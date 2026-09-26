"""Every vault the factory creates is admitted without a restart, and nothing else is."""
from pathlib import Path
import re
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from eth_hash.auto import keccak
from pydantic import ValidationError

import automation_discovery as d
from automation_config import SequenceAdmission, validate_config
from automation_cycle import SequenceCycle
from automation_fixtures import address, identity, sample_automation_config, sample_config
from automation_observer import ObservationError

FACTORY, IMPLEMENTATION = address(4), address(5)
POLICY = {'fromBlock': 100, 'expiresAt': 1900000000, 'confirmations': 5, 'maxBlocksPerScan': 50, 'maxSequences': 4}


def word(value):
    return value[2:].rjust(64, '0') if isinstance(value, str) else format(value, '064x')


def created(owner, vault, block, *, implementation=IMPLEMENTATION, nonce=0, **changes):
    return {'address': FACTORY, 'topics': [d.TOPIC, '0x' + word(owner), identity(900 + block), '0x' + word(vault)],
            'data': '0x' + word(nonce) + word(implementation), 'blockNumber': hex(block), 'removed': False, **changes}


class Reader:
    """The node as discovery sees it: a head, and the factory's logs by block range."""
    def __init__(self, head, events=(), *, failing=()):
        self.number, self.events, self.failing, self.queries = head, list(events), set(failing), []

    def head(self):
        return {'number': self.number}

    def logs(self, query, *, max_logs):
        start, end = int(query['fromBlock'], 16), int(query['toBlock'], 16)
        self.queries.append((start, end))
        assert query['address'] == FACTORY and query['topics'] == [d.TOPIC] and max_logs == 1024
        if start in self.failing:
            raise ObservationError('automation_rpc_unavailable')
        return [event for event in self.events if start <= int(event['blockNumber'], 16) <= end]


def discovery(**policy):
    return d.FactoryDiscovery(sample_automation_config(discovery={**POLICY, **policy}))


class FactoryDiscoveryTests(unittest.TestCase):
    def test_the_topic_is_the_factorys_vault_created_event(self):
        source = (Path(__file__).resolve().parents[2] / 'contracts/src/DominoVaultFactoryV4.sol').read_text()
        declared = re.search(r'event VaultCreated\(([^)]*)\);', source).group(1)
        types = [part.split()[0] for part in declared.split(',')]
        self.assertEqual(types, ['address', 'bytes32', 'address', 'uint256', 'address'])
        self.assertEqual([len(part.split()) == 3 for part in declared.split(',')], [True, True, True, False, False])
        self.assertEqual(d.TOPIC, '0x' + keccak(f'VaultCreated({",".join(types)})'.encode()).hex())

    def test_the_events_are_read_in_spans_up_to_the_confirmations_below_the_head(self):
        found, reader = discovery(), Reader(300)
        self.assertEqual(found.scan(reader, max_logs=1024), {'admitted': [], 'leftOut': 0})
        self.assertEqual(reader.queries, [(100, 149), (150, 199), (200, 249), (250, 295)])
        # The next scan reads only what is new, and nothing while the head has not moved.
        reader.queries.clear()
        found.scan(reader, max_logs=1024)
        reader.number = 310
        found.scan(reader, max_logs=1024)
        self.assertEqual(reader.queries, [(296, 305)])

    def test_each_vault_is_admitted_once_in_creation_order_beside_the_configured_ones(self):
        found = discovery()
        events = [created(address(12), address(13), 180), created(address(1), address(3), 120),
                  created(address(10), address(11), 130), created(address(12), address(13), 290)]
        result = found.scan(Reader(300, events), max_logs=1024)
        first, second = (SequenceAdmission(owner=owner, vault=vault, expiresAt=1900000000, suspended=False)
                         for owner, vault in ((address(10), address(11)), (address(12), address(13))))
        # Blocks 120 and 130 come in the first span, 180 in the second; the configured vault is not added twice.
        self.assertEqual(result, {'admitted': [first, second], 'leftOut': 0})
        self.assertEqual([(s.owner, s.vault) for s in found.admitted()],
                         [(address(1), address(3)), (address(10), address(11)), (address(12), address(13))])

    def test_a_vault_of_another_implementation_is_left_alone(self):
        found = discovery()
        result = found.scan(Reader(300, [created(address(10), address(11), 120, implementation=address(99))]), max_logs=1024)
        self.assertEqual((result['admitted'], found.cursor), ([], 295))

    def test_a_log_that_is_not_the_factorys_event_stops_the_scan_and_is_read_again(self):
        good = created(address(10), address(11), 160)
        for label, bad in (('another emitter', {**good, 'address': address(77)}),
                           ('removed by a reorganization', {**good, 'removed': True}),
                           ('no removed flag', {k: v for k, v in good.items() if k != 'removed'}),
                           ('another event', {**good, 'topics': [identity(1), *good['topics'][1:]]}),
                           ('three topics', {**good, 'topics': good['topics'][:3]}),
                           ('an owner that is not an address', {**good, 'topics': [good['topics'][0], identity(2**200), *good['topics'][2:]]}),
                           ('a sequence id that is not a topic', {**good, 'topics': [*good['topics'][:2], 7, good['topics'][3]]}),
                           ('short data', {**good, 'data': good['data'][:-2]}),
                           ('data without its prefix', {**good, 'data': '00' + good['data'][2:]}),
                           ('an implementation that is not an address', {**good, 'data': '0x' + word(0) + 'f' * 64})):
            with self.subTest(label):
                found = discovery()
                reader = Reader(300, [created(address(12), address(13), 120), bad])
                with self.assertRaisesRegex(ObservationError, 'discovery_log_invalid'):
                    found.scan(reader, max_logs=1024)
                # The span that held it is read again; the vault before it stays admitted.
                self.assertEqual((found.cursor, [s.vault for s in found.found]), (149, [address(13)]))
        # A block the node returns outside the range asked is not trusted either.
        found = discovery()
        with self.assertRaisesRegex(ObservationError, 'discovery_log_invalid'):
            found.scan(type('Loose', (Reader,), {'logs': lambda self, query, *, max_logs: [good]})(300), max_logs=1024)

    def test_the_ceiling_admits_in_order_and_says_how_many_it_left_out(self):
        found = discovery(maxSequences=3)
        events = [created(address(20 + i), address(40 + i), 110 + i) for i in range(4)]
        result = found.scan(Reader(300, events), max_logs=1024)
        self.assertEqual(([s.vault for s in result['admitted']], result['leftOut']), ([address(40), address(41)], 2))
        self.assertEqual(len(found.admitted()), 3)
        # Once full, a later scan admits nothing more and still counts.
        more = found.scan(Reader(400, [created(address(30), address(50), 350)]), max_logs=1024)
        self.assertEqual((more['admitted'], more['leftOut']), ([], 1))

    def test_a_failed_read_leaves_the_cursor_after_the_last_span_read_whole(self):
        found = discovery()
        events = [created(address(10), address(11), 120), created(address(12), address(13), 220)]
        with self.assertRaisesRegex(ObservationError, 'automation_rpc_unavailable'):
            found.scan(Reader(300, events, failing={200}), max_logs=1024)
        self.assertEqual((found.cursor, [s.vault for s in found.found]), (199, [address(11)]))
        reader = Reader(300, events)
        self.assertEqual([s.vault for s in found.scan(reader, max_logs=1024)['admitted']], [address(13)])
        self.assertEqual(reader.queries, [(200, 249), (250, 295)])

    def test_without_a_policy_nothing_is_read_and_only_the_configured_sequences_are_admitted(self):
        found = d.FactoryDiscovery(sample_automation_config())
        reader = Reader(300, [created(address(10), address(11), 120)])
        reader.head = lambda: self.fail('read without a policy')
        self.assertEqual(found.scan(reader, max_logs=1024), {'admitted': [], 'leftOut': 0})
        self.assertEqual([s.vault for s in found.admitted()], [address(3)])


class CycleDiscoveryTests(unittest.TestCase):
    def test_the_cycle_reads_the_factory_with_a_fresh_request_budget_only_under_a_policy(self):
        resets = []
        for config, expected in ((sample_automation_config(), []), (sample_automation_config(discovery=POLICY), [address(11)])):
            cycle = SequenceCycle(config, rpc=object())
            reader = Reader(300, [created(address(10), address(11), 120)])
            reader.reset = lambda: resets.append(config.discovery is not None)
            if config.discovery is None:
                reader.head = lambda: self.fail('read without a policy')
            cycle.reader = reader
            self.assertEqual([s.vault for s in cycle.discover()['admitted']], expected)
            self.assertEqual([s.vault for s in cycle.admitted()], [address(3), *expected])
        self.assertEqual(resets, [True])


class DiscoveryPolicyTests(unittest.TestCase):
    def test_the_policy_is_optional_bounded_and_ends_with_the_release(self):
        self.assertIsNone(sample_automation_config().discovery)
        self.assertEqual(sample_automation_config(discovery=POLICY).discovery.maxSequences, 4)
        with self.assertRaisesRegex(ValueError, 'discovery_expiry_invalid'):
            validate_config(sample_config(discovery={**POLICY, 'expiresAt': 2000000001}))
        for field, value in (('fromBlock', 0), ('confirmations', 10001), ('maxBlocksPerScan', 0),
                             ('maxBlocksPerScan', 1000001), ('maxSequences', 0), ('maxSequences', 257), ('extra', 1)):
            with self.subTest(field=field, value=value), self.assertRaises(ValidationError):
                validate_config(sample_config(discovery={**POLICY, field: value}))


if __name__ == '__main__':
    unittest.main()
