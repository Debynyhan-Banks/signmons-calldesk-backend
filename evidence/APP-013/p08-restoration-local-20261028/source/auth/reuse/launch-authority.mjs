// Exact external authority validator. This module resolves no credentials and creates no clients.
import {readFileSync,lstatSync,realpathSync} from 'node:fs';
import {createHash} from 'node:crypto';
export const hash=v=>createHash('sha256').update(typeof v==='string'||Buffer.isBuffer(v)?v:JSON.stringify(v)).digest('hex');
const capabilities=new WeakMap();
const requireThat=(v,c)=>{if(!v)throw Object.assign(Error(c),{code:c})};
const uuid=v=>typeof v==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(v);
export function authorize(p,a,{now=Date.now,proposal,sourceHashes,mode='prepare'}={}){
 requireThat(p?.status==='PROPOSED_EXACT_DISABLED_ACCOUNT_OPERATION'&&p.localDecisionCommit==='57969acbaca04dcd391594f92b020123040f23d4'&&p.automaticRetryAllowed===false,'EXACT_OPERATION_UNBOUND');
 requireThat(uuid(p.operationId)&&p.projectId==='signmons'&&uuid(p.target?.id)&&uuid(p.target.tenantId)&&p.target.email===p.ownerEmail&&p.target.fullName==='Signmons Test Administrator'&&p.target.role==='ADMIN'&&p.target.status==='DISABLED','EXACT_TARGET_DRIFT');
 requireThat(Object.keys(p.target).sort().join(',')==='email,fullName,id,role,status,tenantId'&&hash(p.ownerPrincipal)===p.ownerPrincipalHash&&p.ownerPrincipal===p.ownerEmail,'OWNER_PRINCIPAL_DRIFT');
 requireThat(p.database?.host==='ep-jolly-flower-ayc6w9hv.c-5.us-east-2.aws.neon.tech'&&p.database.database==='neondb'&&p.database.user==='neondb_owner'&&p.database.port===5432&&p.database.tls==='VERIFY_FULL','DATABASE_TARGET_DRIFT');
 requireThat(/^[a-f0-9]{40}$/.test(p.proposalCommit??'')&&/^[a-f0-9]{64}$/.test(p.proposalSha256??'')&&hash(proposal)===p.proposalSha256,'PROPOSAL_SOURCE_DRIFT');
 requireThat(a?.owner==='Debynyhan Banks'&&a.decision==='APPROVE_EXACT_DISABLED_ACCOUNT_OPERATION'&&a.externalActionAuthorized===true&&a.operationId===p.operationId&&a.planSha256===hash(p)&&a.proposalCommit===p.proposalCommit&&a.proposalSha256===p.proposalSha256&&typeof a.questionCallId==='string'&&a.questionCallId.startsWith('call_'),'EXACT_OWNER_APPROVAL_REQUIRED');
 requireThat(sourceHashes&&hash(sourceHashes)===a.sourceManifestSha256,'SOURCE_MANIFEST_DRIFT');
 const w=p.window;requireThat(w&&Object.keys(w).sort().join(',')==='cleanupEnd,cutoff,purgeEnd,start,workEnd'&&Object.values(w).every(x=>typeof x==='string'&&/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(x)),'WINDOW_FORMAT');
 const t=Object.fromEntries(Object.entries(w).map(([k,v])=>[k,Date.parse(v)]));requireThat(t.start<t.cutoff&&t.cutoff<t.workEnd&&t.workEnd<t.cleanupEnd&&t.cleanupEnd<t.purgeEnd&&t.purgeEnd-t.start<=1800000,'WINDOW_ORDER');
 requireThat(['prepare','closeout'].includes(mode),'MODE_REFUSED');const n=now();requireThat(n>=t.start,'BEFORE_START');requireThat(n<(mode==='prepare'?t.cutoff:t.cleanupEnd),'START_CUTOFF');
 const cap=Object.freeze({});capabilities.set(cap,{p:structuredClone(p),now,t,mode});return cap;
}
export function checkCapability(cap,p,s,cleanup=false){const c=capabilities.get(cap);requireThat(c&&hash(c.p)===hash(p)&&hash(c.p.target)===hash(s),'EXACT_CAPABILITY_REQUIRED');requireThat(c.now()>=c.t.start&&c.now()<(cleanup?c.t.cleanupEnd:c.t.workEnd),'OPERATION_DEADLINE');if(!cleanup)requireThat(c.mode==='prepare','CLOSEOUT_ONLY');return c}
export function capabilityPlan(cap){const c=capabilities.get(cap);requireThat(c,'EXACT_CAPABILITY_REQUIRED');return structuredClone(c.p)}
export function privateJson(path){requireThat(!lstatSync(path).isSymbolicLink()&&realpathSync(path)===path&&(lstatSync(path).mode&0o777)===0o600,'PRIVATE_INPUT_REQUIRED');return JSON.parse(readFileSync(path,'utf8'))}
