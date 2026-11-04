"""The read path's capacity: bounded provider lanes and a wallet inventory reused while fresh."""
import inspect
from pathlib import Path
import sys
import threading
import time
from types import SimpleNamespace
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))
import authenticated_api
import read_api
import read_gateway
import read_service as rs
import session_api
from discovery import CHAIN_ID, DataError
from inventory import AlchemyInventory
from read_api import PROVIDER_CAPACITY, ReadGate, public_gate
from read_deadline import read_deadline
from read_gateway import Gateway
from test_discovery import BLOCK, FakeRpc, OTHER, OWNER, TOKEN
from test_inventory import URL, page

THIRD = '0x' + '5a' * 20


class AnyWalletRpc(FakeRpc):
    """The chain as the discovery tests model it, for whichever wallet asks, its head as fresh as the clock."""
    def __init__(self, now):
        super().__init__()
        self.now = now

    def request(self, method, params=()):
        if method == 'eth_getBalance':
            return '0x0'
        if method == 'eth_getBlockByNumber':
            return {**BLOCK, 'timestamp': hex(self.now[0] - 10)}
        return super().request(method, params)

    def call(self, target, signature, inputs=(), values=(), outputs=(), *, block):
        if signature == 'balanceOf(address)':
            return (2**255 + 123,)
        return super().call(target, signature, inputs, values, outputs, block=block)


class ProviderLaneTests(unittest.TestCase):
    def test_the_provider_lane_admits_its_capacity_and_refuses_the_next(self):
        gate = ReadGate(interval=0, provider_capacity=3)
        self.assertTrue(all(gate.enter() for _ in range(3)))
        self.assertFalse(gate.enter())
        self.assertEqual(gate.retry_after(), ReadGate.MIN_RETRY_AFTER)
        self.assertIsNotNone(gate.held[gate.PROVIDER])
        gate.leave()
        self.assertTrue(gate.enter())
        # The lane stays marked taken until its last read leaves.
        for remaining in (2, 1, 0):
            gate.leave()
            self.assertEqual((gate.provider_inflight, gate.held[gate.PROVIDER] is None), (remaining, remaining == 0))
        # The stored lane is its own: a full provider lane never refuses it.
        self.assertTrue(all(gate.enter() for _ in range(3)))
        self.assertTrue(gate.enter(gate.STORED))

    def test_a_slot_taken_without_enter_is_released_uncounted(self):
        gate = ReadGate(interval=0, provider_capacity=2)
        self.assertTrue(gate.enter())
        self.assertTrue(gate.slot.acquire(blocking=False))  # the development gateway's control read
        gate.leave()
        gate.leave()
        self.assertEqual(gate.provider_inflight, 0)
        self.assertTrue(gate.enter() and gate.enter())

    def test_the_default_lane_is_the_one_it_always_was(self):
        ticks = [0.0]
        gate = ReadGate(interval=1, clock=lambda: ticks[0])
        self.assertEqual(gate.provider_capacity, 1)
        self.assertTrue(gate.enter())
        self.assertFalse(gate.enter())
        gate.leave()
        self.assertFalse(gate.enter())  # the start interval
        ticks[0] = 1.0
        self.assertTrue(gate.enter())

    def test_the_capacity_is_bounded(self):
        for value in (0, 17, 2.0, True, None):
            with self.subTest(value=value), self.assertRaisesRegex(ValueError, 'invalid_provider_capacity'):
                ReadGate(provider_capacity=value)
        self.assertEqual(ReadGate(provider_capacity=16).provider_capacity, 16)

    def test_the_public_reader_and_gateway_admit_sixteen_reads_at_once(self):
        gate = public_gate()
        self.assertEqual(PROVIDER_CAPACITY, 16)
        self.assertEqual((gate.provider_capacity, gate.interval, gate.stored_capacity, gate.stored_interval), (16, 0, 8, 0))
        self.assertTrue(all(gate.enter() for _ in range(16)))
        self.assertFalse(gate.enter())
        # The gateway in front of the reader has the same lanes; a gateway serving no stored route keeps the old one.
        v3 = sorted(read_api.V3_REQUEST_MODELS)[:1]
        self.assertEqual(Gateway(verifier=object(), enabled_v3=True, enabled_v3_reads=v3).gate.provider_capacity, 16)
        self.assertEqual(Gateway(verifier=object(), enabled_v5=True, enabled_v5_reads=['featured-pools']).gate.provider_capacity, 16)
        self.assertEqual(Gateway().gate.provider_capacity, 1)
        # The reader uses the public lanes exactly when it serves public data.
        made = []
        with patch.object(read_api, 'public_gate', lambda: made.append(True) or ReadGate()):
            for public_data in (None, SimpleNamespace(repository=None)):
                read_api.create_app(SimpleNamespace(public_data=public_data))
        self.assertEqual(made, [True])

    def test_uvicorn_admits_more_connections_than_the_gate_so_the_gate_refuses_in_json(self):
        gate = public_gate()
        self.assertEqual(read_api.CONNECTION_LIMIT, 64)
        # The lanes, and as many stored reads waiting for one as the stored lane has slots.
        self.assertGreater(read_api.CONNECTION_LIMIT, gate.provider_capacity + 2 * gate.stored_capacity + 1)
        for module in (read_api, read_gateway):
            self.assertIn('limit_concurrency=CONNECTION_LIMIT', inspect.getsource(module.main))

    def test_the_session_services_take_eight_requests_at_once(self):
        self.assertEqual((authenticated_api.MAX_WORKERS, session_api.MAX_WORKERS), (8, 8))


class StoredLaneWaitTests(unittest.TestCase):
    """3 Nov 2026 (launch): a stored read waits about a second for a stored lane; the provider lane never waits."""

    def enter_in_thread(self, gate, kind=ReadGate.STORED):
        # The reader's worker threads wait; a wait the gate failed to bound would hang the test, not pass it.
        outcome = []
        thread = threading.Thread(target=lambda: outcome.append((gate.enter(kind), time.monotonic())), daemon=True)
        started = time.monotonic()
        thread.start()
        return thread, outcome, started

    def until(self, condition, seconds=2):
        deadline = time.monotonic() + seconds
        while not condition():
            self.assertLess(time.monotonic(), deadline, 'condition never held')
            time.sleep(0.005)

    def test_the_public_lanes_wait_about_a_second_and_others_not_at_all(self):
        self.assertEqual((read_api.STORED_WAIT_SECONDS, public_gate().stored_wait), (1, 1))
        gate = ReadGate()
        self.assertTrue(gate.enter(gate.STORED))
        started = time.monotonic()
        self.assertFalse(gate.enter(gate.STORED))
        self.assertLess(time.monotonic() - started, 0.5, 'the development lane still refuses at once')
        for value in (-1, 5.5, float('nan'), float('inf'), True, '1', None):
            with self.subTest(value=value), self.assertRaisesRegex(ValueError, 'invalid_stored_wait'):
                ReadGate(stored_wait=value)

    def test_a_stored_read_waits_for_a_lane_that_frees_within_the_wait(self):
        gate = ReadGate(interval=0, stored_capacity=1, stored_interval=0, stored_wait=3)
        self.assertTrue(gate.enter(gate.STORED))
        thread, outcome, _ = self.enter_in_thread(gate)
        self.until(lambda: gate.stored_waiting == 1)
        time.sleep(0.1)
        self.assertEqual(outcome, [], 'it waits rather than being refused')
        released = time.monotonic()
        gate.leave(gate.STORED)
        thread.join(2)
        (admitted, at), = outcome
        self.assertTrue(admitted)
        self.assertGreaterEqual(at, released)
        self.assertEqual((gate.stored_inflight, gate.stored_waiting), (1, 0))
        gate.leave(gate.STORED)

    def test_a_stored_read_is_refused_once_its_wait_or_its_read_budget_is_spent(self):
        gate = ReadGate(interval=0, stored_capacity=1, stored_interval=0, stored_wait=1)
        self.assertTrue(gate.enter(gate.STORED))
        try:
            thread, outcome, started = self.enter_in_thread(gate)
            thread.join(3)
            (admitted, at), = outcome
            self.assertFalse(admitted)
            self.assertGreaterEqual(at - started, 0.9)
            # A read with less budget left than the lane's wait waits half of it: refused as busy, still in time
            # (leaving its read_deadline raises once the budget is spent).
            started = time.monotonic()
            with read_deadline(0.4):
                self.assertFalse(gate.enter(gate.STORED))
            self.assertLess(time.monotonic() - started, 0.9)
            self.assertEqual(gate.stored_waiting, 0)
        finally:
            gate.leave(gate.STORED)

    def test_no_more_reads_wait_than_the_lane_has_slots(self):
        gate = ReadGate(interval=0, stored_capacity=2, stored_interval=0, stored_wait=2)
        self.assertTrue(gate.enter(gate.STORED) and gate.enter(gate.STORED))
        waiting = [self.enter_in_thread(gate) for _ in range(2)]
        self.until(lambda: gate.stored_waiting == 2)
        started = time.monotonic()
        self.assertFalse(gate.enter(gate.STORED))
        self.assertLess(time.monotonic() - started, 0.5, 'a full waiting room refuses at once')
        for _ in range(2):
            gate.leave(gate.STORED)
        for thread, outcome, _ in waiting:
            thread.join(3)
            self.assertEqual([admitted for admitted, _ in outcome], [True])
        self.assertEqual((gate.stored_inflight, gate.stored_waiting), (2, 0))
        for _ in range(2):
            gate.leave(gate.STORED)

    def test_the_provider_lane_never_waits(self):
        gate = public_gate()
        self.assertTrue(all(gate.enter() for _ in range(gate.provider_capacity)))
        thread, outcome, started = self.enter_in_thread(gate, ReadGate.PROVIDER)
        thread.join(3)
        (admitted, at), = outcome
        self.assertFalse(admitted)
        self.assertLess(at - started, 0.5)
        self.assertFalse(gate.queue(gate.PROVIDER))
        self.assertEqual(gate.wait_seconds(gate.PROVIDER), 0)


class Pages:
    """The inventory provider: each call answers the next page, and records whose it was."""
    def __init__(self, pages, *, failure=None):
        self.pages, self.failure, self.wallets = list(pages), failure, []

    def __call__(self, url, body):
        if body['method'] == 'eth_chainId':
            return {'jsonrpc': '2.0', 'id': body['id'], 'result': hex(CHAIN_ID)}
        self.wallets.append(body['params'][0])
        if self.failure:
            raise DataError(self.failure)
        return {'jsonrpc': '2.0', 'id': body['id'], 'result': self.pages.pop(0)}


class InventoryReuseTests(unittest.TestCase):
    def setUp(self):
        self.now, self.reads = [1010], []

    def service(self, provider):
        def rpc():
            self.reads.append(AnyWalletRpc(self.now))
            return self.reads[-1]
        return rs.ReadService(rpc_factory=rpc, inventory=AlchemyInventory(URL, transport=provider, clock=lambda: self.now[0]),
                              clock=lambda: self.now[0])

    def test_a_wallets_token_list_is_reused_while_fresh_and_its_balances_are_read_every_time(self):
        provider = Pages([page([TOKEN]), page([OTHER])])
        service = self.service(provider)
        first = service.wallet_assets(OWNER)
        self.now[0] += rs.INVENTORY_FRESH_SECONDS - 1
        second = service.wallet_assets(OWNER)
        self.assertEqual(provider.wallets, [OWNER])
        self.assertEqual(len(self.reads), 2)
        self.assertEqual(second['inventory']['retrievedAt'], first['inventory']['retrievedAt'])
        self.assertEqual([i['address'] for i in second['items']], [i['address'] for i in first['items']])
        self.now[0] += 1
        third = service.wallet_assets(OWNER)
        self.assertEqual(provider.wallets, [OWNER, OWNER])
        self.assertEqual(third['items'][1]['address'], OTHER)
        self.assertEqual(third['inventory']['retrievedAt'], self.now[0])

    def test_each_wallet_has_its_own_list_and_later_pages_always_go_to_the_provider(self):
        provider = Pages([page([TOKEN], 'next'), page([OTHER], owner=OTHER), page([OTHER]), page([OTHER])])
        service = self.service(provider)
        first = service.wallet_assets(OWNER)
        service.wallet_assets(OTHER)
        cursor = first['inventory']['nextCursor']
        service.wallet_assets(OWNER, cursor=cursor)
        service.wallet_assets(OWNER, cursor=cursor)
        self.assertEqual(provider.wallets, [OWNER, OTHER, OWNER, OWNER])

    @patch.object(rs, 'INVENTORY_WAIT_SECONDS', 0.05)
    def test_a_busy_provider_serves_an_hour_old_list_or_says_so_and_still_reads_the_named_tokens(self):
        provider = Pages([page([TOKEN])])
        service = self.service(provider)
        first = service.wallet_assets(OWNER)
        self.now[0] += rs.INVENTORY_FRESH_SECONDS + 700
        for _ in range(rs.INVENTORY_CONCURRENCY):
            self.assertTrue(service._inventory_slot.acquire(blocking=False))
        try:
            busy = service.wallet_assets(OWNER, [OTHER])
            self.assertEqual((busy['inventory']['status'], busy['inventory']['retrievedAt']),
                             ('page_received', first['inventory']['retrievedAt']))
            self.now[0] = first['inventory']['retrievedAt'] + rs.INVENTORY_STALE_SECONDS
            for wallet in (OWNER, OTHER):
                refused = service.wallet_assets(wallet, [TOKEN])
                self.assertEqual((refused['inventory']['status'], refused['inventory']['reason']),
                                 ('unavailable', 'provider_capacity_busy'))
                self.assertIn(TOKEN, [item['address'] for item in refused['items']])
        finally:
            for _ in range(rs.INVENTORY_CONCURRENCY):
                service._inventory_slot.release()
        self.assertEqual(provider.wallets, [OWNER])

    @patch.object(rs, 'INVENTORY_WAIT_SECONDS', 2)
    def test_a_read_waits_for_a_provider_call_to_free_before_it_answers_without_a_list(self):
        provider = Pages([page([TOKEN])])
        service = self.service(provider)
        for _ in range(rs.INVENTORY_CONCURRENCY):
            self.assertTrue(service._inventory_slot.acquire(blocking=False))
        # One call finishes a moment later: the waiting read takes its slot and gets the list.
        threading.Timer(0.1, service._inventory_slot.release).start()
        try:
            result = service.wallet_assets(OWNER)
        finally:
            for _ in range(rs.INVENTORY_CONCURRENCY - 1):
                service._inventory_slot.release()
        self.assertEqual((result['inventory']['status'], provider.wallets), ('page_received', [OWNER]))

    def test_a_failed_provider_call_gives_its_slot_back(self):
        provider = Pages([], failure='http_503')
        service = self.service(provider)
        for _ in range(rs.INVENTORY_CONCURRENCY + 1):
            result = service.wallet_assets(OWNER, [TOKEN])
            self.assertEqual(result['inventory']['status'], 'unavailable')
            self.assertNotEqual(result['inventory']['reason'], 'provider_capacity_busy')
        self.assertEqual(len(provider.wallets), rs.INVENTORY_CONCURRENCY + 1)

    def test_the_reused_lists_are_bounded_least_recently_fetched_first(self):
        provider = Pages([page([TOKEN], owner=OWNER), page([TOKEN], owner=OTHER), page([TOKEN], owner=THIRD),
                          page([OTHER], owner=OWNER), page([OTHER], owner=THIRD), page([OTHER], owner=OTHER)])
        service = self.service(provider)
        with patch.object(rs, 'INVENTORY_CACHE_SIZE', 2):
            for wallet in (OWNER, OTHER, THIRD, OWNER, THIRD):
                service.wallet_assets(wallet)
            # OWNER, the oldest, left when THIRD came; THIRD stayed.
            self.assertEqual(provider.wallets, [OWNER, OTHER, THIRD, OWNER])
            self.assertEqual(len(service._inventory_pages), 2)
            # A list fetched again goes to the back: THIRD, refreshed, outlives OWNER.
            self.now[0] += rs.INVENTORY_FRESH_SECONDS
            service.wallet_assets(THIRD)
            service.wallet_assets(OTHER)
            service.wallet_assets(THIRD)
        self.assertEqual(provider.wallets, [OWNER, OTHER, THIRD, OWNER, THIRD, OTHER])

    def test_the_inventory_limits_are_the_ones_measured(self):
        self.assertEqual((rs.INVENTORY_FRESH_SECONDS, rs.INVENTORY_STALE_SECONDS, rs.INVENTORY_CACHE_SIZE,
                          rs.INVENTORY_CONCURRENCY, rs.INVENTORY_WAIT_SECONDS), (300, 3600, 4096, 4, 2))


if __name__ == '__main__':
    unittest.main()
