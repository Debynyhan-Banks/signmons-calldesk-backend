"""Reviewed connected-operation wrapper. Public spec only; raw scope stays in memory."""
import sys,json,time,subprocess,getpass,hashlib,copy,os
from pathlib import Path
import packet as p
q=p.q

def main(spec,governance=p.G,review=None,read_hidden=getpass.getpass,session_consent=None,read_confirmation=None):
    review=Path(review) if review is not None else Path('/private/tmp/p08-public-review-'+spec['recoveryId'])
    def publish(stage,decision,details):
        review.mkdir(mode=0o700,exist_ok=True)
        q.model.reserve(review/(stage+'.json'),{'stage':stage,'decisionForReview':decision,**details})
        print(stage.upper()+'_READY_FOR_EXACT_APPROVAL',flush=True)

    def wait_decision(path,expected,start,cutoff):
        return p.wait_committed_decision(governance,path,expected,start,cutoff)

    cap=None;dispatched=False;stage='PACKET_PREPARATION'
    try:
        endpoint=read_hidden('Existing Sandbox endpoint ID (hidden, starts we_): ').strip()
        cap,e=p.construct(spec,endpoint);endpoint=None
        decision={'owner':'Debynyhan Banks','decision':'APPROVE_EXACT_P08_CURRENT_QUALIFICATION','externalReadAuthorized':True,'scopeSha256':q.model.digest(e),'cleanupScopeSha256':q.model.digest(q.qualification_cleanup_scope(e))}
        raw=json.dumps(decision).encode();test=copy.deepcopy(e);test['decision']={'commit':'0'*40,'path':'APP013_P08_CURRENT_QUALIFICATION_20261110.json','sha256':hashlib.sha256(raw).hexdigest()}
        a=q.current_module('authority')
        def read(repo,commit,path):
            return raw if commit=='0'*40 else a.committed(repo,commit,path)
        qc=q.QualificationCapability(test,clock=lambda:q.model.timestamp(spec['window']['start'])+1,read_commit=read);qc.prepare()
        publish('qualification',decision,{'operationId':spec['qualificationId'],'nativeScopeSha256':e['plan']['nativeScopeSha256'],'window':spec['window'],'limits':e['sdkReview']['limits'],'sourceCommit':spec['sourceCommit'],'endpointHashMatched':True,'localCapabilityPreflight':'PASS_PROPOSED_CLOCK_ONLY','providerCalls':0})
        stage='QUALIFICATION_APPROVAL'
        if session_consent is not None:
            p.capture_attended_confirmation(review,'qualification',spec,decision,e,session_consent,governance,read_line=read_confirmation)
        e['decision']=wait_decision('APP013_P08_CURRENT_QUALIFICATION_20261110.json',decision,q.model.timestamp(spec['window']['start']),q.model.timestamp(spec['window']['cutoff']))
        def approve_native(native):
            d={'owner':'Debynyhan Banks','decision':'APPROVE_EXACT_P08_CONNECTED_PAYMENT','externalActionAuthorized':True,'operationId':spec['prospectiveOperationId'],'scopeSha256':q.model.digest(native),'sourceManifestSha256':native['sourceManifestSha256']}
            publish('native',d,{'operationId':spec['prospectiveOperationId'],'window':spec['prospectiveWindow'],'paymentWorkEnd':spec['paymentWorkEnd'],'qualification':native['qualification'],'limits':spec['prospectiveLimits'],'sourceCommit':spec['sourceCommit']})
            if session_consent is not None:
                p.capture_attended_confirmation(review,'native',spec,d,native,session_consent,governance,read_line=read_confirmation)
            return wait_decision('APP013_P08_NATIVE_OPERATION_20261110.json',d,q.model.timestamp(spec['prospectiveWindow']['start']),q.model.timestamp(spec['prospectiveWindow']['cutoff']))
        dispatched=True
        result=p.execute_connected(cap,e,approve_native)
        publish('result',{},result)
        return 0
    except BaseException as error:
        stages={'PACKET_PREPARATION','QUALIFICATION_APPROVAL','RECOVERY_HANDOFF','CURRENT_QUALIFICATION','QUALIFICATION_RECEIPT','NATIVE_APPROVAL','NATIVE_HANDOFF','NATIVE_RUN_AND_CLOSEOUT','NATIVE_RECEIPT','RECOVERY_CLOSEOUT'}
        failure_stage=getattr(error,'connected_stage',stage)
        print('CONNECTED_STAGE_'+(failure_stage if failure_stage in stages else 'UNKNOWN'),flush=True)
        print('CONNECTED_STOP_'+(str(error) if isinstance(error,q.model.Stop) else type(error).__name__),flush=True)
        return 2
    finally:
        if cap is not None and not dispatched:
            cleanup=q.BindingRecoveryCapability(q.private_json(cap.root/'guard-envelope.json'),mode='closeout')
            result=q.closeout_binding_recovery(cleanup)
            print('RECOVERY_PURGE_VERIFIED' if result.get('rawFilesAbsent') else 'RECOVERY_PURGE_UNKNOWN',flush=True)

if __name__=='__main__':
    if len(sys.argv) not in (2,4) or (len(sys.argv)==4 and sys.argv[2]!='--terminal-consent'):
        raise SystemExit('Supply reviewed public spec and optional --terminal-consent private reference; no consumed-operation default.')
    reference=q.private_json(Path(sys.argv[3])) if len(sys.argv)==4 else None
    raise SystemExit(main(json.loads(Path(sys.argv[1]).read_text()),session_consent=reference))
