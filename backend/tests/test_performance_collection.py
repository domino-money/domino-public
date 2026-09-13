"""Honest fake RPC fixtures: not provider/deployed-contract qualification."""
from copy import deepcopy
from pathlib import Path
import sys
import unittest

from eth_abi import encode, decode
from eth_hash.auto import keccak

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from discovery import POSITION_MANAGER, POOL_MANAGER, STATE_VIEW, ZERO
from performance_collection import (Baseline, CanonicalCollector, CollectionError,
    ReorgDetected, Page, PerformanceRpc, TRANSFER, POSITION_TYPE, CHECKPOINT_TYPE,
    event_id, MAX_TRANSACTIONS, MAX_BLOCK_TRANSACTIONS)
from v4_math import Q128

OWNER = '0x'+'22'*20
VAULT = '0x'+'44'*20
IMPLEMENTATION = '0x'+'45'*20
FACTORY = '0x'+'46'*20
READ_HELPER = '0x'+'47'*20
COMPOUND_ENGINE = '0x'+'48'*20
TOKEN = '0x'+'77'*20
NEXT_OWNER = '0x'+'88'*20
CODE = '0x60006000f3'
CODE_HASH = '0x'+keccak(bytes.fromhex(CODE[2:])).hex()
KEY = (ZERO, TOKEN, 3000, 60, ZERO)
POOL_ID = '0x'+keccak(encode(['address','address','uint24','int24','address'], KEY)).hex()


def hash_(number): return '0x'+number.to_bytes(32, 'big').hex()
def topic(address): return '0x'+address[2:].rjust(64, '0')


class FakePerformanceRpc:
    def __init__(self):
        self.finalized = 10
        self.calls = []
        self.headers = {n: {'number':hex(n), 'hash':hash_(n), 'parentHash':hash_(n-1),
            'timestamp':hex(1000+n), 'transactions':[]} for n in range(1, 31)}
        self.receipts, self.transactions = {}, {}
        self.owner, self.root_owner = OWNER, OWNER
        self.version = 1
        self.code = {a:CODE for a in (VAULT, IMPLEMENTATION, FACTORY, POSITION_MANAGER, POOL_MANAGER, STATE_VIEW,
                                    READ_HELPER, COMPOUND_ENGINE)}
        self.active = 1
        self.query_omit = self.query_duplicate = False
        self.receipt_disagrees = self.header_reorg_on_recheck = False
        self.header_reads = {}
        self.fail_method = None

    def add_transaction(self, block=11, logs=None, sender=OWNER, to=VAULT, status=1):
        index = len(self.headers[block]['transactions'])
        tx_hash = hash_(block*100+index)
        self.headers[block]['transactions'].append(tx_hash)
        offset = sum(len(self.receipts[t]['logs']) for t in self.headers[block]['transactions'][:-1])
        located = []
        for ordinal, item in enumerate(logs or []):
            located.append({**item, 'blockNumber':hex(block), 'blockHash':hash_(block),
                'transactionHash':tx_hash, 'transactionIndex':hex(index), 'logIndex':hex(offset+ordinal), 'removed':False})
        receipt = {'transactionHash':tx_hash, 'blockNumber':hex(block), 'blockHash':hash_(block),
            'transactionIndex':hex(index), 'from':sender, 'to':to, 'status':hex(status),
            'gasUsed':'0x5208', 'effectiveGasPrice':'0x3b9aca00', 'logs':located}
        self.receipts[tx_hash] = receipt
        self.transactions[tx_hash] = {'hash':tx_hash, 'blockNumber':hex(block), 'blockHash':hash_(block),
            'transactionIndex':hex(index), 'from':sender, 'to':to, 'value':'0x0', 'gas':'0x100000', 'input':'0x'}
        return tx_hash

    def _call(self, call):
        data = bytes.fromhex(call['data'][2:])
        for signature, (inputs, output) in {
            'owner()':([], 'address'), 'positionManager()':([], 'address'), 'poolManager()':([], 'address'),
            'stateView()':([], 'address'), 'rootTokenId()':([], 'uint256'), 'activePositions()':([], 'uint256'),
            'implementationVersion()':([], 'uint64'), 'implementation()':([], 'address'), 'factory()':([], 'address'),
            'readHelper()':([], 'address'), 'compoundEngine()':([], 'address'),
            'sequenceIdentityHash()':([], 'bytes32'), 'poolId()':([], 'bytes32'),
            'poolKey()':([], '(address,address,uint24,int24,address)'),
            'position(uint256)':(['uint256'], POSITION_TYPE),
            'registrationCheckpoint(uint256)':(['uint256'], CHECKPOINT_TYPE),
            'checkpoint(uint256)':(['uint256'], CHECKPOINT_TYPE),
            'accountedCurrency(address)':(['address'], 'uint256'), 'balanceOf(address)':(['address'], 'uint256'),
            'getPoolAndPositionInfo(uint256)':(['uint256'], None),
            'ownerOf(uint256)':(['uint256'], 'address'), 'getPositionLiquidity(uint256)':(['uint256'], 'uint128'),
            'getPositionInfo(bytes32,address,int24,int24,bytes32)':(['bytes32','address','int24','int24','bytes32'], None),
            'getSlot0(bytes32)':(['bytes32'], None), 'getFeeGrowthInside(bytes32,int24,int24)':(['bytes32','int24','int24'], None),
        }.items():
            if data[:4] != keccak(signature.encode())[:4]: continue
            args = decode(inputs, data[4:])
            target = call['to']
            if signature == 'getPoolAndPositionInfo(uint256)':
                packed = (int(POOL_ID,16) & ~((1<<56)-1)) | (((-60)&0xffffff)<<8) | (60<<32) | 1
                return '0x'+encode(['(address,address,uint24,int24,address)','uint256'], [KEY,packed]).hex()
            if signature == 'getPositionInfo(bytes32,address,int24,int24,bytes32)':
                return '0x'+encode(['uint128','uint256','uint256'], [1000,0,0]).hex()
            if signature == 'getSlot0(bytes32)': return '0x'+encode(['uint160','int24','uint24','uint24'], [1<<96,0,0,3000]).hex()
            if signature == 'getFeeGrowthInside(bytes32,int24,int24)':
                return '0x'+encode(['uint256','uint256'], [Q128//2,0]).hex()
            if signature == 'position(uint256)':
                value = (True,True,args[0]==1,0 if args[0]==1 else 1,1,-60,60,
                    bytes.fromhex(hash_(91)[2:]),bytes.fromhex(hash_(92)[2:]),
                    bytes.fromhex(hash_(93)[2:]),bytes.fromhex(hash_(94)[2:]))
            elif signature in ('registrationCheckpoint(uint256)','checkpoint(uint256)'):
                value = (1000,0,0,Q128//2,0,10,bytes.fromhex(hash_(91)[2:]))
            elif signature == 'ownerOf(uint256)': value = self.root_owner if args[0]==1 else VAULT
            else:
                value = {'owner()':self.owner, 'positionManager()':POSITION_MANAGER, 'poolManager()':POOL_MANAGER,
                    'stateView()':STATE_VIEW, 'rootTokenId()':1, 'activePositions()':self.active,
                    'implementationVersion()':self.version, 'implementation()':IMPLEMENTATION, 'factory()':FACTORY,
                    'readHelper()':READ_HELPER, 'compoundEngine()':COMPOUND_ENGINE,
                    'sequenceIdentityHash()':bytes.fromhex(hash_(90)[2:]),'poolId()':bytes.fromhex(POOL_ID[2:]),
                    'poolKey()':KEY,'accountedCurrency(address)':7,'balanceOf(address)':20,
                    'getPositionLiquidity(uint256)':1000}[signature]
            return '0x'+encode([output], [value]).hex()
        raise AssertionError('unknown fake selector')

    def request(self, method, params):
        self.calls.append((method, deepcopy(params)))
        if self.fail_method == method: raise RuntimeError('private-provider-secret-must-not-leak')
        if method == 'eth_chainId': return hex(4663)
        if method == 'eth_getBlockByNumber':
            n = self.finalized if params[0]=='finalized' else int(params[0],16)
            self.header_reads[n] = self.header_reads.get(n,0)+1
            result = deepcopy(self.headers[n])
            if self.header_reorg_on_recheck and n==11 and self.header_reads[n]>2: result['hash']=hash_(999)
            return result
        if method == 'eth_getCode': return self.code.get(params[0], '0x')
        if method == 'eth_getBalance': return '0x1e'
        if method == 'eth_call': return self._call(params[0])
        if method == 'eth_getTransactionByHash': return deepcopy(self.transactions[params[0]])
        if method == 'eth_getTransactionReceipt':
            result = deepcopy(self.receipts[params[0]])
            if self.receipt_disagrees: result['logs']=[]
            return result
        if method == 'eth_getLogs':
            query=params[0]; rows=[]
            addresses=query['address'] if isinstance(query['address'],list) else [query['address']]
            for block in range(int(query['fromBlock'],16),int(query['toBlock'],16)+1):
                for tx in self.headers[block]['transactions']:
                    for log in self.receipts[tx]['logs']:
                        if log['address'] not in addresses: continue
                        matches=True
                        for i,expected in enumerate(query.get('topics',[])):
                            if expected is not None and (i>=len(log['topics']) or log['topics'][i] not in (
                                    expected if isinstance(expected,list) else [expected])): matches=False
                        if matches: rows.append(deepcopy(log))
            if self.query_omit: return rows[:-1]
            if self.query_duplicate and rows: rows.append(deepcopy(rows[0]))
            return rows
        raise AssertionError('forbidden fake method: '+method)


def vault_log(): return {'address':VAULT,'topics':[hash_(500)],'data':'0x'}
def transfer_log(sender=OWNER, recipient=NEXT_OWNER, token_id=1):
    return {'address':POSITION_MANAGER, 'topics':[TRANSFER,topic(sender),topic(recipient),hash_(token_id)],'data':'0x'}
def token_log(): return {'address':TOKEN,'topics':[TRANSFER,topic(OWNER),topic(VAULT)],'data':hash_(100)}


class PerformanceCollectionTests(unittest.TestCase):
    def setUp(self):
        self.rpc=FakePerformanceRpc(); self.collector=CanonicalCollector(self.rpc)
        self.baseline=self.collector.capture(OWNER,VAULT,['1'],CODE_HASH)

    def forward(self, logs=None):
        tx=self.rpc.add_transaction(logs=logs or [vault_log()]); self.rpc.finalized=11
        return tx

    def test_baseline_is_owner_bound_finalized_opening_not_new_income(self):
        self.assertEqual(self.baseline.baseline.blockNumber,10)
        self.assertEqual(self.baseline.opening.members[0].unsettledFeesRaw,['500','0'])
        self.assertEqual(self.baseline.opening.accountedRaw,['7','7'])
        self.assertEqual(self.baseline.opening.heldRaw,['30','20'])
        self.assertEqual(len(self.baseline.opening.codePins),6)
        raw=self.baseline.model_dump()
        self.assertNotIn('canonicality',raw); self.assertNotIn('qualified',raw)
        self.assertNotIn('credits',raw)
        self.assertEqual(Baseline.model_validate(raw),self.baseline)
        pins=[p[1][-1] for p in self.rpc.calls if p[0] in ('eth_call','eth_getCode','eth_getBalance')]
        self.assertTrue(all(p=={'blockHash':hash_(10),'requireCanonical':True} for p in pins))
        self.assertEqual(self.collector.capture(OWNER,VAULT,['1'],CODE_HASH).epochId,self.baseline.epochId)

    def test_capture_rejects_other_owner_hash_and_incomplete_members(self):
        for owner,ids,code in [(NEXT_OWNER,['1'],CODE_HASH),(OWNER,['1'],hash_(0)),(OWNER,['2'],CODE_HASH),
                               (OWNER,['1','1'],CODE_HASH),(OWNER,[1],CODE_HASH)]:
            with self.subTest(owner=owner,ids=ids,code=code),self.assertRaises(CollectionError):
                self.collector.capture(owner,VAULT,ids,code)
        self.rpc.active=2
        with self.assertRaisesRegex(CollectionError,'incomplete_collection_members'):
            self.collector.capture(OWNER,VAULT,['1'],CODE_HASH)

    def test_capture_preserves_v1_v2_and_pins_v3_engine(self):
        for version, count in ((1,6), (2,7), (3,8)):
            with self.subTest(version=version):
                self.rpc.version = version
                baseline = self.collector.capture(OWNER,VAULT,['1'],CODE_HASH)
                self.assertEqual(baseline.opening.implementationVersion,version)
                self.assertEqual(len(baseline.opening.codePins),count)
                self.assertEqual(COMPOUND_ENGINE in {p.address for p in baseline.opening.codePins},version == 3)
                self.assertEqual(Baseline.model_validate(baseline.model_dump()),baseline)
        self.rpc.code[COMPOUND_ENGINE] = '0x'
        with self.assertRaisesRegex(CollectionError,'collection_code_unavailable'):
            self.collector.capture(OWNER,VAULT,['1'],CODE_HASH)

    def test_capture_checks_root_holder_and_complete_child_custody(self):
        self.rpc.root_owner=NEXT_OWNER
        with self.assertRaisesRegex(CollectionError,'collection_nft_binding_mismatch'):
            self.collector.capture(OWNER,VAULT,['1'],CODE_HASH)
        self.rpc.root_owner=OWNER; self.rpc.active=2
        baseline=self.collector.capture(OWNER,VAULT,['2','1'],CODE_HASH)
        self.assertEqual(baseline.tokenIds,['1','2']); self.assertEqual(baseline.opening.members[1].holder,VAULT)

    def test_caught_up_returns_none_without_mutating_baseline(self):
        before=self.baseline.model_dump()
        self.assertIsNone(self.collector.collect(self.baseline,self.baseline.baseline))
        self.assertEqual(before,self.baseline.model_dump())

    def test_complete_receipt_preserves_unrelated_logs_and_local_event_index(self):
        unrelated={'address':NEXT_OWNER,'topics':[hash_(99)],'data':'0x'}
        unrelated_tx=self.rpc.add_transaction(logs=[unrelated])
        tx=self.forward([unrelated,vault_log(),transfer_log(),token_log()])
        page=self.collector.collect(self.baseline,self.baseline.baseline)
        self.assertEqual(len(page.receipts),1); self.assertEqual(len(page.receipts[0].logs),4)
        self.assertEqual([e.receiptLogIndex for e in page.events],[1,2,3])
        self.assertEqual([e.logIndex for e in page.events],[2,3,4])
        self.assertEqual(page.events[0].eventId,event_id(tx,1))
        self.assertEqual([e.kind for e in page.events],['vault','position_transfer','currency_transfer'])
        self.assertEqual(page.receipts[0].gasUsed,'21000')
        self.assertFalse(any(m=='eth_getBlockReceipts' or (m in ('eth_getTransactionReceipt','eth_getTransactionByHash') and p==[unrelated_tx]) for m,p in self.rpc.calls))
        self.assertEqual(Page.model_validate(page.model_dump()),page)
        self.assertEqual(self.collector.collect(self.baseline,self.baseline.baseline),page)

    def test_transfer_closing_order_keeps_immutable_sequence_owner(self):
        tx=self.forward([vault_log(),transfer_log(),vault_log()]); self.rpc.root_owner=NEXT_OWNER
        page=self.collector.collect(self.baseline,self.baseline.baseline)
        self.assertEqual(page.owner,OWNER)
        self.assertEqual([e.receiptLogIndex for e in page.events],[0,1,2])
        self.assertEqual(page.receipts[0].logs[1].topics[2],topic(NEXT_OWNER))
        self.assertEqual(page.receipts[0].transactionHash,tx)
        self.assertNotIn('income',page.model_dump())

    def test_same_timestamp_blocks_keep_canonical_order_and_empty_blocks(self):
        self.rpc.headers[11]['timestamp']=self.rpc.headers[10]['timestamp']
        self.rpc.headers[12]['timestamp']=self.rpc.headers[10]['timestamp']
        self.rpc.add_transaction(12,[vault_log()]); self.rpc.finalized=12
        page=self.collector.collect(self.baseline,self.baseline.baseline)
        self.assertEqual([h.blockNumber for h in page.headers],[11,12])
        self.assertEqual(page.events[0].blockNumber,12)
        self.assertIsNone(self.collector.collect(self.baseline,page.throughCursor))

    def test_page_is_bounded_and_advances_through_empty_blocks(self):
        self.rpc.finalized=20
        page=self.collector.collect(self.baseline,self.baseline.baseline)
        self.assertEqual(page.throughCursor.blockNumber,14)
        self.assertEqual(page.events,[]); self.assertEqual(page.receipts,[])

    def test_missing_or_truncated_logs_and_receipts_fail_instead_of_partial_success(self):
        self.forward([vault_log(),vault_log()])
        for flag,code in [('query_omit','incomplete_or_inconsistent_log_query'),
                          ('query_duplicate','duplicate_query_log'),
                          ('receipt_disagrees','incomplete_or_inconsistent_log_query')]:
            setattr(self.rpc,flag,True)
            with self.subTest(flag=flag),self.assertRaisesRegex(CollectionError,code):
                self.collector.collect(self.baseline,self.baseline.baseline)
            setattr(self.rpc,flag,False)

    def test_receipt_location_status_sender_and_log_forgery_rejected(self):
        tx=self.forward()
        original=deepcopy(self.rpc.receipts[tx])
        for field,value in [('transactionIndex','0x9'),('blockHash',hash_(888)),('status','0x0'),('from',NEXT_OWNER)]:
            self.rpc.receipts[tx]=deepcopy(original); self.rpc.receipts[tx][field]=value
            with self.subTest(field=field),self.assertRaises(CollectionError):
                self.collector.collect(self.baseline,self.baseline.baseline)
        for field,value in [('removed',True),('logIndex','0x01'),('transactionHash',hash_(889))]:
            self.rpc.receipts[tx]=deepcopy(original); self.rpc.receipts[tx]['logs'][0][field]=value
            with self.subTest(log_field=field),self.assertRaises(CollectionError):
                self.collector.collect(self.baseline,self.baseline.baseline)

    def test_baseline_cursor_parent_finality_and_end_recheck_reorgs(self):
        self.forward()
        self.rpc.headers[10]['hash']=hash_(888)
        with self.assertRaises(ReorgDetected) as caught:
            self.collector.collect(self.baseline,self.baseline.baseline)
        self.assertEqual(caught.exception.observed_baseline.blockHash,hash_(888))
        self.rpc.headers[10]['hash']=hash_(10); self.rpc.headers[11]['parentHash']=hash_(333)
        with self.assertRaises(ReorgDetected): self.collector.collect(self.baseline,self.baseline.baseline)
        self.rpc.headers[11]['parentHash']=hash_(10)
        self.rpc.header_reads={}; self.rpc.header_reorg_on_recheck=True
        with self.assertRaises(ReorgDetected): self.collector.collect(self.baseline,self.baseline.baseline)

    def test_code_change_owner_change_rpc_failure_and_budget_are_closed(self):
        self.forward()
        self.rpc.code[STATE_VIEW]='0x6001'
        with self.assertRaisesRegex(CollectionError,'collection_dependency_code_changed'):
            self.collector.collect(self.baseline,self.baseline.baseline)
        self.rpc.code[STATE_VIEW]=CODE; self.rpc.owner=NEXT_OWNER
        with self.assertRaisesRegex(CollectionError,'collection_owner_changed'):
            self.collector.collect(self.baseline,self.baseline.baseline)
        self.rpc.owner=OWNER; self.rpc.fail_method='eth_getTransactionReceipt'
        with self.assertRaises(CollectionError) as caught:
            self.collector.collect(self.baseline,self.baseline.baseline)
        self.assertNotIn('secret',str(caught.exception))
        self.rpc.fail_method=None
        with self.assertRaisesRegex(CollectionError,'collection_rpc_budget'):
            CanonicalCollector(self.rpc,max_requests=2).collect(self.baseline,self.baseline.baseline)

    def test_reorg_observation_is_fresh_and_confirmation_failure_preserves_read_failure(self):
        self.forward()
        page=self.collector.collect(self.baseline,self.baseline.baseline)
        original=self.rpc.request
        def reorganize(method, params=()):
            if method=='eth_getBlockByNumber' and params[0]=='0xb':
                self.rpc.headers[11]['hash']=hash_(900)
                self.rpc.headers[10]['hash']=hash_(901)
            return original(method,params)
        self.rpc.request=reorganize
        with self.assertRaises(ReorgDetected) as caught:
            self.collector.collect(self.baseline,page.throughCursor)
        self.assertEqual(caught.exception.observed_baseline.blockHash,hash_(901))
        self.rpc.headers[10]['hash']=hash_(10)
        confirmation=False
        def failed_confirmation(method,params=()):
            nonlocal confirmation
            if method=='eth_getBlockByNumber' and params[0]=='0xb': confirmation=True
            if confirmation and method=='eth_getBlockByNumber' and params[0]=='0xa':
                raise RuntimeError('provider unavailable')
            return original(method,params)
        self.rpc.request=failed_confirmation
        with self.assertRaises(CollectionError) as caught:
            self.collector.collect(self.baseline,page.throughCursor)
        self.assertNotIsInstance(caught.exception,ReorgDetected)
        self.assertEqual(caught.exception.code,'collection_rpc_unavailable')

    def test_capture_rechecks_finality_after_all_opening_reads(self):
        original=self.rpc.request
        def regress(method,params=()):
            if method=='eth_getCode': self.rpc.finalized=9
            return original(method,params)
        self.rpc.request=regress
        with self.assertRaisesRegex(ReorgDetected,'collection_finality_regressed'):
            self.collector.capture(OWNER,VAULT,['1'],CODE_HASH)

    def test_raw_bounds_checkpoint_types_identity_and_ranges_reject_malformed_records(self):
        mutations=[('rootTokenId','0'),('owner',OWNER+'\n'),('vaultCodeHash',CODE_HASH+'\n')]
        for field,value in mutations:
            raw=self.baseline.model_dump(); raw[field]=value
            with self.subTest(field=field),self.assertRaises(ValueError): Baseline.model_validate(raw)
        for field,value in [('generation',0),('tokenId','0'),('liquidityRaw',str(2**256)),
                ('liquidityRaw','1\n'),('tickUpper',-60),
                ('checkpoint',[hash_(1)]+['0']*5+[hash_(2)]),
                ('checkpoint',['0']*7),('checkpoint',[str(2**128)]+['0']*5+[hash_(2)]),
                ('checkpoint',['0']*5+[str(2**64),hash_(2)])]:
            raw=self.baseline.model_dump(); raw['opening']['members'][0][field]=value
            with self.subTest(field=field,value=value),self.assertRaises(ValueError): Baseline.model_validate(raw)

    def test_malformed_transfer_address_padding_is_not_a_valid_event(self):
        log=transfer_log(); log['topics'][1]='0x'+'01'+'00'*11+OWNER[2:]
        self.forward([log])
        with self.assertRaisesRegex(CollectionError,'malformed_position_transfer'):
            self.collector.collect(self.baseline,self.baseline.baseline)

    def test_block_and_json_budgets_never_truncate(self):
        self.rpc.headers[10]['transactions']=[hash_(i+100) for i in range(MAX_BLOCK_TRANSACTIONS+1)]
        with self.assertRaisesRegex(CollectionError,'collection_payload_budget'):
            self.collector.capture(OWNER,VAULT,['1'],CODE_HASH)

    def test_busy_block_does_not_fetch_unrelated_receipts_or_exceed_relevant_limit(self):
        unrelated=[self.rpc.add_transaction(logs=[]) for _ in range(MAX_TRANSACTIONS+1)]
        tx=self.forward()
        self.rpc.calls.clear()
        page=self.collector.collect(self.baseline,self.baseline.baseline)
        self.assertEqual([r.transactionHash for r in page.receipts],[tx])
        self.assertEqual(page.receipts[0].transactionIndex,MAX_TRANSACTIONS+1)
        self.assertFalse(any(m in ('eth_getTransactionReceipt','eth_getTransactionByHash') and p[0] in unrelated
            for m,p in self.rpc.calls))

    def test_receipt_and_cumulative_byte_budgets_fail_before_fetching_all_transactions(self):
        tx=self.forward()
        self.rpc.transactions[tx]['input']='0x'+'ab'*132000
        with self.assertRaisesRegex(CollectionError,'collection_receipt_budget'):
            self.collector.collect(self.baseline,self.baseline.baseline)
        self.rpc.transactions[tx]['input']='0x'+'ab'*120000
        for _ in range(29):
            tx=self.rpc.add_transaction(logs=[vault_log()])
            self.rpc.transactions[tx]['input']='0x'+'ab'*120000
        self.rpc.calls.clear()
        with self.assertRaisesRegex(CollectionError,'collection_page_budget'):
            self.collector.collect(self.baseline,self.baseline.baseline)
        fetched=[p[0] for m,p in self.rpc.calls if m=='eth_getTransactionReceipt']
        self.assertLess(len(fetched),20)
        self.assertGreater(len(fetched),1)

    def test_models_reject_forged_links_flags_and_derived_instance_bypass(self):
        self.forward(); page=self.collector.collect(self.baseline,self.baseline.baseline)
        for mutation in ('event','cursor','receipt','canonical'):
            raw=page.model_dump()
            if mutation=='event': raw['events'][0]['eventId']=hash_(1)
            if mutation=='cursor': raw['throughCursor']['blockHash']=hash_(1)
            if mutation=='receipt': raw['receipts'][0]['logs'][0]['receiptLogIndex']=7
            if mutation=='canonical': raw['canonicality']='verified'
            with self.subTest(mutation=mutation),self.assertRaises(ValueError): Page.model_validate(raw)
        forged=self.baseline.model_copy(update={'owner':NEXT_OWNER})
        with self.assertRaises(CollectionError): self.collector.collect(forged,forged.baseline)

    def test_rpc_surface_has_no_signer_broadcast_or_estimate_methods(self):
        self.assertNotIn('eth_sendRawTransaction',PerformanceRpc.METHODS)
        self.assertNotIn('eth_estimateGas',PerformanceRpc.METHODS)
        with self.assertRaisesRegex(CollectionError,'collection_method_not_read_only'):
            self.collector.request('eth_sendTransaction',[])


if __name__ == '__main__': unittest.main()
