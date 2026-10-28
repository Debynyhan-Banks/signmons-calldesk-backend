"""Disabled P08 Stage A diagnostic-service model.

This evidence-only controller has no credential resolver or native transport.
Stage B API-key actions are deliberately refused.
"""
from __future__ import annotations

import copy
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
SERVICE = "policytroubleshooter.googleapis.com"
SERVICE_HOST = "https://serviceusage.googleapis.com/v1/"
DIAGNOSTIC_URL = "https://policytroubleshooter.googleapis.com/v3/iam:troubleshoot"
PROJECT = "signmons"
OWNER = "debynyhan@signmons.com"
RUNTIME_IDENTITY = "signmons-calldesk-p07-runtime@signmons.iam.gserviceaccount.com"
STATES = {
    "CAN_ACCESS",
    "CANNOT_ACCESS",
    "UNKNOWN_INFO",
    "UNKNOWN_CONDITIONAL",
    "OVERALL_ACCESS_STATE_UNSPECIFIED",
}
TUPLES = (
    (RUNTIME_IDENTITY, "//cloudresourcemanager.googleapis.com/projects/signmons", "firebaseauth.users.get"),
    (OWNER, "//cloudresourcemanager.googleapis.com/projects/signmons", "firebaseauth.users.get"),
    (OWNER, "//cloudresourcemanager.googleapis.com/projects/signmons", "firebaseauth.users.update"),
    (OWNER, "//iam.googleapis.com/projects/signmons/serviceAccounts/" + RUNTIME_IDENTITY, "iam.serviceAccounts.signBlob"),
)


class Stop(Exception):
    pass


def need(value, code):
    if not value:
        raise Stop(code)


def digest(value):
    if not isinstance(value, bytes):
        value = json.dumps(value, sort_keys=True, separators=(",", ":")).encode()
    return hashlib.sha256(value).hexdigest()


def timestamp(value):
    need(isinstance(value, str) and re.fullmatch(r"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ", value), "UTC_FORMAT")
    return dt.datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()


def reserve(path, value):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        os.write(fd, json.dumps(value, sort_keys=True).encode())
    finally:
        os.close(fd)


def check_sources(root=ROOT):
    manifest_path = Path(root) / "source-manifest.json"
    need(manifest_path.is_file() and not manifest_path.is_symlink(), "SOURCE_MANIFEST")
    manifest = json.loads(manifest_path.read_text())
    need(manifest.get("status") == "DISABLED_LOCAL_PREPARATION_ONLY", "SOURCE_STATUS")
    for name, expected in manifest.get("files", {}).items():
        path = Path(root) / name
        need(not Path(name).is_absolute() and ".." not in Path(name).parts, "SOURCE_PATH")
        need(path.is_file() and not path.is_symlink(), "SOURCE_PATH")
        need(digest(path.read_bytes()) == expected, "SOURCE_DRIFT")
    return manifest


def approve_local_plan(plan, now, mode="run"):
    need(plan.get("mode") == "LOCAL_DIAGNOSTICS_STAGE_ONLY", "LOCAL_ONLY")
    need(plan.get("externalActionAuthorized") is False, "EXTERNAL_ACTION_REFUSED")
    need(str(uuid.UUID(plan.get("operationId", ""))) == plan["operationId"], "OPERATION_ID")
    need(re.fullmatch(r"[0-9]{6,20}", plan.get("projectNumber", "")) is not None, "PROJECT_NUMBER")
    need(plan.get("projectId") == PROJECT and plan.get("ownerPrincipal") == OWNER, "PROJECT_OR_OWNER")
    need(plan.get("service") == SERVICE and plan.get("serviceRetention") == "RETAIN_IF_ENABLED", "SERVICE_DECISION")
    need(plan.get("tuples") == [list(value) for value in TUPLES], "DIAGNOSTIC_SCOPE")
    need(plan.get("automaticRetryAllowed") is False and plan.get("stageBAllowed") is False, "RETRY_OR_STAGE_B")
    window = {name: timestamp(plan["window"][name]) for name in ("start", "cutoff", "workEnd", "cleanupEnd", "purgeEnd")}
    need(window["start"] < window["cutoff"] < window["workEnd"] < window["cleanupEnd"] < window["purgeEnd"], "WINDOW_ORDER")
    need(window["cleanupEnd"] - window["workEnd"] >= 30 and window["purgeEnd"] - window["start"] <= 3600, "WINDOW_SIZE")
    need(mode in ("run", "closeout"), "MODE")
    need(window["start"] <= now < window["cutoff" if mode == "run" else "cleanupEnd"], "START_CUTOFF")
    return window


class RequestAdapter:
    """Exact serialized descriptors with an injected fake transport only."""

    def __init__(self, plan, transport=None):
        self.plan = copy.deepcopy(plan)
        self.transport = transport
        self.service = f"projects/{plan['projectNumber']}/services/{SERVICE}"
        self.calls = 0

    def call(self, method, url, body=None):
        need(self.transport is not None, "NATIVE_TRANSPORT_UNBOUND")
        need(self.calls < 30, "REQUEST_LIMIT")
        allowed = url.startswith(SERVICE_HOST) or url == DIAGNOSTIC_URL
        need(allowed and "apikeys.googleapis.com" not in url, "HOST_SCOPE")
        self.calls += 1
        descriptor = {
            "method": method,
            "url": url,
            "body": None if body is None else json.dumps(body, sort_keys=True, separators=(",", ":")),
            "timeoutSeconds": 8,
            "redirect": "error",
        }
        response = self.transport(descriptor)
        need(isinstance(response, dict) and type(response.get("httpStatus")) is int, "HTTP_SHAPE")
        need(isinstance(response.get("body"), str) and len(response["body"].encode()) <= 65536, "HTTP_SHAPE")
        value = json.loads(response["body"])
        need(isinstance(value, dict), "OUTPUT_OBJECT")
        need(200 <= response["httpStatus"] < 300 and "error" not in value, "PROVIDER_REFUSED")
        return value

    def service_get(self):
        return self.call("GET", SERVICE_HOST + self.service)

    def service_enable(self):
        return self.call("POST", SERVICE_HOST + self.service + ":enable", {})

    def service_operation(self, name):
        need(re.fullmatch(r"operations/[A-Za-z0-9_.-]{1,200}", name) is not None, "SERVICE_OPERATION_SCOPE")
        return self.call("GET", SERVICE_HOST + name)

    def diagnostic(self, principal, resource, permission, receive_time):
        need((principal, resource, permission) in TUPLES, "DIAGNOSTIC_SCOPE")
        body = {
            "accessTuple": {
                "principal": principal,
                "fullResourceName": resource,
                "permission": permission,
                "conditionContext": {"request": {"receiveTime": receive_time}},
            }
        }
        return self.call("POST", DIAGNOSTIC_URL, body)

    def stage_b(self, *args, **kwargs):
        raise Stop("STAGE_B_REFUSED_UNQUALIFIED")


class Controller:
    def __init__(self, plan, adapter, directory, clock=time.time, pause=time.sleep, mode="run"):
        self.plan = copy.deepcopy(plan)
        self.adapter = adapter
        self.directory = Path(directory)
        self.clock = clock
        self.pause = pause
        self.mode = mode
        self.window = approve_local_plan(self.plan, clock(), mode)
        self.last = clock()
        self.abort = False
        self.directory.mkdir(mode=0o700, parents=True, exist_ok=True)
        need(not self.directory.is_symlink() and stat.S_IMODE(self.directory.stat().st_mode) == 0o700, "PRIVATE_DIRECTORY")
        self.journal = {
            "operationId": self.plan["operationId"],
            "planSha256": digest(self.plan),
            "service": "UNOBSERVED",
            "diagnostics": [],
            "stageB": "REFUSED_UNQUALIFIED",
        }

    def gate(self, closeout=False):
        now = self.clock()
        need(now >= self.last, "CLOCK_ROLLBACK")
        self.last = now
        need(now < self.window["cleanupEnd" if closeout else "workEnd"], "DEADLINE")
        need(closeout or not self.abort, "INTERRUPTED")

    def save(self):
        path = self.directory / "journal.json"
        temporary = self.directory / "journal-next.json"
        if temporary.exists():
            temporary.unlink()
        reserve(temporary, self.journal)
        os.replace(temporary, path)

    def invoke(self, function, *args, closeout=False):
        self.gate(closeout)
        started = time.monotonic()

        def timeout(_signal, _frame):
            raise Stop("REQUEST_TIMEOUT")

        old = signal.signal(signal.SIGALRM, timeout)
        signal.setitimer(signal.ITIMER_REAL, min(8, self.window["cleanupEnd" if closeout else "workEnd"] - self.clock()))
        try:
            value = function(*args)
            need(time.monotonic() - started < 8, "REQUEST_TIMEOUT")
            self.gate(closeout)
            return value
        finally:
            signal.setitimer(signal.ITIMER_REAL, 0)
            signal.signal(signal.SIGALRM, old)

    def wait(self, initial):
        need(isinstance(initial, dict) and isinstance(initial.get("name"), str), "OPERATION_SHAPE")
        name = initial["name"]
        need(re.fullmatch(r"operations/[A-Za-z0-9_.-]{1,200}", name) is not None, "SERVICE_OPERATION_SCOPE")
        self.journal["serviceOperation"] = name
        self.save()
        value = initial
        for index in range(6):
            need(isinstance(value, dict) and value.get("name") == name, "OPERATION_SHAPE")
            need(isinstance(value.get("done", False), bool) and "error" not in value, "OPERATION_SHAPE")
            if value.get("done"):
                need(isinstance(value.get("response"), dict), "OPERATION_RESPONSE")
                return value["response"]
            need(index < 5, "POLL_LIMIT")
            self.gate()
            need(self.window["workEnd"] - self.clock() > 10, "POLL_DEADLINE")
            self.pause(10)
            value = self.invoke(self.adapter.service_operation, name)
        raise Stop("POLL_LIMIT")

    def run(self):
        need(self.mode == "run", "RUN_MODE")
        reserve(self.directory / "attempt.json", {"operationId": self.plan["operationId"], "planSha256": digest(self.plan)})
        self.save()
        old = {}

        def interrupted(_signal, _frame):
            self.abort = True
            raise Stop("INTERRUPTED")

        for number in (signal.SIGINT, signal.SIGTERM):
            old[number] = signal.signal(number, interrupted)
        failure = None
        try:
            state = self.invoke(self.adapter.service_get)
            need(state.get("name") == self.adapter.service and state.get("state") in ("ENABLED", "DISABLED"), "SERVICE_SHAPE")
            if state["state"] == "DISABLED":
                self.journal["service"] = "ENABLE_OUTCOME_UNKNOWN"
                self.save()
                response = self.wait(self.invoke(self.adapter.service_enable))
                need(set(response) <= {"@type", "service"}, "UNEXPECTED_ENABLE_RESPONSE")
                service = response.get("service")
                need(isinstance(service, dict) and service.get("name") == self.adapter.service and service.get("state") == "ENABLED", "UNEXPECTED_ENABLE_RESPONSE")
                state = self.invoke(self.adapter.service_get)
                need(state.get("name") == self.adapter.service and state.get("state") == "ENABLED", "ENABLE_READBACK")
                self.journal["service"] = "SERVICE_ENABLED_RETAINED"
            else:
                self.journal["service"] = "PREEXISTING_ENABLED"
            self.save()
            for principal, resource, permission in TUPLES:
                receive_time = dt.datetime.fromtimestamp(self.clock(), dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
                response = self.invoke(self.adapter.diagnostic, principal, resource, permission, receive_time)
                state = response.get("overallAccessState")
                need(state in STATES, "DIAGNOSTIC_SHAPE")
                self.journal["diagnostics"].append({"permission": permission, "overallAccessState": state})
                self.save()
        except BaseException as error:
            failure = str(error) if isinstance(error, Stop) and re.fullmatch(r"[A-Z_]+", str(error)) else "REFUSED_OR_UNKNOWN"
        finally:
            for number, handler in old.items():
                signal.signal(number, handler)
        diagnostics_ready = len(self.journal["diagnostics"]) == 4 and all(
            value["overallAccessState"] == "CAN_ACCESS" for value in self.journal["diagnostics"]
        )
        residuals = []
        if self.journal["service"] == "ENABLE_OUTCOME_UNKNOWN":
            residuals.append("SERVICE_ENABLE_OUTCOME_UNKNOWN")
        result = {
            "status": "LOCAL_DIAGNOSTICS_STAGE_COMPLETE" if failure is None and not residuals else "LOCAL_DIAGNOSTICS_STAGE_STOPPED",
            "failure": failure,
            "serviceState": self.journal["service"],
            "diagnostics": self.journal["diagnostics"],
            "fourDiagnosticsCanAccess": diagnostics_ready,
            "stageBCandidate": diagnostics_ready,
            "stageBActionAuthorized": False,
            "stageBState": "REFUSED_UNQUALIFIED",
            "providerEnableSideEffects": "UNKNOWN",
            "realExternalActions": 0,
            "processCloseout": "NO_NATIVE_CLIENTS_OR_CHILDREN",
            "residuals": residuals,
        }
        reserve(self.directory / "result.json", result)
        return result

    def closeout_only(self):
        need(self.mode == "closeout", "CLOSEOUT_MODE")
        reserve(self.directory / "closeout-attempt.json", {"operationId": self.plan["operationId"]})
        path = self.directory / "journal.json"
        need(path.is_file() and not path.is_symlink() and stat.S_IMODE(path.stat().st_mode) == 0o600, "JOURNAL_PRIVATE")
        journal = json.loads(path.read_text())
        need(journal.get("operationId") == self.plan["operationId"] and journal.get("planSha256") == digest(self.plan), "JOURNAL_SCOPE")
        state = self.invoke(self.adapter.service_get, closeout=True)
        need(state.get("name") == self.adapter.service and state.get("state") in ("ENABLED", "DISABLED"), "SERVICE_SHAPE")
        return {
            "serviceState": state["state"],
            "serviceMutationAttempted": False,
            "stageBActionAuthorized": False,
            "processCloseout": "NO_NATIVE_CLIENTS_OR_CHILDREN",
        }


def native():
    check_sources()
    print("P08_DIAGNOSTICS_STAGE_REFUSED_UNBOUND")
    return 2


if __name__ == "__main__":
    raise SystemExit(native())
