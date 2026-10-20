#!/usr/bin/env python3
"""One-use direct/pooled mapping of a shared secret host to a Neon inventory."""

import datetime as dt
import hashlib
import json
import os
import re
import stat
import subprocess
import sys
from pathlib import Path
from urllib.parse import unquote, urlsplit

PLAN_ID = "78800c38-11fd-4b5b-89a7-865e4a9f7b2c"
OPERATION_ID = "e13000fe-7d13-4e9c-9e39-a164873c98ce"
PRIVATE_ROOT = Path("/Volumes/Signmons-P06/r11-pooled-host-map-20261003-0700")
START = dt.datetime.fromisoformat("2026-10-03T11:00:00+00:00")
START_BEFORE = dt.datetime.fromisoformat("2026-10-03T11:20:00+00:00")
END = dt.datetime.fromisoformat("2026-10-03T11:30:00+00:00")
PROJECT = "signmons"
SECRET = "signmons-staging-database-url"
VERSION = "2"
EXPECTED_ROLE = "neondb_owner"
EXPECTED_DATABASE = "neondb"
EXPECTED_NEON_PROJECT_ID = "soft-smoke-54063480"
EXPECTED_INVENTORY_SHA256 = "0d926e6e6123133125f1cb6ca66f48d507ee41a10e0c699b0f9a22bda85983c4"
APPROVAL_KEYS = {
    "action",
    "automaticRetry",
    "decision",
    "endsAt",
    "expectedDatabase",
    "expectedRole",
    "inventorySha256",
    "neonProjectId",
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
INVENTORY_KEYS = {"capturedAt", "complete", "endpoints", "projectId"}
ENDPOINT_KEYS = {"branchId", "endpointId", "endpointType", "host", "state"}
TOKEN = re.compile(r"^[A-Za-z0-9_-]{2,128}$")
HOST = re.compile(
    r"^(?=.{1,253}\Z)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+"
    r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$"
)


def utc_now():
    return dt.datetime.now(dt.timezone.utc)


def canonical(value):
    return value.isoformat().replace("+00:00", "Z")


def parse_utc(value):
    if not isinstance(value, str) or not value.endswith("Z"):
        raise ValueError("TIME_SCHEMA")
    parsed = dt.datetime.fromisoformat(value[:-1] + "+00:00")
    if parsed.tzinfo != dt.timezone.utc or canonical(parsed) != value:
        raise ValueError("TIME_SCHEMA")
    return parsed


def source_sha256():
    return hashlib.sha256(Path(__file__).read_bytes()).hexdigest()


def file_sha256(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def exact_object(path, keys, schema_error, maximum):
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode) or path.is_symlink():
        raise ValueError(schema_error)
    if info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) != 0o600:
        raise ValueError(schema_error)
    if not 1 <= info.st_size <= maximum:
        raise ValueError(schema_error)
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict) or set(value) != keys:
        raise ValueError(schema_error)
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
    approval = exact_object(
        root / "owner-approval.json", APPROVAL_KEYS, "APPROVAL_SCHEMA", 8192
    )
    expected = {
        "action": "READ_SHARED_SECRET_DIRECT_POOLED_MAPPING",
        "automaticRetry": False,
        "decision": "APPROVED",
        "endsAt": canonical(END),
        "expectedDatabase": EXPECTED_DATABASE,
        "expectedRole": EXPECTED_ROLE,
        "inventorySha256": EXPECTED_INVENTORY_SHA256,
        "neonProjectId": EXPECTED_NEON_PROJECT_ID,
        "operationId": OPERATION_ID,
        "owner": "Debynyhan Banks",
        "planId": PLAN_ID,
        "privateRoot": str(PRIVATE_ROOT),
        "project": PROJECT,
        "secret": SECRET,
        "sourceSha256": source_sha256(),
        "startBefore": canonical(START_BEFORE),
        "startsAt": canonical(START),
        "version": VERSION,
    }
    if approval != expected:
        raise ValueError("APPROVAL_BINDING")
    if require_window and not (START <= now < START_BEFORE and now < END):
        raise ValueError("WINDOW")
    return approval


def normalize_host(value):
    if not isinstance(value, str):
        raise ValueError("INVENTORY_SCHEMA")
    normalized = value.rstrip(".").lower()
    if value != value.strip() or not HOST.fullmatch(normalized):
        raise ValueError("INVENTORY_SCHEMA")
    if not normalized.endswith(".neon.tech"):
        raise ValueError("INVENTORY_SCHEMA")
    return normalized


def load_inventory(root, now=None, require_fresh=False):
    path = root / "neon-endpoints.json"
    if file_sha256(path) != EXPECTED_INVENTORY_SHA256:
        raise ValueError("INVENTORY_HASH")
    value = exact_object(path, INVENTORY_KEYS, "INVENTORY_SCHEMA", 65536)
    if value["projectId"] != EXPECTED_NEON_PROJECT_ID or value["complete"] is not True:
        raise ValueError("INVENTORY_BINDING")
    captured = parse_utc(value["capturedAt"])
    if require_fresh:
        if now is None or captured > now or now - captured > dt.timedelta(minutes=30):
            raise ValueError("INVENTORY_STALE")
    rows = value["endpoints"]
    if not isinstance(rows, list) or not 1 <= len(rows) <= 100:
        raise ValueError("INVENTORY_SCHEMA")
    endpoint_ids = set()
    normalized = []
    for row in rows:
        if not isinstance(row, dict) or set(row) != ENDPOINT_KEYS:
            raise ValueError("INVENTORY_SCHEMA")
        for key in ("branchId", "endpointId", "endpointType", "state"):
            if not isinstance(row[key], str) or not TOKEN.fullmatch(row[key]):
                raise ValueError("INVENTORY_SCHEMA")
        if row["endpointId"] in endpoint_ids:
            raise ValueError("INVENTORY_SCHEMA")
        endpoint_ids.add(row["endpointId"])
        normalized.append(
            {
                "branchId": row["branchId"],
                "endpointId": row["endpointId"],
                "endpointType": row["endpointType"],
                "host": normalize_host(row["host"]),
                "state": row["state"],
            }
        )
        if normalized[-1]["host"].split(".", 1)[0] != row["endpointId"]:
            raise ValueError("INVENTORY_BINDING")
    return {"capturedAt": value["capturedAt"], "endpoints": normalized}


def map_payload(payload, inventory):
    if not isinstance(payload, bytearray) or not 1 <= len(payload) <= 8192:
        raise ValueError("PAYLOAD_SIZE")
    if any(value in payload for value in (0, 10, 13)):
        raise ValueError("PAYLOAD_FORMAT")
    try:
        value = payload.decode("utf-8", "strict")
        parsed = urlsplit(value)
        role = unquote(parsed.username or "")
        password = unquote(parsed.password or "")
        database = unquote(parsed.path.removeprefix("/"))
        if (
            parsed.scheme not in {"postgres", "postgresql"}
            or role != EXPECTED_ROLE
            or not password
            or parsed.port not in {None, 5432}
            or database != EXPECTED_DATABASE
            or not parsed.hostname
        ):
            raise ValueError("IDENTITY_MISMATCH")
        host = normalize_host(parsed.hostname)
        matches = []
        for row in inventory["endpoints"]:
            direct = normalize_host(row["host"])
            prefix, suffix = direct.split(".", 1)
            candidates = ((direct, "DIRECT"), (f"{prefix}-pooler.{suffix}", "POOLED"))
            matches.extend((row, mode) for candidate, mode in candidates if candidate == host)
        if len(matches) == 0:
            return {"status": "NO_MATCH"}
        if len(matches) > 1:
            return {"status": "AMBIGUOUS", "matchCount": len(matches)}
        match, mode = matches[0]
        return {
            "status": "MATCHED_UNIQUE",
            "branchId": match["branchId"],
            "endpointId": match["endpointId"],
            "endpointType": match["endpointType"],
            "endpointState": match["state"],
            "connectionMode": mode,
        }
    except ValueError as error:
        if str(error) == "IDENTITY_MISMATCH":
            raise
        raise ValueError("PAYLOAD_PARSE") from error
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
    inventory = load_inventory(root, now, True)
    for name in ("mapping-attempt.json", "mapping-result.json", "mapping-stop.json"):
        if (root / name).exists():
            raise ValueError("CONSUMED")
    exclusive_json(
        root,
        "mapping-attempt.json",
        {
            "operationId": OPERATION_ID,
            "planId": PLAN_ID,
            "reservedAt": canonical(now),
            "status": "RESERVED_DO_NOT_RETRY",
        },
    )
    payload = bytearray()
    try:
        payload = accessor()
        result = map_payload(payload, inventory)
        result.update(
            {
                "checkedAt": canonical(utc_now()),
                "inventoryCapturedAt": inventory["capturedAt"],
                "inventoryEndpointCount": len(inventory["endpoints"]),
                "operationId": OPERATION_ID,
                "planId": PLAN_ID,
                "secretVersion": f"projects/{PROJECT}/secrets/{SECRET}/versions/{VERSION}",
            }
        )
        exclusive_json(root, "mapping-result.json", result)
        return result["status"]
    except Exception as error:
        reason = str(error) if str(error) in {
            "ACCESS_REFUSED",
            "ACCESS_UNCERTAIN",
            "IDENTITY_MISMATCH",
            "PAYLOAD_SIZE",
            "PAYLOAD_FORMAT",
            "PAYLOAD_PARSE",
        } else "UNEXPECTED"
        exclusive_json(
            root,
            "mapping-stop.json",
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
    load_inventory(root)
    for name in ("mapping-attempt.json", "mapping-result.json", "mapping-stop.json"):
        if (root / name).exists():
            raise ValueError("CONSUMED")
    return "R11_POOLED_HOST_MAP_CHECK_PASSED_NO_ACTION"


def main():
    try:
        if len(sys.argv) != 3 or sys.argv[1] not in {"--check", "--run"}:
            raise ValueError("USAGE")
        root = Path(sys.argv[2])
        if sys.argv[1] == "--check":
            print(check(root))
        else:
            status = run(root)
            print("R11_POOLED_HOST_MAP_" + status)
    except Exception:
        print("R11_POOLED_HOST_MAP_REFUSED_OR_CONSUMED", file=sys.stderr)
        raise SystemExit(1)


if __name__ == "__main__":
    main()
