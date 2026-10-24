import importlib.util,json,subprocess,unittest
from pathlib import Path
ROOT=Path(__file__).parent
s=importlib.util.spec_from_file_location('reused_operator_fixture',ROOT/'reuse/test_operator_postgres.py');f=importlib.util.module_from_spec(s);s.loader.exec_module(f)
NODE=f.fixture.c.NODE;ACTOR=f.ACTOR;TENANT=f.TENANT;OTHER=f.OTHER
class AccountPostgreSQL(f.OperatorPostgreSQL):
 def execute_account(self,mode='pair'):
  return subprocess.run([NODE,str(ROOT/'pg-account-proof.mjs')],input=json.dumps({'host':str(self.socket),'port':self.port,'mode':mode}).encode(),capture_output=True,timeout=15,env=self.env,cwd=ROOT)
 def result(self,mode='pair'):
  r=self.execute_account(mode);self.assertEqual(r.returncode,0,r.stdout.decode());self.assertEqual(self.command("SELECT count(*) FROM pg_stat_activity WHERE application_name='p08-account-disposable';"),'0');return json.loads(r.stdout)
 def test_disabled_pair_in_actual_schema(self):
  r=self.result();self.assertEqual(r['status'],'LOCAL_DISABLED_PAIR_PREPARED');self.assertEqual(self.command('SELECT status::text||\'|\'||role::text FROM "User";'),'DISABLED|ADMIN');self.assertFalse(r['liveAction'])
 def test_independent_cleanup_retains_actual_same_tenant_audit_fk(self):
  r=self.result('retention');self.assertEqual(r['status'],'LOCAL_DISABLED_PAIR_CLOSED');self.assertTrue(r['auditRetained']);self.assertEqual(r['residuals'],[])
 def test_uuid_and_tenant_email_collision_preserve_existing_person(self):
  for collision in ['uuid','email']:
   self.setUp();id=ACTOR if collision=='uuid' else '40000000-0000-4000-8000-000000000001';tenant=OTHER if collision=='uuid' else TENANT
   self.command(f'''INSERT INTO "User"(id,"tenantId",email,"fullName",role,status,"updatedAt") VALUES('{id}','{tenant}','operator@fixture.invalid','Existing fictional person','TECH','ACTIVE',now());''');before=self.command('SELECT row_to_json(u)::text FROM "User" u;');r=self.result();self.assertEqual(r['failureCode'],'APP_COLLISION');self.assertEqual(self.command('SELECT row_to_json(u)::text FROM "User" u;'),before)
 def test_unknown_sql_response_preserves_disabled_row_reports_unconfirmed(self):
  r=self.result('lost-sql');self.assertEqual(r['status'],'LOCAL_CLOSEOUT_UNCONFIRMED');self.assertIn('APP_CREATE_OUTCOME_UNKNOWN',r['residuals']);self.assertFalse(r['appOwned']);self.assertEqual(self.command('SELECT status::text FROM "User";'),'DISABLED')
 def test_unknown_firebase_response_never_claims_cleanup(self):
  r=self.result('lost-firebase');self.assertEqual(r['status'],'LOCAL_CLOSEOUT_UNCONFIRMED');self.assertIn('FIREBASE_CREATE_OUTCOME_UNKNOWN_NO_TAKEOVER',r['residuals']);self.assertTrue(r['appOwned']);self.assertFalse(r['firebaseOwned']);self.assertEqual(self.command('SELECT status::text FROM "User";'),'DISABLED')
 def test_claim_failure_closes_confirmed_owned_pair(self):
  r=self.result('claims-failure');self.assertEqual(r['status'],'LOCAL_DISABLED_PAIR_CLOSED');self.assertEqual(r['failureStage'],'FIREBASE_CLAIMS');self.assertEqual(r['residuals'],[])
 def test_actual_concurrent_create_one_winner_no_overwrite(self):
  data=json.dumps({'host':str(self.socket),'port':self.port,'mode':'pair'}).encode();ps=[subprocess.Popen([NODE,str(ROOT/'pg-account-proof.mjs')],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,env=self.env,cwd=ROOT) for _ in range(2)]
  try:
   for p in ps:p.stdin.write(data);p.stdin.close();p.stdin=None
   results=[]
   for p in ps:
    out,err=p.communicate(timeout=15);self.assertEqual(p.returncode,0,out.decode());results.append(json.loads(out))
   self.assertEqual(sum(r['status']=='LOCAL_DISABLED_PAIR_PREPARED' for r in results),1);self.assertEqual(self.command('SELECT count(*) FROM "User";'),'1');self.assertEqual(self.command('SELECT status::text FROM "User";'),'DISABLED')
  finally:
   for p in ps:
    if p.poll() is None:p.kill();p.wait(timeout=5)
 def test_tcp_refused_before_connection(self):
  r=subprocess.run([NODE,str(ROOT/'pg-account-proof.mjs')],input=json.dumps({'host':'127.0.0.1','port':5432,'mode':'pair'}).encode(),capture_output=True,timeout=5,env=self.env,cwd=ROOT);self.assertNotEqual(r.returncode,0)
for base in [f.OperatorPostgreSQL,f.fixture.PostgreSQLContract]:
 for name in base.__dict__:
  if name.startswith('test_'):setattr(AccountPostgreSQL,name,None)
del base
if __name__=='__main__':unittest.main()
