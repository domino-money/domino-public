"""The automation cycle for one admitted sequence: observe, decide, reserve,
publish on demand, execute through the durable executor, reconcile.

Every transition is durable before its side effect and every side effect is
bounded: a lease per sequence keeps two workers from planning the same fees,
the intent store keeps two plans from spending the same lots, the publisher's
journal keeps a restart from publishing twice, and the executor's journal keeps
it from signing twice. A decision to wait costs nothing on chain. A cycle that
loses its source-block window, its anchor or its plan is abandoned with its
reason and cost on record; the next evaluation starts from current state.
"""
import json
import time
import uuid

import execution_models as m
import execution_planner as p
from automation_config import AutomationConfig
from automation_evidence import build_evidence
from automation_ledger import LedgerIndexStore, LedgerIndexer
from automation_observer import (ChainReader, ObservationError, derive_admission, ledger_balances, measurement_history,
                                 observe_sequence, sample_pool)
from automation_plan import PlanError, build_execution_plan, observation_id, observation_point
from automation_store import CycleStore
from execution_runner import ExecutionRunner
from execution_signer import ExecutionError, ExecutionRpc, RestrictedSigner, SignerPolicy
from execution_store import ExecutionStoreError, UnsignedExecutionStore, _model
from publisher_signer import PublicationJournal, PublisherPolicy, PublisherSigner
from read_deadline import read_deadline

WAIT_STATES = ('planned', 'reserved', 'publishing', 'published', 'executing')
TERMINAL_EXECUTION = ('reconciled', 'reverted', 'attention', 'reorged')
MAX_SUMMARY_CANDIDATES = 16


class CycleError(ValueError):
    def __init__(self, code):
        self.code = code
        super().__init__(code)


def decision_summary(decision, *, evidence_reasons=(), diagnostics=(), samples=0):
    """What is worth keeping of a decision: reasons, economics, waiting
    balances. Never a plan, an allocation list or a signable field."""
    def economics(candidate):
        e = candidate.economics
        return {'action': candidate.action, 'liquidityIncrease': str(candidate.liquidityIncrease), 'swap': candidate.swap is not None,
                'reasons': list(candidate.reasons), 'ownerNetBenefitQuote': str(e.ownerNetBenefitQuote),
                'incrementalEarningsQuote': str(e.incrementalEarningsQuote), 'serviceCostQuote': str(e.serviceCostQuote),
                'swapLossQuote': str(e.swapLossQuote), 'operatorRevenueQuote': str(e.operatorRevenueQuote),
                'operatorBufferedCostQuote': str(e.operatorBufferedCostQuote), 'ownerPass': e.ownerPass, 'operatorPass': e.operatorPass}
    ranked = sorted(decision.candidates[1:], key=lambda c: -c.economics.ownerNetBenefitQuote)[:MAX_SUMMARY_CANDIDATES]
    return {'action': decision.action, 'selected': decision.selected, 'reasons': list(decision.reasons),
            'evidenceReasons': list(evidence_reasons), 'observationDiagnostics': list(diagnostics),
            'elapsedWaitSeconds': decision.elapsedWaitSeconds, 'forecastHorizonSeconds': decision.forecastHorizonSeconds,
            'historySamples': samples, 'candidatesEvaluated': len(decision.candidates) - 1,
            'chosen': economics(decision.candidates[decision.selected]) if decision.selected else None,
            'candidates': [economics(c) for c in ranked],
            'routing': [{'source': r.sourcePosition, 'action': r.action, 'reason': r.reason, 'destinations': len(r.destinations)} for r in decision.routing],
            'waiting': [{'source': w.source, 'currency': w.currency, 'origin': w.origin, 'amountRaw': str(w.amountRaw), 'reason': w.reason} for w in decision.waiting]}


class Evaluation:
    def __init__(self, ctx, history, evidence, evidence_reasons, decision):
        self.ctx, self.history, self.evidence, self.evidence_reasons, self.decision = ctx, history, evidence, evidence_reasons, decision


class SequenceCycle:
    def __init__(self, config, *, rpc=None, worker_id=None, operator_key=None, publisher_key=None, clock=time.time):
        if not isinstance(config, AutomationConfig):
            raise CycleError('automation_configuration_required')
        self.config = config
        self.rpc = rpc or ExecutionRpc(config.rpcEndpoint)
        self.reader = ChainReader(self.rpc)
        settings = config.database.settings()
        self.store = CycleStore(settings)
        self.ledger = UnsignedExecutionStore(settings)
        self.journal = PublicationJournal(settings)
        self.index_store = LedgerIndexStore(settings)
        ledger = config.ledger
        self.indexer = (LedgerIndexer(self.reader, self.index_store, max_blocks=ledger.maxBlocksPerPass, max_logs=ledger.maxLogsPerPass)
                        if ledger.indexer == 'inline' else None)
        self.worker = worker_id or config.scheduling.workerId or str(uuid.uuid4())
        self.clock = clock
        self.settings = config.planner_settings()
        self.operator_key = operator_key
        self.publisher = None
        if publisher_key is not None:
            pub = config.publisher
            self.publisher = PublisherSigner(self.rpc, publisher_key, config.deployment.priceGuard,
                PublisherPolicy(pub.maxGas, pub.maxFeePerGas, pub.priorityFeePerGas, pub.maxTotalCostWei, pub.expirySeconds, pub.enabled))
            if self.publisher.address != config.deployment.pricePublisher:
                raise CycleError('automation_publisher_key_mismatch')

    # ------------------------------------------------------------ helpers
    def _signer(self, admission, anchor):
        if self.operator_key is None:
            raise CycleError('automation_operator_key_required')
        policy = SignerPolicy(**self.config.operator.policy.model_dump())
        signer = RestrictedSigner(self.rpc, self.operator_key, admission, policy, price_observation_id=anchor)
        if signer.address != self.config.deployment.operator:
            raise CycleError('automation_operator_key_mismatch')
        return signer

    def _sample(self, owner, admission, head):
        pool_id = admission.sequence.poolId
        latest = self.store.latest_sample(owner, pool_id)
        # Samples follow their own cadence, not the evaluations': the planner
        # takes the least fee rate over the window's intervals, so intervals
        # must be comparable buckets rather than whatever gap two passes leave.
        due = latest is None or head['timestamp'] - int(latest['block_timestamp']) >= self.config.history.sampleIntervalSeconds
        if due and (latest is None or int(latest['block_number']) < head['number']):
            row = sample_pool(self.reader, admission.stateView, pool_id, head, latest,
                              max_gap_seconds=self.config.history.maximumSampleGapSeconds, sampler_version=self.config.history.samplerVersion)
            if row is not None:
                if not self.reader.canonical(head):
                    raise ObservationError('automation_block_not_canonical')
                self.store.insert_sample(owner, row)
        since = head['timestamp'] - self.settings.maximumMeasurementSeconds - self.config.history.maximumSampleGapSeconds
        return self.store.samples(owner, pool_id, since_timestamp=max(0, since))

    def evaluate(self, entry, admission, block, state):
        """Observe, sample, assemble evidence and run the planner at one block.
        No transaction, no reservation; the decision and its reasons only."""
        owner = entry.owner
        seq_hash = admission.sequence.digest()
        samples = self._sample(owner, admission, block)
        balances = ledger_balances(self.store.available_lots(owner, seq_hash))
        ctx = observe_sequence(self.reader, admission, balances, block)
        pending = self.store.pending_intents(owner, seq_hash)
        waiting_since = max(state['waitingSince'], ctx.last_execution_at)
        history = measurement_history(seq_hash, samples, waiting_since=waiting_since, last_attempt_at=block['timestamp'],
                                      last_read_failed=not ctx.observation.coverageComplete)
        evidence, reasons = build_evidence(self.reader, ctx, admission, samples, self.config, self.settings)
        decision = p.plan(ctx.observation, history, self.settings, evidence, now=block['timestamp'],
                          pending_intent=pending['pending'], pending_parents=pending['parents'])
        return Evaluation(ctx, history, evidence, reasons, decision), pending, len(samples)

    # --------------------------------------------------------------- run
    def run(self, entry, *, act=True):
        """One bounded pass for one sequence: resume open work, or evaluate and,
        when eligible and allowed, take the cycle as far as it can go now."""
        self.reader.reset()
        with read_deadline(self.config.scheduling.cycleBudgetSeconds):
            return self._run(entry, act=act)

    def _source(self):
        """The block an observation binds to: the newest one the guard can already
        prove, which is the block before the head. A publication needs its source
        strictly earlier than its own block, and the executor needs the head past
        the source; observing one block back satisfies both without waiting."""
        head = self.reader.head()
        return head, self.reader.block(max(0, head['number'] - 1))

    def _run(self, entry, *, act):
        owner, scheduling = entry.owner, self.config.scheduling
        head, source = self._source()
        admission = derive_admission(self.reader, self.config.deployment, owner, entry.vault, head)
        seq_hash = admission.sequence.digest()
        state = self.store.ensure_sequence(owner, seq_hash, entry.vault, admission.sequence.poolId, now=source['timestamp'])
        lease = self.store.acquire_sequence(owner, seq_hash, self.worker, lease_seconds=scheduling.leaseSeconds)
        fence = lease['fence']
        summary = {'sequenceHash': seq_hash, 'owner': owner, 'vault': entry.vault, 'head': head['number'], 'worker': self.worker}
        updates = {'last_attempt_at': source['timestamp'], 'last_read_failed': False}
        try:
            open_cycle = self.store.open_cycle(owner, seq_hash)
            if open_cycle is not None:
                summary.update(self._resume(entry, admission, open_cycle, fence, updates))
                return summary
            blocked = self._blocked(entry, admission, state, head)
            if blocked:
                summary.update(outcome='skipped', reason=blocked)
                updates['next_due_seconds'] = scheduling.evaluationIntervalSeconds
                return summary
            if self.indexer is not None:
                summary['ledger'] = self.indexer.index(owner, admission)
            exceptions = self.store.unacknowledged_exceptions(owner, seq_hash)
            if exceptions:
                # A fee event of an execution the ledger cannot represent: the
                # operator decides what it was before any fees are offered again.
                updates.update(suspended=True, suspension_reason='ledger_exception')
                summary.update(outcome='suspended', reason='ledger_exception', exceptions=exceptions)
                return summary
            evaluation, pending, samples = self.evaluate(entry, admission, source, state)
            decision = evaluation.decision
            summary_decision = decision_summary(decision, evidence_reasons=evaluation.evidence_reasons,
                                                diagnostics=evaluation.ctx.diagnostics, samples=samples)
            cycle_id = self.store.record_cycle(owner, seq_hash, self.worker, fence, state='evaluated',
                reason=decision.reasons[0] if decision.reasons else ('wait' if decision.action == 'wait' else 'eligible'),
                config_version=self.config.configVersion, fingerprint=decision.inputFingerprint, observation_hash=decision.observationHash,
                source_block_number=source['number'], source_block_hash=source['hash'], decision=summary_decision)
            summary.update(cycleId=cycle_id, decision=summary_decision)
            updates['last_read_failed'] = not evaluation.ctx.observation.coverageComplete
            if 'ledger_chain_mismatch' in evaluation.ctx.diagnostics and self.operator_key is not None:
                # The vault disagrees with what the ledger settled: let the
                # executor re-verify the recent canonical effects, so a lost
                # block turns into an explicit reorg record, not a silent wait.
                reorged = self._recheck_effects(owner, seq_hash, admission)
                if reorged:
                    updates.update(suspended=True, suspension_reason='execution_reorged')
                    summary.update(outcome='suspended', reason='execution_reorged', reorged=reorged)
                    return summary
            if pending['attention']:
                updates.update(suspended=True, suspension_reason='sequence_attention')
                summary.update(outcome='suspended', reason='sequence_attention')
                return summary
            if decision.action == 'wait' or not act:
                summary.update(outcome='wait' if decision.action == 'wait' else 'eligible_not_acted')
                updates['next_due_seconds'] = self._backoff(state, decision)
                updates['backoff_seconds'] = updates['next_due_seconds']
                return summary
            refusal = self._budget(state, head)
            if refusal:
                self.store.update_cycle(owner, cycle_id, self.worker, fence, state='abandoned', reason=refusal)
                summary.update(outcome='refused', reason=refusal)
                updates['next_due_seconds'] = scheduling.evaluationIntervalSeconds
                return summary
            summary.update(self._act(entry, admission, cycle_id, fence, state, updates))
            return summary
        finally:
            self.store.update_sequence(owner, seq_hash, self.worker, fence, release=True, **updates)

    def _recheck_effects(self, owner, seq_hash, admission):
        reorged = []
        for intent in self.store.recent_effects(owner, seq_hash, limit=3):
            anchor = self.ledger.price_observation(owner, intent)
            if anchor is None:
                continue
            try:
                runner = ExecutionRunner(self.config.database.settings(), self._signer(admission, anchor), restore_only=True)
                status = runner.step(owner, intent, self.worker)
            except (ExecutionError, ExecutionStoreError, ValueError, CycleError):
                continue
            if status['state'] in ('reorged', 'attention'):
                reorged.append(intent)
        return reorged

    def _blocked(self, entry, admission, state, head):
        if self.config.paused or self.store.control(entry.owner, 'paused') is True:
            return 'paused'
        if state['suspended'] or entry.suspended:
            return 'suspended'
        if head['timestamp'] >= min(entry.expiresAt, self.config.deployment.expiresAt):
            return 'admission_expired'
        return None

    def _backoff(self, state, decision):
        scheduling = self.config.scheduling
        if decision.action != 'wait':
            return scheduling.evaluationIntervalSeconds
        previous = state['backoffSeconds'] or scheduling.minimumBackoffSeconds
        return min(scheduling.maximumBackoffSeconds, max(scheduling.minimumBackoffSeconds, previous * 2))

    def _budget(self, state, head):
        gas, scheduling = self.config.gas, self.config.scheduling
        if self.publisher is None or self.operator_key is None:
            return 'signers_unavailable'
        if state['publicationsInWindow'] >= scheduling.maxPublicationsPerWindow and state['publicationWindowStartEpoch']:
            if self.clock() - state['publicationWindowStartEpoch'] < scheduling.publicationWindowSeconds:
                return 'publication_budget'
        if self.reader.balance(self.config.deployment.pricePublisher) < gas.publisherMinimumBalanceWei:
            return 'funding_required_publisher'
        if self.reader.balance(self.config.deployment.operator) < gas.operatorMinimumBalanceWei:
            return 'funding_required_operator'
        return None

    # --------------------------------------------------------------- act
    def _act(self, entry, admission, cycle_id, fence, state, updates):
        """Fresh head, fresh decision, then plan → intent → reservation →
        publication → execution, each step durable before the next."""
        owner, seq_hash, scheduling = entry.owner, admission.sequence.digest(), self.config.scheduling
        _, source = self._source()
        evaluation, pending, _ = self.evaluate(entry, admission, source, state)
        decision = evaluation.decision
        if decision.action == 'wait':
            self.store.update_cycle(owner, cycle_id, self.worker, fence, state='abandoned', reason='replan_wait')
            updates['next_due_seconds'] = scheduling.evaluationIntervalSeconds
            return {'outcome': 'replan_wait', 'reason': decision.reasons[0] if decision.reasons else 'no_economically_qualified_candidate'}
        # The planner's ranking, best first; a swap candidate whose output
        # cannot be consumed at the price the swap leaves is skipped for the
        # next eligible one, which may be the direct addition or a smaller swap.
        ranked = sorted((c for c in decision.candidates[1:] if not c.reasons),
                        key=lambda c: (-c.economics.ownerNetBenefitQuote, -c.economics.productiveQuote, c.swap is not None))
        plan, refusals = None, []
        for candidate in ranked[:8]:
            try:
                plan = build_execution_plan(evaluation.ctx, candidate, plan_policy=self.config.plan, gas_cap_wei=self.config.plan.maxGasCostWei,
                                            reader=self.reader, state_view=admission.stateView, max_steps=self.config.destinations.maxSimulationSteps)
                break
            except PlanError as error:
                refusals.append(error.code.removeprefix('automation_'))
        if plan is None:
            reason = refusals[0] if refusals else 'no_representable_candidate'
            self.store.update_cycle(owner, cycle_id, self.worker, fence, state='abandoned', reason=reason[:100])
            updates['next_due_seconds'] = scheduling.evaluationIntervalSeconds
            return {'outcome': 'abandoned', 'reason': reason, 'refusals': refusals}
        point = observation_point(evaluation.ctx, plan)
        anchor = observation_id(admission.priceGuard, point)
        intent = plan.intent_id()
        observation = evaluation.ctx.observation
        try:
            self.ledger.persist(owner, plan, observation, actor=observation.operator, price_observation_id=anchor)
        except ExecutionStoreError as error:
            self.store.update_cycle(owner, cycle_id, self.worker, fence, state='abandoned', reason='persist_' + error.code)
            updates['next_due_seconds'] = scheduling.evaluationIntervalSeconds
            return {'outcome': 'abandoned', 'reason': error.code}
        self.store.update_cycle(owner, cycle_id, self.worker, fence, state='planned', intent_id=intent, observation_id=anchor)
        cycle = self.store.cycle(owner, cycle_id)
        return self._drive(entry, admission, cycle, fence, updates, point=point)

    def _resume(self, entry, admission, cycle, fence, updates):
        return self._drive(entry, admission, cycle, fence, updates, point=None)

    def _drive(self, entry, admission, cycle, fence, updates, *, point):
        """Advance an open cycle from whatever state it was left in."""
        owner, scheduling = entry.owner, self.config.scheduling
        cycle_id, intent, anchor = cycle['cycleId'], cycle['intentId'], cycle['observationId']
        state = cycle['state']
        result = {'cycleId': cycle_id, 'intentId': intent, 'observationId': anchor}
        if state == 'planned':
            try:
                lease = self.ledger.acquire(owner, intent, self.worker, lease_seconds=300)
                self.ledger.reserve(owner, intent, self.worker, lease['fence'])
            except ExecutionStoreError as error:
                return self._abandon(owner, cycle_id, intent, fence, updates, 'reserve_' + error.code, result)
            self.store.update_cycle(owner, cycle_id, self.worker, fence, state='reserved')
            state = 'reserved'
        if state in ('reserved', 'publishing'):
            outcome = self._publish(owner, cycle_id, intent, anchor, fence, updates, point, result)
            if outcome is not None:
                return outcome
            state = 'published'
        if state in ('published', 'executing'):
            return self._execute(owner, admission, cycle_id, intent, anchor, fence, updates, result)
        raise CycleError('automation_cycle_state')

    def _publish(self, owner, cycle_id, intent, anchor, fence, updates, point, result):
        scheduling, finality = self.config.scheduling, self.config.finality
        stored = self.ledger.get(owner, intent)
        plan = _model(m.ExecutionPlan, stored['plan'])
        observation = _model(m.Observation, stored['observation'])
        if point is None:
            point = (bytes.fromhex(observation.sequence.poolId[2:]), int(plan.sourceBlockNumber), bytes.fromhex(plan.sourceBlockHash[2:]),
                     int(observation.blockTimestamp), int(plan.deadline), int(observation.sqrtPriceX96))
        if observation_id(self.config.deployment.priceGuard, point) != anchor:
            return self._abandon(owner, cycle_id, intent, fence, updates, 'anchor_mismatch', result)
        head = self.reader.head()
        if head['number'] - int(plan.sourceBlockNumber) >= scheduling.maxSourceBlockAge or head['timestamp'] > int(plan.deadline):
            return self._abandon(owner, cycle_id, intent, fence, updates, 'source_window_lost', result)
        if self.publisher is None:
            return self._abandon(owner, cycle_id, intent, fence, updates, 'signers_unavailable', result)
        try:
            publication = self.journal.prepare(self.publisher, point, max_source_age=scheduling.maxSourceBlockAge)
        except ExecutionError as error:
            return self._abandon(owner, cycle_id, intent, fence, updates, 'publish_' + error.code, result)
        if self.store.cycle(owner, cycle_id)['state'] != 'publishing':
            self.store.update_cycle(owner, cycle_id, self.worker, fence, state='publishing')
            updates['publications_in_window'] = self._count_publication(owner, cycle_id)
            updates['publication_window_start_now'] = True
        deadline = self.clock() + scheduling.publicationWaitSeconds
        sent_at = None
        while True:
            publication = self.journal.check(anchor, self.rpc, confirmations=finality.publicationConfirmations)
            # Send persisted bytes that the chain has not seen; a submitted
            # transaction is re-sent only after a pause, with the same bytes.
            if publication['state'] in ('signed', 'broadcast_unknown', 'reorged') or (
                    publication['state'] == 'submitted' and (sent_at is None or self.clock() - sent_at >= 2)):
                publication = self.journal.send(anchor, self.rpc)
                sent_at = self.clock()
                publication = self.journal.check(anchor, self.rpc, confirmations=finality.publicationConfirmations)
            result['publication'] = publication['state']
            if publication['state'] == 'confirmed' or (publication['state'] == 'included' and finality.publicationConfirmations == 0):
                break
            if publication['state'] in ('reverted', 'expired', 'attention'):
                return self._abandon(owner, cycle_id, intent, fence, updates, 'publication_' + publication['state'], result,
                                     cost=self._publication_cost(publication))
            head = self.reader.head()
            if head['number'] - int(plan.sourceBlockNumber) >= scheduling.maxSourceBlockAge or self.clock() >= deadline:
                return self._abandon(owner, cycle_id, intent, fence, updates, 'publication_window_lost', result,
                                     cost=self._publication_cost(publication))
            time.sleep(0.25)
        self.store.update_cycle(owner, cycle_id, self.worker, fence, state='published', cost=self._publication_cost(publication))
        return None

    def _count_publication(self, owner, cycle_id):
        state = self.store.sequence(owner, self.store.cycle(owner, cycle_id)['sequenceHash'])
        started = state['publicationWindowStartEpoch']
        if started and self.clock() - started < self.config.scheduling.publicationWindowSeconds:
            return state['publicationsInWindow'] + 1
        return 1

    @staticmethod
    def _publication_cost(publication):
        if publication.get('gasUsedRaw') is None:
            return {'publication': {'state': publication['state']}}
        return {'publication': {'state': publication['state'], 'gasUsedRaw': publication['gasUsedRaw'],
                                'effectiveGasPriceRaw': publication['effectiveGasPriceRaw'],
                                'wei': str(int(publication['gasUsedRaw']) * int(publication['effectiveGasPriceRaw']))}}

    def _prevalidate(self, admission, plan, anchor):
        """Read-only reasons the executor would refuse for, named before it is
        asked: the executor stays the authority and reports sanitized codes,
        so the common refusals are recognised here with their own words."""
        head = self.reader.head()
        if head['timestamp'] > int(plan.deadline):
            return 'plan_expired'
        if self.reader.call(admission.priceGuard, 'revoked(bytes32)', ['bool'], head, ['bytes32'], [bytes.fromhex(anchor[2:])])[0]:
            return 'anchor_revoked'
        spot = self.reader.call(admission.stateView, 'getSlot0(bytes32)', ['uint160', 'int24', 'uint24', 'uint24'], head,
                                ['bytes32'], [bytes.fromhex(admission.sequence.poolId[2:])])[0]
        if not int(plan.minSqrtPriceX96) <= spot <= int(plan.maxSqrtPriceX96):
            return 'price_outside_plan_band'
        vault = admission.sequence.vault
        if (self.reader.call(vault, 'stateNonce()', ['uint64'], head)[0] != int(plan.expectedStateNonce)
                or self.reader.call(vault, 'authorityGeneration()', ['uint64'], head)[0] != int(plan.expectedAuthorityGeneration)):
            return 'authority_changed'
        return None

    def _execute(self, owner, admission, cycle_id, intent, anchor, fence, updates, result):
        scheduling = self.config.scheduling
        try:
            runner = ExecutionRunner(self.config.database.settings(), self._signer(admission, anchor), restore_only=False)
        except CycleError as error:
            return self._abandon(owner, cycle_id, intent, fence, updates, error.code.removeprefix('automation_'), result)
        if runner.journal.read(owner, intent)['journal'] is None:
            # Nothing signed yet: name the refusal while the intent can still be released.
            reason = self._prevalidate(admission, _model(m.ExecutionPlan, self.ledger.get(owner, intent)['plan']), anchor)
            if reason:
                return self._abandon(owner, cycle_id, intent, fence, updates, reason, result)
        deadline = self.clock() + scheduling.executionWaitSeconds
        status = None
        while True:
            try:
                status = runner.step(owner, intent, self.worker)
            except ExecutionStoreError as error:
                # Another worker's lease, or the store: leave the intent to the
                # executor's journal and come back on the next pass.
                return self._park(owner, cycle_id, fence, updates, 'step_' + error.code, result)
            except (ExecutionError, ValueError) as error:
                code = getattr(error, 'code', str(error))
                journal = runner.journal.read(owner, intent)['journal']
                if journal is None:
                    # Nothing was signed: the plan lost its qualification before
                    # the key was used. Release the reservation and replan later.
                    return self._abandon(owner, cycle_id, intent, fence, updates, 'qualify_' + code[:90], result)
                return self._park(owner, cycle_id, fence, updates, 'step_' + code[:95], result)
            result['execution'] = status['state']
            if status['state'] == 'reconciled':
                receipt = status['receipt'] or {}
                gas = receipt.get('gas') or {}
                cost = {'execution': {'transactionHash': receipt.get('transactionHash'), 'gasUsedRaw': gas.get('gasUsedRaw'),
                                      'effectiveGasPriceRaw': gas.get('effectiveGasPriceRaw'), 'wei': gas.get('receiptGasProductWei'),
                                      'action': receipt.get('action'), 'liquidityIncreaseRaw': receipt.get('liquidityIncreaseRaw')}}
                self.store.update_cycle(owner, cycle_id, self.worker, fence, state='completed', cost=cost)
                block = receipt.get('block') or {}
                if block.get('timestamp'):
                    updates['waiting_since'] = int(block['timestamp'])
                updates['backoff_seconds'] = 0
                updates['next_due_seconds'] = scheduling.evaluationIntervalSeconds
                result.update(outcome='completed', cost=cost)
                return result
            if status['state'] == 'reverted':
                self.store.update_cycle(owner, cycle_id, self.worker, fence, state='abandoned', reason='execution_reverted')
                updates['next_due_seconds'] = self.config.scheduling.maximumBackoffSeconds
                result.update(outcome='abandoned', reason='execution_reverted')
                return result
            if status['state'] in ('attention', 'reorged'):
                self.store.update_cycle(owner, cycle_id, self.worker, fence, state='abandoned', reason='execution_' + status['state'])
                updates.update(suspended=True, suspension_reason='execution_' + status['state'])
                result.update(outcome='suspended', reason='execution_' + status['state'])
                return result
            if self.store.cycle(owner, cycle_id)['state'] != 'executing':
                self.store.update_cycle(owner, cycle_id, self.worker, fence, state='executing')
            if self.clock() >= deadline:
                # Sent, not yet final: the next pass resumes from the journal.
                updates['next_due_seconds'] = scheduling.evaluationIntervalSeconds
                result.update(outcome='executing', reason=status['reason'] or status['state'])
                return result
            time.sleep(0.5)

    def _park(self, owner, cycle_id, fence, updates, reason, result):
        """A signed intent the executor could not advance now stays open; the
        cycle records why and the scheduler comes back to it."""
        if self.store.cycle(owner, cycle_id)['state'] != 'executing':
            self.store.update_cycle(owner, cycle_id, self.worker, fence, state='executing', reason=reason[:100])
        updates['next_due_seconds'] = self.config.scheduling.evaluationIntervalSeconds
        result.update(outcome='executing', reason=reason)
        return result

    def _abandon(self, owner, cycle_id, intent, fence, updates, reason, result, *, cost=None):
        """Release an unsigned intent's reservation and close the cycle. A
        signed intent cannot be cancelled here; the executor owns it."""
        released = False
        if intent is not None:
            try:
                lease = self.ledger.acquire(owner, intent, self.worker, lease_seconds=30)
                self.ledger.cancel(owner, intent, self.worker, lease['fence'])
                released = True
            except ExecutionStoreError:
                released = False
        reason = reason[:100]
        self.store.update_cycle(owner, cycle_id, self.worker, fence, state='abandoned', reason=reason, cost=cost)
        updates['next_due_seconds'] = self.config.scheduling.evaluationIntervalSeconds
        result.update(outcome='abandoned', reason=reason, reservationReleased=released)
        return result

    # ------------------------------------------------------------ status
    def status(self, entry):
        self.reader.reset()
        head = self.reader.head()
        admission = derive_admission(self.reader, self.config.deployment, entry.owner, entry.vault, head)
        seq_hash = admission.sequence.digest()
        try:
            state = self.store.sequence(entry.owner, seq_hash)
        except ExecutionStoreError:
            state = None
        latest = self.store.latest_sample(entry.owner, admission.sequence.poolId)
        return {'sequenceHash': seq_hash, 'owner': entry.owner, 'vault': entry.vault, 'head': head['number'],
                'state': state, 'openCycle': self.store.open_cycle(entry.owner, seq_hash) if state else None,
                'recentCycles': self.store.recent_cycles(entry.owner, seq_hash, limit=5) if state else [],
                'pending': {k: (sorted(v) if isinstance(v, frozenset) else v) for k, v in self.store.pending_intents(entry.owner, seq_hash).items()},
                'latestSampleAgeSeconds': head['timestamp'] - int(latest['block_timestamp']) if latest else None,
                'ledger': self.store.ledger_summary(entry.owner, seq_hash) if state else None,
                'balances': {'publisherWei': str(self.reader.balance(self.config.deployment.pricePublisher)),
                             'operatorWei': str(self.reader.balance(self.config.deployment.operator))},
                'paused': self.config.paused or self.store.control(entry.owner, 'paused') is True,
                'executionAvailable': False}

    def recover_publications(self):
        """Drive every live publication of the configured publisher to a receipt."""
        results = []
        for row in self.journal.live(self.config.deployment.pricePublisher):
            row = self.journal.check(row['observationId'], self.rpc, confirmations=self.config.finality.publicationConfirmations)
            if row['state'] in ('signed', 'submitted', 'broadcast_unknown', 'reorged'):
                self.journal.send(row['observationId'], self.rpc)
                row = self.journal.check(row['observationId'], self.rpc, confirmations=self.config.finality.publicationConfirmations)
            results.append({'observationId': row['observationId'], 'state': row['state'], 'reason': row['reason']})
        return results


def serve(cycle, *, stop, sleep=time.sleep, log=print):
    """Round-robin over the admitted sequences, honouring each one's due time.
    No busy loop: the pause between passes is the configured interval."""
    scheduling = cycle.config.scheduling
    while not stop():
        for entry in cycle.config.sequences:
            if stop():
                break
            try:
                summary = cycle.run(entry)
                log(json.dumps({'event': 'cycle', **{k: v for k, v in summary.items() if k != 'decision'}}, sort_keys=True, default=str))
            except ExecutionStoreError as error:
                log(json.dumps({'event': 'store', 'code': error.code, 'vault': entry.vault}))
            except (ObservationError, CycleError, ExecutionError, PlanError) as error:
                log(json.dumps({'event': 'refused', 'code': getattr(error, 'code', 'automation_unavailable'), 'vault': entry.vault}))
            except Exception:
                log(json.dumps({'event': 'error', 'code': 'automation_unavailable', 'vault': entry.vault}))
        sleep(scheduling.evaluationIntervalSeconds)
