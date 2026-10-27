import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../apps-script/Code.gs', import.meta.url), 'utf8');
const NOW = Date.parse('2026-10-27T16:00:00.000Z');
const TOKEN = 'private-callback-token-'.repeat(3);
const ORIGIN = 'https://pickup-hunt.example';

function relay({ httpStatus = 200, heartbeat = new Date(NOW).toISOString(), lockAvailable = true,
  fetchError = null, createError = null, responseText = null, origin = ORIGIN } = {}) {
  const values = new Map([['PICKUP_HUNT_CALLBACK_TOKEN', TOKEN],['PICKUP_HUNT_SITE_ORIGIN',origin]]);
  const events = [], logs = [];
  let released = 0, serial = 0;
  const makeTrigger = (handler, id) => ({ getHandlerFunction: () => handler, getUniqueId: () => id });
  const triggers = [makeTrigger('refreshPickupHunt', 'old'), makeTrigger('unrelatedTask', 'other')];
  const context = vm.createContext({
    Date: class extends Date { constructor(...args) { super(...(args.length ? args : [NOW])); } static now() { return NOW; } },
    console: { log: value => logs.push(String(value)) },
    PropertiesService: { getScriptProperties: () => ({
      getProperty: key => values.get(key) ?? null,
      setProperty: (key, value) => values.set(key, value)
    }) },
    LockService: { getScriptLock: () => ({
      tryLock: () => lockAvailable,
      releaseLock: () => { released++; }
    }) },
    ScriptApp: {
      getProjectTriggers: () => [...triggers],
      deleteTrigger: trigger => { events.push(`delete:${trigger.getUniqueId()}`); triggers.splice(triggers.indexOf(trigger), 1); },
      newTrigger: handler => ({ timeBased: () => ({ everyMinutes: minutes => ({ create: () => {
        events.push(`create:${handler}:${minutes}`);
        if (createError) throw createError;
        const trigger = makeTrigger(handler, `new-${++serial}`); triggers.push(trigger); return trigger;
      } }) }) })
    },
    UrlFetchApp: { fetch: (url, options) => {
      events.push('fetch');
      assert.equal(url, origin.replace(/\/$/, '') + '/api/refresh');
      assert.equal(options.headers.Authorization, `Bearer ${TOKEN}`);
      assert.equal(options.followRedirects, false);
      assert.equal(options.payload, '{}');
      if (fetchError) throw fetchError;
      return {
        getResponseCode: () => httpStatus,
        getContentText: () => responseText ?? JSON.stringify({ tick: { outcome: 'idle', checked: false }, health: { mode: 'cloud', lastTickAt: heartbeat } })
      };
    } }
  });
  vm.runInContext(source, context);
  return { context, values, events, logs, triggers, released: () => released };
}

test('timer installation verifies the hosted callback before replacing only its own trigger', () => {
  const app = relay();
  assert.equal(app.context.setupPickupHunt().ok, true);
  assert.deepEqual(app.events, ['fetch', 'create:refreshPickupHunt:5', 'delete:old']);
  assert.equal(app.context.pickupHuntTimerStatus().timerCount, 1);
  assert.ok(app.triggers.some(trigger => trigger.getUniqueId() === 'other'));
  app.context.setupPickupHunt();
  assert.equal(app.context.pickupHuntTimerStatus().timerCount, 1);
  assert.equal(app.released(), 2);
});

test('relay requires an explicit safe deployment origin before sending its credential', () => {
  for (const origin of [null,'','http://pickup.example','https://user:pass@pickup.example','https://pickup.example/path','https://pickup.example?token=x','https://pickup.example#fragment','https://127.0.0.1','https://pickup.example:65536']) {
    const app=relay({origin});
    assert.throws(()=>app.context.setupPickupHunt(),/PICKUP_HUNT_SITE_ORIGIN/);
    assert.deepEqual(app.events,[]);
    assert.equal(app.triggers.length,2);
  }
  const custom=relay({origin:'https://my-pickup.example/'});
  assert.equal(custom.context.setupPickupHunt().ok,true);
  assert.equal(custom.context.pickupHuntTimerStatus().targetConfigured,true);
});

test('failed authentication or failed trigger creation preserves an existing timer', () => {
  const denied = relay({ httpStatus: 403 });
  assert.throws(() => denied.context.setupPickupHunt(), /relay failed/);
  assert.deepEqual(denied.events, ['fetch']);
  assert.equal(denied.context.pickupHuntTimerStatus().timerCount, 1);
  const quota = relay({ createError: new Error('Trigger quota exceeded') });
  assert.throws(() => quota.context.setupPickupHunt(), /Trigger quota/);
  assert.ok(quota.triggers.some(trigger => trigger.getUniqueId() === 'old'));
  assert.ok(!quota.events.some(event => event.startsWith('delete:')));
  assert.equal(denied.released(), 1);
  assert.equal(quota.released(), 1);
});

test('overlapping relay execution skips without another callback', () => {
  const app = relay({ lockAvailable: false });
  assert.equal(app.context.refreshPickupHunt({ triggerUid: 'timer-id' }).outcome, 'overlap-skipped');
  assert.deepEqual(app.events, []);
  assert.equal(app.released(), 0);
});

test('scheduled success has separate persisted verification and safe diagnostics', () => {
  const app = relay();
  app.context.refreshPickupHunt({ triggerUid: 'timer-id' });
  const scheduled = app.values.get('PICKUP_HUNT_LAST_SCHEDULED_SUCCESS_AT');
  assert.equal(scheduled, new Date(NOW).toISOString());
  app.context.refreshPickupHunt();
  const status = app.context.pickupHuntTimerStatus();
  assert.equal(status.relay.source, 'manual');
  assert.equal(status.lastScheduledSuccessAt, scheduled);
  assert.ok(!app.logs.join('\n').includes(TOKEN));
  assert.ok(!app.values.get('PICKUP_HUNT_RELAY_STATUS').includes(TOKEN));
});

test('invalid or stale callback responses never count as successful scheduled execution', () => {
  for (const options of [
    { responseText: '<html>Login required</html>' },
    { heartbeat: new Date(NOW - 180_000).toISOString() },
    { heartbeat: new Date(NOW + 120_000).toISOString() },
    { fetchError: new Error(`Fetch failed with request headers ${TOKEN}`) }
  ]) {
    const app = relay(options);
    assert.throws(() => app.context.refreshPickupHunt({ triggerUid: 'timer-id' }), /relay failed/);
    assert.equal(app.values.get('PICKUP_HUNT_LAST_SCHEDULED_SUCCESS_AT'), undefined);
    const persisted = app.values.get('PICKUP_HUNT_RELAY_STATUS');
    assert.equal(JSON.parse(persisted).ok, false);
    assert.ok(!persisted.includes(TOKEN));
    assert.equal(app.released(), 1);
  }
});

test('stopping the timer leaves unrelated automations and server watches alone', () => {
  const app = relay();
  app.context.stopPickupHuntTimer();
  assert.deepEqual(app.events, ['delete:old']);
  assert.equal(app.context.pickupHuntTimerStatus().timerCount, 0);
  assert.equal(app.triggers.length, 1);
});
