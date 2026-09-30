/**
 * The onboarding previews' vocabulary (#38). Request and response shapes are
 * rugged97's generated onboarding-v1 types, imported in place; nothing here
 * restates a contract field.
 */
import type {
  OnboardingErrorCode,
  OnboardingRequests,
  OnboardingResponses,
  OnboardingRoute,
} from 'api-contracts/onboarding-v1/types'

export type { OnboardingErrorCode, OnboardingRequests, OnboardingResponses, OnboardingRoute }
export type SwapPreview = OnboardingResponses['swap-preview']['preview']
export type PositionPreview = OnboardingResponses['position-preview']['preview']
export type SwapRoutePreview = OnboardingResponses['swap-route']['preview']
export type SwapRouteRequest = OnboardingRequests['swap-route']
export type PreviewOf<R extends OnboardingRoute> = OnboardingResponses[R]['preview']

/**
 * The package runtime, satisfied structurally. Passed in rather than imported
 * so the pure modules compile for node tests; onboarding/contract.ts is the
 * one place the app imports it.
 */
export interface OnboardingValidators {
  readonly CONTRACT_VERSION: string
  readonly ERROR_STATUS_BY_CODE: Readonly<Record<OnboardingErrorCode, number>>
  validateRequest<R extends OnboardingRoute>(route: R, value: unknown): value is OnboardingRequests[R]
  validateResponse<R extends OnboardingRoute>(route: R, value: unknown): value is OnboardingResponses[R]
  validateError(status: number, value: unknown): value is { error: OnboardingErrorCode }
}
