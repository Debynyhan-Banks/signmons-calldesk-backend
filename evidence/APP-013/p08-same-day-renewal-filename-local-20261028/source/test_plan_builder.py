import copy
import datetime as dt
import json
import multiprocessing as mp
import os
import signal
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

import diagnostics_stage as stage
import launch_binding as launch
import plan_builder as m


NOW = 1793208000
PROJECT_NUMBER = "123456789012"
DOCUMENT = "APP013_P08_STAGE_A_OPERATION_20261028.md"


def window():
    iso = lambda offset: dt.datetime.fromtimestamp(NOW + offset, dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    return {"start": iso(-10), "cutoff": iso(30), "workEnd": iso(180),
            "cleanupEnd": iso(240), "purgeEnd": iso(300)}


def binding(manifest_sha):
    return {
        "automaticRetryAllowed": False,
        "backendCommit": "d" * 40,
        "decisionId": "40000000-0000-4000-8000-000000000004",
        "mode": launch.PLAN_MODE,
        "operationId": "40000000-0000-4000-8000-000000000003",
        "ownerPrincipal": stage.OWNER,
        "projectId": stage.PROJECT,
        "proposalCommit": launch.PROPOSAL_COMMIT,
        "service": stage.SERVICE,
        "serviceRetention": "RETAIN_IF_ENABLED",
        "sourceManifestSha256": manifest_sha,
        "stageBAllowed": False,
        "tuples": [list(value) for value in stage.TUPLES],
        "window": window(),
    }


def document(value, status="APPROVED", owner="APPROVED", raw_binding=None):
    payload = json.dumps(value, sort_keys=True, separators=(",", ":")) if raw_binding is None else raw_binding
    return (f"# Exact operation\n\nStatus: {status}; owner decision: {owner}.\n"
            f"Operation `{value.get('operationId', 'missing')}`. Decision `{value.get('decisionId', 'missing')}`. "
            f"Source `{value.get('sourceManifestSha256', 'missing')}`. RETAIN_IF_ENABLED.\n\n"
            f"<!-- P08_OPERATION_BINDING\n{payload}\n-->\n").encode()


def race_worker(repo, commit, doc_sha, manifest_sha, output, ready, go, results):
    ready.put(True)
    go.wait()
    try:
        result = m.build(repo, commit, DOCUMENT, doc_sha, manifest_sha, PROJECT_NUMBER,
                         launch.canonical_project_fingerprint(PROJECT_NUMBER), output, NOW)
        results.put(result["status"])
    except BaseException:
        results.put("REFUSED")


class BuilderTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.manifest_sha = launch.sha256((m.ROOT / "source-manifest.json").read_bytes())
        self.binding = binding(self.manifest_sha)
        self.repo = self.root / "governance"
        self.repo.mkdir()
        subprocess.run(["/usr/bin/git", "init", "-q"], cwd=self.repo, check=True)
        subprocess.run(["/usr/bin/git", "config", "user.email", "fixture@example.invalid"], cwd=self.repo, check=True)
        subprocess.run(["/usr/bin/git", "config", "user.name", "Fixture"], cwd=self.repo, check=True)

    def tearDown(self):
        self.temporary.cleanup()

    def commit_document(self, raw=None, name=DOCUMENT):
        raw = raw if raw is not None else document(self.binding)
        path = self.repo / name
        path.write_bytes(raw)
        subprocess.run(["/usr/bin/git", "add", name], cwd=self.repo, check=True)
        subprocess.run(["/usr/bin/git", "commit", "-q", "--allow-empty", "-m", "fixture"], cwd=self.repo, check=True)
        commit = subprocess.run(["/usr/bin/git", "rev-parse", "HEAD"], cwd=self.repo,
                                check=True, capture_output=True, text=True).stdout.strip()
        return commit, launch.sha256(raw), raw

    def build(self, raw=None, output="private", now=NOW, project_number=PROJECT_NUMBER,
              project_fingerprint=None, reserve=stage.reserve, name=DOCUMENT):
        commit, digest, raw = self.commit_document(raw, name=name)
        fingerprint = project_fingerprint or launch.canonical_project_fingerprint(project_number)
        path = self.root / output
        result = m.build(self.repo, commit, name, digest, self.manifest_sha, project_number,
                         fingerprint, path, now, reserve=reserve)
        return result, path, commit, digest, raw

    def test_disposable_git_document_to_launcher_validation_and_exact_ids(self):
        result, output, commit, digest, raw = self.build()
        self.assertEqual(result["status"], "P08_PRIVATE_PLAN_READY_LOCAL")
        self.assertEqual(output.stat().st_mode & 0o777, 0o700)
        self.assertEqual((output / "plan.json").stat().st_mode & 0o777, 0o600)
        plan = launch.private_json(output / "plan.json")
        self.assertEqual(plan["operationId"], self.binding["operationId"])
        self.assertEqual(plan["decisionId"], self.binding["decisionId"])
        self.assertEqual(plan["approval"]["governanceCommit"], commit)
        self.assertEqual(plan["approval"]["documentSha256"], digest)
        launch.validate_plan(plan, self.manifest_sha, NOW)
        launch.verify_approval_document(plan, launch.git_reader(self.repo))
        self.assertNotIn(PROJECT_NUMBER, raw.decode())
        m.purge(output)
        self.assertFalse(output.exists())

    def test_same_day_renewal_document_uses_actual_git_to_launcher_path(self):
        name = "APP013_P08_STAGE_A_OPERATION_20261028_R01.md"
        result, output, commit, digest, raw = self.build(name=name, output="renewal")
        self.assertEqual(result["status"], "P08_PRIVATE_PLAN_READY_LOCAL")
        plan = launch.private_json(output / "plan.json")
        self.assertEqual(plan["approval"]["operationDocument"], name)
        self.assertEqual(plan["approval"]["governanceCommit"], commit)
        self.assertEqual(plan["approval"]["documentSha256"], digest)
        launch.validate_plan(plan, self.manifest_sha, NOW)
        launch.verify_approval_document(plan, launch.git_reader(self.repo))
        self.assertNotIn(PROJECT_NUMBER, raw.decode())
        m.purge(output)
        self.assertFalse(output.exists())

    def test_malformed_renewals_and_document_date_mismatch_refuse_before_output(self):
        malformed = (
            "APP013_P08_STAGE_A_OPERATION_20261028_R00.md",
            "APP013_P08_STAGE_A_OPERATION_20261028_R1.md",
            "APP013_P08_STAGE_A_OPERATION_20261028_R001.md",
            "APP013_P08_STAGE_A_OPERATION_20261028_R100.md",
            "APP013_P08_STAGE_A_OPERATION_20261028_R01_extra.md",
        )
        for index, name in enumerate(malformed):
            with self.subTest(name=name):
                with self.assertRaisesRegex(stage.Stop, "OPERATION_DOCUMENT"):
                    self.build(name=name, output=f"bad-renewal-{index}")
                self.assertFalse((self.root / f"bad-renewal-{index}").exists())
        with self.assertRaisesRegex(stage.Stop, "OPERATION_DOCUMENT_DATE"):
            self.build(name="APP013_P08_STAGE_A_OPERATION_20261029_R01.md", output="wrong-date")
        self.assertFalse((self.root / "wrong-date").exists())

    def test_pending_rejected_or_duplicate_status_refuses_before_private_directory(self):
        cases = (
            document(self.binding, status="PROPOSED", owner="PENDING"),
            document(self.binding, status="REJECTED", owner="REJECTED"),
            document(self.binding) + b"\nStatus: APPROVED; owner decision: APPROVED.\n",
        )
        for index, raw in enumerate(cases):
            with self.subTest(index=index):
                with self.assertRaises(stage.Stop):
                    self.build(raw, output=f"status-{index}")
                self.assertFalse((self.root / f"status-{index}").exists())

    def test_missing_duplicate_malformed_or_extra_binding_refuses(self):
        duplicate = '{"operationId":"a","operationId":"b"}'
        cases = (
            b"Status: APPROVED; owner decision: APPROVED.\n",
            document(self.binding) + document(self.binding),
            document(self.binding, raw_binding="{bad json"),
            document(self.binding, raw_binding=duplicate),
            document({**self.binding, "extra": True}),
        )
        for index, raw in enumerate(cases):
            with self.subTest(index=index):
                with self.assertRaises(stage.Stop):
                    self.build(raw, output=f"binding-{index}")
                self.assertFalse((self.root / f"binding-{index}").exists())

    def test_operation_decision_source_window_retention_and_scope_drift_refuse(self):
        cases = {
            "operation": ("operationId", "not-a-uuid"),
            "decision": ("decisionId", "not-a-uuid"),
            "manifest": ("sourceManifestSha256", "f" * 64),
            "retention": ("serviceRetention", "DISABLE"),
            "retry": ("automaticRetryAllowed", True),
            "stage_b": ("stageBAllowed", True),
            "service": ("service", "apikeys.googleapis.com"),
            "owner": ("ownerPrincipal", "other@example.com"),
        }
        for name, (field, changed) in cases.items():
            with self.subTest(name=name):
                value = copy.deepcopy(self.binding)
                value[field] = changed
                with self.assertRaises(stage.Stop):
                    self.build(document(value), output=name)
                self.assertFalse((self.root / name).exists())
        value = copy.deepcopy(self.binding)
        value["window"]["cutoff"] = value["window"]["start"]
        with self.assertRaises(stage.Stop):
            self.build(document(value), output="window")

    def test_document_hash_foreign_path_and_stale_commit_refuse(self):
        commit, digest, _raw = self.commit_document()
        arguments = (self.repo, commit, DOCUMENT, digest, self.manifest_sha, PROJECT_NUMBER,
                     launch.canonical_project_fingerprint(PROJECT_NUMBER), self.root / "foreign", NOW)
        with self.assertRaisesRegex(stage.Stop, "OPERATION_DOCUMENT_HASH"):
            m.build(*arguments[:3], "0" * 64, *arguments[4:])
        with self.assertRaisesRegex(stage.Stop, "OPERATION_DOCUMENT"):
            m.build(self.repo, commit, "OTHER.md", digest, *arguments[4:])
        with self.assertRaisesRegex(stage.Stop, "APPROVAL_DOCUMENT_READ"):
            m.build(self.repo, "f" * 40, DOCUMENT, digest, *arguments[4:])
        self.assertFalse((self.root / "foreign").exists())

    def test_project_fingerprint_mismatch_refuses_without_private_output(self):
        with self.assertRaisesRegex(stage.Stop, "PROJECT_FINGERPRINT_MISMATCH"):
            self.build(output="fingerprint", project_fingerprint="f" * 64)
        self.assertFalse((self.root / "fingerprint").exists())

    def test_collision_symlink_and_extra_file_purge_refuse(self):
        existing = self.root / "collision"
        existing.mkdir(mode=0o700)
        with self.assertRaises(FileExistsError):
            self.build(output="collision")
        target = self.root / "target"
        target.mkdir()
        link = self.root / "link"
        link.symlink_to(target, target_is_directory=True)
        with self.assertRaises(FileExistsError):
            self.build(output="link")
        private = self.root / "purge"
        private.mkdir(mode=0o700)
        (private / "extra").write_text("preserve")
        with self.assertRaisesRegex(stage.Stop, "PURGE_SCOPE"):
            m.purge(private)
        self.assertEqual((private / "extra").read_text(), "preserve")

    def test_interrupted_write_and_signals_purge_exact_output(self):
        def interrupted(path, value):
            stage.reserve(path, value)
            raise KeyboardInterrupt()
        with self.assertRaises(KeyboardInterrupt):
            self.build(output="interrupt", reserve=interrupted)
        self.assertFalse((self.root / "interrupt").exists())
        for number in (signal.SIGINT, signal.SIGTERM):
            with self.subTest(signal=number):
                name = f"signal-{number}"
                old = signal.getsignal(number)
                signal.signal(number, lambda _number, _frame: (_ for _ in ()).throw(m.Stop("INTERRUPTED")))
                try:
                    def signaled(path, value, chosen=number):
                        stage.reserve(path, value)
                        os.kill(os.getpid(), chosen)
                    with self.assertRaisesRegex(stage.Stop, "INTERRUPTED"):
                        self.build(output=name, reserve=signaled)
                finally:
                    signal.signal(number, old)
                self.assertFalse((self.root / name).exists())

    def test_clock_rollback_and_expired_window_purge(self):
        values = iter((NOW, NOW - 1))
        with self.assertRaisesRegex(stage.Stop, "CLOCK_ROLLBACK"):
            self.build(output="rollback", now=lambda: next(values))
        self.assertFalse((self.root / "rollback").exists())
        with self.assertRaisesRegex(stage.Stop, "START_CUTOFF"):
            self.build(output="expired", now=NOW + 31)
        self.assertFalse((self.root / "expired").exists())

    def test_two_process_reservation_has_one_winner(self):
        commit, digest, _raw = self.commit_document()
        output = self.root / "race"
        ready, go, results = mp.Queue(), mp.Event(), mp.Queue()
        workers = [mp.Process(target=race_worker, args=(str(self.repo), commit, digest, self.manifest_sha,
                                                        str(output), ready, go, results)) for _ in range(2)]
        for worker in workers:
            worker.start()
        ready.get(timeout=5); ready.get(timeout=5); go.set()
        outcomes = sorted(results.get(timeout=10) for _ in workers)
        for worker in workers:
            worker.join(timeout=10)
        self.assertEqual(outcomes, ["P08_PRIVATE_PLAN_READY_LOCAL", "REFUSED"])
        m.purge(output)

    def test_native_refuses_without_inputs_or_provider_access(self):
        completed = subprocess.run([sys.executable, "-B", str(m.ROOT / "plan_builder.py")], cwd=m.ROOT,
                                   capture_output=True, text=True, timeout=5)
        self.assertEqual(completed.returncode, 2)
        self.assertEqual(completed.stdout.strip(), "P08_PLAN_BUILDER_REFUSED_UNBOUND")
        source = (m.ROOT / "plan_builder.py").read_text()
        for forbidden in ("gcloud", "urllib", "Authorization", "print-access-token"):
            self.assertNotIn(forbidden, source)


if __name__ == "__main__":
    unittest.main()
