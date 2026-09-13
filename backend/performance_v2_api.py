"""Private managed-performance listener/collector; explicit enable, no signer."""
import hmac
import os
import re
import signal
import threading
from types import SimpleNamespace

from authenticated_api import AuthenticatedGateway, create_authenticated_app
from discovery import DataError
import performance_v2_models as m

PREFIX = '/internal/performance/v2/'
HEADER = 'X-Domino-Performance-Contract'
CONTRACT = SimpleNamespace(PREFIX=PREFIX,HEADER=HEADER,Error=m.Error,CONTRACT_VERSION=m.CONTRACT_VERSION,
    MAX_BODY=m.MAX_BODY,MAX_RESPONSE=m.MAX_RESPONSE,REQUEST_MODELS=m.REQUEST_MODELS,
    CAPACITY_CODE='performance_capacity_busy',validate_request=m.validate_request,validate_response=m.validate_response)


class PerformanceV2Gateway(AuthenticatedGateway):
    def __init__(self, **kwargs):
        super().__init__(contract=CONTRACT,**kwargs)


def create_performance_v2_app(gateway=None):
    app = create_authenticated_app(gateway or PerformanceV2Gateway())
    @app.middleware('http')
    async def access_duplicate(request, call_next):
        # Access sometimes duplicates its service JWT in this one cookie. The
        # assertion is still verified downstream; no browser cookie is admitted.
        headers = request.scope['headers']
        cookies = [v for k,v in headers if k.lower()==b'cookie']
        assertions = [v for k,v in headers if k.lower()==b'cf-access-jwt-assertion']
        if (len(cookies)==len(assertions)==1 and 1<=len(assertions[0])<=8192
                and hmac.compare_digest(cookies[0].strip(b' \t'),b'CF_Authorization='+assertions[0])):
            request.scope['headers'] = [(k,v) for k,v in headers if k.lower()!=b'cookie']
        return await call_next(request)
    return app


def main():
    import argparse
    import uvicorn
    from bridge_identity import AccessVerifier
    from onboarding_auth import OnboardingAuth
    from performance_runtime import Runtime
    from performance_v2_service import PerformanceV2Service
    from session_api import acquire_session_lock
    from session_chain import PlainEoaChecker
    from session_store import SessionStore
    from rpc_config import configured_rpc_urls, DEFAULT_RPC_HOSTS
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action',choices=('serve','collect'))
    parser.add_argument('--enable',action='store_true')
    parser.add_argument('--profile')
    parser.add_argument('--port',type=int,default=8900)
    parser.add_argument('--once',action='store_true',help='one bounded queue tick; never bypasses startup cooldown')
    args = parser.parse_args()
    lock = None
    try:
        if args.port != 8900 or args.action=='collect' and not args.enable or args.once and args.action!='collect':
            raise ValueError('invalid_performance_arguments')
        if any(os.environ.get(name,'1')!='1' for name in ('WEB_CONCURRENCY','UVICORN_WORKERS')):
            raise ValueError('single_worker_required')
        gateway = PerformanceV2Gateway()
        if args.enable:
            if not args.profile: raise ValueError('performance_profile_required')
            runtime = Runtime(args.profile)
            lock = acquire_session_lock(runtime.runtime/args.action)
            if args.action=='collect':
                producer = runtime.producer()
                if args.once:
                    print(producer.tick())
                else:
                    stop = threading.Event()
                    for event in (signal.SIGTERM,signal.SIGINT): signal.signal(event,lambda *_:stop.set())
                    producer.run(stop)
                return 0
            secret = os.environ.get('DOMINO_SESSION_ABUSE_SECRET','')
            if not re.fullmatch(r'[0-9a-f]{64}',secret): raise ValueError('session_secret_required')
            sessions = SessionStore(runtime.settings,abuse_secret=bytes.fromhex(secret))
            checker = PlainEoaChecker(configured_rpc_urls(runtime.config),allowed_hosts=runtime.config.get('rpcAllowedHosts',DEFAULT_RPC_HOSTS))
            from performance_rollup import project
            service = PerformanceV2Service(OnboardingAuth(sessions,checker),runtime.enrollments,runtime.history,
                runtime.valuation,runtime.admission,projection=project,
                projection_refresh=runtime.projection_writer.request_projection_refresh)
            verifier = AccessVerifier(os.environ.get('DOMINO_PERFORMANCE_ACCESS_ISSUER'),
                os.environ.get('DOMINO_PERFORMANCE_ACCESS_AUDIENCE'),os.environ.get('DOMINO_PERFORMANCE_ACCESS_SERVICE_ID'))
            gateway = PerformanceV2Gateway(service=service,verifier=verifier,origin=os.environ.get('DOMINO_SESSION_ORIGIN'),enabled=True)
        uvicorn.run(create_performance_v2_app(gateway),host='127.0.0.1',port=args.port,workers=1,
            proxy_headers=False,access_log=False,server_header=False,limit_concurrency=16)
    except (ValueError,DataError,OSError):
        parser.exit(2,'Performance configuration invalid or process already running.\n')
    finally:
        if lock is not None: os.close(lock)
    return 0


if __name__=='__main__': raise SystemExit(main())
