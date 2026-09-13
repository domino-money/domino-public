import type { CSSProperties, ReactNode } from 'react'
import { VignetteCompound, VignetteSequence } from '../components/home/Vignettes'
import { IconInfo } from '../components/icons'
import { Display, LinkButton, PageHeader, PageShell, Pill, cx } from '../components/ui'
import { ROADMAP, type Availability } from '../lib/capabilities'

const STATUS: Record<Availability, { text: string; tone: 'neutral' | 'wait' }> = {
  'not-connected': { text: 'Not connected', tone: 'neutral' },
  planned: { text: 'Planned', tone: 'wait' },
}

/**
 * Where a ROADMAP entry stands, as the pill a person scans for. Read from
 * ROADMAP every time, never written by hand, so the pill changes by itself
 * when the entry does; an entry that is not listed shows nothing.
 */
export function RoadmapPill({ name, className }: { name: string; className?: string }) {
  const row = ROADMAP.find((entry) => entry.name === name)
  if (!row) return null
  const status = STATUS[row.status]
  return (
    <Pill tone={status.tone} className={cx('dm-acct-status', className)}>
      {status.text}
    </Pill>
  )
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
          <dd>2% of the earned fees it uses. Never charged on principal.</dd>
        </dl>
        {entry}
      </div>
    </article>
  )
}

/** In builds without the wallet flows there is nowhere to go, and the card says why instead of offering a way in. */
const OFF = <p className="dm-acct-auto-off">Not available here: wallet sign-in is off.</p>

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
        description="Two ways to put a position's earned fees to work, within limits your wallet signs."
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
            "Adds a position's earned fees back into the same position.",
            'Uses proven earned fees only; no wallet asset is pulled and no principal is sold.',
            "Can't reduce your position's liquidity.",
          ]}
          entry={
            __DOMINO_WALLET_SESSION__ ? (
              <div className="dm-acct-auto-entry">
                <p>Runs on a position NFT you hold. Open one first.</p>
                <LinkButton href="#/setup" variant="outline" size="sm">
                  Open a position
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
          title="Domino sequences"
          step={2}
          art={<VignetteSequence className="dm-acct-auto-art" />}
          points={[
            'Starts from a position NFT you already hold.',
            'As the price nears the top of the range, fees open the next position one step higher.',
            'Pause, revoke or withdraw with your own wallet, one reviewed step each.',
          ]}
          entry={
            __DOMINO_WALLET_SESSION__ ? (
              <div className="dm-acct-auto-entry">
                <LinkButton href="#/sequence">Create or manage a sequence</LinkButton>
              </div>
            ) : (
              OFF
            )
          }
        />
      </div>

      <div className="dm-inset dm-acct-auto-note animate-rise" style={rise(3)}>
        <IconInfo className="dm-acct-auto-note-icon" />
        <p>Setup checks the deployment before any wallet step, and every step shows its amounts, destination and limits before your wallet asks you to sign.</p>
      </div>
    </PageShell>
  )
}
