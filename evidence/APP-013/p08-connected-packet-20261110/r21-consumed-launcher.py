import sys,json,time,subprocess,getpass,hashlib,copy,os
from pathlib import Path
B=Path('/Users/debynyhanbanks/Web Projects/signmons-backend-r08-recovery')
G=Path('/Users/debynyhanbanks/Web Projects/signmons-governance-r08-recovery')
sys.path.insert(0,str(B/'evidence/APP-013/p08-connected-packet-20261110'))
import packet as p
q=p.q
spec=json.loads((G/'APP013_P08_CONNECTED_SPEC_R21_20261110.json').read_text())
review=Path('/private/tmp/p08-r21-public-review')

def publish(stage,decision,details):
    review.mkdir(mode=0o700,exist_ok=True)
    with (review/(stage+'.json')).open('x') as f:json.dump({'stage':stage,'decisionForReview':decision,**details},f,indent=2)
    print(stage.upper()+'_READY_FOR_EXACT_APPROVAL',flush=True)

def wait_decision(path,expected,start,cutoff):
    while time.time()<cutoff:
        commit=subprocess.check_output(['git','rev-parse','HEAD'],cwd=G,text=True).strip()
        raw=subprocess.check_output(['git','show',commit+':'+path],cwd=G,stderr=subprocess.DEVNULL)
        if json.loads(raw)==expected and time.time()>=start:
            return {'commit':commit,'path':path,'sha256':hashlib.sha256(raw).hexdigest()}
        time.sleep(1)
    raise q.model.Stop('EXACT_APPROVAL_DEADLINE')

cap=None;dispatched=False
try:
    endpoint=getpass.getpass('Existing Sandbox endpoint ID (hidden, starts we_): ').strip()
    cap,e=p.construct(spec,endpoint);endpoint=None
    decision={'owner':'Debynyhan Banks','decision':'APPROVE_EXACT_P08_CURRENT_QUALIFICATION','externalReadAuthorized':True,'scopeSha256':q.model.digest(e),'cleanupScopeSha256':q.model.digest(q.qualification_cleanup_scope(e))}
    raw=json.dumps(decision).encode();test=copy.deepcopy(e);test['decision']={'commit':'0'*40,'path':'APP013_P08_CURRENT_QUALIFICATION_20261110.json','sha256':hashlib.sha256(raw).hexdigest()}
    a=q.current_module('authority')
    def read(repo,commit,path):
        return raw if commit=='0'*40 else a.committed(repo,commit,path)
    qc=q.QualificationCapability(test,clock=lambda:q.model.timestamp(spec['window']['start'])+1,read_commit=read);qc.prepare()
    publish('qualification',decision,{'operationId':spec['qualificationId'],'nativeScopeSha256':e['plan']['nativeScopeSha256'],'window':spec['window'],'limits':e['sdkReview']['limits'],'sourceCommit':spec['sourceCommit'],'endpointHashMatched':True,'localCapabilityPreflight':'PASS_PROPOSED_CLOCK_ONLY','providerCalls':0})
    e['decision']=wait_decision('APP013_P08_CURRENT_QUALIFICATION_20261110.json',decision,q.model.timestamp(spec['window']['start']),q.model.timestamp(spec['window']['cutoff']))
    def approve_native(native):
        d={'owner':'Debynyhan Banks','decision':'APPROVE_EXACT_P08_CONNECTED_PAYMENT','externalActionAuthorized':True,'operationId':spec['prospectiveOperationId'],'scopeSha256':q.model.digest(native),'sourceManifestSha256':native['sourceManifestSha256']}
        publish('native',d,{'operationId':spec['prospectiveOperationId'],'window':spec['prospectiveWindow'],'paymentWorkEnd':spec['paymentWorkEnd'],'qualification':native['qualification'],'limits':spec['prospectiveLimits'],'sourceCommit':spec['sourceCommit']})
        return wait_decision('APP013_P08_NATIVE_OPERATION_20261110.json',d,q.model.timestamp(spec['prospectiveWindow']['start']),q.model.timestamp(spec['prospectiveWindow']['cutoff']))
    dispatched=True
    result=p.execute_connected(cap,e,approve_native)
    publish('result',{},result)
except BaseException as error:
    print('CONNECTED_STOP_'+(str(error) if isinstance(error,q.model.Stop) else type(error).__name__),flush=True)
finally:
    if cap is not None and not dispatched:
        cleanup=q.BindingRecoveryCapability(q.private_json(cap.root/'guard-envelope.json'),mode='closeout')
        result=q.closeout_binding_recovery(cleanup)
        print('RECOVERY_PURGE_VERIFIED' if result.get('rawFilesAbsent') else 'RECOVERY_PURGE_UNKNOWN',flush=True)
