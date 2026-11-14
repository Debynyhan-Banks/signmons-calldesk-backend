import contextlib,io,json,subprocess,tempfile,unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
import connected_launcher as launcher
import packet
import copy,test_packet

class LauncherBoundaryTests(unittest.TestCase):
    def run_case(self,expire=None,interrupt=False,attended=False,decline=None,diagnostic=False,malformed=None):
        with tempfile.TemporaryDirectory(prefix='p08-launch-boundary-',dir='/private/tmp') as tmp:
            root=Path(tmp);repo=root/'gov';repo.mkdir();review=root/'review'
            def git(*args):return subprocess.check_output(['git',*args],cwd=repo,stderr=subprocess.PIPE)
            git('init','-q');git('-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','--allow-empty','-qm','fixture')
            now=[10];sequence=[];original=packet.wait_committed_decision
            window={'start':'1970-01-01T00:00:10Z','cutoff':'1970-01-01T00:00:15Z'}
            spec={'recoveryId':'synthetic','qualificationId':'qual','prospectiveOperationId':'native','window':window,'prospectiveWindow':window,'paymentWorkEnd':'synthetic','prospectiveLimits':{},'sourceCommit':'synthetic'}
            if diagnostic:spec['nativePurpose']='NATIVE_PREFLIGHT_ONLY'
            envelope={'nativeScope':{'private':'PRIVATE_SENTINEL'},'plan':{'nativeScopeSha256':'a'*64},'sdkReview':{'limits':{}}}
            fixture=test_packet.PacketTests();fixture.setUp();self.addCleanup(fixture.doCleanups)
            qe=packet.construct_values(fixture.spec,fixture.values,'we_PRIVATESENTINEL',fixture.cap)
            native=packet.native_envelope(qe,{**fixture.t.e['qualification'],'scopeSha256':packet.q.model.digest(qe['nativeScope'])})
            if malformed:malformed(native)
            cap=SimpleNamespace(root=root/'guard')
            def wait(gov,path,expected,start,cutoff):
                stage='native' if 'NATIVE' in path else 'qualification'
                sequence.append(stage+'-wait')
                if diagnostic and stage=='native':
                    self.assertEqual(expected['decision'],'APPROVE_EXACT_P08_NATIVE_PREFLIGHT_READ')
                    self.assertTrue(expected['externalReadAuthorized'])
                    self.assertNotIn('externalActionAuthorized',expected)
                self.assertFalse((repo/path).exists())
                def advance(_):
                    now[0]+=1
                    published=json.loads((review/(stage+'.json')).read_text())
                    self.assertEqual(published['decisionForReview'],expected)
                    self.assertNotIn('PRIVATE_SENTINEL',json.dumps(published))
                    self.assertNotIn('we_PRIVATESENTINEL',json.dumps(published))
                    if stage=='native' and not diagnostic:
                        summary=published['summary']
                        self.assertEqual(summary['amountTotalCents'],native['payment']['amountTotalCents'])
                        self.assertEqual(summary['currency'],native['payment']['currency'])
                        self.assertEqual(summary['candidate'],native['resources']['candidate'])
                        self.assertEqual(summary['stripeVersion'],native['resources']['secretVersions']['signmons-staging-stripe-secret-key'])
                        self.assertEqual(summary['cost'],{'allowanceUsd':0,'hardBillingCap':False,'existingLiabilitiesUnchanged':True})
                    if interrupt and stage=='native':raise KeyboardInterrupt()
                    if expire==stage:return
                    (repo/path).write_text(json.dumps(expected));git('add',path)
                    git('-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-qm','explicit synthetic approval')
                return original(gov,path,expected,start,cutoff,clock=lambda:now[0],sleep=advance)
            def capture(root,stage,*args,**kwargs):
                sequence.append(stage+'-confirmation')
                self.assertFalse(any('dispatch' in item for item in sequence) if stage=='qualification' else 'native-dispatch' in sequence)
                if decline==stage:raise packet.q.model.Stop('ATTENDED_CONFIRMATION_REFUSED')
            def execute(c,e,approve,**kwargs):
                self.assertEqual(kwargs, {'native_purpose':'NATIVE_PREFLIGHT_ONLY'} if diagnostic else {})
                sequence.append('qualification-dispatch')
                self.assertEqual(e['nativeScope']['private'],'PRIVATE_SENTINEL')
                try:
                    ref=approve(copy.deepcopy(native))
                    self.assertTrue(ref['commit']);sequence.append('native-dispatch')
                    return {'status':'synthetic-result'}
                finally:sequence.append('connected-cleanup')
            def cleanup(_):sequence.append('prequalification-purge');return {'rawFilesAbsent':True}
            output=io.StringIO()
            with patch.object(packet,'capture_attended_confirmation',side_effect=capture),patch.object(packet,'construct',return_value=(cap,envelope)),patch.object(packet,'wait_committed_decision',side_effect=wait),patch.object(packet,'execute_connected',side_effect=execute),patch.object(packet.q,'QualificationCapability',return_value=SimpleNamespace(prepare=lambda:None)),patch.object(packet.q,'qualification_cleanup_scope',return_value={'synthetic':True}),patch.object(packet.q,'private_json',return_value={}),patch.object(packet.q,'BindingRecoveryCapability',return_value=cap),patch.object(packet.q,'closeout_binding_recovery',side_effect=cleanup),contextlib.redirect_stdout(output):
                code=launcher.main(spec,governance=repo,review=review,read_hidden=lambda _: 'we_synthetic',session_consent={} if attended else None)
            self.assertNotIn('PRIVATE_SENTINEL',output.getvalue())
            if expire=='qualification':self.assertIn('CONNECTED_STAGE_QUALIFICATION_APPROVAL',output.getvalue())
            return code,sequence
    def test_actual_wrapper_waits_for_both_initially_absent_committed_decisions(self):
        code,seq=self.run_case();self.assertEqual(code,0)
        self.assertEqual(seq,['qualification-wait','qualification-dispatch','native-wait','native-dispatch','connected-cleanup'])
    def test_qualification_expiry_purges_without_dispatch(self):
        code,seq=self.run_case(expire='qualification');self.assertEqual(code,2)
        self.assertEqual(seq,['qualification-wait','prequalification-purge'])
    def test_native_expiry_returns_through_connected_cleanup(self):
        code,seq=self.run_case(expire='native');self.assertEqual(code,2)
        self.assertEqual(seq,['qualification-wait','qualification-dispatch','native-wait','connected-cleanup'])
    def test_native_wait_interruption_returns_through_connected_cleanup(self):
        code,seq=self.run_case(interrupt=True);self.assertEqual(code,2)
        self.assertEqual(seq,['qualification-wait','qualification-dispatch','native-wait','connected-cleanup'])

    def test_terminal_confirmation_still_requires_both_committed_decisions(self):
        code,seq=self.run_case(attended=True);self.assertEqual(code,0)
        self.assertEqual(seq,['qualification-confirmation','qualification-wait','qualification-dispatch','native-confirmation','native-wait','native-dispatch','connected-cleanup'])
    def test_terminal_confirmation_without_commit_cannot_dispatch(self):
        code,seq=self.run_case(attended=True,expire='qualification');self.assertEqual(code,2)
        self.assertEqual(seq,['qualification-confirmation','qualification-wait','prequalification-purge'])
    def test_terminal_decline_preserves_cleanup_at_each_stage(self):
        code,seq=self.run_case(attended=True,decline='qualification');self.assertEqual(code,2)
        self.assertEqual(seq,['qualification-confirmation','prequalification-purge'])
        code,seq=self.run_case(attended=True,decline='native');self.assertEqual(code,2)
        self.assertEqual(seq,['qualification-confirmation','qualification-wait','qualification-dispatch','native-confirmation','connected-cleanup'])

    def test_diagnostic_launcher_requires_separate_read_authority(self):
        code,seq=self.run_case(diagnostic=True)
        self.assertEqual(code,0)
        self.assertEqual(seq,['qualification-wait','qualification-dispatch','native-wait','native-dispatch','connected-cleanup'])

    def test_diagnostic_rejects_payment_terminal_delegation_before_hidden_input(self):
        with self.assertRaisesRegex(Exception,'PREFLIGHT_REQUIRES_SEPARATE_CHAT_DECISIONS'):
            launcher.main({'recoveryId':'synthetic','nativePurpose':'NATIVE_PREFLIGHT_ONLY'},
                          session_consent={},read_hidden=lambda _:self.fail('credential prompt'))

    def test_incomplete_or_invalid_payment_review_cleans_without_native_publication(self):
        mutations=[lambda n:n['payment'].pop('amountTotalCents'),
                   lambda n:n['payment'].update(amountTotalCents=None),
                   lambda n:n['payment'].update(currency='eur'),
                   lambda n:n['resources'].update(candidate='wrong'),
                   lambda n:n['plan'].update(allowanceUsd=1)]
        for mutation in mutations:
            with self.subTest(mutation=mutation):
                code,seq=self.run_case(malformed=mutation)
                self.assertEqual(code,2)
                self.assertEqual(seq,['qualification-wait','qualification-dispatch','connected-cleanup'])


class SafePreparationFailureTests(unittest.TestCase):
    def output_for(self,error):
        output=io.StringIO()
        with patch.object(packet,'construct',side_effect=error),patch.object(packet,'execute_connected') as dispatch,contextlib.redirect_stdout(output):
            result=launcher.main({'recoveryId':'synthetic'},read_hidden=lambda _: 'we_SECRET_CANARY')
        self.assertEqual(result,2);dispatch.assert_not_called()
        self.assertNotIn('SECRET_CANARY',output.getvalue())
        return output.getvalue()

    def test_exact_native_codes_are_visible_before_qualification(self):
        native=packet.q.current_module('authority')
        for code in launcher.PAYMENT_FAILURE_CODES:
            with self.subTest(code=code):
                self.assertEqual(self.output_for(native.Stop(code)),
                    'CONNECTED_STAGE_PACKET_PREPARATION\nCONNECTED_STOP_'+code+'\n')

    def test_unknown_foreign_subclass_and_malformed_messages_stay_generic(self):
        native=packet.q.current_module('authority');foreign=type('Stop',(Exception,),{})
        class Derived(native.Stop):pass
        cases=[native.Stop('SECRET_CANARY'),native.Stop('PAYMENT_SCOPE\nSECRET_CANARY'),
               native.Stop('PAYMENT_SCOPE:SECRET_CANARY'),native.Stop(),
               native.Stop('PAYMENT_SCOPE','SECRET_CANARY'),native.Stop({'secret':'SECRET_CANARY'}),
               foreign('PAYMENT_SCOPE'),Derived('PAYMENT_SCOPE'),RuntimeError('SECRET_CANARY')]
        for error in cases:
            with self.subTest(kind=type(error).__name__):
                self.assertEqual(self.output_for(error),
                    'CONNECTED_STAGE_PACKET_PREPARATION\nCONNECTED_STOP_'+type(error).__name__+'\n')

    def test_existing_model_stop_and_interruption_remain_unchanged(self):
        self.assertIn('CONNECTED_STOP_ATTENDED_CONFIRMATION_REFUSED',
                      self.output_for(packet.q.model.Stop('ATTENDED_CONFIRMATION_REFUSED')))
        self.assertIn('CONNECTED_STOP_KeyboardInterrupt',self.output_for(KeyboardInterrupt()))

    def test_actual_payment_validator_distinguishes_pin_and_timing(self):
        fixture=test_packet.PacketTests();fixture.setUp();self.addCleanup(fixture.doCleanups)
        e=packet.construct_values(fixture.spec,fixture.values,'we_synthetic',fixture.cap)
        a=packet.q.current_module('authority')
        times={k:packet.q.model.timestamp(v) for k,v in fixture.spec['prospectiveWindow'].items()}
        for code in ['PAYMENT_ENDPOINT_PIN','PAYMENT_TIMING']:
            pay=copy.deepcopy(e['nativeScope']['payment'])
            if code=='PAYMENT_TIMING':pay['workEnd']=fixture.spec['prospectiveWindow']['start']
            try:a.validate_payment({'payment':pay,'execution':'EXTERNAL'},times)
            except a.Stop as error:self.assertIn('CONNECTED_STOP_'+code,self.output_for(error))
            else:self.fail('validator unexpectedly accepted synthetic scope')

    def test_authority_loader_failure_does_not_leak_or_replace_original_category(self):
        with patch.object(packet.q,'current_module',side_effect=RuntimeError('SECRET_CANARY')):
            self.assertEqual(launcher.safe_failure_code(ValueError('SECRET_CANARY')),'ValueError')

    def test_native_failure_after_recovery_binding_still_runs_independent_purge(self):
        cap=SimpleNamespace(root=Path('/private/tmp/synthetic-ep1'))
        e={'nativeScope':{},'plan':{'nativeScopeSha256':'a'*64}}
        error=packet.q.current_module('authority').Stop('PAYMENT_TIMING')
        output=io.StringIO()
        with patch.object(packet,'construct',return_value=(cap,e)),patch.object(packet.q,'qualification_cleanup_scope',return_value={}),patch.object(packet.q,'QualificationCapability',side_effect=error),patch.object(packet.q,'private_json',return_value={}),patch.object(packet.q,'BindingRecoveryCapability',return_value=cap),patch.object(packet.q,'closeout_binding_recovery',return_value={'rawFilesAbsent':True}) as close,patch.object(packet,'execute_connected') as dispatch,contextlib.redirect_stdout(output):
            self.assertEqual(launcher.main({'recoveryId':'synthetic'},read_hidden=lambda _: 'we_synthetic'),2)
        close.assert_called_once_with(cap);dispatch.assert_not_called()
        self.assertEqual(output.getvalue(),'CONNECTED_STAGE_PACKET_PREPARATION\nCONNECTED_STOP_PAYMENT_TIMING\nRECOVERY_PURGE_VERIFIED\n')
