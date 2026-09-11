"""Disabled-by-default private onboarding listener. Previews, never execution."""
import os
import re
from types import SimpleNamespace

from discovery import DataError
import onboarding_models as models
from authenticated_api import AuthenticatedGateway, create_authenticated_app, MAX_WORKERS
from session_api import acquire_session_lock, load_session_rpc_config

PREFIX = '/internal/onboarding/v1/'
HEADER = 'X-Domino-Onboarding-Contract'
CONTRACT = SimpleNamespace(PREFIX=PREFIX, HEADER=HEADER, Error=models.OnboardingError,
    CONTRACT_VERSION=models.CONTRACT_VERSION, MAX_BODY=models.MAX_BODY,
    MAX_RESPONSE=models.MAX_RESPONSE, REQUEST_MODELS=models.REQUEST_MODELS,
    validate_request=models.validate_request, validate_response=models.validate_response)


class OnboardingGateway(AuthenticatedGateway):
    def __init__(self, **kwargs):
        super().__init__(contract=CONTRACT, **kwargs)


def create_onboarding_app(gateway=None):
    return create_authenticated_app(gateway or OnboardingGateway())

def main():
    import argparse
    from pathlib import Path
    import uvicorn
    from bridge_identity import AccessVerifier
    from catalogue import database_settings
    from onboarding_auth import OnboardingAuth
    from onboarding_service import OnboardingService
    from rpc_config import configured_rpc_urls, DEFAULT_RPC_HOSTS
    from session_chain import PlainEoaChecker
    from session_store import SessionStore
    from uniswap_config import load_config, CONFIG_PATH
    from uniswap_position import UniswapPosition
    from uniswap_quote import UniswapQuote
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--enable', action='store_true')
    parser.add_argument('--port', type=int, default=8880)
    parser.add_argument('--rpc-config', type=Path)
    parser.add_argument('--uniswap-config', type=Path, default=CONFIG_PATH)
    args = parser.parse_args()
    lock = None
    try:
        if args.port in (8765, 8876, 8878, 8879) or not 1024 <= args.port <= 65535:
            raise ValueError()
        if any(os.environ.get(name, '1') != '1' for name in ('WEB_CONCURRENCY', 'UVICORN_WORKERS')):
            raise ValueError()
        lock = acquire_session_lock(Path(__file__).resolve().parent / 'runtime' / 'onboarding')
        gateway = OnboardingGateway()
        if args.enable:
            config = load_session_rpc_config(args.rpc_config)
            api_key = load_config(args.uniswap_config).get('apiKey')
            if not api_key:
                raise ValueError()
            secret = os.environ.get('DOMINO_SESSION_ABUSE_SECRET', '')
            if not re.fullmatch(r'[0-9a-f]{64}', secret):
                raise ValueError()
            store = SessionStore(database_settings(), abuse_secret=bytes.fromhex(secret))
            checker = PlainEoaChecker(configured_rpc_urls(config),
                                     allowed_hosts=config.get('rpcAllowedHosts', DEFAULT_RPC_HOSTS))
            service = OnboardingService(OnboardingAuth(store, checker), UniswapQuote(api_key),
                                        UniswapPosition(api_key), private_values=(api_key,))
            verifier = AccessVerifier(os.environ.get('DOMINO_ONBOARDING_ACCESS_ISSUER'),
                os.environ.get('DOMINO_ONBOARDING_ACCESS_AUDIENCE'), os.environ.get('DOMINO_ONBOARDING_ACCESS_SERVICE_ID'))
            gateway = OnboardingGateway(service=service, verifier=verifier,
                origin=os.environ.get('DOMINO_SESSION_ORIGIN'), enabled=True)
    except (ValueError, DataError, OSError):
        if lock is not None:
            os.close(lock)
        parser.exit(2, 'Onboarding listener configuration invalid or process already running.\n')
    try:
        uvicorn.run(create_onboarding_app(gateway), host='127.0.0.1', port=args.port, workers=1,
                    proxy_headers=False, access_log=False, server_header=False, limit_concurrency=16)
    finally:
        os.close(lock)


if __name__ == '__main__':
    main()
