import type { ReactNode } from 'react'
import { rem } from '../../lib/rootScale'

/**
 * The position page's action glyphs as the approved V4 page draws them (site/position.html and position-base.html, the
 * action row: 16 units, a 1.4 stroke, round ends and joins). Decoration only, as every icon of ../icons.tsx: aria-hidden,
 * never focusable, no text. Class hooks for motion: IconRangeArrows' two heads `dm-ar-l` and `dm-ar-r` (they part on
 * hover, v4-position.css).
 */
type GlyphProps = { size?: number; className?: string }

function Glyph({ size = 16, className, children }: GlyphProps & { children: ReactNode }) {
  return (
    <svg width={rem(size)} height={rem(size)} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.4} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false" className={className}>
      {children}
    </svg>
  )
}

/** Collect fees: a stack of coins. */
export function IconCollect({ size, className }: GlyphProps) {
  return (
    <Glyph size={size} className={className}>
      <ellipse cx="8" cy="4.6" rx="4.75" ry="2" />
      <path d="M3.25 4.6v3.2c0 1.1 2.1 2 4.75 2s4.75-.9 4.75-2V4.6M3.25 7.8V11c0 1.1 2.1 2 4.75 2s4.75-.9 4.75-2V7.8" />
    </Glyph>
  )
}

/** Change range: a double arrow, its two heads apart. */
export function IconRangeArrows({ size, className }: GlyphProps) {
  return (
    <Glyph size={size} className={className}>
      <path d="M5.5 8h5" />
      <path className="dm-ar-l" d="M5 5.5 2.5 8 5 10.5M2.5 8h3" />
      <path className="dm-ar-r" d="m11 5.5 2.5 2.5-2.5 2.5M13.5 8h-3" />
    </Glyph>
  )
}

/** Withdraw: an arrow down into a tray. */
export function IconWithdrawTray({ size, className }: GlyphProps) {
  return (
    <Glyph size={size} className={className}>
      <path d="M8 2.5v7M5 6.8l3 3 3-3" />
      <path d="M2.75 10.5v1.75c0 .7.55 1.25 1.25 1.25h8c.7 0 1.25-.55 1.25-1.25V10.5" />
    </Glyph>
  )
}

/** Auto-exit: a plain shield outline. */
export function IconShieldPlain({ size, className }: GlyphProps) {
  return (
    <Glyph size={size} className={className}>
      <path d="M8 1.9 3.1 3.8v3.9c0 3 2.1 5.1 4.9 6.4 2.8-1.3 4.9-3.4 4.9-6.4V3.8z" />
    </Glyph>
  )
}
