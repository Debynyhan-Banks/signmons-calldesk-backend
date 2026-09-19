"""Private TTY-to-pipe handoff for a bounded diagnostic status."""
import os
import re
import select
import signal
import subprocess
import sys
import time

from p06_private_input import private_read, read_ready


STATUS = re.compile(
    rb"R10_ACTIVATION_DIAGNOSTIC_(?:PASS|FAIL|UNCONFIRMED)_[A-Z_]{3,80}\n"
)


def _read_status(stream, timeout):
    deadline = time.monotonic() + timeout
    line = bytearray()
    while len(line) < 128:
        remaining = deadline - time.monotonic()
        if remaining <= 0 or not select.select([stream], [], [], remaining)[0]:
            raise TimeoutError("diagnostic timeout")
        byte = os.read(stream.fileno(), 1)
        if not byte:
            raise ValueError("diagnostic refused")
        line.extend(byte)
        if byte == b"\n":
            value = bytes(line)
            if not STATUS.fullmatch(value):
                raise ValueError("diagnostic refused")
            return value
    raise ValueError("diagnostic refused")


def forward_diagnostic(command, input_fd, output_fd, timeout=60):
    """Forward hidden TTY input with the newline required by readPipe."""
    if not os.isatty(input_fd) or not 0 < timeout <= 60:
        raise ValueError("private terminal required")
    if (
        not isinstance(command, list)
        or len(command) < 2
        or not all(isinstance(part, str) and part for part in command)
    ):
        raise ValueError("fixed command required")
    secret = bytearray()
    child = subprocess.Popen(
        command,
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        close_fds=True,
        env={"PATH": os.path.dirname(command[0])},
    )
    previous_signals = {}

    def cancel(_number, _frame):
        raise KeyboardInterrupt()

    for number in (signal.SIGTERM, signal.SIGHUP):
        previous_signals[number] = signal.signal(number, cancel)
    try:
        read_ready(child.stdout)
        secret = private_read(input_fd, output_fd, timeout)
        child.stdin.write(secret)
        child.stdin.write(b"\n")
        child.stdin.close()
        child.stdin = None
        secret[:] = b"\0" * len(secret)
        status = _read_status(child.stdout, 20)
        child.wait(timeout=5)
        if child.returncode != 0:
            raise ValueError("diagnostic refused")
        os.write(output_fd, b"\n" + status)
    finally:
        secret[:] = b"\0" * len(secret)
        if child.stdin is not None:
            child.stdin.close()
            child.stdin = None
        if child.poll() is None:
            child.terminate()
            try:
                child.wait(timeout=5)
            except subprocess.TimeoutExpired:
                child.kill()
                child.wait()
        child.stdout.close()
        for number, handler in previous_signals.items():
            signal.signal(number, handler)


if __name__ == "__main__":
    print(
        "Private diagnostic transport requires a fixed reviewed caller; no action performed.",
        file=sys.stderr,
    )
    raise SystemExit(1)
