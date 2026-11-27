import {readFileSync,readSync,writeFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {authorizeChild,gate,need,hash as hashEnvelope} from './authority_bridge.mjs';
import {createPorts} from './transports.mjs';
import {authorize,close,planHash,exactApp,exactIdentity} from '../../p08-coordinator-auth-local-20261031/source/authority.mjs';
import {boundClients} from '../../p08-real-client-binding-local-20261031/source/bound-clients.mjs';
import {CoordinatorAuthSequence} from '../../p08-real-client-binding-local-20261031/source/recovery-sequence.mjs';
import {plan as bridgePlan} from '../../p08-authentication-local-20261026/source/reuse/operator-bridge.mjs';

export const CHILD_FAILURE_STAGES=Object.freeze(['INPUT','AUTHORITY','RESERVATION','PAYMENT_PREFLIGHT',
  'CLIENT_BINDING','AUTH_SEQUENCE','READBACK','CLOSEOUT','RESULT','UNKNOWN']);
export const CHILD_FAILURE_CODES=Object.freeze(['UNCLASSIFIED','CHILD_INPUT','CHILD_INPUT_BOUNDS','CHILD_MODE',
  'ENVELOPE_BOUNDS','CHILD_OUTER_BINDING','ENVELOPE_CHANGED','OUTER_CAPABILITY_REQUIRED','OUTER_DEADLINE',
  'CLOCK_ROLLBACK','CLOSEOUT_ONLY','CHILD_CALL_LIMIT','CHILD_RESERVATION','EEXIST','SOURCE_DRIFT',
  'SOURCE_CONTRACT','EXTRACTION_DRIFT','LOCAL_ONLY','BUSINESS_SCOPE','LOCAL_APPROVAL','TARGET_SCOPE',
  'OWNED_KEY_SCOPE','MODE','JOURNAL_PATH','JOURNAL_PRIVATE','JOURNAL_OWNERSHIP','RUNTIME_SCOPE',
  'WINDOW_FORMAT','WINDOW_ORDER','CLOCK_OR_SIGNAL','START_CUTOFF','CAPABILITY_REQUIRED','OPERATION_DEADLINE',
  'INTERRUPTED','NATIVE_REQUIRES_EXTERNAL_AUTHORITY','MEMORY_CREDENTIALS','PRIVATE_BINDING_SCOPE',
  'INJECTED_CLIENTS_REQUIRED','OWNER_SCOPE','OWNER_DRIFT','OWNER_OVERRIDE','OWNER_AUTHORITY_DRIFT',
  'DATABASE_SCOPE','DATABASE_CLIENT_REQUIRED','TLS_REQUIRED','DATABASE_PREFLIGHT','DATABASE_SESSION_UNCONFIRMED',
  'NATIVE_IO_TIMEOUT','SESSIONS_REMAIN','SESSION_CLOSEOUT_RESERVED','SESSION_SCOPE','PROBE_TLS','SESSION_OUTPUT',
  'CLIENT_CONTRACT','JOURNAL_CONCURRENT_DRIFT','AUTH_JOURNAL_REQUIRED','CLOSEOUT_RESERVED','REVOCATION_READBACK',
  'APP_VERSION_DRIFT','PRIOR_CLOSEOUT_UNCONFIRMED','APPLICATION_DRIFT','IDENTITY_DRIFT','CLAIMS_DRIFT',
  'PAYMENT_PREFLIGHT_VERSION','PAYMENT_SECRET_REFUSED','PAYMENT_SECRET_SHAPE','PAYMENT_TEST_KEY_REQUIRED',
  'PAYMENT_SECRET_NO_RETRY','PAYMENT_SECRET_BUDGET','PAYMENT_ENDPOINT_REFUSED','PAYMENT_ENDPOINT_DRIFT',
  'PAYMENT_OUTPUT_LIMIT','PAYMENT_IO_TIMEOUT','PAYMENT_DEADLINE','PAYMENT_PORT_CLOSED',
  'PAYMENT_ENDPOINT_UNCONFIRMED','PAYMENT_PROOF_PRESENTER_REQUIRED','CHILD_RESULT']);
// Only this module can assign a boundary. Provider error properties cannot forge one.
const failureStages=new WeakMap();
function tagged(error,stage){
  const value=error && (typeof error==='object'||typeof error==='function') ? error : new Error('UNCLASSIFIED');
  if(!failureStages.has(value))failureStages.set(value,stage);
  return value;
}
export function childRefusal(error){
  const object=error && (typeof error==='object'||typeof error==='function');
  const stage=object?failureStages.get(error):undefined;
  // Read data only; a provider-defined getter is not part of the refusal contract.
  let code;try{code=object?Object.getOwnPropertyDescriptor(error,'code')?.value:undefined;}catch{}
  return {status:'NATIVE_CHILD_REFUSED_OR_UNCONFIRMED',
    stage:CHILD_FAILURE_STAGES.includes(stage)?stage:'UNKNOWN',
    code:CHILD_FAILURE_CODES.includes(code)?code:'UNCLASSIFIED'};
}

export async function runChild(mode,request,injected={}){
  const context={stage:'INPUT'};
  try{return await runChildAtBoundary(mode,request,injected,context);}
  catch(error){throw tagged(error,context.stage);}
}

async function runChildAtBoundary(mode, request, injected, context) {
  need(request && Object.keys(request).sort().join(',')==='childCall,credentials,envelopePath,receipt','CHILD_INPUT');
  context.stage='AUTHORITY';
  const outer=authorizeChild(request.envelopePath,mode),e=outer.e,p=e.plan;
  gate(outer,true);
  const runtime={origin:bridgePlan.origin,jobId:p.jobId,tenantId:p.tenantId,revocationRequired:true,
    devAuthEnabled:false,identityQualified:true,restorationApproved:true,serviceAccount:p.runtimeIdentity};
  // Origin comes from the already source-locked historical bridge, never an input URL.
  const envelopeDigest=hashEnvelope(e);
  outer.e.runtimeOrigin=runtime.origin;
  context.stage='RESERVATION';
  const journalPath=request.envelopePath.replace(/envelope\.json$/,'journal.json');
  const initial=JSON.parse(readFileSync(journalPath));
  need(initial.nativeEntry?.envelopeSha256===envelopeDigest &&
    Number.isInteger(request.childCall) && request.childCall>=1 && request.childCall<=e.limits.child &&
    initial.nativeEntry.calls.child===request.childCall,'CHILD_RESERVATION');
  writeFileSync(request.envelopePath.replace(/envelope\.json$/,`child-${request.childCall}.json`),
    JSON.stringify({operationId:p.operationId,mode}),{mode:0o600,flag:'wx'});
  if(mode==='--payment-preflight'){
    context.stage='PAYMENT_PREFLIGHT';
    need(e.version===2,'PAYMENT_PREFLIGHT_VERSION');
    const payment=await import('./connected_payment.mjs');
    const journal=new payment.PaymentJournal(outer,journalPath);
    journal.save({phase:'PREFLIGHT',enableIntent:false,endpointDisabled:false,bridgeClosed:true,
      outcome:'NOT_OBSERVED',failureCode:null,endpointCalls:0,secretReads:0,residuals:[]});
    const ports=payment.createPaymentPorts(outer,request.credentials,journal,injected);
    let primary=false;
    try {payment.endpoint(await ports.endpoint('GET',null,false),e.payment,'disabled');
      journal.save({phase:'QUALIFIED',endpointDisabled:true});
      return {status:'PAYMENT_PREFLIGHT_QUALIFIED',qualified:true};
    }catch(error){
      primary=true;
      // Persist only fixed codes, never provider bodies, credential values or exception text.
      const allowed=new Set(['PAYMENT_SECRET_REFUSED','PAYMENT_SECRET_SHAPE','PAYMENT_TEST_KEY_REQUIRED',
        'PAYMENT_SECRET_NO_RETRY','PAYMENT_SECRET_BUDGET','PAYMENT_ENDPOINT_REFUSED','PAYMENT_ENDPOINT_DRIFT',
        'PAYMENT_OUTPUT_LIMIT','PAYMENT_IO_TIMEOUT','PAYMENT_DEADLINE','PAYMENT_PORT_CLOSED',
        'OUTER_DEADLINE','CLOCK_ROLLBACK','CHILD_CALL_LIMIT']);
      const code=allowed.has(error?.code)?error.code:'PAYMENT_PREFLIGHT_UNCLASSIFIED';
      try{journal.save({phase:'STOPPED',failureCode:code.startsWith('PAYMENT_')?code:'PAYMENT_PREFLIGHT_BOUNDARY'});}catch{}
      throw tagged(error,context.stage);
    }finally{
      try{ports.clear();}catch(error){if(!primary)throw tagged(error,'CLOSEOUT');}
      finally{request.credentials.password='';request.credentials.accessToken='';}
    }
  }
  context.stage='AUTHORITY';
  const approval={decision:'APPROVE_LOCAL_SINGLE_COORDINATOR',externalActionAuthorized:false,
    operationId:p.operationId,planSha256:planHash(p)};
  const now=()=>Math.floor(Date.now()/1000)*1000; // provider revocation timestamps have second precision
  const cap=authorize(p,approval,{target:e.target,receipt:request.receipt,runtime,journalPath,now,
    mode:mode==='--run'?'run':'closeout'});
  context.stage='CLIENT_BINDING';
  const credentials=request.credentials,secret={password:credentials.password};
  let clients, paymentPorts, paymentJournal, verifyPaymentCloseout, payment, closeAttempted=false,paymentReadbackFailed=false,primary=false;
  const paymentUnconfirmed=()=>{paymentReadbackFailed=true;try{payment.paymentReadbackUnconfirmed(paymentJournal);}catch{}};
  try {
    context.stage='CLIENT_BINDING';
    const ports=createPorts(outer,credentials,injected);
    let paymentDb;
    if(e.version===2){
      const originalFactory=ports.dbFactory;
      ports.dbFactory=async(...args)=>{paymentDb=await originalFactory(...args);return paymentDb;};
      payment=await import('./connected_payment.mjs');
      paymentJournal=new payment.PaymentJournal(outer,journalPath);
      paymentPorts=payment.createPaymentPorts(outer,credentials,paymentJournal,injected);
      if(mode!=='--run'){
        context.stage=mode==='--readback'?'READBACK':'CLOSEOUT';
        // Main account readback still verifies the endpoint before secret retirement.
        // The independent process may reuse that completed observation, with fresh
        // account/session reads, only while every bound receipt remains unchanged.
        try {
          if(payment.independentPaymentCloseoutPresent(request.envelopePath))
            verifyPaymentCloseout=payment.completedPaymentCloseout(outer,request.envelopePath,envelopeDigest);
          else {
            paymentJournal.load();
            if(mode==='--readback')payment.endpoint(await paymentPorts.endpoint('GET',null,true),e.payment,'disabled');
            else if(!await payment.closePayment(outer,paymentJournal,paymentPorts))paymentUnconfirmed();
          }
        }catch{paymentUnconfirmed();}
      }
    }
    const binding={operationId:p.operationId,planSha256:planHash(p),project:p.project,
      tenantId:p.tenantId,jobId:p.jobId,targetId:e.target.id,database:e.database};
    context.stage='CLIENT_BINDING';
    clients=await boundClients(cap,{binding,secret,...ports,now});
    const originalClose=clients.close.bind(clients);
    clients.close=async()=>{closeAttempted=true;return originalClose();};
    const journal=JSON.parse(readFileSync(journalPath));
    if(mode==='--readback' || (mode==='--closeout' && journal.authClient?.phase==='CLOSEOUT_FINISHED')) {
      context.stage=mode==='--readback'?'READBACK':'CLOSEOUT';
      const app=exactApp(await clients.db.get(),e.target,'DISABLED');
      const firebase=exactIdentity(await clients.fb.get(),e.target,true);
      const intent=Date.parse(journal.authClient?.revocationIntentAt ?? '');
      need(Number.isFinite(intent) && Date.parse(firebase.tokensValidAfterTime)>=intent,'REVOCATION_READBACK');
      if(journal.authClient?.activatedVersion)need(app.updatedAt===journal.authClient.disabledVersion,'APP_VERSION_DRIFT');
      context.stage='CLOSEOUT';
      await clients.close();
      if(mode==='--readback')return {app,firebase,sessions:0};
      need(journal.authClient.sessionClosed===true && journal.authClient.residuals.length===0,'PRIOR_CLOSEOUT_UNCONFIRMED');
      return {status:'P08_COORDINATOR_AUTH_CLEANUP_VERIFIED',authenticated:journal.authClient.authenticated,
        residuals:[],sessionClosed:true,liveAuthorization:false,authProofReady:false};
    }
    let afterAuthentication;
    if(e.version===2 && mode==='--run'){
      afterAuthentication=async token=>{
        const {runPayment}=await import('./connected_payment.mjs');
        const present=injected.present ?? (async bootstrapUrl=>{
          need(outer.external,'PAYMENT_PROOF_PRESENTER_REQUIRED');
          writeFileSync(request.envelopePath.replace(/envelope\.json$/,'payment-bootstrap.json'),
            JSON.stringify({operationId:p.operationId,bootstrapUrl}),{mode:0o600,flag:'wx'});
        });
        return runPayment(outer,{db:paymentDb,ports:paymentPorts,journal:paymentJournal,token,present});
      };
    }
    context.stage=mode==='--run'?'AUTH_SEQUENCE':'CLOSEOUT';
    const sequence=new CoordinatorAuthSequence(cap,clients,{afterAuthentication});
    return mode==='--run'?await sequence.run():await sequence.closeout(true);
  } catch(error) {
    primary=true;
    throw tagged(error,context.stage);
  } finally {
    let cleanupError,cleanupFailed=false;
    const failed=error=>{if(!cleanupFailed){cleanupError=error;cleanupFailed=true;}};
    if(clients&&!closeAttempted){try{await clients.close();}catch(error){failed(error);}}
    if(verifyPaymentCloseout){try{verifyPaymentCloseout();}catch{paymentUnconfirmed();}}
    try{paymentPorts?.clear();}catch(error){failed(error);}
    try{clients?.clear();}catch(error){failed(error);}
    secret.password=''; credentials.password='';credentials.accessToken='';
    try{close(cap);}catch(error){failed(error);}
    // A failed evidence write must not turn a bad proof into successful output.
    // Preserve the primary boundary if independent cleanup also refuses.
    if(!primary){
      try{need(!paymentReadbackFailed,'PAYMENT_ENDPOINT_UNCONFIRMED');}catch(error){throw tagged(error,'CLOSEOUT');}
      if(cleanupFailed)throw tagged(cleanupError,'CLOSEOUT');
    }
  }
}

export function readChildRequest(){
  const buffer=Buffer.alloc(131073);let used=0;
  try{
    while(used<buffer.length){const n=readSync(0,buffer,used,buffer.length-used,null);if(!n)break;used+=n;}
    need(used>0&&used<=131072,'CHILD_INPUT_BOUNDS');
    return JSON.parse(buffer.subarray(0,used).toString('utf8'));
  }catch(error){throw tagged(error,'INPUT');}
  finally{buffer.fill(0);}
}
export function serializeChildResult(result){
  try{const value=JSON.stringify(result);need(typeof value==='string','CHILD_RESULT');return value+'\n';}
  catch(error){throw tagged(error,'RESULT');}
}
async function main() {
  const result=await runChild(process.argv[2],readChildRequest());
  process.stdout.write(serializeChildResult(result));
}
if(process.argv[1]===fileURLToPath(import.meta.url))main().catch(error=>{
  process.stdout.write(JSON.stringify(childRefusal(error))+'\n');process.exitCode=2;
});
