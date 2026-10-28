import copy, datetime as dt, json, os, signal, socket, subprocess, sys, tempfile, unittest
from pathlib import Path
from unittest.mock import patch
import access_readiness as m

NOW = 1793196000

def fixture():
    op = '10000000-0000-4000-8000-000000000001'
    iso = lambda x: dt.datetime.fromtimestamp(NOW+x, dt.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')
    return {'mode':'LOCAL_ACCESS_MODEL_ONLY','externalActionAuthorized':False,'operationId':op,'projectNumber':'123456789012','keyId':'signmons-p08-'+op.replace('-',''),'serviceRetention':'RETAIN_IF_ENABLED','apiOnlyKeyApproved':True,'automaticRetryAllowed':False,'restrictions':copy.deepcopy(m.RESTRICTIONS),'window':{k:iso(v) for k,v in [('start',-10),('cutoff',30),('workEnd',100),('cleanupEnd',150),('purgeEnd',160)]}}

class Fake:
    def __init__(self, p):
        self.p = p; self.key = None; self.enabled = False; self.operations = {}; self.calls = []; self.fail = None; self.signal_at = None; self.signal_number = signal.SIGTERM; self.after = None; self.pending = 0; self.states = ['CAN_ACCESS']*5; self.tweak = None
    def operation(self, kind, value):
        name = 'operations/'+('akmf.fixture.' if kind != 'enable' else 'su-')+kind
        self.operations[name] = copy.deepcopy(value)
        return {'name':name}
    def __call__(self, req):
        self.calls.append(copy.deepcopy(req)); url=req['url']; method=req['method']; body=json.loads(req['body']) if req['body'] is not None else None
        if '/operations/' in url:
            kind='poll'; name='operations/'+url.rsplit('/operations/',1)[1]; value={'name':name, 'done':True, 'response':copy.deepcopy(self.operations[name])}
            if self.pending: self.pending-=1; value={'name':name}
        elif 'serviceusage.' in url:
            if method=='POST':
                kind='enable'; self.enabled=True; name='projects/'+self.p['projectNumber']+'/services/'+m.SERVICE
                value=self.operation(kind,{'@type':'type.googleapis.com/google.api.serviceusage.v1.EnableServiceResponse','service':{'name':name,'state':'ENABLED','config':{'name':m.SERVICE}}})
            else: kind='service_get';value={'name':'projects/'+self.p['projectNumber']+'/services/'+m.SERVICE,'state':'ENABLED' if self.enabled else 'DISABLED'}
        elif 'policytroubleshooter.' in url:
            kind='diagnostic'; value={'overallAccessState':self.states.pop(0),'allowPolicyExplanation':{'unsafe':'fixture-only-provider-secret'}}
        elif method=='POST':
            kind='create'; self.key={'name':'projects/'+self.p['projectNumber']+'/locations/global/keys/'+self.p['keyId'],'uid':'20000000-0000-4000-8000-000000000002','etag':'fixture+etag==','restrictions':copy.deepcopy(body['restrictions']),'displayName':body['displayName'],'keyString':'fixture-only-provider-secret'};value=self.operation(kind,self.key)
        elif method=='DELETE':
            kind='delete'; self.key['deleteTime']='2026-10-28T18:00:00Z'; self.key['etag']='deleted-etag';value=self.operation(kind,self.key)
        else:
            kind='key_get'; value=copy.deepcopy(self.key) if self.key else {'error':{'code':404,'status':'NOT_FOUND'}}
        if self.after: self.after(kind,self)
        if self.fail==kind: raise RuntimeError('fixture-only-provider-secret')
        if self.signal_at==kind:
            self.signal_at=None;os.kill(os.getpid(),self.signal_number)
        if self.tweak: value=self.tweak(kind,value)
        status=404 if kind=='key_get' and self.key is None else 200
        return {'httpStatus':status,'body':json.dumps(value)}

class Tests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.root=Path(self.temp.name)/'proof';self.p=fixture();self.fake=Fake(self.p);self.now=NOW
        self.adapter=m.RequestAdapter(self.p,self.fake)
    def tearDown(self): self.temp.cleanup()
    def controller(self,mode='run'): return m.Controller(self.p,self.adapter,self.root,clock=lambda:self.now,mode=mode,pause=lambda _:None)
    def run_model(self):
        # Fail closed if a supposedly isolated test tries real provider/credential resolution.
        with patch('socket.socket',side_effect=AssertionError('network forbidden')), patch('subprocess.Popen',side_effect=AssertionError('provider process forbidden')):
            return self.controller().run()
    def test_serialized_positive_lifecycle_and_privacy(self):
        r=self.run_model();self.assertEqual(r['status'],'LOCAL_ACCESS_MODEL_COMPLETE');self.assertEqual(r['residuals'],[]);self.assertTrue(r['fivePolicyDiagnosticsGranted']);self.assertFalse(r['lifecycleAccessQualified']);self.assertFalse(r['restorationQualified']);self.assertFalse(r['immediateGlobalKeyInvalidationProven'])
        self.assertEqual(r['serviceState'],'SERVICE_ENABLED_RETAINED');self.assertEqual(r['keyState'],'CONTROL_PLANE_DELETED')
        text=''.join(p.read_text() for p in self.root.iterdir());self.assertNotIn('fixture-only-provider-secret',text)
        creates=[x for x in self.fake.calls if x['method']=='POST' and '?keyId=' in x['url']];self.assertEqual(len(creates),1)
        self.assertEqual(json.loads(creates[0]['body']),{'displayName':'Signmons P08 '+self.p['operationId'],'restrictions':m.RESTRICTIONS})
        self.assertTrue(any('apikeys.googleapis.com/v2/operations/akmf.fixture.' in x['url'] for x in self.fake.calls));self.assertTrue(any('serviceusage.googleapis.com/v1/operations/su-' in x['url'] for x in self.fake.calls))
        deletes=[x for x in self.fake.calls if x['method']=='DELETE'];self.assertEqual(len(deletes),1);self.assertIn('?etag=fixture%2Betag%3D%3D',deletes[0]['url']);self.assertIsNone(deletes[0]['body'])
        diags=[json.loads(x['body'])['accessTuple'] for x in self.fake.calls if x['url'].startswith('https://policytroubleshooter.googleapis.com/')];self.assertEqual(len(diags),5);self.assertEqual(diags[0]['permission'],'firebaseauth.users.get');self.assertEqual(diags[-1]['permission'],'apikeys.keys.getKeyString');self.assertIn('receiveTime',diags[0]['conditionContext']['request'])
        self.assertFalse(any('keyString' in x['url'] or ':signBlob' in x['url'] or 'accounts:' in x['url'] or ':disable' in x['url'] for x in self.fake.calls))
    def test_environment_reuses_dynamic_required_name(self):
        names=m.expected_environment_names();self.assertEqual(len(names),19);self.assertIn('CUSTOMER_PAYMENT_RETURN_URL',names);self.assertNotIn('PORT',names)
    def test_preexisting_service_not_enabled_or_disabled(self):
        self.fake.enabled=True;r=self.run_model();self.assertEqual(r['serviceState'],'PREEXISTING_ENABLED');self.assertFalse(any(':enable' in x['url'] for x in self.fake.calls))
    def test_collision_never_adopted_or_deleted(self):
        self.fake.key={'existing':'other'};r=self.run_model();self.assertIn('COLLISION',r['failure']);self.assertFalse(any(x['method']=='DELETE' or '?keyId=' in x['url'] for x in self.fake.calls))
    def test_missing_service_state_refuses(self):
        self.fake.tweak=lambda k,v:{} if k=='service_get' else v;r=self.run_model();self.assertEqual(r['failure'],'SERVICE_SHAPE')
    def test_http_denial_is_not_absence(self):
        self.adapter.transport=lambda _: {'httpStatus':403,'body':json.dumps({'error':{'status':'PERMISSION_DENIED','message':'fixture-only-provider-secret'}})}
        r=self.run_model();self.assertEqual(r['failure'],'PROVIDER_REFUSED');self.assertEqual(len(self.fake.calls),0)
    def test_null_or_oversized_or_invalid_json(self):
        for response in [{'httpStatus':200,'body':'null'},{'httpStatus':200,'body':'{'},{'httpStatus':200,'body':'x'*65537},None]:
            with self.subTest(response=type(response).__name__):
                a=m.RequestAdapter(self.p,lambda _:response)
                with self.assertRaises(Exception):a.service_get()
    def test_diagnostic_unknown_and_denied_are_not_grants(self):
        self.fake.states=['CANNOT_ACCESS','UNKNOWN_INFO','UNKNOWN_CONDITIONAL','OVERALL_ACCESS_STATE_UNSPECIFIED','CAN_ACCESS'];r=self.run_model();self.assertFalse(r['fivePolicyDiagnosticsGranted']);self.assertEqual(len(r['diagnostics']),5)
    def test_missing_diagnostic_does_not_become_success(self):
        self.fake.tweak=lambda k,v:{} if k=='diagnostic' else v;r=self.run_model();self.assertEqual(r['failure'],'DIAGNOSTIC_SHAPE');self.assertEqual(r['keyState'],'CONTROL_PLANE_DELETED')
    def test_loss_after_create_is_unknown_no_adopt_no_delete(self):
        self.fake.fail='create';r=self.run_model();self.assertIn('KEY_CREATE_OUTCOME_UNKNOWN',r['residuals']);self.assertFalse(any(x['method']=='DELETE' for x in self.fake.calls))
    def test_loss_after_enable_reports_service_unknown(self):
        self.fake.fail='enable';r=self.run_model();self.assertIn('SERVICE_ENABLE_OUTCOME_UNKNOWN',r['residuals']);self.assertFalse(any('?keyId=' in x['url'] for x in self.fake.calls))
    def test_loss_after_delete_independent_readback_no_mutation_retry(self):
        self.fake.fail='delete';r=self.run_model();self.assertIn('KEY_DELETE_OUTCOME_UNKNOWN',r['residuals']);self.fake.fail=None;c=self.controller('closeout');self.assertEqual(c.closeout_only(),[]);self.assertEqual(sum(x['method']=='DELETE' for x in self.fake.calls),1)
    def test_unknown_create_independent_cleanup_never_adopts(self):
        self.fake.fail='create';self.run_model();self.fake.fail=None;c=self.controller('closeout');self.assertEqual(c.closeout_only(),['KEY_CREATE_OUTCOME_UNKNOWN']);self.assertFalse(any(x['method']=='DELETE' for x in self.fake.calls))
    def test_independent_cleanup_consumed_and_foreign_journal_refusal(self):
        self.run_model();c=self.controller('closeout');self.assertEqual(c.closeout_only(),[])
        with self.assertRaises(FileExistsError):self.controller('closeout').closeout_only()
    def test_operation_response_error_is_unknown_and_never_leaks(self):
        self.fake.tweak=lambda k,v:{**v,'error':{'message':'fixture-only-provider-secret'}} if k=='poll' else v;r=self.run_model();self.assertEqual(r['failure'],'OPERATION_FAILED');self.assertNotIn('fixture-only-provider-secret',json.dumps(r))
    def test_foreign_operation_refused_before_poll(self):
        self.fake.tweak=lambda k,v:{'name':'https://foreign.invalid/operations/bad'} if k=='create' else v;r=self.run_model();self.assertIn('OPERATION_SCOPE',r['failure']);self.assertIn('KEY_CREATE_OUTCOME_UNKNOWN',r['residuals'])
    def test_changed_operation_response_name_refused(self):
        self.fake.tweak=lambda k,v:{**v,'name':'operations/foreign'} if k=='poll' else v;r=self.run_model();self.assertEqual(r['failure'],'OPERATION_SHAPE')
    def test_bounded_pending_poll_never_retries_mutation(self):
        self.fake.pending=20;r=self.run_model();self.assertEqual(r['failure'],'POLL_LIMIT');self.assertEqual(sum(':enable' in x['url'] for x in self.fake.calls),1);self.assertEqual(sum('/operations/' in x['url'] for x in self.fake.calls),5)
    def test_completion_on_last_permitted_poll(self):
        self.fake.pending=4;r=self.run_model();self.assertEqual(r['status'],'LOCAL_ACCESS_MODEL_COMPLETE')
    def test_restriction_variants_fail_before_handoff(self):
        for variant in [{'apiTargets':[{'service':'identitytoolkit.googleapis.com'},{'service':'other.googleapis.com'}]},{**m.RESTRICTIONS,'browserKeyRestrictions':{}},{**m.RESTRICTIONS,'serverKeyRestrictions':{}}]:
            with self.subTest(variant=variant):
                p=fixture();fake=Fake(p);fake.tweak=lambda k,v:{**v,'restrictions':variant} if k=='poll' and v.get('response',{}).get('name','').endswith(p['keyId']) else v
                # Apply mutation to the actual nested provider Key payload.
                def tweak(k,v):
                    if k=='poll' and 'uid' in v.get('response',{}):v['response']['restrictions']=variant
                    return v
                fake.tweak=tweak
                with tempfile.TemporaryDirectory() as d:
                    r=m.Controller(p,m.RequestAdapter(p,fake),Path(d)/'proof',clock=lambda:NOW,pause=lambda _:None).run();self.assertEqual(r['failure'],'KEY_RESTRICTIONS');self.assertIsNone(r['handoff'])
    def test_foreign_key_or_uid_refuses(self):
        self.fake.tweak=lambda k,v:{**v,'response':{**v['response'],'name':'projects/other/locations/global/keys/bad'}} if k=='poll' and 'uid' in v.get('response',{}) else v;r=self.run_model();self.assertEqual(r['failure'],'KEY_IDENTITY')
    def test_etag_drift_cleanup_is_not_verified(self):
        def after(kind,fake):
            if kind=='diagnostic':fake.key['etag']='changed'
        self.fake.after=after;r=self.run_model();self.assertTrue(r['residuals']);self.assertFalse(any(x['method']=='DELETE' for x in self.fake.calls))
    def test_deadline_and_clock_rollback(self):
        def after(kind,fake):
            if kind=='create':self.now=NOW-1
        self.fake.after=after;r=self.run_model();self.assertEqual(r['failure'],'CLOCK_ROLLBACK');self.assertTrue(r['residuals'])
    def test_cleanup_deadline_refuses_delete(self):
        self.fake.after=lambda k,f:setattr(self,'now',NOW+151) if k=='diagnostic' else None;r=self.run_model();self.assertTrue(r['residuals']);self.assertFalse(any(x['method']=='DELETE' for x in self.fake.calls))
    def test_real_signal_matrix_at_every_mutation(self):
        for sig in [signal.SIGINT,signal.SIGTERM]:
            for stage in ['enable','create','delete']:
                with self.subTest(signal=sig,stage=stage),tempfile.TemporaryDirectory() as d:
                    p=fixture();fake=Fake(p);fake.signal_at=stage;fake.signal_number=sig;c=m.Controller(p,m.RequestAdapter(p,fake),Path(d)/'proof',clock=lambda:NOW,pause=lambda _:None);r=c.run()
                    if stage=='delete':self.assertEqual(r['keyState'],'CONTROL_PLANE_DELETED');self.assertEqual(r['residuals'],[])
                    else:self.assertTrue(r['residuals']);self.assertNotEqual(r['status'],'LOCAL_ACCESS_MODEL_COMPLETE')
    def test_plan_gates_before_provider(self):
        for field,value in [('mode','LIVE'),('externalActionAuthorized',True),('restrictions',{}),('apiOnlyKeyApproved',False),('keyId','foreign'),('serviceRetention','DISABLE_SHARED')]:
            p=fixture();p[field]=value
            with self.subTest(field=field),self.assertRaises(Exception):m.Controller(p,m.RequestAdapter(p,self.fake),self.root,clock=lambda:NOW,pause=lambda _:None)
        self.assertEqual(self.fake.calls,[])
    def test_expired_start(self):
        with self.assertRaises(m.Stop):m.Controller(self.p,self.adapter,self.root,clock=lambda:NOW+30,pause=lambda _:None)
    def test_native_transport_unbound(self):
        with self.assertRaises(m.Stop):m.RequestAdapter(self.p).key_create()
    def test_one_attempt_real_process_race(self):
        self.root.mkdir(mode=0o700)
        script='import access_readiness as m,sys;from pathlib import Path;m.reserve(Path(sys.argv[1]),{})'
        path=str(self.root/'race.json');env={**os.environ,'PYTHONDONTWRITEBYTECODE':'1'}
        procs=[subprocess.Popen([sys.executable,'-B','-c',script,path],stdout=subprocess.PIPE,stderr=subprocess.PIPE,env=env) for _ in range(2)]
        for p in procs:p.communicate(timeout=10)
        self.assertEqual(sorted(p.returncode for p in procs),[0,1])
    def test_retention_purge_reuses_existing_guard(self):
        (self.root/'auth').mkdir(mode=0o700,parents=True)
        for name in ['restore-plan.json','auth/auth-plan.json']:
            p=self.root/name;p.write_text('{}');p.chmod(0o600)
        keep=self.root/'keep';keep.write_text('unchanged');self.assertTrue(m.reuse.purge_plans(self.root));self.assertTrue(keep.exists())
    def test_retention_symlink_refusal(self):
        self.root.mkdir(mode=0o700);keep=self.root/'keep';keep.write_text('unchanged');(self.root/'restore-plan.json').symlink_to(keep)
        with self.assertRaises(m.Stop):m.reuse.purge_plans(self.root)
        self.assertEqual(keep.read_text(),'unchanged')

    def test_actual_request_timeout(self):
        c=self.controller();c.t['workEnd']=NOW+.03
        import time
        with self.assertRaises(m.Stop):c.invoke(lambda:time.sleep(2))
    def test_cleanup_after_start_cutoff(self):
        self.fake.fail='delete';self.run_model();self.fake.fail=None;self.now=NOW+50
        c=self.controller('closeout');self.assertEqual(c.closeout_only(),[])
        with self.assertRaises(m.Stop):c.run()
    def test_foreign_journal_refuses_independent_cleanup(self):
        self.run_model();p=self.root/'journal.json';v=json.loads(p.read_text());v['operationId']='foreign';p.write_text(json.dumps(v))
        with self.assertRaises(m.Stop):self.controller('closeout').closeout_only()
    def test_no_native_clients_in_cli(self):
        p=subprocess.run([sys.executable,'-B','access_readiness.py'],capture_output=True,text=True,timeout=10)
        self.assertEqual(p.returncode,2);self.assertEqual(p.stdout.strip(),'P08_ACCESS_REFUSED_UNBOUND')
    def test_source_drift_refusal(self):
        import shutil
        root=Path(self.temp.name)/'copy';shutil.copytree(m.ROOT,root,ignore=shutil.ignore_patterns('__pycache__'))
        (root/'access_readiness.py').write_text('changed')
        with self.assertRaises(m.Stop):m.check_sources(root)
    def test_synthetic_handoff_against_unchanged_auth_authority(self):
        r=self.run_model();root=m.ROOT/'reuse/auth';source=(root/'auth-controller.test.mjs').read_text();fixture_source=source[source.index('function fixture()'):source.index('\nfunction mock')]
        js="import assert from 'node:assert/strict';import {hash,authorize} from "+json.dumps((root/'auth-authority.mjs').as_uri())+";import {plan as bridgePlan} from "+json.dumps((root/'reuse/operator-bridge.mjs').as_uri())+";let serial=0;globalThis.fetch=()=>{throw Error('NETWORK_FORBIDDEN')};\n"+fixture_source+"\nconst f=fixture();f.p.exchange={keyResource:"+json.dumps(r['handoff']['keyResource'])+",keySha256:'a'.repeat(64)};f.refresh();assert(f.cap());f.p.exchange.keySha256=null;f.refresh();assert.throws(()=>f.cap());f.p.exchange={keyResource:'projects/foreign/locations/global/keys/foreign',keySha256:'a'.repeat(64)};f.refresh();assert.throws(()=>f.cap());console.log('SYNTHETIC_AUTHORITY_HANDOFF_PASSED');"
        out=subprocess.run(['node','--input-type=module','-'],input=js,text=True,capture_output=True,timeout=10)
        self.assertEqual(out.returncode,0,out.stderr);self.assertEqual(out.stdout.strip(),'SYNTHETIC_AUTHORITY_HANDOFF_PASSED')
    def test_poll_backoff_is_explicit_and_bounded(self):
        pauses=[];c=m.Controller(self.p,self.adapter,self.root,clock=lambda:self.now,pause=pauses.append);r=c.run();self.assertEqual(r['status'],'LOCAL_ACCESS_MODEL_COMPLETE');self.assertEqual(pauses,[10,10,10])
    def test_real_api_fractional_deleted_timestamp(self):
        def tweak(kind,value):
            if kind=='key_get' and value.get('deleteTime'):value['deleteTime']='2026-10-28T18:00:00.123456789Z'
            return value
        self.fake.tweak=tweak;r=self.run_model();self.assertEqual(r['keyState'],'CONTROL_PLANE_DELETED');self.assertEqual(r['residuals'],[])
    def test_journal_failure_never_returns_verified_result(self):
        c=self.controller()
        with patch.object(c,'save',side_effect=OSError('fixture disk failure')),self.assertRaises(OSError):c.run()
        self.assertFalse((self.root/'result.json').exists());self.assertEqual(self.fake.calls,[])
if __name__=='__main__':unittest.main()
