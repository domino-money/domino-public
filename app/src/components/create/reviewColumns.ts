import { useEffect, useLayoutEffect, useState } from 'react'

/**
 * Review's two cards (V4, site/new.html .desk on Review): what you check in the steps card, and In your wallet as its own
 * card, beside it on a wide screen and under it on a phone. The DOM stays one review body (the wallet steps inside the
 * review stack, the footer inside the body: tests and the reading order rely on both), so the stylesheet places the
 * wallet steps in their card and starts the footer right under them. Two lengths cannot be had from CSS alone: the wallet
 * section's height and the footer's, measured here and written on the steps card as --np-wh and --np-fh
 * (styles/v4-newposition.css §8). Presentation only: nothing is read, moved or changed in the DOM; the properties go when
 * Review closes.
 */
export function useReviewColumns(open: boolean): void {
  useLayoutEffect(() => {
    if (!open || typeof document === 'undefined') return
    const page = document.querySelector<HTMLElement>('.dm-np')
    const card = page?.querySelector<HTMLElement>('.dm-flow-card')
    if (!page || !card) return
    let section: HTMLElement | null = null
    let footer: HTMLElement | null = null
    let frame = 0
    const resize = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => measure())
    const follow = (was: HTMLElement | null, next: HTMLElement | null) => {
      if (next === was) return was
      if (was) resize?.unobserve(was)
      if (next) resize?.observe(next)
      return next
    }
    const measure = () => {
      const body = card.querySelector<HTMLElement>('[data-stage-card="review"]')
      section = follow(section, body?.querySelector<HTMLElement>('[data-stage="review"] > section:has(> h3[id$="steps-heading"])') ?? null)
      footer = follow(footer, body?.querySelector<HTMLElement>(':scope > [data-journey-footer]') ?? null)
      card.style.setProperty('--np-wh', `${section ? section.offsetHeight : 0}px`)
      card.style.setProperty('--np-fh', `${footer ? footer.offsetHeight : 0}px`)
    }
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(() => {
        frame = 0
        measure()
      })
    }
    const changes = typeof MutationObserver === 'undefined' ? null : new MutationObserver(schedule)
    changes?.observe(card, { childList: true, subtree: true })
    measure()
    return () => {
      if (frame) cancelAnimationFrame(frame)
      changes?.disconnect()
      resize?.disconnect()
      card.style.removeProperty('--np-wh')
      card.style.removeProperty('--np-fh')
    }
  }, [open])
}

/**
 * The page's first moment (V4 kit, new.html data-first): true for the first 0.9 s after the journey mounts, while the
 * open step's body, the preview's figures and the done checks wait for their cards (styles/v4-newposition.css).
 */
export function useFirstLoad(): boolean {
  const [first, setFirst] = useState(true)
  useEffect(() => {
    const timer = setTimeout(() => setFirst(false), 900)
    return () => clearTimeout(timer)
  }, [])
  return first
}
