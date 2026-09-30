import { useSyncExternalStore } from 'react'

/** Display-only values from the financial controller. Never authority to sign. */
export interface RoutedReview {
  from: 0 | 1
  gross: string
  totalInput: string
  output: string
  minimum: string
  fee: string
  advantageBps: number | null
  priceImpact: string | null
  poolUnfilled: boolean
  sequential: boolean
}
let review: RoutedReview | null = null
const listeners = new Set<() => void>()
export function publishRoutedReview(next: RoutedReview | null) {
  review = next
  for (const listener of listeners) listener()
}
export const useRoutedReview = () => useSyncExternalStore(
  (listener) => { listeners.add(listener); return () => { listeners.delete(listener) } },
  () => review,
  () => null,
)
