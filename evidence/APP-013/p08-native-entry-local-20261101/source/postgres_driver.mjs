import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {authorizeChild} from './authority_bridge.mjs';
import {createPorts} from './transports.mjs';
import {runChild} from './native_child.mjs';
import {fixturePorts} from './fixture_ports.mjs';
import {boundClients} from '../../p08-real-client-binding-local-20261031/source/bound-clients.mjs';
import {authorize,close,planHash} from '../../p08-coordinator-auth-local-20261031/source/authority.mjs';
import {plan as bridgePlan} from '../../p08-authentication-local-20261026/source/reuse/operator-bridge.mjs';
const require=createRequire(new URL('../../../../package.json',import.meta.url));const {Client}=require('pg');
const input=JSON.parse(readFileSync(0,'utf8')),r=input.request;
assert.match(input.cert,/^\/private\/tmp\/p08-pg-[\w-]+\/server\.crt$/);
const e=JSON.parse(readFileSync(r.envelopePath));assert.equal(e.database.host,'127.0.0.1');
const injected={...fixturePorts(r),ClientClass:Client,ssl:{ca:readFileSync(input.cert,'utf8'),rejectUnauthorized:true}};
// Fault only the primary connection. Cleanup independently uses the fixture's trusted TLS CA.
const probeSsl=injected.ssl;
injected.ClientClass=class extends Client {
  constructor(config){super({...config,ssl:config.application_name.startsWith('p08-probe-')?probeSsl:config.ssl});}
};
if(input.scenario==='positive'){
  const result=await runChild('--run',r,injected);
  assert.equal(result.status,'P08_COORDINATOR_AUTHENTICATED_AND_CLOSED');assert.equal(result.sessionClosed,true);
}else{
  const outer=authorizeChild(r.envelopePath,'--run'),p=e.plan;
  if(input.scenario==='cleartext')injected.ssl=false;
  if(input.scenario==='untrusted')injected.ssl={rejectUnauthorized:true};
  const local=authorize(p,{decision:'APPROVE_LOCAL_SINGLE_COORDINATOR',externalActionAuthorized:false,
    operationId:p.operationId,planSha256:planHash(p)},{target:e.target,receipt:r.receipt,
    runtime:{origin:bridgePlan.origin,jobId:p.jobId,tenantId:p.tenantId,revocationRequired:true,devAuthEnabled:false,
      identityQualified:true,restorationApproved:true,serviceAccount:p.runtimeIdentity},
    journalPath:r.envelopePath.replace('envelope.json','journal.json'),now:()=>Math.floor(Date.now()/1000)*1000});
  const binding={operationId:p.operationId,planSha256:planHash(p),project:p.project,tenantId:p.tenantId,
    jobId:p.jobId,targetId:e.target.id,database:e.database};
  let extra;
  try{
    const ports=createPorts(outer,r.credentials,injected);
    const run=()=>boundClients(local,{binding,secret:{password:r.credentials.password},...ports});
    if(input.scenario==='cleartext')await assert.rejects(run,{code:'TLS_REQUIRED'});
    if(input.scenario==='untrusted')await assert.rejects(run,e=>['DEPTH_ZERO_SELF_SIGNED_CERT','SELF_SIGNED_CERT_IN_CHAIN'].includes(e.code));
    if(input.scenario==='tenant')await assert.rejects(run,{code:'DATABASE_PREFLIGHT'});
    if(input.scenario==='residual'){
      const clients=await run();
      extra=new Client({...e.database,ssl:injected.ssl,application_name:'p08-runtime-'+p.operationId});await extra.connect();
      await assert.rejects(()=>clients.close(),{code:'SESSIONS_REMAIN'});clients.clear();await extra.end();extra=null;
    }
  }finally{if(extra)await extra.end();close(local);}
}
process.stdout.write('{"status":"PASS","providerCalls":0}\n');
