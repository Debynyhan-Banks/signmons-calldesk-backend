#!/opt/homebrew/bin/python3
"""P08 disabled qualification controller; no payment/IAM/token/user write adapter."""
from __future__ import annotations
import datetime as dt
import getpass, hashlib, json, os, re, signal, subprocess, sys, time
from contextlib import contextmanager
from pathlib import Path
ROOT=Path(__file__).resolve().parent
_PHASE_DEADLINE=None
_CLEANING=False
class Stop(Exception):
    def __init__(self,code): self.code=code; super().__init__(code)

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

def save(name,value):
    p=ROOT/name
    fd=os.open(p,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
    with os.fdopen(fd,'w') as f:
        json.dump(value,f,indent=2,sort_keys=True); f.write('\n'); f.flush(); os.fsync(f.fileno())

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

def parse_utc(value):
    if not isinstance(value,str) or not value.endswith('Z'): raise Stop('WINDOW_BINDING_INVALID')
    try: return dt.datetime.fromisoformat(value[:-1]+'+00:00')
    except ValueError: raise Stop('WINDOW_BINDING_INVALID')

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

PLAN=json.loads((ROOT/'plan.json').read_text())
JOB=PLAN['jobId'];TENANT=PLAN['tenantId']
BACKEND=Path(PLAN['backend']);GOV=Path(PLAN['governance'])
NODE='/Users/debynyhanbanks/.nvm/versions/node/v24.12.0/bin/node'
PSQL='/opt/homebrew/opt/postgresql@16/bin/psql'
DB_HOST='ep-jolly-flower-ayc6w9hv.c-5.us-east-2.aws.neon.tech'
APPNAME='signmons_p08_qualification_'+PLAN['operationId'].replace('-','')
QUALIFICATION_SQL=f'''BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL statement_timeout='15s'; SET LOCAL lock_timeout='5s';
WITH j AS (SELECT "id","tenantId","status","deletedAt","updatedAt","calendarEventId","serviceWindowStart","serviceWindowEnd","policySnapshot","pricingSnapshot" FROM "Job" WHERE id='{JOB}'::uuid AND "tenantId"='{TENANT}'::uuid),
t AS (SELECT id,status,settings,"stripeConnectAccountId","chargesEnabled" FROM "TenantOrganization" WHERE id='{TENANT}'::uuid),
u AS (SELECT id,"tenantId",role,status FROM "User" WHERE "tenantId"='{TENANT}'::uuid AND status='ACTIVE' AND role IN ('OWNER','ADMIN'))
SELECT json_build_object('database',current_database(),'user',current_user,
 'jobCount',(SELECT count(*) FROM j),'job',(SELECT row_to_json(j) FROM j),
 'tenantCount',(SELECT count(*) FROM t),'tenant',(SELECT row_to_json(t) FROM t),
 'actorCount',(SELECT count(*) FROM u),'actors',(SELECT COALESCE(json_agg(x),'[]'::json) FROM (SELECT * FROM u ORDER BY id LIMIT 2) x),
 'paymentCount',(SELECT count(*) FROM "Payment" WHERE "jobId"='{JOB}'::uuid AND "tenantId"='{TENANT}'::uuid),
 'calendarCount',(SELECT count(*) FROM "CalendarOperation" WHERE "jobId"='{JOB}'::uuid AND "tenantId"='{TENANT}'::uuid),
 'roleCount',(SELECT count(*) FROM pg_roles WHERE rolname='p07_payment_runtime'),
 'roleClosed',COALESCE((SELECT NOT rolcanlogin AND rolconnlimit=0 AND rolvaliduntil<now() AND NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole AND NOT rolreplication AND NOT rolbypassrls AND NOT rolinherit FROM pg_roles WHERE rolname='p07_payment_runtime'),false),
 'roleMemberships',(SELECT count(*) FROM pg_auth_members WHERE member=(SELECT oid FROM pg_roles WHERE rolname='p07_payment_runtime')),
 'roleSessions',(SELECT count(*) FROM pg_stat_activity WHERE usename='p07_payment_runtime' AND backend_type='client backend'));
ROLLBACK;
'''
CLOSEOUT_SQL=f"BEGIN READ ONLY; SELECT count(*) FROM pg_stat_activity WHERE application_name='{APPNAME}' AND pid<>pg_backend_pid(); ROLLBACK;"

def file_sha(path):return hashlib.sha256(Path(path).read_bytes()).hexdigest()

def load_json(name):
    try:
        p=ROOT/name
        if p.is_symlink() or p.stat().st_mode&0o077:raise Stop('PRIVATE_FILE_MODE')
        return json.loads(p.read_text())
    except (OSError,json.JSONDecodeError):raise Stop('PRIVATE_FILE_INVALID')

def integrity():
    if ROOT.is_symlink() or ROOT.stat().st_mode&0o077:raise Stop('PRIVATE_DIRECTORY_MODE')
    m=load_json('manifest.json')
    if m.get('operationId')!=PLAN['operationId']:raise Stop('MANIFEST_OPERATION')
    for n,digest in m['files'].items():
        if not re.fullmatch(r'[A-Za-z0-9_.-]+',n) or file_sha(ROOT/n)!=digest:raise Stop('SOURCE_INTEGRITY')
        load_path=ROOT/n
        if load_path.is_symlink() or load_path.stat().st_mode&0o077:raise Stop('PRIVATE_FILE_MODE')
    for n,digest in (PLAN['sourceHashes']|PLAN.get('compiledHashes',{})).items():
        if file_sha(BACKEND/n)!=digest:raise Stop('APPLICATION_SOURCE_DRIFT')
    return m

def check_binding(binding,approval,now=None):
    now=time.time() if now is None else now
    expected={'operationId':PLAN['operationId'],'planId':PLAN['planId'],'packetId':PLAN['packetId'],'mode':'READ_ONLY_QUALIFICATION','automaticRetryAllowed':False,'actions':PLAN['readOnlyActions']}
    if not isinstance(binding,dict) or set(binding)!=set(expected)|{'startUtc','cutoffUtc','workEndUtc','closeoutEndUtc','manifestSha256','proposalCommit','proposalSha256'}:raise Stop('WINDOW_NOT_BOUND')
    if any(binding[k]!=v for k,v in expected.items()):raise Stop('BINDING_DRIFT')
    if not re.fullmatch(r'[a-f0-9]{40}',str(binding['proposalCommit'])) or not re.fullmatch(r'[a-f0-9]{64}',str(binding['proposalSha256'])):raise Stop('PROPOSAL_NOT_BOUND')
    values=[parse_utc(binding[k]).timestamp() for k in ['startUtc','cutoffUtc','workEndUtc','closeoutEndUtc']]
    if not values[0]<values[1]<values[2]<values[3]<=parse_utc(PLAN['retirementDeadlineUtc']).timestamp():raise Stop('WINDOW_ORDER')
    if values[3]-values[0]>3600:raise Stop('QUALIFICATION_WINDOW_LIMIT')
    expected_approval={'decision':'APPROVED','owner':'Debynyhan Banks','operationId':PLAN['operationId'],'mode':'READ_ONLY_QUALIFICATION','bindingSha256':hashlib.sha256(json.dumps(binding,sort_keys=True,separators=(',',':')).encode()).hexdigest(),'manifestSha256':binding['manifestSha256'],'automaticRetryAllowed':False,'actions':PLAN['readOnlyActions']}
    if not isinstance(approval,dict):raise Stop('OWNER_APPROVAL_INVALID')
    actual=dict(approval);approved_at=actual.pop('approvedAtUtc',None)
    if actual!=expected_approval or parse_utc(approved_at).timestamp()>min(now,values[1]):raise Stop('OWNER_APPROVAL_INVALID')
    if now<values[0]:raise Stop('NOT_YET_START')
    if now>=values[1]:raise Stop('START_CUTOFF')
    return values

def verify_live_governance(binding):
    name='APP013_P08_READ_ONLY_QUALIFICATION_OPERATION_20261022.md'
    for repo in [BACKEND,GOV]:
        if run(['/usr/bin/git','status','--porcelain'],cwd=repo,timeout=15):raise Stop('CHECKOUT_DIRTY')
    proposal=run_status(['/usr/bin/git','show',binding['proposalCommit']+':'+name],cwd=GOV,timeout=15)
    if proposal.returncode or hashlib.sha256(proposal.stdout).hexdigest()!=binding['proposalSha256']:raise Stop('IMMUTABLE_PROPOSAL_DRIFT')
    source=run_status(['/usr/bin/git','show',PLAN['localApprovalCommit']+':APP013_P08_OPERATOR_ACCESS_PREPARATION_PROPOSAL_20261022.md'],cwd=GOV,timeout=15)
    if source.returncode or hashlib.sha256(source.stdout).hexdigest()!=PLAN['localApprovalProposalSha256']:raise Stop('LOCAL_APPROVAL_SOURCE_DRIFT')

def node_json(args,payload):
    result=run_status([NODE,str(ROOT/'operator-bridge.mjs'),*args],input_bytes=json.dumps(payload).encode(),timeout=30)
    try:value=json.loads(result.stdout.decode('utf-8','strict'))
    except (ValueError,UnicodeError):raise Stop('NODE_OUTPUT_INVALID')
    if result.returncode or value.get('status')=='REFUSED':
        code=value.get('code','NODE_HELPER_FAILED')
        raise Stop(code if isinstance(code,str) and re.fullmatch(r'[A-Z][A-Z0-9_]{1,63}',code) else 'NODE_HELPER_FAILED')
    return value

def normalize_database(raw):
    try:payload=json.loads(raw)
    except (ValueError,TypeError):raise Stop('DATABASE_OUTPUT_INVALID')
    value=node_json(['--normalize'],payload)
    if value.get('status')!='QUALIFIED_DATABASE':raise Stop('DATABASE_CONTRACT')
    return value

def attended_input(prompt):
    import warnings
    if not os.isatty(0):raise Stop('ATTENDED_TERMINAL_REQUIRED')
    with warnings.catch_warnings():
        warnings.simplefilter('error',getpass.GetPassWarning)
        try:return private_input(prompt)
        except getpass.GetPassWarning:raise Stop('HIDDEN_INPUT_UNAVAILABLE')

def psql_read(password,sql):
    if sql not in (QUALIFICATION_SQL,CLOSEOUT_SQL,OPERATOR_DIAGNOSTIC_SQL):raise Stop('SQL_NOT_ALLOWLISTED')
    env={k:v for k,v in os.environ.items() if not k.startswith('PG') and k!='DATABASE_URL'}
    env.update({'PGPASSWORD':password,'PGSSLMODE':'verify-full','PGSSLROOTCERT':'/etc/ssl/cert.pem','PGCONNECT_TIMEOUT':'10','PGAPPNAME':APPNAME,'PGOPTIONS':'-c statement_timeout=15000 -c lock_timeout=5000'})
    try:
        timeout=min(25,require_phase() or 25)
        try:result=subprocess.run([PSQL,'-X','-q','-A','-t','-v','ON_ERROR_STOP=1','-h',DB_HOST,'-U','neondb_owner','-d','neondb','-c',sql],env=env,stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=timeout,check=False)
        except subprocess.TimeoutExpired:raise Stop('DATABASE_COMMAND_TIMEOUT')
        require_phase()
        if result.returncode:raise Stop('DATABASE_READ_COMMAND_FAILED')
        return result.stdout.decode('utf-8','strict').strip()
    finally:env['PGPASSWORD']=''

def cloud_read():
    gc='/opt/homebrew/bin/gcloud'
    service=json.loads(run([gc,'run','services','describe','signmons-calldesk-staging','--project=signmons','--account=debynyhan@signmons.com','--region=us-east5','--format=json'],json_out=False,timeout=40))
    revision=json.loads(run([gc,'run','revisions','describe',PLAN['candidate'],'--project=signmons','--account=debynyhan@signmons.com','--region=us-east5','--format=json'],timeout=40))
    policy=json.loads(run([gc,'projects','get-iam-policy','signmons','--account=debynyhan@signmons.com','--format=json'],timeout=30))
    return classify_cloud(service,revision,policy)

def classify_cloud(service,revision,policy):
    try:
        traffic=service['status']['traffic'];normal=[x for x in traffic if x.get('percent',0)>0];tagged=[x for x in traffic if x.get('tag')==PLAN['tag']]
        if len(normal)!=1 or normal[0].get('revisionName')!=PLAN['normalRevision'] or normal[0].get('percent')!=100 or len(tagged)!=1 or tagged[0].get('revisionName')!=PLAN['candidate'] or tagged[0].get('url')!=PLAN['origin'] or tagged[0].get('percent',0)!=0:raise Stop('TRAFFIC_DRIFT')
        require_envelope(runtime_shape(service,revision),PLAN['serviceIdentity'])
        spec=revision['spec'];container=spec['containers'][0];env={x['name']:x for x in container['env']}
        required={'NODE_ENV':'production','GOOGLE_CLOUD_PROJECT':'signmons','DEV_AUTH_ENABLED':'false','SCHEDULING_ENABLED':'false','STRIPE_WEBHOOK_LIVEMODE':'false','SMS_DELIVERY_ENABLED':'false','BACKGROUND_WORKERS_ENABLED':'false','STAGING_PHONE_TEST_ENABLED':'false','ENABLED_TOOLS':'none','WEBCHAT_INTEGRATIONS_JSON':'[]','TWILIO_TENANT_IDENTITIES_JSON':'[]'}
        pins={'DATABASE_URL':'signmons-staging-p07-payment-database-url','STRIPE_SECRET_KEY':'signmons-staging-stripe-secret-key','STRIPE_WEBHOOK_SECRET':'signmons-staging-p07-stripe-webhook-secret','OPENAI_API_KEY':'signmons-staging-p07-disabled-openai-key','ADMIN_API_TOKEN':'signmons-staging-p07-admin-token','CONVERSATION_DATA_ENCRYPTION_KEY':'signmons-staging-p07-conversation-key','TECHNICIAN_LINK_SECRET':'signmons-staging-p07-technician-link-key'}
        if set(env)!=set(required)|set(pins)|{'CUSTOMER_PAYMENT_RETURN_URL'}:raise Stop('ENVIRONMENT_DRIFT')
        if any(env[k].get('value')!=v for k,v in required.items()):raise Stop('SAFETY_FLAG_DRIFT')
        from urllib.parse import urlsplit
        returned=urlsplit(env['CUSTOMER_PAYMENT_RETURN_URL'].get('value',''))
        if returned.scheme!='https' or not returned.hostname or returned.username or returned.password or returned.query or returned.fragment:raise Stop('RETURN_URL_DRIFT')
        for k,v in pins.items():
            if env[k].get('valueFrom',{}).get('secretKeyRef')!={'name':v,'key':'1'}:raise Stop('SECRET_PIN_DRIFT')
        if spec.get('serviceAccountName')!=PLAN['serviceIdentity'] or revision['status'].get('imageDigest')!=PLAN['image']:raise Stop('RUNTIME_IDENTITY_DRIFT')
        if not any(x.get('type')=='Ready' and x.get('status')=='True' for x in revision['status']['conditions']):raise Stop('REVISION_NOT_READY')
        member='serviceAccount:'+PLAN['serviceIdentity'];roles=[x['role'] for x in policy.get('bindings',[]) if member in x.get('members',[])]
        return {'status':'CLOUD_METADATA_MATCH','normalTrafficPercent':100,'candidateTrafficPercent':0,'numericSecretReferences':7,'candidateProjectRoles':sorted(roles),'effectiveFirebaseLookup':'NOT_ESTABLISHED','inheritedAccess':'UNQUALIFIED','authenticatedHttpRead':'NOT_ATTEMPTED'}
    except (KeyError,TypeError,ValueError):raise Stop('CLOUD_OUTPUT_INVALID')

def firebase_read(database):
    # This CLI branch has no token issuance or user mutation code.
    actor=database['actorId'];role=database['actorRole']
    return classify_firebase(node_json(['--firebase-read'],{'actorId':actor,'actorRole':role}),actor)

def classify_firebase(v,actor):
    if not re.fullmatch(r'[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}',actor):raise Stop('ACTOR_UUID_REQUIRED')
    if v=={'exists':False}:return {'status':'ISOLATED_IDENTITY_REQUIRED','identityAbsent':True,'identityChanged':False}
    if set(v)!={'exists','uidMatches','disabled','tenantMatches','roleAllowed','stagingOnly','claimsExact'} or any(v[k] is not True for k in v):raise Stop('FIREBASE_IDENTITY_COLLISION')
    return {'status':'ISOLATED_DISABLED_IDENTITY_MATCH','identityAbsent':False,'identityChanged':False}

def validate_stripe(v):
    expected={'operationId':PLAN['operationId'],'mode':'SANDBOX_TEST','accountAdmin':True,'enabledConnectedAccounts':1,'connectedAccountSha256':PLAN['connectedAccountSha256'],'destinationDisabled':True,'deliveryAttempts':0,'urlExact':True,'eventHash':PLAN['stripeEventHash'],'apiVersion':PLAN['stripeApiVersion'],'connectedAccountsScope':True}
    if v!=expected:raise Stop('STRIPE_READBACK_DRIFT')
    return v

def wait_stripe():
    print('P08_STRIPE_QUALIFICATION_READY',flush=True)
    while True:
        require_phase()
        if (ROOT/'stripe-readback.json').exists():return validate_stripe(load_json('stripe-readback.json'))
        time.sleep(.5)

def qualify(binding,approval,adapter=None):
    values=check_binding(binding,approval)
    if binding['manifestSha256']!=file_sha(ROOT/'manifest.json'):raise Stop('MANIFEST_BINDING')
    adapter=adapter or {'input':attended_input,'cloud':cloud_read,'database':lambda p:normalize_database(psql_read(p,QUALIFICATION_SQL)),'firebase':firebase_read,'stripe':wait_stripe,'closeout':lambda p:psql_read(p,CLOSEOUT_SQL)=='0'}
    password='';stage='PRIVATE_INPUT';closed=False
    save('qualification-attempt.json',{'status':'RESERVED_DO_NOT_RETRY','operationId':PLAN['operationId'],'automaticRetryAllowed':False,'startedAtUtc':dt.datetime.now(dt.timezone.utc).isoformat().replace('+00:00','Z')})
    with signal_guard():
        try:
            with phase_guard(values[2]):
                password=adapter['input']('Enter current CHILD administrator password for read-only qualification (hidden): ')
                if not password:raise Stop('PASSWORD_EMPTY')
                stage='CLOUD_METADATA';cloud=adapter['cloud']();require_phase()
                stage='STRIPE_READBACK';stripe=adapter['stripe']();require_phase()
                stage='DATABASE_READ';database=adapter['database'](password);require_phase()
                save('database-qualification-private.json',database)
                stage='FIREBASE_READ';firebase=adapter['firebase'](database);require_phase()
            with phase_guard(values[3],cleanup=True):closed=adapter['closeout'](password);require_phase()
            if not closed:raise Stop('SESSION_CLOSEOUT')
            save('qualification-result.json',{'status':'P08_READ_ONLY_OPERATOR_QUALIFICATION_COMPLETE','operationId':PLAN['operationId'],'cloud':cloud,'stripe':stripe,'database':database,'firebase':firebase,'businessMutation':False,'sessionsAbsent':True,'paymentAuthorized':False,'automaticRetryAllowed':False})
            return 'P08_READ_ONLY_OPERATOR_QUALIFICATION_COMPLETE'
        except BaseException as e:
            code=e.code if isinstance(e,Stop) else 'UNCONFIRMED'
            if password and not closed:
                try:
                    with phase_guard(values[3],cleanup=True):closed=bool(adapter['closeout'](password));require_phase()
                except BaseException:closed=False
            save('qualification-stop.json',{'status':'P08_QUALIFICATION_STOP_'+code,'stage':stage,'businessMutation':False,'sessionsAbsent':closed,'automaticRetryAllowed':False})
            return 'P08_QUALIFICATION_STOP_'+code+'\nCONTAINMENT_'+('VERIFIED' if closed else 'UNCONFIRMED')
        finally:password=''

def model_payment_operation(actions,cleanup,work_end,cleanup_end):
    """Local injected adapters only; intentionally has no CLI/live counterpart."""
    completed=[];failure=None;residual=[]
    with signal_guard():
        try:
            with phase_guard(work_end):
                for name,action in actions:
                    require_phase();action();require_phase();completed.append(name)
        except BaseException as e:failure=e.code if isinstance(e,Stop) else 'UNCONFIRMED'
        for name,action in cleanup:
            try:
                with phase_guard(cleanup_end,cleanup=True):action();require_phase()
            except BaseException:residual.append(name)
    return {'completed':completed,'failure':failure,'containmentVerified':not residual,'residual':residual}

def readonly_closeout(binding,approval,adapter=None):
    attempt=load_json('qualification-attempt.json')
    if attempt.get('operationId')!=PLAN['operationId']:raise Stop('CLOSEOUT_OPERATION')
    begun=parse_utc(attempt['startedAtUtc']).timestamp()
    limits=check_binding(binding,approval,begun)
    if (ROOT/'qualification-result.json').exists():raise Stop('ALREADY_CLOSED_NO_ACTION')
    if time.time()>=limits[3]:raise Stop('CLOSEOUT_DEADLINE')
    adapter=adapter or {'input':attended_input,'closeout':lambda p:psql_read(p,CLOSEOUT_SQL)=='0'}
    save('closeout-attempt.json',{'operationId':PLAN['operationId'],'mode':'READ_ONLY_SESSION_CLOSEOUT','automaticRetryAllowed':False})
    password='';closed=False;code=None
    with signal_guard():
        try:
            with phase_guard(limits[3],cleanup=True):
                password=adapter['input']('Enter current CHILD administrator password for read-only closeout (hidden): ')
                if not password:raise Stop('PASSWORD_EMPTY')
                closed=bool(adapter['closeout'](password));require_phase()
        except BaseException as e:code=e.code if isinstance(e,Stop) else 'UNCONFIRMED'
        finally:password=''
    status='P08_READ_ONLY_CLOSEOUT_VERIFIED' if closed else 'P08_MANDATORY_CLOSEOUT_UNCONFIRMED'
    save('closeout-result.json',{'status':status,'operationId':PLAN['operationId'],'sessionsAbsent':closed,'failure':code,'businessMutation':False,'automaticRetryAllowed':False})
    return status

OPERATOR_DIAGNOSTIC_SQL=f'''BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL statement_timeout='15s'; SET LOCAL lock_timeout='5s';
WITH t AS (SELECT id,status FROM "TenantOrganization" WHERE id='{TENANT}'::uuid),
u AS (SELECT id,"tenantId",role,status FROM "User" WHERE "tenantId"='{TENANT}'::uuid AND status='ACTIVE' AND role IN ('OWNER','ADMIN') AND EXISTS (SELECT 1 FROM t WHERE status='ACTIVE'))
SELECT json_build_object('database',current_database(),'user',current_user,
 'tenantCount',(SELECT count(*) FROM t),'tenantStatus',(SELECT max(status::text) FROM t),
 'actorCount',(SELECT count(*) FROM u),'actors',(SELECT COALESCE(json_agg(x),'[]'::json) FROM (SELECT * FROM u ORDER BY id LIMIT 2) x),
 'truncated',(SELECT count(*)>2 FROM u));
ROLLBACK;
'''

def normalize_operator_diagnostic(raw):
    invalid={'classification':'INVALID_OUTPUT','eligibleCount':None,'candidates':[],'truncated':False,'reason':'OPERATOR_DIAGNOSTIC_OUTPUT_INVALID'}
    try:
        if not isinstance(raw,str) or len(raw.encode())>16384:return invalid
        v=json.loads(raw)
        if not isinstance(v,dict) or set(v)!={'database','user','tenantCount','tenantStatus','actorCount','actors','truncated'}:return invalid
        if v['database']!='neondb' or v['user']!='neondb_owner' or type(v['tenantCount']) is not int or v['tenantCount']!=1 or v['tenantStatus']!='ACTIVE':return invalid
        count=v['actorCount'];rows=v['actors']
        if type(count) is not int or not 0<=count<=9007199254740991 or not isinstance(rows,list) or len(rows)!=min(count,2) or type(v['truncated']) is not bool or v['truncated']!=(count>2):return invalid
        ids=[]
        for row in rows:
            if not isinstance(row,dict) or set(row)!={'id','tenantId','role','status'}:return invalid
            if not isinstance(row['id'],str) or not re.fullmatch(r'[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}',row['id']):return invalid
            if row['tenantId']!=TENANT or row['role'] not in ('OWNER','ADMIN') or row['status']!='ACTIVE':return invalid
            ids.append(row['id'])
        if ids!=sorted(set(ids)):return invalid
        classification='ZERO_ELIGIBLE' if count==0 else 'ONE_ELIGIBLE' if count==1 else 'MULTIPLE_ELIGIBLE'
        return {'classification':classification,'eligibleCount':count,'candidates':rows,'truncated':v['truncated'],'reason':None}
    except (ValueError,TypeError,UnicodeError):return invalid

def operator_public_projection(value):
    return {'classification':value['classification'],'eligibleCount':value['eligibleCount'],'truncated':value['truncated'],'candidateHashes':[hashlib.sha256(row['id'].encode()).hexdigest() for row in value['candidates']],'reason':value['reason']}

def check_operator_binding(binding,approval,now=None):
    now=time.time() if now is None else now
    expected={'operationId':PLAN['operationId'],'planId':PLAN['planId'],'packetId':PLAN['packetId'],'mode':'READ_ONLY_OPERATOR_DIAGNOSTIC','automaticRetryAllowed':False,'actions':PLAN['operatorDiagnosticActions'],'privateRetentionEndUtc':PLAN['retirementDeadlineUtc']}
    if not isinstance(binding,dict) or set(binding)!=set(expected)|{'startUtc','cutoffUtc','workEndUtc','closeoutEndUtc','manifestSha256','proposalCommit','proposalSha256'}:raise Stop('OPERATOR_WINDOW_NOT_BOUND')
    if any(binding[k]!=v for k,v in expected.items()):raise Stop('OPERATOR_BINDING_DRIFT')
    if not re.fullmatch(r'[a-f0-9]{40}',str(binding['proposalCommit'])) or not re.fullmatch(r'[a-f0-9]{64}',str(binding['proposalSha256'])):raise Stop('OPERATOR_PROPOSAL_NOT_BOUND')
    values=[parse_utc(binding[k]).timestamp() for k in ['startUtc','cutoffUtc','workEndUtc','closeoutEndUtc']]
    if not values[0]<values[1]<values[2]<values[3]<=parse_utc(PLAN['retirementDeadlineUtc']).timestamp():raise Stop('OPERATOR_WINDOW_ORDER')
    if values[3]-values[0]>3600:raise Stop('OPERATOR_WINDOW_LIMIT')
    expected_approval={'decision':'APPROVED','owner':'Debynyhan Banks','operationId':PLAN['operationId'],'mode':'READ_ONLY_OPERATOR_DIAGNOSTIC','bindingSha256':hashlib.sha256(json.dumps(binding,sort_keys=True,separators=(',',':')).encode()).hexdigest(),'manifestSha256':binding['manifestSha256'],'automaticRetryAllowed':False,'actions':PLAN['operatorDiagnosticActions']}
    if not isinstance(approval,dict):raise Stop('OPERATOR_APPROVAL_INVALID')
    actual=dict(approval);approved_at=actual.pop('approvedAtUtc',None)
    if actual!=expected_approval or parse_utc(approved_at).timestamp()>min(now,values[1]):raise Stop('OPERATOR_APPROVAL_INVALID')
    if now<values[0]:raise Stop('OPERATOR_NOT_YET_START')
    if now>=values[1]:raise Stop('OPERATOR_START_CUTOFF')
    return values

def verify_operator_governance(binding):
    for repo in [BACKEND,GOV]:
        if run(['/usr/bin/git','status','--porcelain'],cwd=repo,timeout=15):raise Stop('CHECKOUT_DIRTY')
    proposal=run_status(['/usr/bin/git','show',binding['proposalCommit']+':APP013_P08_OPERATOR_DIAGNOSTIC_OPERATION_20261022.md'],cwd=GOV,timeout=15)
    if proposal.returncode or hashlib.sha256(proposal.stdout).hexdigest()!=binding['proposalSha256']:raise Stop('OPERATOR_IMMUTABLE_PROPOSAL_DRIFT')
    preparation=PLAN['operatorDiagnosticPreparation']
    source=run_status(['/usr/bin/git','show',preparation['decisionCommit']+':'+preparation['decisionDocument']],cwd=GOV,timeout=15)
    if source.returncode or hashlib.sha256(source.stdout).hexdigest()!=preparation['decisionDocumentSha256']:raise Stop('OPERATOR_LOCAL_APPROVAL_DRIFT')

def operator_diagnostic(binding,approval,adapter=None):
    limits=check_operator_binding(binding,approval)
    if binding['manifestSha256']!=file_sha(ROOT/'manifest.json'):raise Stop('OPERATOR_MANIFEST_BINDING')
    adapter=adapter or {'input':attended_input,'database':lambda password:psql_read(password,OPERATOR_DIAGNOSTIC_SQL),'closeout':lambda password:psql_read(password,CLOSEOUT_SQL)=='0'}
    save('operator-diagnostic-attempt.json',{'operationId':PLAN['operationId'],'startedAtUtc':dt.datetime.now(dt.timezone.utc).isoformat().replace('+00:00','Z'),'status':'RESERVED_DO_NOT_RETRY','automaticRetryAllowed':False})
    password='';stage='PRIVATE_INPUT';closed=False
    with signal_guard():
        try:
            with phase_guard(limits[2]):
                password=adapter['input']('Enter current CHILD administrator password for read-only operator diagnostic (hidden): ')
                if not password:raise Stop('PASSWORD_EMPTY')
                stage='OPERATOR_DATABASE_READ';raw=adapter['database'](password);require_phase()
                value=normalize_operator_diagnostic(raw);raw=''
                if value['candidates']:
                    save('operator-diagnostic-private.json',{'operationId':PLAN['operationId'],'retentionDeadlineUtc':PLAN['retirementDeadlineUtc'],'diagnostic':value})
                public=operator_public_projection(value);value={}
            with phase_guard(limits[3],cleanup=True):closed=bool(adapter['closeout'](password));require_phase()
            if not closed:raise Stop('OPERATOR_SESSION_CLOSEOUT')
            status='P08_OPERATOR_DIAGNOSTIC_'+('INVALID_OUTPUT' if public['classification']=='INVALID_OUTPUT' else 'COMPLETE_'+public['classification'])
            save('operator-diagnostic-result.json',{'status':status,'operationId':PLAN['operationId'],'diagnostic':public,'sessionsAbsent':True,'businessMutation':False,'operatorSelected':False,'paymentAuthorized':False,'automaticRetryAllowed':False,'privateRetentionEndUtc':PLAN['retirementDeadlineUtc']})
            return status+'\nCONTAINMENT_VERIFIED'
        except BaseException as e:
            code=e.code if isinstance(e,Stop) else 'UNCONFIRMED'
            if password and not closed:
                try:
                    with phase_guard(limits[3],cleanup=True):closed=bool(adapter['closeout'](password));require_phase()
                except BaseException:closed=False
            save('operator-diagnostic-stop.json',{'status':'P08_OPERATOR_DIAGNOSTIC_STOP_'+code,'operationId':PLAN['operationId'],'stage':stage,'sessionsAbsent':closed,'businessMutation':False,'automaticRetryAllowed':False})
            return 'P08_OPERATOR_DIAGNOSTIC_STOP_'+code+'\nCONTAINMENT_'+('VERIFIED' if closed else 'UNCONFIRMED')
        finally:password=''

def operator_diagnostic_closeout(binding,approval,adapter=None):
    attempt=load_json('operator-diagnostic-attempt.json')
    if attempt.get('operationId')!=PLAN['operationId']:raise Stop('OPERATOR_CLOSEOUT_OPERATION')
    limits=check_operator_binding(binding,approval,parse_utc(attempt['startedAtUtc']).timestamp())
    if (ROOT/'operator-diagnostic-result.json').exists():raise Stop('OPERATOR_ALREADY_CLOSED_NO_ACTION')
    if time.time()>=limits[3]:raise Stop('OPERATOR_CLOSEOUT_DEADLINE')
    adapter=adapter or {'input':attended_input,'closeout':lambda password:psql_read(password,CLOSEOUT_SQL)=='0'}
    save('operator-diagnostic-closeout-attempt.json',{'operationId':PLAN['operationId'],'automaticRetryAllowed':False})
    password='';closed=False;code=None
    with signal_guard():
        try:
            with phase_guard(limits[3],cleanup=True):
                password=adapter['input']('Enter current CHILD administrator password for read-only diagnostic closeout (hidden): ')
                if not password:raise Stop('PASSWORD_EMPTY')
                closed=bool(adapter['closeout'](password));require_phase()
        except BaseException as e:code=e.code if isinstance(e,Stop) else 'UNCONFIRMED'
        finally:password=''
    status='P08_OPERATOR_DIAGNOSTIC_CLOSEOUT_VERIFIED' if closed else 'P08_OPERATOR_DIAGNOSTIC_CLOSEOUT_UNCONFIRMED'
    save('operator-diagnostic-closeout-result.json',{'status':status,'operationId':PLAN['operationId'],'sessionsAbsent':closed,'failure':code,'businessMutation':False,'automaticRetryAllowed':False})
    return status

def purge_operator_private():
    path=ROOT/'operator-diagnostic-private.json'
    if path.is_symlink():raise Stop('OPERATOR_PRIVATE_SYMLINK')
    if not path.exists():return 'P08_OPERATOR_PRIVATE_ALREADY_ABSENT'
    receipt=load_json('operator-diagnostic-private.json')
    if not isinstance(receipt,dict) or set(receipt)!={'operationId','retentionDeadlineUtc','diagnostic'} or receipt['operationId']!=PLAN['operationId'] or receipt['retentionDeadlineUtc']!=PLAN['retirementDeadlineUtc']:raise Stop('OPERATOR_PRIVATE_RECEIPT_DRIFT')
    if (ROOT/'operator-private-retirement.json').exists():raise Stop('OPERATOR_PRIVATE_RETIREMENT_COLLISION')
    projection=operator_public_projection(receipt['diagnostic']);path.unlink()
    if path.exists() or path.is_symlink():raise Stop('OPERATOR_PRIVATE_REMOVAL_UNCONFIRMED')
    save('operator-private-retirement.json',{'status':'P08_OPERATOR_PRIVATE_RETIRED','operationId':PLAN['operationId'],'retiredAtUtc':dt.datetime.now(dt.timezone.utc).isoformat().replace('+00:00','Z'),'privateReceiptAbsent':True,'diagnostic':projection,'externalAction':False})
    return 'P08_OPERATOR_PRIVATE_RETIRED'

def main():
    args=sys.argv[1:]
    if args==['--run']:print('P08_PAYMENT_BINDING_REQUIRED_NO_ACTION');return 2
    if args not in (['--check'],['--qualify'],['--authorize-helper'],['--closeout'],['--operator-diagnostic'],['--operator-diagnostic-closeout'],['--purge-operator-private']):print('P08_USAGE_REFUSED');return 2
    try:
        integrity()
        if args==['--check']:print('P08_LOCAL_PREPARATION_CHECK_PASSED_NO_ACTION');return 0
        if args==['--purge-operator-private']:print(purge_operator_private());return 0
        if args in (['--operator-diagnostic'],['--operator-diagnostic-closeout']):
            if not (ROOT/'operator-diagnostic-binding.json').exists():raise Stop('OPERATOR_WINDOW_NOT_BOUND')
            binding=load_json('operator-diagnostic-binding.json');approval=load_json('operator-diagnostic-owner-approval.json')
            if args==['--operator-diagnostic']:check_operator_binding(binding,approval)
            verify_operator_governance(binding)
            if not os.isatty(0):raise Stop('ATTENDED_TERMINAL_REQUIRED')
            print(operator_diagnostic(binding,approval) if args==['--operator-diagnostic'] else operator_diagnostic_closeout(binding,approval));return 0
        if not (ROOT/'binding.json').exists():raise Stop('WINDOW_NOT_BOUND')
        binding=load_json('binding.json');approval=load_json('owner-approval.json')
        if args==['--authorize-helper']:
            attempt=load_json('qualification-attempt.json')
            if attempt.get('operationId')!=PLAN['operationId'] or (ROOT/'qualification-result.json').exists() or (ROOT/'qualification-stop.json').exists():raise Stop('HELPER_ATTEMPT')
            verify_live_governance(binding)
            begun=parse_utc(attempt['startedAtUtc']).timestamp()
            limits=check_binding(binding,approval,begun)
            if time.time()>=limits[2] or binding['manifestSha256']!=file_sha(ROOT/'manifest.json'):raise Stop('HELPER_DEADLINE')
            print('P08_HELPER_READ_AUTHORITY_MATCH');return 0
        if args==['--closeout']:
            verify_live_governance(binding)
            if not os.isatty(0):raise Stop('ATTENDED_TERMINAL_REQUIRED')
            print(readonly_closeout(binding,approval));return 0
        check_binding(binding,approval)
        verify_live_governance(binding)
        if not os.isatty(0):raise Stop('ATTENDED_TERMINAL_REQUIRED')
        print(qualify(binding,approval));return 0
    except Stop as e:print('P08_REFUSED_'+e.code);return 2
    except BaseException:print('P08_STOP_UNCONFIRMED');return 1

if __name__=='__main__':raise SystemExit(main())
