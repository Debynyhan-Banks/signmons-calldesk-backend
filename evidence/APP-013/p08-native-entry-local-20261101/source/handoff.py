"""One coordinator-owned child; retains owned receipt until final inventory purge."""
import json
import shutil
import subprocess
from pathlib import Path
from authority import HERE, load, digest
from private_inventory import need, read, reserve

old = load('p08-real-client-binding-local-20261031/source/bound_handoff.py', 'entry_existing_handoff')


class Handoff(old.Handoff):
    def __init__(self, cap, io):
        self.cap, self.io = cap, io
        super().__init__(cap.plan, cap.local_approval, cap.e['target'], cap.root, cap.clock)

    def invoke_child(self, receipt, mode):
        cleanup = mode != '--run'
        deadline = self.cap.spend('child', cleanup)
        before = self._journal()
        request = {'envelopePath': str(self.cap.root / 'envelope.json'), 'receipt': receipt,
                   'childCall': self.cap.coordinator.j['nativeEntry']['calls']['child'],
                   'credentials': self.io.credentials()}
        node = '/Users/debynyhanbanks/.nvm/versions/node/v24.12.0/bin/node'; need(Path(node).is_file(), 'NODE_REQUIRED')
        try:
            result = self.io.child([node, str(HERE / 'native_child.mjs'), mode],
                     input=json.dumps(request, separators=(',', ':')), text=True, capture_output=True,
                     timeout=max(.01, min(30, deadline - self.cap.clock())),
                     env={'PATH': '/usr/bin:/bin:/opt/homebrew/bin', 'LANG': 'C'})
        except subprocess.TimeoutExpired:
            raise old.Stop('CHILD_TIMEOUT') from None
        except BaseException:
            raise old.Stop('CHILD_EXIT_UNKNOWN') from None
        finally:
            request['credentials'] = None
        self.cap.gate(cleanup)
        need(result.returncode == 0 and result.stderr == '' and
             0 < len(result.stdout.encode()) <= 8192, 'CHILD_OUTPUT')
        value = json.loads(result.stdout)
        if mode == '--readback':
            need(digest(read(self.cap.root / 'journal.json')) == digest(before), 'READBACK_JOURNAL_DRIFT')
            need(set(value) == {'app', 'firebase', 'sessions'}, 'READBACK_SHAPE')
            return value, None
        child = self._merge_child(before)
        need(set(value) == {'status', 'authenticated', 'residuals', 'sessionClosed',
                           'liveAuthorization', 'authProofReady'} and
             value['liveAuthorization'] is False and value['authProofReady'] is False and
             type(value['authenticated']) is bool and type(value['sessionClosed']) is bool and
             isinstance(value['residuals'], list), 'CHILD_RESULT_SHAPE')
        return value, child

    def __call__(self, receipt):
        self._request(receipt, '--fixture-auth')  # unchanged exact owned receipt contract
        reserve(self.receipt_path, receipt)
        result, child = self.invoke_child(receipt, '--run')
        need(result['status'] == 'P08_COORDINATOR_AUTHENTICATED_AND_CLOSED' and
             result['authenticated'] is True and result['sessionClosed'] is True and
             result['residuals'] == [] and child['phase'] == 'CLOSEOUT_FINISHED' and
             child['status'] == result['status'] and child['residuals'] == [], 'AUTH_OUTCOME_UNKNOWN')
        return {'status': 'P08_OPERATOR_AUTHENTICATED_AND_CLOSED', 'authenticated': True,
                'sessionsAbsent': True, 'residuals': [], 'liveAuthorization': False, 'authProofReady': False}

    def closeout_only(self):
        result, child = self.invoke_child(read(self.receipt_path), '--closeout')
        return result['status'] in {'P08_COORDINATOR_AUTH_STOPPED_AND_CLOSED',
                 'P08_COORDINATOR_AUTHENTICATED_AND_CLOSED', 'P08_COORDINATOR_AUTH_CLEANUP_VERIFIED'} and \
               result['sessionClosed'] is True and result['residuals'] == [] and \
               child['phase'] == 'CLOSEOUT_FINISHED' and child['residuals'] == []

    def readback(self):
        return self.invoke_child(read(self.receipt_path), '--readback')[0]
