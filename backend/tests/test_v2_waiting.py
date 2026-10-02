"""Why a vault or a mandate waits: the automation's waiting file, read whole or not at all.

The file is the V2 automation's (docs/v2/V2_AUTOMATION_BACKEND.md, "Why a vault
or a mandate waits"), with `since` and `sinceBlock`, the first pass that gave
each subject's current reason, as its journal records them
(test_v2_executor.WaitingTests). The reader never takes part of a malformed
file nor another chain's file, and keeps what the automation recorded as is.
"""
import json
import os
from pathlib import Path
import shutil
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from v2_read_service import waiting_entry, waiting_report  # noqa: E402
from v2_waiting import checked_waiting, read_waiting_file, waiting_rows  # noqa: E402

VAULT, MANDATE = '0x' + 'a2' * 20, '0x' + 'c3' * 32
T = 1790000000


def document(**changes):
    value = {'schemaVersion': 1, 'kind': 'domino-v2-automation-waiting', 'chainId': 8453, 'block': 123456,
             'timestamp': T,
             'vaults': {VAULT: {'reason': 'gas_not_covered', 'since': T - 3600, 'sinceBlock': 121656, 'at': T,
                                'block': 123456, 'lastRevert': None}},
             'mandates': {MANDATE: {'reason': 'trigger_not_reached', 'since': T, 'sinceBlock': 123456, 'at': T,
                                    'block': 123456,
                                    'lastRevert': {'code': 'reverted_automation_unavailable', 'at': T - 10000,
                                                   'block': 123000}}}}
    value.update(changes)
    return value


def vault(**changes):
    return document(vaults={VAULT: dict(document()['vaults'][VAULT], **changes)})


class WaitingFileTests(unittest.TestCase):
    def setUp(self):
        self.directory = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.directory)
        self.path = self.directory / 'waiting-8453.json'

    def write(self, value):
        temporary = self.directory / '.waiting'
        temporary.write_text(value if isinstance(value, str) else json.dumps(value, sort_keys=True))
        os.replace(temporary, self.path)

    def test_the_automation_s_file_is_read_whole_and_kept_as_recorded(self):
        self.write(document())
        status, content = read_waiting_file(self.path, 8453)
        self.assertEqual(status, 'read')
        self.assertEqual(content['mandates'][MANDATE], {
            'reason': 'trigger_not_reached', 'since': T, 'sinceBlock': 123456, 'at': T, 'block': 123456,
            'lastRevert': {'code': 'reverted_automation_unavailable', 'at': T - 10000, 'block': 123000}})
        self.assertEqual(waiting_rows(content), {
            ('vault', VAULT): {'reason': 'gas_not_covered', 'since': T - 3600, 'since_block': 121656, 'at': T,
                               'block': 123456, 'revert': None, 'revert_at': None, 'revert_block': None},
            ('mandate', MANDATE): {'reason': 'trigger_not_reached', 'since': T, 'since_block': 123456, 'at': T,
                                   'block': 123456, 'revert': 'reverted_automation_unavailable',
                                   'revert_at': T - 10000, 'revert_block': 123000}})

    def test_absent_unreadable_or_foreign_files_are_never_read_in_part(self):
        self.assertEqual(read_waiting_file(self.path, 8453), ('unavailable', 'v2_waiting_file_unreadable'))
        entry = document()['vaults'][VAULT]
        defects = [
            '{', '[]', json.dumps(document(chainId=4663)), json.dumps(document(kind='domino-v2-waiting')),
            json.dumps(document(schemaVersion=2)), json.dumps(document(schemaVersion=True)),
            json.dumps(document(extra=1)), json.dumps(document(block=-1)), json.dumps(document(timestamp='1')),
            json.dumps(document(vaults={VAULT.upper().replace('0X', '0x'): entry})),
            json.dumps(document(mandates={'0x' + 'c3' * 20: document()['mandates'][MANDATE]})),
            json.dumps(vault(reason='Gas not covered')), json.dumps(vault(reason='x' * 101)),
            json.dumps(vault(note='why')), json.dumps(vault(at=1.5)),
            # Since when: recorded by the automation, never after the pass that reports it.
            json.dumps(document(vaults={VAULT: {k: v for k, v in entry.items() if k != 'since'}})),
            json.dumps(document(vaults={VAULT: {k: v for k, v in entry.items() if k != 'sinceBlock'}})),
            json.dumps(vault(since=None)), json.dumps(vault(since=T + 1)), json.dumps(vault(sinceBlock=123457)),
            json.dumps(document(mandates={MANDATE: dict(document()['mandates'][MANDATE],
                                                        lastRevert={'code': 'reverted_x', 'at': 1})})),
            '{"schemaVersion": 1, "schemaVersion": 1}',
        ]
        for text in defects:
            with self.subTest(text=text[:70]):
                self.write(text)
                self.assertEqual(read_waiting_file(self.path, 8453), ('unavailable', 'v2_waiting_file_invalid'))
        self.path.write_bytes(b' ' * 4_000_001)
        self.assertEqual(read_waiting_file(self.path, 8453), ('unavailable', 'v2_waiting_file_too_large'))

    def test_checked_waiting_is_the_file_s_content(self):
        self.assertEqual(checked_waiting(document(), 8453)['vaults'][VAULT]['sinceBlock'], 121656)


class ShownTests(unittest.TestCase):
    def test_a_row_and_a_report_as_read_v6_shows_them(self):
        row = {'reason': 'reverted_spot_outside_band', 'since': T - 60, 'since_block': 3, 'at': T, 'block': 9,
               'revert': 'reverted_spot_outside_band', 'revert_at': T, 'revert_block': 9}
        self.assertEqual(waiting_entry(row), {
            'reason': 'reverted_spot_outside_band', 'error': 'SpotOutsideBand', 'since': T - 60, 'sinceBlock': 3,
            'checkedAt': T, 'checkedBlock': 9,
            'lastRevert': {'reason': 'reverted_spot_outside_band', 'error': 'SpotOutsideBand', 'at': T, 'block': 9}})
        report = {'status': 'read', 'block': 9, 'block_timestamp': T, 'reason': None, 'read_at': T}
        self.assertEqual(waiting_report(report, T + 30)['status'], 'reporting')
        self.assertEqual(waiting_report(report, T + 601)['status'], 'stale')
        self.assertEqual(waiting_report(report, T + 600)['status'], 'reporting')
        self.assertEqual(waiting_report(None, T)['status'], 'not_configured')
        self.assertEqual(waiting_report({**report, 'status': 'unavailable', 'block': None, 'block_timestamp': None,
                                         'reason': 'v2_waiting_file_invalid'}, T)['status'], 'unavailable')


if __name__ == '__main__':
    unittest.main()
