"""Fresh EOA checks (plain or EIP-7702 delegated) with deterministic synthetic providers only."""
from copy import deepcopy
import io
import json
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from discovery import CHAIN_ID, DataError, PUBLIC_RPC_URL, SNAPSHOT_LOOPBACK_RPC
# Our node, which a session's private file names first.
LOCAL_URL='https://rpc.domino.money/TEST_LOCAL_TOKEN_0123456/'
from read_deadline import read_deadline
from rpc_config import DEFAULT_RPC_HOSTS
from session_chain import EoaChecker
from session_models import SessionError, validate_account


ADDRESS = '0x'+'1'*40
SECOND = 'https://secondary.example.invalid/SYNTHETIC'
BLOCK = {'number':'0xa', 'hash':'0x'+'a'*64, 'timestamp':'0x3e8'}


class Provider:
    def __init__(self):
        self.calls=[]; self.code='0x'; self.fail={}; self.chain=CHAIN_ID
        self.block=deepcopy(BLOCK); self.changed=False; self.final_chain=None
        self.secondary_block=None; self.code_reads=0

    def __call__(self, url, body):
        method=body['method']; params=body['params']; self.calls.append((url,method,deepcopy(params)))
        if (url,method) in self.fail: raise self.fail[(url,method)]
        if method=='eth_chainId':
            result=hex(self.final_chain if self.code_reads and self.final_chain is not None else self.chain)
        elif method=='eth_getBlockByNumber':
            result=deepcopy(self.secondary_block if url==SECOND and self.secondary_block else self.block)
            if self.code_reads and self.changed: result['hash']='0x'+'b'*64
        elif method=='eth_getCode': self.code_reads+=1; result=self.code
        else: raise AssertionError('unexpected RPC method')
        return {'jsonrpc':'2.0','id':body['id'],'result':result}


class EoaTests(unittest.TestCase):
    def setUp(self):
        self.provider=Provider()
        self.checker=EoaChecker((LOCAL_URL,),transport=self.provider,clock=lambda:1010)

    def unavailable(self):
        with self.assertRaisesRegex(SessionError, '^account_check_unavailable$'):
            self.checker.check(ADDRESS)

    def test_pinned_chain_code_and_canonical_snapshot_without_manager_calls(self):
        self.assertEqual(self.checker.check(ADDRESS),
                         {'method':'plain_eoa','blockNumber':'10','blockHash':BLOCK['hash']})
        self.assertEqual([method for _,method,_ in self.provider.calls],
                         ['eth_chainId','eth_chainId','eth_getBlockByNumber','eth_getCode',
                          'eth_getBlockByNumber','eth_chainId'])
        self.assertEqual(self.provider.calls[3][2],[ADDRESS,'0xa'])
        self.assertEqual(self.provider.calls[4][2],['0xa',False])

    def test_a_delegation_designator_is_an_eoa_reporting_its_delegate(self):
        for code in ('0xef0100'+'ab'*20,'0xEF0100'+'AB'*20,'0xef0100'+'00'*19+'01'):
            self.setUp(); self.provider.code=code
            with self.subTest(code=code):
                self.assertEqual(self.checker.check(ADDRESS),
                                 {'method':'eip7702_delegated','delegate':'0x'+code[8:].lower(),
                                  'blockNumber':'10','blockHash':BLOCK['hash']})
                self.assertEqual([method for _,method,_ in self.provider.calls],
                                 ['eth_chainId','eth_chainId','eth_getBlockByNumber','eth_getCode',
                                  'eth_getBlockByNumber','eth_chainId'])

    def test_other_code_and_near_miss_designators_are_unsupported(self):
        # A contract, a designator one byte short or long, another prefix, and
        # a zero delegate (EIP-7702 clears the code instead of writing that).
        for code in ('0x00','0x6001600055','0xDEADBEEF','0xef0100'+'ab'*19,'0xef0100'+'ab'*21,
                     '0xef0101'+'ab'*20,'0xef01'+'ab'*20,'0x00ef0100'+'ab'*20,'0xef0100'+'00'*20):
            self.setUp(); self.provider.code=code
            with self.subTest(code=code), self.assertRaisesRegex(SessionError, '^account_unsupported$'):
                self.checker.check(ADDRESS)
            self.assertEqual(self.provider.calls[-1][1],'eth_chainId')

    def test_the_validation_a_session_stores_is_one_of_two_closed_shapes(self):
        plain={'method':'plain_eoa','blockNumber':'10','blockHash':BLOCK['hash']}
        delegated={**plain,'method':'eip7702_delegated','delegate':'0x'+'ab'*20}
        for value in (plain,delegated):
            self.assertIs(validate_account(value),value)
        for value in ({**plain,'delegate':'0x'+'ab'*20},{k:v for k,v in delegated.items() if k!='delegate'},
                      {**delegated,'delegate':'0x'+'00'*20},{**delegated,'delegate':'0x'+'AB'*20},
                      {**delegated,'delegate':'0x'+'ab'*19},{**delegated,'delegate':None},
                      {**delegated,'method':'contract'},{**plain,'extra':1},None,[]):
            with self.subTest(value=value), self.assertRaisesRegex(SessionError,'^account_check_unavailable$'):
                validate_account(value)

    def test_unknown_or_malformed_code_never_means_empty(self):
        for code in (None,False,0,'','0X','0x0','0xgg',{},'0x'+'ff'*1_000_000):
            self.setUp(); self.provider.code=code; self.unavailable()
        for error in (DataError('rpc_error'),DataError('http_503'),DataError('network_unavailable'),
                      RuntimeError('SYNTHETIC private provider detail')):
            self.setUp(); self.provider.fail[(LOCAL_URL,'eth_getCode')]=error; self.unavailable()

    def test_chain_snapshot_and_freshness_failure_prevent_support_decision(self):
        for code in ('0x','0xef0100'+'ab'*20):
            self.setUp(); self.provider.code=code; self.provider.changed=True; self.unavailable()
            self.setUp(); self.provider.code=code; self.provider.final_chain=1; self.unavailable()
        self.setUp(); self.provider.chain=1; self.unavailable()
        self.assertEqual(len(self.provider.calls),1)
        for timestamp in (889,1026):
            self.setUp(); self.provider.block['timestamp']=hex(timestamp); self.unavailable()
            self.assertFalse(self.provider.code_reads)

    def test_each_check_is_new_and_code_changes_are_observed(self):
        self.checker.check(ADDRESS)
        self.provider.block={**BLOCK,'number':'0xb','hash':'0x'+'b'*64}
        self.provider.code='0xef0100'+'ab'*20
        self.assertEqual(self.checker.check(ADDRESS)['delegate'],'0x'+'ab'*20)
        self.provider.code='0xef0100'+'cd'*20
        self.assertEqual(self.checker.check(ADDRESS)['delegate'],'0x'+'cd'*20)
        self.provider.code='0x6000'
        with self.assertRaisesRegex(SessionError,'^account_unsupported$'): self.checker.check(ADDRESS)
        self.assertEqual(self.provider.code_reads,4)

    def test_snapshot_height_uses_shared_twenty_digit_bound(self):
        self.provider.block['number']=hex(10**20-1)
        self.assertEqual(self.checker.check(ADDRESS)['blockNumber'],str(10**20-1))
        self.provider.block['number']=hex(10**20)
        count=self.provider.code_reads
        self.unavailable()
        self.assertEqual(self.provider.code_reads,count)

    def test_fallback_must_prove_same_chain_and_existing_block(self):
        self.checker=EoaChecker((LOCAL_URL,SECOND),transport=self.provider,clock=lambda:1010,
                                    allowed_hosts=(*DEFAULT_RPC_HOSTS,'secondary.example.invalid'))
        self.provider.fail[(LOCAL_URL,'eth_getCode')]=DataError('http_503')
        self.assertEqual(self.checker.check(ADDRESS)['blockHash'],BLOCK['hash'])
        methods=[method for url,method,_ in self.provider.calls if url==SECOND]
        self.assertEqual(methods[:3],['eth_chainId','eth_getBlockByNumber','eth_getCode'])
        self.provider.secondary_block={**BLOCK,'hash':'0x'+'c'*64}
        self.unavailable()

    def test_parent_budget_stops_subrequests_and_no_late_success(self):
        elapsed=[0.0]; real=self.provider
        def slow(url,body):
            result=real(url,body); elapsed[0]+=2; return result
        self.checker=EoaChecker((LOCAL_URL,),transport=slow,clock=lambda:1010)
        with read_deadline(1,clock=lambda:elapsed[0]):
            self.unavailable()
            self.assertEqual(len(self.provider.calls),1)
            elapsed[0]=0

    def test_invalid_operator_endpoints_fail_before_any_network(self):
        # Robinhood's public RPC is not a default host: a session file must name it to use it.
        for urls in ([],[LOCAL_URL]*2,[LOCAL_URL]*4,['http://rpc.mainnet.chain.robinhood.com'],[PUBLIC_RPC_URL],
                     ['https://unlisted.example.invalid'],['https://127.0.0.1'],LOCAL_URL):
            with self.assertRaisesRegex(ValueError,'^invalid_session_rpc_config$'):
                EoaChecker(urls,transport=self.provider)
        self.assertEqual(self.provider.calls,[])
        with self.assertRaisesRegex(SessionError,'^account_check_unavailable$'):
            self.checker.check('not-an-address')
        self.assertEqual(self.provider.calls,[])

    def test_status_loopback_uses_only_exact_local_transport_and_pinned_chain(self):
        with patch('session_chain.snapshot_loopback_http', self.provider):
            checker=EoaChecker((SNAPSHOT_LOOPBACK_RPC,),clock=lambda:1010,
                                    execution_status_loopback=True)
        self.assertEqual(checker.urls,(SNAPSHOT_LOOPBACK_RPC,))
        self.assertIs(checker.transport,self.provider)
        self.assertEqual(checker.check(ADDRESS)['blockHash'],BLOCK['hash'])
        self.assertEqual({url for url,_,_ in self.provider.calls},{SNAPSHOT_LOOPBACK_RPC})
        self.provider.chain=1
        with self.assertRaisesRegex(SessionError,'^account_check_unavailable$'):
            checker.check(ADDRESS)

    def test_status_loopback_http_transport_performs_chain_and_code_reads(self):
        methods=[]
        def opener(request,timeout):
            self.assertEqual(request.full_url,SNAPSHOT_LOOPBACK_RPC)
            self.assertGreater(timeout,0)
            body=json.loads(request.data)
            method=body['method'];methods.append(method)
            result={'eth_chainId':hex(CHAIN_ID),'eth_getBlockByNumber':BLOCK,
                    'eth_getCode':'0x'}[method]
            return io.BytesIO(json.dumps({'jsonrpc':'2.0','id':body['id'],
                                          'result':result}).encode())
        checker=EoaChecker((SNAPSHOT_LOOPBACK_RPC,),clock=lambda:1010,
                                execution_status_loopback=True)
        with patch('discovery._LOOPBACK_JSON_OPENER',opener):
            self.assertEqual(checker.check(ADDRESS)['method'],'plain_eoa')
        self.assertEqual(methods,['eth_chainId','eth_chainId','eth_getBlockByNumber',
                                  'eth_getCode','eth_getBlockByNumber','eth_chainId'])

    def test_status_loopback_rejects_near_misses_fallbacks_and_transport_override(self):
        for url in ('http://localhost:18547/','http://127.0.0.2:18547/',
                    'http://127.0.0.1:8547/',SNAPSHOT_LOOPBACK_RPC.rstrip('/'),
                    SNAPSHOT_LOOPBACK_RPC+'?url=https://evil.invalid'):
            for enabled in (False,True):
                with self.subTest(url=url,enabled=enabled), self.assertRaisesRegex(
                        ValueError,'^invalid_session_rpc_config$'):
                    EoaChecker((url,),execution_status_loopback=enabled)
        for urls,kwargs in (((SNAPSHOT_LOOPBACK_RPC,LOCAL_URL),{}),
                            ((SNAPSHOT_LOOPBACK_RPC,),{'transport':self.provider}),
                            ((LOCAL_URL,),{})):
            with self.subTest(urls=urls,kwargs=kwargs), self.assertRaisesRegex(
                    ValueError,'^invalid_session_rpc_config$'):
                EoaChecker(urls,execution_status_loopback=True,**kwargs)
        with self.assertRaisesRegex(ValueError,'^invalid_session_rpc_config$'):
            EoaChecker((SNAPSHOT_LOOPBACK_RPC,),execution_status_loopback=1)
        with self.assertRaisesRegex(ValueError,'^invalid_session_rpc_config$'):
            EoaChecker((SNAPSHOT_LOOPBACK_RPC,))
        self.assertEqual(self.provider.calls,[])


if __name__ == '__main__': unittest.main()
