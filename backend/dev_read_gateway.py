"""Disabled-by-default, dedicated development read gateway (#132).

Only the reviewed HTTPS/Access ingress may reach 127.0.0.1:8891 with that exact
Host header. Its fixed upstream is the isolated development reader at 8890.
This is not a production gateway mode, an IP-impersonating Worker, or an installer.
An enabled CLI/profile is not evidence of provider quota or VM qualification.
"""
import asyncio
from dataclasses import replace
import hmac
import ipaddress
import os
from pathlib import Path
import re
import secrets
from threading import Event
import time

import anyio
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from pydantic import ValidationError

from bridge_identity import AccessVerifier
from bridge_http import LocalReaderHTTP
from bridge_state import strict_json
from dev_read_identity import Admission, DevProfile, GATEWAY_PORT, READER_PORT, PrincipalBudget, RevocableVerifier, private_directory
from discovery import DataError
from read_contract import CONTRACT_VERSION
from pool_apr_contract import CONTRACT_VERSION as V2_CONTRACT_VERSION, REQUEST_MODELS as V2_REQUEST_MODELS
from read_deadline import read_deadline
from read_gateway import Gateway, MAX_BODY, REQUEST_MODELS
from read_api import ReadGate

DEV_READS = ('token', 'pools', 'pool-market', 'wallet-assets', 'nft-positions', 'catalogue', 'pool-activity')
READ_PREFIX = '/internal/read/v1/'
V2_PREFIX = '/internal/read/v2/'
STATUS_PATH = '/internal/dev/v1/status'


def classify_reader_health(status, body, metadata):
    """The same development admission boundary protects status and real reads."""
    if not isinstance(body, dict) or not isinstance(metadata, dict):
        return {'state': 'incompatible'}
    admission = body.get('devAdmission')
    generation = body.get('generation')
    valid = (status in (200, 503) and body.get('status') == 'ok' and body.get('mode') == 'local_read_only' and
             type(body.get('busy')) is bool and type(body.get('readBudgetSeconds')) in (int, float) and
             0 < body['readBudgetSeconds'] <= 15 and isinstance(generation, str) and
             re.fullmatch(r'[0-9a-f]{32}', generation) and metadata.get('generation') == generation and
             metadata.get('contract') == CONTRACT_VERSION and isinstance(admission, dict) and
             set(admission) == {'state', 'retryAfterSeconds', 'startsPerMinute', 'minimumStartIntervalSeconds'})
    if not valid:
        return {'state': 'incompatible'}
    state, retry = admission['state'], admission['retryAfterSeconds']
    if (state not in ('ready', 'cooldown', 'qualification_disabled', 'qualification_expired') or
            type(retry) is not int or not 0 <= retry <= 60 or
            (retry == 0) != (state != 'cooldown') or
            type(admission['startsPerMinute']) is not int or admission['startsPerMinute'] != 6 or
            type(admission['minimumStartIntervalSeconds']) is not int or admission['minimumStartIntervalSeconds'] != 2 or
            status != (200 if state == 'ready' else 503)):
        return {'state': 'incompatible'}
    return {**admission, 'busy': body['busy']}


class GuardedReader:
    def __init__(self, upstream, admission):
        self.upstream, self.admission = upstream, admission

    def request(self, route, body=None, *, deadline):
        # Recheck after potentially slow health/JWKS work, before any new read.
        self.admission.check()
        if route == 'health':
            result = self.health(deadline=deadline)
            connection = classify_reader_health(*result)
            if connection['state'] == 'cooldown':
                raise DataError('read_capacity_busy')
            if connection['state'] != 'ready':
                raise DataError('upstream_unavailable')
            return result
        return self.upstream.request(route, body, deadline=deadline)

    def health(self, *, deadline):
        self.admission.check()
        return self.upstream.request('health', deadline=deadline)


class DevGateway(Gateway):
    def __init__(self, *, profile=None, admission=None, enabled=False, enabled_v2=False, verifier=None,
                 upstream=None, gate=None, clock=time.monotonic, wall_clock=time.time, cursors=None):
        if (type(enabled) is not bool or type(enabled_v2) is not bool or
                profile is not None and not isinstance(profile, DevProfile)):
            raise DataError('invalid_dev_configuration')
        if profile is None or admission is None:
            if enabled or enabled_v2 or verifier is not None:
                raise DataError('invalid_dev_configuration')
        elif admission.service_id != profile.service_id:
            raise DataError('invalid_dev_configuration')
        if isinstance(upstream, LocalReaderHTTP) and upstream.port != READER_PORT:
            raise DataError('invalid_dev_reader_port')
        self.profile, self.admission = profile, admission
        actual_verifier = None if profile is None else verifier or AccessVerifier(profile.issuer, profile.audience, profile.service_id)
        budget = None if profile is None or admission is None else PrincipalBudget(profile, admission, clock=clock)
        self.control_budget = None if profile is None or admission is None else PrincipalBudget(
            replace(profile, requests_per_minute=30, burst=5), admission, clock=clock)
        super().__init__(enabled=enabled, enabled_reads=DEV_READS,
                         enabled_v2=enabled_v2, enabled_v2_reads=('pool-market',),
                         verifier=RevocableVerifier(actual_verifier, admission) if actual_verifier and admission else None,
                         budgets=budget, upstream=GuardedReader(upstream or LocalReaderHTTP(READER_PORT, clock=clock), admission),
                         gate=gate or ReadGate(interval=2, clock=clock), clock=clock, wall_clock=wall_clock, cursors=cursors)

    def allowed(self):
        return self.verifier is not None and self.admission is not None and self.admission.allowed()

    def capabilities(self, *, version='v1'):
        enabled = self.enabled_v2 if version == 'v2' else self.enabled
        reads = ('pool-market',) if version == 'v2' else DEV_READS
        return {'contractVersion': V2_CONTRACT_VERSION if version == 'v2' else CONTRACT_VERSION,
                'dataMode': 'live_read_only' if enabled else 'disabled',
                'chainId': 4663, 'enabledReads': list(reads) if enabled else [],
                'walletAuthentication': False, 'privateAccounts': False, 'ownerTransactions': False, 'automation': False}

    def reader_connection(self, deadline):
        """A bounded local admission probe, never provider/SQL qualification."""
        try:
            health = self.upstream.health(deadline=min(deadline, self.clock() + 3))
        except DataError as error:
            if str(error) == 'service_identity_invalid':
                raise
            return {'state': 'incompatible' if str(error) in ('upstream_invalid_response', 'upstream_contract_mismatch') else 'unavailable'}
        return classify_reader_health(*health)

    def status(self, connection):
        # Operator-attested installed release metadata, never frontend main or
        # a provider-health claim. The installer must verify these exact hashes.
        return {'schemaVersion': 1, 'environment': 'development', 'authenticated': True,
                'readEnabled': self.enabled, 'contractVersion': CONTRACT_VERSION,
                'readerCommit': self.profile.reader_commit, 'gatewayCommit': self.profile.gateway_commit,
                'releaseMetadataSource': 'operator_profile',
                'contractManifestSha256': self.profile.contract_manifest_sha256,
                'enabledReads': list(DEV_READS) if self.enabled else [],
                'providerHealth': 'not_probed', 'readerConnection': connection,
                'gatewayAdmission': {'requestsPerMinute': self.profile.requests_per_minute,
                    'burst': self.profile.burst, 'maxInFlight': 1, 'minimumStartIntervalSeconds': 2,
                    'controlRequestsPerMinute': 30, 'controlBurst': 5, 'upstreamBudgetSeconds': 15}}

    def execute_dev(self, route, body, assertion, deadline, *, version='v1'):
        if route not in ('capabilities', 'status'):
            # Existing execution owns and releases admission, including shielded
            # upstream work. Its client is the configured, verified principal.
            result = super().execute(route, body, assertion, self.profile.service_id, deadline, version=version)
            return result if self.allowed() else (403, {'error': 'upstream_unavailable'})
        try:
            remaining = deadline - self.clock()
            if remaining <= 0:
                return 504, {'error': 'upstream_timeout'}
            with read_deadline(remaining, clock=self.clock):
                self.verifier.verify(assertion)
            if self.clock() >= deadline:
                return 504, {'error': 'upstream_timeout'}
            if not self.control_budget.admit(self.profile.service_id):
                return 429, {'error': 'read_capacity_busy'}
            connection = self.reader_connection(deadline) if route == 'status' else None
            self.admission.check()
            if self.clock() >= deadline:
                return 504, {'error': 'upstream_timeout'}
            return 200, self.capabilities(version=version) if route == 'capabilities' else self.status(connection)
        except DataError:
            return 403, {'error': 'upstream_unavailable'}
        finally:
            self.gate.slot.release()


def create_dev_gateway(gateway=None):
    gateway = gateway or DevGateway()
    app = FastAPI(title='Domino development read gateway', docs_url=None, redoc_url=None, openapi_url=None)

    @app.middleware('http')
    async def boundary(request: Request, call_next):
        deadline, request_id = gateway.clock() + 20, secrets.token_hex(16)
        path = request.scope.get('raw_path', b'').decode('ascii', errors='replace')
        version = 'v2' if path.startswith(V2_PREFIX) else 'v1'
        contract = V2_CONTRACT_VERSION if version == 'v2' else CONTRACT_VERSION
        def result(status, data):
            headers = {'Cache-Control': 'no-store, no-transform', 'X-Content-Type-Options': 'nosniff',
                       'X-Domino-Read-Contract': contract, 'X-Domino-Request-Id': request_id,
                       'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'"}
            if status == 429:
                headers['Retry-After'] = '2'
            return JSONResponse(data, status_code=status, headers=headers)
        prefix = V2_PREFIX if version == 'v2' else READ_PREFIX
        models = V2_REQUEST_MODELS if version == 'v2' else REQUEST_MODELS
        reads = ('pool-market',) if version == 'v2' else DEV_READS
        route = 'status' if path == STATUS_PATH else path[len(prefix):] if path.startswith(prefix) else None
        if route not in (*reads, 'capabilities', 'status') or request.scope.get('query_string') or (route == 'status' and path != STATUS_PATH):
            return result(404, {'error': 'route_not_available'})
        control = route in ('capabilities', 'status')
        if request.method != ('GET' if control else 'POST'):
            return result(405, {'error': 'method_not_allowed'})
        headers = {}
        if sum(len(k) + len(v) for k, v in request.scope['headers']) > 32768:
            return result(422, {'error': 'invalid_request'})
        for name, value in request.scope['headers']:
            name = name.lower()
            if name in headers:
                return result(422, {'error': 'invalid_request'})
            headers[name] = value
        if headers.get(b'host') != b'127.0.0.1:8891' or any(k in headers for k in (b'origin', b'authorization', b'x-domino-client-id')):
            return result(403, {'error': 'origin_not_allowed'})
        if headers.get(b'x-domino-read-contract', contract.encode()) != contract.encode():
            return result(502, {'error': 'upstream_contract_mismatch'})
        try:
            if not ipaddress.ip_address(request.client.host).is_loopback:
                raise ValueError()
        except (AttributeError, ValueError):
            return result(403, {'error': 'origin_not_allowed'})
        # Proxy IP headers are neither required nor trusted. Cloudflare may add
        # them; all callers still share the one authenticated principal/bucket.
        assertion = headers.get(b'cf-access-jwt-assertion', b'')
        if len(assertion) > 8192 or not re.fullmatch(rb'[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+', assertion):
            return result(403, {'error': 'upstream_unavailable'})
        cookie = headers.get(b'cookie')
        if cookie is not None and not hmac.compare_digest(cookie.strip(b' \t'), b'CF_Authorization=' + assertion):
            return result(403, {'error': 'origin_not_allowed'})
        if not gateway.allowed():
            return result(403, {'error': 'upstream_unavailable'})
        if not control and not (gateway.enabled_v2 if version == 'v2' else gateway.enabled):
            return result(404, {'error': 'route_not_available'})
        body = None
        if control:
            if headers.get(b'content-length', b'0') != b'0' or b'transfer-encoding' in headers:
                return result(422, {'error': 'invalid_request'})
        else:
            if (headers.get(b'content-type', b'').split(b';')[0].strip().lower() != b'application/json' or
                    headers.get(b'content-encoding', b'identity') != b'identity'):
                return result(415, {'error': 'json_required'})
            raw = bytearray()
            try:
                async with asyncio.timeout(5):
                    async for chunk in request.stream():
                        raw.extend(chunk)
                        if len(raw) > MAX_BODY:
                            return result(413, {'error': 'request_too_large'})
                body = strict_json(raw)
                models[route].model_validate(body)
            except TimeoutError:
                return result(408, {'error': 'request_timeout'})
            except (DataError, ValidationError, ValueError, TypeError):
                return result(422, {'error': 'invalid_request'})
        # Re-read operator admission after upload, immediately before acquiring
        # the global slot. Verification and upstream dispatch check it again.
        if not gateway.allowed():
            return result(403, {'error': 'upstream_unavailable'})
        # Control metadata needs the same actual worker/slot but spends neither
        # the read quota nor its start interval. Its own bucket bounds GETs.
        admitted = gateway.gate.slot.acquire(blocking=False) if control else gateway.gate.enter()
        if not admitted:
            return result(429, {'error': 'read_capacity_busy'})
        started = Event()
        def execute():
            started.set()
            return gateway.execute_dev(route, body, assertion.decode('ascii'), deadline, version=version)
        try:
            with anyio.CancelScope(shield=True):
                status, data = await anyio.to_thread.run_sync(execute, abandon_on_cancel=False, limiter=app.state.worker_limiter)
            return result(status, data)
        except Exception:
            return result(503, {'error': 'upstream_unavailable'})
        finally:
            if not started.is_set():
                gateway.gate.slot.release()

    app.state.gateway, app.state.worker_limiter = gateway, anyio.CapacityLimiter(1)
    return app


def acquire_runtime_lock(path, profile_path):
    import fcntl
    path, profile_path = Path(path), Path(profile_path)
    if path.name != 'dev-read-gateway' or path == profile_path.parent or path in profile_path.parents:
        raise DataError('invalid_dev_runtime')
    directory = private_directory(path)
    try:
        fd = os.open('gateway.lock', os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW | os.O_NONBLOCK, 0o600, dir_fd=directory)
        try:
            import stat
            info = os.fstat(fd)
            if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_nlink != 1 or stat.S_IMODE(info.st_mode) != 0o600:
                raise DataError('invalid_dev_runtime')
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            return fd
        except BaseException:
            os.close(fd)
            raise
    finally:
        os.close(directory)


def main():
    import argparse
    import uvicorn
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--profile', type=Path, required=True)
    parser.add_argument('--runtime-dir', type=Path, required=True)
    parser.add_argument('--port', type=int, required=True, choices=(GATEWAY_PORT,))
    parser.add_argument('--reader-port', type=int, required=True, choices=(READER_PORT,))
    parser.add_argument('--enable', action='store_true')
    parser.add_argument('--enable-v2', action='store_true', help='Opt in to public pool-market estimates')
    args = parser.parse_args()
    fd = None
    try:
        if any(os.environ.get(name, '1') != '1' for name in ('WEB_CONCURRENCY', 'UVICORN_WORKERS')):
            raise DataError('single_dev_gateway_process_required')
        profile = DevProfile.load(args.profile)
        fd = acquire_runtime_lock(args.runtime_dir, args.profile)
        admission = Admission(args.profile.parent / 'admission.json', profile.service_id)
        if args.enable or args.enable_v2:
            admission.check()
        gateway = DevGateway(profile=profile, admission=admission, enabled=args.enable, enabled_v2=args.enable_v2)
        uvicorn.run(create_dev_gateway(gateway), host='127.0.0.1', port=GATEWAY_PORT, workers=1,
                    proxy_headers=False, access_log=False, server_header=False, limit_concurrency=16)
    except (DataError, OSError, ValueError, TypeError):
        parser.exit(2, 'Development gateway configuration invalid or process already running.\n')
    finally:
        if fd is not None:
            os.close(fd)


if __name__ == '__main__':
    main()
