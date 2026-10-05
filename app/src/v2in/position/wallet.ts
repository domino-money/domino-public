/**
 * The connected wallet as the position page's Domino V2 actions use it, on ONE chain (copied from the S1 reference,
 * the former src/v2ui/s1/wallet.ts): the wallet put on the position's chain first (wallet/port.ts switchToChain; a wallet that does
 * not know Base or Arbitrum One is told "Add {chain} to your wallet, then try again."), then the money clients for that
 * chain, kept per chain, wallet and contracts set, so a step a client offered stays known to it (never offered twice).
 *
 *   - `live`: the zap client on the gate's contracts (the chain's pinned manifest, or a test suite's fake chain), and the
 *     direct-exit client with the zap's vault and root probes (rev2 §2.13: an armed root's exit asks for the warning);
 *   - `preview`: no Domino contract is live, so no zap client is built; the direct-exit client alone, which reads the
 *     position at Uniswap through the wallet (for the review) and is never asked to send (the dialogs stop at the review).
 *     Nothing is sent, so the wallet is never asked to switch chain for it: a wallet on another chain is said so instead.
 */
import { createDirectClient, type DirectClient, type DirectCode } from '../../finance/v2/direct'
import type { V2Wallet } from '../../finance/v2/transact'
import { v2Wallet } from '../../finance/v2/wallet'
import { createZapClient, type ZapClient } from '../../finance/v2/zap'
import { v2Chain } from '../../v2/chains'
import type { V2Gate } from '../../v2/gate'
import type { V2ChainId } from '../../v2/types'
import { switchToChain, v2SwitchNotice } from '../../wallet/port'
import { WalletNotice } from './errors'

declare const __DOMINO_TEST_HOOKS__: boolean | undefined
const TEST_HOOKS: boolean = typeof __DOMINO_TEST_HOOKS__ === 'boolean' && __DOMINO_TEST_HOOKS__

/** The gate this page acts under: preview or live, never off (nothing is offered then). */
export type OpenGate = Exclude<V2Gate, { mode: 'off' }>

export interface PositionConnection {
  chainId: V2ChainId
  wallet: V2Wallet
  /** Null in the preview: no Domino contract is live, and no review by the zap client can run. */
  zap: ZapClient | null
  direct: DirectClient
}

/** The code hashes a browser suite passes for the direct exits on a fake chain (test builds only); the profile's otherwise. */
function directCode(chainId: number): DirectCode | undefined {
  if (!TEST_HOOKS || typeof window === 'undefined') return undefined
  const hooks = (window as unknown as { __dominoV2Test?: { s1?: { directCode?: Record<string, DirectCode> } } }).__dominoV2Test
  return hooks?.s1?.directCode?.[String(chainId)]
}

const kept = new Map<string, PositionConnection>()

/** Right before a step: the wallet back on the position's chain if it moved (switchToChain first, spec §1.3). */
export async function onChain(connection: PositionConnection): Promise<void> {
  if (connection.wallet.chainId() === connection.chainId) return
  const outcome = await switchToChain(connection.chainId)
  if (outcome !== 'switched') throw new WalletNotice(v2SwitchNotice(outcome, v2Chain(connection.chainId).name), outcome)
}

let line: Promise<unknown> = Promise.resolve()
/**
 * One wallet request at a time from the page's own reads (each money client runs one operation at a time and refuses a
 * second as `wallet_action_busy`): the next read waits for the one before it, whatever its outcome.
 */
export function inTurn<T>(work: () => Promise<T>): Promise<T> {
  const next = line.then(work, work)
  line = next.catch(() => undefined)
  return next
}

export async function connectPosition(gate: OpenGate): Promise<PositionConnection> {
  const chainId = gate.chainId
  const chain = v2Chain(chainId)
  const wallet = await v2Wallet()
  if (wallet.chainId() !== chainId) {
    // The preview only reads: no switch is asked for a read (the dialog asks for it only on the position's chain anyway).
    if (gate.mode === 'preview') throw new Error('wallet_wrong_chain')
    const outcome = await switchToChain(chainId)
    if (outcome !== 'switched') throw new WalletNotice(v2SwitchNotice(outcome, chain.name), outcome)
  }
  const contracts = gate.contracts
  const key = `${gate.mode}|${chainId}|${wallet.owner}|${contracts.addresses.zapV3}|${contracts.addresses.zapV4}|${contracts.codeHashes.zapV4}`
  const known = kept.get(key)
  if (known && known.wallet.current()) return known
  const code = directCode(chainId)
  let connection: PositionConnection
  if (gate.mode === 'live') {
    const zap = createZapClient(wallet, chain, contracts)
    // Every step's budget is read by the clients themselves at its review. The zap's probes tell the direct exits a
    // vault's root (armed or not, rev2 review L2) or a successor (rev2 §2.13).
    connection = { chainId, wallet, zap, direct: createDirectClient(wallet, chain, undefined, code, zap.vaultProbe, zap.rootProbe) }
  } else {
    connection = { chainId, wallet, zap: null, direct: createDirectClient(wallet, chain, undefined, code, null, null) }
  }
  kept.set(key, connection)
  return connection
}
