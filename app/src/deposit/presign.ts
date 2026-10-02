/**
 * The checks before a wallet step could ever be handed to a wallet, as a pure
 * function over injected values (DEP-WH step 4). No wallet is connected for
 * this: the chain and account come from the caller (the lab's simulated wallet
 * context; later, the wallet port).
 *
 * In order:
 *   1. the package runtime accepts the prepare response (it binds the
 *      walletStep to the last history step and calls validateWalletStep);
 *   2. there is a walletStep;
 *   3. validateWalletStep(operation.selection, operation.owner, walletStep)
 *      on its own (targets, calldata, caps, budgets, v2 token-review order);
 *   4. the wallet is on chain 4663;
 *   5. wallet account = operation.owner = transaction.from = session owner;
 *   6. the handoff is still fresh on the monotonic clock;
 *   7. the user has reviewed the summary;
 *   8. a wallet handoff exists. It never does in this build, so the result
 *      is never `ok`.
 */
import type { WalletHandoff } from './handoff'
import type { DepositResponses, DepositValidators } from './types'

export type PreSignRowId = 'response' | 'wallet_step' | 'wallet_step_valid' | 'chain' | 'account' | 'fresh' | 'summary' | 'handoff'

export interface PreSignRow {
  id: PreSignRowId
  ok: boolean
  label: string
}

export interface PreSignContext {
  response: unknown
  runtime: DepositValidators
  sessionOwner: string | null
  wallet: { chainId: number | null; account: string | null }
  monoNowMs: number
  walletStepDeadlineMono: number | null
  summaryAcknowledged: boolean
  handoff: WalletHandoff
}

export const PRESIGN_LABELS: Readonly<Record<PreSignRowId, string>> = {
  response: 'The prepare response passes the deposit-v1 contract check',
  wallet_step: 'The response carries a wallet step',
  wallet_step_valid: 'The wallet step matches your selection, owner, limits and budgets (validateWalletStep)',
  chain: 'Your wallet is on Robinhood Chain',
  account: 'Your wallet account is the deposit owner, the transaction sender and your signed-in address',
  fresh: 'The wallet handoff is still within its validity window',
  summary: 'You reviewed the summary above',
  handoff: 'This app can hand the step to your wallet',
}

const safely = (fn: () => boolean) => {
  try {
    return fn()
  } catch {
    return false
  }
}

export function checkPreSign(ctx: PreSignContext): { ok: boolean; rows: PreSignRow[] } {
  const valid = safely(() => ctx.runtime.validateResponse('prepare', ctx.response))
  const body = valid ? (ctx.response as DepositResponses['prepare']) : null
  const step = body?.walletStep ?? null
  const operation = body?.operation ?? null
  const lower = (value: string | null | undefined) => (typeof value === 'string' ? value.toLowerCase() : null)
  const account = lower(ctx.wallet.account)
  const results: Record<PreSignRowId, boolean> = {
    response: valid,
    wallet_step: step !== null,
    wallet_step_valid: step !== null && operation !== null && safely(() => ctx.runtime.validateWalletStep(operation.selection, operation.owner, step)),
    chain: ctx.wallet.chainId === 4663,
    account:
      account !== null &&
      operation !== null &&
      step !== null &&
      account === lower(operation.owner) &&
      account === lower(step.transaction.from) &&
      account === lower(ctx.sessionOwner),
    fresh: ctx.walletStepDeadlineMono !== null && ctx.monoNowMs < ctx.walletStepDeadlineMono,
    summary: ctx.summaryAcknowledged,
    handoff: ctx.handoff.available,
  }
  const rows = (Object.keys(PRESIGN_LABELS) as PreSignRowId[]).map((id) => ({ id, ok: results[id], label: PRESIGN_LABELS[id] }))
  return { ok: rows.every((row) => row.ok), rows }
}
