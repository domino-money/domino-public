/**
 * The bridge-test build's one read source for the whole app: the same-origin
 * bridge behind slice A's scheduler. Deployed reads keep 1.1 s spacing;
 * local-live uses 10.1 s to fit the development reader's six starts/minute
 * and two-second minimum, without increasing any remote limit. The landing
 * table, position lookup, pickers and figures dialog share one source.
 */
import { CAPABILITIES } from '../../capabilities'
import * as estimateRuntime from 'api-contracts/read-v2/runtime.mjs'
import { createEstimateSource } from '../estimateSource'
import { READ_RUNTIME } from '../contract'
import { createScheduledSource } from '../scheduler'
import type { ReadSource } from '../types'

// Logical jobs are paced from the previous job's last attempt. Remote quotas
// remain authoritative across tabs/worktrees and reloads.
export const BRIDGE_SPACING_MS = __DOMINO_LOCAL_LIVE__ ? 10_100 : 1100

export function createAppBridgeSource(): ReadSource {
  return createScheduledSource(createEstimateSource({ enabled: CAPABILITIES.liveReadsBuilt, validators: READ_RUNTIME }, estimateRuntime), { minIntervalMs: BRIDGE_SPACING_MS })
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
