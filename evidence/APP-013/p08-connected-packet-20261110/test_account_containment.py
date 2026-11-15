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


if __name__ == '__main__':
    unittest.main()
