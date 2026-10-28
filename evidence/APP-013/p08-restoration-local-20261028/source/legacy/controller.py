#!/opt/homebrew/bin/python3
"""Disabled-by-default APP-013/P07 repaired-runtime readiness controller."""
from __future__ import annotations
import datetime as dt
import getpass
import base64
import binascii
from contextlib import contextmanager
import hashlib
import json
import os
import re
import secrets
import signal
import subprocess
import sys
import time
import urllib.parse
from pathlib import Path

ROOT=Path('/private/tmp/p07-repaired-runtime-readiness-20261022-sql-contract1')
BACKEND=Path('/Users/debynyhanbanks/Web Projects/signmons-backend-r08-recovery')
GOV=Path('/Users/debynyhanbanks/Web Projects/signmons-governance-r08-recovery')
RUNTIME_PROPOSAL=GOV/'APP013_P07_REPAIRED_DIGEST_RUNTIME_READINESS_PROPOSAL_20261020.md'
CORRECTION_PROPOSAL=GOV/'APP013_P07_STARTUP_CREDENTIAL_CORRECTION_PROPOSAL_20261020.md'
ENVELOPE_PROPOSAL=GOV/'APP013_P07_RUNTIME_ENVELOPE_PREFLIGHT_CORRECTION_PROPOSAL_20261020.md'
ACCOUNT_HANDOFF_PROPOSAL=GOV/'APP013_P07_CONNECTED_ACCOUNT_HANDOFF_CORRECTION_PROPOSAL_20261020.md'
DATABASE_TLS_PROPOSAL=GOV/'APP013_P07_DATABASE_TLS_DIAGNOSTIC_CORRECTION_PROPOSAL_20261021.md'
PREDICATE_DIAGNOSTIC_PROPOSAL=GOV/'APP013_P07_DATABASE_PREFLIGHT_PREDICATE_DIAGNOSTIC_PROPOSAL_20261021.md'
RUNTIME_PROPOSAL_SHA='a57a38e63abe1a54b8bed25b124fee6063ed29b84344febe0252e88c4b489e88'
CORRECTION_PROPOSAL_SHA='8e1e7cb5fdbb2f5d57b7bc251a2f90dc3b89313aae75fe9280589bc07ffcaf39'
ENVELOPE_PROPOSAL_SHA='15e75963b473a07d530d4c383947f1680d197dd715d4cc9d47a701e555ddc7f4'
ENVELOPE_SOURCE_HEAD='ba7b10d99eba0caa17a4a90784163c65758fdb96'
ACCOUNT_HANDOFF_PROPOSAL_SHA='e550cd263e50144e5e8719e0a5e35903a4b2236d8b513fe78a6a01664e3191fe'
ACCOUNT_HANDOFF_SOURCE_HEAD='67c504b18430cb8f9bcab0f40636f31120425a52'
DATABASE_TLS_PROPOSAL_SHA='310264db46ba1a73b2c2724813615b73d4f60e6ac40a5700fac1bd4dc4cb7ea0'
DATABASE_TLS_SOURCE_HEAD='e1342bbc37f570f97b6f25b98aef7f8f0222e0f4'
PREDICATE_DIAGNOSTIC_PROPOSAL_SHA='f910b9b617ed39e5d55af7048b2ebfe0e6adbdd03261f6577868b2ce7161b03c'
PREDICATE_DIAGNOSTIC_SOURCE_HEAD='7b592debd4b2aaddbdfb9e8478acf1759c2cf197'
GUARD_SOURCE_HEAD='d88dc4e8bd138046b8ca5dca36029a266c8b27d5'
GUARD_PROPOSAL_NAME='APP013_P07_RUNTIME_GUARD_COMPLETION_PROPOSAL_20261022.md'
GUARD_PROPOSAL_SHA='bbb91e771ba66aacf149e038045da159111cc8a3e253d0b531cf84ec19f0b9b3'
SQL_CONTRACT_SOURCE_HEAD='a16513f0f9433adebdf3c978a6bfbfefdf4fd55a'
SQL_CONTRACT_PROPOSAL_NAME='APP013_P07_SQL_OUTPUT_CONTRACT_REUSE_PROPOSAL_20261022.md'
SQL_CONTRACT_PROPOSAL_SHA='807b16c97b9acf18bd9a91440615aecc1f051a7dbbad44afea5e58f53934868a'
ROLE_FIXTURE_SHA='35785d3857f6fc9b01042d6dee3137eebb18950601fb1b8e7644e340be8fb83c'
BACKEND_HEAD='17bd56b3f4e88f2cf879b077eb62bc7ec588dd03'
GOV_SOURCE_HEAD='bc7acbb93eddb293a13f0b96b17b00a0cea52aac'
PLAN='4bb26b9b-cd41-4bbb-a62a-5aedfd4f82bb'
PACKET='c9622a7d-7aa0-4a27-ab75-e9bc56f21cc0'
OPERATION='b8d2ac94-3310-4f84-b36a-8495cc919097'
PROJECT='signmons'; REGION='us-east5'; SERVICE='signmons-calldesk-staging'
NORMAL='signmons-calldesk-staging-app013dbrot2'
REVISION='signmons-calldesk-staging-app013p07atomic1'; SUFFIX='app013p07atomic1'; TAG='app013-p07-atomic'
ORIGIN='https://app013-p07-atomic---signmons-calldesk-staging-p572d6wipq-ul.a.run.app'
IMAGE='us-east5-docker.pkg.dev/signmons/signmons/signmons-calldesk-backend@sha256:36f887749947c0b01db683482c081ca663534e7ffe597560b24597f3d46be9da'
JOB='9180bef4-561d-47a0-869f-925e6a3dfd96'; TENANT='a1adcfd4-15be-404b-9ac3-5edb1fda20f0'
DB_HOST='ep-jolly-flower-ayc6w9hv.c-5.us-east-2.aws.neon.tech'; DB_NAME='neondb'; DB_ADMIN='neondb_owner'; ROLE='p07_payment_runtime'
SERVICE_ACCOUNT='signmons-calldesk-p07-runtime@signmons.iam.gserviceaccount.com'
GCLOUD='/opt/homebrew/bin/gcloud'; PSQL='/opt/homebrew/opt/postgresql@16/bin/psql'; NODE='/Users/debynyhanbanks/.nvm/versions/node/v24.12.0/bin/node'
NEW_SECRETS={
  'database':'signmons-staging-p07-payment-database-url',
  'webhook':'signmons-staging-p07-stripe-webhook-secret',
  'openai':'signmons-staging-p07-disabled-openai-key',
  'admin':'signmons-staging-p07-admin-token',
  'conversation':'signmons-staging-p07-conversation-key',
  'technician':'signmons-staging-p07-technician-link-key',
}
STRIPE_SECRET='signmons-staging-stripe-secret-key'; STRIPE_VERSION='1'
EVENTS=sorted(['checkout.session.completed','checkout.session.async_payment_succeeded','checkout.session.async_payment_failed','checkout.session.expired','payment_intent.payment_failed','charge.refunded'])
EVENT_HASH=hashlib.sha256(('\n'.join(EVENTS)+'\n').encode()).hexdigest()
SA_MEMBER='serviceAccount:'+SERVICE_ACCOUNT
SA_RESOURCE='projects/signmons/serviceAccounts/'+SERVICE_ACCOUNT
PLAIN_ENV={
  'NODE_ENV':'production','GOOGLE_CLOUD_PROJECT':'signmons','DEV_AUTH_ENABLED':'false',
  'SCHEDULING_ENABLED':'false','STRIPE_WEBHOOK_LIVEMODE':'false','SMS_DELIVERY_ENABLED':'false',
  'BACKGROUND_WORKERS_ENABLED':'false','STAGING_PHONE_TEST_ENABLED':'false',
  'ENABLED_TOOLS':'none','WEBCHAT_INTEGRATIONS_JSON':'[]','TWILIO_TENANT_IDENTITIES_JSON':'[]',
}
MUT={
  'role_attempted':False,'role_created':False,'role_open':False,'secret_resources':[],
  'secret_versions':{},'service_account_attempted':False,'service_account_created':False,
  'bindings':[],'stripe_destination':False,'deploy_attempted':False,'deployed':False,
}

class Stop(Exception):
    def __init__(self,code): self.code=code; super().__init__(code)

_PHASE_DEADLINE=None
_CLEANING=False


def require_phase():
    if _PHASE_DEADLINE is not None:
        remaining=_PHASE_DEADLINE-time.time()
        if remaining<=0:raise Stop('CONTAINMENT_WINDOW_CLOSED' if _CLEANING else 'READINESS_WINDOW_CLOSED')
        return remaining
    return None


@contextmanager
def phase_guard(deadline,cleanup=False):
    global _PHASE_DEADLINE,_CLEANING
    previous=(_PHASE_DEADLINE,_CLEANING)
    _PHASE_DEADLINE=deadline;_CLEANING=cleanup
    try:
        require_phase()
        yield
        require_phase()
    finally:_PHASE_DEADLINE,_CLEANING=previous


@contextmanager
def signal_guard():
    previous={signum:signal.getsignal(signum) for signum in (signal.SIGINT,signal.SIGTERM)}
    def interrupted(signum,frame):
        if not _CLEANING:raise Stop('INTERRUPTED')
    try:
        for signum in previous:signal.signal(signum,interrupted)
        yield
    finally:
        for signum,handler in previous.items():signal.signal(signum,handler)


def private_input(prompt):
    remaining=require_phase()
    if remaining is None:raise Stop('INPUT_DEADLINE_NOT_BOUND')
    previous=signal.getsignal(signal.SIGALRM)
    old_timer=signal.getitimer(signal.ITIMER_REAL)
    if old_timer!=(0.0,0.0):raise Stop('INPUT_TIMER_COLLISION')
    def expired(signum,frame):raise Stop('CONTAINMENT_WINDOW_CLOSED' if _CLEANING else 'READINESS_WINDOW_CLOSED')
    try:
        signal.signal(signal.SIGALRM,expired)
        signal.setitimer(signal.ITIMER_REAL,remaining)
        value=getpass.getpass(prompt)
        require_phase()
        return value
    finally:
        signal.setitimer(signal.ITIMER_REAL,0)
        signal.signal(signal.SIGALRM,previous)


def sha(path):
    h=hashlib.sha256()
    with Path(path).open('rb') as f:
        for chunk in iter(lambda:f.read(65536),b''): h.update(chunk)
    return h.hexdigest()

def save(name,value):
    p=ROOT/name
    fd=os.open(p,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
    with os.fdopen(fd,'w') as f:
        json.dump(value,f,indent=2,sort_keys=True); f.write('\n'); f.flush(); os.fsync(f.fileno())

def journal():
    tmp=ROOT/'.mutation-journal.tmp'
    data={'planId':PLAN,'operationId':OPERATION,'mutation':MUT}
    fd=os.open(tmp,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
    try:
        with os.fdopen(fd,'w') as f:
            json.dump(data,f,indent=2,sort_keys=True);f.write('\n');f.flush();os.fsync(f.fileno())
        os.replace(tmp,ROOT/'mutation-journal.json')
    finally:
        try:tmp.unlink()
        except FileNotFoundError:pass

def load_journal():
    try:value=json.loads((ROOT/'mutation-journal.json').read_text())
    except (OSError,json.JSONDecodeError):raise Stop('MUTATION_JOURNAL_UNAVAILABLE')
    if value.get('planId')!=PLAN or value.get('operationId')!=OPERATION or not isinstance(value.get('mutation'),dict):raise Stop('MUTATION_JOURNAL_INVALID')
    if set(value['mutation'])!=set(MUT):raise Stop('MUTATION_JOURNAL_INVALID')
    MUT.clear();MUT.update(value['mutation'])

def run_status(args,*,input_bytes=None,timeout=120,env=None,cwd=None):
    base=os.environ.copy(); base['PATH']='/opt/homebrew/bin:/usr/bin:/bin'
    if env: base.update(env)
    remaining=require_phase()
    if remaining is not None:timeout=min(timeout,remaining)
    try:
        result=subprocess.run(args,input=input_bytes,stdout=subprocess.PIPE,stderr=subprocess.PIPE,env=base,cwd=cwd,timeout=timeout,check=False)
        require_phase()
        return result
    except subprocess.TimeoutExpired: raise Stop('COMMAND_TIMEOUT')

def run(args,*,input_bytes=None,timeout=120,json_out=False,env=None,cwd=None):
    r=run_status(args,input_bytes=input_bytes,timeout=timeout,env=env,cwd=cwd)
    if r.returncode: raise Stop('COMMAND_FAILED')
    value=r.stdout.decode('utf-8','strict').strip()
    return json.loads(value) if json_out else value

def gc(args,**kw): return run([GCLOUD,*args],**kw)
def git_head(repo): return run(['/usr/bin/git','rev-parse','HEAD'],env={'PATH':'/usr/bin:/bin'},cwd=repo)
def git_clean(repo): return run(['/usr/bin/git','status','--porcelain'],env={'PATH':'/usr/bin:/bin'},cwd=repo)==''
def git_file_sha(repo,revision,path):
    result=run_status(['/usr/bin/git','show',revision+':'+path],env={'PATH':'/usr/bin:/bin'},cwd=repo)
    if result.returncode:raise Stop('GOVERNANCE_SOURCE_UNAVAILABLE')
    return hashlib.sha256(result.stdout).hexdigest()

def parse_utc(value):
    if not isinstance(value,str) or not value.endswith('Z'): raise Stop('WINDOW_BINDING_INVALID')
    try: return dt.datetime.fromisoformat(value[:-1]+'+00:00')
    except ValueError: raise Stop('WINDOW_BINDING_INVALID')

def load_binding():
    try: value=json.loads((ROOT/'binding.json').read_text())
    except (OSError,json.JSONDecodeError): raise Stop('WINDOW_NOT_BOUND')
    keys={'status','planId','packetId','operationId','windowStartUtc','startCutoffUtc','workEndUtc','containmentEndUtc','windowEndUtc','retirementDeadlineUtc'}
    if set(value)!=keys or value['status']!='LIVE_REVIEW_BOUND' or (value['planId'],value['packetId'],value['operationId'])!=(PLAN,PACKET,OPERATION): raise Stop('WINDOW_BINDING_INVALID')
    start,cutoff,work,contain,end,retire=[parse_utc(value[k]) for k in ['windowStartUtc','startCutoffUtc','workEndUtc','containmentEndUtc','windowEndUtc','retirementDeadlineUtc']]
    if not (start<cutoff<=start+dt.timedelta(minutes=15)<work<contain<=end): raise Stop('WINDOW_BINDING_INVALID')
    if end-start<dt.timedelta(minutes=90) or not (end<retire<=start+dt.timedelta(hours=24)): raise Stop('WINDOW_BINDING_INVALID')
    value['_times']=(start,cutoff,work,contain,end,retire)
    return value

def approval_valid(approval,binding):
    expected={
      'allowedActions':['create_one_restricted_database_role','create_six_secret_resources_and_versions','create_one_service_identity','add_seven_resource_secret_bindings','create_disable_readback_one_stripe_destination','deploy_one_zero_normal_traffic_revision','mandatory_containment_and_retirement'],
      'automaticRetryAllowed':False,'cloudAllowanceUsd':1.0,'decision':'APPROVED',
      'forbiddenActions':['checkout','card_entry','payment','refund','booking','customer_contact','message_delivery','test_event','event_resend','normal_traffic'],
      'operationId':OPERATION,'owner':'Debynyhan Banks','packetId':PACKET,'planId':PLAN,
      'secretVersionMonthlyUsdMax':0.36,'startCutoffUtc':binding['startCutoffUtc'],
      'windowEndUtc':binding['windowEndUtc'],'windowStartUtc':binding['windowStartUtc'],
      'retirementDeadlineUtc':binding['retirementDeadlineUtc']}
    value=dict(approval) if isinstance(approval,dict) else approval
    approved_at=value.pop('approvedAtUtc',None) if isinstance(value,dict) else None
    if value!=expected or not isinstance(approved_at,str): return False
    try: at=parse_utc(approved_at)
    except Stop: return False
    return at<=binding['_times'][1]

def local_check(require_live=False):
    if git_file_sha(GOV,SQL_CONTRACT_SOURCE_HEAD,SQL_CONTRACT_PROPOSAL_NAME)!=SQL_CONTRACT_PROPOSAL_SHA:raise Stop('SQL_CONTRACT_APPROVAL_SOURCE_DRIFT')
    if git_file_sha(GOV,GUARD_SOURCE_HEAD,GUARD_PROPOSAL_NAME)!=GUARD_PROPOSAL_SHA:raise Stop('GUARD_APPROVAL_SOURCE_DRIFT')
    if git_file_sha(GOV,GOV_SOURCE_HEAD,RUNTIME_PROPOSAL.name)!=RUNTIME_PROPOSAL_SHA or git_file_sha(GOV,GOV_SOURCE_HEAD,CORRECTION_PROPOSAL.name)!=CORRECTION_PROPOSAL_SHA or git_file_sha(GOV,ENVELOPE_SOURCE_HEAD,ENVELOPE_PROPOSAL.name)!=ENVELOPE_PROPOSAL_SHA or git_file_sha(GOV,ACCOUNT_HANDOFF_SOURCE_HEAD,ACCOUNT_HANDOFF_PROPOSAL.name)!=ACCOUNT_HANDOFF_PROPOSAL_SHA or git_file_sha(GOV,DATABASE_TLS_SOURCE_HEAD,DATABASE_TLS_PROPOSAL.name)!=DATABASE_TLS_PROPOSAL_SHA or git_file_sha(GOV,PREDICATE_DIAGNOSTIC_SOURCE_HEAD,PREDICATE_DIAGNOSTIC_PROPOSAL.name)!=PREDICATE_DIAGNOSTIC_PROPOSAL_SHA: raise Stop('PROPOSAL_HASH_DRIFT')
    if sha(ROOT/'p07-payment-runtime-role-review.sql')!=ROLE_FIXTURE_SHA: raise Stop('ROLE_FIXTURE_HASH_DRIFT')
    if BACKEND_HEAD not in run(['/usr/bin/git','rev-list','HEAD'],env={'PATH':'/usr/bin:/bin'},cwd=BACKEND).splitlines() or not git_clean(BACKEND): raise Stop('BACKEND_DRIFT')
    governance_history=run(['/usr/bin/git','rev-list','HEAD'],env={'PATH':'/usr/bin:/bin'},cwd=GOV).splitlines()
    if GOV_SOURCE_HEAD not in governance_history or ENVELOPE_SOURCE_HEAD not in governance_history or ACCOUNT_HANDOFF_SOURCE_HEAD not in governance_history or DATABASE_TLS_SOURCE_HEAD not in governance_history or PREDICATE_DIAGNOSTIC_SOURCE_HEAD not in governance_history or not git_clean(GOV): raise Stop('GOVERNANCE_DRIFT')
    if os.stat(ROOT).st_mode&0o777!=0o700: raise Stop('PRIVATE_DIRECTORY_MODE')
    manifest=json.loads((ROOT/'manifest.json').read_text())
    for name,expected in manifest['files'].items():
        if sha(ROOT/name)!=expected: raise Stop('PACKAGE_HASH_DRIFT')
    plan=json.loads((ROOT/'plan.json').read_text())
    if plan.get('status')!='PREPARATION_ONLY_PENDING_WINDOW_AND_LIVE_APPROVAL' or plan.get('externalActionAuthorized') is not False: raise Stop('PLAN_NOT_DISABLED')
    if (ROOT/'binding.json').exists():
        load_binding()
    if require_live:
        binding=load_binding()
        try: approval=json.loads((ROOT/'owner-approval.json').read_text())
        except (OSError,json.JSONDecodeError): raise Stop('OWNER_APPROVAL_INVALID')
        if not approval_valid(approval,binding): raise Stop('OWNER_APPROVAL_INVALID')
        return binding
    return None

def start_state(now,binding):
    start,cutoff=binding['_times'][:2]; instant=dt.datetime.fromtimestamp(now,dt.timezone.utc)
    if instant<start:return 'WAIT'
    if instant>=cutoff:raise Stop('START_WINDOW_CLOSED')
    return 'OPEN'

def require_absent(args,code):
    r=run_status([GCLOUD,*args],timeout=60)
    if r.returncode==0: raise Stop(code+'_COLLISION')
    text=(r.stdout+r.stderr).decode('utf-8','ignore').lower()
    if not any(x in text for x in ['not found','not_found','does not exist']): raise Stop(code+'_UNCONFIRMED')

def runtime_shape(service,revision=None):
    if revision is None: template=service.get('spec',{}).get('template',{}); spec=template.get('spec',{}); annotations=template.get('metadata',{}).get('annotations',{})
    else: spec=revision.get('spec',{}); annotations=revision.get('metadata',{}).get('annotations',{})
    container=spec.get('containers',[{}])[0]; limits=container.get('resources',{}).get('limits',{})
    return {'serviceAccount':spec.get('serviceAccountName'),'timeoutSeconds':spec.get('timeoutSeconds'),'concurrency':spec.get('containerConcurrency'),'cpu':str(limits.get('cpu')),'memory':limits.get('memory'),'maxScale':annotations.get('autoscaling.knative.dev/maxScale'),'minScale':annotations.get('autoscaling.knative.dev/minScale'),'cpuThrottling':annotations.get('run.googleapis.com/cpu-throttling'),'startupCpuBoost':annotations.get('run.googleapis.com/startup-cpu-boost'),'ingress':service.get('metadata',{}).get('annotations',{}).get('run.googleapis.com/ingress')}

def require_envelope(shape,identity):
    if shape.get('serviceAccount')!=identity: raise Stop('RUNTIME_IDENTITY_DRIFT')
    if shape.get('timeoutSeconds')!=60 or shape.get('concurrency')!=40: raise Stop('RUNTIME_ENVELOPE_DRIFT')
    if shape.get('cpu') not in {'1','1000m'} or shape.get('memory')!='512Mi': raise Stop('RUNTIME_ENVELOPE_DRIFT')
    if shape.get('maxScale')!='1' or shape.get('minScale') not in {None,'0'}: raise Stop('RUNTIME_ENVELOPE_DRIFT')
    if shape.get('cpuThrottling')!='true' or shape.get('startupCpuBoost')!='true' or shape.get('ingress')!='all': raise Stop('RUNTIME_ENVELOPE_DRIFT')

def require_normal_envelope(shape):
    if shape.get('serviceAccount')!='signmons-calldesk-runtime@signmons.iam.gserviceaccount.com': raise Stop('NORMAL_RUNTIME_IDENTITY_DRIFT')
    if shape.get('timeoutSeconds')!=60 or shape.get('concurrency')!=40: raise Stop('NORMAL_RUNTIME_ENVELOPE_DRIFT')
    if shape.get('cpu') not in {'1','1000m'} or shape.get('memory')!='512Mi': raise Stop('NORMAL_RUNTIME_ENVELOPE_DRIFT')
    if shape.get('maxScale')!='2' or shape.get('minScale') not in {None,'0'}: raise Stop('NORMAL_RUNTIME_ENVELOPE_DRIFT')
    if shape.get('cpuThrottling') is not None or shape.get('startupCpuBoost')!='true' or shape.get('ingress')!='all': raise Stop('NORMAL_RUNTIME_ENVELOPE_DRIFT')

def traffic_preflight(service):
    rows=service.get('status',{}).get('traffic',[]); normal=[x for x in rows if x.get('percent')==100]
    if len(normal)!=1 or normal[0].get('revisionName')!=NORMAL: raise Stop('NORMAL_TRAFFIC_DRIFT')
    if any(x.get('tag')==TAG or x.get('revisionName')==REVISION for x in rows): raise Stop('TARGET_ALREADY_PRESENT')

def cloud_preflight():
    if gc(['config','get-value','account']).strip()!='debynyhan@signmons.com': raise Stop('CLOUD_ACCOUNT_DRIFT')
    service=gc(['run','services','describe',SERVICE,'--project='+PROJECT,'--region='+REGION,'--format=json'],json_out=True)
    traffic_preflight(service)
    normal_revision=gc(['run','revisions','describe',NORMAL,'--project='+PROJECT,'--region='+REGION,'--format=json'],json_out=True)
    require_normal_envelope(runtime_shape(service,normal_revision))
    meta=gc(['secrets','versions','describe',STRIPE_VERSION,'--secret='+STRIPE_SECRET,'--project='+PROJECT,'--format=json'],json_out=True)
    if meta.get('state')!='ENABLED': raise Stop('STRIPE_KEY_METADATA_DRIFT')
    for name in NEW_SECRETS.values(): require_absent(['secrets','describe',name,'--project='+PROJECT,'--format=json'],'SECRET')
    require_absent(['iam','service-accounts','describe',SERVICE_ACCOUNT,'--project='+PROJECT,'--format=json'],'SERVICE_ACCOUNT')
    firebase=json.loads(run([NODE,str(ROOT/'firebase-read.mjs')],timeout=60))
    if firebase!={'disabled':True,'ownerRole':True,'tenantMatch':True}: raise Stop('FIREBASE_IDENTITY_DRIFT')
    safe={x.get('name'):x.get('value') for x in normal_revision.get('spec',{}).get('containers',[{}])[0].get('env',[]) if 'value' in x}
    return_url=safe.get('CUSTOMER_PAYMENT_RETURN_URL','')
    try: parsed=urllib.parse.urlparse(return_url)
    except ValueError: raise Stop('RETURN_URL_DRIFT')
    if parsed.scheme!='https' or not parsed.hostname or parsed.hostname in {'localhost','127.0.0.1','::1'}: raise Stop('RETURN_URL_DRIFT')
    PLAIN_ENV['CUSTOMER_PAYMENT_RETURN_URL']=return_url
    save('cloud-preflight.json',{'status':'PASSED','normalRevision':NORMAL,'normalTrafficPercent':100,'normalEnvelopeExact':True,'targetAbsent':True,'existingStripeKeyVersionEnabled':True,'sixNewSecretsAbsent':True,'serviceIdentityAbsent':True,'returnUrlQualified':True,'firebase':firebase})

def classify_database_error(stderr):
    text=stderr.decode('utf-8','ignore').lower()
    if any(x in text for x in ['root certificate','certificate verify','certificate validation','hostname mismatch','ssl error','tls error']): return 'DATABASE_TLS_CONFIGURATION'
    if any(x in text for x in ['password authentication failed','authentication failed','no password supplied','sasl authentication']): return 'DATABASE_AUTHENTICATION'
    if any(x in text for x in ['could not translate host name','could not connect','connection refused','network is unreachable','connection timed out','timeout expired','server closed the connection']): return 'DATABASE_CONNECTION'
    if any(x in text for x in ['relation ','column ','operator does not exist','syntax error','invalid input syntax','permission denied']): return 'DATABASE_SCHEMA_OR_QUERY'
    return 'COMMAND_FAILED'

def psql_admin(password,sql,timeout=45):
    env={'PGPASSWORD':password,'PGSSLMODE':'verify-full','PGSSLROOTCERT':'system','PGCONNECT_TIMEOUT':'8','PGAPPNAME':'signmons_p07_atomic_admin'}
    result=run_status([PSQL,'-X','-q','-A','-t','-v','ON_ERROR_STOP=1','-h',DB_HOST,'-U',DB_ADMIN,'-d',DB_NAME],input_bytes=sql.encode(),timeout=timeout,env=env)
    if result.returncode:
        code=classify_database_error(result.stderr);result.stdout=b'';result.stderr=b'';raise Stop(code)
    return result.stdout.decode('utf-8','strict').strip()

def wait_receipt(name,validator,deadline):
    p=ROOT/name
    while time.time()<deadline:
        require_phase()
        if p.exists():
            try:value=json.loads(p.read_text())
            except json.JSONDecodeError:raise Stop('RECEIPT_INVALID')
            validator(value);require_phase();return value
        time.sleep(1)
    raise Stop('RECEIPT_TIMEOUT')

def validate_stripe_preflight(value):
    required={'mode':'SANDBOX_TEST','enabledConnectedAccounts':1,'destinationAbsent':True,'accountAdmin':True}
    if any(value.get(k)!=v for k,v in required.items()) or not re.fullmatch(r'[a-f0-9]{64}',str(value.get('connectedAccountSha256',''))): raise Stop('STRIPE_PREFLIGHT_DRIFT')

PREFLIGHT_SQL=f"""BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;
SELECT 'IDENTITY|'||current_database()||'|'||current_user||'|'||(SELECT count(*) FROM pg_roles WHERE rolname='{ROLE}')||'|'||(SELECT count(*) FROM pg_roles WHERE rolname='p06_intake_runtime')||'|'||COALESCE((SELECT CASE WHEN rolcanlogin THEN '1' ELSE '0' END FROM pg_roles WHERE rolname='p06_intake_runtime'),'0')||'|'||COALESCE((SELECT rolconnlimit::text FROM pg_roles WHERE rolname='p06_intake_runtime'),'0')||'|'||COALESCE((SELECT CASE WHEN rolvaliduntil IS NOT NULL AND rolvaliduntil<now() THEN '1' ELSE '0' END FROM pg_roles WHERE rolname='p06_intake_runtime'),'0')||'|'||(SELECT count(*) FROM pg_stat_activity WHERE usename='p06_intake_runtime' AND backend_type='client backend');
WITH j AS (SELECT * FROM \"Job\" WHERE id='{JOB}'::uuid AND \"tenantId\"='{TENANT}'::uuid) SELECT 'JOB|'||(SELECT count(*) FROM j)||'|'||CASE WHEN COALESCE((SELECT bool_and(status='CREATED') FROM j),false) THEN '1' ELSE '0' END||'|'||CASE WHEN COALESCE((SELECT bool_and(\"deletedAt\" IS NULL) FROM j),false) THEN '1' ELSE '0' END||'|'||(SELECT count(*) FROM \"Payment\" WHERE \"jobId\"='{JOB}'::uuid AND \"tenantId\"='{TENANT}'::uuid)||'|'||CASE WHEN COALESCE((SELECT bool_and(\"calendarEventId\" IS NULL) FROM j),false) THEN '1' ELSE '0' END||'|'||(SELECT count(*) FROM \"CalendarOperation\" WHERE \"jobId\"='{JOB}'::uuid AND \"tenantId\"='{TENANT}'::uuid)||'|'||CASE WHEN COALESCE((SELECT bool_and(jsonb_typeof(\"policySnapshot\"->'intakeAdmission')='object' AND (\"policySnapshot\"#>>'{{intakeAdmission,paymentDigest}}')~'^[a-f0-9]{{64}}$' AND NOT(\"policySnapshot\"?'paymentPolicyBinding')) FROM j),false) THEN '1' ELSE '0' END;
WITH t AS (SELECT \"stripeConnectAccountId\",\"chargesEnabled\" FROM \"TenantOrganization\" WHERE id='{TENANT}'::uuid) SELECT 'TENANT|'||count(*)||'|'||encode(convert_to(COALESCE(max(\"stripeConnectAccountId\"),''),'UTF8'),'base64')||'|'||CASE WHEN COALESCE(bool_and(\"chargesEnabled\"),false) THEN '1' ELSE '0' END FROM t;
ROLLBACK;
"""

def classify_database_preflight(lines,stripe):
    if not isinstance(lines,list) or len(lines)!=3 or not all(isinstance(value,str) for value in lines):raise Stop('DATABASE_PREFLIGHT_OUTPUT_INVALID')
    identity=lines[0].split('|')
    if len(identity)!=9 or identity[0]!='IDENTITY':raise Stop('DATABASE_PREFLIGHT_OUTPUT_INVALID')
    _,database,user,p07_count_raw,p06_count_raw,p06_login,p06_limit_raw,p06_expired,p06_sessions_raw=identity
    if p06_login not in {'0','1'} or p06_expired not in {'0','1'}:raise Stop('DATABASE_PREFLIGHT_OUTPUT_INVALID')
    try:
        p07_count=int(p07_count_raw);p06_count=int(p06_count_raw);p06_limit=int(p06_limit_raw);p06_sessions=int(p06_sessions_raw)
    except ValueError:raise Stop('DATABASE_PREFLIGHT_OUTPUT_INVALID')
    if database!='neondb' or user!='neondb_owner':raise Stop('DATABASE_IDENTITY_DRIFT')
    if p07_count!=0:raise Stop('P07_ROLE_COLLISION')
    if (p06_count,p06_login,p06_limit,p06_expired,p06_sessions)!=(1,'0',0,'1',0):raise Stop('P06_ROLE_STATE_DRIFT')
    job=lines[1].split('|')
    if len(job)!=8 or job[0]!='JOB' or any(job[index] not in {'0','1'} for index in [2,3,5,7]):raise Stop('DATABASE_PREFLIGHT_OUTPUT_INVALID')
    try:job_count=int(job[1]);payment_count=int(job[4]);calendar_count=int(job[6])
    except ValueError:raise Stop('DATABASE_PREFLIGHT_OUTPUT_INVALID')
    if job_count!=1:raise Stop('EXACT_JOB_COUNT_DRIFT')
    if job[2]!='1':raise Stop('JOB_STATE_DRIFT')
    if job[3]!='1':raise Stop('JOB_DELETED')
    if payment_count!=0:raise Stop('PAYMENT_ACTIVITY_PRESENT')
    if job[5]!='1':raise Stop('CALENDAR_EVENT_PRESENT')
    if calendar_count!=0:raise Stop('CALENDAR_OPERATION_PRESENT')
    if job[7]!='1':raise Stop('CONTROLLED_ADMISSION_POLICY_DRIFT')
    tenant=lines[2].split('|')
    if len(tenant)!=4 or tenant[0]!='TENANT' or tenant[3] not in {'0','1'}:raise Stop('DATABASE_PREFLIGHT_OUTPUT_INVALID')
    try:tenant_count=int(tenant[1])
    except ValueError:raise Stop('DATABASE_PREFLIGHT_OUTPUT_INVALID')
    if tenant_count!=1:raise Stop('TENANT_COUNT_DRIFT')
    try:account=base64.b64decode(tenant[2],validate=True).decode('utf-8','strict')
    except (ValueError,binascii.Error,UnicodeDecodeError):raise Stop('DATABASE_PREFLIGHT_OUTPUT_INVALID')
    try:
        if not re.fullmatch(r'acct_[A-Za-z0-9]{8,}',account):raise Stop('CONNECTED_ACCOUNT_FORMAT')
        if tenant[3]!='1':raise Stop('CONNECTED_ACCOUNT_CHARGES_DISABLED')
        validate_stripe_preflight(stripe)
        if not secrets.compare_digest(stripe['connectedAccountSha256'],hashlib.sha256(account.encode()).hexdigest()):raise Stop('CONNECTED_ACCOUNT_MISMATCH')
    finally:account=''
    return 'DATABASE_PREFLIGHT_MATCH'

def db_preflight(password):
    lines=[]
    try:
        lines=[line for line in psql_admin(password,PREFLIGHT_SQL).splitlines() if line]
        try:stripe=json.loads((ROOT/'stripe-preflight.json').read_text())
        except (OSError,json.JSONDecodeError):raise Stop('STRIPE_PREFLIGHT_DRIFT')
        classify_database_preflight(lines,stripe)
        save('database-preflight.json',{'status':'PASSED','p07RoleAbsent':True,'p06RoleClosed':True,'jobCount':1,'jobState':'CREATED','undeleted':True,'paymentCount':0,'calendarEventAbsent':True,'calendarOperationCount':0,'approvedDigestAndUnboundPolicy':True,'tenantAccountMatchesAndChargesEnabled':True})
    finally:lines.clear()


ROLE_BOUNDARY_EXPECTED='ROLE|1|1|0|0|0|0|0|0|6|1|0|0'


def role_boundary_sql(expire):
    flags=['rolcanlogin','rolinherit','rolsuper','rolcreatedb','rolcreaterole','rolreplication','rolbypassrls']
    fields=["CASE WHEN COALESCE(bool_and("+name+"),false) THEN '1' ELSE '0' END" for name in flags]
    fields.extend(["COALESCE(min(rolconnlimit),0)::text",f"CASE WHEN COALESCE(bool_and(rolvaliduntil IS NOT NULL AND rolvaliduntil<='{expire}'::timestamptz),false) THEN '1' ELSE '0' END",f"(SELECT count(*) FROM pg_auth_members WHERE member=(SELECT oid FROM pg_roles WHERE rolname='{ROLE}'))::text",f"(SELECT count(*) FROM pg_class WHERE relowner=(SELECT oid FROM pg_roles WHERE rolname='{ROLE}'))::text"])
    return "BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;\nWITH r AS (SELECT * FROM pg_roles WHERE rolname='"+ROLE+"') SELECT 'ROLE|'||count(*)||'|'||"+"||'|'||".join(fields)+" FROM r;\nROLLBACK;"


def validate_role_boundary(row):
    if row!=ROLE_BOUNDARY_EXPECTED:raise Stop('RUNTIME_ROLE_BOUNDARY_DRIFT')


def create_secret_resource(name,value=None):
    MUT['secret_resources'].append(name)
    journal()
    gc(['secrets','create',name,'--project='+PROJECT,'--replication-policy=automatic','--labels=signmons-operation=app013-p07-atomic','--quiet'],timeout=90)
    if value is None:return None
    MUT['secret_versions'][name]='UNKNOWN'
    journal()
    meta=gc(['secrets','versions','add',name,'--project='+PROJECT,'--data-file=-','--format=json'],input_bytes=value,timeout=90,json_out=True)
    match=re.search(r'/versions/(\d+)$',meta.get('name',''))
    if not match:raise Stop('SECRET_VERSION_UNKNOWN')
    version=match.group(1);MUT['secret_versions'][name]=version;journal()
    state=gc(['secrets','versions','describe',version,'--secret='+name,'--project='+PROJECT,'--format=json'],json_out=True).get('state')
    if state!='ENABLED':raise Stop('SECRET_VERSION_NOT_ENABLED')
    return version

def provision_database(password,binding):
    MUT['role_attempted']=True
    journal()
    fixture=(ROOT/'p07-payment-runtime-role-review.sql').read_text()
    psql_admin(password,fixture+f'\nGRANT CONNECT ON DATABASE "{DB_NAME}" TO {ROLE};\n')
    MUT['role_created']=True;journal()
    raw=bytearray(secrets.token_urlsafe(42).encode())
    role_password=raw.decode()
    expire=binding['workEndUtc'].replace('T',' ').replace('Z','+00')
    psql_admin(password,f"ALTER ROLE {ROLE} PASSWORD '{role_password}' LOGIN CONNECTION LIMIT 6 VALID UNTIL '{expire}';")
    MUT['role_open']=True;journal()
    role_state=psql_admin(password,role_boundary_sql(expire))
    validate_role_boundary(role_state)
    encoded=urllib.parse.quote(role_password,safe='')
    url=f'postgresql://{ROLE}:{encoded}@{DB_HOST}:5432/{DB_NAME}?sslmode=verify-full&channel_binding=require'
    version=create_secret_resource(NEW_SECRETS['database'],url.encode())
    direct=run([PSQL,'-X','-q','-A','-t','-v','ON_ERROR_STOP=1','-h',DB_HOST,'-U',ROLE,'-d',DB_NAME],input_bytes=f"SELECT current_user||'|'||session_user||'|'||current_database()||'|'||(SELECT count(*) FROM \"Job\" WHERE id='{JOB}'::uuid AND \"tenantId\"='{TENANT}'::uuid);".encode(),timeout=45,env={'PGPASSWORD':role_password,'PGSSLMODE':'verify-full','PGSSLROOTCERT':'system','PGCONNECT_TIMEOUT':'8','PGAPPNAME':'signmons_p07_atomic_runtime'})
    if direct!='p07_payment_runtime|p07_payment_runtime|neondb|1':raise Stop('RUNTIME_ROLE_DIRECT_READ_FAILED')
    for i in range(len(raw)):raw[i]=0
    role_password='';encoded='';url=''
    save('database-provisioning.json',{'status':'PASSED','role':ROLE,'noInherit':True,'noElevation':True,'memberships':0,'ownedRelations':0,'connectionLimit':6,'expiresNoLaterThan':binding['workEndUtc'],'directRuntimeIdentity':True,'exactJobVisible':True,'databaseSecretVersion':int(version)})
    return version

def provision_startup_secrets():
    values={
      'openai':bytearray(('p07_disabled_'+secrets.token_urlsafe(30)).encode()),
      'admin':bytearray(secrets.token_urlsafe(48).encode()),
      'conversation':bytearray(secrets.token_hex(32).encode()),
      'technician':bytearray(secrets.token_urlsafe(48).encode()),
    }
    if values['openai'].startswith((b'sk-',b'rk-')) or len({bytes(x) for x in values.values()})!=4:raise Stop('STARTUP_SECRET_GENERATION_FAILED')
    versions={}
    try:
        for key in ['openai','admin','conversation','technician']:
            versions[key]=create_secret_resource(NEW_SECRETS[key],bytes(values[key]))
        create_secret_resource(NEW_SECRETS['webhook'])
    finally:
        for value in values.values():
            for i in range(len(value)):value[i]=0
    save('startup-secrets.json',{'status':'PASSED','candidateOnly':True,'providerCapableOpenAiKey':False,'independentValues':True,'numericVersions':{k:int(v) for k,v in versions.items()},'webhookResourceEmpty':True})
    return versions

def create_identity_and_bindings():
    MUT['service_account_attempted']=True
    journal()
    gc(['iam','service-accounts','create','signmons-calldesk-p07-runtime','--project='+PROJECT,'--display-name=Signmons P07 isolated runtime','--quiet'],timeout=90)
    MUT['service_account_created']=True;journal()
    project_policy=gc(['projects','get-iam-policy',PROJECT,'--format=json'],json_out=True)
    if any(SA_MEMBER in b.get('members',[]) for b in project_policy.get('bindings',[])):raise Stop('SERVICE_ACCOUNT_PROJECT_ROLE_PRESENT')
    permission=json.loads(run([NODE,str(ROOT/'iam-actas-read.mjs')],timeout=60))
    if permission!={'actAs':True}:raise Stop('DEPLOYER_ACTAS_UNAVAILABLE')
    for name in [*NEW_SECRETS.values(),STRIPE_SECRET]:
        MUT['bindings'].append(name);journal()
        gc(['secrets','add-iam-policy-binding',name,'--project='+PROJECT,'--member='+SA_MEMBER,'--role=roles/secretmanager.secretAccessor','--condition=None','--quiet'],timeout=90)
        policy=gc(['secrets','get-iam-policy',name,'--project='+PROJECT,'--format=json'],json_out=True)
        if not any(b.get('role')=='roles/secretmanager.secretAccessor' and SA_MEMBER in b.get('members',[]) for b in policy.get('bindings',[])):raise Stop('SECRET_BINDING_READBACK_FAILED')
    save('identity-bindings.json',{'status':'PASSED','serviceIdentity':SERVICE_ACCOUNT,'projectRoles':0,'deployerActAs':True,'resourceSecretAccessorBindings':7,'serviceAccountKeyCreated':False})

def validate_destination(value):
    expected={'mode':'SANDBOX_TEST','enabledConnectedAccounts':1,'destinationName':'Signmons P07 same-job sandbox','connectedAccountsScope':True,'disabled':True,'urlExact':True,'eventHash':EVENT_HASH,'stableAccountDefaultApiVersion':True,'deliveryAttempts':0,'signingSecretCaptured':True}
    if value!=expected:raise Stop('STRIPE_DESTINATION_READBACK_DRIFT')

def add_webhook_version(secret):
    if not re.fullmatch(r'whsec_[A-Za-z0-9]{16,}',secret):raise Stop('WEBHOOK_SECRET_FORMAT')
    version=create_secret_resource_version(NEW_SECRETS['webhook'],secret.encode())
    save('webhook-secret.json',{'status':'PASSED','numericVersion':int(version),'destinationDisabled':True})
    return version

def create_secret_resource_version(name,value):
    MUT['secret_versions'][name]='UNKNOWN'
    journal()
    meta=gc(['secrets','versions','add',name,'--project='+PROJECT,'--data-file=-','--format=json'],input_bytes=value,timeout=90,json_out=True)
    match=re.search(r'/versions/(\d+)$',meta.get('name',''))
    if not match:raise Stop('SECRET_VERSION_UNKNOWN')
    version=match.group(1);MUT['secret_versions'][name]=version;journal()
    if gc(['secrets','versions','describe',version,'--secret='+name,'--project='+PROJECT,'--format=json'],json_out=True).get('state')!='ENABLED':raise Stop('SECRET_VERSION_NOT_ENABLED')
    return version

def deploy(db_version,startup_versions,webhook_version):
    secret_map={
      'DATABASE_URL':(NEW_SECRETS['database'],db_version),'STRIPE_SECRET_KEY':(STRIPE_SECRET,STRIPE_VERSION),
      'STRIPE_WEBHOOK_SECRET':(NEW_SECRETS['webhook'],webhook_version),'OPENAI_API_KEY':(NEW_SECRETS['openai'],startup_versions['openai']),
      'ADMIN_API_TOKEN':(NEW_SECRETS['admin'],startup_versions['admin']),'CONVERSATION_DATA_ENCRYPTION_KEY':(NEW_SECRETS['conversation'],startup_versions['conversation']),
      'TECHNICIAN_LINK_SECRET':(NEW_SECRETS['technician'],startup_versions['technician'])}
    env_arg=','.join(f'{k}={v}' for k,v in sorted(PLAIN_ENV.items()))
    secret_arg=','.join(f'{k}={name}:{version}' for k,(name,version) in sorted(secret_map.items()))
    MUT['deploy_attempted']=True
    journal()
    gc(['run','deploy',SERVICE,'--project='+PROJECT,'--region='+REGION,'--image='+IMAGE,'--revision-suffix='+SUFFIX,'--no-traffic','--tag='+TAG,'--service-account='+SERVICE_ACCOUNT,'--cpu=1','--memory=512Mi','--concurrency=40','--timeout=60','--max-instances=1','--min-instances=0','--ingress=all','--cpu-throttling','--cpu-boost','--set-env-vars='+env_arg,'--set-secrets='+secret_arg,'--quiet'],timeout=300)
    MUT['deployed']=True;journal()
    return secret_map

def env_map(revision):return {x.get('name'):x for x in revision.get('spec',{}).get('containers',[{}])[0].get('env',[])}

def deploy_readback(secret_map):
    service=gc(['run','services','describe',SERVICE,'--project='+PROJECT,'--region='+REGION,'--format=json'],json_out=True)
    rows=service.get('status',{}).get('traffic',[]); normal=[x for x in rows if x.get('percent')==100]; tagged=[x for x in rows if x.get('tag')==TAG]
    if len(normal)!=1 or normal[0].get('revisionName')!=NORMAL or len(tagged)!=1 or tagged[0].get('revisionName')!=REVISION or tagged[0].get('url')!=ORIGIN or tagged[0].get('percent',0)!=0:raise Stop('TRAFFIC_READBACK_MISMATCH')
    revision=gc(['run','revisions','describe',REVISION,'--project='+PROJECT,'--region='+REGION,'--format=json'],json_out=True)
    ready=next((x for x in revision.get('status',{}).get('conditions',[]) if x.get('type')=='Ready'),{})
    if revision.get('status',{}).get('imageDigest')!=IMAGE or ready.get('status')!='True':raise Stop('REVISION_READBACK_MISMATCH')
    require_envelope(runtime_shape(service,revision),SERVICE_ACCOUNT)
    env=env_map(revision)
    if set(env)!=set(PLAIN_ENV)|set(secret_map):raise Stop('INHERITED_ENVIRONMENT_PRESENT')
    for key,value in PLAIN_ENV.items():
        if env.get(key,{}).get('value')!=value:raise Stop('PLAIN_ENVIRONMENT_MISMATCH')
    for key,(name,version) in secret_map.items():
        ref=env.get(key,{}).get('valueFrom',{}).get('secretKeyRef',{})
        if ref.get('name')!=name or str(ref.get('key'))!=str(version):raise Stop('SECRET_REFERENCE_MISMATCH')
    codes=[run(['/usr/bin/curl','-sS','-o','/dev/null','-w','%{http_code}','--max-time','20',ORIGIN+path],timeout=30) for path in ['/health/liveness','/health/readiness']]
    if codes!=['200','200']:raise Stop('HEALTH_READBACK_FAILED')
    save('deployment-readback.json',{'status':'READY_NO_TRAFFIC','revision':REVISION,'imageDigestExact':True,'serviceIdentityExact':True,'normalRevision':NORMAL,'normalTrafficPercent':100,'targetTrafficPercent':0,'numericSecretReferences':7,'exactEnvironmentReplacement':True,'liveness':200,'readiness':200})

def close_role(password):
    result=run([NODE,str(ROOT/'db-closeout.mjs')],input_bytes=password.encode(),timeout=45)
    allowed={'P07_DATABASE_CLOSEOUT_VERIFIED_ABSENT','P07_DATABASE_CLOSEOUT_VERIFIED_UNCHANGED','P07_DATABASE_CLOSEOUT_VERIFIED_CHANGED'}
    if result not in allowed:raise Stop('ROLE_CLOSEOUT_FAILED')
    if not (ROOT/'role-closeout.json').exists():save('role-closeout.json',{'status':'CLOSED','roleAbsent':result.endswith('ABSENT'),'changedForContainment':result.endswith('CHANGED'),'roleLogin':False,'connectionLimit':0,'expired':True,'sessions':0})

def remove_tag():
    service=gc(['run','services','describe',SERVICE,'--project='+PROJECT,'--region='+REGION,'--format=json'],json_out=True)
    if any(x.get('tag')==TAG for x in service.get('status',{}).get('traffic',[])):
        gc(['run','services','update-traffic',SERVICE,'--project='+PROJECT,'--region='+REGION,'--remove-tags='+TAG,'--quiet'],timeout=180)
    service=gc(['run','services','describe',SERVICE,'--project='+PROJECT,'--region='+REGION,'--format=json'],json_out=True)
    verify_normal_traffic(service,tag_absent=True)

def disable_version(name,version):
    versions=[]
    if str(version).isdigit():versions=[str(version)]
    elif version=='UNKNOWN':
        rows=gc(['secrets','versions','list',name,'--project='+PROJECT,'--format=json'],json_out=True)
        versions=[m.group(1) for row in rows if (m:=re.search(r'/versions/(\d+)$',row.get('name','')))]
    else:raise Stop('SECRET_VERSION_RECONCILIATION')
    for item in versions:
        state=gc(['secrets','versions','describe',item,'--secret='+name,'--project='+PROJECT,'--format=json'],json_out=True).get('state')
        if state=='ENABLED':gc(['secrets','versions','disable',item,'--secret='+name,'--project='+PROJECT,'--quiet'],timeout=90)
        if gc(['secrets','versions','describe',item,'--secret='+name,'--project='+PROJECT,'--format=json'],json_out=True).get('state')!='DISABLED':raise Stop('SECRET_VERSION_CLOSEOUT')

def remove_binding(name):
    policy=gc(['secrets','get-iam-policy',name,'--project='+PROJECT,'--format=json'],json_out=True)
    if not any(SA_MEMBER in b.get('members',[]) for b in policy.get('bindings',[])):return
    gc(['secrets','remove-iam-policy-binding',name,'--project='+PROJECT,'--member='+SA_MEMBER,'--role=roles/secretmanager.secretAccessor','--condition=None','--quiet'],timeout=90)
    policy=gc(['secrets','get-iam-policy',name,'--project='+PROJECT,'--format=json'],json_out=True)
    if any(SA_MEMBER in b.get('members',[]) for b in policy.get('bindings',[])):raise Stop('SECRET_BINDING_CLOSEOUT')

def verify_normal_traffic(service,tag_absent=False):
    rows=service.get('status',{}).get('traffic')
    if not isinstance(rows,list) or not rows:raise Stop('TRAFFIC_READBACK_MISMATCH')
    if any(not isinstance(row,dict) for row in rows):raise Stop('TRAFFIC_READBACK_MISMATCH')
    normal=[row for row in rows if row.get('percent',0)!=0]
    if len(normal)!=1 or normal[0].get('percent')!=100 or normal[0].get('revisionName')!=NORMAL:raise Stop('TRAFFIC_READBACK_MISMATCH')
    if tag_absent and any(row.get('tag')==TAG for row in rows):raise Stop('TAG_CLOSEOUT_READBACK_FAILED')


def disable_identity():
    gc(['iam','service-accounts','disable',SERVICE_ACCOUNT,'--project='+PROJECT,'--quiet'],timeout=90)
    state=gc(['iam','service-accounts','describe',SERVICE_ACCOUNT,'--project='+PROJECT,'--format=json'],json_out=True)
    if not isinstance(state,dict) or state.get('email')!=SERVICE_ACCOUNT or state.get('disabled') is not True:raise Stop('SERVICE_IDENTITY_CLOSEOUT_READBACK_FAILED')


def failure_contain(password,binding=None,deadline=None):
    if deadline is None and binding:deadline=binding['_times'][3].timestamp()
    try:
        with phase_guard(deadline,cleanup=True):return _failure_contain(password,binding)
    except BaseException:return ['CONTAINMENT_DEADLINE_OR_INTERRUPTION']


def _failure_contain(password,binding=None):
    failures=[]
    try:close_role(password)
    except Exception:failures.append('ROLE_CLOSEOUT')
    if MUT['deploy_attempted']:
        try:remove_tag()
        except Exception:failures.append('REMOVE_TAG')
    for name,version in list(MUT['secret_versions'].items()):
        try:disable_version(name,version)
        except Exception:failures.append('DISABLE_'+name)
    for name in reversed(MUT['bindings']):
        try:remove_binding(name)
        except Exception:failures.append('REMOVE_BINDING_'+name)
    if MUT['service_account_attempted']:
        try:disable_identity()
        except Exception:failures.append('DISABLE_SERVICE_ACCOUNT')
    if MUT['stripe_destination'] and binding:
        try:wait_receipt('stripe-containment.json',lambda v: None if v=={'status':'ABSENT_OR_DISABLED_OR_DELETED','deliveryAttempts':0} else (_ for _ in ()).throw(Stop('STRIPE_CONTAINMENT_DRIFT')),_PHASE_DEADLINE if _PHASE_DEADLINE is not None else binding['_times'][3].timestamp())
        except Exception:failures.append('STRIPE_DESTINATION_CONTAINMENT')
    try:
        service=gc(['run','services','describe',SERVICE,'--project='+PROJECT,'--region='+REGION,'--format=json'],json_out=True);rows=service.get('status',{}).get('traffic',[])
        verify_normal_traffic(service,tag_absent=MUT['deploy_attempted'])
    except Exception:failures.append('TRAFFIC_READBACK')
    return sorted(set(failures))

def possible_mutation():return bool(MUT['role_attempted'] or MUT['secret_resources'] or MUT['service_account_attempted'] or MUT['bindings'] or MUT['stripe_destination'] or MUT['deploy_attempted'])

def run_operation(binding):
    with signal_guard():return _run_operation(binding)

def _run_operation(binding):
    if not os.isatty(0):print('P07_ATTENDED_TERMINAL_REQUIRED');return 2
    if start_state(time.time(),binding)=='WAIT':
        print('P07_WAITING_NO_EXTERNAL_ACTION',flush=True)
        while start_state(time.time(),binding)=='WAIT':time.sleep(1)
    start_state(time.time(),binding)
    save('attempt.json',{'status':'RESERVED_DO_NOT_RETRY','planId':PLAN,'packetId':PACKET,'operationId':OPERATION,'automaticRetryAllowed':False,'startedAtUtc':dt.datetime.now(dt.timezone.utc).isoformat()})
    journal()
    password='';webhook='';stage='PRIVATE_INPUT'
    try:
        with phase_guard(binding['_times'][2].timestamp()):
            password=private_input('Enter current CHILD administrator password (hidden): ')
            if not password:raise Stop('CHILD_PASSWORD_EMPTY')
            require_phase()
            stage='CLOUD_PREFLIGHT';cloud_preflight()
            print('P07_STRIPE_PREFLIGHT_READY',flush=True)
            wait_receipt('stripe-preflight.json',validate_stripe_preflight,binding['_times'][2].timestamp())
            require_phase()
            stage='DATABASE_PREFLIGHT';db_preflight(password)
            require_phase()
            stage='DATABASE_PROVISIONING';db_version=provision_database(password,binding)
            require_phase()
            stage='STARTUP_SECRET_PROVISIONING';startup_versions=provision_startup_secrets()
            require_phase()
            stage='IDENTITY_BINDINGS';create_identity_and_bindings()
            require_phase()
            MUT['stripe_destination']=True;journal()
            print('P07_STRIPE_DESTINATION_CREATE_DISABLED_READY',flush=True)
            require_phase()
            stage='STRIPE_DESTINATION';wait_receipt('stripe-destination.json',validate_destination,binding['_times'][2].timestamp())
            webhook=private_input('Paste the new disabled destination signing secret (hidden): ').strip()
            require_phase()
            stage='WEBHOOK_SECRET';webhook_version=add_webhook_version(webhook);webhook=''
            if dt.datetime.now(dt.timezone.utc)>=binding['_times'][2]:raise Stop('READINESS_WINDOW_CLOSED')
            require_phase()
            stage='DEPLOYMENT';secret_map=deploy(db_version,startup_versions,webhook_version)
            require_phase()
            stage='DEPLOYMENT_READBACK';deploy_readback(secret_map)
            require_phase()
            stage='ROLE_CLOSEOUT';close_role(password)
            require_phase()
            save('controller-result.json',{'status':'P07_REPAIRED_RUNTIME_READY_DISABLED','planId':PLAN,'operationId':OPERATION,'revisionReadyZeroTraffic':True,'normalTrafficPreserved':True,'destinationDisabled':True,'roleClosed':True,'newSecretVersions':6,'resourceBindings':7,'retirementDeadlineUtc':binding['retirementDeadlineUtc'],'automaticRetryAllowed':False})
        print('P07_REPAIRED_RUNTIME_READY_DISABLED',flush=True);return 0
    except BaseException as error:
        code=error.code if isinstance(error,Stop) else ('INTERRUPTED' if isinstance(error,(KeyboardInterrupt,SystemExit)) else 'UNCONFIRMED')
        failures=failure_contain(password,binding) if password else ['ROLE_CLOSEOUT_NOT_AVAILABLE']
        try:save('controller-stop.json',{'status':'P07_STOP_'+code,'stage':stage,'possibleMutation':possible_mutation(),'containmentFailures':failures,'automaticRetryAllowed':False})
        except Exception:failures.append('STOP_RECEIPT_PERSISTENCE')
        print('P07_STOP_'+code);print('CONTAINMENT_'+('VERIFIED' if not failures else 'UNCONFIRMED'));return 1
    finally:password='';webhook=''

def recovery_or_retirement(binding,retire=False):
    with signal_guard():return _recovery_or_retirement(binding,retire)

def _recovery_or_retirement(binding,retire=False):
    if not os.isatty(0):print('P07_ATTENDED_TERMINAL_REQUIRED');return 2
    marker='controller-result.json' if retire else 'attempt.json'
    if not (ROOT/marker).exists():print('P07_CLEANUP_NOT_APPLICABLE');return 2
    try:load_journal()
    except Stop as error:print('P07_REFUSED_'+error.code);return 2
    deadline=binding['_times'][5 if retire else 3].timestamp()
    password=''
    try:
        with phase_guard(deadline,cleanup=True):password=private_input('Enter current CHILD administrator password for cleanup (hidden): ')
        failures=failure_contain(password,binding,deadline=deadline)
    except BaseException:failures=['CLEANUP_INPUT_OR_DEADLINE']
    finally:password=''
    status='P07_RETIREMENT_VERIFIED' if retire and not failures else ('P07_RECOVERY_VERIFIED' if not failures else 'P07_MANDATORY_CLOSEOUT_UNCONFIRMED')
    try:save(('retirement-result.json' if retire else 'recovery-result.json'),{'status':status,'failures':failures})
    except Exception:status='P07_MANDATORY_CLOSEOUT_UNCONFIRMED'
    print(status);return 0 if status in {'P07_RETIREMENT_VERIFIED','P07_RECOVERY_VERIFIED'} else 1

def main():
    if sys.argv[1:]==['--check']:
        local_check(False);print('P07_PREPARATION_CHECK_PASSED_NO_ACTION');return 0
    if sys.argv[1:] not in [['--run'],['--recover'],['--retire']]:print('P07_USAGE_REFUSED');return 2
    try:binding=local_check(True)
    except Stop as error:print('P07_REFUSED_'+error.code);return 2
    if sys.argv[1:]==['--run']:return run_operation(binding)
    return recovery_or_retirement(binding,sys.argv[1:]==['--retire'])

if __name__=='__main__':raise SystemExit(main())
