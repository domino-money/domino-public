import { assertRequest, assertResponse } from './runtime.mjs';
import { createProgressiveReader } from './progressive.mjs';
import type { PoolMarketRequest, PoolsResponse, PoolMetricsResponse } from './types.js';

const query: PoolMarketRequest = { poolId: '0x', priceToken: 'quote' };
// @ts-expect-error priceToken is a finite wire enum
const wrongPrice: PoolMarketRequest = { poolId: '0x', priceToken: 'token0' };
void query; void wrongPrice;
function pools(value: PoolsResponse) {
  for (const pool of value.pools) {
    if (pool.poolKind === 'catalogue') pool.catalogueObservation.hash satisfies string;
    else {
      // @ts-expect-error discovery has no catalogue provenance
      pool.catalogueObservation;
    }
    if (pool.poolKey.feeMode === 'dynamic') pool.poolKey.fee_pips satisfies 8388608;
  }
}
function metrics(value: PoolMetricsResponse) {
  if (value.capital.status === 'unavailable') value.capital.current satisfies null;
  else value.capital.current.principalRaw satisfies string[];
  if (value.valuation.status === 'unavailable') value.valuation.feeAprPercent satisfies null;
  else value.valuation.feeAprPercent satisfies string | null;
}
void pools; void metrics;
const reader = createProgressiveReader();
const pending = reader.read('catalogue', assertRequest('catalogue', { token: '0x' }), { onState(state) {
  if (state.status === 'ready') state.data.items;
} });
void pending;
const token = assertResponse('token', null);
// @ts-expect-error TokenResponse has no price history
void token.priceHistory;
reader.dispose();
