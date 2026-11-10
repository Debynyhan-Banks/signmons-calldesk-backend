import copy,json,tempfile,unittest,uuid
from pathlib import Path
from unittest.mock import patch
import correction as c
import binding
class Ports:
 def __init__(self,fail=None):self.fail=fail;self.calls=[];self.states={};self.version=None;self.created=0;self.deployed=0;self.project_number='123456'
 def hit(self,stage):
  self.calls.append(stage)
  if self.fail==stage:raise RuntimeError('PRIVATE_SENTINEL')
 def preflight(self,p,d):self.hit('preflight')
 def check_key(self,k,e,d):self.hit('key')
 def add_version(self,k,d):self.created+=1;self.states[('version',binding.STRIPE)]=True;self.hit('create');return {'name':'projects/123456/secrets/'+binding.STRIPE+'/versions/7','state':'ENABLED'}
 def configure(self,v,r):self.version=v
 def version_readback(self,v,d):self.hit('version_readback')
 def activation(self):return [('identity','identity'),('version','startup'),('secretBinding','binding'),('role','role')]
 def change(self,k,n,on,d):
  self.states[k,n]=on
  if on:self.hit('activate:'+k)
  else:self.hit('retire:'+k)
 def readback(self,k,n,on,d):return self.states.get((k,n),False)==on
 def deploy(self,d):self.deployed+=1;self.states[('tag','app013-p07-atomic')]=True;self.hit('deploy')
 def deployment_readback(self,d):self.hit('readiness');return {'environmentExact':True}
 def final_readback(self,d):return not any(self.states.values())
 def clear_key(self):pass
 def clear(self):pass
class CorrectionTests(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup);self.root=Path(self.tmp.name).resolve();self.root.chmod(0o700)
  self.p={'operationId':str(uuid.uuid4()),'projectNumberSha256':'37d4aa0f46ca5b8f0b81b1148bda235a0f4a9a424b6b4638ec993d889563be54','window':{'start':90,'cutoff':200,'workEnd':500,'cleanupEnd':1200},'qualificationSha256':'0'*64,'sourceManifestSha256':'1'*64}
 def driver(self,ports):return c.Correction(self.p,ports,self.root,lambda:100)
 def test_success_requires_cleanup_and_separate_adoption(self):
  ports=Ports();result=self.driver(ports).run('PRIVATE_SENTINEL','we_fixture');self.assertEqual(result['status'],'CORRECTION_CLOSED');self.assertTrue(result['candidateReadyObserved']);self.assertFalse(result['adopted']);self.assertFalse(any(ports.states.values()));self.assertEqual(ports.created,1);self.assertEqual(ports.deployed,1)
  self.assertNotIn('PRIVATE_SENTINEL',(self.root/'journal.json').read_text())
  with self.assertRaises(FileExistsError):self.driver(ports).run('x','y')
  self.assertEqual(ports.created,1)
 def test_every_mutation_failure_cleans_known_ownership(self):
  for stage in ['preflight','key','create','version_readback','activate:identity','activate:version','activate:secretBinding','activate:role','deploy','readiness']:
   with self.subTest(stage=stage),tempfile.TemporaryDirectory() as root:
    ports=Ports(stage);result=c.Correction(self.p,ports,Path(root).resolve(),lambda:100).run('x','y')
    if stage=='create':self.assertEqual(result['residuals'],['CREATED_VERSION_OWNERSHIP_UNKNOWN'])
    else:self.assertEqual(result['residuals'],[]);self.assertFalse(any(ports.states.values()))
    self.assertLessEqual(ports.created,1);self.assertLessEqual(ports.deployed,1)
 def test_independent_cleanup_never_recreates(self):
  ports=Ports('retire:role');result=self.driver(ports).run('x','y');self.assertTrue(result['residuals']);ports.fail=None
  result=self.driver(ports).closeout();self.assertEqual(result['residuals'],[]);self.assertEqual(ports.created,1);self.assertEqual(ports.deployed,1)
  with self.assertRaises(FileExistsError):self.driver(ports).closeout()
 def test_concurrent_attempt_refused(self):
  d=self.driver(Ports());d.acquire()
  try:
   with self.assertRaisesRegex(c.Stop,'CORRECTION_RUNNING'):self.driver(Ports()).run('x','y')
  finally:d.release()
 def test_clock_rollback_and_cutoff(self):
  with self.assertRaisesRegex(c.Stop,'START_CUTOFF'):c.Correction(self.p,Ports(),self.root,lambda:201).run('x','y')
  d=self.driver(Ports());d.last=101
  with self.assertRaisesRegex(c.Stop,'CLOCK_ROLLBACK'):d.gate()
 def test_wrong_returned_versions_refused(self):
  for name in ['projects/999999/secrets/'+binding.STRIPE+'/versions/7','projects/123456/secrets/foreign/versions/7','projects/123456/secrets/'+binding.STRIPE+'/versions/latest','projects/123456/secrets/'+binding.STRIPE+'/versions/1']:
   with self.assertRaises(c.Stop):c.returned_version({'name':name,'state':'ENABLED'},'123456')
  for v in [None,{}, {'name':'x','state':None}]:
   with self.assertRaises(c.Stop):c.returned_version(v,'123456')
 def test_journal_failure_cannot_skip_cleanup(self):
  ports=Ports();driver=self.driver(ports);original=driver.save
  def fail_after_version():
   if driver.j['version'] is not None:raise OSError('synthetic disk failure')
   original()
  driver.save=fail_after_version
  result=driver.run('x','y');self.assertIn('JOURNAL_UNCONFIRMED',result['residuals']);self.assertFalse(any(ports.states.values()));self.assertEqual(ports.created,1)
 def test_unowned_journal_refused(self):
  ports=Ports();self.driver(ports).run('x','y');j=c.read(self.root/'journal.json');j['intents'].append(['version','foreign']);c.atomic(self.root/'journal.json',j)
  with self.assertRaisesRegex(c.Stop,'JOURNAL_SCOPE'):self.driver(ports).closeout()

class BindingTests(unittest.TestCase):
 def cfg(self):
  op=str(uuid.uuid4());return {'state':'CORRECTED','candidate':c.candidate(op),'stripeVersion':'7','correctionOperationId':op,'correctionReceiptSha256':'a'*64}
 def test_active_binding_stays_legacy(self):self.assertEqual(binding.current()['state'],'LEGACY')
 def test_real_restore_commands_and_readbacks_bind_numeric_version(self):
  r=c.load('p08-restoration-local-20261028/source/restore.py','test_restore_binding');cfg=self.cfg();binding.apply_restore(r,cfg);p={'iam':[]}
  self.assertEqual(binding.resource_pins(r,cfg)['secretVersions'][binding.STRIPE],'7')
  self.assertIn(('version',binding.STRIPE),r.operations(p));self.assertIn('--update-tags='+r.TAG+'='+cfg['candidate'],r.command(p,'tag',r.TAG,True))
  calls=[];a=r.NativeAdapter(None,'',runner=lambda args,d:(calls.append(args) or {'state':'DISABLED'}))
  self.assertTrue(a.readback('version',binding.STRIPE,False,p,100));self.assertIn('7',calls[0]);self.assertNotIn('1',calls[0])
  with self.assertRaises(ValueError):binding.apply_restore(r,self.cfg())
 def test_bad_adoption_fields_refused(self):
  for k,v in [('stripeVersion','latest'),('stripeVersion','1'),('candidate',binding.LEGACY),('correctionReceiptSha256',None)]:
   cfg=self.cfg();cfg[k]=v
   with self.assertRaises((ValueError,TypeError)):binding.validate(cfg)
 def test_legacy_deployment_renderer_preserves_image_and_numeric_map(self):
  calls=[];cfg=self.cfg();d=c.Deployment('7',cfg['candidate'],'https://example.invalid/pay',lambda args,kw:calls.append(args),lambda a,k:'200');d.deploy();args=calls[0]
  self.assertIn('--no-traffic',args);self.assertIn('--min-instances=0',args);self.assertIn('--max-instances=1',args);self.assertIn('--image='+d.m.IMAGE,args)
  secret=next(x for x in args if x.startswith('--set-secrets='));self.assertIn('STRIPE_SECRET_KEY='+binding.STRIPE+':7',secret);self.assertEqual(len(secret.split(',')),7)
 def test_actual_deploy_readback_rejects_traffic_and_environment_drift(self):
  cfg=self.cfg();store={};d=c.Deployment('7',cfg['candidate'],'https://example.invalid/pay',lambda args,kw:store.get('service' if args[:2]==['run','services'] else 'revision',{}),lambda a,k:'200');d.deploy();m=d.m
  env=[{'name':k,'value':v} for k,v in m.PLAIN_ENV.items()]+[{'name':k,'valueFrom':{'secretKeyRef':{'name':v[0],'key':v[1]}}} for k,v in d.secret_map.items()]
  store['service']={'metadata':{'annotations':{'run.googleapis.com/ingress':'all'}},'status':{'traffic':[{'revisionName':m.NORMAL,'percent':100},{'revisionName':m.REVISION,'tag':m.TAG,'url':m.ORIGIN,'percent':0}]}}
  store['revision']={'metadata':{'annotations':{'autoscaling.knative.dev/maxScale':'1','run.googleapis.com/cpu-throttling':'true','run.googleapis.com/startup-cpu-boost':'true'}},'spec':{'serviceAccountName':m.SERVICE_ACCOUNT,'timeoutSeconds':60,'containerConcurrency':40,'containers':[{'env':env,'resources':{'limits':{'cpu':'1','memory':'512Mi'}}}]},'status':{'imageDigest':m.IMAGE,'conditions':[{'type':'Ready','status':'True'}]}}
  self.assertTrue(d.readback()['environmentExact']);store['service']['status']['traffic'][0]['percent']=99
  with self.assertRaises(Exception):d.readback()
  store['service']['status']['traffic'][0]['percent']=100;env[-1]['valueFrom']['secretKeyRef']['key']='latest'
  with self.assertRaises(Exception):d.readback()
if __name__=='__main__':unittest.main()
