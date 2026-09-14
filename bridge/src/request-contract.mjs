import { JsonNumber } from './strict-json.mjs';
import { CONTRACT_VERSION, RESPONSE_SCHEMA_VERSIONS } from '../../api-contracts/read-v1/runtime.mjs';

export { CONTRACT_VERSION };
export const CHAIN_ID = 4663;
export const ROUTES = Object.freeze({
  token: { schemaVersion: RESPONSE_SCHEMA_VERSIONS.token, fields: ['token'], required: ['token'] },
  pools: { schemaVersion: RESPONSE_SCHEMA_VERSIONS.pools, fields: ['token', 'pairedToken', 'maxPools', 'poolIds'], required: ['token'] },
  'pool-market': { schemaVersion: RESPONSE_SCHEMA_VERSIONS['pool-market'], fields: ['poolId', 'includePriceHistory', 'priceToken'], required: ['poolId'] },
  'wallet-assets': { schemaVersion: RESPONSE_SCHEMA_VERSIONS['wallet-assets'], fields: ['wallet', 'tokens', 'autoDiscover', 'cursor'], required: ['wallet'] },
  'nft-positions': { schemaVersion: RESPONSE_SCHEMA_VERSIONS['nft-positions'], fields: ['tokenIds', 'blockNumber'], required: ['tokenIds'] },
  catalogue: { schemaVersion: RESPONSE_SCHEMA_VERSIONS.catalogue, fields: ['token', 'pairedToken', 'limit', 'afterPoolId', 'revision'], required: ['token'] },
  'pool-activity': { schemaVersion: RESPONSE_SCHEMA_VERSIONS['pool-activity'], fields: ['poolId'], required: ['poolId'] },
  'pool-positions': { schemaVersion: RESPONSE_SCHEMA_VERSIONS['pool-positions'], fields: ['poolId'], required: ['poolId'] },
  'pool-metrics': { schemaVersion: RESPONSE_SCHEMA_VERSIONS['pool-metrics'], fields: ['poolId'], required: ['poolId'] },
  'markets-snapshot': { schemaVersion: RESPONSE_SCHEMA_VERSIONS['markets-snapshot'], fields: ['poolIds'], required: [] },
});

const address = (value) => typeof value === 'string' && value.length === 42 && /^0x[0-9a-fA-F]{40}$/.test(value);
const poolId = (value) => typeof value === 'string' && value.length === 66 && /^0x[0-9a-fA-F]{64}$/.test(value);
const integer = (value, min, max) => value instanceof JsonNumber &&
  /^-?(0|[1-9][0-9]*)$/.test(value.source) && BigInt(value.source) >= min && BigInt(value.source) <= max;
const array = (value, max, item) => Array.isArray(value) && value.length <= max && value.every(item);
export const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value) && !(value instanceof JsonNumber);

export function validateRequest(route, body) {
  if (typeof route !== 'string' || !Object.hasOwn(ROUTES, route)) return false;
  const contract = ROUTES[route];
  if (!contract || !isObject(body) || Object.keys(body).some((key) => !contract.fields.includes(key)) ||
      contract.required.some((key) => !Object.hasOwn(body, key))) return false;
  const optional = (key, validate) => !Object.hasOwn(body, key) || validate(body[key]);
  if (route === 'token' || route === 'pools' || route === 'catalogue') {
    if (!address(body.token)) return false;
    if (route === 'token') return true;
    if (route === 'catalogue') return optional('pairedToken', value => value === null || (address(value) && value.toLowerCase() !== body.token.toLowerCase())) &&
      optional('limit', value => integer(value, 1n, 100n)) &&
      optional('afterPoolId', value => value === null || poolId(value)) &&
      optional('revision', value => value === null || integer(value, 0n, 2n ** 53n - 1n)) &&
      (body.afterPoolId == null || body.revision != null);
    if (!optional('pairedToken', (value) => value === null || (address(value) && value.toLowerCase() !== body.token.toLowerCase())) ||
        !optional('maxPools', (value) => integer(value, 1n, 20n)) || !optional('poolIds', (value) => array(value, 10, poolId))) return false;
    return (body.poolIds?.length ?? 0) <= Number(body.maxPools?.source ?? '12');
  }
  if (['pool-activity', 'pool-positions', 'pool-metrics'].includes(route)) return poolId(body.poolId);
  if (route === 'pool-market') return poolId(body.poolId) &&
    optional('includePriceHistory', (value) => typeof value === 'boolean') &&
    optional('priceToken', (value) => value === 'base' || value === 'quote');
  if (route === 'wallet-assets') return address(body.wallet) &&
    optional('tokens', (value) => array(value, 10, address)) &&
    optional('autoDiscover', (value) => typeof value === 'boolean') &&
    optional('cursor', (value) => value === null || (typeof value === 'string' && [...value].length >= 1 && [...value].length <= 4096));
  if (route === 'markets-snapshot') return optional('poolIds', (value) => array(value, 24, poolId));
  return array(body.tokenIds, 10, (value) => typeof value === 'string' && /^(0|[1-9][0-9]{0,77})(?![\s\S])/.test(value) && BigInt(value) < 2n ** 256n) &&
    body.tokenIds.length >= 1 && new Set(body.tokenIds).size === body.tokenIds.length &&
    optional('blockNumber', (value) => value === null || integer(value, 0n, 2n ** 53n - 1n));
}
