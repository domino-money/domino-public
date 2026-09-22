import type { CSSProperties, ReactNode } from 'react'
import { VignetteCompound, VignetteSequence } from '../components/home/Vignettes'
import { Display, LinkButton, PageHeader, PageShell, Pill, cx } from '../components/ui'
import { CREATE } from '../lib/create/copy'
import { ROADMAP, ROADMAP_PILL } from '../lib/capabilities'

/**
 * Where a ROADMAP entry stands, as the pill a person scans for. Read from
 * ROADMAP every time, never written by hand, so the pill changes by itself
 * when the entry does; an entry that is not listed, or whose status wears no
 * pill (ROADMAP_PILL), shows nothing. Every status is the neutral pill: the
 * words say where it stands, never a colour.
 */
export function RoadmapPill({ name, className }: { name: string; className?: string }) {
  const status = ROADMAP.find((entry) => entry.name === name)?.status
  const label = status && ROADMAP_PILL[status]
  if (!label) return null
  return <Pill className={cx('dm-acct-status', className)}>{label}</Pill>
}

const rise = (step: number) => ({ '--delay': `${step * 60}ms` }) as CSSProperties

/** One way to put fees to work: a moving picture, what it does, what it costs and where it starts. */
function AutomationCard({
  id,
  kind,
  roadmap,
  title,
  art,
  points,
  entry,
  step,
}: {
  id: string
  kind: 'compound' | 'domino'
  roadmap: string
  title: string
  art: ReactNode
  points: string[]
  entry: ReactNode
  step: number
}) {
  return (
    <article className="dm-card dm-acct-auto-card animate-rise" style={rise(step)} data-automation-card={kind} aria-labelledby={id}>
      <div className="dm-plate dm-dots-plate dm-acct-auto-plate">{art}</div>
      <div className="dm-acct-auto-body">
        <div className="dm-acct-auto-head">
          <Display as="h2" id={id} className="dm-display-card">
            {title}
          </Display>
          <RoadmapPill name={roadmap} />
        </div>
        <ul className="dm-acct-auto-points">
          {points.map((point) => (
            <li key={point}>{point}</li>
          ))}
        </ul>
        <dl className="dm-acct-auto-fee">
          <dt>Service fee</dt>
          <dd>{CREATE.review.serviceFeeValue(kind)}, once</dd>
        </dl>
        {entry}
      </div>
    </article>
  )
}

/** In builds without the wallet flows there is nowhere to go, and the card says why instead of offering a way in. */
const OFF = <p className="dm-acct-auto-off">Wallet sign-in isn’t available here, so this can’t be set up.</p>

/**
 * Automate: the two ways Domino can put a position's earned fees to work, where
 * each stands, what it costs, and the screen each one starts from. Nothing
 * here reads, signs or enables anything; the status comes from ROADMAP.
 */
export function Automate() {
  return (
    <PageShell data-automate="">
      <PageHeader
        className="animate-rise"
        title="Automate"
        description="Two ways to put a position’s earned fees to work, within limits your wallet signs."
      />

      <div className="dm-acct-auto-grid">
        <AutomationCard
          id="automate-compound"
          kind="compound"
          roadmap="Compound"
          title="Auto-compound"
          step={1}
          art={<VignetteCompound className="dm-acct-auto-art" />}
          points={[
            'Adds a position you already hold’s earned fees back into that same position, improving your fees APR.',
            'Compounds earned fees only, nothing else.',
          ]}
          entry={
            __DOMINO_WALLET_SESSION__ ? (
              <div className="dm-acct-auto-entry">
                <LinkButton href="#/sequence/compound" variant="outline">
                  Set up Auto-compound
                </LinkButton>
              </div>
            ) : (
              OFF
            )
          }
        />
        <AutomationCard
          id="automate-domino"
          kind="domino"
          roadmap="Domino"
          title="Domino-compound"
          step={2}
          art={<VignetteSequence className="dm-acct-auto-art" />}
          points={[
            'As the price nears the top of the range, earned fees automatically open the next position, one step higher.',
            'Compounds earned fees only, nothing else.',
          ]}
          entry={
            __DOMINO_WALLET_SESSION__ ? (
              <div className="dm-acct-auto-entry">
                <LinkButton href="#/sequence/domino">Set up Domino-compound</LinkButton>
              </div>
            ) : (
              OFF
            )
          }
        />
      </div>
    </PageShell>
  )
}
