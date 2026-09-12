// Invoked by the explicitly approved supervised authentication runner only.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHmac,randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {Client}=require('pg');
const {CustomerConsentCredentials}=require('../dist/communications/customer-consent-credentials.js');
const {stagingPhoneDigest}=require('../dist/communications/staging-phone-policy.js');
const tenantId='a1adcfd4-15be-404b-9ac3-5edb1fda20f0';
const base='https://phone-preflight---signmons-calldesk-staging-p572d6wipq-ul.a.run.app';
const image='us-east5-docker.pkg.dev/signmons/signmons/signmons-calldesk-backend@sha256:25e194acfd96299bb670de84e63b932d9dc69528e6f421ae42699f80fc9b3d75';
const gc=(...a)=>execFileSync('gcloud',a,{encoding:'utf8',stdio:['ignore','pipe','pipe'],timeout:180000}).trim();
const secret=(name,version='latest')=>gc('secrets','versions','access',version,'--secret='+name,'--project=signmons');
const dialog=(prompt)=>execFileSync('osascript',['-e',`text returned of (display dialog "${prompt}" default answer "" with hidden answer buttons {"Cancel", "Continue"} default button "Continue" giving up after 120)`],{encoding:'utf8',stdio:['ignore','pipe','pipe'],timeout:125000}).trim();
export async function runApprovedPhoneTest(idToken) {
  const phone=dialog('Signmons: enter your approved US mobile in +1 format, ending 3183. One verification text only; no automatic resend.');
  assert(/^\+1[2-9]\d{9}$/.test(phone)&&phone.endsWith('3183'));
  const request=async(body,path='/operations')=>{const r=await fetch(base+'/communications/staging-phone-test'+path,{method:'POST',headers:{Authorization:'Bearer '+idToken,'content-type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(30000)});const x=await r.json();return {status:r.status,result:x};};
  const refused=await request({operation:{}});assert.equal(refused.status,503);
  console.log('Correct DTO reached disabled-service refusal: 503.');
  const connectionString=secret('signmons-staging-database-url');
  assert.equal(new URL(connectionString).hostname,'ep-nameless-frog-ayk5gr5y-pooler.c-5.us-east-2.aws.neon.tech');
  const db=new Client({connectionString,connectionTimeoutMillis:10000});
  let changed=false,deployed=false;const sessionId=randomUUID(),conversationId=randomUUID(),customerId=randomUUID();
  try {
    await db.connect();
    const t=(await db.query('SELECT status,settings FROM "TenantOrganization" WHERE id=$1',[tenantId])).rows[0];
    assert.equal(t.status,'SUSPENDED');assert.equal(t.settings.stagingPhoneTestApproval.enabled,false);
    const accountSid=secret('signmons-staging-twilio-account-sid');
    const liability=(await db.query('SELECT count(*)::int AS n FROM "AuditLog" WHERE action=$1 AND metadata->>\'accountSid\'=$2',['conversation.staging_phone_held',accountSid])).rows[0];
    assert.equal(liability.n,0,'Existing liability requires review');
    const sessionKey=secret('signmons-staging-phone-session-key','1');const digestKey=secret('signmons-staging-phone-digest-key','1');
    const version=JSON.parse(gc('secrets','versions','describe','latest','--secret=signmons-staging-twilio-auth-token','--project=signmons','--format=json'));
    assert.equal(version.state,'ENABLED');const tokenVersion=version.name.split('/').pop();assert(/^\d+$/.test(tokenVersion));
    const policy={version:1,tenantId,operatorId:'staging-phone-owner-20260912',sessionId,conversationId,accountSid,serviceSid:'VA9aee2b6f81cdf797d4af79e939ab04f0',phoneDigest:createHmac('sha256',Buffer.from(digestKey,'hex')).update(phone).digest('hex'),startsAt:Date.now(),expiresAt:Date.now()+15*60000,rateVersion:'public-payg-us-20260912',flowUpperBoundMicros:500000,noticeVersion:'owner-otp-test-v1'};
    await db.query('BEGIN');
    try {
      const u=await db.query('UPDATE "TenantOrganization" SET status=\'ACTIVE\',settings=jsonb_set(settings,\'{stagingPhoneTestApproval}\',$2::jsonb),"updatedAt"=now() WHERE id=$1 AND status=\'SUSPENDED\'',[tenantId,JSON.stringify({enabled:true,digest:stagingPhoneDigest(policy)})]);assert.equal(u.rowCount,1);
      await db.query('INSERT INTO "Customer" (id,"tenantId",phone,"fullName","updatedAt") VALUES ($1,$2,$3,$4,now())',[customerId,tenantId,'unknown-'+sessionId,'Isolated owner phone test']);
      await db.query('INSERT INTO "Conversation" (id,"tenantId","customerId","customerTenantId",channel,status,"currentFSMState","collectedData","updatedAt") VALUES ($1,$2,$3,$2,\'WEBCHAT\',\'ONGOING\',\'TRIAGE\',$4::jsonb,now())',[conversationId,tenantId,customerId,JSON.stringify({sessionId,source:'WEBCHAT',customerSessionVersion:1,verificationLifecycle:{version:1,expiresAt:policy.expiresAt,closedAt:null,purgedAt:null}})]);
      await db.query('COMMIT');changed=true;
    }catch(e){await db.query('ROLLBACK');throw e;}
    deployed=true; // Cleanup even after an uncertain deploy response.
    gc('run','deploy','signmons-calldesk-staging','--project=signmons','--region=us-east5','--image='+image,'--tag=phone-preflight','--no-traffic','--update-env-vars=^|^STAGING_PHONE_TEST_ENABLED=true|STAGING_PHONE_TEST_POLICY='+JSON.stringify(policy),'--update-secrets=STAGING_PHONE_TWILIO_AUTH_TOKEN=signmons-staging-twilio-auth-token:'+tokenVersion,'--quiet');
    const live=JSON.parse(gc('run','services','describe','signmons-calldesk-staging','--project=signmons','--region=us-east5','--format=json'));
    const env=live.spec.template.spec.containers[0].env;
    for(const name of ['BACKGROUND_WORKERS_ENABLED','SMS_DELIVERY_ENABLED','SCHEDULING_ENABLED','DEV_AUTH_ENABLED','STRIPE_WEBHOOK_LIVEMODE'])assert.equal(env.find(e=>e.name===name)?.value,'false');
    assert.equal(env.find(e=>e.name==='STAGING_PHONE_TEST_POLICY')?.value,JSON.stringify(policy));
    assert.equal(live.status.traffic.find(t=>t.percent===100)?.revisionName,'signmons-calldesk-staging-app013bounds');
    assert(Date.now()<policy.expiresAt-120000);
    const credentials=new CustomerConsentCredentials({activeKeyId:'staging-phone',keys:{'staging-phone':Buffer.from(sessionKey,'hex')}});
    const sessionToken=credentials.issueSession({tenantId,conversationId,sessionId});
    const operation={sessionToken,operationId:randomUUID(),kind:'START',phone,code:'',startOperationId:''};
    const start=await request({operation,optIn:{requested:true,noticeVersion:policy.noticeVersion}});
    console.log(JSON.stringify({startHttp:start.status,outcome:start.result.outcome}));
    assert(start.status>=200&&start.status<300);assert.equal(start.result.outcome,'PENDING');
    const code=dialog('Signmons: enter the six-digit code from the one approved test text. Do not paste it into chat. Cancel stops the test.');assert(/^\d{6}$/.test(code));
    const check=await request({operation:{...operation,operationId:randomUUID(),kind:'CHECK',code,startOperationId:operation.operationId}});
    console.log(JSON.stringify({checkHttp:check.status,outcome:check.result.outcome,bookingAuthorized:check.result.bookingAuthorized,deliveryAuthorized:check.result.deliveryAuthorized}));
    assert(check.status>=200&&check.status<300);assert.equal(check.result.outcome,'APPROVED');
    const stop=await request({},'/stop');console.log(JSON.stringify({stopHttp:stop.status,stopped:stop.result.stopped}));assert.equal(stop.result.stopped,true);
  } finally {
    // Independent exact-target fallback; preserve audit and retained liability.
    if(changed) {
      await db.query('UPDATE "TenantOrganization" SET status=\'SUSPENDED\',settings=jsonb_set(settings,\'{stagingPhoneTestApproval}\',\'{"enabled":false}\'::jsonb),"updatedAt"=now() WHERE id=$1',[tenantId]);
      await db.query('UPDATE "Conversation" SET "collectedData"=jsonb_set("collectedData",\'{verificationLifecycle,closedAt}\',to_jsonb(floor(extract(epoch from clock_timestamp())*1000)::bigint)),"updatedAt"=now() WHERE id=$1 AND "tenantId"=$2',[conversationId,tenantId]);
      console.log('Exact tenant suspended, phone approval revoked and session closed; evidence retained.');
    }
    await db.end();
    if(deployed){gc('run','deploy','signmons-calldesk-staging','--project=signmons','--region=us-east5','--image='+image,'--tag=phone-preflight','--no-traffic','--update-env-vars=STAGING_PHONE_TEST_ENABLED=false','--remove-env-vars=STAGING_PHONE_TEST_POLICY','--remove-secrets=STAGING_PHONE_TWILIO_AUTH_TOKEN','--quiet');console.log('Candidate phone flag disabled and temporary policy/token mapping removed.');}
  }
}
