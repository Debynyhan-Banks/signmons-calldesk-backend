"""Refresh only current source manifests; never touch historical locks/receipts."""
from pathlib import Path
import hashlib,json
HERE=Path(__file__).resolve().parent;APP=HERE.parent;BACKEND=APP.parent.parent
q=APP/'p08-https-output-category-local-20261029/source';n=APP/'p08-native-entry-local-20261101/source'
def sha(p):return hashlib.sha256(p.read_bytes()).hexdigest()
def save(p,v):p.write_text(json.dumps(v,indent=2,sort_keys=True)+'\n')
v=json.loads((q/'source-manifest.json').read_text())
for k in v['files']:v['files'][k]=sha(q/k)
for k in v['producerDependencies']:v['producerDependencies'][k]=sha(APP/k)
save(q/'source-manifest.json',v)
v=json.loads((n/'source-manifest.json').read_text())
for k in v['files']:v['files'][k]=sha(n/k)
for k in v['lockedSources']:
 if k.startswith(('p08-https-output-category-local-20261029/','p08-key-correction-20261110/')):v['lockedSources'][k]=sha(APP/k)
save(n/'source-manifest.json',v)
v=json.loads((n/'test-manifest.json').read_text())
for k in v['files']:v['files'][k]=sha(n/k)
v['runtimeManifestSha256']=sha(n/'source-manifest.json');save(n/'test-manifest.json',v)
files={p for p in HERE.iterdir() if p.suffix in ('.py','.mjs') or p.name=='candidate.json'}
for root,dep in [(q,'producerDependencies'),(n,'lockedSources')]:
 v=json.loads((root/'source-manifest.json').read_text());files.add(root/'source-manifest.json')
 files|={root/name for name in v['files']};files|={APP/name for name in v[dep]}
files.add(APP/'p08-connected-packet-20261110/packet.py')
save(HERE/'source-manifest.json',{'status':'LOCAL_IMPLEMENTATION_NO_EXTERNAL_AUTHORITY','files':{str(p.relative_to(BACKEND)):sha(p) for p in files}})
