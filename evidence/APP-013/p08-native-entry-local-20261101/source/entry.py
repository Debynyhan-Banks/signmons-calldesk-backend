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
from native_io import NativeIO, load_acl
from handoff import Handoff

readbacks = load('p08-native-closeout-local-20261031/source/adapter.py', 'entry_readback_contract')
c, bridge, restore = readbacks.load_sources()


class RuntimeAdapter(restore.NativeAdapter):
    """Full ACL validation at each inherited phase readback, including independent closure."""
    def __init__(self, cap, io, clock=time.time):
        super().__init__(None, '', runner=io.cloud, sql=io.sql, clock=clock)
        self.cap = cap
        self.acl = load_acl()

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
                      'unsafe','memberships','owned','sessions','schemaCreate','databaseTemp','acl'}
            need(isinstance(v, dict) and set(v) == fields, 'ROLE_OUTPUT_UNKNOWN')
            need(v['role'] == self.acl.RETIRED_ROLE and
                 v['database'] == self.cap.e['database']['database'] and
                 v['user'] == self.cap.e['database']['user'], 'ROLE_IDENTITY_UNKNOWN')
            need(all(type(v[k]) is int and v[k] >= 0 for k in ('count','limit','memberships','owned','sessions')) and
                 all(type(v[k]) is bool for k in ('login','expiryFinite','expired','unsafe','schemaCreate','databaseTemp')),
                 'ROLE_OUTPUT_UNKNOWN')
            need(v['count'] == 1 and v['expiryFinite'] and not v['unsafe'] and
                 v['memberships'] == v['owned'] == 0 and not v['schemaCreate'] and not v['databaseTemp'],
                 'ROLE_NOT_READY')
            need(isinstance(v['expires'], str) and 0 < len(v['expires']) <= 64, 'ROLE_OUTPUT_UNKNOWN')
            expiry = datetime.datetime.fromisoformat(v['expires'])
            need(expiry.tzinfo is not None, 'ROLE_OUTPUT_UNKNOWN')
            _, legacy = self.acl.classify_role_acl(v['acl'], v['database'], self.acl.expected_retired_acl())
            need(self.clock() < deadline, 'ROLE_DEADLINE')
            return {**{k:v[k] for k in ('count','login','limit','expires','expired','unsafe','memberships','owned','sessions')},
                    'acl':legacy}
        except BaseException as error:
            if isinstance(error, Stop): raise
            if isinstance(error, self.acl.Stop): raise Stop(str(error)) from None
            raise Stop('ROLE_READ_UNCONFIRMED') from None


class Ports(bridge.Ports):
    def __init__(self, cap, io, handoff, runtime):
        self.cap, self.io, self.handoff, self.runtime = cap, io, handoff, runtime
        super().__init__(cap.plan, io.cli, io.https, self.authenticate_receipt,
                         self.account_readback, lambda: None, cap.clock)

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
        self.j['nativeEntry'] = {'envelopeSha256': cap.envelope_hash,
            'calls': {k: 0 for k in ('cli','https','sql','child')}}
        cap.coordinator = self

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
        cap = Capability(read(path), path.parent, mode, continuing=True)
        print(json.dumps({'envelopeSha256': cap.envelope_hash, 'operationId': cap.plan['operationId'],
                          'external': cap.external, 'mode': mode}))
        return 0
    need(len(argv) == 2 and argv[0] in ('--run','--closeout'), 'NATIVE_ENTRY_UNBOUND')
    result = run_entry(argv[1], argv[0][2:])
    print(json.dumps(result)); return 0 if result['status'] == 'ENTRY_CLOSED' else 2


if __name__ == '__main__':
    try: raise SystemExit(main(sys.argv[1:]))
    except Exception:
        print('{"status":"NATIVE_ENTRY_REFUSED_OR_UNCONFIRMED"}')
        raise SystemExit(2)
