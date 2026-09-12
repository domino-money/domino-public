/**
 * The bridge-test build's one read source for the whole app: the same-origin
 * bridge behind slice A's scheduler, 1.1 s between starts, which is how the
 * bridge admits reads. The landing table, the position lookup, the pickers and
 * the figures dialog all share it, so their reads never overlap.
 */
import { CAPABILITIES } from '../../capabilities'
import { createBridgeSource } from '../bridgeSource'
import { READ_RUNTIME } from '../contract'
import { createScheduledSource } from '../scheduler'
import type { ReadSource } from '../types'

export const BRIDGE_SPACING_MS = 1100

export function createAppBridgeSource(): ReadSource {
  return createScheduledSource(createBridgeSource({ enabled: CAPABILITIES.liveReadsBuilt, validators: READ_RUNTIME }), { minIntervalMs: BRIDGE_SPACING_MS })
}

let shared: ReadSource | null = null

/**
 * That one source, created on first use. Every caller in the build gets the
 * same instance: two sources would each space only their own reads, and the
 * bridge admits by wall clock, not per caller.
 */
export function appBridgeSource(): ReadSource {
  return (shared ??= createAppBridgeSource())
}
