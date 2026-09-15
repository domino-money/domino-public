"""Initialize anchors: bounded discovery, explicit overrides, no silent guess."""
from pathlib import Path
import sys
import unittest

sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from catalogue_indexer import decode_initialize
from discovery import DataError
from manage_activity import find_initialize_anchor, parse_anchors, requested_pool_ids
from manage_catalogue import anchor_candidate
from selected_pools import SELECTED_POOLS
from test_catalogue import log

POOL_ID=decode_initialize(log())['poolId']
UNSET=object()


class StubRpc:
    def __init__(self,logs=None,response=UNSET):
        self.logs=list(logs or [])
        self.response=response
        self.queries=[]
    def request(self,method,params=()):
        if method=='eth_getBlockByNumber':
            number=int(params[0],16)
            for item in self.logs:
                if int(item['blockNumber'],16)==number:
                    return {'number':item['blockNumber'],'hash':item['blockHash'],
                            'timestamp':hex(1000+number)}
            return {'number':hex(number),'hash':'0x'+'ab'*32,'timestamp':hex(1000+number)}
        if method!='eth_getLogs':raise AssertionError(method)
        query=params[0];self.queries.append(query)
        if self.response is not UNSET:return self.response
        low,high=int(query['fromBlock'],16),int(query['toBlock'],16)
        return [item for item in self.logs if low<=int(item['blockNumber'],16)<=high]


class AnchorScanTests(unittest.TestCase):
    def test_found_anchor_reports_the_decoded_block_and_hash(self):
        rpc=StubRpc([log(5000)])
        result=find_initialize_anchor(rpc,POOL_ID,from_block=1,to_block=10000,span=1000,max_spans=10)
        self.assertEqual(result['status'],'found')
        self.assertEqual(result['blockNumber'],5000)
        self.assertEqual(result['blockHash'],log(5000)['blockHash'])
        self.assertEqual(result['spansScanned'],5)
        self.assertEqual(rpc.queries[0]['topics'][1],POOL_ID)

    def test_absent_anchor_stops_at_the_scan_budget_and_says_where_it_stopped(self):
        rpc=StubRpc([])
        result=find_initialize_anchor(rpc,POOL_ID,from_block=1,to_block=10000,span=1000,max_spans=3)
        self.assertEqual(result,{'status':'not_found_in_scanned_range','spansScanned':3,
                                 'scannedThrough':3000,'direction':'forward'})

    def test_a_recent_anchor_is_found_in_the_first_reverse_window(self):
        rpc=StubRpc([log(9950)])
        result=find_initialize_anchor(rpc,POOL_ID,from_block=1,to_block=10000,span=1000,max_spans=10,
                                      reverse=True)
        self.assertEqual((result['status'],result['blockNumber'],result['spansScanned']),
                         ('found',9950,1))
        self.assertEqual(result['direction'],'reverse')
        self.assertEqual(rpc.queries[0]['fromBlock'],hex(9001))
        self.assertEqual(rpc.queries[0]['toBlock'],hex(10000))

    def test_reverse_walks_towards_the_oldest_window_and_reports_where_it_stopped(self):
        rpc=StubRpc([log(1500)])
        found=find_initialize_anchor(rpc,POOL_ID,from_block=1,to_block=10000,span=1000,max_spans=10,
                                     reverse=True)
        self.assertEqual((found['blockNumber'],found['spansScanned']),(1500,9))
        absent=find_initialize_anchor(StubRpc([]),POOL_ID,from_block=1,to_block=10000,span=1000,
                                      max_spans=3,reverse=True)
        self.assertEqual((absent['status'],absent['spansScanned'],absent['scannedThrough']),
                         ('not_found_in_scanned_range',3,7001))

    def test_the_direction_must_be_a_boolean(self):
        for value in (1,'reverse',None):
            with self.subTest(value=value), self.assertRaises(DataError):
                find_initialize_anchor(StubRpc([]),POOL_ID,from_block=1,to_block=10,span=10,
                                       max_spans=1,reverse=value)

    def test_scan_covers_the_requested_end_block_before_giving_up(self):
        rpc=StubRpc([])
        result=find_initialize_anchor(rpc,POOL_ID,from_block=1,to_block=2500,span=1000,max_spans=10)
        self.assertEqual(result['spansScanned'],3)
        self.assertEqual(result['scannedThrough'],2500)
        self.assertEqual(rpc.queries[-1]['toBlock'],hex(2500))

    def test_two_matches_are_ambiguous_and_never_resolved_by_position(self):
        rpc=StubRpc([log(1500),log(1600)])
        with self.assertRaisesRegex(DataError,'ambiguous_initialize_anchor'):
            find_initialize_anchor(rpc,POOL_ID,from_block=1,to_block=10000,span=1000,max_spans=10)

    def test_a_malformed_log_response_is_not_treated_as_absence(self):
        for response in [{'result':[]},'0x',None,[{'removed':True}]]:
            with self.subTest(response=response), self.assertRaises(DataError):
                find_initialize_anchor(StubRpc(response=response),POOL_ID,from_block=1,to_block=10,
                                       span=10,max_spans=1)


class AnchorArgumentTests(unittest.TestCase):
    def test_explicit_anchors_are_parsed_per_pool(self):
        anchors=parse_anchors([f'{POOL_ID}=123',f"{SELECTED_POOLS[0]}=456"])
        self.assertEqual(anchors,{POOL_ID:123,SELECTED_POOLS[0]:456})

    def test_malformed_anchors_are_rejected(self):
        for value in ['',POOL_ID,f'{POOL_ID}=',f'{POOL_ID}=0x10','not-a-pool=12',
                      f'{POOL_ID}=1=2',f'0x00=12']:
            with self.subTest(value=value), self.assertRaises(DataError):
                parse_anchors([value])

    def test_requested_ids_deduplicate_and_the_selection_is_additive(self):
        self.assertEqual(requested_pool_ids([POOL_ID,POOL_ID]),[POOL_ID])
        with_selection=requested_pool_ids([SELECTED_POOLS[0]],selected=True)
        self.assertEqual(with_selection,[*SELECTED_POOLS])
        self.assertEqual(requested_pool_ids([],selected=True),list(SELECTED_POOLS))


class AnchorCandidateTests(unittest.TestCase):
    """Identity from the pool's own Initialize log, without the manager cache."""
    def test_a_log_at_the_anchor_block_yields_a_verified_candidate(self):
        raw=log(5000)
        rpc=StubRpc([raw])
        candidate,block=anchor_candidate('https://rpc.invalid',POOL_ID,5000,rpc=rpc)
        self.assertEqual(candidate['poolId'],POOL_ID)
        key=decode_initialize(raw)['poolKey']
        self.assertEqual(candidate['currencies'],[key['currency0'],key['currency1']])
        self.assertEqual(candidate['poolKey'],key)
        self.assertEqual((block.number,block.hash),(5000,raw['blockHash']))
        self.assertEqual(rpc.queries[0]['topics'][1],POOL_ID)
        self.assertEqual((rpc.queries[0]['fromBlock'],rpc.queries[0]['toBlock']),(hex(5000),hex(5000)))

    def test_a_missing_or_duplicated_anchor_is_refused(self):
        for logs in ([], [log(5000),log(5000,index=1)]):
            with self.subTest(logs=len(logs)), self.assertRaises(DataError):
                anchor_candidate('https://rpc.invalid',POOL_ID,5000,rpc=StubRpc(logs))

    def test_a_log_for_another_pool_is_refused(self):
        with self.assertRaisesRegex(DataError,'initialize_anchor_mismatch'):
            anchor_candidate('https://rpc.invalid',SELECTED_POOLS[0],5000,rpc=StubRpc([log(5000)]))

    def test_an_empty_anchor_block_is_not_an_identity(self):
        with self.assertRaisesRegex(DataError,'initialize_anchor_not_found'):
            anchor_candidate('https://rpc.invalid',POOL_ID,6000,rpc=StubRpc([log(5000)]))

    def test_an_invalid_anchor_block_is_refused_before_any_read(self):
        for block in (0,-1,True,None):
            with self.subTest(block=block), self.assertRaises(DataError):
                anchor_candidate('https://rpc.invalid',POOL_ID,block,rpc=StubRpc([log(5000)]))


if __name__=='__main__':unittest.main()
