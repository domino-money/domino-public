/**
 * The owner screens' closed error codes in words. A code is never printed;
 * it stays in a data attribute beside the sentence.
 */

/** The button each owner screen reads its deployment and the wallet with: Setup's owner recovery, and Your sequences. */
export type ReadControl = 'Read my operations' | 'Read my sequences' | 'Create position'

/** A sentence, or one that names the screen's own read button, since each screen names it differently. */
const TEXT: Readonly<Record<string, string | ((again: ReadControl) => string)>> = {
  connect_robinhood_wallet: 'Connect a wallet on Robinhood Chain (4663) first.',
  wallet_identity_changed: (again) => `Your wallet account or network changed. Press ${again} again.`,
  wallet_action_busy: 'Your wallet is still answering the previous request.',
  wallet_action_expired: 'Your wallet took too long to answer.',
  wallet_timeout: 'Your wallet took too long to answer.',
  invalid_wallet_reply: 'Your wallet returned an answer that could not be read.',
  invalid_wallet_quantity: 'Your wallet returned an answer that could not be read.',
  invalid_sequence_reply: 'Your wallet returned an answer that could not be read.',
  sequence_read_provider: 'The connected wallet did not provide an RPC connection. Reconnect it, then press Read my sequences again.',
  sequence_read_accounts: 'The wallet could not answer the account read. Check its network connection, then press Read my sequences again.',
  sequence_read_chain: 'The wallet could not answer the network read. Check its Robinhood Chain connection, then press Read my sequences again.',
  sequence_read_block: 'The wallet could not read a chain block. Check its RPC connection, then press Read my sequences again.',
  sequence_read_code: 'The wallet could not read deployed contract code. Check its RPC connection, then press Read my sequences again.',
  sequence_read_call: 'The wallet could not read a contract result. Check its RPC connection, then press Read my sequences again.',
  sequence_read_timeout: 'The wallet RPC read took too long. Press Read my sequences again after its connection recovers.',
  sequence_read_limit: 'The wallet read exceeded its request limit. No transaction was prepared.',
  sequence_read_decode: 'The wallet returned a contract result that could not be decoded. No transaction was prepared.',
  sequence_read_rpc: 'The wallet could not complete a read request. No transaction was prepared.',
  sequence_read_unexpected: 'The wallet read ended unexpectedly. No transaction was prepared.',
  invalid_block: 'Your wallet returned a block that could not be read.',
  chain_changed: (again) => `The chain moved on while reading. Press ${again} again.`,
  invalid_amount: 'Enter whole numbers in the smallest units.',
  amount_out_of_range: 'An amount is too large.',
  invalid_integer: 'Enter whole numbers for the fee, tick spacing, ticks and slippage.',
  invalid_address: 'Enter a valid address.',
  invalid_gas_budget: 'Check the network budget: gas units from 21,000 to 15,000,000, and a priority fee no higher than the maximum fee.',
  gas_budget_exceeded: 'This step needs more gas than your maximum gas units.',
  native_gas_reserve_insufficient: 'Your ETH balance does not cover this step and the reserve you set.',
  pending_wallet_transaction: 'Your wallet has a pending transaction. Let it finish first.',
  invalid_pool_key: 'Check the pool: tokens in address order, no hooks, and a fee and tick spacing in range.',
  invalid_funding: 'Fund at least one token, within range.',
  invalid_operation_id: 'Enter the operation ID as a 32-byte hex value.',
  operation_not_owned: 'That operation belongs to another wallet.',
  operation_already_closed: 'That operation is already closed.',
  operation_recovery_started: 'Recovery has started. Refund the remaining funds; this operation can no longer swap or mint.',
  invalid_recovery_amount: 'Choose a token in this operation and an amount within its remaining balance.',
  invalid_swap_budget: 'Check the swap: a budget within the operation balance, a slippage limit from 0.1% to 5% and a price limit.',
  invalid_slippage: 'Choose a swap slippage limit from 0.1% to 5%.',
  swap_output_insufficient: 'The simulated swap output is too small for your slippage limit.',
  invalid_mint_limits: 'Check the mint: ticks on the pool spacing, caps within the operation balance and valid price limits.',
  invalid_transaction_hash: 'Enter the transaction hash as a 32-byte hex value.',
  invalid_transaction: 'That transaction was not sent from this wallet.',
  transaction_does_not_match_review: 'That transaction does not match the reviewed step.',
  transaction_operation_mismatch: 'That transaction belongs to another operation.',
  operation_receipt_required: 'Enter the operation ID together with this transaction hash.',
  invalid_transaction_value: 'That transaction sent an unexpected value.',
  invalid_receipt: 'The receipt could not be read.',
  receipt_not_from_this_review: 'Only a step reviewed on this page can have its receipt checked here.',
  receipt_identity_changed: 'That receipt does not match the reviewed step.',
  setup_release_expired: 'The deployment profile expired. Press Read my operations again.',
  sequence_release_expired: 'The deployment profile expired. Press Read my sequences again.',
  setup_admission_unavailable: 'The deployment could not be confirmed just now. Nothing was prepared.',
  sequence_admission_unavailable: 'The deployment could not be confirmed just now. Nothing was prepared.',
  deployment_code_changed: 'The deployed code no longer matches its profile. Nothing was prepared.',
  deployment_identity_changed: 'The deployment no longer matches its profile. Nothing was prepared.',
  deployment_not_pinned: 'This site has no deployment to check that profile against. Nothing was prepared.',
  deployment_identity_unpinned: 'That profile is not the deployment this site knows. Nothing was prepared.',
  invalid_setup_release: 'The deployment profile could not be read.',
  invalid_sequence_release: 'The deployment profile could not be read.',
  invalid_clone_template: 'The deployment profile is not consistent.',
  invalid_execution_roles: 'The deployment roles are not consistent.',
  unqualified_sequence: 'That address is not a sequence of this deployment.',
  invalid_root_nft: 'Enter the root NFT ID.',
  unsupported_pool: 'That position is in a pool sequences do not support: hooks, or a fee or tick spacing out of range.',
  invalid_position_identity: 'That position could not be verified.',
  invalid_currency: 'A token of that pool has no contract code.',
  sequence_already_exists: 'A sequence already exists at the predicted address.',
  sequence_consent_required: 'Give your consent to continue.',
  invalid_sequence_policy: 'Check the sequence limits: whole numbers, each within its range.',
  sequence_activation_unavailable: 'Activation needs a paused sequence, a valid root permission and the published operator.',
  sequence_tariff_changed: 'The sequence fee no longer matches the published automation mode.',
  simple_compound_position_limit: 'Auto-compound manages only its root position. Choose Domino-compound to manage successors.',
  sequence_preparation_changed: 'The sequence changed since it was prepared. Prepare and review again.',
  root_approval_changed: 'The root NFT approval changed. Prepare and review again.',
  sequence_already_paused: 'This sequence is already paused.',
  operator_already_revoked: 'The operator is already revoked.',
  invalid_child: 'Enter an active child NFT of this sequence.',
  invalid_fee_withdrawal: 'Check the fee source, currency and amounts.',
  fee_reserve_insufficient: 'The fee reserve is smaller than that amount.',
  unknown_position: 'That NFT is not part of this sequence.',
  review_required: 'Review the step again before sending it.',
  wallet_review_required: 'Review the step again before sending it.',
  wallet_review_expired: 'The review expired. Prepare and review again.',
}

/** A closed code as a sentence, or `fallback` for a code without one. `again` is the screen's own read button, for the sentences that send the owner back to it. */
export function financeErrorText(code: string | null, fallback: string, again: ReadControl): string {
  if (code === null || !Object.hasOwn(TEXT, code)) return fallback
  const text = TEXT[code]
  return typeof text === 'function' ? text(again) : text
}

/** The code of a thrown error when it is one of ours: lowercase words and underscores. */
export function errorCode(error: unknown): string | null {
  return error instanceof Error && /^[a-z0-9_]{1,64}$/.test(error.message) ? error.message : null
}

/** A receipt state in words. `over_budget` is an included, successful transaction whose cost went past what the review approved: not a revert, not a mismatch. */
export const RECEIPT_TEXT: Readonly<Record<'pending' | 'included' | 'confirming' | 'reorged' | 'reverted' | 'finalized' | 'over_budget' | 'over_budget_finalized', string>> = {
  pending: 'Waiting to be included',
  included: 'Included, waiting for finality',
  confirming: 'Included, waiting for finality',
  reorged: 'Its block left the canonical chain',
  reverted: 'Reverted',
  finalized: 'Finalized',
  over_budget: 'Included, but past the approved network budget',
  over_budget_finalized: 'Finalized, but past the approved network budget',
}

/** What each prepared setup step is, for its review heading. */
export const SETUP_STEP_TEXT: Readonly<Record<'approve' | 'fund' | 'swap' | 'mint' | 'cancel' | 'recover', string>> = {
  approve: 'exact allowance',
  fund: 'funding',
  swap: 'assisted swap',
  mint: 'mint',
  cancel: 'refund',
  recover: 'single-token refund',
}

/** What each prepared sequence step is, for its review heading. */
export const SEQUENCE_STEP_TEXT: Readonly<Record<'approve-root' | 'create' | 'resume' | 'pause' | 'restore-operator' | 'revoke-operator' | 'revoke-root' | 'withdraw-child' | 'withdraw-fees' | 'rearm-root' | 'recover-position' | 'recover-currency' | 'set-policy' | 'set-limits', string>> = {
  'approve-root': 'root NFT approval',
  create: 'paused sequence creation',
  resume: 'activation',
  pause: 'pause',
  'restore-operator': 'operator authorisation',
  'revoke-operator': 'operator revocation',
  'revoke-root': 'root NFT approval revocation',
  'withdraw-child': 'child NFT withdrawal',
  'withdraw-fees': 'fee reserve withdrawal',
  'rearm-root': 'root permission repair',
  'recover-position': 'unmanaged NFT recovery',
  'recover-currency': 'untracked balance recovery',
  'set-policy': 'automation rule change',
  'set-limits': 'safety limit change',
}
