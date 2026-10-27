import test from 'node:test';
import assert from 'node:assert/strict';
import {createTestD1} from './helpers/d1.mjs';
import {handleAPI,handleMCP,digest} from '../lib/api.mjs';
const origin='https://pickup.example';
const req=(path,body,headers={})=>new Request(origin+path,{method:body===undefined?'GET':'POST',headers:{...(body===undefined?{}:{'content-type':'application/json',origin}),...headers},...(body===undefined?{}:{body:JSON.stringify(body)})});

test('anonymous cookies are private, secure, independent, and never stored as plaintext',async()=>{
 const db=createTestD1(),env={DB:db};
 try{
  const a=await handleAPI(req('/api/status'),env),b=await handleAPI(req('/api/status'),env);
  const cookieA=a.headers.get('set-cookie'),cookieB=b.headers.get('set-cookie');
  assert.match(cookieA,/HttpOnly; SameSite=Lax; Max-Age=2592000; Secure/);assert.notEqual(cookieA,cookieB);
  const state=await a.json();assert.equal(state.config.zip,'');assert.equal(state.monitor.enabled,false);
  const chosen={selection:state.config.selection,zip:'10001',watchHours:4,watchAllNearby:true,storeNumbers:[],partNumber:'EVIL',checkoutUrl:'https://evil.test'};
  const saved=await handleAPI(req('/api/settings',chosen,{cookie:cookieA.split(';')[0]}),env);assert.equal(saved.status,200);
  const same=await(await handleAPI(req('/api/status',undefined,{cookie:cookieA.split(';')[0]}),env)).json();
  const other=await(await handleAPI(req('/api/status',undefined,{cookie:cookieB.split(';')[0]}),env)).json();
  assert.equal(same.config.zip,'10001');assert.equal(other.config.zip,'');assert.notEqual(same.config.models[0].partNumber,'EVIL');
  const rows=db.sqlite.prepare('SELECT id,settings_json FROM hunt_watches').all();assert.equal(rows.length,1);assert.equal(rows[0].id,await digest(cookieA.split(';')[0].slice(15)));assert.ok(!JSON.stringify(rows).includes(cookieA.split(';')[0].slice(15)));
 }finally{db.close();}
});
test('public writers require same origin and updater requires independent authorization',async()=>{
 const db=createTestD1(),token='test-service-credential',env={DB:db,OWNER_EMAIL:'owner@example.test',TRUST_SITES_IDENTITY:'true',UPDATER_TOKEN_HASH:await digest(token)};
 try{
  assert.equal((await handleAPI(req('/api/settings',{}, {origin:'https://evil.test'}),env)).status,403);
  assert.equal((await handleAPI(req('/api/refresh',{}),env)).status,403);
  assert.equal((await handleAPI(req('/api/updater-health'),env)).status,403);
  assert.equal((await handleAPI(req('/api/updater-health',undefined,{authorization:`Bearer ${token}`}),env)).status,200);
  const mcp=async email=>(await(await handleMCP(req('/mcp',{jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'pickup_hunt_health',arguments:{}}},email?{'oai-authenticated-user-email':email}:{}),env)).json());
  assert.equal((await mcp('visitor@example.test')).result.isError,true);
  assert.ok((await mcp('owner@example.test')).result.content[0].text.includes('activeJobs'));
 }finally{db.close();}
});
test('self-hosted defaults reject a forged Sites identity header',async()=>{
 const db=createTestD1(),env={DB:db,OWNER_EMAIL:'owner@example.test'};
 try{
  const headers={'oai-authenticated-user-email':'owner@example.test'};
  assert.equal((await handleAPI(req('/api/updater-health',undefined,headers),env)).status,403);
  assert.equal((await handleAPI(req('/api/refresh',{},headers),env)).status,403);
  const result=await(await handleMCP(req('/mcp',{jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'pickup_hunt_health',arguments:{}}},headers),env)).json();
  assert.equal(result.result.isError,true);
  env.TRUST_SITES_IDENTITY='true';
  assert.equal((await handleAPI(req('/api/updater-health',undefined,headers),env)).status,200);
 }finally{db.close();}
});
test('manual search executes in the cloud once and a second visitor reuses the warm shared result',async()=>{
 const db=createTestD1(),env={DB:db},original=globalThis.fetch;let calls=0;
 try{
  const initial=await(await handleAPI(req('/api/status'),env)).json();
  const variant=initial.config.models[0];
  globalThis.fetch=async url=>{calls++;assert.equal(new URL(url).hostname,'www.apple.com');return new Response(JSON.stringify({body:{stores:[{storeNumber:'R001',storeName:'Test Store',state:'NY',partsAvailability:{[variant.partNumber]:{partNumber:variant.partNumber,pickupDisplay:'available',pickupQuote:'Available Today'}}}]}}),{headers:{'content-type':'application/json'}});};
  const body={selection:initial.config.selection,zip:'10001',watchHours:1,watchAllNearby:true,storeNumbers:[]};
  const first=await handleAPI(req('/api/search',body),env);assert.equal(first.status,202);const a=await first.json();assert.equal(a.status.lastCheck.outcome,'success');assert.equal(a.status.hits.length,1);
  const second=await handleAPI(req('/api/search',body),env);assert.equal(second.status,202);assert.equal((await second.json()).status.hits.length,1);assert.equal(calls,1);
 }finally{globalThis.fetch=original;db.close();}
});

test('completion API is cookie scoped, same-origin, validates its input, and never queries Apple',async()=>{
 const db=createTestD1(),env={DB:db},original=globalThis.fetch;let calls=0;
 try{
  globalThis.fetch=async()=>{calls++;throw new Error('Completion must not query Apple');};
  const first=await handleAPI(req('/api/status'),env),second=await handleAPI(req('/api/status'),env);
  const cookie=first.headers.get('set-cookie').split(';')[0],otherCookie=second.headers.get('set-cookie').split(';')[0];
  const initial=await first.json();
  assert.equal((await handleAPI(req('/api/complete',{}, {cookie}),env)).status,400);
  const body={selection:initial.config.selection,zip:'10001',watchHours:1,watchAllNearby:true,storeNumbers:[]};
  assert.equal((await handleAPI(req('/api/settings',body,{cookie}),env)).status,200);
  assert.equal((await handleAPI(req('/api/complete',{}, {cookie,origin:'https://evil.test'}),env)).status,403);
  assert.equal((await handleAPI(req('/api/complete',{storeNumber:'R999'}, {cookie}),env)).status,400);
  assert.equal((await handleAPI(req('/api/complete',{caption:'Fake purchase'}, {cookie}),env)).status,400);
  const response=await handleAPI(req('/api/complete',{}, {cookie}),env);assert.equal(response.status,200);
  const a=(await response.json()).status;
  assert.equal(a.completion.confirmedBy,'visitor');assert.equal(a.monitor.enabled,false);
  assert.equal((await(await handleAPI(req('/api/status',undefined,{cookie:otherCookie}),env)).json()).completion,null);
  const repeat=await handleAPI(req('/api/complete',{}, {cookie}),env);assert.deepEqual((await repeat.json()).status.completion,a.completion);
  assert.equal((await handleAPI(req('/api/complete/reset',{enabled:true}, {cookie}),env)).status,400);
  const reset=await handleAPI(req('/api/complete/reset',{}, {cookie}),env);assert.equal(reset.status,200);
  assert.equal((await reset.json()).status.completion,null);
  assert.equal(calls,0);
 }finally{globalThis.fetch=original;db.close();}
});

test('push API is opt-in, same-origin, browser scoped and does not send during subscription or test scheduling',async()=>{
 const db=createTestD1(),original=globalThis.fetch;let calls=0;
 try{
  const keys=await crypto.subtle.generateKey({name:'ECDH',namedCurve:'P-256'},true,['deriveBits']);
  const b64=value=>Buffer.from(value).toString('base64url');
  const publicKey=b64(await crypto.subtle.exportKey('raw',keys.publicKey));
  const env={DB:db,VAPID_PUBLIC_KEY:publicKey,VAPID_PRIVATE_KEY:'configured-only-no-send',VAPID_SUBJECT:origin+'/'};
  const subscription={endpoint:'https://fcm.googleapis.com/fcm/send/private-example',keys:{p256dh:publicKey,auth:b64(crypto.getRandomValues(new Uint8Array(16)))},expirationTime:null};
  globalThis.fetch=async()=>{calls++;throw new Error('No outgoing request expected');};
  const first=await handleAPI(req('/api/push'),env),second=await handleAPI(req('/api/push'),env);
  const cookie=first.headers.get('set-cookie').split(';')[0],other=second.headers.get('set-cookie').split(';')[0];
  assert.equal((await first.json()).subscribed,false);
  assert.equal((await handleAPI(req('/api/push/subscribe',{subscription},{cookie,origin:'https://evil.test'}),env)).status,403);
  assert.equal((await handleAPI(req('/api/push/subscribe',{subscription:{...subscription,endpoint:'https://127.0.0.1/private'}},{cookie}),env)).status,400);
  assert.equal((await handleAPI(req('/api/push/subscribe',{subscription},{cookie}),env)).status,200);
  const ownStatus=await(await handleAPI(req('/api/push',undefined,{cookie}),env)).json();
  assert.equal(ownStatus.subscribed,true);assert.ok(!JSON.stringify(ownStatus).includes('private-example'));
  assert.equal((await(await handleAPI(req('/api/push',undefined,{cookie:other}),env)).json()).subscribed,false);
  assert.equal((await handleAPI(req('/api/push/test',{}, {cookie:other}),env)).status,400);
  const queued=await handleAPI(req('/api/push/test',{}, {cookie}),env);assert.equal(queued.status,200);assert.equal((await queued.json()).queued,true);
  assert.equal((await handleAPI(req('/api/push/test',{}, {cookie}),env)).status,429);
  assert.equal((await handleAPI(req('/api/push/unsubscribe',{}, {cookie:other}),env)).status,200);
  assert.equal((await(await handleAPI(req('/api/push',undefined,{cookie}),env)).json()).subscribed,true);
  await handleAPI(req('/api/push/unsubscribe',{}, {cookie}),env);
  assert.equal((await(await handleAPI(req('/api/push',undefined,{cookie}),env)).json()).subscribed,false);
  assert.equal(calls,0);
 }finally{globalThis.fetch=original;db.close();}
});
