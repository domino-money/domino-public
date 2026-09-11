// Closed contract and narrow ABI re-encoding. No LP formulas or broadcast.
import { SCHEMAS, ERRORS } from './schema-data.mjs';
export const CONTRACT_VERSION = '1.1.0-rc.2';
export const ROUTES = Object.freeze(Object.keys(SCHEMAS));
export const ERROR_STATUS_BY_CODE = Object.freeze({...ERRORS});
const UINT256_MAX = (1n << 256n) - 1n;
const rawPattern = '^(0|[1-9][0-9]{0,77})$';
const positiveRawPattern = '^[1-9][0-9]{0,77}$';
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value) &&
  [Object.prototype, null].includes(Object.getPrototypeOf(value));
const ZERO = '0x' + '0'.repeat(40);
const PM = '0x58daec3116aae6d93017baaea7749052e8a04fa7';
const PERMIT2 = '0x000000000022d473030f116ddee9f6b43ac78ba3';
const alias = '0x' + '0'.repeat(39) + '1';
const boolFalse = value => value === false;
function validate(schema, value, root, depth = 0) {
  if (depth > 32) return false;
  if (schema.$ref) {
    const name = schema.$ref.split('/').at(-1);
    return validate(root.$defs[name], value, root, depth + 1) && semantic(name, value);
  }
  if (schema.anyOf) return schema.anyOf.some((option) => validate(option, value, root, depth + 1));
  if (Object.hasOwn(schema, 'const') && value !== schema.const) return false;
  if (schema.enum && !schema.enum.includes(value)) return false;
  if (schema.type === 'null') return value === null;
  if (schema.type === 'boolean') return typeof value === 'boolean';
  if (schema.type === 'integer') return Number.isSafeInteger(value) && !Object.is(value, -0) &&
    (schema.minimum === undefined || value >= schema.minimum) && (schema.maximum === undefined || value <= schema.maximum);
  if (schema.type === 'string') {
    if (typeof value !== 'string' || (schema.minLength !== undefined && value.length < schema.minLength) ||
        (schema.maxLength !== undefined && value.length > schema.maxLength)) return false;
    if (schema.pattern) {
      const match = value.match(new RegExp(schema.pattern, 'u'));
      if (!match || match[0] !== value) return false;
    }
    if ([rawPattern, positiveRawPattern].includes(schema.pattern) && BigInt(value) > UINT256_MAX) return false;
    if (schema['x-maximum-raw'] && BigInt(value) > BigInt(schema['x-maximum-raw'])) return false;
    const fraction = value.split('.')[1] || '';
    return true;
  }
  if (schema.type === 'array') return Array.isArray(value) &&
    (schema.minItems === undefined || value.length >= schema.minItems) &&
    (schema.maxItems === undefined || value.length <= schema.maxItems) &&
    value.every((item) => validate(schema.items, item, root, depth + 1));
  if (schema.type === 'object') {
    if (!object(value)) return false;
    const keys = Object.keys(value), properties = schema.properties;
    return keys.every((key) => Object.hasOwn(properties, key)) &&
      (schema.required || []).every((key) => Object.hasOwn(value, key)) &&
      keys.every((key) => validate(properties[key], value[key], root, depth + 1));
  }
  return false;
}

const word = value => BigInt.asUintN(256, BigInt(value)).toString(16).padStart(64, '0');
const addr = value => value.slice(2).padStart(64, '0');
const bytes = hex => word(hex.length / 2) + hex.padEnd(Math.ceil(hex.length / 64) * 64, '0');
function bytesArray(values) {
  const tails = values.map(bytes);
  let offset = values.length * 32;
  const offsets = tails.map(tail => { const out = word(offset); offset += tail.length / 2; return out; });
  return word(values.length) + offsets.join('') + tails.join('');
}
function mintData(selection, owner, artifact, refund) {
  const k = selection.poolKey, m = artifact.mintedBounds;
  const params = [addr(k.currency0) + addr(k.currency1) + word(k.fee_pips) + word(k.tick_spacing) + addr(k.hooks) +
    word(selection.tickLower) + word(selection.tickUpper) + word(m.mintLiquidityRaw) +
    word(m.amount0MaxRaw) + word(m.amount1MaxRaw) + addr(owner) + word(384) + word(0),
    addr(k.currency0) + addr(k.currency1)];
  let actions = '020d';
  if (k.currency0 === ZERO) { actions += '14'; params.push(addr(ZERO) + addr(refund)); }
  const encodedActions = bytes(actions);
  const unlock = word(64) + word(64 + encodedActions.length / 2) + encodedActions + bytesArray(params);
  return '0xdd46508f' + word(64) + word(artifact.preparedDeadline) + bytes(unlock);
}

export function validateWalletStep(selection, owner, artifact) {
  try {
    const root = SCHEMAS.prepare.response;
    if (!validate(root.$defs.DepositSelection, selection, root) || !semantic('DepositSelection', selection) ||
        !validate(root.$defs.PreparedArtifact, artifact, root) || !semantic('PreparedArtifact', artifact) ||
        !/^0x[0-9a-f]{40}$/u.test(owner) || [ZERO, alias, '0x' + '0'.repeat(39) + '2'].includes(owner)) return false;
    const tx = artifact.transaction, caps = artifact.mintedBounds;
    const currencies = [selection.poolKey.currency0, selection.poolKey.currency1];
    if (tx.from !== owner || BigInt(tx.gasLimitRaw) > BigInt(selection.maxGasLimitRaw) ||
        BigInt(tx.maxFeePerGasRaw) > BigInt(selection.maxFeePerGasRaw) ||
        BigInt(tx.maxPriorityFeePerGasRaw) > BigInt(selection.maxPriorityFeePerGasRaw) ||
        [0, 1].some(i => BigInt(caps[`amount${i}MaxRaw`]) > BigInt(selection[`budget${i}Raw`]))) return false;
    const nativeValue = currencies[0] === ZERO ? caps.amount0MaxRaw : '0';
    if (caps.nativeValueRaw !== nativeValue) return false;
    if (artifact.kind === 'mint') return tx.to === PM && tx.valueRaw === nativeValue &&
      [owner, alias].some(refund => tx.data === mintData(selection, owner, artifact, refund));
    if (tx.valueRaw !== '0') return false;
    if (artifact.kind === 'permit2_approval') return tx.to === PERMIT2 && currencies.some((currency, i) =>
      currency !== ZERO && caps[`amount${i}MaxRaw`] !== '0' && tx.data === '0x87517c45' +
      addr(currency) + addr(PM) + word(caps[`amount${i}MaxRaw`]) + word(artifact.preparedDeadline));
    const index = currencies.indexOf(tx.to);
    return index >= 0 && tx.to !== ZERO && tx.data === '0x095ea7b3' + addr(PERMIT2) +
      word(artifact.kind === 'erc20_reset' ? '0' : caps[`amount${index}MaxRaw`]) &&
      (artifact.kind === 'erc20_reset' || caps[`amount${index}MaxRaw`] !== '0');
  } catch { return false; }
}

function stepPolicy(step, selection, state) {
  if (step.reportedEffectConflicts.length && !['attention', 'cancel_requested'].includes(state)) return false;
  const observed = step.receipt?.transaction;
  if (observed) {
    const exceeded = [['gasLimit', 'gasLimitRaw', 'maxGasLimitRaw'],
      ['maxFeePerGas', 'maxFeePerGasRaw', 'maxFeePerGasRaw'],
      ['maxPriorityFeePerGas', 'maxPriorityFeePerGasRaw', 'maxPriorityFeePerGasRaw']]
      .filter(([, actual, cap]) => BigInt(observed[actual]) > BigInt(selection[cap])).map(([name]) => name);
    if (JSON.stringify(observed.selectedLimitsExceeded) !== JSON.stringify(exceeded)) return false;
  }
  return true;
}

function semantic(name, value) {
  if (name === 'PoolKeyModel') return value.currency0 < value.currency1;
  if (name === 'DepositSelection') {
    const k = value.poolKey, i = [k.currency0, k.currency1].indexOf(value.independentToken);
    return i >= 0 && value.tickLower < value.tickUpper && value.tickLower % k.tick_spacing === 0 &&
      value.tickUpper % k.tick_spacing === 0 && BigInt(value.amountRaw) <= BigInt(value[`budget${i}Raw`]) &&
      BigInt(value.maxGasLimitRaw) >= 21000n && BigInt(value.maxGasLimitRaw) <= 3000000n &&
      BigInt(value.maxPriorityFeePerGasRaw) <= BigInt(value.maxFeePerGasRaw) && BigInt(value.maxFeePerGasRaw) < (1n << 128n);
  }
  if (name === 'WalletTransaction') return ![ZERO, alias, '0x' + '0'.repeat(39) + '2'].includes(value.from) &&
    value.to !== ZERO && BigInt(value.gasLimitRaw) >= 21000n && BigInt(value.gasLimitRaw) <= 3000000n &&
    BigInt(value.maxPriorityFeePerGasRaw) <= BigInt(value.maxFeePerGasRaw);
  if (name === 'PreparedArtifact') return value.expiresAt < value.preparedDeadline &&
    value.expiresAt <= value.sourceBlock.timestamp + 60 &&
    value.preparedDeadline <= value.sourceBlock.timestamp + (value.kind === 'permit2_approval' ? 3650 : 170) &&
    value.expiresAt >= value.sourceBlock.timestamp && value.simulation.blockNumber === value.sourceBlock.number &&
    value.simulation.blockHash === value.sourceBlock.hash &&
    BigInt(value.simulation.estimatedGasRaw) <= BigInt(value.transaction.gasLimitRaw) &&
    (value.kind !== 'mint' || value.transaction.to === PM);
  if (name === 'ReceiptPosition') return (value.currentOwner === null) === (value.currentOwnerStatus === 'unavailable') &&
    value.tickLower < value.tickUpper;
  if (name === 'ObservedTransaction') return BigInt(value.gasLimitRaw) >= 21000n &&
    BigInt(value.maxPriorityFeePerGasRaw) <= BigInt(value.maxFeePerGasRaw) &&
    new Set(value.selectedLimitsExceeded).size === value.selectedLimitsExceeded.length;
  if (name === 'ReceiptSummary') return BigInt(value.executionFeeRaw) === BigInt(value.gasUsedRaw) * BigInt(value.effectiveGasPriceRaw) &&
    value.totalFeeRaw === (value.l1FeeRaw === null ? null : String(BigInt(value.executionFeeRaw) + BigInt(value.l1FeeRaw))) &&
    (value.outcome !== 'reverted' || value.position === null) &&
    (value.transaction === null || BigInt(value.gasUsedRaw) <= BigInt(value.transaction.gasLimitRaw) &&
      BigInt(value.effectiveGasPriceRaw) <= BigInt(value.transaction.maxFeePerGasRaw));
  if (name === 'StepSummary') return value.reportedEffectConflicts.every(item => item.nonceRaw !== value.nonceRaw) &&
    new Set(value.reportedEffectConflicts.map(item => item.transactionHash)).size === value.reportedEffectConflicts.length &&
    (value.receipt?.transaction == null || value.receipt.transaction.nonceRaw === value.nonceRaw);
  if (name === 'Operation') return ![ZERO, alias, '0x' + '0'.repeat(39) + '2'].includes(value.owner) &&
    value.createdAt <= value.updatedAt && value.history.every((entry, i) => entry.step === i + 1 &&
      stepPolicy(entry, value.selection, value.state) &&
      (entry.receipt === null || entry.receipt.transactionHash === entry.transactionHash &&
       (entry.receipt.position === null || entry.receipt.position.recipient === value.owner &&
        entry.receipt.position.poolId === value.selection.poolId &&
        entry.receipt.position.tickLower === value.selection.tickLower && entry.receipt.position.tickUpper === value.selection.tickUpper))) &&
    (!value.outstanding || value.history.length > 0 && !['draft', 'confirmed', 'reverted', 'cancelled', 'superseded'].includes(value.state)) &&
    (value.state !== 'superseded' || !value.outstanding && value.history.length > 0 &&
      value.history.at(-1).reconciliationState === 'mismatched' && value.history.at(-1).receipt?.finality === 'finalized' &&
      value.history.at(-1).receipt.position === null);
  if (name === 'AllowanceObservation') return value.currency !== ZERO &&
    (value.erc20AllowanceRaw === null) === (value.erc20Status === 'unavailable') &&
    (value.permit2AllowanceRaw === null) === (value.permit2Status === 'unavailable') &&
    (value.permit2Expiration === null) === (value.permit2Status === 'unavailable') &&
    (value.permit2AllowanceRaw === null || BigInt(value.permit2AllowanceRaw) < (1n << 160n)) &&
    (value.permit2Expiration === null || value.permit2Expiration < 2 ** 48);
  if (name === 'AllowanceReport') return value.observations.every(row => row.permit2Status === 'unavailable' ||
    row.permit2Status === (row.permit2AllowanceRaw === '0' ? 'zero' : row.permit2Expiration < value.snapshot.timestamp ? 'expired' : 'active'));
  if (name === 'AllowanceResponse') return value.walletStep === null &&
    JSON.stringify(value.allowances.observations.map(row => row.currency)) ===
      JSON.stringify([value.operation.selection.poolKey.currency0, value.operation.selection.poolKey.currency1].filter(c => c !== ZERO));
  if (name === 'OperationListItem') return (value.historyCount === 0) === (value.lastStep === null) &&
    (value.lastStep === null || value.lastStep.step === value.historyCount && stepPolicy(value.lastStep, value.selection, value.state)) &&
    value.createdAt <= value.updatedAt;
  if (name === 'ListResponse') return (value.nextBefore !== null) === value.hasMore &&
    (!value.hasMore || value.operations.length > 0 && value.nextBefore === value.operations.at(-1).id);
  if (name === 'OperationResponse' && value.walletStep !== null) {
    const op = value.operation, step = value.walletStep, last = op.history.at(-1);
    return op.outstanding && op.state === 'awaiting_wallet' && last && step.kind === last.kind &&
      step.transaction.nonceRaw === last.nonceRaw && step.expiresAt === last.expiresAt &&
      validateWalletStep(op.selection, op.owner, step);
  }
  return true;
}

function check(route, kind, value) {
  try {
    if (!Object.hasOwn(SCHEMAS, route)) return false;
    const schema = SCHEMAS[route][kind];
    return validate(schema, value, schema) && semantic(schema.title, value) &&
      (kind !== 'response' || route === 'prepare' || !value.walletStep);
  } catch { return false; }
}
export const validateRequest = (route, value) => check(route, 'request', value);
export const validateResponse = (route, value) => check(route, 'response', value);
export function validateError(status, value) {
  return Number.isSafeInteger(status) && object(value) && Object.keys(value).length === 1 &&
    typeof value.error === 'string' && Object.hasOwn(ERROR_STATUS_BY_CODE, value.error) && ERROR_STATUS_BY_CODE[value.error] === status;
}
