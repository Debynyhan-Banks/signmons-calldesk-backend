"""KQ1 key-only qualification. Importing this module grants no external authority.

The injectable phase API has no native defaults. The CLI constructs native hooks
only after reading an exact, separately committed external owner decision.
"""
import copy
import datetime
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import signal
import sqlite3
import stat
import subprocess
import sys
import time
import urllib.request
from contextlib import contextmanager
from types import SimpleNamespace
from urllib.parse import quote

import packet as p
import kd1_cleanup as kd

q, m, a, acl = p.q, p.q.model, kd.a, kd.acl
_path = list(sys.path)
try:
    sys.path.insert(0, str(a.HERE))
    entry = a.load('p08-native-entry-local-20261101/source/entry.py', 'kq1_entry')
finally:
    sys.path[:] = _path
inv = sys.modules['private_inventory']
need, Stop = inv.need, inv.Stop
HERE = Path(__file__).resolve().parent
LIMITS = {'cli': 4, 'cache': 2, 'https': 25, 'mainHttps': 11,
          'cleanupHttps': 14, 'create': 1, 'delete': 1, 'sql': 0, 'child': 0}
DEPENDENCIES = ('packet.py', 'ks1_read.py', 'kd1_cleanup.py')
ACTION = 'QUALIFY_EXACT_KEY_BOUNDARY_ONCE'
DECISION = 'APPROVE_KQ1_EXACT_CREATE_KEYSTRING_CONDITIONAL_DELETE_SDK_CACHE_AND_CLEANUP'
SDK_EXCEPTION = 'SDK_EXISTING_OWNER_REFRESH_CACHE_INTERNAL_RETRIES_NO_TOKEN_EXPORT'
SAFE_CODES = frozenset({
    'AUTH_KEY_SCOPE', 'AUTH_KEY_OWNERSHIP_DRIFT', 'KEY_STRING_SHAPE',
    'KEY_CREATE_UNCONFIRMED', 'KEY_METADATA_UNCONFIRMED', 'KEY_OPERATION_UNCONFIRMED',
    'KQ1_SERVICE_DISABLED', 'KQ1_KEY_COLLISION', 'KQ1_POSTCREATE_UID',
    'KQ1_OWNER', 'KQ1_PROJECT', 'KQ1_SOURCE', 'KQ1_CONFIG', 'KQ1_CREDENTIAL',
    'KQ1_CLOCK', 'KQ1_DEADLINE', 'KQ1_BUDGET', 'KQ1_DESCRIPTOR',
    'KQ1_PROVENANCE', 'KQ1_UID', 'KQ1_REPLAY', 'KQ1_INTERRUPTED',
    'KQ1_SINK', 'KQ1_PRIVATE', 'KQ1_UNCOMMITTED_STATE', 'KQ1_PROCESS',
})


def root_for(operation_id):
    m.exact_uuid(operation_id, 'KQ1_OPERATION')
    return Path('/private/tmp/p08-coordinator-' + operation_id)


def validate_scope(scope, now, phase):
    fields = {'version', 'action', 'operationId', 'sourceCommit', 'sourceManifestSha256',
              'nativeManifestSha256', 'sdkFilesSha256', 'operatorSha256', 'dependencySha256',
              'projectNumberSha256', 'commands', 'window', 'limits', 'sdkException',
              'allowanceUsd', 'automaticRetryAllowed', 'restrictions'}
    need(isinstance(scope, dict) and set(scope) == fields, 'KQ1_SCOPE')
    need(type(scope['version']) is int and scope['version'] == 1 and scope['action'] == ACTION and
         scope['limits'] == LIMITS and scope['sdkException'] == SDK_EXCEPTION and
         type(scope['allowanceUsd']) is int and scope['allowanceUsd'] == 0 and
         scope['automaticRetryAllowed'] is False and
         scope['restrictions'] == kd.key.RESTRICTIONS, 'KQ1_SCOPE')
    need(all(type(v) is int for v in scope['limits'].values()), 'KQ1_SCOPE')
    root_for(scope['operationId'])
    need(re.fullmatch('[a-f0-9]{40}', scope['sourceCommit'] or ''), 'KQ1_SOURCE')
    for field in ('sourceManifestSha256', 'nativeManifestSha256', 'sdkFilesSha256',
                  'operatorSha256', 'projectNumberSha256'):
        need(type(scope[field]) is str and re.fullmatch('[a-f0-9]{64}', scope[field]), 'KQ1_SOURCE')
    need(scope['projectNumberSha256'] == q.PROJECT_NUMBER_SHA256, 'KQ1_PROJECT')
    need(isinstance(scope['dependencySha256'], dict) and
         set(scope['dependencySha256']) == set(DEPENDENCIES) and
         all(type(v) is str and re.fullmatch('[a-f0-9]{64}', v)
             for v in scope['dependencySha256'].values()), 'KQ1_SOURCE')
    commands = [d for name in ('owner', 'project') for d in q.current_cli_contract() if d['id'] == name]
    need(scope['commands'] == json.loads(json.dumps(commands)), 'KQ1_COMMANDS')
    for descriptor in commands:
        q.validate_cli_descriptor(descriptor)
    need(isinstance(scope['window'], dict) and set(scope['window']) ==
         {'start', 'cutoff', 'workEnd', 'cleanupEnd', 'purgeEnd'}, 'KQ1_WINDOW')
    times = {name: m.timestamp(value) for name, value in scope['window'].items()}
    need(times['start'] < times['cutoff'] < times['workEnd'] < times['cleanupEnd'] < times['purgeEnd'] and
         times['cleanupEnd'] - times['workEnd'] >= 360 and
         times['purgeEnd'] - times['cleanupEnd'] >= 60 and
         times['purgeEnd'] - times['start'] <= 3600, 'KQ1_WINDOW')
    need(phase in ('main', 'cleanup', 'purge'), 'KQ1_PHASE')
    if phase == 'main':
        need(times['start'] <= now < times['cutoff'] and times['workEnd'] - now >= 240, 'KQ1_DEADLINE')
    return times


def source_guard(scope):
    """Local files/configuration only; never reads a token or invokes gcloud."""
    manifest = m.verify_local_manifest()
    m.verify_locked_sources()
    native = a.verify_sources()
    q.verify_qualification_sources(scope['sourceCommit'], manifest, a.committed)
    need(scope['sourceManifestSha256'] == q.source_manifest_sha256() and
         scope['nativeManifestSha256'] == a.digest((a.HERE / 'source-manifest.json').read_bytes()) and
         scope['sdkFilesSha256'] == m.digest(manifest['sdkReview']['files']), 'KQ1_SOURCE')
    files = {str((a.HERE / name).relative_to(p.B)): digest for name, digest in native['files'].items()}
    files.update({'evidence/APP-013/' + name: digest for name, digest in native['lockedSources'].items()})
    files[str(Path(__file__).resolve().relative_to(p.B))] = scope['operatorSha256']
    files.update({str((HERE / name).relative_to(p.B)): digest
                  for name, digest in scope['dependencySha256'].items()})
    for name, digest in files.items():
        path = p.B / name
        need(not path.is_symlink() and path.is_file() and a.digest(path.read_bytes()) == digest and
             a.digest(a.committed(p.B, scope['sourceCommit'], name)) == digest, 'KQ1_SOURCE')
    for name, digest in manifest['sdkReview']['files'].items():
        need(m.digest(Path(name).read_bytes()) == digest, 'KQ1_SOURCE')
    need((sys.platform, sys.version_info[:3], sqlite3.sqlite_version) == acl.LOCAL_RUNTIME, 'KQ1_SOURCE')
    q.sdk_environment(os.environ)
    acl.config_snapshot(acl.CONFIG_ROOT, os.environ)


def _private(root, operation, identity=None):
    inv.inspect(root, operation)
    current = root.lstat()
    need(current.st_uid == os.getuid() and
         (identity is None or [current.st_dev, current.st_ino] == identity), 'KQ1_PRIVATE')
    for path in root.iterdir():
        need(path.lstat().st_uid == os.getuid(), 'KQ1_PRIVATE')
    return [current.st_dev, current.st_ino]


def _purge(root, operation, identity):
    # Unlike the full native cleanup, local retention must also close after an
    # interrupted safe-journal publish. Leave that safe intent as UNKNOWN evidence.
    st = root.lstat()
    need(root == root_for(operation) and root.resolve() == root and stat.S_ISDIR(st.st_mode) and
         stat.S_IMODE(st.st_mode) == 0o700 and st.st_uid == os.getuid() and
         [st.st_dev, st.st_ino] == identity, 'KQ1_PRIVATE')
    absent = True
    for name in inv.PRIVATE:
        path = root / name
        if os.path.lexists(path):
            st = path.lstat()
            if (stat.S_ISREG(st.st_mode) and stat.S_IMODE(st.st_mode) == 0o600 and
                    st.st_uid == os.getuid() and st.st_nlink == 1):
                path.unlink()
            else: absent = False
    return absent and all(not os.path.lexists(root / name) for name in inv.PRIVATE)


def _code(error):
    return (error.args[0] if type(error) in (Stop, entry.c.Stop, entry.bridge.packet.Stop) and
            len(error.args) == 1 and type(error.args[0]) is str and error.args[0] in SAFE_CODES
            else 'KQ1_INTERRUPTED' if isinstance(error, (KeyboardInterrupt, SystemExit))
            else 'KQ1_OPERATION_UNCONFIRMED')


@contextmanager
def _no_proxies():
    # The inherited implementation resolves this standard-library function at
    # call time. KQ runs on one main thread under http_deadline; restore it even
    # on interruption. The original transport and response-finally are unchanged.
    original = urllib.request.build_opener
    def build(*handlers):
        return original(urllib.request.ProxyHandler({}), *handlers)
    urllib.request.build_opener = build
    try: yield
    finally: urllib.request.build_opener = original


class _NativeHTTPS(entry.NativeIO):
    """Only the inherited body/response transport is enabled; no SDK acquisition."""
    def __init__(self, driver):
        self.driver = driver
        self.cleanup = driver.phase == 'cleanup'
        self.cap = SimpleNamespace(plan={'project': m.PROJECT}, clock=driver.clock,
                                   spend=lambda *_: driver.transport_gate(), gate=lambda *_: driver.transport_gate())
        self.token = ''

    def ensure_owner(self):
        self.driver.credential_gate()
        self.token = self.driver.token

    def cli(self, *_): raise Stop('KQ1_DESCRIPTOR')
    cloud = sql = credentials = child = cli


class Driver:
    def __init__(self, scope, phase, *, owned_io_factory, cache_reader, source_guard,
                 config_snapshot, clock, pause):
        self.s, self.phase, self.clock, self.pause = copy.deepcopy(scope), phase, clock, pause
        self.t = validate_scope(scope, clock(), phase)
        self.root = root_for(scope['operationId'])
        self.source_guard, self.snapshot = source_guard, config_snapshot
        self.cache_reader, self.io_factory = cache_reader, owned_io_factory
        self.io = self.token = self.config = self.plan = self.ports = self.engine = None
        self.lock = None
        self.abort = False
        self.busy = False
        self.last = clock()
        self.stage = 'PREPARATION'
        self.qualified_through = None
        self.identity = None
        self.j = None
        self.request_end = None
        self.bound = False

    def open(self):
        if self.phase == 'main':
            self.root.mkdir(mode=0o700)
        self.identity = _private(self.root, self.s['operationId'])
        self.lock = os.open(self.root / 'entry.lock', os.O_RDWR | os.O_NOFOLLOW |
                            (os.O_CREAT if self.phase == 'main' else 0), 0o600)
        try:
            fcntl.flock(self.lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            os.close(self.lock); self.lock = None
            raise Stop('KQ1_REPLAY') from None
        _private(self.root, self.s['operationId'], self.identity)
        identity = {'operationId': self.s['operationId'], 'scopeSha256': a.digest(self.s),
                    'sourceCommit': self.s['sourceCommit'], 'rootIdentity': self.identity}
        if self.phase == 'main':
            inv.reserve(self.root / 'attempt.json', identity)
            self.bound = True
            self.j = {**identity, 'counts': {'cli': 0, 'cache': 0, 'https': 0,
                       'mainHttps': 0, 'cleanupHttps': 0}, 'phases': {}, 'requests': {},
                      'keyCreateAttempted': False, 'keyDeleteAttempted': False,
                      'keyUidSha256': None, 'unknown': [], 'matches': {},
                      'boundaryReached': False, 'mainFailure': None, 'keyState': 'UNOBSERVED',
                      'lastObservedAt': self.last}
        else:
            need(inv.read(self.root / 'attempt.json') == identity, 'KQ1_PRIVATE')
            self.bound = True
            self.j = inv.read(self.root / 'journal.json')
            try:
                need(all(self.j.get(k) == v for k, v in identity.items()), 'KQ1_PRIVATE')
                self.validate_journal()
            except BaseException:
                self.j = None
                raise
            need(type(self.j.get('lastObservedAt')) in (int, float) and
                 self.last >= self.j['lastObservedAt'], 'KQ1_CLOCK')
        need(not os.path.lexists(self.root / 'journal-next.json'), 'KQ1_UNCOMMITTED_STATE')
        need(self.phase not in self.j['phases'], 'KQ1_REPLAY')
        self.j['phases'][self.phase] = {'started': True, 'closed': False}
        self.save()

    def validate_journal(self):
        required = {'operationId', 'scopeSha256', 'sourceCommit', 'rootIdentity', 'counts', 'phases',
                    'requests', 'keyCreateAttempted', 'keyDeleteAttempted', 'keyUidSha256', 'unknown',
                    'matches', 'boundaryReached', 'mainFailure', 'keyState', 'lastObservedAt'}
        optional = {'cleanupMutationFailure', 'cleanupReadbackFailure', 'keyUnownedObservation'}
        need(required <= set(self.j) <= required | optional, 'KQ1_PRIVATE')
        counts = self.j['counts']
        need(type(counts) is dict and set(counts) == {'cli', 'cache', 'https', 'mainHttps', 'cleanupHttps'} and
             all(type(v) is int and 0 <= v <= LIMITS[k] for k, v in counts.items()) and
             counts['https'] == counts['mainHttps'] + counts['cleanupHttps'], 'KQ1_PRIVATE')
        need(type(self.j['phases']) is dict and set(self.j['phases']) <= {'main', 'cleanup', 'purge'} and
             all(type(v) is dict and set(v) == {'started', 'closed'} and v['started'] is True and
                 type(v['closed']) is bool for v in self.j['phases'].values()), 'KQ1_PRIVATE')
        maxima = {'service': 1, 'absence': 1, 'create': 1, 'createPoll': 5, 'postcreate': 1,
                  'authenticate': 1, 'keyString': 1, 'recoverPoll': 6, 'unownedRead': 1,
                  'cleanupRead': 1, 'delete': 1, 'deletePoll': 5, 'finalRead': 1}
        need(type(self.j['requests']) is dict and set(self.j['requests']) <= set(maxima) and
             all(type(v) is int and 0 <= v <= maxima[k] for k, v in self.j['requests'].items()) and
             sum(self.j['requests'].values()) == counts['https'], 'KQ1_PRIVATE')
        need(all(type(self.j[k]) is bool for k in ('keyCreateAttempted', 'keyDeleteAttempted', 'boundaryReached')) and
             self.j['keyCreateAttempted'] is bool(self.j['requests'].get('create')) and
             self.j['keyDeleteAttempted'] is bool(self.j['requests'].get('delete')), 'KQ1_PRIVATE')
        need(self.j['keyUidSha256'] is None or (type(self.j['keyUidSha256']) is str and
             re.fullmatch('[a-f0-9]{64}', self.j['keyUidSha256'])), 'KQ1_PRIVATE')
        need(type(self.j['unknown']) is list and set(self.j['unknown']) <= {'KEY_CREATE', 'KEY_LIFECYCLE_UNCONFIRMED'}, 'KQ1_PRIVATE')
        need(type(self.j['matches']) is dict and set(self.j['matches']) <= {'postcreate', 'authenticate'} and
             all(type(v) is dict and set(v) == {'uid', 'etag', 'active'} and all(type(x) is bool for x in v.values())
                 for v in self.j['matches'].values()), 'KQ1_PRIVATE')
        need(self.j['mainFailure'] is None or type(self.j['mainFailure']) is str and
             self.j['mainFailure'] in SAFE_CODES | {'KQ1_OPERATION_UNCONFIRMED'}, 'KQ1_PRIVATE')
        need(self.j['keyState'] in {'UNOBSERVED', 'NOT_CREATED', 'UNKNOWN', 'ABSENT_AT_READ',
             'CONTROL_PLANE_DELETED', 'PRESENT_UNRESOLVED'}, 'KQ1_PRIVATE')
        need(self.j.get('cleanupMutationFailure') in (None, 'INTERRUPTED', 'DELETE_OR_PRECHECK_UNCONFIRMED') and
             self.j.get('cleanupReadbackFailure') in (None, 'FINAL_READ_UNCONFIRMED') and
             self.j.get('keyUnownedObservation') in (None, 'ABSENT', 'PRESENT'), 'KQ1_PRIVATE')

    def save(self):
        _private(self.root, self.s['operationId'], self.identity)
        observed = self.clock()
        need(observed >= self.last, 'KQ1_CLOCK'); self.last = observed
        self.j['lastObservedAt'] = self.last
        temp = self.root / 'journal-next.json'
        inv.reserve(temp, self.j)
        os.replace(temp, self.root / 'journal.json')
        fd = os.open(self.root, os.O_RDONLY | os.O_DIRECTORY)
        try: os.fsync(fd)
        finally: os.close(fd)

    def gate(self):
        now = self.clock()
        need(now >= self.last, 'KQ1_CLOCK'); self.last = now
        end = self.t['workEnd'] if self.phase == 'main' else self.t['cleanupEnd'] - 10
        need(self.t['start'] <= now < end, 'KQ1_DEADLINE')
        need(not self.abort or self.phase == 'cleanup', 'KQ1_INTERRUPTED')
        _private(self.root, self.s['operationId'], self.identity)
        return end

    def transport_gate(self):
        end = self.gate()
        if self.request_end is not None: end = min(end, self.request_end)
        need(self.clock() < end, 'KQ1_DEADLINE')
        return end

    def spend(self, label):
        self.gate()
        counts = self.j['counts']
        need(counts[label] < LIMITS[label], 'KQ1_BUDGET')
        counts[label] += 1
        self.save()

    def credential_gate(self, mutation=False):
        self.gate()
        need(type(self.token) is str and 20 <= len(self.token) <= 4096 and
             not any(c.isspace() for c in self.token) and
             self.qualified_through == self.t['purgeEnd'] and self.clock() < self.qualified_through,
             'KQ1_CREDENTIAL')
        need(self.snapshot() == self.config, 'KQ1_CONFIG')
        if mutation:
            self.check_sources()

    def check_sources(self):
        with acl.http_deadline(max(.001, min(8, self.gate() - self.clock()))):
            self.source_guard(self.s)
        self.gate()

    def qualify_owner(self):
        self.check_sources()
        self.config = self.snapshot()
        self.io = self.io_factory(self.clock, self.s['operationId'])
        project = raw = None
        env = q.sdk_environment(os.environ)
        for descriptor in self.s['commands']:
            self.spend('cli')
            self.busy = True
            try:
                raw = self.io._owned_run(descriptor['argv'], env, min(self.gate(), self.clock() + 30))
            finally:
                self.busy = False
            self.gate()
            value = q.strict_json(raw); raw = None
            if descriptor['id'] == 'owner':
                need(value == [{'account': m.OWNER, 'status': 'ACTIVE'}], 'KQ1_OWNER')
            else:
                q.validate_recovery_project(SimpleNamespace(e={'projectNumberSha256': self.s['projectNumberSha256']}), value)
                project = value
        need(project is not None, 'KQ1_PROJECT')
        self.plan = {'mode': 'LOCAL_INTEGRATED_PACKET_ONLY', 'externalActionAuthorized': False,
                     'project': m.PROJECT, 'ownerPrincipal': m.OWNER,
                     'operationId': self.s['operationId'], 'keyId': 'signmons-p08-' + self.s['operationId'].replace('-', ''),
                     'projectNumber': project['projectNumber'],
                     'projectNumberSha256': hashlib.sha256(project['projectNumber'].encode()).hexdigest(),
                     'window': self.s['window']}
        envelope = {'version': 1, 'scopeSha256': a.digest(self.s), 'plan': self.plan}
        if self.phase == 'main': inv.reserve(self.root / 'envelope.json', envelope)
        else: need(inv.read(self.root / 'envelope.json') == envelope, 'KQ1_PRIVATE')
        self.spend('cache')
        with acl.http_deadline(max(.001, min(8, self.gate() - self.clock()))):
            self.token = self.cache_reader(self.t['purgeEnd'])
        self.qualified_through = self.t['purgeEnd']
        self.credential_gate()
        cap = SimpleNamespace(root=self.root, plan=self.plan, clock=self.clock, times=self.t,
                              e={'sourceCommit': self.s['sourceCommit']}, envelope_hash=a.digest(self.s),
                              coordinator=self, gate=lambda *_: self.gate())
        io = SimpleNamespace(cleanup=self.phase == 'cleanup', cli=self.deny, https=self.dispatch)
        self.ports = entry.Ports(cap, io, None, None)
        self.ports.pause = self.pause
        self.ports.auth = self.receipt_sink
        original_get = self.ports.key_get
        def observed_get():
            value = original_get()
            if self.stage in ('postcreate', 'authenticate') and isinstance(value, dict):
                self.j['matches'][self.stage] = {
                    'uid': value['uid'] == self.ports.owned_uid,
                    'etag': value['etag'] == self.ports.owned_etag,
                    'active': value['deleted'] is False}
                self.save()
            return value
        self.ports.key_get = observed_get

    @staticmethod
    def deny(*_, **__): raise Stop('KQ1_DESCRIPTOR')

    def receipt_sink(self, receipt):
        self.gate()
        fields = {'operationId', 'keyResource', 'uid', 'etag', 'displayName', 'restrictions',
                  'keyStringSha256', 'createdInOperation', 'deleted', 'ownedAt'}
        need(type(receipt) is dict and set(receipt) == fields and
             receipt['operationId'] == self.s['operationId'] and receipt['keyResource'] == self.ports.key_resource and
             receipt['uid'] == self.ports.owned_uid and receipt['etag'] == self.ports.owned_etag and
             receipt['displayName'] == 'Signmons P08 ' + self.s['operationId'] and
             receipt['restrictions'] == kd.key.RESTRICTIONS and receipt['createdInOperation'] is True and
             receipt['deleted'] is False and type(receipt['keyStringSha256']) is str and
             re.fullmatch('[a-f0-9]{64}', receipt['keyStringSha256']), 'KQ1_SINK')
        self.j['boundaryReached'] = True
        self.save()
        receipt.clear()
        return {'status': 'KEY_BOUNDARY_REACHED'}

    def dispatch(self, descriptor, deadline=None):
        self.gate()
        self.request_end = (deadline if deadline is not None else
                            self.t['cleanupEnd'] - 70 if self.phase == 'cleanup' else self.t['workEnd'])
        self.transport_gate()
        need(isinstance(descriptor, dict) and set(descriptor) ==
             {'method', 'url', 'body', 'timeoutSeconds', 'redirect'} and
             descriptor['timeoutSeconds'] == 8 and descriptor['redirect'] == 'error', 'KQ1_DESCRIPTOR')
        method, url, body = descriptor['method'], descriptor['url'], descriptor['body']
        base = 'https://apikeys.googleapis.com/v2/' + self.ports.key_resource
        service = 'https://serviceusage.googleapis.com/v1/' + self.ports.key_service
        label = None
        if self.phase == 'main':
            if self.stage == 'service' and (method, url, body) == ('GET', service, None): label = 'service'
            elif self.stage in ('absence', 'postcreate', 'authenticate') and (method, url, body) == ('GET', base, None): label = self.stage
            elif self.stage == 'authenticate' and (method, url, body) == ('GET', base + '/keyString', None): label = 'keyString'
            elif self.stage == 'create' and method == 'POST':
                expected = json.dumps({'displayName': 'Signmons P08 ' + self.s['operationId'],
                                      'restrictions': kd.key.RESTRICTIONS}, sort_keys=True, separators=(',', ':'))
                if (url, body) == ('https://apikeys.googleapis.com/v2/projects/' + self.plan['projectNumber'] +
                                  '/locations/global/keys?keyId=' + self.plan['keyId'], expected): label = 'create'
            elif self.stage == 'create' and method == 'GET' and body is None:
                operation = self.ports._load_lifecycle()['createOperation']
                if operation and url == 'https://apikeys.googleapis.com/v2/' + operation: label = 'createPoll'
        elif self.stage == 'recover' and method == 'GET' and body is None:
            operation = self.ports._load_lifecycle()['createOperation']
            if operation and url == 'https://apikeys.googleapis.com/v2/' + operation: label = 'recoverPoll'
            elif not operation and url == base: label = 'unownedRead'
        elif self.stage == 'containment':
            if (method, url, body) == ('GET', base, None): label = 'finalRead' if self.engine.final else 'cleanupRead'
            elif method == 'DELETE' and self.engine.etag and (url, body) == (base + '?etag=' + quote(self.engine.etag, safe=''), None): label = 'delete'
            elif method == 'GET' and body is None and self.engine.waiter.j.get('deleteOperation') and url == 'https://apikeys.googleapis.com/v2/' + self.engine.waiter.j['deleteOperation']: label = 'deletePoll'
        need(label is not None, 'KQ1_DESCRIPTOR')
        maxima = {'createPoll': 5, 'recoverPoll': 6, 'deletePoll': 5}
        used = self.j['requests'].get(label, 0)
        need(used < maxima.get(label, 1), 'KQ1_BUDGET')
        mutation = label in ('create', 'delete')
        self.credential_gate(mutation)
        pool = 'mainHttps' if self.phase == 'main' else 'cleanupHttps'
        need(self.j['counts'][pool] < LIMITS[pool] and self.j['counts']['https'] < 25, 'KQ1_BUDGET')
        if label == 'create':
            need(not self.j['keyCreateAttempted'], 'KQ1_REPLAY'); self.j['keyCreateAttempted'] = True
        if label == 'delete':
            need(not self.j['keyDeleteAttempted'] and self.j['keyUidSha256'] is not None, 'KQ1_REPLAY')
            self.j['keyDeleteAttempted'] = True
        self.j['requests'][label] = used + 1
        self.j['counts'][pool] += 1; self.j['counts']['https'] += 1
        self.save()
        native = _NativeHTTPS(self)
        try:
            with acl.http_deadline(max(.001, min(8, self.transport_gate() - self.clock()))), _no_proxies():
                response = native.https(descriptor)
            self.transport_gate()
            if self.phase == 'cleanup' and label in ('cleanupRead', 'finalRead'):
                parsed = kd.key.RequestAdapter(self.plan, transport=lambda _: response).key_get()
                if parsed != {'status': 'NOT_FOUND'}:
                    kd.metadata(self.plan, parsed, (self.t['start'], self.t['workEnd']))
                    need(self.j['keyUidSha256'] is not None and
                         hashlib.sha256(parsed['uid'].encode()).hexdigest() == self.j['keyUidSha256'], 'KQ1_UID')
                parsed = None
            return response
        finally:
            native.token = ''
            self.request_end = None

    def main(self):
        self.qualify_owner()
        self.stage = 'service'
        need(self.ports.api_keys_state() == 'ENABLED', 'KQ1_SERVICE_DISABLED')
        self.stage = 'absence'
        need(self.ports.key_get() == 'NOT_FOUND', 'KQ1_KEY_COLLISION')
        self.stage = 'create'
        value = self.ports.key_create(self.ports.key_resource, kd.key.RESTRICTIONS)
        probe = SimpleNamespace(modules={'bridge': entry.bridge}, access=self.ports, plan=self.plan)
        uid_hash = entry.c.Coordinator.key_metadata(probe, value, False)
        self.stage = 'postcreate'
        need(entry.c.Coordinator.key_metadata(probe, self.ports.key_get(), False) == uid_hash, 'KQ1_POSTCREATE_UID')
        self.stage = 'authenticate'
        need(self.ports.authenticate(self.ports.key_resource) == {'status': 'KEY_BOUNDARY_REACHED'}, 'KQ1_SINK')

    def cleanup(self):
        if not self.j['keyCreateAttempted']:
            self.j['keyState'] = 'NOT_CREATED'; self.save(); return
        self.qualify_owner()
        self.stage = 'recover'
        self.ports.recover_key()
        need(self.ports.owned_uid is not None and self.j['keyUidSha256'] ==
             hashlib.sha256(self.ports.owned_uid.encode()).hexdigest(), 'KQ1_PROVENANCE')
        self.stage = 'containment'
        # Native key_delete is intentionally unreachable: the approved KD path
        # adopts only the same proven UID's currently validated etag.
        self.engine = kd.Cleanup(self.plan, (self.t['start'], self.t['workEnd']),
            {'workEnd': self.t['cleanupEnd'] - 70, 'readEnd': self.t['cleanupEnd'] - 10},
            lambda descriptor, deadline: self.dispatch(descriptor, deadline), lambda _: None,
            clock=self.clock, pause=self.pause)
        result = self.engine.run()
        self.j['keyState'] = result['status']
        self.j['cleanupMutationFailure'] = result['mutationFailure']
        self.j['cleanupReadbackFailure'] = result['readbackFailure']
        self.save()


def run_phase(scope, phase, *, owned_io_factory, cache_reader, source_guard,
              config_snapshot, clock=time.time, pause=time.sleep):
    """Explicit injected seams only. Native hooks are created solely by execute()."""
    driver = Driver(scope, phase, owned_io_factory=owned_io_factory, cache_reader=cache_reader,
                    source_guard=source_guard, config_snapshot=config_snapshot, clock=clock, pause=pause)
    failure = None
    result = {'status': 'KQ1_UNCONFIRMED', 'operationId': scope['operationId'],
              'scopeSha256': a.digest(scope), 'failure': None, 'privateInputsAbsent': False,
              'providerContainmentConfirmed': False, 'authenticationObserved': False,
              'paymentObserved': False, 'residuals': []}
    previous = {}
    def stop(*_):
        driver.abort = True
        if not driver.busy and phase == 'main': raise Stop('KQ1_INTERRUPTED')
    try:
        driver.open()
        if phase != 'purge':
            previous = {sig: signal.getsignal(sig) for sig in (signal.SIGINT, signal.SIGTERM)}
            for sig in previous: signal.signal(sig, stop)
            (driver.main if phase == 'main' else driver.cleanup)()
    except BaseException as error:
        failure = _code(error)
    finally:
        if driver.lock is not None:
            driver.busy = True
            result['processCleanupVerified'] = driver.io is None
            if driver.io is not None:
                try: result['processCleanupVerified'] = driver.io.close(min(driver.t['cleanupEnd'] - 3, clock() + 5)) is True
                except BaseException: result['processCleanupVerified'] = False
            driver.token = None; driver.qualified_through = None
            try: result['configurationUnchanged'] = driver.config is None or driver.snapshot() == driver.config
            except BaseException: result['configurationUnchanged'] = False
            if phase != 'main':
                try:
                    need(driver.bound, 'KQ1_PRIVATE')
                    result['privateInputsAbsent'] = _purge(driver.root, scope['operationId'], driver.identity)
                except BaseException: result['residuals'].append('PRIVATE_INVENTORY_UNCONFIRMED')
            if driver.j is not None:
                result.update(boundaryReached=driver.j.get('boundaryReached') is True,
                              counts=copy.deepcopy(driver.j['counts']), keyState=driver.j['keyState'],
                              mainFailure=driver.j.get('mainFailure'), matches=copy.deepcopy(driver.j['matches']),
                              cleanupMutationFailure=driver.j.get('cleanupMutationFailure'),
                              cleanupReadbackFailure=driver.j.get('cleanupReadbackFailure'))
                result['providerContainmentConfirmed'] = driver.j['keyState'] in ('CONTROL_PLANE_DELETED', 'NOT_CREATED')
                if not result['providerContainmentConfirmed']: result['residuals'].append('KEY_CONTAINMENT_UNCONFIRMED')
                if phase != 'main':
                    try:
                        main_result = inv.read(driver.root / 'work-result.json')
                        need(main_result.get('scopeSha256') == a.digest(scope) and
                             main_result.get('processCleanupVerified') is True and
                             driver.j['phases'].get('main', {}).get('closed') is True,
                             'KQ1_PROCESS')
                        if main_result.get('configurationUnchanged') is not True:
                            result['residuals'].append('MAIN_CONFIGURATION_UNCONFIRMED')
                        for residual in main_result.get('residuals', []):
                            if residual in ('STATE_HISTORY_UNCONFIRMED', 'PRIVATE_INVENTORY_UNCONFIRMED',
                                            'RESULT_UNCONFIRMED', 'PURGE_DEADLINE_MISSED'):
                                result['residuals'].append(residual)
                    except BaseException:
                        result['residuals'].append('MAIN_PROCESS_CLOSEOUT_UNKNOWN')
                if phase == 'main':
                    driver.j['mainFailure'] = failure
                    result['mainFailure'] = failure
                driver.j['phases'].setdefault(phase, {})['closed'] = True
                try: driver.save()
                except BaseException: result['residuals'].append('STATE_HISTORY_UNCONFIRMED')
            result['onTime'] = clock() < driver.t['purgeEnd']
            result['failure'] = failure
            if not result['processCleanupVerified']: result['residuals'].append('PROCESS_CLOSEOUT_UNCONFIRMED')
            if not result['configurationUnchanged']: result['residuals'].append('CONFIGURATION_UNCONFIRMED')
            if not result['onTime']: result['residuals'].append('PURGE_DEADLINE_MISSED')
            result['status'] = ('KQ1_AWAITING_INDEPENDENT_CLEANUP' if phase == 'main' else
                                'KQ1_CLOSED' if not result['residuals'] and failure is None else 'KQ1_CONTAINMENT_UNCONFIRMED')
            result['residuals'] = sorted(set(result['residuals']))
            name = 'work-result.json' if phase == 'main' else 'result.json'
            try:
                if driver.bound and not os.path.lexists(driver.root / name):
                    inv.reserve(driver.root / name, result)
            except BaseException: result['residuals'].append('RESULT_UNCONFIRMED')
            driver.plan = driver.ports = driver.engine = None
            fcntl.flock(driver.lock, fcntl.LOCK_UN); os.close(driver.lock)
        else:
            result['failure'] = failure
        for sig, handler in previous.items(): signal.signal(sig, handler)
    return result


def approved_scope(commit, scope_path, decision_path):
    """Only a separately committed external decision can construct native hooks."""
    need(re.fullmatch(r'APP013_P08_KQ1_KEY_BOUNDARY_SCOPE_[0-9]{8}\.json', scope_path or '') and
         re.fullmatch(r'APP013_P08_KQ1_KEY_BOUNDARY_APPROVAL_[0-9]{8}\.json', decision_path or ''), 'KQ1_APPROVAL')
    scope = q.strict_json(a.committed(p.G, commit, scope_path))
    decision = q.strict_json(a.committed(p.G, commit, decision_path))
    need(decision == {'owner': 'Debynyhan Banks', 'decision': DECISION,
                     'scopeSha256': a.digest(scope), 'operatorSha256': scope.get('operatorSha256'),
                     'externalActionAuthorized': True}, 'KQ1_APPROVAL')
    validate_scope(scope, time.time(), 'purge')
    need(a.digest(Path(__file__).read_bytes()) == scope['operatorSha256'] and
         a.committed(p.B, scope['sourceCommit'], str(Path(__file__).resolve().relative_to(p.B))) ==
         Path(__file__).read_bytes(), 'KQ1_SOURCE')
    return scope


def _command(mode, commit, scope_path, decision_path):
    return [p.PYTHON, '-I', '-B', '-c',
            'import runpy,sys;path=sys.argv.pop(1);sys.path.insert(0,sys.argv.pop(1));sys.argv[0]=path;runpy.run_path(path,run_name="__main__")',
            str(Path(__file__).resolve()), str(HERE), mode, commit, scope_path, decision_path]


def python_environment():
    # Validate incoming overrides once, then give Python children only the
    # neutral environment. Each worker creates SDK flags solely for gcloud.
    checked = q.sdk_environment(os.environ)
    return {name: checked[name] for name in ('HOME', 'PATH', 'LANG', 'PYTHONDONTWRITEBYTECODE')}


def _watch_purge(scope):
    """A prestarted, finite local guard; no CLI, credentials or provider access."""
    root = root_for(scope['operationId'])
    times = validate_scope(scope, time.time(), 'purge')
    began = time.time(); monotonic_end = time.monotonic() + max(0, times['cleanupEnd'] - began)
    identity = None
    print('KQ1_PURGE_GUARD_READY', flush=True)
    while time.time() < times['cleanupEnd'] and time.monotonic() < monotonic_end:
        try:
            if identity is None and os.path.lexists(root / 'attempt.json'):
                current = _private(root, scope['operationId'])
                attempt = inv.read(root / 'attempt.json')
                need(attempt == {'operationId': scope['operationId'], 'scopeSha256': a.digest(scope),
                                 'sourceCommit': scope['sourceCommit'], 'rootIdentity': current}, 'KQ1_PRIVATE')
                identity = current
            if identity is not None and os.path.lexists(root / 'result.json'):
                _private(root, scope['operationId'], identity)
                result = inv.read(root / 'result.json')
                if (result.get('scopeSha256') == a.digest(scope) and result.get('privateInputsAbsent') is True and
                        not any(os.path.lexists(root / name) for name in inv.PRIVATE)):
                    return 0
        except BaseException:
            pass  # No changed/foreign state is adopted. Recheck only this exact root.
        time.sleep(min(.2, max(.001, monotonic_end - time.monotonic())))
    result = {'status': 'KQ1_PURGE_GUARD_UNCONFIRMED', 'operationId': scope['operationId'],
              'scopeSha256': a.digest(scope), 'privateInputsAbsent': False,
              'providerContainmentConfirmed': False, 'authenticationObserved': False,
              'paymentObserved': False, 'residuals': ['KEY_CONTAINMENT_UNCONFIRMED', 'MAIN_PROCESS_CLOSEOUT_UNKNOWN']}
    try:
        if identity is None:
            need(not os.path.lexists(root), 'KQ1_PRIVATE')
            return 0
        result['privateInputsAbsent'] = _purge(root, scope['operationId'], identity)
        need(result['privateInputsAbsent'], 'KQ1_PRIVATE')
        result['status'] = 'KQ1_PRIVATE_PURGED_PROVIDER_UNKNOWN'
    except BaseException:
        result['residuals'].append('PRIVATE_INVENTORY_UNCONFIRMED')
    result['onTime'] = time.time() < times['purgeEnd']
    if identity is not None:
        try:
            if not os.path.lexists(root / 'result.json'):
                inv.reserve(root / 'result.json', result)
        except BaseException: pass
    return 0 if result['privateInputsAbsent'] and result['onTime'] else 2


def _start_guard(commit, scope_path, decision_path):
    import select
    process = subprocess.Popen(_command('--watch-purge', commit, scope_path, decision_path),
        stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
        env=python_environment(), start_new_session=True)
    try:
        end = time.monotonic() + 10
        received = b''
        os.set_blocking(process.stdout.fileno(), False)
        while b'\n' not in received and time.monotonic() < end and len(received) < 64:
            ready, _, _ = select.select([process.stdout], [], [], max(0, end - time.monotonic()))
            need(ready, 'KQ1_PURGE_GUARD')
            chunk = os.read(process.stdout.fileno(), 64 - len(received))
            need(chunk, 'KQ1_PURGE_GUARD'); received += chunk
        need(received == b'KQ1_PURGE_GUARD_READY\n' and process.poll() is None, 'KQ1_PURGE_GUARD')
        # Independent by design: its original absolute+monotonic deadline remains
        # effective even if this operation's main/supervisor is abruptly killed.
        process.stdout.close()
        return process
    except BaseException:
        try: os.killpg(process.pid, signal.SIGTERM)
        except ProcessLookupError: pass
        try: process.wait(timeout=2)
        except subprocess.TimeoutExpired:
            os.killpg(process.pid, signal.SIGKILL); process.wait(timeout=2)
        raise


def execute(mode, commit, scope_path, decision_path):
    need(mode in ('--run', '--main', '--cleanup', '--purge', '--watch-purge'), 'KQ1_ARGUMENTS')
    scope = approved_scope(commit, scope_path, decision_path)
    if mode == '--watch-purge': return _watch_purge(scope)
    if mode == '--run':
        validate_scope(scope, time.time(), 'main'); source_guard(scope)
        io = q.NativeIO(time.time, scope['operationId'])
        interrupted = False
        previous = {sig: signal.getsignal(sig) for sig in (signal.SIGINT, signal.SIGTERM)}
        def stop(*_):
            nonlocal interrupted
            interrupted = True
            for process in tuple(io.children):
                try: os.killpg(process.pid, signal.SIGTERM)
                except ProcessLookupError: pass
        for sig in previous: signal.signal(sig, stop)
        final = {'status': 'KQ1_SUPERVISION_UNCONFIRMED', 'residuals': ['SUPERVISION_UNCONFIRMED']}
        try:
            try:
                io._owned_run(_command('--main', commit, scope_path, decision_path),
                              python_environment(), m.timestamp(scope['window']['workEnd']) + 10)
            except BaseException:
                pass  # A fresh cleanup is mandatory even after main failure/interruption.
            finally:
                for sig in previous: signal.signal(sig, lambda *_: None)
                raw = io._owned_run(_command('--cleanup', commit, scope_path, decision_path),
                                    python_environment(), m.timestamp(scope['window']['cleanupEnd']))
                final = q.strict_json(raw)
                raw = None
        finally:
            closed = io.close(min(time.time() + 5, m.timestamp(scope['window']['cleanupEnd'])))
            if not closed:
                final['residuals'] = sorted(set(final.get('residuals', []) + ['SUPERVISION_UNCONFIRMED']))
            final['supervisorInterrupted'] = interrupted
            for sig, handler in previous.items(): signal.signal(sig, handler)
        print(json.dumps(final)); return 0
    phase = mode[2:]
    if phase == 'main':
        validate_scope(scope, time.time(), phase); source_guard(scope)
        _start_guard(commit, scope_path, decision_path)
    result = run_phase(scope, phase, owned_io_factory=q.NativeIO,
        cache_reader=lambda horizon: acl.read_cached_token(acl.CONFIG_ROOT, horizon),
        source_guard=source_guard, config_snapshot=lambda: acl.config_snapshot(acl.CONFIG_ROOT, os.environ))
    print(json.dumps(result)); return 0


if __name__ == '__main__':
    try:
        need(len(sys.argv) == 5, 'KQ1_ARGUMENTS')
        raise SystemExit(execute(*sys.argv[1:]))
    except Exception:
        print('{"status":"KQ1_REFUSED_OR_UNCONFIRMED"}')
        raise SystemExit(2)
