import { useEffect, useState } from 'react'
import { IconCheck, IconCopy } from '../../icons'
import { cx } from '../../ui'

/**
 * Copies one identity string (a pool id, an address) to the clipboard and
 * says so for a moment: the tick draws itself in (DESIGN-V2 M23). The value
 * is always shown or reachable beside it; this only saves the selecting.
 */
export function CopyButton({ value, label, className }: { value: string; label: string; className?: string }) {
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), 1600)
    return () => clearTimeout(timer)
  }, [copied])
  const copy = () => {
    const clipboard = typeof navigator === 'undefined' ? undefined : navigator.clipboard
    if (!clipboard) return
    void clipboard.writeText(value).then(() => setCopied(true), () => undefined)
  }
  return (
    <button
      type="button"
      onClick={copy}
      title={label}
      aria-label={copied ? 'Copied' : label}
      data-copied={copied ? '' : undefined}
      className={cx(
        'dm-press-icon inline-flex size-6 shrink-0 items-center justify-center rounded-[var(--radius-sm)] align-middle text-fg-subtle hover:bg-wash hover:text-fg',
        copied && 'text-money-in hover:text-money-in',
        className,
      )}
    >
      {copied ? <IconCheck size={16} className="dm-check-draw" /> : <IconCopy size={16} />}
    </button>
  )
}
