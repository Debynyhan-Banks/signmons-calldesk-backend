"""Assembled-entry proofs: injected providers and actual Python/Node child boundary."""
import copy
import ast
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
    def setUp(self, timing=None):
        # Reused packet-construction fixtures retain their original short windows.
        # Executed native cases explicitly opt into the CT4 work reservation.
        self.timing_window=True if timing is None else timing
        self.f=ta.AdapterTests()
        with patch.object(ta,'restore',LEGACY_FIXTURE_RESTORE):self.f.setUp()
        f=self.f
        self.addCleanup(f.tearDown)
        # Adapt only the inherited synthetic provider after its legacy constructor.
        lifecycle_patch=patch.object(ta,'restore',entry.restore);lifecycle_patch.start();self.addCleanup(lifecycle_patch.stop)
        f.runtime_state={x:False for x in entry.restore.operations({**f.p,'iam':[]})}
        now=int(time.time());f.now=now
        iso=lambda x:datetime.datetime.fromtimestamp(now+x,datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')
        original_make_key=f.transport.make_key
        # Current owned-version validation requires provider creation metadata.
        # Adapt the instance seam without changing the source-locked legacy fixture.
        f.transport.make_key=lambda:{**original_make_key(),'createTime':iso(0)}
        f.p['window']={'start':iso(-10),'cutoff':iso(1800 if self.timing_window else 120),'workEnd':iso(2000 if self.timing_window else 180),'cleanupEnd':iso(2720 if self.timing_window else 900),'purgeEnd':iso(2770 if self.timing_window else 950)}
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
            'scopeSha256':a.digest(scope),'qualifiedUntil':iso(2720 if self.timing_window else 900),**f.q,
            'checks':{k:True for k in ('owner','billing','effectiveAccess','services','database','firebase','job','retiredRuntime','privateInventory')}}
        # Exercise the full interval with a synthetic monotonic clock, never sleep seven real minutes.
        original_init=entry.Coordinator.__init__
        self.settle_sleeps=[]
        def timed_init(controller,*args,**kwargs):
            original_init(controller,*args,**kwargs)
            elapsed=[0.0]
            controller.monotonic=lambda:elapsed[0]
            controller.last_monotonic=0.0
            controller.work_monotonic_end=max(0,controller.forward_end-controller.clock())
            controller.child_monotonic_end=max(0,controller.times['cutoff']-controller.clock())
            def pause(seconds):
                self.settle_sleeps.append(seconds);elapsed[0]+=seconds
            controller.pause=pause
        timing=patch.object(entry.Coordinator,'__init__',timed_init)
        timing.start();self.addCleanup(timing.stop)
        self.acl=entry.load_acl();self.role_reads=0;self.role_mutator=None
        rows=self.acl.expected_retired_acl()
        for row in rows:
            if row['kind']=='database':row['object']=self.e['database']['database']
        f.q['roleAclSha256']=self.acl.classify_role_acl(rows,self.e['database']['database'],self.acl.expected_retired_acl())[0]['roleAclSha256']
        self.e['qualification']['roleAclSha256']=f.q['roleAclSha256']
        self.scenario='normal';self.calls=0;self.io=None;self.capture_recovery=False;self.snapshot=None
        self.seal()

    def seal(self):
        self.e['decision']={'decision':('APPROVE_LOCAL_AUTH_QUALIFICATION_PROOF' if self.e.get('purpose')=='NATIVE_AUTH_QUALIFICATION_ONLY' else 'APPROVE_LOCAL_NATIVE_ENTRY_PROOF'),
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
                    t=EntryTests();t.setUp(timing=True)
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

    def test_exact_dynamic_iam_mutations_request_json_at_native_cli_boundary(self):
        cap, io = self.native_fixture()
        io.token = 'SYNTHETIC_TOKEN'
        ports = entry.Ports(cap, io, None, None)
        for kind in ('lookup', 'signing'):
            for enabled in (True, False):
                vector = ports.restore.command(ports.restore_plan, 'iam', kind, enabled)
                with patch.object(io, '_run', return_value='{"bindings": []}') as run:
                    self.assertEqual(ports.cloud(vector), {'bindings': []})
                    self.assertEqual(run.call_args.args,
                                     (['/opt/homebrew/bin/gcloud', *vector, '--format=json'], 'cli'))
                for raw in ('bindings: []', '{broken', ''):
                    with patch.object(io, '_run', return_value=raw):
                        with self.assertRaises(Exception):
                            ports.cloud(vector)
                foreign = [*vector, '--foreign-flag']
                with patch.object(io, '_run', return_value='{}') as run:
                    ports.cloud(foreign)
                    self.assertEqual(run.call_args.args[0], ['/opt/homebrew/bin/gcloud', *foreign])

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
            t=EntryTests();t.setUp(timing=True)
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
        self.assertEqual(sum(self.settle_sleeps),420)
        self.assertTrue(all(0 < n <= 1 for n in self.settle_sleeps))

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
                t=EntryTests();t.setUp(timing=True)
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
                    if (raw==b'' and kind in ('identity','version')) or (raw==b'[]' and kind=='identity'):self.assertEqual(io.cloud(vector,0),{})
                    else:
                        with self.assertRaisesRegex(Stop,'NATIVE_OUTPUT_SHAPE'):io.cloud(vector,0)
        vector=['run','services','describe','signmons-calldesk-staging','--project=signmons','--region=us-east5','--format=json(status.traffic)']
        with patch('native_io.subprocess.run',return_value=subprocess.CompletedProcess([],0,b'{}',b'')) as run:
            self.assertEqual(io.cloud(vector,0),{});self.assertEqual(run.call_args.args[0],['/opt/homebrew/bin/gcloud',*vector])

    def test_identity_empty_list_ack_is_exact_and_not_state_proof(self):
        cap,io=self.native_fixture();io.token='SYNTHETIC_TOKEN';r=io.restore;plan={**cap.plan,'iam':[]}
        for enabled in (True,False):
            vector=r.command(plan,'identity',r.IDENTITY,enabled)
            # Reproduce the installed SDK hook/printer result without invoking gcloud.
            sdk='/opt/homebrew/Caskroom/gcloud-cli/583.0.0/google-cloud-sdk/lib'
            code="import sys,io;sys.path[:0]=[sys.argv[1],sys.argv[1]+'/third_party'];from googlecloudsdk.command_lib.iam import hooks;from googlecloudsdk.core.resource import resource_printer;from types import SimpleNamespace;from unittest.mock import patch;hook=getattr(hooks,sys.argv[2]);args=SimpleNamespace(command_path=[],service_account='synthetic');v=hook(object(),args);out=io.StringIO();resource_printer.Print(v,'json',out=out);print(out.getvalue(),end='')"
            output=subprocess.check_output([sys.executable,'-c',code,sdk,'EnableIamAccountConfirmation' if enabled else 'DisableIamAccountConfirmation'])
            self.assertEqual(output,b'[]\n')
            with patch('native_io.subprocess.run',return_value=subprocess.CompletedProcess([],0,output,b'')):
                self.assertEqual(io.cloud(vector,0),{})
            for raw in (b'[{}]',b'null',b'false',b'0',b'""',b'garbage'):
                with patch('native_io.subprocess.run',return_value=subprocess.CompletedProcess([],0,raw,b'')):
                    with self.assertRaisesRegex(Stop,'NATIVE_OUTPUT_SHAPE'):io.cloud(vector,0)
            with patch('native_io.subprocess.run',return_value=subprocess.CompletedProcess([],1,b'[]',b'')):
                with self.assertRaisesRegex(Stop,'NATIVE_COMMAND_REFUSED'):io.cloud(vector,0)
            with patch('native_io.subprocess.run',side_effect=subprocess.TimeoutExpired('synthetic',1)):
                with self.assertRaisesRegex(Stop,'NATIVE_COMMAND_UNCONFIRMED'):io.cloud(vector,0)
            # A foreign vector must never acquire the identity acknowledgement exception.
            foreign=[v.replace(r.IDENTITY,'foreign@example.invalid') for v in vector]
            with patch.object(io,'cli',return_value='[]'):
                self.assertEqual(io.cloud(foreign,0),[])
            # Read output remains a list, not a synthesized successful object.
            read=['iam','service-accounts','describe',r.IDENTITY,'--project=signmons','--format=json(email,disabled)']
            with patch.object(io,'cli',return_value='[]'):
                self.assertEqual(io.cloud(read,0),[])
            adapter=SimpleNamespace(cloud=lambda *args:{'email':r.IDENTITY,'disabled':enabled})
            self.assertFalse(r.NativeAdapter.readback(adapter,'identity',r.IDENTITY,enabled,plan,0))

    def test_tag_sdk_lists_are_acknowledgements_only_for_exact_mutations(self):
        cap,io=self.native_fixture();io.token='SYNTHETIC_TOKEN';r=io.restore;plan={**cap.plan,'iam':[]}
        sdk='/opt/homebrew/Caskroom/gcloud-cli/583.0.0/google-cloud-sdk/lib'
        code="""import sys,io,json
from types import SimpleNamespace
sys.path[:0]=[sys.argv[1],sys.argv[1]+'/third_party']
from googlecloudsdk.api_lib.run import traffic_pair
from googlecloudsdk.core.resource import resource_printer
normal=SimpleNamespace(percent=100,tag=None,url='',revisionName='synthetic-normal',latestRevision=False)
tag=SimpleNamespace(percent=None,tag='synthetic-tag',url='https://synthetic.invalid',revisionName='synthetic-candidate',latestRevision=False)
pair=lambda targets,name:traffic_pair.TrafficTargetPair(targets,targets,name,False,None)
outputs=[]
for rows in ([pair([normal],'synthetic-normal')],[pair([normal],'synthetic-normal'),pair([tag],'synthetic-candidate')],[pair([],'synthetic-pending')]):
 out=io.StringIO();resource_printer.Print(rows,'json',out=out);outputs.append(json.loads(out.getvalue()))
print(json.dumps(outputs))
"""
        outputs=json.loads(subprocess.check_output([sys.executable,'-c',code,sdk]))
        for enabled in (True,False):
            vector=r.command(plan,'tag',r.TAG,enabled)
            for value in outputs:
                raw=json.dumps(value).encode()
                with patch('native_io.subprocess.run',return_value=subprocess.CompletedProcess([],0,raw,b'')):
                    self.assertEqual(io.cloud(vector,0),{})
            bad=[[],[{}],[None],None,False,1,'unknown']
            for key,val in [('revisionName',None),('latestRevision',1),('statusPercent','101'),('specPercent',0),('tags',[{}]),('urls',[1])]:
                rows=copy.deepcopy(outputs[0]);rows[0][key]=val;bad.append(rows)
            for value in bad:
                with patch('native_io.subprocess.run',return_value=subprocess.CompletedProcess([],0,json.dumps(value).encode(),b'')):
                    with self.assertRaisesRegex(Stop,'RUNTIME_TAG_ACK_SHAPE' if enabled else 'NATIVE_OUTPUT_SHAPE'):io.cloud(vector,0)
            with patch('native_io.subprocess.run',return_value=subprocess.CompletedProcess([],0,b'bad-json',b'')):
                with self.assertRaisesRegex(Stop,'RUNTIME_TAG_JSON_PARSE' if enabled else 'NATIVE_OUTPUT_SHAPE'):io.cloud(vector,0)
            with patch('native_io.subprocess.run',return_value=subprocess.CompletedProcess([],1,json.dumps(outputs[0]).encode(),b'')):
                with self.assertRaisesRegex(Stop,'RUNTIME_TAG_COMMAND_REFUSED' if enabled else 'NATIVE_COMMAND_REFUSED'):io.cloud(vector,0)
            with patch('native_io.subprocess.run',side_effect=subprocess.TimeoutExpired('synthetic',1)):
                with self.assertRaisesRegex(Stop,'RUNTIME_TAG_COMMAND_TIMEOUT' if enabled else 'NATIVE_COMMAND_UNCONFIRMED'):io.cloud(vector,0)
        # Other mutation families cannot use the tag response exception.
        for kind,name in [('identity',r.IDENTITY),('version',r.SECRETS[0]),('secretBinding',r.POLICIES[0])]:
            with patch.object(io,'cli',return_value=json.dumps(outputs[0])):
                with self.assertRaisesRegex(Stop,'NATIVE_OUTPUT_SHAPE'):io.cloud(r.command(plan,kind,name,True),0)
        with patch.object(io,'cli',return_value=json.dumps(outputs[0])):
            self.assertEqual(io.cloud(['run','services','describe','synthetic'],0),outputs[0])
        # Authoritative state, never the acknowledgement, controls restoration.
        adapter=SimpleNamespace(cloud=lambda *args:{'status':{'traffic':[{'revisionName':r.NORMAL,'percent':100}]}})
        self.assertFalse(r.NativeAdapter.traffic(adapter,plan,0,True))
        adapter.cloud=lambda *args:{}
        with self.assertRaises(Exception):r.NativeAdapter.traffic(adapter,plan,0,False)
        adapter.cloud=lambda *args:{'status':{'traffic':[{'revisionName':r.NORMAL,'percent':99}]}}
        with self.assertRaises(Exception):r.NativeAdapter.traffic(adapter,plan,0,False)

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
    def setUp(self, timing=None):
        super().setUp(timing=(self._testMethodName != 'runTest') if timing is None else timing)
        import uuid
        p=self.e['plan']; stamp='2026-01-01T00:00:00.000Z'
        draft={'currency':'usd','serviceFeeRequired':False,'serviceFeeCents':None,'depositRequired':True,
               'depositPolicy':{'kind':'fixed','amountCents':12500},'emergencyFeePolicy':{'kind':'none'},
               'paymentGateMode':'fail_closed','webhookValidationRequired':True}
        approved={'draft':draft,'actorId':self.e['target']['id'],'approvedAt':stamp}
        self.e['version']=2
        self.e['limits']['cli']=196
        # Share the parent fixture's captured clock so setup cannot shorten the payment reserve.
        self.e['payment']={'qualificationId':str(uuid.uuid4()),'endpointId':'we_synthetic','endpointSha256':a.digest(b'we_synthetic'),
            'apiVersion':'2026-03-25.dahlia','url':'https://app013-p07-atomic---signmons-calldesk-staging-p572d6wipq-ul.a.run.app/webhooks/stripe',
            'connectedAccountSha256':a.digest(b'acct_synthetic'),'amountTotalCents':12500,'currency':'usd',
            'approvedAt':stamp,'policyDigest':a.digest(json.dumps(approved,separators=(',',':')).encode()),
            'jobUpdatedAt':stamp,'requestId':str(uuid.uuid4()),
            'workEnd':datetime.datetime.fromtimestamp(self.f.now+(1940 if self.timing_window else 90),datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')}
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
        self.assertEqual(read(self.root/'journal.json')['payment']['endpointCalls'],8)
        # Immediate identity matches retain191 calls; BR2's196 cap reserves four extra reads.
        self.assertLessEqual(read(self.root/'journal.json')['nativeEntry']['calls']['cli'],self.e['limits']['cli'])
        self.assertEqual(read(self.root/'journal.json')['nativeEntry']['calls'],{'child':5,'cli':191,'https':16,'sql':10})

    def test_failed_tag_before_auth_has_independent_final_receipt(self):
        def factory(cap):
            io=self.factory(cap);cloud=io.cloud
            def fail_tag(vector,deadline):
                value=cloud(vector,deadline)
                if vector[:3]==['run','services','update-traffic']:
                    raise Stop('NATIVE_OUTPUT_SHAPE')
                return value
            io.cloud=fail_tag;return io
        work=entry.run_entry(self.path,io_factory=factory)
        self.assertEqual(work['status'],'ENTRY_AWAITING_INDEPENDENT_CLOSEOUT')
        self.assertFalse(read(self.root/'journal.json')['authAttempted'])
        closed=entry.run_entry(self.path,'closeout',io_factory=factory)
        self.assertEqual(closed['status'],'ENTRY_CONTAINMENT_UNCONFIRMED')
        self.assertTrue(closed['privateInputsAbsent'])
        self.assertTrue((self.root/'result.json').exists())
        self.assertTrue(any('tag' in x.lower() for x in closed['residuals']))

    def test_full_parent_failed_readbacks_have_finite_cleanup_budget(self):
        self.scenario='disable_readback_failed'
        r=self.run_entry()
        self.assertEqual(r['status'],'ENTRY_AWAITING_INDEPENDENT_CLOSEOUT')
        r=self.run_entry('closeout')
        self.assertEqual(r['status'],'ENTRY_CONTAINMENT_UNCONFIRMED')
        self.assertIn('PAYMENT_ENDPOINT_UNCONFIRMED',r['residuals'])
        # Independent refusal uses the failed main proof without retrieving the retired secret.
        self.assertEqual(read(self.root/'journal.json')['payment']['endpointCalls'],10)
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

class IndependentPaymentProofTests(ConnectedEntryTests):

    def factory(self, cap):
        io = ConnectedEntryTests.factory(self, cap)
        child = io.child
        def invoke(argv, **kwargs):
            retire = cap.mode != 'run' or (getattr(self, 'fail_main_readback', False) and argv[2] == '--readback')
            if not retire:
                return child(argv, **kwargs)
            script = """import {readFileSync} from 'node:fs';
import {runChild} from %s;
import {portsFor,rawFor} from %s;
const request=JSON.parse(readFileSync(0,'utf8')),e=JSON.parse(readFileSync(request.envelopePath));
const ports=portsFor({r:request,e,raw:rawFor(e)}),fetcher=ports.fetcher;let secretReads=0;
ports.fetcher=async(url,opts)=>{if(url.startsWith('https://secretmanager.googleapis.com/')){
 secretReads++;return new Response('SYNTHETIC_RETIRED_SECRET',{status:403});}return fetcher(url,opts);};
try{const result=await runChild(process.argv[1],request,ports);
 if(%s && secretReads!==0)throw Error('UNEXPECTED_RETIRED_SECRET_READ');
 process.stdout.write(JSON.stringify(result)+'\\n');
}catch(error){process.stderr.write(String(error.code??error.message)+'\\n');process.exitCode=2;}
""" % (json.dumps((a.HERE/'native_child.mjs').as_uri()),
       json.dumps((a.HERE/'fixture_connected.mjs').as_uri()), 'true' if cap.mode != 'run' else 'false')
            return subprocess.run([argv[0], '--input-type=module', '-e', script, '--', argv[2]], **kwargs)
        io.child = invoke
        return io

    def test_fresh_independent_child_reads_account_after_secret_retirement(self):
        self.assertEqual(self.run_entry()['residuals'], [])
        before = read(self.root/'journal.json')['payment']
        result = self.run_entry('closeout')
        self.assertEqual(result['status'], 'ENTRY_CLOSED', result)
        self.assertTrue(result['privateInputsAbsent'])
        self.assertEqual(read(self.root/'journal.json')['payment'], before)

    def test_failed_main_endpoint_readback_is_preserved_in_work_and_final_results(self):
        self.fail_main_readback = True
        result = self.run_entry()
        self.assertIn('PAYMENT_ENDPOINT_UNCONFIRMED', result['residuals'])
        self.assertEqual(read(self.root/'work-result.json'), result)
        closed = self.run_entry('closeout')
        self.assertIn('PAYMENT_ENDPOINT_UNCONFIRMED', closed['residuals'])
        self.assertFalse(closed['authProofReady'])
        self.assertTrue(closed['privateInputsAbsent'])

    def test_missing_main_receipt_refuses_payment_proof_and_still_closes_accounts(self):
        self.run_entry();(self.root/'work-result.json').unlink()
        result = self.run_entry('closeout')
        self.assertIn('PAYMENT_ENDPOINT_UNCONFIRMED', result['residuals'])
        self.assertIn('ACCOUNT_SESSION', result['residuals'])
        self.assertEqual(read(self.root/'child-5.json')['mode'], '--readback')
        self.assertTrue(result['privateInputsAbsent'])

    def test_pending_payment_publish_cannot_hide_payment_failure_when_recording_fails(self):
        self.run_entry()
        reserve(self.root/'journal.json.payment-next', read(self.root/'journal.json'))
        result = self.run_entry('closeout')
        self.assertIn('PAYMENT_ENDPOINT_UNCONFIRMED', result['residuals'])
        self.assertIn('ACCOUNT_SESSION', result['residuals'])
        self.assertIn('PRIVATE_INVENTORY_UNCONFIRMED', result['residuals'])
        self.assertFalse(result['privateInputsAbsent'])

    def test_malformed_payment_shape_preserves_uncertainty_and_purge(self):
        self.run_entry();journal=read(self.root/'journal.json')
        journal['payment']['unexpected']='SYNTHETIC_UNTRUSTED_FIELD'
        (self.root/'journal.json').write_text(json.dumps(journal))
        result=self.run_entry('closeout')
        self.assertIn('PAYMENT_ENDPOINT_UNCONFIRMED',result['residuals'])
        self.assertFalse(result['authProofReady']);self.assertTrue(result['privateInputsAbsent'])


for _name in dir(ConnectedEntryTests):
    if _name.startswith('test_') and _name not in IndependentPaymentProofTests.__dict__:
        setattr(IndependentPaymentProofTests, _name, None)


class AuthenticationDiagnosticTests(unittest.TestCase):
    CODES = ('AUTH_KEY_SCOPE', 'AUTH_KEY_OWNERSHIP_DRIFT', 'KEY_STRING_SHAPE')
    PRIVATE_TEXT = 'synthetic-private-auth-diagnostic-canary'

    def diagnostic_ports(self):
        ports=object.__new__(entry.Ports)
        ports.owned_uid='synthetic-owned-uid';ports.owned_etag='synthetic-owned-etag'
        ports._load_lifecycle=lambda:{'phase':'CREATED','deleteIntent':False,'deleteOperation':None,
                                     'uid':ports.owned_uid,'etag':ports.owned_etag}
        return ports

    def rejected_errors(self):
        class DerivedStop(entry.bridge.packet.Stop): pass
        class DerivedString(str): pass
        return [
            Stop('AUTH_KEY_SCOPE'),
            DerivedStop('AUTH_KEY_SCOPE'),
            entry.bridge.packet.Stop('AUTH_KEY_SCOPE', self.PRIVATE_TEXT),
            entry.bridge.packet.Stop(17),
            entry.bridge.packet.Stop(DerivedString('AUTH_KEY_SCOPE')),
            entry.bridge.packet.Stop(),
            entry.bridge.packet.Stop(self.PRIVATE_TEXT),
            entry.bridge.packet.Stop('AUTH_KEY_SCOPE: ' + self.PRIVATE_TEXT),
            RuntimeError(self.PRIVATE_TEXT),
        ]

    def test_authenticate_preserves_success_and_only_translates_exact_safe_codes(self):
        ports = self.diagnostic_ports()
        result = object()
        with patch.object(entry.bridge.Ports, 'authenticate', return_value=result) as base:
            self.assertIs(ports.authenticate('synthetic-resource'), result)
            base.assert_called_once_with('synthetic-resource')
        for code in self.CODES:
            with self.subTest(code=code):
                with patch.object(entry.bridge.Ports, 'authenticate', side_effect=entry.bridge.packet.Stop(code)):
                    with self.assertRaises(entry.c.Stop) as raised:
                        ports.authenticate('synthetic-resource')
                self.assertIs(type(raised.exception), entry.c.Stop)
                self.assertEqual(raised.exception.args, (code,))
                self.assertIsNone(raised.exception.__cause__)
                self.assertTrue(raised.exception.__suppress_context__)

    def test_authenticate_preserves_unknown_exception_identity(self):
        ports = self.diagnostic_ports()
        for error in self.rejected_errors():
            with self.subTest(kind=type(error).__name__, argc=len(error.args)):
                with patch.object(entry.bridge.Ports, 'authenticate', side_effect=error):
                    with self.assertRaises(type(error)) as raised:
                        ports.authenticate('synthetic-resource')
                self.assertIs(raised.exception, error)

    def test_safe_scope_and_rejected_errors_through_actual_entry_and_closeout(self):
        cases = [(entry.bridge.packet.Stop('AUTH_KEY_SCOPE'), 'AUTH_KEY_SCOPE')]
        cases.extend((error, 'LOCAL_ADAPTER_OR_SOURCE_STOP') for error in self.rejected_errors())
        for error, expected in cases:
            with self.subTest(kind=type(error).__name__, argc=len(error.args), expected=expected):
                fixture = ConnectedEntryTests()
                try:
                    fixture.setUp(timing=True)
                    with patch.object(entry.bridge.Ports, 'authenticate', side_effect=error):
                        work = fixture.run_entry()
                        result = fixture.run_entry('closeout')
                    journal = read(fixture.root / 'journal.json')
                    self.assertEqual(work['status'], 'ENTRY_AWAITING_INDEPENDENT_CLOSEOUT')
                    self.assertEqual(journal['failure'], expected)
                    self.assertTrue(journal['authAttempted'])
                    self.assertFalse(journal['authProofAccepted'])
                    self.assertNotIn('authClient', journal)
                    self.assertEqual(journal['nativeEntry']['calls']['child'], 1)
                    self.assertTrue(result['privateInputsAbsent'])
                    self.assertNotIn(self.PRIVATE_TEXT, json.dumps([journal, work, result]))
                finally:
                    fixture.doCleanups()

    def test_distinct_owned_versions_reach_real_handoff_and_conditional_cleanup(self):
        fixture=ConnectedEntryTests()
        try:
            fixture.setUp(timing=True);fake=fixture.f.transport;original=fake.https;trace=[];reads=0
            def https(desc):
                nonlocal reads
                method,url=desc['method'],desc['url'];trace.append((method,url))
                if method=='GET' and '/keys/' in url and not url.endswith('/keyString') and fake.key and not fake.key.get('deleteTime'):
                    reads+=1;fake.key['etag']='etag/native-'+str(reads+1)
                if method=='DELETE':
                    self.assertTrue(url.endswith('?etag=etag%2Fnative-4'))
                return original(desc)
            fake.https=https
            work=fixture.run_entry()
            self.assertEqual(work['status'],'ENTRY_AWAITING_INDEPENDENT_CLOSEOUT')
            self.assertEqual(read(fixture.root/'owned-receipt.json')['etag'],'etag/native-3')
            lifecycle=read(fixture.root/'key-lifecycle-private.json')
            self.assertEqual(lifecycle['phase'],'DELETED');self.assertEqual(lifecycle['etag'],'etag/native-4')
            result=fixture.run_entry('closeout');journal=read(fixture.root/'journal.json')
            self.assertEqual(result['status'],'ENTRY_CLOSED',result)
            self.assertEqual(result['residuals'],[])
            self.assertTrue(journal['authProofAccepted']);self.assertIsNone(journal['failure'])
            self.assertEqual(journal['nativeEntry']['calls'],{'child':5,'cli':191,'https':16,'sql':10})
            self.assertEqual(sum(method=='DELETE' for method,_ in trace),1)
            self.assertEqual(sum(url.endswith('/keyString') for _,url in trace),1)
            self.assertTrue(result['privateInputsAbsent'])
        finally:fixture.doCleanups()

    def test_keystring_failure_remains_classified_and_changed_cleanup_version_is_contained(self):
        fixture=ConnectedEntryTests()
        try:
            fixture.setUp(timing=True);fake=fixture.f.transport;original=fake.https;trace=[]
            def https(desc):
                method,url=desc['method'],desc['url'];trace.append((method,url))
                if url.endswith('/keyString'):
                    fake.key['etag']='etag/cleanup-after-refusal'
                    return {'httpStatus':200,'body':'{}'}
                if method=='DELETE':self.assertTrue(url.endswith('?etag=etag%2Fcleanup-after-refusal'))
                return original(desc)
            fake.https=https
            fixture.run_entry();result=fixture.run_entry('closeout');journal=read(fixture.root/'journal.json')
            self.assertEqual(journal['failure'],'KEY_STRING_SHAPE')
            self.assertFalse(journal['authProofAccepted']);self.assertNotIn('authClient',journal)
            self.assertEqual(journal['nativeEntry']['calls']['child'],1)
            self.assertEqual(result['residuals'],['ACCOUNT_SESSION','AUTH_OUTCOME_UNKNOWN','AUTH_REVOKE',
                                                  'PAYMENT_ENDPOINT_UNCONFIRMED'])
            self.assertEqual(sum(method=='DELETE' for method,_ in trace),1)
            self.assertTrue(fake.key.get('deleteTime'));self.assertTrue(result['privateInputsAbsent'])
        finally:fixture.doCleanups()


class IdentityReadbackDiagnosticTests(unittest.TestCase):
    PRIVATE_TEXT = 'synthetic-private-identity-readback-canary'
    VECTOR = ['iam', 'service-accounts', 'describe', entry.restore.IDENTITY,
              '--project=signmons', '--format=json(email,disabled)']

    def fixture(self, connected=False):
        fixture = ConnectedEntryTests() if connected else EntryTests()
        fixture.setUp(timing=True)
        self.addCleanup(fixture.doCleanups)
        return fixture

    def test_same_native_read_preserves_legacy_predicate_and_classifies_rejections(self):
        fixture = self.fixture()
        cap, io = fixture.native_fixture(); io.token = 'SYNTHETIC_TOKEN'
        adapter = entry.RuntimeAdapter(cap, io)
        identity = entry.restore.IDENTITY
        cases = [(None, 'OUTPUT_SHAPE'), ([], 'OUTPUT_SHAPE'), (False, 'OUTPUT_SHAPE'),
                 ({}, 'EMAIL_MISSING'), ({'email': self.PRIVATE_TEXT}, 'EMAIL_MISMATCH')]
        cases += [({'email': identity, 'disabled': value},
                   'STATE_MISMATCH' if type(value) in (bool, int, float) and value in (0, 1)
                   else 'DISABLED_INVALID')
                  for value in (True, False, 0, 1, 0.0, 1.0, None, 'false', [], {}, 2, -1, 0.5)]
        cases.append(({'email': identity}, 'DISABLED_MISSING'))
        for enabled in (True, False):
            for value, code in cases:
                with self.subTest(enabled=enabled, value=value):
                    # The immutable original supplies the compatibility oracle.
                    legacy = SimpleNamespace(cloud=lambda *args: value)
                    try:
                        accepted = entry.restore.NativeAdapter.readback(
                            legacy, 'identity', identity, enabled, cap.plan, 0) is True
                    except (AttributeError, TypeError):
                        accepted = False
                    response = subprocess.CompletedProcess([], 0, json.dumps(value).encode(), b'')
                    with patch('native_io.subprocess.run', return_value=response) as run:
                        if accepted:
                            self.assertIs(adapter.readback('identity', identity, enabled, cap.plan, 0), True)
                        else:
                            with self.assertRaises(entry.c.Stop) as error:
                                adapter.readback('identity', identity, enabled, cap.plan, 0)
                            self.assertEqual(error.exception.args, ('RUNTIME_IDENTITY_' + code,))
                            self.assertNotIn(self.PRIVATE_TEXT, str(error.exception))
                        self.assertEqual(run.call_count, 1)
                        self.assertEqual(run.call_args.args[0], ['/opt/homebrew/bin/gcloud', *self.VECTOR])

    def test_installed_sdk_projection_passes_through_actual_native_parser(self):
        sdk = '/opt/homebrew/Caskroom/gcloud-cli/583.0.0/google-cloud-sdk/lib'
        code = """import sys,io,json
sys.path[:0]=[sys.argv[1],sys.argv[1]+'/third_party']
from googlecloudsdk.generated_clients.apis.iam.v1 import iam_v1_messages as iam
from googlecloudsdk.core.resource import resource_printer
rows=[]
for fields in ({'disabled':True},{'disabled':False},{}):
 out=io.StringIO()
 resource_printer.Print(iam.ServiceAccount(email=sys.argv[2],**fields),'json(email,disabled)',out=out)
 rows.append(out.getvalue())
print(json.dumps(rows))
"""
        serialized = json.loads(subprocess.check_output(
            [sys.executable, '-B', '-c', code, sdk, entry.restore.IDENTITY]))
        fixture = self.fixture(); cap, io = fixture.native_fixture(); io.token = 'SYNTHETIC_TOKEN'
        adapter = entry.RuntimeAdapter(cap, io)
        for raw, enabled in zip(serialized, (False, True, True)):
            with patch('native_io.subprocess.run', return_value=subprocess.CompletedProcess([], 0, raw.encode(), b'')) as run:
                self.assertIs(adapter.readback('identity', entry.restore.IDENTITY, enabled, cap.plan, 0), True)
                self.assertEqual(run.call_count, 1)
                self.assertEqual(run.call_args.args[0], ['/opt/homebrew/bin/gcloud', *self.VECTOR])

    def test_malformed_json_is_safe_and_other_native_failures_are_not_reclassified(self):
        fixture = self.fixture(); cap, io = fixture.native_fixture(); io.token = 'SYNTHETIC_TOKEN'
        adapter = entry.RuntimeAdapter(cap, io)
        cases = [(subprocess.CompletedProcess([], 0, raw, self.PRIVATE_TEXT.encode()),
                  entry.c.Stop, 'RUNTIME_IDENTITY_OUTPUT_SHAPE') for raw in (b'', b'{', b'null', b'[]')]
        cases += [(subprocess.CompletedProcess([], 1, b'', self.PRIVATE_TEXT.encode()), Stop, 'NATIVE_COMMAND_REFUSED'),
                  (subprocess.CompletedProcess([], 0, b'\xff', b''), Stop, 'NATIVE_OUTPUT_ENCODING'),
                  (subprocess.TimeoutExpired(self.PRIVATE_TEXT, 1), Stop, 'NATIVE_COMMAND_UNCONFIRMED')]
        for response, kind, code in cases:
            with self.subTest(code=code):
                kwargs = {'side_effect': response} if isinstance(response, BaseException) else {'return_value': response}
                with patch('native_io.subprocess.run', **kwargs) as run:
                    with self.assertRaises(kind) as error:
                        adapter.readback('identity', entry.restore.IDENTITY, True, cap.plan, 0)
                    self.assertEqual(error.exception.args, (code,))
                    self.assertNotIn(self.PRIVATE_TEXT, str(error.exception))
                    self.assertEqual(run.call_count, 1)
        class DerivedStop(Stop): pass
        class DerivedString(str): pass
        errors = [DerivedStop('NATIVE_OUTPUT_SHAPE'), Stop(DerivedString('NATIVE_OUTPUT_SHAPE')),
                  Stop('NATIVE_OUTPUT_SHAPE', self.PRIVATE_TEXT), Stop(self.PRIVATE_TEXT),
                  RuntimeError(self.PRIVATE_TEXT), KeyboardInterrupt()]
        for error in errors:
            with patch.object(adapter, 'cloud', side_effect=error) as cloud:
                with self.assertRaises(type(error)) as raised:
                    adapter.readback('identity', entry.restore.IDENTITY, True, cap.plan, 0)
                self.assertIs(raised.exception, error)
                cloud.assert_called_once()

    def stopped_run(self, value, expected, *, baseline=False, preflight=False,
                    cleanup_mismatch=False, interrupt=False):
        fixture = self.fixture(connected=True)
        trace = []; injected = []
        identity_item = ['identity', entry.restore.IDENTITY]
        def factory(cap):
            io = fixture.factory(cap); original = io.cloud
            def cloud(vector, deadline):
                result = original(vector, deadline)
                trace.append((cap.mode, io.cleanup, list(vector)))
                if vector == self.VECTOR:
                    active = fixture.f.runtime_state[tuple(identity_item)]
                    target = not io.cleanup and (not active if preflight else active)
                    if target:
                        injected.append(True)
                        if interrupt:
                            cap.coordinator.abort = True
                            return result
                        if isinstance(value, BaseException): raise value
                        # Exercise the real JSON boundary without a provider or credential.
                        parser = SimpleNamespace(cap=cap, restore=entry.restore,
                                                 cli=lambda argv: json.dumps(value))
                        return entry.NativeIO.cloud(parser, vector, deadline)
                    if cleanup_mismatch and io.cleanup:
                        return {'email': entry.restore.IDENTITY, 'disabled': False}
                return result
            io.cloud = cloud
            return io
        current = entry.RuntimeAdapter.readback
        def old_identity(adapter, kind, name, enabled, plan, deadline):
            if kind == 'identity':
                return entry.restore.NativeAdapter.readback(adapter, kind, name, enabled, plan, deadline)
            return current(adapter, kind, name, enabled, plan, deadline)
        with patch.object(entry.RuntimeAdapter, 'readback', old_identity if baseline else current):
            work = entry.run_entry(fixture.path, io_factory=factory)
            final = entry.run_entry(fixture.path, 'closeout', io_factory=factory)
        journal = read(fixture.root/'journal.json')
        self.assertEqual(journal['failure'], expected)
        self.assertEqual(work['status'], 'ENTRY_AWAITING_INDEPENDENT_CLOSEOUT')
        self.assertFalse(work['paymentObserved']); self.assertFalse(final['authenticationObserved'])
        self.assertFalse(final['paymentObserved']); self.assertFalse(journal['authAttempted'])
        self.assertFalse(journal['keyCreateAttempted']); self.assertEqual(journal['iamAttempted'], [])
        self.assertFalse((journal.get('payment') or {}).get('enableIntent', False))
        self.assertEqual(journal['nativeEntry']['calls']['child'], 0 if preflight else 1)
        bounded_mismatch = (not baseline and not preflight and not interrupt and
                            type(value) is dict and value.get('email') == entry.restore.IDENTITY and
                            value.get('disabled') is True)
        self.assertEqual(len(injected), 3 if bounded_mismatch else 1)
        self.assertTrue(final['privateInputsAbsent']); self.assertFalse(fixture.path.exists())
        self.assertFalse((fixture.root/'payment-bootstrap-open-attempt.json').exists())
        self.assertFalse(any(fixture.f.runtime_state.values()))
        if preflight:
            self.assertEqual(journal['preflightStage'], 'RUNTIME_PREFLIGHT')
            self.assertEqual(journal['runtimeAttempted'], [])
        else:
            self.assertEqual(journal['runtimeAttempted'][-1], identity_item)
            self.assertNotIn(identity_item, journal['runtimeOwned'])
            self.assertIn(identity_item, journal['runtimeCleanupAttempted'])
            plan = {**fixture.f.p, 'iam': []}
            for enabled in (True, False):
                mutation = entry.restore.command(plan, 'identity', entry.restore.IDENTITY, enabled)
                self.assertEqual(sum(vector == mutation for _, _, vector in trace), 1)
            self.assertTrue(any(mode == 'closeout' and vector == self.VECTOR for mode, _, vector in trace))
        if cleanup_mismatch:
            self.assertEqual(final['status'], 'ENTRY_CONTAINMENT_UNCONFIRMED')
            self.assertIn('RUNTIME_identity:' + entry.restore.IDENTITY, final['residuals'])
        else:
            self.assertEqual(final['status'], 'ENTRY_CLOSED')
            self.assertEqual(final['residuals'], [])
        for path in fixture.root.iterdir():
            self.assertNotIn(self.PRIVATE_TEXT.encode(), path.read_bytes())
        return journal

    def test_legacy_generic_failure_reproduced_through_assembled_parent(self):
        for value in ({'email': entry.restore.IDENTITY, 'disabled': True},
                      {'email': self.PRIVATE_TEXT, 'disabled': False}):
            self.stopped_run(value, 'RUNTIME_READBACK', baseline=True)

    def test_specific_failures_survive_main_and_independent_closeout(self):
        for value, code in [(None, 'OUTPUT_SHAPE'), ({}, 'EMAIL_MISSING'),
                            ({'email': self.PRIVATE_TEXT}, 'EMAIL_MISMATCH'),
                            ({'email': entry.restore.IDENTITY, 'disabled': None}, 'DISABLED_INVALID'),
                            ({'email': entry.restore.IDENTITY, 'disabled': True}, 'STATE_MISMATCH')]:
            with self.subTest(code=code):
                self.stopped_run(value, 'RUNTIME_IDENTITY_' + code)
        self.stopped_run({'email': entry.restore.IDENTITY}, 'RUNTIME_IDENTITY_DISABLED_MISSING', preflight=True)

    def test_failed_reads_and_private_errors_remain_unconfirmed_without_retries(self):
        for error in (Stop('NATIVE_COMMAND_REFUSED'), Stop('NATIVE_COMMAND_UNCONFIRMED'),
                      Stop('NATIVE_OUTPUT_ENCODING'), RuntimeError(self.PRIVATE_TEXT)):
            self.stopped_run(error, 'LOCAL_ADAPTER_OR_SOURCE_STOP')

    def test_interruption_and_cleanup_disagreement_preserve_conservative_outcomes(self):
        self.stopped_run(None, 'INTERRUPTED', interrupt=True)
        self.stopped_run({'email': entry.restore.IDENTITY, 'disabled': True},
                         'RUNTIME_IDENTITY_STATE_MISMATCH', cleanup_mismatch=True)

    def test_concurrent_connected_entry_never_reaches_readback(self):
        fixture = self.fixture(connected=True)
        fd = os.open(fixture.root/'entry.lock', os.O_CREAT | os.O_WRONLY, 0o600)
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            with patch.object(entry.RuntimeAdapter, 'readback') as readback:
                with self.assertRaisesRegex(Stop, 'ENTRY_ALREADY_RUNNING'):
                    fixture.run_entry()
                readback.assert_not_called()
            self.assertEqual(fixture.calls, 0)
            self.assertFalse((fixture.root/'attempt.json').exists())
        finally:
            os.close(fd)


class ConnectedIdentityReconciliationTests(unittest.TestCase):
    VECTOR = ['iam', 'service-accounts', 'describe', entry.restore.IDENTITY,
              '--project=signmons', '--format=json(email,disabled)']

    @staticmethod
    def state(disabled):
        return {'email': entry.restore.IDENTITY, 'disabled': disabled}

    def harness(self, sequence=(), cleanup=False, legacy=False):
        f = EntryTests() if legacy else ConnectedEntryTests()
        f.setUp(timing=True); self.addCleanup(f.doCleanups)
        cap = a.Capability(f.e, f.root); io = f.factory(cap)
        pending = list(sequence); trace = []; raw = io.cloud
        def cloud(vector, deadline):
            value = raw(vector, deadline); trace.append(list(vector))
            if vector == self.VECTOR and pending:
                value = pending.pop(0)
                if isinstance(value, BaseException): raise value
                if callable(value): return value()
                return copy.deepcopy(value)
            return value
        io.cloud = cloud
        runtime = entry.RuntimeAdapter(cap, io); runtime.q = cap.e['qualification']
        ports = entry.Ports(cap, io, None, runtime)
        controller = entry.Coordinator(cap, io, runtime, ports)
        wall, mono = [time.time()], [0.0]
        controller.clock = cap.clock = lambda: wall[0]
        controller.last = cap.last = wall[0]
        controller.monotonic = lambda: mono[0]; controller.last_monotonic = 0.0
        controller.work_monotonic_end = controller.forward_end - wall[0]
        controller.child_monotonic_end = controller.times['cutoff'] - wall[0]
        pauses = []
        def pause(seconds):
            pauses.append(seconds); wall[0] += seconds; mono[0] += seconds
        controller.pause = pause
        io.cleanup = cleanup
        io.credentials()  # Synthetic fixture credentials; exercise normal reservations.
        args = ('identity', entry.restore.IDENTITY, not cleanup, controller.runtime_plan())
        return SimpleNamespace(f=f,cap=cap,io=io,runtime=runtime,c=controller,args=args,
                               cleanup=cleanup,trace=trace,wall=wall,mono=mono,pauses=pauses)

    def change(self, h):
        return h.c.invoke('change', *h.args, owner=h.runtime, cleanup=h.cleanup)

    def readback(self, h):
        return h.c.invoke('readback', *h.args, owner=h.runtime, cleanup=h.cleanup)

    def test_first_second_and_third_observations_with_one_mutation_each(self):
        for cleanup in (False, True):
            for failures in (0, 1, 2):
                with self.subTest(cleanup=cleanup, failures=failures):
                    h = self.harness([self.state(not cleanup)] * failures, cleanup)
                    self.change(h); self.assertIs(self.readback(h), True)
                    self.assertEqual(h.trace.count(self.VECTOR), failures + 1)
                    mutation = entry.restore.command(h.args[3], 'identity', entry.restore.IDENTITY, not cleanup)
                    self.assertEqual(h.trace.count(mutation), 1)
                    self.assertAlmostEqual(sum(h.pauses), (0, 5, 15)[failures])
                    records = h.c.j['nativeEntry']['identityReadbacks']
                    self.assertEqual(len(records), failures + 1)
                    self.assertEqual(records[-1]['result'], 'MATCH')
                    self.assertEqual([r['ordinal'] for r in records], list(range(1, failures + 2)))

    def test_exhaustion_does_not_make_fourth_read_or_repeat_mutation(self):
        h = self.harness([self.state(True)] * 4)
        self.change(h)
        with self.assertRaisesRegex(entry.c.Stop, 'RUNTIME_IDENTITY_STATE_MISMATCH'):
            self.readback(h)
        self.assertEqual(h.trace.count(self.VECTOR), 3)
        self.assertEqual(len(h.c.j['nativeEntry']['identityReadbacks']), 3)
        self.assertIsNone(h.c.identity_pending)

    def test_missing_disabled_reconciles_cleanup_but_preserves_enabled_predicate(self):
        missing = {'email': entry.restore.IDENTITY}
        for cleanup, expected in ((True, 2), (False, 1)):
            h = self.harness([missing], cleanup)
            self.change(h); self.assertIs(self.readback(h), True)
            self.assertEqual(h.trace.count(self.VECTOR), expected)
            self.assertEqual(h.c.j['nativeEntry']['identityReadbacks'][0]['decodedState'], 'MISSING')

    def test_foreign_null_numeric_extra_shape_and_transport_fail_without_extra_read(self):
        values = [None, {'email':'synthetic-private-foreign','disabled':True}, self.state(None),
                  self.state(1), self.state(1.0), {**self.state(True),'extra':'private'},
                  Stop('NATIVE_COMMAND_UNCONFIRMED'), Stop('NATIVE_COMMAND_REFUSED'),
                  RuntimeError('synthetic-private-error')]
        for value in values:
            with self.subTest(value=type(value).__name__):
                h = self.harness([value]); self.change(h)
                with self.assertRaises(BaseException): self.readback(h)
                self.assertEqual(h.trace.count(self.VECTOR), 1)
                self.assertNotIn('synthetic-private', json.dumps(h.c.j))
                self.assertNotIn('"extra"', json.dumps(h.c.j))

    def test_direct_legacy_and_final_readbacks_have_no_reconciliation(self):
        for legacy in (False, True):
            h = self.harness([self.state(True)], legacy=legacy)
            if legacy: self.change(h)
            with self.assertRaisesRegex(entry.c.Stop, 'RUNTIME_IDENTITY_STATE_MISMATCH'):
                self.readback(h)
            self.assertEqual(h.trace.count(self.VECTOR), 1)
            self.assertNotIn('identityReadbacks', h.c.j['nativeEntry'])
        h = self.harness([self.state(True)]); self.change(h)
        with self.assertRaisesRegex(entry.c.Stop, 'RUNTIME_IDENTITY_STATE_MISMATCH'):
            h.runtime.readback(*h.args, deadline=h.c.times['workEnd'])
        self.assertEqual(h.trace.count(self.VECTOR), 1)

    def test_failed_acknowledgement_and_intervening_call_do_not_grant_allowance(self):
        h = self.harness([self.state(True)])
        with patch.object(h.runtime, 'change', side_effect=Stop('NATIVE_COMMAND_UNCONFIRMED')):
            with self.assertRaises(Stop): self.change(h)
        with self.assertRaises(entry.c.Stop): self.readback(h)
        self.assertEqual(h.trace.count(self.VECTOR), 1)
        h = self.harness([self.state(True)]); self.change(h)
        h.c.invoke('api_keys_state', owner=h.c.access)
        with self.assertRaises(entry.c.Stop): self.readback(h)
        self.assertEqual(h.trace.count(self.VECTOR), 1)

    def test_pending_marker_is_consumed_and_cannot_reset_after_second_change(self):
        h = self.harness(); self.change(h); self.assertTrue(self.readback(h))
        # The inherited coordinator never repeats a mutation; the allowance also
        # refuses to renew if a caller nevertheless invokes the change method twice.
        self.change(h)
        with patch.object(h.runtime, 'cloud', return_value=self.state(True)) as cloud:
            with self.assertRaises(entry.c.Stop): self.readback(h)
            cloud.assert_called_once()

    def test_interrupt_wall_or_monotonic_rollback_and_stalled_wait_stop_before_next_read(self):
        for mode in ('interrupt','wall','monotonic','stalled'):
            h = self.harness([self.state(True)]); self.change(h)
            original = h.c.pause
            def pause(seconds):
                if mode == 'interrupt': h.c.abort = True; original(seconds)
                elif mode == 'wall': h.wall[0] -= 1; h.mono[0] += seconds
                elif mode == 'monotonic': h.mono[0] -= 1
                else: pass
            h.c.pause = pause
            with self.subTest(mode=mode), self.assertRaises((Stop, entry.c.Stop)):
                self.readback(h)
            self.assertEqual(h.trace.count(self.VECTOR), 1)

    def test_phase_bound_reserves_eight_second_child_before_dispatch(self):
        h = self.harness()
        def slow_response():
            h.wall[0] += 36; h.mono[0] += 36
            return self.state(True)
        h.runtime.runner = lambda vector, deadline: slow_response()
        self.change(h)
        # Reset the synthetic ack clock; only the read should consume36seconds.
        h.c.identity_pending = (False, True, h.mono[0])
        with self.assertRaisesRegex(entry.c.Stop,'IDENTITY_READBACK_DEADLINE'):
            self.readback(h)
        self.assertEqual(len(h.c.j['nativeEntry']['identityReadbacks']), 1)

    def test_global_deadline_and_insufficient_main_budget_refuse_before_enable(self):
        for mode in ('deadline','budget'):
            h = self.harness(); before = len(h.trace)
            if mode == 'budget': h.cap.e['limits']['cli'] = h.c.j['nativeEntry']['calls']['cli'] + 7
            else: h.c.child_monotonic_end = 1424
            with self.subTest(mode=mode), self.assertRaises((Stop, entry.c.Stop)): self.change(h)
            self.assertEqual(len(h.trace), before)

    def test_small_cleanup_budget_preserves_original_disable_and_single_read(self):
        h = self.harness(cleanup=True)
        h.cap.e['limits']['cli'] = h.c.j['nativeEntry']['calls']['cli'] + 2
        self.change(h); self.assertIsNone(h.c.identity_pending)
        self.assertTrue(self.readback(h)); self.assertEqual(h.trace.count(self.VECTOR), 1)

    def test_cleanup_wait_respects_deadline_without_suppressing_disable(self):
        h = self.harness([self.state(False)], cleanup=True)
        self.change(h); h.c.times['cleanupEnd'] = h.wall[0] + 10
        with self.assertRaisesRegex(entry.c.Stop,'IDENTITY_READBACK_DEADLINE'): self.readback(h)
        self.assertEqual(h.trace.count(self.VECTOR), 1)
        self.assertEqual(h.trace.count(entry.restore.command(h.args[3],'identity',entry.restore.IDENTITY,False)),1)

    def test_optional_observation_failure_does_not_add_writes_or_block_readback(self):
        h = self.harness(); self.change(h)
        class BadRecords:
            def setdefault(self,*args): raise OSError('synthetic-private-storage')
        with patch.object(h.c,'identity_record',side_effect=lambda *args: None):
            self.assertTrue(self.readback(h))
        # Actual record failure isolation, independent of authoritative journal failure.
        h.c.j['nativeEntry'] = BadRecords()
        h.c.identity_record(False,1,True,0,'MATCH')
        h = self.harness(); self.change(h)
        with patch.object(h.c,'save',side_effect=OSError('synthetic-private-journal')):
            with self.assertRaises(OSError): self.readback(h)
        self.assertEqual(h.trace.count(self.VECTOR),0)

    def assembled(self, main_failures=0, cleanup_failures=0, cap_limit=196):
        f = ConnectedEntryTests(); f.setUp(timing=True); self.addCleanup(f.doCleanups)
        if cap_limit != f.e['limits']['cli']:
            f.e['limits']['cli'] = cap_limit
            f.e['qualification']['scopeSha256'] = a.digest({k:f.e[k] for k in ('plan','target','database','resources','limits','payment')})
            f.seal()
        counts = {'main':0,'cleanup':0}; mutations = {'enable':0,'disable':0}
        def factory(cap):
            io=f.factory(cap); original=io.cloud
            def cloud(vector, deadline):
                result=original(vector,deadline)
                if vector[:3]==['iam','service-accounts','enable']: mutations['enable']+=1
                if vector[:3]==['iam','service-accounts','disable']: mutations['disable']+=1
                active=f.f.runtime_state[('identity',entry.restore.IDENTITY)]
                phase='cleanup' if io.cleanup else 'main'
                if vector==self.VECTOR and ((not io.cleanup and active) or (io.cleanup and cap.mode=='run')):
                    counts[phase]+=1
                    if counts[phase] <= (cleanup_failures if io.cleanup else main_failures):
                        return self.state(not io.cleanup)
                return result
            io.cloud=cloud;return io
        work=entry.run_entry(f.path,io_factory=factory)
        final=entry.run_entry(f.path,'closeout',io_factory=factory)
        journal=read(f.root/'journal.json')
        self.assertEqual(mutations,{'enable':1,'disable':1})
        self.assertTrue(final['privateInputsAbsent'])
        self.assertFalse(any(f.f.runtime_state.values()))
        self.assertLessEqual(journal['nativeEntry']['calls']['cli'],cap_limit)
        return work,final,journal

    def test_assembled_worst_case_closes_at195_with_maximum_four_extra_reads(self):
        for failures,expected in ((0,191),(1,193),(2,195)):
            with self.subTest(failures=failures):
                work,final,j=self.assembled(failures,failures)
                self.assertTrue(work['paymentObserved'])
                self.assertEqual(final['status'],'ENTRY_CLOSED',final)
                self.assertEqual(final['residuals'],[])
                self.assertEqual(j['nativeEntry']['calls']['cli'],expected)
                self.assertEqual(len(j['nativeEntry']['identityReadbacks']),2*(failures+1))

    def test_old192_budget_refuses_remaining_closeout_without_bypassing_accounting(self):
        _,final,j=self.assembled(2,2,192)
        self.assertEqual(j['nativeEntry']['calls']['cli'],192)
        self.assertEqual(final['status'],'ENTRY_CONTAINMENT_UNCONFIRMED')
        self.assertIn('TRAFFIC_PRIVATE_PLANS',final['residuals'])

    def test_exhausted_forward_observations_do_not_reach_payment_and_cleanup_still_closes(self):
        work,final,j=self.assembled(9,0)
        self.assertFalse(work['paymentObserved'])
        self.assertEqual(final['status'],'ENTRY_CLOSED')
        self.assertEqual(j['failure'],'RUNTIME_IDENTITY_STATE_MISMATCH')
        self.assertEqual(len([r for r in j['nativeEntry']['identityReadbacks'] if r['phase']=='MAIN']),3)

    def test_exhausted_cleanup_observations_are_not_reset_by_independent_process(self):
        _,final,j=self.assembled(0,9)
        # Independent single read can confirm the later state, but grants no new
        # transition marker or additional observation sequence from the old journal.
        self.assertEqual(final['status'],'ENTRY_CLOSED',final)
        self.assertEqual(len([r for r in j['nativeEntry']['identityReadbacks'] if r['phase']=='CLEANUP']),3)
        self.assertLessEqual(j['nativeEntry']['calls']['cli'],196)


class TagMutationDiagnosticTests(unittest.TestCase):
    PRIVATE = 'synthetic-private-tag-diagnostic-canary'
    BASELINE = 'b72ecb89f1907a25c988bbe3f33388bfdab77976'
    CODES = ('COMMAND_TIMEOUT', 'COMMAND_UNAVAILABLE', 'COMMAND_REFUSED',
             'OUTPUT_LIMIT', 'OUTPUT_ENCODING', 'JSON_PARSE', 'ACK_SHAPE')

    def fixture(self, connected=False):
        fixture = ConnectedEntryTests() if connected else EntryTests()
        fixture.setUp(timing=True)
        self.addCleanup(fixture.doCleanups)
        return fixture

    def native(self):
        fixture = self.fixture()
        cap, io = fixture.native_fixture()
        io.token = 'SYNTHETIC_TOKEN'
        plan = {**cap.plan, 'iam': []}
        vector = io.restore.command(plan, 'tag', io.restore.TAG, True)
        self.assertIn('--update-tags=' + io.restore.TAG + '=' + cap.e['resources']['candidate'], vector)
        return fixture, cap, io, vector

    def response(self, code):
        private = self.PRIVATE.encode()
        if code == 'COMMAND_TIMEOUT':
            return subprocess.TimeoutExpired(self.PRIVATE, 8, output=private, stderr=private)
        if code == 'COMMAND_UNAVAILABLE':
            return OSError(self.PRIVATE)
        status, raw = {
            'COMMAND_REFUSED': (7, private),
            'OUTPUT_LIMIT': (0, private + b'x' * 65537),
            'OUTPUT_ENCODING': (0, b'\xff' + private),
            'JSON_PARSE': (0, b'{' + private),
            'ACK_SHAPE': (0, json.dumps([{'private': self.PRIVATE}]).encode()),
        }[code]
        return subprocess.CompletedProcess([], status, raw, private)

    def process_patch(self, response):
        return patch('native_io.subprocess.run', **(
            {'side_effect': response} if isinstance(response, BaseException)
            else {'return_value': response}))

    def original_method(self, file, owner, name):
        # The exact approved pre-change source is the compatibility oracle.
        relative = 'evidence/APP-013/p08-native-entry-local-20261101/source/' + file
        raw = subprocess.check_output(['/usr/bin/git', '-C', str(a.BACKEND),
                                       'show', self.BASELINE + ':' + relative])
        expected = {'native_io.py': 'b05001e4fcf462c1727ae58b649fe35b110444da3c43941622213d456004119c',
                    'entry.py': '89f9c917012f9867f135d05d075608da3cb3a23f010cf73ac675f4cdc29ba7a0'}
        self.assertEqual(hashlib.sha256(raw).hexdigest(), expected[file])
        tree = ast.parse(raw)
        cls = next(n for n in tree.body if isinstance(n, ast.ClassDef) and n.name == owner)
        method = next(n for n in cls.body if isinstance(n, ast.FunctionDef) and n.name == name)
        module = sys.modules['native_io'] if file == 'native_io.py' else entry
        namespace = dict(vars(module))
        if file == 'entry.py':
            # A method compiled outside its class has no implicit __class__ cell.
            # Bind the original class in the test namespace, preserving super order.
            class ExplicitSuper(ast.NodeTransformer):
                def visit_Call(self, node):
                    self.generic_visit(node)
                    if isinstance(node.func, ast.Name) and node.func.id == 'super' and not node.args:
                        node.args = [ast.Name(id='Coordinator', ctx=ast.Load()),
                                     ast.Name(id='self', ctx=ast.Load())]
                    return node
            method = ExplicitSuper().visit(method)
        isolated = ast.fix_missing_locations(ast.Module(body=[method], type_ignores=[]))
        exec(compile(isolated, '<exact-tg1-baseline-method>', 'exec'), namespace)
        return namespace[name]

    def test_all_seven_codes_use_one_exact_native_command_and_safe_literal(self):
        _, cap, io, vector = self.native()
        for code in self.CODES:
            with self.subTest(code=code):
                response = self.response(code)
                before = cap.coordinator.j['nativeEntry']['calls']['cli']
                with self.process_patch(response) as run:
                    with self.assertRaises(Stop) as raised:
                        io.cloud(vector, cap.times['workEnd'])
                self.assertEqual(raised.exception.args, ('RUNTIME_TAG_' + code,))
                self.assertNotIn(self.PRIVATE, str(raised.exception))
                self.assertEqual(run.call_count, 1)
                self.assertEqual(run.call_args.args[0], ['/opt/homebrew/bin/gcloud', *vector, '--format=json'])
                self.assertEqual(run.call_args.kwargs['timeout'], 8)
                self.assertEqual(cap.coordinator.j['nativeEntry']['calls']['cli'] - before, 1)
                if isinstance(response, subprocess.CompletedProcess):
                    self.assertEqual((response.stdout, response.stderr), (b'', b''))

    def test_nonzero_output_limit_encoding_and_json_precedence(self):
        _, _, io, vector = self.native()
        cases = [(3, b'\xff' * 65537, 'COMMAND_REFUSED'),
                 (0, b'\xff' * 65537, 'OUTPUT_LIMIT'),
                 (0, b'\xff{', 'OUTPUT_ENCODING'),
                 (0, b'', 'JSON_PARSE'), (0, b'{', 'JSON_PARSE')]
        for status, raw, code in cases:
            with self.subTest(code=code):
                with self.process_patch(subprocess.CompletedProcess([], status, raw, self.PRIVATE.encode())):
                    with self.assertRaises(Stop) as raised: io.cloud(vector, 0)
                self.assertEqual(raised.exception.args, ('RUNTIME_TAG_' + code,))

    def test_exact_output_bound_is_unchanged(self):
        _, _, io, vector = self.native()
        for size in (65536, 65537):
            response = subprocess.CompletedProcess([], 0, b'{}' + b' ' * (size - 2), b'')
            with self.process_patch(response):
                if size == 65536: self.assertEqual(io.cloud(vector, 0), {})
                else:
                    with self.assertRaisesRegex(Stop, '^RUNTIME_TAG_OUTPUT_LIMIT$'): io.cloud(vector, 0)

    def test_installed_sdk_and_dictionary_predicates_match_exact_baseline(self):
        _, _, io, vector = self.native()
        baseline = self.original_method('native_io.py', 'NativeIO', 'cloud')
        sdk = '/opt/homebrew/Caskroom/gcloud-cli/583.0.0/google-cloud-sdk/lib'
        code = """import sys,io,json
from types import SimpleNamespace
sys.path[:0]=[sys.argv[1],sys.argv[1]+'/third_party']
from googlecloudsdk.api_lib.run import traffic_pair
from googlecloudsdk.core.resource import resource_printer
normal=SimpleNamespace(percent=100,tag=None,url='',revisionName='synthetic-normal',latestRevision=False)
tag=SimpleNamespace(percent=None,tag='synthetic-tag',url='https://synthetic.invalid',revisionName='synthetic-candidate',latestRevision=False)
pair=lambda targets,name:traffic_pair.TrafficTargetPair(targets,targets,name,False,None)
outputs=[]
for rows in ([pair([normal],'synthetic-normal')],[pair([normal],'synthetic-normal'),pair([tag],'synthetic-candidate')],[pair([],'synthetic-pending')]):
 out=io.StringIO();resource_printer.Print(rows,'json',out=out);outputs.append(json.loads(out.getvalue()))
print(json.dumps(outputs))
"""
        outputs = json.loads(subprocess.check_output([sys.executable, '-B', '-c', code, sdk]))
        values = [*outputs, {}, {'private': self.PRIVATE}, None, False, 0, 'text', [], [{}], [None]]
        for key, value in [('revisionName', ''), ('latestRevision', 1), ('specPercent', 0),
                           ('statusPercent', '101'), ('tags', [{}]), ('urls', [1])]:
            row = copy.deepcopy(outputs[0]); row[0][key] = value; values.append(row)
        for value in values:
            with self.subTest(shape=type(value).__name__):
                raw = json.dumps(value).encode()
                with self.process_patch(subprocess.CompletedProcess([], 0, raw, b'')):
                    try: expected = ('accepted', baseline(io, vector, 0))
                    except Stop: expected = ('rejected', None)
                with self.process_patch(subprocess.CompletedProcess([], 0, raw, b'')):
                    if expected[0] == 'accepted': self.assertEqual(io.cloud(vector, 0), expected[1])
                    else:
                        with self.assertRaisesRegex(Stop, '^RUNTIME_TAG_ACK_SHAPE$'): io.cloud(vector, 0)

    def test_success_acknowledgment_never_replaces_authoritative_traffic(self):
        _, cap, io, vector = self.native()
        with self.process_patch(subprocess.CompletedProcess([], 0, b'{}', b'')):
            self.assertEqual(io.cloud(vector, 0), {})
        r = io.restore
        normal = {'revisionName': r.NORMAL, 'percent': 100}
        tag = {'revisionName': r.CANDIDATE, 'tag': r.TAG}
        cases = [([normal, tag], True), ([normal, {**tag, 'percent': 0}], True),
                 ([normal], False), ([normal, {**tag, 'revisionName': 'foreign'}], False),
                 ([normal, {**tag, 'percent': 1}], 'NORMAL_TRAFFIC'),
                 ([{**normal, 'percent': 99}, tag], 'NORMAL_TRAFFIC'), ([], 'TRAFFIC_SHAPE')]
        for rows, expected in cases:
            adapter = SimpleNamespace(cloud=lambda *args, rows=rows: {'status': {'traffic': rows}})
            if isinstance(expected, str):
                with self.assertRaisesRegex(r.Stop, '^' + expected + '$'):
                    r.NativeAdapter.traffic(adapter, cap.plan, 0, True)
            else: self.assertIs(r.NativeAdapter.traffic(adapter, cap.plan, 0, True), expected)

    def test_cleanup_non_tag_and_foreign_vectors_keep_original_process_codes(self):
        _, cap, io, vector = self.native()
        r = io.restore; plan = {**cap.plan, 'iam': []}
        exact = ['/opt/homebrew/bin/gcloud', *vector, '--format=json']
        vectors = [('/wrong/gcloud', *exact[1:]), tuple(exact), exact[:-1], [*exact, '--foreign'],
                   [v.replace(r.CANDIDATE, 'foreign-candidate') for v in exact],
                   ['/opt/homebrew/bin/gcloud', *r.command(plan, 'tag', r.TAG, False), '--format=json'],
                   ['/opt/homebrew/bin/gcloud', *r.command(plan, 'identity', r.IDENTITY, True), '--format=json']]
        for argv in vectors:
            for code, old in [('COMMAND_TIMEOUT', 'NATIVE_COMMAND_UNCONFIRMED'),
                              ('COMMAND_UNAVAILABLE', 'NATIVE_COMMAND_UNCONFIRMED'),
                              ('COMMAND_REFUSED', 'NATIVE_COMMAND_REFUSED'),
                              ('OUTPUT_LIMIT', 'NATIVE_COMMAND_REFUSED'),
                              ('OUTPUT_ENCODING', 'NATIVE_OUTPUT_ENCODING')]:
                with self.subTest(argv=type(argv).__name__, code=code):
                    with self.process_patch(self.response(code)):
                        with self.assertRaises(Stop) as raised: io._run(argv, 'cli')
                    self.assertEqual(raised.exception.args, (old,))
        io.cleanup = True
        with self.process_patch(self.response('COMMAND_TIMEOUT')):
            with self.assertRaisesRegex(Stop, '^NATIVE_COMMAND_UNCONFIRMED$'): io._run(exact, 'cli')

    def test_cleanup_and_other_mutations_keep_original_parse_codes(self):
        _, cap, io, vector = self.native()
        r = io.restore; plan = {**cap.plan, 'iam': []}
        vectors = [r.command(plan, 'tag', r.TAG, False),
                   r.command(plan, 'secretBinding', r.POLICIES[0], True)]
        for target in vectors:
            for raw in (b'{', b'null', b'[]'):
                with self.process_patch(subprocess.CompletedProcess([], 0, raw, b'')):
                    with self.assertRaisesRegex(Stop, '^NATIVE_OUTPUT_SHAPE$'): io.cloud(target, 0)
        io.cleanup = True
        for raw in (b'{', b'null'):
            with self.process_patch(subprocess.CompletedProcess([], 0, raw, b'')):
                with self.assertRaisesRegex(Stop, '^NATIVE_OUTPUT_SHAPE$'): io.cloud(vector, 0)

    def stopped_run(self, response, expected, *, cleanup_mismatch=False, after_process=None,
                    injected_error=None, baseline=False):
        fixture = self.fixture(connected=True)
        trace = []; process_calls = []; spends = []
        tag_item = ['tag', entry.restore.TAG]
        def factory(cap):
            io = fixture.factory(cap); original = io.cloud
            forward = entry.restore.command({**cap.plan, 'iam': []}, 'tag', entry.restore.TAG, True)
            def cloud(vector, deadline):
                trace.append((cap.mode, io.cleanup, list(vector)))
                if not io.cleanup and vector == forward:
                    fixture.f.runtime_state[tuple(tag_item)] = True
                    if injected_error is not None: raise injected_error
                    native = object.__new__(entry.NativeIO)
                    native.cap, native.cleanup, native.restore = cap, False, cap.modules['restore']
                    native.token = 'SYNTHETIC_TOKEN'
                    before = cap.coordinator.j['nativeEntry']['calls']['cli']
                    def process(*args, **kwargs):
                        process_calls.append((args, kwargs))
                        if after_process == 'interrupt': cap.coordinator.abort = True
                        if after_process == 'deadline': cap.clock = lambda: cap.times['workEnd'] + 1
                        if isinstance(response, BaseException): raise response
                        return copy.deepcopy(response)
                    with patch('native_io.subprocess.run', side_effect=process):
                        try: return native.cloud(vector, deadline)
                        finally:
                            spends.append(cap.coordinator.j['nativeEntry']['calls']['cli'] - before)
                value = original(vector, deadline)
                if cleanup_mismatch and io.cleanup and vector[:3] == ['run', 'services', 'describe']:
                    return {'status': {'traffic': [{'revisionName': entry.restore.NORMAL, 'percent': 100},
                        {'revisionName': entry.restore.CANDIDATE, 'tag': entry.restore.TAG}]}}
                return value
            io.cloud = cloud
            return io
        if baseline:
            old_run = self.original_method('native_io.py', 'NativeIO', '_run')
            old_cloud = self.original_method('native_io.py', 'NativeIO', 'cloud')
            old_invoke = self.original_method('entry.py', 'Coordinator', 'invoke')
            with patch.object(entry.NativeIO, '_run', old_run), patch.object(entry.NativeIO, 'cloud', old_cloud), \
                    patch.object(entry.Coordinator, 'invoke', old_invoke):
                work = entry.run_entry(fixture.path, io_factory=factory)
                final = entry.run_entry(fixture.path, 'closeout', io_factory=factory)
        else:
            work = entry.run_entry(fixture.path, io_factory=factory)
            final = entry.run_entry(fixture.path, 'closeout', io_factory=factory)
        journal = read(fixture.root / 'journal.json')
        self.assertEqual(journal['failure'], expected)
        self.assertEqual(work['status'], 'ENTRY_AWAITING_INDEPENDENT_CLOSEOUT')
        self.assertEqual(final['status'], 'ENTRY_CONTAINMENT_UNCONFIRMED')
        self.assertEqual(journal['runtimeAttempted'][-1], tag_item)
        self.assertNotIn(tag_item, journal['runtimeOwned'])
        self.assertIn(tag_item, journal['runtimeCleanupAttempted'])
        self.assertEqual(journal['iamAttempted'], []); self.assertEqual(journal['iamOwned'], [])
        self.assertFalse(journal['keyCreateAttempted']); self.assertFalse(journal['authAttempted'])
        self.assertFalse(final['authenticationObserved']); self.assertFalse(final['paymentObserved'])
        self.assertFalse(work['paymentObserved']); self.assertFalse(journal['payment']['enableIntent'])
        self.assertTrue(journal['payment']['endpointDisabled']); self.assertTrue(journal['payment']['bridgeClosed'])
        self.assertEqual(journal['nativeEntry']['calls']['child'], 1)
        self.assertTrue(final['privateInputsAbsent']); self.assertFalse(fixture.path.exists())
        self.assertFalse((fixture.root / 'payment-bootstrap-open-attempt.json').exists())
        self.assertFalse(any(fixture.f.runtime_state.values()))
        label = 'RUNTIME:tag:' + entry.restore.TAG
        self.assertEqual(journal['unknown'], [label])
        self.assertIn(label, work['residuals']); self.assertIn(label, final['residuals'])
        if cleanup_mismatch:
            self.assertIn('RUNTIME_tag:' + entry.restore.TAG, final['residuals'])
            self.assertIn('RUNTIME_FINAL', final['residuals'])
        else: self.assertEqual(final['residuals'], [label])
        if injected_error is None:
            self.assertEqual(len(process_calls), 1); self.assertEqual(spends, [1])
            argv = process_calls[0][0][0]
            forward = entry.restore.command({**fixture.f.p, 'iam': []}, 'tag', entry.restore.TAG, True)
            self.assertEqual(argv, ['/opt/homebrew/bin/gcloud', *forward, '--format=json'])
            self.assertEqual(process_calls[0][1]['timeout'], 8)
        for enabled in (True, False):
            vector = entry.restore.command({**fixture.f.p, 'iam': []}, 'tag', entry.restore.TAG, enabled)
            self.assertEqual(sum(v == vector for _, _, v in trace), 1)
        self.assertTrue(any(mode == 'closeout' and v[:3] == ['run', 'services', 'describe']
                            for mode, _, v in trace))
        for path in fixture.root.iterdir():
            self.assertNotIn(self.PRIVATE.encode(), path.read_bytes())
        return journal

    def test_exact_baseline_collapses_failures_through_assembled_parent(self):
        for code in ('COMMAND_TIMEOUT', 'JSON_PARSE', 'ACK_SHAPE'):
            with self.subTest(code=code):
                self.stopped_run(self.response(code), 'LOCAL_ADAPTER_OR_SOURCE_STOP', baseline=True)

    def test_all_seven_survive_main_and_independent_closeout_without_replay(self):
        for code in self.CODES:
            with self.subTest(code=code):
                self.stopped_run(self.response(code), 'RUNTIME_TAG_' + code)

    def test_failed_cleanup_keeps_separate_residual_and_forward_code(self):
        self.stopped_run(self.response('ACK_SHAPE'), 'RUNTIME_TAG_ACK_SHAPE', cleanup_mismatch=True)

    def test_unknown_and_untrusted_errors_remain_generic_and_private(self):
        class DerivedStop(Stop): pass
        class DerivedString(str): pass
        class HostileStop(Stop):
            @property
            def args(self): raise AssertionError('untrusted exception args inspected')
        errors = [DerivedStop('RUNTIME_TAG_ACK_SHAPE'), Stop(DerivedString('RUNTIME_TAG_ACK_SHAPE')),
                  Stop('RUNTIME_TAG_ACK_SHAPE', self.PRIVATE), Stop(self.PRIVATE),
                  RuntimeError('RUNTIME_TAG_ACK_SHAPE'), ValueError(self.PRIVATE),
                  HostileStop(self.PRIVATE), KeyboardInterrupt()]
        for error in errors:
            with self.subTest(error=type(error).__name__):
                self.stopped_run(None, 'LOCAL_ADAPTER_OR_SOURCE_STOP', injected_error=error)

    def test_coordinator_promotion_requires_exact_method_owner_tag_flag_and_plan(self):
        fixture = self.fixture()
        cap = a.Capability(fixture.e, fixture.root)
        io = fixture.factory(cap); runtime = entry.RuntimeAdapter(cap, io)
        ports = entry.Ports(cap, io, None, runtime)
        controller = entry.Coordinator(cap, io, runtime, ports)
        controller.mutation_admitted = True
        plan = controller.runtime_plan()
        error = Stop('RUNTIME_TAG_ACK_SHAPE')
        runtime.change = lambda *args, **kwargs: (_ for _ in ()).throw(error)
        runtime.readback = runtime.change
        foreign = SimpleNamespace(change=runtime.change)
        cases = [('readback', ('tag', entry.restore.TAG, True, plan), runtime, False),
                 ('change', ('tag', 'foreign-tag', True, plan), runtime, False),
                 ('change', ('identity', entry.restore.TAG, True, plan), runtime, False),
                 ('change', ('tag', entry.restore.TAG, 1, plan), runtime, False),
                 ('change', ('tag', entry.restore.TAG, False, plan), runtime, False),
                 ('change', ('tag', entry.restore.TAG, True, {**plan, 'operationId': 'foreign'}), runtime, False),
                 ('change', ('tag', entry.restore.TAG, True, plan), foreign, False),
                 ('change', ('tag', entry.restore.TAG, True, plan), runtime, True)]
        for method, args, owner, cleanup in cases:
            with self.subTest(method=method, owner=owner is runtime, cleanup=cleanup):
                with self.assertRaises(Stop) as raised:
                    controller.invoke(method, *args, owner=owner, cleanup=cleanup)
                self.assertIs(raised.exception, error)

    def test_postprocess_interrupt_and_deadline_precede_tag_classification(self):
        for boundary in ('interrupt', 'deadline'):
            # Capability guard Stop was historically generic at this non-preflight
            # parent boundary; compare the exact old code instead of relabeling it.
            for baseline in (True, False):
                with self.subTest(boundary=boundary, baseline=baseline):
                    self.stopped_run(self.response('COMMAND_REFUSED'), 'LOCAL_ADAPTER_OR_SOURCE_STOP',
                                     after_process=boundary, baseline=baseline)

    def test_postprocess_guard_code_is_not_mislabeled_as_command_refusal(self):
        _, cap, io, vector = self.native()
        def interrupted(*args, **kwargs):
            cap.coordinator.abort = True
            return subprocess.CompletedProcess([], 7, self.PRIVATE.encode(), self.PRIVATE.encode())
        with patch('native_io.subprocess.run', side_effect=interrupted) as run:
            with self.assertRaises(Stop) as raised: io.cloud(vector, 0)
        self.assertEqual(raised.exception.args, ('INTERRUPTED',))
        self.assertEqual(run.call_count, 1)

    def test_predispatch_guard_refuses_before_reservation_or_process(self):
        _, cap, io, vector = self.native()
        before = copy.deepcopy(cap.coordinator.j['nativeEntry']['calls'])
        cap.coordinator.abort = True
        with patch('native_io.subprocess.run', side_effect=AssertionError('process must not run')) as run:
            with self.assertRaisesRegex(Stop, '^INTERRUPTED$'): io.cloud(vector, 0)
        run.assert_not_called()
        self.assertEqual(cap.coordinator.j['nativeEntry']['calls'], before)

    def test_real_inert_process_results_use_the_existing_run_boundary(self):
        _, _, io, vector = self.native()
        original = subprocess.run
        programs = [('import sys;sys.stderr.write("' + self.PRIVATE + '");sys.exit(7)', 'COMMAND_REFUSED'),
                    ('import os;os.write(1,b"\\xff")', 'OUTPUT_ENCODING'),
                    ('import os;os.write(1,b"x"*65537)', 'OUTPUT_LIMIT')]
        for program, code in programs:
            observed = []
            def inert(argv, **kwargs):
                observed.append(argv)
                return original([sys.executable, '-I', '-B', '-c', program], **kwargs)
            with patch('native_io.subprocess.run', side_effect=inert):
                with self.assertRaisesRegex(Stop, '^RUNTIME_TAG_' + code + '$'): io.cloud(vector, 0)
            self.assertEqual(observed, [['/opt/homebrew/bin/gcloud', *vector, '--format=json']])

    def test_concurrent_entry_refuses_before_any_tag_dispatch(self):
        fixture = self.fixture(connected=True)
        fd = os.open(fixture.root / 'entry.lock', os.O_CREAT | os.O_WRONLY, 0o600)
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            with patch.object(entry.RuntimeAdapter, 'change', side_effect=AssertionError('mutation forbidden')) as change:
                with self.assertRaisesRegex(Stop, '^ENTRY_ALREADY_RUNNING$'): fixture.run_entry()
            change.assert_not_called()
            self.assertEqual(fixture.calls, 0); self.assertFalse((fixture.root / 'attempt.json').exists())
        finally: os.close(fd)


for _name in EntryTests.__dict__:
    if _name.startswith('test_'):
        setattr(ConnectedEntryTests,_name,None)

class ChildOutputContractTests(unittest.TestCase):
    def test_python_and_node_literal_failure_contracts_match(self):
        import handoff
        script = "import {CHILD_FAILURE_STAGES,CHILD_FAILURE_CODES} from " + json.dumps((a.HERE/'native_child.mjs').as_uri()) + ";process.stdout.write(JSON.stringify({stages:CHILD_FAILURE_STAGES,codes:CHILD_FAILURE_CODES}));"
        result = subprocess.run(['/Users/debynyhanbanks/.nvm/versions/node/v24.12.0/bin/node',
                                 '--input-type=module', '-e', script], capture_output=True, text=True, check=True)
        value = json.loads(result.stdout)
        self.assertEqual(set(value['stages']), handoff.CHILD_FAILURE_STAGES)
        self.assertEqual(set(value['codes']), handoff.CHILD_FAILURE_CODES)

    def test_diagnostic_recording_failure_cannot_replace_primary_or_create_success(self):
        import handoff
        for primary in (None,handoff.old.Stop('CHILD_JOURNAL_ABSENT')):
            h=object.__new__(handoff.Handoff)
            h.coordinator=SimpleNamespace(j={'nativeEntry':{'calls':{'child':1}},'unknown':[]})
            h.cap=SimpleNamespace(spend=lambda *args:time.time()+30,e={'version':2},
                                  root=Path('/synthetic'),coordinator=h.coordinator,clock=time.time,
                                  times={'workEnd':time.time()+30},gate=lambda *args:None)
            h.io=SimpleNamespace(credentials=lambda:{},child=lambda *args,**kwargs:
                                 SimpleNamespace(returncode=0,stderr='',stdout='{"status":"PAYMENT_PREFLIGHT_QUALIFIED","qualified":true}'))
            h._journal=lambda:{}
            def merge(before):
                if primary is not None:raise primary
                return None
            h._merge_child=merge
            h._record_child_observation=lambda value:(_ for _ in ()).throw(RuntimeError('SYNTHETIC_PRIVATE_RECORDING_ERROR'))
            with self.assertRaises(handoff.old.Stop) as raised:
                h.invoke_child(None,'--payment-preflight')
            if primary is not None:self.assertIs(raised.exception,primary)
            else:self.assertEqual(raised.exception.args,('CHILD_DIAGNOSTIC_UNCONFIRMED',))
            self.assertEqual(h.coordinator.j['unknown'],['CHILD_DIAGNOSTIC_UNCONFIRMED'])
            self.assertNotIn('SYNTHETIC_PRIVATE_RECORDING_ERROR',json.dumps(h.coordinator.j))

    def test_strict_bounded_process_frame_rejects_private_or_ambiguous_output(self):
        import handoff
        good = {'status':'NATIVE_CHILD_REFUSED_OR_UNCONFIRMED', 'stage':'CLIENT_BINDING', 'code':'TLS_REQUIRED'}
        result = lambda out, code=2, err='': SimpleNamespace(stdout=out, returncode=code, stderr=err)
        self.assertEqual(handoff.child_output(result(json.dumps(good))),
                         (None, {'stage':'CLIENT_BINDING', 'code':'TLS_REQUIRED'}))
        self.assertEqual(handoff.child_output(result('{"ok":true}', 0)), ({'ok':True}, None))
        invalid = ['', 'null', '[]', '42', 'false', 'malformed', 'x'*8193,
                   '{"status":"NATIVE_CHILD_REFUSED_OR_UNCONFIRMED","stage":"INPUT","stage":"RESULT","code":"UNCLASSIFIED"}',
                   '{"private":NaN}', '{"private":Infinity}', '{"ok":{"duplicate":1,"duplicate":2}}',
                   json.dumps({**good,'message':'SYNTHETIC_PRIVATE_FRAME'}),
                   json.dumps({**good,'stage':'SYNTHETIC_PRIVATE_FRAME'}),
                   json.dumps({**good,'code':'SYNTHETIC_PRIVATE_FRAME'}),
                   json.dumps({**good,'stage':None}), json.dumps({**good,'code':True}),
                   json.dumps({**good,'code':[]})]
        for text in invalid:
            with self.subTest(length=len(text)):
                self.assertEqual(handoff.child_output(result(text)), (None,None))
        for code in (0, 1, -9, True, '2'):
            self.assertEqual(handoff.child_output(result(json.dumps(good),code)), (None,None))
        self.assertEqual(handoff.child_output(result(json.dumps(good),2,'SYNTHETIC_PRIVATE_FRAME')), (None,None))


class JournalContractIntegrationTests(unittest.TestCase):
    PRIVATE = 'JC1_PRIVATE_SENTINEL'

    def fixture(self, scenario='normal'):
        value = ConnectedEntryTests()
        value.setUp(timing=True)
        self.addCleanup(value.doCleanups)
        value.scenario = scenario
        return value

    def completed(self, scenario, *, mutate_io=None, auth_only=False):
        fixture = self.fixture(scenario)
        if auth_only:
            fixture.e['purpose']='NATIVE_AUTH_QUALIFICATION_ONLY'
            fixture.seal()
        before_merge = []
        original = fixture.factory
        def factory(cap):
            io = original(cap)
            child = io.child
            def invoke(argv, **kwargs):
                result = child(argv, **kwargs)
                if argv[2] == '--run':
                    auth = read(fixture.root/'journal.json').get('authClient')
                    before_merge.append(copy.deepcopy(auth))
                return result
            io.child = invoke
            if mutate_io is not None:
                mutate_io(io, cap, fixture)
            return io
        work = entry.run_entry(fixture.path, io_factory=factory)
        final = entry.run_entry(fixture.path, 'closeout', io_factory=factory)
        journal = read(fixture.root/'journal.json')
        self.assertTrue(final['privateInputsAbsent'])
        self.assertFalse(fixture.path.exists())
        self.assertFalse((fixture.root/'payment-bootstrap-open-attempt.json').exists())
        for kind,count in journal['nativeEntry']['calls'].items():
            self.assertLessEqual(count, fixture.e['limits'][kind])
        observations = journal['nativeEntry'].get('childObservations', [])
        self.assertEqual([x['childCall'] for x in observations],
                         list(range(1,journal['nativeEntry']['calls']['child']+1)))
        self.assertLessEqual(len(observations),fixture.e['limits']['child'])
        self.assertEqual(set(final), {'status','operationId','liveAuthorization','authProofReady',
                                      'authenticationObserved','residuals','privateInputsAbsent',
                                      'childResultSha256','paymentObserved','paymentReadyForAcceptance'})
        for path in fixture.root.iterdir():
            self.assertNotIn(self.PRIVATE.encode(),path.read_bytes())
            self.assertNotIn(b'PRIVATE_SENTINEL',path.read_bytes())
        return fixture, work, final, journal, before_merge

    def test_ad2_diagnostics_survive_real_subprocess_parent_and_independent_cleanup(self):
        for scenario, stage in [('auth_sign_http403','SIGN'), ('auth_key_http403','KEY_READ'),
                                ('auth_exchange_http403','EXCHANGE')]:
            with self.subTest(stage=stage):
                _, work, final, journal, before = self.completed(scenario)
                self.assertEqual(before[0]['authStage'],stage)
                auth=journal['authClient']
                self.assertEqual((auth['authStage'],auth['failureCategory'],auth['httpStatus']),
                                 (stage,'HTTP',403))
                self.assertNotIn('responseValidationCode', auth)
                self.assertEqual(auth['phase'],'CLOSEOUT_FINISHED')
                self.assertEqual(auth['residuals'],[])
                self.assertTrue(auth['sessionClosed'])
                self.assertEqual(final['residuals'],['AUTH_OUTCOME_UNKNOWN'])
                self.assertFalse(final['authenticationObserved']);self.assertFalse(final['paymentObserved'])
                self.assertFalse(work['paymentObserved'])
                self.assertTrue(all(x['journalMerge']=='ACCEPTED' for x in journal['nativeEntry']['childObservations']))

    def rv1_completed(self, stage, code, process_fault=None):
        """Reuse actual native/client/sequence/merge boundaries; inject only inert I/O."""
        observed = []
        script = """import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runChild,childRefusal,readChildRequest,serializeChildResult} from %s;
import {portsFor,rawFor} from %s;
try {
 const request=readChildRequest(),e=JSON.parse(readFileSync(request.envelopePath));
 const ports=portsFor({r:request,e,raw:rawFor(e)}),fetcher=ports.fetcher;
 const selected=%s,code=%s,stages=['SIGN','KEY_READ','EXCHANGE'];let requests=0;
 ports.fetcher=async(url,options)=>{
  const stage=url.includes(':signBlob')?'SIGN':url.endsWith('/keyString')?'KEY_READ':
    url.includes('signInWithCustomToken')?'EXCHANGE':null;
  if(stage)requests++;
  if(stage!==selected)return fetcher(url,options);
  const privateValue='PRIVATE_SENTINEL';
  const text=code==='BODY_BOUND'?privateValue.repeat(6000):
    code==='JSON_PARSE'?'{'+privateValue:code==='RESPONSE_SHAPE'?'null':
    JSON.stringify(code==='PROVIDER_ERROR'?{error:{message:privateValue}}:
      code==='SIGN_RESPONSE_SHAPE'?{signedBlob:1,body:privateValue}:
      code==='KEY_RESPONSE_MISMATCH'?{keyString:privateValue}:
      {localId:privateValue,idToken:privateValue});
  return {ok:true,status:200,text:async()=>text};
 };
 const result=await runChild(process.argv[1],request,ports);
 assert.equal(requests,stages.indexOf(selected)+1);
 assert.equal(result.authenticated,false);
 process.stdout.write(serializeChildResult(result));
} catch(error) {process.stdout.write(JSON.stringify(childRefusal(error))+'\\n');process.exitCode=2;}
""" % (json.dumps((a.HERE/'native_child.mjs').as_uri()),
       json.dumps((a.HERE/'fixture_connected.mjs').as_uri()), json.dumps(stage), json.dumps(code))
        def inject(io, cap, fixture):
            child = io.child
            def invoke(argv, **kwargs):
                if argv[2] != '--run':
                    return child(argv, **kwargs)
                result = subprocess.run([argv[0], '--input-type=module', '-e', script, '--', argv[2]], **kwargs)
                observed.append(copy.deepcopy(read(fixture.root/'journal.json').get('authClient')))
                self.assertEqual(result.returncode, 0, result.stdout)
                self.assertEqual(result.stderr, '')
                self.assertNotIn('PRIVATE_SENTINEL', result.stdout)
                if process_fault == 'timeout':
                    raise subprocess.TimeoutExpired(argv, 1, output=self.PRIVATE)
                if process_fault == 'interruption':
                    raise KeyboardInterrupt(self.PRIVATE)
                if process_fault == 'exit':
                    raise RuntimeError(self.PRIVATE)
                outputs = {'lost': '', 'oversize': 'x' * 8193,
                           'duplicate': '{"status":"PRIVATE_SENTINEL","status":"duplicate"}'}
                if process_fault in outputs:
                    return subprocess.CompletedProcess(argv, 2, outputs[process_fault], '')
                return result
            io.child = invoke
        fixture, work, final, journal, _ = self.completed('normal', mutate_io=inject)
        self.assertEqual(len(observed), 1)
        # Native transports.mjs rejects oversized text before the client's own
        # body predicate. Keep that established TRANSPORT classification; the
        # direct injected-client suite separately exercises BODY_BOUND.
        category = 'TRANSPORT' if code == 'BODY_BOUND' else 'RESPONSE_VALIDATION'
        if code == 'BODY_BOUND':
            self.assertNotIn('responseValidationCode', observed[0])
        else:
            self.assertEqual(observed[0]['responseValidationCode'], code)
        auth = journal['authClient']
        self.assertEqual((auth['failureCode'], auth['authStage'], auth['failureCategory'],
                          auth['httpStatus']), ('SIGN_EXCHANGE_REFUSED', stage, category, None))
        if code == 'BODY_BOUND':
            self.assertNotIn('responseValidationCode', auth)
        else:
            self.assertEqual(auth['responseValidationCode'], code)
        self.assertEqual(auth['phase'], 'CLOSEOUT_FINISHED')
        self.assertEqual(auth['residuals'], [])
        self.assertTrue(auth['sessionClosed'])
        self.assertFalse(auth['authenticated'])
        self.assertEqual(final['residuals'], ['AUTH_OUTCOME_UNKNOWN'])
        self.assertFalse(final['authenticationObserved'] or final['paymentObserved'] or final['authProofReady'])
        self.assertFalse(work['paymentObserved'])
        self.assertIsNone(final['childResultSha256'])
        self.assertNotIn('childResultSha256', work)
        self.assertFalse(any(fixture.f.runtime_state.values()))
        observations = journal['nativeEntry']['childObservations']
        self.assertTrue(all(x['journalMerge'] == 'ACCEPTED' for x in observations))
        self.assertEqual(sum(x['mode'] == '--run' for x in observations), 1)
        self.assertTrue(any(x['mode'] == '--closeout' for x in observations))
        return journal

    def test_rv1_actual_client_codes_survive_child_journal_parent_and_cleanup(self):
        specific = {'SIGN': 'SIGN_RESPONSE_SHAPE', 'KEY_READ': 'KEY_RESPONSE_MISMATCH',
                    'EXCHANGE': 'EXCHANGE_RESPONSE_MISMATCH'}
        for stage, selected in specific.items():
            for code in ('BODY_BOUND', 'JSON_PARSE', 'RESPONSE_SHAPE', 'PROVIDER_ERROR', selected):
                with self.subTest(stage=stage, code=code):
                    self.rv1_completed(stage, code)

    def test_rv1_committed_code_survives_untrusted_output_timeout_exit_and_interruption(self):
        for fault in ('lost', 'duplicate', 'oversize', 'timeout', 'exit', 'interruption'):
            with self.subTest(fault=fault):
                journal = self.rv1_completed('EXCHANGE', 'EXCHANGE_RESPONSE_MISMATCH', fault)
                primary = next(x for x in journal['nativeEntry']['childObservations'] if x['mode'] == '--run')
                expected = 'TIMEOUT' if fault == 'timeout' else 'EXIT_UNKNOWN' if fault in {'exit', 'interruption'} else 'REFUSED'
                self.assertEqual(primary['processOutcome'], expected)
                self.assertEqual(primary['journalMerge'], 'ACCEPTED')

    def ec1_completed(self, scenario, *, success=False, process_fault=None, auth_only=False):
        """Exercise the documented exchange through actual authentication and parent merge."""
        observed = []
        script = """import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {runChild,childRefusal,readChildRequest,serializeChildResult} from %s;
import {portsFor,rawFor} from %s;
try {
 const request=readChildRequest(),e=JSON.parse(readFileSync(request.envelopePath));
 const ports=portsFor({r:request,e,raw:rawFor(e)}),fetcher=ports.fetcher,present=ports.present;
 const scenario=%s,success=%s;
 const handoff=scenario.kind==='handoff';
 const counts={sign:0,key:0,exchange:0,job:0,paymentWrites:0,present:0};
 let injectedOnce=false;
 ports.fetcher=async(url,options)=>{
  if(url.includes(':signBlob'))counts.sign++;
  if(url.endsWith('/keyString'))counts.key++;
  if(scenario.kind==='ap2' && url.endsWith('/accounts:lookup') && !injectedOnce &&
    JSON.parse(readFileSync(request.envelopePath.replace(/envelope\\.json$/,'journal.json'))).authClient?.phase==='RUNTIME_AUTH_INTENT' && scenario.fault.startsWith('lookup-')){
   injectedOnce=true;
   if(scenario.fault==='lookup-transport')throw {message:'PRIVATE_SENTINEL',authStage:'SIGN',httpStatus:418};
   if(scenario.fault==='lookup-http')return {ok:false,status:403,text:async()=>'PRIVATE_SENTINEL'};
   if(scenario.fault==='lookup-json')return {ok:true,status:200,text:async()=>'PRIVATE_SENTINEL'};
   if(scenario.fault==='lookup-null')return {ok:true,status:200,text:async()=>'null'};
   const response=await fetcher(url,options),value=JSON.parse(await response.text());
   if(scenario.fault==='lookup-identity')value.users[0].email='PRIVATE_SENTINEL';
   if(scenario.fault==='lookup-claims')value.users[0].customAttributes='{';
   return {ok:true,status:200,text:async()=>JSON.stringify(value)};
  }
  if(url.includes('/jobs/dispatch-board/')){
   counts.job++;
   if(scenario.kind==='ap2'){
    if(scenario.fault==='runtime-timeout')return new Promise(()=>{});
    if(scenario.fault==='runtime-transport')throw Object.defineProperty({authStage:'SIGN',httpStatus:418},'code',{get(){throw Error('PRIVATE_SENTINEL');}});
    if(scenario.fault==='runtime-read')return {body:{getReader:()=>({read:async()=>{throw Error('PRIVATE_SENTINEL');},cancel:async()=>{}})}};
    if(scenario.fault==='runtime-decode'){let used=false;return {ok:true,status:200,body:{getReader:()=>({read:async()=>used?{done:true}:(used=true,{done:false,value:new Uint8Array([255])}),cancel:async()=>{}})}};}
    if(scenario.fault==='runtime-bytes')return {ok:true,status:200,text:async()=>'x'.repeat(65537)};
    if(scenario.fault==='runtime-json')return {ok:true,status:200,text:async()=>'PRIVATE_SENTINEL'};
    if(scenario.fault==='runtime-http')return {ok:false,status:403,text:async()=>'PRIVATE_SENTINEL'};
   }
   if(handoff){
    const path=request.envelopePath.replace(/envelope\\.json$/,'journal.json');
    const j=JSON.parse(readFileSync(path));j.payment.phase='STOPPED';
    writeFileSync(path,JSON.stringify(j));
   }
   if(scenario.kind==='runtime')return {ok:false,status:scenario.status,text:async()=>'PRIVATE_SENTINEL'};
   if(scenario.kind==='job')return {ok:true,status:200,text:async()=>JSON.stringify({jobId:'PRIVATE_SENTINEL'})};
  }
  if((url.startsWith('https://api.stripe.com/')&&options.method==='POST')||
     url.endsWith('/job-payment-policy/apply')||url.endsWith('/payment-requests'))counts.paymentWrites++;
  const response=await fetcher(url,options);
  if(!url.includes('signInWithCustomToken'))return response;
  counts.exchange++;
  const value=JSON.parse(await response.text());
  assert.deepEqual(Object.keys(value).sort(),['expiresIn','idToken','isNewUser','refreshToken']);
  if(scenario.kind==='matching'||scenario.matchingLocalId)value.localId=e.target.id;
  if(scenario.kind==='localId')value.localId=scenario.value;
  if(scenario.kind==='ap2' && scenario.fault==='token-json')value.idToken='header.invalid.signature';
  if(scenario.kind==='missing-token')delete value.idToken;
  if(scenario.kind==='token')value.idToken=scenario.value;
  if(scenario.kind==='claim'||scenario.kind==='time'){
   const parts=value.idToken.split('.'),claims=JSON.parse(Buffer.from(parts[1],'base64url').toString());
   claims[scenario.field]=scenario.kind==='time'?Math.floor(Date.now()/1000)+scenario.offset:scenario.value;
   value.idToken=parts[0]+'.'+Buffer.from(JSON.stringify(claims)).toString('base64url')+'.'+parts[2];
  }
  return {ok:true,status:200,text:async()=>JSON.stringify(value)};
 };
 ports.present=async url=>{counts.present++;assert.ok(counts.job>0);return present(url);};
 const result=await runChild(process.argv[1],structuredClone(request),ports);
 assert.equal(result.authenticated,success||handoff);
 assert.equal(result.sessionClosed,true);assert.deepEqual(result.residuals,[]);
 assert.deepEqual([counts.sign,counts.key,counts.exchange],[1,1,1]);
 if(success && e.purpose==='NATIVE_AUTH_QUALIFICATION_ONLY'){assert.equal(counts.job,1);assert.equal(counts.paymentWrites,0);assert.equal(counts.present,0);}
 else if(success){assert.ok(counts.job>0);assert.ok(counts.paymentWrites>0);assert.equal(counts.present,1);}
 else {
  assert.equal(counts.job,(['runtime','job','handoff'].includes(scenario.kind)||(scenario.kind==='ap2'&&scenario.fault.startsWith('runtime-')))?1:0);
  assert.equal(counts.paymentWrites,0);assert.equal(counts.present,0);
 }
 const path=request.envelopePath.replace(/envelope\\.json$/,'journal.json');
 const before=readFileSync(path,'utf8'),countBefore=JSON.stringify(counts);
 assert.ok(!before.includes('PRIVATE_SENTINEL'));assert.ok(!before.includes('header.'));
 await assert.rejects(()=>runChild(process.argv[1],structuredClone(request),ports),{code:'EEXIST'});
 assert.equal(JSON.stringify(counts),countBefore);assert.equal(readFileSync(path,'utf8'),before);
 process.stdout.write(serializeChildResult(result));
} catch(error) {process.stdout.write(JSON.stringify(childRefusal(error))+'\\n');process.exitCode=2;}
""" % (json.dumps((a.HERE/'native_child.mjs').as_uri()),
       json.dumps((a.HERE/'fixture_connected.mjs').as_uri()), json.dumps(scenario),
       'true' if success else 'false')
        def inject(io, cap, fixture):
            child = io.child
            def invoke(argv, **kwargs):
                if argv[2] != '--run':
                    return child(argv, **kwargs)
                result = subprocess.run([argv[0], '--input-type=module', '-e', script, '--', argv[2]], **kwargs)
                observed.append(copy.deepcopy(read(fixture.root/'journal.json').get('authClient')))
                self.assertEqual(result.returncode, 0, result.stdout)
                self.assertEqual(result.stderr, '')
                self.assertNotIn('PRIVATE_SENTINEL', result.stdout)
                self.assertNotIn('header.', result.stdout)
                if process_fault == 'timeout':
                    raise subprocess.TimeoutExpired(argv, 1, output=self.PRIVATE)
                if process_fault == 'interruption':
                    raise KeyboardInterrupt(self.PRIVATE)
                if process_fault == 'exit':
                    raise RuntimeError(self.PRIVATE)
                if process_fault == 'lost':
                    return subprocess.CompletedProcess(argv, 2, '', '')
                if process_fault == 'merge':
                    value = read(fixture.root/'journal.json')
                    value['phase'] = 'FOREIGN'
                    (fixture.root/'journal.json').write_text(json.dumps(value))
                return result
            io.child = invoke
        fixture, work, final, journal, _ = self.completed('normal', mutate_io=inject, auth_only=auth_only)
        self.assertEqual(len(observed), 1)
        if auth_only and success and process_fault:
            self.assertTrue(observed[0]['authenticated'])
            self.assertFalse(final['authenticationObserved'] or final['authProofReady'] or final['paymentObserved'])
            self.assertIsNone(final['childResultSha256'])
            self.assertIn('AUTH_OUTCOME_UNKNOWN',final['residuals'])
            self.assertFalse(any(fixture.f.runtime_state.values()))
            self.assertFalse(journal['payment']['enableIntent'])
            self.assertTrue(journal['payment']['bridgeClosed'])
            return
        if scenario['kind'] == 'ap2' and process_fault:
            diagnostic = observed[0]
            self.assertEqual(diagnostic['authStage'], scenario['stage'])
            self.assertEqual(diagnostic['failureCategory'], scenario['category'])
            self.assertFalse(diagnostic['authenticated'])
            self.assertFalse(final['authenticationObserved'] or final['paymentObserved'] or final['authProofReady'])
            self.assertFalse(final['paymentReadyForAcceptance'])
            self.assertIsNone(final['childResultSha256'])
            self.assertIn('AUTH_OUTCOME_UNKNOWN', final['residuals'])
            self.assertFalse(any(fixture.f.runtime_state.values()))
            primary = [x for x in journal['nativeEntry']['childObservations'] if x['mode']=='--run']
            self.assertEqual(len(primary), 1)
            self.assertEqual(primary[0]['journalMerge'], 'REJECTED' if process_fault=='merge' else 'ACCEPTED')
            if process_fault!='merge':
                self.assertEqual(journal['authClient']['authStage'], scenario['stage'])
                self.assertEqual(journal['authClient']['failureCategory'], scenario['category'])
                self.assertTrue(journal['authClient']['sessionClosed'])
                self.assertEqual(journal['authClient']['residuals'], [])
            for path in fixture.root.iterdir():
                self.assertNotIn(b'PRIVATE_SENTINEL', path.read_bytes())
            return
        if scenario['kind'] == 'handoff':
            self.assertTrue(observed[0]['authenticated'])
            self.assertEqual(observed[0]['failureStage'], 'PAYMENT_HANDOFF_INTENT')
            self.assertEqual(observed[0]['failureCode'], 'ADAPTER_REFUSED_OR_UNKNOWN')
            self.assertFalse(final['paymentObserved'] or final['paymentReadyForAcceptance'] or final['authProofReady'])
            self.assertFalse(work['paymentObserved'])
            self.assertFalse(journal.get('payment', {}).get('enableIntent', False))
            self.assertFalse(any(fixture.f.runtime_state.values()))
            if process_fault:
                self.assertFalse(journal['authProofAccepted'])
                self.assertIsNone(final['childResultSha256'])
                self.assertIn('AUTH_OUTCOME_UNKNOWN', final['residuals'])
            else:
                self.assertTrue(final['authenticationObserved'])
                self.assertTrue(journal['authProofAccepted'])
                self.assertRegex(final['childResultSha256'], '^[a-f0-9]{64}$')
            primary = [x for x in journal['nativeEntry']['childObservations'] if x['mode'] == '--run']
            self.assertEqual(len(primary), 1)
            self.assertEqual(primary[0]['journalMerge'], 'REJECTED' if process_fault == 'merge' else 'ACCEPTED')
            if process_fault != 'merge':
                self.assertEqual(journal['authClient']['failureStage'], 'PAYMENT_HANDOFF_INTENT')
                self.assertTrue(journal['authClient']['sessionClosed'])
                self.assertEqual(journal['authClient']['residuals'], [])
            return
        self.assertEqual(observed[0]['authenticated'], success)
        auth = journal['authClient']
        self.assertEqual(auth['authenticated'], success)
        self.assertEqual(auth['phase'], 'CLOSEOUT_FINISHED')
        self.assertEqual(auth['residuals'], [])
        self.assertTrue(auth['sessionClosed'])
        self.assertEqual(journal['authProofAccepted'], success)
        self.assertEqual(final['authenticationObserved'], success)
        self.assertEqual(final['paymentObserved'], success and not auth_only)
        self.assertEqual(work['paymentObserved'], success and not auth_only)
        self.assertFalse(final['authProofReady'] or final['paymentReadyForAcceptance'])
        self.assertFalse(any(fixture.f.runtime_state.values()))
        self.assertNotIn('childResultSha256', work)
        self.assertTrue(journal['payment']['endpointDisabled'])
        self.assertTrue(journal['payment']['bridgeClosed'])
        self.assertEqual(journal['payment']['residuals'], [])
        if success:
            self.assertEqual(final['status'], 'ENTRY_CLOSED')
            self.assertEqual(final['residuals'], [])
            self.assertRegex(final['childResultSha256'], '^[a-f0-9]{64}$')
            self.assertEqual(journal['payment']['outcome'], 'NOT_OBSERVED' if auth_only else 'APPLICATION_SETTLED')
            if auth_only:self.assertFalse(journal['payment']['enableIntent'])
            self.assertNotIn('failureCode', auth)
        else:
            self.assertEqual(final['status'], 'ENTRY_CONTAINMENT_UNCONFIRMED')
            self.assertEqual(final['residuals'], ['AUTH_OUTCOME_UNKNOWN'])
            self.assertIsNone(final['childResultSha256'])
            self.assertFalse(journal['payment']['enableIntent'])
            self.assertEqual(journal['payment']['outcome'], 'NOT_OBSERVED')
            if scenario['kind'] in {'localId', 'missing-token', 'token'}:
                self.assertEqual((auth['failureCode'], auth['authStage'], auth['failureCategory'],
                                  auth['httpStatus'], auth['responseValidationCode']),
                                 ('SIGN_EXCHANGE_REFUSED', 'EXCHANGE', 'RESPONSE_VALIDATION', None,
                                  'EXCHANGE_RESPONSE_MISMATCH'))
                self.assertEqual(auth['failureStage'], 'TOKEN_INTENT')
            elif scenario['kind'] == 'ap2':
                self.assertEqual(auth['failureStage'], 'RUNTIME_AUTH_INTENT')
                self.assertEqual(auth['failureCode'], 'AUTH_RUNTIME_REFUSED' if scenario['fault']=='runtime-http' else 'AUTHENTICATION_REFUSED')
                self.assertEqual(auth['authStage'], scenario['stage'])
                self.assertEqual(auth['failureCategory'], scenario['category'])
                self.assertEqual(auth['httpStatus'], 403 if scenario['category']=='HTTP' else None)
                self.assertEqual(auth.get('responseValidationCode'), scenario.get('validation'))
            else:
                self.assertEqual(auth['failureStage'], 'RUNTIME_AUTH_INTENT')
                self.assertEqual(auth['failureCode'], {'claim': 'TOKEN_CLAIMS_DRIFT',
                    'time': 'TOKEN_TIME', 'runtime': 'AUTH_RUNTIME_REFUSED', 'job': 'EXACT_JOB_READBACK'}[scenario['kind']])
                self.assertEqual(auth['authStage'], 'AUTH_RUNTIME_READ' if scenario['kind'] in {'runtime','job'} else 'AUTH_TOKEN_CHECK')
                self.assertEqual(auth['failureCategory'], 'HTTP' if scenario['kind']=='runtime' else 'RESPONSE_VALIDATION')
                self.assertEqual(auth.get('responseValidationCode'), {'claim':'CLAIMS_MISMATCH','time':'TOKEN_TIME','runtime':None,'job':'JOB_MISMATCH'}[scenario['kind']])
        observations = journal['nativeEntry']['childObservations']
        self.assertTrue(all(x['journalMerge'] == 'ACCEPTED' for x in observations))
        self.assertEqual(sum(x['mode'] == '--run' for x in observations), 1)
        if success:
            # The successful sequence already closes authentication. The handoff,
            # main coordinator closeout and independent closeout each read it back.
            self.assertEqual([x['mode'] for x in observations],
                             ['--payment-preflight', '--run', '--readback', '--readback', '--readback'])
            self.assertTrue(all(x['processOutcome'] == 'RETURNED' and x['code'] == 'NONE'
                                for x in observations))
            self.assertTrue(auth['closeoutAttempted'])
            for name in ('closeout.json', 'independent-closeout.json'):
                self.assertEqual(read(fixture.root/name), {'operationId': fixture.f.p['operationId']})
        else:
            self.assertTrue(any(x['mode'] == '--closeout' for x in observations))
        for path in fixture.root.iterdir():
            self.assertNotIn(b'header.', path.read_bytes())

    def test_aq1_success_stops_after_authentication_and_closes_independently(self):
        self.ec1_completed({'kind':'documented'},success=True,auth_only=True)

    def test_aq1_successful_child_lost_output_never_becomes_parent_proof(self):
        for fault in ('lost','timeout','exit','interruption','merge'):
            with self.subTest(fault=fault):
                self.ec1_completed({'kind':'documented'},success=True,auth_only=True,process_fault=fault)

    def test_aq1_diagnostic_failure_and_lost_output_matrix(self):
        for fault in (None,'lost','timeout','exit','interruption','merge'):
            with self.subTest(fault=fault):
                self.ec1_completed({'kind':'ap2','fault':'runtime-json','stage':'AUTH_RUNTIME_READ',
                                    'category':'RESPONSE_VALIDATION','validation':'JSON_PARSE'},
                                   auth_only=True,process_fault=fault)

    def test_ap2_actual_transport_client_child_parent_and_cleanup_failure_matrix(self, auth_only=False):
        cases = [
            ('lookup-transport','AUTH_IDENTITY_READ','TRANSPORT',None),
            ('lookup-http','AUTH_IDENTITY_READ','HTTP',None),
            ('lookup-json','AUTH_IDENTITY_READ','RESPONSE_VALIDATION','JSON_PARSE'),
            ('lookup-null','AUTH_IDENTITY_READ','RESPONSE_VALIDATION','RESPONSE_SHAPE'),
            ('lookup-identity','AUTH_IDENTITY_CHECK','RESPONSE_VALIDATION','IDENTITY_MISMATCH'),
            ('lookup-claims','AUTH_IDENTITY_READ','RESPONSE_VALIDATION','JSON_PARSE'),
            ('token-json','AUTH_TOKEN_DECODE','RESPONSE_VALIDATION','JSON_PARSE'),
            ('runtime-transport','AUTH_RUNTIME_READ','TRANSPORT',None),
            ('runtime-timeout','AUTH_RUNTIME_READ','TIMEOUT',None),
            ('runtime-read','AUTH_RUNTIME_READ','TRANSPORT',None),
            ('runtime-decode','AUTH_RUNTIME_READ','RESPONSE_VALIDATION','TEXT_DECODE'),
            ('runtime-bytes','AUTH_RUNTIME_READ','RESPONSE_VALIDATION','BODY_BOUND'),
            ('runtime-json','AUTH_RUNTIME_READ','RESPONSE_VALIDATION','JSON_PARSE'),
            ('runtime-http','AUTH_RUNTIME_READ','HTTP',None),
        ]
        for fault, stage, category, validation in cases:
            with self.subTest(fault=fault):
                self.ec1_completed({'kind':'ap2','fault':fault,'stage':stage,
                                    'category':category,'validation':validation},auth_only=auth_only)

    def test_aq1_actual_authentication_failure_matrix(self):
        self.test_ap2_actual_transport_client_child_parent_and_cleanup_failure_matrix(auth_only=True)

    def test_ap2_runtime_diagnostics_survive_lost_output_but_never_create_proof(self):
        for fault in ['lost', 'timeout', 'exit', 'interruption', 'merge']:
            with self.subTest(fault=fault):
                self.ec1_completed({'kind':'ap2','fault':'runtime-json','stage':'AUTH_RUNTIME_READ',
                                    'category':'RESPONSE_VALIDATION','validation':'JSON_PARSE'}, process_fault=fault)

    def test_ec1_documented_response_and_optional_identity_reach_authenticated_payment(self):
        for kind in ('documented', 'matching'):
            with self.subTest(kind=kind):
                self.ec1_completed({'kind': kind}, success=True)

    def test_ec1_invalid_exchange_fields_stop_before_authentication_and_payment(self):
        cases = ([{'kind': 'localId', 'value': value} for value in ('PRIVATE_SENTINEL', None, 7)] +
                 [{'kind': 'missing-token'}] +
                 [{'kind': 'token', 'value': value} for value in (None, 7, '')])
        for scenario in cases:
            with self.subTest(scenario=scenario):
                self.ec1_completed(scenario)

    def test_ec1_token_identity_time_and_runtime_failures_never_reach_payment(self):
        cases = ([{'kind': 'claim', 'field': field, 'value': value} for field, value in
                  (('sub', 'PRIVATE_SENTINEL'), ('tenantId', 'PRIVATE_SENTINEL'),
                   ('role', 'PRIVATE_SENTINEL'), ('testOnly', False),
                   ('iss', 'PRIVATE_SENTINEL'), ('aud', 'PRIVATE_SENTINEL'))] +
                 [{'kind': 'time', 'field': 'iat', 'offset': 60},
                  {'kind': 'time', 'field': 'exp', 'offset': -1},
                  {'kind': 'claim', 'field': 'sub', 'value': 'PRIVATE_SENTINEL', 'matchingLocalId': True},
                  {'kind': 'runtime', 'status': 401}, {'kind': 'runtime', 'status': 403},
                  {'kind': 'job'}])
        for scenario in cases:
            with self.subTest(scenario=scenario):
                self.ec1_completed(scenario)

    def test_ap1_payment_handoff_refusal_preserves_authentication_but_not_payment(self):
        self.ec1_completed({'kind': 'handoff'})

    def test_ap1_payment_boundary_lost_output_timeout_exit_interruption_merge_fail_closed(self):
        for fault in ('lost', 'timeout', 'exit', 'interruption', 'merge'):
            with self.subTest(fault=fault):
                self.ec1_completed({'kind': 'handoff'}, process_fault=fault)

    def test_previous_schema_reproduces_the_observed_evidence_loss(self):
        import handoff
        previous = handoff.old.AUTH_FIELDS - {'authStage','failureCategory','httpStatus'}
        with patch.object(handoff.old,'AUTH_FIELDS',previous):
            _, _, final, journal, before = self.completed('auth_sign_http403')
        self.assertEqual(before[0]['authStage'],'SIGN')
        self.assertNotIn('authClient',journal)
        self.assertEqual(final['residuals'],['ACCOUNT_SESSION','AUTH_OUTCOME_UNKNOWN','AUTH_REVOKE','PAYMENT_ENDPOINT_UNCONFIRMED'])
        observations=journal['nativeEntry']['childObservations']
        self.assertEqual(next(x for x in observations if x['mode']=='--run')['journalMerge'],'REJECTED')
        self.assertEqual(journal['failure'],'LOCAL_ADAPTER_OR_SOURCE_STOP')

    def test_early_refusals_retain_stage_and_cleanup_cannot_replace_primary(self):
        for scenario, code in [('owner_refused','OWNER_DRIFT'),
                               ('db_connect_refused','NATIVE_IO_TIMEOUT'), ('db_tls_refused','TLS_REQUIRED'),
                               ('db_preflight_refused','DATABASE_PREFLIGHT')]:
            with self.subTest(scenario=scenario):
                _, _, final, journal, _ = self.completed(scenario)
                observations=journal['nativeEntry']['childObservations']
                primary=next(x for x in observations if x['mode']=='--run')
                self.assertEqual((primary['stage'],primary['code'],primary['processOutcome']),
                                 ('CLIENT_BINDING',code,'REFUSED'))
                self.assertEqual(primary['journalMerge'],'ABSENT')
                self.assertIn('ACCOUNT_SESSION',final['residuals'])
                self.assertIn('AUTH_OUTCOME_UNKNOWN',final['residuals'])
                self.assertFalse(final['paymentObserved'])
                self.assertTrue(any(x['mode']=='--closeout' for x in observations))
                self.assertEqual(observations[1],primary)

    def test_authority_reservation_and_sequence_refusals_survive_parent(self):
        for scenario,stage in [('authority_refused','AUTHORITY'),('reservation_refused','RESERVATION'),
                               ('sequence_start_refused','AUTH_SEQUENCE')]:
            with self.subTest(scenario=scenario):
                _, _, final, journal, _ = self.completed(scenario)
                primary=next(x for x in journal['nativeEntry']['childObservations'] if x['mode']=='--run')
                self.assertEqual(primary['stage'],stage)
                self.assertEqual(primary['processOutcome'],'REFUSED')
                self.assertIn(primary['journalMerge'],{'ABSENT','REJECTED'})
                self.assertFalse(final['authenticationObserved'])
                self.assertFalse(final['paymentObserved'])
                self.assertIn('AUTH_OUTCOME_UNKNOWN',final['residuals'])

    def test_result_serialization_refusal_is_retained_without_runtime_activation(self):
        fixture, _, final, journal, _ = self.completed('result_serialization_refused')
        self.assertFalse(journal['authAttempted'])
        self.assertFalse(any(fixture.f.runtime_state.values()))
        primary=journal['nativeEntry']['childObservations'][0]
        self.assertEqual((primary['stage'],primary['code'],primary['processOutcome']),
                         ('RESULT','UNCLASSIFIED','REFUSED'))
        self.assertEqual(primary['journalMerge'],'ACCEPTED')
        self.assertEqual(len(journal['nativeEntry']['childObservations']),1)
        self.assertFalse(final['paymentObserved'])

    def test_main_refusal_and_cleanup_failure_keep_distinct_safe_observations(self):
        _, _, final, journal, _ = self.completed('main_and_cleanup_refused')
        observations=journal['nativeEntry']['childObservations']
        main=next(x for x in observations if x['mode']=='--run')
        self.assertEqual(main['stage'],'CLIENT_BINDING')
        self.assertEqual(main['code'],'OWNER_DRIFT')
        cleanup=[x for x in observations if x['mode']=='--closeout']
        self.assertTrue(cleanup)
        self.assertTrue(all(x['processOutcome']=='REFUSED' for x in cleanup))
        self.assertIn('ACCOUNT_SESSION',final['residuals'])

    def test_valid_auth_intent_survives_lost_or_untrusted_process_output(self):
        outputs=['', 'not-json', 'null', '{"status":NaN}', 'x'*8193,
                 '{"status":"NATIVE_CHILD_REFUSED_OR_UNCONFIRMED","stage":"INPUT","stage":"RESULT","code":"UNCLASSIFIED"}',
                 json.dumps({'status':'NATIVE_CHILD_REFUSED_OR_UNCONFIRMED','stage':'RESULT',
                             'code':'UNCLASSIFIED','message':self.PRIVATE})]
        for out in outputs:
            with self.subTest(length=len(out)):
                def alter(io,cap,fixture):
                    child=io.child
                    def invoke(argv,**kwargs):
                        result=child(argv,**kwargs)
                        if argv[2]=='--run':
                            return subprocess.CompletedProcess(argv,2,out,'')
                        return result
                    io.child=invoke
                _, _, final, journal, _ = self.completed('auth_sign_http403',mutate_io=alter)
                self.assertEqual(journal['authClient']['authStage'],'SIGN')
                primary=next(x for x in journal['nativeEntry']['childObservations'] if x['mode']=='--run')
                self.assertEqual(primary['code'],'CHILD_OUTPUT')
                self.assertEqual(primary['journalMerge'],'ACCEPTED')
                self.assertEqual(final['residuals'],['AUTH_OUTCOME_UNKNOWN'])

    def test_timeout_and_exit_preserve_committed_child_state_without_retry(self):
        for kind in ('timeout','exit'):
            def alter(io,cap,fixture):
                child=io.child
                def invoke(argv,**kwargs):
                    result=child(argv,**kwargs)
                    if argv[2]=='--run':
                        if kind=='timeout':raise subprocess.TimeoutExpired(argv,1,output=self.PRIVATE)
                        raise RuntimeError(self.PRIVATE)
                    return result
                io.child=invoke
            _, _, final, journal, _ = self.completed('auth_sign_http403',mutate_io=alter)
            self.assertEqual(journal['authClient']['authStage'],'SIGN')
            primary=next(x for x in journal['nativeEntry']['childObservations'] if x['mode']=='--run')
            self.assertEqual(primary['processOutcome'],'TIMEOUT' if kind=='timeout' else 'EXIT_UNKNOWN')
            self.assertEqual(primary['journalMerge'],'ACCEPTED')
            self.assertEqual(sum(x['mode']=='--run' for x in journal['nativeEntry']['childObservations']),1)
            self.assertEqual(final['residuals'],['AUTH_OUTCOME_UNKNOWN'])

    def test_observations_use_actual_approved_child_limit_and_reject_replay(self):
        import handoff
        h=object.__new__(handoff.Handoff)
        h.cap=SimpleNamespace(e={'limits':{'child':8}})
        h.coordinator=SimpleNamespace(j={'nativeEntry':{'calls':{'child':0}}})
        h.cap.coordinator=h.coordinator
        for call in range(1,9):
            h.coordinator.j['nativeEntry']['calls']['child']=call
            h._record_child_observation({'childCall':call,'mode':'--readback','stage':'RESULT','code':'NONE',
                                         'processOutcome':'RETURNED','journalMerge':'ACCEPTED'})
        self.assertEqual(len(h.coordinator.j['nativeEntry']['childObservations']),8)
        with self.assertRaisesRegex(Stop,'CHILD_OBSERVATION_LIMIT'):
            h._record_child_observation(h.coordinator.j['nativeEntry']['childObservations'][-1])
        h.cap.e['limits']['child']=2
        with self.assertRaisesRegex(Stop,'CHILD_OBSERVATION_SCOPE'):
            h._record_child_observation(h.coordinator.j['nativeEntry']['childObservations'][-1])


if __name__=='__main__':unittest.main()


class CT4TimingTests(unittest.TestCase):
    def controller(self, remaining=2000, owned=None):
        obj=object.__new__(entry.Coordinator)
        clock={'wall':1000.,'mono':0.}
        obj.clock=lambda:clock['wall'];obj.monotonic=lambda:clock['mono']
        obj.last=1000.;obj.last_monotonic=0.;obj.abort=False
        obj.times={'cutoff':1000.+remaining,'workEnd':1000.+remaining,'cleanupEnd':5000.}
        obj.child_monotonic_end=remaining
        obj.forward_end=obj.times['workEnd'];obj.work_monotonic_end=remaining
        # This focused harness exercises the original settling policy; full
        # version2 transition admission is covered by the assembled BR2 tests.
        obj.cap=SimpleNamespace(e={'version':1},mode='run',gate=lambda cleanup=False:None)
        obj.j={'iamOwned':['lookup','signing'] if owned is None else owned}
        obj.mutation_admitted=False;obj.settling_attempted=False
        obj.identity_pending=None;obj.identity_transitions_used=set()
        calls=[]
        obj.runtime=SimpleNamespace(change=lambda *a,**kw:calls.append('change'))
        obj.access=SimpleNamespace(stage_a=lambda:calls.append(('stage_a',clock['mono'])))
        def pause(seconds):clock['mono']+=seconds;clock['wall']+=seconds
        obj.pause=pause
        return obj,clock,calls

    def test_actual_invoke_waits_before_prediction_once(self):
        c,t,calls=self.controller()
        c.invoke('change',owner=c.runtime)
        c.invoke('stage_a',owner=c.access)
        self.assertEqual(calls,['change',('stage_a',420.)])
        with self.assertRaisesRegex(entry.c.Stop,'ALREADY_ATTEMPTED'):
            c.invoke('stage_a',owner=c.access)
        self.assertEqual(len(calls),2)

    def test_admission_before_mutation_and_before_wait(self):
        for remaining in (0,1379.999):
            c,t,calls=self.controller(remaining)
            with self.assertRaisesRegex(entry.c.Stop,'DEADLINE'):
                c.invoke('change',owner=c.runtime)
            self.assertFalse(calls)
        c,t,calls=self.controller(1400)
        c.invoke('change',owner=c.runtime);t['mono']=21
        with self.assertRaisesRegex(entry.c.Stop,'DEADLINE'):
            c.invoke('stage_a',owner=c.access)
        self.assertEqual(calls,['change'])

    def test_exact_boundary_and_owned_bindings(self):
        c,t,calls=self.controller(1380)
        c.invoke('stage_a',owner=c.access)
        self.assertEqual(calls,[('stage_a',420.)])
        for owned in ([],['lookup'],['signing'],['lookup','foreign'],['signing','lookup']):
            c,t,calls=self.controller(owned=owned)
            with self.assertRaisesRegex(entry.c.Stop,'IAM_READBACK'):
                c.invoke('stage_a',owner=c.access)
            self.assertFalse(calls)

    def test_freeze_rollback_nonfinite_and_interruption(self):
        for mode in ('freeze','rollback','nan','wall_rollback','interrupt','deadline'):
            with self.subTest(mode=mode):
                c,t,calls=self.controller()
                def pause(seconds):
                    if mode=='rollback':t['mono']-=1
                    elif mode=='nan':t['mono']=float('nan')
                    elif mode=='wall_rollback':t['mono']+=1;t['wall']-=1
                    elif mode=='interrupt':t['mono']+=1;c.abort=True
                    elif mode=='deadline':t['mono']=2100
                c.pause=pause
                with self.assertRaises(entry.c.Stop):c.invoke('stage_a',owner=c.access)
                self.assertFalse(calls)
                # Existing cleanup must run even after monotonic failure or interruption.
                t['wall']=1000.;c.last=1000.
                c.invoke('change',owner=c.runtime,cleanup=True)
                self.assertEqual(calls,['change'])

    def test_early_wakeup_does_not_shorten_wait(self):
        c,t,calls=self.controller()
        def pause(seconds):t['mono']+=seconds/2 if seconds>.01 else seconds
        c.pause=pause;c.invoke('stage_a',owner=c.access)
        self.assertEqual(calls,[('stage_a',420.)])

    def test_wall_and_monotonic_horizons_both_enforced(self):
        for field in ('wall','mono'):
            c,t,calls=self.controller(1400);t[field]+=21
            with self.assertRaisesRegex(entry.c.Stop,'DEADLINE'):c.invoke('stage_a',owner=c.access)
            self.assertFalse(calls)

    def test_actual_connected_interruption_closes_without_auth_or_browser(self):
        f=ConnectedEntryTests();f.setUp(timing=True);self.addCleanup(f.doCleanups)
        original=entry.Coordinator.settle_bindings
        def interrupted(controller):
            def pause(seconds):controller.abort=True;controller.monotonic=lambda:1.
            controller.pause=pause
            return original(controller)
        with patch.object(entry.Coordinator,'settle_bindings',interrupted):r=f.run_entry()
        j=read(f.root/'journal.json')
        self.assertFalse(j['authAttempted']);self.assertFalse(j['keyCreateAttempted'])
        self.assertEqual(j['failure'],'INTERRUPTED')
        self.assertFalse(f.f.transport.bindings);self.assertFalse(any(f.f.runtime_state.values()))
        self.assertFalse(r['paymentObserved'])
        self.assertEqual(r['residuals'],[])
        closed=f.run_entry('closeout')
        self.assertTrue(closed['privateInputsAbsent']);self.assertEqual(closed['residuals'],[])

    def test_killed_native_worker_during_wait_allows_independent_closeout(self):
        import signal,select
        f=ConnectedEntryTests();f.setUp(timing=True);self.addCleanup(f.doCleanups)
        rd,wr=os.pipe();pid=os.fork()
        if pid==0:
            os.close(rd)
            original=entry.Coordinator.settle_bindings
            def waiting(controller):
                sent=False
                def pause(seconds):
                    nonlocal sent
                    if not sent:
                        state={'runtime':[[list(k),v] for k,v in f.f.runtime_state.items()],
                               'bindings':sorted(f.f.transport.bindings)}
                        os.write(wr,json.dumps(state).encode()+b'\n');sent=True
                    time.sleep(seconds)
                controller.pause=pause
                controller.monotonic=time.monotonic
                controller.last_monotonic=time.monotonic()
                controller.work_monotonic_end=controller.last_monotonic+1900
                controller.child_monotonic_end=controller.last_monotonic+1800
                return original(controller)
            try:
                with patch.object(entry.Coordinator,'settle_bindings',waiting):f.run_entry()
            finally:os._exit(2)
        os.close(wr)
        try:
            self.assertTrue(select.select([rd],[],[],10)[0],'worker did not enter real wait')
            state=json.loads(os.read(rd,16384))
            with self.assertRaisesRegex(Exception,'OVERLAP|LOCK|CONCURRENT|ATTEMPT|ALREADY'):
                f.run_entry()
            os.kill(pid,signal.SIGKILL);_,status=os.waitpid(pid,0);pid=None
            self.assertTrue(os.WIFSIGNALED(status))
            f.f.runtime_state.clear();f.f.runtime_state.update({tuple(k):v for k,v in state['runtime']})
            f.f.transport.bindings=set(state['bindings'])
            journal=read(f.root/'journal.json')
            self.assertFalse(journal['authAttempted']);self.assertFalse(journal['keyCreateAttempted'])
            closed=f.run_entry('closeout')
            self.assertEqual(closed['residuals'],[],closed)
            self.assertTrue(closed['privateInputsAbsent'])
            self.assertFalse(any(f.f.runtime_state.values()));self.assertFalse(f.f.transport.bindings)
        finally:
            os.close(rd)
            if pid is not None:
                try:os.kill(pid,signal.SIGKILL)
                except ProcessLookupError:pass
                os.waitpid(pid,0)


    def test_actual_payment_deadline_refuses_before_first_mutation(self):
        f=ConnectedEntryTests();f.setUp(timing=True);self.addCleanup(f.doCleanups)
        f.e['payment']['workEnd']=datetime.datetime.fromtimestamp(time.time()+1300,datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')
        f.e['qualification']['scopeSha256']=a.digest({k:f.e[k] for k in ('plan','target','database','resources','limits','payment')})
        f.seal();r=f.run_entry();j=read(f.root/'journal.json')
        self.assertEqual(j['failure'],'DEADLINE')
        self.assertFalse(j['runtimeOwned']);self.assertFalse(j['iamAttempted'])
        self.assertFalse(j['authAttempted']);self.assertEqual(f.settle_sleeps,[])
        closed=f.run_entry('closeout')
        self.assertTrue(closed['privateInputsAbsent']);self.assertEqual(closed['residuals'],[])


class CT5DeadlineTests(unittest.TestCase):
    controller = CT4TimingTests.controller
    def test_child_cutoff_refuses_before_mutation_and_cleanup_remains_available(self):
        for remaining in (0, 1379.999):
            c,t,calls=self.controller(2500)
            c.times['cutoff']=1000+remaining;c.child_monotonic_end=remaining
            with self.assertRaisesRegex(entry.c.Stop,'START_CUTOFF'):
                c.invoke('change',owner=c.runtime)
            self.assertEqual(calls,[])
            t['wall']=1000+remaining+1
            c.invoke('change',owner=c.runtime,cleanup=True)
            self.assertEqual(calls,['change'])

    def test_child_horizon_rechecked_before_and_after_wait(self):
        for field in ('wall','mono'):
            c,t,calls=self.controller(2500)
            c.times['cutoff']=2400;c.child_monotonic_end=1400
            c.invoke('change',owner=c.runtime);t[field]+=21
            with self.assertRaisesRegex(entry.c.Stop,'START_CUTOFF'):
                c.invoke('stage_a',owner=c.access)
            self.assertEqual(calls,['change'])
        c,t,calls=self.controller(2500)
        c.times['cutoff']=2380;c.child_monotonic_end=1380
        # Force a final-sleep overshoot, retaining more than enough work time.
        def overshoot(seconds):
            advance=seconds+(1 if t['mono']==419 else 0)
            t['wall']+=advance;t['mono']+=advance
        c.pause=overshoot
        with self.assertRaisesRegex(entry.c.Stop,'START_CUTOFF'):
            c.invoke('stage_a',owner=c.access)
        self.assertEqual(calls,[])

    def test_r54_schedule_refused_before_any_forward_intent(self):
        f=ConnectedEntryTests();f.setUp(timing=True);self.addCleanup(f.doCleanups)
        f.e['plan']['window']['cutoff']=datetime.datetime.fromtimestamp(time.time()+180,datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')
        f.e['qualification']['scopeSha256']=a.digest({k:f.e[k] for k in ('plan','target','database','resources','limits','payment')})
        f.seal();r=f.run_entry();j=read(f.root/'journal.json')
        self.assertEqual(j['failure'],'START_CUTOFF')
        self.assertFalse(j['runtimeOwned']);self.assertFalse(j['iamAttempted'])
        self.assertFalse(j['authAttempted']);self.assertFalse(j['keyCreateAttempted'])
        self.assertEqual(f.settle_sleeps,[])
        closed=f.run_entry('closeout')
        self.assertTrue(closed['privateInputsAbsent']);self.assertEqual(closed['residuals'],[])

    def test_actual_node_authority_after_parent_wait_and_delayed_child(self):
        c,t,calls=self.controller(2500)
        c.times['cutoff']=2800;c.child_monotonic_end=1800
        c.invoke('stage_a',owner=c.access)
        self.assertEqual(calls,[('stage_a',420.)])
        source=a.APP/'p08-coordinator-auth-local-20261031/source'
        prelude=(source/'test_client.mjs').read_text().split("test('source-pinned",1)[0]
        harness=prelude+"""
const cleanup=[];try {
 const f=fixture({after:fn=>cleanup.push(fn)}), start=Date.parse(f.plan.window.start);
 f.plan.window={start:iso(start),cutoff:iso(start+1800000),workEnd:iso(start+2500000),cleanupEnd:iso(start+2700000),purgeEnd:iso(start+2800000)};
 f.approval.planSha256=planHash(f.plan);
 const j=JSON.parse(readFileSync(f.journalPath));j.planSha256=planHash(f.plan);writeFileSync(f.journalPath,JSON.stringify(j));
 f.clock.value=start+ELAPSED_MS;close(cap(f));
 f.clock.value=start+1800000;assert.throws(()=>cap(f),{code:'START_CUTOFF'});
 f.clock.value=start+1800001;close(cap(f,{mode:'closeout'}));
 console.log('ACTUAL_CHILD_AFTER_WAIT_PASS_CUTOFF_REFUSED_CLEANUP_ALLOWED');
}finally{for(const fn of cleanup)fn();}
""".replace('ELAPSED_MS',str(int(t['mono']*1000)))
        result=subprocess.run(['/Users/debynyhanbanks/.nvm/versions/node/v24.12.0/bin/node','--input-type=module'],input=harness,text=True,cwd=source,capture_output=True)
        self.assertEqual(result.returncode,0,result.stderr)
        self.assertIn('ACTUAL_CHILD_AFTER_WAIT_PASS',result.stdout)


class AQ1AuthorityRecoveryTests(unittest.TestCase):
    def fixture(self):
        f=ConnectedEntryTests();f.setUp(timing=True);self.addCleanup(f.doCleanups)
        f.e['purpose']='NATIVE_AUTH_QUALIFICATION_ONLY';f.seal();return f

    def test_aq1_external_decision_and_committed_source_are_exact(self):
        f=self.fixture();f.e['execution']='EXTERNAL'
        scope=a.digest({k:v for k,v in f.e.items() if k!='decision'})
        decision={'owner':'Debynyhan Banks','decision':'APPROVE_EXACT_P08_AUTH_QUALIFICATION',
                  'externalActionAuthorized':True,'operationId':f.e['plan']['operationId'],
                  'scopeSha256':scope,'sourceManifestSha256':f.e['sourceManifestSha256']}
        raw=json.dumps(decision).encode()
        f.e['decision']={'commit':'1'*40,'path':'APP013_P08_NATIVE_OPERATION_20261127.json','sha256':a.digest(raw)}
        reader=lambda repo,c,p:raw if repo==a.GOV else (a.BACKEND/p).read_bytes()
        # Fictional endpoint pins must first fail the real external validator.
        with self.assertRaisesRegex(Stop,'PAYMENT_ENDPOINT_PIN'):
            a.Capability(f.e,f.root,read_commit=reader)
        validate=a.validate_payment
        def synthetic_payment(envelope,times):
            self.assertEqual(envelope['execution'],'EXTERNAL')
            validate({**envelope,'execution':'PROOF_ONLY'},times)
        # Isolate exact external decision/source checks without introducing real private pins.
        # Current qualification receipt binding is exercised separately below.
        with patch.object(a,'validate_payment',side_effect=synthetic_payment), patch.object(a,'verify_payment_qualification') as qualified:
            cap=a.Capability(f.e,f.root,read_commit=reader)
            self.assertTrue(cap.external);self.assertEqual(cap.mode,'run');qualified.assert_called_once()
            for choice in ('APPROVE_EXACT_P08_CONNECTED_PAYMENT','APPROVE_EXACT_P08_NATIVE_PREFLIGHT_READ'):
                wrong=json.dumps({**decision,'decision':choice}).encode();f.e['decision']['sha256']=a.digest(wrong)
                with self.assertRaisesRegex(Stop,'EXACT_OWNER_APPROVAL'):
                    a.Capability(f.e,f.root,read_commit=lambda repo,c,p:wrong if repo==a.GOV else (a.BACKEND/p).read_bytes())
            f.e['decision']['sha256']=a.digest(raw)
            with self.assertRaisesRegex(Stop,'COMMITTED_SOURCE_MANIFEST'):
                a.Capability(f.e,f.root,read_commit=lambda repo,c,p:raw if repo==a.GOV else b'changed')
        self.assertEqual(f.calls,0)

    def test_aq1_current_qualification_lock_replay_and_drift_checks_remain(self):
        for method in ('test_payment_requires_matching_current_qualification_receipt',
                       'test_concurrent_entry_refuses_before_io','test_duplicate_attempt_never_replays',
                       'test_approval_and_qualification_and_resource_drift_before_io'):
            with self.subTest(method=method):
                f=self.fixture()
                cls=ConnectedEntryTests if method=='test_payment_requires_matching_current_qualification_receipt' else EntryTests
                getattr(cls,method)(f)

    def test_aq1_partial_setup_interruption_still_closes_independently(self):
        f=self.fixture();original=entry.Coordinator.settle_bindings
        def interrupt(controller):
            def pause(seconds):controller.abort=True;controller.monotonic=lambda:1.
            controller.pause=pause;return original(controller)
        with patch.object(entry.Coordinator,'settle_bindings',interrupt):work=f.run_entry()
        final=f.run_entry('closeout');j=read(f.root/'journal.json')
        self.assertEqual(j['failure'],'INTERRUPTED');self.assertFalse(j['authAttempted'])
        self.assertFalse(any(f.f.runtime_state.values()));self.assertFalse(f.f.transport.bindings)
        self.assertFalse(work['paymentObserved'] or final['authenticationObserved'])
        self.assertTrue(final['privateInputsAbsent']);self.assertEqual(final['residuals'],[])

    def test_aq1_expired_work_and_insufficient_cleanup_reserve_refuse(self):
        f=self.fixture()
        with self.assertRaises(Exception):entry.run_entry(f.path,io_factory=f.factory,clock=lambda:f.f.now+3000)
        self.assertEqual(f.calls,0)
        f.e['payment']['workEnd']=datetime.datetime.fromtimestamp(time.time()+1300,datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')
        f.e['qualification']['scopeSha256']=a.digest({k:f.e[k] for k in ('plan','target','database','resources','limits','payment')})
        f.seal();f.run_entry();j=read(f.root/'journal.json')
        self.assertEqual(j['failure'],'DEADLINE');self.assertFalse(j['runtimeOwned'])
        final=f.run_entry('closeout');self.assertTrue(final['privateInputsAbsent']);self.assertEqual(final['residuals'],[])

    def test_aq1_contradictory_payment_records_never_become_clean_authentication_proof(self):
        for field,value in [('enableIntent',True),('bridgeClosed',False),('outcome','APPLICATION_SETTLED')]:
            with self.subTest(field=field):
                f=self.fixture();f.run_entry();j=read(f.root/'journal.json')
                j['payment'][field]=value;(f.root/'journal.json').write_text(json.dumps(j))
                final=f.run_entry('closeout')
                self.assertEqual(final['status'],'ENTRY_CONTAINMENT_UNCONFIRMED')
                self.assertIn('AUTH_QUALIFICATION_PAYMENT_DRIFT',final['residuals'])
                self.assertFalse(final['authProofReady'] or final['paymentReadyForAcceptance'])
                self.assertTrue(final['privateInputsAbsent'])
                self.assertFalse(any(f.f.runtime_state.values()))
