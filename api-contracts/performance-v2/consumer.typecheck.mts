import type {PerformanceRequests, PerformanceResponses} from './types.js';
import {validateRequest, validateResponse} from './runtime.mjs';
const cards: PerformanceRequests['cards'] = {epochIds:['0x'+'1'.repeat(64)]};
// @ts-expect-error Owner is derived from the SIWE session.
const forged: PerformanceRequests['enroll'] = {vault:'0x1',tokenIds:['1'],owner:'0x2'};
// @ts-expect-error Read-only enrollment grants no execution capability.
const execution: PerformanceResponses['cards']['executionAvailable'] = true;
function consume(value:unknown) {
  if (validateResponse('cards',value)) for (const card of value.cards) {
    const amount:string|null = card.metrics.newTradingFeesUsd;
    // @ts-expect-error Amounts are decimal strings, never JS numbers.
    const rounded:number = card.metrics.newTradingFeesUsd;
    void [amount,rounded];
  }
}
void [cards,forged,execution,consume,validateRequest];
