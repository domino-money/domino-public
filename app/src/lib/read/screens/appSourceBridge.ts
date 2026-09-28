/**
 * The bridge-test build's one read source for the whole app: the same-origin
 * bridge behind slice A's scheduler. Deployed reads keep 1.1 s spacing on the
 * gateway's provider lane, the gateway's per-client budget (five at once, then
 * 30 a minute) and a hold for the Retry-After of any busy answer; read-v3's
 * stored reads skip the spacing, which the gateway's stored lane does not
 * have (scheduler.ts, 2026-09-25), two of them at once (2026-09-27). local-live uses 10.1 s for every read to
 * fit the development reader's six starts/minute and two-second minimum,
 * without increasing any remote limit. The landing table, position lookup,
 * pickers and figures dialog share one source, so one budget.
 */
import { CAPABILITIES } from '../../capabilities'
import * as estimateRuntime from 'api-contracts/read-v2/runtime.mjs'
import * as publicRuntime from 'api-contracts/read-v3/runtime.mjs'
import * as featuredRuntime from 'api-contracts/read-v5/runtime.mjs'
import { createEstimateSource } from '../estimateSource'
import { createFeaturedReadSource } from '../featuredList'
import { createPublicSource } from '../publicSource'
import { READ_RUNTIME } from '../contract'
import { createScheduledSource } from '../scheduler'
import { createPublicMetadataCache } from '../publicMetadataCache'
import type { ReadSource } from '../types'

// Logical jobs are paced from the previous job's last attempt. Remote quotas
// remain authoritative across tabs/worktrees and reloads.
export const BRIDGE_SPACING_MS = __DOMINO_LOCAL_LIVE__ ? 10_100 : 1100

export function createAppBridgeSource(): ReadSource {
  const options = { enabled: CAPABILITIES.liveReadsBuilt, validators: READ_RUNTIME }
  // read-v5's featured pools list rides the same queue and budget as every other read (featuredList.ts).
  const source = createFeaturedReadSource(createPublicSource(createEstimateSource(options, estimateRuntime), options, publicRuntime), options, featuredRuntime)
  return createPublicMetadataCache(createScheduledSource(source, { minIntervalMs: BRIDGE_SPACING_MS, unspacedStored: !__DOMINO_LOCAL_LIVE__, storedWidth: 2 }))
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
