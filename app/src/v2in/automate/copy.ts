import { MANDATE_REASON_TEXT, mandateInvalidText, type MandateReason } from '../../finance/v2/autoExit'
import { VAULT_TEXT } from '../../finance/v2/vault'
import { personRefused } from '../../finance/nonce'
import { CONTRACTS_NOT_LIVE } from '../../finance/v2/liveLock'
import { v2Chain } from '../../v2/chains'
import { DECLINED_COPY, decodeV2Error, shortTokenLabel, type ErrorLabels, type Recovery } from '../../v2/errors'
import type { Address } from '../../v2/types'

/**
 * The words the automation screens show for a failure (spec F7 §4.9, §5.8, PHASE B ground rule 4). Every error goes
 * through src/v2/errors.ts decodeV2Error first: a contract's revert (the vault's, the module's, a simulation's) and the
 * wallet's 4001 and 4902 are said in the spec's English. What it does not know is one of the money clients' closed
 * codes (`vault_*`, `mandate_*`, `wallet_*`, `deployment_*`), said here. The code itself is never in the text: it goes
 * in a `data-error-code` attribute. Pure.
 *
 * Domino V2 integration (2026-10-02): the logic of src/v2ui/vault/copy.ts, copied for the integrated screens.
 */

export interface ErrorView {
  text: string
  code: string
  /**
   * A contract's refusal: what the screen may offer next (src/v2/errors.ts). Added 2026-10-04 for the withdrawal's
   * "Send to another address you own" (`send-elsewhere`, rugged97's delta of 4 Oct §2 item 1).
   */
  recovery?: Recovery
}

const SLOW = 'The step took too long to reach your wallet. Try again.'
const UNKNOWN_CONTRACT = "Domino's contracts on {chain} aren't the ones this app knows. Nothing was sent."
const CHANGED = 'Something changed since your review. Review again.'
const WALLET_FAILED = 'Your wallet could not complete this step. Check your wallet activity before trying again: nothing is sent twice.'

/** The closed codes' sentences ({chain} and {token} filled from the labels). */
export const CLOSED_TEXT: Readonly<Record<string, string>> = Object.freeze({
  ...VAULT_TEXT,
  vault_halted: VAULT_TEXT.vault_halted,
  vault_position_not_found: "This position doesn't exist on {chain} for the Uniswap version you chose.",
  vault_reserves_empty: 'Your automation holds nothing to withdraw now.',
  vault_root_not_owned: "This position isn't in your connected wallet.",
  vault_invalid_token_id: 'Enter the number of one of your positions.',
  vault_invalid_dex: 'Choose the Uniswap version of this position.',
  vault_invalid_request: 'Review the settings, then try again.',
  vault_step_not_needed: 'This step is already done.',
  vault_review_stale: CHANGED,
  vault_step_out_of_order: CHANGED,
  vault_review_unknown: CHANGED,
  vault_step_unknown: CHANGED,
  vault_unknown: "Domino didn't set up this automation.",
  vault_identity_mismatch: "Domino didn't set up this automation.",
  vault_invalid_address: "That isn't an automation's address.",
  vault_child_is_root: "This position can't be withdrawn this way.",
  vault_child_inactive: "This position can't be withdrawn this way.",
  vault_position_not_held: "Your automation doesn't hold this position.",
  vault_nothing_to_revoke: 'Your automation has no approval on this position.',
  vault_not_subscribed: "Domino isn't connected to this position anymore.",
  vault_unsubscribe_v4_only: 'This only applies to Uniswap v4 positions.',
  vault_exit_module_refused: "This automation can only use Domino's own Auto-exit.",
  vault_invalid_token: "That isn't a token address.",
  vault_token_not_in_pool: "This token isn't one of this pool's two tokens.",
  vault_prediction_invalid: "Your new automation's address couldn't be worked out. Nothing was sent.",
  vault_action_unknown: CHANGED,
  // Changed on purpose 2026-10-06 (the owner's point 5): Auto-exit by its name, never an "order".
  mandate_invalid_request: 'Check your Auto-exit, then try again.',
  mandate_nonce_unavailable: "A fresh signature number couldn't be chosen. Try again.",
  mandate_already_signed: 'This Auto-exit is already signed.',
  mandate_nonce_held: 'This Auto-exit is signed and waiting. Finish turning it on, or cancel it.',
  // Changed on purpose 2026-10-06 (rugged's answer of 6 Oct: the spec delta §3): the page's own checks before the
  // module's NonceAlreadyUsed and MandateNotActive say the delta's words for them (src/v2/errors.ts AUTO_EXIT_ERRORS).
  mandate_nonce_used: 'This signature was already used or cancelled. Sign a new one.',
  mandate_review_unknown: CHANGED,
  mandate_review_stale: CHANGED,
  mandate_step_unknown: CHANGED,
  mandate_step_is_signature: CHANGED,
  mandate_step_not_needed: 'This step is already done.',
  mandate_not_signed: 'Sign your Auto-exit first.',
  mandate_signature_mismatch: "Your wallet's signature can't be used for this Auto-exit.",
  mandate_module_not_enabled: 'Turn on Auto-exit for your automation first.',
  mandate_already_registered: 'This Auto-exit is already on.',
  mandate_not_active: 'This Auto-exit is no longer on.',
  // Added 2026-10-06 (rugged's answer of 6 Oct, §4 item 7: one Auto-exit per position; a second one active on the same
  // position executes with value zero, the operator paying its gas): read-v6 lists one on this position, on another page
  // or tab (../autoexit/MandateDialog.tsx, right before the signature). Set up automation's own words for it.
  mandate_already_on: 'Auto-exit is already on for this position.',
  mandate_not_owner: 'Only the owner of this automation can do this.',
  mandate_invalid_id: CHANGED,
  mandate_invalid_nonce: CHANGED,
  mandate_nonce_not_held: "This signed Auto-exit isn't waiting on this page.",
  // Added 2026-10-06 (the review of point 5): the pool's own price, which the edges are chosen against.
  mandate_price_unavailable: "The pool's price couldn't be read. Try again in a moment.",
  claim_invalid_token: "That isn't a token address.",
  claim_invalid_recipient: 'Choose a valid address to receive the funds.',
  claim_nothing: 'Nothing to claim in {token}.',
  signature_high_s: "Your wallet's signature can't be used for this Auto-exit.",
  signature_not_from_owner: "The signature isn't from the owner of this automation.",
  invalid_signature: "Your wallet's signature can't be used for this Auto-exit.",
  typed_data_chain_mismatch: 'Your wallet is on another network. Switch to {chain}, then try again.',
  typed_data_signer_mismatch: 'Only the owner of this automation can do this.',
  deployment_missing: UNKNOWN_CONTRACT,
  deployment_code_changed: UNKNOWN_CONTRACT,
  deployment_identity_changed: UNKNOWN_CONTRACT,
  deployment_read_invalid: UNKNOWN_CONTRACT,
  deployment_chain_mismatch: UNKNOWN_CONTRACT,
  deployment_component_unknown: UNKNOWN_CONTRACT,
  deployment_fixture_refused: UNKNOWN_CONTRACT,
  deployment_not_pinned: UNKNOWN_CONTRACT,
  deployment_invalid: UNKNOWN_CONTRACT,
  // The integrated screens never say "V2" (the owner, 2026-10-02).
  chain_not_supported: "This isn't available on this network yet.",
  // finance/v2/liveLock.ts: nothing is sent or signed before Domino's new contracts are live on the chain, in the gate's words.
  contracts_not_live: "This opens as soon as Domino's service is live on {chain}.",
  connect_wallet: 'Connect your wallet first.',
  wallet_wrong_chain: 'Your wallet is on another network. Switch to {chain}, then try again.',
  wallet_identity_changed: 'Your wallet account or network changed. Nothing was sent.',
  wallet_action_busy: 'Your wallet is still busy with the previous step. Wait for it, then try again.',
  wallet_action_expired: SLOW,
  wallet_timeout: SLOW,
  wallet_review_expired: SLOW,
  wallet_review_required: SLOW,
  pending_wallet_transaction: 'Your wallet has a transaction waiting. Let it finish, then try again.',
  native_gas_reserve_insufficient: 'Your ETH does not cover the network fee for this step.',
  gas_budget_exceeded: 'This step needs more gas than expected. Try again in a moment.',
  invalid_gas_budget: 'The network fee could not be worked out. Try again in a moment.',
  invalid_wallet_reply: WALLET_FAILED,
  invalid_wallet_quantity: WALLET_FAILED,
  wallet_result_unknown: WALLET_FAILED,
  receipt_reverted: 'The transaction reverted on chain. Nothing changed; only network gas was spent.',
  receipt_reorged: 'The block that held the transaction left the chain. Check your wallet activity before trying again.',
  receipt_unknown: 'The transaction was sent, but its outcome could not be read. Check your wallet activity before trying again.',
  receipt_duplicate_action: 'The transaction was sent, but its outcome could not be read. Check your wallet activity before trying again.',
  review_already_sent: "This step was already sent from this page, and its outcome isn't known yet. Check your wallet activity before trying again.",
  l1_fee_unavailable: "The network fee on {chain} couldn't be worked out. Try again in a moment.",
  batch_not_included: 'Your wallet did not run these calls. Nothing changed.',
  batch_reverted: 'The calls reverted together on chain. Nothing changed; only network gas was spent.',
  batch_already_offered: 'These calls are already waiting in your wallet. Check your wallet before trying again.',
  wallet_batch_already_offered: 'These calls are already waiting in your wallet. Check your wallet before trying again.',
  batch_unsupported: "Your wallet can't send these calls together. Confirm them one at a time.",
  batch_upgrade_declined: "Your wallet can't send these calls together. Confirm them one at a time.",
  batch_simulation_unavailable: "Your wallet can't check these calls together. Confirm them one at a time.",
  batch_simulation_reverted: 'These calls would fail together. Confirm them one at a time.',
  batch_not_needed: 'Only one call is needed now.',
  batch_coordination_unavailable: "These calls can't be sent together from this browser. Confirm them one at a time.",
})

const SENT_OUTCOMES: ReadonlySet<string> = new Set(['receipt_reverted', 'receipt_reorged', 'receipt_unknown', 'receipt_duplicate_action'])
/** The batch path's own codes (some carry the word "reverted", which decodeV2Error would read as revert data). */
const isBatchCode = (message: string) => /^(?:wallet_)?batch_[a-z_]+$/.test(message) && Object.hasOwn(CLOSED_TEXT, message)

/** Codes after which a batch gives way to the steps, one confirmation each: the wallet cannot batch these calls. */
export const STEPS_INSTEAD: ReadonlySet<string> = new Set(['batch_unsupported', 'batch_upgrade_declined', 'batch_simulation_unavailable', 'batch_simulation_reverted', 'batch_not_needed', 'batch_coordination_unavailable', 'invalid_simulation_reply'])

/** A closed code and its detail ("mandate_invalid: mandate_slippage mandate_valid_until"). */
function closedCode(error: unknown): { code: string; detail: string[] } | null {
  if (!(error instanceof Error) || typeof error.message !== 'string') return null
  const match = /^([a-z][a-z0-9_]{1,63})(?::\s*([a-z0-9_ ]*))?$/.exec(error.message)
  if (!match) return null
  return { code: match[1], detail: (match[2] ?? '').split(/\s+/).filter(Boolean) }
}

function fill(text: string, labels: ErrorLabels): string {
  const chain = (() => {
    try {
      return v2Chain(labels.chainId).name
    } catch {
      return 'this network'
    }
  })()
  const token = labels.subjectToken ? (labels.token?.(labels.subjectToken) ?? shortTokenLabel(labels.subjectToken)) : 'this token'
  return text.replace(/\{chain\}/g, chain).replace(/\{token\}/g, token).replace(/\{fee\}/g, 'the automation')
}

/**
 * §4.9's waiting rows and §6.2's waiting reason that speak of a trigger or of "auto-exit for your automation", in
 * Auto-exit's own words where its card and its automation say them (./portfolio.ts waitingWords), by the error's name or
 * the reason's code. Changed on purpose 2026-10-06 (the review of point 5); the meaning is the spec's.
 */
export const AUTO_EXIT_WAITING_TEXT: Readonly<Record<string, string>> = Object.freeze({
  TriggerNotReached: 'Waiting for the price to reach the end of your range',
  trigger_not_reached: 'Waiting for the price to reach the end of your range',
  // Changed on purpose 2026-10-06 (the final check, F8): by its cause, as the card's line says it (finance/v2/autoExit.ts
  // mandate_module_off), never "turned off" beside a "Turn off" that ends it for good.
  ExitModuleNotEnabled: "Paused: your automation doesn't allow Auto-exit right now",
})

/**
 * What a failure says, and its code for `data-error-code`. `context` is the contract the step talks to: 'vault' for a
 * vault, its factory or the position manager's approval; 'autoExit' for the auto-exit module. Changed on purpose
 * 2026-10-06 (rugged's answer of 6 Oct: the spec delta §3): the module's rows say Auto-exit in the table itself
 * (src/v2/errors.ts), so no context rewrites a row's words any more.
 */
export function describeError(error: unknown, context: 'vault' | 'autoExit', labels: ErrorLabels): ErrorView {
  // The money lock before Domino's new contracts are live (finance/v2/liveLock.ts): nothing was asked of any wallet,
  // said in the gate's own words for the chain.
  if (error instanceof Error && (error.message === CONTRACTS_NOT_LIVE || error.message === `wallet_switch_${CONTRACTS_NOT_LIVE}`)) return { text: fill(CLOSED_TEXT.contracts_not_live, labels), code: CONTRACTS_NOT_LIVE }
  // A step already sent: its receipt said reverted or reorged, or could not be read. Not a simulation's revert data
  // (decodeV2Error would read the word "reverted" as one): the page's own outcome codes.
  if (error instanceof Error && (SENT_OUTCOMES.has(error.message) || isBatchCode(error.message))) return { text: CLOSED_TEXT[error.message], code: error.message }
  const decoded = decodeV2Error(error, context, labels)
  if (decoded) return { text: decoded.copy, code: decoded.dataCode, recovery: decoded.recovery }
  // A refusal the wallet said in other words than 4001 (WalletConnect's 5000, a hardware wallet's): nothing was sent.
  if (personRefused(error)) return { text: DECLINED_COPY, code: 'declined' }
  // The page's own switch to the chain (wallet/port.ts v2SwitchNotice already said it).
  if (error instanceof Error && typeof (error as { notice?: unknown }).notice === 'string' && error.message.startsWith('wallet_switch_')) {
    return { text: (error as unknown as { notice: string }).notice, code: error.message }
  }
  const closed = closedCode(error)
  if (closed) {
    if (closed.code === 'mandate_invalid') {
      const reason = closed.detail.find((r): r is MandateReason => Object.hasOwn(MANDATE_REASON_TEXT, r))
      return { text: reason ? mandateInvalidText(reason) : CHANGED, code: reason ?? closed.code }
    }
    if (Object.hasOwn(CLOSED_TEXT, closed.code)) return { text: fill(CLOSED_TEXT[closed.code], labels), code: closed.code }
    return { text: WALLET_FAILED, code: closed.code }
  }
  return { text: WALLET_FAILED, code: 'unknown' }
}

/** The labels a decode fills `{token}` and `{chain}` from: the screen's own token names (never a token's raw symbol). */
export function errorLabels(chainId: ErrorLabels['chainId'], name: (address: Address) => string, subjectToken?: Address): ErrorLabels {
  return { chainId, token: name, ...(subjectToken ? { subjectToken } : {}) }
}

/** §5.4: what each `RootDisarmed` reason says. */
export const DISARM_TEXT: Readonly<Record<number, string>> = Object.freeze({
  1: 'This position left your wallet or Domino was unsubscribed. Automation stopped for it.',
  2: 'This position was changed outside Domino. Automation stopped for it.',
  3: 'This position was closed. Its automation has ended.',
  4: 'Domino no longer has permission on this position, or it left your wallet.',
  5: 'This position changed outside Domino.',
  6: 'Auto-exit withdrew this position.',
  7: 'You ended your automation.',
})
/**
 * §5.4 reason 5's second sentence, ONLY when the change was liquidity someone else merely added (then the operator may
 * rearm, §5.3 operatorRearm). Appended by ./vaultView.ts disarmText when the data says so, never otherwise: read-v6 rc.1
 * does not tell what changed, so today it is never shown.
 */
export const DISARM_5_ADDED = 'Domino may turn it back on automatically.'
/**
 * §5.1 "Copy do consentimento", the protection-only vault's (decision #25: the mode is chosen only when automation is
 * turned on). The automation vault's is VAULT_TEXT.vault_consent_uncollected_fees, with the chosen mode's fee.
 * Changed on purpose 2026-10-06 (the owner's point 5; the study: the old words spoke of turning automation on later,
 * which confuses a product that never reinvests): Auto-exit reinvests nothing; the contract's consent is still given
 * (consentToUncollectedFees), and the sentence says what it means, under the dialog's Details.
 */
export const PROTECTION_CONSENT_TEXT = 'Auto-exit never reinvests. The fees this position earns leave with it when it closes, and the 0.2% fee counts them too.'

/** No log says why, and the live reads do not either: never guessed. */
export const DISARM_UNKNOWN = "Automation is off for this position. We can't tell why yet."
/** §5.6: what the fees waiting in a vault are, under the card's Details and as the withdrawal dialog's lede. */
export const RESERVES_TEXT = "Fees Domino collected and hasn't reinvested yet. They're yours: no Domino fee to withdraw them."
