/**
 * #/live-preview: the onboarding swap and position previews (#38), for
 * invited testers, in the consumer-test build only. Sign-in is the header's
 * wallet control (#14); this screen reads the session through the port and
 * sends a preview only when the user presses Get preview. It is not part of
 * the practice flow: practice numbers never prefill it (NF-9).
 */
import { useEffect, useId, useMemo, useState, useSyncExternalStore, type KeyboardEvent } from 'react'
import { realClock } from '../lib/clock'
import { livePort } from '../session/livePort'
import { broadcastBudgetChannel, createPreviewBudget } from '../onboarding/budget'
import { consumerTestCatalog } from '../onboarding/catalog'
import { createOnboardingClient } from '../onboarding/client'
import { ONBOARDING_RUNTIME } from '../onboarding/contract'
import type { PreviewDeps } from '../onboarding/controller'
import { useSwapPreview, usePositionPreview } from '../onboarding/hooks'
import { buildPositionRequest, buildSwapRequest, type PositionForm, type SwapForm } from '../onboarding/inputs'
import { ConsumerBoundary } from '../components/consumer/shared'
import { PositionFormFields, SwapFormFields } from '../components/preview/PreviewForms'
import { PreviewResult } from '../components/preview/PreviewPanels'
import { Card, Display, Eyebrow, Pill, cx } from '../components/ui'

const SWAP_DEFAULT: SwapForm = {
  tokenIn: '0x1111111111111111111111111111111111111111',
  tokenOut: '0x2222222222222222222222222222222222222222',
  amountRaw: '1000',
  slippageBps: '50',
  maxPriceImpactBps: '100',
}

const POSITION_DEFAULT: PositionForm = {
  poolId: '0x25431634fd7de72516ccb751020a1a9188376a983ccc5f6c1152ca04a6acffad',
  independent: '0',
  amountRaw: '100',
  tickLower: '-120',
  tickUpper: '180',
  slippageBps: '50',
  budget0Raw: '110',
  budget1Raw: '220',
  nativeBalanceRaw: '1000',
  nativeGasReserveRaw: '300',
}

function SwapTab({ deps }: { deps: PreviewDeps }) {
  const [form, setForm] = useState(SWAP_DEFAULT)
  const built = useMemo(() => buildSwapRequest(form, consumerTestCatalog), [form])
  const { view, request } = useSwapPreview(deps, built)
  return (
    <>
      <SwapFormFields form={form} onChange={setForm} issues={built.ok ? [] : built.issues} catalog={consumerTestCatalog} />
      {view && <PreviewResult route="swap-preview" view={view} onRequest={request} catalog={consumerTestCatalog} clock={deps.clock} />}
    </>
  )
}

function PositionTab({ deps }: { deps: PreviewDeps }) {
  const [form, setForm] = useState(POSITION_DEFAULT)
  const built = useMemo(() => buildPositionRequest(form, consumerTestCatalog), [form])
  const { view, request } = usePositionPreview(deps, built)
  return (
    <>
      <PositionFormFields form={form} onChange={setForm} issues={built.ok ? [] : built.issues} catalog={consumerTestCatalog} />
      {view && <PreviewResult route="position-preview" view={view} onRequest={request} catalog={consumerTestCatalog} clock={deps.clock} />}
    </>
  )
}

const TABS = [
  { id: 'swap', label: 'Swap' },
  { id: 'position', label: 'Position' },
] as const
type TabId = (typeof TABS)[number]['id']

function SessionLine() {
  const session = useSyncExternalStore(livePort.subscribe, livePort.getSnapshot)
  return (
    <p className="mt-3 text-[13px] text-fg-muted" data-session={session.kind}>
      {session.kind === 'signed_in' ? (
        <>
          <Pill tone="in">Signed in</Pill> <span className="font-mono">{session.owner}</span>. Previews are private to this session and are cleared when it changes.
        </>
      ) : (
        'Sign in with the wallet control in the header to request a preview.'
      )}
    </p>
  )
}

export default function LivePreview() {
  // One client and budget per visit to the screen. The budget hears other
  // tabs' cooldowns only while the screen is mounted.
  const deps = useMemo<PreviewDeps>(
    () => ({
      client: createOnboardingClient({ fetch: (input, init) => window.fetch(input, init), runtime: ONBOARDING_RUNTIME, clock: realClock }),
      port: livePort,
      clock: realClock,
      budget: createPreviewBudget({ clock: realClock, channel: broadcastBudgetChannel() }),
    }),
    [],
  )
  useEffect(() => deps.budget.connect(), [deps])
  const [tab, setTab] = useState<TabId>('swap')
  const base = useId()

  const onKey = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return
    event.preventDefault()
    const next = tab === 'swap' ? 'position' : 'swap'
    setTab(next)
    document.getElementById(`${base}-tab-${next}`)?.focus()
  }

  return (
    <ConsumerBoundary>
      <main className="mx-auto max-w-[1220px] px-5 pb-24 pt-8">
        <Eyebrow>Invited testers · consumer-test build</Eyebrow>
        <Display as="h1" className="mt-2 text-[40px]">
          Live preview
        </Display>
        <p className="mt-3 max-w-[70ch] text-[14px] text-fg-muted">
          Estimates from the onboarding service for your signed-in wallet. A preview is never a transaction, a quote lock or an authorization, and it
          expires 30 seconds after it was requested. Pools and tokens here are the package's synthetic test pools.
        </p>
        <SessionLine />

        <Card className="mt-6 p-5">
          <div role="tablist" aria-label="Preview type" className="inline-flex gap-1 rounded-[var(--radius-pill)] border bg-surface-2 p-1">
            {TABS.map((entry) => (
              <button
                key={entry.id}
                id={`${base}-tab-${entry.id}`}
                role="tab"
                type="button"
                aria-selected={tab === entry.id}
                aria-controls={`${base}-panel`}
                tabIndex={tab === entry.id ? 0 : -1}
                onKeyDown={onKey}
                onClick={() => setTab(entry.id)}
                className={cx(
                  'rounded-[var(--radius-pill)] px-4 py-1.5 text-[13px] transition focus-visible:outline-2 focus-visible:outline-[var(--ring)]',
                  tab === entry.id ? 'bg-surface-3 text-fg' : 'text-fg-muted hover:text-fg',
                )}
              >
                {entry.label}
              </button>
            ))}
          </div>
          <div id={`${base}-panel`} role="tabpanel" aria-labelledby={`${base}-tab-${tab}`} className="mt-5">
            {tab === 'swap' ? <SwapTab key="swap" deps={deps} /> : <PositionTab key="position" deps={deps} />}
          </div>
        </Card>
      </main>
    </ConsumerBoundary>
  )
}
