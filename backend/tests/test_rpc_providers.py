from copy import deepcopy
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from discovery import CHAIN_ID, RPC_URL, DataError
from local_config import checked_config, load_config, save_config, configured_rpc_urls
from rpc_config import DEFAULT_RPC_HOSTS, rpc_endpoint
from rpc_failover import FailoverReadRpc
from read_deadline import read_deadline

ALCHEMY = 'https://robinhood-mainnet.g.alchemy.com/v2/SYNTHETIC'
SECOND = 'https://secondary.example.invalid/SYNTHETIC'
THIRD = 'https://tertiary.example.invalid/SYNTHETIC'
TOKEN = '0x'+'1'*40
BLOCK = {'number':'0xa', 'hash':'0x'+'a'*64, 'timestamp':'0x3e8'}


class ConfigTests(unittest.TestCase):
    def modern(self):
        return {'version':2, 'rpcUrl':RPC_URL, 'rpcFallbackUrls':[SECOND],
                'rpcAllowedHosts':[*DEFAULT_RPC_HOSTS, 'secondary.example.invalid'], 'inventoryUrl':ALCHEMY}

    def test_legacy_roundtrip_and_public_rpc_are_supported(self):
        for url in (ALCHEMY, RPC_URL):
            data = {'version':1, 'rpcUrl':url, 'inventoryUrl':ALCHEMY}
            with tempfile.TemporaryDirectory() as directory:
                path = Path(directory)/'providers.json'
                save_config(data, path)
                self.assertEqual(load_config(path), data)
                self.assertEqual(configured_rpc_urls(load_config(path)), (url,))

    def test_operator_can_add_provider_without_code_change_or_inventory_change(self):
        data = self.modern()
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory)/'providers.json'
            save_config(data, path)
            self.assertEqual(load_config(path), data)
            self.assertEqual(configured_rpc_urls(load_config(path)), (RPC_URL, SECOND))
            data['inventoryUrl'] = None
            save_config(data, path)
            self.assertIsNone(load_config(path)['inventoryUrl'])

    def test_invalid_field_is_preserved_on_load_without_input_echo(self):
        for field, value, reason in [('rpcUrl', SECOND, 'invalid_rpc_url'),
                                      ('inventoryUrl', RPC_URL, 'invalid_inventory_url')]:
            data = {'version':1,'rpcUrl':ALCHEMY,'inventoryUrl':ALCHEMY,field:value}
            with self.assertRaisesRegex(DataError, '^'+reason+'$'):
                checked_config(data)
            with tempfile.TemporaryDirectory() as directory:
                import json
                path=Path(directory)/'providers.json'
                path.write_text(json.dumps(data));path.chmod(0o600)
                with self.assertRaisesRegex(DataError, '^'+reason+'$'):load_config(path)

    def test_exact_host_bounds_and_no_url_credentials_or_network_selectors(self):
        for bad in ('http://rpc.mainnet.chain.robinhood.com', RPC_URL+'/secret', RPC_URL+'?redirect=x',
                    RPC_URL+'.evil.invalid', RPC_URL+':443', 'https://127.0.0.1', 'https://localhost',
                    ALCHEMY+'#fragment', 'https://user@rpc.mainnet.chain.robinhood.com',
                    'https://rpc.mainnet.chain.robinhood.com\\@evil.invalid', SECOND, None, True):
            with self.subTest(url=bad), self.assertRaises(DataError):rpc_endpoint(bad)
        for mutate in (lambda d:d.update(rpcFallbackUrls=[RPC_URL]),
                       lambda d:d.update(rpcFallbackUrls=[SECOND]*3),
                       lambda d:d.update(rpcFallbackUrls=['https://other.invalid']),
                       lambda d:d.update(rpcAllowedHosts=['*.example.invalid']),
                       lambda d:d.update(rpcAllowedHosts=['backend.local']),
                       lambda d:d.update(rpcAllowedHosts=['SECONDARY.EXAMPLE.INVALID']),
                       lambda d:d.update(version=True), lambda d:d.update(privateKey='rejected')):
            data=self.modern();mutate(data)
            with self.assertRaises(DataError):checked_config(data)

    def test_environment_override_is_validated_and_excludes_old_fallbacks(self):
        self.assertEqual(configured_rpc_urls(self.modern(), SECOND), (SECOND,))
        with self.assertRaises(DataError):configured_rpc_urls(self.modern(), 'https://unknown.invalid')

    def test_configurator_preserves_inventory_and_validates_all_endpoints(self):
        from configure_rpc import prepare_config
        data=prepare_config({'inventoryUrl':ALCHEMY},[RPC_URL,SECOND])
        self.assertEqual(data['inventoryUrl'],ALCHEMY)
        self.assertEqual(configured_rpc_urls(data),(RPC_URL,SECOND))
        with self.assertRaises(DataError):prepare_config({},[RPC_URL,'https://127.0.0.1'])

    def test_read_api_wires_ordered_endpoints_without_network_or_output_changes(self):
        from read_api import create_app
        with patch('read_api.load_config',return_value=self.modern()), \
             patch('read_api.configured_catalogue',return_value=None), \
             patch('read_api.ReadService') as service, \
             patch.dict('os.environ',{},clear=True):
            create_app()
        self.assertEqual(service.call_args.kwargs['rpc_urls'],(RPC_URL,SECOND))
        self.assertEqual(service.call_args.kwargs['inventory_url'],ALCHEMY)


class Provider:
    def __init__(self):
        self.calls=[];self.fail={};self.blocks={};self.chains={}

    def __call__(self,url,body):
        method=body['method'];self.calls.append((url,method,deepcopy(body['params'])))
        failure=self.fail.get((url,method))
        if failure:raise DataError(failure)
        if method=='eth_chainId':result=hex(self.chains.get(url,CHAIN_ID))
        elif method=='eth_getBlockByNumber':result=self.blocks.get(url,BLOCK)
        elif method=='eth_getCode':result='0x01'
        elif method=='eth_getBalance':result='0x5'
        else:result='0x'+'0'*64
        return {'jsonrpc':'2.0','id':body['id'],'result':deepcopy(result)}


class FailoverTests(unittest.TestCase):
    def setUp(self):
        self.provider=Provider()
        self.rpc=FailoverReadRpc((RPC_URL,SECOND,THIRD),transport=self.provider)

    def anchor(self):
        return self.rpc.request('eth_getBlockByNumber',['latest',False])

    def test_transport_outage_switches_once_after_checking_chain_and_snapshot(self):
        self.anchor()
        self.provider.fail[(RPC_URL,'eth_getCode')]='http_503'
        self.assertEqual(self.rpc.request('eth_getCode',[TOKEN,'0xa']),'0x01')
        second=[method for url,method,_ in self.provider.calls if url==SECOND]
        self.assertEqual(second,['eth_chainId','eth_getBlockByNumber','eth_getCode'])
        self.assertEqual(self.rpc.request('eth_getBalance',[TOKEN,'0xa']),'0x5')
        self.assertEqual(self.rpc.index,1)
        self.assertEqual(self.rpc.count,len(self.provider.calls))

    def test_wrong_chain_or_changed_block_poison_read_without_trying_third(self):
        for mismatch,reason in [('chain','wrong_chain'),('hash','snapshot_reorganized'),('time','snapshot_reorganized')]:
            self.setUp();self.anchor();self.provider.fail[(RPC_URL,'eth_getCode')]='network_unavailable'
            if mismatch=='chain':self.provider.chains[SECOND]=1
            else:self.provider.blocks[SECOND]={**BLOCK,('hash' if mismatch=='hash' else 'timestamp'):('0x'+'b'*64 if mismatch=='hash' else '0x3e9')}
            with self.assertRaisesRegex(DataError, '^'+reason+'$'):self.rpc.request('eth_getCode',[TOKEN,'0xa'])
            count=len(self.provider.calls)
            with self.assertRaisesRegex(DataError, '^'+reason+'$'):self.rpc.request('eth_getBlockByNumber',['0xa',False])
            self.assertEqual(len(self.provider.calls),count)
            self.assertNotIn(THIRD,[url for url,_,_ in self.provider.calls])

    def test_application_revert_or_invalid_rpc_is_not_retried(self):
        for failure in ('rpc_error','invalid_rpc_envelope','invalid_abi_response'):
            self.setUp();self.anchor();self.provider.fail[(RPC_URL,'eth_call')]=failure
            with self.assertRaisesRegex(DataError,'^'+failure+'$'):self.rpc.request('eth_call',[{},'0xa'])
            self.assertEqual(self.rpc.index,0)

    def test_request_budget_counts_failed_attempts_and_identity_checks(self):
        self.rpc.max_requests=4
        self.anchor()  # chain + head
        self.provider.fail[(RPC_URL,'eth_getCode')]='network_unavailable'
        with self.assertRaisesRegex(DataError,'request_budget_exhausted'):
            self.rpc.request('eth_getCode',[TOKEN,'0xa'])
        self.assertEqual(self.rpc.count,4)
        self.assertEqual(len(self.provider.calls),4)

    def test_rpc_error_in_provider_verification_is_global_and_cannot_be_hidden(self):
        self.anchor()
        self.provider.fail[(RPC_URL,'eth_getCode')]='http_503'
        self.provider.fail[(SECOND,'eth_chainId')]='rpc_error'
        with self.assertRaisesRegex(DataError,'^rpc_error$'):
            self.rpc.request('eth_getCode',[TOKEN,'0xa'])
        del self.provider.fail[(SECOND,'eth_chainId')]
        count=len(self.provider.calls)
        with self.assertRaisesRegex(DataError,'^rpc_error$'):
            self.rpc.request('eth_getBlockByNumber',['0xa',False])
        self.assertEqual(len(self.provider.calls),count)
        self.assertEqual(self.rpc.failure,'rpc_error')

    def test_deadline_exhaustion_never_starts_second_provider(self):
        now=[0.]
        def slow(url,body):
            self.provider.calls.append((url,body['method'],body['params']))
            now[0]+=2
            raise DataError('network_unavailable')
        self.rpc.transport=slow
        with self.assertRaisesRegex(DataError,'read_deadline_exceeded'):
            with read_deadline(1,clock=lambda:now[0]):self.anchor()
        self.assertEqual(len(self.provider.calls),1)

    def test_final_transport_failure_is_stable_and_no_cycle_to_primary(self):
        for url in (RPC_URL,SECOND,THIRD):self.provider.fail[(url,'eth_chainId')]='http_429'
        with self.assertRaisesRegex(DataError,'http_429'):self.anchor()
        with self.assertRaisesRegex(DataError,'http_429'):self.anchor()
        self.assertEqual(len(self.provider.calls),3)

    def test_unpinned_state_and_write_methods_cannot_be_dispatched(self):
        for method,params,reason in [('eth_sendRawTransaction',[],'method_not_read_only'),
                                     ('eth_getBalance',[TOKEN,'latest'],'block_unavailable')]:
            self.setUp()
            with self.assertRaisesRegex(DataError,reason):self.rpc.request(method,params)
            self.assertNotIn(method,[m for _,m,_ in self.provider.calls])


if __name__=='__main__':unittest.main()
