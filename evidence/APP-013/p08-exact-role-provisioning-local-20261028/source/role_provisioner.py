"""Disabled exact custom-role provisioner model for APP-013/P08."""
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
import urllib.request
from pathlib import Path

PROJECT = "signmons"
OWNER = "debynyhan@signmons.com"
IDENTITY = "signmons-calldesk-p07-runtime@signmons.iam.gserviceaccount.com"
GCLOUD = "/opt/homebrew/bin/gcloud"
MODE = "DISABLED_LOCAL_STABLE_ROLE_PROVISIONER"
COMMAND_LIMIT = 11
CLI_LIMIT = 5
HTTPS_LIMIT = 9
EXTERNAL_CALL_LIMIT = CLI_LIMIT + HTTPS_LIMIT
PERMISSIONS = (
    "iam.roles.create",
    "iam.roles.get",
    "resourcemanager.projects.get",
    "resourcemanager.projects.getIamPolicy",
    "iam.serviceAccounts.getIamPolicy",
    "serviceusage.services.get",
)
CLI_STAGES = (
    "CLI_1_OWNER",
    "CLI_2_PROJECT",
    "CLI_3_BEARER",
    "CLI_4_PROJECT_POLICY",
    "CLI_5_IDENTITY_POLICY",
)
HTTPS_STAGES = (
    "HTTPS_1_PROJECT_METADATA",
    "HTTPS_2_IAM_SERVICE_STATE",
    "HTTPS_3_PERMISSION_PROBE",
    "HTTPS_4_LOOKUP_ABSENCE",
    "HTTPS_5_SIGNING_ABSENCE",
    "HTTPS_6_LOOKUP_CREATE",
    "HTTPS_7_SIGNING_CREATE",
    "HTTPS_8_LOOKUP_READBACK",
    "HTTPS_9_SIGNING_READBACK",
)
CLOSEOUT_HTTPS_STAGES = ("HTTPS_CLOSEOUT_1_LOOKUP", "HTTPS_CLOSEOUT_2_SIGNING")
CLI_ERROR_CATEGORIES = {
    "AUTH", "PERMISSION_DENIED", "BILLING_OR_SERVICE_DISABLED", "NOT_FOUND",
    "INVALID_ARGUMENT", "TRANSPORT", "TIMEOUT", "UNKNOWN",
}
HTTPS_ERROR_CATEGORIES = {
    "TRANSPORT", "TIMEOUT", "HTTP_STATUS", "HTTP_SHAPE",
    "BILLING_OR_SERVICE_DISABLED", "UNKNOWN",
}
IAM_BASE = "https://iam.googleapis.com/v1"
RESOURCE_MANAGER_BASE = "https://cloudresourcemanager.googleapis.com/v1"
SERVICE_USAGE_BASE = "https://serviceusage.googleapis.com/v1"
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
    "APPROVAL_BINDING", "MODE", "RETRY_POLICY", "PRIVATE_INPUT", "WINDOW_BINDING",
    "PERMISSION_DENIED", "HTTP_STATUS", "HTTP_SHAPE", "CLI_SHAPE",
}


class Stop(Exception):
    pass


class NotFound(Exception):
    pass


class LostResponse(Exception):
    pass


class CliFailure(Stop):
    def __init__(self, category):
        need(category in CLI_ERROR_CATEGORIES, "CLI_SHAPE")
        super().__init__("COMMAND_FAILED")
        self.category = category


class HttpFailure(Stop):
    def __init__(self, category):
        need(category in HTTPS_ERROR_CATEGORIES, "HTTP_SHAPE")
        super().__init__("COMMAND_FAILED")
        self.category = category


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


def native_cli_commands():
    return (
        (GCLOUD, "auth", "list", "--filter=status:ACTIVE", "--format=value(account)"),
        (GCLOUD, "config", "get-value", "project"),
        (GCLOUD, "auth", "print-access-token"),
        (GCLOUD, "projects", "get-iam-policy", PROJECT, "--format=json(bindings)"),
        (GCLOUD, "iam", "service-accounts", "get-iam-policy", IDENTITY, "--project=signmons", "--format=json(bindings)"),
    )


def project_url():
    return f"{RESOURCE_MANAGER_BASE}/projects/{PROJECT}"


def service_url(project_number):
    return f"{SERVICE_USAGE_BASE}/projects/{project_number}/services/iam.googleapis.com"


def classify_cli_failure(stderr):
    value = stderr.lower()
    categories = (
        ("BILLING_OR_SERVICE_DISABLED", ("billing disabled", "billing account", "service disabled", "api has not been used", "serviceusage.services.use")),
        ("AUTH", ("reauthentication", "login required", "invalid_grant", "credential")),
        ("PERMISSION_DENIED", ("permission denied", "permission_denied", "does not have permission", "forbidden")),
        ("NOT_FOUND", ("not found", "not_found", "does not exist")),
        ("INVALID_ARGUMENT", ("invalid argument", "invalid_argument", "unrecognized arguments", "usage:")),
        ("TRANSPORT", ("connection", "network", "dns", "unavailable", "temporarily unavailable", "too many requests")),
    )
    for category, indicators in categories:
        if any(indicator in value for indicator in indicators):
            return category
    return "UNKNOWN"


def cli_json(controller, value, stage):
    try:
        return json.loads(value)
    except (json.JSONDecodeError, TypeError):
        controller.failed_stage = stage
        controller.error_category = "UNKNOWN"
        raise Stop("CLI_SHAPE")


def cli_need(controller, condition, code, stage, category="UNKNOWN"):
    if not condition:
        controller.failed_stage = stage
        controller.error_category = category
        raise Stop(code)


def https_need(controller, condition, code, stage, category="HTTP_SHAPE"):
    if not condition:
        controller.failed_stage = stage
        controller.error_category = category
        raise Stop(code)


def exact_project(value):
    need(isinstance(value, dict), "HTTP_SHAPE")
    number = value.get("projectNumber")
    need(value.get("projectId") == PROJECT, "PROJECT_BINDING")
    need(value.get("lifecycleState") == "ACTIVE", "PROJECT_BINDING")
    need(isinstance(number, str) and number.isdigit() and 6 <= len(number) <= 20, "HTTP_SHAPE")
    return number


def exact_service(value, project_number):
    need(isinstance(value, dict), "HTTP_SHAPE")
    need(value.get("name") == f"projects/{project_number}/services/iam.googleapis.com", "HTTP_SHAPE")
    need(value.get("state") == "ENABLED", "IAM_API_DISABLED")
    return True


def permission_url():
    return f"{RESOURCE_MANAGER_BASE}/projects/{PROJECT}:testIamPermissions"


def role_url(role):
    return f"{IAM_BASE}/{role['name']}"


def create_url(role):
    return f"{IAM_BASE}/projects/{PROJECT}/roles"


def create_body(role):
    return {
        "roleId": role["id"],
        "role": {
            "title": role["title"],
            "description": role["description"],
            "includedPermissions": [role["permission"]],
            "stage": "GA",
        }
    }


def private_json(path):
    path = Path(path)
    need(not path.is_symlink() and path.is_file(), "PRIVATE_INPUT")
    need(stat.S_IMODE(path.stat().st_mode) == 0o600 and path.stat().st_size <= 65536, "PRIVATE_INPUT")
    try:
        value = json.loads(path.read_text())
    except (OSError, UnicodeError, json.JSONDecodeError):
        raise Stop("PRIVATE_INPUT")
    need(isinstance(value, dict), "PRIVATE_INPUT")
    return value


def authorize_native(plan, approval, source_sha256, proposal_sha256, now):
    need(plan.get("mode") == MODE, "MODE")
    need(plan.get("automaticRetryAllowed") is False, "RETRY_POLICY")
    need(plan.get("project") == PROJECT and plan.get("owner") == OWNER, "PROJECT_BINDING")
    need(plan.get("roles") == role_plan(), "ROLE_PLAN")
    need(plan.get("action") in {"PROVISION", "CLOSEOUT"}, "ROLE_PLAN")
    need(plan.get("cliLimit") == CLI_LIMIT and plan.get("httpsLimit") == HTTPS_LIMIT, "ROLE_PLAN")
    need(plan.get("sourceSha256") == source_sha256 and HASH_RE.fullmatch(source_sha256), "SOURCE_BINDING")
    need(plan.get("proposalSha256") == proposal_sha256 and HASH_RE.fullmatch(proposal_sha256), "SOURCE_BINDING")
    need(str(uuid.UUID(plan.get("operationId", ""))) == plan["operationId"], "ROLE_PLAN")
    start = plan.get("windowStartEpoch")
    cutoff = plan.get("startCutoffEpoch")
    deadline = plan.get("deadlineEpoch")
    end = plan.get("windowEndEpoch")
    need(all(isinstance(item, (int, float)) for item in (start, cutoff, deadline, end)), "WINDOW_BINDING")
    need(start <= now < cutoff < deadline <= end and end <= now + 1800, "WINDOW_BINDING")
    need(approval.get("owner") == "Debynyhan Banks", "APPROVAL_BINDING")
    need(approval.get("externalActionAuthorized") is True, "APPROVAL_BINDING")
    expected_decision = "APPROVE_EXACT_STABLE_ROLE_CREATION" if plan["action"] == "PROVISION" else "APPROVE_EXACT_STABLE_ROLE_CLOSEOUT"
    need(approval.get("decision") == expected_decision, "APPROVAL_BINDING")
    need(approval.get("operationId") == plan["operationId"] and approval.get("planSha256") == digest(plan), "APPROVAL_BINDING")
    need(approval.get("sourceSha256") == source_sha256 and approval.get("proposalSha256") == proposal_sha256, "APPROVAL_BINDING")
    return deadline


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, message, headers, newurl):
        return None


class NativeIO:
    def cli(self, command, deadline):
        timeout = max(0.1, deadline - time.time())
        try:
            completed = subprocess.run(command, capture_output=True, timeout=timeout, check=False)
        except subprocess.TimeoutExpired:
            raise CliFailure("TIMEOUT")
        if completed.returncode != 0:
            try:
                stderr = completed.stderr[:65536].decode("utf-8", errors="replace")
            except (AttributeError, TypeError):
                stderr = ""
            raise CliFailure(classify_cli_failure(stderr))
        try:
            return completed.stdout.decode("utf-8").strip()
        except UnicodeDecodeError:
            raise Stop("CLI_SHAPE")

    def https(self, method, url, headers, body, deadline):
        payload = None if body is None else json.dumps(body, sort_keys=True, separators=(",", ":")).encode()
        request = urllib.request.Request(url, data=payload, headers=headers, method=method)
        opener = urllib.request.build_opener(NoRedirect())
        try:
            with opener.open(request, timeout=max(0.1, deadline - time.time())) as response:
                status = response.status
                raw = response.read(1048577)
        except urllib.error.HTTPError as error:
            status = error.code
            raw = error.read(1048577)
        except TimeoutError:
            if method == "POST" and url.startswith(IAM_BASE):
                raise LostResponse()
            raise HttpFailure("TIMEOUT")
        except urllib.error.URLError:
            if method == "POST" and url.startswith(IAM_BASE):
                raise LostResponse()
            raise HttpFailure("TRANSPORT")
        if len(raw) > 1048576:
            raise HttpFailure("HTTP_SHAPE")
        if not raw:
            value = {}
        else:
            try:
                value = json.loads(raw)
            except (UnicodeDecodeError, json.JSONDecodeError):
                raise HttpFailure("HTTP_SHAPE")
        if not isinstance(value, dict):
            raise HttpFailure("HTTP_SHAPE")
        return status, value


class NativeProvisioner:
    def __init__(self, plan, approval, io, directory, source_sha256, proposal_sha256, clock=time.time):
        self.plan = plan
        self.io = io
        self.directory = Path(directory)
        self.clock = clock
        self.last = clock()
        self.deadline = authorize_native(plan, approval, source_sha256, proposal_sha256, self.last)
        need(plan["action"] == "PROVISION", "ROLE_PLAN")
        need(not self.directory.is_symlink() and stat.S_IMODE(self.directory.stat().st_mode) == 0o700, "DIRECTORY")
        self.cli_count = 0
        self.https_count = 0
        self.interrupted = False
        self.failed_stage = None
        self.error_category = None
        self.policy_shapes = {}
        self.journal = {"attempted": [], "created": [], "unknown": [], "verified": []}

    def check(self):
        now = self.clock()
        need(now >= self.last, "CLOCK_ROLLBACK")
        self.last = now
        need(now < self.deadline, "DEADLINE")
        need(not self.interrupted, "INTERRUPTED")

    def cli(self, command, stage):
        self.check()
        self.cli_count += 1
        need(self.cli_count <= CLI_LIMIT, "COMMAND_LIMIT")
        try:
            value = self.io.cli(command, self.deadline)
        except CliFailure as error:
            self.failed_stage = stage
            self.error_category = error.category
            raise Stop("COMMAND_FAILED")
        except Stop:
            self.failed_stage = stage
            self.error_category = self.error_category or "UNKNOWN"
            raise
        except BaseException:
            self.failed_stage = stage
            self.error_category = "UNKNOWN"
            raise Stop("COMMAND_FAILED")
        self.check()
        return value

    def https(self, method, url, headers, stage, body=None, mutation=False):
        self.check()
        self.https_count += 1
        need(self.https_count <= HTTPS_LIMIT, "COMMAND_LIMIT")
        try:
            value = self.io.https(method, url, headers, body, self.deadline)
        except LostResponse:
            self.failed_stage = stage
            self.error_category = "TRANSPORT"
            raise Stop("LOST_RESPONSE")
        except HttpFailure as error:
            self.failed_stage = stage
            self.error_category = error.category
            raise Stop("COMMAND_FAILED")
        except Stop:
            self.failed_stage = stage
            self.error_category = self.error_category or "UNKNOWN"
            raise
        except BaseException:
            self.failed_stage = stage
            self.error_category = "UNKNOWN"
            raise Stop("COMMAND_FAILED")
        try:
            self.check()
        except BaseException:
            if mutation:
                self.failed_stage = stage
                self.error_category = "TIMEOUT" if not self.interrupted else "UNKNOWN"
                raise Stop("INTERRUPTED" if self.interrupted else "DEADLINE")
            raise
        return value

    def save(self):
        atomic(self.directory / "native-journal.json", self.journal)

    def run(self):
        reserve(self.directory / "native-attempt.json", {"operationId": self.plan["operationId"], "planSha256": digest(self.plan)})
        previous = {item: signal.getsignal(item) for item in (signal.SIGINT, signal.SIGTERM)}
        for item in previous:
            signal.signal(item, lambda *_: setattr(self, "interrupted", True))
        result = None
        bearer = None
        try:
            commands = native_cli_commands()
            owner = self.cli(commands[0], CLI_STAGES[0])
            project = self.cli(commands[1], CLI_STAGES[1])
            bearer = self.cli(commands[2], CLI_STAGES[2])
            cli_need(self, owner == OWNER, "OWNER_BINDING", CLI_STAGES[0])
            cli_need(self, project == PROJECT, "PROJECT_BINDING", CLI_STAGES[1])
            cli_need(self, isinstance(bearer, str) and 20 <= len(bearer) <= 8192, "CLI_SHAPE", CLI_STAGES[2])
            project_policy = cli_json(self, self.cli(commands[3], CLI_STAGES[3]), CLI_STAGES[3])
            identity_policy = cli_json(self, self.cli(commands[4], CLI_STAGES[4]), CLI_STAGES[4])
            self.policy_shapes["project"] = policy_shape(project_policy)
            try:
                bindings_absent(project_policy)
            except Stop:
                self.failed_stage = CLI_STAGES[3]
                self.error_category = "UNKNOWN"
                raise
            self.policy_shapes["identity"] = policy_shape(identity_policy)
            try:
                bindings_absent(identity_policy)
            except Stop:
                self.failed_stage = CLI_STAGES[4]
                self.error_category = "UNKNOWN"
                raise
            headers = {"Authorization": "Bearer " + bearer, "Accept": "application/json"}
            post_headers = {**headers, "Content-Type": "application/json"}
            status, project_result = self.https("GET", project_url(), headers, HTTPS_STAGES[0])
            https_need(self, status == 200, "HTTP_STATUS", HTTPS_STAGES[0], "HTTP_STATUS")
            try:
                project_number = exact_project(project_result)
            except Stop as error:
                self.failed_stage = HTTPS_STAGES[0]
                self.error_category = "HTTP_SHAPE"
                raise error
            status, service_result = self.https("GET", service_url(project_number), headers, HTTPS_STAGES[1])
            https_need(self, status == 200, "HTTP_STATUS", HTTPS_STAGES[1], "HTTP_STATUS")
            try:
                exact_service(service_result, project_number)
            except Stop as error:
                self.failed_stage = HTTPS_STAGES[1]
                self.error_category = "BILLING_OR_SERVICE_DISABLED" if error.args[0] == "IAM_API_DISABLED" else "HTTP_SHAPE"
                raise error
            project_number = None
            status, permission_result = self.https("POST", permission_url(), post_headers, HTTPS_STAGES[2], {"permissions": list(PERMISSIONS)})
            https_need(self, status == 200 and set(permission_result) == {"permissions"}, "HTTP_SHAPE", HTTPS_STAGES[2])
            granted = permission_result["permissions"]
            https_need(self, isinstance(granted, list) and all(isinstance(item, str) for item in granted), "HTTP_SHAPE", HTTPS_STAGES[2])
            https_need(self, len(granted) == len(PERMISSIONS) and set(granted) == set(PERMISSIONS), "PERMISSION_DENIED", HTTPS_STAGES[2], "HTTP_STATUS")
            for index, role in enumerate(ROLES):
                stage = HTTPS_STAGES[3 + index]
                status, _ = self.https("GET", role_url(role), headers, stage)
                https_need(self, status == 404, "COLLISION" if status == 200 else "HTTP_STATUS", stage, "HTTP_STATUS")
            for index, role in enumerate(ROLES):
                stage = HTTPS_STAGES[5 + index]
                self.journal["attempted"].append(role["kind"])
                self.save()
                try:
                    status, _ = self.https("POST", create_url(role), post_headers, stage, create_body(role), mutation=True)
                    https_need(self, status == 200, "HTTP_STATUS", stage, "HTTP_STATUS")
                except BaseException:
                    self.journal["unknown"].append(role["kind"])
                    self.save()
                    raise
                self.journal["created"].append(role["kind"])
                self.save()
            definitions = {}
            for index, role in enumerate(ROLES):
                stage = HTTPS_STAGES[7 + index]
                status, value = self.https("GET", role_url(role), headers, stage)
                https_need(self, status == 200, "HTTP_STATUS", stage, "HTTP_STATUS")
                try:
                    definitions[role["kind"]] = digest(exact_definition(value, role))
                except Stop:
                    self.failed_stage = stage
                    self.error_category = "HTTP_SHAPE"
                    raise
                self.journal["verified"].append(role["kind"])
                self.save()
            result = {
                "status": "P08_EXACT_ROLES_CREATED_RETAINED_UNBOUND",
                "createdCount": 2, "verifiedCount": 2, "retainedUnbound": True,
                "definitionSha256": definitions, "cliCompleted": self.cli_count,
                "httpsCompleted": self.https_count, "callsCompleted": self.cli_count + self.https_count,
                "policyShapes": self.policy_shapes,
                "rawOutputRetained": False, "privateInputsAbsent": False,
            }
        except BaseException as error:
            result = {
                "status": "P08_EXACT_ROLE_PROVISIONING_STOP_UNKNOWN_OWNERSHIP",
                "reason": safe_reason(error), "createdCount": len(self.journal["created"]),
                "unknownCount": len(self.journal["unknown"]), "cliCompleted": self.cli_count,
                "httpsCompleted": self.https_count, "callsCompleted": self.cli_count + self.https_count,
                "failedStage": self.failed_stage, "errorCategory": self.error_category,
                "policyShapes": self.policy_shapes,
                "rawOutputRetained": False, "privateInputsAbsent": False,
            }
        finally:
            bearer = None
            for item, handler in previous.items():
                signal.signal(item, handler)
            atomic(self.directory / "native-result.json", result)
        return result


class NativeCloseout:
    def __init__(self, plan, approval, io, directory, source_sha256, proposal_sha256, clock=time.time):
        self.plan = plan
        self.io = io
        self.directory = Path(directory)
        self.clock = clock
        self.last = clock()
        self.deadline = authorize_native(plan, approval, source_sha256, proposal_sha256, self.last)
        need(plan["action"] == "CLOSEOUT", "ROLE_PLAN")
        need(not self.directory.is_symlink() and stat.S_IMODE(self.directory.stat().st_mode) == 0o700, "DIRECTORY")
        self.cli_count = 0
        self.https_count = 0
        self.interrupted = False
        self.failed_stage = None
        self.error_category = None

    def check(self):
        now = self.clock()
        need(now >= self.last, "CLOCK_ROLLBACK")
        self.last = now
        need(now < self.deadline, "DEADLINE")
        need(not self.interrupted, "INTERRUPTED")

    def cli(self, command, stage):
        self.check()
        self.cli_count += 1
        need(self.cli_count <= CLI_LIMIT, "COMMAND_LIMIT")
        try:
            value = self.io.cli(command, self.deadline)
        except CliFailure as error:
            self.failed_stage = stage
            self.error_category = error.category
            raise Stop("COMMAND_FAILED")
        except Stop:
            self.failed_stage = stage
            self.error_category = self.error_category or "UNKNOWN"
            raise
        except BaseException:
            self.failed_stage = stage
            self.error_category = "UNKNOWN"
            raise Stop("COMMAND_FAILED")
        self.check()
        return value

    def https(self, method, url, headers, stage):
        self.check()
        self.https_count += 1
        need(self.https_count <= HTTPS_LIMIT, "COMMAND_LIMIT")
        try:
            value = self.io.https(method, url, headers, None, self.deadline)
        except HttpFailure as error:
            self.failed_stage = stage
            self.error_category = error.category
            raise Stop("COMMAND_FAILED")
        except Stop:
            self.failed_stage = stage
            self.error_category = self.error_category or "UNKNOWN"
            raise
        except BaseException:
            self.failed_stage = stage
            self.error_category = "UNKNOWN"
            raise Stop("COMMAND_FAILED")
        self.check()
        return value

    def run(self):
        reserve(self.directory / "native-closeout-attempt.json", {"operationId": self.plan["operationId"], "planSha256": digest(self.plan)})
        previous = {item: signal.getsignal(item) for item in (signal.SIGINT, signal.SIGTERM)}
        for item in previous:
            signal.signal(item, lambda *_: setattr(self, "interrupted", True))
        bearer = None
        reconciled, absent, residuals = [], [], []
        try:
            commands = native_cli_commands()
            owner = self.cli(commands[0], CLI_STAGES[0])
            project = self.cli(commands[1], CLI_STAGES[1])
            bearer = self.cli(commands[2], CLI_STAGES[2])
            cli_need(self, owner == OWNER, "OWNER_BINDING", CLI_STAGES[0])
            cli_need(self, project == PROJECT, "PROJECT_BINDING", CLI_STAGES[1])
            cli_need(self, isinstance(bearer, str) and 20 <= len(bearer) <= 8192, "CLI_SHAPE", CLI_STAGES[2])
            for index in (3, 4):
                try:
                    bindings_absent(cli_json(self, self.cli(commands[index], CLI_STAGES[index]), CLI_STAGES[index]))
                except Stop:
                    self.failed_stage = CLI_STAGES[index]
                    self.error_category = self.error_category or "UNKNOWN"
                    raise
            headers = {"Authorization": "Bearer " + bearer, "Accept": "application/json"}
            for index, role in enumerate(ROLES):
                status, value = self.https("GET", role_url(role), headers, CLOSEOUT_HTTPS_STAGES[index])
                if status == 404:
                    absent.append(role["kind"])
                elif status == 200:
                    exact_definition(value, role)
                    reconciled.append(role["kind"])
                else:
                    residuals.append(role["kind"])
        except BaseException as error:
            residuals.append(safe_reason(error))
        finally:
            bearer = None
            for item, handler in previous.items():
                signal.signal(item, handler)
        result = {
            "status": "P08_EXACT_ROLE_CLOSEOUT_VERIFIED" if not residuals else "P08_EXACT_ROLE_CLOSEOUT_UNCONFIRMED",
            "reconciledRetainedCount": len(reconciled), "absentCount": len(absent),
            "residualCount": len(residuals), "cliCompleted": self.cli_count,
            "httpsCompleted": self.https_count, "callsCompleted": self.cli_count + self.https_count,
            "failedStage": self.failed_stage, "errorCategory": self.error_category,
            "retainedUnbound": bool(reconciled) and not residuals,
            "rawOutputRetained": False, "privateInputsAbsent": False,
        }
        atomic(self.directory / "native-closeout.json", result)
        return result


def run_bound(directory, expected_source_sha256, expected_proposal_sha256, io=None, clock=time.time):
    directory = Path(directory)
    need(not directory.is_symlink() and stat.S_IMODE(directory.stat().st_mode) == 0o700, "DIRECTORY")
    plan_path = directory / "launch-plan.json"
    approval_path = directory / "owner-approval.json"
    result = None
    try:
        plan = private_json(plan_path)
        approval = private_json(approval_path)
        source_sha256 = hashlib.sha256(Path(__file__).read_bytes()).hexdigest()
        need(source_sha256 == expected_source_sha256, "SOURCE_BINDING")
        controller_type = NativeProvisioner if plan.get("action") == "PROVISION" else NativeCloseout
        controller = controller_type(plan, approval, io or NativeIO(), directory, source_sha256, expected_proposal_sha256, clock)
        result = controller.run()
    finally:
        for path in (plan_path, approval_path):
            try:
                path.unlink()
            except FileNotFoundError:
                pass
    result["privateInputsAbsent"] = not plan_path.exists() and not approval_path.exists()
    output = "native-result.json" if plan["action"] == "PROVISION" else "native-closeout.json"
    atomic(directory / output, result)
    return result


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


def policy_shape(value):
    if not isinstance(value, dict) or not set(value) <= {"bindings", "etag", "version"}:
        return "INVALID"
    if "bindings" not in value:
        return "ABSENT"
    bindings = value["bindings"]
    if bindings is None:
        return "NULL"
    if not isinstance(bindings, list):
        return "INVALID"
    if not bindings:
        return "EMPTY_LIST"
    if not all(isinstance(binding, dict) and isinstance(binding.get("role"), str) for binding in bindings):
        return "INVALID"
    return "NONEMPTY_LIST"


def bindings_absent(value):
    shape = policy_shape(value)
    need(shape != "INVALID", "ROLE_DRIFT")
    bindings = value.get("bindings") or []
    role_names = {role["name"] for role in ROLES}
    for binding in bindings:
        if binding["role"] in role_names:
            raise Stop("BINDING_PRESENT")
    return shape


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
    if len(argv) == 4 and argv[0] in {"--provision-bound", "--closeout-bound"}:
        try:
            result = run_bound(argv[1], argv[2], argv[3])
        except BaseException as error:
            print("P08_EXACT_ROLE_PROVISIONER_REFUSED_" + safe_reason(error))
            return 2
        print(result["status"])
        successes = {"P08_EXACT_ROLES_CREATED_RETAINED_UNBOUND", "P08_EXACT_ROLE_CLOSEOUT_VERIFIED"}
        return 0 if result["status"] in successes else 3
    print("P08_EXACT_ROLE_PROVISIONER_USAGE_REFUSED")
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
