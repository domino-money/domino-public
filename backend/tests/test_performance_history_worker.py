"""Worker lifecycle with actual collector reads and a revision-checking journal.

The journal below models atomic fences only; PostgreSQL semantics are tested by
its store suite. Compound success is verified separately against the actual EVM.
"""
from copy import deepcopy
from pathlib import Path
import sys
import unittest

from eth_abi import encode

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from performance_collection import Baseline, CanonicalCollector, CollectionError, Page
from performance_financial_collection import FinancialCollector, FinancialPage, FinancialPoint
from performance_history_worker import FinancialHistoryWorker, decode_compound_plan, _StepRpc
from general_compound_receipts import COMPLETED, CompoundReceiptReconciler
from performance_store import PerformanceStoreError
from test_performance_financial_collection import FinancialRpc
from test_performance_collection import OWNER, NEXT_OWNER, VAULT, CODE_HASH, token_log, vault_log, hash_
import test_general_compound_receipts as compound_fixture


class Journal:
    def __init__(self, baseline, pages=()):
        self.epoch = {'owner':baseline.owner, 'epochId':baseline.epochId, 'baseline':baseline.model_dump(),
            'cursor':(pages[-1].throughCursor if pages else baseline.baseline).model_dump(),
            'revision':len(pages)+1, 'replayGeneration':1, 'status':'active'}
        self.pages = [p.model_dump() for p in pages]
        self.head, self.saved, self.failures = None, [], []
        self.concurrent = False

    def next_financial_page(self, owner, epoch_id):
        if (owner, epoch_id) != (self.epoch['owner'], self.epoch['epochId']):
            raise PerformanceStoreError('performance_not_found')
        page = next((p for p in self.pages if self.head is not None and p['fromCursor']==self.head['cursor']), None)
        return deepcopy({'epoch':self.epoch, 'financial':self.head, 'page':page, 'pageHash':None})

    def _fence(self, owner, epoch, revision, generation, financial_revision=None):
        if ((owner,epoch,revision,generation) != (self.epoch['owner'],self.epoch['epochId'],
                self.epoch['revision'],self.epoch['replayGeneration'])
                or financial_revision is not None and self.head['revision'] != financial_revision):
            raise PerformanceStoreError('performance_version_conflict')

    def create_financial_history(self, owner, epoch, revision, generation, point):
        self._fence(owner,epoch,revision,generation)
        point = FinancialPoint.model_validate(point.model_dump())
        self.head = {'owner':owner,'epochId':epoch,'revision':1,'rawRevision':revision,'replayGeneration':generation,
            'opening':point.model_dump(),'cursor':point.block.model_dump(), 'lastError':None,
            'state':{'cursor':point.block.model_dump(),'knownTokenIds':[m.tokenId for m in point.members]}}
        return deepcopy(self.head)

    def append_financial_page(self, owner, epoch, revision, generation, financial_revision, raw, financial, reports):
        if self.concurrent: self.epoch['revision'] += 1
        self._fence(owner,epoch,revision,generation,financial_revision)
        raw, financial = Page.model_validate(raw.model_dump()), FinancialPage.model_validate(financial.model_dump())
        if raw.fromCursor.model_dump() != self.head['cursor']: raise AssertionError('cursor changed')
        self.saved.append((raw,financial,deepcopy(reports)))
        self.head.update(revision=financial_revision+1, rawRevision=revision,
            cursor=financial.throughCursor.model_dump(), lastError=None,
            state={'cursor':financial.throughCursor.model_dump(),'knownTokenIds':financial.knownTokenIds})
        return deepcopy(self.head)

    def record_financial_failure(self, owner, epoch, revision, generation, financial_revision, code):
        self._fence(owner,epoch,revision,generation,financial_revision)
        self.failures.append(code)
        self.head.update(revision=financial_revision+1,lastError=code)
        return deepcopy(self.head)


class FinancialHistoryWorkerTests(unittest.TestCase):
    def setUp(self):
        self.rpc = FinancialRpc()
        self.raw = CanonicalCollector(self.rpc)
        self.baseline = self.raw.capture(OWNER,VAULT,['1'],CODE_HASH)
        self.rpc.add_transaction(logs=[vault_log()]); self.rpc.finalized = 11
        self.page = self.raw.collect(self.baseline,self.baseline.baseline)
        self.store = Journal(self.baseline,[self.page])
        self.worker = FinancialHistoryWorker(self.rpc,self.store)

    def advance(self): return self.worker.advance(OWNER,self.baseline.epochId)

    def test_captures_then_advances_one_persisted_page_without_raw_mutation(self):
        original = deepcopy(self.store.epoch)
        self.assertEqual(self.advance().outcome,'captured')
        self.assertEqual(self.store.saved,[])
        step = self.advance()
        self.assertEqual(step.outcome,'advanced')
        self.assertEqual(self.store.saved[0][0],self.page)
        self.assertEqual(self.store.saved[0][2],[])
        self.assertEqual(self.store.epoch,original)
        calls = len(self.rpc.calls)
        self.assertEqual(self.advance().outcome,'caught_up')
        self.assertEqual(len(self.rpc.calls),calls)

    def test_read_failure_preserves_cursor_then_retry_advances(self):
        self.advance(); cursor = deepcopy(self.store.head['cursor'])
        self.rpc.fail_method = 'eth_getCode'
        failed = self.advance()
        self.assertEqual(failed.outcome,'read_failed')
        self.assertEqual(failed.record['cursor'],cursor)
        self.assertEqual(failed.record['lastError'],'financial_read_failed')
        self.assertNotIn('secret',str(failed.record))
        self.rpc.fail_method = None
        self.assertEqual(self.advance().outcome,'advanced')
        self.assertEqual(self.store.head['lastError'],None)

    def test_shared_budget_is_hard_limit_for_opening_and_existing_history(self):
        bounded = FinancialHistoryWorker(self.rpc,self.store,max_requests=8)
        before = len(self.rpc.calls)
        step = bounded.advance(OWNER,self.baseline.epochId)
        self.assertEqual(len(self.rpc.calls)-before,8)
        self.assertEqual(step.record['lastError'],'financial_rpc_budget')
        self.assertIsNone(self.store.head)
        self.advance(); cursor = deepcopy(self.store.head['cursor'])
        step = bounded.advance(OWNER,self.baseline.epochId)
        self.assertEqual(step.record['cursor'],cursor)
        self.assertEqual(self.store.failures,['financial_rpc_budget'])

    def test_partial_opening_returns_bounded_failure_without_raw_error_or_head(self):
        before = deepcopy(self.store.epoch)
        self.rpc.residual = 2
        step = self.advance()
        self.assertEqual(step.outcome,'read_failed')
        self.assertEqual(step.record['lastError'],'financial_opening_partial')
        self.assertEqual(self.store.epoch,before)
        self.assertIsNone(self.store.head)

    def test_missing_page_and_foreign_epoch_fail_before_rpc(self):
        self.advance(); self.store.pages=[]
        before = len(self.rpc.calls)
        self.assertEqual(self.advance().record['lastError'],'financial_cursor_gap')
        self.assertEqual(len(self.rpc.calls),before)
        with self.assertRaises(PerformanceStoreError): self.worker.advance(NEXT_OWNER,self.baseline.epochId)
        self.assertEqual(len(self.rpc.calls),before)

    def test_concurrent_raw_writer_is_not_overwritten_by_a_failure_write(self):
        self.advance(); self.store.concurrent=True
        cursor = deepcopy(self.store.head['cursor'])
        with self.assertRaisesRegex(PerformanceStoreError,'performance_version_conflict'): self.advance()
        self.assertEqual(self.store.head['cursor'],cursor)
        self.assertEqual(self.store.failures,[])

    def test_baseline_reorg_does_not_mutate_raw_generation(self):
        self.advance(); original = deepcopy(self.store.epoch)
        self.rpc.headers[10]['hash'] = '0x'+'ff'*32
        step = self.advance()
        self.assertEqual(step.record['lastError'],'financial_reorg_detected')
        self.assertEqual(self.store.epoch,original)
        self.assertEqual(step.record['cursor'],self.baseline.baseline.model_dump())

    def test_pair_transfer_without_any_managed_event_survives_financial_acquisition(self):
        rpc = FinancialRpc(); raw = CanonicalCollector(rpc)
        baseline = raw.capture(OWNER,VAULT,['1'],CODE_HASH)
        tx = rpc.add_transaction(logs=[token_log()]); rpc.finalized=11
        page = raw.collect(baseline,baseline.baseline)
        store = Journal(baseline,[page]); worker = FinancialHistoryWorker(rpc,store)
        worker.advance(OWNER,baseline.epochId); worker.advance(OWNER,baseline.epochId)
        financial = store.saved[0][1]
        self.assertEqual(financial.receipts[0].transactionHash,tx)
        self.assertEqual(financial.receipts[0].logs[0].topics,token_log()['topics'])
        self.assertEqual(store.saved[0][2],[])

    def test_calldata_exact_roundtrip_rejects_trailing_bytes_selector_and_padding(self):
        plan = compound_fixture.Rpc(collection=True).plan
        self.assertEqual(decode_compound_plan(plan.calldata()),plan)
        for value in (None, plan.calldata()+'00', '0x00000000'+plan.calldata()[10:],
                      plan.calldata()[:10+64*4]+'ff'+plan.calldata()[12+64*4:]):
            with self.subTest(value=str(value)[:20]),self.assertRaisesRegex(CollectionError,'financial_calldata_invalid'):
                decode_compound_plan(value)

    def test_v1_v2_never_produce_v3_effects_from_a_completion_topic(self):
        for version in (1,2):
            with self.subTest(version=version):
                rpc = FinancialRpc(); rpc.version=version
                raw = CanonicalCollector(rpc)
                baseline = raw.capture(OWNER,VAULT,['1'],CODE_HASH)
                log = {'address':VAULT,'topics':[COMPLETED,hash_(123),hash_(1)],
                    'data':'0x'+encode(['bytes32','uint128','uint128','uint64','uint64','uint64'],
                        [bytes.fromhex(hash_(124)[2:]),1000,1001,1,1,1]).hex()}
                rpc.add_transaction(logs=[log]); rpc.finalized=11
                page = raw.collect(baseline,baseline.baseline)
                store = Journal(baseline,[page]); worker = FinancialHistoryWorker(rpc,store)
                self.assertEqual(worker.advance(OWNER,baseline.epochId).outcome,'captured')
                step = worker.advance(OWNER,baseline.epochId)
                self.assertEqual(step.record['lastError'],'financial_compound_version_unsupported')
                self.assertEqual(step.record['cursor'],baseline.baseline.model_dump())
                self.assertEqual(store.saved,[])

    def test_budget_transport_rejects_signing_and_changed_receipt(self):
        budget = _StepRpc(self.rpc,2)
        for method in ('eth_sendTransaction','eth_sendRawTransaction','eth_estimateGas','personal_sign'):
            with self.assertRaisesRegex(CollectionError,'financial_method_not_read_only'): budget.request(method,[])
        self.assertEqual(budget.count,0)
        budget.bind_receipts(self.page.receipts)
        self.rpc.receipts[self.page.receipts[0].transactionHash]['gasUsed']='0x1'
        with self.assertRaisesRegex(CollectionError,'financial_receipt_changed'):
            budget.request('eth_getTransactionReceipt',[self.page.receipts[0].transactionHash])

    def test_new_collector_or_verifier_cannot_reset_the_shared_step_budget(self):
        budget = _StepRpc(self.rpc,3)
        before = len(self.rpc.calls)
        FinancialCollector(budget).request('eth_chainId')
        CompoundReceiptReconciler(budget)._request('eth_chainId')
        FinancialCollector(budget).request('eth_chainId')
        with self.assertRaises(ValueError):
            CompoundReceiptReconciler(budget)._request('eth_chainId')
        self.assertEqual(budget.failure,'financial_rpc_budget')
        self.assertEqual(len(self.rpc.calls)-before,3)


if __name__ == '__main__': unittest.main()
