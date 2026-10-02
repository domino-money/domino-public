// Separate Uniswap v3 wire validation. No fetch, wallet, signer or v4 fallback.
import { SCHEMAS, ERRORS } from './schema-data.mjs';
import { createContractValidators } from '../shared/closed-schema.mjs';
export const CONTRACT_VERSION = '1.0.0-rc.2';
export const ROUTES = Object.freeze(Object.keys(SCHEMAS));
export const ERROR_STATUS_BY_CODE = Object.freeze({ ...ERRORS });
const identityKeys = ['chainId', 'protocol', 'deploymentId', 'positionManager'];
const address = /^0x[0-9a-f]{40}$/;
const hash = /^0x[0-9a-f]{64}$/;
const notZero = (value) => !/^0x0+$/.test(value);
function expectedIdentity(value) {
  return value !== null && typeof value === 'object' && [Object.prototype, null].includes(Object.getPrototypeOf(value)) &&
    Reflect.ownKeys(value).length === 4 && identityKeys.every(key => Object.hasOwn(value, key) &&
      Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), 'value') && Object.getOwnPropertyDescriptor(value, key).enumerable) &&
    value.chainId === 99801 && value.protocol === 'uniswap-v3' && hash.test(value.deploymentId) &&
    notZero(value.deploymentId) && address.test(value.positionManager) && notZero(value.positionManager);
}
const equalIdentity = (value, expected) => identityKeys.every(key => value[key] === expected[key]);
function semantic(name, value) {
  if (name === 'CapabilitiesResponse') return (value.deployment === null) === (value.status === 'unqualified') &&
    (value.deployment !== null || (!value.providerConfigured && !value.ledgerConfigured));
  if (name === 'DiscoverRequest') return value.tokenA !== value.tokenB;
  if (name === 'DiscoverResponse') return (value.pool === null) === (value.status === 'not-found');
  if (name === 'PoolData') return value.token0.address < value.token1.address &&
    BigInt(value.sqrtPriceX96Raw) >= 4295128739n && BigInt(value.sqrtPriceX96Raw) < 1461446703485210103287273052203988822378723970342n &&
    BigInt(value.liquidityRaw) < 2n ** 128n;
  if (name === 'PositionData') return value.token0 < value.token1 && value.tickLower < value.tickUpper && BigInt(value.liquidityRaw) < 2n ** 128n;
  if (name === 'Coverage') return value.fromBlock <= value.toBlock && value.complete === (value.reason === 'complete');
  if (name === 'LedgerResponse') return value.coverage.toBlock === value.anchor.number &&
    value.currencies.every((item, index) => index === 0 || value.currencies[index - 1].currency < item.currency);
  if (name === 'HistoryResponse') {
    if (value.coverage.toBlock !== value.anchor.number) return false;
    for (let i = 0; i < value.items.length; i++) {
      const item = value.items[i], previous = value.items[i - 1];
      if (item.vault !== value.vault || item.blockNumber > value.anchor.number) return false;
      if (previous && !(item.blockNumber > previous.blockNumber || item.blockNumber === previous.blockNumber &&
          (item.transactionIndex > previous.transactionIndex || item.transactionIndex === previous.transactionIndex && item.logIndex > previous.logIndex))) return false;
    }
    return value.nextAfter === null || value.items.length > 0 &&
      ['blockNumber', 'blockHash', 'transactionIndex', 'logIndex'].every(key => value.nextAfter[key] === value.items.at(-1)[key]);
  }
  return true;
}
const validators = createContractValidators(SCHEMAS, ERROR_STATUS_BY_CODE, semantic);
function check(kind, route, value, expected) {
  try {
    if (!validators[kind](route, value)) return false;
    if (route === 'capabilities') return expected === undefined || expectedIdentity(expected) &&
      (kind === 'validateRequest' || value.deployment !== null && equalIdentity(value.deployment, expected));
    // A correctly shaped object from another deployment is still wrong data.
    return expectedIdentity(expected) && equalIdentity(value, expected);
  } catch { return false; }
}
export const validateRequest = (route, value, expected) => check('validateRequest', route, value, expected);
export const validateResponse = (route, value, expected) => check('validateResponse', route, value, expected);
export const validateError = validators.validateError;
