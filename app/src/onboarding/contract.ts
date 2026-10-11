/**
 * The one place the app imports the onboarding-v1 runtime. Only the
 * consumer-test build reaches this module (through the lazy #/live-preview
 * screen); the default build never does.
 */
import { CONTRACT_VERSION, ERROR_STATUS_BY_CODE, validateRequest, validateResponse, validateError } from 'api-contracts/onboarding-v1/runtime.mjs'
import type { OnboardingContractVersion } from 'api-contracts/onboarding-v1/types'
import type { OnboardingValidators } from './types'
import type { OnboardingContractPin } from './version'

type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false

// Fails typecheck as soon as the pinned version and the imported runtime disagree.
void (true satisfies Same<OnboardingContractVersion, OnboardingContractPin>)

export const ONBOARDING_RUNTIME: OnboardingValidators = Object.freeze({ CONTRACT_VERSION, ERROR_STATUS_BY_CODE, validateRequest, validateResponse, validateError })
