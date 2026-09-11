from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from bridge_state import ClientBudgets, OpaqueCursors, strict_json
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
