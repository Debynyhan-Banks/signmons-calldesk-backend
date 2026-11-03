import importlib.util
import json
import unittest
from pathlib import Path
from unittest.mock import patch

import composed_qualification as model
import qualification_launch as launch
from test_composed_qualification import NOW, plan
from test_qualification_launch import FakeIO, UID, binding, database_raw

ROOT = Path(__file__).resolve().parent
FIXTURE = ROOT.parent.parent / "p08-access-resolution-local-20261028/source/reuse/auth/reuse/test_postgres_contract.py"
spec = importlib.util.spec_from_file_location("p08_owned_socket_fixture", FIXTURE)
fixture = importlib.util.module_from_spec(spec); spec.loader.exec_module(fixture)


class QualificationLaunchPostgreSQL(fixture.PostgreSQLContract):
    def setUp(self):
        self.command('''DROP TABLE IF EXISTS "CalendarOperation","User","Job","TenantOrganization" CASCADE; DROP ROLE IF EXISTS p07_payment_runtime;
CREATE TABLE "TenantOrganization"(id uuid,status text);
CREATE TABLE "User"(id uuid,"tenantId" uuid,email text,"fullName" text,role text,status text);
CREATE TABLE "Job"(id uuid,"tenantId" uuid,"policySnapshot" jsonb,"calendarEventId" text);
CREATE TABLE "CalendarOperation"("jobId" uuid,"tenantId" uuid);
INSERT INTO "TenantOrganization" VALUES ('%s','ACTIVE');
INSERT INTO "User" VALUES ('%s','%s','%s','%s','ADMIN','DISABLED');
INSERT INTO "Job" VALUES ('%s','%s','{"intakeAdmission":{"humanReviewed":true}}',NULL);''' % (model.TENANT, UID, model.TENANT, launch.TARGET_EMAIL, launch.TARGET_NAME, model.JOB, model.TENANT))

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
INSERT INTO "Job"(id,"tenantId","customerId","customerTenantId","propertyAddressId","propertyAddressTenantId","serviceCategoryId","serviceCategoryTenantId",status,urgency,"pricingSnapshot","policySnapshot","updatedAt") VALUES('{model.JOB}','{tenant}','{customer}','{tenant}','{address}','{tenant}','{service}','{tenant}','CREATED','STANDARD','{{}}','{{"intakeAdmission":{{"humanReviewed":true}}}}',now());''')
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
    def test_actual_current_producer_sql_tls_positive_and_cleanup(self):
        r=self.case.run_proof();self.assertEqual(r['status'],'CURRENT_EVIDENCE_LOCAL_VERIFIED',r)
        self.assertEqual(self.command("SELECT count(*) FROM pg_stat_activity WHERE application_name LIKE 'signmons_p08_qualification_%'"),'0')
        self.assertFalse(self.native_sql.children)
    def test_actual_current_producer_acl_drift_refuses(self):
        self.command('GRANT UPDATE(status) ON "Job" TO p07_payment_runtime;')
        r=self.case.run_proof();self.assertIsNone(r['candidate']);self.assertFalse(self.native_sql.children)
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


for _name in dir(tls_fixture.LifecyclePostgres):
    if _name.startswith('test_') and _name not in CurrentEvidenceTLS.__dict__:setattr(CurrentEvidenceTLS,_name,None)

if __name__ == "__main__": unittest.main()
