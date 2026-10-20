"""Approved one-use attended journey adapter with mandatory closeout."""
import datetime as dt
import hashlib
import json
import os
from pathlib import Path
import signal
import sys
import time
from zoneinfo import ZoneInfo
sys.dont_write_bytecode=True
ROOT=None  # Only a future owner-approved, hash-bound wrapper supplies its root.
REPO=Path(__file__).resolve().parent.parent
sys.path.insert(0,str(REPO/'scripts'))
import p06_r11_attended_coordinator as core
from p06_private_input import private_read

class LaunchRefusal(ValueError):
    def __init__(self, code):
        self.code = code
        super().__init__(code)


def instant(v): return dt.datetime.fromisoformat(v.replace('Z','+00:00')).timestamp()
def validate(root):
    binding=json.loads((root/'helper-binding.json').read_text())
    for name,expected in binding['files'].items():
        p=REPO/name if name.startswith('scripts/') else root/name
        if hashlib.sha256(p.read_bytes()).hexdigest()!=expected: raise LaunchRefusal('PACKAGE_INTEGRITY_MISMATCH')
    p=json.loads((root/'r10-review-plan.json').read_text())
    return core.Review(root,p['planId'],p['origin'],*[instant(p[k]) for k in ['databaseLoginStart','databaseLoginEnd','runtimeStart','runtimeEnd','closeoutEnd']])

class JourneyPorts(core.ProductionPorts):
    def prompt(self):
        self.emit('Enter the saved CHILD neondb_owner password. Input stays hidden.')
        return private_read(0,self.output_fd,timeout=120)
    def closeout(self,secret):
        if not (self.review.root/'login-attempt.json').exists(): return
        super().closeout(secret)
    def emit(self,line):
        if line=='R12_RUNTIME_CLOSEOUT_VERIFIED' and not (self.review.root/'closeout-result.json').exists(): return
        super().emit(line)

def reserve_launch(review, now):
    # Reserve before Cloud reads/private input. Concurrent/consumed commands never act.
    if now < review.database_login_start: raise LaunchRefusal('WINDOW_NOT_OPEN')
    if now >= review.runtime_start-180: raise LaunchRefusal('START_CUTOFF_PASSED')
    if any((review.root/n).exists() for n in core.ACTION_MARKERS) or list(review.root.glob('*stop*.json')): raise LaunchRefusal('PACKAGE_ALREADY_USED')
    path=review.root/'launcher-attempt.json'
    try:
        fd=os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
    except FileExistsError:
        raise LaunchRefusal('PACKAGE_ALREADY_USED') from None
    with os.fdopen(fd,'w') as f:
        json.dump({'planId':review.plan_id,'at':now,'status':'RESERVED_DO_NOT_RETRY'},f);f.flush();os.fsync(f.fileno())

def report_prelaunch_refusal(root, stage, error, now, review=None):
    # Only fixed categories are persisted. Never serialize an exception or raw inputs.
    known = {'PACKAGE_INTEGRITY_MISMATCH', 'WINDOW_NOT_OPEN',
             'START_CUTOFF_PASSED', 'PACKAGE_ALREADY_USED'}
    if isinstance(error, LaunchRefusal) and error.code in known:
        code = error.code
    elif isinstance(error, KeyboardInterrupt):
        code = 'INTERRUPTED'
    elif isinstance(error, OSError):
        code = 'LOCAL_FILE_ERROR'
    elif stage == 'VALIDATE':
        code = 'PACKAGE_VALIDATION_FAILED'
    else:
        code = 'RESERVATION_UNCONFIRMED'
    record = {'status': 'R11_PRELAUNCH_' + code, 'stage': stage,
              'atUtc': dt.datetime.fromtimestamp(now,dt.timezone.utc).isoformat(),
              'externalActionsStartedByThisInvocation': False,
              'automaticRetryAllowed': False}
    eastern = ZoneInfo('America/New_York')
    print(record['status'], flush=True)
    print('Checked at ' + dt.datetime.fromtimestamp(now,eastern).strftime('%Y-%m-%d %I:%M:%S %p %Z') + '.', flush=True)
    if review is not None:
        for key,stamp in [('startEastern',review.database_login_start),
                          ('cutoffEastern',review.runtime_start-180)]:
            record[key] = dt.datetime.fromtimestamp(stamp,eastern).strftime('%Y-%m-%d %I:%M:%S %p %Z')
        print('Approved start: ' + record['startEastern'] + '; strictly before ' + record['cutoffEastern'] + '.',flush=True)
    print('This invocation stopped before external actions. Another invocation, if any, is not reconciled here.',flush=True)
    try:
        fd=os.open(root/'prelaunch-stop.json',os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
        with os.fdopen(fd,'w') as f:
            json.dump(record,f);f.flush();os.fsync(f.fileno())
        print('Sanitized prelaunch stop receipt saved.',flush=True)
    except FileExistsError:
        print('Existing stop receipt preserved.',flush=True)
    except OSError:
        print('Stop receipt could not be saved. Keep these status lines.',flush=True)
    print('Do not rerun this package.',flush=True)


def main(root):
    global ROOT
    ROOT=Path(root)
    if sys.argv[1:]!=['--run'] or not os.isatty(0):
        print('Attended terminal and --run required.');return 1
    for sig in (signal.SIGHUP,signal.SIGTERM): signal.signal(sig,lambda *_: (_ for _ in ()).throw(KeyboardInterrupt()))
    stage='VALIDATE';review=None
    try:
        review=validate(ROOT)
        stage='RESERVE'
        reserve_launch(review,time.time())
    except BaseException as error:
        report_prelaunch_refusal(ROOT,stage,error,time.time(),review)
        return 1
    try:
        print('One approved browser journey. Wait for R10_ACTIVE_READY, then open its link once.',flush=True)
        print('Keep Terminal open through automatic closeout. Do not run this command again.',flush=True)
        result=core.coordinate(review,JourneyPorts(review))
        mutated=(ROOT/'login-attempt.json').exists()
        ready=(ROOT/'r10-run-result.json').exists()
        closed=(ROOT/'closeout-result.json').exists() and result.closeout_verified
        record={'planId':review.plan_id,'ready':ready,'possibleMutation':mutated,'closeoutVerified':closed,'failedStage':result.failed_stage,'reason':result.reason,'at':time.time(),'automaticRetryAllowed':False}
        fd=os.open(ROOT/'readiness-result.json',os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
        with os.fdopen(fd,'w') as f:json.dump(record,f);f.flush();os.fsync(f.fileno())
        if ready and closed and result.failed_stage is None and result.reason == "BROWSER_DONE":
            print('R11_ATTENDED_JOURNEY_CLOSED_BROWSER_DONE',flush=True);return 0
        print('R11_ATTENDED_JOURNEY_CLOSED_' + result.reason if closed else 'R11_READINESS_CLOSEOUT_UNCONFIRMED' if mutated else 'R11_READINESS_STOPPED_BEFORE_MUTATION',flush=True)
    except BaseException:
        print('R11_POST_LAUNCH_RESULT_UNCONFIRMED',flush=True)
    print('Do not rerun. Share only these final status lines.',flush=True);return 1
if __name__=='__main__':
    print('Template only. A fresh approved hash-bound wrapper is required; no action taken.')
    sys.exit(2)
