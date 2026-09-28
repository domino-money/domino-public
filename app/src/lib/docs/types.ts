/**
 * The in-app documentation, as data. The docs screen renders these objects:
 * the sidebar, "On this page", the breadcrumb, the previous and next links and
 * every anchor come from one registry, so they cannot drift apart.
 *
 * Pure data: no React, no build flags, no markup. Links stay inside this app.
 */

import type { ShotId } from './shots'

/** Inline text. A link's `to` is a route of this app and starts with `#/`. */
export type Inline = string | { b: string } | { mono: string } | { to: string; text: string }

export type Block =
  | { kind: 'p'; text: readonly Inline[] }
  | { kind: 'list'; items: readonly (readonly Inline[])[] }
  | { kind: 'steps'; items: readonly { title: string; body: readonly Inline[] }[] }
  | { kind: 'note'; title?: string; text: readonly Inline[] }
  | { kind: 'facts'; rows: readonly { label: string; value: string; note?: string }[] }
  | { kind: 'addresses'; rows: readonly { label: string; role: string; address: string }[] }
  | { kind: 'split'; columns: readonly { title: string; items: readonly (readonly Inline[])[] }[] }
  | { kind: 'terms'; items: readonly { id: string; term: string; text: readonly Inline[] }[] }
  /** A picture of a screen, from the app's test view with made-up figures (public/docs/<shot>.webp; size and alt in shots.ts). */
  | { kind: 'shot'; shot: ShotId; caption: string }
  /** A drawing of an idea rather than a screen (components/docs/DocsDiagram.tsx), with its plain description. */
  | { kind: 'diagram'; name: DiagramName; caption: string; alt: string }

/** The docs' drawings: how a position earns fees, and the three ways its fees can be used. */
export type DiagramName = 'earning' | 'three-ways'

export interface DocSubsection {
  id: string
  title: string
  blocks: readonly Block[]
}

export interface DocSection {
  /** Kebab-case, unique within the page, never `docs-…` (the docs chrome's own ids). */
  id: string
  title: string
  blocks: readonly Block[]
  subsections?: readonly DocSubsection[]
}

export interface DocPage {
  /** Kebab-case; the page lives at `#/docs/<slug>`. */
  slug: string
  /** The h1, and the page's name in the sidebar, the pager and the index. */
  title: string
  /** One sentence: the page in the index, and the line under the h1 unless `lead` replaces it there. */
  summary: string
  /** What the page opens with under its h1, when that is more than the summary. */
  lead?: string
  /** The ROADMAP entry whose status pill shows beside the title. */
  status?: 'Compound' | 'Domino'
  sections: readonly DocSection[]
}

export interface DocGroup {
  key: string
  title: string
  pages: readonly DocPage[]
}

export interface TocEntry {
  id: string
  title: string
  /** 2 for a section, 3 for a subsection. */
  depth: 2 | 3
}
