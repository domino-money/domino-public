"""Shared bounded private HTTP boundary for session-authenticated services."""
import asyncio
from concurrent.futures import ThreadPoolExecutor
from contextlib import asynccontextmanager
import ipaddress
import json
import math
import os
import random
import re
import secrets
from threading import BoundedSemaphore
import time

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from pydantic import ValidationError

from bridge_state import strict_json
from discovery import DataError
import hop_log
from onboarding_auth import serving
from read_deadline import read_deadline
from session_models import SessionError


# Requests at once per service. Each is a short database read or write; 26 September
# 2026: availability polls answer in ~20 ms, and two slots refused bursts of a busy page.
MAX_WORKERS = 8
TOTAL_SECONDS = 20
UPLOAD_SECONDS = 5
# 3 Nov 2026 (launch): a full listener holds a request up to SLOT_WAIT_SECONDS for a slot, never past
# its own deadline, instead of refusing it at once: a plan holds its slot ~4 s at p50, so the 9th was
# refused with a slot seconds from free. At most MAX_WAITING wait: each holds one of uvicorn's 16
# connections (limit_concurrency), past which uvicorn answers a bare 503, so the JSON 429 with its
# Retry-After stays what sheds load.
SLOT_WAIT_SECONDS = 2.5
SLOT_POLL_SECONDS = 0.05
MAX_WAITING = 4
# Retry-After on a 429, by cause, a whole number of seconds from 1 to 60 (3 Nov 2026; every 429 said 60):
# a capacity-busy refusal (a worker slot, the session store's lock) 2 to 5 s at random, so the tabs it
# refused do not all come back in the same second; a rate limit the seconds until its window admits
# again; anything else (a provider's limit, an owner's own caps) the minute it always said. The bridge
# Workers pass 1 to 60 through.
CAPACITY_RETRY_SECONDS = (2, 5)
MAX_RETRY_SECONDS = 60
# An owner's 16 active deposits: one of them has to end, so no short wait clears it.
OWNER_LIMITS = frozenset(('deposit_owner_capacity_busy',))


def retry_after(code, wait=None):
    """Retry-After for a 429 answering `code`; `wait`: the seconds a rate limit named, when it did."""
    if code.endswith('_capacity_busy') and code not in OWNER_LIMITS:
        return random.randint(*CAPACITY_RETRY_SECONDS)
    if type(wait) in (int, float) and math.isfinite(wait):
        return max(1, min(MAX_RETRY_SECONDS, math.ceil(wait)))
    return MAX_RETRY_SECONDS


class AuthenticatedGateway:
    def __init__(self, *, contract, service=None, verifier=None, origin=None, enabled=False,
                 clock=time.monotonic, total_seconds=TOTAL_SECONDS, upload_seconds=UPLOAD_SECONDS):
        self.contract = contract
        if type(enabled) is not bool or enabled and (service is None or verifier is None):
            raise ValueError('invalid_onboarding_gateway_config')
        if enabled:
            from session_siwe import SiwePolicy
            SiwePolicy(origin)
        if any(type(value) not in (int, float) or not math.isfinite(value) or not 0 < value <= maximum
               for value, maximum in ((total_seconds, TOTAL_SECONDS), (upload_seconds, UPLOAD_SECONDS))):
            raise ValueError('invalid_onboarding_gateway_budget')
        self.service, self.verifier, self.origin, self.enabled = service, verifier, origin, enabled
        self.clock, self.total_seconds, self.upload_seconds = clock, total_seconds, upload_seconds
        self.slot, self.waiting = BoundedSemaphore(MAX_WORKERS), BoundedSemaphore(MAX_WAITING)

    async def take_slot(self, deadline):
        """A worker slot now, or within SLOT_WAIT_SECONDS behind at most MAX_WAITING others; never past `deadline`."""
        if self.slot.acquire(blocking=False):
            return True
        wait = min(SLOT_WAIT_SECONDS, deadline - self.clock())
        if wait <= 0 or not self.waiting.acquire(blocking=False):
            return False
        try:
            loop = asyncio.get_running_loop()
            until = loop.time() + wait
            while (left := until - loop.time()) > 0:
                await asyncio.sleep(min(SLOT_POLL_SECONDS, left))
                if self.slot.acquire(blocking=False):
                    return True
            return False
        finally:
            self.waiting.release()

    def execute(self, route, body, headers, deadline, version=None):
        """`version`: the one the request named, for a family with a switch window (CONTRACT_VERSIONS); its service
        and its models answer in that version. None for every other family, which has one. Answers (status, body,
        wait): `wait`, the seconds a rate limit named for its Retry-After, else None."""
        OnboardingError = self.contract.Error
        validate_response = self.contract.validate_response
        MAX_RESPONSE = self.contract.MAX_RESPONSE
        window = {} if version is None else {'version': version}
        try:
            remaining = deadline - self.clock()
            if remaining <= 0:
                raise OnboardingError('request_timeout')
            # The family ('/internal/<family>/v1/') and route choose the session's preview budget.
            with read_deadline(remaining, clock=self.clock), serving(self.contract.PREFIX.split('/')[2], route):
                try:
                    self.verifier.verify(headers['assertion'])
                except Exception:
                    raise OnboardingError('upstream_unavailable') from None
                response = self.service.execute(route, body, client=headers['client'],
                                                session=headers['session'], csrf=headers['csrf'], **window)
                response = validate_response(route, response, **window)
                encoded = json.dumps(response, allow_nan=False, separators=(',', ':'))
                if len(encoded.encode()) > MAX_RESPONSE or any(headers[name] and headers[name] in encoded
                        for name in ('assertion', 'session', 'csrf')):
                    raise OnboardingError('upstream_invalid_response')
                return 200, response, None
        except (OnboardingError, SessionError) as error:
            normalized = OnboardingError(error.code)
            return normalized.status, {'error': normalized.code}, getattr(error, 'retry_after', None)
        except DataError:
            return 504, {'error': 'request_timeout'}, None
        except (ValidationError, ValueError, TypeError):
            return 502, {'error': 'upstream_invalid_response'}, None
        except Exception:
            return 503, {'error': 'upstream_unavailable'}, None
        finally:
            self.slot.release()


def create_authenticated_app(gateway):
    contract = gateway.contract
    # Each private family names itself in the record; the prefix is its identity.
    SERVICE_NAME = contract.PREFIX.strip('/').replace('/', '-')
    OnboardingError = contract.Error
    validate_request = contract.validate_request
    MAX_BODY, CONTRACT_VERSION = contract.MAX_BODY, contract.CONTRACT_VERSION
    PREFIX, HEADER = contract.PREFIX, contract.HEADER
    # A family may accept a second version while its consumers switch (crosschain-v1, 6 Oct 2026): the request's
    # header names one of CONTRACT_VERSIONS, and its answer, the answer's header and its record carry that one. Every
    # other family has exactly CONTRACT_VERSION, as before.
    WINDOW = getattr(contract, 'CONTRACT_VERSIONS', None)
    ACCEPTED = frozenset(version.encode('ascii') for version in (WINDOW or (CONTRACT_VERSION,)))
    executor = ThreadPoolExecutor(max_workers=MAX_WORKERS, thread_name_prefix='authenticated-api')
    pending = set()

    @asynccontextmanager
    async def lifespan(app):
        yield
        executor.shutdown(wait=False, cancel_futures=False)

    app = FastAPI(title='Domino private authenticated API', docs_url=None, redoc_url=None,
                  openapi_url=None, lifespan=lifespan)
    app.state.gateway, app.state.pending = gateway, pending

    @app.middleware('http')
    async def boundary(request: Request, call_next):
        try:
            from access_transport import normalize_access_cookie
            normalize_access_cookie(request.scope)
            deadline = gateway.clock() + gateway.total_seconds
            upload_deadline = min(deadline, gateway.clock() + gateway.upload_seconds)
            request_id = secrets.token_hex(16)
            opened = gateway.clock()
            logged_route = 'unmatched'
            # The version answered: the one the request names when this family accepts it, a refusal before the
            # header's own check included (a window's previous version is answered in it); else this family's own.
            named = next((value for name, value in request.scope['headers'] if name.lower() == HEADER.lower().encode()), None)
            version = named.decode('ascii') if named in ACCEPTED else CONTRACT_VERSION
            notes = hop_log.open_notes()
            recorded = []

            def record(status, reason=None):
                # The raw path never reaches the record: only a declared route name.
                if recorded:
                    return
                recorded.append(status)
                hop_log.emit(service=SERVICE_NAME, requestId=request_id, route=logged_route,
                             contractVersion=version, method=request.method, status=status,
                             reason=reason, durationMs=int((gateway.clock() - opened) * 1000),
                             **hop_log.close_notes(notes))

            def result(status, body, wait=None):
                reason = body.get('error') if isinstance(body, dict) else None
                record(status, reason)
                headers = {'Cache-Control': 'no-store, no-transform', 'X-Content-Type-Options': 'nosniff',
                           'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
                           HEADER: version, 'X-Domino-Request-Id': request_id}
                if status == 429:
                    headers['Retry-After'] = str(retry_after(reason or '', wait))
                return JSONResponse(body, status_code=status, headers=headers)

            def error(code):
                value = OnboardingError(code)
                return result(value.status, {'error': value.code})

            path = request.scope.get('raw_path', b'').decode('ascii', errors='replace')
            match = re.fullmatch(re.escape(PREFIX) + '(' + '|'.join(re.escape(route) for route in contract.REQUEST_MODELS) + ')', path)
            if match:
                logged_route = match[1]
            if not match or request.scope.get('query_string') or not gateway.enabled:
                return error('route_not_available')
            if request.method != 'POST':
                return error('method_not_allowed')
            try:
                if not ipaddress.ip_address(request.client.host).is_loopback:
                    return error('origin_not_allowed')
            except (ValueError, AttributeError):
                return error('origin_not_allowed')
            headers, total = {}, 0
            for name, value in request.scope['headers']:
                name = name.lower()
                total += len(name) + len(value)
                if name in (b'origin', b'cookie', b'authorization'):
                    return error('origin_not_allowed')
                if name in headers or total > 16384:
                    return error('invalid_request')
                headers[name] = value
            if headers.get(b'x-domino-browser-origin') != gateway.origin.encode('ascii'):
                return error('origin_not_allowed')
            if headers.get(HEADER.lower().encode()) not in ACCEPTED:
                return error('upstream_contract_mismatch')
            if (not re.fullmatch(rb'application/json(?:;\s*charset=utf-8)?', headers.get(b'content-type', b''), re.I)
                    or headers.get(b'content-encoding', b'identity') != b'identity'):
                return error('json_required')
            length = headers.get(b'content-length')
            if length is not None:
                if not re.fullmatch(rb'(0|[1-9][0-9]{0,9})', length) or b'transfer-encoding' in headers:
                    return error('invalid_request')
                if int(length) > MAX_BODY:
                    return error('request_too_large')
            try:
                assertion = headers[b'cf-access-jwt-assertion'].decode('ascii')
                client = headers[b'x-domino-client-id'].decode('ascii')
                if not 1 <= len(assertion) <= 8192 or not 1 <= len(client) <= 45:
                    raise ValueError()
                ipaddress.ip_address(client)
                # Formats/required checks and durable attempt budgets belong to
                # the auth store, after trusted service identity verification.
                credentials = {name: headers[('x-domino-' + name).encode()].decode('ascii')
                               if ('x-domino-' + name).encode() in headers else None for name in ('session', 'csrf')}
            except (KeyError, ValueError, UnicodeError):
                return error('invalid_request')
            raw = bytearray()
            try:
                async with asyncio.timeout(max(0, upload_deadline - gateway.clock())):
                    async for chunk in request.stream():
                        if gateway.clock() >= upload_deadline:
                            raise TimeoutError()
                        if len(raw) + len(chunk) > MAX_BODY:
                            return error('request_too_large')
                        raw.extend(chunk)
                if length is not None and len(raw) != int(length):
                    return error('invalid_request')
                body = strict_json(raw)
                if WINDOW is None:
                    validate_request(match[1], body)
                else:
                    validate_request(match[1], body, version)
                if gateway.clock() >= upload_deadline:
                    raise TimeoutError()
            except TimeoutError:
                return error('request_timeout')
            except (DataError, ValidationError, ValueError, TypeError, OnboardingError):
                return error('invalid_request')
            if gateway.clock() >= deadline:
                return error('request_timeout')
            if not await gateway.take_slot(deadline):
                return error(getattr(contract, 'CAPACITY_CODE', 'onboarding_capacity_busy'))
            try:
                future = asyncio.get_running_loop().run_in_executor(executor, gateway.execute, match[1], body,
                    {'assertion': assertion, 'client': client, **credentials}, deadline,
                    None if WINDOW is None else version)
            except Exception:
                gateway.slot.release()
                return error('upstream_unavailable')
            pending.add(future)
            future.add_done_callback(pending.discard)
            try:
                async with asyncio.timeout(max(0, deadline - gateway.clock())):
                    status, response, wait = await asyncio.shield(future)
                if gateway.clock() >= deadline:
                    return error('request_timeout')
                return result(status, response, wait)
            except TimeoutError:
                return error('request_timeout')
            except Exception:
                return error('upstream_unavailable')

        except BaseException:
            # A caller that vanishes mid-body must still leave a record.
            record(499, "client_disconnected")
            raise
    return app
