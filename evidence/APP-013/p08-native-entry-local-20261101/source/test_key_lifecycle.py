"""Current key lifecycle: real descriptor/HTTP/parser boundary, synthetic provider only."""
import copy
import datetime
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import time
from types import SimpleNamespace, MethodType
import unittest
import uuid
from unittest.mock import patch

import entry
import native_io


class Reply:
    def __init__(self, value, status=200):
        self.raw = json.dumps(value).encode(); self.status = status; self.closed = False
    def read(self, size): return self.raw[:size]
    def close(self): self.closed = True
    def __enter__(self): return self
    def __exit__(self, *_): self.close()


class Harness:
    def __init__(self, root=None, plan=None, now=None):
        self.now = time.time() if now is None else now
        op = str(uuid.uuid4())
        iso = lambda n: datetime.datetime.fromtimestamp(self.now+n, datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')
        self.plan = plan or {'mode': 'LOCAL_INTEGRATED_PACKET_ONLY', 'externalActionAuthorized': False,
            'automaticRetryAllowed': False, 'allowanceUsd': 0, 'project': 'signmons',
            'projectNumber': '123456789012', 'projectNumberSha256': __import__('hashlib').sha256(b'123456789012').hexdigest(),
            'operationId': op, 'keyId': 'signmons-p08-'+op.replace('-', ''),
            'window': {'start': iso(-10), 'cutoff': iso(120), 'workEnd': iso(180), 'cleanupEnd': iso(850), 'purgeEnd': iso(900)}}
        self.root = Path(root) if root else Path('/private/tmp/p08-coordinator-'+self.plan['operationId'])
        if root is None: self.root.mkdir(mode=0o700)
        self.times = {k: entry.restore.timestamp(v) for k, v in self.plan['window'].items()}
        self.calls = []; self.replies = []; self.polls = {'create': 0, 'delete': 0}
        self.complete = {'create': 1, 'delete': 1}; self.initial_done = {'create': None, 'delete': None}
        self.current = None; self.lost = None; self.foreign = None; self.error = None
        self.cap = SimpleNamespace(plan=self.plan, root=self.root, times=self.times,
            e={'sourceCommit': '0'*40, 'resources': {'identity': entry.restore.IDENTITY}, 'limits': {'https': 100}},
            envelope_hash='1'*64, clock=lambda: self.now)
        self.cap.last = self.now; self.cap.mode = 'run'
        self.cap.gate = MethodType(entry.Capability.gate, self.cap)
        self.cap.spend = MethodType(entry.Capability.spend, self.cap)
        self.cap.coordinator = SimpleNamespace(abort=False, j={'unknown': [], 'keyUidSha256': None,
            'keyDeleteAttempted': False, 'nativeEntry': {'calls': {'https': 0}}}, save=self.save)
        self.io = object.__new__(entry.NativeIO)
        self.io.cap = self.cap; self.io.cleanup = False; self.io.token = 'TOKEN_CANARY'; self.io.password = ''
        self.io.ensure_owner = lambda: None
        self.io.cli = lambda _: (_ for _ in ()).throw(AssertionError('No CLI allowed'))
        self.ports = entry.Ports(self.cap, self.io, None, None)
        self.ports.pause = self.pause

    def gate(self, cleanup=False):
        entry.need(self.now < self.times['cleanupEnd' if cleanup else 'workEnd'], 'DEADLINE')
        return self.times['cleanupEnd' if cleanup else 'workEnd']

    def pause(self, seconds):
        assert seconds == 10
        self.now += seconds

    def save(self):
        path = self.root/'journal.json'; temp = self.root/'journal-next.json'
        entry.reserve(temp, self.cap.coordinator.j); os.replace(temp, path)

    def new_key(self):
        return {'name': self.ports.key_resource, 'uid': str(uuid.uuid4()), 'etag': 'etag/synthetic',
            'displayName': 'Signmons P08 '+self.plan['operationId'], 'restrictions': self.ports.key.RESTRICTIONS,
            'createTime': datetime.datetime.fromtimestamp(self.now, datetime.timezone.utc).isoformat().replace('+00:00','Z')}

    def response(self, value, status=200):
        reply = Reply(value, status); self.replies.append(reply); return reply

    def open(self, request, **kwargs):
        method, url = request.get_method(), request.full_url
        self.calls.append((method, url))
        if method == 'POST':
            self.current = self.new_key()
            if self.lost == 'create': raise OSError('PROVIDER_SECRET_CANARY')
            value = {'name': 'operations/create'}
            if self.initial_done['create'] is not None: value['done'] = self.initial_done['create']
            if value.get('done'): value['response'] = copy.deepcopy(self.current)
            return self.response(value)
        if method == 'DELETE':
            if not url.endswith('?etag=etag%2Fsynthetic'): raise AssertionError('etag mismatch')
            if self.lost == 'delete':
                self.current['deleteTime'] = '2026-01-01T00:00:00Z'
                raise OSError('PROVIDER_SECRET_CANARY')
            if self.lost == 'delete-active': raise OSError('PROVIDER_SECRET_CANARY')
            value = {'name': 'operations/delete'}
            if self.initial_done['delete'] is not None: value['done'] = self.initial_done['delete']
            if value.get('done'):
                self.current['deleteTime'] = '2026-01-01T00:00:00Z'; value['response'] = {}
            return self.response(value)
        if '/operations/' in url:
            kind = url.rsplit('/',1)[1]; self.polls[kind] += 1
            value = {'name': 'operations/'+(self.foreign or kind)}
            if self.error: value.update(done=True, error={'code': 13, 'message': 'PROVIDER_SECRET_CANARY'})
            elif self.polls[kind] >= self.complete[kind]:
                if kind == 'delete': self.current['deleteTime'] = '2026-01-01T00:00:00Z'
                value.update(done=True, response=copy.deepcopy(self.current) if kind == 'create' else {})
            return self.response(value)
        if self.current is None:
            return self.response({'error': {'status': 'NOT_FOUND', 'code': 404}}, 404)
        return self.response(copy.deepcopy(self.current))

    def transport(self): return patch.object(native_io.urllib.request, 'build_opener', return_value=self)
    def create(self):
        assert self.ports.key_get() == 'NOT_FOUND'
        return self.ports.key_create(self.ports.key_resource, self.ports.key.RESTRICTIONS)
    def cleanup(self): shutil.rmtree(self.root, ignore_errors=True)


class LifecycleTests(unittest.TestCase):
    def setUp(self):
        self.h = Harness(); self.addCleanup(self.h.cleanup)
        self.transport = self.h.transport(); self.transport.start(); self.addCleanup(self.transport.stop)

    def test_pending_missing_done_first_and_fifth_poll(self):
        for complete in (1, 5):
            with self.subTest(complete=complete):
                if complete == 5:
                    self.transport.stop(); self.h.cleanup(); self.h = Harness(); self.transport = self.h.transport(); self.transport.start(); self.addCleanup(self.h.cleanup); self.addCleanup(self.transport.stop)
                self.h.complete['create'] = complete
                created = self.h.create()
                self.assertEqual(self.h.polls['create'], complete)
                self.assertEqual(entry.read(self.h.root/'key-lifecycle-private.json')['phase'], 'CREATED')
                self.assertEqual(self.h.cap.coordinator.j['keyUidSha256'], __import__('hashlib').sha256(created['uid'].encode()).hexdigest())
                self.assertEqual(sum(method=='POST' for method,_ in self.h.calls), 1)
                self.assertTrue(all(r.closed for r in self.h.replies))

    def test_immediate_done_and_nullable_creation_time(self):
        self.h.initial_done['create'] = True
        original = self.h.new_key
        self.h.new_key = lambda: {k:v for k,v in original().items() if k!='createTime'}
        self.h.create(); receipt = self.h.ports._load_lifecycle()
        self.assertIsNone(receipt['createTime']); self.assertEqual(self.h.polls['create'], 0)

    def test_invalid_creation_time_never_persists_uid(self):
        original = self.h.new_key; self.h.new_key = lambda: {**original(), 'createTime': 'bad'}
        with self.assertRaisesRegex(Exception, 'KEY_CREATE_UNCONFIRMED'): self.h.create()
        self.assertIsNone(self.h.ports._load_lifecycle()['uid'])

    def test_poll_limit_retains_operation_and_recovery_finishes(self):
        self.h.complete['create'] = 6
        with self.assertRaisesRegex(Exception, 'KEY_CREATE_UNCONFIRMED'): self.h.create()
        self.assertEqual(self.h.polls['create'], 5)
        self.h.io.cleanup = True; self.h.cap.coordinator.j['unknown'] = ['KEY_CREATE']
        self.h.ports.recover_key()
        self.assertIsNotNone(self.h.cap.coordinator.j['keyUidSha256'])
        self.assertEqual(self.h.cap.coordinator.j['unknown'], [])
        self.assertEqual(sum(method=='POST' for method,_ in self.h.calls), 1)

    def test_dropped_post_stays_unowned_even_matching_metadata(self):
        self.h.lost = 'create'
        with self.assertRaisesRegex(Exception, 'KEY_CREATE_UNCONFIRMED'): self.h.create()
        self.assertEqual(self.h.ports._load_lifecycle()['phase'], 'INTENT')
        self.h.io.cleanup = True
        with self.assertRaisesRegex(Exception, 'KEY_CREATE_UNCONFIRMED'): self.h.ports.recover_key()
        self.assertIsNone(self.h.cap.coordinator.j['keyUidSha256'])
        self.assertEqual(self.h.cap.coordinator.j['keyUnownedObservation'], 'PRESENT')
        self.assertFalse(any(method=='DELETE' for method,_ in self.h.calls))

    def test_foreign_operation_and_error_do_not_grant_uid(self):
        self.h.foreign = 'foreign'
        with self.assertRaisesRegex(Exception, 'KEY_CREATE_UNCONFIRMED'): self.h.create()
        self.assertIsNone(self.h.ports._load_lifecycle()['uid'])
        self.h.io.cleanup = True
        with self.assertRaises(Exception): self.h.ports.recover_key()
        self.assertIsNone(self.h.cap.coordinator.j['keyUidSha256'])

    def test_terminal_create_error_not_adopted(self):
        self.h.error = True
        with self.assertRaisesRegex(Exception, 'KEY_CREATE_UNCONFIRMED'): self.h.create()
        self.h.io.cleanup = True
        with self.assertRaises(Exception): self.h.ports.recover_key()
        self.assertIsNone(self.h.cap.coordinator.j['keyUidSha256'])

    def test_create_replay_refused(self):
        self.h.create()
        with self.assertRaisesRegex(Exception, 'KEY_CREATE_UNCONFIRMED'):
            self.h.ports.key_create(self.h.ports.key_resource, self.h.ports.key.RESTRICTIONS)
        self.assertEqual(sum(method=='POST' for method,_ in self.h.calls), 1)

    def test_delete_final_read_after_lost_reply_no_retry(self):
        self.h.create(); self.h.io.cleanup=True; self.h.lost='delete'
        self.assertTrue(self.h.ports.key_delete(self.h.ports.owned_etag))
        self.assertEqual(self.h.ports._load_lifecycle()['phase'], 'DELETED')
        self.assertTrue(self.h.ports.key_delete(self.h.ports.owned_etag))
        self.assertEqual(sum(method=='DELETE' for method,_ in self.h.calls), 1)

    def test_lost_delete_active_remains_uncertain_no_retry(self):
        self.h.create(); self.h.io.cleanup=True; self.h.lost='delete-active'
        for _ in range(2):
            with self.assertRaisesRegex(Exception,'KEY_DELETE_UNCONFIRMED'):self.h.ports.key_delete(self.h.ports.owned_etag)
        self.assertEqual(sum(method=='DELETE' for method,_ in self.h.calls), 1)
        self.assertTrue(self.h.ports._load_lifecycle()['deleteIntent'])

    def test_delete_fifth_poll_and_uid_drift(self):
        self.h.create();self.h.io.cleanup=True;self.h.complete['delete']=5
        self.assertTrue(self.h.ports.key_delete(self.h.ports.owned_etag));self.assertEqual(self.h.polls['delete'],5)
        self.h.current['uid']=str(uuid.uuid4())
        with self.assertRaisesRegex(Exception,'KEY_DELETE_UNCONFIRMED'):self.h.ports.key_delete(self.h.ports.owned_etag)

    def test_corrupt_or_unfinished_receipt_refuses_recovery(self):
        self.h.create();self.h.io.cleanup=True
        path=self.h.root/'key-lifecycle-private.json';original=path.read_bytes()
        for field,value in [('sourceCommit','2'*40),('rootIdentity',[1,2]),('uid','wrong'),('phase','foreign')]:
            receipt=json.loads(original);receipt[field]=value;path.write_text(json.dumps(receipt))
            calls=len(self.h.calls)
            with self.assertRaises(Exception):self.h.ports.recover_key()
            self.assertEqual(len(self.h.calls),calls)
        path.write_bytes(original)
        entry.reserve(self.h.root/'key-lifecycle-private.json.next',{})
        with self.assertRaises(Exception):self.h.ports.recover_key()

    def test_atomic_interruption_before_publish_does_not_post(self):
        self.assertEqual(self.h.ports.key_get(),'NOT_FOUND')
        with patch.object(entry.os,'replace',side_effect=KeyboardInterrupt()):
            with self.assertRaises(KeyboardInterrupt):self.h.ports.key_create(self.h.ports.key_resource,self.h.ports.key.RESTRICTIONS)
        self.assertFalse(any(method=='POST' for method,_ in self.h.calls))
        self.assertTrue((self.h.root/'key-lifecycle-private.json.next').exists())

    def test_private_uid_survives_public_journal_save_interruption(self):
        self.h.initial_done['create']=True
        save=self.h.cap.coordinator.save
        def interrupted_save():
            if self.h.cap.coordinator.j['keyUidSha256'] is not None:raise KeyboardInterrupt()
            save()
        self.h.cap.coordinator.save=interrupted_save
        with self.assertRaises(KeyboardInterrupt):self.h.create()
        self.assertIsNotNone(self.h.ports._load_lifecycle()['uid'])
        self.h.cap.coordinator.save=save;self.h.cap.coordinator.j['keyUidSha256']=None;self.h.io.cleanup=True
        self.h.ports.recover_key();self.assertIsNotNone(self.h.cap.coordinator.j['keyUidSha256'])

    def test_retained_journal_and_receipt_exclude_secret_body(self):
        original=self.h.new_key
        self.h.new_key=lambda:{**original(),'keyString':'KEYSTRING_CANARY','providerError':'PROVIDER_SECRET_CANARY'}
        self.h.create()
        for path in self.h.root.iterdir():
            raw=path.read_text()
            for value in ('KEYSTRING_CANARY','PROVIDER_SECRET_CANARY','TOKEN_CANARY'):self.assertNotIn(value,raw)
        self.assertNotIn(self.h.current['uid'],(self.h.root/'journal.json').read_text())
        self.assertNotIn('operations/create',(self.h.root/'journal.json').read_text())

    def test_malformed_pending_shapes_and_foreign_poll_refuse(self):
        for initial in ({'name':'operations/test','done':None},
                        {'name':'operations/test','done':'false'},
                        {'name':'operations/test','done':0},
                        {'name':'operations/test','done':True},
                        {'name':'foreign','done':True,'response':{}}):
            with self.subTest(initial=initial), self.assertRaisesRegex(Exception,'KEY_OPERATION_UNCONFIRMED'):
                self.h.ports.operation(initial,'create')
        self.assertEqual(self.h.calls,[])

    def test_deadline_never_sends_poll_and_budget_stop_is_safe(self):
        self.h.now=self.h.times['workEnd']-5
        with self.assertRaisesRegex(Exception,'KEY_OPERATION_UNCONFIRMED'):
            self.h.ports.operation({'name':'operations/create'},'create')
        self.assertEqual(self.h.calls,[])

    def test_real_capability_budget_refuses_poll_before_http(self):
        self.h.cap.coordinator.j['nativeEntry']['calls']['https']=100
        with self.assertRaisesRegex(Exception,'KEY_OPERATION_UNCONFIRMED'):
            self.h.ports.operation({'name':'operations/create'},'create')
        self.assertEqual(self.h.calls,[])

    def test_combined_slow_create_delete_and_independent_read_budget(self):
        self.h.complete={'create':5,'delete':5}
        start=self.h.now;self.h.create();self.h.io.cleanup=True
        self.h.ports.recover_key()
        self.assertTrue(self.h.ports.key_delete(self.h.ports.owned_etag))
        # A fresh Ports instance reloads private state and verifies the same deleted UID.
        fresh=entry.Ports(self.h.cap,self.h.io,None,None);fresh.pause=self.h.pause
        fresh.recover_key();self.assertTrue(fresh.key_get()['deleted'])
        self.assertEqual(self.h.now-start,100)
        self.assertEqual(len(self.h.calls),15)
        self.assertLess(self.h.now,self.h.times['cleanupEnd'])
        self.assertLessEqual(len(self.h.calls),100)
        self.assertEqual(sum(method=='POST' for method,_ in self.h.calls),1)
        self.assertEqual(sum(method=='DELETE' for method,_ in self.h.calls),1)

    def test_real_capability_clock_rollback_refuses_before_request(self):
        self.h.cap.gate();self.h.now-=1
        with self.assertRaisesRegex(Exception,'CLOCK_ROLLBACK'):
            self.h.ports.operation({'name':'operations/create','done':True,'response':{}},'create')
        self.assertEqual(self.h.calls,[])

    def test_pending_create_and_absence_remains_unconfirmed(self):
        self.h.complete['create']=99
        with self.assertRaises(Exception):self.h.create()
        self.h.current=None;self.h.io.cleanup=True
        with self.assertRaises(Exception):self.h.ports.recover_key()
        self.assertIsNone(self.h.cap.coordinator.j['keyUidSha256'])
        self.assertFalse(any(method=='DELETE' for method,_ in self.h.calls))
        self.assertNotEqual(self.h.ports._load_lifecycle()['phase'],'DELETED')

    def test_interrupt_after_operation_publish_recovers_only_retained_operation(self):
        original=self.h.ports._save_lifecycle
        def save(value):
            original(value)
            if value['phase']=='CREATE_OPERATION':raise KeyboardInterrupt()
        with patch.object(self.h.ports,'_save_lifecycle',side_effect=save):
            with self.assertRaises(KeyboardInterrupt):self.h.create()
        self.assertEqual(self.h.ports._load_lifecycle()['phase'],'CREATE_OPERATION')
        self.assertIsNone(self.h.cap.coordinator.j['keyUidSha256'])
        self.h.io.cleanup=True;self.h.ports.recover_key()
        self.assertIsNotNone(self.h.cap.coordinator.j['keyUidSha256'])
        self.assertEqual(sum(method=='POST' for method,_ in self.h.calls),1)

    def test_stale_etag_and_foreign_metadata_refuse_mutation_or_success(self):
        self.h.create();self.h.io.cleanup=True
        with self.assertRaisesRegex(Exception,'KEY_DELETE_UNCONFIRMED'):
            self.h.ports.key_delete('wrong-etag')
        self.assertFalse(any(method=='DELETE' for method,_ in self.h.calls))
        original=copy.deepcopy(self.h.current)
        for field,value in [('uid','foreign'),('name','foreign'),('displayName','foreign'),('restrictions',{})]:
            with self.subTest(field=field):
                self.h.current={**original,field:value}
                with self.assertRaisesRegex(Exception,'KEY_METADATA_UNCONFIRMED'):self.h.ports.key_get()
        self.h.current=original

    def test_fresh_process_recovery_uses_private_operation_provenance(self):
        self.h.complete['create']=6
        with self.assertRaises(Exception):self.h.create()
        payload={'root':str(self.h.root),'plan':self.h.plan,'now':self.h.now,'current':self.h.current}
        script="""import json,sys
from test_key_lifecycle import Harness
v=json.load(sys.stdin);h=Harness(v['root'],v['plan'],v['now']);h.current=v['current'];h.io.cleanup=True
with h.transport():
 h.ports.recover_key()
 assert h.ports.key_delete(h.ports.owned_etag)
print('RECOVERED_AND_DELETED')
"""
        result=subprocess.run([sys.executable,'-c',script],input=json.dumps(payload),text=True,capture_output=True,cwd=Path(__file__).parent)
        self.assertEqual(result.returncode,0,result.stderr);self.assertEqual(result.stdout.strip(),'RECOVERED_AND_DELETED')
        self.assertEqual(self.h.ports._load_lifecycle()['phase'],'DELETED')


if __name__=='__main__':unittest.main()
