/**
 * The two-asset split at a given price: the token's share of the position's
 * value and the stablecoin's. Percentage, colour and words all say the same
 * thing, so the bar is never the only cue. No amounts: the position has no size.
 */
export function MixBar({ tokenShare }: { tokenShare: number }) {
  const pct = Math.round(tokenShare * 100)
  return (
    <div>
      <div className="flex h-3.5 overflow-hidden rounded-full bg-surface-3">
        <div className="transition-[width] duration-200 ease-out" style={{ width: `${pct}%`, background: 'var(--primary)' }} />
        <div className="transition-[width] duration-200 ease-out" style={{ width: `${100 - pct}%`, background: 'var(--fg-subtle)', opacity: 0.45 }} />
      </div>
      <div className="mt-2.5 flex items-center justify-between text-[12px]">
        <span className="flex items-center gap-2">
          <i className="h-2.5 w-2.5 rounded-full" style={{ background: 'var(--primary)' }} aria-hidden="true" />
          <span className="text-fg-subtle">Token</span>
          <span className="tnum font-mono">{pct}%</span>
        </span>
        <span className="flex items-center gap-2">
          <span className="tnum font-mono">{100 - pct}%</span>
          <span className="text-fg-subtle">Stablecoin</span>
          <i className="h-2.5 w-2.5 rounded-full" style={{ background: 'var(--fg-subtle)', opacity: 0.6 }} aria-hidden="true" />
        </span>
      </div>
    </div>
  )
}
