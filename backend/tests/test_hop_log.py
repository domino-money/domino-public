"""One line per served hop: allowlisted keys, no address, no raw path."""
from contextlib import redirect_stderr, redirect_stdout
import io
import json
from pathlib import Path
import re
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from fastapi.testclient import TestClient
from discovery import DataError
import hop_log
from read_api import ReadGate, create_app
from read_contract import sanitize_error

ADDRESS = '0x' + 'ab' * 20
FULL_HEX = re.compile(r'0x[0-9a-fA-F]{40}')


def lines(printed):
    return [json.loads(line) for line in printed.getvalue().splitlines() if line]


def captured():
    """Records go to stderr so a CLI's stdout contract stays its own."""
    return redirect_stderr(io.StringIO())


class SafetyTests(unittest.TestCase):
    def test_only_allowlisted_keys_survive_and_none_values_drop(self):
        with captured() as printed:
            hop_log.emit(service='x', status=200, reason=None, body='{"a":1}', cookie='s=1')
        record, = lines(printed)
        self.assertEqual(record, {'service': 'x', 'status': 200})

    def test_an_address_or_long_hex_is_cut_to_a_prefix(self):
        self.assertEqual(hop_log.safe_value(ADDRESS), '0xababab…')
        self.assertEqual(hop_log.safe_value(f'reason {ADDRESS} tail'), 'reason 0xababab… tail')
        self.assertEqual(hop_log.safe_value('0x' + 'f' * 11), '0x' + 'f' * 11)
        self.assertEqual(len(hop_log.safe_value('x' * 200)), hop_log.MAX_TEXT)

    def test_a_propagated_request_id_is_exact_shape_or_replaced(self):
        self.assertEqual(hop_log.checked_request_id('ab' * 16), 'ab' * 16)
        uuid = '123e4567-e89b-42d3-a456-426614174000'
        self.assertEqual(hop_log.checked_request_id(uuid), uuid)
        for junk in (None, '', 'abc', 'AB' * 16, 'x' * 32, uuid.upper(), uuid + 'a'):
            self.assertIsNone(hop_log.checked_request_id(junk))

    def test_notes_outside_an_open_context_are_dropped(self):
        hop_log.note(reason='ignored')  # no open context: never raises, never leaks
        token = hop_log.open_notes()
        hop_log.note(gate='provider', admitted=True)
        self.assertEqual(hop_log.close_notes(token), {'gate': 'provider', 'admitted': True})


class StreamTests(unittest.TestCase):
    def test_records_leave_stdout_free_for_a_cli_json_contract(self):
        with redirect_stdout(io.StringIO()) as out, captured() as err:
            hop_log.emit(service='read-api', status=200)
            print(json.dumps({'status': 'report_saved'}))
        self.assertEqual(json.loads(out.getvalue()), {'status': 'report_saved'})
        self.assertEqual(lines(err), [{'service': 'read-api', 'status': 200}])


class ReaderHopTests(unittest.TestCase):
    def client(self, service):
        return TestClient(create_app(service, gate=ReadGate(interval=0)),
                          base_url='http://127.0.0.1')

    def test_a_refused_read_logs_route_reason_gate_and_the_propagated_id(self):
        class Service:
            def token(self, currency):
                raise DataError('wrong_chain')
        with captured() as printed:
            response = self.client(Service()).post('/v1/read/token', json={'token': ADDRESS},
                                                   headers={'X-Domino-Request-Id': 'cd' * 16})
        record, = lines(printed)
        expected_status, _ = sanitize_error('wrong_chain')
        self.assertEqual(response.status_code, expected_status)
        self.assertEqual((record['service'], record['route'], record['status']),
                         ('read-api', 'token', expected_status))
        self.assertEqual(record['requestId'], 'cd' * 16)
        self.assertEqual(record['reason'], 'wrong_chain')
        self.assertEqual((record['gate'], record['admitted']), ('provider', True))
        self.assertLessEqual(set(record), hop_log.ALLOWED_KEYS)
        self.assertIsNone(FULL_HEX.search(printed.getvalue()))

    def test_an_unknown_path_logs_unmatched_and_a_junk_id_is_replaced(self):
        with captured() as printed:
            self.client(object()).post('/v1/read/' + ADDRESS, json={},
                                       headers={'X-Domino-Request-Id': 'not-an-id'})
        record, = lines(printed)
        self.assertEqual(record['route'], 'unmatched')
        self.assertNotEqual(record['requestId'], 'not-an-id')
        self.assertTrue(re.fullmatch(r'[0-9a-f]{32}', record['requestId']))
        self.assertIsNone(FULL_HEX.search(printed.getvalue()))
        self.assertNotIn(ADDRESS, printed.getvalue())

    def test_a_declared_control_route_is_named_not_unmatched(self):
        with captured() as printed:
            client = self.client(object())
            client.get('/v1/capabilities')
        record, = lines(printed)
        self.assertEqual(record['route'], 'capabilities')

    def test_the_middlewares_own_failures_carry_their_safe_reason(self):
        class Slow:
            def token(self, currency):
                raise DataError('read_deadline_exceeded')
        class Broken:
            def token(self, currency):
                raise RuntimeError('never reaches the record')
        for service, status, reason in ((Slow(), 504, 'read_deadline_exceeded'),
                                        (Broken(), 503, 'upstream_unavailable')):
            with self.subTest(reason=reason), captured() as printed:
                response = self.client(service).post('/v1/read/token', json={'token': ADDRESS})
            record, = lines(printed)
            self.assertEqual((response.status_code, record['status']), (status, status))
            self.assertEqual(record['reason'], reason)
            self.assertNotIn('never reaches the record', printed.getvalue())

    def test_notes_do_not_leak_between_requests_on_one_client(self):
        class Service:
            def token(self, currency):
                raise DataError('wrong_chain')
        client = self.client(Service())
        with captured() as printed:
            client.post('/v1/read/token', json={'token': ADDRESS})
            client.get('/health')
        refused, health = lines(printed)
        self.assertEqual(refused['reason'], 'wrong_chain')
        # The health hop never entered the gate and never refused anything.
        self.assertNotIn('reason', health)
        self.assertNotIn('gate', health)
        self.assertNotIn('admitted', health)

    def test_an_encoded_address_in_the_path_still_logs_unmatched(self):
        with captured() as printed:
            self.client(object()).post('/v1/read/%30x' + 'ab' * 20, json={})
        record, = lines(printed)
        self.assertEqual(record['route'], 'unmatched')
        self.assertNotIn('ab' * 20, printed.getvalue())

    def test_every_request_logs_exactly_one_line_with_duration(self):
        with captured() as printed:
            client = self.client(object())
            client.get('/health')
            client.post('/v1/read/nope', json={})
        health, unmatched = lines(printed)
        self.assertEqual(health['route'], 'health')
        self.assertEqual(unmatched['route'], 'unmatched')
        for record in (health, unmatched):
            self.assertIsInstance(record['durationMs'], int)
            self.assertGreaterEqual(record['durationMs'], 0)
            self.assertIn('contractVersion', record)


if __name__ == '__main__':
    unittest.main()
