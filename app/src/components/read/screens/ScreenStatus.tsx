import type { ScreenText } from '../../../lib/read/screens/copy'
import { Button, cx } from '../../ui'

export type StatusLine = Pick<ScreenText, 'code' | 'title' | 'detail'> & { retry?: boolean }

/**
 * A read screen's one polite status line. Always mounted, so the live region
 * exists before anything changes, and empty when there is nothing to say.
 * Retry stays mounted and focused, marked busy, while its read runs. There is
 * no sign-in link: an expired beta cookie is fixed by reloading the page,
 * never by a wallet.
 */
export function ScreenStatus({ line, onRetry, busy, className }: { line: StatusLine | null; onRetry?: () => void; busy?: boolean; className?: string }) {
  return (
    <div
      role="status"
      aria-live="polite"
      data-screen-status={line?.code ?? 'none'}
      className={line ? cx('dm-inset px-4 py-3', className) : 'sr-only'}
    >
      {line && (
        <>
          <p className="text-body font-medium text-fg">{line.title}</p>
          {line.detail && <p className="mt-0.5 text-[13px] leading-[18px] text-fg-muted">{line.detail}</p>}
          {line.retry && onRetry && (
            <div className="mt-3">
              <Button
                variant="outline"
                size="sm"
                aria-disabled={busy ? true : undefined}
                onClick={() => {
                  if (!busy) onRetry()
                }}
              >
                {busy ? 'Trying again…' : 'Retry'}
              </Button>
            </div>
          )}
        </>
      )}
    </div>
  )
}
