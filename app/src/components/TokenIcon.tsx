import { useState } from 'react'
import type { CSSProperties } from 'react'
import type { TokenDisplay } from '../lib/read/types'

/**
 * Token marks.
 *
 * Every symbol looks for its artwork at /tokens/<file> in this app, so adding a
 * logo is dropping a file in that folder. Nothing is fetched from a third-party
 * host at runtime. The keys are our curated artwork keys: a read token reaches
 * one only through its address (project.ts), never through its symbol. A
 * missing file falls back to a coloured disc with letters.
 *
 * `ext` exists because the Robinhood Chain tokens publish raster artwork, not
 * vectors. Those files are their projects' own marks, saved into this
 * repository rather than hot-linked. `bg` still matters for them: it is the
 * colour behind the image while it loads and the disc colour if it is missing.
 */

type Spec = {
  bg: string
  fg?: string
  text?: string
  label: string
  file?: string | null
  ext?: 'svg' | 'jpg' | 'png'
}

/** Tokens that exist on Robinhood Chain (chain 4663), from the backend's validation set. */
const SPECS: Record<string, Spec> = {
  ETH: { bg: '#627EEA', label: 'Ether' },
  WETH: { bg: '#363c4a', label: 'Wrapped Ether' },
  USDG: { bg: '#16b672', label: 'Global Dollar' },
  MARLIN: { bg: '#1f6feb', label: 'Marlin', text: 'MR', ext: 'jpg' },
  UNI: { bg: '#FF007A', label: 'Uniswap', text: 'UNI', file: 'uniswap' },
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
  const src = spec.file === null ? null : `/tokens/${(spec.file ?? key).toLowerCase()}.${spec.ext ?? 'svg'}`
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
        style={{
          width: size,
          height: size,
          borderRadius: '50%',
          border,
          display: 'block',
          // Square source art, drawn into a circle without distorting it.
          objectFit: 'cover',
          flexShrink: 0,
          background: spec.bg,
          ...style,
        }}
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


/**
 * The mark for a token as the read adapter describes it. Artwork comes only
 * from the curated key attached to it by address; a token without one gets a
 * plain disc. No letters are drawn from its symbol, which is untrusted text,
 * and nothing from it ever reaches `src` or `alt`.
 */
export function TokenMark({ token, size = 24, ring, style }: { token: TokenDisplay; size?: number; ring?: string; style?: CSSProperties }) {
  if (token.artwork) return <TokenIcon symbol={token.artwork} size={size} ring={ring} style={style} />
  return (
    <span
      aria-hidden="true"
      data-token-mark="unknown"
      style={{
        width: size,
        height: size,
        borderRadius: '50%',
        border: ring ? `2px solid ${ring}` : undefined,
        display: 'inline-block',
        flexShrink: 0,
        background: 'var(--surface-3)',
        ...style,
      }}
    />
  )
}

/** `TokenPair` for adapter tokens. */
export function TokenMarkPair({ base, quote, size = 32, ring = 'var(--surface-2)' }: { base: TokenDisplay; quote: TokenDisplay; size?: number; ring?: string }) {
  return (
    <span className="inline-flex shrink-0 items-center" aria-hidden="true">
      <TokenMark token={base} size={size} ring={ring} />
      <TokenMark token={quote} size={size} ring={ring} style={{ marginLeft: -size * 0.3 }} />
    </span>
  )
}

