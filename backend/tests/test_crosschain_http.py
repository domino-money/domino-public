"""Provider HTTP: fixed codes, rate limits and back-off, one retry for reads only, nothing private in errors."""
import email.message
import io
import json
import unittest
import urllib.error

from crosschain_support import PRIVATE  # noqa: F401  (puts backend on sys.path)
from crosschain_http import ProviderError, ProviderHttp, RateBudget, retry_after_seconds
from discovery import DataError

KEY = 'relay-offline-key-canary'


class Clock:
    def __init__(self):
        self.now = 1000.0

    def __call__(self):
        return self.now


class Response(io.BytesIO):
    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.close()


def http_error(code, body=b'', retry_after=None):
    headers = email.message.Message()
    if retry_after is not None:
        headers['Retry-After'] = retry_after
    return urllib.error.HTTPError('https://api.example.invalid/private?key=' + KEY, code, 'error', headers, io.BytesIO(body))


class Opener:
    def __init__(self, *answers):
        self.answers, self.requests = list(answers), []

    def __call__(self, request, timeout):
        self.requests.append(request)
        answer = self.answers.pop(0)
        if isinstance(answer, BaseException):
            raise answer
        return Response(answer if isinstance(answer, bytes) else json.dumps(answer).encode())


def client(opener, clock=None, per_minute=50, headers=None, **kwargs):
    return ProviderHttp('relay', 'https://api.relay.link', headers=headers or {'x-api-key': KEY}, per_minute=per_minute,
                        opener=opener, clock=clock or Clock(), sleep=lambda seconds: None, **kwargs)


class ProviderHttpTests(unittest.TestCase):
    def test_a_json_answer_with_the_key_header_and_query(self):
        opener = Opener({'status': 'success'})
        self.assertEqual(client(opener).get('/intents/status/v3', {'requestId': '0x01'}, timeout=5), {'status': 'success'})
        request = opener.requests[0]
        self.assertEqual(request.full_url, 'https://api.relay.link/intents/status/v3?requestId=0x01')
        self.assertEqual(request.get_header('X-api-key'), KEY)
        self.assertEqual(request.get_method(), 'GET')

    def test_post_sends_compact_json(self):
        opener = Opener({'ok': True})
        client(opener).post('/quote/v2', {'amount': '1'}, timeout=5)
        self.assertEqual(opener.requests[0].data, b'{"amount":"1"}')
        self.assertEqual(opener.requests[0].get_header('Content-type'), 'application/json')

    def test_strict_json_and_size(self):
        for body, code in ((b'{"a":1,"a":2}', 'relay_invalid_response'), (b'{"a":NaN}', 'relay_invalid_response'),
                           (b'not json', 'relay_invalid_response'), (b'{"a":"' + b'x' * 64 + b'"}', 'relay_response_too_large')):
            with self.subTest(body=body[:20]), self.assertRaises(ProviderError) as caught:
                client(Opener(body), max_bytes=32).get('/chains', timeout=5)
            self.assertEqual(str(caught.exception), code)

    def test_status_codes_become_fixed_codes_with_the_provider_token(self):
        cases = ((401, b'{"message":"bad","errorCode":"UNAUTHORIZED"}', 'relay_credentials_rejected', 'UNAUTHORIZED'),
                 (400, b'{"message":"x","errorCode":"NO_SWAP_ROUTES_FOUND"}', 'relay_request_rejected', 'NO_SWAP_ROUTES_FOUND'),
                 (404, b'{"error":"DepositNotFoundException"}', 'relay_not_found', 'DepositNotFoundException'),
                 (422, b'<html>', 'relay_request_rejected', None),
                 (502, b'', 'relay_unavailable', None),
                 (302, b'', 'relay_unavailable', None))
        for status, body, code, token in cases:
            with self.subTest(status=status), self.assertRaises(ProviderError) as caught:
                client(Opener(http_error(status, body))).post('/quote/v2', {}, timeout=5)
            self.assertEqual((str(caught.exception), caught.exception.provider_code), (code, token))
            self.assertNotIn(KEY, repr(caught.exception.args))

    def test_a_429_backs_off_for_retry_after_without_calling_again(self):
        clock = Clock()
        opener = Opener(http_error(429, b'{"errorCode":"RATE_LIMITED"}', '30'), {'ok': True})
        http = client(opener, clock)
        for _ in range(2):
            with self.assertRaisesRegex(ProviderError, 'relay_rate_limited'):
                http.get('/chains', timeout=5)
        self.assertEqual(len(opener.requests), 1)
        self.assertEqual(http.budget.blocked_for(), 30)
        clock.now += 31
        self.assertEqual(http.get('/chains', timeout=5), {'ok': True})

    def test_the_budget_caps_calls_per_minute(self):
        clock = Clock()
        opener = Opener(*([{'ok': True}] * 3))
        http = client(opener, clock, per_minute=2)
        http.get('/chains', timeout=5)
        http.get('/chains', timeout=5)
        with self.assertRaisesRegex(ProviderError, 'relay_rate_limited'):
            http.get('/chains', timeout=5)
        clock.now += 61
        http.get('/chains', timeout=5)
        self.assertEqual(len(opener.requests), 3)

    def test_reads_retry_once_after_a_failure_but_quotes_never(self):
        opener = Opener(http_error(503), {'ok': True})
        self.assertEqual(client(opener).get('/chains', timeout=5, retry=True), {'ok': True})
        opener = Opener(urllib.error.URLError('down'), {'ok': True})
        with self.assertRaisesRegex(ProviderError, 'relay_unavailable'):
            client(opener).post('/quote/v2', {}, timeout=5)
        self.assertEqual(len(opener.requests), 1)
        opener = Opener(http_error(400), {'ok': True})
        with self.assertRaisesRegex(ProviderError, 'relay_request_rejected'):
            client(opener).get('/chains', timeout=5, retry=True)
        self.assertEqual(len(opener.requests), 1)

    def test_network_failures_and_timeouts_are_fixed_codes(self):
        for error in (urllib.error.URLError('x'), TimeoutError(), OSError('x')):
            with self.subTest(error=type(error).__name__), self.assertRaisesRegex(ProviderError, 'relay_unavailable'):
                client(Opener(error)).get('/chains', timeout=5)

    def test_configuration_is_bounded(self):
        for base in ('http://api.relay.link', 'https://user:pass' + '@api.relay.link', 'https://api.relay.link?x=1', 'ftp://x'):
            with self.subTest(base=base), self.assertRaises(ValueError):
                ProviderHttp('relay', base, per_minute=1)
        for headers in ({'Cookie': 'x'}, {'x-api-key': 'bad\nvalue'}, {'Authorization': ''}):
            with self.subTest(headers=headers), self.assertRaises(ValueError):
                ProviderHttp('relay', 'https://api.relay.link', headers=headers, per_minute=1)
        with self.assertRaises(ValueError):
            ProviderHttp('other', 'https://api.relay.link', per_minute=1)
        with self.assertRaises(ValueError):
            client(Opener()).get('/../etc', timeout=5)
        with self.assertRaises(ValueError):
            RateBudget(0)

    def test_retry_after_is_bounded(self):
        self.assertEqual([retry_after_seconds(v) for v in ('5', ' 7 ', '0', '100000', 'Wed, 21 Oct 2026', None)],
                         [5, 7, 1, 600, 60, 60])

    def test_errors_are_data_errors(self):
        self.assertTrue(issubclass(ProviderError, DataError))


if __name__ == '__main__':
    unittest.main()
