import datetime as dt
import hashlib
import importlib.util
import json
import stat
import tempfile
import threading
import unittest
from pathlib import Path

MODULE = Path(__file__).with_name("p06-r11-shared-secret-branch-map.py")
spec = importlib.util.spec_from_file_location("branch_map", MODULE)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class MappingTests(unittest.TestCase):
    def inventory(self, *hosts):
        return {
            "capturedAt": module.canonical(module.START),
            "endpoints": [
                {
                    "branchId": f"br-fiction-{index}",
                    "endpointId": f"ep-fiction-{index}",
                    "endpointType": "read_write",
                    "host": host,
                    "state": "active",
                }
                for index, host in enumerate(hosts, 1)
            ],
        }

    def payload(self, host="ep-one.us-east-2.aws.neon.tech", **changes):
        values = {
            "scheme": "postgresql",
            "role": module.EXPECTED_ROLE,
            "password": "FICTIONAL-only",
            "host": host,
            "port": "5432",
            "database": module.EXPECTED_DATABASE,
        }
        values.update(changes)
        return bytearray(
            f"{values['scheme']}://{values['role']}:{values['password']}@"
            f"{values['host']}:{values['port']}/{values['database']}?sslmode=require",
            "utf-8",
        )

    def test_unique_mapping_projects_only_sanitized_identity(self):
        host = "ep-one.us-east-2.aws.neon.tech"
        result = module.map_payload(self.payload(host.upper() + "."), self.inventory(host))
        self.assertEqual(result["status"], "MATCHED_UNIQUE")
        self.assertEqual(result["branchId"], "br-fiction-1")
        self.assertEqual(result["endpointId"], "ep-fiction-1")
        self.assertEqual(result["connectionMode"], "DIRECT")
        serialized = json.dumps(result)
        self.assertNotIn(host, serialized)
        self.assertNotIn("FICTIONAL-only", serialized)

    def test_pooled_mapping_projects_connection_mode(self):
        direct = "ep-one.us-east-2.aws.neon.tech"
        pooled = "ep-one-pooler.us-east-2.aws.neon.tech"
        result = module.map_payload(self.payload(pooled), self.inventory(direct))
        self.assertEqual(result["status"], "MATCHED_UNIQUE")
        self.assertEqual(result["connectionMode"], "POOLED")
        self.assertNotIn(pooled, json.dumps(result))

    def test_no_match_and_ambiguous_are_bounded_results(self):
        host = "ep-one.us-east-2.aws.neon.tech"
        self.assertEqual(
            module.map_payload(self.payload(host), self.inventory("ep-two.us-east-2.aws.neon.tech"))["status"],
            "NO_MATCH",
        )
        duplicate = self.inventory(host, host.upper() + ".")
        result = module.map_payload(self.payload(host), duplicate)
        self.assertEqual(result, {"status": "AMBIGUOUS", "matchCount": 2})

    def test_identity_and_malformed_payloads_refuse(self):
        inventory = self.inventory("ep-one.us-east-2.aws.neon.tech")
        for changes in (
            {"scheme": "https"},
            {"role": "other"},
            {"password": ""},
            {"port": "5433"},
            {"database": "other"},
        ):
            with self.subTest(changes=changes):
                with self.assertRaisesRegex(ValueError, "IDENTITY_MISMATCH"):
                    module.map_payload(self.payload(**changes), inventory)
        for value in (
            bytearray(),
            bytearray(b"not-a-url"),
            bytearray(b"postgresql://x:y@example.invalid/neondb\nleak"),
            bytearray(b"postgresql://x:y@example.invalid/neondb\x00leak"),
            bytearray(b"x" * 8193),
        ):
            with self.subTest(length=len(value)):
                with self.assertRaises(ValueError):
                    module.map_payload(value, inventory)


class BoundRunTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="r11-branch-map-", dir="/private/tmp")
        self.root = Path(self.temp.name)
        self.root.chmod(0o700)
        self.original = {
            "PRIVATE_ROOT": module.PRIVATE_ROOT,
            "EXPECTED_NEON_PROJECT_ID": module.EXPECTED_NEON_PROJECT_ID,
            "EXPECTED_INVENTORY_SHA256": module.EXPECTED_INVENTORY_SHA256,
        }
        module.PRIVATE_ROOT = self.root
        module.EXPECTED_NEON_PROJECT_ID = "fictional-project"
        self.now = module.START + dt.timedelta(minutes=1)
        self.write_inventory()
        self.write_approval()

    def tearDown(self):
        for key, value in self.original.items():
            setattr(module, key, value)
        self.temp.cleanup()

    def inventory_value(self):
        return {
            "capturedAt": module.canonical(self.now - dt.timedelta(minutes=1)),
            "complete": True,
            "endpoints": [
                {
                    "branchId": "br-fiction-1",
                    "endpointId": "ep-fiction-1",
                    "endpointType": "read_write",
                    "host": "ep-fiction-1.us-east-2.aws.neon.tech",
                    "state": "active",
                }
            ],
            "projectId": module.EXPECTED_NEON_PROJECT_ID,
        }

    def write_inventory(self, value=None):
        path = self.root / "neon-endpoints.json"
        path.write_text(json.dumps(value or self.inventory_value()), encoding="utf-8")
        path.chmod(0o600)
        module.EXPECTED_INVENTORY_SHA256 = hashlib.sha256(path.read_bytes()).hexdigest()

    def approval_value(self):
        return {
            "action": "READ_SHARED_SECRET_DIRECT_POOLED_MAPPING",
            "automaticRetry": False,
            "decision": "APPROVED",
            "endsAt": module.canonical(module.END),
            "expectedDatabase": module.EXPECTED_DATABASE,
            "expectedRole": module.EXPECTED_ROLE,
            "inventorySha256": module.EXPECTED_INVENTORY_SHA256,
            "neonProjectId": module.EXPECTED_NEON_PROJECT_ID,
            "operationId": module.OPERATION_ID,
            "owner": "Debynyhan Banks",
            "planId": module.PLAN_ID,
            "privateRoot": str(self.root),
            "project": module.PROJECT,
            "secret": module.SECRET,
            "sourceSha256": module.source_sha256(),
            "startBefore": module.canonical(module.START_BEFORE),
            "startsAt": module.canonical(module.START),
            "version": module.VERSION,
        }

    def write_approval(self, value=None):
        path = self.root / "owner-approval.json"
        path.write_text(json.dumps(value or self.approval_value()), encoding="utf-8")
        path.chmod(0o600)

    def payload(self, host="ep-fiction-1.us-east-2.aws.neon.tech"):
        return bytearray(
            f"postgresql://{module.EXPECTED_ROLE}:FICTIONAL-only@{host}:5432/"
            f"{module.EXPECTED_DATABASE}?sslmode=require",
            "utf-8",
        )

    def test_check_no_action_then_unique_run_is_consumed(self):
        self.assertEqual(module.check(self.root), "R11_POOLED_HOST_MAP_CHECK_PASSED_NO_ACTION")
        self.assertFalse((self.root / "mapping-attempt.json").exists())
        self.assertEqual(module.run(self.root, self.now, self.payload), "MATCHED_UNIQUE")
        result = json.loads((self.root / "mapping-result.json").read_text())
        self.assertEqual(result["status"], "MATCHED_UNIQUE")
        self.assertNotIn("neon.tech", json.dumps(result))
        self.assertNotIn("FICTIONAL", json.dumps(result))
        self.assertEqual(stat.S_IMODE((self.root / "mapping-result.json").stat().st_mode), 0o600)
        with self.assertRaisesRegex(ValueError, "CONSUMED"):
            module.run(self.root, self.now, self.payload)

    def test_no_match_is_terminal_result(self):
        self.assertEqual(
            module.run(self.root, self.now, lambda: self.payload("ep-other.us-east-2.aws.neon.tech")),
            "NO_MATCH",
        )
        self.assertEqual(json.loads((self.root / "mapping-result.json").read_text())["status"], "NO_MATCH")

    def test_failure_consumes_and_redacts(self):
        canary = "FICTIONAL_SECRET_CANARY"

        def fail():
            raise RuntimeError(canary)

        with self.assertRaisesRegex(ValueError, "CONSUMED_STOP"):
            module.run(self.root, self.now, fail)
        text = "".join(path.read_text() for path in self.root.iterdir())
        self.assertNotIn(canary, text)
        self.assertEqual(json.loads((self.root / "mapping-stop.json").read_text())["reason"], "UNEXPECTED")

    def test_window_binding_inventory_and_modes_refuse_before_access(self):
        calls = []

        def access():
            calls.append(True)
            return self.payload()

        for now in (module.START - dt.timedelta(seconds=1), module.START_BEFORE, module.END):
            with self.subTest(now=now):
                with self.assertRaises(ValueError):
                    module.run(self.root, now, access)
                self.assertEqual(calls, [])
        approval = self.approval_value()
        approval["owner"] = "other"
        self.write_approval(approval)
        with self.assertRaises(ValueError):
            module.run(self.root, self.now, access)
        self.assertEqual(calls, [])
        self.write_approval()
        inventory = self.inventory_value()
        inventory["extra"] = True
        self.write_inventory(inventory)
        self.write_approval()
        with self.assertRaises(ValueError):
            module.run(self.root, self.now, access)
        self.assertEqual(calls, [])
        self.write_inventory()
        self.write_approval()
        self.root.chmod(0o755)
        with self.assertRaises(ValueError):
            module.run(self.root, self.now, access)
        self.assertEqual(calls, [])

    def test_stale_duplicate_and_malformed_inventory_refuse(self):
        cases = []
        stale = self.inventory_value()
        stale["capturedAt"] = module.canonical(self.now - dt.timedelta(minutes=31))
        cases.append(stale)
        duplicate = self.inventory_value()
        duplicate["endpoints"].append(dict(duplicate["endpoints"][0]))
        cases.append(duplicate)
        malformed = self.inventory_value()
        malformed["endpoints"][0]["host"] = "https://secret.invalid"
        cases.append(malformed)
        for value in cases:
            with self.subTest(value=value):
                self.write_inventory(value)
                self.write_approval()
                with self.assertRaises(ValueError):
                    module.run(self.root, self.now, self.payload)
                self.assertFalse((self.root / "mapping-attempt.json").exists())

    def test_concurrent_reservation_invokes_accessor_once(self):
        barrier = threading.Barrier(2)
        calls = []
        results = []

        def access():
            calls.append(True)
            return self.payload()

        def worker():
            barrier.wait()
            try:
                results.append(module.run(self.root, self.now, access))
            except Exception as error:
                results.append(type(error).__name__)

        threads = [threading.Thread(target=worker) for _ in range(2)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()
        self.assertEqual(calls, [True])
        self.assertIn("MATCHED_UNIQUE", results)
        self.assertEqual(len(results), 2)


if __name__ == "__main__":
    unittest.main()
