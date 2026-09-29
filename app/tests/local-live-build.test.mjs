import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { test } from 'node:test'
import ts from 'typescript'
import { resolveConfig } from 'vite'
import { findForbidden } from '../scripts/deploy-markers.mjs'

const root = resolve(import.meta.dirname, '..')
const configFile = resolve(root, 'vite.config.ts')
test('local-live refuses every build, regardless of output directory', async () => {
  for (const outDir of ['dist', '.local-dist', '../elsewhere']) {
    await assert.rejects(resolveConfig({ root, configFile, mode: 'local-live', build: { outDir }, logLevel: 'silent' }, 'build'), /serve-only/)
  }
})
test('ordinary Vite cannot bypass the guarded launcher', async () => {
  await assert.rejects(resolveConfig({ root, configFile, mode: 'local-live', logLevel: 'silent' }, 'serve'), /guarded launcher/)
})
test('guarded local-live keeps real source and selection, disables server sessions and test hooks', async () => {
  const config = await resolveConfig({ root, configFile, mode: 'local-live', server: { middlewareMode: true }, logLevel: 'silent' }, 'serve')
  assert.deepEqual([config.define.__DOMINO_READ_MODE__, config.define.__DOMINO_POOL_SET__, config.define.__DOMINO_WALLET_SESSION__, config.define.__DOMINO_TEST_HOOKS__, config.define.__DOMINO_LOCAL_LIVE__], ['"bridge"', '"selected"', 'false', 'false', 'true'])
})
test('production and development builds remove the local flag and reject local markers', async () => {
  for (const mode of ['production', 'development']) {
    const config = await resolveConfig({ root, configFile, mode, logLevel: 'silent' }, 'build')
    assert.equal(config.define.__DOMINO_LOCAL_LIVE__, 'false')
  }
  for (const marker of ['local-live', 'dev-read.domino.money', 'CF-Access-Client-Secret', 'CF-Access-Client-Id', '__DOMINO_LOCAL_LIVE__', 'Local real-data development']) assert.ok(findForbidden(marker).length)
})

// Changed 2026-09-25 (r4/metrics): the deployed source also passes `unspacedStored: true`, so read-v3's stored reads
// skip the 1.1 s the gateway's stored lane never had (scheduler.ts); local-live passes false and keeps 10.1 s for
// every read. The deadline and queue bounds are still the scheduler's defaults.
// Changed on purpose (2026-09-26, featured pools v1 §11.1): read-v5's featured list joins the same source before the
// scheduler (lib/read/featuredList.ts createFeaturedReadSource), with the same options and its own runtime.
// Changed on purpose (2026-09-27, r6/marketsdata): two stored reads may be on the wire at once (`storedWidth: 2`,
// scheduler.ts), so Home's featured list and its overview travel together; local-live spaces every read, so the width
// never applies there.
// Changed on purpose (2026-09-28, speed wave, items 1 and 5): deployed reads go out two at a time, every lane together
// (`width: 2`, the gateway runs two at once), provider reads 0 ms apart since the gateway's provider lane lost its start
// interval (#241), 1.1 s apart again once one meets a refusal (`refusedIntervalMs`), and the deployable build keeps the
// budget in localStorage (`budgetStore`). local-live keeps 10.1 s for every read, one at a time, and no stored budget.
test('the real source factory paces only local-live at 10.1 s; deployed reads go two at a time, 1.1 s apart after a refusal, with shared deadlines', () => {
  const source = readFileSync(resolve(root, 'src/lib/read/screens/appSourceBridge.ts'), 'utf8')
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
  for (const [localLive, poolSet] of [[true, 'selected'], [false, 'selected'], [false, 'fixture']]) {
    const validators = {}; const estimateRuntime = {}; const publicRuntime = {}; const featuredRuntime = {}; const bridge = {}; const publicSource = {}; const featuredSource = {}; const scheduled = {}; const cached = {}; const calls = []
    const takeEarly = () => null
    const exports = {}
    runInNewContext(compiled, { exports, __DOMINO_LOCAL_LIVE__: localLive, __DOMINO_POOL_SET__: poolSet, require: (path) => {
      if (path === '../../capabilities') return { CAPABILITIES: { liveReadsBuilt: true } }
      if (path === '../contract') return { READ_RUNTIME: validators }
      if (path === 'api-contracts/read-v2/runtime.mjs') return estimateRuntime
      if (path === 'api-contracts/read-v3/runtime.mjs') return publicRuntime
      if (path === 'api-contracts/read-v5/runtime.mjs') return featuredRuntime
      if (path === '../featuredList') return { createFeaturedReadSource: (input, options, runtime) => { calls.push(['featured', input, options, runtime]); return featuredSource } }
      if (path === '../earlyList') return { takeEarly }
      if (path === '../estimateSource') return { createEstimateSource: (options, runtime) => { calls.push(['bridge', options, runtime]); return bridge } }
      if (path === '../publicSource') return { createPublicSource: (input, options, runtime) => { calls.push(['public', input, options, runtime]); return publicSource } }
      if (path === '../scheduler') return { createScheduledSource: (input, options) => { calls.push(['scheduler', input, options]); return scheduled }, storedBudget: (key) => ({ key }) }
      if (path === '../publicMetadataCache') return { createPublicMetadataCache: input => { calls.push(['cache', input]); return cached } }
      throw new Error(`Unexpected source dependency: ${path}`)
    } })
    assert.equal(exports.BRIDGE_SPACING_MS, localLive ? 10_100 : 1100)
    assert.equal(exports.createAppBridgeSource(), cached)
    assert.equal(calls[0][1].validators, validators, 'same canonical validators')
    assert.equal(calls[0][1].enabled, true)
    assert.equal(calls[0][2], estimateRuntime, 'canonical v2 validation is supplied to the same scheduled source')
    // Changed on purpose (2026-09-28, speed wave, item 10): the deployable build's first reads take the replies the page
    // sent before the app started (public/early-list.js), through `first`; nothing else is added.
    const early = !localLive && poolSet === 'selected'
    assert.deepEqual(Object.keys(calls[0][1]).sort(), early ? ['enabled', 'first', 'validators'] : ['enabled', 'validators'], 'no retry policy override')
    if (early) assert.equal(calls[0][1].first, takeEarly)
    assert.equal(calls[1][1], bridge, 'V3 keeps the legacy V1/V2 source')
    assert.equal(calls[1][2], calls[0][1], 'the additive source uses the same options')
    assert.equal(calls[1][3], publicRuntime, 'canonical V3 validation is supplied')
    assert.equal(calls[2][0], 'featured')
    assert.equal(calls[2][1], publicSource, 'the featured list sits beside the public source')
    assert.equal(calls[2][2], calls[0][1], 'the featured list uses the same options')
    assert.equal(calls[2][3], featuredRuntime, 'canonical V5 validation is supplied')
    assert.equal(calls[3][1], featuredSource, 'all versions share the existing scheduler')
    assert.equal(calls[3][2].minIntervalMs, localLive ? 10_100 : 0)
    assert.equal(calls[3][2].unspacedStored, !localLive, 'only deployed stored reads skip the spacing; local-live spaces every read')
    if (localLive) {
      assert.deepEqual(Object.keys(calls[3][2]), ['minIntervalMs', 'unspacedStored'], 'one read at a time; 60 s total deadline and queue bounds are not changed')
    } else {
      assert.equal(calls[3][2].refusedIntervalMs, 1100, 'the 1.1 s comes back after a refusal')
      assert.equal(calls[3][2].width, 2, 'two reads at once, as the gateway runs them')
      assert.deepEqual(Object.keys(calls[3][2]), ['minIntervalMs', 'refusedIntervalMs', 'unspacedStored', 'width', ...(poolSet === 'selected' ? ['budgetStore'] : [])],
        '60 s total deadline and queue bounds are not changed; only the deployable build keeps the budget in this browser')
      if (poolSet === 'selected') assert.deepEqual(calls[3][2].budgetStore, { key: 'domino-read-budget:v1' }, 'one key, this browser’s')
    }
    assert.equal(calls[4][1], scheduled, 'only scheduled public outcomes enter the metadata cache')
  }
})

// Added 2026-09-28 (speed wave, item 10): only the deployable build's page loads public/early-list.js, which sends the
// featured list's read before the app starts; a test build's page reads no list, or reads it from a test's own service.
test('only the deployable build loads the early list script, before the app’s own', async () => {
  const html = '<head>\n    <script type="module" crossorigin src="/assets/index-abc.js"></script>\n  </head>'
  for (const mode of ['production', 'development', 'fixtures', 'bridge-test', 'wallet-test', 'consumer-test']) {
    const config = await resolveConfig({ root, configFile, mode, logLevel: 'silent' }, 'build')
    const plugin = config.plugins.find((entry) => entry.name === 'domino:early-list')
    const hook = typeof plugin.transformIndexHtml === 'function' ? plugin.transformIndexHtml : plugin.transformIndexHtml.handler
    const out = hook(html)
    if (['production', 'development'].includes(mode)) assert.equal(out, html.replace('<script type="module"', '<script async src="/early-list.js"></script>\n    <script type="module"'), mode)
    else assert.equal(out, html, mode)
  }
})
