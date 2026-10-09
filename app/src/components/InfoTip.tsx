import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

/** Short help on hover, keyboard focus or tap, kept inside the viewport rather than the table's scroll clip. */
export function InfoTip({ label, text, children }: { label: string; text: string; children: ReactNode }) {
  const id = useId()
  const button = useRef<HTMLButtonElement>(null)
  const tip = useRef<HTMLSpanElement>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [at, setAt] = useState<{ left: number; top: number; above: boolean } | null>(null)
  const cancel = () => { if (timer.current) clearTimeout(timer.current); timer.current = null }
  const close = () => { cancel(); setAt(null) }
  const show = () => {
    cancel()
    const rect = button.current?.getBoundingClientRect()
    if (!rect) return
    const above = rect.bottom > window.innerHeight - 100
    setAt({ left: Math.max(12, Math.min(window.innerWidth - 268, rect.left + rect.width / 2 - 128)), top: above ? rect.top - 8 : rect.bottom + 8, above })
  }
  const leave = () => { cancel(); timer.current = setTimeout(() => { if (document.activeElement !== button.current) setAt(null) }, 120) }
  useEffect(() => {
    if (!at) return
    const dismiss = (event: Event) => { if (!button.current?.contains(event.target as Node) && !tip.current?.contains(event.target as Node)) setAt(null) }
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') setAt(null) }
    const moved = () => setAt(null)
    document.addEventListener('pointerdown', dismiss)
    document.addEventListener('keydown', escape)
    window.addEventListener('scroll', moved, true)
    window.addEventListener('resize', moved)
    return () => { document.removeEventListener('pointerdown', dismiss); document.removeEventListener('keydown', escape); window.removeEventListener('scroll', moved, true); window.removeEventListener('resize', moved) }
  }, [at])
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current) }, [])
  return <>
    <button ref={button} type="button" className="dm-info-tip-trigger" aria-label={label} aria-describedby={at ? id : undefined} onMouseEnter={show} onMouseLeave={leave} onFocus={show} onBlur={close} onClick={event => { event.stopPropagation(); show() }}>{children}</button>
    {/* Hover keeps explanatory text visible while the pointer moves onto it; the tooltip has no action. */}
    {/* oxlint-disable-next-line jsx-a11y/no-noninteractive-element-interactions */}
    {at && createPortal(<span ref={tip} id={id} role="tooltip" className="dm-info-tip" style={{ left: at.left, top: at.top, transform: at.above ? 'translateY(-100%)' : undefined }} onMouseEnter={cancel} onMouseLeave={leave}>{text}</span>, document.body)}
  </>
}
