import '../styles/screens.css'
import { lazy, Suspense } from 'react'
import { AutomationChoice } from '../components/automate/AutomationChoice'
import { IconChevronRight, IconLock, IconPlus } from '../components/icons'
import { Button, LinkButton, PageHeader, PageShell } from '../components/ui'
import { newPositionHref } from '../components/explore/routes'
import { useRouteTitle } from '../lib/routeTitle'
import { recovering } from '../lib/staleRelease'

const protectionUnavailable = () => <Button disabled>Unavailable right now</Button>
const V2Protection = __DOMINO_V2__ ? lazy(recovering(() => import('../v2in/automate/AutomateProtection'), () => ({ default: protectionUnavailable }))) : null
const OFF = <p className="dm-acct-auto-off"><IconLock />Wallet sign-in isn’t available here.</p>

/** The three automations share Home's visual language; each keeps its independently guarded setup. */
export function Automate() {
  useRouteTitle('Automate')
  return <PageShell data-automate="">
    <PageHeader title="Automate" />
    <div className="dm-automation-start">
      <AutomationChoice kind="plain">
        <LinkButton href={newPositionHref()} variant="outline"><IconPlus />New position</LinkButton>
      </AutomationChoice>
    </div>
    <div className="dm-automation-choice-grid">
      <AutomationChoice kind="compound">
        {__DOMINO_WALLET_SESSION__ ? <LinkButton href="#/sequence/compound" variant="outline">Set up Auto-compound<IconChevronRight /></LinkButton> : OFF}
      </AutomationChoice>
      <AutomationChoice kind="domino">
        {__DOMINO_WALLET_SESSION__ ? <LinkButton href="#/sequence/domino" variant="outline">Set up Domino-compound<IconChevronRight /></LinkButton> : OFF}
      </AutomationChoice>
      {V2Protection && <AutomationChoice kind="protection">
        <Suspense fallback={<Button disabled>Checking availability…</Button>}><V2Protection /></Suspense>
      </AutomationChoice>}
    </div>
  </PageShell>
}
