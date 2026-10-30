"""Disabled, injected-only P08 lifecycle coordinator. No native entry or credentials."""
from __future__ import annotations

import hashlib
import importlib.util
import json
import os
import signal
import stat
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent
LOCKS = {
    "bridge": (ROOT.parent.parent / "p08-native-bridge-local-20261029/source/bridge.py", "58835555ea5d062bd84af91ace67c71762b9332a2f6fd9bf31ecec08c7a7dfce"),
    "restore": (ROOT.parent.parent / "p08-restoration-local-20261028/source/restore.py", "a0bf4bc90cca0bd52935915d710ccb44e065dd3deed841a12ab49cb3ac4a1cb9"),
    "auth": (ROOT / "auth/auth-handoff.mjs", "252e88f5659b7e5f3f8e4d0cabf5b5b06a1a90902ec66df6c230026aa992aec5"),
}


class Stop(Exception):
    pass


def need(value, code):
    if not value:
        raise Stop(code)


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def sources():
    for path, expected in LOCKS.values():
        need(path.is_file() and not path.is_symlink() and hashlib.sha256(path.read_bytes()).hexdigest() == expected, "SOURCE_DRIFT")
    out = {}
    for name in ("bridge", "restore"):
        spec = importlib.util.spec_from_file_location("p08_coordinator_" + name, LOCKS[name][0])
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        out[name] = module
    out["bridge"].verify_bundle()
    out["restore"].check_sources()
    return out


def private_directory(directory):
    path = Path(directory)
    need(path.is_dir() and not path.is_symlink() and stat.S_IMODE(path.stat().st_mode) == 0o700, "PRIVATE_DIRECTORY")
    return path


def private_file(path):
    need(path.is_file() and not path.is_symlink() and stat.S_IMODE(path.stat().st_mode) == 0o600, "PRIVATE_FILE")
    return json.loads(path.read_text())


def reserve(path, value):
    fd = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    try:
        os.write(fd, json.dumps(value, sort_keys=True).encode())
    finally:
        os.close(fd)


def authorize(plan, approval, modules, now, closeout=False):
    bridge, restore = modules["bridge"], modules["restore"]
    need(plan.get("mode") == "LOCAL_INTEGRATED_PACKET_ONLY" and plan.get("externalActionAuthorized") is False, "LOCAL_ONLY")
    need(plan.get("automaticRetryAllowed") is False and plan.get("allowanceUsd") == 0, "RETRY_OR_COST")
    need(plan.get("serviceRetention") == "RETAIN_ENABLED_AFTER_KEY_DELETE", "SERVICE_RETENTION")
    need(plan.get("project") == "signmons" and plan.get("jobId") == restore.JOB and plan.get("tenantId") == restore.TENANT, "BUSINESS_SCOPE")
    need(plan.get("ownerPrincipal") == restore.OWNER and plan.get("runtimeIdentity") == restore.IDENTITY, "IDENTITY_SCOPE")
    need(plan.get("projectNumberSha256") == hashlib.sha256(str(plan.get("projectNumber", "")).encode()).hexdigest(), "PROJECT_BINDING")
    need(plan.get("keyId") == "signmons-p08-" + plan.get("operationId", "").replace("-", ""), "KEY_SCOPE")
    need(approval == {"decision": "APPROVE_LOCAL_SINGLE_COORDINATOR", "externalActionAuthorized": False,
                      "operationId": plan.get("operationId"), "planSha256": digest(plan)}, "LOCAL_APPROVAL")
    times = {k: restore.timestamp(plan["window"][k]) for k in ("start", "cutoff", "workEnd", "cleanupEnd", "purgeEnd")}
    need(times["start"] < times["cutoff"] < times["workEnd"] < times["cleanupEnd"] < times["purgeEnd"], "WINDOW_ORDER")
    need(times["purgeEnd"] - times["start"] <= 3600 and times["cleanupEnd"] - times["workEnd"] >= 600, "WINDOW_BOUNDS")
    need(times["start"] <= now < times["cleanupEnd" if closeout else "cutoff"], "START_CUTOFF")
    bridge.Ports(plan, lambda _: None, lambda _: None, lambda _: None, lambda: None, lambda: None, lambda: now)
    return times


class Coordinator:
    def __init__(self, plan, approval, qualification, runtime, access, directory, clock=time.time, closeout=False):
        self.modules = sources()
        self.clock, self.plan, self.qualification = clock, plan, qualification
        self.times = authorize(plan, approval, self.modules, clock(), closeout)
        self.runtime, self.access = runtime, access
        need(all(callable(getattr(runtime, name, None)) for name in ("preflight", "change", "readback", "retired", "close_authentication")), "RUNTIME_PORT")
        need(all(callable(getattr(access, name, None)) for name in (
            "preflight", "bind", "binding_state", "unbind", "stage_a", "api_keys_state", "enable_api_keys",
            "key_get", "key_create", "key_delete", "authenticate", "account_closeout", "runtime_closeout")), "ACCESS_PORT")
        self.dir = private_directory(directory)
        self.last, self.abort = clock(), False
        self.j = {"operationId": plan["operationId"], "planSha256": digest(plan), "phase": "PREPARED",
                  "runtimeAttempted": [], "runtimeOwned": [], "runtimeCleanupAttempted": [],
                  "iamAttempted": [], "iamOwned": [], "iamCleanupAttempted": [],
                  "serviceEnableAttempted": False, "keyCreateAttempted": False, "keyUidSha256": None,
                  "keyDeleteAttempted": False, "authAttempted": False, "childResultSha256": None,
                  "authProofAccepted": False, "failure": None, "unknown": [], "residuals": []}

    def save(self):
        temp = self.dir / "journal-next.json"
        reserve(temp, self.j)
        os.replace(temp, self.dir / "journal.json")

    def gate(self, cleanup=False):
        now = self.clock()
        need(now >= self.last, "CLOCK_ROLLBACK")
        self.last = now
        need(now < self.times["cleanupEnd" if cleanup else "workEnd"], "DEADLINE")
        need(cleanup or not self.abort, "INTERRUPTED")

    def invoke(self, method, *args, owner, cleanup=False):
        self.gate(cleanup)
        deadline = self.times["cleanupEnd" if cleanup else "workEnd"]
        value = getattr(owner, method)(*args, deadline=deadline) if owner is self.runtime else getattr(owner, method)(*args)
        self.gate(cleanup)
        return value

    def runtime_plan(self):
        return {**self.plan, "iam": []}

    def key_metadata(self, value, deleted):
        bridge = self.modules["bridge"]
        need(isinstance(value, dict) and value.get("name") == self.access.key_resource, "KEY_IDENTITY")
        need(value.get("displayName") == "Signmons P08 " + self.plan["operationId"] and
             value.get("restrictions") == bridge.packet.module("key").RESTRICTIONS and
             value.get("deleted") is deleted, "KEY_OWNERSHIP")
        need(isinstance(value.get("uid"), str) and value["uid"] and isinstance(value.get("etag"), str) and value["etag"], "KEY_METADATA")
        return hashlib.sha256(value["uid"].encode()).hexdigest()

    def run(self):
        reserve(self.dir / "attempt.json", {"operationId": self.plan["operationId"], "planSha256": digest(self.plan)})
        previous = {s: signal.getsignal(s) for s in (signal.SIGINT, signal.SIGTERM)}
        for sig in previous:
            signal.signal(sig, lambda *_: setattr(self, "abort", True))
        try:
            self.save()
            rp = self.runtime_plan()
            need(self.invoke("preflight", rp, self.qualification, owner=self.runtime) is True, "RUNTIME_PREFLIGHT")
            pre = self.invoke("preflight", owner=self.access)
            need(pre["bindingsAbsent"] is True and pre["apiKeysService"] in ("ENABLED", "DISABLED"), "ACCESS_PREFLIGHT")
            roles = self.modules["bridge"].packet.module("roles").ROLES
            need(len(pre["roles"]) == len(roles) == 2 and all(
                self.modules["bridge"].packet.module("roles").definition_shape(v, role) in
                ("EXACT_ACTIVE_EXPLICIT", "EXACT_ACTIVE_DEFAULTED") for v, role in zip(pre["roles"], roles)), "ROLE_DRIFT")
            self.j["phase"] = "PREFLIGHT"; self.save()
            for kind, name in self.modules["restore"].operations(rp):
                self.j["runtimeAttempted"].append([kind, name]); self.save()
                try:
                    self.invoke("change", kind, name, True, rp, owner=self.runtime)
                except BaseException:
                    self.j["unknown"].append("RUNTIME:" + kind + ":" + name); self.save(); raise
                need(self.invoke("readback", kind, name, True, rp, owner=self.runtime) is True, "RUNTIME_READBACK")
                self.j["runtimeOwned"].append([kind, name]); self.save()
            for role in roles:
                kind = role["kind"]
                self.j["iamAttempted"].append(kind); self.save()
                try:
                    self.invoke("bind", kind, role["name"], owner=self.access)
                except BaseException:
                    self.j["unknown"].append("IAM:" + kind); self.save(); raise
                need(self.invoke("binding_state", kind, owner=self.access) == "OWNED", "IAM_READBACK")
                self.j["iamOwned"].append(kind); self.save()
            tuples = [list(x) for x in self.modules["bridge"].packet.module("stage_a").TUPLES]
            need(self.invoke("stage_a", tuples, owner=self.access) == ["CAN_ACCESS"] * 4, "DIAGNOSTIC_DENIED")
            if pre["apiKeysService"] == "DISABLED":
                self.j["serviceEnableAttempted"] = True; self.save()
                try: self.invoke("enable_api_keys", owner=self.access)
                except BaseException:
                    self.j["unknown"].append("SERVICE_ENABLE"); self.save(); raise
            need(self.invoke("api_keys_state", owner=self.access) == "ENABLED", "SERVICE_READBACK")
            need(self.invoke("key_get", owner=self.access) == "NOT_FOUND", "KEY_COLLISION")
            self.j["keyCreateAttempted"] = True; self.save()
            try:
                key = self.invoke("key_create", self.access.key_resource,
                                  self.modules["bridge"].packet.module("key").RESTRICTIONS, owner=self.access)
            except BaseException:
                self.j["unknown"].append("KEY_CREATE"); self.save(); raise
            uid = self.key_metadata(key, False)
            need(self.key_metadata(self.invoke("key_get", owner=self.access), False) == uid, "KEY_READBACK")
            self.j["keyUidSha256"] = uid; self.save()
            self.j["authAttempted"] = True; self.save()
            proof = self.invoke("authenticate", self.access.key_resource, owner=self.access)
            self.j["childResultSha256"] = digest(proof) if isinstance(proof, dict) else None; self.save()
            need(proof == self.modules["bridge"].packet.AUTH_PROOF, "AUTH_PROOF_REFUSED")
            self.j["authProofAccepted"] = True; self.save()
            self.j["phase"] = "AUTH_PROOF_LOCAL"; self.save()
        except BaseException as error:
            self.j["failure"] = str(error) if isinstance(error, Stop) else "LOCAL_ADAPTER_OR_SOURCE_STOP"
            try: self.save()
            except BaseException: self.j["unknown"].append("JOURNAL_PERSISTENCE")
        finally:
            for sig, handler in previous.items(): signal.signal(sig, handler)
        return self.closeout()

    def closeout(self, independent=False):
        reserve(self.dir / ("independent-closeout.json" if independent else "closeout.json"),
                {"operationId": self.plan["operationId"]})
        if independent:
            self.j = private_file(self.dir / "journal.json")
            need(self.j.get("operationId") == self.plan["operationId"] and self.j.get("planSha256") == digest(self.plan), "FOREIGN_JOURNAL")
            expected = [list(x) for x in self.modules["restore"].operations(self.runtime_plan())]
            need(self.j.get("runtimeAttempted") == expected[:len(self.j.get("runtimeAttempted", []))], "JOURNAL_SCOPE")
            need(self.j.get("iamAttempted") in ([], ["lookup"], ["lookup", "signing"]), "JOURNAL_IAM_SCOPE")
        residual = list(self.j["unknown"])
        def check(label, fn):
            try: need(fn() is True, "CLOSEOUT_READBACK")
            except BaseException: residual.append(label)
        if self.j["authAttempted"]:
            if not self.j["authProofAccepted"]:
                check("AUTH_REVOKE", lambda: self.invoke("close_authentication", self.runtime_plan(), owner=self.runtime, cleanup=True))
            check("ACCOUNT_SESSION", lambda: self.invoke("account_closeout", owner=self.access, cleanup=True))
            if self.j["childResultSha256"] is None: residual.append("AUTH_OUTCOME_UNKNOWN")
        if self.j["keyCreateAttempted"]:
            def key_close():
                need(self.j["keyUidSha256"] is not None, "KEY_CREATE_UNKNOWN")
                current = self.invoke("key_get", owner=self.access, cleanup=True)
                need(self.key_metadata(current, current.get("deleted") is True) == self.j["keyUidSha256"], "KEY_DRIFT")
                if current["deleted"] is True: return True
                need(not self.j["keyDeleteAttempted"], "KEY_DELETE_UNCERTAIN")
                self.j["keyDeleteAttempted"] = True; self.save()
                self.invoke("key_delete", current["etag"], owner=self.access, cleanup=True)
                return self.key_metadata(self.invoke("key_get", owner=self.access, cleanup=True), True) == self.j["keyUidSha256"]
            check("OWNED_KEY", key_close)
        for kind in reversed(self.j["iamAttempted"]):
            def iam_close(kind=kind):
                state = self.invoke("binding_state", kind, owner=self.access, cleanup=True)
                need(state in ("ABSENT", "OWNED"), "IAM_DRIFT")
                if state == "ABSENT": return True
                need(kind not in self.j["iamCleanupAttempted"], "IAM_REMOVE_UNCERTAIN")
                self.j["iamCleanupAttempted"].append(kind); self.save()
                self.invoke("unbind", kind, owner=self.access, cleanup=True)
                return self.invoke("binding_state", kind, owner=self.access, cleanup=True) == "ABSENT"
            check("IAM_" + kind, iam_close)
        for kind, name in reversed(self.j["runtimeAttempted"]):
            def runtime_close(kind=kind, name=name):
                item = [kind, name]
                if item in self.j["runtimeCleanupAttempted"]:
                    return self.invoke("readback", kind, name, False, self.runtime_plan(), owner=self.runtime, cleanup=True) is True
                self.j["runtimeCleanupAttempted"].append(item); self.save()
                self.invoke("change", kind, name, False, self.runtime_plan(), owner=self.runtime, cleanup=True)
                return self.invoke("readback", kind, name, False, self.runtime_plan(), owner=self.runtime, cleanup=True) is True
            check("RUNTIME_" + kind + ":" + name, runtime_close)
        check("RUNTIME_FINAL", lambda: self.invoke("retired", self.runtime_plan(), owner=self.runtime, cleanup=True))
        check("TRAFFIC_PRIVATE_PLANS", lambda: self.invoke("runtime_closeout", owner=self.access, cleanup=True))
        if self.j["serviceEnableAttempted"]:
            check("SERVICE_RETAINED", lambda: self.invoke("api_keys_state", owner=self.access, cleanup=True) == "ENABLED")
        self.j["phase"] = "CLOSED"; self.j["residuals"] = sorted(set(residual)); self.save()
        return {"status": "LOCAL_COORDINATOR_CLOSED" if not residual else "LOCAL_COORDINATOR_CONTAINMENT_UNCONFIRMED",
                "liveAuthorization": False, "authProofReady": False, "residuals": self.j["residuals"],
                "failure": self.j["failure"], "childResultSha256": self.j["childResultSha256"]}


def native():
    raise Stop("LOCAL_COORDINATOR_NATIVE_DISABLED")


if __name__ == "__main__":
    print("P08_LOCAL_COORDINATOR_NATIVE_DISABLED")
