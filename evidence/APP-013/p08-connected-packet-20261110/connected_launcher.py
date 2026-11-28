"""Reviewed connected-operation wrapper. Public spec only; raw scope stays in memory."""
import sys,json,time,subprocess,getpass,hashlib,copy,os
from pathlib import Path
import packet as p
q=p.q


PAYMENT_FAILURE_CODES=frozenset({'PAYMENT_SCOPE_SHAPE','PAYMENT_SCOPE','PAYMENT_TIMESTAMP',
    'PAYMENT_TIMING','PAYMENT_ENDPOINT_PIN','PAYMENT_BUILD_DRIFT'})

def safe_failure_code(error):
    if isinstance(error,q.model.Stop):return str(error)
    try:native_stop=q.current_module('authority').Stop
    except Exception:return type(error).__name__
    if (type(error) is native_stop and len(error.args)==1 and type(error.args[0]) is str
            and error.args[0] in PAYMENT_FAILURE_CODES):
        return error.args[0]
    return type(error).__name__

def recover_first(spec,path,governance=p.G):
    """The existing exact recovery interface, after this session's opening check."""
    q.need(spec.get('nativePurpose')=='NATIVE_AUTH_QUALIFICATION_ONLY','RECOVERY_FIRST_PURPOSE')
    p.validate_public_spec(spec)
    q.need(q.recovery_main(['--recover-binding-inputs',str(path)],
        before_recover=lambda cap:p.verify_auth_opening(spec,cap,governance=governance))==0,
        'PACKET_RECOVERY_UNCONFIRMED')


def main(spec,governance=p.G,review=None,read_hidden=getpass.getpass,session_consent=None,read_confirmation=None,
         recovery_envelope=None,clock=time.time):
    review=Path(review) if review is not None else Path('/private/tmp/p08-public-review-'+spec['recoveryId'])
    def publish(stage,decision,details):
        review.mkdir(mode=0o700,exist_ok=True)
        q.model.reserve(review/(stage+'.json'),{'stage':stage,'decisionForReview':decision,**details})
        print(stage.upper()+'_READY_FOR_EXACT_APPROVAL',flush=True)

    def wait_decision(path,expected,start,cutoff):
        return p.wait_committed_decision(governance,path,expected,start,cutoff,clock=clock)

    cap=None;dispatched=False;stage='PACKET_PREPARATION'
    purpose=spec.get('nativePurpose')
    q.need(purpose in (None,'NATIVE_PREFLIGHT_ONLY','NATIVE_AUTH_QUALIFICATION_ONLY'),'PACKET_NATIVE_PURPOSE')
    diagnostic=purpose=='NATIVE_PREFLIGHT_ONLY'
    auth_only=purpose=='NATIVE_AUTH_QUALIFICATION_ONLY'
    q.need(not auth_only or session_consent is None,'AUTH_QUALIFICATION_REQUIRES_SEPARATE_CHAT_DECISIONS')
    q.need(not diagnostic or session_consent is None,'PREFLIGHT_REQUIRES_SEPARATE_CHAT_DECISIONS')
    try:
        q.need(recovery_envelope is None or auth_only,'RECOVERY_FIRST_PURPOSE')
        if recovery_envelope is not None:recover_first(spec,recovery_envelope,governance)
        if auth_only:
            cap=q.BindingRecoveryCapability(q.private_json(Path('/private/tmp/p08-binding-recovery-'+spec['recoveryId'])/'guard-envelope.json'),mode='handoff',clock=clock)
            p.verify_recovered_auth_opening(spec,cap,governance)
        endpoint_end=q.model.timestamp(spec['window']['cutoff'])
        if auth_only:endpoint_end=min(endpoint_end,p.auth_timing(p.auth_spec_envelope(spec),clock())['latestAdmission'])
        endpoint_started=clock()
        q.need(endpoint_end>endpoint_started,'ENDPOINT_INPUT_DEADLINE')
        q.need(__import__('signal').getitimer(__import__('signal').ITIMER_REAL)==(0.0,0.0),'ENDPOINT_INPUT_TIMER')
        acl=q.current_module('acl')
        try:
            with acl.http_deadline(endpoint_end-endpoint_started):
                endpoint=read_hidden('Existing Sandbox endpoint ID (hidden, starts we_): ').strip()
        except acl.Stop:raise q.model.Stop('ENDPOINT_INPUT_DEADLINE') from None
        endpoint_finished=clock()
        q.need(endpoint_finished>=endpoint_started,'CLOCK_ROLLBACK')
        q.need(endpoint_finished<endpoint_end,'ENDPOINT_INPUT_DEADLINE')
        cap,e=p.construct(spec,endpoint);endpoint=None
        decision={'owner':'Debynyhan Banks','decision':'APPROVE_EXACT_P08_CURRENT_QUALIFICATION','externalReadAuthorized':True,'scopeSha256':q.model.digest(e),'cleanupScopeSha256':q.model.digest(q.qualification_cleanup_scope(e))}
        raw=json.dumps(decision).encode();test=copy.deepcopy(e);test['decision']={'commit':'0'*40,'path':'APP013_P08_CURRENT_QUALIFICATION_20261110.json','sha256':hashlib.sha256(raw).hexdigest()}
        a=q.current_module('authority')
        def read(repo,commit,path):
            return raw if commit=='0'*40 else a.committed(repo,commit,path)
        qc=q.QualificationCapability(test,clock=lambda:q.model.timestamp(spec['window']['start'])+1,read_commit=read);qc.prepare()
        qualification_cutoff=q.model.timestamp(spec['window']['cutoff'])
        if auth_only:qualification_cutoff=min(qualification_cutoff,p.auth_timing({'purpose':purpose,'version':2,**e['nativeScope']},clock())['latestAdmission'])
        publish('qualification',decision,{'operationId':spec['qualificationId'],'nativeScopeSha256':e['plan']['nativeScopeSha256'],'window':spec['window'],'limits':e['sdkReview']['limits'],'sourceCommit':spec['sourceCommit'],'endpointHashMatched':True,'localCapabilityPreflight':'PASS_PROPOSED_CLOCK_ONLY','providerCalls':0})
        stage='QUALIFICATION_APPROVAL'
        if session_consent is not None:
            p.capture_attended_confirmation(review,'qualification',spec,decision,e,session_consent,governance,read_line=read_confirmation)
        e['decision']=wait_decision('APP013_P08_CURRENT_QUALIFICATION_20261110.json',decision,q.model.timestamp(spec['window']['start']),qualification_cutoff)
        if auth_only:p.auth_timing({'purpose':purpose,'version':2,**e['nativeScope']},clock())
        def approve_native(native):
            native_cutoff=q.model.timestamp(spec['prospectiveWindow']['cutoff'])
            if auth_only:native_cutoff=min(native_cutoff,p.auth_timing(native,clock())['latestAdmission'])
            d={'owner':'Debynyhan Banks','decision':'APPROVE_EXACT_P08_NATIVE_PREFLIGHT_READ' if diagnostic else 'APPROVE_EXACT_P08_AUTH_QUALIFICATION' if auth_only else 'APPROVE_EXACT_P08_CONNECTED_PAYMENT',('externalReadAuthorized' if diagnostic else 'externalActionAuthorized'):True,'operationId':spec['prospectiveOperationId'],'scopeSha256':q.model.digest(native),'sourceManifestSha256':native['sourceManifestSha256']}
            summary={} if diagnostic or auth_only else {'summary':p.stage_review('native',spec,d,native,{'nativeCost':{'allowanceUsd':0,'hardBillingCap':False,'existingLiabilitiesUnchanged':True}})['summary']}
            if auth_only:
                q.need(native.get('purpose')==purpose and native.get('version')==2,'PACKET_NATIVE_PURPOSE')
                summary={'purpose':purpose,'summary':{
                    'actions':['Retain current qualification and temporary runtime/IAM/key/test-account setup',
                               'Read exact Sandbox secret/disabled webhook preflight',
                               'Verify token and protected same-job authentication',
                               'Mandatory normal and independent cleanup/private purge'],
                    'paymentAuthorized':False,'webhookEnableAuthorized':False,'browserAuthorized':False,
                    'limits':spec['prospectiveLimits'],
                    'cost':{'allowanceUsd':0,'hardBillingCap':False,'existingLiabilitiesUnchanged':True}}}
            publish('native',d,{'operationId':spec['prospectiveOperationId'],'window':spec['prospectiveWindow'],'paymentWorkEnd':spec['paymentWorkEnd'],'qualification':native['qualification'],'limits':spec['prospectiveLimits'],'sourceCommit':spec['sourceCommit'],**summary,**({'purpose':'NATIVE_PREFLIGHT_ONLY','activationAuthorized':False,'effectiveLimits':a.PREFLIGHT_LIMITS} if diagnostic else {})})
            if session_consent is not None:
                p.capture_attended_confirmation(review,'native',spec,d,native,session_consent,governance,read_line=read_confirmation)
            result=wait_decision('APP013_P08_NATIVE_OPERATION_20261110.json',d,q.model.timestamp(spec['prospectiveWindow']['start']),native_cutoff)
            if auth_only:p.auth_timing(native,clock())
            return result
        dispatched=True
        result=p.execute_connected(cap,e,approve_native,native_purpose=spec['nativePurpose']) if purpose is not None else p.execute_connected(cap,e,approve_native)
        publish('result',{},result)
        return 0
    except BaseException as error:
        stages={'PACKET_PREPARATION','QUALIFICATION_APPROVAL','RECOVERY_HANDOFF','CURRENT_QUALIFICATION','QUALIFICATION_RECEIPT','NATIVE_APPROVAL','NATIVE_HANDOFF','NATIVE_RUN_AND_CLOSEOUT','NATIVE_RECEIPT','RECOVERY_CLOSEOUT'}
        failure_stage=getattr(error,'connected_stage',stage)
        print('CONNECTED_STAGE_'+(failure_stage if failure_stage in stages else 'UNKNOWN'),flush=True)
        print('CONNECTED_STOP_'+safe_failure_code(error),flush=True)
        return 2
    finally:
        if cap is not None and not dispatched and (cap.root/'guard-envelope.json').exists():
            cleanup=q.BindingRecoveryCapability(q.private_json(cap.root/'guard-envelope.json'),mode='closeout')
            result=q.closeout_binding_recovery(cleanup)
            print('RECOVERY_PURGE_VERIFIED' if result.get('rawFilesAbsent') else 'RECOVERY_PURGE_UNKNOWN',flush=True)

if __name__=='__main__':
    if len(sys.argv) not in (2,4) or (len(sys.argv)==4 and sys.argv[2] not in ('--terminal-consent','--recover-first')):
        raise SystemExit('Supply reviewed public spec and optional exact --terminal-consent or AQ1 --recover-first reference; no consumed-operation default.')
    reference=q.private_json(Path(sys.argv[3])) if len(sys.argv)==4 and sys.argv[2]=='--terminal-consent' else None
    recovery=sys.argv[3] if len(sys.argv)==4 and sys.argv[2]=='--recover-first' else None
    raise SystemExit(main(json.loads(Path(sys.argv[1]).read_text()),session_consent=reference,recovery_envelope=recovery))
