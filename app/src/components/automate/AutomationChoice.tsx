import type { ReactNode } from 'react'
import { Display } from '../ui'
import { ModeArt, PositionChoiceArt } from './ModeArt'
import { AUTOMATION_CHOICE_COPY } from './copy'

type Choice = 'plain' | 'protection' | 'compound' | 'domino'

/** A compact introduction; the existing destination owns review, custody checks and wallet consent. */
export function AutomationChoice({ kind, children }: { kind: Choice; children: ReactNode }) {
  const copy = AUTOMATION_CHOICE_COPY[kind]
  return <article className="dm-card dm-automation-choice" data-automation-card={kind} data-feature={kind} aria-labelledby={`automate-${kind}`}>
    <div className="dm-plate dm-dots-plate dm-automation-choice-art">
      {kind === 'compound' || kind === 'domino'
        ? <ModeArt mode={kind} size="card" play="loop" />
        : <PositionChoiceArt kind={kind} />}
    </div>
    <div className="dm-automation-choice-body">
      <Display as="h2" id={`automate-${kind}`} className="dm-display-card">{copy.title}</Display>
      <p className="dm-automation-choice-description">{copy.description}</p>
      <p className="dm-automation-choice-fee">{copy.fee}</p>
      <div className="dm-automation-choice-entry">{children}</div>
    </div>
  </article>
}
