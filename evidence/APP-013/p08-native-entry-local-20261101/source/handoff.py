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

    def _journal(self):
        if not getattr(self, 'in_payment_preflight', False):
            return super()._journal()
        value=read(self.cap.root/'journal.json')
        need(value.get('operationId')==self.plan['operationId'] and value.get('planSha256')==digest(self.plan) and
             value.get('authAttempted') is False, 'PAYMENT_PREFLIGHT_JOURNAL')
        return value

    def preflight_payment(self):
        self.in_payment_preflight=True
        try:return self.invoke_child(None,'--payment-preflight')[0]
        finally:self.in_payment_preflight=False

    def invoke_child(self, receipt, mode):
        cleanup = mode not in ('--run', '--payment-preflight')
        deadline = self.cap.spend('child', cleanup)
        credentials = self.io.credentials()
        before = self._journal()
        request = {'envelopePath': str(self.cap.root / 'envelope.json'), 'receipt': receipt,
                   'childCall': self.cap.coordinator.j['nativeEntry']['calls']['child'],
                   'credentials': credentials}
        credentials = None
        node = '/Users/debynyhanbanks/.nvm/versions/node/v24.12.0/bin/node'; need(Path(node).is_file(), 'NODE_REQUIRED')
        try:
            result = self.io.child([node, str(HERE / 'native_child.mjs'), mode],
                     input=json.dumps(request, separators=(',', ':')), text=True, capture_output=True,
                     timeout=max(.01, min(30 if self.cap.e['version'] == 1 or cleanup else self.cap.times['workEnd'] - self.cap.clock(), deadline - self.cap.clock())),
                     env={'PATH': '/usr/bin:/bin:/opt/homebrew/bin', 'LANG': 'C'})
        except subprocess.TimeoutExpired:
            self._merge_failed_payment_child(before)
            raise old.Stop('CHILD_TIMEOUT') from None
        except BaseException:
            self._merge_failed_payment_child(before)
            raise old.Stop('CHILD_EXIT_UNKNOWN') from None
        finally:
            request['credentials'] = None
        if self.cap.e['version'] == 2:
            self._merge_child(before)  # Preserve intent even if the work deadline passed during the child.
        self.cap.gate(cleanup)
        need(result.returncode == 0 and result.stderr == '' and
             0 < len(result.stdout.encode()) <= 8192, 'CHILD_OUTPUT')
        value = json.loads(result.stdout)
        if mode == '--payment-preflight':
            need(value == {'status':'PAYMENT_PREFLIGHT_QUALIFIED','qualified':True}, 'PAYMENT_PREFLIGHT_RESULT')
            return value, None
        if mode == '--readback':
            if self.cap.e['version'] == 1:
                need(digest(read(self.cap.root / 'journal.json')) == digest(before), 'READBACK_JOURNAL_DRIFT')
            else:
                after = read(self.cap.root / 'journal.json')
                without_counts = lambda v: {k:x for k,x in v.get('payment', {}).items() if k not in {'revision','endpointCalls','secretReads'}}
                need(without_counts(after) == without_counts(before) and after.get('authClient') == before.get('authClient'), 'READBACK_JOURNAL_DRIFT')
                self._merge_child(before)
            need(set(value) == {'app', 'firebase', 'sessions'}, 'READBACK_SHAPE')
            return value, None
        child = self._merge_child(before)
        need(set(value) == {'status', 'authenticated', 'residuals', 'sessionClosed',
                           'liveAuthorization', 'authProofReady'} and
             value['liveAuthorization'] is False and value['authProofReady'] is False and
             type(value['authenticated']) is bool and type(value['sessionClosed']) is bool and
             isinstance(value['residuals'], list), 'CHILD_RESULT_SHAPE')
        return value, child

    def _merge_failed_payment_child(self, before):
        if self.cap.e['version'] != 2:
            return
        try:
            self._merge_child(before)
        except BaseException:
            self.coordinator.j['unknown'].append('PAYMENT_JOURNAL_UNCONFIRMED')

    def _merge_child(self, before):
        if self.cap.e['version'] == 1:
            return super()._merge_child(before)
        after = self._journal()
        payment = after.get('payment')
        if payment is not None:
            fields = {'operationId','scopeSha256','revision','phase','enableIntent','endpointDisabled',
                      'bridgeClosed','outcome','failureCode','endpointCalls','secretReads','residuals'}
            need(set(payment) == fields and payment['operationId'] == self.plan['operationId'] and
                 payment['scopeSha256'] == digest(self.cap.e['payment']) and
                 type(payment['revision']) is int and payment['revision'] > 0 and
                 payment['phase'] in {'PREFLIGHT','QUALIFIED','START','ENABLE_INTENT','ATTENDED','STOPPED','CLOSED','CLOSEOUT_UNKNOWN'} and
                 payment['outcome'] in {'NOT_OBSERVED','APPLICATION_SETTLED'} and
                 (payment['failureCode'] is None or __import__('re').fullmatch(r'PAYMENT_[A-Z_]{1,48}', payment['failureCode'] or '')) and
                 all(type(payment[k]) is bool for k in ('enableIntent','endpointDisabled','bridgeClosed')) and
                 type(payment['endpointCalls']) is int and 0 <= payment['endpointCalls'] <= 14 and
                 type(payment['secretReads']) is int and 0 <= payment['secretReads'] <= self.cap.e['limits']['child'] and
                 isinstance(payment['residuals'], list) and
                 set(payment['residuals']) <= {'PAYMENT_ENDPOINT_UNCONFIRMED','PAYMENT_BRIDGE_UNCONFIRMED'},
                 'PAYMENT_JOURNAL_SHAPE')
            prior = before.get('payment')
            need(prior is None or payment['revision'] >= prior['revision'], 'PAYMENT_JOURNAL_REVISION')
        need(not (self.cap.root / 'journal.json.payment-next').exists(), 'PAYMENT_UNCOMMITTED_INTENT')
        stripped = lambda j: {k:v for k,v in j.items() if k != 'payment'}
        if before.get('authClient') is None and after.get('authClient') is None and getattr(self,'in_payment_preflight',False):
            need(stripped(after) == stripped(before), 'PAYMENT_PREFLIGHT_PARENT_DRIFT')
            self.coordinator.j['payment'] = payment
            return None
        original = self._journal
        try:
            self._journal = lambda: stripped(after)
            child = super()._merge_child(stripped(before))
        finally:
            self._journal = original
        if payment is not None:
            self.coordinator.j['payment'] = payment
        return child

    def __call__(self, receipt):
        self._request(receipt, '--fixture-auth')  # unchanged exact owned receipt contract
        reserve(self.receipt_path, receipt)
        result, child = self.invoke_child(receipt, '--run')
        need(result['status'] == 'P08_COORDINATOR_AUTHENTICATED_AND_CLOSED' and
             result['authenticated'] is True and result['sessionClosed'] is True and
             result['residuals'] == [] and child['phase'] == 'CLOSEOUT_FINISHED' and
             child['status'] == result['status'] and child['residuals'] == [], 'AUTH_OUTCOME_UNKNOWN')
        if self.cap.e['version'] == 2:
            payment = self.coordinator.j.get('payment', {})
            need(payment.get('bridgeClosed') is True and payment.get('endpointDisabled') is True and
                 payment.get('residuals') == [], 'PAYMENT_CONTAINMENT_UNCONFIRMED')
        return {'status': 'P08_OPERATOR_AUTHENTICATED_AND_CLOSED', 'authenticated': True,
                'sessionsAbsent': True, 'residuals': [], 'liveAuthorization': False, 'authProofReady': False}

    def closeout_only(self):
        result, child = self.invoke_child(read(self.receipt_path), '--closeout')
        return result['status'] in {'P08_COORDINATOR_AUTH_STOPPED_AND_CLOSED',
                 'P08_COORDINATOR_AUTHENTICATED_AND_CLOSED', 'P08_COORDINATOR_AUTH_CLEANUP_VERIFIED'} and \
               result['sessionClosed'] is True and result['residuals'] == [] and \
               child['phase'] == 'CLOSEOUT_FINISHED' and child['residuals'] == [] and \
               (self.cap.e['version'] == 1 or not self.coordinator.j.get('payment', {}).get('enableIntent') or \
                self.coordinator.j['payment'].get('endpointDisabled') is True)

    def readback(self):
        return self.invoke_child(read(self.receipt_path), '--readback')[0]
