// Compile-only consumer contract checks; this does not connect the frontend.
import type { OnboardingRequests, OnboardingResponses } from './types.js';
import { validateRequest, validateResponse } from './runtime.mjs';

const swap: OnboardingRequests['swap-preview'] = {
  chainId: 4663, tokenIn: '0x1', tokenOut: '0x2', amountRaw: '1000',
  slippageBps: 50, maxPriceImpactBps: 100,
};
const invalidOwner: OnboardingRequests['swap-preview'] = {
  ...swap,
  // @ts-expect-error Owners are derived from the session, never browser requests.
  owner: '0x3',
};
const invalidAmount: OnboardingRequests['swap-preview'] = {
  ...swap,
  // @ts-expect-error Raw token amounts must remain strings.
  amountRaw: 1000,
};
// @ts-expect-error No successful preview permits execution.
const invalidAuthority: OnboardingResponses['position-preview']['preview']['executionAvailable'] = true;

function consume(input: unknown, output: unknown) {
  if (validateRequest('position-preview', input)) {
    const optionalBudget: string | null | undefined = input.budget0Raw;
    void optionalBudget;
  }
  if (validateResponse('swap-preview', output)) {
    const outputAmount: string | null = output.preview.quote.outputAfterProviderFeeRaw;
    const noExecution: false = output.preview.executionAvailable;
    void [outputAmount, noExecution];
  }
}
void [invalidOwner, invalidAmount, invalidAuthority, consume];
