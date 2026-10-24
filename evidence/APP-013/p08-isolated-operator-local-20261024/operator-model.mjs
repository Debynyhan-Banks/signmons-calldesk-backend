// Local isolated-operator proof ONLY. No Firebase SDK, live account adapter or launch CLI.
import { readFileSync,openSync,closeSync,writeFileSync,lstatSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { qualifyActor, uuid } from './reuse/operator-bridge.mjs';
export const root=fileURLToPath(new URL('.',import.meta.url));
export const plan=JSON.parse(readFileSync(root+'operator-plan.json','utf8'));
const require=createRequire(plan.backend+'/package.json');
const {RequestAuthGuard}=require(plan.backend+'/dist/auth/request-auth.guard.js');
export class ProofError extends Error {constructor(code){super(code);this.code=code;}}
const need=(ok,code)=>{if(!ok)throw new ProofError(code)};
export const spec=()=>({id:plan.syntheticActorId,tenantId:plan.syntheticTenantId,email:'operator@fixture.invalid',fullName:'Fictional isolated operator',role:'ADMIN',status:'DISABLED'});
export function validate(s,db,fb){
 need(plan.mode==='LOCAL_ISOLATED_OPERATOR_PROOF'&&plan.status==='DISABLED_LOCAL_PREPARATION_ONLY'&&plan.externalActionAuthorized===false&&!plan.liveBinding&&!plan.liveApproval&&!plan.futureActorUuid,'LOCAL_PROOF_ONLY');
 need(s&&Object.keys(s).sort().join(',')==='email,fullName,id,role,status,tenantId'&&uuid(s.id)&&s.id===plan.syntheticActorId&&s.tenantId===plan.syntheticTenantId&&s.email==='operator@fixture.invalid'&&s.fullName==='Fictional isolated operator'&&s.role==='ADMIN'&&s.status==='DISABLED','SYNTHETIC_BOUNDARY');
 need(db&&['MEMORY_PROOF','OWNED_UNIX_POSTGRES_PROOF'].includes(db.kind)&&fb instanceof MockFirebase,'MOCK_OR_OWNED_FIXTURE_REQUIRED');
}
export function reserve(directory,deadline){
 need(Number.isFinite(deadline)&&deadline>Date.now()&&deadline-Date.now()<=60000,'PROOF_DEADLINE');
 need(directory.startsWith('/private/tmp/p08-bootstrap-proof-')&&!lstatSync(directory).isSymbolicLink()&&(lstatSync(directory).mode&0o777)===0o700,'OWNED_PROOF_DIRECTORY');
 let fd;try{fd=openSync(directory+'/attempt.json','wx',0o600)}catch{throw new ProofError('PROOF_ATTEMPT_EXISTS')}
 try{writeFileSync(fd,JSON.stringify({operationId:plan.operationId,status:'LOCAL_PROOF_RESERVED_NO_RETRY'}));}finally{closeSync(fd)}
}
export class MockFirebase {
 constructor(){this.kind='MOCK_FIREBASE_NO_NETWORK';this.users=new Map();this.calls=[];this.failCreate=false;this.failDisable=false;this.failRevoke=false;this.checks=[];}
 async collision(id,email){this.calls.push('lookup');return this.users.has(id)||[...this.users.values()].some(u=>u.email===email)}
 async create(s){this.calls.push('create');need(!this.failCreate&&!await this.collision(s.id,s.email),'FIREBASE_COLLISION_OR_CREATE_FAILED');this.users.set(s.id,{uid:s.id,email:s.email,disabled:true,revoked:true,claims:{sub:s.id,tenantId:s.tenantId,role:'admin',testOnly:true,iss:'https://securetoken.google.com/signmons',aud:'signmons'}})}
 async get(id){return structuredClone(this.users.get(id)??null)}
 async enable(id){this.calls.push('enable');const u=this.users.get(id);need(u,'IDENTITY_MISSING');u.disabled=false;u.revoked=false}
 async disable(id){this.calls.push('disable');need(!this.failDisable,'DISABLE_FAILED');this.users.get(id).disabled=true}
 async revoke(id){this.calls.push('revoke');need(!this.failRevoke,'REVOKE_FAILED');this.users.get(id).revoked=true}
 async verifyIdToken(token,checkRevoked){this.checks.push(checkRevoked);need(checkRevoked===true,'REVOCATION_REQUIRED');const u=this.users.get(token.replace('SYNTHETIC_ONLY:',''));need(u&&!u.disabled&&!u.revoked&&token.startsWith('SYNTHETIC_ONLY:'),'SYNTHETIC_IDENTITY_DISABLED_OR_REVOKED');return structuredClone(u.claims)}
}
export class OperatorProof {
 constructor(s,db,fb){validate(s,db,fb);this.s=structuredClone(s);this.db=db;this.fb=fb;this.ownedDb=false;this.ownedFirebase=false;this.state='NEW';}
 async prepare(){
 need(this.state==='NEW','PROOF_ALREADY_USED');this.state='RESERVED';
 need(!await this.db.collision(this.s)&&!await this.fb.collision(this.s.id,this.s.email),'EXACT_IDENTITY_COLLISION');
 try{await this.db.insert(this.s);this.ownedDb=true;this.state='APP_DISABLED';await this.fb.create(this.s);this.ownedFirebase=true;this.state='BOTH_DISABLED';await this.assertDisabled();return {status:'LOCAL_DISABLED_PAIR_PROVED',actualAccountCreated:false};}
 catch(e){this.state='PARTIAL_UNCONFIRMED';throw new ProofError(this.ownedDb?'LOCAL_IDENTITY_PREPARATION_PARTIAL':'APP_COLLISION_OR_CREATE_FAILED')}
 }
 async assertDisabled(){const u=await this.db.get(this.s.id);const f=await this.fb.get(this.s.id);need(u?.id===this.s.id&&u.tenantId===this.s.tenantId&&u.role==='ADMIN'&&u.status==='DISABLED'&&f?.uid===u.id&&f.disabled===true&&f.revoked===true&&f.claims.tenantId===u.tenantId&&f.claims.role==='admin'&&f.claims.testOnly===true,'DISABLED_READBACK_FAILED')}
 async activate(){
 need(this.state==='BOTH_DISABLED'&&this.ownedDb&&this.ownedFirebase,'NOT_OWNED_DISABLED_PAIR');await this.assertDisabled();
 try{await this.db.status(this.s.id,'ACTIVE');await this.fb.enable(this.s.id);this.state='TEMPORARILY_ACTIVE_LOCAL_PROOF';await this.authenticate();}
 catch{this.state='PARTIAL_UNCONFIRMED';throw new ProofError('LOCAL_ACTIVATION_UNCONFIRMED')}
 }
 async authenticate(){
 need(this.ownedDb&&this.ownedFirebase,'NOT_OWNED_PAIR');
 const guard=new RequestAuthGuard({devAuthEnabled:false,environment:'production',identityIssuer:'https://securetoken.google.com/signmons',identityAudience:'signmons'},{getAuth:()=>({verifyIdToken:this.fb.verifyIdToken.bind(this.fb)})});
 try{const exact=await this.fb.get(this.s.id);need(exact?.uid===this.s.id&&exact.claims.sub===this.s.id&&exact.claims.testOnly===true,'EXACT_TEST_IDENTITY_REQUIRED');await guard.canActivate({switchToHttp:()=>({getRequest:()=>({header:n=>n==='authorization'?'Bearer SYNTHETIC_ONLY:'+this.s.id:undefined})})});const f=await this.fb.get(this.s.id);return qualifyActor(f.claims,await this.db.get(this.s.id),this.s.tenantId)}catch{throw new ProofError('LOCAL_AUTHENTICATION_REFUSED')}
 }
 async close(){
 need(this.ownedDb,'NOT_OWNED_APP_ROW');const residuals=[];
 if(this.ownedFirebase){
 for(const [stage,fn] of [['FIREBASE_DISABLE',()=>this.fb.disable(this.s.id)],['FIREBASE_REVOKE',()=>this.fb.revoke(this.s.id)]])try{await fn()}catch{residuals.push(stage)}
 try{const f=await this.fb.get(this.s.id);need(f?.uid===this.s.id&&f.disabled===true&&f.revoked===true,'IDENTITY_CLOSEOUT_READBACK')}catch{residuals.push('FIREBASE_READBACK')}
 }else residuals.push('IDENTITY_NOT_CREATED_NO_TAKEOVER');
 try{await this.db.status(this.s.id,'DISABLED');const u=await this.db.get(this.s.id);need(u?.status==='DISABLED'&&u.id===this.s.id&&u.tenantId===this.s.tenantId,'APP_CLOSEOUT_READBACK')}catch{residuals.push('APP_DISABLE_OR_READBACK')}
 this.state=residuals.length?'LOCAL_CLOSEOUT_UNCONFIRMED':'LOCAL_DISABLED_PAIR_CLOSED';return {status:this.state,residuals,appRowRetained:true,actualAccountCreated:false};
 }
}
if(process.argv[1]===fileURLToPath(import.meta.url)){
 console.log('P08_ISOLATED_OPERATOR_LIVE_ACTION_DISABLED');process.exitCode=2;
}
