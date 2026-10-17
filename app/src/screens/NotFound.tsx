import { useTabTitle } from '../lib/routeTitle'
import { LinkButton, PageHeader, PageShell } from '../components/ui'
import { DominoTile } from '../components/docs/DominoTile'

/**
 * A link that names no page (2026-10-01, live notes L19): `#/receipts`, `#/foo`, or Markets with something that is not
 * a token's address after it. Until then the site showed Home, or Markets, as if the link had worked. Now it says so in
 * plain words and offers the two ways on. Part of the entry: it reads nothing and loads nothing.
 *
 * V4 (2026-10-16, site/404.html): the words beside a stage where the tile has fallen out of its place, drawn in CSS
 * (styles/v4-system.css); the stage is decoration only, with no link in it.
 */
export function NotFound() {
  // The tab's name, and what a screen reader hears on arriving (lib/routeTitle.ts, audit E11).
  useTabTitle('Page not found · Domino')
  return (
    <PageShell data-not-found="">
      <div className="min-w-0">
        <PageHeader title="This page doesn’t exist" description="The link may be out of date or mistyped. Everything else on Domino works as usual." />
        <div className="dm-nf-acts dm-k-up2 mt-8 flex flex-wrap items-center gap-3">
          <LinkButton href="#/">Go to Home</LinkButton>
          <LinkButton href="#/markets" variant="outline">
            Explore markets
          </LinkButton>
        </div>
      </div>
      <div aria-hidden="true" className="dm-nf-stage">
        <div className="dm-nf-scene">
          <span className="dm-nf-ghost">
            <b />
            <i />
            <i />
            <i />
            <i />
            <i />
          </span>
          <DominoTile fallen />
        </div>
      </div>
    </PageShell>
  )
}
