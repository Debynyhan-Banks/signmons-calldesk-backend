import sys,json,io,datetime
from pathlib import Path
from types import SimpleNamespace
B=Path('/Users/debynyhanbanks/Web Projects/signmons-backend-r08-recovery');N=B/'evidence/APP-013/p08-native-entry-local-20261101/source';sys.path.insert(0,str(N));import test_entry as t
SDK='/opt/homebrew/Caskroom/gcloud-cli/583.0.0/google-cloud-sdk/lib';sys.path[:0]=[SDK,SDK+'/third_party']
from googlecloudsdk.core.resource import resource_printer
from googlecloudsdk.api_lib.run import traffic_pair
# Installed SDK's concrete returned collection serialized through its actual printer.
target=SimpleNamespace(percent=100,tag=None,url='',revisionName='synthetic-normal',latestRevision=False)
pair=traffic_pair.TrafficTargetPair([target],[target],'synthetic-normal',False,None)
out=io.StringIO();resource_printer.Print([pair],'json',out=out);raw=out.getvalue();results=[]
for enabled in [True,False]:
 fake=SimpleNamespace(cap=SimpleNamespace(plan={'iam':[]}),restore=t.entry.restore,cli=lambda v:raw)
 try:t.entry.NativeIO.cloud(fake,t.entry.restore.command({'iam':[]},'tag',t.entry.restore.TAG,enabled),0);failure=None
 except Exception as exc:failure=str(exc)
 results.append({'enabled':enabled,'sdkOutputType':type(json.loads(raw)).__name__,'adapterFailure':failure})
f=t.ConnectedEntryTests();f.setUp()
try:
 def factory(cap):
  obj=f.factory(cap);cloud=obj.cloud
  def altered(v,deadline):
   if v[:3]==['run','services','update-traffic']:
    cloud(v,deadline)
    raise t.Stop('NATIVE_OUTPUT_SHAPE')
   return cloud(v,deadline)
  obj.cloud=altered;return obj
 work=t.entry.run_entry(f.path,io_factory=factory)
 try:closed=t.entry.run_entry(f.path,'closeout',io_factory=factory);stop=None
 except Exception as exc:closed=None;stop=type(exc).__name__+':'+str(exc)
 r={'verifiedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'providerCalls':0,'credentialReads':0,'serialization':results,'syntheticWorkStatus':work['status'],'syntheticIndependentStop':stop,'syntheticCloseoutStatus':None if closed is None else closed['status'],'historicalCause':'UNKNOWN'}
 print(json.dumps(r));(B/'evidence/APP-013/p08-connected-packet-20261110/r39-local-diagnosis.json').write_text(json.dumps(r,indent=2)+'\n')
finally:f.doCleanups()
