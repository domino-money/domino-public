"""When a v3 pool's own TWAP anchors a V2 vault, and when the publisher signs the price instead (v2_oracle; the owner's
decision of 5 Oct 2026): the ring's bound per chain, the guarantee read from the pool, and the pass's choice for
compounds and exits."""
from dataclasses import replace
from decimal import Decimal
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))
from eth_abi import encode
from eth_hash.auto import keccak

from discovery import Block, DataError
import v2_automation as automation
from v2_automation import ChainAutomation
from v2_autoexit import ModuleParameters
from v2_chains import chain as profile
from v2_manifest import checked_deployment
from v2_observation import PublisherPolicy
from v2_oracle import cardinality_for, timestamp_spacing, twap_guaranteed
from v2_plan import twap_evidence
from v2_planner import PlannerConfig
from v2_uniswap import PoolRef, v3_pool_address
from test_v2_manifest import manifest_document
from test_v2_planner import member, vault_state

BASE, ROBINHOOD, ARBITRUM = profile('base-8453'), profile('robinhood-4663'), profile('arbitrum-42161')
WETH, USDC = '0x4200000000000000000000000000000000000006', '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'
POOL = PoolRef(3, WETH, USDC, 500, 10)
ADDRESS = v3_pool_address(BASE, WETH, USDC, 500)
BLOCK = Block(100, '0x' + 'ab' * 32, 1_790_000_000)


def selector(signature):
    return '0x' + keccak(signature.encode())[:4].hex()


class ChainBoundTests(unittest.TestCase):
    def test_nitro_writes_once_a_second_and_base_once_a_block(self):
        self.assertEqual([timestamp_spacing(c) for c in (ROBINHOOD, ARBITRUM, BASE)], [1, 1, 2])
        # The compound's 300 s and the exit's 600 s windows, and the slot at or before the window's start.
        self.assertEqual([cardinality_for(c, 300) for c in (ROBINHOOD, ARBITRUM, BASE)], [301, 301, 151])
        self.assertEqual([cardinality_for(c, 600) for c in (ROBINHOOD, ARBITRUM, BASE)], [601, 601, 301])
        # A window that is no multiple of the block time rounds up, never down.
        self.assertEqual(cardinality_for(BASE, 601), 302)
        self.assertEqual(cardinality_for(BASE, 1), 2)
        self.assertEqual(cardinality_for(ROBINHOOD, 100_000), 65535)  # the pool's own ceiling

    def test_the_stack_decides_how_close_two_timestamps_are(self):
        # A Nitro chain writes once a second however slow its blocks; an OP Stack chain once a block, at least a second.
        slow_nitro = ROBINHOOD.model_copy(update={'blockTimeSeconds': Decimal('2')})
        fast_op = BASE.model_copy(update={'blockTimeSeconds': Decimal('0.5')})
        self.assertEqual((timestamp_spacing(slow_nitro), cardinality_for(slow_nitro, 600)), (1, 601))
        self.assertEqual((timestamp_spacing(fast_op), cardinality_for(fast_op, 600)), (1, 601))

    def test_a_window_that_is_no_window_is_refused(self):
        for window in (0, -1, 300.0, True, '300'):
            with self.subTest(window=window), self.assertRaisesRegex(DataError, '^v2_twap_window_unavailable$'):
                cardinality_for(BASE, window)


class GuaranteeTests(unittest.TestCase):
    class Rpc:
        """A pool's slot0 and observation slots, through eth_call."""
        call_gas_limit = 10**7

        def __init__(self, slot0, observations):
            self.slot0, self.observations, self.calls = slot0, observations, []

        def request(self, method, params):
            call, tag = params
            self.calls.append(call['data'][:10])
            if method != 'eth_call' or call['to'] != ADDRESS or tag != BLOCK.tag:
                raise AssertionError((method, params))
            if call['data'] == selector('slot0()'):
                return '0x' + encode(['uint160', 'int24', 'uint16', 'uint16', 'uint16', 'uint8', 'bool'],
                                     [2**96, 0, *self.slot0, 0, True]).hex()
            ts, initialized = self.observations.get(int(call['data'][10:], 16), (0, False))
            return '0x' + encode(['uint32', 'int56', 'uint160', 'bool'], [ts, 0, 0, initialized]).hex()

    def holds(self, slot0, observations, window=300):
        rpc = self.Rpc(slot0, observations)
        return twap_guaranteed(rpc, BASE, POOL, window, BLOCK), rpc.calls

    def test_a_full_ring_of_the_bound_covering_the_window_holds(self):
        # Base, 300 s: 151 slots. The oldest is the slot after the newest.
        now = BLOCK.timestamp
        ring = {6: (now - 300, True), 0: (now - 900, True), 5: (now - 2, True)}
        reads = [selector('slot0()')] + [selector('observations(uint256)')] * 2
        self.assertEqual(self.holds((5, 151, 151), ring), (True, reads))
        self.assertEqual(self.holds((5, 151, 151), {**ring, 6: (now - 299, True)})[0], False)  # one second short
        self.assertEqual(self.holds((5, 151, 151), ring, window=600)[0], False)  # 600 s needs 301 slots on Base

    def test_a_ring_still_filling_reaches_back_to_slot_zero(self):
        # The slots after the newest were paid for (blockTimestamp 1) but never written.
        now = BLOCK.timestamp
        self.assertEqual(self.holds((3, 400, 400), {4: (1, False), 0: (now - 300, True)})[0], True)
        self.assertEqual(self.holds((3, 400, 400), {4: (1, False), 0: (now - 250, True)})[0], False)

    def test_a_smaller_ring_never_holds_and_costs_one_read(self):
        # Even covered now: its next writes could push the window's start out before inclusion.
        now = BLOCK.timestamp
        self.assertEqual(self.holds((0, 1, 1), {0: (now - 10_000, True)}), (False, [selector('slot0()')]))
        self.assertEqual(self.holds((5, 150, 400), {6: (now - 10_000, True)}), (False, [selector('slot0()')]))

    def test_a_ring_that_is_no_ring_is_refused(self):
        now = BLOCK.timestamp
        cases = {'no slot': ((0, 0, 0), {0: (now, True)}),
                 'an index past the ring': ((151, 151, 151), {0: (now - 400, True)}),
                 'no observation at all': ((0, 200, 200), {}),
                 'an observation from the future': ((0, 200, 200), {1: (now + 1, True)})}
        for label, (slot0, observations) in cases.items():
            with self.subTest(label), self.assertRaisesRegex(DataError, '^v2_oracle_state_invalid$'):
                self.holds(slot0, observations)


# ----------------------------------------------------------------------------- the pass
class Signed:
    def __init__(self, valid_until):
        self.observation = type('Observation', (), {'valid_until': valid_until})()

    def evidence(self):
        return b'signed'


class FakePublisher:
    def __init__(self):
        self.calls = []

    def observe(self, pool, block, *, max_age_seconds):
        self.calls.append((pool, block, max_age_seconds))
        return Signed(block.timestamp + 90)


class PassTests(unittest.TestCase):
    """The pass's choice of anchor, with the chain's reads scripted: whether the pool holds the window
    (twap_guaranteed), the TWAP (twap_price), the anchor's minimum window."""

    HEAD = type('Head', (), {'block': BLOCK, 'base_fee_per_gas': 10**8})()

    def setUp(self):
        self.guaranteed, self.checks, self.twaps = {}, [], []
        patches = [patch.object(automation, 'twap_guaranteed', self.twap_guaranteed),
                   patch.object(automation, 'twap_price', self.twap_price),
                   patch.object(automation, 'anchor_min_twap', lambda rpc, deployment, block: 60)]
        for item in patches:
            item.start()
            self.addCleanup(item.stop)

    def twap_guaranteed(self, rpc, chain, pool, window, block):
        self.checks.append((v3_pool_address(chain, pool.currency0, pool.currency1, pool.fee), window))
        return self.guaranteed.get(window, False)

    def twap_price(self, rpc, deployment, pool, window, block):
        self.twaps.append(window)
        return 2**96 + window

    def service(self, **changes):
        options = dict(chain=BASE, deployment=checked_deployment(manifest_document(), BASE), endpoints=None,
                       follower=None, planner=PlannerConfig(), observations=PublisherPolicy(), price_references=(),
                       earnings_window_seconds=600, twap_seconds=300, exit_twap_seconds=600, deadline_seconds=120)
        options.update(changes)
        service = ChainAutomation(**options)
        service._pass = {'references': None, 'growth': {}, 'min_twap': None, 'oracles': {}}
        return service

    # -------------------------------------------------------- compounds
    def test_a_v3_pool_that_holds_the_window_anchors_on_its_twap(self):
        self.guaranteed = {300: True}
        service = self.service()
        vault = vault_state(member(), pool=POOL)
        anchor, evidence, planner, source = service._anchor(vault, None, BLOCK)
        self.assertEqual((anchor, evidence, planner, source),
                         (2**96 + 300, twap_evidence(300), service.planner, 'twap'))
        self.assertEqual((self.checks, self.twaps), ([(ADDRESS, 300)], [300]))

    def test_otherwise_the_publisher_signs_its_spot_with_no_drift(self):
        service = self.service()
        vault = vault_state(member(), pool=POOL)
        anchor, evidence, planner, source = service._anchor(vault, None, BLOCK)
        self.assertEqual((anchor, evidence, source), (vault.pool.sqrt_price_x96, None, 'signed'))
        self.assertEqual(planner, replace(service.planner, twap_drift_bps=0))
        self.assertEqual(service.planner.twap_drift_bps, 10)  # the TWAP keeps its own
        self.assertEqual(self.twaps, [])

    def test_a_vault_whose_observations_are_younger_than_any_twap_is_signed(self):
        # The vault admits observations 30 s old; the anchor takes no TWAP under 60 s.
        service = self.service()
        vault = vault_state(member(), pool=POOL, limits=replace(vault_state().limits, max_observation_age_seconds=30))
        self.assertEqual(service._anchor(vault, None, BLOCK)[3], 'signed')
        self.assertEqual(self.checks, [])

    def test_a_v4_vault_is_unchanged(self):
        service = self.service()
        vault = vault_state(member())
        self.assertEqual(service._anchor(vault, None, BLOCK), (vault.pool.sqrt_price_x96, None, service.planner, None))
        self.assertEqual(self.checks, [])

    def test_the_compound_says_where_its_anchor_came_from(self):
        service = self.service()
        vault = vault_state(member(), pool=POOL)
        reader = type('Reader', (), {'__init__': lambda self, *args, **kwargs: None,
                                     'read': lambda _, record, block: vault})
        record = type('Record', (), {'vault': vault.vault, 'dex': 3})()
        seen = []

        def decide(vault_, anchor, prices, gas, config, **kwargs):
            seen.append((anchor, config.twap_drift_bps))
            return type('Decision', (), {'act': False, 'reason': 'gas_not_covered', 'considered': ()})()
        with patch.object(automation, 'VaultReader', reader), patch.object(automation, 'decide', decide), \
                patch.object(automation, 'reference_prices', lambda *args: {WETH: 1}):
            entry = service._compound(record, self.HEAD, None, None, None, None)
            self.assertEqual((entry['reason'], entry['anchorSource']), ('gas_not_covered', 'signed'))
            self.assertEqual(seen, [(vault.pool.sqrt_price_x96, 0)])
            self.guaranteed = {300: True}
            service._pass['oracles'] = {}
            entry = service._compound(record, self.HEAD, None, None, None, None)
            self.assertEqual(entry['anchorSource'], 'twap')
            self.assertEqual(seen[-1], (2**96 + 300, 10))

    # ------------------------------------------------------------ cache
    def test_a_pool_is_read_once_a_pass_until_it_holds_and_never_after(self):
        service = self.service()
        self.assertFalse(service._twap_holds(None, POOL, 300, BLOCK))
        self.assertFalse(service._twap_holds(None, POOL, 300, BLOCK))
        self.assertEqual(self.checks, [(ADDRESS, 300)])  # once a pass
        service._pass['oracles'] = {}
        self.guaranteed = {600: True}
        self.assertTrue(service._twap_holds(None, POOL, 600, BLOCK))
        self.assertEqual(service.twap_ready, {ADDRESS: 600})
        service._pass['oracles'] = {}
        self.assertTrue(service._twap_holds(None, POOL, 600, BLOCK))
        self.assertTrue(service._twap_holds(None, POOL, 300, BLOCK))  # a narrower window holds too
        self.assertEqual(self.checks, [(ADDRESS, 300), (ADDRESS, 600)])
        self.assertFalse(service._twap_holds(None, POOL, 900, BLOCK))  # a wider one is read
        self.assertEqual(self.checks[-1], (ADDRESS, 900))

    # ------------------------------------------------------------ exits
    def exit(self, *, triggered=True, publisher=None, executor=None, registered_ago=10**6, **changes):
        """One active mandate on a v3 pool, registered `registered_ago` seconds before the head, through the real
        _exits, with plan_exit scripted. self.asked: the mandates whose registration time the pass asked for."""
        service = self.service(executor=executor, **changes)
        deployment = service.deployment
        mandate = type('Mandate', (), {'hash': '0x' + '0e' * 32, 'vault': '0x' + 'aa' * 20, 'token_id': 7,
                                       'status': 1, 'valid_until': BLOCK.timestamp + 10**6, 'owner': '0x' + 'bb' * 20,
                                       'triggered': lambda _, anchor: triggered})()
        self.asked = []

        def registered_at(_, index, mandate_hash):
            self.asked.append(mandate_hash)
            return BLOCK.timestamp - registered_ago
        service.mandates = type('Watcher', (), {'scan': lambda _, index, block: [mandate.hash],
                                                'registered_at': registered_at})()
        service.index = None
        spot = 2**96 - 5
        position = type('Position', (), {'pool': type('State', (), {'sqrt_price_x96': spot})()})()
        uniswap = type('Uniswap', (), {'position': lambda _, ref, block: position})()
        planned = []

        def plan_exit(mandate_, pool, position_, anchor, evidence, deadline):
            planned.append((anchor, evidence, deadline))
            return None
        with patch.object(automation, 'module_parameters', lambda rpc, d, block: ModuleParameters(300, 600)), \
                patch.object(automation, 'read_mandates', lambda rpc, d, hashes, block: [mandate]), \
                patch.object(automation, 'vault_facts', lambda rpc, m, block: (deployment.auto_exit, m.owner, POOL)), \
                patch.object(automation, 'plan_exit', plan_exit):
            entry, = service._exits(self.HEAD, None, uniswap, publisher)
        return entry, planned, spot

    def test_an_exit_on_a_pool_that_holds_the_modules_window_reads_the_twap(self):
        self.guaranteed = {600: True}
        publisher = FakePublisher()
        entry, planned, _ = self.exit(publisher=publisher)
        self.assertEqual(planned, [(2**96 + 600, twap_evidence(600), BLOCK.timestamp + 120)])
        self.assertEqual((entry['anchorSource'], publisher.calls, self.checks), ('twap', [], [(ADDRESS, 600)]))

    def test_otherwise_the_exit_fires_on_the_signed_spot(self):
        publisher = FakePublisher()
        entry, planned, spot = self.exit(publisher=publisher)
        self.assertEqual(planned, [(spot, b'signed', BLOCK.timestamp + 90)])
        self.assertEqual(publisher.calls, [(POOL, BLOCK, 300)])  # valid at most the module's age
        self.assertEqual(entry['anchorSource'], 'signed')
        self.assertEqual(self.twaps, [])

    def test_a_signed_exit_not_triggered_signs_nothing_and_keyless_reports(self):
        publisher = FakePublisher()
        entry, planned, _ = self.exit(publisher=publisher, triggered=False)
        self.assertEqual((entry['reason'], planned, publisher.calls), ('trigger_not_reached', [], []))
        entry, _, _ = self.exit(publisher=None)
        self.assertEqual((entry['act'], entry['reason'], entry['anchorSource']), (True, 'triggered_keyless', 'signed'))

    # ----------------------------------------------- exits and the registration
    def test_an_exit_never_fires_on_a_twap_that_reaches_back_before_its_mandate(self):
        # The pool holds the module's 600 s window, but the owner turned Auto-exit on 100 s ago: a TWAP would
        # average 500 s of prices from before, so the publisher signs the spot, exactly as for a pool without the
        # ring (valid at most the module's age).
        self.guaranteed = {600: True}
        publisher = FakePublisher()
        entry, planned, spot = self.exit(publisher=publisher, registered_ago=100)
        self.assertEqual(planned, [(spot, b'signed', BLOCK.timestamp + 90)])
        self.assertEqual((entry['anchorSource'], publisher.calls, self.twaps), ('signed', [(POOL, BLOCK, 300)], []))
        self.assertEqual(self.asked, ['0x' + '0e' * 32])
        # 700 s on, the whole window lies after the registration: the module's TWAP.
        publisher = FakePublisher()
        entry, planned, _ = self.exit(publisher=publisher, registered_ago=700)
        self.assertEqual(planned, [(2**96 + 600, twap_evidence(600), BLOCK.timestamp + 120)])
        self.assertEqual((entry['anchorSource'], publisher.calls), ('twap', []))

    def test_the_window_may_start_at_the_registration_and_not_a_second_before(self):
        # A TWAP ending at inclusion, later than the head, starts later still: what clears the registration at the
        # head clears it then.
        self.guaranteed = {600: True}
        for ago, source in ((599, 'signed'), (600, 'twap'), (601, 'twap')):
            with self.subTest(ago=ago):
                entry, _, _ = self.exit(publisher=FakePublisher(), registered_ago=ago)
                self.assertEqual(entry['anchorSource'], source)

    def test_the_registration_is_held_against_the_exits_own_window(self):
        # A preferred window of 900 s: 700 s after the registration still reaches back before it.
        self.guaranteed = {900: True}
        for ago, source in ((700, 'signed'), (899, 'signed'), (900, 'twap')):
            with self.subTest(ago=ago):
                entry, _, _ = self.exit(publisher=FakePublisher(), registered_ago=ago, exit_twap_seconds=900)
                self.assertEqual(entry['anchorSource'], source)
        self.assertEqual(self.checks[-1], (ADDRESS, 900))

    def test_a_pool_without_the_ring_never_asks_when_the_mandate_was_registered(self):
        # The signed spot either way: the registration's block header is not read (a billed call).
        entry, _, _ = self.exit(publisher=FakePublisher(), registered_ago=100)
        self.assertEqual((entry['anchorSource'], self.asked), ('signed', []))


if __name__ == '__main__':
    unittest.main()
