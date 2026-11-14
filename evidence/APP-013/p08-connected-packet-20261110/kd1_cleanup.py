"""Exact R44 key containment; disabled until separate committed owner approval."""
import datetime,fcntl,json,os,re,sqlite3,sys,time,urllib.error,urllib.request
from pathlib import Path
from types import SimpleNamespace
from urllib.parse import quote
import ks1_read as k
p,q,m,a,acl,key=k.p,k.q,k.m,k.a,k.acl,k.key

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self,*args,**kwargs):return None

def send(descriptor,token,deadline):
    response=None
    try:
        with acl.http_deadline(max(.001,min(8,deadline-time.time()))):
            request=urllib.request.Request(descriptor['url'],method=descriptor['method'],data=None,
                headers={'Authorization':'Bearer '+token,'Content-Type':'application/json','x-goog-user-project':m.PROJECT})
            try:response=urllib.request.build_opener(urllib.request.ProxyHandler({}),NoRedirect()).open(request,timeout=max(.001,min(8,deadline-time.time())))
            except urllib.error.HTTPError as error:response=error
            raw=response.read(65537);status=response.status
            m.need(time.time()<deadline and len(raw)<=65536 and not 300<=status<400,'KD1_HTTP')
            return {'httpStatus':status,'body':raw.decode('utf-8','strict')}
    finally:
        if response is not None:response.close()

def metadata(plan,value,interval):
    state=k.classify(plan,{'httpStatus':200,'body':json.dumps(value)})
    created=value.get('createTime')
    m.need(isinstance(created,str) and re.fullmatch(r'\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.[0-9]{1,9})?Z',created),'KD1_CREATE_TIME')
    ts=datetime.datetime.fromisoformat(created.replace('Z','+00:00')).timestamp()
    m.need(interval[0]<=ts<=interval[1],'KD1_CREATE_INTERVAL')
    return state

class Cleanup:
    def __init__(self,plan,interval,times,transport,reserve,clock=time.time,pause=time.sleep):
        self.plan,self.interval,self.t,self.transport,self.reserve,self.clock=plan,interval,times,transport,reserve,clock
        self.adapter=key.RequestAdapter(plan,transport=self.dispatch);self.base='https://apikeys.googleapis.com/v2/'+self.adapter.key
        self.uid=self.etag=None;self.last=clock();self.final=False;self.https=0;self.polls=0;self.deleted=False
        self.waiter=SimpleNamespace(a=self.adapter,j={},save=lambda:None,gate=self.gate,t={'workEnd':times['workEnd'],'cleanupEnd':times['workEnd']},clock=clock,pause=pause,invoke=lambda fn,*args,**kwargs:fn(*args))
    def gate(self,cleanup=False):
        now=self.clock();m.need(self.last<=now<self.t['readEnd' if self.final else 'workEnd'],'KD1_DEADLINE');self.last=now
    def dispatch(self,d):
        self.gate();m.need(set(d)=={'method','url','body','timeoutSeconds','redirect'} and d['body'] is None and d['redirect']=='error' and d['timeoutSeconds']==8,'KD1_DESCRIPTOR')
        method,url=d['method'],d['url']
        if method=='GET' and url==self.base:
            label='final' if self.final else 'initial'
        elif not self.final and method=='DELETE' and self.etag and url==self.base+'?etag='+quote(self.etag,safe=''):
            m.need(not self.deleted,'KD1_DELETE_REPLAY');label='delete'
        elif not self.final and method=='GET' and self.waiter.j.get('deleteOperation') and url=='https://apikeys.googleapis.com/v2/'+self.waiter.j['deleteOperation']:
            m.need(self.polls<5,'KD1_POLLS');self.polls+=1;label='poll-'+str(self.polls)
        else:raise m.Stop('KD1_REQUEST_SCOPE')
        m.need(self.https<8,'KD1_BUDGET');self.reserve(label);self.https+=1
        if label=='delete':self.deleted=True
        return self.transport(d,self.t['readEnd' if self.final else 'workEnd'])
    def run(self):
        result={'status':'UNKNOWN','mutationFailure':None,'readbackFailure':None,'deleteReserved':False}
        try:
            initial=self.adapter.key_get()
            if initial!={'status':'NOT_FOUND'}:
                state=metadata(self.plan,initial,self.interval);self.uid,self.etag=initial['uid'],initial['etag']
                if state=='PRESENT_MATCHING_METADATA':
                    operation=self.adapter.key_delete(self.etag)
                    key.Controller.wait(self.waiter,operation,'delete',cleanup=True)
        except BaseException as error:result['mutationFailure']='INTERRUPTED' if isinstance(error,(KeyboardInterrupt,SystemExit)) else 'DELETE_OR_PRECHECK_UNCONFIRMED'
        finally:
            self.final=True
            try:
                current=self.adapter.key_get()
                if current=={'status':'NOT_FOUND'}:result['status']='ABSENT_AT_READ'
                else:
                    state=metadata(self.plan,current,self.interval)
                    m.need(self.uid is not None and current['uid']==self.uid,'KD1_UID_DRIFT')
                    result['status']='CONTROL_PLANE_DELETED' if state=='DELETED_MATCHING_METADATA' else 'PRESENT_UNRESOLVED'
            except BaseException:result['readbackFailure']='FINAL_READ_UNCONFIRMED'
            result.update(deleteReserved=self.deleted,httpsReserved=self.https,pollsReserved=self.polls)
            self.uid=self.etag=None;self.waiter.j.clear()
        return result

def preflight(s):
    m.exact_uuid(s['operationId'],'KD1_ID')
    m.need(s['action']=='ADOPT_AND_REMOVE_EXACT_R44_KEY_ONCE' and s['r44OperationId']==k.R44 and s['keyId']==k.KEY,'KD1_SCOPE')
    m.need(s['limits']=={'cli':2,'cache':1,'https':8,'sql':0,'delete':1,'polls':5} and s['sdkException']=='SDK_EXISTING_OWNER_REFRESH_CACHE_INTERNAL_RETRIES_NO_TOKEN_EXPORT','KD1_LIMITS')
    t={n:m.timestamp(v) for n,v in s['window'].items()}
    m.need(set(t)=={'start','cutoff','workEnd','readEnd','closeoutEnd'} and t['start']<=time.time()<t['cutoff']<t['workEnd']<t['readEnd']<t['closeoutEnd'],'KD1_WINDOW')
    m.need(t['readEnd']-t['workEnd']>=60 and t['closeoutEnd']-t['readEnd']>=60,'KD1_RESERVE')
    manifest=m.verify_local_manifest();m.verify_locked_sources();a.verify_sources();q.verify_qualification_sources(s['sourceCommit'],manifest,a.committed)
    m.need(s['sourceManifestSha256']==q.source_manifest_sha256() and s['sdkFilesSha256']==m.digest(manifest['sdkReview']['files']),'KD1_SOURCE')
    for name,h in manifest['sdkReview']['files'].items():m.need(m.digest(Path(name).read_bytes())==h,'KD1_SDK')
    for filename in (Path(__file__).resolve(),Path(k.__file__).resolve(),Path(p.__file__).resolve()):m.need(a.committed(p.B,s['sourceCommit'],str(filename.relative_to(p.B)))==filename.read_bytes(),'KD1_COMMITTED_SOURCE')
    receipt=Path(__file__).parent/'r44-result.json';observed=Path(__file__).parent/'ks1-result.json'
    for filename in (receipt,observed):m.need(a.committed(p.B,s['sourceCommit'],str(filename.relative_to(p.B)))==filename.read_bytes(),'KD1_EVIDENCE_DRIFT')
    r=json.loads(receipt.read_text());ks=json.loads(observed.read_text())
    m.need(r['native']['operationId']==k.R44 and r['journalSummary']['keyCreateAttempted'] is True and r['journalSummary']['keyDeleteAttempted'] is False and ks['result']['status']=='PRESENT_MATCHING_METADATA','KD1_PROVENANCE')
    m.need(s['creationInterval']=={'start':'2026-11-14T12:12:00Z','endEpoch':r['recoveryPurge']['completedAt']},'KD1_INTERVAL_PIN')
    interval=(m.timestamp(s['creationInterval']['start']),s['creationInterval']['endEpoch'])
    commands=[next(d for d in q.current_cli_contract() if d['id']==n) for n in ('owner','project')]
    m.need(m.digest(commands)==m.digest(s['commands']),'KD1_COMMANDS')
    for d in commands:q.validate_cli_descriptor(d)
    m.need((sys.platform,sys.version_info[:3],sqlite3.sqlite_version)==acl.LOCAL_RUNTIME,'KD1_RUNTIME')
    env=q.sdk_environment(os.environ);config=acl.config_snapshot(acl.CONFIG_ROOT,os.environ)
    m.need(not Path('/private/tmp/p08-kd1-'+s['operationId']).exists(),'KD1_CONSUMED')
    return t,interval,commands,env,config

def execute(commit,packet_name='KD1'):
    m.need(packet_name in ('KD1','KD2'),'KEY_REMOVAL_PACKET_NAME')
    s=q.strict_json(a.committed(p.G,commit,f'APP013_P08_{packet_name}_KEY_REMOVAL_SCOPE_20261114.json'))
    decision=q.strict_json(a.committed(p.G,commit,f'APP013_P08_{packet_name}_KEY_REMOVAL_APPROVAL_20261114.json'))
    m.need(decision=={'owner':'Debynyhan Banks','decision':f'APPROVE_{packet_name}_EXACT_KEY_ADOPTION_DELETE_CACHE_SDK_EXCEPTION_AND_CLEANUP','scopeSha256':m.digest(s),'externalActionAuthorized':True},'KD1_APPROVAL')
    t,interval,commands,env,config=preflight(s);m.need(time.time()<t['cutoff'],'KD1_CUTOFF');os.umask(0o077)
    root=Path('/private/tmp/p08-kd1-'+s['operationId']);root.mkdir(mode=0o700)
    lock=os.open(root/'entry.lock',os.O_CREAT|os.O_EXCL|os.O_RDWR,0o600);fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
    io=q.NativeIO(time.time,s['operationId']);token=raw=project=plan=engine=None
    result={'status':'UNKNOWN','cliReserved':0,'cacheReserved':0,'failure':None}
    def reserve(label):m.reserve(root/('read-'+label+'.json'),{'reserved':True})
    m.reserve(root/'attempt.json',{'scopeSha256':m.digest(s),'sourceCommit':s['sourceCommit'],'decisionCommit':commit})
    try:
        for d in commands:
            m.need(time.time()<t['workEnd'],'KD1_DEADLINE');reserve(d['id']);result['cliReserved']+=1
            raw=io._owned_run(d['argv'],env,min(t['workEnd'],time.time()+30));value=q.strict_json(raw);raw=None
            if d['id']=='owner':m.need(value==[{'account':m.OWNER,'status':'ACTIVE'}],'OWNER_MISMATCH')
            else:project=value;q.validate_recovery_project(SimpleNamespace(e={'projectNumberSha256':q.PROJECT_NUMBER_SHA256}),project)
        plan={'projectNumber':project['projectNumber'],'keyId':k.KEY,'operationId':k.R44}
        m.need(time.time()<t['workEnd'],'KD1_DEADLINE');reserve('cache');result['cacheReserved']=1
        with acl.http_deadline(min(8,t['workEnd']-time.time())):token=acl.read_cached_token(acl.CONFIG_ROOT,t['closeoutEnd'])
        engine=Cleanup(plan,interval,t,lambda d,end:send(d,token,end),reserve)
        result.update(engine.run())
    except BaseException as error:result['failure']='INTERRUPTED' if isinstance(error,(KeyboardInterrupt,SystemExit)) else 'OPERATION_UNCONFIRMED'
    finally:
        token=raw=project=plan=engine=None
        try:result['processCleanupVerified']=io.close(t['closeoutEnd']) is True
        except BaseException:result['processCleanupVerified']=False
        try:result['configurationUnchanged']=acl.config_snapshot(acl.CONFIG_ROOT,os.environ)==config
        except BaseException:result['configurationUnchanged']=False
        result['onTime']=time.time()<t['closeoutEnd'];result['completedAt']=datetime.datetime.now(datetime.timezone.utc).isoformat()
        result['localResiduals']=[] if result['processCleanupVerified'] and result['configurationUnchanged'] and result['onTime'] else ['LOCAL_CLOSEOUT_UNCONFIRMED']
        result['keyContainmentConfirmed']=result['status']=='CONTROL_PLANE_DELETED'
        m.reserve(root/'result.json',result);fcntl.flock(lock,fcntl.LOCK_UN);os.close(lock)
    print(json.dumps(result));return 0 if result['keyContainmentConfirmed'] and not result['localResiduals'] else 2

if __name__=='__main__':
    m.need(len(sys.argv) in (2,3),'KD1_ARGUMENTS');raise SystemExit(execute(*sys.argv[1:]))
