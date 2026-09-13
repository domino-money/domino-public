"""Actual V3 compound discovery through worker, verifier and financial reducer.

Only the in-memory journal's persistence is synthetic. Deployment, exact calldata,
canonical RPC receipts, fee growth, settlement and reducer inputs are acquired
from pinned official v4 contracts on the isolated local EVM.
"""
import os
from copy import deepcopy
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

from eth_hash.auto import keccak
from eth_abi import encode

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import nft_ownership
import performance_collection as raw
from performance_history import open_history, reduce_history
from performance_history_worker import FinancialHistoryWorker
import test_general_compound_receipts_evm as fixture
from test_performance_history_worker import Journal


class ReducingJournal(Journal):
    def create_financial_history(self, owner, epoch, revision, generation, point):
        result = super().create_financial_history(owner,epoch,revision,generation,point)
        self.head['state'] = open_history(self.epoch['baseline'],point).model_dump(mode='json')
        result['state'] = self.head['state']
        return result

    def append_financial_page(self, owner, epoch, revision, generation, financial_revision, raw_page, financial, reports):
        state, delta = reduce_history(self.epoch['baseline'],self.head['state'],financial,reports)
        result = super().append_financial_page(owner,epoch,revision,generation,financial_revision,raw_page,financial,reports)
        self.head['state'] = state.model_dump(mode='json')
        result['state'] = self.head['state']
        return result


@unittest.skipUnless(os.environ.get('DOMINO_TEST_EVM') == '1', 'requires isolated local Anvil')
class FinancialHistoryWorkerEvmTests(unittest.TestCase):
    setUpClass = classmethod(fixture.CompoundReceiptEvmTests.setUpClass.__func__)
    stop = classmethod(fixture.CompoundReceiptEvmTests.stop.__func__)
    send = fixture.CompoundReceiptEvmTests.send
    deploy = fixture.CompoundReceiptEvmTests.deploy
    call = fixture.CompoundReceiptEvmTests.call
    setup_vault = fixture.CompoundReceiptEvmTests.setup_vault
    swaps = fixture.CompoundReceiptEvmTests.swaps
    compound = fixture.CompoundReceiptEvmTests.compound

    def flow(self, *, native, old_fees):
        self.setup_vault(native=native)
        if old_fees: self.swaps()
        self.rpc.request('anvil_mine',['0x40'])
        with patch.multiple(raw, POSITION_MANAGER=self.positions, POOL_MANAGER=self.manager, STATE_VIEW=self.state), \
             patch.multiple(nft_ownership, POSITION_MANAGER=self.positions, STATE_VIEW=self.state):
            collector = raw.CanonicalCollector(self.rpc,page_blocks=4)
            runtime = self.rpc.request('eth_getCode',[self.vault,'latest'])
            baseline = collector.capture(self.owner,self.vault,[str(self.token)],
                                         '0x'+keccak(bytes.fromhex(runtime[2:])).hex())
            store = ReducingJournal(baseline)
            worker = FinancialHistoryWorker(self.rpc,store)
            self.assertEqual(worker.advance(self.owner,baseline.epochId).outcome,'captured')
            opening = store.head['opening']
            pending = opening['members'][0]['unsettledFeesRaw']
            self.assertEqual(any(int(v)>0 for v in pending),old_fees)
            if not old_fees: self.swaps()
            _, first_receipt, first_verified = self.compound(5*10**13)
            _, second_receipt, second_verified = self.compound(10**12)
            self.assertEqual(second_verified['collections'],())
            cursor = baseline.baseline
            for _ in range(64):
                page = collector.collect(baseline,cursor)
                if page is None: break
                store.pages.append(page.model_dump())
                store.epoch.update(cursor=page.throughCursor.model_dump(),revision=store.epoch['revision']+1)
                cursor = page.throughCursor
            else: self.fail('raw journal did not catch up within bounded fixture')
            raw_before = dict(store.epoch)
            tried_bad_read = False
            for _ in range(len(store.pages)):
                next_page = store.next_financial_page(self.owner,baseline.epochId)['page']
                if not native and not tried_bad_read and any(
                        receipt['transactionHash']==first_receipt['transactionHash'] for receipt in next_page['receipts']):
                    original_rpc = self.rpc
                    class BadNonceRead:
                        def request(self,method,params):
                            if method == 'eth_call' and params[0]['data'][:10] == fixture.calldata('stateNonce()'):
                                return '0x'+encode(['uint64'],[0]).hex()
                            return original_rpc.request(method,params)
                    before = deepcopy(store.head['cursor'])
                    failed = FinancialHistoryWorker(BadNonceRead(),store).advance(self.owner,baseline.epochId)
                    self.assertEqual(failed.outcome,'read_failed')
                    self.assertEqual(failed.record['lastError'],'financial_compound_verification_failed')
                    self.assertEqual(failed.record['cursor'],before)
                    self.assertEqual(store.epoch,raw_before)
                    tried_bad_read = True
                step = worker.advance(self.owner,baseline.epochId)
                self.assertEqual(step.outcome,'advanced',str(step.record.get('lastError')))
            self.assertEqual(worker.advance(self.owner,baseline.epochId).outcome,'caught_up')
            self.assertEqual(store.epoch,raw_before)
            reports = [report for _,_,items in store.saved for report in items]
            self.assertEqual([r['transactionHash'] for r in reports],
                             [first_receipt['transactionHash'],second_receipt['transactionHash']])
            self.assertTrue(all(type(credit) is dict for report in reports for credit in report['collections']))
            self.assertEqual(reports[0]['collections'],[c.model_dump(mode='json') for c in first_verified['collections']])
            self.assertEqual(reports[1]['collections'],[])
            self.assertTrue(all(report['gas']['strategyDebitApplied'] is False for report in reports))
            self.assertEqual(store.head['state']['incompleteBlocks'],0)
            totals = store.head['state']['cumulativeKnown']
            for index,currency in enumerate(baseline.opening.currencies):
                realized = sum(int(report['sources'][index]['realizedRaw']) for report in reports)
                fees = sum(int(report['sources'][index]['serviceFeeRaw']) for report in reports)
                self.assertEqual(int(totals['realized'][currency]),realized)
                self.assertEqual(int(totals['serviceFees'][currency]),fees)
                self.assertGreater(fees,0)
                if old_fees:
                    self.assertEqual(int(totals.get('tradingAccrual',{}).get(currency,'0')),0)
                else:
                    self.assertGreater(int(totals['tradingAccrual'][currency]),0)
            return store,baseline

    def test_real_erc20_new_fee_compound_then_waiting_reserve(self):
        self.flow(native=False,old_fees=False)

    def test_real_native_opening_fees_are_not_new_income_when_collected(self):
        self.flow(native=True,old_fees=True)


if __name__ == '__main__': unittest.main()

@unittest.skipUnless(os.environ.get('DOMINO_TEST_POSTGRES') == '1' and os.environ.get('DOMINO_TEST_EVM') == '1',
                     'requires isolated PostgreSQL and local Anvil')
class FinancialHistoryPersistedEvmTests(unittest.TestCase):
    setUpClass = classmethod(fixture.CompoundReceiptEvmTests.setUpClass.__func__)
    stop = classmethod(fixture.CompoundReceiptEvmTests.stop.__func__)
    send = fixture.CompoundReceiptEvmTests.send
    deploy = fixture.CompoundReceiptEvmTests.deploy
    call = fixture.CompoundReceiptEvmTests.call
    setup_vault = fixture.CompoundReceiptEvmTests.setup_vault
    swaps = fixture.CompoundReceiptEvmTests.swaps
    compound = fixture.CompoundReceiptEvmTests.compound

    def test_real_compound_worker_persists_then_restarts_without_duplicate_income(self):
        import psycopg
        from dev_postgres import ADMIN, SOCKET, PORT
        from performance_history_store import FinancialHistoryStore
        from performance_store import COLLECTOR_ROLE
        settings={'host':str(SOCKET),'port':PORT,'dbname':'domino_catalogue_tests'}
        admin=psycopg.connect(**settings,user=ADMIN,autocommit=True)
        self.addCleanup(admin.close)
        admin.execute('TRUNCATE domino_performance.epochs CASCADE')
        self.setup_vault(native=False)
        self.rpc.request('anvil_mine',['0x40'])
        with patch.multiple(raw,POSITION_MANAGER=self.positions,POOL_MANAGER=self.manager,STATE_VIEW=self.state), \
             patch.multiple(nft_ownership,POSITION_MANAGER=self.positions,STATE_VIEW=self.state):
            collector=raw.CanonicalCollector(self.rpc,page_blocks=4)
            runtime=self.rpc.request('eth_getCode',[self.vault,'latest'])
            baseline=collector.capture(self.owner,self.vault,[str(self.token)],'0x'+keccak(bytes.fromhex(runtime[2:])).hex())
            store=FinancialHistoryStore(settings,role=COLLECTOR_ROLE)
            epoch=store.create_epoch(baseline)
            worker=FinancialHistoryWorker(self.rpc,store)
            self.assertEqual(worker.advance(self.owner,baseline.epochId).outcome,'captured')
            self.swaps()
            _,receipt,verified=self.compound(5*10**13)
            cursor=baseline.baseline
            for _ in range(64):
                page=collector.collect(baseline,cursor)
                if page is None: break
                epoch=store.append_page(self.owner,baseline.epochId,epoch['revision'],page)
                cursor=page.throughCursor
            else: self.fail('raw collection budget')
            for _ in range(64):
                step=worker.advance(self.owner,baseline.epochId)
                if step.outcome=='caught_up': break
                self.assertEqual(step.outcome,'advanced',step.record.get('lastError'))
            else: self.fail('financial collection budget')
            before=FinancialHistoryStore(settings).read_financial_window(self.owner,baseline.epochId)
            reports=[]
            for delta in before['deltas']:
                for span in delta['slices']:
                    reports.extend(span['serviceDebits'])
            for row in verified['sources']:
                self.assertEqual(sum(int(r['raw']) for r in reports if r['currency']==row['currency']),int(row['serviceFeeRaw']))
            self.assertEqual(before['financial']['state']['incompleteBlocks'],0)
            restart=FinancialHistoryWorker(self.rpc,FinancialHistoryStore(settings,role=COLLECTOR_ROLE))
            self.assertEqual(restart.advance(self.owner,baseline.epochId).outcome,'caught_up')
            self.assertEqual(FinancialHistoryStore(settings).read_financial_window(self.owner,baseline.epochId),before)
