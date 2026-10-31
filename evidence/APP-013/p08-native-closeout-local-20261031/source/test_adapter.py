"""Injected serialized-interface matrix for the disabled P08 closeout adapter."""
import copy
import datetime as dt
import json
import os
import stat
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

import adapter as a

c, bridge, restore = a.load_sources()
sys.path.insert(0, str(bridge.ROOT))
import test_bridge


class AdapterTests(unittest.TestCase):
    def setUp(self):
        self.now = test_bridge.NOW
        self.clock = lambda: self.now
        self.p = test_bridge.plan()
        self.p["serviceRetention"] = "RETAIN_ENABLED_AFTER_KEY_DELETE"
        self.p["window"]["purgeEnd"] = test_bridge.iso(950)
        self.approval = {"decision": "APPROVE_LOCAL_SINGLE_COORDINATOR", "externalActionAuthorized": False,
                         "operationId": self.p["operationId"], "planSha256": c.digest(self.p)}
        self.q = {"roleAclSha256": restore.digest([]),
                  "runtimeEnvironmentSha256": restore.digest([{"name": "LOCAL_ONLY", "value": "synthetic"}])}
        self.target = {"id": "10000000-0000-4000-8000-000000000001", "tenantId": self.p["tenantId"],
                       "email": "operator@fixture.invalid", "fullName": "Signmons Test Administrator", "role": "ADMIN"}
        self.app = {**self.target, "status": "DISABLED"}
        self.fb = {"uid": self.target["id"], "email": self.target["email"],
                   "displayName": self.target["fullName"], "disabled": True, "emailVerified": False,
                   "customClaims": {"tenantId": self.target["tenantId"], "role": "admin", "testOnly": True},
                   "tokensValidAfterTime": dt.datetime.fromtimestamp(self.now + 1, dt.timezone.utc).isoformat()}
        self.sessions = 0
        self.transport = test_bridge.Fake(self.p)
        self.runtime_state = {x: False for x in restore.operations({**self.p, "iam": []})}
        self.drift = None
        self.tmp = tempfile.TemporaryDirectory(prefix="p08-adapter-proof-", dir="/private/tmp")
        os.chmod(self.tmp.name, 0o700)
        self.directory = Path(self.tmp.name)
        self.private = Path("/private/tmp/p08-coordinator-private-" + self.p["operationId"])
        self.private.mkdir(mode=0o700)
        self.receipt = None
        self.runtime = restore.NativeAdapter(None, "", runner=self.cloud, sql=self.sql, clock=self.clock)
        self.bound = self.make()

    def tearDown(self):
        self.tmp.cleanup()
        for path in self.private.iterdir(): path.unlink()
        self.private.rmdir()

    def handoff(self, receipt):
        self.receipt = receipt
        result = subprocess.run(["node", str(Path(a.HERE, "fixture_handoff.mjs"))],
                                input=json.dumps(receipt), text=True, capture_output=True, timeout=8)
        self.assertEqual(result.returncode, 0, result.stderr[-1000:])
        return json.loads(result.stdout)

    def make(self):
        return a.BoundReadbacks(self.p, self.target, self.q, self.runtime,
                                self.transport.cli, self.transport.https, self.handoff,
                                lambda: copy.deepcopy(self.app), lambda: copy.deepcopy(self.fb),
                                lambda: self.sessions, self.private, self.clock)

    def execute(self):
        return c.Coordinator(self.p, self.approval, self.q, self.runtime, self.bound.ports,
                             self.directory, self.clock).run()

    def cloud(self, args, deadline):
        if args[:2] == ["auth", "list"]: return restore.OWNER
        if args[:3] == ["run", "revisions", "describe"]:
            return {"spec": {"serviceAccountName": restore.IDENTITY,
                             "containers": [{"image": "foreign" if self.drift == "image" else restore.IMAGE,
                                             "env": [{"name": "LOCAL_ONLY", "value": "synthetic"}]}]}}
        if args[:3] == ["run", "services", "describe"]:
            rows = [{"revisionName": restore.NORMAL, "percent": 100}]
            if self.runtime_state[("tag", restore.TAG)]: rows.append({"tag": restore.TAG, "revisionName": restore.CANDIDATE, "percent": 0})
            if self.drift == "traffic": rows[0]["percent"] = 99
            return {"status": {"traffic": rows}}
        if args[:3] == ["iam", "service-accounts", "describe"]:
            return {"email": restore.IDENTITY, "disabled": not self.runtime_state[("identity", restore.IDENTITY)]}
        if args[:3] == ["secrets", "versions", "describe"]:
            name = next(x.split("=", 1)[1] for x in args if x.startswith("--secret="))
            return {"state": "ENABLED" if self.runtime_state[("version", name)] else "DISABLED"}
        if "get-iam-policy" in args and args[0] == "secrets":
            name = args[2]
            return {"bindings": [{"members": ["serviceAccount:" + restore.IDENTITY],
                                  "role": "roles/secretmanager.secretAccessor"}]} if self.runtime_state[("secretBinding", name)] else {}
        for kind, name in restore.operations({**self.p, "iam": []}):
            if kind == "role": continue
            for on in (True, False):
                if args == restore.command({**self.p, "iam": []}, kind, name, on):
                    self.runtime_state[(kind, name)] = on
                    return {}
        raise AssertionError("UNLISTED_NATIVE_VECTOR")

    def sql(self, query, deadline):
        if query == restore.role_sql(True, self.p["window"]["workEnd"]):
            self.runtime_state[("role", restore.ROLE)] = True
            return ""
        if query == restore.role_sql(False):
            self.runtime_state[("role", restore.ROLE)] = False
            return ""
        self.assertIn("aclexplode", query)
        enabled = self.runtime_state[("role", restore.ROLE)]
        return json.dumps({"count": 1, "login": enabled, "limit": 6 if enabled else 0,
                           "expires": self.p["window"]["workEnd"].replace("Z", "+00:00") if enabled else "2000-01-01T00:00:00+00:00",
                           "expired": not enabled, "unsafe": False, "memberships": 0, "owned": 0,
                           "sessions": 0, "acl": []})

    def test_coordinator_with_native_serialization_and_derived_readbacks(self):
        result = self.execute()
        self.assertEqual(result["status"], "LOCAL_COORDINATOR_CLOSED")
        self.assertFalse(result["liveAuthorization"])
        self.assertFalse(result["authProofReady"])
        self.assertFalse(any(self.runtime_state.values()))
        self.assertEqual(self.receipt["operationId"], self.p["operationId"])
        self.assertFalse(self.transport.bindings)
        journal = (self.directory / "journal.json").read_text()
        self.assertNotIn("SYNTHETIC_IN_MEMORY_TOKEN", journal)
        self.assertNotIn(self.target["email"], journal)

    def test_bound_independent_closeout_after_cutoff(self):
        self.assertEqual(self.execute()["residuals"], [])
        self.now = test_bridge.NOW + 200
        result = c.Coordinator(self.p, self.approval, self.q, self.runtime, self.bound.ports,
                               self.directory, self.clock, closeout=True).closeout(independent=True)
        self.assertEqual(result["residuals"], [])
        self.assertFalse(result["liveAuthorization"])

    def test_account_firebase_revocation_and_session_disagreement(self):
        for mode in ("app", "claims", "revocation", "sessions"):
            with self.subTest(mode=mode):
                saved = copy.deepcopy((self.app, self.fb, self.sessions))
                self.bound.auth_started = self.now
                if mode == "app": self.app["status"] = "ACTIVE"
                if mode == "claims": self.fb["customClaims"]["testOnly"] = False
                if mode == "revocation": self.fb["tokensValidAfterTime"] = dt.datetime.fromtimestamp(self.now - 1, dt.timezone.utc).isoformat()
                if mode == "sessions": self.sessions = 1
                with self.assertRaises(a.Stop): self.bound.account_readback()
                self.app, self.fb, self.sessions = saved

    def test_private_path_modes_and_unknown_names_fail_closed(self):
        self.assertTrue(a.private_absent(self.private, self.p["operationId"]))
        file = self.private / "auth-plan.json"
        file.write_text("synthetic")
        os.chmod(file, 0o600)
        with self.assertRaises(a.Stop): a.private_absent(self.private, self.p["operationId"])
        file.unlink()
        file.symlink_to(self.directory)
        with self.assertRaises(a.Stop): a.private_absent(self.private, self.p["operationId"])
        file.unlink()
        os.mkfifo(file, 0o600)
        with self.assertRaises(a.Stop): a.private_absent(self.private, self.p["operationId"])
        file.unlink()
        file.write_text("synthetic")
        os.chmod(file, 0o644)
        with self.assertRaises(a.Stop): a.private_absent(self.private, self.p["operationId"])
        file.unlink()
        foreign = self.private / "foreign.json"
        foreign.write_text("synthetic")
        with self.assertRaises(a.Stop): a.private_absent(self.private, self.p["operationId"])

    def test_runtime_drift_is_not_a_clean_readback(self):
        self.runtime.q = self.q
        for drift in ("image", "traffic"):
            self.drift = drift
            with self.subTest(drift=drift), self.assertRaises((a.Stop, restore.Stop)):
                self.bound.runtime_readback()

    def test_combined_auth_disagreement_stays_residual(self):
        self.sessions = 1
        result = self.execute()
        self.assertEqual(result["status"], "LOCAL_COORDINATOR_CONTAINMENT_UNCONFIRMED")
        self.assertIn("ACCOUNT_SESSION", result["residuals"])
        self.assertFalse(result["authProofReady"])

    def test_late_readback_refuses(self):
        self.bound.auth_started = self.now
        self.now = restore.timestamp(self.p["window"]["cleanupEnd"])
        with self.assertRaises(a.Stop): self.bound.account_readback()
        with self.assertRaises(a.Stop): self.bound.runtime_readback()

    def test_target_refuses_before_transport_and_native_disabled(self):
        self.target["tenantId"] = "foreign"
        with self.assertRaises(a.Stop): self.make()
        self.assertEqual(self.transport.calls, [])
        with self.assertRaises(a.Stop): a.native()


if __name__ == "__main__": unittest.main()
