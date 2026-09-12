/** Shared brand tile, restored from the owner's cc437b4 artwork change.
 * Keep the 1:1.75 body, cream pips (two above, one below) and theme accent. */
export function BrandMark({ width = 18, height = 30, className }: { width?: number; height?: number; className?: string }) {
  return (
    <svg width={width} height={height} viewBox="0 0 20 34" className={className} aria-hidden="true">
      <rect x="0.6" y="0.6" width="18.8" height="32.8" rx="2.6" fill="var(--primary)" />
      <rect x="2.2" y="16.6" width="15.6" height="0.9" rx="0.45" fill="var(--primary-fg)" opacity="0.32" />
      <circle cx="14.1" cy="5.85" r="1.95" fill="#faf5ea" />
      <circle cx="6.05" cy="12.7" r="1.95" fill="#faf5ea" />
      <circle cx="9.62" cy="25.2" r="1.95" fill="#faf5ea" />
    </svg>
  )
}
