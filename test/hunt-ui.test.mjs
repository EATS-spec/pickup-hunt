import test from 'node:test';
import assert from 'node:assert/strict';
import {huntStage,huntCardMarkup} from '../public/hunt-ui.js';
const variant={partNumber:'TESTLL/A',modelId:'iphone18promax',modelName:'iPhone 18 Pro Max',name:'iPhone 18 Pro Max 512GB Burgundy',color:'Burgundy',storage:'512GB',checkoutUrl:'https://www.apple.com/shop/buy-iphone/iphone-18-pro'};
const config={selection:{modelId:variant.modelId,color:variant.color,storage:variant.storage},models:[variant],zip:'10001',watchAllNearby:false,storeNumbers:['R068']};
const row={partNumber:variant.partNumber,storeNumber:'R068',storeName:'Walt Whitman',availability:'available',stale:false};
test('hunt stages distinguish preview, actual checking, stale results, and confirmed finishes',()=>{
 const base={config,monitor:{enabled:false},scheduler:{},hits:[]};
 assert.equal(huntStage(base).key,'paused');
 assert.equal(huntStage({...base,monitor:{enabled:true}}).key,'watching');
 assert.equal(huntStage({...base,scheduler:{inFlight:true}}).key,'checking');
 assert.equal(huntStage({...base,hits:[row]}).key,'found');
 assert.equal(huntStage({...base,hits:[{...row,stale:true}]}).key,'paused');
 assert.equal(huntStage({...base,hits:[{...row,storeNumber:'R999'}]}).key,'paused');
 assert.equal(huntStage({...base,hits:[row]},{dirty:true}).key,'preview');
 assert.equal(huntStage({...base,hits:[row]},{disconnected:true}).key,'offline');
 assert.equal(huntStage({...base,completion:{id:'done'}}).key,'complete');
 assert.equal(huntStage({...base,scheduler:{backoffMinutes:10},monitor:{enabled:true}}).key,'cooldown');
});
test('hunt card retains exact phone, safe Apple link, and clearly labels drafts and visitor confirmation',()=>{
 const state={config,monitor:{enabled:false},hits:[row],lastCheck:{completedAt:'2026-10-26T13:00:00Z'}};
 const found=huntCardMarkup({state,draft:config,variant});
 assert.match(found,/See pickup at Apple/);assert.match(found,/Burgundy/);assert.match(found,/512GB/);
 const preview=huntCardMarkup({state,draft:config,variant:{...variant,color:'<script>'},dirty:true});
 assert.match(preview,/Preview only/);assert.doesNotMatch(preview,/See pickup at Apple|<script>/);
 const done=huntCardMarkup({state:{...state,completion:{variant,storeName:'My Store',zip:'10001'}},draft:config,variant});
 assert.match(done,/Mission complete/);assert.match(done,/Confirmed by you/);assert.match(done,/orders aren’t verified/);assert.doesNotMatch(done,/See pickup at Apple/);
});
