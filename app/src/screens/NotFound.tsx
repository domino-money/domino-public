import { useTabTitle } from '../lib/routeTitle'
import { LinkButton, PageHeader, PageShell } from '../components/ui'

/**
 * A link that names no page (2026-10-01, live notes L19): `#/receipts`, `#/foo`, or Markets with something that is not
 * a token's address after it. Until then the site showed Home, or Markets, as if the link had worked. Now it says so in
 * plain words and offers the two ways on. Part of the entry: it reads nothing and loads nothing.
 */
export function NotFound() {
  // The tab's name, and what a screen reader hears on arriving (lib/routeTitle.ts, audit E11).
  useTabTitle('Page not found · Domino')
  return (
    <PageShell width="narrow" data-not-found="">
      <PageHeader title="This page doesn’t exist" description="The link may be out of date or mistyped. Everything else on Domino works as usual." />
      <div className="mt-8 flex flex-wrap items-center gap-3">
        <LinkButton href="#/">Go to Home</LinkButton>
        <LinkButton href="#/markets" variant="outline">
          Explore markets
        </LinkButton>
      </div>
    </PageShell>
  )
}
