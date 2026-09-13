/**
 * Compile-only checks, run by the app's own `tsc --noEmit`: the request and
 * response types this app builds against keep the package's guarantees. The
 * package's consumer.typecheck.mts has the same three cases and CI compiles it
 * separately; these prove the app's view of the types, through its alias.
 */
import type { OnboardingRequests, OnboardingResponses } from 'api-contracts/onboarding-v1/types'

const swap: OnboardingRequests['swap-preview'] = {
  chainId: 4663,
  tokenIn: '0x1111111111111111111111111111111111111111',
  tokenOut: '0x2222222222222222222222222222222222222222',
  amountRaw: '1000',
  slippageBps: 50,
  maxPriceImpactBps: 100,
}
const withOwner: OnboardingRequests['swap-preview'] = {
  ...swap,
  // @ts-expect-error The owner comes from the session, never from the browser.
  owner: '0x3333333333333333333333333333333333333333',
}
const numericAmount: OnboardingRequests['swap-preview'] = {
  ...swap,
  // @ts-expect-error Raw amounts are decimal strings, never numbers.
  amountRaw: 1000,
}
// @ts-expect-error No preview can say it is executable.
const executable: OnboardingResponses['position-preview']['preview']['executionAvailable'] = true

void [withOwner, numericAmount, executable]
