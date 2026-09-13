/**
 * The two-asset split at a given price: the token's share of the position's
 * value and the stablecoin's. Percentage, colour and words all say the same
 * thing, so the bar is never the only cue. No amounts: the position has no size.
 */
export function MixBar({ tokenShare }: { tokenShare: number }) {
  const pct = Math.round(tokenShare * 100)
  return (
    <div>
      <div className="flex h-1.5 overflow-hidden rounded-[var(--radius-pill)] bg-surface-3">
        <div className="transition-[width] duration-200 ease-out" style={{ width: `${pct}%`, background: 'var(--primary-ink)' }} />
        <div className="transition-[width] duration-200 ease-out" style={{ width: `${100 - pct}%`, background: 'var(--fg-faint)' }} />
      </div>
      <div className="mt-2.5 flex items-center justify-between text-caption">
        <span className="flex items-center gap-2">
          <span className="size-2 rounded-full" style={{ background: 'var(--primary-ink)' }} aria-hidden="true" />
          <span className="text-fg-subtle">Token</span>
          <span className="tnum font-medium text-fg">{pct}%</span>
        </span>
        <span className="flex items-center gap-2">
          <span className="tnum font-medium text-fg">{100 - pct}%</span>
          <span className="text-fg-subtle">Stablecoin</span>
          <span className="size-2 rounded-full" style={{ background: 'var(--fg-faint)' }} aria-hidden="true" />
        </span>
      </div>
    </div>
  )
}
