"""SQ1: one non-authentication signature, with independently owned restoration.

Import and injected APIs grant no native authority. The CLI reads an immutable
scope and a separate exact external decision before constructing native hooks.
"""
import base64
import copy
import datetime
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import signal
import stat
import subprocess
import sys
import time
from contextlib import contextmanager
from types import SimpleNamespace
import urllib.error
import urllib.request
from urllib.parse import urlsplit

import iq1_identity_boundary as x

q, m, a, acl, entry, inv = x.q, x.m, x.a, x.acl, x.entry, x.inv
HERE = Path(__file__).resolve().parent
MANIFEST = HERE / 'sq1-source-manifest.json'
ACTION = 'SQ1_EXACT_NON_AUTHENTICATION_SIGN_ONCE'
DECISION = 'APPROVE_SQ1_SIGNING_DIAGNOSTIC_SDK_CACHE_AND_INDEPENDENT_CLEANUP'
SDK_EXCEPTION = 'SDK_READ_OWNER_REFRESH_INTERNAL_AUTH_RETRY_CACHE_NO_MUTATION_RETRY'
LIMITS = {'mainCli': 13, 'cleanupCli': 12, 'mainHttps': 10, 'cleanupHttps': 4,
          'cache': 2, 'enable': 1, 'disable': 1, 'policyAdd': 1, 'policyRemove': 1, 'sign': 1}
UID_SHA256 = '3d299bbf03a6c3e2315034fb3a809aedbb6f978c6e6741ff0201fe4464798f72'
PROJECT_HASH = q.PROJECT_NUMBER_SHA256
LEASE = '/private/tmp/p08-iq1-runtime-identity.lock'
PROJECT_PERMISSIONS = ['resourcemanager.projects.get', 'serviceusage.services.get', 'serviceusage.services.use']
IDENTITY_PERMISSIONS = ['iam.serviceAccounts.get', 'iam.serviceAccounts.getIamPolicy',
                        'iam.serviceAccounts.setIamPolicy', 'iam.serviceAccounts.enable', 'iam.serviceAccounts.disable']
REASONS = frozenset(('IAM_PERMISSION_DENIED', 'ACCESS_TOKEN_SCOPE_INSUFFICIENT', 'ACCESS_TOKEN_EXPIRED',
                    'SERVICE_DISABLED', 'SERVICE_NOT_ACTIVATED', 'SERVICE_USAGE_DENIED',
                    'CONSUMER_INVALID', 'SECURITY_POLICY_VIOLATED', 'VPC_SERVICE_CONTROLS'))
DOMAINS = frozenset(('googleapis.com', 'iam.googleapis.com', 'iamcredentials.googleapis.com', 'serviceusage.googleapis.com'))
ERROR_STATUSES = frozenset(('CANCELLED', 'UNKNOWN', 'INVALID_ARGUMENT', 'DEADLINE_EXCEEDED', 'NOT_FOUND',
                          'ALREADY_EXISTS', 'PERMISSION_DENIED', 'RESOURCE_EXHAUSTED', 'FAILED_PRECONDITION',
                          'ABORTED', 'OUT_OF_RANGE', 'UNIMPLEMENTED', 'INTERNAL', 'UNAVAILABLE',
                          'DATA_LOSS', 'UNAUTHENTICATED'))
MAX_OUTPUT = 65536
SETTLE_SECONDS = 420
MAIN_ADMISSION_SECONDS = SETTLE_SECONDS + 300
POST_SETTLE_SECONDS = 60
SDK_BOOTSTRAP = ("import sys,os,time,threading,runpy\n"
                 "sys.argv.pop(0); end=float(sys.argv.pop(0)); remaining=min(8.0,end-time.time())\n"
                 "if remaining<=0: os._exit(124)\n"
                 "def expire():\n threading.Event().wait(remaining); os._exit(124)\n"
                 "threading.Thread(target=expire,daemon=True).start()\n"
                 "runpy.run_path(sys.argv[0],run_name='__main__')\n")


class Stop(Exception):
    pass


def need(value, code):
    if not value:
        raise Stop(code)


SAFE = frozenset(('SQ1_SCOPE SQ1_SOURCE SQ1_CONFIG SQ1_AUTHORITY SQ1_WINDOW SQ1_DEADLINE SQ1_CLOCK '
                  'SQ1_CUSTODY SQ1_REPLAY SQ1_BUDGET SQ1_DESCRIPTOR SQ1_OWNER SQ1_PROJECT SQ1_UID '
                  'SQ1_INITIAL_STATE SQ1_IDENTITY SQ1_ROLE SQ1_SERVICE SQ1_PERMISSION SQ1_POLICY '
                  'SQ1_POLICY_OWNERSHIP SQ1_ETAG SQ1_CREDENTIAL SQ1_HTTP SQ1_OUTPUT SQ1_PREDICTION '
                  'SQ1_INTERRUPTED SQ1_PROCESS SQ1_PROCESS_UNKNOWN SQ1_UNKNOWN SQ1_PARENT_UNKNOWN '
                  'SQ1_HTTP_TIMEOUT SQ1_PROCESS_TIMEOUT').split())


def safe_code(error):
    if type(error) is Stop and len(error.args) == 1 and type(error.args[0]) is str and error.args[0] in SAFE:
        return error.args[0]
    if type(error) is acl.Stop and error.args == ('HTTP_TIMEOUT',):
        return 'SQ1_HTTP_TIMEOUT'
    if type(error) is m.Stop and len(error.args) == 1 and type(error.args[0]) is str:
        return {'PROCESS_TIMEOUT': 'SQ1_PROCESS_TIMEOUT', 'PROCESS_DEADLINE': 'SQ1_PROCESS_TIMEOUT',
                'CLOCK_ROLLBACK': 'SQ1_CLOCK', 'PROCESS_OUTPUT_LIMIT': 'SQ1_OUTPUT',
                'PROCESS_CLEANUP_UNCONFIRMED': 'SQ1_PROCESS_UNKNOWN',
                'PROCESS_OWNERSHIP_UNKNOWN': 'SQ1_PROCESS_UNKNOWN'}.get(error.args[0], 'SQ1_UNKNOWN')
    if type(error) is TimeoutError: return 'SQ1_HTTP_TIMEOUT'
    return 'SQ1_INTERRUPTED' if isinstance(error, (KeyboardInterrupt, SystemExit)) else 'SQ1_UNKNOWN'


def digest(value):
    return x.digest(value)


def commands():
    current = {d['id']: list(d['argv']) for d in q.current_cli_contract()}
    role = list(current['signing_role'])
    role[-1] = '--format=json(name,title,description,includedPermissions,stage,deleted,etag)'
    return {'owner': current['owner'], 'project': current['project'], 'identity': current['identity'],
            'readback': x.commands()['readback'], 'role': role,
            'token_owner': [q.GCLOUD, 'auth', 'list', '--filter=status:ACTIVE', '--format=value(account)'],
            'config_impersonation': [q.GCLOUD, 'config', 'get-value', 'auth/impersonate_service_account'],
            'config_credential': [q.GCLOUD, 'config', 'get-value', 'auth/credential_file_override'],
            'config_access_token': [q.GCLOUD, 'config', 'get-value', 'auth/access_token_file'],
            'token': [q.GCLOUD, 'auth', 'print-access-token', '--account=' + m.OWNER]}


def sdk_command(vector, deadline):
    need(type(vector) is list and vector in commands().values(), 'SQ1_DESCRIPTOR')
    need(type(deadline) in (float, int), 'SQ1_DEADLINE')
    # The watchdog runs in the SDK process, independently of the owning parent
    # and of the SDK spinner's SIGALRM handler. No extra process/provider call.
    return [x.SANDBOX, '-p', x.PROFILE, x.p.PYTHON, '-I', '-B', '-S', '-c', SDK_BOOTSTRAP,
            str(deadline - 2), str(x.SDK), *vector[1:]]


def root_for(operation_id):
    m.exact_uuid(operation_id, 'SQ1_OPERATION')
    return Path('/private/tmp/p08-sq1-' + operation_id)


def validate_scope(scope, now, phase='main'):
    fields = {'version', 'action', 'operationId', 'sourceCommit', 'manifestSha256', 'iq1ManifestSha256',
              'configSha256', 'uidSha256', 'projectNumberSha256', 'window', 'limits', 'sdkException',
              'commands', 'allowanceUsd', 'automaticRetryAllowed'}
    need(type(scope) is dict and set(scope) == fields, 'SQ1_SCOPE')
    need(type(scope['version']) is int and scope['version'] == 1 and scope['action'] == ACTION and
         scope['limits'] == LIMITS and all(type(v) is int for v in scope['limits'].values()) and
         scope['sdkException'] == SDK_EXCEPTION and scope['commands'] == commands() and
         type(scope['allowanceUsd']) is int and scope['allowanceUsd'] == 0 and
         scope['automaticRetryAllowed'] is False, 'SQ1_SCOPE')
    root_for(scope['operationId'])
    need(type(scope['sourceCommit']) is str and re.fullmatch('[a-f0-9]{40}', scope['sourceCommit']), 'SQ1_SOURCE')
    for key in ('manifestSha256', 'iq1ManifestSha256', 'configSha256', 'uidSha256', 'projectNumberSha256'):
        need(type(scope[key]) is str and re.fullmatch('[a-f0-9]{64}', scope[key]), 'SQ1_SOURCE')
    need(scope['uidSha256'] == UID_SHA256 and scope['projectNumberSha256'] == PROJECT_HASH, 'SQ1_UID')
    need(type(scope['window']) is dict and set(scope['window']) ==
         {'start', 'cutoff', 'workEnd', 'cleanupEnd', 'purgeEnd'}, 'SQ1_WINDOW')
    times = {key: m.timestamp(value) for key, value in scope['window'].items()}
    need(times['start'] < times['cutoff'] < times['workEnd'] < times['cleanupEnd'] < times['purgeEnd'] and
         times['cleanupEnd'] - times['workEnd'] >= 660 and times['purgeEnd'] - times['cleanupEnd'] >= 120 and
         times['purgeEnd'] - times['start'] <= 3600, 'SQ1_WINDOW')
    need(phase in ('main', 'cleanup'), 'SQ1_SCOPE')
    if phase == 'main':
        need(times['start'] <= now < times['cutoff'] and
             times['workEnd'] - now >= MAIN_ADMISSION_SECONDS, 'SQ1_DEADLINE')
    else:
        need(times['start'] <= now < times['cleanupEnd'], 'SQ1_DEADLINE')
    return times


def source_guard(scope):
    """Static files/configuration only; no SDK command or credential access."""
    need(MANIFEST.is_file() and not MANIFEST.is_symlink() and digest(MANIFEST.read_bytes()) == scope['manifestSha256'], 'SQ1_SOURCE')
    manifest = strict_json(MANIFEST.read_bytes())
    need(type(manifest) is dict and set(manifest) == {'version', 'files', 'sdkFiles'} and manifest['version'] == 1,
         'SQ1_SOURCE')
    required = {str((HERE / name).relative_to(x.p.B)) for name in ('sq1_signing_boundary.py', 'test_sq1_signing_boundary.py')}
    need(type(manifest['files']) is dict and required <= set(manifest['files']) and
         type(manifest['sdkFiles']) is dict and bool(manifest['sdkFiles']), 'SQ1_SOURCE')
    for name, expected in manifest['files'].items():
        need(not Path(name).is_absolute() and '..' not in Path(name).parts, 'SQ1_SOURCE')
        path = x.p.B / name
        need(path.is_file() and not path.is_symlink() and digest(path.read_bytes()) == expected and
             digest(a.committed(x.p.B, scope['sourceCommit'], name)) == expected, 'SQ1_SOURCE')
    need(digest(a.committed(x.p.B, scope['sourceCommit'], str(MANIFEST.relative_to(x.p.B)))) ==
         scope['manifestSha256'], 'SQ1_SOURCE')
    for name, expected in manifest['sdkFiles'].items():
        path = Path(name)
        need(path.is_absolute() and path.is_file() and digest(path.read_bytes()) == expected, 'SQ1_SOURCE')
    x.source_guard({'sourceCommit': scope['sourceCommit'], 'manifestSha256': scope['iq1ManifestSha256']})


def strict_json(raw):
    need(isinstance(raw, (bytes, str)) and len(raw if isinstance(raw, bytes) else raw.encode()) <= MAX_OUTPUT, 'SQ1_OUTPUT')
    # Bound nesting before json.loads (which otherwise accepts very deep inputs).
    text = raw.decode('utf-8', 'strict') if isinstance(raw, bytes) else raw
    depth = 0; quoted = False; escaped = False
    for char in text:
        if quoted:
            if escaped: escaped = False
            elif char == '\\': escaped = True
            elif char == '"': quoted = False
        elif char == '"': quoted = True
        elif char in '[{':
            depth += 1; need(depth <= 24, 'SQ1_OUTPUT')
        elif char in ']}': depth -= 1
    return q.strict_json(text.encode())


def classify_sign_response(status, raw, expected=None):
    observed = status if type(status) is int and 100 <= status <= 599 else None
    result = {'httpStatus': observed, 'outcome': 'UNKNOWN', 'failureCategory': 'RESPONSE_VALIDATION',
              'errorCode': 'UNKNOWN', 'errorStatus': 'UNKNOWN', 'errorInfo': [], 'signatureObserved': False}
    try:
        value = strict_json(raw)
        need(type(value) is dict and observed is not None, 'SQ1_OUTPUT')
        if 200 <= observed < 300:
            need(set(value) <= {'keyId', 'signedBlob'} and type(value.get('signedBlob')) is str and
                 0 < len(value['signedBlob']) <= MAX_OUTPUT and type(value.get('keyId')) is str and
                 0 < len(value['keyId']) <= 1024, 'SQ1_OUTPUT')
            signature = base64.b64decode(value['signedBlob'], validate=True)
            need(bool(signature), 'SQ1_OUTPUT'); signature = None
            result.update(outcome='SIGNED', failureCategory=None, signatureObserved=True)
            return result
        result['failureCategory'] = 'HTTP'
        need(set(value) == {'error'} and type(value['error']) is dict, 'SQ1_OUTPUT')
        error = value['error']
        need(set(error) <= {'code', 'message', 'status', 'details'}, 'SQ1_OUTPUT')
        code = error.get('code'); label = error.get('status')
        need(type(code) is int and code == observed and 100 <= code <= 599, 'SQ1_OUTPUT')
        need(type(label) is str and label in ERROR_STATUSES, 'SQ1_OUTPUT')
        result.update(errorCode=code, errorStatus=label)
        details = error.get('details', [])
        need(type(details) is list and len(details) <= 32, 'SQ1_OUTPUT')
        expected = {'permission': 'iam.serviceAccounts.signBlob', 'service': 'iamcredentials.googleapis.com',
                    'consumer': None, 'target': m.IDENTITY} if expected is None else expected
        need(type(expected) is dict and set(expected) == {'permission', 'service', 'consumer', 'target'}, 'SQ1_OUTPUT')
        safe = []
        for detail in details:
            need(type(detail) is dict, 'SQ1_OUTPUT')
            if detail.get('@type') != 'type.googleapis.com/google.rpc.ErrorInfo':
                safe.append({'reason': 'UNKNOWN', 'domain': 'UNKNOWN',
                             'metadataMatches': {k: 'UNKNOWN' for k in expected}}); continue
            need(set(detail) <= {'@type', 'reason', 'domain', 'metadata'}, 'SQ1_OUTPUT')
            reason, domain = detail.get('reason'), detail.get('domain')
            need(type(reason) is str and type(domain) is str, 'SQ1_OUTPUT')
            metadata = detail.get('metadata', {})
            need(type(metadata) is dict and all(type(k) is str and type(v) is str
                 for k, v in metadata.items()), 'SQ1_OUTPUT')
            flags = {key: 'UNKNOWN' if key not in metadata or wanted is None else
                     'MATCH' if metadata[key] == wanted else 'MISMATCH' for key, wanted in expected.items()}
            safe.append({'reason': reason if reason in REASONS else 'UNKNOWN',
                         'domain': domain if domain in DOMAINS else 'UNKNOWN', 'metadataMatches': flags})
        # Multiple conflicting reasons cannot become a confident classification.
        result['errorInfo'] = safe
        known = {(row['reason'], row['domain']) for row in safe
                 if row['reason'] != 'UNKNOWN' and row['domain'] != 'UNKNOWN'}
        if len(known) == 1 and all(row['reason'] != 'UNKNOWN' and row['domain'] != 'UNKNOWN' for row in safe):
            result['outcome'] = 'REFUSED'
        elif len(known) > 1:
            result['errorInfo'] = [{'reason': 'UNKNOWN', 'domain': 'UNKNOWN',
                                    'metadataMatches': {key: 'UNKNOWN' for key in expected}}]
        return result
    except BaseException:
        result.update(outcome='UNKNOWN', errorInfo=[])
        return result
    finally:
        raw = None; value = None


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


def bounded_request(descriptor, token, deadline, *, clock, opener):
    """One Request/open only, including HTTPError; no implicit native opener."""
    status = None; response = None; raw = None; failure = None
    try:
        need(type(descriptor) is dict and set(descriptor) == {'id', 'method', 'url', 'body'}, 'SQ1_DESCRIPTOR')
        target = urlsplit(descriptor['url'])
        need(target.scheme == 'https' and target.hostname in {'iam.googleapis.com', 'iamcredentials.googleapis.com',
             'cloudresourcemanager.googleapis.com', 'serviceusage.googleapis.com', 'policytroubleshooter.googleapis.com'} and
             not target.username and not target.password and not target.fragment and target.port in (None, 443), 'SQ1_DESCRIPTOR')
        need(descriptor['method'] in ('GET', 'POST') and type(token) is str and 20 <= len(token) <= 4096 and
             not any(char.isspace() for char in token), 'SQ1_CREDENTIAL')
        remaining = min(8, deadline - clock()); need(remaining > 0, 'SQ1_DEADLINE')
        body = None if descriptor['body'] is None else json.dumps(descriptor['body'], separators=(',', ':')).encode()
        request = urllib.request.Request(descriptor['url'], data=body, method=descriptor['method'],
            headers={'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json', 'x-goog-user-project': 'signmons'})
        with acl.http_deadline(remaining):
            try:
                response = opener.open(request, timeout=remaining)
            except urllib.error.HTTPError as error:
                response = error
            candidate = response.status
            status = candidate if type(candidate) is int and 100 <= candidate <= 599 else None
            need(status is not None and not 300 <= status <= 399, 'SQ1_HTTP')
            chunks = []; size = 0
            while True:
                part = response.read(min(8192, MAX_OUTPUT + 1 - size))
                need(type(part) is bytes, 'SQ1_OUTPUT')
                if not part: break
                size += len(part); need(size <= MAX_OUTPUT, 'SQ1_OUTPUT'); chunks.append(part)
                need(clock() < deadline, 'SQ1_DEADLINE')
            raw = b''.join(chunks); chunks.clear()
            response.close(); response = None
            need(clock() < deadline, 'SQ1_DEADLINE')
    except BaseException as error:
        failure = safe_code(error); raw = None
    finally:
        if response is not None:
            try:
                with acl.http_deadline(max(.01, min(1, deadline - clock()))): response.close()
            except BaseException:
                failure = 'SQ1_HTTP'; raw = None
        token = ''; body = None; request = None
    return {'status': status, 'body': raw, 'bodyFailure': failure}


def binding(scope):
    return {'role': m.SIGNING_ROLE, 'members': ['user:' + m.OWNER], 'condition': {
        'expression': "request.time >= timestamp('%s') && request.time < timestamp('%s')" %
                      (scope['window']['start'], scope['window']['workEnd']),
        'title': 'p08_' + scope['operationId'] + '_signing'}}


def descriptor_contract(scope, uid, number, policy=None, receive_time=None):
    need(type(uid) is str and re.fullmatch('[0-9]{6,30}', uid) and type(number) is str and
         re.fullmatch('[0-9]{6,20}', number), 'SQ1_DESCRIPTOR')
    iam = 'https://iam.googleapis.com/v1/projects/signmons/serviceAccounts/' + uid
    def d(name, method, url, body=None): return {'id': name, 'method': method, 'url': url, 'body': body}
    rows = {name: d(name, 'GET', 'https://serviceusage.googleapis.com/v1/projects/' + number + '/services/' + service + '?fields=name,state')
            for name, service in (('service_signing', 'iamcredentials.googleapis.com'), ('service_troubleshooter', 'policytroubleshooter.googleapis.com'))}
    rows.update({
        'project_permissions': d('project_permissions', 'POST', 'https://cloudresourcemanager.googleapis.com/v1/projects/' + number + ':testIamPermissions', {'permissions': PROJECT_PERMISSIONS}),
        'identity_permissions': d('identity_permissions', 'POST', iam + ':testIamPermissions', {'permissions': IDENTITY_PERMISSIONS}),
        'enable': d('enable', 'POST', iam + ':enable', {}), 'disable': d('disable', 'POST', iam + ':disable', {}),
        'sign': d('sign', 'POST', 'https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/' + m.IDENTITY + ':signBlob',
                  {'payload': base64.b64encode(('Signmons P08 signing diagnostic ' + scope['operationId'] + ' not authentication').encode()).decode()}),
    })
    for name in ('policy_before', 'policy_after', 'policy_cleanup_before', 'policy_cleanup_after'):
        rows[name] = d(name, 'POST', iam + ':getIamPolicy?options.requestedPolicyVersion=3')
    if policy is not None:
        for name in ('policy_add', 'policy_remove'): rows[name] = d(name, 'POST', iam + ':setIamPolicy', {'policy': policy})
    if receive_time is not None:
        # Build through the existing exact tuple adapter, with an inert capture.
        stage = entry.bridge.packet.module('stage_a'); captured = []
        adapter = stage.RequestAdapter({'projectNumber': number}, transport=lambda v: (captured.append(v) or
                  {'httpStatus': 200, 'body': '{"overallAccessState":"CAN_ACCESS"}'}))
        adapter.diagnostic(*stage.TUPLES[-1], receive_time)
        value = captured[0]
        rows['prediction'] = d('prediction', value['method'], value['url'], strict_json(value['body']))
    return rows


def policy_state(policy, scope):
    roles = entry.bridge.packet.module('roles')
    need(roles.policy_shape(policy) != 'INVALID' and type(policy) is dict, 'SQ1_POLICY')
    need(type(policy.get('etag')) is str and 0 < len(policy['etag']) <= 4096, 'SQ1_ETAG')
    rows = policy.get('bindings', [])
    need(type(rows) is list, 'SQ1_POLICY')
    need('version' not in policy or type(policy['version']) is int and policy['version'] in (0, 1, 3), 'SQ1_POLICY')
    if any('condition' in row for row in rows): need(policy.get('version') == 3, 'SQ1_POLICY')
    for row in rows:
        need(type(row) is dict and set(row) <= {'role', 'members', 'condition'} and type(row.get('members')) is list and
             bool(row['members']) and all(type(member) is str and bool(member) for member in row['members']), 'SQ1_POLICY')
        if 'condition' in row:
            need(type(row['condition']) is dict and set(row['condition']) <= {'title', 'description', 'expression', 'location'} and
                 type(row['condition'].get('expression')) is str and
                 all(type(value) is str for value in row['condition'].values()), 'SQ1_POLICY')
    matching = [row for row in rows if row.get('role') == m.SIGNING_ROLE]
    need(not matching or matching == [binding(scope)], 'SQ1_POLICY_OWNERSHIP')
    return 'OWNED' if matching else 'ABSENT'


def modified_policy(policy, scope, add):
    expected = 'ABSENT' if add else 'OWNED'
    need(policy_state(policy, scope) == expected, 'SQ1_POLICY_OWNERSHIP')
    value = copy.deepcopy(policy)
    if add:
        value.setdefault('bindings', []).append(binding(scope)); value['version'] = 3
    else: value['bindings'] = [row for row in value.get('bindings', []) if row != binding(scope)]
    return value


RESIDUALS = frozenset(('PROCESS_CLOSEOUT_UNKNOWN', 'CONFIGURATION_UNCONFIRMED', 'SOURCE_UNCONFIRMED',
    'MAIN_PROCESS_CLOSEOUT_UNKNOWN', 'MAIN_RECEIPT_UNCONFIRMED', 'SIGNING_BINDING_UNCONFIRMED',
    'IDENTITY_DISABLED_UNCONFIRMED', 'ENABLE_OUTCOME_UNKNOWN', 'POLICY_ADD_OUTCOME_UNKNOWN',
    'DISABLE_OUTCOME_UNKNOWN', 'POLICY_REMOVE_OUTCOME_UNKNOWN', 'CLOSEOUT_DEADLINE'))


def validate_sign_result(value):
    need(type(value) is dict and set(value) == {'httpStatus', 'outcome', 'failureCategory', 'errorCode',
         'errorStatus', 'errorInfo', 'signatureObserved'}, 'SQ1_CUSTODY')
    status = value['httpStatus']
    need(status is None or type(status) is int and 100 <= status <= 599, 'SQ1_CUSTODY')
    need(value['outcome'] in ('SIGNED', 'REFUSED', 'UNKNOWN') and
         (value['failureCategory'] is None or type(value['failureCategory']) is str and
          value['failureCategory'] in SAFE | {'HTTP', 'RESPONSE_VALIDATION'}), 'SQ1_CUSTODY')
    need(value['errorCode'] == 'UNKNOWN' or type(value['errorCode']) is int and value['errorCode'] == status,
         'SQ1_CUSTODY')
    need(type(value['errorStatus']) is str and value['errorStatus'] in ERROR_STATUSES | {'UNKNOWN'} and
         type(value['signatureObserved']) is bool, 'SQ1_CUSTODY')
    need(type(value['errorInfo']) is list and len(value['errorInfo']) <= 32, 'SQ1_CUSTODY')
    for item in value['errorInfo']:
        need(type(item) is dict and set(item) == {'reason', 'domain', 'metadataMatches'} and
             type(item['reason']) is str and item['reason'] in REASONS | {'UNKNOWN'} and
             type(item['domain']) is str and item['domain'] in DOMAINS | {'UNKNOWN'}, 'SQ1_CUSTODY')
        flags = item['metadataMatches']
        need(type(flags) is dict and set(flags) == {'permission', 'service', 'consumer', 'target'} and
             all(type(v) is str and v in ('MATCH', 'MISMATCH', 'UNKNOWN') for v in flags.values()), 'SQ1_CUSTODY')
    if value['outcome'] == 'SIGNED':
        need(type(status) is int and 200 <= status < 300 and value['signatureObserved'] is True, 'SQ1_CUSTODY')
    return value


def validate_result(value, journal, phase):
    fields = set(journal.base) | {'phase', 'status', 'failure', 'mainFailure', 'signResult', 'policyAbsent',
        'identityDisabled', 'processClosed', 'configurationClosed', 'sourceClosed', 'privateInputsAbsent',
        'counts', 'mainCounts', 'cleanupFailures', 'residuals', 'onTime', 'finishedAt', 'paymentObserved', 'automaticRetryAllowed'}
    need(type(value) is dict and set(value) == fields and all(value.get(k) == v for k, v in journal.base.items()) and
         value['phase'] == phase, 'SQ1_CUSTODY')
    states = ('SQ1_MAIN_FINISHED',) if phase == 'main' else ('SQ1_CONTAINMENT_UNCONFIRMED', 'SQ1_DIAGNOSTIC_CLOSED', 'SQ1_NOT_MUTATED')
    need(value['status'] in states, 'SQ1_CUSTODY')
    for key in ('failure', 'mainFailure'):
        need(value[key] is None or type(value[key]) is str and value[key] in SAFE, 'SQ1_CUSTODY')
    for key in ('policyAbsent', 'identityDisabled'):
        need(value[key] is None or type(value[key]) is bool, 'SQ1_CUSTODY')
    for key in ('processClosed', 'configurationClosed', 'sourceClosed', 'privateInputsAbsent', 'onTime'):
        need(type(value[key]) is bool, 'SQ1_CUSTODY')
    need(value['paymentObserved'] is False and value['automaticRetryAllowed'] is False and
         type(value['finishedAt']) in (int, float) and 0 < value['finishedAt'] < float('inf'), 'SQ1_CUSTODY')
    def counts(v, for_phase):
        need(type(v) is dict and set(v) == {'cli', 'https', 'cache'} and all(type(n) is int for n in v.values()) and
             0 <= v['cli'] <= LIMITS[for_phase + 'Cli'] and 0 <= v['https'] <= LIMITS[for_phase + 'Https'] and
             0 <= v['cache'] <= 1, 'SQ1_CUSTODY')
    counts(value['counts'], phase)
    for kind, total in value['counts'].items():
        paths = sorted(journal.root.glob(phase + '-' + kind + '-??.json'))
        need(len(paths) == total, 'SQ1_CUSTODY')
        for index, path in enumerate(paths):
            row = journal.read(path.name)
            need(type(row) is dict and set(row) == set(journal.base) | {'kind', 'slot', 'index'} and
                 all(row.get(k) == v for k, v in journal.base.items()) and row['kind'] == kind and
                 type(row['index']) is int and row['index'] == index and type(row['slot']) is str and
                 row['slot'] in set(commands()) | {'pre-sign-uid', 'final-uid', 'readback-0', 'readback-1', 'readback-2',
                    'owner-token', 'service_signing', 'service_troubleshooter', 'project_permissions', 'identity_permissions',
                    'policy_before', 'enable', 'policy_add', 'policy_after', 'prediction', 'sign',
                    'policy_cleanup_before', 'policy_remove', 'policy_cleanup_after', 'disable'}, 'SQ1_CUSTODY')
    if value['mainCounts'] is not None: counts(value['mainCounts'], 'main')
    need(type(value['cleanupFailures']) is dict and set(value['cleanupFailures']) <=
         {'policyMutation', 'policyReadback', 'identityMutation', 'identityReadback'} and
         all(type(v) is str and v in SAFE for v in value['cleanupFailures'].values()), 'SQ1_CUSTODY')
    need(type(value['residuals']) is list and all(type(v) is str and v in RESIDUALS for v in value['residuals']) and
         len(value['residuals']) == len(set(value['residuals'])), 'SQ1_CUSTODY')
    if value['signResult'] is not None: validate_sign_result(value['signResult'])
    return value


class Journal:
    """Only public scope and fixed safe receipts; no credentials or policy bodies."""
    def __init__(self, root, scope, create=False):
        self.root, self.scope = Path(root), scope
        need(self.root == root_for(scope['operationId']), 'SQ1_CUSTODY')
        if create: self.root.mkdir(mode=0o700)
        st = self.root.lstat()
        need(stat.S_ISDIR(st.st_mode) and not self.root.is_symlink() and st.st_uid == os.getuid() and
             stat.S_IMODE(st.st_mode) == 0o700, 'SQ1_CUSTODY')
        self.identity = [st.st_dev, st.st_ino]
        self.base = {'operationId': scope['operationId'], 'scopeSha256': digest(scope), 'rootIdentity': self.identity}
        self.inspect()
        if create:
            self.put('scope.json', scope)
            self.put('attempt.json', self.base)
        else:
            need(self.read('attempt.json') == self.base and self.read('scope.json') == scope, 'SQ1_CUSTODY')

    @staticmethod
    def allowed(name):
        return (name in {'scope.json', 'attempt.json', 'envelope.json', 'launch.json', 'supervision.json', 'supervisor-phase.json',
                         'entry.lock', 'main-phase.json', 'cleanup-phase.json', 'main-result.json', 'result.json',
                         'baseline-policy.json', 'baseline-identity.json', 'last-clock.json', 'last-clock.next'} or
                re.fullmatch(r'(main|cleanup)-(cli|https|cache)-[0-9]{2}\.json', name) is not None or
                re.fullmatch(r'(intent|ack)-(enable|disable|policyAdd|policyRemove|sign)\.json', name) is not None)

    def inspect(self):
        st = self.root.lstat()
        need(stat.S_ISDIR(st.st_mode) and st.st_uid == os.getuid() and stat.S_IMODE(st.st_mode) == 0o700 and
             [st.st_dev, st.st_ino] == self.identity, 'SQ1_CUSTODY')
        for path in self.root.iterdir():
            st = path.lstat()
            need(self.allowed(path.name) and stat.S_ISREG(st.st_mode) and st.st_uid == os.getuid() and
                 stat.S_IMODE(st.st_mode) == 0o600 and st.st_nlink == 1 and st.st_size <= MAX_OUTPUT, 'SQ1_CUSTODY')

    def sync(self):
        fd = os.open(self.root, os.O_RDONLY)
        try: os.fsync(fd)
        finally: os.close(fd)

    def put(self, name, value):
        self.inspect(); need(self.allowed(name) and name != 'entry.lock', 'SQ1_CUSTODY')
        inv.reserve(self.root / name, value); self.sync()

    def read(self, name):
        self.inspect(); need(self.allowed(name), 'SQ1_CUSTODY')
        return inv.read(self.root / name)

    def has(self, name):
        self.inspect()
        path = self.root / name
        if not path.exists(): return False
        value = self.read(name)
        need(type(value) is dict and all(value.get(k) == v for k, v in self.base.items()), 'SQ1_CUSTODY')
        return True

    def remember_clock(self, wall, mono):
        value = {**self.base, 'wall': wall, 'mono': mono}
        if (self.root / 'last-clock.json').exists():
            previous = self.read('last-clock.json')
            need(all(previous.get(k) == v for k, v in self.base.items()) and
                 type(previous.get('wall')) in (int, float) and type(previous.get('mono')) in (int, float) and
                 wall >= previous['wall'] and mono >= previous['mono'], 'SQ1_CLOCK')
        need(not (self.root / 'last-clock.next').exists(), 'SQ1_CUSTODY')
        self.put('last-clock.next', value)
        os.replace(self.root / 'last-clock.next', self.root / 'last-clock.json'); self.sync()


class Driver:
    def __init__(self, scope, phase, hooks, journal):
        self.scope, self.phase, self.h, self.j = scope, phase, hooks, journal
        self.times = validate_scope(scope, hooks.clock(), phase)
        self.last = hooks.clock(); self.mono = hooks.monotonic()
        self.end = self.times['workEnd' if phase == 'main' else 'cleanupEnd'] - 10
        self.hard_end = self.mono + max(0, self.end - self.last)
        self.io = None; self.token = ''; self.uid = ''; self.number = ''
        self.counts = {'cli': 0, 'https': 0, 'cache': 0}
        self.used = set(); self.interrupted = False; self.owned_active = False
        self.sign_result = None; self.policy_absent = None; self.identity_disabled = None
        self.failures = {}; self.closed = False; self.config_closed = False; self.source_closed = False

    def gate(self, cleanup=False):
        now, mono = self.h.clock(), self.h.monotonic()
        need(now >= self.last and mono >= self.mono, 'SQ1_CLOCK')
        self.last, self.mono = now, mono
        need(now < self.end and mono < self.hard_end, 'SQ1_DEADLINE')
        need(not self.interrupted or self.phase == 'cleanup' or cleanup, 'SQ1_INTERRUPTED')
        self.j.inspect()
        with acl.http_deadline(min(8, self.end - now)):
            self.h.guard(self.scope)
        need(self.h.configuration() == self.scope['configSha256'], 'SQ1_CONFIG')
        after, after_mono = self.h.clock(), self.h.monotonic()
        need(after >= now and after_mono >= mono and after < self.end and after_mono < self.hard_end, 'SQ1_DEADLINE')
        self.last, self.mono = after, after_mono
        self.j.remember_clock(after, after_mono)
        return min(after + 8, self.end)

    def reserve(self, kind, label):
        self.gate()
        limit = 1 if kind == 'cache' else LIMITS[self.phase + ('Cli' if kind == 'cli' else 'Https')]
        index = self.counts[kind]
        need(index < limit and (kind, label) not in self.used, 'SQ1_BUDGET')
        self.j.put('%s-%s-%02d.json' % (self.phase, kind, index),
                   {**self.j.base, 'kind': kind, 'slot': label, 'index': index})
        self.counts[kind] += 1; self.used.add((kind, label))

    def cli(self, name, label=None):
        need(name in commands(), 'SQ1_DESCRIPTOR')
        self.reserve('cli', label or name)
        vector = commands()[name]
        env = q.sdk_environment(os.environ)
        self.owned_active = True
        try:
            deadline = self.gate()
            raw = self.io._owned_run(sdk_command(vector, deadline), env, deadline)
        finally:
            self.owned_active = False; env = None
        self.gate()
        need(isinstance(raw, bytes) and len(raw) <= MAX_OUTPUT, 'SQ1_OUTPUT')
        if name in ('token_owner', 'config_impersonation', 'config_credential', 'config_access_token', 'token'):
            return raw.decode('utf-8', 'strict').strip()
        return strict_json(raw)

    def owner_project_uid(self, initial=False):
        need(self.cli('owner') == [{'account': m.OWNER, 'status': 'ACTIVE'}], 'SQ1_OWNER')
        project = self.cli('project')
        q.validate_recovery_project(SimpleNamespace(e={'projectNumberSha256': self.scope['projectNumberSha256']}), project)
        self.number = project['projectNumber']; project = None
        disabled = self.metadata('identity')
        if initial:
            need(disabled is True, 'SQ1_INITIAL_STATE')
            self.j.put('baseline-identity.json', {**self.j.base, 'disabled': True, 'uidSha256': self.scope['uidSha256']})

    def metadata(self, label):
        value = self.cli('identity', label)
        need(type(value) is dict and set(value) <= {'email', 'uniqueId', 'disabled'} and
             value.get('email') == m.IDENTITY and type(value.get('uniqueId')) is str and
             re.fullmatch('[0-9]{6,30}', value['uniqueId']) and
             digest(value['uniqueId'].encode()) == self.scope['uidSha256'], 'SQ1_UID')
        need('disabled' not in value or type(value['disabled']) is bool, 'SQ1_IDENTITY')
        self.uid = value['uniqueId']
        return value.get('disabled', False)

    def credentials(self):
        need(self.cli('token_owner') == m.OWNER, 'SQ1_OWNER')
        for name in ('config_impersonation', 'config_credential', 'config_access_token'):
            need(self.cli(name) in ('', '(unset)'), 'SQ1_CREDENTIAL')
        candidate = self.cli('token')
        acl.validate_token(candidate)
        self.reserve('cache', 'owner-token')
        cached = None
        try:
            with acl.http_deadline(min(8, self.end - self.h.clock())):
                cached = self.h.cache_reader(self.times['purgeEnd'])
            need(type(cached) is str and cached == candidate, 'SQ1_CREDENTIAL')
            self.gate(); self.token = candidate
        finally:
            cached = None; candidate = None

    def http(self, name, policy=None, receive_time=None):
        rows = descriptor_contract(self.scope, self.uid, self.number, policy, receive_time)
        main = {'service_signing', 'service_troubleshooter', 'project_permissions', 'identity_permissions',
                'policy_before', 'enable', 'policy_add', 'policy_after', 'prediction', 'sign'}
        cleanup = {'policy_cleanup_before', 'policy_remove', 'policy_cleanup_after', 'disable'}
        need(name in (main if self.phase == 'main' else cleanup) and name in rows, 'SQ1_DESCRIPTOR')
        need(bool(self.token), 'SQ1_CREDENTIAL')
        self.reserve('https', name)
        action = {'enable': 'enable', 'disable': 'disable', 'policy_add': 'policyAdd',
                  'policy_remove': 'policyRemove', 'sign': 'sign'}.get(name)
        if action:
            self.j.put('intent-' + action + '.json', {**self.j.base, 'action': action})
        # A pending signal stops before dispatch, but its reservation remains spent.
        deadline = self.gate()
        response = bounded_request(rows[name], self.token, deadline, clock=self.h.clock, opener=self.h.opener)
        rows = None; policy = None
        if name == 'sign':
            self.sign_result = classify_sign_response(response['status'], response['body'], expected={
                'permission': 'iam.serviceAccounts.signBlob', 'service': 'iamcredentials.googleapis.com',
                'consumer': 'projects/' + self.number, 'target': m.IDENTITY})
            if response['bodyFailure']:
                self.sign_result.update(outcome='UNKNOWN', failureCategory=response['bodyFailure'])
            if not response['bodyFailure'] and 200 <= (response['status'] or 0) < 300:
                self.j.put('ack-sign.json', {**self.j.base, 'action': 'sign'})
            response = None
            self.gate()
            return self.sign_result
        need(response['bodyFailure'] is None and type(response['status']) is int and
             200 <= response['status'] < 300, 'SQ1_HTTP')
        value = strict_json(response['body']); response = None
        need(type(value) is dict, 'SQ1_OUTPUT')
        if name in ('enable', 'disable'): need(value == {}, 'SQ1_OUTPUT')
        if action:
            self.j.put('ack-' + action + '.json', {**self.j.base, 'action': action})
        self.gate()
        return value

    def reconcile(self, enabled):
        stop = self.h.monotonic() + 45
        adapter = object.__new__(entry.RuntimeAdapter)
        attempt = 0
        def cloud(vector, deadline):
            need([q.GCLOUD, *vector] == commands()['readback'], 'SQ1_DESCRIPTOR')
            return self.cli('readback', 'readback-' + str(attempt))
        adapter.cloud = cloud
        for attempt, delay in enumerate((0, 5, 10)):
            until = self.h.monotonic() + delay
            while self.h.monotonic() < until:
                self.gate(); need(self.h.monotonic() < stop, 'SQ1_DEADLINE')
                self.h.sleep(min(.1, until - self.h.monotonic()))
            self.gate(); need(self.h.monotonic() < stop, 'SQ1_DEADLINE')
            try:
                observed = adapter.readback('identity', m.IDENTITY, enabled, {}, self.end)
                need(observed is True, 'SQ1_IDENTITY')
            except entry.c.Stop as error:
                if (str(error) not in ('RUNTIME_IDENTITY_STATE_MISMATCH', 'RUNTIME_IDENTITY_DISABLED_MISSING')
                        or attempt == 2): raise Stop('SQ1_IDENTITY') from None
            else:
                need(self.h.monotonic() < stop, 'SQ1_DEADLINE')
                return
        raise Stop('SQ1_IDENTITY')

    def require_remaining(self, seconds):
        self.gate()
        need(min(self.end - self.h.clock(), self.hard_end - self.h.monotonic()) >= seconds,
             'SQ1_DEADLINE')

    def settle(self):
        self.require_remaining(SETTLE_SECONDS + POST_SETTLE_SECONDS)
        until = self.h.monotonic() + SETTLE_SECONDS
        while True:
            self.gate()
            before = self.h.monotonic()
            if before >= until:
                break
            self.h.sleep(min(1, until - before))
            # Refuse a broken/non-progressing clock instead of spinning forever.
            # Early wakeups with positive progress must still cover the interval.
            need(self.h.monotonic() > before, 'SQ1_CLOCK')
        self.gate()

    def main(self):
        self.owner_project_uid(initial=True)
        roles = entry.bridge.packet.module('roles')
        expected = next(role for role in roles.ROLES if role['kind'] == 'signing')
        need(roles.definition_shape(self.cli('role'), expected) in
             ('EXACT_ACTIVE_EXPLICIT', 'EXACT_ACTIVE_DEFAULTED'), 'SQ1_ROLE')
        self.credentials()
        for name, service in (('service_signing', 'iamcredentials.googleapis.com'),
                              ('service_troubleshooter', 'policytroubleshooter.googleapis.com')):
            value = self.http(name)
            need(value.get('name') == 'projects/' + self.number + '/services/' + service and value.get('state') == 'ENABLED', 'SQ1_SERVICE')
        for name, permissions in (('project_permissions', PROJECT_PERMISSIONS), ('identity_permissions', IDENTITY_PERMISSIONS)):
            value = self.http(name)
            need(type(value.get('permissions')) is list and sorted(value['permissions']) == sorted(permissions), 'SQ1_PERMISSION')
        policy = self.http('policy_before')
        need(policy_state(policy, self.scope) == 'ABSENT', 'SQ1_POLICY_OWNERSHIP')
        self.j.put('baseline-policy.json', {**self.j.base, 'absent': True, 'uidSha256': self.scope['uidSha256']})
        self.require_remaining(MAIN_ADMISSION_SECONDS)
        self.http('enable'); self.reconcile(True)
        update = modified_policy(policy, self.scope, True); policy = None
        self.http('policy_add', update); update = None
        policy = self.http('policy_after')
        need(policy_state(policy, self.scope) == 'OWNED', 'SQ1_POLICY_OWNERSHIP'); policy = None
        self.settle()
        when = datetime.datetime.fromtimestamp(self.h.clock(), datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')
        need(self.http('prediction', receive_time=when).get('overallAccessState') == 'CAN_ACCESS', 'SQ1_PREDICTION')
        need(self.metadata('pre-sign-uid') is False, 'SQ1_IDENTITY')
        self.http('sign')

    def cleanup(self):
        if not self.j.has('intent-enable.json') and not self.j.has('intent-policyAdd.json'):
            self.policy_absent = True if self.j.has('baseline-policy.json') else None
            self.identity_disabled = True if self.j.has('baseline-identity.json') else None
            return
        self.owner_project_uid()
        self.credentials()
        # Each branch is independent: no policy failure can skip disable.
        try:
            policy = self.http('policy_cleanup_before')
            state = policy_state(policy, self.scope)
            if state == 'OWNED':
                need(self.j.has('intent-policyAdd.json') and self.j.has('baseline-policy.json') and
                     self.j.read('baseline-policy.json').get('absent') is True, 'SQ1_POLICY_OWNERSHIP')
                update = modified_policy(policy, self.scope, False); policy = None
                self.http('policy_remove', update); update = None
        except BaseException as error:
            self.failures['policyMutation'] = safe_code(error)
        finally:
            policy = None; update = None
            try:
                self.policy_absent = policy_state(self.http('policy_cleanup_after'), self.scope) == 'ABSENT'
            except BaseException as error:
                self.policy_absent = False; self.failures['policyReadback'] = safe_code(error)
        try:
            if self.j.has('intent-enable.json'):
                self.http('disable')
                self.reconcile(False)
        except BaseException as error:
            self.failures['identityMutation'] = safe_code(error)
        finally:
            try:
                self.identity_disabled = self.metadata('final-uid') is True
            except BaseException as error:
                self.identity_disabled = False; self.failures['identityReadback'] = safe_code(error)

    def close(self):
        self.token = ''; self.uid = ''; self.number = ''
        self.owned_active = True
        try:
            self.closed = self.io is None or self.io.close(self.times['workEnd' if self.phase == 'main' else 'cleanupEnd']) is True
        except BaseException:
            self.closed = False
        finally:
            self.owned_active = False; self.io = None
        try:
            self.config_closed = self.h.configuration() == self.scope['configSha256']
            with acl.http_deadline(max(.01, min(8, self.times['cleanupEnd'] - self.h.clock()))): self.h.guard(self.scope)
            self.source_closed = True
        except BaseException:
            self.source_closed = False


def run_phase(scope, phase, *, hooks, root=None):
    """Explicitly injected API. A cleanup phase can run in a fresh process."""
    validate_scope(scope, hooks.clock(), phase)
    for name in ('io_factory', 'cache_reader', 'guard', 'configuration', 'clock', 'monotonic', 'sleep'):
        need(callable(getattr(hooks, name, None)), 'SQ1_SCOPE')
    need(hasattr(hooks, 'opener') and callable(getattr(hooks.opener, 'open', None)), 'SQ1_SCOPE')
    hooks.guard(scope); need(hooks.configuration() == scope['configSha256'], 'SQ1_CONFIG')
    root = root_for(scope['operationId']) if root is None else Path(root)
    create = phase == 'main' and not root.exists()
    journal = Journal(root, scope, create=create)
    # Journal has already proved the original attempt/root inode. A worker can
    # die before creating its lock; cleanup may create this exact owned file.
    lock = os.open(root / 'entry.lock', os.O_RDWR | os.O_NOFOLLOW | os.O_CREAT, 0o600)
    driver = None; previous = {}; failure = None
    try:
        journal.inspect()
        try: fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError: raise Stop('SQ1_REPLAY') from None
        if phase == 'main': need(not (root / 'cleanup-phase.json').exists(), 'SQ1_REPLAY')
        journal.put(phase + '-phase.json', journal.base)
        driver = Driver(scope, phase, hooks, journal)
        def interrupted(signum, frame):
            driver.interrupted = True
            if phase == 'main' and not driver.owned_active: raise KeyboardInterrupt()
        previous = {s: signal.signal(s, interrupted) for s in (signal.SIGINT, signal.SIGTERM)}
        driver.gate(); driver.io = hooks.io_factory()
        try:
            getattr(driver, phase)()
        except BaseException as error:
            failure = safe_code(error)
        finally:
            driver.close()
        residuals = []
        if not driver.closed: residuals.append('PROCESS_CLOSEOUT_UNKNOWN')
        if not driver.config_closed: residuals.append('CONFIGURATION_UNCONFIRMED')
        if not driver.source_closed: residuals.append('SOURCE_UNCONFIRMED')
        if driver.interrupted and failure is None: failure = 'SQ1_INTERRUPTED'
        main = None
        if phase == 'cleanup':
            if (root / 'main-result.json').exists():
                try: main = validate_result(journal.read('main-result.json'), journal, 'main')
                except Exception:
                    residuals.append('MAIN_RECEIPT_UNCONFIRMED')
            if main is None or main.get('processClosed') is not True:
                residuals.append('MAIN_PROCESS_CLOSEOUT_UNKNOWN')
            if main is not None:
                for item in main.get('residuals', []):
                    if item not in residuals: residuals.append(item)
            changed = journal.has('intent-enable.json') or journal.has('intent-policyAdd.json')
            if changed and driver.policy_absent is not True: residuals.append('SIGNING_BINDING_UNCONFIRMED')
            if changed and driver.identity_disabled is not True: residuals.append('IDENTITY_DISABLED_UNCONFIRMED')
            for action, label in (('enable', 'ENABLE_OUTCOME_UNKNOWN'), ('policyAdd', 'POLICY_ADD_OUTCOME_UNKNOWN'),
                                  ('disable', 'DISABLE_OUTCOME_UNKNOWN'), ('policyRemove', 'POLICY_REMOVE_OUTCOME_UNKNOWN')):
                if journal.has('intent-' + action + '.json') and not journal.has('ack-' + action + '.json'):
                    residuals.append(label)
        on_time = hooks.clock() < driver.times['cleanupEnd' if phase == 'cleanup' else 'workEnd']
        if not on_time: residuals.append('CLOSEOUT_DEADLINE')
        journal.inspect()
        result = {**journal.base, 'phase': phase, 'status': 'SQ1_MAIN_FINISHED' if phase == 'main' else
                  'SQ1_CONTAINMENT_UNCONFIRMED' if residuals else 'SQ1_DIAGNOSTIC_CLOSED' if changed else 'SQ1_NOT_MUTATED',
                  'failure': failure, 'mainFailure': failure if phase == 'main' else main.get('failure') if main else 'SQ1_PROCESS_UNKNOWN',
                  'signResult': driver.sign_result if phase == 'main' else main.get('signResult') if main else None,
                  'policyAbsent': driver.policy_absent, 'identityDisabled': driver.identity_disabled,
                  'processClosed': driver.closed, 'configurationClosed': driver.config_closed, 'sourceClosed': driver.source_closed,
                  'privateInputsAbsent': True, 'counts': driver.counts, 'mainCounts': main.get('counts') if main else None,
                  'cleanupFailures': driver.failures, 'residuals': sorted(set(residuals)), 'onTime': on_time,
                  'finishedAt': hooks.clock(), 'paymentObserved': False, 'automaticRetryAllowed': False}
        validate_result(result, journal, phase)
        journal.put('main-result.json' if phase == 'main' else 'result.json', result)
        return result
    finally:
        if driver is not None and driver.io is not None: driver.close()
        for signum, handler in previous.items(): signal.signal(signum, handler)
        os.close(lock)


def python_environment():
    # Validate overrides first; do not pass CLOUDSDK_* into a Python worker that
    # will independently validate its incoming environment again.
    q.sdk_environment(os.environ)
    return {key: os.environ[key] for key in ('HOME', 'PATH', 'LANG', 'LC_ALL') if key in os.environ}


def approved_scope(refs, *, read_commit=a.committed):
    need(type(refs) is dict and set(refs) == {'scopeCommit', 'scopePath', 'decisionCommit', 'decisionPath'}, 'SQ1_AUTHORITY')
    for key in ('scopeCommit', 'decisionCommit'):
        need(type(refs[key]) is str and re.fullmatch('[a-f0-9]{40}', refs[key]), 'SQ1_AUTHORITY')
    for key, kind in (('scopePath', 'SCOPE'), ('decisionPath', 'APPROVAL')):
        need(type(refs[key]) is str and re.fullmatch('APP013_P08_SQ1_' + kind + r'_[0-9]{8}_[a-f0-9]{8}\.json', refs[key]), 'SQ1_AUTHORITY')
    raw = read_commit(x.p.G, refs['scopeCommit'], refs['scopePath'])
    scope = strict_json(raw)
    validate_scope(scope, m.timestamp(scope['window']['start']), 'cleanup')
    decision = strict_json(read_commit(x.p.G, refs['decisionCommit'], refs['decisionPath']))
    need(type(decision) is dict and all(type(decision.get(key)) is bool for key in
         ('externalActionAuthorized', 'independentCleanupAuthorized', 'paymentAuthorized')) and
         type(decision.get('allowanceUsd')) is int, 'SQ1_AUTHORITY')
    need(decision == {'decision': DECISION, 'scopeSha256': digest(scope), 'operationId': scope['operationId'],
                     'externalActionAuthorized': True, 'independentCleanupAuthorized': True,
                     'sdkException': SDK_EXCEPTION, 'paymentAuthorized': False, 'allowanceUsd': 0}, 'SQ1_AUTHORITY')
    source_guard(scope)
    need(x.configuration() == scope['configSha256'], 'SQ1_CONFIG')
    return scope


class NativeHooks:
    def __init__(self, refs, scope, phase, *, parent=None):
        need(approved_scope(refs) == scope and phase in ('main', 'cleanup'), 'SQ1_AUTHORITY')
        self.scope, self.phase, self.parent = scope, phase, parent
        self.clock, self.monotonic, self.sleep = time.time, time.monotonic, time.sleep
        self.opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())

    def guard(self, scope):
        need(scope == self.scope, 'SQ1_AUTHORITY')
        if self.phase == 'main':
            need(self.parent is not None and self.parent > 1 and os.getppid() == self.parent, 'SQ1_PARENT_UNKNOWN')
        source_guard(scope)

    def configuration(self):
        return x.configuration()

    def io_factory(self):
        return q.NativeIO(time.time, self.scope['operationId'])

    def cache_reader(self, purge_end):
        need(purge_end == m.timestamp(self.scope['window']['purgeEnd']), 'SQ1_CREDENTIAL')
        return acl.read_cached_token(acl.CONFIG_ROOT, purge_end)


def phase_command(mode, envelope, held_fd=None):
    need(mode in ('--worker', '--cleanup') and (held_fd is None or type(held_fd) is int and held_fd >= 3), 'SQ1_SCOPE')
    script = str(Path(__file__).resolve())
    bootstrap = ('import sys,runpy;sys.path.insert(0,sys.argv.pop(1));'
                 'sys.argv=sys.argv[1:];runpy.run_path(sys.argv[0],run_name="__main__")')
    return [x.p.PYTHON, '-I', '-B', '-c', bootstrap, str(HERE), script, mode, str(envelope),
            *([] if held_fd is None else [str(held_fd)])]


def validate_lease_fd(fd):
    """Use only the actually inherited descriptor, never a PID/fd from a receipt."""
    need(type(fd) is int and fd >= 3, 'SQ1_CUSTODY')
    actual, path = os.fstat(fd), os.lstat(LEASE)
    need(stat.S_ISREG(actual.st_mode) and actual.st_uid == os.getuid() and actual.st_nlink == 1 and
         stat.S_IMODE(actual.st_mode) == 0o600 and (actual.st_dev, actual.st_ino) == (path.st_dev, path.st_ino), 'SQ1_CUSTODY')
    try: fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError: raise Stop('SQ1_REPLAY') from None
    return fd


@contextmanager
def identity_lease(inherited=None):
    if inherited is None:
        fd = os.open(LEASE, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    else:
        fd = inherited
    try:
        validate_lease_fd(fd)
        yield fd
    finally:
        os.close(fd)


def supervise(scope, envelope, *, command_builder, io_factory, clock, guard, configuration):
    """Supervisor owns the detached worker; worker independently execs cleanup.

    All injected callables are mandatory. This API cannot construct native IO.
    A killed worker leaves the supervisor's fresh cleanup route; a killed
    supervisor leaves the worker's finally/exec route.
    """
    journal = Journal(root_for(scope['operationId']), scope)
    need(Path(envelope) == journal.root / 'envelope.json', 'SQ1_CUSTODY')
    times = validate_scope(scope, clock(), 'main')
    guard(scope); need(configuration() == scope['configSha256'], 'SQ1_CONFIG')
    journal.put('supervisor-phase.json', journal.base)
    io = io_factory(); failure = None; closed = False; pending = False; main_active = True
    delivered = set()
    def deliver():
        for child in list(io.children):
            if child in delivered: continue
            try: os.killpg(child.pid, signal.SIGTERM)
            except ProcessLookupError: pass
            delivered.add(child)
    def registered_clock():
        # q._owned_run calls its clock immediately after children.add. A signal
        # in Popen's registration gap is delivered here before its read loop.
        if pending and main_active: deliver()
        return clock()
    io.clock = registered_clock
    def interrupted(signum, frame):
        nonlocal pending
        pending = True
        # Only directly registered owned groups are signalled.
        if main_active: deliver()
    previous = {s: signal.signal(s, interrupted) for s in (signal.SIGINT, signal.SIGTERM)}
    try:
        try:
            io._owned_run(command_builder('--worker', envelope), python_environment(), times['cleanupEnd'])
        except BaseException as error:
            failure = safe_code(error)
        finally:
            main_active = False
        # Never replay an entered cleanup. It may have died after dispatch.
        if not (journal.root / 'cleanup-phase.json').exists() and clock() + 20 < times['cleanupEnd']:
            try:
                guard(scope); need(configuration() == scope['configSha256'], 'SQ1_CONFIG')
                io._owned_run(command_builder('--cleanup', envelope), python_environment(), times['cleanupEnd'])
            except BaseException as error:
                failure = safe_code(error)
    finally:
        try: closed = io.close(times['cleanupEnd']) is True
        except BaseException: closed = False
        for signum, handler in previous.items(): signal.signal(signum, handler)
    summary = {**journal.base, 'supervisorOwnedProcessesClosed': closed, 'failure': failure,
               'interrupted': pending, 'finishedAt': clock(), 'onTime': clock() < times['cleanupEnd']}
    if not (journal.root / 'result.json').exists(): summary['cleanupResult'] = 'UNKNOWN'
    else:
        try: summary['cleanupResult'] = validate_result(journal.read('result.json'), journal, 'cleanup')['status']
        except Exception: summary['cleanupResult'] = 'UNKNOWN'
    journal.put('supervision.json', summary)
    return summary


def _internal_envelope(path):
    path = Path(path)
    need(re.fullmatch(r'/private/tmp/p08-sq1-[a-f0-9-]{36}/envelope\.json', str(path)), 'SQ1_CUSTODY')
    refs = inv.read(path)
    scope = approved_scope(refs)
    need(path == root_for(scope['operationId']) / 'envelope.json', 'SQ1_CUSTODY')
    journal = Journal(path.parent, scope)
    need(journal.read('envelope.json') == refs and journal.has('launch.json'), 'SQ1_CUSTODY')
    return refs, scope, journal


def native_main(argv):
    need(bool(argv), 'SQ1_SCOPE')
    if argv[0] == '--run':
        need(len(argv) == 5, 'SQ1_AUTHORITY')
        refs = dict(zip(('scopeCommit', 'scopePath', 'decisionCommit', 'decisionPath'), argv[1:]))
        scope = approved_scope(refs)
        validate_scope(scope, time.time(), 'main')
        journal = Journal(root_for(scope['operationId']), scope, create=True)
        journal.put('envelope.json', refs); journal.put('launch.json', journal.base)
        return supervise(scope, journal.root / 'envelope.json', command_builder=phase_command,
                         io_factory=lambda: q.NativeIO(time.time, scope['operationId']), clock=time.time,
                         guard=source_guard, configuration=x.configuration)
    need(argv[0] in ('--worker', '--cleanup') and len(argv) in (2, 3), 'SQ1_AUTHORITY')
    need(argv[0] != '--worker' or len(argv) == 2, 'SQ1_AUTHORITY')
    refs, scope, journal = _internal_envelope(argv[1])
    if argv[0] == '--cleanup':
        inherited = None
        if len(argv) == 3:
            need(re.fullmatch('[0-9]{1,8}', argv[2]), 'SQ1_CUSTODY'); inherited = int(argv[2])
        with identity_lease(inherited):
            return run_phase(scope, 'cleanup', hooks=NativeHooks(refs, scope, 'cleanup'), root=journal.root)
    # The worker acquires the identity lease itself. Its only inherited native
    # authority is the exact, separately committed public decision above.
    with identity_lease() as held:
        try:
            run_phase(scope, 'main', hooks=NativeHooks(refs, scope, 'main', parent=os.getppid()), root=journal.root)
        finally:
            # exec drops raw main memory and preserves the same exact lease;
            # no credentials, policy or PID is passed through argv/environment.
            need(time.time() + 20 < m.timestamp(scope['window']['cleanupEnd']), 'SQ1_DEADLINE')
            validate_lease_fd(held); os.set_inheritable(held, True)
            vector = phase_command('--cleanup', journal.root / 'envelope.json', held)
            os.execve(vector[0], vector, python_environment())


if __name__ == '__main__':
    try:
        output = native_main(sys.argv[1:])
        try: print(json.dumps(output, sort_keys=True))
        except BrokenPipeError: pass  # Closure receipt already durable; parent may have exited.
    except BaseException as error:
        try: print(json.dumps({'status': 'SQ1_STOP', 'failure': safe_code(error), 'paymentObserved': False}))
        except BrokenPipeError: pass
        raise SystemExit(1)
