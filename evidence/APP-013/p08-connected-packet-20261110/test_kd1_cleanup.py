import copy,io,json,unittest,uuid,urllib.error
from unittest.mock import patch
import kd1_cleanup as d

class CleanupTests(unittest.TestCase):
    def setUp(self):
        self.now=1794659100.;self.plan={'projectNumber':'123456789012','keyId':d.k.KEY,'operationId':d.k.R44}
        self.meta={'name':d.key.RequestAdapter(self.plan).key,'uid':str(uuid.uuid4()),'etag':'etag/synthetic','displayName':'Signmons P08 '+d.k.R44,'restrictions':d.key.RESTRICTIONS,'createTime':'2026-11-14T12:20:00Z'}
        self.interval=(1794658320.,1794658949.071717);self.t={'workEnd':self.now+200,'readEnd':self.now+260}
        self.requests=[];self.reserved=[];self.poll=0;self.complete_at=1;self.deleted=False;self.scenario='normal'
        self.engine=d.Cleanup(self.plan,self.interval,self.t,self.transport,self.reserve,clock=lambda:self.now,pause=self.pause)
    def pause(self,seconds):self.assertEqual(seconds,10);self.now+=seconds
    def reserve(self,label):self.assertNotIn(label,self.reserved);self.reserved.append(label)
    def reply(self,value,status=200):return {'httpStatus':status,'body':json.dumps(value)}
    def transport(self,request,end):
        self.requests.append(copy.deepcopy(request));method=request['method'];url=request['url']
        if method=='DELETE':
            self.assertTrue(url.endswith('?etag=etag%2Fsynthetic'))
            if self.scenario=='lost':self.deleted=True;raise RuntimeError('SECRET_CANARY')
            if self.scenario=='interrupt':self.deleted=True;raise KeyboardInterrupt()
            return self.reply({'name':'operations/synthetic'})
        if '/operations/' in url:
            self.poll+=1
            if self.poll==self.complete_at:
                self.deleted=True;return self.reply({'name':'operations/synthetic','done':True,'response':{}})
            return self.reply({'name':'operations/synthetic'})
        if self.scenario=='absent':return self.reply({'error':{'status':'NOT_FOUND','code':404}},404)
        if self.scenario=='denied':return self.reply({'error':{'status':'PERMISSION_DENIED','code':403}},403)
        meta=copy.deepcopy(self.meta)
        if self.deleted:meta['deleteTime']='2026-11-14T12:40:00Z'
        if self.scenario=='uiddrift' and self.engine.final:meta['uid']=str(uuid.uuid4())
        return self.reply(meta)
    def test_async_omitted_done(self):
        r=self.engine.run();self.assertEqual(r['status'],'CONTROL_PLANE_DELETED');self.assertEqual(r['httpsReserved'],4);self.assertEqual(r['pollsReserved'],1)
    def test_fifth_poll_evaluated(self):
        self.complete_at=5;r=self.engine.run();self.assertEqual(r['status'],'CONTROL_PLANE_DELETED');self.assertEqual(r['httpsReserved'],8)
    def test_poll_limit_final_get_no_second_delete(self):
        self.complete_at=6;r=self.engine.run();self.assertEqual(r['status'],'PRESENT_UNRESOLVED');self.assertEqual(r['pollsReserved'],5);self.assertEqual(sum(x['method']=='DELETE' for x in self.requests),1);self.assertEqual(self.reserved[-1],'final')
    def test_lost_response_final_get(self):
        self.scenario='lost';r=self.engine.run();self.assertEqual(r['status'],'CONTROL_PLANE_DELETED');self.assertIsNotNone(r['mutationFailure']);self.assertNotIn('SECRET_CANARY',json.dumps(r));self.assertEqual(sum(x['method']=='DELETE' for x in self.requests),1)
    def test_interrupt_final_get(self):
        self.scenario='interrupt';r=self.engine.run();self.assertEqual(r['status'],'CONTROL_PLANE_DELETED');self.assertEqual(r['mutationFailure'],'INTERRUPTED')
    def test_absence_no_delete(self):
        self.scenario='absent';r=self.engine.run();self.assertEqual(r['status'],'ABSENT_AT_READ');self.assertFalse(r['deleteReserved']);self.assertEqual(len(self.requests),2)
    def test_denial_not_absence(self):
        self.scenario='denied';r=self.engine.run();self.assertEqual(r['status'],'UNKNOWN');self.assertFalse(r['deleteReserved'])
    def test_foreign_or_creation_drift_refuses_delete(self):
        for field,value in [('displayName','foreign'),('restrictions',{}),('uid','wrong'),('etag',''),('createTime','2026-11-13T12:20:00Z'),('createTime',None),('keyString','SECRET')]:
            with self.subTest(field=field):
                self.setUp();self.meta[field]=value;r=self.engine.run();self.assertFalse(r['deleteReserved']);self.assertEqual(r['status'],'UNKNOWN')
    def test_uid_drift_refuses_closed_claim(self):
        self.scenario='uiddrift';r=self.engine.run();self.assertEqual(r['status'],'UNKNOWN');self.assertEqual(r['readbackFailure'],'FINAL_READ_UNCONFIRMED')
    def test_already_deleted_no_mutation(self):
        self.deleted=True;r=self.engine.run();self.assertEqual(r['status'],'CONTROL_PLANE_DELETED');self.assertFalse(r['deleteReserved'])
    def test_expired_work_preserves_final_read_budget(self):
        self.now=self.t['workEnd'];r=self.engine.run();self.assertFalse(r['deleteReserved']);self.assertEqual(self.reserved,['final'])
    def test_foreign_transport_refused(self):
        for method,url in [('GET','https://apikeys.googleapis.com/v2/foreign'),('GET',self.engine.base+'/keyString'),('POST',self.engine.base),('DELETE',self.engine.base+'?etag=wrong')]:
            with self.subTest(method=method,url=url),self.assertRaises(Exception):self.engine.dispatch({'method':method,'url':url,'body':None,'redirect':'error','timeoutSeconds':8})
        self.assertEqual(self.requests,[])
    def test_http_success_closed(self):
        with patch.object(d.urllib.request,'build_opener') as build:
            response=build.return_value.open.return_value;response.status=200;response.read.return_value=b'{}'
            r=d.send({'method':'GET','url':self.engine.base},'TOKEN',d.time.time()+10)
            self.assertEqual(r['httpStatus'],200);response.close.assert_called_once()
    def test_http_error_closed(self):
        body=io.BytesIO(b'{"error":{"code":403,"status":"PERMISSION_DENIED"}}')
        err=urllib.error.HTTPError(self.engine.base,403,'forbidden',{},body)
        with patch.object(d.urllib.request,'build_opener') as build:
            build.return_value.open.side_effect=err;r=d.send({'method':'GET','url':self.engine.base},'TOKEN',d.time.time()+10)
            self.assertEqual(r['httpStatus'],403);self.assertTrue(body.closed)
    def test_http_oversize_closed(self):
        with patch.object(d.urllib.request,'build_opener') as build:
            response=build.return_value.open.return_value;response.status=200;response.read.return_value=b'x'*65537
            with self.assertRaises(Exception):d.send({'method':'GET','url':self.engine.base},'TOKEN',d.time.time()+10)
            response.close.assert_called_once()
if __name__=='__main__':unittest.main()
