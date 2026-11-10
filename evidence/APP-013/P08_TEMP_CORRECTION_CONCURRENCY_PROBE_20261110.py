import sys,subprocess,json,select,time
from pathlib import Path
src=Path('/Users/debynyhanbanks/Web Projects/signmons-backend-r08-recovery/evidence/APP-013/p08-https-output-category-local-20261029/source');sys.path.insert(0,str(src));import test_qualification_launch_postgres as t
C=t.fixture.PostgreSQLContract;C.setUpClass();child=None
try:
 C.command('CREATE ROLE p07_payment_runtime NOLOGIN NOINHERIT; CREATE ROLE p06_intake_runtime NOLOGIN; CREATE ROLE p06_migration_owner NOLOGIN; CREATE ROLE p06_migration_runner NOLOGIN; CREATE ROLE token_roles NOLOGIN; GRANT TEMP ON DATABASE neondb TO PUBLIC;')
 argv=[str(t.fixture.PG/'psql'),'-X','-q','-A','-t','-v','ON_ERROR_STOP=1','-h',str(C.socket),'-p',C.port,'-U','neondb_owner','-d','neondb']
 child=subprocess.Popen(argv,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,env=C.env,text=True,bufsize=1)
 def send(sql):child.stdin.write(sql+'\n');child.stdin.flush()
 def line():
  if not select.select([child.stdout],[],[],5)[0]:raise AssertionError('LOCAL_OUTPUT_TIMEOUT')
  return child.stdout.readline().strip()
 send("BEGIN ISOLATION LEVEL SERIALIZABLE; SELECT pg_advisory_xact_lock(13408); GRANT TEMP ON DATABASE neondb TO p06_intake_runtime,p06_migration_owner,p06_migration_runner,token_roles; REVOKE TEMP ON DATABASE neondb FROM PUBLIC RESTRICT; SELECT has_database_privilege('p07_payment_runtime','neondb','TEMP');")
 # lock returns one blank row followed by effective privilege.
 assert line()=='';assert line()=='f'
 other=subprocess.run(argv+['-c',"SET lock_timeout='1s'; SET statement_timeout='2s'; GRANT p06_intake_runtime TO p07_payment_runtime WITH INHERIT TRUE;"],env=C.env,capture_output=True,text=True,timeout=4)
 send('COMMIT;');child.stdin.close();child.wait(timeout=5)
 current=C.command("SELECT has_database_privilege('p07_payment_runtime','neondb','TEMP');")
 result={'isolation':'SERIALIZABLE','cooperativeAdvisoryLock':True,'preCommitTargetTemp':False,'concurrentMembershipCommit':other.returncode==0,'correctionCommit':child.returncode==0,'freshTargetTemp':current,'providerCalls':0}
 C.command('REVOKE p06_intake_runtime FROM p07_payment_runtime; REVOKE TEMP ON DATABASE neondb FROM p06_intake_runtime,p06_migration_owner,p06_migration_runner,token_roles; GRANT TEMP ON DATABASE neondb TO PUBLIC; CREATE ROLE ordinary_owner NOLOGIN; ALTER DATABASE neondb OWNER TO ordinary_owner;')
 before=C.command("SELECT datacl::text FROM pg_database WHERE datname='neondb'")
 delta='GRANT TEMP ON DATABASE neondb TO p06_intake_runtime,p06_migration_owner,p06_migration_runner,token_roles; REVOKE TEMP ON DATABASE neondb FROM PUBLIC RESTRICT;'
 C.command('BEGIN; SET LOCAL ROLE ordinary_owner; '+delta+' ROLLBACK;')
 result['ordinaryOwnerRollbackPreservesAcl']=before==C.command("SELECT datacl::text FROM pg_database WHERE datname='neondb'")
 C.command('BEGIN; SET LOCAL ROLE ordinary_owner; '+delta+' COMMIT;')
 result['ordinaryOwnerPositiveTargetDenied']=C.command("SELECT has_database_privilege('p07_payment_runtime','neondb','TEMP')")=='f'
 result['fourSelectedRetainTemp']=C.command("SELECT bool_and(has_database_privilege(rolname,'neondb','TEMP')) FROM pg_roles WHERE rolname IN ('p06_intake_runtime','p06_migration_owner','p06_migration_runner','token_roles')")=='t'
 assert all(result[k] for k in ['ordinaryOwnerRollbackPreservesAcl','ordinaryOwnerPositiveTargetDenied','fourSelectedRetainTemp'])
 print(json.dumps(result));Path('/private/tmp/p08-correction-concurrency-result.json').write_text(json.dumps(result,indent=2)+'\n')
finally:
 if child is not None and child.poll() is None:child.kill();child.wait(timeout=5)
 C.tearDownClass();print('OWNED_SERVER_REAPED_SCRATCH_ABSENT')
