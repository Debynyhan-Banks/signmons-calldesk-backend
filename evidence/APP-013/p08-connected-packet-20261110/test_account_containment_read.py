"""CT2 injected transport proof; never performs a credential or provider read."""
import copy
import json
import os
from pathlib import Path
import tempfile
import time
import unittest
from unittest.mock import patch
import account_containment_read as r
from test_account_containment import fixture, OP


def coordinate(d):
    for index in range(5):
        d.step(index)


class Fake:
    def __init__(self, db, user, fail=None):
        self.db, self.user, self.fail = db, user, fail
        self.calls = []
        self.closed = 0
    def cli(self, descriptor, deadline):
        name = descriptor['id']; self.calls.append(name)
        if self.fail == name: raise RuntimeError('SECRET_SENTINEL')
        if name == 'owner': return json.dumps([{'account':r.m.OWNER,'status':'ACTIVE'}]).encode()
        if name == 'project': return b'{}'
        return {'accessToken':'SECRET_SENTINEL_' * 3}
    def sql(self, descriptor, password, deadline):
        name = descriptor['id']; self.calls.append(name)
        if self.fail == name: raise RuntimeError('SECRET_SENTINEL')
        return json.dumps(self.db if name == 'qualification' else {'sessionsAbsent':True}).encode()
    def https(self, descriptor, token, deadline):
        self.calls.append('firebase')
        if self.fail == 'firebase': raise RuntimeError('SECRET_SENTINEL')
        return {'status':200,'body':json.dumps({'users':[self.user]}).encode()}
    def close(self, deadline):
        self.closed += 1
        return self.fail != 'close'


class Composition(unittest.TestCase):
    def execute(self, fail=None, mutate=None, coordinator=coordinate):
        target, db, user = fixture()
        target = copy.deepcopy(target)
        if mutate: mutate(db, user)
        main, cleanup = Fake(db, user, fail), Fake(db, user, 'closeout' if fail == 'cleanup' else None)
        self.main, self.cleanup = main, cleanup
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)/'receipt'
            s = {'operationId':OP,'configSha256':'config'}
            journal = r.k.Journal(root,s,create=True)
            t = {'readEnd':time.time()+60,'cleanupEnd':time.time()+120,'purgeEnd':time.time()+180}
            # Synthetic project/target fixture only; public CT1 remains actual validator.
            with patch.object(r.q,'TARGET_SHA256',r.c.target_digest(target)), \
                 patch.object(r.q,'validate_recovery_project',return_value=True):
                result = r.run(s,t,journal,'SECRET_SENTINEL',factory=iter([main,cleanup]).__next__,
                               coordinate=coordinator,source_guard=lambda _:None,config=lambda:'config')
            retained = ''.join(path.read_text() for path in root.iterdir())
            self.assertNotIn('SECRET_SENTINEL',retained)
            self.assertNotIn(target['id'],retained)
            self.assertTrue(result['privateReferencesCleared'])
            return result

    def test_complete_actual_validator(self):
        self.assertEqual(self.execute()['status'],'CURRENT_CONTAINMENT_CONFIRMED')
        self.assertEqual(self.main.calls,['owner','project','token','qualification','firebase'])
        self.assertEqual(self.cleanup.calls,['closeout'])
        self.assertEqual((self.main.closed,self.cleanup.closed),(1,1))

    def test_every_failure_independent_cleanup(self):
        for failure in ('owner','project','token','qualification','firebase','close','cleanup'):
            with self.subTest(failure=failure):
                self.assertEqual(self.execute(failure)['status'],'CURRENT_CONTAINMENT_UNKNOWN')
                self.assertEqual(self.cleanup.calls,['closeout'])
                self.assertEqual(self.cleanup.closed,1)

    def test_foreign_account_stops_before_firebase(self):
        self.assertEqual(self.execute(mutate=lambda db,u: db['operator'].update(id=OP))['status'],'CURRENT_CONTAINMENT_UNKNOWN')
        self.assertNotIn('firebase',self.main.calls)

    def test_stale_and_disabled_and_sessions(self):
        for change in (lambda db,u:u.update(validSince='1'),lambda db,u:u.update(disabled=False),
                       lambda db,u:db.update(sessionCount=1)):
            self.assertEqual(self.execute(mutate=change)['status'],'CURRENT_CONTAINMENT_UNKNOWN')

    def test_interrupt_and_lost_response(self):
        for exception in (KeyboardInterrupt,SystemExit,RuntimeError):
            def interrupted(d):
                d.step(0)
                raise exception('SECRET_SENTINEL')
            self.assertEqual(self.execute(coordinator=interrupted)['status'],'CURRENT_CONTAINMENT_UNKNOWN')
            self.assertEqual(self.cleanup.calls,['closeout'])

    def test_replay_step_denied(self):
        def repeat(d):
            d.step(0);d.step(0)
        self.assertEqual(self.execute(coordinator=repeat)['status'],'CURRENT_CONTAINMENT_UNKNOWN')
        self.assertEqual(self.main.calls,['owner'])

    def test_real_coordinator_process(self):
        self.assertEqual(self.execute(coordinator=r.k.coordinator)['status'],'CURRENT_CONTAINMENT_CONFIRMED')

    def test_reservation_and_concurrent_lease(self):
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder)/'receipt';s={'operationId':OP}
            r.k.Journal(root,s,create=True)
            with self.assertRaises(FileExistsError):r.k.Journal(root,s,create=True)
            with r.k.lease(Path(folder)/'lease'):
                with self.assertRaises(Exception):
                    with r.k.lease(Path(folder)/'lease'):pass

    def test_transport_original_bytes_and_duplicate_rejection(self):
        io = r.Transport(time.time,OP)
        for raw in (b'{"operator":1,"operator":2}', b'NaN', b'{'):
            with patch.object(r.q.NativeIO,'_owned_run',return_value=raw):
                with self.assertRaises(Exception):io.sql(r.q.sql_contract()[0],'SYNTHETIC',time.time()+30)
            self.assertIsNone(io._sql_raw);self.assertFalse(io._capture_sql)
        raw=b'{ "sessionsAbsent" : true }'
        with patch.object(r.q.NativeIO,'_owned_run',return_value=raw) as call:
            self.assertEqual(io.sql(r.q.sql_contract()[1],'SYNTHETIC',time.time()+30),raw)
            self.assertEqual(call.call_count,1)
        self.assertIsNone(io._sql_raw)
        self.assertTrue(io.close(time.time()+2))

    def test_child_exit_still_closes_sessions(self):
        with patch.object(r.k, 'COORDINATOR', 'raise SystemExit(9)'):
            self.assertEqual(self.execute(coordinator=r.k.coordinator)['status'], 'CURRENT_CONTAINMENT_UNKNOWN')
        self.assertEqual(self.cleanup.calls, ['closeout'])

    def test_main_deadline_and_source_failure_do_not_skip_cleanup(self):
        def expired(d):
            d.times['readEnd'] = d.clock() - 1
            d.step(0)
        def drift(d):
            d.guard = lambda _: (_ for _ in ()).throw(RuntimeError('SECRET_SENTINEL'))
            d.step(0)
        for callback in (expired, drift):
            self.assertEqual(self.execute(coordinator=callback)['status'], 'CURRENT_CONTAINMENT_UNKNOWN')
            self.assertEqual(self.main.calls, [])
            self.assertEqual(self.cleanup.calls, ['closeout'])

    def test_wrong_owner_prevents_token_and_sql(self):
        original = Fake.cli
        def wrong(io, descriptor, deadline):
            if descriptor['id'] == 'owner':
                io.calls.append('owner')
                return b'[{"account":"foreign","status":"ACTIVE"}]'
            return original(io, descriptor, deadline)
        with patch.object(Fake, 'cli', wrong):
            self.assertEqual(self.execute()['status'], 'CURRENT_CONTAINMENT_UNKNOWN')
        self.assertEqual(self.main.calls, ['owner'])

    def test_cleanup_numeric_true_is_not_confirmation(self):
        original = Fake.sql
        def wrong(io, descriptor, password, deadline):
            if descriptor['id'] == 'closeout':
                io.calls.append('closeout')
                return b'{"sessionsAbsent":1}'
            return original(io, descriptor, password, deadline)
        with patch.object(Fake, 'sql', wrong):
            self.assertEqual(self.execute()['status'], 'CURRENT_CONTAINMENT_UNKNOWN')

    def test_authority_exact_scope_expiry_and_no_guard_bypass(self):
        now = time.time()
        def iso(offset):
            return r.k.datetime.datetime.fromtimestamp(now+offset, r.k.datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')
        scope = dict(action=r.ACTION, operationId=OP, sourceCommit='a'*40,
                     manifestSha256='b'*64, configSha256='c'*64, limits=dict(r.LIMITS),
                     sdkException=r.EXCEPTION, commands=r.commands(),
                     window={n:iso(v) for n,v in [('start',-1),('cutoff',30),('readEnd',60),('cleanupEnd',120),('purgeEnd',180)]})
        decision = dict(decision='APPROVE_CT2_READS_AND_INDEPENDENT_CLEANUP',
                        operationId=OP, scopeSha256=r.m.digest(scope), externalReadAuthorized=True,
                        independentCleanupAuthorized=True, sdkException=r.EXCEPTION, paymentAuthorized=False)
        raw = json.dumps(decision).encode()
        envelope = dict(scope=scope, decision=dict(commit='d'*40,
                        path='APP013_P08_CT2_EXTERNAL_20261115_11111111.json', sha256=r.m.digest(raw)))
        guards=[]
        r.authorize(envelope,now,read=lambda *args:raw,source_guard=guards.append)
        self.assertEqual(len(guards),1)
        with self.assertRaises(Exception):r.authorize(envelope,now+40,read=lambda *args:raw,source_guard=guards.append)
        for field in ('externalReadAuthorized','independentCleanupAuthorized','paymentAuthorized'):
            bad=dict(decision);bad[field]=int(bad[field]);body=json.dumps(bad).encode()
            modified=copy.deepcopy(envelope);modified['decision']['sha256']=r.m.digest(body)
            with self.assertRaises(Exception):r.authorize(modified,now,read=lambda *args:body,source_guard=guards.append)
        self.assertEqual(len(guards),1)

    def test_native_entry_requires_ready_before_hidden_input(self):
        scope = dict(operationId=OP, configSha256='config')
        times = dict(cutoff=time.time()+60)
        with tempfile.TemporaryDirectory() as folder:
            original_journal = r.k.Journal
            with patch.object(r.k.inv, 'read', return_value={}), \
                 patch.object(r, 'authorize', return_value=(scope,times)), \
                 patch.object(r.k, 'configuration', return_value='config'), \
                 patch.object(r.k, 'sandbox_check'), \
                 patch.object(r.k, 'Journal', side_effect=lambda root,s,create: original_journal(Path(folder)/'receipt',s,create)), \
                 patch('builtins.input', return_value='NOT READY'), \
                 patch.object(r.q, 'recovery_password', side_effect=AssertionError('NO_PASSWORD')) as password, \
                 patch.object(r, 'Transport', side_effect=AssertionError('NO_PROVIDER')) as transport:
                with self.assertRaises(Exception):r.native_main(['--run', str(Path(folder)/'envelope')])
                password.assert_not_called();transport.assert_not_called()

    def test_raw_sql_keeps_existing_tls_command_and_clears_capture(self):
        captured = {}
        def process(io, argv, env, deadline, **kwargs):
            captured.update(argv=list(argv),env=dict(env))
            return b'{"sessionsAbsent":true}'
        io = r.Transport(time.time,OP)
        with patch.object(r.q.NativeIO, '_owned_run', process):
            io.sql(r.q.sql_contract()[1], 'SYNTHETIC', time.time()+30)
        self.assertEqual(captured['env']['PGSSLMODE'],'verify-full')
        self.assertEqual(captured['env']['PGSSLROOTCERT'],'/etc/ssl/cert.pem')
        self.assertEqual(captured['env']['PGAPPNAME'],'signmons_p08_qualification_'+OP.replace('-',''))
        self.assertEqual(captured['argv'][-1],r.q.CLOSEOUT_SQL)
        self.assertIsNone(io._sql_raw)
        captured.clear()

    def test_no_external_entry_without_approval(self):
        with patch.object(r,'Transport',side_effect=AssertionError('NO_NATIVE')):
            with self.assertRaises(Exception):r.authorize({'scope':{},'decision':{}},time.time())


if __name__=='__main__':unittest.main()
