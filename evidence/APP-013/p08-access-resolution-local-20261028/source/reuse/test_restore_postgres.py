import datetime as dt,importlib.util,json,subprocess,unittest
from pathlib import Path
import restore as r
ROOT=Path(__file__).parent
s=importlib.util.spec_from_file_location('owned_socket_fixture',ROOT/'auth/reuse/test_postgres_contract.py');fixture=importlib.util.module_from_spec(s);s.loader.exec_module(fixture)
class RestorePostgreSQL(fixture.PostgreSQLContract):
 @classmethod
 def command(cls,sql=None,args=None):
  if sql is not None:args=[str(fixture.PG/'psql'),'-X','-q','-A','-t','-v','ON_ERROR_STOP=1','-h',str(cls.socket),'-p',cls.port,'-U','neondb_owner','-d','neondb']
  v=subprocess.run(args,input=sql.encode() if sql else None,capture_output=True,env=cls.env,timeout=20)
  if v.returncode:raise AssertionError('DISPOSABLE_FIXTURE_SQL: '+v.stderr.decode())
  return v.stdout.decode().strip()
 @classmethod
 def setUpClass(cls):
  super().setUpClass()
  try:
   backend=Path(json.loads((ROOT/'auth/local-plan.json').read_text())['backend'])
   for p in sorted((backend/'prisma/migrations').glob('*/migration.sql')):cls.command(p.read_text())
  except BaseException:cls.tearDownClass();raise
 def setUp(self):
  self.command("DROP OWNED BY p07_payment_runtime; DROP ROLE p07_payment_runtime;" if self.command("SELECT count(*) FROM pg_roles WHERE rolname='p07_payment_runtime'")=='1' else 'SELECT 1;')
  self.command("CREATE ROLE p07_payment_runtime NOLOGIN NOINHERIT CONNECTION LIMIT 0 VALID UNTIL '2000-01-01'; GRANT USAGE ON SCHEMA public TO p07_payment_runtime; GRANT SELECT ON \"Job\" TO p07_payment_runtime;")
  self.adapter=r.NativeAdapter(None,'synthetic',sql=lambda text,deadline:self.command(text));self.adapter.q={'roleAclSha256':r.digest(self.adapter.role(0)['acl'])}
  end=(dt.datetime.now(dt.timezone.utc)+dt.timedelta(minutes=5)).strftime('%Y-%m-%dT%H:%M:%SZ');self.p={'window':{'workEnd':end}}
 def test_01_real_role_lifecycle_and_acl_unchanged(self):
  before=self.adapter.role(0);self.assertTrue(self.adapter.readback('role',r.ROLE,False,self.p,0));self.command(r.role_sql(True,self.p['window']['workEnd']));self.assertTrue(self.adapter.readback('role',r.ROLE,True,self.p,0));self.command(r.role_sql(False));self.assertTrue(self.adapter.readback('role',r.ROLE,False,self.p,0));self.assertEqual(self.adapter.role(0)['acl'],before['acl'])
 def test_02_changed_membership_privilege_ownership_and_flags_refuse(self):
  for sql in ["GRANT neondb_owner TO p07_payment_runtime",'GRANT UPDATE ON "Job" TO p07_payment_runtime','ALTER ROLE p07_payment_runtime INHERIT','CREATE TABLE role_owned_fixture(id int); ALTER TABLE role_owned_fixture OWNER TO p07_payment_runtime']:
   with self.subTest(sql=sql):
    self.setUp();self.command(sql);self.assertFalse(self.adapter.readback('role',r.ROLE,False,self.p,0))
 def test_03_missing_role_and_wrong_connection_limit_refuse(self):
  self.command('ALTER ROLE p07_payment_runtime CONNECTION LIMIT 6');self.assertFalse(self.adapter.readback('role',r.ROLE,False,self.p,0));self.command('DROP OWNED BY p07_payment_runtime;DROP ROLE p07_payment_runtime');self.assertFalse(self.adapter.readback('role',r.ROLE,False,self.p,0))
 def test_04_expiry_and_no_password_reset_in_serialized_sql(self):
  sql=r.role_sql(True,self.p['window']['workEnd']);self.assertNotIn('PASSWORD',sql);self.assertNotIn('GRANT',sql);self.command(sql);v=self.adapter.role(0);self.assertLessEqual(dt.datetime.fromisoformat(v['expires']).timestamp(),r.timestamp(self.p['window']['workEnd']))
 def test_05_actual_runtime_connection_and_zero_session_termination(self):
  self.command(r.role_sql(True,self.p['window']['workEnd']))
  # Unix-socket, trust-auth, synthetic role; no live password or TCP target.
  args=[str(fixture.PG/'psql'),'-X','-q','-h',str(self.socket),'-p',self.port,'-U',r.ROLE,'-d','neondb','-c','SELECT pg_sleep(30)'];child=subprocess.Popen(args,stdout=subprocess.PIPE,stderr=subprocess.PIPE,env=self.env)
  try:
   import time
   for _ in range(100):
    if self.adapter.role(0)['sessions']>0:break
    time.sleep(.02)
   self.assertGreater(self.adapter.role(0)['sessions'],0);self.command(r.role_sql(False));child.communicate(timeout=5);self.assertTrue(self.adapter.readback('role',r.ROLE,False,self.p,0))
  finally:
   if child.poll() is None:child.kill();child.wait(timeout=5)
 def test_06_no_tcp_listener_and_current_schema_retained(self):
  self.assertEqual(self.command('SHOW listen_addresses'),'');self.assertEqual(self.command("SELECT count(*) FROM information_schema.tables WHERE table_schema='public' AND table_name IN ('Job','User','AuditLog')"),'3');self.assertFalse(self.adapter.role(0)['login'])
for name in list(fixture.PostgreSQLContract.__dict__):
 if name.startswith('test_'):setattr(RestorePostgreSQL,name,None)
if __name__=='__main__':unittest.main()
