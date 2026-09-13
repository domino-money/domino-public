"""One bounded, read-only financial-history step over persisted raw evidence.

This worker accepts a trusted journal store and read transport, never plans,
admission flags or successful effects from a browser. It discovers compound plans
from canonical transaction calldata and verifies them independently. No scheduler,
signer, estimate, send method, valuation or public route is introduced.
"""
from copy import deepcopy
from dataclasses import dataclass

from eth_abi import decode, encode
from eth_hash.auto import keccak

import execution_models as m
from general_compound_receipts import (COMPLETED, COMPOUND_SIGNATURE, PLAN_TYPE,
    CompoundAdmission, CompoundPlan, CompoundReceiptReconciler, RuntimePin)
from performance_collection import (Baseline, CollectionError, Cursor, Page,
    PerformanceRpc, ReorgDetected, _bounded)
from performance_financial_collection import FinancialCollector
from performance_store import PerformanceStoreError
from read_deadline import check_read_deadline


@dataclass(frozen=True)
class FinancialHistoryStep:
    outcome: str
    record: dict


class _StepRpc:
    """One budget shared by state capture, all receipt verifiers and rechecks."""
    def __init__(self, rpc, maximum):
        self.rpc, self.maximum, self.count = rpc, maximum, 0
        self.failure = None
        self.receipts, self.transactions = {}, {}

    def bind_receipts(self, receipts):
        for receipt in receipts:
            self.receipts[receipt.transactionHash] = deepcopy(receipt.rawReceipt)
            self.transactions[receipt.transactionHash] = deepcopy(receipt.rawTransaction)

    def request(self, method, params=()):
        if method not in PerformanceRpc.METHODS:
            raise CollectionError('financial_method_not_read_only')
        if self.count >= self.maximum:
            self.failure = 'financial_rpc_budget'
            raise CollectionError(self.failure)
        check_read_deadline()
        self.count += 1
        try:
            result = self.rpc.request(method, list(params))
        except Exception:
            raise CollectionError('financial_read_failed') from None
        check_read_deadline()
        _bounded(result, 2_000_000)
        expected = (self.receipts if method == 'eth_getTransactionReceipt' else
                    self.transactions if method == 'eth_getTransactionByHash' else {})
        if expected and params and params[0] in expected and result != expected[params[0]]:
            self.failure = 'financial_receipt_changed'
            raise CollectionError(self.failure)
        return result


def decode_compound_plan(calldata):
    """Decode only the canonical fixed V3 owner-entry ABI, with exact roundtrip."""
    try:
        if type(calldata) is not str or not calldata.startswith('0x') or len(calldata) != 10+64*len(CompoundPlan.ABI):
            raise ValueError()
        raw = bytes.fromhex(calldata[2:])
        if raw[:4] != keccak(COMPOUND_SIGNATURE.encode())[:4]:
            raise ValueError()
        values, = decode([PLAN_TYPE], raw[4:], strict=True)
        if encode([PLAN_TYPE], [values]) != raw[4:]:
            raise ValueError()
        plan = CompoundPlan(**{name: '0x'+value.hex() if kind == 'bytes32' else str(value)
                               for (name, kind), value in zip(CompoundPlan.ABI, values)})
        if plan.calldata() != calldata.lower(): raise ValueError()
        return plan
    except Exception:
        raise CollectionError('financial_calldata_invalid') from None


def compound_admission(baseline, collector):
    """Build admission from immutable opening pins and getters at that hash."""
    if baseline.opening.implementationVersion != 3:
        raise CollectionError('financial_compound_version_unsupported')
    opening, block = baseline.opening, baseline.baseline
    get = lambda signature, output: collector._get(baseline.vault, signature, output, block)
    try:
        raw_key = get('poolKey()', '(address,address,uint24,int24,address)')
        key = m.PoolKey(currency0=raw_key[0], currency1=raw_key[1], fee_pips=raw_key[2],
                        tick_spacing=raw_key[3], hooks=raw_key[4])
        sequence = m.SequenceIdentity(chainId=4663, owner=baseline.owner,
            sequenceId='0x'+get('sequenceId()', 'bytes32').hex(), vault=baseline.vault,
            factory=opening.factory, implementation=opening.implementation, implementationVersion='3',
            poolManager=opening.poolManager, positionManager=baseline.positionManager,
            poolKey=key, poolId=opening.poolId, baseCurrency=get('baseCurrency()', 'address'),
            quoteCurrency=get('quoteCurrency()', 'address'), serviceFeeRecipient=get('serviceFeeRecipient()', 'address'))
        if sequence.digest() != opening.sequenceIdentity or [key.currency0, key.currency1] != opening.currencies:
            raise ValueError()
        admission = CompoundAdmission(sequence=sequence, stateView=opening.stateView,
            readHelper=get('readHelper()', 'address'), compoundEngine=get('compoundEngine()', 'address'),
            runtimePins=tuple(RuntimePin(address=pin.address, codeHash=pin.codeHash) for pin in opening.codePins))
        return admission
    except CollectionError: raise
    except Exception:
        raise CollectionError('financial_admission_invalid') from None


class FinancialHistoryWorker:
    def __init__(self, rpc, store, *, max_requests=2048):
        if type(max_requests) is not int or not 1 <= max_requests <= 2048:
            raise CollectionError('invalid_financial_rpc_budget')
        self.rpc, self.store, self.max_requests = rpc, store, max_requests

    def advance(self, owner, epoch_id):
        """Capture an opening OR advance one exact persisted raw page."""
        snapshot = self.store.next_financial_page(owner, epoch_id)
        epoch, head = snapshot['epoch'], snapshot['financial']
        baseline = Baseline.model_validate(epoch['baseline'])
        if (baseline.owner, baseline.epochId, epoch['owner'], epoch['epochId']) != (owner, epoch_id, owner, epoch_id):
            raise PerformanceStoreError('performance_invalid_request')
        if epoch['status'] == 'baseline_reorged':
            return FinancialHistoryStep('baseline_reorged', epoch)
        raw_revision, generation = epoch['revision'], epoch['replayGeneration']
        rpc = _StepRpc(self.rpc, self.max_requests)
        collector = FinancialCollector(rpc, max_requests=self.max_requests)
        try:
            if head is None:
                point = collector.capture_point(baseline, baseline.baseline)
                if point.status != 'complete':
                    raise CollectionError('financial_opening_partial')
                # Capture already checks all identities, pins and finality. One
                # final canonical check occurs immediately before the SQL fence.
                collector._finish(baseline, [point.block])
            else:
                if ((head['owner'], head['epochId'], head['replayGeneration']) != (owner, epoch_id, generation)
                        or head['state']['cursor'] != head['cursor']):
                    raise CollectionError('financial_state_invalid')
                cursor = Cursor.model_validate(head['cursor'])
                raw_cursor = Cursor.model_validate(epoch['cursor'])
                if snapshot['page'] is None:
                    if cursor != raw_cursor: raise CollectionError('financial_cursor_gap')
                    return FinancialHistoryStep('caught_up', head)
                page = Page.model_validate(snapshot['page'])
                if (page.fromCursor != cursor or page.throughCursor.blockNumber > raw_cursor.blockNumber):
                    raise CollectionError('financial_cursor_gap')
                financial = collector.capture_points(baseline, page, head['state']['knownTokenIds'])
                rpc.bind_receipts(financial.receipts)
                reports, admission = [], None
                for receipt in financial.receipts:
                    completions = [log for log in receipt.logs if log.address == baseline.vault
                                   and log.topics and log.topics[0] == COMPLETED]
                    if not completions: continue
                    if len(completions) != 1: raise CollectionError('financial_compound_completion_invalid')
                    if admission is None: admission = compound_admission(baseline, collector)
                    plan = decode_compound_plan(receipt.rawTransaction.get('input'))
                    try:
                        result = CompoundReceiptReconciler(rpc).reconcile(plan, admission, receipt.transactionHash)
                    except Exception:
                        raise CollectionError(rpc.failure or 'financial_compound_verification_failed') from None
                    # No caller-produced success or executable model enters SQL.
                    result['collections'] = [credit.model_dump(mode='json') for credit in result['collections']]
                    reports.append(result)
                _bounded(reports, 4_000_000)
                collector._finish(baseline, [page.fromCursor, *page.headers])
        except (CollectionError, ValueError, KeyError, TypeError) as error:
            code = rpc.failure or ('financial_rpc_budget' if isinstance(error, CollectionError)
                and error.code == 'collection_rpc_budget' else 'financial_reorg_detected' if isinstance(error, ReorgDetected) else
                error.code if isinstance(error, CollectionError) and error.code.startswith('financial_') else
                'financial_read_failed')
            if head is None:
                # There is no financial cursor yet; leave the raw journal alone.
                return FinancialHistoryStep('read_failed', {'epoch':epoch, 'financial':None, 'lastError':code})
            return FinancialHistoryStep('read_failed', self.store.record_financial_failure(
                owner, epoch_id, raw_revision, generation, head['revision'], code))
        # A slow/conflicting SQL writer must surface the store's fence error;
        # never replace that newer result with a second attempted failure write.
        if head is None:
            return FinancialHistoryStep('captured', self.store.create_financial_history(
                owner, epoch_id, raw_revision, generation, point))
        return FinancialHistoryStep('advanced', self.store.append_financial_page(
            owner, epoch_id, raw_revision, generation, head['revision'], page, financial, reports))
