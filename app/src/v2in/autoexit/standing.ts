import type { Mandate, Vault } from 'api-contracts/read-v6/types'

/**
 * Where the Auto-exit of Auto-exit's own vault stands (decision #25: the protection-only vault), from read-v6's orders of
 * its root, never from the vault alone: its pause and its module stay after a "Turn off", an expiry or an exit. Added
 * 2026-10-06 (the review of the owner's point 5), for the Positions rows' badge (../lists/model.ts) and the automation's
 * cards (../automate/vaultView.ts). Pure, types only, so the lists need nothing else of the automation screens.
 *   - `closed`: Auto-exit completed (its root disarmed by it, or one of its orders executed); not proof of value withdrawn;
 *   - `on`: one of its root's orders is active and not expired, nothing keeping it from closing;
 *   - `paused`: one is, but something keeps it from closing (§4.5: the approval lost, auto-exit off, a halt);
 *   - `off`: none is.
 *
 * Changed on purpose 2026-10-06 (the integration review, rugged-literal #1): `paused` comes from the active order's
 * `blockedBy` alone, as rugged97's §4.5 table, his backend's `blockedBy` and the module's `executeExit` ("an exit needs
 * the approval only") have it; never from the vault's live `rootArmed` (read-v6's `custody.armed`), which any change to
 * the root turns false (Collect fees, Add liquidity, Leave automation) while the exit can still fire. Changed on purpose
 * 2026-10-06 (the integration review, rugged-literal #2): Leave automation (`exitAll`) turns the vault's module off and
 * pauses it; a paused vault with Auto-exit listed on its root stays Auto-exit's, never a compounding one's.
 */
export type ProtectionStanding = 'on' | 'paused' | 'off' | 'closed'

/**
 * The `blockedBy` codes that keep an active Auto-exit from closing its position: exactly those the position's card says
 * (../automate/portfolio.ts BLOCKED_TEXT_KEY; tests/v2/auto-exit-edges.test.mjs holds the two equal). `custody_unread`
 * says nothing either way, and an expired one is not active.
 */
export const EXIT_BLOCKERS: ReadonlySet<string> = new Set(['module_disabled', 'automation_halted', 'custody_lost', 'not_in_vault', 'vault_not_domino'])

/** Whether a listed vault is paused: its state's `paused` when read, else `pausedBy` (null only while it runs). */
const pausedOf = (vault: Vault): boolean => (vault.state.status === 'read' ? vault.state.paused : vault.pausedBy !== null)

/** read-v6's Auto-exit orders of a listed vault's root, in any status. */
function rootOrders(vault: Vault, mandates: readonly Mandate[]): readonly Mandate[] {
  const at = vault.address.toLowerCase()
  return mandates.filter((order) => order.chainId === vault.chainId && order.vault.toLowerCase() === at && order.tokenId === vault.rootTokenId)
}

/**
 * Whether a listed vault is Auto-exit's own: paused, with its auto-exit module on, or with Auto-exit listed on its root
 * (Leave automation turned the module off). `now`: the vault's pause and module as the chain reads them now (a read made
 * right after an action on this page), in place of the listing's.
 */
export function exitVaultOf(vault: Vault, mandates: readonly Mandate[], now?: { paused: boolean; autoExitEnabled: boolean }): boolean {
  const paused = now ? now.paused : pausedOf(vault)
  const module = now ? now.autoExitEnabled : vault.autoExitEnabled
  return paused && (module || rootOrders(vault, mandates).length > 0)
}

/** Auto-exit's standing for a listed vault that is Auto-exit's own (exitVaultOf); null for any other vault. */
export function protectionStanding(vault: Vault, mandates: readonly Mandate[]): ProtectionStanding | null {
  return exitVaultOf(vault, mandates) ? exitStandingOf(vault, mandates) : null
}

/** The same from the listed vault's root orders, whatever the listing says of its pause and module (a vault the chain reads as Auto-exit's now). */
export function exitStandingOf(vault: Vault, mandates: readonly Mandate[]): ProtectionStanding {
  const orders = rootOrders(vault, mandates)
  const root = vault.members.find((member) => member.role === 'root')
  if (vault.custody.reason === 'auto_exit' || root?.disarmReason === 'auto_exit' || orders.some((order) => order.status === 'executed')) return 'closed'
  const active = orders.find((order) => order.status === 'active' && !order.expired)
  if (!active) return 'off'
  return active.blockedBy.some((code) => EXIT_BLOCKERS.has(code)) ? 'paused' : 'on'
}
