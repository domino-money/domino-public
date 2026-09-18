/** Fixed Domino read-path release. Credentials stay in the deployment step.
 * Run `inspect` to check existing access; `worker` after the VM serves read-v2.
 * The app uses its existing build-once, preview-then-production release helper.
 */
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { isDeepStrictEqual } from 'node:util'
import { READ_TUNNEL_IDS, extendReadTunnelConfig } from './read-tunnel-config.mjs'

const ROOT = fileURLToPath(new URL('../', import.meta.url))
// read-v1's ten POST routes: an existing Worker variable may name any of them and is retained as it is.
const KNOWN_READS = new Set(['token', 'pools', 'pool-market', 'wallet-assets', 'nft-positions', 'catalogue', 'pool-activity', 'pool-positions', 'pool-metrics', 'markets-snapshot'])
const VISIBLE_VARS = ['READ_BRIDGE_ENABLED', 'READ_V2_BRIDGE_ENABLED', 'ENABLED_READS', 'ENABLED_V2_READS', 'APP_ORIGIN', 'GATEWAY_ORIGIN']

export function releaseVars(settings) {
  const vars = Object.fromEntries((settings.bindings ?? [])
    .filter(binding => binding.type === 'plain_text' && VISIBLE_VARS.includes(binding.name))
    .map(binding => [binding.name, binding.text]))
  const secrets = new Set((settings.bindings ?? []).filter(binding => binding.type === 'secret_text').map(binding => binding.name))
  if (!secrets.has('ACCESS_CLIENT_ID') || !secrets.has('ACCESS_CLIENT_SECRET')) throw new Error('The read Worker is missing its existing Access credentials.')
  if (vars.READ_BRIDGE_ENABLED !== 'true' || vars.APP_ORIGIN !== 'https://domino.money' || vars.GATEWAY_ORIGIN !== 'https://vm-read.domino.money') {
    throw new Error('The existing read Worker does not match the active Domino read path.')
  }
  const reads = vars.ENABLED_READS?.split(',').map(value => value.trim()) ?? []
  if (!reads.includes('pool-market') || reads.some(value => !KNOWN_READS.has(value))) throw new Error('Unexpected existing enabled v1 reads; refusing to replace them.')
  return { ...vars, READ_V2_BRIDGE_ENABLED: 'true', ENABLED_V2_READS: 'pool-market' }
}

/** Summarise one settled result per key, and name every resource refused. */
export function inspection(keys, results) {
  const summary = {}
  for (const [index, key] of keys.entries()) {
    const result = results[index]
    if (result.status === 'rejected') { summary[key] = { error: result.reason.message }; continue }
    const value = result.value
    if (key === 'worker') summary[key] = { name: 'domino-read-bridge', vars: Object.fromEntries((value.bindings ?? [])
      .filter(binding => binding.type === 'plain_text' && VISIBLE_VARS.includes(binding.name))
      .map(binding => [binding.name, binding.text])),
      accessCredentialNames: (value.bindings ?? []).filter(binding => binding.type === 'secret_text').map(binding => binding.name) }
    if (key === 'pages') summary[key] = { name: value.name, productionBranch: value.production_branch,
      productionDeployment: value.canonical_deployment?.id ?? null,
      productionCommit: value.canonical_deployment?.deployment_trigger?.metadata?.commit_hash ?? null }
    if (key.startsWith('tunnel:')) summary[key] = { version: value.version, ingress: (value.config?.ingress ?? [])
      .map(rule => ({ hostname: rule.hostname, path: rule.path, service: rule.service })) }
  }
  return { summary, refused: Object.entries(summary).filter(([, value]) => value.error).map(([key]) => key) }
}


async function cloudflare(path, payload) {
  const token = process.env.CLOUDFLARE_API_TOKEN
  const account = process.env.CLOUDFLARE_ACCOUNT_ID
  if (!token || !/^[0-9a-f]{32}$/.test(account ?? '')) throw new Error('Cloudflare token/account configuration is missing.')
  const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/${path}`, {
    method: payload === undefined ? 'GET' : 'PUT',
    headers: { Authorization: `Bearer ${token}`, ...(payload === undefined ? {} : { 'Content-Type': 'application/json' }) },
    body: payload === undefined ? undefined : JSON.stringify(payload), signal: AbortSignal.timeout(30_000),
  })
  const body = await response.json().catch(() => null)
  if (!response.ok || !body?.success) {
    // Provider error bodies and bindings can contain confidential configuration.
    const codes = (body?.errors ?? []).map(error => Number(error.code)).filter(Number.isFinite)
    throw new Error(`Cloudflare ${path.split('/')[0]} HTTP ${response.status}; error codes ${codes.join(',') || 'unavailable'}.`)
  }
  return body.result
}

async function run(operation) {
  if (!['inspect', 'tunnels', 'worker'].includes(operation)) throw new Error('Use inspect, tunnels or worker.')
  if (operation === 'tunnels') {
    for (const id of READ_TUNNEL_IDS) {
      const path = `cfd_tunnel/${id}/configurations`
      const before = await cloudflare(path)
      const config = extendReadTunnelConfig(id, before.config)
      if (!isDeepStrictEqual(config, before.config)) {
        const latest = await cloudflare(path)
        if (latest.version !== before.version || !isDeepStrictEqual(latest.config, before.config)) throw new Error('Tunnel changed during publication; retry against its new configuration.')
        await cloudflare(path, { config })
      }
      const after = await cloudflare(path)
      if (!isDeepStrictEqual(after.config, config)) throw new Error('Published tunnel configuration differs from the intended path-only update.')
      console.log(JSON.stringify({ tunnel: id, version: after.version, v2PathEnabled: true, storedReadPathsEnabled: true, otherSettingsPreserved: true }))
    }
    return
  }
  if (operation === 'inspect') {
    // Inspect every resource a publication touches, including both tunnels:
    // reading one of them proves nothing about the other.
    const keys = ['worker', 'pages', ...READ_TUNNEL_IDS.map(id => `tunnel:${id}`)]
    const results = await Promise.allSettled([
      cloudflare('workers/scripts/domino-read-bridge/settings'),
      cloudflare('pages/projects/domino-app'),
      ...READ_TUNNEL_IDS.map(id => cloudflare(`cfd_tunnel/${id}/configurations`)),
    ])
    const { summary, refused } = inspection(keys, results)
    // Report everything first: a refused resource is the diagnosis. Then fail,
    // because a run that exits successfully is read as access being complete.
    console.log(JSON.stringify(summary, null, 2))
    if (refused.length) {
      throw new Error(`Inspection could not read ${refused.join(', ')}; the release token is missing a permission. See docs/CLOUDFLARE_RELEASE_TOKEN.md.`)
    }
    return
  }
  const settings = await cloudflare('workers/scripts/domino-read-bridge/settings')
  const vars = releaseVars(settings)
  if (!readFileSync(new URL('../bridge/wrangler.read.toml', import.meta.url), 'utf8').includes('READ_V2_BRIDGE_ENABLED')) {
    throw new Error('This source does not yet contain the v2 read Worker.')
  }
  const args = ['--yes', 'wrangler@4.130.0', 'deploy', '-c', 'bridge/wrangler.read.toml', '--keep-vars']
  for (const [name, value] of Object.entries(vars)) args.push('--var', `${name}:${value}`)
  const result = spawnSync('npx', args, { cwd: ROOT, stdio: 'inherit', shell: false })
  if (result.status !== 0) throw new Error(`Read Worker deployment failed with exit ${result.status ?? 'unknown'}.`)
  const deployed = await cloudflare('workers/scripts/domino-read-bridge/settings')
  const current = Object.fromEntries((deployed.bindings ?? []).filter(binding => binding.type === 'plain_text').map(binding => [binding.name, binding.text]))
  if (Object.entries(vars).some(([name, value]) => current[name] !== value)) throw new Error('Deployed read Worker flags differ from the requested release.')
  releaseVars(deployed)
  console.log('Read Worker deployed: existing v1 reads retained; read-v2 pool-market enabled; Access credentials retained.')
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  run(process.argv[2]).catch(error => { console.error(error.message); process.exitCode = 1 })
}
