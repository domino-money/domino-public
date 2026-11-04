"""Private session/CSRF, keyset and status-schema boundary; no signer involved."""
from copy import deepcopy
from pathlib import Path
from types import SimpleNamespace
import json
import os
import sys
import tempfile
import time
import unittest
from unittest.mock import Mock, patch

sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from fastapi.testclient import TestClient
from discovery import CHAIN_ID, SNAPSHOT_LOOPBACK_RPC
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
        self.reader=SimpleNamespace(list=Mock(return_value=[item()]),
                                    availability=Mock(return_value={'operational':False,'checkedAtEpoch':100,'expiresAtEpoch':100}))
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

    def test_availability_is_owner_scoped_and_never_grants_execution_authority(self):
        vault='0x'+'56'*20
        self.reader.availability.return_value={'operational':True,'checkedAtEpoch':100,'expiresAtEpoch':110}
        result=self.post('availability',{'vault':vault})
        self.assertEqual(result.status_code,200,result.text)
        self.assertEqual(result.json(),{'contractVersion':CONTRACT_VERSION,'chainId':4663,'owner':OWNER,
                                        'vault':vault,'operational':True,'checkedAtEpoch':100,'expiresAtEpoch':110})
        self.reader.availability.assert_called_once_with(OWNER,vault)
        self.assertEqual(self.post('availability',{'vault':vault,'owner':OWNER}).status_code,400)
        self.assertEqual(self.post('availability',{'vault':vault.upper()}).status_code,400)
        self.reader.availability.return_value={'operational':True,'checkedAtEpoch':100,'expiresAtEpoch':111}
        self.assertEqual(self.post('availability',{'vault':vault}).status_code,502)

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

    def test_access_cookie_exact_duplicate_still_requires_verified_assertion(self):
        assertion=HEADERS['CF-Access-Jwt-Assertion']
        result=self.post(headers={**HEADERS,'Cookie':'CF_Authorization='+assertion})
        self.assertEqual(result.status_code,200,result.text)
        self.gateway.verifier.verify.assert_called_once_with(assertion)
        self.gateway.verifier.verify.side_effect=ValueError()
        self.assertEqual(self.post(headers={**HEADERS,'Cookie':'CF_Authorization='+assertion}).status_code,503)

    def test_access_cookie_other_values_or_duplicate_headers_are_refused(self):
        assertion=HEADERS['CF-Access-Jwt-Assertion']
        for value in ('CF_Authorization=wrong','other='+assertion,
                      'CF_Authorization='+assertion+'; other=x','CF_Authorization="'+assertion+'"'):
            self.assertEqual(self.post(headers={**HEADERS,'Cookie':value}).status_code,403)
        headers=list(HEADERS.items())+[('Cookie','CF_Authorization='+assertion)]*2
        self.assertEqual(self.post(headers=headers).status_code,403)
        headers=list(HEADERS.items())+[('Cookie','CF_Authorization='+assertion),('CF-Access-Jwt-Assertion',assertion)]
        self.assertEqual(self.post(headers=headers).status_code,403)
        self.reader.list.assert_not_called();self.gateway.verifier.verify.assert_not_called()


class ExecutionStatusStartupTests(unittest.TestCase):
    def setUp(self):
        self.temporary=tempfile.TemporaryDirectory(prefix='domino-execution-status-')
        self.addCleanup(self.temporary.cleanup)
        self.directory=Path(self.temporary.name).resolve()
        self.directory.chmod(0o700)
        secret=self.directory/'abuse-secret';secret.write_text('ab'*32);secret.chmod(0o600)
        self.config={'schemaVersion':1,'kind':'domino-execution-status','runtimeDirectory':str(self.directory),
            'database':{'host':str(self.directory),'port':5432,'dbname':'domino_catalogue'},
            'session':{'origin':auth_fixture.ORIGIN,'abuseSecretFile':str(secret),
                'rpcEndpoint':'https://rpc.mainnet.chain.robinhood.com','rpcAllowedHosts':['rpc.mainnet.chain.robinhood.com']},
            'access':{'issuer':'https://synthetic.cloudflareaccess.com','audience':'12'*32,'serviceId':'execution.synthetic'}}
        self.path=self.directory/'status.json';self.write()
    def write(self):
        self.path.write_text(json.dumps(self.config));self.path.chmod(0o600)

    def test_explicit_config_starts_fixed_loopback_no_signer_or_provider_calls(self):
        from execution_status_runtime import status_gateway
        from execution_status import main
        with patch('uvicorn.run') as run:
            self.assertEqual(main(['serve','--enable','--config',str(self.path)]),0)
        app=run.call_args.args[0]
        self.assertTrue(app.state.gateway.enabled)
        self.assertEqual(app.state.gateway.service.reader.role,'domino_execution_reader')
        self.assertEqual(app.state.gateway.verifier.service_id,'execution.synthetic')
        self.assertEqual(run.call_args.kwargs,{'host':'127.0.0.1','port':8901,'workers':1,
            'proxy_headers':False,'access_log':False,'server_header':False,'limit_concurrency':16})
        gateway,lock=status_gateway(self.path)
        try:
            self.assertEqual(gateway.service.auth.checker.urls,
                             ('https://rpc.mainnet.chain.robinhood.com',))
            with self.assertRaises((OSError,ValueError)):status_gateway(self.path)
        finally:os.close(lock)

    def test_private_status_profile_uses_only_pinned_loopback_for_eoa_check(self):
        from execution_status_runtime import status_gateway
        calls=[]
        block={'number':'0xa','hash':'0x'+'a'*64,'timestamp':hex(int(time.time()))}
        def local_rpc(url,body):
            calls.append((url,body['method'],body['params']))
            result={'eth_chainId':hex(CHAIN_ID),'eth_getBlockByNumber':block,
                    'eth_getCode':'0x'}[body['method']]
            return {'jsonrpc':'2.0','id':body['id'],'result':result}
        self.config['session']['rpcEndpoint']=SNAPSHOT_LOOPBACK_RPC
        self.write()
        with patch('session_chain.snapshot_loopback_http',local_rpc):
            gateway,lock=status_gateway(self.path)
        try:
            checker=gateway.service.auth.checker
            self.assertEqual(checker.urls,(SNAPSHOT_LOOPBACK_RPC,))
            self.assertIs(checker.transport,local_rpc)
            self.assertEqual(checker.check(OWNER)['method'],'plain_eoa')
            self.assertEqual({url for url,_,_ in calls},{SNAPSHOT_LOOPBACK_RPC})
            self.assertEqual([method for _,method,_ in calls],
                             ['eth_chainId','eth_chainId','eth_getBlockByNumber','eth_getCode',
                              'eth_getBlockByNumber','eth_chainId'])
        finally:os.close(lock)

    def test_status_profile_rejects_loopback_near_misses_without_fallback(self):
        from execution_status_runtime import status_gateway
        for bad in ('http://localhost:18547/','http://127.0.0.2:18547/',
                    'http://127.0.0.1:8547/',SNAPSHOT_LOOPBACK_RPC.rstrip('/'),
                    SNAPSHOT_LOOPBACK_RPC+'?route=https://evil.invalid'):
            self.config['session']['rpcEndpoint']=bad
            self.write()
            with self.subTest(endpoint=bad),self.assertRaisesRegex(
                    ValueError,'^invalid_session_rpc_config$'):
                status_gateway(self.path)

    def test_disabled_start_needs_no_config_and_cannot_enable_from_environment(self):
        from execution_status import main
        with patch('uvicorn.run') as run,patch.dict(os.environ,{'DOMINO_EXECUTION_ENABLE':'1'}):
            self.assertEqual(main(['serve']),0)
        self.assertFalse(run.call_args.args[0].state.gateway.enabled)
        with patch('uvicorn.run') as run:
            for args in (['serve','--enable'],['serve','--port','8900'],['serve','--config',str(self.path)]):
                with self.assertRaises(SystemExit) as failure:main(args)
                self.assertEqual(failure.exception.code,2)
        run.assert_not_called()

    def started(self, session=None, access=None):
        """status_gateway on this profile with `session`/`access` changes, its lock closed; (gateway, stderr)."""
        from execution_status_runtime import status_gateway
        import contextlib, io
        self.path.write_text(json.dumps({**self.config, 'session': {**self.config['session'], **(session or {})},
                                         'access': {**self.config['access'], **(access or {})}}))
        stderr = io.StringIO()
        with contextlib.redirect_stderr(stderr):
            gateway, lock = status_gateway(self.path)
        os.close(lock)
        return gateway, stderr.getvalue()

    def test_profile_may_list_the_exact_preview_origins_the_session_listener_lists(self):
        """Launch round P3 (4 Nov 2026), item 7: session.previewOrigins, optional, a list; absent or empty, none.
        Changed on purpose the same day (review L3): a malformed value turns the preview off, loudly, and the
        canonical origin serves; it used to refuse the profile, stopping the listener at its next restart."""
        from execution_status_runtime import status_gateway
        preview, second = 'https://preview.domino-app-e65.pages.dev', 'https://p3-testing.domino-app-e65.pages.dev'
        self.assertEqual(self.started({'previewOrigins': [preview, second]})[0].origins, (auth_fixture.ORIGIN, preview, second))
        for listed in ([], None):
            with self.subTest(listed=listed):
                gateway, stderr = self.started({} if listed is None else {'previewOrigins': listed})
                self.assertEqual((gateway.origins, stderr), ((auth_fixture.ORIGIN,), ''))
        for listed in (preview, f'{preview},{second}', ['https://*.domino-app-e65.pages.dev'], [preview + '/'],
                       [preview, preview], [auth_fixture.ORIGIN], [preview, 1], [preview, [second]], {'preview': preview},
                       [f'https://b{n}.domino-app-e65.pages.dev' for n in range(5)]):
            with self.subTest(malformed=listed):
                gateway, stderr = self.started({'previewOrigins': listed})
                self.assertTrue(gateway.enabled)
                self.assertEqual(gateway.origins, (auth_fixture.ORIGIN,))
                self.assertEqual(stderr, '<3>session.previewOrigins is malformed: preview origins are off, the canonical origin serves.\n')
        # A key the profile does not know is still a broken profile.
        self.path.write_text(json.dumps({**self.config, 'session': {**self.config['session'], 'previewOrigin': [preview]}}))
        with self.assertRaises(ValueError):status_gateway(self.path)

    def test_profile_may_name_the_preview_workers_own_access_identity(self):
        """Review L1 (4 Nov 2026): access.previewServiceId, optional; malformed or production's own id, off, loudly."""
        from execution_status_runtime import status_gateway
        gateway, stderr = self.started(access={'previewServiceId': 'execution.preview'})
        self.assertEqual((gateway.verifier.service_id, gateway.verifier.preview_service_id, stderr),
                         ('execution.synthetic', 'execution.preview', ''))
        self.assertIsNone(self.started()[0].verifier.preview_service_id)
        for value in ('bad id!', 'execution.synthetic', 7, ''):
            with self.subTest(value=value):
                gateway, stderr = self.started(access={'previewServiceId': value})
                self.assertIsNone(gateway.verifier.preview_service_id)
                self.assertEqual(stderr, '' if value == '' else
                                 '<3>access.previewServiceId is malformed: the preview Access identity is off, production serves.\n')
        self.path.write_text(json.dumps({**self.config, 'access': {**self.config['access'], 'previewService': 'x'}}))
        with self.assertRaises(ValueError):status_gateway(self.path)

    def test_config_rejects_keys_permissions_aliases_duplicates_and_missing_secret(self):
        from execution_status_runtime import status_gateway
        for patch_ in ({'schemaVersion':True},{'keyFile':'do-not-read'},{'database':{'host':'localhost','port':5432,'dbname':'domino_catalogue'}},
                       {'access':{**self.config['access'],'serviceId':''}}):
            self.path.write_text(json.dumps({**self.config,**patch_}))
            with self.assertRaises(Exception):status_gateway(self.path)
        self.write();self.path.chmod(0o644)
        with self.assertRaises(ValueError):status_gateway(self.path)
        self.path.chmod(0o600)
        alias=self.directory/'alias';alias.symlink_to(self.path)
        with self.assertRaises(OSError):status_gateway(alias)
        self.path.write_text('{"schemaVersion":1,"schemaVersion":1}')
        with self.assertRaises(Exception):status_gateway(self.path)
        self.write();Path(self.config['session']['abuseSecretFile']).unlink()
        with self.assertRaises(OSError):status_gateway(self.path)
