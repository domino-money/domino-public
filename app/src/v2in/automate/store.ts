import type { Address, Hex, V2ChainId } from '../../v2/types'

/**
 * What the automation screens learned in THIS page session, from the steps this page itself sent (spec F7 §5.3, §5.4):
 * the vaults created or opened here, the vault events read from those steps' receipts, and the auto-exit orders signed
 * and registered here. Nothing is kept in the browser: a reload forgets it, and the chain and the V2 read API are the
 * only lasting sources. Pure (no React, no wallet): the screens subscribe through useSyncExternalStore.
 *
 * Why the events matter: the vault has no getter for who paused it or why its root was disarmed (§5.4: only the last
 * `AutomationPaused(actor)` and `RootDisarmed(reason)` logs say), and the app reads no logs. A receipt of a step this
 * page sent is one of those logs, with the `stateNonce` it moved the vault to. It is used only while the vault's live
 * `stateNonce` is still that one: anything that happened since (another tab, Domino's operator) makes it unknown again,
 * never guessed.
 *
 * Domino V2 integration (2026-10-02): the logic of src/v2ui/vault/store.ts, copied for the integrated screens.
 */

export interface VaultEvent {
  /** The vault's `stateNonce` right after the event. */
  stateNonce: bigint
  kind: 'paused' | 'resumed' | 'disarmed' | 'rearmed'
  /** AutomationPaused's actor. */
  actor?: Address
  /** RootDisarmed's reason. */
  reason?: number
}

/**
 * Added 2026-10-06 (the final check, F2): the auto-exit module a step of this page set on a vault, from its receipt's
 * `ExitModuleSet` (Leave automation's exitAll turns it off, "Turn back on" turns it on), with the `stateNonce` it moved
 * the vault to. `module` null: off (address(0)).
 */
export interface ExitModuleSet {
  stateNonce: bigint
  module: Address | null
}

export interface SessionMandate {
  chainId: V2ChainId
  owner: Address
  id: Hex
  nonce: bigint
  vault: Address
  tokenId: bigint
  /** True once its registration's receipt is in a block. */
  registered: boolean
  /**
   * Added 2026-10-06 (the owner's point 5): its two triggers as signed (0 is one that is off), so the position's card says
   * where it closes before the index lists it.
   */
  triggers?: { below: bigint; above: bigint }
}

interface State {
  vaults: ReadonlyMap<string, readonly Address[]>
  events: ReadonlyMap<string, VaultEvent>
  mandates: readonly SessionMandate[]
  /** Added 2026-10-06 (the owner's point 5): the Auto-exits this page turned off (revoked), by `${chainId}|${id}`. */
  revoked: ReadonlySet<string>
  /** Added 2026-10-06 (the final check, F2): the last ExitModuleSet a step of this page emitted, by vault. */
  modules: ReadonlyMap<string, ExitModuleSet>
  /**
   * Added 2026-10-06 (rugged's answer of 6 Oct, §4 item 6: "the app keeps 'approved at block X' until
   * positions[].state.snapshot.number ≥ X"): the block of the last step of this page that approved a position for its
   * automation, by `${chainId}|${vault}|${tokenId}`.
   */
  approvals: ReadonlyMap<string, bigint>
}

let state: State = { vaults: new Map(), events: new Map(), mandates: [], revoked: new Set(), modules: new Map(), approvals: new Map() }
const listeners = new Set<() => void>()
const emit = (next: State) => {
  state = next
  for (const listener of listeners) listener()
}

const ownerKey = (chainId: V2ChainId, owner: Address) => `${chainId}|${owner.toLowerCase()}`
const vaultKey = (chainId: V2ChainId, vault: Address) => `${chainId}|${vault.toLowerCase()}`

export const subscribeAutomation = (listener: () => void): (() => void) => {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
export const automationState = (): State => state

/** A vault created or opened from this page, for this wallet on this chain (kept first-seen first). */
export function rememberVault(chainId: V2ChainId, owner: Address, vault: Address): void {
  const key = ownerKey(chainId, owner)
  const known = state.vaults.get(key) ?? []
  const address = vault.toLowerCase() as Address
  if (known.includes(address)) return
  const vaults = new Map(state.vaults)
  vaults.set(key, Object.freeze([...known, address]))
  emit({ ...state, vaults })
}

export const sessionVaults = (s: State, chainId: V2ChainId, owner: Address): readonly Address[] => s.vaults.get(ownerKey(chainId, owner)) ?? []

/**
 * The vault events of one receipt, in log order (their names and arguments as finance/v2/vault.ts decodes them). The
 * last one that says something about pause or custody is kept, with the stateNonce it carries; and, apart from it
 * (Changed on purpose 2026-10-06, the final check F2), the last ExitModuleSet.
 */
export function recordVaultEvents(chainId: V2ChainId, vault: Address, events: readonly { address: string; eventName: string; args: Readonly<Record<string, unknown>> }[]): void {
  let last: VaultEvent | null = null
  let module: ExitModuleSet | null = null
  for (const event of events) {
    if (event.address.toLowerCase() !== vault.toLowerCase()) continue
    const nonce = event.args.stateNonce
    if (typeof nonce !== 'bigint') continue
    if (event.eventName === 'AutomationPaused' && typeof event.args.actor === 'string') last = { stateNonce: nonce, kind: 'paused', actor: event.args.actor.toLowerCase() as Address }
    else if (event.eventName === 'AutomationResumed') last = { stateNonce: nonce, kind: 'resumed' }
    else if (event.eventName === 'RootDisarmed' && typeof event.args.reason === 'number') last = { stateNonce: nonce, kind: 'disarmed', reason: event.args.reason }
    else if (event.eventName === 'RootRearmed') last = { stateNonce: nonce, kind: 'rearmed' }
    else if (event.eventName === 'ExitModuleSet' && typeof event.args.module === 'string') module = { stateNonce: nonce, module: /^0x0{40}$/i.test(event.args.module) ? null : (event.args.module.toLowerCase() as Address) }
  }
  const key = vaultKey(chainId, vault)
  const next = { ...state }
  if (last) next.events = new Map(state.events).set(key, Object.freeze(last))
  if (module) next.modules = new Map(state.modules).set(key, Object.freeze(module))
  if (last || module) emit(next)
}

/** The event this page saw last for a vault, only while the vault's live stateNonce is still the one it left. */
export function currentEvent(s: State, chainId: V2ChainId, vault: Address, liveStateNonce: bigint): VaultEvent | null {
  const event = s.events.get(vaultKey(chainId, vault))
  return event && event.stateNonce === liveStateNonce ? event : null
}

/**
 * Added 2026-10-06 (the final check, F2): the module a step of this page set on a vault, only while read-v6's listing
 * of that vault is older than that step (`listed`: the listing's stateNonce, null when its state was not read): the
 * index runs behind the chain. Null otherwise, and then the listing says it.
 */
export function exitModuleSet(s: State, chainId: V2ChainId, vault: string, listed: bigint | null): ExitModuleSet | null {
  const set = s.modules.get(`${chainId}|${vault.toLowerCase()}`)
  return set && (listed === null || listed < set.stateNonce) ? set : null
}

/** An order this page signed (and, once its registration is in a block, registered). */
export function rememberMandate(entry: SessionMandate): void {
  const rest = state.mandates.filter((m) => !(m.chainId === entry.chainId && m.id === entry.id))
  emit({ ...state, mandates: Object.freeze([...rest, Object.freeze({ ...entry, owner: entry.owner.toLowerCase() as Address, vault: entry.vault.toLowerCase() as Address })]) })
}

export const sessionMandates = (s: State, chainId: V2ChainId, owner: Address): readonly SessionMandate[] =>
  s.mandates.filter((m) => m.chainId === chainId && m.owner === owner.toLowerCase())

/**
 * Added 2026-10-06 (the owner's point 5): an Auto-exit this page turned off, once its revocation is in a block: the card
 * says "off" at once, whatever the index still lists, and this page's own registration of it no longer counts.
 */
export function rememberRevoked(chainId: V2ChainId, id: Hex): void {
  const key = `${chainId}|${id.toLowerCase()}`
  if (state.revoked.has(key)) return
  emit({ ...state, revoked: new Set([...state.revoked, key]) })
}

/** The Auto-exits this page turned off on a chain, by id. */
export const sessionRevoked = (s: State, chainId: V2ChainId): ReadonlySet<string> =>
  new Set([...s.revoked].filter((key) => key.startsWith(`${chainId}|`)).map((key) => key.slice(key.indexOf('|') + 1)))

const approvalKey = (chainId: V2ChainId, vault: string, tokenId: bigint | string) => `${chainId}|${vault.toLowerCase()}|${BigInt(tokenId)}`

/**
 * Added 2026-10-06 (rugged's answer of 6 Oct, §4 item 6): a position approved for its automation again by a step of this
 * page, from that step's receipt (the block it is in). The latest block is kept.
 */
export function rememberApproval(chainId: V2ChainId, vault: Address, tokenId: bigint, block: bigint): void {
  const key = approvalKey(chainId, vault, tokenId)
  const known = state.approvals.get(key)
  if (known !== undefined && known >= block) return
  emit({ ...state, approvals: new Map(state.approvals).set(key, block) })
}

/** The block of this page's last approval of a position for its automation, or null. */
export const approvedAt = (s: State, chainId: V2ChainId, vault: string, tokenId: bigint | string): bigint | null => s.approvals.get(approvalKey(chainId, vault, tokenId)) ?? null

/** Forgets everything (a test's fresh start). */
export function forgetAutomationSession(): void {
  emit({ vaults: new Map(), events: new Map(), mandates: [], revoked: new Set(), modules: new Map(), approvals: new Map() })
}
