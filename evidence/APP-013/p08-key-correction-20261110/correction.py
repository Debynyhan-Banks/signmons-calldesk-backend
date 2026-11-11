"""CR-K1 one-version/one-candidate transaction; credentials never enter the journal.

The driver is independent of transport. Native use requires a separately reviewed,
committed exact packet; installing this module grants no external authority.
"""
import fcntl, hashlib, importlib.util, json, os, re, stat, time, uuid
from pathlib import Path
import binding
HERE=Path(__file__).resolve().parent
APP=HERE.parent
BACKEND=APP.parent.parent
class Stop(Exception):pass
def need(ok,code):
 if not ok:raise Stop(code)
SAFE_CODES=frozenset("""CURRENT_OUTPUT NATIVE_COMMAND_UNCONFIRMED NATIVE_COMMAND_REFUSED NATIVE_OUTPUT_ENCODING OWNER_DRIFT OWNER_OVERRIDE TOKEN_SHAPE PASSWORD_SHAPE SQL_ALLOWLIST CLI_VECTOR ROLE_READ_UNCONFIRMED ROLE_OUTPUT_UNKNOWN ROLE_NOT_READY ROLE_IDENTITY_UNKNOWN ROLE_DEADLINE RESOURCE_NOT_RETIRED QUALIFICATION_DRIFT PROJECT_PIN BILLING_NOT_READY EFFECTIVE_PERMISSION_MISSING SERVICE_NOT_READY EXISTING_CANDIDATE_SOURCE REVISION_INVENTORY_UNKNOWN CANDIDATE_ALREADY_EXISTS RUNTIME_PROJECT_GRANT_PRESENT RUNTIME_SIGNING_GRANT_PRESENT KEY_ENDPOINT_PIN KEY_CHECK_DEADLINE KEY_CHECK_HTTP KEY_ACCOUNT_LIST KEY_ACCOUNT_MISMATCH KEY_MODE_MISMATCH PAYMENT_TEST_KEY_REQUIRED PAYMENT_ENDPOINT_DRIFT PAYMENT_OUTPUT_LIMIT PAYMENT_IO_TIMEOUT PAYMENT_DEADLINE KEY_TRANSPORT_OR_OUTPUT_UNKNOWN KEY_CHECK_RESULT BINDING_OUTPUT_INVALID PROVIDER_RESPONSE_UNCONFIRMED PROVIDER_RESPONSE_REFUSED REUSE_VERSION_NOT_DISABLED REUSE_PROVENANCE REUSE_CREATE_FORBIDDEN VERSION_READBACK VERSION_OUTPUT VERSION_IDENTITY_OR_STATE ACTIVATION_UNCONFIRMED DEPLOYMENT_UNCONFIRMED FOREIGN_TAG_REFUSED CLEANUP_READBACK FINAL_READBACK DEADLINE CLOCK_ROLLBACK CALL_LIMIT MUTATION_ALREADY_ATTEMPTED QUALIFICATION_MUTATION_REFUSED""".split())
SAFE_STAGES=frozenset("""LOCAL OWNER PROJECT BILLING IAM SERVICES PERMISSIONS CANDIDATE DATABASE_ROLE RETIRED_RESOURCES CANDIDATE_ABSENCE SANDBOX_KEY REUSE_VERSION CREATE_VERSION CONFIGURE VERSION_READBACK ACTIVATE_IDENTITY ACTIVATE_VERSION ACTIVATE_BINDING ACTIVATE_ROLE DEPLOY DEPLOYMENT_READBACK CLEANUP_ROLE CLEANUP_TAG CLEANUP_BINDING CLEANUP_VERSION CLEANUP_IDENTITY FINAL_READBACK""".split())
def safe_calls(ports):
 calls=getattr(ports,'calls',None)
 if not isinstance(calls,dict):return None
 return {k:(calls.get(k) if type(calls.get(k)) is int and 0<=calls[k]<=10000 else None) for k in ('cli','https','sql','child')}
def safe_failure(error,ports):
 # Never stringify arbitrary exceptions or copy transport output into receipts.
 args=getattr(error,'args',());code=args[0] if len(args)==1 and type(args[0]) is str and args[0] in SAFE_CODES else 'CORRECTION_STOPPED'
 category='VALIDATION_STOP' if code!='CORRECTION_STOPPED' else 'UNKNOWN_EXCEPTION'
 if isinstance(error,KeyboardInterrupt):category='INTERRUPTED'
 elif isinstance(error,TimeoutError):category='TIMEOUT'
 elif isinstance(error,json.JSONDecodeError):category='JSON_DECODE'
 elif isinstance(error,OSError):category='LOCAL_IO'
 stage=getattr(ports,'stage',None)
 return {'code':code,'category':category,'stage':stage if type(stage) is str and stage in SAFE_STAGES else 'LOCAL','calls':safe_calls(ports)}

def lifecycle_stage(kind,cleanup=False):
 return ('CLEANUP_' if cleanup else 'ACTIVATE_')+{'role':'ROLE','tag':'TAG','secretBinding':'BINDING','version':'VERSION','identity':'IDENTITY'}[kind]

def digest(v):return hashlib.sha256(v if isinstance(v,bytes) else json.dumps(v,sort_keys=True,separators=(',',':')).encode()).hexdigest()
def load(relative,name):
 spec=importlib.util.spec_from_file_location(name,APP/relative);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m);return m

def returned_version(value,project):
 need(isinstance(value,dict),'VERSION_OUTPUT')
 match=re.fullmatch(r'projects/'+re.escape(project)+r'/secrets/'+binding.STRIPE+r'/versions/([1-9][0-9]{0,8})',value.get('name',''))
 need(match is not None and int(match[1])>1 and value.get('state')=='ENABLED','VERSION_IDENTITY_OR_STATE')
 return match[1]

def candidate(operation):
 need(str(uuid.UUID(operation))==operation,'OPERATION_ID')
 return 'signmons-calldesk-staging-p07key'+operation.replace('-','')[:12]

def private_root(path):
 path=Path(path);s=path.lstat()
 need(path.resolve()==path and stat.S_ISDIR(s.st_mode) and stat.S_IMODE(s.st_mode)==0o700 and s.st_uid==os.getuid(),'PRIVATE_ROOT')
 return path

def read(path):
 s=path.lstat();need(stat.S_ISREG(s.st_mode) and stat.S_IMODE(s.st_mode)==0o600 and s.st_uid==os.getuid() and not path.is_symlink(),'PRIVATE_FILE')
 need(s.st_size<=131072,'FILE_LIMIT');return json.loads(path.read_text())

def reserve(path,value):
 fd=os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
 try:
  raw=json.dumps(value,sort_keys=True,separators=(',',':')).encode()
  with os.fdopen(fd,'wb',closefd=False) as f:f.write(raw);f.flush();os.fsync(fd)
 finally:os.close(fd)

def atomic(path,value):
 # An interrupted temporary write is evidence, never silently overwritten.
 tmp=path.with_suffix('.tmp');reserve(tmp,value);os.replace(tmp,path)
 fd=os.open(path.parent,os.O_RDONLY)
 try:os.fsync(fd)
 finally:os.close(fd)

REUSE_RECEIPT='evidence/APP-013/p08-key-correction-20261110/kc1-result.json'
REUSE={'secret':binding.STRIPE,'version':'2','operationId':'392807bd-8c43-4a01-b82d-3292f19fd222',
 'receiptCommit':'ff18dbee2a4c7d94338b549f9d16d725a03b58ca',
 'receiptSha256':'9a2066e1c99ec6e50262a3ad0f05a489ac275ebf49b63e8044189e96160464d2'}
def validate_reuse(plan):
 if 'reuse' not in plan:return
 need(plan['reuse']==REUSE and plan['operationId']!=REUSE['operationId'],'REUSE_PROVENANCE')
 path=BACKEND/REUSE_RECEIPT
 need(path.is_file() and not path.is_symlink() and digest(path.read_bytes())==REUSE['receiptSha256'],'REUSE_RECEIPT')
 r=json.loads(path.read_bytes());closed=r['closeout'];j=r['journal']
 need(r['operationId']==REUSE['operationId'] and closed['status']=='CORRECTION_CLOSED' and closed['residuals']==[] and
  closed['stripeVersion']=='2' and closed['retainedResources']==['DISABLED_SECRET_VERSION'] and not closed['adopted'] and
  not closed['candidateReadyObserved'] and j['version']=='2' and not any(x[0]=='deploy' for x in j['intents']),'REUSE_RECEIPT_STATE')

def validate_plan(plan):
 need(set(plan) in ({'operationId','projectNumberSha256','window','qualificationSha256','sourceManifestSha256'}, {'operationId','projectNumberSha256','window','qualificationSha256','sourceManifestSha256','reuse'}),'CORRECTION_PLAN')
 validate_reuse(plan)
 candidate(plan['operationId']);need(plan['projectNumberSha256']=='37d4aa0f46ca5b8f0b81b1148bda235a0f4a9a424b6b4638ec993d889563be54','PROJECT_NUMBER_PIN')
 need(all(re.fullmatch('[a-f0-9]{64}',plan[k] or '') for k in ('qualificationSha256','sourceManifestSha256')),'PLAN_DIGEST')
 w=plan['window'];need(set(w)=={'start','cutoff','workEnd','cleanupEnd'} and all(type(v) in (int,float) for v in w.values()) and
  w['start']<w['cutoff']<w['workEnd']<w['cleanupEnd'] and w['cleanupEnd']-w['start']<=3600 and w['cleanupEnd']-w['workEnd']>=600,'WINDOW')

class Correction:
 def __init__(self,plan,ports,root,clock=time.time):
  validate_plan(plan)
  self.p,self.ports,self.root,self.clock=plan,ports,private_root(root),clock
  self.last=clock();self.j=None;self.lock=None
 def gate(self,cleanup=False):
  n=self.clock();need(n>=self.last,'CLOCK_ROLLBACK');self.last=n
  need(self.p['window']['start']<=n<self.p['window']['cleanupEnd' if cleanup else 'workEnd'],'DEADLINE')
  return self.p['window']['cleanupEnd' if cleanup else 'workEnd']
 def acquire(self):
  self.lock=os.open(self.root/'entry.lock',os.O_WRONLY|os.O_CREAT|os.O_NOFOLLOW,0o600)
  try:fcntl.flock(self.lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
  except BlockingIOError:os.close(self.lock);self.lock=None;raise Stop('CORRECTION_RUNNING') from None
 def release(self):
  if self.lock is not None:os.close(self.lock);self.lock=None
 def save(self):atomic(self.root/'journal.json',self.j)
 def intent(self,kind,name):
  self.gate();row=[kind,name];need(row not in self.j['intents'],'MUTATION_ALREADY_ATTEMPTED')
  self.j['intents'].append(row);self.save()
 def run(self,key,endpoint):
  self.acquire()
  try:
   self.gate();need(self.clock()<self.p['window']['cutoff'],'START_CUTOFF')
   reserve(self.root/'attempt.json',{'operationId':self.p['operationId'],'planSha256':digest(self.p)})
   self.j={'operationId':self.p['operationId'],'planSha256':digest(self.p),'intents':[],
    'version':None,'candidate':candidate(self.p['operationId']),'readiness':None,'failure':None}
   self.save()
   try:
    self.ports.preflight(self.p,self.gate())
    self.ports.check_key(key,endpoint,self.gate())
    if 'reuse' in self.p:
     self.ports.stage='REUSE_VERSION';self.ports.reuse_version_check(self.gate())
     self.j['version']='2';self.save()
     self.ports.configure('2',self.j['candidate'])
     self.intent('version',binding.STRIPE)
     self.ports.stage='ACTIVATE_VERSION';self.ports.change('version',binding.STRIPE,True,self.gate())
    else:
     self.ports.stage='CREATE_VERSION';self.intent('createVersion',binding.STRIPE)
     result=self.ports.add_version(key,self.gate())
     # The returned owned numeric version is journaled before any following call.
     self.j['version']=returned_version(result,self.ports.project_number);self.save()
     self.ports.configure(self.j['version'],self.j['candidate'])
    key=''
    self.ports.stage='VERSION_READBACK';self.ports.version_readback(self.j['version'],self.gate())
    for kind,name in self.ports.activation():
     self.ports.stage=lifecycle_stage(kind);self.intent(kind,name);self.ports.change(kind,name,True,self.gate())
     need(self.ports.readback(kind,name,True,self.gate()),'ACTIVATION_UNCONFIRMED')
    self.ports.stage='DEPLOY';self.intent('deploy',self.j['candidate']);self.ports.deploy(self.gate())
    self.ports.stage='DEPLOYMENT_READBACK';self.j['readiness']=self.ports.deployment_readback(self.gate());self.save()
   except BaseException as error:
    # No provider output or arbitrary exception message is persisted.
    self.j['failureEvidence']=safe_failure(error,self.ports)
    self.j['failure']=self.j['failureEvidence']['code']
    try:self.save()
    except BaseException:self.j['journalFailure']=True
   finally:
    key='';endpoint=''
   return self.cleanup()
  finally:self.ports.clear();self.release()
 def cleanup(self):
  diagnostics=[]
  residuals=['JOURNAL_UNCONFIRMED'] if self.j.get('journalFailure') else [];intents=self.j['intents'];version=self.j['version']
  if ['createVersion',binding.STRIPE] in intents and version is None:
   residuals.append('CREATED_VERSION_OWNERSHIP_UNKNOWN')
  if version is not None:
   self.ports.configure(version,self.j['candidate'])
   # Cleanup only known owned transitions. The created version starts enabled.
   owned=[x for x in intents if x[0] not in ('createVersion','deploy')]
   if ['deploy',self.j['candidate']] in intents:owned.append(['tag','app013-p07-atomic'])
   if ['version',binding.STRIPE] not in owned:owned.append(['version',binding.STRIPE])
   # Role first, then route, bindings, versions, identity.
   order={'role':0,'tag':1,'secretBinding':2,'version':3,'identity':4}
   for kind,name in sorted(owned,key=lambda x:order[x[0]]):
    try:
     self.ports.stage=lifecycle_stage(kind,True);deadline=self.gate(True)
     if not self.ports.readback(kind,name,False,deadline):
      self.ports.change(kind,name,False,deadline)
     need(self.ports.readback(kind,name,False,self.gate(True)),'CLEANUP_READBACK')
    except BaseException as error:residuals.append(kind+':'+name);diagnostics.append(safe_failure(error,self.ports))
   try:
    self.ports.stage='FINAL_READBACK';need(self.ports.final_readback(self.gate(True)) is True,'FINAL_READBACK')
   except BaseException as error:residuals.append('FINAL_READBACK_UNKNOWN');diagnostics.append(safe_failure(error,self.ports))
  self.ports.clear()
  result={'operationId':self.p['operationId'],'status':'CORRECTION_CONTAINMENT_UNCONFIRMED' if residuals else 'CORRECTION_CLOSED',
   'residuals':sorted(set(residuals)),'candidate':self.j['candidate'],'stripeVersion':version,
   'candidateReadyObserved':self.j['readiness'] is not None,'readiness':self.j['readiness'],
   'failure':self.j['failure'],'failureEvidence':self.j.get('failureEvidence'),'cleanupDiagnostics':diagnostics,'calls':safe_calls(self.ports),'privateInputsPersisted':False,'adopted':False,
   'retainedResources':([] if version is None else ['DISABLED_SECRET_VERSION'])+(['REVISION_METADATA'] if ['deploy',self.j['candidate']] in intents else [])}
  if residuals:result['retainedResources']=[] # Unknown containment must not be represented as disabled.
  return result
 def closeout(self):
  self.acquire()
  try:
   self.gate(True);reserve(self.root/'independent-attempt.json',{'planSha256':digest(self.p)})
   need(read(self.root/'attempt.json')=={'operationId':self.p['operationId'],'planSha256':digest(self.p)},'ATTEMPT_BINDING')
   self.j=read(self.root/'journal.json');need(self.j['planSha256']==digest(self.p) and self.j['operationId']==self.p['operationId'] and self.j['candidate']==candidate(self.p['operationId']),'JOURNAL_BINDING')
   # Reconstruct only exact finite operations; arbitrary journal command vectors are impossible.
   allowed=set(self.ports.activation())|{('deploy',self.j['candidate'])}|({('version',binding.STRIPE)} if 'reuse' in self.p else {('createVersion',binding.STRIPE)})
   if 'reuse' in self.p:need(self.j['version'] in (None,'2'),'REUSE_VERSION_DRIFT')
   need(isinstance(self.j['intents'],list) and len(self.j['intents'])==len({tuple(x) for x in self.j['intents']}) and all(tuple(x) in allowed for x in self.j['intents']),'JOURNAL_SCOPE')
   if self.j['version'] is not None:need(isinstance(self.j['version'],str) and re.fullmatch('[1-9][0-9]{0,8}',self.j['version']) and int(self.j['version'])>1,'OWNED_VERSION_PIN')
   return self.cleanup()
  finally:self.ports.clear();self.release()

class Deployment:
 """Reuse the existing actual command and parser without running its historical main."""
 def __init__(self,version,revision,return_url,cloud,health):
  self.m=load('p08-restoration-local-20261028/source/legacy/controller.py','crk1_deployment')
  m=self.m;need(re.fullmatch('[1-9][0-9]{0,8}',version) and int(version)>1,'VERSION_PIN')
  need(re.fullmatch('signmons-calldesk-staging-p07key[a-f0-9]{12}',revision),'CANDIDATE_PIN')
  m.STRIPE_VERSION=version;m.REVISION=revision;m.SUFFIX=revision.removeprefix(m.SERVICE+'-')
  m.PLAIN_ENV['CUSTOMER_PAYMENT_RETURN_URL']=return_url
  m.gc=lambda args,**kw:cloud(args,kw)
  m.journal=lambda:None;m.save=lambda name,value:None
  m.run=lambda args,**kw:health(args,kw)
  self.secret_map=None
 def deploy(self):self.secret_map=self.m.deploy('1',{n:'1' for n in ('openai','admin','conversation','technician')},'1')
 def readback(self):
  need(self.secret_map is not None,'DEPLOY_NOT_ATTEMPTED');self.m.deploy_readback(self.secret_map)
  return {'imageExact':True,'normalTrafficPercent':100,'candidateTrafficPercent':0,'environmentExact':True,'liveness':200,'readiness':200}
