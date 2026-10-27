import test from 'node:test';
import assert from 'node:assert/strict';
import { HuntService } from '../lib/hunt-service.mjs';
import { createTestD1 } from './helpers/d1.mjs';
import { MIN_GAP_MS, WINDOW_MS } from '../lib/inventory.mjs';

const A = 'a'.repeat(64), B = 'b'.repeat(64);
const variant = { partNumber: 'TEST1LL/A', modelId: 'testphone', modelName: 'Test iPhone', name: 'Test iPhone Blue 512GB', color: 'Blue', storage: '512GB', checkoutUrl: 'https://www.apple.com/shop/buy-iphone/test-phone' };
const secondVariant = { ...variant, partNumber: 'TEST2LL/A', color: 'White', name: 'Test iPhone White 512GB' };
const selection = { modelId: variant.modelId, color: variant.color, storage: variant.storage };
const settings = (input = {}) => ({ selection, zip: '10001', watchAllNearby: true, storeNumbers: [], watchHours: 24, ...input });
const observation = (time, storeNumber = 'R001', availability = 'available') => ({ id: `${storeNumber}|${variant.partNumber}`, storeNumber, storeName: storeNumber === 'R001' ? 'First Store' : 'Second Store', city: 'New York', state: 'NY', timeZone: 'America/New_York', observedAt: new Date(time).toISOString(), partNumber: variant.partNumber, partName: variant.name, availability, pickupQuote: 'Today', pickupDate: '2026-10-23', targetDateStatus: 'verified', stale: false });
function fixture(t, { reader } = {}) {
  const db = createTestD1(); t.after(() => db.close());
  let current = Date.parse('2026-10-23T15:00:00Z');
  const calls = [];
  const catalog = {
    async load() { return { models: [{ id: variant.modelId, name: variant.modelName, variants: [variant, secondVariant] }] }; },
    resolveSelection(input) { const found = [variant, secondVariant].find(item => item.modelId === input.modelId && item.color === input.color && item.storage === input.storage); if (!found) throw new Error('Unknown configuration.'); return found; },
  };
  const read = async (input) => {
    calls.push(input);
    return reader ? reader(input, current) : { observations: [observation(current), observation(current, 'R002', 'unavailable')], warnings: [], storeCount: 2 };
  };
  const service = new HuntService({ db, catalog, fetchInventory: read, now: () => current });
  return { db, catalog, service, calls, now: () => current, advance: (ms) => current += ms,
    restart: () => new HuntService({ db, catalog, fetchInventory: read, now: () => current }) };
}

test('anonymous status has an empty ZIP, no writes, no upstream request, and Start requires configuration', async t => {
  const { service, db, calls } = fixture(t);
  const status = await service.status(A);
  assert.equal(status.config.zip, '');
  assert.equal(status.config.selection.modelId, variant.modelId);
  assert.equal(status.monitor.enabled, false);
  assert.deepEqual(calls, []);
  assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS count FROM hunt_watches').get().count, 0);
  await assert.rejects(service.setMonitoring(A, { enabled: true }), /ZIP code first/);
  await assert.rejects(service.configure(A, settings({ zip: 'abc' })), /five-digit/);
  await assert.rejects(service.status('not-a-hash'), /valid browser session/);
});

test('same SKU and ZIP share one queued fetch and warm results without exposing browser settings', async t => {
  const { service, calls } = fixture(t);
  await service.configure(A, settings(), { check: true });
  await service.configure(B, settings(), { check: true });
  assert.equal((await service.health()).activeJobs, 1);
  await service.tick();
  assert.equal(calls.length, 1);
  await service.configure(A, settings({ watchAllNearby: false, storeNumbers: ['R001'] }));
  await service.configure(B, settings({ watchAllNearby: false, storeNumbers: ['R002'] }), { check: true });
  const one = await service.status(A), two = await service.status(B);
  assert.equal(one.hits.length, 1);
  assert.equal(two.hits.length, 0);
  assert.equal(two.notifications.length, 0);
  assert.deepEqual(one.config.storeNumbers, ['R001']);
  assert.deepEqual(two.config.storeNumbers, ['R002']);
  assert.equal(two.scheduler.queuedScope, null);
  assert.equal((await service.tick()).checked, false);
  assert.equal(calls.length, 1);
});

test('concurrent ticks atomically reserve once before the reader and preserve the gate on restart and retarget', async t => {
  let observedReservation = false;
  const f = fixture(t, { reader: async (_input, time) => {
    const engine = f.db.sqlite.prepare("SELECT * FROM hunt_engine WHERE id = 'global'").get();
    observedReservation = JSON.parse(engine.request_times_json).length === 1 && engine.next_allowed_at === time + MIN_GAP_MS && engine.locked_until > time;
    await Promise.resolve();
    return { observations: [observation(time)], warnings: [], storeCount: 1 };
  } });
  await f.service.configure(A, settings(), { check: true });
  const results = await Promise.all([f.service.tick(), f.service.tick(), f.service.tick()]);
  assert.equal(results.filter(result => result.checked).length, 1);
  assert.equal(f.calls.length, 1);
  assert.equal(observedReservation, true);
  await f.service.configure(A, settings({ zip: '90210', selection: { ...selection, color: 'White' } }), { check: true });
  const restarted = f.restart();
  assert.equal((await restarted.status(A)).observations.length, 0);
  assert.equal((await restarted.tick()).checked, false);
  f.advance(MIN_GAP_MS);
  assert.equal((await restarted.tick()).checked, true);
  assert.equal(f.calls.length, 2);
  assert.equal(f.calls[1].zip, '90210');
  assert.equal(f.calls[1].variant.partNumber, secondVariant.partNumber);
});

test('fair least-recently-checked ordering prevents a busy shared job starving another ZIP', async t => {
  const { service, calls, advance } = fixture(t);
  await service.configure(A, settings(), { check: true });
  await service.setMonitoring(A, { enabled: true });
  await service.configure(B, settings({ zip: '90210' }), { check: true });
  await service.setMonitoring(B, { enabled: true });
  await service.tick(); advance(MIN_GAP_MS); await service.tick(); advance(MIN_GAP_MS); await service.tick();
  assert.deepEqual(calls.map(call => call.zip), ['10001', '90210', '10001']);
});

test('watch expiry is durable, repeated Start does not extend it, and Stop cancels only that session', async t => {
  const { service, restart, advance, calls } = fixture(t);
  await service.configure(A, settings());
  const initial = await service.setMonitoring(A, { enabled: true, durationHours: 1 });
  advance(60_000);
  const repeated = await restart().setMonitoring(A, { enabled: true, durationHours: 72 });
  assert.equal(repeated.monitor.stopAt, initial.monitor.stopAt);
  await service.configure(B, settings(), { check: true });
  await service.setMonitoring(A, { enabled: false });
  await service.tick();
  assert.equal(calls.length, 1);
  assert.equal((await service.status(B)).scheduler.queuedScope, null);
  await service.setMonitoring(A, { enabled: true, durationHours: 1 });
  advance(3_600_000);
  assert.equal((await restart().status(A)).monitor.enabled, false);
  assert.equal((await restart().tick()).outcome, 'idle');
  assert.equal(calls.length, 1);
});

test('429/541 backoff survives a new service, and failed checks retain stale positive evidence', async t => {
  let failures = false;
  const f = fixture(t, { reader: async (_input, time) => {
    if (failures) { const error = new Error('Apple returned HTTP 541.'); error.statusCode = 541; throw error; }
    return { observations: [observation(time)], warnings: [], storeCount: 1 };
  } });
  await f.service.configure(A, settings()); await f.service.setMonitoring(A, { enabled: true });
  await f.service.tick(); failures = true; f.advance(MIN_GAP_MS);
  assert.equal((await f.service.tick()).outcome, 'throttled');
  let status = await f.restart().status(A);
  assert.equal(status.scheduler.backoffMinutes, 10);
  assert.equal(status.hits[0].stale, true);
  f.advance(10 * 60_000);
  await f.restart().tick();
  status = await f.service.status(A);
  assert.equal(status.scheduler.backoffMinutes, 20);
  assert.equal(f.calls.length, 3);
});

test('rolling-window quota is checked even when a stale persisted next_allowed_at says ready', async t => {
  const { service, db, now, calls, advance } = fixture(t);
  await service.configure(A, settings(), { check: true });
  await service.tick();
  const times = Array.from({ length: 30 }, (_, index) => now() - (29 - index) * 1000);
  db.sqlite.prepare("UPDATE hunt_engine SET request_times_json = ?, next_allowed_at = 0 WHERE id = 'global'").run(JSON.stringify(times));
  await service.setMonitoring(A, { enabled: true });
  advance(MIN_GAP_MS);
  assert.equal((await service.tick()).checked, false);
  assert.equal(calls.length, 1);
  advance(WINDOW_MS);
  assert.equal((await service.tick()).checked, true);
});

test('idle tick records durable scheduler health without querying Apple; unknown stores cannot be selected', async t => {
  const { service, calls } = fixture(t);
  assert.equal((await service.health()).schedulerHealthy, false);
  assert.equal((await service.tick()).outcome, 'idle');
  assert.equal((await service.health()).schedulerHealthy, true);
  await service.configure(A, settings());
  await assert.rejects(service.configure(A, settings({ watchAllNearby: false, storeNumbers: ['R999'] })), /returned store/);
  assert.equal(calls.length, 0);
});

test('active-job capacity is atomic and a full queue still lets another browser join an existing job', async t => {
  const { service, db, now } = fixture(t);
  for (let index = 0; index < 100; index++) {
    const id = index.toString(16).padStart(64, '0');
    db.sqlite.prepare('INSERT INTO hunt_watches (id, settings_json, job_key, enabled, expires_at, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?, ?)').run(id, '{}', `occupied-${index}`, now() + 3_600_000, now() - 2 * 3_600_000, now());
  }
  await assert.rejects(service.configure(A, settings(), { check: true }), /queue is full/);
  assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS count FROM hunt_jobs').get().count, 0);
  db.sqlite.prepare("UPDATE hunt_watches SET job_key = ? WHERE job_key = 'occupied-0'").run(`${variant.partNumber}|10001`);
  await service.configure(A, settings(), { check: true });
  assert.equal((await service.health()).activeJobs, 100);
});

test('simultaneous new jobs cannot overfill the shared queue and stopped single checks do not fetch', async t => {
  const { service, db, now, calls } = fixture(t);
  for (let index = 0; index < 99; index++) {
    db.sqlite.prepare('INSERT INTO hunt_watches (id, settings_json, job_key, enabled, expires_at, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?, ?)').run(index.toString(16).padStart(64, '0'), '{}', `occupied-${index}`, now() + 3_600_000, now() - 2 * 3_600_000, now());
  }
  const results = await Promise.allSettled([
    service.configure(A, settings(), { check: true }),
    service.configure(B, settings({ zip: '90210' }), { check: true }),
  ]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.filter(result => result.status === 'rejected').length, 1);
  assert.equal((await service.health()).activeJobs, 100);
  const successfulSession = results[0].status === 'fulfilled' ? A : B;
  await service.setMonitoring(successfulSession, { enabled: false });
  // The other 99 synthetic capacity rows intentionally have no job to execute.
  assert.equal((await service.tick()).outcome, 'idle');
  assert.equal(calls.length, 0);
});

test('changing a browser target during a fetch never merges the old job into the new selection', async t => {
  let continueRead;
  const waiting = new Promise(resolve => { continueRead = resolve; });
  let started;
  const reading = new Promise(resolve => { started = resolve; });
  const f = fixture(t, { reader: async (_input, time) => {
    started(); await waiting;
    return { observations: [observation(time)], storeCount: 1, warnings: [] };
  } });
  await f.service.configure(A, settings(), { check: true });
  const check = f.service.tick(); await reading;
  await f.service.configure(A, settings({ selection: { ...selection, color: 'White' } }), { check: true });
  continueRead(); await check;
  const status = await f.service.status(A);
  assert.equal(status.config.preferredPart, secondVariant.partNumber);
  assert.deepEqual(status.observations, []);
  assert.deepEqual(status.notifications, []);
  assert.equal(status.scheduler.queuedScope, 'nearby');
  assert.equal((await f.service.health()).requestCountInWindow, 1);
});

test('visitor confirmation stops only its own watch, preserves the exact snapshot, and survives a new service', async t => {
  const { service, restart, advance, calls, db } = fixture(t);
  await service.configure(A, settings(), { check: true });
  await service.configure(B, settings(), { check: true });
  await service.setMonitoring(A, { enabled: true });
  await service.setMonitoring(B, { enabled: true });
  await service.tick();
  advance(16 * 60_000); // Actual purchases can be confirmed after cached stock is stale.
  const gate = db.sqlite.prepare("SELECT * FROM hunt_engine WHERE id='global'").get();
  const results = await Promise.all([service.complete(A, { storeNumber: 'R001' }), service.complete(A, { storeNumber: 'R001' })]);
  const completed = results[0];
  assert.deepEqual(results[1].completion, completed.completion);
  assert.equal(completed.completion.confirmedBy, 'visitor');
  assert.equal(completed.completion.completedAt, new Date(Date.parse('2026-10-23T15:00:00Z') + 16 * 60_000).toISOString());
  assert.deepEqual(completed.completion.selection, selection);
  assert.equal(completed.completion.variant.partNumber, variant.partNumber);
  assert.equal(completed.completion.storeName, 'First Store');
  assert.equal(completed.completion.storeNumber, 'R001');
  assert.equal(completed.monitor.enabled, false);
  assert.equal(completed.monitor.stopAt, null);
  assert.equal(completed.scheduler.queuedScope, null);
  assert.deepEqual(completed.hits, []);
  assert.deepEqual(completed.notifications, []);
  assert.equal((await service.status(B)).monitor.enabled, true);
  assert.equal((await service.status(B)).completion, null);
  assert.deepEqual((await restart().status(A)).completion, completed.completion);
  advance(60_000);
  assert.deepEqual((await service.complete(A)).completion, completed.completion);
  assert.deepEqual(db.sqlite.prepare("SELECT * FROM hunt_engine WHERE id='global'").get(), gate);
  assert.equal(calls.length, 1);
});

test('completion requires this browser’s configured target and an optional known watched store', async t => {
  const { service, calls } = fixture(t);
  await assert.rejects(service.complete(A), /ZIP code first/);
  await service.configure(A, settings());
  await assert.rejects(service.complete(A, { storeNumber: 'R001' }), /returned stores/);
  await service.configure(A, settings(), { check: true }); await service.tick();
  await service.configure(A, settings({ watchAllNearby: false, storeNumbers: ['R001'] }));
  for (const input of [null, [], { storeNumber: 1 }, { storeNumber: 'evil' }, { storeNumber: 'R999' }, { storeNumber: 'R002' }, { caption: 'Guaranteed purchase' }, { checkoutUrl: 'https://evil.test' }]) {
    await assert.rejects(service.complete(A, input), /Confirm this hunt|Choose/);
  }
  assert.equal((await service.status(A)).completion, null);
  const completed = await service.complete(A);
  assert.equal(completed.completion.storeNumber, null);
  assert.equal(completed.completion.storeName, null);
  assert.equal(completed.completion.variant.checkoutUrl, variant.checkoutUrl);
  assert.equal(calls.length, 1);
});

test('same settings and Stop preserve completion; a new configuration or explicit search starts a new hunt', async t => {
  const { service, calls } = fixture(t);
  await service.configure(A, settings());
  const completed = (await service.complete(A)).completion;
  assert.deepEqual((await service.configure(A, settings())).completion, completed);
  assert.deepEqual((await service.setMonitoring(A, { enabled: false })).completion, completed);
  assert.equal((await service.configure(A, settings({ watchHours: 4 }))).completion, null);
  await service.complete(A);
  assert.equal((await service.setMonitoring(A, { enabled: true })).completion, null);
  await service.complete(A);
  assert.equal((await service.configure(A, settings(), { check: true })).completion, null);
  assert.equal(calls.length, 0);
});

test('planning another hunt clears only this browser’s celebration and does not restart or query', async t => {
  const { service, calls, db } = fixture(t);
  await service.configure(A, settings()); await service.configure(B, settings());
  await service.complete(A); const second = (await service.complete(B)).completion;
  const reset = await service.resetCompletion(A);
  assert.equal(reset.completion, null);
  assert.equal(reset.monitor.enabled, false);
  assert.equal(reset.scheduler.queuedScope, null);
  assert.deepEqual((await service.status(B)).completion, second);
  assert.deepEqual(calls, []);
  assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS count FROM hunt_engine').get().count, 0);
});
