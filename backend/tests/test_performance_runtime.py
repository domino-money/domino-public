import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from performance_runtime import Runtime, private_json
from test_performance_store import OWNER, baseline


class RuntimeTests(unittest.TestCase):
    def setUp(self):
        self.temporary=tempfile.TemporaryDirectory(prefix='domino-performance-profile-')
        self.addCleanup(self.temporary.cleanup)
        self.directory=Path(self.temporary.name).resolve()
        self.runtime=self.directory/'runtime'; self.runtime.mkdir(mode=0o700)
        self.base=baseline()
        self.provider=self.write('provider.json',{'version':2,'rpcUrl':'https://rpc.mainnet.chain.robinhood.com',
            'inventoryUrl':None,'rpcFallbackUrls':[],'rpcAllowedHosts':['rpc.mainnet.chain.robinhood.com']})
        self.database=self.write('database.json',{'host':str(self.directory/'socket'),'port':8877,'dbname':'domino_catalogue'})
        self.profile={'version':1,'expiresAt':int(time.time())+600,'rpcConfig':str(self.provider),
            'databaseConfig':str(self.database),'runtimeDirectory':str(self.runtime),
            'subjects':[{'owner':OWNER,'vault':self.base.vault,'vaultCodeHash':self.base.vaultCodeHash}]}
        self.path=self.write('profile.json',self.profile)

    def write(self,name,value):
        path=self.directory/name; path.write_text(json.dumps(value)); path.chmod(0o600); return path

    def test_private_profile_explicit_subjects_and_default_cooldown(self):
        value=Runtime(self.path)
        self.assertEqual(value.admission(OWNER,self.base.vault),self.base.vaultCodeHash)
        self.assertIsNone(value.admission('0x'+'f'*40,self.base.vault))
        self.assertEqual(value.producer().tick(),'cooldown')

    def local_profile(self):
        from configure_rpc import prepare_local_config
        data = prepare_local_config({'rpcUrl':'https://rpc.mainnet.chain.robinhood.com'},
                                    'SYNTHETIC_LOCAL_TOKEN_123')
        self.write('provider.json',data)
        producer = Runtime(self.path).producer()
        producer.rpc.ready_at = 0
        return data, producer

    def test_local_primary_counts_identity_proof_and_request_without_fallback(self):
        data, producer = self.local_profile()
        calls = []
        def transport(url, payload, **kwargs):
            calls.append((url, payload['method']))
            return {'jsonrpc':'2.0','id':payload['id'],'result':'0x1237'}
        with patch('performance_runtime.json_http', side_effect=transport):
            self.assertEqual(producer.rpc.request('eth_chainId', []), '0x1237')
        self.assertEqual(calls, [(data['rpcUrl'],'eth_chainId')]*2)
        self.assertEqual(len(producer.rpc.calls), 2)

    def test_old_state_recovery_charges_every_wire_attempt_to_same_budget(self):
        from performance_collection import CollectionError
        from test_rpc_providers import BLOCK, TOKEN
        data, producer = self.local_profile()
        calls = []
        missing = {'code':-32000,'message':'missing trie node '+'a'*64+' (path ) state 0x01 is not available, not found'}
        def transport(url, payload, **kwargs):
            method = payload['method']; calls.append((url,method))
            response = {'jsonrpc':'2.0','id':payload['id']}
            if method == 'eth_chainId': response['result']='0x1237'
            elif method == 'eth_getBlockByNumber': response['result']=BLOCK
            elif url == data['rpcUrl']: response['error']=missing
            else: response['result']='0x6000'
            return response
        with patch('performance_runtime.json_http',side_effect=transport):
            self.assertEqual(producer.rpc.request('eth_getCode',[TOKEN,BLOCK['number']]),'0x6000')
        self.assertEqual(calls, [(data['rpcUrl'],'eth_chainId'),
            (data['rpcUrl'],'eth_getBlockByNumber'),(data['rpcUrl'],'eth_getCode'),
            (data['rpcFallbackUrls'][0],'eth_chainId'),
            (data['rpcFallbackUrls'][0],'eth_getBlockByNumber'),
            (data['rpcFallbackUrls'][0],'eth_getCode')])
        self.assertEqual(len(producer.rpc.calls),len(calls))
        producer.rpc.maximum=len(calls)
        with patch('performance_runtime.json_http') as blocked:
            with self.assertRaisesRegex(CollectionError,'^collection_rpc_budget$'):
                producer.rpc.request('eth_chainId')
            blocked.assert_not_called()

    def test_changed_fallback_identity_fails_instead_of_returning_state(self):
        from discovery import DataError
        from test_rpc_providers import BLOCK, TOKEN
        data, producer = self.local_profile()
        def transport(url, payload, **kwargs):
            if url != data['rpcUrl']: result='0x1'
            elif payload['method']=='eth_chainId': result='0x1237'
            elif payload['method']=='eth_getBlockByNumber': result=BLOCK
            else: raise DataError('http_503')
            return {'jsonrpc':'2.0','id':payload['id'],'result':result}
        with patch('performance_runtime.json_http',side_effect=transport):
            with self.assertRaisesRegex(DataError,'^wrong_chain$'):
                producer.rpc.request('eth_getCode',[TOKEN,BLOCK['number']])

    def test_v4_actual_collector_capture_and_page_keep_finalized_and_hash_pins(self):
        from copy import deepcopy
        from test_performance_collection import FakePerformanceRpc, OWNER, VAULT, CODE_HASH, vault_log
        data, producer = self.local_profile()
        fake = FakePerformanceRpc()
        wire = []
        def transport(url, payload, **kwargs):
            self.assertEqual(url, data['rpcUrl'])
            method, params = payload['method'], payload['params']
            wire.append((method, deepcopy(params)))
            if method == 'eth_getBlockByHash':
                result = next((deepcopy(block) for block in fake.headers.values() if block['hash']==params[0]), None)
            else:
                result = fake.request(method, params)
            return {'jsonrpc':'2.0','id':payload['id'],'result':result}
        with patch('performance_runtime.json_http', side_effect=transport):
            baseline = producer.collector.capture(OWNER, VAULT, ['1'], CODE_HASH)
            fake.add_transaction(logs=[vault_log()])
            fake.finalized = 11
            page = producer.collector.collect(baseline, baseline.baseline)
        self.assertEqual(baseline.baseline.blockNumber, 10)
        self.assertEqual(page.throughCursor.blockNumber, 11)
        self.assertTrue(any(method=='eth_getBlockByNumber' and params[0]=='finalized' for method,params in wire))
        state = [params[-1] for method, params in wire if method in ('eth_call','eth_getCode','eth_getBalance')]
        self.assertTrue(state)
        self.assertTrue(all(isinstance(tag,dict) and tag.get('requireCanonical') is True for tag in state))
        self.assertEqual(len(producer.rpc.calls), len(wire))

    def test_eip1898_fallback_keeps_hash_and_refuses_noncanonical_recovery(self):
        from copy import deepcopy
        from discovery import DataError
        from test_performance_collection import FakePerformanceRpc, CODE, VAULT
        fake = FakePerformanceRpc()
        block = fake.headers[10]
        tag = {'blockHash': block['hash'], 'requireCanonical': True}
        for mismatch in (False, True):
            with self.subTest(mismatch=mismatch):
                data, producer = self.local_profile()
                wire = []
                def transport(url, payload, **kwargs):
                    method, params = payload['method'], payload['params']
                    wire.append((url, method, deepcopy(params)))
                    reply = {'jsonrpc':'2.0','id':payload['id']}
                    if method == 'eth_getBlockByHash': result = deepcopy(block)
                    elif method == 'eth_getCode':
                        self.assertEqual(params[-1], tag)
                        if url == data['rpcUrl']:
                            reply['error'] = {'code':-32000,'message':'missing trie node '+'a'*64+' (path ) state unavailable'}
                            return reply
                        result = CODE
                    else: result = fake.request(method, params)
                    if mismatch and url != data['rpcUrl'] and method == 'eth_getBlockByNumber':
                        result['hash'] = '0x'+'f'*64
                    return {**reply,'result':result}
                with patch('performance_runtime.json_http', side_effect=transport):
                    if mismatch:
                        with self.assertRaisesRegex(DataError,'^snapshot_reorganized$'):
                            producer.rpc.request('eth_getCode',[VAULT,tag])
                    else:
                        self.assertEqual(producer.rpc.request('eth_getCode',[VAULT,tag]),CODE)
                self.assertEqual(len(producer.rpc.calls),len(wire))
                fallback_state = [row for row in wire if row[0]!=data['rpcUrl'] and row[1]=='eth_getCode']
                self.assertEqual(len(fallback_state), 0 if mismatch else 1)

    def test_missing_or_linked_or_shared_configuration_fails_closed(self):
        with self.assertRaises(OSError): private_json(self.directory/'absent.json')
        link=self.directory/'linked.json'; link.symlink_to(self.path)
        with self.assertRaises(OSError): private_json(link)
        self.path.chmod(0o644)
        with self.assertRaises(ValueError): Runtime(self.path)
        self.path.chmod(0o600)
        with self.assertRaises(ValueError): private_json(Path(__file__).resolve())

    def test_expiry_is_absolute_and_has_no_provider_or_production_fallback(self):
        self.profile['expiresAt']=1; self.write('profile.json',self.profile)
        with self.assertRaises(ValueError): Runtime(self.path)
        self.profile['expiresAt']=int(time.time())+600
        self.profile['rpcConfig']=str(self.directory/'absent.json'); self.write('profile.json',self.profile)
        with self.assertRaises(OSError): Runtime(self.path)

    def test_cli_enable_requires_explicit_profile_without_starting_listener(self):
        command=[sys.executable,str(Path(__file__).resolve().parents[1]/'performance_v2_api.py'),'serve','--enable']
        result=subprocess.run(command,text=True,capture_output=True,timeout=10)
        self.assertEqual(result.returncode,2)
        self.assertIn('Performance configuration invalid',result.stderr)
        self.assertNotIn('Traceback',result.stderr)


if __name__=='__main__': unittest.main()
