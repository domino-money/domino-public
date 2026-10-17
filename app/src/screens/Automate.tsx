import '../styles/screens.css'
import { lazy, Suspense } from 'react'
import { AutomationChoice } from '../components/automate/AutomationChoice'
import { AutomateStage } from '../components/automate-v4/AutomateStage'
import { useAutomateChoice } from '../components/automate-v4/useAutomateChoice'
import { useAutomateLight, useEmberRest } from '../components/automate-v4/useAutomateLight'
import { IconLock, IconPlus } from '../components/icons'
import { ActChevron } from '../components/automate-v4/RowIcons'
import { Button, LinkButton, PageHeader, PageShell } from '../components/ui'
import { newPositionHref } from '../components/explore/routes'
import { useRouteTitle } from '../lib/routeTitle'
import { recovering } from '../lib/staleRelease'

const protectionUnavailable = () => <Button disabled>Unavailable right now</Button>
const V2Protection = __DOMINO_V2__ ? lazy(recovering(() => import('../v2in/automate/AutomateProtection'), () => ({ default: protectionUnavailable }))) : null
const OFF = <p className="dm-acct-auto-off"><IconLock />Wallet sign-in isn’t available here.</p>

/**
 * The three automations share Home's visual language; each keeps its independently guarded setup. V4 (the owner's approved
 * site/automate.html): one stage beside the rows performs the chosen function with the one travelling tile; the rows'
 * own drawings stay mounted (transparent) for the tests.
 */
export function Automate() {
  useRouteTitle('Automate')
  const { gridRef, chosen, run, dd, lift, tilt } = useAutomateChoice()
  useAutomateLight('main[data-automate]')
  useEmberRest()
  return <PageShell data-automate="">
    <PageHeader title="Automate" />
    <div className="dm-automation-start">
      <AutomationChoice kind="plain">
        <LinkButton href={newPositionHref()} variant="outline"><IconPlus />New position</LinkButton>
      </AutomationChoice>
    </div>
    <div className="dm-automation-choice-grid" ref={gridRef}>
      {/* The rows' card, lit under the ember (.dm-lit); painted under the rows. */}
      <span className="dm-automate-card dm-lit" aria-hidden="true" />
      <AutomationChoice kind="compound" chosen={chosen === 'compound'}>
        {__DOMINO_WALLET_SESSION__ ? <LinkButton href="#/sequence/compound" variant="outline">Set up Auto-compound<ActChevron /></LinkButton> : OFF}
      </AutomationChoice>
      <AutomationChoice kind="domino" chosen={chosen === 'domino'}>
        {__DOMINO_WALLET_SESSION__ ? <LinkButton href="#/sequence/domino" variant="outline">Set up Domino-compound<ActChevron /></LinkButton> : OFF}
      </AutomationChoice>
      {V2Protection && <AutomationChoice kind="protection" chosen={chosen === 'autoexit'}>
        <Suspense fallback={<Button disabled>Checking availability…</Button>}><V2Protection /></Suspense>
      </AutomationChoice>}
      <AutomateStage chosen={chosen} run={run} dd={dd} lift={lift} tilt={tilt} />
    </div>
  </PageShell>
}
