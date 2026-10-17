import { useEffect, useRef, useState } from 'react'
import { IconChevronRight } from '../icons'
import { cx } from '../ui'
import { HomeAutomationArt, type HomeAutomationKind } from './HomeAutomationArt'
import '../../styles/home-automation-story.css'

const FEATURES: ReadonlyArray<{
  key: HomeAutomationKind
  title: string
  body: string
  fee: string
  href: string
}> = [
  {
    key: 'compound',
    title: 'Auto-compound',
    body: 'Put earned fees back into the same position, in the same range.',
    fee: '2% of earned fees used, once. Your original deposit is not charged.',
    href: '#/automate',
  },
  {
    key: 'domino',
    title: 'Domino-compound',
    body: 'Earned fees can open a higher range. Your original position stays.',
    fee: '4% of earned fees used, once. Your original deposit is not charged.',
    href: '#/automate',
  },
  {
    key: 'autoexit',
    title: 'Auto-exit',
    body: 'Close at your range boundary and send the tokens to your wallet.',
    fee: '0.2% of the position, only when it closes.',
    href: '#/docs/auto-exit',
  },
]

/** The fee's figure in bold, the rest as written: the same words, so the sentence reads exactly as before. */
function Fee({ fee }: { fee: string }) {
  const split = /^([\d.]+%)(.*)$/.exec(fee)
  return split ? <p><b className="tnum">{split[1]}</b>{split[2]}</p> : <p>{fee}</p>
}

/**
 * All three functions stay visible. These educational scenes never enable an automation.
 * V4 (2026-10-16): the three are rows beside one stage; the row under the pointer or focus is the one the stage
 * shows (a look only: each scene stays in its own row's article and keeps running, the others sit unseen behind it).
 */
export function FeatureCards({ className }: { className?: string }) {
  const [active, setActive] = useState<HomeAutomationKind>('compound')
  const grid = useRef<HTMLDivElement>(null)
  // The row under the pointer or holding focus, read from the event's target: a look only, nothing is listened to on
  // the rows' own controls.
  useEffect(() => {
    const node = grid.current
    if (!node) return
    const pick = (event: Event) => {
      const feature = (event.target as Element | null)?.closest?.('[data-feature]')?.getAttribute('data-feature')
      if (feature === 'compound' || feature === 'domino' || feature === 'autoexit') setActive(feature)
    }
    node.addEventListener('pointerover', pick)
    node.addEventListener('focusin', pick)
    return () => {
      node.removeEventListener('pointerover', pick)
      node.removeEventListener('focusin', pick)
    }
  }, [])
  return (
    <div ref={grid} className={cx('dm-home-automation-grid', className)}>
      <div className="dm-home-fx-stage" aria-hidden="true" />
      {FEATURES.map(({ key, title, body, fee, href }) => (
        <article key={key} className="dm-automation-story" data-feature={key} data-active={active === key ? '' : undefined}>
          <div className="dm-automation-story-scene"><HomeAutomationArt kind={key} /></div>
          <div className="dm-automation-story-copy">
            <h3>{title}</h3>
            <p>{body}</p>
            <div className="dm-automation-story-actions">
              <a href={href} aria-label={`How ${title} works`}>How it works<IconChevronRight size={16} /></a>
              <details>
                <summary>Fees</summary>
                <Fee fee={fee} />
              </details>
            </div>
          </div>
        </article>
      ))}
    </div>
  )
}
