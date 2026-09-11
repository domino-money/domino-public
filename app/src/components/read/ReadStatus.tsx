import { describeFailure } from '../../lib/read/describe'
import type { MarketsState } from '../../lib/read/marketsProvider'
import type { FailedOutcome } from '../../lib/read/types'
import { Button, cx } from '../ui'

export interface StatusView {
  /** The outcome state, for tests and styling: `loading`, `partial` or a read state. */
  code: string
  title: string
  detail: string
  retry: boolean
  signIn?: boolean
  /** A retry is in flight: the button stays, focused, but inert. */
  busy?: boolean
  lines?: string[]
}

const fromFailure = (failure: FailedOutcome, extra: Partial<StatusView> = {}): StatusView => ({
  code: failure.state,
  ...describeFailure(failure),
  ...extra,
})

const clock = (ms: number) => new Date(ms).toLocaleTimeString('en-US')
const shortPool = (id: string) => `${id.slice(0, 6)}…${id.slice(-4)}`

/** What the status line says for a markets state, or null when there is nothing to say. */
export function marketsStatus(state: MarketsState): StatusView | null {
  switch (state.phase) {
    case 'loading':
      return state.retrying
        ? fromFailure(state.retrying, { busy: true })
        : { code: 'loading', title: 'Loading pool data…', detail: '', retry: false }
    case 'failed': {
      const retained = state.retained
      return fromFailure(state.failure, {
        lines: retained ? [`Showing the pools read at ${clock(retained.receivedAt)}. Their figures are marked stale.`] : undefined,
      })
    }
    case 'ready':
      if (state.problems.length === 0) return null
      return {
        code: 'partial',
        title: 'Some pool data could not be read',
        detail: 'The figures that depend on it show as unavailable.',
        retry: true,
        lines: state.problems.map(({ poolId, outcome }) => `Pool ${shortPool(poolId)}, ${outcome.route}: ${describeFailure(outcome).title.toLowerCase()}.`),
      }
    default:
      return state satisfies never
  }
}

/**
 * The one place a screen says how its reads went. Always mounted, so the
 * polite live region is already there when something changes, and empty
 * when there is nothing to say. Retry keeps its place and focus while a
 * retry runs. "Sign in again" is a fixed link to this site's root, where the
 * gate shows its access page.
 */
export function ReadStatus({ status, onRetry, className }: { status: StatusView | null; onRetry?: () => void; className?: string }) {
  return (
    <div
      role="status"
      aria-live="polite"
      data-read-status={status?.code ?? 'none'}
      {...(status?.code === 'loading' ? { 'data-loading': '' } : {})}
      className={status ? cx('rounded-[14px] border bg-surface-1 px-4 py-3', className) : 'sr-only'}
    >
      {status && (
        <>
          <p className="text-[14px] font-medium">{status.title}</p>
          {status.detail && <p className="mt-0.5 text-[13px] text-fg-muted">{status.detail}</p>}
          {status.lines?.map((line) => (
            <p key={line} className="mt-1 text-[12px] text-fg-subtle">
              {line}
            </p>
          ))}
          {(status.signIn || (status.retry && onRetry)) && (
            <div className="mt-3 flex items-center gap-2">
              {status.signIn && (
                <a href="/" className="rounded-[var(--radius-pill)] bg-primary px-4 py-2 text-[13px] font-medium text-primary-fg">
                  Sign in again
                </a>
              )}
              {status.retry && onRetry && (
                <Button
                  variant="outline"
                  aria-disabled={status.busy ? true : undefined}
                  onClick={() => {
                    if (!status.busy) onRetry()
                  }}
                >
                  {status.busy ? 'Trying again…' : 'Retry'}
                </Button>
              )}
            </div>
          )}
        </>
      )}
    </div>
  )
}
