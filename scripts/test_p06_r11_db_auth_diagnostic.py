import importlib.util, unittest
from pathlib import Path
path = Path(__file__).with_name("p06-r11-db-auth-diagnostic.py")
spec = importlib.util.spec_from_file_location("diagnostic", path); m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)

class DiagnosticTests(unittest.TestCase):
    def test_classifications(self):
        self.assertEqual(m.classify(0,b"1\n",b""),"ACCEPTED")
        self.assertEqual(m.classify(2,b"",b"password authentication failed"),"AUTH_REFUSED")
        self.assertEqual(m.classify(2,b"",b"could not translate host name"),"DNS_REFUSED")
        self.assertEqual(m.classify(2,b"",b"connection timed out"),"TIMEOUT")
        self.assertEqual(m.classify(2,b"",b"SSL certificate error"),"TLS_REFUSED")

if __name__ == "__main__": unittest.main()
