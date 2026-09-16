import type { MouseEvent } from 'react'
import { DOC_GROUPS, docGroupOf, findDocPage } from '../../lib/docs/registry'
import { docsHref } from '../explore/routes'
import { closeDisclosureOf, plainClick } from './DocsToc'

/**
 * Every docs page, by group, with the open one on a pill. Rendered once:
 * beside the article from 1024px, inside the docs menu below that. Group
 * names are labels, not headings, so the page keeps its one h1.
 */
export function DocsNav({ current, onPick }: { current: string | null; onPick?: (event: MouseEvent<HTMLAnchorElement>) => void }) {
  return (
    <nav aria-label="Docs" className="dm-docs-nav">
      <a href={docsHref()} aria-current={current === null ? 'page' : undefined} onClick={onPick} className="dm-docs-nav-link">
        Overview
      </a>
      {DOC_GROUPS.map((group) => (
        <div key={group.key} className="dm-docs-nav-group">
          <p id={`docs-group-${group.key}`} className="dm-docs-nav-label">
            {group.title}
          </p>
          <ul aria-labelledby={`docs-group-${group.key}`} className="dm-docs-nav-list">
            {group.pages.map((page) => (
              <li key={page.slug}>
                <a href={docsHref(page.slug)} aria-current={page.slug === current ? 'page' : undefined} onClick={onPick} className="dm-docs-nav-link">
                  {page.title}
                </a>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </nav>
  )
}

/** A page chosen from the docs menu closes it, even the page already open, where no route change would. */
const closeMenu = (event: MouseEvent<HTMLAnchorElement>) => {
  if (plainClick(event)) closeDisclosureOf(event.currentTarget)
}

/**
 * The docs menu below 1024px: a closed disclosure at the top of the article
 * that names where you are and opens the same list. Keyed by page where it is
 * used, so every page change starts it closed.
 */
export function DocsMenu({ current }: { current: string | null }) {
  const page = current === null ? null : findDocPage(current)
  const group = page ? docGroupOf(page.slug) : null
  return (
    <details className="dm-details dm-docs-menu" data-docs-menu="">
      <summary>
        <span className="sr-only">Docs pages. Current page: </span>
        {page && group ? (
          <span className="dm-docs-menu-where">
            <span className="dm-docs-menu-group">{group.title}</span>
            <span aria-hidden="true" className="dm-docs-menu-sep">
              /
            </span>
            <span className="dm-docs-menu-page">{page.title}</span>
          </span>
        ) : (
          <span className="dm-docs-menu-where">
            <span className="dm-docs-menu-page">Overview</span>
          </span>
        )}
      </summary>
      <DocsNav current={page ? page.slug : null} onPick={closeMenu} />
    </details>
  )
}
