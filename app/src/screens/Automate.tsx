// The screens' own styles (styles/screens.css, F8): loaded with the first screen that needs them, never on Home's first paint.
import '../styles/screens.css'
import { lazy, Suspense, type CSSProperties, type ReactNode } from 'react'
import { ModeArt, PlainArt } from '../components/automate/ModeArt'
import { FeeMeter } from '../components/automate/ServiceFee'
import { FeeJourney } from '../components/automate/ModeSummary'
import { IconChevronRight, IconLock, IconPlus } from '../components/icons'
import { Display, LinkButton, PageHeader, PageShell } from '../components/ui'
import { newPositionHref } from '../components/explore/routes'
import { FEATURES } from '../lib/automate/features'
import { CREATE } from '../lib/create/copy'
import { useRouteTitle } from '../lib/routeTitle'
import { recovering } from '../lib/staleRelease'

const rise = (step: number) => ({ '--delay': `${step * 40}ms` }) as CSSProperties

// Domino V2 (integration, 2026-10-02): Auto-exit (the owner's point 5, 2026-10-06; once "Protection only") beside the plain
// position, only in a build that carries V2 (production and development do since 2026-10-05; a build without it has this
// null, and nothing of it is bundled).
const V2Protection = __DOMINO_V2__ ? lazy(recovering(() => import('../v2in/automate/AutomateProtection'), () => ({ default: () => null }))) : null

/** One way to put fees to work: a moving picture, what it does, what it costs and where it starts. */
function AutomationCard({
  id,
  kind,
  title,
  points,
  entry,
  step,
}: {
  id: string
  kind: 'compound' | 'domino'
  title: string
  points: string[]
  entry: ReactNode
  step: number
}) {
  return (
    <article className="dm-card dm-acct-auto-card animate-rise" style={rise(step)} data-automation-card={kind} aria-labelledby={id}>
      <div className="dm-plate dm-dots-plate dm-acct-auto-plate">
        <ModeArt mode={kind} size="stage" play="loop" className="dm-acct-auto-art" />
        <FeeJourney mode={kind} />
      </div>
      <div className="dm-acct-auto-body">
        <div className="dm-acct-auto-head">
          <Display as="h2" id={id} className="dm-display-card">
            {title}
          </Display>
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
        <FeeMeter mode={kind} />
        <p className="dm-auto-fee-note">Never charged on your original deposit.</p>
        {entry}
      </div>
    </article>
  )
}

/**
 * The first of the three features (2026-09-24, the owner's product: a plain position, then Auto-compound or
 * Domino-compound on it): what a position does with no automation, and where one is opened. Both automations start
 * from a position like this one, so it leads the page.
 */
function PlainCard({ step }: { step: number }) {
  return (
    <section className="dm-card dm-auto-plain animate-rise" style={rise(step)} data-feature="plain" aria-labelledby="automate-plain">
      <div className="dm-plate dm-dots-plate dm-auto-plain-plate" aria-hidden="true">
        <PlainArt />
      </div>
      <div className="dm-auto-plain-body">
        <Display as="h2" id="automate-plain" className="dm-display-card">
          {FEATURES.plain.name}
        </Display>
        <p className="dm-auto-plain-line">{FEATURES.plain.line}</p>
      </div>
      <LinkButton href={newPositionHref()} variant="outline" size="lg" className="dm-auto-plain-go">
        <IconPlus />
        New position
      </LinkButton>
    </section>
  )
}

/** In builds without the wallet flows there is nowhere to go, and the card says why instead of offering a way in. */
const OFF = (
  <p className="dm-acct-auto-off">
    <IconLock />
    Wallet sign-in isn’t available here, so this can’t be set up.
  </p>
)

/**
 * Automate: Domino's three features in order (2026-09-24): the plain position
 * they all start from, and the two ways Domino can put its earned fees to
 * work, where each stands, what it costs, and the screen each one starts
 * from. Nothing here reads, signs or enables anything. The product explanation
 * does not claim a start state: the connected setup shows its own actual state.
 */
export function Automate() {
  // The tab's name (lib/routeTitle.ts, audit E11).
  useRouteTitle('Automate')
  return (
    <PageShell data-automate="">
      <PageHeader
        className="animate-rise"
        title="Automate"
        // Changed on purpose 2026-10-06 (the integration review, ux #9): beside Auto-exit, which is not about fees, the
        // words Set up automation's own lede uses (screens/Sequence.tsx); a build without V2 keeps the fees' words.
        description={V2Protection ? 'Choose what Domino does for your position.' : 'Choose how to use your earned fees.'}
      />

      {V2Protection ? (
        <>
          <PlainCard step={1} />
          <Suspense fallback={null}>
            <V2Protection />
          </Suspense>
        </>
      ) : (
        <PlainCard step={1} />
      )}

      <div className="dm-acct-auto-grid">
        <AutomationCard
          id="automate-compound"
          kind="compound"
          title="Auto-compound"
          step={2}
          // Changed on purpose 2026-10-01 (audit E4, live note L12): one plain sentence, and no promise about the APR.
          points={['Adds earned fees back into the same position.', 'Keeps the same price range. Uses earned fees only.']}
          entry={
            __DOMINO_WALLET_SESSION__ ? (
              <div className="dm-acct-auto-entry">
                <LinkButton href="#/sequence/compound" variant="outline" size="lg">
                  Set up Auto-compound
                  <IconChevronRight />
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
          title="Domino-compound"
          step={3}
          points={['Fees can fund the next position as the price nears the top of the range.', 'Only earned fees fund the next position, within your limits. Your original deposit stays in place.']}
          entry={
            __DOMINO_WALLET_SESSION__ ? (
              <div className="dm-acct-auto-entry">
                <LinkButton href="#/sequence/domino" variant="outline" size="lg">
                  Set up Domino-compound
                  <IconChevronRight />
                </LinkButton>
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
