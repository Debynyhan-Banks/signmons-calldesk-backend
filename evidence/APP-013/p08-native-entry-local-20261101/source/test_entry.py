"""Assembled-entry proofs: injected providers and actual Python/Node child boundary."""
import copy
import datetime
import fcntl
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import time
import unittest
from unittest.mock import patch
from types import SimpleNamespace

import authority as a
import entry
from private_inventory import inspect, read, reserve, Stop

sys.path.insert(0, str(a.APP / 'p08-native-closeout-local-20261031/source'))
import test_adapter as ta


class EntryTests(unittest.TestCase):
    def setUp(self):
        self.f=ta.AdapterTests();self.f.setUp();f=self.f
        self.addCleanup(f.tearDown)
        now=int(time.time());f.now=now
        iso=lambda x:datetime.datetime.fromtimestamp(now+x,datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')
        f.p['window']={'start':iso(-10),'cutoff':iso(120),'workEnd':iso(180),'cleanupEnd':iso(900),'purgeEnd':iso(950)}
        f.target['email']=f.p['ownerPrincipal']
        self.root=Path('/private/tmp/p08-coordinator-'+f.p['operationId']);self.root.mkdir(mode=0o700)
        self.addCleanup(lambda:shutil.rmtree(self.root))
        self.path=self.root/'envelope.json'
        resources={'candidate':ta.restore.CANDIDATE,'image':ta.restore.IMAGE,'normalRevision':ta.restore.NORMAL,
                   'identity':ta.restore.IDENTITY,'secretVersions':{s:'1' for s in ta.restore.SECRETS}}
        self.e={'version':1,'execution':'PROOF_ONLY','plan':f.p,'target':f.target,
                'database':{'host':'fixture.invalid','port':5432,'database':'fixture_child','user':'fixture_admin'},
                'resources':resources,'limits':{'cli':180,'https':100,'sql':60,'child':6,'childRequests':200},
                'sourceManifestSha256':a.digest((a.HERE/'source-manifest.json').read_bytes()),'sourceCommit':'0'*40}
        scope={k:self.e[k] for k in ('plan','target','database','resources','limits')}
        self.e['qualification']={'status':'QUALIFIED_FOR_NATIVE_ENTRY','operationId':f.p['operationId'],
            'scopeSha256':a.digest(scope),'qualifiedUntil':iso(900),**f.q,
            'checks':{k:True for k in ('owner','billing','effectiveAccess','services','database','firebase','job','retiredRuntime','privateInventory')}}
        self.acl=entry.load_acl();self.role_reads=0;self.role_mutator=None
        rows=self.acl.expected_retired_acl()
        for row in rows:
            if row['kind']=='database':row['object']=self.e['database']['database']
        f.q['roleAclSha256']=self.acl.classify_role_acl(rows,self.e['database']['database'],self.acl.expected_retired_acl())[0]['roleAclSha256']
        self.e['qualification']['roleAclSha256']=f.q['roleAclSha256']
        self.scenario='normal';self.calls=0;self.io=None;self.capture_recovery=False;self.snapshot=None
        self.seal()

    def seal(self):
        self.e['decision']={'decision':'APPROVE_LOCAL_NATIVE_ENTRY_PROOF',
            'scopeSha256':a.digest({k:v for k,v in self.e.items() if k!='decision'})}
        if self.path.exists():self.path.unlink()
        reserve(self.path,self.e)

    def factory(self,cap):
        test=self;f=self.f
        class ProofIO:
            proof=True
            def __init__(self):self.cleanup=cap.mode!='run'
            def credentials(self):
                cap.gate(self.cleanup)
                return {'password':'SYNTHETIC_HIDDEN_PASSWORD','accessToken':'SYNTHETIC_OWNER_OAUTH_TOKEN'}
            def cli(self,v):
                cap.spend('cli',self.cleanup);test.calls+=1
                return f.transport.cli(v)
            def cloud(self,v,d):
                cap.spend('cli',self.cleanup);test.calls+=1
                return f.cloud(v,d)
            def sql(self,q,d):
                cap.spend('sql',self.cleanup);test.calls+=1
                if q==test.acl.lifecycle_role_query():
                    test.role_reads+=1
                    v=json.loads(f.sql(q,d))
                    v.update(role=test.acl.RETIRED_ROLE,database=cap.e['database']['database'],
                             user=cap.e['database']['user'],expiryFinite=True,schemaCreate=False,databaseTemp=False,
                             acl=test.acl.expected_retired_acl())
                    for row in v['acl']:
                        if row['kind']=='database':row['object']=v['database']
                    if test.role_mutator:test.role_mutator(v,self.cleanup)
                    return json.dumps(v)
                return f.sql(q,d)
            def https(self,d):
                cap.spend('https',self.cleanup);test.calls+=1
                return f.transport.https(d)
            def child(self,argv,**kwargs):
                if test.capture_recovery and (test.root/'closeout.json').exists() and test.snapshot is None:
                    test.snapshot=({p.name:p.read_bytes() for p in test.root.iterdir()},
                                   copy.deepcopy(f.runtime_state),copy.deepcopy(f.transport.bindings),
                                   copy.deepcopy(f.transport.key))
                argv=[argv[0],str(a.HERE/'fixture_child.mjs'),argv[2],test.scenario]
                if test.scenario=='timeout':raise subprocess.TimeoutExpired(argv,1)
                return subprocess.run(argv,**kwargs)
            def clear(self):pass
        self.io=ProofIO();return self.io

    def run_entry(self,mode='run'):
        return entry.run_entry(self.path,mode,self.factory)

    def test_assembled_positive_authoritative_readback_and_private_purge(self):
        r=self.run_entry()
        self.assertEqual(r['status'],'ENTRY_CLOSED',r)
        self.assertEqual(r['residuals'],[])
        self.assertTrue(r['privateInputsAbsent'])
        self.assertFalse(r['liveAuthorization'] or r['authProofReady'])
        self.assertFalse(any(self.f.runtime_state.values()))
        self.assertFalse(self.f.transport.bindings)
        self.assertTrue(self.f.transport.key.get('deleteTime'))
        text=(self.root/'journal.json').read_text()+(self.root/'result.json').read_text()
        for value in ['SYNTHETIC_HIDDEN_PASSWORD','SYNTHETIC_OWNER_OAUTH_TOKEN','synthetic-only-key',self.f.target['email']]:
            self.assertNotIn(value,text)
        self.assertFalse(self.path.exists());self.assertFalse((self.root/'owned-receipt.json').exists())
        self.assertGreater(self.calls,0)

    def test_local_envelope_never_dispatches_native_ports(self):
        with self.assertRaisesRegex(Stop,'NATIVE_REQUIRES_EXTERNAL_AUTHORITY'):
            entry.run_entry(self.path)
        self.assertEqual(self.calls,0);self.assertFalse((self.root/'attempt.json').exists())

    def test_approval_and_qualification_and_resource_drift_before_io(self):
        original=copy.deepcopy(self.e)
        for change in ['approval','qualification','source','target','resources','budget']:
            self.e=copy.deepcopy(original)
            if change=='approval':self.e['decision']['decision']='APPROVE_LOCAL_SINGLE_COORDINATOR'
            if change=='qualification':self.e['qualification']['checks']['owner']=False
            if change=='source':self.e['sourceManifestSha256']='0'*64
            if change=='target':self.e['target']['tenantId']='foreign'
            if change=='resources':self.e['resources']['image']='foreign'
            if change=='budget':self.e['limits']['cli']=True
            self.path.unlink();reserve(self.path,self.e)
            with self.assertRaises((Stop,entry.c.Stop)):self.run_entry()
            self.assertEqual(self.calls,0)

    def test_missing_external_decision_refuses(self):
        self.e['execution']='EXTERNAL';self.e['decision']={'commit':'0'*40,
            'path':'APP013_P08_NATIVE_OPERATION_20261101.json','sha256':'0'*64}
        self.path.unlink();reserve(self.path,self.e)
        with self.assertRaisesRegex(Stop,'COMMITTED_EVIDENCE_MISSING'):self.run_entry()
        self.assertEqual(self.calls,0)

    def test_concurrent_entry_refuses_before_io(self):
        fd=os.open(self.root/'entry.lock',os.O_CREAT|os.O_WRONLY,0o600)
        try:
            fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
            with self.assertRaisesRegex(Stop,'ENTRY_ALREADY_RUNNING'):self.run_entry()
        finally:os.close(fd)
        self.assertEqual(self.calls,0)

    def test_duplicate_attempt_never_replays(self):
        reserve(self.root/'attempt.json',{'operationId':self.f.p['operationId'],'planSha256':a.digest(self.f.p)})
        with self.assertRaises(FileExistsError):self.run_entry()
        self.assertEqual(self.calls,0)

    def test_foreign_file_and_symlink_refuse(self):
        foreign=self.root/'foreign.json';foreign.write_text('{}');os.chmod(foreign,0o600)
        with self.assertRaisesRegex(Stop,'PRIVATE_FOREIGN_OR_MODE'):self.run_entry()
        foreign.unlink();(self.root/'owned-receipt.json').symlink_to(self.path)
        with self.assertRaisesRegex(Stop,'PRIVATE_FOREIGN_OR_MODE'):self.run_entry()
        self.assertEqual(self.calls,0)

    def test_expired_start_refuses_before_io(self):
        with self.assertRaisesRegex(Exception,'START_CUTOFF'):
            entry.run_entry(self.path,io_factory=self.factory,clock=lambda:ta.restore.timestamp(self.f.p['window']['cutoff']))
        self.assertEqual(self.calls,0)

    def test_lost_child_output_is_not_authentication_success(self):
        self.scenario='lost_output';r=self.run_entry()
        self.assertEqual(r['status'],'ENTRY_CONTAINMENT_UNCONFIRMED')
        self.assertIn('AUTH_OUTCOME_UNKNOWN',r['residuals']);self.assertFalse(r['authProofReady'])
        self.assertFalse(any(self.f.runtime_state.values()))

    def test_session_disagreement_retains_residual(self):
        self.scenario='sessions';r=self.run_entry()
        self.assertEqual(r['status'],'ENTRY_CONTAINMENT_UNCONFIRMED')
        self.assertIn('ACCOUNT_SESSION',r['residuals'])

    def test_child_timeout_retains_residual_and_retires_runtime(self):
        self.scenario='timeout';r=self.run_entry()
        self.assertEqual(r['status'],'ENTRY_CONTAINMENT_UNCONFIRMED')
        self.assertIn('AUTH_REVOKE',r['residuals'])
        self.assertFalse(any(self.f.runtime_state.values()))

    def test_malformed_provider_output_cannot_succeed(self):
        self.f.transport.fail='service_null';r=self.run_entry()
        self.assertEqual(r['status'],'ENTRY_CLOSED',r) # safe stop before mutation is closed, not authenticated
        self.assertIsNone(r['childResultSha256']);self.assertFalse(r['authProofReady'])
        self.assertFalse(any(self.f.runtime_state.values()))

    def test_final_source_gate_and_separate_test_provenance(self):
        self.assertEqual(set(a.verify_sources()['files']),a.FILES)
        manifest=json.loads((a.HERE/'test-manifest.json').read_text())
        self.assertEqual(manifest['runtimeManifestSha256'],a.digest((a.HERE/'source-manifest.json').read_bytes()))
        for name,sha in manifest['files'].items():self.assertEqual(sha,a.digest((a.HERE/name).read_bytes()))
        self.assertEqual(self.e['sourceManifestSha256'],a.digest((a.HERE/'source-manifest.json').read_bytes()))

    def test_independent_closeout_recovers_interrupted_parent_after_start_cutoff(self):
        self.capture_recovery=True
        self.assertEqual(self.run_entry()['status'],'ENTRY_CLOSED')
        files,state,bindings,key=self.snapshot
        for p in self.root.iterdir():p.unlink()
        for name,data in files.items():
            (self.root/name).write_bytes(data);os.chmod(self.root/name,0o600)
        self.f.runtime_state.clear();self.f.runtime_state.update(state)
        self.f.transport.bindings=bindings;self.f.transport.key=key
        now=ta.restore.timestamp(self.f.p['window']['cutoff'])+1
        r=entry.run_entry(self.path,'closeout',self.factory,clock=lambda:now)
        self.assertEqual(r['status'],'ENTRY_CLOSED',r)
        self.assertEqual(r['residuals'],[])
        self.assertTrue((self.root/'independent-closeout.json').exists())
        self.assertFalse(any(self.f.runtime_state.values()))
        self.assertFalse(self.f.transport.bindings)
        self.assertTrue(self.f.transport.key.get('deleteTime'))
        self.assertFalse(self.path.exists())

    def test_late_cleanup_and_clock_rollback_refuse(self):
        # The reused coordinator labels its mode-specific entry cutoff START_CUTOFF.
        with self.assertRaisesRegex(Exception,'START_CUTOFF'):
            entry.run_entry(self.path,'closeout',self.factory,
                clock=lambda:ta.restore.timestamp(self.f.p['window']['cleanupEnd']))
        cap=a.Capability(self.e,self.root)
        cap.clock=lambda:cap.last-1
        with self.assertRaisesRegex(Stop,'CLOCK_ROLLBACK'):cap.gate()
        self.assertEqual(self.calls,0)

    def test_exact_committed_authority_validation_without_native_dispatch(self):
        self.e['execution']='EXTERNAL'
        raw=json.dumps({'owner':'Debynyhan Banks','decision':'APPROVE_EXACT_P08_NATIVE_ENTRY',
            'externalActionAuthorized':True,'operationId':self.f.p['operationId'],
            'scopeSha256':a.digest({k:v for k,v in self.e.items() if k!='decision'}),
            'sourceManifestSha256':self.e['sourceManifestSha256']}).encode()
        self.e['decision']={'commit':'1'*40,'path':'APP013_P08_NATIVE_OPERATION_20261101.json','sha256':a.digest(raw)}
        def fake_commit(repo,commit,path):
            return raw if repo==a.GOV else (a.BACKEND/path).read_bytes()
        self.assertTrue(a.Capability(self.e,self.root,read_commit=fake_commit).external)
        bad=copy.deepcopy(self.e);bad['limits']['https']-=1
        bad['qualification']['scopeSha256']=a.digest({k:bad[k] for k in ('plan','target','database','resources','limits')})
        with self.assertRaisesRegex(Stop,'EXACT_OWNER_APPROVAL'):a.Capability(bad,self.root,read_commit=fake_commit)
        def source_drift(repo,commit,path):
            return raw if repo==a.GOV else b'changed'
        with self.assertRaisesRegex(Stop,'COMMITTED_SOURCE_MANIFEST'):a.Capability(self.e,self.root,read_commit=source_drift)
        self.assertEqual(self.calls,0)

    def test_lifecycle_column_drift_at_each_phase_blocks_success(self):
        for phase in ('preflight','enabled','retired'):
            with self.subTest(phase=phase):
                t=EntryTests();t.setUp()
                try:
                    seen=[False]
                    def mutate(v,cleanup):
                        if v['login']:seen[0]=True
                        drift=(phase=='preflight' or phase=='enabled' and v['login'] or
                               phase=='retired' and seen[0] and not v['login'])
                        if drift:v['acl'].append(dict(kind='column',object='public.Job',column='status',
                                                      privilege_type='UPDATE',is_grantable=False))
                    t.role_mutator=mutate;r=t.run_entry()
                    self.assertFalse(r['authProofReady'])
                    if phase!='enabled':self.assertEqual(r['status'],'ENTRY_CONTAINMENT_UNCONFIRMED',r)
                    else:self.assertFalse(r['authenticationObserved'])
                    if phase=='preflight':self.assertIsNone(r['childResultSha256'])
                    self.assertGreater(t.role_reads,0)
                finally:t.doCleanups()

    def test_independent_closeout_rechecks_full_acl_after_interruption(self):
        self.capture_recovery=True;self.assertEqual(self.run_entry()['status'],'ENTRY_CLOSED')
        files,state,bindings,key=self.snapshot
        for p in self.root.iterdir():p.unlink()
        for name,data in files.items():
            (self.root/name).write_bytes(data);os.chmod(self.root/name,0o600)
        self.f.runtime_state.clear();self.f.runtime_state.update(state)
        self.f.transport.bindings=bindings;self.f.transport.key=key
        def drift(v,cleanup):v['acl'].pop()
        self.role_mutator=drift;before=self.role_reads
        r=entry.run_entry(self.path,'closeout',self.factory,
                          clock=lambda:ta.restore.timestamp(self.f.p['window']['cutoff'])+1)
        self.assertEqual(r['status'],'ENTRY_CONTAINMENT_UNCONFIRMED',r)
        self.assertTrue(r['residuals']);self.assertFalse(r['authProofReady'])
        self.assertGreater(self.role_reads,before)

    def test_lifecycle_strict_output_and_phase_predicates(self):
        cap=a.Capability(self.e,self.root);io=self.factory(cap)
        cap.coordinator=SimpleNamespace(abort=False,j={'nativeEntry':{'calls':dict.fromkeys(('cli','https','sql','child'),0)}},save=lambda:None)
        runtime=entry.RuntimeAdapter(cap,io);runtime.q=self.e['qualification']
        deadline=time.time()+30
        self.assertTrue(runtime.readback('role',ta.restore.ROLE,False,self.f.p,deadline))
        self.f.runtime_state[('role',ta.restore.ROLE)]=True
        self.assertTrue(runtime.readback('role',ta.restore.ROLE,True,self.f.p,deadline))
        changes=[('database','foreign'),('user','foreign'),('role','foreign'),('count',True),('count',0),
                 ('login',None),('limit',True),('expiryFinite',False),('expires','infinity'),
                 ('unsafe',True),('memberships',1),('owned',1),('schemaCreate',True),('databaseTemp',True)]
        for key,value in changes:
            with self.subTest(key=key,value=value):
                self.role_mutator=lambda v,c,k=key,x=value:v.update({k:x})
                with self.assertRaises(Stop):runtime.role(deadline)
        for key in ('acl','expires','expired'):
            self.role_mutator=lambda v,c,k=key:v.pop(k)
            with self.assertRaises(Stop):runtime.role(deadline)
        for key,value in [('expires','2000-01-01T00:00:00+00:00'),('limit',5),('login',False)]:
            self.role_mutator=lambda v,c,k=key,x=value:v.update({k:x})
            self.assertFalse(runtime.readback('role',ta.restore.ROLE,True,self.f.p,deadline))
        self.f.runtime_state[('role',ta.restore.ROLE)]=False
        self.role_mutator=lambda v,c:v.update(sessions=1)
        self.assertFalse(runtime.readback('role',ta.restore.ROLE,False,self.f.p,deadline))
        for raw in ('null','{}','{"count":1,"count":1}', 'x'*65537):
            runtime.sql_runner=lambda q,d,r=raw:r
            with self.assertRaises(Stop):runtime.role(deadline)

    def native_fixture(self):
        legacy=a.load('p08-restoration-local-20261028/source/legacy/controller.py','native_io_test_legacy')
        self.e['database']={'host':legacy.DB_HOST,'port':5432,'database':legacy.DB_NAME,'user':legacy.DB_ADMIN}
        self.e['execution']='EXTERNAL'
        self.e['qualification']['scopeSha256']=a.digest({k:self.e[k] for k in ('plan','target','database','resources','limits')})
        raw=json.dumps({'owner':'Debynyhan Banks','decision':'APPROVE_EXACT_P08_NATIVE_ENTRY',
            'externalActionAuthorized':True,'operationId':self.f.p['operationId'],
            'scopeSha256':a.digest({k:v for k,v in self.e.items() if k!='decision'}),
            'sourceManifestSha256':self.e['sourceManifestSha256']}).encode()
        self.e['decision']={'commit':'1'*40,'path':'APP013_P08_NATIVE_OPERATION_20261101.json','sha256':a.digest(raw)}
        cap=a.Capability(self.e,self.root,read_commit=lambda repo,commit,path:raw if repo==a.GOV else (a.BACKEND/path).read_bytes())
        cap.coordinator=SimpleNamespace(abort=False,j={'nativeEntry':{'calls':dict.fromkeys(('cli','https','sql','child'),0)}},save=lambda:None)
        return cap,entry.NativeIO(cap)

    def test_actual_native_sql_serializer_uses_pinned_tls_and_safe_errors(self):
        cap,io=self.native_fixture();io.token='SYNTHETIC_TOKEN';io.password='SYNTHETIC_PASSWORD'
        query=next(q for q in io.allowed_sql if 'aclexplode' in q)
        with patch('native_io.subprocess.run',return_value=subprocess.CompletedProcess([],0,b'{}',b'')) as run:
            self.assertEqual(io.sql(query,0),'{}')
            args,kw=run.call_args
            self.assertEqual(args[0][0],io.legacy.PSQL);self.assertTrue(Path(args[0][0]).is_file())
            self.assertEqual(kw['input'],query.encode())
            self.assertEqual(kw['env']['PGSSLMODE'],'verify-full')
            self.assertEqual(kw['env']['PGAPPNAME'],'p08-runtime-'+self.f.p['operationId'])
            self.assertNotIn('DATABASE_URL',kw['env'])
            self.assertNotIn('SYNTHETIC_PASSWORD',' '.join(args[0]))
        for response,code in [(subprocess.CompletedProcess([],0,b'x'*65537,b''),'NATIVE_COMMAND_REFUSED'),
                              (subprocess.CompletedProcess([],0,b'\xff',b''),'NATIVE_OUTPUT_ENCODING'),
                              (subprocess.CompletedProcess([],1,b'',b'SYNTHETIC_PASSWORD'),'NATIVE_COMMAND_REFUSED')]:
            with patch('native_io.subprocess.run',return_value=response):
                with self.assertRaisesRegex(Stop,code):io.sql(query,0)
        with patch('native_io.subprocess.run') as run:
            with self.assertRaisesRegex(Stop,'SQL_ALLOWLIST'):io.sql('SELECT foreign',0)
            old=[];ta.restore.NativeAdapter(None,'',sql=lambda q,d:old.append(q) or '{}').role(0)
            with self.assertRaisesRegex(Stop,'SQL_ALLOWLIST'):io.sql(old[0],0)
            run.assert_not_called()
        io.clear();self.assertEqual((io.token,io.password),('',''))

    def test_actual_native_owner_boundary_refuses_drift_before_token_or_password(self):
        cap,io=self.native_fixture()
        with patch.object(io.restore,'local_environment_gate'),patch('native_io.subprocess.run',
             return_value=subprocess.CompletedProcess([],0,b'foreign@example.invalid',b'')) as run,\
             patch.object(io.legacy,'private_input') as password:
            with self.assertRaisesRegex(Stop,'OWNER_DRIFT'):io.credentials()
            self.assertEqual(run.call_count,1);password.assert_not_called()
            self.assertEqual(io.token,'')


if __name__=='__main__':unittest.main()
