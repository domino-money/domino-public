"""The automation cycle on a disposable chain and database.

observe -> decide -> reserve -> publish (a real transaction from the publisher
key) -> inclusion -> qualify/sign/send through the durable executor -> receipt
-> reconciliation, with restarts at the transitions, two workers, a lost
broadcast reply, a publication and an execution the node dropped, a lost
source window, a revoked anchor, a moved price, an unfunded signer, pauses, a
reorg and a swap cap another vault used up.
Synthetic keys and a mock node interface, the pool's own spot as the only
price: this proves the integration, not a production deployment.
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
from eth_hash.auto import keccak

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
from execution_signer import ExecutionError
from execution_store import ExecutionStoreError, _model
from execution_v4_adapter import decode_plan

OPERATOR_KEY = bytes([66]) * 32   # published synthetic local test keys; never funded remotely
PUBLISHER_KEY = bytes([77]) * 32
NODE_INTERFACE = '0x' + '00' * 19 + 'c8'
OBSERVATION_TYPES = ['bytes32', 'uint64', 'bytes32', 'uint64', 'uint64', 'uint160']


class SyntheticGasBudget:
    # This EVM suite isolates cycle transitions. The real shared cap and
    # concurrent claims are exercised by test_gas_usd_budget.
    def reserve_pair(self, *args):
        return {'publisher': {}, 'operator': {}}

    def require_reservation(self, *args):
        return None

    def require_existing_reservation(self, *args):
        return None

    def reserve_one(self, *args):
        return {'state': 'reserved'}


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
            for name in ('019_execution_journal', '028_automation_cycle', '029_ledger_index',
                         '030_swap_exposure', '031_publication_resend',
                         '032_shared_gas_budget', '033_gas_budget_claim_read',
                         '034_gas_settlement_sweep', '035_cancel_unsigned_gas_claims',
                         '036_gas_settlement_journal_read',
                         '037_gas_settlement_receipt_evidence',
                         '038_gas_settlement_quote_witness'):
                conn.execute((Path(__file__).resolve().parents[1] / f'migrations/{name}.sql').read_text())
            for role in ('domino_execution_signer', 'domino_execution_publisher'):
                conn.execute(f'ALTER ROLE {role} LOGIN')

    def setUp(self):
        with self.pg.admin() as conn:
            conn.execute('TRUNCATE domino_execution.intents,domino_execution.origins,domino_execution.signer_heads,domino_execution.publications,'
                         'domino_execution.publisher_heads,domino_execution.cycles,domino_execution.sequence_state,domino_execution.pool_samples,'
                         'domino_execution.controls,domino_execution.withdrawals,domino_execution.withdrawal_debits,domino_execution.ledger_exceptions,'
                         'domino_execution.ledger_cursors,domino_execution.swap_exposure,'
                         'domino_execution.publication_finality_cursor CASCADE')
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
        raw = sample_config(currencies=(self.key[0], self.key[1]), **deep_update(defaults, changes))
        # The fixture pool has no native side: its quote token stands for the
        # wrapped native asset, so gas converts one to one. Conversion through
        # a native/quote pool is covered offline.
        raw['pricing']['wrappedNative'] = self.admission.sequence.quoteCurrency
        raw['pricing']['gasPools'] = {}
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

    def worker(self, worker_id=None, config=None):
        return SequenceCycle(config or self.config, rpc=self.rpc, worker_id=worker_id, operator_key=OPERATOR_KEY,
                             publisher_key=PUBLISHER_KEY, gas_budget=SyntheticGasBudget())

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

    def dropped_executions(self, cycle):
        """One pass in which the node takes every execution the operator sends
        and then drops it. Returns the pass and the hashes it sent."""
        request, sent = self.rpc.request, []
        def dropping(method, params):
            if method == 'eth_sendRawTransaction' and Account.recover_transaction(params[0]).lower() == self.operator:
                request('evm_setAutomine', [False])
                try:
                    reply = request(method, params)
                    request('anvil_dropTransaction', [reply])
                finally:
                    request('evm_setAutomine', [True])
                sent.append(reply)
                return reply
            return request(method, params)
        self.rpc.request = dropping
        try:
            return cycle.run(self.entry), sent
        finally:
            self.rpc.request = request

    def eligible(self):
        """Trade until an evaluation finds the sequence eligible: a completed
        cycle may have spent what the pool had earned so far."""
        for _ in range(4):
            outcome = self.warm_up(1)[0]
            if outcome['outcome'] == 'eligible_not_acted':
                return
        self.fail(outcome)

    def finalize(self):
        """Finality for the executor, with the pool trading meanwhile as a real
        pool would: the planner rates the window by its least active interval."""
        self.rpc.request('anvil_mine', ['0x40', '0x0'])
        self.advance(2)
        self.trade()

    def set_state(self, *, consecutive_failures=None, next_due_at=None):
        """Put the sequence's row where a scenario needs it, as an earlier
        history would have left it; the row's lease guard is bypassed."""
        with self.pg.admin() as conn:
            conn.execute('SET LOCAL session_replication_role = replica')
            if consecutive_failures is not None:
                conn.execute('UPDATE domino_execution.sequence_state SET consecutive_failures=%s', (consecutive_failures,))
            if next_due_at == 'far':
                conn.execute("UPDATE domino_execution.sequence_state SET next_due_at=clock_timestamp()+interval '1 hour'")

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
        # The service loop honours the backoff the wait set, without a single
        # chain read; a manual pass does not.
        reads = []
        request = self.rpc.request
        self.rpc.request = lambda method, params: reads.append(method) or request(method, params)
        try:
            skipped = self.cycle.run(self.entry, respect_due=True)
        finally:
            self.rpc.request = request
        self.assertEqual((skipped['outcome'], skipped['sequenceHash'], reads), ('not_due', first['sequenceHash'], []))
        self.assertGreater(first['nextDueEpoch'], time.time())
        self.warm_up()
        self.advance(2)
        self.trade()
        # Two earlier paid failures on record: the completion below resets them.
        self.set_state(consecutive_failures=2)
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
        # A pass before finality resumes the same cycle and adds no work; the
        # service loop resumes it too, even before the sequence's due time.
        self.set_state(next_due_at='far')
        again = self.cycle.run(self.entry, respect_due=True)
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
        self.assertEqual(state['consecutiveFailures'], 0)
        # Latency, in chain blocks and seconds from the observed block and in
        # wall-clock milliseconds along the act path of the pass that acted.
        latency = cycle['cost']['latency']
        self.assertEqual((latency['sourceBlock'], latency['sourceTimestamp'], latency['targetSeconds']),
                         (int(intent['plan']['sourceBlockNumber']), int(intent['observation']['blockTimestamp']), 5))
        self.assertEqual(latency['publicationBlock'], publication['includedBlockNumber'])
        self.assertEqual(latency['executionBlock'], int(receipt['block']['number']))
        self.assertGreater(latency['executionBlocksAfterSource'], latency['publicationBlocksAfterSource'])
        self.assertGreaterEqual(latency['publicationBlocksAfterSource'], 1)
        self.assertEqual(latency['executionSecondsAfterSource'], int(receipt['block']['timestamp']) - latency['sourceTimestamp'])
        self.assertEqual(latency['withinTarget'], latency['executionSecondsAfterSource'] <= 5)
        phases = [latency[k] for k in ('evaluatedMs', 'plannedMs', 'persistedMs', 'reservedMs', 'publicationSentMs', 'publicationIncludedMs', 'executionSentMs')]
        self.assertEqual(phases, sorted(phases))
        self.assertGreaterEqual(phases[0], 0)
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
        # A cycle opened by a release that did not record latency yet: the
        # resumed pass takes the source block from the plan.
        with self.pg.admin() as conn:
            conn.execute('SET LOCAL session_replication_role = replica')
            conn.execute("UPDATE domino_execution.cycles SET cost=cost-'latency' WHERE cycle_id=%s", (open_cycle['cycleId'],))
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
        plan = self.ledger.get(self.owner, open_cycle['intentId'])['plan']
        latency = self.store.cycle(self.owner, open_cycle['cycleId'])['cost']['latency']
        self.assertEqual(latency['sourceBlock'], int(plan['sourceBlockNumber']))
        self.assertGreater(latency['executionBlocksAfterSource'], latency['publicationBlocksAfterSource'])
        self.assertNotIn('evaluatedMs', latency)
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

    def test_recovery_resends_a_publication_the_node_never_received(self):
        self.setup()
        self.warm_up()
        self.advance(2)
        self.trade()
        request, send = self.rpc.request, self.journal.send
        def unreachable(method, params):
            if method == 'eth_sendRawTransaction':
                raise TimeoutError('synthetic: never reached the node')
            return request(method, params)
        def crash(anchor, rpc):
            self.rpc.request = unreachable
            try:
                send(anchor, rpc)
            finally:
                self.rpc.request = request
            raise RuntimeError('synthetic_crash_after_an_undelivered_send')
        self.journal.send = crash
        try:
            with self.assertRaisesRegex(RuntimeError, 'synthetic_crash'):
                self.cycle.run(self.entry)
        finally:
            self.journal.send = send
        live = self.journal.live(self.publisher)
        self.assertEqual([row['state'] for row in live], ['broadcast_unknown'])
        # The restarted service finds no receipt and sends the same bytes again.
        restarted = self.worker(self.cycle.worker)
        self.assertIn(restarted.recover_publications()[0]['state'], ('included', 'confirmed'))
        resumed = restarted.run(self.entry)
        self.assertEqual(resumed['outcome'], 'executing', resumed)
        self.assertEqual(self.counts()['publications'], 1)

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
        # Nothing was paid for: not a failed attempt.
        self.assertEqual(self.store.sequence(self.owner, lost['sequenceHash'])['consecutiveFailures'], 0)
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
        # The publication was paid for: one failed attempt.
        self.assertEqual(self.store.sequence(self.owner, revoked['sequenceHash'])['consecutiveFailures'], 1)
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
        self.assertEqual(self.store.sequence(self.owner, moved['sequenceHash'])['consecutiveFailures'], 2)
        # Two paid attempts, none completed: the operator now expects three
        # publications per completed cycle, and its cost says so.
        self.advance(2)
        after = self.cycle.run(self.entry, act=False)
        self.assertEqual(after['decision']['expectedPublicationsPerCompletion'], '3/1')

    def test_a_publication_is_never_left_unsent_and_counts_as_a_failure_only_once_paid(self):
        # A five-second deadline, so a publication can outlive its expiry.
        self.setup(scheduling={'maxSourceBlockAge': 20, 'publicationWaitSeconds': 2}, plan={'deadlineSeconds': 5})
        self.warm_up()
        nonce = lambda: int(self.rpc.request('eth_getTransactionCount', [self.publisher, 'latest']), 16)
        before = nonce()
        def crashed(lose, *, recover=False):
            self.advance(2)
            self.trade()
            send = self.journal.send
            def crash(*args, **kwargs):
                raise RuntimeError('synthetic_crash')
            self.journal.send = crash
            try:
                with self.assertRaisesRegex(RuntimeError, 'synthetic_crash'):
                    self.cycle.run(self.entry)
            finally:
                self.journal.send = send
            opened = self.store.open_cycle(self.owner, self.sequence_hash())
            self.assertEqual((opened['state'], self.journal.status(opened['observationId'])['state']), ('publishing', 'signed'))
            lose()
            restarted = self.worker(self.cycle.worker)
            if recover:
                restarted.recover_publications()
            resumed = restarted.run(self.entry)
            self.assertEqual((resumed['cycleId'], resumed['outcome'], resumed['reason']), (opened['cycleId'], 'abandoned', 'source_window_lost'))
            return self.store.cycle(self.owner, opened['cycleId']), self.store.sequence(self.owner, opened['sequenceHash'])
        # The service carries on without a restart and the source window passes
        # in blocks: the signed bytes still go out, so their nonce holds nothing
        # back. They land, were paid for, and count as a failed attempt.
        cycle, state = crashed(lambda: self.rpc.request('anvil_mine', ['0x20', '0x0']))
        self.assertEqual(cycle['cost']['publication']['state'], 'confirmed')
        self.assertGreater(int(cycle['cost']['publication']['gasUsedRaw']), 0)
        self.assertEqual((state['consecutiveFailures'], nonce()), (1, before + 1))
        # A restart after the publication expired: recovery sends it before an
        # expiry check could retire it unsent. The guard refuses it, the nonce
        # is spent, the revert was paid for, and it counts.
        cycle, state = crashed(lambda: self.advance(6), recover=True)
        self.assertEqual(cycle['cost']['publication']['state'], 'reverted')
        self.assertGreater(int(cycle['cost']['publication']['gasUsedRaw']), 0)
        self.assertEqual((state['consecutiveFailures'], nonce()), (2, before + 2))
        with self.pg.admin() as conn:
            self.assertEqual(int(conn.execute('SELECT next_nonce FROM domino_execution.publisher_heads').fetchone()[0]), before + 2)
        # Sent, not included before the wait ran out: nothing paid yet, not counted.
        self.advance(2)
        self.trade()
        self.rpc.request('evm_setAutomine', [False])
        try:
            waited = self.cycle.run(self.entry)
        finally:
            self.rpc.request('evm_setAutomine', [True])
        self.assertEqual((waited['outcome'], waited['reason']), ('abandoned', 'publication_window_lost'), waited)
        publication = self.store.cycle(self.owner, waited['cycleId'])['cost']['publication']
        self.assertIn(publication['state'], ('submitted', 'broadcast_unknown'))  # the node already held the re-sent bytes
        self.assertNotIn('gasUsedRaw', publication)
        self.assertEqual(self.store.sequence(self.owner, waited['sequenceHash'])['consecutiveFailures'], 2)
        self.rpc.request('evm_mine', [])
        self.advance(2)
        self.assertEqual(self.cycle.run(self.entry, act=False)['decision']['expectedPublicationsPerCompletion'], '3/1')

    def test_a_publication_the_node_dropped_is_sent_again_and_the_next_one_is_mined(self):
        # A five-second deadline, so a dropped publication expires within the
        # test. The cycles that carry on plan with the ordinary deadline, so a
        # slow runner cannot lose their execution to plan_expired.
        self.setup(scheduling={'maxSourceBlockAge': 20, 'publicationWaitSeconds': 2}, plan={'deadlineSeconds': 5})
        steady = self.config.model_copy(update={'plan': self.config.plan.model_copy(update={'deadlineSeconds': 100})})
        self.warm_up()
        nonce = lambda: int(self.rpc.request('eth_getTransactionCount', [self.publisher, 'latest']), 16)
        before = nonce()
        def dropped():
            # The node takes the publication and holds it, no block comes before
            # the cycle stops waiting, and then the node drops it.
            self.eligible()
            self.advance(2)
            self.trade()
            self.rpc.request('evm_setAutomine', [False])
            try:
                waited = self.cycle.run(self.entry)
                self.assertEqual((waited['outcome'], waited['reason']), ('abandoned', 'publication_window_lost'), waited)
                # While the node holds the bytes, nothing is sent again.
                self.assertEqual(self.journal.resend_unspent(self.publisher, self.rpc), [])
                publication = self.journal.status(waited['observationId'])
                self.rpc.request('anvil_dropTransaction', [publication['transactionHash']])
            finally:
                self.rpc.request('evm_setAutomine', [True])
            self.assertIn(publication['state'], ('submitted', 'broadcast_unknown'))
            self.advance(6)  # past the point's expiry
            return publication
        # A restart finds no receipt, the nonce unspent and the point past its
        # expiry: the row is retired as expired, and the nonce is still unspent.
        first = dropped()
        restarted = self.worker(self.cycle.worker, config=steady)
        self.assertEqual([row['state'] for row in restarted.recover_publications()], ['expired'])
        self.assertEqual(nonce(), before)
        # A plain send leaves an expired row alone; only a nonce the chain still waits for brings it back.
        self.assertEqual(self.journal.send(first['observationId'], self.rpc)['state'], 'expired')
        # The next cycle sends the same bytes again ahead of its own: the guard
        # refuses the late point, the nonce is spent, and the new one is mined.
        self.advance(2)
        self.trade()
        acted = restarted.run(self.entry)
        self.assertEqual(acted['outcome'], 'executing', acted)
        self.assertIn(self.journal.status(acted['observationId'])['state'], ('included', 'confirmed'))
        self.assertEqual(self.rpc.request('eth_getTransactionReceipt', [first['transactionHash']])['status'], '0x0')
        self.assertEqual(nonce(), before + 2)
        self.finalize()
        self.assertEqual(restarted.run(self.entry)['outcome'], 'completed')
        # Without a restart the dropped row is still live when the next cycle
        # comes: its bytes go out again too. The first one's nonce is spent, so
        # its bytes never do, although nothing has read its receipt yet and the
        # endpoint's pending count lags behind its latest one.
        second = dropped()
        self.assertEqual(self.journal.status(first['observationId'])['state'], 'submitted')
        sent = []
        request = self.rpc.request
        def spy(method, params):
            if method == 'eth_sendRawTransaction':
                sent.append('0x' + keccak(bytes.fromhex(params[0][2:])).hex())
            if method == 'eth_getTransactionCount' and params == [self.publisher, 'pending']:
                return hex(before)
            return request(method, params)
        self.advance(2)
        self.trade()
        self.rpc.request = spy
        try:
            acted = restarted.run(self.entry)
        finally:
            self.rpc.request = request
        self.assertEqual(acted['outcome'], 'executing', acted)
        self.assertIn(self.journal.status(acted['observationId'])['state'], ('included', 'confirmed'))
        self.assertIn(second['transactionHash'], sent)
        self.assertNotIn(first['transactionHash'], sent)
        self.assertEqual(nonce(), before + 4)
        # Recovery reads what the chain made of both: each late point was
        # refused at the guard, and each revert is on record with its gas.
        restarted.recover_publications()
        for publication in (first, second):
            row = self.journal.status(publication['observationId'])
            self.assertEqual(row['state'], 'reverted')
            self.assertGreater(int(row['gasUsedRaw']), 0)
        with self.pg.admin() as conn:
            self.assertEqual(int(conn.execute('SELECT next_nonce FROM domino_execution.publisher_heads').fetchone()[0]), nonce())

    def test_a_dropped_execution_past_its_deadline_is_sent_again_and_spends_its_nonce(self):
        # A five-second deadline, so the dropped execution's plan expires within
        # the test. The cycles that carry on plan with the ordinary deadline.
        self.setup(plan={'deadlineSeconds': 5})
        steady = self.config.model_copy(update={'plan': self.config.plan.model_copy(update={'deadlineSeconds': 100})})
        operator = steady.operator
        disabled = steady.model_copy(update={'operator': operator.model_copy(update={'policy': operator.policy.model_copy(update={'enabled': False})})})
        self.warm_up()
        self.advance(2)
        self.trade()
        nonce = lambda: int(self.rpc.request('eth_getTransactionCount', [self.operator, 'latest']), 16)
        before = nonce()
        acted, sent = self.dropped_executions(self.cycle)
        self.assertEqual(acted['outcome'], 'executing', acted)
        self.assertTrue(sent)
        journal = lambda: ExecutionJournal(self.pg.settings).status(self.owner, acted['intentId'])
        # The price leaves the plan's band, and the head reaches the deadline
        # itself, where a block could still take the bytes: they no longer
        # requalify, and the intent waits for them instead of retiring.
        deadline = int(self.ledger.get(self.owner, acted['intentId'])['plan']['deadline'])
        self.assertLess(int(self.rpc.request('eth_getBlockByNumber', ['latest', False])['timestamp'], 16), deadline - 1)
        self.rpc.request('evm_setNextBlockTimestamp', [deadline - 1])
        self.send(self.trader, calldata('swap(' + KEY_TYPE + ',bool,uint256)', [KEY_TYPE, 'bool', 'uint256'], [self.key, True, 2 * 10**17]))
        self.rpc.request('evm_setNextBlockTimestamp', [deadline])
        self.rpc.request('evm_mine', [])
        waited = self.cycle.run(self.entry)
        self.assertEqual((waited['outcome'], waited['reason']), ('executing', 'execution_revalidation_pending'), waited)
        self.assertEqual((journal()['state'], nonce()), ('submitted', before))
        self.assertFalse(self.store.sequence(self.owner, acted['sequenceHash'])['suspended'])
        # Past the deadline every block refuses the bytes, whatever the price
        # does now. A signer switched off still sends nothing.
        self.advance(1)
        self.trade(amount=2 * 10**17, directions=(False,))
        parked = self.worker(self.cycle.worker, config=disabled).run(self.entry)
        self.assertEqual((parked['outcome'], parked['reason']), ('executing', 'step_execution_disabled'), parked)
        self.assertEqual(nonce(), before)
        # Switched on, it sends the recorded bytes again as they are: the engine
        # reverts them, the nonce is spent, and the claims go back with the
        # canonical revert, as for any execution that reverts.
        restarted = self.worker(self.cycle.worker, config=steady)
        authorized = restarted.gas_budget.require_existing_reservation
        def refuse_operator_claim(_id, leg, *_args):
            if leg == 'operator':
                raise ExecutionError('gas_reservation_not_authorized')
            return authorized(_id, leg, *_args)
        restarted.gas_budget.require_existing_reservation = refuse_operator_claim
        refused = restarted.run(self.entry)
        self.assertEqual((refused['outcome'], refused['reason']),
                         ('executing', 'execution_gas_reservation_required'), refused)
        self.assertEqual(nonce(), before)
        restarted.gas_budget.require_existing_reservation = authorized
        restarted.run(self.entry)
        self.assertEqual(nonce(), before + 1)
        self.finalize()
        reverted = restarted.run(self.entry)
        self.assertEqual((reverted['outcome'], reverted['reason']), ('abandoned', 'execution_reverted'), reverted)
        self.assertEqual((journal()['state'], journal()['receipt']), ('reverted', None))
        self.assertEqual(self.rpc.request('eth_getTransactionReceipt', [journal()['attempts'][-1]['transactionHash']])['status'], '0x0')
        self.assertFalse(self.store.sequence(self.owner, acted['sequenceHash'])['suspended'])
        with self.pg.admin() as conn:
            self.assertEqual(int(conn.execute('SELECT next_nonce FROM domino_execution.signer_heads').fetchone()[0]), nonce())
        # Nothing waits behind the key: the next execution lands.
        self.eligible()
        self.advance(2)
        self.trade()
        again = restarted.run(self.entry)
        self.assertEqual(again['outcome'], 'executing', again)
        self.assertEqual(nonce(), before + 2)
        self.finalize()
        self.assertEqual(restarted.run(self.entry)['outcome'], 'completed')

    def test_a_dropped_execution_that_stops_qualifying_waits_and_lands_when_it_qualifies_again(self):
        self.setup()
        self.warm_up()
        self.advance(2)
        self.trade()
        nonce = lambda: int(self.rpc.request('eth_getTransactionCount', [self.operator, 'latest']), 16)
        before = nonce()
        acted, _ = self.dropped_executions(self.cycle)
        self.assertEqual(acted['outcome'], 'executing', acted)
        # The operator key runs out of gas funds with the deadline far ahead:
        # the bytes no longer requalify, and nothing is sent or retired.
        self.rpc.request('anvil_setBalance', [self.operator, hex(0)])
        waited, sent = self.dropped_executions(self.cycle)
        self.assertEqual((waited['outcome'], waited['reason'], sent), ('executing', 'execution_revalidation_pending', []), waited)
        self.assertEqual(ExecutionJournal(self.pg.settings).status(self.owner, acted['intentId'])['state'], 'submitted')
        self.assertFalse(self.store.sequence(self.owner, acted['sequenceHash'])['suspended'])
        self.assertEqual(nonce(), before)
        # Funded again, the same bytes requalify, go out again and land.
        self.rpc.request('anvil_setBalance', [self.operator, hex(10**20)])
        landed = self.cycle.run(self.entry)
        self.assertEqual((landed['outcome'], landed['cycleId']), ('executing', acted['cycleId']), landed)
        self.assertEqual(nonce(), before + 1)
        self.finalize()
        self.assertEqual(self.cycle.run(self.entry)['outcome'], 'completed')

    def test_an_evaluation_reports_a_cycle_in_flight_and_leaves_it(self):
        self.setup()
        self.warm_up()
        self.advance(2)
        self.trade()
        acted = self.cycle.run(self.entry)
        self.assertEqual(acted['outcome'], 'executing', acted)
        # The keyless evaluate command sees the open cycle and does not touch it.
        reader = SequenceCycle(self.config, rpc=self.rpc)
        seen = reader.run(self.entry, act=False)
        self.assertEqual((seen['outcome'], seen['cycleId'], seen['state']), ('open', acted['cycleId'], 'executing'))
        self.assertEqual(self.store.cycle(self.owner, acted['cycleId'])['state'], 'executing')
        self.assertNotEqual(self.ledger.get(self.owner, acted['intentId'])['state'], 'cancelled')
        self.finalize()
        self.assertEqual(self.cycle.run(self.entry)['outcome'], 'completed')

    def test_reorg_after_a_completed_cycle_is_recorded_and_suspends_the_sequence(self):
        self.setup()
        self.warm_up()
        self.advance(2)
        self.trade()
        snapshot = self.rpc.request('evm_snapshot', [])
        # The execution lands strictly later than the block the reverted chain
        # will observe, as on a real sequencer: the waiting interval it moved
        # must come back with the block, not stop the pass.
        self.advance(3)
        acted = self.cycle.run(self.entry)
        self.assertEqual(acted['outcome'], 'executing')
        self.finalize()
        self.assertEqual(self.cycle.run(self.entry)['outcome'], 'completed')
        receipt_time = ExecutionJournal(self.pg.settings).status(self.owner, acted['intentId'])['receipt']['block']['timestamp']
        self.assertEqual(self.store.sequence(self.owner, self.sequence_hash())['waitingSince'], receipt_time)
        self.assertTrue(self.rpc.request('evm_revert', [snapshot]))
        self.advance(2)
        blocked = self.cycle.run(self.entry)
        self.assertEqual((blocked['outcome'], blocked['reason']), ('suspended', 'execution_reorged'), blocked)
        self.assertIn('ledger_chain_mismatch', blocked['decision']['observationDiagnostics'])
        state = self.store.sequence(self.owner, blocked['sequenceHash'])
        self.assertLess(state['waitingSince'], receipt_time)
        self.assertLessEqual(state['waitingSince'], state['lastAttemptAt'])
        self.assertIsNone(state['workerId'])
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

    def test_a_swap_cap_another_vault_used_up_stops_before_the_intent_and_the_next_pass_goes_direct(self):
        self.setup()
        self.warm_up(rounds=3, amount=2 * 10**16, directions=(True,))
        self.advance(2)
        self.trade(amount=10**16, directions=(False,))
        self.advance(2)
        self.trade(amount=2 * 10**16, directions=(True,))
        evaluate = self.cycle.evaluate
        def racing(entry, admission, block, state, **kwargs):
            result = evaluate(entry, admission, block, state, **kwargs)
            if kwargs.get('only') is not None:
                # Between this act-time evaluation and the reservation, a vault
                # of another owner takes the whole cap of the same pool.
                with self.pg.admin() as conn:
                    conn.execute("SET LOCAL session_replication_role = replica")
                    conn.execute('INSERT INTO domino_execution.swap_exposure(reservation_id,intent_id,owner,sequence_hash,pool_id,block_number,'
                                 'zero_for_one,amount_in,cap_raw,usage_ppm) VALUES(%s,%s,%s,%s,%s,%s,true,1,1,1000000)',
                                 (str(uuid.uuid4()), '0x' + 'ab' * 32, '0x' + '22' * 20, '0x' + 'cd' * 32, admission.sequence.poolId, block['number']))
            return result
        self.cycle.evaluate = racing
        try:
            raced = self.cycle.run(self.entry)
        finally:
            self.cycle.evaluate = evaluate
        self.assertTrue(raced['decision']['chosen']['swap'], raced['decision'])
        self.assertEqual(raced['decision']['swapCap']['usedPpm'], 0)
        self.assertEqual((raced['outcome'], raced['reason']), ('abandoned', 'swap_cap_exhausted'), raced)
        self.assertEqual((self.counts()['intents'], self.counts()['publications']), (0, 0))
        self.assertEqual(self.store.sequence(self.owner, raced['sequenceHash'])['consecutiveFailures'], 0)
        # The next pass sees the pool's budget spent: no swap is quoted, and
        # the fees go in without one or wait, never over the cap.
        again = self.cycle.run(self.entry)
        self.assertEqual(again['decision']['swapCap']['usedPpm'], 10**6, again['decision'])
        self.assertIn(again['outcome'], ('executing', 'wait'), again)
        if again['outcome'] == 'executing':
            self.assertFalse(again['decision']['chosen']['swap'])
            self.assertFalse(_model(m.ExecutionPlan, self.ledger.get(self.owner, again['intentId'])['plan']).swap.enabled)
        with self.pg.admin() as conn:
            self.assertEqual(conn.execute('SELECT count(*) FROM domino_execution.swap_exposure').fetchone()[0], 1)

    def test_a_swap_share_is_given_back_when_its_intent_is_cancelled_unsigned(self):
        self.setup()
        self.warm_up(rounds=3, amount=2 * 10**16, directions=(True,))
        self.advance(2)
        self.trade(amount=10**16, directions=(False,))
        self.advance(2)
        self.trade(amount=2 * 10**16, directions=(True,))
        def shares():
            with self.pg.admin() as conn:
                return conn.execute('SELECT intent_id,released FROM domino_execution.swap_exposure ORDER BY created_at').fetchall()
        # The intent store fails after the share was taken: the share goes back.
        persist = self.ledger.persist
        def failing(*args, **kwargs):
            raise ExecutionStoreError('execution_store_unavailable')
        self.ledger.persist = failing
        try:
            failed = self.cycle.run(self.entry)
        finally:
            self.ledger.persist = persist
        self.assertTrue(failed['decision']['chosen']['swap'], failed['decision'])
        self.assertEqual((failed['outcome'], failed['reason']), ('abandoned', 'execution_store_unavailable'), failed)
        self.assertEqual([released for _, released in shares()], [True])
        # The same plan at the same block reserves again; revoked after its
        # publication and cancelled unsigned, it gives its share back too.
        signer = self.cycle._signer
        def revoking(admission, anchor):
            self.rpc.request('eth_sendTransaction', [{'from': self.guardian, 'to': self.admission.priceGuard, 'gas': hex(200000),
                                                      'data': calldata('revoke(bytes32)', ['bytes32'], [bytes.fromhex(anchor[2:])])}])
            return signer(admission, anchor)
        self.cycle._signer = revoking
        try:
            revoked = self.cycle.run(self.entry)
        finally:
            self.cycle._signer = signer
        self.assertEqual((revoked['outcome'], revoked['reason'], revoked['reservationReleased']), ('abandoned', 'anchor_revoked', True), revoked)
        # Nothing was mined in between: the same plan, the same intent, twice released.
        self.assertEqual(shares(), [(revoked['intentId'], True), (revoked['intentId'], True)])
        self.advance(2)
        self.assertEqual(self.cycle.run(self.entry, act=False)['decision']['swapCap']['usedPpm'], 0)

    def test_swap_quote_matches_the_engine_output_exactly(self):
        self.setup()
        self.swap_quote_replay()

    def test_swap_quote_matches_the_engine_output_with_the_pool_protocol_fee(self):
        # The WETH/USDG pool on 4663 charges a protocol fee of 52 pips each way
        # on top of its 200-pip LP fee; the fixture pool gets the same shape.
        self.setup()
        self.send(self.manager, calldata('setProtocolFeeController(address)', ['address'], [self.owner]))
        self.send(self.manager, calldata('setProtocolFee(' + KEY_TYPE + ',uint24)', [KEY_TYPE, 'uint24'], [self.key, 52 | (52 << 12)]))
        self.assertEqual(self.call(self.state, 'getSlot0(bytes32)', ['uint160', 'int24', 'uint24', 'uint24'], ['bytes32'],
                                   [bytes.fromhex(self.admission.sequence.poolId[2:])])[2], 52 | (52 << 12))
        self.swap_quote_replay()

    def swap_quote_replay(self):
        # Fees mostly in currency0, at a volume that keeps the spot inside the
        # root range.
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
        # The swap took its share of the pool's cap before the intent existed,
        # and keeps it: it was signed, whatever the window does next.
        with self.pg.admin() as conn:
            row = conn.execute('SELECT owner,pool_id,block_number,zero_for_one,amount_in,cap_raw,usage_ppm,released FROM domino_execution.swap_exposure '
                               'WHERE intent_id=%s', (acted['intentId'],)).fetchone()
        self.assertEqual((row[0], row[1], int(row[2]), row[3], str(row[4]), row[7]),
                         (self.owner, observation.sequence.poolId, int(plan.sourceBlockNumber), plan.swap.currencyIn == self.key[0], plan.swap.amountInRaw, False))
        # A signed intent's share stays: the database refuses to give it back.
        seq_hash = acted['sequenceHash']
        lease = self.store.acquire_sequence(self.owner, seq_hash, self.cycle.worker, lease_seconds=30)
        try:
            with self.assertRaisesRegex(ExecutionStoreError, 'execution_state_conflict'):
                self.store.release_swap(self.owner, seq_hash, self.cycle.worker, lease['fence'], acted['intentId'])
        finally:
            self.store.update_sequence(self.owner, seq_hash, self.cycle.worker, lease['fence'], release=True)
        # No block passed between the evaluation and the act: the same cap.
        self.assertEqual(str(row[5]), acted['decision']['swapCap']['directions']['zeroForOne' if row[3] else 'oneForZero'])
        self.assertEqual(row[6], -(-int(plan.swap.amountInRaw) * 10**6 // int(row[5])))


if __name__ == '__main__':
    unittest.main()
