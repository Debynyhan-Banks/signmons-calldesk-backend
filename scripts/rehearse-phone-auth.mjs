// Exact owner-approved supervised single-SMS runner; fixed window, no automatic retry.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { collectApprovedPhone } from './private-phone-input.mjs';
const require = createRequire(import.meta.url);
const { initializeApp } = require('firebase-admin/app');
const { getAuth } = require('firebase-admin/auth');
if (process.argv[2] !== '--approved-single-sms') throw Error('Approval required');
// Fail/cancel before credentials, IAM, identity changes or propagation waits.
const approvedPhone = collectApprovedPhone();
const uid = 'staging-phone-owner-20260912';
const tenantId = 'a1adcfd4-15be-404b-9ac3-5edb1fda20f0';
const sa = 'signmons-calldesk-runtime@signmons.iam.gserviceaccount.com';
const role = 'projects/signmons/roles/stagingPhoneTokenSigner';
const condition = 'expression=request.time >= timestamp("2026-09-12T22:07:00Z") && request.time < timestamp("2026-09-12T22:22:00Z"),title=staging-phone-one-session';
const gc = (...args) => execFileSync('gcloud', args, {encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
const jsonGc = (...args) => JSON.parse(gc(...args,'--format=json'));
let roleAttempted=false, grantAttempted=false, identityAttempted=false, idToken;
const accessToken=gc('auth','print-access-token');
const headers={Authorization:`Bearer ${accessToken}`,'content-type':'application/json','x-goog-user-project':'signmons'};
async function api(url, body, customHeaders=headers) {
  const r=await fetch(url,{method:body?'POST':'GET',headers:customHeaders,body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(15000)});
  const x=await r.json();
  if(!r.ok) {
    const safe = v => typeof v === 'string' && /^[A-Za-z0-9_.-]{1,120}$/.test(v) ? v : undefined;
    console.log(JSON.stringify({apiFailure:{host:new URL(url).hostname,status:r.status,code:safe(x.error?.status),reasons:x.error?.details?.map(d=>({reason:safe(d.reason),permission:safe(d.metadata?.permission),service:safe(d.metadata?.service)}))}}));
    throw Error(`API refused HTTP ${r.status}`);
  }
  return x;
}
const identity=(action,body)=>api(`https://identitytoolkit.googleapis.com/v1/projects/signmons/accounts:${action}`,body);
const bindingArgs=['--project=signmons',`--member=user:debynyhan@signmons.com`,`--role=${role}`,`--condition=${condition}`];
try {
  assert(Date.now()>=Date.parse('2026-09-12T22:07:00Z') && Date.now()<Date.parse('2026-09-12T22:09:00Z'));
  assert.equal(gc('auth','list','--filter=status:ACTIVE','--format=value(account)'),'debynyhan@signmons.com');
  const priorRole=jsonGc('iam','roles','describe','stagingPhoneTokenSigner','--project=signmons');
  assert.equal(priorRole.stage,'DISABLED');
  assert.deepEqual(priorRole.includedPermissions,['iam.serviceAccounts.signBlob']);
  const baseline=jsonGc('iam','service-accounts','get-iam-policy',sa,'--project=signmons');
  assert.equal((baseline.bindings||[]).length,0);
  const rev=jsonGc('run','revisions','describe','signmons-calldesk-staging-phone-d33ecd0','--project=signmons','--region=us-east5');
  for(const name of ['BACKGROUND_WORKERS_ENABLED','STAGING_PHONE_TEST_ENABLED','SMS_DELIVERY_ENABLED','SCHEDULING_ENABLED','DEV_AUTH_ENABLED','STRIPE_WEBHOOK_LIVEMODE']) assert.equal(rev.spec.containers[0].env.find(e=>e.name===name)?.value,'false');
  const before=(await identity('lookup',{localId:[uid]})).users;
  assert.equal(before.length,1); assert.equal(before[0].disabled,true);
  assert.deepEqual(JSON.parse(before[0].customAttributes),{tenantId,role:'owner',stagingOnly:true});
  roleAttempted=true;
  gc('iam','roles','update','stagingPhoneTokenSigner','--project=signmons','--stage=GA');
  grantAttempted=true;
  gc('iam','service-accounts','add-iam-policy-binding',sa,...bindingArgs);
  const policy=jsonGc('iam','service-accounts','get-iam-policy',sa,'--project=signmons');
  assert.equal(policy.version,3); assert.equal(policy.bindings.length,1);
  assert.equal(policy.bindings[0].role,role);
  assert.deepEqual(policy.bindings[0].members,['user:debynyhan@signmons.com']);
  assert.equal(policy.bindings[0].condition.title,'staging-phone-one-session');
  console.log('Conditional signBlob-only grant verified.');
  for(let elapsed=0;elapsed<420;elapsed+=30) {
    await new Promise(r=>setTimeout(r,30000));
    console.log(`Propagation wait ${elapsed+30}/420 seconds; no signing attempted.`);
  }
  let ready=false;
  for(let attempt=0;attempt<12;attempt++) {
    const checked=await api(`https://iam.googleapis.com/v1/projects/signmons/serviceAccounts/${sa}:testIamPermissions`,{permissions:['iam.serviceAccounts.signBlob']});
    if(checked.permissions?.includes('iam.serviceAccounts.signBlob')) {ready=true;break;}
    console.log('Waiting for permission propagation; no signing attempted.');
    await new Promise(r=>setTimeout(r,10000));
  }
  assert(ready,'Permission propagation did not complete');
  assert(Date.now()<Date.parse('2026-09-12T22:19:00Z'),'Insufficient cleanup window');
  console.log('Effective signBlob permission observed.');
  const now=Math.floor(Date.now()/1000);
  const encode=x=>Buffer.from(JSON.stringify(x)).toString('base64url');
  const unsigned=encode({alg:'RS256',typ:'JWT'})+'.'+encode({iss:sa,sub:sa,aud:'https://identitytoolkit.googleapis.com/google.identity.identitytoolkit.v1.IdentityToolkit',iat:now,exp:now+300,uid});
  const signed=await api(`https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${sa}:signBlob`,{payload:Buffer.from(unsigned).toString('base64')});
  const customToken=unsigned+'.'+Buffer.from(signed.signedBlob,'base64').toString('base64url');
  identityAttempted=true;
  await identity('update',{localId:uid,disableUser:false});
  const key=JSON.parse(gc('services','api-keys','get-key-string','06cfec12-0432-455f-888f-397d1a0150a6','--project=signmons','--location=global','--format=json')).keyString;
  assert(key);
  const exchanged=await api(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=${encodeURIComponent(key)}`,{token:customToken,returnSecureToken:true},{'content-type':'application/json'});
  idToken=exchanged.idToken;
  const auth=getAuth(initializeApp({projectId:'signmons'}));
  const claims=await auth.verifyIdToken(idToken);
  assert.equal(claims.uid,uid);assert.equal(claims.tenantId,tenantId);assert.equal(claims.role,'owner');
  console.log('Firebase token signature, project, UID, tenant and role verified; tokens not printed.');
  const {runApprovedPhoneTest}=await import('./run-approved-phone-test.mjs');
  await runApprovedPhoneTest(idToken, approvedPhone);
} catch(e) { console.log('Rehearsal failed safely: '+(e instanceof assert.AssertionError?'assertion mismatch':String(e.message).startsWith('API refused')?e.message:'operation failed (details suppressed)'));process.exitCode=1; }
finally {
  for(const [label,fn] of [
    [identityAttempted?'isolated user disabled and refresh tokens revoked':'identity unchanged (enable step not reached)',async()=>{if(identityAttempted)await identity('update',{localId:uid,disableUser:true,validSince:String(Math.floor(Date.now()/1000)+1)});}],
    ['temporary binding removed',async()=>{if(grantAttempted)gc('iam','service-accounts','remove-iam-policy-binding',sa,...bindingArgs);}],
    ['custom role disabled',async()=>{if(roleAttempted)gc('iam','roles','update','stagingPhoneTokenSigner','--project=signmons','--stage=DISABLED');}],
  ])try{await fn();console.log(label);}catch{console.log('CLEANUP NEEDS ATTENTION: '+label);process.exitCode=1;}
  const user=(await identity('lookup',{localId:[uid]})).users[0];
  console.log(JSON.stringify({disabled:user.disabled,validSince:user.validSince}));
  assert.equal(user.disabled,true);
  console.log(JSON.stringify({remainingBindings:jsonGc('iam','service-accounts','get-iam-policy',sa,'--project=signmons').bindings||[],roleStage:jsonGc('iam','roles','describe','stagingPhoneTokenSigner','--project=signmons').stage}));
  if(idToken){const r=await fetch('https://phone-preflight---signmons-calldesk-staging-p572d6wipq-ul.a.run.app/communications/staging-phone-test/operations',{method:'POST',headers:{Authorization:`Bearer ${idToken}`,'content-type':'application/json'},body:'{}',signal:AbortSignal.timeout(15000)});await r.text();console.log(JSON.stringify({afterDisableStatus:r.status}));assert.equal(r.status,401);}
  idToken=undefined;
}
