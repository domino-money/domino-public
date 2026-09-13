"""Bounded resumable collection for session-enrolled, currently visible subjects."""
from collections import deque
import threading
import time

from discovery import DataError
from performance_collection import CanonicalCollector, CollectionError, PerformanceRpc
from performance_history_worker import FinancialHistoryWorker
from performance_store import PerformanceStoreError
from performance_worker import PerformanceWorker
from read_deadline import check_read_deadline, read_deadline


class ProducerRpc:
    """One process-wide transport budget, including failures and nested verifiers."""
    def __init__(self, rpc, *, maximum=8192, clock=time.monotonic):
        if type(maximum) is not int or not 1 <= maximum <= 32768: raise ValueError('invalid_producer_rpc_budget')
        self.rpc,self.maximum,self.clock = rpc,maximum,clock
        self.calls,self.lock = deque(),threading.Lock()
        self.ready_at = clock()+60

    def request(self, method, params=()):
        if method not in PerformanceRpc.METHODS: raise CollectionError('collection_method_not_read_only')
        check_read_deadline()
        with self.lock:
            now = self.clock()
            while self.calls and self.calls[0] <= now-60: self.calls.popleft()
            if now < self.ready_at or len(self.calls) >= self.maximum:
                raise CollectionError('collection_rpc_budget')
            self.calls.append(now)
        result = self.rpc.request(method,list(params))
        check_read_deadline()
        return result


class PerformanceProducer:
    def __init__(self, rpc, enrollments, raw_store, financial_store, owners, *, page_blocks=4, max_requests=1024):
        if (not isinstance(rpc,ProducerRpc) or not 1 <= len(owners) <= 32 or len(set(owners)) != len(owners)
                or type(max_requests) is not int or not 1 <= max_requests <= 2048):
            raise ValueError('invalid_performance_producer_config')
        self.enrollments,self.raw_store,self.financial_store,self.owners = enrollments,raw_store,financial_store,tuple(owners)
        self.collector = CanonicalCollector(rpc,page_blocks=page_blocks,max_requests=max_requests)
        self.raw = PerformanceWorker(self.collector,raw_store)
        self.financial = FinancialHistoryWorker(rpc,financial_store,max_requests=max_requests)
        self.rpc,self.index = rpc,0

    def tick(self):
        """One owner queue check, at most one raw and one financial step. No catch-up loop."""
        if self.rpc.clock() < self.rpc.ready_at: return 'cooldown'
        owner = self.owners[self.index % len(self.owners)]
        self.index += 1
        with read_deadline(2): job = self.enrollments.claim(owner)
        if job is None: return 'idle'
        outcome = 'failed'
        try:
            raw_outcome = 'advanced'
            with read_deadline(15):
                if job['epoch_id'] is None:
                    baseline = self.collector.capture(owner,job['vault'],job['token_ids'],job['vault_code_hash'])
                    record = self.enrollments.bind_baseline(owner,job,baseline)
                    epoch = record['epochId']
                else:
                    epoch = job['epoch_id']
                    pending = self.financial_store.next_financial_page(owner,epoch)
                    if pending['epoch']['status']=='baseline_reorged': outcome='blocked'
                    # A committed raw page survives exhausted financial budget.
                    # Drain that exact durable page first, avoiding starvation
                    # from repeatedly spending the next budget on raw progress.
                    elif pending['financial'] is not None and (pending['page'] is None or
                            pending['financial'].get('lastError')=='financial_reorg_detected'):
                        # A stale pending page must not prevent the raw worker
                        # from confirming a reorg and fencing a new generation.
                        step = self.raw.advance(owner,epoch)
                        raw_outcome = step.outcome
                        if step.outcome == 'baseline_reorged': outcome='blocked'
                        elif step.outcome == 'read_failed': raise CollectionError('collection_read_failed')
            if outcome != 'blocked':
                with read_deadline(15):
                    step = self.financial.advance(owner,epoch)
                    outcome = ('failed' if step.outcome=='read_failed' else
                               'caught_up' if step.outcome==raw_outcome=='caught_up' else 'advanced')
        except PerformanceStoreError as error:
            outcome = 'blocked' if error.code=='performance_epoch_blocked' else 'failed'
        except (CollectionError,DataError,ValueError):
            outcome = 'failed'
        # Never record provider error text, sessions, tokens or raw evidence in the queue.
        with read_deadline(2): self.enrollments.finish(owner,job,outcome)
        return outcome

    def run(self, stop):
        while not stop.is_set():
            try: self.tick()
            except (PerformanceStoreError,DataError): pass
            stop.wait(1)
