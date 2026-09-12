import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { test } from 'node:test'
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
