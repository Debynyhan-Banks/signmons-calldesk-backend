"""Disabled, injected-only P08 access/authentication composition proof."""
from __future__ import annotations

import datetime as dt
import hashlib
import importlib.util
import json
import os
import re
import signal
import stat
import time
import uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parent
EVIDENCE = ROOT.parent.parent
PROJECT = "signmons"
TENANT = "a1adcfd4-15be-404b-9ac3-5edb1fda20f0"
JOB = "9180bef4-561d-47a0-869f-925e6a3dfd96"
OWNER = "debynyhan@signmons.com"
IDENTITY = "signmons-calldesk-p07-runtime@signmons.iam.gserviceaccount.com"
SOURCES = {
    "roles": ("p08-exact-role-provisioning-local-20261028/source/role_provisioner.py", "e1fbc15d95450da7662db684e2cfe6f063c8a60fd7c8243053e5431fc3f973f9"),
    "restore": ("p08-restoration-local-20261028/source/restore.py", "a0bf4bc90cca0bd52935915d710ccb44e065dd3deed841a12ab49cb3ac4a1cb9"),
    "stage_a": ("p08-access-sequence-local-20261028/source/diagnostics_stage.py", "483b27f06ce844632e7bd2b43198920e88307c52d18f94b1b2b6d8ee979526d3"),
    "key": ("p08-access-resolution-local-20261028/source/access_readiness.py", "d54334352529e3aa4d3717be6b1c6f840ec284d3b83a9a3aaeb5053fa7547576"),
    "key_restore": ("p08-access-resolution-local-20261028/source/reuse/restore.py", "a0bf4bc90cca0bd52935915d710ccb44e065dd3deed841a12ab49cb3ac4a1cb9"),
    "role_check": ("p08-role-contract-local-20261029/source/qualification_launch.py", "76722d3265cda655b6b2433bc83d3bbcee06c12c6d0f66c07cad9fe2ae2e7e18"),
    "auth_controller": ("p08-authentication-local-20261026/source/auth-controller.mjs", "57ab0853630112145e81e10143b05099b2a446f7f450d0eff4598540528ef0c4"),
    "auth_adapters": ("p08-authentication-local-20261026/source/auth-adapters.mjs", "ee4906f969ae40e40b4c4a066829afc63257c62a8e9e60fcdbc1ea376b91855a"),
}
AUTH_PROOF = {"status": "P08_OPERATOR_AUTHENTICATED_AND_CLOSED", "authenticated": True,
              "sessionsAbsent": True, "privateMetadataAbsent": True,
              "privateMetadataPurgeOnTime": True, "residuals": []}


class Stop(Exception):
    pass


def need(value, code):
    if not value:
        raise Stop(code)


def digest(value):
    raw = value if isinstance(value, bytes) else json.dumps(value, sort_keys=True, separators=(",", ":")).encode()
    return hashlib.sha256(raw).hexdigest()


def reserve(path, value):
    fd = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    try:
        os.write(fd, json.dumps(value, sort_keys=True).encode())
    finally:
        os.close(fd)


def module(name):
    relative, expected = SOURCES[name]
    path = EVIDENCE / relative
    need(path.is_file() and not path.is_symlink() and digest(path.read_bytes()) == expected, "SOURCE_DRIFT")
    spec = importlib.util.spec_from_file_location("p08_integrated_" + name, path)
    need(spec is not None and spec.loader is not None, "SOURCE_DRIFT")
    loaded = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(loaded)
    return loaded


def verify_sources():
    for relative, expected in SOURCES.values():
        path = EVIDENCE / relative
        need(path.is_file() and not path.is_symlink() and digest(path.read_bytes()) == expected, "SOURCE_DRIFT")
    manifest_path = ROOT / "source-manifest.json"
    need(manifest_path.is_file() and not manifest_path.is_symlink(), "MANIFEST_ABSENT")
    manifest = json.loads(manifest_path.read_text())
    need(manifest.get("status") == "DISABLED_LOCAL_ONLY", "MANIFEST_STATUS")
    need(manifest.get("lockedSources") == {name: value[1] for name, value in SOURCES.items()}, "MANIFEST_SOURCE_DRIFT")
    for name, expected in manifest.get("files", {}).items():
        path = ROOT / name
        need(name in ("packet.py", "test_packet.py") and path.is_file() and not path.is_symlink() and digest(path.read_bytes()) == expected, "MANIFEST_FILE_DRIFT")
    need(set(manifest.get("files", {})) == {"packet.py", "test_packet.py"}, "MANIFEST_FILES")
    roles, restore, stage_a, key = (module(name) for name in ("roles", "restore", "stage_a", "key"))
    need([role["name"] for role in roles.ROLES] == [
        "projects/signmons/roles/signmonsP08FirebaseUserLookup",
        "projects/signmons/roles/signmonsP08ServiceAccountSignBlob",
    ], "ROLE_CONTRACT")
    need(stage_a.TUPLES == tuple(stage_a.TUPLES) and len(stage_a.TUPLES) == 4, "DIAGNOSTIC_CONTRACT")
    need(key.RESTRICTIONS == {"apiTargets": [{"service": "identitytoolkit.googleapis.com"}]}, "KEY_RESTRICTIONS")
    return roles, restore, stage_a, key


def timestamp(value):
    need(isinstance(value, str) and re.fullmatch(r"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ", value), "UTC_FORMAT")
    return dt.datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()


def authorize(plan, now):
    need(plan.get("mode") == "LOCAL_INTEGRATED_PACKET_ONLY" and plan.get("externalActionAuthorized") is False, "LOCAL_ONLY")
    need(plan.get("automaticRetryAllowed") is False and plan.get("allowanceUsd") == 0, "RETRY_OR_COST")
    need(plan.get("project") == PROJECT and plan.get("tenantId") == TENANT and plan.get("jobId") == JOB, "BUSINESS_SCOPE")
    need(plan.get("ownerPrincipal") == OWNER and plan.get("runtimeIdentity") == IDENTITY, "IDENTITY_SCOPE")
    need(plan.get("serviceRetention") == "UNDECIDED_REFUSE_LIVE", "SERVICE_DECISION")
    try:
        valid_id = isinstance(plan.get("operationId"), str) and str(uuid.UUID(plan["operationId"])) == plan["operationId"]
    except (ValueError, AttributeError):
        valid_id = False
    need(valid_id, "OPERATION_ID")
    need(plan.get("keyId") == "signmons-p08-" + plan["operationId"].replace("-", ""), "KEY_SCOPE")
    times = {name: timestamp(plan.get("window", {}).get(name)) for name in ("start", "cutoff", "workEnd", "cleanupEnd")}
    need(times["start"] <= now < times["cutoff"] < times["workEnd"] < times["cleanupEnd"], "START_CUTOFF")
    need(times["cleanupEnd"] - times["workEnd"] >= 600 and times["cleanupEnd"] - times["start"] <= 3600, "WINDOW_BOUNDS")
    return times


class Packet:
    """Port methods are injected; this package has no native credential or network transport."""
    def __init__(self, plan, ports, directory, clock=time.time):
        self.roles, self.restore, self.stage_a, self.key = verify_sources()
        self.plan, self.ports, self.directory, self.clock = plan, ports, Path(directory), clock
        self.times = authorize(plan, clock())
        need(self.directory.is_dir() and not self.directory.is_symlink() and stat.S_IMODE(self.directory.stat().st_mode) == 0o700, "PRIVATE_DIRECTORY")
        self.last = clock()
        self.abort = False
        self.journal = {"operationId": plan["operationId"], "planSha256": digest(plan), "phase": "PREPARED",
                        "bindAttempted": [], "bindOwned": [], "unbindAttempted": [], "serviceInitial": None,
                        "serviceEnableAttempted": False, "keyCreateAttempted": False, "keyUidSha256": None,
                        "keyDeleteAttempted": False, "authAttempted": False, "authenticated": False,
                        "failure": None, "residuals": []}

    def save(self):
        temp = self.directory / "journal-next.json"
        fd = os.open(temp, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        try:
            os.write(fd, json.dumps(self.journal, sort_keys=True).encode())
        finally:
            os.close(fd)
        os.replace(temp, self.directory / "journal.json")

    def gate(self, cleanup=False):
        now = self.clock()
        need(now >= self.last, "CLOCK_ROLLBACK")
        self.last = now
        need(now < self.times["cleanupEnd" if cleanup else "workEnd"], "DEADLINE")
        need(cleanup or not self.abort, "INTERRUPTED")

    def call(self, name, *args, cleanup=False):
        self.gate(cleanup)
        value = getattr(self.ports, name)(*args)
        self.gate(cleanup)
        return value

    def key_metadata(self, value, deleted=False):
        need(isinstance(value, dict) and set(value) == {"name", "uid", "etag", "displayName", "restrictions", "deleted"}, "KEY_SHAPE")
        need(value["name"] == self.key.KEY_PREFIX + self.plan["keyId"], "KEY_IDENTITY")
        try:
            valid_uid = isinstance(value["uid"], str) and str(uuid.UUID(value["uid"])) == value["uid"]
        except (ValueError, AttributeError):
            valid_uid = False
        need(valid_uid, "KEY_UID")
        need(isinstance(value["etag"], str) and 0 < len(value["etag"]) <= 256, "KEY_ETAG")
        need(value["displayName"] == "Signmons P08 " + self.plan["operationId"], "KEY_OWNER")
        need(value["restrictions"] == self.key.RESTRICTIONS and value["deleted"] is deleted, "KEY_RESTRICTIONS")
        return digest(value["uid"])

    def run(self):
        reserve(self.directory / "attempt.json", {"operationId": self.plan["operationId"], "planSha256": digest(self.plan)})
        previous = {s: signal.getsignal(s) for s in (signal.SIGINT, signal.SIGTERM)}
        for sig in previous:
            signal.signal(sig, lambda *_: setattr(self, "abort", True))
        try:
            self.save()
            pre = self.call("preflight")
            need(isinstance(pre, dict) and set(pre) == {"roles", "bindingsAbsent", "apiKeysService"}, "PREFLIGHT_SHAPE")
            need(pre["bindingsAbsent"] is True and pre["apiKeysService"] in ("ENABLED", "DISABLED"), "PREFLIGHT_DRIFT")
            need(isinstance(pre["roles"], list) and len(pre["roles"]) == 2, "ROLE_SHAPE")
            for value, role in zip(pre["roles"], self.roles.ROLES):
                need(self.roles.definition_shape(value, role) in ("EXACT_ACTIVE_EXPLICIT", "EXACT_ACTIVE_DEFAULTED"), "ROLE_DRIFT")
            self.journal["serviceInitial"] = pre["apiKeysService"]
            self.journal["phase"] = "PREFLIGHT_QUALIFIED"; self.save()
            for role in self.roles.ROLES:
                kind = role["kind"]
                self.journal["bindAttempted"].append(kind); self.save()
                self.call("bind", kind, role["name"])
                need(self.call("binding_state", kind) == "OWNED", "BINDING_READBACK")
                self.journal["bindOwned"].append(kind); self.save()
            states = self.call("stage_a", [list(item) for item in self.stage_a.TUPLES])
            need(states == ["CAN_ACCESS"] * 4, "STAGE_A_NOT_QUALIFIED")
            self.journal["phase"] = "STAGE_A_QUALIFIED"; self.save()
            if pre["apiKeysService"] == "DISABLED":
                self.journal["serviceEnableAttempted"] = True; self.save()
                self.call("enable_api_keys")
            need(self.call("api_keys_state") == "ENABLED", "API_KEYS_NOT_READY")
            self.journal["phase"] = "API_KEYS_READY"; self.save()
            need(self.call("key_get") == "NOT_FOUND", "KEY_COLLISION_OR_UNKNOWN")
            self.journal["keyCreateAttempted"] = True; self.save()
            created = self.call("key_create", self.key.KEY_PREFIX + self.plan["keyId"], self.key.RESTRICTIONS)
            uid_hash = self.key_metadata(created)
            need(self.key_metadata(self.call("key_get")) == uid_hash, "KEY_READBACK")
            self.journal["keyUidSha256"] = uid_hash; self.journal["phase"] = "KEY_OWNED"; self.save()
            self.journal["authAttempted"] = True; self.save()
            proof = self.call("authenticate", self.key.KEY_PREFIX + self.plan["keyId"])
            need(proof == AUTH_PROOF, "AUTH_PROOF_REFUSED")
            self.journal["authenticated"] = True; self.journal["phase"] = "AUTHENTICATED"; self.save()
        except BaseException as error:
            self.journal["failure"] = str(error) if isinstance(error, Stop) else "ADAPTER_UNKNOWN"
            try:
                self.save()
            except BaseException:
                self.journal["failure"] = "EVIDENCE_UNCONFIRMED"
        finally:
            for sig, handler in previous.items():
                signal.signal(sig, handler)
        return self.closeout()

    def closeout(self, independent=False):
        reserve(self.directory / ("independent-closeout.json" if independent else "closeout-attempt.json"), {"operationId": self.plan["operationId"]})
        if independent:
            self.journal = json.loads((self.directory / "journal.json").read_text())
            need(self.journal.get("operationId") == self.plan["operationId"] and self.journal.get("planSha256") == digest(self.plan), "CLOSEOUT_SCOPE")
        residuals = []
        def cleanup(name, function):
            try:
                need(function() is True, "CLOSEOUT_READBACK")
            except BaseException:
                residuals.append(name)
        if self.journal["authAttempted"]:
            cleanup("ACCOUNT_SESSION", lambda: self.call("account_closeout", cleanup=True))
        if self.journal["keyCreateAttempted"]:
            def key_close():
                need(self.journal["keyUidSha256"] is not None, "KEY_CREATE_OUTCOME_UNKNOWN")
                current = self.call("key_get", cleanup=True)
                uid = self.key_metadata(current, current.get("deleted") is True)
                need(uid == self.journal["keyUidSha256"], "KEY_OWNERSHIP_DRIFT")
                if current["deleted"] is True:
                    return True
                need(not self.journal["keyDeleteAttempted"], "KEY_DELETE_OUTCOME_UNKNOWN")
                self.journal["keyDeleteAttempted"] = True; self.save()
                self.call("key_delete", current["etag"], cleanup=True)
                after = self.call("key_get", cleanup=True)
                need(self.key_metadata(after, True) == uid, "KEY_DELETE_READBACK")
                return True
            cleanup("KEY", key_close)
        for kind in reversed(self.journal["bindAttempted"]):
            def unbind():
                state = self.call("binding_state", kind, cleanup=True)
                need(state in ("OWNED", "ABSENT"), "BINDING_OWNERSHIP_DRIFT")
                if state == "ABSENT":
                    return True
                need(kind not in self.journal["unbindAttempted"], "BINDING_REMOVE_OUTCOME_UNKNOWN")
                self.journal["unbindAttempted"].append(kind); self.save()
                self.call("unbind", kind, cleanup=True)
                need(self.call("binding_state", kind, cleanup=True) == "ABSENT", "BINDING_REMOVE_READBACK")
                return True
            cleanup("BINDING_" + kind.upper(), unbind)
        if self.journal["serviceEnableAttempted"]:
            cleanup("SERVICE_READBACK", lambda: self.call("api_keys_state", cleanup=True) == "ENABLED")
            residuals.append("SERVICE_RETENTION_DECISION_PENDING")
        cleanup("RUNTIME", lambda: self.call("runtime_closeout", cleanup=True))
        self.journal["residuals"] = sorted(set(residuals))
        self.journal["phase"] = "CLOSED"
        self.save()
        return {"status": "LOCAL_PACKET_CLOSED" if not residuals else "LOCAL_PACKET_CLOSEOUT_UNCONFIRMED",
                "authenticated": self.journal["authenticated"], "failure": self.journal["failure"],
                "residuals": self.journal["residuals"], "serviceRetentionDecisionPending": self.journal["serviceEnableAttempted"]}


def native():
    verify_sources()
    print("P08_INTEGRATED_PACKET_REFUSED_UNBOUND")
    return 2


if __name__ == "__main__":
    raise SystemExit(native())
