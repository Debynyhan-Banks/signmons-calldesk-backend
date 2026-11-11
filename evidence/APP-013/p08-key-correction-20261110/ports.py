"""Native CR-K1 ports; exact approval/source verification belongs to launch.py."""
import base64, datetime, json, sys, time, urllib.error, urllib.request
from types import SimpleNamespace
import correction as c
import binding
sys.path.insert(0,str(c.APP/'p08-native-entry-local-20261101/source'))
import entry
from native_io import NativeIO,NoRedirect,load_acl
sys.path.insert(0,str(c.APP/'p08-https-output-category-local-20261029/source'))
import qualification_launch as q
NODE='/Users/debynyhanbanks/.nvm/versions/node/v24.12.0/bin/node'

class NativePorts:
 def __init__(self,plan,qualification,limits,clock=time.time):
  self.clock=clock;self.p=plan;self.expected=qualification;self.calls={k:0 for k in ('cli','https','sql','child')};self.limits=limits;self.last=clock();self.cleanup=False;self.stage='OWNER'
  legacy=c.load('p08-restoration-local-20261028/source/legacy/controller.py','crk1_io_legacy')
  self.cap=SimpleNamespace(external=True,mode='run',clock=clock,
   plan={'ownerPrincipal':'debynyhan@signmons.com','project':'signmons','operationId':plan['operationId'],
    'window':{'workEnd':self.iso(plan['window']['workEnd'])}},
   e={'version':1,'database':{'host':legacy.DB_HOST,'port':5432,'database':legacy.DB_NAME,'user':legacy.DB_ADMIN}},
   modules={'restore':c.load('p08-restoration-local-20261028/source/restore.py','crk1_io_restore')})
  self.cap.gate=self.gate;self.cap.spend=self.spend
  self.io=NativeIO(self.cap)
  base_env=self.io.env
  self.io.env=lambda:{**base_env(),'CLOUDSDK_PYTHON':'/opt/homebrew/Cellar/python@3.14/3.14.2/Frameworks/Python.framework/Versions/3.14/bin/python3.14'}
  self.runtime=self.lifecycle(self.cap.modules['restore']);self.version=None;self.deployment=None;self.key='';self.endpoint='';self.project_number=''
 def iso(self,value):return datetime.datetime.fromtimestamp(value,datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')
 def gate(self,cleanup=False):
  n=self.clock();c.need(n>=self.last,'CLOCK_ROLLBACK');self.last=n
  c.need(self.p['window']['start']<=n<self.p['window']['cleanupEnd' if cleanup or self.cleanup else 'workEnd'],'DEADLINE')
  return self.p['window']['cleanupEnd' if cleanup or self.cleanup else 'workEnd']
 def spend(self,kind,cleanup=False):
  deadline=self.gate(cleanup);c.need(self.calls[kind]<(self.limits[kind] if cleanup or self.cleanup else max(1,self.limits[kind]//2)),'CALL_LIMIT');self.calls[kind]+=1;return deadline
 def cloud(self,args,deadline):
  restore=self.cap.modules['restore'];p={**self.cap.plan,'iam':[]}
  mutations=[restore.command(p,k,n,enabled) for k,n in restore.operations(p) if k!='role' for enabled in (True,False)]
  c.need(self.expected is not None or args not in mutations,'QUALIFICATION_MUTATION_REFUSED')
  binding_write=args in mutations and args[:2] in (['secrets','add-iam-policy-binding'],['secrets','remove-iam-policy-binding'])
  # These SDK commands return policy objects; their default display is not JSON.
  # Authorize the exact lifecycle vector first, then select its serialization.
  raw=self.io.cli([*args,'--format=json'] if binding_write else args)
  if args[:2]==['auth','list']:return raw
  if raw=='' and args in mutations and not binding_write:return {}
  if binding_write:
   try:
    value=q.strict_json(raw)
    c.need(isinstance(value,dict),'BINDING_OUTPUT_INVALID')
    return value
   except Exception:raise c.Stop('BINDING_OUTPUT_INVALID') from None
  return q.strict_json(raw)
 def lifecycle(self,restore):
  class Lifecycle(restore.NativeAdapter):
   role=entry.RuntimeAdapter.role
   def readback(s,kind,name,enabled,p,deadline):
    if kind=='role':return entry.RuntimeAdapter.readback(s,kind,name,enabled,p,deadline)
    return super().readback(kind,name,enabled,p,deadline)
  r=Lifecycle(None,'',runner=self.cloud,sql=self.io.sql,clock=self.clock);r.cap=self.cap;r.acl=load_acl();return r
 def http(self,method,url,body=None):
  self.io.ensure_owner();deadline=self.spend('https',self.cleanup)
  request=urllib.request.Request(url,method=method,data=None if body is None else json.dumps(body).encode(),
   headers={'Authorization':'Bearer '+self.io.token,'Content-Type':'application/json','x-goog-user-project':'signmons'})
  try:
   with urllib.request.build_opener(NoRedirect).open(request,timeout=max(.01,min(8,deadline-self.clock()))) as r:raw=r.read(65537);status=r.status
  except urllib.error.HTTPError as error:raw=error.read(65537);status=error.code
  except (OSError,TimeoutError):raise c.Stop('PROVIDER_RESPONSE_UNCONFIRMED') from None
  self.gate(self.cleanup);c.need(len(raw)<=65536 and status==200,'PROVIDER_RESPONSE_REFUSED')
  return q.strict_json(raw)
 def permissions(self,url,permissions):
  value=self.http('POST',url+':testIamPermissions',{'permissions':permissions})
  c.need(isinstance(value,dict) and set(value)=={'permissions'} and isinstance(value['permissions'],list) and len(value['permissions'])==len(set(value['permissions'])) and set(value['permissions'])==set(permissions),'EFFECTIVE_PERMISSION_MISSING')
 def preflight(self,plan,deadline):
  c.need(binding.current()['state']=='LEGACY','CORRECTION_ALREADY_ADOPTED')
  self.stage='OWNER';self.io.ensure_owner();r=self.runtime
  self.stage='PROJECT';number=self.io.cli(['projects','describe','signmons','--format=value(projectNumber)'])
  c.need(q.model.digest(number)==plan['projectNumberSha256'],'PROJECT_PIN')
  self.project_number=number
  self.stage='BILLING';billing=r.cloud(['billing','projects','describe','signmons','--format=json(billingAccountName,billingEnabled,projectId)'],deadline)
  c.need(billing.get('projectId')=='signmons' and billing.get('billingEnabled') is True and isinstance(billing.get('billingAccountName'),str) and __import__('hashlib').sha256(billing['billingAccountName'].encode()).hexdigest()==q.BILLING_ACCOUNT_SHA256,'BILLING_NOT_READY')
  account=r.cloud(['billing','accounts','describe',billing['billingAccountName'].split('/')[-1],'--format=json(open)'],deadline)
  c.need(account=={'open':True},'BILLING_NOT_READY')
  self.stage='IAM';project_policy=r.cloud(['projects','get-iam-policy','signmons','--format=json(bindings,etag,version)'],deadline)
  member='serviceAccount:'+entry.restore.IDENTITY
  c.need(not any(member in row['members'] for row in q.CurrentAdapter._policy_bindings(None,project_policy)),'RUNTIME_PROJECT_GRANT_PRESENT')
  identity_policy=r.cloud(['iam','service-accounts','get-iam-policy',entry.restore.IDENTITY,'--project=signmons','--format=json(bindings,etag,version)'],deadline)
  c.need(not any(row['role']=='roles/iam.serviceAccountTokenCreator' and 'user:debynyhan@signmons.com' in row['members'] for row in q.CurrentAdapter._policy_bindings(None,identity_policy)),'RUNTIME_SIGNING_GRANT_PRESENT')
  self.stage='SERVICES'
  for service in ('run.googleapis.com' ,'secretmanager.googleapis.com','iam.googleapis.com'):
   value=self.http('GET','https://serviceusage.googleapis.com/v1/projects/'+number+'/services/'+service+'?fields=name,state')
   c.need(value=={'name':'projects/'+number+'/services/'+service,'state':'ENABLED'},'SERVICE_NOT_READY')
  self.stage='PERMISSIONS'
  self.permissions('https://run.googleapis.com/v2/projects/signmons/locations/us-east5/services/signmons-calldesk-staging',['run.services.get','run.services.update'])
  self.permissions('https://iam.googleapis.com/v1/projects/-/serviceAccounts/'+entry.restore.IDENTITY,['iam.serviceAccounts.get','iam.serviceAccounts.actAs','iam.serviceAccounts.enable','iam.serviceAccounts.disable'])
  for secret in entry.restore.POLICIES:
   permissions=['secretmanager.secrets.getIamPolicy','secretmanager.secrets.setIamPolicy','secretmanager.versions.get','secretmanager.versions.enable','secretmanager.versions.disable']
   if secret==binding.STRIPE and 'reuse' not in plan:permissions+=['secretmanager.versions.add']
   self.permissions('https://secretmanager.googleapis.com/v1/projects/signmons/secrets/'+secret,permissions)
  self.stage='CANDIDATE';revision=r.cloud(['run','revisions','describe',binding.LEGACY,'--project=signmons','--region=us-east5','--format=json'],deadline)
  spec=revision.get('spec',{});containers=spec.get('containers');c.need(isinstance(containers,list) and len(containers)==1 and spec.get('serviceAccountName')==entry.restore.IDENTITY and containers[0].get('image')==entry.restore.IMAGE,'EXISTING_CANDIDATE_SOURCE')
  env=containers[0].get('env');envhash=q.environment_digest(env)
  return_url=next(x['value'] for x in env if x['name']=='CUSTOMER_PAYMENT_RETURN_URL')
  self.stage='DATABASE_ROLE';role=r.role(deadline);r.q={'roleAclSha256':c.digest(role['acl'])}
  p={**self.cap.plan,'iam':[]}
  self.stage='RETIRED_RESOURCES'
  for kind,name in entry.restore.operations(p):c.need(r.readback(kind,name,False,p,deadline),'RESOURCE_NOT_RETIRED')
  # Exact list lookup proves the unique revision is absent before deployment intent.
  self.stage='CANDIDATE_ABSENCE';rows=r.cloud(['run','revisions','list','--service=signmons-calldesk-staging','--project=signmons','--region=us-east5','--format=json(metadata.name)'],deadline)
  c.need(isinstance(rows,list) and all(isinstance(x,dict) and isinstance(x.get('metadata',{}).get('name'),str) for x in rows),'REVISION_INVENTORY_UNKNOWN')
  c.need(not any(x['metadata']['name']==c.candidate(plan['operationId']) for x in rows),'CANDIDATE_ALREADY_EXISTS')
  self.observed={'runtimeEnvironmentSha256':envhash,'roleAclSha256':r.q['roleAclSha256'],'returnUrl':return_url}
  if self.expected is not None:c.need(self.observed==self.expected,'QUALIFICATION_DRIFT')
  self.gate();return self.observed
 def check_key(self,key,endpoint,deadline):
  self.stage='SANDBOX_KEY';self.endpoint_diagnostic=None
  value={'key':key,'endpointId':endpoint,'deadline':int(min(deadline,self.clock()+55)*1000)}
  # Child timeout must cover all three sequential bounded requests.
  import subprocess,signal,os
  self.spend('child');p=subprocess.Popen([NODE,str(c.HERE/'key_check.mjs')],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,env=self.io.env(),start_new_session=True)
  try:
   out,_=p.communicate(json.dumps(value).encode(),timeout=max(.01,min(55,deadline-self.clock())))
   c.need(len(out)<=4096,'KEY_CHECK_RESULT');v=json.loads(out)
   if p.returncode!=0:
    safe={'KEY_CHECK_DEADLINE','KEY_ENDPOINT_PIN','KEY_CHECK_HTTP','KEY_ACCOUNT_LIST','KEY_ACCOUNT_MISMATCH','KEY_MODE_MISMATCH','PAYMENT_TEST_KEY_REQUIRED','PAYMENT_ENDPOINT_DRIFT','PAYMENT_OUTPUT_LIMIT','PAYMENT_IO_TIMEOUT','PAYMENT_DEADLINE','KEY_TRANSPORT_OR_OUTPUT_UNKNOWN'}
    c.need(isinstance(v,dict) and v.get('status')=='SANDBOX_KEY_REFUSED' and v.get('code') in safe,'KEY_CHECK_RESULT')
    if v['code']=='KEY_ENDPOINT_PIN':
     c.need(set(v)=={'status','code','endpointInput'} and c.valid_endpoint_diagnostic(v['endpointInput']),'KEY_CHECK_RESULT')
     self.endpoint_diagnostic=v['endpointInput']
    else:c.need(set(v)=={'status','code'},'KEY_CHECK_RESULT')
    raise c.Stop(v['code'])
   c.need(v=={'status':'SANDBOX_KEY_VALIDATED','requests':3,'accountMatched':True,'testMode':True,'endpointDisabled':True},'KEY_CHECK_RESULT')
  finally:
   value.clear()
   if p.poll() is None:
    os.killpg(p.pid,signal.SIGKILL);p.communicate()
  self.gate(self.cleanup);self.key=key;self.endpoint=endpoint;return v
 def reuse_version_check(self,deadline):
  c.need(self.p.get('reuse')==c.REUSE,'REUSE_PROVENANCE')
  name='projects/'+self.project_number+'/secrets/'+binding.STRIPE+'/versions/2'
  value=self.http('GET','https://secretmanager.googleapis.com/v1/'+name+'?fields=name,state')
  c.need(value=={'name':name,'state':'DISABLED'},'REUSE_VERSION_NOT_DISABLED')
 def add_version(self,key,deadline):
  c.need('reuse' not in self.p,'REUSE_CREATE_FORBIDDEN')
  c.need(self.expected is not None,'QUALIFICATION_MUTATION_REFUSED')
  # urllib issues one request and does not retry a non-idempotent addVersion.
  return self.http('POST','https://secretmanager.googleapis.com/v1/projects/'+self.project_number+'/secrets/'+binding.STRIPE+':addVersion',{'payload':{'data':base64.b64encode(key.encode()).decode()}})
 def configure(self,version,revision):
  cfg={'state':'CORRECTED','candidate':revision,'stripeVersion':version,'correctionOperationId':self.p['operationId'],'correctionReceiptSha256':'0'*64}
  restore=binding.apply_restore(c.load('p08-restoration-local-20261028/source/restore.py','crk1_bound_restore'),cfg)
  self.version=version;self.cap.modules['restore']=restore;self.runtime=self.lifecycle(restore)
  qualification=self.expected if self.expected is not None else self.observed
  self.runtime.q={'roleAclSha256':qualification['roleAclSha256']}
  self.deployment=c.Deployment(version,revision,qualification['returnUrl'],self.deployment_cloud,self.health)
 def activation(self):
  return [('identity',entry.restore.IDENTITY)]+[('version',s) for s in entry.restore.SECRETS]+[('secretBinding',s) for s in entry.restore.POLICIES]+[('role',entry.restore.ROLE)]
 def version_readback(self,version,deadline):
  value=self.http('GET','https://secretmanager.googleapis.com/v1/projects/'+self.project_number+'/secrets/'+binding.STRIPE+'/versions/'+version+'?fields=name,state')
  c.need(c.returned_version(value,self.project_number)==version,'VERSION_READBACK')
 def change(self,kind,name,enabled,deadline):
  c.need(self.expected is not None,'QUALIFICATION_MUTATION_REFUSED')
  if not enabled:self.cleanup=True;self.io.cleanup=True
  if kind=='tag' and not enabled:c.need(self.runtime.traffic({**self.cap.plan,'iam':[]},deadline,True),'FOREIGN_TAG_REFUSED')
  return self.runtime.change(kind,name,enabled,{**self.cap.plan,'iam':[]},deadline)
 def readback(self,kind,name,enabled,deadline):
  if not enabled:self.cleanup=True;self.io.cleanup=True
  # Retired readbacks occur during initial qualification too; caller resets mode afterwards.
  return self.runtime.readback(kind,name,enabled,{**self.cap.plan,'iam':[]},deadline)
 def deployment_cloud(self,args,options):
  if args[:2]!=['run','deploy']:return self.runtime.cloud(args,self.gate())
  # Same pinned command renderer, bounded SDK process, one candidate name/no retry by this driver.
  import subprocess,os,signal
  deadline=self.spend('cli');p=subprocess.Popen(['/opt/homebrew/bin/gcloud',*args],stdout=subprocess.PIPE,stderr=subprocess.PIPE,stdin=subprocess.DEVNULL,env=self.io.env(),start_new_session=True)
  try:
   out,_=p.communicate(timeout=max(.01,min(300,deadline-self.clock())))
   c.need(p.returncode==0 and len(out)<=65536,'DEPLOYMENT_UNCONFIRMED')
  finally:
   if p.poll() is None:os.killpg(p.pid,signal.SIGKILL);p.communicate()
  self.gate();return ''
 def health(self,args,options):return self.io._run(args,'https')
 def deploy(self,deadline):
  c.need(self.expected is not None,'QUALIFICATION_MUTATION_REFUSED');self.deployment.deploy()
 def deployment_readback(self,deadline):return self.deployment.readback()
 def final_readback(self,deadline):
  retired=self.runtime.retired({**self.cap.plan,'iam':[]},deadline)
  self.check_key(self.key,self.endpoint,deadline)
  return retired
 def clear_key(self):self.key='';self.endpoint=''
 def clear(self):self.clear_key();self.io.clear();self.project_number=''
