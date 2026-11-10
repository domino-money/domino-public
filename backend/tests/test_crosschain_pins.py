"""The pinned provider contracts (backend/crosschain_pins.json) are complete and agree with the V2 chain profiles."""
import json
import unittest

from eth_utils import is_checksum_address

from crosschain_support import ZERO  # noqa: F401  (puts backend on sys.path)
from crosschain_common import PINS_PATH, load_destinations, load_pins

RELAY_DEPOSITORY = '0x4cd00e387622c35bddb9b4c962c136462338bc31'
# Relay and Across serve Robinhood, Base and Arbitrum; Relay alone serves Elysium, and only its USDC (9 Nov 2026).
ACROSS = {4663, 8453, 42161}
ELYSIUM, ELYSIUM_USDC = 99901, '0xb47c4c8f73f009cc0c0d3f92b388d13e293f0b65'
ENABLED = ACROSS | {ELYSIUM}


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
        self.assertEqual(set(self.pins['destinations']), ACROSS)  # Across' destination contracts
        for chain in ACROSS:
            with self.subTest(chain=chain):
                self.assertEqual(self.destinations[chain]['providers'], ('relay', 'across'))
                row = self.pins['chains'][chain]
                self.assertEqual(row['relay']['depository'], RELAY_DEPOSITORY)
                self.assertEqual(row['across']['spokePool'], self.pins['destinations'][chain]['across']['spokePool'])
                self.assertEqual(row['across']['wrappedNative'], self.destinations[chain]['wrappedNative'])
                self.assertEqual(row['nativeSymbol'], 'ETH')
                tokens = self.destinations[chain]['tokens']
                self.assertIn(ZERO, tokens)
                self.assertIn(self.destinations[chain]['wrappedNative'], tokens)
                self.assertEqual(self.destinations[chain]['bridge'], {'providers': ['relay', 'across'], 'appFeeBps': 35})
        # Elysium: Relay alone, at the Depository's address elsewhere; a deposit delivers its pinned USDC only.
        row, destination = self.pins['chains'][ELYSIUM], self.destinations[ELYSIUM]
        self.assertEqual((row['name'], row['nativeSymbol'], row['relay']['slug'], row['relay']['depository'], 'across' in row),
                         ('Elysium', 'HYPE', 'elysium', RELAY_DEPOSITORY, False))
        self.assertEqual(row['relay']['tokens'], (ELYSIUM_USDC,))
        self.assertEqual((destination['providers'], list(destination['tokens'])), (('relay',), [ELYSIUM_USDC]))
        self.assertEqual(destination['bridge'], {'providers': ['relay'], 'appFeeBps': 35})

    def test_only_elysium_pins_the_tokens_its_provider_bridges(self):
        self.assertEqual({chain for chain, row in self.pins['chains'].items() if 'tokens' in row.get('relay', {})},
                         {ELYSIUM})

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
        self.assertEqual({int(chain) for chain in self.raw['verification']}, ENABLED)
        for chain in ENABLED:
            names = {entry['address'].lower() for entry in self.raw['verification'][str(chain)]['contracts']}
            expected = [RELAY_DEPOSITORY]
            if chain in ACROSS:
                across = self.pins['destinations'][chain]['across']
                expected += [across['spokePool'], across['eventEmitter'], *across['multicallHandlers']]
            for value in expected:
                with self.subTest(chain=chain, address=value):
                    self.assertIn(value, names)


class DestinationTests(unittest.TestCase):
    """S2's destinations are the enabled profiles that name providers, each pinned on that chain. A profile naming
    none (v2_hype_chain's synthetic HYPE chain) is a chain S2 does not serve: no destination, never an import failure.
    These read the repository's profiles without Elysium's, beside the synthetic chain 99801."""

    def destinations(self, change=None, pin=None):
        """load_destinations over v2_hype_chain's profiles; `pin`, if given, is chain 99801's entry in a copy of the
        repository's pins (absent, the repository's pins, which do not pin 99801)."""
        from pathlib import Path
        import tempfile
        import v2_hype_chain as hype
        with tempfile.TemporaryDirectory() as directory:
            profiles = Path(directory) / 'profiles'
            profiles.mkdir()
            for name, document in hype.docs(change=change).items():
                (profiles / name).write_text(json.dumps(document))
            pins = PINS_PATH
            if pin is not None:
                document = json.loads(PINS_PATH.read_text())
                document['chains'][str(hype.CHAIN_ID)] = {'name': 'HYPE test', 'nativeSymbol': 'HYPE', **pin}
                pins = Path(directory) / 'pins.json'
                pins.write_text(json.dumps(document))
            return load_destinations(profiles, pins)

    RELAY = {'relay': {'slug': 'hype-test', 'depository': RELAY_DEPOSITORY}}
    ACROSS_PIN = {'across': {'spokePool': '0x' + '11' * 20, 'spokePoolPeriphery': '0x' + '22' * 20}}

    def test_a_chain_without_providers_is_no_destination(self):
        self.assertEqual(set(self.destinations()), ACROSS)

    def test_a_chain_names_only_the_providers_pinned_on_it_at_the_app_fee(self):
        from discovery import DataError
        import v2_hype_chain as hype
        both = self.destinations(lambda d: d['bridge'].update(providers=['relay', 'across']), {**self.RELAY, **self.ACROSS_PIN})
        self.assertEqual(set(both), ACROSS | {hype.CHAIN_ID})
        self.assertEqual(both[hype.CHAIN_ID]['providers'], ('relay', 'across'))
        self.assertEqual({token: row['symbol'] for token, row in both[hype.CHAIN_ID]['tokens'].items() if row['rank'] == 2},
                         {ZERO: 'HYPE', both[hype.CHAIN_ID]['wrappedNative']: 'WHYPE'})
        relay = self.destinations(lambda d: d['bridge'].update(providers=['relay']), self.RELAY)
        self.assertEqual((relay[hype.CHAIN_ID]['providers'], len(relay[hype.CHAIN_ID]['tokens'])), (('relay',), 3))
        across = self.destinations(lambda d: d['bridge'].update(providers=['across']), self.ACROSS_PIN)
        self.assertEqual(across[hype.CHAIN_ID]['providers'], ('across',))
        for case, change, pin in (
                ('relay, not pinned there', lambda d: d['bridge'].update(providers=['relay']), None),
                ('across, pinned without it', lambda d: d['bridge'].update(providers=['relay', 'across']), self.RELAY),
                ('named twice', lambda d: d['bridge'].update(providers=['relay', 'relay']), self.RELAY),
                ('another provider', lambda d: d['bridge'].update(providers=['stargate']), self.RELAY),
                ('another fee, S2 off', lambda d: d['bridge'].update(appFeeBps=30), self.RELAY),
                ('no bridge', lambda d: d.pop('bridge'), self.RELAY)):
            with self.subTest(case=case), self.assertRaisesRegex(DataError, '^invalid_chain_profile$'):
                self.destinations(change, pin)

    def test_a_pinned_token_list_bounds_what_a_deposit_delivers(self):
        from discovery import DataError
        import v2_hype_chain as hype
        relay_only = lambda d: d['bridge'].update(providers=['relay'])  # noqa: E731
        stable = hype.USDC.lower()
        listed = self.destinations(relay_only, {'relay': {**self.RELAY['relay'], 'tokens': [hype.USDC]}})
        self.assertEqual(list(listed[hype.CHAIN_ID]['tokens']), [stable])
        # Both providers: a list on one of them bounds nothing, the other bridges every charge currency.
        both = self.destinations(lambda d: d['bridge'].update(providers=['relay', 'across']),
                                 {'relay': {**self.RELAY['relay'], 'tokens': [hype.USDC]}, **self.ACROSS_PIN})
        self.assertEqual(len(both[hype.CHAIN_ID]['tokens']), 3)
        with self.assertRaisesRegex(DataError, '^invalid_chain_profile$'):  # it lists no charge currency
            self.destinations(relay_only, {'relay': {**self.RELAY['relay'], 'tokens': ['0x' + '33' * 20]}})
        for tokens in ([], [hype.USDC, hype.USDC.lower()], 'USDC'):
            with self.subTest(tokens=tokens), self.assertRaisesRegex(DataError, '^invalid_crosschain_pins$'):
                self.destinations(relay_only, {'relay': {**self.RELAY['relay'], 'tokens': tokens}})

    def test_the_fee_proofs_read_the_destinations_robinhood_through_its_own_node(self):
        from crosschain_across import HOSTED_DESTINATIONS
        from crosschain_config import DESTINATION_RPC_CHAINS
        # Elysium is a destination Relay alone serves: no Across fee proof reads it.
        self.assertIn(ELYSIUM, load_destinations())
        self.assertEqual((DESTINATION_RPC_CHAINS, HOSTED_DESTINATIONS), ((4663, 8453, 42161), (8453, 42161)))


if __name__ == '__main__':
    unittest.main()
