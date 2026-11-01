"""Actual boundClients TLS/preflight/session proof on an owned disposable cluster."""
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import time
import unittest

ROOT = Path(__file__).resolve().parent
HISTORICAL = ROOT.parent.parent / 'p08-authentication-local-20261026/source/test_auth_postgres.py'
spec = importlib.util.spec_from_file_location('p08_existing_auth_sql', HISTORICAL)
historical = importlib.util.module_from_spec(spec)
spec.loader.exec_module(historical)


class BoundPostgreSQL(historical.AuthPostgreSQL):
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        try:
            base = cls.data.parent
            cls.cert = base / 'server.crt'
            key = base / 'server.key'
            cls.command(args=['/opt/homebrew/bin/openssl', 'req', '-x509', '-newkey',
                              'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=localhost',
                              '-addext', 'subjectAltName=IP:127.0.0.1,DNS:localhost',
                              '-keyout', str(key), '-out', str(cls.cert)])
            os.chmod(key, 0o600)
            pg = historical.fixture.PG
            cls.command(args=[str(pg / 'pg_ctl'), '-D', str(cls.data), '-m', 'fast', 'stop'])
            cls.server.wait(timeout=10)
            cls.server = subprocess.Popen([
                str(pg / 'postgres'), '-D', str(cls.data), '-k', str(cls.socket),
                '-p', cls.port, '-F', '-c', 'listen_addresses=127.0.0.1',
                '-c', 'ssl=on', '-c', 'ssl_cert_file=' + str(cls.cert),
                '-c', 'ssl_key_file=' + str(key)], stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL, env=cls.env)
            for _ in range(100):
                try:
                    cls.command('SELECT 1')
                    break
                except AssertionError:
                    if cls.server.poll() is not None:
                        raise AssertionError('OWNED_TLS_SERVER_FAILED')
                    time.sleep(0.05)
            else:
                raise AssertionError('OWNED_TLS_READINESS_TIMEOUT')
        except BaseException:
            cls.tearDownClass()
            raise

    def setUp(self):
        super().setUp()
        # Synthetic row required by the existing coordinator capability scope.
        self.command('UPDATE "User" SET email=\'debynyhan@signmons.com\';')

    def check_scenario(self, scenario):
        payload = {'root': str(self.data.parent), 'cert': str(self.cert),
                   'port': int(self.port), 'scenario': scenario}
        result = subprocess.run([
            historical.fixture.c.NODE, str(ROOT / 'bound-postgres-fixture.mjs')],
            input=json.dumps(payload).encode(), capture_output=True,
            timeout=20, env=self.env, cwd=ROOT)
        self.assertEqual(result.returncode, 0, result.stderr.decode())
        summary = json.loads(result.stdout)
        self.assertEqual(summary['status'], 'PASS')
        self.assertEqual(summary['providerCalls'], 0)
        self.assertEqual(summary['sessionsRemaining'], 0)
        self.assertEqual(self.command("SELECT count(*) FROM pg_stat_activity WHERE application_name LIKE 'p08-auth-%'"), '0')

    def test_trusted_tls_actual_preflight_sql_and_session_close(self):
        self.check_scenario('positive')

    def test_cleartext_connection_refused_and_closed(self):
        self.check_scenario('cleartext')

    def test_untrusted_certificate_refused_and_closed(self):
        self.check_scenario('untrusted')

    def test_suspended_tenant_refused_and_closed(self):
        self.command('UPDATE "TenantOrganization" SET status=\'SUSPENDED\';')
        self.check_scenario('tenant')

    def test_real_residual_session_prevents_success(self):
        self.check_scenario('residual')


# The unchanged historical cases run separately; this class adds only the gap matrix.
for name in historical.AuthPostgreSQL.__dict__:
    if name.startswith('test_'):
        setattr(BoundPostgreSQL, name, None)

if __name__ == '__main__':
    unittest.main()
