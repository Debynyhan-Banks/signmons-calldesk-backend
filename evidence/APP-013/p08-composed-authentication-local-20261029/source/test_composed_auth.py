import copy
import datetime as dt
import json
import os
import signal
import subprocess
import tempfile
import unittest
import uuid
from pathlib import Path

import composed_auth as m


NOW = 1793268000


def iso(offset):
    return dt.datetime.fromtimestamp(NOW + offset, dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def parent():
    operation = "12345678-1234-4234-8234-123456789abc"
    return {
        "mode": "LOCAL_COMPOSED_MODEL_ONLY", "externalActionAuthorized": False,
        "operationId": operation, "automaticRetryAllowed": False, "project": m.PROJECT, "projectNumber": "123456789012",
        "jobId": m.JOB, "tenantId": m.TENANT, "ownerPrincipal": m.OWNER,
        "runtimeIdentity": m.IDENTITY, "roles": {"lookup": m.LOOKUP_ROLE, "signing": m.SIGNING_ROLE},
        "permissions": {"lookup": ["firebaseauth.users.get"], "signing": ["iam.serviceAccounts.signBlob"]},
        "keyId": "signmons-p08-" + operation.replace("-", ""), "keyRestrictions": copy.deepcopy(m.RESTRICTIONS),
        "sourceHashes": copy.deepcopy(m.SOURCE_HASHES), "proposalSha256": "5009670c7a7bb3284a8c2a99c79eeebf1381fb131f874cc3271aa5564aa9c43f",
        "allowanceUsd": 0, "serviceEnableApproved": False,
        "window": {name: iso(offset) for name, offset in [("start", -10), ("cutoff", 40), ("workEnd", 200), ("cleanupEnd", 800), ("purgeEnd", 850)]},
    }


def receipt(p=None):
    p = parent() if p is None else p
    return {"name": m.key_resource(p), "uid": "20000000-0000-4000-8000-000000000002", "etag": "fixture-etag", "displayName": "Signmons P08 " + p["operationId"], "restrictions": copy.deepcopy(m.RESTRICTIONS)}


class Fake:
    def __init__(self, p):
        self.p = p; self.calls = []; self.fail = None; self.unknown = False; self.service = "ENABLED"
    def step(self, name, value=True):
        self.calls.append(name)
        if self.fail == name:
            error = RuntimeError(name); error.outcome_unknown = self.unknown; raise error
        return value
    def qualify(self, p, deadline): return self.step("qualify", True)
    def key_absent(self, resource, deadline): return self.step("key_absent", True)
    def service_state(self, deadline): return self.step("service_state", self.service)
    def create_key(self, p, deadline): return self.step("create_key", receipt(p))
    def read_key(self, resource, deadline): return self.step("read_key", receipt(self.p))
    def read_key_string(self, resource, deadline): return self.step("read_key_string", "fixture-secret-value-with-length")
    def bind(self, kind, child, deadline): return self.step("bind_" + kind, True)
    def restore(self, child, deadline): return self.step("restore", True)
    def authenticate(self, child, key_string, deadline): return self.step("authenticate", {"status":"P08_OPERATOR_AUTHENTICATED_AND_CLOSED","authenticated":True,"sessionsAbsent":True,"privateMetadataAbsent":True})
    def close_authentication(self, deadline): return self.step("close_authentication", True)
    def retire(self, deadline): return self.step("retire", True)
    def unbind(self, kind, deadline): return self.step("unbind_" + kind, True)
    def delete_key(self, deadline): return self.step("delete_key", True)
    def retired_readback(self, deadline): return self.step("retired_readback", True)


class Tests(unittest.TestCase):
    def setUp(self):
        self.p = parent(); self.fake = Fake(self.p); self.now = NOW
        self.tmp = tempfile.TemporaryDirectory(prefix="p08-composed-")
        os.chmod(self.tmp.name, 0o700)
    def tearDown(self): self.tmp.cleanup()
    def controller(self): return m.Coordinator(self.p, self.fake, self.tmp.name, now=lambda:self.now)

    def test_locked_sources_and_native_refusal(self):
        self.assertTrue(m.verify_locked_sources())
        run = subprocess.run(["/opt/homebrew/bin/python3", "-B", str(Path(m.__file__))], capture_output=True, text=True)
        self.assertEqual(run.returncode, 2); self.assertEqual(run.stdout.strip(), "P08_COMPOSED_AUTH_REFUSED_UNBOUND"); self.assertEqual(run.stderr, "")

    def test_happy_path_and_reverse_cleanup(self):
        result = self.controller().run()
        self.assertEqual(result["status"], "P08_COMPOSED_LOCAL_MODEL_VERIFIED")
        self.assertEqual(self.fake.calls, ["qualify","key_absent","service_state","create_key","read_key","read_key_string","bind_lookup","bind_signing","restore","authenticate","close_authentication","retire","unbind_signing","unbind_lookup","delete_key","retired_readback"])
        journal = json.loads((Path(self.tmp.name)/"journal.json").read_text())
        self.assertEqual(journal["attempted"], ["key","lookup","signing","runtime","authentication"]); self.assertEqual(journal["residuals"], [])
        self.assertEqual(oct((Path(self.tmp.name)/"journal.json").stat().st_mode & 0o777), "0o600")

    def test_child_is_exact_derivation(self):
        secret = "fixture-secret-value-with-length"; child = m.derive_child(self.p, receipt(self.p), secret)
        self.assertTrue(m.authorize_child(self.p, child, receipt(self.p), secret))
        for field in list(child):
            changed = copy.deepcopy(child); changed[field] = "foreign"
            with self.subTest(field=field), self.assertRaises(m.Stop): m.authorize_child(self.p, changed, receipt(self.p), secret)
        self.assertNotIn(secret, json.dumps(child)); self.assertNotIn("approval", child)

    def test_exact_request_contracts(self):
        value = m.request_contracts(self.p)
        self.assertEqual(value["createKey"]["body"]["restrictions"], m.RESTRICTIONS)
        self.assertIn("--role="+m.LOOKUP_ROLE, value["lookupBinding"]); self.assertIn("--role="+m.SIGNING_ROLE, value["signingBinding"])
        self.assertFalse(any("create-role" in x for x in json.dumps(value).split()))
        self.assertIn(self.p["window"]["workEnd"], json.dumps(value))

    def test_parent_field_drift_refuses(self):
        mutations = {
            "mode":"LIVE", "externalActionAuthorized":True, "operationId":"bad", "automaticRetryAllowed":True,
            "project":"other", "projectNumber":"not-numeric", "jobId":str(uuid.uuid4()), "tenantId":str(uuid.uuid4()), "ownerPrincipal":"other@example.com",
            "runtimeIdentity":"other", "roles":{}, "permissions":{}, "keyId":"foreign", "keyRestrictions":{},
            "sourceHashes":{}, "proposalSha256":"0"*64, "allowanceUsd":1, "serviceEnableApproved":True,
        }
        for field, value in mutations.items():
            changed=copy.deepcopy(self.p); changed[field]=value
            with self.subTest(field=field), self.assertRaises((m.Stop, ValueError)): m.authorize_parent(changed,NOW)

    def test_window_drift_refuses(self):
        for field, value in [("start","bad"),("cutoff",iso(-20)),("workEnd",iso(900)),("cleanupEnd",iso(250)),("purgeEnd",iso(4000))]:
            changed=copy.deepcopy(self.p);changed["window"][field]=value
            with self.subTest(field=field), self.assertRaises(m.Stop):m.authorize_parent(changed,NOW)

    def test_key_receipt_drift_refuses(self):
        values={"name":"projects/other/locations/global/keys/x","uid":"not-a-uuid","etag":"","displayName":"foreign","restrictions":{"apiTargets":[{"service":"other.googleapis.com"}]}}
        for field,value in values.items():
            changed=receipt(self.p);changed[field]=value
            with self.subTest(field=field),self.assertRaises(m.Stop):m.exact_key_receipt(self.p,changed)
        changed=receipt(self.p);changed["extra"]=True
        with self.assertRaises(m.Stop):m.exact_key_receipt(self.p,changed)

    def test_service_disabled_stops_before_creation(self):
        self.fake.service="DISABLED"; result=self.controller().run()
        self.assertEqual(result["status"],"P08_COMPOSED_LOCAL_MODEL_STOPPED");self.assertEqual(result["failure"],"SERVICE_NOT_PREAPPROVED")
        self.assertNotIn("create_key",self.fake.calls);self.assertEqual(self.fake.calls[-1],"retired_readback")

    def test_failure_cleanup_prefixes(self):
        expected={"create_key":[],"bind_lookup":["delete_key"],"bind_signing":["unbind_lookup","delete_key"],"restore":["unbind_signing","unbind_lookup","delete_key"],"authenticate":["retire","unbind_signing","unbind_lookup","delete_key"]}
        for failure, cleanup in expected.items():
            with self.subTest(failure=failure):
                self.tearDown();self.setUp();self.fake.fail=failure;result=self.controller().run();self.assertFalse(result["authenticated"])
                positions=[self.fake.calls.index(x) for x in cleanup];self.assertEqual(positions,sorted(positions))
                if failure=="create_key":self.assertNotIn("delete_key",self.fake.calls)

    def test_unknown_outcome_never_claims_containment(self):
        self.fake.fail="bind_lookup";self.fake.unknown=True;result=self.controller().run()
        self.assertEqual(result["status"],"CONTAINMENT_UNCONFIRMED");self.assertIn("UNKNOWN:lookup",result["residuals"])

    def test_unknown_key_creation_is_not_adopted_or_deleted(self):
        self.fake.fail="create_key";self.fake.unknown=True;result=self.controller().run()
        self.assertEqual(result["status"],"CONTAINMENT_UNCONFIRMED");self.assertIn("UNKNOWN:key",result["residuals"])
        self.assertNotIn("delete_key",self.fake.calls)

    def test_create_readback_drift_refuses_and_deletes_owned_key(self):
        original=self.fake.read_key
        def changed(resource,deadline):
            value=original(resource,deadline);value["etag"]="changed";return value
        self.fake.read_key=changed;result=self.controller().run()
        self.assertEqual(result["failure"],"KEY_READBACK_DRIFT");self.assertIn("delete_key",self.fake.calls)

    def test_cleanup_failure_is_residual(self):
        self.fake.fail="delete_key";result=self.controller().run()
        self.assertEqual(result["status"],"CONTAINMENT_UNCONFIRMED");self.assertIn("key",result["residuals"])

    def test_exclusive_attempt(self):
        first=self.controller();reserve=Path(self.tmp.name)/"attempt.json";m.reserve(reserve,{"foreign":True})
        with self.assertRaises(FileExistsError):first.run()

    def test_clock_rollback_and_deadline(self):
        c=self.controller();self.now=NOW-1
        with self.assertRaises(m.Stop) as caught:c.gate()
        self.assertEqual(str(caught.exception),"CLOCK_ROLLBACK")
        self.tearDown();self.setUp();c=self.controller();self.now=NOW+201
        with self.assertRaises(m.Stop) as caught:c.gate()
        self.assertEqual(str(caught.exception),"DEADLINE")

    def test_signal_sets_abort_but_cleanup_runs(self):
        original=self.fake.bind
        def bind(kind,child,deadline):
            if kind=="lookup":os.kill(os.getpid(),signal.SIGTERM)
            return original(kind,child,deadline)
        self.fake.bind=bind;result=self.controller().run()
        self.assertEqual(result["status"],"P08_COMPOSED_LOCAL_MODEL_STOPPED");self.assertEqual(result["failure"],"INTERRUPTED")
        self.assertIn("delete_key",self.fake.calls);self.assertEqual(self.fake.calls[-1],"retired_readback")

    def test_no_sensitive_value_persisted(self):
        self.controller().run(); content="".join(p.read_text() for p in Path(self.tmp.name).iterdir())
        self.assertNotIn("fixture-secret-value-with-length",content);self.assertNotIn("Bearer ",content)


if __name__ == "__main__": unittest.main()
