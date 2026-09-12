import { useEffect, type ReactNode } from 'react'
import { useDialog } from '../../../lib/useDialog'
import { Button, Card, Display, Eyebrow } from '../../ui'

/** One bounded choice; closing unmounts and cancels its child-owned reads. */
export function PoolSelectionDialog({ title, description, onClose, children, footer }: {
  title: string
  description: string
  onClose: () => void
  children: ReactNode
  footer: ReactNode
}) {
  const dialog = useDialog(true, onClose)
  useEffect(() => {
    const previous = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => { document.body.style.overflow = previous }
  }, [])

  return (
    <div role="presentation" className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 backdrop-blur-[2px] sm:items-center sm:p-4"
      onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <Card ref={dialog} level={2} role="dialog" aria-modal="true" aria-labelledby="pool-selection-title" aria-describedby="pool-selection-description"
        className="grid max-h-[92dvh] w-full max-w-[620px] grid-rows-[auto_minmax(0,1fr)_auto] rounded-b-none sm:max-h-[86dvh] sm:rounded-b-[var(--radius-lg)]" data-pool-selection-dialog="">
        <header className="border-b p-5">
          <div className="flex items-center justify-between gap-3">
            <Eyebrow>Robinhood Chain · read only</Eyebrow>
            <Button type="button" variant="ghost" onClick={onClose} aria-label="Close pool explorer">Close</Button>
          </div>
          <Display as="h2" id="pool-selection-title" tabIndex={-1} className="mt-2 text-[26px] outline-none">{title}</Display>
          <p id="pool-selection-description" className="mt-2 text-[13px] leading-relaxed text-fg-muted">{description}</p>
        </header>
        <div className="min-h-0 overflow-y-auto overscroll-contain p-5">{children}</div>
        <footer className="flex items-center justify-between gap-3 border-t p-5">
          <Button type="button" variant="ghost" onClick={onClose}>Back to pools</Button>
          {footer}
        </footer>
      </Card>
    </div>
  )
}
