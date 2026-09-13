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
    body: 'Earned fees are added back into the same position. Only fees are used; the deposit stays in the position.',
    href: '#/automate',
    link: 'Open Automate',
    roadmap: 'Compound',
    Art: VignetteCompound,
  },
  {
    key: 'sequences',
    title: 'Domino sequences',
    body: 'As the price nears the top of a range, earned fees open the next position one step higher.',
    href: '#/automate',
    link: 'Open Automate',
    roadmap: 'Domino',
    Art: VignetteSequence,
  },
  {
    key: 'custody',
    title: 'Non-custodial',
    body: 'Positions are standard Uniswap NFTs. The one you open goes straight to your wallet; positions a sequence opens stay in its vault until you withdraw them.',
    href: '#/#learn',
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
