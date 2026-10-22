import sys,ast,copy,datetime as dt,hashlib,importlib.util,json,os,pty,select,signal,subprocess,tempfile,termios,time,unittest
from pathlib import Path
from unittest.mock import patch
ROOT=Path(__file__).parent
s=importlib.util.spec_from_file_location('p08',ROOT/'controller.py');c=importlib.util.module_from_spec(s);s.loader.exec_module(c)
NOW=dt.datetime(2026,10,22,23,tzinfo=dt.timezone.utc).timestamp()
def binding():
 b={'operationId':c.PLAN['operationId'],'planId':c.PLAN['planId'],'packetId':c.PLAN['packetId'],'mode':'READ_ONLY_QUALIFICATION','automaticRetryAllowed':False,'actions':c.PLAN['readOnlyActions'],'manifestSha256':c.file_sha(ROOT/'manifest.json'),'proposalCommit':'a'*40,'proposalSha256':'b'*64}
 for k,v in [('startUtc',-60),('cutoffUtc',60),('workEndUtc',120),('closeoutEndUtc',180)]:b[k]=dt.datetime.fromtimestamp(NOW+v,dt.timezone.utc).isoformat().replace('+00:00','Z')
 a={'decision':'APPROVED','owner':'Debynyhan Banks','operationId':c.PLAN['operationId'],'mode':'READ_ONLY_QUALIFICATION','bindingSha256':hashlib.sha256(json.dumps(b,sort_keys=True,separators=(',',':')).encode()).hexdigest(),'manifestSha256':b['manifestSha256'],'automaticRetryAllowed':False,'actions':c.PLAN['readOnlyActions'],'approvedAtUtc':'2026-10-22T20:00:00Z'}
 return b,a
class Tests(unittest.TestCase):
 def setUp(self):self.temp=tempfile.TemporaryDirectory(prefix='p08-test-',dir='/private/tmp');self.addCleanup(self.temp.cleanup)
 def test_private_modes_exclusive_reservation_and_symlink(self):
  with patch.object(c,'ROOT',Path(self.temp.name)):
   c.save('attempt.json',{'one':True});self.assertEqual((Path(self.temp.name)/'attempt.json').stat().st_mode&0o777,0o600)
   with self.assertRaises(FileExistsError):c.save('attempt.json',{})
   (Path(self.temp.name)/'linked.json').symlink_to(Path(self.temp.name)/'attempt.json')
   with self.assertRaises(OSError):c.save('linked.json',{})
 def test_actual_concurrent_reservation_one_winner(self):
  script="import importlib.util, pathlib,sys; s=importlib.util.spec_from_file_location('c',sys.argv[1]); c=importlib.util.module_from_spec(s);s.loader.exec_module(c);c.ROOT=pathlib.Path(sys.argv[2]);c.save('reserved.json',{'one':True})"
  jobs=[subprocess.Popen([sys.executable,'-B','-c',script,str(ROOT/'controller.py'),self.temp.name],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL) for _ in range(4)]
  codes=[j.wait(timeout=10) for j in jobs];self.assertEqual(codes.count(0),1)
 def test_bindings_no_window_wrong_operation_extra_action_and_approval(self):
  b,a=binding();self.assertEqual(len(c.check_binding(b,a,NOW)),4)
  for field,value in [('operationId','foreign'),('mode','PAYMENT'),('automaticRetryAllowed',True),('actions',c.PLAN['readOnlyActions']+['payment'])]:
   v=copy.deepcopy(b);v[field]=value
   with self.subTest(field=field),self.assertRaises(c.Stop):c.check_binding(v,a,NOW)
  for v in [None,{},dict(a,owner='someone'),dict(a,automaticRetryAllowed=True)]:
   with self.assertRaises(c.Stop):c.check_binding(b,v,NOW)
  with self.assertRaises(c.Stop):c.check_binding(None,a,NOW)
 def test_start_cutoff_expiry_and_retirement_boundaries(self):
  b,a=binding()
  for now in [NOW-61,NOW+60,NOW+200]:
   with self.assertRaises(c.Stop):c.check_binding(b,a,now)
  v=dict(b,closeoutEndUtc='2026-10-24T00:00:00Z')
  with self.assertRaises(c.Stop):c.check_binding(v,a,NOW)
 def test_no_action_cli_and_helper_do_not_prompt_or_call_provider(self):
  for args in [['--qualify'],['--authorize-helper'],['--closeout'],['--run']]:
   r=subprocess.run([sys.executable,'-B',str(ROOT/'controller.py'),*args],capture_output=True,timeout=10)
   self.assertNotEqual(r.returncode,0);self.assertNotIn(b'password',r.stdout.lower());self.assertNotIn(b'Enter',r.stdout)
 def test_firebase_child_cannot_bypass_approval(self):
  r=subprocess.run([c.NODE,str(ROOT/'operator-bridge.mjs'),'--firebase-read'],input=json.dumps({'actorId':'10000000-0000-4000-8000-000000000001'}).encode(),capture_output=True,timeout=15)
  self.assertNotEqual(r.returncode,0);self.assertNotIn(b'Bearer',r.stdout)
 def test_readonly_sql_exact_only(self):
  with patch.object(c,'run') as run:
   with self.assertRaises(c.Stop):c.psql_read('never-used','UPDATE "Job" SET status=\'COMPLETED\'')
   run.assert_not_called()
  self.assertIn('REPEATABLE READ READ ONLY',c.QUALIFICATION_SQL);self.assertTrue(c.QUALIFICATION_SQL.rstrip().endswith('ROLLBACK;'))
 def test_readonly_adapter_success_closeout_no_mutation(self):
  b,a=binding();called=[]
  adapters={'input':lambda prompt:'synthetic','cloud':lambda:{'metadata':True},'stripe':lambda:{'mockRead':True},'database':lambda p:{'actorId':'10000000-0000-4000-8000-000000000001'},'firebase':lambda actor:{'disabled':True},'closeout':lambda p:called.append('closeout') is None}
  with patch.object(c,'ROOT',Path(self.temp.name)),patch.object(c,'file_sha',return_value=b['manifestSha256']),patch.object(c.time,'time',return_value=NOW):
   self.assertEqual(c.qualify(b,a,adapters),'P08_READ_ONLY_OPERATOR_QUALIFICATION_COMPLETE');v=json.loads((Path(self.temp.name)/'qualification-result.json').read_text());self.assertFalse(v['businessMutation']);self.assertFalse(v['paymentAuthorized'])
   with self.assertRaises(FileExistsError):c.qualify(b,a,adapters)
  self.assertEqual(called,['closeout'])
 def test_real_deadline_prevents_later_stage(self):
  visited=[]
  def slow():time.sleep(.03)
  v=c.model_payment_operation([('slow',slow),('forbidden',lambda:visited.append(True))],[('close',lambda:None)],time.time()+.01,time.time()+1)
  self.assertFalse(visited);self.assertIsNotNone(v['failure']);self.assertTrue(v['containmentVerified'])
 def test_each_modeled_mutation_failure_and_cleanup_residual(self):
  stages=['user_activation','signing_binding','role_open','policy_bind','checkout','signed_settlement']
  for at in stages:
   visited=[]
   def action(name):
    def do():
     visited.append(name)
     if name==at:raise c.Stop('INJECTED_'+name.upper())
    return do
   closed=[];v=c.model_payment_operation([(n,action(n)) for n in stages],[(n,lambda n=n:closed.append(n)) for n in reversed(stages)],time.time()+5,time.time()+6)
   self.assertEqual(visited[-1],at);self.assertEqual(len(closed),len(stages));self.assertTrue(v['containmentVerified'])
  def fail():raise RuntimeError('synthetic secret must not be copied')
  v=c.model_payment_operation([], [('role',fail),('identity',lambda:None)],time.time()+1,time.time()+1);self.assertEqual(v['residual'],['role']);self.assertFalse(v['containmentVerified']);self.assertNotIn('secret',str(v))
 def test_command_deadline_kills_slow_local_child(self):
  start=time.monotonic()
  with self.assertRaises(c.Stop),c.phase_guard(time.time()+.1):c.run([sys.executable,'-c','import time;time.sleep(10)'],timeout=10)
  self.assertLess(time.monotonic()-start,2)
 def test_readonly_failures_preserve_stage_and_truthful_closeout(self):
  b,a=binding()
  for stage in ['cloud','database','firebase']:
   adapters={'input':lambda p:'synthetic','cloud':lambda:{},'stripe':lambda:{'mockRead':True},'database':lambda p:{'actorId':'synthetic'},'firebase':lambda a:{},'closeout':lambda p:True}
   def fail(*a):raise c.Stop('TEST_REFUSAL')
   adapters[stage]=fail
   with tempfile.TemporaryDirectory() as root,patch.object(c,'ROOT',Path(root)),patch.object(c,'file_sha',return_value=b['manifestSha256']),patch.object(c.time,'time',return_value=NOW):
    self.assertIn('CONTAINMENT_VERIFIED',c.qualify(b,a,adapters));self.assertEqual(json.loads((Path(root)/'qualification-stop.json').read_text())['stage'],{'cloud':'CLOUD_METADATA','database':'DATABASE_READ','firebase':'FIREBASE_READ'}[stage])
  adapters['closeout']=lambda p:False
  with tempfile.TemporaryDirectory() as root,patch.object(c,'ROOT',Path(root)),patch.object(c,'file_sha',return_value=b['manifestSha256']),patch.object(c.time,'time',return_value=NOW):self.assertIn('CONTAINMENT_UNCONFIRMED',c.qualify(b,a,adapters))
 def test_no_credential_cleanup_claim(self):
  b,a=binding();adapter={'input':lambda p:(_ for _ in ()).throw(c.Stop('INTERRUPTED')),'closeout':lambda p:self.fail('no password available')}
  with patch.object(c,'ROOT',Path(self.temp.name)),patch.object(c,'file_sha',return_value=b['manifestSha256']),patch.object(c.time,'time',return_value=NOW):self.assertIn('CONTAINMENT_UNCONFIRMED',c.qualify(b,a,adapter))
 def test_firebase_absent_disabled_and_collision(self):
  actor='10000000-0000-4000-8000-000000000001';self.assertEqual(c.classify_firebase({'exists':False},actor)['status'],'ISOLATED_IDENTITY_REQUIRED')
  v={k:True for k in ['exists','uidMatches','disabled','tenantMatches','roleAllowed','stagingOnly','claimsExact']};self.assertEqual(c.classify_firebase(v,actor)['status'],'ISOLATED_DISABLED_IDENTITY_MATCH')
  for k in v:
   wrong=dict(v);wrong[k]=False
   with self.assertRaises(c.Stop):c.classify_firebase(wrong,actor)
 def test_real_pty_secret_echo_restored_after_signals_and_deadline(self):
  for signum in [signal.SIGINT,signal.SIGTERM,None]:
   script="""import importlib.util,sys,time,pathlib,json
s=importlib.util.spec_from_file_location('c',sys.argv[1]);c=importlib.util.module_from_spec(s);s.loader.exec_module(c)
def action():
 with c.phase_guard(time.time()+.3 if sys.argv[3]=='0' else time.time()+5):c.attended_input('Hidden local input: ')
def clean():pathlib.Path(sys.argv[2]).write_text('clean')
v=c.model_payment_operation([('input',action)],[('close',clean)],time.time()+5,time.time()+6)
print(json.dumps(v))
"""
   master,slave=pty.openpty();before=termios.tcgetattr(master);marker=Path(self.temp.name)/str(signum)
   child=subprocess.Popen([sys.executable,'-B','-c',script,str(ROOT/'controller.py'),str(marker),str(signum or 0)],stdin=slave,stdout=slave,stderr=slave);os.close(slave);out=b''
   try:
    until=time.monotonic()+5
    while b'Hidden local input:' not in out and time.monotonic()<until:
     if select.select([master],[],[],.1)[0]:out+=os.read(master,4096)
    self.assertIn(b'Hidden local input:',out);self.assertFalse(termios.tcgetattr(master)[3]&termios.ECHO)
    if signum:os.kill(child.pid,signum)
    child.wait(timeout=8);self.assertTrue(marker.exists());self.assertEqual(termios.tcgetattr(master)[3]&termios.ECHO,before[3]&termios.ECHO)
   finally:
    if child.poll() is None:child.kill();child.wait()
    os.close(master)
 def test_normalizer_fixed_reason_is_not_lost_on_nonzero_exit(self):
  class R:returncode=1;stdout=b'{"status":"REFUSED","code":"ACTOR_UUID_REQUIRED"}'
  with patch.object(c,'run_status',return_value=R()):
   with self.assertRaises(c.Stop) as e:c.node_json(['--normalize'],{})
   self.assertEqual(e.exception.code,'ACTOR_UUID_REQUIRED')
 def test_stripe_readback_requires_exact_current_operation_disabled_destination(self):
  v={'operationId':c.PLAN['operationId'],'mode':'SANDBOX_TEST','accountAdmin':True,'enabledConnectedAccounts':1,'connectedAccountSha256':c.PLAN['connectedAccountSha256'],'destinationDisabled':True,'deliveryAttempts':0,'urlExact':True,'eventHash':c.PLAN['stripeEventHash'],'apiVersion':c.PLAN['stripeApiVersion'],'connectedAccountsScope':True}
  self.assertEqual(c.validate_stripe(v),v)
  for k,bad in [('mode','LIVE'),('operationId','old'),('deliveryAttempts',1),('destinationDisabled',False),('urlExact',False),('apiVersion','preview')]:
   with self.assertRaises(c.Stop):c.validate_stripe(dict(v,**{k:bad}))
 def test_hidden_input_fallback_is_forbidden(self):
  with patch.object(c.os,'isatty',return_value=False):
   with self.assertRaises(c.Stop):c.attended_input('never')
 def test_cloud_snapshot_rejects_traffic_flags_identity_and_environment_drift(self):
  # Reuse existing proved synthetic snapshot factories, never their live controller.
  spec=importlib.util.spec_from_file_location('p07fixtures',Path('/private/tmp/p07-repaired-runtime-readiness-20261022-sql-contract1/test_controller.py'));m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m);f=m.Tests();service=f.service(True)
  revision=copy.deepcopy(service['spec']['template']);revision['spec']['serviceAccountName']=c.PLAN['serviceIdentity'];revision['status']={'imageDigest':c.PLAN['image'],'conditions':[{'type':'Ready','status':'True'}]}
  required={'NODE_ENV':'production','GOOGLE_CLOUD_PROJECT':'signmons','DEV_AUTH_ENABLED':'false','SCHEDULING_ENABLED':'false','STRIPE_WEBHOOK_LIVEMODE':'false','SMS_DELIVERY_ENABLED':'false','BACKGROUND_WORKERS_ENABLED':'false','STAGING_PHONE_TEST_ENABLED':'false','ENABLED_TOOLS':'none','WEBCHAT_INTEGRATIONS_JSON':'[]','TWILIO_TENANT_IDENTITIES_JSON':'[]','CUSTOMER_PAYMENT_RETURN_URL':'https://staging.signmons.com/payment/status'}
  pins={'DATABASE_URL':'signmons-staging-p07-payment-database-url','STRIPE_SECRET_KEY':'signmons-staging-stripe-secret-key','STRIPE_WEBHOOK_SECRET':'signmons-staging-p07-stripe-webhook-secret','OPENAI_API_KEY':'signmons-staging-p07-disabled-openai-key','ADMIN_API_TOKEN':'signmons-staging-p07-admin-token','CONVERSATION_DATA_ENCRYPTION_KEY':'signmons-staging-p07-conversation-key','TECHNICIAN_LINK_SECRET':'signmons-staging-p07-technician-link-key'}
  revision['spec']['containers'][0]['env']=[{'name':k,'value':v} for k,v in required.items()]+[{'name':k,'valueFrom':{'secretKeyRef':{'name':v,'key':'1'}}} for k,v in pins.items()]
  result=c.classify_cloud(service,revision,{'bindings':[]});self.assertEqual(result['effectiveFirebaseLookup'],'NOT_ESTABLISHED');self.assertEqual(result['candidateTrafficPercent'],0)
  for target in ['traffic','identity','cpu','environment','secret','ready']:
   a=copy.deepcopy(service);b=copy.deepcopy(revision)
   if target=='traffic':a['status']['traffic'][0]['percent']=99
   if target=='identity':b['spec']['serviceAccountName']='foreign'
   if target=='cpu':b['spec']['containers'][0]['resources']['limits']['cpu']='2'
   if target=='environment':b['spec']['containers'][0]['env'].append({'name':'DEV_AUTH_SECRET','value':'fictional'})
   if target=='secret':b['spec']['containers'][0]['env'][-1]['valueFrom']['secretKeyRef']['key']='latest'
   if target=='ready':b['status']['conditions'][0]['status']='False'
   with self.subTest(target=target),self.assertRaises(c.Stop):c.classify_cloud(a,b,{'bindings':[]})
 def test_readonly_closeout_has_one_use_and_no_qualification_replay(self):
  b,a=binding()
  for successful in [True,False]:
   with tempfile.TemporaryDirectory() as root,patch.object(c,'ROOT',Path(root)),patch.object(c.time,'time',return_value=NOW):
    c.save('qualification-attempt.json',{'operationId':c.PLAN['operationId'],'startedAtUtc':'2026-10-22T23:00:00Z'})
    v=c.readonly_closeout(b,a,{'input':lambda p:'synthetic','closeout':lambda p:successful})
    self.assertEqual(v,'P08_READ_ONLY_CLOSEOUT_VERIFIED' if successful else 'P08_MANDATORY_CLOSEOUT_UNCONFIRMED')
    with self.assertRaises(FileExistsError):c.readonly_closeout(b,a,{'input':lambda p:self.fail('no repeated input')})
 def test_closeout_refuses_successful_or_expired_operation(self):
  b,a=binding()
  with patch.object(c,'ROOT',Path(self.temp.name)),patch.object(c.time,'time',return_value=NOW+181):
   c.save('qualification-attempt.json',{'operationId':c.PLAN['operationId'],'startedAtUtc':'2026-10-22T23:00:00Z'})
   with self.assertRaises(c.Stop):c.readonly_closeout(b,a,{})
  with patch.object(c,'ROOT',Path(self.temp.name)),patch.object(c.time,'time',return_value=NOW):
   c.save('qualification-result.json',{'sessionsAbsent':True})
   with self.assertRaises(c.Stop):c.readonly_closeout(b,a,{})
 def test_psql_drops_inherited_pg_environment_and_uses_verified_tls(self):
  captured={}
  class Result:returncode=0;stdout=b'0\n'
  def fake(args,**kwargs):captured.update({k:dict(v) if k=='env' else v for k,v in kwargs.items()});return Result()
  with patch.dict(os.environ,{'PGHOSTADDR':'198.51.100.1','PGSERVICE':'fictional-other','PGPASSFILE':'/fictional','DATABASE_URL':'not-used'}),patch.object(c.subprocess,'run',side_effect=fake):
   self.assertEqual(c.psql_read('synthetic',c.CLOSEOUT_SQL),'0')
  self.assertNotIn('PGHOSTADDR',captured['env']);self.assertNotIn('PGSERVICE',captured['env']);self.assertNotIn('PGPASSFILE',captured['env']);self.assertNotIn('DATABASE_URL',captured['env']);self.assertEqual(captured['env']['PGSSLMODE'],'verify-full');self.assertEqual(captured['env']['PGCONNECT_TIMEOUT'],'10')
 def test_reused_guards_ast_are_identical(self):
  source=ast.parse(Path('/private/tmp/p07-repaired-runtime-readiness-20261022-sql-contract1/controller.py').read_text());current=ast.parse((ROOT/'controller.py').read_text());old={n.name:ast.dump(n,include_attributes=False) for n in source.body if isinstance(n,(ast.FunctionDef,ast.ClassDef))};new={n.name:ast.dump(n,include_attributes=False) for n in current.body if isinstance(n,(ast.FunctionDef,ast.ClassDef))}
  for name in json.loads((ROOT/'reuse-source.json').read_text())['astIdentical']:self.assertEqual(old[name],new[name],name)
if __name__=='__main__':unittest.main()
