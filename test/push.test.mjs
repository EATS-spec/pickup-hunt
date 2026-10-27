import test from 'node:test';
import assert from 'node:assert/strict';
import { hkdfSync } from 'node:crypto';
import { PushService, validateSubscription, sendWebPush } from '../lib/push.mjs';
import { HuntService } from '../lib/hunt-service.mjs';
import { createTestD1 } from './helpers/d1.mjs';
import { MIN_GAP_MS } from '../lib/inventory.mjs';

const A = 'a'.repeat(64), B = 'b'.repeat(64);
const base64 = value => Buffer.from(value).toString('base64url');
const variant = { partNumber: 'PUSH1LL/A', modelId: 'testphone', modelName: 'Test iPhone', name: 'Test iPhone Blue 512GB', color: 'Blue', storage: '512GB', checkoutUrl: 'https://www.apple.com/shop/buy-iphone/test-phone' };
const settings = { selection: { modelId: variant.modelId, color: variant.color, storage: variant.storage }, zip: '10001', watchAllNearby: true, storeNumbers: [], watchHours: 24 };
async function keys() {
  const browser = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const browserPublic = new Uint8Array(await crypto.subtle.exportKey('raw', browser.publicKey));
  const signing = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const jwk = await crypto.subtle.exportKey('jwk', signing.privateKey);
  return { browser, browserPublic, signing,
    vapid: { publicKey: base64(await crypto.subtle.exportKey('raw', signing.publicKey)), privateKey: jwk.d, subject: 'https://pickup.example/' },
    subscription: { endpoint: 'https://fcm.googleapis.com/fcm/send/test-subscription', expirationTime: null, keys: { p256dh: base64(browserPublic), auth: base64(crypto.getRandomValues(new Uint8Array(16))) } } };
}
async function fixture(t, { hooked = true, sender } = {}) {
  const db = createTestD1(); t.after(() => db.close());
  let now = Date.now(), available = true;
  const material = await keys(), sent = [];
  const push = new PushService({ db, ...material.vapid, now: () => now, sender: sender || (async (_sub, payload) => { sent.push(payload); return new Response('', { status: 201 }); }) });
  const catalog = { async load() { return { models: [{ id: variant.modelId, variants: [variant] }] }; }, resolveSelection() { return variant; } };
  const service = new HuntService({ db, catalog, now: () => now, notifications: hooked ? push : null,
    fetchInventory: async () => ({ storeCount: 2, warnings: [], observations: ['R001','R002'].map((storeNumber, index) => ({ id: `${storeNumber}|${variant.partNumber}`, partNumber: variant.partNumber, partName: variant.name,
      storeNumber, storeName: index ? 'Other Store' : 'Walt Whitman', observedAt: new Date(now).toISOString(), availability: available && !index ? 'available' : 'unavailable', stale: false })) }) });
  return { db, service, push, sent, material, now: () => now, advance(ms) { now += ms; }, stock(value) { available = value; } };
}

test('subscription validation blocks arbitrary URLs, redirects/credentials and malformed keys while allowing actual browser providers', async () => {
  const { subscription } = await keys();
  assert.equal((await validateSubscription(subscription)).endpoint, subscription.endpoint);
  for (const endpoint of ['http://fcm.googleapis.com/fcm/send/x','https://127.0.0.1/x','https://fcm.googleapis.com.evil.test/x','https://user@fcm.googleapis.com/fcm/send/x','https://fcm.googleapis.com:444/fcm/send/x','https://push.services.mozilla.com.evil.test/x','https://evil.test/push']) {
    await assert.rejects(validateSubscription({ ...subscription, endpoint }));
  }
  for (const endpoint of ['https://web.push.apple.com/Q/example','https://updates.push.services.mozilla.com/wpush/v2/example','https://wns2-test.notify.windows.com/w/?token=example']) assert.equal((await validateSubscription({ ...subscription, endpoint })).endpoint, endpoint);
  await assert.rejects(validateSubscription({ ...subscription, keys: { ...subscription.keys, auth: 'bad' } }), /keys/);
  await assert.rejects(validateSubscription({ ...subscription, expirationTime: Date.now() - 100 }), /expired/);
});

test('real WebCrypto Web Push output decrypts with browser key and has valid ES256 VAPID credentials', async () => {
  const { subscription, vapid, browser, browserPublic, signing } = await keys();
  const message = { title: 'A real encrypted test', body: 'Hello', tag: 'hunt-test' }; let captured;
  await sendWebPush(subscription, message, vapid, { fetcher: async (_url, request) => { captured = request; return new Response('', { status: 201 }); } });
  assert.equal(captured.redirect, 'manual'); assert.equal(captured.headers['Content-Encoding'], 'aes128gcm'); assert.equal(captured.body.length, 4096);
  const token = captured.headers.authorization.match(/^vapid t=([^,]+), k=/)[1], [header, claims, signature] = token.split('.');
  assert.equal(JSON.parse(Buffer.from(header,'base64url')).alg, 'ES256');
  assert.equal(JSON.parse(Buffer.from(claims,'base64url')).aud, 'https://fcm.googleapis.com');
  assert.equal(await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, signing.publicKey, Buffer.from(signature,'base64url'), Buffer.from(`${header}.${claims}`)), true);
  const body = captured.body, salt = body.slice(0,16), serverPublic = body.slice(21,86);
  const publicKey = await crypto.subtle.importKey('raw', serverPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const shared = await crypto.subtle.deriveBits({ name: 'ECDH', public: publicKey }, browser.privateKey, 256);
  const info = Buffer.concat([Buffer.from('WebPush: info\0'), browserPublic, serverPublic]);
  const ikm = hkdfSync('sha256', Buffer.from(shared), Buffer.from(subscription.keys.auth,'base64url'), info, 32);
  const cek = hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'),16);
  const nonce = hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'),12);
  const aes = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['decrypt']);
  const padded = Buffer.from(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce }, aes, body.slice(86)));
  let end = padded.length - 1; while (padded[end] === 0) end--; assert.equal(padded[end],2);
  assert.deepEqual(JSON.parse(padded.subarray(0,end).toString()), message);
});

test('fresh watched availability delivers once per episode, and a later return to stock delivers again', async t => {
  const f = await fixture(t);
  await f.service.configure(A,settings); await f.service.setMonitoring(A,{enabled:true}); await f.push.subscribe(A,f.material.subscription);
  await f.service.tick(); assert.equal(f.sent.length,1); assert.match(f.sent[0].title,/Walt Whitman/);
  await f.service.tick(); f.advance(MIN_GAP_MS); await f.service.tick(); assert.equal(f.sent.length,1);
  f.stock(false); f.advance(MIN_GAP_MS); await f.service.tick();
  f.stock(true); f.advance(MIN_GAP_MS); await f.service.tick(); assert.equal(f.sent.length,2);
  assert.notEqual(f.sent[0].delivery.id,f.sent[1].delivery.id);
});

test('queued test survives a closed page and idle inventory queue; display receipts require own secret', async t => {
  const f = await fixture(t);
  await f.push.subscribe(A,f.material.subscription); const queued = await f.push.test(A);
  assert.equal(queued.queued,true); assert.equal(queued.test.state,'pending');
  assert.equal((await f.service.tick()).outcome,'idle'); assert.equal(f.sent.length,0);
  f.advance(16_000); assert.equal((await f.service.tick()).outcome,'idle'); assert.equal(f.sent.length,1);
  assert.equal((await f.push.status(A)).test.state,'sent'); assert.equal((await f.push.status(A)).lastDisplayedAt,null);
  await assert.rejects(f.push.receipt(B,f.sent[0].delivery),/Unknown/);
  await assert.rejects(f.push.receipt(A,{...f.sent[0].delivery,token:'wrong'}),/Unknown/);
  await f.push.receipt(A,f.sent[0].delivery); assert.ok((await f.push.status(A)).test.displayedAt);
  await assert.rejects(f.push.test(A),/one minute/);
  const publicState=JSON.stringify(await f.push.status(A)); assert.ok(!publicState.includes(f.material.subscription.endpoint));assert.ok(!publicState.includes(f.material.subscription.keys.auth));
});

for (const action of ['stop','complete','unsubscribe','expire','retarget','stale','unwatched']) test(`pending stock alert is suppressed after ${action}`, async t => {
  const f=await fixture(t,{hooked:false});
  await f.service.configure(A,settings);await f.service.setMonitoring(A,{enabled:true});await f.service.tick();await f.push.subscribe(A,f.material.subscription);
  assert.equal(f.db.sqlite.prepare('SELECT COUNT(*) AS count FROM hunt_push_outbox').get().count,1);
  if(action==='stop')await f.service.setMonitoring(A,{enabled:false});
  if(action==='complete')await f.service.complete(A);
  if(action==='unsubscribe')await f.push.unsubscribe(A);
  if(action==='expire')f.advance(25*3_600_000);
  if(action==='stale')f.advance(16*60_000);
  if(action==='retarget')await f.service.configure(A,{...settings,zip:'90210'});
  if(action==='unwatched')await f.service.configure(A,{...settings,watchAllNearby:false,storeNumbers:['R002']});
  await f.push.flush();assert.equal(f.sent.length,0);
});

test('transient failures retry durably and concurrent flushes reserve one delivery', async t => {
  let attempts=0;
  const f=await fixture(t,{sender:async()=>{attempts++;return new Response('',{status:attempts===1?503:201});}});
  await f.push.subscribe(A,f.material.subscription);await f.push.test(A);f.advance(16_000);
  await Promise.all([f.push.flush(),f.push.flush()]);assert.equal(attempts,1);assert.equal((await f.push.status(A)).test.state,'pending');
  f.advance(61_000);await f.push.flush();assert.equal(attempts,2);assert.equal((await f.push.status(A)).test.state,'sent');
  await f.push.flush();assert.equal(attempts,2);
});

test('410 removes expired subscription and no later tick retries it', async t => {
  let attempts=0;const f=await fixture(t,{sender:async()=>{attempts++;return new Response('',{status:410});}});
  await f.push.subscribe(A,f.material.subscription);await f.push.test(A);f.advance(16_000);await f.push.flush();
  assert.equal((await f.push.status(A)).subscribed,false);assert.equal((await f.push.status(A)).needsResubscribe,true);
  f.advance(61_000);await f.push.flush();assert.equal(attempts,1);
  await f.push.subscribe(A,{...f.material.subscription,endpoint:f.material.subscription.endpoint+'-new'});
  assert.equal((await f.push.status(A)).needsResubscribe,false);
});

test('one observation with many available stores produces one aggregated alert per watcher',async t=>{
 const f=await fixture(t,{hooked:false});await f.service.configure(A,settings);await f.service.setMonitoring(A,{enabled:true});await f.service.tick();
 const job=f.db.sqlite.prepare('SELECT * FROM hunt_jobs').get(),state=JSON.parse(job.state_json);
 state.observations[1].availability='available';state.notifications.push({...state.notifications[0],id:'other-store-episode',storeNumber:'R002'});
 f.db.sqlite.prepare('UPDATE hunt_jobs SET state_json = ? WHERE key = ?').run(JSON.stringify(state),job.key);
 await f.push.subscribe(A,f.material.subscription);await f.push.flush();
 assert.equal(f.sent.length,1);assert.equal(f.sent[0].storeNumbers.length,2);assert.match(f.sent[0].title,/2 stores/);
 await f.push.enqueueForJob(job.key);await f.push.flush();assert.equal(f.sent.length,1);
});

test('slow push delivery cannot reserve Apple gate using a timestamp from before the wait',async t=>{
 const f=await fixture(t,{hooked:false});await f.service.configure(A,settings,{check:true});
 const started=f.now();let dispatchedAt;
 const reader=f.service.fetchInventory;
 f.service.fetchInventory=async input=>{dispatchedAt=f.now();return reader(input);};
 f.service.notifications={beginTick(){},async flush(){f.advance(50_000);},async enqueueForJob(){}};
 await f.service.tick();
 const engine=f.db.sqlite.prepare("SELECT * FROM hunt_engine WHERE id = 'global'").get();
 assert.equal(dispatchedAt,started+50_000);
 assert.deepEqual(JSON.parse(engine.request_times_json),[dispatchedAt]);
 assert.equal(engine.next_allowed_at,dispatchedAt+MIN_GAP_MS);
});
