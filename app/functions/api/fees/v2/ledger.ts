/**
 * POST /api/fees/v2/ledger: a position NFT's own ledger of settlements, for its Fees earned and Your APR (RPC-SPEC §11.4,
 * functions/_lib/feesLedger.ts), answered from Domino's own Robinhood Chain node by functions/_lib/chainRoutes.ts. Pages
 * routes this path here, ahead of functions/api/[[path]].ts: a route with only static segments is more specific than the
 * catch-all. The beta gate in functions/_middleware.ts runs first, as for every /api path; an admitted request arrives
 * with no cookie at all, and its answer leaves with no-store and the API CSP.
 */
import { answerChainRoute, type ChainRouteContext } from '../../../_lib/chainRoutes'

export const onRequest = (context: ChainRouteContext) => answerChainRoute('ledger', context)
