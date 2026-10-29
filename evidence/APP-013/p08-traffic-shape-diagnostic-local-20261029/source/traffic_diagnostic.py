"""Disabled, approval-bound P08 Cloud Run traffic-shape diagnostic.

Importing this module performs no provider action. The native entry refuses until a
separately approved exact operation supplies a private plan and binding.
"""
from __future__ import annotations

import datetime as dt
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
from pathlib import Path

ROOT = Path(__file__).resolve().parent
LOCKED = ROOT.parents[1] / "p08-composed-qualification-local-20261029" / "source"
sys.path.insert(0, str(LOCKED))
import composed_qualification as model  # noqa: E402
import qualification_launch as launch  # noqa: E402

LOCKED_LAUNCH_SHA256 = "068f4e7a2f055c3b27a7079b2d7c7cb1ced704f95475d5a675d9c62bfa4b2f30"
LOCKED_MODEL_SHA256 = "19181d987eddec481a105ecc1dbe89413a42fe2b07436c073934aef6aafde685"
LOCAL_PROPOSAL_SHA256 = "3d0623bf588c3f3dbaea4b63b4bda298c1b8991b3991dc96823dd5d35d024031"
MAX_OUTPUT = launch.MAX_OUTPUT
OLD_TAG = "app013-p07-atomic"
FACTS = ("normal100ExactlyOne", "candidatePresent", "candidateZeroExactlyOne", "oldTagAbsent")


class Stop(Exception):
    pass


def need(condition, code):
    if not condition:
        raise Stop(code)


def digest(value):
    data = value if isinstance(value, bytes) else json.dumps(value, sort_keys=True, separators=(",", ":")).encode()
    return hashlib.sha256(data).hexdigest()


def verify_sources():
    need(digest((LOCKED / "qualification_launch.py").read_bytes()) == LOCKED_LAUNCH_SHA256, "SOURCE_DRIFT")
    need(digest((LOCKED / "composed_qualification.py").read_bytes()) == LOCKED_MODEL_SHA256, "SOURCE_DRIFT")
    model.verify_local_manifest()
    model.verify_locked_sources()


def descriptors():
    existing = {item["id"]: item for item in launch.cli_contract()}
    service = existing["service"]
    argv = list(service["argv"])
    argv[-1] = "--format=json(metadata.name,status.traffic)"
    result = (existing["owner"], existing["config"], {"id": "service", "argv": tuple(argv)})
    need(len(result) == 3 and all(x["argv"][0] == launch.GCLOUD for x in result), "COMMAND_CONTRACT")
    return result


def read_json(raw, code):
    need(isinstance(raw, (bytes, str, dict, list)), code)
    if isinstance(raw, (bytes, str)):
        data = raw.encode() if isinstance(raw, str) else raw
        need(0 < len(data) <= MAX_OUTPUT, code)
        try:
            return json.loads(data)
        except (UnicodeError, json.JSONDecodeError):
            raise Stop(code) from None
    need(len(json.dumps(raw).encode()) <= MAX_OUTPUT, code)
    return raw


def classify(owner_raw, config_raw, service_raw):
    owner = read_json(owner_raw, "OWNER_OUTPUT")
    config = read_json(config_raw, "CONFIG_OUTPUT")
    service = read_json(service_raw, "SERVICE_OUTPUT")
    need(owner == [{"account": model.OWNER, "status": "ACTIVE"}], "OWNER_DRIFT")
    try:
        launch.config_output_shape(config)
    except model.Stop:
        raise Stop("CONFIG_DRIFT") from None
    need(isinstance(service, dict) and service.get("metadata") == {"name": launch.SERVICE}, "SERVICE_DRIFT")
    status = service.get("status")
    need(isinstance(status, dict) and isinstance(status.get("traffic"), list), "TRAFFIC_OUTPUT")
    traffic = status["traffic"]
    need(0 < len(traffic) <= 20, "TRAFFIC_BOUNDS")
    seen = set()
    for item in traffic:
        need(isinstance(item, dict), "TRAFFIC_OUTPUT")
        name = item.get("revisionName")
        need(isinstance(name, str) and 0 < len(name) <= 128, "TRAFFIC_OUTPUT")
        need(name not in seen, "TRAFFIC_DUPLICATE")
        seen.add(name)
        percent = item.get("percent", 0)
        need(type(percent) is int and 0 <= percent <= 100, "TRAFFIC_OUTPUT")
        if "tag" in item:
            need(isinstance(item["tag"], str) and len(item["tag"]) <= 128, "TRAFFIC_OUTPUT")
        need(not (name != launch.REVISION and name != expected_normal() and percent > 0), "TRAFFIC_UNEXPECTED_POSITIVE")
    normal = [x for x in traffic if x["revisionName"] == expected_normal()]
    candidate = [x for x in traffic if x["revisionName"] == launch.REVISION]
    facts = {
        "normal100ExactlyOne": len(normal) == 1 and normal[0].get("percent") == 100,
        "candidatePresent": len(candidate) == 1,
        "candidateZeroExactlyOne": len(candidate) == 1 and candidate[0].get("percent", 0) == 0,
        "oldTagAbsent": not any(x.get("tag") == OLD_TAG for x in traffic),
    }
    return {"facts": facts, "falseFacts": sorted(k for k, v in facts.items() if not v), "entryCount": len(traffic)}


def expected_normal():
    # The revision is supplied by a separately reviewed exact binding, not inferred
    # from latestReadyRevisionName or an arbitrary service response.
    return "signmons-calldesk-staging-app013dbrot2"


def _timestamp(value):
    need(isinstance(value, str) and re.fullmatch(r"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ", value), "WINDOW_FORMAT")
    return dt.datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()


def validate(plan, binding, now):
    need(plan.get("mode") == "P08_TRAFFIC_SHAPE_DIAGNOSTIC_ONLY" and plan.get("externalReadAuthorized") is False, "PLAN_MODE")
    need(plan.get("project") == model.PROJECT and plan.get("service") == launch.SERVICE and plan.get("region") == launch.REGION, "RESOURCE_SCOPE")
    need(plan.get("normalRevision") == expected_normal() and plan.get("candidateRevision") == launch.REVISION and plan.get("oldTag") == OLD_TAG, "TRAFFIC_SCOPE")
    need(plan.get("proposalSha256") == LOCAL_PROPOSAL_SHA256 and plan.get("sourceSha256") == digest(Path(__file__).read_bytes()), "SOURCE_BINDING")
    need(plan.get("allowanceUsd") == 0 and plan.get("automaticRetryAllowed") is False and plan.get("cliLimit") == 3, "LIMITS")
    operation = plan.get("operationId")
    try:
        need(isinstance(operation, str) and str(uuid.UUID(operation)) == operation, "OPERATION_ID")
    except (ValueError, TypeError, AttributeError):
        raise Stop("OPERATION_ID") from None
    times = {k: _timestamp(plan.get("window", {}).get(k)) for k in ("start", "cutoff", "readEnd", "closeoutEnd")}
    need(times["start"] < times["cutoff"] < times["readEnd"] < times["closeoutEnd"] and times["closeoutEnd"] - times["start"] <= 900, "WINDOW_BOUNDS")
    need(times["start"] <= now < times["cutoff"], "START_CUTOFF")
    need(binding.get("mode") == "P08_TRAFFIC_SHAPE_EXACT_LAUNCH" and binding.get("externalReadAuthorized") is True and binding.get("mutationsAuthorized") is False, "AUTHORITY")
    need(binding.get("planSha256") == digest(plan) and binding.get("sourceSha256") == plan["sourceSha256"], "BINDING")
    need(binding.get("operationId") == operation and binding.get("cliLimit") == 3 and binding.get("allowanceUsd") == 0 and binding.get("automaticRetryAllowed") is False, "BINDING")
    need(re.fullmatch(r"[a-f0-9]{64}", binding.get("operationProposalSha256", "")), "OPERATION_PROPOSAL")
    approval = binding.get("ownerApproval")
    need(approval == {"decision": "APPROVE_EXACT_P08_TRAFFIC_SHAPE_READ", "owner": "Debynyhan Banks", "operationId": operation, "operationProposalSha256": binding["operationProposalSha256"], "bindingSha256": digest({k: v for k, v in binding.items() if k != "ownerApproval"})}, "OWNER_APPROVAL")
    return times


def reserve(path, value):
    fd = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    with os.fdopen(fd, "w") as file:
        json.dump(value, file, sort_keys=True, separators=(",", ":"))
        file.write("\n")


def purge(directory):
    absent = {}
    for name in ("plan.json", "binding.json"):
        path = directory / name
        info = path.lstat()
        need(stat.S_ISREG(info.st_mode) and stat.S_IMODE(info.st_mode) == 0o600 and not path.is_symlink(), "PRIVATE_PURGE_INPUT")
        path.unlink()
        absent[name] = not path.exists() and not path.is_symlink()
    reserve(directory / "private-input-retirement.json", {"privateInputsAbsent": all(absent.values()), "absence": absent})
    return all(absent.values())


class NativeTransport:
    def __init__(self, clock):
        need(not any(os.environ.get(k) for k in launch.CREDENTIAL_OVERRIDE_KEYS), "CREDENTIAL_OVERRIDE")
        self.clock = clock
        self.child = None

    def cli(self, descriptor, deadline):
        need(self.clock() < deadline and descriptor in descriptors(), "CLI_SCOPE")
        env = {k: v for k, v in os.environ.items() if k not in launch.CREDENTIAL_OVERRIDE_KEYS}
        try:
            self.child = subprocess.Popen(descriptor["argv"], stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, env=env, start_new_session=True)
            raw, _ = self.child.communicate(timeout=max(0.1, min(15, deadline - self.clock())))
            need(self.child.returncode == 0, "CLI_NONZERO_EXIT")
            need(len(raw) <= MAX_OUTPUT, "CLI_OUTPUT_TOO_LARGE")
            return raw
        except subprocess.TimeoutExpired:
            raise Stop("CLI_TIMEOUT") from None
        except OSError:
            raise Stop("CLI_LAUNCH_ERROR") from None
        finally:
            need(self.close(), "CHILD_CONTAINMENT")

    def close(self):
        child = self.child
        contained = True
        if child is not None and child.poll() is None:
            try:
                os.killpg(child.pid, signal.SIGKILL)
                child.wait(timeout=2)
            except (ProcessLookupError, subprocess.TimeoutExpired):
                contained = child.poll() is not None
        self.child = None
        return contained


def run(plan, binding, directory, transport, clock=time.time):
    times = validate(plan, binding, clock())
    reserve(directory / "attempt.json", {"operationId": plan["operationId"], "planSha256": digest(plan)})
    failure = None
    observation = None
    calls = 0
    contained = False
    try:
        raws = []
        for descriptor in descriptors():
            need(clock() < times["readEnd"], "READ_DEADLINE")
            calls += 1
            raws.append(transport.cli(descriptor, times["readEnd"]))
        observation = classify(*raws)
    except (Stop, KeyboardInterrupt, OSError) as error:
        failure = error.args[0] if isinstance(error, Stop) else "INTERRUPTED" if isinstance(error, KeyboardInterrupt) else "CLI_LAUNCH_ERROR"
    finally:
        try:
            contained = transport.close() is True
        except (OSError, Stop):
            contained = False
    if not contained:
        failure = "CHILD_CONTAINMENT_UNCONFIRMED"
    status = "CONTAINMENT_UNCONFIRMED" if not contained else "P08_TRAFFIC_SHAPE_DIAGNOSIS_COMPLETE" if failure is None else "P08_TRAFFIC_SHAPE_DIAGNOSIS_STOPPED"
    journal = {"operationId": plan["operationId"], "status": status, "failure": failure, "cliReads": calls, "facts": None if observation is None else observation["facts"], "falseFacts": [] if observation is None else observation["falseFacts"], "entryCount": None if observation is None else observation["entryCount"], "residuals": [] if contained else ["CHILD_PROCESS_UNKNOWN"]}
    reserve(directory / "journal.json", journal)
    return status


def private_json(path):
    info = path.lstat()
    need(stat.S_ISREG(info.st_mode) and stat.S_IMODE(info.st_mode) == 0o600 and not path.is_symlink(), "PRIVATE_INPUT")
    data = path.read_bytes()
    need(0 < len(data) <= 65536, "PRIVATE_INPUT")
    value = read_json(data, "PRIVATE_INPUT")
    need(isinstance(value, dict), "PRIVATE_INPUT")
    return value


def native(argv=None):
    argv = sys.argv[1:] if argv is None else argv
    if len(argv) != 4 or argv[0] != "--diagnose":
        print("P08_TRAFFIC_SHAPE_LAUNCH_REFUSED_UNBOUND")
        return 2
    directory = Path(argv[3])
    need(directory.is_dir() and not directory.is_symlink() and stat.S_IMODE(directory.stat().st_mode) == 0o700, "PRIVATE_DIRECTORY")
    need(Path(argv[1]).resolve() == (directory / "plan.json").resolve() and Path(argv[2]).resolve() == (directory / "binding.json").resolve(), "PRIVATE_SCOPE")
    old_term = signal.getsignal(signal.SIGTERM)
    def interrupted(_signum, _frame):
        raise Stop("INTERRUPTED")
    signal.signal(signal.SIGTERM, interrupted)
    status = "P08_TRAFFIC_SHAPE_DIAGNOSIS_STOPPED"
    try:
        verify_sources()
        plan = private_json(directory / "plan.json")
        binding = private_json(directory / "binding.json")
        validate(plan, binding, time.time())
        status = run(plan, binding, directory, NativeTransport(time.time), time.time)
    except (Stop, KeyboardInterrupt, OSError):
        status = "P08_TRAFFIC_SHAPE_DIAGNOSIS_STOPPED"
    finally:
        signal.signal(signal.SIGTERM, old_term)
        try:
            purged = purge(directory)
        except (OSError, Stop):
            purged = False
    if not purged:
        print("CONTAINMENT_UNCONFIRMED")
        return 2
    print(status)
    return 0 if status == "P08_TRAFFIC_SHAPE_DIAGNOSIS_COMPLETE" else 2


if __name__ == "__main__":
    raise SystemExit(native())
