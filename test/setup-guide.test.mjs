import test from 'node:test';
import assert from 'node:assert/strict';
import {setupGuide} from '../public/setup-guide.js';

const variant={partNumber:'PHONE512',name:'A phone 512GB'};
const draft={zip:'10001',watchHours:24,watchAllNearby:true,storeNumbers:[]};
const state={config:{zip:'10001',models:[variant]},stores:[{storeNumber:'R001'},{storeNumber:'R002'}],monitor:{enabled:false},scheduler:{}};

test('new visitors get a phone and ZIP prompt before any stock claim',()=>{
  const guide=setupGuide({draft:{...draft,zip:''},variant});
  assert.match(guide.heading,/phone and ZIP/);
  assert.equal(guide.step,0);
  assert.equal(guide.active,false);
  assert.equal(guide.hasStores,false);
});

test('a valid first hunt explains one-time check versus cloud watch',()=>{
  const guide=setupGuide({draft,variant});
  assert.match(guide.checkLabel,/Find stores/);
  assert.match(guide.description,/one-time check/);
  assert.match(guide.description,/automatic cloud checks/);
});

test('a queued first check allows an all-nearby watch without promising returned stores',()=>{
  const guide=setupGuide({state:{...state,stores:[],scheduler:{queuedScope:'nearby'}},draft,variant});
  assert.equal(guide.step,1);
  assert.equal(guide.hasStores,false);
  assert.match(guide.description,/after Apple responds/);
  assert.match(guide.description,/start a watch for all nearby/);
});

test('the guide reports chosen stores and prompts an explicit start',()=>{
  const guide=setupGuide({state,draft:{...draft,watchAllNearby:false,storeNumbers:['R002']},variant,dirty:true});
  assert.equal(guide.step,2);
  assert.match(guide.description,/1 selected/);
  assert.equal(guide.storeSummary,'1 selected store');
  assert.equal(guide.active,false);
});

test('changing phone or ZIP cannot borrow saved stores or active-watch status',()=>{
  for(const changes of [{draft:{...draft,zip:'10002'},variant},{draft,variant:{...variant,partNumber:'OTHER'}}]){
    const guide=setupGuide({state:{...state,monitor:{enabled:true}},dirty:true,...changes});
    assert.equal(guide.hasStores,false);
    assert.equal(guide.active,false);
    assert.match(guide.checkLabel,/Find stores/);
    assert.match(guide.startLabel,/Update & restart/);
  }
});

test('active and completed watches have distinct next steps',()=>{
  const active=setupGuide({state:{...state,monitor:{enabled:true}},draft,variant});
  assert.equal(active.active,true);
  assert.equal(active.step,3);
  assert.match(active.description,/Enable notifications/);
  const complete=setupGuide({state:{...state,completion:{id:'done'}},draft,variant});
  assert.match(complete.description,/watch has stopped/);
  assert.equal(complete.active,false);
});

test('offline setup copy preserves uncertainty about the saved cloud watch',()=>{
  const guide=setupGuide({state:{...state,monitor:{enabled:true}},draft,variant,disconnected:true});
  assert.match(guide.heading,/Reconnect/);
  assert.match(guide.description,/may keep running/);
});
