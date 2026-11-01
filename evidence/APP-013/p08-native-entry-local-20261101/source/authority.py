"""Separate exact outer authority. Local capabilities never authorize native I/O."""
import hashlib
import importlib.util
import json
import re
import subprocess
import time
from pathlib import Path
from private_inventory import Stop, need, inspect

HERE = Path(__file__).resolve().parent
APP = HERE.parent.parent
BACKEND = APP.parent.parent
GOV = Path('/Users/debynyhanbanks/Web Projects/signmons-governance-r08-recovery')
FILES = {'authority.py', 'entry.py', 'native_io.py', 'handoff.py', 'private_inventory.py',
         'authority_bridge.mjs', 'transports.mjs', 'native_child.mjs'}


def digest(value):
    b = value if isinstance(value, bytes) else json.dumps(value, sort_keys=True, separators=(',', ':')).encode()
    return hashlib.sha256(b).hexdigest()


def load(relative, name):
    spec = importlib.util.spec_from_file_location(name, APP / relative)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def verify_sources():
    manifest = json.loads((HERE / 'source-manifest.json').read_text())
    need(set(manifest) == {'status', 'files', 'lockedSources'} and
         manifest['status'] == 'LOCAL_IMPLEMENTATION_NO_OPERATION_APPROVED' and
         set(manifest['files']) == FILES, 'MANIFEST_SHAPE')
    for base, entries in [(HERE, manifest['files']), (APP, manifest['lockedSources'])]:
        for name, expected in entries.items():
            path = base / name
            need(not Path(name).is_absolute() and '..' not in Path(name).parts and
                 path.is_file() and not path.is_symlink() and digest(path.read_bytes()) == expected,
                 'SOURCE_DRIFT')
    old = load('p08-real-client-binding-local-20261031/source/bound_handoff.py', 'entry_old_handoff')
    old.verify_sources()
    adapter = load('p08-native-closeout-local-20261031/source/adapter.py', 'entry_old_readbacks')
    adapter.verify_bundle()
    adapter.load_sources()
    return manifest


def committed(repo, commit, path):
    need(re.fullmatch('[0-9a-f]{40}', commit or '') and
         re.fullmatch('[A-Za-z0-9_./-]+', path or '') and '..' not in path.split('/'),
         'COMMITTED_REFERENCE')
    r = subprocess.run(['/usr/bin/git', 'show', commit + ':' + path], cwd=repo,
                       capture_output=True, timeout=5)
    need(r.returncode == 0 and len(r.stdout) <= 1048576, 'COMMITTED_EVIDENCE_MISSING')
    return r.stdout


class Capability:
    def __init__(self, envelope, root, mode='run', clock=time.time, read_commit=committed, continuing=False):
        manifest = verify_sources()
        need(set(envelope) == {'version', 'execution', 'plan', 'target', 'database', 'resources',
                              'qualification', 'limits', 'sourceManifestSha256', 'sourceCommit', 'decision'},
             'ENVELOPE_SHAPE')
        e = json.loads(json.dumps(envelope))
        need(e['version'] == 1 and e['execution'] in ('EXTERNAL', 'PROOF_ONLY') and
             mode in ('run', 'closeout', 'readback'), 'ENTRY_MODE')
        need(e['sourceManifestSha256'] == digest((HERE / 'source-manifest.json').read_bytes()),
             'MANIFEST_BINDING')
        c = load('p08-live-binder-local-20261029/source/coordinator.py', 'entry_old_coordinator')
        modules = c.sources(); restore = modules['restore']
        p = e['plan']
        local_approval = {'decision': 'APPROVE_LOCAL_SINGLE_COORDINATOR', 'externalActionAuthorized': False,
                          'operationId': p['operationId'], 'planSha256': digest(p)}
        times = c.authorize(p, local_approval, modules, clock(), closeout=mode != 'run' or continuing)
        if continuing:
            from private_inventory import read
            attempt = read(Path(root) / 'attempt.json')
            need(attempt == {'operationId': p['operationId'], 'planSha256': digest(p)}, 'PARENT_ATTEMPT')
            need(mode != 'run' or clock() < times['workEnd'], 'CHILD_WORK_DEADLINE')
        need(str(__import__('uuid').UUID(p['operationId'])) == p['operationId'], 'OPERATION_ID')
        t = e['target']
        need(set(t) == {'id', 'tenantId', 'email', 'fullName', 'role'} and
             str(__import__('uuid').UUID(t['id'])) == t['id'] and t['tenantId'] == p['tenantId'] and
             t['email'] == p['ownerPrincipal'] and t['fullName'] == 'Signmons Test Administrator' and
             t['role'] == 'ADMIN', 'TARGET_SCOPE')
        db = e['database']
        need(set(db) == {'host', 'port', 'database', 'user'} and
             all(isinstance(db[k], str) and db[k] and len(db[k]) <= 255 for k in ('host', 'database', 'user')) and
             type(db['port']) is int and 1 <= db['port'] <= 65535, 'DATABASE_SCOPE')
        need(e['resources'] == {'candidate': restore.CANDIDATE, 'image': restore.IMAGE,
             'normalRevision': restore.NORMAL, 'identity': restore.IDENTITY,
             'secretVersions': {s: '1' for s in restore.SECRETS}}, 'RESOURCE_PINS')
        limits = e['limits']
        need(set(limits) == {'cli', 'https', 'sql', 'child', 'childRequests'} and
             all(type(v) is int and 1 <= v <= 512 for v in limits.values()) and limits['child'] <= 8,
             'CALL_BUDGET')
        q = e['qualification']
        scope = {k: e[k] for k in ('plan', 'target', 'database', 'resources', 'limits')}
        need(set(q) == {'status', 'operationId', 'scopeSha256', 'qualifiedUntil',
                        'runtimeEnvironmentSha256', 'roleAclSha256', 'checks'} and
             q['status'] == 'QUALIFIED_FOR_NATIVE_ENTRY' and q['operationId'] == p['operationId'] and
             q['scopeSha256'] == digest(scope) and restore.timestamp(q['qualifiedUntil']) >= times['cleanupEnd'] and
             set(q['checks']) == {'owner', 'billing', 'effectiveAccess', 'services', 'database',
                                 'firebase', 'job', 'retiredRuntime', 'privateInventory'} and
             all(v is True for v in q['checks'].values()) and
             all(re.fullmatch('[a-f0-9]{64}', q[k] or '') for k in ('runtimeEnvironmentSha256', 'roleAclSha256')),
             'QUALIFICATION_BINDING')
        scope_hash = digest({k: v for k, v in e.items() if k != 'decision'})
        if e['execution'] == 'PROOF_ONLY':
            need(e['decision'] == {'decision': 'APPROVE_LOCAL_NATIVE_ENTRY_PROOF', 'scopeSha256': scope_hash},
                 'LOCAL_PROOF_BINDING')
        else:
            d = e['decision']
            need(set(d) == {'commit', 'path', 'sha256'} and
                 re.fullmatch(r'APP013_P08_NATIVE_OPERATION_[0-9]{8}\.json', d['path']), 'DECISION_REFERENCE')
            raw = read_commit(GOV, d['commit'], d['path'])
            need(digest(raw) == d['sha256'], 'DECISION_DIGEST')
            need(json.loads(raw) == {'owner': 'Debynyhan Banks',
                 'decision': 'APPROVE_EXACT_P08_NATIVE_ENTRY', 'externalActionAuthorized': True,
                 'operationId': p['operationId'], 'scopeSha256': scope_hash,
                 'sourceManifestSha256': e['sourceManifestSha256']}, 'EXACT_OWNER_APPROVAL')
            rel = str(HERE.relative_to(BACKEND))
            need(read_commit(BACKEND, e['sourceCommit'], rel + '/source-manifest.json') ==
                 (HERE / 'source-manifest.json').read_bytes(), 'COMMITTED_SOURCE_MANIFEST')
            for name, expected in manifest['files'].items():
                need(digest(read_commit(BACKEND, e['sourceCommit'], rel + '/' + name)) == expected,
                     'COMMITTED_SOURCE_DRIFT')
        self.e, self.plan, self.root, self.mode, self.clock = e, p, inspect(root, p['operationId']), mode, clock
        self.external = e['execution'] == 'EXTERNAL'
        self.times, self.last, self.coordinator = times, clock(), None
        self.envelope_hash = digest(e)
        self.local_approval, self.modules, self.c = local_approval, modules, c

    def gate(self, cleanup=False):
        now = self.clock()
        need(now >= self.last, 'CLOCK_ROLLBACK'); self.last = now
        need(self.times['start'] <= now < self.times['cleanupEnd' if cleanup else 'workEnd'], 'ENTRY_DEADLINE')
        need(cleanup or self.mode == 'run', 'CLOSEOUT_ONLY')
        need(cleanup or self.coordinator is None or not self.coordinator.abort, 'INTERRUPTED')
        inspect(self.root, self.plan['operationId'])
        return self.times['cleanupEnd' if cleanup else 'workEnd']

    def spend(self, kind, cleanup=False):
        deadline = self.gate(cleanup)
        need(self.coordinator is not None, 'JOURNAL_NOT_BOUND')
        budget = self.coordinator.j['nativeEntry']['calls']
        need(budget[kind] < self.e['limits'][kind], 'ENTRY_CALL_LIMIT')
        budget[kind] += 1
        self.coordinator.save()
        return deadline
