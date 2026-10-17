import type { ComponentType } from 'react'
import { DOCS_HOME, DOC_GROUPS, DOC_START, findDocPage } from '../../lib/docs/registry'
import type { DocPage } from '../../lib/docs/types'
import { docsHref } from '../explore/routes'
import { IconChevronRight } from '../icons'
import { Display } from '../ui'
import { DominoTile } from './DominoTile'

/* The start cards' glyphs, drawn as the prototype draws them (V4, site/docs.html .sp-g; 26 design px, docs CSS sizes them):
   an open book with its spine, a price wandering between a range's two dashed edges, the header's wallet. Decoration
   only: each sits in an aria-hidden span. Never a domino in a tile. */
const StartBook = () => (
  <svg viewBox="0 0 14 14" fill="none">
    <path d="M7 3.6C5.6 2.6 3.7 2.4 1.75 3v7.9c1.95-.6 3.85-.4 5.25.6 1.4-1 3.3-1.2 5.25-.6V3C10.3 2.4 8.4 2.6 7 3.6Zm0 0v7.9" stroke="currentColor" strokeWidth="1.05" strokeLinejoin="round" />
  </svg>
)
const StartRange = () => (
  <svg viewBox="0 0 24 24" fill="none">
    <path d="M7.5 3.5v17M16.5 3.5v17" stroke="currentColor" strokeWidth="1.3" strokeDasharray="2 2.6" strokeLinecap="round" />
    <path d="M2.5 16.5c2.4 0 3.1-6.5 5.9-6.5 2.8 0 3.3 4.2 5.8 4.2 2.6 0 3.4-6.2 7.3-6.2" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
  </svg>
)
const StartWallet = () => (
  <svg viewBox="0 0 16 16" fill="none">
    <rect x="1.75" y="3.25" width="12.5" height="9.5" rx="2.25" stroke="currentColor" strokeWidth="1.15" />
    <path d="M10.5 8h1.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
  </svg>
)

/** The mark on each start card. */
const START_ICONS: Readonly<Record<string, ComponentType>> = {
  'what-is-domino': StartBook,
  ranges: StartRange,
  'non-custodial': StartWallet,
}

const START: ReadonlyArray<DocPage> = DOC_START.flatMap((slug) => findDocPage(slug) ?? [])

/** `#/docs`: three pages to start with, then every page by group. */
export function DocsIndex() {
  return (
    <div className="dm-docs-index">
      <div className="dm-docs-head">
        <Display as="h1" className="dm-display-title">
          {DOCS_HOME.title}
        </Display>
        <p className="dm-docs-lead dm-k-up1">{DOCS_HOME.summary}</p>
        {/* V4 (2026-10-16, site/docs.html): the brand's tile, small, beside the title; decoration only. The ember rests just
            above its top left corner while no pointer moves (EmberLight), and the tile turns toward the pointer. */}
        <div aria-hidden="true" className="dm-docs-istage">
          <DominoTile />
          <span className="dm-ember-at" data-ember-rest="" />
        </div>
      </div>

      <section aria-labelledby="docs-start-title" className="dm-docs-start dm-k-card dm-lit">
        <h2 id="docs-start-title" className="dm-docs-label">
          Start here
        </h2>
        <ul className="dm-docs-start-grid">
          {START.map((page) => {
            const Icon = START_ICONS[page.slug] ?? StartBook
            return (
              <li key={page.slug} className="min-w-0">
                <a href={docsHref(page.slug)} className="dm-card dm-docs-start-card">
                  <span aria-hidden="true" className="dm-docs-start-icon">
                    <Icon />
                  </span>
                  <span className="dm-docs-start-title">
                    {page.title}
                    <IconChevronRight size={14} />
                  </span>
                  <span className="dm-docs-start-summary">{page.summary}</span>
                </a>
              </li>
            )
          })}
        </ul>
      </section>

      <div className="dm-docs-groups dm-k-c3">
        {DOC_GROUPS.map((group) => (
          <section key={group.key} aria-labelledby={`docs-index-${group.key}`} className="dm-docs-group">
            <h2 id={`docs-index-${group.key}`} className="dm-display-rail">
              {group.title}
            </h2>
            <ul className="dm-docs-rows">
              {group.pages.map((page) => (
                <li key={page.slug}>
                  <a href={docsHref(page.slug)} className="dm-docs-row">
                    <span className="min-w-0">
                      <span className="dm-docs-row-title">{page.title}</span>
                      <span className="dm-docs-row-summary">{page.summary}</span>
                    </span>
                    <IconChevronRight size={14} />
                  </a>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </div>
  )
}
