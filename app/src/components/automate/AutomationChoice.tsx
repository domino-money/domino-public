import type { ReactNode } from 'react'
import { Display } from '../ui'
import { PositionChoiceArt } from './ModeArt'
import { HomeAutomationArt } from '../home/HomeAutomationArt'
import { AUTOMATION_CHOICE_COPY } from './copy'
import { docsHref } from '../explore/routes'
import { HowBook } from '../automate-v4/RowIcons'

type Choice = 'plain' | 'protection' | 'compound' | 'domino'

/** "2% of earned fees used, once" → <b>2%</b> and the rest; a fee with no leading figure stays plain text. */
function feeFigure(fee: string): ReactNode {
  const figure = /^(\d[\d.]*%)( .*)$/.exec(fee)
  return figure ? <><b>{figure[1]}</b>{figure[2]}</> : fee
}

/**
 * New position's small still tile on its plate (V4, the owner's approved site/automate.html .npb-art): an outlined domino
 * that tips on the plate's hover. Decoration only; the animated picture beside it stays mounted for the tests.
 */
function PlainTile() {
  return (
    <svg className="dm-npb-tile" width="40" height="58" viewBox="0 0 40 58" fill="none" aria-hidden="true" focusable="false">
      <rect className="npb-plate" x="1" y="51" width="38" height="6" rx="3" />
      <g className="npb-t">
        <rect x="10.6" y="15.6" width="18.8" height="34.8" rx="4.4" stroke="rgb(255 157 98 / .55)" strokeWidth="1.2" />
        <path d="M14 33h12" stroke="rgb(255 157 98 / .55)" strokeWidth="1.1" strokeLinecap="round" />
        <circle cx="16.2" cy="22" r="1.5" fill="rgb(255 157 98 / .55)" /><circle cx="23.8" cy="27" r="1.5" fill="rgb(255 157 98 / .55)" />
        <circle cx="15.8" cy="38.4" r="1.5" fill="rgb(255 157 98 / .55)" /><circle cx="20" cy="42" r="1.5" fill="rgb(255 157 98 / .55)" /><circle cx="24.2" cy="45.6" r="1.5" fill="rgb(255 157 98 / .55)" />
      </g>
    </svg>
  )
}

/**
 * A compact introduction; the existing destination owns review, custody checks and wallet consent. `chosen` marks the row
 * Automate's stage performs (V4: presentational, data-chosen).
 */
export function AutomationChoice({ kind, children, chosen }: { kind: Choice; children: ReactNode; chosen?: boolean }) {
  const copy = AUTOMATION_CHOICE_COPY[kind]
  return <article className="dm-card dm-automation-choice" data-automation-card={kind} data-feature={kind} data-chosen={chosen ? '' : undefined} aria-labelledby={`automate-${kind}`}>
    <div className="dm-automation-choice-art">
      {kind === 'plain'
        ? <><PositionChoiceArt kind="plain" /><PlainTile /></>
        : <HomeAutomationArt kind={kind === 'protection' ? 'autoexit' : kind} />}
    </div>
    <div className="dm-automation-choice-body">
      <div className="dm-automation-choice-heading">
        <Display as="h2" id={`automate-${kind}`} className="dm-display-card">{copy.title}</Display>
      </div>
      <p className="dm-automation-choice-description">{copy.description}</p>
      {/* V4 (2026-10-16): a leading figure in its own <b> for the ink (approved .fn-fee b); the words are unchanged. */}
      <p className="dm-automation-choice-fee">{feeFigure(copy.fee)}</p>
      <div className="dm-automation-choice-entry">{children}</div>
      <a className="dm-automation-choice-doc" href={docsHref(copy.docs)} aria-label={`How ${copy.title} works`}>
        <HowBook /><span>How it works</span>
      </a>
    </div>
  </article>
}
