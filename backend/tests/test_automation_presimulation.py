"""A plan is simulated with its publication before either is paid for."""
from pathlib import Path
import sys
from types import SimpleNamespace
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))
from eth_hash.auto import keccak

import test_automation_plan as fixtures
from automation_cycle import SequenceCycle, simulation_refusal
from automation_plan import build_execution_plan, checkpoints_for, observation_id, observation_point, publish_calldata
from automation_store import _reason
from execution_v4 import CONTRACT_ERRORS
from execution_v4_adapter import rebuild_v4

OK = {'status': '0x1', 'returnData': '0x', 'gasUsed': '0xeb6ce'}


def failed(data, *, code=-32000, message='execution reverted'):
    return {'status': '0x0', 'returnData': '0x', 'gasUsed': '0x98f20', 'error': {'code': code, 'message': message, 'data': data}}


def selector(signature):
    return '0x' + keccak(signature.encode())[:4].hex()


class SimulationRefusalTests(unittest.TestCase):
    def test_a_publication_and_execution_that_both_succeed_refuse_nothing(self):
        self.assertIsNone(simulation_refusal(OK, OK))

    def test_a_reverted_execution_is_named_by_the_contract_error(self):
        # The node's reply for the 14:25 UTC plan of 27 September 2026, simulated
        # with its publication on archive state: the engine refused it.
        nitro = {'returnData': '0x', 'gasUsed': '0x98f20', 'status': '0x0',
                 'error': {'message': 'execution reverted', 'code': -32000, 'data': '0x2c5211c6'}}
        self.assertEqual(simulation_refusal(OK, nitro), 'presimulate_v4_call_reverted_invalid_amount')
        self.assertEqual(simulation_refusal(OK, failed('0x2c5211c6', code=3, message='')),
                         'presimulate_v4_call_reverted_invalid_amount')
        # Anvil's reply: the revert data in returnData, the error only "execution failed".
        anvil = {'returnData': '0x2c5211c6', 'gasUsed': '0x116c52', 'status': '0x0',
                 'error': {'code': -3200, 'message': 'execution failed'}}
        self.assertEqual(simulation_refusal(OK, anvil), 'presimulate_v4_call_reverted_invalid_amount')
        # Revert data only in returnData, or none at all.
        self.assertEqual(simulation_refusal(OK, {'status': '0x0', 'returnData': '0x2C5211C6',
                                                 'error': {'message': 'execution reverted'}}),
                         'presimulate_v4_call_reverted_invalid_amount')
        self.assertEqual(simulation_refusal(OK, failed('0x')), 'presimulate_v4_call_reverted_empty')
        self.assertEqual(simulation_refusal(OK, failed('0x12345678')), 'presimulate_v4_call_reverted_0x12345678')
        # A failure that is no revert, such as running out of gas.
        self.assertEqual(simulation_refusal(OK, failed('0x', code=-32015, message='out of gas')), 'presimulate_v4_call_failed')

    def test_a_refused_publication_is_named_before_its_execution_is_read(self):
        self.assertEqual(simulation_refusal(failed(selector('InvalidObservation()')), OK),
                         'presimulate_publication_v4_call_reverted_invalid_observation')
        self.assertEqual(simulation_refusal(failed(selector('Unauthorized()')), {'status': 'unread'}),
                         'presimulate_publication_v4_call_reverted_unauthorized')

    def test_every_refusal_is_a_reason_a_cycle_can_record(self):
        # The cycle store keeps reasons in [a-z0-9_] of at most 100 characters.
        for error in (*CONTRACT_ERRORS, 'Foreign()'):
            for publication, execution in ((failed(selector(error)), OK), (OK, failed(selector(error)))):
                refusal = simulation_refusal(publication, execution)
                with self.subTest(refusal=refusal):
                    self.assertEqual(_reason(refusal), refusal)
        for refusal in (simulation_refusal(OK, failed('0x')), simulation_refusal(OK, failed('0x', code=-32015, message='out of gas'))):
            self.assertEqual(_reason(refusal), refusal)

    def test_an_unreadable_reply_is_no_verdict(self):
        for publication, execution in ((None, OK), (OK, {}), (OK, {'status': '0x2'}), (OK, {'status': 1}),
                                       (OK, failed('0xzz')), (OK, failed('0x2c5')), (OK, failed(7))):
            with self.subTest(publication=publication, execution=execution), self.assertRaises(ValueError):
                simulation_refusal(publication, execution)


class SimulationRequestTests(unittest.TestCase):
    def setUp(self):
        obs, hist, cfg = fixtures.v4_setup()
        _, candidate = fixtures.chosen(obs, hist, cfg, fixtures.tp.evidence(obs, cfg))
        self.obs, self.ctx = obs, fixtures.context(obs)
        self.plan = build_execution_plan(self.ctx, candidate, plan_policy=fixtures.EXACT, gas_cap_wei=10**14)
        self.point = observation_point(self.ctx, self.plan)
        self.guard = '0x' + '23' * 20
        self.anchor = observation_id(self.guard, self.point)
        self.sent = []
        self.reply = [{'calls': [OK, OK]}]
        test = self

        class Node:
            def request(self, method, params):
                test.sent.append((method, params))
                if method == 'eth_getBlockByNumber':
                    return {'number': '0x64', 'hash': '0x' + 'ab' * 32, 'timestamp': hex(1700000100)}
                return test.reply
        self.cycle = object.__new__(SequenceCycle)
        self.cycle.rpc, self.cycle.clock = Node(), lambda: 0.25
        self.cycle.publisher = SimpleNamespace(address='0x' + '44' * 20, policy=SimpleNamespace(max_gas=400000))
        self.cycle.config = SimpleNamespace(deployment=SimpleNamespace(operator='0x' + '55' * 20),
                                            operator=SimpleNamespace(policy=SimpleNamespace(max_gas=8000000)))

    def simulate(self, latency):
        admission = SimpleNamespace(priceGuard=self.guard, sequence=self.obs.sequence)
        return self.cycle._presimulate(admission, SimpleNamespace(ctx=self.ctx), self.plan, self.point, self.anchor, latency, 0)

    def test_the_publication_then_the_execution_one_second_past_the_head(self):
        latency = {}
        self.assertIsNone(self.simulate(latency))
        self.assertEqual([method for method, _ in self.sent], ['eth_getBlockByNumber', 'eth_simulateV1'])
        request, base = self.sent[1][1]
        self.assertEqual(base, '0x' + 'ab' * 32)
        block, = request['blockStateCalls']
        # The node's own default is twelve seconds past its head, not the next 100 ms block.
        self.assertEqual(block['blockOverrides'], {'time': hex(1700000101)})
        execute = rebuild_v4(self.plan, self.obs, checkpoints_for(self.ctx, self.plan), price_observation_id=self.anchor).calldata()
        self.assertEqual(block['calls'], [
            {'from': '0x' + '44' * 20, 'to': self.guard, 'data': publish_calldata(self.point), 'gas': hex(400000)},
            {'from': '0x' + '55' * 20, 'to': self.obs.sequence.vault, 'data': execute, 'gas': hex(8000000)}])
        self.assertEqual(latency, {'simulatedMs': 250, 'simulatedExecutionGas': int(OK['gasUsed'], 16)})

    def test_a_refusal_is_returned_and_an_unreadable_node_leaves_no_verdict(self):
        self.reply = [{'calls': [OK, failed('0x2c5211c6')]}]
        latency = {}
        self.assertEqual(self.simulate(latency), 'presimulate_v4_call_reverted_invalid_amount')
        self.assertEqual(latency, {'simulatedMs': 250})
        for reply in ([], [{'calls': [OK]}], {'calls': []}, None):
            self.reply, latency = reply, {}
            with self.subTest(reply=reply):
                self.assertIsNone(self.simulate(latency))
                self.assertEqual(latency, {'simulation': 'unavailable'})


if __name__ == '__main__':
    unittest.main()
