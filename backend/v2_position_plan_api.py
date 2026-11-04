"""Disabled-by-default private listener for S1 plans (position-plan-v1). Plans and simulations; never a signer.

The same boundary as the onboarding, deposit and cross-chain listeners
(authenticated_api.py): loopback only, POST, the Cloudflare Access assertion,
a SIWE session and CSRF, a closed contract header. Route:
/internal/position-plan/v1/plan. Configuration, keys and manifests:
v2_position_plan_config.py and docs/v2/V2_S1_PLAN_API.md.
"""
import os
from pathlib import Path
import re
from types import SimpleNamespace

from discovery import DataError
import v2_position_plan_models as models
from authenticated_api import AuthenticatedGateway, create_authenticated_app

PREFIX = '/internal/position-plan/v1/'
HEADER = 'X-Domino-Position-Plan-Contract'
DEFAULT_PORT = 8911
RESERVED_PORTS = (8765, 8876, 8877, 8878, 8879, 8880, 8881, 8900, 8901, 8910)
HEAD_MAX_AGE_SECONDS = 2
CONTRACT = SimpleNamespace(PREFIX=PREFIX, HEADER=HEADER, Error=models.PositionPlanError,
    CONTRACT_VERSION=models.CONTRACT_VERSION, MAX_BODY=models.MAX_BODY, MAX_RESPONSE=models.MAX_RESPONSE,
    REQUEST_MODELS=models.REQUEST_MODELS, CAPACITY_CODE='position_plan_capacity_busy',
    validate_request=models.validate_request, validate_response=models.validate_response)


class PositionPlanGateway(AuthenticatedGateway):
    def __init__(self, **kwargs):
        super().__init__(contract=CONTRACT, **kwargs)


def create_position_plan_app(gateway=None):
    return create_authenticated_app(gateway or PositionPlanGateway())


def build_planners(settings, *, provider_config=None, registry=None):
    """One planner per enabled chain, from validated settings; no network until a request arrives.

    Robinhood reads through the read path's provider file (the own node first);
    Base and Arbitrum through the V2 chain RPC file's hosted endpoints, billed
    per call. Each chain's head is shared through DOMINO_V2_HEAD_DIRECTORY when set.
    Every call goes over a kept HTTPS connection (v2_chain_reads.kept_rpc, since
    3 Nov 2026): a plan makes about ten, and a new TLS handshake each tripled
    Chainstack's round trip from the VM (5 Oct 2026: 360 ms against 118 ms).
    """
    from v2_chain_reads import kept_rpc
    from v2_chains import default_registry
    from v2_head import HeadFollower
    from v2_position_plan import PositionPlanner
    from v2_position_plan_config import load_chain_deployment
    from v2_rpc import configured_endpoints, load_chain_rpc_config
    from v2_uniswap_api import TradingApiLegs
    registry = registry or default_registry()
    rpc_config = load_chain_rpc_config(settings.chain_rpc_file) if settings.chain_rpc_file else None
    router_legs = TradingApiLegs(settings.uniswap_api_key) if settings.uniswap_api_key else None
    planners = {}
    for key in settings.chains:
        chain = registry.chain(key)
        deployment = load_chain_deployment(settings.manifests[key], chain)
        endpoints = configured_endpoints(chain, provider_config=provider_config, chain_rpc_config=rpc_config,
                                         send=kept_rpc)
        shared = Path(settings.head_directory) / f'{key}.head.json' if settings.head_directory else None
        follower = HeadFollower(endpoints, max_age_seconds=HEAD_MAX_AGE_SECONDS, shared_path=shared)
        planners[chain.chainId] = PositionPlanner(chain, endpoints, follower, deployment, router_legs=router_legs)
    return planners


def main():
    import argparse
    import uvicorn
    from bridge_identity import AccessVerifier, configured_preview_identity
    from session_siwe import configured_preview_origins
    from catalogue import database_settings
    from local_config import load_config
    from onboarding_auth import OnboardingAuth
    from rpc_config import configured_rpc_urls, DEFAULT_RPC_HOSTS
    from session_api import acquire_session_lock, load_session_rpc_config
    from session_chain import EoaChecker
    from session_store import SessionStore
    from v2_position_plan_config import ConfigError, load_settings
    from v2_position_plan_service import PositionPlanService
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--enable', action='store_true')
    parser.add_argument('--port', type=int, default=DEFAULT_PORT)
    parser.add_argument('--rpc-config', type=Path, help='Robinhood read path provider file (the own node first)')
    args, lock, problem = parser.parse_args(), None, None
    try:
        if args.port in RESERVED_PORTS or not 1024 <= args.port <= 65535:
            raise ValueError()
        if any(os.environ.get(name, '1') != '1' for name in ('WEB_CONCURRENCY', 'UVICORN_WORKERS')):
            raise ValueError()
        lock = acquire_session_lock(Path(__file__).resolve().parent / 'runtime' / 'position-plan')
        gateway = PositionPlanGateway()
        if args.enable:
            settings = load_settings()
            config = load_session_rpc_config(args.rpc_config)
            secret = os.environ.get('DOMINO_SESSION_ABUSE_SECRET', '')
            if not re.fullmatch(r'[0-9a-f]{64}', secret):
                raise ValueError()
            hosts = config.get('rpcAllowedHosts', DEFAULT_RPC_HOSTS)
            auth = OnboardingAuth(SessionStore(database_settings(), abuse_secret=bytes.fromhex(secret)),
                                  EoaChecker(configured_rpc_urls(config), allowed_hosts=hosts))
            provider = load_config(args.rpc_config) if args.rpc_config else None
            planners = build_planners(settings, provider_config=provider)
            # Review L1 (4 Nov 2026): the separate preview Workers' own Access identity, optional.
            verifier = AccessVerifier(os.environ.get('DOMINO_POSITION_PLAN_ACCESS_ISSUER'),
                os.environ.get('DOMINO_POSITION_PLAN_ACCESS_AUDIENCE'), os.environ.get('DOMINO_POSITION_PLAN_ACCESS_SERVICE_ID'),
                preview_service_id=configured_preview_identity(os.environ.get('DOMINO_POSITION_PLAN_ACCESS_PREVIEW_SERVICE_ID'),
                    os.environ.get('DOMINO_POSITION_PLAN_ACCESS_SERVICE_ID'), 'DOMINO_POSITION_PLAN_ACCESS_PREVIEW_SERVICE_ID'))
            service = PositionPlanService(auth, planners, private_values=settings.private_values())
            gateway = PositionPlanGateway(service=service, verifier=verifier,
                                          origin=os.environ.get('DOMINO_SESSION_ORIGIN'),
                                          preview_origins=configured_preview_origins(os.environ.get('DOMINO_SESSION_PREVIEW_ORIGINS'),
                    os.environ.get('DOMINO_SESSION_ORIGIN'), 'DOMINO_SESSION_PREVIEW_ORIGINS'), enabled=True)
    except ConfigError as error:
        problem = str(error)  # the setting's name only, never its value
    except (ValueError, DataError, OSError):
        problem = 'configuration invalid or process already running'
    if problem is not None:
        if lock is not None:
            os.close(lock)
        parser.exit(2, f'Position plan listener: {problem}.\n')
    try:
        uvicorn.run(create_position_plan_app(gateway), host='127.0.0.1', port=args.port, workers=1,
                    proxy_headers=False, access_log=False, server_header=False, limit_concurrency=16)
    finally:
        os.close(lock)


if __name__ == '__main__':
    main()
