import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
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
    assert.match(rendered, /Reported by a market data provider, retrieved/, 'the figure is attributed to a provider')
    assert.doesNotMatch(rendered, /GeckoTerminal|DexScreener/, 'the provider is never named on a screen')
    assert.match(rendered, />TVL</)
    // Changed on purpose (2026-09-20): a pool that genuinely traded nothing earns
    // nothing, and zero is a figure — the producer's own `_render` prints it and
    // refuses only a POSITIVE estimate too small to show. A dash here said "we do
    // not know" about something we do know.
    assert.match(rendered, /data-row-apr="estimate"/)
    assert.match(rendered, />Pool APR<\/span><span class="tnum font-medium text-fg"[^>]*>0% est\./)
    assert.doesNotMatch(rendered, /data-row-apr-reason/, 'nothing was refused')
    // The caveat that used to sit under every row, contradicting the figure above
    // it on every pool, is gone for good.
    assert.doesNotMatch(rendered, /Pool APR unavailable/, 'no constant caveat under the details')
    assert.match(rendered, /type="radio"/)
    assert.ok(rendered.includes(option.key))
    assert.match(rendered, /Pool details · verified at block/)
  }
})

test('missing and rejected provider figures never become zeroes', () => {
  const rendered = html(PoolRow, { option: { ...option, liquidity: { state: 'not_reported', provider: 'dexscreener' }, volume: { state: 'rejected', provider: 'dexscreener', reason: 'provider_currency_mismatch' } }, checked: false, onPick() {}, name: 'pool', compact: true })
  assert.match(rendered, /Not reported/)
  assert.match(rendered, /Rejected, not shown/)
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
  assert.match(rendered, /Reported by a market data provider, retrieved/, 'the figure is attributed to a provider')
  assert.doesNotMatch(rendered, /GeckoTerminal|DexScreener/, 'the provider is never named on a screen')
  // The row works the estimate out from the figures this read already returned: no read per row.
  assert.match(rendered, /data-row-apr="estimate"/)
  assert.match(rendered, />Pool APR<\/span><span class="tnum font-medium text-fg"[^>]*>[\d.]+% est\./)
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
  // Missing figures: dashes, each with its reason in its title, and the refusal as data.
  const empty = html(PoolRow, { option: cases[0], checked: false, onPick() {}, name: 'pool-option', compact: true, plain: true })
  assert.equal((empty.match(/>—</g) ?? []).length, 3, 'three dashes')
  assert.match(empty, /data-provider-figure="unavailable"[^>]*title="Nothing usable was retrieved from a market data provider/)
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
  assert.match(zero, /data-row-apr="estimate"><span class="text-fg-muted">APR<\/span><span class="tnum font-medium text-fg"[^>]*>0% est\./)
  assert.match(zero, /checked=""/)
  // The fixture pool's own figures: $10.00 TVL and its estimate, like Markets ("12.34% est.").
  const full = html(PoolRow, { option, checked: false, onPick() {}, name: 'pool-option', compact: true, plain: true })
  assert.match(full, />\$10\.00</)
  assert.match(full, />[\d.]+% est\.</)
  assert.match(full, /data-token-metadata="available"/)
  assert.doesNotMatch(full, /\btitle="[^"]*"[^>]*data-pool-option|data-pool-option="discovery"[^>]*title=/, 'no title on a row with nothing to say')
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
