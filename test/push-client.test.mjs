import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createPushController } from '../public/push-client.js';

const publicKey = Buffer.concat([Buffer.from([4]),Buffer.alloc(64,1)]).toString('base64url');
function fixture({ supported = true, ios = false, denied = false, failSubscribe = false, retained = false, needsResubscribe = false } = {}) {
  let localSubscription = null, serverSubscription = false, synchronous = false, click = false;
  const requests = [],events=[], notifications = { permission: denied ? 'denied' : retained ? 'granted' : 'default' };
  const subscription = { toJSON() { return { endpoint: 'https://fcm.googleapis.com/fcm/send/example', keys: {} }; }, async unsubscribe() { events.push('unsubscribe');localSubscription = null; } };
  if(retained)localSubscription=subscription;
  const registration = { pushManager: { async getSubscription() { return localSubscription; }, subscribe() { events.push('subscribe');synchronous = click; notifications.permission = 'granted'; localSubscription = subscription; return Promise.resolve(subscription); } } };
  const environment = { isSecureContext: true, Notification: notifications, PushManager: supported ? function() {} : null, setTimeout, clearTimeout,
    matchMedia: () => ({ matches: false }), navigator: { userAgent: ios ? 'iPhone' : 'Desktop', serviceWorker: { async register() { return registration; }, ready: Promise.resolve(registration) } } };
  const fetcher = async (path, request) => {
    requests.push({ path, request });
    if (path === '/api/push/subscribe') { if (failSubscribe) return new Response(JSON.stringify({ error: 'Could not save subscription.' }),{status:503}); serverSubscription=true;needsResubscribe=false; }
    if (path === '/api/push/unsubscribe') serverSubscription=false;
    return new Response(JSON.stringify({ configured:true, publicKey, subscribed:serverSubscription,needsResubscribe, watchEnabled:false, ...(path==='/api/push/test'?{test:{state:'pending'}}:{}) }));
  };
  return { controller: createPushController({ environment, fetcher }), requests,events,
    markClick(value) { click=value; }, wasSynchronous: () => synchronous };
}

test('unsupported browsers and iOS tabs resolve safely without prompting or registering a subscription', async () => {
  for (const options of [{supported:false},{ios:true},{denied:true}]) {
    const f=fixture(options),state=await f.controller.init();
    assert.equal(state.canEnable,false);await f.controller.enable();
    assert.equal(f.requests.filter(request=>request.path.includes('/subscribe')).length,0);
    if(options.ios)assert.match(state.message,/Home Screen/);
    if(options.denied)assert.match(state.message,/blocked/);
  }
});

test('retained expired browser subscription is replaced only by an explicit reconnect',async()=>{
 const f=fixture({retained:true,needsResubscribe:true});const initial=await f.controller.init();
 assert.equal(initial.subscribed,false);assert.equal(initial.needsResubscribe,true);assert.match(initial.message,/expired or changed/);
 assert.equal(f.requests.filter(request=>request.path.includes('/subscribe')).length,0);
 assert.deepEqual(f.events,[]);
 await f.controller.enable();assert.deepEqual(f.events,['unsubscribe','subscribe']);
 assert.equal(f.controller.getState().subscribed,true);assert.equal(f.controller.getState().needsResubscribe,false);
});

test('permission subscription starts synchronously in click, requires server persistence, and can be disabled',async()=>{
  const f=fixture();await f.controller.init();assert.equal(f.controller.getState().canEnable,true);
  f.markClick(true);const promise=f.controller.enable();f.markClick(false);await promise;
  assert.equal(f.wasSynchronous(),true);assert.equal(f.controller.getState().subscribed,true);assert.equal(f.controller.getState().canTest,true);
  await f.controller.test();assert.match(f.controller.getState().message,/queued/);
  await f.controller.disable();assert.equal(f.controller.getState().subscribed,false);
  const failing=fixture({failSubscribe:true});await failing.controller.init();await failing.controller.enable();assert.equal(failing.controller.getState().subscribed,false);assert.match(failing.controller.getState().error,/save subscription/);
});

test('service worker shows every push and only records display after showNotification resolves',async()=>{
  const listeners={},calls=[];
  const self={addEventListener(type,handler){listeners[type]=handler;},registration:{async showNotification(title,options){calls.push({type:'display',title,options});}},clients:{async matchAll(){return[];}},location:{origin:'https://pickup.example'}};
  const context=vm.createContext({self,URL,Date,fetch:async(path,request)=>{calls.push({type:'receipt',path,request});return new Response('{}');}});
  vm.runInContext(readFileSync(new URL('../public/sw.js',import.meta.url),'utf8'),context);
  let pending;
  listeners.push({data:{json:()=>({title:'Found it',body:'At Walt Whitman',delivery:{id:'a'.repeat(64),token:'secret'}})},waitUntil(promise){pending=promise;}});
  await pending;assert.deepEqual(calls.map(call=>call.type),['display','receipt']);assert.equal(calls[0].options.data.url,'/');
  assert.equal(calls[1].path,'/api/push/receipt');assert.equal(calls[1].request.credentials,'include');
  assert.equal(listeners.fetch,undefined);
  calls.length=0;self.registration.showNotification=async()=>{throw new Error('Permission revoked');};
  listeners.push({data:{json:()=>({delivery:{id:'a'.repeat(64),token:'secret'}})},waitUntil(promise){pending=promise;}});
  await assert.rejects(pending,/revoked/);assert.equal(calls.length,0);
});
