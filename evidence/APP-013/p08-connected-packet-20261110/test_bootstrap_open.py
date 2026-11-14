"""Actual authority/private-file boundary; only synthetic loopback presenters."""
import concurrent.futures
import contextlib
import copy
import datetime
import io
import json
import os
from pathlib import Path
import selectors
import subprocess
import sys
import time
import threading
import unittest
from unittest.mock import patch
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import bootstrap_open as b
from private_inventory import purge, read, reserve, Stop
import test_entry as fixture


class BootstrapTests(unittest.TestCase):
    def setUp(self):
        self.t = fixture.ConnectedEntryTests()
        self.t.setUp()
        self.addCleanup(self.t.doCleanups)
        self.root, self.e = self.t.root, self.t.e
        self.operation = self.e['plan']['operationId']
        reserve(self.root / 'attempt.json', {'operationId': self.operation,
                                            'planSha256': b.a.digest(self.e['plan'])})
        self.j = {'operationId': self.operation, 'planSha256': b.a.digest(self.e['plan']),
                  'nativeEntry': {'envelopeSha256': b.a.digest(self.e)},
                  'payment': {'operationId': self.operation,
                              'scopeSha256': b.a.digest(self.e['payment']),
                              'phase': 'ATTENDED', 'bridgeClosed': False,
                              'enableIntent': True, 'endpointDisabled': False}}
        reserve(self.root / 'journal.json', self.j)
        self.boot = {'operationId': self.operation,
                     'bootstrapUrl': 'http://127.0.0.1:12345/s/' + 'a' * 64}
        reserve(self.root / 'payment-bootstrap.json', self.boot)
        self.calls = []

    def write(self, name, value):
        (self.root / name).unlink(missing_ok=True)
        reserve(self.root / name, value)

    def present(self, url, timeout):
        self.calls.append(True)
        b.validate_url(url)
        self.assertGreater(timeout, 0)
        self.assertLessEqual(timeout, 10)

    def open(self, **kwargs):
        return b.open_bootstrap(self.root, presenter=self.present, **kwargs)

    def test_valid_attended_phase_dispatches_once_and_retains_only_safe_marker(self):
        result = self.open()
        self.assertEqual(result, {'status': 'BROWSER_OPEN_DISPATCHED', 'operationId': self.operation})
        marker = read(self.root / b.MARKER)
        self.assertEqual(set(marker), {'status', 'operationId', 'envelopeSha256',
                                     'paymentScopeSha256', 'sourceCommit'})
        self.assertNotIn('/s/', json.dumps(marker))
        self.assertEqual(self.calls, [True])
        with self.assertRaises(FileExistsError):
            self.open()
        self.assertEqual(self.calls, [True])

    def test_existing_attempt_allows_attended_work_after_launch_cutoff(self):
        now = int(time.time())
        stamp = lambda value: datetime.datetime.fromtimestamp(value, datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')
        self.e['plan']['window']['cutoff'] = stamp(now - 1)
        self.e['qualification']['scopeSha256'] = b.a.digest({k: self.e[k] for k in
                        ('plan', 'target', 'database', 'resources', 'limits', 'payment')})
        self.t.seal()
        self.write('attempt.json', {'operationId': self.operation, 'planSha256': b.a.digest(self.e['plan'])})
        self.j['planSha256'] = b.a.digest(self.e['plan'])
        self.j['nativeEntry']['envelopeSha256'] = b.a.digest(self.e)
        self.write('journal.json', self.j)
        self.open()
        self.assertEqual(self.calls, [True])

    def test_url_foreign_credential_query_fragment_path_and_port_refuse(self):
        token = 'a' * 64
        values = [f'https://127.0.0.1:123/s/{token}', f'http://localhost:123/s/{token}',
                  f'http://127.0.0.2:123/s/{token}', f'http://u@127.0.0.1:123/s/{token}',
                  f'http://127.0.0.1:0/s/{token}', f'http://127.0.0.1:65536/s/{token}',
                  f'http://127.0.0.1:00123/s/{token}', f'http://127.0.0.1:123/s/{token}?q=1',
                  f'http://127.0.0.1:123/s/{token}#f', f'http://127.0.0.1:123/s/{token}/',
                  f'http://127.0.0.1:123/s/{token.upper()}', f'http://127.0.0.1:123/s/{token[:-1]}',
                  f'http://127.0.0.1:123/s/{token}\n', None]
        for index, value in enumerate(values):
            with self.subTest(case=index):
                self.write('payment-bootstrap.json', {**self.boot, 'bootstrapUrl': value})
                with self.assertRaisesRegex(Stop, 'BOOTSTRAP_URL'):
                    self.open()
        self.assertEqual(self.calls, [])
        self.assertFalse((self.root / b.MARKER).exists())

    def test_foreign_operation_root_envelope_attempt_and_journal_refuse(self):
        for name, value in [
            ('payment-bootstrap.json', {**self.boot, 'operationId': '0' * 36}),
            ('attempt.json', {'operationId': self.operation, 'planSha256': '0' * 64}),
            ('journal.json', {**self.j, 'operationId': '0' * 36}),
            ('journal.json', {**self.j, 'planSha256': '0' * 64}),
            ('journal.json', {**self.j, 'nativeEntry': {'envelopeSha256': '0' * 64}}),
            ('journal.json', {**self.j, 'payment': {**self.j['payment'], 'scopeSha256': '0' * 64}}),
            ('envelope.json', {**self.e, 'sourceManifestSha256': '0' * 64}),
            ('envelope.json', {**self.e, 'decision': {}}),
        ]:
            original = read(self.root / name)
            self.write(name, value)
            with self.subTest(file=name), self.assertRaises(Exception):
                self.open()
            self.write(name, original)
        with self.assertRaises(Stop):
            b.open_bootstrap(self.root / '..' / self.root.name, presenter=self.present)
        self.assertEqual(self.calls, [])

    def test_wrong_phase_closed_bridge_and_closeout_refuse(self):
        for changes in ({'phase': 'QUALIFIED'}, {'phase': 'STOPPED'}, {'phase': 'CLOSED'},
                        {'bridgeClosed': True}, {'bridgeClosed': 0}, {'enableIntent': False},
                        {'endpointDisabled': True}):
            self.write('journal.json', {**self.j, 'payment': {**self.j['payment'], **changes}})
            with self.assertRaisesRegex(Stop, 'BOOTSTRAP_NOT_ATTENDED'):
                self.open()
        self.write('journal.json', self.j)
        for name in ('closeout.json', 'independent-closeout.json', 'result.json', 'work-result.json',
                     'journal-next.json', 'journal.json.auth-next', 'journal.json.payment-next'):
            reserve(self.root / name, {})
            with self.assertRaisesRegex(Stop, 'BOOTSTRAP_CLOSED_OR_PENDING'):
                self.open()
            (self.root / name).unlink()
        self.assertEqual(self.calls, [])

    def test_payment_deadline_and_clock_rollback_refuse(self):
        end = datetime.datetime.fromisoformat(self.e['payment']['workEnd'].replace('Z', '+00:00')).timestamp()
        with self.assertRaisesRegex(Stop, 'BOOTSTRAP_PAYMENT_DEADLINE'):
            self.open(clock=lambda: end)
        ticks = iter([time.time()] * 3 + [time.time() - 2] * 20)
        with self.assertRaisesRegex(Stop, 'CLOCK_ROLLBACK'):
            self.open(clock=lambda: next(ticks))
        self.assertEqual(self.calls, [])

    def test_final_dispatch_clock_rollback_consumes_marker_without_opening(self):
        now = time.time()
        ticks = iter([now] * 5 + [now - 2] * 20)
        with self.assertRaisesRegex(Stop, 'CLOCK_ROLLBACK'):
            self.open(clock=lambda: next(ticks))
        self.assertTrue((self.root / b.MARKER).exists())
        self.assertEqual(self.calls, [])

    def test_private_symlink_mode_hardlink_size_and_owner_refuse(self):
        path = self.root / 'payment-bootstrap.json'
        for mutation in ('symlink', 'mode', 'hardlink', 'size', 'owner'):
            with self.subTest(kind=mutation):
                self.write(path.name, self.boot)
                if mutation == 'symlink':
                    path.unlink(); path.symlink_to(self.root / 'envelope.json')
                elif mutation == 'mode':
                    path.chmod(0o644)
                elif mutation == 'hardlink':
                    path.unlink(); os.link(self.root / 'envelope.json', path)
                elif mutation == 'size':
                    path.write_text(' ' * (b.MAX_BYTES + 1))
                with patch.object(b.os, 'getuid', return_value=-1) if mutation == 'owner' else contextlib.nullcontext():
                    with self.assertRaises(Stop):
                        self.open()
        self.assertEqual(self.calls, [])

    def test_purge_prevents_dispatch_and_one_shot_marker_survives_purge(self):
        self.open()
        self.assertTrue(purge(self.root, self.operation))
        self.assertTrue((self.root / b.MARKER).exists())
        self.assertFalse((self.root / 'payment-bootstrap.json').exists())
        with self.assertRaises(FileNotFoundError):
            self.open()
        self.assertEqual(self.calls, [True])

    def test_dispatch_failure_consumes_marker_and_cli_suppresses_private_error(self):
        def fail(url, timeout):
            raise RuntimeError(url)
        with self.assertRaisesRegex(Stop, '^BOOTSTRAP_OPEN_UNCONFIRMED$'):
            b.open_bootstrap(self.root, presenter=fail)
        with self.assertRaises(FileExistsError):
            self.open()
        output = io.StringIO()
        with patch.object(b, 'open_bootstrap', side_effect=RuntimeError(self.boot['bootstrapUrl'])), contextlib.redirect_stdout(output):
            self.assertEqual(b.main([str(self.root)]), 2)
        self.assertEqual(output.getvalue(), '{"status":"BROWSER_OPEN_REFUSED_OR_UNCONFIRMED"}\n')

    def test_concurrent_openers_dispatch_once(self):
        def run(_):
            try:
                self.open()
                return 'opened'
            except FileExistsError:
                return 'consumed'
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
            self.assertEqual(sorted(pool.map(run, range(2))), ['consumed', 'opened'])
        self.assertEqual(self.calls, [True])

    def test_proof_envelope_cannot_launch_chrome(self):
        with patch.object(b, 'open_chrome', side_effect=AssertionError('CHROME_FORBIDDEN')) as chrome:
            with self.assertRaisesRegex(Stop, 'BOOTSTRAP_PRESENTER_AUTHORITY'):
                b.open_bootstrap(self.root)
            chrome.assert_not_called()

    def test_chrome_url_only_uses_private_stdin_and_output_is_discarded(self):
        with patch.object(b.subprocess, 'run', return_value=subprocess.CompletedProcess([], 0)) as run:
            b.open_chrome(self.boot['bootstrapUrl'], 3)
        argv = run.call_args.args[0]
        kwargs = run.call_args.kwargs
        self.assertFalse(any(self.boot['bootstrapUrl'] in arg for arg in argv))
        self.assertTrue(kwargs['input'] == self.boot['bootstrapUrl'].encode('ascii'))
        self.assertEqual(kwargs['stdout'], subprocess.DEVNULL)
        self.assertEqual(kwargs['stderr'], subprocess.DEVNULL)
        self.assertEqual(kwargs['timeout'], 3)

    def test_production_jxa_dispatches_loopback_and_closes_only_owned_window(self):
        observed = threading.Event()
        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_args):
                pass
            def do_GET(self):
                if self.path == '/s/' + 'b' * 64:
                    observed.set()
                self.send_response(200)
                self.send_header('Content-Type', 'text/html')
                self.send_header('Cache-Control', 'no-store')
                self.end_headers()
                self.wfile.write(b'<title>Signmons CC1 local browser fixture</title>Local fixture only')
        server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        # Execute the exact production dispatch, then inspect and close only the
        # window it just created. No existing windows, accounts or URLs are read.
        suffix = r'''
try {
 const until = Date.now() + 5000;
 while (Date.now() < until && ownedWindow.tabs[0].title() !== 'Signmons CC1 local browser fixture')
   $.NSRunLoop.currentRunLoop.runUntilDate($.NSDate.dateWithTimeIntervalSinceNow(0.05));
 if (ownedWindow.mode() !== 'incognito' || ownedWindow.tabs[0].title() !== 'Signmons CC1 local browser fixture')
   throw Error('LOCAL_FIXTURE_UNCONFIRMED');
} finally { ownedWindow.close(); }
void 0;'''
        with patch.object(b, 'CHROME_SCRIPT', b.CHROME_SCRIPT + suffix):
            b.open_chrome('http://127.0.0.1:' + str(server.server_port) + '/s/' + 'b' * 64, 10)
        self.assertTrue(observed.is_set(), 'LOCAL_BROWSER_NOT_OBSERVED')

    def test_actual_loopback_bridge_and_headless_chrome_handoff(self):
        (self.root / 'payment-bootstrap.json').unlink()
        process = subprocess.Popen(['/Users/debynyhanbanks/.nvm/versions/node/v24.12.0/bin/node', str(b.HERE / 'bootstrap_browser_fixture.mjs')],
                                   stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                                   text=True)
        def stop():
            if process.poll() is None:
                try:
                    process.communicate('stop\n', timeout=5)
                except (subprocess.TimeoutExpired, BrokenPipeError):
                    process.kill(); process.communicate(timeout=5)
        self.addCleanup(stop)
        def line():
            with selectors.DefaultSelector() as selector:
                selector.register(process.stdout, selectors.EVENT_READ)
                self.assertTrue(selector.select(timeout=20), 'LOCAL_BROWSER_FIXTURE_TIMEOUT')
                return process.stdout.readline().strip()
        process.stdin.write(json.dumps({'root': str(self.root)}) + '\n'); process.stdin.flush()
        self.assertEqual(line(), 'LOCAL_BRIDGE_READY')
        status = []
        def present(url, timeout):
            process.stdin.write(json.dumps({'bootstrapUrl': url}) + '\n'); process.stdin.flush()
            status.append(line())
            self.assertEqual(status[-1], 'LOCAL_BROWSER_HANDOFF_PASS')
        try:
            result = b.open_bootstrap(self.root, presenter=present)
        except Stop:
            if status and status[-1].startswith('LOCAL_BROWSER_FIXTURE_REFUSED_'):
                self.fail(status[-1])
            raise
        self.assertEqual(result['status'], 'BROWSER_OPEN_DISPATCHED')


if __name__ == '__main__':
    unittest.main()
