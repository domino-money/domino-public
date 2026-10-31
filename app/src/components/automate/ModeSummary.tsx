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
      {/* V4 (2026-10-16): the figure in its own <b> for the ink (approved .mc b). Changed on purpose 2026-10-30 (QA round 2,
          the owner's Q1): Automate's one wording for each fee. */}
      <span className="dm-mode-cost">{fee ? <><b>{fee}</b> of the earned fees it uses, each time</> : <><b>0.2%</b> of the position’s value, only if it closes</>}</span>
    </span>
  )
}

/** The illustration's meaning remains readable when animations are paused or reduced. */
export function FeeJourney({ mode }: { mode: 'compound' | 'domino' }) {
  return (
    <div className="dm-auto-journey" role="group" aria-label={mode === 'compound' ? 'How Auto-compound works' : 'How Domino-compound works'}>
      <span><i aria-hidden="true" />Earned fees</span>
      {/* V4 (2026-10-17): the approved .fj arrow, drawn (30 x 10) instead of a font glyph. */}
      <span className="dm-auto-journey-arrow" aria-hidden="true"><svg width="30" height="10" viewBox="0 0 30 10" fill="none" focusable="false"><path d="M1 5h26M23 1.5 27 5l-4 3.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" /></svg></span>
      <span><i aria-hidden="true" />{mode === 'compound' ? 'Same position' : 'Next price range'}</span>
    </div>
  )
}
