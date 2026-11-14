"""One-shot R44 metadata read; no execution without exact committed KS1 approval."""
import datetime, fcntl, json, os, sqlite3, sys, time
from pathlib import Path
from types import SimpleNamespace
import packet as p
q=p.q; m=q.model; a=q.current_module('authority'); acl=q.current_module('acl')
key=a.load('p08-access-resolution-local-20261028/source/access_readiness.py','ks1_key_contract')
R44='9b537549-1415-4927-a058-75099d875cb7'
KEY='signmons-p08-'+R44.replace('-','')

def classify(plan, response):
    adapter=key.RequestAdapter(plan, transport=lambda _:response)
    value=adapter.key_get()
    if value=={'status':'NOT_FOUND'}:return 'ABSENT_AT_READ'
    m.need('keyString' not in value and ('deleteTime' not in value or isinstance(value['deleteTime'],str) and bool(value['deleteTime'])),'KEY_OUTPUT')
    deleted=bool(value.get('deleteTime'))
    key.Controller.key_metadata(SimpleNamespace(a=adapter,p=plan),value,deleted)
    return 'DELETED_MATCHING_METADATA' if deleted else 'PRESENT_MATCHING_METADATA'

def preflight(s, now=None):
    now=time.time() if now is None else now
    m.exact_uuid(s['operationId'],'KS1_ID')
    m.need(s['action']=='READ_R44_KEY_METADATA_ONCE' and s['r44OperationId']==R44 and s['keyId']==KEY,'KS1_SCOPE')
    m.need(s['limits']=={'cli':2,'cache':1,'https':1,'sql':0,'mutations':0} and s['sdkException']=='SDK_EXISTING_OWNER_REFRESH_CACHE_INTERNAL_RETRIES_NO_TOKEN_EXPORT','KS1_LIMITS')
    t={k:m.timestamp(v) for k,v in s['window'].items()}
    m.need(set(t)=={'start','cutoff','readEnd','closeoutEnd'} and t['start']<=now<t['cutoff']<t['readEnd']<t['closeoutEnd'],'KS1_WINDOW')
    manifest=m.verify_local_manifest();m.verify_locked_sources();a.verify_sources()
    q.verify_qualification_sources(s['sourceCommit'],manifest,a.committed)
    m.need(s['sourceManifestSha256']==q.source_manifest_sha256() and s['sdkFilesSha256']==m.digest(manifest['sdkReview']['files']),'KS1_SOURCE')
    for name,h in manifest['sdkReview']['files'].items():m.need(m.digest(Path(name).read_bytes())==h,'KS1_SDK')
    for filename in (Path(__file__).resolve(),Path(p.__file__).resolve()):
        m.need(a.committed(p.B,s['sourceCommit'],str(filename.relative_to(p.B)))==filename.read_bytes(),'KS1_COMMITTED_SOURCE')
    descriptors=[next(x for x in q.current_cli_contract() if x['id']==name) for name in ('owner','project')]
    m.need(m.digest(descriptors)==m.digest(s['commands']),'KS1_COMMANDS')
    for d in descriptors:q.validate_cli_descriptor(d)
    m.need((sys.platform,sys.version_info[:3],sqlite3.sqlite_version)==acl.LOCAL_RUNTIME,'KS1_RUNTIME')
    env=q.sdk_environment(os.environ);config=acl.config_snapshot(acl.CONFIG_ROOT,os.environ)
    m.need(not Path('/private/tmp/p08-ks1-'+s['operationId']).exists(),'KS1_CONSUMED')
    return t,descriptors,env,config

def execute(commit,scope_path,decision_path):
    m.need(scope_path=='APP013_P08_KS1_KEY_STATE_SCOPE_20261114.json' and decision_path=='APP013_P08_KS1_KEY_STATE_APPROVAL_20261114.json','KS1_PATHS')
    s=q.strict_json(a.committed(p.G,commit,scope_path));decision=q.strict_json(a.committed(p.G,commit,decision_path))
    m.need(decision=={'owner':'Debynyhan Banks','decision':'APPROVE_KS1_KEY_METADATA_READ_CACHE_SDK_EXCEPTION_AND_CLEANUP','scopeSha256':m.digest(s),'externalReadAuthorized':True},'KS1_APPROVAL')
    t,commands,env,config=preflight(s);m.need(time.time()<t['cutoff'],'KS1_CUTOFF');os.umask(0o077)
    root=Path('/private/tmp/p08-ks1-'+s['operationId']);root.mkdir(mode=0o700)
    lock=os.open(root/'entry.lock',os.O_CREAT|os.O_EXCL|os.O_RDWR,0o600);fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
    io=q.NativeIO(time.time,s['operationId']);token=None;raw=None;response=None;project=None;plan=None;last=time.time()
    result={'status':'UNKNOWN','failure':None,'ownerMatched':False,'projectMatched':False,'counts':{'cli':0,'cache':0,'https':0},'mutations':0}
    def reserve(label):
        nonlocal last
        now=time.time();m.need(last<=now<t['readEnd'],'KS1_DEADLINE');last=now
        m.reserve(root/('read-'+label+'.json'),{'reserved':True})
    m.reserve(root/'attempt.json',{'scopeSha256':m.digest(s),'decisionCommit':commit,'sourceCommit':s['sourceCommit']})
    try:
        reserve('owner');result['counts']['cli']+=1
        raw=io._owned_run(commands[0]['argv'],env,min(t['readEnd'],time.time()+30))
        m.need(q.strict_json(raw)==[{'account':m.OWNER,'status':'ACTIVE'}],'OWNER_MISMATCH');raw=None;result['ownerMatched']=True
        reserve('project');result['counts']['cli']+=1
        raw=io._owned_run(commands[1]['argv'],env,min(t['readEnd'],time.time()+30));project=q.strict_json(raw);raw=None
        q.validate_recovery_project(SimpleNamespace(e={'projectNumberSha256':q.PROJECT_NUMBER_SHA256}),project);result['projectMatched']=True
        plan={'projectNumber':project['projectNumber'],'keyId':KEY,'operationId':R44}
        descriptor=next(x for x in q.access_https_contract(plan['projectNumber'],KEY) if x['id']=='key_absence')
        expected=[];adapter=key.RequestAdapter(plan,transport=lambda d:expected.append(d) or {'httpStatus':404,'body':'{"error":{"status":"NOT_FOUND","code":404}}'})
        adapter.key_get();m.need(expected[0]['url']==descriptor['url'] and expected[0]['method']=='GET' and expected[0]['body'] is None,'KS1_BOUNDARY')
        reserve('cache');result['counts']['cache']+=1
        with acl.http_deadline(min(8,t['readEnd']-time.time())):token=acl.read_cached_token(acl.CONFIG_ROOT,t['closeoutEnd'])
        reserve('key');result['counts']['https']+=1
        response=io.https(descriptor,token,min(t['readEnd'],time.time()+15));token=None
        result['status']=classify(plan,{'httpStatus':response['status'],'body':response['body'].decode('utf-8','strict')})
    except BaseException as ex:
        result['failure']='INTERRUPTED' if isinstance(ex,(KeyboardInterrupt,SystemExit)) else 'READ_UNCONFIRMED'
    finally:
        token=raw=response=project=plan=None
        try:result['processCleanupVerified']=io.close(t['closeoutEnd']) is True
        except BaseException:result['processCleanupVerified']=False
        try:result['configurationUnchanged']=acl.config_snapshot(acl.CONFIG_ROOT,os.environ)==config
        except BaseException:result['configurationUnchanged']=False
        result['onTime']=time.time()<t['closeoutEnd']
        result['residuals']=[] if result['processCleanupVerified'] and result['configurationUnchanged'] and result['onTime'] else ['LOCAL_CLOSEOUT_UNCONFIRMED']
        result['completedAt']=datetime.datetime.now(datetime.timezone.utc).isoformat()
        m.reserve(root/'result.json',result);fcntl.flock(lock,fcntl.LOCK_UN);os.close(lock)
    print(json.dumps(result));return 0 if result['failure'] is None and not result['residuals'] else 2

if __name__=='__main__':
    m.need(len(sys.argv)==4,'KS1_ARGUMENTS')
    raise SystemExit(execute(*sys.argv[1:]))
