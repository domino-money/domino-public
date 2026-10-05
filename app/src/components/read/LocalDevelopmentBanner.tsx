import { useEffect, useRef, useState } from 'react'

type Diagnostics = { state: string; frontend?: { commit: string; dirty: boolean | null }; backend?: { readerCommit: string; gatewayCommit: string; contractVersion: string; readEnabled: boolean; readerConnection: { state: string; busy?: boolean }; providerHealth: string }; error?: string }
/** Serve-only component: the deployable constants fold this whole module away. */
export function LocalDevelopmentBanner() {
  const [data, setData] = useState<Diagnostics | null>(null)
  const [busy, setBusy] = useState(false)
  const pending = useRef<AbortController | null>(null)
  useEffect(() => () => pending.current?.abort(), [])
  async function check() {
    if (pending.current) return
    const controller = new AbortController()
    pending.current = controller; setBusy(true)
    const timer = setTimeout(() => controller.abort(), 20_000)
    try {
      const response = await fetch('/api/dev/v1/status', { credentials: 'omit', cache: 'no-store', signal: controller.signal })
      if (!response.headers.get('content-type')?.startsWith('application/json')) throw new Error()
      const value = await response.json() as Diagnostics
      if (!controller.signal.aborted) setData(value)
    } catch { if (pending.current === controller) setData({ state: 'connection_unavailable' }) }
    finally { clearTimeout(timer); if (pending.current === controller) { pending.current = null; setBusy(false) } }
  }
  return (
    <aside aria-label="Development environment" className="border-b bg-money-wait-bg px-5 py-2 text-center text-[0.75rem] text-money-wait">
      <strong>Local real-data development</strong> · Read-only · Wallet sign-in and transactions disabled.
      {' '}<button type="button" className="underline" disabled={busy} onClick={() => void check()}>{busy ? 'Checking…' : 'Check connection'}</button>
      {data && <div role="status" className="mt-1">
        {data.state === 'validated' && data.backend ? <>
          Reader: {data.backend.readerConnection.state}{data.backend.readerConnection.busy ? ' (busy)' : ''} · Reads {data.backend.readEnabled ? 'enabled' : 'disabled'} · Provider health: not probed.
          <details><summary className="cursor-pointer">Development versions</summary>
            <p>Frontend {data.frontend?.commit}{data.frontend?.dirty ? ' · uncommitted edits' : ''}</p>
            <p>Reader {data.backend.readerCommit} · Gateway {data.backend.gatewayCommit}</p>
            <p>Read contract {data.backend.contractVersion} · Backend release metadata is operator-attested, not runtime measured.</p>
          </details>
        </> : data.state === 'access_rejected' ? 'Development access rejected. Ask for dedicated access renewal; do not use a production password.'
          : data.error === 'read_capacity_busy' ? 'Development service busy. Try again manually.'
            : ['upstream_contract_mismatch', 'upstream_invalid_response'].includes(data.error ?? '') ? 'Development response incompatible. Check the agreed backend version.' : 'Development connection unavailable. No replacement data is shown.'}
      </div>}
    </aside>
  )
}
