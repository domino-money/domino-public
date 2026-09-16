/**
 * Every docs page, in reading order, and the lookups the docs screen needs.
 * The sidebar, the index, the breadcrumb, the previous and next links and
 * "On this page" all read from here, so a page added to a group appears in
 * each of them at once.
 */
import { AUTO_COMPOUND, DOMINO_COMPOUNDER } from './pages/automation'
import { EARNED_FEES, POOLS, RANGES } from './pages/basics'
import { NON_CUSTODIAL, RISKS } from './pages/custody'
import { WALLET, WHAT_IS_DOMINO } from './pages/introduction'
import { CONTRACTS, FEES, FIGURES, GLOSSARY } from './pages/reference'
import { MARKETS, NEW_POSITION, POSITIONS } from './pages/using'
import type { DocGroup, DocPage, TocEntry } from './types'

export const DOC_GROUPS: readonly DocGroup[] = [
  { key: 'introduction', title: 'Introduction', pages: [WHAT_IS_DOMINO, WALLET] },
  { key: 'basics', title: 'Liquidity basics', pages: [POOLS, RANGES, EARNED_FEES] },
  { key: 'using', title: 'Using Domino', pages: [MARKETS, NEW_POSITION, POSITIONS] },
  { key: 'automation', title: 'Automation', pages: [AUTO_COMPOUND, DOMINO_COMPOUNDER] },
  { key: 'custody', title: 'Custody and risk', pages: [NON_CUSTODIAL, RISKS] },
  { key: 'reference', title: 'Reference', pages: [FEES, FIGURES, CONTRACTS, GLOSSARY] },
]

/** Every page, in the order the sidebar lists them and the pager walks them. */
export const DOC_PAGES: readonly DocPage[] = DOC_GROUPS.flatMap((group) => group.pages)

/** The index at `#/docs`. */
export const DOCS_HOME = {
  title: 'Docs',
  summary: 'How Domino works, what your wallet signs, and what it costs.',
} as const

/** The three pages the index offers first. */
export const DOC_START: readonly string[] = ['what-is-domino', 'ranges', 'non-custodial']

const BY_SLUG: Readonly<Record<string, DocPage>> = Object.fromEntries(DOC_PAGES.map((page) => [page.slug, page]))
const GROUP_OF: Readonly<Record<string, DocGroup>> = Object.fromEntries(DOC_GROUPS.flatMap((group) => group.pages.map((page) => [page.slug, group])))

/** The page at `slug`, or null. Only a page's own slug counts: `constructor` is not a page. */
export function findDocPage(slug: string): DocPage | null {
  return Object.hasOwn(BY_SLUG, slug) ? BY_SLUG[slug] : null
}

/** The group a page belongs to, or null for a slug that is not a page. */
export function docGroupOf(slug: string): DocGroup | null {
  return Object.hasOwn(GROUP_OF, slug) ? GROUP_OF[slug] : null
}

/** The pages before and after `slug` in reading order. */
export function docNeighbours(slug: string): { previous: DocPage | null; next: DocPage | null } {
  const index = DOC_PAGES.findIndex((page) => page.slug === slug)
  if (index === -1) return { previous: null, next: null }
  return { previous: DOC_PAGES[index - 1] ?? null, next: DOC_PAGES[index + 1] ?? null }
}

/** "On this page": every section, and every subsection under its section. */
export function tocOf(page: DocPage): TocEntry[] {
  return page.sections.flatMap((section): TocEntry[] => [
    { id: section.id, title: section.title, depth: 2 },
    ...(section.subsections ?? []).map((sub): TocEntry => ({ id: sub.id, title: sub.title, depth: 3 })),
  ])
}
