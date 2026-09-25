/**
 * POST /api/fees/v1/logs: one pool's or one position NFT's event logs, in
 * fixed units, read from the chain's public RPC by functions/_lib/fees.ts,
 * validated, compacted and kept in the Workers cache. A relay over fixed
 * methods, contracts and topics, never a general RPC proxy.
 *
 * Routed and gated like functions/api/fees/v1/state.ts.
 */
import { answerLogs, refusal, runtimeOf } from '../../../_lib/fees'

interface Context {
  request: Request
  waitUntil?: (work: Promise<unknown>) => void
}

export async function onRequest(context: Context): Promise<Response> {
  try {
    return await answerLogs(context.request, runtimeOf(context))
  } catch {
    return refusal('rpc_unavailable', 502)
  }
}
