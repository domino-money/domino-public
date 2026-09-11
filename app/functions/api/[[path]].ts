/**
 * Every /api/* request the gate admits ends here, but one with an empty
 * segment. forward() hands it to its family's bridge Worker or refuses it as
 * JSON; see functions/_lib/bridge.ts. Without this route Pages would answer an
 * unknown /api path with index.html and a 200.
 *
 * Pages routes a path here when /api/:path* matches it, and that match takes
 * non-empty segments only: /api//x never arrives. The middleware hands such a
 * path to forward() itself (onward() in functions/_middleware.ts).
 */
import { forward, type BridgeEnv } from '../_lib/bridge'

export function onRequest({ request, env }: { request: Request; env: BridgeEnv }): Promise<Response> {
  return forward(request, env)
}
