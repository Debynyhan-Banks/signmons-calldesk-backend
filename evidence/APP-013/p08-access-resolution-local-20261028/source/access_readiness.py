"""P08 local access lifecycle model. Native execution is deliberately unbound.

No HTTP client, credential resolver, gcloud launcher, signing or exchange is
implemented here. Request descriptors are exercised through injected transports.
"""
from __future__ import annotations
import copy, datetime as dt, importlib.util, json, os, re, signal, stat, time, uuid
from pathlib import Path
ROOT = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('p08_restore_reuse', ROOT / 'reuse/restore.py')
reuse = importlib.util.module_from_spec(spec)
spec.loader.exec_module(reuse)
Stop, need, digest, timestamp, reserve = reuse.Stop, reuse.need, reuse.digest, reuse.timestamp, reuse.reserve
SERVICE = 'policytroubleshooter.googleapis.com'
RESTRICTIONS = {'apiTargets': [{'service': 'identitytoolkit.googleapis.com'}]}
STATES = {'CAN_ACCESS', 'CANNOT_ACCESS', 'UNKNOWN_INFO', 'UNKNOWN_CONDITIONAL', 'OVERALL_ACCESS_STATE_UNSPECIFIED'}
KEY_PREFIX = 'projects/signmons/locations/global/keys/'

def check_sources(root=ROOT):
    manifest = json.loads((root / 'source-manifest.json').read_text())
    need(manifest.get('status') == 'DISABLED_LOCAL_PREPARATION_ONLY', 'SOURCE_STATUS')
    for name, expected in manifest['files'].items():
        path = root / name
        need(not Path(name).is_absolute() and '..' not in Path(name).parts and not path.is_symlink() and path.is_file(), 'SOURCE_PATH')
        need(digest(path.read_bytes()) == expected, 'SOURCE_DRIFT')
    need(digest((root / 'reuse/source-manifest.json').read_bytes()) == '1bb87c987d6450f4727c9813c8636e33a5fe3029433696b1d288c47e77e7f41d', 'REUSE_MANIFEST')
    reuse.check_sources(root / 'reuse')
    return manifest

def expected_environment_names():
    # Reuse both the static values and the separately required dynamic setting.
    path = ROOT / 'reuse/legacy/controller.py'
    s = importlib.util.spec_from_file_location('p08_legacy_names', path)
    legacy = importlib.util.module_from_spec(s); s.loader.exec_module(legacy)
    return sorted(set(legacy.PLAIN_ENV) | {'CUSTOMER_PAYMENT_RETURN_URL', 'DATABASE_URL', 'STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET', 'OPENAI_API_KEY', 'ADMIN_API_TOKEN', 'CONVERSATION_DATA_ENCRYPTION_KEY', 'TECHNICIAN_LINK_SECRET'})

def approve_local_model(p, now, mode='run'):
    need(p.get('mode') == 'LOCAL_ACCESS_MODEL_ONLY' and p.get('externalActionAuthorized') is False, 'LOCAL_MODEL_ONLY')
    need(str(uuid.UUID(p['operationId'])) == p['operationId'], 'OPERATION_ID')
    need(re.fullmatch(r'[0-9]{6,20}', p['projectNumber']) is not None, 'PROJECT_NUMBER')
    need(p['keyId'] == 'signmons-p08-' + p['operationId'].replace('-', ''), 'KEY_ID')
    need(p['serviceRetention'] == 'RETAIN_IF_ENABLED' and p.get('apiOnlyKeyApproved') is True, 'MODEL_DECISIONS')
    need(p.get('restrictions') == RESTRICTIONS and p.get('automaticRetryAllowed') is False, 'RESTRICTIONS_OR_RETRY')
    t = {k: timestamp(p['window'][k]) for k in ['start', 'cutoff', 'workEnd', 'cleanupEnd', 'purgeEnd']}
    need(t['start'] < t['cutoff'] < t['workEnd'] < t['cleanupEnd'] < t['purgeEnd'] and t['cleanupEnd'] - t['workEnd'] >= 30 and t['purgeEnd'] - t['start'] <= 3600, 'WINDOW')
    need(mode in ['run', 'closeout'], 'MODEL_MODE')
    need(t['start'] <= now < t['cutoff' if mode == 'run' else 'cleanupEnd'], 'START_CUTOFF')
    return t

class RequestAdapter:
    """Strict serialised request shapes. Transport is explicit; none is native."""
    def __init__(self, p, transport=None):
        self.p, self.transport = p, transport
        self.key = f"projects/{p['projectNumber']}/locations/global/keys/{p['keyId']}"
        self.service = f"projects/{p['projectNumber']}/services/{SERVICE}"
        self.calls = 0
    def call(self, method, url, body=None):
        need(self.transport is not None, 'NATIVE_TRANSPORT_UNBOUND')
        need(self.calls < 50, 'REQUEST_LIMIT'); self.calls += 1
        descriptor = {'method': method, 'url': url, 'body': None if body is None else json.dumps(body, sort_keys=True, separators=(',', ':')), 'timeoutSeconds': 8, 'redirect': 'error'}
        response = self.transport(descriptor)
        need(isinstance(response, dict) and type(response.get('httpStatus')) is int and isinstance(response.get('body'), str) and len(response['body'].encode()) <= 65536, 'HTTP_SHAPE')
        value = json.loads(response['body']); need(isinstance(value, dict), 'OUTPUT_OBJECT')
        if response['httpStatus'] == 404 and method == 'GET' and url == 'https://apikeys.googleapis.com/v2/' + self.key:
            need(value.get('error', {}).get('status') == 'NOT_FOUND' and value['error'].get('code') == 404, 'ABSENCE_UNQUALIFIED')
            return {'status': 'NOT_FOUND'}
        need(200 <= response['httpStatus'] < 300 and ('error' not in value or isinstance(value.get('name'), str) and value['name'].startswith('operations/')), 'PROVIDER_REFUSED')
        return value
    def service_get(self):
        return self.call('GET', 'https://serviceusage.googleapis.com/v1/' + self.service)
    def service_enable(self):
        return self.call('POST', 'https://serviceusage.googleapis.com/v1/' + self.service + ':enable', {})
    def operation(self, name, kind):
        if kind == 'service':
            need(re.fullmatch(r'operations/[A-Za-z0-9_.-]{1,200}', name) is not None, 'SERVICE_OPERATION_SCOPE')
            host = 'https://serviceusage.googleapis.com/v1/'
        else:
            need(re.fullmatch(r'operations/[A-Za-z0-9_.-]{1,200}', name) is not None, 'KEY_OPERATION_SCOPE')
            host = 'https://apikeys.googleapis.com/v2/'
        return self.call('GET', host + name)
    def key_get(self):
        return self.call('GET', 'https://apikeys.googleapis.com/v2/' + self.key)
    def key_create(self):
        return self.call('POST', 'https://apikeys.googleapis.com/v2/projects/' + self.p['projectNumber'] + '/locations/global/keys?keyId=' + self.p['keyId'], {'displayName': 'Signmons P08 ' + self.p['operationId'], 'restrictions': RESTRICTIONS})
    def key_delete(self, etag):
        from urllib.parse import quote
        return self.call('DELETE', 'https://apikeys.googleapis.com/v2/' + self.key + '?etag=' + quote(etag, safe=''))
    def diagnostic(self, principal, resource, permission, when):
        return self.call('POST', 'https://policytroubleshooter.googleapis.com/v3/iam:troubleshoot', {'accessTuple': {'principal': principal, 'fullResourceName': resource, 'permission': permission, 'conditionContext': {'request': {'receiveTime': when}}}})

class Controller:
    def __init__(self, p, adapter, directory, clock=time.time, mode='run', pause=time.sleep):
        self.p, self.a, self.dir, self.clock = copy.deepcopy(p), adapter, Path(directory), clock
        self.pause = pause
        self.mode = mode
        self.t = approve_local_model(p, clock(), mode); self.last = clock(); self.abort = False; self.cleaning = False
        self.dir.mkdir(mode=0o700, parents=True, exist_ok=True)
        need(not self.dir.is_symlink() and stat.S_IMODE(self.dir.stat().st_mode) == 0o700, 'PRIVATE_DIRECTORY')
        self.j = {'operationId': p['operationId'], 'planSha256': digest(p), 'service': 'UNOBSERVED', 'createAttempted': False, 'deleteAttempted': False, 'owned': None, 'createOperation': None, 'deleteOperation': None, 'key': 'UNOBSERVED'}
    def gate(self, cleanup=False):
        now = self.clock(); need(now >= self.last, 'CLOCK_ROLLBACK'); self.last = now
        need(now < self.t['cleanupEnd' if cleanup else 'workEnd'], 'DEADLINE')
        need(cleanup or not self.abort, 'INTERRUPTED')
    def save(self):
        tmp = self.dir / 'journal-next.json'
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        try: os.write(fd, json.dumps(self.j, sort_keys=True).encode())
        finally: os.close(fd)
        os.replace(tmp, self.dir / 'journal.json')
    def invoke(self, fn, *args, cleanup=False):
        self.gate(cleanup); before = time.monotonic()
        def timeout(s, f): raise Stop('REQUEST_TIMEOUT')
        old = signal.signal(signal.SIGALRM, timeout)
        signal.setitimer(signal.ITIMER_REAL, min(8, self.t['cleanupEnd' if cleanup else 'workEnd'] - self.clock()))
        try:
            value = fn(*args)
            need(time.monotonic() - before < 8, 'REQUEST_TIMEOUT')
            self.gate(cleanup)
            return value
        finally:
            signal.setitimer(signal.ITIMER_REAL, 0); signal.signal(signal.SIGALRM, old)
    def wait(self, initial, kind, cleanup=False):
        need(isinstance(initial, dict) and isinstance(initial.get('name'), str), 'OPERATION_SHAPE')
        name = initial['name']
        if kind == 'service': need(re.fullmatch(r'operations/[A-Za-z0-9_.-]{1,200}', name) is not None, 'SERVICE_OPERATION_SCOPE')
        else: need(re.fullmatch(r'operations/[A-Za-z0-9_.-]{1,200}', name) is not None, 'KEY_OPERATION_SCOPE')
        self.j['createOperation' if kind == 'create' else 'deleteOperation' if kind == 'delete' else 'serviceOperation'] = name; self.save()
        value = initial
        for index in range(6):
            need(isinstance(value, dict) and value.get('name') == name and isinstance(value.get('done', False), bool), 'OPERATION_SHAPE')
            need('error' not in value, 'OPERATION_FAILED')
            if value.get('done'):
                need(isinstance(value.get('response'), dict), 'OPERATION_RESPONSE')
                return value['response']
            need(index < 5, 'POLL_LIMIT')
            self.gate(cleanup)
            need(self.t['cleanupEnd' if cleanup else 'workEnd'] - self.clock() > 10, 'POLL_DEADLINE')
            self.pause(10)
            value = self.invoke(self.a.operation, name, 'service' if kind == 'service' else 'key', cleanup=cleanup)
        raise Stop('POLL_LIMIT')
    def key_metadata(self, value, deleted=False):
        need(isinstance(value, dict) and value.get('name') == self.a.key and isinstance(value.get('uid'), str) and str(uuid.UUID(value['uid'])) == value['uid'], 'KEY_IDENTITY')
        need(isinstance(value.get('etag'), str) and 0 < len(value['etag']) <= 256, 'KEY_ETAG')
        need(value.get('restrictions') == RESTRICTIONS, 'KEY_RESTRICTIONS')
        need(value.get('displayName') == 'Signmons P08 ' + self.p['operationId'], 'KEY_OWNER_MARKER')
        if deleted:
            need(isinstance(value.get('deleteTime'), str), 'DELETION_UNCONFIRMED')
            need(re.fullmatch(r'\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.[0-9]{1,9})?Z', value['deleteTime']) is not None, 'DELETE_TIME_FORMAT')
            dt.datetime.fromisoformat(value['deleteTime'].replace('Z', '+00:00'))
        else: need(not value.get('deleteTime'), 'KEY_DELETED')
        return {k: value[k] for k in ['name', 'uid', 'etag']}
    def cleanup(self):
        self.cleaning = True
        try:
            if self.j['owned']:
                value = self.invoke(self.a.key_get, cleanup=True)
                own = self.key_metadata(value, bool(value.get('deleteTime')))
                need(own['uid'] == self.j['owned']['uid'], 'OWNERSHIP_DRIFT')
                if value.get('deleteTime'):
                    self.j['key'] = 'CONTROL_PLANE_DELETED'; self.save()
                elif self.j['deleteAttempted']:
                    self.j['key'] = 'DELETE_OUTCOME_UNKNOWN'; self.save()
                else:
                    need(own['etag'] == self.j['owned']['etag'], 'ETAG_DRIFT')
                    self.j['deleteAttempted'] = True; self.j['key'] = 'DELETE_OUTCOME_UNKNOWN'; self.save()
                    initial = self.invoke(self.a.key_delete, own['etag'], cleanup=True)
                    self.wait(initial, 'delete', cleanup=True)
                    after = self.invoke(self.a.key_get, cleanup=True)
                    final = self.key_metadata(after, True); need(final['uid'] == own['uid'], 'OWNERSHIP_DRIFT')
                    self.j['key'] = 'CONTROL_PLANE_DELETED'; self.save()
            elif self.j['createAttempted']: self.j['key'] = 'CREATE_OUTCOME_UNKNOWN'; self.save()
        except BaseException:
            self.j['cleanupFailure'] = True; self.save()
        finally: self.cleaning = False
        residuals = []
        if self.j['key'] not in ['CONTROL_PLANE_DELETED', 'UNOBSERVED', 'ABSENT']: residuals.append('KEY_' + self.j['key'])
        if self.j['service'] == 'ENABLE_OUTCOME_UNKNOWN': residuals.append('SERVICE_ENABLE_OUTCOME_UNKNOWN')
        return residuals
    def run(self):
        need(self.mode == 'run', 'CLOSEOUT_ONLY')
        reserve(self.dir / 'attempt.json', {'operationId': self.p['operationId'], 'planSha256': digest(self.p)})
        self.save(); old = {}
        def stop(s, f):
            if not self.cleaning: self.abort = True; raise Stop('INTERRUPTED')
        for sig in [signal.SIGINT, signal.SIGTERM]: old[sig] = signal.signal(sig, stop)
        diagnostics = []; handoff = None; failure = None
        try:
            state = self.invoke(self.a.service_get)
            need(state.get('name') == self.a.service and state.get('state') in ['ENABLED', 'DISABLED'], 'SERVICE_SHAPE')
            if state['state'] == 'DISABLED':
                self.j['service'] = 'ENABLE_OUTCOME_UNKNOWN'; self.save()
                initial = self.invoke(self.a.service_enable)
                response = self.wait(initial, 'service')
                need(set(response) <= {'@type', 'service'} and isinstance(response.get('service'), dict) and response['service'].get('name') == self.a.service and response['service'].get('state') == 'ENABLED', 'UNEXPECTED_ENABLE_RESPONSE')
                state = self.invoke(self.a.service_get)
                need(state.get('name') == self.a.service and state.get('state') == 'ENABLED', 'ENABLE_READBACK')
                self.j['service'] = 'SERVICE_ENABLED_RETAINED'
            else: self.j['service'] = 'PREEXISTING_ENABLED'
            self.save()
            # Exact resource absence must be an explicit typed NOT_FOUND, never an arbitrary denial.
            absent = self.invoke(self.a.key_get)
            need(absent == {'status': 'NOT_FOUND'}, 'KEY_COLLISION_OR_UNQUALIFIED_ABSENCE')
            self.j['key'] = 'ABSENT'; self.save()
            self.j['createAttempted'] = True; self.j['key'] = 'CREATE_OUTCOME_UNKNOWN'; self.save()
            initial = self.invoke(self.a.key_create)
            value = self.wait(initial, 'create')
            owned = self.key_metadata(value)
            self.j['owned'] = owned; self.j['key'] = 'OWNED'; self.save()
            fresh = self.key_metadata(self.invoke(self.a.key_get))
            need(fresh == owned, 'KEY_READBACK_DRIFT')
            tuples = [(reuse.IDENTITY, '//cloudresourcemanager.googleapis.com/projects/signmons', 'firebaseauth.users.get'), (reuse.OWNER, '//cloudresourcemanager.googleapis.com/projects/signmons', 'firebaseauth.users.get'), (reuse.OWNER, '//cloudresourcemanager.googleapis.com/projects/signmons', 'firebaseauth.users.update'), (reuse.OWNER, '//iam.googleapis.com/projects/signmons/serviceAccounts/' + reuse.IDENTITY, 'iam.serviceAccounts.signBlob'), (reuse.OWNER, '//apikeys.googleapis.com/' + self.a.key, 'apikeys.keys.getKeyString')]
            for principal, resource, permission in tuples:
                when = dt.datetime.fromtimestamp(self.clock(), dt.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')
                v = self.invoke(self.a.diagnostic, principal, resource, permission, when)
                state = v.get('overallAccessState'); need(state in STATES, 'DIAGNOSTIC_SHAPE')
                diagnostics.append({'permission': permission, 'overallAccessState': state})
            # No key-string retrieval, authentication or claim of effective lifecycle access.
            handoff = {'keyResource': KEY_PREFIX + self.p['keyId'], 'metadataSha256': digest(owned), 'keySha256': None, 'authenticationAuthorized': False}
        except BaseException as ex:
            failure = str(ex) if isinstance(ex, Stop) and re.fullmatch('[A-Z_]+', str(ex)) else 'REFUSED_OR_UNKNOWN'
        finally:
            residuals = self.cleanup()
            for sig, handler in old.items(): signal.signal(sig, handler)
        ready = len(diagnostics) == 5 and all(x['overallAccessState'] == 'CAN_ACCESS' for x in diagnostics)
        result = {'status': 'LOCAL_ACCESS_MODEL_COMPLETE' if not failure and not residuals else 'LOCAL_ACCESS_MODEL_STOPPED', 'failure': failure, 'diagnostics': diagnostics, 'fivePolicyDiagnosticsGranted': ready, 'lifecycleAccessQualified': False, 'restorationQualified': False, 'handoff': handoff, 'keyState': self.j['key'], 'serviceState': self.j['service'], 'residuals': residuals, 'realExternalActions': 0, 'processCloseout': 'NO_NATIVE_CLIENTS_OR_CHILDREN', 'immediateGlobalKeyInvalidationProven': False, 'providerEnableSideEffects': 'UNKNOWN', 'liveTransportAvailable': False}
        reserve(self.dir / 'result.json', result)
        return result
    def closeout_only(self):
        need(self.mode == 'closeout', 'CLOSEOUT_MODE')
        reserve(self.dir / 'closeout-attempt.json', {'operationId': self.p['operationId']})
        path = self.dir / 'journal.json'
        need(not path.is_symlink() and stat.S_IMODE(path.stat().st_mode) == 0o600, 'JOURNAL_PRIVATE')
        j = json.loads(path.read_text()); need(j.get('planSha256') == digest(self.p) and j.get('operationId') == self.p['operationId'], 'JOURNAL_SCOPE')
        self.j = j
        return self.cleanup()

def native():
    # A source-locked preparatory model is not an approved live launcher.
    check_sources()
    print('P08_ACCESS_REFUSED_UNBOUND')
    return 2
if __name__ == '__main__': raise SystemExit(native())
