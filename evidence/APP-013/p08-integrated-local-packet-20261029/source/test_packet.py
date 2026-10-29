"""Synthetic-only composition, refusal and cleanup proofs."""
import copy
import datetime as dt
import json
import os
import tempfile
import unittest
import uuid
from pathlib import Path

import packet


def plan(now=1000000000):
    iso = lambda offset: dt.datetime.fromtimestamp(now + offset, dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    op = str(uuid.uuid4())
    return {"mode": "LOCAL_INTEGRATED_PACKET_ONLY", "externalActionAuthorized": False,
            "automaticRetryAllowed": False, "allowanceUsd": 0, "project": packet.PROJECT,
            "tenantId": packet.TENANT, "jobId": packet.JOB, "ownerPrincipal": packet.OWNER,
            "runtimeIdentity": packet.IDENTITY, "serviceRetention": "UNDECIDED_REFUSE_LIVE",
            "operationId": op, "keyId": "signmons-p08-" + op.replace("-", ""),
            "window": {"start": iso(-10), "cutoff": iso(60), "workEnd": iso(120), "cleanupEnd": iso(900)}}


class Ports:
    def __init__(self, plan, service="ENABLED", stage=None):
        self.plan = plan
        self.service = service
        self.stage = ["CAN_ACCESS"] * 4 if stage is None else stage
        self.calls = []
        self.bindings = set()
        self.key = None
        self.fail = None

    def mark(self, name):
        self.calls.append(name)
        if self.fail == name:
            raise RuntimeError("synthetic adapter fault with private payload")

    def preflight(self):
        self.mark("preflight")
        roles = packet.module("roles").ROLES
        return {"roles": [{"name": r["name"], "title": r["title"],
                           "description": r["description"], "includedPermissions": [r["permission"]],
                           "stage": "GA", **({"deleted": False} if i == 0 else {})}
                          for i, r in enumerate(roles)],
                "bindingsAbsent": True, "apiKeysService": self.service}

    def bind(self, kind, name):
        self.mark("bind_" + kind)
        self.bindings.add(kind)
        return True

    def binding_state(self, kind):
        self.mark("binding_state_" + kind)
        return "OWNED" if kind in self.bindings else "ABSENT"

    def stage_a(self, tuples):
        self.mark("stage_a")
        self.tuples = tuples
        return self.stage

    def enable_api_keys(self):
        self.mark("enable_api_keys")
        self.service = "ENABLED"
        return True

    def api_keys_state(self):
        self.mark("api_keys_state")
        return self.service

    def key_get(self):
        self.mark("key_get")
        return copy.deepcopy(self.key) if self.key else "NOT_FOUND"

    def key_create(self, name, restrictions):
        self.mark("key_create")
        self.key = {"name": name, "uid": str(uuid.uuid4()), "etag": "etag1",
                    "displayName": "Signmons P08 " + self.plan["operationId"],
                    "restrictions": copy.deepcopy(restrictions), "deleted": False}
        return copy.deepcopy(self.key)

    def authenticate(self, key_resource):
        self.mark("authenticate")
        assert self.key and not self.key["deleted"]
        assert key_resource == self.key["name"]
        return copy.deepcopy(packet.AUTH_PROOF)

    def account_closeout(self):
        self.mark("account_closeout")
        return True

    def key_delete(self, etag):
        self.mark("key_delete")
        assert self.key and etag == self.key["etag"]
        self.key["deleted"] = True
        return True

    def unbind(self, kind):
        self.mark("unbind_" + kind)
        self.bindings.remove(kind)
        return True

    def runtime_closeout(self):
        self.mark("runtime_closeout")
        return True


class PacketTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        os.chmod(self.temp.name, 0o700)
        self.p = plan()
        self.ports = Ports(self.p)

    def tearDown(self):
        self.temp.cleanup()

    def run_packet(self):
        return packet.Packet(self.p, self.ports, self.temp.name, clock=lambda: 1000000000).run()

    def test_enabled_happy_path_and_private_journal(self):
        result = self.run_packet()
        self.assertEqual(result, {"status": "LOCAL_PACKET_CLOSED", "authenticated": True,
                                  "failure": None, "residuals": [], "serviceRetentionDecisionPending": False})
        self.assertLess(self.ports.calls.index("stage_a"), self.ports.calls.index("key_create"))
        self.assertLess(self.ports.calls.index("authenticate"), self.ports.calls.index("key_delete"))
        self.assertEqual(self.ports.tuples, [list(x) for x in packet.module("stage_a").TUPLES])
        self.assertFalse(self.ports.bindings)
        journal = Path(self.temp.name, "journal.json").read_text()
        self.assertNotIn(self.ports.key["uid"], journal)
        self.assertNotIn("private payload", journal)

    def test_disabled_service_requires_retention_decision(self):
        self.ports.service = "DISABLED"
        result = self.run_packet()
        self.assertTrue(result["authenticated"])
        self.assertEqual(result["residuals"], ["SERVICE_RETENTION_DECISION_PENDING"])
        self.assertLess(self.ports.calls.index("enable_api_keys"), self.ports.calls.index("key_create"))

    def test_stage_a_denial_refuses_key(self):
        self.ports.stage[3] = "CANNOT_ACCESS"
        result = self.run_packet()
        self.assertEqual(result["failure"], "STAGE_A_NOT_QUALIFIED")
        self.assertNotIn("key_create", self.ports.calls)
        self.assertFalse(self.ports.bindings)

    def test_role_drift_refuses_binding(self):
        original = self.ports.preflight
        def drift():
            value = original()
            value["roles"][0]["includedPermissions"].append("owner")
            return value
        self.ports.preflight = drift
        result = self.run_packet()
        self.assertEqual(result["failure"], "ROLE_DRIFT")
        self.assertNotIn("bind_lookup", self.ports.calls)

    def test_key_collision_refuses_creation(self):
        self.ports.key = {"existing": True}
        result = self.run_packet()
        self.assertEqual(result["failure"], "KEY_COLLISION_OR_UNKNOWN")
        self.assertNotIn("key_create", self.ports.calls)
        self.assertFalse(self.ports.bindings)

    def test_lost_key_create_response_preserves_unknown(self):
        self.ports.fail = "key_create"
        result = self.run_packet()
        self.assertEqual(result["failure"], "ADAPTER_UNKNOWN")
        self.assertIn("KEY", result["residuals"])
        self.assertNotIn("key_delete", self.ports.calls)
        self.assertFalse(self.ports.bindings)

    def test_lost_bind_response_is_read_back_and_removed(self):
        self.ports.fail = "bind_lookup"
        result = self.run_packet()
        self.assertEqual(result["failure"], "ADAPTER_UNKNOWN")
        self.assertFalse(self.ports.bindings)
        self.assertNotIn("stage_a", self.ports.calls)

    def test_lost_key_delete_response_reads_deleted_without_retry(self):
        original = self.ports.key_delete
        def lost(etag):
            original(etag)
            raise RuntimeError("response lost")
        self.ports.key_delete = lost
        result = self.run_packet()
        self.assertIn("KEY", result["residuals"])
        self.assertEqual(self.ports.calls.count("key_delete"), 1)

    def test_signal_refusal_and_deadline_cleanup(self):
        original = self.ports.stage_a
        def interrupted(tuples):
            self.controller.abort = True
            return original(tuples)
        self.ports.stage_a = interrupted
        self.controller = packet.Packet(self.p, self.ports, self.temp.name, clock=lambda: 1000000000)
        result = self.controller.run()
        self.assertEqual(result["failure"], "INTERRUPTED")
        self.assertNotIn("key_create", self.ports.calls)
        self.assertFalse(self.ports.bindings)

    def test_auth_failure_still_closes_owned_resources(self):
        self.ports.fail = "authenticate"
        result = self.run_packet()
        self.assertFalse(result["authenticated"])
        self.assertIn("account_closeout", self.ports.calls)
        self.assertIn("key_delete", self.ports.calls)
        self.assertFalse(self.ports.bindings)

    def test_one_use_reservation(self):
        self.run_packet()
        with self.assertRaises(FileExistsError):
            self.run_packet()

    def test_plan_refuses_live_or_retry_and_source_lock(self):
        for field, value in [("externalActionAuthorized", True), ("automaticRetryAllowed", True),
                             ("serviceRetention", "RETAIN")]:
            altered = copy.deepcopy(self.p)
            altered[field] = value
            with self.assertRaises(packet.Stop):
                packet.Packet(altered, self.ports, self.temp.name, clock=lambda: 1000000000)
        self.assertEqual(packet.native(), 2)

    def test_serialized_restore_binding_contract(self):
        restore = packet.module("restore")
        source = Path(restore.__file__).read_text()
        self.assertIn("--condition='+x['condition']", source)
        self.assertIn("'--member='+('serviceAccount:'+IDENTITY if name=='lookup' else 'user:'+OWNER)", source)


if __name__ == "__main__":
    unittest.main()
