/**
 * Every sentence the deposit screen says, and the maps from contract enums to
 * words. Server text never reaches the screen except addresses, hashes and
 * numbers, shown as text.
 */
import type { DepositFailure } from './client'
import { DEPOSIT_ERROR_UI } from './errors'
import type { AmountBasis, OperationState, StepKind } from './types'

export const LAB_BANNER = 'Synthetic fixture: not your wallet, not live. Every answer on this page comes from the deposit-v1 package fixtures.'
export const NO_SEND_STATUS =
  "Wallet sending isn't available in this build. Nothing has been sent. Nonce {n} stays reserved on the server until a transaction at that nonce finalizes."
export const PREPARE_OFF_WITHOUT_HANDOFF =
  'Preparing a wallet step reserves a transaction slot (nonce) on the server until a transaction at that nonce finalizes. It stays off until this app can send from your wallet.'
export const LATCH_COPY = "Prepare is off for this deposit: the service refused this pool or token. Don't try another pool or a new deposit to get around it."
export const SUPPORT_REQUIRED =
  "Support required. This can't be retried, cancelled or cleared here, and starting a new deposit won't resolve it. The evidence is kept."
export const REPORT_HINT = 'The hash is only a hint. Status comes from the chain.'
export const FIXED_FACTS = 'Your wallet sends every transaction. Depositing starts no automation.'
export const HASH_PATTERN = /^0x[0-9a-f]{64}$/i

/** Every operation state in words, for list rows. */
export const STATE_LABEL: Readonly<Record<OperationState, string>> = {
  draft: 'Draft',
  awaiting_wallet: 'Awaiting wallet',
  pending: 'Pending',
  confirmed: 'Confirmed',
  reverted: 'Reverted',
  cancel_requested: 'Cancellation requested',
  cancelled: 'Cancelled',
  attention: 'Needs attention',
  superseded: 'Replaced',
}

export const STEP_KIND: Readonly<Record<StepKind, string>> = {
  erc20_reset: 'ERC-20 allowance reset',
  erc20_approval: 'ERC-20 approval to Permit2',
  permit2_approval: 'Permit2 allowance for the PositionManager',
  mint: 'Position mint',
}

export const RECONCILIATION: Readonly<Record<'null' | 'not_found' | 'pending' | 'confirmed' | 'reverted' | 'mismatched' | 'reorged', string>> = {
  null: 'No transaction reported yet',
  not_found: 'Reported transaction not found on-chain yet',
  pending: 'Waiting for finalization',
  confirmed: 'Confirmed',
  reverted: 'Reverted',
  mismatched: 'Evidence did not match this step',
  reorged: 'Chain reorganization',
}

export const FINALITY: Readonly<Record<'finalized' | 'provisional' | 'unavailable', string>> = {
  finalized: 'Finalized',
  provisional: 'Provisional (not final yet)',
  unavailable: 'Finality could not be read',
}

export const BASIS: Readonly<Record<AmountBasis, { qualified: boolean; text: string }>> = {
  admitted_standard_transfer_events: { qualified: true, text: 'from token transfer events' },
  reviewed_proxy_transfer_events: {
    qualified: true,
    text: 'from transfer events under the reviewed token version; reviewed upgradeable token; not a balance trace; a same-block upgrade cannot be ruled out',
  },
  token_review_changed: { qualified: false, text: "Unavailable: the token's implementation changed from the reviewed one" },
  token_review_unavailable: { qualified: false, text: 'Unavailable: the token identity could not be verified' },
  legacy_token_review_unqualified: { qualified: false, text: 'Unavailable: an older record without token-review evidence' },
  native_net_unavailable: { qualified: false, text: 'Native ETH net amount unavailable (the value sent is shown on the step)' },
}

export const LIMIT_NAME: Readonly<Record<'gasLimit' | 'maxFeePerGas' | 'maxPriorityFeePerGas', string>> = {
  gasLimit: 'gas limit',
  maxFeePerGas: 'max fee per gas',
  maxPriorityFeePerGas: 'max priority fee per gas',
}

/** Selector → name, for display only. No label here is call syntax. */
export const SELECTOR_NAME: Readonly<Record<string, string>> = {
  '0x095ea7b3': 'ERC-20 approval',
  '0x87517c45': 'Permit2 allowance',
  '0xdd46508f': 'PositionManager modifyLiquidities',
}

/** Unix seconds as a fixed UTC time, the same on every device. */
export function utcTime(seconds: number): string {
  return `${new Date(seconds * 1000).toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, '')} UTC`
}

export const shortHex = (hex: string) => (hex.length > 14 ? `${hex.slice(0, 8)}…${hex.slice(-6)}` : hex)

export interface FailureContext {
  nonce?: string | null
  /** Currency and spender pairs this page has seen for the operation (ALW-7). */
  knownPairs?: ReadonlyArray<{ currency: string; spender: string }>
}

/** The sentence for a failed call. */
export function failureCopy(failure: DepositFailure, context: FailureContext = {}): string {
  switch (failure.kind) {
    case 'error': {
      const disposition = DEPOSIT_ERROR_UI[failure.code]
      let text = disposition.copy.replace('{n}', context.nonce ?? '(unknown)').replace('{s}', String(failure.retryAfterS ?? 60))
      if (disposition.notFound) {
        const pairs = context.knownPairs ?? []
        text +=
          pairs.length > 0
            ? ` If it ever had approvals, an allowance may still exist: ${pairs.map((pair) => `${pair.currency} to ${pair.spender}`).join('; ')}. Check it in your wallet.`
            : ' If it ever had approvals, allowances may still exist. Check them in your wallet.'
      }
      return text
    }
    case 'gate_required':
      return 'Your site access has expired. Reload the page and enter the password again.'
    case 'gate_unavailable':
      return 'The site is temporarily unavailable. Try again later.'
    case 'not_deployed':
      return 'The deposit service is unavailable right now. Nothing changed.'
    case 'contract':
      return failure.detail === 'owner'
        ? 'This answer was about another account, so nothing from it is shown or remembered.'
        : "The deposit service answered in a way this build doesn't accept. Nothing from it is shown."
    case 'request_invalid':
      return 'This page refused to send a request the deposit contract rejects. Nothing was sent.'
    case 'network':
      return 'The connection failed. The outcome is unknown. Use Check status.'
    case 'timeout':
      return 'The request timed out. Its outcome is unknown. Use Check status.'
    case 'aborted':
      return 'Cancelled by a change of account or session.'
    case 'session_gone':
      return 'Your session ended. Sign in again to continue. Any reserved wallet step stays reserved.'
  }
}
