/**
 * Setup's assisted swap, previewed: the provider's quote, its output fee, the
 * network gas, the simulation and the checks, for the amount the owner typed.
 *
 * onboarding-v1's swap-preview, asked for a signed-in wallet when what the
 * open swap fields would quote changes (onboarding/intent.ts), never on a
 * timer and never by opening the fields again: a quote follows what the owner
 * types. It is current for 30 seconds; then its figures go back to a dash,
 * and why is in the title. Nothing here swaps, approves or signs: Simulate and
 * review swap stays the only way on, and it asks the wallet. The session port
 * and the fetch arrive from the screen, so this module never reaches the
 * wallet feature itself.
 */
import { useEffect, useMemo, useSyncExternalStore } from 'react'
import type { Clock } from '../../lib/clock'
import type { FetchLike } from '../../lib/http/rawReply'
import { broadcastBudgetChannel, createPreviewBudget } from '../../onboarding/budget'
import { createOnboardingClient } from '../../onboarding/client'
import { ONBOARDING_RUNTIME } from '../../onboarding/contract'
import { createPreviewController } from '../../onboarding/controller'
import { createIntentDriver, formFromRequest, type IntentView } from '../../onboarding/intent'
import { SWAP_ROW_LABELS, swapRequest, swapRows, type SwapFields, type SwapRow } from '../../onboarding/swap'
import type { SessionPort } from '../../session/port'

const timeText = (wallMs: number | null) => (wallMs === null ? '' : new Date(wallMs).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }))

/** Why every figure is a dash, by status: the title's words. */
function dashTitle(view: IntentView<'swap-preview'>): string {
  switch (view.status) {
    case 'expired':
      return `This quote expired at ${timeText(view.expiredAtWallMs)}.`
    case 'signed-out':
      return 'Sign in with your wallet to see a quote for this amount.'
    case 'loading':
      return 'Asking for a quote…'
    case 'unavailable':
      return 'A quote could not be read for this amount.'
    case 'off':
      return view.reason === 'not_formed' ? 'Enter the operation’s tokens, an amount, slippage and a maximum price impact to see a quote.' : 'A quote is not available here.'
    case 'current':
      return ''
    default:
      return view.status satisfies never
  }
}

/** What a row's value says when hovered while a quote is current. */
const ROW_NOTES: Readonly<Partial<Record<SwapRow['id'], string>>> = {
  input: 'Your amount less the assisted swap fee: what the pool receives.',
  output: 'Before any provider output fee.',
  minimum: 'The output less your slippage.',
  gas: 'The provider’s estimate, without approvals.',
}

const IDS = Object.keys(SWAP_ROW_LABELS) as SwapRow['id'][]

export function SwapQuote({ fields, open, port, fetch, clock }: { fields: SwapFields; open: boolean; port: SessionPort; fetch: FetchLike; clock: Clock }) {
  const deps = useMemo(() => {
    const budget = createPreviewBudget({ clock, channel: broadcastBudgetChannel() })
    const client = createOnboardingClient({ fetch, runtime: ONBOARDING_RUNTIME, clock })
    const controller = createPreviewController('swap-preview', { client, port, clock, budget })
    // Reopening the fields asks for nothing a quote was already asked for: only a change the owner typed does.
    return { budget, driver: createIntentDriver({ controller, port, clock, openingAsks: false }) }
  }, [port, fetch, clock])
  useEffect(() => deps.budget.connect(), [deps])
  useEffect(() => deps.driver.start(), [deps])
  const formed = swapRequest(fields)
  const request = formed.ok ? formed.request : null
  const why = formed.ok ? '' : formed.problem
  useEffect(() => {
    deps.driver.setForm(formFromRequest('swap-preview', request, why))
  })
  useEffect(() => {
    deps.driver.setOpen(open)
  }, [deps, open])
  const view = useSyncExternalStore(deps.driver.subscribe, deps.driver.getView)
  const rows = view.status === 'current' && view.preview ? swapRows(view.preview) : null
  const current = rows ? `A quote for this amount, current until ${timeText(view.currentUntilWallMs)}.` : dashTitle(view)
  return (
    <section
      aria-label="Swap quote"
      className="dm-acct-review"
      data-swap-preview={view.status}
      data-swap-preview-reason={view.reason ?? undefined}
      data-swap-preview-checks={view.preview ? view.preview.previewChecks.status : undefined}
      aria-busy={view.status === 'loading' || undefined}
    >
      <dl className="dm-kv dm-acct-facts">
        {IDS.map((id) => {
          const row = rows?.find((entry) => entry.id === id)
          const cell = row?.cell
          const title = !cell ? current : cell.kind === 'none' ? `${current} Not reported.` : [current, ROW_NOTES[id]].filter(Boolean).join(' ')
          return (
            <div key={id} data-swap-row={id}>
              <dt>{SWAP_ROW_LABELS[id]}</dt>
              <dd className="min-w-0 tnum dm-acct-wrap" title={title} data-swap-cell={cell ? cell.kind : 'none'} data-swap-cell-reason={cell?.kind === 'none' ? cell.why : undefined}>
                {cell && cell.kind === 'value' ? cell.text : '—'}
              </dd>
            </div>
          )
        })}
      </dl>
      <p role="status" aria-live="polite" className="sr-only">
        {view.status === 'current' ? 'Swap quote shown.' : view.status === 'expired' ? 'The swap quote expired.' : ''}
      </p>
    </section>
  )
}
