"""Single-owner assembled entry. No operation is authorized by installing this code."""
import datetime
import fcntl
import hashlib
import json
import os
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

    def authenticate_receipt(self, receipt):
        self.handoff(receipt)
        self.account_readback()
        # Pinned internal lifecycle marker only. Outer result additionally requires actual inventory purge.
        return dict(bridge.packet.AUTH_PROOF)

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
    def __init__(self, cap, io, runtime, ports):
        super().__init__(cap.plan, cap.local_approval, cap.e['qualification'], runtime, ports,
                         cap.root, cap.clock, closeout=cap.mode != 'run')
        self.cap, self.io = cap, io
        self.modules["restore"] = cap.modules["restore"]
        self.j['nativeEntry'] = {'envelopeSha256': cap.envelope_hash,
            'calls': {k: 0 for k in ('cli','https','sql','child')}}
        cap.coordinator = self

    def invoke(self, method, *args, owner, cleanup=False):
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
            # Fresh process reconstructs key ownership only from intent plus exact authoritative metadata.
            if self.j.get('keyUidSha256'):
                try:
                    current = self.access.key_get()
                    if isinstance(current, dict) and hashlib.sha256(current['uid'].encode()).hexdigest() == self.j['keyUidSha256']:
                        self.access.owned_uid, self.access.owned_etag = current['uid'], current['etag']
                except Exception:
                    pass  # Original closeout retains OWNED_KEY residual on unknown readback.
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
