import copy,json,unittest
from unittest.mock import patch
import ir_identity_dispatch as d
q=d.q

class DispatchTests(unittest.TestCase):
    def setUp(self):
        self.commands=json.loads(json.dumps([next(x for x in q.current_cli_contract() if x['id']==name) for name in ('owner','project','identity')]))
        self.io=q.NativeIO(lambda:100, '109964d4-5156-4788-831e-5ff08f937952')
    def test_json_commands_reach_actual_transport(self):
        reservations=[]; observations=[]
        with patch.object(self.io,'_owned_run',return_value=b'{}') as transport:
            d.dispatch(self.commands,self.io,130,140,reservations.append,lambda *v:observations.append(v))
        self.assertEqual(reservations,['owner','project','identity'])
        self.assertEqual(transport.call_count,3)
        for call in transport.call_args_list:self.assertIsInstance(call.args[0],tuple)
        self.assertTrue(self.io.closed)
    def test_tampered_commands_stop_before_reservation(self):
        variants=[]
        for index,value in [(3,'foreign-account'),(-1,'--format=json')]:
            c=copy.deepcopy(self.commands);c[2]['argv'][index]=value;variants.append(c)
        variants.extend([self.commands[::-1],self.commands+[self.commands[0]]])
        for commands in variants:
            io=q.NativeIO(lambda:100,'109964d4-5156-4788-831e-5ff08f937952'); reservations=[]
            with patch.object(io,'_owned_run') as transport:
                with self.assertRaises(q.model.Stop):d.dispatch(commands,io,130,140,reservations.append,lambda *v:None)
                transport.assert_not_called();self.assertEqual(reservations,[]);self.assertTrue(io.closed)
    def test_explicit_boolean_required(self):
        base={'email':q.model.IDENTITY,'uniqueId':'synthetic'}
        for value in [None,0,1,'false',[],{}]:
            with self.assertRaises(q.model.Stop):d.identity_state(dict(base,disabled=value))
        with self.assertRaises(q.model.Stop):d.identity_state(base)
        self.assertEqual(d.identity_state(dict(base,disabled=True)),'DISABLED')
        self.assertEqual(d.identity_state(dict(base,disabled=False)),'ENABLED')
    def test_failure_stops_and_closes(self):
        reservations=[]
        with patch.object(self.io,'_owned_run',side_effect=q.model.Stop('PROCESS_REFUSED')) as transport:
            with self.assertRaises(q.model.Stop):d.dispatch(self.commands,self.io,130,140,reservations.append,lambda *v:None)
            self.assertEqual(transport.call_count,1);self.assertEqual(reservations,['owner']);self.assertTrue(self.io.closed)
    def test_actual_deadline_refuses_before_process(self):
        with patch.object(self.io,'_owned_run') as transport:
            with self.assertRaises(q.model.Stop):d.dispatch(self.commands,self.io,99,140,lambda v:None,lambda *v:None)
            transport.assert_not_called();self.assertTrue(self.io.closed)

if __name__=='__main__':unittest.main()
