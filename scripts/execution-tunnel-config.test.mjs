import assert from 'node:assert/strict'
import { test } from 'node:test'
import { EXECUTION_HOST, EXECUTION_PATH, EXECUTION_TUNNEL_ID,
  extendExecutionTunnelConfig } from './execution-tunnel-config.mjs'

const SESSION_AUDIENCE = '213e1bd4f444f439af6a2a3bccceff7d369392d079cf052e38d0972d4d8da7e0'
const EXECUTION_AUDIENCE = 'e'.repeat(64)
const OPTIONS = { executionAudience: EXECUTION_AUDIENCE }

function fixture() {
  return {
    ingress: [
      { hostname: 'vm-read.domino.money', path: '^/internal/read/v1/token$', service: 'http://127.0.0.1:8878' },
      { hostname: 'vm-session.domino.money',
        path: '^/internal/session/v1/(bootstrap|challenge|verify|refresh|logout|me)$',
        service: 'http://127.0.0.1:8879',
        originRequest: { access: { required: true, teamName: 'fixture-team', audTag: [SESSION_AUDIENCE] },
          connectTimeout: 5 } },
      { hostname: 'vm-onboarding.domino.money', path: '^/internal/onboarding/v1/preview$',
        service: 'http://127.0.0.1:8880' },
      { service: 'http_status:404' },
    ],
    originRequest: { noTLSVerify: false },
    'warp-routing': { enabled: false },
  }
}

test('inserts only a distinct-audience execution rule before 404 and preserves other ingress', () => {
  const input = fixture(), before = structuredClone(input)
  const result = extendExecutionTunnelConfig(EXECUTION_TUNNEL_ID, input, OPTIONS)
  assert.deepEqual(input, before)
  assert.deepEqual(result.ingress.filter(rule => rule.hostname !== EXECUTION_HOST), before.ingress)
  assert.deepEqual(result.ingress.at(-2), {
    hostname: EXECUTION_HOST, path: EXECUTION_PATH, service: 'http://127.0.0.1:8901',
    originRequest: { access: { required: true, teamName: 'fixture-team',
      audTag: [EXECUTION_AUDIENCE] } },
  })
  assert.deepEqual(result.ingress.at(-1), { service: 'http_status:404' })
  assert.deepEqual(extendExecutionTunnelConfig(EXECUTION_TUNNEL_ID, result, OPTIONS), result)
  result.ingress.at(-2).originRequest.access.audTag[0] = 'changed'
  assert.equal(input.ingress[1].originRequest.access.audTag[0], SESSION_AUDIENCE)
})

test('execution route admits only the three read-only status operations', () => {
  const pattern = new RegExp(EXECUTION_PATH)
  for (const route of ['availability', 'status', 'list'])
    assert.ok(pattern.test(`/internal/execution/v1/${route}`))
  for (const path of ['/internal/execution/v1/sign', '/internal/execution/v1/cancel',
                     '/internal/execution/v1/availability/', '/internal/execution/v1/%61vailability',
                     '/internal/execution/v1//status', '/prefix/internal/execution/v1/list',
                     '/internal/session/v1/me'])
    assert.equal(pattern.test(path), false, path)
})

test('rejects session audience reuse, missing audience, drift and route shadowing', () => {
  for (const options of [{}, { executionAudience: SESSION_AUDIENCE },
                         { executionAudience: 'not-an-audience' }])
    assert.throws(() => extendExecutionTunnelConfig(EXECUTION_TUNNEL_ID, fixture(), options),
      /execution_tunnel_configuration_mismatch/)
  const variants = [
    c => { c.ingress[1].path = '^/internal/session/v1/.*$' },
    c => { c.ingress[1].service = 'http://127.0.0.1:8901' },
    c => { c.ingress[1].originRequest.access.required = false },
    c => { c.ingress[1].originRequest.access.audTag = [EXECUTION_AUDIENCE] },
    c => { c.ingress[1].originRequest.access.audTag.push(EXECUTION_AUDIENCE) },
    c => { c.ingress[0].originRequest = { access: { required: true, teamName: 'fixture-team',
      audTag: [EXECUTION_AUDIENCE] } } },
    c => { c.ingress.splice(1, 0, { service: 'http_status:200' }) },
    c => { c.ingress.splice(1, 0, { hostname: '*.domino.money', service: 'http_status:200' }) },
    c => { c.ingress.splice(2, 0, { hostname: EXECUTION_HOST, path: '^/internal/execution/.*$',
      service: 'http://127.0.0.1:8901' }) },
    c => { c.ingress.at(-1).service = 'http://127.0.0.1:8879' },
  ]
  for (const mutate of variants) {
    const input = fixture()
    mutate(input)
    const before = structuredClone(input)
    assert.throws(() => extendExecutionTunnelConfig(EXECUTION_TUNNEL_ID, input, OPTIONS),
      /^Error: execution_tunnel_configuration_mismatch$/)
    assert.deepEqual(input, before)
  }
  for (const id of ['other', null, '__proto__'])
    assert.throws(() => extendExecutionTunnelConfig(id, fixture(), OPTIONS),
      /execution_tunnel_configuration_mismatch/)
  for (const config of [null, {}, { ingress: [] }, { ingress: [null] }])
    assert.throws(() => extendExecutionTunnelConfig(EXECUTION_TUNNEL_ID, config, OPTIONS),
      /execution_tunnel_configuration_mismatch/)
})

test('rejects every prior ingress that can shadow execution before its Access rule', () => {
  for (const hostname of ['', '*.money', '*.domino.money',
                          'VM-EXECUTION.DOMINO.MONEY', 'ｖｍ-execution.domino.money']) {
    for (const path of [undefined, EXECUTION_PATH]) {
      const input = fixture()
      input.ingress.splice(1, 0, {
        hostname, ...(path === undefined ? {} : { path }), service: 'http://127.0.0.1:8901',
      })
      assert.throws(() => extendExecutionTunnelConfig(EXECUTION_TUNNEL_ID, input, OPTIONS),
        /execution_tunnel_configuration_mismatch/, `${hostname || '(empty)'} ${path || '(all paths)'}`)
    }
  }
})

test('existing execution ingress is accepted only when exact and singular', () => {
  const published = extendExecutionTunnelConfig(EXECUTION_TUNNEL_ID, fixture(), OPTIONS)
  assert.deepEqual(extendExecutionTunnelConfig(EXECUTION_TUNNEL_ID, published, OPTIONS), published)
  for (const mutate of [
    c => { c.ingress.at(-2).service = 'http://127.0.0.1:8879' },
    c => { c.ingress.at(-2).path = '^/internal/execution/v1/.*$' },
    c => { c.ingress.at(-2).originRequest.access.required = false },
    c => { c.ingress.splice(-1, 0, structuredClone(c.ingress.at(-2))) },
  ]) {
    const input = structuredClone(published)
    mutate(input)
    assert.throws(() => extendExecutionTunnelConfig(EXECUTION_TUNNEL_ID, input, OPTIONS),
      /execution_tunnel_configuration_mismatch/)
  }
})
