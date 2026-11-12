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
LEGACY_FIXTURE_RESTORE=ta.restore


class EntryTests(unittest.TestCase):
    def setUp(self):
        self.f=ta.AdapterTests()
        with patch.object(ta,'restore',LEGACY_FIXTURE_RESTORE):self.f.setUp()
        f=self.f
        self.addCleanup(f.tearDown)
        # Adapt only the inherited synthetic provider after its legacy constructor.
        lifecycle_patch=patch.object(ta,'restore',entry.restore);lifecycle_patch.start();self.addCleanup(lifecycle_patch.stop)
        f.runtime_state={x:False for x in entry.restore.operations({**f.p,'iam':[]})}
        now=int(time.time());f.now=now
        iso=lambda x:datetime.datetime.fromtimestamp(now+x,datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')
        f.p['window']={'start':iso(-10),'cutoff':iso(120),'workEnd':iso(180),'cleanupEnd':iso(900),'purgeEnd':iso(950)}
        f.target['email']=f.p['ownerPrincipal']
        self.root=Path('/private/tmp/p08-coordinator-'+f.p['operationId']);self.root.mkdir(mode=0o700)
        self.addCleanup(lambda:shutil.rmtree(self.root))
        self.path=self.root/'envelope.json'
        binding=a.load('p08-key-correction-20261110/binding.py','entry_test_active_binding')
        resources=binding.resource_pins(entry.restore)
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
                             user=cap.e['database']['user'],serverVersion=160000,membershipEdges=[],expiryFinite=True,schemaCreate=False,databaseTemp=False,
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

    def test_preflight_diagnostics_through_actual_run_and_cleanup(self):
        cases = [
            (Stop('ROLE_OUTPUT_UNKNOWN'), 'ROLE_OUTPUT_UNKNOWN'),
            (Stop('ROLE_ACL_DRIFT'), 'ROLE_ACL_DRIFT'),
            (entry.restore.Stop('OWNER_MISMATCH'), 'OWNER_MISMATCH'),
            (entry.bridge.packet.Stop('PROJECT_DRIFT'), 'PROJECT_DRIFT'),
            (entry.c.Stop('INTERRUPTED'), 'INTERRUPTED'),
            (Stop('UNREVIEWED_CODE'), 'LOCAL_ADAPTER_OR_SOURCE_STOP'),
            (Stop('synthetic-private-password'), 'LOCAL_ADAPTER_OR_SOURCE_STOP'),
            (ValueError('ROLE_OUTPUT_UNKNOWN'), 'LOCAL_ADAPTER_OR_SOURCE_STOP'),
            (RuntimeError('synthetic-private-password'), 'LOCAL_ADAPTER_OR_SOURCE_STOP'),
            (KeyboardInterrupt(), 'LOCAL_ADAPTER_OR_SOURCE_STOP'),
        ]
        for stage, adapter in [('RUNTIME_PREFLIGHT', entry.RuntimeAdapter),
                               ('ACCESS_PREFLIGHT', entry.Ports)]:
            for error, expected in cases:
                with self.subTest(stage=stage, error=type(error).__name__, expected=expected):
                    t=EntryTests();t.setUp()
                    try:
                        with patch.object(adapter, 'preflight', side_effect=error):
                            result=t.run_entry()
                        journal=read(t.root/'journal.json')
                        self.assertEqual(journal['preflightStage'],stage)
                        self.assertEqual(journal['failure'],expected)
                        self.assertEqual(journal['runtimeAttempted'],[])
                        self.assertEqual(journal['iamAttempted'],[])
                        self.assertFalse(journal['authAttempted'])
                        self.assertFalse(result['authenticationObserved'])
                        self.assertEqual(result['status'],'ENTRY_CLOSED')
                        self.assertTrue(result['privateInputsAbsent'])
                        self.assertEqual(result['residuals'],[])
                        self.assertNotIn('synthetic-private-password',json.dumps(journal))
                    finally:t.doCleanups()

    def test_policy_projection_preserves_serialized_binding_checks(self):
        cap=a.Capability(self.e,self.root)
        policies={}
        calls=[]
        def cli(vector):
            calls.append(vector)
            value=policies['value']
            # Model the existing gcloud field projection, not a parser bypass.
            if vector[-1]=='--format=json(bindings,etag,version)' and isinstance(value,dict):
                value={k:v for k,v in value.items() if k in ('bindings','etag','version')}
            return json.dumps(value)
        ports=entry.Ports(cap,SimpleNamespace(cli=cli,https=lambda d:None),None,None)
        for kind in ('lookup','signing'):
            for value in ({}, {'bindings':[]}, {'bindings':[], 'etag':'synthetic','version':1,
                                              'auditConfigs':[{'service':'allServices'}]}):
                policies['value']=value
                self.assertEqual(ports.policy(kind),'ABSENT')
                self.assertEqual(calls[-1][-1],'--format=json(bindings,etag,version)')
            policies['value']={'bindings':'malformed'}
            with self.assertRaisesRegex(Exception,'POLICY_SHAPE'):ports.policy(kind)
            role=next(r for r in ports.iam if r['kind']==kind)
            policies['value']={'bindings':[{'role':role['roleId'],'members':['wrong-member']}]}
            with self.assertRaisesRegex(Exception,'POLICY_OWNERSHIP'):ports.policy(kind)
            member=('serviceAccount:'+cap.e['resources']['identity'] if kind=='lookup'
                    else 'user:'+cap.plan['ownerPrincipal'])
            policies['value']={'bindings':[{'role':role['roleId'],'members':[member]}]}
            with self.assertRaisesRegex(Exception,'POLICY_CONDITION'):ports.policy(kind)
        vector=['projects','describe',cap.plan['project'],'--format=json']
        policies['value']={'auditConfigs':[]}
        ports.cloud(vector)
        self.assertEqual(calls[-1],vector)

    def test_preflight_policy_projection_firewall_retains_runtime_reads(self):
        self.preflight_setup();cap=a.Capability(self.e,self.root);cap.external=True
        legacy=a.load('p08-restoration-local-20261028/source/legacy/controller.py','ps1_vector_legacy')
        cap.e['database']={'host':legacy.DB_HOST,'port':5432,'database':legacy.DB_NAME,'user':legacy.DB_ADMIN}
        io=entry.PreflightIO(cap)
        project=cap.plan['project'];identity=cap.e['resources']['identity']
        for vector in (['projects','get-iam-policy',project,'--format=json'],
                       ['iam','service-accounts','get-iam-policy',identity,'--project='+project,'--format=json']):
            self.assertIn(tuple(vector),io.read_vectors)
            self.assertIn(tuple([*vector[:-1],'--format=json(bindings,etag,version)']),io.read_vectors)
        with patch.object(io,'ensure_owner',side_effect=AssertionError('credentials forbidden')):
            for vector in (['projects','get-iam-policy','other','--format=json(bindings,etag,version)'],
                           ['projects','set-iam-policy',project,'--format=json(bindings,etag,version)']):
                with self.assertRaisesRegex(Stop,'PREFLIGHT_CLI_DENIED'):io.cli(vector)
        self.assertEqual(a.PREFLIGHT_LIMITS,{'cli':40,'https':1,'sql':3,'child':0})

    def preflight_setup(self):
        self.e['purpose']='NATIVE_PREFLIGHT_ONLY'
        self.e['decision']={'decision':'APPROVE_LOCAL_PREFLIGHT_PROOF',
            'scopeSha256':a.digest({k:v for k,v in self.e.items() if k!='decision'})}
        self.path.unlink();reserve(self.path,self.e)

    def preflight_factory(self,cap):
        io=self.factory(cap);io.cleanup=cap.mode=='close-preflight'
        original=io.sql
        io.close_sql='SYNTHETIC_SESSION_READ'
        io.close_processes=lambda deadline:True
        io.sql=lambda query,deadline: ('{"sessionsAbsent":true}' if query==io.close_sql else original(query,deadline))
        return io

    def test_preflight_only_success_and_independent_cleanup(self):
        self.preflight_setup()
        with patch.object(entry.c.Coordinator,'run',side_effect=AssertionError('activation forbidden')), \
             patch.object(entry.Coordinator,'closeout',side_effect=AssertionError('resource cleanup forbidden')):
            result=entry.run_preflight_entry(self.path,'preflight',self.preflight_factory)
            self.assertTrue(result['preflightPassed'],result)
            self.assertFalse(result['privateInputsAbsent'])
            self.assertFalse(result['paymentObserved'])
            journal=read(self.root/'journal.json')
            self.assertEqual(journal['runtimeAttempted'],[])
            self.assertEqual(journal['iamAttempted'],[])
            self.assertEqual(journal['nativeEntry']['calls']['child'],0)
            with self.assertRaises(FileExistsError):entry.run_preflight_entry(self.path,'preflight',self.preflight_factory)
            closed=entry.run_preflight_entry(self.path,'close-preflight',self.preflight_factory)
            self.assertEqual(closed['status'],'NATIVE_PREFLIGHT_CLOSED')
            self.assertTrue(closed['privateInputsAbsent'])

    def test_preflight_only_cross_mode_authority_rejected_before_io(self):
        self.preflight_setup()
        with self.assertRaisesRegex(Stop,'ENTRY_PURPOSE_MODE'):self.run_entry()
        with self.assertRaisesRegex(Stop,'ENTRY_PURPOSE_MODE'):self.run_entry('closeout')
        self.e['decision']['decision']='APPROVE_LOCAL_NATIVE_ENTRY_PROOF'
        self.path.unlink();reserve(self.path,self.e)
        with self.assertRaisesRegex(Stop,'LOCAL_PROOF_BINDING'):
            entry.run_preflight_entry(self.path,'preflight',self.preflight_factory)
        self.assertEqual(self.calls,0)

    def test_preflight_only_refusal_interruption_and_uncertain_cleanup(self):
        for error in (Stop('ROLE_OUTPUT_UNKNOWN'),KeyboardInterrupt(),ValueError('synthetic-private-secret')):
            t=EntryTests();t.setUp()
            try:
                t.preflight_setup()
                with patch.object(entry.RuntimeAdapter,'preflight',side_effect=error):
                    result=entry.run_preflight_entry(t.path,'preflight',t.preflight_factory)
                self.assertFalse(result['preflightPassed'])
                self.assertNotIn('synthetic-private-secret',json.dumps(result))
                j=read(t.root/'journal.json');j['preflightProcessPending']=True
                (t.root/'journal.json').write_text(json.dumps(j))
                closed=entry.run_preflight_entry(t.path,'close-preflight',t.preflight_factory)
                self.assertIn('PREFLIGHT_PROCESS_HISTORY_UNKNOWN',closed['residuals'])
                self.assertTrue(closed['privateInputsAbsent'])
            finally:t.doCleanups()

    def test_preflight_only_lock_and_deadline_refuse_before_io(self):
        self.preflight_setup()
        fd=os.open(self.root/'entry.lock',os.O_WRONLY|os.O_CREAT,0o600)
        try:
            fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
            with self.assertRaisesRegex(Stop,'ENTRY_ALREADY_RUNNING'):
                entry.run_preflight_entry(self.path,'preflight',self.preflight_factory)
        finally:os.close(fd)
        with self.assertRaises(Exception):
            entry.run_preflight_entry(self.path,'preflight',self.preflight_factory,
                clock=lambda:entry.restore.timestamp(self.e['plan']['window']['cutoff']))
        self.assertEqual(self.calls,0)

    def test_preflight_actual_parent_death_retains_unknown_and_independently_purges(self):
        import signal
        self.preflight_setup()
        pid=os.fork()
        if pid==0:
            def crash(runtime,*args,**kwargs):
                runtime.cap.coordinator.j['preflightProcessPending']=True
                runtime.cap.coordinator.save()
                os.kill(os.getpid(),signal.SIGKILL)
            with patch.object(entry.RuntimeAdapter,'preflight',crash):
                entry.run_preflight_entry(self.path,'preflight',self.preflight_factory)
            os._exit(9)
        _,status=os.waitpid(pid,0)
        self.assertTrue(os.WIFSIGNALED(status))
        closed=entry.run_preflight_entry(self.path,'close-preflight',self.preflight_factory)
        self.assertEqual(closed['status'],'NATIVE_PREFLIGHT_CONTAINMENT_UNCONFIRMED')
        self.assertIn('PREFLIGHT_PROCESS_HISTORY_UNKNOWN',closed['residuals'])
        self.assertTrue(closed['privateInputsAbsent'])
        self.assertFalse(closed['paymentObserved'])

    def test_preflight_actual_read_vectors_match_firewall_and_effective_budget(self):
        self.preflight_setup()
        cap=a.Capability(self.e,self.root,'preflight')
        legacy=a.load('p08-restoration-local-20261028/source/legacy/controller.py','nq_vector_legacy')
        cap.external=True
        cap.e['database']={'host':legacy.DB_HOST,'port':5432,'database':legacy.DB_NAME,'user':legacy.DB_ADMIN}
        firewall=entry.PreflightIO(cap);seen=[]
        def factory(current):
            io=self.preflight_factory(current);cloud,cli,https=io.cloud,io.cli,io.https
            def checked_cloud(v,d):
                self.assertIn(tuple(v),firewall.read_vectors);seen.append(tuple(v));return cloud(v,d)
            def checked_cli(v):
                self.assertIn(tuple(v),firewall.read_vectors);seen.append(tuple(v));return cli(v)
            def checked_https(d):
                self.assertEqual(d['method'],'GET');self.assertEqual(d['url'],firewall.service_url)
                self.assertIsNone(d['body'])
                with patch.object(entry.NativeIO,'https',side_effect=https):return firewall.https(d)
            io.cloud=checked_cloud;io.cli=checked_cli;io.https=checked_https
            return io
        result=entry.run_preflight_entry(self.path,'preflight',factory)
        self.assertTrue(result['preflightPassed'],result)
        self.assertTrue(seen)
        self.assertLessEqual(len(seen)+10,a.PREFLIGHT_LIMITS['cli'])
        controller=SimpleNamespace(j={'nativeEntry':{'calls':{'cli':0,'https':0,'sql':0,'child':0}}},save=lambda:None,abort=False)
        cap.coordinator=controller
        with self.assertRaisesRegex(Stop,'ENTRY_CALL_LIMIT'):cap.spend('child')
        cap.coordinator.j['nativeEntry']['calls']['https']=1
        with self.assertRaisesRegex(Stop,'ENTRY_CALL_LIMIT'):cap.spend('https')
        closed=entry.run_preflight_entry(self.path,'close-preflight',factory)
        self.assertEqual(closed['residuals'],[])

    def test_preflight_external_decision_source_and_mode_are_exact(self):
        self.preflight_setup();self.e['execution']='EXTERNAL'
        d={'owner':'Debynyhan Banks','decision':'APPROVE_EXACT_P08_NATIVE_PREFLIGHT_READ',
           'externalReadAuthorized':True,'operationId':self.f.p['operationId'],
           'scopeSha256':a.digest({k:v for k,v in self.e.items() if k!='decision'}),
           'sourceManifestSha256':self.e['sourceManifestSha256']}
        raw=json.dumps(d).encode()
        self.e['decision']={'commit':'1'*40,'path':'APP013_P08_NATIVE_OPERATION_20261101.json','sha256':a.digest(raw)}
        read_commit=lambda repo,commit,path:raw if repo==a.GOV else (a.BACKEND/path).read_bytes()
        cap=a.Capability(self.e,self.root,read_commit=read_commit)
        self.assertEqual(cap.mode,'preflight');self.assertTrue(cap.external)
        with self.assertRaisesRegex(Stop,'ENTRY_PURPOSE_MODE'):a.Capability(self.e,self.root,'run',read_commit=read_commit)
        wrong=json.dumps({**d,'decision':'APPROVE_EXACT_P08_CONNECTED_PAYMENT'}).encode()
        self.e['decision']['sha256']=a.digest(wrong)
        with self.assertRaisesRegex(Stop,'EXACT_OWNER_APPROVAL'):
            a.Capability(self.e,self.root,read_commit=lambda repo,c,p:wrong if repo==a.GOV else (a.BACKEND/p).read_bytes())
        self.e['decision']['sha256']=a.digest(raw)
        with self.assertRaisesRegex(Stop,'COMMITTED_SOURCE_MANIFEST'):
            a.Capability(self.e,self.root,read_commit=lambda repo,c,p:raw if repo==a.GOV else b'changed')
        self.assertEqual(self.calls,0)

    def test_preflight_owned_process_output_timeout_and_cleanup(self):
        self.preflight_setup();cap=a.Capability(self.e,self.root,'preflight')
        legacy=a.load('p08-restoration-local-20261028/source/legacy/controller.py','nq_process_legacy')
        cap.external=True
        cap.e['database']={'host':legacy.DB_HOST,'port':5432,'database':legacy.DB_NAME,'user':legacy.DB_ADMIN}
        io=entry.PreflightIO(cap)
        cap.coordinator=SimpleNamespace(j={'nativeEntry':{'calls':{'cli':0,'https':0,'sql':0,'child':0}}},save=lambda:None,abort=False)
        owned=io.processes._owned_run
        vector=['/opt/homebrew/bin/gcloud','auth','list','--filter=status:ACTIVE','--format=value(account)']
        for script,success in [("print('synthetic')",True),("print('x'*70000)",False),('import time;time.sleep(20)',False)]:
            def synthetic(argv,env,deadline):
                self.assertEqual(argv,vector)
                return owned([sys.executable,'-c',script],env,min(deadline,time.time()+2.5))
            with patch.object(io.processes,'_owned_run',side_effect=synthetic):
                if success:self.assertEqual(io._run(vector,'cli'),'synthetic')
                else:
                    with self.assertRaisesRegex(Stop,'PREFLIGHT_PROCESS_UNCONFIRMED'):io._run(vector,'cli')
            self.assertFalse(io.processes.children)
            self.assertFalse(cap.coordinator.j['preflightProcessPending'])
        self.assertTrue(io.close_processes(cap.times['cleanupEnd']))

    def test_preflight_transport_firewall_denies_before_credentials_or_reservation(self):
        self.preflight_setup()
        cap=a.Capability(self.e,self.root,'preflight')
        legacy=a.load('p08-restoration-local-20261028/source/legacy/controller.py','nq_test_legacy')
        cap.external=True
        cap.e['database']={'host':legacy.DB_HOST,'port':5432,'database':legacy.DB_NAME,'user':legacy.DB_ADMIN}
        io=entry.PreflightIO(cap)
        with patch.object(io,'ensure_owner',side_effect=AssertionError('credentials forbidden')), \
             patch.object(cap,'spend',side_effect=AssertionError('reservation forbidden')):
            for vector in [['services','enable','apikeys.googleapis.com'],
                           ['secrets','versions','enable','2','--secret=signmons-staging-stripe-secret-key'],
                           ['projects','describe','another-project','--format=json'],
                           [*next(iter(io.read_vectors)),'--impersonate-service-account=foreign']]:
                with self.assertRaisesRegex(Stop,'PREFLIGHT_CLI_DENIED'):io.cli(vector)
            for query in [io.read_sql+' SELECT 1;',io.restore.role_sql(False),io.close_sql+';']:
                with self.assertRaisesRegex(Stop,'PREFLIGHT_SQL_DENIED'):io.sql(query,cap.times['workEnd'])
            for descriptor in [{'method':'POST','url':io.service_url,'body':None,'timeoutSeconds':8,'redirect':'error'},
                               {'method':'GET','url':io.service_url+'/other','body':None,'timeoutSeconds':8,'redirect':'error'}]:
                with self.assertRaisesRegex(Stop,'PREFLIGHT_HTTPS_DENIED'):io.https(descriptor)
            with self.assertRaisesRegex(Stop,'PREFLIGHT_CHILD_DENIED'):io.child(['anything'])
        self.assertIn(('secrets','versions','describe',cap.e['resources']['secretVersions']['signmons-staging-stripe-secret-key'],
                       '--secret=signmons-staging-stripe-secret-key','--project=signmons','--format=json(state)'),io.read_vectors)

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

    def test_exact_admin_membership_active_retired_and_independent_readback(self):
        self.e['database'].update(database='neondb',user='neondb_owner')
        self.e['qualification']['scopeSha256']=a.digest({k:self.e[k] for k in ('plan','target','database','resources','limits')})
        rows=self.acl.expected_retired_acl()
        for row in rows:
            if row['kind']=='database':row['object']='neondb'
        self.e['qualification']['roleAclSha256']=self.acl.classify_role_acl(rows,'neondb',self.acl.expected_retired_acl())[0]['roleAclSha256']
        self.seal()
        cap=a.Capability(self.e,self.root);io=self.factory(cap)
        cap.coordinator=SimpleNamespace(abort=False,j={'nativeEntry':{'calls':dict.fromkeys(('cli','https','sql','child'),0)}},save=lambda:None)
        runtime=entry.RuntimeAdapter(cap,io);runtime.q=self.e['qualification'];deadline=time.time()+30
        def exact(v,c):v.update(memberships=1,membershipEdges=[dict(self.acl.ADMIN_MEMBERSHIP)],database='neondb',user='neondb_owner')
        # Fixture resources already pin the same database/admin names.
        self.role_mutator=exact
        self.assertEqual(runtime.role(deadline)['memberships'],1)
        self.assertTrue(runtime.readback('role',ta.restore.ROLE,False,self.f.p,deadline))
        self.f.runtime_state[('role',ta.restore.ROLE)]=True
        self.assertTrue(runtime.readback('role',ta.restore.ROLE,True,self.f.p,deadline))
        self.f.runtime_state[('role',ta.restore.ROLE)]=False
        fresh=entry.RuntimeAdapter(cap,self.factory(cap));fresh.q=self.e['qualification']
        self.assertTrue(fresh.readback('role',ta.restore.ROLE,False,self.f.p,deadline))
        for key,value in [('inherit',True),('set',True),('admin',False),('grantor','foreign'),('member','foreign')]:
            def drift(v,c,k=key,x=value):exact(v,c);v['membershipEdges'][0][k]=x
            self.role_mutator=drift
            with self.subTest(key=key),self.assertRaises(Stop):runtime.role(deadline)
        def temp(v,c):exact(v,c);v['databaseTemp']=True
        self.role_mutator=temp
        with self.assertRaises(Stop):runtime.role(deadline)

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

    def test_actual_lifecycle_mutations_select_json_and_reject_missing_structured_output(self):
        cap,io=self.native_fixture();io.token='SYNTHETIC_TOKEN';r=io.restore;plan={**cap.plan,'iam':[]}
        cases=[('tag',r.TAG),('secretBinding',r.POLICIES[0]),('identity',r.IDENTITY),('version',r.SECRETS[0])]
        for kind,name in cases:
            for enabled in (True,False):
                vector=r.command(plan,kind,name,enabled);original=list(vector)
                def response(argv,**kwargs):
                    return subprocess.CompletedProcess([],0,b'{}' if '--format=json' in argv else b'bindings: []',b'')
                with patch('native_io.subprocess.run',side_effect=response) as run:
                    self.assertEqual(io.cloud(vector,0),{});self.assertEqual(vector,original)
                    self.assertEqual(run.call_args.args[0],['/opt/homebrew/bin/gcloud',*original,'--format=json'])
        for kind,name in cases:
            vector=r.command(plan,kind,name,False)
            for raw in (b'',b'null',b'[]',b'status: unknown'):
                with patch('native_io.subprocess.run',return_value=subprocess.CompletedProcess([],0,raw,b'')):
                    if raw==b'' and kind in ('identity','version'):self.assertEqual(io.cloud(vector,0),{})
                    else:
                        with self.assertRaisesRegex(Stop,'NATIVE_OUTPUT_SHAPE'):io.cloud(vector,0)
        vector=['run','services','describe','signmons-calldesk-staging','--project=signmons','--region=us-east5','--format=json(status.traffic)']
        with patch('native_io.subprocess.run',return_value=subprocess.CompletedProcess([],0,b'{}',b'')) as run:
            self.assertEqual(io.cloud(vector,0),{});self.assertEqual(run.call_args.args[0],['/opt/homebrew/bin/gcloud',*vector])

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
        for response,code in [(subprocess.CompletedProcess([],0,b'x'*65537,b''),'DATABASE_OUTPUT_LIMIT'),
                              (subprocess.CompletedProcess([],0,b'\xff',b''),'DATABASE_OUTPUT_ENCODING'),
                              (subprocess.CompletedProcess([],1,b'',b'SYNTHETIC_PASSWORD'),'DATABASE_COMMAND_FAILED')]:
            with patch('native_io.subprocess.run',return_value=response):
                with self.assertRaisesRegex(Stop,code):io.sql(query,0)
        with patch('native_io.subprocess.run') as run:
            with self.assertRaisesRegex(Stop,'SQL_ALLOWLIST'):io.sql('SELECT foreign',0)
            old=[];ta.restore.NativeAdapter(None,'',sql=lambda q,d:old.append(q) or '{}').role(0)
            with self.assertRaisesRegex(Stop,'SQL_ALLOWLIST'):io.sql(old[0],0)
            run.assert_not_called()
        io.clear();self.assertEqual((io.token,io.password),('',''))

    def test_sql_failure_categories_use_existing_classifier_and_clear_output(self):
        cap,io=self.native_fixture();io.token='SYNTHETIC_TOKEN';io.password='SYNTHETIC_PASSWORD'
        query=next(q for q in io.allowed_sql if 'aclexplode' in q)
        cases=[(b'password authentication failed','DATABASE_AUTHENTICATION'),
               (b'certificate verify failed','DATABASE_TLS_CONFIGURATION'),
               (b'connection refused','DATABASE_CONNECTION'),
               (b'permission denied for relation private_table','DATABASE_SCHEMA_OR_QUERY'),
               (b'canceling statement due to statement timeout','DATABASE_STATEMENT_TIMEOUT'),
               (b'unknown failure','DATABASE_COMMAND_FAILED'),
               (b'x'*65537,'DATABASE_ERROR_OUTPUT_LIMIT')]
        for stderr,code in cases:
            cap,io=self.native_fixture();io.token='SYNTHETIC_TOKEN';io.password='SYNTHETIC_PASSWORD'
            response=subprocess.CompletedProcess([],2,b'PRIVATE_SENTINEL',stderr+b' PRIVATE_SENTINEL')
            with patch('native_io.subprocess.run',return_value=response) as run:
                with self.assertRaisesRegex(Stop,'^'+code+'$'):io.sql(query,0)
                run.assert_called_once();self.assertEqual(response.stdout,b'');self.assertEqual(response.stderr,b'')
                self.assertEqual(run.call_args.kwargs['env']['PGPASSWORD'],'')
        for error,code in [(subprocess.TimeoutExpired('PRIVATE_SENTINEL',8),'DATABASE_PROCESS_TIMEOUT'),(OSError('PRIVATE_SENTINEL'),'DATABASE_PROCESS_UNAVAILABLE')]:
            cap,io=self.native_fixture();io.token='SYNTHETIC_TOKEN';io.password='SYNTHETIC_PASSWORD'
            with patch('native_io.subprocess.run',side_effect=error) as run:
                with self.assertRaisesRegex(Stop,'^'+code+'$'):io.sql(query,0)
                run.assert_called_once();self.assertEqual(run.call_args.kwargs['env']['PGPASSWORD'],'')

    def test_actual_native_owner_boundary_refuses_drift_before_token_or_password(self):
        cap,io=self.native_fixture()
        with patch.object(io.restore,'local_environment_gate'),patch('native_io.subprocess.run',
             return_value=subprocess.CompletedProcess([],0,b'foreign@example.invalid',b'')) as run,\
             patch.object(io.legacy,'private_input') as password:
            with self.assertRaisesRegex(Stop,'OWNER_DRIFT'):io.credentials()
            self.assertEqual(run.call_count,1);password.assert_not_called()
            self.assertEqual(io.token,'')


class ConnectedEntryTests(EntryTests):
    def setUp(self):
        super().setUp()
        import uuid
        p=self.e['plan']; stamp='2026-01-01T00:00:00.000Z'
        draft={'currency':'usd','serviceFeeRequired':False,'serviceFeeCents':None,'depositRequired':True,
               'depositPolicy':{'kind':'fixed','amountCents':12500},'emergencyFeePolicy':{'kind':'none'},
               'paymentGateMode':'fail_closed','webhookValidationRequired':True}
        approved={'draft':draft,'actorId':self.e['target']['id'],'approvedAt':stamp}
        self.e['version']=2
        self.e['limits']['cli']=192
        self.e['payment']={'qualificationId':str(uuid.uuid4()),'endpointId':'we_synthetic','endpointSha256':a.digest(b'we_synthetic'),
            'apiVersion':'2026-03-25.dahlia','url':'https://app013-p07-atomic---signmons-calldesk-staging-p572d6wipq-ul.a.run.app/webhooks/stripe',
            'connectedAccountSha256':a.digest(b'acct_synthetic'),'amountTotalCents':12500,'currency':'usd',
            'approvedAt':stamp,'policyDigest':a.digest(json.dumps(approved,separators=(',',':')).encode()),
            'jobUpdatedAt':stamp,'requestId':str(uuid.uuid4()),
            'workEnd':datetime.datetime.fromtimestamp(time.time()+90,datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')}
        self.e['qualification']['scopeSha256']=a.digest({k:self.e[k] for k in ('plan','target','database','resources','limits','payment')})
        self.seal()

    def factory(self,cap):
        io=super().factory(cap)
        # Reuse the actual credential acquisition sequence, with only command I/O synthetic.
        owner=object.__new__(entry.NativeIO)
        owner.cap,owner.cleanup,owner.token=cap,cap.mode!='run',''
        owner.restore=SimpleNamespace(local_environment_gate=lambda:None)
        def command(argv,kind,*args,**kwargs):
            cap.spend(kind,owner.cleanup)
            if argv[1:3]==['auth','list']:return cap.plan['ownerPrincipal']
            if argv[1:3]==['auth','print-access-token']:return 'SYNTHETIC_OWNER_OAUTH_TOKEN'
            return '(unset)'
        owner._run=command
        for name in ('credentials','cli','cloud','https'):
            original=getattr(io,name)
            def wrapped(*args,_original=original,**kwargs):
                owner.ensure_owner()
                return _original(*args,**kwargs)
            setattr(io,name,wrapped)
        return io

    def test_preflight_transport_failure_before_payment_journal_preserves_closeout(self):
        factory=self.factory
        def failed_factory(cap):
            io=factory(cap);child=io.child
            def fail(argv,**kwargs):
                if argv[2]=='--payment-preflight':raise RuntimeError('SYNTHETIC_PREFLIGHT_FAILURE')
                return child(argv,**kwargs)
            io.child=fail;return io
        result=entry.run_entry(self.path,io_factory=failed_factory)
        self.assertEqual(result['status'],'ENTRY_AWAITING_INDEPENDENT_CLOSEOUT')
        self.assertFalse(result['paymentObserved']);self.assertTrue(self.path.exists())
        journal=read(self.root/'journal.json')
        self.assertIsNone(journal['payment']);self.assertFalse(journal['authAttempted'])
        self.assertEqual(journal['failure'],'PAYMENT_PREFLIGHT_STOP')
        self.assertFalse(any(self.f.runtime_state.values()))
        closed=self.run_entry('closeout')
        self.assertEqual(closed['status'],'ENTRY_CLOSED',closed)
        self.assertFalse(closed['paymentObserved']);self.assertTrue(closed['privateInputsAbsent'])

    def test_preflight_refusal_never_activates_runtime(self):
        self.scenario='foreign_endpoint'
        self.run_entry()
        j=read(self.root/'journal.json')
        self.assertFalse(j['authAttempted'])
        self.assertFalse(j['payment']['enableIntent'])
        self.assertEqual(j['nativeEntry']['calls']['child'],1)
        self.assertFalse(any(self.f.runtime_state.values()))
        self.assertEqual(self.run_entry('closeout')['status'],'ENTRY_CLOSED')

    def test_late_child_return_preserves_payment_intent_for_cleanup(self):
        factory=self.factory
        def late_factory(cap):
            io=factory(cap);child=io.child
            def late(argv,**kwargs):
                result=child(argv,**kwargs)
                if argv[2]=='--run':cap.clock=lambda:cap.times['workEnd']+1
                return result
            io.child=late
            return io
        r=entry.run_entry(self.path,io_factory=late_factory)
        self.assertEqual(r['status'],'ENTRY_AWAITING_INDEPENDENT_CLOSEOUT')
        j=read(self.root/'journal.json')
        self.assertTrue(j['payment']['enableIntent'])
        self.assertEqual(j['payment']['outcome'],'APPLICATION_SETTLED')
        self.assertGreaterEqual(j['payment']['endpointCalls'],6)
        closed=self.run_entry('closeout')
        self.assertEqual(closed['status'],'ENTRY_CONTAINMENT_UNCONFIRMED')
        self.assertEqual(closed['residuals'],['AUTH_OUTCOME_UNKNOWN'])
        self.assertTrue(closed['privateInputsAbsent'])
        self.assertTrue(read(self.root/'journal.json')['payment']['endpointDisabled'])
        self.assertFalse(any(self.f.runtime_state.values()))

    def test_payment_parent_retains_then_independently_purges(self):
        r=self.run_entry()
        self.assertEqual(r['status'],'ENTRY_AWAITING_INDEPENDENT_CLOSEOUT',r)
        self.assertTrue(r['paymentObserved'],read(self.root/'journal.json'))
        self.assertTrue(self.path.exists())
        self.assertFalse(any(self.f.runtime_state.values()))
        r=self.run_entry('closeout')
        self.assertEqual(r['status'],'ENTRY_CLOSED',r)
        self.assertEqual(r['residuals'],[])
        self.assertTrue(r['privateInputsAbsent'])
        self.assertFalse(self.path.exists())
        self.assertEqual(read(self.root/'journal.json')['payment']['endpointCalls'],9)
        # Corrected Stripe version adds its own activation/retirement readbacks; existing192 cap is unchanged.
        self.assertLessEqual(read(self.root/'journal.json')['nativeEntry']['calls']['cli'],self.e['limits']['cli'])
        self.assertEqual(read(self.root/'journal.json')['nativeEntry']['calls'],{'child':5,'cli':191,'https':16,'sql':10})

    def test_full_parent_failed_readbacks_have_finite_cleanup_budget(self):
        self.scenario='disable_readback_failed'
        r=self.run_entry()
        self.assertEqual(r['status'],'ENTRY_AWAITING_INDEPENDENT_CLOSEOUT')
        r=self.run_entry('closeout')
        self.assertEqual(r['status'],'ENTRY_CONTAINMENT_UNCONFIRMED')
        self.assertIn('PAYMENT_ENDPOINT_UNCONFIRMED',r['residuals'])
        self.assertEqual(read(self.root/'journal.json')['payment']['endpointCalls'],14)
        self.assertLessEqual(read(self.root/'journal.json')['nativeEntry']['calls']['cli'],self.e['limits']['cli'])
        self.assertEqual(read(self.root/'journal.json')['nativeEntry']['calls'],{'child':6,'cli':191,'https':16,'sql':10})
        self.assertTrue(r['privateInputsAbsent'])
        self.assertFalse(any(self.f.runtime_state.values()))

    def test_payment_requires_matching_current_qualification_receipt(self):
        import shutil
        root=Path('/private/tmp/p08-current-external-'+self.e['payment']['qualificationId'])
        root.mkdir(mode=0o700);self.addCleanup(lambda:shutil.rmtree(root))
        scope={'sourceCommit':self.e['sourceCommit'],
            'manifestSha256':a.digest((a.APP/'p08-https-output-category-local-20261029/source/source-manifest.json').read_bytes()),
            'nativeScopeSha256':self.e['qualification']['scopeSha256']}
        reserve(root/'cleanup-envelope.json',{'scope':scope})
        reserve(root/'attempt.json',{'operationId':self.e['payment']['qualificationId'],
            'scopeSha256':self.e['qualification']['scopeSha256'],'cleanupScopeSha256':a.digest(scope)})
        result={'status':'CURRENT_EVIDENCE_OBSERVED','execution':'EXTERNAL_READ_ONLY','liveObserved':True,
                'failure':None,'residuals':[],'candidate':copy.deepcopy(self.e['qualification'])}
        reserve(root/'result.json',result);a.verify_payment_qualification(self.e)
        for field,value in [('liveObserved',False),('status','CURRENT_EVIDENCE_LOCAL_VERIFIED'),('residuals',['UNKNOWN']),('candidate',None)]:
            (root/'result.json').unlink();reserve(root/'result.json',{**result,field:value})
            with self.assertRaisesRegex(Stop,'PAYMENT_QUALIFICATION_RECEIPT'):a.verify_payment_qualification(self.e)

    def test_payment_external_foreign_endpoint_refuses_before_io(self):
        self.e['execution']='EXTERNAL';self.seal()
        with self.assertRaisesRegex(Stop,'PAYMENT_ENDPOINT_PIN'):
            self.run_entry()
        self.assertEqual(self.calls,0)

for _name in EntryTests.__dict__:
    if _name.startswith('test_'):
        setattr(ConnectedEntryTests,_name,None)

if __name__=='__main__':unittest.main()
