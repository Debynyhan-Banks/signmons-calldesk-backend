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
class CombinedInputPtyTests(unittest.TestCase):
 def test_real_timed_getpass_three_prompts_preserve_values_in_actual_launcher(self):
  import os,pty,select,tempfile,signal,types
  from pathlib import Path
  from test_correction import Ports as FixturePorts
  with tempfile.TemporaryDirectory() as folder:
   now=time.time();plan={'operationId':str(uuid.uuid4()),'projectNumberSha256':'37d4aa0f46ca5b8f0b81b1148bda235a0f4a9a424b6b4638ec993d889563be54','window':{'start':now-1,'cutoff':now+10,'workEnd':now+20,'cleanupEnd':now+620},'qualificationSha256':'0'*64,'sourceManifestSha256':'1'*64}
   pid,fd=pty.fork()
   if pid==0:
    try:
     legacy=c.load('p08-restoration-local-20261028/source/legacy/controller.py','synthetic_combined_getpass')
     class Ports(FixturePorts):
      def __init__(self,*_):super().__init__();self.io=types.SimpleNamespace(legacy=legacy)
      def check_key(self,key,endpoint,deadline):
       assert key=='sk_test_SYNTHETIC_ONLY' and endpoint=='we_SYNTHETIC_ONLY';self.captured=(key,endpoint)
      def preflight(self,*_):
       with legacy.phase_guard(now+10):password=legacy.private_input('3/3 SYNTHETIC SQL PASSWORD (hidden): ')
       assert password=='sql_SYNTHETIC_ONLY' and self.captured==('sk_test_SYNTHETIC_ONLY','we_SYNTHETIC_ONLY')
     result=launch.execute({'mode':'run','plan':plan,'qualification':{},'limits':launch.LIMITS},Ports,base=Path(folder).resolve())
     assert result['candidateReadyObserved'] and not result['residuals'];os._exit(0)
    except BaseException:os._exit(3)
   transcript=b'';steps=[(b'1/2 Sandbox SECRET',b'sk_test_SYNTHETIC_ONLY\n'),(b'2/2 DESTINATION',b'we_SYNTHETIC_ONLY\n'),(b'3/3 SYNTHETIC SQL',b'sql_SYNTHETIC_ONLY\n')];sent=0;status=None;done=0;deadline=time.monotonic()+12
   try:
    while time.monotonic()<deadline:
     if select.select([fd],[],[],.05)[0]:
      try:chunk=os.read(fd,8192)
      except OSError:break
      transcript+=chunk
      if sent<len(steps) and steps[sent][0] in transcript:os.write(fd,steps[sent][1]);sent+=1
     done,status=os.waitpid(pid,os.WNOHANG)
     if done:break
    else:os.kill(pid,signal.SIGKILL)
    if status is None or not done:_,status=os.waitpid(pid,0)
    self.assertEqual(os.waitstatus_to_exitcode(status),0);self.assertEqual(sent,3)
    for _,value in steps:self.assertNotIn(value.strip(),transcript)
   finally:
    os.close(fd)
    try:os.kill(pid,signal.SIGKILL);os.waitpid(pid,0)
    except ProcessLookupError:pass

if __name__=='__main__':unittest.main()
