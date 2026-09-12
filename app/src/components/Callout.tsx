import type { ReactNode } from 'react'

/**
 * A titled note in the accent colour, for something the reader has to take in
 * before acting: what signing in does and does not authorise, above all.
 *
 * Plain markup on purpose. It carries no data, reads nothing and imports
 * nothing but a type, so any screen may use it without pulling a feature in
 * behind it.
 */
export function Callout({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="rounded-[var(--radius)] border p-4" style={{ background: 'var(--accent)', borderColor: 'transparent' }}>
      <strong className="block text-[13px]" style={{ color: 'var(--accent-fg)' }}>
        {title}
      </strong>
      <div className="mt-1 text-[13px] leading-relaxed" style={{ color: 'var(--accent-fg)', opacity: 0.85 }}>
        {children}
      </div>
    </div>
  )
}
