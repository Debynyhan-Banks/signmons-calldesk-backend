import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readFileSync,writeFileSync,rmSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {hash,authorizeChild} from './authority_bridge.mjs';
import {runChild} from './native_child.mjs';
import {fixturePorts} from './fixture_ports.mjs';
import {EVENTS,PAYMENT_SQL,paymentContext,endpoint} from './connected_payment.mjs';

export function fixture(t){
  const f=JSON.parse(execFileSync('/opt/homebrew/bin/python3',['-B',fileURLToPath(new URL('./fixture_envelope.py',import.meta.url))],{encoding:'utf8'}));
  t.after(()=>{for(const p of f.cleanup){assert.match(p,/^\/private\/tmp\/p08-coordinator-(?:private-)?[a-f0-9-]{36}$/);rmSync(p,{recursive:true});}});
  const r=f.request,e=JSON.parse(readFileSync(r.envelopePath));
  const draft={currency:'usd',serviceFeeRequired:false,serviceFeeCents:null,depositRequired:true,
    depositPolicy:{kind:'fixed',amountCents:12500},emergencyFeePolicy:{kind:'none'},paymentGateMode:'fail_closed',webhookValidationRequired:true};
  const approved={draft,actorId:e.target.id,approvedAt:'2026-01-01T00:00:00.000Z'};
  e.version=2;e.payment={qualificationId:randomUUID(),endpointId:'we_synthetic',endpointSha256:hash('we_synthetic'),apiVersion:'2026-03-25.dahlia',
    url:'https://app013-p07-atomic---signmons-calldesk-staging-p572d6wipq-ul.a.run.app/webhooks/stripe',
    connectedAccountSha256:hash('acct_synthetic'),amountTotalCents:12500,currency:'usd',approvedAt:approved.approvedAt,
    policyDigest:hash(JSON.stringify(approved)),jobUpdatedAt:approved.approvedAt,requestId:randomUUID(),
    workEnd:new Date(Date.parse(e.plan.window.workEnd)-60000).toISOString()};
  const raw={actor:{id:e.target.id,tenantId:e.plan.tenantId,status:'ACTIVE',role:'ADMIN'},
    tenant:{id:e.plan.tenantId,status:'ACTIVE',chargesEnabled:true,stripeConnectAccountId:'acct_synthetic',settings:{organizationPaymentPolicyV1:{version:1,draft,approved}}},
    job:{id:e.plan.jobId,tenantId:e.plan.tenantId,status:'CREATED',deletedAt:null,updatedAt:approved.approvedAt,calendarEventId:null,serviceWindowStart:null,serviceWindowEnd:null,
      pricingSnapshot:{},policySnapshot:{intakeAdmission:{version:2,actorId:'signmons-intake-admission-v1',paymentApprovedAt:approved.approvedAt,paymentDigest:e.payment.policyDigest}}},payments:0,calendar:0};
  function seal(){e.qualification.scopeSha256=hash(Object.fromEntries(['plan','target','database','resources','limits','payment'].map(k=>[k,e[k]])));
    e.decision={decision:'APPROVE_LOCAL_NATIVE_ENTRY_PROOF',scopeSha256:hash(Object.fromEntries(Object.entries(e).filter(([k])=>k!=='decision')))};
    writeFileSync(r.envelopePath,JSON.stringify(e));const jp=r.envelopePath.replace('envelope.json','journal.json'),j=JSON.parse(readFileSync(jp));j.nativeEntry.envelopeSha256=hash(e);writeFileSync(jp,JSON.stringify(j));}
  seal();return {r,e,raw,seal};
}

export function portsFor(f,scenario='normal'){
 const base=fixturePorts(f.r),Parent=base.ClientClass;let status=JSON.parse(readFileSync(f.r.envelopePath.replace('envelope.json','journal.json'))).payment?.enableIntent && !JSON.parse(readFileSync(f.r.envelopePath.replace('envelope.json','journal.json'))).payment?.endpointDisabled?'enabled':'disabled',settled=false,creates=0,secretReads=0,hadDisable=false;const calls=[];
 const webhook=()=>({id:f.e.payment.endpointId,object:'webhook_endpoint',livemode:false,url:f.e.payment.url,api_version:f.e.payment.apiVersion,enabled_events:EVENTS,status});
 return {...base,ClientClass:class extends Parent {async query(sql,args){
   if(['BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY','COMMIT','ROLLBACK'].includes(sql))return {rows:[]};
   if(sql===PAYMENT_SQL){assert.deepEqual(args,[f.e.target.id,f.e.plan.tenantId,f.e.plan.jobId]);return {rows:[{value:f.raw}]};}
   return super.query(sql,args);
 }},fetcher:async(url,opts)=>{
   let value;calls.push({url,method:opts.method});
   if(url.startsWith('https://secretmanager.googleapis.com/')){secretReads++;value={name:'projects/'+f.e.plan.projectNumber+'/secrets/signmons-staging-stripe-secret-key/versions/1',payload:{data:Buffer.from('sk_test_SYNTHETIC_ONLY_1234567890'.replaceAll('_ONLY_','ONLY')).toString('base64')}};}
   else if(url.startsWith('https://api.stripe.com/')){
     if(opts.method==='POST'){status=opts.body==='disabled=true'?'disabled':'enabled';hadDisable=status==='disabled';if(scenario==='lost_enable'&&status==='enabled')throw Error('lost response');if(scenario==='disable_failed'&&status==='disabled'){status='enabled';throw Error('disable refused');}}
     if(scenario==='disable_readback_failed'&&opts.method==='GET'&&hadDisable)throw Error('lost disable readback');
     value=webhook();if(scenario==='foreign_endpoint')value.url='https://foreign.invalid/webhooks/stripe';
   }else if(url.endsWith('/job-payment-policy/apply'))value={jobId:f.e.plan.jobId,policyBound:true,paymentInitiated:false,bookingAuthorized:false,deliveryAuthorized:false,updatedAt:f.e.payment.jobUpdatedAt};
   else if(url.endsWith('/payment-requests')){creates++;assert.equal(opts.headers['Idempotency-Key'],f.e.payment.requestId);value={checkoutUrl:'https://checkout.stripe.com/c/pay/synthetic'};if(scenario==='lost_create')throw Error('lost create');}
   else if(url.endsWith('/payment-request/recover'))value={checkoutUrl:'https://checkout.stripe.com/c/pay/synthetic'};
   else if(url.endsWith('/payment-request'))value={status:settled?'SUCCEEDED':'PENDING',amountTotalCents:12500,currency:'usd'};
   else if(url.endsWith('/payment-events'))value=[];
   else if(url.includes('/jobs/dispatch-board/'))value={jobId:f.e.plan.jobId,paymentGate:{state:settled?'UNLOCKED':'LOCKED'}};
   else return base.fetcher(url,opts);
   return {ok:true,status:200,text:async()=>JSON.stringify(value)};
 },present:async url=>{
   const origin=new URL(url).origin,start=await fetch(url,{redirect:'manual'}),cookie=start.headers.get('set-cookie').split(';')[0];
   const html=await (await fetch(origin,{headers:{Cookie:cookie}})).text();
   const csrf=html.match(/const csrf="([a-f0-9]+)"/)?.[1]??html.match(/const csrf = "([a-f0-9]+)"/)?.[1];
   assert.ok(csrf,'CSRF present');
   const act=async action=>{const r=await fetch(origin+'/action',{method:'POST',headers:{Cookie:cookie,Origin:origin,'Content-Type':'application/json','x-p08-csrf':csrf},body:JSON.stringify({action,acknowledged:true})});return {status:r.status,value:await r.json()};};
   assert.equal((await act('bind')).status,200);
   const created=await act('create');assert.equal(created.status,scenario==='lost_create'?503:200);
   if(scenario==='lost_create')assert.equal((await act('recover')).status,200);
   settled=scenario!=='unpaid';assert.equal((await act('read')).status,200);
   assert.equal((await act('clear')).status,200);
 },recover:()=>{scenario='normal';},inspect:()=>({status,creates,secretReads,calls})};
}


export function rawFor(e){
 const draft={currency:'usd',serviceFeeRequired:false,serviceFeeCents:null,depositRequired:true,depositPolicy:{kind:'fixed',amountCents:12500},emergencyFeePolicy:{kind:'none'},paymentGateMode:'fail_closed',webhookValidationRequired:true};
 const approved={draft,actorId:e.target.id,approvedAt:e.payment.approvedAt};
 return {actor:{id:e.target.id,tenantId:e.plan.tenantId,status:'ACTIVE',role:'ADMIN'},
   tenant:{id:e.plan.tenantId,status:'ACTIVE',chargesEnabled:true,stripeConnectAccountId:'acct_synthetic',settings:{organizationPaymentPolicyV1:{version:1,draft,approved}}},
   job:{id:e.plan.jobId,tenantId:e.plan.tenantId,status:'CREATED',deletedAt:null,updatedAt:e.payment.jobUpdatedAt,calendarEventId:null,serviceWindowStart:null,serviceWindowEnd:null,
     pricingSnapshot:{},policySnapshot:{intakeAdmission:{version:2,actorId:'signmons-intake-admission-v1',paymentApprovedAt:approved.approvedAt,paymentDigest:e.payment.policyDigest}}},payments:0,calendar:0};
}


export async function runConnected(request, ports){
 await runChild('--payment-preflight',structuredClone(request),ports);
 const path=request.envelopePath.replace('envelope.json','journal.json'),j=JSON.parse(readFileSync(path));
 j.nativeEntry.calls.child=2;writeFileSync(path,JSON.stringify(j));
 return runChild('--run',{...structuredClone(request),childCall:2},ports);
}
