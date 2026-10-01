"""Domino V2 chain profiles (api-contracts/v2/chains) are complete and sound.

Each enabled profile was verified on-chain when written (see its verification
block). These tests keep the files consistent: checksummed addresses, the
charge-currency ranks the fee rule depends on, every contract V2 needs, and the
deterministic deployer.
"""
import json
import unittest
from pathlib import Path

from eth_utils import is_checksum_address

ROOT = Path(__file__).resolve().parents[2]
CHAINS = ROOT / 'api-contracts/v2/chains'
ZERO = '0x0000000000000000000000000000000000000000'
CREATEX = '0xba5Ed099633D3B313e4D5F7bdc1305d3c28ba5Ed'
PERMIT2 = '0x000000000022D473030F116dDEE9F6B43aC78BA3'
ENABLED = {4663: 'robinhood', 8453: 'base', 42161: 'arbitrum'}


def load():
    return {path.name: json.loads(path.read_text()) for path in sorted(CHAINS.glob('*.json'))}


def addresses(value, path=''):
    """Every 0x-prefixed 20-byte string in the profile, with its path."""
    if isinstance(value, dict):
        for key, item in value.items():
            yield from addresses(item, f'{path}.{key}')
    elif isinstance(value, list):
        for index, item in enumerate(value):
            yield from addresses(item, f'{path}[{index}]')
    elif isinstance(value, str) and value.startswith('0x') and len(value) == 42:
        yield path, value


class V2ChainProfileTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.profiles = load()

    def test_the_owner_chains_are_enabled_and_elysium_waits(self):
        enabled = {p['chainId']: p['slug'] for p in self.profiles.values() if p['enabled']}
        self.assertEqual(enabled, ENABLED)
        elysium = self.profiles['elysium.json']
        self.assertFalse(elysium['enabled'])
        self.assertIsNone(elysium['chainId'])
        self.assertTrue(elysium['enableWhen'])

    def test_file_names_follow_slug_and_chain_id(self):
        for name, profile in self.profiles.items():
            if profile['enabled']:
                self.assertEqual(name, f"{profile['slug']}-{profile['chainId']}.json")

    def test_every_address_is_checksummed(self):
        for name, profile in self.profiles.items():
            for path, value in addresses(profile):
                if value == ZERO:
                    continue
                with self.subTest(file=name, field=path):
                    self.assertTrue(is_checksum_address(value), value)

    def test_enabled_chains_carry_every_contract_v2_uses(self):
        for profile in (p for p in self.profiles.values() if p['enabled']):
            with self.subTest(chain=profile['slug']):
                uniswap = profile['uniswap']
                for key in ('factory', 'positionManager', 'quoterV2', 'swapRouter02', 'poolInitCodeHash'):
                    self.assertTrue(uniswap['v3'][key])
                for key in ('poolManager', 'positionManager', 'stateView', 'quoter'):
                    self.assertTrue(uniswap['v4'][key])
                self.assertEqual(uniswap['universalRouter']['version'], '2.1.2')
                self.assertEqual(profile['permit2'], PERMIT2)
                self.assertEqual(profile['deployer'], {'kind': 'createx', 'address': CREATEX,
                                                       'codehash': profile['deployer']['codehash']})
                self.assertEqual(uniswap['v3']['tickSpacingByFee'], {'100': 1, '500': 10, '3000': 60, '10000': 200})

    def test_charge_currencies_follow_the_fee_rule(self):
        for profile in (p for p in self.profiles.values() if p['enabled']):
            with self.subTest(chain=profile['slug']):
                ranks = [(c['rank'], c['symbol']) for c in profile['chargeCurrencies']]
                expected_stable = 'USDG' if profile['chainId'] == 4663 else 'USDC'
                self.assertEqual(ranks, [(1, expected_stable), (2, 'ETH'), (2, 'WETH')])
                native = [c for c in profile['chargeCurrencies'] if c.get('native')]
                self.assertEqual([c['address'] for c in native], [ZERO])
                weth = [c for c in profile['chargeCurrencies'] if c['symbol'] == 'WETH'][0]
                self.assertEqual(weth['address'], profile['wrappedNative']['address'])
                self.assertEqual(len({c['address'] for c in profile['chargeCurrencies']}), 3)

    def test_bridge_fee_is_the_owner_decision(self):
        for profile in (p for p in self.profiles.values() if p['enabled']):
            self.assertEqual(profile['bridge'], {'providers': ['relay', 'across'], 'appFeeBps': 35})

    def test_every_enabled_profile_records_its_on_chain_verification(self):
        for profile in (p for p in self.profiles.values() if p['enabled']):
            with self.subTest(chain=profile['slug']):
                verification = profile['verification']
                self.assertGreater(verification['block'], 0)
                verified = {c['address'] for c in verification['contracts']}
                for key in ('poolManager', 'positionManager', 'stateView'):
                    self.assertIn(profile['uniswap']['v4'][key], verified)
                self.assertIn(profile['uniswap']['v3']['positionManager'], verified)
                self.assertIn(profile['uniswap']['universalRouter']['address'], verified)
                for contract in verification['contracts']:
                    if contract.get('absent'):
                        self.assertIsNone(contract['codehash'])  # a checked absence, e.g. no ArbSys on Base
                    else:
                        self.assertRegex(contract['codehash'], r'^0x[0-9a-f]{64}$')


if __name__ == '__main__':
    unittest.main()
