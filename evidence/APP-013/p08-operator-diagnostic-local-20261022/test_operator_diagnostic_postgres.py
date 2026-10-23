import importlib.util,json,unittest
from pathlib import Path
ROOT=Path(__file__).parent
s=importlib.util.spec_from_file_location('pg_fixture',ROOT/'test_postgres_contract.py');fixture=importlib.util.module_from_spec(s);s.loader.exec_module(fixture)
c=fixture.c
class OperatorDiagnosticPostgreSQL(unittest.TestCase):
 command=classmethod(fixture.PostgreSQLContract.command.__func__)
 setUpClass=classmethod(fixture.PostgreSQLContract.setUpClass.__func__)
 tearDownClass=classmethod(fixture.PostgreSQLContract.tearDownClass.__func__)
 def setUp(self):
  self.command('''DROP TABLE IF EXISTS "User","TenantOrganization" CASCADE;
CREATE TABLE "TenantOrganization"(id uuid PRIMARY KEY,status text);
CREATE TABLE "User"(id uuid PRIMARY KEY,"tenantId" uuid,role text,status text,name text,email text);''')
  self.command(f'''INSERT INTO "TenantOrganization" VALUES ('{c.TENANT}','ACTIVE');''')
 def add(self,n,role='OWNER',status='ACTIVE',tenant=None):
  self.command(f'''INSERT INTO "User" VALUES ('10000000-0000-4000-8000-{n:012d}','{tenant or c.TENANT}','{role}','{status}','PRIVATE_NAME_SENTINEL','PRIVATE_EMAIL_SENTINEL');''')
 def read(self):return self.command(c.OPERATOR_DIAGNOSTIC_SQL)
 def test_real_pg_zero_one_two_and_more_than_two_total_output(self):
  for n in range(5):
   if n:self.add(n,'OWNER' if n==1 else 'ADMIN')
   raw=self.read();v=c.normalize_operator_diagnostic(raw);self.assertEqual(v['eligibleCount'],n);self.assertEqual(len(v['candidates']),min(n,2));self.assertEqual(v['truncated'],n>2);self.assertEqual(v['classification'],'ZERO_ELIGIBLE' if n==0 else 'ONE_ELIGIBLE' if n==1 else 'MULTIPLE_ELIGIBLE');self.assertNotIn('PRIVATE_',raw)
 def test_real_pg_excludes_foreign_inactive_and_disallowed_roles(self):
  self.add(1);self.add(2,status='DISABLED');self.add(3,role='DISPATCHER');self.add(4,tenant='00000000-0000-4000-8000-000000000002');v=c.normalize_operator_diagnostic(self.read());self.assertEqual(v['eligibleCount'],1);self.assertEqual(v['candidates'][0]['id'],'10000000-0000-4000-8000-000000000001')
 def test_real_pg_order_cap_and_json_boolean_encoding(self):
  for n in [5,3,4,1,2]:self.add(n,'ADMIN')
  raw=json.loads(self.read());self.assertIs(raw['truncated'],True);self.assertEqual(raw['actorCount'],5);self.assertEqual([x['id'] for x in raw['actors']],['10000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000002'])
 def test_real_pg_absent_inactive_tenant_are_invalid_not_zero(self):
  for sql in ['UPDATE "TenantOrganization" SET status=\'DISABLED\'','DELETE FROM "TenantOrganization"']:
   self.command(sql);v=c.normalize_operator_diagnostic(self.read());self.assertEqual(v['classification'],'INVALID_OUTPUT');self.assertIsNone(v['eligibleCount'])
 def test_real_pg_readonly_write_refusal_and_session_absence(self):
  self.add(1)
  with self.assertRaises(AssertionError):self.command('BEGIN READ ONLY; DELETE FROM "User"; ROLLBACK;')
  self.assertEqual(c.normalize_operator_diagnostic(self.read())['eligibleCount'],1);self.assertEqual(self.command(c.CLOSEOUT_SQL),'0')
if __name__=='__main__':unittest.main()
