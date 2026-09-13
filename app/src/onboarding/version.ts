import { PRODUCER_PIN } from '../lib/read/pin'

/** The onboarding-v1 version this build is pinned to, from the one pin table. */
export type OnboardingContractPin = (typeof PRODUCER_PIN)['packages']['onboarding-v1']['version']

/**
 * The only value accepted in `X-Domino-Onboarding-Contract`, and the value
 * sent. An exact string: no range, no trimming.
 */
export const ONBOARDING_CONTRACT: OnboardingContractPin = PRODUCER_PIN.packages['onboarding-v1'].version
