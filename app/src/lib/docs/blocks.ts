import { docsHref } from '../../components/explore/routes'
import type { ShotId } from './shots'
import type { Block, DiagramName, Inline } from './types'

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

/** A picture of a screen, with the line under it. Its file, size and description come from shots.ts. */
export const shot = (id: ShotId, caption: string): Block => ({ kind: 'shot', shot: id, caption })

/** A drawing of an idea, with the line under it and its plain description. */
export const diagram = (name: DiagramName, caption: string, alt: string): Block => ({ kind: 'diagram', name, caption, alt })

/** Where a picture is served from: public/docs/, on this site's own origin (the CSP's img-src 'self'); `phone`, its phone picture. */
export const shotSrc = (id: ShotId, phone = false): string => `/docs/${id}${phone ? '-phone' : ''}.webp`
