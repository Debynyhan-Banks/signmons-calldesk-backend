"""KQ1 proofs: actual key ports/HTTP/parser/cleanup with only synthetic I/O."""
import copy
import datetime
import hashlib
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
import urllib.error
import uuid
from unittest.mock import patch

import kq1_key_boundary as k

NUMBER = '123456789012'
TOKEN = 'SYNTHETIC_KQ1_OWNER_TOKEN_NEVER_PERSIST'
KEY_STRING = 'SYNTHETIC_KQ1_KEY_STRING_NEVER_PERSIST'
PRIVATE_ERROR = 'SYNTHETIC_KQ1_PROVIDER_BODY_NEVER_PERSIST'


def iso(value):
    return datetime.datetime.fromtimestamp(value, datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')


class Clock:
    def __init__(self, value=1794669600.): self.value = value
    def __call__(self): return self.value
    def pause(self, seconds):
        if seconds != 10: raise AssertionError('Unexpected poll pacing')
        self.value += seconds


class Response(io.BytesIO):
    def __init__(self, value, status=200, *, raw=None, on_read=None, on_close=None):
        super().__init__(json.dumps(value).encode() if raw is None else raw)
        self.status = status
        self.on_read, self.on_close = on_read, on_close
        self.closed_count = 0
    def read(self, size=-1):
        if self.on_read: self.on_read()
        return super().read(size)
    def close(self):
        self.closed_count += 1
        super().close()
        if self.on_close: self.on_close()


class Provider:
    """A strict in-memory provider behind the real urllib request boundary."""
    def __init__(self, scope, clock):
        self.scope, self.clock = scope, clock
        self.base = ('https://apikeys.googleapis.com/v2/projects/' + NUMBER +
                     '/locations/global/keys/signmons-p08-' + scope['operationId'].replace('-', ''))
        self.create_url = self.base.rsplit('/', 1)[0] + '?keyId=' + self.base.rsplit('/', 1)[1]
        self.service = 'https://serviceusage.googleapis.com/v1/projects/' + NUMBER + '/services/apikeys.googleapis.com'
        self.meta = None
        self.requests, self.responses = [], []
        self.phase = 'main'
        self.create_polls = self.delete_polls = 0
        self.create_done_at = self.delete_done_at = 0
        self.meta_reads = 0
        self.scenario = 'normal'
        self.cleanup_drift = None
        self.read_hook = self.close_hook = None
        self.persist_path = None
        self.abrupt = False

    def persist(self):
        if self.persist_path:
            self.persist_path.write_text(json.dumps({'meta': self.meta, 'create_polls': self.create_polls,
                                                    'delete_polls': self.delete_polls}))

    def response(self, value, status=200, raw=None):
        r = Response(value, status, raw=raw, on_read=self.read_hook, on_close=self.close_hook)
        self.responses.append(r)
        return r

    def open(self, request, timeout):
        method, url = request.get_method(), request.full_url
        if not 0 < timeout <= 8: raise AssertionError('HTTP timeout escaped cap')
        if request.get_header('Authorization') != 'Bearer ' + TOKEN: raise AssertionError('Wrong synthetic token')
        body = request.data
        self.requests.append((method, url, body))
        if url == self.service and method == 'GET':
            return self.response({'name': self.service.split('/v1/')[1],
                                  'state': 'DISABLED' if self.scenario == 'service_disabled' else 'ENABLED'})
        if url == self.create_url and method == 'POST':
            expected = {'displayName': 'Signmons P08 ' + self.scope['operationId'],
                        'restrictions': k.entry.bridge.packet.module('key').RESTRICTIONS}
            if json.loads(body) != expected: raise AssertionError('Create body discarded or changed')
            if self.meta is not None: raise AssertionError('Duplicate POST')
            self.meta = {'name': self.base.split('/v2/')[1], 'uid': str(uuid.uuid4()), 'etag': 'etag/synthetic-1',
                         **expected, 'createTime': iso(self.clock())}
            self.persist()
            if self.scenario == 'lost_create': raise OSError(PRIVATE_ERROR)
            if self.scenario == 'interrupt_create': raise KeyboardInterrupt(PRIVATE_ERROR)
            if self.create_done_at:
                return self.response({'name': 'operations/kq1-create'})
            return self.response({'name': 'operations/kq1-create', 'done': True, 'response': copy.deepcopy(self.meta)})
        if url == 'https://apikeys.googleapis.com/v2/operations/kq1-create' and method == 'GET':
            self.create_polls += 1
            self.persist()
            if self.scenario == 'lost_create_poll' and self.phase == 'main': raise OSError(PRIVATE_ERROR)
            if self.create_polls >= self.create_done_at:
                return self.response({'name': 'operations/kq1-create', 'done': True, 'response': copy.deepcopy(self.meta)})
            return self.response({'name': 'operations/kq1-create'})
        if url == self.base and method == 'GET':
            if self.meta is None:
                return self.response({'error': {'status': 'NOT_FOUND', 'code': 404}}, 404)
            self.meta_reads += 1
            if self.abrupt and self.phase == 'main': os._exit(23)
            if self.scenario == 'etag_drift' and 'deleteTime' not in self.meta:
                self.meta['etag'] = 'etag/synthetic-' + str(self.meta_reads + 1)
            value = copy.deepcopy(self.meta)
            if self.phase == 'cleanup' and self.cleanup_drift:
                value[self.cleanup_drift[0]] = self.cleanup_drift[1]
            return self.response(value)
        if url == self.base + '/keyString' and method == 'GET':
            return self.response({} if self.scenario == 'keystring_shape' else {'keyString': KEY_STRING})
        if method == 'DELETE' and url.startswith(self.base + '?etag='):
            from urllib.parse import quote
            if url != self.base + '?etag=' + quote(self.meta['etag'], safe=''):
                raise AssertionError('Delete did not use exact fresh etag')
            if any(m == 'DELETE' for m, _, _ in self.requests[:-1]): raise AssertionError('Duplicate DELETE')
            if self.scenario in ('lost_delete', 'interrupt_delete') or not self.delete_done_at:
                self.meta['deleteTime'] = iso(self.clock())
                self.persist()
            if self.scenario == 'lost_delete': raise OSError(PRIVATE_ERROR)
            if self.scenario == 'interrupt_delete': raise KeyboardInterrupt(PRIVATE_ERROR)
            return self.response({'name': 'operations/kq1-delete', **({} if self.delete_done_at else {'done': True, 'response': {}})})
        if url == 'https://apikeys.googleapis.com/v2/operations/kq1-delete' and method == 'GET':
            self.delete_polls += 1
            if self.delete_polls >= self.delete_done_at:
                self.meta['deleteTime'] = iso(self.clock())
                self.persist()
                return self.response({'name': 'operations/kq1-delete', 'done': True, 'response': {}})
            return self.response({'name': 'operations/kq1-delete'})
        raise AssertionError('Unapproved HTTP route: ' + method + ' ' + url)


class Fixture:
    def __init__(self, scope=None):
        self.clock = Clock()
        self.scope = scope or self.make_scope()
        self.root = Path('/private/tmp/p08-coordinator-' + self.scope['operationId'])
        self.provider = Provider(self.scope, self.clock)
        self.cli, self.cache, self.source, self.closed = [], [], [], []
        self.owner_value = [{'account': k.m.OWNER, 'status': 'ACTIVE'}]
        self.project_value = {'projectId': 'signmons', 'projectNumber': NUMBER, 'lifecycleState': 'ACTIVE'}
        self.token = TOKEN
        self.config = {'synthetic': 'unchanged'}
        self.source_error = None

    def make_scope(self):
        import hashlib
        files = ('packet.py', 'ks1_read.py', 'kd1_cleanup.py')
        return {'version': 1, 'action': 'QUALIFY_EXACT_KEY_BOUNDARY_ONCE', 'operationId': str(uuid.uuid4()),
                'sourceCommit': 'a' * 40, 'sourceManifestSha256': 'b' * 64, 'nativeManifestSha256': 'c' * 64,
                'sdkFilesSha256': 'd' * 64, 'operatorSha256': 'e' * 64,
                'dependencySha256': {name: hashlib.sha256((Path(__file__).parent / name).read_bytes()).hexdigest() for name in files},
                'projectNumberSha256': k.m.digest(NUMBER),
                'commands': json.loads(json.dumps([next(d for d in k.q.current_cli_contract() if d['id'] == name)
                                                 for name in ('owner', 'project')])),
                'window': {'start': iso(self.clock() - 10), 'cutoff': iso(self.clock() + 60),
                           'workEnd': iso(self.clock() + 300), 'cleanupEnd': iso(self.clock() + 720),
                           'purgeEnd': iso(self.clock() + 780)},
                'limits': {'cli': 4, 'cache': 2, 'https': 25, 'mainHttps': 11, 'cleanupHttps': 14,
                           'create': 1, 'delete': 1, 'sql': 0, 'child': 0},
                'sdkException': 'SDK_EXISTING_OWNER_REFRESH_CACHE_INTERNAL_RETRIES_NO_TOKEN_EXPORT',
                'allowanceUsd': 0, 'automaticRetryAllowed': False,
                'restrictions': copy.deepcopy(k.entry.bridge.packet.module('key').RESTRICTIONS)}

    def owned_io_factory(self, clock, operation):
        fixture = self
        class Owned:
            def _owned_run(self, argv, env, deadline):
                fixture.cli.append((list(argv), deadline))
                if deadline <= clock(): raise AssertionError('CLI called past deadline')
                owner = fixture.scope['commands'][0]['argv']
                project = fixture.scope['commands'][1]['argv']
                if list(argv) == list(owner): return json.dumps(fixture.owner_value)
                if list(argv) == list(project): return json.dumps(fixture.project_value)
                raise AssertionError('Arbitrary CLI called')
            def close(self, deadline):
                fixture.closed.append(deadline)
                return True
        return Owned()

    def cache_reader(self, horizon):
        self.cache.append(horizon)
        return self.token

    def source_guard(self, scope):
        self.source.append(copy.deepcopy(scope))
        if self.source_error: raise self.source_error

    def run(self, phase):
        self.provider.phase = phase
        with patch.object(k.q, 'PROJECT_NUMBER_SHA256', self.scope['projectNumberSha256']), \
             patch('urllib.request.build_opener', return_value=self.provider):
            return k.run_phase(self.scope, phase, owned_io_factory=self.owned_io_factory,
                               cache_reader=self.cache_reader, source_guard=self.source_guard,
                               config_snapshot=lambda: copy.deepcopy(self.config), clock=self.clock, pause=self.clock.pause)

    def cleanup_files(self):
        if self.root.exists(): shutil.rmtree(self.root)


class KQ1Tests(unittest.TestCase):
    def setUp(self):
        self.f = Fixture()
        self.addCleanup(self.f.cleanup_files)

    def assert_no_secret(self):
        text = '\n'.join(path.read_text() for path in self.f.root.iterdir() if path.is_file()) if self.f.root.exists() else ''
        for value in (TOKEN, KEY_STRING, hashlib.sha256(KEY_STRING.encode()).hexdigest(), PRIVATE_ERROR):
            self.assertNotIn(value, text)

    def assert_no_auth_calls(self):
        self.assertTrue(all('apikeys.googleapis.com/' in u or 'serviceusage.googleapis.com/' in u
                            for _, u, _ in self.f.provider.requests))
        self.assertFalse(any('auth' in p.name or 'child' in p.name or 'payment' in p.name
                             for p in self.f.root.iterdir()))

    def test_exact_scope_and_phase_validation(self):
        with patch.object(k.q, 'PROJECT_NUMBER_SHA256', self.f.scope['projectNumberSha256']):
            times = k.validate_scope(self.f.scope, self.f.clock(), 'main')
            self.assertEqual(times['workEnd'], self.f.clock() + 300)
            for phase in ('cleanup', 'purge'):
                k.validate_scope(self.f.scope, self.f.clock(), phase)
            with self.assertRaises(Exception):
                k.validate_scope(self.f.scope, self.f.clock(), 'foreign')
        self.assertEqual(self.f.cli + self.f.cache + self.f.provider.requests, [])

    def test_scope_drift_refuses_before_any_io(self):
        changes = [('operationId', str(uuid.uuid4()).upper()), ('sourceCommit', 'bad'),
                   ('operatorSha256', 'bad'), ('projectNumberSha256', 'f' * 64),
                   ('allowanceUsd', 1), ('automaticRetryAllowed', True), ('restrictions', {}),
                   ('sdkException', 'foreign'), ('action', 'RUN_PAYMENT'), ('version', 2)]
        with patch.object(k.q, 'PROJECT_NUMBER_SHA256', self.f.scope['projectNumberSha256']):
            for field, value in changes:
                with self.subTest(field=field):
                    scope = copy.deepcopy(self.f.scope); scope[field] = value
                    with self.assertRaises(Exception): k.validate_scope(scope, self.f.clock(), 'main')
            for field in self.f.scope['limits']:
                with self.subTest(limit=field):
                    scope = copy.deepcopy(self.f.scope); scope['limits'][field] += 1
                    with self.assertRaises(Exception): k.validate_scope(scope, self.f.clock(), 'main')
            scope = copy.deepcopy(self.f.scope); scope['unapprovedField'] = True
            with self.assertRaises(Exception): k.validate_scope(scope, self.f.clock(), 'main')
        self.assertEqual(self.f.cli + self.f.cache + self.f.provider.requests, [])

    def test_no_native_defaults_available(self):
        with self.assertRaises(TypeError): k.run_phase(self.f.scope, 'main')
        self.assertFalse(self.f.root.exists())

    def test_insufficient_cleanup_reserve_and_expired_cutoff_refuse(self):
        with patch.object(k.q, 'PROJECT_NUMBER_SHA256', self.f.scope['projectNumberSha256']):
            scope = copy.deepcopy(self.f.scope)
            scope['window']['cleanupEnd'] = iso(self.f.clock() + 181)
            with self.assertRaises(Exception): k.validate_scope(scope, self.f.clock(), 'main')
            with self.assertRaises(Exception):
                k.validate_scope(self.f.scope, self.f.clock() + 60, 'main')
            with self.assertRaises(Exception):
                k.validate_scope(self.f.scope, self.f.clock() - 11, 'main')

    def test_actual_key_boundary_and_independent_conditional_delete(self):
        forbidden = ('authenticate_receipt', 'account_readback')
        from contextlib import ExitStack
        with ExitStack() as stack:
            blocked = [stack.enter_context(patch.object(k.entry.Ports, name, side_effect=AssertionError('auth forbidden')))
                       for name in forbidden]
            blocked += [stack.enter_context(patch.object(k.entry.NativeIO, name, side_effect=AssertionError('native dispatch forbidden')))
                        for name in ('ensure_owner', 'cli', 'sql', 'child', 'credentials')]
            main = self.f.run('main')
            self.assertTrue(main['boundaryReached'], main)
            self.assertEqual(len(self.f.provider.requests), 6)
            self.assertEqual(len(self.f.cli), 2)
            self.assertEqual(len(self.f.cache), 1)
            closed = self.f.run('cleanup')
            self.assertIn('CONTROL_PLANE_DELETED', json.dumps(closed))
            for call in blocked: call.assert_not_called()
        self.assertEqual(len(self.f.cli), 4)
        self.assertEqual(len(self.f.cache), 2)
        self.assertEqual(self.f.cache, [1794670380., 1794670380.])
        self.assertEqual(len(self.f.provider.requests), 9)
        self.assertEqual(sum(m == 'POST' for m, _, _ in self.f.provider.requests), 1)
        self.assertEqual(sum(m == 'DELETE' for m, _, _ in self.f.provider.requests), 1)
        self.assertTrue(all(r.closed_count == 1 for r in self.f.provider.responses))
        self.assert_no_auth_calls()
        self.assert_no_secret()

    def test_owned_version_refresh_reaches_sink_and_keeps_creation_reference_flags(self):
        self.f.provider.scenario = 'etag_drift'
        main = self.f.run('main')
        self.assertTrue(main['boundaryReached'],main)
        self.assertIsNone(main['failure'])
        self.assertEqual(main['matches'],{'postcreate':{'uid':True,'etag':False,'active':True},
                                          'authenticate':{'uid':True,'etag':False,'active':True}})
        self.assertEqual(sum(u.endswith('/keyString') for _, u, _ in self.f.provider.requests),1)
        self.assertEqual(main['counts']['mainHttps'],6)
        closed = self.f.run('cleanup')
        self.assertIn('CONTROL_PLANE_DELETED', json.dumps(closed))
        deletes = [u for m, u, _ in self.f.provider.requests if m == 'DELETE']
        self.assertEqual(deletes, [self.f.provider.base + '?etag=etag%2Fsynthetic-4'])
        self.assertEqual(closed['counts']['https'],9)
        self.assert_no_secret()

    def test_keystring_schema_failure_is_safe_and_independently_contained(self):
        self.f.provider.scenario = 'keystring_shape'
        main = self.f.run('main')
        self.assertIn('KEY_STRING_SHAPE', json.dumps(main))
        self.assertFalse(main['boundaryReached'], main)
        closed = self.f.run('cleanup')
        self.assertIn('CONTROL_PLANE_DELETED', json.dumps(closed))
        self.assert_no_secret()

    def test_both_fifth_polls_evaluated_with_bounded_counts(self):
        self.f.provider.create_done_at = self.f.provider.delete_done_at = 5
        start = self.f.clock()
        result = self.f.run('main')
        self.assertTrue(result['boundaryReached'], result)
        self.assertEqual(len(self.f.provider.requests), 11)
        self.assertIn('CONTROL_PLANE_DELETED', json.dumps(self.f.run('cleanup')))
        self.assertEqual(len(self.f.provider.requests), 19)
        self.assertEqual((self.f.provider.create_polls, self.f.provider.delete_polls), (5, 5))
        self.assertEqual(self.f.clock() - start, 100)

    def test_lost_post_without_provenance_cannot_adopt_matching_key(self):
        self.f.provider.scenario = 'lost_create'
        main = self.f.run('main')
        self.assertFalse(main['boundaryReached'], main)
        self.assertIsNotNone(self.f.provider.meta)
        self.f.run('cleanup')
        self.assertFalse(any(m == 'DELETE' for m, _, _ in self.f.provider.requests))
        self.assertEqual(sum(m == 'POST' for m, _, _ in self.f.provider.requests), 1)
        self.assert_no_secret()

    def test_retained_create_operation_can_recover_before_cleanup(self):
        self.f.provider.scenario = 'lost_create_poll'
        self.f.provider.create_done_at = 2
        self.f.run('main')
        closed = self.f.run('cleanup')
        self.assertIn('CONTROL_PLANE_DELETED', json.dumps(closed))
        self.assertEqual(sum(m == 'POST' for m, _, _ in self.f.provider.requests), 1)
        self.assertEqual(sum(m == 'DELETE' for m, _, _ in self.f.provider.requests), 1)
        self.assert_no_secret()

    def test_lost_delete_reply_uses_final_read_without_retry(self):
        self.f.provider.scenario = 'lost_delete'
        self.f.run('main')
        closed = self.f.run('cleanup')
        self.assertIn('CONTROL_PLANE_DELETED', json.dumps(closed))
        self.assertEqual(sum(m == 'DELETE' for m, _, _ in self.f.provider.requests), 1)
        self.assertEqual(self.f.provider.requests[-1][:2], ('GET', self.f.provider.base))
        self.assert_no_secret()

    def test_foreign_uid_rejected_before_delete(self):
        self.f.run('main')
        self.f.provider.cleanup_drift = ('uid', str(uuid.uuid4()))
        closed = self.f.run('cleanup')
        self.assertNotIn('CONTROL_PLANE_DELETED', json.dumps(closed))
        self.assertFalse(any(m == 'DELETE' for m, _, _ in self.f.provider.requests))

    def test_owner_project_and_token_failures_precede_provider_io(self):
        for kind in ('owner', 'project', 'token'):
            with self.subTest(kind=kind):
                f = Fixture()
                try:
                    if kind == 'owner': f.owner_value = [{'account': 'foreign@example.invalid', 'status': 'ACTIVE'}]
                    if kind == 'project': f.project_value['projectNumber'] = '987654321012'
                    if kind == 'token': f.token = ''
                    try: f.run('main')
                    except Exception: pass
                    self.assertEqual(f.provider.requests, [])
                finally: f.cleanup_files()

    def test_source_failure_precedes_credential_and_provider_io(self):
        self.f.source_error = RuntimeError(PRIVATE_ERROR)
        try: self.f.run('main')
        except Exception: pass
        self.assertEqual(self.f.cli + self.f.cache + self.f.provider.requests, [])
        self.assert_no_secret()

    def test_disabled_service_never_creates_or_enables(self):
        self.f.provider.scenario = 'service_disabled'
        self.f.run('main')
        self.assertTrue(self.f.provider.requests)
        self.assertTrue(all(method == 'GET' for method, _, _ in self.f.provider.requests))
        self.assertIsNone(self.f.provider.meta)

    def test_repeated_main_never_creates_again(self):
        self.f.run('main')
        before = (len(self.f.cli), len(self.f.cache), len(self.f.provider.requests))
        try: self.f.run('main')
        except Exception: pass
        self.assertEqual((len(self.f.cli), len(self.f.cache), len(self.f.provider.requests)), before)

    def test_fresh_process_cleanup_after_abrupt_main_exit(self):
        with tempfile.TemporaryDirectory(prefix='kq1-synthetic-', dir='/private/tmp') as directory:
            payload = Path(directory) / 'fixture.json'
            payload.write_text(json.dumps({'scope': self.f.scope, 'now': self.f.clock()}))
            command = [sys.executable, str(Path(__file__).resolve()), '--synthetic-phase', str(payload)]
            main = subprocess.run(command + ['abrupt-main'], capture_output=True, text=True, timeout=30)
            self.assertEqual(main.returncode, 23, main.stderr)
            self.assertTrue((self.f.root / 'key-lifecycle-private.json').exists())
            cleanup = subprocess.run(command + ['cleanup'], capture_output=True, text=True, timeout=30)
            self.assertEqual(cleanup.returncode, 0, cleanup.stderr)
            self.assertIn('CONTROL_PLANE_DELETED', cleanup.stdout)
            purge = subprocess.run(command + ['purge'], capture_output=True, text=True, timeout=30)
            self.assertEqual(purge.returncode, 0, purge.stderr)
            for name in ('envelope.json', 'key-lifecycle-private.json', 'key-lifecycle-private.json.next'):
                self.assertFalse((self.f.root / name).exists())
            for output in (main.stdout, main.stderr, cleanup.stdout, cleanup.stderr, purge.stdout, purge.stderr):
                for secret in (TOKEN, KEY_STRING, PRIVATE_ERROR): self.assertNotIn(secret, output)
            self.assert_no_secret()

    def test_actual_source_guard_checks_operator_commit_sdk_and_runtime(self):
        from contextlib import ExitStack
        with tempfile.TemporaryDirectory(prefix='kq1-source-fixture-', dir='/private/tmp') as directory:
            sdk = Path(directory) / 'synthetic-sdk.py'; sdk.write_text('# synthetic SDK source\n')
            sdk_files = {str(sdk): k.m.digest(sdk.read_bytes())}
            scope = copy.deepcopy(self.f.scope)
            scope['sourceManifestSha256'] = '1' * 64
            scope['nativeManifestSha256'] = k.a.digest((k.a.HERE / 'source-manifest.json').read_bytes())
            scope['sdkFilesSha256'] = k.m.digest(sdk_files)
            scope['operatorSha256'] = k.a.digest(Path(k.__file__).read_bytes())
            with ExitStack() as stack:
                stack.enter_context(patch.object(k.m, 'verify_local_manifest', return_value={'sdkReview': {'files': sdk_files}}))
                stack.enter_context(patch.object(k.m, 'verify_locked_sources', return_value=None))
                stack.enter_context(patch.object(k.a, 'verify_sources', return_value={'files': {}, 'lockedSources': {}}))
                stack.enter_context(patch.object(k.q, 'verify_qualification_sources', return_value=None))
                stack.enter_context(patch.object(k.q, 'source_manifest_sha256', return_value='1' * 64))
                stack.enter_context(patch.object(k.q, 'sdk_environment', return_value={}))
                stack.enter_context(patch.object(k.acl, 'config_snapshot', return_value={'synthetic': True}))
                stack.enter_context(patch.object(k.acl, 'LOCAL_RUNTIME', (sys.platform, sys.version_info[:3], k.sqlite3.sqlite_version)))
                committed = stack.enter_context(patch.object(k.a, 'committed', side_effect=lambda repo, commit, name: (repo / name).read_bytes()))
                k.source_guard(scope)
                altered = copy.deepcopy(scope); altered['operatorSha256'] = 'f' * 64
                with self.assertRaises(Exception): k.source_guard(altered)
                committed.side_effect = lambda *args: b'changed committed source'
                with self.assertRaises(Exception): k.source_guard(scope)
                committed.side_effect = lambda repo, commit, name: (repo / name).read_bytes()
                sdk.write_text('# drifted synthetic SDK source\n')
                with self.assertRaises(Exception): k.source_guard(scope)
                sdk.write_text('# synthetic SDK source\n')
                with patch.object(k.acl, 'LOCAL_RUNTIME', ('foreign', (0, 0, 0), 'none')):
                    with self.assertRaises(Exception): k.source_guard(scope)
        self.assertEqual(self.f.cli + self.f.cache + self.f.provider.requests, [])

    def test_mutation_source_and_configuration_drift_stop_before_post(self):
        for kind in ('source', 'config'):
            with self.subTest(kind=kind):
                f = Fixture()
                try:
                    original = f.provider.open
                    def open_request(request, timeout):
                        response = original(request, timeout)
                        if request.full_url == f.provider.base:
                            if kind == 'source': f.source_error = RuntimeError(PRIVATE_ERROR)
                            else: f.config = {'synthetic': 'changed'}
                        return response
                    f.provider.open = open_request
                    result = f.run('main')
                    self.assertFalse(result['boundaryReached'])
                    self.assertFalse(any(method == 'POST' for method, _, _ in f.provider.requests))
                    self.assertEqual(len(f.cache), 1)
                finally: f.cleanup_files()

    def test_http_error_oversize_and_read_interruption_close_responses(self):
        for scenario in ('http_error', 'oversize', 'utf8', 'read_timeout'):
            with self.subTest(scenario=scenario):
                f = Fixture()
                try:
                    def failed(request, timeout):
                        f.provider.requests.append((request.get_method(), request.full_url, request.data))
                        raw = (b'x' * 65537 if scenario == 'oversize' else b'\xff' if scenario == 'utf8' else
                               json.dumps({'error': {'status': 'PERMISSION_DENIED', 'code': 403, 'message': PRIVATE_ERROR}}).encode())
                        response = f.provider.response({}, 403, raw=raw)
                        if scenario == 'read_timeout':
                            def interrupted(): raise TimeoutError(PRIVATE_ERROR)
                            response.on_read = interrupted
                        if scenario == 'http_error':
                            raise urllib.error.HTTPError(request.full_url, 403, PRIVATE_ERROR, {}, response)
                        return response
                    f.provider.open = failed
                    result = f.run('main')
                    self.assertFalse(result['boundaryReached'])
                    self.assertTrue(f.provider.responses)
                    self.assertTrue(all(response.closed for response in f.provider.responses))
                    self.assertNotIn(PRIVATE_ERROR, json.dumps(result))
                    self.assertFalse(any(method == 'POST' for method, _, _ in f.provider.requests))
                finally: f.cleanup_files()

    def test_clock_rollback_and_response_deadline_stop_before_mutation(self):
        for rollback in (True, False):
            with self.subTest(rollback=rollback):
                f = Fixture()
                try:
                    f.provider.read_hook = lambda: setattr(f.clock, 'value', 1794669599. if rollback else 1794669900.)
                    result = f.run('main')
                    self.assertFalse(result['boundaryReached'])
                    self.assertTrue(all(response.closed for response in f.provider.responses))
                    self.assertFalse(any(method == 'POST' for method, _, _ in f.provider.requests))
                finally: f.cleanup_files()

    def test_repeated_cleanup_spends_no_extra_credentials_or_delete(self):
        self.f.run('main'); self.f.run('cleanup')
        before = (len(self.f.cli), len(self.f.cache), len(self.f.provider.requests))
        self.f.run('cleanup')
        self.assertEqual((len(self.f.cli), len(self.f.cache), len(self.f.provider.requests)), before)

    def test_full_recovery_pool_and_final_read_stay_within_global_ceiling(self):
        self.f.provider.create_done_at = 11
        self.f.provider.delete_done_at = 5
        main = self.f.run('main')
        self.assertFalse(main['boundaryReached'])
        self.assertEqual(main['counts']['mainHttps'], 8)
        closed = self.f.run('cleanup')
        self.assertEqual(closed['keyState'], 'CONTROL_PLANE_DELETED', closed)
        self.assertEqual(closed['counts'], {'cli': 4, 'cache': 2, 'https': 22,
                                           'mainHttps': 8, 'cleanupHttps': 14})
        self.assertEqual(self.f.provider.requests[-1][:2], ('GET', self.f.provider.base))
        self.assertEqual((self.f.provider.create_polls, self.f.provider.delete_polls), (11, 5))

    def test_exhausted_shared_pool_refuses_all_additional_http(self):
        self.f.run('main')
        path = self.f.root / 'journal.json'
        journal = json.loads(path.read_text())
        journal['requests'].update(createPoll=5, recoverPoll=6, unownedRead=1,
                                   cleanupRead=1, delete=1, deletePoll=5)
        journal['counts'].update(https=25, mainHttps=11, cleanupHttps=14)
        journal['keyDeleteAttempted'] = True
        path.write_text(json.dumps(journal))
        before = len(self.f.provider.requests)
        result = self.f.run('cleanup')
        self.assertFalse(result['providerContainmentConfirmed'])
        self.assertEqual(len(self.f.provider.requests), before)
        self.assertFalse(any(method == 'DELETE' for method, _, _ in self.f.provider.requests))
        self.assertTrue(result['privateInputsAbsent'])

    def test_single_delete_reservation_survives_independent_reload(self):
        self.f.run('main')
        path = self.f.root / 'journal.json'
        journal = json.loads(path.read_text()); journal['keyDeleteAttempted'] = True
        journal['requests']['delete'] = 1
        journal['counts']['https'] += 1
        journal['counts']['cleanupHttps'] += 1
        path.write_text(json.dumps(journal))
        result = self.f.run('cleanup')
        self.assertFalse(any(method == 'DELETE' for method, _, _ in self.f.provider.requests))
        self.assertFalse(result['providerContainmentConfirmed'])
        self.assertEqual(self.f.provider.requests[-1][:2], ('GET', self.f.provider.base))

    def test_concurrent_cleanup_lock_blocks_before_credentials_and_preserves_custody(self):
        import fcntl
        self.f.run('main')
        fd = os.open(self.f.root / 'entry.lock', os.O_RDWR)
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            before = (len(self.f.cli), len(self.f.cache), len(self.f.provider.requests))
            result = self.f.run('cleanup')
            self.assertIsNotNone(result['failure'])
            self.assertEqual((len(self.f.cli), len(self.f.cache), len(self.f.provider.requests)), before)
            self.assertTrue((self.f.root / 'key-lifecycle-private.json').exists())
        finally:
            fcntl.flock(fd, fcntl.LOCK_UN); os.close(fd)
        self.assertEqual(self.f.run('cleanup')['keyState'], 'CONTROL_PLANE_DELETED')

    def test_partial_atomic_lifecycle_receipt_is_not_authority_and_is_purged(self):
        self.f.run('main')
        next_path = self.f.root / 'key-lifecycle-private.json.next'
        fd = os.open(next_path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        os.write(fd, b'{"phase":'); os.close(fd)
        before = len(self.f.provider.requests)
        result = self.f.run('cleanup')
        self.assertEqual(len(self.f.provider.requests), before)
        self.assertFalse(result['providerContainmentConfirmed'])
        self.assertTrue(result['privateInputsAbsent'])
        self.assertFalse(next_path.exists())
        self.assertFalse((self.f.root / 'key-lifecycle-private.json').exists())

    def test_private_mode_symlink_hardlink_and_foreign_files_block_before_io(self):
        for case in ('mode', 'symlink', 'hardlink', 'foreign'):
            with self.subTest(case=case):
                f = Fixture()
                try:
                    f.run('main')
                    if case == 'mode': (f.root / 'key-lifecycle-private.json').chmod(0o644)
                    elif case == 'symlink': (f.root / 'owned-receipt.json').symlink_to(f.root / 'journal.json')
                    elif case == 'hardlink': os.link(f.root / 'journal.json', f.root / 'owned-receipt.json')
                    else: (f.root / 'unapproved-file').write_text('synthetic')
                    before = (len(f.cli), len(f.cache), len(f.provider.requests))
                    result = f.run('cleanup')
                    self.assertIsNotNone(result['failure'])
                    self.assertEqual((len(f.cli), len(f.cache), len(f.provider.requests)), before)
                finally: f.cleanup_files()

    def test_receipt_sink_rejects_malformed_real_boundary_receipts(self):
        changes = [('operationId', str(uuid.uuid4())), ('uid', str(uuid.uuid4())), ('keyResource', 'foreign'),
                   ('etag', 'foreign'), ('restrictions', {}), ('keyStringSha256', 'bad'),
                   ('createdInOperation', False), ('deleted', True), ('keyString', KEY_STRING)]
        original = k.Driver.receipt_sink
        for field, value in changes:
            with self.subTest(field=field):
                f = Fixture()
                try:
                    def malformed(driver, receipt):
                        receipt[field] = value
                        return original(driver, receipt)
                    with patch.object(k.Driver, 'receipt_sink', malformed): result = f.run('main')
                    self.assertEqual(result['failure'], 'KQ1_SINK')
                    self.assertFalse(result['boundaryReached'])
                    self.assertEqual(f.run('cleanup')['keyState'], 'CONTROL_PLANE_DELETED')
                    retained = '\n'.join(p.read_text() for p in f.root.iterdir() if p.is_file())
                    self.assertNotIn(KEY_STRING, retained)
                    self.assertNotIn(hashlib.sha256(KEY_STRING.encode()).hexdigest(), retained)
                finally: f.cleanup_files()

    def test_total_http_alarm_covers_read_and_close(self):
        import contextlib
        import time
        real_deadline = k.acl.http_deadline
        for stage in ('read', 'close'):
            with self.subTest(stage=stage):
                f = Fixture(); requested = []
                try:
                    @contextlib.contextmanager
                    def accelerated(seconds):
                        requested.append(seconds)
                        with real_deadline(min(seconds, .03)): yield
                    if stage == 'read': f.provider.read_hook = lambda: time.sleep(.1)
                    else: f.provider.close_hook = lambda: time.sleep(.1)
                    with patch.object(k.acl, 'http_deadline', accelerated): result = f.run('main')
                    self.assertFalse(result['boundaryReached'])
                    self.assertGreaterEqual(len(requested), 2)  # Cache and entire HTTP exchange.
                    self.assertTrue(all(0 < seconds <= 8 for seconds in requested))
                    self.assertTrue(all(r.closed for r in f.provider.responses))
                    self.assertFalse(any(method == 'POST' for method, _, _ in f.provider.requests))
                finally: f.cleanup_files()

    def test_request_descriptor_firewall_rejects_foreign_body_method_query_and_host(self):
        original = k.Driver.dispatch
        for mutation in ('body', 'method', 'query', 'host', 'timeout', 'redirect'):
            with self.subTest(mutation=mutation):
                f = Fixture()
                try:
                    def dispatch(driver, descriptor):
                        d = copy.deepcopy(descriptor)
                        if d['method'] == 'POST':
                            if mutation == 'body': d['body'] = '{}'
                            elif mutation == 'method': d['method'] = 'PATCH'
                            elif mutation == 'query': d['url'] += '&foreign=1'
                            elif mutation == 'host': d['url'] = d['url'].replace('apikeys.googleapis.com', 'foreign.invalid')
                            elif mutation == 'timeout': d['timeoutSeconds'] = 9
                            else: d['redirect'] = 'follow'
                        return original(driver, d)
                    with patch.object(k.Driver, 'dispatch', dispatch): result = f.run('main')
                    self.assertFalse(result['boundaryReached'])
                    self.assertFalse(any(method == 'POST' for method, _, _ in f.provider.requests))
                    self.assertEqual(f.run('cleanup')['keyState'], 'NOT_CREATED')
                finally: f.cleanup_files()

    def test_native_opener_explicitly_disables_system_proxies(self):
        with patch.object(k.q, 'PROJECT_NUMBER_SHA256', self.f.scope['projectNumberSha256']), \
             patch('urllib.request.build_opener', return_value=self.f.provider) as opener:
            result = k.run_phase(self.f.scope, 'main', owned_io_factory=self.f.owned_io_factory,
                                 cache_reader=self.f.cache_reader, source_guard=self.f.source_guard,
                                 config_snapshot=lambda: self.f.config, clock=self.f.clock, pause=self.f.clock.pause)
        self.assertTrue(result['boundaryReached'], result)
        self.assertTrue(opener.call_args_list)
        for call in opener.call_args_list:
            handlers = [handler for handler in call.args if isinstance(handler, urllib.request.ProxyHandler)]
            self.assertEqual(len(handlers), 1)
            self.assertEqual(handlers[0].proxies, {})

    def test_generated_command_executes_safe_cli_refusal_without_native_hooks(self):
        command = k._command('--main', '0' * 40, 'FOREIGN', 'FOREIGN')
        process = subprocess.run(command, capture_output=True, text=True, timeout=30)
        self.assertEqual(process.returncode, 2, process.stderr)
        self.assertEqual(json.loads(process.stdout), {'status': 'KQ1_REFUSED_OR_UNCONFIRMED'})
        self.assertEqual(process.stderr, '')

    def test_prestarted_local_guard_purges_after_abrupt_owner_exit(self):
        import select
        with tempfile.TemporaryDirectory(prefix='kq1-watch-fixture-', dir='/private/tmp') as directory:
            payload = Path(directory) / 'fixture.json'
            payload.write_text(json.dumps({'scope': self.f.scope, 'now': self.f.clock()}))
            command = [sys.executable, str(Path(__file__).resolve()), '--synthetic-phase', str(payload)]
            guard = subprocess.Popen(command + ['watch'], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
            try:
                ready, _, _ = select.select([guard.stdout], [], [], 5)
                self.assertTrue(ready, 'Guard readiness missing')
                self.assertEqual(guard.stdout.readline(), 'KQ1_PURGE_GUARD_READY\n')
                main = subprocess.run(command + ['abrupt-main'], capture_output=True, text=True, timeout=10)
                self.assertEqual(main.returncode, 23, main.stderr)
                self.assertTrue((self.f.root / 'key-lifecycle-private.json').exists())
                stdout, stderr = guard.communicate(timeout=10)
                self.assertEqual(guard.returncode, 0, stderr)
                self.assertEqual(stderr, '')
                result = json.loads((self.f.root / 'result.json').read_text())
                self.assertTrue(result['privateInputsAbsent'])
                self.assertFalse(result['providerContainmentConfirmed'])
                self.assertIn('KEY_CONTAINMENT_UNCONFIRMED', result['residuals'])
                self.assertFalse((self.f.root / 'key-lifecycle-private.json').exists())
                self.assertFalse((self.f.root / 'envelope.json').exists())
                for output in (stdout, stderr, main.stdout, main.stderr, json.dumps(result)):
                    for secret in (TOKEN, KEY_STRING, hashlib.sha256(KEY_STRING.encode()).hexdigest(), PRIVATE_ERROR):
                        self.assertNotIn(secret, output)
            finally:
                if guard.poll() is None:
                    guard.terminate(); guard.communicate(timeout=5)

    def test_cleanup_mutation_cutoff_preserves_final_read_reserve(self):
        self.f.run('main')
        self.f.clock.value += 660  # cleanupEnd minus the reserved final-read minute.
        before = len(self.f.provider.requests)
        result = self.f.run('cleanup')
        self.assertEqual(self.f.provider.requests[before:], [('GET', self.f.provider.base, None)])
        self.assertFalse(any(method == 'DELETE' for method, _, _ in self.f.provider.requests))
        self.assertTrue(result['privateInputsAbsent'])
        self.assertFalse(result['providerContainmentConfirmed'])

    def test_delete_response_crossing_mutation_cutoff_still_gets_final_read(self):
        self.f.run('main')
        cutoff = self.f.clock() + 660
        self.f.provider.read_hook = lambda: setattr(self.f.clock, 'value', cutoff) if self.f.provider.requests[-1][0] == 'DELETE' else None
        result = self.f.run('cleanup')
        self.assertEqual(result['keyState'], 'CONTROL_PLANE_DELETED', result)
        self.assertIsNotNone(result['cleanupMutationFailure'])
        self.assertEqual(self.f.provider.requests[-1][:2], ('GET', self.f.provider.base))
        self.assertEqual(sum(method == 'DELETE' for method, _, _ in self.f.provider.requests), 1)

    def test_key_collision_never_creates_or_deletes_preexisting_resource(self):
        self.f.provider.meta = {'name': self.f.provider.base.split('/v2/')[1], 'uid': str(uuid.uuid4()),
                                'etag': 'preexisting', 'displayName': 'Signmons P08 ' + self.f.scope['operationId'],
                                'restrictions': self.f.scope['restrictions'], 'createTime': iso(self.f.clock())}
        main = self.f.run('main')
        self.assertEqual(main['failure'], 'KQ1_KEY_COLLISION')
        cleanup = self.f.run('cleanup')
        self.assertEqual(cleanup['keyState'], 'NOT_CREATED')
        self.assertTrue(all(method == 'GET' for method, _, _ in self.f.provider.requests))

    def test_cleanup_metadata_marker_restriction_and_creation_drift_prevent_delete(self):
        for field, value in [('displayName', 'foreign'), ('restrictions', {}),
                             ('createTime', '2026-11-13T00:00:00Z'), ('createTime', None),
                             ('etag', ''), ('keyString', KEY_STRING)]:
            with self.subTest(field=field):
                f = Fixture()
                try:
                    self.assertTrue(f.run('main')['boundaryReached'])
                    f.provider.cleanup_drift = (field, value)
                    result = f.run('cleanup')
                    self.assertFalse(result['providerContainmentConfirmed'])
                    self.assertFalse(any(method == 'DELETE' for method, _, _ in f.provider.requests))
                    self.assertTrue(result['privateInputsAbsent'])
                    self.assertNotIn(KEY_STRING, json.dumps(result))
                finally: f.cleanup_files()

    def test_expired_cached_observation_never_reaches_http(self):
        self.f.cache_reader = lambda horizon: (_ for _ in ()).throw(RuntimeError('EXPIRED_SYNTHETIC_CACHE'))
        result = self.f.run('main')
        self.assertFalse(result['boundaryReached'])
        self.assertEqual(self.f.provider.requests, [])
        self.assertNotIn('EXPIRED_SYNTHETIC_CACHE', json.dumps(result))

    def test_persisted_clock_rollback_blocks_fresh_cleanup_before_io(self):
        self.f.run('main')
        self.f.clock.value -= 1
        before = (len(self.f.cli), len(self.f.cache), len(self.f.provider.requests))
        result = self.f.run('cleanup')
        self.assertEqual(result['failure'], 'KQ1_CLOCK')
        self.assertEqual((len(self.f.cli), len(self.f.cache), len(self.f.provider.requests)), before)
        self.assertTrue(result['privateInputsAbsent'])

    def test_root_identity_substitution_refuses_before_credentials(self):
        self.f.run('main')
        with tempfile.TemporaryDirectory(prefix='kq1-old-root-', dir='/private/tmp') as directory:
            backup = Path(directory) / 'original'
            self.f.root.rename(backup)
            shutil.copytree(backup, self.f.root)
            self.f.root.chmod(0o700)
            before = (len(self.f.cli), len(self.f.cache), len(self.f.provider.requests))
            result = self.f.run('cleanup')
            self.assertIsNotNone(result['failure'])
            self.assertEqual((len(self.f.cli), len(self.f.cache), len(self.f.provider.requests)), before)
            self.assertTrue((self.f.root / 'key-lifecycle-private.json').exists(), 'Foreign substituted custody was deleted')

    def test_main_configuration_uncertainty_survives_successful_cleanup(self):
        def drift_after_key_read():
            if self.f.provider.requests[-1][1].endswith('/keyString'):
                self.f.config = {'synthetic': 'changed-after-key-read'}
        self.f.provider.close_hook = drift_after_key_read
        main = self.f.run('main')
        self.assertTrue(main['boundaryReached'])
        self.assertFalse(main['configurationUnchanged'])
        cleanup = self.f.run('cleanup')
        self.assertEqual(cleanup['keyState'], 'CONTROL_PLANE_DELETED')
        self.assertTrue(cleanup['configurationUnchanged'])
        self.assertIn('MAIN_CONFIGURATION_UNCONFIRMED', cleanup['residuals'])
        self.assertEqual(cleanup['status'], 'KQ1_CONTAINMENT_UNCONFIRMED')

    def test_real_nested_owned_cli_timeout_and_signal_reap_before_outer_deadline(self):
        import signal
        import time
        for mode in ('timeout', 'signal'):
            with self.subTest(mode=mode), tempfile.TemporaryDirectory(prefix='kq1-nested-', dir='/private/tmp') as directory:
                marker = Path(directory) / 'inner-pid'
                outer = k.q.NativeIO(time.time, str(uuid.uuid4()))
                deadline = time.time() + 8
                try:
                    command = [sys.executable, str(Path(__file__).resolve()), '--synthetic-nested', str(marker), mode]
                    raw = outer._owned_run(command, k.python_environment(), deadline)
                    result = json.loads(raw)
                    self.assertTrue(result['processCleanupVerified'], result)
                    self.assertTrue(result['innerClosed'], result)
                    self.assertEqual(result['mainAbort'], mode == 'signal')
                    self.assertEqual(result['providerRequests'], 0)
                    self.assertLess(time.time(), deadline - 2)
                    self.assertEqual(outer.children, set())
                    pid = int(marker.read_text())
                    with self.assertRaises(ProcessLookupError): os.killpg(pid, 0)
                finally:
                    outer.close(time.time() + 2)
                    if marker.exists():
                        try: os.killpg(int(marker.read_text()), signal.SIGKILL)
                        except ProcessLookupError: pass

    def test_aggregate_source_guard_deadline_precedes_io_and_mutation(self):
        import contextlib
        import time
        real_deadline = k.acl.http_deadline
        for when in ('initial', 'mutation'):
            with self.subTest(when=when):
                f = Fixture(); calls = []; requested = []
                try:
                    def guard(scope):
                        calls.append(scope)
                        if when == 'initial' or len(calls) == 2: time.sleep(.1)
                    f.source_guard = guard
                    @contextlib.contextmanager
                    def accelerated(seconds):
                        requested.append(seconds)
                        with real_deadline(min(seconds, .03)): yield
                    with patch.object(k.acl, 'http_deadline', accelerated): result = f.run('main')
                    self.assertFalse(result['boundaryReached'])
                    self.assertTrue(requested)
                    self.assertTrue(all(0 < seconds <= 8 for seconds in requested))
                    self.assertFalse(any(method == 'POST' for method, _, _ in f.provider.requests))
                    if when == 'initial': self.assertEqual(f.cli + f.cache + f.provider.requests, [])
                    else:
                        self.assertEqual(len(f.cache), 1)
                        self.assertEqual(len(f.provider.requests), 2)
                finally: f.cleanup_files()


def synthetic_nested(path, mode):
    """Real nested process ownership and actual run_phase signal handling."""
    import signal
    import threading
    import time
    f = Fixture()
    f.clock = time.time
    f.scope = f.make_scope()
    f.root = Path('/private/tmp/p08-coordinator-' + f.scope['operationId'])
    f.provider = Provider(f.scope, f.clock)
    inner = k.q.NativeIO(time.time, f.scope['operationId'])
    timers, drivers = [], []
    class Owned:
        def _owned_run(self, argv, env, deadline):
            if mode == 'signal':
                timer = threading.Timer(.25, lambda: os.kill(os.getpid(), signal.SIGTERM))
                timer.start(); timers.append(timer)
            sleeper = 'import os,pathlib,sys,time;pathlib.Path(sys.argv[1]).write_text(str(os.getpid()));time.sleep(30)'
            return inner._owned_run([sys.executable, '-c', sleeper, path], env, min(deadline, time.time() + 3))
        def close(self, deadline): return inner.close(min(deadline, time.time() + 2))
    f.owned_io_factory = lambda *_: Owned()
    original_open = k.Driver.open
    def tracked_open(driver):
        drivers.append(driver)
        return original_open(driver)
    try:
        with patch.object(k.q, 'PROJECT_NUMBER_SHA256', f.scope['projectNumberSha256']), \
             patch('urllib.request.build_opener', side_effect=AssertionError('No HTTP expected')), \
             patch.object(k.Driver, 'open', tracked_open):
            result = k.run_phase(f.scope, 'main', owned_io_factory=f.owned_io_factory,
                                 cache_reader=f.cache_reader, source_guard=f.source_guard,
                                 config_snapshot=lambda: f.config, clock=time.time, pause=time.sleep)
        print(json.dumps({'processCleanupVerified': result['processCleanupVerified'],
                          'innerClosed': inner.closed and not inner.children,
                          'mainAbort': drivers[0].abort, 'providerRequests': len(f.provider.requests),
                          'failure': result['failure'], 'counts': result.get('counts')}))
    finally:
        for timer in timers: timer.join(timeout=1)
        inner.close(time.time() + 2)
        f.cleanup_files()


def synthetic_phase(path, phase):
    """Only a local fixture subprocess; never selects real I/O implementations."""
    data = json.loads(Path(path).read_text())
    f = Fixture(data['scope']); f.clock.value = data['now']
    state = Path(path).with_name('provider-state.json')
    f.provider.persist_path = state
    if state.exists():
        old = json.loads(state.read_text())
        f.provider.meta = old['meta']
        f.provider.create_polls, f.provider.delete_polls = old['create_polls'], old['delete_polls']
    if phase == 'watch':
        import time
        began = time.monotonic(); real_monotonic = time.monotonic
        with patch.object(k.q, 'PROJECT_NUMBER_SHA256', f.scope['projectNumberSha256']), \
             patch.object(k.time, 'time', side_effect=lambda: data['now'] + (real_monotonic() - began) * 180), \
             patch.object(k.q, 'NativeIO', side_effect=AssertionError('Watcher must not construct native I/O')), \
             patch.object(k.acl, 'read_cached_token', side_effect=AssertionError('Watcher must not read credentials')), \
             patch('urllib.request.build_opener', side_effect=AssertionError('Watcher must not use HTTP')):
            raise SystemExit(k._watch_purge(f.scope))
    if phase == 'abrupt-main':
        f.provider.abrupt = True
        f.run('main')
        raise AssertionError('Abrupt exit boundary was not reached')
    result = f.run(phase)
    print(json.dumps(result))


if __name__ == '__main__':
    if len(sys.argv) == 4 and sys.argv[1] == '--synthetic-phase':
        synthetic_phase(sys.argv[2], sys.argv[3])
    elif len(sys.argv) == 4 and sys.argv[1] == '--synthetic-nested':
        synthetic_nested(sys.argv[2], sys.argv[3])
    else:
        unittest.main()
