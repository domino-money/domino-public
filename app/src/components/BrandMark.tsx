import { rem } from '../lib/rootScale'

/** The brand tile (V4, the owner-approved prototype's mark, 2026-10-16): a Tangerine domino standing upright, the groove
 * across its middle, two pips above and three below in Tangerine's own ink; nothing sits behind it. Changed on purpose
 * from the cc437b4 artwork (cream pips, two above and one below); the favicon keeps that one. Its size is in design px,
 * drawn in rem (lib/rootScale.ts). */
export function BrandMark({ width = 17, height = 29, className }: { width?: number; height?: number; className?: string }) {
  return (
    <svg width={rem(width)} height={rem(height)} viewBox="0 0 17 29" fill="none" className={className} aria-hidden="true">
      <rect x="0.5" y="0.5" width="16" height="28" rx="4" fill="var(--primary)" />
      <path d="M3.5 14.5h10" stroke="var(--primary-fg)" strokeOpacity="0.55" strokeWidth="1.2" strokeLinecap="round" />
      <g fill="var(--primary-fg)">
        <circle cx="5.6" cy="5.4" r="1.55" />
        <circle cx="11.4" cy="9.6" r="1.55" />
        <circle cx="5.2" cy="18.6" r="1.55" />
        <circle cx="8.5" cy="21.6" r="1.55" />
        <circle cx="11.8" cy="24.6" r="1.55" />
      </g>
    </svg>
  )
}
