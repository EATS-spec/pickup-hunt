import {createHuntLink, readHuntInvite, buildVictorySVG} from './hunt-tools.js';
import {huntStage, huntCardMarkup} from './hunt-ui.js';
import {configuredCheckoutURL, selectCurrentAlert} from './checkout.js';
import {selectionOptions, draftFromConfig, reconcileDraft, updateDraft, draftIsDirty, settingsPayload, isWatchedStore, filterWatchedRows} from './settings.js';
import {setupGuide} from './setup-guide.js';
import {createPushController} from './push-client.js';

const $ = id => document.getElementById(id);
const ids = ['watch-form','model','color','storage','zip','watch-hours','all-nearby','selected-stores','select-all-stores','clear-stores','store-choices','check','start-watch','stop-watch','save-settings','refresh-catalog','sound','status','scope-note','filter','stores','matches','history','runtime','draft-note','form-error'];
const els = Object.fromEntries(ids.map(id => [id, $(id)]));
let state, catalog, draft, busy = false, catalogBusy = false, disconnected = false;
let commandError = '', commandNotice = '', formError = '', catalogError = '';
let audio, sound = false, knownAlerts = new Set(), alertStorageKey = '';
let rowsKey = '', storeChoicesKey = '', huntCardKey = '', victoryKey = '';
let inviteProcessed=false, inviteMessage='', pendingInviteStores=null, sharedSelection=null;
let pushState = {busy:true,message:'Checking notification support…'};
const push = createPushController({onChange(next) { pushState=next; renderPushSettings(); if(state)renderStatus(); }});
const esc = value => String(value ?? '').replace(/[&<>"']/g, character => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[character]));
const config = () => state?.config || {};
const activeModel = () => config().models?.[0];
const activeName = () => activeModel()?.name || Object.values(config().selection || {}).filter(Boolean).join(' · ') || 'No phone selected';
const modelName = row => row.partName || config().models?.find(model => model.partNumber === row.partNumber)?.name || row.partNumber;
const checkoutURL = row => configuredCheckoutURL(row.partNumber, config().models || []);
const formatTime = (value, includeDate = false) => {
  const date = new Date(value);
  if (!value || Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat('en-US', {timeZone:'America/New_York', ...(includeDate ? {month:'short', day:'numeric'} : {}), hour:'numeric', minute:'2-digit'}).format(date);
};
const rank = row => (row.stale ? 100 : 0) + (row.availability === 'available' ? 0 : 20);
const currentRows = () => {
  const parts = new Set((config().models || []).map(model => model.partNumber));
  return (state?.observations || []).filter(row => parts.has(row.partNumber)).map(row => disconnected ? {...row, stale:true, staleReason:'Unable to refresh cloud status. Last saved result.'} : row);
};
const nearbyStores = () => state?.stores || [...new Map(currentRows().map(row => [row.storeNumber, row])).values()];

function renderFields() {
  if (!draft) return;
  const options = selectionOptions(catalog, draft.selection);
  const fill = (element, values, selected, placeholder) => {
    element.innerHTML = values.length ? values.map(value => `<option value="${esc(value.value)}">${esc(value.label)}</option>`).join('') : `<option value="">${placeholder}</option>`;
    element.value = selected || '';
  };
  fill(els.model, options.models.map(model => ({value:model.id, label:model.name})), draft.selection.modelId, 'No models available');
  fill(els.color, options.colors.map(color => ({value:color, label:color})), draft.selection.color, 'Choose a model');
  fill(els.storage, options.storages.map(storage => ({value:storage, label:storage})), draft.selection.storage, 'Choose a color');
  els.zip.value = draft.zip;
  els['watch-hours'].value = String(draft.watchHours);
}

function syncAlertProfile() {
  const key = `pickup-alerts:${config().profileId || JSON.stringify([config().selection, config().zip])}`;
  if (key === alertStorageKey) return;
  alertStorageKey = key;
  let saved = [];
  try { saved = JSON.parse(localStorage.getItem(key) || '[]'); } catch {}
  knownAlerts = new Set(Array.isArray(saved) ? saved : []);
}

function renderIdentity() {
  $('brand').textContent = 'Pickup Hunt';
  $('headline').textContent = 'Good phones. Worth the hunt.';
  $('subhead').textContent = 'Pick your prize. Choose your stores. We’ll keep an eye out.';
  if (!state) return;
  const settings = config();
  const storeCount = (settings.storeNumbers || []).length;
  const selectedStoresLabel = `selected store${storeCount === 1 ? '' : 's'}`;
  $('facts').innerHTML = settings.zip ? `<span>Saved ZIP <strong>${esc(settings.zip)}</strong></span><span><strong>${settings.watchAllNearby !== false ? 'All nearby' : storeCount}</strong> ${settings.watchAllNearby !== false ? 'stores' : selectedStoresLabel}</span>` : '<span>US Apple Stores</span><span>No sign-in needed</span>';
  $('notice').textContent = settings.onlinePickupNote || 'Online pickup only. Walk-in stock can be different. An alert does not reserve a phone.';
  $('checkout-note').textContent = settings.checkoutNote || 'Choose your carrier and payment options at Apple, then confirm the pickup store and date.';
  $('active-target').textContent = settings.zip ? `Saved target: ${activeName()} · ZIP ${settings.zip}` : 'Your next pickup starts here.';
  const locations = settings.watchAllNearby !== false ? 'all nearby stores' : `${storeCount} ${selectedStoresLabel}`;
  const stopAt = state.monitor?.stopAt;
  $('watch-state').textContent = state.completion ? 'Mission complete · Your watch is off.' : state.monitor?.enabled
    ? `Cloud watch active · ${locations}${stopAt ? ` · Ends ${formatTime(stopAt, true)} ET` : ''}`
    : settings.zip ? `Watch paused · ${locations} · Start a watch for automatic checks.` : 'Enter your ZIP code, check availability, then choose the stores you want.';
  const model = activeModel();
  $('checkout-link').href = configuredCheckoutURL(model?.partNumber, settings.models || []);
  $('checkout-link').textContent = `${settings.checkoutLabel || 'Configure at Apple'}${model ? ` · ${model.name}` : ''} ↗`;
  $('checkout-footnote').textContent = `${model ? `${model.name}. ` : ''}Confirm the pickup store, date, carrier, and payment choice at Apple before buying.`;
}

function renderFormStatus() {
  const ready = !!draft && !!selectionOptions(catalog, draft.selection).variant;
  const validZIP = /^\d{5}$/.test(String(draft?.zip || '').trim());
  const dirty = draftIsDirty(draft, config());
  for (const id of ['model','color','storage']) els[id].disabled = busy || !ready;
  for (const id of ['zip','watch-hours','all-nearby','selected-stores']) els[id].disabled = busy || !draft;
  els['selected-stores'].disabled = busy || !draft || String(draft.zip).trim() !== String(config().zip || '').trim() || !nearbyStores().length;
  for (const id of ['select-all-stores','clear-stores']) els[id].disabled = els['selected-stores'].disabled;
  els.check.disabled = busy || !ready || !validZIP;
  const guide = currentSetupGuide();
  els.check.innerHTML = `${esc(guide.checkLabel)} <span aria-hidden="true">↗</span>`;
  els['start-watch'].disabled = busy || !ready || !validZIP;
  els['start-watch'].innerHTML = `${esc(guide.startLabel)} <span aria-hidden="true">↗</span>`;
  els['stop-watch'].disabled = busy || !state?.monitor?.enabled;
  els['save-settings'].disabled = busy || !ready || !validZIP || !dirty;
  els['refresh-catalog'].disabled = busy || catalogBusy;
  if (draft) {
    els['all-nearby'].checked = draft.watchAllNearby;
    els['selected-stores'].checked = !draft.watchAllNearby;
  }
  els['draft-note'].hidden = !dirty || !config().zip;
  const pending = selectionOptions(catalog, draft?.selection).variant?.name || 'your new phone';
  els['draft-note'].textContent = dirty
    ? config().zip ? `Preview: ${pending} near ${draft.zip || 'your ZIP code'}. Results below still belong to ${activeName()} near ${config().zip}. Check stock or start your watch to apply these choices.` : '' : '';
  els['form-error'].hidden = !formError;
  els['form-error'].textContent = formError;
  const updated = catalog?.updatedAt ? `Updated ${formatTime(catalog.updatedAt, true)} ET` : 'Catalog loaded';
  $('catalog-note').textContent = catalogBusy ? 'Refreshing product catalog…' : catalogError || (catalog ? `${catalog.stale ? 'Using saved catalog · ' : ''}${updated}${catalog.error ? ` · ${catalog.error}` : ''}` : 'Product catalog unavailable. Try Refresh catalog.');
}

function currentSetupGuide() {
  return setupGuide({state,draft,variant:selectionOptions(catalog,draft?.selection).variant,dirty:draftIsDirty(draft,config()),busy,disconnected});
}

function renderSetupGuide() {
  const guide=currentSetupGuide();
  $('setup-heading').textContent=guide.heading;
  $('setup-description').textContent=guide.description;
  $('setup-steps').innerHTML=['Pick your phone','Choose your stores','Start your watch'].map((label,index)=>`<li class="${index<guide.step?'is-done':index===guide.step?'is-current':''}"${index===guide.step?' aria-current="step"':''}><span aria-hidden="true">${index<guide.step?'✓':index+1}</span>${label}</li>`).join('');
  $('store-step-hint').textContent=guide.hasStores?'Keep all nearby stores, or choose only the ones you would travel to.':'Your nearby stores will appear after the first check. All nearby stores are included by default.';
  $('first-look-note').textContent=guide.active?'A one-time look at pickup stock. Your active cloud watch keeps its own schedule.':'A one-time look at pickup stock. Your watch starts in step 3.';
  $('watch-summary').textContent=state?.monitor?.enabled&&!draftIsDirty(draft,config())
    ? `Your watch is active${state.monitor.stopAt?` until ${formatTime(state.monitor.stopAt,true)} ET`:''}. Restarting begins a new ${draft?.watchHours||24}-hour watch.`
    : `Watch ${guide.storeSummary.toLowerCase()} for ${draft?.watchHours||24} hour${Number(draft?.watchHours)===1?'':'s'}. Start cloud watch saves these choices and begins automatic checks.`;
}

function renderPushSettings() {
  const info=pushState||{};
  $('notification-status').textContent=info.message||'Notifications are optional. Enable them for stock alerts with this page closed.';
  $('notification-badge').textContent=info.busy?'Working…':info.subscribed?'Enabled':info.installRequired?'Home Screen':info.permission==='denied'?'Blocked':info.supported===false?'Unavailable':info.configured===false?'Not ready':'Optional';
  $('notification-panel').classList.toggle('is-enabled',!!info.subscribed);
  $('notification-error').hidden=!info.error;
  $('notification-error').textContent=info.error||'';
  let help='';
  if(info.installRequired)help='On iPhone or iPad: open this site in Safari, tap Share → Add to Home Screen, then open Pickup Hunt from that icon. Set up your watch and enable notifications there; the installed app may have separate saved choices.';
  else if(info.permission==='denied')help='Notifications are blocked for this site. Allow them in your browser or device notification settings, then reload this page.';
  else if(info.supported===false)help='Try a current version of Safari, Chrome, or Firefox on a supported device. Your cloud watch can still run here.';
  else if(info.subscribed)help='Alerts go to this browser or installed app. Keep its notifications allowed. An alert does not reserve a phone.';
  $('notification-help').textContent=help;
  $('notification-help').hidden=!help;
  $('enable-notifications').hidden=!!info.subscribed||!!info.installRequired||info.permission==='denied'||info.supported===false;
  $('enable-notifications').disabled=!info.canEnable||!!info.busy;
  $('enable-notifications').textContent=info.busy?'One moment…':'Enable notifications';
  $('test-notifications').hidden=!info.subscribed;
  $('test-notifications').disabled=!info.canTest||!!info.busy;
  $('disable-notifications').hidden=!info.subscribed;
  $('disable-notifications').disabled=!!info.busy;
  const delivery=[];
  if(info.lastSentAt)delivery.push(`Last alert accepted by the push service ${formatTime(info.lastSentAt,true)} ET.`);
  if(info.lastDisplayedAt)delivery.push(`Device confirmed display ${formatTime(info.lastDisplayedAt,true)} ET.`);
  if(info.lastError)delivery.push(`Latest delivery: ${info.lastError}`);
  $('notification-delivery').textContent=delivery.join(' ');
}

function renderStoreChoices() {
  if (!draft) return;
  const stores = nearbyStores();
  const sameZIP = String(draft.zip).trim() === String(config().zip || '').trim();
  const key = JSON.stringify([stores, sameZIP, draft.watchAllNearby, draft.storeNumbers, busy]);
  if (key === storeChoicesKey) return;
  storeChoicesKey = key;
  if (!sameZIP) {
    els['store-choices'].innerHTML = '<p>Check availability at the new ZIP code to choose its nearby stores. All nearby stores will be included in that search.</p>';
    return;
  }
  if (!stores.length) {
    els['store-choices'].innerHTML = '<p>Check availability to choose individual nearby stores.</p>';
    return;
  }
  els['store-choices'].innerHTML = stores.map(store => `<label class="store-choice"><input type="checkbox" data-store-number="${esc(store.storeNumber)}" ${draft.watchAllNearby || draft.storeNumbers.includes(store.storeNumber) ? 'checked' : ''} ${busy ? 'disabled' : ''}><span><strong>${esc(store.storeName || store.name || store.storeNumber)}</strong><small>${esc([store.city, store.state].filter(Boolean).join(', '))}${store.stale ? ' · saved result' : ''}</small></span></label>`).join('');
}

function renderRows() {
  let rows = currentRows();
  if (els.filter.value === 'watched') rows = filterWatchedRows(rows, config());
  if (els.filter.value === 'available') rows = filterWatchedRows(rows, config()).filter(row => row.availability === 'available' && !row.stale);
  rows.sort((a,b) => rank(a)-rank(b) || (a.distanceFromAnchorMiles ?? Infinity)-(b.distanceFromAnchorMiles ?? Infinity) || a.storeName.localeCompare(b.storeName));
  if (!rows.length) {
    els.stores.innerHTML = `<tr><td class="empty" colspan="4">${els.filter.value === 'available' ? 'No current pickup matches in the watched stores.' : state?.lastCheck ? 'No store results for the saved target yet. Check status above for any feed error.' : 'No scan yet. Choose your phone and ZIP code, then check availability.'}</td></tr>`;
    return;
  }
  els.stores.innerHTML = rows.map(row => {
    const available = row.availability === 'available' && !row.stale;
    const watched = isWatchedStore(row.storeNumber, config());
    const statusClass = row.stale ? 'stale' : available ? 'good' : '';
    const extra = row.stale ? `<span class="small stale">Stale · ${esc(row.staleReason || 'awaiting a fresh check')}</span>` : available ? '<span class="small">Confirm the pickup date at Apple</span>' : '';
    return `<tr><td><span class="store-name">${esc(row.storeName)}</span><span class="city">${esc([row.city,row.state].filter(Boolean).join(', '))}</span><span class="small">${watched ? 'Watched store' : 'Not watched'}</span></td><td><a class="product" target="_blank" rel="noreferrer" href="${esc(checkoutURL(row))}">${esc(modelName(row))}</a></td><td class="quote ${statusClass}">${esc(row.pickupQuote || (available ? 'Pickup available' : 'Availability unconfirmed'))}${extra}</td><td>${esc(formatTime(row.observedAt, row.stale))}${row.stale ? '<span class="small stale">Last saved result</span>' : '<span class="small">ET</span>'}</td></tr>`;
  }).join('');
}

function renderHits() {
  const hits = disconnected ? [] : filterWatchedRows(state?.hits || [], config()).filter(row => !row.stale);
  els.matches.hidden = !hits.length;
  els.matches.classList.toggle('unverified', hits.length > 0 && !hits.some(row => row.targetDateStatus === 'verified'));
  if (!hits.length) { document.title = 'Pickup Hunt'; return; }
  els.matches.innerHTML = `<h3>Pickup stock found</h3>${hits.slice(0,6).map(row => `<p><a target="_blank" rel="noreferrer" href="${esc(checkoutURL(row))}">${esc(row.storeName)} · ${esc(modelName(row))} ↗</a><br><span>${esc(row.pickupQuote || 'Confirm the pickup date at Apple')}</span></p>`).join('')}`;
  document.title = `Stock found · ${modelName(hits[0])} · Pickup Hunt`;
}

function renderStatus() {
  const schedule = state?.scheduler || {}, last = state?.lastCheck;
  if (disconnected) els.status.textContent = 'Can’t refresh your watch status. A saved cloud watch can continue; reconnect to see fresh results.';
  else if (commandError) els.status.textContent = commandError;
  else if (busy) els.status.textContent = 'Applying your choices…';
  else if (state?.completion) els.status.textContent = 'Mission complete. Your watch is off.';
  else if (schedule.inFlight) els.status.textContent = 'Checking Apple’s pickup feed for the saved target…';
  else if (['error','throttled'].includes(last?.outcome)) els.status.textContent = `${last.outcome === 'throttled' ? 'Apple is throttling checks' : 'Check failed'} · ${last.error || 'No inventory returned'}. Saved results may be stale.`;
  else if (commandNotice) els.status.textContent = commandNotice;
  else if (last?.completedAt) els.status.textContent = `Last check ${formatTime(last.completedAt, true)} ET${Number.isFinite(last.storeCount) ? ` · ${last.storeCount} stores in latest check` : ''}${Number.isFinite(last.availableCount) ? ` · ${last.availableCount} pickup match${last.availableCount === 1 ? '' : 'es'} in latest check` : ''}`;
  else els.status.textContent = state?.monitor?.enabled ? 'Watch starting…' : 'Ready to check · Watch paused';
  if (schedule.nextCheckAt) els.status.textContent += ` · Eligible after ${formatTime(schedule.nextCheckAt)} ET`;
  const cadence = state?.cloudHealth?.cadenceMinutes || 60;
  const gap = `The cloud scheduler runs about every ${cadence} minutes. Searches share a queue, so your watch may wait longer when it is busy.`;
  const backoff = schedule.backoffMinutes ? ` Apple throttled requests; backing off ${schedule.backoffMinutes} minutes.` : '';
  const hits = disconnected ? 0 : filterWatchedRows(state?.hits || [], config()).filter(row => !row.stale).length;
  const coverage = state?.counts ? ` Saved coverage: ${state.counts.stores || 0} stores across checks; ${hits} current watched match${hits === 1 ? '' : 'es'}; ${state.counts.stale || 0} stale observations.` : '';
  els['scope-note'].textContent = `${gap}${backoff}${coverage}`;
  els.runtime.textContent = `Saved watches continue in the cloud until they expire, even with this page closed or your Mac off. ${pushState.subscribed?'Notifications are enabled for this browser.':'Enable notifications above for alerts with this page closed.'} Sound needs this page open.`;
  renderCloudHealth();
}

function renderCloudHealth() {
  const health = state?.cloudHealth;
  const badge = $('cloud-badge');
  const detail = $('cloud-health');
  const lastTick = health?.lastTickAt || health?.lastTick?.at || health?.lastTick?.completedAt;
  const age = lastTick ? Date.now() - new Date(lastTick).getTime() : Infinity;
  const stale = !Number.isFinite(age) || age > Math.max(16, (health?.cadenceMinutes || 60) * 2) * 60 * 1000;
  const issue = health?.error || health?.lastError || health?.lastTick?.error;
  const behind = !!health && (stale || !!issue);
  badge.textContent = disconnected ? 'Cloud status unavailable' : behind ? 'Cloud checks delayed' : lastTick ? 'Cloud checks online' : 'Cloud pickup checks';
  badge.classList.toggle('delayed', disconnected || behind);
  if (disconnected) detail.textContent = 'This page is offline. Reconnect to confirm the scheduler and your latest availability.';
  else if (!health) detail.textContent = 'Cloud scheduler status is loading. Your next check will appear above when queued.';
  else detail.textContent = `${lastTick ? `Scheduler last ran ${formatTime(lastTick, true)} ET.` : 'Waiting for the first cloud scheduler run.'}${issue ? ` ${issue}` : ''}${stale && lastTick ? ' Scheduler activity is older than expected; fresh availability is not confirmed.' : ''}${Number.isFinite(health.queueSize) ? ` ${health.queueSize} check${health.queueSize === 1 ? '' : 's'} in the shared queue.` : ''}`;
}

function render() {
  if (state) syncAlertProfile();
  renderHuntExperience();
  renderIdentity();
  renderFormStatus();
  renderSetupGuide();
  renderPushSettings();
  renderStoreChoices();
  renderStatus();
  const key = JSON.stringify([config(), state?.observations, state?.hits, els.filter.value, disconnected]);
  if (key !== rowsKey) { rowsKey = key; renderRows(); renderHits(); }
  els.history.innerHTML = (state?.history || []).slice(-8).reverse().map(item => `<li class="${['error','throttled'].includes(item.outcome) ? 'error' : ''}"><time>${esc(formatTime(item.completedAt || item.createdAt || item.startedAt, true))}</time> ${esc(item.anchor?.city || item.anchor?.zip || item.anchor || 'Check')} · ${esc(item.error || item.message || item.outcome || 'Checked')}</li>`).join('') || '<li>No monitoring activity yet.</li>';
  if (state && !disconnected) {
    const alert = selectCurrentAlert(state.notifications || [], filterWatchedRows(currentRows(), config()), knownAlerts);
    for (const id of alert.newIds) knownAlerts.add(id);
    if (sound && alert.shouldChime) chime();
    knownAlerts = new Set([...knownAlerts].slice(-500));
    try { localStorage.setItem(alertStorageKey, JSON.stringify([...knownAlerts])); } catch {}
  }
}

function chime() {
  if (!audio) return;
  for (let n=0; n<3; n++) {
    const oscillator=audio.createOscillator(), gain=audio.createGain();
    oscillator.connect(gain); gain.connect(audio.destination); oscillator.frequency.value=n===1?880:659;
    gain.gain.setValueAtTime(0,audio.currentTime+n*.3); gain.gain.linearRampToValueAtTime(.14,audio.currentTime+n*.3+.02); gain.gain.exponentialRampToValueAtTime(.001,audio.currentTime+n*.3+.24);
    oscillator.start(audio.currentTime+n*.3); oscillator.stop(audio.currentTime+n*.3+.25);
  }
}

async function requestJSON(path, body) {
  const response = await fetch(path, body === undefined ? {cache:'no-store'} : {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
  return data;
}

function adoptStatus(next, {hydrate = false} = {}) {
  state = next; disconnected = false;
  if (commandNotice === 'Availability check queued for the saved target.' && state.lastCheck?.completedAt && !state.scheduler?.inFlight && !state.scheduler?.queuedScope) commandNotice = '';
  if (!draft || hydrate) { draft = reconcileDraft(draft, config(), catalog, {force:hydrate}); renderFields(); }
  receiveHuntInvite();
  applySharedStores();
  render();
}

async function loadStatus(options = {}) {
  try { adoptStatus(await requestJSON('/api/status'), options); return true; }
  catch { disconnected = true; render(); return false; }
}

async function loadCatalog(refresh = false) {
  catalogBusy = true; catalogError = ''; render();
  try {
    const data = await requestJSON(refresh ? '/api/catalog/refresh' : '/api/catalog', refresh ? {} : undefined);
    const next = data.catalog || data;
    if (!next.models?.some(model => model.variants?.length)) throw new Error(next.error || 'No usable configurations in the catalog.');
    catalog = next;
    if (draft) { draft = updateDraft(draft, {}, catalog); renderFields(); }
  } catch (error) { catalogError = `Catalog unavailable · ${error.message}${catalog ? ' Using the previously loaded catalog.' : ''}`; }
  finally { catalogBusy = false; receiveHuntInvite(); render(); }
}

function changeDraft(changes, {fields = false} = {}) {
  if (!draft || busy) return;
  if(changes.selection||Object.hasOwn(changes,'zip')){
    if(pendingInviteStores)inviteMessage='Your picks are now your own. Choose any nearby stores after your next check.';
    pendingInviteStores=null;sharedSelection=null;
  }
  draft = updateDraft(draft, changes, catalog);
  formError = ''; commandError = ''; commandNotice = '';
  if($('share-link')){$('share-link').hidden=true;$('share-notice').textContent='';}
  if (fields) renderFields();
  render();
}

async function applyChoices(action) {
  if (busy) return;
  if(action==='start'&&pendingInviteStores){formError='Check availability once to load the shared stores, then save or start your watch.';render();return;}
  let payload;
  try { payload = settingsPayload(draft, catalog); }
  catch (error) { formError = error.message; render(); return; }
  busy = true; formError = ''; commandError = ''; commandNotice = ''; render();
  let settingsSaved = false;
  try {
    const saved = await requestJSON(action === 'save' ? '/api/settings' : '/api/search', payload);
    settingsSaved = true;
    adoptStatus(saved.status || await requestJSON('/api/status'), {hydrate:true});
    if (action === 'start') {
      const started = await requestJSON('/api/monitor', {enabled:true, scope:'nearby', durationHours:payload.watchHours, restart:true});
      adoptStatus(started.status || await requestJSON('/api/status'), {hydrate:true});
    }
    commandNotice = action === 'save' ? 'Settings saved. No availability check requested.' : action === 'start' ? 'Watch started for the saved target.' : 'Availability check queued for the saved target.';
    await loadStatus({hydrate:true});
  } catch (error) {
    commandError = `${settingsSaved ? 'Settings saved, but the action could not finish' : 'Could not apply settings'} · ${error.message}`;
    const refreshed = await loadStatus({hydrate:true});
    if (!refreshed && state) { draft = draftFromConfig(config(), catalog); renderFields(); }
  } finally { busy = false; applySharedStores(); render(); if(settingsSaved)void push.refresh(); }
}

async function stopWatch() {
  if (busy) return;
  busy = true; commandError = ''; commandNotice = ''; render();
  try {
    const data = await requestJSON('/api/monitor', {enabled:false, scope:'nearby', durationHours:Number(config().watchHours || 24)});
    adoptStatus(data.status || await requestJSON('/api/status'));
    commandNotice = 'Watch paused. Your pending choices are unchanged.';
  } catch (error) { commandError = `Could not stop the watch · ${error.message}`; await loadStatus(); }
  finally { busy = false; render(); void push.refresh(); }
}

function receiveHuntInvite() {
  if(inviteProcessed||!state||!catalog)return;
  inviteProcessed=true;
  const hash=typeof location==='object'?location.hash:'';
  try {
    const incoming=readHuntInvite(hash,catalog);if(!incoming)return;
    // A shared link changes the local preview only, never another saved watch.
    draft={...incoming,watchHours:[1,4,12,24,72].includes(incoming.watchHours)?incoming.watchHours:24};
    sharedSelection={...incoming.selection,zip:incoming.zip};
    if(!incoming.watchAllNearby){
      pendingInviteStores=[...incoming.storeNumbers];
      draft={...draft,watchAllNearby:true,storeNumbers:[]};
      inviteMessage='Shared phone loaded. Check availability once to find its stores; your saved watch is unchanged.';
    }else inviteMessage='A friend’s picks are ready to try. This is a preview; your saved watch is unchanged.';
    renderFields();applySharedStores();
  }catch(error){inviteMessage=`This hunt link couldn’t load. ${error.message}`;}
  if(hash.startsWith('#hunt=')&&typeof history==='object'&&typeof location==='object')history.replaceState(null,'',location.pathname+location.search);
}
function applySharedStores() {
  if(busy||!pendingInviteStores||!sharedSelection||!state?.stores?.length)return;
  if(state.config.zip!==sharedSelection.zip||['modelId','color','storage'].some(key=>state.config.selection?.[key]!==sharedSelection[key]))return;
  const known=new Set(state.stores.map(store=>store.storeNumber));
  const matches=pendingInviteStores.filter(id=>known.has(id));
  draft={...draft,watchAllNearby:matches.length===0,storeNumbers:matches};
  inviteMessage=matches.length?'The shared stores are selected in your preview. Save them or start your own watch.':'Those shared stores weren’t in Apple’s results. Choose from the nearby stores returned for this ZIP.';
  pendingInviteStores=null;renderFields();
}
function renderHuntExperience() {
  const target=$('hunt-card');if(!target)return;
  const dirty=draftIsDirty(draft,config());
  const variant=selectionOptions(catalog,draft?.selection).variant;
  const stage=huntStage(state,{dirty,disconnected});
  const key=JSON.stringify([stage,state?.completion,variant,draft,config(),state?.lastCheck?.completedAt]);
  if(key!==huntCardKey){huntCardKey=key;target.innerHTML=huntCardMarkup({state,draft,variant,dirty,disconnected});}
  for(const key of ['complete','checking','found','preview'])target.classList.toggle(`is-${key}`,stage.key===key);
  const configured=!!state?.config?.zip;
  $('share-hunt').disabled=busy||!variant||!/^\d{5}$/.test(String(draft?.zip||''));
  $('got-it').disabled=busy||disconnected||!configured||dirty;
  $('got-it').title=dirty?'Save your choices before marking this hunt complete.':'';
  $('got-it').hidden=!!state?.completion;
  $('new-hunt').hidden=!state?.completion;
  $('new-hunt').disabled=busy;
  if($('success-store')){
    const prior=$('success-store').value;
    const stores=nearbyStores().filter(store=>isWatchedStore(store.storeNumber,config()));
    const choices='<option value="">Keep the store off my card</option>'+stores.map(store=>`<option value="${esc(store.storeNumber)}">${esc(store.storeName)}</option>`).join('');
    if($('success-store').innerHTML!==choices){$('success-store').innerHTML=choices;$('success-store').value=stores.some(store=>store.storeNumber===prior)?prior:'';}
    $('success-store').disabled=busy||!configured; $('success-store-label').hidden=!!state?.completion||!stores.length;
  }
  $('invite-banner').hidden=!inviteMessage; $('invite-note').textContent=inviteMessage;
  const completion=state?.completion;
  $('victory-panel').hidden=!completion;
  if(completion&&victoryKey!==completion.id){victoryKey=completion.id;$('victory-details').innerHTML=`<p class="eyebrow">Filed under: found</p><h3>A very good find.</h3><p>${esc(completion.variant.name)}${completion.storeName?` · ${esc(completion.storeName)}`:''}</p><p class="victory-caption">Confirmed by you. Your watch has stopped.</p>`;}
  if(!completion)victoryKey='';
}
async function shareHunt() {
  try {
    const payload=settingsPayload(draft,catalog);
    const url=createHuntLink(payload,location.origin);
    $('share-link').value=url;$('share-link').hidden=false;
    try{await navigator.clipboard.writeText(url);$('share-notice').textContent='Hunt link copied. It shares your picks and ZIP, with independent controls for your friend.';}
    catch{$('share-notice').textContent='Your hunt link is ready. Copy it below to share your picks and ZIP.';}
  }catch(error){$('share-notice').textContent=error.message;}
}
function celebrateHunt() {
  if(typeof window==='object'&&window.matchMedia?.('(prefers-reduced-motion: reduce)').matches)return;
  const layer=$('confetti-layer');if(!layer)return;
  layer.innerHTML=Array.from({length:42},(_,i)=>`<i class="confetti-piece" style="--x:${Math.round(Math.random()*100)}%;--delay:${Math.round(Math.random()*240)}ms;--rotation:${180+Math.round(Math.random()*540)}deg;--duration:2s;--drift:${Math.round(Math.random()*220)-110}px;--confetti-color:${['#b65d39','#77906d','#e1bc6b','#8397a5'][i%4]}"></i>`).join('');
  setTimeout(()=>{layer.innerHTML='';},2200);
}
async function completeHunt() {
  if(busy||!state?.config?.zip||draftIsDirty(draft,config()))return;
  busy=true;commandError='';commandNotice='';render();
  try{
    const oldId=state.completion?.id,store=$('success-store')?.value;
    const result=await requestJSON('/api/complete',store?{storeNumber:store}:{});
    adoptStatus(result.status,{hydrate:true});commandNotice='Mission complete. Your watch is off.';
    if(result.status.completion?.id!==oldId)celebrateHunt();
    $('victory-panel').scrollIntoView?.({behavior:typeof window==='object'&&window.matchMedia?.('(prefers-reduced-motion: reduce)').matches?'auto':'smooth',block:'center'});
  }catch(error){commandError=`Could not finish the hunt · ${error.message}`;}
  finally{busy=false;render();void push.refresh();}
}
async function newHunt() {
  if(busy)return;busy=true;render();
  try{const result=await requestJSON('/api/complete/reset',{});adoptStatus(result.status,{hydrate:true});commandNotice='A fresh page in the field notes. Choose your next phone when you’re ready.';}
  catch(error){commandError=`Could not reset the hunt · ${error.message}`;}
  finally{busy=false;render();void push.refresh();}
}
async function copyVictory() {
  const done=state?.completion;if(!done)return;
  const text=`Mission complete. ${done.variant.name}${done.storeName?` · ${done.storeName}`:''}. Confirmed by the hunter. Made with Pickup Hunt · ${location.origin}`;
  try{await navigator.clipboard.writeText(text);$('share-notice').textContent='Your victory caption is copied.';}
  catch{$('share-link').hidden=false;$('share-link').value=text;$('share-notice').textContent='Your victory caption is ready to copy below.';}
}
function downloadVictory() {
  if(!state?.completion)return;
  const url=URL.createObjectURL(new Blob([buildVictorySVG(state.completion)],{type:'image/svg+xml;charset=utf-8'}));
  const link=document.createElement('a');link.href=url;link.download='pickup-hunt-mission-complete.svg';link.click();
  setTimeout(()=>URL.revokeObjectURL(url),1000);
}
$('share-hunt')?.addEventListener('click',shareHunt);
$('got-it')?.addEventListener('click',completeHunt);
$('new-hunt')?.addEventListener('click',newHunt);
$('copy-victory')?.addEventListener('click',copyVictory);
$('download-victory')?.addEventListener('click',downloadVictory);
$('dismiss-invite')?.addEventListener('click',()=>{inviteMessage='';pendingInviteStores=null;render();});
$('enable-notifications')?.addEventListener('click',()=>push.enable());
$('test-notifications')?.addEventListener('click',()=>push.test());
$('disable-notifications')?.addEventListener('click',()=>push.disable());

els['watch-form'].addEventListener('submit', event => { event.preventDefault(); return applyChoices('check'); });
for (const id of ['model','color','storage']) els[id].addEventListener('change', () => changeDraft({selection:{[id === 'model' ? 'modelId' : id]:els[id].value}}, {fields:true}));
els.zip.addEventListener('input', () => changeDraft({zip:els.zip.value}));
els['watch-hours'].addEventListener('change', () => changeDraft({watchHours:Number(els['watch-hours'].value)}));
els['all-nearby'].addEventListener('change', () => { if (els['all-nearby'].checked) changeDraft({watchAllNearby:true, storeNumbers:[]}); });
els['selected-stores'].addEventListener('change', () => { if (els['selected-stores'].checked) changeDraft({watchAllNearby:false, storeNumbers:draft.watchAllNearby ? nearbyStores().map(store => store.storeNumber) : draft.storeNumbers}); });
els['select-all-stores'].addEventListener('click', () => changeDraft({watchAllNearby:true, storeNumbers:[]}));
els['clear-stores'].addEventListener('click', () => changeDraft({watchAllNearby:false, storeNumbers:[]}));
els['store-choices'].addEventListener('change', event => {
  if (!event.target.matches('input[data-store-number]')) return;
  const storeNumbers = [...els['store-choices'].querySelectorAll('input[data-store-number]:checked')].map(input => input.dataset.storeNumber);
  changeDraft({watchAllNearby:false, storeNumbers});
});
els['start-watch'].addEventListener('click', () => applyChoices('start'));
els['stop-watch'].addEventListener('click', stopWatch);
els['save-settings'].addEventListener('click', () => applyChoices('save'));
els['refresh-catalog'].addEventListener('click', () => loadCatalog(true));
els.filter.addEventListener('change', render);
els.sound.addEventListener('change', async () => {
  sound = els.sound.value === 'on';
  if (sound) try { audio ||= new (window.AudioContext || window.webkitAudioContext)(); await audio.resume(); chime(); }
  catch { sound = false; els.sound.value = 'off'; commandError = 'Sound is unavailable in this browser. Visual alerts still work.'; render(); }
});
await Promise.allSettled([loadCatalog(), loadStatus()]);
void push.init();
setInterval(() => loadStatus(), 15000);
