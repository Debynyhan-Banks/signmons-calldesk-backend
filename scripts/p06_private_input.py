"""Private terminal-to-passfile input. No network access or secret arguments."""
import os
import select
import signal
import stat
import sys
import termios
import time
from pathlib import Path

HOST = "ep-jolly-flower-ayc6w9hv.c-5.us-east-2.aws.neon.tech"
ROLE = "p06_migration_runner"


def capture(target, input_fd, output_fd, timeout=60):
    target = Path(target)
    if not target.is_absolute() or target.name != "pgpass":
        raise ValueError("invalid destination")
    parent = target.parent
    if parent.resolve(strict=True) != parent:
        raise ValueError("symlink destination")
    info = parent.stat()
    if info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) != 0o700:
        raise ValueError("private directory required")
    if not os.isatty(input_fd):
        raise ValueError("private terminal required")
    if timeout <= 0 or timeout > 120:
        raise ValueError("invalid timeout")
    directory = os.open(parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    secret = bytearray()
    previous = termios.tcgetattr(input_fd)
    terminal = termios.tcgetattr(input_fd)
    terminal[3] &= ~(termios.ECHO | termios.ECHONL | termios.ICANON | termios.ISIG)
    created = False
    fd = None
    previous_signals = {}
    def cancel(_number, _frame):
        raise KeyboardInterrupt()
    try:
        for number in (signal.SIGTERM, signal.SIGHUP):
            previous_signals[number] = signal.signal(number, cancel)
        # Reserve destination before asking for a secret; never overwrite.
        fd = os.open("pgpass", os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                     0o600, dir_fd=directory)
        created = True
        termios.tcsetattr(input_fd, termios.TCSAFLUSH, terminal)
        os.write(output_fd, b"Private password (input hidden): ")
        deadline = time.monotonic() + timeout
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0 or not select.select([input_fd], [], [], remaining)[0]:
                raise TimeoutError("input timeout")
            chunk = os.read(input_fd, 1)
            if not chunk or chunk in (b"\x03", b"\x04"):
                raise KeyboardInterrupt()
            if chunk in (b"\n", b"\r"):
                break
            if chunk in (b"\x7f", b"\x08"):
                if secret:
                    secret.pop()
                continue
            if not 32 <= chunk[0] <= 126 or len(secret) >= 512:
                raise ValueError("invalid input")
            secret.extend(chunk)
        if not secret:
            raise ValueError("empty input")
        escaped = bytes(secret).replace(b"\\", b"\\\\").replace(b":", b"\\:")
        entry = HOST.encode() + b":5432:neondb:" + ROLE.encode() + b":" + escaped + b"\n"
        with os.fdopen(fd, "wb", closefd=False) as output:
            output.write(entry)
            output.flush()
            os.fsync(fd)
        if stat.S_IMODE(os.fstat(fd).st_mode) != 0o600:
            raise ValueError("unsafe output mode")
        os.write(output_fd, b"\nPrivate input saved.\n")
    except BaseException:
        if created:
            os.unlink("pgpass", dir_fd=directory)
        raise
    finally:
        if fd is not None:
            os.close(fd)
        for i in range(len(secret)):
            secret[i] = 0
        # Best effort Python memory clearing is NOT a forensic zeroization claim.
        termios.tcsetattr(input_fd, termios.TCSAFLUSH, previous)
        os.close(directory)
        for number, handler in previous_signals.items():
            signal.signal(number, handler)


if __name__ == "__main__":
    try:
        # No arbitrary path, command-line password, environment secret or pipe input.
        if len(sys.argv) != 1:
            raise ValueError("arguments refused")
        capture("/Volumes/Signmons-P06/r02-backup-v1/pgpass", 0, 1)
    except (Exception, KeyboardInterrupt):
        print("Private input refused or cancelled.", file=sys.stderr)
        sys.exit(1)
