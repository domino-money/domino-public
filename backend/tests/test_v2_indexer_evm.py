"""The V2 indexer and read-v6 on the real V2 contracts: a disposable Base Anvil and PostgreSQL.

Uniswap is the bytecode deployed on Base (F1c's fixtures at their Base
addresses) and the V2 stack is every component at its CREATE3 address, both
from the automation's local chain (tests/v2_local_chain.py: LocalChain,
deploy_v2), whose manifest is #302's format, admitted as a local test by
v2_manifest. The deployment tool's local mode (scripts/v2/deploy-local.mjs,
PR #302) deploys the same contracts, but with synthetic dependencies that
cannot run a pool, and this journey needs real Uniswap.

The journey: an owner creates a position through the v4 zap (S1), puts it in
a vault, pauses and resumes it and enables auto-exit; swaps earn it fees; the
operator compounds with a publisher-signed observation (2% tariff); the owner
registers two exit mandates and revokes one, pauses the vault, and the
operator executes the other (20 bps), which a paused vault allows (protection
without compounding). The indexer follows all of it from the deployment's
first block, enriches it, and the read API answers from the index. Events are
decoded with the frozen ABI exports; a test holds that catalog to every event
the compiled contracts declare (contracts/out), until the exporter covers the
implementation events (3c). Other chains: the registry's governance (a
timelocked change, a cancellation, a removal, the epoch and the halt) as the
chain status shows it; a position burned through the zap, proven by the
manager and no longer listed, and a burn too far back for one read; two
reorganizations under the indexer.
"""
import json
import os
from pathlib import Path
import shutil
import sys
import tempfile
import unittest

from eth_abi import decode, encode
from eth_hash.auto import keccak
import psycopg
from psycopg import sql

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))
from eth_account import Account  # noqa: E402
from eth_account.messages import encode_typed_data  # noqa: E402

from discovery import parse_block  # noqa: E402
from dev_postgres import ADMIN, PORT, SOCKET  # noqa: E402
from v2_chains import default_registry  # noqa: E402
from v2_events import catalog  # noqa: E402
from v2_index_fixtures import local_endpoints  # noqa: E402
from v2_index_store import V2Store  # noqa: E402
from v2_indexer import V2Indexer  # noqa: E402
from v2_manifest import checked_deployment  # noqa: E402
from v2_read_contract import CHAIN_IDS  # noqa: E402
from v2_read_service import V2ReadService  # noqa: E402
from v2_local_chain import LocalChain, calldata, deploy_v2  # noqa: E402

CHAIN = default_registry().chain('base-8453')
OUT = Path(__file__).resolve().parents[2] / 'contracts/out'
# Anvil's default accounts (mnemonic "test test test test test test test test test test test junk"), by role.
ROLES = ('deployer', 'governance', 'guardian', 'feeRecipient', 'operator', 'publisher', 'owner')
KEYS = ('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
        '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
        '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a',
        '0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6',
        '0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a',
        '0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba',
        '0x92db14e403b83dfe3df233f83dfa3a0d7096f21ca9b0d6d6b8d88b2b4ec1564e')

DB = 'domino_v2_index_evm_tests'
MIGRATION = Path(__file__).resolve().parents[1] / 'migrations/052_v2_index.sql'
EIP712 = json.loads((Path(__file__).resolve().parents[2] / 'api-contracts/v2/eip712.json').read_text())
ZERO = '0x' + '00' * 20
U128 = 2**128 - 1
POOL_TYPE = '(uint8,address,address,uint24,int24,address)'
KEY_TYPE = '(address,address,uint24,int24,address)'
LEG_TYPE = '(uint8,address,address,address,uint128,uint128,bytes)'
INTENT_TYPE = f'(uint8,{POOL_TYPE},uint256,int24,int24,uint128,uint16,address,bytes32,address,uint256,uint64)'
CREATE_PLAN = f'({INTENT_TYPE},(address,uint128)[],{LEG_TYPE}[],uint128,uint128,uint160)'
EXIT_PLAN = f'({INTENT_TYPE},uint128,uint128,uint128,{LEG_TYPE}[],bool)'
INIT_TYPE = '((uint8,address,uint256),(uint8,uint16,uint16,uint32,uint8),(uint16,uint16,uint32,uint32),bool,bool)'
MANDATE_TYPE = '(address,address,uint256,uint160,uint160,uint8,address,uint16,uint64,uint256)'
OBSERVATION_TYPE = f'({POOL_TYPE},uint160,uint64,uint64,uint64)'
PLAN_V1_TYPE = ('(uint8,uint64,uint64,uint256,int24,int24,uint128,uint128,uint128,uint256[],'
                f'(uint256,uint128,uint128)[],(uint256,bool,uint128,uint128,{LEG_TYPE}[]),bytes)')
EXECUTION_TYPE = f'(bytes,{LEG_TYPE}[],uint128,uint128)'
AMOUNT = 10**20
# Each emitter kind's compiled contracts (contracts/out): what its address can emit.
ARTIFACTS = {
    'registry': ['DominoRegistry.sol/DominoRegistry'],
    'price_anchor': ['DominoPriceAnchor.sol/DominoPriceAnchor'],
    'vault_factory': ['DominoV2VaultFactory.sol/DominoV2VaultFactory'],
    # A vault clone runs its implementation, its executor and the swap module
    # (DELEGATECALL): their events carry the clone's address.
    'vault': ['DominoV2VaultV3.sol/DominoV2VaultV3', 'DominoV2VaultV4.sol/DominoV2VaultV4',
              'DominoV2VaultV3.sol/DominoV2VaultExecutorV3', 'DominoV2VaultV4.sol/DominoV2VaultExecutorV4',
              'DominoV2VaultSwapModule.sol/DominoV2VaultSwapModule'],
    'zap': ['DominoZapV3.sol/DominoZapV3', 'DominoZapV4.sol/DominoZapV4', 'DominoZapV4Steps.sol/DominoZapV4Steps'],
    'auto_exit': ['DominoAutoExit.sol/DominoAutoExit'],
}


def admin():
    return psycopg.connect(host=str(SOCKET), port=PORT, dbname=DB, user=ADMIN, autocommit=True)


def prepare_database():
    with psycopg.connect(host=str(SOCKET), port=PORT, dbname='postgres', user=ADMIN, autocommit=True) as conn:
        if not conn.execute('SELECT 1 FROM pg_database WHERE datname=%s', (DB,)).fetchone():
            conn.execute(sql.SQL('CREATE DATABASE {}').format(sql.Identifier(DB)))
    with admin() as conn:
        conn.execute('DROP SCHEMA IF EXISTS domino_v2 CASCADE')
        conn.execute(MIGRATION.read_text())
    return V2Store({'host': str(SOCKET), 'port': PORT, 'dbname': DB})


def signature(event):
    def kind(item):
        if item['type'].startswith('tuple'):
            return '(' + ','.join(kind(c) for c in item['components']) + ')' + item['type'][5:]
        return item['type']
    return event['name'] + '(' + ','.join(kind(i) for i in event['inputs']) + ')'


def topic(text):
    return '0x' + keccak(text.encode()).hex()


class Chain(LocalChain):
    """The automation's LocalChain on Base's chain id, with Anvil's accounts by role and their keys."""
    def __init__(self):
        super().__init__(CHAIN.chainId)
        self.roles = dict(zip(ROLES, self.accounts))
        self.keys = dict(zip(ROLES, KEYS))
        if any(Account.from_key(self.keys[role]).address.lower() != self.roles[role] for role in ROLES):
            raise AssertionError('unexpected Anvil accounts')

    def block(self, tag='latest'):
        return self.request('eth_getBlockByNumber', [tag, False])

    def transport(self, _url, body):
        return self.raw(body)

    def sign_typed(self, role, primary, types, domain, message):
        full = {'types': {'EIP712Domain': [{'name': 'name', 'type': 'string'}, {'name': 'version', 'type': 'string'},
                                           {'name': 'chainId', 'type': 'uint256'},
                                           {'name': 'verifyingContract', 'type': 'address'}], **types},
                'primaryType': primary, 'domain': domain, 'message': message}
        return Account.sign_message(encode_typed_data(full_message=full), self.keys[role]).signature


class Journey:
    """One Anvil with Base's Uniswap and V2, and the actions the tests take on it."""
    def __init__(self):
        self.anvil = anvil = Chain()
        roles = anvil.roles
        try:
            anvil.etch_base_uniswap(CHAIN)
            a, b = (anvil.deploy(roles['deployer'], 'DominoSetup.t.sol', 'SetupToken') for _ in range(2))
            self.c0, self.c1 = sorted((a, b))
            self.manifest = deploy_v2(anvil, CHAIN, deployer=roles['deployer'], governance=roles['governance'],
                                      guardian=roles['guardian'], fee_recipient=roles['feeRecipient'],
                                      operator=roles['operator'], publisher=roles['publisher'])
        except BaseException:
            anvil.stop()
            raise
        self.contracts = self.manifest['contracts']
        self.deployment = checked_deployment(self.manifest, CHAIN, admission='local-test')
        self.owner, self.operator, self.deployer = roles['owner'], roles['operator'], roles['deployer']
        self.pool = (4, self.c0, self.c1, 3000, 60, ZERO)
        self.key = (self.c0, self.c1, 3000, 60, ZERO)
        self.v4 = CHAIN.uniswap.v4
        self.driver = None

    def stop(self):
        self.anvil.stop()

    # ------------------------------------------------------------ helpers
    def now(self):
        return int(self.anvil.block()['timestamp'], 16)

    def advance(self, seconds):
        self.anvil.request('evm_increaseTime', [seconds])
        self.anvil.request('evm_mine', [])

    def fund(self, holder, amount=10 * AMOUNT):
        for token in (self.c0, self.c1):
            self.anvil.send(self.deployer, token, calldata('mint(address,uint256)', ['address', 'uint256'],
                                                           [holder, amount]))

    def spot(self):
        pool_id = keccak(encode(['address', 'address', 'uint24', 'int24', 'address'], list(self.key)))
        return self.anvil.call(self.v4.stateView, 'getSlot0(bytes32)', ['uint160', 'int24', 'uint24', 'uint24'],
                               ['bytes32'], [pool_id])[0]

    def events(self, receipt, address, text):
        return [log for log in receipt['logs'] if log['address'].lower() == address and log['topics'][0] == topic(text)]

    def sign(self, role, primary, domain_contract, message):
        types = {name: EIP712['types'][name] for name in ('PoolRef', primary) if name in EIP712['types']}
        if primary == 'ExitMandate':
            types = {'ExitMandate': EIP712['types']['ExitMandate']}
        domain = {'name': 'Domino', 'version': '2', 'chainId': CHAIN.chainId, 'verifyingContract': domain_contract}
        return self.anvil.sign_typed(role, primary, types, domain, message)

    def observation(self, nonce):
        """The publisher's signed observation of the pool's spot: the anchor's evidence."""
        price, observed = self.spot(), self.now()
        pool = dict(zip(('dex', 'currency0', 'currency1', 'fee', 'tickSpacing', 'hooks'), self.pool))
        signed = self.sign('publisher', 'PriceObservation', self.contracts['priceAnchor'],
                           {'pool': pool, 'sqrtPriceX96': price, 'observedAt': observed, 'validUntil': observed + 120,
                            'nonce': nonce})
        return encode([OBSERVATION_TYPE, 'bytes'], [(self.pool, price, observed, observed + 120, nonce), signed])

    # ------------------------------------------------------------ actions
    def s1_create(self, lower=-600, upper=600, amount=AMOUNT, nonce=0, init=True):
        """The owner's S1 create through the v4 zap, no swap: returns (receipt, token id)."""
        zap, anvil = self.contracts['zap.v4'], self.anvil
        self.fund(self.owner)
        for token in (self.c0, self.c1):
            anvil.send(self.owner, token, calldata('approve(address,uint256)', ['address', 'uint256'], [zap, amount]))
        routes = keccak(encode([LEG_TYPE + '[]'], [[]]))
        intent = (1, self.pool, 0, lower, upper, 1, 0, ZERO, routes, self.owner, nonce, self.now() + 600)
        plan = (intent, [(self.c0, amount), (self.c1, amount)], [], amount, amount, 2**96 if init else 0)
        receipt = anvil.send(self.owner, zap, calldata('create(' + CREATE_PLAN + ')', [CREATE_PLAN], [plan]))
        executed, = self.events(receipt, zap, 'PositionActionExecuted(uint8,address,uint256,uint256,uint128,bytes32)')
        return receipt, int(executed['topics'][3], 16)

    def s1_exit(self, token_id, lower=-600, upper=600, nonce=1):
        """The owner's S1 exit of the whole position through the v4 zap, burning it."""
        zap, anvil = self.contracts['zap.v4'], self.anvil
        liquidity, = anvil.call(self.v4.positionManager, 'getPositionLiquidity(uint256)', ['uint128'], ['uint256'],
                                [token_id])
        anvil.send(self.owner, self.v4.positionManager, calldata('approve(address,uint256)', ['address', 'uint256'],
                                                                 [zap, token_id]))
        routes = keccak(encode([LEG_TYPE + '[]'], [[]]))
        intent = (4, self.pool, token_id, lower, upper, liquidity, 0, ZERO, routes, self.owner, nonce,
                  self.now() + 600)
        plan = (intent, liquidity, 0, 0, [], True)
        return anvil.send(self.owner, zap, calldata('exit(' + EXIT_PLAN + ')', [EXIT_PLAN], [plan]))

    def swaps(self, rounds, amount=10**18):
        if self.driver is None:
            self.driver = self.anvil.deploy(self.deployer, 'OfficialV4Fixture.sol', 'OfficialV4SwapDriver',
                                            ['address'], [self.v4.poolManager])
            self.fund(self.driver, 100 * AMOUNT)
        for _ in range(rounds):
            for direction in (True, False):
                self.anvil.send(self.deployer, self.driver, calldata('swap(' + KEY_TYPE + ',bool,uint256)',
                                                                     [KEY_TYPE, 'bool', 'uint256'],
                                                                     [self.key, direction, amount]))

    def create_vault(self, token_id):
        factory, anvil = self.contracts['vaultFactory.v4'], self.anvil
        nonce, = anvil.call(factory, 'nextNonce(address)', ['uint256'], ['address'], [self.owner])
        vault, = anvil.call(factory, 'predictVault(address,uint256)', ['address'], ['address', 'uint256'],
                            [self.owner, nonce])
        vault = vault.lower()
        anvil.send(self.owner, self.v4.positionManager, calldata('approve(address,uint256)', ['address', 'uint256'],
                                                                 [vault, token_id]))
        init = ((4, self.v4.positionManager, token_id), (1, 500, 2000, 600, 1), (100, 100, 300, 1000), False, True)
        receipt = anvil.send(self.owner, factory, calldata('createVault(' + INIT_TYPE + ',uint256)',
                                                           [INIT_TYPE, 'uint256'], [init, nonce]))
        return receipt, vault

    def compound(self, vault, token_id):
        """The operator's compound of the root: collect, add, the tariff."""
        anvil = self.anvil
        state_nonce, = anvil.call(vault, 'stateNonce()', ['uint64'])
        plan = (1, state_nonce, self.now() + 300, token_id, 0, 0, U128, U128, 1, [token_id], [(token_id, U128, U128)],
                (0, False, 0, 0, []), self.observation(nonce=1))
        raw = b'\x01' + encode([PLAN_V1_TYPE], [plan])
        return anvil.send(self.operator, vault, calldata('execute(bytes)', ['bytes'], [raw]))

    def mandate(self, vault, token_id, *, nonce, below=0, above=0):
        mandate = (self.owner, vault, token_id, below, above, 0, ZERO, 100, self.now() + 86400, nonce)
        names = [field['name'] for field in EIP712['types']['ExitMandate']]
        signed = self.sign('owner', 'ExitMandate', self.contracts['autoExit'], dict(zip(names, mandate)))
        receipt = self.anvil.send(self.owner, self.contracts['autoExit'],
                                  calldata('registerMandate(' + MANDATE_TYPE + ',bytes)', [MANDATE_TYPE, 'bytes'],
                                           [mandate, signed]))
        registered, = self.events(receipt, self.contracts['autoExit'],
                                  'MandateRegistered(bytes32,address,address,uint256,uint64)')
        return receipt, registered['topics'][1]

    def exit(self, mandate_hash):
        execution = (self.observation(nonce=2), [], 0, 0)
        return self.anvil.send(self.operator, self.contracts['autoExit'],
                               calldata('execute(bytes32,' + EXECUTION_TYPE + ')', ['bytes32', EXECUTION_TYPE],
                                        [bytes.fromhex(mandate_hash[2:]), execution]))

    def owner_call(self, target, text):
        return self.anvil.send(self.owner, target, calldata(text))

    # ------------------------------------------------------------ indexing
    def indexer(self, store, **options):
        anvil = self.anvil
        return V2Indexer(store, CHAIN, local_endpoints(CHAIN, anvil.transport), lag_blocks=0, clock=self.now,
                         head=lambda: parse_block(anvil.block('latest')), **options)

    def follow(self, indexer, span=7):
        """Index to the head in small ranges (several checkpoints), enriching each time."""
        results = []
        for _ in range(500):
            result = indexer.step(span=span)
            results.append(result)
            if result['status'] == 'caught_up_to_target':
                return results
        raise AssertionError('the index did not reach the head')


@unittest.skipUnless(os.environ.get('DOMINO_TEST_EVM') == '1' and os.environ.get('DOMINO_TEST_POSTGRES') == '1',
                     'requires isolated local Anvil and PostgreSQL')
class IndexedJourneyTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.store = prepare_database()
        cls.j = j = Journey()
        cls.addClassCleanup(j.stop)
        cls.receipts = {}
        cls.receipts['create'], cls.token_id = j.s1_create()
        cls.receipts['vault'], cls.vault = j.create_vault(cls.token_id)
        cls.receipts['module'] = j.anvil.send(j.owner, cls.vault, calldata('setExitModule(address)', ['address'],
                                                                           [j.contracts['autoExit']]))
        cls.receipts['pause'] = j.owner_call(cls.vault, 'pause()')
        cls.receipts['resume'] = j.owner_call(cls.vault, 'resume()')
        j.swaps(6)
        j.advance(120)
        cls.receipts['compound'] = j.compound(cls.vault, cls.token_id)
        spot = j.spot()
        cls.receipts['register'], cls.exit_hash = j.mandate(cls.vault, cls.token_id, nonce=1,
                                                            above=spot - (spot >> 16))
        cls.receipts['register2'], cls.revoked_hash = j.mandate(cls.vault, cls.token_id, nonce=2, below=spot >> 1)
        cls.receipts['revoke'] = j.anvil.send(j.owner, j.contracts['autoExit'],
                                              calldata('revokeMandate(bytes32)', ['bytes32'],
                                                       [bytes.fromhex(cls.revoked_hash[2:])]))
        cls.receipts['pause2'] = j.owner_call(cls.vault, 'pause()')
        cls.receipts['exit'] = j.exit(cls.exit_hash)
        cls.indexer = j.indexer(cls.store)
        cls.registration = cls.indexer.register(j.deployment)
        cls.steps = j.follow(cls.indexer)
        # One more pass: what the last range enriched is complete, nothing is due.
        cls.last = cls.indexer.step()
        cls.service = V2ReadService(cls.store, clock=j.now)

    def rows(self, query, *args):
        with admin() as conn:
            return conn.execute(query, args).fetchall()

    def test_the_catalog_holds_every_event_the_compiled_contracts_declare(self):
        events = catalog()
        for kind, paths in ARTIFACTS.items():
            for path in paths:
                abi = json.loads((OUT / f'{path}.json').read_text())['abi']
                for entry in (e for e in abi if e['type'] == 'event'):
                    with self.subTest(contract=path, event=entry['name']):
                        self.assertEqual(events.event(kind, topic(signature(entry))).name, entry['name'])

    def test_registration_proves_the_deployment_and_indexing_reaches_the_head(self):
        self.assertEqual((self.registration['status'], self.registration['environment'],
                          self.registration['codesProven']), ('registered', 'local-test', 13))
        self.assertGreater(len(self.steps), 3)  # several checkpoints, not one range
        head = int(self.j.anvil.block()['number'], 16)
        self.assertEqual(self.rows('SELECT max(end_block) FROM domino_v2.checkpoints'), [(head,)])
        self.assertEqual(self.last['enrichment']['status'], 'done')

    def test_every_receipt_of_the_journey_is_indexed_with_its_event_counts(self):
        stored = {}
        for block, index, tx, event, address in self.rows(
                'SELECT block_number, log_index, tx_hash, event, address FROM domino_v2.logs ORDER BY 1, 2'):
            stored.setdefault(tx, []).append((index, event, address))
        domino = set(self.j.contracts.values()) | {self.vault}
        for name, receipt in self.receipts.items():
            expected = [(int(log['logIndex'], 16), log['address'].lower()) for log in receipt['logs']
                        if log['address'].lower() in domino]
            with self.subTest(action=name):
                self.assertEqual([(i, a) for i, _, a in stored.get(receipt['transactionHash'], [])], expected)

    def activity(self, wallet=None, limit=50):
        return self.service.activity(wallet or self.j.owner, limit)

    def test_the_owner_s_activity_tells_the_journey_newest_first(self):
        items = self.activity()['items']
        kinds = [(item['kind'], item.get('action') or item.get('event') or item.get('events', [{}])[0].get('event'))
                 for item in items]
        self.assertEqual(kinds, [
            ('auto_exit', None), ('vault_event', 'AutomationPaused'), ('auto_exit_event', 'MandateRevoked'),
            ('auto_exit_event', 'MandateRegistered'), ('auto_exit_event', 'MandateRegistered'),
            ('vault_execution', 'compound'), ('vault_event', 'AutomationResumed'), ('vault_event', 'AutomationPaused'),
            ('vault_event', 'ExitModuleSet'), ('vault_created', None), ('s1_action', 'create')])
        for item in items:
            self.assertEqual(item['tx']['gas']['status'], 'success')
            self.assertGreater(int(item['tx']['gas']['gasUsed']), 0)

    def test_the_s1_receipt_shows_the_steps_and_no_tariff_without_a_swap(self):
        create = self.activity()['items'][-1]
        self.assertEqual((create['action'], create['tokenId'], create['tariffs'], create['legs']),
                         ('create', str(self.token_id), [], []))
        self.assertEqual(create['tx']['gas']['sender'], self.j.owner)
        step, = create['steps']
        self.assertEqual(step['tokenId'], str(self.token_id))
        self.assertGreater(int(step['liquidityDelta']), 0)
        self.assertLess(int(step['amount0']), 0)  # paid into the pool

    def test_the_compound_shows_the_fees_collected_and_the_two_percent_tariff(self):
        compound = next(i for i in self.activity()['items'] if i['kind'] == 'vault_execution')
        receipt = self.receipts['compound']
        charged = self.j.events(receipt, self.vault, 'FeeCharged(uint8,address,address,uint256,bytes32)')
        self.assertEqual(len(compound['tariffs']), len(charged))
        self.assertTrue(all(t['kind'] == 'automation' and t['rateBps'] == 200 for t in compound['tariffs']))
        amounts = sorted(decode(['uint256', 'bytes32'], bytes.fromhex(log['data'][2:]))[0] for log in charged)
        self.assertEqual(sorted(int(t['amount']) for t in compound['tariffs']), amounts)
        self.assertEqual(compound['tx']['gas']['sender'], self.j.operator)
        self.assertGreater(int(compound['compounded']['liquidityAdded']), 0)

    def test_the_auto_exit_shows_the_delivery_and_the_twenty_bps_fee(self):
        exit_ = self.activity()['items'][0]
        executed, = self.j.events(self.receipts['exit'], self.j.contracts['autoExit'],
                                  'MandateExecuted(bytes32,uint160,address,uint256,uint256)')
        amount0, amount1 = decode(['uint160', 'uint256', 'uint256'], bytes.fromhex(executed['data'][2:]))[1:]
        self.assertEqual(exit_['mandateHash'], self.exit_hash)
        self.assertEqual(exit_['delivered'], [str(amount0), str(amount1)])
        self.assertTrue(exit_['tariffs'] and all(t['kind'] == 'auto_exit' and t['rateBps'] == 20
                                                 for t in exit_['tariffs']))

    def test_the_portfolio_shows_the_paused_exited_vault_and_its_mandates(self):
        body = self.service.portfolio(self.j.owner)
        vault, = body['vaults']
        self.assertEqual((vault['address'], vault['dex'], vault['rootTokenId']), (self.vault, 4, str(self.token_id)))
        self.assertEqual(vault['state']['status'], 'read')
        # Paused by its owner, the root exited by auto-exit: neither is an error.
        self.assertEqual((vault['state']['paused'], vault['pausedBy']), (True, 'owner'))
        self.assertEqual((vault['state']['rootArmed'], vault['state']['exitModule']),
                         (False, self.j.contracts['autoExit']))
        self.assertEqual(vault['members'][0]['status'], 'exited')
        self.assertTrue(vault['autoExitEnabled'])
        self.assertEqual((vault['totals']['executions'], vault['totals']['compounds']), (1, 1))
        position = next(p for p in body['positions'] if p['tokenId'] == str(self.token_id))
        # Changed on purpose 2026-11-02: its auto-exit closed the root, so the vault let it go (read-v6's `vault` is
        # the vault a position belongs to now); the vault stays listed above, with its history.
        self.assertIsNone(position['vault'])
        self.assertEqual((position['state']['status'], position['state']['liquidity']), ('live', '0'))
        mandates = {m['mandateHash']: m for m in body['mandates']}
        self.assertEqual(mandates[self.exit_hash]['status'], 'executed')
        self.assertEqual(mandates[self.revoked_hash]['status'], 'revoked')
        self.assertEqual(mandates[self.exit_hash]['terms']['receive'], 'both')
        self.assertIsNotNone(mandates[self.exit_hash]['terms']['triggerAboveSqrtPriceX96'])
        tokens = {t['address']: t for t in body['tokens']}
        # SetupToken has no decimals() or symbol(): unavailable, never guessed.
        self.assertEqual((tokens[self.j.c0]['decimals'], tokens[self.j.c0]['symbol']), (None, None))

    def test_the_automation_s_waiting_reasons_are_shown_beside_the_index(self):
        # The file as the automation writes it after a pass (V2_AUTOMATION_BACKEND.md).
        directory = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, directory)
        path, now = directory / 'waiting-8453.json', self.j.now()
        head = int(self.j.anvil.block()['number'], 16)
        path.write_text(json.dumps({
            'schemaVersion': 1, 'kind': 'domino-v2-automation-waiting', 'chainId': 8453, 'block': head,
            'timestamp': now, 'vaults': {self.vault: {
                'reason': 'vault_paused', 'since': now - 120, 'sinceBlock': head - 6, 'at': now, 'block': head,
                'lastRevert': {'code': 'reverted_automation_unavailable', 'at': now - 60, 'block': head - 3}}},
            'mandates': {self.exit_hash: {'reason': 'triggered', 'since': now - 100, 'sinceBlock': head - 5,
                                          'at': now - 100, 'block': head - 5, 'lastRevert': None}}}, sort_keys=True))
        self.addCleanup(self.forget_waiting)
        # The chain's indexer reads it into the index; the read API serves it from there.
        self.assertEqual(self.j.indexer(self.store, waiting_file=str(path)).step()['waiting'],
                         {'status': 'read', 'block': head, 'subjects': 2})
        body = V2ReadService(self.store, clock=self.j.now).portfolio(self.j.owner)
        reports = {c['chainId']: c['waitingReasons']['status'] for c in body['chains']}
        self.assertEqual(reports, {chain: 'reporting' if chain == 8453 else 'not_configured' for chain in CHAIN_IDS})
        vault, = body['vaults']
        self.assertEqual((vault['waiting']['reason'], vault['waiting']['error'], vault['waiting']['since'],
                          vault['waiting']['sinceBlock'], vault['waiting']['checkedBlock']),
                         ('vault_paused', None, now - 120, head - 6, head))
        self.assertEqual(vault['waiting']['lastRevert'], {'reason': 'reverted_automation_unavailable',
                                                          'error': 'AutomationUnavailable', 'at': now - 60,
                                                          'block': head - 3})
        # An ended mandate keeps the automation's last row; its status already says why it does not run.
        self.assertTrue(all(m['waiting'] is None for m in body['mandates']))

    @staticmethod
    def forget_waiting():
        with admin() as conn:
            conn.execute('DELETE FROM domino_v2.waiting_reports')
            conn.execute('DELETE FROM domino_v2.waiting')

    def test_another_wallet_sees_nothing_of_it(self):
        body = self.service.portfolio('0x' + '99' * 20)
        self.assertEqual((body['vaults'], body['positions'], body['mandates']), ([], [], []))
        self.assertEqual(self.activity('0x' + '99' * 20)['items'], [])

    def test_a_page_continues_where_the_last_ended(self):
        first = self.activity(limit=4)
        second = self.service.activity(self.j.owner, 50, first['nextCursor'])
        self.assertEqual([i['id'] for i in first['items'] + second['items']],
                         [i['id'] for i in self.activity()['items']])


@unittest.skipUnless(os.environ.get('DOMINO_TEST_EVM') == '1' and os.environ.get('DOMINO_TEST_POSTGRES') == '1',
                     'requires isolated local Anvil and PostgreSQL')
class RegistryGovernanceTests(unittest.TestCase):
    """The registry's timelocked changes and the guardian's narrowing actions,
    as the chain status shows them: the halt and the operators admitted."""
    def test_changes_removals_the_epoch_and_the_halt_are_indexed_and_shown(self):
        store, j = prepare_database(), Journey()
        self.addCleanup(j.stop)
        registry, anvil = j.contracts['registry'], j.anvil
        governance, guardian = anvil.roles['governance'], anvil.roles['guardian']
        kind = keccak(b'domino.registry.operator')
        added, other = '0x' + '7e' * 20, '0x' + '7f' * 20

        def schedule(operator):
            receipt = anvil.send(governance, registry, calldata('scheduleChange(bytes32,bytes)', ['bytes32', 'bytes'],
                                                                [kind, encode(['address', 'bool'], [operator, True])]))
            return bytes.fromhex(receipt['logs'][0]['topics'][1][2:])
        change, cancelled = schedule(added), schedule(other)
        anvil.send(guardian, registry, calldata('cancelChange(bytes32)', ['bytes32'], [cancelled]))
        j.advance(86_401)
        anvil.send(governance, registry, calldata('executeChange(bytes32)', ['bytes32'], [change]))
        anvil.send(guardian, registry, calldata('removeOperator(address)', ['address'], [j.operator]))
        anvil.send(guardian, registry, calldata('raiseObservationEpoch(uint64)', ['uint64'], [j.now()]))
        anvil.send(guardian, registry, calldata('haltAutomation()'))
        indexer = j.indexer(store)
        indexer.register(j.deployment)
        j.follow(indexer)
        with admin() as conn:
            events = [row[0] for row in conn.execute(
                "SELECT event FROM domino_v2.logs WHERE emitter = 'registry' AND block_number > %s "
                'ORDER BY block_number, log_index', (j.deployment.start_block('registry'),))]
        self.assertEqual(events, ['ChangeScheduled', 'ChangeScheduled', 'ChangeCancelled', 'OperatorSet',
                                  'ChangeExecuted', 'OperatorSet', 'ObservationEpochRaised', 'AutomationHaltSet'])
        base = next(c for c in V2ReadService(store, clock=j.now).portfolio(j.owner)['chains'] if c['chainId'] == 8453)
        self.assertEqual((base['status'], base['automationHalted'], base['operatorsAdmitted']), ('current', True, 1))


@unittest.skipUnless(os.environ.get('DOMINO_TEST_EVM') == '1' and os.environ.get('DOMINO_TEST_POSTGRES') == '1',
                     'requires isolated local Anvil and PostgreSQL')
class PositionBurnTests(unittest.TestCase):
    def test_a_burned_position_is_proven_by_the_manager_and_no_longer_listed(self):
        store, j = prepare_database(), Journey()
        self.addCleanup(j.stop)
        indexer = j.indexer(store)
        indexer.register(j.deployment)
        _, token_id = j.s1_create()
        j.follow(indexer)
        service = V2ReadService(store, clock=j.now)
        position, = service.portfolio(j.owner)['positions']
        self.assertEqual((position['tokenId'], position['state']['status']), (str(token_id), 'live'))
        # A few quiet blocks, then the exit: the proof is read from the exit's block on.
        for _ in range(3):
            j.anvil.request('evm_mine', [])
        receipt = j.s1_exit(token_id)
        manager = CHAIN.uniswap.v4.positionManager
        burn = [log for log in receipt['logs'] if log['address'].lower() == manager
                and log['topics'][0] == topic('Transfer(address,address,uint256)') and int(log['topics'][2], 16) == 0]
        self.assertEqual(len(burn), 1)
        j.follow(indexer)
        with admin() as conn:
            status = conn.execute('SELECT status FROM domino_v2.position_snapshots WHERE token_id = %s',
                                  (token_id,)).fetchall()
        self.assertEqual(status, [('burned',)])
        self.assertEqual(service.portfolio(j.owner)['positions'], [])
        exit_ = service.activity(j.owner, 50)['items'][0]
        self.assertEqual((exit_['kind'], exit_['action'], exit_['previousTokenId']), ('s1_action', 'exit', str(token_id)))
        self.assertLess(int(exit_['steps'][0]['liquidityDelta']), 0)

    def test_a_burn_further_back_than_one_read_admits_leaves_the_position_unavailable_and_the_pass_going(self):
        from v2_rpc import ChainEndpoints, Endpoint
        store, j = prepare_database(), Journey()
        self.addCleanup(j.stop)
        # An endpoint that serves one block per getLogs window: 1,000 windows at most per read.
        endpoint = Endpoint('local', 'chain.invalid', 'https://chain.invalid/', None, 100, 1, None)
        indexer = V2Indexer(store, CHAIN, ChainEndpoints(CHAIN, (endpoint,), 'test', send=j.anvil.transport),
                            lag_blocks=0, clock=j.now, head=lambda: parse_block(j.anvil.block('latest')))
        indexer.register(j.deployment)
        _, token_id = j.s1_create()
        j.s1_exit(token_id)
        j.anvil.request('anvil_mine', [hex(1_100)])
        while indexer.step(span=200, enrich=False)['status'] != 'caught_up_to_target':
            pass
        result = indexer.step()
        self.assertEqual(result['enrichment']['status'], 'done')
        self.assertEqual(result['enrichment']['positions'], 1)
        with admin() as conn:
            row = conn.execute('SELECT status, reason FROM domino_v2.position_snapshots WHERE token_id = %s',
                               (token_id,)).fetchall()
        self.assertEqual(row, [('unavailable', 'v2_burn_unproven')])
        self.assertGreater(result['enrichment']['tokens'], 0)  # the pass went on past it


@unittest.skipUnless(os.environ.get('DOMINO_TEST_EVM') == '1' and os.environ.get('DOMINO_TEST_POSTGRES') == '1',
                     'requires isolated local Anvil and PostgreSQL')
class ReorganizationTests(unittest.TestCase):
    """Anvil's evm_revert takes blocks the index holds off the chain: the index
    rewinds to the last checkpoint still on it and follows the new branch."""
    def setUp(self):
        self.store = prepare_database()
        self.j = Journey()
        self.addCleanup(self.j.stop)
        self.indexer = self.j.indexer(self.store)
        self.indexer.register(self.j.deployment)

    def items(self):
        return [(i['kind'], i['tokenId']) for i in V2ReadService(self.store, clock=self.j.now)
                .activity(self.j.owner, 50)['items']]

    def positions(self):
        with admin() as conn:
            return [int(r[0]) for r in conn.execute('SELECT token_id FROM domino_v2.positions ORDER BY 1')]

    def test_a_branch_replaced_by_another_is_unindexed_and_the_new_one_followed(self):
        _, first = self.j.s1_create()
        self.j.follow(self.indexer)
        snapshot = self.j.anvil.request('evm_snapshot', [])
        _, second = self.j.s1_create(-1200, 1200, init=False)
        self.j.anvil.request('evm_mine', [])
        self.j.follow(self.indexer)
        self.assertEqual(self.items(), [('s1_action', str(second)), ('s1_action', str(first))])
        self.assertEqual(self.positions(), [first, second])
        self.assertTrue(self.j.anvil.request('evm_revert', [snapshot]))
        # The other branch: another position, and more blocks than the first had.
        _, other = self.j.s1_create(-3000, 3000, init=False)
        for _ in range(4):
            self.j.anvil.request('evm_mine', [])
        results = self.j.follow(self.indexer)
        self.assertEqual(results[0]['status'], 'rewound')
        self.assertEqual(self.items(), [('s1_action', str(other)), ('s1_action', str(first))])
        # The same token id now names the new branch's position, read again.
        self.assertEqual(other, second)
        with admin() as conn:
            ticks = conn.execute("SELECT state->>'tickLower', state->>'tickUpper' FROM domino_v2.position_snapshots "
                                 'WHERE token_id = %s', (other,)).fetchall()
        self.assertEqual(ticks, [('-3000', '3000')])

    def test_a_shorter_branch_rewinds_the_index_below_the_old_head(self):
        _, first = self.j.s1_create()
        self.j.follow(self.indexer)
        snapshot = self.j.anvil.request('evm_snapshot', [])
        self.j.s1_create(-1200, 1200, init=False)
        self.j.follow(self.indexer)
        self.assertTrue(self.j.anvil.request('evm_revert', [snapshot]))
        result = self.indexer.step()
        self.assertEqual(result['status'], 'rewound')
        self.j.follow(self.indexer)
        self.assertEqual(self.items(), [('s1_action', str(first))])
        self.assertEqual(self.positions(), [first])


if __name__ == '__main__':
    unittest.main()
