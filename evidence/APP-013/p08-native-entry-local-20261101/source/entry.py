"""Single-owner assembled entry. No operation is authorized by installing this code."""
import datetime
import fcntl
import hashlib
import json
import math
import os
import re
import stat
import uuid
from types import SimpleNamespace
import sys
import time
from pathlib import Path
from authority import Capability, committed, digest, load
from private_inventory import Stop, need, inspect, read, reserve, purge
from native_io import NativeIO, PreflightIO, load_acl
from handoff import Handoff

readbacks = load('p08-native-closeout-local-20261031/source/adapter.py', 'entry_readback_contract')
c, bridge, restore = readbacks.load_sources()
load("p08-key-correction-20261110/binding.py", "runtime_candidate_binding").apply_restore(restore)


# Only fixed, reviewed preflight codes may cross the historical coordinator boundary.
# Never classify by a message pattern or persist arbitrary exception text.
PREFLIGHT_CODES = frozenset({
    'ROLE_OUTPUT_UNKNOWN', 'ROLE_IDENTITY_UNKNOWN', 'ROLE_DEADLINE',
    'ROLE_NOT_READY', 'ROLE_READ_UNCONFIRMED', 'ROLE_EXPECTATION_DRIFT',
    'ROLE_ACL_UNKNOWN', 'ROLE_ACL_DRIFT', 'ACL_SOURCE_DRIFT', 'OWNER_MISMATCH',
    'CANDIDATE_SOURCE', 'ENVIRONMENT_DRIFT', 'CUSTOM_ROLE_DRIFT',
    'POLICY_SHAPE', 'POLICY_DRIFT', 'TRAFFIC_SHAPE', 'NORMAL_TRAFFIC',
    'PROJECT_DRIFT', 'BINDING_PRESENT', 'SERVICE_SHAPE',
    'POLICY_OWNERSHIP', 'POLICY_CONDITION', 'CLI_OUTPUT_SHAPE',
    'NATIVE_COMMAND_UNCONFIRMED', 'NATIVE_COMMAND_REFUSED',
    'NATIVE_OUTPUT_SHAPE', 'NATIVE_OUTPUT_ENCODING', 'OWNER_DRIFT',
    'OWNER_OVERRIDE', 'TOKEN_SHAPE', 'CLI_VECTOR', 'SQL_ALLOWLIST',
    'DATABASE_PROCESS_TIMEOUT', 'DATABASE_PROCESS_UNAVAILABLE',
    'DATABASE_TLS_CONFIGURATION', 'DATABASE_AUTHENTICATION',
    'DATABASE_CONNECTION', 'DATABASE_SCHEMA_OR_QUERY',
    'DATABASE_ERROR_OUTPUT_LIMIT', 'DATABASE_STATEMENT_TIMEOUT',
    'DATABASE_COMMAND_FAILED', 'DATABASE_OUTPUT_LIMIT', 'DATABASE_OUTPUT_ENCODING',
    'CLOCK_ROLLBACK', 'DEADLINE', 'INTERRUPTED', 'PAYMENT_PREFLIGHT_STOP',
    'PREFLIGHT_CLI_DENIED', 'PREFLIGHT_SQL_DENIED', 'PREFLIGHT_SQL_ENV',
    'PREFLIGHT_HTTPS_DENIED', 'PREFLIGHT_CHILD_DENIED', 'PREFLIGHT_PROCESS_UNCONFIRMED',
    'RUNTIME_IDENTITY_OUTPUT_SHAPE', 'RUNTIME_IDENTITY_EMAIL_MISSING',
    'RUNTIME_IDENTITY_EMAIL_MISMATCH', 'RUNTIME_IDENTITY_DISABLED_MISSING',
    'RUNTIME_IDENTITY_DISABLED_INVALID', 'RUNTIME_IDENTITY_STATE_MISMATCH',
})


class RuntimeAdapter(restore.NativeAdapter):
    """Full ACL validation at each inherited phase readback, including independent closure."""
    def __init__(self, cap, io, clock=time.time):
        super().__init__(None, '', runner=io.cloud, sql=io.sql, clock=clock)
        self.cap = cap
        self.acl = load_acl()

    def preflight(self, p, q, deadline):
        if self.cap.e['version'] == 2 and 'signmons-staging-stripe-secret-key' not in self.cap.e['resources']['secretVersions']:
            try:self.payment_preflight()
            except Exception:raise c.Stop('PAYMENT_PREFLIGHT_STOP') from None
        return super().preflight(p, q, deadline)

    def role(self, deadline):
        def unique(pairs):
            result = {}
            for key, value in pairs:
                need(key not in result, 'ROLE_OUTPUT_UNKNOWN')
                result[key] = value
            return result
        try:
            need(self.clock() < deadline, 'ROLE_DEADLINE')
            raw = self.sql(self.acl.lifecycle_role_query(), deadline)
            need(isinstance(raw, str) and len(raw.encode('utf-8')) <= 65536, 'ROLE_OUTPUT_UNKNOWN')
            v = json.loads(raw, object_pairs_hook=unique)
            fields = {'role','database','user','count','login','limit','expires','expiryFinite','expired',
                      'unsafe','memberships','membershipEdges','serverVersion','owned','sessions','schemaCreate','databaseTemp','acl'}
            need(isinstance(v, dict) and set(v) == fields, 'ROLE_OUTPUT_UNKNOWN')
            need(v['role'] == self.acl.RETIRED_ROLE and
                 v['database'] == self.cap.e['database']['database'] and
                 v['user'] == self.cap.e['database']['user'], 'ROLE_IDENTITY_UNKNOWN')
            need(all(type(v[k]) is int and v[k] >= 0 for k in ('count','limit','memberships','owned','sessions')) and
                 all(type(v[k]) is bool for k in ('login','expiryFinite','expired','unsafe','schemaCreate','databaseTemp')),
                 'ROLE_OUTPUT_UNKNOWN')
            self.acl.classify_memberships(v)
            need(v['count'] == 1 and v['expiryFinite'] and not v['unsafe'] and
                 v['owned'] == 0 and not v['schemaCreate'] and not v['databaseTemp'],
                 'ROLE_NOT_READY')
            need(isinstance(v['expires'], str) and 0 < len(v['expires']) <= 64, 'ROLE_OUTPUT_UNKNOWN')
            expiry = datetime.datetime.fromisoformat(v['expires'])
            need(expiry.tzinfo is not None, 'ROLE_OUTPUT_UNKNOWN')
            _, legacy = self.acl.classify_role_acl(v['acl'], v['database'], self.acl.expected_retired_acl())
            need(self.clock() < deadline, 'ROLE_DEADLINE')
            return {**{k:v[k] for k in ('count','login','limit','expires','expired','unsafe','memberships','membershipEdges','serverVersion','owned','sessions')},
                    'acl':legacy}
        except BaseException as error:
            if isinstance(error, Stop): raise
            if isinstance(error, self.acl.Stop): raise Stop(str(error)) from None
            raise Stop('ROLE_READ_UNCONFIRMED') from None


    def readback(self, kind, name, enabled, p, deadline):
        if kind == 'identity':
            try:
                value = self.cloud(['iam', 'service-accounts', 'describe', restore.IDENTITY,
                                    '--project=signmons', '--format=json(email,disabled)'], deadline)
            except BaseException as error:
                if (type(error) is Stop and len(error.args) == 1 and
                        type(error.args[0]) is str and error.args[0] == 'NATIVE_OUTPUT_SHAPE'):
                    raise c.Stop('RUNTIME_IDENTITY_OUTPUT_SHAPE') from None
                raise
            if not isinstance(value, dict):
                raise c.Stop('RUNTIME_IDENTITY_OUTPUT_SHAPE') from None
            # Preserve the inherited predicate, including omitted-field and numeric
            # equality behavior. Classification changes only rejected observations.
            if value.get('email') == restore.IDENTITY and value.get('disabled', False) == (not enabled):
                return True
            if 'email' not in value:
                code = 'RUNTIME_IDENTITY_EMAIL_MISSING'
            elif value.get('email') != restore.IDENTITY:
                code = 'RUNTIME_IDENTITY_EMAIL_MISMATCH'
            elif 'disabled' not in value:
                code = 'RUNTIME_IDENTITY_DISABLED_MISSING'
            elif type(value['disabled']) not in (bool, int, float) or value['disabled'] not in (False, True):
                code = 'RUNTIME_IDENTITY_DISABLED_INVALID'
            else:
                code = 'RUNTIME_IDENTITY_STATE_MISMATCH'
            raise c.Stop(code) from None
        if kind != 'role':
            observed = super().readback(kind, name, enabled, p, deadline)
            if (observed and enabled and kind == 'version' and name == 'signmons-staging-stripe-secret-key'
                    and self.cap.e['version'] == 2):
                # Corrected versions retire disabled. The source-bound lifecycle puts
                # this journaled enable/readback first, before all runtime activation.
                try:self.payment_preflight()
                except Exception:raise c.Stop('PAYMENT_PREFLIGHT_STOP') from None
            return observed
        # The original role branch requires a blanket zero count. Preserve the
        # real count and use the shared, strictly validated administrative policy.
        v = self.role(deadline)
        safe = (v['count'] == 1 and v['unsafe'] is False and v['owned'] == 0 and
                digest(v['acl']) == self.q['roleAclSha256'])
        if not safe:
            return False
        if enabled:
            return (v['login'] is True and v['limit'] == 6 and
                    datetime.datetime.fromisoformat(v['expires']).timestamp() == restore.timestamp(p['window']['workEnd']))
        return v['login'] is False and v['limit'] == 0 and v['expired'] is True and v['sessions'] == 0


class Ports(bridge.Ports):
    def __init__(self, cap, io, handoff, runtime):
        self.cap, self.io, self.handoff, self.runtime = cap, io, handoff, runtime
        self.absence_observed_at = None
        self.pause = time.sleep
        super().__init__(cap.plan, io.cli, io.https, self.authenticate_receipt,
                         self.account_readback, lambda: None, cap.clock)

    def cloud(self, vector):
        # Access checks consume the same projected policy contract as qualification.
        policy_reads = (
            ['projects', 'get-iam-policy', self.plan['project'], '--format=json'],
            ['iam', 'service-accounts', 'get-iam-policy', self.cap.e['resources']['identity'],
             '--project=' + self.plan['project'], '--format=json'],
        )
        iam_mutations = [self.restore.command(self.restore_plan, 'iam', role['kind'], enabled)
                         for role in self.iam for enabled in (True, False)]
        if vector in iam_mutations:
            vector = [*vector, '--format=json']
        if vector in policy_reads:
            vector = [*vector[:-1], '--format=json(bindings,etag,version)']
        return super().cloud(vector)

    def _lifecycle_pins(self):
        root = inspect(self.cap.root, self.plan['operationId'])
        st = root.lstat()
        need(st.st_uid == os.getuid(), 'KEY_PRIVATE_OWNER')
        return {'version': 1, 'operationId': self.plan['operationId'],
                'planSha256': digest(self.plan), 'sourceCommit': self.cap.e['sourceCommit'],
                'envelopeSha256': self.cap.envelope_hash, 'rootIdentity': [st.st_dev, st.st_ino],
                'resourceSha256': digest(self.key_resource),
                'requestSha256': digest({'method': 'POST', 'resource': self.key_resource,
                    'displayName': 'Signmons P08 ' + self.plan['operationId'],
                    'restrictions': self.key.RESTRICTIONS})}

    def _validate_lifecycle(self, value):
        pins = self._lifecycle_pins()
        fields = {'phase', 'absenceObservedAt', 'createIntentAt', 'createOperation',
                  'uid', 'etag', 'createTime', 'deleteIntent', 'deleteOperation'}
        need(isinstance(value, dict) and set(value) == set(pins) | fields and
             all(value[k] == v for k, v in pins.items()), 'KEY_PRIVATE_BINDING')
        need(value['phase'] in {'INTENT', 'CREATE_OPERATION', 'CREATED', 'DELETE_INTENT',
                              'DELETE_OPERATION', 'DELETED'}, 'KEY_PRIVATE_PHASE')
        start, end = self.cap.times['start'], self.cap.times['workEnd']
        need(all(type(value[k]) in (int, float) for k in ('absenceObservedAt', 'createIntentAt')) and
             start <= value['absenceObservedAt'] <= value['createIntentAt'] < end, 'KEY_PRIVATE_TIME')
        for field in ('createOperation', 'deleteOperation'):
            need(value[field] is None or (type(value[field]) is str and
                 re.fullmatch(r'operations/[A-Za-z0-9_.-]{1,200}', value[field])), 'KEY_PRIVATE_OPERATION')
        need(type(value['deleteIntent']) is bool, 'KEY_PRIVATE_DELETE')
        uid = value['uid']
        need(uid is None or (type(uid) is str and str(uuid.UUID(uid)) == uid), 'KEY_PRIVATE_UID')
        need((uid is None and value['etag'] is None and value['createTime'] is None) or
             (uid is not None and type(value['etag']) is str and 0 < len(value['etag']) <= 256),
             'KEY_PRIVATE_METADATA')
        created = value['createTime']
        if created is not None:
            need(type(created) is str and re.fullmatch(r'\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.[0-9]{1,9})?Z', created), 'KEY_PRIVATE_CREATED')
            at = datetime.datetime.fromisoformat(created.replace('Z', '+00:00')).timestamp()
            need(start <= at < self.cap.times['cleanupEnd'], 'KEY_PRIVATE_CREATED')
        phase = value['phase']
        need((phase == 'INTENT' and value['createOperation'] is None and uid is None and
              not value['deleteIntent'] and value['deleteOperation'] is None) or
             (phase == 'CREATE_OPERATION' and value['createOperation'] is not None and uid is None and
              not value['deleteIntent'] and value['deleteOperation'] is None) or
             (phase in {'CREATED', 'DELETE_INTENT', 'DELETE_OPERATION', 'DELETED'} and
              value['createOperation'] is not None and uid is not None and
              (phase != 'CREATED' or not value['deleteIntent'] and value['deleteOperation'] is None) and
              (phase != 'DELETE_INTENT' or value['deleteIntent'] and value['deleteOperation'] is None) and
              (phase != 'DELETE_OPERATION' or value['deleteIntent'] and value['deleteOperation'] is not None) and
              (value['deleteOperation'] is None or value['deleteIntent'])), 'KEY_PRIVATE_PHASE')
        return value

    def _load_lifecycle(self):
        need(not os.path.lexists(self.cap.root / 'key-lifecycle-private.json.next'), 'KEY_PRIVATE_UNFINISHED')
        path = self.cap.root / 'key-lifecycle-private.json'
        need(path.lstat().st_uid == os.getuid(), 'KEY_PRIVATE_OWNER')
        return self._validate_lifecycle(read(path))

    def _save_lifecycle(self, value):
        self._validate_lifecycle(value)
        path = self.cap.root / 'key-lifecycle-private.json'
        pending = self.cap.root / 'key-lifecycle-private.json.next'
        need(not os.path.lexists(pending), 'KEY_PRIVATE_UNFINISHED')
        if os.path.lexists(path):
            need(path.lstat().st_uid == os.getuid(), 'KEY_PRIVATE_OWNER')
            self._validate_lifecycle(read(path))
        reserve(pending, value)
        os.replace(pending, path)
        fd = os.open(self.cap.root, os.O_RDONLY | os.O_DIRECTORY)
        try: os.fsync(fd)
        finally: os.close(fd)

    def normalized_key(self, value):
        normalized = super().normalized_key(value)
        # Creation establishes provenance through _key_state. Deleted metadata
        # remains readable for final containment checks, without version adoption.
        if self.owned_uid is None or normalized['deleted']:
            return normalized
        receipt = self._load_lifecycle()
        need(normalized['uid'] == receipt['uid'] == self.owned_uid, 'KEY_OWNED_METADATA_DRIFT')
        if receipt['phase'] in ('DELETE_INTENT', 'DELETE_OPERATION', 'DELETED'):
            return normalized
        need(receipt['phase'] == 'CREATED' and not receipt['deleteIntent'] and
             receipt['deleteOperation'] is None and
             receipt['etag'] == self.owned_etag, 'KEY_OWNED_METADATA_DRIFT')
        created = value.get('createTime')
        need(type(created) is str and
             re.fullmatch(r'\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.[0-9]{1,9})?Z', created),
             'KEY_PRIVATE_CREATED')
        at = datetime.datetime.fromisoformat(created.replace('Z', '+00:00')).timestamp()
        need(self.cap.times['start'] <= at < self.cap.times['cleanupEnd'], 'KEY_PRIVATE_CREATED')
        if receipt['createTime'] is not None:
            original = receipt['createTime']
            # Both strings are calendar-validated UTC with up to nine fractional
            # digits. Compare exact fractions; datetime truncates nanoseconds.
            need(created[:19] == original[:19] and
                 created[20:-1].ljust(9, '0') == original[20:-1].ljust(9, '0'), 'KEY_PRIVATE_CREATED')
        if normalized['etag'] != receipt['etag']:
            # Preserve creation identity and intent fields byte-for-byte. A failed
            # atomic publish cannot authorize authentication or conditional delete.
            receipt['etag'] = normalized['etag']
            self._save_lifecycle(receipt)
            self.owned_etag = normalized['etag']
        return normalized

    def _key_state(self, value, response=None):
        # Persist only this exact allowlisted subset, never response bodies/keyString.
        normalized = self.normalized_key(value)
        need(normalized['deleted'] is False, 'KEY_CREATED_DELETED')
        receipt = response if response is not None else self._load_lifecycle()
        receipt.update(phase='CREATED', uid=normalized['uid'], etag=normalized['etag'],
                       createTime=value.get('createTime'))
        self._save_lifecycle(receipt)
        self.owned_uid, self.owned_etag = normalized['uid'], normalized['etag']
        self.cap.coordinator.j['keyUidSha256'] = hashlib.sha256(normalized['uid'].encode()).hexdigest()
        self.cap.coordinator.save()
        return normalized

    def operation(self, initial, kind):
        # Reuse the reviewed paced waiter, not the historical immediate-poll loop.
        def gate(cleanup=False): self.cap.gate(self.io.cleanup)
        def invoke(fn, *args, **kwargs):
            gate(); value = fn(*args); gate(); return value
        deadline = self.cap.times['cleanupEnd' if self.io.cleanup else 'workEnd']
        waiter = SimpleNamespace(a=self.key_adapter, j={}, save=lambda: None, gate=gate,
                                 t={'workEnd': deadline, 'cleanupEnd': deadline},
                                 clock=self.cap.clock, pause=self.pause, invoke=invoke)
        gate()
        try:
            result = self.key.Controller.wait(waiter, initial, kind, cleanup=self.io.cleanup)
            gate(); return result
        except BaseException as error:
            if isinstance(error, (KeyboardInterrupt, SystemExit)): raise
            raise c.Stop('KEY_OPERATION_UNCONFIRMED') from None
        finally: waiter.j.clear()

    def key_get(self):
        try:
            value = super().key_get()
            if value == 'NOT_FOUND' and not self.io.cleanup and self.absence_observed_at is None:
                self.absence_observed_at = self.cap.clock()
            return value
        except BaseException as error:
            if isinstance(error, (KeyboardInterrupt, SystemExit)): raise
            raise c.Stop('KEY_METADATA_UNCONFIRMED') from None

    def key_create(self, resource, restrictions):
        try:
            self.cap.gate(False)
            need(resource == self.key_resource and restrictions == self.key.RESTRICTIONS, 'KEY_CREATE_SCOPE')
            need(self.absence_observed_at is not None and
                 not os.path.lexists(self.cap.root / 'key-lifecycle-private.json') and
                 not os.path.lexists(self.cap.root / 'key-lifecycle-private.json.next'), 'KEY_CREATE_REPLAY')
            receipt = {**self._lifecycle_pins(), 'phase': 'INTENT',
                       'absenceObservedAt': self.absence_observed_at, 'createIntentAt': self.cap.clock(),
                       'createOperation': None, 'uid': None, 'etag': None, 'createTime': None,
                       'deleteIntent': False, 'deleteOperation': None}
            self._save_lifecycle(receipt)
            initial = self.key_adapter.key_create()
            need(isinstance(initial, dict) and type(initial.get('name')) is str and
                 re.fullmatch(r'operations/[A-Za-z0-9_.-]{1,200}', initial['name']), 'KEY_OPERATION_SCOPE')
            receipt.update(phase='CREATE_OPERATION', createOperation=initial['name'])
            self._save_lifecycle(receipt)
            return self._key_state(self.operation(initial, 'create'), receipt)
        except BaseException as error:
            if isinstance(error, (KeyboardInterrupt, SystemExit)): raise
            raise c.Stop('KEY_CREATE_UNCONFIRMED') from None

    def recover_key(self):
        """Rehydrate only persisted create provenance; never adopt an uncertain key."""
        receipt = self._load_lifecycle()
        if receipt['uid'] is None:
            if receipt['createOperation'] is None:
                # Read-only observation cannot turn intent/marker into ownership.
                current = self.key_get()
                self.cap.coordinator.j['keyUnownedObservation'] = ('ABSENT' if current == 'NOT_FOUND' else 'PRESENT')
                self.cap.coordinator.save()
                raise c.Stop('KEY_CREATE_UNCONFIRMED')
            initial = self.key_adapter.operation(receipt['createOperation'], 'key')
            need(isinstance(initial, dict) and initial.get('name') == receipt['createOperation'], 'KEY_OPERATION_DRIFT')
            self._key_state(self.operation(initial, 'create'), receipt)
            receipt = self._load_lifecycle()
        self.owned_uid, self.owned_etag = receipt['uid'], receipt['etag']
        self.cap.coordinator.j['keyUidSha256'] = hashlib.sha256(receipt['uid'].encode()).hexdigest()
        # An acknowledged delete may still be pending; observe its terminal state.
        if receipt['deleteOperation'] is not None and receipt['phase'] != 'DELETED':
            try:
                pending = self.key_adapter.operation(receipt['deleteOperation'], 'key')
                need(isinstance(pending, dict) and pending.get('name') == receipt['deleteOperation'], 'KEY_OPERATION_DRIFT')
                self.operation(pending, 'delete')
            except BaseException:
                pass  # Final authoritative metadata below, never another delete.
        if receipt['deleteIntent']:
            self.cap.coordinator.j['keyDeleteAttempted'] = True
        self.cap.coordinator.j['unknown'] = [v for v in self.cap.coordinator.j['unknown'] if v not in ('KEY_CREATE', 'KEY_LIFECYCLE_UNCONFIRMED')]
        self.cap.coordinator.save()

    def key_delete(self, etag):
        failure = None
        try:
            self.cap.gate(True)
            receipt = self._load_lifecycle()
            need(receipt['uid'] == self.owned_uid and etag == self.owned_etag == receipt['etag'] and
                 not receipt['deleteIntent'], 'KEY_DELETE_OWNERSHIP')
            receipt.update(phase='DELETE_INTENT', deleteIntent=True)
            self._save_lifecycle(receipt)
            initial = self.key_adapter.key_delete(etag)
            need(isinstance(initial, dict) and type(initial.get('name')) is str and
                 re.fullmatch(r'operations/[A-Za-z0-9_.-]{1,200}', initial['name']), 'KEY_OPERATION_SCOPE')
            receipt.update(phase='DELETE_OPERATION', deleteOperation=initial['name'])
            self._save_lifecycle(receipt)
            self.operation(initial, 'delete')
        except BaseException as error:
            failure = error
        # Always attempt a final read even when acknowledgement/polling was lost.
        try:
            current = self.key_get()
            need(isinstance(current, dict) and current['uid'] == self.owned_uid and
                 current['deleted'] is True, 'KEY_DELETE_READBACK')
            receipt = self._load_lifecycle()
            need(receipt['uid'] == self.owned_uid, 'KEY_DELETE_OWNERSHIP')
            receipt['phase'] = 'DELETED'
            self._save_lifecycle(receipt)
            return True
        except BaseException:
            if isinstance(failure, (KeyboardInterrupt, SystemExit)): raise failure
            raise c.Stop('KEY_DELETE_UNCONFIRMED') from None

    def authenticate_receipt(self, receipt):
        self.handoff(receipt)
        self.account_readback()
        # Pinned internal lifecycle marker only. Outer result additionally requires actual inventory purge.
        return dict(bridge.packet.AUTH_PROOF)

    def authenticate(self, resource):
        try:
            receipt = self._load_lifecycle()
            bridge.need(receipt['phase'] == 'CREATED' and not receipt['deleteIntent'] and
                        receipt['deleteOperation'] is None and receipt['uid'] == self.owned_uid and
                        receipt['etag'] == self.owned_etag, 'AUTH_KEY_SCOPE')
            return super().authenticate(resource)
        except bridge.packet.Stop as error:
            if (type(error) is bridge.packet.Stop and len(error.args) == 1 and
                    type(error.args[0]) is str and error.args[0] in {
                        'AUTH_KEY_SCOPE', 'AUTH_KEY_OWNERSHIP_DRIFT', 'KEY_STRING_SHAPE'}):
                raise c.Stop(error.args[0]) from None
            raise

    def account_readback(self):
        raw = self.handoff.readback()
        readbacks.exact_account(raw['app'], self.cap.e['target'])
        journal = read(self.cap.root / 'journal.json')
        intent = journal.get('authClient', {}).get('revocationIntentAt')
        need(intent is not None, 'REVOCATION_INTENT_MISSING')
        readbacks.exact_firebase(raw['firebase'], self.cap.e['target'], datetime.datetime.fromisoformat(intent.replace('Z','+00:00')).timestamp())
        need(type(raw['sessions']) is int and raw['sessions'] == 0, 'SESSIONS_REMAIN')
        return {'appDisabled': True, 'firebaseDisabled': True, 'tokensRevoked': True, 'sessionsAbsent': True}

    def runtime_closeout(self):
        # Private absence is verified by entry after lifecycle completion, not an injected success flag.
        deadline = self.cap.gate(True)
        p = {**self.plan, 'iam': []}
        need(self.runtime.retired(p, deadline), 'RUNTIME_RETIRED')
        revision = self.runtime.cloud(['run','revisions','describe',restore.CANDIDATE,
                     '--project=signmons','--region=us-east5',
                     '--format=json(spec.serviceAccountName,spec.containers[].image,spec.containers[].env,status.conditions)'],deadline)
        spec = revision.get('spec', {}); containers = spec.get('containers')
        need(spec.get('serviceAccountName') == restore.IDENTITY and isinstance(containers, list) and
             len(containers) == 1 and containers[0].get('image') == restore.IMAGE and
             digest(containers[0].get('env')) == self.cap.e['qualification']['runtimeEnvironmentSha256'],
             'CANDIDATE_ENVIRONMENT_DRIFT')
        return True


class Coordinator(c.Coordinator):
    SETTLE_SECONDS = 420
    POST_SETTLE_SECONDS = 960

    def __init__(self, cap, io, runtime, ports):
        super().__init__(cap.plan, cap.local_approval, cap.e['qualification'], runtime, ports,
                         cap.root, cap.clock, closeout=cap.mode != 'run')
        self.cap, self.io = cap, io
        self.modules["restore"] = cap.modules["restore"]
        self.j['nativeEntry'] = {'envelopeSha256': cap.envelope_hash,
            'calls': {k: 0 for k in ('cli','https','sql','child')}}
        cap.coordinator = self
        self.monotonic, self.pause = time.monotonic, time.sleep
        self.last_monotonic = self.monotonic()
        self.forward_end = min(self.times['workEnd'], restore.timestamp(cap.e['payment']['workEnd'])) if cap.e.get('version') == 2 else self.times['workEnd']
        self.work_monotonic_end = self.last_monotonic + max(0, self.forward_end - self.clock())
        self.child_monotonic_end = self.last_monotonic + max(0, self.times['cutoff'] - self.clock())
        self.mutation_admitted = False
        self.settling_attempted = False

    def gate(self, cleanup=False):
        super().gate(cleanup)
        self.cap.gate(cleanup)
        if not cleanup:
            now = self.monotonic()
            c.need(math.isfinite(now) and now >= self.last_monotonic, 'CLOCK_ROLLBACK')
            self.last_monotonic = now
            c.need(now < self.work_monotonic_end, 'DEADLINE')

    def require_work(self, seconds):
        self.gate()
        c.need(min(self.forward_end - self.clock(),
                   self.work_monotonic_end - self.monotonic()) >= seconds, 'DEADLINE')

    def require_child_entry(self, seconds):
        # The authentication child authorizes against cutoff, not workEnd.
        # Admission must preserve both budgets without extending either one.
        self.require_work(seconds)
        c.need(min(self.times['cutoff'] - self.clock(),
                   self.child_monotonic_end - self.monotonic()) >= seconds,
               'START_CUTOFF')

    def settle_bindings(self):
        c.need(not self.settling_attempted, 'IAM_SETTLE_ALREADY_ATTEMPTED')
        self.settling_attempted = True
        c.need(self.j.get('iamOwned') == ['lookup', 'signing'], 'IAM_READBACK')
        self.require_child_entry(self.SETTLE_SECONDS + self.POST_SETTLE_SECONDS)
        until = self.monotonic() + self.SETTLE_SECONDS
        while True:
            self.gate()
            before = self.monotonic()
            if before >= until:
                break
            self.pause(min(1, until - before))
            after = self.monotonic()
            c.need(math.isfinite(after) and after > before, 'CLOCK_ROLLBACK')
        self.require_child_entry(self.POST_SETTLE_SECONDS)

    def invoke(self, method, *args, owner, cleanup=False):
        if not cleanup:
            # Refuse an already-short session before the inherited coordinator
            # records any mutation intent; recheck immediately before dispatch.
            if method == 'preflight' and owner is self.runtime and self.cap.mode == 'run':
                self.require_child_entry(self.SETTLE_SECONDS + self.POST_SETTLE_SECONDS)
            if method == 'change' and owner is self.runtime and not self.mutation_admitted:
                self.require_child_entry(self.SETTLE_SECONDS + self.POST_SETTLE_SECONDS)
                self.mutation_admitted = True
            if method == 'stage_a' and owner is self.access:
                self.settle_bindings()
        if method != 'preflight' or cleanup:
            return super().invoke(method, *args, owner=owner, cleanup=cleanup)
        self.j['preflightStage'] = ('RUNTIME_PREFLIGHT' if owner is self.runtime
                                    else 'ACCESS_PREFLIGHT')
        self.save()
        try:
            return super().invoke(method, *args, owner=owner, cleanup=cleanup)
        except BaseException as error:
            code = (error.args[0] if isinstance(error, (Stop, restore.Stop, bridge.packet.Stop, c.Stop))
                    and len(error.args) == 1 and type(error.args[0]) is str else None)
            raise c.Stop(code if code in PREFLIGHT_CODES else 'LOCAL_ADAPTER_OR_SOURCE_STOP') from None

    def closeout(self, independent=False):
        self.io.cleanup = True
        if independent:
            need(not (self.dir / 'independent-closeout.json').exists(), 'INDEPENDENT_ALREADY_CONSUMED')
            self.j = read(self.dir / 'journal.json')
            native = self.j.get('nativeEntry', {})
            need(native.get('envelopeSha256') == self.cap.envelope_hash and
                 set(native.get('calls', {})) == {'cli','https','sql','child'} and
                 all(type(v) is int and 0 <= v <= self.cap.e['limits'][k]
                     for k,v in native['calls'].items()), 'INDEPENDENT_BINDING')
            need(self.j.get('operationId') == self.plan['operationId'] and
                 self.j.get('planSha256') == c.digest(self.plan), 'FOREIGN_JOURNAL')
        if self.j.get('keyCreateAttempted'):
            try:
                self.access.recover_key()
            except BaseException:
                if 'KEY_LIFECYCLE_UNCONFIRMED' not in self.j['unknown']:
                    self.j['unknown'].append('KEY_LIFECYCLE_UNCONFIRMED')
                self.save()
        if getattr(self.io, 'child_cleanup_unconfirmed', False):
            if 'CHILD_PROCESS_CLOSEOUT_UNCONFIRMED' not in self.j['unknown']:
                self.j['unknown'].append('CHILD_PROCESS_CLOSEOUT_UNCONFIRMED')
            self.save()
        return super().closeout(independent=independent)


def run_preflight_entry(envelope_path, mode, io_factory=None, clock=time.time, read_commit=committed):
    """NQ1 reads only. Never call Coordinator.run or resource closeout."""
    import signal
    path = Path(envelope_path)
    need(path.name == 'envelope.json', 'ENVELOPE_PATH')
    cap = Capability(read(path), path.parent, mode, clock, read_commit)
    need(cap.e.get('purpose') == 'NATIVE_PREFLIGHT_ONLY', 'PREFLIGHT_PURPOSE')
    lock = os.open(cap.root/'entry.lock', os.O_WRONLY|os.O_CREAT|os.O_NOFOLLOW, 0o600)
    io = None
    try:
        try: fcntl.flock(lock, fcntl.LOCK_EX|fcntl.LOCK_NB)
        except BlockingIOError: raise Stop('ENTRY_ALREADY_RUNNING') from None
        inspect(cap.root, cap.plan['operationId'])
        io = (io_factory or PreflightIO)(cap)
        need(cap.external is (not io.proof), 'TRANSPORT_AUTHORITY_MISMATCH')
        runtime = RuntimeAdapter(cap, io, clock=clock); runtime.q = cap.e['qualification']
        # Any legacy payment-child request is explicitly forbidden by this mode.
        runtime.payment_preflight = lambda: need(False, 'PREFLIGHT_CHILD_DENIED')
        ports = Ports(cap, io, None, runtime)
        controller = Coordinator(cap, io, runtime, ports)
        identity = {'operationId':cap.plan['operationId'], 'planSha256':digest(cap.plan)}
        if mode == 'preflight':
            reserve(cap.root/'attempt.json', identity)
            controller.j.update(preflightOnly=True, preflightPassed=False, preflightProcessPending=False)
            controller.save()
            previous = {sig:signal.getsignal(sig) for sig in (signal.SIGINT,signal.SIGTERM)}
            for sig in previous: signal.signal(sig,lambda *_:setattr(controller,'abort',True))
            try:
                rp = controller.runtime_plan()
                c.need(controller.invoke('preflight',rp,cap.e['qualification'],owner=runtime) is True,'RUNTIME_PREFLIGHT')
                pre = controller.invoke('preflight',owner=ports)
                c.need(isinstance(pre,dict) and pre.get('bindingsAbsent') is True and
                       pre.get('apiKeysService') in ('ENABLED','DISABLED'),'ACCESS_PREFLIGHT')
                roles = controller.modules['bridge'].packet.module('roles').ROLES
                c.need(isinstance(pre.get('roles'),list) and len(pre['roles'])==len(roles)==2 and
                       all(controller.modules['bridge'].packet.module('roles').definition_shape(v,role) in
                           ('EXACT_ACTIVE_EXPLICIT','EXACT_ACTIVE_DEFAULTED') for v,role in zip(pre['roles'],roles)), 'ROLE_DRIFT')
                controller.j['preflightPassed'] = True
            except BaseException as error:
                controller.j['failure'] = (error.args[0] if isinstance(error,c.Stop) and len(error.args)==1 and
                    error.args[0] in PREFLIGHT_CODES | {'RUNTIME_PREFLIGHT','ACCESS_PREFLIGHT','ROLE_DRIFT'} else 'LOCAL_ADAPTER_OR_SOURCE_STOP')
            finally:
                for sig,handler in previous.items():signal.signal(sig,handler)
                controller.save()
        else:
            need(read(cap.root/'attempt.json') == identity, 'ATTEMPT_BINDING')
            controller.j = read(cap.root/'journal.json')
            need(controller.j.get('preflightOnly') is True and controller.j.get('operationId')==cap.plan['operationId'] and
                 controller.j.get('planSha256')==digest(cap.plan) and
                 controller.j.get('nativeEntry',{}).get('envelopeSha256')==cap.envelope_hash and
                 controller.j.get('runtimeAttempted')==[] and controller.j.get('iamAttempted')==[] and
                 controller.j.get('authAttempted') is False and controller.j.get('keyCreateAttempted') is False, 'PREFLIGHT_CLOSEOUT_BINDING')
            calls=controller.j['nativeEntry']['calls']
            need(set(calls)=={'cli','https','sql','child'} and all(type(v)is int and 0<=v<=cap.e['limits'][k] for k,v in calls.items()) and calls['child']==0,'PREFLIGHT_CLOSEOUT_BUDGET')
        reserve(cap.root/('closeout.json' if mode=='preflight' else 'independent-closeout.json'),identity)
        residuals = [x for x in controller.j.get('residuals',[]) if x in
                     ('PREFLIGHT_PROCESS_HISTORY_UNKNOWN','PREFLIGHT_PROCESS_CLOSEOUT')]
        if controller.j.get('preflightProcessPending') is not False:
            residuals.append('PREFLIGHT_PROCESS_HISTORY_UNKNOWN')
        io.cleanup = True
        try:
            need(io.close_processes(cap.times['cleanupEnd']), 'PREFLIGHT_PROCESS_CLOSEOUT')
        except BaseException: residuals.append('PREFLIGHT_PROCESS_CLOSEOUT')
        # A fresh connection checks only this operation's application_name; no termination SQL.
        try:
            need(json.loads(io.sql(io.close_sql,cap.times['cleanupEnd']))=={'sessionsAbsent':True}, 'PREFLIGHT_SESSIONS')
        except BaseException: residuals.append('PREFLIGHT_SESSIONS_UNCONFIRMED')
        try:
            need(io.close_processes(cap.times['cleanupEnd']), 'PREFLIGHT_PROCESS_CLOSEOUT')
        except BaseException: residuals.append('PREFLIGHT_PROCESS_CLOSEOUT')
        controller.j['residuals']=sorted(set(residuals));controller.save()
        absent=False
        if mode=='close-preflight':
            try:
                need(clock()<cap.times['purgeEnd'],'PURGE_DEADLINE')
                absent=purge(cap.root,cap.plan['operationId'])
                need(absent and clock()<cap.times['purgeEnd'],'PURGE_UNCONFIRMED')
            except BaseException: residuals.append('PRIVATE_INVENTORY_UNCONFIRMED')
        result={'status':('NATIVE_PREFLIGHT_CLOSED' if not residuals else 'NATIVE_PREFLIGHT_CONTAINMENT_UNCONFIRMED')
                if mode=='close-preflight' else 'NATIVE_PREFLIGHT_AWAITING_CLOSEOUT',
                'operationId':cap.plan['operationId'],'preflightPassed':controller.j.get('preflightPassed') is True,
                'preflightStage':controller.j.get('preflightStage'),'failure':controller.j.get('failure'),
                'residuals':sorted(set(residuals)),'privateInputsAbsent':absent,
                'paymentObserved':False,'paymentReadyForAcceptance':False,'authenticationObserved':False}
        reserve(cap.root/('result.json' if mode=='close-preflight' else 'work-result.json'),result)
        return result
    finally:
        if io is not None:
            try:io.close_processes(cap.times['cleanupEnd'])
            finally:io.clear()
        fcntl.flock(lock,fcntl.LOCK_UN);os.close(lock)


def run_entry(envelope_path, mode='run', io_factory=NativeIO, clock=time.time, read_commit=committed):
    path = Path(envelope_path)
    need(path.name == 'envelope.json', 'ENVELOPE_PATH')
    e = read(path)
    cap = Capability(e, path.parent, mode, clock, read_commit)
    need(mode in ('run','closeout'), 'ENTRY_MODE')
    io = io_factory(cap)
    need(cap.external is (not io.proof), 'TRANSPORT_AUTHORITY_MISMATCH')
    lock_fd = os.open(cap.root / 'entry.lock', os.O_WRONLY | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    try:
        try: fcntl.flock(lock_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError: raise Stop('ENTRY_ALREADY_RUNNING') from None
        inspect(cap.root, cap.plan['operationId'])
        runtime = RuntimeAdapter(cap, io, clock=clock)
        runtime.q = cap.e['qualification']
        handoff = Handoff(cap, io)
        runtime.payment_preflight = handoff.preflight_payment
        runtime.close_authentication = lambda plan, deadline: handoff.closeout_only()
        ports = Ports(cap, io, handoff, runtime)
        controller = Coordinator(cap, io, runtime, ports)
        handoff.attach(controller)
        if mode == 'closeout':
            attempt = read(cap.root / 'attempt.json')
            need(attempt == {'operationId': cap.plan['operationId'], 'planSha256': digest(cap.plan)}, 'ATTEMPT_BINDING')
        result = controller.run() if mode == 'run' else controller.closeout(independent=True)
        residuals = list(result['residuals'])
        if cap.e['version'] == 2:
            payment = controller.j.get('payment')
            # Main readback failure must survive into work-result: the independent
            # child may only reuse a completed, successful payment observation.
            if controller.j.get('authAttempted') and (
                    any(v in residuals for v in ('ACCOUNT_SESSION', 'PAYMENT_JOURNAL_UNCONFIRMED')) or
                    (cap.root / 'journal.json.payment-next').exists()):
                # The unchanged Handoff schema rejects a failed child or an
                # uncommitted journal before account success can be accepted.
                # With no separate payment receipt, that readback cannot serve
                # as completed payment evidence either.
                residuals.append('PAYMENT_ENDPOINT_UNCONFIRMED')
            if isinstance(payment, dict):
                if payment.get('enableIntent') or controller.j.get('authAttempted'):
                    payment_residuals = payment.get('residuals')
                    payment_bound = (payment.get('operationId') == cap.plan['operationId'] and
                                     payment.get('scopeSha256') == digest(cap.e['payment']) and
                                     isinstance(payment_residuals, list))
                    if not payment_bound or payment.get('endpointDisabled') is not True or 'PAYMENT_ENDPOINT_UNCONFIRMED' in payment_residuals:
                        residuals.append('PAYMENT_ENDPOINT_UNCONFIRMED')
                    if payment.get('bridgeClosed') is not True or (isinstance(payment_residuals, list) and 'PAYMENT_BRIDGE_UNCONFIRMED' in payment_residuals):
                        residuals.append('PAYMENT_BRIDGE_UNCONFIRMED')
            elif controller.j.get('authAttempted'):
                residuals.append('PAYMENT_ENDPOINT_UNCONFIRMED')
        private_absent = False
        try:
            need(clock() < cap.times['purgeEnd'], 'PURGE_DEADLINE')
            if cap.e['version'] == 2 and mode == 'run':
                # Version2 retains the owned envelope for mandatory independent closeout.
                # It is never returned as a fully closed operation here.
                result = {'status':'ENTRY_AWAITING_INDEPENDENT_CLOSEOUT',
                          'operationId':cap.plan['operationId'], 'liveAuthorization':cap.external,
                          'authProofReady':False, 'paymentReadyForAcceptance':False,
                          'paymentObserved':({} if controller.j.get('payment') is None else controller.j['payment']).get('outcome') == 'APPLICATION_SETTLED',
                          'residuals':sorted(set(residuals)), 'privateInputsAbsent':False}
                reserve(cap.root / 'work-result.json', result)
                return result
            private_absent = purge(cap.root, cap.plan['operationId'])
            need(private_absent and clock() < cap.times['purgeEnd'], 'PURGE_UNCONFIRMED')
        except Exception:
            residuals.append('PRIVATE_INVENTORY_UNCONFIRMED')
        result = {'status': 'ENTRY_CLOSED' if not residuals else 'ENTRY_CONTAINMENT_UNCONFIRMED',
                  'operationId': cap.plan['operationId'], 'liveAuthorization': cap.external,
                  'authProofReady': cap.external and controller.j.get('authProofAccepted') is True and not residuals,
                  'authenticationObserved': controller.j.get('authProofAccepted') is True,
                  'residuals': sorted(set(residuals)), 'privateInputsAbsent': private_absent,
                  'childResultSha256': result.get('childResultSha256')}
        if cap.e['version'] == 2:
            payment = controller.j.get('payment')
            if payment is None:payment = {}
            result['paymentObserved'] = payment.get('outcome') == 'APPLICATION_SETTLED'
            result['paymentReadyForAcceptance'] = False
            if payment.get('enableIntent') and payment.get('endpointDisabled') is not True:
                result['residuals'] = sorted(set(result['residuals'] + ['PAYMENT_ENDPOINT_UNCONFIRMED']))
                result['status'] = 'ENTRY_CONTAINMENT_UNCONFIRMED'
                result['authProofReady'] = False
        reserve(cap.root / 'result.json', result)
        return result
    finally:
        io.clear()
        fcntl.flock(lock_fd, fcntl.LOCK_UN)
        os.close(lock_fd)


def main(argv):
    if len(argv) == 3 and argv[0] == '--check-child':
        path, mode = Path(argv[1]), argv[2]
        need(path.name == 'envelope.json', 'ENVELOPE_PATH')
        e = read(path)
        if mode == 'payment-preflight':need(e['version'] == 2, 'PAYMENT_PREFLIGHT_VERSION')
        cap = Capability(e, path.parent, 'run' if mode == 'payment-preflight' else mode, continuing=True)
        print(json.dumps({'envelopeSha256': cap.envelope_hash, 'operationId': cap.plan['operationId'],
                          'external': cap.external, 'mode': mode}))
        return 0
    need(len(argv) == 2 and argv[0] in ('--run','--closeout','--preflight','--close-preflight'), 'NATIVE_ENTRY_UNBOUND')
    result = (run_preflight_entry if argv[0] in ('--preflight','--close-preflight') else run_entry)(argv[1], argv[0][2:])
    print(json.dumps(result)); return 0 if result['status'] in ('ENTRY_CLOSED','NATIVE_PREFLIGHT_CLOSED') else 2


if __name__ == '__main__':
    try: raise SystemExit(main(sys.argv[1:]))
    except Exception:
        print('{"status":"NATIVE_ENTRY_REFUSED_OR_UNCONFIRMED"}')
        raise SystemExit(2)
