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
    q.need(set(spec)=={'recoveryId','qualificationId','prospectiveOperationId','sourceCommit','manifestSha256','window','prospectiveWindow','prospectiveLimits','paymentRequestId','paymentWorkEnd'},'PACKET_SPEC_SHAPE')
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


def native_envelope(qualification_envelope,candidate):
    a=q.current_module('authority');scope=qualification_envelope['nativeScope']
    q.need(candidate.get('operationId')==scope['plan']['operationId'] and candidate.get('scopeSha256')==q.model.digest(scope),'PACKET_QUALIFICATION_BINDING')
    return {'version':2,'execution':'EXTERNAL',**copy.deepcopy(scope),'qualification':copy.deepcopy(candidate),
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

def run_native_and_close(root, invoke=None):
    import subprocess
    invoke=invoke or subprocess.run
    entry=str(q.current_module('authority').HERE/'entry.py')
    command=[PYTHON,'-I','-B','-c',
        'import runpy,sys;sys.path.insert(0,sys.argv[1]);sys.argv=sys.argv[2:];runpy.run_module("entry",run_name="__main__")',
        str(Path(entry).parent),'entry.py']
    work_exit=None;closeout_exit=None
    try:
        work_exit=invoke([*command,'--run',str(root/'envelope.json')],check=False).returncode
    finally:
        if (root/'attempt.json').exists() and not (root/'independent-closeout.json').exists():
            closeout_exit=invoke([*command,'--closeout',str(root/'envelope.json')],check=False).returncode
    return {'workExit':work_exit,'closeoutExit':closeout_exit}

def execute_connected(cap,envelope,approve_native):
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
        native=native_envelope(envelope,result['candidate'])
        stage='NATIVE_APPROVAL'
        native['decision']=approve_native(copy.deepcopy(native))
        stage='NATIVE_HANDOFF'
        q.handoff_qualified_bindings(cap,native)
        stage='NATIVE_RUN_AND_CLOSEOUT'
        exits=run_native_and_close(cap.native_root)
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
