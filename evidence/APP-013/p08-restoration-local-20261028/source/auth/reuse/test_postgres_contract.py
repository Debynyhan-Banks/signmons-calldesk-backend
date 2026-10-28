import importlib.util,json,os,subprocess,tempfile,time,unittest
from pathlib import Path
from unittest.mock import patch
ROOT=Path(__file__).parent
s=importlib.util.spec_from_file_location('c',ROOT/'controller.py');c=importlib.util.module_from_spec(s);s.loader.exec_module(c)
PG=Path('/opt/homebrew/opt/postgresql@16/bin')
ACTOR='10000000-0000-4000-8000-000000000001'
class PostgreSQLContract(unittest.TestCase):
 @classmethod
 def command(cls,sql=None,args=None):
  if sql is not None:args=[str(PG/'psql'),'-X','-q','-A','-t','-v','ON_ERROR_STOP=1','-h',str(cls.socket),'-p',cls.port,'-U','neondb_owner','-d','neondb']
  r=subprocess.run(args,input=sql.encode() if sql else None,capture_output=True,env=cls.env,timeout=20)
  if r.returncode:raise AssertionError('LOCAL_POSTGRES_COMMAND_FAILED')
  return r.stdout.decode().strip()
 @classmethod
 def setUpClass(cls):
  cls.temp=tempfile.TemporaryDirectory(prefix='p08-pg-',dir='/private/tmp');base=Path(cls.temp.name);cls.data=base/'data';cls.socket=base/'socket';cls.socket.mkdir(mode=0o700);cls.port=str(55000+os.getpid()%1000);cls.env={k:v for k,v in os.environ.items() if not k.startswith('PG') and k!='DATABASE_URL'}
  try:
   cls.command(args=[str(PG/'initdb'),'-D',str(cls.data),'--username=neondb_owner','--auth=trust','--no-locale','--encoding=UTF8'])
   cls.server=subprocess.Popen([str(PG/'postgres'),'-D',str(cls.data),'-k',str(cls.socket),'-p',cls.port,'-F','-c','listen_addresses='],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,env=cls.env)
   for _ in range(100):
    ready=subprocess.run([str(PG/'psql'),'-X','-h',str(cls.socket),'-p',cls.port,'-U','neondb_owner','-d','postgres','-c','SELECT 1'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,env=cls.env)
    if ready.returncode==0:break
    if cls.server.poll() is not None:raise AssertionError('LOCAL_SERVER_FAILED')
    time.sleep(.05)
   else:raise AssertionError('LOCAL_READINESS_TIMEOUT')
   cls.command(args=[str(PG/'createdb'),'-h',str(cls.socket),'-p',cls.port,'-U','neondb_owner','neondb'])
  except BaseException:cls.tearDownClass();raise
 @classmethod
 def tearDownClass(cls):
  if hasattr(cls,'server') and cls.server.poll() is None:
   subprocess.run([str(PG/'pg_ctl'),'-D',str(cls.data),'-m','fast','stop'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,env=cls.env,timeout=10);cls.server.wait(timeout=10)
  if hasattr(cls,'temp'):
   path=Path(cls.temp.name);cls.temp.cleanup();assert not path.exists()
 def setUp(self):
  self.command('''DROP TABLE IF EXISTS "CalendarOperation","Payment","User","Job","TenantOrganization" CASCADE; DROP ROLE IF EXISTS p07_payment_runtime;
 CREATE ROLE p07_payment_runtime NOLOGIN NOINHERIT CONNECTION LIMIT 0 VALID UNTIL '2000-01-01';
 CREATE TABLE "TenantOrganization"(id uuid,status text,settings jsonb,"stripeConnectAccountId" text,"chargesEnabled" boolean);
 CREATE TABLE "User"(id uuid,"tenantId" uuid,role text,status text);
 CREATE TABLE "Job"(id uuid,"tenantId" uuid,status text,"deletedAt" timestamptz,"updatedAt" timestamptz,"calendarEventId" text,"serviceWindowStart" timestamptz,"serviceWindowEnd" timestamptz,"policySnapshot" jsonb,"pricingSnapshot" jsonb);
 CREATE TABLE "Payment"("jobId" uuid,"tenantId" uuid);CREATE TABLE "CalendarOperation"("jobId" uuid,"tenantId" uuid);''')
  js="""const {createRequire}=require('node:module');const r=createRequire(process.argv[1]+'/package.json');const {profile}=r(process.argv[1]+'/dist/tenants/organization-payment-policy.js');const {createHash}=require('node:crypto');const draft={currency:'usd',serviceFeeRequired:false,serviceFeeCents:null,depositRequired:true,depositPolicy:{kind:'fixed',amountCents:12500},emergencyFeePolicy:{kind:'none'},paymentGateMode:'fail_closed',webhookValidationRequired:true};const p={version:1,draft,approved:{draft,actorId:process.argv[2],approvedAt:'2026-10-19T10:00:00.000Z'}};console.log(JSON.stringify({policy:p,digest:createHash('sha256').update(JSON.stringify(profile(p).approved)).digest('hex')}));"""
  generated=json.loads(subprocess.run([c.NODE,'-e',js,str(c.BACKEND),ACTOR],check=True,capture_output=True).stdout)
  policy={'intakeAdmission':{'version':2,'actorId':'signmons-intake-admission-v1','paymentApprovedAt':'2026-10-19T10:00:00.000Z','paymentDigest':generated['digest'],'humanReviewed':False}}
  settings=json.dumps({'organizationPaymentPolicyV1':generated['policy']});snapshot=json.dumps(policy)
  self.command(f'''INSERT INTO "TenantOrganization" VALUES ('{c.TENANT}','ACTIVE','{settings}','acct_localP08only',true);
 INSERT INTO "User" VALUES ('{ACTOR}','{c.TENANT}','OWNER','ACTIVE');
 INSERT INTO "Job" VALUES ('{c.JOB}','{c.TENANT}','CREATED',NULL,'2026-10-19T11:00:00Z',NULL,NULL,NULL,'{snapshot}','{{}}');''')
 def normalized(self):
  raw=self.command(c.QUALIFICATION_SQL)
  js="""import {normalizeDatabase,plan} from './operator-bridge.mjs';import {createHash} from 'node:crypto';let data='';for await(const x of process.stdin)data+=x;try{console.log(JSON.stringify(normalizeDatabase(JSON.parse(data),{...plan,connectedAccountSha256:createHash('sha256').update('acct_localP08only').digest('hex')})));}catch(e){console.log(JSON.stringify({code:e.code??'UNCONFIRMED'}));process.exitCode=1;}"""
  r=subprocess.run([c.NODE,'--input-type=module','-e',js],input=raw.encode(),capture_output=True,cwd=ROOT,timeout=10)
  v=json.loads(r.stdout);return r.returncode,v
 def test_actual_sql_positive_canonical_jsonb_and_readonly_rollback(self):
  code,v=self.normalized();self.assertEqual(code,0);self.assertEqual(v['actorId'],ACTOR);self.assertEqual(v['amountTotalCents'],12500);self.assertFalse(v['businessMutation']);self.assertNotIn('acct_local',json.dumps(v));self.assertEqual(self.command("SELECT count(*) FROM pg_stat_activity WHERE pid<>pg_backend_pid() AND backend_type='client backend'"),'0')
 def test_absent_null_and_foreign_rows_are_total(self):
  for sql in ['DELETE FROM "Job"','DELETE FROM "TenantOrganization"','DELETE FROM "User"','UPDATE "TenantOrganization" SET settings=NULL','UPDATE "Job" SET "policySnapshot"=NULL',f'''UPDATE "User" SET "tenantId"='00000000-0000-4000-8000-000000000002' ''']:
   with self.subTest(sql=sql):self.setUp();self.command(sql);self.assertNotEqual(self.normalized()[0],0)
 def test_inactive_foreign_role_and_ambiguous_actor(self):
  for sql in ['UPDATE "User" SET status=\'DISABLED\'','UPDATE "User" SET role=\'TECH\'',f'''INSERT INTO "User" VALUES ('10000000-0000-4000-8000-000000000002','{c.TENANT}','ADMIN','ACTIVE')''']:
   with self.subTest(sql=sql):self.setUp();self.command(sql);self.assertNotEqual(self.normalized()[0],0)
 def test_role_must_be_closed_expired_without_sessions(self):
  for sql in ["ALTER ROLE p07_payment_runtime LOGIN","ALTER ROLE p07_payment_runtime CONNECTION LIMIT 6","ALTER ROLE p07_payment_runtime VALID UNTIL 'infinity'","ALTER ROLE p07_payment_runtime INHERIT","DROP ROLE p07_payment_runtime"]:
   with self.subTest(sql=sql):self.setUp();self.command(sql);self.assertNotEqual(self.normalized()[0],0)
 def test_activity_and_changed_job_refuse(self):
  for sql in [f'''INSERT INTO "Payment" VALUES ('{c.JOB}','{c.TENANT}')''',f'''INSERT INTO "CalendarOperation" VALUES ('{c.JOB}','{c.TENANT}')''','UPDATE "Job" SET status=\'CANCELLED\'','UPDATE "Job" SET "calendarEventId"=\'local\'','UPDATE "Job" SET "serviceWindowStart"=now()','UPDATE "Job" SET "pricingSnapshot"=\'{"currency":"usd"}\'']:
   with self.subTest(sql=sql):self.setUp();self.command(sql);self.assertNotEqual(self.normalized()[0],0)
 def test_account_mode_policy_null_and_digest_refuse(self):
  for sql in ['UPDATE "TenantOrganization" SET "chargesEnabled"=NULL','UPDATE "TenantOrganization" SET "stripeConnectAccountId"=NULL','UPDATE "TenantOrganization" SET "stripeConnectAccountId"=\'acct_foreign\'','UPDATE "Job" SET "policySnapshot"=jsonb_set("policySnapshot",\'{intakeAdmission,paymentDigest}\',\'"stale"\')','UPDATE "Job" SET "policySnapshot"=jsonb_set("policySnapshot",\'{intakeAdmission,humanReviewed}\',\'true\')']:
   with self.subTest(sql=sql):self.setUp();self.command(sql);self.assertNotEqual(self.normalized()[0],0)
 def test_actual_pg_read_only_transaction_rejects_write(self):
  with self.assertRaises(AssertionError):self.command('BEGIN READ ONLY; UPDATE "Job" SET status=\'COMPLETED\'; ROLLBACK;')
  self.assertEqual(self.command('SELECT status FROM "Job"'),'CREATED')
 def test_existing_real_role_proof_with_actual_guard_and_actor_preflight(self):
  original=(c.BACKEND/'scripts/verify-p07-payment-runtime-role.mjs').read_text();source_url=(c.BACKEND/'scripts/verify-p07-payment-runtime-role.mjs').as_uri();source=original.replace('import.meta.url','SOURCE_URL').replace('import { qualifyRuntimeRole } from "./verify-p06-runtime-role.mjs";',f'import {{ qualifyRuntimeRole }} from "{(c.BACKEND/"scripts/verify-p06-runtime-role.mjs").as_uri()}";')
  inject='''
  // P08 additions; original P07 assertions remain intact.
  const {RequestAuthGuard}=require('../dist/auth/request-auth.guard.js');
  const {qualifyActor}=await import(P08_BRIDGE);
  const realUser=await owner.user.findFirstOrThrow({where:{id:ownerId,tenantId:tenant.id}});
  const authConfig={devAuthEnabled:false,environment:'production'};
  async function guarded(claims,user,token="synthetic"){
   const firebase={getAuth:()=>({verifyIdToken:async(token,checkRevoked)=>{assert.equal(checkRevoked,true);if(token==='disabled'||token==='revoked'||token==='denied')throw Error('mock Firebase refusal');return claims;}})};
   const guard=new RequestAuthGuard(authConfig,firebase);
   return actor({},async()=>{await guard.canActivate({switchToHttp:()=>({getRequest:()=>({header:n=>n==='authorization'?'Bearer '+token:undefined})})});return qualifyActor(claims,user,tenant.id);});
  }
  const beforeCalls=mockCheckoutCalls;
  for(const token of ['disabled','revoked','denied'])await assert.rejects(guarded({sub:ownerId,tenantId:tenant.id,role:'owner'},realUser,token));
  await assert.rejects(guarded({sub:'staging-phone-text-fixture',tenantId:tenant.id,role:'owner'},realUser));
  await assert.rejects(guarded({sub:ownerId,tenantId:tenant.id,role:'owner'},null));
  await assert.rejects(guarded({sub:ownerId,tenantId:otherTenant.id,role:'owner'},realUser));
  await assert.rejects(guarded({sub:ownerId,tenantId:tenant.id,role:'owner'},{...realUser,status:'DISABLED'}));
  assert.equal(mockCheckoutCalls,beforeCalls);
  assert.equal(await guarded({sub:ownerId,tenantId:tenant.id,role:'owner'},realUser),ownerId);
  pass('P08 real guard preserves revoked check; actual UUID/same-tenant actor required before mocked Checkout');
'''
  target='  const context = { tenantId: tenant.id, userId: ownerId, role: "owner" };';self.assertEqual(source.count(target),1);source=source.replace(target,inject+'\n'+target)
  source='const SOURCE_URL='+json.dumps(source_url)+';\nconst P08_BRIDGE='+json.dumps((ROOT/'operator-bridge.mjs').as_uri())+';\n'+source
  with tempfile.TemporaryDirectory(prefix='p08-proof-',dir='/private/tmp') as root:
   file=Path(root)/'proof.mjs';file.write_text(source)
   r=subprocess.run([c.NODE,str(file)],capture_output=True,cwd=c.BACKEND,timeout=150)
   summary=json.loads(r.stdout.decode().strip().splitlines()[-1]);self.assertEqual(r.returncode,0,summary);self.assertEqual(summary['status'],'LOCAL_PERMISSION_PROOF_PASSED');self.assertEqual(summary['providerCalls'],0);self.assertEqual(summary['secretCalls'],0);self.assertEqual(summary['interruptionProof'],'INTERRUPTION_CONTAINED');self.assertTrue(summary['cleanup']['clusterStopped']);self.assertTrue(summary['cleanup']['scratchRemoved']);(ROOT/'real-role-proof-summary.json').write_text(json.dumps(summary,indent=2)+'\n')
if __name__=='__main__':unittest.main()
