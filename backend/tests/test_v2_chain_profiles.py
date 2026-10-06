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


BALANCE_CHAINS = ROOT / 'api-contracts/v2/balance-chains'
# The balance chains' facts from the providers' own documents on 6 Oct 2026, typed here so that an edit of a profile
# cannot move one silently: Circle's USDC (usdc-contract-addresses), Chainlink's ETH / USD proxy (path eth-usd), its
# decimals and heartbeat and OP Mainnet's sequencer uptime feed (reference data directory), Uniswap's v3 factory and v4
# PoolManager and StateView (deployments pages), WETH9 and Multicall3.
PUBLISHED = {
    1: {'name': 'ethereum-1.json', 'usdc': '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
        'weth': '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
        'feed': ('0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419', 8, 3600, None),
        'poolManager': '0x000000000004444c5dc75cB358380D2e3dE08A90', 'stateView': '0x7fFE42C4a5DEeA5b0feC41C94C136Cf115597227'},
    10: {'name': 'optimism-10.json', 'usdc': '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85',
         'weth': '0x4200000000000000000000000000000000000006',
         'feed': ('0x13e3Ee699D1909E989722E753853AE30b17e08c5', 8, 1200, '0x371EAD81c9102C9BF4874A9075FFFf170F2Ee389'),
         'poolManager': '0x9a13F98Cb987694C9F086b1F5eB990EeA8264Ec3', 'stateView': '0xc18a3169788F4F75A170290584ECA6395C75Ecdb'},
}
V3_FACTORY = '0x1F98431c8aD98523631AE4a59f267346ea31F984'
POOL_INIT_CODE_HASH = '0xe34f199b19b2b4f47f68442619d555527d244f78a3297ea89325f843f87b8b54'  # Uniswap's v3-sdk


class BalanceChainProfileTests(unittest.TestCase):
    """chain-balances' Ethereum and OP Mainnet: each profile is the providers' published contracts, verified on chain."""

    @classmethod
    def setUpClass(cls):
        cls.profiles = {path.name: json.loads(path.read_text()) for path in sorted(BALANCE_CHAINS.glob('*.json'))}

    def test_the_owner_balance_chains_are_ethereum_and_op_mainnet(self):
        self.assertEqual({p['chainId']: name for name, p in self.profiles.items()},
                         {chain_id: facts['name'] for chain_id, facts in PUBLISHED.items()})

    def test_each_is_the_providers_published_contracts(self):
        for chain_id, facts in PUBLISHED.items():
            profile = self.profiles[facts['name']]
            feed = profile['gasPrice']['chainlinkEthUsd']
            with self.subTest(chain=chain_id):
                self.assertEqual([(c['rank'], c['symbol'], c['address'], c['decimals']) for c in profile['chargeCurrencies']],
                                 [(1, 'USDC', facts['usdc'], 6), (2, 'ETH', ZERO, 18), (2, 'WETH', facts['weth'], 18)])
                self.assertEqual(profile['wrappedNative'], {'symbol': 'WETH', 'address': facts['weth'], 'decimals': 18})
                self.assertEqual((feed['proxy'], feed['decimals'], feed['heartbeatSeconds'], feed['sequencerUptimeFeed']),
                                 facts['feed'])
                self.assertEqual(profile['uniswap']['v4'], {'poolManager': facts['poolManager'],
                                                            'stateView': facts['stateView']})
                self.assertEqual(profile['uniswap']['v3'], {'factory': V3_FACTORY, 'poolInitCodeHash': POOL_INIT_CODE_HASH,
                                                            'tickSpacingByFee': {'100': 1, '500': 10, '3000': 60, '10000': 200}})
                self.assertEqual(profile['multicall3'], '0xcA11bde05977b3631167028862bE2a173976CA11')

    def test_the_init_code_hash_is_the_one_the_factory_deployed_its_pools_with(self):
        # The WETH/USDC 0.05% pool the factory's getPool named at the verification block is that pair's CREATE2 address.
        from eth_abi import encode
        from eth_hash.auto import keccak
        for chain_id, facts in PUBLISHED.items():
            profile = self.profiles[facts['name']]
            pool, = [c for c in profile['verification']['contracts'] if c['name'].startswith('v3 pool WETH/USDC fee 500')]
            low, high = sorted((facts['weth'].lower(), facts['usdc'].lower()))
            salt = keccak(encode(['address', 'address', 'uint24'], [low, high, 500]))
            digest = keccak(bytes([0xff]) + bytes.fromhex(V3_FACTORY[2:]) + salt + bytes.fromhex(POOL_INIT_CODE_HASH[2:]))
            with self.subTest(chain=chain_id):
                self.assertEqual(pool['address'].lower(), '0x' + digest[12:].hex())

    def test_every_address_is_checksummed_and_every_record_has_its_code_hash(self):
        for name, profile in self.profiles.items():
            self.assertEqual(name, f"{profile['slug']}-{profile['chainId']}.json")
            for path, value in addresses(profile):
                if value != ZERO:
                    with self.subTest(file=name, field=path):
                        self.assertTrue(is_checksum_address(value), value)
            self.assertGreater(profile['verification']['block'], 0)
            for contract in profile['verification']['contracts']:
                self.assertRegex(contract['codehash'], r'^0x[0-9a-f]{64}$')


if __name__ == '__main__':
    unittest.main()
