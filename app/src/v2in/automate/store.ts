import { V2_CHAIN_IDS } from '../../config/chainIdentity'
import type { Address, Hex, V2ChainId } from '../../v2/types'
import { confirmedOperationState, subscribeConfirmedOperations, type ConfirmedOperation } from '../../lib/confirmedOperations'

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
  /** New registrations retain the NFT namespace. Older in-memory entries remain conservatively unqualified. */
  dex?: 3 | 4
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
  /** Canonical, receipt-proved effects. No balance or liquidity is inferred from these records. */
  proofs: readonly ConfirmedOperation[]
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

const emptyState = (): State => ({ proofs: [], vaults: new Map(), events: new Map(), mandates: [], revoked: new Set(), modules: new Map(), approvals: new Map() })
let base = emptyState()
let state = base
const proofs = new Map<string, ConfirmedOperation>()
const proofApprovals = new Map<string, { chainId: V2ChainId; vault: Address; tokenId: bigint; block: bigint }[]>()
const proofKey = (op: ConfirmedOperation) => `${op.chainId}:${op.hash}:${op.blockHash}`
const canonical = () => [...proofs.values()].filter(op => op.phase !== 'reorged').sort((a, b) => a.block - b.block || a.at - b.at)
const matchingProof = (chainId: V2ChainId, match: (op: ConfirmedOperation) => boolean) => [...proofs.values()].reverse().find(op => op.chainId === chainId && match(op))
const listeners = new Set<() => void>()
const emit = (next: State) => {
  base = next
  state = projectProofs(base)
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
  if (matchingProof(chainId, op => op.wallet === owner.toLowerCase() && op.events.some(event =>
    event.eventName === 'Initialized' && event.address.toLowerCase() === vault.toLowerCase() && String(event.args.owner).toLowerCase() === owner.toLowerCase()
    || event.eventName === 'VaultCreated' && String(event.args.vault).toLowerCase() === vault.toLowerCase() && String(event.args.owner).toLowerCase() === owner.toLowerCase()))) return
  const key = ownerKey(chainId, owner)
  const known = base.vaults.get(key) ?? []
  const address = vault.toLowerCase() as Address
  if (known.includes(address)) return
  const vaults = new Map(base.vaults)
  vaults.set(key, Object.freeze([...known, address]))
  emit({ ...base, vaults })
}

export const sessionVaults = (s: State, chainId: V2ChainId, owner: Address): readonly Address[] => s.vaults.get(ownerKey(chainId, owner)) ?? []

/**
 * The vault events of one receipt, in log order (their names and arguments as finance/v2/vault.ts decodes them). The
 * last one that says something about pause or custody is kept, with the stateNonce it carries; and, apart from it
 * (Changed on purpose 2026-10-06, the final check F2), the last ExitModuleSet.
 */
export function recordVaultEvents(chainId: V2ChainId, vault: Address, events: readonly { address: string; eventName: string; args: Readonly<Record<string, unknown>> }[]): void {
  // Steps publish their verified receipt before this legacy callback. Keep its effects in the
  // proof layer so a reorg can remove that transaction without erasing a newer operation.
  if (matchingProof(chainId, op => op.events === events || events.some(event => event.address.toLowerCase() === vault.toLowerCase() && op.events.some(proved =>
    proved.address.toLowerCase() === event.address.toLowerCase() && proved.eventName === event.eventName && typeof event.args.stateNonce === 'bigint' && proved.args.stateNonce === event.args.stateNonce)))) return
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
  const next = { ...base }
  if (last && last.stateNonce >= (base.events.get(key)?.stateNonce ?? -1n)) next.events = new Map(base.events).set(key, Object.freeze(last))
  if (module && module.stateNonce >= (base.modules.get(key)?.stateNonce ?? -1n)) next.modules = new Map(base.modules).set(key, Object.freeze(module))
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
  const proved = entry.registered && matchingProof(entry.chainId, op => op.events.some(event => event.eventName === 'MandateRegistered' && String(event.args.mandateHash).toLowerCase() === entry.id.toLowerCase()))
  const rest = base.mandates.filter((m) => !(m.chainId === entry.chainId && m.id.toLowerCase() === entry.id.toLowerCase()))
  emit({ ...base, mandates: Object.freeze([...rest, Object.freeze({ ...entry, id: entry.id.toLowerCase() as Hex, registered: proved ? false : entry.registered, owner: entry.owner.toLowerCase() as Address, vault: entry.vault.toLowerCase() as Address })]) })
}

export const sessionMandates = (s: State, chainId: V2ChainId, owner: Address): readonly SessionMandate[] =>
  s.mandates.filter((m) => m.chainId === chainId && m.owner === owner.toLowerCase())

export const sessionMandatesFor = (s: State, chainId: V2ChainId, owner: Address, tokenId: bigint, dex: 3 | 4): readonly SessionMandate[] =>
  sessionMandates(s, chainId, owner).filter((m) => m.tokenId === tokenId && (m.dex === undefined || m.dex === dex))

/**
 * Added 2026-10-06 (the owner's point 5): an Auto-exit this page turned off, once its revocation is in a block: the card
 * says "off" at once, whatever the index still lists, and this page's own registration of it no longer counts.
 */
export function rememberRevoked(chainId: V2ChainId, id: Hex): void {
  if (matchingProof(chainId, op => op.events.some(event => event.eventName === 'MandateRevoked' && String(event.args.mandateHash).toLowerCase() === id.toLowerCase()))) return
  const key = `${chainId}|${id.toLowerCase()}`
  if (base.revoked.has(key)) return
  emit({ ...base, revoked: new Set([...base.revoked, key]) })
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
  const proof = matchingProof(chainId, op => op.block === Number(block) && op.vault === vault.toLowerCase())
  if (proof) {
    if (proof.phase === 'reorged') return
    const key = proofKey(proof)
    const entries = proofApprovals.get(key) ?? []
    proofApprovals.set(key, [...entries.filter(one => one.tokenId !== tokenId || one.vault !== vault), { chainId, vault, tokenId, block }])
    emit(base)
    return
  }
  const key = approvalKey(chainId, vault, tokenId)
  const known = base.approvals.get(key)
  if (known !== undefined && known >= block) return
  emit({ ...base, approvals: new Map(base.approvals).set(key, block) })
}

/** The block of this page's last approval of a position for its automation, or null. */
export const approvedAt = (s: State, chainId: V2ChainId, vault: string, tokenId: bigint | string): bigint | null => s.approvals.get(approvalKey(chainId, vault, tokenId)) ?? null

/** Receipt effects are replayed over the session baseline. Removal never clears another transaction's effects. */
function projectProofs(before: State): State {
  const next: State = { ...before, proofs: Object.freeze([...proofs.values()]), vaults: new Map(before.vaults), events: new Map(before.events), modules: new Map(before.modules), revoked: new Set(before.revoked), approvals: new Map(before.approvals), mandates: [...before.mandates] }
  const vaults = next.vaults as Map<string, readonly Address[]>
  const events = next.events as Map<string, VaultEvent>
  const modules = next.modules as Map<string, ExitModuleSet>
  const revoked = next.revoked as Set<string>
  const approvals = next.approvals as Map<string, bigint>
  for (const op of canonical()) {
    const chainId = op.chainId as V2ChainId
    for (const event of op.events) {
      const args = event.args
      if ((event.eventName === 'Initialized' || event.eventName === 'VaultCreated') && String(args.owner).toLowerCase() === op.wallet) {
        const vault = (event.eventName === 'Initialized' ? event.address : String(args.vault)).toLowerCase() as Address
        if (/^0x[0-9a-f]{40}$/.test(vault)) {
          const key = ownerKey(chainId, op.wallet as Address)
          const known = vaults.get(key) ?? []
          if (!known.includes(vault)) vaults.set(key, Object.freeze([...known, vault]))
        }
      }
      const nonce = args.stateNonce
      const key = vaultKey(chainId, event.address as Address)
      if (typeof nonce === 'bigint') {
        let effect: VaultEvent | null = null
        if (event.eventName === 'AutomationPaused' && typeof args.actor === 'string') effect = { stateNonce: nonce, kind: 'paused', actor: args.actor.toLowerCase() as Address }
        else if (event.eventName === 'AutomationResumed') effect = { stateNonce: nonce, kind: 'resumed' }
        else if (event.eventName === 'RootDisarmed' && typeof args.reason === 'number') effect = { stateNonce: nonce, kind: 'disarmed', reason: args.reason }
        else if (event.eventName === 'RootRearmed') effect = { stateNonce: nonce, kind: 'rearmed' }
        if (effect && nonce >= (events.get(key)?.stateNonce ?? -1n)) events.set(key, Object.freeze(effect))
        if (event.eventName === 'ExitModuleSet' && typeof args.module === 'string' && nonce >= (modules.get(key)?.stateNonce ?? -1n)) modules.set(key, Object.freeze({ stateNonce: nonce, module: /^0x0{40}$/i.test(args.module) ? null : args.module.toLowerCase() as Address }))
      }
      if (event.eventName === 'MandateRegistered' && String(args.owner).toLowerCase() === op.wallet) next.mandates = next.mandates.map(entry => entry.chainId === chainId && entry.owner === op.wallet && entry.id === String(args.mandateHash).toLowerCase() && entry.vault === String(args.vault).toLowerCase() && String(entry.tokenId) === String(args.tokenId) ? Object.freeze({ ...entry, registered: true }) : entry)
      if (event.eventName === 'MandateRevoked' && typeof args.mandateHash === 'string') revoked.add(`${chainId}|${args.mandateHash.toLowerCase()}`)
    }
    for (const approval of proofApprovals.get(proofKey(op)) ?? []) {
      const key = approvalKey(approval.chainId, approval.vault, approval.tokenId)
      approvals.set(key, approvals.has(key) && approvals.get(key)! > approval.block ? approvals.get(key)! : approval.block)
    }
  }
  next.mandates = Object.freeze(next.mandates)
  return next
}

/** Called by the shared public-confirmation subscription, including when a receipt is later reorganized. */
export function applyAutomationProof(operation: ConfirmedOperation): void {
  // Any V2 chain the build serves (config/chainIdentity.ts V2_CHAIN_IDS; Changed on purpose 2026-11-07: the three were written out).
  if (!V2_CHAIN_IDS.includes(operation.chainId)) return
  for (const [key, old] of proofs) if (old.chainId === operation.chainId && old.hash === operation.hash && old.blockHash !== operation.blockHash) { proofs.delete(key); proofApprovals.delete(key) }
  const key = proofKey(operation)
  proofs.set(key, operation)
  if (operation.phase === 'reorged') proofApprovals.delete(key)
  while (proofs.size > 64) {
    const oldest = proofs.keys().next().value as string
    proofs.delete(oldest)
    proofApprovals.delete(oldest)
  }
  emit(base)
}

export interface ConfirmedAutomationStanding {
  vault: Address
  block: number
  name: 'Auto-exit' | 'Auto-compound' | 'Domino-compound' | null
  word: 'Paused' | 'Off' | 'Completed' | 'Automation off' | 'Updating' | null
  running: boolean
}

/** Presentation only: exact NFT scope, concrete events, and only while the index is older than the receipt. */
export function confirmedPositionAutomation(s: State, position: {
  chainId: number; positionManager: string; tokenId: string; dex?: 3 | 4; wallet?: string; vault?: string; listedBlock: number | null; listedNonce?: bigint | null; halted?: boolean
}, indexed?: { mode: 'simple' | 'domino'; paused: boolean; armed: boolean | null; module: string | null; hasExit: boolean; activeExitIds: readonly string[]; blockedExitIds?: readonly string[] }): ConfirmedAutomationStanding | null {
  if (!position.wallet) return null
  const all = s.proofs.filter(op => op.phase !== 'reorged' && op.chainId === position.chainId && op.wallet === position.wallet!.toLowerCase() && (!op.positionManager || op.positionManager === position.positionManager.toLowerCase()))
  const scoped = all.filter(op => op.positionManager === position.positionManager.toLowerCase() && op.tokenIds.includes(position.tokenId))
  const initialized = scoped.flatMap(op => op.events.filter(event => event.eventName === 'Initialized' && String(event.args.rootTokenId) === position.tokenId && String(event.args.owner).toLowerCase() === op.wallet && (position.dex === undefined || Number(event.args.dex) === position.dex)).map(event => ({ op, event })))
  const vault = position.vault?.toLowerCase() ?? initialized.at(-1)?.event.address.toLowerCase()
  if (!vault) return null
  const affecting = all.filter(op => op.vault === vault || op.events.some(event => event.address.toLowerCase() === vault || String(event.args.vault).toLowerCase() === vault))
    .filter(op => op.block > (position.listedBlock ?? 0)).sort((a, b) => a.block - b.block || a.at - b.at)
  if (!affecting.length) return null
  let mode: 'simple' | 'domino' | null = indexed?.mode ?? null
  let paused: boolean | null = indexed?.paused ?? null
  let armed: boolean | null = indexed?.armed ?? null
  let module: string | null | undefined = indexed?.module
  let hasExit = indexed?.hasExit ?? false
  let active = !!indexed?.activeExitIds.length
  let closed = false
  const orders = new Map<string, boolean>(indexed?.activeExitIds.map(id => [id.toLowerCase(), true]) ?? [])
  const blocked = new Set(indexed?.blockedExitIds?.map(id => id.toLowerCase()) ?? [])
  // Registered session forms supply no financial state; their exact receipt supplies registration.
  for (const entry of s.mandates) if (entry.chainId === position.chainId && entry.owner === position.wallet?.toLowerCase() && String(entry.tokenId) === position.tokenId && (entry.dex === undefined || position.dex === undefined || entry.dex === position.dex) && entry.vault === vault && entry.registered) orders.set(entry.id, !s.revoked.has(`${entry.chainId}|${entry.id}`))
  let applied = false
  for (const op of affecting) for (const event of op.events) {
    const args = event.args
    if (event.address.toLowerCase() === vault) {
      // A newer nonce from another tab/operator already supersedes these old vault effects.
      if (typeof args.stateNonce === 'bigint' && position.listedNonce !== null && position.listedNonce !== undefined && args.stateNonce <= position.listedNonce) continue
      if (event.eventName === 'Initialized' && indexed) continue
      if (['Initialized', 'PolicyChanged', 'AutomationPaused', 'AutomationResumed', 'RootDisarmed', 'RootRearmed', 'ExitModuleSet', 'ExitExecuted'].includes(event.eventName)) applied = true
      if (event.eventName === 'Initialized') { if (args.mode === 1 || args.mode === 1n) mode = 'simple'; else if (args.mode === 2 || args.mode === 2n) mode = 'domino' }
      if (event.eventName === 'PolicyChanged' && args.policy && typeof args.policy === 'object') { const value = (args.policy as { mode?: unknown }).mode; if (value === 1 || value === 1n) mode = 'simple'; else if (value === 2 || value === 2n) mode = 'domino' }
      if (event.eventName === 'AutomationPaused') paused = true
      if (event.eventName === 'AutomationResumed') paused = false
      if (event.eventName === 'RootDisarmed') armed = false
      if (event.eventName === 'RootRearmed') armed = true
      if (event.eventName === 'ExitModuleSet' && typeof args.module === 'string') module = /^0x0{40}$/i.test(args.module) ? null : args.module.toLowerCase()
      if (event.eventName === 'ExitExecuted' && String(args.tokenId) === position.tokenId) { closed = true; hasExit = true }
    }
    if (event.eventName === 'MandateRegistered' && String(args.vault).toLowerCase() === vault && String(args.tokenId) === position.tokenId && (!position.wallet || String(args.owner).toLowerCase() === position.wallet.toLowerCase())) { applied = true; hasExit = true; const id = String(args.mandateHash).toLowerCase(); orders.set(id, true); blocked.delete(id) }
    if (event.eventName === 'MandateRevoked' && typeof args.mandateHash === 'string' && orders.has(args.mandateHash.toLowerCase())) { applied = true; orders.set(args.mandateHash.toLowerCase(), false) }
  }
  if (!applied) return null
  if (orders.size) active = [...orders.values()].some(Boolean)
  const block = affecting.at(-1)!.block
  const canExit = [...orders].some(([id, enabled]) => enabled && !blocked.has(id))
  if (hasExit && paused !== false) return { vault: vault as Address, block, name: 'Auto-exit', word: closed ? 'Completed' : !active ? 'Off' : position.halted || !canExit || module === null ? 'Paused' : module === undefined ? 'Updating' : null, running: !closed && canExit && !position.halted && module !== null && module !== undefined }
  const name = mode === null ? null : mode === 'domino' ? 'Domino-compound' : 'Auto-compound'
  return { vault: vault as Address, block, name, word: armed === false ? 'Automation off' : paused === true || position.halted ? 'Paused' : paused === null || armed === null ? 'Updating' : null, running: name !== null && paused === false && armed === true && !position.halted }
}

/** Forgets everything (a test's fresh start). */
export function forgetAutomationSession(): void {
  proofs.clear()
  proofApprovals.clear()
  emit(emptyState())
}

for (const operation of confirmedOperationState()) applyAutomationProof(operation)
subscribeConfirmedOperations(applyAutomationProof)
