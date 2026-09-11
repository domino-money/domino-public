"""Fresh plain-EOA checks with deterministic synthetic providers only."""
from copy import deepcopy
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from discovery import CHAIN_ID, DataError, RPC_URL
from read_deadline import read_deadline
from rpc_config import DEFAULT_RPC_HOSTS
from session_chain import PlainEoaChecker
from session_models import SessionError


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
        self.checker=PlainEoaChecker((RPC_URL,),transport=self.provider,clock=lambda:1010)

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

    def test_every_nonempty_code_including_delegation_is_unsupported(self):
        for code in ('0x00','0x6001600055','0xef0100'+'ab'*20,'0xDEADBEEF'):
            self.setUp(); self.provider.code=code
            with self.subTest(code=code), self.assertRaisesRegex(SessionError, '^account_unsupported$'):
                self.checker.check(ADDRESS)
            self.assertEqual(self.provider.calls[-1][1],'eth_chainId')

    def test_unknown_or_malformed_code_never_means_empty(self):
        for code in (None,False,0,'','0X','0x0','0xgg',{},'0x'+'ff'*1_000_000):
            self.setUp(); self.provider.code=code; self.unavailable()
        for error in (DataError('rpc_error'),DataError('http_503'),DataError('network_unavailable'),
                      RuntimeError('SYNTHETIC private provider detail')):
            self.setUp(); self.provider.fail[(RPC_URL,'eth_getCode')]=error; self.unavailable()

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
        with self.assertRaisesRegex(SessionError,'^account_unsupported$'): self.checker.check(ADDRESS)
        self.assertEqual(self.provider.code_reads,2)

    def test_snapshot_height_uses_shared_twenty_digit_bound(self):
        self.provider.block['number']=hex(10**20-1)
        self.assertEqual(self.checker.check(ADDRESS)['blockNumber'],str(10**20-1))
        self.provider.block['number']=hex(10**20)
        count=self.provider.code_reads
        self.unavailable()
        self.assertEqual(self.provider.code_reads,count)

    def test_fallback_must_prove_same_chain_and_existing_block(self):
        self.checker=PlainEoaChecker((RPC_URL,SECOND),transport=self.provider,clock=lambda:1010,
                                    allowed_hosts=(*DEFAULT_RPC_HOSTS,'secondary.example.invalid'))
        self.provider.fail[(RPC_URL,'eth_getCode')]=DataError('http_503')
        self.assertEqual(self.checker.check(ADDRESS)['blockHash'],BLOCK['hash'])
        methods=[method for url,method,_ in self.provider.calls if url==SECOND]
        self.assertEqual(methods[:3],['eth_chainId','eth_getBlockByNumber','eth_getCode'])
        self.provider.secondary_block={**BLOCK,'hash':'0x'+'c'*64}
        self.unavailable()

    def test_parent_budget_stops_subrequests_and_no_late_success(self):
        elapsed=[0.0]; real=self.provider
        def slow(url,body):
            result=real(url,body); elapsed[0]+=2; return result
        self.checker=PlainEoaChecker((RPC_URL,),transport=slow,clock=lambda:1010)
        with read_deadline(1,clock=lambda:elapsed[0]):
            self.unavailable()
            self.assertEqual(len(self.provider.calls),1)
            elapsed[0]=0

    def test_invalid_operator_endpoints_fail_before_any_network(self):
        for urls in ([],[RPC_URL]*2,[RPC_URL]*4,['http://rpc.mainnet.chain.robinhood.com'],
                     ['https://unlisted.example.invalid'],['https://127.0.0.1'],RPC_URL):
            with self.assertRaisesRegex(ValueError,'^invalid_session_rpc_config$'):
                PlainEoaChecker(urls,transport=self.provider)
        self.assertEqual(self.provider.calls,[])
        with self.assertRaisesRegex(SessionError,'^account_check_unavailable$'):
            self.checker.check('not-an-address')
        self.assertEqual(self.provider.calls,[])


if __name__ == '__main__': unittest.main()
