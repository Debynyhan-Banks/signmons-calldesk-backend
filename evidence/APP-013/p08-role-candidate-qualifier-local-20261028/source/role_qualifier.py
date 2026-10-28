"""Disabled local custom-role candidate qualifier for APP-013/P08."""
from __future__ import annotations

import hashlib
import json
import os
import re
import signal
import stat
import subprocess
import sys
import time
import uuid
import urllib.error
import urllib.parse
import urllib.request
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
OWNER = "debynyhan@signmons.com"
GCLOUD = "/opt/homebrew/bin/gcloud"
IAM_HOST = "iam.googleapis.com"
IAM_PATH = "/v1/projects/signmons/roles"
IAM_QUERY = "view=FULL&pageSize=200"
STAGES = ("OWNER_CHECK", "PROJECT_CHECK", "BEARER_ACQUISITION", "ROLE_LIST_FULL")
SAFE_STOP_REASONS = {
    "CLOCK_ROLLBACK", "DEADLINE", "INTERRUPTED", "COMMAND_LIMIT", "COMMAND_COUNT",
    "OWNER_BINDING", "PROJECT_BINDING", "COMMAND_ALLOWLIST", "COMMAND_FAILED",
    "OUTPUT_SHAPE", "ROLE_OUTPUT_CAP", "ROLE_SHAPE", "FOREIGN_OR_INVALID_ROLE",
    "PERMISSION_SHAPE", "DUPLICATE_PERMISSION", "INACTIVE_ROLE", "DUPLICATE_ROLE",
    "BEARER_SHAPE", "HTTPS_METHOD", "HTTPS_HOST", "HTTPS_PATH", "HTTPS_QUERY",
    "HTTPS_REDIRECT", "HTTPS_STATUS", "HTTPS_BODY_CAP", "RESPONSE_SHAPE",
    "RESPONSE_KEYS", "ROLE_PAGE_CAP",
}


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


def private_json(path):
    path = Path(path)
    info = path.lstat()
    need(stat.S_ISREG(info.st_mode) and not path.is_symlink() and stat.S_IMODE(info.st_mode) == 0o600, "PRIVATE_INPUT")
    return json.loads(path.read_text())


def atomic_result(directory, result):
    directory = Path(directory)
    temporary = directory / "result.tmp"
    output = directory / "result.json"
    try:
        fd = os.open(temporary, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        try:
            os.write(fd, json.dumps(result, sort_keys=True).encode())
        finally:
            os.close(fd)
        os.replace(temporary, output)
    finally:
        if temporary.exists() and temporary.is_file() and not temporary.is_symlink():
            temporary.unlink()


def progress(adapter):
    started = list(getattr(adapter, "started", []))
    completed = list(getattr(adapter, "completed", []))
    return {
        "commandsStarted": int(getattr(adapter, "cli_started", 0)),
        "commandsCompleted": int(getattr(adapter, "cli_completed", 0)),
        "httpsStarted": int(getattr(adapter, "https_started", 0)),
        "httpsCompleted": int(getattr(adapter, "https_completed", 0)),
        "lastStartedStage": started[-1] if started else None,
        "lastCompletedStage": completed[-1] if completed else None,
    }


def safe_reason(error):
    if isinstance(error, Stop) and error.args and error.args[0] in SAFE_STOP_REASONS:
        return error.args[0]
    if isinstance(error, (TimeoutError, ValueError, TypeError, json.JSONDecodeError)):
        return type(error).__name__
    return "UNCLASSIFIED_STOP"


def authorize(plan, source_sha256, decision_sha256, now):
    need(plan.get("mode") == MODE, "MODE")
    need(plan.get("automaticRetryAllowed") is False, "RETRY_POLICY")
    need(plan.get("project") == PROJECT, "PROJECT")
    need(plan.get("sourceSha256") == source_sha256 and HASH_RE.fullmatch(source_sha256), "SOURCE_BINDING")
    need(plan.get("decisionSha256") == decision_sha256 and HASH_RE.fullmatch(decision_sha256), "DECISION_BINDING")
    need(isinstance(plan.get("deadlineEpoch"), (int, float)) and now < plan["deadlineEpoch"] <= now + 300, "DEADLINE")
    need(plan.get("saveCandidateLimit") == 2 and plan.get("rawOutputRetention") == "PROCESS_MEMORY_ONLY", "PRIVACY_CONTRACT")
    need(plan.get("expectedOwner") == OWNER and plan.get("commandLimit") == 3 and plan.get("httpsRequestLimit") == 1, "COMMAND_CONTRACT")
    return plan["deadlineEpoch"]


def approve(plan, approval, source_sha256, decision_sha256):
    need(str(uuid.UUID(plan.get("operationId", ""))) == plan["operationId"], "OPERATION_ID")
    need(approval.get("owner") == "Debynyhan Banks", "APPROVAL_OWNER")
    need(approval.get("externalActionAuthorized") is True, "EXTERNAL_APPROVAL")
    need(approval.get("decision") == "APPROVE_EXACT_ROLE_INVENTORY_READ", "APPROVAL_DECISION")
    need(approval.get("operationId") == plan["operationId"], "APPROVAL_OPERATION")
    need(approval.get("planSha256") == digest(plan), "APPROVAL_PLAN")
    need(approval.get("sourceSha256") == source_sha256 and approval.get("decisionSha256") == decision_sha256, "APPROVAL_BINDING")
    return True


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
        result = None
        try:
            self.check()
            rows = self.adapter.list_roles(self.deadline)
            self.check()
            result = classify(rows)
        except (Stop, TimeoutError, ValueError, TypeError, json.JSONDecodeError) as error:
            result = {
                "status": "P08_ROLE_QUALIFIER_STOP_OUTPUT_UNKNOWN",
                "reason": safe_reason(error),
            }
        finally:
            self.adapter.cancel()
            for sig, handler in previous.items():
                signal.signal(sig, handler)
        result.update(progress(self.adapter))
        result.update({"rawOutputRetained": False, "providerMutationPossible": False})
        try:
            atomic_result(self.directory, result)
        except OSError:
            return {
                "status": "P08_ROLE_QUALIFIER_STOP_EVIDENCE_UNCONFIRMED",
                "reason": "RESULT_WRITE_FAILED",
                **progress(self.adapter),
                "rawOutputRetained": False,
                "providerMutationPossible": False,
            }
        return result


class NativeAdapter:
    """Three CLI reads plus one exact IAM FULL-view HTTPS read."""

    def __init__(self, runner, http):
        self.runner = runner
        self.http = http
        self.calls = []
        self.cli_started = 0
        self.cli_completed = 0
        self.https_started = 0
        self.https_completed = 0
        self.started = []
        self.completed = []

    def _run_cli(self, stage, args, deadline):
        need(stage in STAGES, "COMMAND_ALLOWLIST")
        need(len(self.calls) < 3, "COMMAND_LIMIT")
        self.calls.append(args)
        self.cli_started += 1
        self.started.append(stage)
        value = self.runner(args, deadline)
        self.cli_completed += 1
        self.completed.append(stage)
        return value

    def list_roles(self, deadline):
        owner = self._run_cli("OWNER_CHECK", ["auth", "list", "--filter=status:ACTIVE", "--format=value(account)"], deadline)
        need(owner == OWNER, "OWNER_BINDING")
        project = self._run_cli("PROJECT_CHECK", ["config", "get-value", "project"], deadline)
        need(project == PROJECT, "PROJECT_BINDING")
        bearer = self._run_cli("BEARER_ACQUISITION", ["auth", "print-access-token"], deadline)
        need(isinstance(bearer, str) and len(bearer) >= 20 and not any(x.isspace() for x in bearer), "BEARER_SHAPE")
        need(len(self.calls) == 3, "COMMAND_COUNT")
        self.https_started += 1
        self.started.append("ROLE_LIST_FULL")
        response = self.http("GET", IAM_HOST, IAM_PATH, IAM_QUERY, {"Authorization": "Bearer " + bearer, "Accept": "application/json"}, deadline)
        self.https_completed += 1
        self.completed.append("ROLE_LIST_FULL")
        need(isinstance(response, dict), "RESPONSE_SHAPE")
        need(set(response) <= {"roles", "nextPageToken"} and isinstance(response.get("roles", []), list), "RESPONSE_KEYS")
        need(not response.get("nextPageToken"), "ROLE_PAGE_CAP")
        return response.get("roles", [])

    def cancel(self):
        self.runner.cancel()
        self.http.cancel()


class SubprocessRunner:
    def __init__(self):
        self.child = None

    def __call__(self, args, deadline):
        need(args and args[0] in {"auth", "config"}, "COMMAND_ALLOWLIST")
        timeout = max(0.1, deadline - time.time())
        self.child = subprocess.Popen([GCLOUD, *args], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
        try:
            output, _ = self.child.communicate(timeout=timeout)
        except subprocess.TimeoutExpired:
            self.cancel()
            raise TimeoutError("COMMAND_TIMEOUT")
        need(self.child.returncode == 0, "COMMAND_FAILED")
        output = output.strip()
        return output

    def cancel(self):
        if self.child and self.child.poll() is None:
            self.child.terminate()
            try:
                self.child.wait(timeout=2)
            except subprocess.TimeoutExpired:
                self.child.kill()
                self.child.wait(timeout=2)


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, file_pointer, code, message, headers, new_url):
        raise Stop("HTTPS_REDIRECT")


class HttpsClient:
    def __init__(self, opener=None):
        self.opener = opener or urllib.request.build_opener(NoRedirect())

    def __call__(self, method, host, path, query, headers, deadline):
        need(method == "GET", "HTTPS_METHOD")
        need(host == IAM_HOST, "HTTPS_HOST")
        need(path == IAM_PATH, "HTTPS_PATH")
        need(query == IAM_QUERY, "HTTPS_QUERY")
        need(set(headers) == {"Authorization", "Accept"} and headers["Accept"] == "application/json" and headers["Authorization"].startswith("Bearer "), "BEARER_SHAPE")
        url = "https://" + host + path + "?" + query
        request = urllib.request.Request(url, method="GET", headers=headers)
        timeout = max(0.1, deadline - time.time())
        try:
            response = self.opener.open(request, timeout=timeout)
            need(response.geturl() == url, "HTTPS_REDIRECT")
            need(response.status == 200, "HTTPS_STATUS")
            body = response.read(2 * 1024 * 1024 + 1)
            need(len(body) <= 2 * 1024 * 1024, "HTTPS_BODY_CAP")
            return json.loads(body)
        except urllib.error.HTTPError:
            raise Stop("HTTPS_STATUS")
        except urllib.error.URLError:
            raise Stop("HTTPS_STATUS")

    def cancel(self):
        return None


def run_bound(plan_path, approval_path, directory, runner=None, http=None, clock=time.time):
    directory = Path(directory)
    plan_path = Path(plan_path)
    approval_path = Path(approval_path)
    need(plan_path.parent.resolve() == directory.resolve() and approval_path.parent.resolve() == directory.resolve(), "PRIVATE_PATH_SCOPE")
    result = None
    adapter = None
    try:
        plan = private_json(plan_path)
        approval = private_json(approval_path)
        source_sha256 = digest(Path(__file__).read_bytes())
        decision_sha256 = plan.get("decisionSha256", "")
        approve(plan, approval, source_sha256, decision_sha256)
        adapter = NativeAdapter(runner or SubprocessRunner(), http or HttpsClient())
        result = Controller(plan, adapter, directory, source_sha256, decision_sha256, clock).run()
    finally:
        for path in (plan_path, approval_path):
            if path.exists() and path.is_file() and not path.is_symlink():
                path.unlink()
        if result is not None:
            result["privateInputsAbsent"] = not plan_path.exists() and not approval_path.exists()
            try:
                atomic_result(directory, result)
            except OSError:
                result = {
                    "status": "P08_ROLE_QUALIFIER_STOP_EVIDENCE_UNCONFIRMED",
                    "reason": "CLOSEOUT_RESULT_WRITE_FAILED",
                    **progress(adapter),
                    "privateInputsAbsent": result["privateInputsAbsent"],
                    "rawOutputRetained": False,
                    "providerMutationPossible": False,
                }
    return result


def main(argv=None):
    argv = sys.argv[1:] if argv is None else argv
    if argv == ["--qualify"]:
        print("P08_ROLE_QUALIFIER_REFUSED_UNBOUND")
        return 2
    if len(argv) == 4 and argv[0] == "--qualify-bound":
        result = run_bound(argv[1], argv[2], argv[3])
        print(result["status"])
        return 0 if result["status"] in {"P08_ROLE_CANDIDATES_UNIQUE", "P08_ROLE_CANDIDATES_DECISION_REQUIRED"} else 2
    print("P08_ROLE_QUALIFIER_USAGE_REFUSED")
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
