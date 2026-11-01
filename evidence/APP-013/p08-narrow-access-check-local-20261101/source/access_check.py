"""Exact P08 read-only adapter. No external operation is authorized by installation."""
import datetime as dt
from contextlib import contextmanager
import fcntl
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import configparser
import sqlite3
import signal
import stat
import sys
import time
import urllib.error
import urllib.request
import uuid

HERE = Path(__file__).resolve().parent
APP = HERE.parent.parent
BACKEND = APP.parent.parent
GOV = Path('/Users/debynyhanbanks/Web Projects/signmons-governance-r08-recovery')
CONFIG_ROOT = Path('/Users/debynyhanbanks/.config/gcloud')
LOCAL_RUNTIME = ('darwin', (3, 14, 2), '3.51.1')
LIMITS = {'cli':0,'https':6,'cache':1,'sql':0,'mutations':0,'retry':0}
CALLS = [['cache',0]] + [['https',i] for i in range(6)]
OWNER = 'debynyhan@signmons.com'
IDENTITY = 'signmons-calldesk-p07-runtime@signmons.iam.gserviceaccount.com'
PROJECT_HASH = '37d4aa0f46ca5b8f0b81b1148bda235a0f4a9a424b6b4638ec993d889563be54'
NAMES = {'plan.json','attempt.json','journal.json','journal-next.json','closeout.json',
         'independent-closeout.json','entry.lock','result.json'}
PROJECT_PERMISSIONS = ['resourcemanager.projects.getIamPolicy','resourcemanager.projects.setIamPolicy',
 'apikeys.keys.create','apikeys.keys.get','apikeys.keys.getKeyString','apikeys.keys.delete',
 'serviceusage.operations.get','serviceusage.services.get','serviceusage.services.enable','serviceusage.services.use']
IDENTITY_PERMISSIONS = ['iam.serviceAccounts.getIamPolicy','iam.serviceAccounts.setIamPolicy']
MAX_OUTPUT = 65536

class Stop(Exception):
    pass

def need(value, code):
    if not value:
        raise Stop(code)

def digest(value):
    raw = value if isinstance(value, bytes) else json.dumps(value,sort_keys=True,separators=(',',':')).encode()
    return hashlib.sha256(raw).hexdigest()

def load(path, name):
    spec=importlib.util.spec_from_file_location(name,path)
    module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
    return module

def verify_sources():
    p=HERE/'source-manifest.json'
    need(p.is_file() and not p.is_symlink(),'SOURCE_MANIFEST')
    m=json.loads(p.read_text())
    need(set(m)=={'status','files','lockedSources','sdkFiles'} and
         m['status']=='LOCAL_ONLY_NO_EXTERNAL_OPERATION' and set(m['files'])=={'access_check.py'},'MANIFEST_SHAPE')
    expected={'p08-role-contract-local-20261029/source/qualification_launch.py',
      'p08-role-contract-local-20261029/source/composed_qualification.py',
      'p08-exact-role-provisioning-local-20261028/source/role_provisioner.py',
      'p08-restoration-local-20261028/source/restore.py',
      'p08-native-entry-local-20261101/source/authority.py'}
    need(set(m['lockedSources'])==expected,'SOURCE_SET')
    for base,entries in [(HERE,m['files']),(APP,m['lockedSources'])]:
        for name,h in entries.items():
            path=base/name
            need(not Path(name).is_absolute() and '..' not in Path(name).parts and
                 path.is_file() and not path.is_symlink() and digest(path.read_bytes())==h,'SOURCE_DRIFT')
    return m

def sources():
    verify_sources()
    root=APP/'p08-role-contract-local-20261029/source'
    model=load(root/'composed_qualification.py','narrow_model')
    model.verify_local_manifest();model.verify_locked_sources()
    previous=sys.modules.get('composed_qualification')
    sys.modules['composed_qualification']=model
    try:q=load(root/'qualification_launch.py','narrow_parsers')
    finally:
        if previous is None:sys.modules.pop('composed_qualification',None)
        else:sys.modules['composed_qualification']=previous
    roles=load(APP/'p08-exact-role-provisioning-local-20261028/source/role_provisioner.py','narrow_roles')
    restore=load(APP/'p08-restoration-local-20261028/source/restore.py','narrow_environment')
    native_root=APP/'p08-native-entry-local-20261101/source'
    sys.path.insert(0,str(native_root))
    try:
        authority=load(native_root/'authority.py','narrow_source_authority')
        authority.verify_sources()
    finally:sys.path.remove(str(native_root))
    return q,roles,restore,authority

def http_contract(number=None):
    need(number is None or (isinstance(number,str) and re.fullmatch(r'[0-9]{6,20}',number)),'PROJECT_NUMBER')
    project_fields='projectId,projectNumber,lifecycleState'
    role_fields='name,title,description,includedPermissions,stage,deleted,etag'
    roles=['signmonsP08FirebaseUserLookup','signmonsP08ServiceAccountSignBlob']
    return [
      {'method':'GET','url':'https://cloudresourcemanager.googleapis.com/v1/projects/signmons?fields='+project_fields,'body':None},
      *[{'method':'GET','url':'https://iam.googleapis.com/v1/projects/signmons/roles/'+role+'?fields='+role_fields,'body':None} for role in roles],
      {'method':'POST','url':f'https://cloudresourcemanager.googleapis.com/v1/projects/{number}:testIamPermissions','body':{'permissions':PROJECT_PERMISSIONS}},
      {'method':'POST','url':f'https://iam.googleapis.com/v1/projects/-/serviceAccounts/{IDENTITY}:testIamPermissions','body':{'permissions':IDENTITY_PERMISSIONS}},
      {'method':'GET','url':f'https://serviceusage.googleapis.com/v1/projects/{number}/services/apikeys.googleapis.com','body':None}]

def contract_hash():
    return digest({'version':2,'https':http_contract('000000'),'cache':'EXACT_OWNER_CACHED_TOKEN_NO_REFRESH',
      'limits':LIMITS,'runtime':LOCAL_RUNTIME,'projectHash':PROJECT_HASH})

def inspect(root,operation):
    root=Path(root)
    need(str(uuid.UUID(operation))==operation and str(root)=='/private/tmp/p08-access-check-'+operation,'ROOT_SCOPE')
    info=root.lstat()
    need(stat.S_ISDIR(info.st_mode) and not root.is_symlink() and root.resolve()==root and
         stat.S_IMODE(info.st_mode)==0o700,'ROOT_MODE')
    for p in root.iterdir():
        s=p.lstat()
        need(p.name in NAMES and stat.S_ISREG(s.st_mode) and not p.is_symlink() and
             stat.S_IMODE(s.st_mode)==0o600 and s.st_nlink==1 and s.st_size<=MAX_OUTPUT,'PRIVATE_INVENTORY')
    return root

def read(path):
    s=path.lstat()
    need(stat.S_ISREG(s.st_mode) and not path.is_symlink() and stat.S_IMODE(s.st_mode)==0o600 and
         s.st_nlink==1 and s.st_size<=MAX_OUTPUT,'PRIVATE_INPUT')
    fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW)
    with os.fdopen(fd,'rb') as f:return json.loads(f.read(MAX_OUTPUT+1))

def reserve(path,value):
    data=json.dumps(value,sort_keys=True,separators=(',',':')).encode()
    need(len(data)<=MAX_OUTPUT,'PRIVATE_OUTPUT_SIZE')
    fd=os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
    try:
        with os.fdopen(fd,'wb',closefd=False) as f:f.write(data);f.flush();os.fsync(fd)
    finally:os.close(fd)

def utc(value):
    need(isinstance(value,str) and re.fullmatch(r'\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ',value),'UTC_FORMAT')
    return dt.datetime.fromisoformat(value.replace('Z','+00:00')).timestamp()

class ReadCapability:
    def __init__(self,p,root,mode='read',clock=time.time,read_commit=None):
        self.q,self.roles,self.restore,self.authority=sources()
        p=json.loads(json.dumps(p))
        need(set(p)=={'version','section','operationId','execution','project','ownerPrincipal','identity',
          'projectNumberSha256','contractSha256','limits','window','sourceManifestSha256','sourceCommit','decision'},'PLAN_SHAPE')
        need(type(p['version']) is int and p['version']==2 and p['section']=='APP-013/3A/P08' and
          p['execution'] in ('PROOF_ONLY','EXTERNAL') and mode in ('read','closeout'),'PLAN_MODE')
        need(p['project']=='signmons' and p['ownerPrincipal']==OWNER and p['identity']==IDENTITY and
          p['projectNumberSha256']==PROJECT_HASH and p['contractSha256']==contract_hash() and
          p['limits']==LIMITS and
          all(type(v) is int for v in p['limits'].values()),'PLAN_SCOPE')
        need(p['sourceManifestSha256']==digest((HERE/'source-manifest.json').read_bytes()),'MANIFEST_BINDING')
        need(set(p['window'])=={'start','cutoff','readEnd','closeoutEnd','purgeEnd'},'WINDOW_SHAPE')
        times={k:utc(v) for k,v in p['window'].items()}
        need([times[k]-times['start'] for k in ('start','cutoff','readEnd','closeoutEnd','purgeEnd')]==[0,120,240,540,600],'WINDOW_BOUNDS')
        need(times['start']<=clock()<times['cutoff' if mode=='read' else 'closeoutEnd'],'ENTRY_CUTOFF')
        scope=digest({k:v for k,v in p.items() if k!='decision'})
        if p['execution']=='PROOF_ONLY':
            need(p['decision']=={'decision':'APPROVE_LOCAL_NARROW_ACCESS_PROOF','scopeSha256':scope},'LOCAL_AUTHORITY')
        else:
            d=p['decision']
            need(set(d)=={'commit','path','sha256'} and re.fullmatch(r'APP013_P08_ACCESS_READ_OPERATION_[0-9]{8}\.json',d['path']),'EXTERNAL_REFERENCE')
            get=read_commit or self.authority.committed
            raw=get(GOV,d['commit'],d['path'])
            need(digest(raw)==d['sha256'] and json.loads(raw)=={'decision':'APPROVE_EXACT_P08_NARROW_ACCESS_READ',
              'owner':'Debynyhan Banks','operationId':p['operationId'],'scopeSha256':scope,
              'sourceManifestSha256':p['sourceManifestSha256'],'readOnly':True},'EXACT_OWNER_APPROVAL')
            rel=str(HERE.relative_to(BACKEND))
            need(get(BACKEND,p['sourceCommit'],rel+'/source-manifest.json')==(HERE/'source-manifest.json').read_bytes(),'COMMITTED_MANIFEST')
            need(get(BACKEND,p['sourceCommit'],rel+'/access_check.py')==(HERE/'access_check.py').read_bytes(),'COMMITTED_SOURCE')
        self.p,self.root,self.mode,self.clock=p,inspect(root,p['operationId']),mode,clock
        self.external=p['execution']=='EXTERNAL';self.times=times;self.last=clock();self.abort=False
        self.hash=digest(p)

    def gate(self,cleanup=False):
        now=self.clock();need(now>=self.last,'CLOCK_ROLLBACK');self.last=now
        need(self.times['start']<=now<self.times['closeoutEnd' if cleanup else 'readEnd'],'DEADLINE')
        need(cleanup or (self.mode=='read' and not self.abort),'READ_INTERRUPTED')
        inspect(self.root,self.p['operationId'])
        return self.times['closeoutEnd' if cleanup else 'readEnd']


def native_readiness():
    m=verify_sources()
    for path,h in m['sdkFiles'].items():
        p=Path(path)
        need(p.is_file() and digest(p.read_bytes())==h,'SDK_SOURCE_DRIFT')
    need((sys.platform,sys.version_info[:3],sqlite3.sqlite_version)==LOCAL_RUNTIME,'LOCAL_RUNTIME_DRIFT')
    return {'ready':False,'localTransportReady':True,'reason':'EXTERNAL_QUALIFICATION_NOT_AUTHORIZED'}

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self,*args,**kwargs):return None

def validate_token(token):
    need(isinstance(token,str) and re.fullmatch(r'[A-Za-z0-9._~+/=-]{20,4096}',token),'TOKEN_SHAPE')

def file_stamp(s):
    return (s.st_dev,s.st_ino,s.st_size,s.st_mtime_ns,s.st_ctime_ns,s.st_mode,s.st_uid,s.st_nlink)

def safe_file(path,private=False,max_size=MAX_OUTPUT):
    s=path.lstat()
    need(stat.S_ISREG(s.st_mode) and not path.is_symlink() and s.st_uid==os.getuid() and
         s.st_nlink==1 and not s.st_mode&0o022 and (not private or stat.S_IMODE(s.st_mode)==0o600) and
         0<s.st_size<=max_size,'CACHE_FILE_UNSAFE')
    return file_stamp(s)

def safe_directory(path):
    s=path.lstat()
    need(stat.S_ISDIR(s.st_mode) and path.resolve()==path and s.st_uid==os.getuid() and
         not s.st_mode&0o022,'CONFIG_DIRECTORY_UNSAFE')
    return (s.st_dev,s.st_ino,s.st_mode,s.st_uid)

def config_snapshot(root,env):
    need(not any(v for k,v in env.items() if k.startswith(('CLOUDSDK_','GOOGLE_','GCLOUD_','PG')) or
         k.upper() in ('DATABASE_URL','HTTP_PROXY','HTTPS_PROXY','ALL_PROXY','NO_PROXY',
                      'SSL_CERT_FILE','SSL_CERT_DIR','REQUESTS_CA_BUNDLE','CURL_CA_BUNDLE')),'CREDENTIAL_OVERRIDE')
    directories={p:safe_directory(p) for p in (root,root/'configurations')}
    snapshots={}
    def content(path):
        stamp=safe_file(path)
        fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW)
        try:
            need(file_stamp(os.fstat(fd))==stamp,'CONFIG_CHANGED')
            raw=os.read(fd,MAX_OUTPUT+1)
            need(len(raw)<=MAX_OUTPUT and file_stamp(os.fstat(fd))==stamp and safe_file(path)==stamp,'CONFIG_CHANGED')
        finally:os.close(fd)
        snapshots[path]=(stamp,digest(raw))
        return raw.decode('utf-8','strict')
    name=content(root/'active_config').strip()
    need(re.fullmatch('[A-Za-z0-9_-]{1,100}',name),'CONFIG_NAME')
    parser=configparser.ConfigParser(interpolation=None,strict=True)
    parser.read_string(content(root/'configurations'/('config_'+name)))
    need(not parser.defaults() and set(parser.sections())=={'core'},'CONFIG_UNSUPPORTED')
    allowed={'account','project','universe_domain','disable_usage_reporting','disable_prompts'}
    need(set(parser['core'])<=allowed and parser['core'].get('account')==OWNER and
         parser['core'].get('project')=='signmons' and
         parser['core'].get('universe_domain','googleapis.com')=='googleapis.com','CONFIG_IDENTITY_OR_OVERRIDE')
    for key in ('disable_usage_reporting','disable_prompts'):
        need(parser['core'].get(key,'true').lower() in ('true','false'),'CONFIG_UNSUPPORTED')
    return (directories,snapshots)

CACHE_SCHEMA = ('CREATE TABLE "access_tokens" (account_id TEXT PRIMARY KEY, access_token TEXT, '
                'token_expiry TIMESTAMP, rapt_token TEXT, id_token TEXT, regional_access_boundary TEXT, '
                'regional_access_boundary_expiry TIMESTAMP)')
SCHEMA_QUERY = "SELECT sql FROM sqlite_schema WHERE type='table' AND name='access_tokens'"
TOKEN_QUERY = ('SELECT access_token,token_expiry,regional_access_boundary,regional_access_boundary_expiry '
               'FROM access_tokens WHERE account_id=? LIMIT 2')

def cache_authorizer(action,table,column,database,trigger):
    if trigger is not None:return sqlite3.SQLITE_DENY
    if action==sqlite3.SQLITE_SELECT:return sqlite3.SQLITE_OK
    columns={'sqlite_master':{'sql','type','name'},'access_tokens':{
      'account_id','access_token','token_expiry','regional_access_boundary','regional_access_boundary_expiry'}}
    if action==sqlite3.SQLITE_READ and database=='main' and column in columns.get(table,set()):
        return sqlite3.SQLITE_OK
    return sqlite3.SQLITE_DENY

def cache_query(connection,query,parameters=()):
    need((query==SCHEMA_QUERY and parameters==()) or (query==TOKEN_QUERY and parameters==(OWNER,)),'CACHE_QUERY_SCOPE')
    return connection.execute(query,parameters).fetchall()

def read_cached_token(root,purge_end,env=None):
    """One account read, no SDK resolver/refresh/cache mutation; caller reserves first."""
    root=Path(root);env=os.environ if env is None else env
    connection=None;fd=None;rows=None;token=None
    try:
        initial=config_snapshot(root,env)
        path=root/'access_tokens.db'
        stamp=safe_file(path,True,16*1024*1024)
        fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW)
        need(file_stamp(os.fstat(fd))==stamp,'CACHE_CHANGED')
        # Unix SQLite pending/reserved/shared bytes. Block ordinary SQLite writers
        # before using immutable mode (which itself never writes a sidecar).
        try:fcntl.lockf(fd,fcntl.LOCK_SH|fcntl.LOCK_NB,512,0x40000000)
        except OSError:raise Stop('CACHE_BUSY') from None
        def stable():
            need(file_stamp(os.fstat(fd))==stamp and safe_file(path,True,16*1024*1024)==stamp,'CACHE_CHANGED')
            need(not any(os.path.lexists(str(path)+s) for s in ('-journal','-wal','-shm')),'CACHE_JOURNAL_UNSUPPORTED')
        stable()
        header=os.pread(fd,24,0)
        need(header[:16]==b'SQLite format 3\0' and header[18:20]==b'\x01\x01','CACHE_FORMAT_UNSUPPORTED')
        connection=sqlite3.connect(path.as_uri()+'?mode=ro&immutable=1',uri=True,timeout=0,isolation_level=None)
        connection.enable_load_extension(False)
        connection.setlimit(sqlite3.SQLITE_LIMIT_LENGTH,MAX_OUTPUT)
        connection.setlimit(sqlite3.SQLITE_LIMIT_SQL_LENGTH,4096)
        connection.setlimit(sqlite3.SQLITE_LIMIT_ATTACHED,0)
        connection.set_authorizer(cache_authorizer)
        steps=0
        def bounded():
            nonlocal steps
            steps+=1
            return int(steps>1000)
        connection.set_progress_handler(bounded,100)
        schema=cache_query(connection,SCHEMA_QUERY)
        normalize=lambda value:re.sub(r'[\s\"]','',value).lower()
        need(len(schema)==1 and isinstance(schema[0][0],str) and
             normalize(schema[0][0])==normalize(CACHE_SCHEMA),'CACHE_SCHEMA_UNSUPPORTED')
        rows=cache_query(connection,TOKEN_QUERY,(OWNER,))
        need(len(rows)==1,'CACHED_TOKEN_MISSING')
        token,expiry,restriction,restriction_expiry=rows[0]
        validate_token(token)
        need(restriction is None and restriction_expiry is None,'TOKEN_RESTRICTION_UNSUPPORTED')
        need(isinstance(expiry,str) and re.fullmatch(r'\d{4}-\d\d-\d\d \d\d:\d\d:\d\d(?:\.\d{1,6})?',expiry),'TOKEN_EXPIRY_UNKNOWN')
        expires=dt.datetime.fromisoformat(expiry).replace(tzinfo=dt.timezone.utc).timestamp()
        need(expires>purge_end,'CACHED_TOKEN_EXPIRED')
        stable();need(config_snapshot(root,env)==initial,'CONFIG_CHANGED')
        return token
    except Stop:raise
    except Exception:raise Stop('CACHE_READ_UNCONFIRMED') from None
    finally:
        rows=None;token=None
        try:
            if connection is not None:connection.close()
        finally:
            if fd is not None:os.close(fd)

@contextmanager
def http_deadline(seconds):
    need(seconds>0 and signal.getitimer(signal.ITIMER_REAL)==(0.0,0.0),'HTTP_TIMER_CONFLICT')
    previous=signal.getsignal(signal.SIGALRM)
    def expired(signum,frame):raise Stop('HTTP_TIMEOUT')
    signal.signal(signal.SIGALRM,expired);signal.setitimer(signal.ITIMER_REAL,seconds)
    try:yield
    finally:
        signal.setitimer(signal.ITIMER_REAL,0);signal.signal(signal.SIGALRM,previous)

class NativeIO:
    proof=False
    def __init__(self,cap):
        need(isinstance(cap,ReadCapability) and cap.external,'NATIVE_REQUIRES_EXTERNAL_AUTHORITY')
        self.cap=cap;self.response=None;self.closed=False
        need(native_readiness()['localTransportReady'],'LOCAL_TRANSPORT_UNVERIFIED')

    def cached_token(self,deadline):
        need(not self.closed,'TRANSPORT_CLOSED');self.cap.gate()
        with http_deadline(min(8,deadline-self.cap.clock())):
            token=read_cached_token(CONFIG_ROOT,self.cap.times['purgeEnd'])
        self.cap.gate();return token

    def https(self,index,number,token,deadline):
        need(not self.closed and type(index) is int and 0<=index<6,'HTTP_SCOPE')
        self.cap.gate();need(index<3 or number is not None,'PROJECT_NUMBER')
        d=http_contract(number)[index]
        body=None if d['body'] is None else json.dumps(d['body'],separators=(',',':')).encode()
        req=urllib.request.Request(d['url'],data=body,method=d['method'],headers={
          'Authorization':'Bearer '+token,'Content-Type':'application/json','x-goog-user-project':'signmons'})
        try:
            with http_deadline(min(8,deadline-self.cap.clock())):
                try:self.response=urllib.request.build_opener(urllib.request.ProxyHandler({}),NoRedirect).open(req,timeout=max(.01,min(8,deadline-self.cap.clock())))
                except urllib.error.HTTPError as error:self.response=error
                raw=self.response.read(MAX_OUTPUT+1);status=self.response.status
            need(len(raw)<=MAX_OUTPUT,'HTTP_OUTPUT_SIZE');need(not 300<=status<400,'HTTP_REDIRECT')
            self.cap.gate();return {'status':status,'body':raw}
        except Stop:raise
        except Exception:raise Stop('HTTP_UNCONFIRMED') from None
        finally:
            if self.response is not None:self.response.close();self.response=None

    def close(self):
        if self.response is not None:self.response.close();self.response=None
        self.closed=True
        return True

class Reader:
    def __init__(self,cap,io):
        self.cap,self.io,self.root=cap,io,cap.root
        self.j={'operationId':cap.p['operationId'],'planSha256':cap.hash,'contractSha256':contract_hash(),
          'calls':[],'pending':None,'transportSettled':True,'phase':'PREPARED','failure':None,
          'service':'NOT_RUN','permissions':'NOT_RUN','roles':'NOT_RUN','residuals':[]}
        self.token='';self.number=None

    def save(self):
        reserve(self.root/'journal-next.json',self.j)
        os.replace(self.root/'journal-next.json',self.root/'journal.json')

    def call(self,kind,index):
        self.cap.gate()
        ordinal=len(self.j['calls'])
        need(ordinal<len(CALLS),'CALL_LIMIT')
        need((kind,index)==tuple(CALLS[ordinal]),'CALL_ORDER')
        self.j['calls'].append([kind,index]);self.j['pending']=[kind,index]
        self.j['transportSettled']=False;self.save()
        result=self.io.cached_token(self.cap.times['readEnd']) if kind=='cache' else self.io.https(index,self.number,self.token,self.cap.times['readEnd'])
        self.cap.gate();self.j['pending']=None;self.j['transportSettled']=True;self.save()
        return result

    def http_json(self,index):
        raw=self.call('https',index)
        need(isinstance(raw,dict) and set(raw)=={'status','body'} and type(raw['status']) is int,'HTTP_ENVELOPE')
        need(raw['status']==200,'HTTP_DENIED_OR_UNKNOWN')
        try:value=self.cap.q.bounded_https_json(raw['body'])
        except Exception:raise Stop('HTTP_BODY_UNKNOWN') from None
        need(isinstance(value,dict),'HTTP_BODY_UNKNOWN')
        return value

    def execute(self):
        self.token=self.call('cache',0);validate_token(self.token)
        project=self.http_json(0)
        need(set(project)=={'projectId','projectNumber','lifecycleState'} and
          project['projectId']=='signmons' and project['lifecycleState']=='ACTIVE' and
          isinstance(project['projectNumber'],str) and re.fullmatch(r'[0-9]{6,20}',project['projectNumber']) and
          digest(project['projectNumber'])==PROJECT_HASH,'PROJECT_DRIFT')
        self.number=project['projectNumber']
        for i,role in enumerate(self.cap.roles.ROLES):
            need(self.cap.roles.definition_shape(self.http_json(i+1),role) in
                 ('EXACT_ACTIVE_EXPLICIT','EXACT_ACTIVE_DEFAULTED'),'ROLE_DRIFT')
        self.j['roles']='EXACT';self.save()
        for i in range(3,6):
            value=self.http_json(i)
            if i<5:
                expected=[PROJECT_PERMISSIONS,IDENTITY_PERMISSIONS][i-3]
                need(set(value)<={'permissions'},'PERMISSION_SHAPE')
                values=value.get('permissions',[])
                need(isinstance(values,list) and all(isinstance(v,str) for v in values) and
                     len(values)==len(set(values)) and set(values)<=set(expected),'PERMISSION_SHAPE')
                need(set(values)==set(expected),'PERMISSION_DENIED')
            else:
                need(value.get('name')==http_contract(self.number)[5]['url'].split('/v1/')[1] and
                     value.get('state') in ('ENABLED','DISABLED'),'SERVICE_SHAPE')
                self.j['service']=value['state']
            if i==4:self.j['permissions']='OBSERVED'
            self.save()
        self.j['phase']='READ_FINISHED';self.save()

    def closeout(self,independent=False):
        self.cap.gate(True)
        reserve(self.root/('independent-closeout.json' if independent else 'closeout.json'),
                {'operationId':self.cap.p['operationId'],'planSha256':self.cap.hash})
        residuals=[]
        if independent:
            self.j=read(self.root/'journal.json')
            need(set(self.j)=={'operationId','planSha256','contractSha256','calls','pending','transportSettled',
                 'phase','failure','service','permissions','roles','residuals'} and
                 self.j['operationId']==self.cap.p['operationId'] and self.j['planSha256']==self.cap.hash and
                 self.j['contractSha256']==contract_hash(),'JOURNAL_BINDING')
            allowed=CALLS
            need(isinstance(self.j['calls'],list) and self.j['calls']==allowed[:len(self.j['calls'])] and
                 len(self.j['calls'])<=len(CALLS),'JOURNAL_SCOPE')
            need(self.j['pending'] is None or (self.j['calls'] and self.j['pending']==self.j['calls'][-1]),'JOURNAL_PENDING')
            # An interrupted reservation remains unconfirmed; independent cleanup never replays it.
            if self.j['transportSettled'] is not True:residuals.append('PROCESS_OUTCOME_UNKNOWN')
        else:
            try:
                need(self.io.close() is True,'PROCESS_CLOSE_UNCONFIRMED')
                self.j['transportSettled']=True
            except BaseException:residuals.append('PROCESS_CLOSE_UNCONFIRMED')
        self.token='';self.number=None
        if (self.root/'journal-next.json').exists():
            residuals.append('JOURNAL_WRITE_INTERRUPTED')
            (self.root/'journal-next.json').unlink()  # exact inventoried owned scratch; never promote its claims
        read_finished=self.j['phase']=='READ_FINISHED' and len(self.j['calls'])==len(CALLS) and self.j['pending'] is None
        self.j['residuals']=sorted(set(self.j['residuals']+residuals));self.j['phase']='CLOSED';self.save()
        private_absent=False
        try:
            need(self.cap.clock()<self.cap.times['purgeEnd'],'PURGE_DEADLINE')
            inspect(self.root,self.cap.p['operationId'])
            (self.root/'plan.json').unlink()
            private_absent=not (self.root/'plan.json').exists() and self.cap.clock()<self.cap.times['purgeEnd']
            need(private_absent,'PURGE_UNCONFIRMED')
        except Exception:self.j['residuals'].append('PRIVATE_PURGE_UNCONFIRMED');self.save()
        observed=read_finished and self.j['service']=='ENABLED' and self.j['permissions']=='OBSERVED' and self.j['roles']=='EXACT' and self.j['failure'] is None
        result={'status':'CONTAINMENT_UNCONFIRMED' if self.j['residuals'] else
          'NARROW_ACCESS_OBSERVED' if observed else 'SERVICE_DISABLED' if self.j['service']=='DISABLED' else 'NARROW_ACCESS_STOPPED',
          'operationId':self.cap.p['operationId'],'failure':self.j['failure'],'residuals':self.j['residuals'],
          'privateInputsAbsent':private_absent,'externalObservation':self.cap.external,
          'executionReady':False,'counts':{'cli':sum(c[0]=='cli' for c in self.j['calls']),
                                         'https':sum(c[0]=='https' for c in self.j['calls']),
                                         'cache':sum(c[0]=='cache' for c in self.j['calls'])}}
        reserve(self.root/'result.json',result)
        return result


def run(path,mode='read',io_factory=NativeIO,clock=time.time,read_commit=None):
    path=Path(path);need(path.name=='plan.json','PLAN_PATH')
    cap=ReadCapability(read(path),path.parent,mode,clock,read_commit)
    fd=os.open(cap.root/'entry.lock',os.O_WRONLY|os.O_CREAT|os.O_NOFOLLOW,0o600)
    io=None;handlers={}
    try:
        try:fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
        except BlockingIOError:raise Stop('ENTRY_RUNNING') from None
        inspect(cap.root,cap.p['operationId'])
        if mode=='closeout':
            need(read(cap.root/'attempt.json')=={'operationId':cap.p['operationId'],'planSha256':cap.hash},'ATTEMPT_BINDING')
            return Reader(cap,None).closeout(True)
        io=io_factory(cap)
        need(cap.external is (not io.proof),'TRANSPORT_AUTHORITY')
        reserve(cap.root/'attempt.json',{'operationId':cap.p['operationId'],'planSha256':cap.hash})
        reader=Reader(cap,io);reserve(cap.root/'journal.json',reader.j)
        def interrupted(signum,frame):
            cap.abort=True;raise Stop('INTERRUPTED')
        for sig in (signal.SIGINT,signal.SIGTERM):
            handlers[sig]=signal.signal(sig,interrupted)
        try:reader.execute()
        except BaseException as error:
            reader.j['failure']=str(error) if isinstance(error,Stop) and re.fullmatch('[A-Z_]+',str(error)) else 'UNEXPECTED_LOCAL_FAILURE'
            # A failed atomic journal stays visible to closeout; never erase its evidence here.
            if not (cap.root/'journal-next.json').exists():reader.save()
        finally:
            for sig,h in handlers.items():signal.signal(sig,h)
            handlers={}
        return reader.closeout()
    finally:
        for sig,h in handlers.items():signal.signal(sig,h)
        if io is not None:
            try:io.close()
            except BaseException:pass
        fcntl.flock(fd,fcntl.LOCK_UN);os.close(fd)


def main(argv):
    if argv==['--check-source']:
        sources();print(json.dumps(native_readiness()));return 0
    need(len(argv)==2 and argv[0] in ('--read','--closeout'),'ENTRY_UNBOUND')
    result=run(argv[1],argv[0][2:]);print(json.dumps(result))
    return 0 if result['status']=='NARROW_ACCESS_OBSERVED' else 2

if __name__=='__main__':
    try:raise SystemExit(main(sys.argv[1:]))
    except Exception:
        print('{"status":"NARROW_ACCESS_REFUSED_OR_UNCONFIRMED"}');raise SystemExit(2)
