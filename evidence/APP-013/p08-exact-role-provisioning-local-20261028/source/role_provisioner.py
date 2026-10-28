"""Disabled exact custom-role provisioner model for APP-013/P08."""
from __future__ import annotations

import hashlib
import json
import os
import re
import signal
import stat
import sys
import time
import uuid
from pathlib import Path

PROJECT = "signmons"
OWNER = "debynyhan@signmons.com"
IDENTITY = "signmons-calldesk-p07-runtime@signmons.iam.gserviceaccount.com"
GCLOUD = "/opt/homebrew/bin/gcloud"
MODE = "DISABLED_LOCAL_STABLE_ROLE_PROVISIONER"
COMMAND_LIMIT = 11
ROLES = (
    {
        "kind": "lookup",
        "id": "signmonsP08FirebaseUserLookup",
        "name": "projects/signmons/roles/signmonsP08FirebaseUserLookup",
        "title": "Signmons P08 Firebase User Lookup",
        "description": "Exact Firebase user lookup permission for bounded Signmons P08 runtime access.",
        "permission": "firebaseauth.users.get",
        "stage": "GA",
    },
    {
        "kind": "signing",
        "id": "signmonsP08ServiceAccountSignBlob",
        "name": "projects/signmons/roles/signmonsP08ServiceAccountSignBlob",
        "title": "Signmons P08 Service Account Sign Blob",
        "description": "Exact signBlob permission for bounded Signmons P08 owner access to the dedicated runtime identity.",
        "permission": "iam.serviceAccounts.signBlob",
        "stage": "GA",
    },
)
HASH_RE = re.compile(r"[a-f0-9]{64}")
SAFE_REASONS = {
    "CLOCK_ROLLBACK", "DEADLINE", "INTERRUPTED", "OWNER_BINDING", "PROJECT_BINDING",
    "IAM_API_DISABLED", "COLLISION", "COMMAND_FAILED", "LOST_RESPONSE", "ROLE_DRIFT",
    "BINDING_PRESENT", "COMMAND_LIMIT", "DIRECTORY", "ROLE_PLAN", "SOURCE_BINDING",
    "APPROVAL_BINDING", "MODE", "RETRY_POLICY",
}


class Stop(Exception):
    pass


class NotFound(Exception):
    pass


class LostResponse(Exception):
    pass


def need(value, code):
    if not value:
        raise Stop(code)


def digest(value):
    payload = value if isinstance(value, bytes) else json.dumps(value, sort_keys=True, separators=(",", ":")).encode()
    return hashlib.sha256(payload).hexdigest()


def role_plan():
    return [{key: role[key] for key in ("kind", "id", "name", "title", "description", "permission", "stage")} for role in ROLES]


def authorize(plan, approval, source_sha256, proposal_sha256, now):
    need(plan.get("mode") == MODE, "MODE")
    need(plan.get("automaticRetryAllowed") is False, "RETRY_POLICY")
    need(plan.get("project") == PROJECT and plan.get("owner") == OWNER, "PROJECT_BINDING")
    need(plan.get("roles") == role_plan() and plan.get("commandLimit") == COMMAND_LIMIT, "ROLE_PLAN")
    need(plan.get("sourceSha256") == source_sha256 and HASH_RE.fullmatch(source_sha256), "SOURCE_BINDING")
    need(plan.get("proposalSha256") == proposal_sha256 and HASH_RE.fullmatch(proposal_sha256), "SOURCE_BINDING")
    need(isinstance(plan.get("deadlineEpoch"), (int, float)) and now < plan["deadlineEpoch"] <= now + 300, "DEADLINE")
    need(str(uuid.UUID(plan.get("operationId", ""))) == plan["operationId"], "ROLE_PLAN")
    need(approval.get("owner") == "Debynyhan Banks", "APPROVAL_BINDING")
    need(approval.get("externalActionAuthorized") is True, "APPROVAL_BINDING")
    need(approval.get("decision") == "APPROVE_EXACT_STABLE_ROLE_CREATION", "APPROVAL_BINDING")
    need(approval.get("operationId") == plan["operationId"] and approval.get("planSha256") == digest(plan), "APPROVAL_BINDING")
    need(approval.get("sourceSha256") == source_sha256 and approval.get("proposalSha256") == proposal_sha256, "APPROVAL_BINDING")
    return plan["deadlineEpoch"]


def preflight_commands():
    return (
        (GCLOUD, "auth", "list", "--filter=status:ACTIVE", "--format=value(account)"),
        (GCLOUD, "config", "get-value", "project"),
        (GCLOUD, "services", "describe", "iam.googleapis.com", "--project=signmons", "--format=json(state)"),
    )


def describe_command(role):
    return (GCLOUD, "iam", "roles", "describe", role["id"], "--project=signmons", "--format=json(name,title,description,includedPermissions,stage,deleted,etag)")


def create_command(role):
    return (
        GCLOUD, "iam", "roles", "create", role["id"], "--project=signmons",
        "--title=" + role["title"], "--description=" + role["description"],
        "--permissions=" + role["permission"], "--stage=GA", "--quiet",
    )


def policy_commands():
    return (
        (GCLOUD, "projects", "get-iam-policy", PROJECT, "--format=json(bindings)"),
        (GCLOUD, "iam", "service-accounts", "get-iam-policy", IDENTITY, "--project=signmons", "--format=json(bindings)"),
    )


def exact_definition(value, role):
    need(isinstance(value, dict) and set(value) <= {"name", "title", "description", "includedPermissions", "stage", "deleted", "etag"}, "ROLE_DRIFT")
    need("etag" not in value or isinstance(value["etag"], str), "ROLE_DRIFT")
    need(value.get("name") == role["name"], "ROLE_DRIFT")
    need(value.get("title") == role["title"] and value.get("description") == role["description"], "ROLE_DRIFT")
    need(value.get("includedPermissions") == [role["permission"]], "ROLE_DRIFT")
    need(value.get("stage") == "GA" and value.get("deleted") is False, "ROLE_DRIFT")
    return {
        "name": role["name"], "includedPermissions": [role["permission"]],
        "stage": "GA", "deleted": False,
    }


def bindings_absent(value):
    need(isinstance(value, dict) and set(value) <= {"bindings", "etag", "version"}, "ROLE_DRIFT")
    bindings = value.get("bindings", [])
    need(isinstance(bindings, list), "ROLE_DRIFT")
    role_names = {role["name"] for role in ROLES}
    for binding in bindings:
        need(isinstance(binding, dict) and isinstance(binding.get("role"), str), "ROLE_DRIFT")
        if binding["role"] in role_names:
            raise Stop("BINDING_PRESENT")
    return True


def reserve(path, value):
    fd = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    try:
        os.write(fd, json.dumps(value, sort_keys=True).encode())
    finally:
        os.close(fd)


def atomic(path, value):
    temporary = path.with_suffix(".tmp")
    fd = os.open(temporary, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    try:
        os.write(fd, json.dumps(value, sort_keys=True).encode())
    finally:
        os.close(fd)
    os.replace(temporary, path)


def safe_reason(error):
    return error.args[0] if isinstance(error, Stop) and error.args and error.args[0] in SAFE_REASONS else (
        type(error).__name__ if isinstance(error, (LostResponse, NotFound, TimeoutError, ValueError, TypeError)) else "UNCLASSIFIED_STOP"
    )


class Controller:
    def __init__(self, plan, approval, runner, directory, source_sha256, proposal_sha256, clock=time.time):
        self.plan = plan
        self.runner = runner
        self.directory = Path(directory)
        self.clock = clock
        self.last = clock()
        self.deadline = authorize(plan, approval, source_sha256, proposal_sha256, self.last)
        need(not self.directory.is_symlink() and stat.S_IMODE(self.directory.stat().st_mode) == 0o700, "DIRECTORY")
        self.interrupted = False
        self.commands = 0
        self.journal = {"attempted": [], "created": [], "unknown": [], "verified": []}

    def save(self):
        atomic(self.directory / "journal.json", self.journal)

    def check(self):
        now = self.clock()
        need(now >= self.last, "CLOCK_ROLLBACK")
        self.last = now
        need(now < self.deadline, "DEADLINE")
        need(not self.interrupted, "INTERRUPTED")

    def call(self, command, mutation=False):
        self.check()
        self.commands += 1
        need(self.commands <= self.plan["commandLimit"], "COMMAND_LIMIT")
        try:
            value = self.runner(command, self.deadline)
        except NotFound:
            raise
        except LostResponse:
            raise Stop("LOST_RESPONSE")
        except BaseException:
            raise Stop("COMMAND_FAILED")
        try:
            self.check()
        except BaseException:
            if mutation:
                raise Stop("INTERRUPTED" if self.interrupted else "DEADLINE")
            raise
        return value

    def verify_policies(self):
        for command in policy_commands():
            bindings_absent(self.call(command))

    def run(self):
        reserve(self.directory / "attempt.json", {"operationId": self.plan["operationId"], "planSha256": digest(self.plan)})
        previous = {item: signal.getsignal(item) for item in (signal.SIGINT, signal.SIGTERM)}
        for item in previous:
            signal.signal(item, lambda *_: setattr(self, "interrupted", True))
        result = None
        try:
            owner, project, service = [self.call(command) for command in preflight_commands()]
            need(owner == OWNER, "OWNER_BINDING")
            need(project == PROJECT, "PROJECT_BINDING")
            need(service == {"state": "ENABLED"}, "IAM_API_DISABLED")
            for role in ROLES:
                try:
                    self.call(describe_command(role))
                    raise Stop("COLLISION")
                except NotFound:
                    pass
            definitions = {}
            for role in ROLES:
                self.journal["attempted"].append(role["kind"])
                self.save()
                try:
                    self.call(create_command(role), mutation=True)
                except BaseException:
                    self.journal["unknown"].append(role["kind"])
                    self.save()
                    raise
                self.journal["created"].append(role["kind"])
                self.save()
                definition = exact_definition(self.call(describe_command(role)), role)
                definitions[role["kind"]] = digest(definition)
                self.journal["verified"].append(role["kind"])
                self.save()
            self.verify_policies()
            result = {
                "status": "P08_EXACT_ROLES_CREATED_RETAINED_UNBOUND",
                "createdCount": 2, "verifiedCount": 2, "retainedUnbound": True,
                "definitionSha256": definitions, "commandsCompleted": self.commands,
                "rawOutputRetained": False, "providerMutationModeledOnly": True,
            }
        except BaseException as error:
            result = {
                "status": "P08_EXACT_ROLE_PROVISIONING_STOP_UNKNOWN_OWNERSHIP",
                "reason": safe_reason(error), "createdCount": len(self.journal["created"]),
                "unknownCount": len(self.journal["unknown"]), "commandsCompleted": self.commands,
                "rawOutputRetained": False, "providerMutationModeledOnly": True,
            }
        finally:
            for item, handler in previous.items():
                signal.signal(item, handler)
            atomic(self.directory / "result.json", result)
        return result


def closeout_only(plan, approval, runner, directory, source_sha256, proposal_sha256, clock=time.time):
    directory = Path(directory)
    deadline = authorize(plan, approval, source_sha256, proposal_sha256, clock())
    journal = json.loads((directory / "journal.json").read_text())
    relevant = set(journal.get("attempted", []))
    reconciled, absent, residuals = [], [], []
    commands = 0
    for role in ROLES:
        if role["kind"] not in relevant:
            continue
        commands += 1
        try:
            exact_definition(runner(describe_command(role), deadline), role)
            reconciled.append(role["kind"])
        except NotFound:
            absent.append(role["kind"])
        except BaseException:
            residuals.append(role["kind"])
    try:
        for command in policy_commands():
            commands += 1
            bindings_absent(runner(command, deadline))
    except BaseException:
        residuals.append("binding_state")
    result = {
        "status": "P08_EXACT_ROLE_CLOSEOUT_VERIFIED" if not residuals else "P08_EXACT_ROLE_CLOSEOUT_UNCONFIRMED",
        "reconciledRetainedCount": len(reconciled), "absentCount": len(absent),
        "residualCount": len(residuals), "commandsCompleted": commands,
        "retainedUnbound": bool(reconciled) and not residuals,
        "rawOutputRetained": False, "providerMutationModeledOnly": True,
    }
    atomic(directory / "closeout.json", result)
    return result


def main(argv=None):
    argv = sys.argv[1:] if argv is None else argv
    if argv in (["--provision"], ["--closeout"]):
        print("P08_EXACT_ROLE_PROVISIONER_REFUSED_UNBOUND")
        return 2
    print("P08_EXACT_ROLE_PROVISIONER_USAGE_REFUSED")
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
