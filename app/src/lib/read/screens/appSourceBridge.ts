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
 *
 * Changed on purpose 2026-09-28 (speed wave, items 1 and 5): deployed reads go out two at a time, every lane together
 * (the gateway runs two at once), provider reads 0 ms apart since the gateway's provider lane lost its start interval
 * (#241), and 1.1 s apart again, by themselves, once one meets a refusal (scheduler.ts). The deployable build keeps
 * the budget in this browser's localStorage, one key its tabs and reloads share (the gateway counts per address, not
 * per document); the test builds keep each document's own, as before.
 */
import { CAPABILITIES } from '../../capabilities'
import * as estimateRuntime from 'api-contracts/read-v2/runtime.mjs'
import * as publicRuntime from 'api-contracts/read-v3/runtime.mjs'
import * as featuredRuntime from 'api-contracts/read-v5/runtime.mjs'
import { takeEarly } from '../earlyList'
import { createEstimateSource } from '../estimateSource'
import { createFeaturedReadSource } from '../featuredList'
import { createPublicSource } from '../publicSource'
import { READ_RUNTIME } from '../contract'
import { createScheduledSource, storedBudget } from '../scheduler'
import { createPublicMetadataCache } from '../publicMetadataCache'
import type { ReadSource } from '../types'

// Logical jobs are paced from the previous job's last attempt. Remote quotas
// remain authoritative across tabs/worktrees and reloads.
export const BRIDGE_SPACING_MS = __DOMINO_LOCAL_LIVE__ ? 10_100 : 1100

/** Where the deployable build keeps the read budget. */
export const BUDGET_KEY = 'domino-read-budget:v1'

export function createAppBridgeSource(): ReadSource {
  // The deployable build's first reads take the replies the page's boot script (functions/_lib/boot.ts) sent before the app started (item 10).
  const options = { enabled: CAPABILITIES.liveReadsBuilt, validators: READ_RUNTIME, ...(__DOMINO_POOL_SET__ === 'selected' && !__DOMINO_LOCAL_LIVE__ ? { first: takeEarly } : {}) }
  // read-v5's featured pools list rides the same queue and budget as every other read (featuredList.ts).
  const source = createFeaturedReadSource(createPublicSource(createEstimateSource(options, estimateRuntime), options, publicRuntime), options, featuredRuntime)
  const scheduling = __DOMINO_LOCAL_LIVE__
    ? { minIntervalMs: BRIDGE_SPACING_MS, unspacedStored: false }
    : { minIntervalMs: 0, refusedIntervalMs: BRIDGE_SPACING_MS, unspacedStored: true, width: 2, ...(__DOMINO_POOL_SET__ === 'selected' ? { budgetStore: storedBudget(BUDGET_KEY) } : {}) }
  return createPublicMetadataCache(createScheduledSource(source, scheduling))
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
