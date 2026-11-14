"""R46 structural signature reproduction: synthetic transports only."""
import copy,importlib, json,sys
from pathlib import Path
from unittest.mock import patch
S=Path('/Users/debynyhanbanks/Web Projects/signmons-backend-r08-recovery/evidence/APP-013/p08-native-entry-local-20261101/source')
sys.path.insert(0,str(S))
import test_entry as tmod
entry=tmod.entry

def run(case):
    t=tmod.ConnectedEntryTests();t.setUp();fake=t.f.transport;original=fake.https;created=None;trace=[];underlying=[]
    def https(desc):
        nonlocal created
        method,url=desc['method'],desc['url'];label='other'
        if '/services/' in url:label='service'
        elif 'policytroubleshooter' in url:label='policy'
        elif url.endswith('/keyString'):label='keyString'
        elif '/operations/' in url:label='poll'
        elif '/keys?keyId=' in url:label='create'
        elif '/keys/' in url:label='key'
        trace.append(method+':'+label)
        if case=='creation_etag_then_one_poll' and label=='poll':
            return {'httpStatus':200,'body':json.dumps({'name':'operations/keycreate1','done':True,'response':created})}
        if case=='creation_etag_then_one_poll' and method=='GET' and label=='key' and fake.key is not None:
            fake.key['etag']='synthetic-updated-etag'
        if case=='keystring_shape_then_cleanup_etag' and label=='keyString':
            fake.key['etag']='synthetic-updated-etag'
            return {'httpStatus':200,'body':'{}'}
        result=original(desc)
        if case=='creation_etag_then_one_poll' and label=='create':
            created=copy.deepcopy(fake.key)
            return {'httpStatus':200,'body':json.dumps({'name':'operations/keycreate1'})}
        return result
    authenticate=entry.Ports.authenticate
    def observed_auth(self,resource):
        try:return authenticate(self,resource)
        except BaseException as error:
            underlying.append(str(error) if str(error) in ('AUTH_KEY_OWNERSHIP_DRIFT','KEY_STRING_SHAPE') else type(error).__name__)
            raise
    fake.https=https
    try:
        # Only remove synthetic poll waiting; all real validators/dispatch/reducers execute.
        with patch.object(entry.time,'sleep',lambda _:None),patch.object(entry.Ports,'authenticate',observed_auth):
            work=t.run_entry();result=t.run_entry('closeout')
        journal=entry.read(t.root/'journal.json')
        out={'case':case,'underlyingFixedCode':underlying,'journalFailure':journal['failure'],
            'calls':journal['nativeEntry']['calls'],'authAttempted':journal['authAttempted'],
            'authClientPresent':'authClient' in journal,'keyDeleteAttempted':journal['keyDeleteAttempted'],
            'privateInputsAbsent':result['privateInputsAbsent'],'residuals':result['residuals'],
            'simulatedProviderKeyStillPresent':not bool(fake.key.get('deleteTime')),'httpsTrace':trace}
        assert journal['failure']=='LOCAL_ADAPTER_OR_SOURCE_STOP'
        assert journal['authAttempted'] and not journal['authProofAccepted'] and 'authClient' not in journal
        assert journal['nativeEntry']['calls']=={'child':1,'cli':191,'https':14,'sql':10}
        assert result['residuals']==['ACCOUNT_SESSION','AUTH_OUTCOME_UNKNOWN','AUTH_REVOKE','OWNED_KEY']
        assert journal['keyDeleteAttempted'] and not fake.key.get('deleteTime')
        return out
    finally:t.doCleanups()

if __name__=='__main__':print(json.dumps([run(x) for x in ('creation_etag_then_one_poll','keystring_shape_then_cleanup_etag')],indent=2))
