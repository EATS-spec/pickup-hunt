import { createConfig, validateSettings, RequestGate, mergeObservations, InventoryError, MIN_GAP_MS } from './inventory.mjs';

const HOUR = 3_600_000;
const MAX_ACTIVE_JOBS = 100;
const STALE_AFTER = 15 * 60_000;
const parse = (value, fallback) => { try { return JSON.parse(value); } catch { return fallback; } };
const iso = (value) => value == null ? null : new Date(value).toISOString();
const changed = (result) => Number(result?.meta?.changes ?? result?.changes ?? 0) > 0;
const inputError = (message) => new InventoryError(message, { kind: 'input', statusCode: 400 });
const quotaError = (message) => new InventoryError(message, { kind: 'capacity', statusCode: 429 });
const configurationKey = config => JSON.stringify({ profileId: config.profileId, selection: config.selection,
  watchAllNearby: config.watchAllNearby, storeNumbers: [...config.storeNumbers].sort(), watchHours: config.watchHours });

/** Durable shared queue. D1's conditional UPDATE is the only upstream reservation authority. */
export class HuntService {
  constructor({ db, catalog, fetchInventory, notifications = null, now = () => Date.now(), cadenceMinutes = 60 } = {}) {
    if (!db?.prepare || !catalog?.load || !fetchInventory) throw new Error('HuntService requires D1, a catalog, and an inventory reader.');
    this.db = db; this.catalog = catalog; this.fetchInventory = fetchInventory; this.notifications = notifications; this.now = now; this.cadenceMinutes = Number(cadenceMinutes) || 60;
  }
  statement(sql, ...values) { return this.db.prepare(sql).bind(...values); }
  first(sql, ...values) { return this.statement(sql, ...values).first(); }
  async all(sql, ...values) { return (await this.statement(sql, ...values).all()).results || []; }
  run(sql, ...values) { return this.statement(sql, ...values).run(); }
  validSession(sessionId) {
    if (typeof sessionId !== 'string' || !/^[a-f0-9]{64}$/.test(sessionId)) throw inputError('A valid browser session is required.');
    return sessionId;
  }
  async defaultConfig() {
    const snapshot = await this.catalog.load();
    const variant = snapshot.models?.flatMap(model => model.variants || [])[0];
    if (!variant) throw new InventoryError('The Apple catalog is temporarily unavailable.', { statusCode: 503 });
    return createConfig({ variant, selection: { modelId: variant.modelId, color: variant.color, storage: variant.storage }, zip: '' });
  }
  async watch(sessionId) { return this.first('SELECT * FROM hunt_watches WHERE id = ?', this.validSession(sessionId)); }
  async engine() {
    return await this.first("SELECT * FROM hunt_engine WHERE id = 'global'") || {
      revision: 0, request_times_json: '[]', backoff_until: 0, failure_count: 0,
      locked_until: 0, next_allowed_at: 0, last_tick_at: null, last_tick_json: null,
    };
  }
  gate(engine) { return new RequestGate({ requestTimes: parse(engine.request_times_json, []), failureCount: engine.failure_count, backoffUntil: engine.backoff_until }); }
  async activeJobCount(now = this.now()) {
    return Number((await this.first('SELECT COUNT(DISTINCT job_key) AS count FROM hunt_watches WHERE (enabled = 1 AND expires_at > ?) OR requested_at IS NOT NULL', now))?.count || 0);
  }
  async configure(sessionId, input, { check = false } = {}) {
    this.validSession(sessionId);
    const now = this.now();
    const saved = await this.watch(sessionId);
    const base = saved ? parse(saved.settings_json, null) : await this.defaultConfig();
    if (!base) throw new InventoryError('Saved settings could not be read.', { statusCode: 503 });
    const sameZipJobs = await this.all('SELECT state_json FROM hunt_jobs WHERE zip = ?', base.zip);
    const knownStoreNumbers = [...new Set(sameZipJobs.flatMap(job => parse(job.state_json, {}).observations || []).map(row => row.storeNumber))];
    const config = validateSettings(input, { config: base, resolveSelection: selection => this.catalog.resolveSelection(selection), knownStoreNumbers });
    const jobKey = config.profileId;
    const job = await this.first('SELECT * FROM hunt_jobs WHERE key = ?', jobKey);
    // A warm shared result satisfies a manual check immediately. Starting a watch still
    // enrolls the job for future passes; refreshing pages never creates more requests.
    const fresh = job?.checked_at != null && now - job.checked_at < MIN_GAP_MS;
    const sameJob = saved?.job_key === jobKey;
    const completionJson = !check && saved?.completion_json && configurationKey(base) === configurationKey(config) ? saved.completion_json : null;
    const enabled = sameJob && saved.enabled === 1 && saved.expires_at > now ? 1 : 0;
    const expiresAt = enabled ? saved.expires_at : null;
    const requestedAt = check && !fresh ? now : sameJob ? saved.requested_at : null;
    const interested = enabled || requestedAt != null ? 1 : 0;
    const values = [sessionId, JSON.stringify(config), jobKey, enabled, expiresAt, requestedAt, completionJson, saved?.created_at ?? now, now,
      sessionId, now - HOUR, now - 24 * HOUR, interested, jobKey, now, now];
    const sql = `INSERT INTO hunt_watches (id, settings_json, job_key, enabled, expires_at, requested_at, completion_json, created_at, updated_at)
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?
      WHERE (EXISTS (SELECT 1 FROM hunt_watches WHERE id = ?)
        OR ((SELECT COUNT(*) FROM hunt_watches WHERE created_at > ?) < 100
          AND (SELECT COUNT(*) FROM hunt_watches WHERE created_at > ?) < 1000))
      AND (? = 0 OR EXISTS (SELECT 1 FROM hunt_watches WHERE job_key = ? AND ((enabled = 1 AND expires_at > ?) OR requested_at IS NOT NULL))
        OR (SELECT COUNT(DISTINCT job_key) FROM hunt_watches WHERE (enabled = 1 AND expires_at > ?) OR requested_at IS NOT NULL) < ${MAX_ACTIVE_JOBS})
      ON CONFLICT(id) DO UPDATE SET settings_json = excluded.settings_json, job_key = excluded.job_key,
        enabled = excluded.enabled, expires_at = excluded.expires_at, requested_at = excluded.requested_at, completion_json = excluded.completion_json, updated_at = excluded.updated_at`;
    const result = await this.run(sql, ...values);
    if (!changed(result)) throw quotaError('The shared queue is full. Please try again later; existing watches keep running.');
    await this.run(`INSERT INTO hunt_jobs (key, zip, variant_json, state_json, checked_at, requested_at, last_attempt_at, created_at)
      VALUES (?, ?, ?, '{}', NULL, ?, NULL, ?)
      ON CONFLICT(key) DO UPDATE SET variant_json = excluded.variant_json,
        requested_at = CASE WHEN hunt_jobs.requested_at IS NULL THEN excluded.requested_at ELSE hunt_jobs.requested_at END`,
    jobKey, config.zip, JSON.stringify(config.models[0]), requestedAt, now);
    return this.status(sessionId);
  }
  async setMonitoring(sessionId, { enabled, durationHours, restart = false } = {}) {
    this.validSession(sessionId);
    if (typeof enabled !== 'boolean') throw inputError('Choose whether to start or stop the watch.');
    const saved = await this.watch(sessionId);
    if (!saved) throw inputError('Choose your iPhone and enter a five-digit ZIP code first.');
    const config = parse(saved.settings_json, null), now = this.now();
    if (!config || !/^\d{5}$/.test(config.zip)) throw inputError('Enter a five-digit US ZIP code first.');
    const hours = durationHours ?? config.watchHours;
    if (!Number.isInteger(hours) || hours < 1 || hours > 72) throw inputError('Watch duration must be between 1 and 72 hours.');
    const expiry = enabled ? (saved.enabled && saved.expires_at > now && !restart ? saved.expires_at : now + hours * HOUR) : null;
    const result = await this.run(`UPDATE hunt_watches SET enabled = ?, expires_at = ?, requested_at = ?,
      completion_json = CASE WHEN ? = 1 THEN NULL ELSE completion_json END, updated_at = ?
      WHERE id = ? AND (? = 0
        OR EXISTS (SELECT 1 FROM hunt_watches WHERE job_key = ? AND ((enabled = 1 AND expires_at > ?) OR requested_at IS NOT NULL))
        OR (SELECT COUNT(DISTINCT job_key) FROM hunt_watches WHERE (enabled = 1 AND expires_at > ?) OR requested_at IS NOT NULL) < ${MAX_ACTIVE_JOBS})`,
    enabled ? 1 : 0, expiry, enabled ? saved.requested_at ?? now : null, enabled ? 1 : 0, now, sessionId, enabled ? 1 : 0, saved.job_key, now, now);
    if (!changed(result)) throw quotaError('The shared queue is full. Please try again later.');
    if (enabled) await this.pushUpdates({ sessionId });
    return this.status(sessionId);
  }
  async complete(sessionId, input = {}) {
    this.validSession(sessionId);
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => key !== 'storeNumber')) throw inputError('Confirm this hunt with an optional returned store.');
    if (input.storeNumber !== undefined && (typeof input.storeNumber !== 'string' || !/^R\d{1,6}$/.test(input.storeNumber))) throw inputError('Choose a returned store for this hunt.');
    const saved = await this.watch(sessionId);
    if (!saved) throw inputError('Choose your iPhone and enter a five-digit ZIP code first.');
    const config = parse(saved.settings_json, null);
    if (!config || !/^\d{5}$/.test(config.zip) || !config.models?.[0]) throw inputError('Choose your iPhone and enter a five-digit ZIP code first.');
    const job = await this.first('SELECT state_json FROM hunt_jobs WHERE key = ?', saved.job_key);
    const observations = parse(job?.state_json, {}).observations || [];
    const store = input.storeNumber === undefined ? null : observations.find(row => row.storeNumber === input.storeNumber);
    if (input.storeNumber !== undefined && (!store || (!config.watchAllNearby && !config.storeNumbers.includes(input.storeNumber)))) throw inputError('Choose one of the returned stores included in your watch.');
    // A visitor confirms their own outcome. Stock can already be gone or stale;
    // this records no Apple order verification and never touches another watch.
    if (saved.completion_json) return this.status(sessionId);
    const completion = { id: crypto.randomUUID(), confirmedBy: 'visitor', completedAt: iso(this.now()),
      profileId: config.profileId, selection: { ...config.selection }, variant: { ...config.models[0] },
      zip: config.zip, storeNumber: store?.storeNumber || null, storeName: store?.storeName || null };
    const result = await this.run(`UPDATE hunt_watches SET enabled = 0, expires_at = NULL, requested_at = NULL,
      completion_json = ?, updated_at = ? WHERE id = ? AND job_key = ? AND settings_json = ? AND completion_json IS NULL`,
    JSON.stringify(completion), this.now(), sessionId, saved.job_key, saved.settings_json);
    if (!changed(result)) {
      const current = await this.watch(sessionId);
      if (!current?.completion_json || current.job_key !== saved.job_key || current.settings_json !== saved.settings_json) throw inputError('Your hunt changed while you were confirming it. Review the saved target and try again.');
    }
    return this.status(sessionId);
  }
  async resetCompletion(sessionId) {
    this.validSession(sessionId);
    if (!await this.watch(sessionId)) throw inputError('Choose your iPhone and enter a five-digit ZIP code first.');
    await this.run('UPDATE hunt_watches SET completion_json = NULL, enabled = 0, expires_at = NULL, requested_at = NULL, updated_at = ? WHERE id = ?', this.now(), sessionId);
    return this.status(sessionId);
  }
  async health() {
    const now = this.now(), engine = await this.engine(), gate = this.gate(engine);
    const activeJobs = await this.activeJobCount(now);
    const latest = await this.first('SELECT MAX(checked_at) AS checked_at FROM hunt_jobs');
    return {
      mode: 'cloud', activeJobs, queueSize: activeJobs, maximumActiveJobs: MAX_ACTIVE_JOBS,
      lastTickAt: iso(engine.last_tick_at), lastTick: parse(engine.last_tick_json, null),
      schedulerHealthy: engine.last_tick_at != null && now - engine.last_tick_at < Math.max(10, this.cadenceMinutes * 2) * 60_000,
      nextAllowedAt: iso(gate.nextAllowed(now)), minimumGapSeconds: MIN_GAP_MS / 1000,
      requestCountInWindow: gate.requestTimes.length,
      backoffMinutes: Math.max(0, Math.ceil((engine.backoff_until - now) / 60_000)),
      cadenceMinutes: this.cadenceMinutes, approximateCycleMinutes: activeJobs * this.cadenceMinutes,
      lastSuccessfulCheckAt: iso(latest?.checked_at),
      error: parse(engine.last_tick_json, null)?.error || null,
    };
  }
  async status(sessionId) {
    const saved = await this.watch(sessionId), now = this.now();
    const config = saved ? parse(saved.settings_json, null) : await this.defaultConfig();
    const job = saved ? await this.first('SELECT * FROM hunt_jobs WHERE key = ?', saved.job_key) : null;
    const state = parse(job?.state_json, {}), engine = await this.engine(), gate = this.gate(engine);
    const completion = parse(saved?.completion_json, null);
    const enabled = !completion && saved?.enabled === 1 && saved.expires_at > now;
    const watched = row => config.watchAllNearby || config.storeNumbers.includes(row.storeNumber);
    const observations = (state.observations || []).map(row => now - Date.parse(row.observedAt) > STALE_AFTER
      ? { ...row, stale: true, staleReason: 'Observation is more than 15 minutes old.' } : row);
    const hits = observations.filter(row => !completion && watched(row) && row.availability === 'available').sort((a, b) =>
      Number(a.stale) - Number(b.stale) || Number(b.targetDateStatus === 'verified') - Number(a.targetDateStatus === 'verified'));
    const cloudHealth = await this.health();
    const queued = saved?.requested_at != null;
    const orderedJobs = enabled || queued ? await this.all(`SELECT j.key FROM hunt_jobs j WHERE EXISTS
      (SELECT 1 FROM hunt_watches w WHERE w.job_key = j.key AND ((w.enabled = 1 AND w.expires_at > ?) OR w.requested_at IS NOT NULL))
      ORDER BY COALESCE(j.last_attempt_at, 0) ASC, COALESCE(j.requested_at, j.created_at) ASC, j.key ASC`, now) : [];
    const queuePosition = saved ? orderedJobs.findIndex(item => item.key === saved.job_key) + 1 : 0;
    return {
      config, completion, monitor: { enabled, scope: 'nearby', stopAt: enabled ? iso(saved.expires_at) : null },
      scheduler: { inFlight: Boolean(job && engine.locked_until > now && state.lastCheck?.outcome === 'checking'),
        queuedScope: queued ? 'nearby' : null, nextAllowedAt: iso(gate.nextAllowed(now)),
        nextCheckAt: enabled || queued ? iso(gate.nextAllowed(now)) : null,
        lastRequestAt: iso(gate.requestTimes.at(-1)), requestCountInWindow: gate.requestTimes.length,
        backoffMinutes: cloudHealth.backoffMinutes, sharedQueueSize: cloudHealth.activeJobs,
        estimated: true, queuePosition: queuePosition || null },
      observations, hits, notifications: completion ? [] : (state.notifications || []).filter(watched),
      stores: [...new Map(observations.map(row => [row.storeNumber, {
        storeNumber: row.storeNumber, storeName: row.storeName, city: row.city, state: row.state,
        timeZone: row.timeZone, storeHours: row.storeHours ?? null, regularHours: row.regularHours ?? null,
        specialHours: row.specialHours ?? null, observedAt: row.observedAt, stale: row.stale,
      }])).values()],
      lastCheck: state.lastCheck || null, history: state.history || [], lastUpdatedAt: iso(job?.checked_at),
      counts: { stores: new Set(observations.map(row => row.storeNumber)).size,
        watchedStores: new Set(observations.filter(watched).map(row => row.storeNumber)).size, models: 1,
        available: hits.filter(row => !row.stale).length,
        verifiedTarget: hits.filter(row => !row.stale && row.targetDateStatus === 'verified').length,
        stale: observations.filter(row => row.stale).length }, cloudHealth,
    };
  }
  async noteTick(now, result) {
    await this.run("UPDATE hunt_engine SET last_tick_at = ?, last_tick_json = ? WHERE id = 'global'", now, JSON.stringify(result));
    return result;
  }
  async pushUpdates({ jobKey, sessionId } = {}) {
    if (!this.notifications) return;
    // Notification outages must never turn a successful Apple observation into an error.
    try {
      if (jobKey) await this.notifications.enqueueForJob(jobKey);
      if (sessionId) await this.notifications.enqueueForWatch(sessionId);
      return await this.notifications.flush();
    } catch { return { error: 'Notification queue could not be processed.' }; }
  }
  async tick() {
    let now = this.now();
    this.notifications?.beginTick();
    await this.run("INSERT INTO hunt_engine (id) VALUES ('global') ON CONFLICT(id) DO NOTHING");
    await this.run('UPDATE hunt_watches SET enabled = 0, expires_at = NULL, requested_at = NULL WHERE enabled = 1 AND expires_at <= ?', now);
    // Tests and retries still deliver when there are no active Apple searches or the
    // shared Apple gate is cooling down. Push requests never bypass that gate.
    await this.pushUpdates();
    // Push delivery can wait on an external service. Reserve Apple's request
    // against the current clock, never the time captured before that wait.
    now = this.now();
    // Keep durable storage bounded; completed watches remain available for seven days.
    await this.run('DELETE FROM hunt_watches WHERE enabled = 0 AND requested_at IS NULL AND updated_at < ?', now - 7 * 24 * HOUR);
    await this.run('DELETE FROM hunt_jobs WHERE created_at < ? AND NOT EXISTS (SELECT 1 FROM hunt_watches WHERE job_key = hunt_jobs.key)', now - 24 * HOUR);
    const engine = await this.engine(), gate = this.gate(engine);
    const due = gate.nextAllowed(now);
    if (engine.locked_until > now || due > now) return this.noteTick(now, { outcome: 'waiting', checked: false, nextAllowedAt: iso(Math.max(due, engine.locked_until)) });
    const job = await this.first(`SELECT j.* FROM hunt_jobs j WHERE EXISTS
      (SELECT 1 FROM hunt_watches w WHERE w.job_key = j.key AND ((w.enabled = 1 AND w.expires_at > ?) OR w.requested_at IS NOT NULL))
      ORDER BY COALESCE(j.last_attempt_at, 0) ASC, COALESCE(j.requested_at, j.created_at) ASC, j.key ASC LIMIT 1`, now);
    if (!job) return this.noteTick(now, { outcome: 'idle', checked: false });
    if (!gate.reserve(now)) return this.noteTick(now, { outcome: 'waiting', checked: false, nextAllowedAt: iso(gate.nextAllowed(now)) });
    const token = crypto.randomUUID();
    const reservation = await this.run(`UPDATE hunt_engine SET revision = revision + 1, request_times_json = ?,
      next_allowed_at = ?, locked_until = ?, lock_token = ?, last_tick_at = ?, last_tick_json = ?
      WHERE id = 'global' AND revision = ? AND next_allowed_at <= ? AND locked_until <= ?`,
    JSON.stringify(gate.requestTimes), gate.nextAllowed(now), now + 90_000, token, now,
    JSON.stringify({ outcome: 'checking', checked: false }), engine.revision, now, now);
    if (!changed(reservation)) return { outcome: 'busy', checked: false };
    const state = parse(job.state_json, {});
    const attempt = { startedAt: iso(now), completedAt: null, anchor: job.zip, scope: 'nearby', profileId: job.key, outcome: 'checking', error: null };
    await this.run('UPDATE hunt_jobs SET last_attempt_at = ?, state_json = ? WHERE key = ?', now, JSON.stringify({ ...state, lastCheck: attempt }), job.key);
    let summary;
    try {
      const parsed = await this.fetchInventory({ zip: job.zip, variant: parse(job.variant_json, null) });
      if (!Array.isArray(parsed?.observations) || !parsed.observations.length) throw new InventoryError('Apple returned no recognizable inventory.');
      const completed = this.now();
      const merged = mergeObservations(state.observations || [], parsed.observations, state.activeKeys || [], iso(completed));
      gate.success();
      summary = { ...attempt, completedAt: iso(completed), outcome: 'success', observedModels: 1,
        storeCount: parsed.storeCount, warnings: parsed.warnings || [], newAlerts: merged.notifications.length,
        available: merged.observations.filter(row => row.availability === 'available').map(row => ({ storeNumber: row.storeNumber, storeName: row.storeName, partNumber: row.partNumber, targetDateStatus: row.targetDateStatus })) };
      const next = { observations: merged.observations, activeKeys: merged.activeKeys,
        notifications: [...(state.notifications || []), ...merged.notifications].slice(-80),
        lastCheck: summary, history: [...(state.history || []), summary].slice(-30) };
      await this.db.batch([
        this.statement('UPDATE hunt_jobs SET checked_at = ?, requested_at = NULL, state_json = ? WHERE key = ?', completed, JSON.stringify(next), job.key),
        this.statement('UPDATE hunt_watches SET requested_at = NULL WHERE job_key = ? AND requested_at <= ?', job.key, now),
      ]);
      await this.pushUpdates({ jobKey: job.key });
    } catch (error) {
      if (error.statusCode === 429 || error.statusCode === 541) gate.throttle(this.now());
      summary = { ...attempt, completedAt: iso(this.now()), outcome: error.statusCode === 429 || error.statusCode === 541 ? 'throttled' : 'error', error: error.message || 'Inventory check failed.', statusCode: error.statusCode || null };
      const next = { ...state, observations: (state.observations || []).map(row => ({ ...row, stale: true, staleReason: 'The latest Apple check failed; this is an earlier observation.' })),
        lastCheck: summary, history: [...(state.history || []), summary].slice(-30) };
      await this.run('UPDATE hunt_jobs SET state_json = ? WHERE key = ?', JSON.stringify(next), job.key);
      // One-shot checks finish even on failure; an enabled watch retries after the gate.
      await this.run('UPDATE hunt_watches SET requested_at = NULL WHERE job_key = ? AND requested_at <= ?', job.key, now);
    } finally {
      await this.run(`UPDATE hunt_engine SET request_times_json = ?, backoff_until = ?, failure_count = ?,
        next_allowed_at = ?, locked_until = 0, lock_token = NULL, last_tick_at = ?, last_tick_json = ?
        WHERE id = 'global' AND lock_token = ?`, JSON.stringify(gate.requestTimes), gate.backoffUntil, gate.failureCount,
      gate.nextAllowed(this.now()), this.now(), JSON.stringify(summary || { outcome: 'error', error: 'Check interrupted.' }), token);
    }
    return { checked: true, ...summary };
  }
}

export { MAX_ACTIVE_JOBS };
