"""Synthetic serialized-boundary tests; no native transport or credentials."""
import copy
import datetime as dt
import hashlib
import json
import os
import subprocess
import tempfile
import unittest
import uuid
from pathlib import Path

import bridge

NOW = 1_000_000_000
NUMBER = "123456789012"


def iso(offset):
    return dt.datetime.fromtimestamp(NOW + offset, dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def plan():
    operation = str(uuid.uuid4())
    return {"mode": "LOCAL_INTEGRATED_PACKET_ONLY", "externalActionAuthorized": False,
            "automaticRetryAllowed": False, "allowanceUsd": 0, "project": "signmons",
            "projectNumber": NUMBER, "projectNumberSha256": hashlib.sha256(NUMBER.encode()).hexdigest(),
            "tenantId": bridge.packet.TENANT, "jobId": bridge.packet.JOB,
            "ownerPrincipal": bridge.packet.OWNER, "runtimeIdentity": bridge.packet.IDENTITY,
            "serviceRetention": "UNDECIDED_REFUSE_LIVE", "operationId": operation,
            "keyId": "signmons-p08-" + operation.replace("-", ""),
            "window": {"start": iso(-10), "cutoff": iso(60), "workEnd": iso(120), "cleanupEnd": iso(900)}}


class Fake:
    def __init__(self, plan):
        self.p = plan
        self.calls = []
        self.bindings = set()
        self.service = "ENABLED"
        self.key = None
        self.diagnostic_state = "CAN_ACCESS"
        self.fail = None
        self.key_resource = f"projects/{NUMBER}/locations/global/keys/{plan['keyId']}"
        self.roles = bridge.packet.module("roles").ROLES

    def cli(self, vector):
        self.calls.append(("cli", vector))
        if self.fail == "bind" and "add-iam-policy-binding" in vector:
            self.bindings.add("lookup" if vector[0] == "projects" else "signing")
            raise RuntimeError("private CLI failure")
        if vector[:2] == ["projects", "describe"]:
            value = {"projectId": "signmons", "projectNumber": NUMBER, "lifecycleState": "ACTIVE"}
        elif vector[:3] == ["iam", "roles", "describe"]:
            role = next(r for r in self.roles if r["id"] == vector[3])
            value = {"name": role["name"], "title": role["title"], "description": role["description"],
                     "includedPermissions": [role["permission"]], "stage": "GA"}
            if role["kind"] == "lookup":
                value["deleted"] = False
        elif "get-iam-policy" in vector:
            kind = "lookup" if vector[0] == "projects" else "signing"
            if kind in self.bindings:
                role = next(r for r in self.roles if r["kind"] == kind)
                condition = {"expression": f"request.time >= timestamp('{self.p['window']['start']}') && request.time < timestamp('{self.p['window']['workEnd']}')",
                             "title": f"p08_{self.p['operationId']}_{kind}"}
                member = "serviceAccount:" + bridge.packet.IDENTITY if kind == "lookup" else "user:" + bridge.packet.OWNER
                value = {"bindings": [{"role": role["name"], "members": [member], "condition": condition}]}
            else:
                value = {"bindings": None}
        elif "add-iam-policy-binding" in vector:
            self.bindings.add("lookup" if vector[0] == "projects" else "signing")
            value = {}
        elif "remove-iam-policy-binding" in vector:
            self.bindings.remove("lookup" if vector[0] == "projects" else "signing")
            value = {}
        else:
            raise AssertionError(vector)
        return json.dumps(value)

    def https(self, descriptor):
        self.calls.append(("https", descriptor))
        url, method = descriptor["url"], descriptor["method"]
        if self.fail == "create" and method == "POST" and "/keys?keyId=" in url:
            self.key = self.make_key()
            raise RuntimeError("private create response lost")
        if self.fail == "key_denied" and method == "GET" and "/keys/" in url:
            return {"httpStatus": 403, "body": json.dumps({"error": {"status": "PERMISSION_DENIED", "code": 403}})}
        if self.fail == "service_null" and method == "GET" and "/services/" in url:
            return {"httpStatus": 200, "body": json.dumps({"name": f"projects/{NUMBER}/services/apikeys.googleapis.com", "state": None})}
        if self.fail == "delete" and method == "DELETE" and "/keys/" in url:
            self.key["deleteTime"] = iso(1)
            raise RuntimeError("delete response lost")
        if url.endswith("/keyString"):
            value = {"keyString": "synthetic-only-key"}
        elif "policytroubleshooter.googleapis.com" in url:
            value = {"overallAccessState": self.diagnostic_state}
        elif "/services/" in url and method == "GET":
            value = {"name": f"projects/{NUMBER}/services/policytroubleshooter.googleapis.com" if "policytroubleshooter" in url else f"projects/{NUMBER}/services/apikeys.googleapis.com", "state": self.service}
        elif "/services/" in url and method == "POST":
            self.service = "ENABLED"
            value = {"name": "operations/service1", "done": True,
                     "response": {"service": {"name": f"projects/{NUMBER}/services/apikeys.googleapis.com", "state": "ENABLED"}}}
        elif "/keys?keyId=" in url and method == "POST":
            self.key = self.make_key()
            value = {"name": "operations/keycreate1", "done": True, "response": copy.deepcopy(self.key)}
        elif "/keys/" in url and method == "GET":
            if self.key is None:
                return {"httpStatus": 404, "body": json.dumps({"error": {"status": "NOT_FOUND", "code": 404}})}
            value = copy.deepcopy(self.key)
        elif "/keys/" in url and method == "DELETE":
            self.key["deleteTime"] = iso(1)
            value = {"name": "operations/keydelete1", "done": True, "response": {}}
        else:
            raise AssertionError(descriptor)
        return {"httpStatus": 200, "body": json.dumps(value)}

    def make_key(self):
        return {"name": self.key_resource, "uid": str(uuid.uuid4()), "etag": "etag1",
                "displayName": "Signmons P08 " + self.p["operationId"],
                "restrictions": {"apiTargets": [{"service": "identitytoolkit.googleapis.com"}]}}


class BridgeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        os.chmod(self.temp.name, 0o700)
        self.p = plan()
        self.fake = Fake(self.p)
        self.receipt = None

    def tearDown(self):
        self.temp.cleanup()

    def make(self):
        def auth(receipt):
            self.receipt = receipt
            return copy.deepcopy(bridge.packet.AUTH_PROOF)
        ports = bridge.Ports(self.p, self.fake.cli, self.fake.https, auth,
                             lambda: {"appDisabled": True, "firebaseDisabled": True,
                                      "tokensRevoked": True, "sessionsAbsent": True},
                             lambda: {"retired": True, "normalTraffic100": True,
                                      "sessionsAbsent": True, "privatePlansAbsent": True},
                             lambda: NOW)
        return bridge.BoundPacket(self.p, ports, self.temp.name, clock=lambda: NOW)

    def test_serialized_success_canonical_key_and_cleanup(self):
        result = self.make().run()
        self.assertTrue(result["authenticated"])
        self.assertEqual(result["residuals"], [])
        self.assertFalse(self.fake.bindings)
        self.assertEqual(self.receipt["keyResource"], self.fake.key_resource)
        self.assertEqual(self.receipt["keyStringSha256"], hashlib.sha256(b"synthetic-only-key").hexdigest())
        self.assertNotIn("synthetic-only-key", Path(self.temp.name, "journal.json").read_text())
        self.assertIn("deleteTime", self.fake.key)
        calls = [v[1] for v in self.fake.calls if v[0] == "https"]
        self.assertLess(next(i for i, d in enumerate(calls) if "policytroubleshooter" in d["url"]),
                        next(i for i, d in enumerate(calls) if "/keys?keyId=" in d["url"]))

    def test_stage_a_denial_blocks_all_key_actions(self):
        self.fake.diagnostic_state = "CANNOT_ACCESS"
        result = self.make().run()
        self.assertEqual(result["failure"], "STAGE_A_NOT_QUALIFIED")
        self.assertFalse(self.fake.bindings)
        self.assertFalse(any("/keys?keyId=" in d[1]["url"] for d in self.fake.calls if d[0] == "https"))

    def test_key_collision_refuses(self):
        self.fake.key = self.fake.make_key()
        result = self.make().run()
        self.assertEqual(result["failure"], "KEY_COLLISION_OR_UNKNOWN")
        self.assertFalse(self.fake.bindings)

    def test_lost_create_response_remains_unknown(self):
        self.fake.fail = "create"
        result = self.make().run()
        self.assertEqual(result["failure"], "ADAPTER_UNKNOWN")
        self.assertIn("KEY", result["residuals"])
        self.assertFalse(self.fake.bindings)
        self.assertEqual(sum("/keys?keyId=" in d[1]["url"] for d in self.fake.calls if d[0] == "https"), 1)

    def test_lost_binding_response_readback_cleanup(self):
        self.fake.fail = "bind"
        result = self.make().run()
        self.assertEqual(result["failure"], "ADAPTER_UNKNOWN")
        self.assertFalse(self.fake.bindings)

    def test_disabled_service_keeps_retention_decision_open(self):
        self.fake.service = "DISABLED"
        result = self.make().run()
        self.assertTrue(result["authenticated"])
        self.assertEqual(result["residuals"], ["SERVICE_RETENTION_DECISION_PENDING"])

    def test_wrong_project_number_refuses_before_transport(self):
        self.p["projectNumberSha256"] = "0" * 64
        with self.assertRaises(bridge.packet.Stop):
            self.make()
        self.assertEqual(self.fake.calls, [])

    def test_native_refuses(self):
        self.assertEqual(bridge.native(), 2)

    def test_permission_denied_is_not_absence(self):
        self.fake.fail = "key_denied"
        result = self.make().run()
        self.assertEqual(result["failure"], "ADAPTER_UNKNOWN")
        self.assertFalse(any("/keys?keyId=" in d[1]["url"] for d in self.fake.calls if d[0] == "https"))

    def test_null_service_state_refuses_before_binding(self):
        self.fake.fail = "service_null"
        result = self.make().run()
        self.assertEqual(result["failure"], "SERVICE_SHAPE")
        self.assertFalse(self.fake.bindings)

    def test_lost_delete_response_independent_readback_no_retry(self):
        self.fake.fail = "delete"
        operation = self.make()
        first = operation.run()
        self.assertIn("KEY", first["residuals"])
        self.fake.fail = None
        second = operation.closeout(independent=True)
        self.assertNotIn("KEY", second["residuals"])
        self.assertEqual(sum(d[1]["method"] == "DELETE" for d in self.fake.calls if d[0] == "https"), 1)

    def test_cleanup_readback_failure_is_residual(self):
        operation = self.make()
        operation.ports._runtime_readback = lambda: {"retired": False}
        result = operation.run()
        self.assertIn("RUNTIME", result["residuals"])

    def test_python_receipt_traverses_javascript_authority(self):
        result = self.make().run()
        self.assertTrue(result["authenticated"])
        receipt = dict(self.receipt)
        receipt["ownedAt"] = dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        process = subprocess.run(["node", str(Path(bridge.ROOT, "owned-key-authority.test.mjs"))],
                                 input=json.dumps(receipt), text=True, capture_output=True,
                                 env={**os.environ, "P08_SYNTHETIC_PIPE": "1"}, timeout=8)
        self.assertEqual(process.returncode, 0, process.stdout[-1500:] + process.stderr[-500:])


if __name__ == "__main__":
    unittest.main()
