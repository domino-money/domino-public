/**
 * #/deposits: the deposit consumer's fixture lab (#40/#44), consumer-test
 * build only. Every answer comes from the deposit-v1 package fixtures through
 * the fixture transport; the session is a synthetic one for the fixtures'
 * owner. Nothing here reaches /api/deposit/v1, the real session or a wallet.
 *
 * A wallet step can be reviewed, with the pre-sign checks run against a
 * simulated wallet context, but never handed to a wallet: this build has no
 * wallet handoff (deposit/handoff.ts), and the page has no Send control.
 */
// The screens' own styles (styles/screens.css, F8): loaded with the first screen that needs them, never on Home's first paint.
import '../styles/screens.css'
import { useEffect, useId, useMemo, useState, useSyncExternalStore } from 'react'
import { createDepositClient } from '../deposit/client'
import { DEPOSIT_RUNTIME } from '../deposit/contract'
import { LAB_BANNER, shortHex } from '../deposit/copy'
import { createDepositFlow, type DepositFlow } from '../deposit/flow'
import { DISABLED_WALLET_HANDOFF } from '../deposit/handoff'
import { createMemory, inMemoryBackend, type DepositMemory } from '../deposit/memory'
import { presentOperation, type ActionId } from '../deposit/present'
import { checkPreSign } from '../deposit/presign'
import type { DepositTransport } from '../deposit/transport'
import { LAB_FIXTURES } from '../deposit/fixtures/catalog'
import { createFixtureClock, type FixtureClock } from '../deposit/fixtures/fixtureClock'
import { FIXTURE_CSRF, FIXTURE_OWNER, createFixtureSessionPort, type FixtureSessionPort } from '../deposit/fixtures/fixtureSession'
import { createFixtureTransport, type FixtureTransport } from '../deposit/fixtureTransport'
import { scenarios, type Scenario } from '../deposit/fixtures/scenarios'
import { Callout } from '../components/consumer/shared'
import { ConsumerBoundary } from '../components/consumer/shared'
import { OperationPanel } from '../components/deposit/OperationPanel'
import { Button, Card, Display, Eyebrow, Pill, cx } from '../components/ui'

/** Display time for the lab only: a fixed instant after the fixtures' own timestamps. */
const LAB_WALL_MS = Date.UTC(2027, 0, 15, 0, 5, 0)
const FOREIGN_ACCOUNT = '0x1212121212121212121212121212121212121212'

interface Lab {
  scenario: Scenario
  fixture: FixtureTransport
  session: FixtureSessionPort
  memory: DepositMemory
  clock: FixtureClock
  flow: DepositFlow
}

function makeLab(scenario: Scenario): Lab {
  const fixture = createFixtureTransport({ csrf: FIXTURE_CSRF })
  scenario.script(fixture)
  // The "live transport kind" scenario: the flow believes it talks to the
  // service, with no wallet handoff. It still only reaches the fixtures.
  const transport: DepositTransport = scenario.transportKind === 'http' ? { kind: 'http', send: (route, body, options) => fixture.send(route, body, options) } : fixture
  const session = createFixtureSessionPort()
  const memory = createMemory(inMemoryBackend())
  if (scenario.remembered) memory.remember(scenario.remembered)
  const clock = createFixtureClock({ wallMs: LAB_WALL_MS })
  const client = createDepositClient({ transport, runtime: DEPOSIT_RUNTIME, session })
  const flow = createDepositFlow({ client, session, memory, clock, handoff: DISABLED_WALLET_HANDOFF })
  return { scenario, fixture, session, memory, clock, flow }
}


const STATE_LABEL: Readonly<Record<string, string>> = {
  draft: 'Draft',
  awaiting_wallet: 'Awaiting wallet',
  pending: 'Pending',
  confirmed: 'Confirmed',
  reverted: 'Reverted',
  cancel_requested: 'Cancellation requested',
  cancelled: 'Cancelled',
  attention: 'Needs attention',
  superseded: 'Superseded',
}

function LabView({ lab }: { lab: Lab }) {
  const { flow, fixture, clock, session } = lab
  const state = useSyncExternalStore(flow.subscribe, flow.getState)
  const [chainId, setChainId] = useState(4663)
  const [account, setAccount] = useState<string>(FIXTURE_OWNER)
  const [handoffClock, setHandoffClock] = useState<'fresh' | 'expired'>('fresh')
  const [acknowledged, setAcknowledged] = useState(false)
  const contextId = useId()
  const current = state.current

  // The simulated handoff clock: 5 s after the prepare was sent, or just past
  // the handoff's own window. Only the lab's view of "now" moves; the flow and
  // the device clock are untouched.
  const last = current?.op.history.at(-1)
  const life = last ? last.expiresAt - last.issuedAt : 30
  const monoNow =
    current && current.prepareSentMono !== null ? current.prepareSentMono + (handoffClock === 'fresh' ? 5_000 : (life + 1) * 1000) : clock.monoMs()

  useEffect(() => {
    if (!__DOMINO_TEST_HOOKS__) return
    Object.defineProperty(window, '__dominoDepositProbe', {
      configurable: true,
      value: Object.freeze({
        calls: () => fixture.calls().map((call) => ({ route: call.route, body: call.body })),
        unscripted: () => [...fixture.unscripted()],
        denials: () => [...session.denials()],
        handoffAvailable: () => DISABLED_WALLET_HANDOFF.available,
        remembered: () => lab.memory.lastOperationId(),
        walletStep: () => (flow.getState().current?.walletStep ? JSON.stringify(flow.getState().current?.walletStep) : null),
      }),
    })
  }, [fixture, flow, lab, session])

  const view = current
    ? presentOperation(current.op, current.walletStep, {
        monoNowMs: monoNow,
        walletStepDeadlineMono: current.walletStepDeadlineMono,
        issueWalletStepAllowed: flow.issueWalletStepAllowed,
        latched: Boolean(state.latched[current.op.id]),
        busy: state.busy !== null,
      })
    : null
  const preSign =
    current && view?.step
      ? checkPreSign({
          response: current.prepareResponse,
          runtime: DEPOSIT_RUNTIME,
          sessionOwner: FIXTURE_OWNER,
          wallet: { chainId, account },
          monoNowMs: monoNow,
          walletStepDeadlineMono: current.walletStepDeadlineMono,
          summaryAcknowledged: acknowledged,
          handoff: DISABLED_WALLET_HANDOFF,
        }).rows
      : null

  const onAction = (id: ActionId, hash?: string) => {
    const action = id === 'check_allowances' ? 'allowances' : id
    flow.dispatch({ t: 'user', action, ...(hash !== undefined ? { hash } : {}) })
  }

  return (
    <div className="mt-6 grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
      <div className="space-y-4">
        <Card className="p-4">
          <h2 className="text-[0.875rem] font-medium">Simulated wallet context</h2>
          <p className="mt-1 text-[0.75rem] text-fg-muted">Injected into the pre-sign checks only. No wallet is connected.</p>
          <div className="mt-3 grid gap-3 text-[0.8125rem]">
            <label>
              <span className="text-fg-muted">Wallet network</span>
              <select id={`${contextId}-chain`} className="mt-1 block w-full rounded-[var(--radius)] border bg-surface-1 px-2 py-1.5" value={chainId} onChange={(event) => setChainId(event.target.value === '1' ? 1 : 4663)}>
                <option value="4663">Robinhood Chain (4663)</option>
                <option value="1">Ethereum mainnet (1)</option>
              </select>
            </label>
            <label>
              <span className="text-fg-muted">Wallet account</span>
              <select className="mt-1 block w-full rounded-[var(--radius)] border bg-surface-1 px-2 py-1.5 font-mono text-[0.75rem]" value={account} onChange={(event) => setAccount(event.target.value)}>
                <option value={FIXTURE_OWNER}>{FIXTURE_OWNER} (fixture owner)</option>
                <option value={FOREIGN_ACCOUNT}>{FOREIGN_ACCOUNT} (another account)</option>
              </select>
            </label>
            <label>
              <span className="text-fg-muted">Handoff clock</span>
              <select className="mt-1 block w-full rounded-[var(--radius)] border bg-surface-1 px-2 py-1.5" value={handoffClock} onChange={(event) => setHandoffClock(event.target.value === 'expired' ? 'expired' : 'fresh')}>
                <option value="fresh">Fresh (5 s after the prepare)</option>
                <option value="expired">Expired (past the handoff window)</option>
              </select>
            </label>
          </div>
        </Card>

        <Card className="p-4">
          <h2 className="text-[0.875rem] font-medium">Your deposits (fixture)</h2>
          {state.phase === 'booting' && <p className="mt-2 text-[0.8125rem] text-fg-muted">Loading…</p>}
          {state.items.length === 0 && state.phase === 'ready' && <p className="mt-2 text-[0.8125rem] text-fg-muted">Nothing listed.</p>}
          <ul className="mt-2 space-y-1" aria-label="Deposits">
            {state.items.map((item) => (
              <li key={item.id}>
                <button
                  type="button"
                  onClick={() => flow.dispatch({ t: 'user', action: 'open', id: item.id })}
                  className={cx(
                    'w-full rounded-[var(--radius)] border px-3 py-2 text-left text-[0.8125rem] hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-[var(--ring)]',
                    current?.op.id === item.id && 'bg-surface-2',
                  )}
                  aria-label={`Open deposit ${item.id}: ${STATE_LABEL[item.state] ?? item.state}`}
                >
                  <span className="font-mono">{shortHex(item.id)}</span> · {STATE_LABEL[item.state] ?? item.state}
                  {item.outstanding && (
                    <>
                      {' '}
                      <Pill tone="wait">Reserved slot</Pill>
                    </>
                  )}
                </button>
              </li>
            ))}
          </ul>
          {state.hasMore && (
            <Button variant="outline" className="mt-2" disabled={state.busy !== null} onClick={() => flow.dispatch({ t: 'user', action: 'load_more' })}>
              Load more
            </Button>
          )}
        </Card>

        <Card className="p-4">
          <h2 className="text-[0.875rem] font-medium">What the lab sent</h2>
          <p className="mt-1 text-[0.75rem] text-fg-muted">Every request, in order, to the fixture transport. Nothing else leaves this page.</p>
          <ol className="mt-2 list-decimal pl-5 font-mono text-[0.75rem]" data-testid="request-log">
            {fixture.calls().map((call, index) => (
              <li key={index}>{call.route}</li>
            ))}
          </ol>
        </Card>
      </div>

      <div className="space-y-4">
        {state.notice && (
          <Callout tone="out" role="status" testId="deposit-notice">
            {state.notice.text}
          </Callout>
        )}
        {state.blockerId && (
          <Button variant="outline" onClick={() => flow.dispatch({ t: 'user', action: 'open', id: state.blockerId ?? undefined })}>
            Open the deposit that blocks this one
          </Button>
        )}
        {lab.scenario.labAction && current && (
          <Button variant="outline" disabled={state.busy !== null} onClick={() => flow.dispatch({ t: 'user', action: lab.scenario.labAction?.action ?? 'allowances' })}>
            Lab: {lab.scenario.labAction.label}
          </Button>
        )}
        {current && view ? (
          <OperationPanel
            op={current.op}
            view={view}
            onAction={onAction}
            preSign={preSign}
            summaryAcknowledged={acknowledged}
            onAcknowledge={setAcknowledged}
            allowances={current.allowances}
          />
        ) : (
          state.phase === 'ready' && <p className="text-[0.8125rem] text-fg-muted">No deposit is open.</p>
        )}
      </div>
    </div>
  )
}

export default function Deposits() {
  const all = useMemo(() => scenarios(LAB_FIXTURES), [])
  const [scenarioId, setScenarioId] = useState(all[0].id)
  const scenario = all.find((entry) => entry.id === scenarioId) ?? all[0]
  const groups = useMemo(() => [...new Set(all.map((entry) => entry.group))], [all])
  // One lab per scenario: its own transport, memory, clock and flow.
  const lab = useMemo(() => makeLab(scenario), [scenario])
  useEffect(() => lab.flow.start(), [lab])
  return (
    <ConsumerBoundary>
      <main className="mx-auto max-w-[76.25rem] px-5 pb-24 pt-8" data-fixture="deposit-v1">
        <Callout tone="wait" role="note" testId="fixture-banner">
          <span className="font-medium">{LAB_BANNER}</span>
        </Callout>
        <Eyebrow className="mt-6">Deposit consumer · fixture lab</Eyebrow>
        <Display as="h1" className="mt-2 text-[2.5rem]">
          Deposits
        </Display>
        <p className="mt-3 max-w-[75ch] text-[0.875rem] text-fg-muted">
          How the app will show direct deposits (deposit-v1 1.1.0-rc.4): recovery, nonce conflicts, exceeded limits, Nitro gas and the evidence behind
          received amounts. Wallet steps can be reviewed here but never sent: this build has no wallet handoff.
        </p>
        <div className="mt-5 flex flex-wrap items-end gap-3">
          <label className="text-[0.8125rem]">
            <span className="text-fg-muted">Scenario</span>
            <select
              className="mt-1 block min-w-[20rem] rounded-[var(--radius)] border bg-surface-1 px-3 py-2 text-[0.8125rem]"
              value={scenario.id}
              onChange={(event) => setScenarioId(event.target.value)}
            >
              {groups.map((group) => (
                <optgroup key={group} label={group}>
                  {all
                    .filter((entry) => entry.group === group)
                    .map((entry) => (
                      <option key={entry.id} value={entry.id}>
                        {entry.label}
                      </option>
                    ))}
                </optgroup>
              ))}
            </select>
          </label>
        </div>
        <p className="mt-2 max-w-[75ch] text-[0.75rem] text-fg-subtle" data-testid="scenario-description">
          {scenario.description}
        </p>
        <LabView key={scenario.id} lab={lab} />
      </main>
    </ConsumerBoundary>
  )
}
