"""Disabled native binding for the P08 Stage A diagnostics controller.

The launcher is evidence-only. It requires an immutable future operation and
approval document before it can resolve credentials or issue HTTPS requests.
"""
from __future__ import annotations

import copy
import datetime as dt
import hashlib
import json
import os
import re
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
import uuid
from pathlib import Path
from zoneinfo import ZoneInfo

import diagnostics_stage as stage


ROOT = Path(__file__).resolve().parent
PROPOSAL_COMMIT = "e758c79"
PLAN_MODE = "P08_STAGE_A_EXTERNAL"
GCLOUD = "/opt/homebrew/bin/gcloud"
MAX_BODY = 65536
ALLOWED_HOSTS = (
    "https://serviceusage.googleapis.com/v1/",
    "https://policytroubleshooter.googleapis.com/v3/iam:troubleshoot",
)
OPERATION_DOCUMENT = re.compile(
    r"APP013_P08_STAGE_A_OPERATION_([0-9]{8})(?:_R(0[1-9]|[1-9][0-9]))?\.md"
)
EASTERN = ZoneInfo("America/New_York")


class Stop(stage.Stop):
    pass


def need(value, code):
    if not value:
        raise Stop(code)


def sha256(value):
    if isinstance(value, str):
        value = value.encode()
    return hashlib.sha256(value).hexdigest()


def private_json(path):
    path = Path(path)
    need(path.is_file() and not path.is_symlink(), "PRIVATE_FILE")
    need(path.stat().st_mode & 0o077 == 0, "PRIVATE_PERMISSIONS")
    try:
        value = json.loads(path.read_text())
    except (OSError, ValueError):
        raise Stop("PRIVATE_JSON")
    need(isinstance(value, dict), "PRIVATE_JSON")
    return value


def check_source_manifest(root=ROOT):
    path = Path(root) / "source-manifest.json"
    need(path.is_file() and not path.is_symlink(), "SOURCE_MANIFEST")
    try:
        manifest = json.loads(path.read_text())
    except (OSError, ValueError):
        raise Stop("SOURCE_MANIFEST")
    need(isinstance(manifest, dict), "SOURCE_MANIFEST")
    need(manifest.get("status") == "DISABLED_LAUNCH_BINDING_ONLY", "SOURCE_STATUS")
    need(manifest.get("governanceProposalCommit") == PROPOSAL_COMMIT, "PROPOSAL_PIN")
    for name, expected in manifest.get("files", {}).items():
        target = Path(root) / name
        need(not Path(name).is_absolute() and ".." not in Path(name).parts, "SOURCE_PATH")
        need(target.is_file() and not target.is_symlink(), "SOURCE_PATH")
        need(sha256(target.read_bytes()) == expected, "SOURCE_DRIFT")
    return manifest, sha256(path.read_bytes())


def canonical_project_fingerprint(project_number):
    need(re.fullmatch(r"[0-9]{6,20}", project_number or "") is not None, "PROJECT_NUMBER")
    return sha256(json.dumps(project_number, separators=(",", ":")))


def validate_operation_document(document, window):
    match = OPERATION_DOCUMENT.fullmatch(document or "")
    need(match is not None, "OPERATION_DOCUMENT")
    need(isinstance(window, dict), "WINDOW_KEYS")
    try:
        dates = {
            dt.datetime.fromtimestamp(stage.timestamp(window[name]), EASTERN).strftime("%Y%m%d")
            for name in ("start", "cutoff", "workEnd", "cleanupEnd", "purgeEnd")
        }
    except (KeyError, TypeError, ValueError, OverflowError):
        raise Stop("WINDOW_DATE")
    need(dates == {match.group(1)}, "OPERATION_DOCUMENT_DATE")
    return match.group(1), match.group(2)


def validate_plan(plan, manifest_sha, now):
    need(plan.get("mode") == PLAN_MODE and plan.get("externalActionAuthorized") is True, "EXTERNAL_APPROVAL")
    need(str(uuid.UUID(plan.get("operationId", ""))) == plan["operationId"], "OPERATION_ID")
    need(str(uuid.UUID(plan.get("decisionId", ""))) == plan["decisionId"], "DECISION_ID")
    need(plan.get("projectId") == stage.PROJECT and plan.get("ownerPrincipal") == stage.OWNER, "PROJECT_OR_OWNER")
    need(re.fullmatch(r"[0-9]{6,20}", plan.get("projectNumber", "")) is not None, "PROJECT_NUMBER")
    need(re.fullmatch(r"[0-9a-f]{64}", plan.get("projectNumberFingerprint", "")) is not None, "PROJECT_FINGERPRINT")
    need(plan.get("projectFingerprintEncoding") == "CANONICAL_JSON_STRING_SHA256", "PROJECT_FINGERPRINT_ENCODING")
    need(plan.get("service") == stage.SERVICE and plan.get("serviceRetention") == "RETAIN_IF_ENABLED", "SERVICE_SCOPE")
    need(plan.get("tuples") == [list(value) for value in stage.TUPLES], "DIAGNOSTIC_SCOPE")
    need(plan.get("automaticRetryAllowed") is False and plan.get("stageBAllowed") is False, "RETRY_OR_STAGE_B")
    need(plan.get("sourceManifestSha256") == manifest_sha, "SOURCE_MANIFEST_PIN")
    approval = plan.get("approval")
    need(isinstance(approval, dict) and approval.get("externalActionApproved") is True, "EXTERNAL_APPROVAL")
    need(approval.get("proposalCommit") == PROPOSAL_COMMIT, "PROPOSAL_PIN")
    need(approval.get("decisionId") == plan["decisionId"], "DECISION_ID")
    need(re.fullmatch(r"[0-9a-f]{40}", approval.get("governanceCommit", "")) is not None, "GOVERNANCE_COMMIT")
    validate_operation_document(approval.get("operationDocument", ""), plan.get("window"))
    need(re.fullmatch(r"[0-9a-f]{64}", approval.get("documentSha256", "")) is not None, "OPERATION_DOCUMENT_HASH")
    local = copy.deepcopy(plan)
    local["mode"] = "LOCAL_DIAGNOSTICS_STAGE_ONLY"
    local["externalActionAuthorized"] = False
    window = stage.approve_local_plan(local, now)
    return local, window


def verify_approval_document(plan, reader):
    approval = plan["approval"]
    raw = reader(approval["governanceCommit"], approval["operationDocument"])
    need(isinstance(raw, bytes) and sha256(raw) == approval["documentSha256"], "OPERATION_DOCUMENT_HASH")
    text = raw.decode("utf-8", "strict")
    for value in (plan["operationId"], plan["decisionId"], plan["sourceManifestSha256"], "RETAIN_IF_ENABLED"):
        need(value in text, "APPROVAL_DOCUMENT_BINDING")
    need(re.search(r"owner decision:\s*APPROVED", text, re.I) is not None, "OWNER_DECISION")


def git_reader(repository):
    repository = str(repository)

    def read(commit, path):
        completed = subprocess.run(
            ["/usr/bin/git", "show", f"{commit}:{path}"],
            cwd=repository,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            timeout=5,
            check=False,
            env={"PATH": "/usr/bin:/bin"},
        )
        need(completed.returncode == 0 and len(completed.stdout) <= MAX_BODY, "APPROVAL_DOCUMENT_READ")
        return completed.stdout

    return read


class NativeCLI:
    def __init__(self, binary=GCLOUD, clock=time.time):
        self.binary = binary
        self.clock = clock
        self.children = set()

    def __call__(self, arguments, deadline):
        allowed = (
            ["config", "get-value", "account", "--quiet"],
            ["projects", "describe", stage.PROJECT, "--format=json", "--quiet"],
            ["auth", "print-access-token", "--quiet"],
        )
        need(arguments in allowed, "CLI_SCOPE")
        need(self.clock() < deadline, "DEADLINE")
        environment = {"PATH": "/usr/bin:/bin:/opt/homebrew/bin", "CLOUDSDK_CORE_DISABLE_PROMPTS": "1"}
        process = subprocess.Popen(
            [self.binary, *arguments], stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
            stderr=subprocess.PIPE, env=environment, start_new_session=True,
        )
        self.children.add(process)
        try:
            output, _error = process.communicate(timeout=max(0.1, min(8, deadline - self.clock())))
        except subprocess.TimeoutExpired:
            os.killpg(process.pid, signal.SIGTERM)
            try:
                process.wait(timeout=1)
            except subprocess.TimeoutExpired:
                os.killpg(process.pid, signal.SIGKILL)
                process.wait(timeout=1)
            raise Stop("CLI_TIMEOUT")
        except BaseException:
            if process.poll() is None:
                os.killpg(process.pid, signal.SIGTERM)
                try:
                    process.wait(timeout=1)
                except subprocess.TimeoutExpired:
                    os.killpg(process.pid, signal.SIGKILL)
                    process.wait(timeout=1)
            raise
        finally:
            if process.poll() is not None:
                self.children.discard(process)
        need(process.returncode == 0, "CLI_REFUSED")
        need(len(output) <= MAX_BODY, "CLI_OUTPUT_LIMIT")
        return output.decode("utf-8", "strict").strip()

    def close(self):
        for process in list(self.children):
            if process.poll() is None:
                os.killpg(process.pid, signal.SIGTERM)
                try:
                    process.wait(timeout=1)
                except subprocess.TimeoutExpired:
                    os.killpg(process.pid, signal.SIGKILL)
                    process.wait(timeout=1)
            self.children.discard(process)
        return not self.children


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, _request, _file_pointer, _code, _message, _headers, _new_url):
        return None


class NativeHTTP:
    def __init__(self, opener=None, clock=time.time):
        self.opener = opener or urllib.request.build_opener(NoRedirect())
        self.clock = clock

    def __call__(self, descriptor, token, deadline):
        url = descriptor.get("url", "")
        need(url == ALLOWED_HOSTS[1] or url.startswith(ALLOWED_HOSTS[0]), "HOST_SCOPE")
        need("apikeys.googleapis.com" not in url and self.clock() < deadline, "HOST_SCOPE")
        body = descriptor.get("body")
        data = None if body is None else body.encode()
        headers = {
            "Authorization": "Bearer " + token,
            "Accept": "application/json",
            "x-goog-user-project": stage.PROJECT,
        }
        if data is not None:
            headers["Content-Type"] = "application/json"
        request = urllib.request.Request(url, method=descriptor["method"], data=data, headers=headers)
        try:
            with self.opener.open(request, timeout=max(0.1, min(descriptor["timeoutSeconds"], deadline - self.clock()))) as response:
                raw = response.read(MAX_BODY + 1)
                status = response.status
        except urllib.error.HTTPError as error:
            raw = error.read(MAX_BODY + 1)
            status = error.code
        except Exception:
            raise Stop("HTTPS_REFUSED")
        need(len(raw) <= MAX_BODY, "HTTPS_OUTPUT_LIMIT")
        try:
            text = raw.decode("utf-8", "strict")
            json.loads(text)
        except (UnicodeError, ValueError):
            raise Stop("HTTPS_OUTPUT")
        return {"httpStatus": status, "body": text}


class BoundAdapter:
    def __init__(self, plan, cli, http, deadline):
        self.plan = plan
        self.cli = cli
        self.http = http
        self.deadline = deadline
        self.token = ""
        self.http_calls = 0

    def qualify(self):
        account = self.cli(["config", "get-value", "account", "--quiet"], self.deadline)
        need(account == stage.OWNER, "OWNER_MISMATCH")
        raw = self.cli(["projects", "describe", stage.PROJECT, "--format=json", "--quiet"], self.deadline)
        try:
            project = json.loads(raw)
        except ValueError:
            raise Stop("PROJECT_OUTPUT")
        need(isinstance(project, dict) and project.get("projectId") == stage.PROJECT, "PROJECT_MISMATCH")
        number = str(project.get("projectNumber", ""))
        need(number == self.plan["projectNumber"], "PROJECT_NUMBER_MISMATCH")
        need(canonical_project_fingerprint(number) == self.plan["projectNumberFingerprint"], "PROJECT_FINGERPRINT_MISMATCH")
        token = self.cli(["auth", "print-access-token", "--quiet"], self.deadline)
        need(re.fullmatch(r"[A-Za-z0-9._~-]{20,8192}", token or "") is not None, "TOKEN_FORMAT")
        self.token = token

    def transport(self, descriptor):
        need(bool(self.token), "TOKEN_ABSENT")
        self.http_calls += 1
        need(self.http_calls <= 30, "REQUEST_LIMIT")
        return self.http(descriptor, self.token, self.deadline)

    def close(self):
        self.token = ""
        return self.cli.close()


def execute(plan, output_directory, manifest_sha, cli, http, approval_reader, clock=time.time, pause=time.sleep):
    local_plan, window = validate_plan(plan, manifest_sha, clock())
    verify_approval_document(plan, approval_reader)
    output = Path(output_directory)
    output.mkdir(mode=0o700, parents=True, exist_ok=False)
    need(output.stat().st_mode & 0o077 == 0, "PRIVATE_DIRECTORY")
    stage_root = Path(tempfile.mkdtemp(prefix="stage-model-", dir=output))
    adapter = BoundAdapter(plan, cli, http, window["workEnd"])
    result = None
    failure = None
    closeout = False
    try:
        adapter.qualify()
        request_adapter = stage.RequestAdapter(local_plan, adapter.transport)
        controller = stage.Controller(local_plan, request_adapter, stage_root, clock=clock, pause=pause)
        modeled = controller.run()
        result = {
            "status": "P08_STAGE_A_DIAGNOSTICS_COMPLETE" if modeled["status"] == "LOCAL_DIAGNOSTICS_STAGE_COMPLETE" else "P08_STAGE_A_DIAGNOSTICS_STOPPED",
            "failure": modeled["failure"],
            "serviceState": modeled["serviceState"],
            "diagnostics": modeled["diagnostics"],
            "fourDiagnosticsCanAccess": modeled["fourDiagnosticsCanAccess"],
            "stageBCandidate": modeled["stageBCandidate"],
            "stageBActionAuthorized": False,
            "serviceRetention": "RETAIN_IF_ENABLED",
            "httpsRequestCount": adapter.http_calls,
            "providerMutationPossible": modeled["serviceState"] in ("SERVICE_ENABLED_RETAINED", "ENABLE_OUTCOME_UNKNOWN"),
        }
    except BaseException as error:
        failure = str(error) if isinstance(error, (Stop, stage.Stop)) and re.fullmatch(r"[A-Z_]+", str(error)) else "REFUSED_OR_UNKNOWN"
        result = {
            "status": "P08_STAGE_A_LAUNCH_STOPPED",
            "failure": failure,
            "serviceState": "UNOBSERVED",
            "diagnostics": [],
            "fourDiagnosticsCanAccess": False,
            "stageBCandidate": False,
            "stageBActionAuthorized": False,
            "serviceRetention": "RETAIN_IF_ENABLED",
            "httpsRequestCount": adapter.http_calls,
            "providerMutationPossible": False,
        }
    finally:
        closeout = adapter.close()
        shutil.rmtree(stage_root, ignore_errors=True)
    result["credentialCleared"] = adapter.token == ""
    result["childProcessCloseout"] = "VERIFIED" if closeout else "UNCONFIRMED"
    result["modelScratchPurged"] = not stage_root.exists()
    stage.reserve(output / "result.json", result)
    return result


def native(arguments=None):
    arguments = list(sys.argv[1:] if arguments is None else arguments)
    try:
        check_source_manifest()
        need(len(arguments) == 3 and arguments[0] == "--run", "UNBOUND")
        plan_path, output = arguments[1:]
        plan = private_json(plan_path)
        manifest_sha = sha256((ROOT / "source-manifest.json").read_bytes())
        governance = Path("/Users/debynyhanbanks/Web Projects/signmons-governance-r08-recovery")
        result = execute(plan, output, manifest_sha, NativeCLI(), NativeHTTP(), git_reader(governance))
        print(result["status"])
        return 0 if result["status"] == "P08_STAGE_A_DIAGNOSTICS_COMPLETE" else 2
    except BaseException:
        print("P08_STAGE_A_LAUNCH_REFUSED_UNBOUND")
        return 2


if __name__ == "__main__":
    raise SystemExit(native())
