"""Disabled P08 read-only qualification launch binding.

The native entry is deliberately unbound. Tests inject a transport and prove the
exact future command/request/SQL contract without resolving credentials or
making external calls.
"""
from __future__ import annotations

import copy
import hashlib
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
LOCAL_PREPARATION_SHA256 = "c9a8f5e6ac9a1725b747e12033acef006af58f10f06c0fa58ad2d0f6bce1da9a"
PROJECT_NUMBER_SHA256 = "37d4aa0f46ca5b8f0b81b1148bda235a0f4a9a424b6b4638ec993d889563be54"
BILLING_ACCOUNT_SHA256 = "df8c89e72b72b59ac6b06c0a20fa7d5f85a15b5d6d7450ff57a72722be172935"
TARGET_SHA256 = "23d7b71141e7cdba27558c97333e6821fc76ec872a84cdc2f2f19a980bee029c"
TARGET_EMAIL = "debynyhan@signmons.com"
TARGET_NAME = "Signmons Test Administrator"
REVOCATION_LOWER_BOUND_MS = 1793020648538
MAX_OUTPUT = 65536
HTTPS_DESCRIPTOR_IDS = frozenset({*(f"service_{i}" for i in range(6)), "project_permissions", "identity_permissions", "key_absence", "firebase"})
CREDENTIAL_OVERRIDE_KEYS = {
    "GOOGLE_APPLICATION_CREDENTIALS",
    "CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE",
    "CLOUDSDK_AUTH_IMPERSONATE_SERVICE_ACCOUNT",
    "CLOUDSDK_AUTH_ACCESS_TOKEN",
    "CLOUDSDK_AUTH_ACCESS_TOKEN_FILE",
}


def need(value, code):
    if not value:
        raise model.Stop(code)


def cli_contract(billing_account="<discovered-account>"):
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


def access_https_contract(project_number, key_id):
    need(re.fullmatch(r"[0-9]{6,20}", project_number or ""), "PROJECT_NUMBER")
    need(re.fullmatch(r"signmons-p08-[a-f0-9]{32}", key_id or ""), "KEY_ID")
    base = "https://serviceusage.googleapis.com/v1/projects/" + project_number + "/services/"
    rows = [("service_" + str(i), "GET", base + service, None) for i, service in enumerate(model.SERVICES)]
    rows += [
        ("project_permissions", "POST", f"https://cloudresourcemanager.googleapis.com/v1/projects/{project_number}:testIamPermissions", {"permissions": [p for p in model.PERMISSIONS if p not in model.PERMISSIONS[2:4]]}),
        ("identity_permissions", "POST", f"https://iam.googleapis.com/v1/projects/-/serviceAccounts/{model.IDENTITY}:testIamPermissions", {"permissions": list(model.PERMISSIONS[2:4])}),
        ("key_absence", "GET", f"https://apikeys.googleapis.com/v2/projects/{project_number}/locations/global/keys/{key_id}", None),
    ]
    need(len(rows) == 9, "HTTPS_CONTRACT_COUNT")
    return tuple({"id": name, "method": method, "url": url, "body": body} for name, method, url, body in rows)


def firebase_https_contract(firebase_uid):
    need(re.fullmatch(r"[0-9a-f-]{36}", firebase_uid or ""), "FIREBASE_UID")
    return {"id": "firebase", "method": "POST", "url": f"https://identitytoolkit.googleapis.com/v1/projects/{model.PROJECT}/accounts:lookup", "body": {"localId": [firebase_uid]}}


QUALIFICATION_SQL = f"""BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL statement_timeout='15s'; SET LOCAL lock_timeout='5s';
WITH j AS (SELECT id,\"tenantId\",\"policySnapshot\",\"calendarEventId\" FROM \"Job\" WHERE id='{model.JOB}'::uuid AND \"tenantId\"='{model.TENANT}'::uuid),
t AS (SELECT id,status FROM \"TenantOrganization\" WHERE id='{model.TENANT}'::uuid),
u AS (SELECT id,\"tenantId\",email,\"fullName\",role,status FROM \"User\" WHERE \"tenantId\"='{model.TENANT}'::uuid AND email='{TARGET_EMAIL}')
SELECT json_build_object(
 'jobCount',(SELECT count(*) FROM j),'job',(SELECT row_to_json(j) FROM j),
 'tenantCount',(SELECT count(*) FROM t),'tenant',(SELECT row_to_json(t) FROM t),
 'operatorCount',(SELECT count(*) FROM u),'operator',(SELECT row_to_json(u) FROM u),
 'calendarCount',(SELECT count(*) FROM \"CalendarOperation\" WHERE \"jobId\"='{model.JOB}'::uuid AND \"tenantId\"='{model.TENANT}'::uuid),
 'roleCount',(SELECT count(*) FROM pg_roles WHERE rolname='p07_payment_runtime'),
 'sessionCount',(SELECT count(*) FROM pg_stat_activity WHERE (usename='p07_payment_runtime' OR application_name LIKE 'signmons_p08_qualification_%') AND pid<>pg_backend_pid()));
ROLLBACK;"""
CLOSEOUT_SQL = "SELECT json_build_object('sessionsAbsent',NOT EXISTS(SELECT 1 FROM pg_stat_activity WHERE (usename='p07_payment_runtime' OR application_name LIKE 'signmons_p08_qualification_%') AND pid<>pg_backend_pid()));"


def sql_contract():
    return (
        {"id": "qualification", "sql": QUALIFICATION_SQL, "readOnly": True},
        {"id": "closeout", "sql": CLOSEOUT_SQL, "readOnly": True},
    )


def validate_binding(binding, plan, now, mode="qualify"):
    need(binding.get("mode") == "P08_READ_ONLY_QUALIFICATION_LAUNCH", "LAUNCH_MODE")
    need(binding.get("localPreparationSha256") == LOCAL_PREPARATION_SHA256, "LOCAL_PREPARATION_BINDING")
    need(re.fullmatch(r"[a-f0-9]{64}", binding.get("operationProposalSha256", "")), "OPERATION_PROPOSAL_BINDING")
    need(binding.get("planSha256") == model.digest(plan), "PLAN_BINDING")
    need(binding.get("sourceManifestSha256") == source_manifest_sha256(), "MANIFEST_BINDING")
    need(binding.get("externalReadAuthorized") is True and binding.get("mutationsAuthorized") is False, "READ_ONLY_AUTHORITY")
    need(binding.get("allowanceUsd") == 0 and binding.get("automaticRetryAllowed") is False, "COST_OR_RETRY")
    need(binding.get("operationId") == plan.get("operationId") and binding.get("prospectiveOperationId") == plan.get("prospectiveOperationId"), "OPERATION_BINDING")
    need(binding.get("cliLimit") == 26 and binding.get("httpsLimit") == 10 and binding.get("sqlLimit") == 2, "CALL_LIMITS")
    approval = binding.get("ownerApproval")
    need(isinstance(approval, dict) and approval == {"decision": "APPROVE_EXACT_P08_READ_ONLY_QUALIFICATION", "owner": "Debynyhan Banks", "operationId": plan.get("operationId"), "operationProposalSha256": binding["operationProposalSha256"], "bindingSha256": model.digest({k: v for k, v in binding.items() if k not in {"ownerApproval", "databasePassword"}})}, "OWNER_APPROVAL")
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


def config_output_shape(value):
    if value == {"core": {"project": model.PROJECT}}:
        return "AUTH_SECTION_OMITTED"
    if value == {"core": {"project": model.PROJECT}, "auth": {}}:
        return "AUTH_SECTION_EMPTY"
    raise model.Stop("CONFIG_OUTPUT")


def traffic_retired(traffic, normal_revision):
    need(isinstance(traffic, list) and 0 < len(traffic) <= 20, "SERVICE_OUTPUT")
    seen = set()
    for row in traffic:
        need(isinstance(row, dict), "SERVICE_OUTPUT")
        revision = row.get("revisionName")
        need(isinstance(revision, str) and 0 < len(revision) <= 128 and revision not in seen, "SERVICE_OUTPUT")
        seen.add(revision)
        percent = row.get("percent", 0)
        need(type(percent) is int and 0 <= percent <= 100, "SERVICE_OUTPUT")
        if "tag" in row:
            need(isinstance(row["tag"], str) and len(row["tag"]) <= 128, "SERVICE_OUTPUT")
    normal = [row for row in traffic if row["revisionName"] == normal_revision]
    candidate = [row for row in traffic if row["revisionName"] == REVISION]
    positive = [row for row in traffic if row.get("percent", 0) > 0]
    return (len(normal) == 1 and normal[0].get("percent") == 100
            and len(positive) == 1 and positive[0] is normal[0]
            and (not candidate or (len(candidate) == 1 and candidate[0].get("percent") == 0))
            and not any(row.get("tag") == "app013-p07-atomic" for row in traffic))


class Adapter:
    """Turns injected raw transport responses into the accepted strict shapes."""
    def __init__(self, binding, plan, io, clock, mode="qualify"):
        self.binding, self.plan, self.io, self.clock = copy.deepcopy(binding), copy.deepcopy(plan), io, clock
        self.times = validate_binding(self.binding, self.plan, self.clock(), mode=mode)
        self.cli = {}; self.http = {}; self.closed = False; self.token = None
        self.project_number = None; self.billing_account = None; self.firebase_uid = None

    def _gate(self, cleanup=False):
        need(not self.closed, "CLIENT_CLOSED")
        need(self.clock() < self.times["closeoutEnd" if cleanup else "readEnd"], "LAUNCH_DEADLINE")

    def _cli(self, descriptor):
        self._gate(); value = bounded_json(self.io.cli(descriptor, self.times["readEnd"]), "CLI_OUTPUT")
        self.cli[descriptor["id"]] = value; return value

    def _https(self, descriptor):
        self._gate()
        request_id = descriptor.get("id")
        need(isinstance(request_id, str) and request_id in HTTPS_DESCRIPTOR_IDS, "HTTPS_DESCRIPTOR_SCOPE")
        try:
            value = self.io.https(descriptor, self.token, self.times["readEnd"])
            need(isinstance(value, dict) and set(value) <= {"status", "body"}, "HTTPS_ENVELOPE")
            status = value.get("status"); need(isinstance(status, int), "HTTPS_STATUS")
            body = bounded_json(value.get("body", {}), "HTTPS_OUTPUT")
        except model.Stop as error:
            if str(error) == "HTTPS_OUTPUT":
                raise model.Stop("HTTPS_OUTPUT:" + request_id) from None
            raise
        except UnicodeError:
            raise model.Stop("HTTPS_OUTPUT:" + request_id) from None
        self.http[descriptor["id"]] = {"status": status, "body": body}; return self.http[descriptor["id"]]

    def _prime_cli(self):
        if self.cli: return
        for descriptor in cli_contract():
            if descriptor["id"] == "billing_account":
                need(self.billing_account is not None, "BILLING_ACCOUNT_UNBOUND")
                descriptor = {**descriptor, "argv": tuple(self.billing_account if part == "<discovered-account>" else part for part in descriptor["argv"])}
            value = self._cli(descriptor)
            if descriptor["id"] == "project":
                self.project_number = str(value.get("projectNumber", "")); need(re.fullmatch(r"[0-9]{6,20}", self.project_number), "PROJECT_NUMBER")
                need(model.digest(self.project_number) == PROJECT_NUMBER_SHA256, "PROJECT_NUMBER_FINGERPRINT")
            if descriptor["id"] == "billing_project":
                self.billing_account = value.get("billingAccountName")
                need(re.fullmatch(r"billingAccounts/[0-9A-F-]{6,64}", self.billing_account or ""), "BILLING_ACCOUNT_SCOPE")
                need(hashlib.sha256(self.billing_account.encode()).hexdigest() == BILLING_ACCOUNT_SHA256, "BILLING_ACCOUNT_FINGERPRINT")
            if descriptor["id"] == "token":
                need(set(value) == {"accessToken"} and isinstance(value["accessToken"], str) and 20 <= len(value["accessToken"]) <= 4096, "TOKEN_OUTPUT")
                self.token = value["accessToken"]

    def _prime_access_http(self):
        if "key_absence" in self.http: return
        self._prime_cli()
        for descriptor in access_https_contract(self.project_number, self.plan["prospectiveKeyId"]): self._https(descriptor)

    def read_cloud(self, deadline):
        self._prime_cli()
        owner = self.cli["owner"]; config = self.cli["config"]; project = self.cli["project"]
        bp = self.cli["billing_project"]; ba = self.cli["billing_account"]
        service = self.cli["service"]; revision = self.cli["revision"]; identity = self.cli["identity"]
        secret_states = [self.cli[f"secret_state_{i}"] for i in range(6)]
        secret_policies = [self.cli[f"secret_policy_{i}"] for i in range(7)]
        need(isinstance(owner, list) and len(owner) == 1 and isinstance(owner[0], dict) and set(owner[0]) == {"account", "status"}, "OWNER_OUTPUT")
        config_shape = config_output_shape(config)
        need(isinstance(project, dict) and set(project) == {"projectId", "projectNumber", "lifecycleState"}, "PROJECT_OUTPUT")
        need(isinstance(bp, dict) and set(bp) == {"billingAccountName", "billingEnabled", "projectId"}, "BILLING_OUTPUT")
        need(isinstance(ba, dict) and set(ba) == {"open"}, "BILLING_OUTPUT")
        containers = revision.get("spec", {}).get("containers", []); need(isinstance(containers, list) and len(containers) == 1, "REVISION_OUTPUT")
        environment = containers[0].get("env", []); need(isinstance(environment, list), "REVISION_OUTPUT")
        traffic = service.get("status", {}).get("traffic", [])
        return {
            "ownerExact": owner == [{"account": model.OWNER, "status": "ACTIVE"}],
            "overridesAbsent": config_shape in {"AUTH_SECTION_OMITTED", "AUTH_SECTION_EMPTY"},
            "projectExact": project.get("projectId") == model.PROJECT and project.get("lifecycleState") == "ACTIVE",
            "projectNumberBound": model.digest(self.project_number) == PROJECT_NUMBER_SHA256,
            "billingEnabled": bp.get("billingEnabled") is True and bp.get("projectId") == model.PROJECT,
            "billingOpen": ba == {"open": True},
            "candidateSourceExact": containers[0].get("image") == self.binding["candidateImage"] and revision.get("spec", {}).get("serviceAccountName") == model.IDENTITY,
            "environmentExact": model.digest(environment) == self.binding["environmentSha256"],
            "candidateReady": any(x.get("type") == "Ready" and x.get("status") == "True" for x in revision.get("status", {}).get("conditions", [])),
            "trafficRetired": traffic_retired(traffic, self.binding["normalRevision"]),
            "identityDisabled": identity.get("email") == model.IDENTITY and identity.get("disabled") is True,
            "secretsRetired": all(v.get("state") == "DISABLED" for v in secret_states),
            "secretBindingsAbsent": all(not any(b.get("members") for b in p.get("bindings", []) if model.IDENTITY in b.get("members", [])) for p in secret_policies),
        }

    def read_access(self, deadline):
        self._prime_access_http()
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
        value = bounded_json(self.io.sql(sql_contract()[0], self.binding["databasePassword"], self.times["readEnd"]), "SQL_OUTPUT")
        need(isinstance(value, dict) and set(value) == {"jobCount","job","tenantCount","tenant","operatorCount","operator","calendarCount","roleCount","sessionCount"}, "DATABASE_OUTPUT")
        row = value.get("operator")
        need(value["operatorCount"] == 1 and isinstance(row, dict), "DATABASE_OPERATOR_COUNT")
        target = {"id": row.get("id"), "tenantId": row.get("tenantId"), "email": row.get("email"), "fullName": row.get("fullName"), "role": row.get("role"), "status": row.get("status")}
        model.exact_uuid(target["id"], "DATABASE_OPERATOR_ID")
        ownership_exact = hashlib.sha256(json.dumps(target, separators=(",", ":")).encode()).hexdigest() == TARGET_SHA256
        self.firebase_uid = target["id"] if ownership_exact else None
        job, tenant = value.get("job"), value.get("tenant")
        return {"jobExact": value["jobCount"] == 1 and isinstance(job, dict) and job.get("id") == model.JOB and job.get("tenantId") == model.TENANT,
                "tenantActive": value["tenantCount"] == 1 and isinstance(tenant, dict) and tenant.get("id") == model.TENANT and tenant.get("status") == "ACTIVE",
                "paymentGateExact": isinstance(job, dict) and isinstance(job.get("policySnapshot"), dict) and job["policySnapshot"].get("intakeAdmission", {}).get("humanReviewed") is True,
                "calendarAbsent": value["calendarCount"] == 0 and isinstance(job, dict) and job.get("calendarEventId") is None,
                "operatorExactDisabled": target == {"id": target["id"], "tenantId": model.TENANT, "email": TARGET_EMAIL, "fullName": TARGET_NAME, "role": "ADMIN", "status": "DISABLED"},
                "dbRoleRetired": value["roleCount"] == 0, "sessionsAbsent": value["sessionCount"] == 0, "ownershipReceiptExact": ownership_exact}

    def read_firebase(self, deadline):
        need(self.firebase_uid is not None, "FIREBASE_UID_UNQUALIFIED")
        envelope = self._https(firebase_https_contract(self.firebase_uid))
        need(envelope["status"] == 200, "FIREBASE_DENIED")
        users = envelope["body"].get("users"); need(isinstance(users, list) and len(users) == 1, "FIREBASE_OUTPUT")
        user = users[0]
        try: claims = json.loads(user.get("customAttributes", ""))
        except (json.JSONDecodeError, TypeError): claims = None
        raw_valid_since = user.get("validSince")
        valid_since = int(raw_valid_since) if isinstance(raw_valid_since, str) and re.fullmatch(r"[0-9]{1,19}", raw_valid_since) and int(raw_valid_since) <= 9223372036854775807 else -1
        return {"existsOne": True, "uidExact": user.get("localId") == self.firebase_uid, "disabled": user.get("disabled") is True, "identityExact": user.get("email") == TARGET_EMAIL and user.get("displayName") == TARGET_NAME, "claimsExact": claims == {"tenantId": model.TENANT, "role": "admin", "testOnly": True}, "tokensRevoked": valid_since >= REVOCATION_LOWER_BOUND_MS // 1000 and "tokensValidAfterTime" not in user}

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
    def __init__(self, clock, operation_id):
        model.exact_uuid(operation_id, "OPERATION_ID")
        need(not any(os.environ.get(key) for key in CREDENTIAL_OVERRIDE_KEYS), "CREDENTIAL_OVERRIDE")
        need(not os.environ.get("DATABASE_URL") and not any(key.startswith("PG") and value for key, value in os.environ.items()), "DATABASE_OVERRIDE")
        self.clock = clock; self.children = set(); self.closed = False; self.binding_operation_id = operation_id.replace("-", "")

    def cli(self, descriptor, deadline):
        need(not self.closed and self.clock() < deadline, "CLI_DEADLINE")
        argv = descriptor["argv"]; need(argv and argv[0] == GCLOUD, "CLI_EXECUTABLE")
        env = {k: v for k, v in os.environ.items() if not k.startswith("PG") and k != "DATABASE_URL" and k not in CREDENTIAL_OVERRIDE_KEYS}
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
        sql = QUALIFICATION_SQL if descriptor["id"] == "qualification" else CLOSEOUT_SQL if descriptor["id"] == "closeout" else None
        need(sql is not None, "SQL_ALLOWLIST")
        env = {k: v for k, v in os.environ.items() if not k.startswith("PG") and k != "DATABASE_URL"}
        env.update({"PGPASSWORD": password, "PGSSLMODE": "verify-full", "PGSSLROOTCERT": "/etc/ssl/cert.pem", "PGCONNECT_TIMEOUT": "10", "PGAPPNAME": "signmons_p08_qualification_" + self.binding_operation_id, "PGOPTIONS": "-c statement_timeout=15000 -c lock_timeout=5000"})
        timeout = max(1, min(25, int(deadline - self.clock())))
        try:
            result = subprocess.run([operator.PSQL, "-X", "-q", "-A", "-t", "-v", "ON_ERROR_STOP=1", "-h", operator.DB_HOST, "-U", "neondb_owner", "-d", "neondb", "-c", sql], env=env, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=timeout, check=False)
        except subprocess.TimeoutExpired:
            raise model.Stop("DATABASE_COMMAND_TIMEOUT") from None
        finally:
            env["PGPASSWORD"] = ""
        need(result.returncode == 0 and len(result.stdout) <= MAX_OUTPUT, "DATABASE_READ_COMMAND_FAILED")
        raw = result.stdout.decode("utf-8", "strict").strip()
        if descriptor["id"] == "closeout":
            value = bounded_json(raw, "CLOSEOUT_OUTPUT"); return value
        return bounded_json(raw, "DATABASE_OUTPUT")

    def close(self, deadline):
        self.closed = True
        return not self.children


def private_json(path):
    path = Path(path); info = path.lstat()
    need(stat.S_ISREG(info.st_mode) and not path.is_symlink() and stat.S_IMODE(info.st_mode) == 0o600, "PRIVATE_INPUT")
    value = json.loads(path.read_text()); need(isinstance(value, dict), "PRIVATE_INPUT")
    return value


def purge_private_inputs(directory, paths):
    directory = Path(directory).resolve()
    need(len(paths) == 2, "PRIVATE_PURGE_SCOPE")
    checked = []
    for expected, path in zip(("plan.json", "binding.json"), map(Path, paths)):
        need(path.name == expected and path.parent.resolve() == directory, "PRIVATE_PURGE_SCOPE")
        info = path.lstat()
        need(stat.S_ISREG(info.st_mode) and not path.is_symlink() and stat.S_IMODE(info.st_mode) == 0o600, "PRIVATE_PURGE_INPUT")
        checked.append((expected, path))
    absent = {}
    for expected, path in checked:
        try: path.unlink()
        except OSError: pass
        absent[expected] = not path.exists() and not path.is_symlink()
    model.reserve(directory / "private-input-retirement.json", {"privateInputsAbsent": all(absent.values()), "absence": absent})
    return all(absent.values())


def native(argv=None):
    model.verify_local_manifest(); model.verify_locked_sources()
    argv = sys.argv[1:] if argv is None else argv
    if len(argv) != 4 or argv[0] not in ("--qualify", "--closeout"):
        print("P08_COMPOSED_QUALIFICATION_LAUNCH_REFUSED_UNBOUND"); return 2
    directory = Path(argv[3])
    need(directory.is_dir() and not directory.is_symlink() and stat.S_IMODE(directory.stat().st_mode) == 0o700, "PRIVATE_DIRECTORY")
    input_paths = (Path(argv[1]), Path(argv[2]))
    need(input_paths[0].name == "plan.json" and input_paths[1].name == "binding.json" and all(p.parent.resolve() == directory.resolve() for p in input_paths), "PRIVATE_INPUT_SCOPE")
    plan = private_json(input_paths[0]); binding = private_json(input_paths[1])
    password = ""
    try:
        mode = "qualify" if argv[0] == "--qualify" else "closeout"
        validate_binding(binding, plan, model.time.time(), mode=mode)
        if mode == "closeout":
            attempt = private_json(directory / "attempt.json"); journal = private_json(directory / "journal.json")
            need(attempt.get("operationId") == plan["operationId"] and attempt.get("planSha256") == model.digest(plan), "CLOSEOUT_SCOPE")
            need(journal.get("operationId") == plan["operationId"] and journal.get("planSha256") == model.digest(plan), "CLOSEOUT_SCOPE")
            reserve_path = directory / "closeout-attempt.json"
            model.reserve(reserve_path, {"operationId": plan["operationId"], "planSha256": model.digest(plan)})
        password = getpass.getpass("Enter current CHILD administrator password (hidden): ")
        need(password, "PASSWORD_EMPTY"); binding["databasePassword"] = password
        transport = NativeIO(model.time.time, plan["operationId"]); adapter = Adapter(binding, plan, transport, model.time.time, mode=mode)
        if mode == "closeout":
            closed = adapter.closeout(adapter.times["closeoutEnd"])
            print("P08_COMPOSED_QUALIFICATION_CLOSEOUT_VERIFIED" if closed else "CONTAINMENT_UNCONFIRMED")
            return 0 if closed else 2
        result = model.Coordinator(plan, adapter, directory).run()
        print(result["status"]); return 0 if result["verdict"] == "QUALIFIED" else 2
    finally:
        password = ""; need(purge_private_inputs(directory, input_paths), "PRIVATE_PURGE_UNCONFIRMED")


if __name__ == "__main__":
    raise SystemExit(native())
