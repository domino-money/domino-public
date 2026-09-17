"""Codec/HTTP tests plus opt-in tests against two fixed, disposable PostgreSQL DBs."""
import copy
from dataclasses import asdict
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import Mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import psycopg
from eth_abi import encode
from eth_hash.auto import keccak
from fastapi.testclient import TestClient

from catalogue import LOCK_ID, PgCatalogue, database_settings, pool_lock_key
from catalogue_indexer import CatalogueIndexer, IndexRpc, INITIALIZE_TOPIC, decode_initialize
from dev_postgres import ADMIN, BIN, PORT, SOCKET, create_database
from discovery import (Block, CHAIN_ID, DataError, KEY_TYPES, POOL_MANAGER, PoolKey, ZERO, discover)
from read_api import ReadGate, create_app
from read_service import ReadService
from test_discovery import BLOCK, KEY, OTHER, POOL, TOKEN, FakeRpc, candidate


def block_hash(number, branch=0):
    return '0x' + keccak(f'{branch}:{number}'.encode()).hex()


def log(number=11, *, key=KEY, branch=0, index=0):
    pool_id = '0x' + keccak(encode(KEY_TYPES, key)).hex()
    return {'address': POOL_MANAGER, 'removed': False,
            'topics': [INITIALIZE_TOPIC, pool_id, '0x'+key[0][2:].rjust(64,'0'), '0x'+key[1][2:].rjust(64,'0')],
            'data': '0x'+encode(['uint24','int24','address','uint160','int24'], [*key[2:],2**96,0]).hex(),
            'blockNumber': hex(number), 'blockHash': block_hash(number,branch),
            'transactionHash': block_hash(number+100000,branch), 'logIndex': hex(index)}


def stored_candidate(key=KEY):
    raw = decode_initialize(log(key=key))
    return {'poolId': raw['poolId'], 'poolKey': raw['poolKey'],
            'currencies': [key[0],key[1]], 'providerMetrics': None}


class FakeIndexRpc:
    def __init__(self):
        self.logs = [log()]
        self.fork_at = None
        self.chain = CHAIN_ID
        self.fail = False
        self.after_logs = None
        self.before_block = None
        self.requests = []

    def request(self, method, params=()):
        self.requests.append((method, params))
        if self.fail:
            raise DataError('network_unavailable')
        if method == 'eth_chainId':
            return hex(self.chain)
        if method == 'eth_getBlockByNumber':
            number = int(params[0],16)
            if self.before_block:
                self.before_block(number)
            branch = int(self.fork_at is not None and number>=self.fork_at)
            return {'number': hex(number), 'hash': block_hash(number,branch), 'timestamp': hex(1000+number)}
        if method == 'eth_getCode':
            return '0x6000'
        if method == 'eth_getLogs':
            query = params[0]
            assert query['address'] == POOL_MANAGER and query['topics'] == [INITIALIZE_TOPIC]
            result = [x for x in self.logs if int(query['fromBlock'],16)<=int(x['blockNumber'],16)<=int(query['toBlock'],16)]
            if self.after_logs:
                self.after_logs()
            return result
        raise AssertionError(method)


class CatalogueCodecTests(unittest.TestCase):
    def test_exact_initialize_abi_including_native_and_dynamic_fee(self):
        for key in [KEY, (TOKEN,OTHER,0x800000,200,OTHER)]:
            raw = log(key=key)
            result = decode_initialize(raw)
            self.assertEqual(result['poolKey'], asdict(PoolKey.checked(key,raw['topics'][1])))
            self.assertEqual(result['blockNumber'],11)

    def test_wrong_emitter_removed_topics_and_padding_rejected(self):
        changes = [dict(address=TOKEN), dict(removed=True), dict(removed=None),
                   dict(topics=log()['topics'][:3]), dict(data='0x'),
                   dict(blockHash='0x1234'), dict(logIndex='no')]
        for change in changes:
            with self.subTest(change=change), self.assertRaises(DataError):
                decode_initialize({**log(), **change})
        for position in [0,1,2]:
            raw = log()
            raw['topics'][position] = '0x'+'ff'*32
            with self.subTest(position=position), self.assertRaises(DataError):
                decode_initialize(raw)

    def test_invalid_key_or_initial_price_rejected(self):
        for key in [(ZERO,TOKEN,3000,0,ZERO), (TOKEN,ZERO,3000,60,ZERO), (ZERO,TOKEN,1000001,60,ZERO)]:
            with self.subTest(key=key), self.assertRaises(DataError):
                decode_initialize(log(key=key))
        for sqrt,tick in [(0,0),(2**96,887273)]:
            raw = log()
            raw['data'] = '0x'+encode(['uint24','int24','address','uint160','int24'], [*KEY[2:],sqrt,tick]).hex()
            with self.assertRaises(DataError):
                decode_initialize(raw)

    def test_index_rpc_keeps_signing_and_broadcast_disabled(self):
        transport = Mock()
        rpc = IndexRpc(transport=transport)
        for method in ['eth_sendRawTransaction','eth_sendTransaction','personal_sign','eth_sign']:
            with self.assertRaisesRegex(DataError,'method_not_read_only'):
                rpc.request(method)
        transport.assert_not_called()
        self.assertIn('eth_getLogs',rpc.METHODS)

    def test_private_local_descriptor_and_redacted_errors(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder)/'db.json'
            self.assertIsNone(database_settings(path))
            good = {'host': '/private/socket', 'port':8877, 'dbname':'domino_catalogue'}
            path.write_text(json.dumps(good)); path.chmod(0o600)
            self.assertEqual(database_settings(path),good)
            for changed in [{**good,'password':'secret'}, {**good,'host':'remote.example'}, [], None]:
                path.write_text(json.dumps(changed))
                with self.assertRaisesRegex(DataError,'^catalogue_configuration_unavailable$'):
                    database_settings(path)
            path.write_text(json.dumps(good)); path.chmod(0o644)
            with self.assertRaises(DataError): database_settings(path)
            link = Path(folder)/'link.json'; link.symlink_to(path)
            with self.assertRaises(DataError): database_settings(link)


class CatalogueReadTests(unittest.TestCase):
    def test_known_key_reads_state_without_position_manager_cache(self):
        rpc = FakeRpc()
        result = discover(TOKEN, rpc=rpc, transport=lambda url: [], clock=lambda:1010,
                          catalogue_candidates=[stored_candidate()])
        self.assertEqual(result['pools'][0]['poolId'],POOL)
        self.assertFalse(any(call[1]=='poolKeys(bytes25)' for call in rpc.calls))

    def test_provider_outage_preserves_catalogue_pool(self):
        def unavailable(url): raise DataError('network_unavailable')
        result = discover(TOKEN, rpc=FakeRpc(), transport=unavailable, clock=lambda:1010,
                          catalogue_candidates=[stored_candidate()])
        self.assertEqual(result['discovery']['status'],'unavailable')
        self.assertEqual(len(result['pools']),1)
        self.assertFalse(result['pools'][0]['executionAvailable'])
        self.assertIsNone(result['pools'][0]['feeApr24h'])

    def test_conflicting_provider_currency_does_not_poison_verified_key(self):
        raw = candidate(); raw['quoteToken']['address'] = OTHER
        result = discover(TOKEN, rpc=FakeRpc(), transport=lambda url:[raw], clock=lambda:1010,
                          catalogue_candidates=[stored_candidate()])
        pool = result['pools'][0]
        self.assertTrue(pool['providerCurrencyConflict'])
        self.assertIsNone(pool['providerMetrics'])
        self.assertEqual(pool['currencies'],[ZERO,TOKEN])

    def test_bad_hash_or_stale_uninitialized_pool_not_verified(self):
        cached = stored_candidate(); cached['poolKey']['fee_pips']=500
        result = discover(TOKEN, rpc=FakeRpc(), transport=lambda url:[], clock=lambda:1010,
                          catalogue_candidates=[cached])
        self.assertEqual(result['unverifiedCandidates'][0]['reason'],'pool_id_mismatch')
        class Uninitialized(FakeRpc):
            def call(self,target,signature,*args,**kwargs):
                if signature=='getSlot0(bytes32)': return (0,0,0,0)
                return super().call(target,signature,*args,**kwargs)
        result = discover(TOKEN, rpc=Uninitialized(), transport=lambda url:[], clock=lambda:1010,
                          catalogue_candidates=[stored_candidate()])
        self.assertEqual(result['pools'],[])
        self.assertEqual(result['unverifiedCandidates'][0]['reason'],'invalid_pool_state')

    def test_database_outage_keeps_provider_fallback(self):
        catalogue = Mock(); catalogue.lookup.side_effect=DataError('catalogue_database_unavailable')
        service = ReadService(rpc_factory=FakeRpc, clock=lambda:1010, catalogue=catalogue,
                              transport_factory=lambda:lambda url:[candidate()])
        result = service.pools(TOKEN)
        self.assertEqual(len(result['pools']),1)
        self.assertEqual(result['catalogue']['status'],'unavailable')

    def test_pair_filter_limits_candidates_and_checks_explicit_ids(self):
        result=discover(TOKEN,rpc=FakeRpc(),clock=lambda:1010,transport=lambda url:[candidate()],
                        paired_token=OTHER,catalogue_candidates=[stored_candidate()])
        self.assertEqual(result['pools'],[])
        result=discover(TOKEN,rpc=FakeRpc(),clock=lambda:1010,transport=lambda url:[],
                        paired_token=OTHER,pool_ids=[POOL],catalogue_candidates=[stored_candidate()])
        self.assertEqual(result['unverifiedCandidates'][0]['reason'],'selected_pair_mismatch')

    def test_catalogue_api_validation_and_revision_conflict(self):
        catalogue = Mock()
        from test_read_contract import CatalogueFixture
        catalogue.lookup.return_value={**CatalogueFixture().lookup(TOKEN), 'revision':3}
        service = ReadService(catalogue=catalogue)
        client=TestClient(create_app(service,gate=ReadGate(interval=0)),base_url='http://127.0.0.1')
        response=client.post('/v1/read/catalogue',json={'token':TOKEN,'pairedToken':ZERO})
        self.assertEqual(response.status_code,200)
        self.assertEqual(response.json()['mode'],'stored_catalogue_candidates')
        self.assertEqual(response.headers['cache-control'],'no-store')
        self.assertTrue(client.get('/v1/capabilities').json()['catalogueConfigured'])
        for params in [{'afterPoolId':POOL},{'limit':True},{'revision':-1},{'sql':'SELECT 1'},
                       {'pairedToken':'bad'}, {'pairedToken':TOKEN}]:
            self.assertEqual(client.post('/v1/read/catalogue',json={'token':TOKEN,**params}).status_code,422)
        catalogue.lookup.side_effect=DataError('catalogue_revision_changed')
        response=client.post('/v1/read/catalogue',json={'token':TOKEN,'afterPoolId':POOL,'revision':2})
        self.assertEqual(response.status_code,409)
        self.assertEqual(response.json(),{'error':'catalogue_revision_changed'})


@unittest.skipUnless(os.environ.get('DOMINO_TEST_POSTGRES')=='1', 'set DOMINO_TEST_POSTGRES=1 after dev_postgres.py prepare-tests')
class PostgresCatalogueTests(unittest.TestCase):
    """Only the hard-coded disposable DB is reset; live catalogue is never mutated."""
    @classmethod
    def setUpClass(cls):
        cls.settings={'host':str(SOCKET),'port':PORT,'dbname':'domino_catalogue_tests'}
        cls.restore_settings={**cls.settings,'dbname':'domino_catalogue_restore_tests'}

    def setUp(self):
        assert self.settings['dbname']=='domino_catalogue_tests'
        with psycopg.connect(**self.settings,user=ADMIN) as conn:
            conn.execute('TRUNCATE domino_catalogue.events,domino_catalogue.hints,domino_catalogue.chunks')
            conn.execute('UPDATE domino_catalogue.state SET start_block=NULL,next_block=NULL,base_hash=NULL,revision=0')
        self.store=PgCatalogue(self.settings)
        self.rpc=FakeIndexRpc()
        self.worker=CatalogueIndexer(self.store,self.rpc)

    def counts(self):
        with self.store.connection() as conn:
            return tuple(conn.execute('SELECT count(*) AS n FROM domino_catalogue.'+table).fetchone()['n']
                         for table in ['chunks','events','hints'])

    def state(self):
        with self.store.connection() as conn: return self.store.state(conn)

    def test_atomic_checkpoint_survives_new_connections_and_empty_chunk(self):
        self.worker.start(10)
        self.assertEqual(self.worker.step(through=13,span=2)['events'],1)
        worker=CatalogueIndexer(PgCatalogue(self.settings),self.rpc)
        self.assertEqual(worker.step(through=13,span=2)['fromBlock'],12)
        self.assertEqual(worker.step(through=13)['status'],'caught_up_to_target')
        self.assertEqual(self.state()['next_block'],14)
        self.assertEqual(self.counts(),(2,1,0))
        page=self.store.lookup(TOKEN)
        self.assertEqual(page['indexedThrough'],13)
        self.assertFalse(page['completeHistory'])
        self.assertEqual(page['items'][0]['catalogueSource'],'initialize_event')

    def test_network_failure_does_not_reset_checkpoint(self):
        self.worker.start(10);self.worker.step(through=11)
        original=self.state()
        self.rpc.fail=True
        with self.assertRaisesRegex(DataError,'network_unavailable'): self.worker.step(through=13)
        self.assertEqual(self.state(),original)
        self.rpc.fail=False
        self.assertEqual(self.worker.step(through=13)['fromBlock'],12)

    def test_chain_mismatch_does_not_start_index(self):
        self.rpc.chain=1
        with self.assertRaisesRegex(DataError,'wrong_chain'): self.worker.start(10)
        self.assertIsNone(self.state()['next_block'])

    def test_event_constraints_roll_back_chunk_and_checkpoint_together(self):
        self.worker.start(10)
        self.rpc.logs=[log(10),log(11)] # Same pool cannot initialize twice.
        with self.assertRaisesRegex(DataError,'catalogue_database_unavailable'): self.worker.step(through=11)
        self.assertEqual(self.state()['next_block'],10)
        self.assertEqual(self.counts(),(0,0,0))

    def test_identical_duplicate_log_is_idempotent_conflict_is_rejected(self):
        self.worker.start(10)
        self.rpc.logs=[log(),log()]
        self.assertEqual(self.worker.step(through=11)['events'],1)
        first=log(12,key=(ZERO,OTHER,500,10,ZERO))
        conflict=copy.deepcopy(first);conflict['transactionHash']=block_hash(999)
        self.rpc.logs=[first,conflict]
        with self.assertRaisesRegex(DataError,'conflicting_duplicate_log'): self.worker.step(through=13)
        self.assertEqual(self.state()['next_block'],12)
        self.assertEqual(self.counts(),(1,1,0))

    def test_mid_read_reorg_leave_no_partial_data(self):
        self.worker.start(10)
        self.rpc.logs=[]
        self.rpc.after_logs=lambda:setattr(self.rpc,'fork_at',10)
        with self.assertRaisesRegex(DataError,'index_snapshot_reorganized'): self.worker.step(through=11)
        self.assertEqual(self.state()['next_block'],10)
        self.assertEqual(self.counts(),(0,0,0))

    def test_the_event_block_hash_comes_from_the_provider_reply(self):
        """One header per event would cost a call per Initialize event on the chain.

        The chunk boundaries are read and re-read around the log call, so the
        range and its end hash are verified; the event's own hash is taken from
        the reply that carried it instead of being re-read block by block.
        """
        self.worker.start(10)
        self.rpc.logs=[log(11,branch=1)]
        self.assertEqual(self.worker.step(through=11)['events'],1)
        self.assertEqual(self.counts(),(1,1,0))

    def test_reorg_between_reconcile_and_next_anchor_is_not_committed(self):
        self.worker.start(10);self.worker.step(through=11)
        reads=[0]
        def change_on_second(number):
            if number==11:
                reads[0]+=1
                if reads[0]==2:self.rpc.fork_at=11
        self.rpc.before_block=change_on_second
        with self.assertRaisesRegex(DataError,'index_snapshot_reorganized'): self.worker.step(through=13)
        self.assertEqual(self.state()['next_block'],12)

    def test_reorg_removes_only_orphaned_events_and_replays_from_last_match(self):
        self.worker.start(10);self.worker.step(through=11)
        old_key=(ZERO,OTHER,500,10,ZERO)
        self.rpc.logs=[log(12,key=old_key)]
        self.worker.step(through=13)
        self.store.seed([stored_candidate(old_key)],Block(13,block_hash(13),1013))
        self.rpc.fork_at=12
        replacement=(TOKEN,OTHER,100,1,ZERO)
        self.rpc.logs=[log(12,key=replacement,branch=1)]
        self.assertEqual(self.worker.step(through=13),{'status':'rewound','through':11})
        self.assertEqual(self.counts(),(1,1,0))
        self.assertEqual(self.store.lookup(OTHER)['items'],[])
        self.worker.step(through=13)
        page=self.store.lookup(OTHER)
        self.assertEqual(page['items'][0]['poolId'],stored_candidate(replacement)['poolId'])
        self.assertEqual(self.counts(),(2,2,0))

    def test_no_matching_checkpoint_restarts_configured_window(self):
        self.worker.start(10);self.worker.step(through=11)
        self.rpc.fork_at=9
        self.assertEqual(self.worker.step(through=13)['through'],9)
        self.assertEqual(self.state()['next_block'],10)
        self.assertEqual(self.state()['base_hash'],block_hash(9,1))
        self.assertEqual(self.counts(),(0,0,0))

    def test_two_writers_are_serialized_with_advisory_lock(self):
        with self.store.connection(writer=True,lock=True):
            with self.assertRaisesRegex(DataError,'catalogue_writer_busy'): self.worker.start(10)
        self.worker.start(10)
        self.assertEqual(self.state()['next_block'],10)

    def test_per_pool_writer_keys_are_stable_distinct_and_independent(self):
        other='0x'+'11'*32
        first,second=pool_lock_key(POOL),pool_lock_key(other)
        self.assertEqual(pool_lock_key(POOL),first)
        self.assertNotEqual(first,second)
        self.assertNotEqual(first,LOCK_ID)
        with self.store.connection(writer=True,lock=first):
            # The same pool is still serialized...
            with self.assertRaisesRegex(DataError,'catalogue_writer_busy'):
                with self.store.connection(writer=True,lock=first): pass
            # ...while another pool, and the cross-pool ledger guard, proceed.
            with self.store.connection(writer=True,lock=second): pass
            with self.store.connection(writer=True,lock=True): pass
        with self.assertRaisesRegex(DataError,'invalid_lock_key'):
            with self.store.connection(writer=True,lock='not-a-key'): pass

    def test_start_and_noncontiguous_commit_cannot_skip_history(self):
        self.worker.start(10);self.worker.start(10)
        with self.assertRaisesRegex(DataError,'catalogue_start_already_set'): self.worker.start(12)
        with self.assertRaisesRegex(DataError,'catalogue_noncontiguous_chunk'):
            with self.store.connection(writer=True,lock=True) as conn:
                self.store.commit_chunk(conn,12,13,block_hash(13),[])
        self.assertEqual(self.counts(),(0,0,0))

    def test_both_currencies_pagination_pair_filter_and_revision(self):
        keys=[KEY,(ZERO,OTHER,500,10,ZERO),(TOKEN,OTHER,100,1,ZERO)]
        self.store.seed([stored_candidate(key) for key in keys],Block(9,block_hash(9),1009))
        page=self.store.lookup(TOKEN,limit=1)
        self.assertTrue(page['hasMore'])
        second=self.store.lookup(TOKEN,limit=1,after=page['nextAfterPoolId'],revision=page['revision'])
        self.assertFalse(second['hasMore'])
        self.assertNotEqual(page['items'][0]['poolId'],second['items'][0]['poolId'])
        self.assertEqual(len(self.store.lookup(ZERO)['items']),2)
        pair=self.store.lookup(TOKEN,paired_token=OTHER)
        self.assertEqual(len(pair['items']),1)
        self.assertEqual(pair['items'][0]['poolId'],stored_candidate(keys[2])['poolId'])
        self.worker.start(10)
        with self.assertRaisesRegex(DataError,'catalogue_revision_changed'):
            self.store.lookup(TOKEN,after=page['nextAfterPoolId'],revision=page['revision'])

    def test_event_overrides_seed_without_duplicate_and_old_seed_cannot_replace_new(self):
        self.store.seed([stored_candidate()],Block(8,block_hash(8),1008))
        self.store.seed([stored_candidate()],Block(7,block_hash(7),1007))
        self.assertEqual(self.store.lookup(TOKEN)['items'][0]['catalogueObservation']['number'],8)
        self.worker.start(10);self.worker.step(through=11)
        page=self.store.lookup(TOKEN)
        self.assertEqual(len(page['items']),1)
        self.assertEqual(page['items'][0]['catalogueSource'],'initialize_event')

    def test_reader_cannot_write_and_null_checkpoint_is_rejected(self):
        with psycopg.connect(**self.settings,user='domino_catalogue_reader') as conn:
            with self.assertRaises(psycopg.errors.InsufficientPrivilege):
                conn.execute('UPDATE domino_catalogue.state SET revision=revision+1')
            conn.rollback()
        with psycopg.connect(**self.settings,user='domino_catalogue_writer') as conn:
            with self.assertRaises(psycopg.errors.CheckViolation):
                conn.execute('UPDATE domino_catalogue.state SET start_block=10,base_hash=%s',(block_hash(9),))
            conn.rollback()

    def test_dump_restore_preserves_identities_checkpoint_and_read_grants(self):
        self.worker.start(10);self.worker.step(through=11)
        self.store.seed([stored_candidate((TOKEN,OTHER,100,1,ZERO))],Block(11,block_hash(11),1011))
        # Reapplying the migration must preserve the populated source database.
        create_database('domino_catalogue_tests')
        before=self.store.lookup(TOKEN)
        with tempfile.TemporaryDirectory() as folder:
            archive=Path(folder)/'catalogue.dump'
            common=['-h',str(SOCKET),'-p',str(PORT),'-U',ADMIN]
            subprocess.run([str(BIN/'pg_dump'),*common,'-d','domino_catalogue_tests',
                            '-n','domino_catalogue','-Fc','-f',str(archive)],check=True,capture_output=True)
            subprocess.run([str(BIN/'pg_restore'),*common,'-d','domino_catalogue_restore_tests',
                            '--clean','--if-exists','--exit-on-error',str(archive)],check=True,capture_output=True)
        self.assertEqual(PgCatalogue(self.restore_settings).lookup(TOKEN),before)
        self.assertEqual(self.counts(),(1,1,1))

    def test_empty_chunk_advances_coverage_without_invalidating_paging_clients(self):
        self.worker.start(10)
        self.rpc.logs=[]
        self.assertEqual(self.worker.step(through=11,span=2)['events'],0)
        page=self.store.lookup(TOKEN)
        self.assertEqual(page['indexedThrough'],11)
        self.assertEqual(self.counts(),(1,0,0))
        # The candidate set did not change, so the revision a client holds stays
        # valid and its next page is not rejected with catalogue_revision_changed.
        self.assertEqual(self.store.lookup(TOKEN,revision=page['revision'])['revision'],page['revision'])
        self.worker.step(through=13,span=2)
        self.assertEqual(self.state()['revision'],page['revision'])
        # A chunk that carries an Initialize event is a content change.
        self.rpc.logs=[log(14,key=(ZERO,OTHER,500,10,ZERO))]
        self.assertEqual(self.worker.step(through=15,span=2)['events'],1)
        self.assertEqual(self.state()['revision'],page['revision']+1)
        with self.assertRaisesRegex(DataError,'catalogue_revision_changed'):
            self.store.lookup(TOKEN,revision=page['revision'])

    def test_reset_drops_every_interval_and_restarts_at_a_verified_block(self):
        self.worker.start(10)
        self.rpc.logs=[log(11)]
        self.worker.step(through=11)
        self.store.seed([stored_candidate((TOKEN,OTHER,100,1,ZERO))],Block(11,block_hash(11),1011))
        self.assertEqual(self.counts(),(1,1,1))
        revision=self.state()['revision']
        # The reset is one transaction: the old interval is replaced atomically
        # rather than left half-indexed between two start blocks.
        result=self.worker.reset(20)
        self.assertEqual(result['status'],'reset')
        self.assertEqual((result['previousStartBlock'],result['previousNextBlock']),(10,12))
        state=self.state()
        self.assertEqual((state['start_block'],state['next_block'],state['base_hash']),
                         (20,20,block_hash(19)))
        self.assertEqual(state['revision'],revision+1)
        self.assertEqual(self.counts(),(0,0,0))
        self.rpc.logs=[]
        self.assertEqual(self.worker.step(through=21)['fromBlock'],20)
        self.assertEqual(self.counts(),(1,0,0))

    def test_rewind_and_reset_are_distinct(self):
        self.worker.start(10);self.worker.step(through=11)
        self.rpc.logs=[]
        self.assertEqual(self.worker.reset(30)['status'],'reset')
        self.assertEqual(self.state()['start_block'],30)
        # A rewind keeps the configured interval and only drops unconfirmed
        # checkpoints, so it cannot silently re-index a different range.
        with self.store.connection(writer=True,lock=True) as conn:
            self.store.rewind(conn,29,block_hash(29))
        self.assertEqual(self.state()['start_block'],30)
        self.assertEqual(self.state()['next_block'],30)


if __name__=='__main__': unittest.main()
