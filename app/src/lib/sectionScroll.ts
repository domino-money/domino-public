import { rootScale } from './rootScale'

/**
 * Puts the requested section under the header, or returns to the top when the
 * hash carries none.
 *
 * Positioned directly rather than with a smooth behaviour: smooth scrolling is
 * silently ignored by some embedded browsers, which would leave an in-page link
 * doing nothing at all.
 */
export function scrollToSection(section: string) {
  const target = section ? document.getElementById(section) : null
  if (!target) {
    window.scrollTo(0, 0)
    return
  }
  const header = document.querySelector('header')?.getBoundingClientRect().height ?? 0
  // 16 design px of air under the header, as a section's scroll margin keeps (tokens.css), at the root's scale.
  window.scrollTo(0, Math.max(0, target.getBoundingClientRect().top + window.scrollY - header - 16 * rootScale()))
  arrive(target)
}

/**
 * A docs section's title catches the light as you arrive (V4, site/docs-article.html .arr): its letters warm and a light
 * runs along its line once (docs.css [data-arrived]). Decoration only, removed when it has played; nothing else is
 * written, and a section of any other page is left as it is.
 */
let lit: { heading: Element; timer: number } | null = null
function arrive(section: Element) {
  const heading = section.matches('.dm-docs-section, .dm-docs-sub') ? section.querySelector(':scope > :is(h2, h3)') : null
  if (!heading) return
  if (lit) {
    window.clearTimeout(lit.timer)
    lit.heading.removeAttribute('data-arrived')
  }
  void (heading as HTMLElement).offsetWidth
  heading.setAttribute('data-arrived', '')
  lit = { heading, timer: window.setTimeout(() => heading.removeAttribute('data-arrived'), 1900) }
}
