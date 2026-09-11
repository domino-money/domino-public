"""Shared bounded private HTTP boundary for session-authenticated services."""
import asyncio
from concurrent.futures import ThreadPoolExecutor
from contextlib import asynccontextmanager
import ipaddress
import json
import math
import os
import re
import secrets
from threading import BoundedSemaphore
import time

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from pydantic import ValidationError

from bridge_state import strict_json
from discovery import DataError
from read_deadline import read_deadline
from session_models import SessionError


MAX_WORKERS = 2
TOTAL_SECONDS = 20
UPLOAD_SECONDS = 5


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
        self.slot = BoundedSemaphore(MAX_WORKERS)

    def execute(self, route, body, headers, deadline):
        OnboardingError = self.contract.Error
        validate_response = self.contract.validate_response
        MAX_RESPONSE = self.contract.MAX_RESPONSE
        try:
            remaining = deadline - self.clock()
            if remaining <= 0:
                raise OnboardingError('request_timeout')
            with read_deadline(remaining, clock=self.clock):
                try:
                    self.verifier.verify(headers['assertion'])
                except Exception:
                    raise OnboardingError('upstream_unavailable') from None
                response = self.service.execute(route, body, client=headers['client'],
                                                session=headers['session'], csrf=headers['csrf'])
                response = validate_response(route, response)
                encoded = json.dumps(response, allow_nan=False, separators=(',', ':'))
                if len(encoded.encode()) > MAX_RESPONSE or any(headers[name] and headers[name] in encoded
                        for name in ('assertion', 'session', 'csrf')):
                    raise OnboardingError('upstream_invalid_response')
                return 200, response
        except (OnboardingError, SessionError) as error:
            normalized = OnboardingError(error.code)
            return normalized.status, {'error': normalized.code}
        except DataError:
            return 504, {'error': 'request_timeout'}
        except (ValidationError, ValueError, TypeError):
            return 502, {'error': 'upstream_invalid_response'}
        except Exception:
            return 503, {'error': 'upstream_unavailable'}
        finally:
            self.slot.release()


def create_authenticated_app(gateway):
    contract = gateway.contract
    OnboardingError = contract.Error
    validate_request = contract.validate_request
    MAX_BODY, CONTRACT_VERSION = contract.MAX_BODY, contract.CONTRACT_VERSION
    PREFIX, HEADER = contract.PREFIX, contract.HEADER
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
        deadline = gateway.clock() + gateway.total_seconds
        upload_deadline = min(deadline, gateway.clock() + gateway.upload_seconds)
        request_id = secrets.token_hex(16)

        def result(status, body):
            headers = {'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
                       'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
                       HEADER: CONTRACT_VERSION, 'X-Domino-Request-Id': request_id}
            if status == 429:
                headers['Retry-After'] = '60'
            return JSONResponse(body, status_code=status, headers=headers)

        def error(code):
            value = OnboardingError(code)
            return result(value.status, {'error': value.code})

        path = request.scope.get('raw_path', b'').decode('ascii', errors='replace')
        match = re.fullmatch(re.escape(PREFIX) + '(' + '|'.join(re.escape(route) for route in contract.REQUEST_MODELS) + ')', path)
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
        if headers.get(HEADER.lower().encode()) != CONTRACT_VERSION.encode('ascii'):
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
            validate_request(match[1], body)
            if gateway.clock() >= upload_deadline:
                raise TimeoutError()
        except TimeoutError:
            return error('request_timeout')
        except (DataError, ValidationError, ValueError, TypeError, OnboardingError):
            return error('invalid_request')
        if gateway.clock() >= deadline:
            return error('request_timeout')
        if not gateway.slot.acquire(blocking=False):
            return error(getattr(contract, 'CAPACITY_CODE', 'onboarding_capacity_busy'))
        try:
            future = asyncio.get_running_loop().run_in_executor(executor, gateway.execute, match[1], body,
                {'assertion': assertion, 'client': client, **credentials}, deadline)
        except Exception:
            gateway.slot.release()
            return error('upstream_unavailable')
        pending.add(future)
        future.add_done_callback(pending.discard)
        try:
            async with asyncio.timeout(max(0, deadline - gateway.clock())):
                status, response = await asyncio.shield(future)
            if gateway.clock() >= deadline:
                return error('request_timeout')
            return result(status, response)
        except TimeoutError:
            return error('request_timeout')
        except Exception:
            return error('upstream_unavailable')

    return app
