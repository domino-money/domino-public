"""Actual V4 mint/fund receipts through canonical collection and financial history."""
import os
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

from eth_hash.auto import keccak

sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
import nft_ownership
import performance_collection as raw
from performance_history_worker import FinancialHistoryWorker
from test_performance_history_worker_evm import ReducingJournal
import test_execution_v4_receipts_evm as fixture


@unittest.skipUnless(os.environ.get('DOMINO_TEST_EVM')=='1','requires isolated local Anvil')
class V4PerformanceEvmTests(unittest.TestCase):
    setUpClass=classmethod(fixture.ExecutionV4ReceiptEvmTests.setUpClass.__func__)
    stop=classmethod(fixture.ExecutionV4ReceiptEvmTests.stop.__func__)
    send=fixture.ExecutionV4ReceiptEvmTests.send
    deploy=fixture.ExecutionV4ReceiptEvmTests.deploy
    call=fixture.ExecutionV4ReceiptEvmTests.call
    swaps=fixture.ExecutionV4ReceiptEvmTests.swaps
    setup_vault=fixture.ExecutionV4ReceiptEvmTests.setup_vault
    plan=fixture.ExecutionV4ReceiptEvmTests.plan
    execute=fixture.ExecutionV4ReceiptEvmTests.execute

    def test_actual_created_then_funded_successor_preserves_root_and_fee_origins(self):
        self.setup_vault()
        self.rpc.request('anvil_mine',['0x40'])
        with patch.multiple(raw,POSITION_MANAGER=self.positions,POOL_MANAGER=self.manager,STATE_VIEW=self.state), \
             patch.multiple(nft_ownership,POSITION_MANAGER=self.positions,STATE_VIEW=self.state):
            collector=raw.CanonicalCollector(self.rpc,page_blocks=4,max_requests=2048)
            code=self.rpc.request('eth_getCode',[self.vault,'latest'])
            baseline=collector.capture(self.owner,self.vault,[str(self.token)],'0x'+keccak(bytes.fromhex(code[2:])).hex())
            self.assertEqual(baseline.opening.implementationVersion,4)
            self.assertEqual(len(baseline.opening.codePins),10)
            store=ReducingJournal(baseline)
            worker=FinancialHistoryWorker(self.rpc,store)
            self.assertEqual(worker.advance(self.owner,baseline.epochId).outcome,'captured')
            self.swaps()
            first,created=self.execute(self.plan(3,10**10))
            child=created['destinationTokenId']
            self.swaps()  # The second intent's collection caps admit only new fees.
            second,funded=self.execute(self.plan(2,10**10).model_copy(update={'destinationTokenId':child}))
            cursor=baseline.baseline
            for _ in range(96):
                page=collector.collect(baseline,cursor)
                if page is None: break
                store.pages.append(page.model_dump())
                store.epoch.update(cursor=page.throughCursor.model_dump(),revision=store.epoch['revision']+1)
                cursor=page.throughCursor
            else: self.fail('bounded V4 fixture did not catch finalized')
            for _ in store.pages:
                step=worker.advance(self.owner,baseline.epochId)
                self.assertEqual(step.outcome,'advanced',step.record.get('lastError'))
            self.assertEqual(worker.advance(self.owner,baseline.epochId).outcome,'caught_up')
            reports=[r for _,_,rows in store.saved for r in rows]
            self.assertEqual([r['transactionHash'] for r in reports],[first['transactionHash'],second['transactionHash']])
            self.assertEqual(store.head['state']['incompleteBlocks'],0)
            self.assertEqual({m['tokenId'] for m in store.head['state']['members']},{str(self.token),child})
            self.assertEqual(next(m for m in store.head['state']['lastPoint']['members'] if m['isRoot'])['holder'],self.owner)
            totals=store.head['state']['cumulativeKnown']
            for currency in baseline.opening.currencies:
                self.assertGreater(int(totals['tradingAccrual'][currency]),0)
                expected=sum(int(row['serviceFeeRaw']) for report in reports for row in report['applications'] if row['currency']==currency)
                self.assertEqual(int(totals['serviceFees'][currency]),expected)
            self.assertEqual(reports[0]['applications'],list(created['applications']))
            self.assertEqual(reports[1]['applications'],list(funded['applications']))


if __name__=='__main__': unittest.main()
