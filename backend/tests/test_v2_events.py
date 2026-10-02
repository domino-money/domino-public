"""The V2 event catalog and its strict decoding.

The catalog is the frozen ABI exports' events, per emitter kind, plus F1b's
SwapLegExecuted, which is pinned here to its Solidity declaration. Decoding
refuses anything a deployed contract cannot emit: a short or long topic list,
dirty high bits in an indexed address or integer, a non-canonical data
encoding, a known event from an emitter that does not emit it.
"""
import json
from pathlib import Path
import re
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))
from discovery import DataError  # noqa: E402
from v2_events import (ABI_DIRECTORY, EMITTERS, SWAP_LEG_EXECUTED, catalog, decode_args, decode_log,  # noqa: E402
                       event_from_abi, event_keys, json_args)
from v2_index_fixtures import block_hash, encode_log, tx_hash  # noqa: E402

ROOT = Path(__file__).resolve().parents[2]
VAULT, ZAP, OWNER = '0x' + 'aa' * 20, '0x' + 'bb' * 20, '0x' + 'cc' * 20
TOKEN0, TOKEN1 = '0x' + '11' * 20, '0x' + '22' * 20
POOL = {'dex': 4, 'currency0': TOKEN0, 'currency1': TOKEN1, 'fee': 3000, 'tickSpacing': 60, 'hooks': '0x' + '00' * 20}


def raw(emitter, name, args, address=VAULT, log_index=0):
    return encode_log(emitter, name, args, address=address, block_number=7, block_hash=block_hash(7),
                      tx_hash=tx_hash('t'), log_index=log_index)


def kinds(address_kind):
    return lambda address: address_kind.get(address)


class CatalogTests(unittest.TestCase):
    def test_each_kind_has_exactly_the_events_of_its_exported_interfaces(self):
        cat = catalog()
        for kind, interfaces in EMITTERS.items():
            expected = set()
            for name in interfaces:
                if name == 'SwapLegExecuted':
                    expected.add(event_from_abi(SWAP_LEG_EXECUTED).signature)
                    continue
                for item in json.loads((ABI_DIRECTORY / f'{name}.json').read_text())['abi']:
                    if item['type'] == 'event':
                        expected.add(event_from_abi(item).signature)
            self.assertEqual({e.signature for e in cat.by_kind[kind].values()}, expected, kind)
        self.assertEqual(len(cat.topics()), len(set(cat.topics())))

    def test_the_implementation_event_is_the_solidity_declaration(self):
        source = (ROOT / 'contracts/src/v2/route/DominoSwapExecutor.sol').read_text()
        declared = re.search(r'event SwapLegExecuted\((.*?)\);', source, re.S).group(1)
        parameters = [re.sub(r'\s+', ' ', part.strip()).split(' ') for part in declared.split(',')]
        expected = [{'type': p[0], 'indexed': len(p) == 3 and p[1] == 'indexed', 'name': p[-1]} for p in parameters]
        self.assertEqual([dict(item) for item in SWAP_LEG_EXECUTED['inputs']], expected)

    def test_vault_events_include_the_ledger_and_execution_surfaces(self):
        names = {e.name for e in catalog().by_kind['vault'].values()}
        self.assertTrue({'Compounded', 'Executed', 'FeesCollected', 'Swapped', 'RootCheckpointed', 'FeeCharged',
                         'FeeDeferred', 'OwedFeesFlushed', 'SwapLegExecuted'} <= names)
        self.assertNotIn('VaultCreated', names)
        self.assertEqual({e.name for e in catalog().by_kind['vault_factory'].values()}, {'VaultCreated'})


class DecodeTests(unittest.TestCase):
    def test_tuples_ints_and_addresses_round_trip(self):
        args = {'intentHash': '0x' + '33' * 32, 'owner': OWNER, 'tokenId': 9, 'pool': POOL,
                'liquidityDelta': -5, 'amount0': -10**20, 'amount1': 7}
        log = decode_log(catalog(), raw('zap', 'PositionLiquidityChanged', args, ZAP), kinds({ZAP: 'zap'}))
        self.assertEqual((log.event, log.emitter, log.args), ('PositionLiquidityChanged', 'zap', args))
        self.assertEqual(json_args(log.args)['amount0'], str(-10**20))
        self.assertEqual(json_args(log.args)['pool']['fee'], '3000')

    def test_a_registry_change_keeps_its_bytes(self):
        args = {'id': '0x' + '44' * 32, 'kind': '0x' + '55' * 32, 'data': '0x' + 'ab' * 64, 'executableAt': 99}
        log = decode_log(catalog(), raw('registry', 'ChangeScheduled', args), kinds({VAULT: 'registry'}))
        self.assertEqual(log.args, args)

    def test_a_known_event_from_the_wrong_emitter_is_refused(self):
        entry = raw('vault_factory', 'VaultCreated', {'owner': OWNER, 'vault': VAULT, 'rootTokenId': 1, 'dex': 4,
                                                      'ownerNonce': 0})
        with self.assertRaisesRegex(DataError, 'v2_unexpected_event'):
            decode_log(catalog(), entry, kinds({VAULT: 'zap'}))
        entry['topics'][0] = '0x' + '99' * 32
        with self.assertRaisesRegex(DataError, 'v2_unknown_event'):
            decode_log(catalog(), entry, kinds({VAULT: 'vault_factory'}))

    def test_unfollowed_addresses_removed_logs_and_bad_envelopes_are_refused(self):
        entry = raw('vault', 'RootRearmed', {'stateNonce': 1})
        with self.assertRaisesRegex(DataError, 'v2_log_from_unfollowed_address'):
            decode_log(catalog(), entry, kinds({}))
        for change in ({'removed': True}, {'removed': None}):
            with self.subTest(change=change), self.assertRaisesRegex(DataError, 'v2_invalid_log'):
                decode_log(catalog(), {**entry, **change}, kinds({VAULT: 'vault'}))
        missing = dict(entry)
        del missing['removed']
        with self.assertRaisesRegex(DataError, 'v2_invalid_log'):
            decode_log(catalog(), missing, kinds({VAULT: 'vault'}))

    def test_dirty_topics_are_refused(self):
        event = next(e for e in catalog().by_kind['vault'].values() if e.name == 'AutomationPaused')
        entry = raw('vault', 'AutomationPaused', {'actor': OWNER, 'stateNonce': 2})
        dirty = list(entry['topics'])
        dirty[1] = '0x01' + dirty[1][4:]
        with self.assertRaisesRegex(DataError, 'v2_event_topic_not_canonical'):
            decode_args(event, dirty, entry['data'])
        fee = next(e for e in catalog().by_kind['zap'].values() if e.name == 'FeeCharged')
        entry = raw('zap', 'FeeCharged', {'kind': 1, 'token': TOKEN0, 'payer': OWNER, 'amount': 5,
                                          'ref': '0x' + '01' * 32}, ZAP)
        wide = list(entry['topics'])
        wide[1] = '0x' + '00' * 30 + '0101'  # uint8 kind with a bit above 8 bits
        with self.assertRaisesRegex(DataError, 'v2_event_topic_not_canonical'):
            decode_args(fee, wide, entry['data'])

    def test_wrong_topic_counts_and_non_canonical_data_are_refused(self):
        event = next(e for e in catalog().by_kind['vault'].values() if e.name == 'Compounded')
        args = {'tokenId': 3, 'liquidityAdded': 10, 'fees0': 1, 'fees1': 2, 'serviceFee0': 0, 'serviceFee1': 0,
                'stateNonce': 4}
        entry = raw('vault', 'Compounded', args)
        self.assertEqual(decode_args(event, entry['topics'], entry['data']), args)
        with self.assertRaisesRegex(DataError, 'v2_event_topics_mismatch'):
            decode_args(event, entry['topics'][:1], entry['data'])
        with self.assertRaisesRegex(DataError, 'v2_event_topics_mismatch'):
            decode_args(event, entry['topics'] + ['0x' + '00' * 32], entry['data'])
        with self.assertRaisesRegex(DataError, 'v2_event_data_not_canonical'):
            decode_args(event, entry['topics'], entry['data'] + '00' * 32)
        # A uint128 word with a bit above 128 bits: eth_abi refuses it outright.
        dirty = entry['data'][:2] + '01' + entry['data'][4:]
        with self.assertRaisesRegex(DataError, 'v2_event_data_(invalid|not_canonical)'):
            decode_args(event, entry['topics'], dirty)
        with self.assertRaisesRegex(DataError, 'v2_event_data_invalid'):
            decode_args(event, entry['topics'], entry['data'][:-64])

    def test_an_event_without_data_refuses_trailing_bytes(self):
        event = next(e for e in catalog().by_kind['registry'].values() if e.name == 'ChangeCancelled')
        entry = raw('registry', 'ChangeCancelled', {'id': '0x' + '01' * 32})
        self.assertEqual(entry['data'], '0x')
        with self.assertRaisesRegex(DataError, 'v2_event_data_not_canonical'):
            decode_args(event, entry['topics'], '0x00')

    def test_keys_name_the_wallet_vault_position_and_ref(self):
        mandate = '0x' + '77' * 32
        cases = [
            ('vault_factory', 'VaultCreated', {'owner': OWNER, 'vault': VAULT, 'rootTokenId': 5, 'dex': 4,
                                               'ownerNonce': 0}, ZAP, (OWNER, VAULT, 5, None)),
            ('vault', 'Executed', {'planHash': mandate, 'action': 1, 'stateNonce': 3}, VAULT, (None, VAULT, None, mandate)),
            ('vault', 'Swapped', {'source': 8, 'zeroForOne': True, 'amountIn': 1, 'amountOut': 1}, VAULT,
             (None, VAULT, 8, None)),
            ('vault', 'SuccessorCreated', {'parentTokenId': 5, 'tokenId': 6, 'stateNonce': 4}, VAULT,
             (None, VAULT, 6, None)),
            ('auto_exit', 'MandateRegistered', {'mandateHash': mandate, 'owner': OWNER, 'vault': VAULT, 'tokenId': 5,
                                                'validUntil': 10}, ZAP, (OWNER, VAULT, 5, mandate)),
            ('auto_exit', 'MandateExecuted', {'mandateHash': mandate, 'anchorSqrtPriceX96': 2**96,
                                              'recipient': OWNER, 'amount0': 1, 'amount1': 2}, ZAP,
             (OWNER, None, None, mandate)),
            ('zap', 'Refunded', {'recipient': OWNER, 'token': TOKEN0, 'amount': 3}, ZAP, (OWNER, None, None, None)),
            ('zap', 'FeeCharged', {'kind': 1, 'token': TOKEN0, 'payer': OWNER, 'amount': 5, 'ref': mandate}, ZAP,
             (OWNER, None, None, mandate)),
        ]
        for emitter, name, args, address, expected in cases:
            with self.subTest(event=name):
                log = decode_log(catalog(), raw(emitter, name, args, address), kinds({address: emitter}))
                self.assertEqual(event_keys(log), expected)


if __name__ == '__main__':
    unittest.main()
