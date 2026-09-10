import { PAIR } from '../lib/pair'

/**
 * The two-asset split at a given price. Percentage, colour and the written
 * amounts all say the same thing, so the bar is never the only cue.
 */
export function MixBar({
  tokenShare,
  tokenAmount,
  stableAmount,
}: {
  tokenShare: number
  tokenAmount: string
  stableAmount: string
}) {
  const pct = Math.round(tokenShare * 100)
  return (
    <div>
      <div className="flex h-3.5 overflow-hidden rounded-full bg-surface-3">
        <div
          className="transition-[width] duration-200 ease-out"
          style={{ width: `${pct}%`, background: 'var(--primary)' }}
        />
        <div
          className="transition-[width] duration-200 ease-out"
          style={{ width: `${100 - pct}%`, background: 'var(--fg-subtle)', opacity: 0.45 }}
        />
      </div>
      <div className="mt-2.5 flex items-center justify-between text-[12px]">
        <span className="flex items-center gap-2">
          <i
            className="h-2.5 w-2.5 rounded-full"
            style={{ background: 'var(--primary)' }}
            aria-hidden="true"
          />
          <span className="tnum font-mono">{tokenAmount}</span>
          <span className="text-fg-subtle">{PAIR.token}</span>
          <span className="tnum text-fg-subtle">· {pct}%</span>
        </span>
        <span className="flex items-center gap-2">
          <span className="tnum text-fg-subtle">{100 - pct}% ·</span>
          <span className="tnum font-mono">{stableAmount}</span>
          <span className="text-fg-subtle">{PAIR.stable}</span>
          <i
            className="h-2.5 w-2.5 rounded-full"
            style={{ background: 'var(--fg-subtle)', opacity: 0.6 }}
            aria-hidden="true"
          />
        </span>
      </div>
    </div>
  )
}
