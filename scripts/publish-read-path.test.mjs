import assert from 'node:assert/strict'
import test from 'node:test'
import { inspection, publicDataRelease, releaseVars } from './publish-read-path.mjs'
import { READ_TUNNEL_IDS } from './read-tunnel-config.mjs'

const settings = () => ({ bindings: [
  ...Object.entries({ READ_BRIDGE_ENABLED: 'true', ENABLED_READS: 'token,pools,pool-market,wallet-assets,nft-positions,catalogue,pool-activity',
    APP_ORIGIN: 'https://domino.money', GATEWAY_ORIGIN: 'https://vm-read.domino.money', UNRELATED: 'retained-by-keep-vars' })
    .map(([name, text]) => ({ type: 'plain_text', name, text })),
  { type: 'secret_text', name: 'ACCESS_CLIENT_ID' }, { type: 'secret_text', name: 'ACCESS_CLIENT_SECRET' },
] })

test('the workflow V3 input is explicit and inspect remains read-only', () => {
  for (const operation of ['worker', 'tunnels']) {
    assert.equal(publicDataRelease(operation), false)
    assert.equal(publicDataRelease(operation, 'false'), false)
    assert.equal(publicDataRelease(operation, 'true'), true)
    assert.equal(publicDataRelease(`${operation}-v3`), true)
  }
  assert.equal(publicDataRelease('inspect', 'true'), false)
  for (const invalid of ['', '1', 'yes', true, false, null]) {
    assert.throws(() => publicDataRelease('worker', invalid), /must be true or false/)
  }
})

test('enables only v2 pool-market and retains the exact existing v1 read list', () => {
  const current = settings()
  const next = releaseVars(current)
  assert.equal(next.ENABLED_READS, current.bindings.find(binding => binding.name === 'ENABLED_READS').text)
  assert.equal(next.READ_BRIDGE_ENABLED, 'true')
  assert.equal(next.READ_V2_BRIDGE_ENABLED, 'true')
  assert.equal(next.ENABLED_V2_READS, 'pool-market')
  assert.equal(next.ACCESS_CLIENT_SECRET, undefined)
  assert.equal(next.UNRELATED, undefined)
})
test('V3 is an explicit release option and an existing enabled V3 is preserved', () => {
  const current = settings()
  assert.equal(releaseVars(current).READ_V3_BRIDGE_ENABLED, undefined)
  const enabled = releaseVars(current, { enableV3: true })
  assert.equal(enabled.READ_V3_BRIDGE_ENABLED, 'true')
  assert.equal(enabled.ENABLED_V3_READS, 'overview,history,search')
  for (const name of ['READ_V3_BRIDGE_ENABLED', 'ENABLED_V3_READS']) {
    current.bindings.push({ type: 'plain_text', name, text: enabled[name] })
  }
  assert.equal(releaseVars(current).READ_V3_BRIDGE_ENABLED, 'true')
  assert.equal(releaseVars(current).ENABLED_V3_READS, 'overview,history,search')
  assert.throws(() => releaseVars(current, { enableV3: 'true' }), /Invalid V3/)
})
test('refuses missing Access secrets and changed routing', () => {
  const missing = settings(); missing.bindings.pop()
  assert.throws(() => releaseVars(missing), /credentials/)
  const wrong = settings(); wrong.bindings.find(binding => binding.name === 'GATEWAY_ORIGIN').text = 'https://elsewhere.invalid'
  assert.throws(() => releaseVars(wrong), /active Domino read path/)
})
test('does not turn an inactive or unknown v1 configuration on', () => {
  const off = settings(); off.bindings.find(binding => binding.name === 'READ_BRIDGE_ENABLED').text = 'false'
  assert.throws(() => releaseVars(off), /active Domino read path/)
  const unknown = settings(); unknown.bindings.find(binding => binding.name === 'ENABLED_READS').text = 'pool-market,new-operation'
  assert.throws(() => releaseVars(unknown), /existing enabled v1 reads/)
})
test('retains an existing v1 list that names the stored-data reads, exactly as it is', () => {
  for (const reads of [
    'token,pools,pool-market,wallet-assets,nft-positions,catalogue,pool-activity,markets-snapshot',
    'token,pools,pool-market,wallet-assets,nft-positions,catalogue,pool-activity,pool-positions,pool-metrics',
    'token,pools,pool-market,wallet-assets,nft-positions,catalogue,pool-activity,pool-positions,pool-metrics,markets-snapshot',
  ]) {
    const current = settings(); current.bindings.find(binding => binding.name === 'ENABLED_READS').text = reads
    const next = releaseVars(current)
    assert.equal(next.ENABLED_READS, reads, reads)
    assert.equal(next.ENABLED_V2_READS, 'pool-market', reads)
  }
  // Still only read-v1's own routes: a name that is close is not one of them.
  for (const reads of ['pool-market,pool-metric', 'pool-market,markets_snapshot', 'pool-market,capabilities']) {
    const current = settings(); current.bindings.find(binding => binding.name === 'ENABLED_READS').text = reads
    assert.throws(() => releaseVars(current), /existing enabled v1 reads/, reads)
  }
})

const fulfilled = (value) => ({ status: 'fulfilled', value })
const rejected = (message) => ({ status: 'rejected', reason: new Error(message) })
const inspectKeys = () => ['worker', 'pages', ...READ_TUNNEL_IDS.map(id => `tunnel:${id}`)]

test('inspection covers every tunnel a publication writes, not just one', () => {
  // Reading one tunnel proves nothing about the other; both are published to.
  assert.equal(READ_TUNNEL_IDS.length, 2)
  assert.equal(new Set(READ_TUNNEL_IDS).size, 2)
  const keys = inspectKeys()
  assert.deepEqual(keys.slice(2), READ_TUNNEL_IDS.map(id => `tunnel:${id}`))
})

test('a refused resource is reported and named, never passed over in silence', () => {
  const keys = inspectKeys()
  const { summary, refused } = inspection(keys, [
    rejected('Cloudflare workers HTTP 403; error codes 10000.'),
    fulfilled({ name: 'domino-app', production_branch: 'main' }),
    rejected('Cloudflare cfd_tunnel HTTP 401; error codes 1001.'),
    fulfilled({ version: 7, config: { ingress: [] } }),
  ])
  assert.deepEqual(refused, ['worker', keys[2]])
  assert.match(summary.worker.error, /403/)
  assert.equal(summary.pages.name, 'domino-app')
  assert.equal(summary[keys[3]].version, 7)
})

test('nothing is refused when every resource answers', () => {
  const keys = inspectKeys()
  const { summary, refused } = inspection(keys, [
    fulfilled({ bindings: [{ type: 'plain_text', name: 'READ_V2_BRIDGE_ENABLED', text: 'false' },
                           { type: 'secret_text', name: 'ACCESS_CLIENT_ID' }] }),
    fulfilled({ name: 'domino-app' }),
    fulfilled({ version: 1, config: { ingress: [{ hostname: 'a', path: '^/x$', service: 'http://127.0.0.1:1' }] } }),
    fulfilled({ version: 2, config: { ingress: [] } }),
  ])
  assert.deepEqual(refused, [])
  // The flag this release is waiting on is reported, and no secret value is.
  assert.equal(summary.worker.vars.READ_V2_BRIDGE_ENABLED, 'false')
  assert.deepEqual(summary.worker.accessCredentialNames, ['ACCESS_CLIENT_ID'])
  assert.equal(JSON.stringify(summary).includes('secret_text'), false)
  assert.deepEqual(summary[keys[2]].ingress, [{ hostname: 'a', path: '^/x$', service: 'http://127.0.0.1:1' }])
})
