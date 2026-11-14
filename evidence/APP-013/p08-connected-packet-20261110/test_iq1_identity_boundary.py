"""Actual serializers/adapter/process boundaries; synthetic data, no native calls."""
import copy
import datetime
import json
import os
from pathlib import Path
import signal
import subprocess
import tempfile
import time
import unittest
import uuid
from unittest.mock import patch

import iq1_identity_boundary as k

NUMBER = '123456789012'
UID = '123456789012345678901'
CONFIG = 'a' * 64


def scope(now):
    def iso(delta):
        return datetime.datetime.fromtimestamp(now + delta, datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')
    return {'version': 1, 'action': k.ACTION, 'operationId': str(uuid.uuid4()),
            'sourceCommit': 'b' * 40, 'manifestSha256': 'c' * 64, 'configSha256': CONFIG,
            'commands': k.commands(), 'wrappedCommands': {n: k.wrapped(v) for n, v in k.commands().items()},
            'window': {n: iso(d) for n, d in [('start', -1), ('cutoff', 60), ('workEnd', 120),
                                             ('cleanupEnd', 800), ('purgeEnd', 930)]},
            'limits': dict(k.LIMITS), 'sdkException': k.SDK_EXCEPTION,
            'automaticRetryAllowed': False, 'allowanceUsd': 0}


class Fake:
    def __init__(self):
        self.calls = []
        self.disabled = True
        self.uid = UID
        self.close_ok = True
        self.hook = None
        self.closed = 0

    def run(self, argv, deadline):
        name = next(n for n, v in k.commands().items() if v == list(argv))
        self.calls.append(name)
        if self.hook:
            replacement = self.hook(name, len(self.calls))
            if replacement is not None:
                return replacement
        if name == 'owner':
            value = [{'account': k.m.OWNER, 'status': 'ACTIVE'}]
        elif name == 'project':
            value = {'projectId': k.m.PROJECT, 'projectNumber': NUMBER, 'lifecycleState': 'ACTIVE'}
        elif name == 'identity':
            value = {'email': k.m.IDENTITY, 'uniqueId': self.uid, 'disabled': self.disabled}
        elif name == 'readback':
            value = {'email': k.m.IDENTITY, 'disabled': self.disabled}
        else:
            self.disabled = name == 'disable'
            value = []
        return json.dumps(value).encode()

    def close(self, deadline):
        self.closed += 1
        return self.close_ok


def sequential(driver):
    for i in range(5):
        driver.step(i)


class WorkerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.now = time.time()
        self.s = scope(self.now)
        self.j = k.Journal(Path(self.temp.name) / 'root', self.s, create=True)
        self.fake = Fake()
        self.guard = lambda s: None
        self.config = lambda: CONFIG
        self.clock = lambda: self.now
        self.patch = patch.object(k.q, 'PROJECT_NUMBER_SHA256', k.m.digest(NUMBER))
        self.patch.start()
        self.addCleanup(self.patch.stop)

    def run_case(self, coordinate=sequential):
        result = k.run_worker(self.s, self.j, factory=lambda: self.fake, guard=self.guard,
                              config=self.config, coordinate=coordinate, clock=self.clock)
        self.assertLessEqual(self.fake.calls.count('enable'), 1)
        self.assertLessEqual(self.fake.calls.count('disable'), 1)
        self.assertLessEqual(len(self.fake.calls), 11)
        raw = ''.join(f.read_text() for f in self.j.root.iterdir())
        self.assertNotIn(UID, raw)
        self.assertNotIn('PRIVATE_CANARY', raw)
        return result

    def test_positive_exact_counts_and_real_serialization(self):
        r = self.run_case()
        self.assertEqual(r['status'], 'QUALIFIED_AND_CLOSED')
        self.assertEqual(r['counts'], {'main': 5, 'cleanup': 6})
        self.assertEqual(self.fake.calls, ['owner', 'project', 'identity', 'enable', 'readback',
                                         'owner', 'project', 'identity', 'disable', 'readback', 'identity'])
        self.assertTrue(self.fake.disabled)
        self.assertEqual(self.fake.closed, 2)

    def test_initially_enabled_has_no_mutation(self):
        self.fake.disabled = False
        r = self.run_case()
        self.assertEqual(r['failure'], 'IQ1_INITIAL_STATE')
        self.assertEqual(len(self.fake.calls), 3)
        self.assertFalse(r['restorationReadback'])

    def test_wrong_owner(self):
        self.fake.hook = lambda name, i: b'[]' if name == 'owner' else None
        self.assertEqual(self.run_case()['failure'], 'IQ1_OWNER')

    def test_wrong_project(self):
        self.fake.hook = lambda name, i: b'{}' if name == 'project' else None
        self.assertEqual(self.run_case()['failure'], 'IQ1_PROJECT')

    def test_missing_metadata(self):
        self.fake.hook = lambda name, i: b'{}' if name == 'identity' else None
        self.assertEqual(self.run_case()['failure'], 'IQ1_METADATA')

    def test_cleanup_replaced_uid_no_disable(self):
        def hook(name, i):
            if i == 8:
                self.fake.uid = '999999999999999999999'
        self.fake.hook = hook
        r = self.run_case()
        self.assertEqual(r['cleanupFailure'], 'IQ1_UID')
        self.assertNotIn('disable', self.fake.calls)

    def test_lost_enable_ack_is_not_erased_by_cleanup(self):
        def hook(name, i):
            if name == 'enable':
                self.fake.disabled = False
                raise RuntimeError('PRIVATE_CANARY')
        self.fake.hook = hook
        r = self.run_case()
        self.assertTrue(r['restorationReadback'])
        self.assertIn('ENABLE_OUTCOME_UNKNOWN', r['residuals'])
        self.assertEqual(r['status'], 'CONTAINMENT_UNCONFIRMED')

    def test_malformed_enable_ack_closes_once(self):
        self.fake.hook = lambda name, i: b'PRIVATE_CANARY' if name == 'enable' else None
        r = self.run_case()
        self.assertTrue(r['enableOutcomeUnknown'])
        self.assertEqual(self.fake.calls.count('disable'), 1)

    def test_readback_failure_keeps_safe_rb1_code(self):
        self.fake.hook = lambda name, i: b'null' if i == 5 else None
        r = self.run_case()
        self.assertEqual(r['failure'], 'RUNTIME_IDENTITY_OUTPUT_SHAPE')
        self.assertEqual(r['status'], 'FAILED_AND_CLOSED')

    def test_cleanup_disagreement_stays_unknown(self):
        self.fake.hook = lambda name, i: json.dumps({'email': k.m.IDENTITY, 'disabled': False}).encode() if i == 10 else None
        r = self.run_case()
        self.assertEqual(r['cleanupFailure'], 'RUNTIME_IDENTITY_STATE_MISMATCH')
        self.assertFalse(r['restorationReadback'])

    def test_final_uid_disagreement_stays_unknown(self):
        def hook(name, i):
            if i == 11:
                self.fake.uid = '999999999999999999999'
        self.fake.hook = hook
        self.assertEqual(self.run_case()['cleanupFailure'], 'IQ1_UID')

    def test_interrupt_before_intent_no_mutation(self):
        def coordinate(driver):
            driver.step(0)
            raise KeyboardInterrupt()
        r = self.run_case(coordinate)
        self.assertEqual(r['failure'], 'IQ1_INTERRUPTED')
        self.assertFalse(r['restorationReadback'])

    def test_interrupt_after_intent_restores(self):
        def coordinate(driver):
            for i in range(4):
                driver.step(i)
            raise KeyboardInterrupt()
        self.assertTrue(self.run_case(coordinate)['restorationReadback'])

    def test_process_unknown_blocks_disable(self):
        def coordinate(driver):
            sequential(driver)
            self.fake.close_ok = False
        r = self.run_case(coordinate)
        self.assertEqual(r['cleanupFailure'], 'IQ1_PROCESS')
        self.assertNotIn('disable', self.fake.calls)

    def test_source_drift_blocks_before_transport(self):
        def guard(s):
            raise k.Stop('IQ1_SOURCE')
        self.guard = guard
        self.assertEqual(self.run_case()['failure'], 'IQ1_SOURCE')
        self.assertEqual(self.fake.calls, [])

    def test_configuration_drift_after_enable_blocks_cleanup(self):
        def coordinate(driver):
            sequential(driver)
            self.config = lambda: 'b' * 64
            driver.config = self.config
        self.assertIn('CONFIGURATION_CHANGED', self.run_case(coordinate)['residuals'])

    def test_clock_rollback_is_not_success(self):
        def coordinate(driver):
            sequential(driver)
            self.now -= 1
        self.assertEqual(self.run_case(coordinate)['cleanupFailure'], 'IQ1_CLOCK')

    def test_deadline_blocks_main_but_allows_reserved_cleanup(self):
        def coordinate(driver):
            for i in range(4):
                driver.step(i)
            self.now += 121
            driver.step(4)
        r = self.run_case(coordinate)
        self.assertEqual(r['failure'], 'IQ1_DEADLINE')
        self.assertTrue(r['restorationReadback'])

    def test_disable_reservation_prevents_repeat(self):
        def coordinate(driver):
            sequential(driver)
            self.j.put('disable.json', self.j.binding())
        r = self.run_case(coordinate)
        self.assertFalse(r['restorationReadback'])
        self.assertNotIn('disable', self.fake.calls)

    def test_worker_replay_refuses(self):
        self.run_case()
        with self.assertRaises(FileExistsError):
            self.run_case()

    def test_ready_exists_before_enable(self):
        def hook(name, i):
            if name == 'enable':
                self.assertEqual(k.inv.read(self.j.root / 'ready.json'), self.j.binding())
        self.fake.hook = hook
        self.assertEqual(self.run_case()['status'], 'QUALIFIED_AND_CLOSED')

    def test_command_sequence_rejects_forged_mutation(self):
        def coordinate(driver):
            driver.send(k.commands()['disable'])
        self.assertEqual(self.run_case(coordinate)['failure'], 'IQ1_COMMAND')
        self.assertFalse(self.fake.calls)

    def test_cleanup_fresh_owner_refusal(self):
        self.fake.hook = lambda name, i: b'[]' if i == 6 else None
        r = self.run_case()
        self.assertEqual(r['cleanupFailure'], 'IQ1_OWNER')
        self.assertNotIn('disable', self.fake.calls)

    def test_cleanup_fresh_project_refusal(self):
        self.fake.hook = lambda name, i: b'{}' if i == 7 else None
        self.assertEqual(self.run_case()['cleanupFailure'], 'IQ1_PROJECT')
        self.assertNotIn('disable', self.fake.calls)

    def test_empty_mutation_ack_supported_by_actual_serializer(self):
        def hook(name, i):
            if name in ('enable', 'disable'):
                self.fake.disabled = name == 'disable'
                return b''
        self.fake.hook = hook
        self.assertEqual(self.run_case()['status'], 'QUALIFIED_AND_CLOSED')

    def test_lost_disable_ack_not_retried(self):
        def hook(name, i):
            if name == 'disable':
                self.fake.disabled = True
                raise RuntimeError('PRIVATE_CANARY')
        self.fake.hook = hook
        r = self.run_case()
        self.assertFalse(r['restorationReadback'])
        self.assertEqual(self.fake.calls.count('disable'), 1)

    def test_cleanup_deadline_refuses_mutation(self):
        def coordinate(driver):
            sequential(driver)
            self.now += 801
        r = self.run_case(coordinate)
        self.assertIn('CLEANUP_DEADLINE', r['residuals'])
        self.assertNotIn('disable', self.fake.calls)


class BoundaryTests(unittest.TestCase):
    def test_rb1_actual_serializer_matrix(self):
        cases = [(False, True), (True, False), (None, False), (0, True), (1, False), ('false', False)]
        for value, success in cases:
            with self.subTest(value=value):
                cloud = k.Cloud(lambda argv: json.dumps({'email': k.m.IDENTITY, 'disabled': value}).encode())
                adapter = object.__new__(k.entry.RuntimeAdapter)
                adapter.cloud = cloud.cloud
                if success:
                    self.assertTrue(adapter.readback('identity', k.m.IDENTITY, True, {}, 0))
                else:
                    with self.assertRaises(k.entry.c.Stop):
                        adapter.readback('identity', k.m.IDENTITY, True, {}, 0)
        for raw in (b'[]', b'null', b'PRIVATE_CANARY'):
            cloud = k.Cloud(lambda argv: raw)
            adapter.cloud = cloud.cloud
            with self.assertRaises(k.entry.c.Stop):
                adapter.readback('identity', k.m.IDENTITY, True, {}, 0)
        adapter.cloud = k.Cloud(lambda argv: json.dumps({'email': k.m.IDENTITY}).encode()).cloud
        self.assertTrue(adapter.readback('identity', k.m.IDENTITY, True, {}, 0))

    def test_interfaces_denied(self):
        cloud = k.Cloud(lambda argv: self.fail('transport called'))
        for name in ('sql', 'https', 'credentials', 'ensure_owner', 'child'):
            with self.assertRaises(k.Stop):
                getattr(cloud, name)()

    def test_wrapper_exact_scope_and_no_fallback(self):
        for vector in k.commands().values():
            actual = k.wrapped(vector)
            self.assertEqual(actual[:7], [k.SANDBOX, '-p', k.PROFILE, k.p.PYTHON, '-I', '-B', '-S'])
            self.assertEqual(actual[8:], vector[1:])
        for vector in (['/usr/bin/true'], [k.q.GCLOUD, 'auth', 'print-access-token'],
                       [*k.commands()['enable'], '--project=other']):
            with self.assertRaises(k.Stop):
                k.wrapped(vector)

    def test_scope_pins_and_expiry(self):
        now = time.time()
        original = scope(now)
        for field, value in [('automaticRetryAllowed', True), ('allowanceUsd', 1),
                             ('sdkException', ''), ('action', 'OTHER'), ('version', True)]:
            candidate = copy.deepcopy(original)
            candidate[field] = value
            with self.subTest(field=field), self.assertRaises(k.Stop):
                k.validate(candidate, now, True)
        with self.assertRaises(k.Stop):
            k.validate(original, now + 61, True)
        original['window']['cleanupEnd'] = original['window']['workEnd']
        with self.assertRaises(k.Stop):
            k.validate(original, now, True)

    def test_authority_before_native_hooks(self):
        s = scope(time.time())
        calls = []
        raw = json.dumps({'decision': k.DECISION, 'scopeSha256': k.digest(s),
                          'operationId': s['operationId'], 'externalActionAuthorized': True,
                          'independentCleanupAuthorized': True, 'sdkException': k.SDK_EXCEPTION,
                          'paymentAuthorized': False}).encode()
        envelope = {'scope': s, 'decision': {'commit': 'a' * 40,
                    'path': 'APP013_P08_IQ1_EXTERNAL_20261114_12345678.json', 'sha256': k.digest(raw)}}
        self.assertEqual(k.authorize(envelope, time.time(), lambda *x: raw,
                                     lambda s: calls.append('guard')), s)
        envelope['decision']['sha256'] = '0' * 64
        with self.assertRaises(k.Stop):
            k.authorize(envelope, time.time(), lambda *x: raw, lambda s: self.fail('guard called'))
        self.assertEqual(calls, ['guard'])
        numeric = json.loads(raw)
        numeric['externalActionAuthorized'] = 1
        numeric_raw = json.dumps(numeric).encode()
        envelope['decision']['sha256'] = k.digest(numeric_raw)
        with self.assertRaises(k.Stop):
            k.authorize(envelope, time.time(), lambda *x: numeric_raw, lambda s: self.fail('guard called'))

    def test_custody_symlink_and_foreign_inventory(self):
        with tempfile.TemporaryDirectory() as directory:
            s = scope(time.time())
            root = Path(directory) / 'r'
            journal = k.Journal(root, s, True)
            (root / 'secret').write_text('PRIVATE_CANARY')
            with self.assertRaises(k.Stop):
                journal.inspect()
            (root / 'secret').unlink()
            (root / 'result.json').symlink_to('/tmp/nonexistent')
            with self.assertRaises(k.Stop):
                journal.inspect()

    def test_lease_concurrent_refuses(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'lease'
            with k.lease(path):
                with self.assertRaises(k.Stop):
                    with k.lease(path):
                        self.fail('duplicate lease')
            with k.lease(path):
                pass

    def test_unknown_exception_does_not_persist_raw(self):
        for error in (RuntimeError('PRIVATE_CANARY'), k.Stop({'PRIVATE_CANARY': 1}), k.Stop('PRIVATE_CANARY')):
            self.assertEqual(k.code(error), 'IQ1_UNKNOWN')

    def test_wrapped_command_profile_and_interpreter_drift_refused(self):
        for index in (0, 2, 3, 7):
            s = scope(time.time())
            s['wrappedCommands']['enable'][index] = '/foreign'
            with self.subTest(index=index), self.assertRaises(k.Stop):
                k.validate(s, time.time(), True)

    def test_manifest_hash_drift_refuses_before_dependency_checks(self):
        s = scope(time.time())
        s['manifestSha256'] = '0' * 64
        with self.assertRaises(k.Stop):
            k.source_guard(s, committed=False)

    def test_replaced_root_inode_refused(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / 'root'
            journal = k.Journal(root, scope(time.time()), True)
            root.rename(Path(directory) / 'old')
            root.mkdir(mode=0o700)
            with self.assertRaises(k.Stop):
                journal.inspect()

    def test_foreign_result_binding_is_unknown(self):
        with tempfile.TemporaryDirectory() as directory:
            journal = k.Journal(Path(directory) / 'r', scope(time.time()), True)
            journal.put('result.json', {'status': 'QUALIFIED_AND_CLOSED', 'operationId': 'foreign'})
            self.assertEqual(k.read_result(journal)['status'], 'CONTAINMENT_UNCONFIRMED')

    def test_modified_safe_receipt_is_not_accepted(self):
        with tempfile.TemporaryDirectory() as directory:
            journal = k.Journal(Path(directory) / 'r', scope(time.time()), True)
            journal.put('ready.json', journal.binding())
            (journal.root / 'ready.json').write_text('{}')
            with self.assertRaises(k.Stop):
                journal.inspect()

    def test_unapproved_native_cli_never_constructs_transport(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'envelope.json'
            k.inv.reserve(path, {'scope': {}, 'decision': {}})
            with patch.object(k, 'NativeTransport', side_effect=AssertionError('native hook constructed')):
                with self.assertRaises(k.Stop):
                    k.native_main(['--run', str(path)])


class ProcessTests(unittest.TestCase):
    def test_missing_sandbox_has_no_unsandboxed_fallback(self):
        with patch.object(k, 'SANDBOX', '/nonexistent-iq1-sandbox'):
            transport = k.NativeTransport(scope(time.time()))
            with self.assertRaises(FileNotFoundError):
                transport.run(k.commands()['owner'], time.time() + 8)
            self.assertTrue(transport.close(time.time() + 3))

    def test_actual_wrapped_transport_with_disposable_script(self):
        with tempfile.TemporaryDirectory() as directory:
            script = Path(directory) / 'gcloud.py'
            script.write_text('import json,sys;print(json.dumps(sys.argv[1:]))')
            with patch.object(k, 'SDK', script):
                transport = k.NativeTransport(scope(time.time()))
                vector = k.commands()['owner']
                raw = transport.run(vector, time.time() + 8)
                self.assertEqual(json.loads(raw), vector[1:])
                self.assertTrue(transport.close(time.time() + 3))

    def test_main_sigkill_still_runs_independent_cleanup(self):
        killed = ('import sys,os,signal\nfor i in range(4):\n print(i,flush=True)\n'
                  ' assert sys.stdin.readline()=="OK\\n"\nos.kill(os.getpid(),signal.SIGKILL)\n')
        with tempfile.TemporaryDirectory() as directory, patch.object(k, 'COORDINATOR', killed), \
                patch.object(k.q, 'PROJECT_NUMBER_SHA256', k.m.digest(NUMBER)):
            s = scope(time.time())
            fake = Fake()
            journal = k.Journal(Path(directory) / 'root', s, True)
            r = k.run_worker(s, journal, factory=lambda: fake, guard=lambda s: None,
                             config=lambda: CONFIG, coordinate=k.coordinator)
            self.assertEqual(r['failure'], 'IQ1_PROTOCOL')
            self.assertTrue(r['restorationReadback'])
            self.assertTrue(r['processClosed'])

    def fixture_script(self, directory, delay):
        root = Path(directory) / 'root'
        s = scope(time.time())
        journal = k.Journal(root, s, True)
        script = Path(directory) / 'worker.py'
        script.write_text('import sys,time,json\n'
                          f'sys.path.insert(0,{str(k.HERE)!r})\n'
                          'import iq1_identity_boundary as k\n'
                          'from test_iq1_identity_boundary import Fake,CONFIG,NUMBER\n'
                          f's={s!r}\n'
                          f'j=k.Journal({str(root)!r},s)\n'
                          'k.q.PROJECT_NUMBER_SHA256=k.m.digest(NUMBER)\nf=Fake()\n'
                          'def coordinate(d):\n'
                          ' for i in range(4):d.step(i)\n'
                          f' time.sleep({delay!r})\n d.step(4)\n'
                          f'with k.lease({str(Path(directory)/"lease")!r}):\n'
                          ' k.run_worker(s,j,factory=lambda:f,guard=lambda s:None,config=lambda:CONFIG,coordinate=coordinate)\n')
        return journal, script

    def wait_file(self, path, seconds=5):
        end = time.monotonic() + seconds
        while not path.exists() and time.monotonic() < end:
            time.sleep(.02)
        self.assertTrue(path.exists(), path.name)

    def test_worker_sigkill_retains_unknown_and_consumed_attempt(self):
        with tempfile.TemporaryDirectory() as directory:
            journal, script = self.fixture_script(directory, 10)
            child = subprocess.Popen([k.p.PYTHON, '-I', '-B', str(script)], start_new_session=True,
                                     stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            try:
                self.wait_file(journal.root / 'enable.json')
            finally:
                child.kill()
                child.wait(timeout=3)
            r = k.read_result(journal)
            self.assertEqual(r['status'], 'CONTAINMENT_UNCONFIRMED')
            self.assertTrue((journal.root / 'worker.json').exists())
            self.assertFalse((journal.root / 'disable.json').exists())
            self.assertFalse((journal.root / 'result.json').exists())

    def test_detached_worker_survives_launcher_loss(self):
        with tempfile.TemporaryDirectory() as directory:
            journal, script = self.fixture_script(directory, 1)
            launcher_code = ('import subprocess,time;subprocess.Popen(' +
                             repr([k.p.PYTHON, '-I', '-B', str(script)]) +
                             ',start_new_session=True,stdin=subprocess.DEVNULL,'
                             'stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL);time.sleep(10)')
            launcher = subprocess.Popen([k.p.PYTHON, '-I', '-B', '-c', launcher_code],
                                        start_new_session=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            try:
                self.wait_file(journal.root / 'enable.json')
            finally:
                launcher.kill()
                launcher.wait(timeout=3)
            self.wait_file(journal.root / 'result.json')
            self.assertEqual(k.read_result(journal)['status'], 'QUALIFIED_AND_CLOSED')

    def test_actual_sandbox_fork_and_spawn_denied(self):
        for operation in ('os.fork()', 'os.posix_spawn("/usr/bin/true",["true"],{})',
                          'subprocess.Popen([sys.executable,"-c","pass"],start_new_session=True)'):
            script = ('import os,sys,subprocess,errno\ntry:\n ' + operation +
                      '\nexcept OSError as e:\n print("OK" if e.errno==errno.EPERM else "BAD")\nelse:os._exit(9)')
            io = k.q.NativeIO(time.time, str(uuid.uuid4()))
            raw = io._owned_run([k.SANDBOX, '-p', k.PROFILE, k.p.PYTHON, '-I', '-B', '-c', script],
                                {'PATH': '/usr/bin:/bin'}, time.time() + 8)
            self.assertEqual(raw.strip(), b'OK')
            self.assertTrue(io.close(time.time() + 3))

    def test_actual_support_probe(self):
        k.sandbox_check(str(uuid.uuid4()))

    def test_timeout_closes_owned_process(self):
        io = k.q.NativeIO(time.time, str(uuid.uuid4()))
        with self.assertRaises(k.m.Stop):
            io._owned_run([k.SANDBOX, '-p', k.PROFILE, k.p.PYTHON, '-I', '-B', '-c',
                           'import time;time.sleep(10)'], {'PATH': '/usr/bin:/bin'}, time.time() + 2.5)
        self.assertTrue(io.close(time.time() + 3))
        self.assertFalse(io.children)

    def test_foreign_process_not_adopted(self):
        io = k.q.NativeIO(time.time, str(uuid.uuid4()))
        class Foreign:
            pid = os.getpid()
        self.assertFalse(io._finish(Foreign(), time.time() + 3))

    def test_actual_coordinator_and_cleanup(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(k.q, 'PROJECT_NUMBER_SHA256', k.m.digest(NUMBER)):
            s = scope(time.time())
            fake = Fake()
            journal = k.Journal(Path(directory) / 'root', s, True)
            result = k.run_worker(s, journal, factory=lambda: fake, guard=lambda s: None,
                                  config=lambda: CONFIG, coordinate=k.coordinator)
            self.assertEqual(result['status'], 'QUALIFIED_AND_CLOSED')


if __name__ == '__main__':
    unittest.main()
