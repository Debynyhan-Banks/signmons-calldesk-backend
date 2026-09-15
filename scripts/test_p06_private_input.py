import importlib.util
import hashlib
import os
import pty
import select
import stat
import subprocess
import sys
import tempfile
import termios
import time
import unittest
from pathlib import Path

MODULE = Path(__file__).with_name("p06_private_input.py")
spec = importlib.util.spec_from_file_location("private_input", MODULE)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class PrivateInputTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="p06-dummy-input-", dir="/private/tmp")
        self.root = Path(self.temp.name)
        self.path = self.root / "pgpass"

    def tearDown(self):
        self.temp.cleanup()

    def run_input(self, payload, timeout=1):
        master, slave = pty.openpty()
        original = termios.tcgetattr(slave)
        program = (
            "import sys;sys.path.insert(0,sys.argv[1]);"
            "from p06_private_input import capture;"
            "capture(sys.argv[2],0,1,float(sys.argv[3]))"
        )
        proc = subprocess.Popen(
            [sys.executable, "-B", "-c", program, str(MODULE.parent), str(self.path), str(timeout)],
            stdin=slave, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        )
        observed = b""
        try:
            until = time.monotonic() + 5
            while b"input hidden" not in observed and proc.poll() is None:
                if time.monotonic() > until:
                    self.fail("no private prompt")
                if select.select([proc.stdout], [], [], 0.1)[0]:
                    observed += os.read(proc.stdout.fileno(), 4096)
            if payload == "terminate" and proc.poll() is None:
                proc.terminate()
            elif payload is not None and proc.poll() is None:
                self.assertFalse(termios.tcgetattr(slave)[3] & termios.ECHO)
                os.write(master, payload)
            stdout, stderr = proc.communicate(timeout=5)
            observed += stdout + stderr
            echoed = b""
            while select.select([master], [], [], 0)[0]:
                echoed += os.read(master, 4096)
            self.assertEqual(termios.tcgetattr(slave), original)
            return proc.returncode, observed + echoed
        finally:
            if proc.poll() is None:
                proc.kill()
                proc.wait()
            os.close(master)
            os.close(slave)

    def test_success_hidden_escaped_private(self):
        dummy = b"DUMMY-only:a\\b"
        code, transcript = self.run_input(dummy + b"\n")
        self.assertEqual(code, 0)
        self.assertNotIn(dummy, transcript)
        self.assertEqual(stat.S_IMODE(self.path.stat().st_mode), 0o600)
        self.assertEqual(self.path.read_bytes(),
                         module.HOST.encode() + b":5432:neondb:p06_migration_runner:DUMMY-only\\:a\\\\b\n")

    def test_cancel_eof_empty_invalid_timeout_cleanup(self):
        for value in (b"\x03", b"\x04", b"\n", b"bad\x01", b"x" * 513):
            with self.subTest(value_length=len(value)):
                code, _ = self.run_input(value)
                self.assertNotEqual(code, 0)
                self.assertFalse(self.path.exists())
        code, _ = self.run_input(None, 0.1)
        self.assertNotEqual(code, 0)
        self.assertFalse(self.path.exists())
        code, _ = self.run_input("terminate")
        self.assertNotEqual(code, 0)
        self.assertFalse(self.path.exists())

    def test_existing_file_and_symlink_preserved(self):
        self.path.write_text("keep")
        code, _ = self.run_input(None)
        self.assertNotEqual(code, 0)
        self.assertEqual(self.path.read_text(), "keep")
        self.path.unlink()
        outside = self.root / "untouched"
        outside.write_text("keep")
        self.path.symlink_to(outside)
        code, _ = self.run_input(None)
        self.assertNotEqual(code, 0)
        self.assertEqual(outside.read_text(), "keep")
        self.assertTrue(self.path.is_symlink())

    def test_insecure_parent_and_non_terminal_refused(self):
        self.root.chmod(0o755)
        with self.assertRaises(ValueError):
            module.capture(self.path, 0, 1)
        self.root.chmod(0o700)
        read_fd, write_fd = os.pipe()
        try:
            with self.assertRaises(ValueError):
                module.capture(self.path, read_fd, 1)
        finally:
            os.close(read_fd)
            os.close(write_fd)
        self.assertFalse(self.path.exists())


class AdminPipeTests(unittest.TestCase):
    def run_forward(self, mode="success", payload=b"FICTIONAL_ADMIN_CANARY\n"):
        master, slave = pty.openpty()
        previous = termios.tcgetattr(slave)
        # Child checks transport and leaks a canary on failure deliberately: wrapper must redact it.
        child = (
            "import sys,os,stat,json,hashlib;"
            "assert stat.S_ISFIFO(os.fstat(0).st_mode);"
            + ("print('REFUSED',flush=True);sys.exit(1)" if mode == "early" else
               "print('READY',flush=True);value=sys.stdin.buffer.read();"
               "assert value.rstrip().decode() not in json.dumps([sys.argv,dict(os.environ)]);"
               "assert hashlib.sha256(value).hexdigest()==" + repr(hashlib.sha256(b"FICTIONAL_ADMIN_CANARY\n").hexdigest()) + ";" +
               ("print(value.decode());sys.stderr.write(value.decode());sys.exit(1)"
                if mode == "failure" else "print('HANDOFF_READY',flush=True)"))
        )
        program = (
            "import sys;sys.path.insert(0,sys.argv[1]);from p06_private_input import forward_admin;"
            "forward_admin([sys.executable,'-B','-c',sys.argv[2]],0,1,0.3)"
        )
        proc = subprocess.Popen([sys.executable,"-B","-c",program,str(MODULE.parent),child],
                                stdin=slave,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
        observed=b""
        try:
            until=time.monotonic()+5
            while b"input hidden" not in observed and proc.poll() is None:
                if time.monotonic()>until:
                    self.fail("no prompt or refusal")
                if select.select([proc.stdout],[],[],0.1)[0]:
                    observed += os.read(proc.stdout.fileno(),4096)
            if b"input hidden" in observed:
                self.assertFalse(termios.tcgetattr(slave)[3] & termios.ECHO)
                if payload == "terminate":
                    proc.terminate()
                elif payload is not None:
                    os.write(master,payload)
            out,err=proc.communicate(timeout=10)
            observed+=out+err
            while select.select([master],[],[],0)[0]:
                observed+=os.read(master,4096)
            self.assertEqual(termios.tcgetattr(slave),previous)
            self.assertNotIn(b"FICTIONAL_ADMIN_CANARY",observed)
            return proc.returncode,observed
        finally:
            if proc.poll() is None:proc.kill();proc.wait()
            os.close(master);os.close(slave)

    def test_anonymous_pipe_hidden_input_no_secret_output(self):
        code,output=self.run_forward()
        self.assertEqual(code,0)
        self.assertIn(b"Runner remains NOLOGIN",output)

    def test_failures_cancellation_timeout_and_child_failure_redact(self):
        for mode,payload in [("early",None),("failure",b"FICTIONAL_ADMIN_CANARY\n"),
                             ("success",None),("success",b"\x03"),("success","terminate")]:
            with self.subTest(mode=mode,payload=payload):
                code,_=self.run_forward(mode,payload)
                self.assertNotEqual(code,0)

    def test_cli_rejects_old_direct_capture_and_non_tty(self):
        for args in ([],["/tmp/password"],["--administrator"]):
            result=subprocess.run([sys.executable,"-B",str(MODULE),*args],
                                  input=b"FICTIONAL_ADMIN_CANARY",capture_output=True)
            self.assertNotEqual(result.returncode,0)
            self.assertNotIn(b"FICTIONAL_ADMIN_CANARY",result.stdout+result.stderr)


if __name__ == "__main__":
    unittest.main()
