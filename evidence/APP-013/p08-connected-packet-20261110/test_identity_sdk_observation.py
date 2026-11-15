"""SD3 prerequisite: can optional receipts fail without blocking custody?

Uses disposable files and synthetic SDK responses. The real SDK entry test
blocks network and credential loading; no provider operation is invoked.
"""
import json
import copy
import io
import os
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
import time
import unittest
import uuid
from types import SimpleNamespace
from unittest.mock import patch

import iq1_identity_boundary as k
import identity_sdk_observation as sd


def sdk_types():
    paths = list(sys.path)
    try:
        sys.path[:0] = [str(sd.SDK.parent), str(sd.SDK.parent / 'third_party')]
        from apitools.base.py import base_api, encoding, http_wrapper
        from googlecloudsdk.generated_clients.apis.iam.v1 import iam_v1_messages as messages
        return base_api, encoding, http_wrapper, messages
    finally:
        sys.path[:] = paths


def fixture():
    base, encoding, http, messages = sdk_types()
    client = SimpleNamespace(response_encoding=None, response_type_model=None, MESSAGES_MODULE=messages)
    client.DeserializeMessage = lambda t, d: base.BaseApiClient.DeserializeMessage(client, t, d)
    client.ProcessResponse = lambda cfg, result: result
    service = base.BaseApiService(client)
    config = SimpleNamespace(method_id='iam.projects.serviceAccounts.get', response_type_name='ServiceAccount',
                             request_type_name='IamProjectsServiceAccountsGetRequest')
    request = SimpleNamespace(name='projects/-/serviceAccounts/' + sd.IDENTITY)
    return base, encoding, http, service, config, request


class ResponseTests(unittest.TestCase):
    def test_actual_decoder_same_response_and_original_once(self):
        base, enc, http, service, config, request = fixture()
        original = base.BaseApiService.ProcessHttpResponse
        for field, expected in [({'disabled': True}, ('BOOL_TRUE', 'BOOL_TRUE')),
                                ({'disabled': False}, ('BOOL_FALSE', 'BOOL_FALSE')),
                                ({}, ('MISSING', 'MISSING')),
                                ({'disabled': None}, ('NULL', 'MISSING'))]:
            content = json.dumps({'email': sd.IDENTITY, **field})
            response = http.Response(info={'status': '200'}, content=content, request_url='https://example.invalid')
            calls = []
            def tracked(s, c, r, q=None):
                calls.append((s, c, r, q))
                return original(s, c, r, q)
            with patch.object(base.BaseApiService, 'ProcessHttpResponse', tracked):
                cap = sd.Capture()
                with cap.install(base.BaseApiService, enc.MessageToDict):
                    result = service.ProcessHttpResponse(config, response, request)
                self.assertIs(base.BaseApiService.ProcessHttpResponse, tracked)
            self.assertEqual(calls, [(service, config, response, request)])
            self.assertEqual(response.content, content)
            self.assertEqual((cap.value['disabled'], cap.value['decoded']), expected)
            self.assertEqual(result.email, sd.IDENTITY)

    def test_wrong_method_request_and_identity_are_not_observed(self):
        base, enc, http, service, config, request = fixture()
        for key in ['method_id', 'response_type_name', 'request_type_name', 'name']:
            cfg, req = copy.copy(config), copy.copy(request)
            setattr(req if key == 'name' else cfg, key, 'foreign')
            marker = object()
            with patch.object(base.BaseApiService, 'ProcessHttpResponse', return_value=marker) as original:
                cap = sd.Capture()
                with cap.install(base.BaseApiService, enc.MessageToDict):
                    self.assertIs(service.ProcessHttpResponse(cfg, object(), req), marker)
                original.assert_called_once()
                self.assertEqual(cap.value, {'status': 'NO_MATCH'})

    def test_original_error_is_preserved_without_body_or_headers(self):
        base, enc, http, service, config, request = fixture()
        response = http.Response(info={'status': '200', 'authorization': 'PRIVATE_CANARY'},
                                 content=json.dumps({'email': sd.IDENTITY, 'disabled': True}), request_url='https://example.invalid')
        error = ValueError('PRIVATE_CANARY')
        with patch.object(base.BaseApiService, 'ProcessHttpResponse', side_effect=error) as original:
            cap = sd.Capture()
            with cap.install(base.BaseApiService, enc.MessageToDict):
                with self.assertRaises(ValueError) as seen:
                    service.ProcessHttpResponse(config, response, request)
            self.assertIs(seen.exception, error)
            original.assert_called_once()
        self.assertEqual(cap.value['decoder'], 'RAISED')
        self.assertNotIn('PRIVATE_CANARY', json.dumps(cap.value))

    def test_multiple_responses_are_unavailable_not_last_response_wins(self):
        base, enc, http, service, config, request = fixture()
        cap = sd.Capture()
        with cap.install(base.BaseApiService, enc.MessageToDict):
            for disabled in (True, False):
                response = http.Response(info={'status': '200'}, content=json.dumps({'email': sd.IDENTITY, 'disabled': disabled}), request_url='https://example.invalid')
                service.ProcessHttpResponse(config, response, request)
        self.assertEqual(cap.value, {'status': 'MULTIPLE'})

    def test_classifier_privacy_malformed_and_bounds(self):
        cases = [(b'[]', 'OTHER'), (b'{', 'INVALID'), (b'{}' * 40000, 'TOO_LARGE'),
                 (b'{"disabled":true,"disabled":false}', 'INVALID'),
                 (b'{"disabled":NaN}', 'INVALID'), (b'\xff', 'INVALID')]
        for raw, label in cases:
            self.assertEqual(sd.classify(raw)['shape'], label)
        for value in [1, 0, 'PRIVATE_CANARY', {'nested': 'PRIVATE_CANARY'}]:
            labels = sd.classify(json.dumps({'email': sd.IDENTITY, 'disabled': value}))
            self.assertEqual(labels['disabled'], 'OTHER')
            self.assertNotIn('PRIVATE_CANARY', json.dumps(labels))

    def test_classifier_failure_preserves_original_result(self):
        base, enc, http, service, config, request = fixture()
        marker = object()
        with patch.object(sd, 'classify', side_effect=ValueError('PRIVATE_CANARY')):
            with patch.object(base.BaseApiService, 'ProcessHttpResponse', return_value=marker) as original:
                cap = sd.Capture()
                with cap.install(base.BaseApiService, enc.MessageToDict):
                    self.assertIs(service.ProcessHttpResponse(config, SimpleNamespace(content=b'{}', status_code=200), request), marker)
                original.assert_called_once()
                self.assertEqual(cap.value, {'status': 'UNAVAILABLE'})

    def test_http_error_calls_original_once_and_preserves_exception(self):
        base, enc, http, service, config, request = fixture()
        response = http.Response(info={'status': '403'}, content='{"error":"PRIVATE_CANARY"}', request_url='https://example.invalid')
        cap = sd.Capture()
        with cap.install(base.BaseApiService, enc.MessageToDict):
            with self.assertRaises(Exception):
                service.ProcessHttpResponse(config, response, request)
        self.assertEqual(cap.value, {'status': 'UNAVAILABLE'})


class StoreTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name) / 'observations'
        self.store = sd.Store(str(uuid.uuid4()), [1, 2], directory=self.path)
        self.addCleanup(lambda: self.store.close() if self.store.fd is not None else None)

    def test_child_death_leaves_only_owned_partial_receipt(self):
        binding = self.store.prepare('main-2')
        path = self.path / 'main-2.json'
        child = subprocess.Popen([k.p.PYTHON, '-I', '-B', '-c',
            "import pathlib,sys,time; pathlib.Path(sys.argv[1]).write_bytes(b'{'); print('READY',flush=True); time.sleep(10)", str(path)],
            stdout=subprocess.PIPE)
        try:
            self.assertEqual(child.stdout.readline(), b'READY\n')
            child.kill()
            child.wait(timeout=5)
        finally:
            if child.poll() is None:
                child.kill()
                child.wait(timeout=5)
            child.stdout.close()
        self.assertEqual(self.store.read(binding), {'status': 'UNAVAILABLE'})
        self.assertTrue(self.store.close())

    def test_concurrent_operation_cannot_adopt_receipt(self):
        other = sd.Store(str(uuid.uuid4()), [1, 2], directory=Path(self.temp.name) / 'other')
        try:
            first = self.store.prepare('main-2')
            second = other.prepare('main-2')
            sd.publish(first, {'status': 'NO_MATCH'}, directory=self.path)
            self.assertEqual(other.read(first), {'status': 'UNAVAILABLE'})
            self.assertEqual(self.store.read(first), {'status': 'NO_MATCH'})
            self.assertNotEqual(first['nonce'], second['nonce'])
        finally:
            self.assertTrue(other.close())

    def test_valid_receipt_nonce_binding_and_exact_cleanup(self):
        binding = self.store.prepare('main-2')
        sd.publish(binding, {'status': 'NO_MATCH'}, directory=self.path)
        self.assertEqual(self.store.read(binding), {'status': 'NO_MATCH'})
        with self.assertRaises(ValueError):
            sd.publish(binding, {'status': 'NO_MATCH'}, directory=self.path)
        self.assertTrue(self.store.close())
        self.assertFalse(self.path.exists())

    def test_partial_owned_file_is_unavailable_and_removed_without_journal_change(self):
        binding = self.store.prepare('main-4')
        (self.path / 'main-4.json').write_bytes(b'{"')
        self.assertEqual(self.store.read(binding), {'status': 'UNAVAILABLE'})
        journal = k.Journal(Path(self.temp.name) / 'journal', {}, create=True)
        self.assertEqual(journal.inspect(), journal.identity)
        self.assertTrue(self.store.close())

    def test_wrong_nonce_is_not_adopted_or_deleted(self):
        binding = self.store.prepare('main-2')
        wrong = {**binding, 'nonce': '0' * 32}
        sd.publish(wrong, {'status': 'NO_MATCH'}, directory=self.path)
        self.assertEqual(self.store.read(binding), {'status': 'UNAVAILABLE'})
        self.assertFalse(self.store.close())
        self.assertTrue((self.path / 'main-2.json').exists())

    def test_replaced_directory_is_not_followed_or_deleted(self):
        binding = self.store.prepare('main-2')
        old = self.path.with_name('old')
        self.path.rename(old)
        self.path.mkdir(mode=0o700)
        self.assertEqual(self.store.read(binding), {'status': 'UNAVAILABLE'})
        self.assertFalse(self.store.close())
        self.assertTrue(self.path.exists())
        self.assertTrue((old / 'main-2.json').exists())

    def test_foreign_symlink_and_mode_are_not_deleted(self):
        binding = self.store.prepare('main-2')
        target = self.path / 'main-2.json'
        target.unlink()
        target.symlink_to('/nonexistent-sd3')
        self.assertEqual(self.store.read(binding), {'status': 'UNAVAILABLE'})
        self.assertFalse(self.store.close())
        self.assertTrue(target.is_symlink())

    def test_oversize_and_wrong_mode_refuse_labels(self):
        binding = self.store.prepare('main-2')
        target = self.path / 'main-2.json'
        target.write_bytes(b'x' * 4097)
        self.assertEqual(self.store.read(binding), {'status': 'UNAVAILABLE'})
        target.chmod(0o644)
        self.assertEqual(self.store.read(binding), {'status': 'UNAVAILABLE'})
        self.assertFalse(self.store.close())
        self.assertTrue(target.exists())

    def test_wrong_owner_refuses_publication_and_read(self):
        binding = self.store.prepare('main-2')
        with patch.object(sd.os, 'getuid', return_value=os.getuid() + 1):
            with self.assertRaises(ValueError):
                sd.publish(binding, {'status': 'NO_MATCH'}, directory=self.path)
            self.assertEqual(self.store.read(binding), {'status': 'UNAVAILABLE'})
        self.assertTrue(self.store.close())

    def test_preexisting_directory_does_not_gain_ownership(self):
        other = sd.Store(self.store.operation, [1, 2], directory=self.path)
        self.assertIsNone(other.prepare('main-2'))
        self.assertFalse(other.close())
        self.assertTrue(self.path.exists())

    def test_cap_duplicate_and_absent_receipts(self):
        for slot in sorted(sd.SLOTS):
            binding = self.store.prepare(slot)
            self.assertIsNotNone(binding)
            self.assertEqual(self.store.read(binding), {'status': 'UNAVAILABLE'})
        self.assertIsNone(self.store.prepare('main-2'))
        self.assertIsNone(self.store.prepare('main-3'))
        self.assertEqual(len(self.store.records), 9)
        self.assertTrue(self.store.close())

    def test_permission_failure_is_optional_without_created_files(self):
        with patch.object(Path, 'mkdir', side_effect=PermissionError()):
            other = sd.Store(str(uuid.uuid4()), [1, 2], directory=self.path.with_name('absent'))
        self.assertIsNone(other.prepare('main-2'))
        self.assertTrue(other.close())

    def test_write_failure_leaves_only_owned_partial_safe_data(self):
        binding = self.store.prepare('main-2')
        original = sd.os.write
        def broken(fd, data):
            original(fd, data[:2])
            raise OSError('PRIVATE_CANARY')
        with patch.object(sd.os, 'write', side_effect=broken):
            with self.assertRaises(OSError):
                sd.publish(binding, {'status': 'NO_MATCH'}, directory=self.path)
        self.assertEqual(self.store.read(binding), {'status': 'UNAVAILABLE'})
        self.assertTrue(self.store.close())


PROBE = """import sys, os, json, tempfile, socket
from pathlib import Path
sys.path.insert(0, str(Path.cwd()/'evidence/APP-013/p08-connected-packet-20261110'))
import identity_sdk_observation as sd
import test_identity_sdk_observation as t
sys.path[:0]=[str(sd.SDK.parent),str(sd.SDK.parent/'third_party')]
from googlecloudsdk.api_lib.iam import util
from googlecloudsdk.core.credentials import store
base,enc,http,service,config,request=t.fixture()
def denied(*a,**kw): raise AssertionError('EXTERNAL_ACCESS_FORBIDDEN')
socket.socket.connect=denied
store.Load=denied
from types import SimpleNamespace
def get(req):
 return service.ProcessHttpResponse(config,http.Response(info={'status':'200'},content=json.dumps({'email':sd.IDENTITY,'disabled':None,'uniqueId':'123456789012345678901'}),request_url='https://example.invalid'),req)
util.GetClientAndMessages=lambda:(SimpleNamespace(projects_serviceAccounts=SimpleNamespace(Get=get)),t.sdk_types()[3])
sd.main(['--binding',os.environ['SD3_TEST_BINDING'],'--','iam','service-accounts','describe',sd.IDENTITY,'--project','signmons','--format=json(email,disabled,uniqueId)'])
"""


class WrapperTests(unittest.TestCase):
    def test_actual_sdk_entry_with_network_and_credentials_denied(self):
        store = sd.Store(str(uuid.uuid4()), [1, 2])
        self.addCleanup(lambda: store.close() if store.fd is not None else None)
        binding = store.prepare('main-2')
        self.assertIsNotNone(binding)
        with tempfile.TemporaryDirectory() as config:
            env = dict(os.environ, CLOUDSDK_CONFIG=config,
                       CLOUDSDK_CORE_DISABLE_USAGE_REPORTING='true',
                       CLOUDSDK_COMPONENT_MANAGER_DISABLE_UPDATE_CHECK='true',
                       SD3_TEST_BINDING=sd.encode_binding(binding))
            result = subprocess.run([k.p.PYTHON, '-I', '-B', '-c', PROBE],
                                    cwd=k.p.B, env=env, capture_output=True, timeout=20)
        self.assertEqual(result.returncode, 0, result.stderr.decode())
        output = json.loads(result.stdout)
        self.assertNotIn('disabled', output)
        labels = store.read(binding)
        self.assertEqual((labels['disabled'], labels['decoded']), ('NULL', 'MISSING'))
        self.assertTrue(store.close())


    def test_exact_arguments_only(self):
        argv = k.commands()['identity'][1:]
        self.assertTrue(sd.valid_arguments(argv))
        for bad in [argv + ['--log-http'], ['auth', 'print-access-token'], argv[:-1]]:
            with self.assertRaises(ValueError):
                sd.execute(bad, None, service_class=object, message_to_dict=None, run_sdk=lambda _: self.fail('SDK ran'))

    def test_publication_failure_does_not_change_stdout_or_exit(self):
        base, enc, _, _, _, _ = fixture()
        with tempfile.TemporaryDirectory() as directory:
            store = sd.Store(str(uuid.uuid4()), [1, 2], directory=Path(directory) / 'd')
            binding = store.prepare('main-2')
            def run(argv):
                print('SDK_OUTPUT')
                raise SystemExit(7)
            output = io.StringIO()
            import contextlib
            with contextlib.redirect_stdout(output):
                with self.assertRaises(SystemExit) as seen:
                    sd.execute(k.commands()['identity'][1:], binding, service_class=base.BaseApiService,
                               message_to_dict=enc.MessageToDict, run_sdk=run,
                               publish_receipt=lambda *a: (_ for _ in ()).throw(OSError('PRIVATE_CANARY')))
            self.assertEqual(seen.exception.code, 7)
            self.assertEqual(output.getvalue(), 'SDK_OUTPUT\n')
            self.assertTrue(store.close())


class PublicationPrerequisiteTests(unittest.TestCase):
    def test_complete_existing_reservation_preserves_journal_inspection(self):
        with tempfile.TemporaryDirectory() as directory:
            journal = k.Journal(Path(directory) / 'root', {}, create=True)
            k.inv.reserve(journal.root / 'main-4.json', {'safe': 'RETURNED'})
            self.assertEqual(journal.inspect(), journal.identity)

    def test_interrupted_existing_reservation_blocks_next_custody_gate(self):
        with tempfile.TemporaryDirectory() as directory:
            journal = k.Journal(Path(directory) / 'root', {}, create=True)
            # An already-allowed name isolates publication from filename policy.
            # A proposed optional sidecar would encounter the same JSON check.
            path = journal.root / 'main-4.json'
            original_write = k.inv.os.write

            def interrupted_write(fd, data):
                original_write(fd, data[:2])
                raise OSError('synthetic interrupted write')

            with patch.object(k.inv.os, 'write', side_effect=interrupted_write):
                with self.assertRaises(OSError):
                    k.inv.reserve(path, {'safe': 'RETURNED'})
            self.assertTrue(path.exists())
            self.assertEqual(path.read_bytes(), b'{"')
            # Boundary.gate calls this same inspect before cleanup dispatch.
            with self.assertRaises(json.JSONDecodeError):
                journal.inspect()


if __name__ == '__main__':
    unittest.main()
