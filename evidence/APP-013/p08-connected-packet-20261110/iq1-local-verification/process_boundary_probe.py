"""Local-only IQ1 prerequisite probe; no SDK, credentials or provider calls.

The synthetic descendant is finite and closes its inherited output handles.
Its completion marker proves fixture completion, not provider containment.
"""
import json
import os
from pathlib import Path
import sys
import tempfile
import time
import uuid

SOURCE = Path(__file__).resolve().parents[2] / 'p08-https-output-category-local-20261029/source'
sys.path.insert(0, str(SOURCE))
import qualification_launch as q


def probe():
    with tempfile.TemporaryDirectory(prefix='iq1-process-proof-') as directory:
        done = Path(directory) / 'done'
        # A detached descendant exits itself after a bounded delay. No PID is
        # adopted or signalled by this probe; only the transport owns its child.
        descendant = ('import time,pathlib;time.sleep(2);'
                      'pathlib.Path(' + repr(str(done)) + ').write_text("done")')
        parent = ('import subprocess,sys;'
                  'subprocess.Popen([sys.executable,"-I","-B","-c",'
                  + repr(descendant) + '],start_new_session=True,'
                  'stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,'
                  'stderr=subprocess.DEVNULL);print("{}",flush=True)')
        io = q.NativeIO(time.time, str(uuid.uuid4()))
        raw = io._owned_run([sys.executable, '-I', '-B', '-c', parent],
                            {'PATH': '/usr/bin:/bin'}, time.time() + 8)
        finished_at_return = done.exists()
        closed = io.close(time.time() + 3)
        deadline = time.monotonic() + 5
        while not done.exists() and time.monotonic() < deadline:
            time.sleep(.02)
        result = {
            'test': 'IQ1_EXISTING_TRANSPORT_DETACHED_DESCENDANT',
            'providerCalls': 0, 'credentialReads': 0,
            'transportReturnedSuccess': raw.strip() == b'{}',
            'transportReportedClosed': closed,
            'descendantFinishedWhenTransportReturned': finished_at_return,
            'finiteFixtureCompletionObserved': done.exists(),
            'conclusion': 'GROUP_CLOSURE_DOES_NOT_PROVE_DESCENDANT_CLOSURE',
        }
        assert result['transportReturnedSuccess'] and closed
        assert not finished_at_return and done.exists()
        return result


if __name__ == '__main__':
    print(json.dumps(probe(), sort_keys=True))
