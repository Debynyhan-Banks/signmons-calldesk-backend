import copy,hashlib,importlib.util,json,tempfile,unittest
from pathlib import Path
from unittest.mock import patch
ROOT=Path(__file__).parent
s=importlib.util.spec_from_file_location('renewal_original_diagnostic_tests',ROOT/'test_operator_diagnostic.py');fixture=importlib.util.module_from_spec(s);s.loader.exec_module(fixture)
c=fixture.c
class RenewedRetention(unittest.TestCase):
 def test_actual_saved_private_receipt_deadline_purge_and_public_evidence(self):
  with tempfile.TemporaryDirectory(prefix='p08-renewal-retention-',dir='/private/tmp') as temp:
   root=Path(temp);(root/'manifest.json').write_bytes((ROOT/'manifest.json').read_bytes());b,a=fixture.binding()
   adapter={'input':lambda prompt:'synthetic-only','database':lambda password:json.dumps(fixture.raw(3)),'closeout':lambda password:True}
   with patch.object(c,'ROOT',root):
    result=c.operator_diagnostic(b,a,adapter);self.assertIn('MULTIPLE_ELIGIBLE',result)
    private=json.loads((root/'operator-diagnostic-private.json').read_text());self.assertEqual(private['operationId'],c.PLAN['operationId']);self.assertEqual(private['retentionDeadlineUtc'],'2026-10-24T12:45:00Z');self.assertEqual(len(private['diagnostic']['candidates']),2)
    public_before=(root/'operator-diagnostic-result.json').read_bytes();self.assertNotIn(fixture.ACTOR.encode(),public_before)
    self.assertEqual(c.purge_operator_private(),'P08_OPERATOR_PRIVATE_RETIRED');self.assertFalse((root/'operator-diagnostic-private.json').exists());self.assertEqual((root/'operator-diagnostic-result.json').read_bytes(),public_before)
    retirement=json.loads((root/'operator-private-retirement.json').read_text());self.assertTrue(retirement['privateReceiptAbsent']);self.assertEqual(retirement['operationId'],c.PLAN['operationId']);self.assertEqual(retirement['diagnostic']['classification'],'MULTIPLE_ELIGIBLE');self.assertEqual(c.purge_operator_private(),'P08_OPERATOR_PRIVATE_ALREADY_ABSENT')
 def test_zero_has_no_private_data_and_absence_is_truthful(self):
  with tempfile.TemporaryDirectory(prefix='p08-renewal-retention-',dir='/private/tmp') as temp:
   root=Path(temp);(root/'manifest.json').write_bytes((ROOT/'manifest.json').read_bytes());b,a=fixture.binding()
   with patch.object(c,'ROOT',root):
    self.assertIn('ZERO_ELIGIBLE',c.operator_diagnostic(b,a,{'input':lambda prompt:'synthetic-only','database':lambda password:json.dumps(fixture.raw(0)),'closeout':lambda password:True}));self.assertFalse((root/'operator-diagnostic-private.json').exists());self.assertEqual(c.purge_operator_private(),'P08_OPERATOR_PRIVATE_ALREADY_ABSENT')
 def test_old_retention_and_old_approval_cannot_authorize_renewed_ids(self):
  b,a=fixture.binding();old=Path('/private/tmp/p08-operator-diagnostic-20261022-prep1');old_approval=json.loads((old/'operator-diagnostic-owner-approval.json').read_text())
  with self.assertRaises(c.Stop):c.check_operator_binding(b,old_approval)
  changed=copy.deepcopy(b);changed['privateRetentionEndUtc']='2026-10-23T22:15:00Z'
  with self.assertRaises(c.Stop):c.check_operator_binding(changed,a)
  self.assertEqual(c.PLAN['postRetirementDiagnosticRenewal']['runtimeState'],'RETIRED_NOT_READY_DO_NOT_REACTIVATE');self.assertEqual(c.PLAN['retirementDeadlineUtc'],c.PLAN['postRetirementDiagnosticRenewal']['attendedEndUtc'])
if __name__=='__main__':unittest.main()
