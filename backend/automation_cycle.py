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
from fractions import Fraction
import json
import random
import sys
import time
import uuid

import execution_models as m
import execution_planner as p
import general_compound_receipts as g
from automation_config import AutomationConfig
from automation_evidence import PPM, SWAP_WINDOW_BLOCKS, build_evidence, exposure_ppm
from automation_ledger import LedgerIndexStore, LedgerIndexer
from automation_observer import (POLICY_TYPE, ChainReader, ObservationError, derive_admission, ledger_balances, measurement_history,
                                 observe_sequence, sample_pool)
from automation_plan import PlanError, build_execution_plan, observation_id, observation_point
from automation_store import CycleStore
from execution_runner import ExecutionRunner
from execution_signer import ExecutionError, ExecutionRpc, RestrictedSigner, SignerPolicy
from execution_store import ExecutionStoreError, UnsignedExecutionStore, _model
from gas_budget_bridge import GasBudgetClient
from gas_usd_budget import GasBudgetError, QuotePolicy
from publisher_signer import PublicationJournal, PublisherPolicy, PublisherSigner
from read_deadline import read_deadline

WAIT_STATES = ('planned', 'reserved', 'publishing', 'published', 'executing')
TERMINAL_EXECUTION = ('reconciled', 'reverted', 'attention', 'reorged')
MAX_SUMMARY_CANDIDATES = 16
# Cycles that paid for a publication, over which the operator's expected
# publications per completed cycle are measured.
ATTEMPT_WINDOW = 20
PUBLICATION_POLL_SECONDS = 0.1
EXECUTION_POLL_SECONDS = 0.5
READINESS_MAX_INTERVAL_SECONDS = 15


def service_readiness_probe(cycle, entry):
    """Read-only proof of the gas peer, chain RPC and current vault admission.

    A due-state skip alone never reads the chain. Check the same private peer
    that must reserve gas, an available finalized head, and the vault's live
    owner, root permission, operator and policy. A paused vault may be ready
    for its owner to Resume. Settlement also requires a fresh finalized quote.
    """
    try:
        peer = cycle.gas_budget
        if not isinstance(peer, GasBudgetClient):
            return False
        with read_deadline(12):
            if peer.health() is not True:
                return False
            reader = cycle.reader
            reader.reset()
            if g._quantity(reader.request('eth_chainId', ())) != 4663:
                return False
            head = reader.head()
            finalized = reader.finalized()
            now = cycle.clock()
            if not (0 < finalized['number'] <= head['number']
                    and finalized['timestamp'] <= head['timestamp'] <= now + 5
                    and now - head['timestamp'] <= QuotePolicy().max_head_age_seconds
                    and now - finalized['timestamp'] <= QuotePolicy().max_finalized_lag_seconds):
                return False
            deployment = cycle.config.deployment
            # Operator, publisher, fee recipient and the price guard's guardian
            # are plain keys. Code on one (an EIP-7702 designator) means that key
            # signed an authorization; a delegated fee recipient can also refuse
            # or forward native fees, which the vault's exact-receipt check turns
            # into a revert, and the guardian can name a new publisher. The
            # guardian is immutable in the guard, so it is read there.
            guardian = reader.call(deployment.priceGuard, 'guardian()', ['address'], head)[0]
            for role in (deployment.operator, deployment.pricePublisher, deployment.serviceFeeRecipient, guardian):
                if reader.request('eth_getCode', (role, {'blockHash': head['hash'], 'requireCanonical': True})) != '0x':
                    return False
            derive_admission(reader, cycle.config.deployment, entry.owner, entry.vault, head)
            policy = reader.call(entry.vault, 'policy()', [POLICY_TYPE], head)[0]
            operator = reader.call(entry.vault, 'operator()', ['address'], head)[0]
            enabled = reader.call(entry.vault, 'isOperator(address)', ['bool'], head,
                                  ['address'], [cycle.config.deployment.operator])[0]
            root_permission = reader.call(entry.vault, 'rootPermissionValid()', ['bool'], head)[0]
            return (operator.lower() == deployment.operator and enabled is True
                    and root_permission is True
                    and (policy[0] == deployment.dominoServiceFeeBps
                         or policy[0] == deployment.serviceFeeBps and policy[4] == 1))
    except Exception:
        return False


def service_ready_after_pass(cycle, entry, summary, infrastructure_ready=False):
    """Only the live serve loop can advertise a short-lived owner activation gate.

    This says that this worker handled the admitted vault and its signing lane is
    configured. It is not a promise that a future cycle will be economical or
    that a transaction will succeed; all execution checks remain independent.
    """
    config = cycle.config
    outcome = summary.get('outcome')
    if (not infrastructure_ready
            or outcome not in ('wait', 'not_due', 'completed', 'executing')
            or (outcome == 'not_due' and summary.get('readinessQualified') is not True)
            or (outcome == 'wait' and
                (type(summary.get('decision')) is not dict
                 or summary['decision'].get('observationDiagnostics') != []))
            or config.paused or entry.suspended
            or cycle.clock() >= min(entry.expiresAt, config.deployment.expiresAt)
            or config.scheduling.evaluationIntervalSeconds > READINESS_MAX_INTERVAL_SECONDS
            or not config.operator.policy.enabled or not config.publisher.enabled
            or cycle.operator_key is None or cycle.publisher is None
            or cycle.publisher.address != config.deployment.pricePublisher):
        return False
    try:
        from eth_account import Account
        if Account.from_key(cycle.operator_key).address.lower() != config.deployment.operator:
            return False
        if cycle.store.control(entry.owner, 'paused') is True:
            return False
        return True
    except Exception:
        # A readiness probe must fail closed even if a key decoder raises.
        return False


class CycleError(ValueError):
    def __init__(self, code):
        self.code = code
        super().__init__(code)


def decision_summary(decision, *, evidence_reasons=(), diagnostics=(), samples=0, swap_cap=None, attempts=None):
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
            'historySamples': samples, 'candidatesEvaluated': len(decision.candidates) - 1, 'swapCap': swap_cap,
            'expectedPublicationsPerCompletion': None if attempts is None else f'{attempts.numerator}/{attempts.denominator}',
            'chosen': economics(decision.candidates[decision.selected]) if decision.selected else None,
            'candidates': [economics(c) for c in ranked],
            'routing': [{'source': r.sourcePosition, 'action': r.action, 'reason': r.reason, 'destinations': len(r.destinations)} for r in decision.routing],
            'waiting': [{'source': w.source, 'currency': w.currency, 'origin': w.origin, 'amountRaw': str(w.amountRaw), 'reason': w.reason} for w in decision.waiting]}


class Evaluation:
    def __init__(self, ctx, history, evidence, evidence_reasons, decision, *, samples=(), notes=None, attempts=Fraction(1)):
        self.ctx, self.history, self.evidence, self.evidence_reasons, self.decision = ctx, history, evidence, evidence_reasons, decision
        self.samples, self.notes, self.attempts = samples, notes or {}, attempts

    def summary(self, samples):
        return decision_summary(self.decision, evidence_reasons=self.evidence_reasons, diagnostics=self.ctx.diagnostics,
                                samples=samples, swap_cap=self.notes.get('swapCap'), attempts=self.attempts)


class SequenceCycle:
    def __init__(self, config, *, rpc=None, worker_id=None, operator_key=None, publisher_key=None,
                 gas_budget=None, clock=time.time, rng=None):
        if not isinstance(config, AutomationConfig):
            raise CycleError('automation_configuration_required')
        self.config = config
        self.rpc = rpc or ExecutionRpc(config.rpcEndpoint)
        self.reader = ChainReader(self.rpc)
        settings = config.database.settings()
        self.gas_budget = gas_budget if gas_budget is not None else GasBudgetClient()
        self.store = CycleStore(settings)
        self.ledger = UnsignedExecutionStore(settings)
        self.journal = PublicationJournal(settings, gas_budget=self.gas_budget)
        self.index_store = LedgerIndexStore(settings)
        ledger = config.ledger
        self.indexer = (LedgerIndexer(self.reader, self.index_store, max_blocks=ledger.maxBlocksPerPass, max_logs=ledger.maxLogsPerPass)
                        if ledger.indexer == 'inline' else None)
        self.worker = worker_id or config.scheduling.workerId or str(uuid.uuid4())
        self.clock = clock
        # Unpredictable to anyone outside: the jitter hides when a sequence observes.
        self.random = rng or random.SystemRandom()
        self.settings = config.planner_settings()
        self.operator_key = operator_key
        self.publisher = None
        if publisher_key is not None:
            pub = config.publisher
            self.publisher = PublisherSigner(self.rpc, publisher_key, config.deployment.priceGuard,
                PublisherPolicy(pub.maxGas, pub.maxFeePerGas, pub.priorityFeePerGas, pub.maxTotalCostWei,
                                pub.expirySeconds, pub.enabled), gas_budget=self.gas_budget)
            if self.publisher.address != config.deployment.pricePublisher:
                raise CycleError('automation_publisher_key_mismatch')

    # ------------------------------------------------------------ helpers
    def _due(self, seconds):
        """A wait of about `seconds`, jittered within the configured share."""
        jitter = self.config.scheduling.jitterBps
        if seconds <= 0 or jitter == 0:
            return int(seconds)
        return round(seconds * (10000 + self.random.uniform(-jitter, jitter)) / 10000)

    def _elapsed(self, started):
        return int((self.clock() - started) * 1000)

    def _signer(self, admission, anchor):
        if self.operator_key is None:
            raise CycleError('automation_operator_key_required')
        policy = SignerPolicy(**self.config.operator.policy.model_dump())
        signer = RestrictedSigner(self.rpc, self.operator_key, admission, policy,
                                  price_observation_id=anchor, gas_budget=self.gas_budget)
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

    def evaluate(self, entry, admission, block, state, *, samples=None, only=None):
        """Observe, sample, assemble evidence and run the planner at one block.
        No transaction, no reservation; the decision and its reasons only.

        The act path passes the samples it already has and the destinations
        worth re-quoting: it re-reads only the pool, the vault and the ledger.
        """
        owner = entry.owner
        seq = admission.sequence
        seq_hash = seq.digest()
        if samples is None:
            samples = self._sample(owner, admission, block)
        balances = ledger_balances(self.store.available_lots(owner, seq_hash))
        ctx = observe_sequence(self.reader, admission, balances, block)
        pending = self.store.pending_intents(owner, seq_hash)
        waiting_since = max(state['waitingSince'], ctx.last_execution_at)
        history = measurement_history(seq_hash, samples, waiting_since=waiting_since, last_attempt_at=block['timestamp'],
                                      last_read_failed=not ctx.observation.coverageComplete)
        used = self.store.swap_exposure(owner, seq.poolId, block_number=block['number'], window_blocks=SWAP_WINDOW_BLOCKS)
        attempted, completed = self.store.attempt_history(owner, seq_hash, limit=ATTEMPT_WINDOW)
        attempts = Fraction(attempted + 1, completed + 1)
        notes = {}
        evidence, reasons = build_evidence(self.reader, ctx, admission, samples, self.config, self.settings,
                                           used_ppm=min(used, PPM), attempts=attempts, only=only, notes=notes)
        decision = p.plan(ctx.observation, history, self.settings, evidence, now=block['timestamp'],
                          pending_intent=pending['pending'], pending_parents=pending['parents'])
        return Evaluation(ctx, history, evidence, reasons, decision, samples=samples, notes=notes, attempts=attempts), pending, len(samples)

    # --------------------------------------------------------------- run
    def run(self, entry, *, act=True, respect_due=False):
        """One bounded pass for one sequence: resume open work, or evaluate and,
        when eligible and allowed, take the cycle as far as it can go now.
        `respect_due` (the service loop) skips a sequence whose due time has
        not come and that has nothing open; a manual pass always evaluates."""
        self.reader.reset()
        with read_deadline(self.config.scheduling.cycleBudgetSeconds):
            return self._run(entry, act=act, respect_due=respect_due)

    def _source(self):
        """The block an observation binds to: the newest one the guard can already
        prove, which is the block before the head. A publication needs its source
        strictly earlier than its own block, and the executor needs the head past
        the source; observing one block back satisfies both without waiting."""
        head = self.reader.head()
        return head, self.reader.block(max(0, head['number'] - 1))

    def _run(self, entry, *, act, respect_due):
        owner, scheduling = entry.owner, self.config.scheduling
        if respect_due:
            known = self.store.due_state(owner, entry.vault)
            if known and not any(k['open'] or k['nextDueEpoch'] <= self.clock() for k in known):
                # Not due, nothing open to resume: no chain read, no lease, no evaluation.
                return {'sequenceHash': known[0]['sequenceHash'], 'owner': owner, 'vault': entry.vault, 'worker': self.worker,
                        'outcome': 'not_due', 'nextDueEpoch': min(k['nextDueEpoch'] for k in known),
                        'readinessQualified': all(k['readinessQualified'] for k in known)}
        head, source = self._source()
        admission = derive_admission(self.reader, self.config.deployment, owner, entry.vault, head)
        seq_hash = admission.sequence.digest()
        state = self.store.ensure_sequence(owner, seq_hash, entry.vault, admission.sequence.poolId, now=source['timestamp'])
        summary = {'sequenceHash': seq_hash, 'owner': owner, 'vault': entry.vault, 'head': head['number'], 'worker': self.worker}
        lease = self.store.acquire_sequence(owner, seq_hash, self.worker, lease_seconds=scheduling.leaseSeconds)
        fence = lease['fence']
        updates = {'last_attempt_at': source['timestamp'], 'last_read_failed': False}
        if state['waitingSince'] > source['timestamp']:
            # The block the waiting interval was moved to is gone: the chain
            # observed now predates it. The interval restarts at this block, and
            # the ledger check below turns the lost block into an explicit reorg.
            updates['waiting_since'] = source['timestamp']
            state = {**state, 'waitingSince': source['timestamp']}
        try:
            open_cycle = self.store.open_cycle(owner, seq_hash)
            if open_cycle is not None and not act:
                # An evaluation reports the cycle in flight; only a pass that may
                # act, with its keys, carries it on.
                summary.update(outcome='open', cycleId=open_cycle['cycleId'], state=open_cycle['state'])
                return summary
            if open_cycle is not None:
                summary.update(self._resume(entry, admission, open_cycle, fence, updates))
                return summary
            blocked = self._blocked(entry, admission, state, head)
            if blocked:
                summary.update(outcome='skipped', reason=blocked)
                updates['next_due_seconds'] = self._due(scheduling.evaluationIntervalSeconds)
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
            summary_decision = evaluation.summary(samples)
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
                updates['backoff_seconds'] = self._backoff(state, decision)
                updates['next_due_seconds'] = self._due(updates['backoff_seconds'])
                return summary
            refusal = self._budget(state, head)
            if refusal:
                self.store.update_cycle(owner, cycle_id, self.worker, fence, state='abandoned', reason=refusal)
                summary.update(outcome='refused', reason=refusal)
                updates['next_due_seconds'] = self._due(scheduling.evaluationIntervalSeconds)
                return summary
            summary.update(self._act(entry, admission, cycle_id, fence, state, updates, evaluation))
            return summary
        finally:
            in_flight = sys.exc_info()[1]
            try:
                row = self.store.update_sequence(owner, seq_hash, self.worker, fence, release=True, **updates)
                summary['nextDueEpoch'] = row['nextDueEpoch']
            except ExecutionStoreError:
                # With an error already in flight, that error is the one to
                # report; the lease expires on its own. Without one, the failed
                # release is the error.
                if in_flight is None:
                    raise

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
    def _act(self, entry, admission, cycle_id, fence, state, updates, prepared):
        """The fast path. The pass's evaluation already found what is eligible;
        at a fresh block the cycle re-reads only the pool, the vault and the
        ledger, re-quotes only those destinations, then plan → swap share →
        intent → reservation → publication → execution, each step durable
        before the next, each timed on the cycle's record."""
        owner, seq_hash, scheduling = entry.owner, admission.sequence.digest(), self.config.scheduling
        started = self.clock()
        _, source = self._source()
        only = frozenset(c.destination.digest() for c in prepared.decision.candidates[1:] if not c.reasons and c.destination is not None)
        evaluation, pending, _ = self.evaluate(entry, admission, source, state, samples=prepared.samples, only=only)
        latency = {'sourceBlock': source['number'], 'sourceTimestamp': source['timestamp'], 'targetSeconds': scheduling.latencyTargetSeconds,
                   'evaluatedMs': self._elapsed(started)}
        decision = evaluation.decision
        if decision.action == 'wait':
            self.store.update_cycle(owner, cycle_id, self.worker, fence, state='abandoned', reason='replan_wait', cost={'latency': latency})
            updates['next_due_seconds'] = self._due(scheduling.evaluationIntervalSeconds)
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
        latency['plannedMs'] = self._elapsed(started)
        if plan is None:
            reason = refusals[0] if refusals else 'no_representable_candidate'
            self.store.update_cycle(owner, cycle_id, self.worker, fence, state='abandoned', reason=reason[:100], cost={'latency': latency})
            updates['next_due_seconds'] = self._due(scheduling.evaluationIntervalSeconds)
            return {'outcome': 'abandoned', 'reason': reason, 'refusals': refusals}
        point = observation_point(evaluation.ctx, plan)
        anchor = observation_id(admission.priceGuard, point)
        intent = plan.intent_id()
        observation = evaluation.ctx.observation
        if plan.swap.enabled:
            refusal = self._reserve_swap(owner, seq_hash, fence, plan, evaluation, intent)
            if refusal:
                self.store.update_cycle(owner, cycle_id, self.worker, fence, state='abandoned', reason=refusal, cost={'latency': latency})
                updates['next_due_seconds'] = self._due(scheduling.evaluationIntervalSeconds)
                return {'outcome': 'abandoned', 'reason': refusal}
        try:
            self.ledger.persist(owner, plan, observation, actor=observation.operator, price_observation_id=anchor)
        except ExecutionStoreError as error:
            if plan.swap.enabled:
                self.store.release_swap(owner, seq_hash, self.worker, fence, intent)
            self.store.update_cycle(owner, cycle_id, self.worker, fence, state='abandoned', reason='persist_' + error.code, cost={'latency': latency})
            updates['next_due_seconds'] = self._due(scheduling.evaluationIntervalSeconds)
            return {'outcome': 'abandoned', 'reason': error.code}
        latency['persistedMs'] = self._elapsed(started)
        self.store.update_cycle(owner, cycle_id, self.worker, fence, state='planned', intent_id=intent, observation_id=anchor, cost={'latency': latency})
        cycle = self.store.cycle(owner, cycle_id)
        return self._drive(entry, admission, cycle, fence, updates, point=point, started=started)

    def _reserve_swap(self, owner, seq_hash, fence, plan, evaluation, intent):
        """The plan's share of its pool's swap cap, taken before the intent
        exists; the reason to abandon when the pool has none left."""
        seq = evaluation.ctx.observation.sequence
        zero_for_one = plan.swap.currencyIn == seq.poolKey.currency0
        cap = evaluation.notes.get('caps', {}).get(zero_for_one)
        if cap is None:
            return 'swap_cap_unmeasured'
        amount = int(plan.swap.amountInRaw)
        usage = exposure_ppm(amount, cap)
        if usage is None or usage > PPM:
            return 'swap_cap_exhausted'
        try:
            self.store.reserve_swap(owner, seq_hash, self.worker, fence, intent_id=intent, pool_id=seq.poolId,
                                    block_number=int(plan.sourceBlockNumber), zero_for_one=zero_for_one, amount_in=amount, cap_raw=cap,
                                    usage_ppm=usage, window_blocks=SWAP_WINDOW_BLOCKS)
        except ExecutionStoreError as error:
            return 'swap_cap_exhausted' if error.code == 'execution_swap_cap_exhausted' else 'reserve_swap_' + error.code.removeprefix('execution_')
        return None

    def _resume(self, entry, admission, cycle, fence, updates):
        return self._drive(entry, admission, cycle, fence, updates, point=None, started=None)

    def _drive(self, entry, admission, cycle, fence, updates, *, point, started):
        """Advance an open cycle from whatever state it was left in. `started`
        is the act path's clock when this pass created the cycle; a resumed
        cycle keeps its chain-time latency only."""
        owner = entry.owner
        cycle_id, intent, anchor = cycle['cycleId'], cycle['intentId'], cycle['observationId']
        state = cycle['state']
        result = {'cycleId': cycle_id, 'intentId': intent, 'observationId': anchor}
        # The act path wrote the source block when it planned; the chain-time
        # latency is measured against it, whichever pass carries the cycle on.
        # A cycle opened before cycles recorded latency takes it from its plan.
        latency = dict((cycle['cost'] or {}).get('latency') or {})
        if 'sourceBlock' not in latency:
            stored = self.ledger.get(owner, intent)
            latency.update(sourceBlock=int(stored['plan']['sourceBlockNumber']), sourceTimestamp=int(stored['observation']['blockTimestamp']),
                           targetSeconds=self.config.scheduling.latencyTargetSeconds)
        clock = (started, latency)
        if state == 'planned':
            try:
                lease = self.ledger.acquire(owner, intent, self.worker, lease_seconds=300)
                self.ledger.reserve(owner, intent, self.worker, lease['fence'])
            except ExecutionStoreError as error:
                return self._abandon(owner, cycle_id, intent, fence, updates, 'reserve_' + error.code, result, latency=latency)
            if started is not None:
                latency['reservedMs'] = self._elapsed(started)
            self.store.update_cycle(owner, cycle_id, self.worker, fence, state='reserved', cost={'latency': latency})
            state = 'reserved'
        if state in ('reserved', 'publishing'):
            outcome = self._publish(owner, cycle_id, intent, anchor, fence, updates, point, result, clock)
            if outcome is not None:
                return outcome
            state = 'published'
        if state in ('published', 'executing'):
            return self._execute(owner, admission, cycle_id, intent, anchor, fence, updates, result, clock)
        raise CycleError('automation_cycle_state')

    def _publish(self, owner, cycle_id, intent, anchor, fence, updates, point, result, clock):
        scheduling, finality = self.config.scheduling, self.config.finality
        started, latency = clock
        stored = self.ledger.get(owner, intent)
        plan = _model(m.ExecutionPlan, stored['plan'])
        observation = _model(m.Observation, stored['observation'])
        if point is None:
            point = (bytes.fromhex(observation.sequence.poolId[2:]), int(plan.sourceBlockNumber), bytes.fromhex(plan.sourceBlockHash[2:]),
                     int(observation.blockTimestamp), int(plan.deadline), int(observation.sqrtPriceX96))
        if observation_id(self.config.deployment.priceGuard, point) != anchor:
            return self._abandon(owner, cycle_id, intent, fence, updates, 'anchor_mismatch', result, latency=latency)
        head = self.reader.head()
        if head['number'] - int(plan.sourceBlockNumber) >= scheduling.maxSourceBlockAge or head['timestamp'] > int(plan.deadline):
            return self._abandon(owner, cycle_id, intent, fence, updates, 'source_window_lost', result, latency=latency)
        if self.publisher is None:
            return self._abandon(owner, cycle_id, intent, fence, updates, 'signers_unavailable', result, latency=latency)
        try:
            # Reserve both possible network payments as one database transaction
            # before either key can sign. The signer gates independently check
            # the exact envelope maximum immediately before signing.
            raw_head = self.rpc.request('eth_getBlockByNumber', ['latest', False])
            base = g._quantity(raw_head.get('baseFeePerGas'))
            pub_policy = self.publisher.policy
            op_policy = self.config.operator.policy
            pub_fee = min(pub_policy.max_fee_per_gas, 2 * base + pub_policy.priority_fee_per_gas)
            op_fee = min(op_policy.max_fee_per_gas, 2 * base + op_policy.priority_fee_per_gas)
            pub_max = pub_policy.max_gas * pub_fee
            op_max = op_policy.max_gas * op_fee
            if (pub_max > pub_policy.max_total_cost
                    or op_max > min(op_policy.max_total_cost, int(plan.maxGasCostWei))):
                raise ExecutionError('execution_gas_budget')
            self.gas_budget.reserve_pair(anchor, self.publisher.address, pub_max,
                intent, self.config.deployment.operator, op_max)
            publication = self.journal.prepare(self.publisher, point, max_source_age=scheduling.maxSourceBlockAge)
        except GasBudgetError as error:
            return self._abandon(owner, cycle_id, intent, fence, updates, 'publish_' + error.code,
                                 result, latency=latency)
        except ExecutionError as error:
            return self._abandon(owner, cycle_id, intent, fence, updates, 'publish_' + error.code, result, latency=latency)
        if self.store.cycle(owner, cycle_id)['state'] != 'publishing':
            self.store.update_cycle(owner, cycle_id, self.worker, fence, state='publishing', cost={'latency': latency})
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
                if started is not None and 'publicationSentMs' not in latency:
                    latency['publicationSentMs'] = self._elapsed(started)
                publication = self.journal.check(anchor, self.rpc, confirmations=finality.publicationConfirmations)
            result['publication'] = publication['state']
            if publication['state'] == 'confirmed' or (publication['state'] == 'included' and finality.publicationConfirmations == 0):
                break
            if publication['state'] in ('reverted', 'expired', 'attention'):
                return self._abandon(owner, cycle_id, intent, fence, updates, 'publication_' + publication['state'], result,
                                     cost=self._publication_cost(publication), latency=latency)
            head = self.reader.head()
            if head['number'] - int(plan.sourceBlockNumber) >= scheduling.maxSourceBlockAge or self.clock() >= deadline:
                return self._abandon(owner, cycle_id, intent, fence, updates, 'publication_window_lost', result,
                                     cost=self._publication_cost(publication), latency=latency)
            time.sleep(PUBLICATION_POLL_SECONDS)
        if started is not None:
            latency['publicationIncludedMs'] = self._elapsed(started)
        if publication.get('includedBlockNumber') is not None:
            latency['publicationBlock'] = publication['includedBlockNumber']
            latency['publicationBlocksAfterSource'] = publication['includedBlockNumber'] - latency['sourceBlock']
        self.store.update_cycle(owner, cycle_id, self.worker, fence, state='published', cost={**self._publication_cost(publication), 'latency': latency})
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

    def _execution_block(self, status):
        """Where the execution landed: the reconciled receipt's block, else the
        block of whichever attempt has a receipt. None while none has."""
        block = (status.get('receipt') or {}).get('block') or {}
        if block.get('number') is not None and block.get('timestamp') is not None:
            return int(block['number']), int(block['timestamp'])
        for attempt in status.get('attempts') or ():
            try:
                raw = self.reader.receipt(attempt['transactionHash'])
                header = self.reader.block(int(raw['blockNumber'], 16))
            except (ObservationError, KeyError, TypeError, ValueError):
                continue
            return header['number'], header['timestamp']
        return None

    def _execution_latency(self, latency, status):
        if 'executionBlock' in latency:
            return False
        landed = self._execution_block(status)
        if landed is None:
            return False
        number, timestamp = landed
        seconds = timestamp - latency['sourceTimestamp']
        latency.update(executionBlock=number, executionBlocksAfterSource=number - latency['sourceBlock'],
                       executionSecondsAfterSource=seconds, withinTarget=seconds <= latency['targetSeconds'])
        return True

    def _execute(self, owner, admission, cycle_id, intent, anchor, fence, updates, result, clock):
        scheduling = self.config.scheduling
        started, latency = clock
        try:
            runner = ExecutionRunner(self.config.database.settings(), self._signer(admission, anchor), restore_only=False)
        except CycleError as error:
            return self._abandon(owner, cycle_id, intent, fence, updates, error.code.removeprefix('automation_'), result, latency=latency)
        journal = runner.journal.read(owner, intent)['journal']
        if journal is None:
            # Nothing signed yet: name the refusal while the intent can still be released.
            reason = self._prevalidate(admission, _model(m.ExecutionPlan, self.ledger.get(owner, intent)['plan']), anchor)
            if reason:
                return self._abandon(owner, cycle_id, intent, fence, updates, reason, result, latency=latency)
        if journal is None or journal['state'] == 'signing':
            # Publication may have taken longer than the signing gate's 120s.
            # Refresh only an unsigned operator leg; reconciliation of an
            # already signed attempt never depends on a fresh price quote.
            try:
                policy = self.config.operator.policy
                base = g._quantity(self.rpc.request('eth_getBlockByNumber',
                    ['latest', False]).get('baseFeePerGas'))
                fee = min(policy.max_fee_per_gas, 2 * base + policy.priority_fee_per_gas)
                maximum = policy.max_gas * fee
                if maximum > policy.max_total_cost:
                    raise ExecutionError('execution_gas_budget')
                self.gas_budget.reserve_one(intent, 'operator',
                    self.config.deployment.operator, maximum)
            except (GasBudgetError, ExecutionError) as error:
                code = error.code
                if journal is None:
                    return self._abandon(owner, cycle_id, intent, fence, updates,
                                         'operator_' + code, result, latency=latency)
                return self._park(owner, cycle_id, fence, updates,
                                  'operator_' + code, result, latency)
        deadline = self.clock() + scheduling.executionWaitSeconds
        status = None
        while True:
            try:
                status = runner.step(owner, intent, self.worker)
            except ExecutionStoreError as error:
                # Another worker's lease, or the store: leave the intent to the
                # executor's journal and come back on the next pass.
                return self._park(owner, cycle_id, fence, updates, 'step_' + error.code, result, latency)
            except (ExecutionError, ValueError) as error:
                code = getattr(error, 'code', str(error))
                journal = runner.journal.read(owner, intent)['journal']
                if journal is None:
                    # Nothing was signed: the plan lost its qualification before
                    # the key was used. Release the reservation and replan later.
                    return self._abandon(owner, cycle_id, intent, fence, updates, 'qualify_' + code[:90], result, latency=latency)
                return self._park(owner, cycle_id, fence, updates, 'step_' + code[:95], result, latency)
            result['execution'] = status['state']
            if started is not None and 'executionSentMs' not in latency:
                latency['executionSentMs'] = self._elapsed(started)
            landed = self._execution_latency(latency, status) if status['state'] in TERMINAL_EXECUTION + ('included',) else False
            if status['state'] == 'reconciled':
                receipt = status['receipt'] or {}
                gas = receipt.get('gas') or {}
                cost = {'execution': {'transactionHash': receipt.get('transactionHash'), 'gasUsedRaw': gas.get('gasUsedRaw'),
                                      'effectiveGasPriceRaw': gas.get('effectiveGasPriceRaw'), 'wei': gas.get('receiptGasProductWei'),
                                      'action': receipt.get('action'), 'liquidityIncreaseRaw': receipt.get('liquidityIncreaseRaw')},
                        'latency': latency}
                self.store.update_cycle(owner, cycle_id, self.worker, fence, state='completed', cost=cost)
                block = receipt.get('block') or {}
                if block.get('timestamp'):
                    # The interval starts at the receipt's block; an attempt
                    # that observed an earlier block is dated no earlier.
                    updates['waiting_since'] = int(block['timestamp'])
                    updates['last_attempt_at'] = max(int(updates.get('last_attempt_at', 0)), int(block['timestamp']))
                updates['backoff_seconds'] = 0
                updates['consecutive_failures'] = 0
                updates['next_due_seconds'] = self._due(scheduling.evaluationIntervalSeconds)
                result.update(outcome='completed', cost=cost)
                return result
            if status['state'] == 'reverted':
                self.store.update_cycle(owner, cycle_id, self.worker, fence, state='abandoned', reason='execution_reverted', cost={'latency': latency})
                self._fail(owner, cycle_id, updates, minimum=scheduling.maximumBackoffSeconds)
                result.update(outcome='abandoned', reason='execution_reverted')
                return result
            if status['state'] in ('attention', 'reorged'):
                self.store.update_cycle(owner, cycle_id, self.worker, fence, state='abandoned', reason='execution_' + status['state'],
                                        cost={'latency': latency})
                updates.update(suspended=True, suspension_reason='execution_' + status['state'])
                result.update(outcome='suspended', reason='execution_' + status['state'])
                return result
            if self.store.cycle(owner, cycle_id)['state'] != 'executing' or landed:
                self.store.update_cycle(owner, cycle_id, self.worker, fence, state='executing', cost={'latency': latency})
            if self.clock() >= deadline:
                # Sent, not yet final: the next pass resumes from the journal.
                updates['next_due_seconds'] = self._due(scheduling.evaluationIntervalSeconds)
                result.update(outcome='executing', reason=status['reason'] or status['state'])
                return result
            time.sleep(EXECUTION_POLL_SECONDS)

    def _park(self, owner, cycle_id, fence, updates, reason, result, latency):
        """A signed intent the executor could not advance now stays open; the
        cycle records why and the scheduler comes back to it."""
        if self.store.cycle(owner, cycle_id)['state'] != 'executing':
            self.store.update_cycle(owner, cycle_id, self.worker, fence, state='executing', reason=reason[:100], cost={'latency': latency})
        updates['next_due_seconds'] = self._due(self.config.scheduling.evaluationIntervalSeconds)
        result.update(outcome='executing', reason=reason)
        return result

    def _fail(self, owner, cycle_id, updates, *, minimum=0):
        """An attempt paid for and not completed. Past the configured count of
        consecutive failures, each one doubles the wait, up to the maximum."""
        scheduling = self.config.scheduling
        state = self.store.sequence(owner, self.store.cycle(owner, cycle_id)['sequenceHash'])
        failures = state['consecutiveFailures'] + 1
        wait = scheduling.evaluationIntervalSeconds
        if failures >= scheduling.failureBackoffAfter:
            wait = wait * 2 ** (failures - scheduling.failureBackoffAfter + 1)
        updates['consecutive_failures'] = failures
        updates['next_due_seconds'] = self._due(min(scheduling.maximumBackoffSeconds, max(minimum, wait)))

    def _abandon(self, owner, cycle_id, intent, fence, updates, reason, result, *, cost=None, latency=None):
        """Release an unsigned intent's reservation and its swap share, and
        close the cycle. A signed intent cannot be cancelled here; the executor
        owns it. A cycle whose publication has a receipt paid for it, and
        counts as a failed attempt: the same rule the operator's expected
        publications per completion are measured by."""
        cycle = self.store.cycle(owner, cycle_id)
        if cycle['state'] == 'publishing' and 'publication' not in (cost or {}) and cycle['observationId']:
            # Resumed and abandoned before its poll. A publication still live
            # holds its nonce, and every later one waits behind it: send its
            # persisted bytes, as a restart would, whatever the chain then makes
            # of them. Whether it was included says whether it was paid for.
            try:
                cost = {**(cost or {}), **self._publication_cost(self._settle_publication(cycle['observationId']))}
            except (ExecutionError, ExecutionStoreError):
                pass
        released = False
        if intent is not None:
            try:
                lease = self.ledger.acquire(owner, intent, self.worker, lease_seconds=30)
                self.ledger.cancel(owner, intent, self.worker, lease['fence'])
                released = True
            except ExecutionStoreError:
                released = False
            if released:
                self.store.release_swap(owner, cycle['sequenceHash'], self.worker, fence, intent)
        reason = reason[:100]
        if latency is not None:
            cost = {**(cost or {}), 'latency': latency}
        self.store.update_cycle(owner, cycle_id, self.worker, fence, state='abandoned', reason=reason, cost=cost)
        if (({**(cycle['cost'] or {}), **(cost or {})}).get('publication') or {}).get('gasUsedRaw') is not None:
            self._fail(owner, cycle_id, updates)
        else:
            updates['next_due_seconds'] = self._due(self.config.scheduling.evaluationIntervalSeconds)
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

    def _settle_publication(self, anchor):
        """Drive one publication to what the chain says of it. Bytes never sent
        go out first, even late: a signed row holds its nonce, and retiring it
        unsent would leave every later publication of the key waiting behind
        the gap. A late one reverts at the guard, and its nonce is spent."""
        confirmations = self.config.finality.publicationConfirmations
        if self.journal.status(anchor)['state'] == 'signed':
            self.journal.send(anchor, self.rpc)
        row = self.journal.check(anchor, self.rpc, confirmations=confirmations)
        if row['state'] in ('signed', 'submitted', 'broadcast_unknown', 'reorged'):
            self.journal.send(anchor, self.rpc)
            row = self.journal.check(anchor, self.rpc, confirmations=confirmations)
        return row

    def recover_publications(self):
        """Drive every live publication of the configured publisher to a receipt."""
        results = []
        for row in self.journal.live(self.config.deployment.pricePublisher):
            row = self._settle_publication(row['observationId'])
            results.append({'observationId': row['observationId'], 'state': row['state'], 'reason': row['reason']})
        self.finalize_publications()
        return results

    def finalize_publications(self):
        """One bounded publisher-identity pass after terminal cycles leave live()."""
        return self.journal.finalize_pending(self.config.deployment.pricePublisher, self.rpc,
            confirmations=self.config.finality.publicationConfirmations, limit=8)

def serve(cycle, *, stop, sleep=time.sleep, log=print):
    """Round-robin over the admitted sequences, each at its own due time: a
    pass skips a sequence that is not due and has nothing open, and the loop
    then sleeps until the earliest due time, at least a second and at most the
    configured interval. Due times carry the jitter, so the pauses do too.

    First it drives every live publication to a receipt, and no cycle runs
    before that succeeds. A node or a database that is not up yet, as at boot
    when the unit starts before the RPC tunnel is back, is retried every
    interval instead of ending the process: three quick failures would exhaust
    the unit's start limit and leave the automation off."""
    interval = cycle.config.scheduling.evaluationIntervalSeconds
    while not stop():
        try:
            cycle.recover_publications()
            break
        except (ExecutionStoreError, ExecutionError) as error:
            log(json.dumps({'event': 'publication_recovery',
                            'code': getattr(error, 'code', 'publication_recovery_unavailable')}))
        except Exception:
            log(json.dumps({'event': 'publication_recovery', 'code': 'publication_recovery_unavailable'}))
        sleep(float(interval))
    while not stop():
        due = []
        finality_ready = True
        try:
            cycle.finalize_publications()
        except (ExecutionStoreError, ExecutionError) as error:
            finality_ready = False
            log(json.dumps({'event': 'publication_finality',
                            'code': getattr(error, 'code', 'publisher_finality_unavailable')}))
        except Exception:
            finality_ready = False
            log(json.dumps({'event': 'publication_finality',
                            'code': 'publisher_finality_unavailable'}))
        for entry in cycle.config.sequences:
            if stop():
                break
            summary = None
            try:
                summary = cycle.run(entry, respect_due=True)
                due.append(summary.get('nextDueEpoch'))
                if summary.get('outcome') != 'not_due':
                    log(json.dumps({'event': 'cycle', **{k: v for k, v in summary.items() if k != 'decision'}}, sort_keys=True, default=str))
            except ExecutionStoreError as error:
                log(json.dumps({'event': 'store', 'code': error.code, 'vault': entry.vault}))
            except (ObservationError, CycleError, ExecutionError, PlanError) as error:
                log(json.dumps({'event': 'refused', 'code': getattr(error, 'code', 'automation_unavailable'), 'vault': entry.vault}))
            except Exception:
                log(json.dumps({'event': 'error', 'code': 'automation_unavailable', 'vault': entry.vault}))
            try:
                # Probe after the cycle: a long pass may outlive earlier health
                # evidence. Admission is owner/vault specific, never shared.
                infrastructure_ready = service_readiness_probe(cycle, entry)
                cycle.store.record_readiness(entry.owner, entry.vault,
                    service_ready_after_pass(cycle, entry, summary or {},
                                             finality_ready and infrastructure_ready))
            except ExecutionStoreError as error:
                log(json.dumps({'event': 'readiness', 'code': error.code, 'vault': entry.vault}))
        now = cycle.clock()
        pause = min((d - now for d in due if d is not None), default=interval)
        sleep(max(1.0, min(float(interval), pause)))
