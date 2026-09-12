from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from discovery import DataError, ReadRpc, CHAIN_ID
from dev_read_budget import DevelopmentBudgets, DevelopmentGate, DevelopmentTransport
from read_deadline import read_deadline
from rpc_failover import FailoverReadRpc


PRIMARY = 'https://rpc.mainnet.chain.robinhood.com'
INVENTORY = 'https://robinhood-mainnet.g.alchemy.com/v2/offline-test'
TOKEN = '0x' + '11' * 20
POOL = '0x' + '22' * 32
GECKO = 'https://api.geckoterminal.com/api/v2/networks/robinhood/pools/' + POOL
DEX = 'https://api.dexscreener.com/token-pairs/v1/robinhood/' + TOKEN


def payload(count=1, method='eth_chainId', params=None):
    rows = [{'jsonrpc': '2.0', 'id': i + 1, 'method': method, 'params': params or []}
            for i in range(count)]
    return rows[0] if count == 1 else rows


class DevelopmentBudgetTests(unittest.TestCase):
    def setUp(self):
        self.now, self.wall, self.calls = [0.0], [100], []
        self.budgets = DevelopmentBudgets(qualified=True, expires_at=1000,
            clock=lambda: self.now[0], wall_clock=lambda: self.wall[0])
        def fake(url, body=None, **kwargs):
            self.calls.append((url, body, kwargs))
            rows = body if isinstance(body, list) else [body]
            result = [{'jsonrpc': '2.0', 'id': row['id'], 'result': hex(CHAIN_ID)}
                      for row in rows] if body is not None else {}
            return result if isinstance(body, list) or body is None else result[0]
        self.transport = DevelopmentTransport(self.budgets, rpc_urls=[PRIMARY, INVENTORY],
                                              inventory_url=INVENTORY, transport=fake)
        self.now[0] = 60

    def test_operation_limit_counts_batch_items_across_factories_and_nested_calls(self):
        with self.assertRaisesRegex(DataError, 'request_budget_exhausted'):
            with self.budgets.operation():
                for _ in range(8):
                    # New RPC facades cannot reset the transport's operation.
                    ReadRpc(PRIMARY, transport=self.transport).batch([('eth_chainId', [])] * 8)
                with self.budgets.operation():
                    self.transport(PRIMARY, payload())
        self.assertEqual(len(self.calls), 8)
        self.assertEqual(len(self.budgets.events['rpc']), 64)

    def test_rolling_window_is_shared_between_reads_and_expires(self):
        for count in (64, 56):
            with self.budgets.operation():
                for _ in range(count // 8):
                    self.transport(PRIMARY, payload(8))
        with self.assertRaisesRegex(DataError, 'request_budget_exhausted'):
            with self.budgets.operation(): self.transport(INVENTORY, payload())
        self.assertEqual(len(self.calls), 15)
        self.now[0] = 120
        with self.budgets.operation(): self.transport(PRIMARY, payload())
        self.assertEqual(len(self.budgets.events['rpc']), 1)

    def test_failed_batch_and_failover_identity_checks_all_spend(self):
        original = self.transport.transport
        def fail_primary_batch(url, body, **kwargs):
            if url == PRIMARY and isinstance(body, list):
                self.calls.append((url, body, kwargs))
                raise DataError('http_503')
            return original(url, body, **kwargs)
        self.transport.transport = fail_primary_batch
        with self.budgets.operation():
            rpc = FailoverReadRpc([PRIMARY, INVENTORY], transport=self.transport)
            self.assertEqual(rpc.batch([('eth_chainId', [])] * 2), [hex(CHAIN_ID)] * 2)
        self.assertEqual(len(self.budgets.events['rpc']), 6)
        self.assertEqual([len(body) if isinstance(body, list) else 1 for _, body, _ in self.calls], [1, 2, 1, 2])

    def test_network_failure_is_charged_and_not_refunded(self):
        def fail(*args, **kwargs): raise DataError('network_unavailable')
        self.transport.transport = fail
        with self.budgets.operation():
            with self.assertRaisesRegex(DataError, 'network_unavailable'):
                self.transport(PRIMARY, payload(8))
        self.assertEqual(len(self.budgets.events['rpc']), 8)

    def test_inventory_counts_in_same_rpc_operation_and_requires_exact_endpoint(self):
        item = payload(method='alchemy_getTokenBalances', params=[TOKEN, 'erc20', {'maxCount': 20}])
        with self.budgets.operation():
            self.transport(INVENTORY, payload())
            self.transport(INVENTORY, item)
            with self.assertRaises(DataError): self.transport(PRIMARY, item)
        self.assertEqual(len(self.budgets.events['rpc']), 2)
        self.assertEqual(len(self.calls), 2)

    def test_provider_caps_count_actual_http_and_cannot_be_hidden_as_optional_failure(self):
        for url, limit, kind in ((GECKO, 3, 'gecko'), (DEX, 6, 'dex')):
            with self.subTest(kind=kind):
                for _ in range(limit):
                    with self.budgets.operation(): self.transport(url)
                with self.assertRaisesRegex(DataError, 'request_budget_exhausted'):
                    with self.budgets.operation():
                        try: self.transport(url)
                        except DataError: pass  # Adapter's optional fallback.
                self.assertEqual(len(self.budgets.events[kind]), limit)

    def test_unknown_urls_methods_overrides_and_inventory_options_never_dispatch(self):
        cases = [
            ('https://localhost/private', None),
            (PRIMARY + '/changed', payload()),
            (INVENTORY + '?key=other', payload()),
            ('https://trade-api.gateway.uniswap.org/v1/quote', {}),
            ('https://robinhoodchain.blockscout.com/api/v2/addresses/' + TOKEN, None),
            (GECKO + '?target=https://evil.invalid', None),
            (DEX + '/../../secret', None),
            (PRIMARY, payload(method='eth_sendRawTransaction', params=['0x12'])),
            (PRIMARY, payload(method='eth_call', params=[{'to': TOKEN, 'data': '0x'}, 'latest', {}])),
            (INVENTORY, payload(method='alchemy_getTokenBalances', params=[TOKEN, 'erc20', {'maxCount': 100}])),
        ]
        with self.budgets.operation():
            for url, body in cases:
                with self.subTest(url=url), self.assertRaises(DataError): self.transport(url, body)
        self.assertEqual(self.calls, [])

    def test_no_io_without_operation_qualification_after_expiry_or_during_restart_cooldown(self):
        with self.assertRaises(DataError): self.transport(PRIMARY, payload())
        self.now[0] = 59
        with self.assertRaises(DataError):
            with self.budgets.operation(): self.transport(PRIMARY, payload())
        self.now[0] = 60
        self.wall[0] = 1000
        with self.assertRaises(DataError):
            with self.budgets.operation(): self.transport(PRIMARY, payload())
        self.wall[0] = 100
        self.budgets.qualified = False
        with self.assertRaises(DataError):
            with self.budgets.operation(): self.transport(PRIMARY, payload())
        self.assertEqual(self.calls, [])

    def test_expiry_and_total_deadline_rechecked_after_noncooperative_transport(self):
        def expires(*args, **kwargs):
            self.wall[0] = 1000
            return {}
        self.transport.transport = expires
        with self.assertRaises(DataError):
            with self.budgets.operation(): self.transport(GECKO)
        self.wall[0] = 100
        def timeout(*args, **kwargs):
            self.now[0] += 2
            return {}
        self.transport.transport = timeout
        with self.assertRaisesRegex(DataError, 'read_deadline_exceeded'):
            with read_deadline(1, clock=lambda: self.now[0]):
                with self.budgets.operation(): self.transport(GECKO)

    def test_gate_single_worker_minimum_spacing_rolling_limit_and_restart_delay(self):
        gate = DevelopmentGate(self.budgets)
        self.assertTrue(gate.enter())
        self.assertFalse(gate.enter())
        gate.slot.release()
        self.assertFalse(gate.enter())
        for _ in range(5):
            self.now[0] += 2
            self.assertTrue(gate.enter())
            gate.slot.release()
        self.now[0] += 2
        self.assertFalse(gate.enter())
        self.now[0] = 120
        self.assertTrue(gate.enter())
        gate.slot.release()
        restarted = DevelopmentBudgets(qualified=True, expires_at=1000,
            clock=lambda: self.now[0], wall_clock=lambda: self.wall[0])
        self.assertFalse(DevelopmentGate(restarted).enter())


if __name__ == '__main__':
    unittest.main()
