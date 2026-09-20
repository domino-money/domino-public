import copy
from concurrent.futures import ThreadPoolExecutor
from dataclasses import asdict
import json
from pathlib import Path
import sys
from threading import Barrier, Lock
import time
import unittest
from unittest.mock import patch

sys.path[:0] = [str(Path(__file__).resolve().parents[1]), str(Path(__file__).resolve().parent)]
from fastapi.testclient import TestClient
from eth_abi import encode
from eth_hash.auto import keccak
from discovery import DataError, PoolKey, KEY_TYPES
from read_api import create_app, ReadGate, NftPositionsRequest, CatalogueRequest
from read_contract import validate_response, export_contract
from read_gateway import Gateway, LocalReaderHTTP, create_gateway
from read_history_fixtures import history_service
from test_bridge_identity import IdentityFixtures
from test_discovery import TOKEN, POOL, KEY, FakeRpc, candidate
from test_read_contract import service, CatalogueFixture


class ReadHistoryTests(IdentityFixtures, unittest.TestCase):
    def pipeline(self, reader, *, interval=0):
        upstream = TestClient(create_app(reader, gate=ReadGate(interval=0), read_budget_seconds=15),
                              base_url='http://127.0.0.1:8876')
        gateway = Gateway(enabled=True, enabled_reads=('pool-activity','pool-positions','pool-metrics','catalogue','token'),
                          verifier=self.verifier(), upstream=LocalReaderHTTP(client=upstream), gate=ReadGate(interval=interval))
        return gateway, create_gateway(gateway)

    def test_historical_http_gateway_preserves_real_response_states_and_disabled_execution(self):
        for options in ({}, {'complete':False}, {'stale':True}, {'ledgers':False},
                        {'prices':'overflow'}, {'qualified':False}, {'reference_only':True}):
            with self.subTest(options=options), history_service(**options) as (reader, _):
                _, app = self.pipeline(reader)
                with TestClient(app, base_url='http://127.0.0.1:8878', client=('127.0.0.1',1)) as client:
                    headers={'Cf-Access-Jwt-Assertion':self.token(),'X-Domino-Client-Id':'192.0.2.10'}
                    for route in ('pool-activity','pool-positions','pool-metrics'):
                        response=client.post('/internal/read/v1/'+route,json={'poolId':POOL},headers=headers)
                        self.assertEqual(response.status_code,200,response.text)
                        payload=response.json(); validate_response(route,payload)
                        expected=getattr(reader,route.replace('-','_'))(POOL)
                        self.assertEqual(payload,expected)
                        self.assertFalse(payload['executionAvailable'])
                        directives={item.strip().lower() for item in response.headers['cache-control'].split(',')}
                        self.assertTrue({'no-store','no-transform'} <= directives)
                        self.assertNotIn('content-encoding',response.headers)
                        self.assertNotIn('set-cookie',response.headers)

    def test_current_apr_requires_fresh_complete_qualified_valuation(self):
        with history_service(reference_only=True) as (reader, _):
            reference = reader.pool_metrics(POOL)
            self.assertEqual(reference['valuation']['status'], 'reference_analytics_only')
            self.assertIsNotNone(reference['valuation']['feeAprPercent'])
            self.assertIsNotNone(reference['valuation']['tvlUsd'])
            self.assertTrue(reference['valuation']['complete24h'])
            self.assertEqual(reference['freshness']['status'], 'fresh')
            self.assertFalse(reference['usableAsCurrent24h'])
            validate_response('pool-metrics', reference)
            reference['usableAsCurrent24h'] = True
            with self.assertRaises(ValueError): validate_response('pool-metrics', reference)
        with history_service() as (reader, _):
            qualified = reader.pool_metrics(POOL)
        self.assertTrue(qualified['usableAsCurrent24h'])
        validate_response('pool-metrics', qualified)
        for path, value in [(('valuation','status'),'reference_analytics_only'),
                            (('valuation','complete24h'),False), (('capital','complete24h'),False),
                            (('valuation','feeAprPercent'),None), (('freshness','status'),'stale')]:
            payload=copy.deepcopy(qualified); payload[path[0]][path[1]]=value
            with self.subTest(path=path), self.assertRaises(ValueError):
                validate_response('pool-metrics',payload)
            payload['usableAsCurrent24h']=False
            validate_response('pool-metrics',payload)

    def test_capital_and_price_incomplete_states_never_fabricate_usd_or_raw_context(self):
        for reason in ('capital_ledger_not_caught_up','capital_window_budget_exhausted'):
            with history_service(capital_failure=reason) as (reader, _):
                result=reader.pool_metrics(POOL)
                self.assertEqual(result['capital']['reason'],reason)
                self.assertIsNone(result['capital']['current'])
                self.assertIsNone(result['valuation']['feeAprPercent'])
                self.assertTrue(all(price['observations'] is None for price in result['prices']))
                self.assertFalse(result['usableAsCurrent24h'])
        with history_service(prices='overflow') as (reader, _):
            result=reader.pool_metrics(POOL)
            self.assertEqual(result['capital']['status'],'reconciled_event_history')
            self.assertEqual(result['valuation']['reason'],'price_observation_budget_exhausted')
            self.assertIsNone(result['valuation']['tvlUsd'])
            self.assertEqual(result['coverage']['canonicality'],'block_hash_rechecked')

    def test_database_integrity_and_rpc_failures_remain_errors_not_capacity_states(self):
        for reason in ('catalogue_database_unavailable','stored_capital_events_incomplete','capital_source_history_gap'):
            with history_service(capital_failure=reason) as (reader, _):
                with self.assertRaisesRegex(DataError,reason): reader.pool_metrics(POOL)
        with history_service(prices='outage') as (reader, _):
            with self.assertRaisesRegex(DataError,'catalogue_database_unavailable'): reader.pool_metrics(POOL)
        with history_service(prices='overflow') as (reader, _):
            rpc=reader._rpc(None)
            with patch.object(rpc,'request',side_effect=DataError('rpc_error')):
                reader.rpc_factory=lambda:rpc
                with self.assertRaisesRegex(DataError,'rpc_error'): reader.pool_metrics(POOL)

    def test_selector_bounds_and_closed_schema_reasons(self):
        for model, key, base in [(NftPositionsRequest,'blockNumber',{'tokenIds':['1']}),
                                 (CatalogueRequest,'revision',{'token':TOKEN})]:
            model.model_validate({**base,key:2**53-1})
            for value in (-1,2**53,True,'100'):
                with self.subTest(model=model,key=key,value=value), self.assertRaises(ValueError):
                    model.model_validate({**base,key:value})
        payload=service().token(TOKEN)
        payload['asset']['metadataIssues']['decimals']='unreviewed_new_reason'
        with self.assertRaises(ValueError): validate_response('token',payload)
        for schema in export_contract().values():
            self.assertNotIn('"default": null',json.dumps(schema))

    def test_dynamic_fee_identity_is_discriminated_and_raw_sentinel_is_retained(self):
        class DynamicRpc(FakeRpc):
            def call(self,target,signature,*args,**kwargs):
                if signature=='getSlot0(bytes32)': return (2**96,0,0,3000)
                return super().call(target,signature,*args,**kwargs)
        rpc=DynamicRpc();rpc.key=(*KEY[:2],8388608,*KEY[3:])
        raw=candidate();raw['pairAddress']='0x'+keccak(encode(KEY_TYPES,rpc.key)).hex()
        result=service(rpc,discovery=lambda _: [raw]).pools(TOKEN)
        validate_response('pools',result)
        self.assertEqual(result['pools'][0]['poolKind'],'discovery')
        self.assertEqual(result['pools'][0]['poolKey']['feeMode'],'dynamic')
        self.assertEqual(result['pools'][0]['poolKey']['fee_pips'],8388608)
        result['pools'][0]['poolKey']['feeMode']='fixed'
        with self.assertRaises(ValueError): validate_response('pools',result)

    def test_three_simultaneous_five_read_pages_respect_real_serial_gate_and_bounded_backoff(self):
        # Deterministic synthetic SQL/RPC, actual HTTP/gateway/JWT and one-second gate.
        # This is offline cohort capacity evidence, not a provider/staging throughput claim.
        with history_service() as (reader, _):
            gateway, app=self.pipeline(reader,interval=1)
            barrier=Barrier(3); metrics=[]; lock=Lock(); starts=[]; self.seen_routes=[]
            original=gateway.upstream.request
            def measured(route,*args,**kwargs):
                if route!='health': starts.append(time.monotonic()); self.seen_routes.append(route)
                return original(route,*args,**kwargs)
            gateway.upstream.request=measured
            # Five real historical reads per page; repeated metrics represent separate panels.
            routes=('pool-activity','pool-positions','pool-metrics','pool-activity','pool-metrics')
            def client_page(index):
                retries=0; begin=time.monotonic(); statuses=[]
                with TestClient(app,base_url='http://127.0.0.1:8878',client=('127.0.0.1',100+index)) as client:
                    headers={'Cf-Access-Jwt-Assertion':self.token(),'X-Domino-Client-Id':f'192.0.2.{index+1}'}
                    barrier.wait(timeout=5)
                    for route in routes:
                        for attempt in range(20):
                            response=client.post('/internal/read/v1/'+route,json={'poolId':POOL},headers=headers)
                            if response.status_code==200:
                                validate_response(route,response.json());statuses.append(200);break
                            self.assertEqual(response.status_code,429,response.text)
                            retries+=1
                            self.assertLess(time.monotonic()-begin,40)
                            time.sleep(int(response.headers['Retry-After'])+index*.03)
                        else: self.fail('bounded page retry budget exhausted')
                        time.sleep(1.01)
                with lock: metrics.append({'client':index,'completed':len(statuses),'busyResponses':retries,
                                           'elapsedSeconds':round(time.monotonic()-begin,3)})
            with ThreadPoolExecutor(max_workers=3) as pool: list(pool.map(client_page,range(3)))
            self.assertEqual(len(starts),15)
            # Per-kind start spacing (#157): provider reads keep the one-second
            # serial gate, including pool-metrics' RPC canonicality proof.
            # Stored catalogue/snapshot reads have an independent interval.
            provider_starts=[t for t,route in zip(starts,self.seen_routes) if route not in ('catalogue','markets-snapshot')]
            stored_starts=[t for t,route in zip(starts,self.seen_routes) if route in ('catalogue','markets-snapshot')]
            self.assertTrue(all(b-a>=.95 for a,b in zip(provider_starts,provider_starts[1:])))
            self.assertTrue(all(b-a>=.95 for a,b in zip(stored_starts,stored_starts[1:])))
            self.assertTrue(all(row['completed']==5 for row in metrics))
            self.assertGreater(sum(row['busyResponses'] for row in metrics),0)
            print('READ_COHORT_CAPACITY '+json.dumps(sorted(metrics,key=lambda row:row['client'])))
