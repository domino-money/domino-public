"""Disabled private deposit API; every financial transaction stays wallet-signed."""
import json
import os
from pathlib import Path
import re
import stat
import time
from types import SimpleNamespace

from authenticated_api import AuthenticatedGateway, create_authenticated_app, MAX_WORKERS
import deposit_models as models
from discovery import DataError
from session_api import acquire_session_lock, load_session_rpc_config

PREFIX = '/internal/deposit/v1/'
HEADER = 'X-Domino-Deposit-Contract'
CONTRACT = SimpleNamespace(PREFIX=PREFIX, HEADER=HEADER, Error=models.DepositError,
    CONTRACT_VERSION=models.CONTRACT_VERSION, MAX_BODY=models.MAX_BODY,
    MAX_RESPONSE=models.MAX_RESPONSE, REQUEST_MODELS=models.REQUEST_MODELS,
    CAPACITY_CODE='deposit_capacity_busy', validate_request=models.validate_request,
    validate_response=models.validate_response)


class DepositGateway(AuthenticatedGateway):
    def __init__(self, **kwargs):
        super().__init__(contract=CONTRACT, **kwargs)


def create_deposit_app(gateway=None):
    return create_authenticated_app(gateway or DepositGateway())


def load_admission(path):
    """Explicit owned local evidence only; never a browser admission override."""
    from bridge_state import strict_json
    from deposit_prepare import validate_admission_manifest
    if path is None:
        raise ValueError('admission_file_required')
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        info = os.fstat(fd)
        if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_nlink != 1
                or info.st_mode & 0o077 or not 0 < info.st_size <= 32768):
            raise ValueError('invalid_admission_file')
        raw = os.read(fd, 32769)
        if len(raw) > 32768:
            raise ValueError('invalid_admission_file')
        manifest = strict_json(raw)
        validate_admission_manifest(manifest, now=time.time())
        return manifest
    finally:
        os.close(fd)


def main():
    import argparse
    import uvicorn
    from bridge_identity import AccessVerifier
    from catalogue import database_settings
    from deposit_prepare import DirectDepositPreparer
    from deposit_allowances import AllowanceReader
    from deposit_receipt import ReceiptReconciler
    from deposit_rpc import DepositRpc
    from deposit_service import DepositService
    from deposit_store import DepositStore
    from onboarding_auth import OnboardingAuth
    from rpc_config import configured_rpc_urls, DEFAULT_RPC_HOSTS
    from session_chain import PlainEoaChecker
    from session_store import SessionStore
    from uniswap_config import load_config, CONFIG_PATH
    from uniswap_position import UniswapPosition
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--enable', action='store_true')
    parser.add_argument('--port', type=int, default=8881)
    parser.add_argument('--rpc-config', type=Path)
    parser.add_argument('--uniswap-config', type=Path, default=CONFIG_PATH)
    parser.add_argument('--admission-file', type=Path)
    args, lock = parser.parse_args(), None
    try:
        if args.port in (8765, 8876, 8877, 8878, 8879, 8880) or not 1024 <= args.port <= 65535:
            raise ValueError()
        if any(os.environ.get(name, '1') != '1' for name in ('WEB_CONCURRENCY', 'UVICORN_WORKERS')):
            raise ValueError()
        lock = acquire_session_lock(Path(__file__).resolve().parent / 'runtime' / 'deposits')
        gateway = DepositGateway()
        if args.enable:
            manifest = load_admission(args.admission_file)
            config = load_session_rpc_config(args.rpc_config)
            api_key = load_config(args.uniswap_config).get('apiKey')
            secret = os.environ.get('DOMINO_SESSION_ABUSE_SECRET', '')
            if not api_key or not re.fullmatch(r'[0-9a-f]{64}', secret):
                raise ValueError()
            settings, urls = database_settings(), configured_rpc_urls(config)
            hosts = config.get('rpcAllowedHosts', DEFAULT_RPC_HOSTS)
            # Two currencies, implementation/admin identity and operative
            # controls are checked before and after composition. Still one
            # bounded request budget and deadline; no unbounded retries.
            rpc_factory = lambda: DepositRpc(urls[0], allowed_hosts=hosts, max_requests=160)
            auth = OnboardingAuth(SessionStore(settings, abuse_secret=bytes.fromhex(secret)),
                                 PlainEoaChecker(urls, allowed_hosts=hosts))
            preparer = DirectDepositPreparer(UniswapPosition(api_key), rpc_factory, admission=manifest)
            service = DepositService(auth, DepositStore(settings), preparer,
                lambda: ReceiptReconciler(rpc_factory(), token_guard=preparer.token_guard), private_values=(api_key,),
                allowance_reader_factory=lambda: AllowanceReader(rpc_factory()))
            verifier = AccessVerifier(os.environ.get('DOMINO_DEPOSIT_ACCESS_ISSUER'),
                os.environ.get('DOMINO_DEPOSIT_ACCESS_AUDIENCE'), os.environ.get('DOMINO_DEPOSIT_ACCESS_SERVICE_ID'))
            gateway = DepositGateway(service=service, verifier=verifier,
                origin=os.environ.get('DOMINO_SESSION_ORIGIN'), enabled=True)
    except (ValueError, models.DepositError, DataError, OSError):
        if lock is not None:
            os.close(lock)
        parser.exit(2, 'Deposit listener configuration invalid or process already running.\n')
    try:
        uvicorn.run(create_deposit_app(gateway), host='127.0.0.1', port=args.port, workers=1,
                    proxy_headers=False, access_log=False, server_header=False, limit_concurrency=16)
    finally:
        os.close(lock)


if __name__ == '__main__':
    main()
