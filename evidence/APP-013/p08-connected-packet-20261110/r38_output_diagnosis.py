import sys,io,json,hashlib,datetime
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
B=Path('/Users/debynyhanbanks/Web Projects/signmons-backend-r08-recovery');E=B/'evidence/APP-013/p08-connected-packet-20261110';sys.path.insert(0,str(E))
import packet
sys.path.insert(0,str(B/'evidence/APP-013/p08-native-entry-local-20261101/source'))
q=packet.q;a=q.current_module('authority');native=a.load('p08-native-entry-local-20261101/source/native_io.py','diagnosis_native_io');restore=a.load('p08-restoration-local-20261028/source/restore.py','diagnosis_restore')
SDK=Path('/opt/homebrew/Caskroom/gcloud-cli/583.0.0/google-cloud-sdk/lib');sys.path[:0]=[str(SDK),str(SDK/'third_party')]
from googlecloudsdk.command_lib.iam import hooks
from googlecloudsdk.core.resource import resource_printer
cases=[]
for enabled,hook in [(True,hooks.EnableIamAccountConfirmation),(False,hooks.DisableIamAccountConfirmation)]:
 verb='enable' if enabled else 'disable';args=SimpleNamespace(command_path=['iam','service-accounts',verb],service_account='synthetic')
 with patch.object(hooks.log.status,'Print'):
  response=hook(object(),args)
 out=io.StringIO();resource_printer.Print(response,'json',out=out);raw=out.getvalue().strip();calls=[]
 def cli(vector):calls.append(vector);return raw
 fake=SimpleNamespace(cap=SimpleNamespace(plan={'iam':[]}),restore=restore,cli=cli)
 error=None
 try:native.NativeIO.cloud(fake,restore.command({'iam':[]},'identity',restore.IDENTITY,enabled),0)
 except Exception as exc:error=str(exc)
 assert response is None and raw=='[]' and error=='NATIVE_OUTPUT_SHAPE' and len(calls)==1 and calls[0][-1]=='--format=json'
 cases.append({'verb':verb,'sdkHookReturnsNone':True,'sdkJsonOutput':raw,'actualNativeAdapterFailure':error})
files=['surface/iam/service_accounts/enable.yaml','surface/iam/service_accounts/disable.yaml','googlecloudsdk/command_lib/iam/hooks.py','googlecloudsdk/core/resource/json_printer.py','googlecloudsdk/core/resource/resource_printer_base.py','googlecloudsdk/command_lib/util/apis/yaml_command_translator.py']
r={'verifiedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'providerCalls':0,'credentialReads':0,'cases':cases,'sdkFiles':{n:hashlib.sha256((SDK/n).read_bytes()).hexdigest() for n in files},'historicalR38Cause':'UNKNOWN; reproduced mismatch is consistent with recorded stop','currentIdentityState':'DISABLED verified by IR2; no new read'}
(E/'r38-output-local-diagnosis.json').write_text(json.dumps(r,indent=2)+'\n');print(json.dumps({'cases':cases,'providerCalls':0}))
