"""Disabled P08 composition model. No native credential or provider transport exists."""
from __future__ import annotations

import datetime as dt
import hashlib
import json
import os
import re
import signal
import stat
import time
import uuid
from pathlib import Path


ROOT = Path(__file__).resolve().parent
PROJECT = "signmons"
JOB = "9180bef4-561d-47a0-869f-925e6a3dfd96"
TENANT = "a1adcfd4-15be-404b-9ac3-5edb1fda20f0"
OWNER = "debynyhan@signmons.com"
IDENTITY = "signmons-calldesk-p07-runtime@signmons.iam.gserviceaccount.com"
LOOKUP_ROLE = "projects/signmons/roles/signmonsP08FirebaseUserLookup"
SIGNING_ROLE = "projects/signmons/roles/signmonsP08ServiceAccountSignBlob"
RESTRICTIONS = {"apiTargets": [{"service": "identitytoolkit.googleapis.com"}]}
SOURCE_HASHES = {
    "restoration": "a0bf4bc90cca0bd52935915d710ccb44e065dd3deed841a12ab49cb3ac4a1cb9",
    "access": "d54334352529e3aa4d3717be6b1c6f840ec284d3b83a9a3aaeb5053fa7547576",
    "authAuthority": "51c5250ace4ff095a7cc2e5b6f4e099a863389fa095c2bfe26151c832480d965",
    "authController": "57ab0853630112145e81e10143b05099b2a446f7f450d0eff4598540528ef0c4",
    "authAdapters": "ee4906f969ae40e40b4c4a066829afc63257c62a8e9e60fcdbc1ea376b91855a",
}
SOURCE_PATHS = {
    "restoration": ROOT.parent.parent / "p08-restoration-local-20261028/source/restore.py",
    "access": ROOT.parent.parent / "p08-access-resolution-local-20261028/source/access_readiness.py",
    "authAuthority": ROOT.parent.parent / "p08-authentication-local-20261026/source/auth-authority.mjs",
    "authController": ROOT.parent.parent / "p08-authentication-local-20261026/source/auth-controller.mjs",
    "authAdapters": ROOT.parent.parent / "p08-authentication-local-20261026/source/auth-adapters.mjs",
}


class Stop(Exception):
    pass


def need(value, code):
    if not value:
        raise Stop(code)


def digest(value):
    raw = value if isinstance(value, bytes) else json.dumps(value, sort_keys=True, separators=(",", ":")).encode()
    return hashlib.sha256(raw).hexdigest()


def parse_time(value):
    need(isinstance(value, str) and re.fullmatch(r"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ", value), "UTC_FORMAT")
    return dt.datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()


def exact_uuid(value, code):
    try:
        need(isinstance(value, str) and str(uuid.UUID(value)) == value, code)
    except (ValueError, AttributeError, TypeError):
        raise Stop(code) from None
    return value


def verify_locked_sources(paths=None):
    paths = SOURCE_PATHS if paths is None else paths
    need(set(paths) == set(SOURCE_HASHES), "SOURCE_SET")
    for name, expected in SOURCE_HASHES.items():
        path = Path(paths[name])
        need(path.is_file() and not path.is_symlink(), "SOURCE_PATH")
        need(hashlib.sha256(path.read_bytes()).hexdigest() == expected, "SOURCE_DRIFT")
    return True


def verify_local_manifest():
    path = ROOT / "source-manifest.json"
    need(path.is_file() and not path.is_symlink(), "LOCAL_MANIFEST")
    manifest = json.loads(path.read_text())
    need(manifest.get("status") == "DISABLED_LOCAL_PREPARATION_ONLY", "LOCAL_MANIFEST")
    need(manifest.get("lockedSources") == SOURCE_HASHES, "LOCAL_MANIFEST")
    for name, expected in manifest.get("files", {}).items():
        need(name in ["composed_auth.py", "test_composed_auth.py"], "LOCAL_MANIFEST_PATH")
        target = ROOT / name
        need(target.is_file() and not target.is_symlink() and hashlib.sha256(target.read_bytes()).hexdigest() == expected, "LOCAL_SOURCE_DRIFT")
    need(set(manifest.get("files", {})) == {"composed_auth.py", "test_composed_auth.py"}, "LOCAL_MANIFEST_SET")
    return manifest


def authorize_parent(parent, now, mode="run"):
    need(parent.get("mode") == "LOCAL_COMPOSED_MODEL_ONLY" and parent.get("externalActionAuthorized") is False, "LOCAL_ONLY")
    operation = parent.get("operationId", "")
    exact_uuid(operation, "OPERATION_ID")
    need(parent.get("automaticRetryAllowed") is False, "NO_RETRY")
    need(parent.get("project") == PROJECT and re.fullmatch(r"[1-9][0-9]{5,19}", parent.get("projectNumber", "")), "PROJECT_SCOPE")
    need(parent.get("jobId") == JOB and parent.get("tenantId") == TENANT, "BUSINESS_SCOPE")
    need(parent.get("ownerPrincipal") == OWNER and parent.get("runtimeIdentity") == IDENTITY, "IDENTITY_SCOPE")
    need(parent.get("roles") == {"lookup": LOOKUP_ROLE, "signing": SIGNING_ROLE}, "ROLE_SCOPE")
    need(parent.get("permissions") == {"lookup": ["firebaseauth.users.get"], "signing": ["iam.serviceAccounts.signBlob"]}, "PERMISSION_SCOPE")
    key_id = "signmons-p08-" + operation.replace("-", "")
    need(parent.get("keyId") == key_id and parent.get("keyRestrictions") == RESTRICTIONS, "KEY_SCOPE")
    need(parent.get("sourceHashes") == SOURCE_HASHES, "SOURCE_BINDING")
    need(parent.get("proposalSha256") == "5009670c7a7bb3284a8c2a99c79eeebf1381fb131f874cc3271aa5564aa9c43f", "PROPOSAL_BINDING")
    need(parent.get("allowanceUsd") == 0 and parent.get("serviceEnableApproved") is False, "ALLOWANCE_OR_SERVICE")
    window = parent.get("window", {})
    times = {name: parse_time(window.get(name)) for name in ["start", "cutoff", "workEnd", "cleanupEnd", "purgeEnd"]}
    need(times["start"] < times["cutoff"] < times["workEnd"] < times["cleanupEnd"] < times["purgeEnd"], "WINDOW_ORDER")
    need(times["purgeEnd"] - times["start"] <= 3600 and times["cleanupEnd"] - times["workEnd"] >= 600, "WINDOW_BOUNDS")
    need(mode in ["run", "closeout"], "MODE")
    need(times["start"] <= now < times["cutoff" if mode == "run" else "cleanupEnd"], "START_CUTOFF")
    return times


def key_resource(parent):
    return f"projects/{parent['projectNumber']}/locations/global/keys/{parent['keyId']}"


def exact_key_receipt(parent, receipt):
    need(isinstance(receipt, dict), "KEY_RECEIPT")
    need(set(receipt) == {"name", "uid", "etag", "displayName", "restrictions"}, "KEY_RECEIPT_SHAPE")
    need(receipt["name"] == key_resource(parent), "KEY_RESOURCE")
    exact_uuid(receipt["uid"], "KEY_UID")
    need(isinstance(receipt["etag"], str) and 0 < len(receipt["etag"]) <= 256, "KEY_ETAG")
    need(receipt["displayName"] == "Signmons P08 " + parent["operationId"], "KEY_MARKER")
    need(receipt["restrictions"] == RESTRICTIONS, "KEY_RESTRICTIONS")
    return {"name": receipt["name"], "uid": receipt["uid"], "etag": receipt["etag"]}


def derive_child(parent, receipt, key_string):
    owned = exact_key_receipt(parent, receipt)
    need(isinstance(key_string, str) and 20 <= len(key_string) <= 4096, "KEY_STRING")
    return {
        "parentOperationId": parent["operationId"],
        "parentPlanSha256": digest(parent),
        "jobId": JOB,
        "tenantId": TENANT,
        "ownerPrincipal": OWNER,
        "runtimeIdentity": IDENTITY,
        "roles": parent["roles"],
        "window": parent["window"],
        "keyResource": owned["name"],
        "keyUid": owned["uid"],
        "keyEtag": owned["etag"],
        "keySha256": hashlib.sha256(key_string.encode()).hexdigest(),
        "sourceHashes": SOURCE_HASHES,
        "authority": "DERIVED_FROM_OWNER_APPROVED_PARENT_AND_EXACT_PROVIDER_RECEIPT",
        "externalActions": ["bind", "restore", "authenticate", "retire", "unbind", "delete-owned-key"],
    }


def authorize_child(parent, child, receipt, key_string):
    expected = derive_child(parent, receipt, key_string)
    need(child == expected, "CHILD_AUTHORITY_DRIFT")
    return True


def request_contracts(parent):
    expression = f"request.time >= timestamp('{parent['window']['start']}') && request.time < timestamp('{parent['window']['workEnd']}')"
    return {
        "createKey": {
            "method": "POST",
            "url": f"https://apikeys.googleapis.com/v2/projects/{parent['projectNumber']}/locations/global/keys?keyId={parent['keyId']}",
            "body": {"displayName": "Signmons P08 " + parent["operationId"], "restrictions": RESTRICTIONS},
        },
        "lookupBinding": ["projects", "add-iam-policy-binding", PROJECT, "--member=serviceAccount:" + IDENTITY, "--role=" + LOOKUP_ROLE, "--condition=expression=" + expression + ",title=p08_" + parent["operationId"] + "_lookup", "--quiet"],
        "signingBinding": ["iam", "service-accounts", "add-iam-policy-binding", IDENTITY, "--project=signmons", "--member=user:" + OWNER, "--role=" + SIGNING_ROLE, "--condition=expression=" + expression + ",title=p08_" + parent["operationId"] + "_signing", "--quiet"],
    }


def reserve(path, value):
    fd = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    try:
        os.write(fd, json.dumps(value, sort_keys=True).encode())
    finally:
        os.close(fd)


class Coordinator:
    FORWARD = ["key", "lookup", "signing", "runtime", "authentication"]

    def __init__(self, parent, adapter, directory, now=time.time, mode="run"):
        self.parent = parent
        self.adapter = adapter
        self.dir = Path(directory)
        self.now = now
        self.mode = mode
        self.times = authorize_parent(parent, now(), mode)
        need(self.dir.is_dir() and not self.dir.is_symlink() and stat.S_IMODE(self.dir.stat().st_mode) == 0o700, "PRIVATE_DIRECTORY")
        self.abort = False
        self.cleaning = False
        self.last = now()
        self.journal = {"operationId": parent["operationId"], "parentPlanSha256": digest(parent), "attempted": [], "finished": [], "unknown": [], "authenticated": False, "childSha256": None}

    def save(self):
        target = self.dir / "journal.json"
        temporary = self.dir / "journal.tmp"
        fd = os.open(temporary, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        try:
            os.write(fd, json.dumps(self.journal, sort_keys=True).encode())
        finally:
            os.close(fd)
        os.replace(temporary, target)

    def gate(self, cleanup=False):
        current = self.now()
        need(current >= self.last, "CLOCK_ROLLBACK")
        self.last = current
        need(current < self.times["cleanupEnd" if cleanup else "workEnd"], "DEADLINE")
        need(cleanup or not self.abort, "INTERRUPTED")

    def call(self, name, *args, cleanup=False):
        self.gate(cleanup)
        value = getattr(self.adapter, name)(*args, deadline=self.times["cleanupEnd" if cleanup else "workEnd"])
        self.gate(cleanup)
        return value

    def forward(self, stage, function):
        self.journal["attempted"].append(stage)
        self.save()
        try:
            value = function()
        except BaseException as error:
            if getattr(error, "outcome_unknown", False):
                self.journal["unknown"].append(stage)
                self.save()
            raise
        self.journal["finished"].append(stage)
        self.save()
        return value

    def run(self):
        need(self.mode == "run", "RUN_MODE")
        reserve(self.dir / "attempt.json", {"operationId": self.parent["operationId"], "parentPlanSha256": digest(self.parent)})
        old = {}
        def interrupted(*_):
            if not self.cleaning:
                self.abort = True
        for item in [signal.SIGINT, signal.SIGTERM]:
            old[item] = signal.signal(item, interrupted)
        failure = None
        try:
            self.save()
            need(self.call("qualify", self.parent) is True, "QUALIFICATION_REFUSED")
            need(self.call("key_absent", key_resource(self.parent)) is True, "KEY_COLLISION")
            service = self.call("service_state")
            need(service == "ENABLED", "SERVICE_NOT_PREAPPROVED")
            created = exact_key_receipt(self.parent, self.forward("key", lambda: self.call("create_key", self.parent)))
            receipt = exact_key_receipt(self.parent, self.call("read_key", key_resource(self.parent)))
            need(receipt == created, "KEY_READBACK_DRIFT")
            key_string = self.call("read_key_string", receipt["name"])
            try:
                child = derive_child(self.parent, {**receipt, "displayName": "Signmons P08 " + self.parent["operationId"], "restrictions": RESTRICTIONS}, key_string)
                authorize_child(self.parent, child, {**receipt, "displayName": "Signmons P08 " + self.parent["operationId"], "restrictions": RESTRICTIONS}, key_string)
                self.journal["childSha256"] = digest(child); self.save()
                self.forward("lookup", lambda: self.call("bind", "lookup", child))
                self.forward("signing", lambda: self.call("bind", "signing", child))
                self.forward("runtime", lambda: self.call("restore", child))
                proof = self.forward("authentication", lambda: self.call("authenticate", child, key_string))
            finally:
                key_string = ""
            need(proof == {"status": "P08_OPERATOR_AUTHENTICATED_AND_CLOSED", "authenticated": True, "sessionsAbsent": True, "privateMetadataAbsent": True}, "AUTH_PROOF")
            self.journal["authenticated"] = True; self.save()
        except BaseException as error:
            failure = str(error) if isinstance(error, Stop) else "ADAPTER_REFUSED_OR_UNKNOWN"
            self.journal["failure"] = failure; self.save()
        finally:
            result = self.cleanup()
            for item, handler in old.items():
                signal.signal(item, handler)
        result["failure"] = failure
        return result

    def cleanup(self):
        self.cleaning = True
        residuals = []
        actions = {"authentication": "close_authentication", "runtime": "retire", "signing": "unbind", "lookup": "unbind", "key": "delete_key"}
        for stage in reversed(self.journal["attempted"]):
            # Never delete a key unless exact owned creation was acknowledged and
            # read back. Unknown creation stays residual for later read-only diagnosis.
            if stage == "key" and stage not in self.journal["finished"]:
                continue
            try:
                if stage in ["signing", "lookup"]:
                    need(self.call(actions[stage], stage, cleanup=True) is True, "CLEANUP_READBACK")
                else:
                    need(self.call(actions[stage], cleanup=True) is True, "CLEANUP_READBACK")
            except BaseException:
                residuals.append(stage)
        for stage in self.journal["unknown"]:
            residuals.append("UNKNOWN:" + stage)
        try:
            need(self.call("retired_readback", cleanup=True) is True, "FINAL_READBACK")
        except BaseException:
            residuals.append("final-readback")
        self.cleaning = False
        self.journal["residuals"] = residuals; self.save()
        return {"status": "P08_COMPOSED_LOCAL_MODEL_VERIFIED" if self.journal["authenticated"] and not residuals else "P08_COMPOSED_LOCAL_MODEL_STOPPED" if not residuals else "CONTAINMENT_UNCONFIRMED", "authenticated": self.journal["authenticated"], "residuals": residuals, "realExternalActions": 0, "nativeTransportAvailable": False}


def native():
    verify_local_manifest()
    verify_locked_sources()
    print("P08_COMPOSED_AUTH_REFUSED_UNBOUND")
    return 2


if __name__ == "__main__":
    raise SystemExit(native())
