import { useEffect, useState, type MouseEvent } from 'react'
import type { TocEntry } from '../../lib/docs/types'
import { scrollToSection } from '../../lib/sectionScroll'
import { rootScale } from '../../lib/rootScale'
import { docsHref } from '../explore/routes'

/**
 * The section the reader is in: the last one whose top has passed the line
 * just under the header, or the last one of all once the page is scrolled to
 * its end. Measured on scroll and resize, one frame at a time. It writes
 * nothing: not the hash, not storage.
 */
function useActiveSection(ids: string): string | null {
  const [active, setActive] = useState<string | null>(null)
  useEffect(() => {
    const list = ids ? ids.split(' ') : []
    if (list.length === 0) return
    let frame = 0
    const measure = () => {
      frame = 0
      const line = (document.querySelector('header')?.getBoundingClientRect().height ?? 0) + 24 * rootScale()
      let current = list[0]
      for (const id of list) {
        const top = document.getElementById(id)?.getBoundingClientRect().top
        if (top !== undefined && top <= line + 1) current = id
      }
      const root = document.documentElement
      if (window.scrollY > 0 && window.innerHeight + window.scrollY >= root.scrollHeight - 2) current = list[list.length - 1]
      setActive(current)
    }
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(measure)
    }
    schedule()
    window.addEventListener('scroll', schedule, { passive: true })
    window.addEventListener('resize', schedule)
    return () => {
      cancelAnimationFrame(frame)
      window.removeEventListener('scroll', schedule)
      window.removeEventListener('resize', schedule)
    }
  }, [ids])
  return active
}

/** A plain click, not one that opens the link in a new tab or window. */
export const plainClick = (event: MouseEvent) => event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey

/** Closes the disclosure a chosen link sits in, if any, so what the link opens is what shows next. */
export function closeDisclosureOf(element: Element) {
  const disclosure = element.closest('details')
  if (disclosure) disclosure.open = false
}

/**
 * "On this page": every section of the page, subsections indented, the one
 * being read marked. Chosen from a phone's disclosure, the disclosure closes
 * first, so the section is measured without the list above it. A link already
 * in the address bar changes no hash, so no hashchange would scroll: clicking
 * it scrolls here instead.
 */
export function DocsToc({ slug, entries }: { slug: string; entries: readonly TocEntry[] }) {
  const active = useActiveSection(entries.map((entry) => entry.id).join(' '))
  const choose = (event: MouseEvent<HTMLAnchorElement>, id: string) => {
    if (!plainClick(event)) return
    closeDisclosureOf(event.currentTarget)
    if (window.location.hash !== event.currentTarget.getAttribute('href')) return
    event.preventDefault()
    scrollToSection(id)
  }
  return (
    <nav aria-label="On this page" className="dm-docs-toc">
      <ul className="dm-docs-toc-list">
        {entries.map((entry) => (
          <li key={entry.id}>
            <a
              href={docsHref(slug, entry.id)}
              data-depth={entry.depth}
              aria-current={entry.id === active ? 'location' : undefined}
              onClick={(event) => choose(event, entry.id)}
              className="dm-docs-toc-link"
            >
              {entry.title}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  )
}
