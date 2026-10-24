import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp,rm,stat} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {spec,plan,MockFirebase,OperatorProof,reserve,ProofError} from './operator-model.mjs';
globalThis.fetch=()=>{throw Error('EXTERNAL_FETCH_FORBIDDEN')};
class MemoryDb {
 constructor(){this.kind='MEMORY_PROOF';this.rows=new Map();this.inserts=0;this.updates=0;this.failDisable=false;this.failActivate=false}
 async collision(s){return this.rows.has(s.id)||[...this.rows.values()].some(u=>u.tenantId===s.tenantId&&u.email===s.email)}
 async insert(s){assert.equal(await this.collision(s),false);this.rows.set(s.id,structuredClone(s));this.inserts++}
 async get(id){return structuredClone(this.rows.get(id)??null)}
 async status(id,status){if((status==='DISABLED'&&this.failDisable)||(status==='ACTIVE'&&this.failActivate))throw Error('SYNTHETIC_ERROR');this.rows.get(id).status=status;this.updates++}
}
const fixture=()=>{const db=new MemoryDb(),fb=new MockFirebase();return {db,fb,op:new OperatorProof(spec(),db,fb)}};
test('disabled pair refuses authentication, activates through actual guard/qualifier, and closes',async()=>{const {op,fb}=fixture();assert.equal((await op.prepare()).actualAccountCreated,false);await assert.rejects(()=>op.authenticate(),e=>e.code==='LOCAL_AUTHENTICATION_REFUSED');await op.activate();assert.equal(await op.authenticate(),plan.syntheticActorId);assert.ok(fb.checks.every(x=>x===true));const done=await op.close();assert.deepEqual(done.residuals,[]);await assert.rejects(()=>op.authenticate());await op.assertDisabled()});
test('exact UUID, tenant-email, existing Firebase UID/email collisions never overwrite',async()=>{
 for(const kind of ['uuid','email','firebaseUid','firebaseEmail']){const {op,db,fb}=fixture();const s=spec();
 if(kind==='uuid')db.rows.set(s.id,{...s,tenantId:plan.syntheticOtherTenantId,fullName:'Existing person'});
 if(kind==='email')db.rows.set('40000000-0000-4000-8000-000000000001',{...s,id:'40000000-0000-4000-8000-000000000001',status:'ACTIVE'});
 if(kind==='firebaseUid')fb.users.set(s.id,{uid:s.id,email:'existing@fixture.invalid',disabled:false});
 if(kind==='firebaseEmail')fb.users.set('foreign',{uid:'foreign',email:s.email,disabled:false});
 const before=JSON.stringify([...db.rows]),fBefore=JSON.stringify([...fb.users]);await assert.rejects(()=>op.prepare(),e=>e.code==='EXACT_IDENTITY_COLLISION');assert.equal(JSON.stringify([...db.rows]),before);assert.equal(JSON.stringify([...fb.users]),fBefore);assert.equal(db.inserts,0);assert.equal(db.updates,0);
 }});
test('production-looking metadata, wrong tenant, foreign UUID, missing fields and non-mock Firebase refuse',()=>{
 for(const s of [{...spec(),email:'person@example.com'},{...spec(),tenantId:plan.syntheticOtherTenantId},{...spec(),id:'text-uid'},{...spec(),status:'ACTIVE'},{...spec(),role:'OWNER'},{...spec(),fullName:'Real person'},{}])assert.throws(()=>new OperatorProof(s,new MemoryDb(),new MockFirebase()));
 assert.throws(()=>new OperatorProof(spec(),new MemoryDb(),{}));assert.throws(()=>new OperatorProof(spec(),{kind:'REMOTE_DATABASE'},new MockFirebase()));
});
test('same proof cannot prepare twice or activate a nonowned existing pair',async()=>{const {op}=fixture();await op.prepare();await assert.rejects(()=>op.prepare());const other=fixture();await assert.rejects(()=>other.op.activate())});
test('Firebase failure after DB creation leaves disabled owned row and never closes another identity',async()=>{const {op,db,fb}=fixture();fb.failCreate=true;await assert.rejects(()=>op.prepare(),e=>e.code==='LOCAL_IDENTITY_PREPARATION_PARTIAL');assert.equal((await db.get(spec().id)).status,'DISABLED');const result=await op.close();assert.equal(result.status,'LOCAL_CLOSEOUT_UNCONFIRMED');assert.equal(fb.calls.includes('disable'),false)});
test('activation failure remains unconfirmed and cleanup restores disabled pair',async()=>{const {op,db}=fixture();await op.prepare();db.failActivate=true;await assert.rejects(()=>op.activate());assert.deepEqual((await op.close()).residuals,[])});
test('wrong app tenant, role, status and Firebase UID/claims cannot authenticate',async()=>{
 for(const field of ['tenant','role','status','uid','firebaseTenant','claimRole','testOnly','revoked','disabled']){const {op,db,fb}=fixture();await op.prepare();await op.activate();const u=db.rows.get(spec().id),f=fb.users.get(spec().id);
 if(field==='tenant')u.tenantId=plan.syntheticOtherTenantId;if(field==='role')u.role='TECH';if(field==='status')u.status='DISABLED';if(field==='uid')f.claims.sub='40000000-0000-4000-8000-000000000001';if(field==='firebaseTenant')f.claims.tenantId=plan.syntheticOtherTenantId;if(field==='claimRole')f.claims.role='tech';if(field==='testOnly')f.claims.testOnly=false;if(field==='revoked')f.revoked=true;if(field==='disabled')f.disabled=true;
 await assert.rejects(()=>op.authenticate(),e=>e.code==='LOCAL_AUTHENTICATION_REFUSED');}
});
test('application disable alone is not proof of Firebase revocation',async()=>{const {op,db,fb}=fixture();await op.prepare();await op.activate();await db.status(spec().id,'DISABLED');assert.equal((await fb.verifyIdToken('SYNTHETIC_ONLY:'+spec().id,true)).sub,spec().id);await assert.rejects(()=>op.authenticate());await op.close();await assert.rejects(()=>fb.verifyIdToken('SYNTHETIC_ONLY:'+spec().id,true))});
test('disable/revoke/app readback failures report residuals and never closed',async()=>{for(const stage of ['disable','revoke','app']){const {op,db,fb}=fixture();await op.prepare();await op.activate();if(stage==='disable')fb.failDisable=true;if(stage==='revoke')fb.failRevoke=true;if(stage==='app')db.failDisable=true;const result=await op.close();assert.equal(result.status,'LOCAL_CLOSEOUT_UNCONFIRMED');assert.ok(result.residuals.length)}});
test('local reservation is private, exclusive and deadline bounded',async()=>{const d=await mkdtemp('/private/tmp/p08-bootstrap-proof-');try{reserve(d,Date.now()+1000);assert.equal((await stat(d+'/attempt.json')).mode&0o777,0o600);assert.throws(()=>reserve(d,Date.now()+1000));assert.throws(()=>reserve(d,Date.now()-1));assert.throws(()=>reserve(d,Date.now()+120000))}finally{await rm(d,{recursive:true,force:true})}});
test('two actual processes can reserve only once',async()=>{const d=await mkdtemp('/private/tmp/p08-bootstrap-proof-');try{const program="import {reserve} from './operator-model.mjs';reserve(process.argv[1],Date.now()+10000)";const runs=[0,1].map(()=>new Promise(resolve=>{const child=spawn(process.execPath,['--input-type=module','-e',program,d],{cwd:new URL('.',import.meta.url),stdio:'ignore'});child.on('close',resolve)}));const values=await Promise.all(runs);assert.equal(values.filter(x=>x===0).length,1)}finally{await rm(d,{recursive:true,force:true})}});
test('live-looking CLI modes refuse without any network operation',async()=>{for(const mode of ['--run','--create','--activate','--lookup']){const code=await new Promise(resolve=>{const child=spawn(process.execPath,['operator-model.mjs',mode],{cwd:new URL('.',import.meta.url),stdio:'ignore'});child.on('close',resolve)});assert.equal(code,2)}});

test('live or missing-plan authority cannot turn a local model into an account operation',()=>{for(const [key,bad] of [['mode','LIVE_CREATE'],['externalActionAuthorized',true],['liveApproval',{}],['liveBinding',{}],['futureActorUuid','40000000-0000-4000-8000-000000000001']]){const before=plan[key];plan[key]=bad;try{assert.throws(()=>new OperatorProof(spec(),new MemoryDb(),new MockFirebase()),e=>e.code==='LOCAL_PROOF_ONLY')}finally{plan[key]=before}}});
