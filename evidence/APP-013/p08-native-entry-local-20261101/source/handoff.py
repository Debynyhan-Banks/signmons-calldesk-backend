"""One coordinator-owned child; retains owned receipt until final inventory purge."""
import json
import shutil
import subprocess
from pathlib import Path
from authority import HERE, load, digest
from private_inventory import need, read, reserve

old = load('p08-real-client-binding-local-20261031/source/bound_handoff.py', 'entry_existing_handoff')

CHILD_FAILURE_STAGES = frozenset({
    'INPUT', 'AUTHORITY', 'RESERVATION', 'PAYMENT_PREFLIGHT',
    'CLIENT_BINDING', 'AUTH_SEQUENCE', 'READBACK', 'CLOSEOUT',
    'RESULT', 'UNKNOWN',
})
CHILD_FAILURE_CODES = frozenset({
    'UNCLASSIFIED', 'CHILD_INPUT', 'CHILD_INPUT_BOUNDS', 'CHILD_MODE',
    'ENVELOPE_BOUNDS', 'CHILD_OUTER_BINDING', 'ENVELOPE_CHANGED', 'OUTER_CAPABILITY_REQUIRED',
    'OUTER_DEADLINE', 'CLOCK_ROLLBACK', 'CLOSEOUT_ONLY', 'CHILD_CALL_LIMIT',
    'CHILD_RESERVATION', 'EEXIST', 'SOURCE_DRIFT', 'SOURCE_CONTRACT',
    'EXTRACTION_DRIFT', 'LOCAL_ONLY', 'BUSINESS_SCOPE', 'LOCAL_APPROVAL',
    'TARGET_SCOPE', 'OWNED_KEY_SCOPE', 'MODE', 'JOURNAL_PATH',
    'JOURNAL_PRIVATE', 'JOURNAL_OWNERSHIP', 'RUNTIME_SCOPE', 'WINDOW_FORMAT',
    'WINDOW_ORDER', 'CLOCK_OR_SIGNAL', 'START_CUTOFF', 'CAPABILITY_REQUIRED',
    'OPERATION_DEADLINE', 'INTERRUPTED', 'NATIVE_REQUIRES_EXTERNAL_AUTHORITY', 'MEMORY_CREDENTIALS',
    'PRIVATE_BINDING_SCOPE', 'INJECTED_CLIENTS_REQUIRED', 'OWNER_SCOPE', 'OWNER_DRIFT',
    'OWNER_OVERRIDE', 'OWNER_AUTHORITY_DRIFT', 'DATABASE_SCOPE', 'DATABASE_CLIENT_REQUIRED',
    'TLS_REQUIRED', 'DATABASE_PREFLIGHT', 'DATABASE_SESSION_UNCONFIRMED', 'NATIVE_IO_TIMEOUT',
    'SESSIONS_REMAIN', 'SESSION_CLOSEOUT_RESERVED', 'SESSION_SCOPE', 'PROBE_TLS',
    'SESSION_OUTPUT', 'CLIENT_CONTRACT', 'JOURNAL_CONCURRENT_DRIFT', 'AUTH_JOURNAL_REQUIRED',
    'CLOSEOUT_RESERVED', 'REVOCATION_READBACK', 'APP_VERSION_DRIFT', 'PRIOR_CLOSEOUT_UNCONFIRMED',
    'APPLICATION_DRIFT', 'IDENTITY_DRIFT', 'CLAIMS_DRIFT', 'PAYMENT_PREFLIGHT_VERSION',
    'PAYMENT_SECRET_REFUSED', 'PAYMENT_SECRET_SHAPE', 'PAYMENT_TEST_KEY_REQUIRED', 'PAYMENT_SECRET_NO_RETRY',
    'PAYMENT_SECRET_BUDGET', 'PAYMENT_ENDPOINT_REFUSED', 'PAYMENT_ENDPOINT_DRIFT', 'PAYMENT_OUTPUT_LIMIT',
    'PAYMENT_IO_TIMEOUT', 'PAYMENT_DEADLINE', 'PAYMENT_PORT_CLOSED', 'PAYMENT_ENDPOINT_UNCONFIRMED',
    'PAYMENT_PROOF_PRESENTER_REQUIRED', 'CHILD_RESULT',
})
CHILD_MODES = frozenset({'--run', '--closeout', '--readback', '--payment-preflight'})
PROCESS_OUTCOMES = frozenset({'NOT_STARTED', 'RETURNED', 'REFUSED', 'TIMEOUT', 'EXIT_UNKNOWN'})
JOURNAL_OUTCOMES = frozenset({'NOT_ATTEMPTED', 'ACCEPTED', 'ABSENT', 'REJECTED'})
PARENT_CODES = frozenset({'NONE', 'CHILD_OUTPUT', 'CHILD_TIMEOUT', 'CHILD_EXIT_UNKNOWN',
                          'CHILD_RESULT_REFUSED', 'CHILD_DEADLINE', 'CHILD_INTERRUPTED'})


def child_output(result):
    """Parse bounded process output without retaining raw stdout, stderr or exception text."""
    def unique(pairs):
        value = {}
        for key, item in pairs:
            if key in value:
                raise ValueError()
            value[key] = item
        return value
    def nonfinite(_):
        raise ValueError()
    try:
        if (type(result.returncode) is not int or type(result.stdout) is not str or
                result.stderr != '' or not 0 < len(result.stdout.encode('utf-8')) <= 8192):
            return None, None
        value = json.loads(result.stdout, object_pairs_hook=unique, parse_constant=nonfinite)
        if type(value) is not dict:
            return None, None
        if value.get('status') == 'NATIVE_CHILD_REFUSED_OR_UNCONFIRMED':
            if (result.returncode != 2 or set(value) != {'status', 'stage', 'code'} or
                    type(value['stage']) is not str or value['stage'] not in CHILD_FAILURE_STAGES or
                    type(value['code']) is not str or value['code'] not in CHILD_FAILURE_CODES):
                return None, None
            return None, {'stage': value['stage'], 'code': value['code']}
        return (value, None) if result.returncode == 0 else (None, None)
    except (ValueError, TypeError, UnicodeError, AttributeError, RecursionError):
        return None, None



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

    def _record_child_observation(self, observation):
        # Parent-owned metadata only. A failed merge never adopts untrusted child intent.
        native = self.cap.coordinator.j['nativeEntry']
        limit = self.cap.e['limits']['child']
        count = native['calls']['child']
        need(type(limit) is int and 1 <= limit <= 8 and type(count) is int and
             1 <= count <= limit, 'CHILD_OBSERVATION_SCOPE')
        fields = {'childCall', 'mode', 'stage', 'code', 'processOutcome', 'journalMerge'}
        previous = native.get('childObservations', [])
        need(type(previous) is list and len(previous) < limit, 'CHILD_OBSERVATION_LIMIT')
        last = 0
        for item in [*previous, observation]:
            need(type(item) is dict and set(item) == fields and
                 type(item['childCall']) is int and last < item['childCall'] <= count and
                 type(item['mode']) is str and item['mode'] in CHILD_MODES and
                 type(item['stage']) is str and item['stage'] in CHILD_FAILURE_STAGES and
                 type(item['code']) is str and item['code'] in CHILD_FAILURE_CODES | PARENT_CODES and
                 type(item['processOutcome']) is str and item['processOutcome'] in PROCESS_OUTCOMES and
                 type(item['journalMerge']) is str and item['journalMerge'] in JOURNAL_OUTCOMES,
                 'CHILD_OBSERVATION_SHAPE')
            last = item['childCall']
        need(observation['childCall'] == count, 'CHILD_OBSERVATION_RESERVATION')
        native['childObservations'] = [*previous, observation]

    def _merge_observed_child(self, before, observation):
        try:
            child = self._merge_child(before)
        except BaseException as error:
            absent = (type(error) is old.Stop and error.args == ('CHILD_JOURNAL_ABSENT',))
            observation['journalMerge'] = 'ABSENT' if absent else 'REJECTED'
            raise
        observation['journalMerge'] = 'ACCEPTED'
        return child

    def _merge_failed_payment_child(self, before):
        observation = {'journalMerge': 'NOT_ATTEMPTED'}
        if self.cap.e['version'] != 2:
            return observation['journalMerge']
        try:
            self._merge_observed_child(before, observation)
        except BaseException:
            if 'PAYMENT_JOURNAL_UNCONFIRMED' not in self.cap.coordinator.j['unknown']:
                self.cap.coordinator.j['unknown'].append('PAYMENT_JOURNAL_UNCONFIRMED')
        return observation['journalMerge']

    def invoke_child(self, receipt, mode):
        need(mode in CHILD_MODES, 'CHILD_MODE')
        cleanup = mode not in ('--run', '--payment-preflight')
        deadline = self.cap.spend('child', cleanup)
        observation = {'childCall': self.cap.coordinator.j['nativeEntry']['calls']['child'],
                       'mode': mode, 'stage': 'UNKNOWN', 'code': 'UNCLASSIFIED',
                       'processOutcome': 'NOT_STARTED', 'journalMerge': 'NOT_ATTEMPTED'}
        request = None
        primary_error = None
        try:
            credentials = self.io.credentials()
            before = self._journal()
            request = {'envelopePath': str(self.cap.root / 'envelope.json'), 'receipt': receipt,
                       'childCall': observation['childCall'], 'credentials': credentials}
            credentials = None
            node = '/Users/debynyhanbanks/.nvm/versions/node/v24.12.0/bin/node'
            need(Path(node).is_file(), 'NODE_REQUIRED')
            try:
                result = self.io.child([node, str(HERE / 'native_child.mjs'), mode],
                    input=json.dumps(request, separators=(',', ':')), text=True, capture_output=True,
                    timeout=max(.01, min(30 if self.cap.e['version'] == 1 or cleanup else self.cap.times['workEnd'] - self.cap.clock(), deadline - self.cap.clock())),
                    env={'PATH': '/usr/bin:/bin:/opt/homebrew/bin', 'LANG': 'C'})
            except subprocess.TimeoutExpired:
                observation.update(processOutcome='TIMEOUT', code='CHILD_TIMEOUT')
                merged = self._merge_failed_payment_child(before)
                if merged in JOURNAL_OUTCOMES:
                    observation['journalMerge'] = merged
                raise old.Stop('CHILD_TIMEOUT') from None
            except BaseException:
                observation.update(processOutcome='EXIT_UNKNOWN', code='CHILD_EXIT_UNKNOWN')
                merged = self._merge_failed_payment_child(before)
                if merged in JOURNAL_OUTCOMES:
                    observation['journalMerge'] = merged
                raise old.Stop('CHILD_EXIT_UNKNOWN') from None
            value, refusal = child_output(result)
            returncode = getattr(result, 'returncode', None)
            observation.update(processOutcome=('RETURNED' if returncode == 0 else 'REFUSED') if type(returncode) is int else 'EXIT_UNKNOWN',
                               stage='RESULT', code='NONE' if value is not None else 'CHILD_OUTPUT')
            if refusal is not None:
                observation.update(refusal)
            # Adopt a valid journal even if output or the elapsed deadline refuses the result.
            if self.cap.e['version'] == 2:
                self._merge_observed_child(before, observation)
            self.cap.gate(cleanup)
            need(value is not None, 'CHILD_OUTPUT')
            if mode == '--payment-preflight':
                need(value == {'status': 'PAYMENT_PREFLIGHT_QUALIFIED', 'qualified': True},
                     'PAYMENT_PREFLIGHT_RESULT')
                return value, None
            if mode == '--readback':
                if self.cap.e['version'] == 1:
                    need(digest(read(self.cap.root / 'journal.json')) == digest(before), 'READBACK_JOURNAL_DRIFT')
                else:
                    after = read(self.cap.root / 'journal.json')
                    without_counts = lambda v: {k:x for k,x in v.get('payment', {}).items() if k not in {'revision','endpointCalls','secretReads'}}
                    need(without_counts(after) == without_counts(before) and after.get('authClient') == before.get('authClient'), 'READBACK_JOURNAL_DRIFT')
                    self._merge_observed_child(before, observation)
                need(set(value) == {'app', 'firebase', 'sessions'}, 'READBACK_SHAPE')
                return value, None
            child = self._merge_observed_child(before, observation)
            need(set(value) == {'status', 'authenticated', 'residuals', 'sessionClosed',
                               'liveAuthorization', 'authProofReady'} and
                 value['liveAuthorization'] is False and value['authProofReady'] is False and
                 type(value['authenticated']) is bool and type(value['sessionClosed']) is bool and
                 isinstance(value['residuals'], list), 'CHILD_RESULT_SHAPE')
            return value, child
        except BaseException as error:
            primary_error = error
            if observation['code'] == 'NONE':
                args = error.args if isinstance(error, Exception) else ()
                observation['code'] = ('CHILD_DEADLINE' if args == ('ENTRY_DEADLINE',) else
                                       'CHILD_INTERRUPTED' if args == ('INTERRUPTED',) else
                                       'CHILD_RESULT_REFUSED')
            raise
        finally:
            if request is not None:
                request['credentials'] = None
            # Do this after all before/disk comparisons, and before coordinator's next save.
            try:
                self._record_child_observation(observation)
            except BaseException:
                unknown = self.cap.coordinator.j.setdefault('unknown', [])
                if 'CHILD_DIAGNOSTIC_UNCONFIRMED' not in unknown:
                    unknown.append('CHILD_DIAGNOSTIC_UNCONFIRMED')
                if primary_error is None:
                    raise old.Stop('CHILD_DIAGNOSTIC_UNCONFIRMED') from None

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
