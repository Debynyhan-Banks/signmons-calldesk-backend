#!/usr/bin/env python3
"""One-use, sanitized identity check for the shared staging database URL."""

import datetime as dt
import hashlib
import json
import os
import stat
import subprocess
import sys
from pathlib import Path
from urllib.parse import unquote, urlsplit

PLAN_ID = "bda2718d-9f8d-4701-9913-c9c95609eae4"
OPERATION_ID = "0580681c-e4c7-4ac1-a08d-b5f2756bfb80"
PRIVATE_ROOT = Path("/Volumes/Signmons-P06/r11-credential-rotation-20261002-2130")
START = dt.datetime.fromisoformat("2026-10-03T01:30:00+00:00")
START_BEFORE = dt.datetime.fromisoformat("2026-10-03T01:50:00+00:00")
END = dt.datetime.fromisoformat("2026-10-03T03:00:00+00:00")
PROJECT = "signmons"
SECRET = "signmons-staging-database-url"
VERSION = "2"
EXPECTED_HOST = "ep-nameless-frog-ayk5gr5y.us-east-2.aws.neon.tech"
EXPECTED_ROLE = "neondb_owner"
EXPECTED_DATABASE = "neondb"
APPROVAL_KEYS = {
    "action",
    "automaticRetry",
    "decision",
    "endsAt",
    "expectedDatabase",
    "expectedHost",
    "expectedRole",
    "operationId",
    "owner",
    "planId",
    "privateRoot",
    "project",
    "secret",
    "sourceSha256",
    "startBefore",
    "startsAt",
    "version",
}


def utc_now():
    return dt.datetime.now(dt.timezone.utc)


def source_sha256():
    return hashlib.sha256(Path(__file__).read_bytes()).hexdigest()


def exact_json(path):
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict) or set(value) != APPROVAL_KEYS:
        raise ValueError("APPROVAL_SCHEMA")
    return value


def validate_root(root):
    root = Path(root)
    if root != PRIVATE_ROOT or not root.is_dir() or root.is_symlink():
        raise ValueError("PRIVATE_ROOT")
    info = root.stat()
    if info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) != 0o700:
        raise ValueError("PRIVATE_ROOT_MODE")
    return root


def validate_approval(root, now, require_window):
    approval = exact_json(root / "owner-approval.json")
    expected = {
        "action": "READ_SHARED_SECRET_IDENTITY",
        "automaticRetry": False,
        "decision": "APPROVED",
        "endsAt": END.isoformat().replace("+00:00", "Z"),
        "expectedDatabase": EXPECTED_DATABASE,
        "expectedHost": EXPECTED_HOST,
        "expectedRole": EXPECTED_ROLE,
        "operationId": OPERATION_ID,
        "owner": "Debynyhan Banks",
        "planId": PLAN_ID,
        "privateRoot": str(PRIVATE_ROOT),
        "project": PROJECT,
        "secret": SECRET,
        "sourceSha256": source_sha256(),
        "startBefore": START_BEFORE.isoformat().replace("+00:00", "Z"),
        "startsAt": START.isoformat().replace("+00:00", "Z"),
        "version": VERSION,
    }
    if approval != expected:
        raise ValueError("APPROVAL_BINDING")
    if require_window and not (START <= now < START_BEFORE and now < END):
        raise ValueError("WINDOW")
    return approval


def classify(payload):
    if not isinstance(payload, bytearray) or not 1 <= len(payload) <= 8192:
        raise ValueError("PAYLOAD_SIZE")
    if any(value in payload for value in (0, 10, 13)):
        raise ValueError("PAYLOAD_FORMAT")
    try:
        value = payload.decode("utf-8", "strict")
        parsed = urlsplit(value)
        if not parsed.scheme or not parsed.netloc or not parsed.hostname:
            raise ValueError("PAYLOAD_PARSE")
        role = unquote(parsed.username or "")
        password = unquote(parsed.password or "")
        database = unquote(parsed.path.removeprefix("/"))
        matched = (
            parsed.scheme in {"postgres", "postgresql"}
            and role == EXPECTED_ROLE
            and bool(password)
            and parsed.hostname == EXPECTED_HOST
            and (parsed.port in {None, 5432})
            and database == EXPECTED_DATABASE
        )
        return {
            "status": "MATCHED" if matched else "MISMATCH",
            "schemeValid": parsed.scheme in {"postgres", "postgresql"},
            "roleMatched": role == EXPECTED_ROLE,
            "passwordPresent": bool(password),
            "hostMatched": parsed.hostname == EXPECTED_HOST,
            "portMatched": parsed.port in {None, 5432},
            "databaseMatched": database == EXPECTED_DATABASE,
        }
    except Exception as error:
        raise ValueError("PAYLOAD_PARSE") from error
    finally:
        value = ""


def access_secret():
    command = [
        "gcloud",
        "secrets",
        "versions",
        "access",
        VERSION,
        f"--secret={SECRET}",
        f"--project={PROJECT}",
    ]
    try:
        result = subprocess.run(
            command,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            timeout=20,
            check=False,
        )
    except Exception as error:
        raise ValueError("ACCESS_UNCERTAIN") from error
    payload = bytearray(result.stdout)
    if result.returncode != 0:
        payload[:] = b"\0" * len(payload)
        raise ValueError("ACCESS_REFUSED")
    return payload


def exclusive_json(root, name, value):
    path = root / name
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        with os.fdopen(fd, "w", encoding="utf-8", closefd=False) as output:
            json.dump(value, output, sort_keys=True, separators=(",", ":"))
            output.write("\n")
            output.flush()
            os.fsync(fd)
    finally:
        os.close(fd)


def run(root, now=None, accessor=access_secret):
    now = now or utc_now()
    root = validate_root(root)
    validate_approval(root, now, True)
    for name in ("identity-attempt.json", "identity-result.json", "identity-stop.json"):
        if (root / name).exists():
            raise ValueError("CONSUMED")
    exclusive_json(
        root,
        "identity-attempt.json",
        {
            "operationId": OPERATION_ID,
            "planId": PLAN_ID,
            "reservedAt": now.isoformat().replace("+00:00", "Z"),
            "status": "RESERVED_DO_NOT_RETRY",
        },
    )
    payload = bytearray()
    try:
        payload = accessor()
        result = classify(payload)
        result.update(
            {
                "checkedAt": utc_now().isoformat().replace("+00:00", "Z"),
                "operationId": OPERATION_ID,
                "planId": PLAN_ID,
                "secretVersion": f"projects/{PROJECT}/secrets/{SECRET}/versions/{VERSION}",
            }
        )
        exclusive_json(root, "identity-result.json", result)
        return result["status"]
    except Exception as error:
        reason = str(error) if str(error) in {
            "ACCESS_REFUSED",
            "ACCESS_UNCERTAIN",
            "PAYLOAD_SIZE",
            "PAYLOAD_FORMAT",
            "PAYLOAD_PARSE",
        } else "UNEXPECTED"
        exclusive_json(
            root,
            "identity-stop.json",
            {
                "operationId": OPERATION_ID,
                "planId": PLAN_ID,
                "reason": reason,
                "status": "CONSUMED_STOP",
            },
        )
        raise ValueError("CONSUMED_STOP") from None
    finally:
        payload[:] = b"\0" * len(payload)


def check(root):
    root = validate_root(root)
    validate_approval(root, utc_now(), False)
    for name in ("identity-attempt.json", "identity-result.json", "identity-stop.json"):
        if (root / name).exists():
            raise ValueError("CONSUMED")
    return "R11_CREDENTIAL_IDENTITY_CHECK_PASSED_NO_ACTION"


def main():
    try:
        if len(sys.argv) != 3 or sys.argv[1] not in {"--check", "--run"}:
            raise ValueError("USAGE")
        root = Path(sys.argv[2])
        if sys.argv[1] == "--check":
            print(check(root))
        else:
            status = run(root)
            print("R11_SHARED_SECRET_IDENTITY_" + status)
    except Exception:
        print("R11_SHARED_SECRET_IDENTITY_REFUSED_OR_CONSUMED", file=sys.stderr)
        raise SystemExit(1)


if __name__ == "__main__":
    main()
