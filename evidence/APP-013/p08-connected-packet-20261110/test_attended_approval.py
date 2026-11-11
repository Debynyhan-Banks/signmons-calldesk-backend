import copy,json,os,shutil,subprocess,sys,time,unittest
from pathlib import Path
from unittest.mock import patch
import packet
import test_packet
q=packet.q

class AttendedApprovalTests(unittest.TestCase):
    def setUp(self):
        self.f=test_packet.PacketTests();self.f.setUp();self.addCleanup(self.f.doCleanups)
        self.spec=self.f.spec;self.now=time.time();self.clock=lambda:self.now
        self.envelope=packet.construct_values(self.spec,self.f.values,'we_synthetic',self.f.cap)
        self.decision={'owner':'Debynyhan Banks','decision':'APPROVE_EXACT_P08_CURRENT_QUALIFICATION','externalReadAuthorized':True,
            'scopeSha256':q.model.digest(self.envelope),'cleanupScopeSha256':q.model.digest(q.qualification_cleanup_scope(self.envelope))}
        self.consent={'owner':'Debynyhan Banks','decision':'APPROVE_EXACT_ATTENDED_TERMINAL_CONFIRMATIONS',
            'recoveryId':self.spec['recoveryId'],'sourceCommit':self.spec['sourceCommit'],'specSha256':q.model.digest(self.spec),
            'stages':['qualification','native'],'purgeEnd':self.spec['window']['purgeEnd'],
            'nativeCost':{'allowanceUsd':0,'hardBillingCap':False,'existingLiabilitiesUnchanged':True}}
        self.raw=json.dumps(self.consent).encode();self.ref={'commit':'a'*40,'path':'APP013_P08_ATTENDED_SESSION_20261111.json','sha256':q.model.digest(self.raw)}
        self.root=Path('/private/tmp/p08-public-review-'+self.spec['recoveryId']);self.root.mkdir(mode=0o700);self.addCleanup(lambda:shutil.rmtree(self.root))
        self.output=[]
    def read(self,repo,commit,path):return self.raw if repo==packet.G else (packet.B/path).read_bytes()
    def phrase(self,_):return self.output[-1].removeprefix('Type ').split(' to approve')[0]
    def capture(self,answer=None):
        return packet.capture_attended_confirmation(self.root,'qualification',self.spec,self.decision,self.envelope,self.ref,clock=self.clock,
            read_line=self.phrase if answer is None else answer,read_commit=self.read,emit=self.output.append)
    def expected(self):return packet.stage_review('qualification',self.spec,self.decision,self.envelope,self.consent)
    def verify(self,expected=None):return packet.verify_attended_confirmation(self.root,'qualification',self.spec,self.decision,self.expected() if expected is None else expected,self.ref,clock=self.clock,read_commit=self.read)
    def test_exact_confirmation_requires_independent_verification_and_is_one_use(self):
        self.capture();self.assertFalse((self.root/'qualification.aw1-consumed.json').exists())
        self.assertEqual(self.verify(),self.decision)
        with self.assertRaises(FileExistsError):self.verify()
        self.assertNotIn('we_synthetic',json.dumps(self.output));self.assertNotIn(self.f.values['targetId'],json.dumps(self.output))
    def test_generic_complete_yes_enter_cancel_and_wrong_nonce_refused(self):
        for answer in ('complete','yes','','CANCEL','APPROVE QUALIFICATION wrong wrong'):
            with self.subTest(answer=answer):
                with self.assertRaisesRegex(q.model.Stop,'ATTENDED_CONFIRMATION_REFUSED'):self.capture(lambda _:answer)
                self.assertFalse((self.root/'qualification.aw1-confirmation.json').exists())
                (self.root/'qualification.aw1-review.json').unlink()
    def test_missing_consent_source_and_consent_scope_drift_refuse(self):
        for ref in (None,{**self.ref,'commit':None},{**self.ref,'path':False},{**self.ref,'sha256':'0'*64}):
            with self.assertRaises(q.model.Stop):packet.attended_consent(self.spec,ref,clock=self.clock,read_commit=self.read)
        with self.assertRaisesRegex(q.model.Stop,'ATTENDED_SOURCE_DRIFT'):
            packet.attended_consent(self.spec,self.ref,clock=self.clock,read_commit=lambda repo,commit,path:self.raw if repo==packet.G else b'changed')
        changed={**self.spec,'recoveryId':'00000000-0000-4000-8000-000000000000'}
        with self.assertRaisesRegex(q.model.Stop,'ATTENDED_CONSENT_SCOPE'):packet.attended_consent(changed,self.ref,clock=self.clock,read_commit=self.read)
    def test_late_input_and_clock_rollback_publish_no_confirmation(self):
        for now in (self.now-1,q.model.timestamp(self.spec['window']['cutoff'])):
            original=self.now
            def answer(_):self.now=now;return self.phrase(_)
            with self.assertRaisesRegex(q.model.Stop,'ATTENDED_INPUT_DEADLINE'):self.capture(answer)
            self.now=original;self.assertFalse((self.root/'qualification.aw1-confirmation.json').exists());(self.root/'qualification.aw1-review.json').unlink()
    def test_mutated_confirmation_and_review_and_expected_scope_refused(self):
        self.capture();p=self.root/'qualification.aw1-confirmation.json';original=p.read_bytes()
        for key,value in [('nonce','0'*16),('sourceCommit','f'*40),('operationId',self.spec['prospectiveOperationId']),('stage','native'),('reviewSha256','f'*64),('extra','PRIVATE_SENTINEL')]:
            v=json.loads(original);v[key]=value;p.write_text(json.dumps(v))
            with self.assertRaises(q.model.Stop):self.verify()
            p.write_bytes(original)
        expected=self.expected();expected['summary']['spendingAuthorized']=True
        with self.assertRaisesRegex(q.model.Stop,'ATTENDED_REVIEW_DRIFT'):self.verify(expected)
        self.now=q.model.timestamp(self.spec['window']['cutoff'])
        with self.assertRaisesRegex(q.model.Stop,'ATTENDED_CONFIRMATION_TIME'):self.verify()
    def test_foreign_file_symlink_and_concurrent_writer_refused(self):
        foreign=self.root/'foreign';foreign.write_text('x')
        with self.assertRaises(q.model.Stop):self.capture()
        foreign.unlink();link=self.root/'qualification.aw1-review.json';link.symlink_to('/private/tmp')
        with self.assertRaises(q.model.Stop):self.capture()
        link.unlink();fd=packet._attended_lock(self.root,'qualification')
        try:
            with self.assertRaises(BlockingIOError):self.capture()
        finally:os.close(fd)
    def test_interruption_has_no_confirmation_and_duplicate_capture_refused(self):
        with self.assertRaises(KeyboardInterrupt):self.capture(lambda _:(_ for _ in ()).throw(KeyboardInterrupt()))
        self.assertFalse((self.root/'qualification.aw1-confirmation.json').exists())
        with self.assertRaises(FileExistsError):self.capture()
    def test_native_review_derives_amount_cost_resources_from_actual_envelope(self):
        scope=self.envelope['nativeScope'];candidate={**self.f.t.e['qualification'],'scopeSha256':q.model.digest(scope)}
        native=packet.native_envelope(self.envelope,candidate)
        d={'owner':'Debynyhan Banks','decision':'APPROVE_EXACT_P08_CONNECTED_PAYMENT','externalActionAuthorized':True,'operationId':self.spec['prospectiveOperationId'],'scopeSha256':q.model.digest(native),'sourceManifestSha256':native['sourceManifestSha256']}
        review=packet.stage_review('native',self.spec,d,native,self.consent)
        self.assertEqual(review['summary']['amountTotalCents'],native['payment']['amountTotalCents']);self.assertEqual(review['summary']['stripeVersion'],'2')
        packet.capture_attended_confirmation(self.root,'native',self.spec,d,native,self.ref,clock=self.clock,read_line=self.phrase,read_commit=self.read,emit=self.output.append)
        self.assertEqual(packet.verify_attended_confirmation(self.root,'native',self.spec,d,review,self.ref,clock=self.clock,read_commit=self.read),d)
        for change in ('amount','resource','cost'):
            altered=copy.deepcopy(native)
            if change=='amount':altered['payment']['amountTotalCents']+=1
            if change=='resource':altered['resources']['candidate']='foreign'
            if change=='cost':altered['plan']['allowanceUsd']=1
            with self.assertRaises(q.model.Stop):packet.stage_review('native',self.spec,d,altered,self.consent)
    def terminal_case(self,timeout=False):
        import pty,select
        master,slave=pty.openpty()
        script="from test_attended_approval import AttendedApprovalTests;import packet;t=AttendedApprovalTests();t.setUp();\ntry:\n packet.capture_attended_confirmation(t.root,'qualification',t.spec,t.decision,t.envelope,t.ref,clock=t.clock,read_commit=t.read);print('VISIBLE_CONFIRMATION_CAPTURED',flush=True)\nfinally:t.doCleanups()"
        if timeout:
            script="from test_attended_approval import AttendedApprovalTests;import packet,time;t=AttendedApprovalTests();t.setUp();base=t.now;began=time.monotonic();end=packet.q.model.timestamp(t.spec['window']['cutoff']);t.clock=lambda:end-0.3+(time.monotonic()-began)\ntry:\n packet.capture_attended_confirmation(t.root,'qualification',t.spec,t.decision,t.envelope,t.ref,clock=t.clock,read_commit=t.read)\nexcept BaseException as error:\n assert str(error)=='HTTP_TIMEOUT',repr(error);assert not (t.root/'qualification.aw1-confirmation.json').exists();print('VISIBLE_CONFIRMATION_TIMED_OUT',flush=True)\nfinally:t.doCleanups()"
        process=subprocess.Popen([sys.executable,'-B','-c',script],cwd=Path(__file__).parent,stdin=slave,stdout=slave,stderr=slave);os.close(slave)
        data=b'';sent=False;deadline=time.monotonic()+12
        try:
            while time.monotonic()<deadline:
                if select.select([master],[],[],.1)[0]:
                    try:chunk=os.read(master,8192)
                    except OSError:break
                    if not chunk:break
                    data+=chunk
                    if not timeout and not sent and b'Decision: ' in data:
                        phrase=data.decode().split('Type ')[-1].split(' to approve')[0];os.write(master,(phrase+'\n').encode());sent=True
                if process.poll() is not None:break
            process.wait(timeout=2);self.assertEqual(process.returncode,0,data.decode());self.assertIn(b'VISIBLE_CONFIRMATION_TIMED_OUT' if timeout else b'VISIBLE_CONFIRMATION_CAPTURED',data)
        finally:
            if process.poll() is None:process.kill();process.wait()
            os.close(master)

    def test_actual_visible_terminal_input(self):self.terminal_case()
    def test_actual_visible_terminal_timeout(self):self.terminal_case(timeout=True)



def paste_diagnostic(receipt, seconds=300):
    """PD1 synthetic fixture only; actual input/capture, no execution or Git authority."""
    import builtins,datetime
    receipt=Path(receipt)
    assert receipt.parent.parent==Path('/private/tmp') and receipt.parent.name.startswith('p08-pd1-')
    assert receipt.parent.stat().st_mode & 0o777 == 0o700 and not receipt.exists()
    fixture=AttendedApprovalTests();fixture.setUp()
    outcome={'syntheticOnly':True,'providerCalls':0,'inputObserved':False}
    original_input=builtins.input
    try:
        now=time.time();iso=lambda offset:datetime.datetime.fromtimestamp(now+offset,datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')
        fixture.spec['window']={'start':iso(-10),'cutoff':iso(seconds),'readEnd':iso(seconds+10),'closeoutEnd':iso(seconds+320),'purgeEnd':iso(seconds+600)}
        fixture.envelope['plan']['window']=copy.deepcopy(fixture.spec['window'])
        fixture.decision['scopeSha256']=q.model.digest(fixture.envelope)
        fixture.decision['cleanupScopeSha256']=q.model.digest(q.qualification_cleanup_scope(fixture.envelope))
        fixture.consent.update(specSha256=q.model.digest(fixture.spec),purgeEnd=fixture.spec['window']['purgeEnd'])
        fixture.raw=json.dumps(fixture.consent).encode();fixture.ref['sha256']=q.model.digest(fixture.raw)
        fixture.clock=time.time
        def observe(prompt):
            answer=original_input(prompt)
            review=q.private_json(fixture.root/'qualification.aw1-review.json')
            expected='APPROVE QUALIFICATION '+fixture.spec['qualificationId'][:8]+' '+review['nonce']
            outcome.update(inputObserved=True,expectedLength=len(expected),actualLength=len(answer),exactMatch=answer==expected,
                leadingWhitespace=bool(answer and answer[0].isspace()),trailingWhitespace=bool(answer and answer[-1].isspace()),
                embeddedNewline='\n' in answer or '\r' in answer,nonAscii=not answer.isascii(),pasteControlPresent='\x1b' in answer)
            return answer
        print('PD1 LOCAL SYNTHETIC PASTE CHECK. No password or provider access. Copy only the full APPROVE phrase below.',flush=True)
        with patch.object(builtins,'input',side_effect=observe):
            packet.capture_attended_confirmation(fixture.root,'qualification',fixture.spec,fixture.decision,fixture.envelope,fixture.ref,
                clock=fixture.clock,read_commit=fixture.read)
        outcome['status']='EXACT_SYNTHETIC_INPUT_CAPTURED'
    except BaseException as error:
        outcome['status']=str(error) if str(error) in ('ATTENDED_CONFIRMATION_REFUSED','HTTP_TIMEOUT') else type(error).__name__
    finally:
        fixture.doCleanups();outcome['fixtureRootAbsent']=not fixture.root.exists()
        q.model.reserve(receipt,outcome)
    print('PD1_RESULT '+json.dumps(outcome,sort_keys=True),flush=True)
    return outcome

class PasteBoundaryTests(unittest.TestCase):
    def test_actual_pty_paste_matrix(self):
        import pty,select,tempfile
        cases=[('exact',lambda p:p+'\n',True),('leading',lambda p:' '+p+'\n',False),
            ('trailing',lambda p:p+' \n',False),('crlf',lambda p:p+'\r\n',True),
            ('split',lambda p:p[:12]+'\n'+p[12:]+'\n',False),
            ('paste_control',lambda p:'\x1b[200~'+p+'\x1b[201~\n',False),
            ('eof',lambda p:'\x04',False),('interrupt',lambda p:'\x03',False)]
        for name,transform,accepted in cases:
            with self.subTest(case=name),tempfile.TemporaryDirectory(prefix='p08-pd1-',dir='/private/tmp') as tmp:
                receipt=Path(tmp)/'result.json';master,slave=pty.openpty()
                # No controlling terminal is assigned to subprocess: Ctrl-C case uses
                # SIGINT at the prompt to exercise Python interruption reliably.
                process=subprocess.Popen([sys.executable,'-B',__file__,'--paste-diagnostic',str(receipt)],stdin=slave,stdout=slave,stderr=slave);os.close(slave)
                data=b'';sent=False;deadline=time.monotonic()+10
                try:
                    while time.monotonic()<deadline:
                        if select.select([master],[],[],.05)[0]:
                            try:chunk=os.read(master,16384)
                            except OSError:break
                            if not chunk:break
                            data+=chunk
                            if not sent and b'Decision: ' in data:
                                phrase=data.decode().split('Type ')[-1].split(' to approve')[0]
                                if name=='interrupt':process.send_signal(2)
                                else:os.write(master,transform(phrase).encode())
                                sent=True
                        if process.poll() is not None:break
                    process.wait(timeout=2);self.assertEqual(process.returncode,0)
                    result=json.loads(receipt.read_text());self.assertTrue(result['fixtureRootAbsent'])
                    self.assertEqual(result['status']=='EXACT_SYNTHETIC_INPUT_CAPTURED',accepted)
                    if name=='trailing':self.assertTrue(result['trailingWhitespace'])
                    if name=='leading':self.assertTrue(result['leadingWhitespace'])
                    if name=='paste_control':self.assertTrue(result['pasteControlPresent'])
                    if name=='eof':self.assertEqual(result['status'],'EOFError')
                    if name=='interrupt':self.assertEqual(result['status'],'KeyboardInterrupt')
                    self.assertNotIn('APPROVE QUALIFICATION',receipt.read_text())
                finally:
                    if process.poll() is None:process.kill();process.wait()
                    os.close(master)

if __name__=='__main__':
    if len(sys.argv)==3 and sys.argv[1]=='--paste-diagnostic':paste_diagnostic(sys.argv[2])
    else:unittest.main()
