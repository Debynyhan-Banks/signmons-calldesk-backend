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


if __name__ == '__main__':
    try:
        final = native_main(sys.argv[1:])
    except BaseException:
        final = {'status': 'CURRENT_CONTAINMENT_UNKNOWN', 'failure': 'CT2_STOP'}
    print(json.dumps(final, sort_keys=True))
    sys.exit(0 if final['status'] == 'CURRENT_CONTAINMENT_CONFIRMED' else 2)
