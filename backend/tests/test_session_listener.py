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
from session_siwe import SiwePolicy, siwe_policies
from session_store import SessionStore

ORIGIN='https://app.example.invalid'
PREVIEW='https://preview.pages-project.invalid'
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
        self.assertTrue({'no-store', 'no-transform'} <= {value.strip().lower() for value in response.headers['cache-control'].split(',')})
        self.assertNotIn('content-encoding', response.headers)
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

    def test_http_challenge_is_uniform_and_only_the_owner_signature_logs_in(self):
        other=Account.from_key(bytes([10])*32)
        shapes=[]
        for account,wrong in ((self.account,other),(other,self.account)):
            initial=self.success('bootstrap')
            credentials={'preauth':initial['credentials']['preauth'],'csrf':initial['result']['csrfToken']}
            value=self.success('challenge',{'address':account.address,'chainId':4663},**credentials)
            shapes.append((set(value),set(value['result']),value['credentials']))
            issued=value['result']
            body={'challengeId':issued['challengeId'],'message':issued['message'],
                'signature':'0x'+Account.sign_message(encode_defunct(text=issued['message']),wrong.key).signature.hex()}
            response=self.request('verify',body,**credentials)
            self.assertEqual((response.status_code,response.json()),(401,{'error':'invalid_signature'}))
            self.checker.check.assert_not_called()
        self.assertEqual(shapes[0],shapes[1])
        # The owner's own signature on that same challenge logs in: no list
        # decides who may, only who holds the address.
        body['signature']='0x'+Account.sign_message(encode_defunct(text=issued['message']),other.key).signature.hex()
        response=self.request('verify',body,**credentials)
        self.assertEqual(response.status_code,200,response.text)
        self.checker.check.assert_called_once_with(other.address.lower())
        rows=self.admin.execute('SELECT address FROM domino_sessions.sessions').fetchall()
        self.assertEqual([row['address'] for row in rows],[other.address.lower()])

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

    # Launch round P3 (4 Nov 2026), item 7: a listed Pages preview signs in through the same listener and store, with
    # a sign-in message of its own; a challenge asked from one origin never signs in from the other.
    def preview_client(self):
        settings={'host':str(SOCKET),'port':PORT,'dbname':'domino_catalogue_tests'}
        store=SessionStore(settings,abuse_secret=b'synthetic session listener abuse secret')
        service=SessionService(store,siwe_policies(ORIGIN,PREVIEW),self.checker)
        gateway=SessionGateway(service=service,verifier=self.verifier,origin=ORIGIN,preview_origins=PREVIEW,enabled=True)
        client=TestClient(create_session_app(gateway),client=('127.0.0.1',43100),base_url='http://127.0.0.1:8879')
        client.__enter__()
        self.addCleanup(client.__exit__,None,None,None)
        self.client,self.store=client,store

    def challenge(self,origin):
        initial=self.success('bootstrap',headers={'X-Domino-Browser-Origin':origin})
        credentials={'preauth':initial['credentials']['preauth'],'csrf':initial['result']['csrfToken']}
        issued=self.success('challenge',{'address':self.account.address,'chainId':4663},
                            headers={'X-Domino-Browser-Origin':origin},**credentials)['result']
        signature='0x'+Account.sign_message(encode_defunct(text=issued['message']),self.account.key).signature.hex()
        return credentials,issued,{'challengeId':issued['challengeId'],'message':issued['message'],'signature':signature}

    def test_a_listed_preview_signs_in_with_a_message_naming_the_preview(self):
        self.preview_client()
        credentials,issued,body=self.challenge(PREVIEW)
        lines=issued['message'].split('\n')
        self.assertEqual(lines[0],PREVIEW+' wants you to sign in with your Ethereum account:')
        self.assertEqual(lines[5],'URI: '+PREVIEW+'/')
        logged=self.success('verify',body,headers={'X-Domino-Browser-Origin':PREVIEW},**credentials)
        session={'session':logged['credentials']['session'],'csrf':logged['result']['csrfToken']}
        self.assertEqual(self.success('me',headers={'X-Domino-Browser-Origin':PREVIEW},session=session['session'])['result'],
                         logged['result'])
        self.assertEqual(self.success('logout',headers={'X-Domino-Browser-Origin':PREVIEW},**session)['result'],
                         {'authenticated':False})
        # Production signs in as it did, beside it, with its own message.
        _,production,_=self.challenge(ORIGIN)
        self.assertTrue(production['message'].startswith(ORIGIN+' wants you'))

    def test_a_challenge_asked_from_one_origin_never_signs_in_from_the_other(self):
        self.preview_client()
        for asked,presented in ((PREVIEW,ORIGIN),(ORIGIN,PREVIEW)):
            with self.subTest(asked=asked,presented=presented):
                credentials,_,body=self.challenge(asked)
                # Its own preauth context and CSRF, the owner's valid signature: refused, nothing created.
                response=self.request('verify',body,headers={'X-Domino-Browser-Origin':presented},**credentials)
                self.assertEqual((response.status_code,response.json()),(401,{'error':'challenge_invalid'}))
                self.assertEqual(self.admin.execute('SELECT count(*) AS n FROM domino_sessions.sessions').fetchone()['n'],0)
                self.checker.check.assert_not_called()
                # The same signature still signs in where its message was asked: the refusal was the origin's.
                logged=self.success('verify',body,headers={'X-Domino-Browser-Origin':asked},**credentials)
                self.success('logout',headers={'X-Domino-Browser-Origin':asked},session=logged['credentials']['session'],
                             csrf=logged['result']['csrfToken'])
                self.admin.execute('TRUNCATE domino_sessions.sessions,domino_sessions.rate_limits,'
                                   'domino_sessions.private_limits')
                self.checker.check.reset_mock()

    def test_an_unlisted_preview_reaches_no_store(self):
        response=self.request('bootstrap',headers={'X-Domino-Browser-Origin':PREVIEW})
        self.assertEqual((response.status_code,response.json()),(403,{'error':'origin_not_allowed'}))
        self.assertEqual(self.admin.execute('SELECT count(*) AS n FROM domino_sessions.contexts').fetchone()['n'],0)

    # Review M1 (4 Nov 2026): a session belongs to the origin it signed in on (migration 057).
    def signed_in(self,origin):
        credentials,_,body=self.challenge(origin)
        logged=self.success('verify',body,headers={'X-Domino-Browser-Origin':origin},**credentials)
        return {'session':logged['credentials']['session'],'csrf':logged['result']['csrfToken']}

    def test_a_session_works_only_through_the_origin_it_signed_in_on_in_both_directions(self):
        self.preview_client()
        preview=self.signed_in(PREVIEW)
        self.success('logout',headers={'X-Domino-Browser-Origin':PREVIEW},**preview)
        self.admin.execute('TRUNCATE domino_sessions.rate_limits,domino_sessions.private_limits')
        preview=self.signed_in(PREVIEW)
        rows={row['origin'] for row in self.admin.execute(
            'SELECT origin FROM domino_sessions.sessions WHERE revoked_at IS NULL').fetchall()}
        self.assertEqual(rows,{PREVIEW})
        self.checker.check.reset_mock()
        # The preview's session, its own CSRF, presented through production: refused, untouched, not revoked.
        for route,credentials in (('me',{'session':preview['session']}),('refresh',preview),('logout',preview)):
            response=self.request(route,headers={'X-Domino-Browser-Origin':ORIGIN},**credentials)
            self.assertEqual((response.status_code,response.json()),(401,{'error':'session_required'}),route)
        self.checker.check.assert_not_called()
        self.assertIsNone(self.admin.execute('SELECT revoked_at FROM domino_sessions.sessions').fetchone()['revoked_at'])
        self.success('me',headers={'X-Domino-Browser-Origin':PREVIEW},session=preview['session'])
        self.success('refresh',headers={'X-Domino-Browser-Origin':PREVIEW},**preview)
        # The store's last recheck holds too, though the first already refused: neither origin's call passes for the other.
        with self.assertRaisesRegex(SessionError,'^session_required$'):
            self.store.finish_private(preview['session'],preview['csrf'],dict(VALIDATION))
        self.store.finish_private(preview['session'],preview['csrf'],dict(VALIDATION),origin=PREVIEW)
        # Production's session (NULL: the canonical origin) through the preview: refused the same way.
        self.admin.execute('TRUNCATE domino_sessions.rate_limits,domino_sessions.private_limits')
        production=self.signed_in(ORIGIN)
        self.assertEqual(self.admin.execute('SELECT count(*) AS n FROM domino_sessions.sessions WHERE origin IS NULL '
                                            'AND revoked_at IS NULL').fetchone()['n'],1)
        for route,credentials in (('me',{'session':production['session']}),('refresh',production),('logout',production)):
            response=self.request(route,headers={'X-Domino-Browser-Origin':PREVIEW},**credentials)
            self.assertEqual((response.status_code,response.json()),(401,{'error':'session_required'}),route)
        self.success('refresh',headers={'X-Domino-Browser-Origin':ORIGIN},**production)

    def test_unlisting_a_preview_revokes_its_sessions_by_origin_and_no_others(self):
        self.preview_client()
        preview=self.signed_in(PREVIEW)
        self.admin.execute('TRUNCATE domino_sessions.rate_limits,domino_sessions.private_limits')
        production=self.signed_in(ORIGIN)
        # The rollback step of docs/PREVIEW_PUBLIC_READS.md, as written there.
        revoked=self.admin.execute("UPDATE domino_sessions.sessions SET revoked_at=now() "
                                   "WHERE origin=%s AND revoked_at IS NULL",(PREVIEW,)).rowcount
        self.assertEqual(revoked,1)
        self.assertEqual(self.request('me',headers={'X-Domino-Browser-Origin':PREVIEW},
                                      session=preview['session']).status_code,401)
        self.success('me',headers={'X-Domino-Browser-Origin':ORIGIN},session=production['session'])

    def test_a_previews_sign_in_spends_its_own_budgets_never_productions(self):
        self.preview_client()
        bucket=lambda kind,value:self.admin.execute('SELECT count FROM domino_sessions.rate_limits WHERE key_hash=%s',
                                                    (self.store._key(kind,value),)).fetchone()
        self.signed_in(PREVIEW)
        for kind,value in (('issuance-global','all'),('issuance-ip','192.0.2.1'),('verify-global','all'),
                           ('verify-ip','192.0.2.1')):
            self.assertIsNone(bucket(kind,value),kind)
            self.assertIsNotNone(bucket(kind+'@preview',value),kind)
        self.assertEqual(bucket('issuance-global@preview','all')['count'],2)  # bootstrap and challenge
        self.assertIsNone(bucket('verified-address',self.account.address.lower()))
        self.assertEqual(bucket('verified-address@preview',self.account.address.lower())['count'],1)
        # A refresh's private credits too.
        self.success('refresh',headers={'X-Domino-Browser-Origin':PREVIEW},**self.signed_in(PREVIEW))
        credit=lambda kind,value:self.admin.execute('SELECT 1 FROM domino_sessions.private_limits WHERE key_hash=%s',
                                                    (self.store._key(kind,value),)).fetchone()
        for kind,value in (('private-ip','192.0.2.1'),('private-account',self.account.address.lower())):
            self.assertIsNotNone(credit(kind+'@preview',value),kind)
            self.assertIsNone(credit(kind,value),kind)
        self.admin.execute('TRUNCATE domino_sessions.rate_limits')
        self.signed_in(ORIGIN)
        self.assertEqual(bucket('issuance-global','all')['count'],2)
        self.assertIsNone(bucket('issuance-global@preview','all'))

    def test_the_stored_origin_is_one_the_listeners_admit_or_null(self):
        self.preview_client()
        self.signed_in(PREVIEW)
        for value in ('http://preview.pages-project.invalid',PREVIEW+'/','https://PREVIEW.pages-project.invalid',
                      'https://*.pages-project.invalid',''):
            with self.subTest(value=value),self.assertRaises(psycopg.errors.CheckViolation):
                self.admin.execute('UPDATE domino_sessions.sessions SET origin=%s',(value,))


if __name__=='__main__':unittest.main()
