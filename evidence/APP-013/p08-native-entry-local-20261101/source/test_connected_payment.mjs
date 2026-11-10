import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {hash,authorizeChild} from './authority_bridge.mjs';
import {runChild} from './native_child.mjs';
import {EVENTS,paymentContext,endpoint} from './connected_payment.mjs';
import {fixture,portsFor,runConnected} from './fixture_connected.mjs';
for(const scenario of ['normal','unpaid','lost_create','lost_enable','foreign_endpoint','disable_failed'])test('actual native child payment and cleanup: '+scenario,async t=>{
 const f=fixture(t),ports=portsFor(f,scenario);
 if(scenario==='foreign_endpoint'){await assert.rejects(()=>runConnected(f.r,ports));assert.equal(ports.inspect().creates,0);return;}
 const r=await runConnected(f.r,ports);
 const j=JSON.parse(readFileSync(f.r.envelopePath.replace('envelope.json','journal.json')));
 assert.equal(r.sessionClosed,true);assert.equal(j.authClient.phase,'CLOSEOUT_FINISHED');
 if(scenario==='disable_failed'){assert.equal(j.payment.endpointDisabled,false);assert.ok(j.payment.residuals.includes('PAYMENT_ENDPOINT_UNCONFIRMED'));}
 else {assert.equal(ports.inspect().status,'disabled');assert.equal(j.payment.bridgeClosed,true);}
 if(['normal','lost_create','disable_failed'].includes(scenario)){assert.equal(j.payment.outcome,'APPLICATION_SETTLED');assert.equal(ports.inspect().creates,1);}
 else assert.equal(j.payment.outcome,'NOT_OBSERVED');
 assert.doesNotMatch(JSON.stringify(j),/sk_test|bootstrapUrl|Bearer |checkout\.stripe/);
});

test('current payment context refuses foreign, stale, incomplete and preexisting state',t=>{
 const f=fixture(t);assert.equal(paymentContext(f.raw,f.e).amountTotalCents,12500);
 for(const mutate of [v=>v.actor.status='DISABLED',v=>v.actor.id=randomUUID(),v=>v.tenant.chargesEnabled=false,
   v=>v.tenant.stripeConnectAccountId='acct_foreign',v=>v.payments=1,v=>v.calendar=1,v=>v.job.policySnapshot.intakeAdmission.paymentDigest='a'.repeat(64),
   v=>v.job.pricingSnapshot={currency:'usd'},v=>v.job.updatedAt='2026-02-01T00:00:00.000Z',v=>v.tenant.settings=null]){
   const v=structuredClone(f.raw);mutate(v);assert.throws(()=>paymentContext(v,f.e));}
});

test('endpoint missing/null/live/version/event drift fails closed',t=>{
 const f=fixture(t),v={id:f.e.payment.endpointId,object:'webhook_endpoint',livemode:false,url:f.e.payment.url,api_version:f.e.payment.apiVersion,enabled_events:EVENTS,status:'disabled'};
 for(const change of [{livemode:true},{api_version:null},{url:'https://foreign.invalid'},{enabled_events:['*']},{status:null},{id:'we_foreign'}])assert.throws(()=>endpoint({...v,...change},f.e.payment));
});

test('version1 cannot accept payment and scope cannot omit payment',t=>{
 const f=fixture(t);f.e.version=1;f.seal();assert.throws(()=>authorizeChild(f.r.envelopePath,'--run'));
 f.e.version=2;f.seal();f.e.qualification.scopeSha256=hash(Object.fromEntries(['plan','target','database','resources','limits'].map(k=>[k,f.e[k]])));
 f.e.decision.scopeSha256=hash(Object.fromEntries(Object.entries(f.e).filter(([k])=>k!=='decision')));writeFileSync(f.r.envelopePath,JSON.stringify(f.e));
 assert.throws(()=>authorizeChild(f.r.envelopePath,'--run'));
});

test('fresh cleanup child recovers failed disable without reauthentication or new payment',async t=>{
 const f=fixture(t),ports=portsFor(f,'disable_failed');await runConnected(f.r,ports);
 const path=f.r.envelopePath.replace('envelope.json','journal.json'),j=JSON.parse(readFileSync(path));
 assert.equal(j.payment.endpointDisabled,false);const callsBefore=ports.inspect().calls.length;
 j.nativeEntry.calls.child=3;writeFileSync(path,JSON.stringify(j));ports.recover();
 const r=await runChild('--closeout',{...structuredClone(f.r),childCall:3},ports);
 assert.equal(r.sessionClosed,true);assert.equal(ports.inspect().status,'disabled');assert.equal(ports.inspect().creates,1);
 const after=JSON.parse(readFileSync(path));assert.equal(after.payment.endpointDisabled,true);
 assert.equal(after.payment.outcome,'APPLICATION_SETTLED');assert.ok(after.payment.endpointCalls<=9);
 assert.equal(ports.inspect().calls.slice(callsBefore).filter(x=>x.url.includes('signInWithCustomToken')).length,0);
});
