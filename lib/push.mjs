import { encryptNotification, vapidHeaders } from '@block65/webcrypto-web-push';

const encoder = new TextEncoder();
const STALE_MS = 15 * 60_000;
const authCache = new Map();
const json = (value, fallback = null) => { try { return JSON.parse(value); } catch { return fallback; } };
const changed = result => Number(result?.meta?.changes || 0) > 0;
const iso = value => value == null ? null : new Date(value).toISOString();
const fail = (message, statusCode = 400) => Object.assign(new Error(message), { statusCode });
const stockPayload = (rows, config) => ({
  title: rows.length === 1 ? `Phone spotted at ${String(rows[0].storeName || 'Apple').slice(0, 100)}` : `Your phone was spotted at ${rows.length} stores`,
  body: `${String(rows[0].partName || config.models?.[0]?.name || 'Your chosen iPhone').slice(0, 150)}. ${rows.map(row => row.storeName || row.storeNumber).join(', ').slice(0, 130)}. Tap to check Apple.`,
  storeNumbers: rows.map(row => row.storeNumber), observedAt: rows[0].observedAt,
});
const freshRows = (state, config, now) => state.lastCheck?.outcome !== 'success' ? [] : (state.observations || []).filter(row => {
  const observedAt = Date.parse(row.observedAt);
  return row.availability === 'available' && !row.stale && Number.isFinite(observedAt) && now - observedAt <= STALE_MS && observedAt <= now + 60_000 && (config.watchAllNearby || config.storeNumbers?.includes(row.storeNumber));
});
const hash = async value => [...new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value)))].map(n => n.toString(16).padStart(2, '0')).join('');
const bytes = value => {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) throw fail('Invalid notification subscription keys.');
  return Uint8Array.from(atob(value.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - value.length % 4) % 4)), c => c.charCodeAt(0));
};

/** Only known browser push services can receive server requests. Never follow redirects. */
export async function validateSubscription(input, now = Date.now()) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || typeof input.endpoint !== 'string' || input.endpoint.length > 2048) throw fail('Invalid notification subscription.');
  let url;
  try { url = new URL(input.endpoint); } catch { throw fail('Invalid notification subscription endpoint.'); }
  const host = url.hostname.toLowerCase();
  const allowed = host === 'fcm.googleapis.com' || host === 'updates.push.services.mozilla.com' || host.endsWith('.push.services.mozilla.com') || host.endsWith('.push.apple.com') || host === 'wns2-par02p.notify.windows.com' || host.endsWith('.notify.windows.com');
  if (url.protocol !== 'https:' || !allowed || url.port || url.username || url.password || url.hash || url.pathname === '/') throw fail('This browser notification service is not supported. Open Pickup Hunt in Safari, Chrome, Firefox, or Edge.');
  const p256dh = bytes(input.keys?.p256dh), auth = bytes(input.keys?.auth);
  if (p256dh.length !== 65 || p256dh[0] !== 4 || auth.length !== 16) throw fail('Invalid notification subscription keys.');
  try { await crypto.subtle.importKey('raw', p256dh, { name: 'ECDH', namedCurve: 'P-256' }, false, []); } catch { throw fail('Invalid notification public key.'); }
  const expirationTime = input.expirationTime ?? null;
  if (expirationTime !== null && (!Number.isFinite(expirationTime) || expirationTime <= now)) throw fail('This notification subscription expired. Enable notifications again.');
  return { endpoint: url.href, expirationTime, keys: { p256dh: input.keys.p256dh, auth: input.keys.auth } };
}

export async function sendWebPush(subscription, payload, vapid, { fetcher = fetch, now = Date.now() } = {}) {
  let stage = 'authorization';
  try {
  // Reuse VAPID authorization for an hour in each warm Worker, as Apple recommends.
  const key = `${vapid.publicKey}|${new URL(subscription.endpoint).origin}|${vapid.subject}`;
  let cached = authCache.get(key);
  if (!cached || cached.expires <= now) {
    cached = { expires: now + 3_600_000, headers: (await vapidHeaders(subscription, vapid)).headers };
    if (authCache.size > 20) authCache.clear();
    authCache.set(key, cached);
  }
  stage = 'encryption';
  const body = await encryptNotification(subscription, encoder.encode(JSON.stringify(payload)));
  stage = 'transport';
  // Workers implements follow/manual, not the browser-only "error" mode.
  // Manual preserves the endpoint allowlist: a 3xx response is never followed.
  return await fetcher(subscription.endpoint, { method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(10_000), body,
    headers: { ...cached.headers, TTL: '120', Urgency: 'high', Topic: payload.tag.slice(0, 32), 'Content-Encoding': 'aes128gcm', 'Content-Type': 'application/octet-stream' } });
  } catch (error) {
    // Raw platform errors can contain private endpoint URLs. Persist only an
    // allowlisted stage and the exception class, never error.message/cause.
    const code = /^[A-Za-z][A-Za-z0-9]{0,40}$/.test(error?.name || '') ? error.name : 'Error';
    throw Object.assign(new Error(`Notification delivery failed (${stage}: ${code}). A later tick may retry.`), { pushStage: stage, pushCode: code });
  }
}

/** Private subscriptions and an atomic, bounded outbox. A push-service acceptance is not a display receipt. */
export class PushService {
  constructor({ db, publicKey, privateKey, subject, now = () => Date.now(), sender = sendWebPush } = {}) {
    this.db = db; this.now = now; this.sender = sender;
    this.vapid = { publicKey, privateKey, subject };
    this.remaining = 40;
    this.configured = Boolean(publicKey && privateKey && /^(https:\/\/|mailto:)/.test(subject || ''));
  }
  statement(sql, ...values) { return this.db.prepare(sql).bind(...values); }
  beginTick() { this.remaining = 40; }
  run(sql, ...values) { return this.statement(sql, ...values).run(); }
  first(sql, ...values) { return this.statement(sql, ...values).first(); }
  async all(sql, ...values) { return (await this.statement(sql, ...values).all()).results || []; }
  async status(sessionId) {
    const row = await this.first('SELECT * FROM hunt_push_subscriptions WHERE session_id = ?', sessionId);
    const watch = await this.first('SELECT enabled, expires_at, completion_json FROM hunt_watches WHERE id = ?', sessionId);
    const latestTest = await this.first("SELECT state, accepted_at, displayed_at, last_error FROM hunt_push_outbox WHERE session_id = ? AND kind = 'test' ORDER BY created_at DESC LIMIT 1", sessionId);
    const lastFailure = !row ? await this.first('SELECT last_error FROM hunt_push_outbox WHERE session_id = ? ORDER BY created_at DESC LIMIT 1', sessionId) : null;
    const lastError = row ? row.last_error : lastFailure?.last_error;
    return { configured: this.configured, publicKey: this.configured ? this.vapid.publicKey : null,
      subscribed: Boolean(row && row.public_key === this.vapid.publicKey), watchEnabled: Boolean(watch?.enabled && watch.expires_at > this.now() && !watch.completion_json),
      needsResubscribe: Boolean((row && row.public_key !== this.vapid.publicKey) || (!row && lastError?.startsWith('Notification subscription expired'))),
      lastSentAt: iso(row?.last_sent_at), lastDisplayedAt: iso(row?.last_displayed_at), lastTestAt: iso(row?.last_test_at), lastError: lastError || null,
      test: latestTest ? { state: latestTest.state, acceptedAt: iso(latestTest.accepted_at), displayedAt: iso(latestTest.displayed_at), error: latestTest.last_error } : null };
  }
  async subscribe(sessionId, input) {
    if (!this.configured) throw fail('Notifications are not configured yet.', 503);
    const subscription = await validateSubscription(input, this.now()), endpointHash = await hash(subscription.endpoint), now = this.now();
    // Endpoint ownership follows the current browser cookie. Re-enabling after clearing
    // cookies moves that endpoint, so an abandoned watch cannot keep notifying it.
    await this.db.batch([
      this.statement('DELETE FROM hunt_push_subscriptions WHERE endpoint_hash = ? AND session_id != ?', endpointHash, sessionId),
      this.statement(`INSERT INTO hunt_push_subscriptions (session_id, subscription_json, endpoint_hash, public_key, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(session_id) DO UPDATE SET subscription_json = excluded.subscription_json,
        endpoint_hash = excluded.endpoint_hash, public_key = excluded.public_key, updated_at = excluded.updated_at, last_error = NULL`, sessionId, JSON.stringify(subscription), endpointHash, this.vapid.publicKey, now, now),
    ]);
    await this.enqueueForWatch(sessionId);
    return this.status(sessionId);
  }
  async unsubscribe(sessionId) {
    await this.db.batch([
      this.statement('DELETE FROM hunt_push_subscriptions WHERE session_id = ?', sessionId),
      this.statement("UPDATE hunt_push_outbox SET state = 'cancelled' WHERE session_id = ? AND state IN ('pending','sending')", sessionId),
    ]);
    return this.status(sessionId);
  }
  async enqueue({ sessionId, endpointHash, jobKey, eventId, kind = 'stock', storeNumber = null, payload, expiresAt, notBefore = this.now() }) {
    const id = await hash(`${sessionId}|${eventId}`), token = crypto.randomUUID() + crypto.randomUUID();
    const message = { ...payload, delivery: { id, token }, tag: `hunt-${id.slice(0, 26)}`, url: '/', icon: '/notification-icon.png' };
    await this.run(`INSERT INTO hunt_push_outbox (id, session_id, endpoint_hash, job_key, store_number, kind, payload_json, receipt_hash,
      state, attempts, created_at, not_before, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?) ON CONFLICT(id) DO NOTHING`,
    id, sessionId, endpointHash, jobKey, storeNumber, kind, JSON.stringify(message), await hash(token), this.now(), notBefore, expiresAt);
    // Newer stock supersedes queued older stock for this browser. Tests remain independent.
    if (kind === 'stock') await this.run("UPDATE hunt_push_outbox SET state = 'cancelled' WHERE session_id = ? AND kind = 'stock' AND state = 'pending' AND id != ?", sessionId, id);
    return id;
  }
  async test(sessionId) {
    const now = this.now();
    if (!this.configured) throw fail('Notifications are not configured yet.', 503);
    const row = await this.first('SELECT * FROM hunt_push_subscriptions WHERE session_id = ?', sessionId);
    if (!row || row.public_key !== this.vapid.publicKey) throw fail('Enable notifications on this device first.');
    const reserved = await this.run('UPDATE hunt_push_subscriptions SET last_test_at = ? WHERE session_id = ? AND (last_test_at IS NULL OR last_test_at <= ?)', now, sessionId, now - 60_000);
    if (!changed(reserved)) throw fail('Wait one minute before sending another test alert.', 429);
    await this.enqueue({ sessionId, endpointHash: row.endpoint_hash, jobKey: null, kind: 'test', eventId: `test|${now}`,
      payload: { title: 'Your hunt can reach you.', body: 'Test alert from Pickup Hunt. Stock alerts can arrive with the page closed.', test: true },
      expiresAt: now + 2 * 3_600_000, notBefore: now + 15_000 });
    return { ...await this.status(sessionId), queued: true, message: 'Test queued for the next background tick. You can close this page now.' };
  }
  async enqueueForWatch(sessionId) {
    const row = await this.first(`SELECT w.*, s.endpoint_hash FROM hunt_watches w JOIN hunt_push_subscriptions s ON s.session_id = w.id
      WHERE w.id = ? AND w.enabled = 1 AND w.expires_at > ? AND w.completion_json IS NULL AND s.public_key = ?`, sessionId, this.now(), this.vapid.publicKey || '');
    if (row) await this.enqueueWatchRow(row);
  }
  async enqueueForJob(jobKey) {
    if (!this.configured) return;
    const rows = await this.all(`SELECT w.*, s.endpoint_hash FROM hunt_watches w JOIN hunt_push_subscriptions s ON s.session_id = w.id
      WHERE w.job_key = ? AND w.enabled = 1 AND w.expires_at > ? AND w.completion_json IS NULL AND s.public_key = ?`, jobKey, this.now(), this.vapid.publicKey);
    for (const row of rows) await this.enqueueWatchRow(row);
  }
  async enqueueWatchRow(watch) {
    const job = await this.first('SELECT state_json FROM hunt_jobs WHERE key = ?', watch.job_key), state = json(job?.state_json, {}), config = json(watch.settings_json, {}), now = this.now();
    const rows = freshRows(state, config, now);
    if (!rows.length) return;
    const latestEpisode = (state.notifications || []).filter(item => rows.some(row => item.storeNumber === row.storeNumber && item.partNumber === row.partNumber)).map(item => item.createdAt).sort().at(-1) || 'existing';
    await this.enqueue({ sessionId: watch.id, endpointHash: watch.endpoint_hash, jobKey: watch.job_key,
      eventId: `${watch.job_key}|stock|${latestEpisode}`, payload: stockPayload(rows, config),
      expiresAt: Math.min(...rows.map(row => Date.parse(row.observedAt) + STALE_MS), watch.expires_at) });
  }
  async eligible(delivery) {
    const subscription = await this.first('SELECT * FROM hunt_push_subscriptions WHERE session_id = ? AND endpoint_hash = ?', delivery.session_id, delivery.endpoint_hash);
    if (!subscription || subscription.public_key !== this.vapid.publicKey) return null;
    if (delivery.kind === 'test') return subscription;
    const watch = await this.first('SELECT * FROM hunt_watches WHERE id = ?', delivery.session_id), now = this.now();
    if (!watch?.enabled || watch.expires_at <= now || watch.completion_json || watch.job_key !== delivery.job_key) return null;
    const config = json(watch.settings_json, {});
    const job = await this.first('SELECT state_json FROM hunt_jobs WHERE key = ?', delivery.job_key), state = json(job?.state_json, {});
    const originalStores = json(delivery.payload_json, {}).storeNumbers || [delivery.store_number];
    const rows = freshRows(state, config, now).filter(row => originalStores.includes(row.storeNumber));
    return rows.length ? { ...subscription, currentPayload: stockPayload(rows, config) } : null;
  }
  async flush() {
    if (!this.configured) return { configured: false, accepted: 0 };
    const now = this.now();
    await this.run("UPDATE hunt_push_outbox SET state = 'failed', last_error = 'Alert expired before delivery.' WHERE state IN ('pending','sending') AND expires_at <= ?", now);
    await this.run('DELETE FROM hunt_push_outbox WHERE created_at < ?', now - 7 * 86_400_000);
    await this.run('DELETE FROM hunt_push_subscriptions WHERE updated_at < ? AND NOT EXISTS (SELECT 1 FROM hunt_watches w WHERE w.id = session_id AND w.enabled = 1 AND w.expires_at > ?)', now - 30 * 86_400_000, now);
    const rows = await this.all("SELECT * FROM hunt_push_outbox WHERE (state = 'pending' OR (state = 'sending' AND locked_until <= ?)) AND not_before <= ? AND expires_at > ? ORDER BY created_at, id LIMIT ?", now, now, now, this.remaining);
    this.remaining -= rows.length;
    let accepted = 0;
    // Bound concurrency and request duration independently of Apple's request gate.
    for (let offset = 0; offset < rows.length; offset += 6) await Promise.all(rows.slice(offset, offset + 6).map(async row => {
      const reservation = await this.run("UPDATE hunt_push_outbox SET state = 'sending', locked_until = ?, attempts = attempts + 1 WHERE id = ? AND (state = 'pending' OR (state = 'sending' AND locked_until <= ?))", this.now() + 60_000, row.id, this.now());
      if (!changed(reservation)) return;
      const subscriptionRow = await this.eligible(row);
      if (!subscriptionRow) { await this.run("UPDATE hunt_push_outbox SET state = 'cancelled', locked_until = NULL WHERE id = ?", row.id); return; }
      try {
        const subscription = await validateSubscription(json(subscriptionRow.subscription_json), this.now());
        const response = await this.sender(subscription, { ...json(row.payload_json), ...subscriptionRow.currentPayload }, this.vapid, { now: this.now() });
        // Release each response body before starting another batch; Workers bound
        // the number of concurrent external connections.
        if (response.body) {
          try { await response.body.cancel(); }
          catch { /* An accepted gateway response must not be retried because body cleanup failed. */ }
        }
        if (response.status === 404 || response.status === 410) {
          await this.run('DELETE FROM hunt_push_subscriptions WHERE session_id = ? AND endpoint_hash = ?', row.session_id, row.endpoint_hash);
          throw fail('Notification subscription expired. Enable notifications again.');
        }
        if (!response.ok) throw fail(`Push service returned HTTP ${response.status}.`, response.status === 429 || response.status >= 500 ? 503 : 400);
        const sentAt = this.now();
        await this.db.batch([
          this.statement("UPDATE hunt_push_outbox SET state = 'sent', accepted_at = ?, locked_until = NULL, last_error = NULL WHERE id = ?", sentAt, row.id),
          this.statement('UPDATE hunt_push_subscriptions SET last_sent_at = ?, last_error = NULL WHERE session_id = ? AND endpoint_hash = ?', sentAt, row.session_id, row.endpoint_hash),
        ]);
        accepted++;
      } catch (error) {
        const retry = error.statusCode !== 400 && row.attempts < 3 && this.now() + 60_000 < row.expires_at;
        const message = error.message?.startsWith('Push service') || error.message?.startsWith('Notification subscription') || error.pushStage ? error.message : 'Notification delivery failed (queue: Error). A later tick may retry.';
        await this.db.batch([
          this.statement('UPDATE hunt_push_outbox SET state = ?, not_before = ?, locked_until = NULL, last_error = ? WHERE id = ?', retry ? 'pending' : 'failed', this.now() + Math.min(5, 2 ** row.attempts) * 60_000, message, row.id),
          this.statement('UPDATE hunt_push_subscriptions SET last_error = ? WHERE session_id = ? AND endpoint_hash = ?', message, row.session_id, row.endpoint_hash),
        ]);
      }
    }));
    return { configured: true, accepted };
  }
  async receipt(sessionId, input) {
    if (!input || !/^[a-f0-9]{64}$/.test(input.id || '') || typeof input.token !== 'string' || input.token.length > 100) throw fail('Invalid delivery receipt.');
    const row = await this.first('SELECT id, endpoint_hash FROM hunt_push_outbox WHERE id = ? AND session_id = ? AND receipt_hash = ?', input.id, sessionId, await hash(input.token));
    if (!row) throw fail('Unknown delivery receipt.');
    const now = this.now();
    await this.db.batch([
      this.statement('UPDATE hunt_push_outbox SET displayed_at = COALESCE(displayed_at, ?) WHERE id = ?', now, row.id),
      this.statement('UPDATE hunt_push_subscriptions SET last_displayed_at = ? WHERE session_id = ? AND endpoint_hash = ?', now, sessionId, row.endpoint_hash),
    ]);
    return { recorded: true };
  }
}
