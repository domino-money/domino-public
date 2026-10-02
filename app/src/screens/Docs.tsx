// The screens' own styles (styles/screens.css, F8): loaded with the first screen that needs them, never on Home's first paint.
import '../styles/screens.css'
import { useEffect } from 'react'
import { DocsLayout } from '../components/docs/DocsLayout'
import { hashParts } from '../components/explore/routes'
import { PageShell } from '../components/ui'
import { findDocPage } from '../lib/docs/registry'
import { useTabTitle } from '../lib/routeTitle'
import { scrollToSection } from '../lib/sectionScroll'

/** What stops the late re-scroll: the reader has started moving the page themselves. */
const MOVES = ['wheel', 'touchstart', 'keydown', 'pointerdown'] as const

/**
 * A page opened on a section is scrolled there as soon as it renders, but the
 * web fonts can arrive afterwards and reflow the text above it. Once they
 * have, put the section back under the header, unless the reader has already
 * moved on.
 */
function useSectionAfterFonts() {
  useEffect(() => {
    const { section } = hashParts(window.location.hash)
    const fonts = typeof document === 'undefined' ? undefined : document.fonts
    if (!section || !fonts) return
    let wanted = true
    const stop = () => {
      wanted = false
    }
    for (const move of MOVES) window.addEventListener(move, stop, { passive: true })
    // Asked after a frame: by then the text is laid out and its fonts are loading, so ready waits for them.
    const frame = requestAnimationFrame(() => {
      void fonts.ready.then(() => {
        if (wanted) scrollToSection(section)
      })
    })
    return () => {
      wanted = false
      cancelAnimationFrame(frame)
      for (const move of MOVES) window.removeEventListener(move, stop)
    }
  }, [])
}

/**
 * The docs: `#/docs` is the index, `#/docs/<slug>` a page. A slug that names
 * no page shows the index, without an error, the way an unknown route shows
 * Home. Nothing here reads, signs or stores anything.
 */
export function Docs({ slug }: { slug: string }) {
  const page = findDocPage(slug)
  useSectionAfterFonts()
  useTabTitle(page ? `${page.title} · Domino docs` : 'Domino docs')
  return (
    <PageShell data-docs="">
      <DocsLayout page={page} />
    </PageShell>
  )
}
