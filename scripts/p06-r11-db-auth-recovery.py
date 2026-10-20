#!/usr/bin/env python3
"""Guarded one-use coordinator for APP-013/P06-R11 database-auth recovery."""

import datetime as dt
import hashlib
import json
import os
import select
import shutil
import signal
import stat
import subprocess
import sys
import termios
import urllib.parse
import urllib.request
from pathlib import Path

PLAN_ID = "ffcaf1f0-6c0d-4ac8-9358-52bdae15f000"
OPERATION_ID = "3db3aa7d-974f-466e-a536-b5330be53afa"
ROOT = Path("/private/tmp/r11-db-auth-recovery-20261007-1945")
START = dt.datetime.fromisoformat("2026-10-07T23:45:00+00:00")
START_BEFORE = dt.datetime.fromisoformat("2026-10-08T00:15:00+00:00")
END = dt.datetime.fromisoformat("2026-10-08T01:15:00+00:00")
PROJECT = "signmons"
REGION = "us-east5"
SERVICE = "signmons-calldesk-staging"
BASELINE = "signmons-calldesk-staging-app013bounds"
REPLACEMENT = "signmons-calldesk-staging-app013dbrot2"
CANDIDATE_TAG = "app013-db-recovery"
FAILED_REPLACEMENT = "signmons-calldesk-staging-app013dbrot1"
FAILED_CANDIDATE_TAG = "app013-db-rotation"
JOB = "signmons-calldesk-migrate"
SECRET = "signmons-staging-database-url"
CHILD_SECRET = "signmons-staging-p06-child-database-url"
PRODUCTION_HOST = "ep-nameless-frog-ayk5gr5y.c-5.us-east-2.aws.neon.tech"
POOLED_HOST = "ep-nameless-frog-ayk5gr5y-pooler.c-5.us-east-2.aws.neon.tech"
ROLE = "neondb_owner"
DATABASE = "neondb"
CREDENTIAL_VERIFIED_AT = "2026-10-07T23:20:06.069806+00:00"
BASELINE_IMAGE = "us-east5-docker.pkg.dev/signmons/signmons/signmons-calldesk-backend@sha256:37286933d882466b8592120f48eb69c34e14cdb5a23c1f37480e39a1e6ff933a"
PRESERVE_TAG = "p06-intake-disabled"


def now_utc():
    return dt.datetime.now(dt.timezone.utc)


def iso(value):
    return value.isoformat().replace("+00:00", "Z")


def source_sha():
    return hashlib.sha256(Path(__file__).read_bytes()).hexdigest()


def load_json(path):
    value = json.loads(Path(path).read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise ValueError("JSON_OBJECT_REQUIRED")
    return value


def write_once(name, value):
    fd = os.open(ROOT / name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        with os.fdopen(fd, "w", encoding="utf-8", closefd=False) as output:
            json.dump(value, output, sort_keys=True, separators=(",", ":"))
            output.write("\n")
            output.flush()
            os.fsync(fd)
    finally:
        os.close(fd)


def validate_root():
    if not ROOT.is_dir() or ROOT.is_symlink():
        raise ValueError("PRIVATE_ROOT")
    info = ROOT.stat()
    if info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) != 0o700:
        raise ValueError("PRIVATE_ROOT_MODE")


def validate_approval(require_window=False, require_start=False):
    validate_root()
    approval = load_json(ROOT / "owner-approval.json")
    expected = {
        "action": "CUTOVER_VERIFIED_PRODUCTION_DATABASE_CREDENTIAL",
        "automaticRetry": False,
        "decision": "APPROVED_ALTERNATIVE_1",
        "endsAt": iso(END),
        "operationId": OPERATION_ID,
        "owner": "Debynyhan Banks",
        "planId": PLAN_ID,
        "privateRoot": str(ROOT),
        "sourceSha256": source_sha(),
        "startBefore": iso(START_BEFORE),
        "startsAt": iso(START),
    }
    if approval != expected:
        raise ValueError("APPROVAL_BINDING")
    if require_window:
        current = now_utc()
        if not (START <= current < END):
            raise ValueError("WINDOW")
        if require_start and not current < START_BEFORE:
            raise ValueError("START_DEADLINE")


def run_command(command, *, stdin=None, timeout=60):
    result = subprocess.run(command, input=stdin, stdout=subprocess.PIPE,
                            stderr=subprocess.DEVNULL, timeout=timeout, check=False)
    if result.returncode != 0:
        raise ValueError("COMMAND_REFUSED")
    return result.stdout


def gcloud_json(*args):
    return json.loads(run_command(["gcloud", *args, "--format=json"], timeout=90))


def service_state():
    return gcloud_json("run", "services", "describe", SERVICE, "--region", REGION, "--project", PROJECT)


def revision_state(name):
    return gcloud_json("run", "revisions", "describe", name, "--region", REGION, "--project", PROJECT)


def job_state():
    return gcloud_json("run", "jobs", "describe", JOB, "--region", REGION, "--project", PROJECT)


def secret_versions(name):
    return gcloud_json("secrets", "versions", "list", name, "--project", PROJECT)


def traffic_map(service):
    rows = service.get("spec", {}).get("traffic", [])
    return {row.get("tag", "NORMAL"): (row.get("revisionName"), row.get("percent", 0)) for row in rows}


def secret_ref(container, env_name):
    rows = [row for row in container.get("env", []) if row.get("name") == env_name]
    if len(rows) != 1:
        raise ValueError("SECRET_REFERENCE")
    return rows[0]["valueFrom"]["secretKeyRef"]


def validate_preflight(service, baseline, job, shared, child):
    traffic = traffic_map(service)
    if traffic.get("NORMAL") != (BASELINE, 100) and traffic.get("app013-bounds") != (BASELINE, 100):
        raise ValueError("NORMAL_TRAFFIC")
    if traffic.get("app013-bounds", (None,))[0] != BASELINE or traffic.get(PRESERVE_TAG, (None,))[0] != "signmons-calldesk-staging-app013p06disabled":
        raise ValueError("PRESERVED_TAG")
    if traffic.get(FAILED_CANDIDATE_TAG, (None,))[0] != FAILED_REPLACEMENT:
        raise ValueError("FAILED_CANDIDATE")
    if "p06-intake-enabled" in traffic:
        raise ValueError("ENABLED_TAG")
    container = baseline["spec"]["containers"][0]
    if baseline["status"]["imageDigest"] != BASELINE_IMAGE or container["image"] != BASELINE_IMAGE:
        raise ValueError("BASELINE_IMAGE")
    if secret_ref(container, "DATABASE_URL") != {"key": "latest", "name": SECRET}:
        raise ValueError("BASELINE_SECRET")
    job_container = job["spec"]["template"]["spec"]["template"]["spec"]["containers"][0]
    if secret_ref(job_container, "DATABASE_URL") != {"key": "latest", "name": SECRET}:
        raise ValueError("JOB_SECRET")
    states = {row["name"].rsplit("/", 1)[-1]: row["state"] for row in shared}
    child_states = {row["name"].rsplit("/", 1)[-1]: row["state"] for row in child}
    if states != {"1": "DISABLED", "2": "ENABLED", "3": "ENABLED"} or child_states.get("2") != "ENABLED":
        raise ValueError("SECRET_VERSIONS")


def preflight():
    validate_approval(True, True)
    if (ROOT / "preflight.json").exists():
        raise ValueError("CONSUMED")
    service, baseline, job, shared, child = service_state(), revision_state(BASELINE), job_state(), secret_versions(SECRET), secret_versions(CHILD_SECRET)
    validate_preflight(service, baseline, job, shared, child)
    snapshots = ROOT / "snapshots"
    snapshots.mkdir(mode=0o700)
    for name, value in (("service.json", service), ("baseline.json", baseline), ("job.json", job)):
        path = snapshots / name
        path.write_text(json.dumps(value, sort_keys=True, separators=(",", ":")) + "\n", encoding="utf-8")
        path.chmod(0o600)
    write_once("preflight.json", {"checkedAt": iso(now_utc()), "operationId": OPERATION_ID, "status": "PREFLIGHT_PASSED_NO_MUTATION"})
    return "R11_DB_AUTH_RECOVERY_PREFLIGHT_PASSED"


def stage(name, prerequisite, action):
    validate_approval(True)
    if prerequisite and not (ROOT / prerequisite).is_file():
        raise ValueError("PREREQUISITE")
    attempt = f"{name}-attempt.json"
    result = f"{name}-result.json"
    stop = f"{name}-stop.json"
    if any((ROOT / item).exists() for item in (attempt, result, stop)):
        raise ValueError("CONSUMED")
    write_once(attempt, {"operationId": OPERATION_ID, "reservedAt": iso(now_utc()), "stage": name, "status": "RESERVED_DO_NOT_RETRY"})
    try:
        payload = action()
        payload.update({"completedAt": iso(now_utc()), "operationId": OPERATION_ID, "stage": name})
        write_once(result, payload)
        return payload["status"]
    except Exception:
        write_once(stop, {"operationId": OPERATION_ID, "stage": name, "status": "STOPPED_UNCONFIRMED_DO_NOT_RETRY"})
        raise ValueError("CONSUMED_STOP")


def read_private(prompt):
    if not os.isatty(0):
        raise ValueError("PRIVATE_TERMINAL_REQUIRED")
    secret = bytearray()
    previous = termios.tcgetattr(0)
    hidden = termios.tcgetattr(0)
    hidden[3] &= ~(termios.ECHO | termios.ECHONL | termios.ICANON | termios.ISIG)
    handlers = {}
    def cancel(_number, _frame):
        raise KeyboardInterrupt()
    try:
        for number in (signal.SIGTERM, signal.SIGHUP):
            handlers[number] = signal.signal(number, cancel)
        termios.tcsetattr(0, termios.TCSAFLUSH, hidden)
        os.write(1, (prompt + " (input hidden): ").encode("utf-8"))
        deadline = __import__("time").monotonic() + 240
        while True:
            remaining = deadline - __import__("time").monotonic()
            if remaining <= 0 or not select.select([0], [], [], remaining)[0]:
                raise TimeoutError("PRIVATE_INPUT_TIMEOUT")
            value = os.read(0, 1)
            if not value or value in (b"\x03", b"\x04"):
                raise KeyboardInterrupt()
            if value in (b"\n", b"\r"):
                break
            if value in (b"\x7f", b"\x08"):
                if secret:
                    secret.pop()
                continue
            if not 32 <= value[0] <= 126 or len(secret) >= 512:
                raise ValueError("PRIVATE_INPUT_FORMAT")
            secret.extend(value)
        if not secret:
            raise ValueError("PRIVATE_INPUT_EMPTY")
        os.write(1, b"\n")
        return secret
    except BaseException:
        secret[:] = b"\0" * len(secret)
        raise
    finally:
        termios.tcsetattr(0, termios.TCSAFLUSH, previous)
        for number, handler in handlers.items():
            signal.signal(number, handler)


def parse_connect_url(raw):
    try:
        parts = urllib.parse.urlsplit(bytes(raw))
        query = urllib.parse.parse_qs(parts.query, keep_blank_values=True, strict_parsing=True)
        if parts.scheme not in (b"postgres", b"postgresql") or parts.fragment:
            raise ValueError("CONNECT_URL_METADATA")
        if urllib.parse.unquote_to_bytes(parts.username or b"") != ROLE.encode():
            raise ValueError("CONNECT_URL_METADATA")
        if (parts.hostname or b"").decode("ascii").lower() != POOLED_HOST or parts.port not in (None, 5432):
            raise ValueError("CONNECT_URL_METADATA")
        if urllib.parse.unquote_to_bytes(parts.path) != b"/neondb":
            raise ValueError("CONNECT_URL_METADATA")
        if query.get(b"sslmode") != [b"require"] or set(query) - {b"sslmode", b"channel_binding"}:
            raise ValueError("CONNECT_URL_METADATA")
        if b"channel_binding" in query and query[b"channel_binding"] != [b"require"]:
            raise ValueError("CONNECT_URL_METADATA")
        password = bytearray(urllib.parse.unquote_to_bytes(parts.password or b""))
        if not password or len(password) > 512 or any(value in password for value in (0, 10, 13)):
            raise ValueError("CONNECT_URL_METADATA")
        return password
    except (UnicodeError, ValueError) as error:
        if str(error) == "CONNECT_URL_METADATA": raise
        raise ValueError("CONNECT_URL_METADATA") from error


def authenticate_password(password):
    psql = shutil.which("psql") or "/opt/homebrew/opt/postgresql@16/bin/psql"
    pgpass = ROOT / "pgpass-auth"
    escaped = bytes(password).replace(b"\\", b"\\\\").replace(b":", b"\\:")
    fd = os.open(pgpass, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        with os.fdopen(fd, "wb") as output:
            for host in (PRODUCTION_HOST, POOLED_HOST):
                output.write(f"{host}:5432:{DATABASE}:{ROLE}:".encode() + escaped + b"\n")
        env = {"PATH": os.environ.get("PATH", ""), "PGPASSFILE": str(pgpass), "PGSSLMODE": "require", "PGCHANNELBINDING": "require", "PGCONNECT_TIMEOUT": "20"}
        for host in (PRODUCTION_HOST, POOLED_HOST):
            result = subprocess.run([psql, "-X", "-h", host, "-p", "5432", "-U", ROLE, "-d", DATABASE, "-At", "-v", "ON_ERROR_STOP=1", "-c", "SELECT 1;"], env=env, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=45, check=False)
            if result.returncode != 0 or result.stdout.strip() != b"1": raise ValueError("PASSWORD_AUTH_REFUSED")
    finally:
        try: pgpass.unlink()
        except FileNotFoundError: pass


def verify_and_add_secret_action():
    url = password = bytearray()
    try:
        url = read_private("Now copy and paste the full current PRODUCTION Neon Connection string URL")
        password = parse_connect_url(url)
        authenticate_password(password)
        output = run_command(["gcloud", "secrets", "versions", "add", SECRET, "--project", PROJECT, "--data-file=-", "--format=value(name)"], stdin=url, timeout=90).decode("ascii", "strict").strip()
        version = output.rsplit("/", 1)[-1]
        if not version.isdigit() or int(version) <= 3:
            raise ValueError("NEW_VERSION")
        rows = secret_versions(SECRET)
        matches = [row for row in rows if row["name"].endswith("/" + version) and row["state"] == "ENABLED"]
        if len(matches) != 1:
            raise ValueError("VERSION_READBACK")
        return {"status": "PRODUCTION_PASSWORD_VERIFIED_AND_NEW_SHARED_VERSION_ADDED", "version": version}
    finally:
        for value in (password, url):
            value[:] = b"\0" * len(value)


def new_version():
    return load_json(ROOT / "verify-add-secret-result.json")["version"]


def replacement_document(current, baseline, version):
    doc = {
        "apiVersion": "serving.knative.dev/v1",
        "kind": "Service",
        "metadata": {
            "name": SERVICE,
            "namespace": current["metadata"]["namespace"],
            "annotations": {key: value for key, value in current["metadata"].get("annotations", {}).items() if key in {"run.googleapis.com/ingress", "run.googleapis.com/maxScale"}},
            "labels": current["metadata"].get("labels", {}),
        },
        "spec": {"template": {"metadata": {}, "spec": json.loads(json.dumps(baseline["spec"]))}, "traffic": [row for row in json.loads(json.dumps(current["spec"]["traffic"])) if row.get("tag") != FAILED_CANDIDATE_TAG]},
    }
    annotations = baseline["metadata"].get("annotations", {})
    doc["spec"]["template"]["metadata"] = {
        "name": REPLACEMENT,
        "annotations": {key: value for key, value in annotations.items() if key in {"autoscaling.knative.dev/maxScale", "run.googleapis.com/cpu-throttling", "run.googleapis.com/startup-cpu-boost"}},
        "labels": {"run.googleapis.com/startupProbeType": "Default"},
    }
    container = doc["spec"]["template"]["spec"]["containers"][0]
    secret_ref(container, "DATABASE_URL")["key"] = version
    doc["spec"]["traffic"].append({"revisionName": REPLACEMENT, "tag": CANDIDATE_TAG})
    return doc


def deploy_action():
    version = new_version()
    current = service_state()
    baseline = load_json(ROOT / "snapshots" / "baseline.json")
    if traffic_map(current).get(FAILED_CANDIDATE_TAG, (None,))[0] != FAILED_REPLACEMENT:
        raise ValueError("FAILED_CANDIDATE")
    document = replacement_document(current, baseline, version)
    path = ROOT / "replacement-service.json"
    path.write_text(json.dumps(document, sort_keys=True, separators=(",", ":")) + "\n", encoding="utf-8")
    path.chmod(0o600)
    run_command(["gcloud", "run", "services", "replace", str(path), "--region", REGION, "--project", PROJECT, "--quiet"], timeout=360)
    live = revision_state(REPLACEMENT)
    if live["status"]["imageDigest"] != BASELINE_IMAGE or live["status"]["conditions"][0]["status"] != "True":
        raise ValueError("REVISION_READY")
    if live["spec"] != document["spec"]["template"]["spec"]:
        raise ValueError("REVISION_DIFF")
    service = service_state()
    url_rows = [row for row in service["status"]["traffic"] if row.get("tag") == CANDIDATE_TAG and row.get("revisionName") == REPLACEMENT]
    if len(url_rows) != 1 or any(row.get("percent") for row in url_rows):
        raise ValueError("CANDIDATE_TRAFFIC")
    url = url_rows[0]["url"] + "/health/readiness"
    with urllib.request.urlopen(url, timeout=30) as response:
        if response.status != 200:
            raise ValueError("DATABASE_READINESS")
        response.read(4096)
    return {"status": "REPLACEMENT_READY_DATABASE_VERIFIED", "revision": REPLACEMENT, "secretVersion": version}


def update_job_action():
    version = new_version()
    before = job_state()
    count = before.get("status", {}).get("executionCount")
    run_command(["gcloud", "run", "jobs", "update", JOB, "--region", REGION, "--project", PROJECT, "--update-secrets", f"DATABASE_URL={SECRET}:{version}", "--quiet"], timeout=240)
    after = job_state()
    container = after["spec"]["template"]["spec"]["template"]["spec"]["containers"][0]
    if secret_ref(container, "DATABASE_URL") != {"key": version, "name": SECRET} or after.get("status", {}).get("executionCount") != count:
        raise ValueError("JOB_READBACK")
    before_container = before["spec"]["template"]["spec"]["template"]["spec"]["containers"][0]
    secret_ref(before_container, "DATABASE_URL")["key"] = version
    if before["spec"] != after["spec"]:
        raise ValueError("JOB_DIFF")
    return {"status": "MIGRATION_JOB_REFERENCE_UPDATED_NOT_EXECUTED", "secretVersion": version, "executionCount": count}


def cutover_action():
    run_command(["gcloud", "run", "services", "update-traffic", SERVICE, "--region", REGION, "--project", PROJECT, "--to-revisions", f"{REPLACEMENT}=100", "--remove-tags", CANDIDATE_TAG, "--update-tags", f"app013-bounds={REPLACEMENT}", "--quiet"], timeout=240)
    service = service_state()
    traffic = traffic_map(service)
    if traffic.get("app013-bounds") != (REPLACEMENT, 100) and traffic.get("NORMAL") != (REPLACEMENT, 100):
        raise ValueError("CUTOVER")
    if CANDIDATE_TAG in traffic or FAILED_CANDIDATE_TAG in traffic or traffic.get(PRESERVE_TAG, (None,))[0] != "signmons-calldesk-staging-app013p06disabled":
        raise ValueError("CUTOVER_TAGS")
    return {"status": "NORMAL_TRAFFIC_CUTOVER_VERIFIED", "revision": REPLACEMENT}


def sessions_action():
    reset_at = CREDENTIAL_VERIFIED_AT
    url = password = bytearray()
    pgpass = ROOT / "pgpass"
    try:
        url = read_private("Now copy and paste the full current PRODUCTION Neon Connection string URL again")
        password = parse_connect_url(url)
        escaped = bytes(password).replace(b"\\", b"\\\\").replace(b":", b"\\:")
        fd = os.open(pgpass, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        with os.fdopen(fd, "wb") as output:
            output.write(f"{PRODUCTION_HOST}:5432:{DATABASE}:{ROLE}:".encode() + escaped + b"\n")
        psql = shutil.which("psql") or "/opt/homebrew/opt/postgresql@18/bin/psql"
        query = "SELECT count(*) FROM pg_stat_activity WHERE usename='neondb_owner' AND pid<>pg_backend_pid() AND backend_start < '" + reset_at.replace("Z", "+00:00") + "'::timestamptz;"
        env = {"PATH": os.environ.get("PATH", ""), "PGPASSFILE": str(pgpass), "PGSSLMODE": "require"}
        deadline = __import__("time").monotonic() + 900
        while True:
            result = subprocess.run([psql, "-h", PRODUCTION_HOST, "-p", "5432", "-U", ROLE, "-d", DATABASE, "-At", "-v", "ON_ERROR_STOP=1", "-c", query], env=env, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=45, check=False)
            if result.returncode != 0:
                raise ValueError("SESSION_QUERY")
            count = int(result.stdout.decode("ascii").strip())
            if count == 0:
                return {"status": "NO_PRE_RESET_OWNER_SESSIONS", "count": count}
            if __import__("time").monotonic() >= deadline:
                raise ValueError("OLD_SESSIONS_REMAIN")
            __import__("time").sleep(15)
    finally:
        password[:] = b"\0" * len(password)
        url[:] = b"\0" * len(url)
        try:
            pgpass.unlink()
        except FileNotFoundError:
            pass


def disable_invalid_action():
    run_command(["gcloud", "secrets", "versions", "disable", "2", "--secret", SECRET, "--project", PROJECT, "--quiet"], timeout=90)
    run_command(["gcloud", "secrets", "versions", "disable", "3", "--secret", SECRET, "--project", PROJECT, "--quiet"], timeout=90)
    states = {row["name"].rsplit("/", 1)[-1]: row["state"] for row in secret_versions(SECRET)}
    if states.get("2") != "DISABLED" or states.get("3") != "DISABLED" or states.get(new_version()) != "ENABLED":
        raise ValueError("DISABLE_READBACK")
    return {"status": "INVALID_SHARED_VERSIONS_DISABLED_NOT_DESTROYED", "invalidVersions": ["2", "3"], "newVersion": new_version()}


def final_check():
    validate_approval(False)
    required = ["disable-invalid-result.json", "cutover-result.json", "update-job-result.json", "sessions-result.json"]
    if not all((ROOT / name).is_file() for name in required):
        raise ValueError("PREREQUISITE")
    service, job, shared, child = service_state(), job_state(), secret_versions(SECRET), secret_versions(CHILD_SECRET)
    traffic = traffic_map(service)
    job_container = job["spec"]["template"]["spec"]["template"]["spec"]["containers"][0]
    states = {row["name"].rsplit("/", 1)[-1]: row["state"] for row in shared}
    child_states = {row["name"].rsplit("/", 1)[-1]: row["state"] for row in child}
    checks = [
        traffic.get("app013-bounds", (None,))[0] == REPLACEMENT or traffic.get("NORMAL", (None,))[0] == REPLACEMENT,
        traffic.get(PRESERVE_TAG, (None,))[0] == "signmons-calldesk-staging-app013p06disabled",
        FAILED_CANDIDATE_TAG not in traffic,
        "p06-intake-enabled" not in traffic,
        secret_ref(job_container, "DATABASE_URL") == {"key": new_version(), "name": SECRET},
        states.get("2") == "DISABLED" and states.get("3") == "DISABLED" and states.get(new_version()) == "ENABLED",
        child_states.get("2") == "ENABLED",
    ]
    if not all(checks):
        raise ValueError("FINAL_READBACK")
    write_once("final-result.json", {"checkedAt": iso(now_utc()), "operationId": OPERATION_ID, "status": "R11_DB_AUTH_RECOVERY_VERIFIED"})
    return "R11_DB_AUTH_RECOVERY_VERIFIED"


def check():
    validate_approval(False)
    if any(ROOT.glob("*-attempt.json")) or any(ROOT.glob("*-result.json")) or any(ROOT.glob("*-stop.json")):
        raise ValueError("ACTION_MARKERS")
    return "R11_DB_AUTH_RECOVERY_CHECK_PASSED_NO_ACTION"


def main(argv):
    commands = {
        "--check": check,
        "--preflight": preflight,
        "--verify-add-secret": lambda: stage("verify-add-secret", "preflight.json", verify_and_add_secret_action),
        "--deploy": lambda: stage("deploy", "verify-add-secret-result.json", deploy_action),
        "--update-job": lambda: stage("update-job", "deploy-result.json", update_job_action),
        "--cutover": lambda: stage("cutover", "update-job-result.json", cutover_action),
        "--sessions": lambda: stage("sessions", "cutover-result.json", sessions_action),
        "--disable-invalid": lambda: stage("disable-invalid", "sessions-result.json", disable_invalid_action),
        "--final": final_check,
    }
    if len(argv) != 1 or argv[0] not in commands:
        raise ValueError("EXACT_STAGE_REQUIRED")
    return commands[argv[0]]()


if __name__ == "__main__":
    try:
        print(main(sys.argv[1:]))
    except (Exception, KeyboardInterrupt):
        print("R11_DB_AUTH_RECOVERY_STAGE_STOPPED_OR_REFUSED. Do not rerun a stage with an attempt/result/stop marker.", file=sys.stderr)
        raise SystemExit(1)
