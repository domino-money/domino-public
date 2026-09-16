/**
 * X-Domino-Request-Id in the two shapes Domino's own hops write, and no other:
 * - a bridge Worker's crypto.randomUUID(), what production browsers see
 *   (bridge/src/worker.mjs, authenticated-worker.mjs, session-worker.mjs);
 * - a Python gateway's secrets.token_hex(16), 32 lowercase hex
 *   (backend/read_gateway.py, backend/dev_read_gateway.py), which reaches a
 *   browser only through the local-live proxy (app/scripts/local-live-proxy.mjs).
 * A support identifier: kept on provenance, never rendered as text.
 */
const WORKER_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const GATEWAY_ID = /^[0-9a-f]{32}$/

export function requestIdOf(header: string | null | undefined): string | null {
  return typeof header === 'string' && (WORKER_ID.test(header) || GATEWAY_ID.test(header)) ? header : null
}
