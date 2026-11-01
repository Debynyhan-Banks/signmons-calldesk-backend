"""New transport factory/child tested on the existing owned TLS PostgreSQL fixture."""
import importlib.util
import json
from pathlib import Path
import subprocess
import unittest
import test_entry
from fixture_envelope import child_fixture
from authority import digest

ROOT=Path(__file__).resolve().parent
spec=importlib.util.spec_from_file_location('existing_bound_tls_fixture',ROOT.parent.parent/'p08-real-client-binding-local-20261031/source/test_bound_postgres.py')
prior=importlib.util.module_from_spec(spec);spec.loader.exec_module(prior)

class NativePostgres(prior.BoundPostgreSQL):
    def check_scenario(self,scenario):
        t=test_entry.EntryTests();t.setUp()
        try:
            t.e['database']={'host':'127.0.0.1','port':int(self.port),'database':'neondb','user':'neondb_owner'}
            t.e['qualification']['scopeSha256']=digest({k:t.e[k] for k in ('plan','target','database','resources','limits')})
            t.seal();request=child_fixture(t)
            r=subprocess.run([prior.historical.fixture.c.NODE,str(ROOT/'postgres_driver.mjs')],
                input=json.dumps({'request':request,'cert':str(self.cert),'scenario':scenario}).encode(),
                capture_output=True,timeout=25,env=self.env,cwd=ROOT)
            self.assertEqual(r.returncode,0,r.stderr.decode())
            self.assertEqual(json.loads(r.stdout),{'status':'PASS','providerCalls':0})
            self.assertEqual(self.command("SELECT count(*) FROM pg_stat_activity WHERE application_name LIKE 'p08-auth-%' OR application_name LIKE 'p08-runtime-%'"),'0')
        finally:t.doCleanups()

if __name__=='__main__':unittest.main()
