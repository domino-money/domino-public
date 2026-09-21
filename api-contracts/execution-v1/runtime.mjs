// Closed schema + canonical execution-state validation. No fetch, wallet or financial calculations.
import { SCHEMAS, ERRORS } from './schema-data.mjs';
import { createContractValidators } from '../shared/closed-schema.mjs';

export const CONTRACT_VERSION = '1.0.0-rc.1';
export const ROUTES = Object.freeze(Object.keys(SCHEMAS));
export const ERROR_STATUS_BY_CODE = Object.freeze({ ...ERRORS });

function semantic(name,value) {
  if (name === 'Status') return value.canCancel === ['planned','reserved'].includes(value.state) &&
    (value.receipt !== null) === (value.state === 'reconciled') && (value.signer === null) === (value.nonceRaw === null) &&
    new Set(value.attempts.map(a=>a.ordinal)).size === value.attempts.length && new Set(value.attempts.map(a=>a.transactionHash)).size === value.attempts.length;
  if (name === 'ListResponse') return new Set(value.items.map(i=>i.intentId)).size === value.items.length &&
    value.items.every((item,index)=>index===0 || item.intentId>value.items[index-1].intentId) &&
    (value.nextAfterIntentId === null || value.nextAfterIntentId === value.items.at(-1)?.intentId);
  return true;
}

export const { validateRequest, validateResponse, validateError } =
  createContractValidators(SCHEMAS, ERROR_STATUS_BY_CODE, semantic);
