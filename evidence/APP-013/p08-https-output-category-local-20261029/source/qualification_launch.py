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
from urllib.parse import urlsplit
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


def bounded_https_json(value):
    """Classify only fixed, non-sensitive HTTPS body parsing failures."""
    if isinstance(value, bytes):
        need(len(value) <= MAX_OUTPUT, "HTTPS_OUTPUT_OVERSIZE")
        try:
            value = value.decode("utf-8", "strict")
        except UnicodeError:
            raise model.Stop("HTTPS_OUTPUT_INVALID_UTF8") from None
    if isinstance(value, str):
        need(len(value.encode()) <= MAX_OUTPUT, "HTTPS_OUTPUT_OVERSIZE")
        try:
            value = json.loads(value)
        except json.JSONDecodeError:
            raise model.Stop("HTTPS_OUTPUT_INVALID_JSON") from None
    need(isinstance(value, (dict, list)), "HTTPS_OUTPUT")
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
            body = bounded_https_json(value.get("body", {}))
        except model.Stop as error:
            categories = {"HTTPS_OUTPUT_OVERSIZE": "OVERSIZE", "HTTPS_OUTPUT_INVALID_UTF8": "INVALID_UTF8", "HTTPS_OUTPUT_INVALID_JSON": "INVALID_JSON"}
            if str(error) in categories:
                raise model.Stop("HTTPS_OUTPUT:" + request_id + ":" + categories[str(error)]) from None
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

    def _group_alive(self,process,until):
        import time
        # Darwin can report EPERM while an exited group member is being reaped.
        # Poll only within the cleanup budget; EPERM is never treated as absence.
        while True:
            process.poll()
            try:os.killpg(process.pid,0);return True
            except ProcessLookupError:return False
            except PermissionError:
                if time.monotonic()>=until:raise model.Stop('PROCESS_OWNERSHIP_UNKNOWN') from None
                time.sleep(min(.01,max(0,until-time.monotonic())))

    def _finish(self,process,deadline):
        import signal,time
        if process not in self.children:return False
        hard_end=time.monotonic()+min(1.8,max(0,deadline-self.clock()))
        try:
            if self._group_alive(process,hard_end):
                os.killpg(process.pid,signal.SIGTERM)
                end=min(deadline,self.clock()+0.2)
                while self.clock()<end and time.monotonic()<hard_end and self._group_alive(process,hard_end):
                    process.poll();time.sleep(.01)
                if self._group_alive(process,hard_end):os.killpg(process.pid,signal.SIGKILL)
            process.wait(timeout=max(.01,min(1,deadline-self.clock())))
            while self.clock()<deadline and time.monotonic()<hard_end and self._group_alive(process,hard_end):time.sleep(.01)
            absent=not self._group_alive(process,hard_end)
            if absent:self.children.discard(process)
            return absent and process.returncode is not None and self.clock()<deadline
        except (OSError,subprocess.TimeoutExpired,model.Stop):return False
        finally:
            if process.stdout:process.stdout.close()

    def _owned_run(self,argv,env,deadline):
        import selectors,time
        need(not self.closed and self.clock()+2<deadline,'PROCESS_DEADLINE')
        process=subprocess.Popen(argv,stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,
             stderr=subprocess.DEVNULL,env=env,start_new_session=True)
        self.children.add(process);chunks=[];size=0;failure=None
        last=self.clock();hard_end=time.monotonic()+max(0,deadline-last-2)
        selector=selectors.DefaultSelector()
        try:
            os.set_blocking(process.stdout.fileno(),False);selector.register(process.stdout,selectors.EVENT_READ)
            while True:
                now=self.clock();need(now>=last,'CLOCK_ROLLBACK');last=now
                need(now<deadline-2 and time.monotonic()<hard_end,'PROCESS_TIMEOUT')
                events=selector.select(min(.05,max(.001,deadline-2-self.clock())))
                if events:
                    data=os.read(process.stdout.fileno(),min(8192,MAX_OUTPUT+1-size))
                    if not data:break
                    chunks.append(data);size+=len(data);need(size<=MAX_OUTPUT,'PROCESS_OUTPUT_LIMIT')
                elif process.poll() is not None:
                    data=os.read(process.stdout.fileno(),min(8192,MAX_OUTPUT+1-size))
                    if not data:break
                    chunks.append(data);size+=len(data);need(size<=MAX_OUTPUT,'PROCESS_OUTPUT_LIMIT')
            need(process.wait(timeout=max(.01,deadline-2-self.clock()))==0,'PROCESS_REFUSED')
        except BaseException as error:
            failure=str(error) if isinstance(error,model.Stop) else 'PROCESS_UNCONFIRMED'
        finally:
            selector.close()
            if not self._finish(process,deadline):failure='PROCESS_CLEANUP_UNCONFIRMED'
        if failure:raise model.Stop(failure)
        return b''.join(chunks)

    def cli(self, descriptor, deadline):
        need(not self.closed and self.clock() < deadline, "CLI_DEADLINE")
        argv = descriptor["argv"]; need(argv and argv[0] == GCLOUD, "CLI_EXECUTABLE")
        env = sdk_environment(os.environ) if isinstance(self,(QualificationIO,BindingRecoveryIO,ProjectDiagnosticIO)) else {k: v for k, v in os.environ.items() if not k.startswith("PG") and k != "DATABASE_URL" and k not in CREDENTIAL_OVERRIDE_KEYS}
        timeout = max(1, min(30, int(deadline - self.clock())))
        validate_cli_descriptor(descriptor)
        raw=self._owned_run(argv,env,min(deadline,self.clock()+30))
        if descriptor["id"] == "token":
            token = raw.decode("utf-8", "strict").strip(); need(20 <= len(token) <= 4096, "TOKEN_OUTPUT"); return {"accessToken": token}
        return raw

    def https(self, descriptor, token, deadline):
        from urllib.parse import urlsplit
        need(not self.closed and self.clock()<deadline and isinstance(token,str),'HTTPS_DEADLINE')
        u=urlsplit(descriptor.get('url',''));need(u.scheme=='https' and u.hostname in {
          'serviceusage.googleapis.com','cloudresourcemanager.googleapis.com','iam.googleapis.com',
          'apikeys.googleapis.com','identitytoolkit.googleapis.com','secretmanager.googleapis.com','run.googleapis.com'}
          and not u.username and not u.password and not u.fragment and u.port in (None,443),'HTTPS_HOST')
        need(set(descriptor)=={'id','method','url','body'} and descriptor['method'] in ('GET','POST'),'HTTPS_DESCRIPTOR')
        # Exact resource/body descriptors are checked again here, not only by the reader.
        number=re.search(r'projects/([0-9]{6,20})(?:/|:)',descriptor['url'])
        number=number.group(1) if number else '123456789012'
        key=descriptor['url'].rsplit('/',1)[-1] if descriptor['id']=='key_absence' else 'signmons-p08-'+'0'*32
        allowed=list(current_https_contract(number,key))+list(access_https_contract(number,key))
        if descriptor['id']=='firebase':
            body=descriptor['body'];need(isinstance(body,dict) and isinstance(body.get('localId'),list) and len(body['localId'])==1,'FIREBASE_SCOPE')
            allowed.append(firebase_https_contract(body['localId'][0]))
        need(descriptor in allowed,'HTTPS_DESCRIPTOR_SCOPE')
        body=None if descriptor['body'] is None else json.dumps(descriptor['body'],separators=(',',':')).encode()
        request=urllib.request.Request(descriptor['url'],data=body,method=descriptor['method'],
            headers={'Authorization':'Bearer '+token,'Content-Type':'application/json','x-goog-user-project':model.PROJECT})
        class NoRedirect(urllib.request.HTTPRedirectHandler):
            def redirect_request(self,*args,**kwargs):return None
        response=None
        try:
            with current_module('acl').http_deadline(max(.01,min(15,deadline-self.clock()))):
                try:response=urllib.request.build_opener(urllib.request.ProxyHandler({}),NoRedirect()).open(request,timeout=max(.01,min(15,deadline-self.clock())))
                except urllib.error.HTTPError as error:response=error
                raw=response.read(MAX_OUTPUT+1);status=response.status
                need(self.clock()<deadline,'HTTPS_DEADLINE')
                need(len(raw)<=MAX_OUTPUT,'HTTPS_OUTPUT_OVERSIZE')
                need(not 300<=status<400,'HTTPS_REDIRECT')
                return {'status':status,'body':raw or b'{}'}
        except model.Stop:raise
        except Exception:raise model.Stop('HTTPS_REFUSED') from None
        finally:
            if response is not None:response.close()

    def sql(self, descriptor, password, deadline):
        need(not self.closed and self.clock() < deadline and isinstance(password, str) and password, "SQL_DEADLINE")
        operator = _operator_module()
        need(descriptor in current_sql_contract(), "SQL_ALLOWLIST")
        sql = descriptor["sql"]
        need(sql is not None, "SQL_ALLOWLIST")
        env = ({k:v for k,v in sdk_environment(os.environ).items() if not k.startswith("CLOUDSDK_")} if isinstance(self,(QualificationIO,BindingRecoveryIO,ProjectDiagnosticIO)) else {k: v for k, v in os.environ.items() if not k.startswith("PG") and k != "DATABASE_URL"})
        env.update({"PGPASSWORD": password, "PGSSLMODE": "verify-full", "PGSSLROOTCERT": "/etc/ssl/cert.pem", "PGCONNECT_TIMEOUT": "10", "PGAPPNAME": "signmons_p08_qualification_" + self.binding_operation_id, "PGOPTIONS": "-c statement_timeout=15000 -c lock_timeout=5000"})
        timeout = max(1, min(25, int(deadline - self.clock())))
        try:
            raw=self._owned_run([operator.PSQL,'-X','-q','-A','-t','-v','ON_ERROR_STOP=1','-h',operator.DB_HOST,
                '-U','neondb_owner','-d','neondb','-c',sql],env,min(deadline,self.clock()+25))
        finally:env['PGPASSWORD']=''
        try:raw=raw.decode('utf-8','strict').strip()
        except UnicodeError:raise model.Stop('DATABASE_OUTPUT') from None
        if descriptor["id"] == "closeout":
            value = bounded_json(raw, "CLOSEOUT_OUTPUT"); return value
        return bounded_json(raw, "DATABASE_OUTPUT")

    def close(self, deadline):
        self.closed = True
        results=[self._finish(process,deadline) for process in list(self.children)]
        return all(results) and not self.children and self.clock()<deadline


def private_json(path):
    path=Path(path);fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW)
    try:
        info=os.fstat(fd)
        need(stat.S_ISREG(info.st_mode) and info.st_uid==os.getuid() and info.st_nlink==1 and
             stat.S_IMODE(info.st_mode)==0o600 and info.st_size<=MAX_OUTPUT,'PRIVATE_INPUT')
        stamp=lambda st:(st.st_dev,st.st_ino,st.st_size,st.st_mtime_ns,st.st_ctime_ns,st.st_uid,st.st_nlink,st.st_mode)
        raw=os.read(fd,MAX_OUTPUT+1)
        need(len(raw)<=MAX_OUTPUT and stamp(os.fstat(fd))==stamp(info) and stamp(path.stat(follow_symlinks=False))==stamp(info),'PRIVATE_INPUT_CHANGED')
        value=strict_json(raw);need(isinstance(value,dict),'PRIVATE_INPUT');return value
    finally:os.close(fd)


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
        raise model.Stop("CURRENT_NATIVE_ENTRY_UNBOUND")
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


# Current-evidence proof contract. Historical adapter remains for regression tests only.
CURRENT_PROJECT_PERMISSIONS = ('resourcemanager.projects.get','resourcemanager.projects.getIamPolicy',
 'resourcemanager.projects.setIamPolicy','firebaseauth.users.get','firebaseauth.users.update',
 'apikeys.keys.create','apikeys.keys.get','apikeys.keys.getKeyString','apikeys.keys.delete',
 'apikeys.operations.get','serviceusage.services.get','serviceusage.services.enable',
 'serviceusage.services.use','serviceusage.operations.get','run.operations.get')
CURRENT_IDENTITY_PERMISSIONS = ('iam.serviceAccounts.get','iam.serviceAccounts.getIamPolicy',
 'iam.serviceAccounts.setIamPolicy','iam.serviceAccounts.enable','iam.serviceAccounts.disable','iam.serviceAccounts.actAs')
SECRET_PERMISSIONS = ('secretmanager.secrets.get','secretmanager.secrets.getIamPolicy',
 'secretmanager.secrets.setIamPolicy','secretmanager.versions.get')
CURRENT_SERVICES = (*model.SERVICES,'run.googleapis.com','secretmanager.googleapis.com')
PRODUCER_DEPENDENCIES = {
 'acl':'p08-narrow-access-check-local-20261101/source/access_check.py',
 'authority':'p08-native-entry-local-20261101/source/authority.py',
 'processPattern':'p08-same-day-renewal-filename-local-20261028/source/launch_binding.py',
 'environment':'p08-restoration-local-20261028/source/auth/reuse/controller.py',
}

def current_module(name):
    relative=PRODUCER_DEPENDENCIES[name];path=model.ROOT.parent.parent/relative
    manifest=json.loads((model.ROOT/'source-manifest.json').read_text())
    need(not path.is_symlink() and model.digest(path.read_bytes())==manifest['producerDependencies'].get(relative),'PRODUCER_SOURCE_DRIFT')
    # authority has sibling imports; use a temporary import path without altering its code.
    old=list(sys.path)
    try:
        sys.path.insert(0,str(path.parent))
        spec=importlib.util.spec_from_file_location('current_proof_'+name,path)
        module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
        return module
    finally:sys.path[:]=old

def current_cli_contract(account='<discovered-account>'):
    return (*cli_contract(account),{'id':'stripe_state','argv':(GCLOUD,'secrets','versions','describe','1',
            '--secret','signmons-staging-stripe-secret-key','--project',model.PROJECT,'--format=json(name,state)')})

def current_https_contract(number,key):
    rows=list(access_https_contract(number,key))
    for row in rows:
        if row['id']=='project_permissions':row['body']={'permissions':list(CURRENT_PROJECT_PERMISSIONS)}
        if row['id']=='identity_permissions':row['body']={'permissions':list(CURRENT_IDENTITY_PERMISSIONS)}
    for i,service in enumerate(CURRENT_SERVICES[6:],6):
        rows.append({'id':f'service_{i}','method':'GET','url':f'https://serviceusage.googleapis.com/v1/projects/{number}/services/{service}','body':None})
    for i,secret in enumerate(POLICY_SECRETS):
        permissions=list(SECRET_PERMISSIONS)+(['secretmanager.versions.enable','secretmanager.versions.disable'] if secret in SECRETS else [])
        rows.append({'id':f'secret_permissions_{i}','method':'POST',
          'url':f'https://secretmanager.googleapis.com/v1/projects/signmons/secrets/{secret}:testIamPermissions','body':{'permissions':permissions}})
    rows.append({'id':'run_permissions','method':'POST','url':f'https://run.googleapis.com/v2/projects/signmons/locations/{REGION}/services/{SERVICE}:testIamPermissions',
                 'body':{'permissions':['run.services.get','run.services.update']}})
    for row in rows:
        if row['id'].startswith('service_'):row['url']+='?fields=name,state'
    need(len(rows)==19,'CURRENT_HTTP_CONTRACT');return tuple(rows)

def current_sql_contract():
    return (*sql_contract(),{'id':'retired_role','sql':current_module('acl').retired_role_query(),'readOnly':True})

def strict_json(raw):
    def unique(pairs):
        out={}
        for k,v in pairs:
            need(k not in out,'DUPLICATE_FIELD');out[k]=v
        return out
    if isinstance(raw,dict) or isinstance(raw,list):
        raw=json.dumps(raw,allow_nan=False).encode()
    if isinstance(raw,str):raw=raw.encode('utf-8','strict')
    need(isinstance(raw,bytes) and len(raw)<=MAX_OUTPUT,'CURRENT_OUTPUT')
    try:return json.loads(raw.decode('utf-8','strict'),object_pairs_hook=unique,
                          parse_constant=lambda _:(_ for _ in ()).throw(model.Stop('CURRENT_OUTPUT')))
    except model.Stop:raise
    except Exception:raise model.Stop('CURRENT_OUTPUT') from None

def environment_digest(rows):
    need(isinstance(rows,list) and len(rows)==19,'ENVIRONMENT_SHAPE')
    required={'NODE_ENV':'production','GOOGLE_CLOUD_PROJECT':'signmons','DEV_AUTH_ENABLED':'false',
      'SCHEDULING_ENABLED':'false','STRIPE_WEBHOOK_LIVEMODE':'false','SMS_DELIVERY_ENABLED':'false',
      'BACKGROUND_WORKERS_ENABLED':'false','STAGING_PHONE_TEST_ENABLED':'false','ENABLED_TOOLS':'none',
      'WEBCHAT_INTEGRATIONS_JSON':'[]','TWILIO_TENANT_IDENTITIES_JSON':'[]'}
    pins=dict(zip(('DATABASE_URL','STRIPE_WEBHOOK_SECRET','OPENAI_API_KEY','ADMIN_API_TOKEN',
                   'CONVERSATION_DATA_ENCRYPTION_KEY','TECHNICIAN_LINK_SECRET'),SECRETS))
    pins['STRIPE_SECRET_KEY']='signmons-staging-stripe-secret-key'
    seen=set()
    for row in rows:
        need(isinstance(row,dict) and isinstance(row.get('name'),str) and row['name'] not in seen,'ENVIRONMENT_SHAPE')
        name=row['name'];seen.add(name)
        if name in required:need(row=={'name':name,'value':required[name]},'ENVIRONMENT_LITERAL')
        elif name in pins:need(row=={'name':name,'valueFrom':{'secretKeyRef':{'name':pins[name],'key':'1'}}},'ENVIRONMENT_SECRET')
        else:
            need(name=='CUSTOMER_PAYMENT_RETURN_URL' and set(row)=={'name','value'} and isinstance(row['value'],str),'ENVIRONMENT_SHAPE')
            from urllib.parse import urlsplit
            url=urlsplit(row['value'])
            need(url.scheme=='https' and url.hostname and not url.username and not url.password and not url.query and not url.fragment,'RETURN_URL')
    need(seen==set(required)|set(pins)|{'CUSTOMER_PAYMENT_RETURN_URL'},'ENVIRONMENT_SHAPE')
    return model.digest(rows)

PERMISSION_IDS=('project_permissions','identity_permissions',*[f'secret_permissions_{i}' for i in range(7)],'run_permissions')


class PermissionDiagnostics:
    """Only source-pinned labels and permission names may enter durable receipts."""
    def __init__(self,cap):
        self.root=cap.root
        self.common={'operationId':cap.plan['operationId'],
                     'cleanupScopeSha256':model.digest(qualification_cleanup_scope(cap.e))}
    def write(self,d,phase,value):
        try:
            need(d in current_https_contract('123456789012','signmons-p08-'+'0'*32) or
                 (d['id'] in ('project_permissions','identity_permissions') and
                  d in current_https_contract(re.search(r'projects/([0-9]{6,20}):',d['url']).group(1)
                    if d['id']=='project_permissions' else '123456789012','signmons-p08-'+'0'*32)),
                 'PERMISSION_DESCRIPTOR')
            need(d['id'] in PERMISSION_IDS and phase in ('attempt','result'),'PERMISSION_DESCRIPTOR')
            inspect_current_root(self.root,CURRENT_MARKERS)
            model.reserve(self.root/f"permission-{phase}-{d['id']}.json",{**self.common,'descriptorId':d['id'],**value})
        except Exception:raise model.Stop('PERMISSION_DIAGNOSTIC_WRITE_UNCONFIRMED') from None
    def begin(self,d):self.write(d,'attempt',{'status':'RESERVED'})
    def finish(self,d,response=None):
        status=None;outcome='RESPONSE_UNCONFIRMED';missing=None
        if response is not None:
            code=response.get('status');body=response.get('body')
            status=code if type(code) is int and 100<=code<=599 else None
            if status is not None and status!=200:outcome='HTTP_REFUSED'
            elif status==200:
                outcome='INVALID_RESPONSE'
                ps=body.get('permissions') if isinstance(body,dict) else None
                requested=d['body']['permissions']
                if (isinstance(body,dict) and set(body)=={'permissions'} and isinstance(ps,list) and
                    all(isinstance(x,str) for x in ps) and len(ps)==len(set(ps)) and set(ps)<=set(requested)):
                    missing=[x for x in requested if x not in ps]
                    outcome='MISSING' if missing else 'COMPLETE'
        self.write(d,'result',{'httpStatus':status,'outcome':outcome,'missingPermissions':missing})


class CurrentAdapter(Adapter):
    def __init__(self,plan,scope,io,clock,password="SYNTHETIC_CURRENT_PROOF_ONLY",diagnostics=None):
        self.diagnostics=diagnostics
        self.plan=copy.deepcopy(plan);self.scope=copy.deepcopy(scope);self.io=io;self.clock=clock
        self.times=model.authorize(plan,clock());self.cli={};self.http={};self.closed=False
        self.token=None;self.project_number=None;self.billing_account=None;self.firebase_uid=None
        self.binding={'candidateImage':scope['resources']['image'],'normalRevision':scope['resources']['normalRevision'],
                      'databasePassword':password}
        self.seen=set();self.last=clock();self.role_result=None;self.target=None
    def _gate(self,cleanup=False):
        now=self.clock();need(now>=self.last,'CLOCK_ROLLBACK');self.last=now
        super()._gate(cleanup)
    def _cli(self,d):
        self._gate();need(('cli',d['id']) not in self.seen,'DUPLICATE_READ');self.seen.add(('cli',d['id']))
        value=strict_json(self.io.cli(d,self.times['readEnd']));self._gate();self.cli[d['id']]=value
        return value
    def _prime_cli(self):
        if self.cli:return
        for d in current_cli_contract():
            if d['id']=='billing_account':
                need(self.billing_account is not None,'BILLING_ACCOUNT_UNBOUND')
                d={**d,'argv':tuple(self.billing_account if x=='<discovered-account>' else x for x in d['argv'])}
            v=self._cli(d)
            if d['id']=='project':
                self.project_number=v.get('projectNumber');need(isinstance(self.project_number,str) and re.fullmatch(r'[0-9]{6,20}',self.project_number),'PROJECT_NUMBER')
                need(model.digest(self.project_number)==PROJECT_NUMBER_SHA256,'PROJECT_NUMBER_FINGERPRINT')
            if d['id']=='billing_project':
                self.billing_account=v.get('billingAccountName')
                need(isinstance(self.billing_account,str) and hashlib.sha256(self.billing_account.encode()).hexdigest()==BILLING_ACCOUNT_SHA256,'BILLING_ACCOUNT_FINGERPRINT')
            if d['id']=='token':
                need(isinstance(v,dict) and set(v)=={'accessToken'} and isinstance(v['accessToken'],str) and 20<=len(v['accessToken'])<=4096 and not any(c.isspace() for c in v['accessToken']),'TOKEN_OUTPUT')
                self.token=v['accessToken']
        self.binding['environmentSha256']=environment_digest(self.cli['revision']['spec']['containers'][0]['env'])
    def _https(self,d):
        self._gate();allowed=list(current_https_contract(self.project_number,self.plan['prospectiveKeyId']))
        if self.firebase_uid:allowed.append(firebase_https_contract(self.firebase_uid))
        need(d in allowed and ('https',d['id']) not in self.seen,'CURRENT_HTTP_SCOPE');self.seen.add(('https',d['id']))
        v=self.io.https(d,self.token,self.times['readEnd']);self._gate()
        need(isinstance(v,dict) and set(v)=={'status','body'} and type(v['status']) is int,'CURRENT_HTTP_OUTPUT')
        out={'status':v['status'],'body':strict_json(v['body'])};need(isinstance(out['body'],dict),'CURRENT_HTTP_OUTPUT')
        self.http[d['id']]=out;return out
    def _policy_bindings(self,policy):
        need(isinstance(policy,dict) and set(policy)<={'bindings','etag','version'},'POLICY_OUTPUT')
        need('etag' not in policy or isinstance(policy['etag'],str),'POLICY_OUTPUT')
        need('version' not in policy or type(policy['version']) is int and policy['version'] in (0,1,3),'POLICY_OUTPUT')
        bindings=policy.get('bindings',[]);need(isinstance(bindings,list),'POLICY_OUTPUT')
        for row in bindings:
            need(isinstance(row,dict) and {'role','members'}<=set(row)<={'role','members','condition'} and
                 isinstance(row['role'],str) and bool(row['role']) and isinstance(row['members'],list) and
                 all(isinstance(x,str) and bool(x) for x in row['members']),'POLICY_OUTPUT')
            if 'condition' in row:
                condition=row['condition']
                need(isinstance(condition,dict) and {'expression','title'}<=set(condition)<={'expression','title','description','location'} and
                     all(isinstance(x,str) for x in condition.values()),'POLICY_OUTPUT')
        return bindings

    def read_cloud(self,deadline):
        v=super().read_cloud(deadline)
        need(self.cli['revision'].get('metadata',{}).get('name')==REVISION and self.cli['service'].get('metadata',{}).get('name')==SERVICE,'RUNTIME_RESOURCE_DRIFT')
        need(self.cli['stripe_state']=={'name':'projects/'+self.project_number+'/secrets/signmons-staging-stripe-secret-key/versions/1','state':'ENABLED'},'STRIPE_VERSION_STATE')
        member='serviceAccount:'+model.IDENTITY
        for i,secret in enumerate(SECRETS):
            need(self.cli[f'secret_state_{i}']=={'name':f'projects/{self.project_number}/secrets/{secret}/versions/1','state':'DISABLED'},'RETIRED_VERSION_STATE')
        for i in range(7):
            bindings=self._policy_bindings(self.cli[f'secret_policy_{i}'])
            need(not any(member in x.get('members',[]) for x in bindings),'RETIRED_BINDING_PRESENT')
        return v
    def read_access(self,deadline):
        self._prime_cli();descriptors=current_https_contract(self.project_number,self.plan['prospectiveKeyId'])
        for d in descriptors:
            diagnostic=self.diagnostics if d['id'] in PERMISSION_IDS else None
            if diagnostic:diagnostic.begin(d)
            try:v=self._https(d)
            except BaseException:
                if diagnostic:diagnostic.finish(d)
                raise
            if diagnostic:diagnostic.finish(d,v)
            body=v['body']
            if d['id'].startswith('service_'):
                need(v['status']==200 and body.get('state')=='ENABLED' and body.get('name')==urlsplit(d['url']).path.removeprefix('/v1/'),'SERVICE_NOT_READY')
            elif d['body'] and 'permissions' in d['body']:
                ps=body.get('permissions');need(v['status']==200 and set(body)=={'permissions'} and isinstance(ps,list) and all(isinstance(x,str) for x in ps) and len(ps)==len(set(ps)) and set(ps)==set(d['body']['permissions']),'OWNER_PERMISSION_NOT_READY')
            else:need(v=={'status':404,'body':{'error':{'code':404,'status':'NOT_FOUND'}}},'KEY_ABSENCE_UNKNOWN')
        member='serviceAccount:'+model.IDENTITY
        for name in ('project_policy','identity_policy'):
            bindings=self._policy_bindings(self.cli[name])
            need(all(isinstance(x,dict) and isinstance(x.get('members',[]),list) and member not in x.get('members',[]) and
                     not (name=='identity_policy' and model.SIGNING_ROLE==x.get('role') and 'user:'+model.OWNER in x.get('members',[])) for x in bindings),'RETIRED_BINDING_PRESENT')
        for name,role,permission in [('lookup_role',model.LOOKUP_ROLE,'firebaseauth.users.get'),('signing_role',model.SIGNING_ROLE,'iam.serviceAccounts.signBlob')]:
            v=self.cli[name];need(v.get('name')==role and v.get('includedPermissions')==[permission] and v.get('stage')=='GA' and v.get('deleted',False) is False,'ROLE_DRIFT')
        return True
    def read_database(self,deadline):
        raw=strict_json(self.io.sql(sql_contract()[0],self.binding['databasePassword'],deadline));self._gate()
        fields={'jobCount','job','tenantCount','tenant','operatorCount','operator','calendarCount','roleCount','sessionCount'}
        need(isinstance(raw,dict) and set(raw)==fields and all(type(raw[k]) is int and raw[k]>=0 for k in ('jobCount','tenantCount','operatorCount','calendarCount','roleCount','sessionCount')),'DATABASE_OUTPUT')
        # Reuse the original exact business identity parser without a second read.
        original=self.io
        class Once:
            def sql(_,d,p,t):return raw
        try:self.io=Once();v=super().read_database(deadline)
        finally:self.io=original
        need(raw['roleCount']==1,'ROLE_NOT_READY')
        target=raw['operator'];need(isinstance(target,dict),'TARGET_OUTPUT')
        self.target={k:target[k] for k in ('id','tenantId','email','fullName','role')}
        need(self.target==self.scope['target'],'TARGET_SCOPE')
        acl=current_module('acl');r=strict_json(self.io.sql(current_sql_contract()[2],self.binding['databasePassword'],deadline));self._gate()
        need(r.get('database')==self.scope['database']['database'] and r.get('user')==self.scope['database']['user'],'DATABASE_IDENTITY')
        self.role_result=acl.classify_retired_role(r,acl.expected_retired_acl());v['dbRoleRetired']=True
        need(all(type(x) is bool for x in v.values()),'DATABASE_OUTPUT');return v
    def closeout(self,deadline):
        sessions=False;closed=False
        try:
            v=strict_json(self.io.sql(sql_contract()[1],self.binding['databasePassword'],deadline))
            sessions=v=={'sessionsAbsent':True}
        finally:
            try:closed=self.io.close(deadline) is True
            finally:
                self.token=None;self.binding['databasePassword']=None;self.closed=True
                self.cli.clear();self.http.clear()
        return sessions and closed


def recover_current_proof(plan,native_scope,io,clock=model.time.time):
    """Independent crash readback: lost process ownership can never produce qualification."""
    import fcntl
    need(getattr(io,'proof',None) is True,'CURRENT_PROOF_ONLY')
    model.verify_local_manifest();model.verify_locked_sources()
    need(plan.get('producerDecision')=='APPROVE_LOCAL_CURRENT_EVIDENCE_PROOF' and
         plan.get('producerManifestSha256')==source_manifest_sha256() and
         plan.get('nativeScopeSha256')==model.digest(native_scope) and
         plan.get('prospectiveOperationId')==native_scope['plan']['operationId'],'CURRENT_DECISION_BINDING')
    times=model.authorize(plan,clock(),mode='closeout');root=Path('/private/tmp/p08-current-proof-'+plan['operationId'])
    need(root.is_dir() and not root.is_symlink() and stat.S_IMODE(root.stat().st_mode)==0o700,'PRIVATE_DIRECTORY')
    fd=os.open(root/'entry.lock',os.O_WRONLY|os.O_NOFOLLOW)
    residuals=['OWNED_PROCESS_HISTORY_UNKNOWN']
    try:
        fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
        need(private_json(root/'attempt.json')=={'operationId':plan['operationId'],'scopeSha256':plan['nativeScopeSha256']},'RECOVERY_SCOPE')
        model.reserve(root/'independent-closeout.json',{'operationId':plan['operationId']})
        try:
            need(strict_json(io.sql(sql_contract()[1],'SYNTHETIC_CURRENT_PROOF_ONLY',times['closeoutEnd']))=={'sessionsAbsent':True},'SESSIONS_REMAIN')
        except BaseException:residuals.append('SESSIONS_UNCONFIRMED')
        finally:
            try:need(io.close(times['closeoutEnd']) is True,'PROCESS_CLEANUP_UNCONFIRMED')
            except BaseException:residuals.append('PROCESS_CLEANUP_UNCONFIRMED')
        need(clock()<times['purgeEnd'],'PURGE_DEADLINE')
        if set(p.name for p in root.iterdir())!={'entry.lock','attempt.json','independent-closeout.json'}:residuals.append('PRIVATE_INVENTORY_UNKNOWN')
        result={'status':'CURRENT_EVIDENCE_UNQUALIFIED','execution':'PROOF_ONLY','liveObserved':False,
                'executionReady':False,'candidate':None,'residuals':residuals}
        model.reserve(root/'recovery-result.json',result);return result
    finally:fcntl.flock(fd,fcntl.LOCK_UN);os.close(fd)


def produce_native_qualification(plan,native_scope,io,clock=model.time.time):
    need(getattr(io,'proof',None) is True,'CURRENT_PROOF_ONLY')
    return _produce_current(plan,native_scope,io,clock)


def _produce_current(plan,native_scope,io,clock,capability=None,input_path=None):
    """Shared reducer; only a separately verified capability enables qualification I/O."""
    import fcntl,signal,threading
    need((capability is not None and type(capability) is QualificationCapability) or getattr(io,'proof',None) is True,'CURRENT_PROOF_ONLY')
    model.verify_local_manifest();model.verify_locked_sources()
    need(set(native_scope)=={'plan','target','database','resources','limits'},'CURRENT_SCOPE')
    need(plan.get('producerDecision')=='APPROVE_LOCAL_CURRENT_EVIDENCE_PROOF' and
         plan.get('producerManifestSha256')==source_manifest_sha256() and
         plan.get('nativeScopeSha256')==model.digest(native_scope),'CURRENT_DECISION_BINDING')
    need(plan['prospectiveOperationId']==native_scope['plan']['operationId'],'CURRENT_OPERATION_BINDING')
    times=model.authorize(plan,clock());root=capability.root if capability else Path('/private/tmp/p08-current-proof-'+plan['operationId'])
    root.mkdir(mode=0o700)  # A consumed operation cannot be retried.
    fd=os.open(root/'entry.lock',os.O_CREAT|os.O_EXCL|os.O_WRONLY,0o600)
    adapter=None;failure=None;residuals=[];candidate=None;cleaning=False;handlers={};password=None if capability else 'SYNTHETIC_CURRENT_PROOF_ONLY'
    def interrupted(*_):
        if not cleaning:raise model.Stop('INTERRUPTED')
    if threading.current_thread() is threading.main_thread():
        for sig in (signal.SIGINT,signal.SIGTERM):handlers[sig]=signal.signal(sig,interrupted)
    try:
        fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
        model.reserve(root/'attempt.json',{'operationId':plan['operationId'],'scopeSha256':plan['nativeScopeSha256'],**({'cleanupScopeSha256':model.digest(qualification_cleanup_scope(capability.e))} if capability else {})})
        if capability is not None:
            model.reserve(root/'cleanup-envelope.json',{'scope':qualification_cleanup_scope(capability.e),'decision':capability.e['decision']})
            if input_path is not None:purge_qualification_input(qualification_cleanup_scope(capability.e),capability.e['decision'])
        try:
            if capability is not None:
                capability.prepare()
                password=recovery_password(times['readEnd'],clock)
            adapter=CurrentAdapter(plan,native_scope,io,clock,password,PermissionDiagnostics(capability) if capability else None)
            need(model.classify_cloud(adapter.read_cloud(times['readEnd']))=='QUALIFIED','CLOUD_NOT_READY')
            need(adapter.read_access(times['readEnd']) is True,'ACCESS_NOT_READY')
            need(model.classify_database(adapter.read_database(times['readEnd']))=='QUALIFIED','DATABASE_NOT_READY')
            need(model.classify_firebase(adapter.read_firebase(times['readEnd']))=='QUALIFIED','FIREBASE_NOT_READY')
        except BaseException as error:
            failure=str(error) if isinstance(error,model.Stop) and re.fullmatch('[A-Z_]+',str(error)) else 'CURRENT_READ_UNCONFIRMED'
        finally:
            cleaning=True
            try:need(adapter is not None and adapter.closeout(times['closeoutEnd']) is True,'CLOSEOUT_UNCONFIRMED')
            except BaseException:residuals.append('CLOSEOUT_UNCONFIRMED')
            # Fresh process/connection ownership is required, not reuse of a closed client verdict.
            fresh=None
            try:
                need(password is not None,'CREDENTIAL_INPUT_UNAVAILABLE')
                fresh=io.independent();need(fresh is not io and (capability is not None or getattr(fresh,'proof',None) is True),'INDEPENDENT_SCOPE')
                model.reserve(root/'independent-closeout.json',{'operationId':plan['operationId']})
                need(strict_json(fresh.sql(sql_contract()[1],password,times['closeoutEnd']))=={'sessionsAbsent':True},'SESSIONS_REMAIN')
            except BaseException:residuals.append('INDEPENDENT_UNCONFIRMED')
            finally:
                try:need(fresh is not None and fresh.close(times['closeoutEnd']) is True,'INDEPENDENT_UNCONFIRMED')
                except BaseException:residuals.append('INDEPENDENT_UNCONFIRMED')
        need((adapter is None or adapter.last<=clock()) and clock()<times['purgeEnd'],'PURGE_DEADLINE')
        # This proof persists only sanitized markers; no raw private input or output file is permitted.
        allowed=CURRENT_MARKERS if capability else {'entry.lock','attempt.json','independent-closeout.json'}
        need(set(p.name for p in root.iterdir())<=allowed and
             all(not p.is_symlink() and stat.S_IMODE(p.stat().st_mode)==0o600 for p in root.iterdir()),'PRIVATE_INVENTORY')
        if capability is not None:inspect_current_root(root,CURRENT_MARKERS)
        if not failure and not residuals:
            authority=current_module('authority');authority.verify_sources()
            until=native_scope['plan']['window']['cleanupEnd']
            need(clock()<model.timestamp(until)<=times['purgeEnd'],'QUALIFICATION_EXPIRY')
            candidate={'status':'QUALIFIED_FOR_NATIVE_ENTRY','operationId':plan['prospectiveOperationId'],
               'scopeSha256':model.digest(native_scope),'qualifiedUntil':until,
               'runtimeEnvironmentSha256':adapter.binding['environmentSha256'],
               'roleAclSha256':adapter.role_result['roleAclSha256'],
               'checks':{k:True for k in ('owner','billing','effectiveAccess','services','database','firebase','job','retiredRuntime','privateInventory')}}
            if capability is None:
                envelope={'version':1,'execution':'PROOF_ONLY',**native_scope,'qualification':candidate,
                    'sourceManifestSha256':authority.digest((authority.HERE/'source-manifest.json').read_bytes()),'sourceCommit':'0'*40}
                envelope['decision']={'decision':'APPROVE_LOCAL_NATIVE_ENTRY_PROOF','scopeSha256':authority.digest(envelope)}
                authority.Capability(envelope,Path('/private/tmp/p08-coordinator-'+plan['prospectiveOperationId']),clock=clock)
        result={'status':('CURRENT_EVIDENCE_OBSERVED' if capability else 'CURRENT_EVIDENCE_LOCAL_VERIFIED') if candidate else 'CURRENT_EVIDENCE_UNQUALIFIED',
                'execution':'EXTERNAL_READ_ONLY' if capability else 'PROOF_ONLY','liveObserved':bool(capability and capability.observed),'executionReady':False,'failure':failure,
                'residuals':sorted(set(residuals)),'candidate':candidate}
        if capability is not None:
            result['transportReservations']=copy.deepcopy(capability.counts)
            result['reservationSemantics']='RESERVATIONS_NOT_PROVIDER_REQUEST_COUNTS'
        model.reserve(root/'result.json',result);return result
    finally:
        password=None
        for sig,handler in handlers.items():signal.signal(sig,handler)
        fcntl.flock(fd,fcntl.LOCK_UN);os.close(fd)


CURRENT_MARKERS={'entry.lock','attempt.json','cleanup-envelope.json','independent-closeout.json',
    *[f'permission-{phase}-{name}.json' for phase in ('attempt','result') for name in PERMISSION_IDS],
    'result.json','recovery-result.json',*[f'read-sql-{i}.json' for i in range(1,5)],
    *[f'cli-{kind}-{i:02d}.json' for kind in ('attempt','result') for i in range(1,28)]}


def qualification_cleanup_scope(e):
    return {'version':1,'operationId':e['plan']['operationId'],'database':copy.deepcopy(e['nativeScope']['database']),
        'window':copy.deepcopy(e['plan']['window']),'sourceCommit':e['sourceCommit'],
        'manifestSha256':e['manifestSha256'],'qualificationScopeSha256':model.digest({k:v for k,v in e.items() if k!='decision'}),
        'nativeScopeSha256':e['plan']['nativeScopeSha256'],'limits':{'sql':1,'totalSql':4}}


def verify_cleanup_root(root,scope,decision):
    inspect_current_root(root,CURRENT_MARKERS)
    need(root==Path('/private/tmp/p08-current-external-'+scope['operationId']),'CLEANUP_ROOT_SCOPE')
    need(private_json(root/'cleanup-envelope.json')=={'scope':scope,'decision':decision},'CLEANUP_SCOPE')
    need(private_json(root/'attempt.json')=={'operationId':scope['operationId'],
        'scopeSha256':scope['nativeScopeSha256'],'cleanupScopeSha256':model.digest(scope)},'RECOVERY_SCOPE')


def reserve_qualification_sql(root,operation_id):
    inspect_current_root(root,CURRENT_MARKERS)
    names=sorted(p.name for p in root.glob('read-sql-*.json'))
    need(names==[f'read-sql-{i}.json' for i in range(1,len(names)+1)] and len(names)<4,'QUALIFIER_SQL_BUDGET')
    for name in names:need(private_json(root/name)=={'operationId':operation_id},'QUALIFIER_SQL_SCOPE')
    model.reserve(root/f'read-sql-{len(names)+1}.json',{'operationId':operation_id})


def purge_qualification_input(scope,decision):
    directory=Path('/private/tmp/p08-current-input-'+scope['operationId']);path=directory/'envelope.json'
    if not os.path.lexists(directory):return True
    inspect_current_root(directory,{'envelope.json'})
    if path.exists():
        value=private_json(path)
        need(value.get('decision')==decision and
             model.digest({k:v for k,v in value.items() if k!='decision'})==scope['qualificationScopeSha256'],'CLEANUP_INPUT_SCOPE')
        path.unlink()
    directory.rmdir()
    return not os.path.lexists(directory)


class QualificationCleanupCapability:
    """Committed sanitized cleanup authority; cannot construct a work transport."""
    def __init__(self,root,clock=model.time.time,read_commit=None):
        root=Path(root)
        need(root.parent==Path('/private/tmp') and re.fullmatch(r'p08-current-external-[0-9a-f-]{36}',root.name),'CLEANUP_ROOT_SCOPE')
        inspect_current_root(root,CURRENT_MARKERS)
        record=private_json(root/'cleanup-envelope.json')
        need(set(record)=={'scope','decision'},'CLEANUP_ENVELOPE');s=record['scope'];d=record['decision']
        need(set(s)=={'version','operationId','database','window','sourceCommit','manifestSha256',
            'qualificationScopeSha256','nativeScopeSha256','limits'} and s['version']==1,'CLEANUP_SCOPE')
        model.exact_uuid(s['operationId'],'CLEANUP_OPERATION');operator=_operator_module()
        need(s['database']=={'host':operator.DB_HOST,'port':5432,'database':'neondb','user':'neondb_owner'} and
             s['limits']=={'sql':1,'totalSql':4},'CLEANUP_PINS')
        need(all(isinstance(s[k],str) and re.fullmatch('[a-f0-9]{64}',s[k]) for k in
                 ('manifestSha256','qualificationScopeSha256','nativeScopeSha256')),'CLEANUP_HASH')
        need(set(s['window'])=={'start','cutoff','readEnd','closeoutEnd','purgeEnd'},'CLEANUP_WINDOW')
        times={k:model.timestamp(v) for k,v in s['window'].items()}
        need(times['start']<times['cutoff']<times['readEnd']<times['closeoutEnd']<times['purgeEnd'] and
             times['purgeEnd']-times['start']<=3600 and times['closeoutEnd']-times['readEnd']>=300,'CLEANUP_WINDOW')
        need(clock()>=times['start'],'CLEANUP_NOT_STARTED')
        manifest=model.verify_local_manifest();model.verify_locked_sources()
        need(s['manifestSha256']==source_manifest_sha256(),'QUALIFIER_SOURCE')
        authority=current_module('authority');authority.verify_sources();get=read_commit or authority.committed
        need(set(d)=={'commit','path','sha256'} and re.fullmatch(r'APP013_P08_CURRENT_QUALIFICATION_[0-9]{8}\.json',d['path']),'QUALIFIER_DECISION_REFERENCE')
        raw=get(authority.GOV,d['commit'],d['path'])
        need(model.digest(raw)==d['sha256'] and strict_json(raw)=={'owner':'Debynyhan Banks',
            'decision':'APPROVE_EXACT_P08_CURRENT_QUALIFICATION','externalReadAuthorized':True,
            'scopeSha256':s['qualificationScopeSha256'],'cleanupScopeSha256':model.digest(s)},'QUALIFIER_OWNER_APPROVAL')
        verify_qualification_sources(s['sourceCommit'],manifest,get)
        verify_cleanup_root(root,s,d)
        self.root=root;self.clock=clock;self.last=clock();self.times=times;self.cleanup_scope=s
        self.e={'decision':d,'sdkReview':manifest['sdkReview']};self.plan={'operationId':s['operationId']}
        self.observed=False;self.mode='closeout';self.spent=False
    def gate(self,kind,cleanup=False):
        now=self.clock();need(now>=self.last,'CLOCK_ROLLBACK');self.last=now
        need(kind=='sql' and cleanup,'QUALIFIER_CLOSEOUT_ONLY')
        need(now<self.times['closeoutEnd'],'QUALIFIER_DEADLINE');need(not self.spent,'QUALIFIER_LIMIT')
        verify_cleanup_root(self.root,self.cleanup_scope,self.e['decision'])
        need(private_json(self.root/'independent-closeout.json')=={'operationId':self.plan['operationId']},'CLEANUP_NOT_RESERVED')
        path=_operator_module().PSQL
        need(model.digest(Path(path).read_bytes())==self.e['sdkReview']['files'][path],'SQL_EXECUTABLE_DRIFT')
        reserve_qualification_sql(self.root,self.plan['operationId']);self.spent=True
        return self.times['closeoutEnd']


def verify_qualification_sources(source_commit,manifest,get):
    authority=current_module('authority')
    rel=str(model.ROOT.relative_to(authority.BACKEND))
    need(get(authority.BACKEND,source_commit,rel+'/source-manifest.json')==(model.ROOT/'source-manifest.json').read_bytes(),'QUALIFIER_COMMITTED_MANIFEST')
    for name,h in manifest['files'].items():
        need(model.digest(get(authority.BACKEND,source_commit,rel+'/'+name))==h,'QUALIFIER_COMMITTED_SOURCE')
    for relative,h in manifest['producerDependencies'].items():
        need(model.digest(get(authority.BACKEND,source_commit,'evidence/APP-013/'+relative))==h,'QUALIFIER_COMMITTED_DEPENDENCY')
    for name,h in model.SOURCE_HASHES.items():
        path=str(model.SOURCE_PATHS[name].relative_to(authority.BACKEND))
        need(model.digest(get(authority.BACKEND,source_commit,path))==h,'QUALIFIER_COMMITTED_LOCKED_SOURCE')
    for path,h in manifest['sdkReview']['files'].items():
        need(model.digest(Path(path).read_bytes())==h,'SDK_REVIEW_DRIFT')


class QualificationCapability:
    """Read-only authority; never grants native entry or credential renewal."""
    def __init__(self, envelope, clock=model.time.time, mode='qualify', read_commit=None):
        authority=current_module('authority');authority.verify_sources()
        manifest=model.verify_local_manifest();model.verify_locked_sources()
        need(mode in ('qualify','closeout'),'QUALIFICATION_MODE')
        e=copy.deepcopy(envelope)
        need(set(e)=={'version','plan','nativeScope','sourceCommit','manifestSha256','sdkReview','decision'},'QUALIFIER_ENVELOPE')
        need(e['version']==1 and e['manifestSha256']==source_manifest_sha256(),'QUALIFIER_SOURCE')
        p=e['plan'];scope=e['nativeScope']
        need(set(p)=={'mode','externalReadAuthorized','operationId','prospectiveOperationId','automaticRetryAllowed','allowanceUsd',
            'project','jobId','tenantId','ownerPrincipal','runtimeIdentity','roles','services','permissions','ownershipSha256',
            'sourceHashes','proposalSha256','prospectiveKeyId','readInventory','window','producerDecision','producerManifestSha256','nativeScopeSha256'},'QUALIFIER_PLAN')
        need(p['producerDecision']=='APPROVE_LOCAL_CURRENT_EVIDENCE_PROOF' and p['producerManifestSha256']==e['manifestSha256'] and
             p['nativeScopeSha256']==model.digest(scope),'QUALIFIER_SCOPE_HASH')
        need(set(p['window'])=={'start','cutoff','readEnd','closeoutEnd','purgeEnd'},'QUALIFIER_WINDOW')
        self.times=model.authorize(p,clock(),mode)
        need(p['operationId']!=p['prospectiveOperationId'],'QUALIFIER_DISTINCT_OPERATION')
        need(set(scope)=={'plan','target','database','resources','limits'} and p['prospectiveOperationId']==scope['plan']['operationId'],'QUALIFIER_SCOPE')
        # Pure existing coordinator validators verify the prospective scope, not an execution approval.
        c=authority.load('p08-live-binder-local-20261029/source/coordinator.py','qualifier_scope_validator')
        modules=c.sources();np=scope['plan']
        c.authorize(np,{'decision':'APPROVE_LOCAL_SINGLE_COORDINATOR','externalActionAuthorized':False,
            'operationId':np['operationId'],'planSha256':model.digest(np)},modules,
            model.timestamp(np['window']['start']))
        restore=modules['restore'];operator=_operator_module()
        need(scope['resources']=={'candidate':restore.CANDIDATE,'image':restore.IMAGE,'normalRevision':restore.NORMAL,
            'identity':restore.IDENTITY,'secretVersions':{s:'1' for s in restore.SECRETS}},'QUALIFIER_RESOURCE_PINS')
        need(scope['database']=={'host':operator.DB_HOST,'port':5432,'database':'neondb','user':'neondb_owner'},'QUALIFIER_DATABASE_PINS')
        target=scope['target'];model.exact_uuid(target.get('id'),'QUALIFIER_TARGET')
        need(set(target)=={'id','tenantId','email','fullName','role'} and target['tenantId']==model.TENANT and
             target['email']==model.OWNER and target['fullName']==TARGET_NAME and target['role']=='ADMIN','QUALIFIER_TARGET')
        need(set(scope['limits'])=={'cli','https','sql','child','childRequests'} and all(type(v) is int and 1<=v<=512 for v in scope['limits'].values()) and scope['limits']['child']<=8,'QUALIFIER_NATIVE_LIMITS')
        need(model.timestamp(np['window']['cleanupEnd'])<=self.times['purgeEnd'],'QUALIFIER_EXPIRY')
        review=e['sdkReview']
        need(set(review)=={'files','limits','credentialPolicy','exception','reviewComplete'} and review['reviewComplete'] is True and
             review['limits']=={'cli':27,'https':20,'sql':4,'cache':1} and
             review['credentialPolicy']=='EXISTING_OWNER_SDK_THEN_MATCHED_CACHE_EXPIRY_AFTER_PURGE' and
             review['exception']=='EXACT_REVIEWED_SDK_REFRESH_CACHE_INTERNAL_RETRIES_ONLY','SDK_REVIEW_REQUIRED')
        need(isinstance(review['files'],dict) and len(review['files'])>=1,'SDK_REVIEW_FILES')
        # An exact committed review is required; an arbitrary nonempty file list is not a review.
        need(review==manifest.get('sdkReview'),'SDK_REVIEW_INCOMPLETE')
        d=e['decision'];need(set(d)=={'commit','path','sha256'} and re.fullmatch(r'APP013_P08_CURRENT_QUALIFICATION_[0-9]{8}\.json',d['path']),'QUALIFIER_DECISION_REFERENCE')
        get=read_commit or authority.committed
        raw=get(authority.GOV,d['commit'],d['path'])
        need(model.digest(raw)==d['sha256'] and strict_json(raw)=={'owner':'Debynyhan Banks',
            'decision':'APPROVE_EXACT_P08_CURRENT_QUALIFICATION','externalReadAuthorized':True,
            'scopeSha256':model.digest({k:v for k,v in e.items() if k!='decision'}),
            'cleanupScopeSha256':model.digest(qualification_cleanup_scope(e))},'QUALIFIER_OWNER_APPROVAL')
        verify_qualification_sources(e['sourceCommit'],manifest,get)
        acl=current_module('acl')
        # The configuration snapshot reads no credential payload; it refuses all ambient overrides.
        self.config_root=CONFIG_ROOT
        self.config=None  # Config is inspected only after committed authority and attempt reservation.
        self.e=e;self.plan=p;self.scope=scope;self.clock=clock;self.mode=mode;self.last=clock()
        self.root=Path('/private/tmp/p08-current-external-'+p['operationId'])
        self.counts={'cli':0,'https':0,'sql':0,'cache':0};self.hash=model.digest(e);self.observed=False
        if mode=='qualify':need(not os.path.lexists(self.root),'QUALIFIER_CONSUMED')

    def prepare(self):
        sdk_environment(os.environ)
        self.config=current_module('acl').config_snapshot(self.config_root,os.environ)

    def gate(self,kind,cleanup=False):
        now=self.clock();need(now>=self.last,'CLOCK_ROLLBACK');self.last=now
        need(self.times['start']<=now<self.times['closeoutEnd' if cleanup else 'readEnd'],'QUALIFIER_DEADLINE')
        need(cleanup or self.mode=='qualify','QUALIFIER_CLOSEOUT_ONLY')
        if cleanup:
            path=_operator_module().PSQL
            need(model.digest(Path(path).read_bytes())==self.e['sdkReview']['files'].get(path),'SQL_EXECUTABLE_DRIFT')
        if not cleanup:
            for path,h in self.e['sdkReview']['files'].items():
                need(model.digest(Path(path).read_bytes())==h,'SDK_REVIEW_DRIFT')
        need(self.counts[kind]<self.e['sdkReview']['limits'][kind],'QUALIFIER_LIMIT')
        if kind=='sql':reserve_qualification_sql(self.root,self.plan['operationId'])
        self.counts[kind]+=1
        return self.times['closeoutEnd' if cleanup else 'readEnd']


CONFIG_ROOT=Path('/Users/debynyhanbanks/.config/gcloud')
SDK_ENV={'CLOUDSDK_CORE_DISABLE_FILE_LOGGING':'true','CLOUDSDK_CORE_MAX_LOG_DAYS':'0',
         'CLOUDSDK_CORE_DISABLE_USAGE_REPORTING':'true','CLOUDSDK_CORE_DISABLE_PROMPTS':'true',
         'CLOUDSDK_PYTHON':'/opt/homebrew/Cellar/python@3.14/3.14.2/Frameworks/Python.framework/Versions/3.14/bin/python3.14'}


def sdk_environment(environment):
    need(not any(v for k,v in environment.items() if k.startswith(('CLOUDSDK_','GOOGLE_','GCLOUD_','PG')) or
        k.upper() in ('DATABASE_URL','HTTP_PROXY','HTTPS_PROXY','ALL_PROXY','NO_PROXY','SSL_CERT_FILE',
                     'SSL_CERT_DIR','REQUESTS_CA_BUNDLE','CURL_CA_BUNDLE')),'CREDENTIAL_OVERRIDE')
    need(environment.get('HOME')=='/Users/debynyhanbanks','HOME_OVERRIDE')
    return {'HOME':'/Users/debynyhanbanks','PATH':'/usr/bin:/bin:/opt/homebrew/bin','LANG':'en_US.UTF-8',
            'PYTHONDONTWRITEBYTECODE':'1',**SDK_ENV}


def hidden_password():
    need(sys.stdin.isatty(),'HIDDEN_INPUT_REQUIRED')
    value=getpass.getpass('Qualification SQL password (hidden): ')
    need(isinstance(value,str) and 0<len(value)<=4096,'PASSWORD_SHAPE')
    return value


def validate_cli_descriptor(descriptor):
    need(isinstance(descriptor,dict) and isinstance(descriptor.get('argv'),(tuple,list)),'CLI_SCOPE')
    argv=descriptor['argv']
    need(descriptor in current_cli_contract() or descriptor in current_cli_contract(
        argv[4] if descriptor.get('id')=='billing_account' and len(argv)>4 else '<discovered-account>'),'CLI_SCOPE')


CLI_FAILURE_CODES=frozenset({'PROCESS_DEADLINE','PROCESS_TIMEOUT','PROCESS_OUTPUT_LIMIT','PROCESS_REFUSED',
    'PROCESS_UNCONFIRMED','PROCESS_CLEANUP_UNCONFIRMED','CLOCK_ROLLBACK','TOKEN_OUTPUT','CLI_DEADLINE',
    'CLI_EXECUTABLE','CLI_SCOPE'})


def observed_qualification_cli(cap,descriptor,invoke):
    validate_cli_descriptor(descriptor)
    ordinal=cap.counts['cli']
    need(type(ordinal) is int and 1<=ordinal<=27,'CLI_DIAGNOSTIC_LIMIT')
    inspect_current_root(cap.root,CURRENT_MARKERS)
    common={'operationId':cap.plan['operationId'],'cleanupScopeSha256':model.digest(qualification_cleanup_scope(cap.e)),
        'ordinal':ordinal,'descriptorId':descriptor['id']}
    try:model.reserve(cap.root/f'cli-attempt-{ordinal:02d}.json',
        {**common,'reservedAtMilliseconds':int(cap.clock()*1000),'status':'RESERVED'})
    except Exception:raise model.Stop('CLI_DIAGNOSTIC_WRITE_UNCONFIRMED') from None
    started=model.time.monotonic();failure=None;status='FAILED'
    try:
        value=invoke();status='RETURNED';return value
    except BaseException as error:
        failure=str(error) if isinstance(error,model.Stop) and str(error) in CLI_FAILURE_CODES else 'CLI_UNCONFIRMED'
        if isinstance(error,(KeyboardInterrupt,SystemExit)):raise
        raise model.Stop(failure) from None
    finally:
        elapsed=max(0,min(3600000,int((model.time.monotonic()-started)*1000)))
        try:model.reserve(cap.root/f'cli-result-{ordinal:02d}.json',
            {**common,'status':status,'elapsedMilliseconds':elapsed,'failureCode':failure})
        except Exception:raise model.Stop('CLI_DIAGNOSTIC_WRITE_UNCONFIRMED') from None


class QualificationIO(NativeIO):
    def __init__(self,capability,cleanup_only=False):
        need(type(capability) in (QualificationCapability,QualificationCleanupCapability) and
             (type(capability) is QualificationCapability or cleanup_only),'QUALIFIER_CAPABILITY')
        super().__init__(capability.clock,capability.plan['operationId'])
        self.capability=capability;self.cleanup_only=cleanup_only
    def cli(self,d,deadline):
        need(not self.cleanup_only,'QUALIFIER_CLOSEOUT_ONLY')
        validate_cli_descriptor(d)
        cap=self.capability;cap.gate('cli')
        acl=current_module('acl');snapshot=acl.config_snapshot(cap.config_root,os.environ)
        if cap.config is None:cap.config=snapshot
        need(snapshot==cap.config,'CONFIG_CHANGED')
        value=observed_qualification_cli(cap,d,lambda:super(QualificationIO,self).cli(d,min(deadline,cap.times['readEnd'])))
        if d['id']=='token':
            cap.gate('cache')
            cached=None
            try:
                with acl.http_deadline(max(.01,min(15,cap.times['readEnd']-cap.clock()))):
                    cached=acl.read_cached_token(cap.config_root,cap.times['purgeEnd'])
                need(value=={'accessToken':cached},'TOKEN_CACHE_MISMATCH')
            finally:cached=None
        return value
    def https(self,d,token,deadline):
        need(not self.cleanup_only,'QUALIFIER_CLOSEOUT_ONLY');self.capability.gate('https')
        result=super().https(d,token,min(deadline,self.capability.times['readEnd']))
        self.capability.observed=True;return result
    def sql(self,d,password,deadline):
        cleanup=d==sql_contract()[1]
        need(not self.cleanup_only or cleanup,'QUALIFIER_CLOSEOUT_ONLY');end=self.capability.gate('sql',cleanup)
        result=super().sql(d,password,min(deadline,end))
        self.capability.observed=True;return result
    def independent(self):return QualificationIO(self.capability,True)


def current_dispatch(envelope,mode,clock=model.time.time):
    cap=QualificationCapability(envelope,clock,mode)
    # No hidden credential input or transport construction occurs before every capability gate.
    if mode=='closeout':return recover_current_external(cap)
    io=QualificationIO(cap)
    return _produce_current(cap.plan,cap.scope,io,clock,capability=cap)



def inspect_current_root(root, allowed):
    need(root.is_dir() and not root.is_symlink() and root.resolve()==root and
         root.stat().st_uid==os.getuid() and stat.S_IMODE(root.stat().st_mode)==0o700,'PRIVATE_DIRECTORY')
    need(set(p.name for p in root.iterdir())<=set(allowed),'PRIVATE_INVENTORY')
    for p in root.iterdir():
        st=p.lstat()
        need(stat.S_ISREG(st.st_mode) and not p.is_symlink() and st.st_nlink==1 and
             st.st_uid==os.getuid() and stat.S_IMODE(st.st_mode)==0o600,'PRIVATE_INVENTORY')


def recover_current_external(cap):
    """One cleanup-only restart; never reconstructs work input or produces a candidate."""
    import fcntl
    need(type(cap) in (QualificationCapability,QualificationCleanupCapability),'QUALIFIER_CAPABILITY')
    scope=qualification_cleanup_scope(cap.e) if type(cap) is QualificationCapability else cap.cleanup_scope
    decision=cap.e['decision'];root=cap.root;password=None;io=None;fd=None
    inspect_current_root(root,CURRENT_MARKERS)
    fd=os.open(root/'entry.lock',os.O_WRONLY|os.O_NOFOLLOW)
    try:
        fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
        verify_cleanup_root(root,scope,decision)
        absent=purge_qualification_input(scope,decision)
        need(not (root/'independent-closeout.json').exists(),'INDEPENDENT_CLOSEOUT_CONSUMED')
        # Reservation consumes the independent attempt even if prompting or dispatch is interrupted.
        model.reserve(root/'independent-closeout.json',{'operationId':scope['operationId']})
        residuals=['OWNED_PROCESS_HISTORY_UNKNOWN']
        try:
            need(cap.last<=cap.clock()<cap.times['closeoutEnd'],'QUALIFIER_DEADLINE')
            sdk_environment(os.environ)
            password=recovery_password(cap.times['closeoutEnd'],cap.clock)
            io=QualificationIO(cap,True)
            need(strict_json(io.sql(sql_contract()[1],password,cap.times['closeoutEnd']))=={'sessionsAbsent':True},'SESSIONS_REMAIN')
        except BaseException as error:
            residuals.append('SESSIONS_UNCONFIRMED')
            if isinstance(error,model.Stop) and str(error) in ('RECOVERY_PASSWORD_TIMEOUT','QUALIFIER_DEADLINE'):
                residuals.append(str(error))
        finally:
            password=None
            try:need(io is not None and io.close(cap.times['closeoutEnd']) is True,'PROCESS_CLEANUP_UNCONFIRMED')
            except BaseException:residuals.append('PROCESS_CLEANUP_UNCONFIRMED')
        inspect_current_root(root,CURRENT_MARKERS)
        result={'status':'CURRENT_EVIDENCE_UNQUALIFIED','execution':'EXTERNAL_READ_ONLY',
            'liveObserved':cap.observed,'executionReady':False,'candidate':None,'residuals':residuals,
            'privateInputsAbsent':absent}
        model.reserve(root/'recovery-result.json',result);return result
    finally:
        if fd is not None:fcntl.flock(fd,fcntl.LOCK_UN);os.close(fd)


def current_main(argv=None):
    argv=sys.argv[1:] if argv is None else argv
    if not argv or argv[0] not in ('--qualify-current','--closeout-current'):return native(argv)
    need(len(argv)==2,'QUALIFIER_ARGUMENTS')
    path=Path(argv[1]);directory=path.parent
    if argv[0]=='--closeout-current':
        cap=QualificationCleanupCapability(path)
        result=recover_current_external(cap);print(result['status']);return 2
    need(path.name=='envelope.json' and directory.parent==Path('/private/tmp') and
         re.fullmatch(r'p08-current-input-[0-9a-f-]{36}',directory.name),'QUALIFIER_INPUT_PATH')
    inspect_current_root(directory,{'envelope.json'})
    try:
        envelope=private_json(path)
        need(directory.name=='p08-current-input-'+envelope['plan']['operationId'],'QUALIFIER_INPUT_SCOPE')
        mode='qualify' if argv[0]=='--qualify-current' else 'closeout'
        cap=QualificationCapability(envelope,mode=mode)
        # Durable sanitized cleanup authority precedes input purge and credentials.
        result=_produce_current(cap.plan,cap.scope,QualificationIO(cap),cap.clock,capability=cap,input_path=path)
        if result['failure']=='RECOVERY_PASSWORD_TIMEOUT':print('RECOVERY_PASSWORD_TIMEOUT')
        print(result['status']);return 0 if result['candidate'] else 2
    finally:
        # Only the exact inspected input is owned; never remove foreign content.
        if path.exists() and not path.is_symlink():path.unlink()
        if directory.exists() and not any(directory.iterdir()):directory.rmdir()


# Binding-input recovery is a separate authority, not a relaxed qualification.
RECOVERY_LIMITS={'cli':2,'sql':3,'https':0,'cache':0}


def recovery_password(deadline,clock=model.time.time):
    need(sys.stdin.isatty(),'HIDDEN_INPUT_REQUIRED')
    seconds=min(120,deadline-clock())
    need(seconds>0,'RECOVERY_DEADLINE')
    acl=current_module('acl')
    print(f'Enter the SQL password and press Return within {seconds:.0f} seconds. Input is hidden.',flush=True)
    try:
        with acl.http_deadline(seconds):
            value=hidden_password()
            need(clock()<deadline,'RECOVERY_DEADLINE')
            return value
    except acl.Stop as error:
        if str(error)=='HTTP_TIMEOUT':raise model.Stop('RECOVERY_PASSWORD_TIMEOUT') from None
        raise


RECOVERY_MARKERS={'entry.lock','purge.lock','guard-envelope.json','attempt.json','guard-ready.json',
    'owned-files.json','owned-files.next','handoff-published.json','purge-now.json','purge-result.json',
    'resource-closeout.json','recovery-result.json','recovered-inputs.json','guard-sync.json','guard-ack.json',
    'read-cli-owner.json','read-cli-project.json','read-sql-qualification.json',
    'read-sql-closeout-main.json','read-sql-closeout-independent.json'}


def recovery_source_check(e,manifest,authority,read_commit):
    get=read_commit or authority.committed;d=e['decision']
    need(set(d)=={'commit','path','sha256'} and re.fullmatch(r'APP013_P08_BINDING_RECOVERY_OPERATION_[0-9]{8}\.json',d['path']),'RECOVERY_DECISION_REFERENCE')
    raw=get(authority.GOV,d['commit'],d['path'])
    need(model.digest(raw)==d['sha256'] and strict_json(raw)=={'owner':'Debynyhan Banks',
        'decision':'APPROVE_EXACT_P08_BINDING_INPUT_RECOVERY','externalReadAuthorized':True,
        'scopeSha256':model.digest({k:v for k,v in e.items() if k!='decision'})},'RECOVERY_OWNER_APPROVAL')
    rel=str(model.ROOT.relative_to(authority.BACKEND))
    paths={rel+'/'+n:h for n,h in manifest['files'].items()}
    paths.update({'evidence/APP-013/'+n:h for n,h in manifest['producerDependencies'].items()})
    paths.update({str(model.SOURCE_PATHS[n].relative_to(authority.BACKEND)):h for n,h in model.SOURCE_HASHES.items()})
    need(get(authority.BACKEND,e['sourceCommit'],rel+'/source-manifest.json')==(model.ROOT/'source-manifest.json').read_bytes(),'RECOVERY_COMMITTED_MANIFEST')
    for path,h in paths.items():need(model.digest(get(authority.BACKEND,e['sourceCommit'],path))==h,'RECOVERY_COMMITTED_SOURCE')


class BindingRecoveryCapability:
    def __init__(self,envelope,clock=model.time.time,mode='recover',read_commit=None):
        manifest=model.verify_local_manifest();model.verify_locked_sources()
        authority=current_module('authority');authority.verify_sources();e=copy.deepcopy(envelope)
        need(set(e)=={'version','execution','operationId','qualificationId','project','owner','database',
            'projectNumberSha256','targetSha256','window','limits','sdkException','sdkFilesSha256',
            'manifestSha256','sourceCommit','decision'},'RECOVERY_ENVELOPE')
        need(e['version']==1 and e['execution'] in ('PROOF_ONLY','EXTERNAL_READ_ONLY') and mode in ('recover','closeout','guard','handoff'),'RECOVERY_MODE')
        for k in ('operationId','qualificationId'):model.exact_uuid(e[k],'RECOVERY_OPERATION')
        need(e['operationId']!=e['qualificationId'],'RECOVERY_OPERATION')
        operator=_operator_module()
        need(e['project']==model.PROJECT and e['owner']==model.OWNER and e['database']=={
            'host':operator.DB_HOST,'port':5432,'database':'neondb','user':'neondb_owner'},'RECOVERY_RESOURCE_PINS')
        need(e['limits']==RECOVERY_LIMITS and all(type(x) is int for x in e['limits'].values()),'RECOVERY_LIMITS')
        need(e['sdkException']=='SDK_EXISTING_OWNER_REFRESH_CACHE_INTERNAL_RETRIES_NO_TOKEN_EXPORT' and
             e['sdkFilesSha256']==model.digest(manifest['sdkReview']['files']) and
             e['manifestSha256']==source_manifest_sha256(),'RECOVERY_SOURCE_BINDING')
        need(set(e['window'])=={'start','cutoff','readEnd','closeoutEnd','purgeEnd'},'RECOVERY_WINDOW')
        times={k:model.timestamp(v) for k,v in e['window'].items()}
        need(times['start']<times['cutoff']<times['readEnd']<times['closeoutEnd']<times['purgeEnd'] and
             times['purgeEnd']-times['start']<=3600 and times['closeoutEnd']-times['readEnd']>=300,'RECOVERY_WINDOW')
        need(clock()>=times['start'],'RECOVERY_NOT_STARTED')
        if mode=='recover':need(clock()<times['cutoff'],'RECOVERY_CUTOFF')
        if mode=='handoff':need(clock()<times['purgeEnd'],'RECOVERY_RETENTION_EXPIRED')
        need(all(isinstance(e[k],str) and re.fullmatch('[a-f0-9]{64}',e[k]) for k in ('projectNumberSha256','targetSha256')),'RECOVERY_HASH_PINS')
        self.external=e['execution']=='EXTERNAL_READ_ONLY'
        if self.external:
            need(e['projectNumberSha256']==PROJECT_NUMBER_SHA256 and e['targetSha256']==TARGET_SHA256,'RECOVERY_HASH_PINS')
            recovery_source_check(e,manifest,authority,read_commit)
        else:
            need(e['decision']=={'decision':'APPROVE_LOCAL_BINDING_RECOVERY_PROOF',
                 'scopeSha256':model.digest({k:v for k,v in e.items() if k!='decision'})},'RECOVERY_PROOF_APPROVAL')
        self.e=e;self.clock=clock;self.times=times;self.mode=mode;self.last=clock();self.manifest=manifest
        self.root=Path('/private/tmp/p08-binding-recovery-'+e['operationId'])
        self.input_root=Path('/private/tmp/p08-current-input-'+e['qualificationId'])
        self.hash=model.digest(e);self.config=None;self.observed=False
        if mode=='recover':
            need(not os.path.lexists(self.root) and not os.path.lexists(self.input_root) and
                 not os.path.lexists(Path('/private/tmp/p08-current-external-'+e['qualificationId'])),'RECOVERY_CONSUMED')
    def prepare(self):
        need(self.external and self.mode=='recover','RECOVERY_EXTERNAL_ONLY')
        sdk_environment(os.environ)
        self.config=current_module('acl').config_snapshot(CONFIG_ROOT,os.environ)
    def gate(self,kind,label,cleanup=False):
        now=self.clock();need(now>=self.last,'CLOCK_ROLLBACK');self.last=now
        need(self.times['start']<=now<self.times['closeoutEnd' if cleanup else 'readEnd'],'RECOVERY_DEADLINE')
        need(cleanup or self.mode=='recover','RECOVERY_CLOSEOUT_ONLY')
        allowed={'cli':{'owner','project'},'sql':{'qualification','closeout-main','closeout-independent'}}
        need(kind in allowed and label in allowed[kind] and (not cleanup or label.startswith('closeout-')),'RECOVERY_READ_SCOPE')
        need(not (self.mode=='closeout' and label!='closeout-independent'),'RECOVERY_CLOSEOUT_ONLY')
        self.inspect()
        if self.external:
            paths=self.manifest['sdkReview']['files'] if not cleanup else {_operator_module().PSQL:self.manifest['sdkReview']['files'][_operator_module().PSQL]}
            for path,h in paths.items():need(model.digest(Path(path).read_bytes())==h,'RECOVERY_EXECUTABLE_DRIFT')
        model.reserve(self.root/('read-'+kind+'-'+label+'.json'),{'operationId':self.e['operationId']})
        return self.times['closeoutEnd' if cleanup else 'readEnd']
    def inspect(self):
        inspect_current_root(self.root,RECOVERY_MARKERS)
        a=private_json(self.root/'attempt.json');st=self.root.stat()
        need(a=={'operationId':self.e['operationId'],'scopeSha256':self.hash,'rootIdentity':[st.st_dev,st.st_ino]},'RECOVERY_ROOT_BINDING')


class BindingRecoveryIO(NativeIO):
    def __init__(self,cap,independent=False):
        need(type(cap) is BindingRecoveryCapability and cap.external,'RECOVERY_EXTERNAL_ONLY')
        super().__init__(cap.clock,cap.e['operationId']);self.cap=cap;self.independent_read=independent
    def cli(self,d,deadline):
        need(not self.independent_read and d in cli_contract()[:1]+cli_contract()[2:3],'RECOVERY_CLI_SCOPE')
        end=self.cap.gate('cli',d['id'])
        need(current_module('acl').config_snapshot(CONFIG_ROOT,os.environ)==self.cap.config,'CONFIG_CHANGED')
        value=super().cli(d,min(deadline,end))
        if d['id']=='project':self.cap.observed=True
        return value
    def sql(self,d,password,deadline):
        need(d in sql_contract() and (not self.independent_read or d==sql_contract()[1]),'RECOVERY_SQL_SCOPE')
        cleanup=d==sql_contract()[1]
        label=('closeout-independent' if self.independent_read else 'closeout-main') if cleanup else 'qualification'
        end=self.cap.gate('sql',label,cleanup);result=super().sql(d,password,min(deadline,end))
        self.cap.observed=True;return result
    def https(self,*_):raise model.Stop('RECOVERY_HTTPS_FORBIDDEN')
    def independent(self):return BindingRecoveryIO(self.cap,True)


def initialize_recovery(cap):
    cap.root.mkdir(mode=0o700)
    st=cap.root.stat()
    model.reserve(cap.root/'entry.lock',{})
    model.reserve(cap.root/'purge.lock',{})
    model.reserve(cap.root/'attempt.json',{'operationId':cap.e['operationId'],'scopeSha256':cap.hash,'rootIdentity':[st.st_dev,st.st_ino]})
    model.reserve(cap.root/'guard-envelope.json',cap.e)
    model.reserve(cap.root/'owned-files.json',{})


def recovery_lock(cap):
    import contextlib,fcntl
    @contextlib.contextmanager
    def locked():
        cap.inspect();fd=os.open(cap.root/'purge.lock',os.O_WRONLY|os.O_NOFOLLOW)
        try:fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB);yield
        finally:fcntl.flock(fd,fcntl.LOCK_UN);os.close(fd)
    return locked()


def save_owned_registry(cap,value):
    path=cap.root/'owned-files.next';model.reserve(path,value)
    os.replace(path,cap.root/'owned-files.json')


def recovery_slot(cap,slot):
    need(slot in ('recovered','qualification'),'RECOVERY_PRIVATE_SLOT')
    return cap.root/'recovered-inputs.json' if slot=='recovered' else cap.input_root/'envelope.json'


def record_private_file(cap,slot,value):
    """Write-ahead hash intent permits safe purge even if the writer dies before inode receipt."""
    need(cap.clock()<cap.times['purgeEnd'],'RECOVERY_RETENTION_EXPIRED')
    path=recovery_slot(cap,slot);registry=private_json(cap.root/'owned-files.json')
    need(slot not in registry and not os.path.lexists(path),'RECOVERY_PRIVATE_REPLAY')
    raw=json.dumps(value,sort_keys=True,separators=(',',':')).encode();need(len(raw)<=MAX_OUTPUT,'RECOVERY_PRIVATE_SIZE')
    st=path.parent.stat()
    registry[slot]={'sha256':model.digest(raw),'directory':[st.st_dev,st.st_ino],'file':None}
    save_owned_registry(cap,registry)
    fd=os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
    try:
        need(os.write(fd,raw)==len(raw),'RECOVERY_PRIVATE_WRITE');os.fsync(fd);st=os.fstat(fd)
    finally:os.close(fd)
    registry[slot]['file']=[st.st_dev,st.st_ino];save_owned_registry(cap,registry)


def matched_private_file(cap,slot,record):
    path=recovery_slot(cap,slot)
    need(set(record)=={'sha256','directory','file'},'RECOVERY_OWNERSHIP_RECORD')
    if not os.path.lexists(path):return None
    parent=path.parent.lstat();st=path.lstat()
    need(not path.parent.is_symlink() and stat.S_ISDIR(parent.st_mode) and parent.st_uid==os.getuid() and
         stat.S_IMODE(parent.st_mode)==0o700 and [parent.st_dev,parent.st_ino]==record['directory'],'RECOVERY_DIRECTORY_REPLACED')
    need(stat.S_ISREG(st.st_mode) and st.st_uid==os.getuid() and st.st_nlink==1 and stat.S_IMODE(st.st_mode)==0o600 and
         (record['file'] is None or [st.st_dev,st.st_ino]==record['file']),'RECOVERY_FILE_REPLACED')
    fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW)
    try:
        need(os.fstat(fd).st_ino==st.st_ino and st.st_size<=MAX_OUTPUT,'RECOVERY_FILE_REPLACED')
        raw=os.read(fd,MAX_OUTPUT+1);need(len(raw)<=MAX_OUTPUT and model.digest(raw)==record['sha256'],'RECOVERY_FILE_REPLACED')
    finally:os.close(fd)
    return path


def purge_recovery_files(cap):
    residuals=[]
    with recovery_lock(cap):
        registry=private_json(cap.root/'owned-files.json')
        need(set(registry)<= {'recovered','qualification'},'RECOVERY_OWNERSHIP_RECORD')
        for slot,record in registry.items():
            try:
                path=matched_private_file(cap,slot,record)
                if path is not None:path.unlink()
            except Exception:residuals.append(slot.upper()+'_FILE_UNCONFIRMED')
        for slot in ('recovered','qualification'):
            if os.path.lexists(recovery_slot(cap,slot)):residuals.append(slot.upper()+'_FILE_REMAINS')
        on_time=cap.clock()<=cap.times['purgeEnd']
        result={'operationId':cap.e['operationId'],'status':'PRIVATE_PURGE_UNCONFIRMED' if residuals else ('PRIVATE_PURGE_VERIFIED' if on_time else 'PRIVATE_PURGE_LATE'),
                'rawFilesAbsent':not residuals,'onTime':on_time,'completedAt':cap.clock(),'residuals':sorted(set(residuals))}
        if (cap.root/'purge-result.json').exists():
            prior=private_json(cap.root/'purge-result.json')
            if not residuals and prior.get('rawFilesAbsent') is True and prior.get('onTime') is True:return prior
        # Immutable first receipt; a later reconciliation cannot overwrite a failed receipt.
        if not (cap.root/'purge-result.json').exists():model.reserve(cap.root/'purge-result.json',result)
        return result


def binding_purge_guard(cap):
    import signal,time
    cap.inspect();stop=False;last=cap.clock();hard=time.monotonic()+max(0,cap.times['purgeEnd']-2-last)
    def interrupted(*_):
        nonlocal stop
        stop=True
    old={s:signal.signal(s,interrupted) for s in (signal.SIGINT,signal.SIGTERM)}
    try:
        model.reserve(cap.root/'guard-ready.json',{'scopeSha256':cap.hash,'pid':os.getpid()})
        while not stop:
            now=cap.clock()
            if now<last or now>=cap.times['purgeEnd']-2 or time.monotonic()>=hard or (cap.root/'purge-now.json').exists():break
            last=now
            if (cap.root/'guard-sync.json').exists() and not (cap.root/'guard-ack.json').exists():
                request=private_json(cap.root/'guard-sync.json')
                need(set(request)=={'scopeSha256','nonce'} and request['scopeSha256']==cap.hash and re.fullmatch('[0-9a-f]{32}',request['nonce']),'PURGE_GUARD_SYNC')
                model.reserve(cap.root/'guard-ack.json',{**request,'expiresAt':min(now+3,cap.times['purgeEnd']-2)})
            if (cap.root/'handoff-published.json').exists() and not any(os.path.lexists(recovery_slot(cap,s)) for s in ('recovered','qualification')):break
            time.sleep(min(.05,max(.001,hard-time.monotonic())))
        # A short held writer lock does not defeat expiry; no writes begin at/after expiry.
        until=time.monotonic()+2
        while True:
            try:return purge_recovery_files(cap)
            except BlockingIOError:
                if time.monotonic()>=until:raise model.Stop('PURGE_LOCK_UNCONFIRMED')
                time.sleep(.01)
    finally:
        for s,h in old.items():signal.signal(s,h)


def start_binding_guard(cap):
    import time
    python=SDK_ENV['CLOUDSDK_PYTHON']
    need(model.digest(Path(python).read_bytes())==cap.manifest['sdkReview']['files'][python],'PURGE_INTERPRETER_DRIFT')
    process=subprocess.Popen([python,'-I','-B','-c',
        "import sys;sys.path.insert(0,sys.argv[1]);import qualification_launch as q;raise SystemExit(q.recovery_main(['--binding-input-purge-guard',sys.argv[2]]))",
        str(model.ROOT),str(cap.root)],stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,
        start_new_session=True,env={'PATH':'/usr/bin:/bin','HOME':'/Users/debynyhanbanks','PYTHONDONTWRITEBYTECODE':'1'})
    until=time.monotonic()+5
    while time.monotonic()<until and process.poll() is None:
        if (cap.root/'guard-ready.json').exists():
            ready=private_json(cap.root/'guard-ready.json')
            need(ready=={'scopeSha256':cap.hash,'pid':process.pid},'PURGE_GUARD_BINDING');return process
        time.sleep(.01)
    if process.poll() is None:process.terminate();process.wait(timeout=3)
    raise model.Stop('PURGE_GUARD_NOT_READY')


def validate_recovery_project(cap,project):
    need(isinstance(project,dict) and set(project)=={'projectId','projectNumber','lifecycleState'} and
         project['projectId']==model.PROJECT and project['lifecycleState']=='ACTIVE' and
         isinstance(project['projectNumber'],str) and re.fullmatch('[0-9]{6,20}',project['projectNumber']) and
         model.digest(project['projectNumber'])==cap.e['projectNumberSha256'],'RECOVERY_PROJECT')


def recovery_values(cap,owner,project,raw):
    need(owner==[{'account':model.OWNER,'status':'ACTIVE'}],'RECOVERY_OWNER')
    validate_recovery_project(cap,project)
    fields={'jobCount','job','tenantCount','tenant','operatorCount','operator','calendarCount','roleCount','sessionCount'}
    need(isinstance(raw,dict) and set(raw)==fields and all(type(raw[k]) is int and raw[k]>=0 for k in
         ('jobCount','tenantCount','operatorCount','calendarCount','roleCount','sessionCount')) and raw['operatorCount']==1,'RECOVERY_SQL_OUTPUT')
    row=raw['operator'];need(isinstance(row,dict) and set(row)=={'id','tenantId','email','fullName','role','status'},'RECOVERY_TARGET')
    model.exact_uuid(row['id'],'RECOVERY_TARGET')
    ordered={k:row[k] for k in ('id','tenantId','email','fullName','role','status')}
    need(row['tenantId']==model.TENANT and row['email']==TARGET_EMAIL and row['fullName']==TARGET_NAME and
         row['role']=='ADMIN' and row['status']=='DISABLED' and
         hashlib.sha256(json.dumps(ordered,separators=(',',':')).encode()).hexdigest()==cap.e['targetSha256'],'RECOVERY_TARGET')
    return {'projectNumber':project['projectNumber'],'targetId':row['id']}


def run_binding_recovery(cap,io):
    import fcntl,signal
    need(type(cap) is BindingRecoveryCapability and cap.mode=='recover' and
         ((cap.external and type(io) is BindingRecoveryIO) or (not cap.external and getattr(io,'proof',None) is True)),'RECOVERY_PORT')
    initialize_recovery(cap);fd=os.open(cap.root/'entry.lock',os.O_WRONLY|os.O_NOFOLLOW)
    password=None;values=None;guard=None;failure=None;residuals=[];cleaning=False
    def interrupted(*_):
        if not cleaning:raise model.Stop('INTERRUPTED')
    old={s:signal.signal(s,interrupted) for s in (signal.SIGINT,signal.SIGTERM)}
    try:
        fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
        try:
            guard=start_binding_guard(cap)
            if cap.external:cap.prepare()
            owner=strict_json(io.cli(cli_contract()[0],cap.times['readEnd']))
            need(owner==[{'account':model.OWNER,'status':'ACTIVE'}],'RECOVERY_OWNER')
            project=strict_json(io.cli(cli_contract()[2],cap.times['readEnd']))
            validate_recovery_project(cap,project)
            if cap.external:
                password=recovery_password(cap.times['readEnd'],cap.clock)
            else:password='SYNTHETIC_RECOVERY_ONLY'
            raw=strict_json(io.sql(sql_contract()[0],password,cap.times['readEnd']))
            values=recovery_values(cap,owner,project,raw);raw=None
        except BaseException as error:
            failure=str(error) if isinstance(error,model.Stop) and re.fullmatch('[A-Z_]+',str(error)) else 'RECOVERY_READ_UNCONFIRMED'
        finally:
            cleaning=True
            try:
                need(password is not None and strict_json(io.sql(sql_contract()[1],password,cap.times['closeoutEnd']))=={'sessionsAbsent':True},'RECOVERY_SESSIONS')
            except BaseException:residuals.append('MAIN_SESSIONS_UNCONFIRMED')
            finally:
                try:need(io.close(cap.times['closeoutEnd']) is True,'RECOVERY_PROCESS_CLOSEOUT')
                except BaseException:residuals.append('MAIN_PROCESSES_UNCONFIRMED')
            fresh=None
            try:
                need(password is not None,'RECOVERY_NO_PASSWORD');fresh=io.independent();need(fresh is not io,'RECOVERY_INDEPENDENT')
                need(strict_json(fresh.sql(sql_contract()[1],password,cap.times['closeoutEnd']))=={'sessionsAbsent':True},'RECOVERY_SESSIONS')
            except BaseException:residuals.append('INDEPENDENT_SESSIONS_UNCONFIRMED')
            finally:
                password=None
                try:need(fresh is not None and fresh.close(cap.times['closeoutEnd']) is True,'RECOVERY_PROCESS_CLOSEOUT')
                except BaseException:residuals.append('INDEPENDENT_PROCESSES_UNCONFIRMED')
        model.reserve(cap.root/'resource-closeout.json',{'verified':not residuals,'residuals':residuals})
        if not failure and not residuals:
            need(guard is not None and guard.poll() is None,'PURGE_GUARD_LOST')
            with recovery_lock(cap):
                need(not (cap.root/'purge-result.json').exists(),'PURGE_ALREADY_FINISHED')
                record_private_file(cap,'recovered',values);model.reserve(cap.root/'handoff-published.json',{'scopeSha256':cap.hash})
            status='HANDOFF_RETAINED'
        else:
            status='BINDING_INPUT_RECOVERY_UNQUALIFIED'
            model.reserve(cap.root/'purge-now.json',{})
            if guard is not None:
                try:guard.wait(timeout=5)
                except subprocess.TimeoutExpired:residuals.append('PURGE_GUARD_UNCONFIRMED')
            need(purge_recovery_files(cap)['rawFilesAbsent'],'PRIVATE_PURGE_UNCONFIRMED')
        result={'status':status,'execution':cap.e['execution'],'liveObserved':cap.observed,'executionReady':False,
            'failure':failure,'residuals':residuals,'purgeEnd':cap.e['window']['purgeEnd'],'candidate':None}
        model.reserve(cap.root/'recovery-result.json',result);return result,guard
    finally:
        password=None;values=None
        for s,h in old.items():signal.signal(s,h)
        fcntl.flock(fd,fcntl.LOCK_UN);os.close(fd)


def read_recovered_bindings(cap):
    need(cap.mode=='handoff' and cap.clock()<cap.times['purgeEnd'],'RECOVERY_RETENTION_EXPIRED')
    with recovery_lock(cap):
        need(private_json(cap.root/'resource-closeout.json')['verified'] is True,'RECOVERY_CLOSEOUT_UNCONFIRMED')
        record=private_json(cap.root/'owned-files.json').get('recovered');need(record is not None,'RECOVERY_INPUT_ABSENT')
        path=matched_private_file(cap,'recovered',record);need(path is not None,'RECOVERY_INPUT_ABSENT')
        value=private_json(path);need(set(value)=={'projectNumber','targetId'},'RECOVERY_INPUT_SHAPE')
        row={'id':value['targetId'],'tenantId':model.TENANT,'email':TARGET_EMAIL,'fullName':TARGET_NAME,'role':'ADMIN','status':'DISABLED'}
        need(model.digest(value['projectNumber'])==cap.e['projectNumberSha256'] and
             hashlib.sha256(json.dumps(row,separators=(',',':')).encode()).hexdigest()==cap.e['targetSha256'],'RECOVERY_INPUT_BINDING')
        return value  # Trusted in-memory packet construction only; no CLI prints these values.


def synchronize_recovery_guard(cap):
    import time,uuid
    request={'scopeSha256':cap.hash,'nonce':uuid.uuid4().hex}
    model.reserve(cap.root/'guard-sync.json',request);until=time.monotonic()+2;last=cap.clock()
    while time.monotonic()<until:
        now=cap.clock();need(now>=last and now<cap.times['purgeEnd']-2,'RECOVERY_RETENTION_EXPIRED');last=now
        if (cap.root/'guard-ack.json').exists():
            ack=private_json(cap.root/'guard-ack.json')
            need(set(ack)=={'scopeSha256','nonce','expiresAt'} and all(ack[k]==v for k,v in request.items()) and
                 now<ack['expiresAt']<=cap.times['purgeEnd']-2,'PURGE_GUARD_SYNC')
            return ack['expiresAt']
        time.sleep(.01)
    raise model.Stop('PURGE_GUARD_UNCONFIRMED')


def handoff_recovered_bindings(cap,envelope):
    need(cap.external and cap.mode=='handoff','RECOVERY_HANDOFF_AUTHORITY')
    values=read_recovered_bindings(cap)
    qualified=QualificationCapability(envelope,clock=cap.clock)
    need(set(qualified.scope['plan'])=={'mode','externalActionAuthorized','automaticRetryAllowed','allowanceUsd','project',
         'projectNumber','projectNumberSha256','tenantId','jobId','ownerPrincipal','runtimeIdentity','serviceRetention','operationId','keyId','window'} and
         set(qualified.scope['plan']['window'])=={'start','cutoff','workEnd','cleanupEnd','purgeEnd'},'RECOVERY_HANDOFF_PLAN_FIELDS')
    need(qualified.plan['operationId']==cap.e['qualificationId'] and qualified.times['purgeEnd']<=cap.times['purgeEnd'] and
         qualified.scope['target']['id']==values['targetId'] and
         str(qualified.scope['plan']['projectNumber'])==values['projectNumber'],'RECOVERY_HANDOFF_SCOPE')
    lease=synchronize_recovery_guard(cap)
    with recovery_lock(cap):
        need(cap.clock()<lease and not (cap.root/'purge-result.json').exists(),'RECOVERY_RETENTION_EXPIRED')
        cap.input_root.mkdir(mode=0o700)
        record_private_file(cap,'qualification',envelope)
        record=private_json(cap.root/'owned-files.json')['recovered']
        path=matched_private_file(cap,'recovered',record);need(path is not None,'RECOVERY_INPUT_ABSENT');path.unlink()
    values=None
    return {'status':'QUALIFICATION_INPUT_TRANSFERRED','executionReady':False}


def closeout_binding_recovery(cap):
    import fcntl
    cap.inspect();fd=os.open(cap.root/'entry.lock',os.O_WRONLY|os.O_NOFOLLOW);password=None;io=None
    try:
        fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
        # Pure purge remains permitted after expiry; it does not renew any provider-read allowance.
        if not (cap.root/'purge-now.json').exists():model.reserve(cap.root/'purge-now.json',{})
        result=purge_recovery_files(cap)
        if (cap.root/'resource-closeout.json').exists():return {**result,'resourceCloseout':private_json(cap.root/'resource-closeout.json'),'candidate':None}
        residuals=['OWNED_PROCESS_HISTORY_UNKNOWN']
        if cap.external and cap.clock()<cap.times['closeoutEnd'] and not (cap.root/'read-sql-closeout-independent.json').exists():
            try:
                password=recovery_password(cap.times['closeoutEnd'],cap.clock)
                io=BindingRecoveryIO(cap,True)
                need(strict_json(io.sql(sql_contract()[1],password,cap.times['closeoutEnd']))=={'sessionsAbsent':True},'RECOVERY_SESSIONS')
            except BaseException as error:
                residuals.append('RECOVERY_PASSWORD_TIMEOUT' if isinstance(error,model.Stop) and str(error)=='RECOVERY_PASSWORD_TIMEOUT' else 'SESSIONS_UNCONFIRMED')
            finally:
                password=None
                try:need(io is not None and io.close(cap.times['closeoutEnd']) is True,'RECOVERY_PROCESS_CLOSEOUT')
                except BaseException:residuals.append('PROCESS_CLOSEOUT_UNCONFIRMED')
        else:residuals.append('SESSIONS_UNCONFIRMED')
        return {**result,'resourceCloseout':{'verified':False,'residuals':residuals},'candidate':None}
    finally:password=None;fcntl.flock(fd,fcntl.LOCK_UN);os.close(fd)


def recovery_main(argv):
    modes={'--recover-binding-inputs':'recover','--closeout-binding-inputs':'closeout','--binding-input-purge-guard':'guard'}
    need(len(argv)==2 and argv[0] in modes,'RECOVERY_ARGUMENTS');mode=modes[argv[0]];path=Path(argv[1])
    if mode=='recover':
        need(path.name=='envelope.json' and path.parent.parent==Path('/private/tmp') and
             re.fullmatch(r'p08-binding-request-[0-9a-f-]{36}',path.parent.name),'RECOVERY_INPUT_PATH')
        inspect_current_root(path.parent,{'envelope.json'})
        try:
            e=private_json(path);need(path.parent.name=='p08-binding-request-'+e['operationId'],'RECOVERY_INPUT_SCOPE')
            cap=BindingRecoveryCapability(e);need(cap.external,'RECOVERY_EXTERNAL_ONLY')
            path.unlink();path.parent.rmdir()
            result,_=run_binding_recovery(cap,BindingRecoveryIO(cap))
            if result['failure']=='RECOVERY_PASSWORD_TIMEOUT':print('RECOVERY_PASSWORD_TIMEOUT')
            print(result['status']);return 0 if result['status']=='HANDOFF_RETAINED' else 2
        finally:
            if path.exists() and not path.is_symlink():path.unlink()
            if path.parent.exists() and not any(path.parent.iterdir()):path.parent.rmdir()
    need(path.parent==Path('/private/tmp') and re.fullmatch(r'p08-binding-recovery-[0-9a-f-]{36}',path.name),'RECOVERY_ROOT')
    cap=BindingRecoveryCapability(private_json(path/'guard-envelope.json'),mode=mode);need(cap.root==path,'RECOVERY_ROOT')
    result=binding_purge_guard(cap) if mode=='guard' else closeout_binding_recovery(cap)
    complete=result['rawFilesAbsent'] and result.get('onTime')
    if mode!='guard':
        complete=complete and result.get('resourceCloseout',{}).get('verified') is True
        print('BINDING_RECOVERY_CLOSED' if complete else 'BINDING_RECOVERY_CLOSEOUT_UNCONFIRMED')
    return 0 if complete else 2



PROJECT_DIAGNOSTIC_MARKERS={'envelope.json','attempt.json','entry.lock','result.json','closeout.json',
    *[f'command-{kind}-{name}.json' for kind in ('attempt','result') for name in ('owner','project')]}
PROJECT_DIAGNOSTIC_FAILURES=CLI_FAILURE_CODES|frozenset({'INTERRUPTED','OWNER_MISMATCH','PROJECT_MISMATCH',
    'PROJECT_OUTPUT_INVALID','CONFIG_CHANGED','DIAGNOSTIC_DEADLINE','CLOCK_ROLLBACK',
    'DIAGNOSTIC_WRITE_UNCONFIRMED','CREDENTIAL_OVERRIDE','HOME_OVERRIDE'})


class ProjectDiagnosticCapability:
    def __init__(self,envelope,clock=model.time.time,mode='diagnose',read_commit=None):
        need(mode in ('diagnose','closeout'),'DIAGNOSTIC_MODE')
        e=copy.deepcopy(envelope);manifest=model.verify_local_manifest();model.verify_locked_sources()
        authority=current_module('authority');authority.verify_sources()
        need(set(e)=={'version','execution','operationId','project','owner','projectNumberSha256',
            'sourceCommit','manifestSha256','sdkFilesSha256','sdkException','window','limits','decision'},'DIAGNOSTIC_ENVELOPE')
        need(type(e['version']) is int and e['version']==1 and e['execution']=='EXTERNAL_READ_ONLY','DIAGNOSTIC_EXECUTION')
        model.exact_uuid(e['operationId'],'DIAGNOSTIC_OPERATION')
        need(e['project']==model.PROJECT and e['owner']==model.OWNER and e['projectNumberSha256']==PROJECT_NUMBER_SHA256,'DIAGNOSTIC_PINS')
        need(e['limits']=={'cli':2,'sql':0,'https':0,'cache':0} and all(type(v) is int for v in e['limits'].values()),'DIAGNOSTIC_LIMITS')
        need(e['sdkException']=='SDK_EXISTING_OWNER_REFRESH_CACHE_INTERNAL_RETRIES_NO_TOKEN_EXPORT' and
             e['sdkFilesSha256']==model.digest(manifest['sdkReview']['files']) and e['manifestSha256']==source_manifest_sha256(),'DIAGNOSTIC_SOURCE')
        need(isinstance(e['sourceCommit'],str) and re.fullmatch('[a-f0-9]{40}',e['sourceCommit']),'DIAGNOSTIC_SOURCE')
        need(set(e['window'])=={'start','cutoff','readEnd','closeoutEnd'},'DIAGNOSTIC_WINDOW')
        times={k:model.timestamp(v) for k,v in e['window'].items()}
        need(times['start']<times['cutoff']<times['readEnd']<times['closeoutEnd'] and
             times['closeoutEnd']-times['start']<=600 and times['closeoutEnd']-times['readEnd']>=10,'DIAGNOSTIC_WINDOW')
        d=e['decision'];need(set(d)=={'commit','path','sha256'} and re.fullmatch('[a-f0-9]{40}',d['commit']) and
            re.fullmatch('[a-f0-9]{64}',d['sha256']) and re.fullmatch(r'APP013_P08_OWNER_PROJECT_DIAGNOSTIC_OPERATION_[0-9]{8}\.json',d['path']),'DIAGNOSTIC_DECISION')
        get=read_commit or authority.committed;raw=get(authority.GOV,d['commit'],d['path'])
        scope=model.digest({k:v for k,v in e.items() if k!='decision'})
        need(model.digest(raw)==d['sha256'] and strict_json(raw)=={'owner':'Debynyhan Banks',
             'decision':'APPROVE_EXACT_P08_OWNER_PROJECT_DIAGNOSTIC','externalReadAuthorized':True,'scopeSha256':scope},'DIAGNOSTIC_APPROVAL')
        verify_qualification_sources(e['sourceCommit'],manifest,get)
        now=clock()
        if mode=='diagnose':need(times['start']<=now<times['cutoff'],'DIAGNOSTIC_START_WINDOW')
        self.e=e;self.clock=clock;self.mode=mode;self.times=times;self.last=now;self.manifest=manifest;self.scope_hash=scope
        self.root=Path('/private/tmp/p08-owner-project-'+e['operationId']);self.config=None;self.count=0
        if mode=='diagnose':need(not os.path.lexists(self.root),'DIAGNOSTIC_CONSUMED')
    def prepare(self):
        sdk_environment(os.environ)
        self.config=current_module('acl').config_snapshot(CONFIG_ROOT,os.environ)
    def inspect(self):
        inspect_current_root(self.root,PROJECT_DIAGNOSTIC_MARKERS)
        need(private_json(self.root/'envelope.json')==self.e and
             private_json(self.root/'attempt.json')=={'operationId':self.e['operationId'],'scopeSha256':self.scope_hash},'DIAGNOSTIC_ROOT_BINDING')
    def gate(self,d):
        need(self.mode=='diagnose' and self.count<2 and d==cli_contract()[0 if self.count==0 else 2],'DIAGNOSTIC_COMMAND')
        now=self.clock();need(now>=self.last,'CLOCK_ROLLBACK');self.last=now
        need(self.times['start']<=now<self.times['readEnd'],'DIAGNOSTIC_DEADLINE')
        sdk_environment(os.environ)
        need(self.config is not None and current_module('acl').config_snapshot(CONFIG_ROOT,os.environ)==self.config,'CONFIG_CHANGED')
        for path,h in self.manifest['sdkReview']['files'].items():need(model.digest(Path(path).read_bytes())==h,'SDK_REVIEW_DRIFT')
        self.inspect()
        try:model.reserve(self.root/f"command-attempt-{d['id']}.json",{'operationId':self.e['operationId'],
                 'scopeSha256':self.scope_hash,'descriptorId':d['id'],'status':'RESERVED'})
        except Exception:raise model.Stop('DIAGNOSTIC_WRITE_UNCONFIRMED') from None
        self.count+=1
        return self.times['readEnd']


class ProjectDiagnosticIO(NativeIO):
    def __init__(self,cap):
        need(type(cap) is ProjectDiagnosticCapability and cap.mode=='diagnose','DIAGNOSTIC_PORT')
        super().__init__(cap.clock,cap.e['operationId']);self.cap=cap
    def cli(self,d,deadline):
        need(d in (cli_contract()[0],cli_contract()[2]),'DIAGNOSTIC_COMMAND')
        return super().cli(d,min(deadline,self.cap.gate(d)))
    def sql(self,*args):raise model.Stop('DIAGNOSTIC_SQL_FORBIDDEN')
    def https(self,*args):raise model.Stop('DIAGNOSTIC_HTTPS_FORBIDDEN')


def project_diagnostic_failure(error):
    return str(error) if isinstance(error,model.Stop) and str(error) in PROJECT_DIAGNOSTIC_FAILURES else 'DIAGNOSTIC_UNCONFIRMED'


def run_project_diagnostic(cap,io=None):
    import fcntl,signal,threading,time
    need(type(cap) is ProjectDiagnosticCapability and cap.mode=='diagnose','DIAGNOSTIC_MODE')
    need(io is None or (getattr(io,'proof',None) is True),'DIAGNOSTIC_PORT')
    need(cap.times['start']<=cap.clock()<cap.times['cutoff'],'DIAGNOSTIC_START_WINDOW')
    cap.root.mkdir(mode=0o700)
    fd=os.open(cap.root/'entry.lock',os.O_CREAT|os.O_EXCL|os.O_WRONLY,0o600)
    failure=None;cleaned=False;owner=None;project=None;handlers={};cleaning=False;value=None
    def interrupted(*_):
        if not cleaning:raise model.Stop('INTERRUPTED')
    try:
        fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
        model.reserve(cap.root/'envelope.json',cap.e)
        model.reserve(cap.root/'attempt.json',{'operationId':cap.e['operationId'],'scopeSha256':cap.scope_hash})
        if threading.current_thread() is threading.main_thread():
            for sig in (signal.SIGINT,signal.SIGTERM):handlers[sig]=signal.signal(sig,interrupted)
        try:
            cap.prepare();io=io or ProjectDiagnosticIO(cap)
            for d in (cli_contract()[0],cli_contract()[2]):
                deadline=cap.gate(d) if getattr(io,'proof',False) else cap.times['readEnd']
                started=time.monotonic();code=None;matched=False
                try:
                    value=strict_json(io.cli(d,deadline))
                    now=cap.clock();need(now>=cap.last,'CLOCK_ROLLBACK');cap.last=now
                    need(now<cap.times['readEnd'],'DIAGNOSTIC_DEADLINE')
                    if d['id']=='owner':
                        need(value==[{'account':model.OWNER,'status':'ACTIVE'}],'OWNER_MISMATCH');owner=True
                    else:
                        need(isinstance(value,dict) and set(value)=={'projectId','projectNumber','lifecycleState'} and
                             isinstance(value.get('projectNumber'),str),'PROJECT_OUTPUT_INVALID')
                        need(value['projectId']==model.PROJECT and value['lifecycleState']=='ACTIVE' and
                             re.fullmatch('[0-9]{6,20}',value['projectNumber']) and model.digest(value['projectNumber'])==cap.e['projectNumberSha256'],'PROJECT_MISMATCH')
                        project=True
                    matched=True
                except BaseException as error:
                    code=project_diagnostic_failure(error);raise model.Stop(code) from None
                finally:
                    value=None
                    try:model.reserve(cap.root/f"command-result-{d['id']}.json",{'operationId':cap.e['operationId'],
                        'scopeSha256':cap.scope_hash,'descriptorId':d['id'],'matched':matched,
                        'elapsedMilliseconds':max(0,min(3600000,int((time.monotonic()-started)*1000))),'failureCode':code})
                    except Exception:raise model.Stop('DIAGNOSTIC_WRITE_UNCONFIRMED') from None
        except BaseException as error:failure=project_diagnostic_failure(error)
        finally:
            cleaning=True;value=None
            try:cleaned=io is not None and io.close(cap.times['closeoutEnd']) is True
            except BaseException:cleaned=False
        cap.inspect()
        result={'status':'OWNER_PROJECT_OBSERVED' if owner and project and cleaned and not failure else 'OWNER_PROJECT_UNQUALIFIED',
            'operationId':cap.e['operationId'],'scopeSha256':cap.scope_hash,'failure':failure,
            'ownerMatched':owner,'projectMatched':project,'processCleanupVerified':cleaned,
            'residuals':[] if cleaned else ['PROCESS_CLEANUP_UNCONFIRMED'],
            'cliReservations':cap.count,'reservationSemantics':'RESERVATIONS_NOT_PROVIDER_REQUEST_COUNTS',
            'liveObserved':not getattr(io,'proof',False) and cap.count>0,'executionReady':False,'candidate':None}
        model.reserve(cap.root/'result.json',result);return result
    finally:
        for sig,handler in handlers.items():signal.signal(sig,handler)
        fcntl.flock(fd,fcntl.LOCK_UN);os.close(fd)


def closeout_project_diagnostic(cap):
    import fcntl
    need(type(cap) is ProjectDiagnosticCapability and cap.mode=='closeout','DIAGNOSTIC_MODE');cap.inspect()
    fd=os.open(cap.root/'entry.lock',os.O_WRONLY|os.O_NOFOLLOW)
    try:
        fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
        need(not (cap.root/'closeout.json').exists(),'DIAGNOSTIC_CLOSEOUT_CONSUMED')
        normal=private_json(cap.root/'result.json') if (cap.root/'result.json').exists() else None
        verified=bool(normal and normal.get('operationId')==cap.e['operationId'] and normal.get('scopeSha256')==cap.scope_hash and normal.get('processCleanupVerified') is True)
        result={'operationId':cap.e['operationId'],'scopeSha256':cap.scope_hash,'processCleanupVerified':verified,
            'residuals':[] if verified else ['PROCESS_HISTORY_UNKNOWN'],'candidate':None,'executionReady':False}
        model.reserve(cap.root/'closeout.json',result);return result
    finally:fcntl.flock(fd,fcntl.LOCK_UN);os.close(fd)


def project_diagnostic_main(argv):
    need(len(argv)==2 and argv[0] in ('--diagnose-owner-project','--closeout-owner-project'),'DIAGNOSTIC_ARGUMENTS')
    path=Path(argv[1])
    if argv[0]=='--diagnose-owner-project':
        result=run_project_diagnostic(ProjectDiagnosticCapability(private_json(path)))
        print(result['status']);return 0 if result['status']=='OWNER_PROJECT_OBSERVED' else 2
    cap=ProjectDiagnosticCapability(private_json(path/'envelope.json'),mode='closeout')
    need(path==cap.root,'DIAGNOSTIC_ROOT_BINDING');result=closeout_project_diagnostic(cap)
    print('OWNER_PROJECT_CLOSED' if result['processCleanupVerified'] else 'OWNER_PROJECT_CLOSEOUT_UNCONFIRMED')
    return 0 if result['processCleanupVerified'] else 2


if __name__ == "__main__":
    try:raise SystemExit(project_diagnostic_main(sys.argv[1:]) if sys.argv[1:2] and sys.argv[1] in ('--diagnose-owner-project','--closeout-owner-project') else recovery_main(sys.argv[1:]) if sys.argv[1:2] and sys.argv[1] in ('--recover-binding-inputs','--closeout-binding-inputs','--binding-input-purge-guard') else current_main())
    except Exception:
        print('CURRENT_QUALIFICATION_REFUSED');raise SystemExit(2)
