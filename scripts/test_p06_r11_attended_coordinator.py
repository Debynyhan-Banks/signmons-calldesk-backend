import hashlib
import json
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

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parent))

import p06_r11_attended_coordinator as module


START = 1_790_020_800.0


class FakeClock:
    def __init__(self, value):
        self.value = value
        self.sleeps = []
        self.on_sleep = None

    def now(self):
        return self.value

    def sleep(self, seconds):
        if self.on_sleep is not None:
            self.on_sleep(self.value, seconds)
        self.sleeps.append(seconds)
        self.value += seconds


class FakePorts:
    def __init__(self, *, browser="DONE", fail=None):
        self.browser = browser
        self.fail = fail
        self.calls = []
        self.secret = bytearray(b"FICTIONAL_ADMIN_CANARY")
        self.prompt_count = 0
        self.closed_secrets = []

    def _hit(self, name):
        self.calls.append(name)
        if self.fail == name:
            raise module.CoordinatorStop(name.upper())

    def check(self):
        self._hit("check")

    def reserve(self, _review, _now):
        self._hit("reserve")

    def prompt(self):
        self._hit("prompt")
        self.prompt_count += 1
        return self.secret

    def open_login(self, _secret):
        self._hit("open_login")

    def run(self, _secret, expected_url):
        self._hit("run")
        return expected_url

    def wait_browser(self, _deadline):
        self._hit("wait_browser")
        if self.browser == "INTERRUPT":
            raise KeyboardInterrupt
        return self.browser

    def closeout(self, secret):
        self._hit("closeout")
        self.closed_secrets.append(bytes(secret))

    def emit(self, line):
        self.calls.append("emit:" + line.split(" ", 1)[0])


def review(root=Path("/tmp/fake")):
    return module.Review(
        root=root,
        plan_id="11111111-1111-4111-8111-111111111111",
        origin=module.TARGET_ORIGIN,
        database_login_start=START,
        database_login_end=START + 45 * 60,
        runtime_start=START + 15 * 60,
        runtime_end=START + 30 * 60,
        closeout_end=START + 45 * 60,
    )


class CoordinatorCoreTest(unittest.TestCase):
    def test_early_launch_waits_then_runs_exact_order_with_one_prompt(self):
        clock = FakeClock(START - 5)
        ports = FakePorts()
        clock.on_sleep = lambda value, _seconds: (
            self.assertEqual(ports.calls, []) if value < START else None
        )
        result = module.coordinate(
            review(), ports, now=clock.now, sleep=clock.sleep
        )
        self.assertTrue(result.closeout_verified)
        self.assertEqual(result.reason, "BROWSER_DONE")
        self.assertEqual(ports.prompt_count, 1)
        self.assertEqual(
            ports.calls,
            [
                "check",
                "reserve",
                "prompt",
                "open_login",
                "emit:R10_DATABASE_LOGIN_OPEN",
                "run",
                "emit:R10_ACTIVE_READY",
                "wait_browser",
                "closeout",
                "emit:R12_RUNTIME_CLOSEOUT_VERIFIED",
            ],
        )
        self.assertTrue(clock.sleeps)
        self.assertEqual(clock.value, START + 15 * 60)
        self.assertEqual(ports.secret, bytearray(b"\0" * 22))
        self.assertEqual(ports.closed_secrets, [b"FICTIONAL_ADMIN_CANARY"])

    def test_open_login_failure_waits_for_runtime_and_closes_once(self):
        clock = FakeClock(START)
        ports = FakePorts(fail="open_login")
        result = module.coordinate(
            review(), ports, now=clock.now, sleep=clock.sleep
        )
        self.assertTrue(result.closeout_verified)
        self.assertEqual(result.failed_stage, "OPEN_LOGIN")
        self.assertEqual(ports.calls.count("open_login"), 1)
        self.assertEqual(ports.calls.count("closeout"), 1)
        self.assertNotIn("run", ports.calls)

    def test_run_failure_is_not_retried_and_closes_once(self):
        clock = FakeClock(START)
        ports = FakePorts(fail="run")
        result = module.coordinate(
            review(), ports, now=clock.now, sleep=clock.sleep
        )
        self.assertTrue(result.closeout_verified)
        self.assertEqual(ports.calls.count("run"), 1)
        self.assertEqual(ports.calls.count("closeout"), 1)

    def test_browser_interruption_forces_closeout(self):
        clock = FakeClock(START)
        ports = FakePorts(browser="INTERRUPT")
        result = module.coordinate(
            review(), ports, now=clock.now, sleep=clock.sleep
        )
        self.assertEqual(result.reason, "INTERRUPTED")
        self.assertTrue(result.closeout_verified)
        self.assertEqual(ports.calls.count("closeout"), 1)

    def test_browser_deadline_forces_closeout_without_retry(self):
        clock = FakeClock(START)
        ports = FakePorts(browser="TIMEOUT")
        result = module.coordinate(
            review(), ports, now=clock.now, sleep=clock.sleep
        )
        self.assertEqual(result.reason, "BROWSER_TIMEOUT")
        self.assertTrue(result.closeout_verified)
        self.assertEqual(ports.prompt_count, 1)
        self.assertEqual(ports.calls.count("closeout"), 1)

    def test_closeout_failure_is_unconfirmed_and_secret_is_zeroed(self):
        clock = FakeClock(START)
        ports = FakePorts(fail="closeout")
        result = module.coordinate(
            review(), ports, now=clock.now, sleep=clock.sleep
        )
        self.assertFalse(result.closeout_verified)
        self.assertEqual(result.failed_stage, "CLOSEOUT_UNCONFIRMED")
        self.assertEqual(ports.calls.count("closeout"), 1)
        self.assertEqual(ports.secret, bytearray(b"\0" * 22))

    def test_failed_check_has_no_marker_prompt_or_closeout(self):
        clock = FakeClock(START)
        ports = FakePorts(fail="check")
        result = module.coordinate(
            review(), ports, now=clock.now, sleep=clock.sleep
        )
        self.assertFalse(result.closeout_verified)
        self.assertFalse(result.live_started)
        self.assertEqual(ports.calls, ["check"])
        self.assertEqual(ports.prompt_count, 0)


class LocalReviewTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        base = Path(self.temp.name).resolve()
        self.root = base / "r11-supervised-run-20260922-0900"
        self.repo = base / "repo"
        self.scripts = self.repo / "scripts"
        self.root.mkdir(mode=0o700)
        self.scripts.mkdir(parents=True)
        self.coordinator = self.scripts / "p06_r11_attended_coordinator.py"
        self.coordinator.write_text("coordinator\n", encoding="utf-8")
        (self.scripts / "p06-r10-controller.mjs").write_text(
            "controller\n", encoding="utf-8"
        )
        (self.scripts / "p06-runtime-packet.mjs").write_text(
            "packet\n", encoding="utf-8"
        )
        self.control = self.root / "r10-control.mjs"
        self.control.write_text("control\n", encoding="utf-8")
        self.plan = {
            "planId": "11111111-1111-4111-8111-111111111111",
            "revision": "signmons-calldesk-staging-app013p06enabled18",
            "origin": module.TARGET_ORIGIN,
            "databaseLoginStart": "2026-09-22T13:00:00.000Z",
            "databaseLoginEnd": "2026-09-22T13:45:00.000Z",
            "runtimeStart": "2026-09-22T13:15:00.000Z",
            "runtimeEnd": "2026-09-22T13:30:00.000Z",
            "closeoutEnd": "2026-09-22T13:45:00.000Z",
            "phoneFlowUpperBoundMicros": 500000,
            "phoneAccountCeilingMicros": 4500000,
            "retainedPhoneLiabilityMicros": 4000000,
            "retainedPhoneHoldCount": 8,
            "addressCostMicros": 100000,
            "addressAccountMicros": 600000,
            "addressAccountRequestLimit": 6,
            "addressTenantMicros": 600000,
            "addressTenantRequestLimit": 6,
            "addressSessionMicros": 200000,
            "addressSessionRequestLimit": 2,
            "automaticRetryAllowed": False,
        }
        self.approval = {
            "owner": "Debynyhan Banks",
            "decision": "APPROVED",
            "planId": self.plan["planId"],
            "connectedRuns": 1,
            "automaticRetryAllowed": False,
            **{name: self.plan[name] for name in (
                "databaseLoginStart", "databaseLoginEnd", "runtimeStart",
                "runtimeEnd", "closeoutEnd"
            )},
        }
        self.packet = {
            "envelope": {
                "origin": module.TARGET_ORIGIN,
                "revision": self.plan["revision"],
                "phone": {
                    "flowUpperBoundMicros": 500000,
                    "accountCeilingMicros": 4500000,
                },
                "addressPolicy": {
                    "costMicros": 100000,
                    "account": {"micros": 600000, "requests": 6},
                    "tenant": {"micros": 600000, "requests": 6},
                    "session": {"micros": 200000, "requests": 2},
                },
            }
        }
        self.write_private("r10-review-plan.json", self.plan)
        self.write_private("owner-approval.json", self.approval)
        self.write_private("runtime-packet.json", self.packet)
        self.binding = {
            "planId": self.plan["planId"],
            "backendHead": "1" * 40,
            "files": {
                "r10-control.mjs": self.digest(self.control),
                "scripts/p06-r10-controller.mjs": self.digest(
                    self.scripts / "p06-r10-controller.mjs"
                ),
                "scripts/p06-runtime-packet.mjs": self.digest(
                    self.scripts / "p06-runtime-packet.mjs"
                ),
                "scripts/p06_r11_attended_coordinator.py": self.digest(
                    self.coordinator
                ),
            },
        }
        self.write_private("helper-binding.json", self.binding)
        os.chmod(self.control, 0o600)

    def tearDown(self):
        self.temp.cleanup()

    def write_private(self, name, value):
        path = self.root / name
        path.write_text(json.dumps(value), encoding="utf-8")
        os.chmod(path, 0o600)

    @staticmethod
    def digest(path):
        return hashlib.sha256(path.read_bytes()).hexdigest()

    @staticmethod
    def no_git(_repo, _head):
        return None

    def run_review(self):
        old = module.PRIVATE_PARENT
        module.PRIVATE_PARENT = self.root.parent
        try:
            return module.review_run_directory(
                self.root,
                repo=self.repo,
                coordinator_path=self.coordinator,
                git_review=self.no_git,
                now=START,
            )
        finally:
            module.PRIVATE_PARENT = old

    def test_exact_private_packet_and_approved_ceiling_pass(self):
        result = self.run_review()
        self.assertEqual(result.plan_id, self.plan["planId"])

    def test_existing_marker_refuses_reuse(self):
        self.write_private("coordinator-attempt.json", {"used": True})
        with self.assertRaises(module.CoordinatorStop) as caught:
            self.run_review()
        self.assertEqual(caught.exception.stage, "MARKER_REUSE")

    def test_wrong_ceiling_or_helper_hash_fails_closed(self):
        self.plan["phoneAccountCeilingMicros"] = 3500000
        self.plan["retainedPhoneLiabilityMicros"] = 3000000
        self.plan["retainedPhoneHoldCount"] = 6
        self.packet["envelope"]["phone"]["accountCeilingMicros"] = 3500000
        self.write_private("r10-review-plan.json", self.plan)
        self.write_private("runtime-packet.json", self.packet)
        with self.assertRaises(module.CoordinatorStop) as caught:
            self.run_review()
        self.assertEqual(caught.exception.stage, "PLAN_BINDING")

        self.plan["phoneAccountCeilingMicros"] = 4500000
        self.plan["retainedPhoneLiabilityMicros"] = 4000000
        self.plan["retainedPhoneHoldCount"] = 8
        self.packet["envelope"]["phone"]["accountCeilingMicros"] = 4500000
        self.write_private("r10-review-plan.json", self.plan)
        self.write_private("runtime-packet.json", self.packet)
        self.binding["files"]["r10-control.mjs"] = "0" * 64
        self.write_private("helper-binding.json", self.binding)
        with self.assertRaises(module.CoordinatorStop) as caught:
            self.run_review()
        self.assertEqual(caught.exception.stage, "HELPER_BINDING")

    def test_wrong_address_limits_fail_closed(self):
        self.plan["addressAccountRequestLimit"] = 3
        self.write_private("r10-review-plan.json", self.plan)
        with self.assertRaises(module.CoordinatorStop) as caught:
            self.run_review()
        self.assertEqual(caught.exception.stage, "PLAN_BINDING")

        self.plan["addressAccountRequestLimit"] = 6
        self.write_private("r10-review-plan.json", self.plan)
        self.packet["envelope"]["addressPolicy"]["tenant"]["requests"] = 3
        self.write_private("runtime-packet.json", self.packet)
        with self.assertRaises(module.CoordinatorStop) as caught:
            self.run_review()
        self.assertEqual(caught.exception.stage, "PLAN_BINDING")

    def test_coordinator_reservation_is_private_and_exclusive(self):
        ports = module.ProductionPorts(review(self.root), node=Path(sys.executable))
        ports.reserve(review(self.root), START)
        marker = self.root / "coordinator-attempt.json"
        self.assertEqual(stat.S_IMODE(marker.stat().st_mode), 0o600)
        with self.assertRaises(module.CoordinatorStop) as caught:
            ports.reserve(review(self.root), START)
        self.assertEqual(caught.exception.stage, "COORDINATOR_RESERVATION")


class ChildProtocolTest(unittest.TestCase):
    def test_private_copy_attended_tty_sequence_and_failure_closeout(self):
        """Exercise real prompt/child adapters outside the repository, using local fakes."""
        for failure, signal_value, expected_reason, expected_modes in (
            ("--check", None, "STOPPED_BEFORE_ACTION", ["--check"]),
            (None, "DONE", "BROWSER_DONE", ["--check", "--open-login", "--run", "--closeout"]),
            (None, "STOP", "BROWSER_STOP", ["--check", "--open-login", "--run", "--closeout"]),
            ("--open-login", None, "CHILD_STOP", ["--check", "--open-login", "--closeout"]),
            ("--run", None, "CHILD_STOP", ["--check", "--open-login", "--run", "--closeout"]),
            ("--closeout", "DONE", "CLOSEOUT_UNCONFIRMED", ["--check", "--open-login", "--run", "--closeout"]),
        ):
            with self.subTest(failure=failure, browser=signal_value), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary).resolve()
                private_copy = root / "r11-attended-coordinator.py"
                source = Path(module.__file__).read_text(encoding="utf-8").replace(
                    "REPO = Path(__file__).resolve().parents[1]",
                    "REPO = Path(" + repr(str(module.REPO)) + ")",
                    1,
                )
                private_copy.write_text(source, encoding="utf-8")
                # The child has no database, network or provider dependency. It records
                # modes only and fragments READY so the real complete-line reader runs.
                child = root / "r10-control.mjs"
                child.write_text(
                    "import fs from 'node:fs';\n"
                    "const mode=process.argv[2];\n"
                    "fs.appendFileSync(new URL('./modes.txt',import.meta.url),mode+'\\n');\n"
                    "if(mode==='--check'){ if(mode===" + json.dumps(failure) + ") process.exit(5);"
                    " console.log('R10_CHECK_PASSED_NO_ACTION'); process.exit(0); }\n"
                    "process.stdout.write('REA');\n"
                    "await new Promise(resolve=>setTimeout(resolve,10));\n"
                    "process.stdout.write('DY\\n');\n"
                    "let input='';for await(const chunk of process.stdin) input+=chunk;\n"
                    "if(input!=='FICTIONAL_ADMIN_CANARY\\n') process.exit(4);\n"
                    "if(mode===" + json.dumps(failure) + ") process.exit(5);\n"
                    "const outputs={'--open-login':'R10_DATABASE_LOGIN_OPEN',"
                    "'--run':'R10_ACTIVE_READY " + module.TARGET_ORIGIN + "/customer-intake',"
                    "'--closeout':'R12_RUNTIME_CLOSEOUT_VERIFIED'};\n"
                    "console.log(outputs[mode]);\n",
                    encoding="utf-8",
                )
                runner = root / "run-fixture.py"
                # Only local packet review is injected here; its strict metadata and
                # no-reuse checks have separate tests. CLI, prompt, reservation, child
                # protocol, browser input and closeout all use production code.
                runner.write_text(
                    "import importlib.util,sys,time\n"
                    "from pathlib import Path\n"
                    "s=importlib.util.spec_from_file_location('private_coordinator',sys.argv[1])\n"
                    "m=importlib.util.module_from_spec(s);sys.modules[s.name]=m;s.loader.exec_module(m)\n"
                    "root=Path(sys.argv[2]);now=time.time()\n"
                    "r=m.Review(root,'11111111-1111-4111-8111-111111111111',m.TARGET_ORIGIN,"
                    "now-2,now+900,now-1,now+600,now+900)\n"
                    "m.review_run_directory=lambda supplied: r if supplied==root else None\n"
                    "raise SystemExit(m.main(['--run',str(root)]))\n",
                    encoding="utf-8",
                )
                master, slave = pty.openpty()
                original = termios.tcgetattr(slave)
                process = subprocess.Popen(
                    [sys.executable, "-I", "-B", str(runner), str(private_copy), str(root)],
                    cwd=root,
                    env={"PATH": "/usr/bin:/bin"},
                    stdin=slave,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.STDOUT,
                )
                transcript = bytearray()
                secret_sent = browser_sent = False
                try:
                    deadline = time.monotonic() + 15
                    while process.poll() is None:
                        self.assertLess(time.monotonic(), deadline, "synthetic coordinator did not finish")
                        if select.select([process.stdout], [], [], 0.1)[0]:
                            transcript.extend(os.read(process.stdout.fileno(), 4096))
                        if not secret_sent and b"Private password (input hidden): " in transcript:
                            self.assertFalse(termios.tcgetattr(slave)[3] & termios.ECHO)
                            os.write(master, b"FICTIONAL_ADMIN_CANARY\n")
                            secret_sent = True
                        if not browser_sent and signal_value and b"closeout runs automatically." in transcript:
                            os.write(master, signal_value.encode("ascii") + b"\n")
                            browser_sent = True
                    transcript.extend(process.communicate(timeout=2)[0])
                    while select.select([master], [], [], 0)[0]:
                        transcript.extend(os.read(master, 4096))
                    self.assertEqual(termios.tcgetattr(slave), original)
                    self.assertNotIn(b"FICTIONAL_ADMIN_CANARY", transcript)
                    self.assertEqual((root / "modes.txt").read_text().splitlines(), expected_modes)
                    if failure == "--check":
                        self.assertFalse(secret_sent)
                        self.assertFalse((root / "coordinator-attempt.json").exists())
                        self.assertIn(b"R11_ATTENDED_COORDINATOR_STOPPED_BEFORE_ACTION", transcript)
                        self.assertEqual(process.returncode, 1)
                        continue
                    self.assertTrue(secret_sent)
                    self.assertEqual(transcript.count(b"Private password (input hidden): "), 1)
                    self.assertTrue((root / "coordinator-attempt.json").exists())
                    if expected_reason == "CLOSEOUT_UNCONFIRMED":
                        self.assertIn(b"R11_ATTENDED_COORDINATOR_CLOSEOUT_UNCONFIRMED", transcript)
                        self.assertNotIn(b"R12_RUNTIME_CLOSEOUT_VERIFIED", transcript)
                    else:
                        self.assertIn(b"R12_RUNTIME_CLOSEOUT_VERIFIED", transcript)
                        self.assertIn(("R11_ATTENDED_COORDINATOR_CLOSED_" + expected_reason).encode(), transcript)
                    self.assertEqual(process.returncode, 0 if failure is None else 1)
                finally:
                    if process.poll() is None:
                        process.kill()
                        process.wait()
                    process.stdout.close()
                    os.close(master)
                    os.close(slave)

    def test_private_copy_resolves_hidden_input_module_from_bound_repo(self):
        with tempfile.TemporaryDirectory() as temporary:
            private_copy = Path(temporary) / "r11-attended-coordinator.py"
            source = Path(module.__file__).read_text(encoding="utf-8")
            source = source.replace(
                "REPO = Path(__file__).resolve().parents[1]",
                "REPO = Path(" + repr(str(Path(module.__file__).resolve().parents[1])) + ")",
                1,
            )
            private_copy.write_text(source, encoding="utf-8")
            loader = (
                "import importlib.util,sys;"
                "p=sys.argv[1];"
                "s=importlib.util.spec_from_file_location('private_coordinator',p);"
                "m=importlib.util.module_from_spec(s);"
                "sys.modules[s.name]=m;"
                "s.loader.exec_module(m);"
                "import p06_private_input;"
                "print(p06_private_input.__file__)"
            )
            result = subprocess.run(
                [sys.executable, "-I", "-B", "-c", loader, str(private_copy)],
                cwd=temporary,
                env={"PATH": "/usr/bin:/bin"},
                capture_output=True,
                text=True,
                check=True,
                timeout=20,
            )
            self.assertEqual(
                Path(result.stdout.strip()).resolve(),
                Path(module.__file__).resolve().with_name("p06_private_input.py"),
            )

    def test_secret_uses_ready_pipe_and_never_appears_in_output(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            child = root / "r10-control.mjs"
            child.write_text(
                "import sys\n"
                "mode=sys.argv[1]\n"
                "if mode=='--check': print('R10_CHECK_PASSED_NO_ACTION'); raise SystemExit\n"
                "print('READY',flush=True)\n"
                "secret=sys.stdin.buffer.readline().rstrip(b'\\n')\n"
                "assert secret==b'FICTIONAL_ADMIN_CANARY'\n"
                "out={'--open-login':'R10_DATABASE_LOGIN_OPEN',"
                "'--run':'R10_ACTIVE_READY '+"
                + repr(module.TARGET_ORIGIN + "/customer-intake")
                + ", '--closeout':'R12_RUNTIME_CLOSEOUT_VERIFIED'}[mode]\n"
                "print(out)\n",
                encoding="utf-8",
            )
            fake_review = review(root)
            ports = module.ProductionPorts(fake_review, node=Path(sys.executable))
            secret = bytearray(b"FICTIONAL_ADMIN_CANARY")
            ports.open_login(secret)
            url = ports.run(secret, module.TARGET_ORIGIN + "/customer-intake")
            ports.closeout(secret)
            self.assertEqual(url, module.TARGET_ORIGIN + "/customer-intake")
            self.assertEqual(secret, bytearray(b"FICTIONAL_ADMIN_CANARY"))


if __name__ == "__main__":
    unittest.main()
