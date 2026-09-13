"""Task-local PostgreSQL financial history identity/isolation/replay tests."""
from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch
import psycopg
from psycopg.rows import dict_row
from dev_postgres import ADMIN, BIN, PORT, SOCKET
from performance_history_store import FinancialHistoryStore
from performance_store import COLLECTOR_ROLE, READER_ROLE, PerformanceStoreError
from test_performance_history import HistoryFixture
from test_performance_financial_collection import pool_log
from test_performance_collection import OWNER, NEXT_OWNER


@unittest.skipUnless(os.environ.get('DOMINO_TEST_POSTGRES')=='1','requires task-local PostgreSQL')
class FinancialStoreTests(HistoryFixture,unittest.TestCase):
    def setUp(self):
        self.setup_history()
        self.settings = {'host':str(SOCKET),'port':PORT,'dbname':'domino_catalogue_tests'}
        self.admin = psycopg.connect(**self.settings,user=ADMIN,autocommit=True,row_factory=dict_row)
        self.addCleanup(self.admin.close)
        self.admin.execute('TRUNCATE domino_performance.epochs CASCADE')
        self.writer = FinancialHistoryStore(self.settings,role=COLLECTOR_ROLE)
        self.reader = FinancialHistoryStore(self.settings)
        self.epoch = self.writer.create_epoch(self.base)
        self.head = self.writer.create_financial_history(OWNER,self.base.epochId,1,1,self.opening)

    def append(self):
        self.raw_page,self.financial_page = self.page([pool_log()])
        self.epoch = self.writer.append_page(OWNER,self.base.epochId,1,self.raw_page)
        return self.writer.append_financial_page(OWNER,self.base.epochId,2,1,1,self.raw_page,self.financial_page,[])

    def failure(self, code, call):
        with self.assertRaises(PerformanceStoreError) as caught: call()
        self.assertEqual(caught.exception.code,code)

    def connection(self,role,owner=None):
        conn = psycopg.connect(**self.settings,user=role,autocommit=True,row_factory=dict_row)
        self.addCleanup(conn.close)
        if owner: conn.execute("SELECT set_config('domino.performance_owner',%s,false)",(owner,))
        return conn

    def test_atomic_page_idempotency_and_owner_bound_restart(self):
        saved = self.append()
        duplicate = self.writer.append_financial_page(OWNER,self.base.epochId,2,1,1,self.raw_page,self.financial_page,[])
        self.assertEqual(saved,duplicate)
        self.assertEqual(saved['revision'],2)
        result = FinancialHistoryStore(self.settings).read_financial_window(OWNER,self.base.epochId)
        self.assertEqual(len(result['deltas']),1)
        self.assertEqual(result['deltas'][0]['replayGeneration'],1)
        self.assertEqual(result['deltas'][0]['slices'][0]['credits'][0]['raw'],'99')
        self.failure('performance_not_found',lambda:self.reader.read_financial_window(NEXT_OWNER,self.base.epochId))
        malformed = self.financial_page.model_dump(); malformed['points'][0]['heldRaw'][1]='21'
        self.failure('performance_idempotency_conflict',lambda:self.writer.append_financial_page(
            OWNER,self.base.epochId,2,1,1,self.raw_page,malformed,[]))
        self.assertEqual(self.reader.read_epoch(OWNER,self.base.epochId)['revision'],2)

    def test_failure_preserves_cursor_and_raw_progress_then_recovers(self):
        self.raw_page,self.financial_page = self.page([pool_log()])
        self.writer.append_page(OWNER,self.base.epochId,1,self.raw_page)
        failed = self.writer.record_financial_failure(OWNER,self.base.epochId,2,1,1,'financial_read_failed')
        self.assertEqual(failed['cursor'],self.base.baseline.model_dump())
        self.assertEqual(self.reader.read_epoch(OWNER,self.base.epochId)['cursor'],self.raw_page.throughCursor.model_dump())
        recovered = self.writer.append_financial_page(OWNER,self.base.epochId,2,1,2,self.raw_page,self.financial_page,[])
        self.assertIsNone(recovered['lastError'])
        self.assertEqual(recovered['revision'],3)
        self.assertEqual(recovered['opening'],self.head['opening'])

    def test_reorg_generations_never_reuse_prior_financial_results(self):
        self.append()
        reset = self.writer.invalidate_reorg(OWNER,self.base.epochId,2,self.base.baseline)
        result = self.reader.read_financial_window(OWNER,self.base.epochId)
        self.assertIsNone(result['financial']); self.assertEqual(result['deltas'],[])
        self.failure('performance_epoch_blocked',lambda:self.writer.append_financial_page(
            OWNER,self.base.epochId,2,1,1,self.raw_page,self.financial_page,[]))
        self.writer.create_financial_history(OWNER,self.base.epochId,3,2,self.opening)
        self.writer.append_page(OWNER,self.base.epochId,3,self.raw_page)
        self.writer.append_financial_page(OWNER,self.base.epochId,4,2,1,self.raw_page,self.financial_page,[])
        result = self.reader.read_financial_window(OWNER,self.base.epochId)
        self.assertEqual([p['replayGeneration'] for p in result['deltas']],[2])
        self.assertEqual(self.admin.execute('SELECT count(*) AS n FROM domino_performance.financial_pages').fetchone()['n'],2)

    def test_rls_read_only_and_immutable_financial_evidence(self):
        self.append()
        for role in (COLLECTOR_ROLE,READER_ROLE):
            self.assertEqual(self.connection(role).execute('SELECT * FROM domino_performance.financial_heads').fetchall(),[])
            self.assertEqual(self.connection(role,NEXT_OWNER).execute('SELECT * FROM domino_performance.financial_pages').fetchall(),[])
        reader = self.connection(READER_ROLE,OWNER)
        for table in ('financial_heads','financial_pages'):
            with self.assertRaises(psycopg.errors.InsufficientPrivilege): reader.execute('DELETE FROM domino_performance.'+table)
            flags=self.admin.execute("SELECT relrowsecurity,relforcerowsecurity FROM pg_class WHERE oid=%s::regclass",('domino_performance.'+table,)).fetchone()
            self.assertTrue(flags['relrowsecurity'] and flags['relforcerowsecurity'])
        with self.assertRaises(psycopg.errors.CheckViolation):
            self.admin.execute("UPDATE domino_performance.financial_pages SET payload=payload")
        with self.assertRaises(psycopg.errors.CheckViolation):
            self.admin.execute("UPDATE domino_performance.financial_heads SET opening_hash=repeat('a',64),revision=revision+1")
        self.failure('performance_read_only',lambda:self.reader.record_financial_failure(OWNER,self.base.epochId,2,1,2,'failed'))

    def test_window_byte_and_page_budget_checked_before_payload_fetch(self):
        self.append()
        for name,limit in [('MAX_WINDOW_BYTES',1),('MAX_WINDOW_PAGES',0)]:
            with patch('performance_history_store.'+name,limit):
                self.failure('performance_store_unavailable',lambda:self.reader.read_financial_window(OWNER,self.base.epochId))

    def test_later_block_at_opening_second_is_preserved(self):
        self.rpc.headers[11]['timestamp'] = self.rpc.headers[10]['timestamp']
        self.append()
        result=self.reader.read_financial_window(OWNER,self.base.epochId)
        self.assertEqual(len(result['deltas']),1)
        self.assertEqual(result['deltas'][0]['slices'][0]['credits'][0]['timestamp'],1010)

    def test_concurrent_financial_failure_has_one_winner(self):
        def run(_):
            try: return self.writer.record_financial_failure(OWNER,self.base.epochId,1,1,1,'financial_read_failed')
            except PerformanceStoreError as error: return error.code
        with ThreadPoolExecutor(max_workers=2) as pool: results=list(pool.map(run,(0,1)))
        self.assertEqual(sum(type(r) is dict for r in results),1)
        self.assertEqual(self.reader.read_financial_window(OWNER,self.base.epochId)['financial']['revision'],2)

    def test_dump_restore_retains_financial_evidence_and_failure_cursor(self):
        self.append()
        expected=self.writer.record_financial_failure(OWNER,self.base.epochId,2,1,2,'financial_read_failed')
        restore={**self.settings,'dbname':'domino_catalogue_restore_tests'}
        admin=psycopg.connect(**restore,user=ADMIN,autocommit=True)
        self.addCleanup(admin.close)
        admin.execute('TRUNCATE domino_performance.epochs CASCADE')
        self.addCleanup(lambda:admin.execute('TRUNCATE domino_performance.epochs CASCADE'))
        with tempfile.TemporaryDirectory(prefix='domino-financial-restore-') as directory:
            dump=str(Path(directory)/'synthetic.dump')
            common=['--host',str(SOCKET),'--port',str(PORT),'--username',ADMIN]
            for args in ([str(BIN/'pg_dump'),*common,'--dbname',self.settings['dbname'],'--data-only','--schema=domino_performance','--format=custom','--file',dump],
                         [str(BIN/'pg_restore'),*common,'--dbname',restore['dbname'],'--data-only','--disable-triggers','--no-owner','--no-privileges','--exit-on-error',dump]):
                result=subprocess.run(args,capture_output=True,text=True,timeout=20)
                self.assertEqual(result.returncode,0,result.stderr)
        result=FinancialHistoryStore(restore).read_financial_window(OWNER,self.base.epochId)
        self.assertEqual(result['financial'],expected)
        self.assertEqual(len(result['deltas']),1)

    def test_migration_reapply_preserves_history_and_rejects_role_or_owner_drift(self):
        self.append()
        expected=self.reader.read_financial_window(OWNER,self.base.epochId)
        migration=(Path(__file__).resolve().parents[1]/'migrations/017_performance_financial_history.sql').read_text()
        self.admin.execute(migration)
        self.assertEqual(self.reader.read_financial_window(OWNER,self.base.epochId),expected)
        for statement in (
                'GRANT domino_performance_collector TO domino_performance_reader',
                'ALTER TABLE domino_performance.financial_heads OWNER TO domino_performance_collector',
                'ALTER FUNCTION domino_performance.preserve_financial_page() OWNER TO domino_performance_collector'):
            with self.assertRaises(psycopg.errors.RaiseException):
                with self.admin.transaction():
                    self.admin.execute(statement)
                    self.admin.execute(migration)
        self.assertEqual(self.reader.read_financial_window(OWNER,self.base.epochId),expected)

    def test_raw_migration_reapply_does_not_remove_later_writer_privileges(self):
        self.append()
        migration=(Path(__file__).resolve().parents[1]/'migrations/016_managed_performance.sql').read_text()
        self.admin.execute(migration)
        failed=self.writer.record_financial_failure(OWNER,self.base.epochId,2,1,2,'financial_read_failed')
        self.assertEqual(failed['revision'],3)
        self.assertEqual(len(self.reader.read_financial_window(OWNER,self.base.epochId)['deltas']),1)
