/**
 * The DESIGN of the forwarder family S2 needs (spec F7 §3.2), OFF.
 *
 * NOT WIRED: nothing imports this into app/functions/, functions/_lib/bridge.ts's FAMILIES has no
 * `/api/crosschain/v1/` entry, app/wrangler.toml binds no CROSSCHAIN_BRIDGE, and no crosschain Worker
 * (bridge/src/crosschain-worker.mjs, in onboarding-worker.mjs's mould) or service binding exists. Until the owner's
 * keys, the fee recipient, the Worker and the binding exist (F5 "What the owner must provide"; spec open point 17), a
 * request to that prefix ends at the forwarder's 404 not_found, which the client reads as `not_deployed`.
 *
 * The constant is the exact entry PHASE B adds to FAMILIES, field for field with bridge.ts's `Family`: the family's
 * prefix, its binding, the lowercase contract header passed through, the CSRF header passed through, and the one
 * cookie its Worker reads.
 */
export const CROSSCHAIN_FAMILY_DESIGN = Object.freeze({
  prefix: '/api/crosschain/v1/',
  binding: 'CROSSCHAIN_BRIDGE',
  contract: 'x-domino-crosschain-contract',
  csrf: true,
  cookies: Object.freeze(['__Host-domino-session'] as const),
} as const)

/** The production service binding PHASE B adds to app/wrangler.toml (`[[env.production.services]]`), never to preview. */
export const CROSSCHAIN_BINDING_DESIGN = Object.freeze({ binding: 'CROSSCHAIN_BRIDGE', service: 'domino-crosschain-bridge' } as const)
