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
test('guarded local-live keeps real source and selection, disables wallet and test hooks', async () => {
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

test('the real source factory paces only local-live at 10.1 s; deployed reads retain 1.1 s and shared deadlines', () => {
  const source = readFileSync(resolve(root, 'src/lib/read/screens/appSourceBridge.ts'), 'utf8')
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
  for (const localLive of [true, false]) {
    const validators = {}; const bridge = {}; const scheduled = {}; const calls = []
    const exports = {}
    runInNewContext(compiled, { exports, __DOMINO_LOCAL_LIVE__: localLive, require: (path) => {
      if (path === '../../capabilities') return { CAPABILITIES: { liveReadsBuilt: true } }
      if (path === '../contract') return { READ_RUNTIME: validators }
      if (path === '../bridgeSource') return { createBridgeSource: (options) => { calls.push(['bridge', options]); return bridge } }
      if (path === '../scheduler') return { createScheduledSource: (input, options) => { calls.push(['scheduler', input, options]); return scheduled } }
      throw new Error(`Unexpected source dependency: ${path}`)
    } })
    assert.equal(exports.BRIDGE_SPACING_MS, localLive ? 10_100 : 1100)
    assert.equal(exports.createAppBridgeSource(), scheduled)
    assert.equal(calls[0][1].validators, validators, 'same canonical validators')
    assert.equal(calls[0][1].enabled, true)
    assert.deepEqual(Object.keys(calls[0][1]).sort(), ['enabled', 'validators'], 'no retry policy override')
    assert.equal(calls[1][1], bridge, 'same source through the existing scheduler')
    assert.equal(calls[1][2].minIntervalMs, localLive ? 10_100 : 1100)
    assert.deepEqual(Object.keys(calls[1][2]), ['minIntervalMs'], '60 s total deadline and queue bounds are not changed')
  }
})
