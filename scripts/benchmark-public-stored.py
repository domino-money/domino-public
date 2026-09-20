#!/usr/bin/env python3
"""Bounded ASGI + real task-local PostgreSQL qualification using synthetic data.

Only database domino_public_benchmark_tests is created/reset. No external RPC,
Cloudflare, runtime configuration, service restart or production data is used.
Run with the backend API dependencies and existing private dev_postgres running.
"""
import argparse
import asyncio
from collections import Counter
from datetime import datetime, timezone
import json
import math
from pathlib import Path
import statistics
import sys
import threading
import time

ROOT=Path(__file__).resolve().parents[1]
sys.path[:0]=[str(ROOT/'backend'),str(ROOT/'backend/tests')]
import httpx
import psycopg
from psycopg import sql
from psycopg.types.json import Jsonb
from catalogue import PgCatalogue
from dev_postgres import ADMIN,PORT,SOCKET
from discovery import Block
from public_data_contract import validate_request_response
from public_data_service import PublicDataService
from public_history import PublicHistory
from public_observations import PgPublicData
from read_api import ReadGate,create_app
from read_service import ReadService
from test_catalogue import block_hash,stored_candidate
from test_discovery import FakeRpc,KEY,TOKEN,ZERO
from test_public_observations import fixtures,another_market

DATABASE='domino_public_benchmark_tests'
SETTINGS={'host':str(SOCKET),'port':PORT,'dbname':DATABASE}
MIGRATIONS=('001_catalogue.sql','002_activity.sql','020_pool_requests.sql',
            '023_pool_request_scheduling.sql','024_public_observations.sql','025_public_history.sql')


def describe(values):
    values=sorted(values)
    return {'n':len(values),'p50Ms':round(statistics.median(values),3),
            'p95Ms':round(values[max(0,math.ceil(len(values)*.95)-1)],3),
            'maxMs':round(max(values),3),'sumMs':round(sum(values),3)} if values else {'n':0}


def prepare():
    with psycopg.connect(host=str(SOCKET),port=PORT,dbname='postgres',user=ADMIN,autocommit=True) as conn:
        if not conn.execute('SELECT 1 FROM pg_database WHERE datname=%s',(DATABASE,)).fetchone():
            conn.execute(sql.SQL('CREATE DATABASE {}').format(sql.Identifier(DATABASE)))
    with psycopg.connect(**SETTINGS,user=ADMIN) as conn:
        for name in MIGRATIONS:conn.execute((ROOT/'backend/migrations'/name).read_text())
        conn.execute('TRUNCATE domino_public.entities,domino_public.token_pools,domino_public.provider_requests,domino_public.history_jobs,domino_public.history_coverage,domino_public.history_swaps,domino_public.history_candles')
        conn.execute('UPDATE domino_public.state SET revision=1')
    token,market=fixtures()
    end=int(time.time())//3600*3600
    tokens=[ReadService(rpc_factory=FakeRpc,clock=lambda:1010).token(currency) for currency in KEY[:2]]
    markets=[another_market(market,index) for index in range(32)]
    catalogue=PgCatalogue(SETTINGS)
    catalogue.seed([stored_candidate((*KEY[:2],500+index,*KEY[3:])) for index in range(32)],Block(9,block_hash(9),1009))
    with psycopg.connect(**SETTINGS,user=ADMIN) as conn:
        for data in tokens:
            conn.execute("INSERT INTO domino_public.entities(kind,entity_id,payload,observed_at,status) VALUES('token',%s,%s,%s,'ready')",
                         (data['asset']['address'],Jsonb(data),end))
        for data in markets:
            conn.execute("INSERT INTO domino_public.entities(kind,entity_id,payload,observed_at,status) VALUES('pool',%s,%s,%s,'ready')",(data['poolId'],Jsonb(data),end))
            for currency in KEY[:2]:conn.execute('INSERT INTO domino_public.token_pools(token,pool_id) VALUES(%s,%s)',(currency,data['poolId']))
        pool=markets[0]['poolId'];start=end-86400
        conn.execute('INSERT INTO domino_public.history_coverage(pool_id,start_block,end_block,before_timestamp,end_timestamp,end_hash,checked_at,denomination) VALUES(%s,1,100,%s,%s,%s,%s,%s)',
                     (pool,start,end,block_hash(100),end,Jsonb({'currencies':list(KEY[:2]),'decimals':[18,18]})))
        for index in range(24):
            value=str(100+index)
            conn.execute('''INSERT INTO domino_public.history_candles(pool_id,currency,quote_currency,resolution_seconds,start_timestamp,open,high,low,close,swap_count,first_block,first_log,last_block,last_log)
                VALUES(%s,%s,%s,3600,%s,%s,%s,%s,%s,1,%s,0,%s,0)''',
                (pool,ZERO,TOKEN,start+3600*index,value,value,value,value,index+1,index+1))
    return catalogue,markets,end


async def qualify():
    opened=time.monotonic();catalogue,markets,now=prepare()
    measurements=[];admissions=[];lock=threading.Lock();original=psycopg.connect
    def timed_connect(*args,**kwargs):
        began=time.monotonic();result=original(*args,**kwargs)
        with lock:measurements.append((time.monotonic()-began)*1000)
        return result
    psycopg.connect=timed_connect
    rpc_calls=[]
    def no_rpc(*args,**kwargs):rpc_calls.append('unexpected');raise AssertionError('RPC is forbidden in stored qualification')
    class MeasuredRepository(PgPublicData):
        def request(self,kind,entity_id):
            began=time.monotonic()
            try:return super().request(kind,entity_id)
            finally:
                with lock:admissions.append((time.monotonic()-began)*1000)
        def request_many(self,kind,entity_ids):
            began=time.monotonic()
            try:return super().request_many(kind,entity_ids)
            finally:
                with lock:admissions.append((time.monotonic()-began)*1000)
    public=PublicDataService(MeasuredRepository(catalogue),clock=lambda:now,
                             history_store=PublicHistory(catalogue,clock=lambda:now))
    service=ReadService(catalogue=catalogue,public_data=public,rpc_factory=no_rpc,transport_factory=no_rpc)
    gate=ReadGate(stored_capacity=4,stored_interval=0)
    app=create_app(service,gate=gate,read_budget_seconds=15,snapshot_refresh_seconds=0)
    cases=[];raw=[]
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),base_url='http://127.0.0.1:8876') as client:
        async def post(route,body):
            began=time.monotonic();response=await client.post('/v3/read/'+route,json=body)
            row={'status':response.status_code,'durationMs':round((time.monotonic()-began)*1000,3)}
            if response.status_code==200:validate_request_response(route,body,response.json())
            else:row['errorCode']=response.json().get('error')
            if response.status_code==429:row['retryAfterSeconds']=int(response.headers['retry-after'])
            return response,row
        bodies={'overview_six':('overview',{'poolIds':[m['poolId'] for m in markets[:6]]}),
                'overview_twenty_four':('overview',{'poolIds':[m['poolId'] for m in markets[:24]]}),
                'history_stored':('history',{'poolId':markets[0]['poolId'],'currency':ZERO,'windowSeconds':86400,'resolutionSeconds':3600}),
                'search_stored':('search',{'query':token_symbol(catalogue)})}
        for name,(route,body) in bodies.items():
            start=len(measurements);admission_start=len(admissions);began=time.monotonic();rows=[]
            for _ in range(20 if name!='overview_twenty_four' else 8):
                response,row=await post(route,body);rows.append(row)
                if response.status_code!=200:raise RuntimeError(f'{name}: HTTP {response.status_code}, {row.get("errorCode")}')
            connects=measurements[start:];demand=admissions[admission_start:]
            cases.append({'case':name,'latency':describe([r['durationMs'] for r in rows]),'statuses':dict(Counter(str(r['status']) for r in rows)),
                          'elapsedMs':round((time.monotonic()-began)*1000,3),'databaseConnections':len(connects),
                          'connectionsPerRequest':len(connects)/len(rows),'connectionOpening':describe(connects),
                          'demandAdmission':describe(demand),'admissionShareOfSequentialDurationPercent':round(sum(demand)/sum(r['durationMs'] for r in rows)*100,2)})
            raw.append({'case':name,'attempts':rows})
        first,first_row=await post('overview',{'token':TOKEN,'limit':24})
        page=first.json();second,second_row=await post('overview',{'token':TOKEN,'limit':24,'afterPoolId':page['nextAfterPoolId'],'revision':page['revision']})
        ids=[p['poolId'] for p in page['pools']+second.json()['pools']]
        pagination={'pages':[len(page['pools']),len(second.json()['pools'])],'uniquePools':len(set(ids)),
                    'complete32':len(ids)==len(set(ids))==32,'revisionStable':page['revision']==second.json()['revision'],'attempts':[first_row,second_row]}
        assert pagination['complete32'] and pagination['revisionStable']
        began=time.monotonic()
        async def visitor(index):
            visitor_start=time.monotonic();attempts=[]
            for attempt in range(4):
                response,row=await post(*bodies['overview_six']);attempts.append(row)
                if response.status_code!=429:break
                if attempt<3:await asyncio.sleep(min(10,row['retryAfterSeconds'])+index*.01)
            return {'client':index+1,'finalStatus':response.status_code,'attempts':attempts,
                    'completionMs':round((time.monotonic()-visitor_start)*1000,3)}
        visitors=await asyncio.gather(*(visitor(index) for index in range(10)))
        concurrent={'clients':10,'maxAttemptsPerClient':4,'elapsedMs':round((time.monotonic()-began)*1000,3),
                    'completed':sum(v['finalStatus']==200 for v in visitors),'refusals':sum(a['status']==429 for v in visitors for a in v['attempts']),
                    'errors':sum(a['status']not in(200,429) for v in visitors for a in v['attempts']),
                    'attemptLatency':describe([a['durationMs'] for v in visitors for a in v['attempts']]),
                    'completionLatency':describe([v['completionMs'] for v in visitors]),'visitors':visitors}
    psycopg.connect=original
    return {'generatedAt':datetime.now(timezone.utc).isoformat(),'scope':'local ASGI reader + real isolated PostgreSQL, synthetic fixtures',
            'productionTouched':False,'externalNetworkUsed':False,'database':DATABASE,'syntheticPools':32,'syntheticTokens':2,
            'storedCapacity':4,'storedStartIntervalSeconds':0,'databaseCacheFlushed':False,
            'fixtureLoadBeforeMeasurement':True,'p95Estimator':'nearest rank',
            'rpcCalls':len(rpc_calls),'cases':cases,'pagination':pagination,
            'tenConcurrentClients':concurrent,'rawSequential':raw,'totalElapsedMs':round((time.monotonic()-opened)*1000,3),
            'limitations':['In-process ASGI, no TCP/TLS/Cloudflare/Access/gateway or browser cost.','Synthetic stored observations; not evidence of fresh live data or public latency.','One local run; existing host activity and database cache influence results.','Connection-opening totals measure psycopg.connect only; not full SQL time.','Client retries honor reader Retry-After with deterministic per-client staggering; not a production workload.']}


def token_symbol(catalogue):
    return PgPublicData(catalogue).get('token',TOKEN)['payload']['asset']['symbol']


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output',type=Path,default=ROOT/'reports/public-stored-local-qualification-2026-09-20.json')
    args=parser.parse_args()
    result=asyncio.run(asyncio.wait_for(qualify(),timeout=240))
    args.output.parent.mkdir(parents=True,exist_ok=True);args.output.write_text(json.dumps(result,indent=2)+'\n')
    print(json.dumps({key:value for key,value in result.items() if key not in ('rawSequential','tenConcurrentClients')},indent=2))
    print(json.dumps({key:value for key,value in result['tenConcurrentClients'].items() if key!='visitors'},indent=2))


if __name__=='__main__':main()
