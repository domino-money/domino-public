import { V2_CHAIN_IDS } from '../../config/chainIdentity'
import type { Address, V2ChainId } from '../../v2/types'

/**
 * A manual action on a vault's position, handed to the automation's panel on the position page (spec F7 rev2/rev3
 * §2.13). The S1 screens (the position page's own actions) offer it once their step is confirmed; the automation panel
 * of that position (./PositionAutomation.tsx) takes it and opens the vault's dialog at the step named, for the person to
 * confirm as any other:
 *   - `rearm` (rev2, decision #5): an increase, exit or collect on an armed root paused automation for it; the panel
 *     offers to turn it back on (approve the vault again when the wallet asks, then rearm(true), the consent asked again).
 *   - `reserves` (rev3, the V1 incident of 02/10): an S1 exit on a vault root leaves the fees the automation collected
 *     and had not reinvested in the vault; the panel opens at the reserves with "Withdraw to wallet" (withdrawReserves,
 *     in one EIP-5792 batch when the wallet has it).
 *   - `leave` (rev3 §2.13, §5.6): the main way out of automation is "Leave automation" (exitAll: successors and reserves
 *     back in one action), never a direct close of the root.
 *
 * In this page's memory only, one at a time, taken once: nothing is stored, and nothing here reads a chain or moves
 * anything. Domino V2 integration (2026-10-02): the vault half of src/v2ui/handoff.ts, copied for the integrated screens.
 */
export interface VaultHandoff {
  chainId: V2ChainId
  /** The vault (lowercase). */
  vault: Address
  focus: 'rearm' | 'reserves' | 'leave'
}

const ADDRESS = /^0x[0-9a-fA-F]{40}$/
const FOCUS: readonly VaultHandoff['focus'][] = ['rearm', 'reserves', 'leave']

let pending: VaultHandoff | null = null
const listeners = new Set<(handoff: VaultHandoff) => void>()

/** Offers the automation panel a vault at a step; a later offer replaces one that was not taken. Anything malformed is ignored. */
export function offerVault(handoff: VaultHandoff): void {
  // Any V2 chain the build serves (config/chainIdentity.ts V2_CHAIN_IDS; Changed on purpose 2026-11-07: the three were written out).
  if (!handoff || !V2_CHAIN_IDS.includes(handoff.chainId)) return
  if (typeof handoff.vault !== 'string' || !ADDRESS.test(handoff.vault) || !FOCUS.includes(handoff.focus)) return
  pending = Object.freeze({ chainId: handoff.chainId, vault: handoff.vault.toLowerCase() as Address, focus: handoff.focus })
  for (const listener of listeners) listener(pending)
}

/** The offer waiting for this vault on this chain, taken (a second call gets null); null when none waits for it. */
export function takeVault(chainId: V2ChainId, vault: Address): VaultHandoff | null {
  if (!pending || pending.chainId !== chainId || pending.vault !== vault.toLowerCase()) return null
  const taken = pending
  pending = null
  return taken
}

/** The offer waiting, without taking it. */
export const waitingVault = (): VaultHandoff | null => pending

/** Called on every offer; returns the unsubscribe. */
export function onVaultOffered(listener: (handoff: VaultHandoff) => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
