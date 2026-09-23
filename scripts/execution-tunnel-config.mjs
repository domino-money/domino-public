/** Pure candidate for the distinct execution-status Tunnel ingress. No I/O.
 * The execution Access application/audience must be provisioned separately;
 * this code never borrows the session audience or service token.
 */
import { isDeepStrictEqual } from 'node:util'
import { domainToASCII } from 'node:url'

export const EXECUTION_TUNNEL_ID = '31526265-ca63-40f2-bbb7-bd37a537f899'
export const EXECUTION_HOST = 'vm-execution.domino.money'
export const EXECUTION_PATH = '^/internal/execution/v1/(availability|status|list)$'
const SESSION_HOST = 'vm-session.domino.money'
const SESSION_PATH = '^/internal/session/v1/(bootstrap|challenge|verify|refresh|logout|me)$'
const SESSION_AUDIENCE = '213e1bd4f444f439af6a2a3bccceff7d369392d079cf052e38d0972d4d8da7e0'

function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
}

function refuse() { throw new Error('execution_tunnel_configuration_mismatch') }

function couldShadowExecution(rule) {
  const host = rule.hostname
  // cloudflared treats an empty host as unscoped and matches wildcard hosts
  // by suffix, including *.money. IDNA aliases also match the ASCII host.
  if (typeof host !== 'string' || host === '' || host.includes('*')) return true
  const normalized = domainToASCII(host).replace(/\.$/u, '')
  return normalized === '' || normalized === EXECUTION_HOST
}

/** Accept the inspected production session rule and an operator-supplied new
 * execution Access audience. Add exactly one anchored rule before the final
 * 404; reject drift, duplicate routes and a reused session audience.
 */
export function extendExecutionTunnelConfig(tunnelId, config, { executionAudience } = {}) {
  if (tunnelId !== EXECUTION_TUNNEL_ID || !record(config) || !Array.isArray(config.ingress)
      || config.ingress.length < 2 || !config.ingress.every(record)
      || typeof executionAudience !== 'string' || !/^[0-9a-f]{64}$/u.test(executionAudience)
      || executionAudience === SESSION_AUDIENCE) refuse()
  const ingress = config.ingress
  const last = ingress.length - 1
  if (!isDeepStrictEqual(ingress[last], { service: 'http_status:404' })) refuse()

  const sessionRules = ingress.filter(rule => rule.hostname === SESSION_HOST)
  if (sessionRules.length !== 1) refuse()
  const session = sessionRules[0]
  const access = session.originRequest?.access
  if (session.path !== SESSION_PATH || session.service !== 'http://127.0.0.1:8879'
      || !record(session.originRequest) || !record(access) || access.required !== true
      || typeof access.teamName !== 'string'
      || !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(access.teamName)
      || !isDeepStrictEqual(access.audTag, [SESSION_AUDIENCE])) refuse()

  // cloudflared selects the first match. Refuse a prior wildcard, unscoped or
  // aliased hostname that could intercept the new host before its exact rule.
  if (ingress.slice(0, last).some(rule => rule.hostname !== EXECUTION_HOST
      && couldShadowExecution(rule))) refuse()
  if (ingress.some(rule => rule.hostname !== EXECUTION_HOST
      && Array.isArray(rule.originRequest?.access?.audTag)
      && rule.originRequest.access.audTag.includes(executionAudience))) refuse()

  const expected = {
    hostname: EXECUTION_HOST,
    path: EXECUTION_PATH,
    service: 'http://127.0.0.1:8901',
    originRequest: { access: { required: true, teamName: access.teamName,
      audTag: [executionAudience] } },
  }
  const existing = ingress.filter(rule => rule.hostname === EXECUTION_HOST)
  if (existing.length > 1 || existing.length === 1 && !isDeepStrictEqual(existing[0], expected)) refuse()

  const result = structuredClone(config)
  if (existing.length === 0) result.ingress.splice(last, 0, expected)
  return result
}
