import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {authorizeChild} from './authority_bridge.mjs';
import {createPorts} from './transports.mjs';
import {runChild} from './native_child.mjs';
import {fixturePorts} from './fixture_ports.mjs';
import {boundClients} from '../../p08-real-client-binding-local-20261031/source/bound-clients.mjs';
import {CoordinatorAuthSequence} from '../../p08-real-client-binding-local-20261031/source/recovery-sequence.mjs';
import {database,SQL} from '../../p08-coordinator-auth-local-20261031/source/client.mjs';
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
  constructor(config){
    // Reproduce only the previous native settings on this owned loopback fixture.
    if(input.scenario==='timestamp-legacy'){
      config={...config};delete config.types;
      config.options=config.options.replace(' -c timezone=UTC','');
    }
    super({...config,ssl:config.application_name.startsWith('p08-probe-')?probeSsl:config.ssl});
  }
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
    if(input.scenario.startsWith('timestamp-')){
      const factory=ports.dbFactory,opened=[];let disableCalls=0,lost=false;
      ports.dbFactory=async(...args)=>{
        const db=await factory(...args),query=db.query.bind(db);opened.push(db);
        db.query=async(sql,values)=>{
          if(sql===SQL.disable)disableCalls++;
          const result=await query(sql,values);
          if(input.scenario==='timestamp-lost' && sql===SQL.activate && !lost){
            lost=true;assert.equal(result.rowCount,1);throw Error('SYNTHETIC_LOST_RESPONSE');
          }
          return result;
        };
        return db;
      };
      const clients=await run();let closed=false,second;
      try{
        const raw=opened[0],zone=(await raw.query('SHOW TIME ZONE')).rows[0].TimeZone;
        const type=(await raw.query('SELECT format_type(atttypid,atttypmod) AS type FROM pg_attribute WHERE attrelid=\'"User"\'::regclass AND attname=\'updatedAt\'')).rows[0].type;
        assert.equal(type,'timestamp(3) without time zone');
        const before=await clients.db.get();
        if(input.scenario==='timestamp-legacy'){
          assert.equal(zone,input.serverTimezone);assert.notEqual(before.updatedAt,input.expectedVersion);
          await assert.rejects(()=>clients.db.activate(before.updatedAt),{code:'ACTIVATION_CONFLICT'});
          assert.equal((await clients.db.get()).status,'DISABLED');assert.equal(disableCalls,0);
        }else{
          assert.equal(zone,'UTC');assert.equal(before.updatedAt,input.expectedVersion);
          if(input.scenario==='timestamp-lost'){
            const result=await new CoordinatorAuthSequence(local,clients).run();closed=true;
            assert.equal(result.status,'P08_COORDINATOR_AUTH_CONTAINMENT_UNCONFIRMED');
            assert.deepEqual(result.residuals,['ACTIVATION_OUTCOME_UNKNOWN']);
            assert.equal(result.authenticated,false);assert.equal(result.sessionClosed,true);
            assert.equal(lost,true);assert.equal(disableCalls,0);
          }else{
            const active=await clients.db.activate(before.updatedAt);
            assert.equal(active.status,'ACTIVE');assert.ok(Date.parse(active.updatedAt)>=Date.parse(before.updatedAt)+1);
            await assert.rejects(()=>clients.db.activate(active.updatedAt),{code:'ACTIVATION_CONFLICT'});
            await assert.rejects(()=>clients.db.disable(before.updatedAt),{code:'DISABLE_CONFLICT'});
            const disabled=await clients.db.disable(active.updatedAt);
            assert.equal(disabled.status,'DISABLED');assert.ok(Date.parse(disabled.updatedAt)>=Date.parse(active.updatedAt)+1);
            await assert.rejects(()=>clients.db.activate(before.updatedAt),{code:'ACTIVATION_CONFLICT'});
            for(const patch of [{id:'40000000-0000-4000-8000-000000000002'},
              {tenantId:'40000000-0000-4000-8000-000000000003'},
              {email:'foreign@fixture.invalid'},{fullName:'Foreign fixture'}]){
              const wrong=database(raw,{...e.target,...patch});
              await assert.rejects(()=>wrong.activate(disabled.updatedAt),{code:'ACTIVATION_CONFLICT'});
            }
            await raw.query('UPDATE "User" SET role=\'TECH\' WHERE id=$1::uuid',[e.target.id]);
            await assert.rejects(()=>clients.db.activate(disabled.updatedAt),{code:'ACTIVATION_CONFLICT'});
            await raw.query('UPDATE "User" SET role=\'ADMIN\' WHERE id=$1::uuid',[e.target.id]);
            second=await run();
            const one=await clients.db.get(),two=await second.db.get();assert.equal(one.updatedAt,two.updatedAt);
            const outcomes=await Promise.allSettled([clients.db.activate(one.updatedAt),second.db.activate(two.updatedAt)]);
            assert.equal(outcomes.filter(x=>x.status==='fulfilled').length,1);
            assert.equal(outcomes.find(x=>x.status==='rejected').reason.code,'ACTIVATION_CONFLICT');
            const winner=outcomes.find(x=>x.status==='fulfilled').value;
            await assert.rejects(()=>clients.db.disable(one.updatedAt),{code:'DISABLE_CONFLICT'});
            assert.equal((await clients.db.disable(winner.updatedAt)).status,'DISABLED');
            await opened[1].end();second.clear();second=null;
          }
        }
      }finally{
        if(second){await opened[1].end();second.clear();}
        if(!closed)await clients.close();clients.clear();
      }
    }
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
