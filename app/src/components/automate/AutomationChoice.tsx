import type { ReactNode } from 'react'
import { Display } from '../ui'
import { PositionChoiceArt } from './ModeArt'
import { HomeAutomationArt } from '../home/HomeAutomationArt'
import { AUTOMATION_CHOICE_COPY } from './copy'
import { docsHref } from '../explore/routes'
import { IconBook } from '../icons'

type Choice = 'plain' | 'protection' | 'compound' | 'domino'

/** "2% of earned fees used, once" → <b>2%</b> and the rest; a fee with no leading figure stays plain text. */
function feeFigure(fee: string): ReactNode {
  const figure = /^(\d[\d.]*%)( .*)$/.exec(fee)
  return figure ? <><b>{figure[1]}</b>{figure[2]}</> : fee
}

/** A compact introduction; the existing destination owns review, custody checks and wallet consent. */
export function AutomationChoice({ kind, children }: { kind: Choice; children: ReactNode }) {
  const copy = AUTOMATION_CHOICE_COPY[kind]
  return <article className="dm-card dm-automation-choice" data-automation-card={kind} data-feature={kind} aria-labelledby={`automate-${kind}`}>
    <div className="dm-automation-choice-art">
      {kind === 'plain'
        ? <PositionChoiceArt kind="plain" />
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
        <IconBook size={13} /><span>How it works</span>
      </a>
    </div>
  </article>
}
