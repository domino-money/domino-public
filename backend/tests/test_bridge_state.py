from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from bridge_state import ClientBudgets, ClientShares, OpaqueCursors, strict_json
from discovery import DataError, ZERO
from inventory import CursorCodec
from test_discovery import OWNER, TOKEN, OTHER


class BridgeStateTests(unittest.TestCase):
    def test_strict_json_rejects_ambiguous_or_nonfinite_inputs(self):
        for raw in [b'{"wallet":"a","wallet":"b"}', b'{"a":NaN}', b'{"a":Infinity}', b'\xff']:
            with self.assertRaises(DataError): strict_json(raw)
        self.assertEqual(strict_json(b'{"amountRaw":"9007199254740993","value":null}'),
                         {'amountRaw': '9007199254740993', 'value': None})

    def test_ip_rate_budget_refill_capacity_and_ipv6_normalization(self):
        now = [0.]
        budget = ClientBudgets(clock=lambda: now[0], capacity=2)
        self.assertTrue(all(budget.admit('192.0.2.1') for _ in range(5)))
        self.assertFalse(budget.admit('192.0.2.1'))
        self.assertFalse(budget.admit('::ffff:192.0.2.1'))
        now[0] = 2
        self.assertTrue(budget.admit('192.0.2.1'))
        for _ in range(5): self.assertTrue(budget.admit('2001:db8::1'))
        self.assertFalse(budget.admit('2001:db8::1234'))
        self.assertFalse(budget.admit('192.0.2.2'))
        now[0] = 303
        self.assertTrue(budget.admit('192.0.2.2'))
        with self.assertRaises(DataError): budget.admit('attacker,192.0.2.3')
        self.assertNotIn('192.0.2.2', repr(budget.items))

    def test_a_full_table_makes_room_with_an_address_whose_budget_has_refilled(self):
        # 3 Nov 2026 (launch): a full table refused every new visitor for up to five minutes.
        now = [0.]
        budget = ClientBudgets(clock=lambda: now[0], capacity=2, burst=5, per_minute=30)  # a whole burst back in 10 s
        self.assertEqual([budget.admit('192.0.2.1') for _ in range(6)], [True] * 5 + [False])
        now[0] = 1
        self.assertTrue(budget.admit('192.0.2.2'))
        now[0] = 2
        self.assertFalse(budget.admit('192.0.2.3'), 'the least recently used, 192.0.2.1, is refilling')
        now[0] = 9.9
        self.assertFalse(budget.admit('192.0.2.3'), 'a little short of its burst still')
        self.assertEqual(len(budget.items), 2)
        now[0] = 10
        self.assertTrue(budget.admit('192.0.2.3'))
        self.assertEqual(len(budget.items), 2)
        # 192.0.2.1 left with a full burst, and comes back to one, no more: room is made by 192.0.2.2, refilled too.
        self.assertEqual([budget.admit('192.0.2.1') for _ in range(6)], [True] * 5 + [False])
        self.assertEqual(len(budget.items), 2)

    def test_an_address_mid_burst_cannot_reset_its_budget_by_being_pushed_out(self):
        now = [0.]
        budget = ClientBudgets(clock=lambda: now[0], capacity=2, burst=5, per_minute=30)  # one back every 2 s
        self.assertEqual([budget.admit('192.0.2.1') for _ in range(6)], [True] * 5 + [False])
        now[0] = 1
        self.assertTrue(budget.admit('192.0.2.2'))
        # However many visitors come, none pushes the spent address out while it refills.
        for second, visitor in enumerate(('192.0.2.3', '2001:db8:1::1', '192.0.2.4', '2001:db8:2::1'), start=2):
            now[0] = second / 2 + 1
            self.assertFalse(budget.admit(visitor), visitor)
        now[0] = 4
        # Two returned in 4 s, exactly what it would have had if nobody else had come.
        self.assertEqual([budget.admit('192.0.2.1') for _ in range(3)], [True, True, False])

    def test_opaque_cursor_bound_context_expiry_and_reader_generation(self):
        now = [1000.]
        codec = CursorCodec(clock=lambda: now[0])
        cursors = OpaqueCursors(clock=lambda: now[0], capacity=2)
        cursors.observe_generation('a'*32)
        body = {'wallet': OWNER, 'tokens': [TOKEN, ZERO, TOKEN]}
        internal = codec.issue(OWNER, [TOKEN], 'provider-fingerprint', 'provider-private-page-key')
        handle = cursors.wrap(internal, body)
        self.assertRegex(handle, '^[0-9a-f]{64}$')
        self.assertNotIn('provider', handle)
        self.assertEqual(cursors.unwrap(handle, {'wallet': OWNER.upper().replace('0X','0x'), 'tokens': [TOKEN]}), internal)
        for changed in [{'wallet': OTHER, 'tokens': [TOKEN]}, {'wallet': OWNER},
                        {'wallet': OWNER, 'tokens': [TOKEN], 'autoDiscover': False}]:
            with self.assertRaises(DataError): cursors.unwrap(handle, changed)
        now[0] = 1299
        second = cursors.wrap(internal, body)
        with self.assertRaisesRegex(DataError, 'read_capacity_busy'): cursors.wrap(internal, body)
        now[0] = 1300
        for value in (handle, second):
            with self.assertRaisesRegex(DataError, 'invalid_or_expired_cursor'): cursors.unwrap(value, body)
        now[0] = 1400
        handle = cursors.wrap(codec.issue(OWNER, [TOKEN], 'provider', 'page2'), body)
        cursors.observe_generation('b'*32)
        with self.assertRaises(DataError): cursors.unwrap(handle, body)

    def test_upstream_cursor_cannot_extend_lifetime_or_bind_other_wallet(self):
        cursors = OpaqueCursors(clock=lambda: 1000)
        cursors.observe_generation('a'*32)
        for codec, owner in [(CursorCodec(clock=lambda: 1000, ttl=301), OWNER),
                             (CursorCodec(clock=lambda: 1000), OTHER)]:
            with self.assertRaisesRegex(DataError, 'upstream_invalid_response'):
                cursors.wrap(codec.issue(owner, [], 'provider', 'page'), {'wallet': OWNER})


if __name__ == '__main__': unittest.main()


class ClientBudgetRetryAfterTests(unittest.TestCase):
    def test_the_wait_is_the_time_until_one_token_returns_bounded(self):
        now = [1000.0]
        budgets = ClientBudgets(clock=lambda: now[0], burst=1, per_minute=30)
        self.assertEqual(budgets.retry_after('192.0.2.1'), 1, 'unknown client: nothing to wait for')
        self.assertTrue(budgets.admit('192.0.2.1'))
        self.assertFalse(budgets.admit('192.0.2.1'))
        self.assertEqual(budgets.retry_after('192.0.2.1'), 2, 'one token every two seconds')
        now[0] += 1
        self.assertEqual(budgets.retry_after('192.0.2.1'), 1)
        now[0] += 2
        self.assertEqual(budgets.retry_after('192.0.2.1'), 1)
        self.assertTrue(budgets.admit('192.0.2.1'))
        slow = ClientBudgets(clock=lambda: now[0], burst=1, per_minute=1)
        self.assertTrue(slow.admit('192.0.2.1'))
        self.assertEqual(slow.retry_after('192.0.2.1'), 10, 'a minute becomes the ten-second ceiling')


class ClientShareTests(unittest.TestCase):
    def test_a_client_holds_at_most_its_share_and_gets_it_back(self):
        shares = ClientShares(2)
        self.assertEqual([shares.take('192.0.2.1') for _ in range(3)], [True, True, False])
        # The same visitor by any spelling, an IPv6 /64 as one; another visitor is untouched.
        self.assertFalse(shares.take('::ffff:192.0.2.1'))
        self.assertTrue(shares.take('192.0.2.2'))
        self.assertEqual([shares.take('2001:db8::1'), shares.take('2001:db8::2'), shares.take('2001:db8::3')],
                         [True, True, False])
        shares.give('192.0.2.1')
        self.assertTrue(shares.take('192.0.2.1'))
        self.assertFalse(shares.take('192.0.2.1'))
        for _ in range(2):
            shares.give('192.0.2.1')
        self.assertEqual([shares.take('192.0.2.1') for _ in range(3)], [True, True, False])
        self.assertNotIn('192.0.2', repr(shares.held))

    def test_only_reads_in_hand_are_counted(self):
        shares = ClientShares(1)
        with self.assertRaisesRegex(ValueError, 'client_share_not_held'):
            shares.give('192.0.2.1')
        self.assertTrue(shares.take('192.0.2.1'))
        shares.give('192.0.2.1')
        self.assertEqual(shares.held, {})
        with self.assertRaisesRegex(ValueError, 'client_share_not_held'):
            shares.give('192.0.2.1')
        with self.assertRaises(DataError):
            shares.take('attacker,192.0.2.3')
        for share in (0, 1.0, True, None):
            with self.subTest(share=share), self.assertRaisesRegex(ValueError, 'invalid_client_share'):
                ClientShares(share)
