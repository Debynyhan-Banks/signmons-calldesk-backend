import assert from 'node:assert/strict';import {readFileSync,mkdtempSync,chmodSync,rmSync} from 'node:fs';import {createRequire} from 'node:module';import {randomUUID} from 'node:crypto';
import {AccountController,plan} from './account-controller.mjs';import {socketDatabase,FakeAuth,fixtureFirebase} from './account-adapters.mjs';
for(const k of Object.keys(process.env))if(k==='DATABASE_URL'||k.startsWith('PG'))delete process.env[k];globalThis.fetch=()=>{throw Error('EXTERNAL_FETCH_FORBIDDEN')};
const input=JSON.parse(readFileSync(0,'utf8'));assert.ok(['pair','retention','lost-sql','lost-firebase','claims-failure'].includes(input.mode));
// Socket host and credentials checked before any connection attempt.
assert.match(input.host,/^\/private\/tmp\/p08-pg-[A-Za-z0-9_-]+\/socket$/);
const require=createRequire(plan.backend+'/package.json');const {Client}=require('pg');const cfg={host:input.host,port:Number(input.port),user:'neondb_owner',database:'neondb',application_name:'p08-account-disposable',connectionTimeoutMillis:2000,query_timeout:3000,options:'-c statement_timeout=2s -c lock_timeout=1s'};const client=new Client(cfg);const db=socketDatabase(client,cfg),auth=new FakeAuth(),fb=fixtureFirebase(auth);const dir=mkdtempSync('/private/tmp/p08-account-proof-');chmodSync(dir,0o700);let connected=false;
const make=()=>new AccountController({directory:dir,db,fb,prepareDeadline:Date.now()+2000,cleanupDeadline:Date.now()+4000});
try{await client.connect();connected=true;
if(input.mode==='lost-sql'){const original=db.insert;db.insert=async s=>{await original(s);throw Error('PRIVATE_RESPONSE_LOST')}}
if(input.mode==='lost-firebase'){const original=fb.create;fb.create=async s=>{await original(s);throw Error('PRIVATE_RESPONSE_LOST')}}
if(input.mode==='claims-failure')fb.claims=async()=>{throw Error('PRIVATE_CLAIM_FAILURE')};
const result=await make().prepare();
if(input.mode==='retention'){assert.equal(result.status,'LOCAL_DISABLED_PAIR_PREPARED');const id=randomUUID();await client.query('INSERT INTO "AuditLog"(id,"tenantId",action,"actorType","actorUserId","actorUserTenantId","actorId","entityType","entityId") VALUES($1::uuid,$2::uuid,\'LOCAL_OPERATOR_PROOF\',\'USER\',$3::uuid,$2::uuid,$3::text,\'User\',$3::text)',[id,plan.spec.tenantId,plan.spec.id]);const close=await make().closeout();assert.equal(close.status,'LOCAL_DISABLED_PAIR_CLOSED');const after=await client.query('SELECT a."actorUserId",a."actorUserTenantId",u.status::text FROM "AuditLog" a JOIN "User" u ON a."actorUserId"=u.id AND a."actorUserTenantId"=u."tenantId" WHERE a.id=$1::uuid',[id]);assert.equal(after.rowCount,1);assert.equal(after.rows[0].status,'DISABLED');assert.equal(after.rows[0].actorUserId,plan.spec.id);console.log(JSON.stringify({...close,auditRetained:true}))}
else console.log(JSON.stringify(result));
}catch{console.log(JSON.stringify({status:'LOCAL_DRIVER_REFUSED',liveAction:false}));process.exitCode=2}
finally{if(connected)await client.end();else try{await client.end()}catch{}rmSync(dir,{recursive:true,force:true})}
