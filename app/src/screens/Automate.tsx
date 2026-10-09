import '../styles/screens.css'
import { lazy, Suspense } from 'react'
import { AutomationChoice } from '../components/automate/AutomationChoice'
import { IconChevronRight, IconLock, IconPlus } from '../components/icons'
import { Button, LinkButton, PageHeader, PageShell } from '../components/ui'
import { newPositionHref } from '../components/explore/routes'
import { useRouteTitle } from '../lib/routeTitle'
import { recovering } from '../lib/staleRelease'

const protectionUnavailable = () => <AutomationChoice kind="protection"><Button disabled>Unavailable right now</Button></AutomationChoice>
const V2Protection = __DOMINO_V2__ ? lazy(recovering(() => import('../v2in/automate/AutomateProtection'), () => ({ default: protectionUnavailable }))) : null
const OFF = <p className="dm-acct-auto-off"><IconLock />Wallet sign-in isn’t available here.</p>

/** Four alternatives, each continuing into its existing, independently guarded setup. */
export function Automate() {
  useRouteTitle('Automate')
  return <PageShell data-automate="">
    <PageHeader title="Automate" description="Choose what Domino does for your position." />
    <div className="dm-automation-choice-grid">
      <AutomationChoice kind="plain">
        <LinkButton href={newPositionHref()} variant="outline"><IconPlus />New position</LinkButton>
      </AutomationChoice>
      {V2Protection && <Suspense fallback={<AutomationChoice kind="protection"><Button disabled>Checking availability…</Button></AutomationChoice>}>
        <V2Protection />
      </Suspense>}
      <AutomationChoice kind="compound">
        {__DOMINO_WALLET_SESSION__ ? <LinkButton href="#/sequence/compound" variant="outline">Set up Auto-compound<IconChevronRight /></LinkButton> : OFF}
      </AutomationChoice>
      <AutomationChoice kind="domino">
        {__DOMINO_WALLET_SESSION__ ? <LinkButton href="#/sequence/domino" variant="outline">Set up Domino-compound<IconChevronRight /></LinkButton> : OFF}
      </AutomationChoice>
    </div>
  </PageShell>
}
