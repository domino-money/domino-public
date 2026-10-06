import type { Mandate, PortfolioResponse } from 'api-contracts/read-v6/types'
import type { AutoExitTextKey } from '../../finance/v2/autoExit'
import type { Hex, V2ChainId } from '../../v2/types'
import { BLOCKED_TEXT_KEY, vaultsOfPosition } from '../automate/portfolio'
import type { ExitModuleSet, SessionMandate } from '../automate/store'

/**
 * What a position's Auto-exit card says (Added 2026-10-06, the owner's point 5: "the position shows 'Auto-exit on ·
 * closes at {lower} – {upper}' in one short line, plus its turn-off control"), from read-v6's orders of this position
 * (`portfolio.mandates`) and the ones this page registered that the index does not list yet. One Auto-exit per position:
 * the first active one says it. Pure.
 *   - `on`: active, nothing keeps it from closing the position;
 *   - `paused`: active, but something keeps it from closing (§4.5: auto-exit turned off for the automation, the approval
 *     lost, the chain halted…), its first reason said;
 *   - `closed`: it closed the position (executed), with what it delivered;
 *   - `off`: none active (cancelled, expired, or none at all).
 */

export interface ExitTriggers {
  below: bigint
  above: bigint
}

export type ExitCardState =
  | { kind: 'on'; id: Hex; triggers: ExitTriggers | null; listed: boolean }
  | { kind: 'paused'; id: Hex; triggers: ExitTriggers | null; reasons: readonly AutoExitTextKey[]; moduleOff: boolean }
  | { kind: 'closed'; id: Hex; delivered: readonly bigint[] | null }
  | { kind: 'off' }

const DIGITS = /^(?:0|[1-9]\d{0,77})$/
const raw = (text: string | null | undefined): bigint => (typeof text === 'string' && DIGITS.test(text) ? BigInt(text) : 0n)

/** An order's two triggers as listed; null when its terms were not read. */
export function listedTriggers(order: Pick<Mandate, 'terms'>): ExitTriggers | null {
  if (!order.terms) return null
  return { below: raw(order.terms.triggerBelowSqrtPriceX96), above: raw(order.terms.triggerAboveSqrtPriceX96) }
}

/**
 * Whether the automation's record of an order says its last pass found the auto-exit module off (Added 2026-10-06, the
 * final check F2's review), as the automation writes it: its own check before any try, `exit_module_not_enabled` with no
 * contract `error`, or a try the contract refused, `reverted_exit_module_not_enabled` (ExitModuleNotEnabled).
 */
const moduleOffWaiting = (waiting: Mandate['waiting']): boolean =>
  waiting !== null && (waiting.reason === 'exit_module_not_enabled' || waiting.reason === 'reverted_exit_module_not_enabled' || waiting.error === 'ExitModuleNotEnabled')

/**
 * read-v6's answer with the auto-exit module a step of this page set on a vault (Added 2026-10-06, the final check F2:
 * Leave automation turns it off, "Turn back on" turns it on; ../automate/store.ts exitModuleSet, which answers only while
 * the listing of that vault is older than that step), by the backend's own rule: an active order of a Domino vault is
 * blocked by `module_disabled` while its vault's module is not the order's. So the card says the new standing at once, as
 * it does after a Turn off made here, and never offers a step already done. Pure; the same answer when nothing applies.
 */
export function withExitModules(body: PortfolioResponse, setOf: (chainId: V2ChainId, vault: string, listed: bigint | null) => ExitModuleSet | null): PortfolioResponse {
  let changed = false
  const mandates = body.mandates.map((order) => {
    if (order.status !== 'active' || order.moduleEnabled === null) return order
    const at = order.vault.toLowerCase()
    const vault = body.vaults.find((v) => v.chainId === order.chainId && v.address.toLowerCase() === at)
    const set = setOf(order.chainId, at, vault?.state.status === 'read' ? raw(vault.state.stateNonce) : null)
    if (!set) return order
    changed = true
    const on = set.module === order.module.toLowerCase()
    const rest = order.blockedBy.filter((code) => code !== 'module_disabled')
    return {
      ...order,
      moduleEnabled: on,
      blockedBy: on ? rest : [...rest.filter((code) => code === 'expired'), 'module_disabled' as const, ...rest.filter((code) => code !== 'expired')],
      // The automation's last pass found the module off: no longer once it is on again. Changed on purpose 2026-10-06 (the
      // final check F2's review): by the record the automation writes for it (moduleOffWaiting), whose `error` is null.
      waiting: on && moduleOffWaiting(order.waiting) ? null : order.waiting,
    }
  })
  return changed ? { ...body, mandates } : body
}

/**
 * Whether the automation's record of an order says its last try found the position's approval gone, as the contract
 * says it (§4.9: AutomationUnavailable, InvalidPosition), with or without its `reverted_<error>` reason.
 */
const custodyWaiting = (waiting: Mandate['waiting']): boolean =>
  waiting !== null && (waiting.error === 'AutomationUnavailable' || waiting.error === 'InvalidPosition' || waiting.reason === 'reverted_automation_unavailable' || waiting.reason === 'reverted_invalid_position')

/**
 * read-v6's answer with the approvals a step of this page gave back (Added 2026-10-06, rugged's answer of 6 Oct, §4 item
 * 6: read-v6 drops `custody_lost` only once it reads the position's custody again, up to about 30 minutes; "the app
 * keeps 'approved at block X' until positions[].state.snapshot.number ≥ X"). `approvedAt`: the block of this page's last
 * approval of the position for its automation (../automate/store.ts approvedAt). While read-v6's read of the position
 * is older than that block (or there is none), an active order of that automation's position is no longer blocked by
 * `custody_lost`, nor said to wait for the approval: the card says "On" at once, not "Approve again". Once read-v6 read
 * the position at or after the block, its own word stands. Pure; the same answer when nothing applies.
 */
export function withApprovals(body: PortfolioResponse, approvedAt: (chainId: V2ChainId, vault: string, tokenId: string) => bigint | null): PortfolioResponse {
  let changed = false
  const mandates = body.mandates.map((order) => {
    if (order.status !== 'active' || !order.blockedBy.includes('custody_lost')) return order
    const block = approvedAt(order.chainId, order.vault, order.tokenId)
    if (block === null) return order
    const at = order.vault.toLowerCase()
    const dex = body.vaults.find((v) => v.chainId === order.chainId && v.address.toLowerCase() === at)?.dex ?? null
    const read = body.positions.find((p) => p.chainId === order.chainId && p.tokenId === order.tokenId && (dex === null || p.dex === dex))
    if (read && read.state.status === 'live' && BigInt(read.state.snapshot.number) >= block) return order
    changed = true
    return { ...order, blockedBy: order.blockedBy.filter((code) => code !== 'custody_lost'), waiting: custodyWaiting(order.waiting) ? null : order.waiting }
  })
  return changed ? { ...body, mandates } : body
}

/**
 * read-v6's answer with the Auto-exits this page turned off on `chainId` (`off`, by id: ../automate/store.ts
 * sessionRevoked) listed as turned off while the index still lists them active (Added 2026-10-06, the final check F2's
 * review). So the automation's own word on its Auto-exit (./standing.ts exitStandingOf, its rearm) says what the card
 * says, as it will once the index lists the revocation: never "on" after a Turn off made here, with no way to turn it on
 * again until a reload. Pure; the same answer when nothing applies.
 */
export function withRevoked(body: PortfolioResponse, chainId: V2ChainId, off: ReadonlySet<string>): PortfolioResponse {
  let changed = false
  const mandates = body.mandates.map((order) => {
    if (order.status !== 'active' || order.chainId !== chainId || !off.has(order.mandateHash.toLowerCase())) return order
    changed = true
    return { ...order, status: 'revoked' as const, expired: false, blockedBy: [], waiting: null }
  })
  return changed ? { ...body, mandates } : body
}

/** `off`: the ids this page turned off (revoked) while the index may still list them active. */
export function exitCardState(orders: readonly Mandate[], mine: readonly SessionMandate[], off: ReadonlySet<string> = new Set()): ExitCardState {
  const active = orders.find((order) => order.status === 'active' && !order.expired && !off.has(order.mandateHash.toLowerCase())) ?? null
  if (active) {
    const id = active.mandateHash.toLowerCase() as Hex
    const reasons = active.blockedBy.map((code) => BLOCKED_TEXT_KEY[code]).filter((key): key is NonNullable<typeof key> => key !== undefined)
    if (reasons.length) return { kind: 'paused', id, triggers: listedTriggers(active), reasons, moduleOff: active.blockedBy.includes('module_disabled') }
    return { kind: 'on', id, triggers: listedTriggers(active), listed: true }
  }
  const registered = mine.find((entry) => entry.registered && !off.has(entry.id)) ?? null
  if (registered) return { kind: 'on', id: registered.id, triggers: registered.triggers ?? null, listed: false }
  const executed = orders.find((order) => order.status === 'executed') ?? null
  if (executed) {
    const delivered = executed.executed ? executed.executed.delivered.map((amount) => raw(amount)) : null
    return { kind: 'closed', id: executed.mandateHash.toLowerCase() as Hex, delivered }
  }
  return { kind: 'off' }
}

/**
 * Whether read-v6 lists an Auto-exit on this very position that counts as on: active and not expired (one paused still
 * counts: it closes the position once what blocks it is gone), not one this page turned off (`off`, as in
 * exitCardState), in a vault of the position's DEX (a v3 and a v4 NFT may share a number; an order whose vault is not
 * listed counts). Added 2026-10-06 (rugged's answer of 6 Oct, §4 item 7 and the spec delta §3: one Auto-exit per
 * position; a second one active on the same position executes with value zero when it fires, the operator paying its
 * gas): Auto-exit's dialog asks it right before the signature (./MandateDialog.tsx). Pure.
 */
export function exitOnPosition(body: Pick<PortfolioResponse, 'vaults' | 'mandates'>, chainId: V2ChainId, tokenId: string, dex: 3 | 4, off: ReadonlySet<string> = new Set()): boolean {
  return body.mandates.some((order) => {
    if (order.chainId !== chainId || order.tokenId !== tokenId || order.status !== 'active' || order.expired || off.has(order.mandateHash.toLowerCase())) return false
    const at = order.vault.toLowerCase()
    const vault = body.vaults.find((v) => v.chainId === chainId && v.address.toLowerCase() === at)
    return !vault || vault.dex === dex
  })
}

/**
 * Where a position stands with Auto-exit, from read-v6 (rugged97: "auto-exit has no fee compounding"; the plan: "do not
 * offer compounding on an auto-exit position"). Pure.
 *   - `on`: one of its Auto-exits is active (not expired, and not one this page turned off: `off`, as in exitCardState);
 *   - `vault`: none is, but the position is the root of a protection-only vault (paused, auto-exit on, or with Auto-exit
 *     listed on it after Leave automation turned the module off: ./standing.ts exitVaultOf): its Auto-exit is off, and it
 *     is turned back on in that vault, from the position's own page;
 *   - null: neither.
 * Set up automation offers no compounding on either, and no second Auto-exit.
 */
export type AutoExitStanding = 'on' | 'vault' | null

export function autoExitStanding(
  body: Pick<PortfolioResponse, 'vaults' | 'mandates'>,
  chainId: V2ChainId,
  tokenId: string,
  dex: 3 | 4,
  off: ReadonlySet<string> = new Set(),
): AutoExitStanding {
  const active = body.mandates.some(
    (order) => order.chainId === chainId && order.tokenId === tokenId && order.status === 'active' && !order.expired && !off.has(order.mandateHash.toLowerCase()),
  )
  if (active) return 'on'
  // The rule of ./standing.ts exitVaultOf, repeated here rather than imported: Set up automation reads this file, and an
  // import would split that small module into a chunk of its own (tests/v2/auto-exit-edges.test.mjs holds the two equal).
  const vault = vaultsOfPosition(body as PortfolioResponse, chainId, tokenId, dex).some(({ vault, role }) => {
    if (role !== 'root' || !(vault.state.status === 'read' ? vault.state.paused : vault.pausedBy !== null)) return false
    const at = vault.address.toLowerCase()
    return vault.autoExitEnabled || body.mandates.some((order) => order.chainId === chainId && order.vault.toLowerCase() === at && order.tokenId === tokenId)
  })
  return vault ? 'vault' : null
}
