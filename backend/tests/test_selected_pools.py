"""The backend registration manifest must follow the reviewed product selection."""
from pathlib import Path
import re
import sys
import unittest

sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from discovery import DataError, bytes32
from selected_pools import SELECTED_POOLS

APP_CONFIG=Path(__file__).resolve().parents[2]/'app'/'src'/'config'/'selectedPools.ts'


class SelectedPoolManifestTests(unittest.TestCase):
    def test_ids_are_well_formed_and_unique(self):
        self.assertEqual(len(SELECTED_POOLS),6)
        self.assertEqual(len(set(SELECTED_POOLS)),len(SELECTED_POOLS))
        for pool_id in SELECTED_POOLS:
            with self.subTest(pool_id=pool_id):
                self.assertEqual(bytes32(pool_id),pool_id)

    def test_manifest_matches_the_frontend_selection_in_order(self):
        listed=re.findall(r"'(0x[0-9a-f]{64})'",APP_CONFIG.read_text())
        self.assertTrue(listed)
        self.assertEqual(listed,list(SELECTED_POOLS))

    def test_manifest_rejects_rubbish(self):
        with self.assertRaises(DataError):
            bytes32('0x'+'00'*31)


if __name__=='__main__':unittest.main()
