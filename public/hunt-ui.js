import {filterWatchedRows} from './settings.js';
import {configuredCheckoutURL} from './checkout.js';
import {buildPhoneSVG} from './hunt-tools.js';
const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export function huntStage(state, {dirty=false,disconnected=false}={}) {
  if(state?.completion&&!dirty)return {key:'complete',label:'Mission complete',step:2,description:'You found your phone. Your watch is off, and this little hunt is in the books.'};
  if(dirty)return {key:'preview',label:'Making it yours',step:0,description:'A preview of your next hunt. Apply your choices when you’re ready.'};
  if(!state?.config?.zip)return {key:'setup',label:'Ready when you are',step:0,description:'Pick your phone and add a ZIP. A good find starts with a little looking.'};
  if(disconnected)return {key:'offline',label:'Waiting to reconnect',step:0,description:'Your saved watch may keep running. Reconnect to see its latest results.'};
  if(state.scheduler?.inFlight)return {key:'checking',label:'Eyes on the prize',step:0,description:'Checking Apple’s pickup feed for your saved phone.'};
  const hits=filterWatchedRows(state.hits||[],state.config).filter(row=>!row.stale&&row.availability==='available');
  if(hits.length)return {key:'found',label:'A good find',step:1,count:hits.length,description:`${hits[0].storeName}${hits.length>1?` + ${hits.length-1} more`:''}. Confirm the pickup date and finish your order at Apple.`};
  if(state.scheduler?.backoffMinutes)return {key:'cooldown',label:'Taking a breather',step:0,description:`Apple asked us to slow down. The shared queue is cooling down for ${state.scheduler.backoffMinutes} minutes.`};
  if(['error','throttled'].includes(state.lastCheck?.outcome))return {key:'delayed',label:'A pause in the trail',step:0,description:'The latest check didn’t finish. Earlier results stay labeled with their original time.'};
  if(state.monitor?.enabled)return {key:'watching',label:'On the lookout',step:0,description:'Your cloud watch is active. We’ll check again when your turn comes around.'};
  return {key:'paused',label:'A little pause',step:0,description:'Your picks are saved. Check now or start a cloud watch when you’re ready.'};
}
export function huntCardMarkup({state,draft,variant,dirty=false,disconnected=false}) {
  const stage=huntStage(state,{dirty,disconnected});
  const completed=stage.key==='complete';
  const selected=completed?state.completion.variant:variant;
  const settings=completed?state.completion:(dirty?draft:state?.config)||draft||{};
  const stores=completed?(state.completion.storeName||'A good find'):(settings.watchAllNearby!==false?'Nearby Apple Stores':`${settings.storeNumbers?.length||0} chosen store${settings.storeNumbers?.length===1?'':'s'}`);
  const model=selected?.modelName||selected?.name||'Your next iPhone';
  const date=state?.lastCheck?.completedAt;
  const checked=date?new Intl.DateTimeFormat('en-US',{timeZone:'America/New_York',month:'short',day:'numeric',hour:'numeric',minute:'2-digit'}).format(new Date(date)):null;
  const labels=['On the lookout','Spotted','Got it'];
  const link=selected?configuredCheckoutURL(selected.partNumber,[selected]):null;
  return `<div class="hunt-card-eyebrow"><span>Your hunt card</span><span>${dirty?'Preview':completed?'Filed under: found':'One good find'}</span></div>
    <div class="phone-scene" aria-hidden="true">${buildPhoneSVG({color:selected?.color,modelId:selected?.modelId,complete:completed})}</div>
    <div class="hunt-card-heading-wrap"><p class="hunt-card-model">${esc(model)}</p><h2 class="hunt-card-heading">${esc(selected?.color||'Make it yours.')}<span>${esc(selected?.storage||'')}</span></h2></div>
    <div class="hunt-card-meta"><span>${esc(stores)}</span><span>${completed?'Confirmed by you':settings.zip?`Near ${esc(settings.zip)}`:'Add your ZIP'}</span></div>
    <div class="hunt-card-status" data-stage="${stage.key}"><span class="status-spark" aria-hidden="true">${completed?'✳':stage.key==='found'?'↗':'◉'}</span>${esc(stage.label)}</div>
    <p class="hunt-card-copy">${esc(stage.description)}</p>
    <ol class="hunt-card-progress" aria-label="Hunt progress">${labels.map((label,i)=>`<li class="hunt-card-step ${stage.step>=i?'is-current':''}"${stage.step===i?' aria-current="step"':''}><span>${i+1}</span>${label}</li>`).join('')}</ol>
    ${stage.key==='found'&&link?`<a class="card-apple-link" href="${esc(link)}" target="_blank" rel="noreferrer">See pickup at Apple ↗</a>`:''}
    <p class="hunt-card-footnote">${completed?'A hunter-confirmed finish. Apple orders aren’t verified here.':dirty?'Preview only. Saved results below keep their original target.':checked?`Last checked ${esc(checked)} ET. An alert isn’t a reservation.`:'Your phone illustration is a playful preview.'}</p>`;
}
