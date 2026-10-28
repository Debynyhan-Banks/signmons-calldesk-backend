"""Disabled local custom-role candidate qualifier for APP-013/P08."""
from __future__ import annotations

import hashlib
import json
import os
import re
import signal
import sys
import time
from pathlib import Path

PROJECT = "signmons"
MODE = "DISABLED_LOCAL_ROLE_CANDIDATE_QUALIFIER"
PERMISSIONS = {
    "lookup": "firebaseauth.users.get",
    "signing": "iam.serviceAccounts.signBlob",
}
ROLE_RE = re.compile(r"projects/signmons/roles/[A-Za-z0-9_]+")
HASH_RE = re.compile(r"[a-f0-9]{64}")
ACTIVE_STAGES = {"ALPHA", "BETA", "GA"}
MAX_ROLES = 200


class Stop(Exception):
    pass


def need(value, code):
    if not value:
        raise Stop(code)


def digest(value):
    payload = value if isinstance(value, bytes) else json.dumps(
        value, sort_keys=True, separators=(",", ":")
    ).encode()
    return hashlib.sha256(payload).hexdigest()


def reserve(path, value):
    fd = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    try:
        os.write(fd, json.dumps(value, sort_keys=True).encode())
    finally:
        os.close(fd)


def authorize(plan, source_sha256, decision_sha256, now):
    need(plan.get("mode") == MODE, "MODE")
    need(plan.get("automaticRetryAllowed") is False, "RETRY_POLICY")
    need(plan.get("project") == PROJECT, "PROJECT")
    need(plan.get("sourceSha256") == source_sha256 and HASH_RE.fullmatch(source_sha256), "SOURCE_BINDING")
    need(plan.get("decisionSha256") == decision_sha256 and HASH_RE.fullmatch(decision_sha256), "DECISION_BINDING")
    need(isinstance(plan.get("deadlineEpoch"), (int, float)) and now < plan["deadlineEpoch"] <= now + 300, "DEADLINE")
    need(plan.get("saveCandidateLimit") == 2 and plan.get("rawOutputRetention") == "PROCESS_MEMORY_ONLY", "PRIVACY_CONTRACT")
    return plan["deadlineEpoch"]


def _role(row):
    need(isinstance(row, dict) and set(row) <= {"name", "includedPermissions", "deleted", "stage", "title", "description"}, "ROLE_SHAPE")
    name = row.get("name")
    permissions = row.get("includedPermissions")
    deleted = row.get("deleted", False)
    stage = row.get("stage")
    need(isinstance(name, str) and ROLE_RE.fullmatch(name), "FOREIGN_OR_INVALID_ROLE")
    need(isinstance(permissions, list) and permissions and all(isinstance(x, str) and x for x in permissions), "PERMISSION_SHAPE")
    need(len(permissions) == len(set(permissions)), "DUPLICATE_PERMISSION")
    need(deleted is False and stage in ACTIVE_STAGES, "INACTIVE_ROLE")
    return {
        "name": name,
        "includedPermissions": sorted(permissions),
        "deleted": False,
        "stage": stage,
    }


def classify(rows):
    need(isinstance(rows, list), "OUTPUT_SHAPE")
    need(len(rows) <= MAX_ROLES, "ROLE_OUTPUT_CAP")
    normalized = [_role(row) for row in rows]
    names = [row["name"] for row in normalized]
    need(len(names) == len(set(names)), "DUPLICATE_ROLE")

    candidates = {}
    classifications = {}
    for kind, permission in PERMISSIONS.items():
        exact = [row for row in normalized if row["includedPermissions"] == [permission]]
        broader = [row for row in normalized if permission in row["includedPermissions"] and row not in exact]
        if len(exact) == 1:
            classifications[kind] = "UNIQUE_EXACT"
            row = exact[0]
            definition = {
                "name": row["name"],
                "includedPermissions": row["includedPermissions"],
                "deleted": row["deleted"],
                "stage": row["stage"],
            }
            candidates[kind] = {
                "roleId": row["name"],
                "permission": permission,
                "stage": row["stage"],
                "deleted": False,
                "definitionSha256": digest(definition),
            }
        elif len(exact) == 0:
            classifications[kind] = "NO_EXACT" if not broader else "BROADER_ONLY"
        else:
            classifications[kind] = "MULTIPLE_EXACT"

    status = "P08_ROLE_CANDIDATES_UNIQUE" if len(candidates) == 2 else "P08_ROLE_CANDIDATES_DECISION_REQUIRED"
    return {
        "status": status,
        "project": PROJECT,
        "roleCount": len(normalized),
        "classifications": classifications,
        "candidates": candidates,
        "candidateCount": len(candidates),
        "rawOutputRetained": False,
        "providerMutationPossible": False,
    }


class Controller:
    def __init__(self, plan, adapter, directory, source_sha256, decision_sha256, clock=time.time):
        self.plan = plan
        self.adapter = adapter
        self.directory = Path(directory)
        self.clock = clock
        self.last = clock()
        self.deadline = authorize(plan, source_sha256, decision_sha256, self.last)
        need(self.directory.is_dir() and not self.directory.is_symlink(), "DIRECTORY")
        need((self.directory.stat().st_mode & 0o777) == 0o700, "DIRECTORY_MODE")
        self.interrupted = False

    def check(self):
        current = self.clock()
        need(current >= self.last, "CLOCK_ROLLBACK")
        self.last = current
        need(current < self.deadline, "DEADLINE")
        need(not self.interrupted, "INTERRUPTED")

    def _signal(self, *_):
        self.interrupted = True
        self.adapter.cancel()

    def run(self):
        reserve(self.directory / "attempt.json", {
            "mode": MODE,
            "project": PROJECT,
            "planSha256": digest(self.plan),
        })
        previous = {sig: signal.getsignal(sig) for sig in (signal.SIGINT, signal.SIGTERM)}
        for sig in previous:
            signal.signal(sig, self._signal)
        try:
            self.check()
            rows = self.adapter.list_roles(self.deadline)
            self.check()
            result = classify(rows)
            output = self.directory / "result.json"
            fd = os.open(output, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
            try:
                os.write(fd, json.dumps(result, sort_keys=True).encode())
            finally:
                os.close(fd)
            return result
        except (Stop, TimeoutError, ValueError, TypeError, json.JSONDecodeError) as error:
            reason = error.args[0] if isinstance(error, Stop) and error.args else type(error).__name__
            return {
                "status": "P08_ROLE_QUALIFIER_STOP_OUTPUT_UNKNOWN",
                "reason": reason,
                "rawOutputRetained": False,
                "providerMutationPossible": False,
            }
        finally:
            self.adapter.cancel()
            for sig, handler in previous.items():
                signal.signal(sig, handler)


def main(argv=None):
    argv = sys.argv[1:] if argv is None else argv
    if argv == ["--qualify"]:
        print("P08_ROLE_QUALIFIER_REFUSED_UNBOUND")
        return 2
    print("P08_ROLE_QUALIFIER_USAGE_REFUSED")
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
