"""CT1 pure validator. No runner, credentials, provider calls or native fallback."""
import datetime
import hashlib
import json
import math
import re
from types import SimpleNamespace

import iq1_identity_boundary as source

q = source.q
R47_OPERATION = 'bea4fe6b-2202-48ed-9df1-84a17d23fcd8'
R47_JOURNAL_SHA256 = '7ea07c21fdc737f671a025de9b44980b2771ddbe9cfdd02cfdb26b9063c5323f'
R47_INTENT = '2026-11-14T19:22:30.000Z'
R51_OPERATION = 'cc2c1ce5-640f-41f4-a993-31063630207c'
R51_RESULT_SHA256 = '920b2c641716482ebbc8dffea8a08f9d31e1519b9e99e53e6bd89fdb80cee26c'
R51_CLOSEOUT_SHA256 = '9109229c263c1aa9dcf777aad5f01cece1a60981ead47d6894e49b38ded01d7e'
R51_POLICY_SECOND = 1794780123
R54_OPERATION = '87fba4ce-03dd-4f97-bb1c-da56d875e526'
R54_RESULT_SHA256 = '849697fd584717ebfaf79c14936a53222fc6a5257e95b5aaa9a45c7d45baba24'
R54_CLOSEOUT_SHA256 = '01a728cdf75149f4ede558bd41bec8413a86ae00d0f6d2a2672b805d06a011e9'
R54_POLICY_SECOND = 1794913849
CURRENT_ACCOUNT_FLAGS = ('bindingExact', 'accountIdentityExact', 'accountExactDisabled',
                         'databaseSessionsAbsent', 'validatorAccepted')
CURRENT_FIREBASE_FLAGS = ('bindingExact', 'firebaseIdentityExact', 'firebaseDisabled',
                          'claimsExact', 'emailUnverified', 'revocationTimestampValid',
                          'revocationNotFuture', 'revocationBoundMet', 'validatorAccepted')
MAX_VALID_SINCE = 253402300799
FLAGS = ('bindingExact', 'accountExactDisabled', 'databaseSessionsAbsent',
         'firebaseIdentityExact', 'firebaseDisabled', 'claimsExact',
         'emailUnverified', 'revocationBoundMet')


def require(value):
    if not value:
        raise ValueError('CONTAINMENT_UNKNOWN')


def parse(raw):
    require(type(raw) in (str, bytes))
    require(len(raw.encode('utf-8') if isinstance(raw, str) else raw) <= 65536)
    return q.strict_json(raw)


def target_digest(target):
    return hashlib.sha256(json.dumps(target, separators=(',', ':')).encode()).hexdigest()


def _payloads(operation, database, firebase, intent, expected_digest):
    """Inert parsing seam; production entry fixes expected_digest below."""
    require(type(database) is dict and set(database) == {'operationId', 'body'})
    require(type(firebase) is dict and set(firebase) == {'operationId', 'status', 'body'})
    require(database['operationId'] == firebase['operationId'] == operation)
    require(type(firebase['status']) is int and firebase['status'] == 200)
    db = parse(database['body'])
    require(type(db) is dict)
    for key in ('jobCount', 'tenantCount', 'operatorCount', 'calendarCount', 'roleCount', 'sessionCount'):
        require(type(db.get(key)) is int and db[key] >= 0)
    # Reuse the actual database parser, once, with an inert supplied-response port.
    adapter = object.__new__(q.Adapter)
    adapter.io = SimpleNamespace(sql=lambda *args: db)
    adapter.binding = {'databasePassword': 'INERT_NO_CREDENTIAL'}
    adapter.times = {'readEnd': 0}
    adapter.clock = lambda: 0
    existing = q.Adapter.read_database(adapter, 0)
    row = db['operator']
    target = {key: row.get(key) for key in ('id', 'tenantId', 'email', 'fullName', 'role', 'status')}
    require(target_digest(target) == expected_digest and existing['operatorExactDisabled'] is True)
    source.entry.readbacks.exact_account(row, target)
    flags = {'accountExactDisabled': True, 'databaseSessionsAbsent': db['sessionCount'] == 0}
    body = parse(firebase['body'])
    require(type(body) is dict and type(body.get('users')) is list and len(body['users']) == 1)
    user = body['users'][0]
    require(type(user) is dict and 'tokensValidAfterTime' not in user)
    required = {'localId', 'email', 'displayName', 'disabled', 'emailVerified', 'customAttributes', 'validSince'}
    require(required <= set(user))
    claims = parse(user['customAttributes'])
    require(type(claims) is dict)
    flags.update(firebaseIdentityExact=(user['localId'] == target['id'] and
                 user['email'] == target['email'] and user['displayName'] == target['fullName']),
                 firebaseDisabled=user['disabled'] is True,
                 emailUnverified=user['emailVerified'] is False,
                 claimsExact=(set(claims) == {'tenantId', 'role', 'testOnly'} and
                   claims['tenantId'] == target['tenantId'] and claims['role'] == 'admin' and claims['testOnly'] is True))
    value = user['validSince']
    require(type(value) is str and re.fullmatch(r'[0-9]{1,12}', value) is not None)
    seconds = int(value)
    require(seconds <= 253402300799)
    normalized = {'uid': user['localId'], 'email': user['email'], 'displayName': user['displayName'],
                  'disabled': user['disabled'], 'emailVerified': user['emailVerified'],
                  'customClaims': claims,
                  'tokensValidAfterTime': datetime.datetime.fromtimestamp(seconds, datetime.timezone.utc).isoformat()}
    # Existing exact validator owns second-precision cutoff and account semantics.
    threshold = datetime.datetime.fromisoformat(intent.replace('Z', '+00:00')).timestamp()
    flags['revocationBoundMet'] = seconds >= int(threshold)
    if all(flags.values()):
        source.entry.readbacks.exact_firebase(normalized, target, threshold)
    return flags


def validate(binding, database, firebase, historical_journal):
    """Validate supplied observations only. Binding is provenance, not live authority."""
    flags = dict.fromkeys(FLAGS, False)
    try:
        require(type(binding) is dict and set(binding) ==
                {'operationId', 'historicalOperationId', 'journalSha256', 'revocationIntentAt'})
        source.m.exact_uuid(binding['operationId'], 'CONTAINMENT_OPERATION')
        require(binding['historicalOperationId'] == R47_OPERATION and
                binding['journalSha256'] == R47_JOURNAL_SHA256 and binding['revocationIntentAt'] == R47_INTENT)
        require(type(historical_journal) is bytes and hashlib.sha256(historical_journal).hexdigest() == R47_JOURNAL_SHA256)
        journal = parse(historical_journal)
        require(journal['operationId'] == R47_OPERATION and journal['authClient']['revocationIntentAt'] == R47_INTENT)
        flags['bindingExact'] = True
        flags.update(_payloads(binding['operationId'], database, firebase, R47_INTENT, q.TARGET_SHA256))
    except Exception:
        pass  # Never expose raw provider data, identifiers or exception text.
    return {'status': 'CURRENT_CONTAINMENT_CONFIRMED' if all(flags.values()) else 'CURRENT_CONTAINMENT_UNKNOWN',
            'flags': flags, 'historicalAuthentication': 'UNKNOWN'}


def r51_policy(native_result_raw, closeout_raw):
    """Bind the approved current policy, never reconstruct historical revocation intent."""
    try:
        require(type(native_result_raw) is bytes and type(closeout_raw) is bytes and
                hashlib.sha256(native_result_raw).hexdigest() == R51_RESULT_SHA256 and
                hashlib.sha256(closeout_raw).hexdigest() == R51_CLOSEOUT_SHA256)
        native, closeout = parse(native_result_raw), parse(closeout_raw)
        require(native['operationId'] == R51_OPERATION and
                native['status'] == 'ENTRY_CONTAINMENT_UNCONFIRMED' and
                native['privateInputsAbsent'] is True and
                closeout['privateInputsAbsent'] is True and
                closeout['matchingOperationProcessesAbsent'] is True and
                closeout['receiptCustodyVerified'] is True and closeout['noRetry'] is True)
        observed = datetime.datetime.fromisoformat(closeout['observedAt'].replace('Z', '+00:00'))
        require(observed.tzinfo is not None and
                observed.isoformat() == '2026-11-15T22:02:02.312864+00:00' and
                math.ceil(observed.timestamp()) == R51_POLICY_SECOND)
        return {'kind': 'POST_PROCESS_OBSERVATION', 'historicalOperationId': R51_OPERATION,
                'minimumValidSince': R51_POLICY_SECOND, 'historicalAuthentication': 'UNKNOWN'}
    except Exception:
        raise ValueError('CONTAINMENT_UNKNOWN') from None


def r54_policy(native_result_raw, closeout_raw):
    """Exact current-containment bound after verified R54 process closure."""
    try:
        require(type(native_result_raw) is bytes and type(closeout_raw) is bytes and
                hashlib.sha256(native_result_raw).hexdigest() == R54_RESULT_SHA256 and
                hashlib.sha256(closeout_raw).hexdigest() == R54_CLOSEOUT_SHA256)
        native, closeout = parse(native_result_raw), parse(closeout_raw)
        require(native['operationId'] == closeout['operationId'] == R54_OPERATION and
                native['status'] == 'ENTRY_CONTAINMENT_UNCONFIRMED' and
                native['privateInputsAbsent'] is True and
                closeout['nativePrivateFilesAbsent'] is True and
                closeout['matchingOperationProcessesAbsent'] is True and
                type(closeout['matchingProcessCount']) is int and closeout['matchingProcessCount'] == 0 and
                closeout['receiptCustodyVerified'] is True and closeout['noRetry'] is True)
        observed = datetime.datetime.fromisoformat(closeout['observedAt'])
        require(observed.isoformat() == '2026-11-17T11:10:48.108259+00:00' and
                math.ceil(observed.timestamp()) == R54_POLICY_SECOND)
        return {'kind': 'POST_PROCESS_OBSERVATION', 'historicalOperationId': R54_OPERATION,
                'minimumValidSince': R54_POLICY_SECOND, 'historicalAuthentication': 'UNKNOWN'}
    except Exception:
        raise ValueError('CONTAINMENT_UNKNOWN') from None


def current_account(operation, database, *, final=False):
    """Return safe flags and a transient target only after exact disabled-account proof."""
    flags = dict.fromkeys(CURRENT_ACCOUNT_FLAGS, None)
    target = None
    try:
        source.m.exact_uuid(operation, 'CONTAINMENT_OPERATION')
        require(type(final) is bool and type(database) is dict and
                set(database) == {'operationId', 'body'})
        flags['bindingExact'] = database['operationId'] == operation
        require(flags['bindingExact'])
        db = parse(database['body'])
        require(type(db) is dict)
        if final:
            require(set(db) == {'operatorCount', 'operator', 'sessionsAbsent'} and
                    type(db['operatorCount']) is int and db['operatorCount'] >= 0)
            flags['databaseSessionsAbsent'] = (db['sessionsAbsent']
                                               if type(db['sessionsAbsent']) is bool else None)
        else:
            require(set(db) == {'jobCount', 'job', 'tenantCount', 'tenant', 'operatorCount',
                               'operator', 'calendarCount', 'roleCount', 'sessionCount'})
            require(all(type(db[key]) is int and db[key] >= 0 for key in
                        ('jobCount', 'tenantCount', 'operatorCount', 'calendarCount',
                         'roleCount', 'sessionCount')))
            flags['databaseSessionsAbsent'] = db['sessionCount'] == 0
        if db['operatorCount'] != 1:
            flags['accountIdentityExact'] = False
            return flags, None
        row = db['operator']
        fields = ('id', 'tenantId', 'email', 'fullName', 'role', 'status')
        require(type(row) is dict and set(row) == set(fields) and
                all(type(row[key]) is str for key in fields))
        candidate = {key: row[key] for key in fields}
        source.m.exact_uuid(candidate['id'], 'CONTAINMENT_UID')
        # Fingerprint the immutable identity with its expected status, then check
        # the actually observed status independently. ACTIVE can never authorize use.
        expected = {**candidate, 'status': 'DISABLED'}
        flags['accountIdentityExact'] = target_digest(expected) == q.TARGET_SHA256
        flags['accountExactDisabled'] = row['status'] == 'DISABLED'
        require(flags['accountIdentityExact'] and flags['accountExactDisabled'])
        source.entry.readbacks.exact_account(row, expected)
        if not final:
            adapter = object.__new__(q.Adapter)
            adapter.io = SimpleNamespace(sql=lambda *args: db)
            adapter.binding = {'databasePassword': 'INERT_NO_CREDENTIAL'}
            adapter.times, adapter.clock = {'readEnd': 0}, lambda: 0
            require(q.Adapter.read_database(adapter, 0)['operatorExactDisabled'] is True)
        flags['validatorAccepted'] = True
        target = expected
    except Exception:
        pass  # Only fixed booleans/unknowns escape; no row or exception text.
    return flags, target


def current_firebase(operation, firebase, target, now_seconds, *, initial_valid_since=None,
                     requested_valid_since=None, policy_minimum=R51_POLICY_SECOND):
    """Return safe flags plus transient seconds; raw user data never leaves this helper."""
    flags = dict.fromkeys(CURRENT_FIREBASE_FLAGS, None)
    observed_seconds = None
    try:
        require(type(policy_minimum) is int and policy_minimum in (R51_POLICY_SECOND, R54_POLICY_SECOND))
        source.m.exact_uuid(operation, 'CONTAINMENT_OPERATION')
        fields = ('id', 'tenantId', 'email', 'fullName', 'role', 'status')
        require(type(target) is dict and set(target) == set(fields) and
                all(type(target[key]) is str for key in fields))
        exact_target = {key: target[key] for key in fields}
        require(target_digest(exact_target) == q.TARGET_SHA256)
        source.m.exact_uuid(exact_target['id'], 'CONTAINMENT_UID')
        source.entry.readbacks.exact_account(exact_target, exact_target)
        require(type(now_seconds) is int and policy_minimum <= now_seconds <= MAX_VALID_SINCE)
        for value in (initial_valid_since, requested_valid_since):
            require(value is None or (type(value) is int and 0 <= value <= now_seconds))
        require(requested_valid_since is None or
                (initial_valid_since is not None and
                 requested_valid_since >= max(policy_minimum, initial_valid_since)))
        require(type(firebase) is dict and set(firebase) == {'operationId', 'status', 'body'})
        flags['bindingExact'] = firebase['operationId'] == operation
        require(flags['bindingExact'] and type(firebase['status']) is int and firebase['status'] == 200)
        body = parse(firebase['body'])
        require(type(body) is dict and type(body.get('users')) is list and len(body['users']) == 1)
        user = body['users'][0]
        required = {'localId', 'email', 'displayName', 'disabled', 'emailVerified',
                    'customAttributes', 'validSince'}
        require(type(user) is dict and required <= set(user) and 'tokensValidAfterTime' not in user)
        flags['firebaseIdentityExact'] = (user['localId'] == exact_target['id'] and
                                          user['email'] == exact_target['email'] and
                                          user['displayName'] == exact_target['fullName'])
        flags['firebaseDisabled'] = user['disabled'] if type(user['disabled']) is bool else None
        flags['emailUnverified'] = not user['emailVerified'] if type(user['emailVerified']) is bool else None
        claims = parse(user['customAttributes'])
        flags['claimsExact'] = (type(claims) is dict and set(claims) == {'tenantId', 'role', 'testOnly'} and
                               claims['tenantId'] == exact_target['tenantId'] and claims['role'] == 'admin' and
                               claims['testOnly'] is True)
        value = user['validSince']
        flags['revocationTimestampValid'] = (type(value) is str and
                                             re.fullmatch(r'[0-9]{1,12}', value) is not None)
        require(flags['revocationTimestampValid'])
        seconds = int(value)
        flags['revocationTimestampValid'] = seconds <= MAX_VALID_SINCE
        require(flags['revocationTimestampValid'])
        flags['revocationNotFuture'] = seconds <= now_seconds
        require(flags['revocationNotFuture'])
        observed_seconds = seconds
        threshold = max(policy_minimum, initial_valid_since or 0, requested_valid_since or 0)
        flags['revocationBoundMet'] = seconds >= threshold
        identity_flags = ('bindingExact', 'firebaseIdentityExact', 'firebaseDisabled', 'claimsExact',
                          'emailUnverified', 'revocationTimestampValid', 'revocationNotFuture')
        if all(flags[key] is True for key in identity_flags):
            normalized = {'uid': user['localId'], 'email': user['email'], 'displayName': user['displayName'],
                          'disabled': user['disabled'], 'emailVerified': user['emailVerified'],
                          'customClaims': claims,
                          'tokensValidAfterTime': datetime.datetime.fromtimestamp(seconds, datetime.timezone.utc).isoformat()}
            # A stale cutoff is a permitted observation before conditional correction;
            # the separate bound flag still refuses final containment acceptance.
            source.entry.readbacks.exact_firebase(normalized, exact_target, min(seconds, threshold))
            flags['validatorAccepted'] = True
    except Exception:
        pass
    return flags, observed_seconds
