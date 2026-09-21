"""One-command attended coordinator for one separately approved P06/R11 packet.

This module contains no database, Cloud Run, provider, or browser implementation.
It validates a private packet and invokes its reviewed controller modes at most
once each. Live use still requires a future packet and exact owner approval.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import select
import signal
import stat
import subprocess
import sys
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable, Protocol

sys.dont_write_bytecode = True

REPO = Path(__file__).resolve().parents[1]
PRIVATE_PARENT = Path("/Volumes/Signmons-P06")
NODE = Path("/Users/debynyhanbanks/.nvm/versions/node/v24.12.0/bin/node")
TARGET_ORIGIN = (
    "https://p06-intake-enabled---signmons-calldesk-staging-p572d6wipq-ul.a.run.app"
)
FLOW_UPPER_BOUND_MICROS = 500_000
ACCOUNT_CEILING_MICROS = 3_000_000
RETAINED_LIABILITY_MICROS = 2_500_000
RETAINED_HOLD_COUNT = 5
ADDRESS_COST_MICROS = 100_000
ADDRESS_ACCOUNT_MICROS = 400_000
ADDRESS_ACCOUNT_REQUESTS = 4
ADDRESS_TENANT_MICROS = 400_000
ADDRESS_TENANT_REQUESTS = 4
ADDRESS_SESSION_MICROS = 200_000
ADDRESS_SESSION_REQUESTS = 2
RUN_RESERVE_SECONDS = 4 * 60
CLOSEOUT_RESERVE_SECONDS = 30

ACTION_MARKERS = frozenset(
    {
        "coordinator-attempt.json",
        "login-attempt.json",
        "login-result.json",
        "activation-reservation.json",
        "activation-stage.json",
        "activation-result.json",
        "activation-readback.json",
        "deployment-reservation.json",
        "deployment-readback.json",
        "r10-run-result.json",
        "revocation-reservation.json",
        "revocation-result.json",
        "revocation-readback.json",
        "closeout-attempt.json",
        "closeout-result.json",
    }
)


class CoordinatorStop(Exception):
    """Sanitized fail-closed result; private causes are never user output."""

    def __init__(self, stage: str):
        super().__init__("R11 attended coordinator stopped")
        self.stage = stage


@dataclass(frozen=True)
class Review:
    root: Path
    plan_id: str
    origin: str
    database_login_start: float
    database_login_end: float
    runtime_start: float
    runtime_end: float
    closeout_end: float


@dataclass(frozen=True)
class CoordinationResult:
    reason: str
    live_started: bool
    closeout_verified: bool
    active_url: str | None
    failed_stage: str | None


class Ports(Protocol):
    def check(self) -> None: ...

    def reserve(self, review: Review, now: float) -> None: ...

    def prompt(self) -> bytearray: ...

    def open_login(self, secret: bytearray) -> None: ...

    def run(self, secret: bytearray, expected_url: str) -> str: ...

    def wait_browser(self, deadline: float) -> str: ...

    def closeout(self, secret: bytearray) -> None: ...

    def emit(self, line: str) -> None: ...


def _object(value: object) -> dict:
    if not isinstance(value, dict):
        raise CoordinatorStop("PRIVATE_PACKET")
    return value


def _read_json(path: Path) -> dict:
    try:
        return _object(json.loads(path.read_text(encoding="utf-8")))
    except CoordinatorStop:
        raise
    except Exception as error:
        raise CoordinatorStop("PRIVATE_PACKET") from error


def _instant(value: object) -> float:
    try:
        if not isinstance(value, str) or not value.endswith("Z"):
            raise ValueError
        parsed = datetime.fromisoformat(value[:-1] + "+00:00")
        if parsed.tzinfo != timezone.utc:
            raise ValueError
        canonical = parsed.isoformat(timespec="milliseconds").replace("+00:00", "Z")
        if canonical != value:
            raise ValueError
        return parsed.timestamp()
    except Exception as error:
        raise CoordinatorStop("WINDOW_BINDING") from error


def _private_file(path: Path) -> None:
    try:
        info = path.lstat()
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid():
            raise ValueError
        if stat.S_IMODE(info.st_mode) != 0o600 or path.resolve(strict=True) != path:
            raise ValueError
    except Exception as error:
        raise CoordinatorStop("PRIVATE_PACKET") from error


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(64 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _git_review(repo: Path, backend_head: str) -> None:
    env = {"PATH": "/usr/bin:/bin"}
    try:
        status = subprocess.run(
            ["/usr/bin/git", "status", "--porcelain"],
            cwd=repo,
            env=env,
            capture_output=True,
            check=True,
            timeout=20,
        )
        if status.stdout:
            raise ValueError
        subprocess.run(
            ["/usr/bin/git", "cat-file", "-e", backend_head + "^{commit}"],
            cwd=repo,
            env=env,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            check=True,
            timeout=20,
        )
    except Exception as error:
        raise CoordinatorStop("SOURCE_BINDING") from error


def review_run_directory(
    root: Path,
    *,
    repo: Path = REPO,
    coordinator_path: Path | None = None,
    git_review: Callable[[Path, str], None] = _git_review,
    now: float | None = None,
) -> Review:
    """Review only local/private metadata. It performs no live or provider action."""

    coordinator_path = coordinator_path or Path(__file__).resolve()
    now = time.time() if now is None else now
    try:
        if not root.is_absolute() or root.resolve(strict=True) != root:
            raise ValueError
        if root.parent != PRIVATE_PARENT or not re.fullmatch(
            r"r11-supervised-run-\d{8}-\d{4}", root.name
        ):
            raise ValueError
        root_info = root.lstat()
        if (
            not stat.S_ISDIR(root_info.st_mode)
            or root_info.st_uid != os.getuid()
            or stat.S_IMODE(root_info.st_mode) != 0o700
        ):
            raise ValueError
    except Exception as error:
        raise CoordinatorStop("PRIVATE_DIRECTORY") from error

    required = (
        "runtime-packet.json",
        "r10-review-plan.json",
        "owner-approval.json",
        "helper-binding.json",
        "r10-control.mjs",
    )
    for name in required:
        _private_file(root / name)

    for marker in ACTION_MARKERS:
        if (root / marker).exists():
            raise CoordinatorStop("MARKER_REUSE")
    if any(root.glob("r10-stop-*.json")):
        raise CoordinatorStop("MARKER_REUSE")

    packet = _read_json(root / "runtime-packet.json")
    plan = _read_json(root / "r10-review-plan.json")
    approval = _read_json(root / "owner-approval.json")
    binding = _read_json(root / "helper-binding.json")

    plan_id = plan.get("planId")
    if (
        not isinstance(plan_id, str)
        or not re.fullmatch(
            r"[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}",
            plan_id,
            re.IGNORECASE,
        )
        or approval.get("owner") != "Debynyhan Banks"
        or approval.get("decision") != "APPROVED"
        or approval.get("planId") != plan_id
        or approval.get("connectedRuns") != 1
        or approval.get("automaticRetryAllowed") is not False
        or plan.get("automaticRetryAllowed") is not False
        or plan.get("origin") != TARGET_ORIGIN
        or plan.get("phoneFlowUpperBoundMicros") != FLOW_UPPER_BOUND_MICROS
        or plan.get("phoneAccountCeilingMicros") != ACCOUNT_CEILING_MICROS
        or plan.get("retainedPhoneLiabilityMicros") != RETAINED_LIABILITY_MICROS
        or plan.get("retainedPhoneHoldCount") != RETAINED_HOLD_COUNT
        or plan.get("addressCostMicros") != ADDRESS_COST_MICROS
        or plan.get("addressAccountMicros") != ADDRESS_ACCOUNT_MICROS
        or plan.get("addressAccountRequestLimit") != ADDRESS_ACCOUNT_REQUESTS
        or plan.get("addressTenantMicros") != ADDRESS_TENANT_MICROS
        or plan.get("addressTenantRequestLimit") != ADDRESS_TENANT_REQUESTS
        or plan.get("addressSessionMicros") != ADDRESS_SESSION_MICROS
        or plan.get("addressSessionRequestLimit") != ADDRESS_SESSION_REQUESTS
        or binding.get("planId") != plan_id
    ):
        raise CoordinatorStop("PLAN_BINDING")

    envelope = _object(packet.get("envelope"))
    phone = _object(envelope.get("phone"))
    address = _object(envelope.get("addressPolicy"))
    address_account = _object(address.get("account"))
    address_tenant = _object(address.get("tenant"))
    address_session = _object(address.get("session"))
    if (
        phone.get("flowUpperBoundMicros") != FLOW_UPPER_BOUND_MICROS
        or phone.get("accountCeilingMicros") != ACCOUNT_CEILING_MICROS
        or address.get("costMicros") != ADDRESS_COST_MICROS
        or address_account.get("micros") != ADDRESS_ACCOUNT_MICROS
        or address_account.get("requests") != ADDRESS_ACCOUNT_REQUESTS
        or address_tenant.get("micros") != ADDRESS_TENANT_MICROS
        or address_tenant.get("requests") != ADDRESS_TENANT_REQUESTS
        or address_session.get("micros") != ADDRESS_SESSION_MICROS
        or address_session.get("requests") != ADDRESS_SESSION_REQUESTS
        or envelope.get("origin") != TARGET_ORIGIN
        or envelope.get("revision") != plan.get("revision")
    ):
        raise CoordinatorStop("PLAN_BINDING")

    time_names = (
        "databaseLoginStart",
        "databaseLoginEnd",
        "runtimeStart",
        "runtimeEnd",
        "closeoutEnd",
    )
    for name in time_names:
        if approval.get(name) != plan.get(name):
            raise CoordinatorStop("WINDOW_BINDING")
    login_start, login_end, runtime_start, runtime_end, closeout_end = (
        _instant(plan[name]) for name in time_names
    )
    if not (
        login_start <= runtime_start < runtime_end < closeout_end <= login_end
        and runtime_end - runtime_start <= 15 * 60
        and closeout_end - runtime_end <= 15 * 60
        and closeout_end - runtime_end >= CLOSEOUT_RESERVE_SECONDS
        and now + RUN_RESERVE_SECONDS < runtime_end
    ):
        raise CoordinatorStop("WINDOW_BINDING")

    backend_head = binding.get("backendHead")
    files = binding.get("files")
    if not isinstance(backend_head, str) or not re.fullmatch(r"[a-f0-9]{40}", backend_head):
        raise CoordinatorStop("SOURCE_BINDING")
    if not isinstance(files, dict):
        raise CoordinatorStop("HELPER_BINDING")
    allowed = {
        "r10-control.mjs": root / "r10-control.mjs",
        "r10-private.py": root / "r10-private.py",
        "scripts/p06-r10-controller.mjs": repo / "scripts/p06-r10-controller.mjs",
        "scripts/p06-runtime-packet.mjs": repo / "scripts/p06-runtime-packet.mjs",
        "scripts/p06_r11_attended_coordinator.py": coordinator_path,
    }
    if not {
        "r10-control.mjs",
        "scripts/p06-r10-controller.mjs",
        "scripts/p06-runtime-packet.mjs",
        "scripts/p06_r11_attended_coordinator.py",
    }.issubset(files) or not set(files).issubset(allowed):
        raise CoordinatorStop("HELPER_BINDING")
    for name, expected in files.items():
        path = allowed[name]
        if path.parent == root:
            _private_file(path)
        if (
            not isinstance(expected, str)
            or not re.fullmatch(r"[a-f0-9]{64}", expected)
            or not path.is_file()
            or _sha256(path) != expected
        ):
            raise CoordinatorStop("HELPER_BINDING")

    git_review(repo, backend_head)
    return Review(
        root=root,
        plan_id=plan_id,
        origin=TARGET_ORIGIN,
        database_login_start=login_start,
        database_login_end=login_end,
        runtime_start=runtime_start,
        runtime_end=runtime_end,
        closeout_end=closeout_end,
    )


def _wait_until(target: float, now: Callable[[], float], sleep: Callable[[float], None]) -> None:
    while True:
        remaining = target - now()
        if remaining <= 0:
            return
        sleep(min(remaining, 1.0))


def _zero(secret: bytearray) -> None:
    if isinstance(secret, bytearray):
        secret[:] = b"\0" * len(secret)


def coordinate(
    review: Review,
    ports: Ports,
    *,
    now: Callable[[], float] = time.time,
    sleep: Callable[[float], None] = time.sleep,
) -> CoordinationResult:
    """Execute one attended sequence through injected ports, never retrying a mode."""

    secret = bytearray()
    live_started = False
    closeout_attempted = False
    active_url = None
    reason = "STOPPED"
    failed_stage = None
    expected_url = review.origin + "/customer-intake"
    try:
        _wait_until(review.database_login_start, now, sleep)
        if now() + RUN_RESERVE_SECONDS >= review.runtime_end:
            raise CoordinatorStop("WINDOW_EXPIRED")
        ports.check()
        ports.reserve(review, now())
        secret = ports.prompt()
        if not isinstance(secret, bytearray) or not secret:
            raise CoordinatorStop("PRIVATE_INPUT")
        live_started = True
        ports.open_login(secret)
        ports.emit("R10_DATABASE_LOGIN_OPEN")
        _wait_until(review.runtime_start, now, sleep)
        if now() + RUN_RESERVE_SECONDS >= review.runtime_end:
            raise CoordinatorStop("RUN_WINDOW")
        active_url = ports.run(secret, expected_url)
        if active_url != expected_url:
            raise CoordinatorStop("RUN_RESULT")
        ports.emit("R10_ACTIVE_READY " + active_url)
        browser_deadline = min(
            review.runtime_end,
            review.closeout_end - CLOSEOUT_RESERVE_SECONDS,
        )
        signal_result = ports.wait_browser(browser_deadline)
        if signal_result not in {"DONE", "STOP", "TIMEOUT"}:
            raise CoordinatorStop("BROWSER_SIGNAL")
        reason = "BROWSER_" + signal_result
    except KeyboardInterrupt:
        reason = "INTERRUPTED"
        failed_stage = "INTERRUPTED"
    except CoordinatorStop as error:
        reason = "CHILD_STOP"
        failed_stage = error.stage
    except BaseException:
        reason = "CHILD_STOP"
        failed_stage = "UNCONFIRMED"
    finally:
        closeout_verified = False
        if live_started and not closeout_attempted:
            closeout_attempted = True
            try:
                _wait_until(review.runtime_start, now, sleep)
                if now() + CLOSEOUT_RESERVE_SECONDS >= review.closeout_end:
                    raise CoordinatorStop("CLOSEOUT_WINDOW")
                ports.closeout(secret)
                ports.emit("R12_RUNTIME_CLOSEOUT_VERIFIED")
                closeout_verified = True
            except BaseException:
                failed_stage = "CLOSEOUT_UNCONFIRMED"
        _zero(secret)

    if live_started and not closeout_verified:
        return CoordinationResult(
            reason=reason,
            live_started=True,
            closeout_verified=False,
            active_url=active_url,
            failed_stage=failed_stage or "CLOSEOUT_UNCONFIRMED",
        )
    return CoordinationResult(
        reason=reason,
        live_started=live_started,
        closeout_verified=closeout_verified,
        active_url=active_url,
        failed_stage=failed_stage,
    )


class ProductionPorts:
    def __init__(self, review: Review, *, node: Path = NODE, output_fd: int = 1):
        self.review = review
        self.node = node
        self.output_fd = output_fd
        self.child: subprocess.Popen | None = None

    @property
    def command(self) -> list[str]:
        return [str(self.node), str(self.review.root / "r10-control.mjs")]

    def _environment(self) -> dict[str, str]:
        return {
            "PATH": str(self.node.parent) + ":/opt/homebrew/bin:/usr/bin:/bin"
        }

    def check(self) -> None:
        try:
            result = subprocess.run(
                [*self.command, "--check"],
                cwd=REPO,
                env=self._environment(),
                stdin=subprocess.DEVNULL,
                stdout=subprocess.PIPE,
                stderr=subprocess.DEVNULL,
                check=False,
                timeout=180,
            )
            if result.returncode != 0 or result.stdout != b"R10_CHECK_PASSED_NO_ACTION\n":
                raise ValueError
        except Exception as error:
            raise CoordinatorStop("CONTROLLER_CHECK") from error

    def reserve(self, review: Review, now: float) -> None:
        path = review.root / "coordinator-attempt.json"
        record = {
            "planId": review.plan_id,
            "checkedAt": datetime.fromtimestamp(now, timezone.utc)
            .isoformat(timespec="milliseconds")
            .replace("+00:00", "Z"),
            "status": "RESERVED_DO_NOT_RETRY",
        }
        descriptor = None
        try:
            descriptor = os.open(
                path,
                os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                0o600,
            )
            with os.fdopen(descriptor, "wb", closefd=False) as target:
                target.write((json.dumps(record, indent=2) + "\n").encode("utf-8"))
                target.flush()
                os.fsync(descriptor)
            os.close(descriptor)
            descriptor = None
            directory = os.open(review.root, os.O_RDONLY | os.O_DIRECTORY)
            try:
                os.fsync(directory)
            finally:
                os.close(directory)
        except Exception as error:
            if descriptor is not None:
                os.close(descriptor)
            raise CoordinatorStop("COORDINATOR_RESERVATION") from error

    def prompt(self) -> bytearray:
        from p06_private_input import private_read

        self.emit(
            "One approved R11 sequence will run and close out from this command."
        )
        try:
            return private_read(0, self.output_fd, timeout=120)
        except BaseException as error:
            raise CoordinatorStop("PRIVATE_INPUT") from error

    def _secret_mode(self, mode: str, secret: bytearray, expected: bytes) -> bytes:
        from p06_private_input import read_ready

        try:
            self.child = subprocess.Popen(
                [*self.command, mode],
                cwd=REPO,
                env=self._environment(),
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.DEVNULL,
                close_fds=True,
            )
            read_ready(self.child.stdout, timeout=60)
            self.child.stdin.write(secret)
            self.child.stdin.write(b"\n")
            self.child.stdin.close()
            self.child.stdin = None
            output, _ = self.child.communicate(timeout=300)
            if self.child.returncode != 0 or output != expected:
                raise ValueError
            return output
        except BaseException as error:
            raise CoordinatorStop("CONTROLLER_" + mode[2:].upper().replace("-", "_")) from error
        finally:
            if self.child is not None:
                if self.child.stdin is not None:
                    self.child.stdin.close()
                    self.child.stdin = None
                if self.child.poll() is None:
                    self.child.terminate()
                    try:
                        self.child.wait(timeout=5)
                    except subprocess.TimeoutExpired:
                        self.child.kill()
                        self.child.wait()
                if self.child.stdout is not None:
                    self.child.stdout.close()
                self.child = None

    def open_login(self, secret: bytearray) -> None:
        self._secret_mode("--open-login", secret, b"R10_DATABASE_LOGIN_OPEN\n")

    def run(self, secret: bytearray, expected_url: str) -> str:
        expected = ("R10_ACTIVE_READY " + expected_url + "\n").encode("utf-8")
        self._secret_mode("--run", secret, expected)
        return expected_url

    def wait_browser(self, deadline: float) -> str:
        self.emit(
            "Complete the owner-operated browser journey. Type DONE after a terminal "
            "result or STOP after any error; closeout runs automatically."
        )
        line = bytearray()
        while time.time() < deadline and len(line) <= 16:
            remaining = deadline - time.time()
            if remaining <= 0 or not select.select([0], [], [], remaining)[0]:
                return "TIMEOUT"
            chunk = os.read(0, 1)
            if not chunk or chunk in (b"\x03", b"\x04"):
                raise KeyboardInterrupt
            if chunk in (b"\n", b"\r"):
                value = line.decode("ascii", errors="ignore").strip().upper()
                return value if value in {"DONE", "STOP"} else "INVALID"
            line.extend(chunk)
        return "INVALID"

    def closeout(self, secret: bytearray) -> None:
        self._secret_mode("--closeout", secret, b"R12_RUNTIME_CLOSEOUT_VERIFIED\n")

    def emit(self, line: str) -> None:
        os.write(self.output_fd, (line + "\n").encode("utf-8"))


def _install_signal_handlers():
    previous = {}

    def interrupt(_number, _frame):
        raise KeyboardInterrupt

    for number in (signal.SIGTERM, signal.SIGHUP):
        previous[number] = signal.signal(number, interrupt)
    return previous


def _restore_signal_handlers(previous) -> None:
    for number, handler in previous.items():
        signal.signal(number, handler)


def main(argv: list[str] | None = None) -> int:
    argv = sys.argv[1:] if argv is None else argv
    previous = _install_signal_handlers()
    try:
        if len(argv) != 2 or argv[0] != "--run" or not os.isatty(0):
            raise CoordinatorStop("CLI")
        review = review_run_directory(Path(argv[1]))
        ports = ProductionPorts(review)
        result = coordinate(review, ports)
        if not result.live_started:
            print(
                "R11_ATTENDED_COORDINATOR_STOPPED_BEFORE_ACTION. Do not rerun this "
                "prepared operation.",
                file=sys.stderr,
            )
            return 1
        if not result.closeout_verified:
            print(
                "R11_ATTENDED_COORDINATOR_CLOSEOUT_UNCONFIRMED. Do not rerun.",
                file=sys.stderr,
            )
            return 1
        print("R11_ATTENDED_COORDINATOR_CLOSED_" + result.reason)
        return 0 if result.reason in {"BROWSER_DONE", "BROWSER_STOP"} else 1
    except (CoordinatorStop, KeyboardInterrupt):
        print(
            "R11 attended coordinator stopped before a verified finish. Do not rerun; "
            "report this exact line.",
            file=sys.stderr,
        )
        return 1
    finally:
        _restore_signal_handlers(previous)


if __name__ == "__main__":
    raise SystemExit(main())
