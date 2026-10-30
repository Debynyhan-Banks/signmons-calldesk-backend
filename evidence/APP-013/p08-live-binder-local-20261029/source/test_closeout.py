"""Actual historical packet closeout through a cleanup-only local seam."""
import os
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

import closeout

sys.path.insert(0, str(closeout.BRIDGE.parent))
from test_bridge import Fake, NOW, plan  # noqa: E402


class CloseoutTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        os.chmod(self.temp.name, 0o700)
        self.p = plan()
        self.fake = Fake(self.p)
        self.now = NOW
        self.ports = closeout.bridge.Ports(
            self.p, self.fake.cli, self.fake.https,
            lambda _receipt: dict(closeout.packet.AUTH_PROOF),
            lambda: {"appDisabled": True, "firebaseDisabled": True,
                     "tokensRevoked": True, "sessionsAbsent": True},
            lambda: {"retired": True, "normalTraffic100": True,
                     "sessionsAbsent": True, "privatePlansAbsent": True},
            lambda: self.now,
        )

    def tearDown(self):
        self.temp.cleanup()

    def test_independent_closeout_after_start_cutoff_reuses_exact_journal(self):
        first = closeout.bridge.BoundPacket(self.p, self.ports, self.temp.name,
                                            clock=lambda: self.now).run()
        self.assertEqual(first["residuals"], [])
        before = len(self.fake.calls)
        self.now = NOW + 70  # after the work-start cutoff, before cleanupEnd
        result = closeout.closeout_only(self.p, self.ports, self.temp.name, lambda: self.now)
        self.assertEqual(result["residuals"], [])
        self.assertTrue(Path(self.temp.name, "independent-closeout.json").exists())
        self.assertFalse(any("add-iam-policy-binding" in c[1] for c in self.fake.calls[before:] if c[0] == "cli"))
        self.assertFalse(any("/keys?keyId=" in c[1]["url"] for c in self.fake.calls[before:] if c[0] == "https"))

    def test_second_independent_closeout_refuses_one_use(self):
        closeout.bridge.BoundPacket(self.p, self.ports, self.temp.name, clock=lambda: self.now).run()
        self.now = NOW + 70
        closeout.closeout_only(self.p, self.ports, self.temp.name, lambda: self.now)
        before = len(self.fake.calls)
        with self.assertRaises(FileExistsError):
            closeout.closeout_only(self.p, self.ports, self.temp.name, lambda: self.now)
        self.assertEqual(len(self.fake.calls), before)

    def test_foreign_plan_and_expired_cleanup_refuse_without_transport(self):
        closeout.bridge.BoundPacket(self.p, self.ports, self.temp.name, clock=lambda: self.now).run()
        before = len(self.fake.calls)
        self.now = NOW + 70
        foreign = dict(self.p, jobId="foreign")
        with self.assertRaises(closeout.packet.Stop):
            closeout.closeout_only(foreign, self.ports, self.temp.name, lambda: self.now)
        self.now = NOW + 900
        with self.assertRaises(closeout.packet.Stop):
            closeout.closeout_only(self.p, self.ports, self.temp.name, lambda: self.now)
        self.assertEqual(len(self.fake.calls), before)

    def test_native_entry_refuses(self):
        self.assertEqual(closeout.native(), 2)

    def test_world_readable_journal_refuses_before_transport(self):
        closeout.bridge.BoundPacket(self.p, self.ports, self.temp.name, clock=lambda: self.now).run()
        self.now = NOW + 70
        before = len(self.fake.calls)
        os.chmod(Path(self.temp.name, "journal.json"), 0o644)
        with self.assertRaises(closeout.packet.Stop):
            closeout.closeout_only(self.p, self.ports, self.temp.name, lambda: self.now)
        self.assertEqual(len(self.fake.calls), before)

    def test_source_lock_refuses_changed_local_code(self):
        self.assertTrue(closeout.verify_bundle())
        original = closeout.HERE
        copy = Path(self.temp.name, "copy")
        shutil.copytree(original, copy)
        (copy / "closeout.py").write_bytes((copy / "closeout.py").read_bytes() + b"\n# drift\n")
        try:
            closeout.HERE = copy
            with self.assertRaisesRegex(RuntimeError, "CLOSEOUT_SOURCE_DRIFT"):
                closeout.verify_bundle()
        finally:
            closeout.HERE = original


if __name__ == "__main__":
    unittest.main()
