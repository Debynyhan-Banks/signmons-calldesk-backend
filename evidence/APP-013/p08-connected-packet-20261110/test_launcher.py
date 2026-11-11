import contextlib,io,json,subprocess,tempfile,unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
import connected_launcher as launcher
import packet

class LauncherBoundaryTests(unittest.TestCase):
    def run_case(self,expire=None,interrupt=False,attended=False,decline=None):
        with tempfile.TemporaryDirectory(prefix='p08-launch-boundary-',dir='/private/tmp') as tmp:
            root=Path(tmp);repo=root/'gov';repo.mkdir();review=root/'review'
            def git(*args):return subprocess.check_output(['git',*args],cwd=repo,stderr=subprocess.PIPE)
            git('init','-q');git('-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','--allow-empty','-qm','fixture')
            now=[10];sequence=[];original=packet.wait_committed_decision
            window={'start':'1970-01-01T00:00:10Z','cutoff':'1970-01-01T00:00:15Z'}
            spec={'recoveryId':'synthetic','qualificationId':'qual','prospectiveOperationId':'native','window':window,'prospectiveWindow':window,'paymentWorkEnd':'synthetic','prospectiveLimits':{},'sourceCommit':'synthetic'}
            envelope={'nativeScope':{'private':'PRIVATE_SENTINEL'},'plan':{'nativeScopeSha256':'a'*64},'sdkReview':{'limits':{}}}
            cap=SimpleNamespace(root=root/'guard')
            def wait(gov,path,expected,start,cutoff):
                stage='native' if 'NATIVE' in path else 'qualification'
                sequence.append(stage+'-wait')
                self.assertFalse((repo/path).exists())
                def advance(_):
                    now[0]+=1
                    published=json.loads((review/(stage+'.json')).read_text())
                    self.assertEqual(published['decisionForReview'],expected)
                    self.assertNotIn('PRIVATE_SENTINEL',json.dumps(published))
                    if interrupt and stage=='native':raise KeyboardInterrupt()
                    if expire==stage:return
                    (repo/path).write_text(json.dumps(expected));git('add',path)
                    git('-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-qm','explicit synthetic approval')
                return original(gov,path,expected,start,cutoff,clock=lambda:now[0],sleep=advance)
            def capture(root,stage,*args,**kwargs):
                sequence.append(stage+'-confirmation')
                self.assertFalse(any('dispatch' in item for item in sequence) if stage=='qualification' else 'native-dispatch' in sequence)
                if decline==stage:raise packet.q.model.Stop('ATTENDED_CONFIRMATION_REFUSED')
            def execute(c,e,approve):
                sequence.append('qualification-dispatch')
                self.assertEqual(e['nativeScope']['private'],'PRIVATE_SENTINEL')
                try:
                    ref=approve({'qualification':{'status':'synthetic'},'sourceManifestSha256':'b'*64})
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
