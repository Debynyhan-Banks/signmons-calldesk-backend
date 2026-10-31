"""Disabled P08 adapter: derive closeout from exact injected read interfaces."""
from __future__ import annotations

import hashlib
import importlib.util
import json
import re
import stat
import time
import uuid
from functools import lru_cache
from pathlib import Path

HERE = Path(__file__).resolve().parent
COORDINATOR = HERE.parent.parent / "p08-live-binder-local-20261029/source/coordinator.py"
COORDINATOR_SHA = "1eecc5241794cfed6d892db4385039274539e47b183f1d934899549eb5560f70"
PRIVATE_NAMES = frozenset({"launch-plan.json", "restore-plan.json", "auth-plan.json",
                           "auth-result-authenticate.json", "auth-result-closeout-only.json"})


class Stop(Exception):
    pass


def need(value, code):
    if not value:
        raise Stop(code)


def verify_bundle():
    manifest = HERE / "source-manifest.json"
    need(manifest.is_file() and not manifest.is_symlink(), "MANIFEST_ABSENT")
    value = json.loads(manifest.read_text())
    need(value.get("status") == "DISABLED_LOCAL_ONLY" and
         value.get("coordinatorSha256") == COORDINATOR_SHA and
         set(value.get("files", {})) == {"adapter.py", "test_adapter.py", "fixture_handoff.mjs"}, "MANIFEST_SHAPE")
    for name, expected in value["files"].items():
        path = HERE / name
        need(path.is_file() and not path.is_symlink() and
             hashlib.sha256(path.read_bytes()).hexdigest() == expected, "ADAPTER_SOURCE_DRIFT")
    return True


def load_sources():
    verify_bundle()
    need(COORDINATOR.is_file() and not COORDINATOR.is_symlink() and
         hashlib.sha256(COORDINATOR.read_bytes()).hexdigest() == COORDINATOR_SHA, "COORDINATOR_SOURCE_DRIFT")
    result = _loaded_sources()
    result[0].sources()
    return result


@lru_cache(maxsize=1)
def _loaded_sources():
    spec = importlib.util.spec_from_file_location("p08_closeout_coordinator", COORDINATOR)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    modules = module.sources()
    return module, modules["bridge"], modules["restore"]


def private_absent(root, operation_id):
    root = Path(root)
    need(re.fullmatch(r"/private/tmp/p08-coordinator-private-[a-f0-9-]{36}", str(root)) and
         str(root).endswith(operation_id), "PRIVATE_ROOT_SCOPE")
    need(root.is_dir() and not root.is_symlink() and stat.S_IMODE(root.lstat().st_mode) == 0o700,
         "PRIVATE_ROOT_MODE")
    names = set()
    for child in root.iterdir():
        need(child.name in PRIVATE_NAMES, "PRIVATE_FOREIGN_PATH")
        mode = child.lstat().st_mode
        need(stat.S_ISREG(mode) and not child.is_symlink() and stat.S_IMODE(mode) == 0o600,
             "PRIVATE_PATH_TYPE_MODE")
        names.add(child.name)
    need(not names, "PRIVATE_PATH_PRESENT")
    return True


def exact_account(row, target):
    need(isinstance(row, dict) and set(row) >= {"id", "tenantId", "email", "fullName", "role", "status"}, "ACCOUNT_SHAPE")
    need(all(row[k] == target[k] for k in ("id", "tenantId", "email", "fullName", "role")) and
         row["role"] == "ADMIN" and row["status"] == "DISABLED", "ACCOUNT_DRIFT")
    return True


def exact_firebase(user, target, not_before):
    need(isinstance(user, dict) and set(user) >= {"uid", "email", "displayName", "disabled",
                                                "emailVerified", "customClaims", "tokensValidAfterTime"}, "FIREBASE_SHAPE")
    need(user["uid"] == target["id"] and user["email"] == target["email"] and
         user["displayName"] == target["fullName"] and user["disabled"] is True and
         user["emailVerified"] is False, "FIREBASE_DRIFT")
    need(user["customClaims"] == {"tenantId": target["tenantId"], "role": "admin", "testOnly": True}, "CLAIMS_DRIFT")
    need(isinstance(user["tokensValidAfterTime"], str), "REVOCATION_SHAPE")
    try:
        from datetime import datetime
        parsed = datetime.fromisoformat(user["tokensValidAfterTime"].replace("Z", "+00:00"))
        need(parsed.tzinfo is not None, "REVOCATION_SHAPE")
        valid_after = parsed.timestamp()
    except (ValueError, TypeError):
        raise Stop("REVOCATION_SHAPE") from None
    need(int(valid_after) >= int(not_before), "REVOCATION_STALE")
    return True


class BoundReadbacks:
    """Connect existing Ports to raw readers; no caller-supplied success booleans."""
    def __init__(self, plan, target, qualification, runtime, cli, https, auth_handoff,
                 app_read, firebase_read, session_count, private_root, clock=time.time):
        self.coordinator, self.bridge, self.restore = load_sources()
        need(plan.get("externalActionAuthorized") is False and plan.get("mode") == "LOCAL_INTEGRATED_PACKET_ONLY", "LOCAL_ONLY")
        need(plan.get("jobId") == self.restore.JOB and plan.get("tenantId") == self.restore.TENANT, "BUSINESS_SCOPE")
        need(isinstance(target, dict) and set(target) == {"id", "tenantId", "email", "fullName", "role"}, "TARGET_SHAPE")
        need(str(uuid.UUID(target["id"])) == target["id"] and target["tenantId"] == plan["tenantId"] and
             target["role"] == "ADMIN" and isinstance(target["email"], str) and target["email"] and
             isinstance(target["fullName"], str) and target["fullName"], "TARGET_SCOPE")
        need(all(callable(x) for x in (cli, https, auth_handoff, app_read, firebase_read, session_count, clock)), "READERS_REQUIRED")
        need(isinstance(runtime, self.restore.NativeAdapter), "NATIVE_ADAPTER_REQUIRED")
        need(isinstance(qualification, dict) and re.fullmatch(r"[a-f0-9]{64}", qualification.get("runtimeEnvironmentSha256", "")),
             "QUALIFICATION_SCOPE")
        self.plan, self.target, self.qualification, self.runtime = plan, target, qualification, runtime
        self.app_read, self.firebase_read, self.session_count = app_read, firebase_read, session_count
        self.auth_handoff, self.private_root, self.clock = auth_handoff, private_root, clock
        self.auth_started = None
        self.ports = self.bridge.Ports(plan, cli, https, self.authenticate,
                                      self.account_readback, self.runtime_readback, clock)

    def authenticate(self, receipt):
        need(receipt.get("operationId") == self.plan["operationId"] and
             receipt.get("keyResource") == self.ports.key_resource and receipt.get("createdInOperation") is True and
             receipt.get("deleted") is False, "OWNED_RECEIPT_SCOPE")
        self.auth_started = self.clock()
        result = self.auth_handoff(receipt)
        need(isinstance(result, dict) and result.get("status") == "P08_OPERATOR_AUTHENTICATED_AND_CLOSED" and
             result.get("authenticated") is True and result.get("sessionsAbsent") is True and
             result.get("residuals") == [] and result.get("liveAuthorization") is False and
             result.get("authProofReady") is False, "AUTH_HANDOFF_RESULT")
        need(self.account_readback() == {"appDisabled": True, "firebaseDisabled": True,
                                         "tokensRevoked": True, "sessionsAbsent": True}, "AUTH_READBACK")
        need(private_absent(self.private_root, self.plan["operationId"]), "PRIVATE_READBACK")
        return dict(self.bridge.packet.AUTH_PROOF)

    def account_readback(self):
        need(self.auth_started is not None, "AUTH_NOT_ATTEMPTED")
        need(self.clock() < self.restore.timestamp(self.plan["window"]["cleanupEnd"]), "CLOSEOUT_DEADLINE")
        exact_account(self.app_read(), self.target)
        exact_firebase(self.firebase_read(), self.target, self.auth_started)
        count = self.session_count()
        need(type(count) is int and count == 0, "SESSION_COUNT")
        return {"appDisabled": True, "firebaseDisabled": True, "tokensRevoked": True, "sessionsAbsent": True}

    def runtime_readback(self):
        deadline = self.restore.timestamp(self.plan["window"]["cleanupEnd"])
        need(self.clock() < deadline, "CLOSEOUT_DEADLINE")
        rp = {**self.plan, "iam": []}
        self.runtime.q = self.qualification
        need(self.runtime.retired(rp, deadline) is True, "RUNTIME_RETIRED")
        revision = self.runtime.cloud(["run", "revisions", "describe", self.restore.CANDIDATE,
                                       "--project=signmons", "--region=us-east5",
                                       "--format=json(spec.serviceAccountName,spec.containers[].image,spec.containers[].env,status.conditions)"], deadline)
        need(isinstance(revision, dict) and isinstance(revision.get("spec"), dict), "REVISION_SHAPE")
        spec = revision["spec"]
        containers = spec.get("containers")
        need(spec.get("serviceAccountName") == self.restore.IDENTITY and isinstance(containers, list) and
             len(containers) == 1 and containers[0].get("image") == self.restore.IMAGE and
             self.restore.digest(containers[0].get("env")) == self.qualification["runtimeEnvironmentSha256"],
             "CANDIDATE_DRIFT")
        need(private_absent(self.private_root, self.plan["operationId"]), "PRIVATE_READBACK")
        need(self.clock() < deadline, "CLOSEOUT_DEADLINE")
        return {"retired": True, "normalTraffic100": True, "sessionsAbsent": True, "privatePlansAbsent": True}


def native():
    raise Stop("P08_NATIVE_CLOSEOUT_DISABLED")


if __name__ == "__main__":
    print("P08_NATIVE_CLOSEOUT_DISABLED")
