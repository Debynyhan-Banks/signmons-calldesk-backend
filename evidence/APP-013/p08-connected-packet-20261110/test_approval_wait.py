import json,subprocess,tempfile,unittest
from pathlib import Path
import packet

class ApprovalWaitTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory(prefix='p08-approval-wait-',dir='/private/tmp');self.addCleanup(self.tmp.cleanup)
        self.repo=Path(self.tmp.name);self.path='APP013_P08_NATIVE_OPERATION_20261110.json';self.expected={'decision':'synthetic exact approval','scopeSha256':'a'*64};self.now=10
        self.git('init','-q');self.git('-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','--allow-empty','-qm','fixture')
    def git(self,*args):return subprocess.check_output(['git',*args],cwd=self.repo,stderr=subprocess.PIPE)
    def commit(self,value):
        (self.repo/self.path).write_text(value if isinstance(value,str) else json.dumps(value))
        self.git('add',self.path);self.git('-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-qm','decision')
    def wait(self,sleep,start=10,cutoff=15):
        return packet.wait_committed_decision(self.repo,self.path,self.expected,start,cutoff,lambda:self.now,sleep)
    def test_absent_file_waits_then_returns_exact_committed_approval(self):
        def advance(_):self.now+=1;self.commit(self.expected)
        ref=self.wait(advance)
        self.assertEqual(json.loads(self.git('show',ref['commit']+':'+ref['path'])),self.expected)
    def test_uncommitted_matching_file_does_not_authorize(self):
        (self.repo/self.path).write_text(json.dumps(self.expected))
        with self.assertRaisesRegex(packet.q.model.Stop,'EXACT_APPROVAL_DEADLINE'):
            self.wait(lambda _:setattr(self,'now',self.now+1))
    def test_stale_and_malformed_committed_decisions_wait(self):
        for value in ({'decision':'stale'},'{bad json'):
            with self.subTest(value=value):
                self.commit(value);self.now=10
                def advance(_):self.now+=1;self.commit(self.expected)
                self.assertEqual(self.wait(advance)['path'],self.path)
    def test_matching_approval_waits_until_start(self):
        self.commit(self.expected)
        self.wait(lambda _:setattr(self,'now',self.now+1),start=12)
        self.assertEqual(self.now,12)
    def test_cutoff_and_clock_rollback_refuse(self):
        self.commit(self.expected);self.now=15
        with self.assertRaisesRegex(packet.q.model.Stop,'EXACT_APPROVAL_DEADLINE'):self.wait(lambda _:None)
        self.now=10
        with self.assertRaisesRegex(packet.q.model.Stop,'CLOCK_ROLLBACK'):
            self.wait(lambda _:setattr(self,'now',9),start=12)
    def test_repository_error_is_not_treated_as_absent_approval(self):
        import shutil
        shutil.rmtree(self.repo/'.git')
        with self.assertRaises(subprocess.CalledProcessError):self.wait(lambda _:None)
