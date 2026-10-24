#!/opt/homebrew/bin/python3
"""One-use exact-resource late retirement; no provisioning/payment adapter."""
from __future__ import annotations
import copy,datetime as dt,hashlib,importlib.util,json,os,re,stat,subprocess,sys,time
from pathlib import Path
ROOT=Path(__file__).resolve().parent
GOV=Path('/Users/debynyhanbanks/Web Projects/signmons-governance-r08-recovery')
BACKEND=Path('/Users/debynyhanbanks/Web Projects/signmons-backend-r08-recovery')
SPEC=importlib.util.spec_from_file_location('p07_cleanup_legacy',ROOT/'legacy/controller.py')
c=importlib.util.module_from_spec(SPEC);SPEC.loader.exec_module(c)
PLAN=json.loads((ROOT/'cleanup-plan.json').read_text())
OLD_MANIFEST='006a0c5e4d204cdc8d0b0042c9336724c4b553251dacfd3b42ad17d506b6300c'
OLD_JOURNAL='46283a76afad78f82b12988ba9d80e631c6734fa42d86c34b614dc6ac1611638'
PROPOSAL='APP013_P07_OVERDUE_RETIREMENT_RECOVERY_PROPOSAL_20261023.md'
LOCAL_PROPOSAL_SHA='19dd94593420fc9ff42785bb34c11b05507bf379722d0ea9892f15218327833e'
LOCAL_DECISION='8a6377a122088bfd98ee07f3053aa12940c91f52'
class Stop(Exception):
    def __init__(self,code):self.code=code;super().__init__(code)
def utc():return dt.datetime.now(dt.timezone.utc).isoformat().replace('+00:00','Z')
def digest(value):return hashlib.sha256(json.dumps(value,sort_keys=True,separators=(',',':')).encode()).hexdigest()
def sha(path):return hashlib.sha256(Path(path).read_bytes()).hexdigest()
def parse(value):
    if not isinstance(value,str) or not re.fullmatch(r'\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z',value):raise Stop('TIMESTAMP_INVALID')
    try:return dt.datetime.fromisoformat(value[:-1]+'+00:00').timestamp()
    except ValueError:raise Stop('TIMESTAMP_INVALID')
def read(name):
    path=ROOT/name
    try:
        st=path.lstat()
        if not stat.S_ISREG(st.st_mode) or stat.S_IMODE(st.st_mode)!=0o600:raise Stop('PRIVATE_FILE_INVALID')
        fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW)
        with os.fdopen(fd) as f:return json.load(f)
    except (OSError,ValueError):raise Stop('PRIVATE_FILE_INVALID')
def save(name,value):
    try:
        fd=os.open(ROOT/name,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
        with os.fdopen(fd,'w') as f:json.dump(value,f,indent=2,sort_keys=True);f.write('\n');f.flush();os.fsync(f.fileno())
    except FileExistsError:raise Stop('ALREADY_RESERVED_OR_RECEIPT_EXISTS')
def git(args,repo):
    try:r=subprocess.run(['/usr/bin/git',*args],cwd=repo,stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=15,check=False)
    except (OSError,subprocess.TimeoutExpired):raise Stop('LOCAL_GOVERNANCE_UNAVAILABLE')
    if r.returncode:raise Stop('LOCAL_GOVERNANCE_UNAVAILABLE')
    return r.stdout

def validate_resources(journal):
    keys={'role_attempted','role_created','role_open','secret_resources','secret_versions','service_account_attempted','service_account_created','bindings','stripe_destination','deploy_attempted','deployed'}
    if not isinstance(journal,dict) or set(journal)!={'planId','operationId','mutation'} or journal['planId']!=c.PLAN or journal['operationId']!=c.OPERATION:raise Stop('JOURNAL_IDENTITY_INVALID')
    m=journal['mutation'];names=set(c.NEW_SECRETS.values())
    if not isinstance(m,dict) or set(m)!=keys:raise Stop('RESOURCE_BOUNDARY_INVALID')
    for name in keys-{'secret_resources','secret_versions','bindings'}:
        if m[name] is not True:raise Stop('RESOURCE_BOUNDARY_INVALID')
    if not isinstance(m['secret_versions'],dict) or set(m['secret_versions'])!=names or any(v!='1' for v in m['secret_versions'].values()):raise Stop('VERSION_BOUNDARY_INVALID')
    for field,expected in [('secret_resources',names),('bindings',names|{c.STRIPE_SECRET})]:
        value=m[field]
        if not isinstance(value,list) or len(value)!=len(expected) or not all(isinstance(x,str) for x in value) or set(value)!=expected:raise Stop('RESOURCE_BOUNDARY_INVALID')
    return copy.deepcopy(m)

def local_check():
    if stat.S_IMODE(ROOT.stat().st_mode)!=0o700:raise Stop('PRIVATE_DIRECTORY_INVALID')
    manifest=read('cleanup-manifest.json')
    if set(manifest)!={'files','operationId','status'} or manifest['operationId']!=PLAN['operationId'] or manifest['status']!='DISABLED_LOCAL_PREPARATION_ONLY':raise Stop('MANIFEST_INVALID')
    for name,expected in manifest['files'].items():
        if not isinstance(name,str) or Path(name).is_absolute() or '..' in Path(name).parts:raise Stop('MANIFEST_INVALID')
        p=ROOT/name
        if p.is_symlink() or not p.is_file() or stat.S_IMODE(p.stat().st_mode)!=0o600 or sha(p)!=expected:raise Stop('SOURCE_HASH_DRIFT')
    if PLAN.get('status')!='DISABLED_LOCAL_PREPARATION_ONLY' or PLAN.get('externalActionAuthorized') is not False or PLAN.get('automaticRetryAllowed') is not False or PLAN.get('mode')!='CLEANUP_ONLY':raise Stop('PLAN_NOT_DISABLED')
    if PLAN['originalManifestSha256']!=OLD_MANIFEST or sha(ROOT/'legacy-manifest.json')!=OLD_MANIFEST or PLAN['originalJournalSha256']!=OLD_JOURNAL or sha(ROOT/'source-journal.json')!=OLD_JOURNAL:raise Stop('ORIGINAL_SOURCE_DRIFT')
    if PLAN['originalOperationId']!=c.OPERATION or PLAN['originalRetirementDeadlineUtc']!='2026-10-23T22:15:00Z':raise Stop('ORIGINAL_DEADLINE_DRIFT')
    old=read('legacy-manifest.json')
    required={'cleanup.py','cleanup-plan.json','source-journal.json','source-result.json','legacy-manifest.json','db-closeout.mjs','test_cleanup.py','README.txt'}|{'legacy/'+name for name in old['files']}
    if set(manifest['files'])!=required or (ROOT/'legacy').is_symlink() or stat.S_IMODE((ROOT/'legacy').stat().st_mode)!=0o700:raise Stop('MANIFEST_INVENTORY_INVALID')
    if sha(ROOT/'db-closeout.mjs')!=old['files']['db-closeout.mjs']:raise Stop('CLOSEOUT_HELPER_DRIFT')
    for name,h in old['files'].items():
        if sha(ROOT/'legacy'/name)!=h:raise Stop('ORIGINAL_SOURCE_DRIFT')
    result=read('source-result.json')
    if result.get('operationId')!=c.OPERATION or result.get('status')!='P07_REPAIRED_RUNTIME_READY_DISABLED':raise Stop('ORIGINAL_RESULT_INVALID')
    resources=validate_resources(read('source-journal.json'))
    if PLAN.get('localDecisionCommit')!=LOCAL_DECISION or PLAN.get('localProposalSha256')!=LOCAL_PROPOSAL_SHA:raise Stop('LOCAL_DECISION_DRIFT')
    if hashlib.sha256(git(['show',PLAN['localProposalCommit']+':'+PROPOSAL],GOV)).hexdigest()!=LOCAL_PROPOSAL_SHA:raise Stop('LOCAL_DECISION_DRIFT')
    if LOCAL_DECISION.encode() not in git(['rev-list','HEAD'],GOV).splitlines():raise Stop('LOCAL_DECISION_DRIFT')
    for repo in (BACKEND,GOV):
        if git(['status','--porcelain'],repo):raise Stop('REPOSITORY_DIRTY')
    return resources

def authority(binding,approval,now=None):
    now=time.time() if now is None else now
    base={'mode':'CLEANUP_ONLY','planId':PLAN['planId'],'packetId':PLAN['packetId'],'operationId':PLAN['operationId'],'originalOperationId':c.OPERATION,'originalRetirementDeadlineUtc':PLAN['originalRetirementDeadlineUtc'],'automaticRetryAllowed':False,'actions':PLAN['actions']}
    if not isinstance(binding,dict) or set(binding)!=set(base)|{'startUtc','cutoffUtc','endUtc','manifestSha256','proposalCommit','proposalName','proposalSha256'}:raise Stop('WINDOW_NOT_BOUND')
    if any(binding[k]!=v for k,v in base.items()):raise Stop('BINDING_INVALID')
    if not all(re.fullmatch(r'[a-f0-9]{64}',str(binding[k])) for k in ('manifestSha256','proposalSha256')) or not re.fullmatch(r'[a-f0-9]{40}',str(binding['proposalCommit'])) or not re.fullmatch(r'APP013_P07_[A-Z0-9_]+_20261023\.md',str(binding['proposalName'])):raise Stop('PROPOSAL_NOT_PINNED')
    start,cutoff,end=[parse(binding[k]) for k in ('startUtc','cutoffUtc','endUtc')]
    if not start<cutoff<end or cutoff-start>900 or end-start>3600:raise Stop('WINDOW_INVALID')
    expected={'decision':'APPROVED','owner':'Debynyhan Banks','mode':'CLEANUP_ONLY','operationId':PLAN['operationId'],'bindingSha256':digest(binding),'manifestSha256':binding['manifestSha256'],'automaticRetryAllowed':False,'actions':PLAN['actions']}
    if not isinstance(approval,dict) or set(approval)!=set(expected)|{'approvedAtUtc'} or any(approval[k]!=v for k,v in expected.items()) or parse(approval['approvedAtUtc'])>min(now,cutoff):raise Stop('OWNER_APPROVAL_INVALID')
    if now<start:raise Stop('NOT_YET_START')
    if now>=cutoff:raise Stop('START_CUTOFF')
    return end

def live_check():
    resources=local_check();binding=read('cleanup-binding.json');approval=read('cleanup-owner-approval.json')
    deadline=authority(binding,approval)
    if binding['manifestSha256']!=sha(ROOT/'cleanup-manifest.json'):raise Stop('MANIFEST_BINDING_DRIFT')
    if hashlib.sha256(git(['show',binding['proposalCommit']+':'+binding['proposalName']],GOV)).hexdigest()!=binding['proposalSha256']:raise Stop('OPERATION_PROPOSAL_DRIFT')
    return binding,resources,deadline

# All commands allowed by the reused cleanup primitives; never a broad prefix allowlist.
def allowed_command(args):
    if not isinstance(args,list) or not all(isinstance(x,str) for x in args):return False
    if args==[c.NODE,str(ROOT/'db-closeout.mjs')]:return True
    prefix=[c.GCLOUD]
    tail=['--project='+c.PROJECT]
    describe=['run','services','describe',c.SERVICE,*tail,'--region='+c.REGION,'--format=json']
    remove=['run','services','update-traffic',c.SERVICE,*tail,'--region='+c.REGION,'--remove-tags='+c.TAG,'--quiet']
    identity=[['iam','service-accounts',action,c.SERVICE_ACCOUNT,*tail,*suffix] for action,suffix in [('disable',['--quiet']),('describe',['--format=json'])]]
    if args in [prefix+describe,prefix+remove,*[prefix+x for x in identity]]:return True
    for name in c.NEW_SECRETS.values():
        for action,suffix in [('describe',['--format=json']),('disable',['--quiet'])]:
            if args==prefix+['secrets','versions',action,'1','--secret='+name,*tail,*suffix]:return True
    for name in [*c.NEW_SECRETS.values(),c.STRIPE_SECRET]:
        if args==prefix+['secrets','get-iam-policy',name,*tail,'--format=json']:return True
        if args==prefix+['secrets','remove-iam-policy-binding',name,*tail,'--member='+c.SA_MEMBER,'--role=roles/secretmanager.secretAccessor','--condition=None','--quiet']:return True
    return False

def stripe_valid(receipt,attempt,binding,now=None):
    now=time.time() if now is None else now
    expected={'operationId':PLAN['operationId'],'mode':'SANDBOX_TEST','destinationName':'Signmons P07 same-job sandbox','destinationUrlSha256':hashlib.sha256((c.ORIGIN+'/webhooks/stripe').encode()).hexdigest(),'disabled':True,'deliveryAttempts':0}
    if not isinstance(receipt,dict) or set(receipt)!=set(expected)|{'observedAtUtc'} or any(receipt[k]!=v for k,v in expected.items()):raise Stop('STRIPE_READBACK_INVALID')
    if type(receipt['deliveryAttempts']) is not int or receipt['disabled'] is not True:raise Stop('STRIPE_READBACK_INVALID')
    when=parse(receipt['observedAtUtc'])
    if not parse(attempt['startedAtUtc'])<=when<=min(now,parse(binding['endUtc'])):raise Stop('STRIPE_READBACK_STALE')

def wait_stripe(attempt,binding):
    save('stripe-readback-request.json',{'operationId':PLAN['operationId'],'status':'FRESH_DISABLED_ZERO_DELIVERY_READBACK_REQUIRED','notBeforeUtc':attempt['startedAtUtc'],'deadlineUtc':binding['endUtc']})
    print('P07_RETIREMENT_STRIPE_READBACK_READY',flush=True)
    while time.time()<parse(binding['endUtc']):
        c.require_phase()
        if (ROOT/'stripe-readback.json').exists():
            value=read('stripe-readback.json');stripe_valid(value,attempt,binding);return
        time.sleep(min(0.25,c.require_phase()))
    raise Stop('STRIPE_READBACK_TIMEOUT')

def execute(binding,resources,deadline):
    if not os.isatty(0):raise Stop('ATTENDED_TERMINAL_REQUIRED')
    if (ROOT/'role-closeout.json').exists() or (ROOT/'cleanup-result.json').exists() or (ROOT/'stripe-readback.json').exists():raise Stop('STALE_RECEIPT_PRESENT')
    # Recheck real clock immediately before exclusive reservation, not only at authorization.
    if time.time()>=parse(binding['cutoffUtc']):raise Stop('START_CUTOFF')
    attempt={'operationId':PLAN['operationId'],'status':'CLEANUP_ONLY_RESERVED','startedAtUtc':utc(),'originalOperationId':c.OPERATION,'automaticRetryAllowed':False,'bindingSha256':digest(binding)}
    save('cleanup-attempt.json',attempt)
    c.ROOT=ROOT
    password='';failures=[];done=[];stage='HIDDEN_INPUT';raw_run_status=c.run_status
    def guarded(args,**kw):
        if not allowed_command(args):raise Stop('COMMAND_NOT_ALLOWED')
        c.require_phase();return raw_run_status(args,**kw)
    c.run_status=guarded
    steps=[('ROLE_CLOSEOUT',lambda:c.close_role(password)),('REMOVE_TAG',c.remove_tag)]
    steps += [('DISABLE_VERSION_'+str(i+1),lambda n=n,v=v:c.disable_version(n,v)) for i,(n,v) in enumerate(sorted(resources['secret_versions'].items()))]
    steps += [('REMOVE_BINDING_'+str(i+1),lambda n=n:c.remove_binding(n)) for i,n in enumerate(reversed(resources['bindings']))]
    steps += [('DISABLE_IDENTITY',c.disable_identity),('STRIPE_READBACK',lambda:wait_stripe(attempt,binding)),('NORMAL_TRAFFIC_READBACK',lambda:c.verify_normal_traffic(c.gc(['run','services','describe',c.SERVICE,'--project='+c.PROJECT,'--region='+c.REGION,'--format=json'],json_out=True),tag_absent=True))]
    try:
        with c.signal_guard():
            with c.phase_guard(deadline):password=c.private_input('Enter current CHILD administrator database password for cleanup (hidden): ')
            if not password:raise Stop('PASSWORD_EMPTY')
            with c.phase_guard(deadline,cleanup=True):
                for stage,action in steps:
                    try:action();c.require_phase();done.append(stage)
                    except (Exception,KeyboardInterrupt) as error:
                        code=error.code if isinstance(error,(Stop,c.Stop)) else 'STEP_FAILED'
                        failures.append({'stage':stage,'reason':code})
    except BaseException as error:
        code=error.code if isinstance(error,(Stop,c.Stop)) else 'INTERRUPTED_OR_INPUT_FAILED'
        failures.append({'stage':stage,'reason':code})
    finally:password='';c.run_status=raw_run_status
    required=[name for name,_ in steps]
    if time.time()>=deadline and not any(x['reason']=='CONTAINMENT_WINDOW_CLOSED' for x in failures):failures.append({'stage':'FINAL_DEADLINE','reason':'CONTAINMENT_WINDOW_CLOSED'})
    missing=[name for name in required if name not in done]
    status='P07_LATE_RETIREMENT_VERIFIED' if not failures and not missing else 'P07_LATE_RETIREMENT_UNCONFIRMED'
    result={'status':status,'operationId':PLAN['operationId'],'originalOperationId':c.OPERATION,'originalDeadlineMissed':True,'originalRetirementDeadlineUtc':PLAN['originalRetirementDeadlineUtc'],'completedAtUtc':utc(),'completedSteps':done,'remainingSteps':missing,'failures':failures,'automaticRetryAllowed':False,'businessMutation':False}
    try:save('cleanup-result.json',result)
    except BaseException:print('P07_LATE_RETIREMENT_UNCONFIRMED\nP07_RECEIPT_PERSISTENCE_FAILED',flush=True);return 1
    print(status,flush=True);return 0 if status.endswith('_VERIFIED') else 1

def main():
    args=sys.argv[1:]
    try:
        if args==['--check']:local_check();print('P07_CLEANUP_PREPARATION_CHECK_PASSED_NO_ACTION');return 0
        if args!=['--retire']:raise Stop('USAGE_CLEANUP_ONLY')
        binding,resources,deadline=live_check()
        return execute(binding,resources,deadline)
    except (Stop,c.Stop) as error:print('P07_CLEANUP_REFUSED_'+error.code,flush=True);return 2
    except BaseException:print('P07_CLEANUP_REFUSED_LOCAL_STATE_INVALID',flush=True);return 2
if __name__=='__main__':raise SystemExit(main())
