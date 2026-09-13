/**
 * The wallet handoff: a seam only (DEP-WH, H1). There is no implementation in
 * this app, and this file imports nothing that could reach a wallet.
 *
 * The step that will need a wallet transaction later is exactly
 * FUTURE_WALLET_STEP below. Everything before it (the user's Prepare, the
 * package's validateResponse('prepare') and validateWalletStep, the injected
 * chain, account, freshness and summary checks in presign.ts) exists and is
 * tested with fixtures. Everything after it (report the hash, then a
 * user-initiated Check status) exists on the client. The send itself does not.
 *
 * The one runtime value is DISABLED_WALLET_HANDOFF: `available: false`, and a
 * `send` that throws before doing anything. Nothing in the app calls it; the
 * pre-sign gate treats `available: false` as a failed final check, so a
 * wallet step can be reviewed but never handed to a wallet, and there is no
 * Send button anywhere. Revocations (H2), nonce replacement or cancellation
 * (H3) and chain switching (H4) stay in the user's own wallet and appear only
 * as text.
 */
import type { PreparedArtifact } from './types'

export type HexHash = `0x${string}`

/**
 * H1, the single future send point: one EIP-1559 transaction per prepared
 * step, with every field of `step.transaction` passed unchanged.
 */
export interface WalletHandoff {
  readonly available: boolean
  send(step: PreparedArtifact, context: { chainId: 4663; from: string }): Promise<HexHash>
}

export const FUTURE_WALLET_STEP =
  'After the user presses Prepare and the service returns a walletStep (erc20_reset, erc20_approval, permit2_approval or mint) that passes ' +
  "validateResponse('prepare'), validateWalletStep and every pre-sign check, WalletHandoff.send submits walletStep.transaction as one " +
  'EIP-1559 transaction on chain 4663 (0x1237) with every field unchanged; then report { intentId, version, transactionHash } and a ' +
  'user-initiated Check status. At most four sends per deposit, each after its own Prepare.'

export class WalletHandoffDisabledError extends Error {
  constructor() {
    super('Wallet sending is not available in this build. Nothing was sent.')
    this.name = 'WalletHandoffDisabledError'
  }
}

/** The only handoff this build has: unavailable, and a send that throws without touching anything. */
export const DISABLED_WALLET_HANDOFF: WalletHandoff = Object.freeze({
  available: false,
  send(): never {
    throw new WalletHandoffDisabledError()
  },
})
