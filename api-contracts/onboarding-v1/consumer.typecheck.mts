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
type RoutedSwap = NonNullable<NonNullable<OnboardingResponses['swap-route']['preview']['uniswap']>['swapTransaction']>;
// @ts-expect-error A routed swap goes only to the pinned Universal Router 2.1.2.
const otherRouter: RoutedSwap['to'] = '0x02e5be68d46dac0b524905bff209cf47ee6db2a9';
const route: OnboardingRequests['swap-route'] = {
  chainId: 4663, poolId: '0x1', tokenIn: '0x2', amountRaw: '1000', slippageBps: 50,
  poolKey: { currency0: '0x2', currency1: '0x3', fee_pips: 3000, tick_spacing: 60, hooks: '0x0000000000000000000000000000000000000000' },
};
const invalidRouteOwner: OnboardingRequests['swap-route'] = {
  ...route,
  // @ts-expect-error Owners are derived from the session, never browser requests.
  owner: '0x3',
};

function consume(input: unknown, output: unknown) {
  if (validateRequest('position-preview', input)) {
    const optionalBudget: string | null | undefined = input.budget0Raw;
    void optionalBudget;
  }
  if (validateResponse('swap-route', output) && output.preview.decision === 'uniswap') {
    const transactions = output.preview.uniswap?.swapTransaction ?? null;
    void transactions;
  }
  if (validateResponse('swap-preview', output)) {
    const outputAmount: string | null = output.preview.quote.outputAfterProviderFeeRaw;
    const noExecution: false = output.preview.executionAvailable;
    void [outputAmount, noExecution];
  }
}
void [invalidOwner, invalidAmount, invalidAuthority, otherRouter, invalidRouteOwner, consume];
