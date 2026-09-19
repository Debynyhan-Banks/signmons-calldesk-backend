import hashlib
import importlib.util
import json
import os
import pty
import select
import shutil
import subprocess
import sys
import termios
import time
import unittest
from pathlib import Path


MODULE = Path(__file__).resolve().with_name("p06_private_diagnostic.py")


class PrivateDiagnosticTests(unittest.TestCase):
    def run_forward(self, mode="success", payload=b"FICTIONAL_DIAGNOSTIC_SECRET\n"):
        master, slave = pty.openpty()
        previous = termios.tcgetattr(slave)
        reader = MODULE.with_name("p06_backup_guards.mjs").as_uri()
        expected = hashlib.sha256(payload).hexdigest()
        child = (
            "import {readPipe} from "
            + json.dumps(reader)
            + ";import {createHash} from 'node:crypto';"
            + (
                "process.stdout.write('NOT_READY\\n');process.exitCode=1;"
                if mode == "early"
                else "process.stdout.write('READY\\n');try{const value=await readPipe(process.stdin,{race:p=>p});"
                "if(createHash('sha256').update(value+'\\n').digest('hex')!=="
                + json.dumps(expected)
                + ")throw Error();"
                + (
                    "process.stdout.write('PRIVATE '+value+'\\n');process.exitCode=1;"
                    if mode == "failure"
                    else "process.stdout.write('R10_ACTIVATION_DIAGNOSTIC_FAIL_ORGANIZATION_APPROVAL_BINDING\\n');"
                )
                + "}catch{process.exitCode=1;}"
            )
        )
        command = [shutil.which("node"), "--input-type=module", "-e", child]
        program = (
            "import json,sys;sys.path.insert(0,sys.argv[1]);"
            "from p06_private_diagnostic import forward_diagnostic;"
            "forward_diagnostic(json.loads(sys.argv[2]),0,1,0.5)"
        )
        proc = subprocess.Popen(
            [sys.executable, "-B", "-c", program, str(MODULE.parent), json.dumps(command)],
            stdin=slave,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
        observed = b""
        try:
            until = time.monotonic() + 5
            while b"input hidden" not in observed and proc.poll() is None:
                if time.monotonic() > until:
                    self.fail("no prompt or refusal")
                if select.select([proc.stdout], [], [], 0.1)[0]:
                    observed += os.read(proc.stdout.fileno(), 4096)
            if b"input hidden" in observed:
                self.assertFalse(termios.tcgetattr(slave)[3] & termios.ECHO)
                os.write(master, payload)
            out, err = proc.communicate(timeout=10)
            observed += out + err
            self.assertEqual(termios.tcgetattr(slave), previous)
            self.assertNotIn(payload.rstrip(), observed)
            return proc.returncode, observed
        finally:
            if proc.poll() is None:
                proc.kill()
                proc.wait()
            os.close(master)
            os.close(slave)

    def test_newline_framing_reaches_node_read_pipe_and_returns_safe_status(self):
        code, output = self.run_forward()
        self.assertEqual(code, 0)
        self.assertIn(
            b"R10_ACTIVATION_DIAGNOSTIC_FAIL_ORGANIZATION_APPROVAL_BINDING", output
        )

    def test_child_failures_are_redacted(self):
        for mode in ("early", "failure"):
            with self.subTest(mode=mode):
                code, output = self.run_forward(mode)
                self.assertNotEqual(code, 0)
                self.assertNotIn(b"PRIVATE", output)

    def test_direct_cli_is_inert(self):
        result = subprocess.run(
            [sys.executable, "-B", str(MODULE)], capture_output=True, check=False
        )
        self.assertEqual(result.returncode, 1)
        self.assertEqual(result.stdout, b"")
        self.assertIn(b"no action performed", result.stderr)


if __name__ == "__main__":
    unittest.main()
