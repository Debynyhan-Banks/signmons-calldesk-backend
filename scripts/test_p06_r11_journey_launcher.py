"""Synthetic prelaunch diagnostics; all external ports are blocked or faked."""
import concurrent.futures
import contextlib
import hashlib
import io
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

import p06_r11_journey_launcher as m


class Tests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.review = m.core.Review(self.root, 'fictional', 'https://fictional.invalid',
                                   100, 1100, 500, 800, 1000)

    def invoke(self, now=110, validation_error=None, reserve_error=None, coordinator_error=None):
        out = io.StringIO()
        with contextlib.redirect_stdout(out), patch.object(m.sys, 'argv', ['wrapper', '--run']), \
                patch.object(m.os, 'isatty', return_value=True), patch.object(m.signal, 'signal'), \
                patch.object(m.time, 'time', return_value=now), \
                patch.object(m, 'validate', side_effect=validation_error, return_value=self.review), \
                patch.object(m.core, 'coordinate', side_effect=coordinator_error) as coordinate:
            if reserve_error:
                with patch.object(m, 'reserve_launch', side_effect=reserve_error):
                    status = m.main(self.root)
            else:
                status = m.main(self.root)
        return status, out.getvalue(), coordinate

    def test_early_and_exact_cutoff_block_before_external_ports(self):
        for now, expected in [(99, 'WINDOW_NOT_OPEN'), (320, 'START_CUTOFF_PASSED'),
                              (1200, 'START_CUTOFF_PASSED')]:
            with self.subTest(now=now):
                status, out, coord = self.invoke(now)
                self.assertEqual(status, 1)
                self.assertIn('R11_PRELAUNCH_' + expected, out)
                self.assertIn('EST', out)
                self.assertIn('strictly before', out)
                coord.assert_not_called()
                self.assertFalse((self.root / 'launcher-attempt.json').exists())
                receipt = json.loads((self.root / 'prelaunch-stop.json').read_text())
                self.assertEqual(receipt['stage'], 'RESERVE')
                self.assertFalse(receipt['automaticRetryAllowed'])
                self.assertFalse(receipt['externalActionsStartedByThisInvocation'])
                (self.root / 'prelaunch-stop.json').unlink()

    def test_allowed_boundaries_reserve_once(self):
        for now in [100, 319.999]:
            with tempfile.TemporaryDirectory() as d:
                r = m.core.Review(Path(d), 'fictional', 'https://fictional.invalid',
                                 100, 1100, 500, 800, 1000)
                m.reserve_launch(r, now)
                with self.assertRaises(m.LaunchRefusal) as e:
                    m.reserve_launch(r, now)
                self.assertEqual(e.exception.code, 'PACKAGE_ALREADY_USED')

    def test_concurrent_reservation_has_one_winner(self):
        def attempt(_):
            try:
                m.reserve_launch(self.review, 110)
                return 'WINNER'
            except m.LaunchRefusal as e:
                return e.code
        with concurrent.futures.ThreadPoolExecutor(2) as pool:
            outcomes = list(pool.map(attempt, range(2)))
        self.assertCountEqual(outcomes, ['WINNER', 'PACKAGE_ALREADY_USED'])

    def test_existing_action_and_stop_receipts_block(self):
        for marker in ['login-attempt.json', 'prelaunch-stop.json']:
            p = self.root / marker
            p.write_text('{}')
            _, out, coord = self.invoke()
            self.assertIn('PACKAGE_ALREADY_USED', out)
            coord.assert_not_called()
            if marker == 'prelaunch-stop.json':
                self.assertEqual(p.read_text(), '{}')
            for f in self.root.iterdir():
                f.unlink()

    def test_binding_check_uses_real_validator(self):
        plan = self.root / 'r10-review-plan.json'
        plan.write_text('{}')
        (self.root / 'helper-binding.json').write_text(json.dumps({
            'files': {plan.name: hashlib.sha256(plan.read_bytes()).hexdigest()}}))
        plan.write_text('{"private":"never print"}')
        with self.assertRaises(m.LaunchRefusal) as e:
            m.validate(self.root)
        self.assertEqual(e.exception.code, 'PACKAGE_INTEGRITY_MISMATCH')

    def test_validation_failures_and_interrupt_are_sanitized(self):
        cases = [(m.LaunchRefusal('PACKAGE_INTEGRITY_MISMATCH'), 'PACKAGE_INTEGRITY_MISMATCH'),
                 (ValueError('PRIVATE_PASSWORD token body'), 'PACKAGE_VALIDATION_FAILED'),
                 (FileNotFoundError('PRIVATE_PASSWORD'), 'LOCAL_FILE_ERROR'),
                 (KeyboardInterrupt('PRIVATE_PASSWORD'), 'INTERRUPTED')]
        for error, code in cases:
            _, out, coord = self.invoke(validation_error=error)
            coord.assert_not_called()
            self.assertIn('R11_PRELAUNCH_' + code, out)
            receipt = (self.root / 'prelaunch-stop.json').read_text()
            self.assertNotIn('PRIVATE_PASSWORD', out + receipt)
            self.assertNotIn('startEastern', receipt)
            (self.root / 'prelaunch-stop.json').unlink()

    def test_reservation_io_failure_never_reaches_coordinator(self):
        _, out, coord = self.invoke(reserve_error=PermissionError('private path'))
        self.assertIn('LOCAL_FILE_ERROR', out)
        self.assertNotIn('private path', out)
        coord.assert_not_called()

    def test_unexpected_reservation_failure_is_unconfirmed(self):
        _, out, coord = self.invoke(reserve_error=RuntimeError('private payload'))
        self.assertIn('RESERVATION_UNCONFIRMED', out)
        self.assertNotIn('private payload', out)
        coord.assert_not_called()

    def test_failed_receipt_write_is_not_reported_saved(self):
        out = io.StringIO()
        with patch.object(m.os, 'open', side_effect=PermissionError('private')), contextlib.redirect_stdout(out):
            m.report_prelaunch_refusal(self.root, 'RESERVE', PermissionError(), 110, self.review)
        self.assertIn('could not be saved', out.getvalue())
        self.assertNotIn('receipt saved', out.getvalue())

    def test_receipt_is_private_exclusive_and_symlink_is_not_followed(self):
        target = self.root / 'untouched'
        target.write_text('keep')
        (self.root / 'prelaunch-stop.json').symlink_to(target)
        with contextlib.redirect_stdout(io.StringIO()):
            m.report_prelaunch_refusal(self.root, 'RESERVE', KeyboardInterrupt(), 110)
        self.assertEqual(target.read_text(), 'keep')
        (self.root / 'prelaunch-stop.json').unlink()
        with contextlib.redirect_stdout(io.StringIO()):
            m.report_prelaunch_refusal(self.root, 'RESERVE', KeyboardInterrupt(), 110)
        self.assertEqual((self.root / 'prelaunch-stop.json').stat().st_mode & 0o777, 0o600)

    def test_after_reservation_cannot_claim_no_external_action(self):
        _, out, coord = self.invoke(coordinator_error=RuntimeError('PRIVATE_PASSWORD'))
        coord.assert_called_once()
        self.assertTrue((self.root / 'launcher-attempt.json').exists())
        self.assertIn('R11_POST_LAUNCH_RESULT_UNCONFIRMED', out)
        self.assertNotIn('R11_PRELAUNCH', out)
        self.assertNotIn('PRIVATE_PASSWORD', out)
        self.assertFalse((self.root / 'prelaunch-stop.json').exists())

    def test_eastern_daylight_saving_label(self):
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            m.report_prelaunch_refusal(self.root, 'RESERVE', KeyboardInterrupt(), 1791810900)
        self.assertIn('2026-10-12 09:15:00 AM EDT', out.getvalue())

    def test_direct_cli_is_disabled(self):
        result = subprocess.run([sys.executable, '-B', m.__file__, '--run'],
                                capture_output=True, text=True, check=False)
        self.assertEqual(result.returncode, 2)
        self.assertIn('no action taken', result.stdout)

    def test_original_browser_wait_and_run_are_inherited(self):
        self.assertIs(m.JourneyPorts.run, m.core.ProductionPorts.run)
        self.assertIs(m.JourneyPorts.wait_browser, m.core.ProductionPorts.wait_browser)


if __name__ == '__main__':
    unittest.main()
