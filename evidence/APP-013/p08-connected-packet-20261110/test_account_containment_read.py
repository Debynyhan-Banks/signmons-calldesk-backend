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



class CT3Fake:
    def __init__(self, shared, kind):
        self.s, self.kind = shared, kind
        self.closed = 0
    def cli(self, descriptor, deadline):
        self.s['calls'].append(descriptor['id'])
        if self.s.get('fail') == descriptor['id']:
            raise RuntimeError('SECRET_SENTINEL')
        if descriptor['id'] == 'owner':
            return json.dumps([{'account': r.m.OWNER, 'status': 'ACTIVE'}]).encode()
        if descriptor['id'] == 'project':
            return b'{}'
        return {'accessToken': 'SECRET_SENTINEL_' * 3}
    def sql(self, descriptor, password, deadline):
        name = descriptor['id']; self.s['calls'].append(name)
        if self.s.get('fail') == name:
            raise RuntimeError('SECRET_SENTINEL')
        if name == 'ct3_account':
            return json.dumps(self.s['db']).encode()
        target = dict(self.s['db']['operator'])
        if self.s.get('final_active'):
            target['status'] = 'ACTIVE'
        return json.dumps({'operatorCount': 1, 'operator': target,
                           'sessionsAbsent': not self.s.get('final_sessions', False)}).encode()
    def https(self, descriptor, token, deadline):
        phase = 'revoke' if descriptor['id'] == 'ct3_revoke' else 'firebase_' + self.kind
        self.s['calls'].append(phase)
        if phase == 'revoke':
            self.s['user']['validSince'] = descriptor['body']['validSince']
            if self.s.get('fail') == 'lost_revoke':
                raise RuntimeError('SECRET_SENTINEL')
        if self.s.get('fail') == phase:
            return {'status': 403, 'body': b'SECRET_SENTINEL'}
        user = dict(self.s['user'])
        if self.kind == 'firebase_final' and self.s.get('final_decrease'):
            user['validSince'] = str(r.c.R51_POLICY_SECOND)
        return {'status': 200, 'body': json.dumps({'users': [user]}).encode()}
    def endpoint(self, phase, key, endpoint_id, deadline, times, gate):
        gate(phase == 'VERIFY')
        self.s['calls'].append(phase)
        if phase == 'DISABLE':
            self.s['enabled'] = False
            if self.s.get('fail') == 'lost_disable':
                raise RuntimeError('SECRET_SENTINEL')
        if self.s.get('fail') == phase:
            raise RuntimeError('SECRET_SENTINEL')
        return {'status': 'ENDPOINT_OBSERVED', 'phase': phase, 'code': 'NONE', 'requests': 1,
                'httpStatus': 200, 'scope': 'MATCH', 'state': 'ENABLED' if self.s['enabled'] else 'DISABLED'}
    def endpoint_closed(self):
        return self.s.get('fail') != 'child_close'
    def close(self, deadline):
        self.closed += 1
        return self.s.get('fail') != 'close_' + self.kind


class CT3Composition(unittest.TestCase):
    def execute(self, change=None, coordinate_fn=coordinate, source_guard=lambda _: None):
        target, db, user = fixture()
        user['validSince'] = str(r.c.R51_POLICY_SECOND + 1)
        shared = {'db': db, 'user': user, 'enabled': False, 'calls': []}
        if change:
            change(shared)
        self.shared, self.transports = shared, []
        names = iter(['main', 'firebase_final', 'endpoint_final', 'sql_final'])
        def factory():
            io = CT3Fake(shared, next(names)); self.transports.append(io); return io
        with tempfile.TemporaryDirectory() as folder:
            scope = {'operationId': OP, 'configSha256': 'config'}
            journal = r.k.Journal(Path(folder)/'receipt', scope, create=True)
            now = time.time()
            times = {'readEnd': now + 90, 'cleanupEnd': now + 180, 'purgeEnd': now + 190}
            with patch.object(r.q, 'TARGET_SHA256', r.c.target_digest(target)), \
                 patch.object(r, 'ENDPOINT_SHA256', r.m.digest(b'we_synthetic')), \
                 patch.object(r.q, 'validate_recovery_project', return_value=True):
                result = r.run_ct3(scope, times, journal, 'SECRET_SENTINEL', 'sk_test_' + 'a'*24, 'we_synthetic',
                    factory=factory, coordinate=coordinate_fn, source_guard=source_guard, config=lambda: 'config')
            self.receipts = {p.name: json.loads(p.read_text()) for p in journal.root.iterdir()}
            retained = json.dumps(self.receipts)
            for secret in ('SECRET_SENTINEL', target['id'], 'sk_test_', 'we_synthetic'):
                self.assertNotIn(secret, retained)
            self.assertTrue(result['privateReferencesCleared'])
            self.assertTrue(all(io.closed == 1 for io in self.transports))
            return result

    def test_already_contained_no_mutation_and_exact_calls(self):
        result = self.execute()
        self.assertEqual(result['status'], 'CURRENT_CONTAINMENT_CONFIRMED')
        self.assertFalse(result['revocationAttempted']); self.assertFalse(result['endpointDisableAttempted'])
        self.assertEqual(self.shared['calls'], ['owner', 'project', 'token', 'ct3_account', 'firebase_main',
            'OBSERVE', 'firebase_firebase_final', 'VERIFY', 'ct3_closeout'])
        self.assertEqual(set(self.receipts), {*(f'main-{i}.json' for i in range(6)),
            'cleanup-0.json', 'cleanup-1.json', 'cleanup-3.json', 'result.json'})

    def test_both_conditional_changes_and_distinct_reservations(self):
        def both(s):
            s['user']['validSince'] = '1'; s['enabled'] = True
        result = self.execute(both)
        self.assertEqual(result['status'], 'CURRENT_CONTAINMENT_CONFIRMED')
        self.assertTrue(result['revocationAttempted']); self.assertTrue(result['endpointDisableAttempted'])
        self.assertEqual(self.shared['calls'].count('revoke'), 1)
        self.assertEqual(self.shared['calls'].count('DISABLE'), 1)
        self.assertIn('cleanup-2.json', self.receipts); self.assertIn('main-6.json', self.receipts)
        self.assertGreaterEqual(self.receipts['cleanup-2.json']['requestedValidSince'], r.c.R51_POLICY_SECOND)

    def test_lost_ack_final_read_without_mutation_retry(self):
        for failure in ('lost_revoke', 'lost_disable'):
            def change(s):
                s.update(fail=failure, enabled=True); s['user']['validSince'] = '1'
            with self.subTest(failure=failure):
                result = self.execute(change)
                self.assertEqual(result['status'], 'CURRENT_CONTAINMENT_CONFIRMED')
                self.assertIn('FIREBASE_UPDATE' if failure == 'lost_revoke' else 'ENDPOINT_DISABLE', result['failures'])
                self.assertEqual(self.shared['calls'].count('revoke'), 1)
                self.assertEqual(self.shared['calls'].count('DISABLE'), 1)
                self.assertIn('VERIFY', self.shared['calls']); self.assertIn('ct3_closeout', self.shared['calls'])

    def test_final_account_active_or_sessions_or_decreased_cutoff_refuse(self):
        for flag in ('final_active', 'final_sessions', 'final_decrease'):
            result = self.execute(lambda s: s.update({flag: True}))
            self.assertEqual(result['status'], 'CURRENT_CONTAINMENT_UNKNOWN')

    def test_account_failure_does_not_erase_endpoint_observation(self):
        result = self.execute(lambda s: s.update(fail='firebase_main'))
        self.assertEqual(result['endpointFinal']['state'], 'DISABLED')
        self.assertIn('ct3_closeout', self.shared['calls'])
        self.assertNotIn('revoke', self.shared['calls'])

    def test_wrong_initial_identity_or_disabled_blocks_update(self):
        for change in (lambda s: s['user'].update(disabled=False, validSince='1'),
                       lambda s: s['user'].update(localId=OP, validSince='1'),
                       lambda s: s['db'].update(sessionCount=1)):
            result = self.execute(change)
            self.assertNotIn('revoke', self.shared['calls'])
            self.assertFalse(result['revocationAttempted'])

    def test_every_read_failure_reaches_other_independent_observations(self):
        for phase in ('owner', 'project', 'token', 'ct3_account', 'OBSERVE', 'VERIFY', 'ct3_closeout'):
            with self.subTest(phase=phase):
                result = self.execute(lambda s: s.update(fail=phase))
                self.assertIn('ct3_closeout', self.shared['calls'])
                self.assertIn('VERIFY', self.shared['calls'])
                if phase in ('owner', 'project', 'token', 'ct3_account', 'VERIFY', 'ct3_closeout'):
                    self.assertEqual(result['status'], 'CURRENT_CONTAINMENT_UNKNOWN')

    def test_source_drift_denies_new_provider_actions_but_closes(self):
        count = 0
        def guard(_):
            nonlocal count
            count += 1
            if count > 1:
                raise RuntimeError('SECRET_SENTINEL')
        result = self.execute(source_guard=guard)
        self.assertEqual(result['status'], 'CURRENT_CONTAINMENT_UNKNOWN')
        self.assertEqual(self.shared['calls'], ['owner'])
        self.assertTrue(result['processCleanupVerified'])

    def test_child_group_unknown_blocks_final_worker(self):
        result = self.execute(lambda s: s.update(fail='child_close'))
        self.assertNotIn('VERIFY', self.shared['calls'])
        self.assertEqual(result['status'], 'CURRENT_CONTAINMENT_UNKNOWN')

    def test_early_interrupt_still_attempts_closeout(self):
        def interrupt(d):
            d.step(0); raise KeyboardInterrupt('SECRET_SENTINEL')
        result = self.execute(coordinate_fn=interrupt)
        self.assertIn('ct3_closeout', self.shared['calls'])
        self.assertEqual(result['status'], 'CURRENT_CONTAINMENT_UNKNOWN')

    def test_main_expiry_does_not_expire_independent_reserve(self):
        def expire(d):
            coordinate(d); d.times['readEnd'] = d.clock()-1
        result = self.execute(coordinate_fn=expire)
        self.assertIn('VERIFY', self.shared['calls']); self.assertIn('ct3_closeout', self.shared['calls'])
        self.assertIn('ENDPOINT_INITIAL', result['failures'])

    def test_real_fixed_coordinator_compatible(self):
        self.assertEqual(self.execute(coordinate_fn=r.k.coordinator)['status'], 'CURRENT_CONTAINMENT_CONFIRMED')

    def test_cleanup_failure_preserves_other_final_observations(self):
        result = self.execute(lambda s: s.update(fail='close_main'))
        self.assertFalse(result['processCleanupVerified'])
        self.assertEqual(result['endpointFinal']['state'], 'DISABLED')
        self.assertEqual(result['status'], 'CURRENT_CONTAINMENT_UNKNOWN')


class CT3Boundaries(unittest.TestCase):
    def scope(self):
        now = time.time()
        def iso(offset):
            return r.k.datetime.datetime.fromtimestamp(now+offset, r.k.datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')
        scope = dict(action=r.CT3_ACTION, operationId=OP, sourceCommit='a'*40,
            manifestSha256='b'*64, configSha256='c'*64, limits=dict(r.CT3_LIMITS), sdkException=r.EXCEPTION,
            commands=r.commands(), policy=r.ct3_policy(), resources=r.ct3_resources(),
            window={n: iso(v) for n, v in [('start', -1), ('cutoff', 60), ('readEnd', 160), ('cleanupEnd', 260), ('purgeEnd', 270)]})
        decision = dict(decision=r.CT3_DECISION, operationId=OP, scopeSha256=r.m.digest(scope),
            externalReadAuthorized=True, conditionalRevocationAuthorized=True, conditionalEndpointDisableAuthorized=True,
            independentCleanupAuthorized=True, noOverlappingOperationConfirmed=True, sdkException=r.EXCEPTION, paymentAuthorized=False)
        return scope, decision, now
    def envelope(self, scope, decision):
        raw = json.dumps(decision).encode()
        return dict(scope=scope, decision=dict(commit='d'*40, path='APP013_P08_CT3_EXTERNAL_20261115_11111111.json',
                   sha256=r.m.digest(raw))), raw
    def test_exact_authority_and_all_gates(self):
        scope, decision, now = self.scope(); envelope, raw = self.envelope(scope, decision)
        guards=[]
        r.authorize_ct3(envelope, now, read=lambda *_: raw, source_guard=guards.append)
        self.assertEqual(len(guards), 1)
        for key, value in decision.items():
            if type(value) is bool:
                bad = dict(decision); bad[key] = int(value)
                e, body = self.envelope(scope, bad)
                with self.assertRaises(Exception):
                    r.authorize_ct3(e, now, read=lambda *_: body, source_guard=guards.append)
        for field in ('policy', 'resources', 'limits', 'commands', 'action'):
            bad = copy.deepcopy(scope); bad[field] = None
            with self.assertRaises(Exception):
                r.authorize_ct3(dict(envelope, scope=bad), now, read=lambda *_: raw, source_guard=guards.append)
        for at in (now-100, now+80):
            with self.assertRaises(Exception):
                r.authorize_ct3(envelope, at, read=lambda *_: raw, source_guard=guards.append)
        with self.assertRaises(Exception):r.authorize(envelope, now, read=lambda *_: raw, source_guard=guards.append)
        self.assertEqual(len(guards), 1)

    def test_cleanup_time_reserve_and_boolean_limit_refused(self):
        scope, decision, now = self.scope()
        for mutate in (lambda s:s['window'].update(cleanupEnd=s['window']['readEnd']),
                       lambda s:s['limits'].update(cache=False),
                       lambda s:s['policy'].update(minimumValidSince=r.c.R51_POLICY_SECOND-1)):
            bad = copy.deepcopy(scope); mutate(bad); envelope, raw = self.envelope(bad, decision)
            with self.assertRaises(Exception):r.authorize_ct3(envelope, now, read=lambda *_:raw, source_guard=lambda _:None)

    def test_strict_endpoint_parent_output(self):
        import subprocess
        value = {'status':'ENDPOINT_OBSERVED','phase':'VERIFY','code':'NONE','requests':1,'httpStatus':200,'scope':'MATCH','state':'DISABLED'}
        def result(v=value, code=0, err=''):
            return subprocess.CompletedProcess([], code, json.dumps(v), err)
        self.assertEqual(r.endpoint_result(result(), 'VERIFY'), value)
        for mutate in (lambda v:v.update(private='SECRET_SENTINEL'), lambda v:v.update(requests=True),
                       lambda v:v.update(httpStatus=True), lambda v:v.update(scope='DRIFT'),
                       lambda v:v.update(state='UNKNOWN'), lambda v:v.update(code='private'),
                       lambda v:v.update(phase='DISABLE')):
            bad=dict(value);mutate(bad)
            with self.assertRaises(Exception):r.endpoint_result(result(bad), 'VERIFY')
        for raw in ('{"phase":"VERIFY","phase":"OBSERVE"}', 'NaN', '{'):
            with self.assertRaises(Exception):r.endpoint_result(subprocess.CompletedProcess([],0,raw,''), 'VERIFY')
        with self.assertRaises(Exception):r.endpoint_result(result(err='SECRET_SENTINEL'), 'VERIFY')
        with self.assertRaises(Exception):r.endpoint_result(result(code=2), 'VERIFY')

    def test_ct3_sql_actual_allowlist_environment_and_raw_contract(self):
        io = r.CT3Transport(time.time, OP); captured={}
        def owned(_io, argv, env, deadline, **_kwargs):
            captured.update(argv=argv, env=dict(env)); return b'{"operatorCount":0,"operator":null,"sessionsAbsent":true}'
        with patch.object(r.q.NativeIO, '_owned_run', owned):
            for descriptor in r.ct3_sql_contract():
                self.assertIsInstance(io.sql(descriptor,'SECRET_SENTINEL',time.time()+30),bytes)
                self.assertEqual(captured['argv'][-1],descriptor['sql'])
                self.assertEqual(captured['env']['PGSSLMODE'],'verify-full')
                self.assertEqual(captured['env']['PGSSLROOTCERT'],'/etc/ssl/cert.pem')
                self.assertTrue(all(name in descriptor['sql'] for name in
                    [f'p08-{kind}-{r.c.R51_OPERATION}' for kind in ('auth','runtime','probe')]))
            with self.assertRaises(Exception):io.sql(r.q.sql_contract()[1],'SECRET_SENTINEL',time.time()+30)
        for raw in (b'{"a":1,"a":2}',b'NaN',b'\xff'):
            with patch.object(r.q.NativeIO, '_owned_run', return_value=raw):
                with self.assertRaises(Exception):io.sql(r.ct3_sql_contract()[1],'SECRET_SENTINEL',time.time()+30)
        self.assertIsNone(io._sql_raw);self.assertFalse(io._capture_sql)
        self.assertTrue(io.close(time.time()+2))

    def test_exact_update_http_boundary_no_retry_and_close(self):
        io = r.CT3Transport(time.time, OP)
        class Response:
            status=200
            closed=False
            def read(self,size):return b'{"localId":"private"}'
            def close(self):self.closed=True
        response=Response(); calls=[]
        def open_request(request, timeout):
            calls.append(request);return response
        with patch.object(r.q.urllib.request,'build_opener',return_value=r.SimpleNamespace(open=open_request)):
            out=io.https(r.revoke_descriptor('22222222-2222-4222-8222-222222222222',r.c.R51_POLICY_SECOND),
                         'SECRET_SENTINEL_'*3,time.time()+30)
            self.assertEqual(out['status'],200);self.assertEqual(len(calls),1);self.assertTrue(response.closed)
            self.assertEqual(json.loads(calls[0].data),{'localId':'22222222-2222-4222-8222-222222222222','validSince':str(r.c.R51_POLICY_SECOND)})
            for change in (lambda d:d.update(url='https://wrong.invalid'),lambda d:d['body'].update(disableUser=True)):
                bad=r.revoke_descriptor('22222222-2222-4222-8222-222222222222',r.c.R51_POLICY_SECOND);change(bad)
                with self.assertRaises(Exception):io.https(bad,'SECRET_SENTINEL_'*3,time.time()+30)
            self.assertEqual(len(calls),1)
        self.assertTrue(io.close(time.time()+2))

    def test_real_endpoint_child_rejects_private_input_before_provider(self):
        io=r.CT3Transport(time.time, OP)
        times={'cleanupEnd':time.time()+20}
        result=io.endpoint('OBSERVE','sk_live_'+'a'*24,'we_foreign',time.time()+10,times,lambda _:None)
        self.assertEqual(result['status'],'ENDPOINT_REFUSED');self.assertEqual(result['requests'],0)
        self.assertTrue(io.endpoint_closed());self.assertTrue(io.close(time.time()+2))

    def test_ready_refusal_prevents_all_hidden_inputs_and_provider(self):
        scope={'operationId':OP,'configSha256':'config'};times={'cutoff':time.time()+60}
        with tempfile.TemporaryDirectory() as folder:
            original=r.k.Journal
            with patch.object(r.k.inv,'read',return_value={}), patch.object(r,'authorize_ct3',return_value=(scope,times)), \
                 patch.object(r.k,'configuration',return_value='config'),patch.object(r.k,'sandbox_check'), \
                 patch.object(r.k,'Journal',side_effect=lambda root,s,create:original(Path(folder)/'receipt',s,create)), \
                 patch('builtins.input',return_value='NOT READY'),patch.object(r.q,'recovery_password') as password, \
                 patch.object(r,'ct3_hidden') as hidden,patch.object(r,'CT3Transport') as native:
                with self.assertRaises(Exception):r.native_main_ct3(['--run-ct3',str(Path(folder)/'envelope')])
                password.assert_not_called();hidden.assert_not_called();native.assert_not_called()


# Reuse the existing canonical-schema disposable TLS cluster; no Neon/provider access.
import importlib.util as _ct3_importlib
import subprocess as _ct3_subprocess

_ct3_tls_path = r.HERE.parent / 'p08-real-client-binding-local-20261031/source/test_bound_postgres.py'
_ct3_tls_spec = _ct3_importlib.spec_from_file_location('ct3_existing_owned_tls_fixture', _ct3_tls_path)
_ct3_tls = _ct3_importlib.module_from_spec(_ct3_tls_spec)
_ct3_tls_spec.loader.exec_module(_ct3_tls)


class CT3DisposableTLS(_ct3_tls.BoundPostgreSQL):
    R51_APPLICATIONS = (
        'p08-auth-cc2c1ce5-640f-41f4-a993-31063630207c',
        'p08-runtime-cc2c1ce5-640f-41f4-a993-31063630207c',
        'p08-probe-cc2c1ce5-640f-41f4-a993-31063630207c',
    )

    @classmethod
    def tearDownClass(cls):
        scratch = Path(cls.temp.name)
        super().tearDownClass()
        assert cls.server.poll() is not None and not scratch.exists()
        print(json.dumps({'status':'CT3_TLS_CLEANUP_VERIFIED','serverReaped':True,
                          'scratchAbsent':True,'providerCalls':0}))

    def setUp(self):
        super().setUp()
        raw = json.loads(self.command('SELECT row_to_json(u) FROM (SELECT id,"tenantId",email,"fullName",role::text,status::text FROM "User") u;'))
        self.target = {key:raw[key] for key in ('id','tenantId','email','fullName','role','status')}
        self.target_patch = patch.object(r.q, 'TARGET_SHA256', r.c.target_digest(self.target))
        self.target_patch.start()
        self.addCleanup(self.target_patch.stop)
        self.transport_calls = []

    def transport(self, *, trusted=True):
        case = self
        class LocalTransport(r.CT3Transport):
            def _owned_run(obj, argv, env, deadline, **kwargs):
                contracts = r.ct3_sql_contract()
                case.assertEqual(argv[0], r.q._operator_module().PSQL)
                case.assertIn(argv[-1], [item['sql'] for item in contracts])
                case.assertEqual(argv[argv.index('-h')+1], r.q._operator_module().DB_HOST)
                case.assertEqual(argv[argv.index('-U')+1], 'neondb_owner')
                case.assertEqual(argv[argv.index('-d')+1], 'neondb')
                case.assertEqual(env['PGSSLMODE'], 'verify-full')
                case.assertEqual(env['PGSSLROOTCERT'], '/etc/ssl/cert.pem')
                case.assertNotIn('SYNTHETIC_CT3_PASSWORD', ' '.join(argv))
                case.assertEqual(env['PGPASSWORD'], 'SYNTHETIC_CT3_PASSWORD')
                local_argv = list(argv)
                local_argv[local_argv.index('-h')+1] = '127.0.0.1'
                local_argv[1:1] = ['-p', case.port]
                local_env = dict(env)
                if trusted:
                    local_env['PGSSLROOTCERT'] = str(case.cert)
                case.transport_calls.append(argv[-1])
                # Only fixture host/port/CA differ; exact SQL, serializer and owned process stay real.
                return super()._owned_run(local_argv, local_env, deadline, **kwargs)
        return LocalTransport(time.time, OP)

    def read_descriptor(self, index, *, trusted=True):
        io = self.transport(trusted=trusted)
        try:
            raw = io.sql(r.ct3_sql_contract()[index], 'SYNTHETIC_CT3_PASSWORD', time.time()+20)
            self.assertIs(type(raw), bytes)
            return raw, r.c.parse(raw)
        finally:
            self.assertTrue(io.close(time.time()+5))
            self.assertFalse(io.children)

    def held_session(self, name, user='neondb_owner'):
        pg = _ct3_tls.historical.fixture.PG
        if user == 'p07_payment_runtime':
            self.command("CREATE ROLE p07_payment_runtime LOGIN NOINHERIT;")
            self.addCleanup(lambda:self.command('DROP ROLE IF EXISTS p07_payment_runtime;'))
        env = {**self.env, 'PGAPPNAME':name, 'PGSSLMODE':'verify-full',
               'PGSSLROOTCERT':str(self.cert)}
        process = _ct3_subprocess.Popen(
            [str(pg/'psql'),'-X','-q','-A','-t','-v','ON_ERROR_STOP=1',
             '-h','127.0.0.1','-p',self.port,'-U',user,'-d','neondb',
             '-c','SELECT pg_sleep(30);'],
            stdin=_ct3_subprocess.DEVNULL, stdout=_ct3_subprocess.DEVNULL,
            stderr=_ct3_subprocess.DEVNULL, env=env, start_new_session=True)
        backend_pid = None
        def close():
            nonlocal backend_pid
            try:
                if backend_pid is not None:
                    # Killing psql does not cancel its active pg_sleep on the
                    # server. This PID was observed on our disposable cluster
                    # for this exact synthetic holder, never on a live database.
                    predicate = (f"pid={backend_pid} AND application_name='{name}' "
                                 f"AND usename='{user}' AND datname='neondb'")
                    self.command('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE '+predicate+';')
                    for _ in range(100):
                        if self.command('SELECT count(*) FROM pg_stat_activity WHERE '+predicate+';') == '0':
                            backend_pid = None
                            break
                        time.sleep(.02)
                    self.assertIsNone(backend_pid, 'OWNED_CT3_BACKEND_NOT_CLOSED')
            finally:
                if process.poll() is None:
                    process.terminate()
                process.wait(timeout=5)
        self.addCleanup(close)
        for _ in range(100):
            if process.poll() is not None:
                self.fail('OWNED_CT3_SESSION_EXITED')
            observed = self.command("SELECT pid FROM pg_stat_activity WHERE application_name='"+name+
                                    "' AND usename='"+user+"' AND datname='neondb';")
            if observed:
                self.assertTrue(observed.isdecimal(), 'OWNED_CT3_BACKEND_AMBIGUOUS')
                backend_pid = int(observed)
                return process, close
            time.sleep(.02)
        close()
        self.fail('OWNED_CT3_SESSION_NOT_OBSERVED')

    def test_actual_main_and_independent_sql_readonly_tls_and_self_exclusion(self):
        before = self.command('SELECT row_to_json(u) FROM "User" u;')
        initial_raw, initial = self.read_descriptor(0)
        final_raw, final = self.read_descriptor(1)
        self.assertEqual(initial['operatorCount'],1)
        self.assertEqual(initial['sessionCount'],0)
        self.assertEqual(set(final),{'operatorCount','operator','sessionsAbsent'})
        self.assertEqual(final['operatorCount'],1)
        self.assertIs(final['sessionsAbsent'],True)
        for raw, independent in ((initial_raw,False),(final_raw,True)):
            flags, target = r.c.current_account(OP, {'operationId':OP,'body':raw}, final=independent)
            self.assertTrue(flags['accountIdentityExact'])
            self.assertTrue(flags['accountExactDisabled'])
            self.assertTrue(flags['databaseSessionsAbsent'])
            self.assertEqual(target,self.target)
        self.assertEqual(self.command('SELECT row_to_json(u) FROM "User" u;'),before)
        self.assertEqual(self.command("SELECT count(*) FROM pg_stat_activity WHERE application_name LIKE 'signmons_p08_qualification_%';"),'0')
        self.assertEqual(len(self.transport_calls),2)

    def test_each_exact_r51_session_blocks_both_descriptors(self):
        for name in self.R51_APPLICATIONS:
            with self.subTest(application=name):
                _, close = self.held_session(name)
                try:
                    initial_raw, initial = self.read_descriptor(0)
                    final_raw, final = self.read_descriptor(1)
                    self.assertEqual(initial['sessionCount'],1)
                    self.assertIs(final['sessionsAbsent'],False)
                    for raw, independent in ((initial_raw,False),(final_raw,True)):
                        flags, _ = r.c.current_account(OP, {'operationId':OP,'body':raw}, final=independent)
                        self.assertIs(flags['databaseSessionsAbsent'],False)
                finally:
                    close()
        self.assertEqual(self.command("SELECT count(*) FROM pg_stat_activity WHERE application_name LIKE 'p08-%';"),'0')

    def test_existing_role_and_qualification_predicates_and_unrelated_exclusion(self):
        for name, user in (
            ('signmons_p08_qualification_synthetic', 'neondb_owner'),
            ('ct3-runtime-role-synthetic','p07_payment_runtime'),
            ('ct3-unrelated-synthetic','neondb_owner'),
        ):
            with self.subTest(application=name):
                process, close = self.held_session(name,user)
                try:
                    _, initial = self.read_descriptor(0)
                    _, final = self.read_descriptor(1)
                    expected = name != 'ct3-unrelated-synthetic'
                    self.assertEqual(initial['sessionCount'],int(expected))
                    self.assertIs(final['sessionsAbsent'],not expected)
                    self.assertIsNone(process.poll())
                finally:
                    close()
                if user == 'p07_payment_runtime':
                    # The cleanup callback is idempotent to support explicit per-case teardown.
                    self.command('DROP ROLE p07_payment_runtime;')
        self.assertEqual(self.command("SELECT count(*) FROM pg_stat_activity WHERE application_name LIKE 'ct3-%' OR application_name LIKE 'signmons_p08_qualification_%';"),'0')

    def test_independent_sql_detects_account_becoming_active(self):
        initial_raw, _ = self.read_descriptor(0)
        flags, target = r.c.current_account(OP, {'operationId':OP,'body':initial_raw})
        self.assertTrue(flags['accountExactDisabled'])
        self.assertIsNotNone(target)
        self.command('UPDATE "User" SET status=\'ACTIVE\';')
        final_raw, final = self.read_descriptor(1)
        flags, target = r.c.current_account(OP, {'operationId':OP,'body':final_raw}, final=True)
        self.assertEqual(final['operator']['status'],'ACTIVE')
        self.assertIs(flags['accountIdentityExact'],True)
        self.assertIs(flags['accountExactDisabled'],False)
        self.assertIsNone(target)

    def test_untrusted_tls_and_unlisted_sql_refuse_and_reap_owned_processes(self):
        with self.assertRaises(Exception):
            self.read_descriptor(0,trusted=False)
        io = self.transport()
        try:
            with self.assertRaises(Exception):
                io.sql({'id':'ct3_account','sql':'SELECT 1'},'SYNTHETIC_CT3_PASSWORD',time.time()+20)
        finally:
            self.assertTrue(io.close(time.time()+5))
            self.assertFalse(io.children)
        self.assertEqual(self.command("SELECT count(*) FROM pg_stat_activity WHERE application_name LIKE 'signmons_p08_qualification_%';"),'0')


for _ct3_test_name in dir(_ct3_tls.BoundPostgreSQL):
    if _ct3_test_name.startswith('test_') and _ct3_test_name not in CT3DisposableTLS.__dict__:
        setattr(CT3DisposableTLS,_ct3_test_name,None)




class CT3FailureRegressions(CT3Composition):
    # Reuse only the harness; don't duplicate all composition tests in counts.
    for _name in tuple(name for name in CT3Composition.__dict__ if name.startswith('test_')):
        locals()[_name] = None

    def test_known_future_initial_cutoff_cannot_disappear(self):
        def change(s):
            s['user']['validSince'] = str(int(time.time())+3600)
            s['final_decrease'] = True
        result=self.execute(change)
        self.assertIs(result['initialFirebase']['revocationNotFuture'],False)
        self.assertEqual(result['status'],'CURRENT_CONTAINMENT_UNKNOWN')
        self.assertIn('VERIFY',self.shared['calls']);self.assertNotIn('revoke',self.shared['calls'])

    def test_actual_owner_mismatch_latches_provider_refusal(self):
        original=CT3Fake.cli
        def wrong(io,descriptor,deadline):
            if descriptor['id']=='owner':
                io.s['calls'].append('owner');return b'[{"account":"foreign","status":"ACTIVE"}]'
            return original(io,descriptor,deadline)
        with patch.object(CT3Fake,'cli',wrong):result=self.execute()
        self.assertEqual(self.shared['calls'],['owner'])
        self.assertIn({'stage':'ACCOUNT_INITIAL','code':'CT2_OWNER'},result['failureDetails'])
        self.assertTrue(result['processCleanupVerified'])

    def test_actual_project_mismatch_latches_provider_refusal(self):
        def mismatch(d):
            d.step(0)
            with patch.object(r.q,'validate_recovery_project',side_effect=r.m.Stop('RECOVERY_PROJECT')):
                d.step(1)
        result=self.execute(coordinate_fn=mismatch)
        self.assertEqual(self.shared['calls'],['owner','project'])
        self.assertIn({'stage':'ACCOUNT_INITIAL','code':'RECOVERY_PROJECT'},result['failureDetails'])

    def test_transient_backward_clock_latches_even_after_forward_recovery(self):
        def backward(d):
            d.step(0)
            original=d.clock
            d.clock=lambda:d.last-1
            try:d.gate()
            finally:d.clock=original
        result=self.execute(coordinate_fn=backward)
        self.assertEqual(self.shared['calls'],['owner'])
        self.assertIn({'stage':'ACCOUNT_INITIAL','code':'CT3_CLOCK_ROLLBACK'},result['failureDetails'])

    def test_mutation_receipt_failure_does_not_dispatch_or_skip_final_reads(self):
        original=r.k.Journal.put
        for slot,call in [('cleanup-2.json','revoke'),('main-6.json','DISABLE')]:
            def denied(journal,name,value):
                if name==slot:raise OSError('SECRET_SENTINEL')
                return original(journal,name,value)
            def both(s):s['user']['validSince']='1';s['enabled']=True
            with patch.object(r.k.Journal,'put',denied):result=self.execute(both)
            self.assertNotIn(call,self.shared['calls'])
            self.assertIn('VERIFY',self.shared['calls']);self.assertIn('ct3_closeout',self.shared['calls'])
            self.assertEqual(result['status'],'CURRENT_CONTAINMENT_UNKNOWN')

    def test_raw_temporaries_cleared_after_parser_exception(self):
        import sys
        captured=[]
        def trace(frame,event,arg):
            if frame.f_code is r.run_ct3.__code__ and event=='return':
                captured.append({key:frame.f_locals.get(key) for key in ('response','raw','target','password','key','endpoint_id')})
            return trace
        old=sys.gettrace()
        try:
            sys.settrace(trace)
            with patch.object(r.c,'current_firebase',side_effect=ValueError('SECRET_SENTINEL')):
                result=self.execute()
        finally:sys.settrace(old)
        self.assertTrue(captured);self.assertTrue(all(v is None for v in captured[-1].values()))
        self.assertTrue(result['privateReferencesCleared'])


class CT3OwnedBoundaryRegressions(unittest.TestCase):
    def test_each_owned_group_and_base_close_attempted_after_exception(self):
        io=r.CT3Transport(time.time,OP)
        first,second=object(),object(); groups={first,second}; calls=[]
        def finish(process):
            calls.append(process)
            if process is first:raise OSError('SECRET_SENTINEL')
            groups.remove(process);return True
        io.endpoint_io=r.SimpleNamespace(child_processes=groups,child_cleanup_unconfirmed=False,_finish_child=finish)
        with patch.object(r.Transport,'close',return_value=True) as close:
            self.assertFalse(io.close(time.time()+5));close.assert_called_once()
        self.assertEqual(set(calls),{first,second})

    def test_actual_worker_timeout_closes_descendants(self):
        import subprocess
        times={'cleanupEnd':time.time()+8}
        worker=r.EndpointChild(time.time,times,lambda _:None,False)
        source="const {spawn}=require('child_process');spawn('/bin/sleep',['20'],{stdio:'inherit'});setTimeout(()=>{},20000);"
        with self.assertRaises(subprocess.TimeoutExpired):
            worker.child([r.NODE,'-e',source],input='{}',text=True,capture_output=True,timeout=.2,
                         env={'PATH':'/usr/bin:/bin','LANG':'C'})
        self.assertFalse(worker.child_processes);self.assertFalse(worker.child_cleanup_unconfirmed)

    def test_actual_worker_interruption_closes_group(self):
        ticks=0
        def gate(_):
            nonlocal ticks
            ticks+=1
            if ticks>2:raise KeyboardInterrupt()
        worker=r.EndpointChild(time.time,{'cleanupEnd':time.time()+8},gate,False)
        with self.assertRaises(KeyboardInterrupt):
            worker.child([r.NODE,'-e','setTimeout(()=>{},20000)'],input='{}',text=True,capture_output=True,
                         timeout=3,env={'PATH':'/usr/bin:/bin','LANG':'C'})
        self.assertFalse(worker.child_processes)

    def test_envelope_change_after_hidden_inputs_refuses_launch(self):
        scope={'operationId':OP,'configSha256':'config'};times={'cutoff':time.time()+60}
        with tempfile.TemporaryDirectory() as folder:
            original=r.k.Journal
            with patch.object(r.k.inv,'read',return_value={}), \
                 patch.object(r,'authorize_ct3',side_effect=[(scope,times),({**scope,'operationId':r.c.R51_OPERATION},times)]), \
                 patch.object(r.k,'configuration',return_value='config'),patch.object(r.k,'sandbox_check'), \
                 patch.object(r.k,'Journal',side_effect=lambda root,s,create:original(Path(folder)/'receipt',s,create)), \
                 patch('builtins.input',return_value='READY'),patch.object(r.q,'recovery_password',return_value='SECRET_SENTINEL'), \
                 patch.object(r,'ct3_hidden',side_effect=['sk_test_'+'a'*24,'we_synthetic']), \
                 patch.object(r,'ENDPOINT_SHA256',r.m.digest(b'we_synthetic')),patch.object(r,'run_ct3') as run:
                with self.assertRaises(Exception):r.native_main_ct3(['--run-ct3',str(Path(folder)/'envelope')])
                run.assert_not_called()

    def test_reservation_replay_does_not_publish_twice(self):
        with tempfile.TemporaryDirectory() as folder:
            scope={'operationId':OP,'configSha256':'config'};now=time.time()
            times={'readEnd':now+60,'cleanupEnd':now+120}
            journal=r.k.Journal(Path(folder)/'receipt',scope,create=True)
            d=r.CT3Driver(scope,times,journal,'SYNTHETIC','SYNTHETIC','SYNTHETIC',None,time.time,lambda _:None,lambda:'config')
            d.reserve('main-5','endpoint_observe')
            with self.assertRaises(Exception):d.reserve('main-5','endpoint_observe')
            self.assertEqual(len(list(journal.root.iterdir())),1)
            d.purge()


class CT3ActualEndpointIntegration(unittest.TestCase):
    def test_python_to_actual_node_cli_success_with_only_provider_injected(self):
        io=r.CT3Transport(time.time,OP)
        original=r.EndpointChild.child
        payment=r.p.B/'evidence/APP-013/p08-native-entry-local-20261101/source/connected_payment.mjs'
        plan=r.p.B/'evidence/APP-013/p08-local-preparation-20261022/plan.json'
        source=("import {endpointCli} from "+json.dumps(r.ENDPOINT_WORKER.as_uri())+";"
                "import {EVENTS} from "+json.dumps(payment.as_uri())+";"
                "import {readFileSync} from 'node:fs';"
                "const origin=JSON.parse(readFileSync("+json.dumps(str(plan))+" )).origin;"
                "process.exitCode=await endpointCli({pin:"+json.dumps(r.m.digest(b'we_synthetic'))+","
                "send:async(url,opts)=>new Response(JSON.stringify({object:'webhook_endpoint',id:'we_synthetic',"
                "livemode:false,url:origin+'/webhooks/stripe',api_version:'2026-03-25.dahlia',enabled_events:EVENTS,status:'disabled'}))});")
        def injected(worker,argv,**kwargs):
            self.assertEqual(argv,[r.NODE,str(r.ENDPOINT_WORKER),'--endpoint-once'])
            self.assertEqual(kwargs['env'],{'PATH':'/usr/bin:/bin:/opt/homebrew/bin','LANG':'C'})
            return original(worker,[r.NODE,'--input-type=module','-e',source],**kwargs)
        with patch.object(r.EndpointChild,'child',injected):
            value=io.endpoint('VERIFY','sk_test_'+'a'*24,'we_synthetic',time.time()+10,
                              {'cleanupEnd':time.time()+20},lambda _:None)
        self.assertEqual(value['status'],'ENDPOINT_OBSERVED');self.assertEqual(value['state'],'DISABLED')
        self.assertEqual(value['requests'],1);self.assertTrue(io.endpoint_closed())
        self.assertTrue(io.close(time.time()+2))

    def test_node_and_python_safe_code_contracts_match(self):
        worker=r.EndpointChild(time.time,{'cleanupEnd':time.time()+10},lambda _:None,False)
        source="import {ENDPOINT_CODES} from "+json.dumps(r.ENDPOINT_WORKER.as_uri())+";process.stdout.write(JSON.stringify(ENDPOINT_CODES));"
        result=worker.child([r.NODE,'--input-type=module','-e',source],input='{}',text=True,capture_output=True,
                            timeout=4,env={'PATH':'/usr/bin:/bin','LANG':'C'})
        self.assertEqual(result.returncode,0);self.assertEqual(result.stderr,'')
        self.assertEqual(set(json.loads(result.stdout)),r.ENDPOINT_CODES)
        self.assertFalse(worker.child_processes)


class CT3HiddenInputPtyTests(unittest.TestCase):
    """Actual READY/getpass entry with synthetic inputs and an inert run boundary."""
    def exercise(self, partial=False):
        import pty
        import select
        import signal

        password = 'SQL_CT3_PTY_SYNTHETIC_ONLY'
        key = 'sk_test_' + 'SYNTHETICCT3ONLY' * 2
        endpoint_id = 'we_CT3PTYSYNTHETICONLY'
        prompts = [b'Type READY to start the three hidden inputs: ',
                   b'Qualification SQL password (hidden): ',
                   b'Existing Sandbox secret key (hidden): ',
                   b'Existing Sandbox endpoint ID (hidden): ']
        values = [b'READY\n', (password + '\n').encode(), (key + '\n').encode(),
                  (endpoint_id + '\n').encode()]
        if partial:
            # Leave the actual second getpass read incomplete until its real timer
            # expires. No mocked getpass/input and no provider entry are used.
            values = values[:2] + [key[:18].encode()]
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            now = time.time()
            scope = {'operationId': OP, 'configSha256': 'config'}
            times = {'cutoff': now + (2 if partial else 10)}
            envelope = {'scope': scope, 'decision': {'syntheticOnly': True}}
            pid, fd = pty.fork()
            if pid == 0:
                try:
                    original_journal, original_lease, original_read = r.k.Journal, r.k.lease, r.k.inv.read
                    def inert(scope_arg, times_arg, journal, entered_password, entered_key, entered_id, **_kwargs):
                        assert not partial
                        assert scope_arg == scope and times_arg == times
                        assert (entered_password, entered_key, entered_id) == (password, key, endpoint_id)
                        result = {'status': 'CURRENT_CONTAINMENT_CONFIRMED', 'syntheticOnly': True}
                        journal.put('result.json', result)
                        return result
                    with patch.object(r.k.inv, 'read', side_effect=lambda path:
                                      envelope if Path(path) == root / 'envelope' else original_read(path)), \
                         patch.object(r, 'authorize_ct3', return_value=(scope, times)) as authorized, \
                         patch.object(r.k, 'configuration', return_value='config'), \
                         patch.object(r.k, 'sandbox_check'), \
                         patch.object(r.k, 'lease', side_effect=lambda _path: original_lease(str(root / 'lease'))), \
                         patch.object(r.k, 'Journal', side_effect=lambda _root, s, create:
                                      original_journal(root / 'receipt', s, create)), \
                         patch.object(r, 'ENDPOINT_SHA256', r.m.digest(endpoint_id.encode())), \
                         patch.object(r, 'CT3Transport', side_effect=AssertionError('provider entry forbidden')) as native, \
                         patch.object(r, 'run_ct3', side_effect=inert) as run:
                        if partial:
                            try:
                                r.native_main_ct3(['--run-ct3', str(root / 'envelope')])
                            except BaseException as error:
                                assert str(error) == 'HTTP_TIMEOUT'
                            else:
                                raise AssertionError('partial hidden input did not time out')
                            run.assert_not_called()
                            assert authorized.call_count == 1
                            result = json.loads((root / 'receipt' / 'result.json').read_bytes())
                            assert result['status'] == 'CURRENT_CONTAINMENT_UNKNOWN'
                            assert result['stage'] == 'INPUT_OR_LAUNCH_REFUSED'
                            assert result['privateReferencesCleared'] is True
                        else:
                            result = r.native_main_ct3(['--run-ct3', str(root / 'envelope')])
                            assert result['status'] == 'CURRENT_CONTAINMENT_CONFIRMED'
                            assert run.call_count == 1 and authorized.call_count == 2
                        native.assert_not_called()
                        retained = b''.join(path.read_bytes() for path in (root / 'receipt').iterdir())
                        assert all(value.encode() not in retained for value in (password, key, endpoint_id))
                    os._exit(0)
                except BaseException as error:
                    os.write(2, ('CT3_PTY_FAILED_' + type(error).__name__ + '\n').encode())
                    os._exit(3)
            transcript = b''
            sent = 0
            status = None
            deadline = time.monotonic() + 13
            try:
                while time.monotonic() < deadline:
                    if select.select([fd], [], [], .05)[0]:
                        try:
                            chunk = os.read(fd, 8192)
                        except OSError:
                            break
                        transcript += chunk
                        if sent < len(values) and prompts[sent] in transcript:
                            os.write(fd, values[sent])
                            sent += 1
                    done, candidate = os.waitpid(pid, os.WNOHANG)
                    if done:
                        status = candidate
                        break
                if status is None:
                    done, candidate = os.waitpid(pid, os.WNOHANG)
                    if not done:
                        os.kill(pid, signal.SIGKILL)
                        _, candidate = os.waitpid(pid, 0)
                    status = candidate
                self.assertEqual(os.waitstatus_to_exitcode(status), 0, transcript.decode(errors='replace'))
                self.assertEqual(sent, len(values))
                expected_prompts = prompts[:3] if partial else prompts
                positions = [transcript.index(prompt) for prompt in expected_prompts]
                self.assertEqual(positions, sorted(positions))
                if partial:
                    self.assertNotIn(prompts[3], transcript)
                for secret in (password.encode(), key.encode(), endpoint_id.encode(), key[:18].encode()):
                    self.assertNotIn(secret, transcript)
            finally:
                os.close(fd)
                if status is None:
                    try:
                        os.kill(pid, signal.SIGKILL)
                        os.waitpid(pid, 0)
                    except (ProcessLookupError, ChildProcessError):
                        pass

    def test_actual_ready_then_three_hidden_prompts_deliver_exact_values(self):
        self.exercise()

    def test_partial_hidden_input_times_out_without_native_entry(self):
        self.exercise(partial=True)


if __name__=='__main__':unittest.main()
