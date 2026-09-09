import copy
from pathlib import Path
import sys
import unittest

from eth_abi import encode
from eth_hash.auto import keccak
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from discovery import Block, DataError, KEY_TYPES, POSITION_MANAGER, ReadRpc, ZERO
from nft_ownership import read_identity, resolve_core_owners, token_id
from position_accounting import core_position_id
from read_api import ReadGate, create_app
from read_service import ReadService
from test_discovery import BLOCK, KEY, OWNER, POOL, TOKEN, FakeRpc
from v4_math import Q128


class NftRpc(FakeRpc):
    def __init__(self):
        super().__init__()
        self.empty = False;self.fail_owner = False;self.wrong_pool_prefix = False
        self.bad_liquidity = False;self.owner = OWNER;self.liquidity = 1000000
        self.recorded = [];self.historical_owners = {699: '0x'+'44'*20}

    def request(self, method, params=()):
        if method == 'eth_getBlockByNumber' and params[0] != 'latest' and int(params[0], 16) != 700:
            number = int(params[0], 16)
            return {'number': hex(number), 'hash': '0x'+number.to_bytes(32, 'big').hex(), 'timestamp': hex(999)}
        return super().request(method, params)

    def call(self, target, signature, inputs=(), values=(), outputs=(), *, block):
        self.recorded.append((signature, block))
        if signature == 'getPoolAndPositionInfo(uint256)':
            prefix = (int(POOL, 16) >> 56)+(1 if self.wrong_pool_prefix else 0)
            info = (prefix << 56) | (60 << 32) | (((-60) & 0xffffff) << 8) | 1
            return (KEY, 0 if self.empty else info)
        if signature == 'getPositionLiquidity(uint256)': return (self.liquidity,)
        if signature == 'getPositionInfo(bytes32,address,int24,int24,bytes32)':
            assert values[1] == POSITION_MANAGER and values[2:4] == [-60, 60]
            return (self.liquidity+int(self.bad_liquidity), 0, 0)
        if signature == 'getFeeGrowthInside(bytes32,int24,int24)': return (Q128//2, 0)
        if signature == 'ownerOf(uint256)':
            if self.fail_owner: raise DataError('rpc_error')
            return (self.historical_owners.get(int(block, 16), self.owner),)
        if signature == 'getSlot0(bytes32)': return (1 << 96, 0, 0, 3000)
        return super().call(target, signature, inputs, values, outputs, block=block)


class NftOwnershipTests(unittest.TestCase):
    def setUp(self):
        self.rpc = NftRpc()
        self.service = ReadService(rpc_factory=lambda: self.rpc, clock=lambda: 1010)
        self.client = TestClient(create_app(self.service, gate=ReadGate(interval=0)), base_url='http://127.0.0.1')

    def test_nft_id_core_identity_and_owner_are_verified_at_same_block(self):
        result = self.service.nft_positions(['2235738'])
        item = result['items'][0]
        expected = core_position_id(POSITION_MANAGER, -60, 60, '0x'+(2235738).to_bytes(32, 'big').hex())
        self.assertEqual(item['corePositionId'], expected)
        self.assertEqual(item['owner'], OWNER);self.assertNotEqual(item['owner'], item['coreOwner'])
        self.assertEqual(item['unsettledFeesRaw'], ['500000', '0'])
        self.assertTrue(item['inRange']);self.assertFalse(item['pastSettledFeesAttributedToCurrentOwner'])
        self.assertFalse(result['walletControlVerified']);self.assertFalse(result['executionAvailable'])
        self.assertTrue(all(block == BLOCK['number'] for _, block in self.rpc.recorded))

    def test_transfer_re_reads_owner_and_historical_snapshot_keeps_old_holder(self):
        first = self.service.nft_positions(['1'])['items'][0]
        self.rpc.owner = TOKEN
        second = self.service.nft_positions(['1'])['items'][0]
        historical = self.service.nft_positions(['1'], 699)['items'][0]
        self.assertEqual(first['owner'], OWNER);self.assertEqual(second['owner'], TOKEN)
        self.assertEqual(historical['owner'], self.rpc.historical_owners[699])
        self.assertEqual(first['corePositionId'], second['corePositionId'])

    def test_empty_position_is_not_confused_with_rpc_failure(self):
        self.rpc.empty = True
        item = self.service.nft_positions(['1'])['items'][0]
        self.assertEqual(item['status'], 'position_info_empty_at_snapshot')
        self.assertIsNone(item['owner']);self.assertFalse(item['nftOwnershipResolved'])
        self.rpc.empty = False;self.rpc.fail_owner = True
        with self.assertRaisesRegex(DataError, 'rpc_error'): self.service.nft_positions(['1'])

    def test_wrong_pool_prefix_core_liquidity_and_no_owner_rejected(self):
        for attr, value, error in [('wrong_pool_prefix', True, 'pool_or_range'),
                                    ('bad_liquidity', True, 'core_liquidity'), ('owner', ZERO, 'no_owner')]:
            previous = getattr(self.rpc, attr);setattr(self.rpc, attr, value)
            with self.subTest(attr=attr), self.assertRaisesRegex(DataError, error): self.service.nft_positions(['1'])
            setattr(self.rpc, attr, previous)

    def test_reorg_discards_owner_and_amounts(self):
        self.rpc.reorg = True
        with self.assertRaisesRegex(DataError, 'snapshot_reorganized'): self.service.nft_positions(['1'])

    def test_distinct_tokens_have_distinct_core_salts(self):
        items = self.service.nft_positions(['1', str(2**255+1)])['items']
        self.assertNotEqual(items[0]['corePositionId'], items[1]['corePositionId'])
        self.assertEqual(items[1]['tokenId'], str(2**255+1))

    def test_strict_http_bounds_and_untrusted_owner_fields(self):
        good = self.client.post('/v1/read/nft-positions', json={'tokenIds': ['1']})
        self.assertEqual(good.status_code, 200)
        for request in [{'tokenIds': []}, {'tokenIds': ['1']*11}, {'tokenIds': ['1','1']},
                        {'tokenIds': [1]}, {'tokenIds': ['01']}, {'tokenIds': [str(2**256)]},
                        {'tokenIds': ['1'], 'blockNumber': True}, {'tokenIds': ['1'], 'owner': OWNER},
                        {'tokenIds': ['1'], 'positionManager': TOKEN}]:
            with self.subTest(request=request):
                self.assertEqual(self.client.post('/v1/read/nft-positions', json=request).status_code, 422)
        self.assertEqual(self.client.post('/v1/read/nft-positions', json={'tokenIds': ['1'], 'blockNumber': 701}).status_code, 503)

    def test_closed_nft_is_still_owned_and_has_zero_current_claims(self):
        self.rpc.liquidity = 0
        item = self.service.nft_positions(['1'])['items'][0]
        self.assertEqual(item['owner'], OWNER)
        self.assertEqual(item['principalRaw'], ['0','0']);self.assertEqual(item['unsettledFeesRaw'], ['0','0'])
        self.assertFalse(item['hasLiquidity'])

    def test_only_official_manager_salt_is_decoded_and_matches_full_core_identity(self):
        block = Block(700, BLOCK['hash'], 1000)
        nft = read_identity(self.rpc, '1', block)
        core = {k: nft[k] for k in ('corePositionId','coreOwner','tickLower','tickUpper','salt','liquidityRaw')}
        resolved = resolve_core_owners(self.rpc, POOL, [core], block)[0]
        self.assertEqual(resolved['nft']['owner'], OWNER)
        unknown = {**core, 'coreOwner': TOKEN}
        result = resolve_core_owners(self.rpc, POOL, [unknown], block)[0]
        self.assertEqual(result['nft']['status'], 'core_owner_adapter_required')
        with self.assertRaisesRegex(DataError, 'identity_mismatch'):
            resolve_core_owners(self.rpc, POOL, [{**core, 'corePositionId': '0x'+'99'*32}], block)
        self.rpc.empty = True
        with self.assertRaisesRegex(DataError, 'active_core_has_empty'):
            resolve_core_owners(self.rpc, POOL, [core], block)
        resolved = resolve_core_owners(self.rpc, POOL, [{**core, 'liquidityRaw': '0'}], block)[0]
        self.assertIsNone(resolved['nft']['owner'])

    def test_nested_position_info_abi_decodes_with_real_rpc_codec(self):
        def transport(url, body):
            info = (int(POOL,16) >> 56 << 56) | (60 << 32) | (((-60)&0xffffff) << 8)
            raw = '0x'+encode(['(address,address,uint24,int24,address)','uint256'], [KEY,info]).hex()
            return {'jsonrpc':'2.0','id':body['id'],'result':raw}
        rpc = ReadRpc('https://example.invalid', transport=transport)
        key, info = rpc.call(POSITION_MANAGER, 'getPoolAndPositionInfo(uint256)', ['uint256'], [1],
                            ['(address,address,uint24,int24,address)','uint256'], block=BLOCK['number'])
        self.assertEqual(key, KEY);self.assertEqual(info >> 56, int(POOL,16) >> 56)
