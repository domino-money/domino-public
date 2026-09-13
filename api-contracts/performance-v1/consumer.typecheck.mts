// Compile-only private-card integration boundary. No frontend connection.
import type { PerformanceRequests, PerformanceResponses } from './types.js';
import { validateRequest, validateResponse } from './runtime.mjs';

const request: PerformanceRequests['cards'] = { epochIds: ['0x' + '1'.repeat(64)] };
const invalidOwner: PerformanceRequests['cards'] = {
  ...request,
  // @ts-expect-error The browser cannot supply the authenticated owner.
  owner: '0x1',
};
// @ts-expect-error The batch uses canonical string identities, never JS numbers.
const invalidIds: PerformanceRequests['cards'] = { epochIds: [123] };
// @ts-expect-error This candidate cannot enable financial execution.
const invalidExecution: PerformanceResponses['cards']['executionAvailable'] = true;

function consume(input: unknown, output: unknown) {
  if (validateRequest('cards', input)) {
    const ids: string[] = input.epochIds;
    void ids;
  }
  if (validateResponse('cards', output)) {
    for (const card of output.cards) {
      const pending: 'unavailable' = card.performanceStatus;
      const noApr: null = card.metrics.netFeeAprPercent;
      // @ts-expect-error Financial numbers do not exist in this candidate.
      const inventedApr: string = card.metrics.grossFeeAprPercent;
      if (card.kind === 'tracked') {
        const lastConfirmed: number = card.snapshot.timestamp;
        void lastConfirmed;
      } else {
        // @ts-expect-error Missing/foreign epochs disclose no snapshot.
        void card.snapshot;
      }
      void [pending, noApr, inventedApr];
    }
  }
}
void [invalidOwner, invalidIds, invalidExecution, consume];
