/** Read-only Cloudflare inventory for the execution-status bridge.
 * API responses, resource IDs and credentials never enter stdout, errors or artifacts.
 */
import { domainToASCII, pathToFileURL } from 'node:url'

const HOST = 'vm-execution.domino.money'
const SESSION_HOST = 'vm-session.domino.money'
const WORKER = 'domino-execution-bridge'
const TUNNEL = '31526265-ca63-40f2-bbb7-bd37a537f899'
const MAX_RESPONSE_BYTES = 512_000
const TIMEOUT_MS = 8_000
const APP_PAGE_SIZE = 100
const MAX_APP_PAGES = 10
const EXECUTION_ROUTES = ['availability', 'status', 'list'].map(route => `/internal/execution/v1/${route}`)

const record = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const rows = value => Array.isArray(value) ? value : []
const hex32 = value => typeof value === 'string' && /^[0-9a-f]{32}$/.test(value)
const policyRules = value => Array.isArray(value) && value.every(rule =>
  record(rule) && Object.keys(rule).length === 1 && record(Object.values(rule)[0]))
const namedTokenRule = rule => policyRules([rule]) && Object.hasOwn(rule, 'service_token')
  && Object.keys(rule.service_token).length === 1
  && typeof rule.service_token.token_id === 'string' && rule.service_token.token_id.length > 0

function safePolicy(policy) {
  if (!record(policy) || !Array.isArray(policy.include) || policy.include.length === 0
      || !policyRules(policy.include)
      || !policyRules(policy.require === undefined ? [] : policy.require)
      || !policyRules(policy.exclude === undefined ? [] : policy.exclude)) return false
  // A deny policy cannot grant access, regardless of whom it blocks.
  if (policy.decision === 'deny') return true
  // Include is OR in Access. Every granting branch must require a named token.
  // Additional Require/Exclude selectors need separate review before green.
  return policy.decision === 'non_identity' && policy.include.every(namedTokenRule)
    && rows(policy.require).length === 0 && rows(policy.exclude).length === 0
}

function appDomains(app) {
  // Inspect every advertised route conservatively; destinations can supersede legacy fields.
  const domains = []
  if (typeof app.type !== 'string') domains.push('*')
  if (typeof app.domain === 'string') domains.push(app.domain)
  else if (app.type === 'self_hosted') domains.push('*')
  if (app.self_hosted_domains !== undefined) {
    if (!Array.isArray(app.self_hosted_domains)) domains.push('*')
    else for (const item of app.self_hosted_domains) {
      const domain = typeof item === 'string' ? item : item?.domain
      domains.push(typeof domain === 'string' ? domain : '*')
    }
  }
  if (app.destinations !== undefined) {
    if (!Array.isArray(app.destinations)) domains.push('*')
    else for (const item of app.destinations) {
      if (typeof item?.uri === 'string') domains.push(item.uri)
      else if (app.type === 'self_hosted' && item?.type !== 'private') domains.push('*')
    }
  }
  return domains
}

function matchingApps(inventory, host) {
  if (!inventory.ok) return []
  const prefix = host === SESSION_HOST ? 'session' : 'execution'
  return inventory.result.filter(app => app?.type === 'self_hosted' && typeof app.id === 'string'
    && /^[0-9a-f-]{36}$/.test(app.id) && appDomains(app).some(domain =>
    domain === host || domain === `${host}/internal/${prefix}/v1/*`)
    && (app.destinations === undefined || Array.isArray(app.destinations)
      && app.destinations.some(item =>
        item?.uri === host || item?.uri === `${host}/internal/${prefix}/v1/*`)))
}

function overlapsExecution(domain) {
  if (typeof domain !== 'string' || domain === '*') return true
  if (domain.length > 2048) return true
  const uri = domain.replace(/^https?:\/\//iu, '')
  const slash = uri.indexOf('/')
  const hostname = slash < 0 ? uri : uri.slice(0, slash)
  const path = slash < 0 ? '' : uri.slice(slash)
  const asciiHost = domainToASCII(hostname).replace(/\.$/u, '').toLowerCase()
  if (!asciiHost) return true
  const hostPattern = new RegExp(`^${asciiHost.replace(/[|\\{}()[\]^$+?.]/gu, '\\$&').replace(/\*/gu, '.*')}$`, 'u')
  if (!hostPattern.test(HOST)) return false
  if (!path || path === '/') return true
  if (/[?#%]/u.test(path)) return true // Ambiguous URL encoding or unsupported components.
  const pathPattern = new RegExp(`^${path.replace(/[|\\{}()[\]^$+?.]/gu, '\\$&').replace(/\*/gu, '.*')}$`, 'u')
  return EXECUTION_ROUTES.some(route => pathPattern.test(route) || path.replace(/\/$/u, '') === route
    || !path.includes('*') && route.startsWith(`${path.replace(/\/$/u, '')}/`))
}

async function boundedJson(response) {
  if (!response.ok || !response.body) return null
  const length = response.headers.get('content-length')
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > MAX_RESPONSE_BYTES)) return null
  const reader = response.body.getReader()
  const chunks = []
  let size = 0
  try {
    for (;;) {
      const part = await reader.read()
      if (part.done) break
      size += part.value.byteLength
      if (size > MAX_RESPONSE_BYTES) { await reader.cancel().catch(() => {}); return null }
      chunks.push(part.value)
    }
  } finally { reader.releaseLock() }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) } catch { return null }
}

/** The optional fetch argument exists only for offline tests; production uses global fetch. */
export async function inspectExecutionCloudflare({ token, accountId, fetcher = fetch }) {
  if (!token || !hex32(accountId)) throw new Error('Cloudflare preflight configuration unavailable')
  const base = 'https://api.cloudflare.com/client/v4'
  const probe = async path => {
    try {
      const response = await fetcher(`${base}${path}`, {
        method: 'GET', headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(TIMEOUT_MS),
      })
      const body = await boundedJson(response)
      if (!record(body) || body.success !== true || !('result' in body)) return { ok: false, result: null, pages: null, page: null }
      const pages = Number.isSafeInteger(body.result_info?.total_pages) ? body.result_info.total_pages : null
      const page = Number.isSafeInteger(body.result_info?.page) ? body.result_info.page : null
      return { ok: true, result: body.result, pages, page }
    } catch { return { ok: false, result: null, pages: null, page: null } }
  }
  const accessApps = async scope => {
    const path = `${scope}/access/apps?per_page=${APP_PAGE_SIZE}&page=`
    const first = await probe(`${path}1`)
    if (!first.ok || !Array.isArray(first.result) || first.page !== 1
        || !Number.isSafeInteger(first.pages) || first.pages < 0 || first.pages > MAX_APP_PAGES
        || first.result.length > APP_PAGE_SIZE || first.pages === 0 && first.result.length !== 0) return { ok: false, result: [] }
    const rest = await Promise.all(Array.from({ length: first.pages - 1 }, (_, index) => probe(`${path}${index + 2}`)))
    if (rest.some((answer, index) => !answer.ok || !Array.isArray(answer.result)
        || answer.pages !== first.pages || answer.page !== index + 2
        || answer.result.length > APP_PAGE_SIZE)) return { ok: false, result: [] }
    const result = [first, ...rest].flatMap(answer => answer.result)
    const ids = result.map(app => app?.id)
    if (ids.some(id => typeof id !== 'string') || new Set(ids).size !== ids.length) return { ok: false, result: [] }
    return { ok: true, result }
  }
  // Unfiltered Access inventory detects path-specific apps that override a host-root app.
  // Only fixed GETs and bounded numeric page suffixes are requested; no origin is contacted.
  const [apps, serviceTokens, workers, tunnel, zones] = await Promise.all([
    accessApps(`/accounts/${accountId}`),
    probe(`/accounts/${accountId}/access/service_tokens?per_page=1`),
    probe(`/accounts/${accountId}/workers/scripts`),
    probe(`/accounts/${accountId}/cfd_tunnel/${TUNNEL}/configurations`),
    probe(`/zones?name=domino.money&account.id=${accountId}&per_page=5`),
  ])
  const executionMatches = matchingApps(apps, HOST)
  const sessionMatches = matchingApps(apps, SESSION_HOST)
  const executionApp = executionMatches.length === 1 ? executionMatches[0] : null
  const sessionApp = sessionMatches.length === 1 ? sessionMatches[0] : null
  const zoneComplete = zones.ok && Array.isArray(zones.result) && zones.pages === 1 && zones.page === 1
  const zoneMatches = zoneComplete ? zones.result.filter(zone => zone?.name === 'domino.money' && zone?.account?.id === accountId && hex32(zone.id)) : []
  const zone = zoneMatches.length === 1 ? zoneMatches[0] : null
  const [zoneApps, policies, workerSettings, workerSecrets, dns] = await Promise.all([
    zone ? accessApps(`/zones/${zone.id}`) : Promise.resolve({ ok: false, result: [] }),
    executionApp && typeof executionApp.id === 'string'
      ? probe(`/accounts/${accountId}/access/apps/${encodeURIComponent(executionApp.id)}/policies?per_page=100`)
      : Promise.resolve({ ok: false, result: null, pages: null }),
    probe(`/accounts/${accountId}/workers/scripts/${WORKER}/settings`),
    probe(`/accounts/${accountId}/workers/scripts/${WORKER}/secrets`),
    zone ? probe(`/zones/${zone.id}/dns_records?name.exact=${HOST}&per_page=5`)
      : Promise.resolve({ ok: false, result: null, pages: null }),
  ])
  const bindings = workerSettings.ok ? rows(workerSettings.result?.bindings) : []
  const setting = name => bindings.find(binding => binding?.type === 'plain_text' && binding.name === name)?.text
  const names = workerSecrets.ok ? rows(workerSecrets.result).filter(secret => secret?.type === 'secret_text').map(secret => secret.name) : []
  const tunnelRules = tunnel.ok ? rows(tunnel.result?.config?.ingress) : []
  const completePolicies = policies.ok && policies.pages === 1 && policies.page === 1
    && Array.isArray(policies.result) ? policies.result : null
  const safePolicies = completePolicies !== null && completePolicies.every(safePolicy)
  const specificServiceAuth = safePolicies && completePolicies.some(policy => policy.decision === 'non_identity')
  const executionRouteExclusive = apps.ok && zoneApps.ok && !!executionApp
    && ![...apps.result, ...zoneApps.result].some(app =>
      app.id !== executionApp.id && appDomains(app).some(overlapsExecution))
  const summary = {
    accessAppsReadable: apps.ok && zoneApps.ok,
    accountAccessAppsReadable: apps.ok,
    zoneAccessAppsReadable: zoneApps.ok,
    sessionAppPresent: !!sessionApp,
    executionAppPresent: !!executionApp,
    executionRouteExclusive,
    executionAppDistinct: executionRouteExclusive && !!sessionApp && typeof executionApp.aud === 'string' && /^[0-9a-f]{64}$/.test(executionApp.aud)
      && typeof sessionApp.aud === 'string' && /^[0-9a-f]{64}$/.test(sessionApp.aud)
      && executionApp.id !== sessionApp.id && executionApp.aud !== sessionApp.aud,
    executionPoliciesReadable: completePolicies !== null,
    executionBroadAccessAbsent: safePolicies,
    executionSpecificServiceAuthPresent: specificServiceAuth,
    serviceTokensReadable: serviceTokens.ok && Array.isArray(serviceTokens.result),
    workersReadable: workers.ok && Array.isArray(workers.result),
    executionWorkerPresent: workerSettings.ok && record(workerSettings.result),
    executionWorkerSettingsReadable: workerSettings.ok,
    executionWorkerDisabled: setting('EXECUTION_BRIDGE_ENABLED') === 'false',
    executionWorkerOriginMatches: setting('EXECUTION_GATEWAY_ORIGIN') === `https://${HOST}`,
    executionWorkerSecretsReadable: workerSecrets.ok && Array.isArray(workerSecrets.result),
    executionWorkerAccessSecretsPresent: names.includes('EXECUTION_ACCESS_CLIENT_ID') && names.includes('EXECUTION_ACCESS_CLIENT_SECRET'),
    tunnelConfigReadable: tunnel.ok && record(tunnel.result?.config) && Array.isArray(tunnel.result.config.ingress),
    executionTunnelHostPresent: tunnelRules.some(rule => rule?.hostname === HOST),
    zoneReadable: zones.ok && Array.isArray(zones.result),
    dnsRecordsReadable: dns.ok && Array.isArray(dns.result),
    executionDnsPresent: dns.ok && rows(dns.result).some(entry => entry?.name === HOST),
  }
  return Object.freeze(summary)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  inspectExecutionCloudflare({ token: process.env.CLOUDFLARE_API_TOKEN, accountId: process.env.CLOUDFLARE_ACCOUNT_ID })
    .then(summary => { process.stdout.write(`${JSON.stringify(summary)}\n`) })
    .catch(() => { process.stderr.write('Cloudflare preflight could not run.\n'); process.exitCode = 1 })
}
