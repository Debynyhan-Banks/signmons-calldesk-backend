import importlib.util,json,subprocess,unittest
from pathlib import Path
ROOT=Path(__file__).parent
s=importlib.util.spec_from_file_location('owned_existing_pg_fixture',ROOT/'reuse/test_postgres_contract.py');fixture=importlib.util.module_from_spec(s);s.loader.exec_module(fixture)
plan=json.loads((ROOT/'operator-plan.json').read_text());BACKEND=Path(plan['backend']);ACTOR=plan['syntheticActorId'];TENANT=plan['syntheticTenantId'];OTHER=plan['syntheticOtherTenantId']
class OperatorPostgreSQL(fixture.PostgreSQLContract):
 @classmethod
 def setUpClass(cls):
  super().setUpClass()
  try:
   for file in sorted((BACKEND/'prisma/migrations').glob('*/migration.sql')):cls.command(file.read_text())
  except BaseException:cls.tearDownClass();raise
 def setUp(self):
  self.command('TRUNCATE "TenantOrganization" CASCADE;')
  for id in [TENANT,OTHER]:self.command(f'''INSERT INTO "TenantOrganization"(id,name,timezone,"updatedAt") VALUES('{id}','Fictional local tenant','UTC',now());''')
 def execute(self,mode='pair'):
  return subprocess.run([fixture.c.NODE,str(ROOT/'pg-operator-proof.mjs')],input=json.dumps({'host':str(self.socket),'port':self.port,'mode':mode}).encode(),capture_output=True,timeout=40,env=self.env,cwd=ROOT)
 def test_01_actual_schema_disabled_pair_and_unique_constraints(self):
  result=self.execute();self.assertEqual(result.returncode,0,result.stdout.decode());self.assertIn('LOCAL_DISABLED_PAIR_PROVED',result.stdout.decode());self.assertEqual(self.command(f'''SELECT status||'|'||role FROM "User" WHERE id='{ACTOR}';'''),'DISABLED|ADMIN')
  for sql in [f'''INSERT INTO "User" SELECT * FROM "User" WHERE id='{ACTOR}';''',f'''INSERT INTO "User"(id,"tenantId",email,"fullName",role,status,"updatedAt") VALUES('40000000-0000-4000-8000-000000000001','{TENANT}','operator@fixture.invalid','Fictional','ADMIN','DISABLED',now());''']:
   with self.assertRaises(AssertionError):self.command(sql)
  self.assertEqual(self.command('SELECT count(*) FROM "User";'),'1')
 def test_02_full_existing_policy_request_audit_and_disabled_retention(self):
  result=self.execute('flow');self.assertEqual(result.returncode,0,result.stdout.decode());data=json.loads(result.stdout);self.assertEqual(data['status'],'LOCAL_ADMIN_POLICY_REQUEST_AUDIT_AND_DISABLED_RETENTION_PROVED');self.assertEqual(data['mockCheckoutSessions'],1);self.assertEqual(data['logicalPayments'],1);self.assertTrue(data['disabledRowRetained']);self.assertFalse(data['livePayment'])
 def test_03_existing_uuid_or_email_collision_no_overwrite(self):
  for collision in ['uuid','email']:
   self.setUp();id=ACTOR if collision=='uuid' else '40000000-0000-4000-8000-000000000001';tenant=OTHER if collision=='uuid' else TENANT
   self.command(f'''INSERT INTO "User"(id,"tenantId",email,"fullName",role,status,"updatedAt") VALUES('{id}','{tenant}','operator@fixture.invalid','Existing fictional person','TECH','ACTIVE',now());''')
   before=self.command('SELECT row_to_json(u)::text FROM "User" u;');result=self.execute();self.assertNotEqual(result.returncode,0);self.assertEqual(self.command('SELECT row_to_json(u)::text FROM "User" u;'),before)
 def test_04_actual_concurrent_creation_has_one_winner_no_overwrite(self):
  args=[fixture.c.NODE,str(ROOT/'pg-operator-proof.mjs')];data=json.dumps({'host':str(self.socket),'port':self.port,'mode':'race'}).encode();processes=[subprocess.Popen(args,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,env=self.env,cwd=ROOT) for _ in range(2)]
  try:
   for p in processes:p.stdin.write(data);p.stdin.close();p.stdin=None
   for p in processes:p.communicate(timeout=40)
   self.assertEqual(sum(p.returncode==0 for p in processes),1);self.assertEqual(self.command('SELECT count(*) FROM "User";'),'1');self.assertEqual(self.command('SELECT status::text FROM "User";'),'DISABLED')
  finally:
   for p in processes:
    if p.poll() is None:p.kill();p.wait(timeout=5)
 def test_05_required_fields_roles_and_same_tenant_audit_fk(self):
  for sql in [f'''INSERT INTO "User"(id,"tenantId",role,status,"updatedAt") VALUES('{ACTOR}','{TENANT}','ADMIN','DISABLED',now());''',f'''INSERT INTO "User"(id,"tenantId",email,"fullName",role,status,"updatedAt") VALUES('{ACTOR}','{TENANT}','operator@fixture.invalid','Fictional','SUPERADMIN','DISABLED',now());''']:
   with self.assertRaises(AssertionError):self.command(sql)
  result=self.execute('foreign-audit');self.assertEqual(result.returncode,0,result.stdout.decode());self.assertIn('LOCAL_FOREIGN_AUDIT_REFUSED',result.stdout.decode())
 def test_06_adapter_rejects_tcp_before_connection(self):
  r=subprocess.run([fixture.c.NODE,str(ROOT/'pg-operator-proof.mjs')],input=json.dumps({'host':'127.0.0.1','port':5432,'mode':'pair'}).encode(),capture_output=True,timeout=10,env=self.env);self.assertNotEqual(r.returncode,0)
# Inherit only the existing lifecycle/command, never its unrelated tests.
for name in list(fixture.PostgreSQLContract.__dict__):
 if name.startswith('test_'):setattr(OperatorPostgreSQL,name,None)
if __name__=='__main__':unittest.main()
