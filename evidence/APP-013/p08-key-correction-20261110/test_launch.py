import copy,json,time,unittest,uuid
from unittest.mock import patch
import correction as c
import launch
class AuthorityTests(unittest.TestCase):
 def setUp(self):
  self.now=int(time.time());h=c.digest((c.HERE/'source-manifest.json').read_bytes())
  self.spec={'mode':'qualify','sourceCommit':'0'*40,'sourceManifestSha256':h,'plan':{'operationId':str(uuid.uuid4()),'projectNumberSha256':'37d4aa0f46ca5b8f0b81b1148bda235a0f4a9a424b6b4638ec993d889563be54','window':{'start':self.now-5,'cutoff':self.now+60,'workEnd':self.now+300,'cleanupEnd':self.now+1000},'qualificationSha256':'0'*64,'sourceManifestSha256':h},'qualification':None,'limits':launch.QUALIFICATION_LIMITS,'costAllowanceUsd':0,'decisionCommit':'1'*40}
  import sys
  sys.path.insert(0,str(c.APP/'p08-https-output-category-local-20261029/source'))
  import qualification_launch as q
  # Project pin is public and fixed; raw project number is discovered only inside native preflight.
 def approval(self,s):return {'owner':'Debynyhan Banks','decision':'APPROVE_EXACT_CR_K1_'+s['mode'].upper(),'scopeSha256':c.digest({k:v for k,v in s.items() if k!='decisionCommit'}),'externalReadAuthorized':True,'externalMutationAuthorized':s['mode']!='qualify','costHoldReleased':s['mode']!='qualify'}
 def read_commit(self,repo,sha,path):return (repo/path).read_bytes()
 def test_exact_qualification_is_read_only(self):
  self.assertEqual(launch.verify(self.spec,self.approval(self.spec),self.now,self.read_commit),self.spec)
 def test_generic_approval_cannot_authorize_external_action(self):
  with self.assertRaisesRegex(c.Stop,'EXACT_OWNER_APPROVAL'):launch.verify(self.spec,{'approved':True},self.now,self.read_commit)
 def test_malformed_window_refused_before_source_or_input(self):
  self.spec['plan']['window']['cleanupEnd']=self.now+350
  with self.assertRaisesRegex(c.Stop,'WINDOW'):launch.verify(self.spec,{},self.now,lambda *_:self.fail('source should not be read'))
 def test_qualified_metadata_is_exact_and_stale_source_refused(self):
  s=copy.deepcopy(self.spec);s['mode']='run';s['limits']=launch.LIMITS;s['qualification']={'runtimeEnvironmentSha256':'2'*64,'roleAclSha256':'3'*64,'returnUrl':'https://fixture.invalid'};s['plan']['qualificationSha256']=c.digest(s['qualification'])
  self.assertEqual(launch.verify(s,self.approval(s),self.now,self.read_commit),s)
  with self.assertRaisesRegex(c.Stop,'COMMITTED_MANIFEST'):launch.verify(s,self.approval(s),self.now,lambda *_:b'foreign')
 def test_cutoff_and_mutation_authority_not_inferred(self):
  d=self.approval(self.spec);d['externalMutationAuthorized']=True
  with self.assertRaisesRegex(c.Stop,'EXACT_OWNER_APPROVAL'):launch.verify(self.spec,d,self.now,self.read_commit)
  with self.assertRaisesRegex(c.Stop,'OUTSIDE_WINDOW'):launch.verify(self.spec,self.approval(self.spec),self.now+100,self.read_commit)
 def test_reuse_is_bound_to_committed_receipt_and_exact_scope(self):
  s=copy.deepcopy(self.spec);s['mode']='run';s['limits']=launch.LIMITS;s['plan']['reuse']=dict(c.REUSE)
  s['qualification']={'runtimeEnvironmentSha256':'2'*64,'roleAclSha256':'3'*64,'returnUrl':'https://fixture.invalid'};s['plan']['qualificationSha256']=c.digest(s['qualification'])
  self.assertEqual(launch.verify(s,self.approval(s),self.now,self.read_commit),s)
  def foreign(repo,sha,path):return b'foreign' if path==c.REUSE_RECEIPT else self.read_commit(repo,sha,path)
  with self.assertRaisesRegex(c.Stop,'REUSE_COMMITTED_RECEIPT'):launch.verify(s,self.approval(s),self.now,foreign)
  d=self.approval(s);s['mode']='closeout'
  with self.assertRaisesRegex(c.Stop,'EXACT_OWNER_APPROVAL'):launch.verify(s,d,self.now,self.read_commit)
  self.assertEqual(launch.verify(s,self.approval(s),self.now,self.read_commit),s)
 def test_reuse_qualification_mode_refused(self):
  self.spec['plan']['reuse']=dict(c.REUSE)
  with self.assertRaisesRegex(c.Stop,'REUSE_MODE'):launch.verify(self.spec,self.approval(self.spec),self.now,self.read_commit)
class QualificationOrderTests(unittest.TestCase):
 def test_endpoint_refusal_precedes_cloud_sql_and_always_clears(self):
  import contextlib,tempfile,types
  calls=[]
  class Ports:
   def __init__(self,*args):
    self.stage='SANDBOX_KEY';self.io=types.SimpleNamespace(legacy=types.SimpleNamespace(phase_guard=lambda *_:contextlib.nullcontext(),private_input=lambda _: 'SYNTHETIC_ONLY'))
   def gate(self):return time.time()+60
   def check_key(self,*args):calls.append('key');raise c.Stop('KEY_ENDPOINT_PIN')
   def preflight(self,*args):calls.append('cloud_sql');raise AssertionError('must not execute')
   def clear(self):calls.append('clear')
  with tempfile.TemporaryDirectory() as folder:
   spec={'mode':'qualify','plan':{'operationId':str(uuid.uuid4()),'window':{'cutoff':time.time()+60}},'qualification':None,'limits':launch.QUALIFICATION_LIMITS}
   with self.assertRaisesRegex(c.Stop,'KEY_ENDPOINT_PIN'):launch.execute(spec,Ports,base=__import__('pathlib').Path(folder).resolve())
  self.assertEqual(calls,['key','clear'])
if __name__=='__main__':unittest.main()
