"""Exact committed CR-K1 qualification/correction launcher. Unbound by default."""
import json,os,re,signal,subprocess,sys,time
from pathlib import Path
import correction as c
GOV=Path('/Users/debynyhanbanks/Web Projects/signmons-governance-r08-recovery')
DECISION='APP013_P08_KEY_CORRECTION_DECISION_20261110.json'
LIMITS={'cli':180,'https':40,'sql':40,'child':2}
QUALIFICATION_LIMITS={'cli':54,'https':24,'sql':4,'child':2}

def committed(repo,sha,path):
 c.need(re.fullmatch('[a-f0-9]{40}',sha or '') and re.fullmatch('[A-Za-z0-9_./-]+',path or '') and '..' not in path.split('/'),'SOURCE_REFERENCE')
 return subprocess.check_output(['/usr/bin/git','show',sha+':'+path],cwd=repo,stderr=subprocess.DEVNULL,timeout=5)

def verify(spec,decision,now,read_commit=committed):
 c.need(set(spec)=={'mode','sourceCommit','sourceManifestSha256','plan','qualification','limits','costAllowanceUsd','decisionCommit'},'SPEC_SHAPE')
 c.validate_plan(spec['plan'])
 c.need(spec['mode'] in ('qualify','run','closeout') and spec['limits']==(QUALIFICATION_LIMITS if spec['mode']=='qualify' else LIMITS),'MODE_OR_LIMITS')
 c.need(type(spec['costAllowanceUsd']) in (float,int) and spec['costAllowanceUsd']>=0,'ALLOWANCE')
 c.need(spec['mode']!='qualify' or spec['costAllowanceUsd']==0,'QUALIFICATION_ALLOWANCE')
 manifest=(c.HERE/'source-manifest.json').read_bytes();c.need(c.digest(manifest)==spec['sourceManifestSha256']==spec['plan']['sourceManifestSha256'],'MANIFEST_BINDING')
 m=json.loads(manifest);c.need(m['status']=='LOCAL_IMPLEMENTATION_NO_EXTERNAL_AUTHORITY','MANIFEST_STATUS')
 rel='evidence/APP-013/p08-key-correction-20261110/source-manifest.json'
 c.need(read_commit(c.BACKEND,spec['sourceCommit'],rel)==manifest,'COMMITTED_MANIFEST')
 for path,h in m['files'].items():
  f=c.BACKEND/path;c.need(f.is_file() and not f.is_symlink() and c.digest(f.read_bytes())==h and read_commit(c.BACKEND,spec['sourceCommit'],path)==f.read_bytes(),'SOURCE_DRIFT')
 # The complete active native/qualification chain also checks historical source locks and SDK hashes.
 sys.path.insert(0,str(c.APP/'p08-https-output-category-local-20261029/source'))
 import qualification_launch as q
 q.model.verify_local_manifest();q.current_module('authority').verify_sources()
 for path,h in json.loads((q.model.ROOT/'source-manifest.json').read_text())['sdkReview']['files'].items():c.need(c.digest(Path(path).read_bytes())==h,'SDK_DRIFT')
 c.need(spec['plan']['projectNumberSha256']==q.PROJECT_NUMBER_SHA256,'PROJECT_PIN')
 approval={'owner':'Debynyhan Banks','decision':'APPROVE_EXACT_CR_K1_'+spec['mode'].upper(),
  'scopeSha256':c.digest({k:v for k,v in spec.items() if k!='decisionCommit'}),'externalReadAuthorized':True,
  'externalMutationAuthorized':spec['mode']!='qualify','costHoldReleased':spec['mode']!='qualify'}
 c.need(decision==approval,'EXACT_OWNER_APPROVAL')
 w=spec['plan']['window'];c.need(w['start']<=now<w['cleanupEnd' if spec['mode']=='closeout' else 'cutoff'],'OUTSIDE_WINDOW')
 if spec['mode']=='qualify':c.need(spec['qualification'] is None and spec['plan']['qualificationSha256']=='0'*64,'QUALIFICATION_ONLY')
 else:
  v=spec['qualification'];c.need(isinstance(v,dict) and set(v)=={'runtimeEnvironmentSha256','roleAclSha256','returnUrl'} and c.digest(v)==spec['plan']['qualificationSha256'],'QUALIFICATION_BINDING')
 return spec

def execute(spec,ports_factory=None,clock=time.time,base=Path('/private/tmp')):
 # execute is reached only after verify in main; injected transports used only in local tests.
 if ports_factory is None:
  from ports import NativePorts
  ports_factory=NativePorts
 root=base/('p08-key-correction-'+spec['plan']['operationId'])
 if spec['mode']!='closeout':root.mkdir(mode=0o700)
 c.private_root(root)
 ports=ports_factory(spec['plan'],spec['qualification'],spec['limits'],clock)
 key='';endpoint=''
 previous={s:signal.getsignal(s) for s in (signal.SIGTERM,signal.SIGINT)}
 def interrupted(*_):raise KeyboardInterrupt()
 try:
  for s in previous:signal.signal(s,interrupted)
  if spec['mode']=='closeout':
   ports.cleanup=True;ports.io.cleanup=True
   with ports.io.legacy.phase_guard(spec['plan']['window']['cleanupEnd'],cleanup=True):
    ports.key=ports.io.legacy.private_input('Correct Sandbox secret API key for cleanup readback (hidden): ')
    ports.endpoint=ports.io.legacy.private_input('Existing Sandbox webhook endpoint ID (hidden): ')
   result=c.Correction(spec['plan'],ports,root,clock).closeout()
  else:
   if spec['mode']=='qualify':c.reserve(root/'attempt.json',{'operationId':spec['plan']['operationId'],'mode':'qualify','scopeSha256':c.digest(spec)})
   # No timed input starts until owner/source gates and a unique root are established.
   with ports.io.legacy.phase_guard(spec['plan']['window']['cutoff']):
    key=ports.io.legacy.private_input('Correct Sandbox secret API key (hidden): ')
    endpoint=ports.io.legacy.private_input('Existing Sandbox webhook endpoint ID (hidden): ')
   if spec['mode']=='qualify':
    ports.check_key(key,endpoint,ports.gate())
    value=ports.preflight(spec['plan'],ports.gate())
    result={'status':'CR_K1_QUALIFIED_FOR_EXACT_MUTATION_REVIEW','qualification':value,'qualificationSha256':c.digest(value),'providerMutations':0,'operationId':spec['plan']['operationId'],'calls':ports.calls,'privateInputsPersisted':False}
   else:
    result=c.Correction(spec['plan'],ports,root,clock).run(key,endpoint)
    if result['status']=='CORRECTION_CLOSED':result['status']='CORRECTION_AWAITING_INDEPENDENT_CLOSEOUT'
  c.reserve(root/(spec['mode']+'-result.json'),result)
  print(json.dumps(result),flush=True);return result
 except BaseException as error:
  # Immutable failure evidence; never expose arbitrary exception/provider text.
  path=root/(spec['mode']+'-failure.json')
  if not path.exists():c.reserve(path,{'status':'CR_K1_STOPPED','operationId':spec['plan']['operationId'],'stage':getattr(ports,'stage','LOCAL'),'code':str(error) if isinstance(error,c.Stop) else 'LOCAL_OR_PROVIDER_OUTPUT_UNKNOWN','privateInputsPersisted':False})
  raise
 finally:
  key='';endpoint='';ports.clear()
  for s,handler in previous.items():signal.signal(s,handler)

def inspect_endpoint_local():
 # No external capability, credential discovery, fetch, SQL, or provider port exists in this path.
 manifest=json.loads((c.HERE/'source-manifest.json').read_text())
 for path,h in manifest['files'].items():
  file=c.BACKEND/path;c.need(not file.is_symlink() and c.digest(file.read_bytes())==h,'LOCAL_SOURCE_DRIFT')
 legacy=c.load('p08-restoration-local-20261028/source/legacy/controller.py','local_endpoint_getpass')
 deadline=time.time()+120;value=''
 try:
  with legacy.phase_guard(deadline):value=legacy.private_input('Paste only the endpoint ID beginning we_ (hidden; no key or SQL password): ')
  result=subprocess.run(['/Users/debynyhanbanks/.nvm/versions/node/v24.12.0/bin/node',str(c.HERE/'key_check.mjs'),'--inspect-endpoint-local'],
   input=json.dumps({'endpointId':value}).encode(),capture_output=True,timeout=min(5,max(.01,deadline-time.time())),
   env={'PATH':'/usr/bin:/bin','LANG':'C'})
  c.need(result.returncode==0 and len(result.stdout)<=2048,'LOCAL_INPUT_CHECK_FAILED')
  answer=json.loads(result.stdout)
  c.need(set(answer)=={'status','isString','inputLength','formatValid','exactMatch','trimmedMatch','surroundingWhitespace','looksLikeUrl','controlOrNonAscii','providerCalls'} and
   answer['status']=='LOCAL_ENDPOINT_INPUT_INSPECTED' and answer['providerCalls']==0,'LOCAL_INPUT_CHECK_RESULT')
  print(json.dumps(answer),flush=True);return answer
 finally:value=''

def main():
 if sys.argv[1:]==['--inspect-endpoint-local']:return inspect_endpoint_local()
 c.need(len(sys.argv)==2,'SPEC_REQUIRED');spec=c.read(Path(sys.argv[1]))
 decision=json.loads(committed(GOV,spec['decisionCommit'],DECISION));verify(spec,decision,time.time())
 execute(spec)
if __name__=='__main__':
 try:main()
 except BaseException:print('CR_K1_NOT_STARTED_OR_UNCONFIRMED',flush=True);sys.exit(2)
