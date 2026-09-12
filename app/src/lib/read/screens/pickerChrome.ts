/**
 * The contract between the create dialog and the chain-selection
 * slot. Type-only: CreatePositionFlow imports it with `import type`, so none
 * of the picker's words or state reach the default bundle.
 *
 * While a picker is open, the slot owns the dialog's header text, its two
 * footer buttons and its error line; the progress marker stays on "Pair".
 * Escape and a backdrop click call `onBack`, which returns to Pair and keeps
 * the draft. `focusKey` changes on every view change, and the
 * dialog moves focus to its heading each time.
 */
export interface PickerChrome {
  title: string
  description: string
  backLabel: string
  nextLabel: string
  nextDisabled: boolean
  error?: string
  focusKey: string
  onBack(): void
  onNext(): void
}

export interface ChainSelectionSlotProps {
  onChrome(chrome: PickerChrome | null): void
}
