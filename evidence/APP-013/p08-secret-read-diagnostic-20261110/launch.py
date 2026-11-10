"""One exact-approved secret read. No SQL, Stripe request or provider mutation."""
import hashlib,json,os,re,signal,subprocess,sys,time,uuid
from pathlib import Path
HERE=Path(__file__).resolve().parent
BACKEND=HERE.parents[2]
GOV=Path('/Users/debynyhanbanks/Web Projects/signmons-governance-r08-recovery')
NODE='/Users/debynyhanbanks/.nvm/versions/node/v24.12.0/bin/node'
PYTHON='/opt/homebrew/Cellar/python@3.14/3.14.2/Frameworks/Python.framework/Versions/3.14/bin/python3.14'
DECISION='APP013_P08_SECRET_READ_DIAGNOSTIC_DECISION_20261110.json'
CODES={'TEST_KEY_VALID','PAYMENT_SECRET_REFUSED','PAYMENT_SECRET_SHAPE','PAYMENT_TEST_KEY_REQUIRED','PAYMENT_OUTPUT_LIMIT','PAYMENT_IO_TIMEOUT','PAYMENT_DEADLINE','SECRET_JSON_INVALID','SECRET_TIMEOUT','SECRET_TRANSPORT_OR_ENCODING','SECRET_UNCLASSIFIED'}
def digest(value):return hashlib.sha256(json.dumps(value,sort_keys=True,separators=(',',':')).encode()).hexdigest()
def need(value,code):
 if not value:raise RuntimeError(code)
def command(argv,deadline,input_bytes=None):
 env={'PATH':'/usr/bin:/bin:/opt/homebrew/bin','HOME':'/Users/debynyhanbanks','LANG':'C','CLOUDSDK_PYTHON':PYTHON,'CLOUDSDK_CORE_DISABLE_PROMPTS':'true','CLOUDSDK_CORE_DISABLE_FILE_LOGGING':'true','CLOUDSDK_CORE_LOG_HTTP':'false'}
 p=subprocess.Popen(argv,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,env=env,start_new_session=True)
 try:
  out,err=p.communicate(input_bytes,timeout=max(.01,min(8,deadline-time.time())))
  need(p.returncode==0 and len(out)<=8192,'COMMAND_UNCONFIRMED');return out
 finally:
  if p.poll() is None:
   os.killpg(p.pid,signal.SIGTERM)
   try:p.communicate(timeout=1)
   except subprocess.TimeoutExpired:os.killpg(p.pid,signal.SIGKILL);p.communicate(timeout=1)

def validate(spec,decision,now):
 need(set(spec)=={'operationId','sourceCommit','files','window','projectNumberSha256','sdkFiles'},'SPEC_SHAPE')
 need(str(uuid.UUID(spec['operationId']))==spec['operationId'],'OPERATION_ID')
 need(re.fullmatch('[0-9a-f]{40}',spec['sourceCommit']),'SOURCE_COMMIT')
 need(spec['projectNumberSha256']=='37d4aa0f46ca5b8f0b81b1148bda235a0f4a9a424b6b4638ec993d889563be54','PROJECT_PIN')
 w=spec['window'];need(set(w)=={'start','cutoff','end'} and w['start']<w['cutoff']<w['end'] and w['end']-w['start']<=1800,'WINDOW')
 need(w['start']<=now<w['cutoff'],'OUTSIDE_WINDOW')
 need(decision=={'owner':'Debynyhan Banks','decision':'APPROVE_EXACT_SECRET_READ_DIAGNOSTIC','externalReadAuthorized':True,'scopeSha256':digest(spec)},'EXACT_APPROVAL')

def execute(spec,decision,invoke=command,clock=time.time,root_base=Path('/private/tmp')):
 validate(spec,decision,clock());root=root_base/('p08-secret-read-'+spec['operationId']);root.mkdir(mode=0o700)
 (root/'attempt.json').write_text(json.dumps({'operationId':spec['operationId'],'scopeSha256':digest(spec)}))
 deadline=min(spec['window']['end'],clock()+60);last=clock();token=b'';number='';calls=0
 result={'operationId':spec['operationId'],'status':'DIAGNOSTIC_UNCONFIRMED','code':'LOCAL_PREREQUISITE','httpStatus':None,'providerReason':None,'stage':'OWNER_CHECK','sdkCommands':0,'requests':0,'rawFilesAbsent':True}
 def run(vector,data=None):
  nonlocal last,calls
  n=clock();need(n>=last and n<deadline,'DEADLINE');last=n
  if vector[0]=='/opt/homebrew/bin/gcloud':calls+=1;need(calls<=6,'SDK_BUDGET')
  return invoke(vector,deadline,data)
 try:
  gc='/opt/homebrew/bin/gcloud'
  need(run([gc,'auth','list','--filter=status:ACTIVE','--format=value(account)']).decode().strip()=='debynyhan@signmons.com','OWNER_MISMATCH')
  result['stage']='OVERRIDE_CHECK'
  for key in ('auth/impersonate_service_account','auth/credential_file_override','auth/access_token_file'):
   need(run([gc,'config','get-value',key]).decode().strip() in ('','(unset)'),'OWNER_OVERRIDE')
  result['stage']='PROJECT_LOOKUP'
  number=run([gc,'projects','describe','signmons','--format=value(projectNumber)']).decode().strip()
  need(re.fullmatch('[0-9]{6,20}',number) and digest(number)==spec['projectNumberSha256'],'PROJECT_PIN')
  result['stage']='TOKEN_ACQUISITION'
  token=run([gc,'auth','print-access-token','--account=debynyhan@signmons.com']).strip()
  need(20<=len(token)<=4096 and not any(chr(v).isspace() for v in token),'TOKEN_SHAPE')
  result['stage']='SECRET_READ'
  raw=run([NODE,str(HERE/'read.mjs')],json.dumps({'token':token.decode(),'projectNumber':number,'deadline':int(deadline*1000)}).encode())
  v=json.loads(raw);need(set(v)=={'code','httpStatus','providerReason','requests'} and v['code'] in CODES and type(v['requests']) is int and 0<=v['requests']<=1 and (v['httpStatus'] is None or type(v['httpStatus']) is int and 100<=v['httpStatus']<=599),'RESULT_SHAPE')
  need(v['providerReason'] in {None,'UNCLASSIFIED','SERVICE_DISABLED','BILLING_DISABLED','ACCESS_TOKEN_SCOPE_INSUFFICIENT','ACCESS_TOKEN_EXPIRED','IAM_PERMISSION_DENIED','USER_PROJECT_DENIED','CONSUMER_INVALID','SECURITY_POLICY_VIOLATED','RATE_LIMIT_EXCEEDED'},'RESULT_REASON')
  need(clock()<deadline,'DEADLINE');result.update(status='DIAGNOSTIC_OBSERVED',**v)
 except BaseException as error:
  safe={'OWNER_MISMATCH','OWNER_OVERRIDE','PROJECT_PIN','TOKEN_SHAPE','COMMAND_UNCONFIRMED','SDK_BUDGET','DEADLINE','RESULT_SHAPE','RESULT_REASON'}
  result['code']=str(error) if isinstance(error,RuntimeError) and str(error) in safe else 'LOCAL_PREREQUISITE'
 finally:
  token=b'';number='';result['sdkCommands']=calls
  result['rawFilesAbsent']={p.name for p in root.iterdir()}=={'attempt.json'}
  if not result['rawFilesAbsent']:result['status']='DIAGNOSTIC_CONTAINMENT_UNCONFIRMED'
  (root/'result.json').write_text(json.dumps(result,sort_keys=True)+'\n')
 return result

def main():
 spec=json.loads(Path(sys.argv[1]).read_text());head=subprocess.check_output(['git','rev-parse','HEAD'],cwd=GOV,text=True).strip()
 decision=json.loads(subprocess.check_output(['git','show',head+':'+DECISION],cwd=GOV))
 validate(spec,decision,time.time())
 expected={'evidence/APP-013/p08-secret-read-diagnostic-20261110/'+n for n in ('launch.py','read.mjs')}
 expected|={'evidence/APP-013/p08-https-output-category-local-20261029/source/'+n for n in ('qualification_launch.py','source-manifest.json')}
 expected|={'evidence/APP-013/p08-native-entry-local-20261101/source/'+n for n in ('connected_payment.mjs','authority_bridge.mjs')}
 need(set(spec['files'])==expected,'SOURCE_INVENTORY')
 for p,h in spec['files'].items():
  raw=(BACKEND/p).read_bytes();need(hashlib.sha256(raw).hexdigest()==h and subprocess.check_output(['git','show',spec['sourceCommit']+':'+p],cwd=BACKEND)==raw,'SOURCE_DRIFT')
 sys.path.insert(0,str(BACKEND/'evidence/APP-013/p08-https-output-category-local-20261029/source'))
 import qualification_launch as q
 manifest=q.model.verify_local_manifest();need(spec['sdkFiles']==manifest['sdkReview']['files'],'SDK_INVENTORY')
 for p,h in spec['sdkFiles'].items():need(hashlib.sha256(Path(p).read_bytes()).hexdigest()==h,'SDK_DRIFT')
 q.current_module('authority').load('p08-restoration-local-20261028/source/restore.py','secret_diagnostic_restore').local_environment_gate()
 print(json.dumps(execute(spec,decision)),flush=True)
if __name__=='__main__':
 try:main()
 except BaseException:print('SECRET_DIAGNOSTIC_NOT_STARTED_OR_UNCONFIRMED');sys.exit(2)
