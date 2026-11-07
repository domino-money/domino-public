import { useEffect, useState } from 'react'
import type { PortfolioResponse, Position } from 'api-contracts/read-v6/types'
import type { WalletPosition } from '../../lib/walletPositions'
import { positionManagerOrNull, v2Chain } from '../../v2/chains'
import { ZERO_ADDRESS } from '../../v2/types'
import { walletPositionOf } from '../position/card'
import { findPosition, isLive, tokensOf } from '../position/model'
import { tokenBook } from '../position/tokens'
import type { V2PositionRef } from '../route'
import { setupKey } from './intent'
import { vaultsOfPosition } from './portfolio'
import { exitOnPosition } from '../autoexit/card'

export type SetupPosition = WalletPosition & { key: string; chainId: V2PositionRef['chainId']; dex: 3 | 4; network: string }

export type SetupEligibility = 'eligible' | 'unavailable' | 'unsupported' | 'not-owned' | 'closed' | 'automated' | 'subscribed'

/** A validated read-v6 NFT, never its numeric id alone, admits an automation offer. The money client rechecks on chain. */
export function setupEligibility(body: PortfolioResponse, owner: string, item: Position): SetupEligibility {
  if (body.wallet.toLowerCase() !== owner.toLowerCase()) return 'unavailable'
  const chain = v2Chain(item.chainId)
  // A position of a version the chain lacks (v3 on a chain with v4 alone) is never offered automation.
  const manager = positionManagerOrNull(chain, item.dex)
  if (manager === null || item.positionManager.toLowerCase() !== manager || BigInt(item.tokenId) <= 0n || BigInt(item.tokenId) >= 1n << 96n) return 'unsupported'
  const state = item.state
  if (body.chains.find((one) => one.chainId === item.chainId)?.status !== 'current' || state.status !== 'live' || state.freshness.status !== 'fresh') return 'unavailable'
  if (state.pool.dex !== item.dex || state.pool.hooks.toLowerCase() !== ZERO_ADDRESS) return 'unsupported'
  if (state.owner.toLowerCase() !== owner.toLowerCase()) return 'not-owned'
  if (BigInt(state.liquidity) === 0n) return 'closed'
  if (item.vault !== null) return 'automated'
  // read-v6 maps the on-chain zero subscriber to null. A live reply read both custody fields successfully.
  if (state.custody.subscriber !== null && state.custody.subscriber.toLowerCase() !== ZERO_ADDRESS) return 'subscribed'
  return 'eligible'
}

/** Each supported manager has its own NFT namespace, token metadata and financial gate. */
export function setupPositions(body: PortfolioResponse, owner: string): { positions: readonly SetupPosition[]; incomplete: boolean } {
  const positions: SetupPosition[] = []
  let incomplete = body.wallet.toLowerCase() !== owner.toLowerCase()
    || body.truncated.positions
  if (body.truncated.vaults || body.truncated.mandates) return { positions, incomplete: true }
  const seen = new Set<string>()
  for (const item of body.positions) {
    const eligibility = setupEligibility(body, owner, item)
    if (eligibility === 'unavailable') incomplete = true
    if (eligibility !== 'eligible') continue
    if (vaultsOfPosition(body, item.chainId, item.tokenId, item.dex).length || exitOnPosition(body, item.chainId, item.tokenId, item.dex)) continue
    const position = findPosition({ positions: [item] }, item.chainId, item.dex, BigInt(item.tokenId))
    if (!position || !isLive(position)) continue
    const key = setupKey(position)
    if (seen.has(key)) continue
    seen.add(key)
    const book = tokenBook(item.chainId, tokensOf(body, item.chainId))
    positions.push({ ...walletPositionOf(position, book), key, chainId: item.chainId, dex: item.dex, network: v2Chain(item.chainId).name })
  }
  // An unavailable inventory cannot prove the wallet has no eligible NFTs. Keep known, eligible positions usable
  // when an unrelated network is behind; only an otherwise empty picker needs the unavailable state.
  if (positions.length === 0 && body.chains.some(chain => chain.status !== 'current')) incomplete = true
  return { positions, incomplete }
}

/**
 * Changed on purpose 2026-10-30 (QA round 2, final review shell-1): an empty offer is a fact only when every NFT of the
 * wallet on an open network was judged. One that could not be (its network behind, its reading not fresh) is read again
 * by itself (../lists/source.ts, every 30 s), so Set up automation and Set up Auto-exit keep their loading rows instead of
 * saying there is no position and offering a second deposit. A wallet with no NFT, or whose only unjudged NFTs sit behind
 * a closed gate, still gets the plate at once, even while an unrelated network is behind.
 */
/**
 * How long a screen keeps those loading rows (QA round 2, final review follow-up): read-v6 can keep an NFT unjudged for
 * good (one it cannot prove burned, `v2_burn_unproven`), so past two minutes of 30 s re-asks the plate is said after all.
 */
export const SETUP_WAIT_MS = 120_000

/** Starts at the screen's mount: true once SETUP_WAIT_MS has passed, so setupWaiting stops holding the loading rows. */
export function useSetupWaitOver(): boolean {
  const [over, setOver] = useState(false)
  useEffect(() => {
    const timer = window.setTimeout(() => setOver(true), SETUP_WAIT_MS)
    return () => window.clearTimeout(timer)
  }, [])
  return over
}

export function setupWaiting(body: PortfolioResponse, owner: string, offered: number, open: (chainId: Position['chainId']) => boolean): boolean {
  return offered === 0 && body.positions.some((item) => open(item.chainId) && setupEligibility(body, owner, item) === 'unavailable')
}

/** Only a successful read with a pending requested NFT is polled. Transport failures keep their own retry policy. */
export function setupRetryDelay(body: PortfolioResponse, owner: string, wanted: string | V2PositionRef | null, attempt: number): number | null {
  if (wanted === null || attempt >= 3) return null
  const ref = typeof wanted === 'string' ? { chainId: 4663, dex: 4, tokenId: BigInt(wanted) } : wanted
  const item = body.positions.find((one) => one.chainId === ref.chainId && one.dex === ref.dex && one.tokenId === ref.tokenId.toString())
  return !item || setupEligibility(body, owner, item) === 'unavailable' ? 1500 * 2 ** attempt : null
}
