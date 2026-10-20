#!/usr/bin/env python3
"""One-use, read-only PostgreSQL auth diagnostic for APP-013/P06-R11."""

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
from pathlib import Path

PLAN_ID = "1f681cc1-bf0a-4ace-a4b6-f4dc806a46ec"
OPERATION_ID = "c61dba09-5f4c-4bc4-932c-dfc2575b57cd"
ROOT = Path("/private/tmp/r11-db-auth-diagnostic-20261005-0825")
START = dt.datetime.fromisoformat("2026-10-05T12:25:00+00:00")
START_BEFORE = dt.datetime.fromisoformat("2026-10-05T12:35:00+00:00")
END = dt.datetime.fromisoformat("2026-10-05T12:50:00+00:00")
DIRECT = "ep-nameless-frog-ayk5gr5y.us-east-2.aws.neon.tech"
POOLED = "ep-nameless-frog-ayk5gr5y-pooler.us-east-2.aws.neon.tech"


def now(): return dt.datetime.now(dt.timezone.utc)
def iso(value): return value.isoformat().replace("+00:00", "Z")
def source_sha(): return hashlib.sha256(Path(__file__).read_bytes()).hexdigest()


def write_once(name, value):
    fd = os.open(ROOT / name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as output:
        json.dump(value, output, sort_keys=True, separators=(",", ":")); output.write("\n")


def validate():
    if not ROOT.is_dir() or ROOT.is_symlink() or ROOT.stat().st_uid != os.getuid() or stat.S_IMODE(ROOT.stat().st_mode) != 0o700:
        raise ValueError("PRIVATE_ROOT")
    approval = json.loads((ROOT / "owner-approval.json").read_text())
    expected = {"action":"DIAGNOSE_PRODUCTION_DATABASE_AUTH_READ_ONLY","automaticRetry":False,"decision":"APPROVED","endsAt":iso(END),"operationId":OPERATION_ID,"owner":"Debynyhan Banks","planId":PLAN_ID,"privateRoot":str(ROOT),"sourceSha256":source_sha(),"startBefore":iso(START_BEFORE),"startsAt":iso(START)}
    if approval != expected or not (START <= now() < START_BEFORE and now() < END): raise ValueError("APPROVAL_OR_WINDOW")


def read_private():
    if not os.isatty(0): raise ValueError("PRIVATE_TERMINAL_REQUIRED")
    secret = bytearray(); previous = termios.tcgetattr(0); hidden = termios.tcgetattr(0)
    hidden[3] &= ~(termios.ECHO | termios.ECHONL | termios.ICANON | termios.ISIG)
    try:
        termios.tcsetattr(0, termios.TCSAFLUSH, hidden)
        os.write(1, b"Paste saved PRODUCTION neondb_owner password (input hidden): ")
        deadline = __import__("time").monotonic() + 120
        while True:
            remaining = deadline - __import__("time").monotonic()
            if remaining <= 0 or not select.select([0], [], [], remaining)[0]: raise TimeoutError()
            value = os.read(0, 1)
            if not value or value in (b"\x03", b"\x04"): raise KeyboardInterrupt()
            if value in (b"\n", b"\r"): break
            if value in (b"\x7f", b"\x08"):
                if secret: secret.pop()
            elif 32 <= value[0] <= 126 and len(secret) < 512: secret.extend(value)
            else: raise ValueError("PRIVATE_INPUT_FORMAT")
        if not secret: raise ValueError("PRIVATE_INPUT_EMPTY")
        os.write(1, b"\n"); return secret
    finally: termios.tcsetattr(0, termios.TCSAFLUSH, previous)


def classify(returncode, stdout, stderr):
    text = stderr.decode("utf-8", "replace").lower()
    if returncode == 0 and stdout.strip() == b"1": return "ACCEPTED"
    if "password authentication failed" in text: return "AUTH_REFUSED"
    if "could not translate host name" in text: return "DNS_REFUSED"
    if "timeout" in text or "timed out" in text: return "TIMEOUT"
    if "ssl" in text or "certificate" in text: return "TLS_REFUSED"
    if "connection refused" in text or "server closed" in text: return "CONNECTION_REFUSED"
    return "OTHER_REFUSED"


def probe(host, pgpass):
    psql = shutil.which("psql") or "/opt/homebrew/opt/postgresql@16/bin/psql"
    env = {"PATH":os.environ.get("PATH", ""),"PGPASSFILE":str(pgpass),"PGSSLMODE":"require","PGCONNECT_TIMEOUT":"20"}
    result = subprocess.run([psql,"-X","-h",host,"-p","5432","-U","neondb_owner","-d","neondb","-At","-v","ON_ERROR_STOP=1","-c","SELECT 1;"],env=env,stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=35,check=False)
    return classify(result.returncode, result.stdout, result.stderr)


def run():
    validate()
    if any(ROOT.glob("diagnostic-*.json")): raise ValueError("CONSUMED")
    write_once("diagnostic-attempt.json", {"operationId":OPERATION_ID,"reservedAt":iso(now()),"status":"RESERVED_DO_NOT_RETRY"})
    password = bytearray(); pgpass = ROOT / "pgpass"
    try:
        password = read_private(); escaped = bytes(password).replace(b"\\", b"\\\\").replace(b":", b"\\:")
        fd = os.open(pgpass, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        with os.fdopen(fd, "wb") as output:
            for host in (DIRECT, POOLED): output.write(host.encode() + b":5432:neondb:neondb_owner:" + escaped + b"\n")
        payload = {"checkedAt":iso(now()),"direct":probe(DIRECT,pgpass),"operationId":OPERATION_ID,"pooled":probe(POOLED,pgpass),"status":"R11_DB_AUTH_DIAGNOSTIC_CAPTURED"}
        write_once("diagnostic-result.json", payload); return payload["status"]
    except Exception:
        write_once("diagnostic-stop.json", {"operationId":OPERATION_ID,"status":"STOPPED_DO_NOT_RETRY"}); raise
    finally:
        password[:] = b"\0" * len(password)
        try: pgpass.unlink()
        except FileNotFoundError: pass


if __name__ == "__main__":
    try:
        if sys.argv[1:] != ["--run"]: raise ValueError("EXACT_COMMAND_REQUIRED")
        print(run())
    except (Exception, KeyboardInterrupt):
        print("R11_DB_AUTH_DIAGNOSTIC_STOPPED. Do not rerun.", file=sys.stderr); raise SystemExit(1)
