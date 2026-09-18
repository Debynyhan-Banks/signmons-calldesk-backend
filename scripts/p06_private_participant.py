"""Private R08 participant input; the phone is forwarded only through a pipe."""

import os
import json
import re
import select
import signal
import subprocess
import sys
import termios
import time
from datetime import datetime, timezone


NODE = "/Users/debynyhanbanks/.nvm/versions/node/v24.12.0/bin/node"
SCRIPT = "/Volumes/Signmons-P06/r08-bundle-preparation-20260918/bind-participant.mjs"
ROOT = "/Volumes/Signmons-P06/r08-bundle-preparation-20260918"
READY = b"READY\n"
SUCCESS = b"PARTICIPANT_BOUND_NO_SMS\n"
ABORT = b"ABORT\n"
ABORTED = b"PARTICIPANT_BINDING_ABORTED_NO_SMS\n"
STAGES = {
    "LOCAL_PREFLIGHT",
    "INPUT_READY",
    "INPUT_PIPE",
    "INPUT_FORMAT",
    "GOOGLE_AUTH",
    "DIGEST_ACCESS",
    "DIGEST_FORMAT",
    "ACCOUNT_ACCESS",
    "ACCOUNT_FORMAT",
    "SAVE_BINDING",
    "INPUT_TIMEOUT",
    "INPUT_CANCELLED",
}


class BindingRefused(ValueError):
    def __init__(self, stage=None, local=False):
        super().__init__("participant binding refused")
        self.stage = stage if stage in STAGES else None
        self.local = local


def _cancel(_number, _frame):
    raise KeyboardInterrupt()


def _read_ready(stream, timeout=20):
    deadline = time.monotonic() + timeout
    line = bytearray()
    try:
        while len(line) < 64:
            remaining = deadline - time.monotonic()
            if remaining <= 0 or not select.select([stream], [], [], remaining)[0]:
                raise BindingRefused()
            byte = os.read(stream.fileno(), 1)
            if not byte:
                raise BindingRefused()
            line.extend(byte)
            if byte == b"\n":
                if line != READY:
                    raise BindingRefused()
                return
        raise BindingRefused()
    finally:
        line[:] = b"\0" * len(line)


def _read_phone(input_fd, output_fd, timeout=60):
    if not os.isatty(input_fd) or not 0 < timeout <= 60:
        raise BindingRefused(local=True)
    phone = bytearray()
    previous = termios.tcgetattr(input_fd)
    hidden = termios.tcgetattr(input_fd)
    hidden[3] &= ~(termios.ECHO | termios.ECHONL | termios.ICANON | termios.ISIG)
    try:
        termios.tcsetattr(input_fd, termios.TCSAFLUSH, hidden)
        os.write(
            output_fd,
            b"Your US mobile number (+1 and 10 digits; spaces/parentheses/hyphens accepted; input hidden): ",
        )
        deadline = time.monotonic() + timeout
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0 or not select.select([input_fd], [], [], remaining)[0]:
                raise BindingRefused("INPUT_TIMEOUT", local=True)
            byte = os.read(input_fd, 1)
            if not byte or byte in (b"\x03", b"\x04"):
                raise KeyboardInterrupt()
            if byte in (b"\n", b"\r"):
                break
            if byte in (b"\x7f", b"\x08"):
                if phone:
                    phone.pop()
                continue
            # Accept only printable ASCII plus Terminal's exact bracketed-paste
            # escape wrapper; validate and remove that wrapper before use.
            if (not 32 <= byte[0] <= 126 and byte != b"\x1b") or len(phone) >= 32:
                raise BindingRefused("INPUT_FORMAT", local=True)
            phone.extend(byte)
        opening, closing = b"\x1b[200~", b"\x1b[201~"
        if phone.startswith(opening) or phone.endswith(closing):
            if not phone.startswith(opening) or not phone.endswith(closing):
                raise BindingRefused("INPUT_FORMAT", local=True)
            del phone[-len(closing) :]
            del phone[: len(opening)]
        if any(not 32 <= byte <= 126 for byte in phone):
            raise BindingRefused("INPUT_FORMAT", local=True)
        allowed = b"+0123456789 ()-."
        separators = b" ()-."
        if any(byte not in allowed for byte in phone):
            raise BindingRefused("INPUT_FORMAT", local=True)
        canonical = bytearray(byte for byte in phone if byte not in separators)
        phone[:] = b"\0" * len(phone)
        phone = canonical
        if re.fullmatch(rb"\+1[2-9][0-9]{9}", phone) is None:
            raise BindingRefused("INPUT_FORMAT", local=True)
        return phone
    except BaseException:
        phone[:] = b"\0" * len(phone)
        raise
    finally:
        termios.tcsetattr(input_fd, termios.TCSAFLUSH, previous)


def _fixed_stage(stderr):
    match = re.fullmatch(
        rb"PARTICIPANT_BINDING_REFUSED_NO_SMS:([A-Z_]+)\n", stderr
    )
    if match is None:
        return None
    stage = match.group(1).decode("ascii")
    return stage if stage in STAGES else None


def _record_local_stop(stage, root=ROOT):
    if stage not in {"INPUT_FORMAT", "INPUT_TIMEOUT", "INPUT_CANCELLED"}:
        return
    record = {
        "recordKind": "local-input-stop",
        "stage": stage,
        "noSms": True,
        "checkedAt": datetime.now(timezone.utc)
        .isoformat(timespec="milliseconds")
        .replace("+00:00", "Z"),
    }
    descriptor = None
    try:
        path = root + "/local-input-stop-" + str(time.time_ns() // 1_000_000) + ".json"
        descriptor = os.open(
            path,
            os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
            0o600,
        )
        os.write(descriptor, (json.dumps(record, separators=(",", ":")) + "\n").encode())
        os.fsync(descriptor)
    except Exception:
        pass
    finally:
        if descriptor is not None:
            os.close(descriptor)


def _stop_child(child):
    if child.stdin is not None:
        child.stdin.close()
        child.stdin = None
    if child.poll() is None:
        try:
            child.wait(timeout=2)
        except subprocess.TimeoutExpired:
            child.terminate()
            try:
                child.wait(timeout=3)
            except subprocess.TimeoutExpired:
                child.kill()
                child.wait()


def forward_participant(
    command,
    input_fd=0,
    output_fd=1,
    input_timeout=60,
    ready_timeout=20,
    child_timeout=50,
):
    """Wait for this bind child's preflight, then forward one hidden phone line."""
    if not os.isatty(input_fd):
        raise BindingRefused()
    child = None
    phone = bytearray()
    previous_signals = {}
    for number in (signal.SIGTERM, signal.SIGHUP):
        previous_signals[number] = signal.signal(number, _cancel)
    try:
        child = subprocess.Popen(
            command,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            close_fds=True,
        )
        try:
            _read_ready(child.stdout, ready_timeout)
        except BindingRefused:
            _stop_child(child)
            stderr = child.stderr.read(256)
            raise BindingRefused(_fixed_stage(stderr)) from None
        try:
            phone = _read_phone(input_fd, output_fd, input_timeout)
        except BaseException:
            try:
                child.stdin.write(ABORT)
                child.stdin.close()
                child.stdin = None
                stdout, stderr = child.communicate(timeout=3)
                if child.returncode != 0 or stdout != ABORTED or stderr:
                    raise BindingRefused()
            except (BrokenPipeError, subprocess.TimeoutExpired):
                pass
            raise
        child.stdin.write(phone)
        child.stdin.write(b"\n")
        child.stdin.close()
        child.stdin = None
        phone[:] = b"\0" * len(phone)
        stdout, stderr = child.communicate(timeout=child_timeout)
        if child.returncode != 0 or stdout != SUCCESS or stderr:
            raise BindingRefused(_fixed_stage(stderr))
    except subprocess.TimeoutExpired:
        raise BindingRefused() from None
    finally:
        phone[:] = b"\0" * len(phone)
        if child is not None:
            _stop_child(child)
            child.stdout.close()
            child.stderr.close()
        for number, handler in previous_signals.items():
            signal.signal(number, handler)


def main():
    try:
        if sys.argv[1:] != ["--bind"] or not os.isatty(0):
            raise BindingRefused()
        print(
            "R08 private participant binding only. Reads the existing digest key "
            "and account identifier; sends no SMS and does not activate intake.",
            flush=True,
        )
        forward_participant([NODE, SCRIPT, "--bind"])
        print("\nParticipant bound privately. No SMS sent. Tell Codex: participant bound.")
    except (BindingRefused, KeyboardInterrupt) as error:
        stage = (
            error.stage
            if isinstance(error, BindingRefused)
            else "INPUT_CANCELLED"
        )
        if (isinstance(error, BindingRefused) and error.local) or isinstance(
            error, KeyboardInterrupt
        ):
            _record_local_stop(stage)
        if stage is not None:
            print("Failure stage: " + stage, file=sys.stderr)
        print(
            "Participant binding stopped. No SMS sent. Tell Codex: participant binding stopped.",
            file=sys.stderr,
        )
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
