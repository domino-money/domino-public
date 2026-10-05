import { VignetteCompound, VignetteSequence } from './home/Vignettes'

/** The same drawings used on Home and Automate; fee destinations, never projected earnings. */
export function FeeFlowDemo({ running, phase }: { running: boolean; phase: 'compound' | 'domino' | 'outside' }) {
  return (
    <div className="dm-sim-fees" aria-label="Two ways to reinvest earned fees">
      <div className="dm-sim-fee-option" data-sim-fee-mode="compound" data-active={phase === 'compound' ? '' : undefined}>
        <div className="dm-sim-fee-art" data-play="automatic" data-destination="same-position">
          <VignetteCompound key={phase === 'compound' ? 'active' : 'idle'} running={running && phase === 'compound'} />
        </div>
        <div className="dm-sim-fee-copy">
          <h3>Auto-compound</h3>
          <p>Fees back into the same position.</p>
        </div>
      </div>
      <div className="dm-sim-fee-option" data-sim-fee-mode="domino" data-active={phase === 'domino' ? '' : undefined}>
        <div className="dm-sim-fee-art" data-play="automatic" data-destination="next-range">
          <VignetteSequence key={phase === 'domino' ? 'active' : 'idle'} running={running && phase === 'domino'} />
        </div>
        <div className="dm-sim-fee-copy">
          <h3>Domino-compound</h3>
          <p>Near the top, fees open the next range.</p>
        </div>
      </div>
    </div>
  )
}
