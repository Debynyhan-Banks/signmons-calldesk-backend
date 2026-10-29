"""Disabled P08 current-state qualification model; injected read adapters only."""
from __future__ import annotations

import datetime as dt
import hashlib
import json
import os
import re
import signal
import stat
import time
import uuid
from pathlib import Path


ROOT = Path(__file__).resolve().parent
PROJECT = "signmons"
JOB = "9180bef4-561d-47a0-869f-925e6a3dfd96"
TENANT = "a1adcfd4-15be-404b-9ac3-5edb1fda20f0"
OWNER = "debynyhan@signmons.com"
IDENTITY = "signmons-calldesk-p07-runtime@signmons.iam.gserviceaccount.com"
LOOKUP_ROLE = "projects/signmons/roles/signmonsP08FirebaseUserLookup"
SIGNING_ROLE = "projects/signmons/roles/signmonsP08ServiceAccountSignBlob"
OWNERSHIP_SHA256 = "65409264d701edf8201878f6d058dfbbc3302412e683b36913a81b4578e6b668"
PROPOSAL_SHA256 = "8f28bfdeb3b924e6a9c282c9579338ae352ad1fccda93531b7bf5f908849d157"
SERVICES = ("serviceusage.googleapis.com", "iam.googleapis.com", "iamcredentials.googleapis.com", "identitytoolkit.googleapis.com", "apikeys.googleapis.com", "policytroubleshooter.googleapis.com")
PERMISSIONS = ("resourcemanager.projects.getIamPolicy", "resourcemanager.projects.setIamPolicy", "iam.serviceAccounts.getIamPolicy", "iam.serviceAccounts.setIamPolicy", "apikeys.keys.create", "apikeys.keys.get", "apikeys.keys.getKeyString", "apikeys.keys.delete", "serviceusage.operations.get")
SOURCE_HASHES = {
    "roles": "e1fbc15d95450da7662db684e2cfe6f063c8a60fd7c8243053e5431fc3f973f9",
    "restoration": "a0bf4bc90cca0bd52935915d710ccb44e065dd3deed841a12ab49cb3ac4a1cb9",
    "operator": "7b43d332625bbf7f2735187bf5709f0e6ff58c975d98c1b4aef33f911f77807c",
    "firebase": "ee4906f969ae40e40b4c4a066829afc63257c62a8e9e60fcdbc1ea376b91855a",
    "access": "d54334352529e3aa4d3717be6b1c6f840ec284d3b83a9a3aaeb5053fa7547576",
}
SOURCE_PATHS = {
    "roles": ROOT.parent.parent / "p08-exact-role-provisioning-local-20261028/source/role_provisioner.py",
    "restoration": ROOT.parent.parent / "p08-restoration-local-20261028/source/restore.py",
    "operator": ROOT.parent.parent / "p08-operator-diagnostic-local-20261022/controller.py",
    "firebase": ROOT.parent.parent / "p08-authentication-local-20261026/source/auth-adapters.mjs",
    "access": ROOT.parent.parent / "p08-access-resolution-local-20261028/source/access_readiness.py",
}
OWNERSHIP_PATH = ROOT.parent.parent / "p08-oct26-0915-live-result/journal.json"


class Stop(Exception):
    pass


def need(value, code):
    if not value:
        raise Stop(code)


def digest(value):
    raw = value if isinstance(value, bytes) else json.dumps(value, sort_keys=True, separators=(",", ":")).encode()
    return hashlib.sha256(raw).hexdigest()


def exact_uuid(value, code):
    try:
        need(isinstance(value, str) and str(uuid.UUID(value)) == value, code)
    except (ValueError, AttributeError, TypeError):
        raise Stop(code) from None


def timestamp(value):
    need(isinstance(value, str) and re.fullmatch(r"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ", value), "UTC_FORMAT")
    return dt.datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()


def verify_locked_sources(paths=None, ownership=OWNERSHIP_PATH):
    paths = SOURCE_PATHS if paths is None else paths
    need(set(paths) == set(SOURCE_HASHES), "SOURCE_SET")
    for name, expected in SOURCE_HASHES.items():
        path = Path(paths[name]); need(path.is_file() and not path.is_symlink(), "SOURCE_PATH")
        need(hashlib.sha256(path.read_bytes()).hexdigest() == expected, "SOURCE_DRIFT")
    ownership = Path(ownership)
    need(ownership.is_file() and not ownership.is_symlink(), "OWNERSHIP_PATH")
    need(hashlib.sha256(ownership.read_bytes()).hexdigest() == OWNERSHIP_SHA256, "OWNERSHIP_DRIFT")
    return True


def verify_local_manifest():
    path = ROOT / "source-manifest.json"; need(path.is_file() and not path.is_symlink(), "LOCAL_MANIFEST")
    value = json.loads(path.read_text())
    need(value.get("status") == "DISABLED_LOCAL_PREPARATION_ONLY" and value.get("lockedSources") == SOURCE_HASHES, "LOCAL_MANIFEST")
    need(value.get("ownershipSha256") == OWNERSHIP_SHA256, "LOCAL_MANIFEST")
    need(set(value.get("files", {})) == {"composed_qualification.py", "test_composed_qualification.py"}, "LOCAL_MANIFEST_SET")
    for name, expected in value["files"].items():
        target = ROOT / name
        need(target.is_file() and not target.is_symlink() and hashlib.sha256(target.read_bytes()).hexdigest() == expected, "LOCAL_SOURCE_DRIFT")
    return value


def authorize(plan, now, mode="qualify"):
    need(plan.get("mode") == "LOCAL_COMPOSED_QUALIFICATION_ONLY" and plan.get("externalReadAuthorized") is False, "LOCAL_ONLY")
    exact_uuid(plan.get("operationId"), "OPERATION_ID"); exact_uuid(plan.get("prospectiveOperationId"), "PROSPECTIVE_OPERATION_ID")
    need(plan.get("automaticRetryAllowed") is False and plan.get("allowanceUsd") == 0, "RETRY_OR_ALLOWANCE")
    need(plan.get("project") == PROJECT and plan.get("jobId") == JOB and plan.get("tenantId") == TENANT, "BUSINESS_SCOPE")
    need(plan.get("ownerPrincipal") == OWNER and plan.get("runtimeIdentity") == IDENTITY, "IDENTITY_SCOPE")
    need(plan.get("roles") == [LOOKUP_ROLE, SIGNING_ROLE] and plan.get("services") == list(SERVICES) and plan.get("permissions") == list(PERMISSIONS), "READ_SCOPE")
    need(plan.get("ownershipSha256") == OWNERSHIP_SHA256 and plan.get("sourceHashes") == SOURCE_HASHES and plan.get("proposalSha256") == PROPOSAL_SHA256, "SOURCE_BINDING")
    expected_key = "signmons-p08-" + plan["prospectiveOperationId"].replace("-", "")
    need(plan.get("prospectiveKeyId") == expected_key, "KEY_SCOPE")
    need(plan.get("readInventory") == read_inventory(plan), "INVENTORY_BINDING")
    times = {name: timestamp(plan.get("window", {}).get(name)) for name in ["start", "cutoff", "readEnd", "closeoutEnd", "purgeEnd"]}
    need(times["start"] < times["cutoff"] < times["readEnd"] < times["closeoutEnd"] < times["purgeEnd"], "WINDOW_ORDER")
    need(times["purgeEnd"] - times["start"] <= 3600 and times["closeoutEnd"] - times["readEnd"] >= 300, "WINDOW_BOUNDS")
    need(mode in ["qualify", "closeout"] and times["start"] <= now < times["cutoff" if mode == "qualify" else "closeoutEnd"], "START_CUTOFF")
    return times


def read_inventory(plan):
    key = "projects/<private-project-number>/locations/global/keys/" + plan["prospectiveKeyId"]
    return {
        "domains": ["cloud", "access", "database", "firebase", "closeout"],
        "services": list(SERVICES), "permissions": list(PERMISSIONS), "keyResourceTemplate": key,
        "sql": ["EXACT_JOB_TENANT_OPERATOR_ROLE_READ_ONLY", "EXACT_SESSION_CLOSEOUT_READ_ONLY"],
        "mutations": [], "stripe": False,
    }


CLOUD_KEYS = {"ownerExact", "overridesAbsent", "projectExact", "projectNumberBound", "billingEnabled", "billingOpen", "candidateSourceExact", "environmentExact", "candidateReady", "trafficRetired", "identityDisabled", "secretsRetired", "secretBindingsAbsent"}
DATABASE_KEYS = {"jobExact", "tenantActive", "paymentGateExact", "calendarAbsent", "operatorExactDisabled", "dbRoleRetired", "sessionsAbsent", "ownershipReceiptExact"}
FIREBASE_KEYS = {"existsOne", "uidExact", "disabled", "identityExact", "claimsExact", "tokensRevoked"}


def classify_cloud(value):
    need(isinstance(value, dict) and set(value) == CLOUD_KEYS, "CLOUD_SHAPE")
    return "QUALIFIED" if all(value.values()) else "DRIFT"


def classify_access(value):
    need(isinstance(value, dict) and set(value) == {"rolesExact", "bindingsAbsent", "services", "permissions", "keyAbsence"}, "ACCESS_SHAPE")
    need(set(value["services"]) == set(SERVICES) and all(v in ["ENABLED", "DISABLED", "UNKNOWN"] for v in value["services"].values()), "SERVICE_SHAPE")
    need(set(value["permissions"]) == set(PERMISSIONS) and all(v in ["GRANTED", "DENIED", "UNKNOWN"] for v in value["permissions"].values()), "PERMISSION_SHAPE")
    need(value["keyAbsence"] in ["NOT_FOUND", "PRESENT", "DENIED", "UNKNOWN"], "KEY_ABSENCE_SHAPE")
    if any(v == "UNKNOWN" for v in value["services"].values()) or any(v == "UNKNOWN" for v in value["permissions"].values()) or value["keyAbsence"] in ["DENIED", "UNKNOWN"]: return "UNKNOWN"
    if any(v == "DISABLED" for v in value["services"].values()) or any(v == "DENIED" for v in value["permissions"].values()) or value["keyAbsence"] == "PRESENT": return "NOT_READY"
    return "QUALIFIED" if value["rolesExact"] is True and value["bindingsAbsent"] is True else "DRIFT"


def classify_database(value):
    need(isinstance(value, dict) and set(value) == DATABASE_KEYS, "DATABASE_SHAPE")
    return "QUALIFIED" if all(value.values()) else "DRIFT"


def classify_firebase(value):
    need(isinstance(value, dict) and set(value) == FIREBASE_KEYS, "FIREBASE_SHAPE")
    return "QUALIFIED" if all(value.values()) else "DRIFT"


def reserve(path, value):
    fd = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    try: os.write(fd, json.dumps(value, sort_keys=True).encode())
    finally: os.close(fd)


class Coordinator:
    def __init__(self, plan, adapter, directory, clock=time.time, mode="qualify"):
        self.plan=plan; self.adapter=adapter; self.dir=Path(directory); self.clock=clock; self.mode=mode
        self.times=authorize(plan,clock(),mode); self.last=clock(); self.abort=False; self.cleaning=False
        need(self.dir.is_dir() and not self.dir.is_symlink() and stat.S_IMODE(self.dir.stat().st_mode)==0o700,"PRIVATE_DIRECTORY")
        self.journal={"operationId":plan["operationId"],"planSha256":digest(plan),"completed":[],"domains":{},"residuals":[]}
    def save(self):
        temp=self.dir/"journal.tmp"; target=self.dir/"journal.json"; fd=os.open(temp,os.O_CREAT|os.O_EXCL|os.O_WRONLY,0o600)
        try:os.write(fd,json.dumps(self.journal,sort_keys=True).encode())
        finally:os.close(fd)
        os.replace(temp,target)
    def gate(self,cleanup=False):
        now=self.clock();need(now>=self.last,"CLOCK_ROLLBACK");self.last=now
        need(now<self.times["closeoutEnd" if cleanup else "readEnd"],"DEADLINE");need(cleanup or not self.abort,"INTERRUPTED")
    def call(self,name,cleanup=False):
        self.gate(cleanup);value=getattr(self.adapter,name)(deadline=self.times["closeoutEnd" if cleanup else "readEnd"]);self.gate(cleanup);return value
    def run(self):
        need(self.mode=="qualify","QUALIFY_MODE");reserve(self.dir/"attempt.json",{"operationId":self.plan["operationId"],"planSha256":digest(self.plan)})
        previous={}
        def stop(*_):
            if not self.cleaning:self.abort=True
        for item in [signal.SIGINT,signal.SIGTERM]:previous[item]=signal.signal(item,stop)
        failure=None
        try:
            self.save()
            for domain,classifier in [("cloud",classify_cloud),("access",classify_access),("database",classify_database),("firebase",classify_firebase)]:
                verdict=classifier(self.call("read_"+domain));self.journal["domains"][domain]=verdict;self.journal["completed"].append(domain);self.save()
                if verdict!="QUALIFIED":raise Stop(domain.upper()+"_"+verdict)
        except BaseException as error:
            failure=str(error) if isinstance(error,Stop) else "ADAPTER_REFUSED_OR_UNKNOWN";self.journal["failure"]=failure;self.save()
        finally:
            self.cleaning=True
            try:closed=self.call("closeout",cleanup=True) is True
            except BaseException:closed=False
            self.cleaning=False
            if not closed:self.journal["residuals"].append("CLOSEOUT_UNCONFIRMED")
            self.journal["domains"]["closeout"]="QUALIFIED" if closed else "CONTAINMENT_UNCONFIRMED";self.save()
            for item,handler in previous.items():signal.signal(item,handler)
        all_exact=not failure and closed and all(self.journal["domains"].get(x)=="QUALIFIED" for x in ["cloud","access","database","firebase","closeout"])
        return {"status":"P08_COMPOSED_QUALIFICATION_LOCAL_VERIFIED" if all_exact else "CONTAINMENT_UNCONFIRMED" if not closed else "P08_COMPOSED_QUALIFICATION_LOCAL_STOPPED","verdict":"QUALIFIED" if all_exact else "UNKNOWN" if failure and failure.endswith("_UNKNOWN") else "NOT_READY" if failure and failure.endswith("_NOT_READY") else "DRIFT" if failure and failure.endswith("_DRIFT") else "UNKNOWN","failure":failure,"domains":self.journal["domains"],"residuals":self.journal["residuals"],"realExternalReads":0,"realExternalMutations":0,"nativeTransportAvailable":False}


def native():
    verify_local_manifest();verify_locked_sources();print("P08_COMPOSED_QUALIFICATION_REFUSED_UNBOUND");return 2


if __name__=="__main__":raise SystemExit(native())
