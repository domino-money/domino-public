"""Bounded acquisition tests; fake RPC is not deployment/provider qualification."""
from copy import deepcopy
from pathlib import Path
import sys
import unittest

from eth_abi import decode, encode
from eth_hash.auto import keccak

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from performance_collection import CanonicalCollector, CollectionError, ReorgDetected
from performance_financial_collection import (FinancialCollector, FinancialPage, FinancialPoint,
    REGISTERED, SOURCE_TYPE, FEE_BALANCE_TYPE, SWAP, DONATE, MODIFY)
from test_performance_collection import (FakePerformanceRpc, OWNER, VAULT, NEXT_OWNER, CODE_HASH, CODE,
    POOL_ID, TOKEN, KEY, hash_, topic, vault_log, transfer_log)
from discovery import POOL_MANAGER, POSITION_MANAGER, ZERO
from v4_math import Q128


def selector(signature): return keccak(signature.encode())[:4]

def pool_log(kind=SWAP, *, pool=POOL_ID, token=1, sender=POSITION_MANAGER):
    if kind == MODIFY:
        types, values = ['int24', 'int24', 'int256', 'bytes32'], [-60, 60, 0, bytes.fromhex(hash_(token)[2:])]
    elif kind == DONATE:
        types, values = ['uint256', 'uint256'], [100, 200]
    else:
        types, values = ['int128', 'int128', 'uint160', 'uint128', 'int24', 'uint24'], [100, -90, 1<<96, 1000, 0, 3000]
    return {'address':POOL_MANAGER, 'topics':[kind, pool, topic(sender)], 'data':'0x'+encode(types, values).hex()}


class FinancialRpc(FakePerformanceRpc):
    def __init__(self):
        super().__init__()
        self.at = 10
        self.version = 3
        self.helper, self.engine = '0x'+'47'*20, '0x'+'48'*20
        self.code.update({self.helper:CODE, self.engine:CODE})
        self.burned = set()
        self.failed_selectors = set()
        self.residual = 0
        self.second_member_at = None
        self.accounted_override = None

    def request(self, method, params):
        if method == 'eth_call':
            self.at = int(params[1]['blockHash'], 16)
            if bytes.fromhex(params[0]['data'][2:10]) in self.failed_selectors:
                raise RuntimeError('sensitive-endpoint-message')
        return super().request(method, params)

    def _call(self, call):
        data = bytes.fromhex(call['data'][2:]); sig = data[:4]
        if sig == selector('implementationVersion()'): return '0x'+encode(['uint64'], [self.version]).hex()
        if sig in (selector('readHelper()'), selector('compoundEngine()')):
            return '0x'+encode(['address'], [self.helper if sig == selector('readHelper()') else self.engine]).hex()
        if sig == selector('source(bytes32)'):
            source = int.from_bytes(data[4:], 'big')
            number, index = (source-93)//100+1, (source-93)%100
            value = (True, number, KEY[index], bytes.fromhex(hash_(92+100*(number-1))[2:]))
            return '0x'+encode([SOURCE_TYPE], [value]).hex()
        if sig == selector('feeBalance(bytes32,address)'):
            source, currency = decode(['bytes32', 'address'], data[4:])
            index = (int.from_bytes(source, 'big')-93)%100
            return '0x'+encode([FEE_BALANCE_TYPE], [(5,2) if currency == KEY[index] else (0,0)]).hex()
        if sig == selector('accountedCurrency(address)'):
            count = 2 if self.second_member_at is not None and self.at >= self.second_member_at else 1
            amount = 7*count+self.residual if self.accounted_override is None else self.accounted_override
            return '0x'+encode(['uint256'], [amount]).hex()
        if sig == selector('activePositions()') and self.second_member_at is not None:
            return '0x'+encode(['uint256'], [2 if self.at >= self.second_member_at else 1]).hex()
        if sig == selector('position(uint256)'):
            raw = super()._call(call)
            from performance_collection import POSITION_TYPE
            number, = decode(['uint256'], data[4:])
            value = list(decode([POSITION_TYPE], bytes.fromhex(raw[2:]))[0])
            value[7:] = [bytes.fromhex(hash_(n+100*(number-1))[2:]) for n in (91,92,93,94)]
            return '0x'+encode([POSITION_TYPE], [value]).hex()
        if sig == selector('ownerOf(uint256)') and int.from_bytes(data[4:], 'big') in self.burned:
            raise RuntimeError('ownerOf reverted')
        if sig == selector('getPoolAndPositionInfo(uint256)') and int.from_bytes(data[4:], 'big') in self.burned:
            return '0x'+encode(['(address,address,uint24,int24,address)','uint256'], [KEY,0]).hex()
        if sig == selector('getFeeGrowthInside(bytes32,int24,int24)'):
            return '0x'+encode(['uint256','uint256'], [Q128//2+(self.at-10)*Q128//10, 0]).hex()
        return super()._call(call)


class FinancialCollectionTests(unittest.TestCase):
    def setUp(self):
        self.rpc = FinancialRpc()
        self.raw = CanonicalCollector(self.rpc)
        self.collector = FinancialCollector(self.rpc)
        self.baseline = self.raw.capture(OWNER, VAULT, ['1'], CODE_HASH)

    def page(self, through=12):
        self.rpc.finalized = through
        return self.raw.collect(self.baseline, self.baseline.baseline)

    def test_opening_exact_growth_sources_and_native_surplus(self):
        point = self.collector.capture_point(self.baseline, self.baseline.baseline)
        self.assertEqual(point.status, 'complete')
        self.assertEqual(point.members[0].insideGrowthX128, [str(Q128//2), '0'])
        self.assertEqual(point.members[0].lastGrowthX128, ['0','0'])
        self.assertEqual(point.members[0].unsettledFeesRaw, ['500','0'])
        self.assertEqual(point.members[0].principalRaw, self.baseline.opening.members[0].principalRaw)
        self.assertEqual(point.nativeSurplusRaw, '23')
        self.assertEqual(point.unattributedAccountedRaw, ['0','0'])
        self.assertEqual(len(point.sources), 4)
        self.assertEqual(FinancialPoint.model_validate(point.model_dump()), point)

    def test_v4_points_preserve_inventory_and_recheck_all_execution_pins(self):
        from test_performance_collection import EXECUTION_ENGINE, ROUTING_HELPER, PRICE_GUARD
        self.rpc.version = 4
        baseline = self.raw.capture(OWNER, VAULT, ['1'], CODE_HASH)
        opening = self.collector.capture_point(baseline, baseline.baseline)
        self.assertEqual(opening.status, 'complete')
        self.assertEqual(opening.members[0].tokenId, '1')
        self.rpc.finalized = 11
        page = self.raw.collect(baseline, baseline.baseline)
        points = self.collector.capture_points(baseline, page)
        self.assertEqual(points.points[0].status, 'complete')
        for target in (EXECUTION_ENGINE, ROUTING_HELPER, PRICE_GUARD):
            self.rpc.code[target] = '0x60016000f3'
            with self.assertRaisesRegex(CollectionError, 'collection_dependency_code_changed'):
                self.collector.capture_points(baseline, page)
            self.rpc.code[target] = CODE

    def test_every_block_and_real_empty_block_growth_are_preserved(self):
        page = self.page(13)
        result = self.collector.capture_points(self.baseline, page)
        self.assertEqual([p.block.blockNumber for p in result.points], [11,12,13])
        self.assertEqual([p.members[0].unsettledFeesRaw[0] for p in result.points], ['599','699','799'])
        self.assertEqual(result.knownTokenIds, ['1'])
        self.assertEqual(FinancialPage.model_validate(result.model_dump()), result)

    def test_pool_filter_excludes_other_pools_and_unrelated_receipts(self):
        swap = self.rpc.add_transaction(logs=[pool_log()])
        donation = self.rpc.add_transaction(logs=[pool_log(DONATE)])
        self.rpc.add_transaction(logs=[pool_log(pool=hash_(999))])
        result = self.collector.capture_points(self.baseline, self.page(11))
        self.assertEqual([p.transactionHash for p in result.poolEvents], [swap, donation])
        self.assertTrue(all(p.receiptLogIndex is None for p in result.poolEvents))
        self.assertEqual(result.receipts, [])
        reads = [params[0] for method, params in self.rpc.calls if method == 'eth_getTransactionReceipt']
        self.assertNotIn(swap, reads); self.assertNotIn(donation, reads)
        queries = [p[0] for m,p in self.rpc.calls if m == 'eth_getLogs' and p[0]['address'] == POOL_MANAGER]
        self.assertEqual(queries[0]['topics'], [[SWAP,DONATE,MODIFY], POOL_ID])

    def test_managed_modify_acquires_full_receipt_and_actual_ordinal(self):
        tx = self.rpc.add_transaction(logs=[{'address':NEXT_OWNER,'topics':[hash_(99)],'data':'0x'}, pool_log(MODIFY)])
        result = self.collector.capture_points(self.baseline, self.page(11))
        self.assertEqual(result.receipts[0].transactionHash, tx)
        self.assertEqual(len(result.receipts[0].logs), 2)
        self.assertEqual(result.poolEvents[0].receiptLogIndex, 1)

    def test_known_raw_receipts_are_rechecked_and_pool_ordinals_filled(self):
        self.rpc.add_transaction(logs=[pool_log(), vault_log()])
        page = self.page(11)
        result = self.collector.capture_points(self.baseline, page)
        self.assertEqual(result.receipts, page.receipts)
        self.assertEqual(result.poolEvents[0].receiptLogIndex, 0)
        page.receipts[0].gasUsed = '1'
        with self.assertRaisesRegex(CollectionError, 'financial_raw_receipt_mismatch'):
            self.collector.capture_points(self.baseline, page)

    def test_query_omission_in_a_relevant_receipt_is_rejected(self):
        self.rpc.add_transaction(logs=[pool_log(), vault_log()])
        page = self.page(11)
        self.rpc.query_omit = True
        with self.assertRaisesRegex(CollectionError, 'incomplete_or_inconsistent_log_query'):
            self.collector.capture_points(self.baseline, page)

    def test_burned_root_retains_reserves_and_child_observation(self):
        self.rpc.second_member_at = 11
        registered = {'address':VAULT, 'topics':[REGISTERED,hash_(2),hash_(192)],
            'data':'0x'+encode(['bytes32','bytes32','uint64'], [bytes.fromhex(hash_(193)[2:]),bytes.fromhex(hash_(194)[2:]),2]).hex()}
        self.rpc.add_transaction(logs=[registered])
        page = self.page(11)
        self.rpc.burned.add(1)
        result = self.collector.capture_points(self.baseline, page)
        point = result.points[0]
        self.assertEqual(result.knownTokenIds, ['1','2'])
        self.assertEqual(point.status, 'partial')
        self.assertIsNone(point.members[0].holder)
        self.assertIsNone(point.members[0].principalRaw)
        self.assertEqual(point.members[1].holder, VAULT)
        self.assertIsNotNone(point.members[1].principalRaw)
        self.assertEqual(point.accountedRaw, ['14','14'])
        self.assertEqual(len(point.sources), 8)
        self.assertEqual(point.unattributedAccountedRaw, ['0','0'])
        self.rpc.finalized = 12
        following = self.raw.collect(self.baseline, page.throughCursor)
        carried = self.collector.capture_points(self.baseline, following, result.knownTokenIds)
        self.assertEqual([m.tokenId for m in carried.points[0].members], ['1','2'])

    def test_missing_source_inventory_is_retained_once(self):
        self.rpc.residual = 3
        point = self.collector.capture_point(self.baseline, self.baseline.baseline)
        self.assertEqual(point.accountedRaw, ['10','10'])
        self.assertEqual(point.unattributedAccountedRaw, ['3','3'])
        self.assertIn('source_inventory_unattributed', point.reasons)
        self.rpc.failed_selectors.add(selector('feeBalance(bytes32,address)'))
        point = self.collector.capture_point(self.baseline, self.baseline.baseline)
        self.assertTrue(all(s.originalRaw is None for s in point.sources))
        self.assertEqual(point.unattributedAccountedRaw, ['10','10'])
        self.assertNotIn('sensitive', str(point.model_dump()))

    def test_holder_change_and_failed_balance_do_not_erase_other_fields(self):
        self.rpc.root_owner = NEXT_OWNER
        self.rpc.failed_selectors.add(selector('balanceOf(address)'))
        point = self.collector.capture_point(self.baseline, self.baseline.baseline)
        self.assertIn('member_holder_changed', point.members[0].reasons)
        self.assertEqual(point.heldRaw, ['30',None])
        self.assertEqual(point.nativeSurplusRaw, '23')
        self.assertEqual(point.accountedRaw, ['7','7'])

    def test_request_budget_is_hard_failure_not_partial_zero(self):
        with self.assertRaisesRegex(CollectionError, 'collection_rpc_budget'):
            FinancialCollector(self.rpc, max_requests=8).capture_point(self.baseline, self.baseline.baseline)

    def test_reorg_pin_changes_and_epoch_mismatch_are_rejected(self):
        page = self.page(11)
        self.rpc.headers[11]['hash'] = hash_(999)
        with self.assertRaises(ReorgDetected): self.collector.capture_points(self.baseline, page)
        self.rpc.headers[11]['hash'] = hash_(11)
        self.rpc.code[self.rpc.engine] = '0x60016000f3'
        with self.assertRaisesRegex(CollectionError, 'collection_dependency_code_changed'):
            self.collector.capture_points(self.baseline, page)
        self.rpc.code[self.rpc.engine] = CODE
        page.owner = NEXT_OWNER
        with self.assertRaisesRegex(CollectionError, 'financial_page_epoch_mismatch'):
            self.collector.capture_points(self.baseline, page)

    def test_models_reject_cross_epoch_and_fabricated_pool_ordinal(self):
        self.rpc.add_transaction(logs=[pool_log()])
        result = self.collector.capture_points(self.baseline, self.page(11))
        raw = result.model_dump(); raw['points'][0]['owner'] = NEXT_OWNER
        with self.assertRaises(ValueError): FinancialPage.model_validate(raw)
        raw = result.model_dump(); raw['poolEvents'][0]['receiptLogIndex'] = 0
        with self.assertRaises(ValueError): FinancialPage.model_validate(raw)


if __name__ == '__main__': unittest.main()
