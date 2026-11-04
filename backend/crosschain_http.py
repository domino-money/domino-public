"""Bounded HTTPS client for the bridge providers' public APIs (Relay, Across).

One instance per provider. Every call is HTTPS to the provider's fixed base URL,
follows no redirect, reads at most MAX_RESPONSE bytes of strict JSON and runs
inside the caller's read deadline. Errors are fixed codes: never a URL, query,
header or response text, because the URL carries the integrator id and the
headers carry API keys.

Rate limits: a per-process budget keeps the service under the provider's limit
(Relay documents 50 quotes per minute for a default key; Across publishes no
numbers and rate-limits unauthenticated traffic strictly). Since 3 Nov 2026 the
status reads that track a deposit (`status=True`) have their own share of it,
and quotes and listings keep the rest: a tracked transfer is asked about every
10 s or more, and that polling never takes a quote's slot. A 429 blocks further
calls of its kind (quotes, or status reads) until its Retry-After passes, so a
throttled provider is reported at once instead of being hammered, and a
throttled status read never blocks a quote. Retries: one, and only for
idempotent reads (listings, status) after a network or 5xx failure, on the
request's own slot; a quote is never retried, since its price moves and the
caller can ask again.
"""
from collections import deque
from decimal import Decimal, InvalidOperation
import http.client
import json
import re
import threading
import time
import urllib.error
import urllib.parse
import urllib.request

from discovery import DataError, _JSON_OPENER, _reject_json_constant, _strict_json_object
from read_deadline import check_read_deadline, read_deadline

MAX_RESPONSE = 2_000_000
MAX_ERROR_BODY = 4096
DEFAULT_RETRY_AFTER = 60
MAX_RETRY_AFTER = 600
PROVIDER_CODE = re.compile(r'[A-Za-z][A-Za-z0-9_]{0,63}')
HEADER_VALUE = re.compile(r'[\x21-\x7e](?:[\x20-\x7e]{0,510}[\x21-\x7e])?')
USER_AGENT = 'DominoCrosschain/1.0'


class ProviderError(DataError):
    """A fixed `<provider>_<kind>` code, plus the provider's own error token when it sent one."""
    def __init__(self, code, provider_code=None):
        super().__init__(code)
        self.provider_code = provider_code if isinstance(provider_code, str) and PROVIDER_CODE.fullmatch(provider_code) else None


class RateBudget:
    """At most `per_minute` calls in any 60-second window, and none while a 429 back-off lasts."""
    def __init__(self, per_minute, *, clock=time.monotonic):
        if type(per_minute) is not int or not 1 <= per_minute <= 6000:
            raise ValueError('invalid_rate_budget')
        self.per_minute, self.clock = per_minute, clock
        self._calls, self._blocked_until, self._lock = deque(), 0.0, threading.Lock()

    def acquire(self):
        with self._lock:
            now = self.clock()
            if now < self._blocked_until:
                return False
            while self._calls and self._calls[0] <= now - 60:
                self._calls.popleft()
            if len(self._calls) >= self.per_minute:
                return False
            self._calls.append(now)
            return True

    def back_off(self, seconds):
        with self._lock:
            self._blocked_until = max(self._blocked_until, self.clock() + seconds)

    def blocked_for(self):
        with self._lock:
            return max(0.0, self._blocked_until - self.clock())


def retry_after_seconds(value):
    """Retry-After in delta seconds, bounded; an HTTP date or garbage falls back to the default."""
    if isinstance(value, str) and re.fullmatch(r'[0-9]{1,6}', value.strip()):
        return min(max(int(value.strip()), 1), MAX_RETRY_AFTER)
    return DEFAULT_RETRY_AFTER


def _provider_code(raw):
    try:
        body = json.loads(raw)
    except (ValueError, UnicodeError, RecursionError):
        return None
    if not isinstance(body, dict):
        return None
    for key in ('errorCode', 'code', 'error'):
        value = body.get(key)
        if isinstance(value, str) and PROVIDER_CODE.fullmatch(value):
            return value
    return None


class ProviderHttp:
    """`per_minute` is every call to the provider; `status_per_minute` of them are the status reads' own (0: they
    share one budget with everything else, as the operator's fee tool does)."""
    def __init__(self, provider, base_url, *, headers=None, per_minute, status_per_minute=0, opener=_JSON_OPENER,
                 clock=time.monotonic, sleep=time.sleep, max_bytes=MAX_RESPONSE):
        if provider not in ('relay', 'across'):
            raise ValueError('invalid_provider')
        if type(per_minute) is not int or type(status_per_minute) is not int or not 0 <= status_per_minute < per_minute:
            raise ValueError('invalid_rate_budget')
        parsed = urllib.parse.urlsplit(base_url)
        if (parsed.scheme != 'https' or not parsed.hostname or parsed.username or parsed.password
                or parsed.query or parsed.fragment or parsed.port not in (None, 443)):
            raise ValueError('invalid_provider_base_url')
        headers = dict(headers or {})
        for name, value in headers.items():
            if name not in ('x-api-key', 'Authorization') or not isinstance(value, str) or not HEADER_VALUE.fullmatch(value):
                raise ValueError('invalid_provider_header')
        self.provider, self.base_url = provider, base_url.rstrip('/')
        self._headers = headers
        self.budget = RateBudget(per_minute - status_per_minute, clock=clock)
        self.status_budget = RateBudget(status_per_minute, clock=clock) if status_per_minute else self.budget
        self._opener, self._sleep, self._max_bytes = opener, sleep, max_bytes

    def _code(self, kind, provider_code=None):
        return ProviderError(f'{self.provider}_{kind}', provider_code)

    def get(self, path, params=None, *, timeout, retry=False, status=False):
        return self._request('GET', path, params, None, timeout, retry, self.status_budget if status else self.budget)

    def post(self, path, body, *, timeout, retry=False):
        return self._request('POST', path, None, body, timeout, retry, self.budget)

    def _request(self, method, path, params, body, timeout, retry, budget):
        if not re.fullmatch(r'(?:/(?!\.\.?(?:/|$))[A-Za-z0-9._-]+)+', path):
            raise ValueError('invalid_provider_path')
        url = self.base_url + path
        if params:
            if any(not isinstance(value, str) for value in params.values()):
                raise ValueError('invalid_provider_query')
            url += '?' + urllib.parse.urlencode(params)
        # One slot per request: its retry rides on it (3 Nov 2026), so a failing provider costs a status poll one
        # slot, not two.
        if not budget.acquire():
            raise self._code('rate_limited')
        attempts = 2 if retry else 1
        for attempt in range(attempts):
            try:
                return self._once(method, url, body, timeout, budget)
            except ProviderError as error:
                if attempt + 1 < attempts and str(error) == f'{self.provider}_unavailable':
                    check_read_deadline()
                    self._sleep(0.25)
                    # Never through a 429 back-off that another call began meanwhile.
                    if budget.blocked_for():
                        raise self._code('rate_limited') from None
                    continue
                raise

    def _once(self, method, url, body, timeout, budget):
        headers = {'Accept': 'application/json', 'User-Agent': USER_AGENT, **self._headers}
        data = None
        if body is not None:
            headers['Content-Type'] = 'application/json'
            data = json.dumps(body, allow_nan=False, separators=(',', ':')).encode()
        try:
            with read_deadline(timeout) as deadline:
                request = urllib.request.Request(url, data=data, headers=headers, method=method)
                try:
                    with self._opener(request, timeout=deadline.remaining()) as response:
                        chunks, size = [], 0
                        read = getattr(response, 'read1', response.read)
                        while True:
                            deadline.remaining()
                            chunk = read(min(64 * 1024, self._max_bytes + 1 - size))
                            if not chunk:
                                break
                            size += len(chunk)
                            if size > self._max_bytes:
                                raise self._code('response_too_large')
                            chunks.append(chunk)
                except urllib.error.HTTPError as error:
                    raise self._http_error(error, budget) from None
                try:
                    return json.loads(b''.join(chunks), parse_float=Decimal, parse_constant=_reject_json_constant,
                                      object_pairs_hook=_strict_json_object)
                except (UnicodeError, ValueError, RecursionError, InvalidOperation):
                    raise self._code('invalid_response') from None
        except ProviderError:
            raise
        except DataError as error:
            if str(error) == 'read_deadline_exceeded':
                raise self._code('deadline_exceeded') from None
            raise self._code('unavailable') from None
        except (urllib.error.URLError, TimeoutError, OSError, http.client.HTTPException, ValueError):
            raise self._code('unavailable') from None

    def _http_error(self, error, budget):
        status = error.code
        retry_after = error.headers.get('Retry-After') if error.headers is not None else None
        try:
            raw = error.read(MAX_ERROR_BODY)
        except Exception:
            raw = b''
        # Close before discarding: a delayed resource warning must not carry the private URL.
        try:
            error.close()
        except Exception:
            pass
        code = _provider_code(raw)
        if status == 429:
            budget.back_off(retry_after_seconds(retry_after))
            return self._code('rate_limited', code)
        if status in (401, 403):
            return self._code('credentials_rejected', code)
        if status == 404:
            return self._code('not_found', code)
        if status in (400, 409, 422):
            return self._code('request_rejected', code)
        return self._code('unavailable', code)
