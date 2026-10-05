/**
 * Small pieces the second chain's screens share (2026-10-01, the chain2 workstream): a token's mark and name, an amount,
 * where and when a figure was read, and a figure that is not there. In the app's own primitives (components/ui.tsx) and
 * tokens, so the section looks like the rest of the site.
 *
 * A token is drawn as a calm disc coloured from its address (lib/format/tokenHue.ts) with its first letters: never
 * artwork chosen by its symbol, which is the token contract's own untrusted text.
 */
import type { ReactNode } from 'react'
import type { ChainConfig } from '../../../config/chainKit'
import { explorerAddress, explorerTx } from '../../../config/chainKit'
import { FigureDash, cx } from '../../../components/ui'
import { tokenHue } from '../../../lib/format/tokenHue'
import { rem } from '../../../lib/rootScale'
import type { Provenance, TokenInfo } from '../../types'
import { amountText, provenanceText, shortAddress, tokenLabel } from '../present'

export function TokenDot({ token, size = 28, ring }: { token: TokenInfo; size?: number; ring?: string }) {
  const label = tokenLabel(token)
  const letters = token.symbol ? [...token.symbol].slice(0, 2).join('').toUpperCase() : '?'
  return (
    <span
      aria-hidden="true"
      title={label}
      className="inline-flex shrink-0 items-center justify-center rounded-full font-medium text-fg"
      style={{
        width: rem(size),
        height: rem(size),
        fontSize: rem(Math.max(9, Math.round(size * 0.36))),
        background: `hsl(${tokenHue(token.address)} 38% 30%)`,
        border: ring ? `2px solid ${ring}` : undefined,
      }}
    >
      {letters}
    </span>
  )
}

export function PairMarks({ token0, token1, size = 28 }: { token0: TokenInfo; token1: TokenInfo; size?: number }) {
  return (
    <span className="inline-flex shrink-0 items-center" aria-hidden="true">
      <TokenDot token={token0} size={size} ring="var(--card)" />
      <span style={{ marginLeft: rem(-size * 0.3) }}>
        <TokenDot token={token1} size={size} ring="var(--card)" />
      </span>
    </span>
  )
}

/** A pair's name, each side its token's own symbol (bidirectional text isolated) or its address shortened. */
export function PairName({ base, quote }: { base: TokenInfo; quote: TokenInfo }) {
  return (
    <>
      <bdi>{tokenLabel(base)}</bdi> / <bdi>{tokenLabel(quote)}</bdi>
    </>
  )
}

/** An amount of a token, or a dash (with its reason) when the token's decimals are unknown. */
export function Amount({ raw, token, approx = false }: { raw: bigint | null; token: TokenInfo; approx?: boolean }) {
  if (raw === null) return <FigureDash reason="Not read" />
  const text = amountText(raw, token.decimals)
  if (text === null) return <FigureDash reason={`${tokenLabel(token)} does not say how many decimals it has, so its amount can't be written`} />
  return (
    <span className="tnum">
      {approx && raw > 0n ? '≈' : ''}
      {text} <bdi>{tokenLabel(token)}</bdi>
    </span>
  )
}

/** Where and when the figures above were read: always shown, quietly. */
export function ReadAt({ at, chain, now, className }: { at: Provenance; chain: ChainConfig; now: number; className?: string }) {
  return (
    <p className={cx('text-caption text-fg-subtle', className)} data-provenance={at.source}>
      {provenanceText(at, chain, now)}
    </p>
  )
}

/** A link to the chain's explorer for an address or a transaction; plain text when it is neither. */
export function ExplorerLink({ chain, address, hash, children }: { chain: ChainConfig; address?: string; hash?: string; children?: ReactNode }) {
  const href = address ? explorerAddress(chain, address) : hash ? explorerTx(chain, hash) : null
  const text = children ?? shortAddress(address ?? hash ?? '')
  if (!href) return <span className="font-mono">{text}</span>
  return (
    <a href={href} target="_blank" rel="noreferrer noopener" className="font-mono underline hover:text-fg">
      {text}
    </a>
  )
}

/** A quiet line saying why something is not shown here (a capability the chain does not have). */
export function Missing({ children }: { children: ReactNode }) {
  return <p className="text-caption text-fg-subtle">{children}</p>
}
