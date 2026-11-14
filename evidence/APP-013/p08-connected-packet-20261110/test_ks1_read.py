import copy,io,json,shutil,time,unittest,uuid
from contextlib import redirect_stdout
from pathlib import Path
from unittest.mock import patch
import ks1_read as k

class KeyReadTests(unittest.TestCase):
    def setUp(self):
        self.plan={'projectNumber':'123456789012','keyId':k.KEY,'operationId':k.R44}
        self.value={'name':k.key.RequestAdapter(self.plan).key,'uid':str(uuid.uuid4()),'etag':'synthetic','displayName':'Signmons P08 '+k.R44,'restrictions':k.key.RESTRICTIONS}
    def reply(self,value,status=200):return {'httpStatus':status,'body':json.dumps(value)}
    def test_present(self):self.assertEqual(k.classify(self.plan,self.reply(self.value)),'PRESENT_MATCHING_METADATA')
    def test_deleted(self):self.assertEqual(k.classify(self.plan,self.reply({**self.value,'deleteTime':'2026-11-14T12:00:00Z'})),'DELETED_MATCHING_METADATA')
    def test_typed_absence(self):self.assertEqual(k.classify(self.plan,self.reply({'error':{'status':'NOT_FOUND','code':404}},404)),'ABSENT_AT_READ')
    def test_unqualified_absence(self):
        for value,status in [({},404),({'error':{'status':'PERMISSION_DENIED','code':403}},403),({'error':{'status':'NOT_FOUND','code':404}},200)]:
            with self.subTest(value=value,status=status),self.assertRaises(Exception):k.classify(self.plan,self.reply(value,status))
    def test_foreign_or_malformed_metadata(self):
        for name,bad in [('name','foreign'),('uid','not-uuid'),('etag',''),('displayName','foreign'),('restrictions',{}),('deleteTime',None),('deleteTime','bad'),('keyString','SECRET_CANARY')]:
            with self.subTest(field=name),self.assertRaises(Exception):k.classify(self.plan,self.reply({**self.value,name:bad}))
    def test_nonobject_or_invalid_json(self):
        for raw in ('null','[]','{'):
            with self.subTest(raw=raw),self.assertRaises(Exception):k.classify(self.plan,{'httpStatus':200,'body':raw})
    def test_actual_https_boundary_and_descriptor(self):
        d=next(x for x in k.q.access_https_contract(self.plan['projectNumber'],k.KEY) if x['id']=='key_absence')
        class Response:
            status=200
            def read(inner,size):return json.dumps(self.value).encode()
            def close(inner):pass
        transport=k.q.NativeIO(time.time,str(uuid.uuid4()))
        with patch.object(k.q.urllib.request,'build_opener') as build:
            build.return_value.open.return_value=Response()
            r=transport.https(d,'SYNTHETIC_TOKEN',time.time()+15)
            req=build.return_value.open.call_args.args[0]
            self.assertEqual(req.get_method(),'GET');self.assertEqual(req.full_url,d['url']);self.assertIsNone(req.data)
            self.assertEqual(k.classify(self.plan,{'httpStatus':r['status'],'body':r['body'].decode()}),'PRESENT_MATCHING_METADATA')
        self.assertTrue(transport.close(time.time()+3))
    def test_executor_one_attempt_cleanup_and_redaction(self):
        self.exercise()
    def test_executor_failure_still_closes_no_retry(self):
        self.exercise(fail=True)
    def test_executor_interrupt_still_closes(self):
        self.exercise(interrupt=True)
    def exercise(self,fail=False,interrupt=False):
        op=str(uuid.uuid4());root=Path('/private/tmp/p08-ks1-'+op);self.addCleanup(lambda:shutil.rmtree(root,ignore_errors=True))
        s={'operationId':op,'sourceCommit':'0'*40};d={'owner':'Debynyhan Banks','decision':'APPROVE_KS1_KEY_METADATA_READ_CACHE_SDK_EXCEPTION_AND_CLEANUP','scopeSha256':k.m.digest(s),'externalReadAuthorized':True}
        commands=[next(x for x in k.q.current_cli_contract() if x['id']==n) for n in ('owner','project')]
        t={'cutoff':time.time()+30,'readEnd':time.time()+45,'closeoutEnd':time.time()+60}
        with patch.object(k.a,'committed',side_effect=lambda repo,commit,path:json.dumps(s if 'SCOPE' in path else d).encode()),patch.object(k,'preflight',return_value=(t,commands,{},'same')),patch.object(k.q,'NativeIO') as io_mock,patch.object(k.acl,'config_snapshot',return_value='same'),patch.object(k.acl,'read_cached_token',return_value='TOKEN_CANARY') as cache,patch.object(k.q,'validate_recovery_project'):
            native=io_mock.return_value
            native._owned_run.side_effect=[json.dumps([{'account':k.m.OWNER,'status':'ACTIVE'}]).encode(),json.dumps({'projectNumber':self.plan['projectNumber']}).encode()]
            native.https.return_value={'status':200,'body':json.dumps(self.value).encode()};native.close.return_value=True
            if fail:native.https.side_effect=RuntimeError('SECRET_CANARY')
            if interrupt:native.https.side_effect=KeyboardInterrupt()
            out=io.StringIO()
            with redirect_stdout(out):rc=k.execute('1'*40,'APP013_P08_KS1_KEY_STATE_SCOPE_20261114.json','APP013_P08_KS1_KEY_STATE_APPROVAL_20261114.json')
            result=json.loads((root/'result.json').read_text());self.assertEqual(result['counts'],{'cli':2,'cache':1,'https':1});self.assertEqual(rc,2 if fail or interrupt else 0)
            self.assertEqual(native.https.call_count,1);self.assertEqual(cache.call_count,1);self.assertEqual(native.close.call_count,1)
            self.assertTrue(result['processCleanupVerified']);self.assertNotIn('TOKEN_CANARY',out.getvalue());self.assertNotIn('SECRET_CANARY',out.getvalue())
            with self.assertRaises(FileExistsError):k.execute('1'*40,'APP013_P08_KS1_KEY_STATE_SCOPE_20261114.json','APP013_P08_KS1_KEY_STATE_APPROVAL_20261114.json')
            self.assertEqual(native.https.call_count,1)
if __name__=='__main__':unittest.main()
