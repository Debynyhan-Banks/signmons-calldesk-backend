from pathlib import Path
import sys,json,copy,io,contextlib
from unittest.mock import patch
B=Path('/Users/debynyhanbanks/Web Projects/signmons-backend-r08-recovery');sys.path.insert(0,str(B/'evidence/APP-013/p08-connected-packet-20261110'))
import packet,connected_launcher,test_packet
q=packet.q;a=q.current_module('authority');f=test_packet.PacketTests();f.setUp();results=[]
try:
 e=packet.construct_values(f.spec,f.values,'we_synthetic',f.cap);times={k:q.model.timestamp(v) for k,v in f.spec['prospectiveWindow'].items()}
 for case in ['synthetic_endpoint_pin','synthetic_timing']:
  payment=copy.deepcopy(e['nativeScope']['payment'])
  if case=='synthetic_timing':payment['workEnd']=f.spec['prospectiveWindow']['start']
  try:a.validate_payment({'payment':payment,'execution':'EXTERNAL'},times)
  except Exception as error:
   out=io.StringIO()
   with patch.object(packet,'construct',side_effect=error),contextlib.redirect_stdout(out):
    code=connected_launcher.main(f.spec,read_hidden=lambda _: 'we_synthetic')
   results.append({'case':case,'actualValidatorCode':str(error),'exceptionClass':type(error).__name__,'recognizedByLauncher':isinstance(error,q.model.Stop),'exitCode':code,'launcherOutput':out.getvalue().splitlines()})
finally:f.doCleanups()
assert {r['actualValidatorCode'] for r in results}=={'PAYMENT_ENDPOINT_PIN','PAYMENT_TIMING'}
assert all(r['launcherOutput']==['CONNECTED_STAGE_PACKET_PREPARATION','CONNECTED_STOP_Stop'] for r in results)
print(json.dumps({'status':'LOCAL_EXCEPTION_MASKING_REPRODUCED','cases':results,'r42UnderlyingCause':'UNKNOWN;original inputs purged','providerCalls':0,'credentialReads':0},indent=2))
