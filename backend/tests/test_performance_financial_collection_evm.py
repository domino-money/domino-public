"""Actual local V3/official-v4 acquisition, without live provider qualification.

Uses the existing pinned deployment helpers and their explicit Anvil synthetic
finalized-tag assumptions. No production signer/configuration is read.
"""
import os
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

from eth_hash.auto import keccak

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import nft_ownership
import performance_collection as raw
from performance_financial_collection import FinancialCollector, FinancialPage, MODIFY, SWAP
import test_general_compound_receipts_evm as fixture


@unittest.skipUnless(os.environ.get('DOMINO_TEST_EVM') == '1', 'requires isolated local Anvil')
class FinancialCollectionEvmTests(unittest.TestCase):
    setUpClass = classmethod(fixture.CompoundReceiptEvmTests.setUpClass.__func__)
    stop = classmethod(fixture.CompoundReceiptEvmTests.stop.__func__)
    send = fixture.CompoundReceiptEvmTests.send
    deploy = fixture.CompoundReceiptEvmTests.deploy
    call = fixture.CompoundReceiptEvmTests.call
    setup_vault = fixture.CompoundReceiptEvmTests.setup_vault
    swaps = fixture.CompoundReceiptEvmTests.swaps
    compound = fixture.CompoundReceiptEvmTests.compound

    def _flow(self, native):
        self.setup_vault(native=native)
        self.rpc.request('anvil_mine', ['0x40'])
        # The discovery adapter is deliberately bound to Robinhood's deployed
        # addresses. These test-only patches select the actual local contracts.
        with patch.multiple(raw, POSITION_MANAGER=self.positions, POOL_MANAGER=self.manager, STATE_VIEW=self.state), \
             patch.multiple(nft_ownership, POSITION_MANAGER=self.positions, STATE_VIEW=self.state):
            collector = raw.CanonicalCollector(self.rpc, page_blocks=16)
            financial = FinancialCollector(self.rpc)
            runtime = self.rpc.request('eth_getCode', [self.vault, 'latest'])
            baseline = collector.capture(self.owner, self.vault, [str(self.token)],
                                         '0x'+keccak(bytes.fromhex(runtime[2:])).hex())
            self.assertEqual(baseline.opening.implementationVersion, 3)
            self.assertEqual(len(baseline.opening.codePins), 8)
            opening = financial.capture_point(baseline, baseline.baseline)
            self.assertEqual(opening.status, 'complete')
            self.assertEqual(opening.members[0].unsettledFeesRaw, ['0','0'])
            self.swaps()
            plan, receipt, verified = self.compound(5*10**13)
            # A direct native donation to an ERC20-pair vault must remain a
            # third held asset, without entering accounted fee balances.
            if not native:
                self.send(self.vault, value=12345)
                self.rpc.request('anvil_mine', ['0x40'])
            cursor, points, pool_events, receipts = baseline.baseline, [], [], []
            for _ in range(20):
                page = collector.collect(baseline, cursor)
                if page is None: break
                result = financial.capture_points(baseline, page)
                self.assertEqual([p.block for p in result.points], page.headers)
                self.assertEqual(FinancialPage.model_validate(result.model_dump()), result)
                self.assertTrue(all(point.status == 'complete' for point in result.points))
                points.extend(result.points); pool_events.extend(result.poolEvents); receipts.extend(result.receipts)
                cursor = page.throughCursor
            else: self.fail('local bounded pages did not catch up')
            number = int(receipt['blockNumber'],16)
            after = next(point for point in points if point.block.blockNumber == number)
            self.assertEqual(after.members[0].liquidityRaw, verified['liquidityAfterRaw'])
            self.assertEqual(after.members[0].unsettledFeesRaw, ['0','0'])
            self.assertEqual(after.members[0].registrationCheckpoint, opening.members[0].registrationCheckpoint)
            for effect in verified['sources']:
                row = next(source for source in after.sources if source.sourceId == effect['sourceId']
                           and source.currency == effect['currency'])
                self.assertEqual(row.originalRaw, effect['originalAfterRaw'])
                self.assertEqual(row.chargedRaw, effect['chargedAfterRaw'])
            self.assertEqual(after.unattributedAccountedRaw, ['0','0'])
            self.assertEqual(sum(log.topics[0] == SWAP for log in pool_events), 2)
            modified = [log for log in pool_events if log.topics[0] == MODIFY]
            self.assertEqual(len(modified), 2)
            self.assertTrue(all(log.receiptLogIndex is not None for log in modified))
            actual = next(item for item in receipts if item.transactionHash == receipt['transactionHash'])
            self.assertEqual(len(actual.logs), len(receipt['logs']))
            self.assertEqual(actual.rawTransaction['input'], plan.calldata())
            if not native:
                self.assertEqual(points[-1].nativeHeldRaw, '12345')
                self.assertEqual(points[-1].nativeSurplusRaw, '12345')
                self.assertEqual(points[-1].accountedRaw, after.accountedRaw)

    def test_actual_erc20_v3_forward_points_compound_receipt_and_third_asset(self):
        self._flow(False)

    def test_actual_native_v3_forward_points_compound_receipt(self):
        self._flow(True)


if __name__ == '__main__': unittest.main()
