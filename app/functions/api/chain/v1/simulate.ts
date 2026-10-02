/**
 * POST /api/chain/v1/simulate: eth_simulateV1 for a wallet that lacks it, behind LOCAL_RPC_SIMULATE (off unless "true")
 * (RPC-SPEC §2.5.6), answered from Domino's own Robinhood Chain node by functions/_lib/chainRoutes.ts. Pages routes
 * this path here, ahead of functions/api/[[path]].ts: a route with only static segments is more specific than the
 * catch-all. The beta gate in functions/_middleware.ts runs first, as for every /api path; an admitted request arrives
 * with no cookie at all, and its answer leaves with no-store and the API CSP.
 */
import { answerChainRoute, type ChainRouteContext } from '../../../_lib/chainRoutes'

export const onRequest = (context: ChainRouteContext) => answerChainRoute('simulate', context)
