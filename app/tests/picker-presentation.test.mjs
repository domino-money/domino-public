import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { test } from 'node:test'
import * as runtime from '../../api-contracts/read-v1/runtime.mjs'

const require = createRequire(import.meta.url)
const React = require('react')
const { renderToStaticMarkup } = require('react-dom/server')
const ts = require('typescript')
const root = resolve(import.meta.dirname, '..')
const cache = new Map()

// Render the actual TSX without emitting files or rebuilding a shared checkout.
// Private row functions are exposed in this test's in-memory module only.
function load(relative, expose = '') {
  const file = resolve(root, relative)
  const key = `${file}:${expose}`
  if (cache.has(key)) return cache.get(key).exports
  const mod = { exports: {} }; cache.set(key, mod)
  const code = ts.transpileModule(readFileSync(file, 'utf8') + (expose ? `\nexport { ${expose} };` : ''), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
  }).outputText
  const local = (name) => {
    if (!name.startsWith('.')) return createRequire(file)(name)
    const path = resolve(dirname(file), name)
    const typed = ['.ts', '.tsx', '/index.ts', '/index.tsx'].map((suffix) => path + suffix).find(existsSync)
    return typed ? load(typed) : createRequire(file)(name)
  }
  new Function('require', 'module', 'exports', code)(local, mod, mod.exports)
  return mod.exports
}
const { CandidateRow, TokenPicker } = load('src/components/read/screens/TokenPicker.tsx', 'CandidateRow')
const { PoolRow } = load('src/components/read/screens/PoolPicker.tsx', 'PoolRow')
const { candidateFromToken } = load('src/lib/read/screens/tokens.ts')
const tokens = load('src/lib/read/screens/tokens.ts')
const { projectPoolsView } = load('src/lib/read/screens/poolsList.ts')
const fixture = (name) => JSON.parse(readFileSync(resolve(root, `../api-contracts/read-v1/fixtures/gateway/${name}.json`), 'utf8'))
const tokenRead = runtime.assertResponse('token', fixture('token.success'))
const candidate = candidateFromToken(tokenRead, tokenRead.asset.address)
const option = projectPoolsView(runtime.assertResponse('pools', fixture('pools.success'))).options[0]
const html = (component, props) => renderToStaticMarkup(React.createElement(component, props))

test('token choice keeps native radio selection, identity details and untrusted symbols as text', () => {
  const hostile = { ...candidate, token: { ...candidate.token, symbol: '<img src=x onerror=alert(1)>' } }
  const rendered = html(CandidateRow, { candidate: hostile, name: 'token', checked: true, onPick() {}, index: 0 })
  assert.match(rendered, /type="radio"/)
  assert.match(rendered, /checked=""/)
  assert.match(rendered, /&lt;img src=x onerror=alert\(1\)&gt;/)
  assert.doesNotMatch(rendered, /<img src="x"/)
  assert.ok(rendered.includes(candidate.key))
  assert.match(rendered, /<details[^>]*><summary[^>]*>Token details/)
  assert.doesNotMatch(rendered, /<details[^>]*\bopen=/)
})

test('unselectable tokens retain a disabled radio and an associated reason', () => {
  const rendered = html(CandidateRow, { candidate: { ...candidate, why: 'no_contract' }, name: 'token', checked: false, onPick() {}, index: 4 })
  assert.match(rendered, /disabled=""/)
  assert.match(rendered, /aria-describedby="token-why-4"/)
  assert.match(rendered, /id="token-why-4"/)
  assert.match(rendered, /no contract at this address/)
})

test('token picker exposes address search and wallet lookup without issuing reads on render', () => {
  let calls = 0
  const rendered = html(TokenPicker, { source: { read() { calls++; throw Error('Unexpected read') } }, variant: 'token', exclude: null, candidates: [candidate], onCandidates() {}, pending: candidate, onPending() {} })
  assert.equal(calls, 0)
  assert.match(rendered, /id="token-address"/)
  assert.match(rendered, /Check address/)
  assert.match(rendered, /List tokens from a public address/)
  assert.match(rendered, /Filter these tokens by address/)
  assert.match(rendered, /About native ETH &amp; wrapped tokens/)
})

test('pool cards preserve real zero, unavailable APR and provider attribution in both layouts', () => {
  for (const compact of [true, false]) {
    const rendered = html(PoolRow, { option: { ...option, volume: { state: 'attributed', value: '$0.00', raw: '0', zero: true, provider: 'dexscreener', retrievedAt: 1000, cacheAgeSeconds: null } }, checked: true, onPick() {}, name: 'pool', compact })
    assert.match(rendered, /\$0\.00/)
    // changed on purpose 2026-10-15 (pack 7, owner: no status notices): attributed by its basis alone, no retrieval time.
    assert.match(rendered, /Reported by a market data provider\. Provider-reported, not reconciled with chain data\./, 'the figure is attributed to a provider')
    assert.doesNotMatch(rendered, /retrieved/)
    assert.doesNotMatch(rendered, /GeckoTerminal|DexScreener/, 'the provider is never named on a screen')
    assert.match(rendered, />TVL</)
    // Changed on purpose (2026-09-20): a pool that genuinely traded nothing earns
    // nothing, and zero is a figure — the producer's own `_render` prints it and
    // refuses only a POSITIVE estimate too small to show. A dash here said "we do
    // not know" about something we do know.
    assert.match(rendered, /data-row-apr="estimate"/)
    assert.match(rendered, />Pool APR<\/span><span class="tnum font-medium text-fg"[^>]*>0\.0% est\./, "a real zero, by the one APR rule (audit E21)")
    assert.doesNotMatch(rendered, /data-row-apr-reason/, 'nothing was refused')
    // The caveat that used to sit under every row, contradicting the figure above
    // it on every pool, is gone for good.
    assert.doesNotMatch(rendered, /Pool APR unavailable/, 'no constant caveat under the details')
    assert.match(rendered, /type="radio"/)
    assert.ok(rendered.includes(option.key))
    assert.match(rendered, /Pool details · verified at block/)
  }
})

// Changed on purpose 2026-10-15 (pack 7, owner: no status notices): a missing or rejected figure is the dash, never the
// words "Not reported" or "Rejected, not shown"; its state stays in `data-provider-figure`.
test('missing and rejected provider figures never become zeroes', () => {
  const rendered = html(PoolRow, { option: { ...option, liquidity: { state: 'not_reported', provider: 'dexscreener' }, volume: { state: 'rejected', provider: 'dexscreener', reason: 'provider_currency_mismatch' } }, checked: false, onPick() {}, name: 'pool', compact: true })
  assert.match(rendered, /data-provider-figure="not_reported"/)
  assert.match(rendered, /data-provider-figure="rejected"/)
  assert.doesNotMatch(rendered, /Not reported|Rejected, not shown/)
  assert.equal((rendered.match(/>—</g) ?? []).length >= 2, true, 'each is a dash')
  assert.doesNotMatch(rendered, /\$0\.00/)
})

test('on Explore a pool row is a way in, not a choice: a button named by its own text, the same figures, no radio, and no attribute built from a symbol', () => {
  const hostile = { ...option, currencies: [{ ...option.currencies[0], symbol: '<img src=x onerror=alert(1)>' }, option.currencies[1]] }
  const rendered = html(PoolRow, { option: hostile, checked: false, onPick() {}, name: 'pool', compact: true, open: true })
  assert.match(rendered, /<button type="button"[^>]*data-open-pool=""/)
  assert.doesNotMatch(rendered, /type="radio"/)
  assert.doesNotMatch(rendered, /aria-label="[^"]*(onerror|img)/, 'the symbol stays text')
  assert.match(rendered, /&lt;img src=x onerror=alert\(1\)&gt;/)
  assert.doesNotMatch(rendered, /<img src="x"/)
  assert.ok(rendered.includes(option.key))
  // changed on purpose 2026-10-15 (pack 7, owner: no status notices): attributed by its basis alone, no retrieval time.
  assert.match(rendered, /Reported by a market data provider\. Provider-reported, not reconciled with chain data\./, 'the figure is attributed to a provider')
  assert.doesNotMatch(rendered, /GeckoTerminal|DexScreener/, 'the provider is never named on a screen')
  // The row works the estimate out from the figures this read already returned: no read per row.
  assert.match(rendered, /data-row-apr="estimate"/)
  assert.match(rendered, />Pool APR<\/span><span class="tnum font-medium text-fg"[^>]*>[\d.,]+% est\./)
})

test('the picker with onOpen and the catalogue left to the page renders no catalogue section and reads nothing on render', () => {
  const { PoolPicker } = load('src/components/read/screens/PoolPicker.tsx')
  let calls = 0
  const rendered = html(PoolPicker, { source: { read() { calls++; throw Error('Unexpected read') } }, token: candidate.key, paired: null, pending: null, onPending() {}, onOpen() {}, catalogue: false, compact: true })
  assert.equal(calls, 0)
  assert.doesNotMatch(rendered, /Stored pool catalogue|Load catalogue candidates/)
  assert.doesNotMatch(rendered, /New pool creation/, 'the compact form carries no new-pool note')
})

// A positive estimate too small for two places is still refused, and still says
// so by name — the row shows a dash only when it truly has nothing to show.
test('an estimate below what two places can show is refused by name, not rounded to zero', () => {
  const tiny = { state: 'attributed', value: '$0.0001', raw: '0.0001', zero: false, provider: 'dexscreener', retrievedAt: 1000, cacheAgeSeconds: null }
  const rendered = html(PoolRow, { option: { ...option, volume: tiny }, checked: false, onPick() {}, name: 'pool', compact: true })
  assert.match(rendered, /data-row-apr="none" data-row-apr-reason="estimate_rounds_to_zero"/)
  assert.match(rendered, />Pool APR<\/span><span class="text-fg-subtle" title="[^"]+">—/)
  assert.doesNotMatch(rendered, /0% est\./, 'a figure too small to show is never printed as a zero')
  assert.doesNotMatch(rendered, /Pool APR unavailable/)
})

// Added 2026-09-20. mergeCandidates keeps one row per TOKEN address, which is
// right — the key is the token everywhere. But a listing for a NEW wallet does
// not mention the tokens the previous wallet held, so those rows stayed on
// screen under the new address, with their balances, their page number and
// old: false. Nothing on a row says which address it came from, so one
// wallet's holdings read as another's, and the picker would carry that choice
// forward into a deposit.
test('a listing for another address does not keep the previous address’s balances', () => {
  const at = (byte) => `0x${byte.toString(16).padStart(2, '0').repeat(20)}`;
  const walletA = at(0xaa), walletB = at(0xbb);
  const row = (address, wallet) => ({ key: address, wire: address, token: { origin: 'read', chainId: 4663, address, symbol: 'T', decimals: 18, readStatus: 'available', artwork: null },
    kind: 'erc20_candidate', why: null, reasonCode: null, decimalsUnavailable: false, source: 'wallet', wallet, balance: null, page: 1, old: false, block: 700 });
  const pasted = { ...row(at(0x11), null), source: 'pasted', wallet: null, page: null };

  const first = [row(at(0x22), walletA), row(at(0x33), walletA), pasted];
  // B holds only one of A's tokens. A's other token must not survive.
  const second = tokens.mergeCandidates(first, [row(at(0x33), walletB)]);
  // Both of A's rows go; the pasted row is not a wallet row and stays; the
  // token both addresses hold comes back fresh, from B's own listing.
  assert.deepEqual(second.map((candidate) => candidate.key), [at(0x11), at(0x33)], 'nothing of A’s listing survives');
  assert.equal(second.find((candidate) => candidate.key === at(0x33)).wallet, walletB, 'the shared token belongs to B now');
  assert.equal(second.some((candidate) => candidate.wallet === walletA), false, 'no row still points at A');

  // Paging the SAME address keeps what earlier pages found.
  const paged = tokens.mergeCandidates(first, [row(at(0x44), walletA)]);
  assert.deepEqual(paged.map((candidate) => candidate.key), [at(0x22), at(0x33), at(0x11), at(0x44)]);
});

// Added 2026-09-21 after the owner asked why the figures never show. They
// mostly cannot: for one token here, eleven of twelve pools a search turns up
// are covered by no market data provider at all, and the read service says so
// (providerMetrics: null, metricsQualified: false). The row spent its whole
// figure strip on three columns each reading "Unavailable", with the reason
// only in a title nobody hovers. It now says it once, in words.
test('a pool no provider covers says so once, instead of three columns saying Unavailable', () => {
  const nothing = { state: 'unavailable', provider: 'dexscreener', reason: 'no_provider_figures' }
  const rendered = html(PoolRow, { option: { ...option, liquidity: nothing, volume: nothing }, checked: false, onPick() {}, name: 'pool', compact: true })
  assert.match(rendered, /data-no-figures=""/)
  assert.match(rendered, /No market figures are reported for this pool\./)
  assert.match(rendered, /still verified on chain, and you can use it/, 'the row says the pool is usable')
  assert.doesNotMatch(rendered, />TVL</, 'no empty TVL column')
  assert.doesNotMatch(rendered, />24h volume</, 'no empty volume column')
  assert.doesNotMatch(rendered, /Unavailable/, 'the word nobody could act on is gone')
})

// But a provider that ANSWERED still keeps its columns: "not reported" and
// "rejected" each say something specific about this pool, unlike "nothing was
// retrieved at all".
test('a provider that answered keeps its columns, whatever it answered', () => {
  const rendered = html(PoolRow, { option: { ...option, liquidity: { state: 'not_reported', provider: 'dexscreener' },
    volume: { state: 'rejected', provider: 'dexscreener', reason: 'provider_currency_mismatch' } }, checked: false, onPick() {}, name: 'pool', compact: true })
  assert.match(rendered, />TVL</)
  assert.match(rendered, />24h volume</)
  assert.doesNotMatch(rendered, /data-no-figures/)
})

// Added 2026-09-24 (owner): New position's pool step lists pools with their TVL, 24h volume and APR on every row,
// and nothing else under the pair — no "Pool details · verified at block N" to open, no line saying no figures are
// reported. A figure nobody reports is a dash, why only in its title and data. Markets keeps its own row, above.
test('New position’s pool row: TVL, 24h volume and APR on every row, a dash for a missing figure, nothing to open and no note', () => {
  const nothing = { state: 'unavailable', provider: 'dexscreener', reason: 'no_provider_figures' }
  const cases = [
    { ...option, liquidity: nothing, volume: nothing },
    { ...option, liquidity: { state: 'not_reported', provider: 'dexscreener' }, volume: { state: 'rejected', provider: 'dexscreener', reason: 'provider_currency_mismatch' } },
    { ...option, tokenMetadata: 'partial', providerConflict: true },
    option,
  ]
  for (const shown of cases) {
    const rendered = html(PoolRow, { option: shown, checked: false, onPick() {}, name: 'pool-option', compact: true, plain: true })
    const text = rendered.replace(/<[^>]+>/g, ' ')
    assert.match(rendered, /type="radio"/, 'still a choice')
    assert.doesNotMatch(rendered, /<details|<summary/, 'nothing to open')
    assert.doesNotMatch(rendered, /data-no-figures|data-provider-note/)
    assert.doesNotMatch(text, /verified at block|No market figures|Unavailable|Not reported|Rejected, not shown|separate adapter|No hooks|hooks|Token metadata partial|Provider figures rejected/i, 'no note line, no provenance words on screen')
    for (const label of ['TVL', '24h volume', 'APR']) assert.match(rendered, new RegExp(`>${label}</span>`), `${label} on every row`)
    assert.doesNotMatch(rendered, />Pool APR</, 'the row names it APR')
    assert.equal((rendered.match(/data-provider-figure=/g) ?? []).length, 2)
    assert.equal((rendered.match(/data-row-apr=/g) ?? []).length, 1)
    assert.doesNotMatch(rendered, /GeckoTerminal|DexScreener/, 'the provider is never named on a screen')
    assert.doesNotMatch(rendered, /money-wait|warning|yellow|amber/, 'no warning colour')
  }
  // Missing figures: dashes, and the refusal as data (changed on purpose 2026-10-15, pack 7, owner: no status notices: a
  // provider figure's dash no longer has "Nothing usable was retrieved from a market data provider (…)" as its title).
  const empty = html(PoolRow, { option: cases[0], checked: false, onPick() {}, name: 'pool-option', compact: true, plain: true })
  assert.equal((empty.match(/>—</g) ?? []).length, 3, 'three dashes')
  assert.match(empty, /data-provider-figure="unavailable" data-provider="[^"]*">/)
  assert.doesNotMatch(empty, /Nothing usable was retrieved/)
  assert.match(empty, /data-row-apr="none" data-row-apr-reason="missing_reported_tvl"><span class="text-fg-muted">APR<\/span><span class="text-fg-subtle" title="No market data provider reports liquidity for this pool\.">—/)
  const answered = html(PoolRow, { option: cases[1], checked: false, onPick() {}, name: 'pool-option', compact: true, plain: true })
  assert.match(answered, /data-provider-figure="not_reported"/)
  assert.match(answered, /data-provider-figure="rejected"/)
  // What the details and note lines said is the row's title and data now.
  const noted = html(PoolRow, { option: cases[2], checked: false, onPick() {}, name: 'pool-option', compact: true, plain: true })
  assert.match(noted, /data-token-metadata="partial" data-provider-conflict="" title="Token metadata partial\. Provider figures rejected: the provider’s currencies conflict with the chain\."/)
  // A real zero is a figure: $0.00 and 0% est., never a dash.
  const zero = html(PoolRow, { option: { ...option, volume: { state: 'attributed', value: '$0.00', raw: '0', zero: true, provider: 'dexscreener', retrievedAt: 1000, cacheAgeSeconds: null } }, checked: true, onPick() {}, name: 'pool-option', compact: true, plain: true })
  assert.match(zero, /\$0\.00/)
  assert.match(zero, /data-row-apr="estimate"><span class="text-fg-muted">APR<\/span><span class="tnum font-medium text-fg"[^>]*>0\.0% est\./)
  assert.match(zero, /checked=""/)
  // The fixture pool's own figures: $10.00 TVL and its estimate, like Markets ("12.34% est.").
  const full = html(PoolRow, { option, checked: false, onPick() {}, name: 'pool-option', compact: true, plain: true })
  assert.match(full, />\$10\.00</)
  assert.match(full, />[\d.,]+% est\.</)
  // 2026-10-01 (audit E21): the fee as every chip writes it. Changed on purpose 2026-10-30 (QA round 2, Q28): with what the
  // fee is in its title.
  assert.match(full, /data-fee="" title="Traders pay this on every swap\. People who add money to the pool, you included, share it\. It is never taken from your deposit\.">0\.30% fee</)
  // Changed on purpose 2026-10-06 (the review of the next update): a row that names its network draws the fee chip beside the
  // network chip, on one line under the pair (.dm-flow-pool-chips, which wraps where both do not fit); a row without one keeps
  // its fee chip beside the pair, last in the label.
  assert.match(full, /<\/span><span class="dm-chip shrink-0" data-fee="" title="[^"]+">0\.30% fee<\/span><\/label>/)
  assert.doesNotMatch(full, /dm-flow-pool-chips|dm-flow-pool-net/)
  const networked = html(PoolRow, { option, checked: false, onPick() {}, name: 'pool-option', compact: true, plain: true, network: 'Base' })
  assert.match(networked, /<span class="dm-flow-pool-chips"><span class="dm-chip dm-flow-pool-net" data-chain-chip="\d+">Base<\/span><span class="dm-chip shrink-0" data-fee="" title="[^"]+">0\.30% fee<\/span><\/span><\/span><\/label>/)
  assert.equal((networked.match(/data-fee=/g) ?? []).length, 1, 'one fee chip')
  assert.match(full, /data-token-metadata="available"/)
  // Changed on purpose (round 6, 2026-09-27, New position for beginners): the row names its pair and fee only; the
  // "Uniswap · <pool id>" line is gone from New position's rows, and the id is the row's data-pool-key.
  assert.doesNotMatch(full, /Uniswap ·/)
  assert.match(full, new RegExp(`data-pool-key="${option.key}"`))
  assert.doesNotMatch(full, /\btitle="[^"]*"[^>]*data-pool-option|data-pool-option="discovery"[^>]*title=/, 'no title on a row with nothing to say')
  // Changed on purpose 2026-10-30 (QA round 2, N105): a row's estimate has the one plain title every "est." figure has.
  assert.match(full, /<span class="tnum font-medium text-fg" title="Estimate from the last 24 hours of trading fees\. Your earnings depend on your price range\.">[\d.,]+% est\.</)
  // Added 2026-10-30 (QA round 2, N8): where the page holds the pool's Markets row, the row writes Markets' own APR.
  const marketEstimate = html(PoolRow, { option: { ...option, marketApr: { digits: '38.8', estimate: true } }, checked: false, onPick() {}, name: 'pool-option', compact: true, plain: true })
  assert.match(marketEstimate, /data-row-apr="estimate" data-row-apr-source="markets"><span class="text-fg-muted">APR<\/span><span class="tnum font-medium text-fg" title="Estimate from the last 24 hours of trading fees\. Your earnings depend on your price range\.">38\.8% est\.<\/span>/)
  const marketHistory = html(PoolRow, { option: { ...option, marketApr: { digits: '41.2', estimate: false } }, checked: false, onPick() {}, name: 'pool-option', compact: true, plain: true })
  assert.match(marketHistory, /data-row-apr="history" data-row-apr-source="markets"><span class="text-fg-muted">APR<\/span><span class="tnum font-medium text-money-in">41\.2%<\/span>/, 'Domino’s own history, no "est.", in the gains ink as on Markets')
})

test('the New position picker reads nothing on render and shows no coverage, catalogue or rejected panel while it waits', () => {
  const { PoolPicker } = load('src/components/read/screens/PoolPicker.tsx')
  let calls = 0
  const rendered = html(PoolPicker, { source: { read() { calls++; throw Error('Unexpected read') } }, token: candidate.key, paired: null, pending: null, onPending() {}, catalogue: false, compact: true, variant: 'create' })
  assert.equal(calls, 0)
  assert.match(rendered, /data-picker-variant="create"/)
  assert.match(rendered, /data-pools-state="loading"/)
  assert.doesNotMatch(rendered, /<details|Stored pool catalogue|Load catalogue candidates|Rejected candidates|sources &amp; coverage/)
  assert.equal((rendered.match(/dm-flow-pool-figures/g) ?? []).length, 2, 'each resting row rests with three figure cells')
})

// ---------------------------------------------------------------------------
// Speed wave, 2026-09-28 (study items 27, 29 and 30): New position's pools read, asked when the token is chosen and
// kept for the flow (lib/create/poolsAhead.ts), and the token search's kept answers (searchAnswers.ts).
// ---------------------------------------------------------------------------

const ahead = load('src/lib/create/poolsAhead.ts')
const searchAnswers = load('src/lib/read/screens/searchAnswers.ts')
// The pool hints come from the provider's token-pairs list (lib/tokenArtwork.ts): none here, so each read is the plain one.
load('src/lib/tokenArtwork.ts').tokenArtwork.pairs = async () => null
const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

/** A read source whose reads wait until the test answers them: ok (the fixture pools), or a failure that passes. */
function heldSource() {
  const reads = []
  const provenance = () => ({ transport: 'bridge', contract: null, receivedAt: Date.now(), attempts: 1 })
  const source = {
    transport: 'bridge',
    read(route, request, { signal } = {}) {
      return new Promise((settle) => {
        const entry = {
          route,
          request,
          aborted: false,
          ok: () => settle({ route, state: 'ok', data: runtime.assertResponse('pools', fixture('pools.success')), provenance: provenance() }),
          fail: () => settle({ route, state: 'unavailable', cause: { kind: 'queue_full' }, retryable: true, provenance: provenance() }),
        }
        signal?.addEventListener('abort', () => { entry.aborted = true; settle({ route, state: 'aborted', provenance: provenance() }) }, { once: true })
        reads.push(entry)
      })
    },
  }
  return { source, reads }
}

test('New position’s pools read is asked at the choice and taken by the list; an ok answer is kept a minute for the flow, a failed one never', async () => {
  ahead.forgetCreatePools()
  const { source, reads } = heldSource()
  const token = candidate.key
  ahead.startCreatePools(source, token, null)
  await tick()
  assert.equal(reads.length, 1, 'asked at the choice')
  assert.deepEqual(reads[0].request, { token }, 'the list’s own request')
  // The list mounts once the token read answers, and takes the read on its way: nothing new is asked.
  const taken = ahead.readCreatePools(source, token, null, new AbortController().signal)
  await tick()
  assert.equal(reads.length, 1)
  reads[0].ok()
  const answer = await taken
  assert.equal(answer.outcome.state, 'ok')
  assert.equal(answer.restarted, false)
  // Mounted again (Change pool, the same token chosen again): the kept answer, at once, with no read.
  assert.equal(ahead.keptCreatePools(source, token, null), answer)
  assert.equal(await ahead.readCreatePools(source, token, null, new AbortController().signal), answer)
  ahead.startCreatePools(source, token, null)
  assert.equal(reads.length, 1, 'chosen again: nothing asked')
  assert.equal(ahead.keptCreatePools(heldSource().source, token, null), null, 'another source asks for itself')
  // A minute later the list reads again, and a failed answer is not kept: the list's quiet re-ask reads once more.
  const realNow = Date.now
  try {
    Date.now = () => realNow() + ahead.KEEP_MS
    assert.equal(ahead.keptCreatePools(source, token, null), null)
    const again = ahead.readCreatePools(source, token, null, new AbortController().signal)
    await tick()
    assert.equal(reads.length, 2)
    reads[1].fail()
    assert.equal((await again).outcome.state, 'unavailable')
    assert.equal(ahead.keptCreatePools(source, token, null), null, 'a failure is never kept')
    const third = ahead.readCreatePools(source, token, null, new AbortController().signal)
    await tick()
    assert.equal(reads.length, 3)
    reads[2].ok()
    await third
    assert.notEqual(ahead.keptCreatePools(source, token, null), null)
  } finally {
    Date.now = realNow
  }
  ahead.forgetCreatePools()
  assert.equal(ahead.keptCreatePools(source, token, null), null, 'the flow’s end forgets what it kept')
})

test('a read nobody waits for is cancelled: another choice cancels one no list took, a list leaving cancels its own, a failed token read cancels its choice’s', async () => {
  ahead.forgetCreatePools()
  const { source, reads } = heldSource()
  const [a, b] = [candidate.key, '0x2222222222222222222222222222222222222222']
  ahead.startCreatePools(source, a, null)
  await tick()
  ahead.startCreatePools(source, b, null)
  await tick()
  assert.deepEqual(reads.map((read) => [read.request.token, read.aborted]), [[a, true], [b, false]], 'the earlier choice’s read, which no list took, is cancelled')
  // B's list takes its read: a later choice leaves it running while the list waits for it.
  const list = new AbortController()
  const taken = ahead.readCreatePools(source, b, null, list.signal)
  ahead.startCreatePools(source, a, null)
  await tick()
  assert.deepEqual(reads.map((read) => read.aborted), [true, false, false])
  // The list leaves while its read is out, and it is no longer the current choice's: cancelled.
  list.abort()
  assert.equal(await taken, null)
  assert.equal(reads[1].aborted, true)
  // The current choice's token read failed for good: its pools read is cancelled.
  ahead.dropCreatePools()
  assert.equal(reads[2].aborted, true)
  ahead.forgetCreatePools()
})

test('the New position picker shows the flow’s kept list at once, with no read', async () => {
  ahead.forgetCreatePools()
  const { source, reads } = heldSource()
  ahead.startCreatePools(source, candidate.key, null)
  await tick()
  reads[0].ok()
  await ahead.readCreatePools(source, candidate.key, null, new AbortController().signal)
  const { PoolPicker } = load('src/components/read/screens/PoolPicker.tsx')
  const rendered = html(PoolPicker, { source, token: candidate.key, paired: null, pending: null, onPending() {}, catalogue: false, compact: true, variant: 'create' })
  assert.equal(reads.length, 1, 'no read on render')
  assert.match(rendered, /data-pools-state="ok"/)
  assert.match(rendered, new RegExp(`data-pool-key="${option.key}"`))
  assert.doesNotMatch(rendered, /dm-skel|animate-pulse/, 'no resting rows')
  ahead.forgetCreatePools()
})

test('the token search keeps its answers a minute and answers a longer query from a complete shorter one, as the service would', () => {
  searchAnswers.forgetSearches()
  const stored = JSON.parse(readFileSync(resolve(root, '../api-contracts/read-v3/fixtures/search.json'), 'utf8')).tokens[0]
  const entry = (address, symbol) => ({ ...stored, address, value: { ...stored.value, asset: { ...stored.value.asset, address, symbol } } })
  const [usdg, usdc, usual] = [entry('0x5fc5360d0400a0fd4f2af552add042d716f1d168', 'USDG'), entry('0x3333333333333333333333333333333333333333', 'USDC'), entry('0x4444444444444444444444444444444444444444', 'usUAL')]
  const keys = (candidates) => candidates?.map((c) => c.key) ?? null
  const source = {}
  // The service's answer to "us": every symbol beginning with it, by address.
  searchAnswers.keepSearch(source, 'us', [usdc, usual, usdg], 20, 0)
  assert.deepEqual(keys(searchAnswers.keptSearch(source, 'us', 1)), [usdc.address, usual.address, usdg.address])
  assert.deepEqual(keys(searchAnswers.keptSearch(source, 'US', 1)), [usdc.address, usual.address, usdg.address], 'letter case is the service’s ILIKE')
  assert.deepEqual(keys(searchAnswers.keptSearch(source, 'usd', 1)), [usdc.address, usdg.address], 'narrowed, in the service’s order')
  assert.deepEqual(keys(searchAnswers.keptSearch(source, 'Usdg', 1)), [usdg.address])
  assert.deepEqual(keys(searchAnswers.keptSearch(source, 'usdx', 1)), [], 'nothing begins with it')
  assert.equal(searchAnswers.keptSearch(source, 'u', 1), null, 'a shorter query is asked')
  assert.equal(searchAnswers.keptSearch(source, 'usé', 1), null, 'anything but ASCII is asked')
  assert.equal(searchAnswers.keptSearch({}, 'usd', 1), null, 'another source asks for itself')
  assert.equal(searchAnswers.keptSearch(source, 'usd', searchAnswers.SEARCH_KEEP_MS), null, 'a minute later it is asked again')
  // An answer the limit cut off answers only itself.
  const full = Array.from({ length: 20 }, (_, i) => entry(`0x${String(i + 10).repeat(20)}`, `WE${i}`))
  searchAnswers.keepSearch(source, 'we', full, 20, 0)
  assert.equal(searchAnswers.keptSearch(source, 'we1', 1), null)
  assert.equal(searchAnswers.keptSearch(source, 'we', 1)?.length, 20)
  // A symbol that only the service can compare to the query is never decided here.
  searchAnswers.keepSearch(source, 'ab', [entry('0x5555555555555555555555555555555555555555', 'ABÇD')], 20, 0)
  assert.equal(searchAnswers.keptSearch(source, 'abc', 1), null)
  searchAnswers.forgetSearches()
  assert.equal(searchAnswers.keptSearch(source, 'us', 1), null)
})

// Added 2026-10-31 (QA round 2 follow-ups): New position's step 1 and Review, in their source and copy. The browser suites
// (finance-create, v2in-browser/journey) check the same on the pages.
const sourceOf = (relative) => readFileSync(resolve(root, relative), 'utf8').replace(/\r\n/g, '\n')
/** A file's code without its comments: what it draws, never what its notes quote. */
const codeOf = (relative) => sourceOf(relative).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
const tsxUnder = (dir) => readdirSync(resolve(root, dir), { withFileTypes: true }).flatMap((entry) => entry.isDirectory() ? tsxUnder(`${dir}/${entry.name}`) : entry.name.endsWith('.tsx') ? [`${dir}/${entry.name}`] : [])

test('Q12: Review names every automation the created view offers, with "Automate." kept whole on its line', () => {
  const { CREATE } = load('src/lib/create/copy.ts')
  assert.equal(CREATE.review.automateLater, 'You can add Auto-compound, Domino-compound or Auto-exit after the position is created, from')
  assert.equal(CREATE.review.automateLaterFull, 'You can add Auto-compound after the position is created, from', 'the full range line as it was')
  for (const file of ['src/components/create/StageReview.tsx', 'src/v2in/journey/ReviewStage.tsx']) {
    assert.match(codeOf(file), /<span className="whitespace-nowrap">\s*<a className="underline" href=\{automateHref\}[^>]*>[\s\S]*?<\/a>\s*\.\s*<\/span>/, `${file}: the link and its period in one unbroken span`)
  }
})

test('Q28: every fee chip says what the fee is in its title, the zap path’s PoolChips (the production Review’s) included', () => {
  const chips = tsxUnder('src').flatMap((file) => [...codeOf(file).matchAll(/<span className="dm-chip[^"]*" data-fee=""[^>]*>/g)].map(([chip]) => [file, chip]))
  assert.ok(chips.some(([file]) => file === 'src/v2in/journey/parts.tsx'), 'PoolChips is one of them')
  for (const [file, chip] of chips) assert.match(chip, /title=\{FEE_MEANING\}/, file)
})

test('N102: New position’s search takes the search’s own placeholder, the words Markets shows', () => {
  assert.doesNotMatch(codeOf('src/components/create/StageToken.tsx'), /placeholder=/, 'no placeholder of its own')
  const search = codeOf('src/components/read/screens/TokenSearch.tsx')
  assert.match(search, /placeholder=\{placeholder \?\? \(others \? SEARCH_EVERY_NETWORK : SEARCH_PLACEHOLDER\)\}/)
  assert.match(search, /export const SEARCH_EVERY_NETWORK = 'Search a token on any network'/)
  assert.doesNotMatch(search, /SEARCH_EVERY_NETWORK_UNDER_LABEL|Name or address, on any network/)
})

test('R20: a token read is heard by its name, never by a block number', () => {
  for (const file of ['src/components/read/screens/TokenSearch.tsx', 'src/components/read/screens/TokenPicker.tsx']) assert.doesNotMatch(codeOf(file), /Read at block/, file)
  assert.match(codeOf('src/components/read/screens/TokenSearch.tsx'), /const selectedWords = \(name: string\) => `\$\{name\} selected\.`/)
})
