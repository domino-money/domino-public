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
    const rendered = html(PoolRow, { option: { ...option, volume: { state: 'attributed', value: '$0.00', zero: true, provider: 'dexscreener', retrievedAt: 1000, cacheAgeSeconds: null } }, checked: true, onPick() {}, name: 'pool', compact })
    assert.match(rendered, /\$0\.00/)
    assert.match(rendered, /DexScreener/)
    assert.match(rendered, />TVL</)
    assert.match(rendered, />Pool APR<\/span><span>Unavailable/)
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
  assert.match(rendered, /DexScreener/)
  assert.match(rendered, />Pool APR<\/span><span>Unavailable/)
})

test('the picker with onOpen and the catalogue left to the page renders no catalogue section and reads nothing on render', () => {
  const { PoolPicker } = load('src/components/read/screens/PoolPicker.tsx')
  let calls = 0
  const rendered = html(PoolPicker, { source: { read() { calls++; throw Error('Unexpected read') } }, token: candidate.key, paired: null, pending: null, onPending() {}, onOpen() {}, catalogue: false, compact: true })
  assert.equal(calls, 0)
  assert.doesNotMatch(rendered, /Stored pool catalogue|Load catalogue candidates/)
  assert.doesNotMatch(rendered, /New pool creation/, 'the compact form carries no new-pool note')
})
