import { docsHref } from '../../components/explore/routes'
import type { Block, Inline } from './types'

/** A paragraph. */
export const p = (...text: Inline[]): Block => ({ kind: 'p', text })

/** A bulleted list, one array of inline text per item. */
export const list = (...items: (readonly Inline[])[]): Block => ({ kind: 'list', items })

/** A quiet callout with an info mark. */
export const note = (text: readonly Inline[], title?: string): Block => (title ? { kind: 'note', title, text } : { kind: 'note', text })

/** Bold words. */
export const b = (text: string): Inline => ({ b: text })

/** A link to a docs page, or to a section of one. */
export const doc = (text: string, slug: string, section?: string): Inline => ({ to: docsHref(slug, section ?? null), text })

/** A link to a screen of the app, or a section of Home. */
export const screen = (text: string, to: `#/${string}`): Inline => ({ to, text })
