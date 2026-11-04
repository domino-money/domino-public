"""What a plan costs in calls and connections (launch round P2, 3 Nov 2026).

The recorded scenarios (position_plan_contract_fixtures) are the planner's exact
JSON-RPC traffic, replayed in order: a plan that asks one call more or fewer
than counted here fails, and its answer is the committed export's
(test_position_plan_contract), so a call cut here never moved a plan.
EVM journeys count what the recordings cannot: a plan rebuilt from what its
simulated call delivered, and the Trading API's calls per leg
(test_v2_position_plan_evm).
"""
from pathlib import Path
import sys
from types import SimpleNamespace
import unittest
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))
from position_plan_contract_fixtures import CLIENT, CSRF, SESSION, recordings, replay_service  # noqa: E402
import v2_chain_reads  # noqa: E402
import v2_rpc  # noqa: E402
from v2_position_plan_api import build_planners  # noqa: E402

# (round trips, JSON-RPC calls) of each recorded plan, the head's read included: the service reads it from the
# chain's follower, shared for 2 s. Before 3 Nov 2026 create-split-v4 made (10, 11): each of its legs was quoted again
# at the amount its probe had priced.
CALLS = {
    'change-range-direct': (9, 16),
    'create-native-direct': (9, 10),
    'create-new-pool-direct': (9, 10),
    'create-permit2': (8, 9),
    'create-robinhood-direct': (10, 11),
    'create-split-v4': (8, 9),
    'exit-converted-direct': (9, 16),
    'exit-relayed': (7, 14),
    'increase-direct': (9, 16),
}


class PlanCallTests(unittest.TestCase):
    def test_each_recorded_plan_makes_exactly_its_counted_calls(self):
        data = recordings()
        self.assertEqual(sorted(data['scenarios']), sorted(CALLS))
        for name, (trips, calls) in CALLS.items():
            with self.subTest(name=name):
                service, request, replay = replay_service(name, data)
                service.execute('plan', request, client=CLIENT, session=SESSION, csrf=CSRF)
                asked = replay.exchanges[:replay.index]
                self.assertEqual(replay.index, len(replay.exchanges))
                self.assertEqual((len(asked), sum(len(e['request']) if isinstance(e['request'], list) else 1
                                                  for e in asked)), (trips, calls))


class KeptConnectionTests(unittest.TestCase):
    def test_every_chain_plans_over_kept_connections(self):
        # 3 Nov 2026: a new TLS handshake for each of a plan's calls tripled a hosted round trip from the VM.
        built = []

        def recording(chain, **kwargs):
            built.append((chain.chainId, kwargs.get('send')))
            endpoint = v2_rpc.Endpoint('stack', 'stack.example.invalid', 'https://stack.example.invalid/k', None, 50,
                                       None, None)
            return v2_rpc.ChainEndpoints(chain, (endpoint,), 'test')
        chains = ('robinhood-4663', 'base-8453', 'arbitrum-42161')
        settings = SimpleNamespace(chains=chains, manifests={key: f'/manifests/{key}.json' for key in chains},
                                   uniswap_api_key=None, chain_rpc_file=None, head_directory=None)
        with mock.patch('v2_rpc.configured_endpoints', side_effect=recording), \
                mock.patch('v2_position_plan_config.load_chain_deployment',
                           side_effect=lambda path, chain: SimpleNamespace(chain=chain)):
            planners = build_planners(settings, provider_config={'any': 'provider file'})
        self.assertEqual(sorted(planners), [4663, 8453, 42161])
        self.assertEqual(built, [(4663, v2_chain_reads.kept_rpc), (8453, v2_chain_reads.kept_rpc),
                                 (42161, v2_chain_reads.kept_rpc)])


if __name__ == '__main__':
    unittest.main()
