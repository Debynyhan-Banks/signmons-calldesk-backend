import copy
import datetime as dt
import json
import os
import signal
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import diagnostics_stage as stage
import launch_binding as m


NOW = 1793208000
PROJECT_NUMBER = "123456789012"
MANIFEST_SHA = "a" * 64


class Clock:
    def __init__(self, value=NOW):
        self.value = value

    def __call__(self):
        return self.value

    def pause(self, seconds):
        self.value += seconds


def operation_plan():
    iso = lambda offset: dt.datetime.fromtimestamp(NOW + offset, dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    value = {
        "mode": m.PLAN_MODE,
        "externalActionAuthorized": True,
        "operationId": "30000000-0000-4000-8000-000000000003",
        "decisionId": "30000000-0000-4000-8000-000000000004",
        "projectId": stage.PROJECT,
        "projectNumber": PROJECT_NUMBER,
        "projectNumberFingerprint": m.canonical_project_fingerprint(PROJECT_NUMBER),
        "projectFingerprintEncoding": "CANONICAL_JSON_STRING_SHA256",
        "ownerPrincipal": stage.OWNER,
        "service": stage.SERVICE,
        "serviceRetention": "RETAIN_IF_ENABLED",
        "tuples": [list(value) for value in stage.TUPLES],
        "automaticRetryAllowed": False,
        "stageBAllowed": False,
        "sourceManifestSha256": MANIFEST_SHA,
        "window": {
            "start": iso(-10), "cutoff": iso(30), "workEnd": iso(180),
            "cleanupEnd": iso(240), "purgeEnd": iso(300),
        },
        "approval": {
            "externalActionApproved": True,
            "proposalCommit": m.PROPOSAL_COMMIT,
            "decisionId": "30000000-0000-4000-8000-000000000004",
            "governanceCommit": "b" * 40,
            "operationDocument": "APP013_P08_STAGE_A_OPERATION_20261028.md",
            "documentSha256": "0" * 64,
        },
    }
    document = approval_document(value)
    value["approval"]["documentSha256"] = m.sha256(document)
    return value, document


def approval_document(plan):
    return ("owner decision: APPROVED\noperation: " + plan["operationId"] + "\ndecision: " +
            plan["decisionId"] + "\nsource: " + plan["sourceManifestSha256"] +
            "\nretention: RETAIN_IF_ENABLED\n").encode()


class FakeCLI:
    def __init__(self, plan, account=stage.OWNER, project=None, token="fixture-token-value-1234567890"):
        self.plan = plan
        self.account = account
        self.project = project or {"projectId": stage.PROJECT, "projectNumber": plan["projectNumber"]}
        self.token_value = token
        self.calls = []
        self.closed = False
        self.fail_at = None

    def __call__(self, arguments, deadline):
        self.calls.append((copy.deepcopy(arguments), deadline))
        if self.fail_at == len(self.calls):
            raise m.Stop("CLI_REFUSED")
        if arguments[0] == "config":
            return self.account
        if arguments[0] == "projects":
            return json.dumps(self.project)
        if arguments[0] == "auth":
            return self.token_value
        raise AssertionError(arguments)

    def close(self):
        self.closed = True
        return True


class FakeHTTP:
    def __init__(self, plan, enabled=False):
        self.service = f"projects/{plan['projectNumber']}/services/{stage.SERVICE}"
        self.enabled = enabled
        self.calls = []
        self.states = ["CAN_ACCESS"] * 4
        self.fail_at = None
        self.response_tweak = None

    def __call__(self, descriptor, token, deadline):
        self.calls.append({"descriptor": copy.deepcopy(descriptor), "token": token, "deadline": deadline})
        index = len(self.calls)
        if self.fail_at == index:
            raise m.Stop("HTTPS_REFUSED")
        url = descriptor["url"]
        method = descriptor["method"]
        body = json.loads(descriptor["body"]) if descriptor["body"] is not None else None
        if url == stage.SERVICE_HOST + self.service and method == "GET":
            value = {"name": self.service, "state": "ENABLED" if self.enabled else "DISABLED"}
        elif url == stage.SERVICE_HOST + self.service + ":enable" and method == "POST":
            self.enabled = True
            value = {"name": "operations/stage-a-enable"}
        elif url == stage.SERVICE_HOST + "operations/stage-a-enable" and method == "GET":
            value = {"name": "operations/stage-a-enable", "done": True,
                     "response": {"service": {"name": self.service, "state": "ENABLED"}}}
        elif url == stage.DIAGNOSTIC_URL and method == "POST":
            access = body["accessTuple"]
            exact = (access["principal"], access["fullResourceName"], access["permission"])
            value = {"overallAccessState": self.states[list(stage.TUPLES).index(exact)]}
        else:
            raise AssertionError((method, url))
        if self.response_tweak:
            value = self.response_tweak(index, value)
        return {"httpStatus": 200, "body": json.dumps(value)}


class LaunchBindingTests(unittest.TestCase):
    def setUp(self):
        self.plan, self.document = operation_plan()
        self.clock = Clock()
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)

    def tearDown(self):
        signal.setitimer(signal.ITIMER_REAL, 0)
        self.temporary.cleanup()

    def reader(self, commit, path):
        self.assertEqual(commit, self.plan["approval"]["governanceCommit"])
        self.assertEqual(path, self.plan["approval"]["operationDocument"])
        return self.document

    def execute(self, cli=None, http=None, name="result"):
        cli = cli or FakeCLI(self.plan)
        http = http or FakeHTTP(self.plan)
        result = m.execute(self.plan, self.root / name, MANIFEST_SHA, cli, http, self.reader,
                           clock=self.clock, pause=self.clock.pause)
        return result, cli, http

    def test_plan_and_approval_document_bind_every_authority(self):
        local, window = m.validate_plan(self.plan, MANIFEST_SHA, NOW)
        self.assertEqual(local["mode"], "LOCAL_DIAGNOSTICS_STAGE_ONLY")
        self.assertFalse(local["externalActionAuthorized"])
        self.assertGreater(window["workEnd"], NOW)
        m.verify_approval_document(self.plan, self.reader)

    def test_legacy_and_same_day_renewal_filenames_are_valid(self):
        for name in (
            "APP013_P08_STAGE_A_OPERATION_20261028.md",
            "APP013_P08_STAGE_A_OPERATION_20261028_R01.md",
            "APP013_P08_STAGE_A_OPERATION_20261028_R99.md",
        ):
            with self.subTest(name=name):
                changed = copy.deepcopy(self.plan)
                changed["approval"]["operationDocument"] = name
                local, _window = m.validate_plan(changed, MANIFEST_SHA, NOW)
                self.assertFalse(local["externalActionAuthorized"])

    def test_malformed_renewal_date_mismatch_and_cross_midnight_refuse(self):
        malformed = (
            "APP013_P08_STAGE_A_OPERATION_20261028_R00.md",
            "APP013_P08_STAGE_A_OPERATION_20261028_R1.md",
            "APP013_P08_STAGE_A_OPERATION_20261028_R001.md",
            "APP013_P08_STAGE_A_OPERATION_20261028_R100.md",
            "APP013_P08_STAGE_A_OPERATION_20261028_R01_extra.md",
            "../APP013_P08_STAGE_A_OPERATION_20261028_R01.md",
        )
        for name in malformed:
            with self.subTest(name=name):
                changed = copy.deepcopy(self.plan)
                changed["approval"]["operationDocument"] = name
                with self.assertRaisesRegex(stage.Stop, "OPERATION_DOCUMENT"):
                    m.validate_plan(changed, MANIFEST_SHA, NOW)
        changed = copy.deepcopy(self.plan)
        changed["approval"]["operationDocument"] = "APP013_P08_STAGE_A_OPERATION_20261029_R01.md"
        with self.assertRaisesRegex(stage.Stop, "OPERATION_DOCUMENT_DATE"):
            m.validate_plan(changed, MANIFEST_SHA, NOW)
        crossed = copy.deepcopy(self.plan)
        crossed["window"] = {
            "start": "2026-10-29T03:55:00Z",
            "cutoff": "2026-10-29T04:00:00Z",
            "workEnd": "2026-10-29T04:05:00Z",
            "cleanupEnd": "2026-10-29T04:06:00Z",
            "purgeEnd": "2026-10-29T04:07:00Z",
        }
        with self.assertRaisesRegex(stage.Stop, "OPERATION_DOCUMENT_DATE"):
            m.validate_plan(crossed, MANIFEST_SHA, NOW)

    def test_plan_refuses_missing_or_changed_authority(self):
        cases = {
            "external": ("externalActionAuthorized", False),
            "manifest": ("sourceManifestSha256", "f" * 64),
            "owner": ("ownerPrincipal", "other@example.com"),
            "service": ("service", "apikeys.googleapis.com"),
            "retry": ("automaticRetryAllowed", True),
            "stage_b": ("stageBAllowed", True),
            "retention": ("serviceRetention", "DISABLE"),
            "encoding": ("projectFingerprintEncoding", "RAW"),
        }
        for name, (field, value) in cases.items():
            with self.subTest(name=name):
                changed = copy.deepcopy(self.plan)
                changed[field] = value
                with self.assertRaises(stage.Stop):
                    m.validate_plan(changed, MANIFEST_SHA, NOW)

    def test_approval_document_hash_and_content_refuse(self):
        with self.assertRaisesRegex(stage.Stop, "OPERATION_DOCUMENT_HASH"):
            m.verify_approval_document(self.plan, lambda *_: self.document + b"x")
        altered = self.document.replace(self.plan["operationId"].encode(), b"missing")
        changed = copy.deepcopy(self.plan)
        changed["approval"]["documentSha256"] = m.sha256(altered)
        with self.assertRaisesRegex(stage.Stop, "APPROVAL_DOCUMENT_BINDING"):
            m.verify_approval_document(changed, lambda *_: altered)

    def test_disabled_service_exact_requests_and_retained_state(self):
        result, cli, http = self.execute()
        self.assertEqual(result["status"], "P08_STAGE_A_DIAGNOSTICS_COMPLETE")
        self.assertEqual(result["serviceState"], "SERVICE_ENABLED_RETAINED")
        self.assertEqual(result["httpsRequestCount"], 8)
        self.assertTrue(result["fourDiagnosticsCanAccess"])
        self.assertTrue(result["stageBCandidate"])
        self.assertFalse(result["stageBActionAuthorized"])
        self.assertTrue(result["providerMutationPossible"])
        self.assertTrue(result["credentialCleared"])
        self.assertTrue(cli.closed)
        self.assertTrue(result["modelScratchPurged"])
        self.assertFalse(any("apikeys.googleapis.com" in call["descriptor"]["url"] for call in http.calls))
        self.assertFalse(any(call["descriptor"]["url"].endswith(":disable") for call in http.calls))
        saved = json.loads((self.root / "result" / "result.json").read_text())
        self.assertNotIn("token", json.dumps(saved).lower())
        self.assertNotIn(PROJECT_NUMBER, json.dumps(saved))

    def test_preenabled_skips_enable_and_never_disables(self):
        http = FakeHTTP(self.plan, enabled=True)
        result, _cli, http = self.execute(http=http)
        self.assertEqual(result["serviceState"], "PREEXISTING_ENABLED")
        self.assertEqual(result["httpsRequestCount"], 5)
        self.assertFalse(result["providerMutationPossible"])
        urls = [call["descriptor"]["url"] for call in http.calls]
        self.assertFalse(any(url.endswith(":enable") or url.endswith(":disable") for url in urls))

    def test_owner_project_and_fingerprint_stop_before_token_or_https(self):
        cases = [
            FakeCLI(self.plan, account="other@example.com"),
            FakeCLI(self.plan, project={"projectId": "other", "projectNumber": PROJECT_NUMBER}),
            FakeCLI(self.plan, project={"projectId": stage.PROJECT, "projectNumber": "999999999999"}),
        ]
        for index, cli in enumerate(cases):
            with self.subTest(index=index):
                http = FakeHTTP(self.plan)
                result, cli, http = self.execute(cli=cli, http=http, name=f"identity-{index}")
                self.assertEqual(result["status"], "P08_STAGE_A_LAUNCH_STOPPED")
                self.assertEqual(http.calls, [])
                self.assertFalse(any(call[0][0] == "auth" for call in cli.calls))
                self.assertTrue(result["credentialCleared"])

    def test_token_format_and_cli_failure_close_without_https(self):
        for index, cli in enumerate((FakeCLI(self.plan, token="short"), FakeCLI(self.plan))):
            if index == 1:
                cli.fail_at = 3
            result, cli, http = self.execute(cli=cli, name=f"cli-{index}")
            self.assertEqual(result["status"], "P08_STAGE_A_LAUNCH_STOPPED")
            self.assertEqual(http.calls, [])
            self.assertTrue(cli.closed)
            self.assertTrue(result["modelScratchPurged"])

    def test_diagnostic_unknowns_never_authorize_stage_b(self):
        for index, state in enumerate(("CANNOT_ACCESS", "UNKNOWN_INFO", "UNKNOWN_CONDITIONAL", "OVERALL_ACCESS_STATE_UNSPECIFIED")):
            with self.subTest(state=state):
                http = FakeHTTP(self.plan, enabled=True)
                http.states[index] = state
                result, _cli, _http = self.execute(http=http, name=f"state-{index}")
                self.assertEqual(result["status"], "P08_STAGE_A_DIAGNOSTICS_COMPLETE")
                self.assertFalse(result["fourDiagnosticsCanAccess"])
                self.assertFalse(result["stageBCandidate"])
                self.assertFalse(result["stageBActionAuthorized"])

    def test_lost_enable_response_is_unknown_and_never_resubmitted(self):
        http = FakeHTTP(self.plan)
        http.fail_at = 2
        result, _cli, http = self.execute(http=http)
        self.assertEqual(result["status"], "P08_STAGE_A_DIAGNOSTICS_STOPPED")
        self.assertEqual(result["failure"], "HTTPS_REFUSED")
        self.assertEqual(result["serviceState"], "ENABLE_OUTCOME_UNKNOWN")
        self.assertTrue(result["providerMutationPossible"])
        self.assertEqual(sum(call["descriptor"]["url"].endswith(":enable") for call in http.calls), 1)

    def test_malformed_provider_output_closes_and_purges(self):
        http = FakeHTTP(self.plan, enabled=True)
        http.response_tweak = lambda index, value: {"unexpected": True} if index == 1 else value
        result, cli, _http = self.execute(http=http)
        self.assertEqual(result["status"], "P08_STAGE_A_DIAGNOSTICS_STOPPED")
        self.assertEqual(result["failure"], "SERVICE_SHAPE")
        self.assertTrue(cli.closed)
        self.assertTrue(result["modelScratchPurged"])

    def test_http_failure_after_token_clears_credential(self):
        http = FakeHTTP(self.plan, enabled=True)
        http.fail_at = 1
        result, cli, _http = self.execute(http=http)
        self.assertEqual(result["failure"], "HTTPS_REFUSED")
        self.assertTrue(result["credentialCleared"])
        self.assertTrue(cli.closed)

    def test_deadline_and_clock_rollback_refuse(self):
        late = copy.deepcopy(self.plan)
        late["window"]["cutoff"] = late["window"]["start"]
        with self.assertRaises(stage.Stop):
            m.validate_plan(late, MANIFEST_SHA, NOW)
        clock = Clock()
        http = FakeHTTP(self.plan, enabled=True)
        original = http.__call__

        class Rollback:
            def __call__(_self, descriptor, token, deadline):
                value = original(descriptor, token, deadline)
                clock.value -= 1
                return value

        result = m.execute(self.plan, self.root / "rollback", MANIFEST_SHA, FakeCLI(self.plan), Rollback(),
                           self.reader, clock=clock, pause=clock.pause)
        self.assertEqual(result["failure"], "CLOCK_ROLLBACK")

    def test_native_adapters_refuse_scope_before_process_or_network(self):
        cli = m.NativeCLI(binary="/usr/bin/true", clock=lambda: NOW)
        with self.assertRaisesRegex(stage.Stop, "CLI_SCOPE"):
            cli(["services", "enable", "apikeys.googleapis.com"], NOW + 5)
        self.assertEqual(cli(["config", "get-value", "account", "--quiet"], NOW + 5), "")
        self.assertTrue(cli.close())
        http = m.NativeHTTP(clock=lambda: NOW)
        with self.assertRaisesRegex(stage.Stop, "HOST_SCOPE"):
            http({"url": "https://apikeys.googleapis.com/v2/keys", "method": "GET", "body": None,
                  "timeoutSeconds": 8}, "fixture-token-value-123456", NOW + 5)

    def test_native_cli_interruption_terminates_and_untracks_child(self):
        class Child:
            pid = 424242
            returncode = None

            def communicate(self, timeout):
                raise KeyboardInterrupt()

            def poll(self):
                return self.returncode

            def wait(self, timeout):
                self.returncode = -signal.SIGTERM
                return self.returncode

        child = Child()
        cli = m.NativeCLI(binary="/opt/homebrew/bin/gcloud", clock=lambda: NOW)
        with mock.patch.object(m.subprocess, "Popen", return_value=child), mock.patch.object(m.os, "killpg") as kill:
            with self.assertRaises(KeyboardInterrupt):
                cli(["config", "get-value", "account", "--quiet"], NOW + 5)
        kill.assert_called_once_with(child.pid, signal.SIGTERM)
        self.assertEqual(cli.children, set())
        self.assertTrue(cli.close())

    def test_private_plan_permissions_and_json(self):
        path = self.root / "plan.json"
        path.write_text(json.dumps(self.plan))
        os.chmod(path, 0o600)
        self.assertEqual(m.private_json(path)["operationId"], self.plan["operationId"])
        os.chmod(path, 0o644)
        with self.assertRaisesRegex(stage.Stop, "PRIVATE_PERMISSIONS"):
            m.private_json(path)

    def test_native_unbound_refuses_before_prompt(self):
        completed = subprocess.run([sys.executable, "-B", str(m.ROOT / "launch_binding.py")], cwd=m.ROOT,
                                   capture_output=True, text=True, timeout=5)
        self.assertEqual(completed.returncode, 2)
        self.assertEqual(completed.stdout.strip(), "P08_STAGE_A_LAUNCH_REFUSED_UNBOUND")
        self.assertNotIn("password", completed.stdout.lower())


if __name__ == "__main__":
    unittest.main()
