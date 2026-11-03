"""Local entry proofs only: synthetic config/cache/HTTP; no user credentials or provider access."""
import copy
import datetime as dt
import fcntl
import io
import json
import os
from pathlib import Path
import shutil
import sqlite3
import tempfile
import socket
import subprocess
import sys
import time
import unittest
import uuid
from unittest.mock import patch

import access_check as a

class ManifestTests(unittest.TestCase):
    def verify(self,manifest):
        self.assertEqual(manifest['runtimeManifestSha256'],a.digest((a.HERE/'source-manifest.json').read_bytes()))
        self.assertEqual(set(manifest['files']),{'test_access_check.py','test_retired_role_postgres.py'})
        for name,expected in manifest['files'].items():
            self.assertEqual(a.digest((a.HERE/name).read_bytes()),expected)
        self.assertTrue(manifest['sdkReviewFiles'])
        for name,expected in manifest['sdkReviewFiles'].items():
            self.assertEqual(a.digest(Path(name).read_bytes()),expected)

    def test_current_manifest_runtime_test_and_sdk_hashes(self):
        self.verify(json.loads((a.HERE/'test-manifest.json').read_text()))

    def test_stale_runtime_test_or_sdk_hash_is_rejected(self):
        original=json.loads((a.HERE/'test-manifest.json').read_text())
        for kind in ('runtime','test','sdk'):
            manifest=copy.deepcopy(original)
            if kind=='runtime':manifest['runtimeManifestSha256']='0'*64
            elif kind=='test':manifest['files']['test_access_check.py']='0'*64
            else:manifest['sdkReviewFiles'][next(iter(manifest['sdkReviewFiles']))]='0'*64
            with self.subTest(kind=kind),self.assertRaises(AssertionError):self.verify(manifest)

def make_cache(root,expires):
    root=Path(root);os.chmod(root,0o700)
    (root/'configurations').mkdir(mode=0o700)
    (root/'active_config').write_text('default\n')
    (root/'configurations/config_default').write_text('[core]\naccount = '+a.OWNER+'\nproject = signmons\n')
    path=root/'access_tokens.db';c=sqlite3.connect(path)
    c.execute(a.CACHE_SCHEMA)
    expiry=dt.datetime.fromtimestamp(expires,dt.timezone.utc).replace(tzinfo=None).isoformat(' ')
    c.execute('INSERT INTO access_tokens(account_id,access_token,token_expiry) VALUES (?,?,?)',
              (a.OWNER,'SYNTHETIC_BEARER_NEVER_PERSIST',expiry))
    c.execute('INSERT INTO access_tokens(account_id,access_token,token_expiry) VALUES (?,?,?)',
              ('other@example.invalid','OTHER_ACCOUNT_MUST_NOT_READ',expiry))
    c.commit();c.close();os.chmod(path,0o600)
    return path

class CacheTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory(dir='/private/tmp',prefix='p08-cache-synthetic-')
        self.addCleanup(self.temp.cleanup);self.root=Path(self.temp.name)
        self.end=int(time.time())+600;self.db=make_cache(self.root,self.end+1000)
    def read(self):return a.read_cached_token(self.root,self.end,env={})
    def mutate(self,sql,params=()):
        c=sqlite3.connect(self.db);c.execute(sql,params);c.commit();c.close()
    def inventory(self):
        return {str(p.relative_to(self.root)):(p.read_bytes(),p.stat().st_mode,p.stat().st_mtime_ns)
                for p in self.root.rglob('*') if p.is_file()}
    def test_exact_owner_read_no_network_no_other_secret_no_cache_or_sidecar_write(self):
        before=self.inventory();queries=[];original=a.cache_query
        def query(c,q,params=()):
            queries.append((q,params));return original(c,q,params)
        with patch.object(a,'cache_query',side_effect=query),patch.object(socket.socket,'connect',side_effect=AssertionError('NETWORK_FORBIDDEN')):
            self.assertEqual(self.read(),'SYNTHETIC_BEARER_NEVER_PERSIST')
        self.assertEqual(queries,[(a.SCHEMA_QUERY,()),(a.TOKEN_QUERY,(a.OWNER,))])
        self.assertEqual(before,self.inventory())
    def test_missing_foreign_or_expired_cached_token_refuses_without_refresh(self):
        for expiry in [None,'not-a-date','2020-01-01 00:00:00',dt.datetime.fromtimestamp(self.end,dt.timezone.utc).replace(tzinfo=None).isoformat(' '),'2099-01-01T00:00:00+00:00']:
            self.mutate('UPDATE access_tokens SET token_expiry=? WHERE account_id=?',(expiry,a.OWNER))
            with self.subTest(expiry=expiry),self.assertRaises(a.Stop):self.read()
        self.mutate('DELETE FROM access_tokens WHERE account_id=?',(a.OWNER,))
        with self.assertRaisesRegex(a.Stop,'CACHED_TOKEN_MISSING'):self.read()
    def test_token_shape_and_restrictions_refuse(self):
        for token in [None,'','short','x'*4097,'x'*25+'\nHeader:bad']:
            self.mutate('UPDATE access_tokens SET access_token=? WHERE account_id=?',(token,a.OWNER))
            with self.assertRaisesRegex(a.Stop,'TOKEN_SHAPE'):self.read()
        self.mutate('UPDATE access_tokens SET access_token=?,regional_access_boundary=? WHERE account_id=?',('x'*25,'restricted',a.OWNER))
        with self.assertRaisesRegex(a.Stop,'TOKEN_RESTRICTION_UNSUPPORTED'):self.read()
    def test_schema_and_missing_database_fail_without_creation(self):
        self.mutate('ALTER TABLE access_tokens ADD COLUMN unexpected TEXT')
        with self.assertRaisesRegex(a.Stop,'CACHE_SCHEMA_UNSUPPORTED'):self.read()
        self.db.unlink()
        with self.assertRaisesRegex(a.Stop,'CACHE_READ_UNCONFIRMED'):self.read()
        self.assertFalse(self.db.exists())
    def test_symlink_hardlink_mode_and_owner_refuse(self):
        original=self.db.with_suffix('.original');self.db.rename(original);self.db.symlink_to(original)
        with self.assertRaisesRegex(a.Stop,'CACHE_FILE_UNSAFE'):self.read()
        self.db.unlink();os.link(original,self.db)
        with self.assertRaisesRegex(a.Stop,'CACHE_FILE_UNSAFE'):self.read()
        self.db.unlink();original.rename(self.db);os.chmod(self.db,0o644)
        with self.assertRaisesRegex(a.Stop,'CACHE_FILE_UNSAFE'):self.read()
        os.chmod(self.db,0o600)
        with patch.object(a.os,'getuid',return_value=os.getuid()+1),self.assertRaises(a.Stop):self.read()
    def test_config_identity_unknown_sections_defaults_and_environment_refuse(self):
        config=self.root/'configurations/config_default';original=config.read_text()
        for text in [original.replace(a.OWNER,'foreign'),original+'universe_domain = other.example\n',
                     original+'[auth]\naccess_token_file = forbidden\n',original+'[proxy]\naddress = foreign\n',
                     '[DEFAULT]\naccount = '+a.OWNER+'\n[core]\nproject = signmons\n',original+'api_endpoint_overrides = foreign\n']:
            config.write_text(text)
            with self.assertRaises(a.Stop):self.read()
        config.write_text(original)
        for key in ['CLOUDSDK_CONFIG','CLOUDSDK_CORE_ACCOUNT','GOOGLE_APPLICATION_CREDENTIALS','HTTPS_PROXY','https_proxy','SSL_CERT_FILE','PGHOST','DATABASE_URL']:
            with self.subTest(key=key),self.assertRaisesRegex(a.Stop,'CREDENTIAL_OVERRIDE'):
                a.read_cached_token(self.root,self.end,env={key:'forbidden'})
    def test_journals_and_wal_format_refuse_without_side_effects(self):
        for suffix in ['-journal','-wal','-shm']:
            p=Path(str(self.db)+suffix);p.write_bytes(b'synthetic')
            before=self.inventory()
            with self.assertRaisesRegex(a.Stop,'CACHE_JOURNAL_UNSUPPORTED'):self.read()
            self.assertEqual(before,self.inventory());p.unlink()
        with self.db.open('r+b') as f:f.seek(18);f.write(b'\x02\x02')
        with self.assertRaisesRegex(a.Stop,'CACHE_FORMAT_UNSUPPORTED'):self.read()
    def test_authorizer_and_query_allowlist_deny_mutations_and_other_secrets(self):
        original=a.cache_query
        def query(c,q,params=()):
            if q==a.TOKEN_QUERY:
                for sql in ['DELETE FROM access_tokens','CREATE TABLE evil(x)','ATTACH DATABASE ":memory:" AS evil',
                            'PRAGMA user_version=1','SELECT rapt_token FROM access_tokens','SELECT id_token FROM access_tokens',
                            'SELECT load_extension("evil")']:
                    with self.subTest(sql=sql),self.assertRaises(sqlite3.DatabaseError):c.execute(sql)
                with self.assertRaisesRegex(a.Stop,'CACHE_QUERY_SCOPE'):original(c,'SELECT access_token FROM access_tokens')
            return original(c,q,params)
        before=self.inventory()
        with patch.object(a,'cache_query',side_effect=query):self.read()
        self.assertEqual(before,self.inventory())
    def test_competing_real_sqlite_writer_is_blocked_during_query(self):
        original=a.cache_query
        def query(c,q,params=()):
            if q==a.TOKEN_QUERY:
                r=subprocess.run([sys.executable,'-c',
                  "import sqlite3,sys;c=sqlite3.connect(sys.argv[1],timeout=0)\ntry:c.execute('DELETE FROM access_tokens');c.commit();print('UNSAFE')\nexcept sqlite3.OperationalError:print('BLOCKED')",str(self.db)],capture_output=True,text=True,timeout=5)
                self.assertEqual(r.stdout.strip(),'BLOCKED',r.stderr)
            return original(c,q,params)
        before=self.inventory()
        with patch.object(a,'cache_query',side_effect=query):self.read()
        self.assertEqual(before,self.inventory())
    def test_existing_writer_refuses_without_wait_or_retry(self):
        child=subprocess.Popen([sys.executable,'-u','-c',
          "import sqlite3,sys;c=sqlite3.connect(sys.argv[1],timeout=0);c.execute('BEGIN IMMEDIATE');print('LOCKED',flush=True);sys.stdin.readline();c.rollback();c.close()",str(self.db)],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
        try:
            self.assertEqual(child.stdout.readline().strip(),'LOCKED')
            with self.assertRaisesRegex(a.Stop,'CACHE_BUSY'):self.read()
        finally:
            child.communicate('done\n',timeout=5)
        self.assertEqual(child.returncode,0)
    def test_database_replacement_and_config_drift_refuse(self):
        original=a.cache_query
        def query(c,q,params=()):
            result=original(c,q,params)
            if q==a.TOKEN_QUERY:
                replacement=self.root/'replacement.db';shutil.copyfile(self.db,replacement);os.chmod(replacement,0o600);os.replace(replacement,self.db)
            return result
        with patch.object(a,'cache_query',side_effect=query),self.assertRaisesRegex(a.Stop,'CACHE_CHANGED'):self.read()
        def config_change(c,q,params=()):
            result=original(c,q,params)
            if q==a.TOKEN_QUERY:(self.root/'active_config').write_text('other')
            return result
        with patch.object(a,'cache_query',side_effect=config_change),self.assertRaises(a.Stop):self.read()
    def test_query_exception_closes_connection_and_releases_writer_lock(self):
        original=a.cache_query
        with patch.object(a,'cache_query',side_effect=RuntimeError('PRIVATE_TOKEN_NEVER_EXPORT')):
            with self.assertRaisesRegex(a.Stop,'^CACHE_READ_UNCONFIRMED$'):self.read()
        r=subprocess.run([sys.executable,'-c',"import sqlite3,sys;c=sqlite3.connect(sys.argv[1],timeout=0);c.execute('BEGIN IMMEDIATE');c.rollback();c.close()",str(self.db)],capture_output=True,text=True,timeout=5)
        self.assertEqual(r.returncode,0,r.stderr)

    def test_config_file_symlink_and_cache_oversize_refuse(self):
        path=self.root/'active_config';original=self.root/'old_config';path.rename(original);path.symlink_to(original)
        with self.assertRaisesRegex(a.Stop,'CACHE_FILE_UNSAFE'):self.read()
        path.unlink();original.rename(path)
        with self.db.open('r+b') as f:f.truncate(16*1024*1024+1)
        with self.assertRaisesRegex(a.Stop,'CACHE_FILE_UNSAFE'):self.read()
    def test_total_cache_deadline_closes_database_and_releases_lock(self):
        def slow_query(*args):time.sleep(.1)
        with patch.object(a,'cache_query',side_effect=slow_query):
            with self.assertRaisesRegex(a.Stop,'HTTP_TIMEOUT'):
                with a.http_deadline(.02):self.read()
        r=subprocess.run([sys.executable,'-c',"import sqlite3,sys;c=sqlite3.connect(sys.argv[1],timeout=0);c.execute('BEGIN IMMEDIATE');c.rollback();c.close()",str(self.db)],capture_output=True,text=True,timeout=5)
        self.assertEqual(r.returncode,0,r.stderr)

class FakeIO:
    proof=True
    def __init__(self,case,cap):self.case=case;self.cap=cap;self.calls=[];self.closed=False
    def cached_token(self,deadline):
        self.calls.append(('cache',0))
        if self.case.break_at==len(self.calls):raise a.Stop('INTERRUPTED')
        return 'SYNTHETIC_BEARER_NEVER_PERSIST'
    def https(self,i,number,token,deadline):
        self.calls.append(('https',i))
        if self.case.break_at==len(self.calls):raise a.Stop('INTERRUPTED')
        self.case.assertEqual(number,None if i==0 else self.case.number)
        self.case.assertEqual(token,'SYNTHETIC_BEARER_NEVER_PERSIST')
        values=[{'projectId':'signmons','projectNumber':self.case.number,'lifecycleState':'ACTIVE'},
          *[json.loads(v) for v in self.case.role_json],
          {'permissions':a.PROJECT_PERMISSIONS},{'permissions':a.IDENTITY_PERMISSIONS},
          {'name':a.http_contract(number)[5]['url'].split('/v1/')[1],'state':self.case.service}]
        return self.case.http_override.get(i,{'status':200,'body':json.dumps(values[i]).encode()})
    def close(self):self.closed=True;return not self.case.close_failure

class AccessTests(unittest.TestCase):
    def setUp(self):
        self.number='123456789012'
        self.original_project_hash=a.PROJECT_HASH
        self.hash_patch=patch.object(a,'PROJECT_HASH',a.digest(self.number));self.hash_patch.start();self.addCleanup(self.hash_patch.stop)
        op=str(uuid.uuid4());self.root=Path('/private/tmp/p08-access-check-'+op);self.root.mkdir(mode=0o700)
        self.addCleanup(lambda:shutil.rmtree(self.root))
        now=int(time.time())-1
        iso=lambda n:dt.datetime.fromtimestamp(now+n,dt.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')
        self.p={'version':2,'section':'APP-013/3A/P08','operationId':op,'execution':'PROOF_ONLY',
          'project':'signmons','ownerPrincipal':a.OWNER,'identity':a.IDENTITY,'projectNumberSha256':a.PROJECT_HASH,
          'contractSha256':a.contract_hash(),'limits':dict(a.LIMITS),
          'window':dict(zip(('start','cutoff','readEnd','closeoutEnd','purgeEnd'),map(iso,(0,120,240,540,600)))),
          'sourceManifestSha256':a.digest((a.HERE/'source-manifest.json').read_bytes()),'sourceCommit':'0'*40}
        self.path=self.root/'plan.json';self.seal()
        self.role_json=[]
        for role in a.sources()[1].ROLES:
            self.role_json.append(json.dumps({'name':role['name'],'title':role['title'],
              'description':role['description'],'includedPermissions':[role['permission']],'stage':'GA'}))
        self.http_override={};self.service='ENABLED';self.close_failure=False
        self.break_at=None;self.io=None;self.factory_calls=0
    def seal(self):
        self.p['decision']={'decision':'APPROVE_LOCAL_NARROW_ACCESS_PROOF','scopeSha256':a.digest({k:v for k,v in self.p.items() if k!='decision'})}
        if self.path.exists():self.path.unlink()
        a.reserve(self.path,self.p)
    def factory(self,cap):
        self.factory_calls+=1;self.io=FakeIO(self,cap);return self.io
    def run_entry(self):return a.run(self.path,io_factory=self.factory)
    def reset_run(self):
        for p in self.root.iterdir():p.unlink()
        self.seal();self.io=None;self.factory_calls=0
    def external(self):
        self.p['execution']='EXTERNAL'
        scope=a.digest({k:v for k,v in self.p.items() if k!='decision'})
        raw=json.dumps({'decision':'APPROVE_EXACT_P08_NARROW_ACCESS_READ','owner':'Debynyhan Banks',
          'operationId':self.p['operationId'],'scopeSha256':scope,
          'sourceManifestSha256':self.p['sourceManifestSha256'],'readOnly':True}).encode()
        self.p['decision']={'commit':'1'*40,'path':'APP013_P08_ACCESS_READ_OPERATION_20261101.json','sha256':a.digest(raw)}
        self.path.unlink();a.reserve(self.path,self.p)
        return lambda repo,commit,path:raw if repo==a.GOV else (a.BACKEND/path).read_bytes()

    def test_positive_exact_entry_counts_and_private_purge(self):
        r=self.run_entry()
        self.assertEqual(r['status'],'NARROW_ACCESS_OBSERVED');self.assertEqual(r['counts'],{'cli':0,'https':6,'cache':1})
        self.assertFalse(r['executionReady'] or r['externalObservation']);self.assertTrue(r['privateInputsAbsent'])
        self.assertFalse(self.path.exists());self.assertTrue(self.io.closed)
        self.assertEqual(self.io.calls,[tuple(v) for v in a.CALLS])
        retained=''.join(p.read_text() for p in self.root.iterdir())
        for raw in [self.number,a.OWNER,'SYNTHETIC_BEARER_NEVER_PERSIST','includedPermissions']:
            self.assertNotIn(raw,retained)
    def test_disabled_service_is_blocker_without_mutation(self):
        self.service='DISABLED';r=self.run_entry();self.assertEqual(r['status'],'SERVICE_DISABLED')
        self.assertEqual(r['counts'],{'cli':0,'https':6,'cache':1});self.assertEqual(r['residuals'],[])
    def test_explicit_false_and_missing_deleted_use_existing_validator(self):
        for i,s in enumerate(self.role_json):
            d=json.loads(s);d['deleted']=False;self.role_json[i]=json.dumps(d)
        self.assertEqual(self.run_entry()['status'],'NARROW_ACCESS_OBSERVED')
    def test_native_default_refuses_local_before_attempt_or_credentials(self):
        with self.assertRaisesRegex(a.Stop,'NATIVE_REQUIRES_EXTERNAL_AUTHORITY'):a.run(self.path)
        self.assertFalse((self.root/'attempt.json').exists())
    def test_external_authority_constructor_does_not_resolve_credentials(self):
        get=self.external();cap=a.ReadCapability(self.p,self.root,read_commit=get)
        with patch.object(a,'read_cached_token',side_effect=AssertionError('NO_CREDENTIAL_READ')):
            io=a.NativeIO(cap);self.assertTrue(io.close())
        self.assertFalse((self.root/'attempt.json').exists())
    def test_missing_external_commit_refuses_before_factory(self):
        self.external()
        with self.assertRaisesRegex(Exception,'COMMITTED_EVIDENCE_MISSING'):self.run_entry()
        self.assertEqual(self.factory_calls,0)
    def test_plan_source_scope_and_approval_drift_refuse(self):
        original=copy.deepcopy(self.p)
        for key,value in [('contractSha256','0'*64),('sourceManifestSha256','0'*64),('ownerPrincipal','foreign'),
                          ('limits',{'cli':26,'https':10,'sql':2,'mutations':0,'retry':0}),('decision',{})]:
            self.p=copy.deepcopy(original);self.p[key]=value
            self.path.unlink();a.reserve(self.path,self.p)
            with self.assertRaises(a.Stop):self.run_entry()
            self.assertEqual(self.factory_calls,0)
    def test_committed_source_or_decision_drift_refuses(self):
        get=self.external()
        with self.assertRaisesRegex(a.Stop,'COMMITTED_MANIFEST'):
            a.ReadCapability(self.p,self.root,read_commit=lambda repo,commit,path:get(repo,commit,path) if repo==a.GOV else b'bad')
        self.p['decision']['sha256']='0'*64
        with self.assertRaisesRegex(a.Stop,'EXACT_OWNER_APPROVAL'):a.ReadCapability(self.p,self.root,read_commit=get)
    def test_project_and_invalid_output_stop_early(self):
        for value in ['null','{}',b'\xff','x'*65537,json.dumps({'projectId':'foreign'})]:
            self.reset_run();self.http_override={0:{'status':200,'body':value}}
            r=self.run_entry();self.assertIn(r['failure'],('HTTP_BODY_UNKNOWN','PROJECT_DRIFT'))
            self.assertEqual(r['counts'],{'cli':0,'https':1,'cache':1});self.assertFalse(r['executionReady'])
    def test_role_null_deleted_broader_and_foreign_refuse(self):
        original=json.loads(self.role_json[0])
        cases=[None,{**original,'deleted':None},{**original,'deleted':True},
               {**original,'includedPermissions':['foreign']},{**original,'name':'foreign'},
               {**original,'extra':'unexpected'}]
        for value in cases:
            self.reset_run();self.http_override={1:{'status':200,'body':json.dumps(value)}}
            r=self.run_entry();self.assertIn(r['failure'],('ROLE_DRIFT','HTTP_BODY_UNKNOWN'))
            self.assertEqual(r['counts'],{'cli':0,'https':2,'cache':1})
    def test_permission_empty_missing_null_duplicate_foreign_refuse(self):
        cases=[{}, {'permissions':[]},{'permissions':None},{'permissions':['foreign']},
          {'permissions':a.PROJECT_PERMISSIONS+[a.PROJECT_PERMISSIONS[0]]}, {'permissions':[5]},None]
        for value in cases:
            self.reset_run();self.http_override={3:{'status':200,'body':json.dumps(value)}}
            r=self.run_entry();self.assertIn(r['failure'],('PERMISSION_DENIED','PERMISSION_SHAPE','HTTP_BODY_UNKNOWN'))
            self.assertEqual(r['counts'],{'cli':0,'https':4,'cache':1})
    def test_http_denial_redirect_oversize_encoding_and_shape(self):
        cases=[{'status':403,'body':'{}'},{'status':302,'body':'{}'}, {'status':200,'body':'x'*65537},
          {'status':200,'body':b'\xff'}, {'status':200,'body':'not json'}, {'status':True,'body':'{}'}]
        for value in cases:
            self.reset_run();self.http_override={0:value};r=self.run_entry()
            self.assertEqual(r['status'],'NARROW_ACCESS_STOPPED');self.assertEqual(r['counts'],{'cli':0,'https':1,'cache':1})
    def test_service_null_and_wrong_resource_refuse(self):
        for value in [None,{'name':'foreign','state':'ENABLED'}, {'state':None}]:
            self.reset_run();self.http_override={5:{'status':200,'body':json.dumps(value)}}
            self.assertIn(self.run_entry()['failure'],('HTTP_BODY_UNKNOWN','SERVICE_SHAPE'))
    def test_duplicate_and_concurrent_attempts_refuse(self):
        fd=os.open(self.root/'entry.lock',os.O_CREAT|os.O_WRONLY,0o600)
        try:
            fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
            with self.assertRaisesRegex(a.Stop,'ENTRY_RUNNING'):self.run_entry()
            self.assertEqual(self.factory_calls,0)
        finally:os.close(fd)
        a.reserve(self.root/'attempt.json',{})
        with self.assertRaises(FileExistsError):self.run_entry()
        self.assertEqual(self.io.calls,[])
    def test_foreign_symlink_hardlink_and_wrong_mode_refuse(self):
        foreign=self.root/'foreign';foreign.write_text('foreign');os.chmod(foreign,0o600)
        with self.assertRaisesRegex(a.Stop,'PRIVATE_INVENTORY'):self.run_entry()
        foreign.unlink();(self.root/'journal.json').symlink_to(self.path)
        with self.assertRaisesRegex(a.Stop,'PRIVATE_INVENTORY'):self.run_entry()
        (self.root/'journal.json').unlink();os.link(self.path,self.root/'journal.json')
        with self.assertRaisesRegex(a.Stop,'PRIVATE_INPUT'):self.run_entry()
        (self.root/'journal.json').unlink();os.chmod(self.path,0o644)
        with self.assertRaisesRegex(a.Stop,'PRIVATE_INPUT'):self.run_entry()
    def test_cutoff_late_cleanup_and_clock_rollback(self):
        for mode,key in [('read','cutoff'),('closeout','closeoutEnd')]:
            with self.assertRaisesRegex(a.Stop,'ENTRY_CUTOFF'):
                a.run(self.path,mode,self.factory,clock=lambda:a.utc(self.p['window'][key]))
        cap=a.ReadCapability(self.p,self.root);cap.clock=lambda:cap.last-1
        with self.assertRaisesRegex(a.Stop,'CLOCK_ROLLBACK'):cap.gate()
    def test_interrupt_every_reserved_call_never_retries(self):
        for call in range(1,8):
            self.reset_run();self.break_at=call;r=self.run_entry()
            self.assertEqual(r['failure'],'INTERRUPTED');self.assertEqual(len(self.io.calls),call)
            self.assertEqual(len(set(self.io.calls)),call);self.assertTrue(self.io.closed)
            self.assertTrue(r['privateInputsAbsent']);self.assertEqual(r['residuals'],[])
    def seed_interruption(self,pending=False,scratch=False):
        cap=a.ReadCapability(self.p,self.root);reader=a.Reader(cap,None)
        a.reserve(self.root/'attempt.json',{'operationId':self.p['operationId'],'planSha256':cap.hash})
        reader.j['calls']=[['cache',0]];reader.j['pending']=['cache',0] if pending else None
        reader.j['transportSettled']=not pending
        a.reserve(self.root/'journal.json',reader.j)
        if scratch:a.reserve(self.root/'journal-next.json',reader.j)
    def test_independent_cleanup_after_cutoff_performs_zero_provider_calls(self):
        self.seed_interruption()
        r=a.run(self.path,'closeout',self.factory,clock=lambda:a.utc(self.p['window']['cutoff'])+1)
        self.assertEqual(r['status'],'NARROW_ACCESS_STOPPED');self.assertEqual(r['residuals'],[])
        self.assertEqual(self.factory_calls,0);self.assertTrue(r['privateInputsAbsent'])
    def test_unknown_orphan_and_interrupted_journal_remain_residuals(self):
        self.seed_interruption(pending=True,scratch=True)
        r=a.run(self.path,'closeout',self.factory)
        self.assertEqual(r['status'],'CONTAINMENT_UNCONFIRMED')
        self.assertEqual(r['residuals'],['JOURNAL_WRITE_INTERRUPTED','PROCESS_OUTCOME_UNKNOWN'])
        self.assertEqual(self.factory_calls,0);self.assertTrue(r['privateInputsAbsent'])
    def test_fresh_cleanup_recovers_finished_reads_without_replay(self):
        with patch.object(a.Reader,'closeout',side_effect=SystemExit('simulated parent exit')):
            with self.assertRaises(SystemExit):self.run_entry()
        self.assertEqual(self.io.calls,[tuple(v) for v in a.CALLS])
        self.assertTrue(self.io.closed)
        r=a.run(self.path,'closeout',self.factory,clock=lambda:a.utc(self.p['window']['cutoff'])+1)
        self.assertEqual(r['status'],'NARROW_ACCESS_OBSERVED');self.assertEqual(self.factory_calls,1)
        self.assertTrue(r['privateInputsAbsent'])
    def test_foreign_journal_cannot_authorize_cleanup(self):
        self.seed_interruption();p=self.root/'journal.json';j=a.read(p);j['operationId']=str(uuid.uuid4())
        p.unlink();a.reserve(p,j)
        with self.assertRaisesRegex(a.Stop,'JOURNAL_BINDING'):a.run(self.path,'closeout',self.factory)
        self.assertTrue(self.path.exists());self.assertEqual(self.factory_calls,0)
    def test_close_failure_cannot_report_success(self):
        self.close_failure=True;r=self.run_entry()
        self.assertEqual(r['status'],'CONTAINMENT_UNCONFIRMED');self.assertIn('PROCESS_CLOSE_UNCONFIRMED',r['residuals'])
    def native_for_serialization_test(self):
        get=self.external();cap=a.ReadCapability(self.p,self.root,read_commit=get)
        return cap,a.NativeIO(cap)
    def test_cli_removed_and_old_contract_refused(self):
        self.assertFalse(hasattr(a.NativeIO,'cli') or hasattr(a.NativeIO,'_command'))
        self.p['version']=1;self.seal()
        with self.assertRaisesRegex(a.Stop,'PLAN_MODE'):self.run_entry()
        self.assertEqual(self.factory_calls,0)
    def test_actual_native_https_serialization_redirect_and_body_close(self):
        cap,io=self.native_for_serialization_test()
        class Response:
            status=200;closed=False
            def read(self,n):return b'{"permissions":[]}'
            def close(self):self.closed=True
        response=Response()
        with patch.object(a.urllib.request,'build_opener') as factory:
            factory.return_value.open.return_value=response
            r=io.https(3,self.number,'SYNTHETIC_BEARER',cap.times['readEnd'])
            req=factory.return_value.open.call_args.args[0]
            self.assertEqual(req.full_url,a.http_contract(self.number)[3]['url'])
            self.assertEqual(json.loads(req.data),{'permissions':a.PROJECT_PERMISSIONS})
            self.assertTrue(response.closed);self.assertEqual(r['status'],200)
            response.status=302
            with self.assertRaisesRegex(a.Stop,'HTTP_REDIRECT'):io.https(0,self.number,'SYNTHETIC_BEARER',cap.times['readEnd'])
            self.assertTrue(response.closed)
        self.assertIsNone(a.NoRedirect().redirect_request(None,None,302,'',{},'https://foreign.invalid'))
    def test_total_http_deadline_closes_slow_response(self):
        cap,io=self.native_for_serialization_test()
        class SlowResponse:
            status=200;closed=False
            def read(self,n):time.sleep(.2);return b'{}'
            def close(self):self.closed=True
        response=SlowResponse()
        with patch.object(a.urllib.request,'build_opener') as factory:
            factory.return_value.open.return_value=response
            with self.assertRaisesRegex(a.Stop,'HTTP_TIMEOUT'):
                io.https(0,self.number,'SYNTHETIC_TOKEN',time.time()+.03)
        self.assertTrue(response.closed);self.assertIsNone(io.response)
    def test_call_ceiling_refuses_before_transport(self):
        cap=a.ReadCapability(self.p,self.root);io=FakeIO(self,cap);r=a.Reader(cap,io)
        r.j['calls']=copy.deepcopy(a.CALLS)
        with self.assertRaisesRegex(a.Stop,'CALL_LIMIT'):r.call('https',2)
        self.assertEqual(io.calls,[])
    def test_final_source_gate_and_sdk_fact(self):
        self.assertEqual(set(a.verify_sources()['files']),{'access_check.py'})
        self.assertEqual(a.native_readiness(),{'ready':False,'localTransportReady':True,'reason':'EXTERNAL_QUALIFICATION_NOT_AUTHORIZED'})
        self.assertEqual(self.original_project_hash,a.sources()[0].PROJECT_NUMBER_SHA256)
    def test_actual_command_entry_reports_source_and_refuses_local_native(self):
        result=subprocess.run([sys.executable,'-B',str(a.HERE/'access_check.py'),'--check-source'],capture_output=True,text=True,timeout=5)
        self.assertEqual(result.returncode,0,result.stderr)
        self.assertEqual(json.loads(result.stdout),{'ready':False,'localTransportReady':True,'reason':'EXTERNAL_QUALIFICATION_NOT_AUTHORIZED'})
        with patch.object(a,'PROJECT_HASH',self.original_project_hash):
            self.p['projectNumberSha256']=a.PROJECT_HASH;self.p['contractSha256']=a.contract_hash();self.seal()
        result=subprocess.run([sys.executable,'-B',str(a.HERE/'access_check.py'),'--read',str(self.path)],capture_output=True,text=True,timeout=5)
        self.assertEqual(result.returncode,2);self.assertEqual(result.stderr,'')
        self.assertEqual(json.loads(result.stdout),{'status':'NARROW_ACCESS_REFUSED_OR_UNCONFIRMED'})
        self.assertFalse((self.root/'attempt.json').exists())

    def test_native_entry_uses_actual_synthetic_cache_and_six_fixed_requests(self):
        get=self.external();responses=[];requests=[]
        with tempfile.TemporaryDirectory(dir='/private/tmp',prefix='p08-native-cache-') as tmp:
            root=Path(tmp);db=make_cache(root,a.utc(self.p['window']['purgeEnd'])+1000)
            before={p.relative_to(root):p.read_bytes() for p in root.rglob('*') if p.is_file()}
            values=[{'projectId':'signmons','projectNumber':self.number,'lifecycleState':'ACTIVE'},
              *[json.loads(v) for v in self.role_json],{'permissions':a.PROJECT_PERMISSIONS},
              {'permissions':a.IDENTITY_PERMISSIONS},{'name':a.http_contract(self.number)[5]['url'].split('/v1/')[1],'state':'ENABLED'}]
            class Response:
                status=200
                def __init__(self,value):self.value=value;self.closed=False
                def read(self,n):return json.dumps(self.value).encode()
                def close(self):self.closed=True
            def open_request(req,timeout):
                requests.append(req);r=Response(values[len(requests)-1]);responses.append(r);return r
            original=a.read_cached_token
            def cached(*args,**kwargs):
                j=a.read(self.root/'journal.json');self.assertEqual(j['pending'],['cache',0]);self.assertEqual(j['calls'],[['cache',0]])
                return original(*args,**kwargs)
            with patch.object(a,'CONFIG_ROOT',root),patch.dict(os.environ,{},clear=True),                 patch.object(a,'read_cached_token',side_effect=cached) as cache,                 patch.object(socket.socket,'connect',side_effect=AssertionError('NETWORK_FORBIDDEN')),                 patch.object(a.urllib.request,'build_opener') as factory:
                factory.return_value.open.side_effect=open_request
                result=a.run(self.path,read_commit=get)
                self.assertEqual(cache.call_count,1)
            self.assertEqual(result['status'],'NARROW_ACCESS_OBSERVED',result)
            self.assertEqual(result['counts'],{'cli':0,'https':6,'cache':1});self.assertFalse(result['executionReady'])
            self.assertEqual([r.full_url for r in requests],[d['url'] for d in a.http_contract(self.number)])
            for req,d in zip(requests,a.http_contract(self.number)):
                self.assertEqual(req.method,d['method']);self.assertEqual(None if req.data is None else json.loads(req.data),d['body'])
                self.assertEqual(req.get_header('Authorization'),'Bearer SYNTHETIC_BEARER_NEVER_PERSIST')
            self.assertTrue(all(r.closed for r in responses));self.assertEqual(len(responses),6)
            self.assertEqual(before,{p.relative_to(root):p.read_bytes() for p in root.rglob('*') if p.is_file()})
            for p in self.root.iterdir():self.assertNotIn('SYNTHETIC_BEARER',p.read_text())
    def test_native_failures_attempt_once_and_cache_failure_prevents_https(self):
        get=self.external()
        with tempfile.TemporaryDirectory(dir='/private/tmp',prefix='p08-native-negative-') as tmp:
            root=Path(tmp);make_cache(root,a.utc(self.p['window']['purgeEnd'])+1000)
            for status in [401,429,503,302]:
                for p in self.root.iterdir():p.unlink()
                a.reserve(self.path,self.p)
                class Response:
                    closed=False
                    def read(self,n):return b'{}'
                    def close(self):self.closed=True
                response=Response();response.status=status
                with patch.object(a,'CONFIG_ROOT',root),patch.dict(os.environ,{},clear=True),patch.object(a.urllib.request,'build_opener') as factory:
                    factory.return_value.open.return_value=response
                    result=a.run(self.path,read_commit=get)
                    self.assertEqual(factory.return_value.open.call_count,1)
                self.assertEqual(result['status'],'NARROW_ACCESS_STOPPED');self.assertTrue(response.closed)
            for p in self.root.iterdir():p.unlink()
            a.reserve(self.path,self.p);(root/'access_tokens.db').unlink()
            with patch.object(a,'CONFIG_ROOT',root),patch.dict(os.environ,{},clear=True),patch.object(a.urllib.request,'build_opener') as factory:
                result=a.run(self.path,read_commit=get);factory.assert_not_called()
            self.assertEqual(result['counts'],{'cli':0,'https':0,'cache':1});self.assertTrue(result['privateInputsAbsent'])

    def test_native_http_error_and_connection_timeout_have_one_attempt_no_proxy(self):
        cap,transport=self.native_for_serialization_test()
        for status in [401,429,503,302]:
            body=io.BytesIO(b'{}')
            error=a.urllib.error.HTTPError('https://synthetic.invalid',status,'synthetic',{},body)
            with patch.object(a.urllib.request,'build_opener') as factory:
                factory.return_value.open.side_effect=error
                if status==302:
                    with self.assertRaisesRegex(a.Stop,'HTTP_REDIRECT'):transport.https(0,None,'SYNTHETIC_TOKEN',cap.times['readEnd'])
                else:self.assertEqual(transport.https(0,None,'SYNTHETIC_TOKEN',cap.times['readEnd'])['status'],status)
                self.assertEqual(factory.return_value.open.call_count,1)
                self.assertIsInstance(factory.call_args.args[0],a.urllib.request.ProxyHandler)
                self.assertEqual(factory.call_args.args[0].proxies,{})
                self.assertTrue(body.closed)
        with patch.object(a.urllib.request,'build_opener') as factory:
            factory.return_value.open.side_effect=TimeoutError('PRIVATE_OUTPUT')
            with self.assertRaisesRegex(a.Stop,'^HTTP_UNCONFIRMED$'):transport.https(0,None,'SYNTHETIC_TOKEN',cap.times['readEnd'])
            self.assertEqual(factory.return_value.open.call_count,1)
        self.assertTrue(transport.close())

SDK_PROBE = r'''
import json,os,socket,sys,tempfile,time
from unittest.mock import patch
sdk='/opt/homebrew/Caskroom/gcloud-cli/583.0.0/google-cloud-sdk/lib'
sys.path[:0]=[sdk,sdk+'/third_party']
with tempfile.TemporaryDirectory(prefix='p08-sdk-anonymous-',dir='/private/tmp') as config:
 os.environ['CLOUDSDK_CONFIG']=config
 with patch.object(socket.socket,'connect',side_effect=AssertionError('NETWORK_FORBIDDEN')), \
      patch.object(socket.socket,'connect_ex',side_effect=AssertionError('NETWORK_FORBIDDEN')), \
      patch.object(time,'sleep',return_value=None):
  import httplib2
  from googlecloudsdk.generated_clients.apis.iam.v1 import iam_v1_client
  from googlecloudsdk.generated_clients.apis.cloudresourcemanager.v1 import cloudresourcemanager_v1_client
  from google.oauth2 import credentials, _client
  from google.auth import exceptions
  class FakeHTTP:
   connections={}
   def __init__(self):self.calls=0
   def request(self,*args,**kwargs):
    self.calls+=1
    return httplib2.Response({'status':'503','content-type':'application/json'}),b'{"error":{"code":503,"message":"synthetic"}}'
  def generated(kind,one_attempt=False):
   http=FakeHTTP()
   cls=iam_v1_client.IamV1 if kind=='iam' else cloudresourcemanager_v1_client.CloudresourcemanagerV1
   client=cls(get_credentials=False,http=http)
   if one_attempt:client.num_retries=0
   try:
    if kind=='iam':client.organizations_roles.Get(client.MESSAGES_MODULE.IamOrganizationsRolesGetRequest(name='projects/synthetic/roles/synthetic'))
    else:client.projects.Get(client.MESSAGES_MODULE.CloudresourcemanagerProjectsGetRequest(projectId='synthetic'))
   except Exception as error:
    assert type(error).__name__ in ('HttpError','HttpServiceUnavailableError','BadStatusCodeError'),type(error).__name__
   return http.calls
  class Response:
   status=503;data=b'{"error":"temporarily_unavailable"}';headers={}
  class Request:
   def __init__(self):self.calls=0
   def __call__(self,**kwargs):self.calls+=1;return Response()
  def token(actual_credential):
   request=Request()
   try:
    if actual_credential:
     cred=credentials.Credentials(None,refresh_token='synthetic-refresh',token_uri='https://oauth2.googleapis.com/token',client_id='synthetic-id',client_secret='synthetic-secret')
     cred.refresh(request)
    else:
     _client.refresh_grant(request,'https://oauth2.googleapis.com/token','synthetic-refresh','synthetic-id','synthetic-secret',can_retry=False)
   except exceptions.RefreshError:pass
   return request.calls
  result={'iam_default_attempts':generated('iam'),'project_default_attempts':generated('project'),
   'iam_explicit_zero_attempts':generated('iam',True),'project_explicit_zero_attempts':generated('project',True),
   'credential_refresh_attempts':token(True),'low_level_refresh_no_retry_attempts':token(False),
   'real_network_calls':0,'real_credentials_loaded':False}
  print(json.dumps(result))
'''

class SDKRetryTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        # Separate interpreter, fake transports and anonymous SDK clients only.
        env={k:v for k,v in os.environ.items() if not k.startswith(('CLOUDSDK_','GOOGLE_','PG')) and k!='DATABASE_URL'}
        r=subprocess.run([sys.executable,'-B','-c',SDK_PROBE],capture_output=True,text=True,timeout=15,env=env)
        if r.returncode:raise AssertionError(r.stderr)
        cls.result=json.loads(r.stdout)
    def test_iam_default_repeats_synthetic_unavailable_response(self):
        self.assertEqual(self.result['iam_default_attempts'],5)
    def test_project_default_repeats_synthetic_unavailable_response(self):
        self.assertEqual(self.result['project_default_attempts'],5)
    def test_real_credential_class_refresh_repeats_synthetic_response(self):
        self.assertEqual(self.result['credential_refresh_attempts'],3)
    def test_explicit_library_controls_do_not_prove_cli_exposure(self):
        self.assertEqual(self.result['iam_explicit_zero_attempts'],1)
        self.assertEqual(self.result['project_explicit_zero_attempts'],1)
        self.assertEqual(self.result['low_level_refresh_no_retry_attempts'],1)
        self.assertFalse(self.result['real_credentials_loaded'])
        self.assertEqual(self.result['real_network_calls'],0)

class ServiceFakeIO(FakeIO):
    def https(self,index,number,token,deadline,operation=None):
        self.calls.append(('https',index))
        if self.case.break_at==len(self.calls):raise a.Stop('INTERRUPTED')
        if index==3:
            j=a.read(self.cap.root/'journal.json')
            self.case.assertTrue(j['enableAttempted']);self.case.assertEqual(j['pending'],['https',3])
        if 4<=index<=8:self.case.assertEqual(operation,self.case.operation)
        return self.case.http_override.get(index,{'status':200,'body':json.dumps(self.case.value(index)).encode()})
    def wait_pending(self,deadline):
        self.case.waits+=1
        if self.case.wait_failure:raise a.Stop('INTERRUPTED')

class ServiceTests(unittest.TestCase):
    def setUp(self):
        AccessTests.setUp(self)
        self.p.update(version=3,limits=dict(a.SERVICE_LIMITS),contractSha256=a.service_contract_hash(),serviceRetention='RETAIN_ENABLED')
        self.seal();self.service='DISABLED';self.pending=0;self.waits=0;self.wait_failure=False
        self.operation='operations/synthetic-operation';self.after='ENABLED'
        for method in ('connect','connect_ex'):
            p=patch.object(socket.socket,method,side_effect=AssertionError('NETWORK_FORBIDDEN'));p.start();self.addCleanup(p.stop)
    def seal(self):
        self.p['decision']={'decision':'APPROVE_LOCAL_SERVICE_ENABLEMENT_PROOF',
          'scopeSha256':a.digest({k:v for k,v in self.p.items() if k!='decision'})}
        if self.path.exists():self.path.unlink()
        a.reserve(self.path,self.p)
    reset_run=AccessTests.reset_run
    def factory(self,cap):
        self.factory_calls+=1;self.io=ServiceFakeIO(self,cap);return self.io
    def run_entry(self,**kwargs):return a.run(self.path,'enable',self.factory,**kwargs)
    def value(self,index):
        service={'name':f'projects/{self.number}/services/apikeys.googleapis.com','state':self.after}
        if index==0:return {'projectId':'signmons','projectNumber':self.number,'lifecycleState':'ACTIVE'}
        if index==1:return {'permissions':a.SERVICE_PERMISSIONS}
        if index==2:return {**service,'state':self.service}
        if index==9:return service
        return {'name':self.operation} if index<3+self.pending else {
            'name':self.operation,'done':True,'response':{'@type':'type.googleapis.com/google.api.serviceusage.v1.EnableServiceResponse','service':service}}
    def external(self):
        self.p['execution']='EXTERNAL'
        scope=a.digest({k:v for k,v in self.p.items() if k!='decision'})
        raw=json.dumps({'decision':'APPROVE_EXACT_P08_SERVICE_ENABLEMENT','owner':'Debynyhan Banks',
            'operationId':self.p['operationId'],'scopeSha256':scope,'sourceManifestSha256':self.p['sourceManifestSha256'],
            'serviceRetention':'RETAIN_ENABLED','service':'apikeys.googleapis.com','maxEnableAttempts':1}).encode()
        self.p['decision']={'commit':'1'*40,'path':'APP013_P08_SERVICE_ENABLE_OPERATION_20261103.json','sha256':a.digest(raw)}
        self.path.unlink();a.reserve(self.path,self.p)
        return lambda repo,commit,path:raw if repo==a.GOV else (a.BACKEND/path).read_bytes()
    def test_enable_once_and_preexisting_skip_mutation(self):
        r=self.run_entry();self.assertEqual(r['status'],'SERVICE_ENABLEMENT_OBSERVED',r)
        self.assertEqual(r['counts'],dict(cli=0,cache=1,https=5));self.assertEqual(self.waits,0)
        self.assertFalse(r['executionReady']);self.assertTrue(r['privateInputsAbsent'])
        self.assertEqual(self.io.calls,[('cache',0),('https',0),('https',1),('https',2),('https',3),('https',9)])
        self.reset_run();self.service='ENABLED';r=self.run_entry()
        self.assertEqual(r['status'],'SERVICE_PREEXISTING_ENABLED');self.assertEqual(r['counts']['https'],3)
        self.assertFalse(a.read(self.root/'journal.json')['enableAttempted'])
    def test_five_successful_pending_observations_ceiling_and_poll_exhaustion(self):
        self.pending=5;r=self.run_entry();self.assertEqual(r['status'],'SERVICE_ENABLEMENT_OBSERVED',r)
        self.assertEqual(r['counts']['https'],10);self.assertEqual(self.waits,5)
        self.reset_run();self.waits=0;self.pending=6;r=self.run_entry()
        self.assertEqual(r['failure'],'OPERATION_POLL_LIMIT');self.assertEqual(self.waits,5)
        self.assertEqual(r['counts']['https'],9);self.assertEqual(r['residuals'],['SERVICE_ENABLE_OUTCOME_UNKNOWN'])
    def test_done_absent_null_and_false_are_pending_with_same_operation(self):
        for done in ('absent',None,False):
            self.reset_run();self.waits=0
            value={'name':self.operation,'metadata':None}
            if done!='absent':value['done']=done
            self.http_override={3:{'status':200,'body':json.dumps(value)}}
            self.assertEqual(self.run_entry()['status'],'SERVICE_ENABLEMENT_OBSERVED');self.assertEqual(self.waits,1)
    def test_operation_shapes_fail_without_retry_and_preserve_remote_unknown(self):
        valid=self.value(3)
        cases=[None,{}, {'name':'https://evil.invalid/operations/x'}, {'name':'operations/x?key=bad'},
            {'name':'operations/x%2Fy'}, {'name':'operations/../x'}, {'name':'projects/foreign/operations/x'},
            {**valid,'done':1},{**valid,'done':'true'},{**valid,'metadata':[]},{**valid,'extra':True},
            {**valid,'error':{}},{**valid,'response':None},{**valid,'response':{}},
            {**valid,'response':{'@type':'foreign','service':valid['response']['service']}},
            {'name':self.operation,'done':False,'response':{}},
            {'name':self.operation,'done':True,'error':{'code':7}}]
        for value in cases:
            self.reset_run();self.http_override={3:{'status':200,'body':json.dumps(value)}}
            r=self.run_entry();self.assertEqual(r['status'],'CONTAINMENT_UNCONFIRMED',value)
            self.assertEqual(r['counts']['https'],4);self.assertIn('SERVICE_ENABLE_OUTCOME_UNKNOWN',r['residuals'])
            self.assertTrue(r['privateInputsAbsent'])
    def test_operation_name_change_and_foreign_completed_service_refuse(self):
        self.pending=1
        for value in [{**self.value(4),'name':'operations/foreign'},
                      {'name':self.operation,'done':True,'response':{'service':{'name':'foreign','state':'ENABLED'}}}]:
            self.reset_run();self.http_override={4:{'status':200,'body':json.dumps(value)}}
            r=self.run_entry();self.assertEqual(r['counts']['https'],5);self.assertIn('SERVICE_ENABLE_OUTCOME_UNKNOWN',r['residuals'])
    def test_final_readback_required_and_no_rollback(self):
        for value in ({'name':f'projects/{self.number}/services/apikeys.googleapis.com','state':'DISABLED'},None,{}):
            self.reset_run();self.http_override={9:{'status':200,'body':json.dumps(value)}}
            r=self.run_entry();self.assertIn('SERVICE_ENABLE_OUTCOME_UNKNOWN',r['residuals'])
            self.assertEqual([x for x in self.io.calls if x==('https',3)],[('https',3)])
    def test_project_permissions_service_null_or_drift_stops_before_enable(self):
        cases=[(0,None),(0,{'projectId':'foreign'}),(1,{}),(1,{'permissions':None}),
               (1,{'permissions':a.SERVICE_PERMISSIONS*2}),(1,{'permissions':['foreign']}),
               (2,None),(2,{}),(2,{'name':'foreign','state':'DISABLED'})]
        for index,value in cases:
            self.reset_run();self.http_override={index:{'status':200,'body':json.dumps(value)}}
            r=self.run_entry();self.assertEqual(r['status'],'SERVICE_ENABLEMENT_STOPPED');self.assertEqual(r['residuals'],[])
            self.assertNotIn(('https',3),self.io.calls)
    def test_every_reserved_call_interruption_is_single_attempt_and_private_purged(self):
        self.pending=5
        for n in range(1,12):
            self.reset_run();self.break_at=n;r=self.run_entry()
            self.assertEqual(r['failure'],'INTERRUPTED');self.assertEqual(len(self.io.calls),n)
            self.assertEqual(len(set(self.io.calls)),n);self.assertTrue(r['privateInputsAbsent']);self.assertTrue(self.io.closed)
            self.assertEqual('SERVICE_ENABLE_OUTCOME_UNKNOWN' in r['residuals'],n>=5)
    def test_interrupted_wait_and_failed_poll_never_retry(self):
        self.pending=1;self.wait_failure=True;r=self.run_entry()
        self.assertEqual(r['failure'],'INTERRUPTED');self.assertEqual(r['counts']['https'],4)
        self.reset_run();self.wait_failure=False;self.http_override={4:{'status':503,'body':b'{}'}}
        r=self.run_entry();self.assertEqual(r['counts']['https'],5);self.assertIn('SERVICE_ENABLE_OUTCOME_UNKNOWN',r['residuals'])
    def test_cross_mode_local_native_and_source_authority_refusals_before_io(self):
        with self.assertRaisesRegex(a.Stop,'PLAN_SHAPE'):a.run(self.path,'read',self.factory)
        with self.assertRaisesRegex(a.Stop,'NATIVE_REQUIRES_EXTERNAL_AUTHORITY'):a.run(self.path,'enable')
        self.assertFalse((self.root/'attempt.json').exists());self.assertEqual(self.factory_calls,0)
        get=self.external();cap=a.ServiceCapability(self.p,self.root,read_commit=get)
        with self.assertRaisesRegex(a.Stop,'NATIVE_REQUIRES_EXTERNAL_AUTHORITY'):a.NativeIO(cap)
        with self.assertRaisesRegex(a.Stop,'COMMITTED_MANIFEST'):
            a.ServiceCapability(self.p,self.root,read_commit=lambda repo,c,p:get(repo,c,p) if repo==a.GOV else b'bad')
        with self.assertRaisesRegex(Exception,'COMMITTED_EVIDENCE_MISSING'):a.run(self.path,'enable')
    def test_exact_retention_budget_decision_and_version_refuse(self):
        original=copy.deepcopy(self.p)
        for key,value in [('version',2),('serviceRetention','DISABLE'),('contractSha256','0'*64),
                          ('limits',{**a.SERVICE_LIMITS,'mutations':2}),('ownerPrincipal','foreign')]:
            self.p=copy.deepcopy(original);self.p[key]=value;self.seal()
            with self.assertRaises(a.Stop):self.run_entry()
            self.assertEqual(self.factory_calls,0)
        self.p=original;self.seal();self.p['decision']['decision']='APPROVE_LOCAL_NARROW_ACCESS_PROOF'
        self.path.unlink();a.reserve(self.path,self.p)
        with self.assertRaisesRegex(a.Stop,'LOCAL_AUTHORITY'):self.run_entry()
        self.p=original;self.seal();get=self.external();self.p['decision']['path']='APP013_P08_ACCESS_READ_OPERATION_20261103.json'
        with self.assertRaisesRegex(a.Stop,'EXTERNAL_REFERENCE'):a.ServiceCapability(self.p,self.root,read_commit=get)
    def test_duplicate_concurrent_and_foreign_inventory_refuse(self):
        AccessTests.test_duplicate_and_concurrent_attempts_refuse(self)
        self.reset_run();AccessTests.test_foreign_symlink_hardlink_and_wrong_mode_refuse(self)
    def test_all_deadlines_clock_rollback_and_poll_wait_bound(self):
        for mode,key in [('enable','cutoff'),('closeout-enable','closeoutEnd')]:
            with self.assertRaisesRegex(a.Stop,'ENTRY_CUTOFF'):
                a.run(self.path,mode,self.factory,clock=lambda:a.utc(self.p['window'][key]))
        with self.assertRaisesRegex(a.Stop,'ENTRY_CUTOFF'):
            self.run_entry(clock=lambda:a.utc(self.p['window']['start'])-1)
        cap=a.ServiceCapability(self.p,self.root);cap.clock=lambda:cap.last-1
        with self.assertRaisesRegex(a.Stop,'CLOCK_ROLLBACK'):cap.gate()
        get=self.external();cap=a.ServiceCapability(self.p,self.root,read_commit=get);native=a.ServiceNativeIO(cap)
        with patch.object(time,'sleep') as sleep:
            native.wait_pending(cap.times['readEnd']);sleep.assert_called_once_with(2)
            with self.assertRaisesRegex(a.Stop,'DEADLINE'):native.wait_pending(time.time()+1)
        cap.clock=lambda:cap.times['readEnd']
        with self.assertRaisesRegex(a.Stop,'DEADLINE'):cap.gate()
        cap.clock=lambda:cap.times['closeoutEnd']
        with self.assertRaisesRegex(a.Stop,'DEADLINE'):cap.gate(True)
    def test_independent_closeout_preserves_pending_remote_and_calls_no_factory(self):
        self.break_at=5
        with patch.object(a.ServiceReader,'closeout',side_effect=SystemExit('parent exit')):
            with self.assertRaises(SystemExit):self.run_entry()
        self.assertTrue(self.io.closed)
        before=self.factory_calls
        r=a.run(self.path,'closeout-enable',self.factory,clock=lambda:a.utc(self.p['window']['cutoff'])+1)
        self.assertEqual(self.factory_calls,before);self.assertTrue(r['privateInputsAbsent'])
        self.assertIn('SERVICE_ENABLE_OUTCOME_UNKNOWN',r['residuals']);self.assertIn('PROCESS_OUTCOME_UNKNOWN',r['residuals'])
    def test_independent_closeout_recovers_completed_without_remote_replay(self):
        with patch.object(a.ServiceReader,'closeout',side_effect=SystemExit('parent exit')):
            with self.assertRaises(SystemExit):self.run_entry()
        r=a.run(self.path,'closeout-enable',self.factory)
        self.assertEqual(r['status'],'SERVICE_ENABLEMENT_OBSERVED');self.assertEqual(self.factory_calls,1)
    def test_forged_journal_refuses_and_missing_journal_does_not_invent_success(self):
        cap=a.ServiceCapability(self.p,self.root)
        a.reserve(self.root/'attempt.json',dict(operationId=self.p['operationId'],planSha256=cap.hash))
        with self.assertRaises(FileNotFoundError):a.run(self.path,'closeout-enable',self.factory)
        self.assertTrue(self.path.exists());self.assertEqual(self.factory_calls,0)
        (self.root/'independent-closeout.json').unlink()
        reader=a.ServiceReader(cap,None);reader.j['calls']=[['cache',0],['https',9]]
        a.reserve(self.root/'journal.json',reader.j)
        with self.assertRaisesRegex(a.Stop,'JOURNAL_SCOPE'):a.run(self.path,'closeout-enable',self.factory)
        self.assertTrue(self.path.exists())
    def test_retained_receipts_contain_no_private_payloads(self):
        self.pending=1;r=self.run_entry();self.assertTrue(r['privateInputsAbsent'])
        retained=''.join(p.read_text() for p in self.root.iterdir())
        for raw in [self.number,self.operation,a.OWNER,'SYNTHETIC_BEARER_NEVER_PERSIST','type.googleapis.com']:
            self.assertNotIn(raw,retained)
    def test_http_errors_output_bounds_and_secret_safe_failures(self):
        for raw in [{'status':403,'body':'{}'},{'status':302,'body':'{}'},{'status':True,'body':'{}'},
                    {'status':200,'body':b'\xff'},{'status':200,'body':b'x'*65537}]:
            self.reset_run();self.http_override={3:raw};r=self.run_entry()
            self.assertEqual(r['counts']['https'],4);self.assertIn('SERVICE_ENABLE_OUTCOME_UNKNOWN',r['residuals'])
        self.reset_run()
        with patch.object(ServiceFakeIO,'https',side_effect=RuntimeError('SECRET_MUST_NOT_EXPORT')):
            r=self.run_entry()
        self.assertEqual(r['failure'],'UNEXPECTED_LOCAL_FAILURE');self.assertNotIn('SECRET_MUST_NOT_EXPORT',json.dumps(r))
    def test_native_service_entry_actual_synthetic_cache_and_serialized_requests(self):
        get=self.external();self.pending=1;indices=[0,1,2,3,4,9];requests=[];responses=[]
        with tempfile.TemporaryDirectory(dir='/private/tmp',prefix='p08-service-synthetic-') as tmp:
            root=Path(tmp);make_cache(root,a.utc(self.p['window']['purgeEnd'])+1000)
            before={p.relative_to(root):p.read_bytes() for p in root.rglob('*') if p.is_file()}
            class Response:
                status=200
                def __init__(self,value):self.value=value;self.closed=False
                def read(self,n):return json.dumps(self.value).encode()
                def close(self):self.closed=True
            def open_request(req,timeout):
                index=indices[len(requests)];requests.append(req)
                if index==3:self.assertTrue(a.read(self.root/'journal.json')['enableAttempted'])
                r=Response(self.value(index));responses.append(r);return r
            original=a.read_cached_token
            with patch.object(a,'CONFIG_ROOT',root),patch.dict(os.environ,{},clear=True), \
                 patch.object(a,'read_cached_token',side_effect=original) as cache, \
                 patch.object(a.urllib.request,'build_opener') as opener,patch.object(time,'sleep') as sleep:
                opener.return_value.open.side_effect=open_request
                r=a.run(self.path,'enable',read_commit=get)
                self.assertEqual(cache.call_count,1);sleep.assert_called_once_with(2)
                for call in opener.call_args_list:
                    self.assertIsInstance(call.args[0],a.urllib.request.ProxyHandler)
                    self.assertEqual(call.args[0].proxies,{})
            self.assertEqual(r['status'],'SERVICE_ENABLEMENT_OBSERVED',r);self.assertTrue(all(x.closed for x in responses))
            self.assertEqual(before,{p.relative_to(root):p.read_bytes() for p in root.rglob('*') if p.is_file()})
            for index,req in zip(indices,requests):
                d=a.service_descriptor(index,self.number,self.operation)
                self.assertEqual(req.full_url,d['url']);self.assertEqual(req.method,d['method'])
                self.assertEqual(None if req.data is None else json.loads(req.data),d['body'])
                self.assertEqual(req.get_header('X-goog-user-project'),'signmons')
            self.assertIsNone(requests[3].data)
    def test_native_service_timeout_redirect_oversize_and_no_retry(self):
        get=self.external();cap=a.ServiceCapability(self.p,self.root,read_commit=get);native=a.ServiceNativeIO(cap)
        class Response:
            status=200;closed=False;raw=b'{}';slow=False
            def read(self,n):
                if self.slow:time.sleep(.1)
                return self.raw
            def close(self):self.closed=True
        for status,raw,slow,code in [(302,b'{}',False,'HTTP_REDIRECT'),(200,b'x'*65537,False,'HTTP_OUTPUT_SIZE'),(200,b'{}',True,'HTTP_TIMEOUT')]:
            response=Response();response.status=status;response.raw=raw;response.slow=slow
            with patch.object(a.urllib.request,'build_opener') as opener:
                opener.return_value.open.return_value=response
                with self.assertRaisesRegex(a.Stop,code):native.https(3,self.number,'SYNTHETIC_TOKEN',time.time()+.02)
                self.assertEqual(opener.return_value.open.call_count,1)
            self.assertTrue(response.closed)
        with patch.object(a.urllib.request,'build_opener') as opener:
            for name in ('https://evil.invalid','operations/x?x=y','operations/x%2Fy'):
                with self.assertRaisesRegex(a.Stop,'OPERATION_SCOPE'):native.https(4,self.number,'SYNTHETIC',cap.times['readEnd'],name)
            opener.assert_not_called()
    def test_cli_new_mode_refuses_local_before_cache_and_pre_marker(self):
        with patch.object(a,'PROJECT_HASH',self.original_project_hash):
            self.p['projectNumberSha256']=a.PROJECT_HASH;self.p['contractSha256']=a.service_contract_hash();self.seal()
        r=subprocess.run([sys.executable,'-B',str(a.HERE/'access_check.py'),'--enable',str(self.path)],capture_output=True,text=True,timeout=5)
        self.assertEqual(r.returncode,2);self.assertEqual(r.stderr,'');self.assertFalse((self.root/'attempt.json').exists())

    def test_actual_committed_reader_pending_approved_and_source_drift(self):
        # Disposable Git only; no fixture decision is written to real governance.
        with tempfile.TemporaryDirectory(dir='/private/tmp',prefix='p08-service-git-proof-') as tmp:
            repo=Path(tmp)
            def git(*args):
                r=subprocess.run(['/usr/bin/git','-C',str(repo),*args],capture_output=True,text=True,timeout=5)
                self.assertEqual(r.returncode,0,r.stderr);return r.stdout.strip()
            git('init','-q');git('config','user.name','Synthetic Proof');git('config','user.email','proof@example.invalid')
            rel=a.HERE.relative_to(a.BACKEND);(repo/rel).mkdir(parents=True)
            for name in ('source-manifest.json','access_check.py'):(repo/rel/name).write_bytes((a.HERE/name).read_bytes())
            git('add','.');git('commit','-qm','Synthetic source');self.p['sourceCommit']=git('rev-parse','HEAD')
            get_fixture=self.external();path=self.p['decision']['path']
            approved=json.loads(get_fixture(a.GOV,'',path));pending={**approved,'decision':'PENDING_OWNER_APPROVAL'}
            authority=a.sources()[3]
            actual=lambda original,commit,path:authority.committed(repo,commit,path)
            def commit_decision(value):
                raw=json.dumps(value).encode();(repo/path).write_bytes(raw)
                git('add',path);git('commit','-qm','Synthetic decision')
                self.p['decision'].update(commit=git('rev-parse','HEAD'),sha256=a.digest(raw))
            commit_decision(pending)
            with self.assertRaisesRegex(a.Stop,'EXACT_OWNER_APPROVAL'):a.ServiceCapability(self.p,self.root,read_commit=actual)
            commit_decision(approved)
            cap=a.ServiceCapability(self.p,self.root,read_commit=actual)
            self.assertTrue(cap.external);self.assertFalse((self.root/'attempt.json').exists())
            (repo/rel/'access_check.py').write_text('synthetic drift')
            git('add','.');git('commit','-qm','Synthetic drift');self.p['sourceCommit']=git('rev-parse','HEAD')
            # Rebind exact decision scope, so committed-source validation itself is exercised.
            approved['scopeSha256']=a.digest({k:v for k,v in self.p.items() if k!='decision'});commit_decision(approved)
            with self.assertRaisesRegex(a.Stop,'COMMITTED_SOURCE'):a.ServiceCapability(self.p,self.root,read_commit=actual)

    def test_close_failure_and_purge_failure_never_claim_containment(self):
        self.close_failure=True;r=self.run_entry()
        self.assertIn('PROCESS_CLOSE_UNCONFIRMED',r['residuals']);self.assertEqual(r['status'],'CONTAINMENT_UNCONFIRMED')
        self.reset_run();self.close_failure=False
        original=Path.unlink
        def cannot_purge(path,*args,**kwargs):
            if path==self.path:raise PermissionError('synthetic refusal')
            return original(path,*args,**kwargs)
        with patch.object(Path,'unlink',cannot_purge):r=self.run_entry()
        self.assertFalse(r['privateInputsAbsent']);self.assertIn('PRIVATE_PURGE_UNCONFIRMED',r['residuals'])
        self.assertTrue(self.path.exists())

    def test_purge_deadline_and_private_reference_clear_on_closeout_failure(self):
        cap=a.ServiceCapability(self.p,self.root);reader=a.ServiceReader(cap,ServiceFakeIO(self,cap))
        # Gate first succeeds; clock advances to the exact purge cutoff before unlink.
        original=reader.save
        def save_then_expire():
            original()
            if reader.j['phase']=='CLOSED':cap.clock=lambda:cap.times['purgeEnd']
        with patch.object(reader,'save',side_effect=save_then_expire):r=reader.closeout()
        self.assertFalse(r['privateInputsAbsent']);self.assertIn('PRIVATE_PURGE_UNCONFIRMED',r['residuals'])
        self.reset_run();captured=[];original_init=a.ServiceReader.__init__
        def capture(obj,*args):original_init(obj,*args);captured.append(obj)
        with patch.object(a.ServiceReader,'__init__',capture),patch.object(a.ServiceReader,'closeout',side_effect=SystemExit('crash')):
            with self.assertRaises(SystemExit):self.run_entry()
        self.assertEqual(captured[0].token,'');self.assertIsNone(captured[0].number);self.assertIsNone(captured[0].operation)

    def test_atomic_journal_interruption_retained_and_never_replayed(self):
        original=os.replace;failed=[False]
        def interrupted(source,dest):
            value=a.read(Path(source))
            if value.get('pending')==['https',3] and not failed[0]:
                failed[0]=True;raise a.Stop('INTERRUPTED')
            return original(source,dest)
        with patch.object(a.os,'replace',side_effect=interrupted):r=self.run_entry()
        self.assertEqual(r['failure'],'INTERRUPTED');self.assertNotIn(('https',3),self.io.calls)
        self.assertIn('JOURNAL_WRITE_INTERRUPTED',r['residuals']);self.assertIn('SERVICE_ENABLE_OUTCOME_UNKNOWN',r['residuals'])
        self.assertTrue(r['privateInputsAbsent']);self.assertFalse((self.root/'journal-next.json').exists())

    def test_persistent_journal_failure_leaves_private_cleanup_unconfirmed(self):
        original=os.replace
        def unavailable(source,dest):
            if a.read(Path(source)).get('pending')==['https',3]:raise a.Stop('INTERRUPTED')
            return original(source,dest)
        with patch.object(a.os,'replace',side_effect=unavailable):
            with self.assertRaisesRegex(a.Stop,'INTERRUPTED'):self.run_entry()
        self.assertTrue(self.path.exists());self.assertFalse((self.root/'result.json').exists())
        self.assertTrue(self.io.closed);self.assertNotIn(('https',3),self.io.calls)

    def test_expired_cache_and_read_deadline_stop_before_mutation(self):
        with patch.object(ServiceFakeIO,'cached_token',side_effect=a.Stop('CACHED_TOKEN_EXPIRED')):r=self.run_entry()
        self.assertEqual(r['counts'],dict(cache=1,https=0,cli=0));self.assertEqual(r['residuals'],[])
        self.reset_run();now=[a.utc(self.p['window']['start'])+1];original=ServiceFakeIO.https
        def expires_after_preflight(obj,*args,**kwargs):
            result=original(obj,*args,**kwargs)
            if args[0]==2:now[0]=a.utc(self.p['window']['readEnd'])
            return result
        with patch.object(ServiceFakeIO,'https',expires_after_preflight):r=self.run_entry(clock=lambda:now[0])
        self.assertEqual(r['failure'],'DEADLINE');self.assertEqual(r['counts']['https'],3)
        self.assertNotIn(('https',3),self.io.calls);self.assertTrue(r['privateInputsAbsent'])

class KeyFakeIO(FakeIO):
    def https(self,i,number,token,deadline):
        self.calls.append(('https',i))
        self.case.assertEqual(a.read(self.cap.root/'journal.json')['pending'],['https',i])
        if self.case.break_at==len(self.calls):raise a.Stop('INTERRUPTED')
        self.case.assertEqual(number,None if i==0 else self.case.number)
        self.case.assertEqual(token,'SYNTHETIC_BEARER_NEVER_PERSIST')
        return self.case.http_override.get(i,{'status':404 if i==2 else 200,'body':json.dumps(self.case.value(i)).encode()})

class KeyAbsenceTests(unittest.TestCase):
    def setUp(self):
        AccessTests.setUp(self)
        prospective=str(uuid.uuid4())
        self.p.update(version=4,limits=dict(a.KEY_LIMITS),contractSha256=a.key_contract_hash(),
                      prospectiveAuthenticationOperationId=prospective,prospectiveKeyId=a.prospective_key(prospective))
        self.seal()
        for method in ('connect','connect_ex'):
            p=patch.object(socket.socket,method,side_effect=AssertionError('NETWORK_FORBIDDEN'));p.start();self.addCleanup(p.stop)
    def seal(self):
        self.p['decision']={'decision':'APPROVE_LOCAL_KEY_ABSENCE_PROOF',
                           'scopeSha256':a.digest({k:v for k,v in self.p.items() if k!='decision'})}
        if self.path.exists():self.path.unlink()
        a.reserve(self.path,self.p)
    reset_run=AccessTests.reset_run
    def factory(self,cap):
        self.factory_calls+=1;self.io=KeyFakeIO(self,cap);return self.io
    def run_entry(self,**kwargs):return a.run(self.path,'key-absence',self.factory,**kwargs)
    def value(self,index):
        if index==0:return {'projectId':'signmons','projectNumber':self.number,'lifecycleState':'ACTIVE'}
        if index==1:return {'name':f'projects/{self.number}/services/apikeys.googleapis.com','state':self.service}
        return {'error':{'status':'NOT_FOUND','code':404,'message':'PRIVATE_PROVIDER_MESSAGE','details':['PRIVATE_DETAILS']}}
    def external(self):
        self.p['execution']='EXTERNAL'
        scope=a.digest({k:v for k,v in self.p.items() if k!='decision'})
        raw=json.dumps({'decision':'APPROVE_EXACT_P08_KEY_ABSENCE_READ','owner':'Debynyhan Banks',
          'operationId':self.p['operationId'],'scopeSha256':scope,'sourceManifestSha256':self.p['sourceManifestSha256'],
          'readOnly':True,'prospectiveAuthenticationOperationId':self.p['prospectiveAuthenticationOperationId'],
          'prospectiveKeyId':self.p['prospectiveKeyId']}).encode()
        self.p['decision']={'commit':'1'*40,'path':'APP013_P08_KEY_ABSENCE_OPERATION_20261103.json','sha256':a.digest(raw)}
        self.path.unlink();a.reserve(self.path,self.p)
        return lambda repo,commit,path:raw if repo==a.GOV else (a.BACKEND/path).read_bytes()
    def test_absence_exact_counts_and_sanitized_purged_receipts(self):
        r=self.run_entry();self.assertEqual(r['status'],'KEY_ABSENCE_OBSERVED')
        self.assertEqual(r['counts'],dict(cache=1,https=3,cli=0));self.assertTrue(r['privateInputsAbsent'])
        self.assertFalse(r['externalObservation']);self.assertFalse(r['executionReady'])
        for p in self.root.iterdir():
            for secret in ('SYNTHETIC_BEARER','PRIVATE_PROVIDER_MESSAGE','PRIVATE_DETAILS',self.number,self.p['prospectiveKeyId']):
                self.assertNotIn(secret,p.read_text())
    def test_not_found_requires_exact_status_and_optional_integer_code(self):
        for error,expected in [({'status':'NOT_FOUND'},True),({'status':'NOT_FOUND','code':404},True),
                              ({'status':'NOT_FOUND','code':True},False),({'status':'NOT_FOUND','code':'404'},False),
                              ({'status':'NOT_FOUND','code':404.0},False),({'status':'NOT_FOUND','code':None},False),
                              ({'status':'NOT_FOUND','code':403},False),({},False),({'status':None},False),
                              ({'status':'PERMISSION_DENIED'},False),(None,False),([],False)]:
            self.reset_run();self.http_override[2]={'status':404,'body':json.dumps({'error':error}).encode()}
            r=self.run_entry();self.assertEqual(r['status'],'KEY_ABSENCE_OBSERVED' if expected else 'KEY_RESPONSE_UNKNOWN',error)
    def test_present_including_deleted_key_never_available(self):
        name=a.key_descriptor(2,self.number,self.p['prospectiveAuthenticationOperationId'])['url'].split('/v2/')[1]
        for value,expected in [({'name':name},'KEY_PRESENT_STOP'),({'name':name,'deleteTime':'PRIVATE_METADATA'},'KEY_PRESENT_STOP'),
                               ({},'KEY_RESPONSE_UNKNOWN'),({'name':None},'KEY_RESPONSE_UNKNOWN'),
                               ({'name':name+'x'},'KEY_RESPONSE_UNKNOWN')]:
            self.reset_run();self.http_override[2]={'status':200,'body':json.dumps(value).encode()}
            self.assertEqual(self.run_entry()['status'],expected)
    def test_denial_and_other_status_never_absence_or_retry(self):
        for status in (401,403,429,500,503,204,True):
            self.reset_run();self.http_override[2]={'status':status,'body':json.dumps(self.value(2)).encode()}
            r=self.run_entry();self.assertEqual(r['status'],'KEY_ACCESS_DENIED' if status in (401,403) else 'KEY_RESPONSE_UNKNOWN')
            self.assertEqual(len(self.io.calls),4)
    def test_malformed_null_missing_oversize_and_encoding_unknown(self):
        for raw in (b'null',b'[]',b'{}',b'{',b'\xff',b'x'*65537,b'{"error":{"status":null}}'):
            self.reset_run();self.http_override[2]={'status':404,'body':raw}
            self.assertEqual(self.run_entry()['status'],'KEY_RESPONSE_UNKNOWN')
    def test_project_service_preconditions_stop_before_key(self):
        for index,value in [(0,{'projectId':'foreign'}),(1,{'name':'foreign','state':'ENABLED'}),
                            (1,{'name':f'projects/{self.number}/services/apikeys.googleapis.com','state':None})]:
            self.reset_run();self.http_override={index:{'status':200,'body':json.dumps(value).encode()}}
            self.assertEqual(self.run_entry()['status'],'KEY_ABSENCE_STOPPED');self.assertNotIn(('https',2),self.io.calls)
        self.reset_run();self.http_override={};self.service='DISABLED'
        r=self.run_entry();self.assertEqual(r['failure'],'SERVICE_DISABLED');self.assertEqual(r['counts']['https'],2)
    def test_uuid_target_scope_limits_version_and_manifest_refuse_before_io(self):
        original=json.loads(json.dumps(self.p))
        changes=[('prospectiveAuthenticationOperationId',None),('prospectiveAuthenticationOperationId','../../evil'),
                 ('prospectiveAuthenticationOperationId',self.p['operationId']),
                 ('prospectiveAuthenticationOperationId',self.p['prospectiveAuthenticationOperationId'].upper()),
                 ('prospectiveKeyId','other'),('version',3),('limits',{**a.KEY_LIMITS,'https':4}),
                 ('limits',{**a.KEY_LIMITS,'mutations':False}),('sourceManifestSha256','0'*64),('contractSha256','0'*64)]
        for key,value in changes:
            self.p=json.loads(json.dumps(original));self.p[key]=value;self.seal()
            with self.assertRaises(a.Stop):self.run_entry()
            self.assertEqual(self.factory_calls,0);self.assertFalse((self.root/'attempt.json').exists())
    def test_cross_mode_native_and_decision_source_refusals(self):
        with self.assertRaisesRegex(a.Stop,'NATIVE_REQUIRES_EXTERNAL_AUTHORITY'):a.run(self.path,'key-absence')
        for mode in ('read','enable'):
            with self.assertRaises(a.Stop):a.run(self.path,mode,self.factory)
        get=self.external();cap=a.KeyAbsenceCapability(self.p,self.root,read_commit=get)
        for native in (a.NativeIO,a.ServiceNativeIO):
            with self.assertRaisesRegex(a.Stop,'NATIVE_REQUIRES_EXTERNAL_AUTHORITY'):native(cap)
        for wrong in (b'{}',b'{"decision":"APPROVE_EXACT_P08_NARROW_ACCESS_READ"}'):
            with self.assertRaises(a.Stop):a.KeyAbsenceCapability(self.p,self.root,read_commit=lambda *args:wrong)
        with self.assertRaisesRegex(a.Stop,'COMMITTED_MANIFEST'):
            a.KeyAbsenceCapability(self.p,self.root,read_commit=lambda repo,*args:get(repo,*args) if repo==a.GOV else b'drift')
        self.assertFalse((self.root/'attempt.json').exists())
    def test_interrupt_each_reservation_never_retries(self):
        for ordinal in range(1,5):
            self.reset_run();self.break_at=ordinal;r=self.run_entry()
            self.assertEqual(r['failure'],'INTERRUPTED');self.assertEqual(len(self.io.calls),ordinal)
            self.assertTrue(r['privateInputsAbsent']);self.assertNotEqual(r['status'],'KEY_ABSENCE_OBSERVED')
    def test_cutoff_read_closeout_deadlines_and_clock_rollback(self):
        for mode,key in [('key-absence','cutoff'),('closeout-key-absence','closeoutEnd')]:
            with self.assertRaisesRegex(a.Stop,'ENTRY_CUTOFF'):a.run(self.path,mode,self.factory,clock=lambda:a.utc(self.p['window'][key]))
        with self.assertRaisesRegex(a.Stop,'ENTRY_CUTOFF'):self.run_entry(clock=lambda:a.utc(self.p['window']['start'])-1)
        cap=a.KeyAbsenceCapability(self.p,self.root);cap.clock=lambda:cap.last-1
        with self.assertRaisesRegex(a.Stop,'CLOCK_ROLLBACK'):cap.gate()
        for key,cleanup in [('readEnd',False),('closeoutEnd',True)]:
            cap.clock=lambda:cap.times[key]
            with self.assertRaisesRegex(a.Stop,'DEADLINE'):cap.gate(cleanup)
    def test_independent_pending_and_finished_cleanup_never_calls_io(self):
        for interrupted in (True,False):
            self.reset_run();self.break_at=4 if interrupted else None
            with patch.object(a.KeyAbsenceReader,'closeout',side_effect=SystemExit('exit')):
                with self.assertRaises(SystemExit):self.run_entry()
            r=a.run(self.path,'closeout-key-absence',self.factory,clock=lambda:a.utc(self.p['window']['cutoff'])+1)
            self.assertEqual(self.factory_calls,1);self.assertTrue(r['privateInputsAbsent'])
            self.assertEqual(r['status'],'CONTAINMENT_UNCONFIRMED' if interrupted else 'KEY_ABSENCE_OBSERVED')
    def test_native_entry_synthetic_cache_three_gets_and_no_proxy(self):
        get=self.external();requests=[];responses=[]
        with tempfile.TemporaryDirectory(dir='/private/tmp',prefix='p08-key-synthetic-') as tmp:
            root=Path(tmp);make_cache(root,a.utc(self.p['window']['purgeEnd'])+1000)
            before={p.relative_to(root):p.read_bytes() for p in root.rglob('*') if p.is_file()}
            class Response:
                def __init__(self,status,value):self.status=status;self.value=value;self.closed=False
                def read(self,n):return json.dumps(self.value).encode()
                def close(self):self.closed=True
            def open_request(req,timeout):
                index=len(requests);requests.append(req)
                self.assertEqual(a.read(self.root/'journal.json')['pending'],['https',index])
                r=Response(404 if index==2 else 200,self.value(index));responses.append(r);return r
            with patch.object(a,'CONFIG_ROOT',root),patch.dict(os.environ,{},clear=True),patch.object(a.urllib.request,'build_opener') as opener:
                opener.return_value.open.side_effect=open_request
                r=a.run(self.path,'key-absence',read_commit=get)
                for call in opener.call_args_list:
                    self.assertEqual(call.args[0].proxies,{});self.assertIs(call.args[1],a.NoRedirect)
            self.assertEqual(r['status'],'KEY_ABSENCE_OBSERVED');self.assertTrue(all(x.closed for x in responses))
            self.assertEqual(len(requests),3)
            self.assertEqual(before,{p.relative_to(root):p.read_bytes() for p in root.rglob('*') if p.is_file()})
            for index,req in enumerate(requests):
                self.assertEqual(req.full_url,a.key_descriptor(index,self.number,self.p['prospectiveAuthenticationOperationId'])['url'])
                self.assertEqual(req.method,'GET');self.assertIsNone(req.data)
                self.assertEqual(req.get_header('Authorization'),'Bearer SYNTHETIC_BEARER_NEVER_PERSIST')
                self.assertEqual(req.get_header('X-goog-user-project'),'signmons')
    def test_native_final_http_error_404_is_bounded_and_closed(self):
        get=self.external();cap=a.KeyAbsenceCapability(self.p,self.root,read_commit=get);native=a.KeyAbsenceNativeIO(cap)
        body=io.BytesIO(json.dumps(self.value(2)).encode())
        error=a.urllib.error.HTTPError('https://synthetic.invalid',404,'private',{},body)
        with patch.object(a.urllib.request,'build_opener') as opener:
            opener.return_value.open.side_effect=error
            raw=native.https(2,self.number,'SYNTHETIC',cap.times['readEnd'])
            reader=a.KeyAbsenceReader(cap,None);reader.number=self.number
            self.assertEqual(reader.key_state(raw),'KEY_ABSENCE_OBSERVED');self.assertEqual(opener.return_value.open.call_count,1)
        self.assertTrue(body.closed)

    def test_duplicate_concurrent_and_foreign_inventory_refuse(self):
        AccessTests.test_duplicate_and_concurrent_attempts_refuse(self)
        self.reset_run();AccessTests.test_foreign_symlink_hardlink_and_wrong_mode_refuse(self)

    def test_forged_journal_refuses_and_missing_journal_does_not_invent_success(self):
        cap=a.KeyAbsenceCapability(self.p,self.root)
        a.reserve(self.root/'attempt.json',dict(operationId=self.p['operationId'],planSha256=cap.hash))
        with self.assertRaises(FileNotFoundError):a.run(self.path,'closeout-key-absence',self.factory)
        self.assertTrue(self.path.exists());self.assertEqual(self.factory_calls,0)
        (self.root/'independent-closeout.json').unlink()
        reader=a.KeyAbsenceReader(cap,None);reader.j['calls']=[['cache',0],['https',9]]
        a.reserve(self.root/'journal.json',reader.j)
        with self.assertRaisesRegex(a.Stop,'JOURNAL_SCOPE'):a.run(self.path,'closeout-key-absence',self.factory)
        self.assertTrue(self.path.exists())

    def test_cli_new_mode_refuses_local_before_cache_and_pre_marker(self):
        with patch.object(a,'PROJECT_HASH',self.original_project_hash):
            self.p['projectNumberSha256']=a.PROJECT_HASH;self.p['contractSha256']=a.key_contract_hash();self.seal()
        r=subprocess.run([sys.executable,'-B',str(a.HERE/'access_check.py'),'--key-absence',str(self.path)],capture_output=True,text=True,timeout=5)
        self.assertEqual(r.returncode,2);self.assertEqual(r.stderr,'');self.assertFalse((self.root/'attempt.json').exists())


    def test_actual_committed_reader_pending_approved_and_source_drift(self):
        # Disposable Git only; no fixture decision is written to real governance.
        with tempfile.TemporaryDirectory(dir='/private/tmp',prefix='p08-service-git-proof-') as tmp:
            repo=Path(tmp)
            def git(*args):
                r=subprocess.run(['/usr/bin/git','-C',str(repo),*args],capture_output=True,text=True,timeout=5)
                self.assertEqual(r.returncode,0,r.stderr);return r.stdout.strip()
            git('init','-q');git('config','user.name','Synthetic Proof');git('config','user.email','proof@example.invalid')
            rel=a.HERE.relative_to(a.BACKEND);(repo/rel).mkdir(parents=True)
            for name in ('source-manifest.json','access_check.py'):(repo/rel/name).write_bytes((a.HERE/name).read_bytes())
            git('add','.');git('commit','-qm','Synthetic source');self.p['sourceCommit']=git('rev-parse','HEAD')
            get_fixture=self.external();path=self.p['decision']['path']
            approved=json.loads(get_fixture(a.GOV,'',path));pending={**approved,'decision':'PENDING_OWNER_APPROVAL'}
            authority=a.sources()[3]
            actual=lambda original,commit,path:authority.committed(repo,commit,path)
            def commit_decision(value):
                raw=json.dumps(value).encode();(repo/path).write_bytes(raw)
                git('add',path);git('commit','-qm','Synthetic decision')
                self.p['decision'].update(commit=git('rev-parse','HEAD'),sha256=a.digest(raw))
            commit_decision(pending)
            with self.assertRaisesRegex(a.Stop,'EXACT_OWNER_APPROVAL'):a.KeyAbsenceCapability(self.p,self.root,read_commit=actual)
            commit_decision(approved)
            cap=a.KeyAbsenceCapability(self.p,self.root,read_commit=actual)
            self.assertTrue(cap.external);self.assertFalse((self.root/'attempt.json').exists())
            (repo/rel/'access_check.py').write_text('synthetic drift')
            git('add','.');git('commit','-qm','Synthetic drift');self.p['sourceCommit']=git('rev-parse','HEAD')
            # Rebind exact decision scope, so committed-source validation itself is exercised.
            approved['scopeSha256']=a.digest({k:v for k,v in self.p.items() if k!='decision'});commit_decision(approved)
            with self.assertRaisesRegex(a.Stop,'COMMITTED_SOURCE'):a.KeyAbsenceCapability(self.p,self.root,read_commit=actual)


    def test_close_failure_and_purge_failure_never_claim_containment(self):
        self.close_failure=True;r=self.run_entry()
        self.assertIn('PROCESS_CLOSE_UNCONFIRMED',r['residuals']);self.assertEqual(r['status'],'CONTAINMENT_UNCONFIRMED')
        self.reset_run();self.close_failure=False
        original=Path.unlink
        def cannot_purge(path,*args,**kwargs):
            if path==self.path:raise PermissionError('synthetic refusal')
            return original(path,*args,**kwargs)
        with patch.object(Path,'unlink',cannot_purge):r=self.run_entry()
        self.assertFalse(r['privateInputsAbsent']);self.assertIn('PRIVATE_PURGE_UNCONFIRMED',r['residuals'])
        self.assertTrue(self.path.exists())


    def test_purge_deadline_and_private_reference_clear_on_closeout_failure(self):
        cap=a.KeyAbsenceCapability(self.p,self.root);reader=a.KeyAbsenceReader(cap,KeyFakeIO(self,cap))
        # Gate first succeeds; clock advances to the exact purge cutoff before unlink.
        original=reader.save
        def save_then_expire():
            original()
            if reader.j['phase']=='CLOSED':cap.clock=lambda:cap.times['purgeEnd']
        with patch.object(reader,'save',side_effect=save_then_expire):r=reader.closeout()
        self.assertFalse(r['privateInputsAbsent']);self.assertIn('PRIVATE_PURGE_UNCONFIRMED',r['residuals'])
        self.reset_run();captured=[];original_init=a.KeyAbsenceReader.__init__
        def capture(obj,*args):original_init(obj,*args);captured.append(obj)
        with patch.object(a.KeyAbsenceReader,'__init__',capture),patch.object(a.KeyAbsenceReader,'closeout',side_effect=SystemExit('crash')):
            with self.assertRaises(SystemExit):self.run_entry()
        self.assertEqual(captured[0].token,'');self.assertIsNone(captured[0].number)


    def test_persistent_journal_failure_leaves_private_cleanup_unconfirmed(self):
        original=os.replace
        def unavailable(source,dest):
            if a.read(Path(source)).get('pending')==['https',2]:raise a.Stop('INTERRUPTED')
            return original(source,dest)
        with patch.object(a.os,'replace',side_effect=unavailable):
            with self.assertRaisesRegex(a.Stop,'INTERRUPTED'):self.run_entry()
        self.assertTrue(self.path.exists());self.assertFalse((self.root/'result.json').exists())
        self.assertTrue(self.io.closed);self.assertNotIn(('https',2),self.io.calls)


    def test_native_timeout_redirect_oversize_and_request_ceiling(self):
        get=self.external();cap=a.KeyAbsenceCapability(self.p,self.root,read_commit=get);native=a.KeyAbsenceNativeIO(cap)
        class Response:
            status=200;closed=False;raw=b'{}';slow=False
            def read(self,n):
                if self.slow:time.sleep(.1)
                return self.raw
            def close(self):self.closed=True
        for status,raw,slow,code in [(302,b'{}',False,'HTTP_REDIRECT'),(404,b'x'*65537,False,'HTTP_OUTPUT_SIZE'),(404,b'{}',True,'HTTP_TIMEOUT')]:
            response=Response();response.status=status;response.raw=raw;response.slow=slow
            with patch.object(a.urllib.request,'build_opener') as opener:
                opener.return_value.open.return_value=response
                with self.assertRaisesRegex(a.Stop,code):native.https(2,self.number,'SYNTHETIC',time.time()+.02)
                self.assertEqual(opener.return_value.open.call_count,1)
            self.assertTrue(response.closed)
        with patch.object(a.urllib.request,'build_opener') as opener:
            for index in (-1,3,True):
                with self.assertRaisesRegex(a.Stop,'HTTP_SCOPE'):native.https(index,self.number,'SYNTHETIC',cap.times['readEnd'])
            opener.assert_not_called()
        reader=a.KeyAbsenceReader(cap,None);reader.j['calls']=list(a.KEY_CALLS)
        with self.assertRaisesRegex(a.Stop,'CALL_LIMIT'):reader.call('https',2)
    def test_atomic_journal_interruption_stops_before_transport(self):
        original=os.replace;failed=[False]
        def interrupted(source,dest):
            if a.read(Path(source)).get('pending')==['https',2] and not failed[0]:
                failed[0]=True;raise a.Stop('INTERRUPTED')
            return original(source,dest)
        with patch.object(a.os,'replace',side_effect=interrupted):r=self.run_entry()
        self.assertEqual(r['failure'],'INTERRUPTED');self.assertNotIn(('https',2),self.io.calls)
        self.assertIn('JOURNAL_WRITE_INTERRUPTED',r['residuals']);self.assertTrue(r['privateInputsAbsent'])
    def test_expired_cache_and_read_deadline_stop_before_key(self):
        with patch.object(KeyFakeIO,'cached_token',side_effect=a.Stop('CACHED_TOKEN_EXPIRED')):r=self.run_entry()
        self.assertEqual(r['counts'],dict(cache=1,https=0,cli=0));self.assertTrue(r['privateInputsAbsent'])
        self.reset_run();now=[a.utc(self.p['window']['start'])+1];original=KeyFakeIO.https
        def expires(obj,*args,**kwargs):
            result=original(obj,*args,**kwargs)
            if args[0]==1:now[0]=a.utc(self.p['window']['readEnd'])
            return result
        with patch.object(KeyFakeIO,'https',expires):r=self.run_entry(clock=lambda:now[0])
        self.assertEqual(r['failure'],'DEADLINE');self.assertNotIn(('https',2),self.io.calls)
        self.assertEqual(r['counts']['https'],2);self.assertTrue(r['privateInputsAbsent'])

class RetiredRoleTests(unittest.TestCase):
    def setUp(self):
        self.expected={'fixtureSha256':a.ROLE_FIXTURE_SHA,'database':'local_role_proof','user':'local_owner','acl':a.expected_retired_acl()}
        rows=copy.deepcopy(self.expected['acl'])
        for row in rows:
            if row['kind']=='database':row['object']=self.expected['database']
        self.value=dict(role=a.RETIRED_ROLE,database=self.expected['database'],user=self.expected['user'],count=1,
                        login=False,limit=0,expiryFinite=True,expired=True,unsafe=False,memberships=0,owned=0,
                        sessions=0,schemaCreate=False,databaseTemp=False,acl=rows)
        for method in ('connect','connect_ex'):
            p=patch.object(socket.socket,method,side_effect=AssertionError('NETWORK_FORBIDDEN'));p.start();self.addCleanup(p.stop)
    def classify(self):return a.classify_retired_role(self.value,self.expected['acl'])
    def test_exact_retained_role_has_local_hashes_only(self):
        result=self.classify();self.assertEqual(result['status'],'ROLE_CONTRACT_LOCAL_VERIFIED')
        self.assertFalse(result['liveObserved']);self.assertFalse(result['executionReady'])
        self.assertNotIn(self.expected['database'],json.dumps(result));self.assertNotIn('acl',result)
        self.assertEqual(len(result['roleAclSha256']),64)
    def test_absent_multiple_and_unsafe_role_refuse(self):
        for key,value in [('count',0),('count',2),('login',True),('limit',6),('expiryFinite',False),
                          ('expired',False),('unsafe',True),('memberships',1),('owned',1),('sessions',1),
                          ('schemaCreate',True),('databaseTemp',True)]:
            with self.subTest(key=key),patch.dict(self.value,{key:value}),self.assertRaisesRegex(a.Stop,'ROLE_NOT_READY'):self.classify()
    def test_missing_null_wrong_type_identity_and_extra_fields_refuse(self):
        original=copy.deepcopy(self.value)
        for key in original:
            self.value=copy.deepcopy(original);del self.value[key]
            with self.subTest(missing=key),self.assertRaises(a.Stop):self.classify()
            self.value=copy.deepcopy(original);self.value[key]=None
            with self.subTest(null=key),self.assertRaises(a.Stop):self.classify()
        for key,value in [('limit',False),('count',True),('owned',0.0),('expired',1),('role','foreign')]:
            self.value=copy.deepcopy(original);self.value[key]=value
            with self.subTest(key=key),self.assertRaises(a.Stop):self.classify()
        self.value=original;self.value['extra']=True
        with self.assertRaises(a.Stop):self.classify()
    def test_complete_acl_rejects_missing_extra_duplicate_grant_option_and_column_drift(self):
        original=copy.deepcopy(self.value['acl'])
        for change in ('missing','extra_column','extra_table','grant','duplicate','malformed','foreign_database','routine','default'):
            rows=copy.deepcopy(original)
            if change=='missing':rows.pop()
            elif change=='duplicate':rows.append(rows[0])
            elif change=='grant':rows[0]['is_grantable']=True
            elif change=='malformed':rows[0]['is_grantable']=0
            else:
                rows.append(dict(kind={'extra_column':'column','extra_table':'relation','foreign_database':'database'}.get(change,change),
                                 object='public.Job' if change.startswith('extra') else 'foreign',column='status' if change=='extra_column' else '',privilege_type='UPDATE',is_grantable=False))
            self.value['acl']=rows
            with self.subTest(change=change),self.assertRaises(a.Stop):self.classify()
    def test_expected_acl_cannot_be_rebased_to_observed(self):
        self.value['acl']=[]
        with self.assertRaisesRegex(a.Stop,'ROLE_EXPECTATION_DRIFT'):a.classify_retired_role(self.value,[])
        self.value['acl']=a.expected_retired_acl();self.value['acl'][0]['is_grantable']=True
        with self.assertRaisesRegex(a.Stop,'ROLE_EXPECTATION_DRIFT'):a.classify_retired_role(self.value,self.value['acl'])
    def test_readonly_query_has_columns_and_fixed_target_no_business_mutations(self):
        query=a.retired_role_query()
        for required in ('READ ONLY','pg_attribute','t.attacl','statement_timeout','lock_timeout',"rolname='p07_payment_runtime'",'ROLLBACK'):
            self.assertIn(required,query)
        for word in ('ALTER ROLE','CREATE ROLE','GRANT ','DROP ','pg_terminate_backend','PASSWORD'):self.assertNotIn(word,query)
    def test_injected_proof_executes_once_and_closes(self):
        case=self
        class IO:
            proof=True;calls=0;closed=False
            def sql(self,query,deadline):
                case.assertEqual(query,a.retired_role_query());self.calls+=1;return json.dumps(case.value).encode()
            def close(self,deadline):self.closed=True;return True
        io=IO();result=a.retired_role_evidence(io,self.expected,time.time()+5)
        self.assertEqual(io.calls,1);self.assertTrue(io.closed);self.assertEqual(result['status'],'ROLE_CONTRACT_LOCAL_VERIFIED')
        io=IO();io.proof=False
        with self.assertRaisesRegex(a.Stop,'ROLE_LOCAL_ONLY'):a.retired_role_evidence(io,self.expected,time.time()+5)
        self.assertEqual(io.calls,0)
    def test_deadline_clock_rollback_interruption_bad_output_and_cleanup_failure(self):
        case=self
        class IO:
            proof=True;calls=0;closed=False;raw=b'{}';failure=None;close_result=True
            def sql(self,query,deadline):
                self.calls+=1
                if self.failure:raise self.failure
                return self.raw
            def close(self,deadline):self.closed=True;return self.close_result
        for raw in (b'{}',b'null',b'\xff',b'x'*65537):
            io=IO();io.raw=raw
            with self.assertRaises(a.Stop):a.retired_role_evidence(io,self.expected,time.time()+5)
            self.assertEqual(io.calls,1);self.assertTrue(io.closed)
        for failure in (KeyboardInterrupt(),RuntimeError('PRIVATE_ERROR'),a.Stop('INTERRUPTED')):
            io=IO();io.failure=failure
            with self.assertRaises(a.Stop) as error:a.retired_role_evidence(io,self.expected,time.time()+5)
            self.assertNotIn('PRIVATE_ERROR',str(error.exception));self.assertEqual(io.calls,1);self.assertTrue(io.closed)
        io=IO()
        with self.assertRaisesRegex(a.Stop,'DEADLINE'):a.retired_role_evidence(io,self.expected,1,clock=lambda:1)
        self.assertEqual(io.calls,0);self.assertTrue(io.closed)
        io=IO();io.raw=json.dumps(self.value).encode();times=iter([2,1])
        with self.assertRaisesRegex(a.Stop,'DEADLINE'):a.retired_role_evidence(io,self.expected,5,clock=lambda:next(times))
        self.assertTrue(io.closed)
        io=IO();io.raw=json.dumps(self.value).encode();times=iter([1,2,6])
        with self.assertRaisesRegex(a.Stop,'DEADLINE'):a.retired_role_evidence(io,self.expected,5,clock=lambda:next(times))
        self.assertTrue(io.closed)
        io=IO();io.close_result=False
        with self.assertRaisesRegex(a.Stop,'ROLE_CLEANUP_UNCONFIRMED'):a.retired_role_evidence(io,self.expected,time.time()+5)
    def test_fixture_hash_and_expected_identity_refuse(self):
        class IO:
            proof=True;closed=False
            def sql(obj,query,deadline):return json.dumps(self.value).encode()
            def close(obj,deadline):obj.closed=True;return True
        bad={**self.expected,'fixtureSha256':'0'*64}
        with self.assertRaisesRegex(a.Stop,'ROLE_EXPECTATION_DRIFT'):a.retired_role_evidence(IO(),bad,time.time()+5)
        io=IO()
        with self.assertRaisesRegex(a.Stop,'ROLE_IDENTITY_UNKNOWN'):a.retired_role_evidence(io,{**self.expected,'user':'foreign'},time.time()+5)
        self.assertTrue(io.closed)

if __name__=='__main__':unittest.main()
