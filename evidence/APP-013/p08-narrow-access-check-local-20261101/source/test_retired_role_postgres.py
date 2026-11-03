"""Approved local proof: fixed role query against an owned disposable Unix-socket PG only."""
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import signal
import time
import unittest
import access_check as a

PRIOR=a.APP/'p08-restoration-local-20261028/source/auth/reuse/test_postgres_contract.py'
spec=importlib.util.spec_from_file_location('retired_owned_fixture',PRIOR)
fixture=importlib.util.module_from_spec(spec);spec.loader.exec_module(fixture)

class RetiredRolePostgres(unittest.TestCase):
    @classmethod
    def command(cls,sql=None,args=None):
        if sql is not None:args=[str(fixture.PG/'psql'),'-X','-q','-A','-t','-v','ON_ERROR_STOP=1','-h',str(cls.socket),'-p',cls.port,'-U','neondb_owner','-d','neondb']
        result=subprocess.run(args,input=sql.encode() if sql else None,capture_output=True,env=cls.env,timeout=20)
        if result.returncode:raise AssertionError('DISPOSABLE_POSTGRES_FAILED: '+result.stderr.decode()[:2000])
        return result.stdout.decode().strip()

    @classmethod
    def setUpClass(cls):
        fixture.PostgreSQLContract.setUpClass.__func__(cls)
        try:
            for p in sorted((a.BACKEND/'prisma/migrations').glob('*/migration.sql')):cls.command(p.read_text())
            cls.fixture_sql=(a.BACKEND/'scripts/fixtures/p07-payment-runtime-role-review.sql').read_bytes()
            assert a.digest(cls.fixture_sql)==a.ROLE_FIXTURE_SHA
            cls.restore=a.sources()[2]
        except BaseException:
            fixture.PostgreSQLContract.tearDownClass.__func__(cls);raise

    @classmethod
    def tearDownClass(cls):
        path=Path(cls.temp.name)
        fixture.PostgreSQLContract.tearDownClass.__func__(cls)
        assert (not hasattr(cls,'server') or cls.server.poll() is not None) and not path.exists()
        print(json.dumps({'status':'OWNED_POSTGRES_CLEANUP_VERIFIED','serverReaped':True,'scratchAbsent':True,'providerCalls':0}))

    def setUp(self):
        self.command("DROP TABLE IF EXISTS role_owned_fixture; DROP FUNCTION IF EXISTS public.role_extra();")
        self.command("DROP OWNED BY p07_payment_runtime; DROP ROLE p07_payment_runtime;" if self.command("SELECT count(*) FROM pg_roles WHERE rolname='p07_payment_runtime'")=='1' else 'SELECT 1;')
        self.command('REVOKE ALL ON DATABASE neondb FROM PUBLIC; REVOKE CREATE ON SCHEMA public FROM PUBLIC;')
        self.command(self.fixture_sql.decode()+ '\nGRANT CONNECT ON DATABASE neondb TO p07_payment_runtime;')
        self.expected={'fixtureSha256':a.ROLE_FIXTURE_SHA,'database':'neondb','user':'neondb_owner','acl':a.expected_retired_acl()}

    def observation(self):return json.loads(self.command(a.retired_role_query()))
    def classify(self):return a.classify_retired_role(self.observation(),self.expected['acl'])
    def argv(self,user='neondb_owner'):
        return [str(fixture.PG/'psql'),'-X','-q','-A','-t','-v','ON_ERROR_STOP=1','-h',str(self.socket),'-p',self.port,'-U',user,'-d','neondb']
    def sql_port(self):
        case=self
        class LocalSQL:
            proof=True
            calls=0
            closed=False
            def sql(self,query,deadline):
                if query!=a.retired_role_query():raise a.Stop('SQL_SCOPE')
                assert str(case.socket).startswith('/private/tmp/p08-pg-') and case.socket.resolve()==case.socket
                self.calls+=1
                result=subprocess.run(case.argv(),input=query.encode(),capture_output=True,env=case.env,timeout=max(.01,min(16,deadline-time.time())))
                if result.returncode:raise a.Stop('LOCAL_SQL_REFUSED')
                return result.stdout.strip()
            def close(self,deadline):
                self.closed=True
                return case.command("SELECT count(*) FROM pg_stat_activity WHERE datname='neondb' AND pid<>pg_backend_pid() AND backend_type='client backend'")=='0'
        return LocalSQL()

    def test_01_actual_fixture_baseline_legacy_hash_and_single_injected_query(self):
        value=self.observation();result=self.classify()
        adapter=self.restore.NativeAdapter(None,'synthetic',sql=lambda sql,deadline:self.command(sql))
        legacy=adapter.role(0)['acl']
        self.assertEqual(result['roleAclSha256'],self.restore.digest(legacy))
        self.assertGreater(len(value['acl']),len(legacy));self.assertTrue(any(row['kind']=='column' for row in value['acl']))
        io=self.sql_port();output=a.retired_role_evidence(io,self.expected,time.time()+16)
        self.assertEqual(output,result);self.assertEqual(io.calls,1);self.assertTrue(io.closed)
        self.assertEqual(self.command("SELECT count(*) FROM pg_stat_activity WHERE usename='p07_payment_runtime'"),'0')

    def test_lifecycle_query_adds_only_expiry_and_preserves_acl_projection(self):
        retired=self.observation();lifecycle=json.loads(self.command(a.lifecycle_role_query()))
        expiry=lifecycle.pop('expires')
        self.assertEqual(lifecycle,retired);self.assertTrue(isinstance(expiry,str))
        result,legacy=a.classify_role_acl(lifecycle['acl'],'neondb',a.expected_retired_acl())
        self.assertEqual(result['roleAclSha256'],a.digest(legacy))
        self.assertEqual(result['roleAclSha256'],self.classify()['roleAclSha256'])

    def test_02_column_drift_that_legacy_hash_misses_refuses(self):
        before=self.classify();adapter=self.restore.NativeAdapter(None,'synthetic',sql=lambda sql,deadline:self.command(sql))
        self.command('GRANT UPDATE ("status") ON "Job" TO p07_payment_runtime;')
        self.assertEqual(self.restore.digest(adapter.role(0)['acl']),before['roleAclSha256'])
        with self.assertRaisesRegex(a.Stop,'ROLE_ACL_DRIFT'):self.classify()

    def test_03_missing_extra_and_grant_option_refuse(self):
        statements=['REVOKE UPDATE ("updatedAt") ON "TenantOrganization" FROM p07_payment_runtime',
                    'GRANT UPDATE ON "Job" TO p07_payment_runtime',
                    'GRANT SELECT ON "Job" TO p07_payment_runtime WITH GRANT OPTION',
                    'GRANT CREATE ON SCHEMA public TO p07_payment_runtime',
                    'GRANT TEMP ON DATABASE neondb TO p07_payment_runtime',
                    'REVOKE CONNECT ON DATABASE neondb FROM p07_payment_runtime',
                    'CREATE FUNCTION public.role_extra() RETURNS integer LANGUAGE sql AS $$SELECT 1$$; GRANT EXECUTE ON FUNCTION public.role_extra() TO p07_payment_runtime',
                    'ALTER DEFAULT PRIVILEGES FOR ROLE neondb_owner GRANT SELECT ON TABLES TO p07_payment_runtime']
        for statement in statements:
            with self.subTest(statement=statement):
                self.setUp();self.command(statement)
                with self.assertRaises(a.Stop):self.classify()

    def test_04_role_flags_expiry_membership_ownership_and_absence_refuse(self):
        for statement in ['ALTER ROLE p07_payment_runtime LOGIN','ALTER ROLE p07_payment_runtime CONNECTION LIMIT 6',
                          "ALTER ROLE p07_payment_runtime VALID UNTIL 'infinity'","ALTER ROLE p07_payment_runtime VALID UNTIL '2099-01-01'",
                          'ALTER ROLE p07_payment_runtime INHERIT','ALTER ROLE p07_payment_runtime CREATEDB',
                          'GRANT neondb_owner TO p07_payment_runtime',
                          'CREATE TABLE role_owned_fixture(id int); ALTER TABLE role_owned_fixture OWNER TO p07_payment_runtime',
                          'DROP OWNED BY p07_payment_runtime; DROP ROLE p07_payment_runtime']:
            with self.subTest(statement=statement):
                self.setUp();self.command(statement)
                with self.assertRaises(a.Stop):self.classify()

    def test_05_public_effective_privileges_refuse_without_direct_acl_drift(self):
        for statement in ['GRANT CREATE ON SCHEMA public TO PUBLIC','GRANT TEMP ON DATABASE neondb TO PUBLIC']:
            with self.subTest(statement=statement):
                self.setUp();before=self.observation()['acl'];self.command(statement)
                self.assertEqual(self.observation()['acl'],before)
                with self.assertRaisesRegex(a.Stop,'ROLE_NOT_READY'):self.classify()

    def test_06_actual_role_session_refuses_then_closes(self):
        self.command('ALTER ROLE p07_payment_runtime LOGIN CONNECTION LIMIT 1')
        child=subprocess.Popen(self.argv('p07_payment_runtime'),stdin=subprocess.PIPE,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,env=self.env)
        try:
            child.stdin.write(b'SELECT pg_sleep(10);\n');child.stdin.flush()
            for _ in range(100):
                if self.command("SELECT count(*) FROM pg_stat_activity WHERE usename='p07_payment_runtime'")=='1':break
                time.sleep(.02)
            else:self.fail('LOCAL_SESSION_NOT_OBSERVED')
            self.command('ALTER ROLE p07_payment_runtime NOLOGIN CONNECTION LIMIT 0')
            with self.assertRaisesRegex(a.Stop,'ROLE_NOT_READY'):self.classify()
        finally:
            if child.poll() is None:child.send_signal(signal.SIGINT)
            child.communicate(timeout=15)
        for _ in range(100):
            if self.command("SELECT count(*) FROM pg_stat_activity WHERE usename='p07_payment_runtime'")=='0':break
            time.sleep(.02)
        self.assertEqual(self.classify()['status'],'ROLE_CONTRACT_LOCAL_VERIFIED')

    def test_07_readonly_statement_timeout_lock_and_interruption_cleanup(self):
        with self.assertRaises(AssertionError):self.command('BEGIN READ ONLY; ALTER ROLE p07_payment_runtime LOGIN; ROLLBACK;')
        with self.assertRaises(AssertionError):self.command("SET statement_timeout='20ms'; SELECT pg_sleep(1);")
        holder=subprocess.Popen(self.argv(),stdin=subprocess.PIPE,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,env=self.env)
        try:
            holder.stdin.write(b'BEGIN; LOCK TABLE "Job" IN ACCESS EXCLUSIVE MODE; SELECT pg_sleep(10);\n');holder.stdin.flush()
            for _ in range(100):
                if self.command("SELECT count(*) FROM pg_locks WHERE relation='\"Job\"'::regclass AND mode='AccessExclusiveLock' AND granted")=='1':break
                time.sleep(.02)
            else:self.fail('LOCAL_LOCK_NOT_OBSERVED')
            with self.assertRaises(AssertionError):self.command('BEGIN READ ONLY; SET LOCAL lock_timeout=\'20ms\'; SELECT count(*) FROM "Job"; ROLLBACK;')
            # Catalog proof does not need a business-table lock or business-row payload.
            self.assertEqual(self.classify()['status'],'ROLE_CONTRACT_LOCAL_VERIFIED')
        finally:
            if holder.poll() is None:holder.send_signal(signal.SIGINT)
            holder.communicate(timeout=15)
        # Interrupt an owned local query process; never signal a guessed external PID.
        child=subprocess.Popen(self.argv(),stdin=subprocess.PIPE,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,env=self.env)
        try:
            child.stdin.write(b'SELECT pg_sleep(10);\n');child.stdin.flush();child.terminate();child.communicate(timeout=15)
        finally:
            if child.poll() is None:child.kill();child.wait(timeout=5)
        self.assertTrue(self.sql_port().close(time.time()+5))

if __name__=='__main__':unittest.main()
