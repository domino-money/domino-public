import type { CSSProperties, ReactNode } from 'react'
import { FEE_MEANING } from '../../components/explore/feeMeaning'
import { TokenMark } from '../../components/TokenIcon'
import { Button } from '../../components/ui'
import { unreadToken } from '../../lib/read/project'
import { rem } from '../../lib/rootScale'
import { nativeArtwork, nativeSymbolOf, v2Chain, wrappedArtwork } from '../../v2/chains'
import { ZERO_ADDRESS, type Address, type Dex, type V2ChainId } from '../../v2/types'
import { REJECTED_IN_WALLET, type JourneyError } from './errors'
import { dexChipShown, dexName, feePercent } from './model/pools'
import type { JourneyToken } from './tokens'

/**
 * Small pieces New position's zap path draws in the journey's own look (components/create, styles/flow.css): a token's
 * mark and name, the chain, DEX and fee chips on a pool, a failure line, a note and a box to tick.
 */

/**
 * A token's symbol as untrusted text (the read layer's SymbolText look): isolated, cut at 24 characters, its short address
 * when it has none. The native currency (address(0)) is the chain's own symbol, never a list's: "ETH" (changed on purpose
 * 2026-11-06, Elysium readiness: HYPE on a HYPE-native chain, `chainId`).
 */
export function TokenName({ token, chainId }: { token: Pick<JourneyToken, 'address' | 'symbol'>; chainId?: number }) {
  if (token.address.toLowerCase() === ZERO_ADDRESS) return <bdi className="inline-block max-w-[24ch] truncate align-bottom">{nativeSymbolOf(chainId ?? 0)}</bdi>
  if (token.symbol === null) return <span className="text-fg-subtle">{`${token.address.slice(0, 6)}…${token.address.slice(-4)}`}</span>
  return <bdi className="inline-block max-w-[24ch] truncate align-bottom">{token.symbol}</bdi>
}

/**
 * A token's mark on any of the three networks: the bundled artwork for native ETH, the chain's WETH and Robinhood Chain's
 * USDG (matched by ADDRESS against the chain profile, never by symbol; on a HYPE-native chain none for HYPE and WHYPE,
 * v2/chains.ts nativeArtwork, 2026-11-06). Other tokens reuse the same bounded artwork
 * resolver as search and positions, keyed by chain plus address, with its neutral fallback when no image is known.
 */
export function TokenDisc({ chainId, token, size = 24, ring, style }: { chainId: V2ChainId; token: Pick<JourneyToken, 'address'>; size?: number; ring?: string; style?: CSSProperties }) {
  const chain = v2Chain(chainId)
  const address = token.address.toLowerCase()
  const base = unreadToken(address)
  const artwork = address === ZERO_ADDRESS ? nativeArtwork(chain) : address === chain.wrappedNative.address ? wrappedArtwork(chain) : chainId === 4663 ? base.artwork : null
  return <TokenMark token={{ ...base, chainId, artwork }} size={size} ring={ring} style={style} />
}

/** Two marks, the second overlapping the first by 30%, as the journey draws a pair. */
export function TokenDiscPair({ chainId, first, second, size = 32, ring = 'var(--card)' }: { chainId: V2ChainId; first: Pick<JourneyToken, 'address'>; second: Pick<JourneyToken, 'address'>; size?: number; ring?: string }) {
  return (
    <span className="inline-flex shrink-0 items-center" aria-hidden="true">
      <TokenDisc chainId={chainId} token={first} size={size} ring={ring} />
      <TokenDisc chainId={chainId} token={second} size={size} ring={ring} style={{ marginLeft: rem(-size * 0.3) }} />
    </span>
  )
}

/**
 * The chips a V2 pool carries on its row, in the journey's chip style: its network, the DEX and its fee. The lists' rule
 * (lists/parts.tsx DEX_BADGE_SHOWS_VERSION; the owner, 2026-09-13: nothing on screen says "v4"): the DEX chip says
 * "Uniswap", the version only in its title and data attribute. On Robinhood Chain, where every pool is Uniswap v4, a v4
 * pool carries no DEX chip at all; a v3 pool found there says "Uniswap".
 * Changed on purpose 2026-11-06 (the replica rule, O-17: Base and Arbitrum One are Robinhood Chain's screens, only the
 * network changes): a pool on Base or Arbitrum One carries no DEX chip either, v3 or v4 (their lists show one row for a
 * pair and fee, whichever version: lib/create/otherChains.ts networkRows), so New position's Review there reads as
 * Robinhood Chain's does: the network and the fee. It said "Uniswap" on every pool there.
 */
export function PoolChips({ chainId, dex, fee }: { chainId: V2ChainId; dex: Dex; fee: number }) {
  const dexChip = dexChipShown(chainId, dex)
  return (
    <span className="flex flex-wrap items-center gap-1.5" data-pool-chips="" data-pool-dex={dex}>
      <span className="dm-chip shrink-0" data-chain-chip={chainId}>{v2Chain(chainId).name}</span>
      {dexChip && <span className="dm-chip shrink-0" data-dex-chip={dex} title={dexName(dex)}>Uniswap</span>}
      {/* Changed on purpose 2026-10-31 (QA round 2 follow-ups, Q28): what the fee is, on hover, as every other fee chip says it. */}
      <span className="dm-chip shrink-0" data-fee="" title={FEE_MEANING}>{`${feePercent(fee)} fee`}</span>
    </span>
  )
}

/**
 * A failure in words, its code in `data-error-code` only (never in the text). Under the refusal that an earlier action
 * handed to the wallet is not settled yet (`zap_action_unsettled`, rev2 review F3), V1's own way out, "I rejected it in
 * my wallet".
 */
export function ErrorLine({ error, onRejected, busy = false }: { error: JourneyError | null; onRejected?: () => void; busy?: boolean }) {
  if (!error) return null
  return (
    <>
      <p role="alert" className="dm-flow-reason" data-align="start" data-error-code={error.code}>
        {error.copy}
      </p>
      {error.code === 'zap_action_unsettled' && onRejected && (
        <Button type="button" variant="outline" size="md" className="w-full" disabled={busy} onClick={onRejected} data-rejected-in-wallet="">
          {REJECTED_IN_WALLET}
        </Button>
      )}
    </>
  )
}

/** A neutral line under a block, in the flow's note style. */
export function Note({ children, tone = 'neutral', ...data }: { children: ReactNode; tone?: 'neutral' | 'warn' } & Record<`data-${string}`, string>) {
  return (
    <p role="status" className="dm-flow-position" data-tone={tone} {...data}>
      <span>{children}</span>
    </p>
  )
}

/** A box the person ticks before the wallet may be asked (rev2 §2.6.5's price warning). */
export function Tick({ checked, onChange, children, disabled, ...data }: { checked: boolean; onChange: (next: boolean) => void; children: ReactNode; disabled?: boolean } & Record<`data-${string}`, string>) {
  return (
    <label className="flex items-start gap-2 text-body">
      <input type="checkbox" className="mt-1" checked={checked} disabled={disabled} onChange={(event) => onChange(event.currentTarget.checked)} {...data} />
      <span>{children}</span>
    </label>
  )
}

/** A short address. */
export const short = (address: Address | string): string => `${address.slice(0, 6)}…${address.slice(-4)}`
