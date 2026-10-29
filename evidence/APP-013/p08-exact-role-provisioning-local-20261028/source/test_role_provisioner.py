from __future__ import annotations

import copy
import json
import os
import signal
import subprocess
import sys
import tempfile
import time
import unittest
import uuid
from pathlib import Path
from unittest import mock

import role_provisioner as p


class Clock:
    def __init__(self): self.value = 1_800_000_000.0
    def __call__(self): return self.value


class Fake:
    def __init__(self):
        self.roles = {}
        self.bindings = []
        self.calls = []
        self.fail_create = None
        self.lost_create = None
        self.drift = None
        self.signal_create = None
        self.cli_failure = None

    def definition(self, role):
        return {
            "name": role["name"], "title": role["title"], "description": role["description"],
            "includedPermissions": [role["permission"]], "stage": "GA", "deleted": False,
            "etag": "BwYFixture=",
        }

    def __call__(self, command, deadline):
        command = tuple(command)
        self.calls.append(command)
        if command == p.preflight_commands()[0]: return p.OWNER
        if command == p.preflight_commands()[1]: return p.PROJECT
        if command == p.preflight_commands()[2]: return {"state": "ENABLED"}
        if command in p.policy_commands(): return {"bindings": copy.deepcopy(self.bindings)}
        for role in p.ROLES:
            if command == p.describe_command(role):
                if role["kind"] not in self.roles: raise p.NotFound()
                value = copy.deepcopy(self.roles[role["kind"]])
                if self.drift == role["kind"]: value["includedPermissions"].append("resourcemanager.projects.get")
                return value
            if command == p.create_command(role):
                if self.fail_create == role["kind"]: raise RuntimeError("private-provider-body")
                self.roles[role["kind"]] = self.definition(role)
                if self.signal_create == role["kind"]: os.kill(os.getpid(), signal.SIGTERM)
                if self.lost_create == role["kind"]: raise p.LostResponse("private-lost-response")
                return copy.deepcopy(self.roles[role["kind"]])
        raise AssertionError(command)


class NativeFake:
    def __init__(self):
        self.calls = []
        self.roles = {}
        self.permissions = list(p.PERMISSIONS)
        self.collision = None
        self.lost_create = None
        self.signal_create = None
        self.cli_failure = None
        self.http_failure = None
        self.project_number = "123456789012"
        self.project_result = None
        self.service_state = "ENABLED"
        self.private_token = "private-token-" + "x" * 24

    def definition(self, role):
        return {
            "name": role["name"], "title": role["title"], "description": role["description"],
            "includedPermissions": [role["permission"]], "stage": "GA", "deleted": False,
            "etag": "BwYNativeFixture=",
        }

    def cli(self, command, deadline):
        command = tuple(command)
        self.calls.append(("CLI", command))
        commands = p.native_cli_commands()
        if self.cli_failure and command == commands[self.cli_failure[0]]:
            raise p.CliFailure(self.cli_failure[1])
        if command == commands[0]: return p.OWNER
        if command == commands[1]: return p.PROJECT
        if command == commands[2]: return self.private_token
        if command in commands[3:]: return json.dumps({"bindings": []})
        raise AssertionError(command)

    def https(self, method, url, headers, body, deadline):
        self.calls.append(("HTTPS", method, url, copy.deepcopy(headers), copy.deepcopy(body)))
        if self.http_failure and url == self.http_failure[0]:
            raise p.HttpFailure(self.http_failure[1])
        if url == p.project_url():
            return 200, copy.deepcopy(self.project_result or {
                "projectId": p.PROJECT, "projectNumber": self.project_number,
                "lifecycleState": "ACTIVE", "name": "private-project-name",
            })
        if url == p.service_url(self.project_number):
            return 200, {
                "name": f"projects/{self.project_number}/services/iam.googleapis.com",
                "state": self.service_state, "config": {"name": "private-config"},
            }
        if url == p.permission_url():
            return 200, {"permissions": copy.deepcopy(self.permissions)}
        if method == "POST" and url == p.create_url(p.ROLES[0]):
            role = next((item for item in p.ROLES if body == p.create_body(item)), None)
            if role is None: raise AssertionError((method, url, body))
            self.roles[role["kind"]] = self.definition(role)
            if self.signal_create == role["kind"]: os.kill(os.getpid(), signal.SIGTERM)
            if self.lost_create == role["kind"]: raise p.LostResponse()
            return 200, copy.deepcopy(self.roles[role["kind"]])
        for role in p.ROLES:
            if url == p.role_url(role):
                if method != "GET": raise AssertionError((method, url))
                if self.collision == role["kind"] and role["kind"] not in self.roles:
                    return 200, self.definition(role)
                if role["kind"] not in self.roles: return 404, {"error": {"code": 404}}
                return 200, copy.deepcopy(self.roles[role["kind"]])
        raise AssertionError((method, url))


class ProvisionerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="p08-role-provisioner-", dir="/private/tmp")
        self.root = Path(self.temp.name)
        os.chmod(self.root, 0o700)
        self.clock = Clock()
        self.source = "a" * 64
        self.proposal = "b" * 64
        self.operation = str(uuid.uuid4())
        self.plan = {
            "mode": p.MODE, "automaticRetryAllowed": False, "project": p.PROJECT, "owner": p.OWNER,
            "roles": p.role_plan(), "commandLimit": p.COMMAND_LIMIT,
            "sourceSha256": self.source, "proposalSha256": self.proposal,
            "deadlineEpoch": self.clock() + 120, "operationId": self.operation,
        }
        self.approval = {
            "owner": "Debynyhan Banks", "externalActionAuthorized": True,
            "decision": "APPROVE_EXACT_STABLE_ROLE_CREATION", "operationId": self.operation,
            "planSha256": p.digest(self.plan), "sourceSha256": self.source, "proposalSha256": self.proposal,
        }

    def tearDown(self):
        self.temp.cleanup()

    def controller(self, fake=None, directory=None):
        return p.Controller(self.plan, self.approval, fake or Fake(), directory or self.root, self.source, self.proposal, self.clock)

    def test_success_serializes_exact_commands_and_retains_unbound_roles(self):
        fake = Fake()
        result = self.controller(fake).run()
        self.assertEqual(result["status"], "P08_EXACT_ROLES_CREATED_RETAINED_UNBOUND")
        self.assertEqual(result["commandsCompleted"], 11)
        self.assertTrue(result["retainedUnbound"])
        expected = list(p.preflight_commands())
        expected += [p.describe_command(role) for role in p.ROLES]
        for role in p.ROLES: expected += [p.create_command(role), p.describe_command(role)]
        expected += list(p.policy_commands())
        self.assertEqual(fake.calls, expected)
        self.assertEqual(len(fake.calls), p.COMMAND_LIMIT)
        for command in fake.calls:
            self.assertFalse(any(token in {"delete", "update", "undelete", "add-iam-policy-binding", "remove-iam-policy-binding"} for token in command))
        self.assertNotIn("title", json.dumps(result))

    def test_collision_refuses_before_any_create(self):
        fake = Fake()
        fake.roles["lookup"] = fake.definition(p.ROLES[0])
        result = self.controller(fake).run()
        self.assertEqual(result["reason"], "COLLISION")
        self.assertFalse(any(command[1:4] == ("iam", "roles", "create") for command in fake.calls))

    def test_partial_create_is_truthful_and_independent_closeout_reconciles(self):
        fake = Fake(); fake.fail_create = "signing"
        result = self.controller(fake).run()
        self.assertEqual(result["status"], "P08_EXACT_ROLE_PROVISIONING_STOP_UNKNOWN_OWNERSHIP")
        self.assertEqual(result["createdCount"], 1)
        self.assertEqual(result["unknownCount"], 1)
        closeout = p.closeout_only(self.plan, self.approval, fake, self.root, self.source, self.proposal, self.clock)
        self.assertEqual(closeout["status"], "P08_EXACT_ROLE_CLOSEOUT_VERIFIED")
        self.assertEqual(closeout["reconciledRetainedCount"], 1)
        self.assertEqual(closeout["absentCount"], 1)

    def test_lost_response_reconciles_exact_owned_role_without_retry(self):
        fake = Fake(); fake.lost_create = "signing"
        result = self.controller(fake).run()
        self.assertEqual(result["reason"], "LOST_RESPONSE")
        before = sum(command == p.create_command(p.ROLES[1]) for command in fake.calls)
        closeout = p.closeout_only(self.plan, self.approval, fake, self.root, self.source, self.proposal, self.clock)
        after = sum(command == p.create_command(p.ROLES[1]) for command in fake.calls)
        self.assertEqual(before, after)
        self.assertEqual(closeout["reconciledRetainedCount"], 2)

    def test_definition_drift_and_binding_presence_refuse(self):
        fake = Fake(); fake.drift = "lookup"
        self.assertEqual(self.controller(fake).run()["reason"], "ROLE_DRIFT")
        with tempfile.TemporaryDirectory(dir=self.root) as directory:
            os.chmod(directory, 0o700)
            fake = Fake(); fake.bindings = [{"role": p.ROLES[0]["name"], "members": ["serviceAccount:private"]}]
            self.assertEqual(self.controller(fake, directory).run()["reason"], "BINDING_PRESENT")

    def test_malformed_definition_and_policy_are_sanitized(self):
        class Bad(Fake):
            def __call__(inner, command, deadline):
                value = super(Bad, inner).__call__(command, deadline)
                if command == p.describe_command(p.ROLES[0]) and p.ROLES[0]["kind"] in inner.roles:
                    value["privateUnknown"] = "private-provider-value"
                return value
        result = self.controller(Bad()).run()
        self.assertEqual(result["reason"], "ROLE_DRIFT")
        self.assertNotIn("private-provider-value", json.dumps(result))

    def test_signal_after_create_records_unknown_and_closeout_reads_only(self):
        fake = Fake(); fake.signal_create = "lookup"
        result = self.controller(fake).run()
        self.assertEqual(result["reason"], "INTERRUPTED")
        self.assertEqual(result["unknownCount"], 1)
        p.closeout_only(self.plan, self.approval, fake, self.root, self.source, self.proposal, self.clock)
        self.assertEqual(sum(command == p.create_command(p.ROLES[0]) for command in fake.calls), 1)

    def test_deadline_and_clock_rollback_stop(self):
        fake = Fake()
        class Tick(Fake):
            def __call__(inner, command, deadline):
                value = super(Tick, inner).__call__(command, deadline)
                self.clock.value -= 1
                return value
        self.assertEqual(self.controller(Tick()).run()["reason"], "CLOCK_ROLLBACK")
        with tempfile.TemporaryDirectory(dir=self.root) as directory:
            os.chmod(directory, 0o700)
            plan = copy.deepcopy(self.plan); plan["deadlineEpoch"] = self.clock() - 1
            approval = copy.deepcopy(self.approval); approval["planSha256"] = p.digest(plan)
            with self.assertRaises(p.Stop): p.Controller(plan, approval, fake, directory, self.source, self.proposal, self.clock)

    def test_authorization_contract_refuses_each_material_change(self):
        changes = [("mode", "LIVE"), ("automaticRetryAllowed", True), ("project", "foreign"), ("owner", "foreign"), ("commandLimit", 12), ("sourceSha256", "c" * 64), ("proposalSha256", "c" * 64)]
        for field, value in changes:
            with self.subTest(field=field), tempfile.TemporaryDirectory(dir=self.root) as directory:
                os.chmod(directory, 0o700)
                plan = copy.deepcopy(self.plan); plan[field] = value
                approval = copy.deepcopy(self.approval); approval["planSha256"] = p.digest(plan)
                with self.assertRaises(p.Stop): p.Controller(plan, approval, Fake(), directory, self.source, self.proposal, self.clock)

    def test_one_attempt_and_concurrent_reservation_have_one_winner(self):
        fake = Fake(); self.controller(fake).run()
        with self.assertRaises(FileExistsError): self.controller(fake).run()
        with tempfile.TemporaryDirectory(dir=self.root) as directory:
            path = Path(directory) / "race.json"
            script = "import sys;from pathlib import Path;import role_provisioner as p;p.reserve(Path(sys.argv[1]),{'x':1})"
            processes = [subprocess.Popen([sys.executable, "-c", script, str(path)], cwd=Path(__file__).parent, stderr=subprocess.DEVNULL) for _ in range(2)]
            for process in processes: process.wait(timeout=5)
            self.assertEqual(sum(process.returncode == 0 for process in processes), 1)

    def test_unbound_entrypoints_refuse_before_provider_access(self):
        for option in ("--provision", "--closeout"):
            result = subprocess.run([sys.executable, "-B", str(Path(__file__).parent / "role_provisioner.py"), option], capture_output=True, timeout=5)
            self.assertEqual(result.returncode, 2)
            self.assertEqual(result.stdout.decode().strip(), "P08_EXACT_ROLE_PROVISIONER_REFUSED_UNBOUND")

    def native_plan(self):
        source = p.hashlib.sha256(Path(p.__file__).read_bytes()).hexdigest()
        proposal = "c" * 64
        plan = {
            "mode": p.MODE, "action": "PROVISION", "automaticRetryAllowed": False, "project": p.PROJECT, "owner": p.OWNER,
            "roles": p.role_plan(), "cliLimit": p.CLI_LIMIT, "httpsLimit": p.HTTPS_LIMIT,
            "sourceSha256": source, "proposalSha256": proposal, "operationId": str(uuid.uuid4()),
            "windowStartEpoch": self.clock() - 10, "startCutoffEpoch": self.clock() + 60,
            "deadlineEpoch": self.clock() + 120, "windowEndEpoch": self.clock() + 180,
        }
        approval = {
            "owner": "Debynyhan Banks", "externalActionAuthorized": True,
            "decision": "APPROVE_EXACT_STABLE_ROLE_CREATION", "operationId": plan["operationId"],
            "planSha256": p.digest(plan), "sourceSha256": source, "proposalSha256": proposal,
        }
        return plan, approval, source, proposal

    def native_controller(self, fake=None, directory=None):
        plan, approval, source, proposal = self.native_plan()
        return p.NativeProvisioner(plan, approval, fake or NativeFake(), directory or self.root, source, proposal, self.clock)

    def test_native_success_uses_exact_five_cli_nine_https_contract(self):
        fake = NativeFake()
        result = self.native_controller(fake).run()
        self.assertEqual(result["status"], "P08_EXACT_ROLES_CREATED_RETAINED_UNBOUND")
        self.assertEqual((result["cliCompleted"], result["httpsCompleted"], result["callsCompleted"]), (5, 9, 14))
        self.assertEqual([item[1] for item in fake.calls[:5]], list(p.native_cli_commands()))
        https = fake.calls[5:]
        self.assertEqual([(item[1], item[2]) for item in https], [
            ("GET", p.project_url()),
            ("GET", p.service_url(fake.project_number)),
            ("POST", p.permission_url()),
            ("GET", p.role_url(p.ROLES[0])), ("GET", p.role_url(p.ROLES[1])),
            ("POST", p.create_url(p.ROLES[0])), ("POST", p.create_url(p.ROLES[1])),
            ("GET", p.role_url(p.ROLES[0])), ("GET", p.role_url(p.ROLES[1])),
        ])
        self.assertEqual(https[2][4], {"permissions": list(p.PERMISSIONS)})
        self.assertEqual(https[5][4], p.create_body(p.ROLES[0]))
        self.assertEqual(https[6][4], p.create_body(p.ROLES[1]))
        for item in https:
            self.assertEqual(item[3]["Authorization"], "Bearer " + fake.private_token)
            self.assertEqual(item[3]["Accept"], "application/json")
            self.assertEqual("Content-Type" in item[3], item[1] == "POST")
        self.assertNotIn(fake.private_token, json.dumps(result))
        self.assertNotIn(fake.project_number, json.dumps(result))

    def test_native_permission_denial_and_collision_stop_before_create(self):
        fake = NativeFake(); fake.permissions = list(p.PERMISSIONS[:-1])
        result = self.native_controller(fake).run()
        self.assertEqual(result["reason"], "PERMISSION_DENIED")
        self.assertEqual(result["httpsCompleted"], 3)
        with tempfile.TemporaryDirectory(dir=self.root) as directory:
            os.chmod(directory, 0o700)
            fake = NativeFake(); fake.collision = "lookup"
            result = self.native_controller(fake, directory).run()
            self.assertEqual(result["reason"], "COLLISION")
            self.assertFalse(any(item[0] == "HTTPS" and item[1] == "POST" and item[2].startswith(p.IAM_BASE) for item in fake.calls))

    def test_native_lost_response_records_unknown_without_retry(self):
        fake = NativeFake(); fake.lost_create = "signing"
        result = self.native_controller(fake).run()
        self.assertEqual(result["reason"], "LOST_RESPONSE")
        self.assertEqual(result["createdCount"], 1)
        self.assertEqual(result["unknownCount"], 1)
        self.assertEqual(result["failedStage"], "HTTPS_7_SIGNING_CREATE")
        self.assertEqual(result["errorCategory"], "TRANSPORT")
        self.assertEqual(sum(item[0] == "HTTPS" and item[1] == "POST" and item[4] == p.create_body(p.ROLES[1]) for item in fake.calls), 1)

    def test_native_signal_after_create_records_unknown_and_no_retry(self):
        fake = NativeFake(); fake.signal_create = "lookup"
        result = self.native_controller(fake).run()
        self.assertEqual(result["reason"], "INTERRUPTED")
        self.assertEqual(result["unknownCount"], 1)
        self.assertEqual(sum(item[0] == "HTTPS" and item[1] == "POST" for item in fake.calls), 2)

    def test_native_malformed_outputs_and_window_changes_refuse(self):
        class Bad(NativeFake):
            def cli(inner, command, deadline):
                value = super(Bad, inner).cli(command, deadline)
                if tuple(command) == p.native_cli_commands()[3]: return "private-malformed"
                return value
        result = self.native_controller(Bad()).run()
        self.assertEqual(result["reason"], "CLI_SHAPE")
        self.assertEqual(result["failedStage"], "CLI_4_PROJECT_POLICY")
        self.assertEqual(result["errorCategory"], "UNKNOWN")
        self.assertNotIn("private-malformed", json.dumps(result))
        plan, approval, source, proposal = self.native_plan()
        plan["startCutoffEpoch"] = self.clock() - 1
        approval["planSha256"] = p.digest(plan)
        with self.assertRaises(p.Stop):
            p.NativeProvisioner(plan, approval, NativeFake(), self.root, source, proposal, self.clock)

    def test_native_cli_failure_persists_fixed_stage_and_safe_category(self):
        fake = NativeFake(); fake.cli_failure = (3, "BILLING_OR_SERVICE_DISABLED")
        result = self.native_controller(fake).run()
        self.assertEqual(result["reason"], "COMMAND_FAILED")
        self.assertEqual(result["failedStage"], "CLI_4_PROJECT_POLICY")
        self.assertEqual(result["errorCategory"], "BILLING_OR_SERVICE_DISABLED")
        self.assertEqual((result["cliCompleted"], result["httpsCompleted"]), (4, 0))
        self.assertNotIn(fake.private_token, json.dumps(result))

    def test_https_project_service_and_transport_stops_are_sanitized(self):
        fake = NativeFake()
        fake.project_result = {"projectId": p.PROJECT, "lifecycleState": "ACTIVE", "projectNumber": "private-invalid"}
        result = self.native_controller(fake).run()
        self.assertEqual((result["reason"], result["failedStage"], result["errorCategory"]),
                         ("HTTP_SHAPE", "HTTPS_1_PROJECT_METADATA", "HTTP_SHAPE"))
        self.assertNotIn("private-invalid", json.dumps(result))
        with tempfile.TemporaryDirectory(dir=self.root) as directory:
            os.chmod(directory, 0o700)
            fake = NativeFake(); fake.service_state = "DISABLED"
            result = self.native_controller(fake, directory).run()
            self.assertEqual((result["reason"], result["failedStage"], result["errorCategory"]),
                             ("IAM_API_DISABLED", "HTTPS_2_IAM_SERVICE_STATE", "BILLING_OR_SERVICE_DISABLED"))
        with tempfile.TemporaryDirectory(dir=self.root) as directory:
            os.chmod(directory, 0o700)
            fake = NativeFake(); fake.http_failure = (p.project_url(), "TRANSPORT")
            result = self.native_controller(fake, directory).run()
            self.assertEqual((result["reason"], result["failedStage"], result["errorCategory"]),
                             ("COMMAND_FAILED", "HTTPS_1_PROJECT_METADATA", "TRANSPORT"))

    def test_native_io_serialization_and_all_safe_error_categories(self):
        command = p.native_cli_commands()[3]
        cases = {
            "AUTH": "ERROR: invalid_grant requires reauthentication private-detail",
            "PERMISSION_DENIED": "PERMISSION_DENIED private-resource",
            "BILLING_OR_SERVICE_DISABLED": "BILLING DISABLED for private-account",
            "NOT_FOUND": "resource not found private-name",
            "INVALID_ARGUMENT": "INVALID_ARGUMENT private-value",
            "TRANSPORT": "network connection unavailable private-host",
            "UNKNOWN": "unclassified private-provider-message",
        }
        for expected, stderr in cases.items():
            with self.subTest(expected=expected), mock.patch.object(p.subprocess, "run") as run:
                run.return_value = subprocess.CompletedProcess(command, 1, stdout=b"", stderr=stderr.encode())
                with self.assertRaises(p.CliFailure) as raised:
                    p.NativeIO().cli(command, time.time() + 10)
                self.assertEqual(raised.exception.category, expected)
                self.assertNotIn("private", str(raised.exception))
                run.assert_called_once_with(command, capture_output=True, timeout=mock.ANY, check=False)
        with mock.patch.object(p.subprocess, "run", side_effect=subprocess.TimeoutExpired(command, 1)):
            with self.assertRaises(p.CliFailure) as raised:
                p.NativeIO().cli(command, time.time() + 10)
            self.assertEqual(raised.exception.category, "TIMEOUT")
        with mock.patch.object(p.subprocess, "run") as run:
            run.return_value = subprocess.CompletedProcess(command, 0, stdout=b'{"state":"ENABLED"}\n', stderr=b"private-warning")
            self.assertEqual(p.NativeIO().cli(command, time.time() + 10), '{"state":"ENABLED"}')

    def test_bound_private_inputs_are_mode_checked_and_always_purged(self):
        plan, approval, source, proposal = self.native_plan()
        plan_path = self.root / "launch-plan.json"
        approval_path = self.root / "owner-approval.json"
        for path, value in ((plan_path, plan), (approval_path, approval)):
            path.write_text(json.dumps(value))
            os.chmod(path, 0o600)
        result = p.run_bound(self.root, source, proposal, NativeFake(), self.clock)
        self.assertEqual(result["callsCompleted"], p.EXTERNAL_CALL_LIMIT)
        self.assertFalse(plan_path.exists())
        self.assertFalse(approval_path.exists())
        self.assertTrue(result["privateInputsAbsent"])
        self.assertNotIn("private-token", (self.root / "native-result.json").read_text())

    def test_native_independent_closeout_is_read_only_and_bound(self):
        plan, approval, source, proposal = self.native_plan()
        plan["action"] = "CLOSEOUT"
        approval["decision"] = "APPROVE_EXACT_STABLE_ROLE_CLOSEOUT"
        approval["planSha256"] = p.digest(plan)
        fake = NativeFake()
        for role in p.ROLES: fake.roles[role["kind"]] = fake.definition(role)
        result = p.NativeCloseout(plan, approval, fake, self.root, source, proposal, self.clock).run()
        self.assertEqual(result["status"], "P08_EXACT_ROLE_CLOSEOUT_VERIFIED")
        self.assertEqual((result["cliCompleted"], result["httpsCompleted"]), (5, 2))
        self.assertFalse(any(item[0] == "HTTPS" and item[1] != "GET" for item in fake.calls))

    def test_bound_source_or_mode_drift_refuses_and_purges(self):
        plan, approval, source, proposal = self.native_plan()
        for path, value in ((self.root / "launch-plan.json", plan), (self.root / "owner-approval.json", approval)):
            path.write_text(json.dumps(value)); os.chmod(path, 0o600)
        with self.assertRaises(p.Stop): p.run_bound(self.root, "d" * 64, proposal, NativeFake(), self.clock)
        self.assertFalse((self.root / "launch-plan.json").exists())
        self.assertFalse((self.root / "owner-approval.json").exists())
        plan, approval, source, proposal = self.native_plan()
        for path, value in ((self.root / "launch-plan.json", plan), (self.root / "owner-approval.json", approval)):
            path.write_text(json.dumps(value)); os.chmod(path, 0o600)
        os.chmod(self.root / "launch-plan.json", 0o644)
        with self.assertRaises(p.Stop): p.run_bound(self.root, source, proposal, NativeFake(), self.clock)

    def test_native_attempt_reservation_prevents_concurrent_second_winner(self):
        plan, approval, source, proposal = self.native_plan()
        first = p.NativeProvisioner(plan, approval, NativeFake(), self.root, source, proposal, self.clock)
        self.assertEqual(first.run()["callsCompleted"], p.EXTERNAL_CALL_LIMIT)
        second = p.NativeProvisioner(plan, approval, NativeFake(), self.root, source, proposal, self.clock)
        with self.assertRaises(FileExistsError): second.run()


if __name__ == "__main__":
    unittest.main()
