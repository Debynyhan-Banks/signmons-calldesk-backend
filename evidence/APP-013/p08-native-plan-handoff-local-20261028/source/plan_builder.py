"""Disabled deterministic operation-document to private-plan builder.

This module performs no credential, command-line cloud, OAuth, HTTP, database or provider
action. Native invocation remains unbound; tests inject private synthetic data.
"""
from __future__ import annotations

import copy
import datetime as dt
import json
import os
import re
import shutil
import stat
import sys
import time
import uuid
from pathlib import Path

import diagnostics_stage as stage
import launch_binding as launch


ROOT = Path(__file__).resolve().parent
CORRECTION_PROPOSAL_COMMIT = "832407d"
MARKER = re.compile(r"<!-- P08_OPERATION_BINDING\n(\{.*?\})\n-->", re.DOTALL)
EXPECTED_KEYS = {
    "automaticRetryAllowed", "backendCommit", "decisionId", "mode", "operationId",
    "ownerPrincipal", "projectId", "proposalCommit", "service", "serviceRetention",
    "sourceManifestSha256", "stageBAllowed", "tuples", "window",
}


class Stop(stage.Stop):
    pass


def need(value, code):
    if not value:
        raise Stop(code)


def strict_object(pairs):
    value = {}
    for key, item in pairs:
        need(key not in value, "DOCUMENT_DUPLICATE_KEY")
        value[key] = item
    return value


def parse_document(raw, manifest_sha):
    need(isinstance(raw, bytes) and len(raw) <= launch.MAX_BODY, "DOCUMENT_SIZE")
    try:
        text = raw.decode("utf-8", "strict")
    except UnicodeError:
        raise Stop("DOCUMENT_ENCODING")
    need(len(re.findall(r"owner decision:\s*APPROVED", text, re.I)) == 1, "OWNER_DECISION")
    need(len(re.findall(r"Status:\s*APPROVED", text, re.I)) == 1, "DOCUMENT_STATUS")
    matches = MARKER.findall(text)
    need(len(matches) == 1, "DOCUMENT_BINDING_BLOCK")
    try:
        binding = json.loads(matches[0], object_pairs_hook=strict_object)
    except (ValueError, TypeError):
        raise Stop("DOCUMENT_BINDING_JSON")
    need(isinstance(binding, dict) and set(binding) == EXPECTED_KEYS, "DOCUMENT_BINDING_KEYS")
    for field in ("operationId", "decisionId"):
        try:
            parsed = str(uuid.UUID(binding.get(field, "")))
        except (ValueError, TypeError, AttributeError):
            raise Stop(field.upper())
        need(parsed == binding[field], field.upper())
    need(re.fullmatch(r"[0-9a-f]{40}", binding.get("backendCommit", "")) is not None, "BACKEND_COMMIT")
    need(binding.get("sourceManifestSha256") == manifest_sha, "SOURCE_MANIFEST_PIN")
    need(binding.get("mode") == launch.PLAN_MODE, "PLAN_MODE")
    need(binding.get("proposalCommit") == launch.PROPOSAL_COMMIT, "PROPOSAL_PIN")
    need(binding.get("projectId") == stage.PROJECT and binding.get("ownerPrincipal") == stage.OWNER, "PROJECT_OR_OWNER")
    need(binding.get("service") == stage.SERVICE and binding.get("serviceRetention") == "RETAIN_IF_ENABLED", "SERVICE_SCOPE")
    need(binding.get("tuples") == [list(value) for value in stage.TUPLES], "DIAGNOSTIC_SCOPE")
    need(binding.get("automaticRetryAllowed") is False and binding.get("stageBAllowed") is False, "RETRY_OR_STAGE_B")
    window = binding.get("window")
    need(isinstance(window, dict) and set(window) == {"start", "cutoff", "workEnd", "cleanupEnd", "purgeEnd"}, "WINDOW_KEYS")
    timestamps = [stage.timestamp(window[name]) for name in ("start", "cutoff", "workEnd", "cleanupEnd", "purgeEnd")]
    need(all(left < right for left, right in zip(timestamps, timestamps[1:])), "WINDOW_ORDER")
    need(timestamps[3] - timestamps[2] >= 30 and timestamps[4] - timestamps[0] <= 3600, "WINDOW_SIZE")
    for value in (binding["operationId"], binding["decisionId"], binding["sourceManifestSha256"], "RETAIN_IF_ENABLED"):
        need(text.count(value) >= 1, "DOCUMENT_BINDING_TEXT")
    return binding


def construct_plan(binding, project_number, project_fingerprint, governance_commit, document, document_sha):
    need(re.fullmatch(r"[0-9]{6,20}", project_number or "") is not None, "PROJECT_NUMBER")
    need(launch.canonical_project_fingerprint(project_number) == project_fingerprint, "PROJECT_FINGERPRINT_MISMATCH")
    need(re.fullmatch(r"[0-9a-f]{40}", governance_commit or "") is not None, "GOVERNANCE_COMMIT")
    launch.validate_operation_document(document, binding.get("window"))
    need(re.fullmatch(r"[0-9a-f]{64}", document_sha or "") is not None, "OPERATION_DOCUMENT_HASH")
    return {
        "mode": binding["mode"],
        "externalActionAuthorized": True,
        "operationId": binding["operationId"],
        "decisionId": binding["decisionId"],
        "projectId": binding["projectId"],
        "projectNumber": project_number,
        "projectNumberFingerprint": project_fingerprint,
        "projectFingerprintEncoding": "CANONICAL_JSON_STRING_SHA256",
        "ownerPrincipal": binding["ownerPrincipal"],
        "service": binding["service"],
        "serviceRetention": binding["serviceRetention"],
        "tuples": copy.deepcopy(binding["tuples"]),
        "automaticRetryAllowed": binding["automaticRetryAllowed"],
        "stageBAllowed": binding["stageBAllowed"],
        "sourceManifestSha256": binding["sourceManifestSha256"],
        "window": copy.deepcopy(binding["window"]),
        "approval": {
            "externalActionApproved": True,
            "proposalCommit": binding["proposalCommit"],
            "decisionId": binding["decisionId"],
            "governanceCommit": governance_commit,
            "operationDocument": document,
            "documentSha256": document_sha,
        },
    }


def purge(directory):
    directory = Path(directory)
    need(directory.is_dir() and not directory.is_symlink(), "PURGE_DIRECTORY")
    entries = list(directory.iterdir())
    need(all(entry.name == "plan.json" and entry.is_file() and not entry.is_symlink() for entry in entries), "PURGE_SCOPE")
    for entry in entries:
        need(stat.S_IMODE(entry.stat().st_mode) == 0o600, "PRIVATE_PERMISSIONS")
        entry.unlink()
    directory.rmdir()
    need(not directory.exists(), "PURGE_READBACK")


def check_builder_manifest(root=ROOT):
    path = Path(root) / "builder-source-manifest.json"
    need(path.is_file() and not path.is_symlink(), "BUILDER_MANIFEST")
    try:
        manifest = json.loads(path.read_text())
    except (OSError, ValueError):
        raise Stop("BUILDER_MANIFEST")
    need(manifest.get("status") == "DISABLED_NATIVE_PLAN_HANDOFF_CORRECTION_ONLY", "BUILDER_STATUS")
    need(manifest.get("correctionProposalCommit") == "eb7da758cb9af322769b73e2c8e8bb0f20487587", "CORRECTION_PIN")
    for name, expected in manifest.get("files", {}).items():
        target = Path(root) / name
        need(not Path(name).is_absolute() and ".." not in Path(name).parts, "BUILDER_SOURCE_PATH")
        need(target.is_file() and not target.is_symlink(), "BUILDER_SOURCE_PATH")
        need(launch.sha256(target.read_bytes()) == expected, "BUILDER_SOURCE_DRIFT")
    return manifest


class PrefetchedCLI:
    def __init__(self, delegate, account, project_raw):
        self.delegate = delegate
        self.account = account
        self.project_raw = project_raw
        self.seen = set()
        self.delegated = 0

    def __call__(self, arguments, deadline):
        key = tuple(arguments)
        account_key = ("config", "get-value", "account", "--quiet")
        project_key = ("projects", "describe", stage.PROJECT, "--format=json", "--quiet")
        token_key = ("auth", "print-access-token", "--quiet")
        need(key not in self.seen, "CLI_CACHE_REUSE")
        self.seen.add(key)
        if key == account_key:
            return self.account
        if key == project_key:
            return self.project_raw
        need(key == token_key and self.delegated == 0, "CLI_SCOPE")
        self.delegated += 1
        return self.delegate(arguments, deadline)

    def close(self):
        return self.delegate.close()


def run_bound(repository, governance_commit, document, document_sha, manifest_sha,
              private_directory, result_directory, clock=time.time, cli=None, http=None):
    reader = launch.git_reader(repository)
    raw = reader(governance_commit, document)
    need(launch.sha256(raw) == document_sha, "OPERATION_DOCUMENT_HASH")
    binding = parse_document(raw, manifest_sha)
    first_now = clock()
    start = stage.timestamp(binding["window"]["start"])
    cutoff = stage.timestamp(binding["window"]["cutoff"])
    work_end = stage.timestamp(binding["window"]["workEnd"])
    need(start <= first_now < cutoff, "WINDOW")
    native_cli = cli or launch.NativeCLI(clock=clock)
    native_http = http or launch.NativeHTTP(clock=clock)
    built = False
    try:
        account_arguments = ["config", "get-value", "account", "--quiet"]
        project_arguments = ["projects", "describe", stage.PROJECT, "--format=json", "--quiet"]
        account = native_cli(account_arguments, work_end)
        need(account == stage.OWNER, "OWNER_MISMATCH")
        project_raw = native_cli(project_arguments, work_end)
        try:
            project = json.loads(project_raw)
        except ValueError:
            raise Stop("PROJECT_OUTPUT")
        need(isinstance(project, dict) and project.get("projectId") == stage.PROJECT, "PROJECT_MISMATCH")
        project_number = str(project.get("projectNumber", ""))
        fingerprint = launch.canonical_project_fingerprint(project_number)
        prefetched = PrefetchedCLI(native_cli, account, project_raw)
        build(repository, governance_commit, document, document_sha, manifest_sha,
              project_number, fingerprint, private_directory, clock, reader=reader)
        built = True
        plan = launch.private_json(Path(private_directory) / "plan.json")
        return launch.execute(plan, result_directory, manifest_sha, prefetched, native_http, reader, clock=clock)
    finally:
        if built and Path(private_directory).exists():
            purge(private_directory)
        native_cli.close()


def build(repository, governance_commit, document, document_sha, manifest_sha, project_number,
          project_fingerprint, output_directory, now, reader=None, reserve=stage.reserve):
    need(re.fullmatch(r"[0-9a-f]{40}", governance_commit or "") is not None, "GOVERNANCE_COMMIT")
    need(launch.OPERATION_DOCUMENT.fullmatch(document or "") is not None, "OPERATION_DOCUMENT")
    reader = reader or launch.git_reader(repository)
    raw = reader(governance_commit, document)
    need(launch.sha256(raw) == document_sha, "OPERATION_DOCUMENT_HASH")
    binding = parse_document(raw, manifest_sha)
    plan = construct_plan(binding, project_number, project_fingerprint, governance_commit, document, document_sha)
    first_now = now() if callable(now) else now
    output = Path(output_directory)
    created = False
    try:
        os.mkdir(output, 0o700)
        created = True
        need(not output.is_symlink() and stat.S_IMODE(output.stat().st_mode) == 0o700, "PRIVATE_DIRECTORY")
        reserve(output / "plan.json", plan)
        reread = launch.private_json(output / "plan.json")
        second_now = now() if callable(now) else now
        need(second_now >= first_now, "CLOCK_ROLLBACK")
        launch.validate_plan(reread, manifest_sha, second_now)
        launch.verify_approval_document(reread, reader)
        need(reread["operationId"] == binding["operationId"] and reread["decisionId"] == binding["decisionId"], "ID_BINDING")
        return {
            "status": "P08_PRIVATE_PLAN_READY_LOCAL",
            "operationIdSha256": launch.sha256(reread["operationId"]),
            "planSha256": launch.sha256((output / "plan.json").read_bytes()),
            "privatePlan": output / "plan.json",
        }
    except BaseException:
        if created and output.exists() and not output.is_symlink():
            for entry in list(output.iterdir()):
                if entry.name == "plan.json" and entry.is_file() and not entry.is_symlink():
                    entry.unlink()
            if not list(output.iterdir()):
                output.rmdir()
        raise


def native(arguments=None):
    arguments = list(sys.argv[1:] if arguments is None else arguments)
    try:
        check_builder_manifest()
        launch.check_source_manifest()
        need(len(arguments) == 6 and arguments[0] == "--run", "UNBOUND")
        governance_commit, document, document_sha, private_directory, result_directory = arguments[1:]
        governance = Path("/Users/debynyhanbanks/Web Projects/signmons-governance-r08-recovery")
        manifest_sha = launch.sha256((ROOT / "source-manifest.json").read_bytes())
        result = run_bound(governance, governance_commit, document, document_sha, manifest_sha,
                           private_directory, result_directory)
        print(result["status"])
        return 0 if result["status"] == "P08_STAGE_A_DIAGNOSTICS_COMPLETE" else 2
    except BaseException:
        print("P08_PLAN_BUILDER_REFUSED_UNBOUND")
        return 2


if __name__ == "__main__":
    raise SystemExit(native())
