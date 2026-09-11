"""Dense study selection, public transport bounds and independent state checkpoints."""
from copy import deepcopy
from dataclasses import asdict
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import Mock,patch

sys.path[:0]=[str(Path(__file__).resolve().parents[1]),str(Path(__file__).resolve().parent)]
from benchmark_fee_steps import (BatchIndexRpc,StudyRpc,study_batch,dense_selection,dense_pool_input,
    detailed_crossing_work,empirical_distribution,paced_public_transport,measure,main,digest,
    WorkLimit,BenchmarkLimit,DENSE_BATCH,validate_dense_checkpoints,selected_dense_input)
from catalogue_indexer import IndexRpc,decode_initialize
from discovery import DataError,parse_block
from pool_activity import INITIALIZE_TOPIC,MODIFY,SWAP
from test_catalogue import FakeIndexRpc,log
from test_discovery import KEY,POOL
from test_pool_activity import ActivityRpc,event_log

ROOT=Path(__file__).resolve().parents[2]
RECENT=ROOT/'reports/fee-step-recent-events-2026-09-10.json'


class DenseRpc(ActivityRpc):
    def request(self,method,params=()):
        if method=='eth_getBlockByNumber' and params[0]=='latest': params=[hex(20),False]
        if method=='eth_getLogs':
            self.requests.append((method,params));q=params[0]
            topics=q['topics'][0] if isinstance(q['topics'][0],list) else [q['topics'][0]]
            pools=q['topics'][1] if len(q['topics'])>1 else None
            if isinstance(pools,str): pools=[pools]
            return [deepcopy(x) for x in self.logs if x['topics'][0] in topics and
                    (pools is None or x['topics'][1] in pools) and
                    int(q['fromBlock'],16)<=int(x['blockNumber'],16)<=int(q['toBlock'],16)]
        return super().request(method,params)
    def batch(self,calls): return [self.request(method,params) for method,params in calls]


class DenseFeeBenchmarkTests(unittest.TestCase):
    def fixture(self):
        data=json.loads(RECENT.read_text())
        data['chunks'][0]['expectedSnapshot']=deepcopy(data['expectedSnapshot'])
        return data

    def bundle(self,data):
        end=deepcopy(data['chunks'][-1]['endBlock'])
        return {'selection':{'selectedPools':[data['poolId']],
            'fromBlock':end['number']-39999,'throughBlock':end['number'],'head':end},'datasets':[data]}

    def test_batch_counts_methods_and_reorders_only_exact_expected_ids(self):
        def transport(url,body):
            return [{'jsonrpc':'2.0','id':item['id'],'result':item['params'][0]} for item in reversed(body)]
        raw=BatchIndexRpc(transport=transport,max_requests=3)
        rpc=StudyRpc(raw,max_requests=3,clock=lambda:0)
        self.assertEqual(study_batch(rpc,[('eth_getBlockByNumber',['0xa',False]),
                                       ('eth_getBlockByNumber',['0xb',False])]),['0xa','0xb'])
        self.assertEqual((rpc.count,raw.count),(2,2))
        with self.assertRaisesRegex(DataError,'rpc_budget'):
            study_batch(rpc,[('eth_getBlockByNumber',['0xc',False])]*2)
        self.assertEqual((rpc.count,raw.count),(2,2))
        with self.assertRaisesRegex(DataError,'method_not_read_only'):
            study_batch(rpc,[('eth_sendTransaction',[])])
        with self.assertRaisesRegex(DataError,'batch_budget'):
            study_batch(rpc,[('eth_chainId',[])]*(DENSE_BATCH+1))

    def test_batch_rejects_partial_duplicate_boolean_unknown_and_error_envelopes(self):
        good=[{'jsonrpc':'2.0','id':1,'result':'a'},{'jsonrpc':'2.0','id':2,'result':'b'}]
        for rows in [good[:1],good+[good[0]],[good[0],good[0]],
                     [{**good[0],'id':True},good[1]],[good[0],{**good[1],'id':3}],
                     [{**good[0],'debug':'private'},good[1]],
                     [{'jsonrpc':'2.0','id':1,'error':{'code':-1}},good[1]]]:
            rpc=BatchIndexRpc(transport=lambda *args:rows)
            with self.subTest(rows=rows),self.assertRaises(DataError):
                rpc.batch([('eth_chainId',[])]*2)
        raw=Mock();rpc=StudyRpc(raw,max_requests=9,clock=Mock(side_effect=[0,0,61]))
        with self.assertRaisesRegex(DataError,'acquisition_deadline'):
            study_batch(rpc,[('eth_chainId',[])])
        self.assertEqual(rpc.count,1)

    def test_pacing_waits_in_shared_deadline_and_never_retries_429(self):
        now=[0.0];waits=[]
        def sleep(delay): waits.append(delay);now[0]+=delay
        transport=Mock(side_effect=['ok',DataError('http_429')])
        with patch('benchmark_fee_steps.bounded_transport',return_value=transport):
            call=paced_public_transport(60,clock=lambda:now[0],sleep=sleep)
            self.assertEqual(call('public',{}),'ok')
            with self.assertRaisesRegex(DataError,'http_429'): call('public',{})
        self.assertEqual(waits,[1.0]);self.assertEqual(transport.call_count,2)

    def test_selection_covers_late_candidates_and_ranks_three_distinct_criteria(self):
        rpc=DenseRpc();rpc.logs=[];pools=[];index=0
        for i in range(10):
            raw=log(10,key=(*KEY[:2],3000+i,*KEY[3:]),index=index);index+=1
            pool=raw['topics'][1];pools.append(pool);rpc.logs.append(raw)
            for j in range(3 if i==9 else 1):
                change=event_log(MODIFY,[-60*(j+1),60*(j+1),100,b'\0'*32],number=11,index=index);index+=1
                change['topics'][1]=pool;rpc.logs.append(change)
            for j in range(4 if i==8 else 2):
                swap=event_log(SWAP,[-100,99,2**96,100,6000*j if i==7 else j,3000+i],number=12+j,index=index);index+=1
                swap['topics'][1]=pool;rpc.logs.append(swap)
        head,candidates,selection=dense_selection(StudyRpc(rpc),through=20,blocks=20)
        self.assertEqual(len(candidates),10)
        self.assertEqual(selection['selectedPools'],[pools[9],pools[8],pools[7]])
        self.assertTrue(selection['olderPoolsExcluded']);self.assertFalse(selection['globalBusiestAssessed'])
        rpc.logs.reverse()
        self.assertEqual(dense_selection(StudyRpc(rpc),through=20,blocks=20)[2],selection)
        with patch('benchmark_fee_steps.DENSE_SELECTION_EVENTS',1):
            with self.assertRaisesRegex(DataError,'selection_event_budget'):
                dense_selection(StudyRpc(rpc),through=20,blocks=20)

    def test_acquisition_rechecks_all_headers_and_preserves_complete_initialize(self):
        raw=DenseRpc();rpc=StudyRpc(raw)
        item=decode_initialize(raw.logs[0]);head=parse_block(raw.request('eth_getBlockByNumber',[hex(20),False]))
        result=dense_pool_input(rpc,item,head)
        self.assertEqual(result['chunks'][0]['events'][0]['kind'],'initialize')
        self.assertEqual(result['chunks'][0]['expectedSnapshot']['number'],20)
        numbers=[row['number'] for row in result['verifiedHeaders']]
        self.assertEqual(numbers,[9,10,11,20])
        for number in numbers:
            self.assertGreaterEqual(sum(method=='eth_getBlockByNumber' and params[0]==hex(number)
                                        for method,params in raw.requests),2)
        raw=DenseRpc();raw.batch=Mock(side_effect=raw.batch)
        def fork(calls):
            values=DenseRpc.batch(raw,calls)
            if raw.batch.call_count==2: values[0]['hash']='0x'+'ab'*32
            return values
        raw.batch.side_effect=fork
        with self.assertRaisesRegex(DataError,'snapshot_reorganized'):
            dense_pool_input(StudyRpc(raw),item,head)

    def test_remaining_global_event_allowance_stops_before_extra_proof_work(self):
        first=DenseRpc();item=decode_initialize(first.logs[0])
        head=parse_block(first.request('eth_getBlockByNumber',[hex(20),False]))
        dataset=dense_pool_input(StudyRpc(first),item,head,remaining_events=6)
        consumed=sum(len(c['events']) for c in dataset['chunks'])
        second=DenseRpc();second.batch=Mock(side_effect=second.batch);second.call=Mock(side_effect=second.call)
        with self.assertRaisesRegex(DataError,'event_budget'):
            dense_pool_input(StudyRpc(second),item,head,remaining_events=6-consumed)
        second.batch.assert_not_called();second.call.assert_not_called()
        self.assertEqual(len(second.requests),1)

    def test_every_chunk_state_is_checked_and_onepass_resume_hash_is_preserved(self):
        dataset=self.fixture();actual=measure(dataset)
        original=json.loads((ROOT/'reports/fee-step-recent-study-2026-09-10.json').read_text())
        self.assertEqual(actual['chunks'][0]['outputSha256'],original['chunks'][0]['outputSha256'])
        for key in ('tick','feeGrowthGlobalX128'):
            broken=deepcopy(dataset)
            broken['chunks'][0]['expectedSnapshot'][key]=1 if key=='tick' else ['0','0']
            with self.subTest(key=key),self.assertRaisesRegex(DataError,'state_reconciliation_failed'):measure(broken)
        broken=deepcopy(dataset);broken['chunks'][0]['events']=broken['chunks'][0]['events'][1:]
        with self.assertRaisesRegex(DataError,'initialize_anchor_required|replay_anchor_required'):measure(broken)

    def test_crossing_instrument_restores_original_math_and_shares_work_limit(self):
        import fee_accounting
        original=fee_accounting.simulate;work=WorkLimit()
        detail=detailed_crossing_work(self.fixture(),work)
        self.assertIs(fee_accounting.simulate,original)
        self.assertEqual(detail['additionalStepAttempts'],240)
        self.assertEqual(detail['swapsObserved'],40)
        self.assertEqual(detail['stepsPerCandidate']['maximum'],1)
        with self.assertRaises(BenchmarkLimit): detailed_crossing_work(self.fixture(),WorkLimit(max_steps=10))
        self.assertIs(fee_accounting.simulate,original)
        self.assertEqual(empirical_distribution([1,2,3,4])['p95'],4)
        self.assertIsNone(empirical_distribution([])['maximum'])

    def test_dense_fixture_is_offline_and_never_claims_fresh_state(self):
        data=self.fixture();bundle=self.bundle(data)
        with tempfile.TemporaryDirectory() as directory,patch('benchmark_fee_steps.BatchIndexRpc') as rpc,\
                patch('benchmark_fee_steps.load_config') as config,patch('benchmark_fee_steps.database_settings') as database:
            fixture=Path(directory)/'source.json';fixture.write_text(json.dumps(bundle));output=Path(directory)/'result.json'
            self.assertEqual(main(['--source','dense-fixture','--fixture',str(fixture),'--output',str(output)]),0)
            report=json.loads(output.read_text());self.assertEqual(report['inputSha256'],digest(bundle))
            self.assertFalse(report['currentCanonicalityAssessed']);self.assertFalse(report['productionCapacityCalibrated'])
            self.assertEqual(report['totalStepAttemptsAllStages'],720)
            self.assertEqual(report['limits']['blocks'],40000)
            rpc.assert_not_called();config.assert_not_called();database.assert_not_called()


    def test_dense_fixture_requires_every_intermediate_checkpoint_and_binding(self):
        data=self.fixture();first=deepcopy(data['chunks'][0]);second=deepcopy(first)
        data['chunks']=[first,second]
        first.pop('expectedSnapshot')
        with self.assertRaisesRegex(DataError,'chunk_checkpoint_required'): validate_dense_checkpoints(data)
        data=self.fixture();data['chunks'][0]['expectedSnapshot']['number']-=1
        with self.assertRaisesRegex(DataError,'chunk_checkpoint_required'): validate_dense_checkpoints(data)
        data=self.fixture();data['expectedSnapshot']['tick']+=1
        with self.assertRaisesRegex(DataError,'chunk_checkpoint_mismatch'): validate_dense_checkpoints(data)

    def test_complete_acquisition_survives_independent_replay_failure_without_success_claim(self):
        bundle=self.bundle(self.fixture())
        with tempfile.TemporaryDirectory() as directory,patch('benchmark_fee_steps.measure',
                side_effect=BenchmarkLimit('fee_benchmark_aggregate_step_budget')):
            source=Path(directory)/'input.json';source.write_text(json.dumps(bundle))
            evidence=Path(directory)/'evidence.json';output=Path(directory)/'output.json'
            self.assertEqual(main(['--source','dense-fixture','--fixture',str(source),
                '--events-output',str(evidence),'--output',str(output)]),1)
            saved=json.loads(evidence.read_text());report=json.loads(output.read_text())
            self.assertEqual(saved['datasets'],bundle['datasets'])
            self.assertEqual(saved['acquisition']['status'],'complete')
            self.assertEqual(saved['acquisition']['replayStatus'],'not_assessed')
            self.assertFalse(saved['acquisition']['currentCanonicalityAssessed'])
            self.assertEqual(saved['acquisition']['inputSha256'],digest(bundle))
            self.assertEqual(report['status'],'unavailable');self.assertIsNone(report['busiestExaminedChunk'])
        for change in ('head','pool'):
            bad=deepcopy(bundle)
            if change=='head': bad['selection']['head']['hash']='0x'+'ee'*32
            else: bad['selection']['selectedPools']=['0x'+'ee'*32]
            with tempfile.TemporaryDirectory() as directory:
                source=Path(directory)/'input.json';source.write_text(json.dumps(bad))
                evidence=Path(directory)/'evidence.json';output=Path(directory)/'output.json'
                self.assertEqual(main(['--source','dense-fixture','--fixture',str(source),
                    '--events-output',str(evidence),'--output',str(output)]),1)
                self.assertFalse(evidence.exists())

    def test_visible_incomplete_or_misordered_lifecycle_never_exports_complete_acquisition(self):
        original=json.loads((ROOT/'reports/fee-step-dense-configured-events-2026-09-10.json').read_text())
        for change in ('missing_chunk','missing_initialize','wrong_key','wrong_order','duplicate_pool'):
            bundle=deepcopy(original);dataset=bundle['datasets'][0]
            if change=='missing_chunk': del dataset['chunks'][1]
            elif change=='missing_initialize': del dataset['chunks'][0]['events'][0]
            elif change=='wrong_key': dataset['chunks'][0]['events'][0]['payload']['poolKey']['fee_pips']+=1
            elif change=='wrong_order': dataset['chunks'][0]['events'][:2]=reversed(dataset['chunks'][0]['events'][:2])
            else:
                bundle['selection']['selectedPools']=[dataset['poolId']]*2
                bundle['datasets']=[dataset,dataset]
            with self.subTest(change=change),tempfile.TemporaryDirectory() as directory,\
                    patch('benchmark_fee_steps.measure') as replay:
                source=Path(directory)/'input.json';source.write_text(json.dumps(bundle))
                evidence=Path(directory)/'evidence.json';output=Path(directory)/'output.json'
                self.assertEqual(main(['--source','dense-fixture','--fixture',str(source),
                    '--events-output',str(evidence),'--output',str(output)]),1)
                self.assertFalse(evidence.exists());replay.assert_not_called()

    def test_censored_chunks_never_produce_nested_or_global_busiest_inference(self):
        from fee_accounting import replay_fees
        from catalogue import checked_key
        from pool_activity import active_liquidity
        data=self.fixture();original=data['chunks'][0];events=original['events']
        cut=next(i+1 for i,e in enumerate(events) if sum(r['kind']=='swap' for r in events[:i+1])==10
                 and i+1<len(events) and events[i+1]['blockNumber']>e['blockNumber'])
        event=events[cut-1];block={'number':event['blockNumber'],'hash':event['blockHash'],'timestamp':event['timestamp']}
        state,ledger,_=replay_fees(None,None,events[:cut],data['poolId'],checked_key(data['poolKey'],data['poolId']))
        snapshot={**data['expectedSnapshot'],**block,
                  **{key:state[key] for key in ('sqrtPriceX96','tick','protocolFeeRaw')},
                  'activeLiquidityRaw':str(active_liquidity(state)),'feeGrowthGlobalX128':ledger['growthX128']}
        data['chunks']=[{**original,'throughBlock':block['number'],'endBlock':block,'expectedSnapshot':snapshot,'events':events[:cut]},
                        {**original,'fromBlock':block['number']+1,'events':events[cut:]}]
        self.assertEqual([c['candidateStepsAdmitted'] for c in measure(data)['chunks']],[60,180])
        with tempfile.TemporaryDirectory() as directory,patch('fee_accounting.MAX_CHUNK_STEPS',18),                patch('benchmark_fee_steps.MAX_CHUNK_STEPS',18):
            source=Path(directory)/'input.json';source.write_text(json.dumps(self.bundle(data)))
            output=Path(directory)/'output.json'
            self.assertEqual(main(['--source','dense-fixture','--fixture',str(source),'--output',str(output)]),0)
            report=json.loads(output.read_text())
            self.assertTrue(report['directChunkMeasurementsCensored'])
            self.assertIsNone(report['busiestExaminedChunk']);self.assertIsNone(report['observedChunkSteps'])
            self.assertIsNone(report['pools'][0]['busiestExaminedChunk'])

    def test_reused_selection_rechecks_chain_head_and_exact_selected_initialization(self):
        rpc=DenseRpc();head,candidates,selection=dense_selection(StudyRpc(rpc),through=20,blocks=20)
        with tempfile.TemporaryDirectory() as directory:
            source=Path(directory)/'survey.json';source.write_text(json.dumps({'selection':selection}))
            observed,again,proof=selected_dense_input(StudyRpc(DenseRpc()),source)
            self.assertEqual(observed,head);self.assertEqual(again,candidates)
            self.assertFalse(proof['reusedSurveyCountsRevalidated'])
            self.assertIn('reusedSurveySha256',proof)
            bad=DenseRpc();bad.chain=1
            with self.assertRaisesRegex(DataError,'wrong_chain'): selected_dense_input(StudyRpc(bad),source)
            bad=DenseRpc();bad.fork_at=20
            with self.assertRaisesRegex(DataError,'snapshot_reorganized'): selected_dense_input(StudyRpc(bad),source)

    def test_configured_dense_requires_explicit_product_path_without_implicit_lookup(self):
        with tempfile.TemporaryDirectory() as directory,patch('benchmark_fee_steps.load_config') as config:
            output=Path(directory)/'output.json'
            self.assertEqual(main(['--source','configured-dense','--output',str(output)]),1)
            self.assertEqual(json.loads(output.read_text())['reason'],'configured_rpc_required')
            config.assert_not_called()


    def test_reused_selection_scope_is_validated_and_controls_reported_window(self):
        rpc=DenseRpc();_,_,selection=dense_selection(StudyRpc(rpc),through=20,blocks=20)
        with tempfile.TemporaryDirectory() as directory:
            source=Path(directory)/'survey.json';source.write_text(json.dumps({'selection':selection}))
            rejected=Mock()
            with self.assertRaisesRegex(DataError,'invalid_window'):
                selected_dense_input(rejected,source,through=21)
            rejected.request.assert_not_called()
            dataset=self.fixture()
            with patch('benchmark_fee_steps.selected_dense_input',return_value=(None,{dataset['poolId']:{}},
                        {'selectedPools':[dataset['poolId']],'fromBlock':10001,'throughBlock':50000,
                         'head':{'number':50000,'hash':'0x'+'aa'*32,'timestamp':1700000000}})),                    patch('benchmark_fee_steps.BatchIndexRpc'),                    patch('benchmark_fee_steps.dense_pool_input',side_effect=DataError('test_bounded_stop')):
                output=Path(directory)/'output.json'
                self.assertEqual(main(['--source','public-dense','--selection-fixture',str(source),'--output',str(output)]),1)
                report=json.loads(output.read_text())
                self.assertEqual(report['limits']['blocks'],40000)
            for key,value in [('fromBlock',-1),('fromBlock',True),('throughBlock',21)]:
                bad=deepcopy(selection);bad[key]=value;source.write_text(json.dumps({'selection':bad}))
                with self.assertRaisesRegex(DataError,'invalid_window'): selected_dense_input(Mock(),source)

    def test_extreme_after_price_repeats_limit_and_can_require_eight_candidates(self):
        # This is a branch-count/resource test, not an independent fee oracle.
        import fee_accounting
        from fee_accounting import simulate,reconstruct_swap
        from catalogue import checked_key
        from pool_activity import replay,MIN_SQRT,protocol_directions
        from test_position_accounting import reference
        fixture=reference();key=checked_key(fixture['poolKey'],fixture['poolId'])
        events=[row['event'] for row in fixture['sequence']]
        prefix=events[:next(i for i,event in enumerate(events) if event['kind']=='swap')]
        state=replay(None,prefix,fixture['poolId'],fixture['poolKey'])
        protocol=protocol_directions(state['protocolFeeRaw'])[0]
        fee=protocol+key.fee_pips-protocol*key.fee_pips//1000000
        result=simulate(state,key,zero=True,remaining=-(2**120),limit=MIN_SQRT+1,fee=fee)
        payload={'amount0':str(-result['grossInput']),'amount1':str(result['output']),
                 'sqrtPriceX96':str(result['sqrtPriceX96']),'tick':result['tick'],
                 'liquidity':str(result['liquidity']),'swapFeePips':fee}
        self.assertEqual(result['sqrtPriceX96'],MIN_SQRT+1)
        with patch.object(fee_accounting,'simulate',wraps=simulate) as observed:
            reconstruct_swap(state,key,payload)
        self.assertEqual(observed.call_count,8)
        self.assertEqual([call.kwargs['limit'] for call in observed.call_args_list],[MIN_SQRT+1]*8)

    def test_real_three_pool_lifecycles_reproduce_exact_checkpoints_costs_and_hashes_offline(self):
        source=ROOT/'reports/fee-step-dense-configured-events-2026-09-10.json'
        observed=json.loads((ROOT/'reports/fee-step-dense-configured-study-2026-09-10.json').read_text())
        with tempfile.TemporaryDirectory() as directory,patch('benchmark_fee_steps.BatchIndexRpc') as rpc,\
                patch('benchmark_fee_steps.load_config') as config:
            output=Path(directory)/'result.json'
            self.assertEqual(main(['--source','dense-fixture','--fixture',str(source),'--output',str(output)]),0)
            replayed=json.loads(output.read_text())
            self.assertEqual(replayed['inputSha256'],observed['inputSha256'])
            self.assertEqual(replayed['totalStepAttemptsAllStages'],43350)
            self.assertEqual(replayed['limits']['blocks'],40000)
            self.assertEqual(replayed['observedChunkSteps']['maximum'],5550)
            self.assertEqual(replayed['observedResumeBatchSteps']['maximum'],1116)
            self.assertEqual(sum(c['events'] for p in replayed['pools'] for c in p['chunks']),2143)
            self.assertEqual(sum(p['crossingWork']['swapsObserved'] for p in replayed['pools']),1960)
            for old,new in zip(observed['pools'],replayed['pools']):
                self.assertTrue(new['eachChunkStateMatched'])
                self.assertEqual(new['crossingWork'],old['crossingWork'])
                self.assertEqual(new['inputSha256'],old['inputSha256'])
                for previous,current in zip(old['chunks'],new['chunks']):
                    self.assertTrue(current['resumedEqualsSinglePass'])
                    self.assertEqual({k:v for k,v in current.items() if k!='replayMilliseconds'},
                                     {k:v for k,v in previous.items() if k!='replayMilliseconds'})
            self.assertFalse(replayed['currentCanonicalityAssessed'])
            self.assertFalse(replayed['globalBusiestAssessed']);self.assertFalse(replayed['productionCapacityCalibrated'])
            self.assertFalse(replayed['ledgerWritten']);self.assertFalse(replayed['executionAvailable'])
            rpc.assert_not_called();config.assert_not_called()
