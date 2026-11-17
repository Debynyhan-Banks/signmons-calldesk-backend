"""CT2 narrow read composition. External entry requires separate committed authority."""
import json
import os
from pathlib import Path
import signal
import sys
import time
from types import SimpleNamespace
import account_containment as c

k = c.source
q, m, a, p = k.q, k.m, k.a, k.p
need = m.need
HERE = Path(__file__).resolve().parent
MANIFEST = HERE / 'account-containment-read-source-manifest.json'
ACTION = 'READ_CURRENT_ACCOUNT_CONTAINMENT_ONCE'
EXCEPTION = 'SDK_OWNER_REFRESH_RETRY_CACHE_EXPLICIT_TOKEN_MEMORY_ONLY'
LIMITS = {'cli': 3, 'accountSql': 1, 'firebase': 1, 'closeoutSql': 1}


def commands():
    return [next(d for d in q.current_cli_contract() if d['id'] == name)
            for name in ('owner', 'project', 'token')]


class Transport(q.NativeIO):
    """Reuse actual SQL process path; retain raw bytes before its legacy decoder."""
    def __init__(self, clock, operation):
        super().__init__(clock, operation)
        self._sql_raw = None
        self._capture_sql = False

    def _owned_run(self, argv, env, deadline, **kwargs):
        # Same SDK sanitization as the existing qualification capability.
        clean = q.sdk_environment(os.environ)
        if self._capture_sql:
            clean = {key: value for key, value in clean.items() if not key.startswith('CLOUDSDK_')}
            clean.update({key: value for key, value in env.items() if key.startswith('PG')})
        try:
            raw = super()._owned_run(argv, clean, deadline, **kwargs)
            if self._capture_sql:
                c.parse(raw)  # Reject duplicates before legacy parsing can lose them.
                self._sql_raw = raw
            return raw
        finally:
            clean.clear()

    def sql(self, descriptor, password, deadline):
        need(descriptor in q.sql_contract() and not self._capture_sql, 'CT2_SQL_SCOPE')
        self._capture_sql = True
        self._sql_raw = None
        try:
            super().sql(descriptor, password, deadline)
            need(type(self._sql_raw) is bytes, 'CT2_SQL_RAW')
            return self._sql_raw
        finally:
            self._capture_sql = False
            self._sql_raw = None


def guard(scope):
    need(m.digest(MANIFEST.read_bytes()) == scope['manifestSha256'], 'CT2_SOURCE')
    manifest = q.strict_json(MANIFEST.read_bytes())
    for name, digest in manifest['files'].items():
        path = p.B / name
        need(not Path(name).is_absolute() and '..' not in Path(name).parts and not path.is_symlink(), 'CT2_SOURCE')
        need(m.digest(path.read_bytes()) == digest and
             m.digest(a.committed(p.B, scope['sourceCommit'], name)) == digest, 'CT2_SOURCE')
    need(a.committed(p.B, scope['sourceCommit'], str(MANIFEST.relative_to(p.B))) == MANIFEST.read_bytes(), 'CT2_SOURCE')
    # Reuse original source/SDK guards without modifying any old manifest.
    k.source_guard({'sourceCommit': scope['sourceCommit'],
                    'manifestSha256': m.digest(k.MANIFEST.read_bytes())})


def authorize(envelope, now, read=a.committed, source_guard=guard):
    need(type(envelope) is dict and set(envelope) == {'scope', 'decision'}, 'CT2_AUTHORITY')
    s, ref = envelope['scope'], envelope['decision']
    need(set(s) == {'action','operationId','sourceCommit','manifestSha256','configSha256',
                    'window','limits','sdkException','commands'}, 'CT2_SCOPE')
    m.exact_uuid(s['operationId'], 'CT2_OPERATION')
    need(s['action'] == ACTION and s['limits'] == LIMITS and all(type(v) is int for v in s['limits'].values()) and s['sdkException'] == EXCEPTION and
         m.digest(s['commands']) == m.digest(commands()), 'CT2_SCOPE')
    t = {name: m.timestamp(value) for name, value in s['window'].items()}
    need(set(t) == {'start','cutoff','readEnd','cleanupEnd','purgeEnd'} and
         t['start'] <= now < t['cutoff'] < t['readEnd'] < t['cleanupEnd'] < t['purgeEnd'], 'CT2_WINDOW')
    need(type(ref) is dict and set(ref) == {'commit','path','sha256'} and
         k.re.fullmatch(r'APP013_P08_CT2_EXTERNAL_[0-9]{8}_[a-f0-9]{8}\.json', ref['path']), 'CT2_APPROVAL')
    raw = read(p.G, ref['commit'], ref['path'])
    need(m.digest(raw) == ref['sha256'], 'CT2_APPROVAL')
    decision = q.strict_json(raw)
    need(all(type(decision.get(key)) is bool for key in ('externalReadAuthorized','independentCleanupAuthorized','paymentAuthorized')), 'CT2_APPROVAL')
    need(decision == {'decision': 'APPROVE_CT2_READS_AND_INDEPENDENT_CLEANUP',
         'operationId': s['operationId'], 'scopeSha256': m.digest(s),
         'externalReadAuthorized': True, 'independentCleanupAuthorized': True,
         'sdkException': EXCEPTION, 'paymentAuthorized': False}, 'CT2_APPROVAL')
    source_guard(s)
    return s, t


class Driver:
    def __init__(self, scope, times, journal, password, io, clock, source_guard, config):
        self.scope, self.times, self.journal = scope, times, journal
        self.password, self.io, self.clock = password, io, clock
        self.guard, self.config = source_guard, config
        self.index = 0
        self.last = clock()
        self.hard_end = time.monotonic() + max(0, times['readEnd'] - self.last)
        self.token = self.database = self.firebase = self.uid = None
        self.process_closed = True

    def gate(self):
        now = self.clock()
        need(self.last <= now < self.times['readEnd'] and time.monotonic() < self.hard_end, 'CT2_DEADLINE')
        self.last = now
        self.journal.inspect()
        self.guard(self.scope)
        need(self.config() == self.scope['configSha256'], 'CT2_CONFIG')
        return self.times['readEnd']

    def step(self, index):
        need(type(index) is int and index == self.index and index < 5, 'CT2_REPLAY')
        deadline = self.gate()
        self.journal.put(f'main-{index}.json', {**self.journal.binding(), 'step': index})
        self.index += 1
        if index < 3:
            raw = self.io.cli(commands()[index], deadline)
            if index == 0:
                need(q.strict_json(raw) == [{'account': m.OWNER, 'status': 'ACTIVE'}], 'CT2_OWNER')
            elif index == 1:
                q.validate_recovery_project(SimpleNamespace(e={'projectNumberSha256': q.PROJECT_NUMBER_SHA256}), q.strict_json(raw))
            else:
                need(type(raw) is dict and set(raw) == {'accessToken'} and type(raw['accessToken']) is str and
                     20 <= len(raw['accessToken']) <= 4096, 'CT2_TOKEN')
                self.token = raw['accessToken']
        elif index == 3:
            self.database = self.io.sql(q.sql_contract()[0], self.password, deadline)
            parsed = c.parse(self.database)
            row = parsed['operator']
            target = {key: row.get(key) for key in ('id','tenantId','email','fullName','role','status')}
            need(type(parsed['operatorCount']) is int and parsed['operatorCount'] == 1 and
                 c.target_digest(target) == q.TARGET_SHA256, 'CT2_ACCOUNT')
            m.exact_uuid(target['id'], 'CT2_UID')
            k.entry.readbacks.exact_account(row, target)
            self.uid = target['id']
        else:
            self.firebase = self.io.https(q.firebase_https_contract(self.uid), self.token, deadline)
            self.token = None
        self.gate()

    def purge(self):
        self.password = self.token = self.database = self.firebase = self.uid = None


def run(scope, times, journal, password, *, factory, coordinate, source_guard, config, clock=time.time):
    """Supervisor owns reads and cleanup; coordinator receives no secret/provider port."""
    result = {'status': 'CURRENT_CONTAINMENT_UNKNOWN', 'historicalAuthentication': 'UNKNOWN',
              'mainComplete': False, 'sessionsAbsent': False, 'processCleanupVerified': False,
              'configurationUnchanged': False, 'privateReferencesCleared': False}
    io = driver = cleanup = None
    main_closed = cleanup_closed = False
    try:
        io = factory()
        driver = Driver(scope, times, journal, password, io, clock, source_guard, config)
        coordinate(driver)
        need(driver.index == 5 and driver.process_closed, 'CT2_MAIN')
        binding = {'operationId': scope['operationId'], 'historicalOperationId': c.R47_OPERATION,
                   'journalSha256': c.R47_JOURNAL_SHA256, 'revocationIntentAt': c.R47_INTENT}
        observed = c.validate(binding, {'operationId': scope['operationId'], 'body': driver.database},
                              {'operationId': scope['operationId'], **driver.firebase},
                              (HERE / 'r47-journal.json').read_bytes())
        result['mainComplete'] = observed['status'] == 'CURRENT_CONTAINMENT_CONFIRMED'
    except BaseException:
        pass  # Fixed labels only; raw exception text never leaves this boundary.
    finally:
        blocked_signals = signal.pthread_sigmask(signal.SIG_BLOCK, {signal.SIGINT, signal.SIGTERM})
        if driver is not None:
            driver.purge()
        # Main source/config/result failure cannot skip independent closeout.
        try:
            if io is not None:
                main_closed = io.close(times['cleanupEnd']) is True
        except BaseException:
            pass
        try:
            need(clock() < times['cleanupEnd'], 'CT2_CLEANUP_DEADLINE')
            journal.put('cleanup-0.json', {**journal.binding(), 'step': 'sessions'})
            cleanup = factory()
            raw = cleanup.sql(q.sql_contract()[1], password, times['cleanupEnd'])
            parsed = c.parse(raw)
            result['sessionsAbsent'] = type(parsed) is dict and set(parsed) == {'sessionsAbsent'} and parsed['sessionsAbsent'] is True
            raw = None
        except BaseException:
            pass
        finally:
            password = None
            try:
                if cleanup is not None:
                    cleanup_closed = cleanup.close(times['cleanupEnd']) is True
            except BaseException:
                pass
        result['processCleanupVerified'] = main_closed and cleanup_closed and (driver is None or driver.process_closed)
        try:
            result['configurationUnchanged'] = config() == scope['configSha256']
        except BaseException:
            pass
        result['privateReferencesCleared'] = driver is None or all(getattr(driver, field) is None
            for field in ('password','token','database','firebase','uid'))
        result['onTime'] = (driver is None or clock() >= driver.last) and clock() < times['cleanupEnd'] < times['purgeEnd']
        if all(result[key] for key in ('mainComplete','sessionsAbsent','processCleanupVerified',
                                      'configurationUnchanged','privateReferencesCleared','onTime')):
            result['status'] = 'CURRENT_CONTAINMENT_CONFIRMED'
        try:
            journal.put('result.json', result)
        finally:
            signal.pthread_sigmask(signal.SIG_SETMASK, blocked_signals)
    return result


def native_main(argv):
    need(len(argv) == 2 and argv[0] == '--run', 'CT2_ARGUMENTS')
    envelope = k.inv.read(Path(argv[1]))
    scope, times = authorize(envelope, time.time())
    need(k.configuration() == scope['configSha256'], 'CT2_CONFIG')
    k.sandbox_check(scope['operationId'])
    root = Path('/private/tmp/p08-ct2-' + scope['operationId'])
    # Reuse the restrictive custody/immutable receipt format and shared operation lease.
    with k.lease('/private/tmp/p08-account-containment.lock'):
        journal = k.Journal(root, scope, create=True)
        journal.put('envelope.json', envelope)
        journal.put('launch.json', journal.binding())
        with k.acl.http_deadline(max(.01, min(120, times['cutoff'] - time.time()))):
            need(input('Type READY to start the hidden password prompt: ') == 'READY', 'CT2_NOT_READY')
        need(time.time() < times['cutoff'], 'CT2_CUTOFF')
        password = None
        previous = {}
        try:
            password = q.recovery_password(times['cutoff'])
            def interrupted(*_):
                raise m.Stop('CT2_INTERRUPTED')
            for sig in (signal.SIGINT, signal.SIGTERM):
                previous[sig] = signal.signal(sig, interrupted)
            return run(scope, times, journal, password, factory=lambda: Transport(time.time, scope['operationId']),
                       coordinate=k.coordinator, source_guard=guard, config=k.configuration)
        finally:
            password = None
            for sig, handler in previous.items():
                signal.signal(sig, handler)



# CT3 is an explicitly separate authority; a CT2 approval never permits writes.
CT3_ACTION = 'VERIFY_R54_CURRENT_CONTAINMENT_WITH_CONDITIONAL_CORRECTION_ONCE'
CT3_DECISION = 'APPROVE_CT3_CONTAINMENT_CONDITIONAL_CORRECTION_AND_INDEPENDENT_CLEANUP'
CT3_LIMITS = {'cli': 3, 'accountSql': 1, 'firebase': 3, 'firebaseUpdate': 1,
              'stripe': 3, 'stripeDisable': 1, 'child': 3, 'closeoutSql': 1, 'cache': 0}
NODE = '/Users/debynyhanbanks/.nvm/versions/node/v24.12.0/bin/node'
ENDPOINT_WORKER = p.B / 'evidence/APP-013/p08-key-correction-20261110/key_check.mjs'
ENDPOINT_SHA256 = 'dbaae6448069a186dc4b9e2fc6182707dda7b61218376e9e97cd21b20b4bfeae'
ENDPOINT_CODES = frozenset({'NONE', 'ENDPOINT_INPUT', 'ENDPOINT_PHASE', 'KEY_INPUT_LIMIT',
    'KEY_ENDPOINT_PIN', 'PAYMENT_TEST_KEY_REQUIRED', 'KEY_CHECK_DEADLINE', 'KEY_CHECK_BUDGET',
    'KEY_CHECK_HTTP', 'PAYMENT_ENDPOINT_DRIFT', 'ENDPOINT_NOT_DISABLED', 'PAYMENT_OUTPUT_LIMIT',
    'PAYMENT_IO_TIMEOUT', 'PAYMENT_DEADLINE', 'ENDPOINT_JSON', 'ENDPOINT_TRANSPORT_OR_OUTPUT_UNKNOWN'})


def ct3_policy():
    root = HERE / 'r54-live-20261117'
    return c.r54_policy((root / 'native-result.json').read_bytes(),
                        (root / 'local-closeout-verification.json').read_bytes())


def ct3_sql_contract():
    original = "(usename='p07_payment_runtime' OR application_name LIKE 'signmons_p08_qualification_%')"
    names = [f'p08-{kind}-{c.R54_OPERATION}' for kind in ('auth', 'runtime', 'probe')]
    predicate = original[:-1] + ' OR application_name IN (' + ','.join("'" + name + "'" for name in names) + '))'
    need(q.QUALIFICATION_SQL.count(original) == 1, 'CT3_SQL_SOURCE')
    main = q.QUALIFICATION_SQL.replace(original, predicate)
    closeout = f'''BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL statement_timeout='15s'; SET LOCAL lock_timeout='5s';
WITH u AS (SELECT id,"tenantId",email,"fullName",role,status FROM "User"
 WHERE "tenantId"='{m.TENANT}'::uuid AND email='{q.TARGET_EMAIL}')
SELECT json_build_object('operatorCount',(SELECT count(*) FROM u),
 'operator',(SELECT row_to_json(u) FROM u),
 'sessionsAbsent',NOT EXISTS(SELECT 1 FROM pg_stat_activity WHERE {predicate} AND pid<>pg_backend_pid()));
ROLLBACK;'''
    return ({'id': 'ct3_account', 'sql': main}, {'id': 'ct3_closeout', 'sql': closeout})


def ct3_resources():
    operator = q._operator_module()
    plan = q.strict_json((p.B / 'evidence/APP-013/p08-local-preparation-20261022/plan.json').read_bytes())
    return {'targetSha256': q.TARGET_SHA256, 'projectNumberSha256': q.PROJECT_NUMBER_SHA256,
            'endpointSha256': ENDPOINT_SHA256, 'endpointUrl': plan['origin'] + '/webhooks/stripe',
            'apiVersion': '2026-03-25.dahlia', 'node': NODE,
            'worker': str(ENDPOINT_WORKER.relative_to(p.B)),
            'database': {'psql': operator.PSQL, 'host': operator.DB_HOST, 'user': 'neondb_owner',
                         'name': 'neondb', 'tls': 'verify-full', 'ca': '/etc/ssl/cert.pem'},
            'sql': list(ct3_sql_contract())}


def authorize_ct3(envelope, now, read=a.committed, source_guard=guard):
    need(type(envelope) is dict and set(envelope) == {'scope', 'decision'}, 'CT3_AUTHORITY')
    s, ref = envelope['scope'], envelope['decision']
    need(type(s) is dict and set(s) == {'action', 'operationId', 'sourceCommit', 'manifestSha256',
         'configSha256', 'window', 'limits', 'sdkException', 'commands', 'policy', 'resources'}, 'CT3_SCOPE')
    m.exact_uuid(s['operationId'], 'CT3_OPERATION')
    need(s['operationId'] != c.R54_OPERATION and s['action'] == CT3_ACTION and
         s['limits'] == CT3_LIMITS and all(type(v) is int for v in s['limits'].values()) and
         s['sdkException'] == EXCEPTION and m.digest(s['commands']) == m.digest(commands()) and
         s['policy'] == ct3_policy() and s['resources'] == ct3_resources(), 'CT3_SCOPE')
    for key, length in [('sourceCommit', 40), ('manifestSha256', 64), ('configSha256', 64)]:
        need(type(s[key]) is str and k.re.fullmatch('[a-f0-9]{' + str(length) + '}', s[key]), 'CT3_SCOPE')
    need(type(s['window']) is dict and set(s['window']) == {'start', 'cutoff', 'readEnd', 'cleanupEnd', 'purgeEnd'}, 'CT3_WINDOW')
    t = {name: m.timestamp(value) for name, value in s['window'].items()}
    need(t['start'] <= now < t['cutoff'] and t['cutoff'] + 90 <= t['readEnd'] and
         t['readEnd'] + 90 <= t['cleanupEnd'] and t['cleanupEnd'] + 5 <= t['purgeEnd'], 'CT3_WINDOW')
    need(type(ref) is dict and set(ref) == {'commit', 'path', 'sha256'} and
         k.re.fullmatch(r'APP013_P08_CT3_EXTERNAL_[0-9]{8}_[a-f0-9]{8}\.json', ref['path']), 'CT3_APPROVAL')
    raw = read(p.G, ref['commit'], ref['path'])
    need(m.digest(raw) == ref['sha256'], 'CT3_APPROVAL')
    decision = q.strict_json(raw)
    expected = {'decision': CT3_DECISION, 'operationId': s['operationId'], 'scopeSha256': m.digest(s),
                'externalReadAuthorized': True, 'conditionalRevocationAuthorized': True,
                'conditionalEndpointDisableAuthorized': True, 'independentCleanupAuthorized': True,
                'noOverlappingOperationConfirmed': True, 'sdkException': EXCEPTION, 'paymentAuthorized': False}
    need(type(decision) is dict and decision == expected and
         all(type(decision[key]) is bool for key, value in expected.items() if type(value) is bool), 'CT3_APPROVAL')
    source_guard(s)
    return s, t


def revoke_descriptor(uid, seconds):
    m.exact_uuid(uid, 'CT3_UID')
    need(type(seconds) is int and c.R54_POLICY_SECOND <= seconds <= 253402300799, 'CT3_REVOCATION')
    return {'id': 'ct3_revoke', 'method': 'POST',
            'url': f'https://identitytoolkit.googleapis.com/v1/projects/{m.PROJECT}/accounts:update',
            'body': {'localId': uid, 'validSince': str(seconds)}}


class EndpointChild(k.entry.NativeIO):
    """Only reuse owned bounded stdin/process methods; no native provider capability."""
    def __init__(self, clock, times, gate, cleanup):
        self.cap = SimpleNamespace(clock=clock, times=times, gate=gate)
        self.cleanup = cleanup
        self.child_processes = set()
        self.child_cleanup_unconfirmed = False


class CT3Transport(Transport):
    def __init__(self, clock, operation):
        super().__init__(clock, operation)
        self.endpoint_io = None

    def sql(self, descriptor, password, deadline):
        need(descriptor in ct3_sql_contract() and not self.closed and self.clock() < deadline and
             type(password) is str and bool(password), 'CT3_SQL_SCOPE')
        operator = q._operator_module()
        env = {key: value for key, value in q.sdk_environment(os.environ).items()
               if not key.startswith(('PG', 'CLOUDSDK_')) and key != 'DATABASE_URL'}
        env.update(PGPASSWORD=password, PGSSLMODE='verify-full', PGSSLROOTCERT='/etc/ssl/cert.pem',
                   PGCONNECT_TIMEOUT='10', PGAPPNAME='signmons_p08_qualification_' + self.binding_operation_id,
                   PGOPTIONS='-c statement_timeout=15000 -c lock_timeout=5000')
        self._capture_sql = True
        try:
            raw = self._owned_run([operator.PSQL, '-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1',
                                  '-h', operator.DB_HOST, '-U', 'neondb_owner', '-d', 'neondb', '-c', descriptor['sql']],
                                 env, min(deadline, self.clock() + 25))
            c.parse(raw)
            return raw
        finally:
            env.clear()
            self._capture_sql = False
            self._sql_raw = None

    def https(self, descriptor, token, deadline):
        if descriptor.get('id') != 'ct3_revoke':
            need(descriptor.get('id') == 'firebase', 'CT3_HTTPS_SCOPE')
            return super().https(descriptor, token, deadline)
        body = descriptor.get('body')
        need(type(body) is dict and set(body) == {'localId', 'validSince'} and
             type(body['validSince']) is str and k.re.fullmatch('[0-9]{1,12}', body['validSince']), 'CT3_HTTPS_SCOPE')
        need(descriptor == revoke_descriptor(body['localId'], int(body['validSince'])) and
             not self.closed and self.clock() < deadline and type(token) is str and 20 <= len(token) <= 4096,
             'CT3_HTTPS_SCOPE')
        request = q.urllib.request.Request(descriptor['url'], data=json.dumps(body, separators=(',', ':')).encode(),
            method='POST', headers={'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json',
                                    'x-goog-user-project': m.PROJECT})
        class NoRedirect(q.urllib.request.HTTPRedirectHandler):
            def redirect_request(self, *_args, **_kwargs):
                return None
        response = None
        try:
            seconds = max(.01, min(15, deadline - self.clock()))
            with k.acl.http_deadline(seconds):
                try:
                    response = q.urllib.request.build_opener(q.urllib.request.ProxyHandler({}), NoRedirect()).open(request, timeout=seconds)
                except q.urllib.error.HTTPError as error:
                    response = error
                raw = response.read(q.MAX_OUTPUT + 1)
                need(self.clock() < deadline and len(raw) <= q.MAX_OUTPUT and
                     type(response.status) is int and not 300 <= response.status < 400, 'CT3_HTTPS_OUTPUT')
                return {'status': response.status, 'body': raw}
        finally:
            if response is not None:
                response.close()

    def endpoint(self, phase, key, endpoint_id, deadline, times, gate):
        need(not self.closed and phase in ('OBSERVE', 'DISABLE', 'VERIFY'), 'CT3_ENDPOINT_PHASE')
        need(self.endpoint_io is None or (not self.endpoint_io.child_processes and
             not self.endpoint_io.child_cleanup_unconfirmed), 'CT3_CHILD_CLOSURE')
        self.endpoint_io = EndpointChild(self.clock, times, gate, phase == 'VERIFY')
        until = min(deadline, self.clock() + 7)
        request = {'phase': phase, 'key': key, 'endpointId': endpoint_id, 'deadline': int(until * 1000)}
        try:
            result = self.endpoint_io.child([NODE, str(ENDPOINT_WORKER), '--endpoint-once'],
                 input=json.dumps(request, separators=(',', ':')), text=True, capture_output=True,
                 timeout=max(.01, until - self.clock()), env={'PATH': '/usr/bin:/bin:/opt/homebrew/bin', 'LANG': 'C'})
            return endpoint_result(result, phase)
        finally:
            request.clear()
            key = endpoint_id = None

    def endpoint_closed(self):
        return self.endpoint_io is None or (not self.endpoint_io.child_processes and
                                           not self.endpoint_io.child_cleanup_unconfirmed)

    def close(self, deadline):
        endpoint_closed = True
        if self.endpoint_io is not None:
            # Attempt every owned group even if one close fails. No PID adoption.
            results = []
            for process in list(self.endpoint_io.child_processes):
                try:
                    results.append(self.endpoint_io._finish_child(process) is True)
                except BaseException:
                    results.append(False)
            endpoint_closed = all(results) and self.endpoint_closed()
        try:
            base_closed = super().close(deadline) is True
        except BaseException:
            base_closed = False
        return base_closed and endpoint_closed


def endpoint_result(result, phase):
    need(type(result.stdout) is str and type(result.stderr) is str and result.stderr == '' and
         len(result.stdout.encode()) <= 8192 and type(result.returncode) is int, 'CT3_ENDPOINT_OUTPUT')
    value = q.strict_json(result.stdout)
    need(type(value) is dict and set(value) == {'status', 'phase', 'code', 'requests', 'httpStatus', 'scope', 'state'} and
         value['phase'] == phase and value['code'] in ENDPOINT_CODES and
         type(value['requests']) is int and value['requests'] in (0, 1) and
         (value['httpStatus'] is None or (type(value['httpStatus']) is int and 100 <= value['httpStatus'] <= 599)) and
         value['scope'] in ('MATCH', 'DRIFT', 'UNKNOWN') and value['state'] in ('DISABLED', 'ENABLED', 'UNKNOWN'),
         'CT3_ENDPOINT_OUTPUT')
    success = value['status'] == 'ENDPOINT_OBSERVED'
    need((success and result.returncode == 0 and value['code'] == 'NONE' and value['requests'] == 1 and
          value['httpStatus'] == 200 and value['scope'] == 'MATCH' and value['state'] != 'UNKNOWN' and
          (phase != 'DISABLE' or value['state'] == 'DISABLED')) or
         (value['status'] == 'ENDPOINT_REFUSED' and result.returncode == 2 and value['code'] != 'NONE'),
         'CT3_ENDPOINT_OUTPUT')
    need(value['scope'] == 'MATCH' or value['state'] == 'UNKNOWN', 'CT3_ENDPOINT_OUTPUT')
    return value


class CT3Driver(Driver):
    def __init__(self, scope, times, journal, password, key, endpoint_id, io, clock, source_guard, config):
        need(scope.get('policy') == ct3_policy(), 'CT3_SCOPE')
        super().__init__(scope, times, journal, password, io, clock, source_guard, config)
        self.key, self.endpoint_id = key, endpoint_id
        self.target = self.initial_since = self.requested_since = None
        self.initial_account = self.initial_firebase = None
        self.initial_http = None
        self.owner_project = False
        self.hard_cleanup = time.monotonic() + max(0, times['cleanupEnd'] - self.last)
        self.integrity = True
        self.used = set()

    def gate(self, cleanup=False):
        now = self.clock()
        need(self.integrity, 'CT3_INTEGRITY')
        if now < self.last:
            self.integrity = False
            need(False, 'CT3_CLOCK_ROLLBACK')
        need(self.last <= now and now < self.times['cleanupEnd' if cleanup else 'readEnd'] and
             time.monotonic() < (self.hard_cleanup if cleanup else self.hard_end), 'CT3_DEADLINE')
        self.last = now
        try:
            self.journal.inspect()
            self.guard(self.scope)
            need(self.config() == self.scope['configSha256'], 'CT3_CONFIG')
        except BaseException:
            self.integrity = False
            raise
        return self.times['cleanupEnd' if cleanup else 'readEnd']

    def reserve(self, slot, action, cleanup=False, **safe):
        deadline = self.gate(cleanup)
        need(slot not in self.used, 'CT3_REPLAY')
        self.used.add(slot)  # Publication failure must not permit a second dispatch.
        self.journal.put(slot + '.json', {**self.journal.binding(), 'step': action, **safe})
        return deadline

    def step(self, index):
        if index < 3:
            try:
                super().step(index)
            except BaseException as error:
                if index < 2 and isinstance(error, m.Stop) and str(error) in ('CT2_OWNER', 'RECOVERY_PROJECT'):
                    self.integrity = False
                raise
            if index == 1:
                self.owner_project = True
            return
        need(type(index) is int and index == self.index and index in (3, 4), 'CT3_REPLAY')
        deadline = self.reserve('main-' + str(index), 'account' if index == 3 else 'firebase_initial')
        self.index += 1
        if index == 3:
            raw = self.io.sql(ct3_sql_contract()[0], self.password, deadline)
            self.initial_account, self.target = c.current_account(self.scope['operationId'],
                {'operationId': self.scope['operationId'], 'body': raw})
            raw = None
            need(self.target is not None, 'CT3_ACCOUNT')
            self.uid = self.target['id']
        else:
            response = self.io.https(q.firebase_https_contract(self.uid), self.token, deadline)
            if type(response) is dict and type(response.get('status')) is int and 100 <= response['status'] <= 599:
                self.initial_http = response['status']
            self.initial_firebase, self.initial_since = c.current_firebase(self.scope['operationId'],
                {'operationId': self.scope['operationId'], **response}, self.target, int(self.clock()), policy_minimum=self.scope['policy']['minimumValidSince'])
            response = None
        self.gate()

    def purge(self):
        super().purge()
        self.key = self.endpoint_id = self.target = self.initial_since = self.requested_since = None


def ct3_inputs_valid(key, endpoint_id):
    need(type(key) is str and k.re.fullmatch(r'sk_test_[A-Za-z0-9]{16,256}', key) and
         type(endpoint_id) is str and k.re.fullmatch(r'we_[A-Za-z0-9]+', endpoint_id) and
         m.digest(endpoint_id.encode()) == ENDPOINT_SHA256, 'CT3_INPUT')


def run_ct3(scope, times, journal, password, key, endpoint_id, *, factory, coordinate,
            source_guard, config, clock=time.time):
    result = {'status': 'CURRENT_CONTAINMENT_UNKNOWN', 'historicalAuthentication': 'UNKNOWN',
              'initialAccount': None, 'initialFirebase': None, 'finalAccount': None, 'finalFirebase': None,
              'initialFirebaseHttpStatus': None, 'finalFirebaseHttpStatus': None,
              'endpointInitial': None, 'endpointChange': None, 'endpointFinal': None,
              'revocationAttempted': False, 'revocationAcknowledged': None, 'revocationHttpStatus': None,
              'endpointDisableAttempted': False, 'failures': [], 'failureDetails': [], 'processCleanupVerified': False,
              'configurationUnchanged': False, 'privateReferencesCleared': False, 'onTime': False}
    io = driver = response = raw = target = None
    closed = []
    def failure(stage, error=None):
        # Stages are fixed caller-owned labels, never derived from exception text.
        if stage not in result['failures']:
            result['failures'].append(stage)
            code = 'CT3_INTERRUPTED' if isinstance(error, (KeyboardInterrupt, SystemExit)) else 'CT3_UNCONFIRMED'
            allowed = {'CT3_INTEGRITY', 'CT3_DEADLINE', 'CT3_CONFIG', 'CT3_REPLAY', 'CT3_MAIN',
                'CT3_ACCOUNT', 'CT3_REVOCATION', 'CT3_HTTPS_OUTPUT', 'CT3_ENDPOINT_OUTPUT',
                'CT3_CHILD_CLOSURE', 'CT3_ENTRY', 'CT3_INPUT', 'CT3_FIREBASE_UNBOUND', 'CT3_INTERRUPTED',
                'CT2_OWNER', 'RECOVERY_PROJECT', 'CT2_TOKEN', 'CT2_SOURCE', 'IQ1_SOURCE', 'CT3_CLOCK_ROLLBACK',
                'PROCESS_TIMEOUT', 'PROCESS_REFUSED', 'PROCESS_CLEANUP_UNCONFIRMED', 'HTTPS_REFUSED',
                'CHILD_PROCESS_CLOSEOUT_UNCONFIRMED', 'CHILD_OUTPUT_LIMIT', 'CLOCK_ROLLBACK'}
            if isinstance(error, (m.Stop, k.inv.Stop)) and str(error) in allowed:
                code = str(error)
            if code in ('CLOCK_ROLLBACK', 'CT3_CLOCK_ROLLBACK') and driver is not None:
                driver.integrity = False
            result['failureDetails'].append({'stage': stage, 'code': code})
    try:
        ct3_inputs_valid(key, endpoint_id)
        io = factory()
        driver = CT3Driver(scope, times, journal, password, key, endpoint_id, io, clock, source_guard, config)
        try:
            coordinate(driver)
            need(driver.index == 5 and driver.process_closed, 'CT3_MAIN')
        except BaseException as error:
            failure('ACCOUNT_INITIAL', error)
        result['initialAccount'], result['initialFirebase'] = driver.initial_account, driver.initial_firebase
        result['initialFirebaseHttpStatus'] = driver.initial_http
        try:
            flags = driver.initial_firebase
            eligible = (driver.owner_project and driver.initial_account is not None and
                        all(value is True for value in driver.initial_account.values()) and flags is not None and
                        all(value is True for name, value in flags.items() if name != 'revocationBoundMet') and
                        flags.get('revocationBoundMet') is False and driver.initial_since is not None)
            if eligible:
                seconds = int(clock())
                need(seconds >= max(c.R54_POLICY_SECOND, driver.initial_since), 'CT3_REVOCATION')
                deadline = driver.reserve('cleanup-2', 'firebase_revoke', requestedValidSince=seconds)
                driver.requested_since = seconds
                result['revocationAttempted'] = True
                response = io.https(revoke_descriptor(driver.uid, seconds), driver.token, deadline)
                status = response.get('status')
                need(type(status) is int and 100 <= status <= 599, 'CT3_HTTPS_OUTPUT')
                result['revocationHttpStatus'] = status
                result['revocationAcknowledged'] = status == 200
                response = None
                if status != 200:
                    failure('FIREBASE_UPDATE')
        except BaseException as error:
            failure('FIREBASE_UPDATE', error)
        finally:
            response = None
        try:
            deadline = driver.reserve('main-5', 'endpoint_observe')
            result['endpointInitial'] = io.endpoint('OBSERVE', key, endpoint_id, deadline, times, driver.gate)
            initial = result['endpointInitial']
            if initial['status'] != 'ENDPOINT_OBSERVED':
                failure('ENDPOINT_INITIAL')
            if driver.owner_project and initial['status'] == 'ENDPOINT_OBSERVED' and initial['scope'] == 'MATCH' and initial['state'] == 'ENABLED':
                need(io.endpoint_closed(), 'CT3_CHILD_CLOSURE')
                deadline = driver.reserve('main-6', 'endpoint_disable')
                result['endpointDisableAttempted'] = True
                result['endpointChange'] = io.endpoint('DISABLE', key, endpoint_id, deadline, times, driver.gate)
                if result['endpointChange']['status'] != 'ENDPOINT_OBSERVED':
                    failure('ENDPOINT_DISABLE')
        except BaseException as error:
            failure('ENDPOINT_DISABLE' if result['endpointDisableAttempted'] else 'ENDPOINT_INITIAL', error)
    except BaseException as error:
        failure('ENTRY', error)
    finally:
        previous = signal.pthread_sigmask(signal.SIG_BLOCK, {signal.SIGINT, signal.SIGTERM})
        try:
            if io is not None:
                try:
                    closed.append(io.close(times['cleanupEnd']) is True)
                except BaseException:
                    closed.append(False)
            # Each observation owns a fresh transport and fixed reservation. A failed
            # branch cannot short-circuit the others. Source/authority gates still apply.
            for stage in ('FIREBASE_FINAL', 'ENDPOINT_FINAL', 'SQL_FINAL'):
                cleanup = None
                try:
                    need(driver is not None, 'CT3_ENTRY')
                    if stage == 'FIREBASE_FINAL':
                        need(driver.uid is not None and driver.token is not None and driver.target is not None,
                             'CT3_FIREBASE_UNBOUND')
                        deadline = driver.reserve('cleanup-3', 'firebase_final', True)
                        cleanup = factory()
                        response = cleanup.https(q.firebase_https_contract(driver.uid), driver.token, deadline)
                        if type(response) is dict and type(response.get('status')) is int and 100 <= response['status'] <= 599:
                            result['finalFirebaseHttpStatus'] = response['status']
                        result['finalFirebase'], _ = c.current_firebase(scope['operationId'],
                            {'operationId': scope['operationId'], **response}, driver.target, int(clock()),
                            initial_valid_since=driver.initial_since, requested_valid_since=driver.requested_since,
                            policy_minimum=scope['policy']['minimumValidSince'])
                        response = None
                    elif stage == 'ENDPOINT_FINAL':
                        need(io is not None and io.endpoint_closed(), 'CT3_CHILD_CLOSURE')
                        deadline = driver.reserve('cleanup-1', 'endpoint_verify', True)
                        cleanup = factory()
                        result['endpointFinal'] = cleanup.endpoint('VERIFY', key, endpoint_id, deadline, times, driver.gate)
                    else:
                        deadline = driver.reserve('cleanup-0', 'account_and_sessions_final', True)
                        cleanup = factory()
                        raw = cleanup.sql(ct3_sql_contract()[1], password, deadline)
                        result['finalAccount'], target = c.current_account(scope['operationId'],
                            {'operationId': scope['operationId'], 'body': raw}, final=True)
                        raw = target = None
                except BaseException as error:
                    failure(stage, error)
                finally:
                    response = raw = target = None
                    if cleanup is not None:
                        try:
                            closed.append(cleanup.close(times['cleanupEnd']) is True)
                        except BaseException:
                            closed.append(False)
            if driver is not None:
                driver.purge()
            password = key = endpoint_id = response = raw = target = None
            result['privateReferencesCleared'] = driver is None or all(getattr(driver, field) is None for field in
                 ('password', 'token', 'database', 'firebase', 'uid', 'key', 'endpoint_id', 'target', 'initial_since', 'requested_since'))
            result['processCleanupVerified'] = bool(closed) and all(closed) and (driver is None or driver.process_closed)
            try:
                result['configurationUnchanged'] = config() == scope['configSha256']
                result['onTime'] = (driver is None or clock() >= driver.last) and clock() < times['cleanupEnd'] < times['purgeEnd']
            except BaseException:
                failure('FINAL_LOCAL')
            endpoint = result['endpointFinal']
            if (driver is not None and driver.integrity and driver.owner_project and
                result['finalAccount'] and all(v is True for v in result['finalAccount'].values()) and
                result['finalFirebase'] and all(v is True for v in result['finalFirebase'].values()) and
                (driver.initial_firebase is None or all(v is not False for name, v in driver.initial_firebase.items()
                    if name != 'revocationBoundMet')) and
                endpoint and endpoint['status'] == 'ENDPOINT_OBSERVED' and endpoint['scope'] == 'MATCH' and
                endpoint['state'] == 'DISABLED' and all(result[name] is True for name in
                ('processCleanupVerified', 'privateReferencesCleared', 'configurationUnchanged', 'onTime'))):
                result['status'] = 'CURRENT_CONTAINMENT_CONFIRMED'
            journal.put('result.json', result)
        finally:
            signal.pthread_sigmask(signal.SIG_SETMASK, previous)
    return result


def ct3_hidden(prompt, cutoff):
    need(sys.stdin.isatty() and time.time() < cutoff, 'CT3_HIDDEN_INPUT')
    with k.acl.http_deadline(min(120, cutoff - time.time())):
        import warnings
        with warnings.catch_warnings():
            warnings.simplefilter('error', q.getpass.GetPassWarning)
            value = q.getpass.getpass(prompt)
        need(time.time() < cutoff and 0 < len(value) <= 4096, 'CT3_INPUT')
        return value


def native_main_ct3(argv):
    need(len(argv) == 2 and argv[0] == '--run-ct3', 'CT3_ARGUMENTS')
    envelope = k.inv.read(Path(argv[1]))
    scope, times = authorize_ct3(envelope, time.time())
    need(k.configuration() == scope['configSha256'], 'CT3_CONFIG')
    k.sandbox_check(scope['operationId'])
    password = key = endpoint_id = None
    previous = {}
    with k.lease('/private/tmp/p08-account-containment.lock'):
        journal = k.Journal(Path('/private/tmp/p08-ct3-' + scope['operationId']), scope, create=True)
        journal.put('envelope.json', envelope)
        journal.put('launch.json', journal.binding())
        try:
            with k.acl.http_deadline(min(120, times['cutoff'] - time.time())):
                need(input('Type READY to start the three hidden inputs: ') == 'READY', 'CT3_NOT_READY')
            password = q.recovery_password(times['cutoff'])
            key = ct3_hidden('Existing Sandbox secret key (hidden): ', times['cutoff'])
            endpoint_id = ct3_hidden('Existing Sandbox endpoint ID (hidden): ', times['cutoff'])
            ct3_inputs_valid(key, endpoint_id)
            need(time.time() < times['cutoff'], 'CT3_CUTOFF')
            # Revalidate exact committed authority/source after attended input.
            rebound_scope, rebound_times = authorize_ct3(k.inv.read(Path(argv[1])), time.time())
            need(rebound_scope == scope and rebound_times == times, 'CT3_ENVELOPE_DRIFT')
            def interrupted(*_):
                raise m.Stop('CT3_INTERRUPTED')
            for sig in (signal.SIGINT, signal.SIGTERM):
                previous[sig] = signal.signal(sig, interrupted)
            return run_ct3(scope, times, journal, password, key, endpoint_id,
                factory=lambda: CT3Transport(time.time, scope['operationId']), coordinate=k.coordinator,
                source_guard=guard, config=k.configuration)
        except BaseException:
            password = key = endpoint_id = None
            if not (journal.root / 'result.json').exists():
                journal.put('result.json', {'status': 'CURRENT_CONTAINMENT_UNKNOWN',
                    'stage': 'INPUT_OR_LAUNCH_REFUSED', 'privateReferencesCleared': True,
                    'historicalAuthentication': 'UNKNOWN'})
            raise
        finally:
            password = key = endpoint_id = None
            for sig, handler in previous.items():
                signal.signal(sig, handler)


if __name__ == '__main__':
    try:
        final = (native_main_ct3(sys.argv[1:]) if sys.argv[1:2] == ['--run-ct3'] else native_main(sys.argv[1:]))
    except BaseException:
        final = {'status': 'CURRENT_CONTAINMENT_UNKNOWN', 'failure': 'CT3_STOP' if sys.argv[1:2] == ['--run-ct3'] else 'CT2_STOP'}
    print(json.dumps(final, sort_keys=True))
    sys.exit(0 if final['status'] == 'CURRENT_CONTAINMENT_CONFIRMED' else 2)
