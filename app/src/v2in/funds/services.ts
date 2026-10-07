/**
 * What the inline offer talks to (spec F7 §3.2), by the gate's answer for S2 on the position's chain (src/v2/gate.ts,
 * which asks the crosschain route's own capabilities):
 *
 *   - `off`: nothing. The amount step is V1's, exactly.
 *   - `preview` (the preview alias and the development server, while the route is not on): nothing either. The owner,
 *     2026-10-02 night: no fixtures and no test data anywhere, real data only; where a function cannot run yet it says
 *     so. The offer then runs LOCKED (./BringFunds.tsx): what the wallet holds on other networks is still read through
 *     the wallet's own provider (./Holdings.tsx), and Bring says FUNDS_TEXT.locked.
 *   - `live` (the route serves origins and quote): the crosschain-v1 client over the HTTP transport (Changed on purpose
 *     (data) 2026-10-02 (S2 wired), open point #17's app side: constants.ts FUNDS_HTTP_TRANSPORT_WIRED).
 *
 * The client is v2/crosschain/client.ts over the package runtime (v2/crosschain/contract.ts), so every reply passes
 * `validateResponse` / `validateError` and the owner echo before the offer sees it. What reaches the page (the site's
 * route, the signed-in session's CSRF, the runtime, the page's monotonic clock) is handed in (`FundsPage`, built by
 * ./live.ts), the way src/v2in/transports.ts hands the page's routes to src/v2in/dataSource.ts: this module stays pure,
 * so the node tests run the choice (tests/v2/funds-source.test.mjs) without the page. The quote's deadline is on that
 * clock.
 */
import { createCrosschainClient, type CrosschainClient } from '../../v2/crosschain/client'
import type { CrosschainTransport } from '../../v2/crosschain/transport'
import type { CrosschainClock, CrosschainSession, CrosschainValidators } from '../../v2/crosschain/types'
import type { V2Gate } from '../../v2/gate'
import { FUNDS_HTTP_TRANSPORT_WIRED } from './constants'
import { fundsSource } from './model'
import type { BalanceRead } from './reconcile'

export interface FundsServices {
  client: CrosschainClient
  runtime: CrosschainValidators
  clock: CrosschainClock
  source: CrosschainClient['transportKind']
  /** The wallet every answer must be about: the connected wallet. */
  owner: string
  /** A wait on the page's timers. */
  wait(ms: number): Promise<void>
  /** A timer for the quote's deadline. Returns its cancel. */
  deadlineTimer(callback: () => void, ms: number): () => void
  /** Destination balances through the read service, without changing the wallet network. */
  readBalances?(chainId: number, tokens: readonly string[]): Promise<BalanceRead>
}

/** The parts of the page a live chain's client is made of (./live.ts): the HTTP transport, never a fixture one. */
export interface FundsPage {
  live(): { transport: CrosschainTransport; runtime: CrosschainValidators; session: CrosschainSession; clock: CrosschainClock }
  balances?(gate: V2Gate, owner: string, chainId: number, tokens: readonly string[]): Promise<BalanceRead>
}

/**
 * The offer's services under `gate` for the connected wallet `owner` (every answer on a live chain must be about it), or
 * null while the service is not there to talk to (`off`, `preview`). Nothing is ever built from test data in their
 * place: a page whose transport is not the HTTP one gets no services either.
 */
export function fundsServices(gate: V2Gate, owner: string, page: FundsPage): FundsServices | null {
  const source = fundsSource(gate.mode, FUNDS_HTTP_TRANSPORT_WIRED)
  if (source === null) return null
  const { transport, runtime, session, clock } = page.live()
  if (transport.kind !== source) return null
  const client = createCrosschainClient({ transport, runtime, session, clock })
  // Deposits arriving together share the in-flight destination read. No settled balance is cached here.
  const balanceReads = new Map<string, Promise<BalanceRead>>()
  const readBalances = (chainId: number, tokens: readonly string[]): Promise<BalanceRead> => {
    const asked = [...new Set(tokens.map((token) => token.toLowerCase()))].sort()
    const key = `${chainId}|${asked.join(',')}`
    const pending = balanceReads.get(key)
    if (pending) return pending
    const request = Promise.resolve().then(() => page.balances?.(gate, owner.toLowerCase(), chainId, asked) ?? { kind: 'unavailable' as const })
    balanceReads.set(key, request)
    void request.finally(() => { if (balanceReads.get(key) === request) balanceReads.delete(key) }).catch(() => {})
    return request
  }
  return {
    client,
    runtime,
    clock,
    source: client.transportKind,
    owner: owner.toLowerCase(),
    wait: (ms) =>
      new Promise<void>((done) => {
        clock.setTimer(done, ms)
      }),
    deadlineTimer: (callback, ms) => clock.setTimer(callback, ms),
    readBalances,
  }
}
