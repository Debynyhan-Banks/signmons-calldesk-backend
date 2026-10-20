import datetime as dt
import importlib.util
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

path = Path(__file__).with_name("p06-r11-connect-string-diagnostic.py")
spec = importlib.util.spec_from_file_location("connect_diagnostic", path)
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)


def url(host=m.DIRECT, user=b"neondb_owner", password=b"npg_test", database=b"neondb", query=b"sslmode=require&channel_binding=require", port=b""):
    port_value = b":" + port if port else b""
    return bytearray(b"postgresql://" + user + b":" + password + b"@" + host + port_value + b"/" + database + b"?" + query)


class ConnectDiagnosticTests(unittest.TestCase):
    def test_current_cell_routed_hosts_are_fixed(self):
        self.assertEqual(m.DIRECT, b"ep-nameless-frog-ayk5gr5y.c-5.us-east-2.aws.neon.tech")
        self.assertEqual(m.POOLED, b"ep-nameless-frog-ayk5gr5y-pooler.c-5.us-east-2.aws.neon.tech")

    def test_exact_direct_and_pooled_targets(self):
        self.assertEqual(m.parse_target(url())[0], "DIRECT")
        host_class, password = m.parse_target(url(host=m.POOLED, password=b"npg_a%3Ab"))
        self.assertEqual(host_class, "POOLED")
        self.assertEqual(password, bytearray(b"npg_a:b"))

    def test_target_mismatches_refuse(self):
        cases = [
            bytearray(b"http://neondb_owner:npg_test@" + m.DIRECT + b"/neondb?sslmode=require"),
            url(user=b"other"), url(password=b""), url(host=b"ep-wrong.us-east-2.aws.neon.tech"),
            url(database=b"other"), url(port=b"6432"), url(query=b"sslmode=disable"),
            url(query=b"sslmode=require&other=1"), url() + b"#fragment",
        ]
        for value in cases:
            with self.subTest(value=value[:24]), self.assertRaises(m.TargetError): m.parse_target(value)

    def test_classifications(self):
        self.assertEqual(m.classify(0,b"1\n",b""),"ACCEPTED")
        self.assertEqual(m.classify(2,b"",b"password authentication failed"),"AUTH_REFUSED")
        self.assertEqual(m.classify(2,b"",b"could not translate host name"),"DNS_REFUSED")
        self.assertEqual(m.classify(2,b"",b"connection timed out"),"TIMEOUT")
        self.assertEqual(m.classify(2,b"",b"channel binding error"),"TLS_REFUSED")

    def test_write_once_is_exclusive(self):
        with tempfile.TemporaryDirectory() as directory, mock.patch.object(m, "ROOT", Path(directory)):
            m.write_once("marker.json", {"status":"FIRST"})
            with self.assertRaises(FileExistsError): m.write_once("marker.json", {"status":"SECOND"})
            self.assertEqual(json.loads((Path(directory) / "marker.json").read_text())["status"], "FIRST")

    def test_validate_refuses_expired_window(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); os.chmod(root, 0o700)
            current = dt.datetime.now(dt.timezone.utc)
            with mock.patch.multiple(m, ROOT=root, START=current-dt.timedelta(minutes=20), START_BEFORE=current-dt.timedelta(minutes=10), END=current-dt.timedelta(minutes=1)):
                approval = {"action":"DIAGNOSE_PRODUCTION_CONNECT_STRING_READ_ONLY","automaticRetry":False,"decision":"APPROVED","endsAt":m.iso(m.END),"operationId":m.OPERATION_ID,"owner":"Debynyhan Banks","planId":m.PLAN_ID,"privateRoot":str(root),"sourceSha256":m.source_sha(),"startBefore":m.iso(m.START_BEFORE),"startsAt":m.iso(m.START)}
                (root / "owner-approval.json").write_text(json.dumps(approval))
                with self.assertRaisesRegex(ValueError, "APPROVAL_OR_WINDOW"): m.validate()

    def test_one_use_result_contains_no_credential(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); os.chmod(root, 0o700)
            current = dt.datetime.now(dt.timezone.utc)
            with mock.patch.multiple(m, ROOT=root, START=current-dt.timedelta(minutes=1), START_BEFORE=current+dt.timedelta(minutes=10), END=current+dt.timedelta(minutes=20)):
                approval = {"action":"DIAGNOSE_PRODUCTION_CONNECT_STRING_READ_ONLY","automaticRetry":False,"decision":"APPROVED","endsAt":m.iso(m.END),"operationId":m.OPERATION_ID,"owner":"Debynyhan Banks","planId":m.PLAN_ID,"privateRoot":str(root),"sourceSha256":m.source_sha(),"startBefore":m.iso(m.START_BEFORE),"startsAt":m.iso(m.START)}
                (root / "owner-approval.json").write_text(json.dumps(approval))
                private_url = url(password=b"npg_private_test")
                with mock.patch.object(m, "read_private_url", return_value=private_url), mock.patch.object(m, "probe", return_value="ACCEPTED") as probe:
                    self.assertEqual(m.run(), "R11_CONNECT_STRING_DIAGNOSTIC_CAPTURED")
                    self.assertEqual(probe.call_count, 2)
                result = (root / "diagnostic-result.json").read_text()
                self.assertNotIn("npg_private_test", result)
                self.assertFalse((root / "pgpass").exists())
                with self.assertRaisesRegex(ValueError, "CONSUMED"): m.run()

    def test_target_mismatch_never_connects(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); os.chmod(root, 0o700)
            current = dt.datetime.now(dt.timezone.utc)
            with mock.patch.multiple(m, ROOT=root, START=current-dt.timedelta(minutes=1), START_BEFORE=current+dt.timedelta(minutes=10), END=current+dt.timedelta(minutes=20)):
                approval = {"action":"DIAGNOSE_PRODUCTION_CONNECT_STRING_READ_ONLY","automaticRetry":False,"decision":"APPROVED","endsAt":m.iso(m.END),"operationId":m.OPERATION_ID,"owner":"Debynyhan Banks","planId":m.PLAN_ID,"privateRoot":str(root),"sourceSha256":m.source_sha(),"startBefore":m.iso(m.START_BEFORE),"startsAt":m.iso(m.START)}
                (root / "owner-approval.json").write_text(json.dumps(approval))
                with mock.patch.object(m, "read_private_url", return_value=url(host=b"ep-wrong.us-east-2.aws.neon.tech")), mock.patch.object(m, "probe") as probe:
                    self.assertEqual(m.run(), "R11_CONNECT_STRING_TARGET_MISMATCH")
                    probe.assert_not_called()
                result = json.loads((root / "diagnostic-result.json").read_text())
                self.assertEqual(result["target"], "MISMATCH")
                self.assertEqual(result["direct"], "NOT_RUN")


if __name__ == "__main__": unittest.main()
