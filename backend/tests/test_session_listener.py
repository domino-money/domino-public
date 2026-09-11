"""Real ASGI -> SessionGateway -> Service -> task-local PostgreSQL boundary.

Only Access and chain RPC observations are stubbed; SIWE uses public synthetic
keys and the actual verifier. No deployed service, provider or wallet is used.
"""
import os
from pathlib import Path
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import Mock

sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
import psycopg
from psycopg.rows import dict_row
from eth_account import Account
from eth_account.messages import encode_defunct
from fastapi.testclient import TestClient

from dev_postgres import ADMIN, PORT, SOCKET
from session_api import SessionGateway, create_session_app
from session_models import CONTRACT_VERSION, RESPONSE_MODELS, SessionError
from session_service import SessionService
from session_siwe import SiwePolicy
from session_store import SessionStore

ORIGIN='https://app.example.invalid'
PREFIX='/internal/session/v1/'
VALIDATION={'method':'plain_eoa','blockNumber':'123','blockHash':'0x'+'ab'*32}


@unittest.skipUnless(os.environ.get('DOMINO_TEST_POSTGRES')=='1','set DOMINO_TEST_POSTGRES=1 after prepare-tests')
class SessionListenerTests(unittest.TestCase):
    def setUp(self):
        settings={'host':str(SOCKET),'port':PORT,'dbname':'domino_catalogue_tests'}
        self.admin=psycopg.connect(**settings,user=ADMIN,autocommit=True,row_factory=dict_row)
        self.addCleanup(self.admin.close)
        self.admin.execute('TRUNCATE domino_sessions.contexts,domino_sessions.challenges,domino_sessions.sessions,'
                           'domino_sessions.rate_limits,domino_sessions.private_limits')
        self.account=Account.from_key(bytes([3])*32)
        self.checker=SimpleNamespace(check=Mock(return_value=dict(VALIDATION)))
        self.verifier=SimpleNamespace(verify=Mock())
        store=SessionStore(settings,abuse_secret=b'synthetic session listener abuse secret')
        service=SessionService(store,SiwePolicy(ORIGIN),self.checker)
        gateway=SessionGateway(service=service,verifier=self.verifier,origin=ORIGIN,enabled=True)
        self.client=TestClient(create_session_app(gateway),client=('127.0.0.1',43100),base_url='http://127.0.0.1:8879')
        self.client.__enter__()
        self.addCleanup(self.client.__exit__,None,None,None)

    def request(self,route,body=None,*,method='POST',headers=None,**credentials):
        transport={'CF-Access-Jwt-Assertion':'synthetic-listener-assertion','X-Domino-Client-Id':'192.0.2.1',
                   'X-Domino-Browser-Origin':ORIGIN,'X-Domino-Session-Contract':CONTRACT_VERSION}
        transport.update({'X-Domino-'+name:value for name,value in credentials.items() if value is not None})
        transport.update(headers or {})
        response=self.client.request(method,PREFIX+route,json=body or {},headers=transport)
        self.assertEqual(response.headers['X-Domino-Session-Contract'],CONTRACT_VERSION)
        self.assertEqual(response.headers['Cache-Control'],'no-store')
        self.assertNotIn('set-cookie',response.headers)  # Only the external BFF emits cookies.
        return response

    def success(self,route,body=None,**kwargs):
        response=self.request(route,body,**kwargs)
        self.assertEqual(response.status_code,200,response.text)
        value=response.json()
        RESPONSE_MODELS[route].model_validate(value['result'])
        return value

    def login(self):
        initial=self.success('bootstrap')
        credentials={'preauth':initial['credentials']['preauth'],'csrf':initial['result']['csrfToken']}
        issued=self.success('challenge',{'address':self.account.address,'chainId':4663},**credentials)['result']
        signature='0x'+Account.sign_message(encode_defunct(text=issued['message']),self.account.key).signature.hex()
        logged=self.success('verify',{'challengeId':issued['challengeId'],'message':issued['message'],
                                    'signature':signature},**credentials)
        return {'session':logged['credentials']['session'],'csrf':logged['result']['csrfToken']},logged['result']

    def test_real_listener_login_reload_refresh_and_logout(self):
        credentials,logged=self.login()
        stored=self.admin.execute('SELECT * FROM domino_sessions.sessions').fetchone()
        recovered=self.success('me',session=credentials['session'])
        self.assertEqual(recovered['result'],logged)
        self.assertEqual(self.admin.execute('SELECT * FROM domino_sessions.sessions').fetchone(),stored)
        self.checker.check.assert_called_once_with(self.account.address.lower())
        latest={**VALIDATION,'blockNumber':'124','blockHash':'0x'+'cd'*32}
        self.checker.check.return_value=latest
        refreshed=self.success('refresh',**credentials)
        self.assertEqual(refreshed['result']['validation'],latest)
        self.assertEqual(refreshed['result']['csrfToken'],credentials['csrf'])
        self.assertEqual(refreshed['credentials'],{})
        row=self.admin.execute('SELECT * FROM domino_sessions.sessions').fetchone()
        self.assertGreater(row['last_used_at'],stored['last_used_at'])
        self.assertEqual(row['expires_at'],stored['expires_at'])
        self.assertEqual(row['block_number'],'124')
        self.assertEqual(self.checker.check.call_count,2)
        self.assertEqual(self.success('logout',**credentials)['result'],{'authenticated':False})
        self.assertEqual(self.request('me',session=credentials['session']).status_code,401)
        self.assertEqual(self.verifier.verify.call_count,7)

    def test_real_listener_refresh_denies_method_path_version_and_csrf_before_mutation(self):
        credentials,_=self.login()
        stored=self.admin.execute('SELECT * FROM domino_sessions.sessions').fetchone()
        self.checker.check.side_effect=SessionError('account_unsupported')
        self.verifier.verify.reset_mock()
        for method in ('GET','PUT','PATCH','DELETE','OPTIONS'):
            response=self.request('refresh',method=method,**credentials)
            self.assertEqual((response.status_code,response.json()),(405,{'error':'method_not_allowed'}))
        for route in ('refresh/','%72efresh','refresh?tenant=other','refresh/other'):
            response=self.request(route,**credentials)
            self.assertEqual((response.status_code,response.json()),(404,{'error':'route_not_available'}))
        for headers,status in (({'X-Domino-Session-Contract':'1.0.0'},400),
                               ({'X-Domino-Browser-Origin':'https://foreign.example.invalid'},403)):
            self.assertEqual(self.request('refresh',headers=headers,**credentials).status_code,status)
        self.verifier.verify.assert_not_called()
        # Actual service/store reject missing or foreign CSRF, not a mock.
        for csrf in (None,'x'*43):
            response=self.request('refresh',session=credentials['session'],csrf=csrf)
            self.assertEqual((response.status_code,response.json()),(403,{'error':'csrf_invalid'}))
        self.assertEqual(self.admin.execute('SELECT * FROM domino_sessions.sessions').fetchone(),stored)
        self.assertEqual(self.admin.execute('SELECT count(*) AS n FROM domino_sessions.private_limits').fetchone()['n'],0)
        self.assertEqual(self.checker.check.call_count,1)
        # A valid request reaches the fresh checker and its revocation path.
        response=self.request('refresh',**credentials)
        self.assertEqual((response.status_code,response.json()),(403,{'error':'account_unsupported'}))
        self.assertIsNotNone(self.admin.execute('SELECT revoked_at FROM domino_sessions.sessions').fetchone()['revoked_at'])
        self.assertEqual(self.request('me',session=credentials['session']).status_code,401)


if __name__=='__main__':unittest.main()
