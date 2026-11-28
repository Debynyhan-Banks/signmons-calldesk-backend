"""Disabled Python-to-Node P08 auth handoff. Only synthetic child transports exist."""
from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import stat
import subprocess
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
APP = HERE.parent.parent
LOCKS = {
    "historical_launch": (APP / "p08-authentication-local-20261026/source/auth-launch.mjs", "180346d1874efa61986ea79575407af8669e940ec076639f828bbf2b65c0516a"),
    "historical_adapters": (APP / "p08-authentication-local-20261026/source/auth-adapters.mjs", "ee4906f969ae40e40b4c4a066829afc63257c62a8e9e60fcdbc1ea376b91855a"),
    "serialized_handoff": (APP / "p08-serialized-handoff-local-20261031/source/handoff.py", "9e74e9a25c5a11cb9200c2a5517e6800c0be77e263a4e6312db0806a5d34663e"),
    "coordinator": (APP / "p08-live-binder-local-20261029/source/coordinator.py", "829b0ea7d693862c78a4febd774229ba7c101fba059462476101059bdd86b8ab"),
    "bridge": (APP / "p08-native-bridge-local-20261029/source/bridge.py", "58835555ea5d062bd84af91ace67c71762b9332a2f6fd9bf31ecec08c7a7dfce"),
    "adapter": (APP / "p08-native-closeout-local-20261031/source/adapter.py", "edf593e30a6fe6c147a6a7063a9512da1b9c6300d6cd22d6ab0ccf80070ce4c1"),
    "authority": (APP / "p08-coordinator-auth-local-20261031/source/authority.mjs", "8ab176ba2acbddd591063700eab56161b3589017fe0e2ebaa3bdbf4d3473bbe9"),
    "sequence": (APP / "p08-coordinator-auth-local-20261031/source/sequence.mjs", "cf8e1d6a7143874871fdf602afc1e8e9bf6afb51724c587d3eef1eb59d792f9c"),
    "client": (APP / "p08-coordinator-auth-local-20261031/source/client.mjs", "127a37aa0c1bf3b65b068dc7cebd153a005822a3c015c6635329d957415bfbdd"),
    "bridge_plan": (APP / "p08-authentication-local-20261026/source/reuse/plan.json", "7e4f1d228944e7cc6c02fa103acceb7fce7cdd6fa907cab4365cc22d6efc4f27"),
}
OWNED_RECEIPT = "owned-receipt.json"
MAX_OUTPUT = 4096
AUTH_DIAGNOSTIC_FIELDS = {"authStage", "failureCategory", "httpStatus"}
AUTH_FIELDS = {"operationId", "version", "phase", "activationIntent", "firebaseEnableIntent",
               "tokenIssueIntent", "authenticated", "closeoutAttempted", "activatedVersion",
               "disabledVersion", "residuals", "failureStage", "failureCode", "status",
               "sessionClosed", "revocationIntentAt", "responseValidationCode"} | AUTH_DIAGNOSTIC_FIELDS


AUTHENTICATION_VALIDATIONS = {
    "AUTH_ENTRY": set(),
    "AUTH_IDENTITY_READ": {"BODY_BOUND", "TEXT_DECODE", "JSON_PARSE", "RESPONSE_SHAPE", "PROVIDER_ERROR", "IDENTITY_MISMATCH"},
    "AUTH_IDENTITY_CHECK": {"IDENTITY_MISMATCH", "CLAIMS_MISMATCH"},
    "AUTH_TOKEN_DECODE": {"JSON_PARSE"},
    "AUTH_TOKEN_CHECK": {"RESPONSE_SHAPE", "CLAIMS_MISMATCH", "TOKEN_TIME"},
    "AUTH_RUNTIME_READ": {"BODY_BOUND", "TEXT_DECODE", "JSON_PARSE", "RESPONSE_SHAPE", "JOB_MISMATCH"},
}
AUTHENTICATION_CODES = {"AUTHENTICATION_REFUSED", "INTERRUPTED", "OPERATION_DEADLINE",
    "CLOCK_ROLLBACK", "EXACT_TOKEN_REQUIRED", "TOKEN_CLAIMS_DRIFT", "TOKEN_TIME",
    "AUTH_RUNTIME_REFUSED", "EXACT_JOB_READBACK"}


def authentication_diagnostics(child):
    stage, category = child.get("authStage"), child.get("failureCategory")
    status = child.get("httpStatus")
    if not (type(stage) is str and stage in AUTHENTICATION_VALIDATIONS and
            child.get("failureStage") == "RUNTIME_AUTH_INTENT" and
            type(child.get("failureCode")) is str and child["failureCode"] in AUTHENTICATION_CODES and
            child.get("authenticated") is False and type(category) is str and
            category in {"TIMEOUT", "TRANSPORT", "HTTP", "RESPONSE_VALIDATION", "GUARD", "UNKNOWN"}):
        return False
    if category in {"TIMEOUT", "TRANSPORT", "HTTP"} and stage not in {"AUTH_IDENTITY_READ", "AUTH_RUNTIME_READ"}:
        return False
    if status is not None and not (category == "HTTP" and type(status) is int and 100 <= status <= 599):
        return False
    if category == "RESPONSE_VALIDATION":
        value = child.get("responseValidationCode")
        if type(value) is not str or value not in AUTHENTICATION_VALIDATIONS[stage]:
            return False
    elif "responseValidationCode" in child:
        return False
    exact = {"EXACT_TOKEN_REQUIRED": ("AUTH_ENTRY", "GUARD", None),
             "TOKEN_CLAIMS_DRIFT": ("AUTH_TOKEN_CHECK", "RESPONSE_VALIDATION", "CLAIMS_MISMATCH"),
             "TOKEN_TIME": ("AUTH_TOKEN_CHECK", "RESPONSE_VALIDATION", "TOKEN_TIME"),
             "AUTH_RUNTIME_REFUSED": ("AUTH_RUNTIME_READ", "HTTP", None),
             "EXACT_JOB_READBACK": ("AUTH_RUNTIME_READ", "RESPONSE_VALIDATION", "JOB_MISMATCH")}
    if child.get("failureCode") in exact:
        return (stage, category, child.get("responseValidationCode")) == exact[child["failureCode"]]
    return True


class Stop(Exception):
    pass


def need(value, code):
    if not value:
        raise Stop(code)


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def verify_sources():
    for path, expected in LOCKS.values():
        need(path.is_file() and not path.is_symlink() and hashlib.sha256(path.read_bytes()).hexdigest() == expected,
             "SOURCE_DRIFT")
    manifest = HERE / "source-manifest.json"
    need(manifest.is_file() and not manifest.is_symlink(), "MANIFEST_ABSENT")
    value = json.loads(manifest.read_text())
    need(value.get("status") == "DISABLED_LOCAL_ONLY" and
         value.get("sourceLocks") == {k: v[1] for k, v in LOCKS.items()} and
         set(value.get("files", {})) == {"bound_handoff.py", "bound-child.mjs", "bound-clients.mjs", "recovery-sequence.mjs", "test_bound.py", "test_bound.mjs"}, "MANIFEST_SHAPE")
    for name, expected in value["files"].items():
        if name == "bound_handoff.py":  # The manifest is checked by the tests to avoid a self-hash cycle.
            continue
        path = HERE / name
        need(path.is_file() and not path.is_symlink() and hashlib.sha256(path.read_bytes()).hexdigest() == expected,
             "HANDOFF_SOURCE_DRIFT")
    return True


def private_file(path):
    need(path.is_file() and not path.is_symlink() and stat.S_IMODE(path.lstat().st_mode) == 0o600,
         "PRIVATE_FILE")
    return json.loads(path.read_text())


def write_exclusive(path, value):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        os.write(fd, json.dumps(value, sort_keys=True, separators=(",", ":")).encode())
    finally:
        os.close(fd)


class Handoff:
    def __init__(self, plan, approval, target, directory, clock=time.time, runner=subprocess.run,
                 scenario="normal"):
        verify_sources()
        need(plan.get("mode") == "LOCAL_INTEGRATED_PACKET_ONLY" and
             plan.get("externalActionAuthorized") is False and approval == {
                 "decision": "APPROVE_LOCAL_SINGLE_COORDINATOR", "externalActionAuthorized": False,
                 "operationId": plan.get("operationId"), "planSha256": digest(plan)}, "LOCAL_APPROVAL")
        need(scenario in {"normal", "lost_output", "lost_activation", "session_failure", "hang", "exit"},
             "SCENARIO_SCOPE")
        self.plan, self.approval, self.target = plan, approval, target
        self.dir, self.clock, self.runner, self.scenario = Path(directory), clock, runner, scenario
        need(str(self.dir) == "/private/tmp/p08-coordinator-" + plan["operationId"] and
             self.dir.is_dir() and not self.dir.is_symlink() and
             stat.S_IMODE(self.dir.stat().st_mode) == 0o700, "PRIVATE_ROOT")
        self.coordinator = None
        self.receipt_path = self.dir / OWNED_RECEIPT
        self.bridge_plan = json.loads(LOCKS["bridge_plan"][0].read_text())
        self.runtime = {"origin": self.bridge_plan["origin"], "jobId": plan["jobId"],
                        "tenantId": plan["tenantId"], "revocationRequired": True,
                        "devAuthEnabled": False, "identityQualified": True,
                        "restorationApproved": True, "serviceAccount": plan["runtimeIdentity"]}

    def attach(self, coordinator):
        need(self.coordinator is None and coordinator.plan == self.plan and
             coordinator.dir == self.dir, "COORDINATOR_SCOPE")
        self.coordinator = coordinator

    def _journal(self):
        need(self.coordinator is not None, "COORDINATOR_UNBOUND")
        path = self.dir / "journal.json"
        value = private_file(path)
        need(value.get("operationId") == self.plan["operationId"] and
             value.get("planSha256") == digest(self.plan) and value.get("authAttempted") is True,
             "JOURNAL_SCOPE")
        return value

    def _merge_child(self, before):
        after = self._journal()
        base = lambda value: {k: v for k, v in value.items() if k != "authClient"}
        need(base(after) == base(before), "JOURNAL_PARENT_DRIFT")
        need(not (self.dir / "journal.json.auth-next").exists() and
             not (self.dir / "journal.json.auth-next").is_symlink(), "JOURNAL_TEMP_REMAINS")
        child = after.get("authClient")
        need(isinstance(child, dict) and child.get("operationId") == self.plan["operationId"] and
             isinstance(child.get("version"), int) and child["version"] > 0, "CHILD_JOURNAL_ABSENT")
        need(set(child) <= AUTH_FIELDS and child.get("phase") in {
            "START", "ACTIVATE_INTENT", "ACTIVATED", "ENABLE_INTENT", "TOKEN_INTENT",
            "RUNTIME_AUTH_INTENT", "AUTHENTICATED", "PAYMENT_HANDOFF_INTENT",
            "STOPPED", "CLOSEOUT_INTENT", "CLOSEOUT_FINISHED"} and
            type(child.get("authenticated")) is bool and
            type(child.get("closeoutAttempted")) is bool and
            isinstance(child.get("residuals"), list) and
            all(isinstance(x, str) and re.fullmatch(r"[A-Z_]{2,48}", x) for x in child["residuals"]),
            "CHILD_JOURNAL_SHAPE")
        diagnostics = set(child) & AUTH_DIAGNOSTIC_FIELDS
        runtime_diagnostics = child.get("authStage") in AUTHENTICATION_VALIDATIONS if type(child.get("authStage")) is str else False
        if child.get("failureCode") == "AUTHENTICATION_REFUSED":
            need(runtime_diagnostics and diagnostics == AUTH_DIAGNOSTIC_FIELDS, "CHILD_JOURNAL_SHAPE")
        if runtime_diagnostics:
            need(diagnostics == AUTH_DIAGNOSTIC_FIELDS and authentication_diagnostics(child), "CHILD_JOURNAL_SHAPE")
        elif diagnostics:
            need(diagnostics == AUTH_DIAGNOSTIC_FIELDS and
                 child.get("failureCode") == "SIGN_EXCHANGE_REFUSED" and
                 type(child.get("authStage")) is str and
                 child["authStage"] in {"SIGN", "KEY_READ", "EXCHANGE", "UNKNOWN"} and
                 type(child.get("failureCategory")) is str and
                 child["failureCategory"] in {"TRANSPORT", "HTTP", "RESPONSE_VALIDATION", "UNKNOWN"} and
                 (child.get("httpStatus") is None or
                  (type(child["httpStatus"]) is int and 100 <= child["httpStatus"] <= 599)) and
                 (child["failureCategory"] == "HTTP" or child["httpStatus"] is None),
                 "CHILD_JOURNAL_SHAPE")
        previous = before.get("authClient")
        need((previous is None and child["version"] >= 1) or
             (isinstance(previous, dict) and child["version"] >= previous.get("version", 0) and
              child["operationId"] == previous.get("operationId")), "CHILD_JOURNAL_VERSION")
        if "responseValidationCode" in child and not runtime_diagnostics:
            need(diagnostics == AUTH_DIAGNOSTIC_FIELDS and
                 child.get("failureCode") == "SIGN_EXCHANGE_REFUSED" and
                 child.get("failureCategory") == "RESPONSE_VALIDATION" and
                 child.get("authStage") in {"SIGN", "KEY_READ", "EXCHANGE"} and
                 type(child["responseValidationCode"]) is str and
                 (child["responseValidationCode"] in {"BODY_BOUND", "JSON_PARSE", "RESPONSE_SHAPE", "PROVIDER_ERROR"} or
                  (child["authStage"] == "SIGN" and child["responseValidationCode"] == "SIGN_RESPONSE_SHAPE") or
                  (child["authStage"] == "KEY_READ" and child["responseValidationCode"] == "KEY_RESPONSE_MISMATCH") or
                  (child["authStage"] == "EXCHANGE" and child["responseValidationCode"] == "EXCHANGE_RESPONSE_MISMATCH")),
                 "CHILD_JOURNAL_SHAPE")
        self.coordinator.j["authClient"] = child
        return child

    def _request(self, receipt, mode):
        need(receipt.get("operationId") == self.plan["operationId"] and
             receipt.get("createdInOperation") is True and receipt.get("deleted") is False and
             receipt.get("keyResource") ==
             f"projects/{self.plan['projectNumber']}/locations/global/keys/{self.plan['keyId']}",
             "OWNED_RECEIPT_SCOPE")
        from datetime import datetime, timezone
        now = datetime.fromtimestamp(self.clock(), timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        return {"approval": self.approval, "fixtureNow": now,
                "journalPath": str(self.dir / "journal.json"), "localOnly": True,
                "plan": self.plan, "receipt": receipt, "runtime": self.runtime,
                "scenario": self.scenario if mode == "--fixture-auth" else "normal",
                "target": self.target}

    def _child(self, receipt, mode):
        before = self._journal()
        request = self._request(receipt, mode)
        deadline = self.plan["window"]["workEnd" if mode == "--fixture-auth" else "cleanupEnd"]
        from datetime import datetime
        seconds = datetime.fromisoformat(deadline.replace("Z", "+00:00")).timestamp() - self.clock()
        need(seconds > 0, "CHILD_DEADLINE")
        node = shutil.which("node")
        need(node and Path(node).is_file(), "NODE_REQUIRED")
        error = None
        try:
            completed = self.runner([node, str(HERE / "bound-child.mjs"), mode],
                                    input=json.dumps(request, sort_keys=True, separators=(",", ":")),
                                    text=True, capture_output=True, timeout=min(seconds, 8),
                                    env={"PATH": "/usr/bin:/bin:/opt/homebrew/bin", "LANG": "C"})
        except subprocess.TimeoutExpired:
            completed = None
            error = "CHILD_TIMEOUT"
        except BaseException:
            completed = None
            error = "CHILD_EXIT_UNKNOWN"
        child = self._merge_child(before) if (self.dir / "journal.json").exists() and "authClient" in private_file(self.dir / "journal.json") else None
        if error:
            raise Stop(error)
        need(completed is not None and completed.returncode == 0 and
             isinstance(completed.stdout, str) and 0 < len(completed.stdout.encode()) <= MAX_OUTPUT and
             completed.stderr == "", "CHILD_OUTPUT")
        try:
            result = json.loads(completed.stdout)
        except ValueError:
            raise Stop("CHILD_OUTPUT") from None
        need(isinstance(result, dict) and set(result) == {"status", "authenticated", "residuals",
                                                         "sessionClosed", "liveAuthorization", "authProofReady"} and
             result["liveAuthorization"] is False and result["authProofReady"] is False and
             type(result["authenticated"]) is bool and type(result["sessionClosed"]) is bool and
             isinstance(result["residuals"], list) and all(isinstance(x, str) for x in result["residuals"]),
             "CHILD_RESULT_SHAPE")
        need(child is not None, "CHILD_JOURNAL_ABSENT")
        return result, child

    def __call__(self, receipt):
        self._request(receipt, "--fixture-auth")
        need(not self.receipt_path.exists() and not self.receipt_path.is_symlink(), "RECEIPT_RESERVED")
        write_exclusive(self.receipt_path, receipt)
        result, child = self._child(receipt, "--fixture-auth")
        need(result["status"] == "P08_COORDINATOR_AUTHENTICATED_AND_CLOSED" and
             result["authenticated"] is True and result["sessionClosed"] is True and
             result["residuals"] == [] and child.get("phase") == "CLOSEOUT_FINISHED" and
             child.get("status") == result["status"] and child.get("residuals") == [],
             "AUTH_OUTCOME_UNKNOWN")
        self.receipt_path.unlink()
        need(not self.receipt_path.exists(), "RECEIPT_PURGE")
        return {"status": "P08_OPERATOR_AUTHENTICATED_AND_CLOSED", "authenticated": True,
                "sessionsAbsent": True, "residuals": [],
                "liveAuthorization": False, "authProofReady": False}

    def closeout_only(self):
        receipt = private_file(self.receipt_path)
        try:
            result, child = self._child(receipt, "--fixture-closeout")
            clean = result["status"] in {"P08_COORDINATOR_AUTH_CLEANUP_VERIFIED",
                                         "P08_COORDINATOR_AUTH_STOPPED_AND_CLOSED",
                                         "P08_COORDINATOR_AUTHENTICATED_AND_CLOSED"} and \
                result["sessionClosed"] is True and result["residuals"] == [] and \
                child.get("phase") == "CLOSEOUT_FINISHED" and child.get("sessionClosed") is True and \
                child.get("residuals") == []
            return clean
        finally:
            self.receipt_path.unlink()
            need(not self.receipt_path.exists() and not self.receipt_path.is_symlink(), "RECEIPT_PURGE")


def native():
    raise Stop("P08_REAL_CLIENT_BINDING_NATIVE_DISABLED")
