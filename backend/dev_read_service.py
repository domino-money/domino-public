"""Explicitly disabled development-only reader; no production config fallback."""
from contextlib import contextmanager
from functools import wraps
import json
import os
from pathlib import Path
import re
import stat
import time

import psycopg
from psycopg.rows import dict_row
from fastapi import FastAPI
from fastapi.responses import JSONResponse

from catalogue import PgCatalogue
from discovery import DataError, json_http
from dev_read_budget import DevelopmentBudgets, DevelopmentGate, DevelopmentTransport
from inventory import CursorCodec, inventory_endpoint
from market_cache import MarketCache
from market_data import GeckoMarketData
from read_api import LocalReadBoundary, create_app
from read_contract import CONTRACT_VERSION
from read_deadline import check_read_deadline, read_timeout
from read_service import ReadService
from rpc_config import DEFAULT_RPC_HOSTS, rpc_endpoint


PORT = 8890
READS = frozenset(('token', 'pools', 'pool-market', 'wallet-assets',
                  'nft-positions', 'catalogue', 'pool-activity'))
CODE_ROOT = Path(__file__).resolve().parents[1]
PROFILE_KEYS = {'version', 'kind', 'enabled', 'runtimeDirectory', 'rpcUrls',
                'inventoryUrl', 'catalogue', 'quotaQualification'}


def _private_path(path, *, directory=False):
    path = Path(path)
    if not path.is_absolute() or '..' in path.parts or path.is_relative_to(CODE_ROOT):
        raise ValueError()
    for parent in path.parents:
        # Also exclude other checkouts of this product, including the operator's
        # production backend/runtime. No configuration contents are inspected.
        if (parent / 'AGENTS.md').is_file() and (parent / 'backend/read_service.py').is_file():
            raise ValueError()
    # O_NOFOLLOW on the leaf alone does not reject a symlinked parent.
    for component in (*reversed(path.parents), path):
        if component.is_symlink():
            raise ValueError()
    info = path.lstat()
    expected = stat.S_ISDIR if directory else stat.S_ISREG
    if (not expected(info.st_mode) or info.st_uid != os.getuid()
            or info.st_mode & 0o077 or (not directory and info.st_nlink != 1)):
        raise ValueError()
    return path


def _directory_fd(path):
    """Walk with directory handles: no symlink or mutable foreign ancestor race."""
    path = _private_path(path, directory=True)
    fd = os.open('/', os.O_RDONLY | os.O_DIRECTORY)
    try:
        for name in path.parts[1:]:
            child = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            os.close(fd)
            fd = child
            info = os.fstat(fd)
            shared_sticky = info.st_uid == 0 and bool(info.st_mode & stat.S_ISVTX)
            if (info.st_uid not in (0, os.getuid())
                    or (info.st_mode & 0o022 and not shared_sticky)):
                raise ValueError()
        info = os.fstat(fd)
        if info.st_uid != os.getuid() or info.st_mode & 0o077:
            raise ValueError()
        return fd
    except BaseException:
        os.close(fd)
        raise


def load_profile(path):
    """One private self-owned file, bounded schema; never environment/provider defaults."""
    try:
        path = _private_path(path)
        _private_path(path.parent, directory=True)
        parent_fd = _directory_fd(path.parent)
        try:
            fd = os.open(path.name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent_fd)
        finally:
            os.close(parent_fd)
        with os.fdopen(fd) as stream:
            info = os.fstat(stream.fileno())
            if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid()
                    or info.st_mode & 0o077 or info.st_nlink != 1):
                raise ValueError()
            raw = stream.read(8193)
        if len(raw) > 8192:
            raise ValueError()
        def unique(pairs):
            result = {}
            for key, value in pairs:
                if key in result:
                    raise ValueError()
                result[key] = value
            return result
        return checked_profile(json.loads(raw, object_pairs_hook=unique))
    except (OSError, ValueError, TypeError, DataError):
        raise DataError('development_profile_unavailable') from None


def checked_profile(data):
    try:
        if (type(data) is not dict or set(data) != PROFILE_KEYS
                or type(data['version']) is not int or data['version'] != 1
                or data['kind'] != 'domino-development-reader' or type(data['enabled']) is not bool):
            raise ValueError()
        _private_path(data['runtimeDirectory'], directory=True)
        urls = data['rpcUrls']
        if (type(urls) is not list or not 1 <= len(urls) <= 3
                or len(set(urls)) != len(urls)):
            raise ValueError()
        for url in urls:
            rpc_endpoint(url, DEFAULT_RPC_HOSTS)
        if data['inventoryUrl'] is not None:
            if type(data['inventoryUrl']) is not str:
                raise ValueError()
            inventory_endpoint(data['inventoryUrl'])
        qualification = data['quotaQualification']
        if (type(qualification) is not dict
                or set(qualification) != {'approved', 'expiresAt', 'receiptSha256'}
                or type(qualification['approved']) is not bool
                or type(qualification['expiresAt']) is not int
                or not 0 <= qualification['expiresAt'] <= 2**53 - 1
                or type(qualification['receiptSha256']) is not str
                or not re.fullmatch(r'[0-9a-f]{64}', qualification['receiptSha256'])):
            raise ValueError()
        database = data['catalogue']
        if database is not None and (type(database) is not dict
                or set(database) != {'host', 'port', 'dbname'}
                or type(database['host']) is not str
                or not re.fullmatch(r'/[A-Za-z0-9_/.-]{1,200}', database['host'])
                or '..' in Path(database['host']).parts or ',' in database['host']
                or type(database['port']) is not int or not 1024 <= database['port'] <= 65535
                or database['dbname'] != 'domino_catalogue'):
            raise ValueError()
        return data
    except (OSError, ValueError, TypeError, DataError):
        raise DataError('development_profile_unavailable') from None


class _DevelopmentCursor:
    def __init__(self, cursor):
        self.cursor = cursor

    def fetchone(self):
        check_read_deadline()
        result = self.cursor.fetchone()
        check_read_deadline()
        return result

    def fetchall(self):
        check_read_deadline()
        result = self.cursor.fetchall()
        check_read_deadline()
        return result


class _DevelopmentConnection:
    """Only the query surface used by public readers, with one total deadline."""
    def __init__(self, connection):
        self.connection = connection

    def execute(self, query, params=None):
        check_read_deadline()
        milliseconds = max(1, int(read_timeout(1) * 1000))
        # Only a computed integer enters SQL; no user input or persistent SET.
        self.connection.execute(f"SET LOCAL statement_timeout='{milliseconds}ms'")
        check_read_deadline()
        result = self.connection.execute(query, params)
        check_read_deadline()
        return _DevelopmentCursor(result)


class DevelopmentCatalogue(PgCatalogue):
    @contextmanager
    def connection(self, *, writer=False, lock=False):
        if writer or lock:
            raise DataError('catalogue_database_unavailable')
        try:
            # libpq's connection timeout has a two-second minimum. Do not
            # start a fresh connection when the logical read cannot afford it.
            if read_timeout(2) < 2:
                raise DataError('read_deadline_exceeded')
            with psycopg.connect(**self.settings, user='domino_dev_catalogue_reader',
                                 connect_timeout=2, row_factory=dict_row,
                                 options='-c default_transaction_read_only=on -c statement_timeout=1000',
                                 application_name='domino-development-reader') as conn:
                bounded = _DevelopmentConnection(conn)
                bounded.execute('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')
                bounded.execute("SET LOCAL lock_timeout='100ms'")
                bounded.execute("SET LOCAL work_mem='1MB'")
                yield bounded
                check_read_deadline()
        except psycopg.Error:
            raise DataError('catalogue_database_unavailable') from None


def _operation(method):
    @wraps(method)
    def bounded(self, *args, **kwargs):
        with self.development_budgets.operation():
            return method(self, *args, **kwargs)
    return bounded


class DevelopmentReadService(ReadService):
    def __init__(self, profile, *, transport=json_http, clock=time.time, monotonic=time.monotonic):
        profile = checked_profile(profile)
        qualification = profile['quotaQualification']
        self.development_budgets = DevelopmentBudgets(
            qualified=profile['enabled'] and qualification['approved'],
            expires_at=qualification['expiresAt'], clock=monotonic, wall_clock=clock)
        bounded = DevelopmentTransport(self.development_budgets, rpc_urls=profile['rpcUrls'],
                                       inventory_url=profile['inventoryUrl'], transport=transport)
        market = MarketCache(GeckoMarketData(transport=bounded, clock=clock), clock=monotonic)
        market.requests_per_minute = 3
        super().__init__(rpc_urls=tuple(profile['rpcUrls']), inventory_url=profile['inventoryUrl'],
                         clock=clock, transport_factory=lambda: bounded,
                         cursor_codec=CursorCodec(clock=clock), market_cache=market,
                         catalogue=DevelopmentCatalogue(profile['catalogue']) if profile['catalogue'] else None)

    token = _operation(ReadService.token)
    pools = _operation(ReadService.pools)
    pool_market = _operation(ReadService.pool_market)
    wallet_assets = _operation(ReadService.wallet_assets)
    nft_positions = _operation(ReadService.nft_positions)
    catalogue_page = _operation(ReadService.catalogue_page)
    pool_activity = _operation(ReadService.pool_activity)

    def pool_positions(self, *args, **kwargs):
        raise DataError('route_not_available')

    def pool_metrics(self, *args, **kwargs):
        raise DataError('route_not_available')


class DevelopmentBoundary:
    def __init__(self, app, *, enabled, gate=None):
        self.app, self.enabled, self.gate = app, enabled, gate

    async def __call__(self, scope, receive, send):
        if scope['type'] != 'http':
            return await self.app(scope, receive, send)
        raw = scope.get('raw_path', b'')
        allowed = {b'/health', b'/v1/capabilities'} | {
            ('/v1/read/' + route).encode() for route in READS}
        if scope.get('query_string') or raw not in allowed:
            response = JSONResponse({'error': 'route_not_available'}, status_code=404)
        elif not self.enabled:
            response = JSONResponse({'error': 'upstream_unavailable'}, status_code=503)
        elif raw == b'/health':
            admission = self.gate.admission()
            start, chunks = None, []
            async def health_send(message):
                nonlocal start
                if message['type'] == 'http.response.start':
                    start = message
                elif message['type'] == 'http.response.body':
                    chunks.append(message.get('body', b''))
                    if message.get('more_body', False):
                        return
                    # This fixed, private route contains no provider content.
                    body = json.loads(b''.join(chunks))
                    body['devAdmission'] = admission
                    encoded = json.dumps(body, separators=(',', ':')).encode()
                    start['headers'] = [(k, v) for k, v in start['headers'] if k.lower() != b'content-length']
                    start['headers'].append((b'content-length', str(len(encoded)).encode()))
                    if admission['state'] != 'ready':
                        start['status'] = 503
                        if admission['retryAfterSeconds']:
                            start['headers'].append((b'retry-after', str(admission['retryAfterSeconds']).encode()))
                    await send(start)
                    await send({'type': 'http.response.body', 'body': encoded})
            return await self.app(scope, receive, health_send)
        else:
            try:
                # Health/capabilities may not describe an expired reader as
                # ready; stored-catalogue reads also require qualification.
                self.gate.budgets.check()
            except DataError:
                response = JSONResponse({'error': 'upstream_unavailable'}, status_code=503)
            else:
                return await self.app(scope, receive, send)
        response.headers['X-Domino-Read-Contract'] = CONTRACT_VERSION
        response.headers['Cache-Control'] = 'no-store'
        return await response(scope, receive, send)


def create_dev_app(profile=None, *, enable=False, transport=json_http,
                   clock=time.time, monotonic=time.monotonic):
    if type(enable) is not bool:
        raise DataError('development_profile_unavailable')
    gate = None
    if enable:
        profile = checked_profile(profile)
        qualification = profile['quotaQualification']
        if not profile['enabled'] or not qualification['approved'] or clock() >= qualification['expiresAt']:
            raise DataError('development_qualification_required')
        service = DevelopmentReadService(profile, transport=transport, clock=clock, monotonic=monotonic)
        gate = DevelopmentGate(service.development_budgets)
        app = create_app(service, gate=gate, read_budget_seconds=15)
    else:
        # Avoid create_app(None): that would read production runtime defaults.
        app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)
    app.add_middleware(DevelopmentBoundary, enabled=enable, gate=gate)
    app.add_middleware(LocalReadBoundary)
    return app


@contextmanager
def reader_lock(runtime):
    """One service instance, with a dedicated lock outside every code checkout."""
    import fcntl
    fd = None
    try:
        runtime = _private_path(runtime, directory=True)
        directory_fd = _directory_fd(runtime)
        try:
            fd = os.open('dev-reader.lock', os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600, dir_fd=directory_fd)
        finally:
            os.close(directory_fd)
        info = os.fstat(fd)
        if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid()
                or info.st_mode & 0o077 or info.st_nlink != 1):
            raise ValueError()
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        yield
    except (OSError, ValueError):
        raise DataError('development_reader_lock_unavailable') from None
    finally:
        if fd is not None:
            os.close(fd)


def main():
    import argparse
    import uvicorn
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--enable', action='store_true')
    parser.add_argument('--profile')
    args = parser.parse_args()
    if any(os.environ.get(name, '1') != '1' for name in ('WEB_CONCURRENCY', 'UVICORN_WORKERS')):
        parser.error('single development reader required')
    try:
        if args.enable:
            if not args.profile:
                raise DataError('development_profile_required')
            profile = load_profile(args.profile)
            with reader_lock(profile['runtimeDirectory']):
                app = create_dev_app(profile, enable=True)
                uvicorn.run(app, host='127.0.0.1', port=PORT, access_log=False, proxy_headers=False,
                            server_header=False, limit_concurrency=8, workers=1)
        else:
            uvicorn.run(create_dev_app(), host='127.0.0.1', port=PORT, access_log=False,
                        proxy_headers=False, server_header=False, limit_concurrency=8, workers=1)
    except DataError:
        parser.error('development reader unavailable; check private profile, qualification and instance lock')


if __name__ == '__main__':
    main()
