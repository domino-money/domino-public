import { useEffect, useRef, useState } from 'react'
import { MarketsTable } from '../components/MarketsTable'
import { BuildBanner } from '../components/read/BuildBanner'
import { ChainSelectionPanel } from '../components/read/screens'
import type { PickerChrome } from '../lib/read/screens/pickerChrome'
import { useDialog } from '../lib/useDialog'
import { Button, Display } from '../components/ui'
import { READ_RUNTIME } from '../lib/read/contract'
import { FIXTURE_CATALOG } from '../lib/read/fixtureCatalog'
import { createFixtureSource, type ReplyScript, type RouteScript } from '../lib/read/fixtureSource'
import type { MarketsProvider } from '../lib/read/marketsProvider'
import { FIXTURE_POOL, FIXTURE_TOKEN, MARKET_CASES, MUTATED_CURSOR, NATIVE, errorFixture, gateway, withCursor, withNextCataloguePage } from '../lib/read/scenarios'
import { createScheduledSource } from '../lib/read/scheduler'
import { createAppMarketsProvider } from '../lib/read/screens/appMarkets'
import { sqrtPriceAtTick } from '../lib/read/screens/poolRange'
import { FIXTURE_OWNER } from '../lib/read/screens/appScript'
import { readWithin, type ScreenOutcome } from '../lib/read/screens/screenRead'
import { failureText } from '../lib/read/screens/copy'
import { withDelays, type Delay, type DelayedSource } from '../lib/read/screens/delayedSource'
import { ReadSourceProvider } from '../lib/read/screens/readContext'
import type { ReadRoute, ReadSource } from '../lib/read/types'
import { MarketsContext } from '../lib/read/useMarkets'

/**
 * The read screens' lab: one case per page, `read-lab.html#screens/<id>`,
 * each with its own scheduled fixture source, mounting the real components
 * (the Dashboard lookup section, the real create dialog, the real Top pools
 * table). Only which fixture answers, and when, is scripted. For
 * tests/read-screens.browser.test.mjs and for a look by hand.
 */

type Json = Record<string, unknown>
const obj = (v: unknown) => v as Json

const at = (digit: string) => `0x${digit.repeat(40)}`
export const ADDRESSES = {
  hostile: at('2'),
  noContract: at('4'),
  unreadable: at('5'),
  gasLimit: at('6'),
  weth: at('7'),
  partialUpper: `0x${'A'.repeat(40)}`,
}

const withAsset = (patch: Json) => (body: unknown) => {
  Object.assign(obj(obj(body).asset), patch)
  return body
}

const BASE_TOKENS: ReplyScript[] = [
  { fixture: gateway('token.native'), expectRequest: { token: NATIVE } },
  { fixture: gateway('token.success'), expectRequest: { token: FIXTURE_TOKEN } },
]

const PICKER_TOKENS: ReplyScript[] = [
  ...BASE_TOKENS,
  { fixture: gateway('token.untrusted-symbol'), mutate: withAsset({ address: ADDRESSES.hostile }), expectRequest: { token: ADDRESSES.hostile } },
  { fixture: gateway('token.missing-contract'), mutate: withAsset({ address: ADDRESSES.noContract }), expectRequest: { token: ADDRESSES.noContract } },
  { fixture: gateway('token.unavailable'), mutate: withAsset({ address: ADDRESSES.unreadable }), expectRequest: { token: ADDRESSES.unreadable } },
  { fixture: gateway('token.call-gas-limit'), mutate: withAsset({ address: ADDRESSES.gasLimit }), expectRequest: { token: ADDRESSES.gasLimit } },
  { fixture: gateway('token.success'), mutate: withAsset({ address: ADDRESSES.weth, symbol: 'WETH', decimals: 18 }), expectRequest: { token: ADDRESSES.weth } },
  { fixture: gateway('token.missing-decimals'), mutate: withAsset({ address: ADDRESSES.partialUpper.toLowerCase() }), expectRequest: { token: ADDRESSES.partialUpper } },
]

const WALLET = { wallet: FIXTURE_OWNER, autoDiscover: true }
const WALLET_MORE = { ...WALLET, cursor: MUTATED_CURSOR }
const firstPage: ReplyScript = { fixture: gateway('wallet-assets.opaque-page'), mutate: withCursor(MUTATED_CURSOR), expectRequest: WALLET }
const expired: ReplyScript = { fixture: errorFixture('wallet-assets.invalid_or_expired_cursor'), expectRequest: WALLET_MORE }

const withoutItems = (body: unknown) => {
  obj(body).items = []
  return body
}

/** The echo still names the chosen token, but the pool now holds 0x0000… and 0x4444…, not the token. */
const foreignPool = (body: unknown) => {
  for (const pool of obj(body).pools as Json[]) obj(pool.poolKey).currency1 = ADDRESSES.noContract
  return body
}

/** The pool's tick moved to 5000 while its square-root price still says tick 0: the two disagree. */
const tickMismatch = (body: unknown) => {
  for (const pool of obj(body).pools as Json[]) pool.tick = 5000
  return body
}
/** The token's symbol could not be read; its decimals could. */
const symbolUnread = (body: unknown) => {
  for (const pool of obj(body).pools as Json[]) pool.tokenMetadataStatus = 'partial'
  for (const token of obj(body).tokens as Json[]) {
    if (token.address !== FIXTURE_TOKEN) continue
    token.symbol = null
    token.readStatus = 'partial'
    token.metadataIssues = { symbol: 'invalid_symbol_text' }
  }
  return body
}
/** The same pool read again, a few blocks later, its price moved up one tick spacing (tick 60, and the square-root price of tick 60). */
const laterBlock = (body: unknown) => {
  obj(obj(body).snapshot).number = 705
  for (const pool of obj(body).pools as Json[]) {
    obj(pool.snapshot).number = 705
    pool.tick = 60
    pool.sqrtPriceX96 = sqrtPriceAtTick(60).toString()
  }
  return body
}
const otherChain = (body: unknown) => {
  obj(body).chainId = 1
  return body
}

const TOKEN_POOLS = { token: FIXTURE_TOKEN }
const VERIFY = { token: FIXTURE_TOKEN, maxPools: 1, poolIds: [FIXTURE_POOL] }
const CATALOGUE = { token: FIXTURE_TOKEN, limit: 20 }
const CATALOGUE_NEXT = { ...CATALOGUE, afterPoolId: FIXTURE_POOL, revision: 2 }

export interface ScreenCase {
  id: string
  kind: 'create' | 'figures' | 'flood' | 'budget'
  script: RouteScript
  delay?: (route: ReadRoute, request: unknown, n: number) => Delay | undefined
  /** The per-read budget of the Top pools reads; the app's is 60 s. */
  budgetMs?: number
}


const marketScript = (id: string, activity: ReplyScript): RouteScript => ({ ...MARKET_CASES.find((c) => c.id === id)?.script, 'pool-activity': [activity] })

/** The same pool-market answers, each with the pool's key turned into the v4 dynamic-fee sentinel. */
const withDynamicMarket = (script: RouteScript): RouteScript => ({
  ...script,
  'pool-market': (script['pool-market'] ?? []).map((reply) => ({
    ...reply,
    mutate: (body: unknown) => {
      const next = reply.mutate ? reply.mutate(body) : body
      const key = obj(obj(obj(next).pool).poolKey)
      key.feeMode = 'dynamic'
      key.fee_pips = 8388608
      return next
    },
  })),
})

export const SCREEN_CASES: ScreenCase[] = [
  // 2026-09-24: the nft.* cases went with the lookup by typed NFT ids; Positions lists the wallet's own from chain.
  { id: 'create.tokens', kind: 'create', script: { token: PICKER_TOKENS, 'wallet-assets': [firstPage, { fixture: gateway('wallet-assets.last-page'), expectRequest: WALLET_MORE }] } },
  { id: 'create.walletRestart', kind: 'create', script: { token: PICKER_TOKENS, 'wallet-assets': [firstPage, expired] } },
  { id: 'create.walletRestartTwice', kind: 'create', script: { token: PICKER_TOKENS, 'wallet-assets': [firstPage, expired, expired] } },
  { id: 'create.walletCap', kind: 'create', script: { token: PICKER_TOKENS, 'wallet-assets': [firstPage, { fixture: gateway('wallet-assets.opaque-page'), mutate: withCursor(MUTATED_CURSOR), expectRequest: WALLET_MORE }] } },
  { id: 'create.walletEmpty', kind: 'create', script: { token: PICKER_TOKENS, 'wallet-assets': [{ fixture: gateway('wallet-assets.fallback'), mutate: withoutItems, expectRequest: WALLET }] } },
  { id: 'create.walletZero', kind: 'create', script: { token: PICKER_TOKENS, 'wallet-assets': [{ fixture: gateway('wallet-assets.zero'), expectRequest: WALLET }] } },
  {
    id: 'create.pools',
    kind: 'create',
    script: {
      token: PICKER_TOKENS,
      pools: [
        { fixture: gateway('pools.success'), expectRequest: TOKEN_POOLS },
        { fixture: gateway('pools.catalogue'), expectRequest: VERIFY },
      ],
      catalogue: [
        { fixture: gateway('catalogue.success'), mutate: withNextCataloguePage, expectRequest: CATALOGUE },
        { fixture: errorFixture('pools.catalogue_revision_changed'), expectRequest: CATALOGUE_NEXT },
      ],
    },
  },
  {
    id: 'create.range',
    kind: 'create',
    script: {
      token: PICKER_TOKENS,
      pools: [
        { fixture: gateway('pools.success'), expectRequest: TOKEN_POOLS },
        { fixture: gateway('pools.catalogue'), mutate: laterBlock, expectRequest: VERIFY },
      ],
    },
  },
  { id: 'create.rangeNoDecimals', kind: 'create', script: { token: PICKER_TOKENS, pools: [{ fixture: gateway('pools.partial-metadata'), expectRequest: TOKEN_POOLS }] } },
  { id: 'create.rangeMismatch', kind: 'create', script: { token: PICKER_TOKENS, pools: [{ fixture: gateway('pools.success'), mutate: tickMismatch, expectRequest: TOKEN_POOLS }] } },
  { id: 'create.rangePartial', kind: 'create', script: { token: PICKER_TOKENS, pools: [{ fixture: gateway('pools.success'), mutate: symbolUnread, expectRequest: TOKEN_POOLS }] } },
  { id: 'create.walletOtherChain', kind: 'create', script: { token: PICKER_TOKENS, 'wallet-assets': [{ fixture: gateway('wallet-assets.opaque-page'), mutate: otherChain, expectRequest: WALLET }] } },
  { id: 'create.poolsForeign', kind: 'create', script: { token: PICKER_TOKENS, pools: [{ fixture: gateway('pools.success'), mutate: foreignPool, expectRequest: TOKEN_POOLS }] } },
  { id: 'create.poolsRejected', kind: 'create', script: { token: PICKER_TOKENS, pools: [{ fixture: gateway('pools.rejected-candidate'), expectRequest: TOKEN_POOLS }] } },
  { id: 'create.poolsProviderUnavailable', kind: 'create', script: { token: PICKER_TOKENS, pools: [{ fixture: gateway('pools.provider-unavailable'), expectRequest: TOKEN_POOLS }] } },
  { id: 'create.poolsMissing', kind: 'create', script: { token: PICKER_TOKENS, pools: [{ fixture: gateway('pools.missing'), expectRequest: TOKEN_POOLS }] } },
  { id: 'create.pools409', kind: 'create', script: { token: PICKER_TOKENS, pools: [{ fixture: errorFixture('pools.catalogue_revision_changed') }, { fixture: gateway('pools.catalogue') }] } },

  { id: 'figures.provider', kind: 'figures', script: marketScript('provider', { fixture: gateway('pool-activity.partial') }) },
  { id: 'figures.qualified', kind: 'figures', script: marketScript('qualified', { fixture: gateway('pool-activity.success') }) },
  { id: 'figures.reference', kind: 'figures', script: marketScript('reference', { fixture: gateway('pool-activity.partial') }) },
  { id: 'figures.stale', kind: 'figures', script: marketScript('stale', { fixture: gateway('pool-activity.stale') }) },
  { id: 'figures.expired', kind: 'figures', script: marketScript('expired', { fixture: gateway('pool-activity.partial') }) },
  { id: 'figures.missing', kind: 'figures', script: marketScript('missing', { fixture: gateway('pool-activity.partial') }) },
  { id: 'figures.zero', kind: 'figures', script: marketScript('zero', { fixture: gateway('pool-activity.partial') }) },
  { id: 'figures.activityUnavailable', kind: 'figures', script: marketScript('provider', { fixture: errorFixture('pool-activity.upstream_unavailable') }) },
  { id: 'figures.dynamicFee', kind: 'figures', script: withDynamicMarket(marketScript('provider', { fixture: gateway('pool-activity.partial') })) },
  // A pool-market read that never answers, under a 400 ms budget instead of the app's 60 s.
  { id: 'figures.budget', kind: 'figures', script: marketScript('provider', { fixture: gateway('pool-activity.partial') }), delay: (route) => (route === 'pool-market' ? { hang: true } : undefined), budgetMs: 400 },
  // markets-snapshot listed: the stored row first; a store served 400 s after it was filled is read again on demand.
  { id: 'figures.snapshot', kind: 'figures', script: marketScript('snapshot-current', { fixture: gateway('pool-activity.partial') }) },
  { id: 'figures.snapshotStale', kind: 'figures', script: marketScript('snapshot-stale-entry', { fixture: gateway('pool-activity.partial') }) },

  { id: 'local.flood', kind: 'flood', script: { token: BASE_TOKENS }, delay: () => ({ hang: true }) },
  { id: 'local.budget', kind: 'budget', script: { token: BASE_TOKENS }, delay: () => ({ hang: true }) },
]

/** Thirteen distinct reads that never answer: the thirteenth is refused by the queue, not sent. */
function Flood({ source }: { source: ReadSource }) {
  const [text, setText] = useState('')
  useEffect(() => {
    const controller = new AbortController()
    for (let i = 0; i < 13; i++) {
      const token = `0x${(i + 1).toString(16).padStart(40, '0')}`
      void readWithin(source, 'token', { token }, { signal: controller.signal }).then((outcome) => {
        if (outcome.state !== 'aborted') setText(failureText(outcome as Exclude<ScreenOutcome<'token'>, { state: 'ok' | 'aborted' }>, 'token').detail)
      })
    }
    return () => controller.abort()
  }, [source])
  return <p data-flood-result="">{text}</p>
}

/** One read that never answers, under a 400 ms budget instead of 60 s. */
function Budget({ source }: { source: ReadSource }) {
  const [text, setText] = useState('')
  useEffect(() => {
    const controller = new AbortController()
    void readWithin(source, 'token', { token: FIXTURE_TOKEN }, { signal: controller.signal, budgetMs: 400 }).then((outcome) => {
      if (outcome.state !== 'aborted' && outcome.state !== 'ok') setText(failureText(outcome, 'token').detail)
    })
    return () => controller.abort()
  }, [source])
  return <p data-budget-result="">{text}</p>
}

/**
 * The dialog the chain-selection panel lives in, for the lab only.
 *
 * #72's create flow is the frame in the app; here the lab supplies the
 * smallest shell that panel needs — a heading that takes focus on every view
 * change, and Back and Next from the chrome the panel hands up. Nothing of
 * the retired local workspace is involved: no draft, no card, no book.
 */
function SelectionDialog({ onClose }: { onClose: () => void }) {
  const [chrome, setChrome] = useState<PickerChrome | null>(null)
  const container = useDialog(true, onClose)
  const heading = useRef<HTMLHeadingElement>(null)
  const focusKey = chrome?.focusKey ?? 'pair'
  useEffect(() => {
    const id = setTimeout(() => heading.current?.focus(), 0)
    return () => clearTimeout(id)
  }, [focusKey])
  return (
    // useDialog already closes on Escape and on a click outside, so the
    // backdrop carries no handler of its own: it is only the dimmed ground.
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/50 p-4">
      <div
        ref={container}
        role="dialog"
        aria-modal="true"
        aria-labelledby="step-dialog-title"
        className="max-h-[90vh] w-full max-w-[45rem] overflow-auto rounded-[1.5rem] border bg-surface-1 p-6"
      >
        <Display as="h2" id="step-dialog-title" ref={heading} tabIndex={-1} className="text-[1.4375rem] outline-none">
          {chrome ? chrome.title : 'Start with a token you know.'}
        </Display>
        {chrome && <p className="mt-1 text-[0.8125rem] text-fg-muted">{chrome.description}</p>}
        <div className="mt-4">
          <ChainSelectionPanel onChrome={setChrome} />
        </div>
        {chrome && (
          <div className="mt-5 flex items-center justify-between gap-3 border-t pt-4">
            <Button variant="ghost" onClick={chrome.onBack}>
              {chrome.backLabel}
            </Button>
            <Button onClick={chrome.onNext} aria-disabled={chrome.nextDisabled || undefined} disabled={chrome.nextDisabled}>
              {chrome.nextLabel}
            </Button>
          </div>
        )}
        {chrome?.error && (
          <p role="alert" className="mt-3 text-[0.8125rem]" style={{ color: 'var(--money-out)' }}>
            {chrome.error}
          </p>
        )}
      </div>
    </div>
  )
}

function CreateCase() {
  const [open, setOpen] = useState(false)
  return (
    <>
      <Button onClick={() => setOpen(true)}>New position</Button>
      {open && <SelectionDialog onClose={() => setOpen(false)} />}
    </>
  )
}

function CaseView({ scenario }: { scenario: ScreenCase }) {
  const [setup] = useState(() => {
    const fixture = createFixtureSource({ catalog: FIXTURE_CATALOG, validators: READ_RUNTIME, script: scenario.script })
    const logged: DelayedSource = withDelays(fixture, scenario.delay ?? (() => undefined))
    const source = createScheduledSource(logged, { minIntervalMs: 20 })
    ;(window as unknown as { __screenCase: unknown }).__screenCase = { id: scenario.id, log: logged.log }
    const markets: MarketsProvider | null = scenario.kind === 'figures' ? createAppMarketsProvider({ source, poolIds: [FIXTURE_POOL], kind: 'fixture', budgetMs: scenario.budgetMs }) : null
    return { source, markets }
  })
  const body =
    scenario.kind === 'create' ? (
      <CreateCase />
    ) : scenario.kind === 'figures' && setup.markets ? (
      <MarketsContext.Provider value={setup.markets}>
        <MarketsTable diagnostics />
      </MarketsContext.Provider>
    ) : scenario.kind === 'flood' ? (
      <Flood source={setup.source} />
    ) : (
      <Budget source={setup.source} />
    )
  return (
    <ReadSourceProvider source={setup.source}>
      <section data-screen-case={scenario.id} className="mx-auto max-w-[68.75rem] px-5 py-8">
        <Display as="h1" className="text-[1.75rem]">
          {scenario.id}
        </Display>
        <div className="mt-4">{body}</div>
      </section>
    </ReadSourceProvider>
  )
}

export function ScreensLab({ caseId }: { caseId: string }) {
  const scenario = SCREEN_CASES.find((c) => c.id === caseId)
  return (
    <>
      <BuildBanner mode="fixture" />
      {scenario ? (
        <CaseView scenario={scenario} />
      ) : (
        <main className="mx-auto max-w-[68.75rem] px-5 py-10">
          <Display as="h1" className="text-[2rem]">
            Read screens lab
          </Display>
          <p className="mt-2 text-[0.875rem] text-fg-muted">Open read-lab.html#screens/&lt;case&gt; for one of:</p>
          <ul className="mt-3 grid gap-1 font-mono text-[0.8125rem]">
            {SCREEN_CASES.map((c) => (
              <li key={c.id}>{c.id}</li>
            ))}
          </ul>
        </main>
      )}
    </>
  )
}
