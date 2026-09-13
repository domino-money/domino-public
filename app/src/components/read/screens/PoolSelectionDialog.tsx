import { useEffect, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useDialog } from '../../../lib/useDialog'
import { IconClose } from '../../icons'
import { Button, IconButton } from '../../ui'

/**
 * One bounded choice; closing unmounts and cancels its child-owned reads.
 * Drawn on the document body, so no transformed or clipped ancestor can move
 * or cut the fixed backdrop; the dialog hook still hides the rest of the page.
 * Head and foot are plain divs: the page's only header and footer are the site's.
 */
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

  return createPortal(
    <div role="presentation" className="dm-dialog-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div ref={dialog} role="dialog" aria-modal="true" aria-labelledby="pool-selection-title" aria-describedby="pool-selection-description"
        className="dm-dialog dm-dialog--wide dm-flow-dialog" data-pool-selection-dialog="">
        <div className="dm-flow-dialog-head">
          <h2 id="pool-selection-title" tabIndex={-1} className="dm-dialog-title outline-none">{title}</h2>
          <p id="pool-selection-description" className="mt-1 text-body text-fg-muted">{description}</p>
          <IconButton label="Close" icon={<IconClose />} variant="ghost" size="sm" className="dm-dialog-close" onClick={onClose} />
        </div>
        <div className="dm-flow-dialog-body">{children}</div>
        <div className="dm-flow-dialog-foot">
          <Button type="button" variant="ghost" onClick={onClose}>Back to pools</Button>
          {footer}
        </div>
      </div>
    </div>,
    document.body,
  )
}
