import assert from 'node:assert/strict'
import test from 'node:test'
import { releaseVars } from './publish-read-path.mjs'

const settings = () => ({ bindings: [
  ...Object.entries({ READ_BRIDGE_ENABLED: 'true', ENABLED_READS: 'token,pools,pool-market,wallet-assets,nft-positions,catalogue,pool-activity',
    APP_ORIGIN: 'https://domino.money', GATEWAY_ORIGIN: 'https://vm-read.domino.money', UNRELATED: 'retained-by-keep-vars' })
    .map(([name, text]) => ({ type: 'plain_text', name, text })),
  { type: 'secret_text', name: 'ACCESS_CLIENT_ID' }, { type: 'secret_text', name: 'ACCESS_CLIENT_SECRET' },
] })

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
