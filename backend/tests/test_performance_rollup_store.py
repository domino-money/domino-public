"""Real owner-RLS SQL queues, bounded materialization, restart and price repair."""
from copy import deepcopy
import os
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

sys.path[:0]=[str(Path(__file__).resolve().parents[1]),str(Path(__file__).resolve().parent)]
import psycopg
from psycopg.rows import dict_row
import price_history as ph
from dev_postgres import ADMIN,PORT,SOCKET,ROOT
from performance_store import PerformanceStore,COLLECTOR_ROLE,READER_ROLE,PerformanceStoreError
from performance_enrollment import EnrollmentStore
from performance_history_store import FinancialHistoryStore
from performance_producer import PerformanceProducer,ProducerRpc
from performance_rollup import project,summarize
from performance_rollup_store import ProjectionStore,ProjectionWorker
from test_performance_financial_collection import FinancialRpc,pool_log
from test_performance_collection import OWNER,NEXT_OWNER,VAULT,CODE_HASH,hash_
import test_performance_history_projection as fixtures


@unittest.skipUnless(os.environ.get('DOMINO_TEST_POSTGRES')=='1','requires task-local PostgreSQL')
class ProjectionStoreTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.settings={'host':str(SOCKET),'port':PORT,'dbname':'domino_catalogue_tests'}
        with psycopg.connect(**cls.settings,user=ADMIN) as conn:
            conn.execute((ROOT/'migrations/018_performance_enrollment.sql').read_text())

    def setUp(self):
        self.admin=psycopg.connect(**self.settings,user=ADMIN,autocommit=True,row_factory=dict_row)
        self.addCleanup(self.admin.close)
        self.admin.execute('TRUNCATE domino_performance.epochs CASCADE')
        self.registry=patch.dict(ph.PRODUCTION_QUALIFICATIONS,{},clear=True)
        self.registry.start();self.addCleanup(self.registry.stop)
        self.queue=EnrollmentStore(self.settings,role=COLLECTOR_ROLE)
        self.raw=PerformanceStore(self.settings,role=COLLECTOR_ROLE)
        self.financial=FinancialHistoryStore(self.settings,role=COLLECTOR_ROLE)
        self.projections=ProjectionStore(self.settings,role=COLLECTOR_ROLE)
        self.reader=ProjectionStore(self.settings)
        self.rpc=FinancialRpc()
        self.rpc.headers={n:{'number':hex(n),'hash':hash_(n),'parentHash':hash_(n-1),
            'timestamp':hex(1000+n),'transactions':[]} for n in range(1,151)}
        budget=ProducerRpc(self.rpc,maximum=32768,clock=lambda:60);budget.ready_at=60
        self.producer=PerformanceProducer(budget,self.queue,self.raw,self.financial,[OWNER],page_blocks=16,max_requests=2048)
        self.queue.enroll(OWNER,{'vault':VAULT,'tokenIds':['1']},CODE_HASH)
        self.assertEqual(self.producer.tick(),'advanced')
        self.epoch=self.queue.visible(OWNER)['enrollments'][0]['epochId']

    def values(self,bundle,price='1'):
        start=bundle['epoch']['baseline']['baseline']['timestamp'];end=bundle['financial']['cursor']['timestamp']
        return fixtures.FinancialHistoryProjectionTests().value(bundle,prices={currency:[(start,price),(end,price)]
            for currency in bundle['epoch']['baseline']['opening']['currencies']})

    def fill(self,projector=None):
        self.producer.projector=projector
        for block in range(11,84):self.rpc.add_transaction(block=block,logs=[pool_log()])
        self.rpc.finalized=83
        for _ in range(8):
            self.admin.execute("UPDATE domino_performance.enrollments SET due_at=clock_timestamp()-interval '1 second',revision=revision+1")
            self.assertIn(self.producer.tick(),('advanced','caught_up'))
            if self.financial.next_financial_page(OWNER,self.epoch)['financial']['cursor']['blockNumber']==83:break
        else:self.fail('bounded fixture did not catch up')

    def drain(self,worker):
        for _ in range(4):
            if worker.advance(OWNER,self.epoch)=='caught_up':return
        self.fail('bounded minute fixture did not catch up')

    def test_producer_materializes_closed_minutes_and_reader_only_loads_two_edges(self):
        worker=ProjectionWorker(self.projections,self.values)
        self.fill(worker)
        self.drain(worker)
        bundle=self.reader.read_projection_window(OWNER,self.epoch)
        self.assertEqual([row['bucket'] for row in bundle['summaries']],[1020])
        self.assertEqual([row['bucket'] for row in bundle['edges']],[960,1080])
        self.assertEqual(bundle['missingBuckets'],[])
        result=project(bundle,self.values(bundle),1083)
        self.assertEqual(result['performance']['status'],'measuring')
        self.assertIsNotNone(result['performance']['timeWeightedCapitalUsd'])
        self.assertFalse(result['performance']['complete24h'])
        before=deepcopy(bundle)
        restarted=ProjectionWorker(ProjectionStore(self.settings,role=COLLECTOR_ROLE),self.values)
        self.assertEqual(restarted.advance(OWNER,self.epoch),'caught_up')
        self.assertEqual(self.reader.read_projection_window(OWNER,self.epoch),before)

    def test_financial_revision_drift_rejects_publication_then_restart_resumes(self):
        self.fill()
        job=self.projections.next_projection_job(OWNER,self.epoch)
        summary=summarize(job['epoch']['baseline'],job['financial'],job['deltas'],self.values(job),job['bucket'])
        self.financial.record_financial_failure(OWNER,self.epoch,job['epoch']['revision'],1,job['financial']['revision'],'financial_read_failed')
        with self.assertRaisesRegex(PerformanceStoreError,'performance_version_conflict'):
            self.projections.publish_projection(OWNER,self.epoch,job,summary)
        self.assertEqual(self.admin.execute('SELECT count(*) AS n FROM domino_performance.projection_buckets').fetchone()['n'],0)
        self.assertEqual(ProjectionWorker(self.projections,self.values).advance(OWNER,self.epoch),'advanced')

    def test_publication_requires_exact_closed_minute_bounds(self):
        self.fill()
        job=self.projections.next_projection_job(OWNER,self.epoch)
        summary=summarize(job['epoch']['baseline'],job['financial'],job['deltas'],self.values(job),job['bucket'])
        invalid=summary.model_copy(update={'endsAt':summary.endsAt-1})
        with self.assertRaisesRegex(PerformanceStoreError,'performance_invalid_request'):
            self.projections.publish_projection(OWNER,self.epoch,job,invalid)
        self.assertEqual(self.admin.execute('SELECT count(*) AS n FROM domino_performance.projection_buckets').fetchone()['n'],0)

    def test_price_change_marks_derived_row_dirty_and_repairs_from_immutable_source(self):
        self.fill();worker=ProjectionWorker(self.projections,self.values)
        self.drain(worker)
        before=self.reader.read_projection_window(OWNER,self.epoch)
        original=self.financial.read_financial_window(OWNER,self.epoch)
        changed=project(before,self.values(before,'2'),1083)
        self.assertEqual(changed['dirtyBuckets'],[1020])
        self.assertIsNone(changed['performance']['netFeeAprPercent'])
        self.projections.request_projection_refresh(OWNER,self.epoch,1,changed['dirtyBuckets'])
        self.assertTrue(self.reader.read_projection_window(OWNER,self.epoch)['summaries'][0]['dirty'])
        repair=ProjectionWorker(self.projections,lambda bundle:self.values(bundle,'2'))
        self.assertEqual(repair.advance(OWNER,self.epoch),'advanced')
        after=self.reader.read_projection_window(OWNER,self.epoch)
        self.assertFalse(after['summaries'][0]['dirty'])
        self.assertEqual(project(after,self.values(after,'2'),1083)['dirtyBuckets'],[])
        self.assertEqual(self.financial.read_financial_window(OWNER,self.epoch),original)

    def test_owner_isolation_and_new_replay_generation_hide_old_minutes(self):
        self.fill();worker=ProjectionWorker(self.projections,self.values)
        self.drain(worker)
        with self.assertRaisesRegex(PerformanceStoreError,'performance_not_found'):
            self.reader.read_projection_window(NEXT_OWNER,self.epoch)
        with psycopg.connect(**self.settings,user=READER_ROLE,autocommit=True) as conn:
            self.assertEqual(conn.execute('SELECT count(*) FROM domino_performance.projection_buckets').fetchone()[0],0)
            with self.assertRaises(psycopg.errors.InsufficientPrivilege):
                conn.execute('UPDATE domino_performance.projection_buckets SET dirty=true')
        current=self.raw.read_epoch(OWNER,self.epoch)
        from performance_collection import Cursor
        self.raw.invalidate_reorg(OWNER,self.epoch,current['revision'],Cursor.model_validate(current['baseline']['baseline']))
        replay=self.reader.read_projection_window(OWNER,self.epoch)
        self.assertEqual(replay['epoch']['replayGeneration'],2)
        self.assertIsNone(replay['financial'])
        self.assertEqual(replay['summaries'],[])
        self.assertGreater(self.admin.execute('SELECT count(*) AS n FROM domino_performance.projection_buckets').fetchone()['n'],0)


if __name__=='__main__':unittest.main()
