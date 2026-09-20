"""Bounded persistent public collectors. Run each lane as its own service.

Current state never waits for historical replay; history never depends on an
open browser. Existing activity, fee, position and capital reducers retain their
canonical checkpoints and accounting policy.
"""
import argparse
from dataclasses import asdict
import json
import signal
import threading
import time

from catalogue import configured_writer_catalogue
from discovery import Block, DataError
from local_config import load_config
from pool_requests import PgRequests, WRITER_ROLE
from public_observations import PgPublicData
from read_deadline import check_read_deadline, read_deadline
from read_service import ReadService
from rpc_config import configured_rpc_urls, configured_history_rpc_url


class PublicCollector:
    def __init__(self, repository, service, *, history=None, requests=None, clock=time.time):
        self.repository,self.service,self.history,self.clock = repository,service,history,clock
        self.requests = requests
        self.service.market_cache.reserve_provider = repository.reserve_provider

    def tick(self, *, token_limit=2, pool_limit=4,max_rpc_calls=256):
        if any(type(value) is not int for value in (token_limit,pool_limit,max_rpc_calls)) or not (
                0<=token_limit<=8 and 0<=pool_limit<=24 and 16<=max_rpc_calls<=2048):
            raise DataError('invalid_collector_budget')
        factory=self.service.transport_factory
        self.rpc_calls=0
        def bounded_factory():
            transport=factory()
            def bounded(url,body=None):
                check_read_deadline()
                count=(len(body) if isinstance(body,list) else 1 if isinstance(body,dict) and 'method' in body else 0)
                if self.rpc_calls+count>max_rpc_calls:raise DataError('public_rpc_budget_exhausted')
                self.rpc_calls+=count
                return transport(url,body) if body is not None else transport(url)
            return bounded
        self.service.transport_factory=bounded_factory
        try:return self._tick(token_limit=token_limit,pool_limit=pool_limit)
        finally:self.service.transport_factory=factory

    def _tick(self, *, token_limit, pool_limit):
        results = []
        # Separate quotas prevent either metadata or popular pools monopolizing
        # the collector. Due order is preserved independently within each class.
        for kind,limit in (('token',token_limit),('pool',pool_limit)):
            for _ in range(limit):
                claims = self.repository.claim(kind)
                if not claims:
                    break
                claim = claims[0]
                try:
                    with read_deadline(12):
                        self.collect(claim)
                    results.append({'kind':kind,'entity':claim['entity_id'],'status':'published'})
                except Exception as error:
                    reason = str(error) if isinstance(error,DataError) else 'collection_failed'
                    delay = min(300,15*2**min(claim['attempts'],4))
                    rejected = reason in ('invalid_pool_key','pool_id_mismatch','missing_contract_code')
                    try:
                        self.repository.fail(claim,reason,delay=86400 if rejected else delay,rejected=rejected)
                    except DataError:
                        pass  # A lost lease must never modify its replacement.
                    results.append({'kind':kind,'entity':claim['entity_id'],'status':'retry',
                                    'reason':reason if reason.replace('_','').isalnum() else 'collection_failed'})
                    if reason=='public_rpc_budget_exhausted':return results
        return results

    def collect(self, claim):
        entity_id = claim['entity_id']
        if claim['kind'] == 'token':
            payload = self.service.token(entity_id)
            if payload['asset']['readStatus'] == 'unavailable':
                raise DataError(payload['asset'].get('reason') or 'upstream_unavailable')
            if payload['asset']['readStatus'] == 'no_contract':
                self.repository.publish(claim,payload,delay=86400)
                return
            observed_at=int(self.clock())
            # Metadata is independently useful. Retain the lease/cursor so an
            # optional discovery failure can schedule a fenced retry without
            # throwing away the already verified address and display units.
            self.repository.publish(claim,payload,observed_at=observed_at,keep_lease=True)
            catalogue = self.repository.catalogue
            try:
                page = catalogue.lookup(entity_id,limit=100,after=claim.get('discovery_after'),
                                        revision=claim.get('discovery_revision'))
            except DataError as error:
                if str(error) != 'catalogue_revision_changed':
                    raise
                page = catalogue.lookup(entity_id,limit=100)
            ids = [item['poolId'] for item in page['items']]
            verified = None
            # A first address absent from the indexed catalogue can still find
            # provider candidates, which DiscoveryReader verifies on this chain.
            # No catalogue result is a proof of universal absence.
            if not ids and claim.get('discovery_after') is None:
                if not self.repository.reserve_provider():raise DataError('provider_capacity_busy')
                verified = self.service.pools(entity_id,max_pools=20)
                if verified['discovery']['status']!='received':raise DataError('public_discovery_unavailable')
                ids = [item['poolId'] for item in verified['pools']]
            if verified and verified['pools']:
                pools = []
                for pool in verified['pools']:
                    key = {k:v for k,v in pool['poolKey'].items() if k != 'feeMode'}
                    pools.append({**pool,'poolKey':key})
                catalogue.seed(pools,Block(**verified['snapshot']),
                               publication_guard=lambda conn:self.repository.guard(conn,claim))
            self.repository.publish(claim,payload,observed_at=observed_at,discovered_pools=ids,
                discovery_after=page['nextAfterPoolId'] if page['hasMore'] else None,
                discovery_revision=page['revision'] if page['hasMore'] else None,
                delay=5 if page['hasMore'] else 300)
        else:
            payload = self.service.pool_market(entity_id)
            # Browser demand is debounced by 15s in PostgreSQL. A minute of
            # grace tolerates that debounce without keeping abandoned tabs hot.
            # Claim order stays oldest-due first for active and idle pools alike.
            active = self.clock() - claim['last_requested_at'].timestamp() <= 60
            self.repository.publish(claim,payload,delay=5 if active else 120)
            if self.requests is not None:
                self.requests.enqueue(entity_id)
            if self.history is not None:
                self.history.request(entity_id,86400)


def accounting_tick(repository,service):
    """One existing ledger step, round-robin by pool and dependency stage."""
    from activity_store import PgActivity
    from fee_store import FeeIndexer
    from position_store import PositionIndexer
    from capital_store import CapitalIndexer
    with repository.connection(write=True) as conn:
        row = conn.execute("""SELECT e.entity_id,e.ledger_stage FROM domino_public.entities e
          WHERE e.kind='pool' AND e.payload IS NOT NULL AND e.ledger_due<=clock_timestamp()
            AND EXISTS(SELECT 1 FROM domino_activity.chunks c WHERE c.pool_id=e.entity_id)
          ORDER BY e.ledger_due,e.entity_id FOR UPDATE SKIP LOCKED LIMIT 1""").fetchone()
        if row is None:
            return {'status':'idle'}
        conn.execute("""UPDATE domino_public.entities SET ledger_due=clock_timestamp()+interval '30 seconds',
          ledger_stage=(ledger_stage+1)%%3 WHERE kind='pool' AND entity_id=%s""",(row['entity_id'],))
    stage = row['ledger_stage']
    try:
        with read_deadline(20):
            rpc = service._rpc(service.transport_factory(),historical=True)
            rpc.max_requests = 180
            indexer = (FeeIndexer,PositionIndexer,CapitalIndexer)[stage](PgActivity(repository.catalogue),rpc)
            result = indexer.step(row['entity_id'])
        error = None
    except DataError as exception:
        error = str(exception)
        result = {'status':'pending','reason':error}
    with repository.connection(write=True) as conn:
        conn.execute("UPDATE domino_public.entities SET ledger_error=%s WHERE kind='pool' AND entity_id=%s",
                     (error,row['entity_id']))
    return {'poolId':row['entity_id'],'stage':('fee','position','capital')[stage],**result}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--lane',choices=('current','history','accounting'),default='current')
    parser.add_argument('--once',action='store_true')
    parser.add_argument('--period',type=float,default=1)
    parser.add_argument('--import-snapshot',help='Private legacy snapshot file; import with original ages before collecting')
    args = parser.parse_args()
    if not 0.2 <= args.period <= 300:
        parser.error('period must be between 0.2 and 300 seconds')
    config = load_config()
    catalogue = configured_writer_catalogue()
    if catalogue is None:
        raise DataError('catalogue_not_configured')
    repository = PgPublicData(catalogue,writer=True)
    service = ReadService(catalogue=catalogue,rpc_urls=configured_rpc_urls(config),
                          historical_rpc_url=configured_history_rpc_url(config))
    if args.import_snapshot:
        from markets_snapshot import MarketsSnapshot
        legacy = MarketsSnapshot(path=args.import_snapshot)
        if not legacy.loaded:
            raise DataError('invalid_snapshot_store')
        source = ReadService(snapshot=legacy)
        imported = 0
        for pool_id,record in legacy.state['pools'].items():
            imported += repository.import_market(source.pool_market(pool_id,from_snapshot=True),record['observedAt'])
        print(json.dumps({'legacySnapshotsImported':imported}),flush=True)
    from public_history import PublicHistory
    history = PublicHistory(catalogue,writer=True)
    collector = PublicCollector(repository,service,history=history,
                                requests=PgRequests(catalogue,role=WRITER_ROLE))
    stopped = threading.Event()
    for signum in (signal.SIGTERM,signal.SIGINT):
        signal.signal(signum,lambda *_:stopped.set())
    while not stopped.is_set():
        opened = time.monotonic()
        try:
            result = (collector.tick() if args.lane=='current' else
                      history.tick(service,budget_seconds=20) if args.lane=='history' else
                      accounting_tick(repository,service))
            print(json.dumps({'lane':args.lane,'durationMs':int((time.monotonic()-opened)*1000),
                              'result':result}),flush=True)
        except Exception as error:
            reason = str(error) if isinstance(error,DataError) else 'collector_failed'
            print(json.dumps({'lane':args.lane,'status':'retry',
                              'reason':reason if reason.replace('_','').isalnum() else 'collector_failed'}),flush=True)
        if args.once:
            break
        stopped.wait(args.period)


if __name__ == '__main__':
    main()
