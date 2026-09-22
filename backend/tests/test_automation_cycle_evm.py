"""The automation cycle on a disposable chain and database.

observe -> decide -> reserve -> publish (a real transaction from the publisher
key) -> inclusion -> qualify/sign/send through the durable executor -> receipt
-> reconciliation, with restarts at the transitions, two workers, a lost
broadcast reply, a lost source window, a revoked anchor, a moved price, an
unfunded signer, pauses and a reorg. Synthetic keys, fixture feeds and a mock
node interface: this proves the integration, not a production deployment.
"""
import os
from pathlib import Path
import sys
import time
import unittest
import uuid

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))
from eth_account import Account

import execution_models as m
import test_execution_v4_receipts_evm as evm
from automation_config import validate_config
from automation_cycle import SequenceCycle
from automation_evidence import simulate_exact_input
from automation_fixtures import deep_update, sample_config
from automation_observer import ChainReader, derive_admission, pool_state
from evm_harness import calldata, KEY_TYPE, LIMITS_TYPE, POLICY_TYPE
from execution_pg import ExecutionPostgres
from execution_runner import ExecutionJournal
from execution_store import ExecutionStoreError, _model
from execution_v4_adapter import decode_plan

OPERATOR_KEY = bytes([66]) * 32   # published synthetic local test keys; never funded remotely
PUBLISHER_KEY = bytes([77]) * 32
NODE_INTERFACE = '0x' + '00' * 19 + 'c8'
OBSERVATION_TYPES = ['bytes32', 'uint64', 'bytes32', 'uint64', 'uint64', 'uint160']


@unittest.skipUnless(os.environ.get('DOMINO_TEST_POSTGRES') == '1' and os.environ.get('DOMINO_TEST_EVM') == '1', 'isolated PG and EVM required')
class AutomationCycleEvmTests(unittest.TestCase):
    send = evm.ExecutionV4ReceiptEvmTests.send
    deploy = evm.ExecutionV4ReceiptEvmTests.deploy
    call = evm.ExecutionV4ReceiptEvmTests.call
    setup_vault = evm.ExecutionV4ReceiptEvmTests.setup_vault
    stop = classmethod(evm.ExecutionV4ReceiptEvmTests.stop.__func__)

    @classmethod
    def setUpClass(cls):
        evm.ExecutionV4ReceiptEvmTests.setUpClass.__func__(cls)
        cls.base_snapshot = cls.rpc.request('evm_snapshot', [])
        cls.pg = ExecutionPostgres().start()
        cls.addClassCleanup(cls.pg.close)
        with cls.pg.admin() as conn:
            for name in ('019_execution_journal', '028_automation_cycle', '029_ledger_index'):
                conn.execute((Path(__file__).resolve().parents[1] / f'migrations/{name}.sql').read_text())
            for role in ('domino_execution_signer', 'domino_execution_publisher'):
                conn.execute(f'ALTER ROLE {role} LOGIN')

    def setUp(self):
        with self.pg.admin() as conn:
            conn.execute('TRUNCATE domino_execution.intents,domino_execution.origins,domino_execution.signer_heads,domino_execution.publications,'
                         'domino_execution.publisher_heads,domino_execution.cycles,domino_execution.sequence_state,domino_execution.pool_samples,'
                         'domino_execution.controls,domino_execution.withdrawals,domino_execution.withdrawal_debits,domino_execution.ledger_exceptions,'
                         'domino_execution.ledger_cursors CASCADE')
        self.rpc.request('evm_revert', [self.base_snapshot])
        type(self).base_snapshot = self.rpc.request('evm_snapshot', [])
        self.rpc.request('evm_setAutomine', [True])
        self.operator = Account.from_key(OPERATOR_KEY).address.lower()
        self.publisher = Account.from_key(PUBLISHER_KEY).address.lower()

    # ------------------------------------------------------------ fixture
    def setup(self, **changes):
        self.setup_vault()
        for account in (self.operator, self.publisher):
            self.rpc.request('anvil_setBalance', [account, hex(10**20)])
        self.send(self.vault, calldata('setOperator(address)', ['address'], [self.operator]))
        self.send(self.vault, calldata('setExecutionLimits(' + LIMITS_TYPE + ')', [LIMITS_TYPE], [(2, 5000, 100, 100, 10**18, 120, 3600)]))
        # The fixture's root range is +-6% and its trigger distance 10%, so the
        # spot always counts as near the ceiling and every route is a successor.
        # A 1% trigger keeps the owner's Domino policy while routing fresh fees
        # to the root, the path this suite drives end to end.
        self.send(self.vault, calldata('setPolicy(' + POLICY_TYPE + ')', [POLICY_TYPE], [(400, 100, 1000, 1, 4, 2, False)]))
        # The guard's publisher becomes the synthetic key, through the guardian's two-key handshake.
        guard = self.admission.priceGuard
        guardian = self.rpc.request('eth_accounts', [])[3]
        self.guardian = guardian
        self.mined(self.rpc.request('eth_sendTransaction', [{'from': guardian, 'to': guard, 'gas': hex(200000), 'data': calldata('proposePublisher(address)', ['address'], [self.publisher])}]))
        self.rpc.request('anvil_impersonateAccount', [self.publisher])
        try:
            self.mined(self.rpc.request('eth_sendTransaction', [{'from': self.publisher, 'to': guard, 'gas': hex(200000), 'data': calldata('acceptPublisher()')}]))
        finally:
            self.rpc.request('anvil_stopImpersonatingAccount', [self.publisher])
        self.assertEqual(self.call(guard, 'publisher()', ['address'])[0], self.publisher)
        self.admission = self.admission.model_copy(update={'pricePublisher': self.publisher})
        # Competing liquidity: a second fixture position that is not part of the sequence.
        competitor = self.deploy('OfficialV4Fixture.sol', 'OfficialV4Controller', ['address', 'address'], [self.manager, self.positions])
        for currency in self.key[:2]:
            self.send(currency, calldata('mint(address,uint256)', ['address', 'uint256'], [competitor, 10**20]))
        self.send(competitor, calldata('seed(' + KEY_TYPE + ',uint128)', [KEY_TYPE, 'uint128'], [self.key, 9 * 10**18]))
        self.send(competitor, calldata('refundSetup()'))
        self.feeds = {c: self.deploy('OfficialV4Fixture.sol', 'OfficialFixtureFeed', ['uint8', 'string', 'int256'], [8, 'FIXTURE / USD', 10**8])
                      for c in (self.key[0], self.key[1], m.ZERO)}
        node = self.deploy('OfficialV4Fixture.sol', 'OfficialFixtureNodeInterface')
        self.rpc.request('anvil_setCode', [NODE_INTERFACE, self.rpc.request('eth_getCode', [node, 'latest'])])
        self.rpc.request('anvil_setNextBlockBaseFeePerGas', [hex(1)])
        pins = {p.address: p.codeHash for p in self.admission.runtimePins}
        seq = self.admission.sequence
        deployment = {'poolManager': self.manager, 'positionManager': self.positions, 'stateView': self.state, 'factory': seq.factory,
                      'readHelper': self.admission.readHelper, 'routing': self.admission.routingHelper, 'priceGuard': guard,
                      'engine': self.admission.executionEngine, 'implementation': seq.implementation, 'serviceFeeRecipient': self.recipient,
                      'operator': self.operator, 'pricePublisher': self.publisher, 'serviceFeeBps': 200, 'dominoServiceFeeBps': 400,
                      'expiresAt': int(time.time()) + 86400,
                      'codeHashes': {'poolManager': pins[self.manager], 'positionManager': pins[self.positions], 'stateView': pins[self.state],
                                     'factory': pins[seq.factory], 'readHelper': pins[self.admission.readHelper], 'routing': pins[self.admission.routingHelper],
                                     'priceGuard': pins[guard], 'engine': pins[self.admission.executionEngine], 'implementation': pins[seq.implementation],
                                     'vault': pins[self.vault]}}
        defaults = {'database': dict(self.pg.settings), 'deployment': deployment,
                    'sequences': [{'owner': self.owner, 'vault': self.vault, 'expiresAt': int(time.time()) + 86400, 'suspended': False}],
                    'gas': {'l1DataComponent': 'node_interface', 'priorityFeePerGasWei': 1},
                    'planner': {'minimumSamples': 3, 'minimumSampleSeconds': 2, 'maximumMeasurementSeconds': 60, 'maximumSampleAgeSeconds': 120},
                    'scheduling': {'executionWaitSeconds': 2, 'publicationWaitSeconds': 10, 'evaluationIntervalSeconds': 1,
                                   'minimumBackoffSeconds': 1, 'maximumBackoffSeconds': 4}}
        raw = sample_config(currencies=(self.key[0], self.key[1]), feeds=self.feeds, **deep_update(defaults, changes))
        self.config = validate_config(raw)
        self.entry = self.config.sequences[0]
        self.cycle = self.worker()
        self.store, self.journal, self.ledger = self.cycle.store, self.cycle.journal, self.cycle.ledger
        # A reverted chain keeps an older clock than the host. Observations bind
        # to the block before the head, so two wall-clock blocks bring the two
        # together before the first sample; the sampled intervals are then the
        # ones the scenario intends rather than the drift between tests.
        self.advance(1)
        self.advance(1)

    def mined(self, tx):
        for _ in range(200):
            receipt = self.rpc.request('eth_getTransactionReceipt', [tx])
            if receipt is not None:
                self.assertEqual(receipt['status'], '0x1', tx)
                return receipt
            time.sleep(0.01)
        self.fail('local transaction was not mined')

    def worker(self, worker_id=None):
        return SequenceCycle(self.config, rpc=self.rpc, worker_id=worker_id, operator_key=OPERATOR_KEY, publisher_key=PUBLISHER_KEY)

    def advance(self, seconds):
        head = self.rpc.request('eth_getBlockByNumber', ['latest', False])
        target = max(int(head['timestamp'], 16) + seconds, int(time.time()))
        while time.time() < target:
            time.sleep(min(0.05, max(0.001, target - time.time())))
        self.rpc.request('evm_setNextBlockTimestamp', [target])
        self.rpc.request('evm_mine', [])

    def trade(self, amount=10**17, directions=(True, False)):
        for direction in directions:
            self.send(self.trader, calldata('swap(' + KEY_TYPE + ',bool,uint256)', [KEY_TYPE, 'bool', 'uint256'], [self.key, direction, amount]))
        # Observations bind to the block before the head: close the round with
        # an empty block so the observed price is the settled one, not the
        # price between two opposite swaps.
        self.rpc.request('evm_mine', [])

    def warm_up(self, rounds=3, **trade):
        outcomes = []
        for _ in range(rounds):
            self.advance(2)
            self.trade(**trade)
            outcomes.append(self.cycle.run(self.entry, act=False))
        return outcomes

    def finalize(self):
        """Finality for the executor, with the pool trading meanwhile as a real
        pool would: the planner rates the window by its least active interval."""
        self.rpc.request('anvil_mine', ['0x40', '0x0'])
        self.advance(2)
        self.trade()

    def counts(self):
        with self.pg.admin() as conn:
            return {table: conn.execute(f'SELECT count(*) FROM domino_execution.{table}').fetchone()[0]
                    for table in ('intents', 'journal', 'attempts', 'effects', 'publications', 'cycles', 'nonce_claims')}

    def sequence_hash(self):
        reader = ChainReader(self.rpc)
        return derive_admission(reader, self.config.deployment, self.owner, self.vault, reader.head()).sequence.digest()

    # -------------------------------------------------------------- tests
    def test_waits_without_history_then_completes_and_reconciles_exactly_once(self):
        self.setup()
        first = self.cycle.run(self.entry)
        self.assertEqual(first['outcome'], 'wait', first)
        self.assertIn('insufficient_qualified_fee_history', first['decision']['reasons'])
        self.assertEqual((self.counts()['publications'], self.counts()['intents']), (0, 0))
        self.warm_up()
        self.advance(2)
        self.trade()
        acted = self.cycle.run(self.entry)
        self.assertEqual(acted['outcome'], 'executing', acted)
        counts = self.counts()
        self.assertEqual((counts['publications'], counts['intents'], counts['attempts'], counts['nonce_claims']), (1, 1, 1, 1))
        publication = self.journal.status(acted['observationId'])
        self.assertIn(publication['state'], ('included', 'confirmed'))
        self.assertEqual(publication['signer'], self.publisher)
        intent = self.ledger.get(self.owner, acted['intentId'])
        self.assertEqual(self.ledger.price_observation(self.owner, acted['intentId']), acted['observationId'])
        stored = self.call(self.admission.priceGuard, 'observations(bytes32)', OBSERVATION_TYPES, ['bytes32'], [bytes.fromhex(acted['observationId'][2:])])
        self.assertEqual((stored[1], '0x' + stored[2].hex(), stored[5]), (int(intent['plan']['sourceBlockNumber']), intent['plan']['sourceBlockHash'], int(intent['observation']['sqrtPriceX96'])))
        # A pass before finality resumes the same cycle and adds no work.
        again = self.cycle.run(self.entry)
        self.assertEqual((again['cycleId'], again['outcome']), (acted['cycleId'], 'executing'))
        self.assertEqual(self.counts()['publications'], 1)
        self.finalize()
        done = self.cycle.run(self.entry)
        self.assertEqual(done['outcome'], 'completed', done)
        self.assertEqual(self.counts()['effects'], 1)
        cycle = self.store.cycle(self.owner, done['cycleId'])
        self.assertEqual(cycle['state'], 'completed')
        self.assertGreater(int(cycle['cost']['execution']['gasUsedRaw']), 0)
        self.assertGreater(int(cycle['cost']['publication']['gasUsedRaw']), 0)
        receipt = ExecutionJournal(self.pg.settings).status(self.owner, acted['intentId'])['receipt']
        state = self.store.sequence(self.owner, cycle['sequenceHash'])
        self.assertEqual(state['waitingSince'], receipt['block']['timestamp'])
        # The pool kept trading while finality was awaited, so the next pass
        # may already find enough new fees for a second cycle; if it waits, more
        # rounds make it eligible. Either way the second cycle spends ledger
        # lots plus fresh accruals, with the ledger and the vault agreeing.
        second = self.cycle.run(self.entry)
        if second['outcome'] == 'wait':
            self.assertEqual(self.counts()['publications'], 1)
            self.warm_up(2)
            self.advance(2)
            self.trade()
            second = self.cycle.run(self.entry)
        self.assertEqual(second['outcome'], 'executing', second)
        self.assertNotEqual(second['cycleId'], done['cycleId'])
        lots = self.store.available_lots(self.owner, cycle['sequenceHash'])
        self.assertTrue(any(int(row['remaining']) > 0 for row in lots))
        self.assertEqual(second['decision']['observationDiagnostics'], [])
        self.finalize()
        self.assertEqual(self.cycle.run(self.entry)['outcome'], 'completed')
        self.assertEqual((self.counts()['effects'], self.counts()['publications']), (2, 2))

    def test_restarts_between_transitions_never_duplicate_publication_or_signature(self):
        self.setup()
        self.warm_up()
        self.advance(2)
        self.trade()
        original = self.journal.send
        def crash(*args, **kwargs):
            raise RuntimeError('synthetic_crash_after_persisting_signed_publication')
        self.journal.send = crash
        with self.assertRaisesRegex(RuntimeError, 'synthetic_crash'):
            self.cycle.run(self.entry)
        self.journal.send = original
        counts = self.counts()
        self.assertEqual((counts['publications'], counts['intents'], counts['attempts']), (1, 1, 0))
        self.assertEqual(self.journal.live(self.publisher)[0]['state'], 'signed')
        open_cycle = self.store.open_cycle(self.owner, self.sequence_hash())
        self.assertEqual(open_cycle['state'], 'publishing')
        # The restarted service keeps its worker identity, so it resumes its own
        # leases at once, sends the persisted bytes and continues the same cycle.
        restarted = self.worker(self.cycle.worker)
        self.assertIn(restarted.recover_publications()[0]['state'], ('included', 'confirmed'))
        resumed = restarted.run(self.entry)
        self.assertEqual((resumed['cycleId'], resumed['outcome']), (open_cycle['cycleId'], 'executing'))
        counts = self.counts()
        self.assertEqual((counts['publications'], counts['attempts'], counts['nonce_claims']), (1, 1, 1))
        # Crash after the execution was submitted: another restart completes it with the same attempt.
        self.finalize()
        done = self.worker(self.cycle.worker).run(self.entry)
        self.assertEqual((done['cycleId'], done['outcome']), (open_cycle['cycleId'], 'completed'))
        counts = self.counts()
        self.assertEqual((counts['publications'], counts['attempts'], counts['effects']), (1, 1, 1))
        with self.pg.admin() as conn:
            # One publication for the whole episode: the journal's head is the chain's next nonce.
            self.assertEqual(int(conn.execute('SELECT next_nonce FROM domino_execution.publisher_heads').fetchone()[0]),
                             int(self.rpc.request('eth_getTransactionCount', [self.publisher, 'latest']), 16))

    def test_lost_broadcast_reply_recovers_the_same_publication(self):
        self.setup()
        self.warm_up()
        self.advance(2)
        self.trade()
        request = self.rpc.request
        lost = []
        def flaky(method, params):
            result = request(method, params)
            if method == 'eth_sendRawTransaction' and not lost:
                lost.append(params[0])
                raise TimeoutError('synthetic reply lost')
            return result
        self.rpc.request = flaky
        try:
            acted = self.cycle.run(self.entry)
        finally:
            self.rpc.request = request
        self.assertEqual(acted['outcome'], 'executing', acted)
        self.assertEqual(len(lost), 1)
        self.assertEqual(self.counts()['publications'], 1)
        self.assertIn(self.journal.status(acted['observationId'])['state'], ('included', 'confirmed'))

    def test_contention_pause_and_funding_refuse_before_any_transaction(self):
        self.setup()
        self.warm_up()
        self.advance(2)
        self.trade()
        seq_hash = self.sequence_hash()
        other = str(uuid.uuid4())
        lease = self.store.acquire_sequence(self.owner, seq_hash, other, lease_seconds=30)
        with self.assertRaisesRegex(ExecutionStoreError, 'execution_lease_busy'):
            self.cycle.run(self.entry)
        self.store.update_sequence(self.owner, seq_hash, other, lease['fence'], release=True)
        self.store.set_control(self.owner, 'paused', True)
        self.assertEqual(self.cycle.run(self.entry)['outcome'], 'skipped')
        self.store.set_control(self.owner, 'paused', False)
        self.rpc.request('anvil_setBalance', [self.publisher, hex(0)])
        refused = self.cycle.run(self.entry)
        self.assertEqual((refused['outcome'], refused['reason']), ('refused', 'funding_required_publisher'))
        self.rpc.request('anvil_setBalance', [self.publisher, hex(10**20)])
        self.assertEqual((self.counts()['publications'], self.counts()['intents']), (0, 0))
        self.send(self.vault, calldata('pause()'))
        self.advance(1)  # observations bind to the newest closed block, so the pause needs one more
        paused = self.cycle.run(self.entry)
        self.assertEqual(paused['outcome'], 'wait', paused)
        self.assertIn('paused', paused['decision']['reasons'])
        self.assertEqual((self.counts()['publications'], self.counts()['intents']), (0, 0))
        status = self.cycle.status(self.entry)
        self.assertFalse(status['executionAvailable'])
        self.assertEqual(status['balances']['publisherWei'], str(10**20))

    def test_lost_window_revoked_anchor_and_moved_price_stop_before_signing(self):
        self.setup(scheduling={'maxSourceBlockAge': 20})
        self.warm_up()
        self.advance(2)
        self.trade()
        prepare = self.journal.prepare
        def late(*args, **kwargs):
            self.rpc.request('anvil_mine', ['0x20', '0x0'])
            return prepare(*args, **kwargs)
        self.journal.prepare = late
        try:
            lost = self.cycle.run(self.entry)
        finally:
            self.journal.prepare = prepare
        self.assertEqual(lost['outcome'], 'abandoned', lost)
        self.assertEqual(lost['reason'], 'publish_publisher_source_window')
        self.assertTrue(lost['reservationReleased'])
        self.assertEqual(self.ledger.get(self.owner, lost['intentId'])['state'], 'cancelled')
        self.assertEqual(self.counts()['publications'], 0)
        # Revoked after publication: the executor refuses before the key is used.
        signer = self.cycle._signer
        def revoking(admission, anchor):
            self.rpc.request('eth_sendTransaction', [{'from': self.guardian, 'to': self.admission.priceGuard, 'gas': hex(200000),
                                                      'data': calldata('revoke(bytes32)', ['bytes32'], [bytes.fromhex(anchor[2:])])}])
            return signer(admission, anchor)
        self.advance(2)
        self.trade()
        self.cycle._signer = revoking
        try:
            revoked = self.cycle.run(self.entry)
        finally:
            self.cycle._signer = signer
        self.assertEqual(revoked['outcome'], 'abandoned', revoked)
        self.assertEqual(revoked['reason'], 'anchor_revoked')
        self.assertEqual((self.counts()['publications'], self.counts()['journal'], self.counts()['attempts']), (1, 0, 0))
        self.assertEqual(self.ledger.get(self.owner, revoked['intentId'])['state'], 'cancelled')
        # The price leaves the plan's band between publication and signing: same refusal, nothing signed.
        def moving(admission, anchor):
            self.trade(amount=5 * 10**17, directions=(True,))
            return signer(admission, anchor)
        self.advance(2)
        self.trade()
        self.cycle._signer = moving
        try:
            moved = self.cycle.run(self.entry)
        finally:
            self.cycle._signer = signer
        self.assertEqual(moved['outcome'], 'abandoned', moved)
        self.assertEqual(moved['reason'], 'price_outside_plan_band')
        self.assertEqual((self.counts()['publications'], self.counts()['journal'], self.counts()['attempts']), (2, 0, 0))

    def test_reorg_after_a_completed_cycle_is_recorded_and_suspends_the_sequence(self):
        self.setup()
        self.warm_up()
        self.advance(2)
        self.trade()
        snapshot = self.rpc.request('evm_snapshot', [])
        self.assertEqual(self.cycle.run(self.entry)['outcome'], 'executing')
        self.finalize()
        self.assertEqual(self.cycle.run(self.entry)['outcome'], 'completed')
        self.assertTrue(self.rpc.request('evm_revert', [snapshot]))
        self.advance(2)
        blocked = self.cycle.run(self.entry)
        self.assertEqual((blocked['outcome'], blocked['reason']), ('suspended', 'execution_reorged'), blocked)
        self.assertIn('ledger_chain_mismatch', blocked['decision']['observationDiagnostics'])
        self.assertEqual(self.counts()['publications'], 1)
        self.assertEqual(self.cycle.run(self.entry)['outcome'], 'skipped')
        with self.pg.admin() as conn:
            self.assertEqual(conn.execute("SELECT count(*) FROM domino_execution.journal WHERE state='reorged'").fetchone()[0], 1)
            self.assertEqual(conn.execute('SELECT count(*) FROM domino_execution.effects WHERE canonical').fetchone()[0], 0)

    def test_owner_withdrawal_is_read_into_the_ledger_after_finality_and_the_cycle_continues(self):
        self.setup()
        self.warm_up()
        self.advance(2)
        self.trade()
        acted = self.cycle.run(self.entry)
        self.assertEqual(acted['outcome'], 'executing', acted)
        self.finalize()
        done = self.cycle.run(self.entry)
        self.assertEqual(done['outcome'], 'completed', done)
        seq_hash = self.store.cycle(self.owner, done['cycleId'])['sequenceHash']
        executed = ExecutionJournal(self.pg.settings).status(self.owner, acted['intentId'])['receipt']['transactionHash']
        # The pass after reconciliation reads our own execution's fee events and
        # verifies them against the journal; nothing is recorded twice.
        self.advance(2)
        after = self.cycle.run(self.entry, act=False)
        self.assertEqual((after['ledger']['verified'], after['ledger']['exceptions'], after['ledger']['withdrawals']), ([executed], [], []))
        self.assertGreaterEqual(after['ledger']['cursor'], int(self.rpc.request('eth_getBlockByNumber', ['finalized', False])['number'], 16) - 1)
        lots = [row for row in self.store.available_lots(self.owner, seq_hash) if row['kind'] == 'original' and int(row['remaining']) > 0]
        self.assertTrue(lots)
        source = _model(m.FeeSourceIdentity, lots[0]['source_record'])
        source_id, currency = source.digest(), lots[0]['currency']
        same = lambda row: _model(m.FeeSourceIdentity, row['source_record']).digest() == source_id and row['currency'] == currency and row['kind'] == 'original'
        ledger_before = sum(int(row['remaining']) for row in self.store.available_lots(self.owner, seq_hash) if same(row))
        balance = lambda: self.call(self.vault, 'feeBalance(bytes32,address)', ['(uint128,uint128)'], ['bytes32', 'address'], [bytes.fromhex(source_id[2:]), currency])[0]
        vault_before = balance()[0]
        self.assertEqual(ledger_before, vault_before)
        withdraw = max(1, vault_before // 2)
        receipt = self.send(self.vault, calldata('withdrawFeeReserves(bytes32,address,uint128,uint128)', ['bytes32', 'address', 'uint128', 'uint128'],
                                                 [bytes.fromhex(source_id[2:]), currency, withdraw, 0]))
        self.assertEqual(balance()[0], vault_before - withdraw)
        # Not final yet: the vault and the ledger disagree, the executor finds the
        # effect still canonical, and the planner waits without a transaction.
        self.advance(2)
        blocked = self.cycle.run(self.entry, act=False)
        self.assertEqual(blocked['outcome'], 'wait', blocked)
        self.assertIn('ledger_chain_mismatch', blocked['decision']['observationDiagnostics'])
        self.assertEqual(blocked['ledger']['withdrawals'], [])
        self.assertFalse(self.store.sequence(self.owner, seq_hash)['suspended'])
        self.finalize()
        read = self.cycle.run(self.entry, act=False)
        self.assertNotIn('ledger_chain_mismatch', read['decision']['observationDiagnostics'], read)
        recorded = read['ledger']['withdrawals']
        self.assertEqual(len(recorded), 1, read['ledger'])
        self.assertEqual((recorded[0]['state'], recorded[0]['originalRaw'], recorded[0]['chargedRaw'], recorded[0]['sourceId'], recorded[0]['currency'],
                          recorded[0]['transactionHash'], recorded[0]['unattributedOriginalRaw'], recorded[0]['unattributedChargedRaw']),
                         ('recorded', str(withdraw), '0', source_id, currency, receipt['transactionHash'], '0', '0'))
        self.assertEqual(sum(int(d['amountRaw']) for d in recorded[0]['debits']), withdraw)
        self.assertEqual(recorded[0]['blockNumber'], int(receipt['blockNumber'], 16))
        # The ledger's lots for that source equal the vault's balance again, and the reader is caught up.
        self.assertEqual(sum(int(row['remaining']) for row in self.store.available_lots(self.owner, seq_hash) if same(row)), balance()[0])
        self.assertEqual((read['ledger']['caughtUp'], read['ledger']['held'], read['ledger']['exceptions']), (True, None, []))
        status = self.cycle.status(self.entry)
        self.assertEqual(status['ledger']['cursor']['blockNumber'], read['ledger']['cursor'])
        self.assertEqual([w['withdrawalId'] for w in status['ledger']['withdrawals']], [recorded[0]['withdrawalId']])
        self.assertEqual(status['ledger']['exceptions'], [])
        # A second read records nothing new; the same event is the same row.
        again = self.cycle.run(self.entry, act=False)
        self.assertEqual((again['ledger']['withdrawals'], again['ledger']['exceptions']), ([], []))
        self.assertEqual(len(self.cycle.index_store.withdrawals(self.owner, seq_hash)), 1)
        # With fresh trading the cycle acts again from the reduced lots.
        self.warm_up(2)
        self.advance(2)
        self.trade()
        resumed = self.cycle.run(self.entry)
        self.assertIn(resumed['outcome'], ('executing', 'wait'), resumed)
        self.assertNotIn('ledger_chain_mismatch', resumed['decision']['observationDiagnostics'])

    def test_swap_quote_matches_the_engine_output_exactly(self):
        self.setup()
        # Fees mostly in currency0, at a volume that keeps the spot inside the
        # root range and within the reference divergence the config admits.
        self.warm_up(rounds=3, amount=2 * 10**16, directions=(True,))
        self.advance(2)
        self.trade(amount=10**16, directions=(False,))
        self.advance(2)
        self.trade(amount=2 * 10**16, directions=(True,))
        acted = self.cycle.run(self.entry)
        self.assertEqual(acted['outcome'], 'executing', acted)
        self.assertTrue(acted['decision']['chosen']['swap'], acted['decision'])
        intent = self.ledger.get(self.owner, acted['intentId'])
        plan = _model(m.ExecutionPlan, intent['plan'])
        observation = _model(m.Observation, intent['observation'])
        journal = ExecutionJournal(self.pg.settings)
        typed = decode_plan(journal.read(self.owner, acted['intentId'])['journal']['envelope']['data'])
        self.finalize()
        self.assertEqual(self.cycle.run(self.entry)['outcome'], 'completed')
        receipt = journal.status(self.owner, acted['intentId'])['receipt']
        self.assertEqual(len(receipt['conversions']), 1)
        reader = ChainReader(self.rpc)
        block = reader.block(int(plan.sourceBlockNumber))
        pool = pool_state(reader, self.state, observation.sequence.poolId, block)
        replay = simulate_exact_input(reader, self.state, observation.sequence.poolKey, observation.sequence.poolId, pool, block,
                                      zero_for_one=plan.swap.currencyIn == self.key[0], amount_in=int(plan.swap.amountInRaw),
                                      price_limit=int(typed.swap.sqrtPriceLimitX96), max_steps=64)
        self.assertEqual(str(replay['amountOut']), receipt['conversions'][0]['amountOutRaw'])
        self.assertEqual(receipt['conversions'][0]['amountInRaw'], plan.swap.amountInRaw)


if __name__ == '__main__':
    unittest.main()
