import type { ComponentType, CSSProperties } from 'react'
import { RoadmapPill } from '../automate/RoadmapPill'
import { IconChevronRight } from '../icons'
import { cx } from '../ui'
import { VignetteCompound, VignetteSequence, VignetteWallet, type VignetteProps } from './Vignettes'

const FEATURES: ReadonlyArray<{
  key: string
  title: string
  body: string
  href: string
  link: string
  /** The ROADMAP entry whose status the plate shows, if any. */
  roadmap?: string
  Art: ComponentType<VignetteProps>
}> = [
  {
    key: 'compound',
    title: 'Auto-compound',
    // Changed on purpose 2026-10-01 (audit E3): no "principal" on Home; the tokens you put in are your deposit.
    body: 'Earned fees go back into the same position. The range stays as it is, and the fees become more liquidity inside it. Your deposit is never sold.',
    href: '#/automate',
    link: 'Open Automate',
    roadmap: 'Compound',
    Art: VignetteCompound,
  },
  {
    key: 'domino',
    title: 'Domino-compound',
    // Changed on purpose 2026-10-01 (audit E3): plain words for "never principal" and "the sequence stops at a cap".
    body: 'Near the top of a range, earned fees fund the next position one step higher in the same pool, new or already open, instead of returning to the position that earned them. It uses fees only, never your deposit, and opens no more positions than the number you set.',
    href: '#/automate',
    link: 'Open Automate',
    roadmap: 'Domino',
    Art: VignetteSequence,
  },
  {
    key: 'custody',
    title: 'Non-custodial',
    body: 'You stay the owner: Domino never holds your keys. You approve one position at a time, never a blanket approval over all of them, and that approval is yours to withdraw.',
    // The Non-custodial page of the docs; its route is added alongside the docs.
    href: '#/docs/non-custodial',
    link: 'How it works',
    Art: VignetteWallet,
  },
]

/**
 * Home's three features (DESIGN-V2 §7.1-3). Each is one card: a dotted plate
 * with its looping drawing inset at the top, the words under it. The card is
 * not a link (its link is), so hovering it only lights its ring and slides the
 * link's chevron. The cards rise in one after another on the first load
 * (`delay` is the first one's delay in ms, then 40 ms apart); each drawing
 * plays only while it is in view.
 */
export function FeatureCards({ className, delay = 160 }: { className?: string; delay?: number }) {
  return (
    <div className={cx('dm-features', className)}>
      {FEATURES.map(({ key, title, body, href, link, roadmap, Art }, index) => (
        <article key={key} className="dm-card dm-feature animate-rise" style={{ '--delay': `${delay + 40 * index}ms` } as CSSProperties}>
          <div className="dm-plate dm-dots-plate dm-vig-plate">
            {/* ROADMAP's pill describes owner-scoped readiness for automated features. */}
            {roadmap && <RoadmapPill name={roadmap} className="dm-feature-pill" />}
            <Art className="absolute inset-0" />
          </div>
          <div className="dm-feature-body">
            <h2 className="dm-subtitle">{title}</h2>
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
