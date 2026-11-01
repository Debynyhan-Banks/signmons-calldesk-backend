import {readFileSync,readSync,writeFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {authorizeChild,gate,need,hash as hashEnvelope} from './authority_bridge.mjs';
import {createPorts} from './transports.mjs';
import {authorize,close,planHash,exactApp,exactIdentity} from '../../p08-coordinator-auth-local-20261031/source/authority.mjs';
import {boundClients} from '../../p08-real-client-binding-local-20261031/source/bound-clients.mjs';
import {CoordinatorAuthSequence} from '../../p08-real-client-binding-local-20261031/source/recovery-sequence.mjs';
import {plan as bridgePlan} from '../../p08-authentication-local-20261026/source/reuse/operator-bridge.mjs';

export async function runChild(mode, request, injected = {}) {
  need(request && Object.keys(request).sort().join(',')==='childCall,credentials,envelopePath,receipt','CHILD_INPUT');
  const outer=authorizeChild(request.envelopePath,mode),e=outer.e,p=e.plan;
  gate(outer,true);
  const runtime={origin:bridgePlan.origin,jobId:p.jobId,tenantId:p.tenantId,revocationRequired:true,
    devAuthEnabled:false,identityQualified:true,restorationApproved:true,serviceAccount:p.runtimeIdentity};
  // Origin comes from the already source-locked historical bridge, never an input URL.
  const envelopeDigest=hashEnvelope(e);
  outer.e.runtimeOrigin=runtime.origin;
  const journalPath=request.envelopePath.replace(/envelope\.json$/,'journal.json');
  const initial=JSON.parse(readFileSync(journalPath));
  need(initial.nativeEntry?.envelopeSha256===envelopeDigest &&
    Number.isInteger(request.childCall) && request.childCall>=1 && request.childCall<=e.limits.child &&
    initial.nativeEntry.calls.child===request.childCall,'CHILD_RESERVATION');
  writeFileSync(request.envelopePath.replace(/envelope\.json$/,`child-${request.childCall}.json`),
    JSON.stringify({operationId:p.operationId,mode}),{mode:0o600,flag:'wx'});
  const approval={decision:'APPROVE_LOCAL_SINGLE_COORDINATOR',externalActionAuthorized:false,
    operationId:p.operationId,planSha256:planHash(p)};
  const now=()=>Math.floor(Date.now()/1000)*1000; // provider revocation timestamps have second precision
  const cap=authorize(p,approval,{target:e.target,receipt:request.receipt,runtime,journalPath,now,
    mode:mode==='--run'?'run':'closeout'});
  const credentials=request.credentials,secret={password:credentials.password};
  let clients, closeAttempted=false;
  try {
    const ports=createPorts(outer,credentials,injected);
    const binding={operationId:p.operationId,planSha256:planHash(p),project:p.project,
      tenantId:p.tenantId,jobId:p.jobId,targetId:e.target.id,database:e.database};
    clients=await boundClients(cap,{binding,secret,...ports,now});
    const originalClose=clients.close.bind(clients);
    clients.close=async()=>{closeAttempted=true;return originalClose();};
    const journal=JSON.parse(readFileSync(journalPath));
    if(mode==='--readback' || (mode==='--closeout' && journal.authClient?.phase==='CLOSEOUT_FINISHED')) {
      const app=exactApp(await clients.db.get(),e.target,'DISABLED');
      const firebase=exactIdentity(await clients.fb.get(),e.target,true);
      const intent=Date.parse(journal.authClient?.revocationIntentAt ?? '');
      need(Number.isFinite(intent) && Date.parse(firebase.tokensValidAfterTime)>=intent,'REVOCATION_READBACK');
      if(journal.authClient?.activatedVersion)need(app.updatedAt===journal.authClient.disabledVersion,'APP_VERSION_DRIFT');
      await clients.close();
      if(mode==='--readback')return {app,firebase,sessions:0};
      need(journal.authClient.sessionClosed===true && journal.authClient.residuals.length===0,'PRIOR_CLOSEOUT_UNCONFIRMED');
      return {status:'P08_COORDINATOR_AUTH_CLEANUP_VERIFIED',authenticated:journal.authClient.authenticated,
        residuals:[],sessionClosed:true,liveAuthorization:false,authProofReady:false};
    }
    const sequence=new CoordinatorAuthSequence(cap,clients);
    return mode==='--run'?await sequence.run():await sequence.closeout(true);
  } finally {
    if(clients&&!closeAttempted){try{await clients.close();}catch{}}
    clients?.clear(); secret.password=''; credentials.password='';credentials.accessToken='';close(cap);
  }
}

async function main() {
  const buffer=Buffer.alloc(131073);let used=0;
  while(used<buffer.length){const n=readSync(0,buffer,used,buffer.length-used,null);if(!n)break;used+=n;}
  need(used>0&&used<=131072,'CHILD_INPUT_BOUNDS');
  const request=JSON.parse(buffer.subarray(0,used).toString('utf8'));buffer.fill(0);
  const result=await runChild(process.argv[2],request);
  process.stdout.write(JSON.stringify(result)+'\n');
}
if(process.argv[1]===fileURLToPath(import.meta.url))main().catch(()=>{
  process.stdout.write('{"status":"NATIVE_CHILD_REFUSED_OR_UNCONFIRMED"}\n');process.exitCode=2;
});
