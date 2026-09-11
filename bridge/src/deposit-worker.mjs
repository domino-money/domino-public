import { fail } from './worker.mjs';
import { createAuthenticatedWorker } from './authenticated-worker.mjs';
import * as runtime from '../../api-contracts/deposit-v1/runtime.mjs';

export const DEPOSIT_LIMITS = Object.freeze({ requestBytes: 8192, responseBytes: 256 * 1024,
  cookiesBytes: 8192, bodyMs: 5000, totalMs: 25000, upstreamMs: 20000 });

function equal(left, right) {
  if (left !== null && right !== null && typeof left === 'object' && typeof right === 'object') {
    const keys = Object.keys(left);
    return keys.length === Object.keys(right).length && keys.every(key => Object.hasOwn(right, key) && equal(left[key], right[key]));
  }
  return left === right;
}

function associated(route, body, response) {
  if (route === 'list') {
    const rows = response.operations;
    return rows.length <= (body.limit ?? 20) && new Set(rows.map(row => row.id)).size === rows.length &&
      rows.every(row => row.owner === rows[0].owner && row.id !== body.before);
  }
  const op = response.operation;
  if (route === 'create') return op.idempotencyKey === body.idempotencyKey && equal(op.selection, body.selection);
  return op.id === body.intentId && (body.version === undefined || op.version >= body.version && op.version <= body.version + 2);
}

export function createDepositWorker(options = {}) {
  return createAuthenticatedWorker({...runtime, PREFIX: '/api/deposit/v1/',
    HEADER: 'X-Domino-Deposit-Contract', envPrefix: 'DEPOSIT', internalPrefix: '/internal/deposit/v1/',
    limits: DEPOSIT_LIMITS, associated,
    assertFresh: data => {
      const step = data.walletStep;
      if (!step) return;
      const now = Date.now() / 1000;
      if (step.expiresAt <= now) fail('deposit_artifact_expired');
      if (step.expiresAt > now + 30 || step.sourceBlock.timestamp > now + 15) fail('upstream_contract_mismatch');
    },
  }, options);
}

export default createDepositWorker();
