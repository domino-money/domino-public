import { tocOf } from '../../lib/docs/registry'
import type { DocPage } from '../../lib/docs/types'
import { useMediaQuery } from '../../lib/useMediaQuery'
import { DocsArticle } from './DocsContent'
import { DocsIndex } from './DocsIndex'
import { DocsMenu, DocsNav } from './DocsNav'
import { DocsToc } from './DocsToc'

/** From here the sidebar sits beside the article; below it, the docs menu opens at the top. */
const SIDE = '(min-width: 1024px)'
/** From here "On this page" is a rail of its own; below it, a disclosure under the title. */
const RAIL = '(min-width: 1280px)'

/**
 * The docs frame: sidebar, article and "On this page", as three columns, two
 * or one. Each navigation renders in exactly one place for the width, never
 * twice with one of them hidden, and nothing but the two side columns is
 * sticky, so an anchor always lands just under the header.
 */
export function DocsLayout({ page }: { page: DocPage | null }) {
  const side = useMediaQuery(SIDE)
  const wide = useMediaQuery(RAIL)
  const current = page ? page.slug : null
  const entries = page ? tocOf(page) : []
  const rail = wide && entries.length > 0
  return (
    <div className="dm-docs" data-docs-side={side ? '' : undefined} data-docs-rail={rail ? '' : undefined}>
      {side && (
        <div className="dm-docs-side">
          <DocsNav current={current} />
        </div>
      )}
      <div className="dm-docs-main">
        {/* Keyed per page, so each page change remounts them: the menu starts closed and the article's entrance plays. Siblings, so the keys must differ. */}
        {!side && <DocsMenu key={`menu:${current ?? ''}`} current={current} />}
        {page ? <DocsArticle key={`page:${page.slug}`} page={page} tocInline={!rail} crumbs={side} /> : <DocsIndex />}
      </div>
      {rail && page && (
        <div className="dm-docs-rail">
          <p id="docs-toc-title" className="dm-docs-rail-title">
            On this page
          </p>
          <DocsToc key={page.slug} slug={page.slug} entries={entries} />
        </div>
      )}
    </div>
  )
}
