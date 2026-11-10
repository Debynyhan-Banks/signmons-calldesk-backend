import copy,datetime,hashlib,json,sys,time,unittest,uuid
from pathlib import Path
from types import SimpleNamespace
import packet
q=packet.q
sys.path.insert(0,str(q.model.ROOT.parent.parent/'p08-native-entry-local-20261101/source'))
import test_entry as native_fixture
from authority import Capability,digest

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
    def test_foreign_operation_manifest_account_and_limits_refuse(self):
        for key,value in [('qualificationId',str(uuid.uuid4())),('prospectiveOperationId',str(uuid.uuid4())),('sourceCommit','f'*40),('manifestSha256','f'*64),('prospectiveLimits',{'cli':1})]:
            spec={**self.spec,key:value}
            with self.subTest(key=key),self.assertRaises(Exception):packet.construct_values(spec,self.values,'we_synthetic',self.cap)
        values=copy.deepcopy(self.values);values['paymentBinding']['connectedAccountSha256']='f'*64
        with self.assertRaises(Exception):packet.construct_values(self.spec,values,'we_synthetic',self.cap)
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
    def test_declined_native_approval_still_purges_without_native_dispatch(self):
        self.sequence(True)
    def sequence(self,declined):
        import tempfile
        from unittest.mock import patch
        e=packet.construct_values(self.spec,self.values,'we_synthetic',self.cap)
        candidate={**self.t.e['qualification'],'scopeSha256':digest(e['nativeScope'])}
        with tempfile.TemporaryDirectory(prefix='p08-sequence-proof-',dir='/private/tmp') as d:
            root=Path(d);slot=root/'input';slot.mkdir();(slot/'envelope.json').write_text('{}')
            cap=SimpleNamespace(external=True,mode='handoff',e={'qualificationId':self.spec['qualificationId']},input_root=slot,root=root,native_root=root/'native')
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
                    with self.assertRaisesRegex(RuntimeError,'DECLINED'):packet.execute_connected(cap,e,approve)
                    run.assert_not_called();transfer.assert_not_called()
                else:
                    result=packet.execute_connected(cap,e,approve);self.assertTrue(result['privateInputsAbsent']);self.assertFalse(result['paymentReadyForAcceptance'])
                    self.assertEqual(transfer.call_args.args[1]['payment'],e['nativeScope']['payment'])
                purge.assert_called_once()

for name in PacketTests.__dict__:
    if name.startswith('test_'):setattr(RetainedScopeTests,name,None)
