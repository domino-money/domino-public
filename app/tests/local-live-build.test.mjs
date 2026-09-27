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
test('the real source factory paces only local-live at 10.1 s; deployed reads retain 1.1 s and shared deadlines', () => {
  const source = readFileSync(resolve(root, 'src/lib/read/screens/appSourceBridge.ts'), 'utf8')
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
  for (const localLive of [true, false]) {
    const validators = {}; const estimateRuntime = {}; const publicRuntime = {}; const featuredRuntime = {}; const bridge = {}; const publicSource = {}; const featuredSource = {}; const scheduled = {}; const cached = {}; const calls = []
    const exports = {}
    runInNewContext(compiled, { exports, __DOMINO_LOCAL_LIVE__: localLive, require: (path) => {
      if (path === '../../capabilities') return { CAPABILITIES: { liveReadsBuilt: true } }
      if (path === '../contract') return { READ_RUNTIME: validators }
      if (path === 'api-contracts/read-v2/runtime.mjs') return estimateRuntime
      if (path === 'api-contracts/read-v3/runtime.mjs') return publicRuntime
      if (path === 'api-contracts/read-v5/runtime.mjs') return featuredRuntime
      if (path === '../featuredList') return { createFeaturedReadSource: (input, options, runtime) => { calls.push(['featured', input, options, runtime]); return featuredSource } }
      if (path === '../estimateSource') return { createEstimateSource: (options, runtime) => { calls.push(['bridge', options, runtime]); return bridge } }
      if (path === '../publicSource') return { createPublicSource: (input, options, runtime) => { calls.push(['public', input, options, runtime]); return publicSource } }
      if (path === '../scheduler') return { createScheduledSource: (input, options) => { calls.push(['scheduler', input, options]); return scheduled } }
      if (path === '../publicMetadataCache') return { createPublicMetadataCache: input => { calls.push(['cache', input]); return cached } }
      throw new Error(`Unexpected source dependency: ${path}`)
    } })
    assert.equal(exports.BRIDGE_SPACING_MS, localLive ? 10_100 : 1100)
    assert.equal(exports.createAppBridgeSource(), cached)
    assert.equal(calls[0][1].validators, validators, 'same canonical validators')
    assert.equal(calls[0][1].enabled, true)
    assert.equal(calls[0][2], estimateRuntime, 'canonical v2 validation is supplied to the same scheduled source')
    assert.deepEqual(Object.keys(calls[0][1]).sort(), ['enabled', 'validators'], 'no retry policy override')
    assert.equal(calls[1][1], bridge, 'V3 keeps the legacy V1/V2 source')
    assert.equal(calls[1][2], calls[0][1], 'the additive source uses the same options')
    assert.equal(calls[1][3], publicRuntime, 'canonical V3 validation is supplied')
    assert.equal(calls[2][0], 'featured')
    assert.equal(calls[2][1], publicSource, 'the featured list sits beside the public source')
    assert.equal(calls[2][2], calls[0][1], 'the featured list uses the same options')
    assert.equal(calls[2][3], featuredRuntime, 'canonical V5 validation is supplied')
    assert.equal(calls[3][1], featuredSource, 'all versions share the existing scheduler')
    assert.equal(calls[3][2].minIntervalMs, localLive ? 10_100 : 1100)
    assert.equal(calls[3][2].unspacedStored, !localLive, 'only deployed stored reads skip the spacing; local-live spaces every read')
    assert.deepEqual(Object.keys(calls[3][2]), ['minIntervalMs', 'unspacedStored'], '60 s total deadline and queue bounds are not changed')
    assert.equal(calls[4][1], scheduled, 'only scheduled public outcomes enter the metadata cache')
  }
})
