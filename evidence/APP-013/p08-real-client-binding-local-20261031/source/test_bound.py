"""Serialized disabled coordinator/Node boundary tests with synthetic providers."""
import copy
import json
import os
import shutil
import sys
import time
import unittest
from pathlib import Path

import bound_handoff as h

sys.path.insert(0, str(h.APP / 'p08-native-closeout-local-20261031/source'))
import test_adapter as ta


class BoundHandoffTests(unittest.TestCase):
    def setUp(self):
        self.fixture = ta.AdapterTests()
        self.fixture.setUp()
        f = self.fixture
        f.now = int(time.time())
        from datetime import datetime, timezone
        iso = lambda offset: datetime.fromtimestamp(f.now + offset, timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')
        f.p['window'] = {'start': iso(-10), 'cutoff': iso(60), 'workEnd': iso(120),
                         'cleanupEnd': iso(900), 'purgeEnd': iso(950)}
        f.approval['planSha256'] = ta.c.digest(f.p)
        f.fb['tokensValidAfterTime'] = iso(1)
        f.target['email'] = f.p['ownerPrincipal']
        f.app['email'] = f.target['email']
        f.fb['email'] = f.target['email']
        self.root = Path('/private/tmp/p08-coordinator-' + f.p['operationId'])
        self.root.mkdir(mode=0o700)
        self.h = h.Handoff(f.p, f.approval, f.target, self.root, f.clock)
        f.bound = f.make()
        f.bound.auth_handoff = self.h
        f.directory = self.root
        self.original_close = f.runtime.close_authentication
        f.runtime.close_authentication = lambda plan, deadline: self.h.closeout_only()
        self.coordinator = ta.c.Coordinator(f.p, f.approval, f.q, f.runtime,
                                             f.bound.ports, self.root, f.clock)
        self.h.attach(self.coordinator)

    def tearDown(self):
        self.fixture.runtime.close_authentication = self.original_close
        self.fixture.tearDown()
        shutil.rmtree(self.root)

    def test_same_journal_success_and_private_purge(self):
        result = self.coordinator.run()
        self.assertEqual(result['status'], 'LOCAL_COORDINATOR_CLOSED', result)
        self.assertEqual(result['residuals'], [])
        self.assertIsNotNone(result['childResultSha256'])
        journal = json.loads((self.root / 'journal.json').read_text())
        self.assertEqual(journal['authClient']['phase'], 'CLOSEOUT_FINISHED', journal['authClient'])
        self.assertEqual(journal['authClient']['status'], 'P08_COORDINATOR_AUTHENTICATED_AND_CLOSED')
        self.assertFalse((self.root / h.OWNED_RECEIPT).exists())
        self.assertFalse((self.root / 'journal.json.auth-next').exists())
        self.assertFalse(result['liveAuthorization'] or result['authProofReady'])
        self.assertFalse(any(self.fixture.runtime_state.values()))
        self.assertFalse(self.fixture.transport.bindings)
        text = (self.root / 'journal.json').read_text()
        self.assertNotIn('SYNTHETIC_IN_MEMORY_TOKEN', text)
        self.assertNotIn('SYNTHETIC_OWNER_OAUTH_TOKEN', text)
        self.assertNotIn('SYNTHETIC_HIDDEN_PASSWORD', text)
        self.assertNotIn('synthetic-only-key', text)
        self.assertNotIn('header.', text)
        self.assertNotIn(self.fixture.target['email'], text)

    def test_lost_output_retains_journal_and_unknown_outcome(self):
        self.h.scenario = 'lost_output'
        result = self.coordinator.run()
        self.assertEqual(result['status'], 'LOCAL_COORDINATOR_CONTAINMENT_UNCONFIRMED')
        self.assertIn('AUTH_OUTCOME_UNKNOWN', result['residuals'])
        journal = json.loads((self.root / 'journal.json').read_text())
        self.assertEqual(journal['authClient']['phase'], 'CLOSEOUT_FINISHED', journal['authClient'])
        self.assertFalse((self.root / h.OWNED_RECEIPT).exists())
        self.assertFalse(result['liveAuthorization'] or result['authProofReady'])

    def test_child_exit_fails_closed(self):
        self.h.scenario = 'exit'
        result = self.coordinator.run()
        self.assertEqual(result['status'], 'LOCAL_COORDINATOR_CONTAINMENT_UNCONFIRMED')
        self.assertIn('AUTH_OUTCOME_UNKNOWN', result['residuals'])
        self.assertFalse(result['authProofReady'])

    def test_lost_activation_fails_closed(self):
        self.h.scenario = 'lost_activation'
        result = self.coordinator.run()
        self.assertEqual(result['status'], 'LOCAL_COORDINATOR_CONTAINMENT_UNCONFIRMED')
        self.assertFalse(result['authProofReady'])

    def test_session_failure_fails_closed(self):
        self.h.scenario = 'session_failure'
        result = self.coordinator.run()
        self.assertEqual(result['status'], 'LOCAL_COORDINATOR_CONTAINMENT_UNCONFIRMED')
        self.assertFalse(result['authProofReady'])

    def test_child_timeout_fails_closed(self):
        import subprocess
        def timeout(*args, **kwargs):
            raise subprocess.TimeoutExpired(args[0], 0.01)
        self.h.runner = timeout
        result = self.coordinator.run()
        self.assertEqual(result['status'], 'LOCAL_COORDINATOR_CONTAINMENT_UNCONFIRMED')
        self.assertIn('AUTH_REVOKE', result['residuals'])
        self.assertFalse(result['authProofReady'])

    def test_wrong_approval_and_source_refused(self):
        bad = copy.deepcopy(self.fixture.approval)
        bad['operationId'] = 'foreign'
        with self.assertRaises(h.Stop):
            h.Handoff(self.fixture.p, bad, self.fixture.target, self.root, self.fixture.clock)
        self.assertTrue(h.verify_sources())

    def test_wrong_key_refused_before_receipt_write(self):
        with self.assertRaises(h.Stop):
            self.h({'operationId': self.fixture.p['operationId'],
                    'createdInOperation': True, 'deleted': False,
                    'keyResource': 'projects/foreign/locations/global/keys/foreign'})
        self.assertFalse(self.h.receipt_path.exists())

    def test_parent_journal_tamper_refused(self):
        import subprocess
        def tamper(*args, **kwargs):
            result = subprocess.run(*args, **kwargs)
            path = self.root / 'journal.json'
            value = json.loads(path.read_text())
            value['phase'] = 'FOREIGN'
            path.write_text(json.dumps(value))
            os.chmod(path, 0o600)
            return result
        self.h.runner = tamper
        result = self.coordinator.run()
        self.assertEqual(result['status'], 'LOCAL_COORDINATOR_CONTAINMENT_UNCONFIRMED')
        self.assertFalse(result['authProofReady'])

    def test_duplicate_receipt_and_symlink_refused(self):
        h.write_exclusive(self.h.receipt_path, {'foreign': True})
        with self.assertRaises(h.Stop):
            self.h({'operationId': self.fixture.p['operationId']})
        self.h.receipt_path.unlink()
        self.h.receipt_path.symlink_to(self.root / 'absent')
        with self.assertRaises(h.Stop):
            self.h({'operationId': self.fixture.p['operationId']})

    def test_native_stays_disabled(self):
        with self.assertRaises(h.Stop): h.native()


if __name__ == '__main__':
    unittest.main()
