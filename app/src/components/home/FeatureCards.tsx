import type { ComponentType, CSSProperties } from 'react'
import { IconChevronRight } from '../icons'
import { cx } from '../ui'
import { VignetteCompound, VignetteExit, VignetteSequence, type VignetteProps } from './Vignettes'

const FEATURES: ReadonlyArray<{
  key: string
  title: string
  outcome: string
  body: string
  href: string
  link: string
  Art: ComponentType<VignetteProps>
}> = [
  {
    key: 'compound',
    title: 'Auto-compound',
    outcome: 'Build on the same position.',
    body: 'Earned fees go back into the position that earned them. Your price range stays the same.',
    href: '#/automate',
    link: 'Explore Auto-compound',
    Art: VignetteCompound,
  },
  {
    key: 'domino',
    title: 'Domino-compound',
    outcome: 'Let fees fund the next step.',
    body: 'Near the top of a range, earned fees fund the next position higher in the same pool. You set how far the sequence can go.',
    href: '#/automate',
    link: 'Explore Domino-compound',
    Art: VignetteSequence,
  },
  // Changed on purpose 2026-10-06 (the owner's point 5; rugged97: "it goes in the home page cards, in place of
  // Non-custodial"): Auto-exit, with its own drawing, and its page of the docs. Non-custodial stays in the docs' start.
  {
    key: 'autoexit',
    title: 'Auto-exit',
    outcome: 'Close at the edge.',
    body: 'When the price reaches the end of your range, Domino closes the position and sends the tokens to your wallet.',
    href: '#/docs/auto-exit',
    link: 'How it works',
    Art: VignetteExit,
  },
]

/**
 * Home's three features (DESIGN-V2 §7.1-3). Each is one card: a dotted plate
 * with its looping drawing inset at the top, the words under it. The card is
 * not a link (its link is), so hovering it only lights its ring and slides the
 * link's chevron. The cards rise in one after another on the first load
 * (`delay` is the first one's delay in ms, then 40 ms apart); each drawing
 * plays only while it is in view.
 *
 * Changed on purpose 2026-10-03 (the owner: "Starts paused" is not needed on these cards): the plates wear no pill; the
 * docs pages still say where each automation stands.
 */
export function FeatureCards({ className, delay = 160 }: { className?: string; delay?: number }) {
  return (
    <div className={cx('dm-features', className)}>
      {FEATURES.map(({ key, title, outcome, body, href, link, Art }, index) => (
        <article key={key} data-feature={key} className="dm-card dm-feature animate-rise" style={{ '--delay': `${delay + 40 * index}ms` } as CSSProperties}>
          <div className="dm-plate dm-dots-plate dm-vig-plate">
            <Art className="absolute inset-0" />
          </div>
          <div className="dm-feature-body">
            <p className="dm-feature-kind">{title}</p>
            <h3 className="dm-feature-title">{outcome}</h3>
            <p className="dm-feature-text">{body}</p>
            <a href={href} className="dm-vig-link">
              {link}
              <IconChevronRight size={16} />
            </a>
          </div>
        </article>
      ))}
    </div>
  )
}
