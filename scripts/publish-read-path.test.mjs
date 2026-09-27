import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { featuredPoolsRelease, inspection, publicDataRelease, releaseOptions, sequenceSnapshotRelease, releaseVars } from './publish-read-path.mjs'
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
test('V4 snapshot publication requires its separate explicit opt-in', () => {
  assert.equal(sequenceSnapshotRelease('worker'),false)
  assert.equal(sequenceSnapshotRelease('worker','true'),true)
  assert.equal(sequenceSnapshotRelease('tunnels-v4'),true)
  assert.equal(sequenceSnapshotRelease('worker-disable-v4','true'),false)
  assert.equal(sequenceSnapshotRelease('tunnels-disable-v4','true'),false)
  assert.equal(sequenceSnapshotRelease('inspect','true'),false)
  const current=settings(), enabled=releaseVars(current,{enableV4:true})
  assert.equal(releaseVars(current).READ_V4_BRIDGE_ENABLED,undefined)
  assert.equal(enabled.READ_V4_BRIDGE_ENABLED,'true')
  assert.equal(enabled.ENABLED_V4_READS,'sequence-snapshot')
  current.bindings.push({type:'plain_text',name:'READ_V4_BRIDGE_ENABLED',text:'true'},
    {type:'plain_text',name:'ENABLED_V4_READS',text:'sequence-snapshot'})
  assert.equal(releaseVars(current).ENABLED_V4_READS,'sequence-snapshot')
  const disabled=releaseVars(current,{disableV4:true})
  assert.equal(disabled.READ_V4_BRIDGE_ENABLED,'false')
  assert.equal(disabled.ENABLED_V4_READS,'sequence-snapshot')
  assert.equal(disabled.ENABLED_READS,releaseVars(current).ENABLED_READS)
  assert.equal(disabled.READ_V3_BRIDGE_ENABLED,releaseVars(current).READ_V3_BRIDGE_ENABLED)
  assert.equal(releaseVars(current).READ_V4_BRIDGE_ENABLED,'true','ordinary release preserves active V4')
  assert.throws(()=>releaseVars(current,{enableV4:true,disableV4:true}),/Invalid V4/)
  assert.throws(()=>releaseVars(current,{enableV4:'true'}),/Invalid V4/)
})

test('reviewed V4 rollback disables the Worker before removing the tunnel path', () => {
  const workflow=readFileSync(new URL('../.github/workflows/read-path-release.yml',import.meta.url),'utf8')
  assert.match(workflow,/options: \[inspect, app, bridge, publish, disable-sequence-snapshot\]/)
  const worker=workflow.indexOf('run: node scripts/publish-read-path.mjs worker-disable-v4')
  const tunnel=workflow.indexOf('run: node scripts/publish-read-path.mjs tunnels-disable-v4')
  assert.ok(worker>0 && tunnel>worker)
})

// 2026-09-26, featured-pools v1 §10.3-§10.5: read-v5 is opened by its own
// operations only, locked to its one route, and kept by every other release.
const withV5 = (enabled, reads = 'featured-pools') => {
  const current = settings()
  current.bindings.push({ type: 'plain_text', name: 'READ_V5_BRIDGE_ENABLED', text: enabled },
    { type: 'plain_text', name: 'ENABLED_V5_READS', text: reads })
  return current
}

test('only worker-v5 and tunnels-v5 open the featured pools list; no release input can', () => {
  for (const operation of ['worker-v5', 'tunnels-v5']) assert.equal(featuredPoolsRelease(operation), true, operation)
  for (const operation of ['inspect', 'worker', 'tunnels', 'worker-v3', 'tunnels-v3', 'worker-v4', 'tunnels-v4',
    'worker-disable-v4', 'tunnels-disable-v4', 'worker-disable-v5', 'tunnels-disable-v5', 'Worker-v5', 'worker-v5 ']) {
    assert.equal(featuredPoolsRelease(operation), false, operation)
  }
  const every = { DOMINO_RELEASE_PUBLIC_DATA: 'true', DOMINO_RELEASE_SEQUENCE_SNAPSHOT: 'true' }
  for (const operation of ['worker', 'tunnels', 'worker-v4', 'inspect']) assert.equal(releaseOptions(operation, every).enableV5, false, operation)
  assert.deepEqual(releaseOptions('worker-v5', {}),
    { enableV3: false, enableV4: false, disableV4: false, enableV5: true, disableV5: false })
  // A rollback opens nothing, whatever the inputs say.
  for (const operation of ['worker-disable-v5', 'tunnels-disable-v5']) {
    assert.deepEqual(releaseOptions(operation, every),
      { enableV3: false, enableV4: false, disableV4: false, enableV5: false, disableV5: true }, operation)
  }
  assert.deepEqual(releaseOptions('worker-disable-v4', every),
    { enableV3: false, enableV4: false, disableV4: true, enableV5: false, disableV5: false })
  assert.throws(() => releaseOptions('worker-v6', {}), /Unknown/)
  for (const operation of ['worker-v5', 'tunnels-v5', 'worker-disable-v5']) assert.doesNotThrow(() => releaseVars(settings(), releaseOptions(operation, {})))
})

test('worker-v5 sets exactly READ_V5_BRIDGE_ENABLED=true and ENABLED_V5_READS=featured-pools', () => {
  const current = settings()
  const ordinary = releaseVars(current)
  assert.equal(ordinary.READ_V5_BRIDGE_ENABLED, undefined, 'an ordinary release does not switch read-v5 on')
  assert.equal(ordinary.ENABLED_V5_READS, undefined)
  const enabled = releaseVars(current, { enableV5: true })
  assert.equal(enabled.READ_V5_BRIDGE_ENABLED, 'true')
  assert.equal(enabled.ENABLED_V5_READS, 'featured-pools')
  assert.deepEqual({ ...enabled, READ_V5_BRIDGE_ENABLED: undefined, ENABLED_V5_READS: undefined },
    { ...ordinary, READ_V5_BRIDGE_ENABLED: undefined, ENABLED_V5_READS: undefined }, 'nothing else moves')
  assert.equal(releaseVars(withV5('false', ''), { enableV5: true }).ENABLED_V5_READS, 'featured-pools')
})

test('every other release keeps an enabled read-v5, and its rollback moves nothing but its flag', () => {
  const current = withV5('true')
  for (const options of [{}, { enableV3: true }, { enableV4: true }, { disableV4: true }, { enableV5: true }]) {
    const next = releaseVars(current, options)
    assert.equal(next.READ_V5_BRIDGE_ENABLED, 'true', JSON.stringify(options))
    assert.equal(next.ENABLED_V5_READS, 'featured-pools', JSON.stringify(options))
  }
  current.bindings.push({ type: 'plain_text', name: 'READ_V2_BRIDGE_ENABLED', text: 'true' },
    { type: 'plain_text', name: 'ENABLED_V2_READS', text: 'pool-market' },
    { type: 'plain_text', name: 'READ_V4_BRIDGE_ENABLED', text: 'true' },
    { type: 'plain_text', name: 'ENABLED_V4_READS', text: 'sequence-snapshot' })
  const live = Object.fromEntries(current.bindings.filter(binding => binding.type === 'plain_text' && binding.name !== 'UNRELATED')
    .map(binding => [binding.name, binding.text]))
  assert.deepEqual(releaseVars(current, { disableV5: true }), { ...live, READ_V5_BRIDGE_ENABLED: 'false' })
  // Off, it stays off, keeping its one route for the next worker-v5.
  const off = withV5('false')
  assert.equal(releaseVars(off).READ_V5_BRIDGE_ENABLED, 'false')
  assert.equal(releaseVars(off).ENABLED_V5_READS, 'featured-pools')
})

test('the V5 lock refuses any other route list, live or stored, and any mixed rollback', () => {
  for (const [enabled, reads] of [['true', ''], ['true', 'overview'], ['true', 'featured-pools,featured-pools'],
    ['true', 'featured-pools,overview'], ['true', ' featured-pools'], ['true', 'featured_pools'], ['false', 'overview'],
    ['false', 'featured-pools,capabilities'], ['false', '__proto__']]) {
    assert.throws(() => releaseVars(withV5(enabled, reads)), /Unexpected existing V5/, `${enabled} ${reads}`)
    assert.throws(() => releaseVars(withV5(enabled, reads), { enableV5: true }), /Unexpected existing V5/, `${enabled} ${reads}`)
    assert.throws(() => releaseVars(withV5(enabled, reads), { disableV5: true }), /Unexpected existing V5/, `${enabled} ${reads}`)
  }
  const current = withV5('true')
  for (const options of [{ enableV5: true, disableV5: true }, { enableV3: true, disableV5: true }, { enableV4: true, disableV5: true },
    { disableV4: true, disableV5: true }, { enableV5: true, disableV4: true }, { enableV5: 'true' }, { disableV5: 1 }]) {
    assert.throws(() => releaseVars(current, options), /Invalid V[45]/, JSON.stringify(options))
  }
})

test('inspection reports the read-v5 flags, and the reviewed Worker config keeps them off', () => {
  const { summary } = inspection(['worker'], [{ status: 'fulfilled', value: withV5('false', '') }])
  assert.equal(summary.worker.vars.READ_V5_BRIDGE_ENABLED, 'false')
  assert.equal(summary.worker.vars.ENABLED_V5_READS, '')
  const toml = readFileSync(new URL('../bridge/wrangler.read.toml', import.meta.url), 'utf8')
  assert.match(toml, /^READ_V5_BRIDGE_ENABLED = "false"$/m)
  assert.match(toml, /^ENABLED_V5_READS = ""$/m)
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
