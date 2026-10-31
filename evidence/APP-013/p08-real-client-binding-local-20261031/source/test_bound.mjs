import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash, randomUUID} from 'node:crypto';
import {readFileSync, writeFileSync, mkdirSync, chmodSync, rmSync} from 'node:fs';
import {authorize, close, hash, planHash} from '../../p08-coordinator-auth-local-20261031/source/authority.mjs';
import {boundClients, PREFLIGHT_SQL, native} from './bound-clients.mjs';
import {CoordinatorAuthSequence} from './recovery-sequence.mjs';
import {SQL} from '../../p08-coordinator-auth-local-20261031/source/client.mjs';
import {plan as bridgePlan} from '../../p08-authentication-local-20261026/source/reuse/operator-bridge.mjs';

const TARGET = {id: '10000000-0000-4000-8000-000000000001', tenantId: bridgePlan.tenantId,
  email: 'debynyhan@signmons.com', fullName: 'Signmons Test Administrator', role: 'ADMIN'};
const iso = n => new Date(n).toISOString().replace('.000', '');
function fixture(t) {
  const op = randomUUID(), base = Math.floor(Date.now()/1000)*1000;
  const clock = {value: base+1000};
  const plan = {mode: 'LOCAL_INTEGRATED_PACKET_ONLY', externalActionAuthorized: false,
    automaticRetryAllowed: false, allowanceUsd: 0, serviceRetention: 'RETAIN_ENABLED_AFTER_KEY_DELETE',
    project: 'signmons', projectNumber: '123456789012', projectNumberSha256: hash('123456789012'),
    operationId: op, tenantId: TARGET.tenantId, jobId: bridgePlan.jobId,
    ownerPrincipal: TARGET.email,
    runtimeIdentity: 'signmons-calldesk-p07-runtime@signmons.iam.gserviceaccount.com',
    keyId: 'signmons-p08-' + op.replaceAll('-', ''),
    window: {start: iso(base), cutoff: iso(base+10000), workEnd: iso(base+30000),
      cleanupEnd: iso(base+45000), purgeEnd: iso(base+50000)}};
  const approval = {decision:'APPROVE_LOCAL_SINGLE_COORDINATOR',externalActionAuthorized:false,
    operationId:op,planSha256:planHash(plan)};
  const receipt = {operationId:op,keyResource:`projects/${plan.projectNumber}/locations/global/keys/${plan.keyId}`,
    uid:'synthetic-uid',etag:'synthetic-etag',displayName:`Signmons P08 ${op}`,
    restrictions:{apiTargets:[{service:'identitytoolkit.googleapis.com'}]},
    keyStringSha256:hash('synthetic-key'),createdInOperation:true,deleted:false,ownedAt:iso(base)};
  const runtime = {origin:bridgePlan.origin,jobId:plan.jobId,tenantId:plan.tenantId,
    revocationRequired:true,devAuthEnabled:false,identityQualified:true,
    restorationApproved:true,serviceAccount:plan.runtimeIdentity};
  const root = `/private/tmp/p08-coordinator-${op}`;mkdirSync(root,{mode:0o700});chmodSync(root,0o700);
  const journalPath = root+'/journal.json';
  writeFileSync(journalPath,JSON.stringify({operationId:op,planSha256:planHash(plan),
    phase:'PREFLIGHT',authAttempted:true,keyCreateAttempted:true,keyUidSha256:hash(receipt.uid),
    keyDeleteAttempted:false,authProofAccepted:false}),{mode:0o600,flag:'wx'});
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  const cap = authorize(plan,approval,{target:TARGET,receipt,runtime,journalPath,now:()=>clock.value});
  t.after(()=>close(cap));
  const binding = {operationId:op,planSha256:planHash(plan),project:plan.project,
    tenantId:plan.tenantId,jobId:plan.jobId,targetId:TARGET.id,
    database:{host:'fixture.invalid',port:5432,database:'fixture_child',user:'fixture_admin'}};
  return {cap,plan,approval,receipt,runtime,journalPath,clock,binding};
}
function ports(f, overrides={}) {
  const row={...TARGET,status:'DISABLED',updatedAt:'2026-01-01T00:00:00.000Z'};
  const state={row,open:false,queries:[],ends:0,probe:0};
  const dbFactory=async()=>({connection:{stream:{encrypted:true,authorized:true}},
    async connect(){state.open=true;},async end(){state.open=false;state.ends++;},
    async query(sql,args){state.queries.push([sql,args]);
      if(sql===PREFLIGHT_SQL)return {rows:[{database:'fixture_child',username:'fixture_admin',status:'ACTIVE'}]};
      if(sql===SQL.get)return {rows:[{...state.row}],rowCount:1};
      if(sql===SQL.activate){state.row={...state.row,status:'ACTIVE',updatedAt:'2026-01-01T00:00:01.000Z'};return {rows:[{...state.row}],rowCount:1};}
      if(sql===SQL.disable){state.row={...state.row,status:'DISABLED',updatedAt:'2026-01-01T00:00:02.000Z'};return {rows:[{...state.row}],rowCount:1};}
      throw Error('UNLISTED_SQL');}});
  const ownerAuth=async()=>({principal:f.plan.ownerPrincipal,impersonationOverride:false,
    credentialOverride:false,accessToken:'SYNTHETIC_OWNER_OAUTH_TOKEN'});
  const fetcher=async()=>{throw Error('NO_PROVIDER_ACTION_IN_BINDING_TEST')};
  const sessionProbe=async()=>{state.probe++;return Number(state.open)};
  return {state,dbFactory,ownerAuth,fetcher,sessionProbe,...overrides};
}

test('private binding, owner, TLS, database preflight and session probe are required',async t=>{
  const f=fixture(t),p=ports(f),secret={password:'SYNTHETIC_HIDDEN_PASSWORD'};
  const clients=await boundClients(f.cap,{binding:f.binding,secret,...p});
  assert.equal((await clients.db.get()).status,'DISABLED');
  assert.equal(await clients.close(),true);
  assert.equal(secret.password,'');
  assert.equal(p.state.probe,1);
  assert.equal(p.state.open,false);
  assert.ok(p.state.queries.some(x=>x[0]===PREFLIGHT_SQL));
  assert.throws(()=>native(),{code:'P08_REAL_CLIENT_BINDING_NATIVE_DISABLED'});
});

test('wrong binding, missing transports and credentials refuse before owner or database call',async t=>{
  const f=fixture(t);let calls=0;
  const p=ports(f,{ownerAuth:async()=>{calls++;throw Error('MUST_NOT_CALL')}});
  for(const binding of [{...f.binding,jobId:randomUUID()},
    {...f.binding,targetId:randomUUID()},
    {...f.binding,planSha256:'0'.repeat(64)},
    {...f.binding,database:{...f.binding.database,port:0}}])
    await assert.rejects(()=>boundClients(f.cap,{binding,secret:{password:'synthetic'},...p}),
      {code:'PRIVATE_BINDING_SCOPE'});
  await assert.rejects(()=>boundClients(f.cap,{binding:f.binding,secret:{password:''},...p}),
    {code:'INJECTED_CLIENTS_REQUIRED'});
  assert.equal(calls,0);
});

test('owner override, TLS, tenant and session disagreements fail closed',async t=>{
  const f=fixture(t);
  const badOwner=ports(f,{ownerAuth:async()=>({principal:f.plan.ownerPrincipal,
    impersonationOverride:true,credentialOverride:false,accessToken:'SYNTHETIC_OWNER_OAUTH_TOKEN'})});
  await assert.rejects(()=>boundClients(f.cap,{binding:f.binding,secret:{password:'x'},...badOwner}),
    {code:'OWNER_AUTHORITY_DRIFT'});
  const badTls=ports(f,{dbFactory:async()=>({connection:{stream:{encrypted:false,authorized:false}},
    async connect(){},async end(){},async query(){throw Error('MUST_NOT_QUERY')}})});
  await assert.rejects(()=>boundClients(f.cap,{binding:f.binding,secret:{password:'x'},...badTls}),
    {code:'TLS_REQUIRED'});
  const badTenant=ports(f,{dbFactory:async()=>({connection:{stream:{encrypted:true,authorized:true}},
    async connect(){},async end(){},async query(){return {rows:[{database:'fixture_child',username:'fixture_admin',status:'SUSPENDED'}]}}})});
  await assert.rejects(()=>boundClients(f.cap,{binding:f.binding,secret:{password:'x'},...badTenant}),
    {code:'DATABASE_PREFLIGHT'});
  const session=ports(f,{sessionProbe:async()=>1});
  const clients=await boundClients(f.cap,{binding:f.binding,secret:{password:'x'},...session});
  await assert.rejects(()=>clients.close(),{code:'SESSIONS_REMAIN'});
});

test('interrupted closeout intent reconciles current state without reissuing a token',async t=>{
  const f=fixture(t),p=ports(f);const j=JSON.parse(readFileSync(f.journalPath));
  j.authClient={operationId:f.plan.operationId,version:8,phase:'CLOSEOUT_INTENT',
    activationIntent:true,firebaseEnableIntent:true,tokenIssueIntent:true,authenticated:true,
    closeoutAttempted:true,activatedVersion:'2026-01-01T00:00:01.000Z',disabledVersion:null,
    revocationIntentAt:iso(f.clock.value),residuals:[]};
  writeFileSync(f.journalPath,JSON.stringify(j));
  p.state.row={...p.state.row,status:'ACTIVE',updatedAt:j.authClient.activatedVersion};
  const fb={disabled:false,validSince:0};let tokenCalls=0;
  const fetcher=async(url,opts)=>{
    const body=opts.body?JSON.parse(opts.body):null;let value;
    if(url.endsWith('/accounts:lookup'))value={users:[{localId:TARGET.id,email:TARGET.email,
      displayName:TARGET.fullName,disabled:fb.disabled,emailVerified:false,
      customAttributes:JSON.stringify({tenantId:TARGET.tenantId,role:'admin',testOnly:true}),
      validSince:String(fb.validSince)}]};
    else if(url.endsWith('/accounts:update')){
      if('disableUser' in body)fb.disabled=body.disableUser;
      if('validSince' in body)fb.validSince=body.validSince;
      value={localId:TARGET.id};
    }else{tokenCalls++;throw Error('TOKEN_OR_JOB_NOT_ALLOWED_IN_CLEANUP')}
    return {ok:true,text:async()=>JSON.stringify(value)};
  };
  const clients=await boundClients(f.cap,{binding:f.binding,secret:{password:'x'},...p,fetcher,
    now:()=>f.clock.value});
  const result=await new CoordinatorAuthSequence(f.cap,clients).closeout(true);
  assert.equal(result.status,'P08_COORDINATOR_AUTHENTICATED_AND_CLOSED');
  assert.deepEqual(result.residuals,[]);assert.equal(p.state.row.status,'DISABLED');
  assert.equal(fb.disabled,true);assert.ok(fb.validSince>0);assert.equal(tokenCalls,0);
  assert.equal(p.state.probe,1);
});

test('unknown activation version and late cleanup refuse success',async t=>{
  const f=fixture(t),p=ports(f),j=JSON.parse(readFileSync(f.journalPath));
  j.authClient={operationId:f.plan.operationId,version:2,phase:'CLOSEOUT_INTENT',
    activationIntent:true,firebaseEnableIntent:false,tokenIssueIntent:false,authenticated:false,
    closeoutAttempted:true,activatedVersion:null,disabledVersion:null,
    revocationIntentAt:iso(f.clock.value),residuals:[]};
  writeFileSync(f.journalPath,JSON.stringify(j));
  const clients=await boundClients(f.cap,{binding:f.binding,secret:{password:'x'},...p});
  const result=await new CoordinatorAuthSequence(f.cap,clients).closeout(true);
  assert.equal(result.status,'P08_COORDINATOR_AUTH_CONTAINMENT_UNCONFIRMED');
  assert.ok(result.residuals.includes('ACTIVATION_OUTCOME_UNKNOWN'));
  f.clock.value=Date.parse(f.plan.window.cleanupEnd);
  await assert.rejects(()=>boundClients(f.cap,{binding:f.binding,secret:{password:'x'},...ports(f)}),
    {code:'OPERATION_DEADLINE'});
});

test('foreign Firebase identity never receives cleanup mutation',async t=>{
  const f=fixture(t),p=ports(f),j=JSON.parse(readFileSync(f.journalPath));
  j.authClient={operationId:f.plan.operationId,version:5,phase:'CLOSEOUT_INTENT',
    activationIntent:false,firebaseEnableIntent:true,tokenIssueIntent:false,authenticated:false,
    closeoutAttempted:true,activatedVersion:null,disabledVersion:null,
    revocationIntentAt:iso(f.clock.value),residuals:[]};
  writeFileSync(f.journalPath,JSON.stringify(j));
  let updates=0;
  const fetcher=async(url)=>{
    if(url.endsWith('/accounts:update'))updates++;
    return {ok:true,text:async()=>JSON.stringify({users:[{localId:randomUUID(),
      email:TARGET.email,displayName:TARGET.fullName,disabled:false,emailVerified:false,
      customAttributes:JSON.stringify({tenantId:TARGET.tenantId,role:'admin',testOnly:true}),
      validSince:'0'}]})};
  };
  const clients=await boundClients(f.cap,{binding:f.binding,secret:{password:'x'},...p,fetcher,
    now:()=>f.clock.value});
  const result=await new CoordinatorAuthSequence(f.cap,clients).closeout(true);
  assert.equal(result.status,'P08_COORDINATOR_AUTH_CONTAINMENT_UNCONFIRMED');
  assert.ok(result.residuals.includes('FIREBASE_READBACK'));
  assert.equal(updates,0);
});

test('independent closeout resumes after start cutoff under the same journal',async t=>{
  const f=fixture(t),j=JSON.parse(readFileSync(f.journalPath));
  j.authClient={operationId:f.plan.operationId,version:3,phase:'CLOSEOUT_INTENT',
    activationIntent:false,firebaseEnableIntent:false,tokenIssueIntent:false,
    authenticated:false,closeoutAttempted:true,activatedVersion:null,disabledVersion:null,
    revocationIntentAt:iso(f.clock.value),residuals:[]};
  writeFileSync(f.journalPath,JSON.stringify(j));
  f.clock.value=Date.parse(f.plan.window.cutoff)+1000;
  const cleanupCap=authorize(f.plan,f.approval,{target:TARGET,receipt:f.receipt,
    runtime:f.runtime,journalPath:f.journalPath,now:()=>f.clock.value,mode:'closeout'});
  t.after(()=>close(cleanupCap));
  const p=ports(f);
  const clients=await boundClients(cleanupCap,{binding:f.binding,secret:{password:'x'},...p});
  const result=await new CoordinatorAuthSequence(cleanupCap,clients).closeout(true);
  assert.equal(result.status,'P08_COORDINATOR_AUTH_STOPPED_AND_CLOSED');
  assert.deepEqual(result.residuals,[]);
  assert.equal(p.state.probe,1);
});
