/**
 * Which way an S1 action is consented to (spec F7 §2.5.4, with its recommendations), as a pure decision over what the
 * wallet said (EIP-5792 `atomic` status on the action's chain) and what the chain says of the account (its code on the
 * action's chain: EIP-7702 delegation is per chain):
 *
 *   1. `batch`: the wallet batches atomically on this chain (`ready` or `supported`): one EIP-5792 batch with
 *      [approvals…, NFT approval?, the zap call], direct consent. Preferred over Permit2 whenever both are possible: it
 *      leaves no valid off-chain signature behind.
 *   2. `permit2`: create or increase from a PLAIN account (no code on this chain; any delegated or contract account is
 *      direct, OP8, since the app does not know which delegates implement EIP-1271), ERC-20 inputs only (Permit2 takes
 *      no native ETH), and the position for the connected wallet itself (no recipient the person chose).
 *   3. `direct`: one transaction at a time, each confirmed before the next: everything else (ETH inputs, a delegated or
 *      contract account, a change of range, an exit).
 * The relayed consent is never chosen (OP4: no relayer exists).
 *
 * Pure: no viem, no wallet.
 */
import { ZERO_ADDRESS, type ActionName, type Address } from '../types'

export type ConsentPath = 'batch' | 'permit2' | 'direct'
export type AtomicSupport = 'supported' | 'ready' | 'unsupported'
export type AccountKind = 'plain' | 'delegated' | 'contract'

export interface ConsentFacts {
  action: ActionName
  atomic: AtomicSupport
  account: AccountKind
  inputs: readonly { token: Address }[]
  /** A recipient other than the connected wallet, chosen by the person (never offered by this app's screens). */
  chosenRecipient: boolean
}

/** Why each path was or was not taken, for the review's Details. */
export interface ConsentChoice {
  path: ConsentPath
  /** The plan's consent: a batch is direct consent, sent whole. */
  planConsent: 'direct' | 'permit2'
  reason: 'wallet_batches' | 'plain_account_erc20' | 'native_input' | 'account_has_code' | 'chosen_recipient' | 'position_action' | 'no_inputs'
}

export function chooseConsent(facts: ConsentFacts): ConsentChoice {
  if (facts.atomic === 'ready' || facts.atomic === 'supported') return { path: 'batch', planConsent: 'direct', reason: 'wallet_batches' }
  if (facts.action !== 'create' && facts.action !== 'increase') return { path: 'direct', planConsent: 'direct', reason: 'position_action' }
  if (facts.inputs.length === 0) return { path: 'direct', planConsent: 'direct', reason: 'no_inputs' }
  if (facts.chosenRecipient) return { path: 'direct', planConsent: 'direct', reason: 'chosen_recipient' }
  if (facts.inputs.some((input) => input.token.toLowerCase() === ZERO_ADDRESS)) return { path: 'direct', planConsent: 'direct', reason: 'native_input' }
  if (facts.account !== 'plain') return { path: 'direct', planConsent: 'direct', reason: 'account_has_code' }
  return { path: 'permit2', planConsent: 'permit2', reason: 'plain_account_erc20' }
}
