from pathlib import Path
import sys,json,copy,hashlib
B=Path('/Users/debynyhanbanks/Web Projects/signmons-backend-r08-recovery');G=Path('/Users/debynyhanbanks/Web Projects/signmons-governance-r08-recovery');S=B/'evidence/APP-013/p08-https-output-category-local-20261029/source';sys.path.insert(0,str(S))
import qualification_launch as q

def construct(spec, endpoint_id):
    root=Path('/private/tmp/p08-binding-recovery-'+spec['recoveryId'])
    cap=q.BindingRecoveryCapability(q.private_json(root/'guard-envelope.json'),mode='handoff')
    values=q.read_recovered_bindings(cap)
    q.need(spec['qualificationId']==cap.e['qualificationId'] and spec['prospectiveOperationId']==cap.e['nativeOperationId'] and spec['sourceCommit']==cap.e['sourceCommit'], 'PACKET_OPERATION_BINDING')
    return cap,construct_values(spec,values,endpoint_id,cap)

def construct_values(spec,values,endpoint_id,cap):
    q.need(set(spec)==({'nativePurpose'} if 'nativePurpose' in spec else set()) | {'recoveryId','qualificationId','prospectiveOperationId','sourceCommit','manifestSha256','window','prospectiveWindow','prospectiveLimits','paymentRequestId','paymentWorkEnd'},'PACKET_SPEC_SHAPE')
    q.need(spec.get('nativePurpose') in (None,'NATIVE_PREFLIGHT_ONLY'),'PACKET_NATIVE_PURPOSE')
    q.need(cap.e['version']==2 and set(values)=={'projectNumber','targetId','paymentBinding'},'PACKET_RECOVERY_VERSION')
    q.validate_recovered_payment(values['paymentBinding'],cap)
    a=q.current_module('authority');c=a.load('p08-live-binder-local-20261029/source/coordinator.py','qualification_packet_validator');mods=c.sources();restore=mods['restore'];m=q.model
    native={'mode':'LOCAL_INTEGRATED_PACKET_ONLY','externalActionAuthorized':False,'automaticRetryAllowed':False,'allowanceUsd':0,'project':m.PROJECT,'projectNumber':values['projectNumber'],'projectNumberSha256':hashlib.sha256(values['projectNumber'].encode()).hexdigest(),'tenantId':m.TENANT,'jobId':m.JOB,'ownerPrincipal':m.OWNER,'runtimeIdentity':m.IDENTITY,'serviceRetention':'RETAIN_ENABLED_AFTER_KEY_DELETE','operationId':spec['prospectiveOperationId'],'keyId':'signmons-p08-'+spec['prospectiveOperationId'].replace('-',''),'window':spec['prospectiveWindow']}
    c.authorize(native,{'decision':'APPROVE_LOCAL_SINGLE_COORDINATOR','externalActionAuthorized':False,'operationId':native['operationId'],'planSha256':m.digest(native)},mods,m.timestamp(native['window']['start']))
    q.need(spec['prospectiveLimits']=={'cli':192,'https':100,'sql':60,'child':6,'childRequests':200},'PACKET_LIMITS')
    scope={'plan':native,'target':{'id':values['targetId'],'tenantId':m.TENANT,'email':m.OWNER,'fullName':q.TARGET_NAME,'role':'ADMIN'},'database':cap.e['database'],'resources':q.candidate_binding.resource_pins(restore,q.CANDIDATE_CONFIG),'limits':spec['prospectiveLimits']}
    payment={**values['paymentBinding'],'endpointId':endpoint_id,'endpointSha256':hashlib.sha256(endpoint_id.encode()).hexdigest(),'apiVersion':'2026-03-25.dahlia','url':json.loads((a.APP/'p08-local-preparation-20261022/plan.json').read_text())['origin']+'/webhooks/stripe','requestId':spec['paymentRequestId'],'qualificationId':spec['qualificationId'],'workEnd':spec['paymentWorkEnd']}
    scope['payment']=payment
    a.validate_payment({'payment':payment,'execution':'EXTERNAL' if cap.external else 'PROOF_ONLY'},{k:m.timestamp(v) for k,v in native['window'].items()})
    plan={'mode':'LOCAL_COMPOSED_QUALIFICATION_ONLY','externalReadAuthorized':False,'operationId':spec['qualificationId'],'prospectiveOperationId':spec['prospectiveOperationId'],'automaticRetryAllowed':False,'allowanceUsd':0,'project':m.PROJECT,'jobId':m.JOB,'tenantId':m.TENANT,'ownerPrincipal':m.OWNER,'runtimeIdentity':m.IDENTITY,'roles':[m.LOOKUP_ROLE,m.SIGNING_ROLE],'services':list(m.SERVICES),'permissions':list(m.PERMISSIONS),'ownershipSha256':m.OWNERSHIP_SHA256,'sourceHashes':m.SOURCE_HASHES,'proposalSha256':m.PROPOSAL_SHA256,'prospectiveKeyId':native['keyId'],'window':spec['window'],'producerDecision':'APPROVE_LOCAL_CURRENT_EVIDENCE_PROOF','producerManifestSha256':q.source_manifest_sha256(),'nativeScopeSha256':m.digest(scope)}
    plan['readInventory']=m.read_inventory(plan)
    m.authorize(plan,m.timestamp(plan['window']['start']))
    manifest=m.verify_local_manifest();e={'version':1,'plan':plan,'nativeScope':scope,'sourceCommit':spec['sourceCommit'],'manifestSha256':q.source_manifest_sha256(),'sdkReview':manifest['sdkReview']}
    q.need(e['manifestSha256']==spec['manifestSha256'],'PACKET_MANIFEST_BINDING')
    q.need(plan['operationId']==cap.e['qualificationId'] and native['operationId']==cap.e['nativeOperationId'] and e['sourceCommit']==cap.e['sourceCommit'],'PACKET_OPERATION_BINDING')
    q.need(m.timestamp(native['window']['purgeEnd'])<=cap.times['purgeEnd'] and m.timestamp(plan['window']['purgeEnd'])<=cap.times['purgeEnd'],'PACKET_RETENTION')
    return e


def native_envelope(qualification_envelope,candidate,purpose=None):
    a=q.current_module('authority');scope=qualification_envelope['nativeScope']
    q.need(candidate.get('operationId')==scope['plan']['operationId'] and candidate.get('scopeSha256')==q.model.digest(scope),'PACKET_QUALIFICATION_BINDING')
    q.need(purpose in (None,'NATIVE_PREFLIGHT_ONLY'),'PACKET_NATIVE_PURPOSE')
    return {**({'purpose':purpose} if purpose else {}),'version':2,'execution':'EXTERNAL',**copy.deepcopy(scope),'qualification':copy.deepcopy(candidate),
        'sourceManifestSha256':a.digest((a.HERE/'source-manifest.json').read_bytes()),'sourceCommit':qualification_envelope['sourceCommit']}

PYTHON='/opt/homebrew/Cellar/python@3.14/3.14.2/Frameworks/Python.framework/Versions/3.14/bin/python3.14'

def wait_committed_decision(repo,path,expected,start,cutoff,clock=None,sleep=None):
    """Wait for an exact committed decision; absence is not an execution error."""
    import subprocess,time,re
    clock=clock or time.time;sleep=sleep or time.sleep
    q.need(re.fullmatch(r'APP013_P08_(CURRENT_QUALIFICATION|NATIVE_OPERATION)_[0-9]{8}\.json',path) is not None,'APPROVAL_PATH')
    q.need(start<cutoff,'APPROVAL_WINDOW')
    last=clock()
    while True:
        now=clock();q.need(now>=last,'CLOCK_ROLLBACK');last=now
        q.need(now<cutoff,'EXACT_APPROVAL_DEADLINE')
        commit=subprocess.check_output(['git','rev-parse','HEAD'],cwd=repo,text=True).strip()
        present=subprocess.check_output(['git','ls-tree','--name-only',commit,'--',path],cwd=repo,text=True).splitlines()
        if present==[path]:
            raw=subprocess.check_output(['git','show',commit+':'+path],cwd=repo)
            try:value=q.strict_json(raw)
            except (ValueError,q.model.Stop):value=None
            checked=clock();q.need(checked>=last,'CLOCK_ROLLBACK');last=checked
            q.need(checked<cutoff,'EXACT_APPROVAL_DEADLINE')
            if value==expected and checked>=start:
                return {'commit':commit,'path':path,'sha256':hashlib.sha256(raw).hexdigest()}
        sleep(min(1,max(0,cutoff-last)))

def run_native_and_close(root, invoke=None, preflight_only=False):
    import subprocess
    invoke=invoke or subprocess.run
    entry=str(q.current_module('authority').HERE/'entry.py')
    command=[PYTHON,'-I','-B','-c',
        'import runpy,sys;sys.path.insert(0,sys.argv[1]);sys.argv=sys.argv[2:];runpy.run_module("entry",run_name="__main__")',
        str(Path(entry).parent),'entry.py']
    work_exit=None;closeout_exit=None
    try:
        work_exit=invoke([*command,'--preflight' if preflight_only else '--run',str(root/'envelope.json')],check=False).returncode
    finally:
        if (root/'attempt.json').exists() and not (root/'independent-closeout.json').exists():
            closeout_exit=invoke([*command,'--close-preflight' if preflight_only else '--closeout',str(root/'envelope.json')],check=False).returncode
    return {'workExit':work_exit,'closeoutExit':closeout_exit}

def execute_connected(cap,envelope,approve_native,native_purpose=None):
    """Operation-specific sequencing; approvals/credentials are never manufactured here.

    The caller has already obtained the exact qualification decision. approve_native
    receives only the unsigned envelope in this process and must return a committed
    exact approval reference. Existing authority validates it before native launch.
    """
    q.need(cap.external and cap.mode=='handoff','PACKET_EXTERNAL_HANDOFF_REQUIRED')
    qualification_root=Path('/private/tmp/p08-current-external-'+cap.e['qualificationId'])
    stage='RECOVERY_HANDOFF'
    try:
        q.handoff_recovered_bindings(cap,envelope)
        stage='CURRENT_QUALIFICATION'
        q.current_main(['--qualify-current',str(cap.input_root/'envelope.json')])
        stage='QUALIFICATION_RECEIPT'
        result=q.private_json(qualification_root/'result.json')
        q.need(result.get('status')=='CURRENT_EVIDENCE_OBSERVED' and result.get('liveObserved') is True and
               result.get('failure') is None and result.get('residuals')==[],'PACKET_QUALIFICATION_UNCONFIRMED')
        native=native_envelope(envelope,result['candidate'],native_purpose)
        stage='NATIVE_APPROVAL'
        native['decision']=approve_native(copy.deepcopy(native))
        stage='NATIVE_HANDOFF'
        q.handoff_qualified_bindings(cap,native)
        stage='NATIVE_RUN_AND_CLOSEOUT'
        exits=run_native_and_close(cap.native_root,preflight_only=True) if native_purpose else run_native_and_close(cap.native_root)
        stage='NATIVE_RECEIPT'
        native_result=q.private_json(cap.native_root/'result.json')
    except BaseException as error:
        error.connected_stage=stage
        raise
    finally:
        # Qualification's normal path already owns both SQL closeouts. Only an
        # unconsumed independent cleanup receipt permits fresh crash recovery.
        if (qualification_root/'cleanup-envelope.json').exists() and not (qualification_root/'independent-closeout.json').exists():
            try:q.current_main(['--closeout-current',str(qualification_root)])
            except BaseException:pass  # Guard purge still runs; owned receipts retain unknown containment.
        try:
            cleanup=q.BindingRecoveryCapability(q.private_json(cap.root/'guard-envelope.json'),mode='closeout')
            purged=q.closeout_binding_recovery(cleanup)
        except BaseException as error:
            error.connected_stage='RECOVERY_CLOSEOUT'
            raise
    q.need(purged.get('rawFilesAbsent') is True and purged.get('resourceCloseout',{}).get('verified') is True,'PACKET_PURGE_UNCONFIRMED')
    return {'native':native_result,'commandExits':exits,'privateInputsAbsent':True,'paymentReadyForAcceptance':False}

if __name__=='__main__':
    raise SystemExit('PACKET_REQUIRES_GUARDED_BINDINGS_AND_SEPARATE_AUTHORITY')

# AW1 only captures an explicitly delegated owner's local attestation. It never
# writes a Git decision or substitutes for the existing capability validators.
AW1_FILES={'qualification.json','native.json','result.json',*(stage+suffix for stage in ('qualification','native') for suffix in ('.aw1-review.json','.aw1-confirmation.json','.aw1-consumed.json','.aw1.lock','.aw1-next.json'))}

def attended_consent(spec,reference,governance=G,clock=None,read_commit=None):
    import time,re
    clock=clock or time.time;authority=q.current_module('authority');read_commit=read_commit or authority.committed
    q.need(isinstance(reference,dict) and set(reference)=={'commit','path','sha256'} and
        isinstance(reference['commit'],str) and isinstance(reference['path'],str) and
        re.fullmatch(r'[a-f0-9]{40}',reference['commit']) and
        re.fullmatch(r'APP013_P08_ATTENDED_SESSION_[0-9]{8}\.json',reference['path']),'ATTENDED_CONSENT_REFERENCE')
    raw=read_commit(governance,reference['commit'],reference['path'])
    q.need(q.model.digest(raw)==reference['sha256'],'ATTENDED_CONSENT_HASH')
    value=q.strict_json(raw)
    expected={'owner':'Debynyhan Banks','decision':'APPROVE_EXACT_ATTENDED_TERMINAL_CONFIRMATIONS',
        'recoveryId':spec['recoveryId'],'sourceCommit':spec['sourceCommit'],'specSha256':q.model.digest(spec),
        'stages':['qualification','native'],'purgeEnd':spec['window']['purgeEnd'],
        'nativeCost':{'allowanceUsd':0,'hardBillingCap':False,'existingLiabilitiesUnchanged':True}}
    q.need(value==expected,'ATTENDED_CONSENT_SCOPE')
    q.need(q.model.timestamp(spec['window']['start'])<=clock()<q.model.timestamp(value['purgeEnd']),'ATTENDED_CONSENT_WINDOW')
    for name in ('packet.py','connected_launcher.py'):
        rel='evidence/APP-013/p08-connected-packet-20261110/'+name
        q.need(read_commit(B,spec['sourceCommit'],rel)==(B/rel).read_bytes(),'ATTENDED_SOURCE_DRIFT')
    return value


def stage_review(stage,spec,decision,envelope,consent):
    q.need(stage in ('qualification','native'),'ATTENDED_STAGE')
    operation=spec['qualificationId'] if stage=='qualification' else spec['prospectiveOperationId']
    window=spec['window'] if stage=='qualification' else spec['prospectiveWindow']
    common={'owner':'Debynyhan Banks','scopeSha256':q.model.digest(envelope)}
    if stage=='qualification':
        expected={**common,'decision':'APPROVE_EXACT_P08_CURRENT_QUALIFICATION','externalReadAuthorized':True,
            'cleanupScopeSha256':q.model.digest(q.qualification_cleanup_scope(envelope))}
        summary={'actions':['Read cloud identity/configuration/permissions and retired resources','Read test identity and same-job payment policy','Independent database closeout and private purge'],
            'providerMutations':False,'limits':envelope['sdkReview']['limits'],'spendingAuthorized':False}
    else:
        expected={**common,'decision':'APPROVE_EXACT_P08_CONNECTED_PAYMENT','externalActionAuthorized':True,
            'operationId':operation,'sourceManifestSha256':envelope['sourceManifestSha256']}
        pay=envelope['payment'];resources=envelope['resources'];cost=consent['nativeCost']
        q.need(type(pay['amountTotalCents']) is int and pay['amountTotalCents']>0 and pay['currency']=='usd','ATTENDED_PAYMENT_REVIEW')
        q.need(envelope['plan']['allowanceUsd']==cost['allowanceUsd'] and resources==q.candidate_binding.resource_pins(q.current_module('authority').load('p08-restoration-local-20261028/source/restore.py','aw1_restore')),'ATTENDED_RESOURCE_COST')
        summary={'actions':['Temporarily enable exact runtime identity, numeric secret versions and resource bindings','Activate bounded database role and candidate tag; normal traffic percentages unchanged','Create/delete owned restricted key; enable/close exact test identities','Enable existing Sandbox webhook; one same-job Sandbox Checkout and authentic event check','Mandatory independent cleanup and private purge'],
            'sandboxOnly':True,'amountTotalCents':pay['amountTotalCents'],'currency':pay['currency'],
            'candidate':resources['candidate'],'stripeVersion':resources['secretVersions']['signmons-staging-stripe-secret-key'],
            'limits':spec['prospectiveLimits'],'paymentWorkEnd':spec['paymentWorkEnd'],'cost':cost,
            'realChargesRefundsBookingCustomerMessagesAuthorized':False}
    q.need(decision==expected,'ATTENDED_DECISION_SCOPE')
    return {'stage':stage,'operationId':operation,'recoveryId':spec['recoveryId'],'sourceCommit':spec['sourceCommit'],
        'decision':decision,'window':window,'summary':summary,'consentSha256':q.model.digest(consent)}


def _attended_root(root,spec):
    q.need(Path(root)==Path('/private/tmp/p08-public-review-'+spec['recoveryId']),'ATTENDED_REVIEW_ROOT')
    q.inspect_current_root(Path(root),AW1_FILES)


def _attended_lock(root,stage):
    import os,fcntl
    fd=os.open(Path(root)/(stage+'.aw1.lock'),os.O_CREAT|os.O_WRONLY|os.O_NOFOLLOW,0o600)
    try:fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
    except BaseException:os.close(fd);raise
    return fd


def _attended_publish(root,stage,name,value):
    import os
    root=Path(root);tmp=root/(stage+'.aw1-next.json')
    q.model.reserve(tmp,value)
    try:os.link(tmp,root/name) # Exclusive atomic publication, never replace a receipt.
    finally:tmp.unlink()


def capture_attended_confirmation(root,stage,spec,decision,envelope,reference,governance=G,clock=None,read_line=None,read_commit=None,emit=print):
    import time,secrets,os
    clock=clock or time.time
    consent=attended_consent(spec,reference,governance,clock,read_commit)
    review=stage_review(stage,spec,decision,envelope,consent)
    _attended_root(root,spec);fd=_attended_lock(root,stage)
    try:
        _attended_root(root,spec)
        now=clock();start=q.model.timestamp(review['window']['start']);cutoff=q.model.timestamp(review['window']['cutoff'])
        q.need(start<=now<cutoff,'ATTENDED_INPUT_WINDOW')
        nonce=secrets.token_hex(8);review.update(nonce=nonce,createdAt=now)
        _attended_publish(root,stage,stage+'.aw1-review.json',review)
        phrase='APPROVE '+('QUALIFICATION' if stage=='qualification' else 'SANDBOX')+' '+review['operationId'][:8]+' '+nonce
        emit(json.dumps(review,indent=2));emit('Type '+phrase+' to approve this exact scope, or CANCEL. No default approval.')
        if read_line is None:
            q.need(sys.stdin.isatty(),'ATTENDED_TERMINAL_REQUIRED')
            with q.current_module('acl').http_deadline(cutoff-clock()):answer=input('Decision: ')
        else:answer=read_line('Decision: ')
        checked=clock();q.need(now<=checked<cutoff,'ATTENDED_INPUT_DEADLINE')
        q.need(answer==phrase,'ATTENDED_CONFIRMATION_REFUSED')
        confirmation={'stage':stage,'operationId':review['operationId'],'recoveryId':spec['recoveryId'],
            'sourceCommit':spec['sourceCommit'],'decisionSha256':q.model.digest(decision),'reviewSha256':q.model.digest(review),
            'consentSha256':q.model.digest(consent),'nonce':nonce,'confirmedAt':checked,'expiresAt':cutoff}
        _attended_publish(root,stage,stage+'.aw1-confirmation.json',confirmation)
        emit('Confirmation recorded locally; awaiting independent verification and committed approval. '+('Next: hidden SQL password in this Terminal.' if stage=='qualification' else 'Next: existing native authentication and Sandbox Checkout flow. Stay in this attended session.'))
        return confirmation
    finally:os.close(fd)


def verify_attended_confirmation(root,stage,spec,decision,expected_review,reference,governance=G,clock=None,read_commit=None):
    """Operator-only verifier; consumes once, returns decision, never commits or runs it."""
    import time,os,re
    clock=clock or time.time;consent=attended_consent(spec,reference,governance,clock,read_commit)
    # Operator reviews the sanitized summary, not retained private scope. Capture's
    # source-bound renderer derives it from the actual envelope; never accept the
    # confirmation record itself as the expected review.
    expected=copy.deepcopy(expected_review)
    q.need(stage in ('qualification','native') and set(expected)=={'stage','operationId','recoveryId','sourceCommit','decision','window','summary','consentSha256'},'ATTENDED_EXPECTED_REVIEW')
    q.need(expected['stage']==stage and expected['operationId']==spec['qualificationId' if stage=='qualification' else 'prospectiveOperationId'] and expected['recoveryId']==spec['recoveryId'] and expected['sourceCommit']==spec['sourceCommit'] and expected['decision']==decision and expected['window']==spec['window' if stage=='qualification' else 'prospectiveWindow'] and expected['consentSha256']==q.model.digest(consent),'ATTENDED_EXPECTED_SCOPE')
    q.need(decision.get('owner')=='Debynyhan Banks' and decision.get('decision')==('APPROVE_EXACT_P08_CURRENT_QUALIFICATION' if stage=='qualification' else 'APPROVE_EXACT_P08_CONNECTED_PAYMENT'),'ATTENDED_EXPECTED_DECISION')
    _attended_root(root,spec);fd=_attended_lock(root,stage)
    try:
        _attended_root(root,spec);root=Path(root)
        review=q.private_json(root/(stage+'.aw1-review.json'));confirmation=q.private_json(root/(stage+'.aw1-confirmation.json'))
        q.need(set(review)==set(expected)|{'nonce','createdAt'} and all(review[k]==v for k,v in expected.items()),'ATTENDED_REVIEW_DRIFT')
        q.need(isinstance(review['nonce'],str) and re.fullmatch('[a-f0-9]{16}',review['nonce']),'ATTENDED_NONCE')
        now=clock();cutoff=q.model.timestamp(expected['window']['cutoff'])
        q.need(type(review['createdAt']) in (int,float) and type(confirmation.get('confirmedAt')) in (int,float) and
            q.model.timestamp(expected['window']['start'])<=review['createdAt']<=confirmation['confirmedAt']<=now<cutoff,'ATTENDED_CONFIRMATION_TIME')
        q.need(confirmation=={'stage':stage,'operationId':expected['operationId'],'recoveryId':spec['recoveryId'],
            'sourceCommit':spec['sourceCommit'],'decisionSha256':q.model.digest(decision),'reviewSha256':q.model.digest(review),
            'consentSha256':q.model.digest(consent),'nonce':review['nonce'],'confirmedAt':confirmation['confirmedAt'],'expiresAt':cutoff},'ATTENDED_CONFIRMATION_DRIFT')
        _attended_publish(root,stage,stage+'.aw1-consumed.json',{'decisionSha256':q.model.digest(decision),'consumedAt':now})
        return copy.deepcopy(decision)
    finally:os.close(fd)

# PA1 renewal preflight only. This function never invokes an SDK, reads a token,
# reserves an operation, or changes any historical manifest.
def renewal_tree_check(source_commit, backend=B):
    import subprocess,re
    q.need(isinstance(source_commit,str) and re.fullmatch('[a-f0-9]{40}',source_commit),'RENEWAL_SOURCE_REFERENCE')
    result=subprocess.run(['/usr/bin/git','diff','--quiet',source_commit,'--','evidence/APP-013'],cwd=backend,
        stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,timeout=10)
    q.need(result.returncode==0,'RENEWAL_COMMITTED_TREE_DRIFT')


def renewal_preflight(source_commit, reference, expected_decision, *, config_root=None, environment=None, clock=None, read_commit=None):
    """Exact current-source preflight; caller separately owns reviewed one-shot procedure."""
    import os,time,sqlite3,re
    clock=clock or time.time;a=q.current_module('authority');acl=q.current_module('acl');get=read_commit or a.committed
    q.need(isinstance(reference,dict) and set(reference)=={'commit','path','sha256'} and
        isinstance(reference['path'],str) and re.fullmatch('APP013_P08_TR[0-9]+_DECISION_[0-9]{8}\\.json',reference['path']),'RENEWAL_AUTHORITY_REFERENCE')
    raw=get(G,reference['commit'],reference['path'])
    q.need(q.model.digest(raw)==reference['sha256'] and q.strict_json(raw)==expected_decision and
        expected_decision.get('owner')=='Debynyhan Banks' and expected_decision.get('externalActionAuthorized') is True and
        expected_decision.get('decision')=='APPROVE_TR1_CREDENTIAL_RENEWAL_SDK_RETRY_CACHE_AND_CLEANUP' and
        expected_decision.get('sourceCommit')==source_commit,'RENEWAL_EXACT_AUTHORITY')
    now=clock();cutoff=q.model.timestamp(expected_decision['cutoff']);closeout=q.model.timestamp(expected_decision['closeoutEnd'])
    q.need(now<cutoff<closeout<q.model.timestamp(expected_decision['validThrough']),'RENEWAL_WINDOW')
    renewal_tree_check(source_commit)
    manifest=q.model.verify_local_manifest();q.model.verify_locked_sources();native=a.verify_sources()
    q.verify_qualification_sources(source_commit,manifest,get)
    legacy_path=acl.HERE/'source-manifest.json';legacy=json.loads(legacy_path.read_text())
    review_path=acl.HERE/'test-manifest.json';sdk_review=json.loads(review_path.read_text())
    # The unchanged historical inventory is checked in full. Only authority.py
    # maps to the already-approved current manifest; the old pin is preserved.
    expected_legacy={'p08-role-contract-local-20261029/source/qualification_launch.py',
        'p08-role-contract-local-20261029/source/composed_qualification.py',
        'p08-exact-role-provisioning-local-20261028/source/role_provisioner.py',
        'p08-restoration-local-20261028/source/restore.py','p08-native-entry-local-20261101/source/authority.py'}
    q.need(set(legacy['lockedSources'])==expected_legacy and set(legacy['files'])=={'access_check.py'},'RENEWAL_DEPENDENCY_SET')
    dependencies={acl.HERE/n:h for n,h in legacy['files'].items()};mapping={}
    for name,old in legacy['lockedSources'].items():
        current=native['files']['authority.py'] if name=='p08-native-entry-local-20261101/source/authority.py' else old
        dependencies[acl.APP/name]=current;mapping[name]={'historical':old,'current':current,'changed':old!=current}
    for path in (legacy_path,review_path,a.HERE/'source-manifest.json',Path(__file__)):
        dependencies[path]=q.model.digest(path.read_bytes())
    for path,expected in dependencies.items():
        q.need(path.is_file() and not path.is_symlink() and q.model.digest(path.read_bytes())==expected,'RENEWAL_DEPENDENCY_DRIFT')
        q.need(q.model.digest(get(B,source_commit,str(path.relative_to(B))))==expected,'RENEWAL_COMMITTED_DEPENDENCY')
    sdk={}
    for entries in (legacy['sdkFiles'],sdk_review['sdkReviewFiles'],manifest['sdkReview']['files']):
        for name,expected in entries.items():
            q.need(name not in sdk or sdk[name]==expected,'RENEWAL_SDK_PIN_CONFLICT');sdk[name]=expected
    for name,expected in sdk.items():
        q.need(q.model.digest(Path(name).read_bytes())==expected,'RENEWAL_SDK_DRIFT')
    q.need((sys.platform,sys.version_info[:3],sqlite3.sqlite_version)==acl.LOCAL_RUNTIME,'LOCAL_RUNTIME_DRIFT')
    acl.config_snapshot(acl.CONFIG_ROOT if config_root is None else config_root,os.environ if environment is None else environment)
    q.need(now<=clock()<cutoff,'RENEWAL_PREFLIGHT_DEADLINE')
    return {'status':'PREFLIGHT_VERIFIED_NO_OPERATION_RESERVED','sourceCommit':source_commit,
        'dependencyMapping':mapping,'sdkFilesVerified':len(sdk),'credentialStoresRead':False,'providerCalls':0}
