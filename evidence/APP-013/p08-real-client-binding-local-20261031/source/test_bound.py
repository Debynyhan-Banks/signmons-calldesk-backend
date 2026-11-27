"""Serialized disabled coordinator/Node boundary tests with synthetic providers."""
import copy
import json
import os
import shutil
import sys
import time
import unittest
import uuid
from pathlib import Path
from types import SimpleNamespace

import bound_handoff as h

sys.path.insert(0, str(h.APP / 'p08-native-closeout-local-20261031/source'))
import test_adapter as ta


class ChildJournalMergeTests(unittest.TestCase):
    """Exercise the real private-file/parent merge with supplied inert journals."""

    def setUp(self):
        operation = str(uuid.uuid4())
        self.root = Path('/private/tmp/p08-coordinator-' + operation)
        self.root.mkdir(mode=0o700)
        self.plan = {'operationId': operation}
        self.before = {'operationId': operation, 'planSha256': h.digest(self.plan),
                       'authAttempted': True, 'phase': 'PREFLIGHT'}
        # No constructor/launch/source-check substitution: this fixture invokes only
        # the supplied-journal merge, never a coordinator run or provider port.
        self.h = object.__new__(h.Handoff)
        self.h.plan, self.h.dir = self.plan, self.root
        self.h.coordinator = SimpleNamespace(j=copy.deepcopy(self.before))
        self.child = {'operationId': operation, 'version': 7,
                      'phase': 'CLOSEOUT_FINISHED', 'authenticated': False,
                      'closeoutAttempted': True, 'residuals': [],
                      'failureStage': 'TOKEN_INTENT', 'failureCode': 'SIGN_EXCHANGE_REFUSED',
                      'sessionClosed': True, 'status': 'P08_COORDINATOR_AUTH_STOPPED_AND_CLOSED'}

    def tearDown(self):
        shutil.rmtree(self.root)

    def merge(self, child, *, before=None, parent_changes=None):
        before = copy.deepcopy(self.before if before is None else before)
        self.h.coordinator.j = copy.deepcopy(before)
        after = {**before, **(parent_changes or {}), 'authClient': child}
        path = self.root / 'journal.json'
        path.write_text(json.dumps(after))
        os.chmod(path, 0o600)
        return self.h._merge_child(before)

    def assert_refused(self, child, code='CHILD_JOURNAL_SHAPE', **kwargs):
        expected = copy.deepcopy(kwargs.get('before', self.before))
        with self.assertRaisesRegex(h.Stop, '^' + code + '$') as caught:
            self.merge(child, **kwargs)
        self.assertEqual(self.h.coordinator.j, expected)
        self.assertNotIn('PRIVATE_DIAGNOSTIC_SENTINEL', str(caught.exception))
        self.assertNotIn('PRIVATE_DIAGNOSTIC_SENTINEL', json.dumps(self.h.coordinator.j))

    def test_ap1_new_phases_merge_without_synthesizing_proof(self):
        for phase, authenticated in (('RUNTIME_AUTH_INTENT', False), ('PAYMENT_HANDOFF_INTENT', True)):
            child = {**self.child, 'phase': phase, 'authenticated': authenticated}
            self.assertEqual(self.merge(child), child)
            self.assertNotIn('authProofAccepted', self.h.coordinator.j)
            self.assertNotIn('childResultSha256', self.h.coordinator.j)
            self.assert_refused({**child, 'operationId': str(uuid.uuid4())}, 'CHILD_JOURNAL_ABSENT')
            self.assert_refused(child, 'JOURNAL_PARENT_DRIFT', parent_changes={'phase': 'FOREIGN'})
            self.assert_refused(child, 'CHILD_JOURNAL_VERSION',
                               before={**self.before, 'authClient': {**child, 'version': 8}})
        self.assert_refused({**self.child, 'phase': 'PAYMENT_HANDOFF_PRIVATE_DIAGNOSTIC_SENTINEL'})

    def test_ap2_finite_authentication_diagnostics_survive_only_exact_combinations(self):
        for stage, values in h.AUTHENTICATION_VALIDATIONS.items():
            for category, validations in [('GUARD', [None]), ('UNKNOWN', [None]),
                    ('RESPONSE_VALIDATION', sorted(values))]:
                for validation in validations:
                    child = {**self.child, 'failureStage': 'RUNTIME_AUTH_INTENT',
                             'failureCode': 'AUTHENTICATION_REFUSED', 'authStage': stage,
                             'failureCategory': category, 'httpStatus': None}
                    if validation is not None:child['responseValidationCode'] = validation
                    self.assertEqual(self.merge(child), child)
                    self.assertNotIn('authProofAccepted', self.h.coordinator.j)
            for category in ['TIMEOUT', 'TRANSPORT', 'HTTP']:
                child = {**self.child, 'failureStage': 'RUNTIME_AUTH_INTENT',
                         'failureCode': 'AUTHENTICATION_REFUSED', 'authStage': stage,
                         'failureCategory': category, 'httpStatus': 403 if category == 'HTTP' else None}
                if stage in {'AUTH_IDENTITY_READ', 'AUTH_RUNTIME_READ'}:self.assertEqual(self.merge(child), child)
                else:self.assert_refused(child)

    def test_ap2_partial_forged_mismatched_or_private_diagnostics_do_not_merge(self):
        good = {**self.child, 'failureStage': 'RUNTIME_AUTH_INTENT', 'failureCode': 'AUTHENTICATION_REFUSED',
                'authStage': 'AUTH_RUNTIME_READ', 'failureCategory': 'HTTP', 'httpStatus': 403}
        for key in ['authStage', 'failureCategory', 'httpStatus']:
            self.assert_refused({k:v for k,v in good.items() if k != key})
        for patch in [{'authStage':'SIGN'}, {'failureStage':'TOKEN_INTENT'}, {'failureCode':'SIGN_EXCHANGE_REFUSED'},
                      {'httpStatus':True}, {'httpStatus':600}, {'httpStatus':'PRIVATE_DIAGNOSTIC_SENTINEL'},
                      {'failureCategory':'TIMEOUT'}, {'responseValidationCode':'JSON_PARSE'},
                      {'failureCategory':'RESPONSE_VALIDATION','httpStatus':None},
                      {'failureCategory':'RESPONSE_VALIDATION','httpStatus':None,'responseValidationCode':'IDENTITY_MISMATCH'},
                      {'failureCode':'TOKEN_TIME'}, {'failureCode':[]}, {'failureCode':{}}, {'authenticated':True},
                      {'failureCategory':'PRIVATE_DIAGNOSTIC_SENTINEL'}]:
            self.assert_refused({**good, **patch})
        self.assert_refused(good, 'JOURNAL_PARENT_DRIFT', parent_changes={'phase':'FOREIGN'})
        self.assert_refused({**good,'operationId':str(uuid.uuid4())}, 'CHILD_JOURNAL_ABSENT')
        self.assert_refused(good, 'CHILD_JOURNAL_VERSION', before={**self.before,'authClient':{**good,'version':8}})

    def test_complete_diagnostics_survive_merge_and_parent_save(self):
        for stage in ('SIGN', 'KEY_READ', 'EXCHANGE', 'UNKNOWN'):
            for category, statuses in (('HTTP', (None, 100, 403, 599)),
                                       ('TRANSPORT', (None,)),
                                       ('RESPONSE_VALIDATION', (None,)), ('UNKNOWN', (None,))):
                for status in statuses:
                    with self.subTest(stage=stage, category=category, status=status):
                        child = {**self.child, 'authStage': stage,
                                 'failureCategory': category, 'httpStatus': status}
                        self.assertEqual(self.merge(child), child)
                        # A subsequent parent serialization must retain the accepted
                        # fields, which the previous schema rejected before copying.
                        saved = json.loads(json.dumps(self.h.coordinator.j))
                        self.assertEqual(saved['authClient'], child)
                        self.assertEqual({k: v for k, v in saved.items() if k != 'authClient'},
                                         self.before)

    def test_absent_diagnostic_group_remains_compatible(self):
        for code in ('SIGN_EXCHANGE_REFUSED', 'ADAPTER_REFUSED_OR_UNKNOWN', None):
            with self.subTest(code=code):
                child = {**self.child}
                if code is None:
                    child.pop('failureCode')
                else:
                    child['failureCode'] = code
                self.assertEqual(self.merge(child), child)
                self.assertNotIn('responseValidationCode', self.h.coordinator.j['authClient'])

    def test_response_validation_codes_require_their_exact_stage_and_diagnostic_group(self):
        specific = {'SIGN': 'SIGN_RESPONSE_SHAPE', 'KEY_READ': 'KEY_RESPONSE_MISMATCH',
                    'EXCHANGE': 'EXCHANGE_RESPONSE_MISMATCH'}
        common = ('BODY_BOUND', 'JSON_PARSE', 'RESPONSE_SHAPE', 'PROVIDER_ERROR')
        for stage, selected in specific.items():
            for code in (*common, selected):
                with self.subTest(stage=stage, code=code):
                    child = {**self.child, 'authStage': stage, 'failureCategory': 'RESPONSE_VALIDATION',
                             'httpStatus': None, 'responseValidationCode': code}
                    self.assertEqual(self.merge(child), child)
                    self.assertEqual(json.loads(json.dumps(self.h.coordinator.j))['authClient'], child)
            for code in set(specific.values()) - {selected}:
                with self.subTest(stage=stage, mismatch=code):
                    self.assert_refused({**self.child, 'authStage': stage,
                                        'failureCategory': 'RESPONSE_VALIDATION', 'httpStatus': None,
                                        'responseValidationCode': code})

    def test_response_validation_code_rejects_partial_wrong_or_private_diagnostics(self):
        valid = {**self.child, 'authStage': 'EXCHANGE', 'failureCategory': 'RESPONSE_VALIDATION',
                 'httpStatus': None, 'responseValidationCode': 'EXCHANGE_RESPONSE_MISMATCH'}
        for mask in range(7):
            child = {k: v for k, v in valid.items() if k not in h.AUTH_DIAGNOSTIC_FIELDS}
            child.update({key: valid[key] for i, key in enumerate(sorted(h.AUTH_DIAGNOSTIC_FIELDS))
                          if mask & (1 << i)})
            with self.subTest(partial=mask):
                self.assert_refused(child)
        for code in (None, False, 1, [], {}, 'PRIVATE_DIAGNOSTIC_SENTINEL', 'json_parse'):
            with self.subTest(code=code):
                self.assert_refused({**valid, 'responseValidationCode': code})
        for field, values in {'authStage': ('UNKNOWN', 'SIGN', 'KEY_READ'),
                              'failureCategory': ('TRANSPORT', 'HTTP', 'UNKNOWN'),
                              'failureCode': ('ADAPTER_REFUSED_OR_UNKNOWN', None),
                              'httpStatus': (403, True)}.items():
            for value in values:
                with self.subTest(field=field, value=value):
                    self.assert_refused({**valid, field: value})
        for field in ('message', 'stack', 'body', 'url', 'accessToken', 'password'):
            with self.subTest(private_field=field):
                self.assert_refused({**valid, field: 'PRIVATE_DIAGNOSTIC_SENTINEL'})

    def test_partial_diagnostics_and_wrong_failure_code_refused(self):
        values = {'authStage': 'SIGN', 'failureCategory': 'HTTP', 'httpStatus': 403}
        keys = tuple(values)
        for mask in range(1, 7):
            with self.subTest(mask=mask):
                group = {key: values[key] for i, key in enumerate(keys) if mask & (1 << i)}
                self.assert_refused({**self.child, **group})
        for code in ('ADAPTER_REFUSED_OR_UNKNOWN', None, False, ['SIGN_EXCHANGE_REFUSED']):
            with self.subTest(code=code):
                self.assert_refused({**self.child, **values, 'failureCode': code})

    def test_invalid_diagnostic_enums_types_and_category_status_refused(self):
        valid = {**self.child, 'authStage': 'SIGN', 'failureCategory': 'HTTP', 'httpStatus': 403}
        for field in ('authStage', 'failureCategory'):
            for value in (None, False, 403, [], {}, 'PRIVATE_DIAGNOSTIC_SENTINEL', 'sign'):
                with self.subTest(field=field, value=value):
                    self.assert_refused({**valid, field: value})
        for status in (True, False, 99, 600, -1, 403.0, '403', [], {}):
            with self.subTest(status=status):
                self.assert_refused({**valid, 'httpStatus': status})
        for category in ('TRANSPORT', 'RESPONSE_VALIDATION', 'UNKNOWN'):
            with self.subTest(category=category):
                self.assert_refused({**valid, 'failureCategory': category})

    def test_unknown_fields_and_private_values_never_enter_parent(self):
        valid = {**self.child, 'authStage': 'SIGN', 'failureCategory': 'HTTP', 'httpStatus': 403}
        for field in ('message', 'stack', 'body', 'url', 'accessToken', 'password'):
            with self.subTest(field=field):
                self.assert_refused({**valid, field: 'PRIVATE_DIAGNOSTIC_SENTINEL'})

    def test_diagnostics_do_not_bypass_identity_version_parent_or_temp_guards(self):
        child = {**self.child, 'authStage': 'EXCHANGE', 'failureCategory': 'RESPONSE_VALIDATION',
                 'httpStatus': None, 'responseValidationCode': 'EXCHANGE_RESPONSE_MISMATCH'}
        self.assert_refused({**child, 'operationId': str(uuid.uuid4())}, 'CHILD_JOURNAL_ABSENT')
        previous = {**self.before, 'authClient': {**child, 'version': 8}}
        self.assert_refused(child, 'CHILD_JOURNAL_VERSION', before=previous)
        self.assert_refused(child, 'JOURNAL_PARENT_DRIFT', parent_changes={'phase': 'FOREIGN'})
        temporary = self.root / 'journal.json.auth-next'
        temporary.write_text('PRIVATE_DIAGNOSTIC_SENTINEL')
        self.assert_refused(child, 'JOURNAL_TEMP_REMAINS')


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
