"""Deposit-specific private ingress and secure launcher checks; no network."""
from copy import deepcopy
import json
import os
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from fastapi.testclient import TestClient
from deposit_api import DepositGateway, create_deposit_app, load_admission, main
from deposit_models import DepositError
from deposit_contract_fixtures import build_fixtures
from test_deposit_prepare import signed_manifest

ORIGIN='https://domino.money'
HEADERS={'Content-Type':'application/json','X-Domino-Deposit-Contract':'1.1.0-rc.4',
    'X-Domino-Browser-Origin':ORIGIN,'CF-Access-Jwt-Assertion':'synthetic-service-assertion',
    'X-Domino-Client-Id':'192.0.2.1','X-Domino-Session':'a'*43,'X-Domino-CSRF':'b'*43}


class DepositApiTests(unittest.TestCase):
    def setUp(self):
        self.requests,self.responses,_=build_fixtures()
        self.service=SimpleNamespace(execute=Mock(side_effect=lambda route,*args,**kw:deepcopy(self.responses[route])))
        self.verifier=SimpleNamespace(verify=Mock())
        self.gateway=DepositGateway(service=self.service,verifier=self.verifier,origin=ORIGIN,enabled=True)
        self.client=self.client_for(self.gateway)

    def client_for(self,gateway,host='127.0.0.1'):
        client=TestClient(create_deposit_app(gateway),client=(host,40000))
        client.__enter__();self.addCleanup(client.__exit__,None,None,None)
        return client

    def post(self,route='create',headers=None,raw=None,client=None):
        return (client or self.client).post('/internal/deposit/v1/'+route,
            content=json.dumps(self.requests.get(route,{})) if raw is None else raw,
            headers=HEADERS if headers is None else headers)

    def test_all_routes_and_distinct_contract_header(self):
        for route in self.requests:
            response=self.post(route)
            self.assertEqual(response.status_code,200,response.text)
            self.assertEqual(response.headers['X-Domino-Deposit-Contract'],'1.1.0-rc.4')
            self.assertTrue({'no-store', 'no-transform'} <= {value.strip().lower() for value in response.headers['cache-control'].split(',')})
            self.assertNotIn('content-encoding', response.headers)
            self.assertNotIn('set-cookie',response.headers)
            self.assertNotIn('access-control-allow-origin',response.headers)
        self.assertEqual(self.service.execute.call_count,len(self.requests))

    def test_disabled_exact_paths_browser_denial_and_body_before_service(self):
        self.assertEqual(self.post(client=self.client_for(DepositGateway())).status_code,404)
        for path in ('create/','%63reate','create?owner=x','swap','sign','broadcast'):
            self.assertEqual(self.post(path).status_code,404,path)
        self.assertEqual(self.client.get('/docs').status_code,404)
        self.assertEqual(self.client.get('/internal/deposit/v1/create').status_code,405)
        self.assertEqual(self.post(client=self.client_for(self.gateway,'192.0.2.1')).status_code,403)
        for name in ('Origin','Cookie','Authorization'):
            self.assertEqual(self.post(headers={**HEADERS,name:'blocked'}).status_code,403)
        for raw in ('[]','null','{"x":1,"x":2}',json.dumps(self.requests['create']).replace('4663','4663.0'),
                    json.dumps({**self.requests['create'],'owner':'0x'+'cc'*20})):
            self.assertEqual(self.post(raw=raw).status_code,400,raw)
        self.assertEqual(self.post(raw=' '*8193).status_code,413)
        self.service.execute.assert_not_called()

    def test_access_failure_and_malformed_private_response_are_sanitized(self):
        self.verifier.verify.side_effect=RuntimeError('provider-secret')
        result=self.post();self.assertEqual((result.status_code,result.json()),(503,{'error':'upstream_unavailable'}))
        self.service.execute.assert_not_called()
        self.verifier.verify.side_effect=None
        self.service.execute.side_effect=lambda *args,**kwargs:{'secret':'provider-secret'}
        result=self.post();self.assertEqual(result.status_code,502)
        self.assertNotIn('provider-secret',result.text)

    def test_contract_mismatch_duplicate_headers_and_capacity(self):
        for version in ('1.0.0', '1.1.0-rc.2', '1.1.0-rc.3', '2.0.0'):
            self.assertEqual(self.post(headers={**HEADERS,'X-Domino-Deposit-Contract':version}).status_code,502)
        self.service.execute.assert_not_called()
        self.assertEqual(self.post(headers=[*HEADERS.items(),('x-domino-session','c'*43)]).status_code,400)
        self.gateway.slot.acquire();self.gateway.slot.acquire()
        try:
            result=self.post();self.assertEqual(result.status_code,429)
            self.assertEqual(result.json(),{'error':'deposit_capacity_busy'})
            self.assertEqual(result.headers['Retry-After'],'60')
        finally:self.gateway.slot.release();self.gateway.slot.release()


class DepositLauncherTests(unittest.TestCase):
    def test_disabled_start_reads_no_credentials_manifest_rpc_or_database(self):
        with tempfile.TemporaryDirectory() as temp:
            fd=os.open(Path(temp)/'lock',os.O_CREAT|os.O_RDWR,0o600)
            with patch('deposit_api.acquire_session_lock',return_value=fd),patch.dict(os.environ,{},clear=True),\
                 patch.object(sys,'argv',['deposit_api.py']),patch('deposit_api.load_admission') as admission,\
                 patch('deposit_api.load_session_rpc_config') as rpc,patch('uniswap_config.load_config') as key,\
                 patch('catalogue.database_settings') as db,patch('uvicorn.run') as server:
                main();admission.assert_not_called();rpc.assert_not_called();key.assert_not_called();db.assert_not_called()
                self.assertEqual(server.call_args.kwargs['port'],8881)
                self.assertFalse(server.call_args.args[0].state.gateway.enabled)

    def test_shared_ports_and_multiple_workers_are_rejected(self):
        for port in (8765,8876,8877,8878,8879,8880):
            with patch.object(sys,'argv',['deposit_api.py','--port',str(port)]),patch('deposit_api.acquire_session_lock') as lock:
                with self.assertRaises(SystemExit):main()
                lock.assert_not_called()
        with patch.object(sys,'argv',['deposit_api.py']),patch.dict(os.environ,{'WEB_CONCURRENCY':'2'}):
            with self.assertRaises(SystemExit):main()

    def test_admission_file_is_owned_private_regular_singlelink_and_valid(self):
        with tempfile.TemporaryDirectory() as temp:
            path=Path(temp)/'admission.json';path.write_text(json.dumps(signed_manifest()));path.chmod(0o600)
            with patch('deposit_api.time.time',return_value=1000):
                self.assertEqual(load_admission(path)['schemaVersion'],1)
                link=Path(temp)/'symlink';link.symlink_to(path)
                with self.assertRaises(OSError):load_admission(link)
                hard=Path(temp)/'hard';os.link(path,hard)
                with self.assertRaises(ValueError):load_admission(path)
                hard.unlink();path.chmod(0o644)
                with self.assertRaises(ValueError):load_admission(path)
                path.chmod(0o600);path.write_text('{"schemaVersion":1,"schemaVersion":1}')
                with self.assertRaises(ValueError):load_admission(path)
