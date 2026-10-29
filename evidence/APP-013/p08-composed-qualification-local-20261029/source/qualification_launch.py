"""Disabled P08 read-only qualification launch binding.

The native entry is deliberately unbound. Tests inject a transport and prove the
exact future command/request/SQL contract without resolving credentials or
making external calls.
"""
from __future__ import annotations

import copy
import getpass
import importlib.util
import json
import os
import re
import subprocess
import stat
import sys
import urllib.error
import urllib.request
from pathlib import Path

import composed_qualification as model


GCLOUD = "/opt/homebrew/bin/gcloud"
PSQL = "/opt/homebrew/bin/psql"
REGION = "us-east5"
SERVICE = "signmons-calldesk-staging"
REVISION = "signmons-calldesk-staging-app013p07atomic1"
SECRETS = tuple(f"signmons-staging-p07-{name}" for name in (
    "payment-database-url", "stripe-webhook-secret", "disabled-openai-key",
    "admin-token", "conversation-key", "technician-link-key",
))
POLICY_SECRETS = SECRETS + ("signmons-staging-stripe-secret-key",)
APPROVAL_SHA256 = "1225d18577221bff810c6d5b4633df937a3fd9d6dd3ae91265ec4d9c6dbd247e"
MAX_OUTPUT = 65536


def need(value, code):
    if not value:
        raise model.Stop(code)


def cli_contract(billing_account="<bound-account>"):
    fixed = [
        ("owner", ["auth", "list", "--filter=status:ACTIVE", "--format=json(account,status)"]),
        ("config", ["config", "list", "--format=json(core.project,auth.impersonate_service_account,auth.login_config_file,auth.credential_file_override)"]),
        ("project", ["projects", "describe", model.PROJECT, "--format=json(projectId,projectNumber,lifecycleState)"]),
        ("billing_project", ["billing", "projects", "describe", model.PROJECT, "--format=json(billingAccountName,billingEnabled,projectId)"]),
        ("billing_account", ["billing", "accounts", "describe", billing_account, "--format=json(open)"]),
        ("service", ["run", "services", "describe", SERVICE, "--project", model.PROJECT, "--region", REGION, "--format=json(metadata.name,spec.template.spec.serviceAccountName,status.traffic,status.latestReadyRevisionName)"]),
        ("revision", ["run", "revisions", "describe", REVISION, "--project", model.PROJECT, "--region", REGION, "--format=json(metadata.name,spec.serviceAccountName,spec.containers,status.conditions)"]),
        ("identity", ["iam", "service-accounts", "describe", model.IDENTITY, "--project", model.PROJECT, "--format=json(email,disabled,uniqueId)"]),
    ]
    fixed += [(f"secret_state_{i}", ["secrets", "versions", "describe", "1", "--secret", secret, "--project", model.PROJECT, "--format=json(name,state)"]) for i, secret in enumerate(SECRETS)]
    fixed += [(f"secret_policy_{i}", ["secrets", "get-iam-policy", secret, "--project", model.PROJECT, "--format=json(bindings,etag,version)"]) for i, secret in enumerate(POLICY_SECRETS)]
    fixed += [
        ("project_policy", ["projects", "get-iam-policy", model.PROJECT, "--format=json(bindings,etag,version)"]),
        ("identity_policy", ["iam", "service-accounts", "get-iam-policy", model.IDENTITY, "--project", model.PROJECT, "--format=json(bindings,etag,version)"]),
        ("lookup_role", ["iam", "roles", "describe", "signmonsP08FirebaseUserLookup", "--project", model.PROJECT, "--format=json(name,includedPermissions,stage,deleted)"]),
        ("signing_role", ["iam", "roles", "describe", "signmonsP08ServiceAccountSignBlob", "--project", model.PROJECT, "--format=json(name,includedPermissions,stage,deleted)"]),
        ("token", ["auth", "print-access-token"]),
    ]
    need(len(fixed) == 26, "CLI_CONTRACT_COUNT")
    return tuple({"id": name, "argv": (GCLOUD, *args)} for name, args in fixed)


def https_contract(project_number, key_id, firebase_uid):
    need(re.fullmatch(r"[0-9]{6,20}", project_number or ""), "PROJECT_NUMBER")
    need(re.fullmatch(r"signmons-p08-[a-f0-9]{32}", key_id or ""), "KEY_ID")
    need(re.fullmatch(r"[0-9a-f-]{36}", firebase_uid or ""), "FIREBASE_UID")
    base = "https://serviceusage.googleapis.com/v1/projects/" + project_number + "/services/"
    rows = [("service_" + str(i), "GET", base + service, None) for i, service in enumerate(model.SERVICES)]
    rows += [
        ("project_permissions", "POST", f"https://cloudresourcemanager.googleapis.com/v1/projects/{project_number}:testIamPermissions", {"permissions": [p for p in model.PERMISSIONS if p not in model.PERMISSIONS[2:4]]}),
        ("identity_permissions", "POST", f"https://iam.googleapis.com/v1/projects/-/serviceAccounts/{model.IDENTITY}:testIamPermissions", {"permissions": list(model.PERMISSIONS[2:4])}),
        ("key_absence", "GET", f"https://apikeys.googleapis.com/v2/projects/{project_number}/locations/global/keys/{key_id}", None),
        ("firebase", "POST", f"https://identitytoolkit.googleapis.com/v1/projects/{model.PROJECT}/accounts:lookup", {"localId": [firebase_uid]}),
    ]
    need(len(rows) == 10, "HTTPS_CONTRACT_COUNT")
    return tuple({"id": name, "method": method, "url": url, "body": body} for name, method, url, body in rows)


QUALIFICATION_SQL = """BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;\nSELECT json_build_object('jobExact',j.id=$1::uuid,'tenantActive',t.id=$2::uuid AND t.status='ACTIVE','paymentGateExact',j.\"humanReviewed\"=TRUE,'calendarAbsent',NOT EXISTS(SELECT 1 FROM \"Booking\" b WHERE b.\"jobId\"=j.id),'operatorExactDisabled',u.id=$3::uuid AND u.\"tenantId\"=t.id AND u.role='ADMIN' AND u.status='DISABLED','dbRoleRetired',NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname=$4),'sessionsAbsent',NOT EXISTS(SELECT 1 FROM pg_stat_activity WHERE application_name=$5 AND pid<>pg_backend_pid()),'ownershipReceiptExact',$6=$7) FROM \"Job\" j JOIN \"Tenant\" t ON t.id=j.\"tenantId\" LEFT JOIN \"User\" u ON u.\"tenantId\"=t.id WHERE j.id=$1::uuid AND t.id=$2::uuid;\nCOMMIT;"""
CLOSEOUT_SQL = "SELECT json_build_object('sessionsAbsent',NOT EXISTS(SELECT 1 FROM pg_stat_activity WHERE application_name=$1 AND pid<>pg_backend_pid()));"


def sql_contract():
    return (
        {"id": "qualification", "sql": QUALIFICATION_SQL, "readOnly": True},
        {"id": "closeout", "sql": CLOSEOUT_SQL, "readOnly": True},
    )


def validate_binding(binding, plan, now, mode="qualify"):
    need(binding.get("mode") == "P08_READ_ONLY_QUALIFICATION_LAUNCH", "LAUNCH_MODE")
    need(binding.get("proposalSha256") == APPROVAL_SHA256, "APPROVAL_BINDING")
    need(binding.get("planSha256") == model.digest(plan), "PLAN_BINDING")
    need(binding.get("sourceManifestSha256") == source_manifest_sha256(), "MANIFEST_BINDING")
    need(binding.get("externalReadAuthorized") is True and binding.get("mutationsAuthorized") is False, "READ_ONLY_AUTHORITY")
    need(binding.get("allowanceUsd") == 0 and binding.get("automaticRetryAllowed") is False, "COST_OR_RETRY")
    need(binding.get("operationId") == plan.get("operationId") and binding.get("prospectiveOperationId") == plan.get("prospectiveOperationId"), "OPERATION_BINDING")
    need(binding.get("cliLimit") == 26 and binding.get("httpsLimit") == 10 and binding.get("sqlLimit") == 2, "CALL_LIMITS")
    need(re.fullmatch(r"billingAccounts/[0-9A-F-]{6,64}", binding.get("billingAccountResource", "")), "BILLING_ACCOUNT_SCOPE")
    approval = binding.get("ownerApproval")
    need(isinstance(approval, dict) and approval == {"decision": "APPROVE_EXACT_P08_READ_ONLY_QUALIFICATION", "owner": "Debynyhan Banks", "operationId": plan.get("operationId"), "bindingSha256": model.digest({k: v for k, v in binding.items() if k not in {"ownerApproval", "databasePassword"}})}, "OWNER_APPROVAL")
    times = model.authorize({**plan, "mode": "LOCAL_COMPOSED_QUALIFICATION_ONLY", "externalReadAuthorized": False}, now, mode=mode)
    return times


def source_manifest_sha256():
    path = model.ROOT / "source-manifest.json"
    need(path.is_file() and not path.is_symlink(), "LOCAL_MANIFEST")
    return model.hashlib.sha256(path.read_bytes()).hexdigest()


def bounded_json(value, code):
    if isinstance(value, bytes):
        need(len(value) <= MAX_OUTPUT, code)
        value = value.decode("utf-8", "strict")
    if isinstance(value, str):
        need(len(value.encode()) <= MAX_OUTPUT, code)
        try:
            value = json.loads(value)
        except json.JSONDecodeError:
            raise model.Stop(code) from None
    need(isinstance(value, (dict, list)), code)
    return value


class Adapter:
    """Turns injected raw transport responses into the accepted strict shapes."""
    def __init__(self, binding, plan, io, clock, mode="qualify"):
        self.binding, self.plan, self.io, self.clock = copy.deepcopy(binding), copy.deepcopy(plan), io, clock
        self.times = validate_binding(self.binding, self.plan, self.clock(), mode=mode)
        self.cli = {}; self.http = {}; self.closed = False; self.token = None
        self.project_number = None; self.firebase_uid = binding["firebaseUid"]

    def _gate(self, cleanup=False):
        need(not self.closed, "CLIENT_CLOSED")
        need(self.clock() < self.times["closeoutEnd" if cleanup else "readEnd"], "LAUNCH_DEADLINE")

    def _cli(self, descriptor):
        self._gate(); value = bounded_json(self.io.cli(descriptor, self.times["readEnd"]), "CLI_OUTPUT")
        self.cli[descriptor["id"]] = value; return value

    def _https(self, descriptor):
        self._gate(); value = self.io.https(descriptor, self.token, self.times["readEnd"])
        need(isinstance(value, dict) and set(value) <= {"status", "body"}, "HTTPS_ENVELOPE")
        status = value.get("status"); need(isinstance(status, int), "HTTPS_STATUS")
        body = bounded_json(value.get("body", {}), "HTTPS_OUTPUT")
        self.http[descriptor["id"]] = {"status": status, "body": body}; return self.http[descriptor["id"]]

    def _prime_cli(self):
        if self.cli: return
        for descriptor in cli_contract(self.binding["billingAccountResource"]):
            value = self._cli(descriptor)
            if descriptor["id"] == "project":
                self.project_number = str(value.get("projectNumber", "")); need(re.fullmatch(r"[0-9]{6,20}", self.project_number), "PROJECT_NUMBER")
            if descriptor["id"] == "token":
                need(set(value) == {"accessToken"} and isinstance(value["accessToken"], str) and 20 <= len(value["accessToken"]) <= 4096, "TOKEN_OUTPUT")
                self.token = value["accessToken"]

    def _prime_http(self):
        if self.http: return
        self._prime_cli()
        for descriptor in https_contract(self.project_number, self.plan["prospectiveKeyId"], self.firebase_uid): self._https(descriptor)

    def read_cloud(self, deadline):
        self._prime_cli()
        owner = self.cli["owner"]; config = self.cli["config"]; project = self.cli["project"]
        bp = self.cli["billing_project"]; ba = self.cli["billing_account"]
        service = self.cli["service"]; revision = self.cli["revision"]; identity = self.cli["identity"]
        secret_states = [self.cli[f"secret_state_{i}"] for i in range(6)]
        secret_policies = [self.cli[f"secret_policy_{i}"] for i in range(7)]
        need(isinstance(owner, list) and len(owner) == 1 and isinstance(owner[0], dict) and set(owner[0]) == {"account", "status"}, "OWNER_OUTPUT")
        need(isinstance(config, dict) and set(config) == {"core", "auth"}, "CONFIG_OUTPUT")
        need(isinstance(project, dict) and set(project) == {"projectId", "projectNumber", "lifecycleState"}, "PROJECT_OUTPUT")
        need(isinstance(bp, dict) and set(bp) == {"billingAccountName", "billingEnabled", "projectId"}, "BILLING_OUTPUT")
        need(isinstance(ba, dict) and set(ba) == {"open"}, "BILLING_OUTPUT")
        containers = revision.get("spec", {}).get("containers", []); need(isinstance(containers, list) and len(containers) == 1, "REVISION_OUTPUT")
        environment = containers[0].get("env", []); need(isinstance(environment, list), "REVISION_OUTPUT")
        traffic = service.get("status", {}).get("traffic", []); need(isinstance(traffic, list), "SERVICE_OUTPUT")
        normal = [x for x in traffic if x.get("revisionName") == self.binding["normalRevision"] and x.get("percent") == 100]
        candidate = [x for x in traffic if x.get("revisionName") == REVISION and x.get("percent", 0) == 0]
        return {
            "ownerExact": owner == [{"account": model.OWNER, "status": "ACTIVE"}],
            "overridesAbsent": config == {"core": {"project": model.PROJECT}, "auth": {}},
            "projectExact": project.get("projectId") == model.PROJECT and project.get("lifecycleState") == "ACTIVE",
            "projectNumberBound": self.project_number == self.binding["projectNumber"],
            "billingEnabled": bp.get("billingEnabled") is True and bp.get("projectId") == model.PROJECT,
            "billingOpen": ba == {"open": True},
            "candidateSourceExact": containers[0].get("image") == self.binding["candidateImage"] and revision.get("spec", {}).get("serviceAccountName") == model.IDENTITY,
            "environmentExact": model.digest(environment) == self.binding["environmentSha256"],
            "candidateReady": any(x.get("type") == "Ready" and x.get("status") == "True" for x in revision.get("status", {}).get("conditions", [])),
            "trafficRetired": len(normal) == 1 and len(candidate) == 1 and not any(x.get("tag") == "app013-p07-atomic" for x in traffic),
            "identityDisabled": identity.get("email") == model.IDENTITY and identity.get("disabled") is True,
            "secretsRetired": all(v.get("state") == "DISABLED" for v in secret_states),
            "secretBindingsAbsent": all(not any(b.get("members") for b in p.get("bindings", []) if model.IDENTITY in b.get("members", [])) for p in secret_policies),
        }

    def read_access(self, deadline):
        self._prime_http()
        roles = [self.cli["lookup_role"], self.cli["signing_role"]]
        services = {}
        for i, service in enumerate(model.SERVICES):
            response = self.http[f"service_{i}"]; state = response["body"].get("state")
            services[service] = state if response["status"] == 200 and state in ("ENABLED", "DISABLED") else "UNKNOWN"
        project_permissions = self.http["project_permissions"]; identity_permissions = self.http["identity_permissions"]
        project_set = set(project_permissions["body"].get("permissions", [])) if project_permissions["status"] == 200 else None
        identity_set = set(identity_permissions["body"].get("permissions", [])) if identity_permissions["status"] == 200 else None
        permissions = {}
        for permission in model.PERMISSIONS:
            allowed = identity_set if permission in model.PERMISSIONS[2:4] else project_set
            permissions[permission] = "UNKNOWN" if allowed is None else "GRANTED" if permission in allowed else "DENIED"
        key = self.http["key_absence"]
        key_absence = "NOT_FOUND" if key["status"] == 404 and key["body"].get("error", {}).get("status") == "NOT_FOUND" else "PRESENT" if key["status"] == 200 else "DENIED" if key["status"] in (401,403) else "UNKNOWN"
        project_policy = self.cli["project_policy"]; identity_policy = self.cli["identity_policy"]
        bindings_absent = all(model.IDENTITY not in b.get("members", []) for p in (project_policy, identity_policy) for b in p.get("bindings", []))
        roles_exact = roles[0] == {"name": model.LOOKUP_ROLE, "includedPermissions": ["firebaseauth.users.get"], "stage": "GA", "deleted": False} and roles[1] == {"name": model.SIGNING_ROLE, "includedPermissions": ["iam.serviceAccounts.signBlob"], "stage": "GA", "deleted": False}
        return {"rolesExact": roles_exact, "bindingsAbsent": bindings_absent, "services": services, "permissions": permissions, "keyAbsence": key_absence}

    def read_database(self, deadline):
        self._prime_http()
        value = bounded_json(self.io.sql(sql_contract()[0], self.binding["databasePassword"], self.times["readEnd"]), "SQL_OUTPUT")
        need(isinstance(value, dict) and set(value) == model.DATABASE_KEYS, "DATABASE_OUTPUT")
        return value

    def read_firebase(self, deadline):
        self._prime_http(); envelope = self.http["firebase"]
        need(envelope["status"] == 200, "FIREBASE_DENIED")
        users = envelope["body"].get("users"); need(isinstance(users, list) and len(users) == 1, "FIREBASE_OUTPUT")
        user = users[0]; expected = self.binding["firebase"]
        return {"existsOne": True, "uidExact": user.get("localId") == self.firebase_uid, "disabled": user.get("disabled") is True, "identityExact": user.get("email") == expected["email"] and user.get("displayName") == expected["displayName"], "claimsExact": user.get("customAttributes") == expected["customAttributes"], "tokensRevoked": user.get("tokensValidAfterTime") == expected["tokensValidAfterTime"]}

    def closeout(self, deadline):
        try:
            value = bounded_json(self.io.sql(sql_contract()[1], self.binding["databasePassword"], self.times["closeoutEnd"]), "CLOSEOUT_OUTPUT")
            return value == {"sessionsAbsent": True} and self.io.close(self.times["closeoutEnd"]) is True
        finally:
            self.token = None; self.binding["databasePassword"] = None; self.closed = True


def _operator_module():
    path = model.SOURCE_PATHS["operator"]
    spec = importlib.util.spec_from_file_location("p08_locked_operator", path)
    need(spec is not None and spec.loader is not None, "OPERATOR_SOURCE")
    module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
    return module


class NativeIO:
    """Future exact transport. Construction occurs only after all public gates."""
    def __init__(self, clock):
        self.clock = clock; self.children = set(); self.closed = False

    def cli(self, descriptor, deadline):
        need(not self.closed and self.clock() < deadline, "CLI_DEADLINE")
        argv = descriptor["argv"]; need(argv and argv[0] == GCLOUD, "CLI_EXECUTABLE")
        env = {k: v for k, v in os.environ.items() if not k.startswith("PG") and k != "DATABASE_URL" and k not in {"GOOGLE_APPLICATION_CREDENTIALS", "CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE", "CLOUDSDK_AUTH_IMPERSONATE_SERVICE_ACCOUNT", "CLOUDSDK_AUTH_ACCESS_TOKEN", "CLOUDSDK_AUTH_ACCESS_TOKEN_FILE"}}
        timeout = max(1, min(30, int(deadline - self.clock())))
        try:
            result = subprocess.run(argv, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, env=env, timeout=timeout, check=False)
        except subprocess.TimeoutExpired:
            raise model.Stop("CLI_TIMEOUT") from None
        need(result.returncode == 0 and len(result.stdout) <= MAX_OUTPUT, "CLI_REFUSED")
        if descriptor["id"] == "token":
            token = result.stdout.decode("utf-8", "strict").strip(); need(20 <= len(token) <= 4096, "TOKEN_OUTPUT"); return {"accessToken": token}
        return result.stdout

    def https(self, descriptor, token, deadline):
        need(not self.closed and self.clock() < deadline and isinstance(token, str), "HTTPS_DEADLINE")
        body = None if descriptor["body"] is None else json.dumps(descriptor["body"], separators=(",", ":")).encode()
        request = urllib.request.Request(descriptor["url"], data=body, method=descriptor["method"], headers={"Authorization": "Bearer " + token, "Content-Type": "application/json", "x-goog-user-project": model.PROJECT})
        timeout = max(1, min(15, int(deadline - self.clock())))
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                raw = response.read(MAX_OUTPUT + 1); status = response.status
        except urllib.error.HTTPError as error:
            status = error.code; raw = error.read(MAX_OUTPUT + 1)
        except (OSError, TimeoutError):
            raise model.Stop("HTTPS_REFUSED") from None
        need(len(raw) <= MAX_OUTPUT, "HTTPS_OUTPUT")
        return {"status": status, "body": raw or b"{}"}

    def sql(self, descriptor, password, deadline):
        need(not self.closed and self.clock() < deadline and isinstance(password, str) and password, "SQL_DEADLINE")
        operator = _operator_module()
        sql = operator.QUALIFICATION_SQL if descriptor["id"] == "qualification" else operator.CLOSEOUT_SQL if descriptor["id"] == "closeout" else None
        need(sql is not None, "SQL_ALLOWLIST")
        with operator.phase_guard(deadline, cleanup=descriptor["id"] == "closeout"):
            raw = operator.psql_read(password, sql)
        if descriptor["id"] == "closeout": return {"sessionsAbsent": raw == "0"}
        normalized = operator.normalize_database(raw)
        need(normalized.get("actorId") and normalized.get("actorRole") in ("OWNER", "ADMIN"), "DATABASE_OUTPUT")
        return {key: True for key in model.DATABASE_KEYS}

    def close(self, deadline):
        self.closed = True
        return not self.children


def private_json(path):
    path = Path(path); info = path.lstat()
    need(stat.S_ISREG(info.st_mode) and not path.is_symlink() and stat.S_IMODE(info.st_mode) == 0o600, "PRIVATE_INPUT")
    value = json.loads(path.read_text()); need(isinstance(value, dict), "PRIVATE_INPUT")
    return value


def native(argv=None):
    model.verify_local_manifest(); model.verify_locked_sources()
    argv = sys.argv[1:] if argv is None else argv
    if len(argv) != 4 or argv[0] not in ("--qualify", "--closeout"):
        print("P08_COMPOSED_QUALIFICATION_LAUNCH_REFUSED_UNBOUND"); return 2
    plan = private_json(argv[1]); binding = private_json(argv[2]); directory = Path(argv[3])
    mode = "qualify" if argv[0] == "--qualify" else "closeout"
    validate_binding(binding, plan, model.time.time(), mode=mode)
    need(directory.is_dir() and not directory.is_symlink() and stat.S_IMODE(directory.stat().st_mode) == 0o700, "PRIVATE_DIRECTORY")
    if mode == "closeout":
        attempt = private_json(directory / "attempt.json"); journal = private_json(directory / "journal.json")
        need(attempt.get("operationId") == plan["operationId"] and attempt.get("planSha256") == model.digest(plan), "CLOSEOUT_SCOPE")
        need(journal.get("operationId") == plan["operationId"] and journal.get("planSha256") == model.digest(plan), "CLOSEOUT_SCOPE")
        reserve_path = directory / "closeout-attempt.json"
        model.reserve(reserve_path, {"operationId": plan["operationId"], "planSha256": model.digest(plan)})
    password = getpass.getpass("Enter current CHILD administrator password (hidden): ")
    need(password, "PASSWORD_EMPTY"); binding["databasePassword"] = password
    transport = NativeIO(model.time.time); adapter = Adapter(binding, plan, transport, model.time.time, mode=mode)
    try:
        if mode == "closeout":
            closed = adapter.closeout(adapter.times["closeoutEnd"])
            print("P08_COMPOSED_QUALIFICATION_CLOSEOUT_VERIFIED" if closed else "CONTAINMENT_UNCONFIRMED")
            return 0 if closed else 2
        result = model.Coordinator(plan, adapter, directory).run()
        print(result["status"]); return 0 if result["verdict"] == "QUALIFIED" else 2
    finally:
        password = ""


if __name__ == "__main__":
    raise SystemExit(native())
