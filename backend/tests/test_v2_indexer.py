"""The V2 indexer over a scripted chain and a real PostgreSQL.

A fake chain serves blocks, logs, receipts and calls, and can move blocks to
a new branch; the store is the real migration in an isolated database with the
real writer and reader roles. These tests pin the V1 indexing rules the V2
indexer reuses (continuity, before-and-after boundary headers, rewind through
checkpoints, the base as the last resort) and what the index records: events,
vaults followed from their creation, activity items, positions, and the
enrichment reads, each written only while its checkpoint stands.
"""
import os
from pathlib import Path
import sys
import unittest

from eth_abi import encode
import psycopg
from psycopg import sql

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))
from discovery import DataError, parse_block  # noqa: E402
from dev_postgres import ADMIN, PORT, SOCKET  # noqa: E402
from v2_abi import function  # noqa: E402
from v2_chains import default_registry  # noqa: E402
from v2_manifest import COMPONENTS, DEPLOY_ORDER, checked_deployment  # noqa: E402
from v2_index_store import V2Store  # noqa: E402
from v2_indexer import V2Indexer  # noqa: E402
from v2_index_fixtures import (IndexChain, local_endpoints, manifest, synthetic_runtime, tx_hash)  # noqa: E402
from v2_read_service import V2ReadService  # noqa: E402

DB = 'domino_v2_index_tests'
MIGRATION = Path(__file__).resolve().parents[1] / 'migrations/052_v2_index.sql'
CHAIN = default_registry().chain('robinhood-4663')
OWNER, OTHER = '0x' + 'b1' * 20, '0x' + 'b2' * 20
USDG, MANY = '0x5fc5360d0400a0fd4f2af552add042d716f1d168', '0x' + '7a' * 20
T0, T1 = sorted((USDG, MANY))
ZERO = '0x' + '00' * 20
POOL = {'dex': 4, 'currency0': T0, 'currency1': T1, 'fee': 3000, 'tickSpacing': 60, 'hooks': ZERO}
POLICY = {'mode': 1, 'triggerDistanceBps': 100, 'maxOverlapBps': 100, 'minimumIntervalSeconds': 60,
          'maxPositions': 1}
LIMITS = {'maxSlippageBps': 100, 'maxPriceImpactBps': 100, 'maxObservationAgeSeconds': 300, 'upsideBps': 500}
VAULT = '0x' + 'a2' * 20
INTENT, PLAN, MANDATE = '0x' + 'c1' * 32, '0x' + 'c2' * 32, '0x' + 'c3' * 32


def admin():
    return psycopg.connect(host=str(SOCKET), port=PORT, dbname=DB, user=ADMIN, autocommit=True)


@unittest.skipUnless(os.environ.get('DOMINO_TEST_POSTGRES') == '1', 'isolated PostgreSQL required')
class IndexerTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        with psycopg.connect(host=str(SOCKET), port=PORT, dbname='postgres', user=ADMIN, autocommit=True) as conn:
            if not conn.execute('SELECT 1 FROM pg_database WHERE datname=%s', (DB,)).fetchone():
                conn.execute(sql.SQL('CREATE DATABASE {}').format(sql.Identifier(DB)))
        with admin() as conn:
            conn.execute('DROP SCHEMA IF EXISTS domino_v2 CASCADE')
            conn.execute(MIGRATION.read_text())
            # Applying it again changes nothing (the installers re-run migrations).
            conn.execute(MIGRATION.read_text())

    def setUp(self):
        with admin() as conn:
            conn.execute('TRUNCATE domino_v2.deployments CASCADE')
            conn.execute('TRUNCATE domino_v2.tokens, domino_v2.position_snapshots, domino_v2.vault_snapshots')
        self.store = V2Store({'host': str(SOCKET), 'port': PORT, 'dbname': DB})
        self.chain = IndexChain(head=40)
        # A local test: the fake serves the components' code, not Uniswap's or Permit2's.
        self.document = manifest(receipts={c: (10 + i, self.chain.hash(10 + i), tx_hash(c))
                                           for i, c in enumerate(DEPLOY_ORDER)}, environment='local-test',
                                 block_tag='latest')
        self.deployment = checked_deployment(self.document, CHAIN, admission='local-test')
        self.contracts = self.deployment.manifest['contracts']
        for component, address in self.contracts.items():
            self.chain.codes[address] = synthetic_runtime(address)
        self.clock = [self.chain.timestamp0 + 40]
        self.indexer = self.make_indexer()
        self.registry_constructor()

    def make_indexer(self, **options):
        endpoints = local_endpoints(CHAIN, self.chain)
        return V2Indexer(self.store, CHAIN, endpoints, lag_blocks=0, clock=lambda: self.clock[0],
                         head=lambda: parse_block(self.chain.header(self.chain.head)), **options)

    # ------------------------------------------------------------ scripts
    def registry_constructor(self):
        registry = self.contracts['registry']
        for name, args in (('GovernanceTransferred', {'previous': ZERO, 'current': '0x' + '61' * 20}),
                           ('GuardianChanged', {'previous': ZERO, 'current': '0x' + '62' * 20}),
                           ('FeeRecipientSet', {'recipient': '0x' + '63' * 20}),
                           ('OperatorSet', {'operator': '0x' + '64' * 20, 'allowed': True}),
                           ('ChargeCurrencySet', {'token': USDG, 'rank': 1})):
            self.chain.emit('registry', name, args, address=registry, number=10, tx='registry')

    def create_vault(self, number, *, vault=VAULT, root=7):
        factory = self.contracts['vaultFactory.v4']
        tx = f'create:{vault}'
        self.chain.emit('vault', 'Initialized', {'owner': OWNER, 'dex': 4, 'rootTokenId': root, 'mode': 1},
                        address=vault, number=number, tx=tx)
        self.chain.emit('vault', 'PolicyChanged', {'policy': POLICY, 'stateNonce': 1}, address=vault, number=number,
                        tx=tx)
        self.chain.emit('vault', 'LimitsChanged', {'limits': LIMITS, 'stateNonce': 1}, address=vault, number=number,
                        tx=tx)
        self.chain.emit('vault', 'RootRearmed', {'stateNonce': 1}, address=vault, number=number, tx=tx)
        self.chain.emit('vault_factory', 'VaultCreated', {'owner': OWNER, 'vault': vault, 'rootTokenId': root,
                                                          'dex': 4, 'ownerNonce': 0}, address=factory, number=number, tx=tx)

    def s1_create(self, number, *, token_id=9, label='s1'):
        zap = self.contracts['zap.v4']
        intent = '0x' + label.encode().hex().ljust(64, '0')[:64]
        for name, args in (
                ('InputPulled', {'intentHash': intent, 'owner': OWNER, 'token': USDG, 'amount': 1000}),
                ('SwapLegExecuted', {'kind': 3, 'tokenIn': USDG, 'tokenOut': MANY, 'venue': '0x' + '44' * 20,
                                     'amountIn': 500, 'amountOut': 490}),
                ('FeeCharged', {'kind': 1, 'token': USDG, 'payer': OWNER, 'amount': 3, 'ref': intent}),
                ('PositionLiquidityChanged', {'intentHash': intent, 'owner': OWNER, 'tokenId': token_id, 'pool': POOL,
                                              'liquidityDelta': 100, 'amount0': -490, 'amount1': -497}),
                ('Refunded', {'recipient': OWNER, 'token': USDG, 'amount': 7}),
                ('PositionActionExecuted', {'action': 1, 'recipient': OWNER, 'tokenId': token_id, 'previousTokenId': 0,
                                            'liquidity': 100, 'intentHash': intent})):
            self.chain.emit('zap', name, args, address=zap, number=number, tx=label)

    def execute(self, number, *, vault=VAULT):
        for name, args in (('FeesCollected', {'tokenId': 7, 'amount0': 10, 'amount1': 20}),
                           ('FeeCharged', {'kind': 2, 'token': T0, 'payer': OWNER, 'amount': 1, 'ref': PLAN}),
                           ('FeeDeferred', {'token': T0, 'amount': 1, 'totalOwed': 1}),
                           ('Compounded', {'tokenId': 7, 'liquidityAdded': 50, 'fees0': 10, 'fees1': 20,
                                           'serviceFee0': 1, 'serviceFee1': 0, 'stateNonce': 2}),
                           ('Executed', {'planHash': PLAN, 'action': 1, 'stateNonce': 2})):
            self.chain.emit('vault', name, args, address=vault, number=number, tx=f'exec:{number}')

    def mandate(self, number):
        self.chain.emit('auto_exit', 'MandateRegistered', {'mandateHash': MANDATE, 'owner': OWNER, 'vault': VAULT,
                                                           'tokenId': 7, 'validUntil': self.chain.timestamp0 + 10**6},
                        address=self.contracts['autoExit'], number=number, tx='mandate')

    def rows(self, query, *args):
        with admin() as conn:
            return conn.execute(query, args).fetchall()

    def register(self):
        return self.indexer.register(self.deployment)

    # ------------------------------------------------------------ register
    def test_registration_proves_the_receipts_and_the_code(self):
        report = self.register()
        self.assertEqual((report['status'], report['startBlock']), ('registered', 10))
        self.assertEqual(self.register()['status'], 'already_registered')
        rows = self.rows('SELECT component,emitter,dex FROM domino_v2.contracts ORDER BY component')
        self.assertEqual(len(rows), len(COMPONENTS))
        self.assertIn(('zap.v4', 'zap', 4), rows)
        self.assertIn(('vault.v4', None, None), rows)
        other = manifest(deployer='0x' + '5e' * 20, receipts={c: (10 + i, self.chain.hash(10 + i), tx_hash(c))
                                                              for i, c in enumerate(DEPLOY_ORDER)},
                         environment='local-test', block_tag='latest')
        other = checked_deployment(other, CHAIN, admission='local-test')
        for c, a in other.manifest['contracts'].items():
            self.chain.codes[a] = synthetic_runtime(a)
        with self.assertRaisesRegex(DataError, 'v2_deployment_already_registered'):
            self.indexer.register(other)

    def test_outside_a_local_test_the_dependencies_are_proven_too(self):
        import shutil
        import tempfile
        from v2_fixtures import documents, with_synthetic_code, synthetic_code, write_registry
        directory = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, directory)
        docs = documents()
        real = docs['robinhood-4663.json']['deployer']['codehash']
        synthetic = docs['robinhood-4663.json'] = with_synthetic_code(docs['robinhood-4663.json'])
        # CreateX keeps its real hash: the manifest names CreateX's own runtime.
        synthetic['deployer']['codehash'] = real
        for record in synthetic['verification']['contracts']:
            if record['address'] == synthetic['deployer']['address']:
                record['codehash'] = real
        profile = write_registry(directory, docs).chain('robinhood-4663')
        document = manifest(chain=profile, receipts={c: (10 + i, self.chain.hash(10 + i), tx_hash(c))
                                                     for i, c in enumerate(DEPLOY_ORDER)})
        deployment = checked_deployment(document, profile)
        indexer = V2Indexer(self.store, profile, local_endpoints(profile, self.chain), lag_blocks=0,
                            head=lambda: parse_block(self.chain.header(self.chain.head)))
        with self.assertRaisesRegex(DataError, 'v2_deployment_code_mismatch'):
            indexer.register(deployment)
        for address in deployment.manifest['dependencies'].values():
            self.chain.codes[address] = synthetic_code(address)
        self.assertEqual(indexer.register(deployment)['codesProven'], 24)

    def test_registration_refuses_wrong_code_or_a_receipt_off_the_chain(self):
        self.chain.codes[self.contracts['zap.v4']] = synthetic_runtime(self.contracts['zap.v3'])
        with self.assertRaisesRegex(DataError, 'v2_deployment_code_mismatch'):
            self.register()
        self.chain.codes[self.contracts['zap.v4']] = synthetic_runtime(self.contracts['zap.v4'])
        self.chain.reorg(15)
        with self.assertRaisesRegex(DataError, 'v2_deployment_not_canonical'):
            self.register()
        self.assertEqual(self.rows('SELECT count(*) FROM domino_v2.deployments'), [(0,)])

    # ---------------------------------------------------------------- step
    def test_a_range_commits_events_vaults_activity_and_positions(self):
        self.register()
        self.create_vault(22)
        self.s1_create(23)
        self.execute(25)
        self.mandate(26)
        before = self.chain.count('eth_getLogs')
        result = self.indexer.step(span=100, enrich=False)
        self.assertEqual((result['status'], result['through'], result['vaultsCreated']), ('indexed', 40, 1))
        # One getLogs for the components, one for the vault created in the range.
        self.assertEqual(self.chain.count('eth_getLogs') - before, 2)
        events = self.rows('SELECT event FROM domino_v2.logs ORDER BY block_number,log_index')
        self.assertEqual(len(events), 5 + 5 + 6 + 5 + 1)
        self.assertEqual(self.rows('SELECT vault,owner,dex,root_token_id FROM domino_v2.vaults'),
                         [(VAULT, OWNER, 4, 7)])
        kinds = self.rows('SELECT kind,wallet,cardinality(log_indexes) FROM domino_v2.activity ORDER BY block_number')
        self.assertEqual(kinds, [('vault_created', OWNER, 5), ('s1_action', OWNER, 6), ('vault_execution', OWNER, 5),
                                 ('auto_exit_event', OWNER, 1)])
        self.assertEqual(self.rows('SELECT dex,token_id,source,vault,wallet,last_event_block FROM domino_v2.positions '
                                   'ORDER BY token_id'),
                         [(4, 7, 'vault_root', VAULT, OWNER, 25), (4, 9, 's1', None, OWNER, 23)])
        self.assertEqual(self.rows('SELECT end_block,events FROM domino_v2.checkpoints'), [(40, 22)])
        caught = self.indexer.step(span=100, enrich=False)
        self.assertEqual(caught['status'], 'caught_up_to_target')

    def test_a_caught_up_pass_reads_one_header(self):
        self.register()
        self.indexer.step(span=100, enrich=False)
        calls = len(self.chain.log)
        self.indexer.step(span=100, enrich=False)
        self.assertEqual([m for m, _ in self.chain.log[calls:]], ['eth_getBlockByNumber'])

    def test_ranges_follow_the_span_and_continue_their_checkpoints(self):
        self.register()
        self.s1_create(15)
        first = self.indexer.step(span=10, enrich=False)
        self.assertEqual((first['fromBlock'], first['through']), (10, 19))
        self.assertEqual(self.indexer.step(span=10, enrich=False)['through'], 29)
        self.assertEqual([r[0] for r in self.rows('SELECT end_block FROM domino_v2.checkpoints ORDER BY 1')], [19, 29])

    def test_a_reorganization_rewinds_to_the_newest_standing_checkpoint(self):
        self.register()
        self.s1_create(15, label='old')
        self.indexer.step(span=10, enrich=False)
        self.indexer.step(span=10, enrich=False)
        self.indexer.step(span=11, enrich=False)
        self.chain.reorg(25)
        self.s1_create(27, token_id=11, label='new')
        self.assertEqual(self.indexer.step(span=10, enrich=False), {'status': 'rewound', 'through': 19})
        self.assertEqual([r[0] for r in self.rows('SELECT end_block FROM domino_v2.checkpoints')], [19])
        self.indexer.step(span=30, enrich=False)
        self.assertEqual([r[0] for r in self.rows("SELECT token_id FROM domino_v2.positions ORDER BY 1")], [9, 11])
        hashes = {r[0]: r[1] for r in self.rows('SELECT end_block,end_hash FROM domino_v2.checkpoints')}
        self.assertEqual(hashes[40], self.chain.hash(40))

    def test_a_shorter_chain_rewinds_to_the_checkpoint_it_still_has(self):
        self.register()
        self.indexer.step(span=10, enrich=False)
        self.indexer.step(span=10, enrich=False)
        self.indexer.step(span=21, enrich=False)
        self.chain.reorg(25)
        self.chain.head = 26
        self.assertEqual(self.indexer.step(span=10, enrich=False), {'status': 'rewound', 'through': 19})

    def test_a_reorganization_below_every_checkpoint_rewinds_to_the_base(self):
        self.register()
        self.s1_create(15, label='old')
        self.indexer.step(span=10, enrich=False)
        self.chain.reorg(12)
        self.assertEqual(self.indexer.step(span=10, enrich=False), {'status': 'rewound', 'through': 9})
        self.assertEqual(self.rows('SELECT count(*) FROM domino_v2.logs'), [(0,)])
        self.assertEqual(self.rows('SELECT count(*) FROM domino_v2.activity'), [(0,)])

    def test_a_deployment_reorganized_away_stops_the_indexer(self):
        self.register()
        self.indexer.step(span=10, enrich=False)
        self.chain.reorg(5)
        with self.assertRaisesRegex(DataError, 'v2_deployment_reorganized'):
            self.indexer.step(span=10, enrich=False)
        self.assertEqual(self.rows('SELECT last_error FROM domino_v2.deployments'), [('v2_deployment_reorganized',)])

    def test_a_chain_that_moves_during_the_read_commits_nothing(self):
        self.register()
        original = self.chain.answer
        moved = []

        def answer(body):
            reply = original(body)
            if body['method'] == 'eth_getLogs' and not moved:
                moved.append(True)
                self.chain.reorg(30)
            return reply
        self.chain.answer = answer
        with self.assertRaisesRegex(DataError, 'snapshot_reorganized'):
            self.indexer.step(span=100, enrich=False)
        self.chain.answer = original
        self.assertEqual(self.rows('SELECT count(*) FROM domino_v2.checkpoints'), [(0,)])
        self.assertEqual(self.indexer.step(span=100, enrich=False)['status'], 'indexed')

    def test_an_event_the_model_does_not_expect_is_refused_and_recorded(self):
        self.register()
        # A Compounded from a zap: a known event its emitter never emits.
        self.chain.emit('vault', 'Compounded', {'tokenId': 7, 'liquidityAdded': 50, 'fees0': 10, 'fees1': 20,
                                                'serviceFee0': 1, 'serviceFee1': 0, 'stateNonce': 2},
                        address=self.contracts['zap.v4'], number=20, tx='odd')
        with self.assertRaisesRegex(DataError, 'v2_unexpected_event'):
            self.indexer.step(span=100, enrich=False)
        self.assertEqual(self.rows('SELECT last_error,next_block FROM domino_v2.deployments'),
                         [('v2_unexpected_event', 10)])

    def test_one_writer_per_chain(self):
        self.register()
        with self.store.writer(4663):
            with self.assertRaisesRegex(DataError, 'v2_indexer_busy'):
                self.indexer.step(span=10, enrich=False)
        with self.store.writer(8453):
            self.indexer.step(span=10, enrich=False)

    def test_the_reader_role_cannot_write(self):
        self.register()
        with psycopg.connect(host=str(SOCKET), port=PORT, dbname=DB, user='domino_catalogue_reader') as conn:
            with self.assertRaises(psycopg.errors.InsufficientPrivilege):
                conn.execute('DELETE FROM domino_v2.logs')

    # ---------------------------------------------------------- enrichment
    def serve(self, target, interface, name, values, *, revert=False):
        fn = function(interface, name)

        def handler(data, block):
            if revert:
                return {'code': 3, 'message': 'execution reverted', 'data': '0x'}
            return '0x' + encode(list(fn.outputs), list(values)).hex()
        self.chain.calls[(target, fn.selector)] = handler

    def serve_vault(self, vault=VAULT, paused=False):
        root = (4, CHAIN.uniswap.v4.positionManager, 7)
        pool = (4, T0, T1, 3000, 60, ZERO)
        self.serve(vault, 'IDominoVaultLedger', 'member', ((True, 0, 0, -600, 600),))
        self.serve(vault, 'IDominoVaultLedger', 'lot', ((10, 0),))
        self.serve(vault, 'IDominoVault', 'reserves', (10,))
        self.serve(vault, 'IDominoVaultLedger', 'idleReserves', (0,))
        for interface, name, value in (
                ('IDominoVault', 'owner', OWNER), ('IDominoVault', 'factory', self.contracts['vaultFactory.v4']),
                ('IDominoVault', 'pool', pool), ('IDominoVault', 'root', root), ('IDominoVault', 'positions', [7]),
                ('IDominoVault', 'policy', tuple(POLICY.values())), ('IDominoVault', 'limits', tuple(LIMITS.values())),
                ('IDominoVault', 'paused', paused), ('IDominoVault', 'rootArmed', True),
                ('IDominoVault', 'stateNonce', 2), ('IDominoVault', 'exitModule', ZERO),
                ('IDominoVaultLedger', 'quoteCurrency', USDG), ('IDominoVaultLedger', 'lastExecutionAt', 1234)):
            self.serve(vault, interface, name, (value,))

    def serve_token(self, token, decimals, symbol):
        def call(signature, output):
            from eth_hash.auto import keccak
            selector = '0x' + keccak(signature.encode())[:4].hex()
            self.chain.calls[(token, selector)] = lambda data, block: '0x' + encode([output[0]], [output[1]]).hex()
        call('decimals()', ('uint8', decimals))
        call('symbol()', ('string', symbol))

    def test_enrichment_reads_at_the_checkpoint_and_the_read_api_serves_it(self):
        self.register()
        self.create_vault(22)
        self.s1_create(23)
        self.execute(25)
        self.mandate(26)
        self.serve_vault()
        record = (OWNER, self.chain.timestamp0 + 10**6, 150, 1, 1, VAULT, USDG, 2**95, 0, 7)
        self.serve(self.contracts['autoExit'], 'IDominoAutoExitExtension', 'mandateOf', (record,))
        self.serve_token(USDG, 6, 'USDG')
        self.serve_token(MANY, 18, 'MANY')
        result = self.indexer.step(span=100)
        enrichment = result['enrichment']
        self.assertEqual((enrichment['status'], enrichment['transactions'], enrichment['mandates'],
                          enrichment['vaults']), ('done', 4, 1, 1))
        # The fake serves no Uniswap code: the positions read as unavailable, with the reason.
        self.assertEqual(self.rows('SELECT status,reason FROM domino_v2.position_snapshots ORDER BY token_id'),
                         [('unavailable', 'v2_deployment_code_mismatch')] * 2)
        self.assertEqual(sorted(self.rows('SELECT address,decimals,symbol,status FROM domino_v2.tokens')),
                         sorted([(USDG, 6, 'USDG', 'available'), (MANY, 18, 'MANY', 'available')]))
        self.assertEqual(self.rows('SELECT terms->>\'receiveMode\',terms->>\'convertTo\' FROM domino_v2.mandates'),
                         [('1', USDG)])
        # A pass with nothing due spends no call on enrichment.
        calls = len(self.chain.log)
        self.indexer.step(span=100)
        self.assertEqual([m for m, _ in self.chain.log[calls:]], ['eth_getBlockByNumber'])

        service = V2ReadService(self.store, clock=lambda: self.clock[0] + 5)
        portfolio = service.portfolio(OWNER)
        robinhood = portfolio['chains'][0]
        self.assertEqual((robinhood['chainId'], robinhood['status'], robinhood['indexedThrough']['number']),
                         (4663, 'current', 40))
        self.assertEqual([c['status'] for c in portfolio['chains'][1:]], ['unavailable', 'unavailable'])
        self.assertEqual(portfolio['coverage'], 'partial')
        vault, = portfolio['vaults']
        self.assertEqual((vault['address'], vault['state']['status'], vault['totals']['executions'],
                          vault['totals']['serviceFees'], vault['autoExitEnabled']),
                         (VAULT, 'read', 1, ['1', '0'], False))
        self.assertEqual([m['status'] for m in vault['members']], ['armed'])
        self.assertEqual(vault['custody'], {'armed': True, 'reason': None, 'source': None, 'since': None})
        self.assertEqual(vault['state']['reserves'], [{'token': T0, 'total': '10', 'idle': '0'},
                                                     {'token': T1, 'total': '10', 'idle': '0'}])
        self.assertEqual(vault['state']['members'][0]['lots'][0], {'token': T0, 'uncharged': '10', 'charged': '0'})
        mandate, = portfolio['mandates']
        # The module is off on the vault, and the root was never read live (no Uniswap here).
        self.assertEqual((mandate['status'], mandate['terms']['receive'], mandate['moduleEnabled'],
                          mandate['position'], mandate['blockedBy']),
                         ('active', 'converted', False, 'root', ['module_disabled', 'custody_unread']))
        self.assertEqual(robinhood['operatorsAdmitted'], 1)
        self.assertEqual(robinhood['finalizedThrough']['number'], 40)
        self.assertEqual(sorted(p['tokenId'] for p in portfolio['positions']), ['7', '9'])
        self.assertEqual({t['address']: t['symbol'] for t in portfolio['tokens']}, {USDG: 'USDG', MANY: 'MANY'})

        activity = service.activity(OWNER, limit=2)
        self.assertEqual([i['kind'] for i in activity['items']], ['auto_exit_event', 'vault_execution'])
        execution = activity['items'][1]
        self.assertEqual(execution['tariffs'], [{'kind': 'automation', 'rateBps': 200, 'token': T0, 'amount': '1',
                                                 'deferred': '1'}])
        self.assertEqual((execution['tx']['gas']['gasUsed'], execution['tx']['finality']), ('210000', 'finalized'))
        rest = service.activity(OWNER, limit=2, cursor=activity['nextCursor'])
        self.assertEqual([i['kind'] for i in rest['items']], ['s1_action', 'vault_created'])
        self.assertIsNone(rest['nextCursor'])
        action = rest['items'][0]
        self.assertEqual((action['action'], action['tariffs'][0]['rateBps'], action['legs'][0]['kind']),
                         ('create', 65, 'v4_pool'))
        self.assertEqual(service.activity(OTHER)['items'], [])

    def test_a_return_the_owner_did_not_send_reads_as_reserves_returned(self):
        # read-v6's reserves_returned (0xdecimal's item 8), told apart at read time: the stored sender and the
        # registry's OperatorSet events (the constructor admitted 0x64..; OTHER is admitted, then revoked).
        self.register()
        self.create_vault(22)
        for number, allowed in ((23, True), (25, False)):
            self.chain.emit('registry', 'OperatorSet', {'operator': OTHER, 'allowed': allowed},
                            address=self.contracts['registry'], number=number, tx=f'operator-{number}')
        self.chain.emit('vault', 'ReservesWithdrawn', {'token': T1, 'amount': 5, 'stateNonce': 2}, address=VAULT,
                        number=24, tx='withdraw')
        for token, amount in ((T0, 7), (T1, 9)):
            self.chain.emit('vault', 'ReservesWithdrawn', {'token': token, 'amount': amount, 'stateNonce': 3},
                            address=VAULT, number=25, tx='return')
        self.chain.emit('vault', 'ReservesWithdrawn', {'token': T0, 'amount': 4, 'stateNonce': 4}, address=VAULT,
                        number=26, tx='revoked')
        self.chain.receipts.update({tx_hash('withdraw'): (24, OWNER), tx_hash('return'): (25, '0x' + '64' * 20),
                                    tx_hash('revoked'): (26, OTHER)})
        self.indexer.step(span=100)
        items = V2ReadService(self.store, clock=lambda: self.clock[0] + 5).activity(OWNER)['items']
        self.assertEqual([(i['kind'], i.get('returnedBy'), i.get('byOperator')) for i in items],
                         [('reserves_returned', OTHER, False), ('reserves_returned', '0x' + '64' * 20, True),
                          ('vault_event', None, None), ('vault_created', None, None)])
        self.assertEqual(items[1]['reservesReturned'], [{'token': T0, 'amount': '7'}, {'token': T1, 'amount': '9'}])
        self.assertEqual(items[1]['stateNonce'], '3')
        self.assertEqual(items[2]['events'], [{'event': 'ReservesWithdrawn', 'stateNonce': '2', 'token': T1,
                                               'amount': '5'}])

    def test_the_answers_tokens_are_priced_with_the_decimals_the_index_read(self):
        # Qualified USD on the stored routes: the read service asks the chain reads' pricer, with what it read.
        self.register()
        self.create_vault(22)
        self.s1_create(23)
        self.serve_token(USDG, 6, 'USDG')
        self.serve_token(MANY, 18, 'MANY')
        self.indexer.step(span=100)
        asked = []

        class Pricer:
            def prices(self, tokens):
                asked.extend(tokens)
                return {(chain_id, token): ({'usd': '1.000000000000000000', 'source': 'chain_stable', 'snapshot': None,
                                             'ethUsd': None, 'pool': None, 'depthUsd': None}, None)
                        if token == USDG else (None, 'no_pool') for chain_id, token, _ in tokens}
        service = V2ReadService(self.store, clock=lambda: self.clock[0] + 5, pricer=Pricer())
        tokens = {t['address']: (t['decimals'], t['price'] and t['price']['source'], t['priceReason'])
                  for t in service.activity(OWNER)['tokens']}
        self.assertEqual(tokens, {USDG: (6, 'chain_stable', None), MANY: (18, None, 'no_pool')})
        self.assertEqual(sorted(asked), sorted([(4663, USDG, 6), (4663, MANY, 18)]))
        # Without the chain reads, no token has a price.
        unpriced = V2ReadService(self.store, clock=lambda: self.clock[0] + 5).activity(OWNER)['tokens']
        self.assertEqual({t['priceReason'] for t in unpriced}, {'no_qualified_price_source'})

    def test_the_tokens_read_in_full_feed_the_chain_search(self):
        # read-v6 chain-tokens' v2_activity source: a chain's available tokens, by address, through the reader role.
        rows = [(CHAIN.chainId, '0x' + '03' * 20, 6, 'ALPHA', 'available'),  # by address, not by symbol
                (CHAIN.chainId, '0x' + '01' * 20, 18, 'ONE', 'available'),
                (CHAIN.chainId, '0x' + '02' * 20, None, 'TWO', 'partial'),
                (CHAIN.chainId, '0x' + '04' * 20, None, None, 'unavailable'),
                (8453, '0x' + '00' * 20, 18, 'BASE', 'available')]
        with admin() as conn:
            for row in rows:
                conn.execute('''INSERT INTO domino_v2.tokens(chain_id,address,decimals,symbol,status,block_number)
                  VALUES(%s,%s,%s,%s,%s,1)''', row)
        with self.store.reader() as reader:
            self.assertEqual(reader.available_tokens(CHAIN.chainId, 10),
                             [('0x' + '01' * 20, 18, 'ONE'), ('0x' + '03' * 20, 6, 'ALPHA')])
            self.assertEqual(reader.available_tokens(CHAIN.chainId, 1), [('0x' + '01' * 20, 18, 'ONE')])
            self.assertEqual(reader.available_tokens(8453, 10), [('0x' + '00' * 20, 18, 'BASE')])

    def test_the_automation_s_waiting_file_is_kept_and_served(self):
        import json
        import os
        import shutil
        import tempfile
        directory = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, directory)
        path = directory / 'waiting-4663.json'
        t0 = self.chain.timestamp0

        def write(seconds, vault, mandate):
            """vault, mandate: (reason, since seconds, last revert or None), as the automation's journal records them."""
            t = t0 + seconds

            def entry(reason, since, revert):
                return {'reason': reason, 'since': t0 + since, 'sinceBlock': since, 'at': t, 'block': seconds,
                        'lastRevert': revert}
            document = {'schemaVersion': 1, 'kind': 'domino-v2-automation-waiting', 'chainId': 4663, 'block': seconds,
                        'timestamp': t, 'vaults': {VAULT: entry(*vault)}, 'mandates': {MANDATE: entry(*mandate)}}
            (directory / '.next').write_text(json.dumps(document))
            os.replace(directory / '.next', path)
        self.register()
        self.create_vault(22)
        self.mandate(26)
        indexer = self.make_indexer(waiting_file=str(path))
        # Configured, but the automation has not written it yet.
        self.assertEqual(indexer.step(span=100, enrich=False)['waiting'],
                         {'status': 'unavailable', 'reason': 'v2_waiting_file_unreadable'})
        write(30, ('gas_not_covered', 30, None), ('trigger_not_reached', 30, None))
        self.assertEqual(indexer.step(enrich=False)['waiting'], {'status': 'read', 'block': 30, 'subjects': 2})
        self.assertEqual(indexer.step(enrich=False)['waiting'], {'status': 'unchanged', 'block': 30})
        revert = {'code': 'reverted_spot_outside_band', 'at': t0 + 90, 'block': 90}
        write(90, ('gas_not_covered', 30, None), ('reverted_spot_outside_band', 90, revert))
        indexer.step(enrich=False)
        self.assertEqual(self.rows('SELECT kind,reason,since,since_block,at FROM domino_v2.waiting ORDER BY kind'),
                         [('mandate', 'reverted_spot_outside_band', t0 + 90, 90, t0 + 90),
                          ('vault', 'gas_not_covered', t0 + 30, 30, t0 + 90)])
        self.clock[0] = t0 + 100
        portfolio = V2ReadService(self.store, clock=lambda: self.clock[0]).portfolio(OWNER)
        self.assertEqual([c['waitingReasons']['status'] for c in portfolio['chains']],
                         ['reporting', 'not_configured', 'not_configured'])
        vault, = portfolio['vaults']
        self.assertEqual({k: vault['waiting'][k] for k in ('reason', 'since', 'sinceBlock', 'checkedAt')},
                         {'reason': 'gas_not_covered', 'since': t0 + 30, 'sinceBlock': 30, 'checkedAt': t0 + 90})
        mandate, = portfolio['mandates']
        self.assertEqual((mandate['waiting']['error'], mandate['waiting']['lastRevert']['error']),
                         ('SpotOutsideBand', 'SpotOutsideBand'))
        # A rewind leaves the automation's reasons alone: they are not derived from blocks.
        self.chain.reorg(30)
        self.chain.mine(1)
        indexer.step(enrich=False)
        self.assertEqual(len(self.rows('SELECT * FROM domino_v2.waiting')), 2)
        path.unlink()
        indexer.step(enrich=False)
        portfolio = V2ReadService(self.store, clock=lambda: self.clock[0]).portfolio(OWNER)
        self.assertEqual(portfolio['chains'][0]['waitingReasons']['status'], 'unavailable')
        self.assertIsNone(portfolio['vaults'][0]['waiting'])

    def test_a_snapshot_whose_checkpoint_was_rewound_is_not_written(self):
        self.register()
        self.create_vault(22)
        self.serve_vault()
        self.indexer.step(span=100, enrich=False)
        original = self.chain.answer

        def answer(body):
            # Rewind the store between the pinned read and the write.
            if body['method'] == 'eth_call' and not getattr(answer, 'done', False):
                answer.done = True
                with admin() as conn:
                    conn.execute('DELETE FROM domino_v2.checkpoints')
            return original(body)
        self.chain.answer = answer
        with self.store.writer(4663) as writer:
            report = self.indexer.enrich(writer)
        self.assertEqual(report['vaults'], 0)
        self.assertEqual(self.rows('SELECT count(*) FROM domino_v2.vault_snapshots'), [(0,)])

    def test_a_reverted_vault_view_reads_as_unavailable(self):
        self.register()
        self.create_vault(22)
        self.serve_vault()
        self.serve(VAULT, 'IDominoVault', 'paused', (False,), revert=True)
        self.indexer.step(span=100)
        self.assertEqual(self.rows('SELECT status,reason FROM domino_v2.vault_snapshots'),
                         [('unavailable', 'rpc_call_reverted')])

    def test_an_unknown_vault_code_owner_mismatch_is_unavailable(self):
        self.register()
        self.create_vault(22)
        self.serve_vault()
        self.serve(VAULT, 'IDominoVault', 'owner', (OTHER,))
        self.indexer.step(span=100)
        self.assertEqual(self.rows('SELECT status,reason FROM domino_v2.vault_snapshots'),
                         [('unavailable', 'v2_vault_state_mismatch')])


if __name__ == '__main__':
    unittest.main()
