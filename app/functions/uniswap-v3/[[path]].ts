/**
 * /uniswap-v3/* : rugged97's Uniswap v3 services for the second chain's section, through this site's edge
 * (functions/_lib/uniswap-v3/handler.ts holds the rules; the chain2 workstream, audit item G9, part B). Pages routes here
 * after the root middleware, which treats this prefix as an API: no-store, the API CSP, every cookie removed, and a path
 * with an empty segment refused there (functions/_middleware.ts). Until rugged97's bridge Worker is bound as
 * ELYSIUM_BRIDGE, every path answers 404 {"error":"not_enabled"}.
 */
export { onUniswapV3Request as onRequest } from '../_lib/uniswap-v3/handler'
