/**
 * The reads the wallet feature asks of the site (RPC-SPEC, 2026-10-01, the owner's rule: nothing is read from a public
 * RPC). Two callers ask them:
 * - a WalletConnect wallet on a phone answers no reads, so its provider asks them here (wallet/walletConnect.ts);
 * - a read the connected wallet's own RPC could not answer is asked here once more (finance/wallet.ts, audit C6).
 *
 * None is served (RPC-SPEC D6): the site has no general line to the chain any more, only fixed routes with fixed
 * purposes. A read is refused at once, with no network call, as a read the chain could not answer (-32603), under its own
 * message, SITE_READS_UNAVAILABLE. Changed on purpose 2026-10-02 (review of the RPC switch, finding 16): finance/setup.ts
 * tells that refusal from a wallet's own RPC failing. When the wallet's own request met it (a WalletConnect wallet, which
 * hands its reads to the page), the step says so (`site_reads_unavailable`: not available yet for such a wallet), never
 * "check your wallet's RPC", which was never asked; when it is the C6 fallback's (the wallet's RPC failed first), the
 * step still says `wallet_rpc_unreachable`, which is true.
 *
 * The one exception is a batch's simulation (RPC-SPEC D7), for a wallet that does not carry the method itself: the
 * site's fixed route /api/chain/v1/simulate, which wrangler.toml turns on in both environments (since 2026-10-02, when
 * rugged97 confirmed his node serves it). Where it is off, or when Domino's node does not carry the method, the
 * simulation is "not available" (-32601), so finance/batch.ts gives
 * `batch_simulation_unavailable` and Create position and Set up automation go on step by step, as they already do for
 * a wallet without it.
 */
import { postSimulate, type RouteOptions, type SimulateAnswer, type SimulateCall } from './edge/chainRoutes'

/** The simulation's one method name, the only one this module ever compares against. */
const SIMULATE = 'eth_simulateV1'
const ADDRESS = /^0x[0-9a-fA-F]{40}$/
const DATA = /^0x(?:[0-9a-fA-F]{2})*$/
const QUANTITY = /^0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)$/

const refused = (message: string, code: number) => Object.assign(new Error(message), { code })
const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const keysAre = (value: Record<string, unknown>, keys: readonly string[]) => Object.keys(value).sort().join() === [...keys].sort().join()

/** The message of the site's own refusal of a read (finance/setup.ts readThrough tells it by this exact text). */
export const SITE_READS_UNAVAILABLE = 'site_reads_unavailable'

/** A read the wallet feature asked of the site (WalletConnect, or the C6 fallback): none is served (RPC-SPEC D6). */
export async function readOnChain(method: string, params: readonly unknown[], _heavy = false): Promise<unknown> {
  if (method === SIMULATE) return simulateOnChain(params as unknown[])
  throw refused(SITE_READS_UNAVAILABLE, -32603)
}

/**
 * The owner and the calls of exactly the simulation finance/batch.ts asks: `[{ blockStateCalls: [{ calls }], validation:
 * false }, 'latest']`, every call `{ from, to, data, value }` from one owner. Null for anything else.
 */
function simulationOf(params: unknown): { owner: string; calls: SimulateCall[] } | null {
  if (!Array.isArray(params) || params.length !== 2 || params[1] !== 'latest') return null
  const [options] = params as unknown[]
  if (!isRecord(options) || !keysAre(options, ['blockStateCalls', 'validation']) || options.validation !== false) return null
  const blocks = options.blockStateCalls
  if (!Array.isArray(blocks) || blocks.length !== 1 || !isRecord(blocks[0]) || !keysAre(blocks[0], ['calls'])) return null
  const calls = blocks[0].calls
  if (!Array.isArray(calls) || calls.length === 0) return null
  let owner: string | null = null
  const out: SimulateCall[] = []
  for (const call of calls as unknown[]) {
    if (!isRecord(call) || !keysAre(call, ['from', 'to', 'data', 'value'])) return null
    const { from, to, data, value } = call
    if (typeof from !== 'string' || !ADDRESS.test(from) || typeof to !== 'string' || !ADDRESS.test(to)) return null
    if (typeof data !== 'string' || !DATA.test(data) || typeof value !== 'string' || !QUANTITY.test(value)) return null
    // Every call is the same account's (finance/batch.ts simulates the owner's own execution).
    owner ??= from.toLowerCase()
    if (from.toLowerCase() !== owner) return null
    // Hex the route takes in one case only (lowercase); the same numbers and bytes.
    out.push({ to: to.toLowerCase(), data: data.toLowerCase(), value: value.toLowerCase() })
  }
  return owner ? { owner, calls: out } : null
}

/** What each answer of the simulate route is to finance/batch.ts: a result, "not available", or a read that failed. */
function settled(answer: SimulateAnswer): unknown {
  if (answer.ok) return answer.result
  if (answer.reason === 'not_enabled' || answer.reason === 'unsupported') throw refused(`${SIMULATE} is not available`, -32601)
  throw refused('chain_read_unavailable', -32603)
}

/** finance/batch.ts BatchSimulator over /api/chain/v1/simulate (RPC-SPEC D7). `options`: tests only (the network call). */
export async function simulateOnChain(params: unknown[], options?: RouteOptions): Promise<unknown> {
  const simulation = simulationOf(params)
  if (!simulation) throw refused('invalid_simulation_params', -32602)
  return settled(await postSimulate(simulation, options))
}
