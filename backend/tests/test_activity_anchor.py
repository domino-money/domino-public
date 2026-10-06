"""Initialize anchors: bounded discovery, explicit overrides, no silent guess."""
from contextlib import contextmanager
from pathlib import Path
import sys
import unittest

sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from catalogue_indexer import decode_initialize
from discovery import DataError
from manage_activity import (MAX_SEARCH_SPAN, SEARCH_FINALITY_BLOCKS, ensure_anchor, find_initialize_anchor,
                             parse_anchors, requested_pool_ids, search_initialize, stored_scan,
                             worker_exit_code)
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


class TimedRpc(StubRpc):
    """Each log window takes `seconds` on its own clock; `fail_after` windows answer, then rpc_error."""
    def __init__(self,logs=None,*,seconds=0.0,fail_after=None,response=UNSET):
        super().__init__(logs,response=response)
        self.now,self.seconds,self.fail_after=0.0,seconds,fail_after
    def clock(self):
        return self.now
    def request(self,method,params=()):
        if method=='eth_getLogs':
            self.now+=self.seconds
            if self.fail_after is not None and len(self.queries)>=self.fail_after:
                raise DataError('rpc_error')
        return super().request(method,params)
    def windows(self):
        return [(int(query['fromBlock'],16),int(query['toBlock'],16)) for query in self.queries]


def search(rpc,*,scanned=(),covered=(100,9500),span=40,max_spans=10,seconds=20,lower=1):
    """Head 10,000: the catalogue holds [100, 9,500]; POOL_ID's Initialize, if any, is the stub's."""
    return search_initialize(rpc,POOL_ID,lower=lower,upper=9999,covered=covered,scanned=list(scanned),
                             span=span,max_spans=max_spans,seconds=seconds,head_number=10_000,clock=rpc.clock)


class InitializeSearchTests(unittest.TestCase):
    """The history no stored source answers, newest window first, resumed claim after claim."""
    def test_the_catalogue_interval_is_skipped_and_the_deep_part_goes_newest_first(self):
        rpc=TimedRpc([log(10)])
        found,progress=search(rpc)
        self.assertEqual(found,10)
        self.assertEqual(rpc.windows(),[(60,99),(20,59),(1,19)])
        self.assertTrue(all(query['topics']==[query['topics'][0],POOL_ID] for query in rpc.queries))
        self.assertEqual((progress['scanned'],progress['complete'],progress['windows']),([[20,99]],False,3))
        self.assertEqual(progress['catalogueInterval'],[100,9500])

    def test_a_claim_resumes_below_what_the_last_one_proved_empty(self):
        rpc=TimedRpc([])
        found,first=search(rpc,max_spans=2)
        self.assertEqual((found,first['complete'],first['scanned']),(None,False,[[20,99]]))
        # Left: 19 blocks below the catalogue and the 499 above it, next to the head.
        self.assertEqual(first['remainingBlocks'],19+499)
        again=TimedRpc([])
        found,second=search(again,scanned=stored_scan({'anchorSearch':first}),max_spans=100)
        self.assertIsNone(found)
        self.assertEqual(again.windows()[0],(1,19))
        self.assertEqual(again.windows()[1:3],[(9960,9999),(9920,9959)])
        self.assertTrue(all(low>=9501 for low,_ in again.windows()[1:]))
        # Nothing is left, so absence is proved; windows next to the head are never remembered.
        self.assertEqual((second['complete'],second['remainingBlocks'],second['scanned']),(True,0,[[1,99]]))

    def test_the_part_next_to_the_head_comes_last_and_is_never_remembered(self):
        self.assertEqual(SEARCH_FINALITY_BLOCKS,1_000)
        rpc=TimedRpc([])
        found,progress=search(rpc,covered=None,span=4000,max_spans=3)
        # [1, 9,000] newest first, then the 999 blocks within 1,000 of the head.
        self.assertEqual(rpc.windows(),[(5001,9000),(1001,5000),(1,1000)])
        found,progress=search(TimedRpc([]),covered=None,span=4000,max_spans=4)
        self.assertEqual((progress['complete'],progress['scanned']),(True,[[1,9000]]))
        found,progress=search(TimedRpc([]),covered=None,span=10_000,max_spans=1,lower=9500)
        self.assertEqual((progress['complete'],progress['scanned'],progress['remainingBlocks']),(True,[],0))

    def test_a_window_is_started_only_when_the_budget_still_holds_one(self):
        rpc=TimedRpc([],seconds=8.0)
        found,progress=search(rpc,seconds=20)
        # 0 + 0 < 20 and 8 + 8 < 20 start a window; 16 + 8 does not.
        self.assertEqual((len(rpc.windows()),progress['seconds']),(2,16.0))
        none=TimedRpc([],seconds=8.0)
        found,progress=search(none,seconds=0)
        self.assertEqual((none.windows(),progress['windows'],progress['complete']),([],0,False))

    def test_a_failed_window_carries_what_was_proved_before_it(self):
        rpc=TimedRpc([],fail_after=1)
        with self.assertRaisesRegex(DataError,'^rpc_error$') as caught:
            search(rpc)
        self.assertEqual((caught.exception.search['scanned'],caught.exception.search['complete']),([[60,99]],False))

    def test_a_log_for_another_pool_or_outside_the_window_is_refused(self):
        other=log(70,key=('0x'+'11'*20,'0x'+'22'*20,3000,60,'0x'+'00'*20))
        for response in ([other],[log(5000)]):
            with self.subTest(block=int(response[0]['blockNumber'],16)):
                with self.assertRaisesRegex(DataError,'^initialize_anchor_mismatch$') as caught:
                    search(TimedRpc(response=response))
                self.assertEqual((caught.exception.search['windows'],caught.exception.search['scanned']),(1,[]))

    def test_bounds_and_stored_progress_are_checked(self):
        for change in ({'span':0},{'span':MAX_SEARCH_SPAN+1},{'max_spans':0},{'seconds':-1},{'lower':0}):
            with self.subTest(change=change), self.assertRaisesRegex(DataError,'invalid_search_bounds'):
                search(TimedRpc([]),**change)
        self.assertEqual(stored_scan({'anchorSearch':{'scanned':[[20,99],[200,300]]}}),[(20,99),(200,300)])
        for detail in (None,{},{'anchorSearch':None},{'anchorSearch':{'scanned':[[99,20]]}},
                       {'anchorSearch':{'scanned':[[0,5]]}},{'anchorSearch':{'scanned':[[1,True]]}},
                       {'anchorSearch':{'scanned':[[1,2,3]]}},{'anchorSearch':{'scanned':[[1,2]]*17}}):
            with self.subTest(detail=detail):
                self.assertEqual(stored_scan(detail),[])


class Rows:
    def __init__(self,row):self.row=row
    def fetchone(self):return self.row


class FakeCatalogue:
    """The four answers ensure_anchor reads, and the hints it seeds."""
    def __init__(self,*,registered=None,event=None,hint=False,covered=(100,9500)):
        self.registered,self.event,self.hint,self.covered=registered,event,hint,covered
        self.seeded=[]
    @contextmanager
    def connection(self):
        yield self
    def execute(self,query,params=()):
        if 'domino_activity.pools' in query:
            return Rows({'start_block':self.registered} if self.registered else None)
        if 'domino_catalogue.events' in query:
            return Rows({'block_number':self.event} if self.event else None)
        if 'domino_catalogue.hints' in query:
            return Rows({'present':1} if self.hint else None)
        if 'domino_catalogue.state' in query:
            start,end=self.covered or (None,None)
            return Rows({'start_block':start,'next_block':None if end is None else end+1})
        raise AssertionError(query)
    def seed(self,pools,block):
        self.seeded.append(([pool['poolId'] for pool in pools],block.number))


class StateRpc(TimedRpc):
    def __init__(self,logs=None,*,sqrt=2**96):
        super().__init__(logs)
        self.sqrt,self.calls=sqrt,[]
    def call(self,target,signature,inputs=(),values=(),outputs=(),*,block):
        self.calls.append((signature,'0x'+values[0].hex(),block))
        return (self.sqrt,0,0,3000)


def anchor(catalogue,rpc,**kwargs):
    return ensure_anchor(catalogue,rpc,'https://rpc.invalid',POOL_ID,lower=1,head_number=10_000,
                         span=kwargs.pop('span',40),max_spans=kwargs.pop('max_spans',10),seconds=20,**kwargs)


class EnsureAnchorTests(unittest.TestCase):
    def test_stored_answers_need_no_rpc(self):
        rpc=StateRpc([])
        self.assertEqual(anchor(FakeCatalogue(registered=10,event=12),rpc),(10,'stored_registration',None))
        self.assertEqual(anchor(FakeCatalogue(event=12),rpc),(12,'catalogue_event',None))
        self.assertEqual((rpc.queries,rpc.calls),([],[]))

    def test_an_id_nobody_initialized_costs_one_state_read_and_no_log(self):
        rpc=StateRpc([log(10)],sqrt=0)
        with self.assertRaisesRegex(DataError,'^pool_not_initialized$'):
            anchor(FakeCatalogue(),rpc)
        self.assertEqual(rpc.calls,[('getSlot0(bytes32)',POOL_ID,hex(10_000))])
        self.assertEqual(rpc.queries,[])

    def test_a_hint_is_evidence_enough_to_search(self):
        catalogue,rpc=FakeCatalogue(hint=True),StateRpc([log(10)],sqrt=0)
        block,source,progress=anchor(catalogue,rpc)
        self.assertEqual((block,source,rpc.calls,catalogue.seeded),(10,'initialize_log',[],[]))
        self.assertEqual(progress['windows'],3)

    def test_a_pool_the_catalogue_never_saw_is_found_seeded_then_resumed_or_refused(self):
        catalogue,rpc=FakeCatalogue(),StateRpc([log(10)])
        self.assertEqual(anchor(catalogue,rpc)[:2],(10,'initialize_log'))
        self.assertEqual(catalogue.seeded,[([POOL_ID],10)])
        block,source,progress=anchor(FakeCatalogue(hint=True),StateRpc([]),max_spans=2)
        self.assertEqual((block,source,progress['complete']),(None,'initialize_search',False))
        with self.assertRaisesRegex(DataError,'^initialize_anchor_not_found$') as caught:
            anchor(FakeCatalogue(hint=True),StateRpc([]),span=MAX_SEARCH_SPAN)
        self.assertEqual((caught.exception.search['complete'],caught.exception.search['remainingBlocks']),(True,0))


class WorkerExitTests(unittest.TestCase):
    def test_only_the_runs_own_budget_after_progress_is_a_success(self):
        done={'poolId':POOL_ID,'status':'indexing'}
        budget={**done,'reason':'run_deadline_exceeded'}
        self.assertEqual(worker_exit_code([]),0)
        self.assertEqual(worker_exit_code([done,done]),0)
        self.assertEqual(worker_exit_code([done,budget]),0)
        self.assertEqual(worker_exit_code([done,{**budget,'reason':'header_budget_exhausted'}]),0)
        self.assertEqual(worker_exit_code([budget]),1)
        self.assertEqual(worker_exit_code([done,{**done,'reason':'network_unavailable'}]),1)
        self.assertEqual(worker_exit_code([done,{**done,'status':'blocked','reason':'initialize_anchor_not_found'}]),1)


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
