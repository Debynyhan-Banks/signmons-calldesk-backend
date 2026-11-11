import datetime,json,sqlite3,subprocess,tempfile,time,unittest
from pathlib import Path
from unittest.mock import patch
import packet
q=packet.q
class RenewalPreflightTests(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory(prefix='p08-pa1-',dir='/private/tmp');self.addCleanup(self.tmp.cleanup);self.root=Path(self.tmp.name);(self.root/'configurations').mkdir(mode=0o700)
  (self.root/'active_config').write_text('default\n');(self.root/'configurations/config_default').write_text('[core]\naccount = debynyhan@signmons.com\nproject = signmons\n')
  self.now=time.time();iso=lambda n:datetime.datetime.fromtimestamp(self.now+n,datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ');self.source='a'*40
  self.d={'owner':'Debynyhan Banks','decision':'APPROVE_TR1_CREDENTIAL_RENEWAL_SDK_RETRY_CACHE_AND_CLEANUP','externalActionAuthorized':True,'sourceCommit':self.source,'cutoff':iso(60),'closeoutEnd':iso(180),'validThrough':iso(300)}
  self.raw=json.dumps(self.d).encode();self.ref={'commit':'b'*40,'path':'APP013_P08_TR2_DECISION_20261111.json','sha256':q.model.digest(self.raw)};self.acl=q.current_module('acl')
 def read(self,repo,commit,path):return self.raw if repo==packet.G else (packet.B/path).read_bytes()
 def run_preflight(self,**kwargs):
  args={'config_root':self.root,'environment':{},'clock':lambda:self.now,'read_commit':self.read};args.update(kwargs)
  current=q.current_module
  with patch.object(q,'current_module',side_effect=lambda name:self.acl if name=='acl' else current(name)),patch.object(packet,'renewal_tree_check'),patch.object(self.acl,'read_cached_token',side_effect=AssertionError('NO_CACHE_READ')):return packet.renewal_preflight(self.source,self.ref,self.d,**args)
 def test_current_graph_covers_five_legacy_dependencies(self):
  r=self.run_preflight();self.assertEqual(len(r['dependencyMapping']),5);self.assertEqual([n for n,v in r['dependencyMapping'].items() if v['changed']],['p08-native-entry-local-20261101/source/authority.py']);self.assertGreaterEqual(r['sdkFilesVerified'],35);self.assertFalse(r['credentialStoresRead'])
  with self.assertRaisesRegex(self.acl.Stop,'SOURCE_DRIFT'):self.acl.native_readiness()
 def test_changed_committed_dependencies_refused(self):
  for target in ('p08-native-entry-local-20261101/source/authority.py','p08-native-entry-local-20261101/source/source-manifest.json','p08-connected-packet-20261110/packet.py','p08-narrow-access-check-local-20261101/source/source-manifest.json'):
   with self.subTest(path=target),self.assertRaises(Exception):self.run_preflight(read_commit=lambda repo,commit,path:b'changed' if repo==packet.B and path=='evidence/APP-013/'+target else self.read(repo,commit,path))
 def test_sdk_and_runtime_refused(self):
  original=Path.read_bytes;target=Path('/opt/homebrew/Caskroom/gcloud-cli/583.0.0/google-cloud-sdk/lib/surface/auth/print_access_token.py')
  with patch.object(Path,'read_bytes',lambda p:b'changed' if p==target else original(p)),self.assertRaisesRegex(q.model.Stop,'SDK_REVIEW_DRIFT'):self.run_preflight()
  with patch.object(sqlite3,'sqlite_version','0.0'),self.assertRaisesRegex(q.model.Stop,'LOCAL_RUNTIME_DRIFT'):self.run_preflight()
 def test_authority_and_time_refused(self):
  for key,value in [('owner','other'),('externalActionAuthorized',False),('sourceCommit','f'*40)]:
   old=self.d[key];self.d[key]=value
   with self.assertRaisesRegex(q.model.Stop,'RENEWAL_EXACT_AUTHORITY'):self.run_preflight()
   self.d[key]=old
  with self.assertRaisesRegex(q.model.Stop,'RENEWAL_WINDOW'):self.run_preflight(clock=lambda:self.now+100)
  clocks=iter([self.now,self.now-1])
  with self.assertRaisesRegex(q.model.Stop,'RENEWAL_PREFLIGHT_DEADLINE'):self.run_preflight(clock=lambda:next(clocks))
 def test_real_config_guard(self):
  with self.assertRaisesRegex(self.acl.Stop,'CREDENTIAL_OVERRIDE'):self.run_preflight(environment={'CLOUDSDK_AUTH_ACCESS_TOKEN':'SYNTHETIC'})
  (self.root/'configurations/config_default').write_text('[core]\naccount = other@example.invalid\nproject = signmons\n')
  with self.assertRaisesRegex(self.acl.Stop,'CONFIG_IDENTITY_OR_OVERRIDE'):self.run_preflight()
 def test_real_git_tree_gate(self):
  repo=self.root/'git';repo.mkdir()
  def git(*args):return subprocess.check_output(['git',*args],cwd=repo,stderr=subprocess.DEVNULL)
  git('init','-q');folder=repo/'evidence/APP-013';folder.mkdir(parents=True);p=folder/'source.py';p.write_text('original\n');m=folder/'source-manifest.json';m.write_text('{}\n');git('add','.');git('-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-qm','fixture');sha=git('rev-parse','HEAD').decode().strip();packet.renewal_tree_check(sha,repo)
  for target in (p,m):
   original=target.read_text();target.write_text('changed\n')
   with self.assertRaisesRegex(q.model.Stop,'RENEWAL_COMMITTED_TREE_DRIFT'):packet.renewal_tree_check(sha,repo)
   target.write_text(original)
  with self.assertRaisesRegex(q.model.Stop,'RENEWAL_COMMITTED_TREE_DRIFT'):packet.renewal_tree_check('f'*40,repo)
if __name__=='__main__':unittest.main()
