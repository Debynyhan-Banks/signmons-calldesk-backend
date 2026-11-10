// Owned TLS PostgreSQL + real application services + reused browser UI. No provider network.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {createHmac,randomUUID} from 'node:crypto';
import {fixture,portsFor,runConnected} from './fixture_connected.mjs';
import {runChild} from './native_child.mjs';
const require=createRequire(new URL('../../../../package.json',import.meta.url));
const {Client,Pool}=require('pg'),{PrismaPg}=require('@prisma/adapter-pg'),{PrismaClient}=require('@prisma/client');
const {JobPaymentPolicyService}=require('./dist/jobs/job-payment-policy.service.js');
const {PaymentRequestsService}=require('./dist/payments/payment-requests.service.js');
const {StripeWebhooksService}=require('./dist/payments/stripe-webhooks.service.js');
const {DispatchBoardService}=require('./dist/jobs/dispatch-board.service.js');
const {RoutingService}=require('./dist/jobs/routing.service.js');
const {requestContextMiddleware,setAuthContext}=require('./dist/common/context/request-context.js');
const input=JSON.parse(readFileSync(0,'utf8'));assert.match(input.cert,/^\/private\/tmp\/p08-pg-[\w-]+\/server\.crt$/);
assert.equal(input.host,'127.0.0.1');assert.ok(Number.isInteger(input.port));
const cleanups=[],f=fixture({after:fn=>cleanups.push(fn)}),e=f.e;
e.database={host:input.host,port:input.port,database:'neondb',user:'neondb_owner'};f.seal();
const ssl={ca:readFileSync(input.cert,'utf8'),rejectUnauthorized:true};
const pool=new Pool({...e.database,ssl,max:4,application_name:'p08-connected-app-fixture',connectionTimeoutMillis:5000});
const prisma=new PrismaClient({adapter:new PrismaPg(pool)});let browser;
try {
 await prisma.tenantOrganization.update({where:{id:e.plan.tenantId},data:{chargesEnabled:true,stripeConnectAccountId:'acct_synthetic',settings:f.raw.tenant.settings}});
 const customer=await prisma.customer.create({data:{tenantId:e.plan.tenantId,fullName:'Fictional local customer',phone:'+12025550123'}});
 const address=await prisma.propertyAddress.create({data:{tenantId:e.plan.tenantId,customerId:customer.id,customerTenantId:e.plan.tenantId,formattedAddress:'Fictional test address',addressComponents:[]}});
 const category=await prisma.serviceCategory.create({data:{tenantId:e.plan.tenantId,name:'Fictional service'}});
 await prisma.job.create({data:{id:e.plan.jobId,tenantId:e.plan.tenantId,customerId:customer.id,customerTenantId:e.plan.tenantId,
   propertyAddressId:address.id,propertyAddressTenantId:e.plan.tenantId,serviceCategoryId:category.id,serviceCategoryTenantId:e.plan.tenantId,
   status:'CREATED',urgency:'STANDARD',policySnapshot:f.raw.job.policySnapshot,pricingSnapshot:{},updatedAt:new Date(e.payment.jobUpdatedAt)}});
 const context={tenantId:e.plan.tenantId,userId:e.target.id,role:'admin'},actor=fn=>new Promise((resolve,reject)=>
   requestContextMiddleware({headers:{}},{},()=>{setAuthContext(context);Promise.resolve().then(fn).then(resolve,reject);}));
 const policy=new JobPaymentPolicyService(prisma),sessions=new Map();let creates=0;
 const provider={async createCheckout(i){creates++;if(!sessions.has(i.idempotencyKey))sessions.set(i.idempotencyKey,{sessionId:'cs_local_'+randomUUID().replaceAll('-',''),paymentIntentId:'pi_local_'+randomUUID().replaceAll('-',''),checkoutUrl:'https://checkout.stripe.com/c/pay/local-fixture',expiresAt:new Date(Date.now()+3600000)});return sessions.get(i.idempotencyKey);},async recoverCheckout(i){return [...sessions.values()].find(x=>x.sessionId===i.sessionId);}};
 const payments=new PaymentRequestsService(prisma,provider),key='SYNTHETIC_LOCAL_SIGNING_KEY';
 const hooks=new StripeWebhooksService(prisma,{stripeWebhookSecret:key,stripeWebhookLivemode:false});
 const dispatch=new DispatchBoardService(prisma,new RoutingService(prisma));
 const ports=portsFor(f),original=ports.fetcher;
 ports.ClientClass=class extends Client {async query(...args){try{return await super.query(...args);}catch(error){process.stderr.write('LOCAL_SQL '+error.message+'\n');throw error;}}};ports.ssl=ssl;
 ports.fetcher=async(url,options)=>{
   if(!url.startsWith(e.payment.url.replace('/webhooks/stripe','')))return original(url,options);
   const body=options.body?JSON.parse(options.body):null;let value;
   const common={tenantId:e.plan.tenantId,jobId:e.plan.jobId,actorId:e.target.id,traceId:randomUUID()};
   if(url.endsWith('/job-payment-policy/apply'))value=await actor(()=>policy.apply(body));
   else if(url.endsWith('/payment-requests'))value=await payments.create({...common,idempotencyKey:options.headers['Idempotency-Key'],expectedJobUpdatedAt:body.expectedJobUpdatedAt});
   else if(url.endsWith('/payment-request/recover'))value=await payments.recoverForOperator(common);
   else if(url.endsWith('/payment-request'))value=await payments.get(common.tenantId,common.jobId);
   else if(url.endsWith('/payment-events'))value=await payments.events(common.tenantId,common.jobId);
   else if(url.includes('/jobs/dispatch-board/'))value=await actor(()=>dispatch.get(common.tenantId,common.jobId));
   else throw Error('UNLISTED_LOCAL_APPLICATION_ROUTE');
   return {ok:true,status:200,text:async()=>JSON.stringify(value)};
 };
 const {chromium}=await import('/Users/debynyhanbanks/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs');
 browser=await chromium.launch({headless:true,channel:'chrome'});const page=await browser.newPage({viewport:{width:input.width??1440,height:900}}),errors=[];
 page.on('pageerror',e=>errors.push(e.message));
 // Prevent any browser request to Checkout/providers; this proof never submits a payment externally.
 await page.route('**/*',route=>new URL(route.request().url()).hostname==='127.0.0.1'?route.continue():route.abort());
 const event=(payment,type='checkout.session.completed',changes={},envelope={})=>{
   const time=Math.floor(Date.now()/1000),body=Buffer.from(JSON.stringify({id:'evt_local_'+randomUUID(),type,account:'acct_synthetic',livemode:false,created:time,
     data:{object:{id:payment.stripeCheckoutSessionId,payment_status:'paid',payment_intent:payment.stripePaymentIntentId,amount_total:payment.amountTotalCents,currency:payment.currency,
       metadata:{paymentRequestId:payment.id,jobId:payment.jobId,tenantId:payment.tenantId},...changes}},...envelope}));
   return {body,signature:`t=${time},v1=${createHmac('sha256',key).update(`${time}.`).update(body).digest('hex')}`};
 };
 ports.present=async url=>{
   await page.goto(url);await page.locator('#ack').check();
   const click=async id=>{await Promise.all([page.waitForResponse(r=>r.url().endsWith('/action')),page.locator('#'+id).click()]);if(id!=='clear')await page.waitForFunction(()=>!document.querySelector('#read').disabled);};
   await click('bind');assert.match(await page.locator('#state').innerText(),/policy applied/i);
   await click('create');assert.match(await page.locator('#state').innerText(),/request created/i);
   await click('read');assert.match(await page.locator('#state').innerText(),/pending/i);
   const payment=await prisma.payment.findFirstOrThrow({where:{jobId:e.plan.jobId}});
   const signed=event(payment);await assert.rejects(()=>hooks.receive(signed.body,'forged'));
   const foreign=event(payment,'checkout.session.completed',{}, {account:'acct_foreign'});await assert.rejects(()=>hooks.receive(foreign.body,foreign.signature));
   const unpaid=event(payment,'checkout.session.completed',{payment_status:'unpaid'});await hooks.receive(unpaid.body,unpaid.signature);
   assert.notEqual((await payments.get(e.plan.tenantId,e.plan.jobId)).status,'SUCCEEDED');
   await hooks.receive(signed.body,signed.signature);await hooks.receive(signed.body,signed.signature);
   const late=event(payment,'checkout.session.async_payment_failed');await hooks.receive(late.body,late.signature);
   await click('read');assert.match(await page.locator('#state').innerText(),/succeeded/i);
   assert.equal(await prisma.payment.count({where:{jobId:e.plan.jobId}}),1);assert.equal(creates,1);
   assert.deepEqual(await page.evaluate(()=>({local:localStorage.length,session:sessionStorage.length})),{local:0,session:0});
   assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));assert.deepEqual(errors,[]);
   await page.screenshot({path:input.screenshot});await click('clear');
 };
 const show=ports.present;ports.present=async url=>{try{await show(url);}catch(error){process.stderr.write('LOCAL_PRESENT_FAILURE '+error.message+'\n');throw error;}};
 const result=await runConnected(f.r,ports),journal=JSON.parse(readFileSync(f.r.envelopePath.replace('envelope.json','journal.json')));
 assert.equal(result.sessionClosed,true);assert.equal(journal.payment.outcome,'APPLICATION_SETTLED',JSON.stringify(journal.payment));assert.equal(journal.payment.endpointDisabled,true);
 assert.equal((await prisma.user.findUniqueOrThrow({where:{id:e.target.id}})).status,'DISABLED');
 process.stdout.write(JSON.stringify({status:'CONNECTED_TLS_BROWSER_PASS',width:input.width??1440,providerCalls:0,paymentCount:1,sessionClosed:true})+'\n');
}finally{await browser?.close();await prisma.$disconnect();await pool.end();for(const fn of cleanups)fn();}
