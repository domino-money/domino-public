// Closed generated-schema validation plus arithmetic/identity checks. No ABI or LP math.
import { SCHEMAS, ERRORS } from './schema-data.mjs';
export const CONTRACT_VERSION = '1.0.0';
export const ROUTES = Object.freeze(Object.keys(SCHEMAS));
export const ERROR_STATUS_BY_CODE = Object.freeze({ ...ERRORS });
const UINT256_MAX = (1n << 256n) - 1n;
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value) &&
  [Object.prototype, null].includes(Object.getPrototypeOf(value));
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const positiveRawPattern = '^[1-9][0-9]{0,77}$';
const rawPattern = '^(0|[1-9][0-9]{0,77})$';

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
    if (schema['x-minimum-decimal'] !== undefined && decimalCompare(value, schema['x-minimum-decimal']) < 0) return false;
    if (schema['x-maximum-decimal'] !== undefined && decimalCompare(value, schema['x-maximum-decimal']) > 0) return false;
    const fraction = value.split('.')[1] || '';
    if (schema['x-fraction-digits'] !== undefined && fraction.length > schema['x-fraction-digits']) return false;
    if (schema['x-hundredths'] && /[1-9]/u.test(fraction.slice(2))) return false;
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

function positionRequest(value) {
  const key = value.poolKey;
  const currencies = [key.currency0, key.currency1], index = currencies.indexOf(value.independentToken.toLowerCase());
  if (index < 0 || !range(value, key)) return false;
  const budget = [value.budget0Raw, value.budget1Raw][index];
  return (budget == null || BigInt(value.amountRaw) <= BigInt(budget)) &&
    (value.nativeGasReserveRaw == null || value.nativeBalanceRaw != null);
}
const range = (value, key) => value.tickLower < value.tickUpper &&
  value.tickLower % key.tick_spacing === 0 && value.tickUpper % key.tick_spacing === 0;

// Compare fixed-point decimals exactly; no Number coercion of monetary values.
function decimalCompare(a, b) {
  const [wholeA, fractionA = ''] = a.split('.'), [wholeB, fractionB = ''] = b.split('.');
  const length = Math.max(fractionA.length, fractionB.length);
  const left = BigInt(wholeA + fractionA.padEnd(length, '0'));
  const right = BigInt(wholeB + fractionB.padEnd(length, '0'));
  return left < right ? -1 : left > right ? 1 : 0;
}

function swapAssociations(value) {
  const request = value.request, quote = value.quote;
  if (request.owner === '0x' + '0'.repeat(40) || quote.dexInputAmountRaw !== request.amountRaw || value.providerOutputFee.currency !== request.tokenOut.toLowerCase()) return false;
  let totalIn = 0n, totalOut = 0n;
  for (const path of quote.routes) {
    if (path[0].tokenIn.address !== request.tokenIn.toLowerCase() || path.at(-1).tokenOut.address !== request.tokenOut.toLowerCase() ||
        path[0].amountInRaw === null || path.at(-1).amountOutRaw === null) return false;
    for (let index = 1; index < path.length; index++) if (path[index - 1].tokenOut.address !== path[index].tokenIn.address) return false;
    totalIn += BigInt(path[0].amountInRaw); totalOut += BigInt(path.at(-1).amountOutRaw);
  }
  const floor = BigInt(quote.grossOutputAmountRaw) * BigInt(10000 - request.slippageBps) / 10000n;
  const expected = value.providerOutputFee.status === 'reported_zero' ? [quote.grossOutputAmountRaw, quote.grossMinimumOutputAmountRaw] : [null, null];
  const reasons = [];
  if (quote.priceImpactPercent === null) reasons.push('price_impact_unknown');
  else {
    const [whole, fraction = ''] = quote.priceImpactPercent.split('.');
    const impactNumerator = BigInt(whole + fraction) * 100n;
    if (impactNumerator > BigInt(request.maxPriceImpactBps) * 10n ** BigInt(fraction.length)) reasons.push('price_impact_exceeded');
  }
  if (value.providerOutputFee.status !== 'reported_zero') reasons.push('provider_output_fee_' + value.providerOutputFee.status);
  if (value.simulation.failureCodes === null) reasons.push('simulation_unknown');
  else if (value.simulation.failureCodes.length) reasons.push('provider_simulation_failed');
  if (value.gas.feeWei === null || value.gas.units === null) reasons.push('gas_estimate_incomplete');
  return equal(value.previewChecks.reasons, reasons) && totalIn === BigInt(quote.dexInputAmountRaw) && totalOut === BigInt(quote.grossOutputAmountRaw) &&
    BigInt(quote.policyMinimumOutputRaw) === floor && BigInt(quote.grossMinimumOutputAmountRaw) >= floor &&
    BigInt(quote.grossMinimumOutputAmountRaw) <= BigInt(quote.grossOutputAmountRaw) &&
    equal([quote.outputAfterProviderFeeRaw, quote.minimumAfterProviderFeeRaw], expected);
}
function positionAssociations(value) {
  const request = value.request, position = value.position, native = value.nativeFunding;
  if (['0', '1', '2'].some((digit) => request.owner === '0x' + '0'.repeat(39) + digit) ||
      position.recipient !== request.owner || position.poolId !== request.poolId ||
      Object.keys(position.poolKey).some((key) => position.poolKey[key] !== request.poolKey[key]) ||
      position.tickLower !== request.tickLower || position.tickUpper !== request.tickUpper ||
      !equal(position.tokens.map((token) => token.selectedBudgetRaw), [request.budget0Raw, request.budget1Raw]) ||
      native.reportedBalanceRaw !== request.nativeBalanceRaw || native.selectedGasReserveRaw !== request.nativeGasReserveRaw) return false;
  const nativeMaximum = request.poolKey.currency0 === '0x' + '0'.repeat(40) ? position.tokens[0].maximumDebitRaw : '0';
  const independent = position.tokens.find((token) => token.address === request.independentToken.toLowerCase());
  if (native.depositMaximumRaw !== nativeMaximum || BigInt(independent.expectedDepositRaw) > BigInt(request.amountRaw) ||
      !position.tokens.some((token) => BigInt(token.expectedDepositRaw) > 0n)) return false;
  const blocked = [], incomplete = [];
  position.tokens.forEach((token, index) => {
    if (token.budgetStatus === 'exceeded') blocked.push(`token${index}_maximum_exceeds_budget`);
    if (token.budgetStatus === 'unknown') incomplete.push(`token${index}_budget_unknown`);
  });
  if (native.reportedBalanceRaw === null) incomplete.push('native_balance_unknown');
  else if (BigInt(native.depositMaximumRaw) > BigInt(native.reportedBalanceRaw)) blocked.push('native_deposit_exceeds_balance');
  if (native.selectedGasReserveRaw === null) incomplete.push('native_gas_reserve_unspecified');
  else if (BigInt(native.depositMaximumRaw) + BigInt(native.selectedGasReserveRaw) > BigInt(native.reportedBalanceRaw)) blocked.push('native_gas_reserve_exceeded');
  return equal(value.previewChecks.reasons, [...blocked, ...incomplete]);
}

function semantic(name, value) {
  if (name === 'PoolKeyModel') return value.currency0 < value.currency1;
  if (['SwapRequest', 'SwapIdentity'].includes(name)) return value.tokenIn.toLowerCase() !== value.tokenOut.toLowerCase();
  if (['PositionRequest', 'PositionIdentity'].includes(name)) return positionRequest(value);
  if (name === 'RouteHop') return equal([value.tokenIn.address, value.tokenOut.address].sort(),
    [value.poolKey.currency0, value.poolKey.currency1]);
  if (name === 'SwapChecks') return (value.status === 'blocked') === Boolean(value.reasons.length) && new Set(value.reasons).size === value.reasons.length;
  if (name === 'PositionChecks') {
    const blocked = value.reasons.some((reason) => ['exceeded', 'exceeds_budget', 'exceeds_balance'].some((suffix) => reason.endsWith(suffix)));
    return value.status === (blocked ? 'blocked' : value.reasons.length ? 'incomplete' : 'within_selected_limits') && new Set(value.reasons).size === value.reasons.length;
  }
  if (name === 'SwapSimulation') return value.status === (value.failureCodes === null ? 'unknown' : value.failureCodes.length ? 'provider_reported_failure' : 'no_provider_failure_reported');
  if (name === 'ProviderFee') return (value.status === 'reported_zero') === (value.zeroEvidence !== null) &&
    (value.status !== 'reported_zero' || (value.bps === null || decimalCompare(value.bps, '0') === 0) && (value.amountRaw === null || value.amountRaw === '0'));
  if (name === 'PositionToken') {
    const nominal = BigInt(value.expectedDepositRaw), maximum = BigInt(value.maximumDebitRaw);
    const budget = value.selectedBudgetRaw === null ? null : BigInt(value.selectedBudgetRaw);
    return nominal <= maximum && value.budgetStatus === (budget === null ? 'unknown' : maximum > budget ? 'exceeded' : 'within_limit') &&
      value.estimatedUnspentBudgetRaw === (budget === null || nominal > budget ? null : String(budget - nominal)) &&
      value.unspentAtMaximumRaw === (budget === null || maximum > budget ? null : String(budget - maximum));
  }
  if (name === 'AdjustedPrices') return decimalCompare(value.min, '0.' + '0'.repeat(77) + '1') >= 0 &&
    decimalCompare(value.min, value.max) < 0 && decimalCompare(value.max, '1' + '0'.repeat(78)) <= 0;
  if (name === 'Position') return range(value, value.poolKey) &&
    equal(value.tokens.map((token) => token.address), [value.poolKey.currency0, value.poolKey.currency1]);
  if (name === 'PositionGas') return (value.feeWei === null) === (value.source === null);
  if (['SwapPreview', 'PositionPreview'].includes(name)) return value.requestedAt <= value.retrievedAt &&
    value.retrievedAt < value.expiresAt && value.expiresAt === value.requestedAt + 30 &&
    (name === 'PositionPreview' ? value.preparedDeadline === value.requestedAt + 1200 && positionAssociations(value) : swapAssociations(value));
  return true;
}

function check(route, kind, value) {
  try {
    if (!Object.hasOwn(SCHEMAS, route)) return false;
    const schema = SCHEMAS[route][kind];
    return validate(schema, value, schema) && semantic(schema.title, value);
  } catch { return false; }
}
export const validateRequest = (route, value) => check(route, 'request', value);
export const validateResponse = (route, value) => check(route, 'response', value);
export function validateError(status, value) {
  return Number.isSafeInteger(status) && object(value) && Object.keys(value).length === 1 &&
    typeof value.error === 'string' && Object.hasOwn(ERROR_STATUS_BY_CODE, value.error) && ERROR_STATUS_BY_CODE[value.error] === status;
}
