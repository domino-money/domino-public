import type { ComponentType, CSSProperties } from 'react'
import { ROADMAP } from '../../lib/capabilities'
import { IconChevronRight } from '../icons'
import { Pill, cx } from '../ui'
import { VignetteCompound, VignetteSequence, VignetteWallet, type VignetteProps } from './Vignettes'

/** True while ROADMAP marks the named capability as not connected; the plate says so only then. */
const notConnected = (name: string) => ROADMAP.some((entry) => entry.name === name && entry.status === 'not-connected')

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
    body: 'Sign and approve once. We calculate the best rate of compounding earned fees for maximum return.',
    href: '#/automate',
    link: 'Open Automate',
    roadmap: 'Compound',
    Art: VignetteCompound,
  },
  {
    key: 'domino',
    title: 'Domino Compounder',
    body: 'Our novel auto-compounder. As the token price goes up and out of range, we collect your earned fees and automatically create a new pool above your previous one, drastically reducing risk of impermanent loss. Even if a token runs out of your range, you still earn.',
    href: '#/automate',
    link: 'Open Automate',
    roadmap: 'Domino',
    Art: VignetteSequence,
  },
  {
    key: 'custody',
    title: 'Non-custodial',
    body: 'When you create an automation using Domino, you are the sole owner and only you can control it. Every step is fully automated by a contract whose controller is your signed wallet.',
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
            {roadmap && notConnected(roadmap) && <Pill className="absolute left-3 top-3 z-[1]">Not connected</Pill>}
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
