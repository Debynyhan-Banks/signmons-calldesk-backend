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
    version=2
    limits=LIMITS
    extra_fields=set()
    local_decision='APPROVE_LOCAL_NARROW_ACCESS_PROOF'
    decision_pattern=r'APP013_P08_ACCESS_READ_OPERATION_[0-9]{8}\.json'

    def contract_digest(self):return contract_hash()

    def owner_decision(self,scope):
        return {'decision':'APPROVE_EXACT_P08_NARROW_ACCESS_READ','owner':'Debynyhan Banks',
          'operationId':self.p['operationId'],'scopeSha256':scope,
          'sourceManifestSha256':self.p['sourceManifestSha256'],'readOnly':True}

    def __init__(self,p,root,mode='read',clock=time.time,read_commit=None):
        self.q,self.roles,self.restore,self.authority=sources()
        p=json.loads(json.dumps(p))
        need(set(p)=={'version','section','operationId','execution','project','ownerPrincipal','identity',
          'projectNumberSha256','contractSha256','limits','window','sourceManifestSha256','sourceCommit','decision'} | self.extra_fields,'PLAN_SHAPE')
        need(type(p['version']) is int and p['version']==self.version and p['section']=='APP-013/3A/P08' and
          p['execution'] in ('PROOF_ONLY','EXTERNAL') and mode in ('read','closeout'),'PLAN_MODE')
        need(p['project']=='signmons' and p['ownerPrincipal']==OWNER and p['identity']==IDENTITY and
          p['projectNumberSha256']==PROJECT_HASH and p['contractSha256']==self.contract_digest() and
          p['limits']==self.limits and
          all(type(v) is int for v in p['limits'].values()),'PLAN_SCOPE')
        if self.version==3:need(p['serviceRetention']=='RETAIN_ENABLED','SERVICE_RETENTION')
        self.p=p
        need(p['sourceManifestSha256']==digest((HERE/'source-manifest.json').read_bytes()),'MANIFEST_BINDING')
        need(set(p['window'])=={'start','cutoff','readEnd','closeoutEnd','purgeEnd'},'WINDOW_SHAPE')
        times={k:utc(v) for k,v in p['window'].items()}
        need([times[k]-times['start'] for k in ('start','cutoff','readEnd','closeoutEnd','purgeEnd')]==[0,120,240,540,600],'WINDOW_BOUNDS')
        need(times['start']<=clock()<times['cutoff' if mode=='read' else 'closeoutEnd'],'ENTRY_CUTOFF')
        scope=digest({k:v for k,v in p.items() if k!='decision'})
        if p['execution']=='PROOF_ONLY':
            need(p['decision']=={'decision':self.local_decision,'scopeSha256':scope},'LOCAL_AUTHORITY')
        else:
            d=p['decision']
            need(set(d)=={'commit','path','sha256'} and re.fullmatch(self.decision_pattern,d['path']),'EXTERNAL_REFERENCE')
            get=read_commit or self.authority.committed
            raw=get(GOV,d['commit'],d['path'])
            need(digest(raw)==d['sha256'] and json.loads(raw)==self.owner_decision(scope),'EXACT_OWNER_APPROVAL')
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
    capability_type=ReadCapability
    def __init__(self,cap):
        need(type(cap) is self.capability_type and cap.external,'NATIVE_REQUIRES_EXTERNAL_AUTHORITY')
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
        return self.request(d,token,deadline)

    def request(self,d,token,deadline):
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
    journal_fields={'operationId','planSha256','contractSha256','calls','pending','transportSettled',
                    'phase','failure','service','permissions','roles','residuals'}
    def __init__(self,cap,io):
        self.cap,self.io,self.root=cap,io,cap.root
        self.j={'operationId':cap.p['operationId'],'planSha256':cap.hash,'contractSha256':cap.contract_digest(),
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

    def validate_journal(self):
        need(set(self.j)==self.journal_fields and
             self.j['operationId']==self.cap.p['operationId'] and self.j['planSha256']==self.cap.hash and
             self.j['contractSha256']==self.cap.contract_digest(),'JOURNAL_BINDING')
        need(isinstance(self.j['calls'],list) and self.j['calls']==CALLS[:len(self.j['calls'])] and
             len(self.j['calls'])<=len(CALLS),'JOURNAL_SCOPE')
        need(self.j['pending'] is None or (self.j['calls'] and self.j['pending']==self.j['calls'][-1]),'JOURNAL_PENDING')

    def observation(self):
        return (self.j['phase']=='READ_FINISHED' and len(self.j['calls'])==len(CALLS) and
                self.j['pending'] is None and self.j['service']=='ENABLED' and
                self.j['permissions']=='OBSERVED' and self.j['roles']=='EXACT' and self.j['failure'] is None)

    def remote_residuals(self):return []

    def result_status(self,observed):
        return 'NARROW_ACCESS_OBSERVED' if observed else 'SERVICE_DISABLED' if self.j['service']=='DISABLED' else 'NARROW_ACCESS_STOPPED'

    def clear_private(self):self.token='';self.number=None

    def closeout(self,independent=False):
        self.cap.gate(True)
        reserve(self.root/('independent-closeout.json' if independent else 'closeout.json'),
                {'operationId':self.cap.p['operationId'],'planSha256':self.cap.hash})
        residuals=[]
        if independent:
            self.j=read(self.root/'journal.json')
            self.validate_journal()
            # An interrupted reservation remains unconfirmed; independent cleanup never replays it.
            if self.j['transportSettled'] is not True:residuals.append('PROCESS_OUTCOME_UNKNOWN')
        else:
            try:
                need(self.io.close() is True,'PROCESS_CLOSE_UNCONFIRMED')
                self.j['transportSettled']=True
            except BaseException:residuals.append('PROCESS_CLOSE_UNCONFIRMED')
        self.clear_private()
        if (self.root/'journal-next.json').exists():
            residuals.append('JOURNAL_WRITE_INTERRUPTED')
            (self.root/'journal-next.json').unlink()  # exact inventoried owned scratch; never promote its claims
        observed=self.observation()
        self.j['residuals']=sorted(set(self.j['residuals']+residuals+self.remote_residuals()));self.j['phase']='CLOSED';self.save()
        private_absent=False
        try:
            need(self.cap.clock()<self.cap.times['purgeEnd'],'PURGE_DEADLINE')
            inspect(self.root,self.cap.p['operationId'])
            (self.root/'plan.json').unlink()
            private_absent=not (self.root/'plan.json').exists() and self.cap.clock()<self.cap.times['purgeEnd']
            need(private_absent,'PURGE_UNCONFIRMED')
        except Exception:self.j['residuals'].append('PRIVATE_PURGE_UNCONFIRMED');self.save()
        result={'status':'CONTAINMENT_UNCONFIRMED' if self.j['residuals'] else
          self.result_status(observed),
          'operationId':self.cap.p['operationId'],'failure':self.j['failure'],'residuals':self.j['residuals'],
          'privateInputsAbsent':private_absent,'externalObservation':self.cap.external,
          'executionReady':False,'counts':{'cli':sum(c[0]=='cli' for c in self.j['calls']),
                                         'https':sum(c[0]=='https' for c in self.j['calls']),
                                         'cache':sum(c[0]=='cache' for c in self.j['calls'])}}
        reserve(self.root/'result.json',result)
        return result


SERVICE_PERMISSIONS=['serviceusage.services.get','serviceusage.services.enable',
                     'serviceusage.services.use','serviceusage.operations.get']
SERVICE_LIMITS={'cli':0,'https':10,'cache':1,'sql':0,'mutations':1,'retry':0}
SERVICE_PREFIX=[['cache',0]]+[['https',i] for i in range(9)]

def service_operation_name(value):
    need(isinstance(value,str) and re.fullmatch(r'operations/[A-Za-z0-9_.-]{1,200}',value), 'OPERATION_SCOPE')
    return value

def service_descriptor(index,number,operation=None):
    need(type(index) is int and 0<=index<=9,'HTTP_SCOPE')
    if index==0:return http_contract()[0]
    need(isinstance(number,str) and re.fullmatch(r'[0-9]{6,20}',number),'PROJECT_NUMBER')
    service=f'projects/{number}/services/apikeys.googleapis.com'
    host='https://serviceusage.googleapis.com/v1/'
    if index==1:
        return {'method':'POST','url':f'https://cloudresourcemanager.googleapis.com/v1/projects/{number}:testIamPermissions',
                'body':{'permissions':SERVICE_PERMISSIONS}}
    if index in (2,9):return {'method':'GET','url':host+service,'body':None}
    if index==3:return {'method':'POST','url':host+service+':enable','body':None}
    return {'method':'GET','url':host+service_operation_name(operation),'body':None}

def service_contract_hash():
    return digest({'version':3,'https':[service_descriptor(i,'000000','operations/pinned') for i in range(10)],
                   'cache':'EXACT_OWNER_CACHED_TOKEN_NO_REFRESH','limits':SERVICE_LIMITS,
                   'runtime':LOCAL_RUNTIME,'projectHash':PROJECT_HASH,'retention':'RETAIN_ENABLED',
                   'pollIntervalSeconds':2,'operationDoneUnset':False})

class ServiceCapability(ReadCapability):
    version=3
    limits=SERVICE_LIMITS
    extra_fields={'serviceRetention'}
    local_decision='APPROVE_LOCAL_SERVICE_ENABLEMENT_PROOF'
    decision_pattern=r'APP013_P08_SERVICE_ENABLE_OPERATION_[0-9]{8}\.json'

    def contract_digest(self):return service_contract_hash()

    def owner_decision(self,scope):
        return {'decision':'APPROVE_EXACT_P08_SERVICE_ENABLEMENT','owner':'Debynyhan Banks',
          'operationId':self.p['operationId'],'scopeSha256':scope,
          'sourceManifestSha256':self.p['sourceManifestSha256'],'serviceRetention':'RETAIN_ENABLED',
          'service':'apikeys.googleapis.com','maxEnableAttempts':1}

class ServiceNativeIO(NativeIO):
    capability_type=ServiceCapability

    def https(self,index,number,token,deadline,operation=None):
        need(not self.closed,'TRANSPORT_CLOSED');self.cap.gate()
        return self.request(service_descriptor(index,number,operation),token,deadline)

    def wait_pending(self,deadline):
        self.cap.gate()
        need(deadline-self.cap.clock()>2,'DEADLINE')
        time.sleep(2)
        self.cap.gate()

class ServiceReader(Reader):
    journal_fields=Reader.journal_fields | {'enableAttempted','operationSha256','operationDone','serviceBefore'}

    def __init__(self,cap,io):
        super().__init__(cap,io)
        self.operation=None
        self.j.update(enableAttempted=False,operationSha256=None,operationDone=False,serviceBefore='NOT_RUN')

    def validate_journal(self):
        j=self.j
        need(set(j)==self.journal_fields and j['operationId']==self.cap.p['operationId'] and
             j['planSha256']==self.cap.hash and j['contractSha256']==self.cap.contract_digest(),'JOURNAL_BINDING')
        calls=j['calls']
        need(isinstance(calls,list) and len(calls)<=11,'JOURNAL_SCOPE')
        prefix=calls[:-1] if calls and calls[-1]==['https',9] else calls
        need(prefix==SERVICE_PREFIX[:len(prefix)] and len(prefix)<=len(SERVICE_PREFIX) and
             (prefix==calls or len(prefix)>=5),'JOURNAL_SCOPE')
        need(j['pending'] is None or (calls and j['pending']==calls[-1]),'JOURNAL_PENDING')
        need(type(j['enableAttempted']) is bool and j['enableAttempted']==(['https',3] in calls) and
             type(j['operationDone']) is bool and type(j['transportSettled']) is bool and
             (j['operationSha256'] is None or isinstance(j['operationSha256'],str) and
              re.fullmatch('[a-f0-9]{64}',j['operationSha256'])) and
             j['serviceBefore'] in ('NOT_RUN','ENABLED','DISABLED') and
             j['service'] in ('NOT_RUN','ENABLED','DISABLED') and
             j['permissions'] in ('NOT_RUN','OBSERVED') and j['roles']=='NOT_RUN' and
             j['phase'] in ('PREPARED','READ_FINISHED','CLOSED') and isinstance(j['residuals'],list) and
             all(isinstance(v,str) and re.fullmatch('[A-Z_]+',v) for v in j['residuals']) and
             (j['failure'] is None or isinstance(j['failure'],str) and re.fullmatch('[A-Z_]+',j['failure'])), 'JOURNAL_STATE')
        need(not j['enableAttempted'] or j['serviceBefore']=='DISABLED','JOURNAL_STATE')
        need(not j['operationDone'] or j['enableAttempted'] and j['operationSha256'] is not None,'JOURNAL_STATE')

    def call(self,kind,index):
        self.cap.gate();calls=self.j['calls']
        if index==9 and kind=='https':
            need(self.j['operationDone'] and 5<=len(calls)<=10 and calls==SERVICE_PREFIX[:len(calls)],'CALL_ORDER')
        else:
            need(len(calls)<len(SERVICE_PREFIX),'CALL_LIMIT')
            need([kind,index]==SERVICE_PREFIX[len(calls)],'CALL_ORDER')
        if kind=='https' and index==3:
            need(self.j['serviceBefore']=='DISABLED' and self.j['permissions']=='OBSERVED' and
                 not self.j['enableAttempted'],'ENABLE_PRECONDITION')
            self.j['enableAttempted']=True
        if kind=='https' and 4<=index<=8:
            need(self.operation is not None and not self.j['operationDone'],'POLL_PRECONDITION')
        calls.append([kind,index]);self.j['pending']=[kind,index];self.j['transportSettled']=False;self.save()
        value=self.io.cached_token(self.cap.times['readEnd']) if kind=='cache' else self.io.https(
            index,self.number,self.token,self.cap.times['readEnd'],self.operation)
        self.cap.gate();self.j['pending']=None;self.j['transportSettled']=True;self.save()
        return value

    def service_state(self,value):
        need(value.get('name')==f'projects/{self.number}/services/apikeys.googleapis.com' and
             value.get('state') in ('ENABLED','DISABLED'),'SERVICE_SHAPE')
        return value['state']

    def operation_result(self,value):
        need(set(value)<={'name','done','metadata','error','response'},'OPERATION_SHAPE')
        name=service_operation_name(value.get('name'))
        need(self.operation is None or self.operation==name,'OPERATION_DRIFT')
        done=value.get('done')
        if done is None:done=False
        need(type(done) is bool and (value.get('metadata') is None or isinstance(value['metadata'],dict)), 'OPERATION_SHAPE')
        error,response=value.get('error'),value.get('response')
        need(error is None or response is None,'OPERATION_SHAPE')
        if not done:need(error is None and response is None,'OPERATION_SHAPE')
        else:
            need(error is None,'SERVICE_OPERATION_FAILED')
            need(isinstance(response,dict) and set(response)<={'@type','service'} and
                 ('@type' not in response or response['@type']=='type.googleapis.com/google.api.serviceusage.v1.EnableServiceResponse') and
                 isinstance(response.get('service'),dict),'OPERATION_RESPONSE')
            need(self.service_state(response['service'])=='ENABLED','SERVICE_ENABLE_RESPONSE')
        self.operation=name;self.j['operationSha256']=digest(name);self.j['operationDone']=done;self.save()
        return done

    def execute(self):
        self.token=self.call('cache',0);validate_token(self.token)
        project=self.http_json(0)
        need(set(project)=={'projectId','projectNumber','lifecycleState'} and
             project['projectId']=='signmons' and project['lifecycleState']=='ACTIVE' and
             isinstance(project['projectNumber'],str) and re.fullmatch(r'[0-9]{6,20}',project['projectNumber']) and
             digest(project['projectNumber'])==PROJECT_HASH,'PROJECT_DRIFT')
        self.number=project['projectNumber']
        permissions=self.http_json(1)
        values=permissions.get('permissions',[])
        need(set(permissions)<={'permissions'} and isinstance(values,list) and
             all(isinstance(v,str) for v in values) and len(values)==len(set(values)) and
             set(values)<=set(SERVICE_PERMISSIONS),'PERMISSION_SHAPE')
        need(set(values)==set(SERVICE_PERMISSIONS),'PERMISSION_DENIED')
        self.j['permissions']='OBSERVED';self.save()
        self.j['serviceBefore']=self.j['service']=self.service_state(self.http_json(2));self.save()
        if self.j['service']=='DISABLED':
            done=self.operation_result(self.http_json(3))
            for index in range(4,9):
                if done:break
                self.io.wait_pending(self.cap.times['readEnd']);self.cap.gate()
                done=self.operation_result(self.http_json(index))
            need(done,'OPERATION_POLL_LIMIT')
            self.j['service']=self.service_state(self.http_json(9));self.save()
            need(self.j['service']=='ENABLED','SERVICE_READBACK')
        self.j['phase']='READ_FINISHED';self.save()

    def observation(self):
        self.validate_journal()
        return (self.j['phase']=='READ_FINISHED' and self.j['pending'] is None and
                self.j['failure'] is None and self.j['service']=='ENABLED' and
                self.j['permissions']=='OBSERVED' and
                ((self.j['serviceBefore']=='ENABLED' and self.j['calls']==SERVICE_PREFIX[:4]) or
                 (self.j['enableAttempted'] and self.j['operationDone'] and self.j['calls'][-1]==['https',9])))

    def remote_residuals(self):
        return ['SERVICE_ENABLE_OUTCOME_UNKNOWN'] if self.j['enableAttempted'] and not self.observation() else []

    def result_status(self,observed):
        return ('SERVICE_ENABLEMENT_OBSERVED' if self.j['enableAttempted'] else 'SERVICE_PREEXISTING_ENABLED') if observed else 'SERVICE_ENABLEMENT_STOPPED'

    def clear_private(self):
        super().clear_private();self.operation=None


KEY_LIMITS={'cli':0,'https':3,'cache':1,'sql':0,'mutations':0,'retry':0}
KEY_CALLS=[['cache',0]]+[['https',i] for i in range(3)]
KEY_STATES={'NOT_RUN','KEY_ABSENCE_OBSERVED','KEY_PRESENT_STOP','KEY_ACCESS_DENIED','KEY_RESPONSE_UNKNOWN'}

def prospective_key(operation):
    need(isinstance(operation,str),'TARGET_UUID')
    try:canonical=str(uuid.UUID(operation))
    except (ValueError,AttributeError):raise Stop('TARGET_UUID') from None
    need(canonical==operation,'TARGET_UUID')
    return 'signmons-p08-'+operation.replace('-','')

def key_descriptor(index,number,operation):
    need(type(index) is int and 0<=index<3,'HTTP_SCOPE')
    key=prospective_key(operation)
    if index==0:return http_contract()[0]
    need(isinstance(number,str) and re.fullmatch(r'[0-9]{6,20}',number),'PROJECT_NUMBER')
    if index==1:return http_contract(number)[5]
    return {'method':'GET','url':f'https://apikeys.googleapis.com/v2/projects/{number}/locations/global/keys/{key}','body':None}

def key_contract_hash():
    return digest({'version':4,'https':[key_descriptor(i,'000000','00000000-0000-0000-0000-000000000001') for i in range(3)],
                   'cache':'EXACT_OWNER_CACHED_TOKEN_NO_REFRESH','limits':KEY_LIMITS,
                   'runtime':LOCAL_RUNTIME,'projectHash':PROJECT_HASH,'target':'CANONICAL_DISTINCT_UUID_DERIVED_KEY'})

class KeyAbsenceCapability(ReadCapability):
    version=4
    limits=KEY_LIMITS
    extra_fields={'prospectiveAuthenticationOperationId','prospectiveKeyId'}
    local_decision='APPROVE_LOCAL_KEY_ABSENCE_PROOF'
    decision_pattern=r'APP013_P08_KEY_ABSENCE_OPERATION_[0-9]{8}\.json'

    def __init__(self,p,*args,**kwargs):
        need(isinstance(p,dict),'PLAN_SHAPE')
        key=prospective_key(p.get('prospectiveAuthenticationOperationId'))
        prospective_key(p.get('operationId'))
        need(p['operationId']!=p['prospectiveAuthenticationOperationId'] and p.get('prospectiveKeyId')==key,'TARGET_SCOPE')
        super().__init__(p,*args,**kwargs)

    def contract_digest(self):return key_contract_hash()

    def owner_decision(self,scope):
        return {'decision':'APPROVE_EXACT_P08_KEY_ABSENCE_READ','owner':'Debynyhan Banks',
                'operationId':self.p['operationId'],'scopeSha256':scope,
                'sourceManifestSha256':self.p['sourceManifestSha256'],'readOnly':True,
                'prospectiveAuthenticationOperationId':self.p['prospectiveAuthenticationOperationId'],
                'prospectiveKeyId':self.p['prospectiveKeyId']}

class KeyAbsenceNativeIO(NativeIO):
    capability_type=KeyAbsenceCapability

    def https(self,index,number,token,deadline):
        need(not self.closed,'TRANSPORT_CLOSED');self.cap.gate()
        return self.request(key_descriptor(index,number,self.cap.p['prospectiveAuthenticationOperationId']),token,deadline)

class KeyAbsenceReader(Reader):
    journal_fields=Reader.journal_fields | {'targetSha256','keyState'}

    def __init__(self,cap,io):
        super().__init__(cap,io)
        self.j.update(targetSha256=digest(cap.p['prospectiveKeyId']),keyState='NOT_RUN')

    def call(self,kind,index):
        self.cap.gate();ordinal=len(self.j['calls'])
        need(ordinal<len(KEY_CALLS),'CALL_LIMIT')
        need([kind,index]==KEY_CALLS[ordinal],'CALL_ORDER')
        self.j['calls'].append([kind,index]);self.j['pending']=[kind,index]
        self.j['transportSettled']=False;self.save()
        result=self.io.cached_token(self.cap.times['readEnd']) if kind=='cache' else self.io.https(index,self.number,self.token,self.cap.times['readEnd'])
        self.cap.gate();self.j['pending']=None;self.j['transportSettled']=True;self.save()
        return result

    def key_state(self,raw):
        if not isinstance(raw,dict) or set(raw)!={'status','body'} or type(raw['status']) is not int:return 'KEY_RESPONSE_UNKNOWN'
        if raw['status'] in (401,403):return 'KEY_ACCESS_DENIED'
        try:value=self.cap.q.bounded_https_json(raw['body'])
        except Exception:return 'KEY_RESPONSE_UNKNOWN'
        if not isinstance(value,dict):return 'KEY_RESPONSE_UNKNOWN'
        if raw['status']==200:
            expected=key_descriptor(2,self.number,self.cap.p['prospectiveAuthenticationOperationId'])['url'].split('/v2/')[1]
            return 'KEY_PRESENT_STOP' if value.get('name')==expected else 'KEY_RESPONSE_UNKNOWN'
        error=value.get('error')
        if (raw['status']==404 and isinstance(error,dict) and error.get('status')=='NOT_FOUND' and
            ('code' not in error or type(error['code']) is int and error['code']==404)):
            return 'KEY_ABSENCE_OBSERVED'
        return 'KEY_RESPONSE_UNKNOWN'

    def execute(self):
        self.token=self.call('cache',0);validate_token(self.token)
        project=self.http_json(0)
        need(set(project)=={'projectId','projectNumber','lifecycleState'} and
             project['projectId']=='signmons' and project['lifecycleState']=='ACTIVE' and
             isinstance(project['projectNumber'],str) and re.fullmatch(r'[0-9]{6,20}',project['projectNumber']) and
             digest(project['projectNumber'])==PROJECT_HASH,'PROJECT_DRIFT')
        self.number=project['projectNumber']
        value=self.http_json(1)
        need(value.get('name')==f'projects/{self.number}/services/apikeys.googleapis.com' and
             value.get('state') in ('ENABLED','DISABLED'),'SERVICE_SHAPE')
        self.j['service']=value['state'];self.save()
        need(self.j['service']=='ENABLED','SERVICE_DISABLED')
        self.j['keyState']=self.key_state(self.call('https',2))
        self.j['phase']='READ_FINISHED';self.save()

    def validate_journal(self):
        j=self.j;calls=j['calls']
        need(set(j)==self.journal_fields and j['operationId']==self.cap.p['operationId'] and
             j['planSha256']==self.cap.hash and j['contractSha256']==self.cap.contract_digest() and
             j['targetSha256']==digest(self.cap.p['prospectiveKeyId']),'JOURNAL_BINDING')
        need(isinstance(calls,list) and len(calls)<=len(KEY_CALLS) and calls==KEY_CALLS[:len(calls)],'JOURNAL_SCOPE')
        need(j['pending'] is None or (calls and j['pending']==calls[-1]),'JOURNAL_PENDING')
        need(type(j['transportSettled']) is bool and j['keyState'] in KEY_STATES and
             j['service'] in ('NOT_RUN','ENABLED','DISABLED') and j['permissions']==j['roles']=='NOT_RUN' and
             j['phase'] in ('PREPARED','READ_FINISHED','CLOSED') and isinstance(j['residuals'],list) and
             all(isinstance(v,str) and re.fullmatch('[A-Z_]+',v) for v in j['residuals']) and
             (j['failure'] is None or isinstance(j['failure'],str) and re.fullmatch('[A-Z_]+',j['failure'])), 'JOURNAL_STATE')
        need(j['keyState']=='NOT_RUN' or calls==KEY_CALLS and j['pending'] is None and j['service']=='ENABLED','JOURNAL_STATE')

    def observation(self):
        self.validate_journal()
        return (self.j['phase']=='READ_FINISHED' and self.j['calls']==KEY_CALLS and self.j['pending'] is None and
                self.j['failure'] is None and self.j['service']=='ENABLED' and self.j['keyState']=='KEY_ABSENCE_OBSERVED')

    def result_status(self,observed):
        if observed:return 'KEY_ABSENCE_OBSERVED'
        if self.j['keyState'] in ('KEY_PRESENT_STOP','KEY_ACCESS_DENIED','KEY_RESPONSE_UNKNOWN'):return self.j['keyState']
        return 'KEY_ABSENCE_STOPPED'


def run(path,mode='read',io_factory=None,clock=time.time,read_commit=None):
    path=Path(path);need(path.name=='plan.json','PLAN_PATH')
    need(mode in ('read','closeout','enable','closeout-enable','key-absence','closeout-key-absence'),'ENTRY_MODE')
    service=mode in ('enable','closeout-enable');cleanup=mode in ('closeout','closeout-enable','closeout-key-absence')
    cap_type,reader_type,native_type=(ServiceCapability,ServiceReader,ServiceNativeIO) if service else (ReadCapability,Reader,NativeIO)
    if mode in ('key-absence','closeout-key-absence'):cap_type,reader_type,native_type=KeyAbsenceCapability,KeyAbsenceReader,KeyAbsenceNativeIO
    cap=cap_type(read(path),path.parent,'closeout' if cleanup else 'read',clock,read_commit)
    io_factory=io_factory or native_type
    fd=os.open(cap.root/'entry.lock',os.O_WRONLY|os.O_CREAT|os.O_NOFOLLOW,0o600)
    io=None;reader=None;handlers={}
    try:
        try:fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
        except BlockingIOError:raise Stop('ENTRY_RUNNING') from None
        inspect(cap.root,cap.p['operationId'])
        if cleanup:
            need(read(cap.root/'attempt.json')=={'operationId':cap.p['operationId'],'planSha256':cap.hash},'ATTEMPT_BINDING')
            return reader_type(cap,None).closeout(True)
        io=io_factory(cap)
        need(cap.external is (not io.proof),'TRANSPORT_AUTHORITY')
        reserve(cap.root/'attempt.json',{'operationId':cap.p['operationId'],'planSha256':cap.hash})
        reader=reader_type(cap,io);reserve(cap.root/'journal.json',reader.j)
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
        if reader is not None:reader.clear_private()
        if io is not None:
            try:io.close()
            except BaseException:pass
        fcntl.flock(fd,fcntl.LOCK_UN);os.close(fd)


def main(argv):
    if argv==['--check-source']:
        sources();print(json.dumps(native_readiness()));return 0
    need(len(argv)==2 and argv[0] in ('--read','--closeout','--enable','--closeout-enable','--key-absence','--closeout-key-absence'),'ENTRY_UNBOUND')
    result=run(argv[1],argv[0][2:]);print(json.dumps(result))
    return 0 if result['status'] in ('NARROW_ACCESS_OBSERVED','SERVICE_ENABLEMENT_OBSERVED','SERVICE_PREEXISTING_ENABLED','KEY_ABSENCE_OBSERVED') else 2

if __name__=='__main__':
    try:raise SystemExit(main(sys.argv[1:]))
    except Exception:
        print('{"status":"NARROW_ACCESS_REFUSED_OR_UNCONFIRMED"}');raise SystemExit(2)
