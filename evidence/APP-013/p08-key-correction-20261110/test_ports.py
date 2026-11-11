"""Actual native serializer/ACL/lifecycle seam against a finite synthetic provider."""
import datetime,json,tempfile,time,unittest,uuid
from pathlib import Path
from unittest.mock import patch
import correction as c
import ports
import binding
class NativeSeamTests(unittest.TestCase):
 def setUp(self):
  self.now=int(time.time());self.plan={'operationId':str(uuid.uuid4()),'projectNumberSha256':'37d4aa0f46ca5b8f0b81b1148bda235a0f4a9a424b6b4638ec993d889563be54','window':{'start':self.now-5,'cutoff':self.now+60,'workEnd':self.now+300,'cleanupEnd':self.now+1000},'qualificationSha256':'0'*64,'sourceManifestSha256':'1'*64}
  self.port=ports.NativePorts(self.plan,None,{'cli':180,'https':40,'sql':40,'child':2});self.port.io.token='synthetic';self.port.io.password='synthetic'
  self.state={};self.commands=[];self.requests=[];self.login=False;self.env=[]
  for k,v in self.port.io.legacy.PLAIN_ENV.items():self.env.append({'name':k,'value':v})
  self.env.append({'name':'CUSTOMER_PAYMENT_RETURN_URL','value':'https://fixture.invalid/pay'})
  for k,s in zip(('DATABASE_URL','STRIPE_WEBHOOK_SECRET','OPENAI_API_KEY','ADMIN_API_TOKEN','CONVERSATION_DATA_ENCRYPTION_KEY','TECHNICIAN_LINK_SECRET'),ports.entry.restore.SECRETS):self.env.append({'name':k,'valueFrom':{'secretKeyRef':{'name':s,'key':'1'}}})
  self.env.append({'name':'STRIPE_SECRET_KEY','valueFrom':{'secretKeyRef':{'name':binding.STRIPE,'key':'1'}}})
  self.plan['projectNumberSha256']=ports.q.model.digest('123456789012')
  self.patch2=patch.object(ports.q,'BILLING_ACCOUNT_SHA256',__import__('hashlib').sha256(b'billingAccounts/ABC').hexdigest());self.patch2.start();self.addCleanup(self.patch2.stop)
  self.port.io._run=self.fixture_run;self.port.http=self.http
 def http(self,method,url,body=None):
  self.requests.append((method,url,body));self.port.spend('https',self.port.cleanup)
  if 'testIamPermissions' in url:return body
  if 'serviceusage' in url:return {'name':url.split('/v1/')[1].split('?')[0],'state':'ENABLED'}
  if ':addVersion' in url:self.state['stripe']=True
  return {'name':'projects/'+'123456789012'+'/secrets/'+binding.STRIPE+'/versions/7','state':'ENABLED'}
 def fixture_run(self,argv,kind,input_bytes=None,extra=None):
  self.port.spend(kind,self.port.io.cleanup);self.commands.append(argv)
  if kind=='sql':
   query=input_bytes.decode()
   if query.startswith('BEGIN;'):
    self.login=' LOGIN ' in query;return ''
   acl=self.port.runtime.acl
   return json.dumps({'role':acl.RETIRED_ROLE,'database':'neondb','user':'neondb_owner','serverVersion':160000,'membershipEdges':[],'count':1,'login':self.login,'limit':6 if self.login else 0,'expires':self.port.cap.plan['window']['workEnd'] if self.login else '1970-01-01T00:00:00Z','expiryFinite':True,'expired':not self.login,'unsafe':False,'memberships':0,'owned':0,'sessions':0,'schemaCreate':False,'databaseTemp':False,'acl':acl.expected_retired_acl()})
  args=argv[1:]
  if args[:2]==['projects','describe']:return '123456789012'
  if args[:3]==['billing','projects','describe']:return json.dumps({'projectId':'signmons','billingEnabled':True,'billingAccountName':'billingAccounts/ABC'})
  if args[:3]==['billing','accounts','describe']:return '{"open":true}'
  if args[:2]==['projects','get-iam-policy'] or args[:3]==['iam','service-accounts','get-iam-policy']:return '{"bindings":[]}'
  if args[:3]==['run','revisions','list']:return '[]'
  if args[:3]==['run','revisions','describe']:return json.dumps({'spec':{'serviceAccountName':ports.entry.restore.IDENTITY,'containers':[{'image':ports.entry.restore.IMAGE,'env':self.env}]}})
  if args[:3]==['run','services','describe']:return json.dumps({'status':{'traffic':[{'revisionName':ports.entry.restore.NORMAL,'percent':100}]}})
  if args[:2]==['iam','service-accounts']:
   if args[2]=='describe':return json.dumps({'email':ports.entry.restore.IDENTITY,'disabled':not self.state.get('identity',False)})
   self.state['identity']=args[2]=='enable';return ''
  if args[:2]==['secrets','versions']:
   name=next(x.split('=',1)[1] for x in args if x.startswith('--secret='));key='stripe' if name==binding.STRIPE else name
   if args[2]=='describe':return json.dumps({'state':'ENABLED' if self.state.get(key,False) else 'DISABLED'})
   self.state[key]=args[2]=='enable';return ''
  if args[:2]==['secrets','get-iam-policy']:
   return json.dumps({'bindings':[{'role':'roles/secretmanager.secretAccessor','members':['serviceAccount:'+ports.entry.restore.IDENTITY]}] if self.state.get('binding:'+args[2]) else []})
  if args[:2] in (['secrets','add-iam-policy-binding'],['secrets','remove-iam-policy-binding']):
   self.state['binding:'+args[2]]=args[1]=='add-iam-policy-binding'
   policy={'bindings':[{'role':'roles/secretmanager.secretAccessor','members':['serviceAccount:'+ports.entry.restore.IDENTITY]}] if self.state['binding:'+args[2]] else [],'etag':'synthetic','version':1}
   return json.dumps(policy) if '--format=json' in args else 'bindings: []\netag: synthetic\nversion: 1'
  raise AssertionError('Unexpected synthetic command '+str(args))
 def test_current_preflight_full_role_and_permissions(self):
  observed=self.port.preflight(self.plan,self.port.gate());self.assertEqual(set(observed),{'runtimeEnvironmentSha256','roleAclSha256','returnUrl'})
  self.assertEqual(self.port.calls['sql'],2)
  self.assertTrue(any('secretmanager.versions.add' in (body or {}).get('permissions',[]) for _,_,body in self.requests))
  self.assertFalse(self.port.cleanup)
 def test_actual_lifecycle_new_version_enable_disable_and_role_acl(self):
  self.port.expected=self.port.preflight(self.plan,self.port.gate());self.port.configure('7',c.candidate(self.plan['operationId']));self.state['stripe']=True
  for k,n in self.port.activation():
   self.port.change(k,n,True,self.port.gate());self.assertTrue(self.port.readback(k,n,True,self.port.gate()))
  self.assertTrue(self.login)
  for k,n in reversed(self.port.activation()+[('version',binding.STRIPE)]):
   self.port.change(k,n,False,self.port.gate(True));self.assertTrue(self.port.readback(k,n,False,self.port.gate(True)))
  self.assertFalse(any(self.state.values()));self.assertFalse(self.login)
  stripe=[a for a in self.commands if '--secret='+binding.STRIPE in a];self.assertTrue(stripe);self.assertTrue(all('7' in a for a in stripe))
 def test_binding_output_is_explicit_json_for_add_and_remove(self):
  self.port.expected=self.port.preflight(self.plan,self.port.gate())
  name=ports.entry.restore.SECRETS[0]
  for enabled in (True,False):
   self.port.change('secretBinding',name,enabled,self.port.gate(True))
   self.assertIn('--format=json',self.commands[-1])
   self.assertTrue(self.port.readback('secretBinding',name,enabled,self.port.gate(True)))
 def test_binding_malformed_output_has_safe_code_and_no_retry(self):
  self.port.expected={'qualified':True}
  for raw in ('', 'bindings: []', 'null', '[]', '{"bindings":[],"bindings":[]}'):
   with self.subTest(raw=raw),patch.object(self.port.io,'cli',return_value=raw) as dispatch:
    with self.assertRaisesRegex(c.Stop,'^BINDING_OUTPUT_INVALID$'):
     self.port.change('secretBinding',ports.entry.restore.SECRETS[0],True,self.port.gate())
    dispatch.assert_called_once()
 def test_qualification_binding_mutation_refused_before_dispatch(self):
  with patch.object(self.port.io,'cli') as dispatch:
   with self.assertRaisesRegex(c.Stop,'QUALIFICATION_MUTATION_REFUSED'):
    self.port.change('secretBinding',ports.entry.restore.SECRETS[0],True,self.port.gate())
   dispatch.assert_not_called()
 def test_reuse_ports_refuse_create_before_network(self):
  self.port.p['reuse']=dict(c.REUSE)
  with self.assertRaisesRegex(c.Stop,'REUSE_CREATE_FORBIDDEN'):self.port.add_version('synthetic',self.port.gate())
  self.assertEqual(self.requests,[]);self.assertEqual(self.commands,[])
 def test_reuse_requires_exact_disabled_numeric_version(self):
  self.port.p['reuse']=dict(c.REUSE);self.port.project_number='123456789012'
  name='projects/123456789012/secrets/'+binding.STRIPE+'/versions/2'
  with patch.object(self.port,'http',return_value={'name':name,'state':'DISABLED'}) as http:
   self.port.reuse_version_check(self.port.gate());self.assertIn('/versions/2?',http.call_args.args[1])
  for value in ({'name':name,'state':'ENABLED'},{'name':name,'state':'DESTROYED'},{'name':name.replace('/2','/3'),'state':'DISABLED'},None,{}):
   with patch.object(self.port,'http',return_value=value):
    with self.assertRaisesRegex(c.Stop,'REUSE_VERSION_NOT_DISABLED'):self.port.reuse_version_check(self.port.gate())
 def test_reuse_preflight_does_not_request_create_permission(self):
  self.port.p['reuse']=dict(c.REUSE);self.port.preflight(self.plan,self.port.gate())
  self.assertFalse(any('secretmanager.versions.add' in (body or {}).get('permissions',[]) for _,_,body in self.requests))
 def test_actual_reuse_lifecycle_pins_two_and_retires_every_resource(self):
  self.port.p['reuse']=dict(c.REUSE);self.port.expected=self.port.preflight(self.plan,self.port.gate())
  name='projects/123456789012/secrets/'+binding.STRIPE+'/versions/2'
  with patch.object(self.port,'http',return_value={'name':name,'state':'DISABLED'}):self.port.reuse_version_check(self.port.gate())
  self.port.configure('2',c.candidate(self.plan['operationId']))
  for k,n in [('version',binding.STRIPE)]+self.port.activation():
   self.port.change(k,n,True,self.port.gate());self.assertTrue(self.port.readback(k,n,True,self.port.gate()))
  for k,n in reversed(self.port.activation()+[('version',binding.STRIPE)]):
   self.port.change(k,n,False,self.port.gate(True));self.assertTrue(self.port.readback(k,n,False,self.port.gate(True)))
  self.assertFalse(any(self.state.values()));self.assertFalse(self.login)
  stripe=[a for a in self.commands if '--secret='+binding.STRIPE in a]
  self.assertTrue(stripe);self.assertTrue(all('2' in a for a in stripe))
  self.assertFalse(any(':addVersion' in url for _,url,_ in self.requests))
 def test_work_budget_reserves_cleanup(self):
  self.port.calls['cli']=90
  with self.assertRaisesRegex(c.Stop,'CALL_LIMIT'):self.port.spend('cli')
  self.port.spend('cli',True);self.assertEqual(self.port.calls['cli'],91)
 def test_qualification_ports_refuse_mutations_before_dispatch(self):
  for fn in [lambda:self.port.add_version('synthetic',self.port.gate()),lambda:self.port.change('identity',ports.entry.restore.IDENTITY,True,self.port.gate()),lambda:self.port.cloud(self.port.cap.modules['restore'].command({},'identity',ports.entry.restore.IDENTITY,True),self.port.gate()),lambda:self.port.deploy(self.port.gate())]:
   with self.assertRaisesRegex(c.Stop,'QUALIFICATION_MUTATION_REFUSED'):fn()
  self.assertEqual(self.commands,[]);self.assertEqual(self.requests,[])
 def test_corrected_native_preflight_runs_after_owned_version_enable(self):
  import importlib.util,types
  import authority
  cfg={'state':'CORRECTED','candidate':c.candidate(self.plan['operationId']),'stripeVersion':'7','correctionOperationId':self.plan['operationId'],'correctionReceiptSha256':'a'*64}
  original=authority.load
  def bound_load(relative,name):
   if relative=='p08-key-correction-20261110/binding.py':return types.SimpleNamespace(apply_restore=lambda r:binding.apply_restore(r,cfg))
   return original(relative,name)
  spec=importlib.util.spec_from_file_location('corrected_native_entry',c.APP/'p08-native-entry-local-20261101/source/entry.py');m=importlib.util.module_from_spec(spec)
  with patch.object(authority,'load',bound_load):spec.loader.exec_module(m)
  self.assertEqual(m.restore.operations({'iam':[]})[0],('version',binding.STRIPE))
  state={'enabled':False};calls=[]
  def cloud(args,deadline):
   self.assertIn('7',args)
   if args[2]=='enable':state['enabled']=True;return {}
   return {'state':'ENABLED' if state['enabled'] else 'DISABLED'}
  cap=types.SimpleNamespace(e={'version':2,'resources':{'secretVersions':{binding.STRIPE:'7'}}})
  io=types.SimpleNamespace(cloud=cloud,sql=lambda *_:self.fail('no SQL before corrected key preflight'))
  runtime=m.RuntimeAdapter(cap,io);runtime.payment_preflight=lambda:(self.assertTrue(state['enabled']),calls.append('key'))
  with patch.object(m.restore.NativeAdapter,'preflight',return_value=True):self.assertTrue(runtime.preflight({}, {}, self.now+50))
  self.assertEqual(calls,[]);self.assertTrue(runtime.readback('version',binding.STRIPE,False,{},self.now+50));self.assertEqual(calls,[])
  runtime.change('version',binding.STRIPE,True,{},self.now+50);self.assertTrue(runtime.readback('version',binding.STRIPE,True,{},self.now+50));self.assertEqual(calls,['key'])
  runtime.payment_preflight=lambda:(_ for _ in ()).throw(RuntimeError('synthetic refusal'))
  with self.assertRaisesRegex(Exception,'PAYMENT_PREFLIGHT_STOP'):runtime.readback('version',binding.STRIPE,True,{},self.now+50)
 def test_wrong_environment_stops_before_any_mutation(self):
  self.env[-1]['valueFrom']['secretKeyRef']['key']='latest'
  with self.assertRaises(Exception):self.port.preflight(self.plan,self.port.gate())
  self.assertEqual(self.state,{})
if __name__=='__main__':unittest.main()
