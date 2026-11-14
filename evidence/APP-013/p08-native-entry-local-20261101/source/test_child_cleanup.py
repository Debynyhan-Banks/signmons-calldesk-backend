"""Actual owned local processes and native response closure; no provider or credential I/O."""
import io
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
        self.io.ensure_owner = lambda: None
        self.io.cap = SimpleNamespace(plan={'project':'synthetic'}, clock=time.time,
            spend=lambda *args:time.time()+5, gate=lambda *args:None)
        self.io.cleanup, self.io.token = False, 'synthetic'
        self.descriptor = {'method':'GET','url':'https://apikeys.googleapis.com/v2/synthetic',
            'body':None,'timeoutSeconds':5,'redirect':'error'}

    def run_response(self, response=None, error=None):
        opener = SimpleNamespace(open=lambda *args, **kwargs: response)
        if error is not None:
            def fail(*args, **kwargs): raise error
            opener.open = fail
        with patch.object(native_io.urllib.request, 'build_opener', return_value=opener):
            return self.io.https(self.descriptor)

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


if __name__ == '__main__':
    unittest.main()
