import importlib.util
import json
import unittest
from pathlib import Path
from unittest.mock import patch

import composed_qualification as model
import qualification_launch as launch
from test_composed_qualification import NOW, plan
from test_qualification_launch import FakeIO, UID, binding, database_raw, controlled_raw

ROOT = Path(__file__).resolve().parent
FIXTURE = ROOT.parent.parent / "p08-access-resolution-local-20261028/source/reuse/auth/reuse/test_postgres_contract.py"
spec = importlib.util.spec_from_file_location("p08_owned_socket_fixture", FIXTURE)
fixture = importlib.util.module_from_spec(spec); spec.loader.exec_module(fixture)


class QualificationLaunchPostgreSQL(fixture.PostgreSQLContract):
    def setUp(self):
        self.command('''DROP TABLE IF EXISTS "CalendarOperation","User","Job","TenantOrganization" CASCADE; DROP ROLE IF EXISTS p07_payment_runtime;
CREATE TABLE "TenantOrganization"(id uuid,status text,settings jsonb);
CREATE TABLE "User"(id uuid,"tenantId" uuid,email text,"fullName" text,role text,status text);
CREATE TABLE "Job"(id uuid,"tenantId" uuid,"policySnapshot" jsonb,"calendarEventId" text);
CREATE TABLE "CalendarOperation"("jobId" uuid,"tenantId" uuid);
INSERT INTO "TenantOrganization"(id,status) VALUES ('%s','ACTIVE');
INSERT INTO "User" VALUES ('%s','%s','%s','%s','ADMIN','DISABLED');
INSERT INTO "Job" VALUES ('%s','%s','{"intakeAdmission":{"version":1,"humanReviewed":true}}',NULL);''' % (model.TENANT, UID, model.TENANT, launch.TARGET_EMAIL, launch.TARGET_NAME, model.JOB, model.TENANT))

    def raw(self):
        return json.loads(self.command(launch.QUALIFICATION_SQL))

    def adapter(self):
        p = plan(); b = binding(p); io = FakeIO(b, p); io.override["qualification"] = self.raw()
        return launch.Adapter(b, p, io, lambda: NOW), io

    def test_actual_repeatable_read_projection_qualifies_each_observed_fact(self):
        expected_hash = launch.hashlib.sha256(json.dumps(database_raw()["operator"], separators=(",", ":")).encode()).hexdigest()
        with patch.object(launch, "TARGET_SHA256", expected_hash):
            adapter, _ = self.adapter(); value = adapter.read_database(adapter.times["readEnd"])
        self.assertEqual(set(value), model.DATABASE_KEYS); self.assertTrue(all(value.values())); self.assertEqual(adapter.firebase_uid, UID)

    def test_absence_duplicate_foreign_and_changed_rows_never_qualify(self):
        cases = ['DELETE FROM "User"', 'INSERT INTO "User" SELECT * FROM "User"', 'UPDATE "User" SET role=\'OWNER\'', 'UPDATE "User" SET status=\'ACTIVE\'', 'UPDATE "TenantOrganization" SET status=\'INACTIVE\'', 'UPDATE "Job" SET "policySnapshot"=\'{}\'', 'INSERT INTO "CalendarOperation" VALUES (\'%s\',\'%s\')' % (model.JOB, model.TENANT)]
        expected_hash = launch.hashlib.sha256(json.dumps(database_raw()["operator"], separators=(",", ":")).encode()).hexdigest()
        for sql in cases:
            with self.subTest(sql=sql):
                self.setUp(); self.command(sql)
                with patch.object(launch, "TARGET_SHA256", expected_hash):
                    try:
                        adapter, _ = self.adapter(); value = adapter.read_database(adapter.times["readEnd"]); qualified = all(value.values())
                    except (model.Stop, AssertionError): qualified = False
                self.assertFalse(qualified)

    def test_controlled_policy_through_actual_jsonb_sql_projection(self):
        raw=controlled_raw()
        policy=json.dumps({'organizationPaymentPolicyV1':raw['tenant']['paymentPolicy']}).replace("'","''")
        job=json.dumps(raw['job']['policySnapshot']).replace("'","''")
        self.command(f"UPDATE \"TenantOrganization\" SET settings='{policy}'::jsonb; UPDATE \"Job\" SET \"policySnapshot\"='{job}'::jsonb;")
        adapter,_=self.adapter();self.assertTrue(adapter.read_database(adapter.times['readEnd'])['paymentGateExact'])
        self.command("UPDATE \"TenantOrganization\" SET settings=jsonb_set(settings,'{organizationPaymentPolicyV1,approved,actorId}','\"changed-owner\"');")
        adapter,_=self.adapter();self.assertFalse(adapter.read_database(adapter.times['readEnd'])['paymentGateExact'])

    def test_query_is_read_only_and_leaves_no_session(self):
        before = self.command('SELECT count(*) FROM "User";'); self.raw(); after = self.command('SELECT count(*) FROM "User";')
        self.assertEqual(before, after); self.assertEqual(self.command("SELECT count(*) FROM pg_stat_activity WHERE application_name LIKE 'signmons_p08_qualification_%'"), '0')


for name in list(fixture.PostgreSQLContract.__dict__):
    if name.startswith("test_"): setattr(QualificationLaunchPostgreSQL, name, None)


# Reuse the existing owned TLS cluster and full grant fixture; no external endpoint is opened.
import sys,subprocess,time,os,copy
sys.path.insert(0,str(ROOT.parent.parent/'p08-native-entry-local-20261101/source'))
import test_native_postgres as tls_fixture
import test_qualification_launch as current_tests

class CurrentEvidenceTLS(tls_fixture.LifecyclePostgres):
    def setUp(self):
        super().setUp()
        self.case=current_tests.CurrentProofTests();self.case.setUp();self.addCleanup(self.case.doCleanups)
        t=self.case;target=t.scope['target']
        def literal(value):return "'"+str(value).replace("'","''")+"'"
        self.command('UPDATE "User" SET id='+literal(target['id'])+',"fullName"='+literal(target['fullName'])+';')
        customer='20000000-0000-4000-8000-000000000001';address='30000000-0000-4000-8000-000000000001';service='40000000-0000-4000-8000-000000000001'
        tenant=model.TENANT
        self.command(f'''INSERT INTO "Customer"(id,"tenantId",phone,"fullName","updatedAt") VALUES('{customer}','{tenant}','synthetic','Fictional',now());
INSERT INTO "PropertyAddress"(id,"tenantId","customerId","customerTenantId","formattedAddress","addressComponents","updatedAt") VALUES('{address}','{tenant}','{customer}','{tenant}','Fictional','{{}}',now());
INSERT INTO "ServiceCategory"(id,"tenantId",name,"updatedAt") VALUES('{service}','{tenant}','Fictional',now());
INSERT INTO "Job"(id,"tenantId","customerId","customerTenantId","propertyAddressId","propertyAddressTenantId","serviceCategoryId","serviceCategoryTenantId",status,urgency,"pricingSnapshot","policySnapshot","updatedAt") VALUES('{model.JOB}','{tenant}','{customer}','{tenant}','{address}','{tenant}','{service}','{tenant}','CREATED','STANDARD','{{}}','{{"intakeAdmission":{{"version":1,"humanReviewed":true}}}}',now());''')
        t.scope['database']={'host':'127.0.0.1','port':int(self.port),'database':'neondb','user':'neondb_owner'}
        t.p['nativeScopeSha256']=model.digest(t.scope)
        case=self
        class LocalNative(launch.NativeIO):
            proof=True
            def _owned_run(obj,argv,env,deadline):
                case.assertEqual(argv[0],launch._operator_module().PSQL)
                case.assertIn(argv[-1],[d['sql'] for d in launch.current_sql_contract()])
                case.assertEqual(env['PGSSLMODE'],'verify-full')
                case.assertTrue(str(case.cert).startswith('/private/tmp/p08-pg-'))
                argv=list(argv);argv[argv.index('-h')+1]='127.0.0.1';argv[1:1]=['-p',case.port]
                return super()._owned_run(argv,{**env,'PGSSLROOTCERT':str(case.cert)},deadline)
        self.native_sql=LocalNative(time.time,t.p['operationId']);old_sql=t.io.sql
        def actual(d,password,deadline):
            t.io.calls.append(('sql',d));return self.native_sql.sql(d,password,time.time()+20)
        t.io.sql=actual;t.io.close=lambda deadline:self.native_sql.close(time.time()+5)
        def independent():
            fresh=LocalNative(time.time,t.p['operationId']);self.addCleanup(lambda:fresh.close(time.time()+5));return fresh
        t.io.independent=independent
        self.addCleanup(lambda:self.native_sql.close(time.time()+5))
    def test_managed_creator_membership_real_sql_current_and_native(self):
        # Reproduce the provider pattern using this OWNED cluster's bootstrap OID.
        # Rename bootstrap only inside the fixture, restore all names in finally.
        self.command('CREATE ROLE admin_fixture LOGIN SUPERUSER;')
        def admin(sql,user='admin_fixture'):
            argv=[launch._operator_module().PSQL,'-X','-q','-A','-t','-v','ON_ERROR_STOP=1',
                  '-h',str(self.socket),'-p',self.port,'-U',user,'-d','neondb','-c',sql]
            p=subprocess.run(argv,env=self.env,capture_output=True,timeout=20)
            self.assertEqual(p.returncode,0,p.stderr.decode());return p.stdout.decode().strip()
        renamed=False;created=False
        try:
            admin('DROP OWNED BY p07_payment_runtime; DROP ROLE p07_payment_runtime; ALTER ROLE neondb_owner RENAME TO cloud_admin;');renamed=True
            admin('CREATE ROLE neondb_owner LOGIN CREATEROLE; GRANT CONNECT ON DATABASE neondb TO neondb_owner; GRANT USAGE ON SCHEMA public TO neondb_owner; GRANT SELECT ON ALL TABLES IN SCHEMA public TO neondb_owner;');created=True
            fixture_sql=(model.ROOT.parents[3]/'scripts/fixtures/p07-payment-runtime-role-review.sql').read_text()
            create,grants=fixture_sql.split(';',1)
            admin(create+';','neondb_owner') # genuinely non-superuser CREATE ROLE
            admin(grants+'\nGRANT CONNECT ON DATABASE neondb TO p07_payment_runtime;')
            acl=launch.current_module('acl')
            raw=json.loads(self.command(acl.retired_role_query()))
            self.assertEqual(raw['membershipEdges'],[acl.ADMIN_MEMBERSHIP]);self.assertEqual(raw['memberships'],1)
            self.assertEqual(acl.classify_memberships(raw),'EXACT_ADMIN_EDGE')
            self.assertEqual(acl.classify_retired_role(raw,acl.expected_retired_acl())['status'],'ROLE_CONTRACT_LOCAL_VERIFIED')
            result=self.case.run_proof();self.assertEqual(result['status'],'CURRENT_EVIDENCE_LOCAL_VERIFIED',result)
            # Same actual catalog at native active,retired,and fresh-independent readback.
            t=tls_fixture.test_entry.EntryTests();t.setUp();self.addCleanup(t.doCleanups)
            cap,io=self.local_io(t.f.p);runtime=tls_fixture.entry.RuntimeAdapter(cap,io)
            runtime.q={'roleAclSha256':acl.classify_role_acl(raw['acl'],'neondb',acl.expected_retired_acl())[0]['roleAclSha256']}
            deadline=time.time()+20
            self.assertEqual(runtime.role(deadline)['memberships'],1)
            self.assertTrue(runtime.readback('role','p07_payment_runtime',False,t.f.p,deadline))
            admin("ALTER ROLE p07_payment_runtime LOGIN CONNECTION LIMIT 6 VALID UNTIL '"+t.f.p['window']['workEnd']+"';")
            self.assertTrue(runtime.readback('role','p07_payment_runtime',True,t.f.p,deadline))
            admin("ALTER ROLE p07_payment_runtime NOLOGIN CONNECTION LIMIT 0 VALID UNTIL '1970-01-01';")
            freshcap,freshio=self.local_io(t.f.p);fresh=tls_fixture.entry.RuntimeAdapter(freshcap,freshio);fresh.q=runtime.q
            self.assertTrue(fresh.readback('role','p07_payment_runtime',False,t.f.p,time.time()+20))
            admin('GRANT TEMP ON DATABASE neondb TO PUBLIC;')
            bad=json.loads(self.command(acl.retired_role_query()))
            with self.assertRaisesRegex(acl.Stop,'ROLE_NOT_READY'):acl.classify_retired_role(bad,acl.expected_retired_acl())
            with self.assertRaisesRegex(tls_fixture.entry.Stop,'ROLE_NOT_READY'):runtime.role(time.time()+20)
            admin('REVOKE TEMP ON DATABASE neondb FROM PUBLIC;')
            # A changed option and extra edge must fail through actual serialization.
            admin('GRANT p07_payment_runtime TO neondb_owner WITH INHERIT TRUE GRANTED BY cloud_admin;')
            with self.assertRaises(acl.Stop):acl.classify_retired_role(json.loads(self.command(acl.retired_role_query())),acl.expected_retired_acl())
            admin('GRANT p07_payment_runtime TO neondb_owner WITH INHERIT FALSE GRANTED BY cloud_admin; GRANT p07_payment_runtime TO admin_fixture;')
            bad=json.loads(self.command(acl.retired_role_query()));self.assertEqual(bad['memberships'],2)
            with self.assertRaises(acl.Stop):acl.classify_retired_role(bad,acl.expected_retired_acl())
        finally:
            if renamed:
                admin('DROP OWNED BY p07_payment_runtime; DROP ROLE IF EXISTS p07_payment_runtime;')
                if created:admin('DROP OWNED BY neondb_owner; DROP ROLE neondb_owner;')
                admin('ALTER ROLE cloud_admin RENAME TO neondb_owner; REVOKE TEMP ON DATABASE neondb FROM PUBLIC;')
            self.command('DROP ROLE admin_fixture;')
        self.assertEqual(self.command("SELECT count(*) FROM pg_stat_activity WHERE application_name LIKE 'signmons_p08_%'"),'0')

    def test_actual_current_producer_sql_tls_positive_and_cleanup(self):
        r=self.case.run_proof();self.assertEqual(r['status'],'CURRENT_EVIDENCE_LOCAL_VERIFIED',r)
        self.assertEqual(self.command("SELECT count(*) FROM pg_stat_activity WHERE application_name LIKE 'signmons_p08_qualification_%'"),'0')
        self.assertFalse(self.native_sql.children)
    def test_actual_current_producer_acl_drift_refuses(self):
        self.command('GRANT UPDATE(status) ON "Job" TO p07_payment_runtime;')
        r=self.case.run_proof();self.assertIsNone(r['candidate']);self.assertFalse(self.native_sql.children)
        self.assertEqual(r['failure'],'ROLE_ACL_DRIFT');self.assertEqual(r['failureStage'],'database')
        self.assertEqual(self.command("SELECT count(*) FROM pg_stat_activity WHERE application_name LIKE 'signmons_p08_qualification_%'"),'0')
    def test_actual_current_producer_wrong_job_refuses(self):
        self.command('UPDATE "Job" SET "policySnapshot"=\'{}\';')
        r=self.case.run_proof();self.assertIsNone(r['candidate']);self.assertFalse(self.native_sql.children)

    def test_external_binding_actual_tls_and_independent_factory(self):
        import shutil
        t=self.case;cap=object.__new__(launch.QualificationCapability)
        cap.plan=t.p;cap.scope=t.scope;cap.clock=lambda:t.now;cap.last=t.now;cap.mode='qualify'
        cap.times=model.authorize(t.p,t.now);cap.hash=model.digest({'synthetic':t.p});cap.observed=False
        cap.counts={'cli':0,'https':0,'sql':0,'cache':0};cap.e={'version':1,'plan':t.p,'nativeScope':t.scope,'sourceCommit':'0'*40,'manifestSha256':launch.source_manifest_sha256(),'decision':{'synthetic':True},'sdkReview':{'files':{launch._operator_module().PSQL:model.digest(Path(launch._operator_module().PSQL).read_bytes())},'limits':{'cli':27,'https':20,'sql':4,'cache':1}}}
        cap.root=Path('/private/tmp/p08-current-external-'+t.p['operationId']);cap.prepare=lambda:None
        self.addCleanup(lambda:shutil.rmtree(cap.root,ignore_errors=True))
        case=self;original=launch.NativeIO._owned_run;fresh=[]
        def owned(obj,argv,env,deadline):
            case.assertEqual(argv[0],launch._operator_module().PSQL)
            case.assertIn(argv[-1],[d['sql'] for d in launch.current_sql_contract()]);case.assertEqual(env['PGSSLMODE'],'verify-full')
            argv=list(argv);argv[argv.index('-h')+1]='127.0.0.1';argv[1:1]=['-p',case.port]
            return original(obj,argv,{**env,'PGSSLROOTCERT':str(case.cert)},time.time()+20)
        io=launch.QualificationIO(cap)
        t.io.sql=io.sql;t.io.close=io.close
        def independent():
            obj=io.independent();fresh.append(obj);return obj
        t.io.independent=independent
        with patch.object(launch.QualificationIO,'_owned_run',owned),patch.object(launch.sys.stdin,'isatty',return_value=True),patch.object(launch,'hidden_password',return_value='SYNTHETIC_TLS_ONLY'):
            result=launch._produce_current(t.p,t.scope,t.io,cap.clock,capability=cap)
        self.assertIsNotNone(result['candidate'],result);self.assertFalse(result['executionReady'])
        self.assertEqual(cap.counts['sql'],4);self.assertEqual(len(fresh),1);self.assertIsNot(fresh[0],io)
        self.assertTrue(io.closed and fresh[0].closed);self.assertFalse(io.children or fresh[0].children)
        self.assertEqual(self.command("SELECT count(*) FROM pg_stat_activity WHERE application_name LIKE 'signmons_p08_qualification_%'"),'0')


    def recovery_sql_fixture(self,drift=False):
        import shutil
        t=self.case;helper=current_tests.BindingRecoveryTests();helper.raw=copy.deepcopy(t.raw)
        e=helper.envelope(int(time.time()));cap=launch.BindingRecoveryCapability(e)
        self.addCleanup(lambda:shutil.rmtree(cap.root,ignore_errors=True))
        if drift:self.command('UPDATE "User" SET status=\'ACTIVE\';')
        local_type=type(self.native_sql);clients=[]
        class Ports:
            proof=True
            def __init__(obj,independent=False):
                obj.independent_read=independent;obj.native=local_type(time.time,e['operationId']);clients.append(obj.native)
            def cli(obj,d,deadline):
                cap.gate('cli',d['id'])
                return [{'account':model.OWNER,'status':'ACTIVE'}] if d['id']=='owner' else {'projectId':model.PROJECT,'projectNumber':'123456789012','lifecycleState':'ACTIVE'}
            def sql(obj,d,password,deadline):
                cleanup=d['id']=='closeout';label=('closeout-independent' if obj.independent_read else 'closeout-main') if cleanup else 'qualification'
                cap.gate('sql',label,cleanup);return obj.native.sql(d,password,time.time()+20)
            def close(obj,deadline):return obj.native.close(time.time()+5)
            def independent(obj):return Ports(True)
        result,guard=launch.run_binding_recovery(cap,Ports())
        try:
            if drift:
                self.assertEqual(result['status'],'BINDING_INPUT_RECOVERY_UNQUALIFIED');self.assertFalse((cap.root/'recovered-inputs.json').exists())
            else:
                self.assertEqual(result['status'],'HANDOFF_RETAINED',result)
                self.assertEqual(launch.private_json(cap.root/'recovered-inputs.json')['targetId'],t.scope['target']['id'])
                model.reserve(cap.root/'purge-now.json',{})
            guard.wait(timeout=5)
        finally:
            if guard.poll() is None:guard.terminate();guard.wait(timeout=3)
        self.assertEqual(len(list(cap.root.glob('read-sql-*.json'))),3)
        self.assertEqual(len(clients),2);self.assertTrue(all(c.closed and not c.children for c in clients))
        self.assertTrue(launch.private_json(cap.root/'purge-result.json')['rawFilesAbsent'])
        self.assertFalse((cap.root/'recovered-inputs.json').exists())
        self.assertEqual(self.command("SELECT count(*) FROM pg_stat_activity WHERE application_name LIKE 'signmons_p08_qualification_%'"),'0')
    def test_recovery_actual_tls_two_reads_three_sql_and_guard_cleanup(self):self.recovery_sql_fixture()
    def test_recovery_actual_tls_target_drift_refuses_and_closes(self):self.recovery_sql_fixture(True)


    def test_public_restart_after_parent_death_uses_fresh_actual_tls_sql(self):
        import subprocess,shutil
        helper=current_tests.ExternalBindingTests();helper.setUp();self.addCleanup(helper.doCleanups)
        directory=Path('/private/tmp/p08-current-input-'+helper.case.p['operationId']);directory.mkdir(mode=0o700)
        self.addCleanup(lambda:shutil.rmtree(directory,ignore_errors=True));path=directory/'envelope.json';model.reserve(path,helper.e)
        parent=subprocess.run([launch.sys.executable,'-I','-B','-c',current_tests.restart_child_code(helper.repo,True),str(model.ROOT),'--qualify-current',str(path)],capture_output=True,timeout=15)
        self.assertEqual(parent.returncode,-9,parent.stderr.decode());self.assertFalse(directory.exists())
        child=subprocess.run([launch.sys.executable,'-I','-B','-c',current_tests.restart_child_code(helper.repo,pg=(self.port,self.cert)),str(model.ROOT),'--closeout-current',str(helper.root)],capture_output=True,timeout=20)
        self.assertEqual(child.returncode,2,child.stderr.decode());result=json.loads((helper.root/'recovery-result.json').read_text())
        self.assertEqual(result['residuals'],['OWNED_PROCESS_HISTORY_UNKNOWN']);self.assertTrue(result['privateInputsAbsent']);self.assertIsNone(result['candidate'])
        self.assertEqual(len(list(helper.root.glob('read-sql-*.json'))),1)
        self.assertEqual(self.command("SELECT count(*) FROM pg_stat_activity WHERE application_name LIKE 'signmons_p08_qualification_%'"),'0')

    def test_role_diagnostic_actual_tls_public_and_acl_conditions(self):
        import shutil
        helper=current_tests.RoleDiagnosticTests();helper.setUp();self.addCleanup(helper.doCleanups)
        original=launch.NativeIO._owned_run;case=self
        def owned(obj,argv,env,deadline):
            case.assertIn(argv[-1],[launch.current_sql_contract()[2]['sql'],launch.sql_contract()[1]['sql']])
            case.assertEqual(env['PGSSLMODE'],'verify-full')
            argv=list(argv);argv[argv.index('-h')+1]='127.0.0.1';argv[1:1]=['-p',case.port]
            return original(obj,argv,{**env,'PGSSLROOTCERT':str(case.cert)},time.time()+20)
        cases=[(None,None),('GRANT TEMP ON DATABASE neondb TO PUBLIC','noDatabaseTemp'),
               ('GRANT CREATE ON SCHEMA public TO PUBLIC','noSchemaCreate'),
               ('GRANT UPDATE(status) ON "Job" TO p07_payment_runtime','aclExact')]
        for statement,failed in cases:
            with self.subTest(statement=statement):
                if statement:self.command(statement)
                shutil.rmtree(helper.root,ignore_errors=True)
                cap=helper.cap()
                with patch.object(launch.RoleDiagnosticIO,'_owned_run',owned),patch.object(launch,'recovery_password',return_value='SYNTHETIC_TLS'):
                    r=launch.run_role_diagnostic(cap)
                self.assertEqual(r['residuals'],[],r);self.assertEqual(r['sqlReservations'],3)
                if failed:self.assertEqual(r['observation']['checks'][failed],'FAIL')
                else:self.assertEqual(set(r['observation']['checks'].values()),{'PASS'})
                if failed in ('noDatabaseTemp','noSchemaCreate'):self.assertEqual(r['observation']['checks']['aclExact'],'PASS')
                self.assertIsNone(r['candidate']);self.assertFalse(r['executionReady'])
                self.assertEqual(self.command("SELECT count(*) FROM pg_stat_activity WHERE application_name LIKE 'signmons_p08_qualification_%'"),'0')
                self.command('REVOKE TEMP ON DATABASE neondb FROM PUBLIC; REVOKE CREATE ON SCHEMA public FROM PUBLIC;')

    def test_role_diagnostic_public_hard_crash_and_fresh_tls_cleanup(self,provenance=False,temp_impact=False,correction=False):
        command='temp-correction' if correction else 'temp-impact' if temp_impact else 'role-provenance' if provenance else 'database-role'
        helper=(current_tests.TempCorrectionTests if correction else current_tests.TempImpactTests if temp_impact else current_tests.RoleProvenanceTests if provenance else current_tests.RoleDiagnosticTests)();helper.setUp();self.addCleanup(helper.doCleanups)
        path=helper.fixture.repo/'role-envelope.json';path.write_text(json.dumps(helper.e));path.chmod(0o600)
        prefix='\n'.join([
            'import sys,os,signal,json;from pathlib import Path',
            'sys.path.insert(0,sys.argv[1]);import qualification_launch as q',
            'original=q.current_module;a=original("authority");read=a.committed',
            f'a.committed=lambda repo,commit,path:read(Path({str(helper.fixture.repo)!r}),commit,path)',
            'q.current_module=lambda name:a if name=="authority" else original(name)',
            'q.recovery_password=lambda *args:"SYNTHETIC_CHILD"',
        ])
        entry='temp_correction_main' if correction else 'role_diagnostic_main'
        port='CorrectionIO._open_transaction' if correction else 'RoleDiagnosticIO._owned_run'
        crash=prefix+'\nq.'+port+'=lambda *args:os.kill(os.getpid(),signal.SIGKILL)\nraise SystemExit(q.'+entry+'(sys.argv[2:]))'
        p=subprocess.run([launch.sys.executable,'-I','-B','-c',crash,str(model.ROOT),'--correct-temp' if correction else '--diagnose-'+command,str(path)],capture_output=True,timeout=15)
        self.assertEqual(p.returncode,-9,p.stderr.decode());self.assertTrue((helper.root/'sql-role.json').exists());self.assertFalse((helper.root/'result.json').exists())
        cleanup=prefix+'\n'+ '\n'.join([
            'owned=q.NativeIO._owned_run',
            'def local(obj,argv,env,deadline):',
            '    assert argv[-1]=='+('q.correction_snapshot_contract()["sql"]' if correction else 'q.sql_contract()[1]["sql"]'),
            f'    argv=list(argv);argv[argv.index("-h")+1]="127.0.0.1";argv[1:1]=["-p",{self.port!r}]',
            f'    return owned(obj,argv,dict(env,PGSSLROOTCERT={str(self.cert)!r}),deadline)',
            'q.'+('CorrectionIO' if correction else 'RoleDiagnosticIO')+'._owned_run=local',
            'raise SystemExit(q.'+entry+'(sys.argv[2:]))'])
        p=subprocess.run([launch.sys.executable,'-I','-B','-c',cleanup,str(model.ROOT),'--closeout-'+command,str(helper.root)],capture_output=True,timeout=20)
        self.assertEqual(p.returncode,2,p.stderr.decode());r=json.loads((helper.root/'closeout.json').read_text())
        self.assertEqual(r['residuals'],['PROCESS_HISTORY_UNKNOWN']);self.assertFalse(r['verified'])
        self.assertEqual(sorted(p.name for p in helper.root.glob('sql-*.json')),['sql-independent.json','sql-role.json'])
        self.assertEqual(self.command("SELECT count(*) FROM pg_stat_activity WHERE application_name LIKE 'signmons_p08_qualification_%'"),'0')

    def test_role_provenance_actual_tls_sources_directions_and_defaults(self):
        import shutil
        helper=current_tests.RoleProvenanceTests();helper.setUp();self.addCleanup(helper.doCleanups)
        original=launch.NativeIO._owned_run;case=self
        def owned(obj,argv,env,deadline):
            case.assertIn(argv[-1],[launch.role_provenance_contract()['sql'],launch.sql_contract()[1]['sql']])
            case.assertEqual(env['PGSSLMODE'],'verify-full')
            argv=list(argv);argv[argv.index('-h')+1]='127.0.0.1';argv[1:1]=['-p',case.port]
            return original(obj,argv,{**env,'PGSSLROOTCERT':str(case.cert)},time.time()+20)
        def observe():
            shutil.rmtree(helper.root,ignore_errors=True)
            with patch.object(launch.RoleDiagnosticIO,'_owned_run',owned),patch.object(launch,'recovery_password',return_value='SYNTHETIC_TLS'):
                r=launch.run_role_diagnostic(helper.cap())
            self.assertEqual(r['residuals'],[],r);self.assertEqual(r['sqlReservations'],3)
            self.assertEqual(r['status'],'DATABASE_ROLE_PROVENANCE_DIAGNOSED',r)
            self.assertIsNone(r['candidate']);self.assertFalse(r['executionReady'])
            self.assertEqual(self.command("SELECT count(*) FROM pg_stat_activity WHERE application_name LIKE 'signmons_p08_qualification_%'"),'0')
            return r['observation']['provenance']
        self.command('CREATE ROLE provenance_parent; CREATE ROLE provenance_consumer; CREATE ROLE provenance_grandparent;')
        try:
            v=observe();self.assertFalse(v['effectiveTemp']);self.assertEqual(v['tempSources'],[])
            self.command('GRANT p07_payment_runtime TO provenance_consumer; GRANT provenance_parent TO p07_payment_runtime WITH INHERIT FALSE; GRANT TEMP ON DATABASE neondb TO provenance_parent;')
            v=observe();self.assertFalse(v['effectiveTemp']);self.assertEqual({e['direction'] for e in v['memberships']},{'INCOMING','OUTGOING'})
            self.command('GRANT provenance_parent TO p07_payment_runtime WITH INHERIT TRUE;')
            v=observe();self.assertEqual(v['tempSources'],[{'kind':'INHERITED','role':'provenance_parent'}])
            self.command('REVOKE TEMP ON DATABASE neondb FROM provenance_parent; GRANT provenance_grandparent TO provenance_parent WITH INHERIT TRUE; GRANT TEMP ON DATABASE neondb TO provenance_grandparent;')
            v=observe();self.assertEqual(v['tempSources'],[{'kind':'INHERITED','role':'provenance_grandparent'}]);self.assertIn('ANCESTOR',[e['direction'] for e in v['memberships']])
            self.command('REVOKE TEMP ON DATABASE neondb FROM provenance_grandparent; GRANT TEMP ON DATABASE neondb TO p07_payment_runtime;')
            v=observe();self.assertEqual(v['tempSources'],[{'kind':'DIRECT','role':'p07_payment_runtime'}])
            self.command('REVOKE TEMP ON DATABASE neondb FROM p07_payment_runtime; GRANT TEMP ON DATABASE neondb TO PUBLIC;')
            v=observe();self.assertEqual(v['tempSources'],[{'kind':'PUBLIC','role':None}]);self.assertFalse(v['aclDefault'])
            # Owned disposable cluster only: exercise actual null catalog/default-ACL semantics.
            saved=self.command("SELECT datacl::text FROM pg_database WHERE datname='neondb'")
            try:
                self.command("UPDATE pg_database SET datacl=NULL WHERE datname='neondb';")
                v=observe();self.assertTrue(v['aclDefault']);self.assertEqual(v['tempSources'],[{'kind':'PUBLIC','role':None}])
            finally:
                self.command("UPDATE pg_database SET datacl='"+saved.replace("'","''")+"'::aclitem[] WHERE datname='neondb';")
        finally:
            self.command('DROP OWNED BY provenance_parent,provenance_consumer,provenance_grandparent; DROP ROLE provenance_consumer,provenance_parent,provenance_grandparent; REVOKE ALL ON DATABASE neondb FROM PUBLIC;')

    def test_role_provenance_actual_catalog_overflow_is_unknown(self):
        # 65 incoming edges exceed the approved bound, without a truncated success.
        self.command("DO $$ BEGIN FOR i IN 1..65 LOOP EXECUTE format('CREATE ROLE provenance_bound_%s',i); EXECUTE format('GRANT p07_payment_runtime TO provenance_bound_%s',i); END LOOP; END $$;")
        try:
            raw=json.loads(self.command(launch.role_provenance_contract()['sql']))
            self.assertEqual(len(raw['memberships']),65)
            self.assertFalse(launch.role_provenance_observation(raw)['complete'])
            self.command("DO $$ BEGIN FOR i IN 1..65 LOOP EXECUTE format('REVOKE p07_payment_runtime FROM provenance_bound_%s',i); EXECUTE format('GRANT TEMP ON DATABASE neondb TO provenance_bound_%s',i); END LOOP; END $$;")
            raw=json.loads(self.command(launch.role_provenance_contract()['sql']))
            self.assertEqual(raw['memberships'],[]);self.assertEqual(len(raw['tempGrants']),65)
            self.assertFalse(launch.role_provenance_observation(raw)['complete'])
        finally:
            self.command("DO $$ BEGIN FOR i IN 1..65 LOOP EXECUTE format('DROP OWNED BY provenance_bound_%s',i); EXECUTE format('DROP ROLE provenance_bound_%s',i); END LOOP; END $$;")

    def test_role_provenance_public_hard_crash_and_fresh_tls_cleanup(self):
        self.test_role_diagnostic_public_hard_crash_and_fresh_tls_cleanup(provenance=True)


    def test_temp_impact_actual_tls_grant_sources_and_session_visibility(self):
        import shutil,signal
        helper=current_tests.TempImpactTests();helper.setUp();self.addCleanup(helper.doCleanups)
        original=launch.NativeIO._owned_run;case=self
        def owned(obj,argv,env,deadline):
            case.assertIn(argv[-1],[launch.temp_impact_contract()['sql'],launch.sql_contract()[1]['sql']])
            case.assertEqual(env['PGSSLMODE'],'verify-full')
            argv=list(argv);argv[argv.index('-h')+1]='127.0.0.1';argv[1:1]=['-p',case.port]
            return original(obj,argv,{**env,'PGSSLROOTCERT':str(case.cert)},time.time()+20)
        def observe(complete=True):
            shutil.rmtree(helper.root,ignore_errors=True)
            with patch.object(launch.RoleDiagnosticIO,'_owned_run',owned),patch.object(launch,'recovery_password',return_value='SYNTHETIC_TLS'):
                result=launch.run_role_diagnostic(helper.cap())
            self.assertEqual(result['residuals'],[],result);self.assertEqual(result['sqlReservations'],3)
            self.assertEqual(result['observation']['complete'],complete,result)
            self.assertIsNone(result['candidate']);self.assertFalse(result['executionReady'])
            if not complete:return result
            self.assertEqual(result['status'],'TEMP_IMPACT_DIAGNOSED',result)
            v=result['observation']['inventory'];return v,{row['name']:row for row in v['roles']}
        def admin(sql):
            p=subprocess.run([launch._operator_module().PSQL,'-X','-q','-A','-t','-v','ON_ERROR_STOP=1',
                '-h',str(self.socket),'-p',self.port,'-U','temp_admin','-d','neondb','-c',sql],env=self.env,capture_output=True,timeout=20)
            self.assertEqual(p.returncode,0,p.stderr.decode())
        self.command('CREATE ROLE temp_admin LOGIN SUPERUSER; CREATE ROLE temp_direct; CREATE ROLE temp_parent; CREATE ROLE temp_middle; CREATE ROLE temp_leaf; CREATE ROLE temp_blocked; CREATE ROLE temp_session LOGIN; GRANT CONNECT ON DATABASE neondb TO temp_session;')
        child=None; renamed=False
        try:
            v,rows=observe();self.assertEqual(rows['p07_payment_runtime']['effect'],'NO_TEMP')
            self.command('GRANT TEMP ON DATABASE neondb TO PUBLIC,temp_direct,temp_parent; GRANT temp_parent TO temp_middle WITH INHERIT TRUE; GRANT temp_middle TO temp_leaf WITH INHERIT TRUE; GRANT temp_parent TO temp_blocked WITH INHERIT FALSE;')
            v,rows=observe()
            self.assertEqual(rows['p07_payment_runtime']['effect'],'LOSE_TEMP')
            self.assertEqual(rows['temp_direct']['effect'],'RETAINS_TEMP')
            self.assertEqual(rows['temp_leaf']['sources'],['temp_parent'])
            self.assertEqual(rows['temp_leaf']['effect'],'RETAINS_TEMP')
            self.assertEqual(rows['temp_blocked']['effect'],'LOSE_TEMP')
            self.assertFalse(rows['temp_blocked']['connect']);self.assertFalse(rows['temp_blocked']['login'])
            self.assertEqual(rows['temp_admin']['effect'],'RETAINS_TEMP')
            # General session identity/database fields remain visible to a non-superuser.
            argv=[launch._operator_module().PSQL,'-X','-q','-A','-t','-h',str(self.socket),'-p',self.port,'-U','temp_session','-d','neondb','-c','SELECT pg_sleep(30)']
            child=subprocess.Popen(argv,env=self.env,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
            for _ in range(100):
                if self.command("SELECT count(*) FROM pg_stat_activity WHERE usename='temp_session'")=='1':break
                time.sleep(.02)
            else:self.fail('fixture session absent')
            admin('ALTER ROLE neondb_owner RENAME TO temp_bootstrap;');renamed=True
            admin('CREATE ROLE neondb_owner LOGIN; ALTER DATABASE neondb OWNER TO neondb_owner; GRANT CONNECT,TEMP ON DATABASE neondb TO neondb_owner;')
            v,rows=observe();self.assertEqual(rows['temp_session']['sessions'],1)
            self.assertFalse(rows['neondb_owner']['superuser']);self.assertEqual(rows['neondb_owner']['effect'],'RETAINS_TEMP')
            admin('REVOKE TEMP ON DATABASE neondb FROM PUBLIC,neondb_owner;')
            v,rows=observe();self.assertEqual(rows['neondb_owner']['effect'],'NO_TEMP')
            self.assertEqual(rows['p07_payment_runtime']['effect'],'NO_TEMP')
            if renamed:
                admin('ALTER DATABASE neondb OWNER TO temp_bootstrap; DROP OWNED BY neondb_owner; DROP ROLE neondb_owner; ALTER ROLE temp_bootstrap RENAME TO neondb_owner;');renamed=False
            saved=self.command("SELECT datacl::text FROM pg_database WHERE datname='neondb'")
            try:
                self.command("UPDATE pg_database SET datacl=NULL WHERE datname='neondb'")
                v,rows=observe();self.assertTrue(v['aclDefault']);self.assertEqual(rows['p07_payment_runtime']['effect'],'LOSE_TEMP')
            finally:self.command("UPDATE pg_database SET datacl='"+saved.replace("'","''")+"'::aclitem[] WHERE datname='neondb'")
            self.command('DROP OWNED BY p07_payment_runtime; DROP ROLE p07_payment_runtime;')
            self.assertIsNone(observe(False)['observation']['inventory'])
        finally:
            if child is not None:
                if child.poll() is None:child.send_signal(signal.SIGTERM)
                child.wait(timeout=5)
            if renamed:
                admin('ALTER DATABASE neondb OWNER TO temp_bootstrap; DROP OWNED BY neondb_owner; DROP ROLE neondb_owner; ALTER ROLE temp_bootstrap RENAME TO neondb_owner;');renamed=False
            self.command('DROP OWNED BY temp_admin,temp_direct,temp_parent,temp_middle,temp_leaf,temp_blocked,temp_session; DROP ROLE temp_admin,temp_direct,temp_parent,temp_middle,temp_leaf,temp_blocked,temp_session; REVOKE TEMP ON DATABASE neondb FROM PUBLIC;')
        self.assertEqual(self.command("SELECT count(*) FROM pg_stat_activity WHERE application_name LIKE 'signmons_p08_%'"),'0')

    def test_temp_impact_actual_role_and_acl_overflow(self):
        self.command("DO $$ BEGIN FOR i IN 1..257 LOOP EXECUTE format('CREATE ROLE temp_bound_%s',i); END LOOP; END $$;")
        try:
            raw=json.loads(self.command(launch.temp_impact_contract()['sql']))
            self.assertEqual(len(raw['roles']),257);self.assertGreater(raw['inventoryRoleCount'],256)
            self.assertFalse(launch.temp_impact_observation(raw)['complete'])
            self.command("DO $$ BEGIN FOR i IN 66..257 LOOP EXECUTE format('DROP ROLE temp_bound_%s',i); END LOOP; FOR i IN 1..65 LOOP EXECUTE format('GRANT TEMP ON DATABASE neondb TO temp_bound_%s',i); END LOOP; END $$;")
            raw=json.loads(self.command(launch.temp_impact_contract()['sql']))
            self.assertEqual(len(raw['tempGrants']),65);self.assertLess(raw['inventoryRoleCount'],256)
            self.assertFalse(launch.temp_impact_observation(raw)['complete'])
        finally:
            self.command("DO $$ BEGIN FOR i IN 1..257 LOOP IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='temp_bound_'||i) THEN EXECUTE format('DROP OWNED BY temp_bound_%s',i); EXECUTE format('DROP ROLE temp_bound_%s',i); END IF; END LOOP; END $$;")

    def test_temp_impact_public_hard_crash_and_fresh_tls_cleanup(self):
        self.test_role_diagnostic_public_hard_crash_and_fresh_tls_cleanup(temp_impact=True)



    def test_temp_correction_actual_tls_transaction_and_uncertain_commit(self):
        import shutil
        self.command('CREATE ROLE correction_admin LOGIN SUPERUSER;')
        def admin(sql,user='cloud_admin'):
            p=subprocess.run([launch._operator_module().PSQL,'-X','-q','-A','-t','-v','ON_ERROR_STOP=1','-h',str(self.socket),'-p',self.port,'-U',user,'-d','neondb','-c',sql],env=self.env,capture_output=True,timeout=20)
            self.assertEqual(p.returncode,0,p.stderr.decode());return p.stdout.decode().strip()
        renamed=False;created=False;roles=False
        try:
            admin('DROP OWNED BY p07_payment_runtime; DROP ROLE p07_payment_runtime; ALTER ROLE neondb_owner RENAME TO cloud_admin;','correction_admin');renamed=True
            admin('CREATE ROLE neondb_owner LOGIN CREATEROLE; ALTER DATABASE neondb OWNER TO neondb_owner; GRANT CONNECT,TEMP ON DATABASE neondb TO neondb_owner; DROP ROLE correction_admin;');created=True
            fixture_sql=(model.ROOT.parents[3]/'scripts/fixtures/p07-payment-runtime-role-review.sql').read_text();create,grants=fixture_sql.split(';',1)
            admin(create+';','neondb_owner');admin(grants+' GRANT CONNECT ON DATABASE neondb TO p07_payment_runtime;')
            admin('CREATE ROLE neon_superuser; CREATE ROLE neon_service LOGIN; GRANT neon_superuser TO neon_service; CREATE ROLE p06_intake_runtime; CREATE ROLE p06_migration_owner; CREATE ROLE p06_migration_runner; CREATE ROLE token_roles; GRANT TEMP ON DATABASE neondb TO PUBLIC,neon_superuser;');roles=True
            baseline=json.loads(self.command(launch.temp_impact_contract()['sql']))
            original_open=launch.CorrectionIO._open_transaction;original_run=launch.NativeIO._owned_run;case=self
            scenario={'name':'positive'}
            def rewrite(argv,env):
                case.assertEqual(env['PGSSLMODE'],'verify-full');argv=list(argv);argv[argv.index('-h')+1]='127.0.0.1';argv[1:1]=['-p',case.port]
                return argv,{**env,'PGSSLROOTCERT':str(case.cert)}
            def opened(obj,argv,env):
                argv,env=rewrite(argv,env);p=original_open(obj,argv,env)
                stdin=p.stdin
                class Input:
                    def write(_,data):
                        if data.startswith(b'COMMIT;'):
                            if scenario['name']=='lost_commit':data=b'COMMIT;\n\\quit\n'
                            if scenario['name']=='concurrent':admin('GRANT p06_intake_runtime TO p07_payment_runtime WITH INHERIT TRUE;')
                        return stdin.write(data)
                    def flush(_):return stdin.flush()
                    def close(_):return stdin.close()
                p.stdin=Input();return p
            def read(obj,argv,env,deadline):
                argv,env=rewrite(argv,env);return original_run(obj,argv,env,time.time()+20)
            with patch.object(launch,'TEMP_CORRECTION_BASELINE',baseline):
                helper=current_tests.TempCorrectionTests();helper.setUp();self.addCleanup(helper.doCleanups)
                def run():
                    shutil.rmtree(helper.root,ignore_errors=True)
                    with patch.object(launch.CorrectionIO,'proof',True,create=True),patch.object(launch.CorrectionIO,'_open_transaction',opened),patch.object(launch.CorrectionIO,'_owned_run',read),patch.object(launch,'recovery_password',return_value='SYNTHETIC_TLS'):
                        cap=helper.cap();result=launch.run_temp_correction(cap)
                        close=launch.closeout_temp_correction(helper.cap('closeout'))
                    self.assertTrue(close['verified'],close);self.assertEqual(result['connectionReservations'],3,result)
                    self.assertFalse(result['executionReady']);self.assertIsNone(result['candidate'])
                    self.assertEqual(admin("SELECT count(*) FROM pg_stat_activity WHERE application_name LIKE 'signmons_p08_%'"),'0')
                    return result
                before=admin("SELECT json_agg(x::text ORDER BY x::text) FROM pg_database d CROSS JOIN LATERAL unnest(d.datacl) x WHERE datname='neondb'")
                original_validate=launch.correction_validate
                def reject_post(raw,post=False,expected_acl=None):
                    if post:raise model.Stop('SYNTHETIC_POST_FAILURE')
                    return original_validate(raw,post,expected_acl)
                with patch.object(launch,'correction_validate',side_effect=reject_post):
                    r=run();self.assertFalse(r['verified']);self.assertEqual(r['independent']['state'],'PRESTATE')
                self.assertEqual(admin("SELECT json_agg(x::text ORDER BY x::text) FROM pg_database d CROSS JOIN LATERAL unnest(d.datacl) x WHERE datname='neondb'"),before)
                r=run();self.assertTrue(r['verified'],r);self.assertEqual(r['independent']['state'],'POSTSTATE')
                def reset():admin('SET ROLE neondb_owner; GRANT TEMP ON DATABASE neondb TO PUBLIC; REVOKE TEMP ON DATABASE neondb FROM p06_intake_runtime,p06_migration_owner,p06_migration_runner,token_roles; RESET ROLE;')
                reset();scenario['name']='lost_commit';r=run();self.assertFalse(r['verified']);self.assertFalse(r['commitAcknowledged']);self.assertEqual(r['independent']['state'],'POSTSTATE')
                reset();scenario['name']='concurrent';r=run();self.assertFalse(r['verified']);self.assertTrue(r['commitAcknowledged']);self.assertEqual(r['independent']['state'],'DRIFT')
                admin('REVOKE p06_intake_runtime FROM p07_payment_runtime;');reset()
                # Drift detected before any write leaves the original PUBLIC ACL intact.
                admin('GRANT p06_intake_runtime TO p07_payment_runtime WITH INHERIT TRUE;')
                scenario['name']='positive';r=run();self.assertFalse(r['verified']);self.assertFalse(r['commitAcknowledged'])
                self.assertEqual(admin("SELECT json_agg(x::text ORDER BY x::text) FROM pg_database d CROSS JOIN LATERAL unnest(d.datacl) x WHERE datname='neondb'"),before)
        finally:
            if renamed:
                admin('DROP OWNED BY p07_payment_runtime; DROP ROLE p07_payment_runtime;')
                if roles:admin('DROP OWNED BY neon_service,neon_superuser,p06_intake_runtime,p06_migration_owner,p06_migration_runner,token_roles; DROP ROLE neon_service,neon_superuser,p06_intake_runtime,p06_migration_owner,p06_migration_runner,token_roles;')
                if created:admin('ALTER DATABASE neondb OWNER TO cloud_admin; DROP OWNED BY neondb_owner; DROP ROLE neondb_owner;')
                admin('CREATE ROLE correction_admin LOGIN SUPERUSER;')
                admin('ALTER ROLE cloud_admin RENAME TO neondb_owner;','correction_admin')
            self.command('DROP ROLE correction_admin; REVOKE TEMP ON DATABASE neondb FROM PUBLIC;')


    def test_temp_correction_public_crash_fresh_cleanup_no_replay(self):
        self.test_role_diagnostic_public_hard_crash_and_fresh_tls_cleanup(correction=True)

for _name in dir(tls_fixture.LifecyclePostgres):
    if _name.startswith('test_') and _name not in CurrentEvidenceTLS.__dict__:setattr(CurrentEvidenceTLS,_name,None)

if __name__ == "__main__": unittest.main()
