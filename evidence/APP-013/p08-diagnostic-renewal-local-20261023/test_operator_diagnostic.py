import copy,datetime as dt,hashlib,importlib.util,json,os,pty,select,signal,subprocess,sys,tempfile,termios,time,unittest
from pathlib import Path
from unittest.mock import patch
ROOT=Path(__file__).parent
s=importlib.util.spec_from_file_location('op',ROOT/'controller.py');c=importlib.util.module_from_spec(s);s.loader.exec_module(c)
ACTOR='10000000-0000-4000-8000-000000000001'
def row(n=1,role='OWNER'):
 return {'id':f'10000000-0000-4000-8000-{n:012d}','tenantId':c.TENANT,'role':role,'status':'ACTIVE'}
def raw(count=1):
 return {'database':'neondb','user':'neondb_owner','tenantCount':1,'tenantStatus':'ACTIVE','actorCount':count,'actors':[row(i+1,'OWNER' if i==0 else 'ADMIN') for i in range(min(count,2))],'truncated':count>2}
def binding():
 now=time.time();b={k:c.PLAN[k] for k in ['operationId','planId','packetId']}
 b.update(mode='READ_ONLY_OPERATOR_DIAGNOSTIC',actions=c.PLAN['operatorDiagnosticActions'],automaticRetryAllowed=False,privateRetentionEndUtc=c.PLAN['retirementDeadlineUtc'],manifestSha256=c.file_sha(ROOT/'manifest.json'),proposalCommit='a'*40,proposalSha256='b'*64)
 for key,seconds in [('startUtc',-5),('cutoffUtc',60),('workEndUtc',120),('closeoutEndUtc',180)]:b[key]=dt.datetime.fromtimestamp(now+seconds,dt.timezone.utc).isoformat().replace('+00:00','Z')
 a={'decision':'APPROVED','owner':'Debynyhan Banks','operationId':b['operationId'],'mode':b['mode'],'actions':b['actions'],'automaticRetryAllowed':False,'manifestSha256':b['manifestSha256'],'bindingSha256':hashlib.sha256(json.dumps(b,sort_keys=True,separators=(',',':')).encode()).hexdigest(),'approvedAtUtc':dt.datetime.fromtimestamp(now-6,dt.timezone.utc).isoformat().replace('+00:00','Z')}
 return b,a
class OperatorDiagnosticTests(unittest.TestCase):
 def setUp(self):
  self.temp=tempfile.TemporaryDirectory(prefix='p08-op-test-',dir='/private/tmp');self.addCleanup(self.temp.cleanup);self.root=Path(self.temp.name);(self.root/'manifest.json').write_bytes((ROOT/'manifest.json').read_bytes())
 def adapter(self,value=None,closed=True):return {'input':lambda prompt:'synthetic-only','database':lambda password:json.dumps(raw() if value is None else value),'closeout':lambda password:closed}
 def test_zero_one_two_and_capped_multiple_classification(self):
  for count,expected in [(0,'ZERO_ELIGIBLE'),(1,'ONE_ELIGIBLE'),(2,'MULTIPLE_ELIGIBLE'),(3,'MULTIPLE_ELIGIBLE'),(20,'MULTIPLE_ELIGIBLE')]:
   with self.subTest(count=count):
    v=c.normalize_operator_diagnostic(json.dumps(raw(count)));self.assertEqual(v['classification'],expected);self.assertEqual(v['eligibleCount'],count);self.assertEqual(len(v['candidates']),min(count,2));self.assertEqual(v['truncated'],count>2)
 def test_invalid_output_never_becomes_zero_and_never_leaks_fields(self):
  variants=[None,{},[],dict(raw(),extra='PRIVATE_SENTINEL'),dict(raw(),tenantCount=0),dict(raw(),tenantStatus='DISABLED'),dict(raw(),database='foreign'),dict(raw(),user='other')]
  for value in [None,True,-1,1.0,'1',9007199254740992]:variants.append(dict(raw(),actorCount=value))
  variants += [dict(raw(),actors=[]),dict(raw(),actors=None),dict(raw(3),truncated=False),dict(raw(0),truncated=True),dict(raw(3),actors=[row(1),row(2),row(3)])]
  for field,value in [('id','not-a-uuid'),('id',None),('tenantId','00000000-0000-4000-8000-000000000002'),('role','TECH'),('status','DISABLED'),('email','PRIVATE_SENTINEL')]:
   v=raw();v['actors'][0][field]=value;variants.append(v)
  variants += [dict(raw(2),actors=[row(1),row(1)]),dict(raw(2),actors=[row(2),row(1)])]
  for value in variants:
   result=c.normalize_operator_diagnostic(json.dumps(value));self.assertEqual(result['classification'],'INVALID_OUTPUT');self.assertIsNone(result['eligibleCount']);self.assertEqual(result['candidates'],[]);self.assertNotIn('PRIVATE_SENTINEL',json.dumps(result))
  for text in ['not JSON','x'*16385]:self.assertEqual(c.normalize_operator_diagnostic(text)['classification'],'INVALID_OUTPUT')
 def test_exact_approval_mode_actions_window_and_retention(self):
  b,a=binding();self.assertEqual(len(c.check_operator_binding(b,a)),4)
  for key,value in [('operationId','foreign'),('mode','READ_ONLY_QUALIFICATION'),('automaticRetryAllowed',True),('actions',b['actions']+['payment']),('privateRetentionEndUtc','2026-10-24T00:00:00Z'),('proposalCommit',None)]:
   with self.subTest(key=key),self.assertRaises(c.Stop):c.check_operator_binding(dict(b,**{key:value}),a)
  for value in [None,{},dict(a,owner='other'),dict(a,mode='READ_ONLY_QUALIFICATION'),dict(a,approvedAtUtc=b['cutoffUtc'])]:
   with self.assertRaises(c.Stop):c.check_operator_binding(b,value)
  for now,code in [(c.parse_utc(b['startUtc']).timestamp()-1,'OPERATOR_NOT_YET_START'),(c.parse_utc(b['cutoffUtc']).timestamp(),'OPERATOR_START_CUTOFF')]:
   with self.assertRaises(c.Stop) as failure:c.check_operator_binding(b,a,now)
   self.assertEqual(failure.exception.code,code)
  with self.assertRaises(c.Stop):c.check_operator_binding(dict(b,closeoutEndUtc='2026-10-24T00:00:00Z'),a)
 def test_success_private_cap_public_hashes_and_one_use(self):
  b,a=binding()
  with patch.object(c,'ROOT',self.root):
   self.assertEqual(c.operator_diagnostic(b,a,self.adapter(raw(3))),'P08_OPERATOR_DIAGNOSTIC_COMPLETE_MULTIPLE_ELIGIBLE\nCONTAINMENT_VERIFIED')
   public=c.load_json('operator-diagnostic-result.json');private=c.load_json('operator-diagnostic-private.json');self.assertEqual(len(private['diagnostic']['candidates']),2);self.assertEqual(public['diagnostic']['eligibleCount'],3);self.assertTrue(public['diagnostic']['truncated']);self.assertFalse(public['operatorSelected']);self.assertFalse(public['paymentAuthorized']);self.assertNotIn(ACTOR,json.dumps(public));self.assertNotIn(c.TENANT,json.dumps(public['diagnostic']));self.assertEqual((self.root/'operator-diagnostic-private.json').stat().st_mode&0o777,0o600)
   with self.assertRaises(FileExistsError):c.operator_diagnostic(b,a,self.adapter())
 def test_invalid_result_has_no_private_payload_and_cleanup_is_truthful(self):
  b,a=binding()
  with patch.object(c,'ROOT',self.root):
   value=dict(raw(),secret='PRIVATE_SENTINEL');self.assertEqual(c.operator_diagnostic(b,a,self.adapter(value)),'P08_OPERATOR_DIAGNOSTIC_INVALID_OUTPUT\nCONTAINMENT_VERIFIED');self.assertFalse((self.root/'operator-diagnostic-private.json').exists());self.assertNotIn('PRIVATE_SENTINEL',(self.root/'operator-diagnostic-result.json').read_text())
 def test_failed_query_preserves_reason_and_no_credential_cleanup_claim(self):
  b,a=binding();adapter=self.adapter();adapter['database']=lambda password:(_ for _ in ()).throw(c.Stop('DATABASE_READ_COMMAND_FAILED'))
  with patch.object(c,'ROOT',self.root):
   self.assertEqual(c.operator_diagnostic(b,a,adapter),'P08_OPERATOR_DIAGNOSTIC_STOP_DATABASE_READ_COMMAND_FAILED\nCONTAINMENT_VERIFIED');self.assertEqual(c.load_json('operator-diagnostic-stop.json')['stage'],'OPERATOR_DATABASE_READ')
  with tempfile.TemporaryDirectory(prefix='p08-op-test-',dir='/private/tmp') as name,patch.object(c,'ROOT',Path(name)),patch.object(c,'file_sha',return_value=b['manifestSha256']):
   adapter['input']=lambda prompt:(_ for _ in ()).throw(c.Stop('INTERRUPTED'));adapter['closeout']=lambda password:self.fail('no credential available')
   self.assertIn('CONTAINMENT_UNCONFIRMED',c.operator_diagnostic(b,a,adapter))
 def test_real_signals_actual_attempt_to_exclusive_closeout_and_deadline(self):
  for signum in [signal.SIGINT,signal.SIGTERM]:
   b,a=binding()
   with tempfile.TemporaryDirectory(prefix='p08-op-test-',dir='/private/tmp') as name,patch.object(c,'ROOT',Path(name)),patch.object(c,'file_sha',return_value=b['manifestSha256']):
    adapter=self.adapter(closed=False)
    def interrupted(password):os.kill(os.getpid(),signum)
    adapter['database']=interrupted
    self.assertEqual(c.operator_diagnostic(b,a,adapter),'P08_OPERATOR_DIAGNOSTIC_STOP_INTERRUPTED\nCONTAINMENT_UNCONFIRMED');self.assertTrue(c.load_json('operator-diagnostic-attempt.json')['startedAtUtc'].endswith('Z'))
    self.assertEqual(c.operator_diagnostic_closeout(b,a,{'input':lambda prompt:'synthetic','closeout':lambda password:True}),'P08_OPERATOR_DIAGNOSTIC_CLOSEOUT_VERIFIED')
    with self.assertRaises(FileExistsError):c.operator_diagnostic_closeout(b,a,self.adapter())
    with patch.object(c.time,'time',return_value=c.parse_utc(b['closeoutEndUtc']).timestamp()),self.assertRaises(c.Stop) as expired:c.operator_diagnostic_closeout(b,a,self.adapter())
    self.assertEqual(expired.exception.code,'OPERATOR_CLOSEOUT_DEADLINE')
 def test_real_slow_read_hits_deadline_before_private_save_and_closes(self):
  b,a=binding();now=time.time()
  for k,offset in [('cutoffUtc',.1),('workEndUtc',.2),('closeoutEndUtc',1)]:b[k]=dt.datetime.fromtimestamp(now+offset,dt.timezone.utc).isoformat().replace('+00:00','Z')
  a['bindingSha256']=hashlib.sha256(json.dumps(b,sort_keys=True,separators=(',',':')).encode()).hexdigest();closed=[];adapter=self.adapter()
  def slow(password):time.sleep(.25);return json.dumps(raw())
  adapter.update(database=slow,closeout=lambda password:closed.append(True) is None)
  with patch.object(c,'ROOT',self.root):
   self.assertIn('STOP_READINESS_WINDOW_CLOSED\nCONTAINMENT_VERIFIED',c.operator_diagnostic(b,a,adapter));self.assertFalse((self.root/'operator-diagnostic-private.json').exists());self.assertEqual(closed,[True])
 def test_private_retirement_is_local_scoped_and_preserves_public_evidence(self):
  b,a=binding()
  with patch.object(c,'ROOT',self.root),patch.object(c,'psql_read',side_effect=AssertionError('no external call')):
   c.operator_diagnostic(b,a,self.adapter());public=(self.root/'operator-diagnostic-result.json').read_bytes();self.assertEqual(c.purge_operator_private(),'P08_OPERATOR_PRIVATE_RETIRED');self.assertFalse((self.root/'operator-diagnostic-private.json').exists());self.assertEqual((self.root/'operator-diagnostic-result.json').read_bytes(),public);self.assertNotIn(ACTOR,(self.root/'operator-private-retirement.json').read_text());self.assertEqual(c.purge_operator_private(),'P08_OPERATOR_PRIVATE_ALREADY_ABSENT')
 def test_retirement_refuses_foreign_and_symlink_private_receipts(self):
  with patch.object(c,'ROOT',self.root):
   c.save('operator-diagnostic-private.json',{'operationId':'foreign','retentionDeadlineUtc':c.PLAN['retirementDeadlineUtc'],'diagnostic':{}})
   with self.assertRaises(c.Stop):c.purge_operator_private()
   self.assertTrue((self.root/'operator-diagnostic-private.json').exists());(self.root/'operator-diagnostic-private.json').unlink();(self.root/'operator-diagnostic-private.json').symlink_to(ROOT/'plan.json')
   with self.assertRaises(c.Stop):c.purge_operator_private()
 def test_new_cli_is_disabled_before_input_and_payment_remains_refused(self):
  for mode in ['--operator-diagnostic','--operator-diagnostic-closeout','--run']:
   result=subprocess.run([sys.executable,'-B',str(ROOT/'controller.py'),mode],capture_output=True,text=True,timeout=10);self.assertEqual(result.returncode,2);self.assertNotIn('Enter',result.stdout);self.assertNotIn('password',result.stdout.lower())
 def test_concurrent_diagnostics_reserve_once_and_read_once(self):
  b,a=binding()
  with patch.object(c,'ROOT',self.root):c.save('fixture-binding.json',b);c.save('fixture-approval.json',a);c.save('fixture-raw.json',raw())
  script="""import importlib.util,json,pathlib,sys
s=importlib.util.spec_from_file_location('d',sys.argv[1]);c=importlib.util.module_from_spec(s);s.loader.exec_module(c);c.ROOT=pathlib.Path(sys.argv[2])
def read(password):
 with (c.ROOT/'read-count.txt').open('a') as f:f.write('read\\n')
 return (c.ROOT/'fixture-raw.json').read_text()
try:
 c.operator_diagnostic(c.load_json('fixture-binding.json'),c.load_json('fixture-approval.json'),{'input':lambda p:'synthetic','database':read,'closeout':lambda p:True})
except FileExistsError:sys.exit(2)
"""
  jobs=[subprocess.Popen([sys.executable,'-B','-c',script,str(ROOT/'controller.py'),str(self.root)],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL) for _ in range(4)];codes=[job.wait(timeout=10) for job in jobs];self.assertEqual(codes.count(0),1);self.assertEqual(codes.count(2),3);self.assertEqual((self.root/'read-count.txt').read_text().splitlines(),['read'])
 def test_manifest_and_actual_old_approval_refuse_before_input_or_reservation(self):
  b,a=binding();old=json.loads(Path('/private/tmp/p08-same-job-sandbox-20261022-timestamp1/owner-approval.json').read_text())
  with self.assertRaises(c.Stop):c.check_operator_binding(b,old)
  with patch.object(c,'ROOT',self.root),patch.object(c,'file_sha',return_value='c'*64):
   adapter=self.adapter();adapter['input']=lambda prompt:self.fail('no input before manifest binding')
   with self.assertRaises(c.Stop) as failure:c.operator_diagnostic(b,a,adapter)
   self.assertEqual(failure.exception.code,'OPERATOR_MANIFEST_BINDING');self.assertFalse((self.root/'operator-diagnostic-attempt.json').exists())
 def test_completed_and_foreign_attempt_closeout_refuse_before_input(self):
  b,a=binding()
  with patch.object(c,'ROOT',self.root):
   c.operator_diagnostic(b,a,self.adapter());adapter={'input':lambda prompt:self.fail('closed operation must not prompt')}
   with self.assertRaises(c.Stop) as failure:c.operator_diagnostic_closeout(b,a,adapter)
   self.assertEqual(failure.exception.code,'OPERATOR_ALREADY_CLOSED_NO_ACTION')
  with tempfile.TemporaryDirectory(prefix='p08-op-test-',dir='/private/tmp') as name,patch.object(c,'ROOT',Path(name)):
   c.save('operator-diagnostic-attempt.json',{'operationId':'foreign','startedAtUtc':b['startUtc']})
   with self.assertRaises(c.Stop) as failure:c.operator_diagnostic_closeout(b,a,adapter)
   self.assertEqual(failure.exception.code,'OPERATOR_CLOSEOUT_OPERATION')
 def test_diagnostic_real_hidden_pty_echo_after_signals_and_expiry(self):
  for signum in [signal.SIGINT,signal.SIGTERM,None]:
   with tempfile.TemporaryDirectory(prefix='p08-op-test-',dir='/private/tmp') as name:
    root=Path(name);b,a=binding()
    if signum is None:
     now=time.time()
     for k,offset in [('cutoffUtc',.2),('workEndUtc',.7),('closeoutEndUtc',2)]:b[k]=dt.datetime.fromtimestamp(now+offset,dt.timezone.utc).isoformat().replace('+00:00','Z')
     a['bindingSha256']=hashlib.sha256(json.dumps(b,sort_keys=True,separators=(',',':')).encode()).hexdigest()
    with patch.object(c,'ROOT',root):c.save('fixture-binding.json',b);c.save('fixture-approval.json',a)
    (root/'manifest.json').write_bytes((ROOT/'manifest.json').read_bytes())
    script="""import importlib.util,pathlib,sys
s=importlib.util.spec_from_file_location('d',sys.argv[1]);c=importlib.util.module_from_spec(s);s.loader.exec_module(c);c.ROOT=pathlib.Path(sys.argv[2])
def forbidden(*a):raise AssertionError('no external call without password')
print(c.operator_diagnostic(c.load_json('fixture-binding.json'),c.load_json('fixture-approval.json'),{'input':c.attended_input,'database':forbidden,'closeout':forbidden}),flush=True)
"""
    master,slave=pty.openpty();before=termios.tcgetattr(master);child=subprocess.Popen([sys.executable,'-B','-c',script,str(ROOT/'controller.py'),str(root)],stdin=slave,stdout=slave,stderr=slave);os.close(slave);output=b''
    try:
     until=time.monotonic()+5
     while b'(hidden):' not in output and time.monotonic()<until:
      if select.select([master],[],[],.05)[0]:output+=os.read(master,4096)
     self.assertIn(b'(hidden):',output);self.assertFalse(termios.tcgetattr(master)[3]&termios.ECHO)
     if signum:os.kill(child.pid,signum)
     child.wait(timeout=8);self.assertEqual(child.returncode,0);self.assertEqual(termios.tcgetattr(master)[3]&termios.ECHO,before[3]&termios.ECHO);stop=json.loads((root/'operator-diagnostic-stop.json').read_text());self.assertFalse(stop['sessionsAbsent']);self.assertEqual(stop['stage'],'PRIVATE_INPUT');self.assertFalse((root/'operator-diagnostic-private.json').exists())
    finally:
     if child.poll() is None:child.kill();child.wait()
     os.close(master)
 def test_immutable_operation_and_local_approval_pins_fail_closed(self):
  b,a=binding();operation=b'synthetic exact operation';preparation=b'synthetic owner-approved preparation';b['proposalSha256']=hashlib.sha256(operation).hexdigest();plan=copy.deepcopy(c.PLAN);plan['operatorDiagnosticPreparation']['decisionDocumentSha256']=hashlib.sha256(preparation).hexdigest()
  class Result:
   def __init__(self,body,code=0):self.stdout=body;self.returncode=code
  with patch.object(c,'PLAN',plan),patch.object(c,'run',return_value=''),patch.object(c,'run_status',side_effect=[Result(operation),Result(preparation)]) as reader:
   c.verify_operator_governance(b);self.assertTrue(all(call.args[0][:2]==['/usr/bin/git','show'] for call in reader.call_args_list))
  with patch.object(c,'run',return_value=' M owner-work'),patch.object(c,'run_status') as reader:
   with self.assertRaises(c.Stop) as failure:c.verify_operator_governance(b)
   self.assertEqual(failure.exception.code,'CHECKOUT_DIRTY');reader.assert_not_called()
  with patch.object(c,'run',return_value=''),patch.object(c,'run_status',return_value=Result(b'changed')):
   with self.assertRaises(c.Stop) as failure:c.verify_operator_governance(b)
   self.assertEqual(failure.exception.code,'OPERATOR_IMMUTABLE_PROPOSAL_DRIFT')
  with patch.object(c,'PLAN',plan),patch.object(c,'run',return_value=''),patch.object(c,'run_status',side_effect=[Result(operation),Result(b'',1)]):
   with self.assertRaises(c.Stop) as failure:c.verify_operator_governance(b)
   self.assertEqual(failure.exception.code,'OPERATOR_LOCAL_APPROVAL_DRIFT')
if __name__=='__main__':unittest.main()
