import unittest,tempfile,json,uuid,hashlib,time,sys,subprocess
from pathlib import Path
import launch as m
class DiagnosticTests(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup);self.base=Path(self.tmp.name)
  self.s={'operationId':str(uuid.uuid4()),'sourceCommit':'a'*40,'files':{},'sdkFiles':{},'projectNumberSha256':'37d4aa0f46ca5b8f0b81b1148bda235a0f4a9a424b6b4638ec993d889563be54','window':{'start':1,'cutoff':20,'end':30}}
  self.d={'owner':'Debynyhan Banks','decision':'APPROVE_EXACT_SECRET_READ_DIAGNOSTIC','externalReadAuthorized':True,'scopeSha256':m.digest(self.s)};self.calls=[]
 def invoke(self,argv,deadline,data):
  self.calls.append(argv)
  if argv[1:3]==['auth','list']:return b'debynyhan@signmons.com\n'
  if argv[1:3]==['config','get-value']:return b'(unset)\n'
  if argv[1:3]==['projects','describe']:return b'123456789012\n'
  raise AssertionError('No credential read allowed after wrong project')
 def test_project_mismatch_stops_before_token_or_http(self):
  r=m.execute(self.s,self.d,invoke=self.invoke,clock=lambda:2,root_base=self.base)
  self.assertEqual(r['sdkCommands'],5);self.assertEqual(r['stage'],'PROJECT_LOOKUP');self.assertEqual(r['requests'],0)
  self.assertEqual(sorted(p.name for p in next(self.base.iterdir()).iterdir()),['attempt.json','result.json'])
 def test_one_attempt_refuses_replay(self):
  m.execute(self.s,self.d,invoke=self.invoke,clock=lambda:2,root_base=self.base)
  with self.assertRaises(FileExistsError):m.execute(self.s,self.d,invoke=self.invoke,clock=lambda:2,root_base=self.base)
  self.assertEqual(len(self.calls),5)
 def test_wrong_approval_refuses_before_root(self):
  self.d['externalReadAuthorized']=False
  with self.assertRaises(RuntimeError):m.execute(self.s,self.d,invoke=self.invoke,clock=lambda:2,root_base=self.base)
  self.assertEqual(list(self.base.iterdir()),[])
 def test_expired_refuses_before_root(self):
  with self.assertRaises(RuntimeError):m.execute(self.s,self.d,clock=lambda:20,root_base=self.base)
  self.assertEqual(list(self.base.iterdir()),[])
 def test_interruption_records_safe_failure(self):
  def stop(*_):raise KeyboardInterrupt('PRIVATE_SENTINEL')
  r=m.execute(self.s,self.d,invoke=stop,clock=lambda:2,root_base=self.base)
  self.assertEqual(r['status'],'DIAGNOSTIC_UNCONFIRMED');self.assertNotIn('PRIVATE_SENTINEL',json.dumps(r))
 def test_clock_rollback_stops_before_command(self):
  ticks=iter([2,2,2,1]);r=m.execute(self.s,self.d,invoke=self.invoke,clock=lambda:next(ticks),root_base=self.base)
  self.assertEqual(self.calls,[]);self.assertEqual(r['status'],'DIAGNOSTIC_UNCONFIRMED')
 def test_actual_child_timeout_is_reaped(self):
  pidfile=self.base/'pid'
  script='import os,time;open('+repr(str(pidfile))+',"w").write(str(os.getpid()));time.sleep(20)'
  with self.assertRaises(subprocess.TimeoutExpired):m.command([sys.executable,'-c',script],time.time()+.3)
  import os
  with self.assertRaises(ProcessLookupError):os.kill(int(pidfile.read_text()),0)
 def test_success_is_six_commands_one_secret_request_and_no_raw_files(self):
  from unittest.mock import patch
  real=m.hashlib.sha256
  class Pin:
   def hexdigest(self):return self.s['projectNumberSha256']
  pin=Pin();pin.s=self.s
  def sha(data=b''):return pin if data==b'123456789012' else real(data)
  def invoke(argv,deadline,data):
   if argv[0]==m.NODE:
    self.calls.append(argv);v=json.loads(data);self.assertEqual(v['token'],'PRIVATE_SENTINEL_TOKEN_123456');self.assertEqual(v['projectNumber'],'123456789012')
    return json.dumps({'code':'TEST_KEY_VALID','httpStatus':200,'providerReason':None,'requests':1}).encode()
   if argv[1:3]==['auth','print-access-token']:self.calls.append(argv);return b'PRIVATE_SENTINEL_TOKEN_123456\n'
   return self.invoke(argv,deadline,data)
  with patch.object(m.hashlib,'sha256',side_effect=sha):r=m.execute(self.s,self.d,invoke=invoke,clock=lambda:2,root_base=self.base)
  self.assertEqual(r['status'],'DIAGNOSTIC_OBSERVED');self.assertEqual(r['sdkCommands'],6);self.assertEqual(r['requests'],1)
  for p in next(self.base.iterdir()).iterdir():self.assertNotIn('PRIVATE_SENTINEL',p.read_text())
 def test_concurrent_attempts_only_one_dispatch(self):
  from concurrent.futures import ThreadPoolExecutor
  with ThreadPoolExecutor(max_workers=2) as pool:
   futures=[pool.submit(m.execute,self.s,self.d,self.invoke,lambda:2,self.base) for _ in range(2)]
   outcomes=[]
   for f in futures:
    try:f.result();outcomes.append('attempt')
    except FileExistsError:outcomes.append('refused')
  self.assertEqual(sorted(outcomes),['attempt','refused']);self.assertEqual(len(self.calls),5)
