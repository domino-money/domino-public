"""Finite read gas and safe diagnostics; all RPC inputs are synthetic."""
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import time
import unittest
import urllib.request

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from discovery import (DEFAULT_READ_CALL_GAS, MAX_READ_CALL_GAS, DataError,
                       ReadRpc, ZERO, rpc_error_code)
import local_anvil
from read_contract import sanitize_error, validate_response
from rpc_failover import FailoverReadRpc
from test_discovery import TOKEN, OTHER, OWNER
from test_read_contract import MetadataRpc, service
from test_rpc_providers import Provider, RPC_URL, SECOND

ROOT = Path(__file__).resolve().parents[2]


class CallBudgetTests(unittest.TestCase):
    def test_only_explicit_node_gas_errors_are_classified(self):
        for message in ('out of gas', 'intrinsic gas too low', 'execution ran out of gas',
                        'EVM error OutOfGas', 'gas required exceeds allowance (150000)'):
            error = {'code': -32000, 'message': message}
            self.assertEqual(rpc_error_code('eth_call', error), 'rpc_call_gas_limit')
            self.assertEqual(rpc_error_code('eth_getCode', error), 'rpc_error')
        for error in (None, {}, {'code': True, 'message': 'out of gas'},
                      {'code': -32000, 'message': 'provider /SECRET says out of gas'},
                      {'code': -32000, 'message': 'out of gas', 'data': {'reason': 'unknown'}},
                      {'code': -32000, 'message': 'x'*513}):
            self.assertEqual(rpc_error_code('eth_call', error), 'rpc_error')

    def test_reverts_take_precedence_over_gas_words(self):
        for error in ({'code': 3, 'message': 'out of gas'},
                      {'code': -32000, 'message': 'execution reverted: out of gas'},
                      {'code': -32000, 'message': 'out of gas', 'data': '0xdeadbeef'}):
            self.assertEqual(rpc_error_code('eth_call', error), 'rpc_call_reverted')

    def test_bounded_profile_is_sent_once_and_errors_never_echo_provider_data(self):
        calls = []
        def transport(url, body):
            calls.append(body)
            return {'jsonrpc': '2.0', 'id': body['id'],
                    'error': {'code': -32000, 'message': 'out of gas'}}
        rpc = ReadRpc(transport=transport)
        with self.assertRaisesRegex(DataError, '^rpc_call_gas_limit$'):
            rpc.call_raw(TOKEN, 'decimals()', block='0x1')
        self.assertEqual(len(calls), 1)
        self.assertEqual(calls[0]['params'][0]['gas'], hex(DEFAULT_READ_CALL_GAS))
        self.assertEqual(sanitize_error('rpc_call_gas_limit'), (503, {'error': 'rpc_call_gas_limit'}))
        for value in (True, None, '500000', 0, 20_999, MAX_READ_CALL_GAS+1):
            with self.assertRaisesRegex(DataError, '^invalid_read_call_gas_limit$'):
                ReadRpc(call_gas_limit=value)

    def test_unavailable_read_is_not_invalid_metadata_and_other_assets_survive(self):
        rpc = MetadataRpc(decimals=DataError('rpc_call_gas_limit'))
        response = service(rpc).token(TOKEN)
        validate_response('token', response)
        token = response['asset']
        self.assertEqual(token['readStatus'], 'unavailable')
        self.assertEqual(token['reason'], 'rpc_call_gas_limit')
        self.assertEqual(token['metadataIssues'], {})
        self.assertIsNone(token['decimals'])
        wallet = service(rpc).wallet_assets(OWNER, [TOKEN, OTHER])
        validate_response('wallet-assets', wallet)
        self.assertEqual(wallet['unavailableAssets'], [{'currency': TOKEN, 'reason': 'rpc_call_gas_limit'}])
        self.assertEqual({item['address'] for item in wallet['items']}, {ZERO, OTHER})

    def test_symbol_budget_and_ordinary_metadata_revert_remain_distinct(self):
        class SymbolBudget(MetadataRpc):
            def symbol(self, target, *, block): raise DataError('rpc_call_gas_limit')
        self.assertEqual(service(SymbolBudget()).token(TOKEN)['asset']['reason'], 'rpc_call_gas_limit')
        token = service(MetadataRpc(decimals=DataError('rpc_call_reverted'))).token(TOKEN)['asset']
        self.assertEqual(token['readStatus'], 'partial')
        self.assertEqual(token['metadataIssues'], {'decimals': 'rpc_call_reverted'})

    def test_contract_failure_never_retries_or_poisons_unrelated_reads(self):
        for reason in ('rpc_call_gas_limit', 'rpc_call_reverted'):
            provider = Provider()
            rpc = FailoverReadRpc((RPC_URL, SECOND), transport=provider)
            rpc.request('eth_getBlockByNumber', ['latest', False])
            provider.fail[(RPC_URL, 'eth_call')] = reason
            with self.assertRaisesRegex(DataError, '^'+reason+'$'):
                rpc.call_raw(TOKEN, 'decimals()', block='0xa')
            self.assertEqual(rpc.request('eth_getBalance', [OWNER, '0xa']), '0x5')
            self.assertEqual(rpc.index, 0)
            self.assertIsNone(rpc.failure)
            self.assertNotIn(SECOND, [url for url, _, _ in provider.calls])


@unittest.skipUnless(os.environ.get('DOMINO_TEST_EVM') == '1', 'requires isolated local Anvil')
class NativeCallBudgetTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        # Cold SLOADs make the cost deterministic. This synthetic delegated view
        # is intentionally expensive; it is not a claim about any real token.
        source = '''// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
contract CostlyMetadata {
    function decimals() external view returns (uint8 value) {
        assembly {
            let total := 0
            for { let i := 0 } lt(i, 100) { i := add(i, 1) } { total := add(total, sload(i)) }
            value := add(6, total)
        }
    }
}
contract MetadataProxy {
    address immutable implementation;
    constructor(address target) { implementation = target; }
    fallback() external {
        address target = implementation;
        assembly {
            calldatacopy(0, 0, calldatasize())
            let ok := delegatecall(gas(), target, 0, calldatasize(), 0, 0)
            returndatacopy(0, 0, returndatasize())
            if iszero(ok) { revert(0, returndatasize()) }
            return(0, returndatasize())
        }
    }
}'''
        payload = {'language': 'Solidity', 'sources': {'Budget.sol': {'content': source}},
                   'settings': {'optimizer': {'enabled': True, 'runs': 200}, 'evmVersion': 'cancun',
                                'outputSelection': {'*': {'*': ['evm.bytecode.object']}}}}
        result = subprocess.run(['node', str(ROOT/'scripts/solc-compile.cjs')],
                                input=json.dumps(payload), text=True, capture_output=True, timeout=60, check=True)
        compiled = json.loads(result.stdout)
        if any(error['severity'] == 'error' for error in compiled.get('errors', [])):
            raise AssertionError('synthetic read budget compilation failed')
        cls.contracts = compiled['contracts']['Budget.sol']
        with socket.socket() as sock:
            sock.bind(('127.0.0.1', 0)); port = sock.getsockname()[1]
        cls.url = f'http://127.0.0.1:{port}'
        cls.process = local_anvil.start(['--host', '127.0.0.1',
                                         '--port', str(port), '--chain-id', '31337', '--silent'])
        cls.addClassCleanup(cls.stop)
        for _ in range(100):
            try:
                if cls.rpc('eth_chainId', []) != '0x7a69': raise AssertionError('local chain required')
                cls.account = cls.rpc('eth_accounts', [])[0]
                break
            except OSError: time.sleep(.05)
        else: raise AssertionError('local EVM failed to start')

    @classmethod
    def stop(cls):
        local_anvil.stop(cls.process)

    @classmethod
    def transport(cls, url, body):
        if url != cls.url: raise AssertionError('local test endpoint required')
        request = urllib.request.Request(url, json.dumps(body).encode(), {'Content-Type': 'application/json'})
        with urllib.request.urlopen(request, timeout=10) as response: return json.load(response)

    @classmethod
    def rpc(cls, method, params):
        response = cls.transport(cls.url, {'jsonrpc': '2.0', 'id': 1, 'method': method, 'params': params})
        if 'error' in response: raise AssertionError(response['error'])
        return response['result']

    def deploy(self, name, argument=''):
        code = self.contracts[name]['evm']['bytecode']['object']+argument
        tx = self.rpc('eth_sendTransaction', [{'from': self.account, 'data': '0x'+code, 'gas': hex(2_000_000)}])
        for _ in range(100):
            receipt = self.rpc('eth_getTransactionReceipt', [tx])
            if receipt is not None: break
            time.sleep(.01)
        self.assertIsNotNone(receipt)
        self.assertEqual(receipt['status'], '0x1')
        return receipt['contractAddress']

    def test_expensive_delegated_metadata_fits_new_profile_but_not_old_limit(self):
        implementation = self.deploy('CostlyMetadata')
        proxy = self.deploy('MetadataProxy', implementation[2:].rjust(64, '0'))
        block = self.rpc('eth_blockNumber', [])
        for target in (implementation, proxy):
            old = ReadRpc(self.url, transport=self.transport, call_gas_limit=150_000)
            reason = 'rpc_call_gas_limit' if target == implementation else 'rpc_call_reverted'
            # Anvil explicitly reports OOG for a direct call. The proxy wraps
            # the same inner failure in an empty revert; do not infer its cause.
            with self.assertRaisesRegex(DataError, '^'+reason+'$'):
                old.call(target, 'decimals()', outputs=['uint8'], block=block)
            current = ReadRpc(self.url, transport=self.transport)
            self.assertEqual(current.call(target, 'decimals()', outputs=['uint8'], block=block), (6,))
            self.assertEqual(current.count, 1)
