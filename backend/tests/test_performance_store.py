"""Performance evidence persistence/isolation on this worktree's disposable PG."""
from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy
import os
from pathlib import Path
import sys
import subprocess
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
import psycopg
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb
from dev_postgres import ADMIN, BIN, PORT, SOCKET, ROOT
from performance_collection import Baseline, Cursor, Page, epoch_id, event_id
from performance_store import (PerformanceStore, PerformanceStoreError, COLLECTOR_ROLE, READER_ROLE,
                               MAX_REVISION, _json, _model, _revision)

OWNER, OTHER = '0x'+'aa'*20, '0x'+'bb'*20


def h(number): return '0x'+number.to_bytes(32,'big').hex()
def a(number): return '0x'+number.to_bytes(20,'big').hex()
def replace(record, **changes): return type(record).model_validate({**record.model_dump(),**changes})


def baseline(owner=OWNER, *, block_hash=None):
    block_hash = block_hash or h(100)
    vault = a(3)
    cursor = Cursor(blockNumber=100,blockHash=block_hash,parentHash=h(99),timestamp=1700000000)
    member = {'tokenId':'101','holder':owner,'isRoot':True,'parentTokenId':'0','generation':1,
        'tickLower':-120,'tickUpper':120,'identity':h(101),'registrationBaselineId':h(102),
        'source0':h(103),'source1':h(104),'liquidityRaw':'1000','principalRaw':['100','100'],
        'unsettledFeesRaw':['50','60'],'registrationCheckpoint':['1000','1','2','3','4','100',h(90)],
        'checkpoint':['1000','1','2','3','4','100',h(90)]}
    return Baseline(chainId=4663,epochId=epoch_id(owner,vault,block_hash),owner=owner,vault=vault,
        positionManager=a(4),rootTokenId='101',tokenIds=['101'],baseline=cursor,vaultCodeHash=h(3),
        opening={'sequenceIdentity':h(80),'poolManager':a(5),'stateView':a(6),'factory':a(7),
            'implementation':a(8),'implementationVersion':2,'poolId':h(81),'currencies':[a(16),a(32)],
            'members':[member],'codePins':[{'address':a(i),'codeHash':h(i)} for i in range(3,9)],
            'heldRaw':['1','2'],'accountedRaw':['1','1'],'nativeHeldRaw':'3'})


def page(base, *, start=None, block_hash=None, tx_hash=None, global_index=8, include=True):
    start = start or base.baseline
    block_hash = block_hash or h(start.blockNumber+1)
    tx_hash = tx_hash or h(900+start.blockNumber)
    end = Cursor(blockNumber=start.blockNumber+1,blockHash=block_hash,parentHash=start.blockHash,timestamp=start.timestamp+12)
    log = {'address':base.vault,'topics':[h(701)],'data':'0x01','blockNumber':end.blockNumber,
        'blockHash':end.blockHash,'transactionHash':tx_hash,'transactionIndex':0,'logIndex':global_index,'receiptLogIndex':0}
    receipt = {'transactionHash':tx_hash,'blockNumber':end.blockNumber,'blockHash':end.blockHash,'transactionIndex':0,
        'fromAddress':base.owner,'toAddress':base.vault,'status':1,'gasUsed':'100','effectiveGasPrice':'3',
        'logs':[log],'rawReceipt':{'status':'0x1'},'rawTransaction':{'hash':tx_hash}}
    event = {key:log[key] for key in ('transactionHash','receiptLogIndex','blockNumber','blockHash','transactionIndex','logIndex','address')}
    event.update(eventId=event_id(tx_hash,0),kind='vault')
    return Page(epochId=base.epochId,owner=base.owner,vault=base.vault,fromCursor=start,throughCursor=end,
                headers=[end],receipts=[receipt] if include else [],events=[event] if include else [])


class ValidationTests(unittest.TestCase):
    def test_strict_models_revalidated_and_json_bounds_before_database(self):
        base = baseline()
        encoded = _model('Baseline',base,262144)[1]
        self.assertEqual(encoded['opening']['members'][0]['unsettledFeesRaw'],['50','60'])
        altered = base.model_copy(update={'owner':OTHER})
        with self.assertRaises(PerformanceStoreError): _model('Baseline',altered,262144)
        event_page = page(base)
        altered = event_page.model_copy(update={'events':[event_page.events[0].model_copy(update={'eventId':h(9)})]})
        with self.assertRaises(PerformanceStoreError): _model('Page',altered,4194304)
        for value in ({'x':1.5},{'x':float('nan')},{'x':b'raw'},{'x':'a'*300}):
            with self.assertRaises(PerformanceStoreError): _json(value,200)
        for value in (True,0,MAX_REVISION,1.0):
            with self.assertRaises(PerformanceStoreError): _revision(value)

    def test_reader_cannot_call_mutations_even_before_connection(self):
        def no_connection(**kwargs): raise AssertionError('database should not be called')
        store = PerformanceStore({'host':'unused','port':1,'dbname':'unused'},connect=no_connection)
        for call in (lambda:store.create_epoch(baseline()),lambda:store.record_failure(OWNER,h(1),1,'failed'),
                     lambda:store.invalidate_reorg(OWNER,h(1),1,baseline().baseline),
                     lambda:store.append_page(OWNER,h(1),1,page(baseline()))):
            with self.assertRaises(PerformanceStoreError) as caught: call()
            self.assertEqual(caught.exception.code,'performance_read_only')
        for ids in ([],[{}],[h(1)]*2,[h(1)]*9):
            with self.assertRaises(PerformanceStoreError): store.list_epochs(OWNER,ids)


@unittest.skipUnless(os.environ.get('DOMINO_TEST_POSTGRES') == '1','set DOMINO_TEST_POSTGRES=1 after task-local prepare-tests')
class PerformanceStoreTests(unittest.TestCase):
    def setUp(self):
        self.settings = {'host':str(SOCKET),'port':PORT,'dbname':'domino_catalogue_tests'}
        self.admin = psycopg.connect(**self.settings,user=ADMIN,autocommit=True,row_factory=dict_row)
        self.addCleanup(self.admin.close)
        self.admin.execute('TRUNCATE domino_performance.epochs CASCADE')
        self.writer = PerformanceStore(self.settings,role=COLLECTOR_ROLE)
        self.reader = PerformanceStore(self.settings)
        self.base = baseline()

    def create(self, value=None): return self.writer.create_epoch(value or self.base)

    def error(self, code, action):
        with self.assertRaises(PerformanceStoreError) as caught: action()
        self.assertEqual(caught.exception.code,code)

    def role_connection(self, role, *, owner=None):
        conn = psycopg.connect(**self.settings,user=role,autocommit=True,row_factory=dict_row)
        self.addCleanup(conn.close)
        if owner is not None: conn.execute("SELECT set_config('domino.performance_owner',%s,false)",(owner,))
        return conn

    def test_baseline_is_immutable_idempotent_and_owner_bound_after_restart(self):
        row = self.create()
        self.assertEqual(row['revision'],1)
        self.assertEqual(row['baseline']['opening']['members'][0]['unsettledFeesRaw'],['50','60'])
        self.assertEqual(self.create(),row)
        other = self.create(baseline(OTHER))
        self.assertEqual(self.reader.list_epochs(OWNER,[other['epochId'],row['epochId']]),[row])
        self.error('performance_not_found',lambda:self.reader.read_epoch(OTHER,row['epochId']))
        peer = PerformanceStore(self.settings,role=COLLECTOR_ROLE)
        self.assertEqual(peer.read_epoch(OWNER,row['epochId']),row)
        changed = self.base.model_dump()
        changed['opening']['heldRaw'][0] = '999'
        self.error('performance_idempotency_conflict',lambda:peer.create_epoch(Baseline.model_validate(changed)))
        row['baseline']['opening']['heldRaw'][0] = '0'
        self.assertEqual(self.reader.read_epoch(OWNER,row['epochId'])['baseline']['opening']['heldRaw'][0],'1')

    def test_page_is_atomic_idempotent_and_same_cursor_content_cannot_be_replaced(self):
        row = self.create()
        first = page(self.base)
        saved = self.writer.append_page(OWNER,row['epochId'],1,first)
        self.assertEqual((saved['revision'],saved['pageCount'],saved['receiptCount'],saved['eventCount']),(2,1,1,1))
        self.assertEqual(self.writer.append_page(OWNER,row['epochId'],1,first),saved)
        self.error('performance_idempotency_conflict',lambda:self.writer.append_page(OWNER,row['epochId'],2,
            page(self.base,global_index=9)))
        self.error('performance_invalid_request',lambda:self.writer.append_page(OTHER,row['epochId'],1,first))
        second = page(self.base,start=first.throughCursor)
        with patch.object(self.writer,'_transition',side_effect=PerformanceStoreError('performance_store_unavailable')):
            self.error('performance_store_unavailable',lambda:self.writer.append_page(OWNER,row['epochId'],2,second))
        self.assertEqual(self.reader.read_epoch(OWNER,row['epochId']),saved)
        self.assertEqual(self.admin.execute('SELECT count(*) AS n FROM domino_performance.pages').fetchone()['n'],1)
        self.assertEqual(self.admin.execute('SELECT count(*) AS n FROM domino_performance.receipts').fetchone()['n'],1)

    def test_single_failure_preserves_cursor_baseline_and_journal_then_recovery_fences_old_work(self):
        row = self.create()
        first = page(self.base)
        saved = self.writer.append_page(OWNER,row['epochId'],1,first)
        failed = self.writer.record_failure(OWNER,row['epochId'],2,'collection_rpc_unavailable')
        self.assertEqual(failed['revision'],3)
        self.assertEqual(failed['status'],'read_failed')
        for field in ('baseline','cursor','pageCount','receiptCount','eventCount'):
            self.assertEqual(failed[field],saved[field])
        second = page(self.base,start=first.throughCursor)
        self.error('performance_version_conflict',lambda:self.writer.append_page(OWNER,row['epochId'],2,second))
        recovered = self.writer.append_page(OWNER,row['epochId'],3,second)
        self.assertEqual((recovered['revision'],recovered['status'],recovered['eventCount']),(4,'active',2))
        self.assertIsNone(recovered['lastError'])
        kinds = self.admin.execute('SELECT kind FROM domino_performance.transitions ORDER BY revision').fetchall()
        self.assertEqual([r['kind'] for r in kinds],['capture','page','read_failure','page'])

    def test_concurrent_captures_and_page_failure_race_have_single_mutation(self):
        with ThreadPoolExecutor(max_workers=3) as pool:
            records = list(pool.map(lambda _:self.create(),range(3)))
        self.assertTrue(all(record == records[0] for record in records))
        row = records[0]
        def append_or_fail(kind):
            try:
                return self.writer.append_page(OWNER,row['epochId'],1,page(self.base)) if kind == 0 else self.writer.record_failure(OWNER,row['epochId'],1,'read_failure')
            except PerformanceStoreError as error: return error.code
        with ThreadPoolExecutor(max_workers=2) as pool: results = list(pool.map(append_or_fail,(0,1)))
        self.assertEqual(sum(type(result) is dict for result in results),1)
        self.assertIn('performance_version_conflict',results)
        self.assertEqual(self.reader.read_epoch(OWNER,row['epochId'])['revision'],2)

    def test_reorg_keeps_orphans_and_reinclusion_counts_same_event_once_with_new_global_index(self):
        row = self.create()
        first = page(self.base,block_hash=h(200),global_index=8)
        self.writer.append_page(OWNER,row['epochId'],1,first)
        reset = self.writer.invalidate_reorg(OWNER,row['epochId'],2,self.base.baseline)
        self.assertEqual((reset['revision'],reset['replayGeneration'],reset['status'],reset['eventCount']),(3,2,'replaying',0))
        self.assertEqual(reset['cursor'],self.base.baseline.model_dump())
        second = page(self.base,block_hash=h(201),global_index=2)
        self.assertEqual(first.events[0].eventId,second.events[0].eventId)
        saved = self.writer.append_page(OWNER,row['epochId'],3,second)
        self.assertEqual((saved['revision'],saved['eventCount'],saved['receiptCount']),(4,1,1))
        events = self.admin.execute('SELECT event_id,block_hash,canonical FROM domino_performance.events ORDER BY block_hash').fetchall()
        self.assertEqual(len(events),2)
        self.assertEqual(len({event['event_id'] for event in events}),1)
        self.assertEqual(sum(event['canonical'] for event in events),1)
        self.error('performance_idempotency_conflict',lambda:self.writer.append_page(OWNER,row['epochId'],1,first))

    def test_replay_same_inclusion_reuses_immutable_content_and_revision_never_aba(self):
        row = self.create()
        first = page(self.base)
        self.writer.append_page(OWNER,row['epochId'],1,first)
        self.writer.invalidate_reorg(OWNER,row['epochId'],2,self.base.baseline)
        self.error('performance_version_conflict',lambda:self.writer.append_page(OWNER,row['epochId'],1,first))
        resumed = self.writer.append_page(OWNER,row['epochId'],3,first)
        self.assertEqual(resumed['revision'],4)
        self.assertEqual(self.admin.execute('SELECT count(*) AS n FROM domino_performance.events').fetchone()['n'],1)
        self.writer.invalidate_reorg(OWNER,row['epochId'],4,self.base.baseline)
        changed = page(self.base,global_index=4)
        self.error('performance_idempotency_conflict',lambda:self.writer.append_page(OWNER,row['epochId'],5,changed))
        self.assertEqual(self.reader.read_epoch(OWNER,row['epochId'])['revision'],5)
        self.assertEqual(self.admin.execute('SELECT count(*) AS n FROM domino_performance.pages').fetchone()['n'],2)

    def test_baseline_reorg_is_terminal_and_fresh_owner_epoch_gets_no_prior_history(self):
        row = self.create()
        self.writer.append_page(OWNER,row['epochId'],1,page(self.base))
        changed = replace(self.base.baseline,blockHash=h(800))
        invalid = self.writer.invalidate_reorg(OWNER,row['epochId'],2,changed)
        self.assertEqual(invalid['status'],'baseline_reorged')
        self.error('performance_epoch_blocked',lambda:self.writer.append_page(OWNER,row['epochId'],3,page(self.base)))
        self.error('performance_epoch_blocked',lambda:self.writer.record_failure(OWNER,row['epochId'],3,'retry'))
        self.assertEqual(self.create()['status'],'baseline_reorged')
        fresh = self.create(baseline(OTHER,block_hash=h(800)))
        self.assertEqual((fresh['revision'],fresh['pageCount'],fresh['eventCount']),(1,0,0))
        self.assertEqual(self.reader.list_epochs(OTHER,[row['epochId'],fresh['epochId']]),[fresh])

    def test_actual_dump_restore_retains_failed_cursor_and_requires_fenced_reorg_replay(self):
        row = self.create()
        original = page(self.base)
        self.writer.append_page(OWNER,row['epochId'],1,original)
        failed = self.writer.record_failure(OWNER,row['epochId'],2,'collection_rpc_unavailable')
        restore_settings = {**self.settings,'dbname':'domino_catalogue_restore_tests'}
        restore_admin = psycopg.connect(**restore_settings,user=ADMIN,autocommit=True,row_factory=dict_row)
        self.addCleanup(restore_admin.close)
        restore_admin.execute('TRUNCATE domino_performance.epochs CASCADE')
        self.addCleanup(lambda:restore_admin.execute('TRUNCATE domino_performance.epochs CASCADE'))
        with tempfile.TemporaryDirectory(prefix='domino-performance-restore-') as directory:
            dump = str(Path(directory)/'synthetic.dump')
            common = ['--host',str(SOCKET),'--port',str(PORT),'--username',ADMIN]
            result = subprocess.run([str(BIN/'pg_dump'),*common,'--dbname',self.settings['dbname'],
                '--data-only','--schema=domino_performance','--format=custom','--file',dump],capture_output=True,text=True,timeout=20)
            self.assertEqual(result.returncode,0,result.stderr)
            result = subprocess.run([str(BIN/'pg_restore'),*common,'--dbname',restore_settings['dbname'],
                '--data-only','--disable-triggers','--no-owner','--no-privileges','--exit-on-error',dump],
                capture_output=True,text=True,timeout=20)
            self.assertEqual(result.returncode,0,result.stderr)
        restored = PerformanceStore(restore_settings,role=COLLECTOR_ROLE)
        self.assertEqual(restored.read_epoch(OWNER,row['epochId']),failed)
        self.error('performance_version_conflict',lambda:restored.append_page(OWNER,row['epochId'],2,
            page(self.base,start=original.throughCursor)))
        reset = restored.invalidate_reorg(OWNER,row['epochId'],3,self.base.baseline)
        self.assertEqual((reset['revision'],reset['cursor'],reset['eventCount']),(4,self.base.baseline.model_dump(),0))
        replayed = restored.append_page(OWNER,row['epochId'],4,page(self.base,block_hash=h(700),global_index=1))
        self.assertEqual((replayed['revision'],replayed['eventCount']),(5,1))
        history = restore_admin.execute('SELECT count(*) AS total,count(*) FILTER(WHERE canonical) AS current FROM domino_performance.events').fetchone()
        self.assertEqual((history['total'],history['current']),(2,1))

    def test_force_rls_denies_omitted_owner_context_or_filters_and_reader_is_sql_read_only(self):
        left,right = self.create(),self.create(baseline(OTHER))
        for role in (COLLECTOR_ROLE,READER_ROLE):
            missing = self.role_connection(role)
            self.assertEqual(missing.execute('SELECT * FROM domino_performance.epochs').fetchall(),[])
            own = self.role_connection(role,owner=OWNER)
            rows = own.execute('SELECT epoch_id FROM domino_performance.epochs').fetchall()
            self.assertEqual([row['epoch_id'] for row in rows],[left['epochId']])
            self.assertEqual(own.execute('SELECT * FROM domino_performance.epochs WHERE epoch_id=%s',(right['epochId'],)).fetchall(),[])
        reader = self.role_connection(READER_ROLE,owner=OWNER)
        for statement in ("UPDATE domino_performance.epochs SET revision=revision+1",'DELETE FROM domino_performance.epochs',
                          'TRUNCATE domino_performance.epochs CASCADE'):
            with self.assertRaises(psycopg.errors.InsufficientPrivilege): reader.execute(statement)
        flags = self.admin.execute("SELECT relname,relrowsecurity,relforcerowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='domino_performance' AND c.relkind='r'").fetchall()
        self.assertEqual({row['relname'] for row in flags}, {'epochs','pages','receipts','events','transitions',
            'financial_heads','financial_pages','enrollments','projection_heads','projection_buckets'})
        self.assertTrue(all(row['relrowsecurity'] and row['relforcerowsecurity'] for row in flags))

    def test_actual_roles_cannot_enter_auth_deposit_execution_or_become_collector(self):
        for role in (READER_ROLE,COLLECTOR_ROLE):
            conn = self.role_connection(role,owner=OWNER)
            for target in ('domino_session_auth','domino_deposit_service'):
                with self.assertRaises(psycopg.errors.InsufficientPrivilege): conn.execute(f'SET ROLE {target}')
            for target in ('domino_sessions.sessions','domino_deposits.intents'):
                with self.assertRaises(psycopg.errors.InsufficientPrivilege): conn.execute(f'SELECT * FROM {target}')
            if self.admin.execute("SELECT 1 FROM pg_namespace WHERE nspname='domino_execution'").fetchone():
                self.assertFalse(conn.execute("SELECT has_schema_privilege(current_user,'domino_execution','USAGE') AS allowed").fetchone()['allowed'])
        reader = self.role_connection(READER_ROLE)
        with self.assertRaises(psycopg.errors.InsufficientPrivilege): reader.execute(f'SET ROLE {COLLECTOR_ROLE}')
        for role in ('domino_session_auth','domino_deposit_service','domino_catalogue_reader','domino_catalogue_writer'):
            conn = self.role_connection(role)
            with self.assertRaises(psycopg.errors.InsufficientPrivilege): conn.execute('SELECT * FROM domino_performance.epochs')

    def test_database_rejects_baseline_page_content_changes_and_history_deletion(self):
        row = self.create()
        self.writer.append_page(OWNER,row['epochId'],1,page(self.base))
        conn = self.role_connection(COLLECTOR_ROLE,owner=OWNER)
        with self.assertRaises(psycopg.errors.CheckViolation):
            conn.execute("UPDATE domino_performance.epochs SET baseline=baseline||'{\"unexpected\":true}'::jsonb,revision=revision+1")
        with self.assertRaises(psycopg.errors.CheckViolation):
            conn.execute("UPDATE domino_performance.pages SET payload=payload||'{\"unexpected\":true}'::jsonb")
        with self.assertRaises(psycopg.errors.CheckViolation):
            conn.execute('UPDATE domino_performance.epochs SET revision=revision')
        for table in ('epochs','pages','receipts','events','transitions'):
            with self.assertRaises(psycopg.errors.InsufficientPrivilege): conn.execute(f'DELETE FROM domino_performance.{table}')
        with self.assertRaises(psycopg.errors.InsufficientPrivilege):
            conn.execute("UPDATE domino_performance.transitions SET kind='read_failure'")

    def test_migration_reapply_preserves_rows_and_rejects_membership_or_foreign_ownership(self):
        row = self.create()
        migration = (ROOT/'migrations/016_managed_performance.sql').read_text()
        self.admin.execute(migration)
        self.assertEqual(self.reader.read_epoch(OWNER,row['epochId']),row)
        # Each malicious configuration is rolled back, never repaired silently.
        for statement in (f'GRANT {COLLECTOR_ROLE} TO {READER_ROLE}',
                          f'GRANT domino_session_auth TO {COLLECTOR_ROLE}',
                          f'GRANT {READER_ROLE} TO domino_session_auth',
                          f'ALTER SCHEMA domino_performance OWNER TO {READER_ROLE}',
                          f'ALTER TABLE domino_performance.epochs OWNER TO {COLLECTOR_ROLE}',
                          f'ALTER FUNCTION domino_performance.preserve_epoch() OWNER TO {COLLECTOR_ROLE}'):
            with self.assertRaises(psycopg.errors.RaiseException):
                with self.admin.transaction():
                    self.admin.execute(statement)
                    self.admin.execute(migration)
        self.assertEqual(self.reader.read_epoch(OWNER,row['epochId']),row)
