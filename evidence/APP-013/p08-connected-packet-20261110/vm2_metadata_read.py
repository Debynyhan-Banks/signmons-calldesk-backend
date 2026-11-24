"""VM2: exact metadata diagnosis; local preparation grants no live authority.

The native CLI requires a separately committed scope and owner decision.  Tests
inject the same CLI/cache/opener boundary without reading real credentials.
"""
import contextlib
import contextvars
import datetime
import json
import os
from pathlib import Path
import re
import signal
import sqlite3
import stat
import sys
import time
from types import SimpleNamespace
import urllib.error
import urllib.request

import sq1_signing_boundary as sq

q, m, acl, a, p = sq.q, sq.m, sq.acl, sq.a, sq.x.p
HERE = Path(__file__).resolve().parent
MANIFEST = HERE / 'vm2-source-manifest.json'
ACTION = 'VM2_EXACT_SECRET_VERSION_METADATA_ONCE'
DECISION = 'APPROVE_VM2_METADATA_READ_CACHE_SDK_EXCEPTION_AND_CLEANUP'
SDK_EXCEPTION = 'SDK_EXISTING_OWNER_REFRESH_CACHE_INTERNAL_RETRIES_NO_TOKEN_EXPORT'
SECRET = 'signmons-staging-p07-payment-database-url'
LIMITS = {'cli': 2, 'cache': 1, 'https': 1, 'sql': 0, 'mutations': 0}
MAX_OUTPUT = 65536
# Fixed non-default google.api.ErrorReason labels, reviewed 2026-11-24:
# https://raw.githubusercontent.com/googleapis/googleapis/master/google/api/error_reason.proto
# These labels supplement SQ1 only for the exact googleapis.com domain.
GOOGLE_ERROR_REASONS = frozenset(('SERVICE_DISABLED BILLING_DISABLED API_KEY_INVALID '
    'API_KEY_SERVICE_BLOCKED API_KEY_HTTP_REFERRER_BLOCKED API_KEY_IP_ADDRESS_BLOCKED '
    'API_KEY_ANDROID_APP_BLOCKED API_KEY_IOS_APP_BLOCKED RATE_LIMIT_EXCEEDED '
    'RESOURCE_QUOTA_EXCEEDED LOCATION_TAX_POLICY_VIOLATED USER_PROJECT_DENIED '
    'CONSUMER_SUSPENDED CONSUMER_INVALID SECURITY_POLICY_VIOLATED ACCESS_TOKEN_EXPIRED '
    'ACCESS_TOKEN_SCOPE_INSUFFICIENT ACCOUNT_STATE_INVALID ACCESS_TOKEN_TYPE_UNSUPPORTED '
    'CREDENTIALS_MISSING RESOURCE_PROJECT_INVALID SESSION_COOKIE_INVALID USER_BLOCKED_BY_ADMIN '
    'RESOURCE_USAGE_RESTRICTION_VIOLATED SYSTEM_PARAMETER_UNSUPPORTED ORG_RESTRICTION_VIOLATION '
    'ORG_RESTRICTION_HEADER_INVALID SERVICE_NOT_VISIBLE GCP_SUSPENDED LOCATION_POLICY_VIOLATED '
    'MISSING_ORIGIN OVERLOADED_CREDENTIALS LOCATION_ORG_POLICY_VIOLATED TLS_ORG_POLICY_VIOLATED '
    'EMULATOR_QUOTA_EXCEEDED CREDENTIAL_ANDROID_APP_INVALID IAM_PERMISSION_DENIED '
    'JWT_TOKEN_INVALID CREDENTIAL_TYPE_UNSUPPORTED ACCOUNT_TYPE_UNSUPPORTED '
    'ENDPOINT_USAGE_RESTRICTION_VIOLATED TLS_CIPHER_RESTRICTION_VIOLATED MCP_SERVER_DISABLED').split())
INTERRUPTED = contextvars.ContextVar('vm2_interrupted', default=False)
CODES = frozenset({'VM2_SCOPE', 'VM2_SOURCE', 'VM2_AUTHORITY', 'VM2_WINDOW', 'VM2_CUTOFF',
    'VM2_DEADLINE', 'VM2_CONFIG', 'VM2_CUSTODY', 'VM2_LIMIT', 'VM2_DESCRIPTOR',
    'VM2_CREDENTIAL', 'VM2_OUTPUT', 'VM2_REDIRECT', 'VM2_RESPONSE_CLOSE',
    'VM2_OWNER', 'VM2_PROJECT', 'VM2_RUNTIME', 'VM2_INTERRUPTED', 'VM2_HTTP',
    'VM2_UNKNOWN', 'VM2_ARGUMENTS', 'VM2_REPLAY'}) | q.CLI_FAILURE_CODES


class Stop(Exception):
    pass


def need(value, code):
    if not value:
        raise Stop(code)


def safe_code(error):
    if isinstance(error, (KeyboardInterrupt, SystemExit)):
        return 'VM2_INTERRUPTED'
    value = str(error) if isinstance(error, (Stop, m.Stop)) else ''
    return value if value in CODES else 'VM2_UNKNOWN'


def commands():
    rows = [next(row for row in q.cli_contract() if row['id'] == name)
            for name in ('owner', 'project')]
    for row in rows:
        q.validate_cli_descriptor(row)
    return json.loads(json.dumps(rows))


def root_for(operation_id):
    m.exact_uuid(operation_id, 'VM2_SCOPE')
    return Path('/private/tmp/p08-vm2-' + operation_id)


def validate_scope(scope, now, starting=True):
    fields = {'version', 'action', 'operationId', 'sourceCommit', 'manifestSha256',
              'configSha256', 'projectNumberSha256', 'commands', 'limits',
              'sdkException', 'allowanceUsd', 'automaticRetryAllowed', 'window'}
    need(type(scope) is dict and set(scope) == fields, 'VM2_SCOPE')
    need(type(scope['version']) is int and scope['version'] == 1 and scope['action'] == ACTION and
         scope['commands'] == commands() and scope['limits'] == LIMITS and
         all(type(v) is int for v in scope['limits'].values()) and
         scope['sdkException'] == SDK_EXCEPTION and type(scope['allowanceUsd']) is int and
         scope['allowanceUsd'] == 0 and scope['automaticRetryAllowed'] is False, 'VM2_SCOPE')
    root_for(scope['operationId'])
    need(type(scope['sourceCommit']) is str and re.fullmatch('[a-f0-9]{40}', scope['sourceCommit']), 'VM2_SOURCE')
    for name in ('manifestSha256', 'configSha256', 'projectNumberSha256'):
        need(type(scope[name]) is str and re.fullmatch('[a-f0-9]{64}', scope[name]), 'VM2_SOURCE')
    need(scope['projectNumberSha256'] == q.PROJECT_NUMBER_SHA256, 'VM2_PROJECT')
    need(type(scope['window']) is dict and set(scope['window']) ==
         {'start', 'cutoff', 'readEnd', 'closeoutEnd'}, 'VM2_WINDOW')
    t = {key: m.timestamp(value) for key, value in scope['window'].items()}
    need(t['start'] < t['cutoff'] < t['readEnd'] < t['closeoutEnd'] and
         t['readEnd'] - t['cutoff'] >= 90 and t['closeoutEnd'] - t['readEnd'] >= 120 and
         t['closeoutEnd'] - t['start'] <= 1200, 'VM2_WINDOW')
    need(t['start'] <= now < t['cutoff' if starting else 'readEnd'], 'VM2_CUTOFF' if starting else 'VM2_DEADLINE')
    return t


def source_guard(scope):
    """Use the current dependency guards; never resolve or inspect credentials."""
    need(MANIFEST.is_file() and not MANIFEST.is_symlink() and
         m.digest(MANIFEST.read_bytes()) == scope['manifestSha256'], 'VM2_SOURCE')
    manifest = sq.strict_json(MANIFEST.read_bytes())
    need(type(manifest) is dict and set(manifest) == {'version', 'files', 'dependencies'} and
         type(manifest['version']) is int and manifest['version'] == 1, 'VM2_SOURCE')
    expected = {str((HERE / n).relative_to(p.B)) for n in ('vm2_metadata_read.py', 'test_vm2_metadata_read.py')}
    need(type(manifest['files']) is dict and set(manifest['files']) == expected and
         type(manifest['dependencies']) is dict and set(manifest['dependencies']) ==
         {'sq1ManifestSha256', 'iq1ManifestSha256'}, 'VM2_SOURCE')
    for name, digest in manifest['files'].items():
        path = p.B / name
        need(path.is_file() and not path.is_symlink() and m.digest(path.read_bytes()) == digest and
             m.digest(a.committed(p.B, scope['sourceCommit'], name)) == digest, 'VM2_SOURCE')
    need(a.committed(p.B, scope['sourceCommit'], str(MANIFEST.relative_to(p.B))) ==
         MANIFEST.read_bytes(), 'VM2_SOURCE')
    sq.source_guard({'sourceCommit': scope['sourceCommit'],
                     'manifestSha256': manifest['dependencies']['sq1ManifestSha256'],
                     'iq1ManifestSha256': manifest['dependencies']['iq1ManifestSha256']})
    need((sys.platform, sys.version_info[:3], sqlite3.sqlite_version) == acl.LOCAL_RUNTIME,
         'VM2_RUNTIME')


def configuration():
    return sq.x.configuration()


def preflight(scope, clock=time.time, *, guard=None, configuration=None):
    t = validate_scope(scope, clock())
    (source_guard if guard is None else guard)(scope)
    current = globals()['configuration']() if configuration is None else configuration()
    need(current == scope['configSha256'], 'VM2_CONFIG')
    need(clock() < t['cutoff'], 'VM2_CUTOFF')
    return t


def authorize(commit, scope_path, decision_path, *, read_commit=None):
    need(type(commit) is str and re.fullmatch('[a-f0-9]{40}', commit), 'VM2_AUTHORITY')
    for name, suffix in ((scope_path, 'SCOPE'), (decision_path, 'APPROVAL')):
        need(type(name) is str and re.fullmatch('APP013_P08_VM2_' + suffix + r'_[0-9]{8}_[a-f0-9]{8}\.json', name),
             'VM2_AUTHORITY')
    get = a.committed if read_commit is None else read_commit
    scope = sq.strict_json(get(p.G, commit, scope_path))
    decision = sq.strict_json(get(p.G, commit, decision_path))
    need(type(decision) is dict and all(type(decision.get(k)) is bool for k in
         ('externalReadAuthorized', 'independentCleanupAuthorized', 'paymentAuthorized')),
         'VM2_AUTHORITY')
    need(decision == {'owner': 'Debynyhan Banks', 'decision': DECISION,
         'scopeSha256': m.digest(scope), 'operationId': scope['operationId'],
         'externalReadAuthorized': True, 'independentCleanupAuthorized': True,
         'sdkException': SDK_EXCEPTION, 'paymentAuthorized': False, 'allowanceUsd': 0} and
         type(decision['allowanceUsd']) is int, 'VM2_AUTHORITY')
    return scope


def metadata_descriptor(number):
    need(type(number) is str and re.fullmatch('[0-9]{6,20}', number) and
         m.digest(number) == q.PROJECT_NUMBER_SHA256, 'VM2_PROJECT')
    name = 'projects/' + number + '/secrets/' + SECRET + '/versions/1'
    return {'id': 'secret_version', 'method': 'GET',
            'url': 'https://secretmanager.googleapis.com/v1/' + name + '?fields=name,state', 'body': None}


def classify_metadata(status, raw, number):
    metadata_descriptor(number)
    observed = status if type(status) is int and 100 <= status <= 599 else None
    result = {'httpStatus': observed, 'outcome': 'UNKNOWN', 'state': 'UNKNOWN',
              'resourceMatched': False, 'failureCategory': 'RESPONSE_VALIDATION',
              'errorStatus': 'UNKNOWN', 'errorCode': 'UNKNOWN', 'errorInfo': [], 'errorEnvelopeValid': False}
    name = 'projects/' + number + '/secrets/' + SECRET + '/versions/1'
    try:
        need(observed is not None and not 300 <= observed < 400, 'VM2_OUTPUT')
        if observed != 200:
            need(not 200 <= observed < 300, 'VM2_OUTPUT')
            # SQ1 intentionally preserves partially validated status fields on
            # malformed detail.  They must not become VM2 completion evidence.
            value = sq.strict_json(raw)
            need(type(value) is dict and set(value) == {'error'} and type(value['error']) is dict, 'VM2_OUTPUT')
            error = value['error']
            need(set(error) <= {'code', 'message', 'status', 'details'} and
                 type(error.get('code')) is int and error['code'] == observed and
                 type(error.get('status')) is str and error['status'] in sq.ERROR_STATUSES and
                 ('message' not in error or type(error['message']) is str), 'VM2_OUTPUT')
            details = error.get('details', [])
            need(type(details) is list and len(details) <= 32, 'VM2_OUTPUT')
            for detail in details:
                need(type(detail) is dict, 'VM2_OUTPUT')
                if detail.get('@type') == 'type.googleapis.com/google.rpc.ErrorInfo':
                    need(set(detail) <= {'@type', 'reason', 'domain', 'metadata'} and
                         type(detail.get('reason')) is str and type(detail.get('domain')) is str and
                         type(detail.get('metadata', {})) is dict and all(type(k) is str and type(v) is str
                         for k, v in detail.get('metadata', {}).items()), 'VM2_OUTPUT')
            safe = sq.classify_sign_response(observed, raw, expected={
                'permission': 'secretmanager.versions.get', 'service': 'secretmanager.googleapis.com',
                'consumer': 'projects/' + number, 'target': name})
            # SQ1 collapses conflicting known reasons to one UNKNOWN row. Never
            # remap that row onto a raw detail; extend only its one-to-one result.
            if len(safe['errorInfo']) == len(details):
                for detail, row in zip(details, safe['errorInfo']):
                    if (detail.get('@type') == 'type.googleapis.com/google.rpc.ErrorInfo' and
                            detail.get('domain') == 'googleapis.com' and
                            detail.get('reason') in GOOGLE_ERROR_REASONS):
                        row['reason'] = detail['reason']
                known = {(row['reason'], row['domain']) for row in safe['errorInfo']
                         if row['reason'] != 'UNKNOWN' and row['domain'] != 'UNKNOWN'}
                if len(known) > 1:
                    safe.update(outcome='UNKNOWN', errorInfo=[{
                        'reason': 'UNKNOWN', 'domain': 'UNKNOWN',
                        'metadataMatches': {key: 'UNKNOWN' for key in
                                            ('permission', 'service', 'consumer', 'target')}}])
                elif len(known) == 1 and all(row['reason'] != 'UNKNOWN' and row['domain'] != 'UNKNOWN'
                                            for row in safe['errorInfo']):
                    safe['outcome'] = 'REFUSED'
            need(not INTERRUPTED.get(), 'VM2_INTERRUPTED')
            for key in ('outcome', 'failureCategory', 'errorStatus', 'errorCode', 'errorInfo'):
                result[key] = safe[key]
            result['errorEnvelopeValid'] = True
            return result
        value = sq.strict_json(raw)
        need(type(value) is dict and set(value) == {'name', 'state'} and value['name'] == name and
             type(value['state']) is str and value['state'] in {'ENABLED', 'DISABLED', 'DESTROYED'}, 'VM2_OUTPUT')
        result.update(outcome='METADATA_OBSERVED', state=value['state'], resourceMatched=True, failureCategory=None)
        return result
    except Exception:
        return result
    finally:
        raw = None


def bounded_metadata_request(number, token, deadline, *, clock, opener):
    """Exactly one GET with bounded safe output; no generic endpoint parameter."""
    descriptor = metadata_descriptor(number)
    try:
        acl.validate_token(token)
    except BaseException:
        raise Stop('VM2_CREDENTIAL') from None
    remaining = min(8, deadline - clock())
    need(remaining > 0, 'VM2_DEADLINE')
    response = request = raw = None
    chunks = []
    status = None
    failure = None
    result = None
    closed = True
    try:
        request = urllib.request.Request(descriptor['url'], method='GET', headers={
            'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json', 'x-goog-user-project': 'signmons'})
        with acl.http_deadline(remaining):
            try:
                response = opener.open(request, timeout=remaining)
            except urllib.error.HTTPError as error:
                response = error
            closed = False
            status = response.status
            need(type(status) is int and 100 <= status <= 599, 'VM2_OUTPUT')
            need(not 300 <= status < 400, 'VM2_REDIRECT')
            size = 0
            while True:
                part = response.read(min(8192, MAX_OUTPUT + 1 - size))
                need(type(part) is bytes, 'VM2_OUTPUT')
                if not part:
                    break
                size += len(part)
                need(size <= MAX_OUTPUT, 'VM2_OUTPUT')
                chunks.append(part)
                need(clock() < deadline, 'VM2_DEADLINE')
            raw = b''.join(chunks)
            chunks.clear()
            need(clock() < deadline, 'VM2_DEADLINE')
            result = classify_metadata(status, raw, number)
            need(not INTERRUPTED.get(), 'VM2_INTERRUPTED')
    except BaseException as error:
        failure = safe_code(error)
    finally:
        if response is not None:
            try:
                with acl.http_deadline(1):
                    response.close()
                closed = True
            except BaseException:
                closed = False
                failure = 'VM2_RESPONSE_CLOSE'
        token = raw = request = response = None
        chunks.clear()
    if result is None:
        result = {'httpStatus': status if type(status) is int and 100 <= status <= 599 else None,
                  'outcome': 'UNKNOWN', 'state': 'UNKNOWN', 'resourceMatched': False,
                  'failureCategory': 'TRANSPORT', 'errorStatus': 'UNKNOWN', 'errorCode': 'UNKNOWN', 'errorInfo': [],
                  'errorEnvelopeValid': False}
    if failure is not None:
        result.update(outcome='UNKNOWN', state='UNKNOWN', resourceMatched=False, failureCategory='TRANSPORT')
    return {**result, 'failure': failure, 'responseClosed': closed}


class Journal:
    def __init__(self, root):
        self.root = Path(root)
        self.root.mkdir(mode=0o700)
        self.identity = self.root.stat().st_dev, self.root.stat().st_ino
        self.hashes = {}
        self.inspect()

    def inspect(self):
        s = self.root.lstat()
        need(stat.S_ISDIR(s.st_mode) and not self.root.is_symlink() and stat.S_IMODE(s.st_mode) == 0o700 and
             s.st_uid == os.getuid() and (s.st_dev, s.st_ino) == self.identity, 'VM2_CUSTODY')
        need({x.name for x in self.root.iterdir()} == set(self.hashes), 'VM2_CUSTODY')
        for name, digest in self.hashes.items():
            path = self.root / name
            s = path.lstat()
            need(stat.S_ISREG(s.st_mode) and not path.is_symlink() and s.st_uid == os.getuid() and
                 s.st_nlink == 1 and stat.S_IMODE(s.st_mode) == 0o600 and s.st_size <= MAX_OUTPUT and
                 m.digest(path.read_bytes()) == digest, 'VM2_CUSTODY')

    def put(self, name, value):
        need(name in {'attempt.json', 'owner.json', 'project.json', 'cache.json', 'metadata.json',
                      'closeout.json', 'result.json', 'interruption.json'}, 'VM2_CUSTODY')
        self.inspect()
        m.reserve(self.root / name, value)
        self.hashes[name] = m.digest((self.root / name).read_bytes())
        self.inspect()


class TrackedIO(q.NativeIO):
    """Retain actual owned process handles for an independent absence readback."""
    def __init__(self, clock, operation_id):
        super().__init__(clock, operation_id)
        self.observed = set()

    def _finish(self, process, deadline):
        self.observed.add(process)
        return super()._finish(process, deadline)

    def verify_absent(self, deadline):
        if not self.closed or self.children or self.clock() >= deadline:
            return False
        for process in self.observed:
            if process.poll() is None:
                return False
            try:
                os.killpg(process.pid, 0)
                return False
            except ProcessLookupError:
                pass
            except OSError:
                return False
        return self.clock() < deadline


class NativeHooks:
    clock = staticmethod(time.time)
    configuration = staticmethod(configuration)

    def __init__(self, scope, *, refs=None):
        need(type(refs) is dict and set(refs) == {'commit', 'scope_path', 'decision_path'}, 'VM2_AUTHORITY')
        need(authorize(**refs) == scope, 'VM2_AUTHORITY')
        self.refs = dict(refs)
        self.scope = scope
        self.opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), sq.NoRedirect())

    def guard(self, scope):
        need(scope == self.scope and authorize(**self.refs) == scope, 'VM2_AUTHORITY')
        source_guard(scope)

    def io_factory(self):
        return TrackedIO(self.clock, self.scope['operationId'])

    def cache_reader(self, closeout_end):
        need(closeout_end == m.timestamp(self.scope['window']['closeoutEnd']), 'VM2_CREDENTIAL')
        return acl.read_cached_token(acl.CONFIG_ROOT, closeout_end, env=os.environ)


def run(scope, *, hooks, root=None):
    t = preflight(scope, hooks.clock, guard=hooks.guard, configuration=hooks.configuration)
    journal = Journal(root_for(scope['operationId']) if root is None else root)
    journal.put('attempt.json', {'operationId': scope['operationId'], 'scopeSha256': m.digest(scope),
                               'sourceCommit': scope['sourceCommit']})
    result = {'status': 'UNKNOWN', 'failure': None, 'ownerMatched': False, 'projectMatched': False,
              'counts': {'cli': 0, 'cache': 0, 'https': 0}, 'metadata': None, 'paymentAttempted': False}
    token = raw = project = value = io = None
    last = hooks.clock()

    def reserve(label, kind):
        nonlocal last
        now = hooks.clock()
        need(not INTERRUPTED.get(), 'VM2_INTERRUPTED')
        need(last <= now < t['readEnd'], 'VM2_DEADLINE')
        last = now
        hooks.guard(scope)
        need(hooks.configuration() == scope['configSha256'], 'VM2_CONFIG')
        need(result['counts'][kind] < LIMITS[kind], 'VM2_LIMIT')
        journal.put(label + '.json', {'reserved': True})
        result['counts'][kind] += 1
        need(not INTERRUPTED.get(), 'VM2_INTERRUPTED')
        need(last <= hooks.clock() < t['readEnd'], 'VM2_DEADLINE')

    try:
        need(hooks.clock() < t['cutoff'], 'VM2_CUTOFF')
        io = hooks.io_factory()
        env = q.sdk_environment(os.environ)
        # Dispatch original tuples: the existing exact descriptor validator
        # deliberately distinguishes them from JSON's public list form.
        for descriptor in (row for row in q.cli_contract() if row['id'] in ('owner', 'project')):
            reserve(descriptor['id'], 'cli')
            q.validate_cli_descriptor(descriptor)
            raw = io._owned_run(descriptor['argv'], env, min(t['readEnd'], hooks.clock() + 30))
            need(not INTERRUPTED.get(), 'VM2_INTERRUPTED')
            value = sq.strict_json(raw)
            raw = None
            if descriptor['id'] == 'owner':
                need(value == [{'account': m.OWNER, 'status': 'ACTIVE'}], 'VM2_OWNER')
                result['ownerMatched'] = True
            else:
                q.validate_recovery_project(SimpleNamespace(e={'projectNumberSha256': q.PROJECT_NUMBER_SHA256}), value)
                project = value['projectNumber']
                result['projectMatched'] = True
            value = None
        reserve('cache', 'cache')
        with acl.http_deadline(min(8, t['readEnd'] - hooks.clock())):
            token = hooks.cache_reader(t['closeoutEnd'])
        reserve('metadata', 'https')
        result['metadata'] = bounded_metadata_request(project, token, t['readEnd'], clock=hooks.clock, opener=hooks.opener)
        token = None
        result['failure'] = result['metadata']['failure']
        result['status'] = 'METADATA_DIAGNOSED' if result['failure'] is None and (
            result['metadata']['outcome'] == 'METADATA_OBSERVED' or
            result['metadata']['errorEnvelopeValid']) else 'UNKNOWN'
    except BaseException as error:
        result['failure'] = safe_code(error)
    finally:
        token = raw = project = value = None
        closure = {'processCleanupVerified': io is None, 'independentProcessAbsence': io is None,
                   'configurationUnchanged': False, 'responseClosed': result['metadata'] is None or
                   result['metadata']['responseClosed']}
        try:
            if io is not None:
                closure['processCleanupVerified'] = io.close(t['closeoutEnd']) is True
        except BaseException:
            pass
        try:
            if io is not None:
                closure['independentProcessAbsence'] = io.verify_absent(t['closeoutEnd']) is True
        except BaseException:
            pass
        try:
            closure['configurationUnchanged'] = hooks.configuration() == scope['configSha256']
        except BaseException:
            pass
        closure['onTime'] = last <= hooks.clock() < t['closeoutEnd']
        if INTERRUPTED.get():
            result['failure'] = 'VM2_INTERRUPTED'
            result['status'] = 'UNKNOWN'
        result['residuals'] = [] if all(closure.values()) else ['LOCAL_CLOSEOUT_UNCONFIRMED']
        if result['residuals']:
            result['status'] = 'UNKNOWN'
        result['closeout'] = closure
        result['completedAt'] = datetime.datetime.fromtimestamp(hooks.clock(), datetime.timezone.utc).isoformat()
        journal.put('closeout.json', closure)
        if INTERRUPTED.get():
            result.update(status='UNKNOWN', failure='VM2_INTERRUPTED')
        result_digest = m.digest(result)
        journal.put('result.json', result)
        if INTERRUPTED.get():
            # Preserve immutable results. A late interrupt writes a veto marker
            # that the authoritative readback must apply before interpretation.
            journal.put('interruption.json', {'failure': 'VM2_INTERRUPTED'})
            result.update(status='UNKNOWN', failure='VM2_INTERRUPTED')
    return {**result, 'resultSha256': result_digest}


def read_result(root, expected_digest, *, interruption_required=False):
    """Read-only result projection; an interruption marker always vetoes success."""
    root = Path(root)
    need(type(expected_digest) is str and re.fullmatch('[a-f0-9]{64}', expected_digest), 'VM2_CUSTODY')
    s = root.lstat()
    need(stat.S_ISDIR(s.st_mode) and not root.is_symlink() and s.st_uid == os.getuid() and
         stat.S_IMODE(s.st_mode) == 0o700, 'VM2_CUSTODY')
    result = q.private_json(root / 'result.json')
    need(m.digest(result) == expected_digest, 'VM2_CUSTODY')
    marker = root / 'interruption.json'
    need(type(interruption_required) is bool and
         (not interruption_required or marker.exists()), 'VM2_CUSTODY')
    if marker.exists() or marker.is_symlink():
        need(q.private_json(marker) == {'failure': 'VM2_INTERRUPTED'}, 'VM2_CUSTODY')
        result.update(status='UNKNOWN', failure='VM2_INTERRUPTED')
    return {**result, 'resultSha256': expected_digest}


def record_interruption(root, expected_digest):
    read_result(root, expected_digest)
    marker = Path(root) / 'interruption.json'
    try:
        m.reserve(marker, {'failure': 'VM2_INTERRUPTED'})
    except FileExistsError:
        need(q.private_json(marker) == {'failure': 'VM2_INTERRUPTED'}, 'VM2_CUSTODY')
    return read_result(root, expected_digest, interruption_required=True)


@contextlib.contextmanager
def interruption_handlers():
    previous = {}
    token = INTERRUPTED.set(False)
    def interrupted(signum, frame):
        INTERRUPTED.set(True)
        # Flag-only while bounded calls unwind: raising between Popen and the
        # existing transport's registration could lose the owned child handle.
        # Each dispatch gate and final result check observes this flag.
    try:
        for sig in (signal.SIGTERM, signal.SIGHUP, signal.SIGINT):
            previous[sig] = signal.signal(sig, interrupted)
        yield
    finally:
        for sig, handler in previous.items():
            signal.signal(sig, handler)
        INTERRUPTED.reset(token)


def execute(commit, scope_path, decision_path):
    scope = authorize(commit, scope_path, decision_path)
    preflight(scope)
    with sq.identity_lease(), interruption_handlers():
        result = run(scope, hooks=NativeHooks(scope, refs={
            'commit': commit, 'scope_path': scope_path, 'decision_path': decision_path}))
        result = read_result(root_for(scope['operationId']), result['resultSha256'],
                             interruption_required=result['failure'] == 'VM2_INTERRUPTED')
        if INTERRUPTED.get():
            result = record_interruption(root_for(scope['operationId']), result['resultSha256'])
    print(json.dumps(result, sort_keys=True))
    return 0 if result['status'] == 'METADATA_DIAGNOSED' and not result['residuals'] else 2


if __name__ == '__main__':
    try:
        need(len(sys.argv) == 4, 'VM2_ARGUMENTS')
        rc = execute(*sys.argv[1:])
    except BaseException as error:
        print(json.dumps({'status': 'VM2_STOPPED', 'failure': safe_code(error)}))
        rc = 2
    raise SystemExit(rc)
