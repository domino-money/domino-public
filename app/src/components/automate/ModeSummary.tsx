/** Plain-language labels shared by both automation setup screens. No policy or wallet behavior lives here. */
const PURPOSE = {
  compound: 'Reinvest earned fees into the same position.',
  domino: 'Use earned fees to grow into the next price range.',
  // Changed on purpose 2026-10-06 (the owner's point 5: Auto-exit closes at the range's edges; no price is typed).
  protection: 'Closes the position at the end of its range.',
} as const

export function ModeSummary({ mode, title, fee }: { mode: keyof typeof PURPOSE; title: string; fee: string | null }) {
  return (
    <span className="dm-mode-copy">
      <span className="dm-mode-name">{title}</span>
      <span className="dm-mode-purpose">{PURPOSE[mode]}</span>
      {/* V4 (2026-10-16): the figure in its own <b> for the ink (approved .mc b); the words are unchanged. */}
      <span className="dm-mode-cost">{fee ? <><b>{fee}</b> of the earned fees it uses</> : <><b>0.2%</b> of its value, only if it closes</>}</span>
    </span>
  )
}

/** The illustration's meaning remains readable when animations are paused or reduced. */
export function FeeJourney({ mode }: { mode: 'compound' | 'domino' }) {
  return (
    <div className="dm-auto-journey" role="group" aria-label={mode === 'compound' ? 'How Auto-compound works' : 'How Domino-compound works'}>
      <span><i aria-hidden="true" />Earned fees</span>
      <span className="dm-auto-journey-arrow" aria-hidden="true">→</span>
      <span><i aria-hidden="true" />{mode === 'compound' ? 'Same position' : 'Next price range'}</span>
    </div>
  )
}
