"""Independent lifecycle regressions through real acquisition fixtures.

Synthetic RPC data exercises canonical ordering and the reducer. It does not
qualify deployed contracts, provider completeness, token prices or live income.
"""
from pathlib import Path
import sys
import unittest

from eth_abi import decode, encode

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from performance_collection import CanonicalCollector, POSITION_TYPE
from performance_financial_collection import FinancialCollector
from performance_history import CHILD_EXIT, open_history, reduce_history
from test_performance_financial_collection import FinancialRpc, pool_log, selector
from test_performance_collection import OWNER, VAULT, NEXT_OWNER, CODE_HASH, hash_, topic, transfer_log


class ClosedChildRpc(FinancialRpc):
    """Child leaves custody while its old source reserves remain in the vault."""
    def __init__(self):
        super().__init__()
        self.second_member_at = 10
        self.closed_at = 11

    def _call(self, call):
        data = bytes.fromhex(call['data'][2:])
        sig = data[:4]
        if self.at >= self.closed_at:
            if sig == selector('activePositions()'):
                return '0x'+encode(['uint256'], [1]).hex()
            if sig == selector('ownerOf(uint256)') and int.from_bytes(data[4:], 'big') == 2:
                return '0x'+encode(['address'], [OWNER]).hex()
            if sig == selector('position(uint256)') and int.from_bytes(data[4:], 'big') == 2:
                member = list(decode([POSITION_TYPE], bytes.fromhex(super()._call(call)[2:]))[0])
                member[1] = False
                return '0x'+encode([POSITION_TYPE], [member]).hex()
        return super()._call(call)


class PerformanceHistoryAuditTests(unittest.TestCase):
    def start(self, rpc, tokens):
        raw = CanonicalCollector(rpc)
        financial = FinancialCollector(rpc)
        baseline = raw.capture(OWNER, VAULT, tokens, CODE_HASH)
        point = financial.capture_point(baseline, baseline.baseline)
        self.assertEqual(point.status, 'complete')
        return raw, financial, baseline, open_history(baseline, point)

    def advance(self, rpc, raw, financial, baseline, state, through):
        rpc.finalized = through
        page = raw.collect(baseline, state.cursor)
        observed = financial.capture_points(baseline, page, state.knownTokenIds)
        return reduce_history(baseline, state, observed, [])

    def test_root_round_trip_transfer_does_not_prove_continuous_ownership(self):
        rpc = FinancialRpc()
        raw, financial, baseline, state = self.start(rpc, ['1'])
        # Identical owner and liquidity at both block endpoints. The swap
        # happened while another holder owned the NFT, which must not silently
        # become old-owner income merely because the NFT returned later.
        rpc.add_transaction(logs=[transfer_log(OWNER, NEXT_OWNER), pool_log(),
                                  transfer_log(NEXT_OWNER, OWNER)])
        next_state, delta = self.advance(rpc, raw, financial, baseline, state, 11)
        self.assertEqual(next_state.lastPoint.members[0].holder, OWNER)
        observed = delta['slices'][0]
        self.assertFalse(observed['incomeComplete'])
        self.assertEqual(observed['credits'], [])
        self.assertTrue(observed['issues'])
        self.assertNotIn('tradingAccrual', next_state.cumulativeKnown)

    def test_proven_child_exit_does_not_permanently_poison_remaining_assets(self):
        rpc = ClosedChildRpc()
        raw, financial, baseline, state = self.start(rpc, ['1', '2'])
        exit_log = {'address': VAULT, 'topics': [CHILD_EXIT, hash_(2), topic(OWNER)],
                    'data': '0x'+encode(['uint64'], [2]).hex()}
        rpc.add_transaction(block=11, logs=[transfer_log(VAULT, OWNER, 2), exit_log, pool_log()])
        state, transition = self.advance(rpc, raw, financial, baseline, state, 11)
        self.assertFalse(transition['slices'][0]['incomeComplete'])
        self.assertEqual(next(m for m in state.members if m.tokenId == '2').endsAt, 1011)

        # The next block has no ownership ambiguity. The withdrawn NFT's core
        # capital is excluded, while BOTH old fee-source reserves remain in the
        # one actual vault residual. It must not need a new management baseline.
        rpc.add_transaction(block=12, logs=[pool_log()])
        next_state, following = self.advance(rpc, raw, financial, baseline, state, 12)
        observed = following['slices'][0]
        self.assertTrue(observed['incomeComplete'], observed['issues'])
        self.assertTrue(observed['capitalComplete'])
        self.assertEqual({c['tokenId'] for c in observed['capital']}, {'1', None})
        residual = next(c for c in observed['capital'] if c['tokenId'] is None)
        self.assertEqual(residual['amountsRaw'], dict(zip(state.lastPoint.currencies, state.lastPoint.heldRaw)))
        self.assertEqual(next_state.startedAt, baseline.baseline.timestamp)
        self.assertEqual({c['tokenId'] for c in observed['credits']}, {'1'})
        self.assertTrue(all(c['kind'] == 'new_trading_fee' for c in observed['credits']))


if __name__ == '__main__':
    unittest.main()
