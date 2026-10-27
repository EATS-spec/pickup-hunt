import { CloudCatalog } from './catalog.mjs';
import { HuntService } from './hunt-service.mjs';
import { buildInventoryURL, parseInventory, InventoryError } from './inventory.mjs';
import { PushService } from './push.mjs';

export async function digest(value) {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value)))].map(n=>n.toString(16).padStart(2,'0')).join('');
}
const json = (value, code = 200, headers = {}) => new Response(JSON.stringify(value), {status:code,headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff',...headers}});
function tokenFor(request) {
  const value = request.headers.get('cookie')?.split(';').map(item=>item.trim()).find(item=>item.startsWith('pickup_session='))?.slice(15);
  return /^[a-f0-9]{64}$/.test(value || '') ? value : null;
}
async function session(request) {
  const existing = tokenFor(request), token = existing || (crypto.randomUUID()+crypto.randomUUID()).replaceAll('-','');
  return {id:await digest(token),cookie:existing ? null : `pickup_session=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000${new URL(request.url).protocol === 'https:' ? '; Secure' : ''}`};
}
async function createService(env) {
  if (!env.DB) throw new Error('Cloud database is not connected.');
  const catalog = new CloudCatalog({db:env.DB}); await catalog.load();
  const notifications = new PushService({db:env.DB,publicKey:env.VAPID_PUBLIC_KEY,privateKey:env.VAPID_PRIVATE_KEY,subject:env.VAPID_SUBJECT});
  const service = new HuntService({db:env.DB,catalog,notifications,cadenceMinutes:Number(env.SCHEDULE_CADENCE_MINUTES || 60), fetchInventory:async ({zip,variant})=>{
    const response = await fetch(buildInventoryURL(zip,[variant]),{headers:{Referer:'https://www.apple.com/shop/buy-iphone/',Accept:'application/json','Cache-Control':'no-cache'},signal:AbortSignal.timeout(35_000)});
    if (!response.ok) throw new InventoryError(`Apple returned HTTP ${response.status}.`,{statusCode:response.status,kind:[429,541].includes(response.status)?'throttled':'http'});
    let payload;try{payload=await response.json();}catch{throw new Error('Apple returned an invalid response.');}
    return parseInventory(payload,{models:[variant],anchor:{zip,city:`ZIP ${zip}`},observedAt:new Date().toISOString()});
  }});
  return {service,catalog,notifications};
}
async function isUpdater(request,env) {
  const caller = request.headers.get('oai-authenticated-user-email');
  // Enable only behind a trusted Sites proxy that strips visitor-supplied identity headers.
  // Generic Worker/self-hosted installations must leave this disabled and use the token path.
  if (env.TRUST_SITES_IDENTITY === 'true' && caller && env.OWNER_EMAIL && caller.toLowerCase() === env.OWNER_EMAIL.toLowerCase()) return true;
  // Fallback for the owner’s supported Site service credential. Public visitors
  // never receive this token; dispatch and app authorization are separate.
  const auth = request.headers.get('authorization');
  if(!auth?.startsWith('Bearer '))return false;
  const hash=await digest(auth.slice(7));
  return [env.UPDATER_TOKEN_HASH,env.CALLBACK_TOKEN_HASH].filter(Boolean).includes(hash);
}
async function readBody(request) {
  if (!(request.headers.get('content-type')||'').startsWith('application/json')) throw new Error('Send application/json.');
  if (Number(request.headers.get('content-length')) > 16_384) throw new Error('Request body is too large.');
  const reader=request.body?.getReader(); let text='',size=0; const decoder=new TextDecoder();
  if(reader)while(true){const{value,done}=await reader.read();if(done)break;size+=value.byteLength;if(size>16_384){await reader.cancel();throw new Error('Request body is too large.');}text+=decoder.decode(value,{stream:true});}text+=decoder.decode();
  return text ? JSON.parse(text) : {};
}
async function limitMutation(request,env) {
  const now=Date.now(),ip=request.headers.get('cf-connecting-ip')||'unknown';
  const reset=(Math.floor(now/3_600_000)+1)*3_600_000;
  const key=await digest(`${env.RATE_SALT || 'pickup-hunt'}:${reset}:${ip}`);
  await env.DB.prepare('DELETE FROM hunt_rate_limits WHERE reset_at < ?').bind(now).run();
  const result=await env.DB.prepare('INSERT INTO hunt_rate_limits (id,count,reset_at) VALUES (?,1,?) ON CONFLICT(id) DO UPDATE SET count=count+1 WHERE count < 60').bind(key,reset).run();
  if (!result.meta?.changes) {const error=new Error('Too many changes from this network. Please try again later. Existing watches continue.');error.statusCode=429;throw error;}
}
export async function handleAPI(request,env) {
  try {
    const url = new URL(request.url), path=url.pathname;
    const {service,catalog,notifications} = await createService(env);
    if (path==='/api/catalog' && request.method==='GET') return json(await catalog.load());
    if (path==='/api/health' && request.method==='GET') return json(await service.health());
    if (path==='/api/refresh' && request.method==='POST') {
      if (!await isUpdater(request,env)) return json({error:'Updater authorization required.'},403);
      if (catalog.snapshot.stale) await catalog.load({refresh:true});
      return json({tick:await service.tick(),health:await service.health()});
    }
    if (path==='/api/updater-health' && request.method==='GET') {
      if (!await isUpdater(request,env)) return json({error:'Updater authorization required.'},403);
      return json(await service.health());
    }
    const own = await session(request);
    const headers = own.cookie ? {'Set-Cookie':own.cookie} : {};
    if (path==='/api/status' && request.method==='GET') return json(await service.status(own.id),200,headers);
    if (path==='/api/push' && request.method==='GET') return json(await notifications.status(own.id),200,headers);
    if (request.method==='POST') {
      if (request.headers.get('origin')!==url.origin) return json({error:'Use Pickup Hunt from its own page.'},403);
      const input=await readBody(request);
      if (!input || typeof input!=='object' || Array.isArray(input)) throw new Error('Settings must be an object.');
      if (path==='/api/push/subscribe') {
        await limitMutation(request,env);
        if(Object.keys(input).some(key=>key!=='subscription'))throw new Error('Send a browser notification subscription.');
        return json(await notifications.subscribe(own.id,input.subscription),200,headers);
      }
      if (path==='/api/push/unsubscribe' || path==='/api/push/test') {
        if(Object.keys(input).length)throw new Error('Send an empty notification request.');
        if(path==='/api/push/test')await limitMutation(request,env);
        return json(await (path==='/api/push/test'?notifications.test(own.id):notifications.unsubscribe(own.id)),200,headers);
      }
      if(path==='/api/push/receipt')return json(await notifications.receipt(own.id,input),200,headers);
      if (path==='/api/catalog/refresh') return json(await catalog.load(),200,headers);
      if (path==='/api/search' || path==='/api/settings') {
        await limitMutation(request,env);
        let status=await service.configure(own.id,input,{check:path==='/api/search'});
        if(path==='/api/search' && status.scheduler.queuedScope){await service.tick();status=await service.status(own.id);}
        return json({accepted:true,status},path==='/api/search'?202:200,headers);
      }
      if (path==='/api/complete') return json({status:await service.complete(own.id,input)},200,headers);
      if (path==='/api/complete/reset') {
        if(Object.keys(input).length)throw new Error('Reset this hunt with an empty request.');
        return json({status:await service.resetCompletion(own.id)},200,headers);
      }
      if (path==='/api/monitor') {
        if(input.enabled===true)await limitMutation(request,env);
        if (typeof input.enabled!=='boolean' || (input.restart!==undefined && typeof input.restart!=='boolean')) throw new Error('enabled and restart must be booleans.');
        return json({status:await service.setMonitoring(own.id,input)},200,headers);
      }
    }
    return json({error:'Unknown API route.'},404);
  }catch(error){return json({error:error.message},[400,429,503].includes(error.statusCode)?error.statusCode:400);}
}
const toolDefinitions=[
 {name:'pickup_hunt_tick',description:'Refresh at most one due shared Apple pickup search through the durable request gate. Owner only. Returns persisted updater health.',inputSchema:{type:'object',properties:{},additionalProperties:false}},
 {name:'pickup_hunt_health',description:'Read cloud inventory updater heartbeat, request gate, and shared queue health. Owner only.',inputSchema:{type:'object',properties:{},additionalProperties:false}}
];
export async function handleMCP(request,env) {
  let id=null;
  try {
    const msg=await readBody(request);id=msg.id??null;
    const success=result=>json({jsonrpc:'2.0',id,result});
    if (msg.method==='server/discover') return success({supportedVersions:['2026-07-28'],capabilities:{tools:{}}});
    if (msg.method==='initialize') return success({protocolVersion:'2026-07-28',capabilities:{tools:{}},serverInfo:{name:'pickup-hunt',version:'1.0.0'}});
    if (msg.method?.startsWith('notifications/')) return new Response(null,{status:204});
    if (msg.method==='tools/list') return success({tools:toolDefinitions});
    if (msg.method==='tools/call') {
      if (!await isUpdater(request,env)) return success({isError:true,content:[{type:'text',text:'Only the Site owner can operate the shared updater.'}]});
      const {service,catalog}=await createService(env);let value;
      if (msg.params?.name==='pickup_hunt_health') value=await service.health();
      else if (msg.params?.name==='pickup_hunt_tick') {
        if (catalog.snapshot.stale) await catalog.load({refresh:true});
        value={tick:await service.tick(),health:await service.health()};
      } else throw new Error('Unknown tool.');
      return success({content:[{type:'text',text:JSON.stringify(value)}]});
    }
    return json({jsonrpc:'2.0',id,error:{code:-32601,message:'Method not found'}},200);
  }catch(error){return json({jsonrpc:'2.0',id,error:{code:-32000,message:error.message}},200);}
}
