/**
 * The two-asset split at a given price: the token's share of the position's
 * value and the stablecoin's (DESIGN-V2 §7.1-6). Percentage, colour and words
 * all say the same thing, so the bar is never the only cue; the bar itself is
 * decoration. No amounts: the position has no size. The segments share the
 * track 2px apart and follow the price at once, as the price marker does; a
 * share of 0 folds its segment away.
 */
export function MixBar({ tokenShare }: { tokenShare: number }) {
  const pct = Math.round(tokenShare * 100)
  return (
    <div className="dm-mix">
      <div aria-hidden="true" className="dm-mix-bar">
        <span className="dm-mix-seg" data-tone="token" data-empty={pct === 0 ? '' : undefined} style={{ flexGrow: pct }} />
        <span className="dm-mix-seg" data-tone="stable" data-empty={pct === 100 ? '' : undefined} style={{ flexGrow: 100 - pct }} />
      </div>
      <div className="dm-mix-legend">
        <span className="dm-mix-key">
          <span className="dm-mix-dot" data-tone="token" aria-hidden="true" />
          <span className="text-fg-subtle">Token</span>
          <span className="tnum dm-mix-pct">{pct}%</span>
        </span>
        <span className="dm-mix-key">
          <span className="tnum dm-mix-pct">{100 - pct}%</span>
          <span className="text-fg-subtle">Stablecoin</span>
          <span className="dm-mix-dot" data-tone="stable" aria-hidden="true" />
        </span>
      </div>
    </div>
  )
}
