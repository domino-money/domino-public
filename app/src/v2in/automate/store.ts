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
}

let state: State = { vaults: new Map(), events: new Map(), mandates: [], revoked: new Set() }
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
 * last one that says something about pause or custody is kept, with the stateNonce it carries.
 */
export function recordVaultEvents(chainId: V2ChainId, vault: Address, events: readonly { address: string; eventName: string; args: Readonly<Record<string, unknown>> }[]): void {
  let last: VaultEvent | null = null
  for (const event of events) {
    if (event.address.toLowerCase() !== vault.toLowerCase()) continue
    const nonce = event.args.stateNonce
    if (typeof nonce !== 'bigint') continue
    if (event.eventName === 'AutomationPaused' && typeof event.args.actor === 'string') last = { stateNonce: nonce, kind: 'paused', actor: event.args.actor.toLowerCase() as Address }
    else if (event.eventName === 'AutomationResumed') last = { stateNonce: nonce, kind: 'resumed' }
    else if (event.eventName === 'RootDisarmed' && typeof event.args.reason === 'number') last = { stateNonce: nonce, kind: 'disarmed', reason: event.args.reason }
    else if (event.eventName === 'RootRearmed') last = { stateNonce: nonce, kind: 'rearmed' }
  }
  if (!last) return
  const events2 = new Map(state.events)
  events2.set(vaultKey(chainId, vault), Object.freeze(last))
  emit({ ...state, events: events2 })
}

/** The event this page saw last for a vault, only while the vault's live stateNonce is still the one it left. */
export function currentEvent(s: State, chainId: V2ChainId, vault: Address, liveStateNonce: bigint): VaultEvent | null {
  const event = s.events.get(vaultKey(chainId, vault))
  return event && event.stateNonce === liveStateNonce ? event : null
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

/** Forgets everything (a test's fresh start). */
export function forgetAutomationSession(): void {
  emit({ vaults: new Map(), events: new Map(), mandates: [], revoked: new Set() })
}
