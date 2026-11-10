"""The V2 chain registry loads the F0 profiles whole, or refuses them whole.

Each refusal below changes one fact of a real profile, so every rule the
loader enforces is pinned by a case only that rule refuses.
"""
from fractions import Fraction
import json
from pathlib import Path
import re
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))
from discovery import DataError
import v2_chains
from v2_chains import (DEX_V3, DEX_V4, ZERO, default_balance_registry, default_registry, load_balance_registry,
                       load_registry)
from v2_fixtures import ROOT, balance_documents, documents, write_balance_registry, write_registry

ROBINHOOD, BASE, ARBITRUM = 'robinhood-4663.json', 'base-8453.json', 'arbitrum-42161.json'
# Changed on purpose 2026-11-09 (Elysium's mainnet): Elysium's enabled profile replaced its disabled placeholder in
# api-contracts/v2/chains. The placeholder, as it was, is kept as a fixture so the pending-profile rules keep a case.
PENDING = 'elysium.json'
PENDING_FIXTURE = Path(__file__).resolve().parent / 'fixtures/v2-pending-elysium.json'


def pending_documents():
    """The live profiles with Elysium back to its pending placeholder (a pending and an enabled profile of one slug
    cannot sit side by side)."""
    docs = {name: document for name, document in documents().items() if document.get('slug') != 'elysium'}
    docs[PENDING] = json.loads(PENDING_FIXTURE.read_text())
    return docs
ETHEREUM, OPTIMISM = 'ethereum-1.json', 'optimism-10.json'


class RegistryTests(unittest.TestCase):
    def test_the_owner_chains_load_in_chain_id_order_and_elysium_is_the_fourth(self):
        registry = load_registry()
        self.assertEqual([(p.chainId, p.key, p.stack) for p in registry.chains],
                         [(4663, 'robinhood-4663', 'arbitrum-nitro'), (8453, 'base-8453', 'op-stack'),
                          (42161, 'arbitrum-42161', 'arbitrum-nitro'), (99901, 'elysium-99901', 'arbitrum-nitro')])
        self.assertEqual(registry.pending, ())
        with tempfile.TemporaryDirectory() as directory:
            self.assertEqual([p.slug for p in write_registry(directory, pending_documents()).pending], ['elysium'])
        self.assertIs(default_registry(), default_registry())
        self.assertEqual(v2_chains.chain('base-8453').chainId, 8453)

    def test_a_chain_is_named_by_id_or_profile_name_only(self):
        registry = load_registry()
        self.assertEqual(registry.chain(42161).key, 'arbitrum-42161')
        self.assertEqual(registry.chain('robinhood-4663').chainId, 4663)
        self.assertEqual(registry.chain(99901).key, 'elysium-99901')
        with tempfile.TemporaryDirectory() as directory, self.assertRaisesRegex(DataError, '^v2_chain_not_enabled$'):
            write_registry(directory, pending_documents()).chain('elysium')
        for name, code in (('elysium', 'v2_chain_unknown'), ('base', 'v2_chain_unknown'),
                           ('8453', 'v2_chain_unknown'), (True, 'v2_chain_unknown'),
                           (8453.0, 'v2_chain_unknown'), ('base-4663', 'v2_chain_unknown'), (1, 'v2_chain_unknown')):
            with self.subTest(name=name), self.assertRaisesRegex(DataError, f'^{code}$'):
                registry.chain(name)

    def test_profile_facts_are_typed_lower_case_and_exact(self):
        robinhood, base, arbitrum, elysium = load_registry().chains
        self.assertEqual((robinhood.block_time, base.block_time, arbitrum.block_time, elysium.block_time),
                         (Fraction(1, 10), Fraction(2), Fraction(1, 4), Fraction(96, 1000)))
        # Relay alone serves Elysium (crosschain_pins.json, 9 Nov 2026).
        self.assertEqual((elysium.uniswap.v3, elysium.nativeSymbol, elysium.bridge.providers), (None, 'HYPE', ('relay',)))
        self.assertEqual(elysium.uniswap.universalRouter.address, '0x32ca6537934d333b776283d38834309cac06b3e7')
        self.assertEqual(robinhood.uniswap.v4.stateView, '0xf3334192d15450cdd385c8b70e03f9a6bd9e673b')
        self.assertEqual(robinhood.wrappedNative.address, '0x0bd7d308f8e1639fab988df18a8011f41eacad73')
        self.assertIsNone(robinhood.gasPrice.chainlinkEthUsd.sequencerUptimeFeed)
        self.assertEqual(base.gasPrice.chainlinkEthUsd.sequencerUptimeFeed, '0xbcf85224fc0756b9fa45aa7892530b47e10b6433')
        self.assertEqual(base.bridge.providers, ('relay', 'across'))
        self.assertEqual(base.bridge.appFeeBps, 35)

    def test_charge_ranks_codehashes_and_fee_tiers_come_from_the_profile(self):
        robinhood, base, *_ = load_registry().chains
        self.assertEqual(robinhood.charge_rank('0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168'), 1)  # USDG
        self.assertEqual(robinhood.charge_rank(ZERO), 2)
        self.assertEqual(robinhood.charge_rank(robinhood.wrappedNative.address), 2)
        self.assertIsNone(robinhood.charge_rank('0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'))  # Base's USDC
        self.assertEqual(base.charge_rank('0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'), 1)
        self.assertEqual(base.verified_codehash(base.uniswap.v4.poolManager),
                         '0x83b2af6e9f3158defc2811cbcb0db71ecf8b2ba2abea39c39e370ac5c6f43eb6')
        self.assertIsNone(base.verified_codehash('0x0000000000000000000000000000000000000064'))  # no ArbSys on Base
        with self.assertRaisesRegex(DataError, '^v2_contract_not_in_profile$'):
            base.verified_codehash('0x' + '12' * 20)
        self.assertEqual([base.v3_tick_spacing(fee) for fee in (100, 500, 3000, 10000, 300)], [1, 10, 60, 200, None])

    def test_dex_ids_are_the_solidity_constants(self):
        source = (ROOT / 'contracts/src/v2/DominoV2Types.sol').read_text()
        constants = dict(re.findall(r'uint8 internal constant (DEX_V[34]) = (\d+);', source))
        self.assertEqual(constants, {'DEX_V3': str(DEX_V3), 'DEX_V4': str(DEX_V4)})


class RefusalTests(unittest.TestCase):
    def load(self, mutate, name=ROBINHOOD, rename=None):
        docs = pending_documents() if name == PENDING else documents()
        mutate(docs[name])
        if rename:
            docs[rename] = docs.pop(name)
        with tempfile.TemporaryDirectory() as directory:
            return write_registry(directory, docs)

    def refused(self, mutate, code='v2_chain_profile_invalid', **kwargs):
        with self.assertRaisesRegex(DataError, f'^{code}$'):
            self.load(mutate, **kwargs)

    def test_the_unchanged_copy_loads(self):
        self.assertEqual(len(self.load(lambda d: None).chains), 4)
        self.assertEqual(len(self.load(lambda d: None, name=PENDING).chains), 3)

    def test_keys_and_types_are_exact(self):
        cases = {
            'extra_top_level': lambda d: d.update(rpcUrl='https://example.invalid'),
            'extra_nested': lambda d: d['uniswap']['v4'].update(hooks=ZERO),
            'missing_key': lambda d: d.pop('permit2'),
            'string_chain_id': lambda d: d.update(chainId='4663'),
            'boolean_rank': lambda d: d['chargeCurrencies'][0].update(rank=True),
            'unknown_stack': lambda d: d.update(stack='zk-stack'),
            'sunset_router': lambda d: d['uniswap']['universalRouter'].update(version='2.1.1'),
            'zero_contract': lambda d: d['uniswap']['v3'].update(quoterV2=ZERO),
            'zero_aggregator': lambda d: d['gasPrice']['chainlinkEthUsd'].update(aggregator=ZERO),
            'block_time_zero': lambda d: d.update(blockTimeSeconds=0),
            'block_time_list': lambda d: d.update(blockTimeSeconds=[0.1]),
            'impossible_day': lambda d: d['verification'].update(checkedAt='2026-02-30'),
            'unknown_provider': lambda d: d['bridge'].update(providers=['relay', 'stargate']),
            'duplicate_provider': lambda d: d['bridge'].update(providers=['relay', 'relay']),
            'no_fee_tiers': lambda d: d['uniswap']['v3'].update(tickSpacingByFee={}),
            'fee_tier_too_high': lambda d: d['uniswap']['v3']['tickSpacingByFee'].update({'1000000': 1}),
            'fee_tier_not_a_number': lambda d: d['uniswap']['v3']['tickSpacingByFee'].update({'03000': 60}),
            'tick_spacing_too_wide': lambda d: d['uniswap']['v3']['tickSpacingByFee'].update({'3000': 16384}),
            'hyphen_in_slug': lambda d: d.update(slug='robin-hood'),
        }
        for name, mutate in cases.items():
            with self.subTest(case=name):
                self.refused(mutate)

    def test_addresses_must_carry_their_checksum(self):
        self.refused(lambda d: d.update(permit2=d['permit2'].lower()))
        self.refused(lambda d: d['chargeCurrencies'][0].update(address=d['chargeCurrencies'][0]['address'].upper()
                                                               .replace('0X', '0x')))

    def test_charge_currencies_keep_the_rank_order_the_fee_rule_reads(self):
        def first_rank_two(d):
            d['chargeCurrencies'][0]['rank'] = 2

        def skipped_rank(d):
            for currency in d['chargeCurrencies'][1:]:
                currency['rank'] = 3

        def reordered(d):
            d['chargeCurrencies'].reverse()

        def duplicated(d):
            d['chargeCurrencies'][2]['address'] = d['chargeCurrencies'][0]['address']
            d['chargeCurrencies'][2]['rank'] = 2

        for mutate in (first_rank_two, skipped_rank, reordered, duplicated):
            with self.subTest(case=mutate.__name__):
                self.refused(mutate)

    def test_native_and_wrapped_native_are_one_currency(self):
        def native_with_address(d):
            d['chargeCurrencies'][1]['address'] = d['permit2']

        def zero_without_native(d):
            d['chargeCurrencies'][1].pop('native')

        def native_symbol(d):
            d['chargeCurrencies'][1]['symbol'] = 'HYPE'

        def native_decimals(d):
            d['chargeCurrencies'][1]['decimals'] = 8

        def wrapped_decimals(d):
            d['wrappedNative']['decimals'] = 6

        def wrapped_charge_decimals(d):
            d['chargeCurrencies'][2]['decimals'] = 6

        for mutate in (native_with_address, zero_without_native, native_symbol, native_decimals,
                       wrapped_decimals, wrapped_charge_decimals):
            with self.subTest(case=mutate.__name__):
                self.refused(mutate)

    def test_wrapped_rank_must_follow_native_rank(self):
        # USDG 1, ETH 2, WETH 3: in order, but ETH and WETH would be charged apart.
        self.refused(lambda d: d['chargeCurrencies'][2].update(rank=3))

    def test_every_consumed_contract_is_in_the_verification_record(self):
        def drop(address_of):
            def mutate(d):
                target = address_of(d)
                d['verification']['contracts'] = [c for c in d['verification']['contracts'] if c['address'] != target]
            return mutate

        for name, address_of in (('permit2', lambda d: d['permit2']), ('stateView', lambda d: d['uniswap']['v4']['stateView']),
                                 ('feed', lambda d: d['gasPrice']['chainlinkEthUsd']['proxy']),
                                 ('usdg', lambda d: d['chargeCurrencies'][0]['address']),
                                 ('weth', lambda d: d['wrappedNative']['address'])):
            with self.subTest(contract=name):
                self.refused(drop(address_of))
        with self.subTest(contract='sequencer feed on Base'):
            self.refused(drop(lambda d: d['gasPrice']['chainlinkEthUsd']['sequencerUptimeFeed']), name=BASE)

        def recorded_absent(d):
            record = next(c for c in d['verification']['contracts'] if c['address'] == d['multicall3'])
            record.update(codehash=None, absent=True)
        self.refused(recorded_absent)

    def test_verification_records_are_consistent(self):
        def absent_with_hash(d):
            d['verification']['contracts'][0]['absent'] = True

        def hash_missing(d):
            d['verification']['contracts'][0]['codehash'] = None

        def duplicate_record(d):
            d['verification']['contracts'].append(dict(d['verification']['contracts'][0], name='again'))

        def deployer_hash(d):
            d['deployer']['codehash'] = '0x' + '00' * 32

        def uniswap_aliases(d):
            d['uniswap']['v4']['quoter'] = d['uniswap']['v4']['stateView']

        for mutate in (absent_with_hash, hash_missing, duplicate_record, deployer_hash, uniswap_aliases):
            with self.subTest(case=mutate.__name__):
                self.refused(mutate)

    def test_the_file_name_and_document_must_agree(self):
        self.refused(lambda d: None, code='v2_chain_profile_file_name', rename='robinhood-1.json')
        self.refused(lambda d: None, code='v2_chain_profile_file_name', name=PENDING, rename='elysium-99801.json')

    def test_chain_ids_and_slugs_are_unique(self):
        self.refused(lambda d: d.update(chainId=8453, slug='arb'), code='v2_chain_profile_duplicate',
                     rename='arb-8453.json', name=ARBITRUM)
        self.refused(lambda d: d.update(slug='base'), code='v2_chain_profile_duplicate', rename='base-42161.json',
                     name=ARBITRUM)

    def test_a_disabled_profile_stays_pending(self):
        self.refused(lambda d: d.update(chainId=99801), name=PENDING)
        self.refused(lambda d: d.update(enableWhen=[]), name=PENDING)
        self.refused(lambda d: d.update(enabled='false'), name=PENDING)
        self.refused(lambda d: d.pop('enabled'), name=PENDING)
        # Even its opaque testnet facts must be standard JSON.
        self.refused(lambda d: d['testnet'].update(arbOS=float('nan')), name=PENDING)

    def test_duplicate_keys_and_oversized_files_are_refused(self):
        docs = documents()
        with tempfile.TemporaryDirectory() as directory:
            write_registry(directory, docs)
            path = Path(directory) / ROBINHOOD
            path.write_text(path.read_text().replace('"schemaVersion": 1,', '"schemaVersion": 1, "schemaVersion": 1,', 1))
            with self.assertRaisesRegex(DataError, '^v2_chain_profile_invalid$'):
                load_registry(directory)
            path.write_text(json.dumps(docs[ROBINHOOD]) + ' ' * v2_chains.MAX_PROFILE_BYTES)
            with self.assertRaisesRegex(DataError, '^v2_chain_profile_invalid$'):
                load_registry(directory)

    def test_an_empty_directory_is_no_registry(self):
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaisesRegex(DataError, '^v2_chain_profile_missing$'):
                load_registry(directory)


class BalanceRegistryTests(unittest.TestCase):
    """The balance chains (api-contracts/v2/balance-chains): read-v6's chain-balances reads them when asked."""

    def test_ethereum_and_op_mainnet_load_in_chain_id_order_apart_from_the_domino_chains(self):
        registry = load_balance_registry()
        self.assertEqual([(p.chainId, p.key, p.name) for p in registry.chains],
                         [(1, 'ethereum-1', 'Ethereum'), (10, 'optimism-10', 'OP Mainnet')])
        self.assertEqual(registry.pending, ())
        self.assertIs(default_balance_registry(), default_balance_registry())
        self.assertEqual(registry.chain('optimism-10').chainId, 10)
        self.assertEqual(registry.chain(1).key, 'ethereum-1')
        # Each registry names its own chains only.
        for name in (8453, 'base-8453', 4663, 'ethereum', '1', 137):
            with self.subTest(name=name), self.assertRaisesRegex(DataError, '^v2_chain_unknown$'):
                registry.chain(name)
        for name in (1, 'ethereum-1', 10, 'optimism-10'):
            with self.subTest(name=name), self.assertRaisesRegex(DataError, '^v2_chain_unknown$'):
                default_registry().chain(name)

    def test_a_balance_profile_names_what_a_balance_and_its_price_read_lower_case(self):
        ethereum, optimism = load_balance_registry().chains
        self.assertEqual(ethereum.uniswap.v4.stateView, '0x7ffe42c4a5deea5b0fec41c94c136cf115597227')
        self.assertEqual(optimism.wrappedNative.address, '0x4200000000000000000000000000000000000006')
        self.assertIsNone(ethereum.gasPrice.chainlinkEthUsd.sequencerUptimeFeed)
        self.assertEqual(optimism.gasPrice.chainlinkEthUsd.sequencerUptimeFeed, '0x371ead81c9102c9bf4874a9075ffff170f2ee389')
        self.assertEqual(ethereum.verified_codehash(ethereum.uniswap.v4.poolManager),
                         '0x785f1014552b7ce7d5fb7d0c970ca60edee94fd00425d7ca21609acac7ce1293')
        with self.assertRaisesRegex(DataError, '^v2_contract_not_in_profile$'):
            ethereum.verified_codehash(BASE_USDC)


BASE_USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
DAI = '0x6B175474E89094C44Da98b954EedeAC495271d0F'


class BalanceRefusalTests(unittest.TestCase):
    """Each refusal changes one fact of a real balance profile, refused by the rule it names alone."""

    def load(self, mutate, name=ETHEREUM, rename=None, extra=None):
        docs = balance_documents()
        mutate(docs[name])
        if rename:
            docs[rename] = docs.pop(name)
        docs.update(extra or {})
        with tempfile.TemporaryDirectory() as directory:
            return write_balance_registry(directory, docs, domino=load_registry())

    def refused(self, mutate, code='v2_chain_profile_invalid', rule=None, **kwargs):
        with self.assertRaisesRegex(DataError, f'^{code}$') as caught:
            self.load(mutate, **kwargs)
        if rule is not None:
            self.assertIn(rule, str(caught.exception.__cause__))

    def test_the_unchanged_copies_load(self):
        self.assertEqual([p.chainId for p in self.load(lambda d: None).chains], [1, 10])

    def test_keys_and_types_are_exact(self):
        cases = {
            'a domino profile kind': lambda d: d.update(kind='domino-v2-chain'),
            'a domino profile field': lambda d: d.update(permit2='0x000000000022D473030F116dDEE9F6B43aC78BA3'),
            'missing multicall3': lambda d: d.pop('multicall3'),
            'string chain id': lambda d: d.update(chainId='1'),
            'zero state view': lambda d: d['uniswap']['v4'].update(stateView=ZERO),
            'no fee tiers': lambda d: d['uniswap']['v3'].update(tickSpacingByFee={}),
            'unchecksummed': lambda d: d.update(multicall3=d['multicall3'].lower()),
            'heartbeat zero': lambda d: d['gasPrice']['chainlinkEthUsd'].update(heartbeatSeconds=0),
        }
        for name, mutate in cases.items():
            with self.subTest(case=name):
                self.refused(mutate)

    def test_one_stable_at_rank_one_beside_eth_and_weth(self):
        def two_stables(d):
            d['chargeCurrencies'].insert(1, {'rank': 1, 'symbol': 'DAI', 'address': DAI, 'decimals': 18})
            d['verification']['contracts'].append({'name': 'DAI', 'address': DAI, 'codehash': '0x' + '11' * 32})

        def no_eth(d):
            d['chargeCurrencies'] = [c for c in d['chargeCurrencies'] if not c.get('native')]

        def no_weth(d):
            d['chargeCurrencies'] = [c for c in d['chargeCurrencies'] if c['address'] != d['wrappedNative']['address']]
        for mutate in (two_stables, no_eth, no_weth):
            with self.subTest(case=mutate.__name__):
                self.refused(mutate, rule='balance_currencies_invalid')
        # The currency rules the Domino profiles keep hold here too.
        self.refused(lambda d: d['chargeCurrencies'].reverse(), rule='charge_currency_ranks_out_of_order')
        self.refused(lambda d: d['chargeCurrencies'][2].update(rank=3), rule='native_and_wrapped_ranks_differ')

    def test_every_consumed_contract_is_in_the_verification_record(self):
        def drop(address_of):
            def mutate(d):
                target = address_of(d)
                d['verification']['contracts'] = [c for c in d['verification']['contracts'] if c['address'] != target]
            return mutate
        for name, address_of in (('multicall3', lambda d: d['multicall3']), ('weth', lambda d: d['wrappedNative']['address']),
                                 ('usdc', lambda d: d['chargeCurrencies'][0]['address']),
                                 ('feed', lambda d: d['gasPrice']['chainlinkEthUsd']['proxy']),
                                 ('factory', lambda d: d['uniswap']['v3']['factory']),
                                 ('poolManager', lambda d: d['uniswap']['v4']['poolManager']),
                                 ('stateView', lambda d: d['uniswap']['v4']['stateView'])):
            with self.subTest(contract=name):
                self.refused(drop(address_of), rule='consumed_contract_not_verified')
        with self.subTest(contract='sequencer feed on OP Mainnet'):
            self.refused(drop(lambda d: d['gasPrice']['chainlinkEthUsd']['sequencerUptimeFeed']), name=OPTIMISM,
                         rule='consumed_contract_not_verified')

        def recorded_absent(d):
            record = next(c for c in d['verification']['contracts'] if c['address'] == d['multicall3'])
            record.update(codehash=None, absent=True)
        self.refused(recorded_absent, rule='consumed_contract_not_verified')
        # One address for two of Uniswap's contracts, each recorded: refused all the same.
        self.refused(lambda d: d['uniswap']['v4'].update(stateView=d['uniswap']['v4']['poolManager']),
                     rule='uniswap_contracts_not_distinct')

    def test_the_file_name_and_document_must_agree(self):
        self.refused(lambda d: None, code='v2_chain_profile_file_name', rename='ethereum-2.json')

    def test_no_balance_chain_takes_a_domino_chain_or_another_balance_chains_id_or_name(self):
        for case, change, file in (('a domino chain id', {'chainId': 8453, 'slug': 'mainnet'}, 'mainnet-8453.json'),
                                   ('a domino chain name', {'chainId': 5, 'slug': 'arbitrum'}, 'arbitrum-5.json'),
                                   ('a pending chain name', {'chainId': 5, 'slug': 'elysium'}, 'elysium-5.json'),
                                   ('a balance chain id', {'slug': 'mainnet', 'chainId': 10}, 'mainnet-10.json'),
                                   ('a balance chain name', {'slug': 'optimism', 'chainId': 5}, 'optimism-5.json')):
            with self.subTest(case=case):
                self.refused(lambda d: d.update(change), code='v2_chain_profile_duplicate', rename=file)

    def test_an_empty_directory_is_no_registry(self):
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaisesRegex(DataError, '^v2_chain_profile_missing$'):
                load_balance_registry(directory, domino=load_registry())


class NoChainlinkChainTests(unittest.TestCase):
    """A chain whose native currency is HYPE and Chainlink does not serve (Elysium, v2_hype_chain's synthetic profile):
    its profile names the pool that prices HYPE instead, and the profiles before it mean what they meant."""

    def load(self, change=None, *, v4=False, tolerant=False):
        import v2_hype_chain as hype
        with tempfile.TemporaryDirectory() as directory:
            for name, document in hype.docs(v4=v4, change=change).items():
                (Path(directory) / name).write_text(json.dumps(document, indent=2))
            return load_registry(directory, tolerant=tolerant)

    def refused(self, change, rule, *, v4=False):
        with self.assertRaisesRegex(DataError, '^v2_chain_profile_invalid$') as caught:
            self.load(change, v4=v4)
        self.assertIn(rule, str(caught.exception.__cause__))

    def test_a_hype_chain_without_chainlink_loads_beside_the_live_ones(self):
        import v2_hype_chain as hype
        for v4 in (False, True):
            with self.subTest(v4=v4):
                registry = self.load(v4=v4)
                self.assertEqual([p.chainId for p in registry.chains], [4663, 8453, 42161, hype.CHAIN_ID])
                self.assertEqual((registry.pending, registry.refused), ((), ()))
                chain = registry.chain(hype.KEY)
                self.assertEqual((chain.nativeSymbol, chain.wrappedNative.symbol, chain.native_feed), ('HYPE', 'WHYPE', None))
                self.assertEqual([(c.symbol, c.rank) for c in chain.chargeCurrencies], [('USDC', 1), ('HYPE', 2), ('WHYPE', 2)])
                pool = chain.native_pool
                self.assertEqual((pool.dex, pool.stable, pool.fee), (DEX_V4 if v4 else DEX_V3, hype.USDC.lower(), 500))
                self.assertEqual(pool.currency, ZERO if v4 else hype.WHYPE.lower())
                self.assertEqual(chain.bridge.providers, ())  # S2 off on this chain

    def test_the_fixture_keeps_the_pending_files_testnet_facts(self):
        import v2_hype_chain as hype
        pending = json.loads(PENDING_FIXTURE.read_text())  # the placeholder as it was until 9 Nov 2026
        self.assertEqual({key: pending['testnet'][key] for key in hype.TESTNET if key != 'stack'},
                         {key: value for key, value in hype.TESTNET.items() if key != 'stack'})
        self.assertEqual(pending['stack'], hype.TESTNET['stack'])

    def test_the_live_profiles_keep_their_chainlink_feed(self):
        for profile in map(load_registry().chain, ('robinhood-4663', 'base-8453', 'arbitrum-42161')):
            with self.subTest(chain=profile.key):
                self.assertIs(profile.native_feed, profile.gasPrice.chainlinkEthUsd)
                self.assertIsNone(profile.native_pool)

    def test_one_native_source_never_both_and_never_none(self):
        arbitrum = documents()['arbitrum-42161.json']
        self.refused(lambda d: d['gasPrice'].update(chainlinkEthUsd=arbitrum['gasPrice']['chainlinkEthUsd']),
                     'Extra inputs are not permitted')
        self.refused(lambda d: d.update(gasPrice={}), 'Field required')
        self.refused(lambda d: d['gasPrice']['poolNativeUsd'].update(dex=2), 'dex')

    def test_the_pool_pairs_the_native_currency_with_the_stable_at_rank_one(self):
        import v2_hype_chain as hype
        other = hype.synthetic('another token')

        def stable_is(address):
            return lambda d: d['gasPrice']['poolNativeUsd'].update(stable=address)

        self.refused(stable_is(hype.WHYPE), 'native_usd_pool_invalid')
        factory, init = (documents()['arbitrum-42161.json']['uniswap']['v3'][key] for key in ('factory', 'poolInitCodeHash'))

        def paired(currency, stable):
            # The factory's own pool of the pair, verified: only the rule on the pair itself can refuse it.
            def change(d):
                pool = hype.v3_pool(factory, init, currency, stable, 500)
                d['chargeCurrencies'].append({'rank': 3, 'symbol': 'OTHER', 'address': other, 'decimals': 6})
                records = d['verification']['contracts']
                records.append({'name': 'OTHER', 'address': other, 'codehash': '0x' + '11' * 32})
                if all(record['address'] != pool for record in records):
                    records.append({'name': 'pool', 'address': pool, 'codehash': '0x' + '12' * 32})
                d['gasPrice']['poolNativeUsd'].update(currency=currency, stable=stable, pool=pool)
            return change

        self.assertEqual(self.load(paired(hype.WHYPE, hype.USDC)).chain(hype.CHAIN_ID).native_pool.stable,
                         hype.USDC.lower())
        self.refused(paired(hype.WHYPE, other), 'native_usd_pool_invalid')  # a listed token, not the rank-1 stable
        self.refused(paired(other, hype.USDC), 'native_usd_pool_invalid')  # not the native currency's pool

        def wrapped_first(d):
            # WHYPE alone at rank 1 (no native charge currency), and a pool of it with itself where its address says.
            pool = hype.v3_pool(factory, init, hype.WHYPE, hype.WHYPE, 500)
            d['chargeCurrencies'] = [{'rank': 1, 'symbol': 'WHYPE', 'address': hype.WHYPE, 'decimals': 18},
                                     {'rank': 2, 'symbol': 'USDC', 'address': hype.USDC, 'decimals': 6}]
            d['verification']['contracts'].append({'name': 'pool', 'address': pool, 'codehash': '0x' + '13' * 32})
            d['gasPrice']['poolNativeUsd'].update(stable=hype.WHYPE, pool=pool)
        self.refused(wrapped_first, 'native_usd_pool_invalid')
        # v3 has no native currency: its pool holds the wrapped token. v4's may hold either.
        self.refused(lambda d: d['gasPrice']['poolNativeUsd'].update(currency=ZERO), 'zero_contract_address')

    def test_a_v3_pool_is_its_factorys_at_a_tier_the_profile_lists_and_verified(self):
        import v2_hype_chain as hype
        factory, init = (documents()['arbitrum-42161.json']['uniswap']['v3'][key] for key in ('factory', 'poolInitCodeHash'))

        def at(fee):
            def change(d):
                pool = hype.v3_pool(factory, init, hype.WHYPE, hype.USDC, fee)
                d['gasPrice']['poolNativeUsd'].update(fee=fee, pool=pool)
                d['verification']['contracts'].append({'name': f'fee {fee}', 'address': pool,
                                                       'codehash': '0x' + '22' * 32})
            return change

        self.assertEqual(self.load(at(3000)).chain(hype.CHAIN_ID).native_pool.fee, 3000)
        self.refused(at(2500), 'native_usd_pool_invalid')  # at its CREATE2 address, but no tier of the profile
        self.refused(lambda d: d['gasPrice']['poolNativeUsd'].update(fee=3000), 'native_usd_pool_invalid')
        self.refused(lambda d: d['gasPrice']['poolNativeUsd'].update(pool=hype.synthetic('elsewhere')),
                     'native_usd_pool_invalid')

        def unverified(d):
            pool = d['gasPrice']['poolNativeUsd']['pool']
            d['verification']['contracts'] = [c for c in d['verification']['contracts'] if c['address'] != pool]
        self.refused(unverified, 'consumed_contract_not_verified')

    def test_a_v4_pool_is_the_hookless_key_its_id_hashes(self):
        import v2_hype_chain as hype

        def keyed(currency, fee, spacing, pool_id=None):
            return lambda d: d['gasPrice']['poolNativeUsd'].update(
                currency=currency, fee=fee, tickSpacing=spacing,
                poolId=pool_id or hype.v4_pool_id(currency, hype.USDC, fee, spacing))

        self.assertEqual(self.load(keyed(hype.WHYPE, 3000, 60), v4=True).chain(hype.CHAIN_ID).native_pool.currency,
                         hype.WHYPE.lower())
        self.refused(keyed(ZERO, 3000, 60, hype.v4_pool_id(ZERO, hype.USDC, 500, 10)), 'native_usd_pool_invalid', v4=True)
        self.refused(keyed(ZERO, 0x800000, 10), 'fee', v4=True)  # a dynamic fee is its hook's, never a key's
        self.refused(lambda d: d['gasPrice']['poolNativeUsd'].update(hooks=ZERO), 'Extra inputs', v4=True)

    def test_the_universal_router_is_a_qualified_version(self):
        from v2_manifest import POLICIES
        self.assertEqual(v2_chains.UNIVERSAL_ROUTER_VERSIONS, {'2.1.2': 212})
        self.assertTrue(all(number >= POLICIES['minimumUniversalRouterVersion']
                            for number in v2_chains.UNIVERSAL_ROUTER_VERSIONS.values()))
        self.assertTrue(all(version == '.'.join(str(number)) for version, number in
                            v2_chains.UNIVERSAL_ROUTER_VERSIONS.items()))
        for version in ('2.1.1', '2.0', '2.1.3', '3.0.0'):
            with self.subTest(version=version):
                self.refused(lambda d: d['uniswap']['universalRouter'].update(version=version), 'universalRouter')

    def test_a_chain_without_bridge_providers_loads_and_one_with_both_too(self):
        import v2_hype_chain as hype
        for providers in ([], ['relay'], ['relay', 'across']):
            with self.subTest(providers=providers):
                registry = self.load(lambda d: d['bridge'].update(providers=providers))
                self.assertEqual(registry.chain(hype.CHAIN_ID).bridge.providers, tuple(providers))
        self.refused(lambda d: d['bridge'].pop('providers'), 'providers')

    def test_a_bad_new_profile_costs_its_own_chain_where_the_services_load(self):
        import v2_hype_chain as hype

        def broken(d):
            d['gasPrice'] = {}
        with self.assertRaisesRegex(DataError, '^v2_chain_profile_invalid$'):
            self.load(broken)
        registry = self.load(broken, tolerant=True)
        self.assertEqual([p.chainId for p in registry.chains], [4663, 8453, 42161])
        self.assertEqual(registry.refused, (v2_chains.RefusedProfile(hype.KEY, hype.CHAIN_ID, 'v2_chain_profile_invalid'),))
        for name in (hype.KEY, hype.CHAIN_ID):
            with self.subTest(name=name), self.assertRaisesRegex(DataError, '^v2_chain_profile_invalid$'):
                registry.chain(name)
        self.assertEqual(registry.chain('base-8453').chainId, 8453)
        with self.assertRaisesRegex(DataError, '^v2_chain_unknown$'):
            registry.chain(99802)
        # A file named for another chain id is set aside under its own name.
        renamed = self.load(lambda d: d.update(chainId=99802), tolerant=True)
        self.assertEqual([(r.key, r.chain_id, r.code) for r in renamed.refused],
                         [(hype.KEY, hype.CHAIN_ID, 'v2_chain_profile_file_name')])
        # A pending profile set aside answers for its slug; two chains on one id refuse the directory either way.
        docs = documents()
        docs['later.json'] = {'schemaVersion': 1, 'chainId': 5, 'slug': 'later', 'name': 'Later', 'enabled': False,
                              'nativeSymbol': 'HYPE', 'stack': 'arbitrum-nitro', 'enableWhen': ['its mainnet']}
        pending = self.directory_load(docs)
        self.assertEqual([(r.key, r.chain_id) for r in pending.refused], [('later', None)])
        with self.assertRaisesRegex(DataError, '^v2_chain_profile_invalid$'):
            pending.chain('later')
        docs = hype.docs()
        docs['arb-8453.json'] = dict(documents()['arbitrum-42161.json'], chainId=8453, slug='arb')
        with self.assertRaisesRegex(DataError, '^v2_chain_profile_duplicate$'):
            self.directory_load(docs)

    def directory_load(self, docs):
        with tempfile.TemporaryDirectory() as directory:
            for name, document in docs.items():
                (Path(directory) / name).write_text(json.dumps(document, indent=2))
            return load_registry(directory, tolerant=True)

    def test_the_services_registry_is_the_tolerant_one(self):
        from unittest import mock
        with mock.patch.object(v2_chains, 'load_registry', return_value='loaded') as loaded:
            self.assertEqual(v2_chains.default_registry.__wrapped__(), 'loaded')
        loaded.assert_called_once_with(tolerant=True)


if __name__ == '__main__':
    unittest.main()
