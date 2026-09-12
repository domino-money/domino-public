import {assertRequest, assertResponse, validateResponse, CONTRACT_VERSION} from './runtime.mjs';
import type {PoolMarketEstimateRequest, PoolMarketEstimateResponse, ReadV2ContractVersion} from './types.js';

const version: ReadV2ContractVersion = CONTRACT_VERSION;
const request: PoolMarketEstimateRequest = {poolId: '0x'};
// @ts-expect-error chart requests are outside this version's only operation
const chart: PoolMarketEstimateRequest = {poolId: '0x', includePriceHistory: true};
// @ts-expect-error callers cannot choose an evaluation clock
const clock: PoolMarketEstimateRequest = {poolId: '0x', now: 1};
// @ts-expect-error token remains a read-v1 route
assertRequest('token', {token: '0x'});
const result: PoolMarketEstimateResponse = assertResponse('pool-market', null);
result.estimate.feeAprEstimate24hPercent satisfies string | null;
result.estimate.inputs.protocolFeeRaw satisfies number;
result.market.feeApr24h satisfies null;
result.executionAvailable satisfies false;
// @ts-expect-error numeric estimates are not JavaScript floats
const numeric: number = result.estimate.feeAprEstimate24hPercent;
function narrowed(value: unknown) {
  if (validateResponse('capabilities', value)) value.enabledReads satisfies Array<'pool-market'>;
}
void version; void request; void chart; void clock; void numeric; void narrowed;
