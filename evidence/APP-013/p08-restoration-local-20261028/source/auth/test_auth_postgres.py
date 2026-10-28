import importlib.util,json,subprocess,unittest
from pathlib import Path
ROOT=Path(__file__).parent
s=importlib.util.spec_from_file_location('existing_owned_socket_fixture',ROOT/'reuse/test_postgres_contract.py');fixture=importlib.util.module_from_spec(s);s.loader.exec_module(fixture)
SPEC={'id':'10000000-0000-4000-8000-000000000001','tenantId':'a1adcfd4-15be-404b-9ac3-5edb1fda20f0','email':'operator@fixture.invalid','fullName':'Signmons Test Administrator','role':'ADMIN','status':'DISABLED'}
class AuthPostgreSQL(fixture.PostgreSQLContract):
 @classmethod
 def setUpClass(cls):
  super().setUpClass()
  try:
   backend=Path(json.loads((ROOT/'local-plan.json').read_text())['backend'])
   for file in sorted((backend/'prisma/migrations').glob('*/migration.sql')):cls.command(file.read_text())
  except BaseException:cls.tearDownClass();raise
 def setUp(self):
  self.command('TRUNCATE "TenantOrganization" CASCADE;')
  self.command(f'''INSERT INTO "TenantOrganization"(id,name,timezone,"updatedAt") VALUES('{SPEC['tenantId']}','Fictional tenant','UTC',now()); INSERT INTO "User"(id,"tenantId",email,"fullName",role,status,"updatedAt") VALUES('{SPEC['id']}','{SPEC['tenantId']}','operator@fixture.invalid','Signmons Test Administrator','ADMIN','DISABLED','2026-01-01');''')
 def invoke(self,mode,version=None,spec=SPEC):
  r=subprocess.run([fixture.c.NODE,str(ROOT/'auth-adapters.mjs'),'--fixture-sql'],input=json.dumps({'host':str(self.socket),'port':self.port,'mode':mode,'version':version,'spec':spec}).encode(),capture_output=True,timeout=10,env=self.env,cwd=ROOT);return r.returncode,json.loads(r.stdout)
 def test_01_actual_predicate_roundtrip_retains_row_and_audit(self):
  self.command(f'''INSERT INTO "AuditLog"(id,"tenantId",action,"actorType","actorUserId","actorUserTenantId","actorId","entityType","entityId") VALUES('50000000-0000-4000-8000-000000000001','{SPEC['tenantId']}','LOCAL_AUTH_TEST','USER','{SPEC['id']}','{SPEC['tenantId']}','{SPEC['id']}','User','{SPEC['id']}');''')
  audit=self.command('SELECT row_to_json(a)::text FROM "AuditLog" a;')
  _,before=self.invoke('read');code,active=self.invoke('activate',before['updatedAt']);self.assertEqual(code,0);self.assertEqual(active['status'],'ACTIVE');self.assertNotEqual(active['updatedAt'],before['updatedAt']);code,disabled=self.invoke('disable',active['updatedAt']);self.assertEqual(code,0);self.assertEqual(disabled['status'],'DISABLED');self.assertEqual(self.command('SELECT count(*) FROM "User";'),'1');self.assertEqual(self.command('SELECT row_to_json(a)::text FROM "AuditLog" a;'),audit);self.assertEqual(self.command("SELECT count(*) FROM pg_stat_activity WHERE application_name='p08-auth-fixture'"),'0')
 def test_02_concurrent_conditional_activation_one_winner(self):
  _,before=self.invoke('read');args=[fixture.c.NODE,str(ROOT/'auth-adapters.mjs'),'--fixture-sql'];payload=json.dumps({'host':str(self.socket),'port':self.port,'mode':'activate','version':before['updatedAt'],'spec':SPEC}).encode();ps=[subprocess.Popen(args,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,env=self.env,cwd=ROOT) for _ in range(2)]
  try:
   for p in ps:p.stdin.write(payload);p.stdin.close();p.stdin=None
   results=[p.communicate(timeout=15) for p in ps];self.assertEqual(sum(p.returncode==0 for p in ps),1);self.assertEqual(self.command('SELECT status::text FROM "User";'),'ACTIVE')
   _,row=self.invoke('read');self.assertEqual(self.invoke('disable',row['updatedAt'])[0],0)
  finally:
   for p in ps:
    if p.poll() is None:p.kill();p.wait(timeout=5)
 def test_03_foreign_missing_wrong_role_and_stale_refuse(self):
  _,row=self.invoke('read')
  for patch in [{'tenantId':'40000000-0000-4000-8000-000000000001'},{'id':'40000000-0000-4000-8000-000000000001'},{'email':'foreign@fixture.invalid'},{'fullName':'Foreign'}]:self.assertNotEqual(self.invoke('activate',row['updatedAt'],{**SPEC,**patch})[0],0)
  self.assertNotEqual(self.invoke('activate','2025-01-01T00:00:00Z')[0],0)
  self.command('UPDATE "User" SET role=\'TECH\';');self.assertNotEqual(self.invoke('activate',row['updatedAt'])[0],0);self.assertEqual(self.command('SELECT status::text FROM "User";'),'DISABLED')
 def test_04_already_active_and_changed_version_no_cleanup_takeover(self):
  _,row=self.invoke('read');code,active=self.invoke('activate',row['updatedAt']);self.assertEqual(code,0);self.assertNotEqual(self.invoke('activate',row['updatedAt'])[0],0);self.assertNotEqual(self.invoke('disable',row['updatedAt'])[0],0);self.assertEqual(self.command('SELECT status::text FROM "User";'),'ACTIVE');self.assertEqual(self.invoke('disable',active['updatedAt'])[0],0)
 def test_05_tcp_refuses_before_connection(self):
  r=subprocess.run([fixture.c.NODE,str(ROOT/'auth-adapters.mjs'),'--fixture-sql'],input=json.dumps({'host':'127.0.0.1','port':5432,'mode':'read'}).encode(),capture_output=True,timeout=5,env=self.env);self.assertNotEqual(r.returncode,0);self.assertIn('OWNED_SOCKET_ONLY',r.stdout.decode())
for name in list(fixture.PostgreSQLContract.__dict__):
 if name.startswith('test_'):setattr(AuthPostgreSQL,name,None)
if __name__=='__main__':unittest.main()
