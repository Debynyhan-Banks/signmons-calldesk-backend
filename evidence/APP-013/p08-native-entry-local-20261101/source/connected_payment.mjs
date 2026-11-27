// Owned payment phase for native entry. No ambient credentials or provider clients.
import {readFileSync,writeFileSync,renameSync,readSync,lstatSync,realpathSync,openSync,closeSync,fstatSync,constants} from 'node:fs';
import {dirname,join} from 'node:path';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {hash,need,gate} from './authority_bridge.mjs';
const require=createRequire(new URL('../../../../package.json',import.meta.url));
export const EVENTS=Object.freeze(['charge.refunded','checkout.session.async_payment_failed',
  'checkout.session.async_payment_succeeded','checkout.session.completed','checkout.session.expired',
  'payment_intent.payment_failed']);
export const PAYMENT_SQL=`SELECT json_build_object(
 'actor',(SELECT row_to_json(a) FROM (SELECT id,"tenantId",role::text,status::text FROM "User" WHERE id=$1::uuid) a),
 'tenant',(SELECT row_to_json(t) FROM (SELECT id,status::text,"chargesEnabled","stripeConnectAccountId",settings FROM "TenantOrganization" WHERE id=$2::uuid) t),
 'job',(SELECT row_to_json(j) FROM (SELECT id,"tenantId",status::text,"deletedAt",to_char("updatedAt",'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "updatedAt","calendarEventId","serviceWindowStart","serviceWindowEnd","policySnapshot","pricingSnapshot" FROM "Job" WHERE id=$3::uuid AND "tenantId"=$2::uuid) j),
 'payments',(SELECT count(*)::int FROM "Payment" WHERE "jobId"=$3::uuid),
 'calendar',(SELECT count(*)::int FROM "CalendarOperation" WHERE "jobId"=$3::uuid)) AS value`;

function contextBinding(v,e,now,actorStatus) {
  const {profile}=require('./dist/tenants/organization-payment-policy.js');
  const p=e.payment, j=v?.job,t=v?.tenant,a=v?.actor;
  need(a?.id===e.target.id && a.tenantId===e.plan.tenantId && a.role==='ADMIN' && a.status===actorStatus,'PAYMENT_ACTOR');
  need(j?.id===e.plan.jobId && j.tenantId===e.plan.tenantId && j.status==='CREATED' && j.deletedAt===null,'PAYMENT_JOB');
  need(v.payments===0 && v.calendar===0 && j.calendarEventId===null && j.serviceWindowStart===null && j.serviceWindowEnd===null,'PAYMENT_ACTIVITY');
  need(t?.id===e.plan.tenantId && t.status==='ACTIVE' && t.chargesEnabled===true &&
    typeof t.stripeConnectAccountId==='string' && /^acct_[A-Za-z0-9]+$/.test(t.stripeConnectAccountId) &&
    hash(t.stripeConnectAccountId)===p.connectedAccountSha256,'PAYMENT_ACCOUNT');
  let approved;try{approved=profile(t.settings?.organizationPaymentPolicyV1)?.approved;}catch{need(false,'PAYMENT_POLICY');}
  need(approved && Date.parse(approved.approvedAt)<=now,'PAYMENT_POLICY');
  // Application canonical profile property order, not sorted-key envelope serialization.
  const digest=hash(JSON.stringify(approved)),ad=j.policySnapshot?.intakeAdmission;
  need(ad?.version===2 && ad.actorId==='signmons-intake-admission-v1' && ad.humanReviewed!==true &&
    ad.paymentApprovedAt===approved.approvedAt && ad.paymentDigest===digest,'PAYMENT_ADMISSION');
  need(j.pricingSnapshot && Object.keys(j.pricingSnapshot).length===0 &&
    !['paymentPolicyBinding','depositRequired','serviceFeeRequired','paymentGateMode','paymentGateException']
      .some(k=>k in j.policySnapshot),'PAYMENT_EXISTING_TERMS');
  const d=approved.draft,amount=(d.serviceFeeRequired?d.serviceFeeCents:0)+(d.depositRequired?d.depositPolicy.amountCents:0);
  need(Number.isSafeInteger(amount)&&amount>0 && amount<=200000000,'PAYMENT_AMOUNT');
  need(typeof j.updatedAt==='string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(j.updatedAt) &&
    Number.isFinite(Date.parse(j.updatedAt)) && Date.parse(j.updatedAt)<=now,'PAYMENT_JOB_VERSION');
  return {amountTotalCents:amount,currency:'usd',approvedAt:approved.approvedAt,policyDigest:digest,
    jobUpdatedAt:j.updatedAt,connectedAccountSha256:p.connectedAccountSha256};
}

export function recoveryPaymentBinding(v,scope,now=Date.now()) {
  need(scope && Object.keys(scope).sort().join(',')==='connectedAccountSha256,jobId,targetId,tenantId' &&
    /^[a-f0-9]{64}$/.test(scope.connectedAccountSha256) && Number.isFinite(now),'PAYMENT_RECOVERY_SCOPE');
  return contextBinding(v,{target:{id:scope.targetId},plan:{tenantId:scope.tenantId,jobId:scope.jobId},
    payment:{connectedAccountSha256:scope.connectedAccountSha256}},now,'DISABLED');
}

export function paymentContext(v,e,now=Date.now()) {
  const binding=contextBinding(v,e,now,'ACTIVE');
  need(Object.entries(binding).every(([k,value])=>e.payment[k]===value),'PAYMENT_SCOPE_DRIFT');
  return {status:'QUALIFIED_DATABASE',actorId:v.actor.id,actorRole:'admin',tenantId:v.tenant.id,jobId:v.job.id,...binding};
}

// Finite labels only: never retain a provider value or a digest of one.
// The wire input is decoded JSON; invalid/missing field types remain distinct
// from well-typed mismatches. Duplicate events are not normalized away.
export function endpointComparison(value,p) {
  const row=value!==null && typeof value==='object' && !Array.isArray(value)?value:{};
  const label=(valid,match)=>!valid?'TYPE_INVALID':match?'MATCH':'MISMATCH';
  const string=(value,expected)=>label(typeof value==='string',value===expected);
  const idValid=typeof row.id==='string';
  const eventsValid=Array.isArray(row.enabled_events) && row.enabled_events.every(x=>typeof x==='string');
  return {
    objectType:string(row.object,'webhook_endpoint'),
    endpointIdentity:label(idValid,idValid && row.id===p.endpointId && hash(row.id)===p.endpointSha256),
    sandboxMode:label(typeof row.livemode==='boolean',row.livemode===false),
    url:string(row.url,p.url),
    apiVersion:string(row.api_version,p.apiVersion),
    enabledEvents:label(eventsValid,eventsValid &&
      JSON.stringify([...row.enabled_events].sort())===JSON.stringify(EVENTS)),
    recognizedStatus:label(typeof row.status==='string',['enabled','disabled'].includes(row.status)),
    disabledStatus:string(row.status,'disabled')
  };
}

export function endpoint(value,p,status) {
  const fields=endpointComparison(value,p);
  need(Object.entries(fields).every(([name,result])=>name==='disabledStatus'||result==='MATCH') &&
    (!status||value.status===status),'PAYMENT_ENDPOINT_DRIFT');
  return value;
}

// Single extension to the existing coordinator journal; writes never replace parent state.
export class PaymentJournal {
  constructor(cap,path){this.cap=cap;this.path=path;this.state=null;}
  read(){gate(this.cap,true);return JSON.parse(readFileSync(this.path,'utf8'));}
  load(){const j=this.read();need(j.operationId===this.cap.e.plan.operationId && j.payment?.operationId===j.operationId &&
    j.payment.scopeSha256===hash(this.cap.e.payment),'PAYMENT_JOURNAL_BINDING');this.state=j.payment;return this.state;}
  save(change){const j=this.read();need(j.operationId===this.cap.e.plan.operationId &&
    (this.state===null?j.payment===undefined:hash(j.payment)===hash(this.state)),'PAYMENT_JOURNAL_DRIFT');
    const next={operationId:j.operationId,scopeSha256:hash(this.cap.e.payment),...this.state,...change,revision:(this.state?.revision??0)+1};
    writeFileSync(this.path+'.payment-next',JSON.stringify({...j,payment:next}),{mode:0o600,flag:'wx'});
    renameSync(this.path+'.payment-next',this.path);this.state=next;return next;
  }
}

const paymentFields='operationId,scopeSha256,revision,phase,enableIntent,endpointDisabled,bridgeClosed,outcome,failureCode,endpointCalls,secretReads,residuals';
const exactKeys=(value,fields)=>value && typeof value==='object' && !Array.isArray(value) &&
  Object.keys(value).sort().join(',')===fields.split(',').sort().join(',');
const present=path=>{try{lstatSync(path);return true;}catch(error){if(error.code==='ENOENT')return false;throw error;}};

// Either marker makes this a post-main observation. A missing counterpart must
// never fall back to retrieving a credential that main cleanup already retired.
export function independentPaymentCloseoutPresent(envelopePath) {
  const root=dirname(envelopePath);
  return present(join(root,'work-result.json')) || present(join(root,'independent-closeout.json'));
}

export function paymentReadbackUnconfirmed(journal) {
  const state=journal.state??journal.load();
  need(exactKeys(state,paymentFields) && Array.isArray(state.residuals),'PAYMENT_JOURNAL_SHAPE');
  journal.save({phase:'CLOSEOUT_UNKNOWN',endpointDisabled:false,
    residuals:[...new Set([...state.residuals,'PAYMENT_ENDPOINT_UNCONFIRMED'])].sort()});
}

/** Reuse only the completed main observation; this never claims a new provider read. */
export function completedPaymentCloseout(cap,envelopePath,envelopeDigest) {
  gate(cap,true);
  need(['--readback','--closeout'].includes(cap.mode),'PAYMENT_CLOSEOUT_MODE');
  const root=dirname(envelopePath),operation=cap.e.plan.operationId;
  need(root==='/private/tmp/p08-coordinator-'+operation && envelopePath===join(root,'envelope.json'),
    'PAYMENT_CLOSEOUT_ROOT');
  const stamp=s=>[s.dev,s.ino,s.mode,s.uid,s.nlink,s.size,s.mtimeNs,s.ctimeNs].map(String).join(':');
  const rootStamp=()=>{const s=lstatSync(root,{bigint:true});
    need(s.isDirectory() && !s.isSymbolicLink() && Number(s.mode&0o777n)===0o700 &&
      s.uid===BigInt(process.getuid()) && realpathSync(root)===root,'PAYMENT_CLOSEOUT_CUSTODY');
    // Child marker creation changes directory timestamps; identity and custody are stable.
    return [s.dev,s.ino,s.mode,s.uid].map(String).join(':');};
  const identity=rootStamp(),snapshots=[];
  function read(name){
    const path=join(root,name),s=lstatSync(path,{bigint:true});
    need(s.isFile() && !s.isSymbolicLink() && Number(s.mode&0o777n)===0o600 && s.nlink===1n &&
      s.uid===BigInt(process.getuid()) && s.size<=65536n,'PAYMENT_CLOSEOUT_CUSTODY');
    const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW),buffer=Buffer.alloc(65537);
    try {
      need(stamp(fstatSync(fd,{bigint:true}))===stamp(s),'PAYMENT_CLOSEOUT_CHANGED');
      const used=readSync(fd,buffer,0,buffer.length,0);
      need(used<=65536 && BigInt(used)===s.size && stamp(fstatSync(fd,{bigint:true}))===stamp(s) &&
        stamp(lstatSync(path,{bigint:true}))===stamp(s),'PAYMENT_CLOSEOUT_CHANGED');
      return {value:JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(buffer.subarray(0,used))),stamp:stamp(s),digest:hash(buffer.subarray(0,used))};
    }finally{buffer.fill(0);closeSync(fd);}
  }
  function observe(name){const v=read(name);snapshots.push([name,v.stamp,v.digest]);return v.value;}
  const envelope=observe('envelope.json'),work=observe('work-result.json'),main=observe('closeout.json'),
    independent=observe('independent-closeout.json'),j=observe('journal.json'),p=j.payment;
  need(hash(envelope)===envelopeDigest && hash(envelope.payment)===hash(cap.e.payment) &&
    j.operationId===operation && j.planSha256===hash(cap.e.plan) && j.nativeEntry?.envelopeSha256===envelopeDigest &&
    j.phase==='CLOSED' && j.authAttempted===true,'PAYMENT_CLOSEOUT_BINDING');
  for(const marker of [main,independent])need(exactKeys(marker,'operationId') && marker.operationId===operation,'PAYMENT_CLOSEOUT_MARKER');
  need(exactKeys(work,'status,operationId,liveAuthorization,authProofReady,paymentReadyForAcceptance,paymentObserved,residuals,privateInputsAbsent') &&
    work.status==='ENTRY_AWAITING_INDEPENDENT_CLOSEOUT' && work.operationId===operation && work.liveAuthorization===cap.external &&
    work.authProofReady===false && work.paymentReadyForAcceptance===false && work.privateInputsAbsent===false &&
    typeof work.paymentObserved==='boolean' && Array.isArray(work.residuals) && work.residuals.every(x=>typeof x==='string') &&
    !work.residuals.some(x=>['ACCOUNT_SESSION','PAYMENT_ENDPOINT_UNCONFIRMED','PAYMENT_BRIDGE_UNCONFIRMED','PAYMENT_JOURNAL_UNCONFIRMED'].includes(x)),
    'PAYMENT_MAIN_READBACK_UNCONFIRMED');
  need(exactKeys(p,paymentFields) && p.operationId===operation && p.scopeSha256===hash(cap.e.payment) &&
    Number.isSafeInteger(p.revision) && p.revision>0 && Number.isSafeInteger(p.endpointCalls) && p.endpointCalls>=2 && p.endpointCalls<=14 &&
    Number.isSafeInteger(p.secretReads) && p.secretReads>=1 && p.secretReads<=cap.e.limits.child &&
    p.endpointDisabled===true && p.bridgeClosed===true && Array.isArray(p.residuals) && p.residuals.length===0 &&
    (p.failureCode===null || /^PAYMENT_[A-Z_]{1,48}$/.test(p.failureCode)) &&
    ['NOT_OBSERVED','APPLICATION_SETTLED'].includes(p.outcome) && work.paymentObserved===(p.outcome==='APPLICATION_SETTLED') &&
    ((p.phase==='QUALIFIED' && p.enableIntent===false && p.outcome==='NOT_OBSERVED' && p.failureCode===null) ||
     (p.phase==='CLOSED' && p.enableIntent===true)),'PAYMENT_CLOSEOUT_STATE');
  need(exactKeys(j.nativeEntry.calls,'cli,https,sql,child') && Object.entries(j.nativeEntry.calls).every(([k,v])=>
    Number.isSafeInteger(v) && v>=0 && v<=cap.e.limits[k]),'PAYMENT_CLOSEOUT_COUNTERS');
  const verify=()=>{
    gate(cap,true);need(rootStamp()===identity,'PAYMENT_CLOSEOUT_CHANGED');
    need(!['journal-next.json','journal.json.payment-next','journal.json.auth-next'].some(name=>present(join(root,name))),
      'PAYMENT_UNCOMMITTED_INTENT');
    for(const [name,s,d] of snapshots){const v=read(name);need(v.stamp===s && v.digest===d,'PAYMENT_CLOSEOUT_CHANGED');}
  };
  verify();return verify;
}

export async function readPaymentContext(db,e) {
  await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  try {const r=await db.query(PAYMENT_SQL,[e.target.id,e.plan.tenantId,e.plan.jobId]);
    need(r.rows?.length===1,'PAYMENT_SQL_OUTPUT');const q=paymentContext(r.rows[0].value,e);
    await db.query('COMMIT');return q;
  }catch(error){try{await db.query('ROLLBACK');}catch{}throw error;}
}

export async function closePayment(cap,journal,ports) {
  const state=journal.state??journal.load();
  if(!state.enableIntent)return true;
  try {
    // Independent closeout reads before mutation. No activation or new payment is possible here.
    if(cap.mode==='--run')await ports.endpoint('POST',true,true);
    else {const current=endpoint(await ports.endpoint('GET',null,true),cap.e.payment);
      if(current.status==='disabled'){journal.save({phase:'CLOSED',endpointDisabled:true,residuals:[]});return true;}
      await ports.endpoint('POST',true,true);}
    endpoint(await ports.endpoint('GET',null,true),cap.e.payment,'disabled');
    journal.save({phase:'CLOSED',endpointDisabled:true,residuals:[]});return true;
  }catch {journal.save({phase:'CLOSEOUT_UNKNOWN',endpointDisabled:false,residuals:['PAYMENT_ENDPOINT_UNCONFIRMED']});return false;}
}

export async function runPayment(cap,{db,ports,journal,token,present}) {
  need(cap.e.version===2 && cap.mode==='--run' && !('purpose' in cap.e),'PAYMENT_AUTHORITY');gate(cap);
  const p=cap.e.payment,deadline=Date.parse(p.workEnd);
  need(deadline>Date.now() && deadline<=Date.parse(cap.e.plan.window.workEnd)-60000,'PAYMENT_WORK_DEADLINE');
  journal.load();need(journal.state.phase==='QUALIFIED' && journal.state.enableIntent===false,'PAYMENT_PREFLIGHT_REQUIRED');
  journal.save({phase:'START',endpointDisabled:false,bridgeClosed:false});
  let bridge,finish;
  try {
    const q=await readPaymentContext(db,cap.e);
    endpoint(await ports.endpoint('GET',null,false),p,'disabled');
    journal.save({phase:'ENABLE_INTENT',enableIntent:true});
    endpoint(await ports.endpoint('POST',false,false),p,'enabled');
    endpoint(await ports.endpoint('GET',null,false),p,'enabled');
    const {createOperatorBridge}=await import('./operator_bridge.mjs');
    const closed=new Promise(resolve=>{finish=resolve;});
    bridge=await createOperatorBridge({qualification:q,token,transport:ports.application,deadline,expectedAccount:p.connectedAccountSha256,onClose:()=>finish()});
    journal.save({phase:'ATTENDED'});
    await present(bridge.bootstrapUrl);
    await closed;
    // Application canonical state, not redirect, is the only payment observation.
    const base=cap.e.runtimeOrigin+'/jobs/'+cap.e.plan.jobId;
    if(Date.now()<deadline){
      const responses=await Promise.all([ports.application(base+'/payment-request',{method:'GET',headers:{Authorization:'Bearer '+token}}),
        ports.application(cap.e.runtimeOrigin+'/jobs/dispatch-board/'+cap.e.plan.jobId,{method:'GET',headers:{Authorization:'Bearer '+token}})]);
      const [payment,detail]=await Promise.all(responses.map(async r=>{need(r.ok,'PAYMENT_FINAL_READ');return JSON.parse(await r.text());}));
      need(payment.amountTotalCents===p.amountTotalCents && payment.currency===p.currency && detail.jobId===cap.e.plan.jobId,'PAYMENT_FINAL_SCOPE');
      journal.save({outcome:payment.status==='SUCCEEDED'&&detail.paymentGate?.state==='UNLOCKED'?'APPLICATION_SETTLED':'NOT_OBSERVED'});
    }
  }catch(error) {journal.save({phase:'STOPPED',outcome:'NOT_OBSERVED',failureCode:/^PAYMENT_[A-Z_]{1,48}$/.test(error?.code??'')?error.code:'PAYMENT_ADAPTER_UNKNOWN'});}
  finally {
    if(bridge){try{await bridge.stop();journal.save({bridgeClosed:true});}catch{journal.save({residuals:['PAYMENT_BRIDGE_UNCONFIRMED']});}}
    else journal.save({bridgeClosed:true});
    token='';
    const closed=await closePayment(cap,journal,ports);
    ports.clear();
    need(closed && journal.state.bridgeClosed,'PAYMENT_CONTAINMENT_UNCONFIRMED');
  }
  return journal.state;
}

export function createPaymentPorts(cap,credentials,journal,injected={}) {
  need(cap.e.version===2 && (cap.external || typeof injected.fetcher==='function'),'PAYMENT_TRANSPORT_AUTHORITY');
  const p=cap.e.payment,send=injected.fetcher??fetch;
  let key='',secretAttempted=false,cleared=false;
  const counts={reads:0,creates:0,binds:0,recovers:0};
  async function bounded(url,options,cleanup){
    const until=cleanup?Date.parse(cap.e.plan.window.cleanupEnd):Date.parse(p.workEnd);
    return boundedPaymentResponse(send,url,options,spend=>{gate(cap,cleanup,spend);need(!cleared,'PAYMENT_PORT_CLOSED');},until);
  }
  async function stripeKey(cleanup){
    if(key)return key;
    need(!secretAttempted,'PAYMENT_SECRET_NO_RETRY');secretAttempted=true;
    need(journal.state.secretReads<cap.e.limits.child,'PAYMENT_SECRET_BUDGET');journal.save({secretReads:journal.state.secretReads+1});
    const name=stripeSecretName(cap.e);
    const r=await bounded('https://secretmanager.googleapis.com/v1/'+name+':access',{
      method:'GET',headers:{Authorization:'Bearer '+credentials.accessToken}},cleanup);
    key=await decodeStripeTestSecret(r,name);
    return key;
  }
  return {
    async endpoint(method,disabled,cleanup){
      need(cap.e.purpose!=='NATIVE_AUTH_QUALIFICATION_ONLY' ||
        (method==='GET'&&disabled===null)||(cleanup===true&&method==='POST'&&disabled===true),
        'AUTH_QUALIFICATION_PAYMENT_DENIED');
      need((method==='GET'&&disabled===null)||(method==='POST'&&typeof disabled==='boolean'),'PAYMENT_ENDPOINT_METHOD');
      need(cleanup?method==='GET'||disabled===true:(cap.mode==='--run'||(cap.mode==='--payment-preflight'&&method==='GET')),'PAYMENT_CLEANUP_ONLY');
      gate(cap,cleanup);need(journal.state.endpointCalls<14,'PAYMENT_ENDPOINT_BUDGET');
      if(method==='POST'&&!disabled)need(journal.state.enableIntent===true && journal.state.phase==='ENABLE_INTENT' && journal.state.endpointCalls===2,'PAYMENT_ENABLE_NO_RETRY');
      const secret=await stripeKey(cleanup);
      journal.save({endpointCalls:journal.state.endpointCalls+1});
      const r=await bounded('https://api.stripe.com/v1/webhook_endpoints/'+p.endpointId,{
        method,headers:{Authorization:'Bearer '+secret,'Content-Type':'application/x-www-form-urlencoded','Stripe-Version':p.apiVersion},
        ...(method==='POST'?{body:'disabled='+String(disabled)}:{})},cleanup);
      need(r.ok,'PAYMENT_ENDPOINT_REFUSED');return endpoint(JSON.parse(await r.text()),p);
    },
    async application(url,options){
      need(cap.e.purpose!=='NATIVE_AUTH_QUALIFICATION_ONLY','AUTH_QUALIFICATION_PAYMENT_DENIED');
      gate(cap);need(cap.mode==='--run','PAYMENT_CLEANUP_ONLY');
      const base=cap.e.runtimeOrigin+'/jobs/'+cap.e.plan.jobId;
      const routes=new Map([['GET '+base+'/payment-request','reads'],['GET '+base+'/payment-events','reads'],
        ['GET '+cap.e.runtimeOrigin+'/jobs/dispatch-board/'+cap.e.plan.jobId,'reads'],
        ['POST '+cap.e.runtimeOrigin+'/job-payment-policy/apply','binds'],['POST '+base+'/payment-requests','creates'],
        ['POST '+base+'/payment-request/recover','recovers']]);
      const kind=routes.get(options.method+' '+url);need(kind,'PAYMENT_ROUTE');
      need(++counts[kind]<=({reads:30,creates:2,binds:1,recovers:1})[kind],'PAYMENT_ROUTE_BUDGET');
      const headers={...options.headers};need(typeof headers.Authorization==='string'&&headers.Authorization.startsWith('Bearer '),'PAYMENT_TOKEN');
      if(kind==='creates')headers['Idempotency-Key']=p.requestId;
      return bounded(url,{...options,headers},false);
    },
    clear(){key='';cleared=true;},counts:()=>({...counts})
  };
}


// Local derivation only: raw SQL enters through bounded stdin, never argv or a file.
if(process.argv[1]===fileURLToPath(import.meta.url)){
  const bytes=Buffer.alloc(65537);let used=0;
  try {
    need(process.argv.length===3 && process.argv[2]==='--derive-recovery','PAYMENT_DERIVATION_MODE');
    while(used<bytes.length){const n=readSync(0,bytes,used,bytes.length-used,null);if(!n)break;used+=n;}
    need(used>0 && used<=65536,'PAYMENT_DERIVATION_BOUNDS');
    const input=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes.subarray(0,used)));
    need(Object.keys(input).sort().join(',')==='now,scope,value','PAYMENT_DERIVATION_INPUT');
    process.stdout.write(JSON.stringify(recoveryPaymentBinding(input.value,input.scope,input.now))+'\n');
  }catch {process.stdout.write('{"status":"PAYMENT_BINDING_UNQUALIFIED"}\n');process.exitCode=2;}
  finally{bytes.fill(0);}
}

export async function boundedPaymentResponse(send,url,options,guard,until){
    guard(true);
    need(Date.now()<until,'PAYMENT_DEADLINE');
    const signal=AbortSignal.timeout(Math.max(1,Math.min(5000,until-Date.now())));
    const response=await send(url,{...options,redirect:'error',signal});
    let text;
    if(response.body?.getReader){const reader=response.body.getReader(),chunks=[];let size=0;
      try {while(true){guard(false);need(!signal.aborted,'PAYMENT_IO_TIMEOUT');
        const r=await reader.read();if(r.done)break;size+=r.value.byteLength;need(size<=65536,'PAYMENT_OUTPUT_LIMIT');chunks.push(Buffer.from(r.value));}
        text=new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks));
      }finally{await reader.cancel().catch(()=>{});}
    }else{text=await response.text();need(Buffer.byteLength(text)<=65536,'PAYMENT_OUTPUT_LIMIT');}
    guard(false);need(Date.now()<until && !signal.aborted,'PAYMENT_IO_TIMEOUT');
    return {ok:response.ok,status:response.status,text:async()=>text};
  }

export async function decodeStripeTestSecret(r,name){
  need(r.ok,'PAYMENT_SECRET_REFUSED');const v=JSON.parse(await r.text());
    need(v.name===name && typeof v.payload?.data==='string' && /^[A-Za-z0-9+/]+={0,2}$/.test(v.payload.data),'PAYMENT_SECRET_SHAPE');
    const bytes=Buffer.from(v.payload.data,'base64');
    try {const value=new TextDecoder('utf-8',{fatal:true}).decode(bytes);
      need(/^sk_test_[A-Za-z0-9]{16,256}$/.test(value),'PAYMENT_TEST_KEY_REQUIRED');return value;
    }finally{bytes.fill(0);}
}

export function stripeSecretName(e){
 const pinned=e.resources.secretVersions['signmons-staging-stripe-secret-key'];
 const version=pinned??(e.resources.candidate==='signmons-calldesk-staging-app013p07atomic1'?'1':null);
 need(typeof version==='string'&&/^[1-9][0-9]{0,8}$/.test(version),'PAYMENT_SECRET_VERSION_PIN');
 return 'projects/'+e.plan.projectNumber+'/secrets/signmons-staging-stripe-secret-key/versions/'+version;
}
