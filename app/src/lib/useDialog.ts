import { useEffect, useRef } from 'react'

const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  'details > summary:first-child:not([tabindex="-1"])',
  '[tabindex]:not([tabindex="-1"])',
].join(',')

const supportsInert = typeof HTMLElement !== 'undefined' && 'inert' in HTMLElement.prototype

/**
 * Modal behaviour that `aria-modal` alone does not provide.
 *
 * Keeps Tab and Shift+Tab inside the dialog, hides the rest of the page from
 * assistive technology and from pointer input while it is open, closes on
 * Escape, and returns focus to whatever opened it. Returns a ref to put on the
 * dialog element.
 *
 * The effect deliberately depends on `open` alone. Callers pass an inline
 * `onClose`, so depending on its identity would tear down and re-run on every
 * render, and each teardown would pull focus back to the trigger.
 */
export function useDialog(open: boolean, onClose: () => void) {
  const container = useRef<HTMLDivElement>(null)
  const close = useRef(onClose)

  useEffect(() => {
    close.current = onClose
  }, [onClose])

  useEffect(() => {
    if (!open) return
    const node = container.current
    if (!node) return

    const restoreTo = document.activeElement instanceof HTMLElement ? document.activeElement : null

    // Hide everything else from assistive tech and pointer input. The dialog is
    // rendered deep inside the app root rather than as a child of body, so walk
    // up from it and mark the siblings at every level.
    const outside: HTMLElement[] = []
    for (let el: HTMLElement | null = node; el && el !== document.body; el = el.parentElement) {
      for (const sibling of Array.from(el.parentElement?.children ?? [])) {
        if (sibling !== el && sibling instanceof HTMLElement) outside.push(sibling)
      }
    }
    const restored = outside.map((el) => ({
      el,
      ariaHidden: el.getAttribute('aria-hidden'),
      inert: el.hasAttribute('inert'),
    }))
    for (const el of outside) {
      el.setAttribute('aria-hidden', 'true')
      // Set the attribute rather than the property: it reflects either way on
      // engines that support inert, and is inspectable on those that do not.
      el.setAttribute('inert', '')
      if (supportsInert) el.inert = true
    }

    const focusables = () =>
      Array.from(node.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((el) => {
        // Closed details can retain layout boxes in Chromium, so offsetParent
        // alone would keep their hidden buttons in the trap and strand focus.
        if (typeof el.checkVisibility === 'function') return el.checkVisibility({ checkVisibilityCSS: true })
        for (let closed = el.closest('details:not([open])'); closed; closed = closed.parentElement?.closest('details:not([open])') ?? null) {
          if (!closed.querySelector(':scope > summary:first-child')?.contains(el)) return false
        }
        return el.offsetParent !== null || el === document.activeElement
      })

    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        // 2026-10-03 (the position dialogs' token chip, components/ui.tsx Select): a select's list open inside the dialog
        // closes first. Its trigger keeps focus while the list is open and says so (combobox, expanded), and its own
        // Escape closes the list; the dialog closes on the next one.
        const active = document.activeElement
        if (active instanceof HTMLElement && node.contains(active) && active.getAttribute('role') === 'combobox' && active.getAttribute('aria-expanded') === 'true') return
        event.stopPropagation()
        close.current()
        return
      }
      if (event.key !== 'Tab') return
      const items = focusables()
      if (items.length === 0) {
        event.preventDefault()
        return
      }
      const first = items[0]
      const last = items[items.length - 1]
      const active = document.activeElement
      // Wrap at both ends, and pull focus back in if it has escaped the dialog.
      if (!node.contains(active)) {
        event.preventDefault()
        ;(event.shiftKey ? last : first).focus()
        return
      }
      const at = items.indexOf(active as HTMLElement)
      if (at === -1) {
        // The dialog opens with its heading focused, and a heading is not
        // tabbable, so it is not in this list. Left to the browser, Shift+Tab
        // from there walks backwards out of the dialog and lands on BODY.
        // Step to the neighbour on the correct side instead, wrapping at the
        // ends like any other position.
        event.preventDefault()
        const before = (el: HTMLElement) =>
          Boolean(el.compareDocumentPosition(active!) & Node.DOCUMENT_POSITION_FOLLOWING)
        const target = event.shiftKey
          ? items.filter(before).pop() ?? last
          : items.find((el) => !before(el)) ?? first
        target.focus()
        return
      }
      if (event.shiftKey && at === 0) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && at === items.length - 1) {
        event.preventDefault()
        first.focus()
      }
    }

    // Marking the background inert leaves focus outside the dialog, so claim it
    // here. The DOM is committed by the time this effect runs, so this is done
    // synchronously rather than on a later frame, where it would race the step
    // dialog's own heading focus and could be cancelled by a re-render.
    if (!node.contains(document.activeElement)) {
      const heading = node.querySelector<HTMLElement>('[tabindex="-1"]')
      const target = heading ?? focusables()[0] ?? node
      if (target === node && !node.hasAttribute('tabindex')) node.setAttribute('tabindex', '-1')
      target.focus()
    }

    document.addEventListener('keydown', onKey, true)
    return () => {
      document.removeEventListener('keydown', onKey, true)
      for (const entry of restored) {
        if (entry.ariaHidden === null) entry.el.removeAttribute('aria-hidden')
        else entry.el.setAttribute('aria-hidden', entry.ariaHidden)
        if (!entry.inert) entry.el.removeAttribute('inert')
        if (supportsInert) entry.el.inert = entry.inert
      }
      restoreTo?.focus?.()
    }
  }, [open])

  return container
}
