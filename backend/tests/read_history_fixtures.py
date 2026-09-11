"""Offline producer fixtures: real ledger reads over deterministic database/RPC rows.

PostgreSQL/RPC transport and the code-owned qualification registry are synthetic.
The reference-only variant also supplies explicit offline currency binding and
reference series; it does not activate the ordinary production price loader.
Response dictionaries are produced by PgActivity, read_positions, stored_metrics,
ReadService, and Gateway; they are never handwritten copies of a response schema.
"""
from contextlib import contextmanager, ExitStack
from copy import deepcopy
from dataclasses import asdict
from unittest.mock import patch

from capital_store import capital_point
from chainlink_reference import _ReferenceQualification, _ReferenceSeries
from catalogue import checked_key
from discovery import Block, DataError, POOL_MANAGER, ZERO
from fee_accounting import replay_fees
from pool_activity import active_liquidity
from position_accounting import replay_positions
from price_history import PriceQualification, SOURCE
from read_service import ReadService
from test_discovery import FakeRpc, POOL, TOKEN
from test_position_accounting import reference


class Rows:
    def __init__(self, rows): self.rows = rows
    def fetchone(self): return deepcopy(self.rows[0]) if self.rows else None
    def fetchall(self): return deepcopy(self.rows)


class HistoryDatabase:
    def __init__(self, *, complete=True, ledgers=True, prices='qualified', capital_failure=None):
        fixture = reference()
        self.events = [item['event'] for item in fixture['sequence']]
        self.points = []
        activity, self.positions, _ = replay_positions(None, None, self.events, POOL,
            checked_key(fixture['poolKey'], POOL),
            observe=lambda event, a, m: self.points.append({**deepcopy(event), 'capital': capital_point(a, m)}))
        _, self.fees, fee_events = replay_fees(None, None, self.events, POOL, checked_key(fixture['poolKey'], POOL))
        self.fee_events = {item['logIndex']: item['fees'] for item in fee_events}
        self.ledgers, self.price_state, self.capital_failure = ledgers, prices, capital_failure
        self.end = 87410 if complete else 1029
        self.snapshot = {'number':700, 'hash':'0x'+'ab'*32, 'timestamp':self.end,
            'sqrtPriceX96':activity['sqrtPriceX96'], 'tick':activity['tick'],
            'activeLiquidityRaw':str(active_liquidity(activity)), 'protocolFeeRaw':activity['protocolFeeRaw'],
            'lpFeePips':fixture['poolKey']['fee_pips'], 'feeGrowthGlobalX128':self.fees['growthX128']}
        self.row = {'pool_id':POOL, 'pool_key':fixture['poolKey'], 'revision':2, 'methodology_version':1,
                    'start_block':10, 'next_block':701}
        self.tail = {'start_block':10, 'end_block':700, 'end_hash':self.snapshot['hash'],
                     'end_timestamp':self.end, 'state_snapshot':self.snapshot, 'model':activity}
        self.proof = {'blockNumber':700, 'blockHash':self.snapshot['hash'],
            'corePositions':len(self.positions['positions']), 'ticks':len(self.positions['ticks']),
            'ranges':len({(p['tickLower'],p['tickUpper']) for p in self.positions['positions'].values()}),
            'sourceFeeMethodology':1}

    @contextmanager
    def connection(self): yield self

    def execute(self, query, params=()):
        q = ' '.join(query.split())
        if q.startswith('SELECT diagnostic FROM domino_activity.historical_work'):
            # No worker row exists in the baseline deterministic fixture.
            return Rows([])
        if q.startswith('SELECT * FROM domino_activity.pools'): return Rows([self.row])
        if q.startswith('SELECT * FROM domino_activity.chunks'): return Rows([self.tail])
        if q.startswith('SELECT * FROM domino_activity.position_chunks'):
            return Rows([{'model':self.positions, 'methodology_version':1, 'reconciliation':self.proof}] if self.ledgers else [])
        if q.startswith('SELECT * FROM domino_activity.fee_chunks'):
            return Rows([{'model':self.fees, 'methodology_version':1}] if self.ledgers else [])
        if 'FROM domino_activity.position_settlements' in q:
            return Rows([{'count':self.positions['modifyCount'], 'f0':self.positions['settledFeesRaw'][0],
                          'f1':self.positions['settledFeesRaw'][1]}])
        if q.startswith('SELECT f.fees FROM'):
            return Rows([{'fees':self.fee_events[e['logIndex']]} for e in self.events
                         if e['kind']=='swap' and params[1]<e['timestamp']<=params[2]])
        if q.startswith('SELECT block_timestamp AS timestamp,kind,payload'):
            return Rows([e for e in self.events if e['kind'] in ('swap','donate') and params[1]<e['timestamp']<=params[2]])
        if q.startswith('SELECT count(*) AS chunks'):
            if self.capital_failure: raise DataError(self.capital_failure)
            return Rows([{'chunks':1, 'qualified':1, 'events':len(self.events), 'min_version':1, 'max_version':1}])
        if q.startswith('SELECT min(start_block)'):
            return Rows([{'first_block':10,'last_block':700,'gaps':0}])
        if q.startswith('SELECT count(*) AS events'):
            return Rows([{'events':len(self.events),'capital':len(self.events)}])
        if q.startswith('SELECT end_capital'):
            return Rows([{'end_capital':self.points[-1]['capital']}])
        if 'SELECT e.block_number AS "blockNumber",e.block_timestamp AS timestamp' in q:
            if 'ORDER BY e.block_number DESC' in q:
                return Rows([p for p in self.points if p['timestamp']<=params[1]][-1:])
            return Rows([{**p,'fees':self.fee_events.get(p['logIndex'])} for p in self.points if params[1]<p['timestamp']<=params[2]])
        if 'SELECT e.block_timestamp AS timestamp,e.block_number AS "blockNumber"' in q:
            return Rows([{**e,'fees':self.fee_events[e['logIndex']]} for e in self.events
                         if e['kind']=='swap' and params[1]<e['timestamp']<=params[2]])
        if 'FROM domino_activity.price_observations' in q:
            if self.price_state=='overflow': raise DataError('price_observation_budget_exhausted')
            if self.price_state=='outage': raise DataError('catalogue_database_unavailable')
            if self.price_state=='missing': return Rows([])
            return Rows([{'chainId':4663,'currency':params[1],'source':SOURCE,'timestamp':t,
                          'retrievedAt':self.end,'priceUsd':'1'}
                         for t in range(max(0, params[3]), params[4]+1, 300)])
        raise AssertionError('Unrecognized fixture query: '+q)


class HistoryRpc(FakeRpc):
    def __init__(self, snapshot, age=10): super().__init__(); self.snapshot_=snapshot; self.age=age
    def request(self, method, params=()):
        if method=='eth_getBlockByNumber':
            if params[0]=='latest':
                return {'number':hex(701),'hash':'0x'+'cd'*32,'timestamp':hex(self.snapshot_['timestamp']+self.age)}
            if params[0]==hex(700):
                return {k:hex(self.snapshot_[k]) if k!='hash' else self.snapshot_[k] for k in ('number','hash','timestamp')}
            if params[0]==hex(701):
                return {'number':hex(701),'hash':'0x'+'cd'*32,'timestamp':hex(self.snapshot_['timestamp']+self.age)}
        if method=='eth_getCode': return '0x6000'
        return super().request(method, params)
    def call(self, target, signature, *args, **kwargs):
        if signature=='poolManager()': return (POOL_MANAGER,)
        return super().call(target, signature, *args, **kwargs)


@contextmanager
def history_service(*, stale=False, qualified=True, reference_only=False, **kwargs):
    database = HistoryDatabase(**kwargs)
    age=300 if stale else 10
    reader=ReadService(catalogue=database, rpc_factory=lambda:HistoryRpc(database.snapshot, age),
                       clock=lambda:database.end+age, transport_factory=lambda:None)
    registry={(POOL,c):PriceQualification(c,18,SOURCE,POOL,'offline_fixture_only') for c in (ZERO,TOKEN)} if qualified else {}
    with ExitStack() as stack:
        stack.enter_context(patch.dict('price_history.PRODUCTION_QUALIFICATIONS',registry,clear=True))
        if reference_only:
            # Exercise the real reference-series time convention and valuation path.
            # Test-only inputs include currency association and reference observations;
            # no real source is admitted to the production registry.
            from price_history import load_price_series
            from capital_store import load_capital_window
            def reference_window(conn, row, tail):
                # Offline reference valuation requires explicit currency association;
                # the ordinary production window intentionally does not enable it.
                window = load_capital_window(conn, row, tail)
                window['currencies'] = tuple(row['pool_key'][f'currency{i}'] for i in (0, 1))
                return window
            stack.enter_context(patch('metrics_service.load_capital_window', side_effect=reference_window))
            def reference_prices(conn, pool_id, currencies, start, end):
                _, evidence = load_price_series(conn, pool_id, currencies, start, end)
                series = []
                for currency, item in zip(currencies, evidence):
                    proof = _ReferenceQualification(currency, 18, pool_id, 'offline_fixture_only',
                                                    start, end, (ZERO, TOKEN))
                    observations = [{'chainId':4663, 'currency':currency, 'source':proof.source,
                        'timestamp':t, 'retrievedAt':end, 'priceUsd':'1',
                        'provenance':{'answerUpdatedAt':t}}
                        for t in range(max(0, start-300), end+1, 300)]
                    series.append(_ReferenceSeries(proof, observations))
                    item['observedSources'] = [proof.source]
                    item['observations'] = len(observations)
                    item['firstTimestamp'] = observations[0]['timestamp']
                    item['lastTimestamp'] = observations[-1]['timestamp']
                    item['coverage']['maxAgeSeconds'] = proof.max_age
                return series, evidence
            stack.enter_context(patch('metrics_service.load_price_series', side_effect=reference_prices))
        yield reader, database


def historical_fixtures():
    result=[]
    for name, options in [('success',{}),('partial',{'complete':False}),('stale',{'stale':True}),
                          ('unavailable',{'ledgers':False})]:
        with history_service(**options) as (reader, _):
            result.append(('pool-activity',name,reader.pool_activity(POOL)))
            result.append(('pool-positions',name,reader.pool_positions(POOL)))
    for name, options in [('qualified',{}),('partial',{'complete':False}),('stale',{'stale':True}),
        ('unqualified',{'qualified':False}),('reference-analytics',{'reference_only':True}),('missing-prices',{'prices':'missing'}),
        ('capital-unavailable',{'ledgers':False}),('capital-capacity',{'capital_failure':'capital_window_budget_exhausted'}),
        ('price-capacity',{'prices':'overflow'})]:
        with history_service(**options) as (reader, _):
            result.append(('pool-metrics',name,reader.pool_metrics(POOL)))
    return result
