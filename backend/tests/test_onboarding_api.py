"""HTTP admission, identity, framing, deadlines and safe previews, offline."""
import asyncio
from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy
import json
import os
from pathlib import Path
import sys
import tempfile
from threading import Event
import time
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from fastapi.testclient import TestClient
from discovery import DataError
from onboarding_api import OnboardingGateway, create_onboarding_app, main, MAX_WORKERS
from onboarding_models import CONTRACT_VERSION
from session_api import acquire_session_lock
from session_models import SessionError
from read_deadline import current_read_deadline
from test_onboarding_service import make_service, SESSION, CSRF

ORIGIN='https://domino.money'
HEADERS={'CF-Access-Jwt-Assertion':'synthetic-service-assertion','X-Domino-Client-Id':'192.0.2.1',
         'X-Domino-Browser-Origin':ORIGIN,'X-Domino-Onboarding-Contract':CONTRACT_VERSION,
         'X-Domino-Session':SESSION,'X-Domino-CSRF':CSRF}


class OnboardingApiTests(unittest.TestCase):
    def setUp(self):
        self.service,self.auth,self.transport,self.body=make_service()
        self.verifier=SimpleNamespace(verify=Mock())
        self.gateway=OnboardingGateway(service=self.service,verifier=self.verifier,origin=ORIGIN,enabled=True)
        self.client=self.new_client(self.gateway)

    def new_client(self,gateway):
        client=TestClient(create_onboarding_app(gateway),client=('127.0.0.1',43100),base_url='http://127.0.0.1:8880')
        client.__enter__()
        self.addCleanup(client.__exit__,None,None,None)
        return client

    def post(self,path='swap-preview',body=None,headers=None,client=None,raw=None):
        return (client or self.client).post('/internal/onboarding/v1/'+path,
            content=raw if raw is not None else json.dumps(self.body if body is None else body),
            headers={'content-type':'application/json',**{k.lower():v for k,v in (HEADERS if headers is None else headers).items()}})

    def test_success_uses_full_service_adapter_and_safe_headers(self):
        response=self.post()
        self.assertEqual(response.status_code,200,response.text)
        self.assertFalse(response.json()['preview']['executionAvailable'])
        self.assertEqual(response.headers['X-Domino-Onboarding-Contract'],'1.0.0')
        self.assertTrue({'no-store', 'no-transform'} <= {value.strip().lower() for value in response.headers['cache-control'].split(',')})
        self.assertNotIn('content-encoding', response.headers)
        self.assertEqual(response.headers['X-Content-Type-Options'],'nosniff')
        self.assertNotIn('set-cookie',response.headers)
        self.assertNotIn('access-control-allow-origin',response.headers)
        self.assertRegex(response.headers['X-Domino-Request-Id'],r'^[0-9a-f]{32}$')
        self.auth.begin.assert_called_once_with('192.0.2.1',SESSION,CSRF)
        self.verifier.verify.assert_called_once_with(HEADERS['CF-Access-Jwt-Assertion'])
        self.assertEqual(len(self.transport.calls),1)

    def test_access_cookie_duplicate_preserves_verification_and_session_boundary(self):
        assertion = HEADERS['CF-Access-Jwt-Assertion']
        response = self.post(headers={**HEADERS, 'Cookie': 'CF_Authorization=' + assertion})
        self.assertEqual(response.status_code, 200, response.text)
        self.verifier.verify.assert_called_once_with(assertion)
        self.auth.begin.assert_called_once_with('192.0.2.1', SESSION, CSRF)

    def test_cookie_normalization_never_admits_other_credentials_or_invalid_assertion(self):
        assertion = HEADERS['CF-Access-Jwt-Assertion']
        for cookie in ('CF_Authorization=wrong', 'CF_Authorization=' + assertion + '; session=secret',
                       'session=' + assertion, 'CF_Authorization=' + assertion + '; CF_Authorization=' + assertion):
            self.assertEqual(self.post(headers={**HEADERS, 'Cookie': cookie}).status_code, 403)
        self.verifier.verify.assert_not_called()
        self.auth.begin.assert_not_called()
        self.verifier.verify.side_effect = DataError('synthetic-invalid-jwt')
        response = self.post(headers={**HEADERS, 'Cookie': 'CF_Authorization=' + assertion})
        self.assertEqual(response.status_code, 503)
        self.auth.begin.assert_not_called()

    def test_disabled_listener_exact_routes_and_methods(self):
        self.assertEqual(self.post(client=self.new_client(OnboardingGateway())).status_code,404)
        for path in ('swap-preview/','%73wap-preview','../swap-preview','position-preview?x=1',
                     'swap','create','sign','approve','health','session'):
            self.assertEqual(self.post(path).status_code,404,path)
        self.assertEqual(self.client.get('/internal/onboarding/v1/swap-preview').status_code,405)
        self.assertEqual(self.client.get('/docs').status_code,404)
        self.assertEqual(self.transport.calls,[])

    def test_direct_browser_and_nonloopback_cannot_bypass_bff(self):
        for field,value in (('Origin',ORIGIN),('Cookie','secret=value'),('Authorization','Bearer secret'),
                            ('X-Domino-Browser-Origin','https://other.domino.money')):
            response=self.post(headers={**HEADERS,field:value})
            self.assertEqual(response.status_code,403,response.text)
        client=TestClient(create_onboarding_app(self.gateway),client=('192.0.2.1',43100))
        self.addCleanup(client.close)
        self.assertEqual(self.post(client=client).status_code,403)
        self.verifier.verify.assert_not_called()
        self.auth.begin.assert_not_called()

    def test_missing_or_invalid_access_never_touches_auth_or_provider(self):
        for field in ('CF-Access-Jwt-Assertion','X-Domino-Client-Id'):
            headers={k:v for k,v in HEADERS.items() if k!=field}
            self.assertEqual(self.post(headers=headers).status_code,400)
        self.verifier.verify.side_effect=DataError('secret-service-key')
        response=self.post()
        self.assertEqual((response.status_code,response.json()),(503,{'error':'upstream_unavailable'}))
        self.auth.begin.assert_not_called()
        self.assertEqual(self.transport.calls,[])

    def test_missing_credentials_reach_store_denial_only_after_access(self):
        self.auth.begin.side_effect=SessionError('session_required')
        headers={k:v for k,v in HEADERS.items() if k!='X-Domino-Session'}
        response=self.post(headers=headers)
        self.assertEqual((response.status_code,response.json()),(401,{'error':'session_required'}))
        self.auth.begin.assert_called_once_with('192.0.2.1',None,CSRF)
        self.verifier.verify.assert_called_once()
        self.assertEqual(self.transport.calls,[])

    def test_forged_transport_owner_and_ip_are_not_application_identity(self):
        response=self.post(headers={**HEADERS,'X-Domino-Owner':'0x'+'99'*20,'X-Domino-Tenant':'attacker',
                                   'CF-Connecting-IP':'203.0.113.1','X-Forwarded-For':'203.0.113.2'})
        self.assertEqual(response.status_code,200,response.text)
        self.auth.begin.assert_called_once_with('192.0.2.1',SESSION,CSRF)
        self.assertEqual(response.json()['preview']['request']['owner'],self.auth.begin.return_value['owner'])

    def test_duplicate_and_contract_headers_fail_closed(self):
        headers=[('Content-Type','application/json'),*HEADERS.items(),('x-domino-session','a'*43)]
        response=self.client.post('/internal/onboarding/v1/swap-preview',content=json.dumps(self.body),headers=headers)
        self.assertEqual(response.status_code,400)
        response=self.post(headers={**HEADERS,'X-Domino-Onboarding-Contract':'2.0.0'})
        self.assertEqual((response.status_code,response.json()),(502,{'error':'upstream_contract_mismatch'}))
        self.assertEqual(self.post(headers={**HEADERS,'X-Extra':'x'*16500}).status_code,400)
        self.auth.begin.assert_not_called()

    def test_strict_body_unknown_fields_and_numeric_lexemes(self):
        for raw in ('null','[]','{"x":1,"x":2}','{"x":NaN}','{"x":1e999}',
                    json.dumps({**self.body,'owner':'0x'+'99'*20}),
                    json.dumps(self.body).replace('4663','4663.0'),
                    json.dumps(self.body).replace('4663','4.663e3'),
                    json.dumps({**self.body,'amountRaw':1000})):
            with self.subTest(raw=raw):
                self.assertEqual(self.post(raw=raw).status_code,400)
        self.assertEqual(self.post(raw=' '*8193).status_code,413)
        self.auth.begin.assert_not_called()

    def test_framing_encoding_and_content_type_rejected(self):
        for field,value,status in (('Content-Type','text/plain',415),('Content-Type','application/json; charset=latin1',415),
            ('Content-Encoding','gzip',415),('Content-Length','01',400),('Content-Length','9999999999',413)):
            self.assertEqual(self.post(headers={**HEADERS,field:value}).status_code,status)
        self.assertEqual(self.post(headers={**HEADERS,'Content-Length':'1'}).status_code,400)
        self.assertEqual(self.post(headers={**HEADERS,'Content-Length':'1','Transfer-Encoding':'chunked'}).status_code,400)
        self.auth.begin.assert_not_called()

    def test_safe_auth_provider_and_unexpected_errors(self):
        for error,status,code in ((SessionError('csrf_invalid'),403,'csrf_invalid'),
            (SessionError('session_rate_limited'),429,'session_rate_limited'),
            (SessionError('session_store_unavailable'),503,'session_store_unavailable'),
            (RuntimeError('secret db connection string'),503,'upstream_unavailable')):
            self.auth.begin.side_effect=error
            response=self.post()
            self.assertEqual((response.status_code,response.json()),(status,{'error':code}))
            if status==429:self.assertEqual(response.headers['Retry-After'],'60')
            self.assertNotIn('secret',response.text)

    def test_injected_service_cannot_export_executable_or_credential_fields(self):
        value=self.post().json()
        for bad in ({**value,'session':SESSION},{**value,'preview':{**value['preview'],'executionAvailable':True}},
                    {'credentials':{'session':SESSION},'result':value},None):
            self.gateway.service=SimpleNamespace(execute=Mock(return_value=bad))
            response=self.post()
            self.assertEqual(response.status_code,502,response.text)
            self.assertEqual(set(response.json()),{'error'})
            self.assertNotIn(SESSION,response.text)

    def test_access_auth_provider_share_whole_operation_deadline(self):
        clock=[0.0];seen=[]
        original=self.service.execute
        def verify(_):
            seen.append(current_read_deadline().remaining());clock[0]+=4
        def execute(*args,**kwargs):
            seen.append(current_read_deadline().remaining());return original(*args,**kwargs)
        self.verifier.verify.side_effect=verify
        service=SimpleNamespace(execute=execute)
        gateway=OnboardingGateway(service=service,verifier=self.verifier,origin=ORIGIN,enabled=True,clock=lambda:clock[0])
        self.assertEqual(self.post(client=self.new_client(gateway)).status_code,200)
        self.assertEqual(seen,[20,16])

    def test_timed_out_work_holds_concurrency_until_actual_completion(self):
        release=Event(); started=[Event() for _ in range(MAX_WORKERS)]; sequence=iter(started)
        def stuck(*args,**kwargs):
            next(sequence).set();release.wait(3);raise RuntimeError('done')
        service=SimpleNamespace(execute=Mock(side_effect=stuck))
        gateway=OnboardingGateway(service=service,verifier=self.verifier,origin=ORIGIN,enabled=True,total_seconds=.12)
        client=self.new_client(gateway)
        try:
            with ThreadPoolExecutor(MAX_WORKERS) as pool:
                futures=[pool.submit(self.post,client=client) for _ in range(MAX_WORKERS)]
                for event in started:self.assertTrue(event.wait(1))
                for future in futures:self.assertEqual(future.result(1).status_code,504)
            response=self.post(client=client)
            self.assertEqual((response.status_code,response.json()),(429,{'error':'onboarding_capacity_busy'}))
            self.assertEqual(service.execute.call_count,MAX_WORKERS)
        finally:release.set()
        until=time.monotonic()+2
        while client.app.state.pending and time.monotonic()<until:time.sleep(.01)
        self.assertFalse(client.app.state.pending)

    def test_slow_upload_is_bounded_before_access_and_auth(self):
        gateway=OnboardingGateway(service=self.service,verifier=self.verifier,origin=ORIGIN,enabled=True,upload_seconds=.03)
        app=create_onboarding_app(gateway)
        async def run():
            sent=[]
            async def receive():
                await asyncio.sleep(.1)
                return {'type':'http.request','body':json.dumps(self.body).encode(),'more_body':False}
            async def send(message):sent.append(message)
            scope={'type':'http','asgi':{'version':'3.0'},'http_version':'1.1','method':'POST','scheme':'http',
                   'path':'/internal/onboarding/v1/swap-preview','raw_path':b'/internal/onboarding/v1/swap-preview',
                   'query_string':b'','root_path':'','server':('127.0.0.1',8880),'client':('127.0.0.1',40000),
                   'headers':[(k.lower().encode(),v.encode()) for k,v in {**HEADERS,'Content-Type':'application/json'}.items()]}
            await app(scope,receive,send)
            return sent
        messages=asyncio.run(run())
        self.assertEqual(messages[0]['status'],504)
        self.verifier.verify.assert_not_called()
        self.auth.begin.assert_not_called()

    def test_launcher_disabled_has_no_credential_rpc_or_database_reads(self):
        with tempfile.TemporaryDirectory() as temporary:
            fd=acquire_session_lock(Path(temporary)/'runtime')
            with patch('onboarding_api.acquire_session_lock',return_value=fd),patch.dict(os.environ,{},clear=True),\
                 patch.object(sys,'argv',['onboarding_api.py']),patch('onboarding_api.load_session_rpc_config') as rpc,\
                 patch('uniswap_config.load_config') as key,patch('catalogue.database_settings') as db,patch('uvicorn.run') as server:
                main()
                rpc.assert_not_called();key.assert_not_called();db.assert_not_called()
                self.assertFalse(server.call_args.args[0].state.gateway.enabled)
                self.assertEqual(server.call_args.kwargs['host'],'127.0.0.1')
                self.assertEqual(server.call_args.kwargs['port'],8880)
                self.assertFalse(server.call_args.kwargs['access_log'])
                self.assertFalse(server.call_args.kwargs['proxy_headers'])
            with self.assertRaises(OSError):os.fstat(fd)

    def test_launcher_invalid_enable_closes_lock_and_multiple_workers_are_rejected(self):
        with tempfile.TemporaryDirectory() as temporary:
            fd=acquire_session_lock(Path(temporary)/'runtime')
            with patch('onboarding_api.acquire_session_lock',return_value=fd),patch.dict(os.environ,{},clear=True),\
                 patch.object(sys,'argv',['onboarding_api.py','--enable']),patch('uvicorn.run') as server:
                with self.assertRaises(SystemExit) as error:main()
                self.assertEqual(error.exception.code,2);server.assert_not_called()
            with self.assertRaises(OSError):os.fstat(fd)
        with patch.dict(os.environ,{'WEB_CONCURRENCY':'2'},clear=True),\
             patch.object(sys,'argv',['onboarding_api.py']),patch('onboarding_api.acquire_session_lock') as lock:
            with self.assertRaises(SystemExit):main()
            lock.assert_not_called()


if __name__=='__main__':unittest.main()
