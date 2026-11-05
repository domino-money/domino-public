"""The pinned provider contracts (backend/crosschain_pins.json) are complete and agree with the V2 chain profiles."""
import json
import unittest

from eth_utils import is_checksum_address

from crosschain_support import ZERO  # noqa: F401  (puts backend on sys.path)
from crosschain_common import PINS_PATH, load_destinations, load_pins

RELAY_DEPOSITORY = '0x4cd00e387622c35bddb9b4c962c136462338bc31'
ENABLED = {4663, 8453, 42161}


def addresses(value, path=''):
    if isinstance(value, dict):
        for key, item in value.items():
            yield from addresses(item, f'{path}.{key}')
    elif isinstance(value, list):
        for index, item in enumerate(value):
            yield from addresses(item, f'{path}[{index}]')
    elif isinstance(value, str) and value.startswith('0x') and len(value) == 42:
        yield path, value


class PinTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.raw = json.loads(PINS_PATH.read_text())
        cls.pins, cls.destinations = load_pins(), load_destinations()

    def test_every_address_is_checksummed(self):
        for path, value in addresses(self.raw):
            with self.subTest(path=path):
                self.assertTrue(is_checksum_address(value), value)

    def test_the_destinations_are_the_enabled_chain_profiles(self):
        self.assertEqual(set(self.destinations), ENABLED)
        self.assertEqual(set(self.pins['destinations']), ENABLED)
        for chain in ENABLED:
            with self.subTest(chain=chain):
                row = self.pins['chains'][chain]
                self.assertEqual(row['relay']['depository'], RELAY_DEPOSITORY)
                self.assertEqual(row['across']['spokePool'], self.pins['destinations'][chain]['across']['spokePool'])
                self.assertEqual(row['across']['wrappedNative'], self.destinations[chain]['wrappedNative'])
                self.assertEqual(row['nativeSymbol'], 'ETH')
                tokens = self.destinations[chain]['tokens']
                self.assertIn(ZERO, tokens)
                self.assertIn(self.destinations[chain]['wrappedNative'], tokens)
                self.assertEqual(self.destinations[chain]['bridge'], {'providers': ['relay', 'across'], 'appFeeBps': 35})

    def test_every_pinned_origin_can_take_a_deposit(self):
        for chain, row in self.pins['chains'].items():
            with self.subTest(chain=chain):
                self.assertTrue('relay' in row or 'across' in row)
                if 'relay' in row:
                    self.assertTrue(row['relay']['slug'])
                if 'across' in row:
                    self.assertIn('spokePool', row['across'])
                    self.assertIn('spokePoolPeriphery', row['across'])
                    if row['nativeSymbol'] == 'ETH':
                        self.assertIn('wrappedNative', row['across'])

    def test_the_verification_record_names_each_destination_contract(self):
        for chain in ENABLED:
            names = {entry['address'].lower() for entry in self.raw['verification'][str(chain)]['contracts']}
            across = self.pins['destinations'][chain]['across']
            for value in (across['spokePool'], across['eventEmitter'], *across['multicallHandlers'], RELAY_DEPOSITORY):
                with self.subTest(chain=chain, address=value):
                    self.assertIn(value, names)


class DestinationTests(unittest.TestCase):
    """S2's destinations are the enabled profiles that name both providers. A profile naming none (v2_hype_chain's
    synthetic HYPE chain, as Elysium's may) is a chain S2 does not serve: no destination, never an import failure."""

    def destinations(self, change=None):
        from pathlib import Path
        import tempfile
        import v2_hype_chain as hype
        with tempfile.TemporaryDirectory() as directory:
            for name, document in hype.docs(change=change).items():
                (Path(directory) / name).write_text(json.dumps(document))
            return load_destinations(directory)

    def test_a_chain_without_providers_is_no_destination(self):
        self.assertEqual(set(self.destinations()), ENABLED)

    def test_a_chain_that_names_providers_names_both_at_the_app_fee(self):
        from discovery import DataError
        both = self.destinations(lambda d: d['bridge'].update(providers=['relay', 'across']))
        self.assertEqual(set(both), ENABLED | {99801})
        self.assertEqual({token: row['symbol'] for token, row in both[99801]['tokens'].items() if row['rank'] == 2},
                         {ZERO: 'HYPE', both[99801]['wrappedNative']: 'WHYPE'})
        for case, change in (('relay alone', lambda d: d['bridge'].update(providers=['relay'])),
                             ('across alone', lambda d: d['bridge'].update(providers=['across'])),
                             ('another fee, S2 off', lambda d: d['bridge'].update(appFeeBps=30)),
                             ('no bridge', lambda d: d.pop('bridge'))):
            with self.subTest(case=case), self.assertRaisesRegex(DataError, '^invalid_chain_profile$'):
                self.destinations(change)

    def test_the_fee_proofs_read_the_destinations_robinhood_through_its_own_node(self):
        from crosschain_across import HOSTED_DESTINATIONS
        from crosschain_config import DESTINATION_RPC_CHAINS
        self.assertEqual((DESTINATION_RPC_CHAINS, HOSTED_DESTINATIONS), ((4663, 8453, 42161), (8453, 42161)))


if __name__ == '__main__':
    unittest.main()
