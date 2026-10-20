#!/usr/bin/env python3
"""One-use, read-only Neon Connect-string diagnostic for APP-013/P06-R11."""

import datetime as dt
import hashlib
import json
import os
import select
import shutil
import stat
import subprocess
import sys
import termios
import urllib.parse
from pathlib import Path

PLAN_ID = "ffc2e0fc-12f2-4936-b8ee-d0617d5675c2"
OPERATION_ID = "35d42af5-b938-4783-a053-80a1a0706de2"
ROOT = Path("/private/tmp/r11-connect-string-diagnostic-20261007-1915")
START = dt.datetime.fromisoformat("2026-10-07T23:15:00+00:00")
START_BEFORE = dt.datetime.fromisoformat("2026-10-07T23:25:00+00:00")
END = dt.datetime.fromisoformat("2026-10-07T23:40:00+00:00")
DIRECT = b"ep-nameless-frog-ayk5gr5y.c-5.us-east-2.aws.neon.tech"
POOLED = b"ep-nameless-frog-ayk5gr5y-pooler.c-5.us-east-2.aws.neon.tech"


class TargetError(ValueError):
    """Fixed-category target mismatch with no private value."""


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
    expected = {"action":"DIAGNOSE_PRODUCTION_CONNECT_STRING_READ_ONLY","automaticRetry":False,"decision":"APPROVED","endsAt":iso(END),"operationId":OPERATION_ID,"owner":"Debynyhan Banks","planId":PLAN_ID,"privateRoot":str(ROOT),"sourceSha256":source_sha(),"startBefore":iso(START_BEFORE),"startsAt":iso(START)}
    current = now()
    if approval != expected or not (START <= current < START_BEFORE and current < END):
        raise ValueError("APPROVAL_OR_WINDOW")


def read_private_url():
    if not os.isatty(0): raise ValueError("PRIVATE_TERMINAL_REQUIRED")
    value = bytearray(); previous = termios.tcgetattr(0); hidden = termios.tcgetattr(0)
    hidden[3] &= ~(termios.ECHO | termios.ECHONL | termios.ICANON | termios.ISIG)
    try:
        termios.tcsetattr(0, termios.TCSAFLUSH, hidden)
        os.write(1, b"Now copy the full postgresql:// URL from Neon Connection string, return here, and paste it (not password or PSQL command; input hidden): ")
        deadline = __import__("time").monotonic() + 240
        while True:
            remaining = deadline - __import__("time").monotonic()
            if remaining <= 0 or not select.select([0], [], [], remaining)[0]: raise TimeoutError()
            char = os.read(0, 1)
            if not char or char in (b"\x03", b"\x04"): raise KeyboardInterrupt()
            if char in (b"\n", b"\r"): break
            if char in (b"\x7f", b"\x08"):
                if value: value.pop()
            elif 32 <= char[0] <= 126 and len(value) < 4096: value.extend(char)
            else: raise ValueError("PRIVATE_INPUT_FORMAT")
        if not value: raise ValueError("PRIVATE_INPUT_EMPTY")
        os.write(1, b"\n"); return value
    finally:
        termios.tcsetattr(0, termios.TCSAFLUSH, previous)


def parse_target(raw):
    try:
        parts = urllib.parse.urlsplit(bytes(raw))
        if parts.scheme not in (b"postgres", b"postgresql"): raise TargetError("SCHEME")
        if parts.fragment: raise TargetError("FRAGMENT")
        if urllib.parse.unquote_to_bytes(parts.username or b"") != b"neondb_owner": raise TargetError("ROLE")
        host = (parts.hostname or b"").lower()
        if host == DIRECT: host_class = "DIRECT"
        elif host == POOLED: host_class = "POOLED"
        else: raise TargetError("HOST")
        if parts.port not in (None, 5432): raise TargetError("PORT")
        if urllib.parse.unquote_to_bytes(parts.path) != b"/neondb": raise TargetError("DATABASE")
        query = urllib.parse.parse_qs(parts.query, keep_blank_values=True, strict_parsing=True)
        if query.get(b"sslmode") != [b"require"]: raise TargetError("TLS")
        if set(query) - {b"sslmode", b"channel_binding"}: raise TargetError("QUERY")
        if b"channel_binding" in query and query[b"channel_binding"] != [b"require"]: raise TargetError("CHANNEL_BINDING")
        password = bytearray(urllib.parse.unquote_to_bytes(parts.password or b""))
        if not password or len(password) > 512 or any(value in password for value in (0, 10, 13)): raise TargetError("PASSWORD")
        return host_class, password
    except TargetError:
        raise
    except (UnicodeError, ValueError) as error:
        raise TargetError("MALFORMED") from error


def classify(returncode, stdout, stderr):
    text = stderr.decode("utf-8", "replace").lower()
    if returncode == 0 and stdout.strip() == b"1": return "ACCEPTED"
    if "password authentication failed" in text: return "AUTH_REFUSED"
    if "could not translate host name" in text: return "DNS_REFUSED"
    if "timeout" in text or "timed out" in text: return "TIMEOUT"
    if "ssl" in text or "certificate" in text or "channel binding" in text: return "TLS_REFUSED"
    if "connection refused" in text or "server closed" in text: return "CONNECTION_REFUSED"
    return "OTHER_REFUSED"


def probe(host, pgpass):
    psql = shutil.which("psql") or "/opt/homebrew/opt/postgresql@16/bin/psql"
    env = {"PATH":os.environ.get("PATH", ""),"PGPASSFILE":str(pgpass),"PGSSLMODE":"require","PGCHANNELBINDING":"require","PGCONNECT_TIMEOUT":"20"}
    result = subprocess.run([psql,"-X","-h",host.decode("ascii"),"-p","5432","-U","neondb_owner","-d","neondb","-At","-v","ON_ERROR_STOP=1","-c","SELECT 1;"],env=env,stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=35,check=False)
    return classify(result.returncode, result.stdout, result.stderr)


def run():
    validate()
    if any(ROOT.glob("diagnostic-*.json")): raise ValueError("CONSUMED")
    write_once("diagnostic-attempt.json", {"operationId":OPERATION_ID,"reservedAt":iso(now()),"status":"RESERVED_DO_NOT_RETRY"})
    raw = bytearray(); password = bytearray(); pgpass = ROOT / "pgpass"
    try:
        raw = read_private_url()
        try:
            host_class, password = parse_target(raw)
        except TargetError:
            payload = {"checkedAt":iso(now()),"direct":"NOT_RUN","inputHostClass":"UNCONFIRMED","operationId":OPERATION_ID,"pooled":"NOT_RUN","status":"R11_CONNECT_STRING_TARGET_MISMATCH","target":"MISMATCH"}
            write_once("diagnostic-result.json", payload); return payload["status"]
        escaped = bytes(password).replace(b"\\", b"\\\\").replace(b":", b"\\:")
        fd = os.open(pgpass, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        with os.fdopen(fd, "wb") as output:
            for host in (DIRECT, POOLED): output.write(host + b":5432:neondb:neondb_owner:" + escaped + b"\n")
        payload = {"checkedAt":iso(now()),"direct":probe(DIRECT,pgpass),"inputHostClass":host_class,"operationId":OPERATION_ID,"pooled":probe(POOLED,pgpass),"status":"R11_CONNECT_STRING_DIAGNOSTIC_CAPTURED","target":"MATCH"}
        write_once("diagnostic-result.json", payload); return payload["status"]
    except Exception:
        write_once("diagnostic-stop.json", {"operationId":OPERATION_ID,"status":"STOPPED_DO_NOT_RETRY"}); raise
    finally:
        raw[:] = b"\0" * len(raw); password[:] = b"\0" * len(password)
        try: pgpass.unlink()
        except FileNotFoundError: pass


if __name__ == "__main__":
    try:
        if sys.argv[1:] != ["--run"]: raise ValueError("EXACT_COMMAND_REQUIRED")
        print(run())
    except (Exception, KeyboardInterrupt):
        print("R11_CONNECT_STRING_DIAGNOSTIC_STOPPED. Do not rerun.", file=sys.stderr); raise SystemExit(1)
