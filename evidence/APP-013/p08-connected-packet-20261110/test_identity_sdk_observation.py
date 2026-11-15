"""SD3 prerequisite: can optional receipts fail without blocking custody?

Uses only disposable files and the actual existing publication/inspection
primitives. No SDK, credential, process or provider operation is invoked.
"""
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import iq1_identity_boundary as k


class PublicationPrerequisiteTests(unittest.TestCase):
    def test_complete_existing_reservation_preserves_journal_inspection(self):
        with tempfile.TemporaryDirectory() as directory:
            journal = k.Journal(Path(directory) / 'root', {}, create=True)
            k.inv.reserve(journal.root / 'main-4.json', {'safe': 'RETURNED'})
            self.assertEqual(journal.inspect(), journal.identity)

    def test_interrupted_existing_reservation_blocks_next_custody_gate(self):
        with tempfile.TemporaryDirectory() as directory:
            journal = k.Journal(Path(directory) / 'root', {}, create=True)
            # An already-allowed name isolates publication from filename policy.
            # A proposed optional sidecar would encounter the same JSON check.
            path = journal.root / 'main-4.json'
            original_write = k.inv.os.write

            def interrupted_write(fd, data):
                original_write(fd, data[:2])
                raise OSError('synthetic interrupted write')

            with patch.object(k.inv.os, 'write', side_effect=interrupted_write):
                with self.assertRaises(OSError):
                    k.inv.reserve(path, {'safe': 'RETURNED'})
            self.assertTrue(path.exists())
            self.assertEqual(path.read_bytes(), b'{"')
            # Boundary.gate calls this same inspect before cleanup dispatch.
            with self.assertRaises(json.JSONDecodeError):
                journal.inspect()


if __name__ == '__main__':
    unittest.main()
