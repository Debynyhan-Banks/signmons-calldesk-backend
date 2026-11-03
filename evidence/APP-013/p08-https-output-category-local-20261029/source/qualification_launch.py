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
        env = {k: v for k, v in os.environ.items() if not k.startswith("PG") and k != "DATABASE_URL" and k not in CREDENTIAL_OVERRIDE_KEYS}
        timeout = max(1, min(30, int(deadline - self.clock())))
        need(descriptor in current_cli_contract() or descriptor in current_cli_contract(argv[4] if descriptor['id']=='billing_account' and len(argv)>4 else '<discovered-account>'),'CLI_SCOPE')
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
        env = {k: v for k, v in os.environ.items() if not k.startswith("PG") and k != "DATABASE_URL"}
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

class CurrentAdapter(Adapter):
    def __init__(self,plan,scope,io,clock):
        self.plan=copy.deepcopy(plan);self.scope=copy.deepcopy(scope);self.io=io;self.clock=clock
        self.times=model.authorize(plan,clock());self.cli={};self.http={};self.closed=False
        self.token=None;self.project_number=None;self.billing_account=None;self.firebase_uid=None
        self.binding={'candidateImage':scope['resources']['image'],'normalRevision':scope['resources']['normalRevision'],
                      'databasePassword':'SYNTHETIC_CURRENT_PROOF_ONLY'}
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
            v=self._https(d);body=v['body']
            if d['id'].startswith('service_'):
                need(v['status']==200 and body.get('state')=='ENABLED' and body.get('name')==d['url'].split('/v1/')[1],'SERVICE_NOT_READY')
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
    """Produces a candidate only inside an owned local proof; never resolves native credentials."""
    import fcntl,signal,threading
    need(getattr(io,'proof',None) is True,'CURRENT_PROOF_ONLY')
    model.verify_local_manifest();model.verify_locked_sources()
    need(set(native_scope)=={'plan','target','database','resources','limits'},'CURRENT_SCOPE')
    need(plan.get('producerDecision')=='APPROVE_LOCAL_CURRENT_EVIDENCE_PROOF' and
         plan.get('producerManifestSha256')==source_manifest_sha256() and
         plan.get('nativeScopeSha256')==model.digest(native_scope),'CURRENT_DECISION_BINDING')
    need(plan['prospectiveOperationId']==native_scope['plan']['operationId'],'CURRENT_OPERATION_BINDING')
    times=model.authorize(plan,clock());root=Path('/private/tmp/p08-current-proof-'+plan['operationId'])
    root.mkdir(mode=0o700)  # A consumed operation cannot be retried.
    fd=os.open(root/'entry.lock',os.O_CREAT|os.O_EXCL|os.O_WRONLY,0o600)
    adapter=None;failure=None;residuals=[];candidate=None;cleaning=False;handlers={}
    def interrupted(*_):
        if not cleaning:raise model.Stop('INTERRUPTED')
    if threading.current_thread() is threading.main_thread():
        for sig in (signal.SIGINT,signal.SIGTERM):handlers[sig]=signal.signal(sig,interrupted)
    try:
        fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
        model.reserve(root/'attempt.json',{'operationId':plan['operationId'],'scopeSha256':plan['nativeScopeSha256']})
        try:
            adapter=CurrentAdapter(plan,native_scope,io,clock)
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
                fresh=io.independent();need(fresh is not io and getattr(fresh,'proof',None) is True,'INDEPENDENT_SCOPE')
                model.reserve(root/'independent-closeout.json',{'operationId':plan['operationId']})
                need(strict_json(fresh.sql(sql_contract()[1],'SYNTHETIC_CURRENT_PROOF_ONLY',times['closeoutEnd']))=={'sessionsAbsent':True},'SESSIONS_REMAIN')
            except BaseException:residuals.append('INDEPENDENT_UNCONFIRMED')
            finally:
                try:need(fresh is not None and fresh.close(times['closeoutEnd']) is True,'INDEPENDENT_UNCONFIRMED')
                except BaseException:residuals.append('INDEPENDENT_UNCONFIRMED')
        need(adapter is not None and adapter.last<=clock()<times['purgeEnd'],'PURGE_DEADLINE')
        # This proof persists only sanitized markers; no raw private input or output file is permitted.
        need(set(p.name for p in root.iterdir())=={'entry.lock','attempt.json','independent-closeout.json'} and
             all(not p.is_symlink() and stat.S_IMODE(p.stat().st_mode)==0o600 for p in root.iterdir()),'PRIVATE_INVENTORY')
        if not failure and not residuals:
            authority=current_module('authority');authority.verify_sources()
            until=native_scope['plan']['window']['cleanupEnd']
            need(clock()<model.timestamp(until)<=times['purgeEnd'],'QUALIFICATION_EXPIRY')
            candidate={'status':'QUALIFIED_FOR_NATIVE_ENTRY','operationId':plan['prospectiveOperationId'],
               'scopeSha256':model.digest(native_scope),'qualifiedUntil':until,
               'runtimeEnvironmentSha256':adapter.binding['environmentSha256'],
               'roleAclSha256':adapter.role_result['roleAclSha256'],
               'checks':{k:True for k in ('owner','billing','effectiveAccess','services','database','firebase','job','retiredRuntime','privateInventory')}}
            envelope={'version':1,'execution':'PROOF_ONLY',**native_scope,'qualification':candidate,
                'sourceManifestSha256':authority.digest((authority.HERE/'source-manifest.json').read_bytes()),'sourceCommit':'0'*40}
            envelope['decision']={'decision':'APPROVE_LOCAL_NATIVE_ENTRY_PROOF','scopeSha256':authority.digest(envelope)}
            authority.Capability(envelope,Path('/private/tmp/p08-coordinator-'+plan['prospectiveOperationId']),clock=clock)
        result={'status':'CURRENT_EVIDENCE_LOCAL_VERIFIED' if candidate else 'CURRENT_EVIDENCE_UNQUALIFIED',
                'execution':'PROOF_ONLY','liveObserved':False,'executionReady':False,'failure':failure,
                'residuals':sorted(set(residuals)),'candidate':candidate}
        model.reserve(root/'result.json',result);return result
    finally:
        for sig,handler in handlers.items():signal.signal(sig,handler)
        fcntl.flock(fd,fcntl.LOCK_UN);os.close(fd)


if __name__ == "__main__":
    raise SystemExit(native())
