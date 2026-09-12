/**
 * The bridge-test build's one read source for the whole app: the same-origin
 * bridge behind slice A's scheduler. Deployed reads keep 1.1 s spacing;
 * local-live uses 10.1 s to fit the development reader's six starts/minute
 * and two-second minimum, without increasing any remote limit. The landing
 * table, position lookup, pickers and figures dialog share one source.
 */
import { CAPABILITIES } from '../../capabilities'
import { createBridgeSource } from '../bridgeSource'
import { READ_RUNTIME } from '../contract'
import { createScheduledSource } from '../scheduler'
import type { ReadSource } from '../types'

// Applies to logical job starts, paced from the previous job's last attempt.
// Retries inside a job retain the existing Retry-After/60 s policy. Other
// tabs/worktrees and reloads still share the authoritative remote budget.
export const BRIDGE_SPACING_MS = __DOMINO_LOCAL_LIVE__ ? 10_100 : 1100

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
