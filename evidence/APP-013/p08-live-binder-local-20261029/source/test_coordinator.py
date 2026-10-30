"""Isolated coordinator tests across the existing serialized and runtime ports."""
import copy
import os
import signal
import subprocess
import tempfile
import unittest
from pathlib import Path

import coordinator as c

modules = c.sources()
bridge, restore = modules["bridge"], modules["restore"]
import sys
sys.path.insert(0, str(bridge.ROOT))
sys.path.insert(0, str(restore.ROOT))
import test_bridge
import test_restore


class CoordinatorTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="p08-coordinator-", dir="/private/tmp")
        os.chmod(self.temp.name, 0o700)
        self.directory = Path(self.temp.name)
        self.now = test_bridge.NOW
        self.clock = lambda: self.now
        self.p = test_bridge.plan()
        self.p["serviceRetention"] = "RETAIN_ENABLED_AFTER_KEY_DELETE"
        self.p["window"]["purgeEnd"] = test_bridge.iso(950)
        self.a = {"decision": "APPROVE_LOCAL_SINGLE_COORDINATOR", "externalActionAuthorized": False,
                  "operationId": self.p["operationId"], "planSha256": c.digest(self.p)}
        self.q = {"roleAclSha256": restore.digest([]), "runtimeEnvironmentSha256": "0" * 64}
        self.runtime = test_restore.Fake({**self.p, "iam": []})
        self.transport = test_bridge.Fake(self.p)
        self.receipt = None
        self.account = {"appDisabled": True, "firebaseDisabled": True, "tokensRevoked": True, "sessionsAbsent": True}
        self.runtime_closeout = {"retired": True, "normalTraffic100": True, "sessionsAbsent": True,
                                 "privatePlansAbsent": True}
        self.auth_proof = copy.deepcopy(bridge.packet.AUTH_PROOF)
        self.ports = bridge.Ports(self.p, self.transport.cli, self.transport.https, self.auth,
                                  lambda: self.account, lambda: self.runtime_closeout, self.clock)

    def tearDown(self):
        self.temp.cleanup()

    def auth(self, receipt):
        self.receipt = receipt
        return copy.deepcopy(self.auth_proof)

    def make(self, closeout=False):
        return c.Coordinator(self.p, self.a, self.q, self.runtime, self.ports,
                             self.directory, self.clock, closeout)

    def test_exact_local_lifecycle_and_private_journal(self):
        result = self.make().run()
        self.assertEqual(result["status"], "LOCAL_COORDINATOR_CLOSED")
        self.assertFalse(result["liveAuthorization"])
        self.assertFalse(result["authProofReady"])
        self.assertEqual(result["residuals"], [])
        self.assertIsNotNone(result["childResultSha256"])
        self.assertFalse(any(self.runtime.state.values()))
        self.assertFalse(self.transport.bindings)
        self.assertIn("deleteTime", self.transport.key)
        self.assertEqual(os.stat(self.directory / "journal.json").st_mode & 0o777, 0o600)
        journal = (self.directory / "journal.json").read_text()
        for secret in ("synthetic-only-key", "password", "keyString", "debynyhan@"):
            self.assertNotIn(secret, journal)
        self.assertEqual(len(c.private_file(self.directory / "journal.json")["runtimeOwned"]),
                         len(restore.operations({**self.p, "iam": []})))

    def test_local_authority_and_source_refusal(self):
        self.a["externalActionAuthorized"] = True
        with self.assertRaises(c.Stop): self.make()
        self.a["externalActionAuthorized"] = False
        self.p["tenantId"] = "foreign"
        self.a["planSha256"] = c.digest(self.p)
        with self.assertRaises(c.Stop): self.make()
        self.assertEqual(self.transport.calls, [])

    def test_key_collision_refuses_without_deleting_foreign_key(self):
        self.transport.key = self.transport.make_key()
        result = self.make().run()
        self.assertEqual(result["failure"], "KEY_COLLISION")
        self.assertNotIn("deleteTime", self.transport.key)
        self.assertFalse(self.transport.bindings)
        self.assertFalse(any(self.runtime.state.values()))

    def test_lost_create_response_stays_residual_and_no_second_create(self):
        self.transport.fail = "create"
        result = self.make().run()
        self.assertEqual(result["status"], "LOCAL_COORDINATOR_CONTAINMENT_UNCONFIRMED")
        self.assertIn("KEY_CREATE", result["residuals"])
        self.assertIn("OWNED_KEY", result["residuals"])
        self.assertEqual(sum("/keys?keyId=" in d[1]["url"] for d in self.transport.calls if d[0] == "https"), 1)

    def test_lost_delete_response_is_not_repeated_after_cutoff(self):
        self.transport.fail = "delete"
        first = self.make().run()
        self.assertIn("OWNED_KEY", first["residuals"])
        self.now = test_bridge.NOW + 200
        second = self.make(closeout=True).closeout(independent=True)
        self.assertEqual(second["residuals"], [])
        self.assertEqual(sum(d[1]["method"] == "DELETE" for d in self.transport.calls if d[0] == "https"), 1)

    def test_runtime_unknown_and_cleanup_failure_stay_residual(self):
        self.runtime.unknown = ("version", restore.SECRETS[0])
        self.runtime.cleanup_fail = ("version", restore.SECRETS[0])
        result = self.make().run()
        self.assertIn("RUNTIME:version:" + restore.SECRETS[0], result["residuals"])
        self.assertIn("RUNTIME_version:" + restore.SECRETS[0], result["residuals"])
        self.assertTrue(self.runtime.state[("version", restore.SECRETS[0])])

    def test_auth_failure_closes_account_and_does_not_claim_proof(self):
        self.auth_proof["sessionsAbsent"] = False
        result = self.make().run()
        self.assertEqual(result["failure"], "AUTH_PROOF_REFUSED")
        self.assertNotIn("ACCOUNT_SESSION", result["residuals"])
        self.assertFalse(result["authProofReady"])

    def test_independent_closeout_one_use_and_foreign_journal(self):
        first = self.make().run()
        self.assertEqual(first["residuals"], [])
        self.now = test_bridge.NOW + 200
        operation = self.make(closeout=True)
        self.assertEqual(operation.closeout(independent=True)["residuals"], [])
        with self.assertRaises(FileExistsError): operation.closeout(independent=True)

    def test_deadline_and_signal_stop_then_cleanup(self):
        def tick(): self.now = test_bridge.NOW + 121
        self.runtime.tick = tick
        result = self.make().run()
        self.assertEqual(result["failure"], "DEADLINE")
        self.assertFalse(any(self.runtime.state.values()))
        self.assertEqual(result["status"], "LOCAL_COORDINATOR_CONTAINMENT_UNCONFIRMED")
        self.assertTrue(any(x.startswith("RUNTIME:") for x in result["residuals"]))

    def test_signal_stops_before_next_mutation_and_restores_handler(self):
        for signum in (signal.SIGINT, signal.SIGTERM):
            with self.subTest(signum=signum):
                self.runtime.signal = ("identity", restore.IDENTITY)
                self.runtime.signalType = signum
                previous = signal.getsignal(signum)
                result = self.make().run()
                self.assertEqual(result["failure"], "INTERRUPTED")
                self.assertFalse(any(self.runtime.state.values()))
                self.assertEqual(signal.getsignal(signum), previous)
                (self.directory / "attempt.json").unlink()
                (self.directory / "journal.json").unlink()
                (self.directory / "closeout.json").unlink()

    def test_concurrent_one_use_reservation_has_one_winner(self):
        target = self.directory / "race.json"
        script = "import coordinator,sys;coordinator.reserve(sys.argv[1],{'operationId':'fixture'})"
        tasks = [subprocess.Popen([sys.executable, "-B", "-c", script, str(target)],
                                  cwd=str(c.ROOT), stdout=subprocess.PIPE, stderr=subprocess.PIPE) for _ in range(2)]
        try:
            for task in tasks: task.communicate(timeout=5)
            self.assertEqual(sum(task.returncode == 0 for task in tasks), 1)
        finally:
            for task in tasks:
                if task.poll() is None: task.kill(); task.wait()

    def test_native_refused(self):
        with self.assertRaises(c.Stop): c.native()


if __name__ == "__main__": unittest.main()
