import copy,datetime,hashlib,json,sys,time,unittest,uuid
from pathlib import Path
from types import SimpleNamespace
import packet
from unittest.mock import patch
q=packet.q
sys.path.insert(0,str(q.model.ROOT.parent.parent/'p08-native-entry-local-20261101/source'))
import test_entry as native_fixture
from authority import Capability,digest

def tc1_windows(now):
    iso=lambda n:datetime.datetime.fromtimestamp(int(now)+n,datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')
    return ({'start':iso(-10),'cutoff':iso(30),'readEnd':iso(300),'closeoutEnd':iso(600),'purgeEnd':iso(3580)},
            {'start':iso(-10),'cutoff':iso(2000),'workEnd':iso(2800),'cleanupEnd':iso(3460),'purgeEnd':iso(3580)},iso(2740))

class PacketTests(unittest.TestCase):
    def setUp(self):
        self.t=native_fixture.ConnectedEntryTests();self.t.setUp();self.addCleanup(self.t.doCleanups)
        e=self.t.e;now=int(time.time());iso=lambda n:datetime.datetime.fromtimestamp(now+n,datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')
        self.spec={'recoveryId':str(uuid.uuid4()),'qualificationId':e['payment']['qualificationId'],'prospectiveOperationId':e['plan']['operationId'],
            'sourceCommit':e['sourceCommit'],'manifestSha256':q.source_manifest_sha256(),'window':{'start':iso(-10),'cutoff':iso(30),'readEnd':iso(60),'closeoutEnd':iso(400),'purgeEnd':iso(1000)},
            'prospectiveWindow':e['plan']['window'],'prospectiveLimits':e['limits'],'paymentRequestId':e['payment']['requestId'],'paymentWorkEnd':e['payment']['workEnd']}
        self.values={'targetId':e['target']['id'],'projectNumber':e['plan']['projectNumber'],'paymentBinding':{k:e['payment'][k] for k in q.PAYMENT_BINDING_FIELDS}}
        self.cap=SimpleNamespace(e={'version':2,'nativeOperationId':e['plan']['operationId'],'qualificationId':e['payment']['qualificationId'],
            'sourceCommit':e['sourceCommit'],'paymentAccountSha256':e['payment']['connectedAccountSha256'],'database':e['database']},external=False,times={'purgeEnd':now+1100},clock=time.time)
    def test_constructs_actual_native_capability_without_writing_or_authorizing(self):
        before={p.name:p.read_bytes() for p in self.t.root.iterdir()}
        qualification=packet.construct_values(self.spec,self.values,'we_synthetic',self.cap)
        self.assertNotIn('decision',qualification)
        scope=qualification['nativeScope'];candidate={**self.t.e['qualification'],'scopeSha256':digest(scope)}
        native=packet.native_envelope(qualification,candidate)
        self.assertNotIn('decision',native);native['execution']='PROOF_ONLY'
        native['decision']={'decision':'APPROVE_LOCAL_NATIVE_ENTRY_PROOF','scopeSha256':digest(native)}
        Capability(native,self.t.root)
        self.assertEqual({k:scope['payment'][k] for k in q.PAYMENT_BINDING_FIELDS},self.values['paymentBinding'])
        self.assertEqual(before,{p.name:p.read_bytes() for p in self.t.root.iterdir()})
    def test_preflight_purpose_binds_distinct_authority_and_rejects_payment_mode(self):
        spec={**self.spec,'nativePurpose':'NATIVE_PREFLIGHT_ONLY'}
        e=packet.construct_values(spec,self.values,'we_synthetic',self.cap)
        candidate={**self.t.e['qualification'],'scopeSha256':digest(e['nativeScope'])}
        native=packet.native_envelope(e,candidate,'NATIVE_PREFLIGHT_ONLY')
        native['execution']='PROOF_ONLY'
        native['decision']={'decision':'APPROVE_LOCAL_PREFLIGHT_PROOF','scopeSha256':digest(native)}
        self.assertEqual(Capability(native,self.t.root).mode,'preflight')
        with self.assertRaisesRegex(Exception,'ENTRY_PURPOSE_MODE'):Capability(native,self.t.root,'run')
        with self.assertRaisesRegex(Exception,'PACKET_NATIVE_PURPOSE'):
            packet.construct_values({**spec,'nativePurpose':'OTHER'},self.values,'we_synthetic',self.cap)

    def test_aq1_purpose_and_decision_cannot_be_swapped_with_payment(self):
        spec={**self.spec,'nativePurpose':'NATIVE_AUTH_QUALIFICATION_ONLY','opening':{}}
        spec['window'],spec['prospectiveWindow'],spec['paymentWorkEnd']=tc1_windows(int(time.time()))
        self.cap.times={k:q.model.timestamp(v) for k,v in spec['window'].items()}
        # This existing test isolates purpose authority. Committed opening is
        # exercised through the real consumer by Tc1TimingTests below.
        with patch.object(packet,'verify_recovered_auth_opening'):
            e=packet.construct_values(spec,self.values,'we_synthetic',self.cap)
        candidate={**self.t.e['qualification'],'scopeSha256':digest(e['nativeScope']),
                   'qualifiedUntil':spec['prospectiveWindow']['cleanupEnd']}
        native=packet.native_envelope(e,candidate,spec['nativePurpose']);native['execution']='PROOF_ONLY'
        native['decision']={'decision':'APPROVE_LOCAL_AUTH_QUALIFICATION_PROOF','scopeSha256':digest(native)}
        self.assertEqual(Capability(native,self.t.root).mode,'run')
        for mode in ('preflight','close-preflight'):
            with self.assertRaisesRegex(Exception,'ENTRY_PURPOSE_MODE'):Capability(native,self.t.root,mode)
        for decision in ('APPROVE_LOCAL_NATIVE_ENTRY_PROOF','APPROVE_LOCAL_PREFLIGHT_PROOF'):
            bad=copy.deepcopy(native);bad['decision']['decision']=decision
            with self.assertRaisesRegex(Exception,'LOCAL_PROOF_BINDING'):Capability(bad,self.t.root)
        for mutation,code in [(lambda n:n.update(version=1),'AUTH_QUALIFICATION_VERSION'),
                              (lambda n:n.pop('purpose'),'LOCAL_PROOF_BINDING'),
                              (lambda n:n.update(purpose='OTHER'),'ENTRY_PURPOSE_MODE')]:
            bad=copy.deepcopy(native);mutation(bad)
            with self.assertRaisesRegex(Exception,code):Capability(bad,self.t.root)

    def test_foreign_operation_manifest_account_and_limits_refuse(self):
        for key,value in [('qualificationId',str(uuid.uuid4())),('prospectiveOperationId',str(uuid.uuid4())),('sourceCommit','f'*40),('manifestSha256','f'*64),('prospectiveLimits',{'cli':1})]:
            spec={**self.spec,key:value}
            with self.subTest(key=key),self.assertRaises(Exception):packet.construct_values(spec,self.values,'we_synthetic',self.cap)
        values=copy.deepcopy(self.values);values['paymentBinding']['connectedAccountSha256']='f'*64
        with self.assertRaises(Exception):packet.construct_values(self.spec,values,'we_synthetic',self.cap)
    def test_br2_requires_exact_new_read_budget_and_rejects_old_or_larger_caps(self):
        for limit in (192, 195, 197, 512):
            spec=copy.deepcopy(self.spec);spec['prospectiveLimits']['cli']=limit
            with self.subTest(limit=limit),self.assertRaisesRegex(Exception,'PACKET_LIMITS'):
                packet.construct_values(spec,self.values,'we_synthetic',self.cap)
        e=packet.construct_values(self.spec,self.values,'we_synthetic',self.cap)
        self.assertEqual(e['nativeScope']['limits'],
                         {'cli':196,'https':100,'sql':60,'child':6,'childRequests':200})

    def test_candidate_must_match_complete_payment_scope(self):
        e=packet.construct_values(self.spec,self.values,'we_synthetic',self.cap)
        with self.assertRaises(Exception):packet.native_envelope(e,{**self.t.e['qualification'],'scopeSha256':'f'*64})
    def test_missing_binding_or_extended_retention_refuses(self):
        values=copy.deepcopy(self.values);del values['paymentBinding']['jobUpdatedAt']
        with self.assertRaises(Exception):packet.construct_values(self.spec,values,'we_synthetic',self.cap)
        self.cap.times['purgeEnd']=time.time()+50
        with self.assertRaises(Exception):packet.construct_values(self.spec,self.values,'we_synthetic',self.cap)

if __name__=='__main__':unittest.main()

class CommandLifetimeTests(unittest.TestCase):
    def test_pending_exit_and_interruption_both_invoke_independent_cleanup(self):
        import tempfile
        for interrupt in (False,True):
            with self.subTest(interrupt=interrupt),tempfile.TemporaryDirectory(prefix='p08-command-proof-',dir='/private/tmp') as d:
                root=Path(d);(root/'attempt.json').write_text('{}');calls=[]
                def invoke(argv,**kwargs):
                    calls.append(argv[-2])
                    if argv[-2]=='--run' and interrupt:raise KeyboardInterrupt()
                    return SimpleNamespace(returncode=2)
                if interrupt:
                    with self.assertRaises(KeyboardInterrupt):packet.run_native_and_close(root,invoke)
                else:self.assertEqual(packet.run_native_and_close(root,invoke),{'workExit':2,'closeoutExit':2})
                self.assertEqual(calls,['--run','--closeout'])
    def test_preflight_dispatch_never_uses_activation_or_resource_closeout(self):
        import tempfile
        with tempfile.TemporaryDirectory(dir='/private/tmp') as d:
            root=Path(d);(root/'attempt.json').write_text('{}');calls=[]
            def invoke(argv,**kw):
                calls.append(argv[-2])
                if argv[-2]=='--preflight':raise KeyboardInterrupt()
                return SimpleNamespace(returncode=0)
            with self.assertRaises(KeyboardInterrupt):packet.run_native_and_close(root,invoke,preflight_only=True)
            self.assertEqual(calls,['--preflight','--close-preflight'])

    def test_no_replay_for_unstarted_or_consumed_cleanup(self):
        import tempfile
        for consumed in (False,True):
            with tempfile.TemporaryDirectory(prefix='p08-command-proof-',dir='/private/tmp') as d:
                root=Path(d)
                if consumed:(root/'attempt.json').write_text('{}');(root/'independent-closeout.json').write_text('{}')
                calls=[]
                packet.run_native_and_close(root,lambda argv,**kw:(calls.append(argv[-2]) or SimpleNamespace(returncode=2)))
                self.assertEqual(calls,['--run'])


class RetainedScopeTests(PacketTests):
    def test_qualification_input_removal_preserves_in_memory_native_scope(self):
        self.sequence(False)
    def test_aq1_uses_run_and_independent_closeout_not_preflight_dispatch(self):
        self.sequence(False,'NATIVE_AUTH_QUALIFICATION_ONLY')
    def test_declined_native_approval_still_purges_without_native_dispatch(self):
        self.sequence(True)
    def sequence(self,declined,purpose=None):
        import tempfile
        from unittest.mock import patch
        e=packet.construct_values(self.spec,self.values,'we_synthetic',self.cap)
        candidate={**self.t.e['qualification'],'scopeSha256':digest(e['nativeScope'])}
        with tempfile.TemporaryDirectory(prefix='p08-sequence-proof-',dir='/private/tmp') as d:
            root=Path(d);slot=root/'input';slot.mkdir();(slot/'envelope.json').write_text('{}')
            cap=SimpleNamespace(external=True,mode='handoff',e={'qualificationId':self.spec['qualificationId']},input_root=slot,root=root,native_root=root/'native',clock=time.time)
            if purpose=='NATIVE_AUTH_QUALIFICATION_ONLY':
                _,e['nativeScope']['plan']['window'],e['nativeScope']['payment']['workEnd']=tc1_windows(int(time.time()))
                candidate['scopeSha256']=digest(e['nativeScope'])
            def qualify(args):
                (slot/'envelope.json').unlink();return 0
            def read(path):
                if path.name=='guard-envelope.json':return {}
                if path.parent==cap.native_root:return {'status':'ENTRY_CLOSED','paymentObserved':True}
                return {'status':'CURRENT_EVIDENCE_OBSERVED','liveObserved':True,'failure':None,'residuals':[],'candidate':candidate}
            def approve(native):
                self.assertFalse((slot/'envelope.json').exists())
                self.assertEqual(native['payment'],e['nativeScope']['payment'])
                if declined:raise RuntimeError('DECLINED')
                return {'synthetic':'approval reference only'}
            with patch.object(q,'handoff_recovered_bindings'),patch.object(q,'current_main',side_effect=qualify),patch.object(q,'private_json',side_effect=read),\
                 patch.object(q,'handoff_qualified_bindings') as transfer,patch.object(q,'BindingRecoveryCapability'),\
                 patch.object(q,'closeout_binding_recovery',return_value={'rawFilesAbsent':True,'resourceCloseout':{'verified':True}}) as purge,\
                 patch.object(packet,'run_native_and_close',return_value={'workExit':2,'closeoutExit':0}) as run:
                if declined:
                    with self.assertRaisesRegex(RuntimeError,'DECLINED') as stopped:packet.execute_connected(cap,e,approve)
                    self.assertEqual(stopped.exception.connected_stage,'NATIVE_APPROVAL')
                    run.assert_not_called();transfer.assert_not_called()
                else:
                    result=packet.execute_connected(cap,e,approve,native_purpose=purpose);self.assertTrue(result['privateInputsAbsent']);self.assertFalse(result['paymentReadyForAcceptance'])
                    self.assertEqual(transfer.call_args.args[1]['payment'],e['nativeScope']['payment'])
                    self.assertEqual(transfer.call_args.args[1].get('purpose'),purpose)
                    run.assert_called_once_with(cap.native_root)
                purge.assert_called_once()

for name in PacketTests.__dict__:
    if name.startswith('test_'):setattr(RetainedScopeTests,name,None)

class DiagnosticCustodyTests(unittest.TestCase):
    def test_actual_qualified_transfer_diagnostic_closeout_and_guard_purge(self):
        import shutil
        import test_qualification_launch as recovery_fixture
        t=native_fixture.ConnectedEntryTests();t.setUp();self.addCleanup(t.doCleanups)
        t.preflight_setup();envelope=copy.deepcopy(t.e);shutil.rmtree(t.root)
        f=recovery_fixture.BindingRecoveryTests();f.setUp();self.addCleanup(f.doCleanups)
        f.e.update(version=2,paymentAccountSha256=hashlib.sha256(b'acct_synthetic').hexdigest(),
                   nativeOperationId=envelope['plan']['operationId'],qualificationId=envelope['payment']['qualificationId'])
        target=envelope['target'];row={**target,'status':'DISABLED'}
        f.e['targetSha256']=hashlib.sha256(json.dumps(row,separators=(',',':')).encode()).hexdigest()
        f.e['projectNumberSha256']=q.model.digest(str(envelope['plan']['projectNumber']))
        f.e['window']['purgeEnd']=datetime.datetime.fromtimestamp(f.now+1100,datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')
        f.seal(f.e);cap=q.BindingRecoveryCapability(f.e,mode='handoff');f.cap=cap
        q.initialize_recovery(cap);guard=q.start_binding_guard(cap)
        try:
            rr=Path('/private/tmp/p08-current-proof-'+f.e['qualificationId']);rr.mkdir(mode=0o700)
            self.addCleanup(lambda:shutil.rmtree(rr,ignore_errors=True))
            q.model.reserve(rr/'attempt.json',{'operationId':f.e['qualificationId'],'scopeSha256':envelope['qualification']['scopeSha256']})
            q.model.reserve(rr/'result.json',{'status':'CURRENT_EVIDENCE_LOCAL_VERIFIED','candidate':envelope['qualification'],
                'failure':None,'residuals':[],'liveObserved':False})
            self.assertEqual(q.handoff_qualified_bindings(cap,envelope)['status'],'NATIVE_INPUT_TRANSFERRED')
            with self.assertRaises(FileExistsError):q.handoff_qualified_bindings(cap,envelope)
            result=native_fixture.entry.run_preflight_entry(t.path,'preflight',t.preflight_factory)
            self.assertTrue(result['preflightPassed'],result)
            result=native_fixture.entry.run_preflight_entry(t.path,'close-preflight',t.preflight_factory)
            self.assertEqual(result['status'],'NATIVE_PREFLIGHT_CLOSED')
            self.assertTrue(result['privateInputsAbsent'])
        finally:
            if not (cap.root/'purge-now.json').exists():q.model.reserve(cap.root/'purge-now.json',{})
            guard.wait(timeout=5)
        self.assertTrue(q.private_json(cap.root/'purge-result.json')['rawFilesAbsent'])


class Tc1TimingTests(unittest.TestCase):
    def setUp(self):
        self.now=10000.;qual,native,payment=tc1_windows(self.now)
        self.spec={'nativePurpose':'NATIVE_AUTH_QUALIFICATION_ONLY','recoveryId':str(uuid.uuid4()),
            'qualificationId':str(uuid.uuid4()),'prospectiveOperationId':str(uuid.uuid4()),'sourceCommit':'a'*40,
            'window':qual,'prospectiveWindow':native,'paymentWorkEnd':payment,'manifestSha256':q.source_manifest_sha256(),
            'paymentRequestId':str(uuid.uuid4()),'prospectiveLimits':{'cli':196,'https':100,'sql':60,'child':6,'childRequests':200}}
        self.cap=SimpleNamespace(e={'operationId':self.spec['recoveryId'],'qualificationId':self.spec['qualificationId'],
            'nativeOperationId':self.spec['prospectiveOperationId'],'sourceCommit':'a'*40},times={k:q.model.timestamp(v) for k,v in qual.items()},
            clock=lambda:self.now,external=True,hash='b'*64,root=Path('/private/tmp/synthetic-tc1'))
        self.result={'sourceCommit':'a'*40,'exitCode':0,'cliReserved':1,'cacheReserved':1,
            'executorRemoved':True,'decisionCommit':'c'*40,'reservation':'owner-signin-20990101-tr99',
            'status':'VALID_THROUGH_CUTOFF','validThrough':native['purgeEnd'],'completedAt':self.now-20,
            'localResiduals':[],'onTime':True,'leaderReaped':True,'groupAbsent':True,'configurationUnchanged':True}
        self.decision={'owner':'Debynyhan Banks','decision':'APPROVE_TR1_CREDENTIAL_RENEWAL_SDK_RETRY_CACHE_AND_CLEANUP',
            'externalActionAuthorized':True,'sourceCommit':'a'*40,'reservation':'owner-signin-20990101-tr99',
            'validThrough':native['purgeEnd'],'connectedSession':{'recoveryId':self.spec['recoveryId'],
                'qualificationId':self.spec['qualificationId'],'nativeOperationId':self.spec['prospectiveOperationId'],'purgeEnd':native['purgeEnd']}}
        self.spec['opening']={'receipt':{'commit':'d'*40,'path':'APP013_P08_TR99_CLOSEOUT_20990101.json','sha256':''},
            'decisionPath':'APP013_P08_TR99_DECISION_20990101.json'}
        self.seal()
    def seal(self):self.spec['opening']['receipt']['sha256']=q.model.digest(json.dumps(self.result).encode())
    def read(self,repo,commit,path):
        self.assertIn(commit,('c'*40,'d'*40))
        return json.dumps(self.result if commit=='d'*40 else self.decision).encode()
    def opening(self):return packet.verify_auth_opening(self.spec,self.cap,read_commit=self.read)
    def test_current_committed_opening_fixed_purge_and_actual_start_are_required(self):
        out=self.opening();self.assertTrue(out['openingVerified']);self.assertFalse(out['restorationGuaranteed'])
        self.assertEqual(out['forwardSeconds'],1800);self.assertEqual(out['latestAdmission'],self.now+200)
        self.assertEqual(out['purgeEnd'],self.now+3580)
        for mutate,code in [
            (lambda:self.result.update(validThrough=self.spec['window']['closeoutEnd']),'PACKET_OPENING_BINDING'),
            (lambda:self.decision['connectedSession'].update(nativeOperationId='stale'),'PACKET_OPENING_BINDING'),
            (lambda:self.result.update(sourceCommit='e'*40),'PACKET_OPENING_BINDING'),
            (lambda:self.result.update(exitCode=False),'PACKET_OPENING_BINDING'),
            (lambda:self.result.update(completedAt=self.now+1),'PACKET_OPENING_SEQUENCE'),
            (lambda:self.result.update(groupAbsent=False),'PACKET_OPENING_UNCONFIRMED')]:
            saved=(copy.deepcopy(self.result),copy.deepcopy(self.decision))
            with self.subTest(code=code):
                mutate();self.seal()
                with self.assertRaisesRegex(Exception,code):self.opening()
            self.result,self.decision=saved;self.seal()
    def test_insufficient_credential_coverage_cannot_be_rebound(self):
        self.result['validThrough']=self.decision['validThrough']=self.spec['window']['closeoutEnd'];self.seal()
        with self.assertRaisesRegex(Exception,'PACKET_CREDENTIAL_HORIZON'):self.opening()
        original=self.spec['prospectiveWindow']['purgeEnd']
        self.cap.times['purgeEnd']+=60
        with self.assertRaisesRegex(Exception,'PACKET_FIXED_PURGE'):self.opening()
        self.assertEqual(self.spec['prospectiveWindow']['purgeEnd'],original)
    def test_actual_recovery_record_is_bound_not_just_retained_status(self):
        record={'operationId':self.spec['recoveryId'],'sourceCommit':'a'*40,'scopeSha256':'b'*64,'startedAt':self.now,
            'status':'HANDOFF_RETAINED','failure':None,'residuals':[],'liveObserved':True}
        original=q.current_module;authority=original('authority')
        with patch.object(q,'private_json',return_value=record),patch.object(authority,'committed',side_effect=self.read),\
             patch.object(q,'current_module',side_effect=lambda name:authority if name=='authority' else original(name)):
            self.assertTrue(packet.verify_recovered_auth_opening(self.spec,self.cap)['openingVerified'])
            for key,value in [('startedAt',float('nan')),('operationId','other'),('scopeSha256','f'*64),('sourceCommit','f'*40)]:
                before=record[key];record[key]=value
                with self.subTest(key=key),self.assertRaisesRegex(Exception,'PACKET_RECOVERY_UNCONFIRMED'):
                    packet.verify_recovered_auth_opening(self.spec,self.cap)
                record[key]=before
    def test_pre_recovery_route_checks_opening_before_existing_interface_once(self):
        import connected_launcher as launcher
        from unittest.mock import Mock
        original=q.current_module;authority=original('authority')
        dispatched=Mock()
        def recovery(args,*,before_recover):before_recover(self.cap);dispatched();return 0
        with patch.object(authority,'committed',side_effect=self.read),patch.object(q,'recovery_main',side_effect=recovery) as run,\
             patch.object(q,'current_module',side_effect=lambda name:authority if name=='authority' else original(name)):
            launcher.recover_first(self.spec,'/private/tmp/synthetic-envelope')
            self.assertEqual(run.call_args.args,(['--recover-binding-inputs','/private/tmp/synthetic-envelope'],))
            run.assert_called_once();dispatched.assert_called_once()
            run.reset_mock();dispatched.reset_mock();self.decision['connectedSession']['nativeOperationId']='historical'
            with self.assertRaisesRegex(Exception,'PACKET_OPENING_BINDING'):
                launcher.recover_first(self.spec,'/private/tmp/synthetic-envelope')
            dispatched.assert_not_called();run.reset_mock()
            for mutation in (lambda s:s.update(extra=True),lambda s:s.update(manifestSha256='f'*64),
                             lambda s:s['prospectiveLimits'].update(cli=197),lambda s:s.update(paymentRequestId='bad')):
                bad=copy.deepcopy(self.spec);mutation(bad)
                with self.assertRaises(Exception):launcher.recover_first(bad,'/private/tmp/synthetic-envelope')
                run.assert_not_called()
    def test_actual_completion_boundary_and_unchanged_cleanup_reserve(self):
        e=packet.auth_spec_envelope(self.spec)
        for delta,accepted in [(199.999,True),(200,False),(201,False)]:
            with self.subTest(delta=delta):
                if accepted:self.assertEqual(packet.auth_timing(e,self.now+delta)['forwardSeconds'],1800)
                else:
                    with self.assertRaisesRegex(Exception,'PACKET_AUTH_ADMISSION'):packet.auth_timing(e,self.now+delta)
        bad=copy.deepcopy(e);bad['plan']['window']['cleanupEnd']=bad['plan']['window']['workEnd']
        with self.assertRaisesRegex(Exception,'PACKET_INDEPENDENT_RESERVE'):
            packet.composed_auth_timing(bad,self.cap.times,self.cap.times)
    def test_connected_sequence_rechecks_slow_qualification_and_approval(self):
        scope=packet.auth_spec_envelope(self.spec);scope.pop('version');scope.pop('purpose')
        scope['plan']['operationId']=self.spec['prospectiveOperationId']
        candidate={'operationId':self.spec['prospectiveOperationId'],'scopeSha256':q.model.digest(scope)}
        envelope={'nativeScope':scope,'sourceCommit':'a'*40}
        self.cap.mode='handoff';self.cap.input_root=Path('/private/tmp/synthetic-input');self.cap.native_root=Path('/private/tmp/synthetic-native')
        for phase,delta,accepted in [('qualification',199.9,True),('qualification',200,False),('approval',200,False),('handoff',200,False)]:
            self.now=10000.;events=[]
            def qualify(args):
                events.append('qualification')
                if phase=='qualification':self.now+=delta
            def approve(native):
                events.append('approval')
                if phase=='approval':self.now+=delta
                return {'synthetic':'exact-reference'}
            def handoff(*args):
                events.append('handoff')
                if phase=='handoff':self.now+=delta
            def read(path):
                if path.name=='guard-envelope.json':return {}
                if path.parent==self.cap.native_root:return {'status':'AUTH_QUALIFICATION_CLOSED'}
                return {'status':'CURRENT_EVIDENCE_OBSERVED','liveObserved':True,'failure':None,'residuals':[],'candidate':candidate}
            with self.subTest(phase=phase,delta=delta),patch.object(q,'handoff_recovered_bindings'),\
                 patch.object(q,'current_main',side_effect=qualify),patch.object(q,'private_json',side_effect=read),\
                 patch.object(q,'handoff_qualified_bindings',side_effect=handoff),patch.object(q,'BindingRecoveryCapability'),\
                 patch.object(q,'closeout_binding_recovery',return_value={'rawFilesAbsent':True,'resourceCloseout':{'verified':True}}) as close,\
                 patch.object(packet,'run_native_and_close',return_value={'workExit':0,'closeoutExit':0}) as dispatch:
                if accepted:packet.execute_connected(self.cap,envelope,approve,'NATIVE_AUTH_QUALIFICATION_ONLY');dispatch.assert_called_once()
                else:
                    with self.assertRaisesRegex(Exception,'PACKET_AUTH_ADMISSION'):
                        packet.execute_connected(self.cap,envelope,approve,'NATIVE_AUTH_QUALIFICATION_ONLY')
                    dispatch.assert_not_called()
                    if phase=='qualification':self.assertNotIn('approval',events)
                close.assert_called_once()
    def test_endpoint_and_git_calls_are_actually_bounded(self):
        import connected_launcher as launcher,subprocess,signal
        from contextlib import redirect_stdout
        import io
        spec={'recoveryId':'synthetic','window':{'cutoff':'1970-01-01T00:00:01Z'}}
        output=io.StringIO();old_handler=signal.getsignal(signal.SIGALRM)
        with redirect_stdout(output),patch.object(packet,'construct') as construct:
            self.assertEqual(launcher.main(spec,read_hidden=lambda _:time.sleep(2),clock=lambda:.95),2)
            construct.assert_not_called()
        self.assertIn('CONNECTED_STOP_ENDPOINT_INPUT_DEADLINE',output.getvalue())
        self.assertEqual(signal.getsignal(signal.SIGALRM),old_handler);self.assertEqual(signal.getitimer(signal.ITIMER_REAL),(0.,0.))
        with patch('subprocess.check_output',side_effect=subprocess.TimeoutExpired('git',.1)) as git:
            with self.assertRaisesRegex(Exception,'EXACT_APPROVAL_DEADLINE'):
                packet.wait_committed_decision(Path('/private/tmp'),'APP013_P08_NATIVE_OPERATION_20990101.json',{},0,1,clock=lambda:0)
            self.assertLessEqual(git.call_args.kwargs['timeout'],1)


class Tc1SupervisorTests(unittest.TestCase):
    def setUp(self):
        import tempfile
        self.temp=tempfile.TemporaryDirectory(prefix='p08-tc1-supervisor-',dir='/private/tmp');self.addCleanup(self.temp.cleanup)
        self.root=Path(self.temp.name);now=time.time();_,native,payment=tc1_windows(now)
        self.e={'version':2,'purpose':'NATIVE_AUTH_QUALIFICATION_ONLY','execution':'PROOF_ONLY',
            'sourceCommit':'a'*40,'plan':{'operationId':'synthetic-operation','window':native},'payment':{'workEnd':payment},
            'limits':{'cli':196,'sql':60,'child':6}}
    def journal(self,pid,started,ack,rows=None):
        rows=[] if rows is None else rows
        parent={'pid':pid,'startedAt':started}
        counts={k:sum(r['kind']==k.upper() for r in rows) for k in ('cli','sql','child')}
        proof={'version':1,'operationId':self.e['plan']['operationId'],'envelopeSha256':q.model.digest(self.e),
            'sourceCommit':self.e['sourceCommit'],'parent':parent,'ownedChildren':rows,
            'inventoryComplete':True,'groupsAbsent':True,'acknowledgedAt':ack}
        return {'operationId':proof['operationId'],'planSha256':q.model.digest(self.e['plan']),
            'nativeEntry':{'parent':parent,'envelopeSha256':proof['envelopeSha256'],'calls':counts,
                           'ownedChildren':rows,'mainClosure':proof}}
    def test_exact_parent_inventory_source_and_group_absence_required(self):
        process=SimpleNamespace(pid=4242,poll=lambda:0)
        rows=[{'ordinal':1,'kind':'CHILD','pid':5252,'pgid':5252,'state':'CLOSED'}]
        good=self.journal(4242,101,102,rows)
        def check(j,absent=True):
            with patch.object(q,'private_json',return_value=j):
                return packet.verify_main_closure(self.root,self.e,process,100,103,group_absent=lambda _:absent)
        self.assertTrue(check(good)['inventoryComplete'])
        for mutate,code in [(lambda j:j['nativeEntry']['mainClosure'].update(sourceCommit='f'*40),'NATIVE_CLOSURE_BINDING'),
            (lambda j:j['nativeEntry']['mainClosure'].update(parent={'pid':999,'startedAt':101}),'NATIVE_CLOSURE_PARENT'),
            (lambda j:j['nativeEntry']['mainClosure'].update(ownedChildren=[]),'NATIVE_CLOSURE_INVENTORY'),
            (lambda j:j['nativeEntry']['ownedChildren'][0].update(state='SPAWNED'),'NATIVE_CLOSURE_INVENTORY')]:
            bad=copy.deepcopy(good);mutate(bad)
            with self.subTest(code=code),self.assertRaisesRegex(Exception,code):check(bad)
        with self.assertRaisesRegex(Exception,'NATIVE_CHILD_GROUP_UNCONFIRMED'):check(good,False)
        empty=self.journal(4242,101,102);empty['nativeEntry']['calls']['cli']=1
        with self.assertRaisesRegex(Exception,'NATIVE_CLOSURE_INVENTORY'):check(empty)
    def test_no_independent_dispatch_without_proof_full_reserve_or_unconsumed_slot(self):
        (self.root/'envelope.json').write_text(json.dumps(self.e));(self.root/'envelope.json').chmod(0o600)
        for failure in ('proof','reserve','consumed','okay'):
            for file in ('attempt.json','independent-closeout.json'):(self.root/file).unlink(missing_ok=True)
            calls=[]
            def supervise(command,envelope,root,**kw):
                calls.append(command[-2])
                if command[-2]=='--run':
                    if failure=='proof':raise q.model.Stop('NATIVE_CLOSURE_PROOF')
                    (root/'attempt.json').write_text('{}')
                    if failure=='consumed':(root/'independent-closeout.json').write_text('{}')
                return 0
            now=q.model.timestamp(self.e['plan']['window']['workEnd'])+(1 if failure=='reserve' else -1)
            with self.subTest(failure=failure),patch.object(packet,'auth_timing'),\
                 patch.object(packet,'supervise_attended_parent',side_effect=supervise),patch('time.time',return_value=now):
                if failure=='okay':self.assertEqual(packet.run_native_and_close(self.root),{'workExit':0,'closeoutExit':0})
                else:
                    with self.assertRaises(Exception):packet.run_native_and_close(self.root)
            self.assertEqual(calls,['--run','--closeout'] if failure=='okay' else ['--run'])
        with patch.object(packet,'supervise_attended_parent') as run:
            with self.assertRaisesRegex(Exception,'NATIVE_ATTEMPT_CONSUMED'):packet.run_native_and_close(self.root)
            run.assert_not_called()
    def test_rollback_waits_for_exact_parent_to_close_before_unwinding(self):
        import signal
        state={'wall':100.,'mono':0.,'polls':0,'sent':False};events=[]
        def poll():
            state['polls']+=1
            return 0 if state['sent'] and state['polls']>5 else None
        process=SimpleNamespace(pid=999,poll=poll,returncode=0,
            send_signal=lambda s:(self.assertEqual(s,signal.SIGTERM),events.append('abort'),state.update(sent=True)),
            wait=lambda **kw:events.append('exit'))
        def clock():state['wall']-=.01;return state['wall']
        def monotonic():state['mono']+=.01;return state['mono']
        with self.assertRaisesRegex(Exception,'CLOCK_ROLLBACK'):
            packet.supervise_attended_parent(['synthetic'],self.e,self.root,clock=clock,monotonic=monotonic,
                sleep=lambda _:None,popen=lambda *a,**kw:process,read_closure=lambda *args:events.append('proof'))
        self.assertEqual(events,['abort','exit'])
    def test_post_exit_clock_and_monotonic_checks_cannot_be_skipped(self):
        for wall,ticks,code in [([100,99],[0,.01],'CLOCK_ROLLBACK'),
                                ([100,100],[0,100000000000.],'NATIVE_PARENT_CLOSURE_UNCONFIRMED')]:
            process=SimpleNamespace(pid=999,poll=lambda:0,returncode=0,wait=lambda **kw:None)
            with self.subTest(code=code),self.assertRaisesRegex(Exception,code),patch.object(packet,'verify_main_closure'):
                packet.supervise_attended_parent(['synthetic'],self.e,self.root,clock=iter(wall).__next__,
                    monotonic=iter(ticks).__next__,popen=lambda *a,**kw:process,
                    read_closure=lambda *args:self.fail('must refuse before closure acceptance'))
    def test_real_pty_preserves_hidden_input_and_reaps_detached_owned_child(self):
        self.pty_boundary(False)
    def test_real_supervisor_abort_closes_owned_descendants_before_parent_exit(self):
        self.pty_boundary(True)
    def pty_boundary(self,cooperative):
        import os,pty,select,signal,subprocess
        native_path=str(q.current_module('authority').HERE)
        code='''import os,sys,time,json,getpass,subprocess,signal
from pathlib import Path
from types import SimpleNamespace
sys.path.insert(0,sys.argv[1]);sys.path.insert(0,sys.argv[2])
import packet
from native_io import NativeIO
from entry import Coordinator
root=Path(sys.argv[3]);e=json.loads((root/'envelope.json').read_text())
parent={'pid':os.getpid(),'startedAt':time.time()}
j={'operationId':e['plan']['operationId'],'planSha256':packet.q.model.digest(e['plan']),'residuals':[],
   'nativeEntry':{'parent':parent,'envelopeSha256':packet.q.model.digest(e),'ownedChildren':[],
                  'calls':{'cli':0,'sql':0,'child':1}}}
def save():
    path=root/'journal.json';path.write_text(json.dumps(j));path.chmod(0o600)
save()
assert getpass.getpass('Fictional password (hidden): ')=='fixture-only-no-echo'
print('FICTIONAL_INPUT_ACCEPTED',flush=True)
abort=[False]
signal.signal(signal.SIGTERM,lambda *_:abort.__setitem__(0,True))
def gate(cleanup=False):
    if abort[0]:raise packet.q.model.Stop('SYNTHETIC_COOPERATIVE_ABORT')
cap=SimpleNamespace(e=e,mode='run',clock=time.time,times={'cleanupEnd':time.time()+15},
                    gate=gate,dispatch_serial=0,envelope_hash=packet.q.model.digest(e))
io=object.__new__(NativeIO);io.cap=cap;io.cleanup=False;io.child_processes=set();io.child_cleanup_unconfirmed=False
cap.coordinator=SimpleNamespace(j=j,save=save)
child="import subprocess,sys,time; p=subprocess.Popen([sys.executable,'-c','import time;time.sleep(30)']); time.sleep(30)"
try:io._owned_process([sys.executable,'-c',child],b'',{'PATH':'/usr/bin:/bin'},15 if sys.argv[4]=='abort' else .3,False,8192,'child')
except subprocess.TimeoutExpired:pass
except packet.q.model.Stop:
    assert abort[0]
    print('COOPERATIVE_ABORT_OBSERVED',flush=True)
co=object.__new__(Coordinator);co.auth_only=True;co.cap=cap;co.io=io;co.j=j;co.clock=time.time
co.times={k:packet.q.model.timestamp(v) for k,v in e['plan']['window'].items()};co.plan=e['plan'];co.save=save
co.acknowledge_main_closure()
print('OWNED_PROCESS_CLOSED',flush=True)
'''
        script=self.root/'fixture.py';script.write_text(code)
        if cooperative:
            self.e['plan']['window']['workEnd']=datetime.datetime.fromtimestamp(time.time()+6,datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')
        self.e['execution']='EXTERNAL';(self.root/'envelope.json').write_text(json.dumps(self.e))
        sentinel=subprocess.Popen([sys.executable,'-c','import time;time.sleep(30)'],start_new_session=True,
            stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
        def close_sentinel():
            if sentinel.poll() is None:sentinel.terminate()
            sentinel.wait(timeout=3)
        self.addCleanup(close_sentinel)
        pid,master=pty.fork()
        if pid==0:
            try:
                result=packet.supervise_attended_parent([sys.executable,'-I','-B',str(script),str(Path(packet.__file__).parent),native_path,str(self.root),'abort' if cooperative else 'timeout'],self.e,self.root)
                print('SUPERVISOR_RESULT_'+str(result),flush=True);os._exit(0)
            except BaseException as error:
                print('SUPERVISOR_ERROR_'+type(error).__name__+':'+str(error),flush=True);os._exit(2)
        transcript=b'';sent=False;status=None;end=time.monotonic()+12
        try:
            while time.monotonic()<end:
                if select.select([master],[],[],.1)[0]:
                    try:chunk=os.read(master,65536)
                    except OSError:chunk=b''
                    transcript+=chunk
                    if not sent and b'Fictional password (hidden): ' in transcript:
                        os.write(master,b'fixture-only-no-echo\n');sent=True
                got,status=os.waitpid(pid,os.WNOHANG)
                if got:break
            else:self.fail('harmless PTY supervisor did not close')
            self.assertEqual(os.waitstatus_to_exitcode(status),0,transcript.decode(errors='replace'))
            self.assertTrue(sent);self.assertIn(b'FICTIONAL_INPUT_ACCEPTED',transcript)
            self.assertNotIn(b'fixture-only-no-echo',transcript)
            self.assertIn(b'SUPERVISOR_RESULT_0',transcript)
            if cooperative:self.assertIn(b'COOPERATIVE_ABORT_OBSERVED',transcript)
            self.assertIsNone(sentinel.poll())
            journal=json.loads((self.root/'journal.json').read_text())
            self.assertEqual(journal['nativeEntry']['ownedChildren'][0]['state'],'CLOSED')
            self.assertTrue(packet._group_absent(journal['nativeEntry']['ownedChildren'][0]['pgid']))
        finally:
            os.close(master)
            try:got,_=os.waitpid(pid,os.WNOHANG)
            except ChildProcessError:got=pid
            if not got:os.kill(pid,signal.SIGTERM);os.waitpid(pid,0)
