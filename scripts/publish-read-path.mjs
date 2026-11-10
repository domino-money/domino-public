/** Fixed Domino read-path release. Credentials stay in the deployment step.
 * Run `inspect` to check existing access; `worker` after the VM is ready.
 * DOMINO_RELEASE_PUBLIC_DATA=true explicitly adds the stored read-v3 routes.
 * The featured pools list (read-v5, featured-pools v1 §10.3-§10.5) has no
 * such input: `tunnels-v5` opens its production tunnel path and `worker-v5`
 * alone switches READ_V5_BRIDGE_ENABLED on, with ENABLED_V5_READS exactly
 * `featured-pools`. Rollback is `worker-disable-v5`, then `tunnels-disable-v5`.
 * Every other operation keeps the v5 state it finds.
 * Domino V2's wallet reads (read-v6, spec F7 §6.2, 2026-10-02) follow the same
 * rule: `tunnels-v6` opens their production tunnel path and `worker-v6` alone
 * switches READ_V6_BRIDGE_ENABLED on, with ENABLED_V6_READS exactly
 * `portfolio,activity,chain-pools,chain-balances,chain-tokens,position-fees`
 * (read-v6 1.2.0-rc.1's position-fees named last since the owner's approval of
 * 2026-11-07; a Worker still holding the five 1.1.0-rc.1 routes, as published
 * from 2026-10-06, or the first two, `portfolio,activity`, is a known state that
 * worker-v6 widens). Rollback is `worker-disable-v6`, then `tunnels-disable-v6`.
 * Every other operation keeps the v6 state it finds.
 * The app uses its existing build-once, preview-then-production release helper.
 */
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { isDeepStrictEqual } from 'node:util'
import { READ_TUNNEL_IDS, V3_READ_TUNNEL_IDS, V4_READ_TUNNEL_IDS, V5_READ_TUNNEL_IDS, V6_READ_TUNNEL_IDS, extendReadTunnelConfig } from './read-tunnel-config.mjs'

const ROOT = fileURLToPath(new URL('../', import.meta.url))
// read-v1's ten POST routes: an existing Worker variable may name any of them and is retained as it is.
const KNOWN_READS = new Set(['token', 'pools', 'pool-market', 'wallet-assets', 'nft-positions', 'catalogue', 'pool-activity', 'pool-positions', 'pool-metrics', 'markets-snapshot'])
// Every flag a release passes back: one left out here would be reset to wrangler.read.toml's "false" by the next deploy.
const VISIBLE_VARS = ['READ_BRIDGE_ENABLED', 'READ_V2_BRIDGE_ENABLED', 'READ_V3_BRIDGE_ENABLED', 'READ_V4_BRIDGE_ENABLED', 'READ_V5_BRIDGE_ENABLED',
  'READ_V6_BRIDGE_ENABLED', 'ENABLED_READS', 'ENABLED_V2_READS', 'ENABLED_V3_READS', 'ENABLED_V4_READS', 'ENABLED_V5_READS', 'ENABLED_V6_READS',
  'APP_ORIGIN', 'GATEWAY_ORIGIN']
/** read-v5's one route: the only value ENABLED_V5_READS may hold. */
const V5_READS = 'featured-pools'
/** read-v6's routes, as this release writes them; with the five 1.1.0-rc.1 routes, as published from 2026-10-06, and
 * the first two, as published from 2026-10-02, the only values ENABLED_V6_READS may hold. */
const V6_READS = 'portfolio,activity,chain-pools,chain-balances,chain-tokens,position-fees'
const V6_CHAIN_READS = 'portfolio,activity,chain-pools,chain-balances,chain-tokens'
const V6_FIRST_READS = 'portfolio,activity'

export function publicDataRelease(operation, selected = 'false') {
  if (!['false', 'true'].includes(selected)) throw new Error('DOMINO_RELEASE_PUBLIC_DATA must be true or false.')
  return operation !== 'inspect' && (operation.endsWith('-v3') || selected === 'true')
}

export function sequenceSnapshotRelease(operation, selected = 'false') {
  if (!['false', 'true'].includes(selected)) throw new Error('DOMINO_RELEASE_SEQUENCE_SNAPSHOT must be true or false.')
  return operation !== 'inspect' && operation !== 'worker-disable-v4' && operation !== 'tunnels-disable-v4'
    && (operation === 'worker-v4' || operation === 'tunnels-v4' || selected === 'true')
}

/** Only the operations named for the featured pools list open it; no workflow input or variable can. */
export function featuredPoolsRelease(operation) {
  return operation === 'worker-v5' || operation === 'tunnels-v5'
}

/** Only the operations named for Domino V2's wallet reads (read-v6) open them; no workflow input or variable can. */
export function walletReadsRelease(operation) {
  return operation === 'worker-v6' || operation === 'tunnels-v6'
}

export function releaseVars(settings, { enableV3 = false, enableV4 = false, disableV4 = false, enableV5 = false, disableV5 = false,
  enableV6 = false, disableV6 = false } = {}) {
  if (typeof enableV3 !== 'boolean') throw new Error('Invalid V3 release option.')
  if (typeof enableV4 !== 'boolean' || typeof disableV4 !== 'boolean' || (enableV4 || enableV3) && disableV4)
    throw new Error('Invalid V4 release option.')
  // A V5 rollback changes nothing but READ_V5_BRIDGE_ENABLED.
  if (typeof enableV5 !== 'boolean' || typeof disableV5 !== 'boolean' || enableV5 && disableV4
      || disableV5 && (enableV3 || enableV4 || enableV5 || disableV4))
    throw new Error('Invalid V5 release option.')
  // Likewise a V6 rollback changes nothing but READ_V6_BRIDGE_ENABLED, and opening V6 travels with no other rollback.
  if (typeof enableV6 !== 'boolean' || typeof disableV6 !== 'boolean' || enableV6 && (disableV4 || disableV5)
      || disableV6 && (enableV3 || enableV4 || enableV5 || enableV6 || disableV4 || disableV5))
    throw new Error('Invalid V6 release option.')
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
  if (vars.READ_V4_BRIDGE_ENABLED === 'true' && vars.ENABLED_V4_READS !== 'sequence-snapshot')
    throw new Error('Unexpected existing V4 snapshot routes; refusing to replace them.')
  // The lock: a stored ENABLED_V5_READS is nothing or exactly read-v5's one
  // route, and read-v5 is never on without that route.
  if (![undefined, '', V5_READS].includes(vars.ENABLED_V5_READS)
      || vars.READ_V5_BRIDGE_ENABLED === 'true' && vars.ENABLED_V5_READS !== V5_READS)
    throw new Error('Unexpected existing V5 featured pools routes; refusing to replace them.')
  // The same lock for read-v6: nothing, or exactly its routes as worker-v6 writes or wrote them.
  if (![undefined, '', V6_READS, V6_CHAIN_READS, V6_FIRST_READS].includes(vars.ENABLED_V6_READS)
      || vars.READ_V6_BRIDGE_ENABLED === 'true' && ![V6_READS, V6_CHAIN_READS, V6_FIRST_READS].includes(vars.ENABLED_V6_READS))
    throw new Error('Unexpected existing V6 wallet read routes; refusing to replace them.')
  const rollback = disableV4 || disableV5 || disableV6
  return { ...vars, ...(rollback ? {} : { READ_V2_BRIDGE_ENABLED: 'true', ENABLED_V2_READS: 'pool-market' }),
    ...(enableV3 ? { READ_V3_BRIDGE_ENABLED: 'true', ENABLED_V3_READS: 'overview,history,search' } : {}),
    ...(enableV4 ? { READ_V4_BRIDGE_ENABLED: 'true', ENABLED_V4_READS: 'sequence-snapshot' } : {}),
    ...(enableV5 ? { READ_V5_BRIDGE_ENABLED: 'true', ENABLED_V5_READS: V5_READS } : {}),
    ...(enableV6 ? { READ_V6_BRIDGE_ENABLED: 'true', ENABLED_V6_READS: V6_READS } : {}),
    ...(disableV4 ? { READ_V4_BRIDGE_ENABLED: 'false' } : {}),
    ...(disableV5 ? { READ_V5_BRIDGE_ENABLED: 'false' } : {}),
    ...(disableV6 ? { READ_V6_BRIDGE_ENABLED: 'false' } : {}) }
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

const OPERATIONS = ['inspect', 'tunnels', 'worker', 'tunnels-v3', 'worker-v3', 'tunnels-v4', 'worker-v4', 'tunnels-v5', 'worker-v5',
  'tunnels-v6', 'worker-v6', 'worker-disable-v4', 'tunnels-disable-v4', 'worker-disable-v5', 'tunnels-disable-v5',
  'worker-disable-v6', 'tunnels-disable-v6']

/** What one operation opens and closes, from its name and the two release inputs. A rollback opens nothing, whatever the inputs say. */
export function releaseOptions(operation, env = {}) {
  if (!OPERATIONS.includes(operation)) throw new Error('Unknown read-path operation.')
  const disableV4 = operation === 'worker-disable-v4' || operation === 'tunnels-disable-v4'
  const disableV5 = operation === 'worker-disable-v5' || operation === 'tunnels-disable-v5'
  const disableV6 = operation === 'worker-disable-v6' || operation === 'tunnels-disable-v6'
  const rollback = disableV4 || disableV5 || disableV6
  return {
    enableV3: !rollback && publicDataRelease(operation, env.DOMINO_RELEASE_PUBLIC_DATA),
    enableV4: !rollback && sequenceSnapshotRelease(operation, env.DOMINO_RELEASE_SEQUENCE_SNAPSHOT),
    disableV4,
    enableV5: featuredPoolsRelease(operation),
    disableV5,
    enableV6: walletReadsRelease(operation),
    disableV6,
  }
}

async function run(operation) {
  if (!OPERATIONS.includes(operation)) {
    throw new Error('Use inspect, tunnels, worker, tunnels-v3 or worker-v3/v4/v5/v6; reviewed rollback uses worker-disable-v4 then tunnels-disable-v4, worker-disable-v5 then tunnels-disable-v5, or worker-disable-v6 then tunnels-disable-v6.')
  }
  const options = releaseOptions(operation, process.env)
  const { enableV3, enableV4, disableV4, enableV5, disableV5, enableV6, disableV6 } = options
  if (operation.startsWith('tunnels')) {
    for (const id of enableV6 || disableV6 ? V6_READ_TUNNEL_IDS : enableV5 || disableV5 ? V5_READ_TUNNEL_IDS : enableV4 || disableV4 ? V4_READ_TUNNEL_IDS : enableV3 ? V3_READ_TUNNEL_IDS : READ_TUNNEL_IDS) {
      const path = `cfd_tunnel/${id}/configurations`
      const before = await cloudflare(path)
      const config = extendReadTunnelConfig(id, before.config, options)
      if (!isDeepStrictEqual(config, before.config)) {
        const latest = await cloudflare(path)
        if (latest.version !== before.version || !isDeepStrictEqual(latest.config, before.config)) throw new Error('Tunnel changed during publication; retry against its new configuration.')
        await cloudflare(path, { config })
      }
      const after = await cloudflare(path)
      if (!isDeepStrictEqual(after.config, config)) throw new Error('Published tunnel configuration differs from the intended path-only update.')
      console.log(JSON.stringify({ tunnel: id, version: after.version, v2PathEnabled: true, storedReadPathsEnabled: true,
        ...(enableV3 ? { v3StoredPathsEnabled: true } : {}),
        ...(enableV4 ? { v4SequenceSnapshotEnabled: true } : {}),
        ...(disableV4 ? { v4SequenceSnapshotEnabled: false } : {}),
        ...(enableV5 ? { v5FeaturedPoolsEnabled: true } : {}),
        ...(disableV5 ? { v5FeaturedPoolsEnabled: false } : {}),
        ...(enableV6 ? { v6WalletReadsEnabled: true } : {}),
        ...(disableV6 ? { v6WalletReadsEnabled: false } : {}), otherSettingsPreserved: true }))
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
  const vars = releaseVars(settings, options)
  if (!readFileSync(new URL('../bridge/wrangler.read.toml', import.meta.url), 'utf8').includes('READ_V2_BRIDGE_ENABLED')) {
    throw new Error('This source does not yet contain the v2 read Worker.')
  }
  if (enableV3 && !readFileSync(new URL('../bridge/wrangler.read.toml', import.meta.url), 'utf8').includes('READ_V3_BRIDGE_ENABLED')) {
    throw new Error('This source does not yet contain the v3 read Worker.')
  }
  if (enableV4 && !readFileSync(new URL('../bridge/wrangler.read.toml', import.meta.url), 'utf8').includes('READ_V4_BRIDGE_ENABLED')) {
    throw new Error('This source does not yet contain the v4 read Worker.')
  }
  if ((enableV5 || disableV5) && !readFileSync(new URL('../bridge/wrangler.read.toml', import.meta.url), 'utf8').includes('READ_V5_BRIDGE_ENABLED')) {
    throw new Error('This source does not yet contain the v5 read Worker.')
  }
  if ((enableV6 || disableV6) && !readFileSync(new URL('../bridge/wrangler.read.toml', import.meta.url), 'utf8').includes('READ_V6_BRIDGE_ENABLED')) {
    throw new Error('This source does not yet contain the v6 read Worker.')
  }
  const args = ['--yes', 'wrangler@4.130.0', 'deploy', '-c', 'bridge/wrangler.read.toml', '--keep-vars']
  for (const [name, value] of Object.entries(vars)) args.push('--var', `${name}:${value}`)
  const result = spawnSync('npx', args, { cwd: ROOT, stdio: 'inherit', shell: false })
  if (result.status !== 0) throw new Error(`Read Worker deployment failed with exit ${result.status ?? 'unknown'}.`)
  const deployed = await cloudflare('workers/scripts/domino-read-bridge/settings')
  const current = Object.fromEntries((deployed.bindings ?? []).filter(binding => binding.type === 'plain_text').map(binding => [binding.name, binding.text]))
  if (Object.entries(vars).some(([name, value]) => current[name] !== value)) throw new Error('Deployed read Worker flags differ from the requested release.')
  releaseVars(deployed, options)
  console.log(disableV4
    ? 'Read Worker deployed: read-v4 sequence snapshot disabled; existing v1-v3, v5 and v6 flags and Access credentials retained.'
    : disableV5
      ? 'Read Worker deployed: read-v5 featured pools disabled; existing v1-v4 and v6 flags and Access credentials retained.'
      : disableV6
        ? 'Read Worker deployed: read-v6 wallet reads disabled; existing v1-v5 flags and Access credentials retained.'
        : `Read Worker deployed: existing v1 reads retained; read-v2 pool-market enabled; ${enableV3 ? 'read-v3 stored reads enabled; ' : ''}${enableV4 ? 'read-v4 sequence snapshot enabled; ' : ''}${enableV5 ? 'read-v5 featured pools enabled; ' : ''}${enableV6 ? 'read-v6 wallet reads enabled; ' : ''}Access credentials retained.`)
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  run(process.argv[2]).catch(error => { console.error(error.message); process.exitCode = 1 })
}
