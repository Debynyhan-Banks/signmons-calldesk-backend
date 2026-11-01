"""Create only synthetic local envelope/journal inputs for child transport tests."""
import json
from pathlib import Path
from test_entry import EntryTests
from private_inventory import reserve
from authority import digest


def child_fixture(test):
    e=test.e;p=e['plan']
    receipt={'operationId':p['operationId'], 'keyResource':f"projects/{p['projectNumber']}/locations/global/keys/{p['keyId']}",
             'uid':'synthetic-uid','etag':'synthetic-etag','displayName':'Signmons P08 '+p['operationId'],
             'restrictions':{'apiTargets':[{'service':'identitytoolkit.googleapis.com'}]},
             'keyStringSha256':__import__('hashlib').sha256(b'synthetic-only-key').hexdigest(),
             'createdInOperation':True,'deleted':False,'ownedAt':p['window']['start']}
    reserve(test.root/'attempt.json',{'operationId':p['operationId'],'planSha256':digest(p)})
    reserve(test.root/'journal.json',{'operationId':p['operationId'],'planSha256':digest(p),
        'phase':'PREFLIGHT','authAttempted':True,'keyCreateAttempted':True,
        'keyUidSha256':__import__('hashlib').sha256(b'synthetic-uid').hexdigest(),
        'keyDeleteAttempted':False,'authProofAccepted':False,
        'nativeEntry':{'envelopeSha256':digest(e),'calls':{'cli':0,'sql':0,'https':0,'child':1}}})
    return {'envelopePath':str(test.path),'receipt':receipt,'childCall':1,
            'credentials':{'password':'SYNTHETIC_HIDDEN_PASSWORD','accessToken':'SYNTHETIC_OWNER_OAUTH_TOKEN'}}

if __name__=='__main__':
    t=EntryTests();t.setUp()
    print(json.dumps({'request':child_fixture(t),'cleanup':[str(t.root),str(t.f.private)]}))
