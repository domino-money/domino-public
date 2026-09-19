import { lazy, Suspense } from 'react'
import type { PairBalancesState } from './usePairBalances'
import { CREATE } from '../../lib/create/copy'
import type { JourneyState } from '../../lib/create/journey'
import { SymbolText } from '../read/screens/SymbolText'

/**
 * Where the deposit amount rows stand, on the section as `data-preview`:
 *   off          nothing is asked here: this build has no wallet sign-in, or the service or the pool does not allow it
 *   signed-out   a signed-in wallet would see the amounts
 *   loading      asked for, or about to be
 *   current      filled with an estimate for these choices
 *   expired      the estimate expired and its figures are gone
 *   unavailable  the last request failed
 * The reason, a closed code, is `data-preview-reason`; the words are in the titles, never on screen.
 */
export type AmountsStatus = 'off' | 'signed-out' | 'loading' | 'current' | 'expired' | 'unavailable'

/** One token's figure: exact text, in token units when `units`, else raw units. Null when the estimate has none for it. */
export type AmountCell = { text: string; units: boolean } | null

export interface AmountsShown {
  status: AmountsStatus
  reason: string | null
  /** While current: one cell per pool currency, in pool order, and the liquidity. Null otherwise. */
  figures: { expected: readonly AmountCell[]; maximum: readonly AmountCell[]; unspent: readonly AmountCell[]; liquidity: string } | null
  /** What the rows say when hovered: until when the estimate is current, or why they show a dash. */
  title: string
  /** The estimate's own checks status, for data attributes only. */
  checks: string | null
  /**
   * The pool currencies, in pool order, the estimate reported the wallet does
   * not cover. A deposit is funded with both currencies, so this is where the
   * person learns they are short of the one they did not choose. Empty when no
   * balance could be read, which is also when the check cannot run.
   */
  short: readonly (0 | 1)[]
}

const TOKEN_ROWS = ['expected', 'maximum', 'unspent'] as const
const ROW_TITLES = { expected: CREATE.balance.titles.expected, maximum: CREATE.balance.titles.maximum, unspent: '' } as const

const NOT_ASKED: AmountsShown = { status: 'off', reason: 'no_wallet_sign_in', figures: null, title: CREATE.balance.titles.off, checks: null, short: [] }
const LOADING: AmountsShown = { status: 'loading', reason: null, figures: null, title: CREATE.balance.titles.loading, checks: null, short: [] }

// The consumer of the position preview, in builds that carry wallet sign-in: its own chunk, loaded when Review
// first renders, as Positions loads Performance and Execution. Elsewhere the constant is null, nothing is
// imported, and the rows stay a dash. A chunk that fails to load leaves the dash with its reason.
const DepositAmounts = __DOMINO_WALLET_SESSION__
  ? lazy(() =>
      import('./DepositAmounts').catch(() => ({
        default: ({ state }: { state: JourneyState; open: boolean; balances: PairBalancesState }) => <AmountsSection state={state} shown={{ ...NOT_ASKED, reason: 'not_loaded' }} />,
      })),
    )
  : null

/**
 * The deposit amounts, inside Review (the `balance` stage has no step of its
 * own): expected deposit, maximum debit and unspent budget per token, and the
 * mint's liquidity. Filled only while an estimate for exactly these choices
 * is current; otherwise every figure is a dash, and why is in its title. The
 * estimate is asked for when Review opens and when its inputs change, in
 * builds with wallet sign-in and for a signed-in wallet (DepositAmounts.tsx).
 * Exact amounts are still calculated in Setup, and nothing here can sign.
 */
export function StageBalance({ state, open, balances }: { state: JourneyState; open: boolean; balances: PairBalancesState }) {
  if (!DepositAmounts) return <AmountsSection state={state} shown={NOT_ASKED} />
  return (
    <Suspense fallback={<AmountsSection state={state} shown={LOADING} />}>
      <DepositAmounts state={state} open={open} balances={balances} />
    </Suspense>
  )
}

/** The rows as a table of facts, the same markup whatever the build: a figure per token while current, a dash otherwise. */
export function AmountsSection({ state, shown }: { state: JourneyState; shown: AmountsShown }) {
  const currencies = state.pool?.currencies ?? []
  const titles = CREATE.balance.titles
  const { figures } = shown
  // Named only when the pool read gave the currency a symbol: an unnamed one is left out rather than guessed.
  const shortLines = shown.short.map((index) => currencies[index]?.symbol).filter((symbol): symbol is string => typeof symbol === 'string' && symbol.length > 0)
  const tokenLines = (cells: readonly AmountCell[], row: (typeof TOKEN_ROWS)[number]) =>
    // A row the estimate has nothing for is one dash, not a dash per token.
    cells.every((cell) => cell === null) ? (
      <span className="block" title={row === 'unspent' ? titles.noBudget : shown.title} data-amount-cell="none">
        —
      </span>
    ) : cells.map((cell, index) => {
      const token = currencies[index]
      if (cell === null) {
        return (
          <span key={index} className="block" title={row === 'unspent' ? titles.noBudget : shown.title} data-amount-cell="none">
            —
          </span>
        )
      }
      const title = [shown.title, cell.units ? ROW_TITLES[row] : titles.rawUnits].filter(Boolean).join(' ')
      return (
        <span key={index} className="block" title={title} data-amount-cell={cell.units ? 'units' : 'raw'}>
          {cell.units ? cell.text : CREATE.balance.rawUnits(cell.text)}
          {cell.units && token && (
            <>
              {' '}
              <SymbolText token={token} />
            </>
          )}
        </span>
      )
    })
  return (
    <section
      aria-labelledby="create-amounts-heading"
      className="dm-flow-section"
      data-stage="balance"
      data-preview={shown.status}
      data-preview-reason={shown.reason ?? undefined}
      data-preview-checks={shown.checks ?? undefined}
      aria-busy={shown.status === 'loading' || undefined}
    >
      <h3 id="create-amounts-heading" className="dm-flow-subtitle">
        {CREATE.review.amounts}
      </h3>
      <dl className="dm-flow-facts">
        {TOKEN_ROWS.map((row) => (
          <div key={row} data-balance-row={row}>
            <dt>{CREATE.balance.rows[row]}</dt>
            <dd className="tnum" title={figures ? undefined : shown.title}>
              {figures ? tokenLines(figures[row], row) : '—'}
            </dd>
          </div>
        ))}
        <div data-balance-row="liquidity">
          <dt>{CREATE.balance.rows.liquidity}</dt>
          <dd className="tnum" title={figures ? `${shown.title} ${titles.liquidity}` : shown.title}>
            {figures ? figures.liquidity : '—'}
          </dd>
        </div>
      </dl>
      {shortLines.length > 0 && (
        <p className="dm-flow-short" data-balance-short={shown.short.join(',')}>
          {CREATE.balance.short(shortLines)}
        </p>
      )}
      <p className="dm-hint">{CREATE.balance.notEnabled}</p>
      <p role="status" aria-live="polite" className="sr-only">
        {shown.status === 'current' ? CREATE.balance.announce.current : shown.status === 'expired' ? CREATE.balance.announce.expired : ''}
      </p>
    </section>
  )
}
