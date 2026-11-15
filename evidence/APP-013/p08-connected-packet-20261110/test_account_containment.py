"""Synthetic supplied responses only; no native reader or credential access."""
import concurrent.futures
import copy
import datetime
import json
from pathlib import Path
import unittest
from unittest.mock import patch
import account_containment as c

OP = '11111111-1111-4111-8111-111111111111'
UID = '22222222-2222-4222-8222-222222222222'
SECOND = int(datetime.datetime.fromisoformat(c.R47_INTENT.replace('Z', '+00:00')).timestamp())


def fixture():
    target = dict(id=UID, tenantId=c.q.model.TENANT, email=c.q.TARGET_EMAIL,
                  fullName=c.q.TARGET_NAME, role='ADMIN', status='DISABLED')
    db = dict(jobCount=0, job=None, tenantCount=0, tenant=None, operatorCount=1,
              operator=target, calendarCount=0, roleCount=0, sessionCount=0)
    user = dict(localId=UID, email=target['email'], displayName=target['fullName'],
                disabled=True, emailVerified=False, validSince=str(SECOND),
                customAttributes=json.dumps(dict(tenantId=target['tenantId'], role='admin', testOnly=True)))
    return target, db, user


class Containment(unittest.TestCase):
    def setUp(self):
        self.target, self.db, self.user = fixture()

    def payloads(self, operation=OP, dbop=OP, fbop=OP):
        return c._payloads(operation, dict(operationId=dbop, body=json.dumps(self.db)),
                           dict(operationId=fbop, status=200, body=json.dumps({'users': [self.user]})),
                           c.R47_INTENT, c.target_digest(self.target))

    def rejected(self):
        try:
            result = self.payloads()
        except Exception:
            return
        self.assertFalse(all(result.values()))

    def test_equal_and_newer_seconds(self):
        for offset in (0, 1, 100):
            self.user['validSince'] = str(SECOND + offset)
            self.assertTrue(all(self.payloads().values()))

    def test_stale_second_and_old_shared_cutoff(self):
        for value in (SECOND - 1, int(c.q.REVOCATION_LOWER_BOUND_MS / 1000) + 1):
            self.user['validSince'] = str(value)
            self.assertFalse(self.payloads()['revocationBoundMet'])

    def test_timestamp_shapes(self):
        for value in (None, True, 123, '', '-1', '1.5', '1e9', 'NaN', '9' * 1000, '253402300800'):
            with self.subTest(value=type(value).__name__):
                self.user['validSince'] = value
                self.rejected()

    def test_missing_fields(self):
        original = copy.deepcopy(self.user)
        for field in original:
            self.user = {k: v for k, v in original.items() if k != field}
            self.rejected()

    def test_explicit_booleans(self):
        for field, values in [('disabled', (False, None, 1, 'true')), ('emailVerified', (True, None, 0, 'false'))]:
            for value in values:
                self.user = fixture()[2]
                self.user[field] = value
                self.rejected()

    def test_claims_and_foreign_identity(self):
        for change in ({'tenantId': 'foreign'}, {'role': 'user'}, {'testOnly': 1}, {'extra': True}):
            self.user = fixture()[2]
            claims = json.loads(self.user['customAttributes']); claims.update(change)
            self.user['customAttributes'] = json.dumps(claims)
            self.rejected()
        for field in ('localId', 'email', 'displayName'):
            self.user = fixture()[2]; self.user[field] = 'foreign'
            self.rejected()

    def test_account_and_sessions(self):
        for field in self.target:
            self.db = fixture()[1]; self.db['operator'][field] = 'foreign'
            self.rejected()
        self.db = fixture()[1]; self.db['sessionCount'] = 1
        self.assertFalse(self.payloads()['databaseSessionsAbsent'])
        self.db['sessionCount'] = False
        self.rejected()

    def test_serializers_duplicate_invalid_multiuser(self):
        for raw in ('{', '{"users":[],"users":[]}', '{"users":[]}', '{"users":[{},{}]}', 'NaN', 'x' * 65537):
            with self.assertRaises(Exception):
                c._payloads(OP, dict(operationId=OP, body=json.dumps(self.db)),
                            dict(operationId=OP, status=200, body=raw), c.R47_INTENT, c.target_digest(self.target))
        self.user['customAttributes'] = '{"testOnly":true,"testOnly":true}'
        self.rejected()

    def test_operation_binding_and_status(self):
        with self.assertRaises(Exception): self.payloads(dbop=UID)
        with self.assertRaises(Exception): self.payloads(fbop=UID)
        for status in (True, 403, None):
            with self.assertRaises(Exception):
                c._payloads(OP, dict(operationId=OP, body=json.dumps(self.db)),
                            dict(operationId=OP, status=status, body=json.dumps({'users': [self.user]})),
                            c.R47_INTENT, c.target_digest(self.target))

    def test_existing_validators_invoked_no_native_fallback(self):
        with patch.object(c.q.Adapter, 'read_database', wraps=c.q.Adapter.read_database) as db, \
             patch.object(c.source.entry.readbacks, 'exact_firebase', wraps=c.source.entry.readbacks.exact_firebase) as fb, \
             patch.object(c.source.subprocess, 'Popen', side_effect=AssertionError('NO_NATIVE')):
            self.assertTrue(all(self.payloads().values()))
            self.assertEqual(db.call_count, 1); self.assertEqual(fb.call_count, 1)

    def test_isolation_concurrency_no_mutation(self):
        before = copy.deepcopy((self.db, self.user)); cutoff = c.q.REVOCATION_LOWER_BOUND_MS
        with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
            results = list(pool.map(lambda _: self.payloads(), range(20)))
        self.assertTrue(all(all(r.values()) for r in results))
        self.assertEqual(before, (self.db, self.user)); self.assertEqual(cutoff, c.q.REVOCATION_LOWER_BOUND_MS)

    def test_public_provenance_and_safe_unknown(self):
        journal = (Path(__file__).parent / 'r47-journal.json').read_bytes()
        binding = dict(operationId=OP, historicalOperationId=c.R47_OPERATION,
                       journalSha256=c.R47_JOURNAL_SHA256, revocationIntentAt=c.R47_INTENT)
        # Real immutable provenance; synthetic target deliberately cannot satisfy the production fingerprint.
        result = c.validate(binding, dict(operationId=OP, body=json.dumps(self.db)),
                            dict(operationId=OP, status=200, body=json.dumps({'users': [self.user]})), journal)
        self.assertTrue(result['flags']['bindingExact'])
        self.assertEqual(result['status'], 'CURRENT_CONTAINMENT_UNKNOWN')
        for key in binding:
            bad = dict(binding); bad[key] = 'RAW_SECRET_SENTINEL'
            result = c.validate(bad, None, None, journal)
            self.assertFalse(result['flags']['bindingExact'])
            self.assertNotIn('RAW_SECRET_SENTINEL', json.dumps(result))
        for raw in (journal + b' ', b'RAW_SECRET_SENTINEL', None):
            result = c.validate(binding, None, None, raw)
            self.assertEqual(result['status'], 'CURRENT_CONTAINMENT_UNKNOWN')
            self.assertEqual(result['historicalAuthentication'], 'UNKNOWN')
            self.assertNotIn('RAW_SECRET_SENTINEL', json.dumps(result))


class CurrentContainment(unittest.TestCase):
    def setUp(self):
        self.target, self.db, self.user = fixture()
        self.now = c.R51_POLICY_SECOND + 100
        self.user['validSince'] = str(c.R51_POLICY_SECOND)
        self.pin = patch.object(c.q, 'TARGET_SHA256', c.target_digest(self.target))
        self.pin.start()
        self.addCleanup(self.pin.stop)

    def account(self, *, final=False, body=None, operation=OP):
        if body is None:
            body = ({'operatorCount': self.db['operatorCount'], 'operator': self.db['operator'],
                     'sessionsAbsent': self.db['sessionCount'] == 0} if final else self.db)
        raw = body if type(body) in (str, bytes) else json.dumps(body)
        return c.current_account(OP, {'operationId': operation, 'body': raw}, final=final)

    def firebase(self, *, body=None, operation=OP, status=200, target=None, **kwargs):
        if body is None:
            body = {'users': [self.user]}
        raw = body if type(body) in (str, bytes) else json.dumps(body)
        return c.current_firebase(OP, {'operationId': operation, 'status': status, 'body': raw},
                                  self.target if target is None else target, self.now, **kwargs)

    def test_r51_policy_actual_immutable_provenance_and_ceil(self):
        root = Path(__file__).parent / 'r51-live-20261115'
        native = (root / 'native-result.json').read_bytes()
        closure = (root / 'local-closeout-verification.json').read_bytes()
        policy = c.r51_policy(native, closure)
        self.assertEqual(policy, {'kind': 'POST_PROCESS_OBSERVATION',
                                 'historicalOperationId': c.R51_OPERATION,
                                 'minimumValidSince': 1794780123, 'historicalAuthentication': 'UNKNOWN'})
        observed = datetime.datetime.fromisoformat(json.loads(closure)['observedAt']).timestamp()
        self.assertGreater(policy['minimumValidSince'], observed)
        self.assertLess(policy['minimumValidSince'] - observed, 1)
        for result, closed in ((native + b' ', closure), (native, closure + b' '),
                               (None, closure), (native, b'RAW_SECRET_SENTINEL')):
            with self.subTest(result_type=type(result), closed_type=type(closed)):
                with self.assertRaisesRegex(ValueError, '^CONTAINMENT_UNKNOWN$'):
                    c.r51_policy(result, closed)

    def test_policy_rejects_inconsistent_operation_absence_or_timestamp(self):
        root = Path(__file__).parent / 'r51-live-20261115'
        native = json.loads((root / 'native-result.json').read_bytes())
        closure = json.loads((root / 'local-closeout-verification.json').read_bytes())
        changes = [('native', 'operationId', OP), ('closure', 'matchingOperationProcessesAbsent', False),
                   ('closure', 'receiptCustodyVerified', 1), ('closure', 'noRetry', False),
                   ('closure', 'observedAt', '2026-11-15T22:02:02+00:00'),
                   ('closure', 'observedAt', '2026-11-15T22:02:02.312864')]
        for owner, field, value in changes:
            with self.subTest(owner=owner, field=field):
                n, r = copy.deepcopy(native), copy.deepcopy(closure)
                (n if owner == 'native' else r)[field] = value
                nr, rr = json.dumps(n).encode(), json.dumps(r).encode()
                # Exercise the semantic derivation as well as the production hash guard.
                with patch.object(c, 'R51_RESULT_SHA256', c.hashlib.sha256(nr).hexdigest()), \
                     patch.object(c, 'R51_CLOSEOUT_SHA256', c.hashlib.sha256(rr).hexdigest()):
                    with self.assertRaisesRegex(ValueError, '^CONTAINMENT_UNKNOWN$'):
                        c.r51_policy(nr, rr)

    def test_initial_and_final_account_use_actual_validators(self):
        with patch.object(c.q.Adapter, 'read_database', wraps=c.q.Adapter.read_database) as parse_db, \
             patch.object(c.source.entry.readbacks, 'exact_account',
                          wraps=c.source.entry.readbacks.exact_account) as exact:
            for final in (False, True):
                flags, target = self.account(final=final)
                self.assertTrue(all(value is True for value in flags.values()), flags)
                self.assertEqual(target, self.target)
            self.assertEqual(parse_db.call_count, 1)
            self.assertEqual(exact.call_count, 2)

    def test_initial_and_final_account_identity_and_status_drift(self):
        for final in (False, True):
            for field, value in (('id', OP), ('tenantId', OP), ('email', 'RAW_SECRET_SENTINEL'),
                                 ('fullName', 'foreign'), ('role', 'TECH'), ('status', 'ACTIVE')):
                with self.subTest(final=final, field=field):
                    self.db['operator'] = {**self.target, field: value}
                    flags, target = self.account(final=final)
                    self.assertIsNone(target)
                    self.assertFalse(all(value is True for value in flags.values()))
                    self.assertNotIn('RAW_SECRET_SENTINEL', json.dumps(flags))
                    if field == 'status':
                        self.assertTrue(flags['accountIdentityExact'])
                        self.assertFalse(flags['accountExactDisabled'])
                    else:
                        self.assertFalse(flags['accountIdentityExact'])
        self.db['operator'] = self.target

    def test_current_account_strict_shapes_sessions_and_binding(self):
        for raw in ('{"operatorCount":1,"operatorCount":1}', b'\xff', 'NaN', '{}'):
            for final in (False, True):
                flags, target = self.account(body=raw, final=final)
                self.assertIsNone(target)
                self.assertFalse(all(value is True for value in flags.values()))
        for count in (True, -1, 1.0, '1', 0, 2):
            self.db['operatorCount'] = count
            for final in (False, True):
                self.assertIsNone(self.account(final=final)[1])
        self.db['operatorCount'] = 1
        self.db['sessionCount'] = 1
        for final in (False, True):
            flags, _ = self.account(final=final)
            self.assertFalse(flags['databaseSessionsAbsent'])
        self.db['sessionCount'] = 0
        for value in (None, 1, 'true'):
            flags, _ = self.account(final=True, body={'operatorCount': 1, 'operator': self.target,
                                                       'sessionsAbsent': value})
            self.assertIsNone(flags['databaseSessionsAbsent'])
        flags, target = self.account(operation=c.R51_OPERATION)
        self.assertFalse(flags['bindingExact']); self.assertIsNone(target)

    def test_stale_current_timestamp_is_observed_but_not_containment(self):
        stale = c.R51_POLICY_SECOND - 1
        self.user['validSince'] = str(stale)
        flags, seconds = self.firebase()
        self.assertEqual(seconds, stale)
        self.assertFalse(flags['revocationBoundMet'])
        self.assertTrue(all(value is True for key, value in flags.items() if key != 'revocationBoundMet'), flags)

    def test_final_bound_includes_policy_initial_and_requested(self):
        for initial, requested in ((None, None), (c.R51_POLICY_SECOND + 20, None),
                                   (c.R51_POLICY_SECOND - 1, c.R51_POLICY_SECOND + 40),
                                   (c.R51_POLICY_SECOND + 30, c.R51_POLICY_SECOND + 40)):
            minimum = max(c.R51_POLICY_SECOND, initial or 0, requested or 0)
            for delta in (-1, 0, 1):
                with self.subTest(initial=initial, requested=requested, delta=delta):
                    self.user['validSince'] = str(minimum + delta)
                    flags, seconds = self.firebase(initial_valid_since=initial, requested_valid_since=requested)
                    self.assertEqual(seconds, minimum + delta)
                    self.assertEqual(flags['revocationBoundMet'], delta >= 0)
                    self.assertTrue(flags['validatorAccepted'])

    def test_invalid_or_future_requested_and_observed_timestamps(self):
        for value in (None, True, 1, '', '-1', '1.5', '1e9', 'NaN', '9' * 13, '253402300800'):
            with self.subTest(value=value):
                self.user['validSince'] = value
                flags, seconds = self.firebase()
                self.assertIsNone(seconds)
                self.assertIsNot(flags['validatorAccepted'], True)
        self.user['validSince'] = str(self.now + 1)
        flags, seconds = self.firebase()
        self.assertFalse(flags['revocationNotFuture']); self.assertIsNone(seconds)
        self.user['validSince'] = str(c.R51_POLICY_SECOND)
        for initial, requested in ((True, None), (self.now + 1, None), (None, c.R51_POLICY_SECOND),
                                   (c.R51_POLICY_SECOND + 1, c.R51_POLICY_SECOND),
                                   (0, c.R51_POLICY_SECOND - 1), (0, True), (0, self.now + 1)):
            with self.subTest(initial=initial, requested=requested):
                flags, seconds = self.firebase(initial_valid_since=initial, requested_valid_since=requested)
                self.assertIsNone(seconds)
                self.assertFalse(all(value is True for value in flags.values()))

    def test_initial_and_final_firebase_identity_claim_status_drift(self):
        original = copy.deepcopy(self.user)
        changes = ({'localId': OP}, {'email': 'RAW_SECRET_SENTINEL'}, {'displayName': 'foreign'},
                   {'disabled': False}, {'disabled': 1}, {'emailVerified': True}, {'emailVerified': 0},
                   {'customAttributes': '{}'}, {'tokensValidAfterTime': 'RAW_SECRET_SENTINEL'})
        for final in (False, True):
            for change in changes:
                with self.subTest(final=final, change=next(iter(change))):
                    self.user = {**original, **change}
                    kwargs = {'initial_valid_since': c.R51_POLICY_SECOND} if final else {}
                    flags, _ = self.firebase(**kwargs)
                    self.assertFalse(all(value is True for value in flags.values()))
                    self.assertIsNot(flags['validatorAccepted'], True)
                    self.assertNotIn('RAW_SECRET_SENTINEL', json.dumps(flags))
        self.user = original

    def test_firebase_strict_json_types_target_and_binding(self):
        for raw in ('{"users":[],"users":[]}', b'\xff', 'NaN', '[]'):
            self.assertIsNone(self.firebase(body=raw)[1])
        self.user['customAttributes'] = '{"tenantId":"x","tenantId":"y"}'
        self.assertIsNone(self.firebase()[1])
        self.user = fixture()[2]; self.user['validSince'] = str(c.R51_POLICY_SECOND)
        for status in (True, 403, '200', None):
            self.assertIsNone(self.firebase(status=status)[1])
        for key in self.user:
            body = {'users': [{k: v for k, v in self.user.items() if k != key}]}
            self.assertIsNone(self.firebase(body=body)[1])
        self.assertIsNone(self.firebase(target={**self.target, 'status': 'ACTIVE'})[1])
        flags, seconds = self.firebase(operation=c.R51_OPERATION)
        self.assertFalse(flags['bindingExact']); self.assertIsNone(seconds)

    def test_inherited_validator_failure_cannot_leave_accepted_flags(self):
        with patch.object(c.source.entry.readbacks, 'exact_account', side_effect=ValueError('RAW_SECRET_SENTINEL')):
            flags, target = self.account()
            self.assertIsNone(flags['validatorAccepted']); self.assertIsNone(target)
        with patch.object(c.source.entry.readbacks, 'exact_firebase', side_effect=ValueError('RAW_SECRET_SENTINEL')):
            flags, seconds = self.firebase()
            self.assertIsNone(flags['validatorAccepted'])
            self.assertEqual(seconds, c.R51_POLICY_SECOND)
            self.assertNotIn('RAW_SECRET_SENTINEL', json.dumps(flags))

    def test_current_helpers_are_inert_and_do_not_mutate_inputs_or_history(self):
        before = copy.deepcopy((self.db, self.user, self.target))
        with patch.object(c.source.subprocess, 'Popen', side_effect=AssertionError('NO_NATIVE')):
            self.assertTrue(all(value is True for value in self.account()[0].values()))
            self.assertTrue(all(value is True for value in self.firebase()[0].values()))
        self.assertEqual(before, (self.db, self.user, self.target))
        self.assertEqual(c.R47_INTENT, '2026-11-14T19:22:30.000Z')


if __name__ == '__main__':
    unittest.main()
