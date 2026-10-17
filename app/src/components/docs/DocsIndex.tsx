import type { ComponentType } from 'react'
import { DOCS_HOME, DOC_GROUPS, DOC_START, findDocPage } from '../../lib/docs/registry'
import type { DocPage } from '../../lib/docs/types'
import { docsHref } from '../explore/routes'
import { IconBook, IconChevronRight, IconRange, IconWallet, type IconProps } from '../icons'
import { Display } from '../ui'
import { DominoTile } from './DominoTile'

/** The mark on each start card. Never a domino in a tile. */
const START_ICONS: Readonly<Record<string, ComponentType<IconProps>>> = {
  'what-is-domino': IconBook,
  ranges: IconRange,
  'non-custodial': IconWallet,
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
        {/* V4 (2026-10-16, site/docs.html): the brand's tile, small, beside the title; decoration only. */}
        <div aria-hidden="true" className="dm-docs-istage">
          <DominoTile />
        </div>
      </div>

      <section aria-labelledby="docs-start-title" className="dm-docs-start dm-k-card">
        <h2 id="docs-start-title" className="dm-docs-label">
          Start here
        </h2>
        <ul className="dm-docs-start-grid">
          {START.map((page) => {
            const Icon = START_ICONS[page.slug] ?? IconBook
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
