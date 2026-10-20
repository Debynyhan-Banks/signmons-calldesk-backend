import importlib.util
import json
import tempfile
import unittest
from pathlib import Path

MODULE = Path(__file__).with_name("p06-r11-db-auth-recovery.py")
spec = importlib.util.spec_from_file_location("replacement", MODULE)
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)


class DatabaseAuthRecoveryTests(unittest.TestCase):
    def test_current_connect_url_metadata_and_password(self):
        value = bytearray(b"postgresql://neondb_owner:npg_a%3Ab@" + m.POOLED_HOST.encode() + b"/neondb?sslmode=require&channel_binding=require")
        self.assertEqual(m.parse_connect_url(value), bytearray(b"npg_a:b"))
        self.assertIn(".c-5.", m.POOLED_HOST)

    def test_connect_url_refuses_wrong_target(self):
        cases = [
            bytearray(b"postgresql://other:npg_test@" + m.POOLED_HOST.encode() + b"/neondb?sslmode=require"),
            bytearray(b"postgresql://neondb_owner:npg_test@wrong.example/neondb?sslmode=require"),
            bytearray(b"postgresql://neondb_owner:npg_test@" + m.POOLED_HOST.encode() + b"/other?sslmode=require"),
            bytearray(b"postgresql://neondb_owner:npg_test@" + m.POOLED_HOST.encode() + b"/neondb?sslmode=disable"),
        ]
        for value in cases:
            with self.subTest(value=value[:28]), self.assertRaisesRegex(ValueError, "CONNECT_URL_METADATA"):
                m.parse_connect_url(value)

    def test_replacement_document_changes_only_database_version_and_adds_candidate(self):
        baseline = {
            "metadata": {"annotations": {"autoscaling.knative.dev/maxScale": "2", "run.googleapis.com/operation-id": "omit"}},
            "spec": {"containers": [{"image": m.BASELINE_IMAGE, "env": [{"name": "DATABASE_URL", "valueFrom": {"secretKeyRef": {"name": m.SECRET, "key": "latest"}}}, {"name": "UNCHANGED", "value": "yes"}]}], "containerConcurrency": 40},
        }
        current = {"metadata": {"namespace": "1", "annotations": {"run.googleapis.com/ingress": "all", "noise": "omit"}, "labels": {}}, "spec": {"traffic": [{"revisionName": m.BASELINE, "percent": 100}]}}
        current["spec"]["traffic"].append({"revisionName": m.FAILED_REPLACEMENT, "tag": m.FAILED_CANDIDATE_TAG})
        doc = m.replacement_document(current, baseline, "4")
        container = doc["spec"]["template"]["spec"]["containers"][0]
        self.assertEqual(m.secret_ref(container, "DATABASE_URL"), {"name": m.SECRET, "key": "4"})
        self.assertEqual(container["env"][1], {"name": "UNCHANGED", "value": "yes"})
        self.assertEqual(doc["spec"]["traffic"][-1], {"revisionName": m.REPLACEMENT, "tag": m.CANDIDATE_TAG})
        self.assertNotIn(m.FAILED_CANDIDATE_TAG, [row.get("tag") for row in doc["spec"]["traffic"]])
        self.assertNotIn("noise", doc["metadata"]["annotations"])

    def test_preflight_accepts_only_exact_inventory(self):
        baseline = {"spec": {"containers": [{"image": m.BASELINE_IMAGE, "env": [{"name": "DATABASE_URL", "valueFrom": {"secretKeyRef": {"name": m.SECRET, "key": "latest"}}}]}]}, "status": {"imageDigest": m.BASELINE_IMAGE}}
        job = {"spec": {"template": {"spec": {"template": {"spec": {"containers": [{"env": [{"name": "DATABASE_URL", "valueFrom": {"secretKeyRef": {"name": m.SECRET, "key": "latest"}}}]}]}}}}}}
        traffic = [{"revisionName": m.BASELINE, "percent": 100, "tag": "app013-bounds"}, {"revisionName": "signmons-calldesk-staging-app013p06disabled", "tag": m.PRESERVE_TAG}]
        traffic += [{"revisionName": m.FAILED_REPLACEMENT, "tag": m.FAILED_CANDIDATE_TAG}]
        service = {"spec": {"traffic": traffic}}
        shared = [{"name": "x/1", "state": "DISABLED"}, {"name": "x/2", "state": "ENABLED"}, {"name": "x/3", "state": "ENABLED"}]
        child = [{"name": "x/2", "state": "ENABLED"}]
        m.validate_preflight(service, baseline, job, shared, child)
        service["spec"]["traffic"].append({"revisionName": "bad", "tag": "p06-intake-enabled"})
        with self.assertRaises(ValueError):
            m.validate_preflight(service, baseline, job, shared, child)

    def test_write_once_and_stage_are_one_use_and_sanitize_failure(self):
        with tempfile.TemporaryDirectory(dir="/private/tmp") as directory:
            original = m.ROOT
            m.ROOT = Path(directory)
            m.ROOT.chmod(0o700)
            try:
                m.write_once("preflight.json", {"status": "ok"})
                with self.assertRaises(FileExistsError):
                    m.write_once("preflight.json", {"status": "again"})
                original_validate = m.validate_approval
                m.validate_approval = lambda require_window=False: None
                with self.assertRaisesRegex(ValueError, "CONSUMED_STOP"):
                    m.stage("example", "preflight.json", lambda: (_ for _ in ()).throw(RuntimeError("FICTIONAL_SECRET_CANARY")))
                content = "".join(path.read_text() for path in m.ROOT.iterdir())
                self.assertNotIn("FICTIONAL_SECRET_CANARY", content)
                self.assertTrue((m.ROOT / "example-stop.json").exists())
                m.validate_approval = original_validate
            finally:
                m.ROOT = original


if __name__ == "__main__":
    unittest.main()
