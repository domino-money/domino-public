import asyncio
from copy import deepcopy
from concurrent.futures import ThreadPoolExecutor
import json
from pathlib import Path
import sys
import threading
from threading import Event
import time
from types import SimpleNamespace
import unittest
from unittest.mock import Mock

sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from fastapi.testclient import TestClient
from pydantic import ValidationError

from discovery import DataError
from read_deadline import current_read_deadline
import session_api
from session_api import SessionGateway, create_session_app, MAX_WORKERS
from session_models import (CONTRACT_VERSION, REQUEST_MODELS, RESPONSE_MODELS, SessionError,
                            validate_body)
from session_contract_fixtures import build_fixtures

ORIGIN='https://domino.money'
HEADERS={'CF-Access-Jwt-Assertion':'synthetic-assertion','X-Domino-Client-Id':'192.0.2.1',
         'X-Domino-Browser-Origin':ORIGIN,'X-Domino-Session-Contract':CONTRACT_VERSION}
RESULT={'result':{'status':'challenge_required','csrfToken':'c'*43,'expiresAt':'2026-09-10T20:00:00Z'},
        'credentials':{'preauth':'p'*43}}


class SessionApiTests(unittest.TestCase):
    def setUp(self):
        self.service=SimpleNamespace(execute=Mock(return_value=deepcopy(RESULT)))
        self.verifier=SimpleNamespace(verify=Mock())
        self.gateway=SessionGateway(service=self.service,verifier=self.verifier,origin=ORIGIN,enabled=True)
        self.client=self.new_client(self.gateway)

    def new_client(self,gateway):
        client=TestClient(create_session_app(gateway),client=('127.0.0.1',43100),base_url='http://127.0.0.1:8879')
        client.__enter__()
        self.addCleanup(client.__exit__,None,None,None)
        return client

    def post(self,path='bootstrap',body=None,headers=None,client=None,raw=None):
        return (client or self.client).post('/internal/session/v1/'+path,
            content=raw if raw is not None else json.dumps({} if body is None else body),
            headers={'content-type':'application/json',**{k.lower():v for k,v in (HEADERS if headers is None else headers).items()}})

    def test_enabled_success_contract_and_named_credential_forwarding(self):
        response=self.post(headers={**HEADERS,'X-Domino-Preauth':'p'*43,'X-Domino-Session':'s'*43,'X-Domino-CSRF':'c'*43})
        self.assertEqual(response.status_code,200,response.text)
        self.assertEqual(response.json(),RESULT)
        self.assertEqual(response.headers['X-Domino-Session-Contract'],CONTRACT_VERSION)
        self.assertTrue({'no-store', 'no-transform'} <= {value.strip().lower() for value in response.headers['cache-control'].split(',')})
        self.assertNotIn('content-encoding', response.headers)
        self.assertEqual(response.headers['X-Content-Type-Options'],'nosniff')
        self.assertNotIn('set-cookie',response.headers)
        self.assertRegex(response.headers['X-Domino-Request-Id'],r'^[0-9a-f]{32}$')
        # Changed on purpose 2026-11-04 (launch round P3): the service is told the origin admitted, for its SIWE message.
        self.service.execute.assert_called_once_with('bootstrap',{},client='192.0.2.1',origin=ORIGIN,preauth='p'*43,
                                                     session='s'*43,csrf='c'*43)

    def test_disabled_listener_and_exact_routes_methods(self):
        disabled=self.new_client(SessionGateway())
        self.assertEqual(self.post(client=disabled).status_code,404)
        for path in ('bootstrap/','../bootstrap','me?x=1','%62ootstrap','health','verify?'):
            if path=='verify?':continue  # An empty query marker is normalized by HTTP clients.
            self.assertEqual(self.post(path).status_code,404,path)
        self.assertEqual(self.client.get('/internal/session/v1/me').status_code,405)
        self.service.execute.assert_not_called()

    def test_every_contract_route_reaches_the_actual_listener_dispatch(self):
        requests,responses,_=build_fixtures()
        self.assertEqual(set(requests),set(REQUEST_MODELS))
        self.assertEqual(set(responses),set(RESPONSE_MODELS))
        for route,body in requests.items():
            with self.subTest(route=route):
                credentials={'bootstrap':{'preauth':'p'*43},
                             'verify':{'preauth':None,'session':'s'*43},
                             'logout':{'preauth':None,'session':None}}.get(route,{})
                self.service.execute.reset_mock()
                self.service.execute.return_value={'result':responses[route],'credentials':credentials}
                response=self.post(route,body,headers={**HEADERS,'X-Domino-Session':'s'*43,'X-Domino-CSRF':'c'*43})
                self.assertEqual(response.status_code,200,response.text)
                self.assertEqual(response.json()['result'],responses[route])
                self.service.execute.assert_called_once_with(route,body,client='192.0.2.1',origin=ORIGIN,preauth=None,
                                                             session='s'*43,csrf='c'*43)
                for method in ('GET','PUT','PATCH','DELETE','OPTIONS'):
                    self.assertEqual(self.client.request(method,'/internal/session/v1/'+route).status_code,405)

    def test_origin_cookie_authorization_and_remote_fail_before_service(self):
        for field,value in (('Origin',ORIGIN),('Cookie','secret=value'),('Authorization','Bearer secret'),
                            ('X-Domino-Browser-Origin','https://other.domino.money')):
            response=self.post(headers={**HEADERS,field:value})
            self.assertEqual(response.status_code,403,response.text)
        outside=TestClient(create_session_app(self.gateway),client=('192.0.2.1',43100))
        self.addCleanup(outside.close)
        self.assertEqual(self.post(client=outside).status_code,403)
        self.service.execute.assert_not_called()

    def test_access_cookie_is_only_a_duplicate_not_authentication(self):
        response=self.post(headers={**HEADERS,'Cookie':'CF_Authorization=synthetic-assertion'})
        self.assertEqual(response.status_code,200,response.text)
        self.verifier.verify.assert_called_once_with('synthetic-assertion')
        self.verifier.verify.side_effect=DataError('invalid signature')
        self.service.execute.reset_mock()
        response=self.post(headers={**HEADERS,'Cookie':'CF_Authorization=synthetic-assertion'})
        self.assertEqual(response.status_code,503)
        self.service.execute.assert_not_called()
        for cookie in ('CF_Authorization=another','CF_Authorization=synthetic-assertion; other=x',
                       'CF_Authorization=synthetic-assertion; CF_Authorization=synthetic-assertion',''):
            self.assertEqual(self.post(headers={**HEADERS,'Cookie':cookie}).status_code,403,cookie)

    def test_duplicate_missing_and_malformed_internal_headers(self):
        for change in ({'X-Domino-CSRF':'bad'}, {'X-Domino-Session-Contract':'1.0.0'},
                       {'X-Domino-Client-Id':'example.com'}, {'X-Domino-CSRF':''}):
            self.assertEqual(self.post(headers={**HEADERS,**change}).status_code,400)
        headers=[('Content-Type','application/json'),*HEADERS.items(),('x-domino-client-id','192.0.2.2')]
        self.assertEqual(self.client.post('/internal/session/v1/bootstrap',content='{}',headers=headers).status_code,400)
        self.service.execute.assert_not_called()

    def test_transport_metadata_is_ignored_and_never_becomes_identity(self):
        response=self.post(headers={**HEADERS,'CF-Ray':'ignored','X-Forwarded-For':'203.0.113.9',
                                   'CF-Connecting-IP':'203.0.113.10','X-Domino-Owner':'0x'+'ab'*20})
        self.assertEqual(response.status_code,200)
        self.assertEqual(self.service.execute.call_args.kwargs['client'],'192.0.2.1')
        self.assertNotIn('owner',self.service.execute.call_args.kwargs)

    def test_strict_json_shape_numeric_chain_and_upload_size(self):
        for body in ('{"x":1,"x":2}','{"x":NaN}','{"x":1e999}','[]','null','{"__proto__":{}}'):
            self.assertEqual(self.post(raw=body).status_code,400,body)
        for chain in (True,4663.0,'4663',1):
            self.assertEqual(self.post('challenge',{'address':'0x'+'ab'*20,'chainId':chain}).status_code,400)
        self.assertEqual(self.post(raw=' '*8193).status_code,413)
        self.assertEqual(self.post(headers={**HEADERS,'Content-Encoding':'gzip'}).status_code,415)
        for content_type in ('application/json;charset=latin1','application/json;foo=bar','application/json;charset=utf-8;foo=bar'):
            self.assertEqual(self.post(headers={**HEADERS,'Content-Type':content_type}).status_code,415)
        self.service.execute.assert_not_called()

    def test_access_failure_and_arbitrary_exception_never_leak_details(self):
        self.verifier.verify.side_effect=DataError('secret upstream key')
        response=self.post()
        self.assertEqual((response.status_code,response.json()),(503,{'error':'upstream_unavailable'}))
        self.service.execute.assert_not_called()
        self.verifier.verify.side_effect=None
        self.service.execute.side_effect=RuntimeError('secret database URL')
        response=self.post()
        self.assertEqual((response.status_code,response.json()),(503,{'error':'upstream_unavailable'}))
        self.service.execute.side_effect=SessionError('session_store_unavailable')
        response=self.post()
        self.assertEqual(response.json(),{'error':'session_store_unavailable'})
        self.assertNotIn('credentials',response.json())

    def test_invalid_service_success_rejected_without_credentials(self):
        for change in ({'credentials':{'preauth':'invalid'}},{'credentials':{'session':'s'*43}},
                       {'result':{**RESULT['result'],'secret':'hidden'}}):
            self.service.execute.return_value={**deepcopy(RESULT),**change}
            response=self.post()
            self.assertNotEqual(response.status_code,200)
            self.assertEqual(set(response.json()),{'error'})

    def test_authentication_and_service_share_total_deadline(self):
        clock=[0.0]
        gateway=SessionGateway(service=self.service,verifier=self.verifier,origin=ORIGIN,enabled=True,clock=lambda:clock[0])
        seen=[]
        def auth(assertion):
            seen.append(current_read_deadline().remaining());clock[0]+=7
        def service(*args,**kwargs):
            seen.append(current_read_deadline().remaining());return deepcopy(RESULT)
        self.verifier.verify.side_effect=auth
        self.service.execute.side_effect=service
        response=self.post(client=self.new_client(gateway))
        self.assertEqual(response.status_code,200,response.text)
        self.assertEqual(seen,[20,13])

    def test_timed_out_workers_hold_all_admission_until_actual_exit(self):
        release=Event()
        started=[Event() for _ in range(MAX_WORKERS)]
        sequence=iter(started)
        def stuck(*args,**kwargs):
            next(sequence).set();release.wait(3);return deepcopy(RESULT)
        self.service.execute.side_effect=stuck
        gateway=SessionGateway(service=self.service,verifier=self.verifier,origin=ORIGIN,enabled=True,total_seconds=.15)
        client=self.new_client(gateway)
        try:
            with ThreadPoolExecutor(MAX_WORKERS) as pool:
                futures=[pool.submit(self.post,client=client) for _ in range(MAX_WORKERS)]
                for event in started:self.assertTrue(event.wait(1))
                for future in futures:self.assertEqual(future.result(1).status_code,504)
            response=self.post(client=client)
            self.assertEqual((response.status_code,response.json()),(429,{'error':'session_capacity_busy'}))
            self.assertEqual(self.service.execute.call_count,MAX_WORKERS)
        finally:release.set()
        deadline=time.monotonic()+2
        while client.app.state.pending and time.monotonic()<deadline:time.sleep(.01)
        self.service.execute.side_effect=None
        self.assertEqual(self.post(client=client).status_code,200)

    def test_retry_after_names_the_cause_of_each_429(self):
        # 3 Nov 2026 (launch): every 429 said 2 s. Always a whole number of seconds from 1 to 60.
        self.assertEqual({session_api.retry_after('session_capacity_busy') for _ in range(400)},{2,3,4,5})
        for wait,expected in ((12.2,13),(.01,1),(3600,60),(-3,1),(None,60),(float('nan'),60),(True,60)):
            self.assertEqual(session_api.retry_after('session_rate_limited',wait),expected,wait)
        from session_store import limited
        self.service.execute.side_effect=limited(41.5)
        response=self.post()
        self.assertEqual((response.status_code,response.json()),(429,{'error':'session_rate_limited'}))
        self.assertEqual(response.headers['Retry-After'],'42')

    def test_a_full_listener_waits_for_a_slot_before_refusing(self):
        for _ in range(MAX_WORKERS):self.gateway.slot.acquire()
        try:
            threading.Timer(.3,self.gateway.slot.release).start()
            started=time.monotonic()
            self.assertEqual(self.post().status_code,200)
            self.assertGreaterEqual(time.monotonic()-started,.25)
        finally:
            for _ in range(MAX_WORKERS-1):self.gateway.slot.release()

    def test_the_wait_ends_at_the_request_deadline_and_releases_its_place(self):
        gateway=SessionGateway(service=self.service,verifier=self.verifier,origin=ORIGIN,enabled=True,total_seconds=.3)
        client=self.new_client(gateway)
        for _ in range(MAX_WORKERS):gateway.slot.acquire()
        try:
            for attempt in range(session_api.MAX_WAITING+1):
                started=time.monotonic()
                response=self.post(client=client)
                elapsed=time.monotonic()-started
                self.assertEqual((response.status_code,response.json()),(429,{'error':'session_capacity_busy'}))
                self.assertIn(response.headers['Retry-After'],{'2','3','4','5'})
                self.assertTrue(.2<=elapsed<1.5,(attempt,elapsed))
        finally:
            for _ in range(MAX_WORKERS):gateway.slot.release()
        for _ in range(session_api.MAX_WAITING):self.assertTrue(self.gateway.waiting.acquire(blocking=False))
        try:
            for _ in range(MAX_WORKERS):self.gateway.slot.acquire()
            started=time.monotonic()
            self.assertEqual(self.post().json(),{'error':'session_capacity_busy'})
            self.assertLess(time.monotonic()-started,1)
        finally:
            for _ in range(MAX_WORKERS):self.gateway.slot.release()
            for _ in range(session_api.MAX_WAITING):self.gateway.waiting.release()
        self.service.execute.assert_not_called()

    def test_slow_body_is_bounded_before_any_auth_or_db_work(self):
        gateway=SessionGateway(service=self.service,verifier=self.verifier,origin=ORIGIN,enabled=True,upload_seconds=.03)
        app=create_session_app(gateway)
        async def run():
            sent=[]
            async def receive():
                await asyncio.sleep(.1)
                return {'type':'http.request','body':b'{}','more_body':False}
            async def send(message):sent.append(message)
            scope={'type':'http','asgi':{'version':'3.0'},'http_version':'1.1','method':'POST','scheme':'http',
                   'path':'/internal/session/v1/bootstrap','raw_path':b'/internal/session/v1/bootstrap',
                   'query_string':b'','root_path':'','server':('127.0.0.1',8879),'client':('127.0.0.1',40000),
                   'headers':[(k.lower().encode(),v.encode()) for k,v in {**HEADERS,'Content-Type':'application/json'}.items()]}
            await app(scope,receive,send)
            return sent
        messages=asyncio.run(run())
        self.assertEqual(messages[0]['status'],504)
        self.verifier.verify.assert_not_called()
        self.service.execute.assert_not_called()

    def test_fulfilled_body_after_absolute_upload_deadline_is_rejected(self):
        clock=[0.0]
        gateway=SessionGateway(service=self.service,verifier=self.verifier,origin=ORIGIN,enabled=True,clock=lambda:clock[0])
        app=create_session_app(gateway)
        async def run():
            sent=[]
            async def receive():
                clock[0]=6
                return {'type':'http.request','body':b'{}','more_body':False}
            async def send(message):sent.append(message)
            scope={'type':'http','asgi':{'version':'3.0'},'http_version':'1.1','method':'POST','scheme':'http',
                   'path':'/internal/session/v1/bootstrap','raw_path':b'/internal/session/v1/bootstrap',
                   'query_string':b'','root_path':'','server':('127.0.0.1',8879),'client':('127.0.0.1',40000),
                   'headers':[(k.lower().encode(),v.encode()) for k,v in {**HEADERS,'Content-Type':'application/json'}.items()]}
            await app(scope,receive,send)
            return sent
        self.assertEqual(asyncio.run(run())[0]['status'],504)
        self.verifier.verify.assert_not_called()
        self.service.execute.assert_not_called()

    def test_cancelled_request_keeps_worker_slot_until_blocking_service_exits(self):
        release,entered=Event(),Event()
        def stuck(*args,**kwargs):
            entered.set();release.wait(3);return deepcopy(RESULT)
        self.service.execute.side_effect=stuck
        app=create_session_app(self.gateway)
        async def run():
            received=False
            async def receive():
                nonlocal received
                if not received:
                    received=True
                    return {'type':'http.request','body':b'{}','more_body':False}
                await asyncio.Event().wait()
            async def send(message):pass
            scope={'type':'http','asgi':{'version':'3.0'},'http_version':'1.1','method':'POST','scheme':'http',
                   'path':'/internal/session/v1/bootstrap','raw_path':b'/internal/session/v1/bootstrap',
                   'query_string':b'','root_path':'','server':('127.0.0.1',8879),'client':('127.0.0.1',40000),
                   'headers':[(k.lower().encode(),v.encode()) for k,v in {**HEADERS,'Content-Type':'application/json'}.items()]}
            task=asyncio.create_task(app(scope,receive,send))
            end=time.monotonic()+1
            while not entered.is_set() and time.monotonic()<end:await asyncio.sleep(.001)
            self.assertTrue(entered.is_set())
            task.cancel()
            with self.assertRaises(asyncio.CancelledError):await task
            for index in range(MAX_WORKERS-1):self.assertTrue(self.gateway.slot.acquire(blocking=False))
            self.assertFalse(self.gateway.slot.acquire(blocking=False))
            for index in range(MAX_WORKERS-1):self.gateway.slot.release()
            release.set()
            end=time.monotonic()+1
            while app.state.pending and time.monotonic()<end:await asyncio.sleep(.001)
            self.assertFalse(app.state.pending)
        try:asyncio.run(run())
        finally:release.set()

    def test_public_models_reject_non_boolean_bad_dates_and_utf8_overflow(self):
        for value in (0,1,'false'):
            with self.assertRaises(ValidationError):RESPONSE_MODELS['logout'].model_validate({'authenticated':value})
        for date in ('2026-02-30T01:00:00Z','2026-01-01T25:00:00Z','２０２６-01-01T00:00:00Z'):
            with self.assertRaises(ValidationError):RESPONSE_MODELS['bootstrap'].model_validate({**RESULT['result'],'expiresAt':date})
        for message in ('é'*1025,'\ud800'):
            body={'challengeId':'a'*32,'message':message,'signature':'0x'+'ab'*65}
            with self.assertRaises(ValidationError):REQUEST_MODELS['verify'].model_validate(body)
            with self.assertRaises(SessionError):validate_body('verify',body)


if __name__=='__main__':unittest.main()
