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


if __name__ == "__main__":
    unittest.main()
