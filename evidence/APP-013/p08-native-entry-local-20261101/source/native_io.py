"""Bounded native primitives, available only to an exact external capability."""
import json
import os
import subprocess
import urllib.error
import urllib.request
from authority import load, HERE, APP, digest
from private_inventory import need


def load_acl():
    relative = 'p08-narrow-access-check-local-20261101/source/access_check.py'
    manifest = json.loads((HERE / 'source-manifest.json').read_text())
    path = APP / relative
    need(not path.is_symlink() and digest(path.read_bytes()) == manifest['lockedSources'].get(relative),
         'ACL_SOURCE_DRIFT')
    return load(relative, 'native_lifecycle_acl')


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


class NativeIO:
    proof = False

    def __init__(self, cap):
        need(cap.external, 'NATIVE_REQUIRES_EXTERNAL_AUTHORITY')
        self.cap, self.cleanup, self.token, self.password = cap, cap.mode != 'run', '', ''
        self.legacy = load('p08-restoration-local-20261028/source/legacy/controller.py', 'entry_legacy_io')
        self.restore = cap.modules['restore']
        need(cap.e['database'] == {'host': self.legacy.DB_HOST, 'port': 5432,
             'database': self.legacy.DB_NAME, 'user': self.legacy.DB_ADMIN}, 'NATIVE_DATABASE_PIN')
        self.allowed_sql = {self.restore.role_sql(True, cap.plan['window']['workEnd']),
                            self.restore.role_sql(False)}
        self.allowed_sql.add(load_acl().lifecycle_role_query())

    def env(self):
        env = {k: v for k, v in os.environ.items() if not k.startswith('PG') and
               k != 'DATABASE_URL' and not k.startswith('CLOUDSDK_AUTH_') and
               k != 'GOOGLE_APPLICATION_CREDENTIALS'}
        env.update({'CLOUDSDK_CORE_DISABLE_PROMPTS': 'true', 'CLOUDSDK_CORE_DISABLE_FILE_LOGGING': 'true',
                    'CLOUDSDK_CORE_LOG_HTTP': 'false'})
        return env

    def _run(self, argv, kind, input_bytes=None, extra=None):
        deadline = self.cap.spend(kind, self.cleanup)
        env = self.env(); env.update(extra or {})
        try:
            r = subprocess.run(argv, input=input_bytes, capture_output=True, env=env,
                               timeout=max(.01, min(8, deadline - self.cap.clock())))
        except subprocess.TimeoutExpired:
            raise __import__('private_inventory').Stop('DATABASE_PROCESS_TIMEOUT' if kind == 'sql' else 'NATIVE_COMMAND_UNCONFIRMED') from None
        except OSError:
            raise __import__('private_inventory').Stop('DATABASE_PROCESS_UNAVAILABLE' if kind == 'sql' else 'NATIVE_COMMAND_UNCONFIRMED') from None
        finally:
            if 'PGPASSWORD' in env: env['PGPASSWORD'] = ''
        try:
            self.cap.gate(self.cleanup)
            if kind == 'sql':
                if r.returncode != 0:
                    # Reuse the reviewed classifier; never expose raw PostgreSQL text.
                    if len(r.stderr) > 65536: code = 'DATABASE_ERROR_OUTPUT_LIMIT'
                    elif b'canceling statement due to statement timeout' in r.stderr.lower(): code = 'DATABASE_STATEMENT_TIMEOUT'
                    else: code = self.legacy.classify_database_error(r.stderr)
                    allowed = {'DATABASE_TLS_CONFIGURATION', 'DATABASE_AUTHENTICATION',
                               'DATABASE_CONNECTION', 'DATABASE_SCHEMA_OR_QUERY',
                               'DATABASE_ERROR_OUTPUT_LIMIT', 'DATABASE_STATEMENT_TIMEOUT'}
                    raise __import__('private_inventory').Stop(code if code in allowed else 'DATABASE_COMMAND_FAILED')
                need(len(r.stdout) <= 65536, 'DATABASE_OUTPUT_LIMIT')
            else: need(r.returncode == 0 and len(r.stdout) <= 65536, 'NATIVE_COMMAND_REFUSED')
            try: return r.stdout.decode('utf-8', 'strict').strip()
            except UnicodeError:
                raise __import__('private_inventory').Stop('DATABASE_OUTPUT_ENCODING' if kind == 'sql' else 'NATIVE_OUTPUT_ENCODING') from None
        finally:
            if kind == 'sql': r.stdout = b''; r.stderr = b''

    def ensure_owner(self):
        if self.token: return
        self.cap.gate(self.cleanup)
        self.restore.local_environment_gate()
        gc = '/opt/homebrew/bin/gcloud'
        owner = self._run([gc, 'auth', 'list', '--filter=status:ACTIVE', '--format=value(account)'], 'cli')
        need(owner == self.cap.plan['ownerPrincipal'], 'OWNER_DRIFT')
        for key in ('auth/impersonate_service_account', 'auth/credential_file_override', 'auth/access_token_file'):
            need(self._run([gc, 'config', 'get-value', key], 'cli') in ('', '(unset)'), 'OWNER_OVERRIDE')
        token = self._run([gc, 'auth', 'print-access-token', '--account=' + owner], 'cli')
        need(20 <= len(token) <= 4096 and not any(c.isspace() for c in token), 'TOKEN_SHAPE')
        self.token = token

    def credentials(self):
        self.ensure_owner()
        if not self.password:
            deadline = self.cap.gate(self.cleanup)
            with self.legacy.phase_guard(deadline, cleanup=self.cleanup):
                self.password = self.legacy.private_input('Enter current CHILD administrator password (hidden): ')
            need(isinstance(self.password, str) and 0 < len(self.password) <= 4096, 'PASSWORD_SHAPE')
        return {'password': self.password, 'accessToken': self.token}

    def cli(self, vector):
        self.ensure_owner()
        # Vectors are generated by the pinned Ports/NativeAdapter, never accepted from stdin.
        need(isinstance(vector, list) and vector and all(isinstance(v, str) and '\x00' not in v for v in vector),
             'CLI_VECTOR')
        return self._run(['/opt/homebrew/bin/gcloud', *vector], 'cli')

    def cloud(self, vector, deadline):
        # Match the original exact lifecycle vector before selecting serialization.
        plan = {**self.cap.plan, 'iam': self.cap.plan.get('iam', [])}
        mutations = {tuple(self.restore.command(plan, kind, name, enabled)): kind
                     for kind, name in self.restore.operations(plan) if kind != 'role'
                     for enabled in (True, False)}
        kind = mutations.get(tuple(vector))
        raw = self.cli([*vector, '--format=json'] if kind is not None else vector)
        if vector[:2] == ['auth', 'list']: return raw
        if raw == '' and kind in ('identity', 'version'): return {}
        try: value = json.loads(raw)
        except (ValueError, TypeError): raise __import__('private_inventory').Stop('NATIVE_OUTPUT_SHAPE') from None
        # Installed IAM enable/disable hooks return None, serialized as [] by JSON.
        # This acknowledges only the exact mutation; authoritative readback is unchanged.
        if kind == 'identity' and value == []: return {}
        if kind == 'tag' and isinstance(value, list):
            # update-traffic returns TrafficTargetPair[], not a Service resource.
            # Treat it only as acknowledgement; restore.traffic still verifies state.
            def percent(v):
                return isinstance(v, str) and (v == '-' or
                    (v.isascii() and v.isdecimal() and 0 <= int(v) <= 100))
            need(bool(value) and all(isinstance(row, dict) and
                 isinstance(row.get('revisionName'), str) and bool(row['revisionName']) and
                 type(row.get('latestRevision')) is bool and
                 percent(row.get('specPercent')) and percent(row.get('statusPercent')) and
                 isinstance(row.get('tags'), list) and all(isinstance(tag, dict) and
                     isinstance(tag.get('tag'), str) and bool(tag['tag']) and
                     type(tag.get('inSpec')) is bool and type(tag.get('inStatus')) is bool
                     for tag in row['tags']) and
                 isinstance(row.get('urls'), list) and all(isinstance(url, str) for url in row['urls'])
                 for row in value), 'NATIVE_OUTPUT_SHAPE')
            return {}
        if kind is not None: need(isinstance(value, dict), 'NATIVE_OUTPUT_SHAPE')
        return value

    def sql(self, query, deadline):
        need(query in self.allowed_sql, 'SQL_ALLOWLIST')
        secret = self.credentials()['password']; db = self.cap.e['database']
        return self._run([self.legacy.PSQL, '-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1',
                          '-h', db['host'], '-p', str(db['port']), '-U', db['user'], '-d', db['database']],
                         'sql', query.encode(), {'PGPASSWORD': secret, 'PGSSLMODE': 'verify-full',
                         'PGSSLROOTCERT': '/etc/ssl/cert.pem', 'PGCONNECT_TIMEOUT': '5',
                         'PGAPPNAME': 'p08-runtime-' + self.cap.plan['operationId'],
                         'PGOPTIONS': '-c statement_timeout=5000 -c lock_timeout=2000'})

    def https(self, descriptor):
        self.ensure_owner()
        need(set(descriptor) == {'method', 'url', 'body', 'timeoutSeconds', 'redirect'} and
             descriptor['redirect'] == 'error', 'HTTPS_DESCRIPTOR')
        url = urllib.parse.urlsplit(descriptor['url'])
        need(url.scheme == 'https' and url.hostname in {'apikeys.googleapis.com',
             'serviceusage.googleapis.com', 'policytroubleshooter.googleapis.com'} and
             not url.username and not url.password and not url.fragment and url.port in (None, 443), 'HTTPS_HOST')
        deadline = self.cap.spend('https', self.cleanup)
        body = descriptor['body']
        request = urllib.request.Request(descriptor['url'], method=descriptor['method'],
                  data=None if body is None else body.encode(), headers={'Authorization': 'Bearer ' + self.token,
                  'Content-Type': 'application/json', 'x-goog-user-project': self.cap.plan['project']})
        try:
            with urllib.request.build_opener(NoRedirect).open(request,
                    timeout=max(.01, min(8, deadline - self.cap.clock()))) as r:
                raw, status = r.read(65537), r.status
        except urllib.error.HTTPError as error:
            raw, status = error.read(65537), error.code
        except (OSError, TimeoutError):
            raise __import__('private_inventory').Stop('HTTPS_UNCONFIRMED') from None
        self.cap.gate(self.cleanup)
        need(len(raw) <= 65536 and not 300 <= status < 400, 'HTTPS_OUTPUT')
        return {'httpStatus': status, 'body': raw.decode('utf-8', 'strict')}

    def child(self, argv, **kwargs):
        return subprocess.run(argv, **kwargs)

    def clear(self):
        self.token = ''; self.password = ''


class PreflightIO(NativeIO):
    """Read-only transport firewall; no activation or resource-retirement cleanup."""
    def __init__(self, cap):
        need(cap.e.get('purpose') == 'NATIVE_PREFLIGHT_ONLY', 'PREFLIGHT_PURPOSE')
        super().__init__(cap)
        self.cleanup = cap.mode == 'close-preflight'
        import sys
        source = str(APP/'p08-https-output-category-local-20261029/source')
        sys.path.insert(0,source)
        try:self.q = load('p08-https-output-category-local-20261029/source/qualification_launch.py', 'preflight_process_owner')
        finally:sys.path.remove(source)
        self.processes = self.q.NativeIO(cap.clock, cap.plan['operationId'])
        self.read_sql = load_acl().lifecycle_role_query()
        self.close_sql = ("BEGIN TRANSACTION READ ONLY; SELECT json_build_object('sessionsAbsent',"
            "NOT EXISTS(SELECT 1 FROM pg_stat_activity WHERE application_name='p08-runtime-" +
            cap.plan['operationId'] + "' AND pid<>pg_backend_pid()))::text; ROLLBACK;")
        self.allowed_sql = {self.read_sql, self.close_sql}
        r = cap.e['resources']; project = '--project=' + cap.plan['project']
        vectors = [
            ['auth','list','--filter=status:ACTIVE','--format=value(account)'],
            *[['config','get-value',k] for k in ('auth/impersonate_service_account','auth/credential_file_override','auth/access_token_file')],
            ['auth','print-access-token','--account='+cap.plan['ownerPrincipal']],
            ['run','revisions','describe',r['candidate'],project,'--region=us-east5','--format=json(spec.serviceAccountName,spec.containers[].image,spec.containers[].env,status.conditions)'],
            ['iam','service-accounts','describe',r['identity'],project,'--format=json(email,disabled)'],
            ['run','services','describe','signmons-calldesk-staging',project,'--region=us-east5','--format=json(status.traffic)'],
            ['projects','describe',cap.plan['project'],'--format=json(projectId,projectNumber,lifecycleState)'],
            ['projects','get-iam-policy',cap.plan['project'],'--format=json'],
            ['iam','service-accounts','get-iam-policy',r['identity'],project,'--format=json'],
        ]
        vectors += [[*v[:-1], '--format=json(bindings,etag,version)'] for v in vectors
                    if 'get-iam-policy' in v]
        vectors += [['secrets','versions','describe',v,'--secret='+n,project,'--format=json(state)'] for n,v in r['secretVersions'].items()]
        vectors += [['secrets','get-iam-policy',n,project,'--format=json'] for n in self.restore.POLICIES]
        roles = cap.modules['bridge'].packet.module('roles').ROLES
        vectors += [['iam','roles','describe',role['id'],project,'--format=json(name,title,description,includedPermissions,stage,deleted,etag)'] for role in roles]
        self.read_vectors = frozenset(tuple(v) for v in vectors)
        self.credential_vectors = frozenset(tuple(v) for v in vectors[:5])
        self.service_url = 'https://serviceusage.googleapis.com/v1/projects/' + cap.plan['projectNumber'] + '/services/apikeys.googleapis.com'

    def _run(self, argv, kind, input_bytes=None, extra=None):
        # Validate before credentials, reservation or process creation, including direct calls.
        if kind == 'cli':
            need(argv[0] == '/opt/homebrew/bin/gcloud' and tuple(argv[1:]) in
                 (self.credential_vectors if self.cleanup else self.read_vectors) and
                 input_bytes is None and extra is None, 'PREFLIGHT_CLI_DENIED')
        elif kind == 'sql':
            db = self.cap.e['database']
            expected = [self.legacy.PSQL,'-X','-q','-A','-t','-v','ON_ERROR_STOP=1',
                        '-h',db['host'],'-p',str(db['port']),'-U',db['user'],'-d',db['database']]
            need(argv == expected and input_bytes in {self.close_sql.encode()} |
                 (set() if self.cleanup else {self.read_sql.encode()}), 'PREFLIGHT_SQL_DENIED')
            need(extra is not None and set(extra) == {'PGPASSWORD','PGSSLMODE','PGSSLROOTCERT','PGCONNECT_TIMEOUT','PGAPPNAME','PGOPTIONS'} and
                 extra['PGSSLMODE']=='verify-full' and extra['PGSSLROOTCERT']=='/etc/ssl/cert.pem' and
                 extra['PGCONNECT_TIMEOUT']=='5' and extra['PGAPPNAME']=='p08-runtime-'+self.cap.plan['operationId'] and
                 extra['PGOPTIONS']=='-c statement_timeout=5000 -c lock_timeout=2000', 'PREFLIGHT_SQL_ENV')
            argv = [*argv,'-c',input_bytes.decode()]
        else:
            need(False, 'PREFLIGHT_TRANSPORT_DENIED')
        deadline = self.cap.spend(kind, self.cleanup)
        env = self.env(); env.update(extra or {})
        journal = self.cap.coordinator
        journal.j['preflightProcessPending'] = True; journal.save()
        try:
            raw = self.processes._owned_run(argv, env, min(deadline, self.cap.clock()+10))
            self.cap.gate(self.cleanup)
            return raw.decode('utf-8','strict').strip()
        except Exception:
            raise __import__('private_inventory').Stop('PREFLIGHT_PROCESS_UNCONFIRMED') from None
        finally:
            env.pop('PGPASSWORD', None)
            if not self.processes.children:
                journal.j['preflightProcessPending'] = False; journal.save()

    def cli(self, vector):
        need(tuple(vector) in (self.credential_vectors if self.cleanup else self.read_vectors), 'PREFLIGHT_CLI_DENIED')
        return super().cli(vector)

    def sql(self, query, deadline):
        need(query == self.close_sql or (not self.cleanup and query == self.read_sql), 'PREFLIGHT_SQL_DENIED')
        return super().sql(query, deadline)

    def https(self, descriptor):
        need(not self.cleanup and isinstance(descriptor,dict) and set(descriptor)=={'method','url','body','timeoutSeconds','redirect'} and
             descriptor['method']=='GET' and descriptor['url']==self.service_url and descriptor['body'] is None and
             descriptor['redirect']=='error' and type(descriptor['timeoutSeconds']) in (int,float) and
             0 < descriptor['timeoutSeconds'] <= 10, 'PREFLIGHT_HTTPS_DENIED')
        return super().https(descriptor)

    def child(self, *args, **kwargs):
        need(False, 'PREFLIGHT_CHILD_DENIED')

    def close_processes(self, deadline):
        results = [self.processes._finish(p,deadline) for p in list(self.processes.children)]
        return all(results) and not self.processes.children and self.cap.clock()<deadline
