"""Real PostgreSQL enrollment fences, visibility leases and collector restart."""
from copy import deepcopy
import os
from pathlib import Path
import sys
import unittest

sys.path[:0]=[str(Path(__file__).resolve().parents[1]),str(Path(__file__).resolve().parent)]
import psycopg
from psycopg.rows import dict_row
from dev_postgres import ADMIN,PORT,SOCKET,ROOT
from performance_enrollment import EnrollmentStore
from performance_store import PerformanceStore,PerformanceStoreError,COLLECTOR_ROLE,READER_ROLE
from performance_history_store import FinancialHistoryStore
from performance_producer import PerformanceProducer,ProducerRpc
from test_performance_store import OWNER,OTHER,baseline,h


@unittest.skipUnless(os.environ.get('DOMINO_TEST_POSTGRES')=='1','requires task-local PostgreSQL')
class EnrollmentTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.settings={'host':str(SOCKET),'port':PORT,'dbname':'domino_catalogue_tests'}
        with psycopg.connect(**cls.settings,user=ADMIN) as conn:
            conn.execute((ROOT/'migrations/018_performance_enrollment.sql').read_text())

    def setUp(self):
        self.admin=psycopg.connect(**self.settings,user=ADMIN,autocommit=True,row_factory=dict_row)
        self.addCleanup(self.admin.close)
        self.admin.execute('TRUNCATE domino_performance.epochs CASCADE')
        self.store=EnrollmentStore(self.settings,role=COLLECTOR_ROLE)
        self.base=baseline()
        self.body={'vault':self.base.vault,'tokenIds':self.base.tokenIds}

    def enroll(self): return self.store.enroll(OWNER,self.body,self.base.vaultCodeHash)

    def expire(self, **changes):
        # Synthetic scheduler time movement by the disposable cluster's DDL owner.
        for field in changes:
            self.assertIn(field,('lease_until','visible_until','due_at'))
        self.admin.execute('UPDATE domino_performance.enrollments SET '+','.join(f"{field}=clock_timestamp()-interval '1 second'" for field in changes)+',revision=revision+1')

    def test_atomic_binding_and_repeated_enrollment_preserve_opening_across_restart(self):
        first=self.enroll(); job=self.store.claim(OWNER)
        saved=self.store.bind_baseline(OWNER,job,self.base)
        # A crash after atomic commit leaves the epoch bound. A replacement lease
        # must resume that epoch, not capture a later baseline.
        self.expire(lease_until=True)
        restarted=EnrollmentStore(self.settings,role=COLLECTOR_ROLE)
        resumed=restarted.claim(OWNER)
        self.assertEqual(resumed['epoch_id'],self.base.epochId)
        self.assertNotEqual(resumed['lease_id'],job['lease_id'])
        with self.assertRaises(PerformanceStoreError): self.store.finish(OWNER,job,'failed')
        restarted.finish(OWNER,resumed,'success')
        again=self.enroll()
        self.assertEqual((first['enrollmentId'],again['epochId']),(again['enrollmentId'],self.base.epochId))
        self.assertEqual(PerformanceStore(self.settings).read_epoch(OWNER,self.base.epochId)['baseline'],saved['baseline'])
        self.assertEqual(self.admin.execute('SELECT count(*) AS n FROM domino_performance.epochs').fetchone()['n'],1)

    def test_binding_failure_rolls_back_both_epoch_and_queue(self):
        self.enroll(); job=self.store.claim(OWNER)
        other=baseline(OTHER)
        with self.assertRaises(PerformanceStoreError): self.store.bind_baseline(OWNER,job,other)
        self.assertEqual(self.admin.execute('SELECT count(*) AS n FROM domino_performance.epochs').fetchone()['n'],0)
        self.assertIsNone(self.store.visible(OWNER)['enrollments'][0]['epochId'])

    def test_owner_rls_unknown_subject_and_expired_visibility_prevent_work(self):
        self.enroll()
        self.assertEqual(self.store.visible(OTHER)['enrollments'],[])
        self.assertIsNone(self.store.claim(OTHER))
        with psycopg.connect(**self.settings,user=READER_ROLE,autocommit=True) as conn:
            self.assertEqual(conn.execute('SELECT count(*) FROM domino_performance.enrollments').fetchone()[0],0)
        self.expire(visible_until=True)
        self.assertIsNone(self.store.claim(OWNER))
        self.store.visible(OWNER)
        self.assertIsNotNone(self.store.claim(OWNER))

    def test_failed_reads_are_delayed_60_seconds_without_erasing_a_bound_epoch(self):
        self.enroll(); job=self.store.claim(OWNER)
        self.store.bind_baseline(OWNER,job,self.base)
        self.store.finish(OWNER,job,'failed')
        row=self.store.visible(OWNER)['enrollments'][0]
        self.assertEqual((row['status'],row['reason'],row['epochId']),('stale','collection_failed',self.base.epochId))
        self.assertIsNone(self.store.claim(OWNER))
        delay=self.admin.execute('SELECT extract(epoch FROM due_at-updated_at) AS seconds FROM domino_performance.enrollments').fetchone()['seconds']
        self.assertGreater(delay,59)

    def test_duplicate_claim_and_foreign_finish_cannot_take_a_live_lease(self):
        self.enroll(); job=self.store.claim(OWNER)
        self.assertIsNone(self.store.claim(OWNER))
        with self.assertRaises(PerformanceStoreError): self.store.finish(OTHER,job,'failed')
        self.store.finish(OWNER,job,'failed')

    def test_real_collectors_persist_raw_and_financial_pages_under_the_enrollment(self):
        from test_performance_financial_collection import FinancialRpc,pool_log
        from test_performance_collection import OWNER as chain_owner,VAULT,CODE_HASH
        rpc=FinancialRpc(); clock=[60]
        bounded=ProducerRpc(rpc,maximum=2048,clock=lambda:clock[0]); bounded.ready_at=60
        enrollment=self.store.enroll(chain_owner,{'vault':VAULT,'tokenIds':['1']},CODE_HASH)
        producer=PerformanceProducer(bounded,self.store,PerformanceStore(self.settings,role=COLLECTOR_ROLE),
            FinancialHistoryStore(self.settings,role=COLLECTOR_ROLE),[chain_owner],max_requests=256)
        self.assertEqual(producer.tick(),'advanced')
        epoch=self.store.visible(chain_owner)['enrollments'][0]['epochId']
        original=PerformanceStore(self.settings).read_epoch(chain_owner,epoch)
        rpc.add_transaction(logs=[pool_log()]); rpc.finalized=11
        self.expire(due_at=True)
        self.assertEqual(producer.tick(),'advanced')
        bundle=FinancialHistoryStore(self.settings).read_financial_window(chain_owner,epoch)
        self.assertEqual(bundle['epoch']['cursor']['blockNumber'],11)
        self.assertEqual(bundle['financial']['cursor']['blockNumber'],11)
        self.assertEqual(bundle['epoch']['baseline'],original['baseline'])
        self.assertEqual(len(bundle['deltas']),1)
        rpc.fail_method='eth_getBlockByNumber'; self.expire(due_at=True)
        self.assertEqual(producer.tick(),'failed')
        retained=FinancialHistoryStore(self.settings).read_financial_window(chain_owner,epoch)
        self.assertEqual(retained['financial']['cursor'],bundle['financial']['cursor'])

    def test_120_blocks_per_minute_for_three_minutes_and_bounded_catchup(self):
        from test_performance_financial_collection import FinancialRpc
        from test_performance_collection import OWNER as chain_owner,VAULT,CODE_HASH,hash_
        rpc=FinancialRpc()
        rpc.headers={n:{'number':hex(n),'hash':hash_(n),'parentHash':hash_(n-1),
            'timestamp':hex(1000+n//2),'transactions':[]} for n in range(1,801)}
        clock=[60]
        bounded=ProducerRpc(rpc,maximum=8192,clock=lambda:clock[0]); bounded.ready_at=60
        self.store.enroll(chain_owner,{'vault':VAULT,'tokenIds':['1']},CODE_HASH)
        raw=PerformanceStore(self.settings,role=COLLECTOR_ROLE)
        financial=FinancialHistoryStore(self.settings,role=COLLECTOR_ROLE)
        producer=PerformanceProducer(bounded,self.store,raw,financial,[chain_owner],page_blocks=4,max_requests=1024)
        self.assertEqual(producer.tick(),'advanced')
        epoch=self.store.visible(chain_owner)['enrollments'][0]['epochId']
        opening=raw.read_epoch(chain_owner,epoch)['baseline']
        for second in range(1,181):
            clock[0]=60+second; rpc.finalized=10+2*second
            self.expire(due_at=True)
            self.assertEqual(producer.tick(),'advanced')
            self.assertEqual(financial.next_financial_page(chain_owner,epoch)['financial']['cursor']['blockNumber'],rpc.finalized)
        # Thirty seconds without work creates a real 60-block durable backlog;
        # finalized keeps advancing at two blocks/s while four-block pages catch up.
        caught=False
        for second in range(211,252):
            clock[0]=60+second; rpc.finalized=10+2*second
            self.expire(due_at=True)
            self.assertEqual(producer.tick(),'advanced')
            head=financial.next_financial_page(chain_owner,epoch)['financial']['cursor']['blockNumber']
            if head==rpc.finalized:
                caught=True; break
        self.assertTrue(caught,'configured pages must recover the backlog while the chain keeps advancing')
        self.assertEqual(raw.read_epoch(chain_owner,epoch)['baseline'],opening)
        self.assertLessEqual(len(bounded.calls),8192)

    def test_budget_exhaustion_after_raw_commit_resumes_that_financial_page(self):
        from unittest.mock import patch
        from test_performance_financial_collection import FinancialRpc
        from test_performance_collection import OWNER as chain_owner,VAULT,CODE_HASH
        rpc=FinancialRpc(); clock=[60]
        budget=ProducerRpc(rpc,maximum=2048,clock=lambda:clock[0]); budget.ready_at=60
        self.store.enroll(chain_owner,{'vault':VAULT,'tokenIds':['1']},CODE_HASH)
        raw=PerformanceStore(self.settings,role=COLLECTOR_ROLE)
        financial=FinancialHistoryStore(self.settings,role=COLLECTOR_ROLE)
        producer=PerformanceProducer(budget,self.store,raw,financial,[chain_owner])
        self.assertEqual(producer.tick(),'advanced')
        epoch=self.store.visible(chain_owner)['enrollments'][0]['epochId']
        opening=raw.read_epoch(chain_owner,epoch)['baseline']
        rpc.finalized=14; budget.maximum=len(budget.calls)+40
        self.expire(due_at=True)
        self.assertEqual(producer.tick(),'failed')
        retained=financial.next_financial_page(chain_owner,epoch)
        self.assertEqual(retained['epoch']['cursor']['blockNumber'],14)
        self.assertEqual(retained['financial']['cursor']['blockNumber'],10)
        self.assertIsNotNone(retained['page'])
        # New producer, same persistent quota; expiration permits the next step.
        clock[0]=121; budget.maximum=2048; self.expire(due_at=True)
        resumed=PerformanceProducer(budget,self.store,raw,financial,[chain_owner])
        with patch.object(resumed.raw,'advance',side_effect=AssertionError('raw must not starve persisted financial work')):
            self.assertEqual(resumed.tick(),'advanced')
        final=financial.next_financial_page(chain_owner,epoch)
        self.assertEqual(final['financial']['cursor']['blockNumber'],14)
        self.assertEqual(final['epoch']['baseline'],opening)
        self.assertIsNone(final['page'])


if __name__=='__main__': unittest.main()
