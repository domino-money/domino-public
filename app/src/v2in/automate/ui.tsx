import type { ReactNode } from 'react'
import { ActionSheet } from '../../components/positions/ActionSheet'
import type { ErrorView } from './copy'

/**
 * The integrated automation screens' small shared parts, drawn with the existing app's own classes (the position page's
 * action dialogs, Set up automation's steps and consent, the details disclosures): never a look of their own.
 */

/** A failure in words, its code in `data-error-code`, never in the text. */
export function ErrorLine({ error }: { error: ErrorView | null }) {
  if (!error) return null
  return (
    <p role="alert" className="text-body text-fg-muted" data-error-code={error.code}>
      {error.text}
    </p>
  )
}

/** Where a `preview` option stops: its review is shown, and this sentence stands where the wallet would be asked. */
export function LockedNote({ copy }: { copy: string }) {
  return (
    <p role="status" className="dm-flow-reason" data-align="start" data-v2-locked="">
      {copy}
    </p>
  )
}

/** Technical detail, closed until opened (beginner-first), as the flows' own Advanced and More limits are. */
export function Details({ label = 'Details', children, ...data }: { label?: string; children: ReactNode } & Record<`data-${string}`, string>) {
  return (
    <details className="dm-details dm-acct-disclosure" {...data}>
      <summary>{label}</summary>
      <div className="dm-acct-disclosure-body dm-v2in-facts">{children}</div>
    </details>
  )
}

/** One exact fact inside Details: its label, and its value as written (an address, a raw integer). */
export function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <p className="dm-acct-note">
      {label}: <span className="dm-mono" translate="no">{children}</span>
    </p>
  )
}

/** A consent or an acknowledgement: Set up automation's own box. */
export function Check({ checked, onChange, disabled, children, ...data }: { checked: boolean; onChange: (next: boolean) => void; disabled?: boolean; children: ReactNode } & Record<`data-${string}`, string>) {
  return (
    <label className="dm-acct-check dm-seq-consent">
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(event) => onChange(event.target.checked)} {...data} />
      <span>{children}</span>
    </label>
  )
}

/**
 * Automation uses the same frame as every position action, including focus, scrolling and the mobile footer.
 * Callers keep their wallet steps, confirmations and data hooks.
 */
export function FlowDialog({ name, title, onClose, children, footer }: { name: string; title: string; onClose: () => void; children: ReactNode; footer: ReactNode }) {
  return (
    <ActionSheet id={`v2in-${name}`} title={title} onClose={onClose} footer={footer} data-v2in-dialog={name}>
      {children}
    </ActionSheet>
  )
}
