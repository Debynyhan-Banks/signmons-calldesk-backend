import importlib.util
import json
import os
import pty
import select
import signal
import subprocess
import sys
import tempfile
import termios
import time
import unittest
from pathlib import Path


MODULE = Path(__file__).with_name("p06_private_participant.py")
SPEC = importlib.util.spec_from_file_location("p06_private_participant", MODULE)
PARTICIPANT = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(PARTICIPANT)
PHONE = b"+12165550123"
NODE = "/Users/debynyhanbanks/.nvm/versions/node/v24.12.0/bin/node"


DUMMY = r'''
import os, stat, sys, time
mode = sys.argv[1]
if mode == "partial":
    os.write(1, b"REA")
    time.sleep(2)
    raise SystemExit(1)
if mode == "wrong-ready":
    os.write(1, b"NOT_READY\n")
    raise SystemExit(1)
if mode == "preflight-refusal":
    os.write(2, b"PARTICIPANT_BINDING_REFUSED_NO_SMS:LOCAL_PREFLIGHT\n")
    raise SystemExit(1)
if not stat.S_ISFIFO(os.fstat(0).st_mode):
    os.write(2, b"PARTICIPANT_BINDING_REFUSED_NO_SMS:INPUT_READY\n")
    raise SystemExit(1)
os.write(1, b"READY\n")
value = sys.stdin.buffer.read()
if value == b"ABORT\n":
    os.write(1, b"PARTICIPANT_BINDING_ABORTED_NO_SMS\n")
    raise SystemExit(0)
if mode == "post-refusal":
    os.write(2, b"PARTICIPANT_BINDING_REFUSED_NO_SMS:INPUT_FORMAT\n")
    raise SystemExit(1)
if value != b"+12165550123\n":
    os.write(2, b"PARTICIPANT_BINDING_REFUSED_NO_SMS:INPUT_PIPE\n")
    raise SystemExit(1)
os.write(1, b"PARTICIPANT_BOUND_NO_SMS\n")
'''


DRIVER = r'''
import importlib.util, sys
spec=importlib.util.spec_from_file_location("participant",sys.argv[1])
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
try:
    module.forward_participant(
        [sys.argv[2],sys.argv[3]]+([] if sys.argv[4]=="-" else [sys.argv[4]]),0,1,
        input_timeout=float(sys.argv[5]),ready_timeout=float(sys.argv[6]),child_timeout=1)
    print("HANDOFF_OK")
except module.BindingRefused as error:
    print("REFUSED:"+(error.stage or "NONE"),file=sys.stderr)
    raise SystemExit(2)
except KeyboardInterrupt:
    raise SystemExit(130)
'''


class PrivateParticipantTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(
            prefix="p06-participant-input-", dir="/private/tmp"
        )
        self.child = Path(self.temp.name) / "child.py"
        self.child.write_text(DUMMY)
        self.node_child = Path(self.temp.name) / "child.mjs"
        self.node_child.write_text(
            '''
import {readPipe} from "file:///Users/debynyhanbanks/Web%20Projects/signmons-backend-r08-recovery/scripts/p06_backup_guards.mjs";
let timer;
const budget={race:async promise=>{try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error("timeout")),1000)})])}finally{clearTimeout(timer)}}};
process.stdout.write("READY\\n");
try {
  const value=await readPipe(process.stdin,budget);
  if(value==="ABORT") {
    process.stdout.write("PARTICIPANT_BINDING_ABORTED_NO_SMS\\n");
    process.exit(0);
  }
  if(value!=="+12165550123") throw Error("wrong input");
  process.stdout.write("PARTICIPANT_BOUND_NO_SMS\\n");
} catch {
  process.stderr.write("PARTICIPANT_BINDING_REFUSED_NO_SMS:INPUT_PIPE\\n");
  process.exitCode=1;
}
'''
        )

    def tearDown(self):
        self.temp.cleanup()

    def run_tty(
        self,
        mode,
        payload=None,
        terminate=False,
        input_timeout=1,
        ready_timeout=1,
        executable=None,
        child=None,
    ):
        master, slave = pty.openpty()
        original = termios.tcgetattr(slave)
        process = subprocess.Popen(
            [
                sys.executable,
                "-B",
                "-c",
                DRIVER,
                str(MODULE),
                executable or sys.executable,
                str(child or self.child),
                mode,
                str(input_timeout),
                str(ready_timeout),
            ],
            stdin=slave,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
        observed = b""
        try:
            deadline = time.monotonic() + 4
            while (
                b"input hidden" not in observed
                and process.poll() is None
                and time.monotonic() < deadline
            ):
                if select.select([process.stdout], [], [], 0.05)[0]:
                    observed += os.read(process.stdout.fileno(), 4096)
            if terminate and process.poll() is None:
                process.send_signal(signal.SIGTERM)
            elif payload is not None and process.poll() is None:
                self.assertFalse(termios.tcgetattr(slave)[3] & termios.ECHO)
                os.write(master, payload)
            stdout, stderr = process.communicate(timeout=5)
            observed += stdout
            echoed = b""
            while select.select([master], [], [], 0)[0]:
                try:
                    echoed += os.read(master, 4096)
                except OSError:
                    break
            self.assertEqual(termios.tcgetattr(slave), original)
            self.assertNotIn(PHONE, observed + stderr + echoed)
            return process.returncode, observed, stderr
        finally:
            if process.poll() is None:
                process.kill()
                process.wait()
            os.close(master)
            os.close(slave)

    def test_positive_tty_to_fifo_handoff(self):
        code, stdout, stderr = self.run_tty("success", PHONE + b"\n")
        self.assertEqual(code, 0)
        self.assertIn(b"HANDOFF_OK", stdout)
        self.assertEqual(stderr, b"")

    def test_positive_handoff_uses_production_pipe_reader(self):
        code, stdout, stderr = self.run_tty(
            "-", PHONE + b"\n", executable=NODE, child=self.node_child
        )
        self.assertEqual(code, 0)
        self.assertIn(b"HANDOFF_OK", stdout)
        self.assertEqual(stderr, b"")

    def test_terminal_bracketed_paste_is_unwrapped_before_pipe(self):
        payload = b"\x1b[200~" + PHONE + b"\x1b[201~\n"
        code, stdout, stderr = self.run_tty("success", payload)
        self.assertEqual(code, 0)
        self.assertIn(b"HANDOFF_OK", stdout)
        self.assertEqual(stderr, b"")

    def test_common_us_presentation_is_canonicalized_before_pipe(self):
        code, stdout, stderr = self.run_tty(
            "success", b" +1 (216) 555-0123 \n"
        )
        self.assertEqual(code, 0)
        self.assertIn(b"HANDOFF_OK", stdout)
        self.assertEqual(stderr, b"")

    def test_invalid_phone_refuses_before_child_acceptance(self):
        code, stdout, stderr = self.run_tty("success", b"12165550123\n")
        self.assertEqual(code, 2)
        self.assertNotIn(b"HANDOFF_OK", stdout)
        self.assertEqual(stderr, b"REFUSED:INPUT_FORMAT\n")

    def test_child_fixed_stage_is_preserved(self):
        code, _stdout, stderr = self.run_tty("post-refusal", PHONE + b"\n")
        self.assertEqual(code, 2)
        self.assertEqual(stderr, b"REFUSED:INPUT_FORMAT\n")

    def test_wrong_and_partial_ready_never_prompt(self):
        for mode in ("wrong-ready", "partial", "preflight-refusal"):
            with self.subTest(mode=mode):
                code, stdout, stderr = self.run_tty(
                    mode, ready_timeout=0.15, input_timeout=0.15
                )
                self.assertEqual(code, 2)
                self.assertNotIn(b"input hidden", stdout)
                expected = (
                    b"REFUSED:LOCAL_PREFLIGHT\n"
                    if mode == "preflight-refusal"
                    else b"REFUSED:NONE\n"
                )
                self.assertEqual(stderr, expected)

    def test_signal_cancellation_restores_terminal(self):
        code, stdout, stderr = self.run_tty("success", terminate=True)
        self.assertNotEqual(code, 0)
        self.assertIn(b"input hidden", stdout)
        self.assertNotIn(b"HANDOFF_OK", stdout)
        self.assertEqual(stderr, b"")

    def test_non_tty_refuses_without_starting_child(self):
        read_fd, write_fd = os.pipe()
        try:
            with self.assertRaises(PARTICIPANT.BindingRefused):
                PARTICIPANT.forward_participant(
                    [sys.executable, str(self.child), "success"], read_fd, write_fd
                )
        finally:
            os.close(read_fd)
            os.close(write_fd)

    def test_local_stop_record_is_fixed_private_and_phone_free(self):
        PARTICIPANT._record_local_stop("INPUT_FORMAT", self.temp.name)
        records = list(Path(self.temp.name).glob("local-input-stop-*.json"))
        self.assertEqual(len(records), 1)
        self.assertEqual(records[0].stat().st_mode & 0o777, 0o600)
        record = json.loads(records[0].read_text())
        self.assertEqual(
            set(record), {"recordKind", "stage", "noSms", "checkedAt"}
        )
        self.assertEqual(record["recordKind"], "local-input-stop")
        self.assertEqual(record["stage"], "INPUT_FORMAT")
        self.assertTrue(record["noSms"])
        self.assertNotIn(PHONE.decode(), records[0].read_text())


if __name__ == "__main__":
    unittest.main()
