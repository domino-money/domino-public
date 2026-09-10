import { useState } from 'react'
import type { CSSProperties } from 'react'

/**
 * Token marks.
 *
 * Every symbol looks for its artwork at /tokens/<symbol>.svg in this app, so
 * adding a logo is dropping a file in that folder. Nothing is fetched from a
 * third-party host. Symbols here are fixed constants chosen by us, not metadata
 * read from chain. A missing file falls back to a coloured disc with letters.
 */

type Spec = { bg: string; fg?: string; text?: string; label: string; file?: string | null }

/** Tokens that exist on Robinhood Chain (chain 4663), from the backend's validation set. */
const SPECS: Record<string, Spec> = {
  ETH: { bg: '#627EEA', label: 'Ether' },
  WETH: { bg: '#363c4a', label: 'Wrapped Ether' },
  USDG: { bg: '#16b672', label: 'Global Dollar' },
  MARLIN: { bg: '#1f6feb', label: 'Marlin', text: 'MR' },
  TRADOOR: { bg: '#d99a00', label: 'Tradoor', text: 'TR' },
  CRUMBS: { bg: '#c4703b', label: 'Crumbs', text: 'CR' },
  RUBEN: { bg: '#8b5cf6', label: 'Ruben', text: 'RU' },
  MAD: { bg: '#e0483f', label: 'Mad', text: 'MD' },
  BAG: { bg: '#0ea5e9', label: 'Bag', text: 'BG' },
  ZZZ: { bg: '#6366f1', label: 'ZZZ', text: 'ZZ' },
  UNI: { bg: '#FF007A', label: 'Uniswap', text: 'UNI', file: 'uniswap' },
  MEME: { bg: 'var(--primary)', fg: 'var(--primary-fg)', label: 'Example token', text: 'M', file: null },
}

const fallback = (symbol: string): Spec => ({ bg: 'var(--surface-3)', fg: 'var(--fg)', label: symbol })

export function TokenIcon({
  symbol,
  size = 24,
  className,
  style,
  ring,
}: {
  symbol: string
  size?: number
  className?: string
  style?: CSSProperties
  /** Colour of the thin border, used when icons overlap. */
  ring?: string
}) {
  const key = symbol.toUpperCase()
  const spec = SPECS[key] ?? fallback(symbol)
  const src = spec.file === null ? null : `/tokens/${(spec.file ?? key).toLowerCase()}.svg`
  const [broken, setBroken] = useState(false)
  const border = ring ? `2px solid ${ring}` : undefined

  if (src && !broken) {
    return (
      <img
        src={src}
        alt=""
        width={size}
        height={size}
        draggable={false}
        onError={() => setBroken(true)}
        className={className}
        style={{ width: size, height: size, borderRadius: '50%', border, display: 'block', background: spec.bg, ...style }}
      />
    )
  }

  return (
    <span
      aria-hidden="true"
      className={className}
      style={{
        width: size,
        height: size,
        borderRadius: '50%',
        border,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: `radial-gradient(circle at 32% 28%, color-mix(in srgb, ${spec.bg} 70%, white) 0%, ${spec.bg} 48%, color-mix(in srgb, ${spec.bg} 60%, black) 100%)`,
        color: spec.fg ?? '#fff',
        fontFamily: 'var(--font-mono)',
        fontWeight: 600,
        fontSize: Math.max(9, size * 0.34),
        letterSpacing: '0.2px',
        flexShrink: 0,
        ...style,
      }}
    >
      {spec.text ?? key.slice(0, 2)}
    </span>
  )
}

/** Two overlapping marks, the way exchanges show a pair. */
export function TokenPair({ base, quote, size = 32, ring = 'var(--surface-2)' }: { base: string; quote: string; size?: number; ring?: string }) {
  return (
    <span className="inline-flex shrink-0 items-center" aria-hidden="true">
      <TokenIcon symbol={base} size={size} ring={ring} />
      <TokenIcon symbol={quote} size={size} ring={ring} style={{ marginLeft: -size * 0.3 }} />
    </span>
  )
}

export const tokenLabel = (symbol: string) => (SPECS[symbol.toUpperCase()] ?? fallback(symbol)).label

/** Real network tokens, in the order they appear across the site. */
export const NETWORK_TOKENS = ['ETH', 'USDG', 'WETH', 'MARLIN', 'TRADOOR', 'CRUMBS', 'RUBEN', 'MAD', 'BAG', 'ZZZ']
