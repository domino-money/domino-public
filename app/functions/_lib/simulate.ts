/**
 * POST /api/chain/v1/simulate (RPC-SPEC §2.5.6, §11.4): a batch of calls simulated on Domino's node for a wallet that
 * cannot simulate it itself (finance/batch.ts BatchSimulator), behind the deployment's flag LOCAL_RPC_SIMULATE, off
 * unless it is exactly "true". Off, the page goes on step by step, as it already does for such wallets. Changed on
 * purpose 2026-10-02 (rugged97 confirmed that his node serves eth_simulateV1): wrangler.toml turns it on in both
 * environments.
 *
 * One fixed upstream call: eth_simulateV1 of one block of the owner's 1..SIMULATE_CALLS calls, without validation, at the head,
 * each call's gas bounded (simulateGas); no state override and no other block. The answer is trimmed to each call's status and gas, and a reply of any other shape
 * is not handed on.
 */
import { MULTICALL3, RPC_URL, hex } from './owned'
import type { SimulateCall, SimulateRequest } from '../../src/lib/edge/chainRoutes'

export const SIMULATE_BODY_BYTES = 65_536
/**
 * The most calls one simulation may name. Changed on purpose 2026-10-02 (review finding 17): 8, but Create position's
 * largest batch (finance/setup.ts prepareBatch: a routed one-token deposit with a Permit2 allowance to reset and both pool
 * tokens' allowances to reset) is 10 calls, which the route refused, so such a wallet lost the one-signature batch and
 * the Uniswap route; 12 leaves room.
 */
export const SIMULATE_CALLS = 12
export const SIMULATE_DATA_CHARS = 32_770
/**
 * The most gas one simulated call may use, and all of a simulation's calls together. Changed on purpose 2026-10-02 (review
 * of rugged97's rules, finding 15: a call named no gas, so a caller's calls, to any contract, ran to the node's own cap,
 * up to twelve of them): each call gets its share of SIMULATE_TOTAL_GAS, at most SIMULATE_CALL_GAS. The page refuses a
 * batch whose gas, with its frame and margin, is past its own budget of 15,000,000 (finance/setup.ts, finance/sequence.ts),
 * so a batch it would send uses less than either.
 */
export const SIMULATE_CALL_GAS = 15_000_000
export const SIMULATE_TOTAL_GAS = 30_000_000
/** Each call's gas in a simulation of `count` calls. */
export const simulateGas = (count: number) => Math.min(SIMULATE_CALL_GAS, Math.floor(SIMULATE_TOTAL_GAS / Math.max(1, count)))

const ADDRESS = /^0x[0-9a-f]{40}$/
const DATA = /^0x(?:[0-9a-f]{2})*$/
const QUANTITY = /^0x(?:0|[1-9a-f][0-9a-f]*)$/
const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const keysAre = (value: Record<string, unknown>, keys: readonly string[]) => Object.keys(value).length === keys.length && keys.every((key) => key in value)

/** Whether the deployment turned the simulation on (the plain var LOCAL_RPC_SIMULATE, exactly "true"). */
export const simulateEnabled = (env: { LOCAL_RPC_SIMULATE?: string }) => env.LOCAL_RPC_SIMULATE === 'true'

/**
 * A simulate body as a SimulateRequest, or null unless it is exactly one (exact keys, lowercase hex, 1..SIMULATE_CALLS
 * calls). Changed on purpose 2026-10-02 (finding 15): no call to Multicall3, whose aggregate3 would carry past rugged97's
 * fifty calls a multicall (rule 5); the page's batches never name it.
 */
export function simulateRequestOf(body: Record<string, unknown>): SimulateRequest | null {
  if (!keysAre(body, ['owner', 'calls']) || typeof body.owner !== 'string' || !ADDRESS.test(body.owner)) return null
  const calls = body.calls
  if (!Array.isArray(calls) || calls.length < 1 || calls.length > SIMULATE_CALLS) return null
  const out: SimulateCall[] = []
  for (const call of calls) {
    if (!isRecord(call) || !keysAre(call, ['to', 'data', 'value'])) return null
    const { to, data, value } = call
    if (typeof to !== 'string' || !ADDRESS.test(to) || to === MULTICALL3 || typeof data !== 'string' || !DATA.test(data) || data.length > SIMULATE_DATA_CHARS || typeof value !== 'string' || !QUANTITY.test(value) || value.length > 66) return null
    out.push({ to, data, value })
  }
  return { owner: body.owner, calls: out }
}

/** The one eth_simulateV1 call of a request, as the node is asked it: each call with its share of the gas (finding 15). */
export const simulateEnvelope = (asked: SimulateRequest) => ({
  jsonrpc: '2.0',
  id: 1,
  method: 'eth_simulateV1',
  params: [{ blockStateCalls: [{ calls: asked.calls.map(({ to, data, value }) => ({ from: asked.owner, to, data, value, gas: hex(simulateGas(asked.calls.length)) })) }], validation: false }, 'latest'],
})

/** What the node's simulation came to, as the route answers it. */
export type Simulated = { kind: 'result'; result: [{ calls: { status: '0x0' | '0x1'; gasUsed: string }[] }] } | { kind: 'unsupported' } | { kind: 'failed' } | { kind: 'invalid' }

/** A method the node does not serve: -32601, or its words. */
const UNSUPPORTED = /\bmethod\b.*\b(?:not (?:found|supported|available)|unsupported|does not exist)\b/i

/** The node's JSON-RPC envelope for `asked`: its trimmed result, the method missing, a failed simulation, or a reply of another shape. */
export function simulatedOf(envelope: unknown, asked: SimulateRequest): Simulated {
  if (!isRecord(envelope)) return { kind: 'invalid' }
  if (envelope.error !== undefined && envelope.error !== null) {
    const error = isRecord(envelope.error) ? envelope.error : {}
    return error.code === -32601 || (typeof error.message === 'string' && UNSUPPORTED.test(error.message)) ? { kind: 'unsupported' } : { kind: 'failed' }
  }
  const blocks = envelope.result
  if (!Array.isArray(blocks) || blocks.length !== 1 || !isRecord(blocks[0]) || !Array.isArray(blocks[0].calls) || blocks[0].calls.length !== asked.calls.length) return { kind: 'invalid' }
  const calls: { status: '0x0' | '0x1'; gasUsed: string }[] = []
  for (const call of blocks[0].calls as unknown[]) {
    if (!isRecord(call) || (call.status !== '0x0' && call.status !== '0x1') || typeof call.gasUsed !== 'string' || !QUANTITY.test(call.gasUsed)) return { kind: 'invalid' }
    calls.push({ status: call.status, gasUsed: call.gasUsed })
  }
  return { kind: 'result', result: [{ calls }] }
}

/**
 * The simulation through the node transport's fetch (purpose 'simulate'): its outcome, or the Response the transport
 * handed back (a 429 to wait out, a 502). Throws what the transport throws (the node down, its time-out).
 */
export async function simulateOnNode(fetchChain: (input: string, init: RequestInit) => Promise<Response>, asked: SimulateRequest, signal?: AbortSignal): Promise<Simulated | Response> {
  const response = await fetchChain(RPC_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(simulateEnvelope(asked)), signal })
  if (response.status !== 200) return response
  let envelope: unknown
  try {
    envelope = await response.json()
  } catch {
    return { kind: 'invalid' }
  }
  return simulatedOf(envelope, asked)
}
