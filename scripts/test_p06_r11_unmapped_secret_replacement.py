import importlib.util
import json
import tempfile
import unittest
from pathlib import Path

MODULE = Path(__file__).with_name("p06-r11-unmapped-secret-replacement.py")
spec = importlib.util.spec_from_file_location("replacement", MODULE)
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)


class ReplacementTests(unittest.TestCase):
    def test_password_percent_encoding(self):
        value = bytearray(b"a b:@/%")
        self.assertEqual(m.encode_password(value), bytearray(b"a%20b%3A%40%2F%25"))
        self.assertNotIn(b"a b", m.encode_password(value))

    def test_replacement_document_changes_only_database_version_and_adds_candidate(self):
        baseline = {
            "metadata": {"annotations": {"autoscaling.knative.dev/maxScale": "2", "run.googleapis.com/operation-id": "omit"}},
            "spec": {"containers": [{"image": m.BASELINE_IMAGE, "env": [{"name": "DATABASE_URL", "valueFrom": {"secretKeyRef": {"name": m.SECRET, "key": "latest"}}}, {"name": "UNCHANGED", "value": "yes"}]}], "containerConcurrency": 40},
        }
        current = {"metadata": {"namespace": "1", "annotations": {"run.googleapis.com/ingress": "all", "noise": "omit"}, "labels": {}}, "spec": {"traffic": [{"revisionName": m.BASELINE, "percent": 100}]}}
        doc = m.replacement_document(current, baseline, "3")
        container = doc["spec"]["template"]["spec"]["containers"][0]
        self.assertEqual(m.secret_ref(container, "DATABASE_URL"), {"name": m.SECRET, "key": "3"})
        self.assertEqual(container["env"][1], {"name": "UNCHANGED", "value": "yes"})
        self.assertEqual(doc["spec"]["traffic"][-1], {"revisionName": m.REPLACEMENT, "tag": m.CANDIDATE_TAG})
        self.assertNotIn("noise", doc["metadata"]["annotations"])

    def test_preflight_accepts_only_exact_inventory(self):
        baseline = {"spec": {"containers": [{"image": m.BASELINE_IMAGE, "env": [{"name": "DATABASE_URL", "valueFrom": {"secretKeyRef": {"name": m.SECRET, "key": "latest"}}}]}]}, "status": {"imageDigest": m.BASELINE_IMAGE}}
        job = {"spec": {"template": {"spec": {"template": {"spec": {"containers": [{"env": [{"name": "DATABASE_URL", "valueFrom": {"secretKeyRef": {"name": m.SECRET, "key": "latest"}}}]}]}}}}}}
        traffic = [{"revisionName": m.BASELINE, "percent": 100, "tag": "app013-bounds"}, {"revisionName": "signmons-calldesk-staging-app013p06disabled", "tag": m.PRESERVE_TAG}]
        traffic += [{"revisionName": "old", "tag": tag} for tag in m.REMOVE_TAGS]
        service = {"spec": {"traffic": traffic}}
        shared = [{"name": "x/1", "state": "DISABLED"}, {"name": "x/2", "state": "ENABLED"}]
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
