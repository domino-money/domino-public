// Closed schema + collection-state validation. No fetch, wallet or financial calculations.
import { SCHEMAS, ERRORS } from './schema-data.mjs';
import { createContractValidators } from '../shared/closed-schema.mjs';

export const CONTRACT_VERSION = '2.0.0-rc.1';
export const ROUTES = Object.freeze(Object.keys(SCHEMAS));
export const ERROR_STATUS_BY_CODE = Object.freeze({ ...ERRORS });

function semantic(name, value) {
  if (name === 'ObservationCounts') return (value.pages !== 0 || value.receipts === 0 && value.events === 0) && (value.receipts !== 0 || value.events === 0);
  if (name === 'EnrollRequest') return new Set(value.tokenIds).size === value.tokenIds.length;
  if (name === 'Enrollment') return ({awaiting_baseline:'queued',forward_collection:'tracking',collection_failed:'stale',baseline_reorged:'blocked'})[value.reason] === value.status && (value.status !== 'tracking' || value.epochId !== null);
  if (name === 'FinancialCoverage') return value.windowEnd >= value.windowStart && value.observedSeconds === value.windowEnd-value.windowStart && value.snapshot.timestamp === value.windowEnd;
  if (name === 'TrackedCard' || name === 'MissingCard') {
    const apr = [value.metrics.grossFeeAprPercent,value.metrics.netFeeAprPercent];
    if ((!value.complete24h || value.performanceStatus !== 'available') && apr.some(x => x !== null)) return false;
    if (value.performanceStatus === 'unavailable' && Object.values(value.metrics).some(x => x !== null)) return false;
    if (name === 'TrackedCard' && (value.snapshot.timestamp < value.baseline.timestamp || value.snapshot.blockNumber < value.baseline.blockNumber || value.observedSeconds !== value.snapshot.timestamp-value.baseline.timestamp || value.financial.snapshot.blockNumber > value.snapshot.blockNumber || value.financial.windowStart < value.baseline.timestamp || value.complete24h && value.financial.observedSeconds !== 86400)) return false;
  }
  if (name === 'TrackedCard') {
    const states={forward_observations_only:'measuring',latest_read_failed:'stale',snapshot_stale:'stale',canonical_replay_required:'partial',baseline_reorged:'unavailable'};
    if (states[value.collectionReason] !== value.collectionStatus || value.collectionReason === 'forward_observations_only' && value.snapshotAgeSeconds > 120 || value.collectionReason === 'snapshot_stale' && value.snapshotAgeSeconds <= 120 || value.snapshot.blockNumber === value.baseline.blockNumber && (value.snapshot.blockHash !== value.baseline.blockHash || value.snapshot.timestamp !== value.baseline.timestamp)) return false;
  }
  if (name === 'CardsResponse') return new Set(value.cards.map(card => card.epochId)).size === value.cards.length;
  return true;
}

export const { validateRequest, validateResponse, validateError } =
  createContractValidators(SCHEMAS, ERROR_STATUS_BY_CODE, semantic);
