import test from 'node:test';import assert from 'node:assert/strict';
import {checkKey} from './key_check.mjs';
import {hash} from '../p08-native-entry-local-20261101/source/authority_bridge.mjs';
import {EVENTS,stripeSecretName} from '../p08-native-entry-local-20261101/source/connected_payment.mjs';
import {readFileSync} from 'node:fs';
const origin=JSON.parse(readFileSync(new URL('../p08-local-preparation-20261022/plan.json',import.meta.url))).origin;
const pins={account:hash('acct_owned'),endpoint:hash('we_owned')};
function fixture(change=()=>{}){
 const input={key:'sk_test_'+'a'.repeat(24),endpointId:'we_owned',deadline:Date.now()+50000};const calls=[];
 const rows=[{object:'list',has_more:false,data:[{id:'acct_owned',object:'account',charges_enabled:true}]},
  {object:'balance',livemode:false},{id:'we_owned',object:'webhook_endpoint',livemode:false,url:origin+'/webhooks/stripe',api_version:'2026-03-25.dahlia',enabled_events:EVENTS,status:'disabled'}];
 change(rows,input);
 return {input,calls,send:async(url,opts)=>{calls.push({url,opts});return new Response(JSON.stringify(rows[calls.length-1]));}};
}
test('actual shared decoder/response/endpoint boundary; platform key binds connected account',async()=>{
 const f=fixture();assert.equal((await checkKey(f.input,f.send,pins)).requests,3);
 assert.match(f.calls[0].url,/accounts\?limit=100$/);assert.equal(f.calls.every(x=>x.opts.method==='GET'),true);
 assert.equal(f.input.key,'');assert.equal(f.input.endpointId,'');
});
for(const [name,change] of Object.entries({liveKey:(r,i)=>i.key='sk_live_'+'b'.repeat(24),newline:(r,i)=>i.key+='\n',wrongEndpoint:(r,i)=>i.endpointId='we_foreign',
 foreignAccount:r=>r[0].data[0].id='acct_foreign',platformAccountIsNotConnectedAccount:r=>r[0]={object:'account',id:'acct_owned'},
 moreAccounts:r=>r[0].has_more=true,missingCharges:r=>delete r[0].data[0].charges_enabled,nullAccounts:r=>r[0].data=null,
 liveMode:r=>r[1].livemode=true,missingMode:r=>delete r[1].livemode,enabledEndpoint:r=>r[2].status='enabled',foreignURL:r=>r[2].url='https://wrong.invalid',expired:(r,i)=>i.deadline=Date.now()-1
}))test('key qualification rejects '+name+' without mutation',async()=>{
 const f=fixture(change);await assert.rejects(()=>checkKey(f.input,f.send,pins));assert.ok(f.calls.length<=3);assert.equal(f.input.key,'');assert.equal(f.input.endpointId,'');
});
test('provider failure does not retry',async()=>{let calls=0;const f=fixture();await assert.rejects(()=>checkKey(f.input,async()=>{calls++;return new Response('private',{status:403});},pins));assert.equal(calls,1);});

test('actual payment secret resource follows corrected numeric pin and rejects omission',()=>{
 const e={plan:{projectNumber:'123456'},resources:{candidate:'signmons-calldesk-staging-p07key0123456789ab',secretVersions:{'signmons-staging-stripe-secret-key':'7'}}};
 assert.equal(stripeSecretName(e),'projects/123456/secrets/signmons-staging-stripe-secret-key/versions/7');
 delete e.resources.secretVersions['signmons-staging-stripe-secret-key'];assert.throws(()=>stripeSecretName(e));
 e.resources.candidate='signmons-calldesk-staging-app013p07atomic1';assert.match(stripeSecretName(e),/versions\/1$/);
});
