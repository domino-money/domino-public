"""Disabled-by-default private listener for the deposit from another chain (S2). Quotes and tracking; never a signer.

Same boundary as the onboarding and deposit listeners (authenticated_api.py):
loopback only, POST, the Cloudflare Access assertion, a SIWE session and CSRF,
a closed contract header. Routes: /internal/crosschain/v1/{origins,quote,status}.
Configuration and keys: crosschain_config.py and docs/v2/F5_BRIDGE.md.

The header may name 1.1.0-rc.1 or, for the switch window, 1.0.0-rc.1
(CONTRACT_VERSIONS): the answer, its header and the request's line carry the
version the request named (crosschain_models).
"""
import os
import re
from types import SimpleNamespace

from discovery import DataError
import crosschain_models as models
from authenticated_api import AuthenticatedGateway, create_authenticated_app
from session_api import acquire_session_lock, load_session_rpc_config

PREFIX = '/internal/crosschain/v1/'
HEADER = 'X-Domino-Crosschain-Contract'
DEFAULT_PORT = 8910
RESERVED_PORTS = (8765, 8876, 8877, 8878, 8879, 8880, 8881, 8900, 8901)
CONTRACT = SimpleNamespace(PREFIX=PREFIX, HEADER=HEADER, Error=models.CrosschainError,
    CONTRACT_VERSION=models.CONTRACT_VERSION, CONTRACT_VERSIONS=models.CONTRACT_VERSIONS,
    MAX_BODY=models.MAX_BODY, MAX_RESPONSE=models.MAX_RESPONSE,
    REQUEST_MODELS=models.REQUEST_MODELS, CAPACITY_CODE='crosschain_capacity_busy',
    validate_request=models.validate_request, validate_response=models.validate_response)


class CrosschainGateway(AuthenticatedGateway):
    def __init__(self, **kwargs):
        super().__init__(contract=CONTRACT, **kwargs)


def create_crosschain_app(gateway=None):
    return create_authenticated_app(gateway or CrosschainGateway())


def build_service(settings, auth, *, robinhood_rpc=None, chain_endpoints=None):
    """The service and its two providers from validated settings; no network until a request arrives.

    Destination reads (the Across fee proof) use DOMINO_CROSSCHAIN_RPC_URL_<chainId> when it is set. Otherwise
    Robinhood reads the listener's own node (--rpc-config), and Base and Arbitrum the hosted endpoints of the V2
    chain RPC file (chain_endpoints, F6), in order and with failover; each is billed per call, one receipt per
    filled deposit.
    """
    from crosschain_across import ACROSS_API, AcrossProvider, ChainRpc, EndpointsChainRpc
    from crosschain_common import load_destinations, load_pins
    from crosschain_http import ProviderHttp
    from crosschain_relay import RELAY_API, RelayProvider
    from crosschain_service import CrosschainService
    pins, destinations = load_pins(), load_destinations()
    relay_headers = {'x-api-key': settings.relay_api_key} if settings.relay_api_key else None
    across_headers = {'Authorization': 'Bearer ' + settings.across_api_key} if settings.across_api_key else None
    relay = RelayProvider(ProviderHttp('relay', RELAY_API, headers=relay_headers, per_minute=settings.relay_per_minute),
                          pins, fee_recipient=settings.fee_recipient, has_key=bool(settings.relay_api_key),
                          timeout=settings.provider_timeout)
    urls = dict(settings.rpc_urls)
    if robinhood_rpc and 4663 not in urls:
        urls[4663] = robinhood_rpc
    hosted = dict(chain_endpoints or {})
    clients = {}

    def rpc_factory(chain):
        # One client per chain for the process, so a URL's chain id is read once; a destination's own URL wins.
        if chain not in clients:
            if chain in urls:
                clients[chain] = ChainRpc(urls[chain], chain)
            elif chain in hosted:
                clients[chain] = EndpointsChainRpc(hosted[chain], chain)
            else:
                return None
        return clients[chain]

    across = AcrossProvider(ProviderHttp('across', ACROSS_API, headers=across_headers, per_minute=settings.across_per_minute),
                            pins, destinations, fee_recipient=settings.fee_recipient,
                            integrator_id=settings.across_integrator_id, timeout=settings.provider_timeout,
                            rpc_factory=rpc_factory)
    hosted_urls = tuple(endpoint.url for endpoints in hosted.values() for endpoint in endpoints.endpoints)
    return CrosschainService(auth, relay, across, fee_recipient=settings.fee_recipient,
                             private_values=(*settings.private_values(), *urls.values(), *hosted_urls))


def main():
    import argparse
    from pathlib import Path
    import uvicorn
    from bridge_identity import AccessVerifier
    from catalogue import database_settings
    from crosschain_across import destination_endpoints
    from crosschain_config import ConfigError, load_settings
    from onboarding_auth import OnboardingAuth
    from rpc_config import configured_rpc_urls, DEFAULT_RPC_HOSTS
    from session_chain import EoaChecker
    from session_store import SessionStore
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--enable', action='store_true')
    parser.add_argument('--port', type=int, default=DEFAULT_PORT)
    parser.add_argument('--rpc-config', type=Path, help='Robinhood RPC configuration for the session account check')
    args, lock, problem = parser.parse_args(), None, None
    try:
        if args.port in RESERVED_PORTS or not 1024 <= args.port <= 65535:
            raise ValueError()
        if any(os.environ.get(name, '1') != '1' for name in ('WEB_CONCURRENCY', 'UVICORN_WORKERS')):
            raise ValueError()
        lock = acquire_session_lock(Path(__file__).resolve().parent / 'runtime' / 'crosschain')
        gateway = CrosschainGateway()
        if args.enable:
            settings = load_settings()
            config = load_session_rpc_config(args.rpc_config)
            secret = os.environ.get('DOMINO_SESSION_ABUSE_SECRET', '')
            if not re.fullmatch(r'[0-9a-f]{64}', secret):
                raise ValueError()
            hosts = config.get('rpcAllowedHosts', DEFAULT_RPC_HOSTS)
            robinhood = configured_rpc_urls(config)
            auth = OnboardingAuth(SessionStore(database_settings(), abuse_secret=bytes.fromhex(secret)),
                                  EoaChecker(robinhood, allowed_hosts=hosts))
            verifier = AccessVerifier(os.environ.get('DOMINO_CROSSCHAIN_ACCESS_ISSUER'),
                os.environ.get('DOMINO_CROSSCHAIN_ACCESS_AUDIENCE'), os.environ.get('DOMINO_CROSSCHAIN_ACCESS_SERVICE_ID'))
            service = build_service(settings, auth, robinhood_rpc=robinhood[0],
                                    chain_endpoints=destination_endpoints(settings.chain_rpc_file))
            gateway = CrosschainGateway(service=service, verifier=verifier, origin=os.environ.get('DOMINO_SESSION_ORIGIN'),
                                        enabled=True)
    except ConfigError as error:
        # The setting's name only, never its value.
        problem = str(error)
    except (ValueError, DataError, OSError):
        problem = 'configuration invalid or process already running'
    if problem is not None:
        if lock is not None:
            os.close(lock)
        parser.exit(2, f'Crosschain listener: {problem}.\n')
    try:
        uvicorn.run(create_crosschain_app(gateway), host='127.0.0.1', port=args.port, workers=1,
                    proxy_headers=False, access_log=False, server_header=False, limit_concurrency=16)
    finally:
        os.close(lock)


if __name__ == '__main__':
    main()
