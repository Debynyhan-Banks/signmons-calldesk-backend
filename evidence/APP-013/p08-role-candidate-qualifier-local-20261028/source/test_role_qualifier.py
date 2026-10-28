import copy
import datetime as dt
import importlib.util
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

import role_qualifier as q

ROOT = Path(__file__).resolve().parent
RESTORE_PATH = ROOT.parents[1] / "p08-restoration-local-20261028" / "source" / "restore.py"
SPEC = importlib.util.spec_from_file_location("p08_restore_contract", RESTORE_PATH)
restore = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(restore)


class Clock:
    def __init__(self):
        self.value = time.time()

    def __call__(self):
        return self.value


class Adapter:
    def __init__(self, rows):
        self.rows = rows
        self.calls = 0
        self.cancelled = False

    def list_roles(self, deadline):
        self.calls += 1
        return copy.deepcopy(self.rows)

    def cancel(self):
        self.cancelled = True


class Runner:
    def __init__(self, rows, owner=q.OWNER, project=q.PROJECT):
        self.rows = rows
        self.owner = owner
        self.project = project
        self.calls = []
        self.cancelled = False

    def __call__(self, args, deadline):
        self.calls.append(args)
        if args[0] == "auth":
            return self.owner
        if args[0] == "config":
            return self.project
        if args[:3] == ["iam", "roles", "list"]:
            return copy.deepcopy(self.rows)
        raise AssertionError("unexpected command")

    def cancel(self):
        self.cancelled = True


def role(name, permissions, **extra):
    return {
        "name": f"projects/signmons/roles/{name}",
        "includedPermissions": permissions,
        "deleted": False,
        "stage": "GA",
        **extra,
    }


class QualifierTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="p08-role-qualifier-", dir="/private/tmp")
        self.root = Path(self.temp.name)
        os.chmod(self.root, 0o700)
        self.clock = Clock()
        self.source = "a" * 64
        self.decision = "b" * 64
        self.plan = {
            "mode": q.MODE,
            "automaticRetryAllowed": False,
            "project": q.PROJECT,
            "sourceSha256": self.source,
            "decisionSha256": self.decision,
            "deadlineEpoch": self.clock() + 120,
            "saveCandidateLimit": 2,
            "rawOutputRetention": "PROCESS_MEMORY_ONLY",
            "expectedOwner": q.OWNER,
            "commandLimit": 3,
        }
        self.rows = [
            role("p08_lookup", [q.PERMISSIONS["lookup"]], title="ignored private title"),
            role("p08_signing", [q.PERMISSIONS["signing"]]),
            role("unrelated", ["resourcemanager.projects.get"], description="must not persist"),
        ]

    def tearDown(self):
        self.temp.cleanup()
        self.assertFalse(self.root.exists())

    def controller(self, rows=None, adapter=None):
        adapter = adapter or Adapter(self.rows if rows is None else rows)
        return q.Controller(self.plan, adapter, self.root, self.source, self.decision, self.clock), adapter

    def test_unique_candidates_are_sanitized_and_hashed(self):
        controller, adapter = self.controller()
        result = controller.run()
        self.assertEqual(result["status"], "P08_ROLE_CANDIDATES_UNIQUE")
        self.assertEqual(result["candidateCount"], 2)
        self.assertEqual(adapter.calls, 1)
        saved = (self.root / "result.json").read_text()
        self.assertNotIn("ignored private title", saved)
        self.assertNotIn("must not persist", saved)
        self.assertNotIn("unrelated", saved)
        self.assertFalse(result["rawOutputRetained"])
        self.assertFalse(result["providerMutationPossible"])

    def test_zero_broader_and_multiple_are_decision_required(self):
        cases = [
            ([], {"lookup": "NO_EXACT", "signing": "NO_EXACT"}),
            ([role("broad", [q.PERMISSIONS["lookup"], "firebaseauth.users.update"])], {"lookup": "BROADER_ONLY", "signing": "NO_EXACT"}),
            ([role("one", [q.PERMISSIONS["lookup"]]), role("two", [q.PERMISSIONS["lookup"]])], {"lookup": "MULTIPLE_EXACT", "signing": "NO_EXACT"}),
        ]
        for rows, expected in cases:
            with self.subTest(expected=expected), tempfile.TemporaryDirectory(dir=self.root) as directory:
                os.chmod(directory, 0o700)
                result = q.Controller(self.plan, Adapter(rows), directory, self.source, self.decision, self.clock).run()
                self.assertEqual(result["status"], "P08_ROLE_CANDIDATES_DECISION_REQUIRED")
                self.assertEqual(result["classifications"], expected)

    def test_malformed_foreign_inactive_duplicate_and_over_cap_stop_truthfully(self):
        cases = [
            "not-a-list",
            [{"name": "projects/foreign/roles/x", "includedPermissions": ["x"], "stage": "GA"}],
            [role("inactive", ["x"], stage="DISABLED")],
            [role("duplicate_permission", ["x", "x"])],
            [role("duplicate", ["x"]), role("duplicate", ["y"])],
            [role(f"r{i}", [f"permission.{i}"]) for i in range(q.MAX_ROLES + 1)],
            [{"name": "projects/signmons/roles/missing", "stage": "GA"}],
        ]
        for rows in cases:
            with self.subTest(kind=type(rows).__name__), tempfile.TemporaryDirectory(dir=self.root) as directory:
                os.chmod(directory, 0o700)
                result = q.Controller(self.plan, Adapter(rows), directory, self.source, self.decision, self.clock).run()
                self.assertEqual(result["status"], "P08_ROLE_QUALIFIER_STOP_OUTPUT_UNKNOWN")
                self.assertFalse((Path(directory) / "result.json").exists())

    def test_source_decision_retry_deadline_and_privacy_contract_refuse_before_adapter(self):
        changes = [
            ("mode", "LIVE"),
            ("automaticRetryAllowed", True),
            ("project", "foreign"),
            ("sourceSha256", "f" * 64),
            ("decisionSha256", "f" * 64),
            ("deadlineEpoch", self.clock() - 1),
            ("saveCandidateLimit", 3),
            ("rawOutputRetention", "FILE"),
            ("expectedOwner", "foreign@example.com"),
            ("commandLimit", 4),
        ]
        for field, value in changes:
            with self.subTest(field=field):
                plan = copy.deepcopy(self.plan)
                plan[field] = value
                adapter = Adapter(self.rows)
                with self.assertRaises(q.Stop):
                    q.Controller(plan, adapter, self.root, self.source, self.decision, self.clock)
                self.assertEqual(adapter.calls, 0)

    def test_one_attempt_reservation_blocks_retry(self):
        controller, adapter = self.controller()
        self.assertEqual(controller.run()["status"], "P08_ROLE_CANDIDATES_UNIQUE")
        with self.assertRaises(FileExistsError):
            q.Controller(self.plan, adapter, self.root, self.source, self.decision, self.clock).run()
        self.assertEqual(adapter.calls, 1)

    def test_clock_rollback_and_deadline_report_unknown_without_result(self):
        class Tick(Adapter):
            def list_roles(inner, deadline):
                rows = super().list_roles(deadline)
                self.clock.value = self.clock.value - 1
                return rows

        result = self.controller(adapter=Tick(self.rows))[0].run()
        self.assertEqual(result["reason"], "CLOCK_ROLLBACK")
        self.assertFalse((self.root / "result.json").exists())

    def test_untrusted_adapter_error_text_is_not_retained(self):
        class Bad(Adapter):
            def list_roles(inner, deadline):
                raise ValueError("private-provider-body")

        result = self.controller(adapter=Bad(self.rows))[0].run()
        self.assertEqual(result["reason"], "ValueError")
        self.assertNotIn("private-provider-body", json.dumps(result))

    def test_signal_cancels_real_child_and_never_saves_success(self):
        class Child(Adapter):
            def __init__(inner):
                super().__init__(self.rows)
                inner.child = None

            def list_roles(inner, deadline):
                inner.calls += 1
                inner.child = subprocess.Popen([sys.executable, "-c", "import time;time.sleep(60)"])
                os.kill(os.getpid(), signal.SIGTERM)
                inner.child.wait(timeout=5)
                return copy.deepcopy(inner.rows)

            def cancel(inner):
                inner.cancelled = True
                if inner.child and inner.child.poll() is None:
                    inner.child.terminate()

        adapter = Child()
        result = self.controller(adapter=adapter)[0].run()
        self.assertEqual(result["reason"], "INTERRUPTED")
        self.assertIsNotNone(adapter.child.returncode)
        self.assertFalse((self.root / "result.json").exists())

    def test_concurrent_reservation_has_one_winner(self):
        path = self.root / "concurrent.json"
        script = "import sys;from pathlib import Path;import role_qualifier as q;q.reserve(Path(sys.argv[1]),{'fixture':True})"
        processes = [subprocess.Popen([sys.executable, "-c", script, str(path)], cwd=ROOT, stderr=subprocess.DEVNULL) for _ in range(2)]
        for process in processes:
            process.wait(timeout=5)
        self.assertEqual(sum(process.returncode == 0 for process in processes), 1)

    def test_accepted_candidates_pass_existing_restoration_role_contract(self):
        result = q.classify(self.rows)
        now = time.time()
        utc = lambda offset: dt.datetime.fromtimestamp(now + offset, dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        operation = "6bfbeb9d-2411-4e83-9f08-a5e58fa8803d"
        window = {key: utc(offset) for key, offset in [("start", -5), ("cutoff", 100), ("workEnd", 300), ("cleanupEnd", 1000), ("purgeEnd", 1100)]}
        plan = {
            "mode": "RESTORE_AUTHENTICATE_RETIRE", "automaticRetryAllowed": False,
            "operationId": operation, "jobId": restore.JOB, "tenantId": restore.TENANT,
            "ownerPrincipal": restore.OWNER, "sourceManifestSha256": "a" * 64,
            "proposalSha256": "b" * 64, "window": window, "authenticationPlanSha256": "c" * 64,
            "authenticationSourceSha256": "305f27922daecf24721a25fc3e78c27554cc481e3ce902664d4f574044bcf5c8",
            "iam": [],
        }
        for kind, candidate in result["candidates"].items():
            plan["iam"].append({
                "kind": kind, "roleId": candidate["roleId"], "permissions": [candidate["permission"]],
                "preexisting": True,
                "condition": f"expression=request.time >= timestamp('{window['start']}') && request.time < timestamp('{window['workEnd']}'),title=p08_{operation}_{kind}",
            })
        qualification = {
            "status": "EXACT_RESTORATION_QUALIFIED", "operationId": operation,
            "qualifiedUntil": window["purgeEnd"], "sourceMatched": True, "trafficMatched": True,
            "testAccountOwnedDisabled": True, "keyRestrictionsCompatible": True,
            "ownerAccessQualified": True, "grantFixtureSha256": "35785d3857f6fc9b01042d6dee3137eebb18950601fb1b8e7644e340be8fb83c",
            "roleAclSha256": restore.digest([]), "authPlanAndApprovalBound": True,
            "authenticationPlanSha256": "c" * 64,
        }
        plan["qualificationSha256"] = restore.digest(qualification)
        approval = {
            "owner": "Debynyhan Banks", "externalActionAuthorized": True,
            "decision": "APPROVE_EXACT_RESTORE_AUTHENTICATE_RETIRE",
            "planSha256": restore.digest(plan), "sourceManifestSha256": "a" * 64,
            "proposalSha256": "b" * 64, "operationId": operation,
        }
        self.assertTrue(restore.authorize(plan, approval, qualification, "a" * 64, "b" * 64, now))

    def test_native_entrypoint_refuses_before_any_adapter(self):
        result = subprocess.run([sys.executable, "-B", str(ROOT / "role_qualifier.py"), "--qualify"], capture_output=True, timeout=5)
        self.assertEqual(result.returncode, 2)
        self.assertEqual(result.stdout.decode().strip(), "P08_ROLE_QUALIFIER_REFUSED_UNBOUND")

    def test_native_adapter_uses_exact_three_read_only_commands(self):
        runner = Runner(self.rows)
        result = q.Controller(self.plan, q.NativeAdapter(runner), self.root, self.source, self.decision, self.clock).run()
        self.assertEqual(result["status"], "P08_ROLE_CANDIDATES_UNIQUE")
        self.assertEqual(runner.calls, [
            ["auth", "list", "--filter=status:ACTIVE", "--format=value(account)"],
            ["config", "get-value", "project"],
            ["iam", "roles", "list", "--project=signmons", "--format=json(name,includedPermissions,deleted,stage)"],
        ])
        tokens = [token for command in runner.calls for token in command]
        self.assertFalse(any(token in {"create", "delete", "update", "add-iam-policy-binding", "remove-iam-policy-binding", "set-policy"} for token in tokens))

    def test_native_owner_and_project_drift_stop_before_role_list(self):
        for runner in [Runner(self.rows, owner="foreign@example.com"), Runner(self.rows, project="foreign")]:
            with self.subTest(owner=runner.owner, project=runner.project), tempfile.TemporaryDirectory(dir=self.root) as directory:
                os.chmod(directory, 0o700)
                result = q.Controller(self.plan, q.NativeAdapter(runner), directory, self.source, self.decision, self.clock).run()
                self.assertEqual(result["status"], "P08_ROLE_QUALIFIER_STOP_OUTPUT_UNKNOWN")
                self.assertLess(len(runner.calls), 3)

    def test_bound_path_requires_private_exact_approval_then_runs_fake_native(self):
        source = q.digest((ROOT / "role_qualifier.py").read_bytes())
        decision = "d" * 64
        plan = copy.deepcopy(self.plan)
        plan.update({"sourceSha256": source, "decisionSha256": decision, "operationId": str(uuid.uuid4())})
        approval = {
            "owner": "Debynyhan Banks", "externalActionAuthorized": True,
            "decision": "APPROVE_EXACT_ROLE_INVENTORY_READ", "operationId": plan["operationId"],
            "planSha256": q.digest(plan), "sourceSha256": source, "decisionSha256": decision,
        }
        plan_path = self.root / "plan.json"
        approval_path = self.root / "approval.json"
        for path, value in [(plan_path, plan), (approval_path, approval)]:
            path.write_text(json.dumps(value))
            os.chmod(path, 0o600)
        runner = Runner(self.rows)
        result = q.run_bound(plan_path, approval_path, self.root, runner, self.clock)
        self.assertEqual(result["status"], "P08_ROLE_CANDIDATES_UNIQUE")
        self.assertTrue(result["privateInputsAbsent"])
        self.assertFalse(plan_path.exists())
        self.assertFalse(approval_path.exists())
        self.assertEqual(len(runner.calls), 3)
        bad = copy.deepcopy(approval)
        bad["externalActionAuthorized"] = False
        with tempfile.TemporaryDirectory(dir=self.root) as directory:
            os.chmod(directory, 0o700)
            bad_plan_path = Path(directory) / "plan.json"
            bad_approval_path = Path(directory) / "approval.json"
            for path, value in [(bad_plan_path, plan), (bad_approval_path, bad)]:
                path.write_text(json.dumps(value))
                os.chmod(path, 0o600)
            with self.assertRaises(q.Stop):
                q.run_bound(bad_plan_path, bad_approval_path, directory, Runner(self.rows), self.clock)
            self.assertFalse(bad_plan_path.exists())
            self.assertFalse(bad_approval_path.exists())


if __name__ == "__main__":
    unittest.main()
