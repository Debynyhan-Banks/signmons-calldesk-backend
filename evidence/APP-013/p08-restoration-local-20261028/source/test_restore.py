import copy,datetime as dt,hashlib,json,os,signal,subprocess,sys,tempfile,time,unittest,uuid
from pathlib import Path
from unittest.mock import patch
import restore as r
ROOT=Path(__file__).parent
class Clock:
 def __init__(self):self.value=time.time()
 def __call__(self):return self.value
 def utc(self,offset):return dt.datetime.fromtimestamp(self.value+offset,dt.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')
def plans(clock,iam=True):
 window={k:clock.utc(v) for k,v in [('start',-5),('cutoff',100),('workEnd',300),('cleanupEnd',1000),('purgeEnd',1100)]};op=str(uuid.uuid4())
 p={'mode':'RESTORE_AUTHENTICATE_RETIRE','automaticRetryAllowed':False,'operationId':op,'jobId':r.JOB,'tenantId':r.TENANT,'ownerPrincipal':r.OWNER,'sourceManifestSha256':'a'*64,'proposalSha256':'b'*64,'window':window,'authenticationPlanSha256':'c'*64,'authenticationSourceSha256':'305f27922daecf24721a25fc3e78c27554cc481e3ce902664d4f574044bcf5c8','iam':[]}
 if iam:
  for kind,permission in [('lookup','firebaseauth.users.get'),('signing','iam.serviceAccounts.signBlob')]:p['iam'].append({'kind':kind,'roleId':'projects/signmons/roles/fixture_'+kind,'permissions':[permission],'preexisting':True,'condition':f"expression=request.time >= timestamp('{window['start']}') && request.time < timestamp('{window['workEnd']}'),title=p08_{op}_{kind}"})
 q={'status':'EXACT_RESTORATION_QUALIFIED','operationId':op,'qualifiedUntil':window['purgeEnd'],'sourceMatched':True,'trafficMatched':True,'testAccountOwnedDisabled':True,'keyRestrictionsCompatible':True,'ownerAccessQualified':True,'grantFixtureSha256':'35785d3857f6fc9b01042d6dee3137eebb18950601fb1b8e7644e340be8fb83c','roleAclSha256':r.digest([]),'authPlanAndApprovalBound':True,'authenticationPlanSha256':'c'*64}
 p['qualificationSha256']=r.digest(q)
 a={'owner':'Debynyhan Banks','externalActionAuthorized':True,'decision':'APPROVE_EXACT_RESTORE_AUTHENTICATE_RETIRE','planSha256':r.digest(p),'sourceManifestSha256':'a'*64,'proposalSha256':'b'*64,'operationId':op}
 return p,a,q
class Fake:
 def __init__(self,p):self.state={tuple(x):False for x in r.operations(p)};self.trace=[];self.fail=None;self.unknown=None;self.cleanup_fail=None;self.bad_read=None;self.signal=None;self.tick=None;self.preflight_ok=True;self.proof={'status':'P08_OPERATOR_AUTHENTICATED_AND_CLOSED','authenticated':True,'sessionsAbsent':True,'privateMetadataAbsent':True,'privateMetadataPurgeOnTime':True,'residuals':[]}
 def preflight(self,p,q,deadline):self.trace.append('preflight');return self.preflight_ok and not any(self.state.values())
 def change(self,k,n,on,p,deadline):
  self.trace.append((k,n,on));key=(k,n)
  if not on and key==self.cleanup_fail:raise TimeoutError()
  if on and key==self.fail:raise r.Stop('REFUSED')
  self.state[key]=on
  if on and key==self.signal:os.kill(os.getpid(),getattr(self,'signalType',signal.SIGTERM))
  if on and self.tick:self.tick()
  if on and key==self.unknown:raise TimeoutError()
 def readback(self,k,n,on,p,deadline):return self.state[(k,n)]==on and (k,n,on)!=self.bad_read
 def authenticate(self,p,deadline):self.trace.append('auth');return copy.deepcopy(self.proof)
 def close_authentication(self,p,deadline):self.trace.append('auth-closeout');return True
 def retired(self,p,deadline):return not any(self.state.values())
class RestoreTests(unittest.TestCase):
 def setUp(self):self.temp=tempfile.TemporaryDirectory(prefix='p08-restore-test-',dir='/private/tmp');self.root=Path(self.temp.name);os.chmod(self.root,0o700);self.clock=Clock();self.p,self.a,self.q=plans(self.clock);self.fake=Fake(self.p)
 def tearDown(self):self.temp.cleanup();self.assertFalse(self.root.exists())
 def controller(self,**kw):return r.Controller(self.p,self.a,self.q,self.fake,self.root,'a'*64,'b'*64,self.clock,**kw)
 def rebind(self):self.p['qualificationSha256']=r.digest(self.q);self.a['planSha256']=r.digest(self.p)
 def test_positive_same_block_and_exact_cleanup(self):
  v=self.controller().run();self.assertEqual(v['status'],'P08_RESTORE_AUTH_RETIRE_VERIFIED');self.assertFalse(any(self.fake.state.values()));self.assertTrue(v['authenticated']);self.assertEqual(len([x for x in self.fake.trace if isinstance(x,tuple)]),2*len(r.operations(self.p)))
 def test_auth_timeout_and_failed_independent_closeout_never_verified(self):
  def failed(p,deadline):raise TimeoutError()
  self.fake.authenticate=failed;self.fake.close_authentication=lambda p,deadline:False
  v=self.controller().run();self.assertEqual(v['status'],'CONTAINMENT_UNCONFIRMED');self.assertIn('AUTH_OUTCOME_UNKNOWN',v['residuals']);self.assertIn('AUTH_ACCOUNT_SESSION_CLOSEOUT',v['residuals']);self.assertFalse(any(self.fake.state.values()))
 def test_no_iam_branch_preserved(self):
  self.p,self.a,self.q=plans(self.clock,False);self.fake=Fake(self.p);self.assertEqual(self.controller().run()['status'],'P08_RESTORE_AUTH_RETIRE_VERIFIED')
 def test_all_mutation_unknowns_remain_unconfirmed_even_after_cleanup(self):
  for item in r.operations(self.p):
   with self.subTest(item=item),tempfile.TemporaryDirectory(dir=self.root) as d:
    f=Fake(self.p);f.unknown=item;c=r.Controller(self.p,self.a,self.q,f,d,'a'*64,'b'*64,self.clock);v=c.run();self.assertEqual(v['status'],'CONTAINMENT_UNCONFIRMED');self.assertTrue(any(x.startswith('UNKNOWN:') for x in v['residuals']));self.assertFalse(any(f.state.values()))
 def test_signal_each_mutation_stops_and_retires(self):
  for item,signum in [(x,s) for x in r.operations(self.p) for s in [signal.SIGINT,signal.SIGTERM]]:
   with self.subTest(item=item,signum=signum),tempfile.TemporaryDirectory(dir=self.root) as d:
    f=Fake(self.p);f.signal=item;f.signalType=signum;v=r.Controller(self.p,self.a,self.q,f,d,'a'*64,'b'*64,self.clock).run();self.assertEqual(v['status'],'P08_RESTORATION_STOP_CONTAINED');self.assertFalse(any(f.state.values()));self.assertNotIn('auth',f.trace)
 def test_partial_failure_cleanup_continues_and_reports_residual(self):
  self.fake.cleanup_fail=('version',r.SECRETS[2]);v=self.controller().run();self.assertEqual(v['status'],'CONTAINMENT_UNCONFIRMED');self.assertTrue(self.fake.state[('version',r.SECRETS[2])]);self.assertFalse(self.fake.state[('identity',r.IDENTITY)])
 def test_failed_readback_cannot_claim_authentication(self):
  self.fake.bad_read=('tag',r.TAG,True);v=self.controller().run();self.assertFalse(v['authenticated']);self.assertFalse(any(self.fake.state.values()))
 def test_preflight_refuses_foreign_active_state_without_mutation(self):
  for item in r.operations(self.p):
   with self.subTest(item=item),tempfile.TemporaryDirectory(dir=self.root) as d:
    f=Fake(self.p);f.state[item]=True;v=r.Controller(self.p,self.a,self.q,f,d,'a'*64,'b'*64,self.clock).run();self.assertEqual(len(f.trace),1);self.assertTrue(f.state[item]);self.assertFalse(v['authenticated'])
 def test_source_scope_identity_and_approval_refuse(self):
  for field,value in [('ownerPrincipal','foreign'),('jobId',str(uuid.uuid4())),('tenantId',str(uuid.uuid4())),('sourceManifestSha256','f'*64),('proposalSha256','f'*64),('automaticRetryAllowed',True),('mode','CREATE')]:
   with self.subTest(field=field):
    p=copy.deepcopy(self.p);p[field]=value
    with self.assertRaises((r.Stop,ValueError)):r.authorize(p,self.a,self.q,'a'*64,'b'*64,self.clock())
 def test_missing_authorization_and_qualification_refuse(self):
  for field in ['externalActionAuthorized','planSha256','operationId','decision']:
   a=copy.deepcopy(self.a);a.pop(field)
   with self.assertRaises(r.Stop):r.authorize(self.p,a,self.q,'a'*64,'b'*64,self.clock())
  for field in ['testAccountOwnedDisabled','keyRestrictionsCompatible','ownerAccessQualified','sourceMatched','trafficMatched','authPlanAndApprovalBound']:
   q=copy.deepcopy(self.q);q[field]=False;p=copy.deepcopy(self.p);p['qualificationSha256']=r.digest(q);a=copy.deepcopy(self.a);a['planSha256']=r.digest(p)
   with self.assertRaises(r.Stop):r.authorize(p,a,q,'a'*64,'b'*64,self.clock())
 def test_expired_early_and_long_windows_refuse(self):
  for moment in [self.clock()-100,self.clock()+101]:
   with self.assertRaises(r.Stop):r.authorize(self.p,self.a,self.q,'a'*64,'b'*64,moment)
  self.p['window']['purgeEnd']=self.clock.utc(4000);self.rebind()
  with self.assertRaises(r.Stop):self.controller()
 def test_work_deadline_stops_but_cleanup_can_finish(self):
  self.fake.tick=lambda:setattr(self.clock,'value',r.timestamp(self.p['window']['workEnd'])+.01);v=self.controller().run();self.assertEqual(v['status'],'P08_RESTORATION_STOP_CONTAINED');self.assertFalse(any(self.fake.state.values()))
 def test_clock_rollback_never_reports_verified(self):
  self.fake.tick=lambda:setattr(self.clock,'value',self.clock.value-10);v=self.controller().run();self.assertEqual(v['status'],'CONTAINMENT_UNCONFIRMED')
 def test_cleanup_deadline_and_unavailable_readback_unconfirmed(self):
  self.fake.tick=lambda:setattr(self.clock,'value',r.timestamp(self.p['window']['cleanupEnd'])+1);v=self.controller().run();self.assertEqual(v['status'],'CONTAINMENT_UNCONFIRMED')
 def test_auth_bad_or_incomplete_closeout_never_passes(self):
  for patchvalue in [{'authenticated':False},{'residuals':['pending']},{'sessionsAbsent':False},{'privateMetadataAbsent':False},{'status':'CUSTOM_SUCCESS'}]:
   with self.subTest(patchvalue=patchvalue),tempfile.TemporaryDirectory(dir=self.root) as d:
    f=Fake(self.p);f.proof.update(patchvalue);v=r.Controller(self.p,self.a,self.q,f,d,'a'*64,'b'*64,self.clock).run();self.assertFalse(v['authenticated']);self.assertFalse(any(f.state.values()))
 def test_reservation_one_winner_with_real_processes(self):
  script="import sys;from pathlib import Path;import restore;r=Path(sys.argv[1]);restore.reserve(r,{'operationId':'fixture'})"
  path=str(self.root/'concurrent.json');ps=[subprocess.Popen([sys.executable,'-c',script,path],cwd=ROOT,stdout=subprocess.PIPE,stderr=subprocess.PIPE) for _ in range(2)]
  try:
   for p in ps:p.communicate(timeout=5)
   self.assertEqual(sum(p.returncode==0 for p in ps),1)
  finally:
   for p in ps:
    if p.poll() is None:p.kill();p.wait()
 def test_independent_closeout_one_use_and_foreign_journal_refuses(self):
  c=self.controller();c.j['attempted']=[['identity',r.IDENTITY]];self.fake.state[('identity',r.IDENTITY)]=True;c.save();self.clock.value=r.timestamp(self.p['window']['cutoff'])+1
  c=r.Controller(self.p,self.a,self.q,self.fake,self.root,'a'*64,'b'*64,self.clock,mode='closeout');v=c.cleanup(True);self.assertFalse(v['residuals']);self.assertFalse(any(self.fake.state.values()))
  with self.assertRaises(FileExistsError):c.cleanup(True)
 def test_no_secret_or_private_data_in_journal(self):
  self.controller().run();s=(self.root/'journal.json').read_text();self.assertNotIn('password',s);self.assertNotIn('eyJ',s);self.assertNotIn(r.OWNER,s);self.assertNotIn('fixture-secret',s)
 def test_exact_serialized_command_inventory(self):
  self.assertEqual(r.command(self.p,'version',r.SECRETS[0],True),['secrets','versions','enable','1','--secret='+r.SECRETS[0],'--project=signmons','--quiet'])
  self.assertIn('--update-tags='+r.TAG+'='+r.CANDIDATE,r.command(self.p,'tag',r.TAG,True));self.assertNotIn('--set-tags',str(r.command(self.p,'tag',r.TAG,True)))
  for k,n in r.operations(self.p):
   if k!='role':
    for on in [True,False]:
     args=r.command(self.p,k,n,on);self.assertFalse(any(x in args for x in ['deploy','get-key-string','access','create','delete','destroy']))
  with self.assertRaises(r.Stop):r.command(self.p,'version','foreign',True)
 def test_iam_extra_permissions_creation_and_duplicate_refuse(self):
  for edit in ['extra','create','duplicate','unbounded']:
   p=copy.deepcopy(self.p)
   if edit=='extra':p['iam'][0]['permissions'].append('firebaseauth.users.update')
   if edit=='create':p['iam'][0]['preexisting']=False
   if edit=='duplicate':p['iam'].append(copy.deepcopy(p['iam'][0]))
   if edit=='unbounded':p['iam'][0]['condition']='None'
   a=copy.deepcopy(self.a);a['planSha256']=r.digest(p)
   with self.assertRaises(r.Stop):r.authorize(p,a,self.q,'a'*64,'b'*64,self.clock())
 def test_native_command_builder_exercised_with_fake_transport(self):
  calls=[];sql=[];a=r.NativeAdapter(None,'synthetic',runner=lambda args,deadline:calls.append(args),sql=lambda text,deadline:sql.append(text))
  for k,n in r.operations(self.p):a.change(k,n,True,self.p,self.clock()+20);a.change(k,n,False,self.p,self.clock()+20)
  self.assertEqual(len(calls),2*(len(r.operations(self.p))-1));self.assertEqual(sql,[r.role_sql(True,self.p['window']['workEnd']),r.role_sql(False)])
 def test_auth_child_result_serialization_and_syntax(self):
  v=subprocess.run(['node','--input-type=module','--check'],input=r.AUTH_CHILD.encode(),capture_output=True,timeout=5);self.assertEqual(v.returncode,0)
  import re
  literal=re.search(r"JSON.stringify\(result\)\+('.*?')",r.AUTH_CHILD).group(1)
  v=subprocess.run(['node','-e',"process.stdout.write(JSON.stringify({status:'LOCAL'})+"+literal+")"],capture_output=True,timeout=5);self.assertEqual(json.loads(v.stdout),{'status':'LOCAL'});self.assertTrue(v.stdout.endswith(bytes([10])))
  self.assertIn('passwordInput:async()',r.AUTH_CHILD);self.assertNotIn('print-access-token',r.AUTH_CHILD)
 def test_native_without_binding_refuses_before_input(self):
  v=subprocess.run([sys.executable,'-B',str(ROOT/'restore.py'),'--restore'],cwd=ROOT,capture_output=True,timeout=5);self.assertEqual(v.returncode,2);self.assertEqual(v.stdout.decode().strip(),'P08_RESTORE_REFUSED_UNBOUND');self.assertNotIn('password',v.stdout.decode().lower())
class PurgeAndPersistenceTests(RestoreTests):
 def test_exact_private_purge_preserves_unrelated_file(self):
  (self.root/'auth').mkdir()
  for path in [self.root/'restore-plan.json',self.root/'auth/auth-plan.json',self.root/'keep.json']:path.write_text('{}');os.chmod(path,0o600)
  self.assertTrue(r.purge_plans(self.root));self.assertTrue((self.root/'keep.json').exists())
 def test_purge_symlink_refuses_and_never_removes_target(self):
  target=self.root/'keep';target.write_text('synthetic');(self.root/'restore-plan.json').symlink_to(target)
  with self.assertRaises(r.Stop):r.purge_plans(self.root)
  self.assertTrue(target.exists())
 def test_residual_wait_is_bounded_then_purges(self):
  (self.root/'auth').mkdir();path=self.root/'restore-plan.json';path.write_text('{}');os.chmod(path,0o600)
  v={'status':'CONTAINMENT_UNCONFIRMED','residuals':['UNKNOWN']};end=r.timestamp(self.p['window']['purgeEnd'])
  def tick(n):self.clock.value+=n
  v=r.finish_private(v,self.p,self.root,self.clock,tick);self.assertTrue(v['privatePlansAbsent']);self.assertTrue(v['privatePurgeOnTime']);self.assertLess(self.clock(),end)
 def test_retention_purge_ignores_both_catchable_signals(self):
  v={'status':'CONTAINMENT_UNCONFIRMED','residuals':['UNKNOWN']}
  def tick(n):
   os.kill(os.getpid(),signal.SIGTERM);os.kill(os.getpid(),signal.SIGINT);self.clock.value+=min(100,r.timestamp(self.p['window']['purgeEnd'])-2-self.clock.value)
  self.assertTrue(r.finish_private(v,self.p,self.root,self.clock,tick)['privatePurgeOnTime'])
 def test_journal_write_failure_cannot_escape_as_verified(self):
  c=self.controller();original=c.save;count=[0]
  def fail_later():
   count[0]+=1
   if count[0]>3:raise OSError('synthetic')
   original()
  c.save=fail_later;v=c.run();self.assertEqual(v['status'],'CONTAINMENT_UNCONFIRMED');self.assertFalse(any(self.fake.state.values()))
for name in RestoreTests.__dict__:
 if name.startswith('test_'):setattr(PurgeAndPersistenceTests,name,None)
class EnvironmentTests(unittest.TestCase):
 def test_local_environment_overrides_refuse_without_any_provider(self):
  with tempfile.TemporaryDirectory(dir='/private/tmp') as d:
   root=Path(d);(root/'configurations').mkdir();(root/'active_config').write_text('fixture');cfg=root/'configurations/config_fixture';cfg.write_text('[auth]\n')
   self.assertTrue(r.local_environment_gate({},root))
   for env in [{'PGOPTIONS':'role=foreign'},{'CLOUDSDK_AUTH_IMPERSONATE_SERVICE_ACCOUNT':'foreign'},{'GOOGLE_APPLICATION_CREDENTIALS':'foreign'},{'CLOUDSDK_CONFIG':'/foreign'}]:
    with self.assertRaises(r.Stop):r.local_environment_gate(env,root)
   cfg.write_text('[auth]\nimpersonate_service_account=foreign\n')
   with self.assertRaises(r.Stop):r.local_environment_gate({},root)
class NativeBoundaryTests(RestoreTests):
 def setUp(self):
  super().setUp();self.q['runtimeEnvironmentSha256']=r.digest([{'name':'LOCAL_ONLY','value':'synthetic'}]);self.native_state={x:False for x in r.operations(self.p)};self.calls=[];self.drift=None
  auth=self.root/'auth';auth.mkdir();plan={'synthetic':True,'window':self.p['window'],'jobId':r.JOB,'target':{'tenantId':r.TENANT}};path=auth/'auth-plan.json';path.write_text(json.dumps(plan));os.chmod(path,0o600);self.p['authenticationPlanSha256']=r.digest(plan);self.q['authenticationPlanSha256']=r.digest(plan);self.rebind()
  self.adapter=r.NativeAdapter(None,'fixture-only',root=self.root,runner=self.cloud,sql=self.sql,auth=lambda args,deadline:copy.deepcopy(self.fake.proof),clock=self.clock)
 def controller(self,**kw):return r.Controller(self.p,self.a,self.q,self.adapter,self.root,'a'*64,'b'*64,self.clock,**kw)
 def cloud(self,args,deadline):
  self.calls.append(args)
  if args[:2]==['auth','list']:return 'foreign' if self.drift=='owner' else r.OWNER
  if args[:3]==['run','revisions','describe']:return {'spec':{'serviceAccountName':r.IDENTITY,'containers':[{'image':'foreign' if self.drift=='image' else r.IMAGE,'env':[{'name':'LOCAL_ONLY','value':'synthetic'}]}]}}
  if args[:3]==['run','services','describe']:
   rows=[{'revisionName':r.NORMAL,'percent':100}]
   if self.native_state[('tag',r.TAG)]:rows.append({'tag':r.TAG,'revisionName':r.CANDIDATE,'percent':0})
   return {'status':{'traffic':rows}}
  if args[:3]==['iam','roles','describe']:
   x=next(x for x in self.p['iam'] if x['roleId'].split('/')[-1]==args[3]);return {'name':x['roleId'],'includedPermissions':['extra'] if self.drift=='customRole' else x['permissions'],'stage':'GA'}
  if args[:3]==['iam','service-accounts','describe']:return {'email':r.IDENTITY,'disabled':not self.native_state[('identity',r.IDENTITY)]}
  if args[:3]==['secrets','versions','describe']:
   name=next(x.split('=',1)[1] for x in args if x.startswith('--secret='));return {'state':'ENABLED' if self.drift=='version' or self.native_state[('version',name)] else 'DISABLED'}
  if 'get-iam-policy' in args:
   if args[0]=='secrets':name=args[2];key=('secretBinding',name);member='serviceAccount:'+r.IDENTITY;role='roles/secretmanager.secretAccessor';condition=None
   else:
    kind='lookup' if args[0]=='projects' else 'signing';x=next(x for x in self.p['iam'] if x['kind']==kind);key=('iam',kind);member='serviceAccount:'+r.IDENTITY if kind=='lookup' else 'user:'+r.OWNER;role=x['roleId'];condition={'expression':x['condition'].split(',title=')[0].removeprefix('expression='),'title':x['condition'].split(',title=')[1]}
   if self.native_state[key] or self.drift=='policy':return {'bindings':[{'members':[member],'role':'foreign' if self.drift=='policy' else role,**({'condition':condition} if condition else {})}]}
   return {}
  for kind,name in r.operations(self.p):
   if kind=='role':continue
   for on in [True,False]:
    if args==r.command(self.p,kind,name,on):self.native_state[(kind,name)]=on;return {}
  raise AssertionError('UNLISTED_NATIVE_COMMAND')
 def sql(self,text,deadline):
  if text==r.role_sql(True,self.p['window']['workEnd']):self.native_state[('role',r.ROLE)]=True;return ''
  if text==r.role_sql(False):self.native_state[('role',r.ROLE)]=False;return ''
  self.assertIn('aclexplode',text);on=self.native_state[('role',r.ROLE)];return json.dumps({'count':1,'login':on,'limit':6 if on else 0,'expires':self.p['window']['workEnd'].replace('Z','+00:00') if on else '2000-01-01T00:00:00+00:00','expired':not on,'unsafe':False,'memberships':0,'owned':0,'sessions':0,'acl':['drift'] if self.drift=='acl' else []})
 def test_native_full_preflight_command_restore_auth_retirement(self):
  self.assertEqual(self.controller().run()['status'],'P08_RESTORE_AUTH_RETIRE_VERIFIED');self.assertFalse(any(self.native_state.values()));self.assertTrue(self.calls)
 def test_native_actual_output_contract_drift_refuses_before_mutation(self):
  for drift in ['owner','image','customRole','version','policy','acl']:
   with self.subTest(drift=drift),tempfile.TemporaryDirectory(dir=self.root) as d:
    self.drift=drift;self.adapter.root=self.root;c=r.Controller(self.p,self.a,self.q,self.adapter,d,'a'*64,'b'*64,self.clock);v=c.run();self.assertFalse(v['authenticated']);self.assertFalse(any(self.native_state.values()));self.assertEqual(c.j['attempted'],[])
 # Run just native-specific cases; inherited state-machine cases use their own fake adapter.
for name in RestoreTests.__dict__:
 if name.startswith('test_'):setattr(NativeBoundaryTests,name,None)
if __name__=='__main__':unittest.main()
