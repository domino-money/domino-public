import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { inspectExecutionCloudflare } from './inspect-execution-cloudflare.mjs'

const ACCOUNT = 'a'.repeat(32)
const ZONE = 'b'.repeat(32)
const TOKEN = 'synthetic-api-token-never-log'
const APP_ID = '11111111-1111-4111-8111-111111111111'
const SESSION_ID = '22222222-2222-4222-8222-222222222222'
const OTHER_ID = '33333333-3333-4333-8333-333333333333'
const BASE = 'https://api.cloudflare.com/client/v4'
const APPS_PAGE_1 = `${BASE}/accounts/${ACCOUNT}/access/apps?per_page=100&page=1`
const APPS_PAGE_2 = `${BASE}/accounts/${ACCOUNT}/access/apps?per_page=100&page=2`
const ZONE_APPS_PAGE_1 = `${BASE}/zones/${ZONE}/access/apps?per_page=100&page=1`
const executionApp = { type: 'self_hosted', id: APP_ID, aud: '1'.repeat(64), domain: 'vm-execution.domino.money' }
const sessionApp = { type: 'self_hosted', id: SESSION_ID, aud: '2'.repeat(64), domain: 'vm-session.domino.money' }
const answer = (result, pages = 1, page = 1) => new Response(JSON.stringify({ success: true, result, result_info: { total_pages: pages, page } }), {
  status: 200, headers: { 'Content-Type': 'application/json' },
})
const answerWithoutPages = result => new Response(JSON.stringify({ success: true, result }), {
  status: 200, headers: { 'Content-Type': 'application/json' },
})
const answerWithoutPage = result => new Response(JSON.stringify({ success: true, result, result_info: { total_pages: 1 } }), {
  status: 200, headers: { 'Content-Type': 'application/json' },
})
const refused = () => new Response(JSON.stringify({ success: false, errors: [{ message: 'private-provider-error-never-log' }] }), { status: 403 })

function fixture(overrides = {}) {
  const routes = {
    [APPS_PAGE_1]: answer([executionApp, sessionApp,
      { type: 'self_hosted', id: OTHER_ID, domain: 'vm-execution.domino.money.evil' }]),
    [`${BASE}/accounts/${ACCOUNT}/access/service_tokens?per_page=1`]: answer([]),
    [`${BASE}/accounts/${ACCOUNT}/workers/scripts`]: answer([{ id: 'domino-execution-bridge' }]),
    [`${BASE}/accounts/${ACCOUNT}/cfd_tunnel/31526265-ca63-40f2-bbb7-bd37a537f899/configurations`]: answer({ config: { ingress: [
      { hostname: 'vm-execution.domino.money', path: '^/internal/execution/v1/(status|list)$', service: 'http://127.0.0.1:8901' },
    ] } }),
    [`${BASE}/zones?name=domino.money&account.id=${ACCOUNT}&per_page=5`]: answer([{ id: ZONE, name: 'domino.money', account: { id: ACCOUNT } }]),
    [ZONE_APPS_PAGE_1]: answer([]),
    [`${BASE}/accounts/${ACCOUNT}/access/apps/${APP_ID}/policies?per_page=100`]: answer([
      { decision: 'non_identity', include: [{ service_token: { token_id: 'token-resource-id' } }] },
    ]),
    [`${BASE}/accounts/${ACCOUNT}/workers/scripts/domino-execution-bridge/settings`]: answer({ bindings: [
      { type: 'plain_text', name: 'EXECUTION_BRIDGE_ENABLED', text: 'false' },
      { type: 'plain_text', name: 'EXECUTION_GATEWAY_ORIGIN', text: 'https://vm-execution.domino.money' },
      { type: 'secret_text', name: 'EXECUTION_ACCESS_CLIENT_SECRET' },
    ] }),
    [`${BASE}/accounts/${ACCOUNT}/workers/scripts/domino-execution-bridge/secrets`]: answer([
      { name: 'EXECUTION_ACCESS_CLIENT_ID', type: 'secret_text' },
      { name: 'EXECUTION_ACCESS_CLIENT_SECRET', type: 'secret_text' },
    ]),
    [`${BASE}/zones/${ZONE}/dns_records?name.exact=vm-execution.domino.money&per_page=5`]: answer([
      { name: 'vm-execution.domino.money', content: 'confidential-dns-target-never-log' },
    ]),
    ...overrides,
  }
  const calls = []
  const fetcher = async (url, init) => {
    calls.push({ url, init })
    assert.equal(init.method, 'GET', 'preflight must never mutate Cloudflare')
    assert.equal(init.headers.Authorization, `Bearer ${TOKEN}`)
    assert.ok(init.signal instanceof AbortSignal)
    assert.equal(init.body, undefined)
    assert.ok(Object.hasOwn(routes, url), `unexpected API endpoint ${url}`)
    return routes[url]
  }
  return { fetcher, calls }
}

test('reads complete Access inventory, filters exact execution host, and emits booleans only', async () => {
  const { fetcher, calls } = fixture()
  const summary = await inspectExecutionCloudflare({ token: TOKEN, accountId: ACCOUNT, fetcher })
  assert.equal(calls.length, 10)
  assert.ok(Object.values(summary).every(value => typeof value === 'boolean'))
  assert.ok(Object.values(summary).every(Boolean))
  const printed = JSON.stringify(summary)
  for (const forbidden of [TOKEN, ACCOUNT, ZONE, APP_ID, SESSION_ID, 'confidential-dns-target', 'token-resource-id']) {
    assert.ok(!printed.includes(forbidden), `summary must not expose ${forbidden}`)
  }
})

test('denied capabilities remain independent; a session app is not an execution app', async () => {
  const { fetcher } = fixture({
    [APPS_PAGE_1]: answer([sessionApp]),
    [`${BASE}/accounts/${ACCOUNT}/access/service_tokens?per_page=1`]: refused(),
    [`${BASE}/accounts/${ACCOUNT}/cfd_tunnel/31526265-ca63-40f2-bbb7-bd37a537f899/configurations`]: refused(),
    [`${BASE}/accounts/${ACCOUNT}/workers/scripts`]: refused(),
  })
  const summary = await inspectExecutionCloudflare({ token: TOKEN, accountId: ACCOUNT, fetcher })
  assert.equal(summary.accessAppsReadable, true)
  assert.equal(summary.sessionAppPresent, true)
  assert.equal(summary.executionAppPresent, false)
  assert.equal(summary.executionPoliciesReadable, false)
  assert.equal(summary.serviceTokensReadable, false)
  assert.equal(summary.tunnelConfigReadable, false)
  assert.equal(summary.workersReadable, false)
  assert.equal(summary.executionWorkerSettingsReadable, true, 'other probes continue after a refusal')
})

test('zone discovery failure does not pretend to test DNS permission', async () => {
  const { fetcher, calls } = fixture({
    [`${BASE}/zones?name=domino.money&account.id=${ACCOUNT}&per_page=5`]: refused(),
  })
  const summary = await inspectExecutionCloudflare({ token: TOKEN, accountId: ACCOUNT, fetcher })
  assert.equal(summary.zoneReadable, false)
  assert.equal(summary.dnsRecordsReadable, false)
  assert.equal(summary.executionDnsPresent, false)
  assert.equal(calls.length, 8, 'no DNS request without a verified zone ID')
})

test('malformed, oversized and overbroad inventories fail closed', async () => {
  const oversized = new Response('{"success":true,"result":[]}', { status: 200, headers: { 'Content-Length': '9999999' } })
  const { fetcher } = fixture({
    [APPS_PAGE_1]: answer([executionApp, sessionApp], 2),
    [`${BASE}/accounts/${ACCOUNT}/access/service_tokens?per_page=1`]: oversized,
    [`${BASE}/accounts/${ACCOUNT}/workers/scripts/domino-execution-bridge/secrets`]: new Response('not-json', { status: 200 }),
  })
  const summary = await inspectExecutionCloudflare({ token: TOKEN, accountId: ACCOUNT, fetcher })
  assert.equal(summary.executionAppPresent, false)
  assert.equal(summary.serviceTokensReadable, false)
  assert.equal(summary.executionWorkerSecretsReadable, false)
  assert.equal(summary.executionWorkerAccessSecretsPresent, false)
})

test('path-specific and wildcard Access apps cannot override the execution app unnoticed', async () => {
  for (const competing of [
    { domain: 'vm-execution.domino.money/internal/execution/v1/status' },
    { domain: 'vm-execution.domino.money/internal/execution/v1/st*' },
    { domain: '*.domino.money/internal/execution/v1/*' },
    { domain: 'unrelated.example', destinations: [{ type: 'public', uri: 'vm-execution.domino.money/internal/execution/v1/availability' }] },
    { domain: 'unrelated.example', self_hosted_domains: [{ domain: 'vm-execution.domino.money/internal/execution/v1/list' }] },
    { domain: 'unrelated.example', self_hosted_domains: [{}] },
  ]) {
    const { fetcher } = fixture({ [APPS_PAGE_1]: answer([executionApp, sessionApp,
      { type: 'self_hosted', id: OTHER_ID, aud: '3'.repeat(64), ...competing }]) })
    const summary = await inspectExecutionCloudflare({ token: TOKEN, accountId: ACCOUNT, fetcher })
    assert.equal(summary.accessAppsReadable, true, JSON.stringify(competing))
    assert.equal(summary.executionAppPresent, true, JSON.stringify(competing))
    assert.equal(summary.executionRouteExclusive, false, JSON.stringify(competing))
    assert.equal(summary.executionAppDistinct, false, JSON.stringify(competing))
  }
})

test('a legacy zone-scoped path application also breaks execution route exclusivity', async () => {
  const { fetcher } = fixture({
    [ZONE_APPS_PAGE_1]: answer([{ type: 'self_hosted', id: OTHER_ID,
      domain: 'vm-execution.domino.money/internal/execution/v1/status' }]),
  })
  const summary = await inspectExecutionCloudflare({ token: TOKEN, accountId: ACCOUNT, fetcher })
  assert.equal(summary.accountAccessAppsReadable, true)
  assert.equal(summary.zoneAccessAppsReadable, true)
  assert.equal(summary.executionAppPresent, true)
  assert.equal(summary.executionRouteExclusive, false)
  assert.equal(summary.executionAppDistinct, false)
})

test('unreadable zone Access inventory fails closed independently of account inventory', async () => {
  const { fetcher } = fixture({ [ZONE_APPS_PAGE_1]: refused() })
  const summary = await inspectExecutionCloudflare({ token: TOKEN, accountId: ACCOUNT, fetcher })
  assert.equal(summary.accountAccessAppsReadable, true)
  assert.equal(summary.zoneAccessAppsReadable, false)
  assert.equal(summary.accessAppsReadable, false)
  assert.equal(summary.executionRouteExclusive, false)
  assert.equal(summary.executionAppDistinct, false)
})

test('incomplete zone pagination and an ambiguous advertised execution destination fail closed', async () => {
  const { fetcher: zoneFetcher } = fixture({ [ZONE_APPS_PAGE_1]: answerWithoutPages([]) })
  const zoneSummary = await inspectExecutionCloudflare({ token: TOKEN, accountId: ACCOUNT, fetcher: zoneFetcher })
  assert.equal(zoneSummary.accountAccessAppsReadable, true)
  assert.equal(zoneSummary.zoneAccessAppsReadable, false)
  assert.equal(zoneSummary.executionRouteExclusive, false)

  const advertised = { ...executionApp, destinations: [
    { type: 'public', uri: 'vm-execution.domino.money/internal/other/v1/status' },
  ] }
  const { fetcher: appFetcher } = fixture({ [APPS_PAGE_1]: answer([advertised, sessionApp]) })
  const appSummary = await inspectExecutionCloudflare({ token: TOKEN, accountId: ACCOUNT, fetcher: appFetcher })
  assert.equal(appSummary.accessAppsReadable, true)
  assert.equal(appSummary.executionAppPresent, false)
  assert.equal(appSummary.executionRouteExclusive, false)
})

test('unrelated Access paths remain separate, including on the same host', async () => {
  const { fetcher } = fixture({ [APPS_PAGE_1]: answer([executionApp, sessionApp,
    { type: 'self_hosted', id: OTHER_ID, domain: 'vm-execution.domino.money/internal/other/v1/status' }]) })
  const summary = await inspectExecutionCloudflare({ token: TOKEN, accountId: ACCOUNT, fetcher })
  assert.equal(summary.executionRouteExclusive, true)
  assert.equal(summary.executionAppDistinct, true)
})

test('all Access pages are required and a competing app on a later page is detected', async () => {
  const competing = { type: 'self_hosted', id: OTHER_ID,
    domain: 'vm-execution.domino.money/internal/execution/v1/status' }
  const { fetcher, calls } = fixture({
    [APPS_PAGE_1]: answer([executionApp, sessionApp], 2, 1),
    [APPS_PAGE_2]: answer([competing], 2, 2),
  })
  const summary = await inspectExecutionCloudflare({ token: TOKEN, accountId: ACCOUNT, fetcher })
  assert.equal(summary.accessAppsReadable, true)
  assert.equal(summary.executionRouteExclusive, false)
  assert.equal(summary.executionAppDistinct, false)
  assert.equal(calls.length, 11)

  for (const pageTwo of [refused(), answer([competing], 2, 1), answer([competing], 3, 2)]) {
    const { fetcher: incompleteFetcher } = fixture({
      [APPS_PAGE_1]: answer([executionApp, sessionApp], 2, 1),
      [APPS_PAGE_2]: pageTwo,
    })
    const incomplete = await inspectExecutionCloudflare({ token: TOKEN, accountId: ACCOUNT, fetcher: incompleteFetcher })
    assert.equal(incomplete.accessAppsReadable, false)
    assert.equal(incomplete.executionAppPresent, false)
    assert.equal(incomplete.executionRouteExclusive, false)
  }
})

test('a Bypass policy invalidates named Service Auth even when both coexist', async () => {
  const { fetcher } = fixture({
    [`${BASE}/accounts/${ACCOUNT}/access/apps/${APP_ID}/policies?per_page=100`]: answer([
      { decision: 'non_identity', include: [{ service_token: { token_id: 'token-resource-id' } }] },
      { decision: 'bypass', include: [{ everyone: {} }] },
    ]),
  })
  const summary = await inspectExecutionCloudflare({ token: TOKEN, accountId: ACCOUNT, fetcher })
  assert.equal(summary.executionPoliciesReadable, true)
  assert.equal(summary.executionBroadAccessAbsent, false)
  assert.equal(summary.executionSpecificServiceAuthPresent, false)
})

test('an any-valid service token rule invalidates named Service Auth in every rule field', async () => {
  for (const field of ['include', 'require', 'exclude']) {
    const named = { service_token: { token_id: 'token-resource-id' } }
    const { fetcher } = fixture({
      [`${BASE}/accounts/${ACCOUNT}/access/apps/${APP_ID}/policies?per_page=100`]: answer([
        { decision: 'non_identity', include: field === 'include' ? [named, { any_valid_service_token: {} }] : [named],
          ...(field === 'include' ? {} : { [field]: [{ any_valid_service_token: {} }] }) },
      ]),
    })
    const summary = await inspectExecutionCloudflare({ token: TOKEN, accountId: ACCOUNT, fetcher })
    assert.equal(summary.executionBroadAccessAbsent, false, field)
    assert.equal(summary.executionSpecificServiceAuthPresent, false, field)
  }
})

test('an Allow Everyone policy cannot coexist with named Service Auth', async () => {
  const { fetcher } = fixture({
    [`${BASE}/accounts/${ACCOUNT}/access/apps/${APP_ID}/policies?per_page=100`]: answer([
      { decision: 'non_identity', include: [{ service_token: { token_id: 'token-resource-id' } }] },
      { decision: 'allow', include: [{ everyone: {} }] },
    ]),
  })
  const summary = await inspectExecutionCloudflare({ token: TOKEN, accountId: ACCOUNT, fetcher })
  assert.equal(summary.executionPoliciesReadable, true)
  assert.equal(summary.executionBroadAccessAbsent, false)
  assert.equal(summary.executionSpecificServiceAuthPresent, false)
})

test('every granting Include branch must be a named token; Block may coexist', async () => {
  const named = { service_token: { token_id: 'token-resource-id' } }
  for (const selector of [{ everyone: {} }, { certificate: {} }, { any_valid_service_token: {} },
                          { service_token: {} }, { service_token: { token_id: '' } },
                          { service_token: { token_id: 'token-resource-id' }, everyone: {} }]) {
    const { fetcher } = fixture({
      [`${BASE}/accounts/${ACCOUNT}/access/apps/${APP_ID}/policies?per_page=100`]: answer([
        { decision: 'non_identity', include: [named, selector] },
      ]),
    })
    const summary = await inspectExecutionCloudflare({ token: TOKEN, accountId: ACCOUNT, fetcher })
    assert.equal(summary.executionBroadAccessAbsent, false, JSON.stringify(selector))
    assert.equal(summary.executionSpecificServiceAuthPresent, false, JSON.stringify(selector))
  }

  const { fetcher } = fixture({
    [`${BASE}/accounts/${ACCOUNT}/access/apps/${APP_ID}/policies?per_page=100`]: answer([
      { decision: 'deny', include: [{ everyone: {} }] },
      { decision: 'non_identity', include: [named] },
    ]),
  })
  const summary = await inspectExecutionCloudflare({ token: TOKEN, accountId: ACCOUNT, fetcher })
  assert.equal(summary.executionBroadAccessAbsent, true)
  assert.equal(summary.executionSpecificServiceAuthPresent, true)
})

test('unknown, malformed or mixed granting policies fail closed', async () => {
  const named = { service_token: { token_id: 'token-resource-id' } }
  for (const policy of [
    { decision: 'future_action', include: [named] },
    { decision: 'non_identity' },
    { decision: 'non_identity', include: [] },
    { decision: 'non_identity', include: [null] },
    { decision: 'non_identity', include: [named], require: [{ everyone: {} }] },
    { decision: 'non_identity', include: [named], exclude: [{ certificate: {} }] },
    { decision: 'non_identity', include: [named], require: null },
  ]) {
    const { fetcher } = fixture({
      [`${BASE}/accounts/${ACCOUNT}/access/apps/${APP_ID}/policies?per_page=100`]: answer([
        { decision: 'non_identity', include: [named] }, policy,
      ]),
    })
    const summary = await inspectExecutionCloudflare({ token: TOKEN, accountId: ACCOUNT, fetcher })
    assert.equal(summary.executionBroadAccessAbsent, false, JSON.stringify(policy))
    assert.equal(summary.executionSpecificServiceAuthPresent, false, JSON.stringify(policy))
  }
})

test('missing pagination metadata cannot prove app, zone or policy inventory completeness', async () => {
  const { fetcher: appFetcher } = fixture({ [APPS_PAGE_1]: answerWithoutPages([executionApp, sessionApp]) })
  const appSummary = await inspectExecutionCloudflare({ token: TOKEN, accountId: ACCOUNT, fetcher: appFetcher })
  assert.equal(appSummary.accessAppsReadable, false)
  assert.equal(appSummary.executionAppPresent, false)
  assert.equal(appSummary.sessionAppPresent, false)
  assert.equal(appSummary.executionRouteExclusive, false)
  assert.equal(appSummary.executionAppDistinct, false)

  const zoneRows = [{ id: ZONE, name: 'domino.money', account: { id: ACCOUNT } }]
  for (const response of [answerWithoutPages(zoneRows), answerWithoutPage(zoneRows), answer(zoneRows, 1, 2)]) {
    const { fetcher, calls } = fixture({
      [`${BASE}/zones?name=domino.money&account.id=${ACCOUNT}&per_page=5`]: response,
    })
    const summary = await inspectExecutionCloudflare({ token: TOKEN, accountId: ACCOUNT, fetcher })
    assert.equal(summary.zoneReadable, true)
    assert.equal(summary.zoneAccessAppsReadable, false)
    assert.equal(summary.executionRouteExclusive, false)
    assert.equal(summary.dnsRecordsReadable, false)
    assert.equal(summary.executionDnsPresent, false)
    assert.equal(calls.length, 8, 'no zone Access or DNS request without a complete zone inventory')
  }

  const policyRows = [{ decision: 'non_identity', include: [{ service_token: { token_id: 'token-resource-id' } }] }]
  for (const response of [answerWithoutPages(policyRows), answerWithoutPage(policyRows), answer(policyRows, 1, 2)]) {
    const { fetcher } = fixture({
      [`${BASE}/accounts/${ACCOUNT}/access/apps/${APP_ID}/policies?per_page=100`]: response,
    })
    const summary = await inspectExecutionCloudflare({ token: TOKEN, accountId: ACCOUNT, fetcher })
    assert.equal(summary.executionPoliciesReadable, false)
    assert.equal(summary.executionBroadAccessAbsent, false)
    assert.equal(summary.executionSpecificServiceAuthPresent, false)
  }
})

test('workflow is manual, main-pinned, read-only and has no upload step', () => {
  const workflow = readFileSync(new URL('../.github/workflows/execution-cloudflare-preflight.yml', import.meta.url), 'utf8')
  assert.match(workflow, /^on:\n  workflow_dispatch:/m)
  assert.doesNotMatch(workflow, /^\s+(?:push|pull_request|pull_request_target|schedule|workflow_run):/m)
  assert.match(workflow, /permissions:\n  contents: read/)
  assert.match(workflow, /if: github\.ref == 'refs\/heads\/main'/)
  assert.match(workflow, /test "\$SOURCE_SHA" = "\$\(git rev-parse HEAD\)"/)
  assert.equal((workflow.match(/secrets\.CLOUDFLARE_API_TOKEN/g) ?? []).length, 1)
  assert.equal((workflow.match(/vars\.CLOUDFLARE_ACCOUNT_ID/g) ?? []).length, 1)
  assert.doesNotMatch(workflow, /upload-artifact|wrangler|gh secret|npm .*deploy|curl /i)
  assert.match(workflow, /run: node scripts\/inspect-execution-cloudflare\.mjs/)
})
