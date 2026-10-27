import test from 'node:test';
import assert from 'node:assert/strict';
import {createHuntLink} from '../public/hunt-tools.js';
import { configuredCheckoutURL, selectCurrentAlert } from '../public/checkout.js';
import { selectionOptions, draftFromConfig, reconcileDraft, updateDraft, draftIsDirty, settingsPayload, filterWatchedRows } from '../public/settings.js';

const base = 'https://www.apple.com/shop/buy-iphone';
const exactURL = 'https://www.apple.com/shop/buy-iphone/iphone-18-pro/6.9-inch-display-512gb-burgundy-unlocked';
const models = Object.freeze([Object.freeze({
  partNumber: 'MJWA4LL/A', name: 'iPhone 18 Pro Max 512GB Burgundy', preferred: true, checkoutUrl: exactURL,
})]);

test('checkout uses the exact configured Pro Max, Burgundy, 512GB URL', () => {
  assert.equal(configuredCheckoutURL('MJWA4LL/A', models), exactURL);
});

test('checkout metadata is preserved without adding a carrier or payment route', () => {
  const url = 'https://www.apple.com/shop/buy-iphone/another-config?option=saved';
  assert.equal(configuredCheckoutURL('another-part', [{ partNumber: 'another-part', checkoutUrl: url }]), url);
});

test('unknown parts fall back without guessing a configuration', () => {
  for (const part of ['unknown', 'MJWA4LL', 'mjwa4ll/a', '', null, undefined]) {
    assert.equal(configuredCheckoutURL(part, models), base);
  }
  assert.equal(configuredCheckoutURL('MJWA4LL/A'), base);
});

test('unsafe checkout metadata cannot direct the user off Apple HTTPS', () => {
  for (const checkoutUrl of ['https://apple.com.example.org/shop', 'https://example.org/apple.com',
    'http://www.apple.com/shop', 'javascript:alert(1)', 'https://user:password@www.apple.com/shop',
    'https://www.apple.com:8443/shop', '/shop/buy-iphone', undefined]) {
    assert.equal(configuredCheckoutURL('part', [{ partNumber: 'part', checkoutUrl }]), base);
  }
});

const observation = (changes = {}) => ({
  storeNumber: 'R001', partNumber: 'MJWA4LL/A', availability: 'available', stale: false, ...changes,
});
const notification = (id, changes = {}) => ({
  id, storeNumber: 'R001', partNumber: 'MJWA4LL/A', ...changes,
});

test('obsolete and stale alerts are marked known without chiming', () => {
  const notes = [notification('gone'), notification('stale', { storeNumber: 'R002' }),
    notification('missing', { storeNumber: 'R003' })];
  const rows = [observation({ availability: 'unavailable' }),
    observation({ storeNumber: 'R002', stale: true })];
  assert.deepEqual(selectCurrentAlert(notes, rows, new Set()), {
    newIds: ['gone', 'stale', 'missing'], shouldChime: false,
  });
});

test('multiple current matches return one chime decision and deduplicate new IDs', () => {
  const notes = [notification('first'), notification('first'),
    notification('second', { storeNumber: 'R002' })];
  const rows = [observation(), observation({ storeNumber: 'R002' })];
  assert.deepEqual(selectCurrentAlert(notes, rows, []), {
    newIds: ['first', 'second'], shouldChime: true,
  });
});

test('known alerts do not replay and inputs remain unchanged', () => {
  const notes = Object.freeze([Object.freeze(notification('known')), Object.freeze(notification('new'))]);
  const rows = Object.freeze([Object.freeze(observation())]);
  const knownIds = new Set(['known']);
  const result = selectCurrentAlert(notes, rows, knownIds);
  assert.deepEqual(result, { newIds: ['new'], shouldChime: true });
  assert.deepEqual([...knownIds], ['known']);
  assert.deepEqual(selectCurrentAlert(notes, rows, [...knownIds, ...result.newIds]), {
    newIds: [], shouldChime: false,
  });
});

test('availability must match both store and part', () => {
  const notes = [notification('different-store', { storeNumber: 'R002' }),
    notification('different-part', { partNumber: 'another-part' })];
  assert.deepEqual(selectCurrentAlert(notes, [observation()], []), {
    newIds: ['different-store', 'different-part'], shouldChime: false,
  });
});

const secondURL = 'https://www.apple.com/shop/buy-iphone/iphone-18-pro/6.9-inch-display-256gb-silver-unlocked';
const variants = [
  {...models[0], modelId:'pro-max', modelName:'iPhone 18 Pro Max', color:'Burgundy', storage:'512GB'},
  {...models[0], partNumber:'MAX1TB', name:'iPhone 18 Pro Max 1TB Burgundy', modelId:'pro-max', modelName:'iPhone 18 Pro Max', color:'Burgundy', storage:'1TB'},
  {partNumber:'MAXSILVER', name:'iPhone 18 Pro Max 256GB Silver', modelId:'pro-max', modelName:'iPhone 18 Pro Max', color:'Silver', storage:'256GB', checkoutUrl:secondURL},
  {partNumber:'STANDARD', name:'iPhone 17 256GB Black', modelId:'standard', modelName:'iPhone 17', color:'Black', storage:'256GB', checkoutUrl:'https://www.apple.com/shop/buy-iphone/iphone-17'},
];
const catalog = {
  updatedAt:'2026-10-23T15:00:00Z', stale:true, error:'Some product families are unavailable; using the saved catalog.',
  models:[
    {id:'pro-max', name:'iPhone 18 Pro Max', colors:['Burgundy','Silver','Invented'], storages:['256GB','512GB','1TB','2TB'], variants:variants.slice(0,3)},
    {id:'standard', name:'iPhone 17', variants:variants.slice(3)},
  ],
};
const savedConfig = {
  profileId:'pro-max-burgundy-512-10001', selection:{modelId:'pro-max',color:'Burgundy',storage:'512GB'},
  models:[variants[0]], zip:'10001', watchAllNearby:true, storeNumbers:[], watchHours:24, minimumGapSeconds:240,
};

test('dependent selectors only expose combinations present in actual variants', () => {
  const options = selectionOptions(catalog, savedConfig.selection);
  assert.deepEqual(options.colors, ['Burgundy','Silver']);
  assert.deepEqual(options.storages, ['512GB','1TB']);
  assert.equal(options.variant.partNumber, 'MJWA4LL/A');
  const silver = selectionOptions(catalog, {...savedConfig.selection,color:'Silver'});
  assert.deepEqual(silver.storages, ['256GB']);
  assert.equal(silver.selection.storage, '256GB');
});

test('changing model or color repairs invalid dependent choices and retains stores at the same ZIP', () => {
  const draft = draftFromConfig({...savedConfig,watchAllNearby:false,storeNumbers:['R001']}, catalog);
  const silver = updateDraft(draft, {selection:{color:'Silver'}}, catalog);
  assert.deepEqual(silver.selection, {modelId:'pro-max',color:'Silver',storage:'256GB'});
  assert.deepEqual(silver.storeNumbers, ['R001']);
  const standard = updateDraft(silver, {selection:{modelId:'standard'}}, catalog);
  assert.deepEqual(standard.selection, {modelId:'standard',color:'Black',storage:'256GB'});
  assert.equal(standard.watchAllNearby, false);
  assert.deepEqual(standard.storeNumbers, ['R001']);
});

test('a new public browser has no personal location and cannot submit an empty ZIP', () => {
  const draft = draftFromConfig({},catalog);
  assert.equal(draft.zip,'');
  assert.equal(draft.watchAllNearby,true);
  assert.deepEqual(draft.storeNumbers,[]);
  assert.throws(() => settingsPayload(draft,catalog), /five-digit US ZIP/);
});

test('changing ZIP clears previous stores and requires a new all-nearby search', () => {
  const draft = draftFromConfig({...savedConfig,watchAllNearby:false,storeNumbers:['R001'],watchHours:72}, catalog);
  const next = updateDraft(draft, {zip:'10002'}, catalog);
  assert.equal(next.watchAllNearby, true);
  assert.deepEqual(next.storeNumbers, []);
  assert.equal(next.watchHours, 72);
  assert.deepEqual(draft.storeNumbers, ['R001']);
});

test('status polling preserves dirty form choices; explicit save/error hydration restores saved settings', () => {
  const draft = updateDraft(draftFromConfig(savedConfig,catalog), {selection:{color:'Silver'}}, catalog);
  assert.equal(draftIsDirty(draft,savedConfig), true);
  assert.equal(reconcileDraft(draft,savedConfig,catalog), draft);
  assert.deepEqual(reconcileDraft(draft,savedConfig,catalog,{force:true}), draftFromConfig(savedConfig,catalog));
});

test('dirty comparison ignores irrelevant store order and detects watch duration changes', () => {
  const config = {...savedConfig,watchAllNearby:false,storeNumbers:['R002','R001']};
  const draft = draftFromConfig(config,catalog);
  assert.equal(draftIsDirty({...draft,storeNumbers:['R001','R002','R001']},config), false);
  assert.equal(draftIsDirty({...draft,watchHours:4},config), true);
  assert.equal(draftIsDirty({...draft,watchAllNearby:true,storeNumbers:['R001']},{...config,watchAllNearby:true}), false);
});

test('settings payload validates ZIP, exact variant, duration, and selected stores', () => {
  const draft = draftFromConfig(savedConfig,catalog);
  assert.deepEqual(settingsPayload(draft,catalog), {
    selection:savedConfig.selection,zip:'10001',watchAllNearby:true,storeNumbers:[],watchHours:24,
  });
  assert.throws(() => settingsPayload({...draft,zip:'123'},catalog), /five-digit/);
  assert.throws(() => settingsPayload({...draft,selection:{...draft.selection,storage:'2TB'}},catalog), /valid model/);
  assert.throws(() => settingsPayload({...draft,watchHours:2},catalog), /duration/);
  assert.throws(() => settingsPayload({...draft,watchAllNearby:false,storeNumbers:[]},catalog), /at least one store/);
  assert.deepEqual(settingsPayload({...draft,selection:{storage:'512GB',color:'Burgundy',modelId:'pro-max'}},catalog).selection, savedConfig.selection);
});

test('watched filters require both saved product and selected store before sounding alerts', () => {
  const config = {...savedConfig,watchAllNearby:false,storeNumbers:['R001']};
  const rows = [observation(),observation({storeNumber:'R002'}),observation({partNumber:'OTHER'})];
  assert.equal(filterWatchedRows(rows,config).length,1);
  assert.equal(filterWatchedRows(rows,{...config,watchAllNearby:true}).length,2);
  assert.deepEqual(selectCurrentAlert([notification('unwatched',{storeNumber:'R002'})],filterWatchedRows(rows,config),[]), {
    newIds:['unwatched'],shouldChime:false,
  });
});

test('frontend keeps drafts across polls, applies new target before starting, and restores paused watches', async () => {
  const nodes = new Map();
  const element = id => {
    if (!nodes.has(id)) nodes.set(id, {
      value:id === 'filter' ? 'all' : '',textContent:'',innerHTML:'',hidden:false,disabled:false,checked:false,
      listeners:new Map(),
      addEventListener(name,callback) { this.listeners.set(name,callback); },
      setAttribute() {},querySelectorAll() { return []; },classList:{toggle() {}},
    });
    return nodes.get(id);
  };
  const fire = async (id,event='click',details={}) => element(id).listeners.get(event)?.({preventDefault(){},...details});
  const calls = [], savedKeys = [], clipboard=[];
  let poll, rejectNextSearch=false, queueSearch=false,searchStores=[];
  let status = {
    config:{...savedConfig}, monitor:{enabled:false,scope:'nearby',stopAt:null},scheduler:{},
    lastCheck:{completedAt:'2026-10-23T15:00:00Z',outcome:'success',storeCount:10,availableCount:0},
    cloudHealth:{lastTickAt:new Date().toISOString(),cadenceMinutes:5,queueSize:2},
    counts:{stores:179,stale:80},observations:[],hits:[],notifications:[],history:[],
    stores:[{storeNumber:'R001',storeName:'First Store',city:'First City',state:'NY'}],
  };
  const document = {getElementById:element,title:''};
  const stubs = {
    document,
    location:{origin:'https://pickup.example',hash:'',pathname:'/',search:''},
    history:{replaceState(){}},
    navigator:{clipboard:{async writeText(value){clipboard.push(value);}}},
    window:{matchMedia(){return{matches:true};}},
    localStorage:{getItem(){return null;},setItem(key){savedKeys.push(key);}},
    setInterval(callback){poll=callback;return 1;},
    fetch:async (path,options={}) => {
      const body = options.body ? JSON.parse(options.body) : null;
      calls.push({path,body});
      if (path === '/api/catalog') return {ok:true,json:async()=>catalog};
      if (path === '/api/status') return {ok:true,json:async()=>status};
      if (path === '/api/search' || path === '/api/settings') {
        if (rejectNextSearch) { rejectNextSearch=false;return {ok:false,status:400,json:async()=>({error:'Selection rejected'})}; }
        const variant = variants.find(item => item.modelId===body.selection.modelId && item.color===body.selection.color && item.storage===body.selection.storage);
        status = {...status,config:{...status.config,...body,models:[variant],profileId:`${variant.partNumber}-${body.zip}`},monitor:{enabled:false,scope:'nearby',stopAt:null},observations:[],hits:[],stores:searchStores,scheduler:queueSearch && path==='/api/search'?{queuedScope:'nearby',inFlight:false}:status.scheduler};
      } else if (path === '/api/complete') {
        status={...status,completion:status.completion||{id:'completed-1',confirmedBy:'visitor',completedAt:'2026-10-26T13:00:00Z',profileId:status.config.profileId,variant:status.config.models[0],selection:status.config.selection,zip:status.config.zip,storeName:null},monitor:{enabled:false,scope:'nearby',stopAt:null},hits:[],notifications:[]};
      } else if (path === '/api/complete/reset') {
        status={...status,completion:null,monitor:{enabled:false,scope:'nearby',stopAt:null}};
      } else if (path === '/api/monitor') {
        status = {...status,monitor:{enabled:body.enabled,scope:'nearby',stopAt:body.enabled?'2026-10-24T02:00:00Z':null}};
      } else throw new Error(`Unexpected request ${path}`);
      return {ok:true,json:async()=>({status})};
    },
  };
  const originals = new Map(Object.keys(stubs).map(key => [key,Object.getOwnPropertyDescriptor(globalThis,key)]));
  try {
    for (const [key,value] of Object.entries(stubs)) Object.defineProperty(globalThis,key,{value,writable:true,configurable:true});
    await import(`../public/app.js?reusable-test=${Date.now()}`);
    assert.equal(document.title,'Pickup Hunt');
    assert.equal(element('headline').textContent,'Good phones. Worth the hunt.');
    assert.match(element('watch-state').textContent,/Watch paused/);
    assert.equal(element('stop-watch').disabled,true);
    assert.equal(element('cloud-badge').textContent,'Cloud checks online');
    assert.match(element('cloud-health').textContent,/2 checks in the shared queue/);
    assert.equal(calls.filter(call=>call.body).length,0,'reload does not start a watch or check stock');
    assert.match(element('catalog-note').textContent,/Some product families are unavailable/);
    assert.equal(element('checkout-link').href,exactURL);
    assert.match(element('status').textContent,/10 stores in latest check/);
    assert.doesNotMatch(element('status').textContent,/179/);
    assert.match(element('scope-note').textContent,/179 stores across checks/);
    assert.match(element('scope-note').textContent,/watch may wait longer/);
    assert.match(element('runtime').textContent,/Enable notifications above for alerts with this page closed/);
    assert.match(element('runtime').textContent,/Sound needs this page open/);
    assert.match(element('setup-heading').textContent,/stores are ready/);
    assert.match(element('check').innerHTML,/Check stock again/);
    await fire('clear-stores');
    assert.equal(element('selected-stores').checked,true);
    assert.equal(element('all-nearby').checked,false);
    await fire('start-watch');
    assert.match(element('form-error').textContent,/at least one store/);
    assert.equal(calls.filter(call=>call.body).length,0,'empty store selection fails before any request');
    await fire('select-all-stores');
    assert.equal(element('all-nearby').checked,true);
    assert.equal(element('form-error').hidden,true);

    element('color').value='Silver';await fire('color','change');
    assert.equal(element('storage').value,'256GB');
    assert.equal(element('draft-note').hidden,false);
    assert.match(element('active-target').textContent,/Burgundy/);
    assert.match(element('setup-heading').textContent,/Find your stores/,'a pending target cannot claim the saved hunt is ready');
    await poll();
    assert.equal(element('color').value,'Silver','polling must preserve the dirty color');
    assert.equal(element('checkout-link').href,exactURL,'old results retain the saved checkout target');

    element('zip').value='10002';await fire('zip','input');
    assert.equal(element('selected-stores').disabled,true);
    assert.equal(element('all-nearby').checked,true);
    assert.match(element('store-choices').innerHTML,/new ZIP code/);
    element('watch-hours').value='4';await fire('watch-hours','change');
    await fire('start-watch');
    const mutations = calls.filter(call=>call.body);
    assert.deepEqual(mutations.map(call=>call.path),['/api/search','/api/monitor']);
    assert.deepEqual(mutations[0].body,{selection:{modelId:'pro-max',color:'Silver',storage:'256GB'},zip:'10002',watchAllNearby:true,storeNumbers:[],watchHours:4});
    assert.deepEqual(mutations[1].body,{enabled:true,scope:'nearby',durationHours:4,restart:true});
    assert.equal(element('checkout-link').href,secondURL);
    assert.equal(element('draft-note').hidden,true);
    assert.equal(element('stop-watch').disabled,false);
    assert.ok(savedKeys.includes('pickup-alerts:MAXSILVER-10002'));

    element('watch-hours').value='72';await fire('watch-hours','change');
    await fire('stop-watch');
    assert.equal(element('watch-hours').value,'72','stopping does not discard pending form choices');
    assert.match(element('watch-state').textContent,/Watch paused/);
    assert.equal(calls.filter(call=>call.path==='/api/search').length,1,'Stop never applies a new search');
    await fire('save-settings');
    assert.equal(calls.filter(call=>call.path==='/api/settings').length,1);
    assert.equal(calls.filter(call=>call.path==='/api/search').length,1,'Save settings never queues a check');

    rejectNextSearch=true;element('color').value='Burgundy';await fire('color','change');
    const monitorCalls = calls.filter(call=>call.path==='/api/monitor').length;
    await fire('start-watch');
    assert.equal(calls.filter(call=>call.path==='/api/monitor').length,monitorCalls,'failed apply cannot start the previous target');
    assert.match(element('status').textContent,/Could not apply settings/);
    assert.equal(element('color').value,'Silver','server error restores the saved form');
    queueSearch=true;
    await fire('watch-form','submit');
    assert.match(element('status').textContent,/Availability check queued/);
    status={...status,scheduler:{},lastCheck:{...status.lastCheck,completedAt:'2026-10-23T16:00:00Z',storeCount:12,availableCount:1}};
    await poll();
    assert.doesNotMatch(element('status').textContent,/queued/);
    assert.match(element('status').textContent,/12 stores in latest check/);
    status={...status,config:{...status.config,watchAllNearby:false,storeNumbers:['R001']}};
    await poll();
    assert.match(element('facts').innerHTML,/<strong>1<\/strong> selected store</);
    assert.match(element('watch-state').textContent,/1 selected store ·/);
    assert.doesNotMatch(element('watch-state').textContent,/1 selected stores/);
    status={...status,cloudHealth:{lastTickAt:'2020-01-01T00:00:00Z',cadenceMinutes:5}};
    await poll();
    assert.equal(element('cloud-badge').textContent,'Cloud checks delayed');
    assert.match(element('cloud-health').textContent,/older than expected/);
    await fire('share-hunt');
    assert.match(clipboard.at(-1),/^https:\/\/pickup\.example\/#hunt=/);
    assert.match(element('share-notice').textContent,/independent controls/);
    await fire('save-settings');
    await fire('got-it');
    assert.equal(calls.filter(call=>call.path==='/api/complete').length,1);
    assert.match(element('hunt-card').innerHTML,/Mission complete/);
    assert.equal(element('got-it').hidden,true);
    assert.equal(element('new-hunt').hidden,false);
    assert.equal(element('victory-panel').hidden,false);
    await poll();
    assert.equal(calls.filter(call=>call.path==='/api/complete').length,1,'polling never completes again');
    await fire('copy-victory');
    assert.match(clipboard.at(-1),/Confirmed by the hunter/);
    const searchCount=calls.filter(call=>call.path==='/api/search').length;
    await fire('new-hunt');
    assert.equal(element('victory-panel').hidden,true);
    assert.equal(calls.filter(call=>call.path==='/api/search').length,searchCount,'planning another hunt never checks stock');
    // A selected-store invitation must discover returned IDs before saving them.
    stubs.location.hash=new URL(createHuntLink({selection:savedConfig.selection,zip:'10001',watchAllNearby:false,storeNumbers:['R001'],watchHours:24},stubs.location.origin)).hash;
    await import(`../public/app.js?selected-invite-test=${Date.now()}`);
    assert.match(element('invite-note').textContent,/Check availability once/);
    assert.equal(element('all-nearby').checked,true);
    const beforeInviteStart=calls.filter(call=>call.body).length;
    await fire('start-watch');
    assert.equal(calls.filter(call=>call.body).length,beforeInviteStart);
    assert.match(element('form-error').textContent,/load the shared stores/);
    searchStores=[{storeNumber:'R001',storeName:'First Store',city:'First City',state:'NY'}];
    await fire('watch-form','submit');
    assert.equal(element('selected-stores').checked,true);
    assert.match(element('invite-note').textContent,/shared stores are selected/);
    await fire('save-settings');
    assert.deepEqual(status.config.storeNumbers,['R001']);
    assert.equal(status.config.watchAllNearby,false);


  } finally {
    for (const [key,descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis,key,descriptor);
      else delete globalThis[key];
    }
  }
});
