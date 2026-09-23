import type { ComponentType, CSSProperties } from 'react'
import { RoadmapPill } from '../../screens/Automate'
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
    body: 'Earned fees go back into the same position. The range stays as it is, and the fees become more liquidity inside it. Your principal is never sold.',
    href: '#/automate',
    link: 'Open Automate',
    roadmap: 'Compound',
    Art: VignetteCompound,
  },
  {
    key: 'domino',
    title: 'Domino-compound',
    body: 'Near the top of a range, earned fees fund the next position one step higher in the same pool, new or already open, instead of returning to the position that earned them. Fees only, never principal, and the sequence stops at a cap you set.',
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
 * Home's three features, each a small looping drawing on a dotted plate with
 * its caption under it. The columns rise in one after another; each drawing
 * plays only while it is in view. `delay` is the first column's entrance delay in ms.
 */
export function FeatureCards({ className, delay = 60 }: { className?: string; delay?: number }) {
  return (
    <div className={cx('grid gap-x-6 gap-y-10 md:grid-cols-3', className)}>
      {FEATURES.map(({ key, title, body, href, link, roadmap, Art }, index) => (
        <article key={key} className="dm-vig-feature" style={{ '--delay': `${delay + 120 * index}ms` } as CSSProperties}>
          <div className="dm-plate dm-dots-plate dm-vig-plate">
            {/* ROADMAP's pill describes owner-scoped readiness for automated features. */}
            {roadmap && <RoadmapPill name={roadmap} className="absolute left-3 top-3 z-[1]" />}
            <Art className="absolute inset-0" />
          </div>
          <h2 className="mt-5 text-lead font-medium text-fg">{title}</h2>
          <p className="mt-1 text-body text-fg-muted">{body}</p>
          <a href={href} className="dm-vig-link">
            {link}
            <IconChevronRight size={14} />
          </a>
        </article>
      ))}
    </div>
  )
}
