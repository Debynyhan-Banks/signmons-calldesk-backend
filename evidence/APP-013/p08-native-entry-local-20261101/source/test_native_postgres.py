"""New transport factory/child tested on the existing owned TLS PostgreSQL fixture."""
import importlib.util
import json
from pathlib import Path
import subprocess
import unittest
import time
import os
from types import SimpleNamespace
import entry
from native_io import NativeIO, load_acl
from private_inventory import Stop
import test_entry
from fixture_envelope import child_fixture
from authority import digest

ROOT=Path(__file__).resolve().parent
spec=importlib.util.spec_from_file_location('existing_bound_tls_fixture',ROOT.parent.parent/'p08-real-client-binding-local-20261031/source/test_bound_postgres.py')
prior=importlib.util.module_from_spec(spec);spec.loader.exec_module(prior)

class NativePostgres(prior.BoundPostgreSQL):
    def check_scenario(self,scenario):
        t=test_entry.EntryTests();t.setUp()
        try:
            t.e['database']={'host':'127.0.0.1','port':int(self.port),'database':'neondb','user':'neondb_owner'}
            t.e['qualification']['scopeSha256']=digest({k:t.e[k] for k in ('plan','target','database','resources','limits')})
            t.seal();request=child_fixture(t)
            r=subprocess.run([prior.historical.fixture.c.NODE,str(ROOT/'postgres_driver.mjs')],
                input=json.dumps({'request':request,'cert':str(self.cert),'scenario':scenario}).encode(),
                capture_output=True,timeout=25,env=self.env,cwd=ROOT)
            self.assertEqual(r.returncode,0,r.stderr.decode())
            self.assertEqual(json.loads(r.stdout),{'status':'PASS','providerCalls':0})
            self.assertEqual(self.command("SELECT count(*) FROM pg_stat_activity WHERE application_name LIKE 'p08-auth-%' OR application_name LIKE 'p08-runtime-%'"),'0')
        finally:t.doCleanups()

class LifecyclePostgres(NativePostgres):
    # Separate class shares owned TLS fixture, without repeating inherited scenario tests.
    @classmethod
    def tearDownClass(cls):
        scratch=Path(cls.temp.name)
        super().tearDownClass()
        assert cls.server.poll() is not None and not scratch.exists()
        print(json.dumps({'status':'LIFECYCLE_TLS_CLEANUP_VERIFIED','serverReaped':True,'scratchAbsent':True,'providerCalls':0}))

    def setUp(self):
        super().setUp()
        self.acl=load_acl()
        if self.command("SELECT count(*) FROM pg_roles WHERE rolname='p07_payment_runtime'")=='1':
            self.command('DROP OWNED BY p07_payment_runtime; DROP ROLE p07_payment_runtime;')
        self.command('REVOKE ALL ON DATABASE neondb FROM PUBLIC; REVOKE CREATE ON SCHEMA public FROM PUBLIC;')
        fixture=(test_entry.a.BACKEND/'scripts/fixtures/p07-payment-runtime-role-review.sql').read_bytes()
        self.assertEqual(digest(fixture),self.acl.ROLE_FIXTURE_SHA)
        self.command(fixture.decode()+'\nGRANT CONNECT ON DATABASE neondb TO p07_payment_runtime;')

    def local_io(self,plan):
        case=self
        legacy=test_entry.a.load('p08-restoration-local-20261028/source/legacy/controller.py','tls_fixture_legacy')
        cap=SimpleNamespace(external=True,mode='run',plan=plan,modules={'restore':entry.restore},clock=time.time,
            e={'database':{'host':legacy.DB_HOST,'port':5432,'database':legacy.DB_NAME,'user':legacy.DB_ADMIN}},
            spend=lambda *args:time.time()+8,gate=lambda *args:time.time()+8)
        class FixtureIO(NativeIO):
            def credentials(self):return {'password':'SYNTHETIC_ONLY','accessToken':'SYNTHETIC_ONLY'}
            def _run(self,argv,kind,input_bytes=None,extra=None):
                case.assertEqual(kind,'sql')
                case.assertEqual(argv[argv.index('-h')+1],'127.0.0.1')
                case.assertEqual(argv[argv.index('-p')+1],case.port)
                case.assertEqual(extra['PGSSLMODE'],'verify-full')
                case.assertTrue(str(case.cert).startswith('/private/tmp/p08-pg-'))
                # Only the owned fixture CA replaces the production CA. Actual serializer/process remain in use.
                return super()._run(argv,kind,input_bytes,{**extra,'PGSSLROOTCERT':str(case.cert)})
            def cloud(self,*args):raise AssertionError('PROVIDER_FORBIDDEN')
        io=FixtureIO(cap)
        cap.e['database']={'host':'127.0.0.1','port':int(self.port),'database':'neondb','user':'neondb_owner'}
        return cap,io

    def fixture_runtime(self):
        t=test_entry.EntryTests();t.setUp();self.addCleanup(t.doCleanups)
        cap,io=self.local_io(t.f.p)
        runtime=entry.RuntimeAdapter(cap,io)
        observed=json.loads(self.command(self.acl.lifecycle_role_query()))
        runtime.q={'roleAclSha256':self.acl.classify_role_acl(observed['acl'],'neondb',self.acl.expected_retired_acl())[0]['roleAclSha256']}
        return t,cap,io,runtime

    def test_actual_lifecycle_sql_tls_enabled_retired_and_column_drift(self):
        t,cap,io,runtime=self.fixture_runtime();deadline=time.time()+30
        self.assertTrue(runtime.readback('role',entry.restore.ROLE,False,t.f.p,deadline))
        io.sql(entry.restore.role_sql(True,t.f.p['window']['workEnd']),deadline)
        self.assertTrue(runtime.readback('role',entry.restore.ROLE,True,t.f.p,deadline))
        self.command('GRANT UPDATE(status) ON "Job" TO p07_payment_runtime;')
        with self.assertRaisesRegex(Stop,'ROLE_ACL_DRIFT'):runtime.readback('role',entry.restore.ROLE,True,t.f.p,deadline)
        io.sql(entry.restore.role_sql(False),deadline)
        with self.assertRaisesRegex(Stop,'ROLE_ACL_DRIFT'):runtime.readback('role',entry.restore.ROLE,False,t.f.p,deadline)
        self.command('REVOKE UPDATE(status) ON "Job" FROM p07_payment_runtime;')
        self.assertTrue(runtime.readback('role',entry.restore.ROLE,False,t.f.p,deadline))
        with self.assertRaisesRegex(Stop,'SQL_ALLOWLIST'):io.sql('SELECT 1',deadline)
        self.assertEqual(self.command("SELECT count(*) FROM pg_stat_activity WHERE application_name LIKE 'p08-runtime-%'"),'0')
        io.clear()

    def test_assembled_tls_preflight_and_enabled_drift_refuse_authentication(self):
        for phase in ('preflight','enabled'):
            with self.subTest(phase=phase):
                self.setUp()
                t,cap,io,runtime=self.fixture_runtime()
                t.e['database']=cap.e['database'];t.e['qualification']['roleAclSha256']=runtime.q['roleAclSha256']
                t.e['qualification']['scopeSha256']=digest({k:t.e[k] for k in ('plan','target','database','resources','limits')})
                t.seal();factory=t.factory;injected=[False]
                def actual_factory(entry_cap):
                    ports=factory(entry_cap)
                    def sql(q,d):
                        entry_cap.spend('sql',ports.cleanup)
                        if q==self.acl.lifecycle_role_query() and not injected[0]:
                            enabled=self.command("SELECT rolcanlogin FROM pg_roles WHERE rolname='p07_payment_runtime'")=='t'
                            if phase=='preflight' or enabled:
                                self.command('GRANT UPDATE(status) ON "Job" TO p07_payment_runtime;');injected[0]=True
                        return io.sql(q,d)
                    ports.sql=sql;return ports
                r=entry.run_entry(t.path,io_factory=actual_factory)
                self.assertTrue(injected[0]);self.assertFalse(r['authenticationObserved'])
                self.assertEqual(r['status'],'ENTRY_CONTAINMENT_UNCONFIRMED',r)
                self.assertEqual(self.command("SELECT count(*) FROM pg_stat_activity WHERE application_name LIKE 'p08-runtime-%'"),'0')
                io.clear()

    def test_assembled_tls_run_and_independent_closeout_column_refusal(self):
        t,cap,io,runtime=self.fixture_runtime()
        t.e['database']=cap.e['database'];t.e['qualification']['roleAclSha256']=runtime.q['roleAclSha256']
        t.e['qualification']['scopeSha256']=digest({k:t.e[k] for k in ('plan','target','database','resources','limits')})
        t.seal();t.capture_recovery=True
        factory=t.factory
        def actual_sql_factory(entry_cap):
            ports=factory(entry_cap)
            def sql(q,d):
                entry_cap.spend('sql',ports.cleanup)
                return io.sql(q,d)
            ports.sql=sql
            return ports
        self.assertEqual(entry.run_entry(t.path,io_factory=actual_sql_factory)['status'],'ENTRY_CLOSED')
        files,state,bindings,key=t.snapshot
        for p in t.root.iterdir():p.unlink()
        for name,data in files.items():
            (t.root/name).write_bytes(data);os.chmod(t.root/name,0o600)
        t.f.runtime_state.clear();t.f.runtime_state.update(state)
        t.f.transport.bindings=bindings;t.f.transport.key=key
        self.command('GRANT UPDATE(status) ON "Job" TO p07_payment_runtime;')
        result=entry.run_entry(t.path,'closeout',actual_sql_factory)
        self.assertEqual(result['status'],'ENTRY_CONTAINMENT_UNCONFIRMED',result)
        self.assertTrue(result['residuals']);self.assertFalse(result['authProofReady'])
        self.assertEqual(self.command("SELECT count(*) FROM pg_stat_activity WHERE application_name LIKE 'p08-runtime-%'"),'0')
        self.assertFalse(json.loads(self.command(self.acl.lifecycle_role_query()))['login'])
        io.clear()

# Avoid inherited authentication scenarios in the new lifecycle-only class; NativePostgres still runs them unchanged.
for _name in dir(NativePostgres):
    if _name.startswith('test_') and _name not in LifecyclePostgres.__dict__:
        setattr(LifecyclePostgres,_name,None)

if __name__=='__main__':unittest.main()
