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


if __name__ == '__main__':
    unittest.main()
