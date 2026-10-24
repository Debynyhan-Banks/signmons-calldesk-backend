// Test-only disposable adapter. Rejects all TCP hosts and never initializes Firebase SDK.
import assert from 'node:assert/strict';
import {readFileSync,realpathSync,lstatSync} from 'node:fs';
import {createRequire} from 'node:module';
import {randomUUID,createHash} from 'node:crypto';
import {spec,plan,MockFirebase,OperatorProof} from './operator-model.mjs';
for(const k of Object.keys(process.env))if(k==='DATABASE_URL'||k.startsWith('PG'))delete process.env[k];
globalThis.fetch=()=>{throw Error('EXTERNAL_FETCH_FORBIDDEN')};
const input=JSON.parse(readFileSync(0,'utf8'));
assert.ok(/^\/private\/tmp\/p08-pg-[A-Za-z0-9_-]+\/socket$/.test(input.host));assert.equal(realpathSync(input.host),input.host);assert.equal(lstatSync(input.host).mode&0o777,0o700);
assert.ok(/^55\d{3}$/.test(String(input.port)));assert.ok(['pair','flow','race','foreign-audit'].includes(input.mode));
const require=createRequire(plan.backend+'/package.json');const {Client,Pool}=require('pg');
const cfg={host:input.host,port:Number(input.port),user:'neondb_owner',database:'neondb',connectionTimeoutMillis:5000,query_timeout:10000,options:'-c statement_timeout=8s -c lock_timeout=3s'};
const db=new Client(cfg);let owner,pool;let phase='CONNECT';
const actorSpec=spec();const fb=new MockFirebase();
const adapter={kind:'OWNED_UNIX_POSTGRES_PROOF',
 async collision(s){return (await db.query('SELECT EXISTS(SELECT 1 FROM "User" WHERE id=$1::uuid OR ("tenantId"=$2::uuid AND email=$3)) AS hit',[s.id,s.tenantId,s.email])).rows[0].hit},
 async insert(s){await db.query('INSERT INTO "User"(id,"tenantId",email,"fullName",role,status,"updatedAt") VALUES($1::uuid,$2::uuid,$3,$4,$5::"UserRole",$6::"UserStatus",now())',[s.id,s.tenantId,s.email,s.fullName,s.role,s.status])},
 async get(id){assert.equal(id,actorSpec.id);return (await db.query('SELECT id,"tenantId",email,"fullName",role,status FROM "User" WHERE id=$1::uuid',[id])).rows[0]??null},
 async status(id,status){assert.equal(id,actorSpec.id);assert.ok(['ACTIVE','DISABLED'].includes(status));const r=await db.query('UPDATE "User" SET status=$2::"UserStatus","updatedAt"=now() WHERE id=$1::uuid AND "tenantId"=$3::uuid',[id,status,actorSpec.tenantId]);assert.equal(r.rowCount,1)}
};
try{
 await db.connect();phase='PREPARE';const op=new OperatorProof(actorSpec,adapter,fb);await op.prepare();
 assert.equal((await adapter.get(actorSpec.id)).status,'DISABLED');await assert.rejects(()=>op.authenticate());
 if(input.mode==='pair'||input.mode==='race'){console.log(JSON.stringify({status:'LOCAL_DISABLED_PAIR_PROVED',rows:1,actualAccountCreated:false}));}
 else{
 phase='ACTIVATE';await op.activate();assert.equal(await op.authenticate(),actorSpec.id);
 if(input.mode==='foreign-audit'){phase='FOREIGN_AUDIT';
 await assert.rejects(()=>db.query('INSERT INTO "AuditLog"(id,"tenantId",action,"actorType","actorUserId","actorUserTenantId","actorId","entityType","entityId") VALUES($1::uuid,$2::uuid,\'LOCAL_TEST\',\'USER\',$3::uuid,$2::uuid,$3::text,\'User\',$3::text)',[randomUUID(),plan.syntheticOtherTenantId,actorSpec.id]),e=>e.code==='23503');
 assert.deepEqual((await op.close()).residuals,[]);console.log(JSON.stringify({status:'LOCAL_FOREIGN_AUDIT_REFUSED',actualAccountCreated:false}));
 }else{
 phase='PRISMA_SETUP';const {PrismaClient}=require('@prisma/client');const {PrismaPg}=require('@prisma/adapter-pg');pool=new Pool(cfg);owner=new PrismaClient({adapter:new PrismaPg(pool),log:[]});
 const {JobPaymentPolicyService}=require(plan.backend+'/dist/jobs/job-payment-policy.service.js');const {PaymentRequestsService}=require(plan.backend+'/dist/payments/payment-requests.service.js');
 const {requestContextMiddleware,setAuthContext}=require(plan.backend+'/dist/common/context/request-context.js');
 const actor=fn=>new Promise((resolve,reject)=>requestContextMiddleware({headers:{}},{},()=>{setAuthContext({tenantId:actorSpec.tenantId,userId:actorSpec.id,role:'admin'});Promise.resolve().then(fn).then(resolve,reject)}));
 const terms={currency:'usd',serviceFeeRequired:false,serviceFeeCents:null,depositRequired:true,depositPolicy:{kind:'fixed',amountCents:12500},emergencyFeePolicy:{kind:'none'},paymentGateMode:'fail_closed',webhookValidationRequired:true};
 const approvedAt=new Date(Date.now()-60000).toISOString();const approved={draft:terms,actorId:actorSpec.id,approvedAt};
 await owner.tenantOrganization.update({where:{id:actorSpec.tenantId},data:{stripeConnectAccountId:'acct_local_bootstrap_only',chargesEnabled:true,settings:{organizationPaymentPolicyV1:{version:1,draft:terms,approved}}}});
 const customer=await owner.customer.create({data:{tenantId:actorSpec.tenantId,fullName:'Fictional customer',phone:'+12025550123'}});
 const address=await owner.propertyAddress.create({data:{tenantId:actorSpec.tenantId,customerId:customer.id,customerTenantId:actorSpec.tenantId,formattedAddress:'Fictional local address',addressComponents:[]}});
 const category=await owner.serviceCategory.create({data:{tenantId:actorSpec.tenantId,name:'Fictional repair'}});
 let job=await owner.job.create({data:{tenantId:actorSpec.tenantId,customerId:customer.id,customerTenantId:actorSpec.tenantId,propertyAddressId:address.id,propertyAddressTenantId:actorSpec.tenantId,serviceCategoryId:category.id,serviceCategoryTenantId:actorSpec.tenantId,status:'CREATED',urgency:'STANDARD',pricingSnapshot:{},policySnapshot:{intakeAdmission:{version:2,actorId:'signmons-intake-admission-v1',paymentApprovedAt:approvedAt,paymentDigest:createHash('sha256').update(JSON.stringify(approved)).digest('hex')}}}});
 phase='POLICY_BIND';await actor(()=>new JobPaymentPolicyService(owner).apply({jobId:job.id,expectedUpdatedAt:job.updatedAt.toISOString(),approvedAt,acknowledged:true}));job=await owner.job.findUniqueOrThrow({where:{id:job.id}});
 let calls=0;const sessions=new Map();const provider={async createCheckout(input){calls++;if(!sessions.has(input.idempotencyKey))sessions.set(input.idempotencyKey,{sessionId:'cs_local_bootstrap',paymentIntentId:'pi_local_bootstrap',checkoutUrl:'https://checkout.stripe.com/c/pay/local-fixture',expiresAt:new Date(Date.now()+3600000)});return sessions.get(input.idempotencyKey)}};
 const requests=new PaymentRequestsService(owner,provider);const args={tenantId:actorSpec.tenantId,jobId:job.id,actorId:actorSpec.id,traceId:randomUUID(),idempotencyKey:randomUUID(),expectedJobUpdatedAt:job.updatedAt.toISOString()};
 phase='REQUEST_AND_REPLAY';const first=await actor(()=>requests.create(args)),second=await actor(()=>requests.create(args));phase='REQUEST_IDENTITY';assert.equal(first.paymentRequestId,second.paymentRequestId);phase='LOGICAL_CHECKOUT_COUNT';assert.equal(sessions.size,1);
 phase='AUDIT_READBACK';const audits=await owner.auditLog.findMany({where:{tenantId:actorSpec.tenantId,actorId:actorSpec.id}});assert.equal(audits.length,2);const policyAudit=audits.find(a=>a.action==='job.payment_policy_bound');const paymentAudit=audits.find(a=>a.action==='payment.request_created');assert.ok(policyAudit);assert.equal(policyAudit.entityId,job.id);assert.ok(paymentAudit);assert.equal(paymentAudit.entityId,first.paymentRequestId);assert.equal(paymentAudit.actorUserId,actorSpec.id);assert.equal(paymentAudit.actorUserTenantId,actorSpec.tenantId);const auditIds=audits.map(a=>a.id).sort();
 phase='CLOSEOUT';assert.deepEqual((await op.close()).residuals,[]);await assert.rejects(()=>op.authenticate());assert.equal((await adapter.get(actorSpec.id)).status,'DISABLED');
 phase='AUDIT_RETENTION';const after=await owner.auditLog.findMany({where:{tenantId:actorSpec.tenantId,actorId:actorSpec.id}});assert.deepEqual(after.map(a=>a.id).sort(),auditIds);assert.equal(await owner.payment.count({where:{jobId:job.id}}),1);
 console.log(JSON.stringify({status:'LOCAL_ADMIN_POLICY_REQUEST_AUDIT_AND_DISABLED_RETENTION_PROVED',mockCheckoutCalls:calls,mockCheckoutSessions:sessions.size,logicalPayments:1,auditCount:after.length,disabledRowRetained:true,firebaseDisabledRevoked:true,actualAccountCreated:false,livePayment:false}));
 }
 }
}catch(error){console.log(JSON.stringify({status:'LOCAL_PROOF_REFUSED_OR_FAILED',phase,numericActual:typeof error?.actual==='number'?error.actual:undefined,numericExpected:typeof error?.expected==='number'?error.expected:undefined,code:typeof error?.code==='string'?error.code:'ASSERTION_OR_LOCAL_STATE'}));process.exitCode=1}
finally{if(owner)await owner.$disconnect();if(pool)await pool.end();try{await db.end()}catch{}}
