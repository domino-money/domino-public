"""Disabled-by-default private listener for season 1's points (points-v1). Reads and records; never a signer.

The same boundary as the onboarding, deposit, cross-chain and plan listeners
(authenticated_api.py): loopback only, POST, the Cloudflare Access assertion,
a SIWE session and CSRF, a closed contract header. Routes:
/internal/points/v1/points and /internal/points/v1/link. It logs in as the
session role and reaches the points schema only through migration 059's
functions (points_service.py). docs/points/POINTS.md, part 3.
"""
import os
from pathlib import Path
import re
from types import SimpleNamespace

from discovery import DataError
import points_models as models
from authenticated_api import AuthenticatedGateway, create_authenticated_app

PREFIX = '/internal/points/v1/'
HEADER = 'X-Domino-Points-Contract'
DEFAULT_PORT = 8912
RESERVED_PORTS = (8765, 8876, 8877, 8878, 8879, 8880, 8881, 8900, 8901, 8910, 8911)
CONTRACT = SimpleNamespace(PREFIX=PREFIX, HEADER=HEADER, Error=models.PointsError,
    CONTRACT_VERSION=models.CONTRACT_VERSION, MAX_BODY=models.MAX_BODY, MAX_RESPONSE=models.MAX_RESPONSE,
    REQUEST_MODELS=models.REQUEST_MODELS, CAPACITY_CODE='points_capacity_busy',
    validate_request=models.validate_request, validate_response=models.validate_response)


class PointsGateway(AuthenticatedGateway):
    def __init__(self, **kwargs):
        super().__init__(contract=CONTRACT, **kwargs)


def create_points_app(gateway=None):
    return create_authenticated_app(gateway or PointsGateway())


def main():
    import argparse
    import uvicorn
    from bridge_identity import AccessVerifier, configured_preview_identity
    from catalogue import database_settings
    from onboarding_auth import OnboardingAuth
    from points_engine import load_season
    from points_service import PointsService
    from rpc_config import configured_rpc_urls, DEFAULT_RPC_HOSTS
    from session_api import acquire_session_lock, load_session_rpc_config
    from session_chain import EoaChecker
    from session_siwe import configured_preview_origins
    from session_store import SessionStore
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--enable', action='store_true')
    parser.add_argument('--port', type=int, default=DEFAULT_PORT)
    parser.add_argument('--rpc-config', type=Path, help='Robinhood read path provider file (the session account check)')
    args, lock, problem = parser.parse_args(), None, None
    try:
        if args.port in RESERVED_PORTS or not 1024 <= args.port <= 65535:
            raise ValueError()
        if any(os.environ.get(name, '1') != '1' for name in ('WEB_CONCURRENCY', 'UVICORN_WORKERS')):
            raise ValueError()
        lock = acquire_session_lock(Path(__file__).resolve().parent / 'runtime' / 'points')
        gateway = PointsGateway()
        if args.enable:
            database = database_settings()
            if database is None:
                raise ValueError()
            config = load_session_rpc_config(args.rpc_config)
            secret = os.environ.get('DOMINO_SESSION_ABUSE_SECRET', '')
            if not re.fullmatch(r'[0-9a-f]{64}', secret):
                raise ValueError()
            hosts = config.get('rpcAllowedHosts', DEFAULT_RPC_HOSTS)
            auth = OnboardingAuth(SessionStore(database, abuse_secret=bytes.fromhex(secret)),
                                  EoaChecker(configured_rpc_urls(config), allowed_hosts=hosts))
            verifier = AccessVerifier(os.environ.get('DOMINO_POINTS_ACCESS_ISSUER'),
                os.environ.get('DOMINO_POINTS_ACCESS_AUDIENCE'), os.environ.get('DOMINO_POINTS_ACCESS_SERVICE_ID'),
                preview_service_id=configured_preview_identity(os.environ.get('DOMINO_POINTS_ACCESS_PREVIEW_SERVICE_ID'),
                    os.environ.get('DOMINO_POINTS_ACCESS_SERVICE_ID'), 'DOMINO_POINTS_ACCESS_PREVIEW_SERVICE_ID'))
            service = PointsService(auth, database, load_season())
            gateway = PointsGateway(service=service, verifier=verifier, origin=os.environ.get('DOMINO_SESSION_ORIGIN'),
                                    preview_origins=configured_preview_origins(os.environ.get('DOMINO_SESSION_PREVIEW_ORIGINS'),
                    os.environ.get('DOMINO_SESSION_ORIGIN'), 'DOMINO_SESSION_PREVIEW_ORIGINS'), enabled=True)
    except (ValueError, DataError, OSError):
        problem = 'configuration invalid or process already running'
    if problem is not None:
        if lock is not None:
            os.close(lock)
        parser.exit(2, f'Points listener: {problem}.\n')
    try:
        uvicorn.run(create_points_app(gateway), host='127.0.0.1', port=args.port, workers=1,
                    proxy_headers=False, access_log=False, server_header=False, limit_concurrency=16)
    finally:
        os.close(lock)


if __name__ == '__main__':
    main()
