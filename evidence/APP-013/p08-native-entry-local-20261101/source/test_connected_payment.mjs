import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,unlinkSync,chmodSync,linkSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {hash,authorizeChild} from './authority_bridge.mjs';
import {runChild} from './native_child.mjs';
import {EVENTS,paymentContext,recoveryPaymentBinding,endpoint,endpointComparison,stripeSecretName,completedPaymentCloseout,createPaymentPorts,runPayment,PaymentJournal,boundedPaymentResponse} from './connected_payment.mjs';
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

// Frozen pre-ED1 predicate: an independent pass/fail oracle, including its
// historical TypeError for non-sortable JSON event members. Pins are the
// validated production types, while provider fields range over decoded JSON.
function legacyEndpointAccepts(value,p,status) {
 try{return Boolean(value && value.object==='webhook_endpoint' && value.id===p.endpointId &&
  hash(value.id)===p.endpointSha256 && value.livemode===false && value.url===p.url &&
  value.api_version===p.apiVersion && Array.isArray(value.enabled_events) &&
  JSON.stringify([...value.enabled_events].sort())===JSON.stringify(EVENTS) &&
  ['enabled','disabled'].includes(value.status) && (!status||value.status===status));}
 catch{return false;}
}
const comparisonFields=['objectType','endpointIdentity','sandboxMode','url','apiVersion','enabledEvents','recognizedStatus','disabledStatus'];
function comparisonFixture() {
 const p={endpointId:'we_ED1_fixture',endpointSha256:hash('we_ED1_fixture'),url:'https://fixture.invalid/webhooks/stripe',apiVersion:'2026-03-25.dahlia'};
 return {p,row:{object:'webhook_endpoint',id:p.endpointId,livemode:false,url:p.url,
  api_version:p.apiVersion,enabled_events:[...EVENTS],status:'disabled'}};
}
test('ED1 native acceptance matches the frozen predicate across JSON field and status cases',()=>{
 const {p,row}=comparisonFixture(),values=[null,[],{},true,false,0,1,'','PRIVATE_SENTINEL'];
 for(const key of Object.keys(row))for(const value of [undefined,null,[],{},true,false,0,1,'','PRIVATE_SENTINEL']) {
  const changed={...row};if(value===undefined)delete changed[key];else changed[key]=value;values.push(changed);
 }
 values.push(row,{...row,status:'enabled'},{...row,enabled_events:[...EVENTS].reverse()},
  {...row,enabled_events:[...EVENTS,EVENTS[0]]},{...row,enabled_events:EVENTS.slice(1)},
  {...row,enabled_events:[...EVENTS,{toString:'PRIVATE_SENTINEL'}]},
  {...row,id:'we_foreign',url:'https://PRIVATE_SENTINEL.invalid',livemode:true});
 for(const value of values)for(const required of [undefined,null,false,0,'','enabled','disabled',true,'unknown']) {
  const expected=legacyEndpointAccepts(value,p,required);
  if(expected)assert.equal(endpoint(value,p,required),value);
  else assert.throws(()=>endpoint(value,p,required),{code:'PAYMENT_ENDPOINT_DRIFT'});
 }
 assert.throws(()=>endpoint(row,{...p,endpointSha256:'0'.repeat(64)}),{code:'PAYMENT_ENDPOINT_DRIFT'});
 assert.equal(endpointComparison(row,{...p,endpointSha256:'0'.repeat(64)}).endpointIdentity,'MISMATCH');
});
test('ED1 reports each failed comparison without retaining values or changing the input',()=>{
 const {p,row}=comparisonFixture(),match=Object.fromEntries(comparisonFields.map(k=>[k,'MATCH']));
 assert.deepEqual(endpointComparison(row,p),match);
 const cases=[['object','objectType','PRIVATE_SENTINEL'],['id','endpointIdentity','we_PRIVATE_SENTINEL'],
  ['livemode','sandboxMode',true],['url','url','https://PRIVATE_SENTINEL.invalid'],
  ['api_version','apiVersion','PRIVATE_SENTINEL'],['enabled_events','enabledEvents',['PRIVATE_SENTINEL']],
  ['status','recognizedStatus','PRIVATE_SENTINEL'],['status','disabledStatus','enabled']];
 for(const [key,field,value] of cases) {
  const changed={...row,[key]:value},before=JSON.stringify(changed),report=endpointComparison(changed,p);
  assert.equal(report[field],'MISMATCH');assert.deepEqual(Object.keys(report),comparisonFields);
  assert.equal(JSON.stringify(changed),before);assert.doesNotMatch(JSON.stringify(report),/PRIVATE_SENTINEL|we_|https:|dahlia/);
  for(const invalid of [undefined,null,[],{},0]) {
   const malformed={...row};if(invalid===undefined)delete malformed[key];else malformed[key]=invalid;
   // An empty array is a valid event-list type, but it is a mismatched list.
   assert.equal(endpointComparison(malformed,p)[field],key==='enabled_events'&&Array.isArray(invalid)?'MISMATCH':'TYPE_INVALID');
  }
 }
 const both=endpointComparison({...row,livemode:true,api_version:null,url:'PRIVATE_SENTINEL'},p);
 assert.equal(both.sandboxMode,'MISMATCH');assert.equal(both.apiVersion,'TYPE_INVALID');assert.equal(both.url,'MISMATCH');
 const reversed={...row,enabled_events:Object.freeze([...EVENTS].reverse())};
 assert.equal(endpointComparison(Object.freeze(reversed),p).enabledEvents,'MATCH');
 for(const events of [[...EVENTS,EVENTS[0]],[...EVENTS,'*']])assert.equal(endpointComparison({...row,enabled_events:events},p).enabledEvents,'MISMATCH');
 for(const events of [[null],[{}],[true],[1],[['checkout.session.completed']]])assert.equal(endpointComparison({...row,enabled_events:events},p).enabledEvents,'TYPE_INVALID');
 for(const value of [null,[],true,1,'PRIVATE_SENTINEL'])assert.ok(Object.values(endpointComparison(value,p)).every(x=>x==='TYPE_INVALID'));
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

for(const boundary of ['request','text','read','cancel','dripping'])test('TC1 payment full response bounds ignored abort at '+boundary,async()=>{
 let sends=0,reservations=0,reads=0,cancels=0,signal;
 const hanging=()=>new Promise(()=>{}),start=performance.now();
 const send=async(_url,options)=>{
  sends++;signal=options.signal;if(boundary==='request')return hanging();
  if(boundary==='text')return {ok:true,status:200,text:hanging};
  return {ok:true,status:200,body:{getReader:()=>({read:async()=>{
   reads++;if(boundary==='read')return hanging();
   if(boundary==='dripping'){await new Promise(resolve=>setTimeout(resolve,10));return {done:false,value:Buffer.from('x')};}
   return {done:true};
  },cancel:async()=>{cancels++;if(boundary==='cancel')return hanging();}})}};
 };
 await assert.rejects(()=>boundedPaymentResponse(send,'https://synthetic.invalid',{},spend=>{if(spend)reservations++;},Date.now()+100),{code:'PAYMENT_IO_TIMEOUT'});
 assert.ok(performance.now()-start<1500);assert.equal(sends,1);assert.equal(reservations,1);
 assert.ok(signal instanceof AbortSignal);if(boundary==='cancel')assert.equal(cancels,1);
 if(boundary==='dripping')assert.ok(reads>1,'progress must not reset the response deadline');
});

for(const kind of ['read','validation','interrupt'])for(const cancellation of ['reject','hang'])test('TC1 payment retains '+kind+' failure with '+cancellation+' disposal',async()=>{
 const primary=kind==='interrupt'?new DOMException('synthetic interruption','AbortError'):Error('PRIVATE_PRIMARY');
 let requests=0,cancels=0,reservations=0;
 const send=async()=>{requests++;return {ok:true,status:200,body:{getReader:()=>({read:async()=>{
  if(kind==='validation')return {done:false,value:Buffer.alloc(65537)};throw primary;
 },cancel:async()=>{cancels++;if(cancellation==='hang')return new Promise(()=>{});throw Error('PRIVATE_CANCEL');}})}};};
 const start=performance.now();
 await assert.rejects(()=>boundedPaymentResponse(send,'https://synthetic.invalid',{},spend=>{if(spend)reservations++;},Date.now()+100),
  error=>kind==='validation'?error.code==='PAYMENT_OUTPUT_LIMIT':error===primary);
 assert.ok(performance.now()-start<1500);assert.equal(requests,1);assert.equal(cancels,1);assert.equal(reservations,1);
});

test('TC1 payment cancellation refusal fails closed and all owned timers are cleared',async t=>{
 const originalSet=setTimeout,originalClear=clearTimeout,active=new Set();
 t.mock.method(globalThis,'setTimeout',(fn,ms,...args)=>{const handle=originalSet(fn,ms,...args);active.add(handle);return handle;});
 t.mock.method(globalThis,'clearTimeout',handle=>{active.delete(handle);return originalClear(handle);});
 const primary=Error('PRIVATE_CANCEL');let reservations=0,cancels=0;
 const send=async()=>({ok:true,status:200,body:{getReader:()=>({read:async()=>({done:true}),cancel:async()=>{cancels++;throw primary;}})}});
 await assert.rejects(()=>boundedPaymentResponse(send,'https://synthetic.invalid',{},spend=>{if(spend)reservations++;},Date.now()+500),error=>error===primary);
 assert.equal(cancels,1);assert.equal(reservations,1);assert.equal(active.size,0);
});

test('TC1 payment success closes once and backward time cannot authorize success',async t=>{
 let reads=0,cancels=0,reservations=0;
 const send=async()=>({ok:true,status:200,body:{getReader:()=>({read:async()=>++reads===1?{done:false,value:Buffer.from('{}')}:{done:true},cancel:async()=>{cancels++;}})}});
 const result=await boundedPaymentResponse(send,'https://synthetic.invalid',{},spend=>{if(spend)reservations++;},Date.now()+500);
 assert.equal(await result.text(),'{}');assert.equal(result.status,200);assert.equal(cancels,1);assert.equal(reservations,1);
 const original=Date.now;let rollback=0;t.mock.method(Date,'now',()=>original()-rollback);
 await assert.rejects(()=>boundedPaymentResponse(async()=>{rollback=100;return {text:async()=>'{}'};},'https://synthetic.invalid',{},()=>{},original()+500),{code:'CLOCK_ROLLBACK'});
});

test('TC1 payment request and failed-disposal timers retain five-second and one-second ceilings',async t=>{
 const original=setTimeout,budgets=[];
 t.mock.method(globalThis,'setTimeout',(fn,ms,...args)=>{budgets.push(ms);return original(fn,Math.min(ms,40),...args);});
 let sends=0,cancels=0,reservations=0;
 const send=async()=>{sends++;return {ok:true,status:200,body:{getReader:()=>({read:()=>new Promise(()=>{}),
  cancel:()=>{cancels++;return new Promise(()=>{});}})}};};
 const start=performance.now();
 await assert.rejects(()=>boundedPaymentResponse(send,'https://synthetic.invalid',{},spend=>{if(spend)reservations++;},Date.now()+20000),{code:'PAYMENT_IO_TIMEOUT'});
 assert.equal(sends,1);assert.equal(cancels,1);assert.equal(reservations,1);assert.equal(budgets.length,3);
 assert.ok(budgets.slice(0,2).every(value=>value>4900&&value<=5000));assert.ok(budgets[2]>900&&budgets[2]<=1000);
 assert.ok(performance.now()-start<1500);
});

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

function authQualificationFixture(t){
 const f=fixture(t);f.e.purpose='NATIVE_AUTH_QUALIFICATION_ONLY';f.seal();
 f.e.decision={decision:'APPROVE_LOCAL_AUTH_QUALIFICATION_PROOF',scopeSha256:hash(Object.fromEntries(Object.entries(f.e).filter(([k])=>k!=='decision')))};
 writeReceipt(f,'envelope.json',f.e);
 const j=readReceipt(f,'journal.json');j.nativeEntry.envelopeSha256=hash(f.e);writeReceipt(f,'journal.json',j);
 return f;
}
test('AQ1 actual child authenticates, refuses payment and independently reads back cleanup',async t=>{
 const f=authQualificationFixture(t),base=portsFor(f);let presented=0;
 const ports={...base,present:async()=>{presented++;throw Error('must not open');}};
 const result=await runConnected(f.r,ports);
 assert.equal(result.authenticated,true);assert.equal(result.sessionClosed,true);
 assert.equal(presented,0);assert.equal(base.inspect().creates,0);assert.equal(base.inspect().status,'disabled');
 assert.equal(base.inspect().calls.filter(x=>x.url.includes('/jobs/dispatch-board/')).length,1);
 assert.equal(base.inspect().calls.filter(x=>x.url.startsWith('https://api.stripe.com/')&&x.method==='POST').length,0);
 await nextChild(f,'--readback',ports);await nextChild(f,'--closeout',ports);
 const j=readReceipt(f,'journal.json');assert.equal(j.payment.enableIntent,false);
 assert.equal(j.payment.bridgeClosed,true);assert.equal(j.payment.outcome,'NOT_OBSERVED');
 assert.equal(j.authClient.phase,'CLOSEOUT_FINISHED');assert.deepEqual(j.authClient.residuals,[]);
});
test('AQ1 direct payment and route invocations fail before secret access or I/O',async t=>{
 const f=authQualificationFixture(t),cap=authorizeChild(f.r.envelopePath,'--run');
 cap.e.runtimeOrigin=f.e.payment.url.replace('/webhooks/stripe','');
 const journal=new PaymentJournal(cap,receiptPath(f,'journal.json'));
 journal.save({phase:'QUALIFIED',enableIntent:false,endpointDisabled:true,bridgeClosed:true,outcome:'NOT_OBSERVED',failureCode:null,endpointCalls:0,secretReads:0,residuals:[]});
 let calls=0;const base=portsFor(f);
 const ports=createPaymentPorts(cap,structuredClone(f.r.credentials),journal,{fetcher:async(...args)=>{calls++;return base.fetcher(...args);}});
 await assert.rejects(()=>runPayment(cap,{db:null,ports,journal,token:'PRIVATE_SENTINEL',present:()=>assert.fail()}),{code:'PAYMENT_AUTHORITY'});
 for(const cleanup of [false,true])await assert.rejects(()=>ports.endpoint('POST',false,cleanup),{code:'AUTH_QUALIFICATION_PAYMENT_DENIED'});
 await assert.rejects(()=>ports.endpoint('POST',true,false),{code:'AUTH_QUALIFICATION_PAYMENT_DENIED'});
 for(const [method,path] of [['GET','/jobs/x/payment-request'],['POST','/job-payment-policy/apply'],['POST','/jobs/x/payment-requests'],['POST','/jobs/x/payment-request/recover']])
  await assert.rejects(()=>ports.application(cap.e.runtimeOrigin+path,{method}),{code:'AUTH_QUALIFICATION_PAYMENT_DENIED'});
 assert.equal(calls,0);assert.equal(journal.state.secretReads,0);
 await ports.endpoint('GET',null,false);await ports.endpoint('POST',true,true);
 assert.equal(calls,3);assert.equal(base.inspect().status,'disabled');ports.clear();
});
