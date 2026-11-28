"""Actual owned local processes and native response closure; no provider or credential I/O."""
import io
from contextlib import contextmanager
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import threading
import time
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import urllib.error

import native_io
from native_io import NativeIO
from private_inventory import Stop, need
import handoff


class ChildCleanupTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='p08-child-cleanup-', dir='/private/tmp')
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.io = object.__new__(NativeIO)
        self.io.cap = SimpleNamespace(clock=time.time, times={'cleanupEnd': time.time() + 15}, gate=lambda cleanup=False: None)
        self.io.cleanup = False
        self.io.child_processes = set()
        self.io.child_cleanup_unconfirmed = False
        self.processes = []
        self.spawn = subprocess.Popen
        self.sentinel = self.spawn([sys.executable, '-c', 'import time;time.sleep(30)'],
            stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            start_new_session=True)
        self.addCleanup(self.close_sentinel)

    def close_sentinel(self):
        if self.sentinel.poll() is None:
            self.sentinel.terminate()
        self.sentinel.wait(timeout=3)

    def owned_spawn(self, *args, **kwargs):
        process = self.spawn(*args, **kwargs)
        self.processes.append(process)
        return process

    def child_code(self, action, held=False):
        path = str(self.root / 'descendant.pid')
        return ("import subprocess,sys,time,signal;from pathlib import Path;"
                "p=subprocess.Popen([sys.executable,'-c','import time;time.sleep(30)'],"
                "stdin=subprocess.DEVNULL,"
                + ("stdout=sys.stdout,stderr=sys.stderr);" if held else
                   "stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL);")
                + f"Path({path!r}).write_text(str(p.pid));" + action)

    def invoke(self, code, timeout=.5):
        with patch.object(native_io.subprocess, 'Popen', side_effect=self.owned_spawn):
            return self.io.child([sys.executable, '-c', code], input='synthetic input',
                text=True, capture_output=True, timeout=timeout,
                env={'PATH': '/usr/bin:/bin:/opt/homebrew/bin', 'LANG': 'C'})

    def assert_closed(self):
        self.assertTrue(self.processes)
        for process in self.processes:
            self.assertIsNotNone(process.poll())
            with self.assertRaises(ProcessLookupError):
                os.killpg(process.pid, 0)
        self.assertEqual(self.io.child_processes, set())
        self.assertIsNone(self.sentinel.poll(), 'unrelated process must remain alive')

    def test_success_and_nonzero_reap_descendants_and_keep_protocol(self):
        for code in (0, 3):
            result = self.invoke(self.child_code(f"print('ack',flush=True);sys.exit({code})"))
            self.assertEqual((result.returncode, result.stdout, result.stderr), (code, 'ack\n', ''))
            self.assert_closed()

    def test_timeout_and_descendant_held_pipe_close_owned_group(self):
        for code, held in (("time.sleep(30)", False), ("sys.exit(0)", True)):
            with self.assertRaises(subprocess.TimeoutExpired):
                self.invoke(self.child_code(code, held))
            self.assert_closed()

    def test_oversized_stdout_and_stderr_close_owned_group(self):
        for stream in ('stdout', 'stderr'):
            with self.assertRaisesRegex(Stop, 'CHILD_OUTPUT_LIMIT'):
                self.invoke(self.child_code(f"sys.{stream}.write('x'*65536);sys.{stream}.flush();time.sleep(30)"))
            self.assert_closed()

    def test_interruption_closes_actual_child_and_descendant(self):
        previous = signal.getsignal(signal.SIGALRM)
        def interrupt(signum, frame):
            raise KeyboardInterrupt()
        signal.signal(signal.SIGALRM, interrupt)
        signal.setitimer(signal.ITIMER_REAL, .2)
        try:
            with self.assertRaises(KeyboardInterrupt):
                self.invoke(self.child_code('time.sleep(30)'), timeout=2)
        finally:
            signal.setitimer(signal.ITIMER_REAL, 0)
            signal.signal(signal.SIGALRM, previous)
        self.assert_closed()

    def test_coordinator_abort_gate_interrupts_detached_child(self):
        state = {'abort':False}
        def gate(cleanup=False):
            need(cleanup or not state['abort'], 'INTERRUPTED')
        self.io.cap.gate = gate
        timer = threading.Timer(.2, lambda: state.update(abort=True))
        timer.start()
        try:
            with self.assertRaisesRegex(Stop, 'INTERRUPTED'):
                self.invoke(self.child_code('time.sleep(30)'), timeout=5)
        finally:
            timer.cancel()
            timer.join()
        self.assert_closed()

    def test_term_ignoring_child_is_killed_within_cleanup_budget(self):
        with self.assertRaises(subprocess.TimeoutExpired):
            self.invoke(self.child_code('signal.signal(signal.SIGTERM,signal.SIG_IGN);time.sleep(30)'))
        self.assert_closed()

    def test_unknown_closure_is_sticky_failure(self):
        finish = self.io._finish_child
        def unknown(process):
            self.assertTrue(finish(process))
            return False
        with patch.object(self.io, '_finish_child', side_effect=unknown):
            with self.assertRaisesRegex(Stop, 'CHILD_PROCESS_CLOSEOUT_UNCONFIRMED'):
                self.invoke(self.child_code("print('ack')"))
        self.assertTrue(self.io.child_cleanup_unconfirmed)
        self.assert_closed()

    def test_selector_setup_failure_still_closes_spawned_group(self):
        with patch.object(native_io.selectors, 'DefaultSelector', side_effect=OSError('synthetic')):
            with self.assertRaises(OSError):
                self.invoke(self.child_code('time.sleep(30)'))
        self.assert_closed()

    def test_input_bound_and_cleanup_reserve_refuse_before_spawn(self):
        with patch.object(native_io.subprocess, 'Popen', side_effect=AssertionError('must not spawn')):
            with self.assertRaisesRegex(Stop, 'CHILD_INPUT_BOUNDS'):
                self.io.child(['unused'], input='x'*131073, text=True, capture_output=True,
                    timeout=1, env={})
            self.io.cap.times['cleanupEnd'] = time.time() + 1
            with self.assertRaisesRegex(Stop, 'CHILD_PROCESS_DEADLINE'):
                self.io.child(['unused'], input='x', text=True, capture_output=True,
                    timeout=1, env={})

    def test_actual_handoff_timeout_merges_journal_after_group_closure(self):
        (self.root/'native_child.mjs').write_text(
            "import{spawn}from'node:child_process';import{writeFileSync}from'node:fs';"
            f"const p=spawn({json.dumps(sys.executable)},['-c','import time;time.sleep(30)'],{{stdio:'ignore'}});"
            f"writeFileSync({json.dumps(str(self.root/'handoff-descendant.pid'))},String(p.pid));"
            "setTimeout(()=>{},30000);")
        cap = SimpleNamespace(root=self.root, clock=time.time,
            times={'workEnd':time.time()+.5,'cleanupEnd':time.time()+10}, e={'version':2},
            spend=lambda *args: time.time()+.5,
            coordinator=SimpleNamespace(j={'nativeEntry':{'calls':{'child':1}}}), gate=lambda cleanup=False: None)
        self.io.cap = cap
        self.io.credentials = lambda: {'password':'synthetic','accessToken':'synthetic'}
        owner = object.__new__(handoff.Handoff)
        owner.cap, owner.io = cap, self.io
        owner._journal = lambda: {'synthetic':True}
        merged = []
        owner._merge_failed_payment_child = lambda before: merged.append(before)
        with patch.object(handoff, 'HERE', self.root), patch.object(native_io.subprocess, 'Popen', side_effect=self.owned_spawn):
            with self.assertRaisesRegex(handoff.old.Stop, 'CHILD_TIMEOUT'):
                owner.invoke_child(None, '--run')
        self.assertEqual(merged, [{'synthetic':True}])
        self.assert_closed()


class ResponseCleanupTests(unittest.TestCase):
    def setUp(self):
        self.io = object.__new__(NativeIO)
        self.owner_checks = 0
        def owner(): self.owner_checks += 1
        self.io.ensure_owner = owner
        self.deadline = time.time() + 5
        self.reservations = []
        self.open_calls = []
        def spend(*args):
            self.reservations.append(args)
            return self.deadline
        self.io.cap = SimpleNamespace(plan={'project':'synthetic'}, clock=time.time,
            spend=spend, gate=lambda *args:None)
        self.io.cleanup, self.io.token = False, 'synthetic'
        self.descriptor = {'method':'GET','url':'https://apikeys.googleapis.com/v2/synthetic',
            'body':None,'timeoutSeconds':5,'redirect':'error'}
        self.acl = native_io.load_acl()
        patched = patch.object(native_io, 'load_acl', return_value=self.acl)
        patched.start(); self.addCleanup(patched.stop)

    def run_response(self, response=None, error=None):
        def opened(*args, **kwargs):
            self.open_calls.append((args, kwargs))
            if error is not None: raise error
            return response
        opener = SimpleNamespace(open=opened)
        with patch.object(native_io.urllib.request, 'build_opener', return_value=opener):
            return self.io.https(self.descriptor)

    @contextmanager
    def accelerated_deadlines(self):
        # Exercise the real source-pinned SIGALRM context, with short local waits.
        # Record the production-requested budgets independently of acceleration.
        original = self.acl.http_deadline
        requested = []
        @contextmanager
        def bounded(seconds):
            requested.append(seconds)
            with original(min(seconds, .05)):
                yield
        with patch.object(self.acl, 'http_deadline', bounded):
            yield requested

    def test_success_malformed_oversized_and_decode_paths_close(self):
        for body in (b'{}', b'{malformed', b'x'*65537, b'\xff'):
            response = io.BytesIO(body)
            response.status = 200
            if len(body)>65536 or body==b'\xff':
                with self.assertRaises((Stop, UnicodeDecodeError)):
                    self.run_response(response)
            else:
                self.assertEqual(self.run_response(response)['body'],body.decode())
            self.assertTrue(response.closed)

    def test_http_error_response_is_always_closed(self):
        body = io.BytesIO(b'{"error":{"code":404}}')
        error = urllib.error.HTTPError(self.descriptor['url'],404,'synthetic',{},body)
        self.assertEqual(self.run_response(error=error)['httpStatus'],404)
        self.assertTrue(body.closed)

    def test_read_failure_and_interruption_close_response(self):
        for failure in (OSError('synthetic'), KeyboardInterrupt()):
            class Response:
                status = 200
                closed = False
                def read(self, size): raise failure
                def close(self): self.closed=True
            response=Response()
            with self.assertRaises((Stop,KeyboardInterrupt)):
                self.run_response(response)
            self.assertTrue(response.closed)

    def test_close_failure_is_not_reported_as_success(self):
        class Response:
            status=200
            def read(self,size):return b'{}'
            def close(self):raise OSError('synthetic')
        with self.assertRaisesRegex(Stop,'HTTPS_RESPONSE_CLOSE_UNCONFIRMED'):
            self.run_response(Response())

    def test_whole_request_timer_stops_hanging_and_dripping_body(self):
        for dripping in (False, True):
            with self.subTest(dripping=dripping):
                self.open_calls.clear(); self.reservations.clear()
                self.deadline = time.time() + 20
                class Response:
                    status = 200
                    closed = False
                    def read(self, size):
                        if not dripping: time.sleep(5)
                        while True: time.sleep(.005)  # Repeated progress cannot reset the wall bound.
                    def close(self): self.closed = True
                response = Response(); before = time.monotonic()
                with self.accelerated_deadlines() as budgets:
                    with self.assertRaisesRegex(Stop, '^HTTPS_UNCONFIRMED$'):
                        self.run_response(response)
                self.assertEqual(budgets, [8, 1])
                self.assertLess(time.monotonic() - before, 1)
                self.assertTrue(response.closed)
                self.assertEqual(len(self.open_calls), 1)
                self.assertEqual(len(self.reservations), 1)
                self.assertEqual(signal.getitimer(signal.ITIMER_REAL), (0.0, 0.0))

    def test_whole_request_timer_includes_open_and_has_no_retry(self):
        self.deadline = time.time() + 20
        calls = []
        def hanging(*args, **kwargs):
            calls.append(kwargs['timeout']); time.sleep(5)
        with self.accelerated_deadlines() as budgets, patch.object(
                native_io.urllib.request, 'build_opener', return_value=SimpleNamespace(open=hanging)):
            with self.assertRaisesRegex(Stop, '^HTTPS_UNCONFIRMED$'):
                self.io.https(self.descriptor)
        self.assertEqual(budgets, [8]); self.assertEqual(calls, [8])
        self.assertEqual(len(self.reservations), 1)

    def test_normal_and_fallback_close_are_bounded_without_success(self):
        self.deadline = time.time() + 20
        class Response:
            status = 200
            closes = 0
            def read(self, size): return b'{}'
            def close(self): self.closes += 1; time.sleep(5)
        response = Response(); before = time.monotonic()
        with self.accelerated_deadlines() as budgets:
            with self.assertRaisesRegex(Stop, '^HTTPS_RESPONSE_CLOSE_UNCONFIRMED$'):
                self.run_response(response)
        self.assertEqual(budgets, [8, 1]); self.assertEqual(response.closes, 2)
        self.assertEqual(len(self.open_calls), 1); self.assertEqual(len(self.reservations), 1)
        self.assertLess(time.monotonic() - before, 1)

    def test_primary_read_failure_survives_failing_or_hanging_cleanup(self):
        for primary in (OSError('PRIVATE_PRIMARY'), Stop('HTTPS_OUTPUT'), KeyboardInterrupt(), SystemExit(7)):
            for hanging in (False, True):
                with self.subTest(primary=type(primary).__name__, hanging=hanging):
                    self.deadline = time.time() + 20
                    class Response:
                        status = 200
                        def read(self, size): raise primary
                        def close(self):
                            if hanging: time.sleep(5)
                            raise OSError('PRIVATE_CLEANUP')
                    with self.accelerated_deadlines():
                        with self.assertRaises(type(primary) if not isinstance(primary, OSError) else Stop) as caught:
                            self.run_response(Response())
                    if isinstance(primary, OSError): self.assertEqual(str(caught.exception), 'HTTPS_UNCONFIRMED')
                    else: self.assertIs(caught.exception, primary)
                    self.assertNotIn('PRIVATE_', str(caught.exception))

    def test_http_error_body_timeout_is_bounded_and_response_closed(self):
        self.deadline = time.time() + 20
        class Body:
            closed = False
            def read(self, size): time.sleep(5)
            def close(self): self.closed = True
        body = Body()
        error = urllib.error.HTTPError(self.descriptor['url'], 404, 'synthetic', {}, body)
        with self.accelerated_deadlines() as budgets:
            with self.assertRaisesRegex(Stop, '^HTTPS_UNCONFIRMED$'):
                self.run_response(error=error)
        self.assertEqual(budgets, [8, 1]); self.assertTrue(body.closed)
        self.assertEqual(len(self.open_calls), 1)

    def test_expired_phase_refuses_before_open_and_respects_short_remaining_time(self):
        self.deadline = time.time() - 1
        with self.assertRaisesRegex(Stop, '^HTTPS_UNCONFIRMED$'):
            self.run_response()
        self.assertEqual(self.open_calls, [])
        self.deadline = time.time() + .04
        class Response:
            status = 200
            closes = 0
            def read(self, size): time.sleep(5)
            def close(self): self.closes += 1
        response = Response(); before = time.monotonic()
        with self.assertRaisesRegex(Stop, '^HTTPS_UNCONFIRMED$'):
            self.run_response(response)
        self.assertLess(time.monotonic() - before, 1)
        self.assertEqual(response.closes, 0)  # An expired phase grants no extra close time.
        self.assertLessEqual(self.open_calls[-1][1]['timeout'], .04)

    def test_active_alarm_is_preserved_and_refused_before_any_io(self):
        previous = signal.getsignal(signal.SIGALRM)
        def handler(*args): pass
        signal.signal(signal.SIGALRM, handler)
        signal.setitimer(signal.ITIMER_REAL, 20)
        try:
            with self.assertRaisesRegex(Stop, '^HTTPS_UNCONFIRMED$'):
                self.run_response()
            self.assertIs(signal.getsignal(signal.SIGALRM), handler)
            remaining, interval = signal.getitimer(signal.ITIMER_REAL)
            self.assertGreater(remaining, 19); self.assertEqual(interval, 0)
            self.assertEqual(self.owner_checks, 0)
            self.assertEqual(self.reservations, []); self.assertEqual(self.open_calls, [])
        finally:
            signal.setitimer(signal.ITIMER_REAL, 0); signal.signal(signal.SIGALRM, previous)

    def test_original_handler_restored_on_success_and_timeout(self):
        previous = signal.getsignal(signal.SIGALRM)
        def handler(*args): pass
        signal.signal(signal.SIGALRM, handler)
        try:
            response = io.BytesIO(b'{}'); response.status = 200
            self.run_response(response)
            self.assertIs(signal.getsignal(signal.SIGALRM), handler)
            self.assertEqual(signal.getitimer(signal.ITIMER_REAL), (0.0, 0.0))
            class Response:
                status = 200
                def read(self, size): time.sleep(5)
                def close(self): pass
            with self.accelerated_deadlines():
                with self.assertRaisesRegex(Stop, '^HTTPS_UNCONFIRMED$'):
                    self.run_response(Response())
            self.assertIs(signal.getsignal(signal.SIGALRM), handler)
            self.assertEqual(signal.getitimer(signal.ITIMER_REAL), (0.0, 0.0))
        finally:
            signal.setitimer(signal.ITIMER_REAL, 0); signal.signal(signal.SIGALRM, previous)


if __name__ == '__main__':
    unittest.main()


class TC1OwnershipTests(unittest.TestCase):
    def setUp(self):
        self.fixture=ChildCleanupTests();self.fixture.setUp();self.addCleanup(self.fixture.doCleanups)
        self.io=self.fixture.io
        cap=self.io.cap;cap.mode='run';cap.dispatch_serial=0
        cap.e={'version':2,'purpose':'NATIVE_AUTH_QUALIFICATION_ONLY',
            'limits':{'cli':8,'sql':8,'child':8}}
        cap.coordinator=SimpleNamespace(j={'nativeEntry':{'ownedChildren':[]}},save=lambda:None)
        self.rows=cap.coordinator.j['nativeEntry']['ownedChildren']

    def test_cli_total_bound_reaps_term_ignoring_descendant_and_pipe_holder(self):
        for code in (self.fixture.child_code('sys.exit(0)',held=True),
                     self.fixture.child_code('signal.signal(signal.SIGTERM,signal.SIG_IGN);time.sleep(30)')):
            with self.subTest(code=code[-30:]):
                start=time.monotonic()
                with patch.object(native_io.subprocess,'Popen',side_effect=self.fixture.owned_spawn):
                    with self.assertRaises(subprocess.TimeoutExpired):
                        self.io._owned_process([sys.executable,'-c',code],b'',{},1.,False,65536,'cli',total=True)
                self.assertLess(time.monotonic()-start,1.4)
                self.fixture.assert_closed()
                self.assertEqual(self.rows[-1]['state'],'CLOSED')
        complete,rows=self.io.closure()
        self.assertTrue(complete);self.assertEqual(rows,self.rows)
        self.assertEqual([row['ordinal'] for row in rows],[1,2])
        self.assertEqual({row['kind'] for row in rows},{'CLI'})

    def test_predispatch_expiry_records_positive_not_started_without_process(self):
        closed=[False]
        def save():
            if self.rows:closed[0]=True
        def gate(cleanup=False):
            if closed[0]:raise Stop('ENTRY_DEADLINE')
        self.io.cap.coordinator.save=save;self.io.cap.gate=gate
        with patch.object(native_io.subprocess,'Popen',side_effect=AssertionError('must not spawn')):
            with self.assertRaisesRegex(Stop,'ENTRY_DEADLINE'):
                self.io._owned_process(['synthetic'],b'',{},1.,False,65536,'sql',total=True)
        self.assertEqual(self.io.cap.dispatch_serial,0)
        self.assertEqual(self.rows,[{'ordinal':1,'kind':'SQL','pid':None,'pgid':None,'state':'NOT_STARTED'}])
        self.assertTrue(self.io.closure()[0])

    def test_unconfirmed_spawn_blocks_closure_and_further_processes(self):
        with patch.object(native_io.subprocess,'Popen',side_effect=OSError('synthetic')):
            with self.assertRaises(OSError):
                self.io._owned_process(['synthetic'],b'',{},1.,False,65536,'sql',total=True)
        self.assertFalse(self.io.closure()[0])
        with patch.object(native_io.subprocess,'Popen',side_effect=AssertionError('must not spawn')):
            with self.assertRaisesRegex(Stop,'CHILD_PROCESS_CLOSEOUT_UNCONFIRMED'):
                self.io._owned_process(['synthetic'],b'',{},1.,False,65536,'sql',total=True)

    def test_owned_inventory_bound_refuses_before_spawn(self):
        self.io.cap.e['limits']={'cli':0,'sql':0,'child':0}
        with patch.object(native_io.subprocess,'Popen',side_effect=AssertionError('must not spawn')):
            with self.assertRaisesRegex(Stop,'CHILD_INVENTORY_LIMIT'):
                self.io._owned_process(['synthetic'],b'',{},1.,False,65536,'sql',total=True)


    def test_cli_sql_output_limits_preserve_safe_categories(self):
        self.io.env=lambda:{}
        def spend(kind,cleanup):return time.time()+8
        self.io.cap.spend=spend
        cases=[('sql','stdout','DATABASE_OUTPUT_LIMIT'),('sql','stderr','DATABASE_ERROR_OUTPUT_LIMIT'),
               ('cli','stdout','NATIVE_COMMAND_REFUSED'),('cli','stderr','NATIVE_COMMAND_REFUSED')]
        for kind,stream,code in cases:
            with self.subTest(kind=kind,stream=stream),                 patch.object(native_io.subprocess,'Popen',side_effect=self.fixture.owned_spawn):
                with self.assertRaisesRegex(Stop,code):
                    self.io._run([sys.executable,'-c',f'import sys;sys.{stream}.write("x"*70000)'],kind)
                self.fixture.assert_closed()

    def test_tag_output_limit_category_reaches_owned_transport(self):
        self.io.env=lambda:{};self.io.cap.spend=lambda *args:time.time()+8
        self.io.cap.plan={'iam':[]}
        vector=['run','services','update-traffic','synthetic']
        self.io.restore=SimpleNamespace(TAG='synthetic',command=lambda *args:vector)
        def run(*args,**kwargs):
            self.assertEqual(kwargs['output_codes']['stdout'],'RUNTIME_TAG_OUTPUT_LIMIT')
            raise Stop(kwargs['output_codes']['stdout'])
        with patch.object(self.io,'_owned_process',side_effect=run):
            with self.assertRaisesRegex(Stop,'RUNTIME_TAG_OUTPUT_LIMIT'):
                self.io._run(['/opt/homebrew/bin/gcloud',*vector,'--format=json'],'cli')


class TC2TagTimingTests(unittest.TestCase):
    def setUp(self):
        self.fixture = TC1OwnershipTests()
        self.fixture.setUp()
        self.addCleanup(self.fixture.doCleanups)
        self.io = self.fixture.io
        self.io.env = lambda: {'PATH': '/usr/bin:/bin', 'LANG': 'C'}
        self.io.cap.plan = {'iam': []}
        restore = native_io.load('p08-restoration-local-20261028/source/restore.py', 'tc2_restore')
        binding = native_io.load('p08-key-correction-20261110/binding.py', 'tc2_binding')
        self.io.restore = binding.apply_restore(restore)
        self.reservations = []
        self.deadline = time.time() + 45
        self.io.cap.times['cleanupEnd'] = time.time() + 60
        def gate(cleanup=False):
            need(self.io.cap.clock() < self.deadline, 'ENTRY_DEADLINE')
            return self.deadline
        def spend(kind, cleanup):
            self.reservations.append((kind, cleanup))
            return gate(cleanup)
        self.io.cap.gate, self.io.cap.spend = gate, spend

    def command(self, enabled):
        return ['/opt/homebrew/bin/gcloud', *self.io.restore.command(
            self.io.cap.plan, 'tag', self.io.restore.TAG, enabled), '--format=json']

    def test_exact_dynamic_vectors_select_thirty_seconds_and_total_reap_bound(self):
        self.io.cap.clock = lambda: 100.
        self.deadline = 200.
        for cleanup in (False, True):
            with self.subTest(cleanup=cleanup):
                self.io.cleanup = cleanup
                command = self.command(not cleanup)
                with patch.object(self.io, '_owned_process', return_value=
                        subprocess.CompletedProcess(command, 0, b'[]', b'')) as owned:
                    self.assertEqual(self.io._run(command, 'cli'), '[]')
                self.assertEqual(owned.call_args.args[3], 30)
                self.assertIs(owned.call_args.kwargs['total'], True)
                self.assertEqual(owned.call_count, 1)
        self.assertEqual(self.reservations, [('cli', False), ('cli', True)])
        self.assertEqual(native_io.AUTH_TAG_CLEANUP_SECONDS, 38)

    def test_unrelated_foreign_vectors_wrong_direction_and_kind_keep_eight(self):
        self.io.cap.clock = lambda: 100.
        self.deadline = 200.
        forward, removal = self.command(True), self.command(False)
        foreign_candidate = [x.replace(self.io.restore.CANDIDATE, 'foreign-candidate') for x in forward]
        foreign_tag = [x.replace(self.io.restore.TAG, 'foreign-tag') for x in removal]
        foreign_service = [x.replace('signmons-calldesk-staging', 'foreign-service') for x in forward]
        cases = [(False, forward[:-1], 'cli'), (False, [*forward, '--async'], 'cli'),
                 (False, foreign_candidate, 'cli'), (True, foreign_tag, 'cli'),
                 (False, foreign_service, 'cli'), (False, tuple(forward), 'cli'),
                 (False, removal, 'cli'), (True, forward, 'cli'),
                 (False, forward, 'sql'), (False, ['/opt/homebrew/bin/psql'], 'sql'),
                 (False, ['/opt/homebrew/bin/gcloud', 'auth', 'list'], 'cli')]
        for cleanup, command, kind in cases:
            with self.subTest(cleanup=cleanup, command=command, kind=kind):
                self.io.cleanup = cleanup
                with patch.object(self.io, '_owned_process', return_value=
                        subprocess.CompletedProcess(command, 0, b'[]', b'')) as owned:
                    self.io._run(command, kind)
                self.assertEqual(owned.call_args.args[3], 8)
                self.assertEqual(owned.call_count, 1)

    def test_ordinary_and_preflight_purposes_keep_original_subprocess_timeout(self):
        self.io.cap.clock = lambda: 100.
        self.deadline = 200.
        for purpose in (None, 'NATIVE_PREFLIGHT_ONLY'):
            self.io.cap.e['purpose'] = purpose
            for cleanup in (False, True):
                with self.subTest(purpose=purpose, cleanup=cleanup):
                    self.io.cleanup = cleanup
                    command = self.command(not cleanup)
                    with patch.object(self.io, '_owned_process', side_effect=AssertionError('AQ1 only')), \
                         patch.object(native_io.subprocess, 'run', return_value=
                            subprocess.CompletedProcess(command, 0, b'[]', b'')) as original:
                        self.io._run(command, 'cli')
                    self.assertEqual(original.call_args.kwargs['timeout'], 8)
                    self.assertEqual(original.call_count, 1)

    def local_spawn(self, expected, code):
        def spawn(command, **kwargs):
            self.assertEqual(command, expected)
            # Preserve stdin/stdout/stderr/env/session ownership. Replace only
            # the exact Popen program with this harmless local Python process.
            return self.fixture.fixture.owned_spawn([sys.executable, '-c', code], **kwargs)
        return spawn

    def delayed_success(self, cleanup):
        self.io.cleanup = cleanup
        if cleanup:
            self.io.cap.mode = 'closeout'
        command = self.command(not cleanup)
        code = self.fixture.fixture.child_code("time.sleep(10);print('[]',flush=True)")
        start = time.monotonic()
        with patch.object(native_io.subprocess, 'Popen', side_effect=self.local_spawn(command, code)) as spawn:
            self.assertEqual(self.io._run(command, 'cli'), '[]')
        elapsed = time.monotonic() - start
        self.assertGreaterEqual(elapsed, 10)
        self.assertLess(elapsed, native_io.AUTH_TAG_COMMAND_SECONDS)
        self.assertEqual(spawn.call_count, 1)
        self.assertEqual(self.reservations, [('cli', cleanup)])
        self.assertEqual(self.io.cap.dispatch_serial, 1)
        inventory = 'independentChildren' if cleanup else 'ownedChildren'
        rows = self.io.cap.coordinator.j['nativeEntry'][inventory]
        self.assertEqual(len(rows), 1)
        self.assertEqual((rows[0]['kind'], rows[0]['state']), ('CLI', 'CLOSED'))
        self.fixture.fixture.assert_closed()

    def test_actual_forward_tag_ten_second_success_keeps_owned_closure_and_sentinel(self):
        self.delayed_success(False)

    def test_actual_removal_tag_ten_second_success_keeps_owned_closure_and_sentinel(self):
        self.delayed_success(True)

    def test_short_work_and_cleanup_phase_clamp_tag_and_reap_held_pipes(self):
        for cleanup in (False, True):
            with self.subTest(cleanup=cleanup):
                self.io.cleanup = cleanup
                command = self.command(not cleanup)
                self.deadline = time.time() + 1
                code = self.fixture.fixture.child_code('sys.exit(0)', held=True)
                start = time.monotonic()
                with patch.object(native_io.subprocess, 'Popen', side_effect=self.local_spawn(command, code)) as spawn:
                    with self.assertRaisesRegex(Stop, 'NATIVE_COMMAND_UNCONFIRMED' if cleanup else 'RUNTIME_TAG_COMMAND_TIMEOUT'):
                        self.io._run(command, 'cli')
                self.assertLess(time.monotonic() - start, 1.6)
                self.assertEqual(spawn.call_count, 1)
                self.fixture.fixture.assert_closed()
        self.assertEqual(self.reservations, [('cli', False), ('cli', True)])

    def test_exact_tag_interruption_stops_one_spawn_and_preserves_failure(self):
        command = self.command(True)
        code = self.fixture.fixture.child_code('time.sleep(30)')
        gate = self.io.cap.gate
        interrupted = [False]
        def interruptible(cleanup=False):
            need(not interrupted[0], 'INTERRUPTED')
            return gate(cleanup)
        self.io.cap.gate = interruptible
        timer = threading.Timer(.2, lambda: interrupted.__setitem__(0, True))
        timer.start()
        try:
            with patch.object(native_io.subprocess, 'Popen', side_effect=self.local_spawn(command, code)) as spawn:
                with self.assertRaisesRegex(Stop, 'INTERRUPTED'):
                    self.io._run(command, 'cli')
            self.assertEqual(spawn.call_count, 1)
        finally:
            timer.cancel()
            timer.join()
        self.fixture.fixture.assert_closed()

    def test_exact_tag_output_and_nonzero_failures_keep_safe_categories(self):
        for cleanup, action, expected in [
                (False, "sys.stdout.write('x'*70000)", 'RUNTIME_TAG_OUTPUT_LIMIT'),
                (True, "sys.stdout.write('x'*70000)", 'NATIVE_COMMAND_REFUSED'),
                (False, 'sys.exit(3)', 'RUNTIME_TAG_COMMAND_REFUSED'),
                (True, 'sys.exit(3)', 'NATIVE_COMMAND_REFUSED')]:
            with self.subTest(cleanup=cleanup, expected=expected):
                self.io.cleanup = cleanup
                command = self.command(not cleanup)
                code = 'import sys;' + action
                with patch.object(native_io.subprocess, 'Popen', side_effect=self.local_spawn(command, code)) as spawn:
                    with self.assertRaisesRegex(Stop, expected):
                        self.io._run(command, 'cli')
                self.assertEqual(spawn.call_count, 1)
                self.fixture.fixture.assert_closed()
