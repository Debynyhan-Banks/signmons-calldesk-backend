import copy
import datetime as dt
import json
import os
import stat
import subprocess
import tempfile
import unittest
import uuid
from pathlib import Path
from unittest.mock import patch

import traffic_diagnostic as diag


NOW = dt.datetime(2026, 10, 29, 19, 0, 0, tzinfo=dt.timezone.utc).timestamp()


def raw(value):
    return json.dumps(value, separators=(",", ":")).encode()


def inputs():
    normal = diag.expected_normal()
    return {
        "owner": [{"account": diag.model.OWNER, "status": "ACTIVE"}],
        "config": {"core": {"project": diag.model.PROJECT}, "auth": {}},
        "service": {"metadata": {"name": diag.launch.SERVICE}, "status": {"traffic": [
            {"revisionName": normal, "percent": 100},
            {"revisionName": diag.launch.REVISION, "percent": 0},
        ]}},
    }


def plan():
    return {
        "mode": "P08_TRAFFIC_SHAPE_DIAGNOSTIC_ONLY", "externalReadAuthorized": False,
        "project": diag.model.PROJECT, "service": diag.launch.SERVICE, "region": diag.launch.REGION,
        "normalRevision": diag.expected_normal(), "candidateRevision": diag.launch.REVISION,
        "oldTag": diag.OLD_TAG, "proposalSha256": diag.LOCAL_PROPOSAL_SHA256,
        "sourceSha256": diag.digest(Path(diag.__file__).read_bytes()),
        "allowanceUsd": 0, "automaticRetryAllowed": False, "cliLimit": 3,
        "operationId": str(uuid.uuid4()),
        "window": {"start": "2026-10-29T19:00:00Z", "cutoff": "2026-10-29T19:03:00Z", "readEnd": "2026-10-29T19:08:00Z", "closeoutEnd": "2026-10-29T19:13:00Z"},
    }


def binding(p):
    value = {
        "mode": "P08_TRAFFIC_SHAPE_EXACT_LAUNCH", "externalReadAuthorized": True,
        "mutationsAuthorized": False, "planSha256": diag.digest(p),
        "sourceSha256": p["sourceSha256"], "operationId": p["operationId"],
        "cliLimit": 3, "allowanceUsd": 0, "automaticRetryAllowed": False,
        "operationProposalSha256": "a" * 64,
    }
    value["ownerApproval"] = {
        "decision": "APPROVE_EXACT_P08_TRAFFIC_SHAPE_READ", "owner": "Debynyhan Banks",
        "operationId": p["operationId"], "operationProposalSha256": value["operationProposalSha256"],
        "bindingSha256": diag.digest(value),
    }
    return value


class FakeTransport:
    def __init__(self, overrides=None, failure=None):
        self.values = inputs()
        self.values.update(overrides or {})
        self.failure = failure
        self.calls = []
        self.closed = False

    def cli(self, descriptor, deadline):
        self.calls.append(descriptor)
        if self.failure == descriptor["id"]:
            raise diag.Stop("CLI_TIMEOUT")
        return raw(self.values[descriptor["id"]])

    def close(self):
        self.closed = True
        return True


class DiagnosticTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="p08-traffic-")
        self.dir = Path(self.temp.name)
        os.chmod(self.dir, 0o700)
        self.p = plan()
        self.b = binding(self.p)

    def tearDown(self):
        self.temp.cleanup()

    def test_locked_sources_and_exact_three_read_commands(self):
        diag.verify_sources()
        commands = diag.descriptors()
        self.assertEqual([x["id"] for x in commands], ["owner", "config", "service"])
        self.assertEqual(commands[2]["argv"], (
            diag.launch.GCLOUD, "run", "services", "describe", diag.launch.SERVICE,
            "--project", diag.model.PROJECT, "--region", diag.launch.REGION,
            "--format=json(metadata.name,status.traffic)",
        ))
        self.assertFalse(any(part in {"update", "delete", "set-traffic", "deploy"} for item in commands for part in item["argv"]))

    def test_unbound_native_refuses_without_provider_call(self):
        self.assertEqual(diag.native([]), 2)

    def test_exact_all_true_and_sanitized_journal(self):
        transport = FakeTransport()
        status = diag.run(self.p, self.b, self.dir, transport, lambda: NOW)
        self.assertEqual(status, "P08_TRAFFIC_SHAPE_DIAGNOSIS_COMPLETE")
        journal = json.loads((self.dir / "journal.json").read_text())
        self.assertEqual(journal["facts"], dict.fromkeys(diag.FACTS, True))
        self.assertEqual(journal["falseFacts"], [])
        self.assertEqual(journal["cliReads"], 3)
        self.assertTrue(transport.closed)
        text = (self.dir / "journal.json").read_text()
        self.assertNotIn(diag.model.OWNER, text)
        self.assertNotIn(diag.launch.REVISION, text)
        self.assertNotIn(diag.expected_normal(), text)

    def test_normal_missing_wrong_percent_and_duplicate(self):
        for traffic, expected in [
            ([{"revisionName": diag.launch.REVISION, "percent": 0}], False),
            ([{"revisionName": diag.expected_normal(), "percent": 90}, {"revisionName": diag.launch.REVISION, "percent": 0}], False),
        ]:
            with self.subTest(traffic=traffic):
                v = inputs(); v["service"]["status"]["traffic"] = traffic
                self.assertEqual(diag.classify(raw(v["owner"]), raw(v["config"]), raw(v["service"]))["facts"]["normal100ExactlyOne"], expected)
        v = inputs(); v["service"]["status"]["traffic"].append({"revisionName": diag.expected_normal(), "percent": 0})
        with self.assertRaisesRegex(diag.Stop, "TRAFFIC_DUPLICATE"):
            diag.classify(raw(v["owner"]), raw(v["config"]), raw(v["service"]))

    def test_candidate_missing_zero_positive_duplicate(self):
        v = inputs(); v["service"]["status"]["traffic"].pop()
        result = diag.classify(raw(v["owner"]), raw(v["config"]), raw(v["service"]))
        self.assertFalse(result["facts"]["candidatePresent"])
        self.assertFalse(result["facts"]["candidateZeroExactlyOne"])
        v = inputs(); v["service"]["status"]["traffic"][1]["percent"] = 1
        result = diag.classify(raw(v["owner"]), raw(v["config"]), raw(v["service"]))
        self.assertTrue(result["facts"]["candidatePresent"])
        self.assertFalse(result["facts"]["candidateZeroExactlyOne"])
        v = inputs(); v["service"]["status"]["traffic"].append({"revisionName": diag.launch.REVISION, "percent": 0})
        with self.assertRaisesRegex(diag.Stop, "TRAFFIC_DUPLICATE"):
            diag.classify(raw(v["owner"]), raw(v["config"]), raw(v["service"]))

    def test_old_tag_and_extra_positive_traffic(self):
        v = inputs(); v["service"]["status"]["traffic"][1]["tag"] = diag.OLD_TAG
        self.assertFalse(diag.classify(raw(v["owner"]), raw(v["config"]), raw(v["service"]))["facts"]["oldTagAbsent"])
        v = inputs(); v["service"]["status"]["traffic"].append({"revisionName": "foreign", "percent": 1})
        with self.assertRaisesRegex(diag.Stop, "TRAFFIC_UNEXPECTED_POSITIVE"):
            diag.classify(raw(v["owner"]), raw(v["config"]), raw(v["service"]))

    def test_malformed_missing_oversized_foreign_and_config(self):
        v = inputs()
        cases = [
            (v["owner"], v["config"], b"", "SERVICE_OUTPUT"),
            (v["owner"], v["config"], b"{" + b"x" * (diag.MAX_OUTPUT + 1), "SERVICE_OUTPUT"),
            (v["owner"], v["config"], {"metadata": {"name": "foreign"}, "status": {"traffic": []}}, "SERVICE_DRIFT"),
            (v["owner"], v["config"], {"metadata": {"name": diag.launch.SERVICE}, "status": {}}, "TRAFFIC_OUTPUT"),
            ([{"account": "foreign", "status": "ACTIVE"}], v["config"], v["service"], "OWNER_DRIFT"),
            (v["owner"], {"core": {"project": diag.model.PROJECT}, "auth": {"impersonate_service_account": "foreign"}}, v["service"], "CONFIG_DRIFT"),
        ]
        for owner, config, service, error in cases:
            with self.subTest(error=error):
                with self.assertRaisesRegex(diag.Stop, error):
                    diag.classify(raw(owner), raw(config), service if isinstance(service, bytes) else raw(service))

    def test_refuses_unsafe_binding_and_window(self):
        diag.validate(self.p, self.b, NOW)
        for change, error in [
            ({"externalReadAuthorized": True}, "PLAN_MODE"),
            ({"automaticRetryAllowed": True}, "LIMITS"),
            ({"service": "foreign"}, "RESOURCE_SCOPE"),
        ]:
            p = copy.deepcopy(self.p); p.update(change)
            with self.subTest(change=change), self.assertRaisesRegex(diag.Stop, error):
                diag.validate(p, binding(p), NOW)
        with self.assertRaisesRegex(diag.Stop, "START_CUTOFF"):
            diag.validate(self.p, self.b, NOW + 180)
        b = copy.deepcopy(self.b); b["ownerApproval"]["owner"] = "foreign"
        with self.assertRaisesRegex(diag.Stop, "OWNER_APPROVAL"):
            diag.validate(self.p, b, NOW)

    def test_timeout_stops_once_and_closes(self):
        transport = FakeTransport(failure="service")
        status = diag.run(self.p, self.b, self.dir, transport, lambda: NOW)
        self.assertEqual(status, "P08_TRAFFIC_SHAPE_DIAGNOSIS_STOPPED")
        journal = json.loads((self.dir / "journal.json").read_text())
        self.assertEqual(journal["failure"], "CLI_TIMEOUT")
        self.assertEqual(journal["cliReads"], 3)
        self.assertTrue(transport.closed)
        with self.assertRaises(FileExistsError):
            diag.run(self.p, self.b, self.dir, FakeTransport(), lambda: NOW)

    def test_child_containment_failure_is_not_success(self):
        transport = FakeTransport()
        transport.close = lambda: False
        status = diag.run(self.p, self.b, self.dir, transport, lambda: NOW)
        self.assertEqual(status, "CONTAINMENT_UNCONFIRMED")
        journal = json.loads((self.dir / "journal.json").read_text())
        self.assertEqual(journal["failure"], "CHILD_CONTAINMENT_UNCONFIRMED")
        self.assertEqual(journal["residuals"], ["CHILD_PROCESS_UNKNOWN"])

    def test_native_transport_exact_argv_and_safe_error(self):
        class Child:
            returncode = 0
            pid = 12345
            def __init__(self): self.done = False
            def communicate(self, timeout): self.done = True; return raw(inputs()["owner"]), b""
            def poll(self): return 0 if self.done else None
        child = Child()
        with patch.object(diag.subprocess, "Popen", return_value=child) as popen:
            transport = diag.NativeTransport(lambda: NOW)
            result = transport.cli(diag.descriptors()[0], NOW + 10)
        self.assertEqual(result, raw(inputs()["owner"]))
        self.assertEqual(popen.call_args.args[0], diag.descriptors()[0]["argv"])
        self.assertEqual(popen.call_args.kwargs["stderr"], subprocess.DEVNULL)
        self.assertTrue(popen.call_args.kwargs["start_new_session"])

    def test_native_timeout_kills_child_group(self):
        class HangingChild:
            pid = 12345
            returncode = None
            def __init__(self): self.dead = False
            def communicate(self, timeout): raise subprocess.TimeoutExpired("gcloud", timeout)
            def poll(self): return 0 if self.dead else None
            def wait(self, timeout): self.dead = True; return 0
        child = HangingChild()
        with patch.object(diag.subprocess, "Popen", return_value=child), patch.object(diag.os, "killpg") as kill:
            with self.assertRaisesRegex(diag.Stop, "CLI_TIMEOUT"):
                diag.NativeTransport(lambda: NOW).cli(diag.descriptors()[0], NOW + 10)
        kill.assert_called_once_with(child.pid, diag.signal.SIGKILL)
        self.assertTrue(child.dead)

    def test_native_cli_failure_categories_are_fixed_and_private(self):
        class CompletedChild:
            pid = 12345
            def __init__(self, code, output): self.returncode = code; self.output = output
            def communicate(self, timeout): return self.output, b"private stderr never captured"
            def poll(self): return self.returncode

        cases = [
            (CompletedChild(1, b"private account detail"), "CLI_NONZERO_EXIT"),
            (CompletedChild(0, b"private account detail" * (diag.MAX_OUTPUT // 10)), "CLI_OUTPUT_TOO_LARGE"),
        ]
        for child, code in cases:
            with self.subTest(code=code), patch.object(diag.subprocess, "Popen", return_value=child):
                with self.assertRaisesRegex(diag.Stop, code) as caught:
                    diag.NativeTransport(lambda: NOW).cli(diag.descriptors()[0], NOW + 10)
                self.assertEqual(str(caught.exception), code)
        with patch.object(diag.subprocess, "Popen", side_effect=FileNotFoundError("private local path")):
            with self.assertRaisesRegex(diag.Stop, "CLI_LAUNCH_ERROR") as caught:
                diag.NativeTransport(lambda: NOW).cli(diag.descriptors()[0], NOW + 10)
            self.assertEqual(str(caught.exception), "CLI_LAUNCH_ERROR")

    def test_native_fake_nonzero_stop_purges_without_raw_output(self):
        diag.reserve(self.dir / "plan.json", self.p)
        diag.reserve(self.dir / "binding.json", self.b)
        fake = FakeTransport(failure="owner")
        def nonzero(_descriptor, _deadline):
            raise diag.Stop("CLI_NONZERO_EXIT")
        fake.cli = nonzero
        with patch.object(diag.time, "time", return_value=NOW), patch.object(diag, "NativeTransport", return_value=fake):
            self.assertEqual(diag.native(["--diagnose", str(self.dir / "plan.json"), str(self.dir / "binding.json"), str(self.dir)]), 2)
        journal = (self.dir / "journal.json").read_text()
        self.assertEqual(json.loads(journal)["failure"], "CLI_NONZERO_EXIT")
        self.assertNotIn(diag.model.OWNER, journal)
        self.assertFalse((self.dir / "plan.json").exists())
        self.assertFalse((self.dir / "binding.json").exists())

    def test_native_purge_failure_reports_unconfirmed(self):
        diag.reserve(self.dir / "plan.json", self.p)
        diag.reserve(self.dir / "binding.json", self.b)
        with patch.object(diag.time, "time", return_value=NOW), patch.object(diag, "NativeTransport", return_value=FakeTransport()), patch.object(diag, "purge", return_value=False):
            self.assertEqual(diag.native(["--diagnose", str(self.dir / "plan.json"), str(self.dir / "binding.json"), str(self.dir)]), 2)
        self.assertTrue((self.dir / "plan.json").exists())

    def test_native_fake_success_purges_private_inputs(self):
        diag.reserve(self.dir / "plan.json", self.p)
        diag.reserve(self.dir / "binding.json", self.b)
        fake = FakeTransport()
        with patch.object(diag.time, "time", return_value=NOW), patch.object(diag, "NativeTransport", return_value=fake):
            self.assertEqual(diag.native(["--diagnose", str(self.dir / "plan.json"), str(self.dir / "binding.json"), str(self.dir)]), 0)
        self.assertTrue(fake.closed)
        self.assertFalse((self.dir / "plan.json").exists())
        self.assertFalse((self.dir / "binding.json").exists())
        self.assertTrue(json.loads((self.dir / "private-input-retirement.json").read_text())["privateInputsAbsent"])

    def test_source_drift_refuses_and_purges_before_any_read(self):
        diag.reserve(self.dir / "plan.json", self.p)
        diag.reserve(self.dir / "binding.json", self.b)
        with patch.object(diag, "verify_sources", side_effect=diag.Stop("SOURCE_DRIFT")), patch.object(diag.time, "time", return_value=NOW), patch.object(diag, "NativeTransport") as transport:
            self.assertEqual(diag.native(["--diagnose", str(self.dir / "plan.json"), str(self.dir / "binding.json"), str(self.dir)]), 2)
        transport.assert_not_called()
        self.assertFalse((self.dir / "plan.json").exists())
        self.assertFalse((self.dir / "binding.json").exists())

    def test_private_purge_and_readback(self):
        for name in ("plan.json", "binding.json"):
            diag.reserve(self.dir / name, {"private": name})
        self.assertTrue(diag.purge(self.dir))
        self.assertEqual(sorted(p.name for p in self.dir.iterdir()), ["private-input-retirement.json"])
        receipt = json.loads((self.dir / "private-input-retirement.json").read_text())
        self.assertTrue(receipt["privateInputsAbsent"])
        self.assertEqual(stat.S_IMODE((self.dir / "private-input-retirement.json").stat().st_mode), 0o600)
        with self.assertRaises((FileNotFoundError, diag.Stop)):
            diag.purge(self.dir)


if __name__ == "__main__":
    unittest.main()
