/**
 * Is this preview about what was asked, and for whom?
 *
 * The runtime proves the shape. These prove the answer belongs to the request
 * this page sent (INV-2) and to the signed-in owner (S-5): the bridge cannot
 * compare the owner by design, so a preview for anyone else is dropped here.
 */
import type { OnboardingRequests, OnboardingRoute, PreviewOf } from './types'

const lower = (value: string) => value.toLowerCase()

/** Fields that name a token, pool or currency: compared without regard to case. */
const IDENTITY_FIELDS = new Set(['tokenIn', 'tokenOut', 'poolId', 'independentToken'])
const POOL_KEY_IDENTITY = new Set(['currency0', 'currency1', 'hooks'])
const POSITION_OPTIONAL = ['budget0Raw', 'budget1Raw', 'nativeBalanceRaw', 'nativeGasReserveRaw'] as const

/** The request as the worker echoes it: every optional position field present, null when not sent. */
export function withExplicitNulls<R extends OnboardingRoute>(route: R, request: OnboardingRequests[R]): Record<string, unknown> {
  const out: Record<string, unknown> = { ...request }
  if (route === 'position-preview') for (const key of POSITION_OPTIONAL) if (out[key] === undefined) out[key] = null
  return out
}

function sameKeys(a: object, b: object): boolean {
  const x = Object.keys(a).sort()
  const y = Object.keys(b).sort()
  return x.length === y.length && x.every((key, i) => key === y[i])
}

function samePoolKey(a: unknown, b: unknown): boolean {
  if (typeof a !== 'object' || a === null || typeof b !== 'object' || b === null || !sameKeys(a, b)) return false
  const x = a as Record<string, unknown>
  const y = b as Record<string, unknown>
  return Object.keys(x).every((key) =>
    POOL_KEY_IDENTITY.has(key) && typeof x[key] === 'string' && typeof y[key] === 'string'
      ? lower(x[key] as string) === lower(y[key] as string)
      : x[key] === y[key],
  )
}

/** `preview.request` minus `owner` equals the request sent, field for field. */
export function echoMatches<R extends OnboardingRoute>(route: R, sent: OnboardingRequests[R], preview: PreviewOf<R>): boolean {
  const expected = withExplicitNulls(route, sent)
  const { owner: _owner, ...echoed } = preview.request as unknown as Record<string, unknown>
  void _owner
  if (!sameKeys(expected, echoed)) return false
  return Object.keys(expected).every((key) => {
    const want = expected[key]
    const got = echoed[key]
    if (key === 'poolKey') return samePoolKey(want, got)
    if (IDENTITY_FIELDS.has(key) && typeof want === 'string' && typeof got === 'string') return lower(want) === lower(got)
    return want === got
  })
}

/** The preview was computed for the signed-in owner. */
export function ownerMatches<R extends OnboardingRoute>(preview: PreviewOf<R>, sessionOwner: string): boolean {
  return lower(preview.request.owner) === lower(sessionOwner)
}
