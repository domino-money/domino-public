import { useEffect, useRef, useState, type MouseEvent } from 'react'
import type { TocEntry } from '../../lib/docs/types'
import { scrollToSection } from '../../lib/sectionScroll'
import { rootScale } from '../../lib/rootScale'
import { docsHref } from '../explore/routes'

/**
 * The section the reader is in: the last one whose top has passed the line
 * 24 design px under the window's top (or under the header while it is still
 * in view; V4: it scrolls away with the page), or the last one of all once the
 * page is scrolled to its end. Measured on scroll and resize, one frame at a
 * time. It writes nothing: not the hash, not storage.
 */
function useActiveSection(ids: string): string | null {
  const [active, setActive] = useState<string | null>(null)
  useEffect(() => {
    const list = ids ? ids.split(' ') : []
    if (list.length === 0) return
    let frame = 0
    const measure = () => {
      frame = 0
      const line = Math.max(0, document.querySelector('header')?.getBoundingClientRect().bottom ?? 0) + 24 * rootScale()
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

/**
 * Places the rail's mini domino on the current entry (8 design px under the entry's top, as the prototype's script does)
 * and fills the hairline down to it, through two custom properties the CSS transitions (.5s, docs.css). Measured again
 * whenever the list's box changes: a font arriving, the folded list opening.
 */
function useTocMarker(nav: { current: HTMLElement | null }, active: string | null) {
  useEffect(() => {
    const root = nav.current
    if (!root) return
    const place = () => {
      const links = Array.from(root.querySelectorAll<HTMLAnchorElement>('.dm-docs-toc-link'))
      const link = links.find((each) => each.getAttribute('aria-current') === 'location') ?? links[0]
      if (!link) return
      const scale = rootScale()
      const list = link.closest('ul')
      const top = link.offsetTop + (list?.offsetTop ?? 0)
      root.style.setProperty('--mk-y', `${Math.round((top + 8 * scale) * 10) / 10}px`)
      root.style.setProperty('--mk-f', String(Math.round(Math.min(1, Math.max(0, (top + 10 * scale) / Math.max(1, root.offsetHeight - 12 * scale))) * 1000) / 1000))
    }
    place()
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(place)
    observer?.observe(root)
    return () => observer?.disconnect()
  }, [nav, active])
}

/** A plain click, not one that opens the link in a new tab or window. */
export const plainClick = (event: MouseEvent) => event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey

/**
 * Closes the disclosure a chosen link sits in, if any, so what the link opens is what shows next. At once, without the
 * fold's closing motion (data-instant, docs.css), so what is measured next is the page without the list.
 */
export function closeDisclosureOf(element: Element) {
  const disclosure = element.closest('details')
  if (!disclosure) return
  disclosure.setAttribute('data-instant', '')
  disclosure.open = false
  void disclosure.offsetHeight
  disclosure.removeAttribute('data-instant')
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
  const nav = useRef<HTMLElement>(null)
  useTocMarker(nav, active)
  const choose = (event: MouseEvent<HTMLAnchorElement>, id: string) => {
    if (!plainClick(event)) return
    closeDisclosureOf(event.currentTarget)
    if (window.location.hash !== event.currentTarget.getAttribute('href')) return
    event.preventDefault()
    scrollToSection(id)
  }
  return (
    <nav ref={nav} aria-label="On this page" className="dm-docs-toc">
      {/* V4 (site/docs-article.html .toc-fill, .toc-mk): the reading fill over the rail's hairline and the one mini domino
          that glides to the current entry. Decoration only; the current entry is still the link's aria-current. */}
      <span aria-hidden="true" className="dm-docs-toc-fill" />
      <span aria-hidden="true" className="dm-docs-toc-mk">
        <svg width="9" height="16" viewBox="0 0 9 16" fill="none">
          <rect x="0.6" y="0.6" width="7.8" height="14.8" rx="2.2" stroke="rgb(255 157 98 / .62)" strokeWidth="1.2" />
          <path d="M2.4 8h4.2" stroke="rgb(255 157 98 / .62)" strokeWidth="1.1" />
        </svg>
      </span>
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
