"""Exact retired-resource restoration lifecycle. Disabled until fresh external binding."""
from __future__ import annotations
import copy,datetime as dt,hashlib,importlib.util,json,os,re,signal,stat,sys,time,uuid
from pathlib import Path
ROOT=Path(__file__).resolve().parent
ORIGINAL='093a69824feef7f0885680ba92685927ca5e8259c0752608ca2e84f3abc285ae'
IDENTITY='signmons-calldesk-p07-runtime@signmons.iam.gserviceaccount.com'
SECRETS=tuple('signmons-staging-p07-'+x for x in ['payment-database-url','stripe-webhook-secret','disabled-openai-key','admin-token','conversation-key','technician-link-key'])
POLICIES=SECRETS+('signmons-staging-stripe-secret-key',)
JOB='9180bef4-561d-47a0-869f-925e6a3dfd96';TENANT='a1adcfd4-15be-404b-9ac3-5edb1fda20f0'
NORMAL='signmons-calldesk-staging-app013dbrot2';CANDIDATE='signmons-calldesk-staging-app013p07atomic1';TAG='app013-p07-atomic'
OWNER='debynyhan@signmons.com';ROLE='p07_payment_runtime'
IMAGE='us-east5-docker.pkg.dev/signmons/signmons/signmons-calldesk-backend@sha256:36f887749947c0b01db683482c081ca663534e7ffe597560b24597f3d46be9da'
class Stop(Exception):pass
def need(v,code):
 if not v:raise Stop(code)
def digest(v):return hashlib.sha256(v if isinstance(v,bytes) else json.dumps(v,sort_keys=True,separators=(',',':')).encode()).hexdigest()
def timestamp(v):
 need(isinstance(v,str) and re.fullmatch(r'\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ',v),'UTC_FORMAT')
 return dt.datetime.fromisoformat(v.replace('Z','+00:00')).timestamp()
def private_read(path):
 s=path.lstat();need(stat.S_ISREG(s.st_mode) and not path.is_symlink() and stat.S_IMODE(s.st_mode)==0o600,'PRIVATE_INPUT');return json.loads(path.read_text())
def reserve(path,value):
 fd=os.open(path,os.O_CREAT|os.O_EXCL|os.O_WRONLY,0o600)
 try:os.write(fd,json.dumps(value).encode())
 finally:os.close(fd)
def check_sources(root=ROOT):
 m=json.loads((root/'source-manifest.json').read_text())
 need(m.get('status')=='DISABLED_LOCAL_PREPARATION_ONLY','LOCAL_MANIFEST')
 for name,h in m['files'].items():
  need(not Path(name).is_absolute() and '..' not in Path(name).parts,'SOURCE_PATH');p=root/name
  need(not p.is_symlink() and p.is_file() and hashlib.sha256(p.read_bytes()).hexdigest()==h,'SOURCE_DRIFT')
 need(hashlib.sha256((root/'legacy/controller.py').read_bytes()).hexdigest()==ORIGINAL,'LEGACY_SOURCE_DRIFT')
 backend=Path(json.loads((root/'auth/local-plan.json').read_text())['backend'])
 for name,h in json.loads((root/'auth/reuse/backend-lock.json').read_text()).items():need(hashlib.sha256((backend/name).read_bytes()).hexdigest()==h,'BACKEND_SOURCE_DRIFT')
 return m

def local_environment_gate(env=None,config_root=None):
 import configparser
 env=os.environ if env is None else env
 need(not any(v for k,v in env.items() if k.startswith('PG') or k=='DATABASE_URL' or k in ['GOOGLE_APPLICATION_CREDENTIALS','CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE','CLOUDSDK_AUTH_IMPERSONATE_SERVICE_ACCOUNT','CLOUDSDK_AUTH_ACCESS_TOKEN','CLOUDSDK_AUTH_ACCESS_TOKEN_FILE']),'CREDENTIAL_OVERRIDE')
 root=Path(config_root or '/Users/debynyhanbanks/.config/gcloud')
 need(not env.get('CLOUDSDK_CONFIG') or Path(env['CLOUDSDK_CONFIG'])==root,'CLOUD_CONFIG_OVERRIDE')
 name=(root/'active_config').read_text().strip();need(re.fullmatch('[A-Za-z0-9_-]+',name),'CONFIG_NAME')
 c=configparser.ConfigParser(interpolation=None);c.read(root/'configurations'/('config_'+name))
 need(not any(c.get('auth',k,fallback='').strip() for k in ['impersonate_service_account','credential_file_override','access_token_file']),'PERSISTED_CREDENTIAL_OVERRIDE')
 return True

def authorize(p,a,q,source_hash,proposal_hash,now,mode="restore"):
 need(p.get('mode')=='RESTORE_AUTHENTICATE_RETIRE' and p.get('automaticRetryAllowed') is False,'MODE')
 need(str(uuid.UUID(p.get('operationId','')))==p['operationId'],'OPERATION_ID')
 need(p.get('jobId')==JOB and p.get('tenantId')==TENANT and p.get('ownerPrincipal')==OWNER,'IDENTITY_SCOPE')
 need(p.get('sourceManifestSha256')==source_hash and p.get('proposalSha256')==proposal_hash,'SOURCE_BINDING')
 t={k:timestamp(p['window'][k]) for k in ['start','cutoff','workEnd','cleanupEnd','purgeEnd']}
 need(t['start']<t['cutoff']<t['workEnd']<t['cleanupEnd']<t['purgeEnd'] and t['purgeEnd']-t['start']<=3600 and t['cleanupEnd']-t['workEnd']>=600,'WINDOW')
 need(mode in ['restore','closeout'] and t['start']<=now<t['cutoff' if mode=='restore' else 'cleanupEnd'],'START_CUTOFF')
 need(a.get('owner')=='Debynyhan Banks' and a.get('externalActionAuthorized') is True and a.get('decision')=='APPROVE_EXACT_RESTORE_AUTHENTICATE_RETIRE' and a.get('planSha256')==digest(p) and a.get('sourceManifestSha256')==source_hash and a.get('proposalSha256')==proposal_hash and a.get('operationId')==p['operationId'],'OWNER_APPROVAL')
 need(p.get('qualificationSha256')==digest(q) and q.get('status')=='EXACT_RESTORATION_QUALIFIED' and q.get('operationId')==p['operationId'] and timestamp(q['qualifiedUntil'])>=t['cleanupEnd'],'QUALIFICATION_BINDING')
 need(q.get('sourceMatched') is True and q.get('trafficMatched') is True and q.get('testAccountOwnedDisabled') is True and q.get('keyRestrictionsCompatible') is True and q.get('ownerAccessQualified') is True,'QUALIFICATION_FACTS')
 need(q.get('grantFixtureSha256')=='35785d3857f6fc9b01042d6dee3137eebb18950601fb1b8e7644e340be8fb83c','ROLE_FIXTURE')
 need(isinstance(q.get('roleAclSha256'),str) and re.fullmatch('[a-f0-9]{64}',q['roleAclSha256']),'ROLE_ACL')
 need(isinstance(p.get('authenticationPlanSha256'),str) and re.fullmatch('[a-f0-9]{64}',p['authenticationPlanSha256']) and q.get('authenticationPlanSha256')==p['authenticationPlanSha256'],'AUTH_PLAN_HASH')
 need(p.get('authenticationSourceSha256')=='305f27922daecf24721a25fc3e78c27554cc481e3ce902664d4f574044bcf5c8' and q.get('authPlanAndApprovalBound') is True,'AUTH_BINDING')
 # Exact conditional IAM definitions/permissions and start/end are reviewed externally, never inferred.
 for x in p.get('iam',[]):
  need(set(x)=={'kind','roleId','permissions','condition','preexisting'},'IAM_SHAPE')
  need(x['kind'] in ['lookup','signing'] and re.fullmatch(r'projects/signmons/roles/[A-Za-z0-9_]+',x['roleId']),'IAM_ROLE')
  need(x['permissions']==(['firebaseauth.users.get'] if x['kind']=='lookup' else ['iam.serviceAccounts.signBlob']),'IAM_PERMISSION')
  need(x['preexisting'] is True,'ROLE_CREATION_NOT_BOUND')
  need(x['condition']==f"expression=request.time >= timestamp('{p['window']['start']}') && request.time < timestamp('{p['window']['workEnd']}'),title=p08_{p['operationId']}_{x['kind']}",'IAM_CONDITION')
 need(len({x['kind'] for x in p.get('iam',[])})==len(p.get('iam',[]))<=2,'IAM_DUPLICATE')
 return t

def operations(p):
 out=[('identity',IDENTITY)] + [('version',n) for n in SECRETS]+[('secretBinding',n) for n in POLICIES]
 out += [('iam',x['kind']) for x in p.get('iam',[])]
 return out+[('tag',TAG),('role',ROLE)]

def command(p,kind,name,enable):
 """One exact immutable command vector per scoped Cloud action; no prefixes accepted."""
 if kind=='identity':return ['iam','service-accounts','enable' if enable else 'disable',IDENTITY,'--project=signmons','--quiet']
 if kind=='version':need(name in SECRETS,'FOREIGN_SECRET');return ['secrets','versions','enable' if enable else 'disable','1','--secret='+name,'--project=signmons','--quiet']
 if kind=='secretBinding':
  need(name in POLICIES,'FOREIGN_POLICY');return ['secrets','add-iam-policy-binding' if enable else 'remove-iam-policy-binding',name,'--project=signmons','--member=serviceAccount:'+IDENTITY,'--role=roles/secretmanager.secretAccessor','--condition=None','--quiet']
 if kind=='tag':return ['run','services','update-traffic','signmons-calldesk-staging','--project=signmons','--region=us-east5',('--update-tags='+TAG+'='+CANDIDATE) if enable else '--remove-tags='+TAG,'--quiet']
 if kind=='iam':
  x=next(x for x in p['iam'] if x['kind']==name)
  base=['projects','add-iam-policy-binding' if enable else 'remove-iam-policy-binding','signmons'] if name=='lookup' else ['iam','service-accounts','add-iam-policy-binding' if enable else 'remove-iam-policy-binding',IDENTITY,'--project=signmons']
  return base+['--member='+('serviceAccount:'+IDENTITY if name=='lookup' else 'user:'+OWNER),'--role='+x['roleId'],'--condition='+x['condition'],'--quiet']
 raise Stop('NO_CLOUD_COMMAND')

def role_sql(enable,deadline=None):
 if enable:
  timestamp(deadline)
  return f"BEGIN; SET LOCAL lock_timeout='2s'; ALTER ROLE {ROLE} LOGIN CONNECTION LIMIT 6 VALID UNTIL '{deadline}'; COMMIT;"
 return f"BEGIN; SET LOCAL lock_timeout='2s'; ALTER ROLE {ROLE} NOLOGIN CONNECTION LIMIT 0 VALID UNTIL '1970-01-01T00:00:00Z'; SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE usename='{ROLE}' AND pid<>pg_backend_pid(); COMMIT;"

class Controller:
 def __init__(self,p,a,q,adapter,directory,source_hash,proposal_hash,clock=time.time,mode="restore"):
  self.clock=clock;self.p=p;self.t=authorize(p,a,q,source_hash,proposal_hash,clock(),mode);self.adapter=adapter;self.q=q;self.dir=Path(directory);self.interrupted=False;self.last=clock()
  need(not self.dir.is_symlink() and stat.S_IMODE(self.dir.stat().st_mode)==0o700,'DIRECTORY')
  self.j={'operationId':p['operationId'],'planSha256':digest(p),'attempted':[],'finished':[],'unknown':[],'authenticated':False,'authAttempted':False,'authOutcomeUnknown':False}
 def save(self):
  tmp=self.dir/'journal.tmp';fd=os.open(tmp,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
  try:os.write(fd,json.dumps(self.j).encode())
  finally:os.close(fd)
  os.replace(tmp,self.dir/'journal.json')
 def check(self,cleanup=False):
  n=self.clock();need(n>=self.last,'CLOCK_ROLLBACK');self.last=n;need(n<self.t['cleanupEnd' if cleanup else 'workEnd'],'DEADLINE');need(cleanup or not self.interrupted,'INTERRUPTED')
 def invoke(self,method,*args,cleanup=False):
  self.check(cleanup);deadline=self.t['cleanupEnd' if cleanup else 'workEnd'];value=getattr(self.adapter,method)(*args,deadline=deadline)
  try:self.check(cleanup)
  except BaseException as e:
   if method=='change':e.adapterAcknowledged=True
   raise
  return value
 def run(self):
  reserve(self.dir/'attempt.json',{'operationId':self.p['operationId'],'planSha256':digest(self.p)})
  previous={s:signal.getsignal(s) for s in [signal.SIGINT,signal.SIGTERM]};handler=lambda *_:setattr(self,'interrupted',True)
  for s in previous:signal.signal(s,handler)
  try:
   self.save()
   need(self.invoke('preflight',self.p,self.q) is True,'PREFLIGHT_REFUSED')
   for kind,name in operations(self.p):
    self.check();self.j['attempted'].append([kind,name]);self.save()
    try:self.invoke('change',kind,name,True,self.p)
    except BaseException as e:
     if not getattr(e,'adapterAcknowledged',False):self.j['unknown'].append([kind,name])
     self.save();raise
    need(self.invoke('readback',kind,name,True,self.p) is True,'RESTORE_READBACK')
    self.j['finished'].append([kind,name]);self.save()
   self.j['authAttempted']=True;self.save()
   try:proof=self.invoke('authenticate',self.p)
   except BaseException:self.j['authOutcomeUnknown']=True;self.save();raise
   need(proof=={'status':'P08_OPERATOR_AUTHENTICATED_AND_CLOSED','authenticated':True,'sessionsAbsent':True,'privateMetadataAbsent':True,'privateMetadataPurgeOnTime':True,'residuals':[]},'AUTH_PROOF_REFUSED')
   self.j['authenticated']=True;self.save()
  except BaseException as e:
   self.j['failureCode']=str(e) if isinstance(e,Stop) else 'ADAPTER_UNKNOWN'
   try:self.save()
   except BaseException:self.j['persistenceUnconfirmed']=True
  finally:
   try:result=self.cleanup()
   except BaseException:result={'status':'CONTAINMENT_UNCONFIRMED','authenticated':self.j['authenticated'],'residuals':['CLOSEOUT_OR_PERSISTENCE_UNCONFIRMED'],'failureCode':self.j.get('failureCode')}
   finally:
    for s,h in previous.items():signal.signal(s,h)
  return result
 def cleanup(self,independent=False):
  reserve(self.dir/('independent-closeout.json' if independent else 'closeout.json'),{'operationId':self.p['operationId']})
  if independent:
   self.j=private_read(self.dir/'journal.json');need(self.j['operationId']==self.p['operationId'] and self.j['planSha256']==digest(self.p),'FOREIGN_JOURNAL')
   valid=[list(x) for x in operations(self.p)];need(self.j.get('attempted')==valid[:len(self.j.get('attempted',[]))],'JOURNAL_RESOURCE_SCOPE')
  residuals=[]
  if self.j.get('authAttempted') and not self.j['authenticated']:
   try:need(self.invoke('close_authentication',self.p,cleanup=True) is True,'AUTH_CLOSEOUT_UNCONFIRMED')
   except BaseException:residuals.append('AUTH_ACCOUNT_SESSION_CLOSEOUT')
   if self.j.get('authOutcomeUnknown'):residuals.append('AUTH_OUTCOME_UNKNOWN')
  for kind,name in reversed(self.j['attempted']):
   try:self.invoke('change',kind,name,False,self.p,cleanup=True);need(self.invoke('readback',kind,name,False,self.p,cleanup=True) is True,'CLOSEOUT_READBACK')
   except BaseException:residuals.append(kind+':'+name)
  try:need(self.invoke('retired',self.p,cleanup=True) is True,'RETIRED_READBACK')
  except BaseException:residuals.append('FINAL_RETIREMENT_READBACK')
  # A lost mutation response may arrive after the readback; preserve uncertainty.
  residuals += ['UNKNOWN:'+k+':'+n for k,n in self.j['unknown']]
  if self.j.get('persistenceUnconfirmed'):residuals.append('JOURNAL_PERSISTENCE')
  self.j['residuals']=residuals;self.save()
  return {'status':'P08_RESTORE_AUTH_RETIRE_VERIFIED' if self.j['authenticated'] and not residuals else 'P08_RESTORATION_STOP_CONTAINED' if not residuals else 'CONTAINMENT_UNCONFIRMED','authenticated':self.j['authenticated'],'residuals':residuals,'failureCode':self.j.get('failureCode')}

# This adapter is source-locked and unreachable without exact external plans and approval.
# Tests replace its runner/SQL/auth child, so native argument construction is exercised offline.
AUTH_CHILD = r"""
import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
import {execFileSync} from 'node:child_process';
const root=process.argv[1],mode=process.argv[2];
const {runLaunch,verifySources}=await import(pathToFileURL(root+'/auth-launch.mjs'));
const {privateJson}=await import(pathToFileURL(root+'/auth-authority.mjs'));
const {purgeMetadata}=await import(pathToFileURL(root+'/reuse/account-launch.mjs'));
let password=readFileSync(0,'utf8');
try {
 const p=privateJson(root+'/auth-plan.json'),a=privateJson(root+'/auth-approval.json'),ownership=privateJson(p.ownershipPath),sources=verifySources();
 const proposal=execFileSync('/usr/bin/git',['show',p.proposalCommit+':APP013_P08_AUTHENTICATION_OPERATION_20261026.md'],{cwd:'/Users/debynyhanbanks/Web Projects/signmons-governance-r08-recovery',encoding:'utf8',timeout:5000});
 const result=await runLaunch({p,a,proposal,sources,ownership,directory:'/private/tmp/p08-auth-proof-'+p.operationId,mode,passwordInput:async()=>{const v=password;password='';return v}});
 if(!result.residuals.length)purgeMetadata([root+'/auth-plan.json']);
 result.privateMetadataAbsent=!existsSync(root+'/auth-plan.json');result.privateMetadataPurgeOnTime=Date.now()<Date.parse(p.window.purgeEnd);
 writeFileSync(root+'/auth-result-'+(mode==='authenticate'?'authenticate':'closeout-only')+'.json',JSON.stringify(result)+'\n',{mode:0o600,flag:'wx'});
 console.log(result.status);
} catch {console.log('P08_AUTH_CHILD_REFUSED_OR_UNKNOWN');process.exitCode=2} finally {password=''}
"""

class NativeAdapter:
 def __init__(self,legacy,password,root=ROOT,runner=None,sql=None,auth=None,clock=time.time):
  self.c=legacy;self.password=password;self.root=root;self.clock=clock;self.runner=runner;self.sql_runner=sql;self.auth_runner=auth;self.p=None;self.q=None
 def cloud(self,args,deadline):
  if self.runner:return self.runner(args,deadline)
  with self.c.phase_guard(deadline):return self.c.gc(args,json_out=True,timeout=min(10,max(.01,deadline-self.clock())),env={'CLOUDSDK_CORE_DISABLE_PROMPTS':'true','CLOUDSDK_CORE_DISABLE_FILE_LOGGING':'true','CLOUDSDK_CORE_LOG_HTTP':'false'})
 def sql(self,text,deadline):
  if self.sql_runner:return self.sql_runner(text,deadline)
  with self.c.phase_guard(deadline):return self.c.psql_admin(self.password,text,timeout=min(10,max(.01,deadline-self.clock())))
 def role(self,deadline):
  # Enumerate only ACL entries addressed to this existing role, not other principals.
  query=f'''BEGIN TRANSACTION READ ONLY;
WITH r AS (SELECT * FROM pg_roles WHERE rolname='{ROLE}'), grants AS (
 SELECT 'relation' AS kind,n.nspname||'.'||c.relname AS object,a.privilege_type,a.is_grantable FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace CROSS JOIN LATERAL aclexplode(c.relacl) a WHERE a.grantee=(SELECT oid FROM r)
 UNION ALL SELECT 'schema',n.nspname,a.privilege_type,a.is_grantable FROM pg_namespace n CROSS JOIN LATERAL aclexplode(n.nspacl) a WHERE a.grantee=(SELECT oid FROM r)
 UNION ALL SELECT 'routine',p.oid::regprocedure::text,a.privilege_type,a.is_grantable FROM pg_proc p CROSS JOIN LATERAL aclexplode(p.proacl) a WHERE a.grantee=(SELECT oid FROM r)
 UNION ALL SELECT 'database',d.datname,a.privilege_type,a.is_grantable FROM pg_database d CROSS JOIN LATERAL aclexplode(d.datacl) a WHERE a.grantee=(SELECT oid FROM r)
 UNION ALL SELECT 'default',d.defaclnamespace::text||':'||d.defaclobjtype::text,a.privilege_type,a.is_grantable FROM pg_default_acl d CROSS JOIN LATERAL aclexplode(d.defaclacl) a WHERE a.grantee=(SELECT oid FROM r)
)
SELECT json_build_object('count',(SELECT count(*) FROM r),'login',(SELECT rolcanlogin FROM r),'limit',(SELECT rolconnlimit FROM r),'expires',(SELECT rolvaliduntil::text FROM r),'expired',(SELECT rolvaliduntil<now() FROM r),'unsafe',(SELECT rolinherit OR rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls FROM r),'memberships',(SELECT count(*) FROM pg_auth_members WHERE member=(SELECT oid FROM r)),'owned',(SELECT count(*) FROM pg_shdepend WHERE refclassid='pg_authid'::regclass AND refobjid=(SELECT oid FROM r) AND deptype='o'),'sessions',(SELECT count(*) FROM pg_stat_activity WHERE usename='{ROLE}'),'acl',COALESCE((SELECT json_agg(row_to_json(g) ORDER BY kind,object,privilege_type,is_grantable) FROM grants g),'[]'::json))::text;
ROLLBACK;'''
  return json.loads(self.sql(query,deadline))
 def traffic(self,p,deadline,tag):
  svc=self.cloud(['run','services','describe','signmons-calldesk-staging','--project=signmons','--region=us-east5','--format=json(status.traffic)'],deadline)
  rows=svc.get('status',{}).get('traffic');need(isinstance(rows,list) and rows,'TRAFFIC_SHAPE')
  positive=[x for x in rows if x.get('percent',0)!=0]
  need(len(positive)==1 and positive[0].get('revisionName')==NORMAL and positive[0].get('percent')==100,'NORMAL_TRAFFIC')
  tags=[x for x in rows if x.get('tag')==TAG];return (len(tags)==1 and tags[0].get('revisionName')==CANDIDATE and tags[0].get('percent',0)==0) if tag else not tags
 def policy(self,kind,name,p,deadline):
  if kind=='secretBinding':
   v=self.cloud(['secrets','get-iam-policy',name,'--project=signmons','--format=json'],deadline);member='serviceAccount:'+IDENTITY;role='roles/secretmanager.secretAccessor';condition=None
  else:
   x=next(x for x in p['iam'] if x['kind']==name);member='serviceAccount:'+IDENTITY if name=='lookup' else 'user:'+OWNER;role=x['roleId']
   args=['projects','get-iam-policy','signmons','--format=json'] if name=='lookup' else ['iam','service-accounts','get-iam-policy',IDENTITY,'--project=signmons','--format=json']
   v=self.cloud(args,deadline);condition={'expression':x['condition'].split(',title=')[0].removeprefix('expression='),'title':x['condition'].split(',title=')[1]}
  bindings=v.get('bindings',[]);need(isinstance(bindings,list),'POLICY_SHAPE');owned=[b for b in bindings if member in b.get('members',[]) and (kind=='secretBinding' or b.get('role')==role)]
  if not owned:return False
  need(len(owned)==1 and owned[0].get('role')==role and owned[0].get('condition')==condition,'POLICY_DRIFT')
  return True
 def readback(self,kind,name,enabled,p,deadline):
  if kind=='identity':
   v=self.cloud(['iam','service-accounts','describe',IDENTITY,'--project=signmons','--format=json(email,disabled)'],deadline);return v.get('email')==IDENTITY and v.get('disabled',False)==(not enabled)
  if kind=='version':return self.cloud(['secrets','versions','describe','1','--secret='+name,'--project=signmons','--format=json(state)'],deadline).get('state')==('ENABLED' if enabled else 'DISABLED')
  if kind in ['secretBinding','iam']:return self.policy(kind,name,p,deadline)==enabled
  if kind=='tag':return self.traffic(p,deadline,enabled)
  if kind=='role':
   v=self.role(deadline);safe=v.get('count')==1 and v.get('unsafe') is False and v.get('memberships')==0 and v.get('owned')==0 and digest(v.get('acl'))==self.q['roleAclSha256']
   if not safe:return False
   if enabled:return v.get('login') is True and v.get('limit')==6 and dt.datetime.fromisoformat(v['expires']).timestamp()==timestamp(p['window']['workEnd'])
   return v.get('login') is False and v.get('limit')==0 and v.get('expired') is True and v.get('sessions')==0
  raise Stop('READBACK_SCOPE')
 def preflight(self,p,q,deadline):
  self.p=p;self.q=q
  if self.runner:owner=self.runner(['auth','list','--filter=status:ACTIVE','--format=value(account)'],deadline)
  else:
   with self.c.phase_guard(deadline):owner=self.c.gc(['auth','list','--filter=status:ACTIVE','--format=value(account)'],timeout=10)
  need(owner.strip()==OWNER,'OWNER_MISMATCH')
  revision=self.cloud(['run','revisions','describe',CANDIDATE,'--project=signmons','--region=us-east5','--format=json(spec.serviceAccountName,spec.containers[].image,spec.containers[].env,status.conditions)'],deadline)
  containers=revision.get('spec',{}).get('containers');need(isinstance(containers,list) and len(containers)==1 and containers[0].get('image')==IMAGE and revision['spec'].get('serviceAccountName')==IDENTITY,'CANDIDATE_SOURCE')
  need(digest(containers[0].get('env'))==q.get('runtimeEnvironmentSha256'),'ENVIRONMENT_DRIFT')
  for x in p.get('iam',[]):
   v=self.cloud(['iam','roles','describe',x['roleId'].split('/')[-1],'--project=signmons','--format=json(name,includedPermissions,deleted,stage)'],deadline)
   need(v.get('name')==x['roleId'] and sorted(v.get('includedPermissions',[]))==x['permissions'] and not v.get('deleted') and v.get('stage') not in ['DISABLED','DEPRECATED'],'CUSTOM_ROLE_DRIFT')
  return all(self.readback(k,n,False,p,deadline) for k,n in operations(p))
 def change(self,kind,name,enabled,p,deadline):
  if kind=='role':self.sql(role_sql(enabled,p['window']['workEnd'] if enabled else None),deadline)
  else:self.cloud(command(p,kind,name,enabled),deadline)
 def authenticate(self,p,deadline):
  auth_plan=private_read(self.root/'auth/auth-plan.json');need(digest(auth_plan)==p['authenticationPlanSha256'],'AUTH_PLAN_DRIFT');need(auth_plan.get('window')==p['window'] and auth_plan.get('jobId')==JOB and auth_plan.get('target',{}).get('tenantId')==TENANT,'AUTH_WINDOW_SCOPE_DRIFT')
  args=[getattr(self.c,'NODE','/Users/debynyhanbanks/.nvm/versions/node/v24.12.0/bin/node'),'--input-type=module','-e',AUTH_CHILD,str(self.root/'auth'),'authenticate']
  if self.auth_runner:return self.auth_runner(args,deadline)
  with self.c.phase_guard(deadline):self.c.run(args,input_bytes=self.password.encode(),timeout=max(.01,deadline-self.clock()),env={'CLOUDSDK_CORE_DISABLE_PROMPTS':'true','CLOUDSDK_CORE_DISABLE_FILE_LOGGING':'true','CLOUDSDK_CORE_LOG_HTTP':'false'})
  # Existing native implementation writes the sanitized result only after disable/revoke/purge/session closeout.
  v=private_read(self.root/'auth/auth-result-authenticate.json')
  return {k:v.get(k) for k in ['status','authenticated','sessionsAbsent','privateMetadataAbsent','privateMetadataPurgeOnTime','residuals']}
 def close_authentication(self,p,deadline):
  args=[getattr(self.c,'NODE','/Users/debynyhanbanks/.nvm/versions/node/v24.12.0/bin/node'),'--input-type=module','-e',AUTH_CHILD,str(self.root/'auth'),'closeout']
  if self.auth_runner:return self.auth_runner(args,deadline) is True
  with self.c.phase_guard(deadline,cleanup=True):self.c.run(args,input_bytes=self.password.encode(),timeout=min(30,max(.01,deadline-self.clock())),env={'CLOUDSDK_CORE_DISABLE_PROMPTS':'true','CLOUDSDK_CORE_DISABLE_FILE_LOGGING':'true','CLOUDSDK_CORE_LOG_HTTP':'false'})
  v=private_read(self.root/'auth/auth-result-closeout-only.json')
  return v.get('residuals')==[] and v.get('sessionsAbsent') is True and v.get('privateMetadataAbsent') is True and v.get('privateMetadataPurgeOnTime') is True
 def retired(self,p,deadline):return all(self.readback(k,n,False,p,deadline) for k,n in operations(p))
 def clear(self):self.password=''

def purge_plans(root=ROOT):
 for path in [root/'restore-plan.json',root/'auth/auth-plan.json']:
  if path.exists() or path.is_symlink():
   st=path.lstat();need(stat.S_ISREG(st.st_mode) and not path.is_symlink() and stat.S_IMODE(st.st_mode)==0o600,'PRIVATE_PURGE_PATH');path.unlink()
 return all(not x.exists() and not x.is_symlink() for x in [root/'restore-plan.json',root/'auth/auth-plan.json'])
def finish_private(result,p,root=ROOT,clock=time.time,pause=time.sleep):
 deadline=timestamp(p['window']['purgeEnd']);previous={x:signal.getsignal(x) for x in [signal.SIGINT,signal.SIGTERM]}
 try:
  for x in previous:signal.signal(x,lambda *_:None)
  if result['residuals']:
   while clock()<deadline-2:
    try:pause(min(.1,max(0,deadline-2-clock())))
    except (KeyboardInterrupt,InterruptedError):continue
  try:result['privatePlansAbsent']=purge_plans(root)
  except BaseException:result['privatePlansAbsent']=False
  result['privatePurgeOnTime']=clock()<deadline
  if not result['privatePlansAbsent'] or not result['privatePurgeOnTime']:
   result['status']='CONTAINMENT_UNCONFIRMED';result['residuals'].append('PRIVATE_PLAN_PURGE')
  return result
 finally:
  for x,h in previous.items():signal.signal(x,h)

def native():
 adapter=None
 try:
  need(sys.argv[1:] in [['--restore'],['--closeout-only']],'MODE')
  manifest=check_sources();p=private_read(ROOT/'restore-plan.json');a=private_read(ROOT/'restore-approval.json');q=private_read(ROOT/'qualification.json')
  import subprocess
  need(re.fullmatch('[a-f0-9]{40}',p.get('proposalCommit','')),'PROPOSAL_COMMIT')
  proposal=subprocess.run(['/usr/bin/git','show',p['proposalCommit']+':APP013_P08_RESTORATION_OPERATION_20261028.md'],cwd='/Users/debynyhanbanks/Web Projects/signmons-governance-r08-recovery',capture_output=True,timeout=5,check=True).stdout
  mode='restore' if sys.argv[1]=='--restore' else 'closeout';t=authorize(p,a,q,digest(manifest),hashlib.sha256(proposal).hexdigest(),time.time(),mode)
  spec=importlib.util.spec_from_file_location('p07_locked_source',ROOT/'legacy/controller.py');c=importlib.util.module_from_spec(spec);spec.loader.exec_module(c);c.ROOT=ROOT
  # Same private hidden-input primitive; no credential resolution before all authority/source gates.
  local_environment_gate()
  with c.phase_guard(t['cleanupEnd'] if mode=='closeout' else t['workEnd']):password=c.private_input('Enter current CHILD administrator password (hidden): ')
  adapter=NativeAdapter(c,password);adapter.p=p;adapter.q=q;password=''
  directory=ROOT/('proof-'+p['operationId']);directory.mkdir(mode=0o700,exist_ok=True)
  controller=Controller(p,a,q,adapter,directory,digest(manifest),hashlib.sha256(proposal).hexdigest(),mode=mode)
  result=controller.run() if mode=='restore' else controller.cleanup(independent=True)
  # Clear credentials before any bounded wait for independent closeout/absolute private purge.
  adapter.clear();result=finish_private(result,p)
  reserve(ROOT/('restore-result-'+mode+'.json'),result);print(result['status']);return 0 if result['status']=='P08_RESTORE_AUTH_RETIRE_VERIFIED' else 1
 except FileNotFoundError:print('P08_RESTORE_REFUSED_UNBOUND');return 2
 except BaseException:print('P08_RESTORE_REFUSED_UNBOUND_OR_SOURCE');return 2
 finally:
  if adapter:adapter.clear()
if __name__=='__main__':sys.exit(native())
