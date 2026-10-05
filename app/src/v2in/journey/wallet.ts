import type { V2Wallet } from '../../finance/v2/transact'
import { v2Wallet } from '../../finance/v2/wallet'
import { createZapClient, type ZapClient } from '../../finance/v2/zap'
import { v2Chain } from '../../v2/chains'
import type { V2ChainId, V2Contracts } from '../../v2/types'
import { switchToChain, v2SwitchNotice } from '../../wallet/port'

/**
 * The connected wallet as New position's zap path uses it, on ONE network (copied from the #/v2 screens'
 * src/v2ui/s1/wallet.ts, which this area never imports): the wallet put on the plan's chain first (wallet/port.ts
 * switchToChain; a wallet that does not know Base or Arbitrum One is told "Add {chain} to your wallet, then try again."),
 * then the zap client for that chain with that chain's Domino contracts (the gate's set: a pinned manifest under `live`,
 * a test suite's fake chain in a test build). Clients are kept per chain, wallet and contracts, so a step a client
 * offered stays known to it (never offered twice).
 */
export interface JourneyConnection {
  chainId: V2ChainId
  wallet: V2Wallet
  zap: ZapClient
}

/** A wallet outcome said in words (a switch the wallet refused, a network it does not know), with its code. */
export class JourneyNotice extends Error {
  readonly copy: string
  readonly code: string
  constructor(copy: string, code: string) {
    super(code)
    this.name = 'JourneyNotice'
    this.copy = copy
    this.code = code
  }
}

const kept = new Map<string, JourneyConnection>()

/** Right before a step: the wallet back on the plan's chain if it moved (switchToChain first, spec §1.3). */
export async function onChain(connection: JourneyConnection): Promise<void> {
  if (connection.wallet.chainId() === connection.chainId) return
  const outcome = await switchToChain(connection.chainId)
  if (outcome !== 'switched') throw new JourneyNotice(v2SwitchNotice(outcome, v2Chain(connection.chainId).name), outcome)
}

let line: Promise<unknown> = Promise.resolve()
/**
 * One wallet request at a time from the steps' reads (each money client runs one operation at a time and refuses a
 * second as `wallet_action_busy`): the next waits for the one before it, whatever its outcome.
 */
export function inTurn<T>(work: () => Promise<T>): Promise<T> {
  const next = line.then(work, work)
  line = next.catch(() => undefined)
  return next
}

export async function connectJourney(chainId: V2ChainId, contracts: V2Contracts): Promise<JourneyConnection> {
  const chain = v2Chain(chainId)
  const wallet = await v2Wallet()
  if (wallet.chainId() !== chainId) {
    const outcome = await switchToChain(chainId)
    if (outcome !== 'switched') throw new JourneyNotice(v2SwitchNotice(outcome, chain.name), outcome)
  }
  const key = `${chainId}|${wallet.owner}|${contracts.addresses.zapV3}|${contracts.addresses.zapV4}|${contracts.codeHashes.zapV4}`
  const known = kept.get(key)
  if (known && known.wallet.current()) return known
  const connection: JourneyConnection = { chainId, wallet, zap: createZapClient(wallet, chain, contracts) }
  kept.set(key, connection)
  return connection
}
