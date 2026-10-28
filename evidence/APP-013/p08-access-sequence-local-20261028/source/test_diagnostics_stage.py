import copy
import datetime as dt
import json
import multiprocessing as mp
import os
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path

import diagnostics_stage as m


NOW = 1793208000


def plan():
    operation = "20000000-0000-4000-8000-000000000002"
    iso = lambda offset: dt.datetime.fromtimestamp(NOW + offset, dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    return {
        "mode": "LOCAL_DIAGNOSTICS_STAGE_ONLY",
        "externalActionAuthorized": False,
        "operationId": operation,
        "projectId": "signmons",
        "projectNumber": "123456789012",
        "ownerPrincipal": m.OWNER,
        "service": m.SERVICE,
        "serviceRetention": "RETAIN_IF_ENABLED",
        "tuples": [list(value) for value in m.TUPLES],
        "automaticRetryAllowed": False,
        "stageBAllowed": False,
        "window": {
            "start": iso(-10),
            "cutoff": iso(20),
            "workEnd": iso(120),
            "cleanupEnd": iso(180),
            "purgeEnd": iso(240),
        },
    }


class Clock:
    def __init__(self, value=NOW):
        self.value = value

    def __call__(self):
        return self.value

    def pause(self, seconds):
        self.value += seconds


class Fake:
    def __init__(self, stage_plan, enabled=False):
        self.plan = stage_plan
        self.service = f"projects/{stage_plan['projectNumber']}/services/{m.SERVICE}"
        self.enabled = enabled
        self.calls = []
        self.states = ["CAN_ACCESS"] * 4
        self.pending = 0
        self.signal_at = None
        self.signal_number = signal.SIGTERM
        self.fail_at = None
        self.tweak = None

    def __call__(self, descriptor):
        self.calls.append(copy.deepcopy(descriptor))
        index = len(self.calls)
        if self.signal_at == index:
            os.kill(os.getpid(), self.signal_number)
        if self.fail_at == index:
            return {"httpStatus": 403, "body": json.dumps({"error": {"status": "PERMISSION_DENIED"}})}
        url = descriptor["url"]
        method = descriptor["method"]
        body = json.loads(descriptor["body"]) if descriptor["body"] is not None else None
        if url == m.SERVICE_HOST + self.service and method == "GET":
            value = {"name": self.service, "state": "ENABLED" if self.enabled else "DISABLED"}
        elif url == m.SERVICE_HOST + self.service + ":enable" and method == "POST":
            self.enabled = True
            value = {"name": "operations/su-enable"}
        elif url == m.SERVICE_HOST + "operations/su-enable" and method == "GET":
            if self.pending:
                self.pending -= 1
                value = {"name": "operations/su-enable"}
            else:
                value = {
                    "name": "operations/su-enable",
                    "done": True,
                    "response": {"service": {"name": self.service, "state": "ENABLED"}},
                }
        elif url == m.DIAGNOSTIC_URL and method == "POST":
            permission = body["accessTuple"]["permission"]
            expected = [value[2] for value in m.TUPLES]
            value = {"overallAccessState": self.states[expected.index(permission)]}
        else:
            return {"httpStatus": 500, "body": json.dumps({"error": {"status": "UNEXPECTED"}})}
        if self.tweak:
            value = self.tweak(index, descriptor, value)
        return {"httpStatus": 200, "body": json.dumps(value)}


def reserve_worker(path, ready, go, output):
    ready.put(True)
    go.wait()
    try:
        m.reserve(Path(path), {"worker": os.getpid()})
        output.put("WON")
    except FileExistsError:
        output.put("REFUSED")


class DiagnosticsStageTests(unittest.TestCase):
    def setUp(self):
        self.plan = plan()
        self.clock = Clock()
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)

    def tearDown(self):
        signal.setitimer(signal.ITIMER_REAL, 0)
        self.temporary.cleanup()

    def controller(self, fake=None, name="run", mode="run"):
        fake = fake or Fake(self.plan)
        adapter = m.RequestAdapter(self.plan, fake)
        controller = m.Controller(self.plan, adapter, self.root / name, clock=self.clock, pause=self.clock.pause, mode=mode)
        return controller, fake

    def test_disabled_service_four_diagnostics_and_stage_b_refusal(self):
        controller, fake = self.controller()
        result = controller.run()
        self.assertEqual(result["status"], "LOCAL_DIAGNOSTICS_STAGE_COMPLETE")
        self.assertEqual(result["serviceState"], "SERVICE_ENABLED_RETAINED")
        self.assertTrue(result["fourDiagnosticsCanAccess"])
        self.assertTrue(result["stageBCandidate"])
        self.assertFalse(result["stageBActionAuthorized"])
        self.assertEqual(len(result["diagnostics"]), 4)
        self.assertFalse(any("apikeys.googleapis.com" in value["url"] for value in fake.calls))
        with self.assertRaisesRegex(m.Stop, "STAGE_B_REFUSED_UNQUALIFIED"):
            controller.adapter.stage_b()

    def test_preexisting_enabled_does_not_enable_or_disable(self):
        controller, fake = self.controller(Fake(self.plan, enabled=True))
        result = controller.run()
        self.assertEqual(result["serviceState"], "PREEXISTING_ENABLED")
        urls = [value["url"] for value in fake.calls]
        self.assertFalse(any(url.endswith(":enable") or url.endswith(":disable") for url in urls))

    def test_exact_serialized_requests_and_no_sensitive_headers(self):
        controller, fake = self.controller()
        controller.run()
        self.assertEqual(fake.calls[0], {
            "method": "GET",
            "url": m.SERVICE_HOST + fake.service,
            "body": None,
            "timeoutSeconds": 8,
            "redirect": "error",
        })
        self.assertEqual(json.loads(fake.calls[1]["body"]), {})
        diagnostic_calls = [value for value in fake.calls if value["url"] == m.DIAGNOSTIC_URL]
        self.assertEqual(len(diagnostic_calls), 4)
        for descriptor, expected in zip(diagnostic_calls, m.TUPLES):
            body = json.loads(descriptor["body"])["accessTuple"]
            self.assertEqual((body["principal"], body["fullResourceName"], body["permission"]), expected)
            self.assertRegex(body["conditionContext"]["request"]["receiveTime"], r"Z$")
            self.assertNotIn("Authorization", descriptor)
            self.assertNotIn("token", json.dumps(descriptor).lower())

    def test_unknown_and_denied_states_never_qualify_stage_b(self):
        for state in ("CANNOT_ACCESS", "UNKNOWN_INFO", "UNKNOWN_CONDITIONAL", "OVERALL_ACCESS_STATE_UNSPECIFIED"):
            with self.subTest(state=state):
                fake = Fake(self.plan, enabled=True)
                fake.states[2] = state
                controller, _ = self.controller(fake, name=state)
                result = controller.run()
                self.assertEqual(result["status"], "LOCAL_DIAGNOSTICS_STAGE_COMPLETE")
                self.assertFalse(result["fourDiagnosticsCanAccess"])
                self.assertFalse(result["stageBCandidate"])

    def test_invalid_diagnostic_state_stops(self):
        fake = Fake(self.plan, enabled=True)
        fake.states[0] = "GRANTED"
        result = self.controller(fake)[0].run()
        self.assertEqual(result["failure"], "DIAGNOSTIC_SHAPE")
        self.assertFalse(result["stageBCandidate"])

    def test_provider_denial_stops_without_retry(self):
        fake = Fake(self.plan)
        fake.fail_at = 2
        result = self.controller(fake)[0].run()
        self.assertEqual(result["failure"], "PROVIDER_REFUSED")
        self.assertEqual(len(fake.calls), 2)
        self.assertEqual(result["residuals"], ["SERVICE_ENABLE_OUTCOME_UNKNOWN"])

    def test_enable_lost_response_is_truthful(self):
        fake = Fake(self.plan)
        fake.tweak = lambda index, descriptor, value: {"unexpected": True} if index == 2 else value
        result = self.controller(fake)[0].run()
        self.assertEqual(result["failure"], "OPERATION_SHAPE")
        self.assertEqual(result["residuals"], ["SERVICE_ENABLE_OUTCOME_UNKNOWN"])

    def test_enable_response_and_readback_are_strict(self):
        cases = {
            "foreign": lambda value: {**value, "response": {"service": {"name": "projects/123/services/foreign.googleapis.com", "state": "ENABLED"}}},
            "extra": lambda value: {**value, "response": {"service": {"name": Fake(self.plan).service, "state": "ENABLED"}, "dependentServices": []}},
            "disabled": lambda value: {**value, "response": {"service": {"name": Fake(self.plan).service, "state": "DISABLED"}}},
        }
        for name, change in cases.items():
            with self.subTest(name=name):
                self.clock.value = NOW
                fake = Fake(self.plan)
                fake.tweak = lambda index, descriptor, value, change=change: change(value) if index == 3 else value
                result = self.controller(fake, name=name)[0].run()
                self.assertIn(result["failure"], ("UNEXPECTED_ENABLE_RESPONSE", "ENABLE_READBACK"))
                self.assertEqual(result["residuals"], ["SERVICE_ENABLE_OUTCOME_UNKNOWN"])

    def test_bounded_polling_and_final_poll(self):
        fake = Fake(self.plan)
        fake.pending = 2
        result = self.controller(fake)[0].run()
        self.assertEqual(result["status"], "LOCAL_DIAGNOSTICS_STAGE_COMPLETE")
        polls = [value for value in fake.calls if "operations/su-enable" in value["url"]]
        self.assertEqual(len(polls), 3)

    def test_poll_limit_is_no_retry_of_mutation(self):
        fake = Fake(self.plan)
        fake.pending = 20
        result = self.controller(fake)[0].run()
        self.assertEqual(result["failure"], "POLL_LIMIT")
        enables = [value for value in fake.calls if value["url"].endswith(":enable")]
        self.assertEqual(len(enables), 1)

    def test_request_timeout(self):
        fake = Fake(self.plan, enabled=True)

        def slow(_descriptor):
            time.sleep(9)
            return {"httpStatus": 200, "body": "{}"}

        controller = m.Controller(self.plan, m.RequestAdapter(self.plan, slow), self.root / "timeout", clock=self.clock, pause=self.clock.pause)
        started = time.monotonic()
        result = controller.run()
        self.assertEqual(result["failure"], "REQUEST_TIMEOUT")
        self.assertLess(time.monotonic() - started, 8.5)

    def test_signals_at_every_modeled_transition(self):
        for number in (signal.SIGINT, signal.SIGTERM):
            for call_index in range(1, 9):
                with self.subTest(signal=number, call=call_index):
                    self.clock.value = NOW
                    fake = Fake(self.plan)
                    fake.signal_at = call_index
                    fake.signal_number = number
                    controller, _ = self.controller(fake, name=f"signal-{number}-{call_index}")
                    result = controller.run()
                    self.assertEqual(result["failure"], "INTERRUPTED")
                    self.assertFalse(result["stageBActionAuthorized"])

    def test_clock_rollback_and_deadline(self):
        controller, _ = self.controller(Fake(self.plan, enabled=True), name="rollback")
        controller.last = NOW + 1
        result = controller.run()
        self.assertEqual(result["failure"], "CLOCK_ROLLBACK")
        self.clock.value = NOW + 121
        with self.assertRaisesRegex(m.Stop, "START_CUTOFF"):
            self.controller(Fake(self.plan), name="late")

    def test_plan_validation_refuses_material_changes(self):
        changes = {
            "mode": "LIVE",
            "externalActionAuthorized": True,
            "projectId": "foreign",
            "ownerPrincipal": "other@example.com",
            "service": "apikeys.googleapis.com",
            "serviceRetention": "DISABLE_AFTER_USE",
            "automaticRetryAllowed": True,
            "stageBAllowed": True,
            "projectNumber": "not-a-number",
            "tuples": [],
        }
        for field, value in changes.items():
            with self.subTest(field=field):
                candidate = copy.deepcopy(self.plan)
                candidate[field] = value
                with self.assertRaises(m.Stop):
                    m.approve_local_plan(candidate, NOW)

    def test_host_scope_and_output_contract(self):
        adapter = m.RequestAdapter(self.plan, lambda descriptor: {"httpStatus": 200, "body": "{}"})
        with self.assertRaisesRegex(m.Stop, "HOST_SCOPE"):
            adapter.call("GET", "https://apikeys.googleapis.com/v2/projects/x/keys/y")
        with self.assertRaisesRegex(m.Stop, "HOST_SCOPE"):
            adapter.call("GET", "https://example.com/")
        bad = [
            None,
            {"httpStatus": "200", "body": "{}"},
            {"httpStatus": 200, "body": None},
            {"httpStatus": 200, "body": "[]"},
            {"httpStatus": 500, "body": "{}"},
            {"httpStatus": 200, "body": "x" * 65537},
        ]
        for index, response in enumerate(bad):
            with self.subTest(index=index):
                candidate = m.RequestAdapter(self.plan, lambda descriptor, response=response: response)
                with self.assertRaises((m.Stop, json.JSONDecodeError)):
                    candidate.service_get()

    def test_diagnostic_scope_refuses_extra_tuple(self):
        adapter = m.RequestAdapter(self.plan, lambda descriptor: {"httpStatus": 200, "body": "{}"})
        with self.assertRaisesRegex(m.Stop, "DIAGNOSTIC_SCOPE"):
            adapter.diagnostic(m.OWNER, "//cloudresourcemanager.googleapis.com/projects/signmons", "resourcemanager.projects.delete", "2026-10-28T12:00:00Z")

    def test_operation_scope_refuses_foreign_name(self):
        adapter = m.RequestAdapter(self.plan, lambda descriptor: {"httpStatus": 200, "body": "{}"})
        for name in ("projects/x/operations/y", "../operations/y", "operations/", "operations/a/b"):
            with self.subTest(name=name), self.assertRaisesRegex(m.Stop, "SERVICE_OPERATION_SCOPE"):
                adapter.service_operation(name)

    def test_closeout_only_reads_and_never_mutates(self):
        controller, fake = self.controller(Fake(self.plan, enabled=True), name="closeout-source")
        controller.run()
        self.clock.value = NOW + 130
        closeout = m.Controller(self.plan, m.RequestAdapter(self.plan, fake), self.root / "closeout-source", clock=self.clock, pause=self.clock.pause, mode="closeout")
        result = closeout.closeout_only()
        self.assertEqual(result["serviceState"], "ENABLED")
        self.assertFalse(result["serviceMutationAttempted"])
        self.assertFalse(result["stageBActionAuthorized"])
        self.assertEqual(fake.calls[-1]["method"], "GET")

    def test_closeout_refuses_foreign_journal(self):
        directory = self.root / "foreign-journal"
        directory.mkdir(mode=0o700)
        foreign = copy.deepcopy(self.plan)
        foreign["operationId"] = "30000000-0000-4000-8000-000000000003"
        path = directory / "journal.json"
        path.write_text(json.dumps({"operationId": foreign["operationId"], "planSha256": m.digest(foreign)}))
        path.chmod(0o600)
        self.clock.value = NOW + 130
        controller = m.Controller(self.plan, m.RequestAdapter(self.plan, Fake(self.plan, enabled=True)), directory, clock=self.clock, pause=self.clock.pause, mode="closeout")
        with self.assertRaisesRegex(m.Stop, "JOURNAL_SCOPE"):
            controller.closeout_only()

    def test_exclusive_reservation_process_race(self):
        path = self.root / "race.json"
        ready = mp.Queue()
        output = mp.Queue()
        go = mp.Event()
        workers = [mp.Process(target=reserve_worker, args=(str(path), ready, go, output)) for _ in range(2)]
        for worker in workers:
            worker.start()
        ready.get(timeout=5)
        ready.get(timeout=5)
        go.set()
        for worker in workers:
            worker.join(timeout=5)
            self.assertFalse(worker.is_alive())
        self.assertEqual(sorted([output.get(timeout=5), output.get(timeout=5)]), ["REFUSED", "WON"])

    def test_attempt_is_one_use(self):
        controller, _ = self.controller(Fake(self.plan, enabled=True), name="one-use")
        controller.run()
        second = m.Controller(self.plan, m.RequestAdapter(self.plan, Fake(self.plan, enabled=True)), self.root / "one-use", clock=self.clock, pause=self.clock.pause)
        with self.assertRaises(FileExistsError):
            second.run()

    def test_saved_evidence_contains_no_raw_policy_or_secret(self):
        controller, _ = self.controller()
        controller.run()
        content = "\n".join(path.read_text() for path in (self.root / "run").glob("*.json"))
        for forbidden in ("Bearer ", "private_key", "keyString", "bindings", "rawPolicy", "whsec_", "sk_test_"):
            self.assertNotIn(forbidden, content)

    def test_source_manifest_passes_and_detects_drift(self):
        manifest = m.check_sources()
        self.assertEqual(manifest["status"], "DISABLED_LOCAL_PREPARATION_ONLY")
        copied = self.root / "source-copy"
        shutil.copytree(m.ROOT, copied)
        (copied / "diagnostics_stage.py").write_text((copied / "diagnostics_stage.py").read_text() + "\n# drift\n")
        with self.assertRaisesRegex(m.Stop, "SOURCE_DRIFT"):
            m.check_sources(copied)

    def test_native_refuses_before_any_provider_access(self):
        completed = subprocess.run([sys.executable, "-B", str(m.ROOT / "diagnostics_stage.py")], cwd=m.ROOT, capture_output=True, text=True, timeout=5)
        self.assertEqual(completed.returncode, 2)
        self.assertEqual(completed.stdout.strip(), "P08_DIAGNOSTICS_STAGE_REFUSED_UNBOUND")
        self.assertEqual(completed.stderr, "")


if __name__ == "__main__":
    unittest.main(verbosity=2)
