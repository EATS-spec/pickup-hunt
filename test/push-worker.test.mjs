import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { Miniflare, createFetchMock } from 'miniflare';

test('deployed Web Push crypto and request construction run inside the actual Workers runtime', async () => {
  const source = `import {sendWebPush} from './lib/push.mjs';
const b64=a=>btoa(String.fromCharCode(...new Uint8Array(a))).replaceAll('+','-').replaceAll('/','_').replaceAll('=','');
export default {async fetch(){
const browser=await crypto.subtle.generateKey({name:'ECDH',namedCurve:'P-256'},true,['deriveBits']);
const signing=await crypto.subtle.generateKey({name:'ECDSA',namedCurve:'P-256'},true,['sign','verify']);
const jwk=await crypto.subtle.exportKey('jwk',signing.privateKey);
const vapid={publicKey:b64(await crypto.subtle.exportKey('raw',signing.publicKey)),privateKey:jwk.d,subject:'https://pickup.example/'};
const subscription={endpoint:'https://fcm.googleapis.com/fcm/send/private-test',expirationTime:null,keys:{p256dh:b64(await crypto.subtle.exportKey('raw',browser.publicKey)),auth:b64(crypto.getRandomValues(new Uint8Array(16)))}};
let captured;
await sendWebPush(subscription,{title:'Test',body:'Hello',tag:'hunt-test'},vapid,{fetcher:async(url,request)=>{new Request(url,request);captured=request;return new Response('',{status:201});}});
// Exercise native Workers fetch validation too. The outbound service is mocked
// outside the Worker, after fetch has validated its RequestInit.
const nativeResponse=await sendWebPush(subscription,{title:'Native request test',tag:'hunt-test'},vapid);
let diagnostic;
try {await sendWebPush(subscription,{title:'Test',tag:'hunt-test'},vapid,{fetcher:async()=>{throw new TypeError('private endpoint and key canary must not leak');}});}catch(error){diagnostic=error.message;}
return Response.json({length:captured.body.byteLength,encoding:captured.headers['Content-Encoding'],vapid:captured.headers.authorization.startsWith('vapid t='),redirect:captured.redirect,nativeStatus:nativeResponse.status,diagnostic});
}};`;
  const bundle = await build({ stdin: { contents: source, resolveDir: new URL('..',import.meta.url).pathname }, bundle:true, format:'esm', platform:'browser',write:false });
  const fetchMock=createFetchMock();fetchMock.disableNetConnect();
  fetchMock.get('https://fcm.googleapis.com').intercept({path:'/fcm/send/private-test',method:'POST'}).reply(201,'');
  const runtime = new Miniflare({modules:true,script:bundle.outputFiles[0].text,compatibilityDate:'2026-05-15',compatibilityFlags:['nodejs_compat'],fetchMock});
  try {
    const response=await runtime.dispatchFetch('https://probe.example/'),result=await response.json();
    assert.equal(result.length,4096);assert.equal(result.encoding,'aes128gcm');assert.equal(result.vapid,true);assert.equal(result.redirect,'manual');
    assert.equal(result.nativeStatus,201);
    assert.match(result.diagnostic,/transport: TypeError/);assert.ok(!result.diagnostic.includes('canary'));assert.ok(!result.diagnostic.includes('private-test'));
  }finally{await runtime.dispose();}
});
