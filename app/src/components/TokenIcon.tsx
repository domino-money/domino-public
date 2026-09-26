import { useEffect, useState } from 'react'
import type { CSSProperties } from 'react'
import type { TokenDisplay } from '../lib/read/types'
import { tokenArtwork, tokenArtworkKey } from '../lib/tokenArtwork'
import { tokenHue } from '../lib/format/tokenHue'

/**
 * Token marks.
 *
 * Bundled artwork is preferred. The keys are our curated artwork keys: a read token reaches
 * one only through its address (project.ts), never through its symbol. A
 * missing bundled file falls back to a coloured disc with letters. Unmapped
 * read tokens may use separately bounded public decorative metadata below.
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
  // A failed previous token must not suppress the next token's artwork.
  const [brokenSrc, setBrokenSrc] = useState<string | null>(null)
  const border = ring ? `2px solid ${ring}` : undefined

  if (src && brokenSrc !== src) {
    return (
      <img
        src={src}
        alt=""
        width={size}
        height={size}
        draggable={false}
        onError={() => setBrokenSrc(src)}
        className={className ? `dm-token-img ${className}` : 'dm-token-img'}
        style={{
          width: size,
          height: size,
          borderRadius: '50%',
          border,
          // The theme's hairline sits on the art's own edge, inside the overlap ring (shell.css .dm-token-img).
          outlineOffset: ring ? -3 : -1,
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
 * The mark for a token as the read adapter describes it. Curated artwork is
 * preferred; other public token contracts may resolve decorative artwork by
 * exact chain/address through the bounded provider helper. Symbols never
 * select an image, and supply fallback letters only where a vetted list asks
 * for them (`monogram`, 2026-09-25). Missing artwork is a calm disc whose hue
 * comes from the token's address (DESIGN-V2 §3.8), with a 1px theme line, so
 * a pair never looks broken and nothing untrusted is drawn.
 */
type MarkProps = {
  token: TokenDisplay
  size?: number
  ring?: string
  style?: CSSProperties
  /**
   * Missing artwork shows the first two letters of the symbol on the disc.
   * Only for a list that has already vetted its tokens and prints the same
   * symbol beside the mark (the Positions Wallet card, 2026-09-25: a priced,
   * non-look-alike holding), so the letters say nothing the row does not.
   * Everywhere else the disc stays empty (§3.8).
   */
  monogram?: boolean
}

/**
 * Up to two letters or digits of a symbol, upper case. A token with no
 * symbol the adapter would pass (or none with a letter or digit in it) takes
 * the first two hex digits of its address, which the row names it by, so a
 * monogram disc is never empty (2026-09-25).
 */
export function monogramOf(symbol: string | null, address: string): string {
  const letters = symbol === null ? '' : [...symbol.normalize('NFKC').replace(/[^\p{L}\p{N}]/gu, '')].slice(0, 2).join('').toUpperCase()
  return letters !== '' ? letters : /^0x[0-9a-fA-F]{2}/.test(address) ? address.slice(2, 4).toUpperCase() : ''
}

/** A 1px inner line from the strong border token, visible on every card. */
const DISC_LINE = 'inset 0 0 0 1px var(--border-strong)'

export function TokenMark({ token, size = 24, ring, style, monogram }: MarkProps) {
  if (token.artwork) return <TokenIcon symbol={token.artwork} size={size} ring={ring} style={style} />
  return <RemoteTokenMark key={`${token.chainId}:${token.address}`} token={token} size={size} ring={ring} style={style} monogram={monogram} />
}

/** Decoration only: the provider never supplies a symbol, balance or verified badge. */
function RemoteTokenMark({ token, size = 24, ring, style, monogram = false }: MarkProps) {
  // Artwork the resolver already holds paints on the first frame, with no disc before it.
  const [src, setSrc] = useState<string | null>(() => tokenArtwork.peek(token.chainId, token.address) ?? null)
  const [loaded, setLoaded] = useState(false)
  const [broken, setBroken] = useState(false)
  useEffect(() => {
    let alive = true
    if (token.readStatus !== 'no_contract' && tokenArtworkKey(token.chainId, token.address)) {
      void tokenArtwork.resolve(token.chainId, token.address).then((image) => { if (alive) setSrc(image) })
    }
    return () => { alive = false }
  }, [token.chainId, token.address, token.readStatus])
  useEffect(() => {
    if (!src || loaded || broken) return
    const timer = setTimeout(() => {
      setBroken(true)
      tokenArtwork.rejectImage(token.chainId, token.address)
    }, 6000)
    return () => clearTimeout(timer)
  }, [src, loaded, broken, token.chainId, token.address])
  const markStyle: CSSProperties = {
    width: size, height: size, borderRadius: '50%', border: ring ? `2px solid ${ring}` : undefined,
    display: 'inline-block', flexShrink: 0, background: 'var(--surface-3)',
    // The plain disc's own line, inside the overlap ring: until artwork paints, and when there is none. Never letters.
    boxShadow: loaded ? undefined : DISC_LINE,
    ...style,
  }
  if (src && !broken) return <img src={src} alt="" width={size} height={size} draggable={false}
    decoding="async" referrerPolicy="no-referrer" data-token-mark="provider" className="dm-token-img"
    onLoad={() => setLoaded(true)} onError={() => { setBroken(true); tokenArtwork.rejectImage(token.chainId, token.address) }}
    style={{ ...markStyle, outlineOffset: ring ? -3 : -1, objectFit: 'cover' }} />
  // No inline background or shadow here: inline styles would beat the disc's class.
  const letters = monogram ? monogramOf(token.symbol, token.address) : ''
  const discStyle = {
    width: size, height: size, borderRadius: '50%', border: ring ? `2px solid ${ring}` : undefined,
    display: letters ? 'inline-grid' : 'inline-block', flexShrink: 0, '--mark-h': tokenHue(token.address),
    ...(letters ? { fontSize: Math.max(9, Math.round(size * (letters.length > 1 ? 0.34 : 0.42))) } : {}), ...style,
  } as CSSProperties
  // The letters are drawn by the class from `data-letters` (shell.css), not as text: a copied row reads "UFG", never "UF UFG".
  return (
    <span
      aria-hidden="true"
      data-token-mark="unknown"
      data-letters={letters || undefined}
      className={letters ? 'dm-token-disc dm-token-mono' : 'dm-token-disc'}
      style={discStyle}
    />
  )
}

/** `TokenPair` for adapter tokens: the second mark overlaps the first by 30 %, both ringed in the surface they sit on. */
export function TokenMarkPair({ base, quote, size = 32, ring = 'var(--card)' }: { base: TokenDisplay; quote: TokenDisplay; size?: number; ring?: string }) {
  return (
    <span className="inline-flex shrink-0 items-center" aria-hidden="true">
      <TokenMark token={base} size={size} ring={ring} />
      <TokenMark token={quote} size={size} ring={ring} style={{ marginLeft: -size * 0.3 }} />
    </span>
  )
}
