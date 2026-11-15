"""CT1 pure validator. No runner, credentials, provider calls or native fallback."""
import datetime
import hashlib
import json
import re
from types import SimpleNamespace

import iq1_identity_boundary as source

q = source.q
R47_OPERATION = 'bea4fe6b-2202-48ed-9df1-84a17d23fcd8'
R47_JOURNAL_SHA256 = '7ea07c21fdc737f671a025de9b44980b2771ddbe9cfdd02cfdb26b9063c5323f'
R47_INTENT = '2026-11-14T19:22:30.000Z'
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
