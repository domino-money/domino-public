import type { ReactNode } from 'react'
import { rem } from '../lib/rootScale'

/**
 * Domino's inline icon set (DESIGN.md C.19). Every icon is a 16-unit SVG drawn
 * in currentColor with a 1.5 stroke and round ends. A second tone reads
 * `--icon-2` (falling back to currentColor) at .55 opacity, so a parent can
 * lighten it for an active state. Icons are decoration: aria-hidden, never
 * focusable, no title, no text, no letters or digits.
 *
 * Class hooks for motion (the gestures themselves live in art.css):
 * IconMarkets squares `i-t1`..`i-t4` in reading order, IconPositions group
 * `i-tile`, IconAutomate group `i-turn`, IconChevronRight root `i-chev-r`.
 *
 * Changed on purpose 2026-10-03 (the owner: the site looks too big at 100%): `size` is in design px and drawn in rem,
 * so an icon keeps its size beside its text at every scale of the root (lib/rootScale.ts).
 */
export type IconProps = { size?: number; className?: string }

const TWO = 'var(--icon-2, currentColor)'

function Svg({ size = 16, className, children }: IconProps & { children: ReactNode }) {
  return (
    <svg
      width={rem(size)}
      height={rem(size)}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      className={className}
    >
      {children}
    </svg>
  )
}

const withClass = (base: string, className?: string) => (className ? `${base} ${className}` : base)

/** Four tiles; the top-right one in the main tone. */
export function IconMarkets({ size, className }: IconProps) {
  return (
    <Svg size={size} className={className}>
      <rect className="i-t1" x="1.5" y="1.5" width="5.5" height="5.5" rx="1.5" stroke={TWO} opacity=".55" />
      <rect className="i-t2" x="9" y="1.5" width="5.5" height="5.5" rx="1.5" />
      <rect className="i-t3" x="1.5" y="9" width="5.5" height="5.5" rx="1.5" stroke={TWO} opacity=".55" />
      <rect className="i-t4" x="9" y="9" width="5.5" height="5.5" rx="1.5" stroke={TWO} opacity=".55" />
    </Svg>
  )
}

/**
 * A domino tile: one pip above the divider, three below (1|3, never the
 * brand mark's 2|1). Used only in the nav pill and the menu, never on a plate,
 * a tile or an indicator of its own.
 */
export function IconPositions({ size, className }: IconProps) {
  return (
    <Svg size={size} className={className}>
      <g className="i-tile">
        <rect x="4" y="1" width="8" height="14" rx="2" />
        <path d="M5.5 8h5" stroke={TWO} opacity=".55" />
        <circle cx="8" cy="4.5" r="1" fill="currentColor" stroke="none" />
        <circle cx="6" cy="9.8" r="1" fill="currentColor" stroke="none" />
        <circle cx="8" cy="11.5" r="1" fill="currentColor" stroke="none" />
        <circle cx="10" cy="13.2" r="1" fill="currentColor" stroke="none" />
      </g>
    </Svg>
  )
}

/** A turning arc around a fixed point. */
export function IconAutomate({ size, className }: IconProps) {
  return (
    <Svg size={size} className={className}>
      <g className="i-turn">
        <path d="M12.21 11.54A5.5 5.5 0 1 1 12.21 4.46" />
        <path d="M12.21 1.46v3l-2.95-.52" />
        <circle cx="8" cy="8" r="1.5" fill={TWO} stroke="none" opacity=".55" />
      </g>
    </Svg>
  )
}

export function IconMenu({ size, className }: IconProps) {
  return (
    <Svg size={size} className={className}>
      <path d="M2.5 4.5h11M2.5 8h11M2.5 11.5h11" />
    </Svg>
  )
}

export function IconClose({ size, className }: IconProps) {
  return (
    <Svg size={size} className={className}>
      <path d="m4 4 8 8M12 4l-8 8" />
    </Svg>
  )
}

export function IconChevronRight({ size, className }: IconProps) {
  return (
    <Svg size={size} className={withClass('i-chev-r', className)}>
      <path d="m6 3.5 4.5 4.5L6 12.5" />
    </Svg>
  )
}

export function IconChevronLeft({ size, className }: IconProps) {
  return (
    <Svg size={size} className={className}>
      <path d="M10 3.5 5.5 8l4.5 4.5" />
    </Svg>
  )
}

export function IconChevronDown({ size, className }: IconProps) {
  return (
    <Svg size={size} className={className}>
      <path d="m3.5 6 4.5 4.5L12.5 6" />
    </Svg>
  )
}

export function IconArrowUpRight({ size, className }: IconProps) {
  return (
    <Svg size={size} className={className}>
      <path d="M5 11 11 5M6 5h5v5" />
    </Svg>
  )
}

export function IconSearch({ size, className }: IconProps) {
  return (
    <Svg size={size} className={className}>
      <circle cx="7" cy="7" r="4.5" />
      <path d="m10.5 10.5 3 3" />
    </Svg>
  )
}

export function IconCopy({ size, className }: IconProps) {
  return (
    <Svg size={size} className={className}>
      <rect x="5.5" y="5.5" width="8" height="8" rx="1.5" />
      <path d="M10.5 5.5V4A1.5 1.5 0 0 0 9 2.5H4A1.5 1.5 0 0 0 2.5 4v5A1.5 1.5 0 0 0 4 10.5h1.5" stroke={TWO} opacity=".55" />
    </Svg>
  )
}

/** A tick. `pathLength="1"` lets `.dm-check-draw` draw it in (stroke-dashoffset 1 → 0). */
export function IconCheck({ size, className }: IconProps) {
  return (
    <Svg size={size} className={className}>
      <path d="m3.5 8.5 3 3 6-7" pathLength={1} />
    </Svg>
  )
}

/** A circle with a stem and a point: drawn shapes, not a letter. */
export function IconInfo({ size, className }: IconProps) {
  return (
    <Svg size={size} className={className}>
      <circle cx="8" cy="8" r="6" />
      <path d="M8 7.25V11" />
      <circle cx="8" cy="5" r=".85" fill="currentColor" stroke="none" />
    </Svg>
  )
}

export function IconPlus({ size, className }: IconProps) {
  return (
    <Svg size={size} className={className}>
      <path d="M8 3.5v9M3.5 8h9" />
    </Svg>
  )
}

export function IconMinus({ size, className }: IconProps) {
  return (
    <Svg size={size} className={className}>
      <path d="M3.5 8h9" />
    </Svg>
  )
}

/** Three dots in a row: the header menu's glyph from 768px. */
export function IconMore({ size, className }: IconProps) {
  return (
    <Svg size={size} className={className}>
      <circle cx="3.5" cy="8" r="1.25" fill="currentColor" stroke="none" />
      <circle cx="8" cy="8" r="1.25" fill="currentColor" stroke="none" />
      <circle cx="12.5" cy="8" r="1.25" fill="currentColor" stroke="none" />
    </Svg>
  )
}

/** A line that falls, over a faint floor. */
export function IconChartDown({ size, className }: IconProps) {
  return (
    <Svg size={size} className={className}>
      <path d="M2 13.5h12" stroke={TWO} opacity=".55" />
      <path d="M2.5 4l3.5 3.5 2.5-2 5 5" />
      <path d="M13.5 7.5v3h-3" />
    </Svg>
  )
}

/** Two stacked coins. */
export function IconCoins({ size, className }: IconProps) {
  return (
    <Svg size={size} className={className}>
      <ellipse cx="6.5" cy="5" rx="4" ry="2" />
      <path d="M2.5 5v3c0 1.1 1.8 2 4 2s4-.9 4-2V5" stroke={TWO} opacity=".55" />
      <path d="M9.5 9.35c.3-.05.6-.1.9-.1 2.2 0 3.6.9 3.6 2v1.5c0 1.1-1.8 2-4 2-1.65 0-3.05-.5-3.65-1.2" />
    </Svg>
  )
}

/** A key. */
export function IconKey({ size, className }: IconProps) {
  return (
    <Svg size={size} className={className}>
      <circle cx="5.25" cy="10.75" r="2.75" />
      <path d="m7.25 8.75 6-6M11 5l1.75 1.75M9.5 6.5l1.25 1.25" stroke={TWO} opacity=".55" />
    </Svg>
  )
}

/** A shield. */
export function IconShield({ size, className }: IconProps) {
  return (
    <Svg size={size} className={className}>
      <path d="M8 1.75 3 3.75v4c0 3.1 2.15 5.4 5 6.5 2.85-1.1 5-3.4 5-6.5v-4z" />
      <path d="M8 4.5v7" stroke={TWO} opacity=".55" />
    </Svg>
  )
}

/** A padlock. */
export function IconLock({ size, className }: IconProps) {
  return (
    <Svg size={size} className={className}>
      <rect x="3" y="7" width="10" height="7.5" rx="2" />
      <path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" stroke={TWO} opacity=".55" />
      <circle cx="8" cy="10.75" r=".9" fill="currentColor" stroke="none" />
    </Svg>
  )
}

export function IconWallet({ size, className }: IconProps) {
  return (
    <Svg size={size} className={className}>
      <rect x="2" y="4" width="12" height="9" rx="2" />
      <path d="M2 6.5h12" stroke={TWO} opacity=".55" />
      <circle cx="11.5" cy="8.5" r=".9" fill="currentColor" stroke="none" />
    </Svg>
  )
}

/** V4's wallet glyph (the header's wallet control, study/20-v4-language.md §3.1): a card with its clasp. */
export function IconWalletLine({ size, className }: IconProps) {
  return (
    <Svg size={size} className={className}>
      <rect x="1.75" y="3.25" width="12.5" height="9.5" rx="2.25" strokeWidth={1.4} />
      <path d="M10.5 8h1.5" strokeWidth={1.6} />
    </Svg>
  )
}

export function IconRange({ size, className }: IconProps) {
  return (
    <Svg size={size} className={className}>
      <path d="M2 5h12M2 11h12" stroke={TWO} opacity=".55" />
      <circle cx="9" cy="8" r="1.5" fill="currentColor" stroke="none" />
    </Svg>
  )
}

export function IconReceipt({ size, className }: IconProps) {
  return (
    <Svg size={size} className={className}>
      <path d="M3 1.5h10v13l-1.67-1.25-1.66 1.25L8 13.25 6.33 14.5l-1.66-1.25L3 14.5z" />
      <path d="M5.5 5.5h5M5.5 8.5h5" stroke={TWO} opacity=".55" />
    </Svg>
  )
}

/** Two bars. */
export function IconPause({ size, className }: IconProps) {
  return (
    <Svg size={size} className={className}>
      <path d="M5.75 3.5v9M10.25 3.5v9" />
    </Svg>
  )
}

/** A triangle pointing forward. */
export function IconPlay({ size, className }: IconProps) {
  return (
    <Svg size={size} className={className}>
      <path d="M5 3.4v9.2a.6.6 0 0 0 .9.52l7.6-4.6a.6.6 0 0 0 0-1.04L5.9 2.88A.6.6 0 0 0 5 3.4z" />
    </Svg>
  )
}

/** An open book. */
export function IconBook({ size, className }: IconProps) {
  return (
    <Svg size={size} className={className}>
      <path d="M8 4c-1.5-1-3.5-1.25-5.5-1v9.5c2-.25 4 0 5.5 1 1.5-1 3.5-1.25 5.5-1V3c-2-.25-4 0-5.5 1z" />
      <path d="M8 4v9.5" stroke={TWO} opacity=".55" />
    </Svg>
  )
}

/** A five-pointed star: Points (added 2026-11-07, the owner's Points page, Season 1). */
export function IconStar({ size, className }: IconProps) {
  return (
    <Svg size={size} className={className}>
      <path d="M8 1.9l1.8 3.75 4.1.55-3 2.85.75 4.05L8 11.15 4.35 13.1l.75-4.05-3-2.85 4.1-.55z" />
    </Svg>
  )
}
