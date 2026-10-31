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
    "coordinator": (APP / "p08-live-binder-local-20261029/source/coordinator.py", "1eecc5241794cfed6d892db4385039274539e47b183f1d934899549eb5560f70"),
    "bridge": (APP / "p08-native-bridge-local-20261029/source/bridge.py", "58835555ea5d062bd84af91ace67c71762b9332a2f6fd9bf31ecec08c7a7dfce"),
    "adapter": (APP / "p08-native-closeout-local-20261031/source/adapter.py", "c463671302f8d858d51063e94d7baaa6c0c72a395f505f5fa0a502674d8e532c"),
    "authority": (APP / "p08-coordinator-auth-local-20261031/source/authority.mjs", "0bcd2c7b86cfd98a77bcedb86b5d02735a8bc148f040d4d53d3d80b8e00a9aa5"),
    "sequence": (APP / "p08-coordinator-auth-local-20261031/source/sequence.mjs", "cf8e1d6a7143874871fdf602afc1e8e9bf6afb51724c587d3eef1eb59d792f9c"),
    "client": (APP / "p08-coordinator-auth-local-20261031/source/client.mjs", "0ae21eed01f6d0af2fc5497e825f9c05a5ecd3a0f75476616b04d81054d589c9"),
    "bridge_plan": (APP / "p08-authentication-local-20261026/source/reuse/plan.json", "7e4f1d228944e7cc6c02fa103acceb7fce7cdd6fa907cab4365cc22d6efc4f27"),
}
OWNED_RECEIPT = "owned-receipt.json"
MAX_OUTPUT = 4096
AUTH_FIELDS = {"operationId", "version", "phase", "activationIntent", "firebaseEnableIntent",
               "tokenIssueIntent", "authenticated", "closeoutAttempted", "activatedVersion",
               "disabledVersion", "residuals", "failureStage", "failureCode", "status",
               "sessionClosed"}


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
         set(value.get("files", {})) == {"handoff.py", "child.mjs", "test_handoff.py"}, "MANIFEST_SHAPE")
    for name, expected in value["files"].items():
        if name == "handoff.py":  # The manifest is checked by the tests to avoid a self-hash cycle.
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
            "AUTHENTICATED", "STOPPED", "CLOSEOUT_INTENT", "CLOSEOUT_FINISHED"} and
            type(child.get("authenticated")) is bool and
            type(child.get("closeoutAttempted")) is bool and
            isinstance(child.get("residuals"), list) and
            all(isinstance(x, str) and re.fullmatch(r"[A-Z_]{2,48}", x) for x in child["residuals"]),
            "CHILD_JOURNAL_SHAPE")
        previous = before.get("authClient")
        need((previous is None and child["version"] >= 1) or
             (isinstance(previous, dict) and child["version"] >= previous.get("version", 0) and
              child["operationId"] == previous.get("operationId")), "CHILD_JOURNAL_VERSION")
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
            completed = self.runner([node, str(HERE / "child.mjs"), mode],
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
                                         "P08_COORDINATOR_AUTH_STOPPED_AND_CLOSED"} and \
                result["sessionClosed"] is True and result["residuals"] == [] and \
                child.get("phase") == "CLOSEOUT_FINISHED" and child.get("sessionClosed") is True and \
                child.get("residuals") == []
            return clean
        finally:
            self.receipt_path.unlink()
            need(not self.receipt_path.exists() and not self.receipt_path.is_symlink(), "RECEIPT_PURGE")


def native():
    raise Stop("P08_SERIALIZED_HANDOFF_NATIVE_DISABLED")
