"""The cycle's own decisions, offline: jittered due times, the backoff after
consecutive failed attempts, the swap's share of its pool's cap taken before
the intent exists, and a service loop that sleeps until the earliest due
sequence instead of a fixed interval."""
from pathlib import Path
import os
import random
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))
from automation_cycle import CycleError, SequenceCycle, serve, service_readiness_probe, service_ready_after_pass
from automation_fixtures import address, identity, sample_automation_config
from execution_store import ExecutionStoreError
from gas_budget_bridge import GasBudgetClient
from eth_account import Account


def cycle(**scheduling):
    config = sample_automation_config(scheduling=scheduling)
    # No request leaves the constructor: the reader and stores connect on use.
    return SequenceCycle(config, rpc=object(), rng=random.Random(5))


class Store:
    """The two reads a failure makes: the cycle's sequence and its count."""
    def __init__(self, failures):
        self.failures = failures

    def cycle(self, owner, cycle_id):
        return {'sequenceHash': '0x' + '11' * 32}

    def sequence(self, owner, sequence_hash):
        return {'consecutiveFailures': self.failures}


class JitterTests(unittest.TestCase):
    def test_every_wait_is_jittered_within_the_configured_share(self):
        jittered = cycle(jitterBps=2000)
        waits = [jittered._due(100) for _ in range(400)]
        self.assertTrue(all(80 <= w <= 120 for w in waits), (min(waits), max(waits)))
        self.assertGreater(len(set(waits)), 20)
        self.assertLess(min(waits), 88)
        self.assertGreater(max(waits), 112)
        self.assertEqual({jittered._due(0)}, {0})
        self.assertEqual({cycle(jitterBps=0)._due(100) for _ in range(20)}, {100})

    def test_the_default_source_of_jitter_is_the_system_generator(self):
        config = sample_automation_config()
        self.assertIsInstance(SequenceCycle(config, rpc=object()).random, random.SystemRandom)


class FailureBackoffTests(unittest.TestCase):
    def wait_after(self, failures, **scheduling):
        worker = cycle(**{'evaluationIntervalSeconds': 5, 'maximumBackoffSeconds': 60, 'failureBackoffAfter': 3, **scheduling})
        worker.store = Store(failures)
        updates = {}
        worker._fail(address(1), '00000000-0000-4000-8000-000000000000', updates)
        return updates

    def test_the_wait_doubles_per_failure_past_the_configured_count_up_to_the_maximum(self):
        self.assertEqual(self.wait_after(0), {'consecutive_failures': 1, 'next_due_seconds': 5})
        self.assertEqual(self.wait_after(1), {'consecutive_failures': 2, 'next_due_seconds': 5})
        self.assertEqual(self.wait_after(2), {'consecutive_failures': 3, 'next_due_seconds': 10})
        self.assertEqual(self.wait_after(3), {'consecutive_failures': 4, 'next_due_seconds': 20})
        self.assertEqual(self.wait_after(4), {'consecutive_failures': 5, 'next_due_seconds': 40})
        self.assertEqual(self.wait_after(5), {'consecutive_failures': 6, 'next_due_seconds': 60})
        self.assertEqual(self.wait_after(40), {'consecutive_failures': 41, 'next_due_seconds': 60})
        self.assertEqual(self.wait_after(0, failureBackoffAfter=1)['next_due_seconds'], 10)
        # A reverted execution waits the maximum whatever the count.
        worker = cycle(evaluationIntervalSeconds=5, maximumBackoffSeconds=60, failureBackoffAfter=3)
        worker.store = Store(0)
        updates = {}
        worker._fail(address(1), '00000000-0000-4000-8000-000000000000', updates, minimum=60)
        self.assertEqual(updates, {'consecutive_failures': 1, 'next_due_seconds': 60})


class Reserving:
    def __init__(self, error=None):
        self.error, self.calls = error, []

    def reserve_swap(self, owner, sequence_hash, worker, fence, **fields):
        self.calls.append(fields)
        if self.error:
            raise ExecutionStoreError(self.error)
        return {'usedPpm': fields['usage_ppm'], 'usagePpm': fields['usage_ppm']}


class ReservationTests(unittest.TestCase):
    C0, C1, POOL = address(16), address(32), identity(12)

    def reserve(self, *, amount='480', currency_in=None, caps=None, error=None):
        worker = cycle()
        worker.store = Reserving(error)
        sequence = SimpleNamespace(poolKey=SimpleNamespace(currency0=self.C0, currency1=self.C1), poolId=self.POOL)
        evaluation = SimpleNamespace(ctx=SimpleNamespace(observation=SimpleNamespace(sequence=sequence)),
                                     notes={'caps': {True: 3 * 10**6} if caps is None else caps})
        plan = SimpleNamespace(swap=SimpleNamespace(currencyIn=currency_in or self.C0, amountInRaw=amount), sourceBlockNumber='1234')
        return worker._reserve_swap(address(1), identity(11), 1, plan, evaluation, identity(40)), worker.store.calls

    def test_the_share_is_taken_at_the_plan_block_in_millionths_of_the_act_time_cap(self):
        refusal, calls = self.reserve()
        self.assertIsNone(refusal)
        self.assertEqual(calls, [{'intent_id': identity(40), 'pool_id': self.POOL, 'block_number': 1234, 'zero_for_one': True,
                                  'amount_in': 480, 'cap_raw': 3 * 10**6, 'usage_ppm': 160, 'window_blocks': 256}])
        # Selling currency1 takes the other direction's cap.
        refusal, calls = self.reserve(currency_in=self.C1, caps={False: 10**6})
        self.assertIsNone(refusal)
        self.assertEqual((calls[0]['zero_for_one'], calls[0]['usage_ppm']), (False, 480))

    def test_each_refusal_has_its_own_reason_and_nothing_is_reserved_without_a_cap(self):
        self.assertEqual(self.reserve(caps={False: 10**6}), ('swap_cap_unmeasured', []))
        self.assertEqual(self.reserve(caps={True: 0}), ('swap_cap_exhausted', []))
        self.assertEqual(self.reserve(amount=str(3 * 10**6 + 1)), ('swap_cap_exhausted', []))
        self.assertEqual(self.reserve(error='execution_swap_cap_exhausted')[0], 'swap_cap_exhausted')
        self.assertEqual(self.reserve(error='execution_stale_fence')[0], 'reserve_swap_stale_fence')


class FakeCycle:
    def __init__(self, outcomes, *, now=1000.0, interval=30):
        self.config = sample_automation_config(scheduling={'evaluationIntervalSeconds': interval},
                                               sequences=[{'owner': address(1), 'vault': address(3), 'expiresAt': 2000000000, 'suspended': False},
                                                          {'owner': address(2), 'vault': address(4), 'expiresAt': 2000000000, 'suspended': False}])
        self.outcomes, self.now, self.calls = list(outcomes), now, []
        self.finality_passes = 0
        self.finality_error = None
        self.readiness = []
        self.store = SimpleNamespace(record_readiness=lambda owner, vault, ready: self.readiness.append((owner, vault, ready)))

    def clock(self):
        return self.now

    def run(self, entry, *, respect_due):
        self.calls.append((entry.vault, respect_due))
        outcome = self.outcomes.pop(0)
        if isinstance(outcome, Exception):
            raise outcome
        return outcome

    def settle_gas(self, *, limit):
        assert limit == 8
        return {'scanned': 0, 'settled': 0, 'cancelled': 0,
                'attention': 0, 'results': []}

    def finalize_publications(self):
        self.finality_passes += 1
        if self.finality_error:
            raise self.finality_error
        return []


class ServeTests(unittest.TestCase):
    def serve(self, fake, rounds):
        sleeps, logs = [], []
        serve(fake, stop=lambda: len(sleeps) >= rounds, sleep=sleeps.append, log=logs.append)
        return sleeps, logs

    def test_the_loop_sleeps_until_the_earliest_due_sequence_within_bounds(self):
        fake = FakeCycle([{'outcome': 'wait', 'nextDueEpoch': 1012.5}, {'outcome': 'not_due', 'nextDueEpoch': 1020.0},
                          {'outcome': 'not_due', 'nextDueEpoch': 1012.5}, {'outcome': 'executing', 'nextDueEpoch': 1000.2},
                          {'outcome': 'not_due', 'nextDueEpoch': 5000.0}, {'outcome': 'not_due', 'nextDueEpoch': 4000.0}])
        sleeps, logs = self.serve(fake, 3)
        # 12.5 s to the first; then a due time 0.2 s away sleeps the one-second
        # floor; then nothing due before the interval sleeps the interval.
        self.assertEqual(sleeps, [12.5, 1.0, 30.0])
        self.assertEqual([vault for vault, _ in fake.calls], [address(3), address(4)] * 3)
        self.assertEqual(fake.finality_passes, 3)
        self.assertTrue(all(respect for _, respect in fake.calls))
        self.assertEqual(len(fake.readiness), 6)
        self.assertTrue(all(ready is False for _, _, ready in fake.readiness))
        # Sequences that were not due are not logged.
        self.assertEqual(len(logs), 2)

    def test_a_failing_sequence_is_logged_and_does_not_stop_the_others(self):
        fake = FakeCycle([CycleError('automation_sequence_not_admitted'), {'outcome': 'wait', 'nextDueEpoch': 1010.0}])
        sleeps, logs = self.serve(fake, 1)
        self.assertEqual(sleeps, [10.0])
        self.assertIn('automation_sequence_not_admitted', logs[0])
        self.assertEqual(len(logs), 2)
        self.assertEqual([ready for _, _, ready in fake.readiness], [False, False])

    def test_finality_failure_closes_every_heartbeat_for_that_pass(self):
        fake = FakeCycle([{'outcome':'wait','nextDueEpoch':1010.0}, {'outcome':'wait','nextDueEpoch':1010.0}], interval=10)
        fake.finality_error = ExecutionStoreError('execution_store_unavailable')
        sleeps, logs = self.serve(fake, 1)
        self.assertEqual(sleeps, [10.0])
        self.assertEqual([ready for _, _, ready in fake.readiness], [False, False])
        self.assertTrue(any('publication_finality' in line for line in logs))
        fake = FakeCycle([RuntimeError('boom'), RuntimeError('boom')])
        sleeps, logs = self.serve(fake, 1)
        self.assertEqual(sleeps, [30.0])
        self.assertTrue(all('automation_unavailable' in line and 'boom' not in line for line in logs))
        self.assertEqual([ready for _, _, ready in fake.readiness], [False, False])


class ReadinessTests(unittest.TestCase):
    def test_only_a_successful_live_pass_with_the_expected_signers_and_checked_infrastructure_is_ready(self):
        key = bytes.fromhex('11' * 32)  # Synthetic test key, never a deployed wallet.
        operator = Account.from_key(key).address.lower()
        publisher = address(2)
        entry = SimpleNamespace(owner=address(1), vault=address(3), expiresAt=5000, suspended=False)
        config = SimpleNamespace(paused=False, scheduling=SimpleNamespace(evaluationIntervalSeconds=10),
            operator=SimpleNamespace(policy=SimpleNamespace(enabled=True)), publisher=SimpleNamespace(enabled=True),
            deployment=SimpleNamespace(operator=operator, pricePublisher=publisher, expiresAt=5000))
        cycle = SimpleNamespace(config=config, clock=lambda: 1000, operator_key=key,
            publisher=SimpleNamespace(address=publisher),
            store=SimpleNamespace(control=lambda owner, name: False))
        clean_wait = {'outcome': 'wait', 'decision': {'observationDiagnostics': []}}
        clean_skip = {'outcome': 'not_due', 'readinessQualified': True}
        self.assertTrue(service_ready_after_pass(cycle, entry, clean_wait, True))
        self.assertTrue(service_ready_after_pass(cycle, entry, clean_skip, True))
        self.assertFalse(service_ready_after_pass(cycle, entry, {'outcome': 'wait'}, True))
        self.assertFalse(service_ready_after_pass(cycle, entry, {'outcome': 'wait', 'decision':
                         {'observationDiagnostics': ['ledger_chain_mismatch']}}, True))
        self.assertFalse(service_ready_after_pass(cycle, entry, {'outcome': 'not_due'}, True))
        self.assertFalse(service_ready_after_pass(cycle, entry, {'outcome': 'not_due', 'readinessQualified': False}, True))
        self.assertFalse(service_ready_after_pass(cycle, entry, {'outcome': 'not_due'}, False))
        self.assertFalse(service_ready_after_pass(cycle, entry, {'outcome': 'refused'}, True))
        cycle.store.control = lambda owner, name: True
        self.assertFalse(service_ready_after_pass(cycle, entry, clean_wait, True))
        cycle.store.control = lambda owner, name: False
        config.paused = True
        self.assertFalse(service_ready_after_pass(cycle, entry, clean_wait, True))
        config.paused = False
        cycle.operator_key = bytes.fromhex('22' * 32)
        self.assertFalse(service_ready_after_pass(cycle, entry, clean_wait, True))

    def test_due_skip_preserves_the_last_structural_read_state(self):
        worker = cycle()
        worker.clock = lambda: 1000
        entry = worker.config.sequences[0]
        def skip(qualified):
            worker.store = SimpleNamespace(due_state=lambda owner, vault: [
                {'sequenceHash': identity(1), 'open': False, 'nextDueEpoch': 5000,
                 'readinessQualified': qualified}])
            return worker._run(entry, act=True, respect_due=True)
        self.assertIs(skip(True)['readinessQualified'], True)
        self.assertIs(skip(False)['readinessQualified'], False)

    def test_probe_requires_live_peer_rpc_and_current_vault_admission(self):
        client = GasBudgetClient('/run/test-readiness.sock', server_uid=os.getuid())
        head = {'number': 200, 'timestamp': 2000, 'hash': '0x' + '2' * 64}
        finalized = {'number': 190, 'timestamp': 1900}
        entry = SimpleNamespace(owner=address(1), vault=address(3))
        deployment = SimpleNamespace(operator=address(2), pricePublisher=address(5), serviceFeeRecipient=address(6),
                                     priceGuard=address(7), serviceFeeBps=200, dominoServiceFeeBps=400)
        guardian = address(8)
        code = {}
        def request(method, params):
            if method == 'eth_getCode':
                self.assertEqual(params[1], {'blockHash': head['hash'], 'requireCanonical': True})
                return code.get(params[0], '0x')
            return '0x1237'
        state = {'paused': True, 'operator': address(2), 'enabled': True,
                 'rootPermission': True, 'fee': 200, 'positions': 1}
        def call(target, signature, outputs, block, *args):
            if signature == 'guardian()':
                self.assertEqual((target, block), (deployment.priceGuard, head))
                return (guardian,)
            if signature == 'policy()':
                return ((state['fee'], 0, 0, 0, state['positions'], 0, state['paused']),)
            if signature == 'operator()':
                return (state['operator'],)
            if signature == 'isOperator(address)':
                return (state['enabled'],)
            if signature == 'rootPermissionValid()':
                return (state['rootPermission'],)
            raise AssertionError(signature)
        reader = SimpleNamespace(reset=lambda: None, request=request,
                                 head=lambda: head, finalized=lambda: finalized, call=call)
        candidate = SimpleNamespace(gas_budget=client, reader=reader, clock=lambda: 2000,
                                    config=SimpleNamespace(deployment=deployment))
        with patch.object(client, 'health', return_value=True), patch('automation_cycle.derive_admission') as admitted:
            self.assertTrue(service_readiness_probe(candidate, entry))
            admitted.assert_called_with(reader, deployment, entry.owner, entry.vault, head)
            state['paused'] = False
            self.assertTrue(service_readiness_probe(candidate, entry))
            state['paused'] = True
            state['rootPermission'] = False
            self.assertFalse(service_readiness_probe(candidate, entry))
            state['rootPermission'] = True
            state['enabled'] = False
            self.assertFalse(service_readiness_probe(candidate, entry))
            state['enabled'] = True
            state['operator'] = address(4)
            self.assertFalse(service_readiness_probe(candidate, entry))
            state['operator'] = address(2)
            state['fee'] = 300
            self.assertFalse(service_readiness_probe(candidate, entry))
            state['fee'] = 200
            state['positions'] = 2
            self.assertFalse(service_readiness_probe(candidate, entry))
            state['fee'] = 400
            self.assertTrue(service_readiness_probe(candidate, entry))
            state['fee'] = 200
            state['positions'] = 1
            admitted.side_effect = RuntimeError('vault changed')
            self.assertFalse(service_readiness_probe(candidate, entry))
            admitted.side_effect = None
            reader.finalized = lambda: (_ for _ in ()).throw(RuntimeError('finalized unavailable'))
            self.assertFalse(service_readiness_probe(candidate, entry))
            reader.finalized = lambda: {'number': 201, 'timestamp': 1900}
            self.assertFalse(service_readiness_probe(candidate, entry))
            reader.finalized = lambda: finalized
            finalized['timestamp'] = 199
            self.assertFalse(service_readiness_probe(candidate, entry))
            finalized['timestamp'] = 200
            self.assertTrue(service_readiness_probe(candidate, entry))
            finalized['timestamp'] = 1900
            # A role key carrying code (an EIP-7702 designator) is not ready,
            # whichever of the four it is, the guardian as the guard names it;
            # a vault's own code is never read.
            for role in (deployment.operator, deployment.pricePublisher, deployment.serviceFeeRecipient, guardian):
                code[role] = '0xef0100' + 'ab' * 20
                self.assertFalse(service_readiness_probe(candidate, entry))
                code.clear()
            self.assertTrue(service_readiness_probe(candidate, entry))
            reader.request = lambda method, params: '0x1'
            self.assertFalse(service_readiness_probe(candidate, entry))
            reader.request = request
            head['timestamp'] = 800
            self.assertFalse(service_readiness_probe(candidate, entry))
            head['timestamp'] = 2000
        with patch.object(client, 'health', return_value=False):
            self.assertFalse(service_readiness_probe(candidate, entry))


if __name__ == '__main__':
    unittest.main()
