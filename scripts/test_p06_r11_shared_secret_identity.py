import datetime as dt
import hashlib
import importlib.util
import json
import os
import stat
import tempfile
import unittest
from pathlib import Path

MODULE = Path(__file__).with_name("p06-r11-shared-secret-identity.py")
spec = importlib.util.spec_from_file_location("credential_identity", MODULE)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class IdentityTests(unittest.TestCase):
    def payload(self, **changes):
        values = {
            "scheme": "postgresql",
            "role": module.EXPECTED_ROLE,
            "password": "FICTIONAL-only",
            "host": module.EXPECTED_HOST,
            "port": "5432",
            "database": module.EXPECTED_DATABASE,
        }
        values.update(changes)
        return bytearray(
            f"{values['scheme']}://{values['role']}:{values['password']}@"
            f"{values['host']}:{values['port']}/{values['database']}?sslmode=require",
            "utf-8",
        )

    def test_exact_identity_matches_without_value_projection(self):
        result = module.classify(self.payload())
        self.assertEqual(result["status"], "MATCHED")
        self.assertEqual(
            set(result),
            {
                "status",
                "schemeValid",
                "roleMatched",
                "passwordPresent",
                "hostMatched",
                "portMatched",
                "databaseMatched",
            },
        )
        self.assertNotIn("FICTIONAL", json.dumps(result))

    def test_each_identity_mismatch_stops_match(self):
        cases = [
            {"scheme": "https"},
            {"role": "other"},
            {"password": ""},
            {"host": "example.invalid"},
            {"port": "5433"},
            {"database": "other"},
        ]
        for changes in cases:
            with self.subTest(changes=changes):
                self.assertEqual(module.classify(self.payload(**changes))["status"], "MISMATCH")

    def test_malformed_multiline_nul_and_oversized_refuse(self):
        for value in (
            bytearray(),
            bytearray(b"not-a-url"),
            bytearray(b"postgresql://x:y@example.invalid/neondb\nleak"),
            bytearray(b"postgresql://x:y@example.invalid/neondb\x00leak"),
            bytearray(b"x" * 8193),
        ):
            with self.subTest(length=len(value)):
                with self.assertRaises(ValueError):
                    module.classify(value)


class BoundRunTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="r11-credential-identity-", dir="/private/tmp")
        self.root = Path(self.temp.name)
        self.root.chmod(0o700)
        self.original_root = module.PRIVATE_ROOT
        module.PRIVATE_ROOT = self.root
        self.approval = {
            "action": "READ_SHARED_SECRET_IDENTITY",
            "automaticRetry": False,
            "decision": "APPROVED",
            "endsAt": module.END.isoformat().replace("+00:00", "Z"),
            "expectedDatabase": module.EXPECTED_DATABASE,
            "expectedHost": module.EXPECTED_HOST,
            "expectedRole": module.EXPECTED_ROLE,
            "operationId": module.OPERATION_ID,
            "owner": "Debynyhan Banks",
            "planId": module.PLAN_ID,
            "privateRoot": str(self.root),
            "project": module.PROJECT,
            "secret": module.SECRET,
            "sourceSha256": module.source_sha256(),
            "startBefore": module.START_BEFORE.isoformat().replace("+00:00", "Z"),
            "startsAt": module.START.isoformat().replace("+00:00", "Z"),
            "version": module.VERSION,
        }
        (self.root / "owner-approval.json").write_text(json.dumps(self.approval), encoding="utf-8")
        (self.root / "owner-approval.json").chmod(0o600)

    def tearDown(self):
        module.PRIVATE_ROOT = self.original_root
        self.temp.cleanup()

    def now(self):
        return module.START + dt.timedelta(minutes=1)

    def payload(self):
        return bytearray(
            f"postgresql://{module.EXPECTED_ROLE}:FICTIONAL-only@{module.EXPECTED_HOST}:5432/{module.EXPECTED_DATABASE}?sslmode=require",
            "utf-8",
        )

    def test_check_is_no_action_and_success_is_one_use(self):
        self.assertEqual(module.check(self.root), "R11_CREDENTIAL_IDENTITY_CHECK_PASSED_NO_ACTION")
        self.assertFalse((self.root / "identity-attempt.json").exists())
        self.assertEqual(module.run(self.root, self.now(), self.payload), "MATCHED")
        result = json.loads((self.root / "identity-result.json").read_text())
        self.assertEqual(result["status"], "MATCHED")
        self.assertNotIn("FICTIONAL", json.dumps(result))
        self.assertEqual(stat.S_IMODE((self.root / "identity-result.json").stat().st_mode), 0o600)
        with self.assertRaisesRegex(ValueError, "CONSUMED"):
            module.run(self.root, self.now(), self.payload)

    def test_mismatch_is_result_not_mutation_authority(self):
        def mismatch():
            return bytearray(b"postgresql://other:FICTIONAL@example.invalid/other")
        self.assertEqual(module.run(self.root, self.now(), mismatch), "MISMATCH")
        self.assertEqual(json.loads((self.root / "identity-result.json").read_text())["status"], "MISMATCH")

    def test_failure_consumes_and_redacts(self):
        canary = "FICTIONAL_SECRET_CANARY"
        def fail():
            raise RuntimeError(canary)
        with self.assertRaisesRegex(ValueError, "CONSUMED_STOP"):
            module.run(self.root, self.now(), fail)
        text = "".join(path.read_text() for path in self.root.iterdir())
        self.assertNotIn(canary, text)
        self.assertEqual(json.loads((self.root / "identity-stop.json").read_text())["reason"], "UNEXPECTED")

    def test_window_schema_binding_mode_and_existing_marker_refuse_before_access(self):
        calls = []
        def access():
            calls.append(True)
            return self.payload()
        for now in (module.START - dt.timedelta(seconds=1), module.START_BEFORE, module.END):
            with self.subTest(now=now):
                with self.assertRaises(ValueError):
                    module.run(self.root, now, access)
                self.assertEqual(calls, [])
        self.approval["owner"] = "other"
        (self.root / "owner-approval.json").write_text(json.dumps(self.approval), encoding="utf-8")
        with self.assertRaises(ValueError):
            module.run(self.root, self.now(), access)
        self.assertEqual(calls, [])
        self.approval["owner"] = "Debynyhan Banks"
        self.approval["extra"] = True
        (self.root / "owner-approval.json").write_text(json.dumps(self.approval), encoding="utf-8")
        with self.assertRaises(ValueError):
            module.run(self.root, self.now(), access)
        self.assertEqual(calls, [])
        self.root.chmod(0o755)
        with self.assertRaises(ValueError):
            module.run(self.root, self.now(), access)
        self.assertEqual(calls, [])


if __name__ == "__main__":
    unittest.main()
