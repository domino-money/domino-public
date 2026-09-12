import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { parsePort } from './local-live-boundary.mjs'
import { readCredentials } from './local-live-credentials.mjs'
import { createLocalProxy } from './local-live-proxy.mjs'
import { createGuardedVite } from './local-live-vite.mjs'

const APP = resolve(import.meta.dirname, '..')
try {
  const port = parsePort(process.argv.slice(2))
  const git = (...args) => execFileSync('git', args, { cwd: APP, windowsHide: true, encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  const commonGit = resolve(APP, git('rev-parse', '--git-common-dir'))
  const credentials = readCredentials({ forbiddenRoots: [resolve(APP, '..'), resolve(commonGit, '..')] })
  // Canonical producer package from PR #134: never a copied browser schema.
  const statusSchema = JSON.parse(readFileSync(resolve(APP, '../api-contracts/dev-status-v1/schema.json'), 'utf8'))
  const proxy = createLocalProxy({ credentials, statusSchema, frontend: () => ({ commit: git('rev-parse', 'HEAD'), dirty: git('status', '--porcelain').length > 0 }) })
  const shell = await createGuardedVite({ port, handleRead: proxy })
  const stop = async () => { proxy.close(); await shell.close(); process.exitCode = 0 }
  process.once('SIGINT', stop); process.once('SIGTERM', stop)
  console.log(`Local read-only development: ${shell.origin}/#/pools. Use Check connection in the banner; no automatic diagnostics polling. Ctrl+C stops the local listener.`)
} catch { console.error('Local development did not start. Check the documented private credential setup, canonical status package, environment and explicit port. No credentials or detailed upstream errors are logged.'); process.exitCode = 1 }
