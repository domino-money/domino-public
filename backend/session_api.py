"""Explicitly enabled, loopback-only wallet authentication listener.

The edge authenticates the browser origin; Access authenticates the edge.
No cookie, browser Authorization, financial configuration, or read route enters
this listener. A timed-out/disconnected request retains its worker slot until
the actual synchronous operation exits.
"""
import asyncio
from concurrent.futures import ThreadPoolExecutor
from contextlib import asynccontextmanager
import ipaddress
import math
import os
import re
import secrets
import hop_log
import stat
from threading import BoundedSemaphore
import time

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from pydantic import ValidationError

from bridge_state import strict_json
from discovery import DataError
from read_deadline import read_deadline
from session_models import (CONTRACT_VERSION, MAX_BODY, REQUEST_MODELS, RESPONSE_MODELS,
                            SessionError, token, validate_body)

MAX_WORKERS=4
TOTAL_SECONDS=20
UPLOAD_SECONDS=5
PREFIX='/internal/session/v1/'


def acquire_session_lock(runtime):
    """Keep the listener singleton lock in an owned private runtime directory."""
    import fcntl
    runtime.mkdir(mode=0o700,parents=True,exist_ok=True)
    info=runtime.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid!=os.getuid() or stat.S_IMODE(info.st_mode)!=0o700:
        raise ValueError('invalid_session_runtime')
    fd=os.open(runtime/'session-api.lock',os.O_CREAT|os.O_RDWR|os.O_NOFOLLOW|os.O_NONBLOCK,0o600)
    try:
        info=os.fstat(fd)
        if (not stat.S_ISREG(info.st_mode) or info.st_uid!=os.getuid() or
                stat.S_IMODE(info.st_mode)!=0o600 or info.st_nlink!=1):
            raise ValueError('invalid_session_lock')
        fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
        return fd
    except BaseException:
        os.close(fd)
        raise


def load_session_rpc_config(path):
    from local_config import load_config
    if path is None:raise ValueError('session_rpc_config_required')
    config=load_config(path)
    # The generic local reader permits an absent file and provider defaults.
    # Explicit auth enablement requires an existing validated operator file.
    if not config or not isinstance(config.get('rpcUrl'),str):
        raise ValueError('session_rpc_config_required')
    return config


class SessionGateway:
    def __init__(self, *, service=None, verifier=None, origin=None, enabled=False,
                 clock=time.monotonic, total_seconds=TOTAL_SECONDS, upload_seconds=UPLOAD_SECONDS):
        if type(enabled) is not bool or (enabled and (service is None or verifier is None)):
            raise ValueError('invalid_session_gateway_config')
        if enabled:
            from session_siwe import SiwePolicy
            SiwePolicy(origin)  # Same canonical deployment origin as SIWE.
        if (type(total_seconds) not in (int,float) or not math.isfinite(total_seconds) or
                not 0<total_seconds<=TOTAL_SECONDS or type(upload_seconds) not in (int,float) or
                not math.isfinite(upload_seconds) or not 0<upload_seconds<=UPLOAD_SECONDS):
            raise ValueError('invalid_session_gateway_budget')
        self.service,self.verifier,self.origin,self.enabled=service,verifier,origin,enabled
        self.clock,self.total_seconds,self.upload_seconds=clock,total_seconds,upload_seconds
        self.slot=BoundedSemaphore(MAX_WORKERS)

    def execute(self, route, body, headers, deadline):
        try:
            remaining=deadline-self.clock()
            if remaining<=0:raise SessionError('request_timeout')
            with read_deadline(remaining,clock=self.clock):
                try:
                    self.verifier.verify(headers['assertion'])
                except DataError:
                    raise SessionError('upstream_unavailable') from None
                response=self.service.execute(route,body,client=headers['client'],
                    preauth=headers['preauth'],session=headers['session'],csrf=headers['csrf'])
                # Guard even injected services; bearer directives are validated
                # separately and are never part of the public result schema.
                if not isinstance(response,dict) or set(response)!={'result','credentials'}:
                    raise SessionError('upstream_invalid_response')
                RESPONSE_MODELS[route].model_validate(response['result'])
                expected={'bootstrap':{'preauth'},'verify':{'preauth','session'},
                          'logout':{'preauth','session'}}.get(route,set())
                credentials=response['credentials']
                if not isinstance(credentials,dict) or set(credentials)!=expected:
                    raise SessionError('upstream_invalid_response')
                for name,value in credentials.items():
                    if route=='logout' or (route=='verify' and name=='preauth'):
                        if value is not None:raise SessionError('upstream_invalid_response')
                    else:
                        try:token(value,required='upstream_invalid_response')
                        except SessionError:raise SessionError('upstream_invalid_response') from None
                return 200,response
        except SessionError as error:
            return error.status,{'error':error.code}
        except DataError:
            return 504,{'error':'request_timeout'}
        except (ValidationError,ValueError,TypeError):
            return 502,{'error':'upstream_invalid_response'}
        except Exception:
            return 503,{'error':'upstream_unavailable'}
        finally:
            self.slot.release()


def create_session_app(gateway=None):
    gateway=gateway or SessionGateway()
    executor=ThreadPoolExecutor(max_workers=MAX_WORKERS,thread_name_prefix='session-auth')
    pending=set()

    @asynccontextmanager
    async def lifespan(app):
        yield
        # Request cancellation never abandons admission ownership. Shutdown
        # cannot interrupt a running DB/crypto call; each remains bounded there.
        executor.shutdown(wait=False,cancel_futures=False)

    app=FastAPI(title='Domino private session service',docs_url=None,redoc_url=None,
                openapi_url=None,lifespan=lifespan)
    app.state.gateway=gateway
    app.state.pending=pending

    @app.middleware('http')
    async def boundary(request: Request,call_next):
        try:
            from access_transport import normalize_access_cookie
            normalize_access_cookie(request.scope)
            deadline=gateway.clock()+gateway.total_seconds
            upload_deadline=min(deadline,gateway.clock()+gateway.upload_seconds)
            request_id=secrets.token_hex(16)
            opened=gateway.clock()
            logged_route='unmatched'
            notes=hop_log.open_notes()
            recorded=[]
            def record(status,reason=None):
                # The raw path never reaches the record: only a declared route name.
                if recorded:return
                recorded.append(status)
                hop_log.emit(service='session-v1',requestId=request_id,route=logged_route,
                             contractVersion=CONTRACT_VERSION,method=request.method,status=status,
                             reason=reason,durationMs=int((gateway.clock()-opened)*1000),
                             **hop_log.close_notes(notes))
            def result(status,body):
                record(status,body.get('error') if isinstance(body,dict) else None)
                headers={'Cache-Control':'no-store, no-transform','X-Content-Type-Options':'nosniff',
                         'Content-Security-Policy':"default-src 'none'; frame-ancestors 'none'",
                         'X-Domino-Session-Contract':CONTRACT_VERSION,'X-Domino-Request-Id':request_id}
                if status==429:headers['Retry-After']='2'
                return JSONResponse(body,status_code=status,headers=headers)
            def error(code):
                item=SessionError(code)
                return result(item.status,{'error':item.code})
            path=request.scope.get('raw_path',b'').decode('ascii',errors='replace')
            route=path[len(PREFIX):] if path.startswith(PREFIX) else ''
            if route in REQUEST_MODELS:
                logged_route=route
            if route not in REQUEST_MODELS or request.scope.get('query_string') or not gateway.enabled:
                return error('route_not_available')
            if request.method!='POST':return error('method_not_allowed')
            try:
                if not ipaddress.ip_address(request.client.host).is_loopback:
                    return error('origin_not_allowed')
            except (ValueError,AttributeError):return error('origin_not_allowed')
            headers={}
            total=0
            for name,value in request.scope['headers']:
                name=name.lower()
                total+=len(name)+len(value)
                if name in (b'origin',b'cookie',b'authorization'):return error('origin_not_allowed')
                if name in headers or total>16384:return error('invalid_request')
                headers[name]=value
            if headers.get(b'x-domino-browser-origin')!=gateway.origin.encode('ascii'):
                return error('origin_not_allowed')
            if headers.get(b'x-domino-session-contract')!=CONTRACT_VERSION.encode('ascii'):
                return error('invalid_request')
            if (not re.fullmatch(rb'application/json(?:;\s*charset=utf-8)?',headers.get(b'content-type',b''),re.I) or
                    headers.get(b'content-encoding',b'identity')!=b'identity'):
                return error('json_required')
            length=headers.get(b'content-length')
            if length is not None:
                if not re.fullmatch(rb'(0|[1-9][0-9]{0,9})',length) or b'transfer-encoding' in headers:
                    return error('invalid_request')
                if int(length)>MAX_BODY:return error('request_too_large')
            try:
                assertion=headers[b'cf-access-jwt-assertion'].decode('ascii')
                client=headers[b'x-domino-client-id'].decode('ascii')
                if not 1<=len(assertion)<=8192 or not 1<=len(client)<=45:raise ValueError()
                ipaddress.ip_address(client)
                credentials={name:token(headers[('x-domino-'+name).encode()].decode('ascii'))
                             if ('x-domino-'+name).encode() in headers else None
                             for name in ('preauth','session','csrf')}
            except (KeyError,ValueError,UnicodeError,SessionError):return error('invalid_request')
            raw=bytearray()
            try:
                async with asyncio.timeout(max(0,upload_deadline-gateway.clock())):
                    async for chunk in request.stream():
                        if gateway.clock()>=upload_deadline:raise TimeoutError()
                        if len(raw)+len(chunk)>MAX_BODY:return error('request_too_large')
                        raw.extend(chunk)
                if length is not None and len(raw)!=int(length):return error('invalid_request')
                body=strict_json(raw)
                validate_body(route,body)
                REQUEST_MODELS[route].model_validate(body)
                if gateway.clock()>=upload_deadline:raise TimeoutError()
            except TimeoutError:return error('request_timeout')
            except (DataError,ValidationError,ValueError,TypeError,SessionError):return error('invalid_request')
            if gateway.clock()>=deadline:return error('request_timeout')
            if not gateway.slot.acquire(blocking=False):return error('session_capacity_busy')
            try:
                future=asyncio.get_running_loop().run_in_executor(executor,gateway.execute,route,body,
                    {'assertion':assertion,'client':client,**credentials},deadline)
            except Exception:
                gateway.slot.release()
                return error('upstream_unavailable')
            pending.add(future)
            future.add_done_callback(pending.discard)
            try:
                # shield keeps the actual worker and admission alive on timeout or
                # disconnect; the HTTP response itself is still bounded by 20s.
                async with asyncio.timeout(max(0,deadline-gateway.clock())):
                    status,response=await asyncio.shield(future)
                if gateway.clock()>=deadline:return error('request_timeout')
                return result(status,response)
            except TimeoutError:return error('request_timeout')
            except Exception:return error('upstream_unavailable')

        except BaseException:
            # A caller that vanishes mid-body must still leave a record.
            record(499, "client_disconnected")
            raise
    return app


def main():
    import argparse
    from pathlib import Path
    import uvicorn
    from bridge_identity import AccessVerifier
    from catalogue import database_settings
    from rpc_config import configured_rpc_urls, DEFAULT_RPC_HOSTS
    from session_chain import EoaChecker
    from session_service import SessionService
    from session_siwe import SiwePolicy
    from session_store import SessionStore
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--enable',action='store_true')
    parser.add_argument('--port',type=int,default=8879)
    parser.add_argument('--rpc-config',type=Path)
    args=parser.parse_args()
    lock=None
    try:
        if args.port in (8765,8876,8878) or not 1024<=args.port<=65535:raise ValueError()
        if any(os.environ.get(name,'1')!='1' for name in ('WEB_CONCURRENCY','UVICORN_WORKERS')):raise ValueError()
        runtime=Path(__file__).resolve().parent/'runtime'
        lock=acquire_session_lock(runtime)
        gateway=SessionGateway()
        if args.enable:
            if args.rpc_config is None:raise ValueError()
            secret=os.environ.get('DOMINO_SESSION_ABUSE_SECRET','')
            if not re.fullmatch(r'[0-9a-f]{64}',secret):raise ValueError()
            origin=os.environ.get('DOMINO_SESSION_ORIGIN')
            config=load_session_rpc_config(args.rpc_config)
            checker=EoaChecker(configured_rpc_urls(config),allowed_hosts=config.get('rpcAllowedHosts',DEFAULT_RPC_HOSTS))
            store=SessionStore(database_settings(),abuse_secret=bytes.fromhex(secret))
            service=SessionService(store,SiwePolicy(origin),checker)
            verifier=AccessVerifier(os.environ.get('DOMINO_SESSION_ACCESS_ISSUER'),os.environ.get('DOMINO_SESSION_ACCESS_AUDIENCE'),
                                    os.environ.get('DOMINO_SESSION_ACCESS_SERVICE_ID'))
            gateway=SessionGateway(service=service,verifier=verifier,origin=origin,enabled=True)
    except (ValueError,DataError,OSError):
        if lock is not None:os.close(lock)
        parser.exit(2,'Session listener configuration invalid or process already running.\n')
    try:
        uvicorn.run(create_session_app(gateway),host='127.0.0.1',port=args.port,workers=1,proxy_headers=False,
                    access_log=False,server_header=False,limit_concurrency=16)
    finally:
        os.close(lock)


if __name__=='__main__':
    main()
