import { useEffect, useState } from 'react'

/** Keep routine background reads quiet; explain a sustained delay once per section. */
export function DataFreshness({ active, scope, detail, children }: {
  active: boolean
  scope: string
  detail?: string
  children?: string
}) {
  const [waiting, setWaiting] = useState<string | null>(null)
  useEffect(() => {
    if (!active) return
    const timer = window.setTimeout(() => setWaiting(scope), 15_000)
    return () => { window.clearTimeout(timer); setWaiting(null) }
  }, [active, scope])
  if (!active || waiting !== scope) return null
  return <p className="text-caption text-fg-muted" role="status" data-data-freshness="delayed" title={detail}>
    {children ?? 'Some figures are taking longer to update. Details shows the last available data.'}
  </p>
}
