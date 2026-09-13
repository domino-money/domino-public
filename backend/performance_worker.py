"""One bounded internal collection step; no scheduler, signer or public route.

Deployment admission selects the collector's subjects and code hash. Neither
this worker nor a persisted raw observation authorizes execution or live APR.
RPC acquisition runs outside the database transaction. The store's revision
fence prevents a slow reader from replacing a newer page or reorg decision.
"""
from dataclasses import dataclass

from performance_collection import Baseline, Cursor, CollectionError, ReorgDetected
from performance_store import PerformanceStoreError


@dataclass(frozen=True)
class CollectionStep:
    outcome: str
    record: dict


class PerformanceWorker:
    def __init__(self, collector, store):
        self.collector, self.store = collector, store

    def capture(self, owner, vault, token_ids, expected_vault_code_hash):
        """Capture one finalized opening, preserving preexisting assets as opening."""
        baseline = self.collector.capture(owner, vault, token_ids, expected_vault_code_hash)
        return CollectionStep('captured', self.store.create_epoch(baseline))

    def advance(self, owner, epoch_id):
        """Acquire at most one page; caller explicitly schedules any next step."""
        record = self.store.read_epoch(owner, epoch_id)
        if record['status'] == 'baseline_reorged':
            return CollectionStep('baseline_reorged', record)
        baseline = Baseline.model_validate(record['baseline'])
        cursor = Cursor.model_validate(record['cursor'])
        if baseline.owner != owner or baseline.epochId != epoch_id:
            raise PerformanceStoreError('performance_invalid_request')
        revision = record['revision']
        try:
            page = self.collector.collect(baseline, cursor)
        except ReorgDetected as error:
            # A fresh baseline header is required to distinguish replay from a
            # permanently invalid opening. Never substitute a cached header.
            if error.observed_baseline is None:
                return CollectionStep('read_failed', self.store.record_failure(
                    owner, epoch_id, revision, 'collection_reorg_unconfirmed'))
            updated = self.store.invalidate_reorg(owner, epoch_id, revision, error.observed_baseline)
            return CollectionStep(updated['status'], updated)
        except CollectionError:
            # Do not persist arbitrary RPC exception text, URLs or provider data.
            return CollectionStep('read_failed', self.store.record_failure(
                owner, epoch_id, revision, 'collection_read_failed'))
        if page is None:
            # No cursor/measurement reset and no claimed new coverage. A prior
            # failure stays visible until a new canonical page is committed.
            return CollectionStep('caught_up', record)
        return CollectionStep('advanced', self.store.append_page(owner, epoch_id, revision, page))
