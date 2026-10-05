/**
 * Every docs page, in reading order, and the lookups the docs screen needs.
 * The sidebar, the index, the breadcrumb, the previous and next links and
 * "On this page" all read from here, so a page added to a group appears in
 * each of them at once.
 */
import { AUTO_COMPOUND, DOMINO_COMPOUNDER, STOP_LOSS, YOUR_AUTOMATION } from './pages/automation'
import { EARNED_FEES, POOLS, RANGES } from './pages/basics'
import { NON_CUSTODIAL, PRIVACY, RISKS } from './pages/custody'
import { WALLET, WALLET_REQUESTS, WHAT_IS_DOMINO } from './pages/introduction'
import { CONTRACTS, FEES, FIGURES, GLOSSARY } from './pages/reference'
import { BRING_FUNDS, MANAGE_POSITION, MARKETS, NEW_POSITION, POOL_PAGE, POSITIONS } from './pages/using'
import type { DocGroup, DocPage, TocEntry } from './types'

export const DOC_GROUPS: readonly DocGroup[] = [
  { key: 'introduction', title: 'Introduction', pages: [WHAT_IS_DOMINO, WALLET, WALLET_REQUESTS] },
  { key: 'basics', title: 'Liquidity basics', pages: [POOLS, RANGES, EARNED_FEES] },
  // Changed on purpose 2026-10-04 (the owner: docs revalidated for V2): bringing funds from another network, managing a
  // position from its page, stop-loss and take-profit, and the automation behind them, each a page of its own.
  { key: 'using', title: 'Using Domino', pages: [MARKETS, POOL_PAGE, NEW_POSITION, BRING_FUNDS, POSITIONS, MANAGE_POSITION] },
  { key: 'automation', title: 'Automation', pages: [AUTO_COMPOUND, DOMINO_COMPOUNDER, STOP_LOSS, YOUR_AUTOMATION] },
  { key: 'custody', title: 'Custody and risk', pages: [NON_CUSTODIAL, RISKS, PRIVACY] },
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

/** Older slugs that still open their page (2026-10-01, live note L12). */
export const DOC_ALIASES: Readonly<Record<string, string>> = Object.freeze({ 'domino-compounder': 'domino-compound' })

const BY_SLUG: Readonly<Record<string, DocPage>> = Object.fromEntries(DOC_PAGES.map((page) => [page.slug, page]))
const GROUP_OF: Readonly<Record<string, DocGroup>> = Object.fromEntries(DOC_GROUPS.flatMap((group) => group.pages.map((page) => [page.slug, group])))

/** A slug as the registry knows it: itself, or the page an older slug now names. */
const canonical = (slug: string) => (Object.hasOwn(DOC_ALIASES, slug) ? DOC_ALIASES[slug] : slug)

/** The page at `slug` (or at the page an older slug names), or null. Only a page's own slug counts: `constructor` is not a page. */
export function findDocPage(slug: string): DocPage | null {
  const key = canonical(slug)
  return Object.hasOwn(BY_SLUG, key) ? BY_SLUG[key] : null
}

/** The group a page belongs to, or null for a slug that is not a page. */
export function docGroupOf(slug: string): DocGroup | null {
  const key = canonical(slug)
  return Object.hasOwn(GROUP_OF, key) ? GROUP_OF[key] : null
}

/** The pages before and after `slug` in reading order. */
export function docNeighbours(slug: string): { previous: DocPage | null; next: DocPage | null } {
  const key = canonical(slug)
  const index = DOC_PAGES.findIndex((page) => page.slug === key)
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
