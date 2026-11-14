"""IQ1 identity-only qualification. No native hooks without committed authority.

The injected worker API has no native defaults. The detached worker owns every
SDK Popen; its main coordinator can request only five ordered steps. SDK children
cannot fork. No PID discovered from disk or a process listing is ever adopted.
"""
import contextlib
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import selectors
import signal
import stat
import subprocess
import sys
import time
from types import SimpleNamespace

import packet as p

q, m = p.q, p.q.model
a = q.current_module('authority')
_path = list(sys.path)
try:
    sys.path.insert(0, str(a.HERE))
    entry = a.load('p08-native-entry-local-20261101/source/entry.py', 'iq1_entry')
finally:
    sys.path[:] = _path
inv = sys.modules['private_inventory']
acl = q.current_module('acl')
HERE = Path(__file__).resolve().parent
MANIFEST = HERE / 'iq1-source-manifest.json'
SANDBOX = '/usr/bin/sandbox-exec'
PROFILE = '(version 1)(allow default)(deny process-fork)'
SDK = Path('/opt/homebrew/bin/gcloud').resolve().parents[1] / 'lib/gcloud.py'
ACTION = 'IQ1_IDENTITY_ENABLE_READBACK_RESTORE_ONCE'
DECISION = 'APPROVE_IQ1_IDENTITY_QUALIFICATION_SDK_EXCEPTION_AND_INDEPENDENT_CLEANUP'
SDK_EXCEPTION = 'SDK_EXISTING_OWNER_REFRESH_CACHE_INTERNAL_RETRIES_NO_TOKEN_EXPORT'
LIMITS = {'mainCli': 5, 'cleanupCli': 6, 'enable': 1, 'disable': 1,
          'cache': 0, 'https': 0, 'sql': 0, 'payment': 0}
COORDINATOR = ('import sys\nfor i in range(5):\n print(i,flush=True)\n'
               ' if sys.stdin.readline()!= "OK\\n":sys.exit(1)\n')


class Stop(Exception):
    pass


def need(value, code):
    if not value:
        raise Stop(code)


def digest(value):
    return hashlib.sha256(value if isinstance(value, bytes) else
                          json.dumps(value, sort_keys=True, separators=(',', ':')).encode()).hexdigest()


SAFE = frozenset('IQ1_SCOPE IQ1_WINDOW IQ1_DEADLINE IQ1_CLOCK IQ1_SOURCE IQ1_CONFIG '
                 'IQ1_AUTHORITY IQ1_CUSTODY IQ1_REPLAY IQ1_BUDGET IQ1_COMMAND IQ1_OWNER '
                 'IQ1_PROJECT IQ1_METADATA IQ1_INITIAL_STATE IQ1_UID IQ1_PROCESS '
                 'IQ1_PROTOCOL IQ1_INTERRUPTED IQ1_SANDBOX IQ1_UNKNOWN IQ1_READBACK '
                 'IQ1_INTERFACE IQ1_LEASE IQ1_ACK'.split()) | frozenset(
                     code for code in entry.PREFLIGHT_CODES if code.startswith('RUNTIME_IDENTITY_'))


def code(error):
    # Unknown/private exception text never crosses this boundary.
    if type(error) in (Stop, entry.c.Stop) and len(error.args) == 1 and type(error.args[0]) is str and error.args[0] in SAFE:
        return error.args[0]
    if type(error) is m.Stop and len(error.args) == 1 and type(error.args[0]) is str:
        return {'PROCESS_TIMEOUT': 'IQ1_DEADLINE', 'PROCESS_DEADLINE': 'IQ1_DEADLINE',
                'CLOCK_ROLLBACK': 'IQ1_CLOCK', 'PROCESS_REFUSED': 'IQ1_PROCESS',
                'PROCESS_CLEANUP_UNCONFIRMED': 'IQ1_PROCESS',
                'PROCESS_OWNERSHIP_UNKNOWN': 'IQ1_PROCESS'}.get(error.args[0], 'IQ1_UNKNOWN')
    return 'IQ1_INTERRUPTED' if isinstance(error, (KeyboardInterrupt, SystemExit)) else 'IQ1_UNKNOWN'


def commands():
    values = {d['id']: list(d['argv']) for d in q.current_cli_contract()
              if d['id'] in ('owner', 'project', 'identity')}
    for enabled, name in ((True, 'enable'), (False, 'disable')):
        values[name] = [q.GCLOUD, *entry.restore.command({}, 'identity', m.IDENTITY, enabled), '--format=json']
    # Derive the real RB1 vector by invoking its method with an inert cloud seam.
    adapter = object.__new__(entry.RuntimeAdapter)
    def capture(vector, deadline):
        values['readback'] = [q.GCLOUD, *vector]
        return {'email': m.IDENTITY, 'disabled': False}
    adapter.cloud = capture
    entry.RuntimeAdapter.readback(adapter, 'identity', m.IDENTITY, True, {}, 0)
    return values


def wrapped(argv):
    need(list(argv) in commands().values(), 'IQ1_COMMAND')
    return [SANDBOX, '-p', PROFILE, p.PYTHON, '-I', '-B', '-S', str(SDK), *argv[1:]]


def validate(scope, now, starting=False):
    fields = {'version', 'action', 'operationId', 'sourceCommit', 'manifestSha256',
              'configSha256', 'window', 'limits', 'sdkException', 'commands',
              'wrappedCommands', 'automaticRetryAllowed', 'allowanceUsd'}
    need(type(scope) is dict and set(scope) == fields, 'IQ1_SCOPE')
    need(type(scope['version']) is int and scope['version'] == 1 and scope['action'] == ACTION and
         scope['limits'] == LIMITS and all(type(v) is int for v in scope['limits'].values()) and
         scope['sdkException'] == SDK_EXCEPTION and scope['automaticRetryAllowed'] is False and
         type(scope['allowanceUsd']) is int and scope['allowanceUsd'] == 0, 'IQ1_SCOPE')
    m.exact_uuid(scope['operationId'], 'IQ1_OPERATION')
    need(re.fullmatch('[a-f0-9]{40}', scope['sourceCommit'] or '') is not None, 'IQ1_SOURCE')
    for name in ('manifestSha256', 'configSha256'):
        need(type(scope[name]) is str and re.fullmatch('[a-f0-9]{64}', scope[name]), 'IQ1_SCOPE')
    need(scope['commands'] == commands() and scope['wrappedCommands'] ==
         {k: wrapped(v) for k, v in commands().items()}, 'IQ1_COMMAND')
    need(type(scope['window']) is dict and set(scope['window']) ==
         {'start', 'cutoff', 'workEnd', 'cleanupEnd', 'purgeEnd'}, 'IQ1_WINDOW')
    times = {k: m.timestamp(v) for k, v in scope['window'].items()}
    need(times['start'] < times['cutoff'] < times['workEnd'] < times['cleanupEnd'] < times['purgeEnd'] and
         times['cleanupEnd'] - times['workEnd'] >= 660 and
         times['purgeEnd'] - times['cleanupEnd'] >= 120 and
         times['purgeEnd'] - times['start'] <= 3600, 'IQ1_WINDOW')
    if starting:
        need(times['start'] <= now < times['cutoff'] and times['workEnd'] - now >= 60, 'IQ1_DEADLINE')
    return times


def source_guard(scope, committed=True):
    need(not MANIFEST.is_symlink() and digest(MANIFEST.read_bytes()) == scope['manifestSha256'], 'IQ1_SOURCE')
    manifest = json.loads(MANIFEST.read_bytes())
    need(set(manifest) == {'version', 'files', 'sdkFiles'} and manifest['version'] == 1, 'IQ1_SOURCE')
    need({str((HERE / name).relative_to(p.B)) for name in
          ('iq1_identity_boundary.py', 'test_iq1_identity_boundary.py', 'packet.py')} <= set(manifest['files']) and
         {SANDBOX, p.PYTHON, str(SDK)} <= set(manifest['sdkFiles']), 'IQ1_SOURCE')
    for name, expected in manifest['files'].items():
        path = p.B / name
        need(not Path(name).is_absolute() and '..' not in Path(name).parts and
             not path.is_symlink() and digest(path.read_bytes()) == expected, 'IQ1_SOURCE')
        if committed:
            need(digest(a.committed(p.B, scope['sourceCommit'], name)) == expected, 'IQ1_SOURCE')
    if committed:
        need(digest(a.committed(p.B, scope['sourceCommit'], str(MANIFEST.relative_to(p.B)))) ==
             scope['manifestSha256'], 'IQ1_SOURCE')
    for name, expected in manifest['sdkFiles'].items():
        need(digest(Path(name).read_bytes()) == expected, 'IQ1_SOURCE')
    model_manifest = m.verify_local_manifest()
    m.verify_locked_sources()
    a.verify_sources()
    if committed:
        q.verify_qualification_sources(scope['sourceCommit'], model_manifest, a.committed)
    need(Path(sys.executable).resolve() == Path(p.PYTHON).resolve() and sys.platform == 'darwin', 'IQ1_SOURCE')


def configuration():
    q.sdk_environment(os.environ)
    return digest(repr(acl.config_snapshot(acl.CONFIG_ROOT, os.environ)).encode())


def authorize(envelope, now, read_commit=a.committed, guard=source_guard, starting=False):
    need(type(envelope) is dict and set(envelope) == {'scope', 'decision'}, 'IQ1_AUTHORITY')
    scope, ref = envelope['scope'], envelope['decision']
    validate(scope, now, starting)
    need(type(ref) is dict and set(ref) == {'commit', 'path', 'sha256'} and
         re.fullmatch('APP013_P08_IQ1_EXTERNAL_[0-9]{8}_[a-f0-9]{8}\\.json', ref['path'] or ''), 'IQ1_AUTHORITY')
    raw = read_commit(p.G, ref['commit'], ref['path'])
    need(digest(raw) == ref['sha256'], 'IQ1_AUTHORITY')
    decision = q.strict_json(raw)
    need(type(decision) is dict and all(type(decision.get(key)) is bool for key in
         ('externalActionAuthorized', 'independentCleanupAuthorized', 'paymentAuthorized')), 'IQ1_AUTHORITY')
    need(decision == {'decision': DECISION, 'scopeSha256': digest(scope),
         'operationId': scope['operationId'], 'externalActionAuthorized': True,
         'independentCleanupAuthorized': True, 'sdkException': SDK_EXCEPTION,
         'paymentAuthorized': False}, 'IQ1_AUTHORITY')
    guard(scope)
    return scope


def root_for(scope):
    return Path('/private/tmp/p08-iq1-' + scope['operationId'])


class Journal:
    """Exclusive immutable safe receipts; incomplete publications are UNKNOWN."""
    def __init__(self, root, scope, create=False):
        self.root, self.scope = Path(root), scope
        self.hashes = {}
        if create:
            self.root.mkdir(mode=0o700)
        self.identity = self.inspect()

    def inspect(self):
        st = self.root.lstat()
        need(not self.root.is_symlink() and stat.S_ISDIR(st.st_mode) and
             stat.S_IMODE(st.st_mode) == 0o700 and st.st_uid == os.getuid(), 'IQ1_CUSTODY')
        identity = [st.st_dev, st.st_ino]
        need(not hasattr(self, 'identity') or self.identity == identity, 'IQ1_CUSTODY')
        for path in self.root.iterdir():
            info = path.lstat()
            need(re.fullmatch('(envelope|launch|worker|ready|result|main-[0-4]|cleanup-[0-5]|enable|disable)\\.json', path.name) and
                 stat.S_ISREG(info.st_mode) and info.st_nlink == 1 and info.st_uid == os.getuid() and
                 stat.S_IMODE(info.st_mode) == 0o600 and info.st_size <= 65536, 'IQ1_CUSTODY')
            current = digest(inv.read(path))
            need(path.name not in self.hashes or self.hashes[path.name] == current, 'IQ1_CUSTODY')
            self.hashes[path.name] = current
        return identity

    def put(self, name, value):
        self.inspect()
        need(re.fullmatch('(envelope|launch|worker|ready|result|main-[0-4]|cleanup-[0-5]|enable|disable)\\.json', name), 'IQ1_CUSTODY')
        inv.reserve(self.root / name, value)
        self.hashes[name] = digest(value)
        fd = os.open(self.root, os.O_RDONLY)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)

    def binding(self):
        return {'operationId': self.scope['operationId'], 'scopeSha256': digest(self.scope),
                'rootIdentity': self.identity}


@contextlib.contextmanager
def lease(path):
    fd = os.open(path, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    try:
        st = os.fstat(fd)
        need(stat.S_ISREG(st.st_mode) and st.st_uid == os.getuid() and st.st_nlink == 1 and
             stat.S_IMODE(st.st_mode) == 0o600, 'IQ1_LEASE')
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise Stop('IQ1_LEASE') from None
        # Keep the inode; unlinking a lock permits two simultaneous lock owners.
        yield
    finally:
        os.close(fd)


def denied(*args, **kwargs):
    raise Stop('IQ1_INTERFACE')


class Cloud:
    """Reuse actual native serializer, exposing no credential or other-resource API."""
    cloud = entry.NativeIO.cloud
    sql = https = credentials = ensure_owner = child = denied

    def __init__(self, send):
        self.send = send
        self.restore = entry.restore
        self.cap = SimpleNamespace(plan={'iam': []})  # serializer input, not a native Capability

    def cli(self, vector):
        return self.send([q.GCLOUD, *vector]).decode('utf-8', 'strict').strip()


class Boundary:
    def __init__(self, scope, journal, *, factory, guard, config, clock=time.time):
        self.scope, self.journal, self.factory = scope, journal, factory
        self.guard, self.config, self.clock = guard, config, clock
        self.times = validate(scope, clock(), True)
        self.last, self.started = clock(), time.monotonic()
        self.hard_end = self.started + self.times['cleanupEnd'] - self.last
        self.phase, self.counts = 'main', {'main': 0, 'cleanup': 0}
        self.io = None
        self.uid = None
        self.intent = self.ack = self.enabled = self.restored = False
        self.process_closed = True
        self.config_closed = False
        self.failure = self.cleanup_failure = None
        self.cleanup_readback_failure = None
        self.stage = 'PREPARE'
        self.cloud = Cloud(self.send)
        self.adapter = object.__new__(entry.RuntimeAdapter)
        self.adapter.cloud = self.cloud.cloud

    def gate(self):
        now = self.clock()
        need(now >= self.last, 'IQ1_CLOCK')
        self.last = now
        deadline = self.times['workEnd' if self.phase == 'main' else 'cleanupEnd']
        need(now + 3 < deadline and time.monotonic() < self.hard_end, 'IQ1_DEADLINE')
        self.journal.inspect()
        self.guard(self.scope)
        need(self.config() == self.scope['configSha256'], 'IQ1_CONFIG')
        return min(deadline, now + 8)

    def send(self, argv):
        expected = (['owner', 'project', 'identity', 'enable', 'readback'] if self.phase == 'main'
                    else ['owner', 'project', 'identity', 'disable', 'readback', 'identity'])
        index = self.counts[self.phase]
        need(index < len(expected), 'IQ1_BUDGET')
        need(list(argv) == commands()[expected[index]], 'IQ1_COMMAND')
        deadline = self.gate()
        self.journal.put(f'{self.phase}-{index}.json', {**self.journal.binding(), 'step': expected[index]})
        self.counts[self.phase] += 1
        raw = self.io.run(argv, deadline)
        self.gate()
        return raw

    def metadata(self):
        value = q.strict_json(self.send(commands()['identity']))
        need(type(value) is dict and set(value) <= {'email', 'uniqueId', 'disabled'} and
             value.get('email') == m.IDENTITY and type(value.get('uniqueId')) is str and
             re.fullmatch('[0-9]{6,30}', value['uniqueId']), 'IQ1_METADATA')
        need('disabled' not in value or type(value['disabled']) is bool, 'IQ1_METADATA')
        return digest(value['uniqueId'].encode()), value.get('disabled', False)

    def step(self, index):
        self.stage = ('OWNER', 'PROJECT', 'BASELINE', 'ENABLE', 'ENABLED_READBACK')[index]
        if index == 0:
            need(q.strict_json(self.send(commands()['owner'])) ==
                 [{'account': m.OWNER, 'status': 'ACTIVE'}], 'IQ1_OWNER')
        elif index == 1:
            try:
                q.validate_recovery_project(SimpleNamespace(e={'projectNumberSha256': q.PROJECT_NUMBER_SHA256}),
                                            q.strict_json(self.send(commands()['project'])))
            except Exception as error:
                if isinstance(error, Stop):
                    raise
                raise Stop('IQ1_PROJECT') from None
        elif index == 2:
            uid, disabled = self.metadata()
            need(disabled is True, 'IQ1_INITIAL_STATE')
            self.uid = uid
        elif index == 3:
            self.gate()
            need(inv.read(self.journal.root / 'ready.json') == self.journal.binding(), 'IQ1_CUSTODY')
            need(self.uid is not None and not self.intent, 'IQ1_UID')
            self.journal.put('enable.json', {**self.journal.binding(), 'uidSha256': self.uid})
            self.intent = True
            self.adapter.change('identity', m.IDENTITY, True, {}, self.times['workEnd'])
            self.ack = True
        elif index == 4:
            need(self.adapter.readback('identity', m.IDENTITY, True, {}, self.times['workEnd']), 'IQ1_READBACK')
            self.enabled = True

    def finish_processes(self):
        if self.io is not None:
            try:
                self.process_closed = bool(self.io.close(self.times['cleanupEnd'])) and self.process_closed
            except BaseException:
                self.process_closed = False
            self.io = None

    def cleanup(self):
        self.phase = 'cleanup'
        if not self.intent:
            return
        need(self.process_closed, 'IQ1_PROCESS')
        self.gate()
        self.io = self.factory()
        self.step(0)
        self.step(1)
        self.stage = 'CLEANUP_UID'
        uid, _ = self.metadata()
        need(uid == self.uid, 'IQ1_UID')
        self.gate()
        self.journal.put('disable.json', {**self.journal.binding(), 'uidSha256': self.uid})
        self.stage = 'DISABLE'
        self.adapter.change('identity', m.IDENTITY, False, {}, self.times['cleanupEnd'])
        self.stage = 'DISABLED_READBACK'
        try:
            need(self.adapter.readback('identity', m.IDENTITY, False, {}, self.times['cleanupEnd']), 'IQ1_READBACK')
        except entry.c.Stop as error:
            reason = code(error)
            # This read returned through the owned transport/serializer. Retain
            # its failure, then use the already budgeted final UID observation.
            # Source/configuration/transport failures are not classified RB1
            # observations and must not enter this continuation path.
            if not reason.startswith('RUNTIME_IDENTITY_'):
                raise
            self.cleanup_readback_failure = reason
            self.cleanup_failure = reason
        self.stage = 'FINAL_UID'
        final_uid, disabled = self.metadata()
        need(final_uid == self.uid and disabled is True, 'IQ1_UID')
        self.restored = True


def run_worker(scope, journal, *, factory, guard, config, coordinate, clock=time.time):
    """One worker attempt. All injected dependencies mandatory; no native fallback."""
    driver = Boundary(scope, journal, factory=factory, guard=guard, config=config, clock=clock)
    journal.put('worker.json', journal.binding())
    try:
        driver.gate()
        driver.io = factory()
        journal.put('ready.json', journal.binding())
        coordinate(driver)
    except BaseException as error:
        driver.failure = code(error)
    finally:
        driver.finish_processes()
        main_stage = driver.stage
        try:
            driver.cleanup()
        except BaseException as error:
            driver.cleanup_failure = code(error)
        finally:
            driver.finish_processes()
    try:
        driver.config_closed = driver.config() == scope['configSha256']
        journal.inspect()
        private_absent = True  # whitelist contains public scope and safe receipts only
    except BaseException:
        private_absent = False
    try:
        guard(scope)
        source_closed = True
    except BaseException:
        source_closed = False
    residuals = []
    if driver.intent and not driver.restored:
        residuals.append('IDENTITY_RESTORATION_UNKNOWN')
    if driver.intent and not driver.ack:
        residuals.append('ENABLE_OUTCOME_UNKNOWN')
    if not driver.process_closed:
        residuals.append('PROCESS_CLOSURE_UNKNOWN')
    if not driver.config_closed:
        residuals.append('CONFIGURATION_CHANGED')
    if not private_absent:
        residuals.append('PRIVATE_INVENTORY_UNKNOWN')
    if not source_closed:
        residuals.append('SOURCE_CHANGED')
    if clock() >= driver.times['cleanupEnd'] or time.monotonic() >= driver.hard_end:
        residuals.append('CLEANUP_DEADLINE')
    qualified = driver.enabled and driver.restored and not residuals and not driver.failure and not driver.cleanup_failure
    result = {**journal.binding(), 'status': 'QUALIFIED_AND_CLOSED' if qualified else
              'CONTAINMENT_UNCONFIRMED' if residuals else 'FAILED_AND_CLOSED',
              'failure': driver.failure, 'cleanupFailure': driver.cleanup_failure,
              'cleanupReadbackFailure': driver.cleanup_readback_failure,
              'mainStage': main_stage, 'cleanupStage': driver.stage,
              'counts': driver.counts, 'uidSha256': driver.uid,
              'enabledReadback': driver.enabled, 'restorationReadback': driver.restored,
              'enableOutcomeUnknown': driver.intent and not driver.ack,
              'processClosed': driver.process_closed, 'configurationClosed': driver.config_closed,
              'sourceClosed': source_closed,
              'privateInputsAbsent': private_absent, 'residuals': residuals,
              'paymentObserved': False, 'finishedAt': clock()}
    journal.put('result.json', result)
    return result


def read_result(journal):
    """Missing/partial receipt after worker death is never a successful closeout."""
    try:
        journal.inspect()
        value = inv.read(journal.root / 'result.json')
        need(all(value.get(k) == v for k, v in journal.binding().items()), 'IQ1_CUSTODY')
        return value
    except BaseException:
        return {**journal.binding(), 'status': 'CONTAINMENT_UNCONFIRMED',
                'failure': 'IQ1_PROCESS', 'residuals': ['WORKER_RESULT_UNKNOWN'],
                'paymentObserved': False}


class NativeTransport:
    def __init__(self, scope):
        self.io = q.NativeIO(time.time, scope['operationId'])
        self.env = q.sdk_environment(os.environ)

    def run(self, argv, deadline):
        previous = signal.pthread_sigmask(signal.SIG_BLOCK, {signal.SIGINT, signal.SIGTERM})
        try:
            return self.io._owned_run(wrapped(argv), self.env, deadline)
        finally:
            signal.pthread_sigmask(signal.SIG_SETMASK, previous)

    def close(self, deadline):
        return self.io.close(deadline)


def sandbox_check(operation):
    io = q.NativeIO(time.time, operation)
    probe = ('import os,errno\ntry:os.fork()\n'
             'except OSError as e:print("DENIED" if e.errno==errno.EPERM else "FAILED")\n'
             'else:os._exit(9)\n')
    try:
        raw = io._owned_run([SANDBOX, '-p', PROFILE, p.PYTHON, '-I', '-B', '-c', probe],
                            {'PATH': '/usr/bin:/bin'}, time.time() + 8)
        need(raw.strip() == b'DENIED', 'IQ1_SANDBOX')
    finally:
        need(io.close(time.time() + 3), 'IQ1_PROCESS')


def coordinator(driver):
    """Main process has no provider interfaces. Worker owns it and every SDK child."""
    owned = q.NativeIO(time.time, driver.scope['operationId'])
    process = None
    selector = selectors.DefaultSelector()
    try:
        # Block catchable interrupts across spawn/registration; never adopt PIDs.
        previous = signal.pthread_sigmask(signal.SIG_BLOCK, {signal.SIGINT, signal.SIGTERM})
        try:
            process = subprocess.Popen([SANDBOX, '-p', PROFILE, p.PYTHON, '-I', '-B', '-c', COORDINATOR],
                                       stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                                       env={'PATH': '/usr/bin:/bin'}, start_new_session=True)
            owned.children.add(process)
        finally:
            signal.pthread_sigmask(signal.SIG_SETMASK, previous)
        os.set_blocking(process.stdout.fileno(), False)
        selector.register(process.stdout, selectors.EVENT_READ)
        for index in range(5):
            deadline = driver.gate()
            value = b''
            end = time.monotonic() + 8
            while not value.endswith(b'\n'):
                need(driver.clock() < deadline and time.monotonic() < end, 'IQ1_PROTOCOL')
                if selector.select(.05):
                    chunk = os.read(process.stdout.fileno(), 16)
                    need(chunk and len(value + chunk) <= 2, 'IQ1_PROTOCOL')
                    value += chunk
            need(value == f'{index}\n'.encode(), 'IQ1_PROTOCOL')
            driver.step(index)
            process.stdin.write(b'OK\n')
            process.stdin.flush()
        process.wait(timeout=2)
        need(process.returncode == 0, 'IQ1_PROTOCOL')
    finally:
        selector.close()
        try:
            if process and process.stdin:
                process.stdin.close()
        finally:
            if not owned.close(driver.times['cleanupEnd']):
                driver.process_closed = False


def native_main(argv):
    need(len(argv) == 2 and argv[0] in ('--run', '--worker'), 'IQ1_SCOPE')
    envelope = inv.read(Path(argv[1]))
    scope = authorize(envelope, time.time(), starting=True)
    need(configuration() == scope['configSha256'], 'IQ1_CONFIG')
    sandbox_check(scope['operationId'])
    root = root_for(scope)
    if argv[0] == '--run':
        journal = Journal(root, scope, create=True)
        journal.put('envelope.json', envelope)
        journal.put('launch.json', journal.binding())
        # Detached cleanup worker owns all future provider subprocess objects.
        subprocess.Popen([p.PYTHON, '-I', '-B', '-c',
                          'import sys,runpy;sys.path.insert(0,sys.argv[1]);sys.argv=sys.argv[2:];runpy.run_module("iq1_identity_boundary",run_name="__main__")',
                          str(HERE), 'iq1_identity_boundary.py', '--worker', str(root / 'envelope.json')],
                         stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                         start_new_session=True)
        return {'status': 'WORKER_LAUNCHED_NOT_QUALIFIED', 'operationId': scope['operationId']}
    need(Path(argv[1]) == root / 'envelope.json', 'IQ1_CUSTODY')
    journal = Journal(root, scope)
    need(inv.read(root / 'launch.json') == journal.binding(), 'IQ1_CUSTODY')
    with lease('/private/tmp/p08-iq1-runtime-identity.lock'):
        def interrupted(signum, frame):
            raise Stop('IQ1_INTERRUPTED')
        signal.signal(signal.SIGINT, interrupted)
        signal.signal(signal.SIGTERM, interrupted)
        return run_worker(scope, journal, factory=lambda: NativeTransport(scope),
                          guard=lambda s: source_guard(s, committed=False), config=configuration,
                          coordinate=coordinator)


if __name__ == '__main__':
    try:
        print(json.dumps(native_main(sys.argv[1:]), sort_keys=True))
    except BaseException as error:
        print(json.dumps({'status': 'IQ1_STOP', 'failure': code(error), 'qualified': False}))
        sys.exit(1)
