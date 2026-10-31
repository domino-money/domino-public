import { useEffect, useRef } from 'react'
import { IconChevronRight } from '../icons'
import { cx } from '../ui'
import type { HomeAutomationKind } from './HomeAutomationArt'
import { HomeFunctionLayer } from './HomeFunctionLayer'
import { homeStory, locOf, useHomeStoryState, type FxMode } from './homeStory'
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
    body: 'Adds earned fees back into the same position, in the same range.',
    // Changed on purpose 2026-10-30 (QA round 2, Q1 and N12): the fees in the words Automate, the docs and the pool page
    // use (one fee wording everywhere), and "deposit" and "the end of your range" as everywhere else. The body is
    // Automate's own sentence for the same feature (components/automate/copy.ts), word for word.
    fee: '2% of the earned fees it uses, each time. Your original deposit is not charged.',
    // Changed on purpose 2026-10-30 (QA round 2, Q16): each "How it works" opens its own docs page, as Auto-exit's and the
    // Automate page's do; these two still opened the setup page they linked to before #407 renamed them.
    href: '#/docs/auto-compound',
  },
  {
    key: 'domino',
    title: 'Domino-compound',
    body: 'Earned fees can open a higher range. Your original deposit stays.',
    fee: '4% of the earned fees it uses, each time. Your original deposit is not charged.',
    href: '#/docs/domino-compound',
  },
  {
    key: 'autoexit',
    title: 'Auto-exit',
    body: 'Closes at the end of your range and sends the tokens to your wallet.',
    fee: '0.2% of the position’s value, only if it closes.',
    href: '#/docs/auto-exit',
  },
]

const MODE: Record<HomeAutomationKind, FxMode> = { compound: 'compound', domino: 'domino', autoexit: 'exit' }

/** The fee's figure in bold, the rest as written: the same words, so the sentence reads exactly as before. */
function Fee({ fee }: { fee: string }) {
  const split = /^([\d.]+%)(.*)$/.exec(fee)
  return split ? <p><b className="tnum">{split[1]}</b>{split[2]}</p> : <p>{fee}</p>
}

const featureOf = (target: EventTarget | null): HomeAutomationKind | null => {
  const feature = (target as Element | null)?.closest?.('[data-feature]')?.getAttribute('data-feature')
  return feature === 'compound' || feature === 'domino' || feature === 'autoexit' ? feature : null
}

/**
 * All three functions stay visible. These educational scenes never enable an automation.
 * V4 (2026-10-16, the approved prototype): the three are rows beside one stage. A row under the pointer (after 90 ms, so a
 * sweep across the rows never flickers the stage), or picked by a press or focus (at once), is the one the stage acts out;
 * while the reader is in this place its story plays once and holds, and hovering the stage replays it. A look only:
 * every row keeps its own scene layer in its own article, and nothing is listened to on the rows' own controls.
 */
export function FeatureCards({ className }: { className?: string }) {
  const story = useHomeStoryState()
  const active = (Object.keys(MODE) as HomeAutomationKind[]).find((key) => MODE[key] === story.mode) ?? 'compound'
  const live = story.act === 'fn'
  // The tile stands here (the stage's own place for it is lit only while it is away).
  const here = story.ready && locOf(story.act, story.rangeOpen) === 'fn'
  const grid = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const node = grid.current
    if (!node) return
    let pending: ReturnType<typeof setTimeout> | undefined
    const hover = (event: PointerEvent) => {
      if (event.pointerType === 'touch') return
      const feature = featureOf(event.target)
      if (!feature) return
      clearTimeout(pending)
      pending = setTimeout(() => homeStory.setMode(MODE[feature]), 90)
    }
    const pick = (event: Event) => {
      const feature = featureOf(event.target)
      if (!feature) return
      clearTimeout(pending)
      homeStory.setMode(MODE[feature], 'fn')
    }
    const leave = () => clearTimeout(pending)
    node.addEventListener('pointerover', hover)
    node.addEventListener('pointerleave', leave)
    node.addEventListener('focusin', pick)
    node.addEventListener('click', pick)
    return () => {
      clearTimeout(pending)
      node.removeEventListener('pointerover', hover)
      node.removeEventListener('pointerleave', leave)
      node.removeEventListener('focusin', pick)
      node.removeEventListener('click', pick)
    }
  }, [])
  return (
    <div ref={grid} className={cx('dm-home-automation-grid', className)} data-fx-mode={story.mode} data-fx-key={story.fnKey} data-fx-live={live ? '' : undefined}>
      <div className="dm-home-fx-stage dm-lit" aria-hidden="true" onMouseEnter={homeStory.replayFunctions}>
        <div className="dm-fx-box">
          <div className="dm-fx-scene">
            <span className="dm-fx-floor" />
            <span className="dm-fx-ba">
              <span className="dm-gl-depth" />
              <span className="dm-gl"><span className="dm-gl-fill" /><span className="dm-gl-edge" /></span>
              <svg className="dm-fx-price" viewBox="0 0 320 46" focusable="false">
                <path className="dm-fx-pl" pathLength={100} d="M16 36 L48 27 L80 31 L112 19 L144 23 L176 12 L208 15 L240 7 L272 10 L304 0" />
                <circle className="dm-fx-pd" cx="304" cy="0" r="4" />
              </svg>
            </span>
            <span className={cx('dm-foot dm-fx-foot', !here && 'is-away')}>
              <span className="dm-foot-groove" />
              {[1, 2, 3, 4, 5].map((p) => <span key={p} className={`dm-foot-pip dm-foot-p${p}`} />)}
            </span>
          </div>
        </div>
      </div>
      {FEATURES.map(({ key, title, body, fee, href }) => (
        <article key={key} className="dm-automation-story" data-feature={key} data-active={active === key ? '' : undefined}>
          <div className="dm-automation-story-scene"><HomeFunctionLayer kind={key} /></div>
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
