"""Private session/CSRF, keyset and status-schema boundary; no signer involved."""
from copy import deepcopy
from pathlib import Path
from types import SimpleNamespace
import json
import sys
import unittest
from unittest.mock import Mock

sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from fastapi.testclient import TestClient
from onboarding_auth import OnboardingAuth
from execution_status import *
import test_performance_api as auth_fixture

OWNER=auth_fixture.OWNER
ID='0x'+'12'*32
HEADERS={**auth_fixture.HEADERS}
HEADERS.pop('X-Domino-Performance-Contract')
HEADERS[HEADER]=CONTRACT_VERSION

def item(identifier=ID):
    return {'intentId':identifier,'sequenceHash':'0x'+'34'*32,'state':'reserved','reason':'',
            'signer':None,'nonceRaw':None,'attempts':[],'receipt':None,'canCancel':True}

class ExecutionStatusTests(unittest.TestCase):
    def setUp(self):
        self.auth_store=auth_fixture.AuthStore()
        checker=SimpleNamespace(check=Mock(return_value={'method':'plain_eoa','blockNumber':'100','blockHash':auth_fixture.h(100)}))
        self.auth=OnboardingAuth(self.auth_store,checker)
        self.reader=SimpleNamespace(list=Mock(return_value=[item()]))
        self.service=ExecutionStatusService(self.auth,self.reader)
        self.gateway=ExecutionStatusGateway(service=self.service,verifier=SimpleNamespace(verify=Mock()),origin=auth_fixture.ORIGIN,enabled=True)
        self.client=TestClient(create_execution_status_app(self.gateway),client=('127.0.0.1',40000))
        self.client.__enter__();self.addCleanup(self.client.__exit__,None,None,None)
    def post(self,route='status',body=None,headers=None):
        return self.client.post(PREFIX+route,json={'intentId':ID} if body is None else body,headers=HEADERS if headers is None else headers)

    def test_authenticated_read_uses_session_owner_and_reauth_after_store(self):
        result=self.post();self.assertEqual(result.status_code,200,result.text)
        self.assertEqual(result.json()['owner'],OWNER)
        self.reader.list.assert_called_once_with(OWNER,identifier=ID,limit=1)
        self.assertEqual(self.auth_store.finish_calls,2)
        self.assertFalse(result.json()['executionAvailable'])
        self.assertEqual(result.headers[HEADER],CONTRACT_VERSION)
        for secret in ('signed_bytes','envelope','session','csrf','plan','keyFile'):
            self.assertNotIn('"'+secret+'"',result.text)
        self.assertEqual(set(result.headers['cache-control'].split(', ')),{'no-store','no-transform'})

    def test_no_owner_signer_nonce_calldata_in_requests(self):
        for field,value in [('owner',OWNER),('signer',OWNER),('nonceRaw','0'),('data','0x'),('privateKey','synthetic')]:
            self.assertEqual(self.post(body={'intentId':ID,field:value}).status_code,ERROR_STATUS_BY_CODE['invalid_request'],field)
        self.reader.list.assert_not_called()

    def test_missing_foreign_are_identical_and_keyset_is_owner_bound(self):
        self.reader.list.return_value=[]
        missing=self.post().json();self.assertIsNone(missing['item'])
        other=self.post(body={'intentId':'0x'+'ff'*32}).json();self.assertEqual(missing,other)
        self.reader.list.return_value=[item('0x'+'21'*32),item('0x'+'22'*32)]
        response=self.post('list',{'limit':1,'afterIntentId':ID})
        self.assertEqual(response.status_code,200,response.text)
        self.assertEqual(len(response.json()['items']),1)
        self.assertEqual(response.json()['nextAfterIntentId'],'0x'+'21'*32)
        self.reader.list.assert_called_with(OWNER,after=ID,limit=2)
        for body in ({'limit':21},{'limit':True},{'afterIntentId':'bad'},{'limit':0}):
            self.assertEqual(self.post('list',body).status_code,ERROR_STATUS_BY_CODE['invalid_request'])

    def test_revocation_during_query_prevents_release(self):
        def read(*args,**kwargs):self.auth_store.revoked=True;return [item()]
        self.reader.list.side_effect=read
        result=self.post();self.assertEqual(result.status_code,401,result.text)
        self.assertNotIn('item',result.json())

    def test_missing_csrf_and_session_fail_before_read(self):
        for name in ('X-Domino-Session','X-Domino-CSRF'):
            headers={k:v for k,v in HEADERS.items() if k!=name}
            self.assertIn(self.post(headers=headers).status_code,(401,403))
        self.reader.list.assert_not_called()

    def test_browser_origin_untrusted_assertion_disabled_and_unknown_paths(self):
        self.assertEqual(self.post(headers={**HEADERS,'Origin':auth_fixture.ORIGIN}).status_code,403)
        self.assertEqual(self.post('sign').status_code,404)
        self.assertEqual(self.post('cancel').status_code,404)
        self.gateway.verifier.verify.side_effect=ValueError('private diagnostic')
        result=self.post();self.assertEqual(result.status_code,503);self.assertNotIn('private diagnostic',result.text)
        self.gateway.enabled=False;self.assertEqual(self.post().status_code,404)
        self.reader.list.assert_not_called()

    def test_inconsistent_or_extra_receipt_cannot_be_rendered(self):
        for change in ({'state':'signed','canCancel':True},{'state':'reconciled','receipt':None},
                       {'signed_bytes':'0x00'},{'reason':'http://secret.invalid/key'}):
            self.reader.list.return_value=[{**item(),**change}]
            self.assertEqual(self.post().status_code,502)
