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

/** All three functions stay visible. These educational scenes never enable an automation. */
export function FeatureCards({ className }: { className?: string }) {
  return (
    <div className={cx('dm-home-automation-grid', className)}>
      {FEATURES.map(({ key, title, body, fee, href }) => (
        <article key={key} className="dm-automation-story" data-feature={key}>
          <div className="dm-automation-story-scene"><HomeAutomationArt kind={key} /></div>
          <div className="dm-automation-story-copy">
            <h3>{title}</h3>
            <p>{body}</p>
            <div className="dm-automation-story-actions">
              <a href={href} aria-label={`How ${title} works`}>How it works<IconChevronRight size={16} /></a>
              <details>
                <summary>Fees</summary>
                <p>{fee}</p>
              </details>
            </div>
          </div>
        </article>
      ))}
    </div>
  )
}
