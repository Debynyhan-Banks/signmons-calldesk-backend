"""Bounded native primitives, available only to an exact external capability."""
import json
import os
import subprocess
import math
import selectors
import signal
import time
import urllib.error
import urllib.request
from authority import load, HERE, APP, digest
from private_inventory import need

AUTH_TAG_COMMAND_SECONDS = 30
AUTH_TAG_CLEANUP_SECONDS = AUTH_TAG_COMMAND_SECONDS + 8


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
        self.child_processes = set()
        self.child_cleanup_unconfirmed = False
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

    def auth_only(self):
        return getattr(self.cap, 'e', {}).get('purpose') == 'NATIVE_AUTH_QUALIFICATION_ONLY'

    def dispatch(self):
        if self.auth_only():
            need(not self.child_cleanup_unconfirmed and not self.child_processes, 'CHILD_PROCESS_CLOSEOUT_UNCONFIRMED')
            self.cap.gate(self.cleanup)
            self.cap.dispatch_serial += 1
            self.cap.coordinator.j['nativeEntry']['dispatchSerial'] = self.cap.dispatch_serial
            self.cap.coordinator.save()

    def _inventory(self):
        key = 'ownedChildren' if self.cap.mode == 'run' else 'independentChildren'
        return self.cap.coordinator.j['nativeEntry'].setdefault(key, [])

    def _reserve_process(self, kind):
        if not self.auth_only(): return None
        need(not self.child_cleanup_unconfirmed and not self.child_processes, 'CHILD_PROCESS_CLOSEOUT_UNCONFIRMED')
        rows = self._inventory()
        need(len(rows) < sum(self.cap.e['limits'][k] for k in ('cli', 'sql', 'child')), 'CHILD_INVENTORY_LIMIT')
        row = {'ordinal':len(rows)+1, 'kind':kind.upper(), 'pid':None, 'pgid':None, 'state':'RESERVED'}
        rows.append(row); self.cap.coordinator.save()
        return row

    def closure(self):
        """Only the handles created by this process may be reaped or acknowledged."""
        for process in list(self.child_processes):
            if hasattr(process, '_p08_finish_end'): del process._p08_finish_end
            if not self._finish_child(process): self.child_cleanup_unconfirmed = True
        rows = self._inventory()
        complete = not self.child_processes and all(
            row['state'] in ('CLOSED', 'NOT_STARTED') for row in rows)
        return complete, json.loads(json.dumps(rows))

    def _run(self, argv, kind, input_bytes=None, extra=None):
        deadline = self.cap.spend(kind, self.cleanup)
        env = self.env(); env.update(extra or {})
        forward_tag = (kind == 'cli' and self.cleanup is False and type(argv) is list and
                       argv[:4] == ['/opt/homebrew/bin/gcloud', 'run', 'services', 'update-traffic'] and
                       argv == ['/opt/homebrew/bin/gcloud', *self.restore.command(
                           {**self.cap.plan, 'iam': self.cap.plan.get('iam', [])},
                           'tag', self.restore.TAG, True), '--format=json'])
        auth_tag = self.auth_only() and (forward_tag or (
            kind == 'cli' and self.cleanup is True and type(argv) is list and
            argv[:4] == ['/opt/homebrew/bin/gcloud', 'run', 'services', 'update-traffic'] and
            argv == ['/opt/homebrew/bin/gcloud', *self.restore.command(
                {**self.cap.plan, 'iam': self.cap.plan.get('iam', [])},
                'tag', self.restore.TAG, False), '--format=json']))
        try:
            if self.auth_only():
                r = self._owned_process(argv, input_bytes or b'', env,
                    min(AUTH_TAG_COMMAND_SECONDS if auth_tag else 8, deadline - self.cap.clock()),
                    self.cleanup, 65536, kind, total=True,
                    output_codes=({'stdout':'DATABASE_OUTPUT_LIMIT','stderr':'DATABASE_ERROR_OUTPUT_LIMIT'}
                        if kind == 'sql' else {'stdout':'RUNTIME_TAG_OUTPUT_LIMIT' if forward_tag else 'NATIVE_COMMAND_REFUSED',
                                              'stderr':'NATIVE_COMMAND_REFUSED'}))
            else:
                r = subprocess.run(argv, input=input_bytes, capture_output=True, env=env,
                                   timeout=max(.01, min(8, deadline - self.cap.clock())))
        except subprocess.TimeoutExpired:
            raise __import__('private_inventory').Stop('DATABASE_PROCESS_TIMEOUT' if kind == 'sql' else
                'RUNTIME_TAG_COMMAND_TIMEOUT' if forward_tag else 'NATIVE_COMMAND_UNCONFIRMED') from None
        except OSError:
            raise __import__('private_inventory').Stop('DATABASE_PROCESS_UNAVAILABLE' if kind == 'sql' else
                'RUNTIME_TAG_COMMAND_UNAVAILABLE' if forward_tag else 'NATIVE_COMMAND_UNCONFIRMED') from None
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
            elif forward_tag:
                need(r.returncode == 0, 'RUNTIME_TAG_COMMAND_REFUSED')
                need(len(r.stdout) <= 65536, 'RUNTIME_TAG_OUTPUT_LIMIT')
            else: need(r.returncode == 0 and len(r.stdout) <= 65536, 'NATIVE_COMMAND_REFUSED')
            try: return r.stdout.decode('utf-8', 'strict').strip()
            except UnicodeError:
                raise __import__('private_inventory').Stop('DATABASE_OUTPUT_ENCODING' if kind == 'sql' else
                    'RUNTIME_TAG_OUTPUT_ENCODING' if forward_tag else 'NATIVE_OUTPUT_ENCODING') from None
        finally:
            if kind == 'sql' or forward_tag: r.stdout = b''; r.stderr = b''

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
        if self.auth_only() and not self.password:
            need(signal.getitimer(signal.ITIMER_REAL) == (0.0, 0.0), 'INPUT_TIMER_COLLISION')
        self.ensure_owner()
        if not self.password:
            deadline = self.cap.gate(self.cleanup)
            if self.auth_only(): deadline = min(deadline, self.cap.clock() + 120)
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
        forward_tag = (kind == 'tag' and self.cleanup is False and
                       vector == self.restore.command(plan, 'tag', self.restore.TAG, True))
        raw = self.cli([*vector, '--format=json'] if kind is not None else vector)
        if vector[:2] == ['auth', 'list']: return raw
        if raw == '' and kind in ('identity', 'version'): return {}
        try: value = json.loads(raw)
        except (ValueError, TypeError):
            raise __import__('private_inventory').Stop(
                'RUNTIME_TAG_JSON_PARSE' if forward_tag else 'NATIVE_OUTPUT_SHAPE') from None
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
                 for row in value), 'RUNTIME_TAG_ACK_SHAPE' if forward_tag else 'NATIVE_OUTPUT_SHAPE')
            return {}
        if kind is not None:
            need(isinstance(value, dict), 'RUNTIME_TAG_ACK_SHAPE' if forward_tag else 'NATIVE_OUTPUT_SHAPE')
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
        # Refuse a borrowed alarm before even an owner/credential operation.
        # The source-pinned context below restores the prior handler on every exit.
        need(signal.getitimer(signal.ITIMER_REAL) == (0.0, 0.0), 'HTTPS_UNCONFIRMED')
        acl = load_acl()
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
        response = None
        failure = None
        result = None
        try:
            remaining = min(8, deadline - self.cap.clock())
            need(remaining > 0, 'HTTPS_UNCONFIRMED')
            # A socket inactivity timeout alone does not bound a dripping body.
            # Keep open, body consumption, validation and normal close in one timer.
            with acl.http_deadline(remaining):
                try:
                    self.dispatch()
                    response = urllib.request.build_opener(NoRedirect).open(request, timeout=remaining)
                    status = response.status
                except urllib.error.HTTPError as error:
                    response, status = error, error.code
                raw = response.read(65537)
                self.cap.gate(self.cleanup)
                need(len(raw) <= 65536 and not 300 <= status < 400, 'HTTPS_OUTPUT')
                result = {'httpStatus': status, 'body': raw.decode('utf-8', 'strict')}
                try:
                    response.close()
                except (KeyboardInterrupt, SystemExit):
                    raise
                except BaseException:
                    raise __import__('private_inventory').Stop('HTTPS_RESPONSE_CLOSE_UNCONFIRMED') from None
                response = None
                self.cap.gate(self.cleanup)
        except BaseException as error:
            if isinstance(error, (OSError, TimeoutError)) or (
                    type(error) is acl.Stop and str(error) in ('HTTP_TIMEOUT', 'HTTP_TIMER_CONFLICT')):
                failure = __import__('private_inventory').Stop('HTTPS_UNCONFIRMED')
            else:
                failure = error
        finally:
            if response is not None:
                # This is local response disposal, never another provider request.
                # Its separate one-second ceiling also stays inside the phase.
                try:
                    remaining = min(1, deadline - self.cap.clock())
                    need(remaining > 0, 'HTTPS_RESPONSE_CLOSE_UNCONFIRMED')
                    with acl.http_deadline(remaining):
                        response.close()
                except BaseException as error:
                    if failure is None:
                        failure = error if isinstance(error, (KeyboardInterrupt, SystemExit)) else \
                            __import__('private_inventory').Stop('HTTPS_RESPONSE_CLOSE_UNCONFIRMED')
        if failure is not None:
            raise failure from None
        return result

    def _child_group_alive(self, process, until):
        # Only directly owned, start_new_session process groups are inspected/signalled.
        need(process in self.child_processes, 'CHILD_PROCESS_OWNERSHIP')
        while True:
            process.poll()
            try:
                os.killpg(process.pid, 0)
                return True
            except ProcessLookupError:
                return False
            except PermissionError:
                if time.monotonic() >= until:
                    raise __import__('private_inventory').Stop('CHILD_PROCESS_OWNERSHIP_UNKNOWN') from None
                time.sleep(min(.01, max(0, until - time.monotonic())))

    def _finish_child(self, process):
        if process not in self.child_processes:
            return False
        until = time.monotonic() + min(2, max(0, self.cap.times['cleanupEnd'] - self.cap.clock()))
        until = min(until, getattr(process, '_p08_finish_end', until))
        try:
            if self._child_group_alive(process, until):
                os.killpg(process.pid, signal.SIGTERM)
                term_end = min(until, time.monotonic() + .2)
                while time.monotonic() < term_end and self._child_group_alive(process, until):
                    time.sleep(.01)
                if self._child_group_alive(process, until):
                    os.killpg(process.pid, signal.SIGKILL)
            process.wait(timeout=max(.001, until - time.monotonic()))
            while time.monotonic() < until and self._child_group_alive(process, until):
                time.sleep(.01)
            absent = not self._child_group_alive(process, until)
            if absent:
                self.child_processes.remove(process)
                row = getattr(process, '_p08_inventory', None)
                if row is not None:
                    row['state'] = 'CLOSED'
                    # The Node child owns auth/payment journal fields until
                    # Handoff merges them. Do not overwrite its final write.
                    if row['kind'] != 'CHILD': self.cap.coordinator.save()
            return absent and process.returncode is not None and self.cap.clock() < self.cap.times['cleanupEnd']
        except (OSError, subprocess.TimeoutExpired, __import__('private_inventory').Stop):
            return False
        finally:
            for stream in (process.stdin, process.stdout, process.stderr):
                if stream is not None:
                    stream.close()

    def child(self, argv, **kwargs):
        # Handoff owns the request budget and exact argv; this boundary owns descendants.
        need(set(kwargs) == {'input', 'text', 'capture_output', 'timeout', 'env'} and
             kwargs['text'] is True and kwargs['capture_output'] is True and
             isinstance(kwargs['input'], str), 'CHILD_PROTOCOL')
        need(isinstance(argv, list) and bool(argv) and
             all(isinstance(arg, str) and '\x00' not in arg for arg in argv), 'CHILD_ARGV')
        timeout = kwargs['timeout']
        need(type(timeout) in (int, float) and math.isfinite(timeout) and timeout > 0, 'CHILD_TIMEOUT_BOUND')
        data = kwargs['input'].encode('utf-8')
        need(0 < len(data) <= 131072, 'CHILD_INPUT_BOUNDS')
        self.child_parent_baseline = None
        result = self._owned_process(argv, data, kwargs['env'], timeout,
            self.cleanup or argv[-1] in ('--closeout', '--readback'), 8192, 'child')
        return subprocess.CompletedProcess(argv, result.returncode,
            result.stdout.decode('utf-8', 'strict'), result.stderr.decode('utf-8', 'strict'))

    def _owned_process(self, argv, data, env, timeout, cleanup, output_limit, kind, total=False, output_codes=None):
        need(math.isfinite(timeout) and timeout > 0, 'CHILD_PROCESS_DEADLINE')
        # Reserve the existing independent-cleanup horizon; never extend work or cleanup.
        remaining = self.cap.times['cleanupEnd'] - self.cap.clock() - 2
        need(remaining > 0, 'CHILD_PROCESS_DEADLINE')
        end = time.monotonic() + min(timeout, remaining)
        hard_end = end - min(2, timeout / 2) if total else end
        self.cap.gate(cleanup)
        process = None
        selector = None
        chunks = {'stdout': [], 'stderr': []}
        sizes = {'stdout': 0, 'stderr': 0}
        offset = 0
        failure = None
        last = self.cap.clock()
        row = self._reserve_process(kind)
        try:
            try:
                need(time.monotonic() < hard_end, 'CHILD_PROCESS_DEADLINE')
                self.dispatch()
                need(time.monotonic() < hard_end, 'CHILD_PROCESS_DEADLINE')
            except BaseException:
                if row is not None:
                    row['state'] = 'NOT_STARTED'; self.cap.coordinator.save()
                raise
            process = subprocess.Popen(argv, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                stderr=subprocess.PIPE, env=env, start_new_session=True)
            self.child_processes.add(process)
            if total: process._p08_finish_end = end
            if row is not None:
                process._p08_inventory = row
                row.update(pid=process.pid, pgid=process.pid, state='SPAWNED'); self.cap.coordinator.save()
                if kind == 'child':
                    # No request byte has reached the child yet. Capture the
                    # exact parent-owned transition before releasing stdin.
                    self.child_parent_baseline = (self.cap.coordinator.j['nativeEntry']['calls']['child'],
                        json.loads(json.dumps(self.cap.coordinator.j)))
            selector = selectors.DefaultSelector()
            for stream, event, name in ((process.stdin, selectors.EVENT_WRITE, 'stdin'),
                    (process.stdout, selectors.EVENT_READ, 'stdout'),
                    (process.stderr, selectors.EVENT_READ, 'stderr')):
                os.set_blocking(stream.fileno(), False)
                selector.register(stream, event, name)
            while selector.get_map() or process.poll() is None:
                now = self.cap.clock()
                need(now >= last, 'CLOCK_ROLLBACK')
                last = now
                if time.monotonic() >= hard_end or now >= self.cap.times['cleanupEnd'] - 2:
                    raise subprocess.TimeoutExpired(argv, timeout)
                self.cap.gate(cleanup)
                for key, _ in selector.select(min(.05, max(.001, hard_end - time.monotonic()))):
                    stream, name = key.fileobj, key.data
                    if name == 'stdin':
                        try: offset += os.write(stream.fileno(), data[offset:offset + 8192])
                        except BrokenPipeError: offset = len(data)
                        if offset == len(data):
                            selector.unregister(stream)
                            stream.close()
                            data = b''
                    else:
                        chunk = os.read(stream.fileno(), min(8192, output_limit + 1 - sizes[name]))
                        if not chunk:
                            selector.unregister(stream)
                        else:
                            sizes[name] += len(chunk)
                            need(sizes[name] <= output_limit, (output_codes or {}).get(name, 'CHILD_OUTPUT_LIMIT'))
                            chunks[name].append(chunk)
            code = process.wait(timeout=max(.001, hard_end - time.monotonic()))
        except BaseException as error:
            failure = error
        finally:
            data = b''
            if process is None and row is not None and row['state'] == 'RESERVED':
                self.child_cleanup_unconfirmed = True
            try:
                if selector is not None: selector.close()
            finally:
                if process is not None:
                    try: closed = self._finish_child(process)
                    except BaseException: closed = False
                    if not closed:
                        self.child_cleanup_unconfirmed = True
                        failure = __import__('private_inventory').Stop('CHILD_PROCESS_CLOSEOUT_UNCONFIRMED')
        if failure is not None:
            for value in chunks.values(): value.clear()
            raise failure
        return subprocess.CompletedProcess(argv, code, b''.join(chunks['stdout']), b''.join(chunks['stderr']))

    def clear(self):
        self.token = ''; self.password = ''
        self.child_parent_baseline = None


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
