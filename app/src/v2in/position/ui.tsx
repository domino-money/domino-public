import type { ReactNode } from 'react'
import { ActionSheet, SheetAlert, SheetLocked, SheetNote, SheetStatus, TokenRow, TokenRows } from '../../components/positions/ActionSheet'
import { TokenMark, TokenMarkPair } from '../../components/TokenIcon'
import { Button } from '../../components/ui'
import { formatUnitsText } from '../../v2/plan/present'
import type { Address, V2ChainId } from '../../v2/types'
import { COPY } from './copy'
import { REJECTED_IN_WALLET, type ActionError } from './errors'
import { markOf } from './marks'
import { amountText, decimalsOf, labelOf, type TokenBook } from './tokens'

/**
 * The position page's Domino V2 parts in the page's own look. Changed on purpose 2026-10-03 (the owner, point 9: the
 * dialogs were "literally ugly"): the position actions' one family (components/positions/ActionSheet.tsx, shared with
 * V1's Collect fees and Close position): the frame (title, its plain line, Back on the second step, Close, one button at
 * the foot), token rows with each token's mark, notes, the step in progress, the failure line (its code in
 * `data-error-code`, never in the text), the tick a warning asks for, and the gate's locked slot.
 */
export function ActionDialog({ id, title, lede, back, onClose, children, footer, ...data }: {
  id: string
  title: ReactNode
  lede?: ReactNode
  back?: ({ onClick: () => void; disabled?: boolean } & Record<`data-${string}`, string>) | null
  onClose: () => void
  children: ReactNode
  footer: ReactNode
} & Record<`data-${string}`, string>) {
  return (
    <ActionSheet id={`position-v2-${id}`} title={title} lede={lede} back={back} onClose={onClose} footer={footer} {...data}>
      {children}
    </ActionSheet>
  )
}

/** A short note in the dialog; `warn` for what the person must not miss. */
export function Note({ children, tone = 'info', ...data }: { children: ReactNode; tone?: 'info' | 'warn' } & Record<`data-${string}`, string>) {
  return (
    <SheetNote tone={tone} {...data}>
      {children}
    </SheetNote>
  )
}

/** What the dialog is doing now, as V1's dialogs say it. */
export function Progress({ children, ...data }: { children: ReactNode } & Record<`data-${string}`, string>) {
  return <SheetStatus {...data}>{children}</SheetStatus>
}

/**
 * A failure in words, its code in `data-error-code` only. Under `zap_action_unsettled` (an earlier action handed to the
 * wallet is not settled yet, rev2 review F3), V1's own way out, "I rejected it in my wallet", when the dialog hands
 * `onRejected` (the money client hears it only while the chain shows nothing pending).
 */
export function ErrorLine({ error, onRejected, busy = false }: { error: ActionError | null; onRejected?: () => void; busy?: boolean }) {
  if (!error) return null
  return (
    <>
      <SheetAlert data-position-notice="v2" data-error-code={error.code}>
        {error.copy}
      </SheetAlert>
      {error.code === 'zap_action_unsettled' && onRejected && (
        <Button type="button" variant="outline" size="sm" className="justify-self-start" disabled={busy} onClick={onRejected} data-position-rejected="">
          {REJECTED_IN_WALLET}
        </Button>
      )}
    </>
  )
}

/** A box the person ticks before the wallet may be asked (rev2 §2.13's pause warning). */
export function Tick({ checked, onChange, children, disabled, ...data }: { checked: boolean; onChange: (next: boolean) => void; children: ReactNode; disabled?: boolean } & Record<`data-${string}`, string>) {
  return (
    <label className="dm-pa-tick">
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(event) => onChange(event.currentTarget.checked)} {...data} />
      <span>{children}</span>
    </label>
  )
}

/** The gate's sentence where the wallet's button would be: the option runs to its review and no further yet. */
export function Locked({ copy }: { copy: string }) {
  return <SheetLocked data-position-locked="">{copy}</SheetLocked>
}

/** A token's mark on its chain (./marks.ts): Robinhood's artwork, another chain's plain disc. */
export function Mark({ chainId, book, token, size = 20 }: { chainId: V2ChainId; book: TokenBook; token: Address; size?: number }) {
  const meta = book.get(token.toLowerCase()) ?? { address: token, symbol: null, decimals: null }
  return <TokenMark token={markOf(chainId, meta)} size={size} />
}

/**
 * A raw amount split for a token row: the figure in the token's own units, and its symbol (raw units when unread).
 * `round` 'up' for a fee, never shown lower than it is (v2/plan/present.ts formatUnitsText, 2026-10-06).
 */
export function amountParts(book: TokenBook, token: Address, raw: bigint, maxFraction = 6, round: 'down' | 'up' = 'down'): { figure: string; symbol: string } {
  const decimals = decimalsOf(book, token)
  const label = labelOf(book, token)
  return decimals === null ? { figure: formatUnitsText(raw, null), symbol: `${COPY.form.rawUnits} of ${label}` } : { figure: formatUnitsText(raw, decimals, maxFraction, round), symbol: label }
}

/** Token amounts as rows: each token's mark, its figure, its symbol; every digit in the row's title. */
export function Rows({ chainId, book, items, size = 'lg', maxFraction = 6, round = 'down', ...data }: { chainId: V2ChainId; book: TokenBook; items: readonly { token: Address; amount: bigint }[]; size?: 'lg' | 'sm'; maxFraction?: number; round?: 'down' | 'up' } & Record<`data-${string}`, string>) {
  return (
    <TokenRows size={size} {...data}>
      {items.map((item, index) => {
        const parts = amountParts(book, item.token, item.amount, maxFraction, round)
        return <TokenRow key={`${item.token}-${index}`} mark={<Mark chainId={chainId} book={book} token={item.token} size={size === 'lg' ? 28 : 16} />} figure={parts.figure} symbol={parts.symbol} title={amountText(book, item.token, item.amount, 18)} />
      })}
    </TokenRows>
  )
}

/** Both amounts of a pool's pair as rows, as V1's dialogs draw them. */
export function Pair({ chainId, book, tokens, amounts, size = 'sm', maxFraction }: { chainId: V2ChainId; book: TokenBook; tokens: readonly [Address, Address]; amounts: readonly [bigint, bigint]; size?: 'lg' | 'sm'; maxFraction?: number }) {
  return <Rows chainId={chainId} book={book} items={[{ token: tokens[0], amount: amounts[0] }, { token: tokens[1], amount: amounts[1] }]} size={size} maxFraction={maxFraction} />
}

/** "ETH / USDC" with the pair's two marks before it. */
export function PairName({ chainId, book, tokens, size = 20 }: { chainId: V2ChainId; book: TokenBook; tokens: readonly [Address, Address]; size?: number }) {
  const meta = (token: Address) => markOf(chainId, book.get(token.toLowerCase()) ?? { address: token, symbol: null, decimals: null })
  return (
    <span className="dm-pa-pair-name">
      <TokenMarkPair base={meta(tokens[0])} quote={meta(tokens[1])} size={size} ring="var(--pa-well, var(--surface-2))" />
      <span>
        {labelOf(book, tokens[0])} / {labelOf(book, tokens[1])}
      </span>
    </span>
  )
}

/** One amount inline, its mark beside it (a route's leg, a receipt's swap). */
export function Amount({ chainId, book, token, raw, maxFraction = 6 }: { chainId: V2ChainId; book: TokenBook; token: Address; raw: bigint; maxFraction?: number }) {
  return (
    <span className="dm-pa-inline tnum" title={amountText(book, token, raw, 18)}>
      <Mark chainId={chainId} book={book} token={token} size={16} />
      {amountText(book, token, raw, maxFraction)}
    </span>
  )
}
