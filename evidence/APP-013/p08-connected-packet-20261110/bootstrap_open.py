"""Open the existing attended bridge once; private URLs never enter argv or output.

The CLI accepts only the approved native root. It is an operator step while the
native child runs, not an entry/approval/payment launcher. Tests may inject a
loopback-only presenter only for a PROOF_ONLY envelope.
"""
import datetime
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys
import time

HERE = Path(__file__).resolve().parent
NATIVE = HERE.parent / 'p08-native-entry-local-20261101/source'
sys.path.insert(0, str(NATIVE))
import authority as a
from private_inventory import Stop, need, inspect, reserve

SOURCE = 'p08-connected-packet-20261110/bootstrap_open.py'
MARKER = 'payment-bootstrap-open-attempt.json'
MAX_BYTES = 65536
# The script is constant. Neither the bearer URL nor any input is interpolated.
# Chrome's installed scripting dictionary defines Window(mode) and tab.URL.
# A dedicated incognito window avoids adding this bearer URL to normal history.
CHROME_SCRIPT = r'''ObjC.import('Foundation');
const bytes = $.NSFileHandle.fileHandleWithStandardInput.readDataToEndOfFile;
const url = ObjC.unwrap($.NSString.alloc.initWithDataEncoding(bytes, $.NSUTF8StringEncoding));
if (!/^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}\/s\/[0-9a-f]{64}$/.test(url)) throw Error('REFUSED');
const chrome = Application('com.google.Chrome');
const ownedWindow = chrome.Window({mode:'incognito'});
chrome.windows.push(ownedWindow);
ownedWindow.tabs[0].url = url;
chrome.activate();
void 0;'''


def root_identity(root, operation):
    root = inspect(root, operation)
    st = root.lstat()
    need(st.st_uid == os.getuid(), 'BOOTSTRAP_OWNER')
    for path in root.iterdir():
        need(path.lstat().st_uid == os.getuid(), 'BOOTSTRAP_OWNER')
    return st.st_dev, st.st_ino


def private_read(root, name):
    """Reject replaced links/files and bound input before JSON decoding."""
    path = root / name
    before = path.lstat()
    need(stat.S_ISREG(before.st_mode) and stat.S_IMODE(before.st_mode) == 0o600 and
         before.st_uid == os.getuid() and before.st_nlink == 1 and
         0 < before.st_size <= MAX_BYTES, 'BOOTSTRAP_PRIVATE_FILE')
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        opened = os.fstat(fd)
        need((opened.st_dev, opened.st_ino) == (before.st_dev, before.st_ino),
             'BOOTSTRAP_PRIVATE_REPLACED')
        raw = os.read(fd, MAX_BYTES + 1)
        need(0 < len(raw) <= MAX_BYTES and not os.read(fd, 1), 'BOOTSTRAP_PRIVATE_SIZE')
        after = path.lstat()
        need((after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns) ==
             (opened.st_dev, opened.st_ino, opened.st_size, opened.st_mtime_ns),
             'BOOTSTRAP_PRIVATE_REPLACED')
        return json.loads(raw)
    finally:
        os.close(fd)


def validate_url(value):
    need(isinstance(value, str), 'BOOTSTRAP_URL')
    match = re.fullmatch(r'http://127\.0\.0\.1:([1-9][0-9]{0,4})/s/[0-9a-f]{64}', value)
    need(match is not None and 1 <= int(match[1]) <= 65535, 'BOOTSTRAP_URL')
    return value


def attended_state(cap, identity):
    operation = cap.plan['operationId']
    need(root_identity(cap.root, operation) == identity, 'BOOTSTRAP_ROOT_REPLACED')
    cap.gate()
    # The payment phase may finish before the broader native work window.
    end = datetime.datetime.fromisoformat(cap.e['payment']['workEnd'].replace('Z', '+00:00')).timestamp()
    need(cap.last < end, 'BOOTSTRAP_PAYMENT_DEADLINE')
    need(a.digest(private_read(cap.root, 'envelope.json')) == cap.envelope_hash,
         'BOOTSTRAP_ENVELOPE_CHANGED')
    need(private_read(cap.root, 'attempt.json') ==
         {'operationId': operation, 'planSha256': a.digest(cap.plan)}, 'BOOTSTRAP_ATTEMPT')
    j = private_read(cap.root, 'journal.json')
    p = j.get('payment', {})
    need(j.get('operationId') == operation and j.get('planSha256') == a.digest(cap.plan) and
         j.get('nativeEntry', {}).get('envelopeSha256') == cap.envelope_hash and
         p.get('operationId') == operation and p.get('scopeSha256') == a.digest(cap.e['payment']),
         'BOOTSTRAP_JOURNAL_BINDING')
    need(p.get('phase') == 'ATTENDED' and p.get('bridgeClosed') is False and
         p.get('enableIntent') is True and p.get('endpointDisabled') is False,
         'BOOTSTRAP_NOT_ATTENDED')
    need(not any((cap.root / name).exists() for name in
                 ('journal-next.json', 'journal.json.auth-next', 'journal.json.payment-next',
                  'closeout.json', 'independent-closeout.json', 'result.json', 'work-result.json')),
         'BOOTSTRAP_CLOSED_OR_PENDING')
    boot = private_read(cap.root, 'payment-bootstrap.json')
    need(isinstance(boot, dict) and set(boot) == {'operationId', 'bootstrapUrl'} and
         boot['operationId'] == operation, 'BOOTSTRAP_OPERATION')
    return validate_url(boot['bootstrapUrl']), end


def open_chrome(url, timeout):
    """No shell, URL argv, inherited output, logging, or automatic retry."""
    try:
        result = subprocess.run(['/usr/bin/osascript', '-l', 'JavaScript', '-e', CHROME_SCRIPT],
                                input=url.encode('ascii'), stdout=subprocess.DEVNULL,
                                stderr=subprocess.DEVNULL, timeout=timeout, check=False)
        need(result.returncode == 0, 'BOOTSTRAP_CHROME_UNCONFIRMED')
    except BaseException:
        raise Stop('BOOTSTRAP_CHROME_UNCONFIRMED') from None


def open_bootstrap(root, *, presenter=None, clock=time.time, read_commit=a.committed):
    root = Path(root)
    match = re.fullmatch(r'/private/tmp/p08-coordinator-([0-9a-f-]{36})', str(root))
    need(match is not None, 'BOOTSTRAP_ROOT')
    identity = root_identity(root, match[1])
    envelope = private_read(root, 'envelope.json')
    # continuing=True uses the existing attempt and work deadline, never a new
    # launch cutoff. The actual validator checks the entire approved source graph.
    cap = a.Capability(envelope, root, mode='run', continuing=True,
                       clock=clock, read_commit=read_commit)
    need(cap.e['version'] == 2 and 'purpose' not in cap.e, 'BOOTSTRAP_PAYMENT_ONLY')
    manifest = json.loads((a.HERE / 'source-manifest.json').read_text())
    need(manifest['lockedSources'].get(SOURCE) == a.digest(Path(__file__).read_bytes()),
         'BOOTSTRAP_SOURCE_BINDING')
    need((cap.external and presenter is None) or (not cap.external and callable(presenter)),
         'BOOTSTRAP_PRESENTER_AUTHORITY')
    url, end = attended_state(cap, identity)
    # Persist before dispatch. An uncertain opener result is consumed, not retried.
    reserve(root / MARKER, {'status': 'BROWSER_OPEN_ATTEMPTED',
                           'operationId': cap.plan['operationId'],
                           'envelopeSha256': cap.envelope_hash,
                           'paymentScopeSha256': a.digest(cap.e['payment']),
                           'sourceCommit': cap.e['sourceCommit']})
    current, _ = attended_state(cap, identity)
    need(current == url, 'BOOTSTRAP_CHANGED')
    cap.gate()
    remaining = min(10, end - cap.last)
    need(remaining > 0, 'BOOTSTRAP_PAYMENT_DEADLINE')
    try:
        (open_chrome if presenter is None else presenter)(url, remaining)
    except BaseException:
        raise Stop('BOOTSTRAP_OPEN_UNCONFIRMED') from None
    return {'status': 'BROWSER_OPEN_DISPATCHED', 'operationId': cap.plan['operationId']}


def main(argv=None):
    try:
        argv = sys.argv[1:] if argv is None else argv
        need(len(argv) == 1, 'BOOTSTRAP_ARGUMENTS')
        result = open_bootstrap(argv[0])
        print(json.dumps(result, sort_keys=True))
        return 0
    except BaseException:
        # Arbitrary OS/JSON/AppleEvent exceptions must not disclose private data.
        print('{"status":"BROWSER_OPEN_REFUSED_OR_UNCONFIRMED"}')
        return 2


if __name__ == '__main__':
    raise SystemExit(main())
