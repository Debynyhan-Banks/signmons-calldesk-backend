import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,unlinkSync,chmodSync,linkSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {hash,authorizeChild} from './authority_bridge.mjs';
import {runChild} from './native_child.mjs';
import {EVENTS,paymentContext,recoveryPaymentBinding,endpoint,stripeSecretName,completedPaymentCloseout} from './connected_payment.mjs';
import {SQL} from '../../p08-coordinator-auth-local-20261031/source/client.mjs';
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


test('recovery uses actual policy profile and keeps disabled/active phases distinct',t=>{
 const f=fixture(t),v=structuredClone(f.raw);v.actor.status='DISABLED';
 const scope={targetId:f.e.target.id,tenantId:f.e.plan.tenantId,jobId:f.e.plan.jobId,connectedAccountSha256:f.e.payment.connectedAccountSha256};
 const value=recoveryPaymentBinding(v,scope);
 assert.deepEqual(value,Object.fromEntries(Object.keys(value).map(k=>[k,f.e.payment[k]])));
 assert.throws(()=>paymentContext(v,f.e));
 for(const mutate of [x=>x.actor.status='ACTIVE',x=>x.job.updatedAt=null,x=>x.job.updatedAt='2026-01-01T00:00:00',
   x=>x.job.updatedAt='2099-01-01T00:00:00.000Z',x=>x.tenant.chargesEnabled=false,x=>x.tenant.stripeConnectAccountId='acct_foreign',
   x=>x.job.policySnapshot.intakeAdmission.paymentDigest='0'.repeat(64),x=>x.payments=1,x=>x.calendar=1,x=>x.tenant.settings=null]){
   const changed=structuredClone(v);mutate(changed);assert.throws(()=>recoveryPaymentBinding(changed,scope));}
});

for (const scenario of ['denied','missing_payload','malformed_json','live_key','newline_key','transport','foreign_code','streamed_success']) {
 test('actual payment preflight preserves safe failure evidence: '+scenario,async t=>{
  const f=fixture(t),base=portsFor(f);let secretCalls=0,stripeCalls=0;
  const injected={...base,fetcher:async(url,options)=>{
   if(url.startsWith('https://api.stripe.com/'))stripeCalls++;
   if(!url.startsWith('https://secretmanager.googleapis.com/'))return base.fetcher(url,options);
   secretCalls++;
   if(scenario==='transport')throw new TypeError('PRIVATE_SENTINEL transport body');
   if(scenario==='foreign_code')throw Object.assign(Error('PRIVATE_SENTINEL'),{code:'PAYMENT_PRIVATE_SENTINEL'});
   if(scenario==='denied')return new Response('PRIVATE_SENTINEL denied',{status:403});
   if(scenario==='malformed_json')return new Response('{PRIVATE_SENTINEL');
   const name=stripeSecretName(f.e);
   if(scenario==='missing_payload')return new Response(JSON.stringify({name,payload:null}));
   const key=scenario==='live_key'?'sk_live_PRIVATE_SENTINEL_123456':
     scenario==='newline_key'?'sk_test_12345678901234567890\n':'sk_test_12345678901234567890';
   return new Response(JSON.stringify({name,payload:{data:Buffer.from(key).toString('base64')}}));
  }};
  const jp=f.r.envelopePath.replace('envelope.json','journal.json');
  const initial=JSON.parse(readFileSync(jp));initial.authAttempted=false;writeFileSync(jp,JSON.stringify(initial));
  const request=structuredClone(f.r);
  if(scenario==='streamed_success')assert.deepEqual(await runChild('--payment-preflight',request,injected),{status:'PAYMENT_PREFLIGHT_QUALIFIED',qualified:true});
  else await assert.rejects(()=>runChild('--payment-preflight',request,injected));
  const j=JSON.parse(readFileSync(f.r.envelopePath.replace('envelope.json','journal.json')));
  assert.equal(secretCalls,1);assert.equal(stripeCalls,scenario==='streamed_success'?1:0);
  assert.equal(j.authAttempted,false);assert.equal(j.payment.enableIntent,false);
  const expected={denied:'PAYMENT_SECRET_REFUSED',missing_payload:'PAYMENT_SECRET_SHAPE',
   live_key:'PAYMENT_TEST_KEY_REQUIRED',newline_key:'PAYMENT_TEST_KEY_REQUIRED'};
  assert.equal(j.payment.failureCode,scenario==='streamed_success'?null:expected[scenario]??'PAYMENT_PREFLIGHT_UNCLASSIFIED');
  assert.equal(j.payment.phase,scenario==='streamed_success'?'QUALIFIED':'STOPPED');
  assert.equal(request.credentials.password,'');assert.equal(request.credentials.accessToken,'');
  assert.doesNotMatch(JSON.stringify(j),/PRIVATE_SENTINEL|sk_test_|sk_live_|Bearer /);
 });
}

const receiptPath=(f,name)=>f.r.envelopePath.replace('envelope.json',name);
const readReceipt=(f,name)=>JSON.parse(readFileSync(receiptPath(f,name)));
const writeReceipt=(f,name,value)=>writeFileSync(receiptPath(f,name),JSON.stringify(value),{mode:0o600});
async function nextChild(f,mode,ports){
 const j=readReceipt(f,'journal.json');j.nativeEntry.calls.child++;
 writeReceipt(f,'journal.json',j);
 return runChild(mode,{...structuredClone(f.r),childCall:j.nativeEntry.calls.child},ports);
}
async function completedMain(t,neverEnabled=false){
 const f=fixture(t),ports=portsFor(f),Parent=ports.ClientClass;
 if(neverEnabled)ports.ClientClass=class extends Parent{async query(sql,args){
   if(sql===SQL.activate)return {rows:[],rowCount:0};return super.query(sql,args);}};
 await runConnected(f.r,ports);
 const before=ports.inspect().calls.filter(x=>x.url.startsWith('https://api.stripe.com/')).length;await nextChild(f,'--readback',ports);
 assert.equal(ports.inspect().calls.filter(x=>x.url.startsWith('https://api.stripe.com/')).length,
   before+1,'main readback performs fresh endpoint GET');
 const j=readReceipt(f,'journal.json');j.phase='CLOSED';writeReceipt(f,'journal.json',j);
 writeReceipt(f,'closeout.json',{operationId:f.e.plan.operationId});
 writeReceipt(f,'independent-closeout.json',{operationId:f.e.plan.operationId});
 writeReceipt(f,'work-result.json',{status:'ENTRY_AWAITING_INDEPENDENT_CLOSEOUT',operationId:f.e.plan.operationId,
   liveAuthorization:false,authProofReady:false,paymentReadyForAcceptance:false,
   paymentObserved:j.payment.outcome==='APPLICATION_SETTLED',residuals:neverEnabled?['AUTH_REVOKE','AUTH_OUTCOME_UNKNOWN']:[],privateInputsAbsent:false});
 return f;
}
function retiredPorts(f,onRead){
 const base=portsFor(f),Parent=base.ClientClass;const observed={secrets:0,stripe:0,accounts:0,probes:0,closed:0};
 return {...base,observed,ClientClass:class extends Parent{
   async query(sql,args){if(sql===SQL.get){observed.accounts++;onRead?.();}if(sql.includes('pg_stat_activity'))observed.probes++;
     return super.query(sql,args);}
   async end(){observed.closed++;return super.end();}
 },fetcher:async(url,options)=>{
   if(url.startsWith('https://secretmanager.googleapis.com/')){observed.secrets++;return new Response('retired synthetic secret',{status:403});}
   if(url.startsWith('https://api.stripe.com/'))observed.stripe++;
   return base.fetcher(url,options);
 }};
}

for(const neverEnabled of [false,true])test('independent account readback after secret retirement reuses only completed main proof: '+neverEnabled,async t=>{
 const f=await completedMain(t,neverEnabled),before=readReceipt(f,'journal.json'),ports=retiredPorts(f);
 const result=await nextChild(f,'--readback',ports);
 assert.equal(result.app.status,'DISABLED');assert.equal(result.firebase.disabled,true);assert.equal(result.sessions,0);
 assert.deepEqual(ports.observed,{secrets:0,stripe:0,accounts:1,probes:1,closed:2});
 const after=readReceipt(f,'journal.json');assert.deepEqual(after.payment,before.payment);
 assert.equal(after.authClient.tokenIssueIntent,!neverEnabled);
 assert.doesNotMatch(JSON.stringify(after),/sk_test|Bearer |bootstrapUrl/);
});

test('main readback failure records payment uncertainty after fresh account/session cleanup',async t=>{
 const f=fixture(t),base=portsFor(f);await runConnected(f.r,base);
 const ports=retiredPorts(f);await assert.rejects(()=>nextChild(f,'--readback',ports),/PAYMENT_ENDPOINT_UNCONFIRMED/);
 assert.equal(ports.observed.secrets,1);assert.equal(ports.observed.accounts,1);assert.equal(ports.observed.probes,1);
 assert.deepEqual(readReceipt(f,'journal.json').payment.residuals,['PAYMENT_ENDPOINT_UNCONFIRMED']);
});

const proofFailures={
 missing_work:f=>unlinkSync(receiptPath(f,'work-result.json')),
 missing_independent:f=>unlinkSync(receiptPath(f,'independent-closeout.json')),
 foreign_marker:f=>writeReceipt(f,'independent-closeout.json',{operationId:randomUUID()}),
 failed_account:f=>{const v=readReceipt(f,'work-result.json');v.residuals.push('ACCOUNT_SESSION');writeReceipt(f,'work-result.json',v);},
 failed_payment:f=>{const v=readReceipt(f,'work-result.json');v.residuals.push('PAYMENT_ENDPOINT_UNCONFIRMED');writeReceipt(f,'work-result.json',v);},
 stale_outcome:f=>{const v=readReceipt(f,'work-result.json');v.paymentObserved=!v.paymentObserved;writeReceipt(f,'work-result.json',v);},
 pending_publish:f=>writeReceipt(f,'journal.json.payment-next',readReceipt(f,'journal.json')),
 later_enable:f=>{const v=readReceipt(f,'journal.json');v.payment.phase='ENABLE_INTENT';writeReceipt(f,'journal.json',v);},
 unknown_endpoint:f=>{const v=readReceipt(f,'journal.json');v.payment.endpointDisabled=false;writeReceipt(f,'journal.json',v);},
 open_bridge:f=>{const v=readReceipt(f,'journal.json');v.payment.bridgeClosed=false;writeReceipt(f,'journal.json',v);},
 foreign_scope:f=>{const v=readReceipt(f,'journal.json');v.payment.scopeSha256='a'.repeat(64);writeReceipt(f,'journal.json',v);},
};
for(const [name,mutate] of Object.entries(proofFailures))test('bad independent payment proof still attempts account/session reads: '+name,async t=>{
 const f=await completedMain(t);mutate(f);const ports=retiredPorts(f);
 await assert.rejects(()=>nextChild(f,'--readback',ports),/PAYMENT_ENDPOINT_UNCONFIRMED/);
 assert.equal(ports.observed.secrets,0);assert.equal(ports.observed.stripe,0);
 assert.equal(ports.observed.accounts,1);assert.equal(ports.observed.probes,1);
 if(!['foreign_scope','pending_publish'].includes(name))
   assert.ok(readReceipt(f,'journal.json').payment.residuals.includes('PAYMENT_ENDPOINT_UNCONFIRMED'));
});

for(const name of ['work_replaced','later_intent'])test('concurrent proof drift during account readback never becomes payment success: '+name,async t=>{
 const f=await completedMain(t);let changed=false;
 const ports=retiredPorts(f,()=>{if(changed)return;changed=true;
   if(name==='work_replaced'){const path=receiptPath(f,'work-result.json'),v=readReceipt(f,'work-result.json');unlinkSync(path);writeReceipt(f,'work-result.json',v);}
   else {const v=readReceipt(f,'journal.json');v.payment.phase='ENABLE_INTENT';writeReceipt(f,'journal.json',v);}
 });
 await assert.rejects(()=>nextChild(f,'--readback',ports),/PAYMENT_ENDPOINT_UNCONFIRMED/);
 assert.equal(ports.observed.probes,1);assert.equal(ports.observed.secrets,0);
 assert.ok(readReceipt(f,'journal.json').payment.residuals.includes('PAYMENT_ENDPOINT_UNCONFIRMED'));
});

test('completed payment proof enforces custody and deadline through actual authorized capability',async t=>{
 const f=await completedMain(t),cap=authorizeChild(f.r.envelopePath,'--readback'),digest=hash(f.e),path=receiptPath(f,'work-result.json');
 const verify=completedPaymentCloseout(cap,f.r.envelopePath,digest);verify();
 chmodSync(path,0o644);assert.throws(()=>completedPaymentCloseout(cap,f.r.envelopePath,digest));chmodSync(path,0o600);
 const linked=receiptPath(f,'journal-next.json');linkSync(path,linked);
 assert.throws(()=>completedPaymentCloseout(cap,f.r.envelopePath,digest));unlinkSync(linked);
 const now=Date.now;Date.now=()=>Date.parse(f.e.plan.window.cleanupEnd);
 try{assert.throws(()=>verify(),/OUTER_DEADLINE/);}finally{Date.now=now;}
});
