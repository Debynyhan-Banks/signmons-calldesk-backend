"""Private TTY input. Administrator input is forwarded only through an anonymous pipe."""
import os
import select
import signal
import stat
import subprocess
import shutil
import sys
import termios
import time
from pathlib import Path

HOST = "ep-jolly-flower-ayc6w9hv.c-5.us-east-2.aws.neon.tech"
ROLE = "p06_migration_runner"


def private_read(input_fd, output_fd, timeout=60):
    if not os.isatty(input_fd) or not 0 < timeout <= 120:
        raise ValueError("private terminal required")
    secret = bytearray()
    previous = termios.tcgetattr(input_fd)
    terminal = termios.tcgetattr(input_fd)
    terminal[3] &= ~(termios.ECHO | termios.ECHONL | termios.ICANON | termios.ISIG)
    previous_signals = {}
    def cancel(_number, _frame):
        raise KeyboardInterrupt()
    try:
        for number in (signal.SIGTERM, signal.SIGHUP):
            previous_signals[number] = signal.signal(number, cancel)
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
        return secret
    except BaseException:
        secret[:] = b"\0" * len(secret)
        raise
    finally:
        termios.tcsetattr(input_fd, termios.TCSAFLUSH, previous)
        for number, handler in previous_signals.items():
            signal.signal(number, handler)


def capture(target, input_fd, output_fd, timeout=60):
    """Existing runner-only capture API; never give it an administrator password."""
    target = Path(target)
    if not target.is_absolute() or target.name != "pgpass":
        raise ValueError("invalid destination")
    parent = target.parent
    if parent.resolve(strict=True) != parent:
        raise ValueError("symlink destination")
    info = parent.stat()
    if info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) != 0o700:
        raise ValueError("private directory required")
    if not os.isatty(input_fd) or not 0 < timeout <= 120:
        raise ValueError("private terminal required")
    directory = os.open(parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    secret = bytearray()
    fd = None
    try:
        fd = os.open("pgpass", os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                     0o600, dir_fd=directory)
        secret = private_read(input_fd, output_fd, timeout)
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
        if fd is not None:
            os.unlink("pgpass", dir_fd=directory)
        raise
    finally:
        if fd is not None:
            os.close(fd)
        secret[:] = b"\0" * len(secret)
        os.close(directory)


def forward_admin(command, input_fd, output_fd, timeout=60, backup=False):
    """Fixed CLI supplies command; injected command used only by dummy local tests."""
    if not os.isatty(input_fd) or not 0 < timeout <= 60:
        raise ValueError("private terminal required")
    secret = bytearray()
    child = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                             stderr=subprocess.DEVNULL, close_fds=True,
                             env={"PATH": os.path.dirname(command[0])})
    previous_signals = {}
    def cancel(_number, _frame):
        raise KeyboardInterrupt()
    for number in (signal.SIGTERM, signal.SIGHUP):
        previous_signals[number] = signal.signal(number, cancel)
    try:
        # Child preflight must finish before owner is asked to reveal a credential.
        if not select.select([child.stdout], [], [], 20)[0]:
            raise TimeoutError("preflight timeout")
        if child.stdout.readline(64) != b"READY\n":
            raise ValueError("preflight refused")
        secret = private_read(input_fd, output_fd, timeout)
        child.stdin.write(secret)
        child.stdin.write(b"\n")
        child.stdin.close()
        child.stdin = None
        secret[:] = b"\0" * len(secret)
        output, _ = child.communicate(timeout=1260 if backup else 125)
        expected = b"BACKUP_COMPLETE\n" if backup else b"HANDOFF_READY\n"
        if child.returncode != 0 or output != expected:
            raise ValueError("handoff refused; inspect fixed status record")
        os.write(output_fd, b"\nBackup and local cleanup complete.\n" if backup else
                 b"\nPrivate handoff complete. Runner remains NOLOGIN.\n")
    finally:
        secret[:] = b"\0" * len(secret)
        if child.stdin is not None:
            child.stdin.close()
            child.stdin = None
        if child.poll() is None:
            # EOF gives the child a chance to perform its independent cleanup.
            try:
                child.wait(timeout=5)
            except subprocess.TimeoutExpired:
                child.terminate()
                try:
                    child.wait(timeout=45 if backup else 8)
                except subprocess.TimeoutExpired:
                    child.kill()
                    child.wait()
        child.stdout.close()
        for number, handler in previous_signals.items():
            signal.signal(number, handler)


if __name__ == "__main__":
    try:
        # No credential arguments/environment, arbitrary host/path or default admin mode.
        if sys.argv[1:] not in (["--administrator"], ["--existing-admin-backup"]):
            raise ValueError("explicit administrator mode required")
        executable = shutil.which("node")
        if executable is None:
            raise ValueError("runtime unavailable")
        backup = sys.argv[1:] == ["--existing-admin-backup"]
        command = ([executable, str(Path(__file__).resolve().with_name("p06-backup-once.mjs")),
                    "--existing-admin-backup", "/Volumes/Signmons-P06/r02-backup-admin-v1/approval.json"]
                   if backup else [executable, str(Path(__file__).resolve().with_name(
                       "p06-private-role-password.mjs")),
                       "/Volumes/Signmons-P06/r02-backup-v2/approval.json"])
        forward_admin(command, 0, 1, backup=backup)
    except (Exception, KeyboardInterrupt):
        # Never print exception/child payload: it may carry credential material.
        print("Private handoff refused or cancelled; verify closeout before any retry.", file=sys.stderr)
        sys.exit(1)
