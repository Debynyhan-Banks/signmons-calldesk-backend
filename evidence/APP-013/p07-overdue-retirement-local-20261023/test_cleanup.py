import copy,datetime as dt,hashlib,importlib.util,json,os,pty,shutil,signal,stat,subprocess,sys,tempfile,termios,time,unittest
from pathlib import Path
from unittest.mock import patch
HERE=Path(__file__).resolve().parent
spec=importlib.util.spec_from_file_location('cleanup_supervisor',HERE/'cleanup.py');w=importlib.util.module_from_spec(spec);spec.loader.exec_module(w)
class FakeProvider:
    def __init__(self,already=False,fail=None):
        self.tag=not already;self.disabled=already;self.versions={n:('DISABLED' if already else 'ENABLED') for n in w.c.NEW_SECRETS.values()};self.bound={n:not already for n in [*w.c.NEW_SECRETS.values(),w.c.STRIPE_SECRET]};self.calls=[];self.fail=fail
    def __call__(self,args,**kw):
        self.calls.append(args)
        if not w.allowed_command(args):raise AssertionError('unlisted command')
        if self.fail and self.fail(args):raise w.c.Stop('COMMAND_FAILED')
        value=''
        if args[0]==w.c.NODE:value='P07_DATABASE_CLOSEOUT_VERIFIED_UNCHANGED'
        elif args[1:4]==['run','services','describe']:
            value={'status':{'traffic':[{'revisionName':w.c.NORMAL,'percent':100}]+([{'tag':w.c.TAG,'revisionName':w.c.REVISION,'percent':0}] if self.tag else [])}}
        elif args[1:4]==['run','services','update-traffic']:self.tag=False
        elif args[1:4]==['secrets','versions','describe']:value={'state':self.versions[next(x.split('=',1)[1] for x in args if x.startswith('--secret='))]}
        elif args[1:4]==['secrets','versions','disable']:self.versions[next(x.split('=',1)[1] for x in args if x.startswith('--secret='))]='DISABLED'
        elif args[1:3]==['secrets','get-iam-policy']:value={'bindings':[{'role':'roles/secretmanager.secretAccessor','members':[w.c.SA_MEMBER]}] if self.bound[args[3]] else []}
        elif args[1:3]==['secrets','remove-iam-policy-binding']:self.bound[args[3]]=False
        elif args[1:4]==['iam','service-accounts','disable']:self.disabled=True
        elif args[1:4]==['iam','service-accounts','describe']:value={'email':w.c.SERVICE_ACCOUNT,'disabled':self.disabled}
        else:raise AssertionError('unmodelled command')
        output=json.dumps(value) if isinstance(value,dict) else value
        return subprocess.CompletedProcess(args,0,output.encode(),b'')

class Tests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory(prefix='p07-cleanup-test-');self.root=Path(self.temp.name);self.oldroot=w.ROOT;self.oldcroot=w.c.ROOT
        shutil.copytree(HERE/'legacy',self.root/'legacy')
        for f in HERE.iterdir():
            if f.is_file() and f.name not in {'cleanup-binding.json','cleanup-owner-approval.json','cleanup-attempt.json','cleanup-result.json','stripe-readback.json','stripe-readback-request.json','role-closeout.json'}:shutil.copy2(f,self.root/f.name)
        w.ROOT=self.root;w.c.ROOT=self.root;w.c._PHASE_DEADLINE=None;w.c._CLEANING=False
    def tearDown(self):
        w.ROOT=self.oldroot;w.c.ROOT=self.oldcroot;w.c._PHASE_DEADLINE=None;w.c._CLEANING=False;self.temp.cleanup()
    def bound(self,now=None):
        now=time.time() if now is None else now
        fmt=lambda t:dt.datetime.fromtimestamp(t,dt.timezone.utc).isoformat().replace('+00:00','Z')
        b={'mode':'CLEANUP_ONLY','planId':w.PLAN['planId'],'packetId':w.PLAN['packetId'],'operationId':w.PLAN['operationId'],'originalOperationId':w.c.OPERATION,'originalRetirementDeadlineUtc':w.PLAN['originalRetirementDeadlineUtc'],'automaticRetryAllowed':False,'actions':w.PLAN['actions'],'startUtc':fmt(now-10),'cutoffUtc':fmt(now+30),'endUtc':fmt(now+60),'manifestSha256':'a'*64,'proposalCommit':'b'*40,'proposalName':'APP013_P07_LATE_RETIREMENT_OPERATION_20261023.md','proposalSha256':'c'*64}
        a=self.approval(b,now-1)
        return b,a
    def approval(self,b,when):
        return {'decision':'APPROVED','owner':'Debynyhan Banks','mode':'CLEANUP_ONLY','operationId':w.PLAN['operationId'],'bindingSha256':w.digest(b),'manifestSha256':b['manifestSha256'],'automaticRetryAllowed':False,'actions':w.PLAN['actions'],'approvedAtUtc':dt.datetime.fromtimestamp(when,dt.timezone.utc).isoformat().replace('+00:00','Z')}
    def resources(self):return w.validate_resources(w.read('source-journal.json'))
    def fake_stripe(self,attempt,binding):
        receipt={'operationId':w.PLAN['operationId'],'mode':'SANDBOX_TEST','destinationName':'Signmons P07 same-job sandbox','destinationUrlSha256':hashlib.sha256((w.c.ORIGIN+'/webhooks/stripe').encode()).hexdigest(),'disabled':True,'deliveryAttempts':0,'observedAtUtc':w.utc()}
        w.save('stripe-readback.json',receipt);w.stripe_valid(receipt,attempt,binding)
    def execute(self,provider=None,already=False):
        b,a=self.bound();p=provider or FakeProvider(already=already)
        with patch.object(os,'isatty',return_value=True),patch.object(w.c,'private_input',return_value='synthetic-private-value'),patch.object(w.c,'run_status',p),patch.object(w,'wait_stripe',self.fake_stripe):
            result=w.execute(b,self.resources(),w.parse(b['endUtc']))
        return result,p,json.loads((self.root/'cleanup-result.json').read_text())
    def test_local_source_and_exact_resources(self):
        self.assertEqual(len(w.local_check()['bindings']),7);self.assertEqual(len(self.resources()['secret_versions']),6)
    def test_fresh_complete_binding_is_required(self):
        b,a=self.bound();self.assertGreater(w.authority(b,a),time.time())
        for key in list(b):
            x=copy.deepcopy(b);x.pop(key)
            with self.subTest(key=key),self.assertRaises(w.Stop):w.authority(x,a)
    def test_wrong_old_or_missing_approval_refuses(self):
        b,a=self.bound()
        for bad in [None,{},dict(a,mode='READ_ONLY_OPERATOR_DIAGNOSTIC'),dict(a,operationId=w.c.OPERATION),dict(a,automaticRetryAllowed=True),dict(a,approvedAtUtc='2099-01-01T00:00:00Z')]:
            with self.subTest(approval=bad),self.assertRaises(w.Stop):w.authority(b,bad)
    def test_before_start_cutoff_and_expired_refuse(self):
        now=time.time();b,a=self.bound(now)
        for instant,code in [(now-11,'OWNER_APPROVAL_INVALID'),(now+30,'START_CUTOFF'),(now+61,'START_CUTOFF')]:
            with self.subTest(code=code),self.assertRaises(w.Stop) as caught:w.authority(b,a,instant)
            self.assertEqual(caught.exception.code,code)
        a=self.approval(b,now-20)
        with self.assertRaisesRegex(w.Stop,'NOT_YET_START'):w.authority(b,a,now-11)
    def test_clock_rechecked_before_reservation(self):
        b,a=self.bound(time.time()-100)
        with patch.object(os,'isatty',return_value=True),self.assertRaisesRegex(w.Stop,'START_CUTOFF'):w.execute(b,self.resources(),time.time()+1)
        self.assertFalse((self.root/'cleanup-attempt.json').exists())
    def test_deadline_shape_and_original_deadline_cannot_change(self):
        b,a=self.bound()
        for x in [dict(b,endUtc=b['startUtc']),dict(b,originalRetirementDeadlineUtc='2099-01-01T00:00:00Z'),dict(b,mode='PROVISION'),dict(b,actions=b['actions']+['create_role']),dict(b,endUtc='2099-01-01T00:00:00Z')]:
            with self.subTest(binding=x),self.assertRaises(w.Stop):w.authority(x,self.approval(x,time.time()-1))
    def test_json_receipts_exclusive_private_and_symlink_refused(self):
        w.save('test.json',{'status':'ONE'});self.assertEqual(stat.S_IMODE((self.root/'test.json').stat().st_mode),0o600)
        with self.assertRaises(w.Stop):w.save('test.json',{})
        (self.root/'alias.json').symlink_to(self.root/'test.json')
        with self.assertRaises(w.Stop):w.read('alias.json')
    def test_source_hash_manifest_inventory_and_journal_pins(self):
        for name in ['cleanup.py','source-journal.json','db-closeout.mjs','legacy/controller.py']:
            f=self.root/name;original=f.read_bytes();f.write_bytes(original+b' ')
            with self.subTest(name=name),self.assertRaises(w.Stop):w.local_check()
            f.write_bytes(original)
        path=self.root/'cleanup-manifest.json';m=json.loads(path.read_text());m['files'].pop('cleanup.py');path.write_text(json.dumps(m))
        with self.assertRaisesRegex(w.Stop,'MANIFEST_INVENTORY_INVALID'):w.local_check()
    def test_private_modes_directory_and_files(self):
        os.chmod(self.root,0o755)
        with self.assertRaisesRegex(w.Stop,'PRIVATE_DIRECTORY_INVALID'):w.local_check()
        os.chmod(self.root,0o700);os.chmod(self.root/'source-journal.json',0o644)
        with self.assertRaises(w.Stop):w.local_check()
    def test_foreign_extra_duplicate_and_unknown_resources_refuse(self):
        j=w.read('source-journal.json');cases=[]
        x=copy.deepcopy(j);x['operationId']='foreign';cases.append(x)
        x=copy.deepcopy(j);x['mutation']['secret_versions'][next(iter(x['mutation']['secret_versions']))]='UNKNOWN';cases.append(x)
        x=copy.deepcopy(j);x['mutation']['secret_versions'][next(iter(x['mutation']['secret_versions']))]='2';cases.append(x)
        x=copy.deepcopy(j);x['mutation']['bindings'][0]='foreign';cases.append(x)
        x=copy.deepcopy(j);x['mutation']['bindings'].append(x['mutation']['bindings'][0]);cases.append(x)
        x=copy.deepcopy(j);x['mutation']['secret_resources'].append('foreign');cases.append(x)
        x=copy.deepcopy(j);x['mutation']['role_open']=1;cases.append(x)
        x=copy.deepcopy(j);x['mutation']['extra']='bad';cases.append(x)
        for x in cases:
            with self.subTest(journal=x),self.assertRaises(w.Stop):w.validate_resources(x)
    def test_command_allowlist_excludes_provisioning_and_shared_version_disable(self):
        p=FakeProvider();result,p,receipt=self.execute(p);self.assertEqual(result,0);self.assertTrue(all(w.allowed_command(args) for args in p.calls))
        for cmd in [[w.c.GCLOUD,'run','deploy',w.c.SERVICE],[w.c.GCLOUD,'secrets','versions','access','1','--secret='+w.c.STRIPE_SECRET],[w.c.GCLOUD,'secrets','versions','disable','1','--secret='+w.c.STRIPE_SECRET,'--project='+w.c.PROJECT,'--quiet'],[w.c.NODE,str(w.ROOT/'legacy/firebase-read.mjs')],[w.c.PSQL,'ALTER ROLE anything LOGIN']]:self.assertFalse(w.allowed_command(cmd))
        for call in p.calls:self.assertFalse(w.allowed_command(call+['--unexpected']))
    def test_full_cleanup_executes_existing_functions_and_current_role_readback(self):
        result,p,receipt=self.execute();self.assertEqual(result,0);self.assertEqual(receipt['status'],'P07_LATE_RETIREMENT_VERIFIED');self.assertEqual(len(receipt['completedSteps']),18)
        self.assertTrue(all(x=='DISABLED' for x in p.versions.values()));self.assertFalse(any(p.bound.values()));self.assertTrue(p.disabled);self.assertFalse(p.tag)
        self.assertTrue((self.root/'role-closeout.json').exists());self.assertIn([w.c.NODE,str(w.ROOT/'db-closeout.mjs')],p.calls)
        self.assertNotIn('synthetic-private-value',(self.root/'cleanup-result.json').read_text())
    def test_already_retired_provider_states_are_read_back(self):
        result,p,receipt=self.execute(already=True);self.assertEqual(result,0)
        self.assertFalse(any(x[1:4]==['secrets','versions','disable'] for x in p.calls));self.assertFalse(any(x[1:3]==['secrets','remove-iam-policy-binding'] for x in p.calls))
    def test_each_cleanup_failure_keeps_residual_without_false_verified(self):
        groups=[lambda a:a[0]==w.c.NODE,lambda a:a[1:4]==['run','services','update-traffic'],lambda a:a[1:4]==['secrets','versions','disable'],lambda a:a[1:3]==['secrets','remove-iam-policy-binding'],lambda a:a[1:4]==['iam','service-accounts','disable']]
        for index,predicate in enumerate(groups):
            with self.subTest(group=index):
                for name in ['cleanup-attempt.json','cleanup-result.json','role-closeout.json','stripe-readback.json']:
                    (self.root/name).unlink(missing_ok=True)
                result,p,receipt=self.execute(FakeProvider(fail=predicate));self.assertEqual(result,1);self.assertTrue(receipt['remainingSteps']);self.assertTrue(receipt['failures'])
    def test_stale_role_or_stripe_result_refuses_before_input(self):
        for name in ['role-closeout.json','stripe-readback.json','cleanup-result.json']:
            w.save(name,{})
            with patch.object(os,'isatty',return_value=True),patch.object(w.c,'private_input') as private,self.assertRaises(w.Stop):
                b,a=self.bound();w.execute(b,self.resources(),w.parse(b['endUtc']))
            private.assert_not_called();(self.root/name).unlink()
    def test_stripe_must_be_fresh_exact_operation_and_destination(self):
        b,a=self.bound();attempt={'startedAtUtc':w.utc()};self.fake_stripe(attempt,b);good=w.read('stripe-readback.json')
        cases=[dict(good,operationId=w.c.OPERATION),dict(good,observedAtUtc='2026-10-22T22:30:00Z'),dict(good,deliveryAttempts=1),dict(good,deliveryAttempts=False),dict(good,disabled=False),dict(good,destinationUrlSha256='0'*64),dict(good,observedAtUtc='2099-01-01T00:00:00Z')]
        for x in cases:
            with self.subTest(receipt=x),self.assertRaises(w.Stop):w.stripe_valid(x,attempt,b)
    def test_late_readback_never_returns_verified(self):
        clock=[time.time()];b,a=self.bound(clock[0]);p=FakeProvider()
        def late(*args):clock[0]=w.parse(b['endUtc'])+1
        with patch.object(os,'isatty',return_value=True),patch.object(w.c,'private_input',return_value='synthetic'),patch.object(w.c,'run_status',p),patch.object(w.c,'close_role',side_effect=late),patch.object(time,'time',side_effect=lambda:clock[0]):
            self.assertEqual(w.execute(b,self.resources(),w.parse(b['endUtc'])),1)
        receipt=w.read('cleanup-result.json');self.assertNotEqual(receipt['status'],'P07_LATE_RETIREMENT_VERIFIED');self.assertTrue(receipt['remainingSteps'])
    def test_receipt_write_failure_never_prints_verified(self):
        original=w.save
        def fail(name,value):
            if name=='cleanup-result.json':raise OSError('synthetic-private-error')
            return original(name,value)
        import io
        output=io.StringIO()
        b,a=self.bound();p=FakeProvider()
        with patch.object(w,'save',side_effect=fail),patch('sys.stdout',output),patch.object(os,'isatty',return_value=True),patch.object(w.c,'private_input',return_value='synthetic'),patch.object(w.c,'run_status',p),patch.object(w,'wait_stripe',self.fake_stripe):self.assertEqual(w.execute(b,self.resources(),w.parse(b['endUtc'])),1)
        self.assertNotIn('P07_LATE_RETIREMENT_VERIFIED',output.getvalue());self.assertNotIn('synthetic-private-error',output.getvalue())
    def test_no_terminal_no_action(self):
        b,a=self.bound()
        with patch.object(os,'isatty',return_value=False),self.assertRaisesRegex(w.Stop,'ATTENDED_TERMINAL_REQUIRED'):w.execute(b,self.resources(),w.parse(b['endUtc']))
        self.assertFalse((self.root/'cleanup-attempt.json').exists())
    def test_real_concurrent_reservation_only_one_winner(self):
        code="import sys;from pathlib import Path;sys.path.insert(0,sys.argv[1]);import cleanup as w;w.ROOT=Path(sys.argv[2]);w.save('race.json',{'status':'reserved'})"
        processes=[subprocess.Popen([sys.executable,'-B','-c',code,str(HERE),str(self.root)],stdout=subprocess.PIPE,stderr=subprocess.PIPE) for _ in range(2)]
        results=[p.communicate(timeout=10)+(p.returncode,) for p in processes]
        self.assertEqual(sum(r[2]==0 for r in results),1);self.assertTrue(all(p.poll() is not None for p in processes));self.assertEqual(stat.S_IMODE((self.root/'race.json').stat().st_mode),0o600)
    def test_preparation_cli_cannot_launch_any_old_mode(self):
        for mode in ['--run','--qualify','--recover','--operator-diagnostic','--retire']:
            run=subprocess.run([sys.executable,'-B',str(HERE/'cleanup.py'),mode],stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=20)
            self.assertEqual(run.returncode,2);self.assertIn(b'P07_CLEANUP_REFUSED_',run.stdout)
        self.assertFalse((HERE/'cleanup-attempt.json').exists())
    def test_actual_saved_binding_approval_and_proposal_reach_same_validator(self):
        b,a=self.bound();b['manifestSha256']=w.sha(self.root/'cleanup-manifest.json');body=b'synthetic exact cleanup proposal';b['proposalSha256']=hashlib.sha256(body).hexdigest();a=self.approval(b,time.time()-1)
        w.save('cleanup-binding.json',b);w.save('cleanup-owner-approval.json',a);real_git=w.git
        def fake_git(args,repo):
            if args==['show',b['proposalCommit']+':'+b['proposalName']]:return body
            return real_git(args,repo)
        with patch.object(w,'git',side_effect=fake_git):
            binding,resources,deadline=w.live_check()
            self.assertEqual(binding,b);self.assertEqual(len(resources['bindings']),7);self.assertEqual(deadline,w.parse(b['endUtc']))
        self.assertFalse((self.root/'cleanup-attempt.json').exists())
    def test_actual_guard_blocks_unlisted_legacy_command_before_provider(self):
        b,a=self.bound();p=FakeProvider()
        def forbidden(password):w.c.run([w.c.GCLOUD,'secrets','create','unlisted'])
        with patch.object(os,'isatty',return_value=True),patch.object(w.c,'private_input',return_value='synthetic'),patch.object(w.c,'run_status',p),patch.object(w.c,'close_role',side_effect=forbidden),patch.object(w,'wait_stripe',self.fake_stripe):self.assertEqual(w.execute(b,self.resources(),w.parse(b['endUtc'])),1)
        self.assertFalse(any('unlisted' in args for args in p.calls));self.assertIn({'stage':'ROLE_CLOSEOUT','reason':'COMMAND_NOT_ALLOWED'},w.read('cleanup-result.json')['failures'])
    def test_wrong_identity_readback_never_verified(self):
        p=FakeProvider();original=p.__call__
        def wrong(args,**kw):
            result=original(args,**kw)
            if args[1:4]==['iam','service-accounts','describe']:return subprocess.CompletedProcess(args,0,json.dumps({'email':'foreign','disabled':True}).encode(),b'')
            return result
        result,provider,receipt=self.execute(provider=wrong);self.assertEqual(result,1);self.assertIn('DISABLE_IDENTITY',receipt['remainingSteps'])
    def test_wrong_normal_traffic_readback_never_verified(self):
        p=FakeProvider();original=p.__call__
        def wrong(args,**kw):
            result=original(args,**kw)
            if args[1:4]==['run','services','describe']:return subprocess.CompletedProcess(args,0,json.dumps({'status':{'traffic':[{'revisionName':w.c.REVISION,'percent':100}]}}).encode(),b'')
            return result
        result,provider,receipt=self.execute(provider=wrong);self.assertEqual(result,1);self.assertIn('NORMAL_TRAFFIC_READBACK',receipt['remainingSteps'])
    def test_actual_stripe_wait_requires_new_correlated_receipt(self):
        b,a=self.bound();attempt={'startedAtUtc':w.utc()};self.fake_stripe(attempt,b)
        with w.c.phase_guard(w.parse(b['endUtc']),cleanup=True):w.wait_stripe(attempt,b)
        request=w.read('stripe-readback-request.json');self.assertEqual(request['operationId'],w.PLAN['operationId']);self.assertEqual(request['notBeforeUtc'],attempt['startedAtUtc'])
    def child_pty(self,signum=None,input_timeout=False,repeated=False):
        code=r'''
import sys,time,json,os
from pathlib import Path
from unittest.mock import patch
sys.path.insert(0,sys.argv[1]);import cleanup as w
w.ROOT=Path(sys.argv[2]);w.c.ROOT=w.ROOT
import test_cleanup
test_cleanup.w=w
from test_cleanup import Tests,FakeProvider
h=Tests();h.root=w.ROOT
b,a=h.bound();deadline=time.time()+(1 if sys.argv[3]=='timeout' else 5)
b['endUtc']=w.dt.datetime.fromtimestamp(deadline,w.dt.timezone.utc).isoformat().replace('+00:00','Z')
p=FakeProvider()
if sys.argv[3]=='cleanup':
 original=p.__call__
 def fake(args,**kw):
  if args[0]==w.c.NODE:print('CLEANUP_ENTERED',flush=True);time.sleep(0.4)
  return original(args,**kw)
else:fake=p
with patch.object(w.c,'run_status',side_effect=fake),patch.object(w,'wait_stripe',h.fake_stripe):
 rc=w.execute(b,h.resources(),deadline)
sys.exit(rc)
'''
        master,slave=pty.openpty();before=termios.tcgetattr(slave);mode='timeout' if input_timeout else ('cleanup' if repeated else 'signal')
        p=subprocess.Popen([sys.executable,'-B','-c',code,str(HERE),str(self.root),mode],stdin=slave,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
        try:
            import select
            deadline=time.monotonic()+8
            while termios.tcgetattr(slave)[3]&termios.ECHO:
                if time.monotonic()>deadline:raise AssertionError('hidden input not reached')
                time.sleep(.01)
            self.assertFalse(termios.tcgetattr(slave)[3]&termios.ECHO)
            if repeated:
                os.write(master,b'synthetic-pty-secret\n')
                line=p.stdout.readline();self.assertIn(b'CLEANUP_ENTERED',line)
                for s in (signal.SIGINT,signal.SIGTERM,signal.SIGINT):p.send_signal(s);time.sleep(.03)
            elif signum:p.send_signal(signum)
            out,err=p.communicate(timeout=10)
            self.assertEqual(termios.tcgetattr(slave)[3]&termios.ECHO,before[3]&termios.ECHO)
            self.assertNotIn(b'synthetic-pty-secret',out+err)
            receipt=w.read('cleanup-result.json')
            if repeated:self.assertEqual(p.returncode,0);self.assertEqual(receipt['status'],'P07_LATE_RETIREMENT_VERIFIED')
            else:self.assertEqual(p.returncode,1);self.assertEqual(receipt['completedSteps'],[]);self.assertEqual(receipt['status'],'P07_LATE_RETIREMENT_UNCONFIRMED')
        finally:
            if p.poll() is None:p.kill();p.communicate(timeout=5)
            os.close(master);os.close(slave)
    def test_real_sigint_hidden_input_truthfully_unconfirmed(self):self.child_pty(signal.SIGINT)
    def test_real_sigterm_hidden_input_truthfully_unconfirmed(self):self.child_pty(signal.SIGTERM)
    def test_real_hidden_input_deadline_restores_echo(self):self.child_pty(input_timeout=True)
    def test_repeated_signals_during_cleanup_do_not_abort_it(self):self.child_pty(repeated=True)
if __name__=='__main__':unittest.main()
