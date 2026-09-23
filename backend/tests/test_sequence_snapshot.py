import sys
from pathlib import Path
import unittest
from unittest.mock import Mock, patch

from eth_abi import encode
from pydantic import ValidationError
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from discovery import DataError, SNAPSHOT_LOOPBACK_RPC
from read_api import create_app, ReadGate
from read_gateway import Gateway, create_gateway
from bridge_http import LocalReaderHTTP
from read_service import ReadService
from rpc_failover import FailoverReadRpc
from sequence_snapshot import (SequenceSnapshotRequest, deployment, sequence_snapshot,
                               validate_snapshot_response)


OWNER = '0x706627e3e75b0603c4b6f9a1ebbfc635da712747'
TOKEN0 = '0x5fc5360d0400a0fd4f2af552add042d716f1d168'
TOKEN1 = '0xefab538cf3c29237a47c6afb145d50ddf204a0a3'


class FixedRpc:
    batch_reads = True

    def __init__(self):
        self.targets = []
        self.reorganized = False

    def call_params(self, target, signature, inputs=(), values=(), *, block):
        return [{'to': target, 'data': signature, 'gas': '0x7a120'}, block]

    def call_raw(self, target, signature, inputs=(), values=(), *, block):
        self.targets.append((target, signature, block))
        if signature == 'nextOwnerNonce(address)':
            return '0x' + encode(['uint256'], [0]).hex()
        if signature == 'ownerOf(uint256)':
            return '0x' + encode(['address'], [OWNER]).hex()
        if signature == 'getPoolAndPositionInfo(uint256)':
            return '0x' + encode(['(address,address,uint24,int24,address)', 'uint256'],
                                 [(TOKEN0, TOKEN1, 40000, 200, '0x'+'00'*20), 1]).hex()
        if signature == 'getApproved(uint256)':
            return '0x' + encode(['address'], ['0x'+'00'*20]).hex()
        if signature == 'predictVault(address,uint256)':
            return '0x' + encode(['address'], ['0x'+'11'*20]).hex()
        raise AssertionError(signature)

    def request(self, method, params):
        self.targets.append((method, tuple(str(p) for p in params)))
        if method == 'eth_chainId':
            return '0x1237'
        if method == 'eth_getBlockByNumber':
            return {'number':'0x42','hash':'0x'+('cc' if self.reorganized and params[0] == '0x42' else 'bb')*32}
        if method == 'eth_getCode':
            return '0x' if params[0] in (deployment()['operator'], deployment()['pricePublisher']) else '0x6000'
        if method == 'eth_call':
            return '0x' + encode(['uint256'], [0]).hex()
        raise AssertionError(method)

    def batch(self, specs):
        assert len(specs) <= 8
        return [self.request(method, params) for method, params in specs]


class SequenceSnapshotTests(unittest.TestCase):
    def test_snapshot_uses_only_local_primary_and_refuses_legacy_or_public_config(self):
        local = 'https://rpc.domino.money/SYNTHETIC_LOCAL_TOKEN_123/'
        public = 'https://rpc.mainnet.chain.robinhood.com'
        for version, urls in ((None,(local,public)), (3,(local,public)), (4,(public,local)),
                              (4,(public,)), (4,())):
            service = ReadService(rpc_urls=urls,snapshot_rpc_version=version)
            with patch('read_service.sequence_snapshot') as read:
                with self.assertRaisesRegex(DataError,'upstream_unavailable'):
                    service.sequence_snapshot(OWNER)
                read.assert_not_called()
        service = ReadService(rpc_urls=(local,public),snapshot_rpc_version=4)
        with patch('read_service.sequence_snapshot',side_effect=lambda rpc,*_: rpc) as read:
            rpc = service.sequence_snapshot(OWNER)
        self.assertEqual(rpc.url,local)
        self.assertNotIsInstance(rpc,FailoverReadRpc)
        self.assertEqual(read.call_count,1)

    def test_snapshot_loopback_requires_explicit_v4_local_primary_and_never_falls_back(self):
        local = 'https://rpc.domino.money/SYNTHETIC_LOCAL_TOKEN_123/'
        public = 'https://rpc.mainnet.chain.robinhood.com'
        for version, urls in ((3, (local, public)), (4, (public, local)), (4, ())):
            service = ReadService(rpc_urls=urls, snapshot_rpc_version=version,
                                  snapshot_loopback=True)
            with patch('read_service.sequence_snapshot') as read:
                with self.assertRaisesRegex(DataError, '^upstream_unavailable$'):
                    service.sequence_snapshot(OWNER)
                read.assert_not_called()
        service = ReadService(rpc_urls=(local, public), snapshot_rpc_version=4,
                              snapshot_loopback=True)
        with patch('read_service.sequence_snapshot', side_effect=lambda rpc, *_: rpc):
            rpc = service.sequence_snapshot(OWNER)
        self.assertEqual(rpc.url, SNAPSHOT_LOOPBACK_RPC)
        self.assertNotIsInstance(rpc, FailoverReadRpc)
        with patch('read_service.snapshot_loopback_http', side_effect=DataError('network_unavailable')) as local_http:
            with self.assertRaisesRegex(DataError, '^network_unavailable$'):
                rpc.request('eth_chainId', [])
            local_http.assert_called_once()

    def test_fixed_targets_finalized_anchor_and_closed_shape(self):
        rpc = FixedRpc()
        result = sequence_snapshot(rpc, OWNER, '3136705')
        validate_snapshot_response('sequence-snapshot', result)
        self.assertEqual((result['owner'], result['tokenId'], result['blockNumber']),
                         (OWNER, '3136705', 66))
        self.assertEqual(result['recent'], [])
        self.assertEqual(result['root']['currency0'], TOKEN0)
        self.assertEqual(result['root']['currency1'], TOKEN1)
        self.assertIn(('eth_getBlockByNumber', ("finalized", "False")), rpc.targets)
        call_targets = [entry[0] for entry in rpc.targets if len(entry) == 3]
        self.assertTrue(all(target in set(deployment()[role] for role in (
            'factory','implementation','poolManager','positionManager','stateView',
            'readHelper','engine','routing','priceGuard')) | {TOKEN0,TOKEN1,OWNER}
            for target in call_targets))

    def test_reorg_and_extra_request_fields_fail_closed(self):
        rpc = FixedRpc(); rpc.reorganized = True
        with self.assertRaisesRegex(DataError, 'chain_changed'):
            sequence_snapshot(rpc, OWNER, None)
        for value in ({'owner': OWNER, 'tokenId': None, 'method':'eth_call'},
                      {'owner': OWNER, 'tokenId': '-1'},
                      {'owner': OWNER.upper(), 'tokenId': None}):
            with self.assertRaises(ValidationError):
                SequenceSnapshotRequest.model_validate(value)

    def test_response_mismatch_is_rejected(self):
        result = sequence_snapshot(FixedRpc(), OWNER, None)
        validate_snapshot_response('sequence-snapshot', result)
        result['calls']['factory']['unexpected'] = '0x'
        with self.assertRaises(ValueError):
            validate_snapshot_response('sequence-snapshot', result)

    def test_loopback_gateway_is_off_by_default_then_accepts_only_typed_route(self):
        service = ReadService(rpc_factory=FixedRpc)
        reader = TestClient(create_app(service, gate=ReadGate(interval=0), read_budget_seconds=15),
                            base_url='http://127.0.0.1:8876')
        local = LocalReaderHTTP(client=reader)
        header = {'Cf-Access-Jwt-Assertion':'a.b.c','X-Domino-Client-Id':'192.0.2.1'}
        body = {'owner':OWNER,'tokenId':None}
        off = TestClient(create_gateway(Gateway(verifier=Mock(),upstream=local,
                            gate=ReadGate(interval=0))),base_url='http://127.0.0.1:8878',
                         client=('127.0.0.1',40000))
        self.assertEqual(off.post('/internal/read/v4/sequence-snapshot',json=body,headers=header).status_code,404)
        gateway = Gateway(verifier=Mock(),upstream=local,enabled_v4=True,
                          enabled_v4_reads=('sequence-snapshot',),gate=ReadGate(interval=0))
        client = TestClient(create_gateway(gateway),base_url='http://127.0.0.1:8878',
                            client=('127.0.0.1',40000))
        response = client.post('/internal/read/v4/sequence-snapshot',json=body,headers=header)
        self.assertEqual(response.status_code,200,response.text)
        self.assertEqual(response.headers['x-domino-read-contract'],'1.0.0-rc.1')
        validate_snapshot_response('sequence-snapshot',response.json())
        self.assertEqual(client.post('/internal/read/v4/eth_call',json={'method':'eth_call'},headers=header).status_code,404)
        self.assertEqual(client.post('/internal/read/v4/sequence-snapshot',json={**body,'url':'https://evil.invalid'},headers=header).status_code,422)
        self.assertEqual(reader.post('/v4/read/sequence-snapshot',json=body,headers={'Origin':'https://evil.invalid'}).status_code,403)


if __name__ == '__main__':
    unittest.main()
