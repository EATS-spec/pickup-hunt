import test from 'node:test';
import assert from 'node:assert/strict';
import {createHuntLink,readHuntInvite,getPhonePalette,buildPhoneSVG,buildVictorySVG} from '../public/hunt-tools.js';
const selection={modelId:'iphone18promax',color:'Burgundy',storage:'512GB'};
const draft={selection,zip:'10001',watchAllNearby:false,storeNumbers:['R068','R060','R068'],watchHours:24};
const catalog={models:[{id:selection.modelId,variants:[{...selection,partNumber:'MJWA4LL/A'}]}]};
const hashFor=value=>'#hunt='+Buffer.from(JSON.stringify(value)).toString('base64url');

test('share links round-trip only allowlisted preferences and normalize store IDs',()=>{
 const source={...draft,sessionId:'secret-session',email:'private@example.test',notifications:[{id:'private'}],checkoutUrl:'https://evil.test',completion:{confirmedBy:'visitor'}};
 const link=new URL(createHuntLink(source,'https://pickup.example/private/path?credential=secret#old'));
 assert.equal(link.origin,'https://pickup.example');assert.equal(link.pathname,'/');assert.equal(link.search,'');
 assert.deepEqual(readHuntInvite(link.hash,catalog),{...draft,storeNumbers:['R060','R068']});
 const payload=Buffer.from(link.hash.slice(6),'base64url').toString();
 for(const privateWord of ['secret','email','notifications','checkoutUrl','completion','private@example'])assert.ok(!payload.includes(privateWord));
 assert.equal(source.storeNumbers.length,3);
});
test('all-nearby links omit explicit stores and loopback HTTP works for preview',()=>{
 const shared={...draft,watchAllNearby:true};
 assert.deepEqual(readHuntInvite(new URL(createHuntLink(shared,'http://127.0.0.1:4318/foo')).hash,catalog).storeNumbers,[]);
 assert.equal(new URL(createHuntLink(shared,'http://[::1]:4318')).host,'[::1]:4318');
 for(const origin of ['javascript:alert(1)','http://pickup.example','https://user:pass@pickup.example','file:///tmp/test'])assert.throws(()=>createHuntLink(shared,origin),/secure|valid/);
});
test('unrelated hashes are ignored; malformed, oversized, and unsupported invitations fail closed',()=>{
 for(const hash of ['',null,'#about','#other=abc'])assert.equal(readHuntInvite(hash,catalog),null);
 for(const hash of ['#hunt=','#hunt=%%%%','#hunt=a','#hunt='+ 'A'.repeat(4100),hashFor({v:2,...draft}),'#hunt='+Buffer.from([0xff,0xfe]).toString('base64url')])assert.throws(()=>readHuntInvite(hash,catalog),/valid|large|version/);
});
test('decoding requires the exact offered model, color and storage rather than repairing a selection',()=>{
 for(const changes of [{modelId:'iphone18pro'},{color:'Silver'},{storage:'2TB'},{modelId:'<script>alert(1)</script>'}])assert.throws(()=>readHuntInvite(hashFor({v:1,...draft,selection:{...selection,...changes}}),catalog),/catalog|invalid/);
 assert.throws(()=>readHuntInvite(hashFor({v:1,...draft}),{models:[]}),/catalog/);
});
test('store selection, ZIP, capacity and duration validation is bounded',()=>{
 for(const changes of [{zip:'1172'},{zip:10001},{watchHours:0},{watchHours:73},{watchHours:'24'},{storeNumbers:[]},{storeNumbers:['R068<script>']},{storeNumbers:Array.from({length:51},(_,n)=>`R${n}`)},{selection:{...selection,storage:'512GB<script>'}}])assert.throws(()=>createHuntLink({...draft,...changes},'https://pickup.example'),/ZIP|duration|store|storage/);
});
test('phone palette supports current colors and a safe deterministic neutral fallback',()=>{
 assert.equal(getPhonePalette(' Burgundy ').body,'#804a57');
 assert.equal(getPhonePalette('Star White').body,'#ece9df');
 assert.deepEqual(getPhonePalette('<script>'),getPhonePalette('Unlisted'));
 const changed=getPhonePalette('Burgundy');changed.body='unsafe';assert.equal(getPhonePalette('Burgundy').body,'#804a57');
});
test('phone art is standalone and escaped, with no external image or executable resource',()=>{
 const svg=buildPhoneSVG({color:'<img onerror="evil()">',modelId:'iphone18promax',complete:true});
 assert.ok(svg.includes('&lt;img onerror=&quot;evil()&quot;&gt;'));
 assert.ok(!/<(?:script|image|foreignObject)\b|\bonload=/i.test(svg));
 assert.ok(svg.includes('viewBox="0 0 260 320"'));assert.ok(svg.includes('translate(201 239)'));
});
test('victory card is clearly visitor-confirmed and escapes all user-controlled text',()=>{
 const completion={completedAt:'2026-10-26T13:00:00Z',confirmedBy:'visitor',selection,variant:{...selection,modelName:'iPhone 18 Pro Max'},storeName:'Walt <script>alert("x")</script> & Whitman'};
 const svg=buildVictorySVG(completion);
 assert.ok(svg.includes('width="1200" height="700"'));assert.ok(svg.includes('Mission'));assert.ok(svg.includes('complete.'));
 assert.ok(svg.includes('Confirmed by the hunter'));assert.ok(svg.includes('not an Apple order confirmation'));
 assert.ok(svg.includes('Burgundy · 512GB'));assert.ok(svg.includes('Oct 26, 2026'));
 assert.ok(!/<script\b|<foreignObject\b|\bhref=|\bonload=/i.test(svg));assert.ok(svg.includes('&lt;script&gt;'));
 assert.ok(buildVictorySVG({}).includes('Pickup complete'));
});
