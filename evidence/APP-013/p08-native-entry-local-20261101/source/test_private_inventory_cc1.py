"""CC1 private receipt retention: actual fresh-process purge, no provider I/O."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import unittest
import uuid

import private_inventory as inventory


class LifecyclePurge(unittest.TestCase):
    def setUp(self):
        self.operation = str(uuid.uuid4())
        self.root = Path('/private/tmp/p08-coordinator-' + self.operation)
        self.root.mkdir(mode=0o700)
        self.addCleanup(shutil.rmtree, self.root)

    def put(self, name, raw):
        path = self.root / name
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, 'w') as stream:
            stream.write(raw)
        return path

    def test_fresh_process_purges_malformed_and_unfinished_receipts(self):
        for name in inventory.PRIVATE:
            self.put(name, '{unfinished synthetic private data')
        marker = self.put('payment-bootstrap-open-attempt.json', '{"status":"ATTEMPTED"}')
        self.put('journal.json', '{"unknown":["KEY_LIFECYCLE_RECEIPT_UNCONFIRMED"]}')
        result = subprocess.run([sys.executable, '-c',
            'import private_inventory as i,sys; '
            'print(i.purge(sys.argv[1],sys.argv[2]))', str(self.root), self.operation],
            cwd=Path(__file__).resolve().parent, capture_output=True, text=True, timeout=5)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.strip(), 'True')
        self.assertTrue(all(not (self.root / name).exists() for name in inventory.PRIVATE))
        self.assertTrue(marker.exists())
        self.assertEqual(json.loads((self.root / 'journal.json').read_text())['unknown'],
                         ['KEY_LIFECYCLE_RECEIPT_UNCONFIRMED'])

    def test_historical_uncommitted_intents_still_block_purge(self):
        for name in ('journal-next.json', 'journal.json.auth-next', 'journal.json.payment-next'):
            with self.subTest(name=name):
                private = self.put('key-lifecycle-private.json.next', 'unfinished')
                intent = self.put(name, '{}')
                with self.assertRaisesRegex(inventory.Stop, '^UNCOMMITTED_INTENT$'):
                    inventory.purge(self.root, self.operation)
                self.assertTrue(private.exists())
                private.unlink(); intent.unlink()

    def test_bad_mode_symlink_and_hardlink_refuse_without_touching_target(self):
        target = self.put('result.json', 'safe sentinel')
        private = self.root / 'key-lifecycle-private.json'
        private.symlink_to(target)
        with self.assertRaises(inventory.Stop):
            inventory.purge(self.root, self.operation)
        private.unlink()
        os.link(target, private)
        with self.assertRaises(inventory.Stop):
            inventory.purge(self.root, self.operation)
        private.unlink()
        private = self.put(private.name, 'synthetic private')
        private.chmod(0o644)
        with self.assertRaises(inventory.Stop):
            inventory.purge(self.root, self.operation)
        self.assertEqual(target.read_text(), 'safe sentinel')

    def test_foreign_file_refuses_and_exact_marker_is_allowed(self):
        marker = self.put('payment-bootstrap-open-attempt.json', '{}')
        self.assertEqual(inventory.inspect(self.root, self.operation), self.root)
        foreign = self.put('foreign.json', '{}')
        with self.assertRaises(inventory.Stop):
            inventory.purge(self.root, self.operation)
        self.assertTrue(marker.exists()); self.assertTrue(foreign.exists())


if __name__ == '__main__':
    unittest.main()
