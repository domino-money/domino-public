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
  window.scrollTo(0, Math.max(0, target.getBoundingClientRect().top + window.scrollY - header - 16))
}
