/**
 * The S1 plan API, the app's side: `position-plan-v1`, contract `1.0.0-rc.2` (spec F7 rev2 §2.4, decision #1: the
 * server builds the plan and the app verifies it; api-contracts/position-plan-v1, PR #308). One route,
 * `POST /api/position-plan/v1/plan`, through the authenticated bridge (SIWE session and CSRF), header
 * `X-Domino-Position-Plan-Contract: 1.0.0-rc.2`. The owner is always the session's wallet: no request names an owner
 * or a recipient.
 *
 * Raw integers are decimal strings on the wire, bigint once parsed. Every Domino address in an answer is checked
 * against the chain's pinned manifest and never used as a source (§2.4, §7.3 rule 6).
 *
 * Pure: no viem, no wallet (screens may import it). The package's runtime is handed in (`S1PlanValidators`), as
 * src/v2/crosschain and src/v2/read/v6.ts do: only ./contract.ts imports it, and only src/v2ui reaches that.
 */
import type { PlanDocument, PositionPlanErrorCode } from 'api-contracts/position-plan-v1/types'
import type { Address, ActionName, Dex, Hex, PoolRef, V2ChainId, ZapPlan } from '../types'

export const S1_PLAN_CONTRACT_VERSION = '1.0.0-rc.2' as const
export const S1_PLAN_HEADER = 'X-Domino-Position-Plan-Contract' as const
export const S1_PLAN_PATH = '/api/position-plan/v1/plan' as const

/** How the plan is consented to. 'relayed' is never asked: no relayer exists (decision #4). */
export type S1PlanConsent = 'direct' | 'permit2'

/** `receive` on an exit: both tokens, or converted to one token. */
export type S1Receive = 'both' | { convertTo: Address }

/** A new pool's starting price as asked (§2.6.5), with the app's own exact value for check 13. */
export interface S1InitialPrice {
  /** The plan API's `initialPrice.price` text: one whole `baseToken` is worth this many whole tokens of the other currency. */
  price: string
  baseToken: Address
  decimals0: number
  decimals1: number
  /** What the app computed from the typed price (./initialPrice.ts): the plan's initSqrtPriceX96 must equal it. */
  sqrtPriceX96: bigint
}

/** The request as the app builds it (before it is written to the wire). */
export interface S1PlanRequest {
  chainId: V2ChainId
  action: ActionName
  consent: S1PlanConsent
  /** create only. */
  pool?: PoolRef
  /** increase, change range, exit. */
  position?: { dex: Dex; tokenId: bigint }
  /** create and change range. */
  tickLower?: number
  tickUpper?: number
  /** create and increase: what the wallet puts in (native ETH is address(0)). */
  inputs?: readonly { token: Address; amount: bigint }[]
  /** change range and exit: 'all', or raw liquidity (0 collects the fees on an exit). */
  liquidityToRemove?: 'all' | bigint
  /** change range (burnOld) and exit (burn). */
  burn?: boolean
  /** exit only. */
  receive?: S1Receive
  /** create of a pool with no price only. */
  initialPrice?: S1InitialPrice
  slippageBps: number
}

/** The package's validators (api-contracts/position-plan-v1/runtime.mjs), handed in. */
export interface S1PlanValidators {
  readonly CONTRACT_VERSION: string
  readonly ERROR_STATUS_BY_CODE: Readonly<Record<string, number>>
  validateRequest(route: 'plan', value: unknown): boolean
  validateResponse(route: 'plan', value: unknown): boolean
  validateError(status: number, value: unknown): boolean
}

/** What the app holds the answer to, beyond the request: who asked, on what, and the manifest's and profile's addresses. */
export interface S1PlanContext {
  /** The connected wallet (lowercase): the session's, the plan's owner and recipient. */
  owner: Address
  /**
   * The chain's pinned Domino zaps (the manifest's), by DEX. Changed on purpose 2026-11-06 (Elysium readiness): those of
   * the chain's versions only, so an answer about a version the chain lacks (v3 on a chain with v4 alone) is refused.
   */
  zaps: Readonly<Partial<Record<Dex, Address>>>
  /** The chain profile's Permit2 and Uniswap position managers (api-contracts/v2/chains), never the answer's; by version, as `zaps`. */
  permit2: Address
  managers: Readonly<Partial<Record<Dex, Address>>>
  /** Unix seconds now. */
  now: number
}

/** The quote's leg, as the review shows it and the zap client takes it. */
export interface S1QuotedLeg {
  expectedOut: bigint
  minAmountOut: bigint
  pools: readonly { dex: 3 | 4; fee: number; hooks: Address }[]
}

/** The quote in the shape the zap client takes (finance/v2/zap.ts ZapQuote): structurally the same. */
export interface S1Quote {
  requestedAt: number
  expiresAt: number
  legs: readonly S1QuotedLeg[]
  /** The server's simulation (check 11's first half): `ok` also for `not_run` with `approvals_missing` (an app choice, see ./parse.ts). */
  simulation: { ok: boolean; block: bigint; error: string | null }
  /** What a change of range or an exit is expected to take out of the position (principal and fees), per currency. */
  expectedRemoved?: readonly [bigint, bigint]
  /** The registry ranks the plan's fee rule used (`fee.ranks`): the zap client checks them against the registry it reads (check 2). */
  ranks: readonly { token: Address; rank: number }[]
  /**
   * What the plan's minimums were computed from (finance/v2/plan.ts PlanBasis): the zap client ties them to its own reads
   * at the review and to its own simulation of the call. Changed on purpose (data) 2026-10-02 (Domino V2 rev2 review, F4).
   */
  basis: S1PlanBasis
}

/** A band of sqrt prices, both ends included (position-plan-v1 `minimums.mintBand` / `removalBand`). */
export interface S1SqrtBand {
  lower: bigint
  upper: bigint
}

/** What the plan's minimums were computed from: structurally finance/v2/plan.ts PlanBasis. */
export interface S1PlanBasis {
  slippageBps: number
  poolSqrtPriceX96: bigint | null
  sqrtPriceX96After: bigint | null
  expectedLiquidity: bigint
  mintBand: S1SqrtBand | null
  removalBand: S1SqrtBand | null
  position: { tickLower: number; tickUpper: number; liquidity: bigint } | null
}

/** The L1 data fee of the action's transaction at the plan's block (§2.4), apart from the L2 gas. */
export type S1L1DataFee =
  | { status: 'ok'; source: 'op_gas_price_oracle'; wei: bigint; upperBoundWei: bigint | null }
  | { status: 'ok'; source: 'nitro_node_interface'; wei: bigint; l1GasUnits: bigint; l2BaseFeeWei: bigint }
  | { status: 'unavailable'; source: 'op_gas_price_oracle' | 'nitro_node_interface' }

/** What a parsed plan holds beyond the plan: the quote's figures, exact, for the review. */
export interface S1PlanFacts {
  contractVersion: typeof S1_PLAN_CONTRACT_VERSION
  block: { number: bigint; timestamp: number }
  requestedAt: number
  retrievedAt: number
  /** Consent is never asked at or after this (a 3-minute quote, decision #3). */
  expiresAt: number
  /** The intent's and the permit's deadline (requestedAt + 300, decision #3). */
  deadline: bigint
  expected: {
    liquidity: bigint
    /** What goes into the position, per pool currency. */
    amounts: readonly [bigint, bigint]
    sqrtPriceX96After: bigint | null
    /** Change of range and exit: what the removal takes out (principal, fees), per currency. */
    principal: readonly [bigint, bigint] | null
    fees: readonly [bigint, bigint] | null
    /** What comes back to the wallet, per token. */
    returned: readonly { token: Address; amount: bigint }[]
  }
  minimums: {
    liquidity: bigint
    slippageBps: number
    removed: readonly [bigint, bigint] | null
  }
  /** The Domino fee as planned: null without legs ("No Domino fee"). */
  fee: { token: Address; place: 'input' | 'output' | 'hop' | 'fallback'; basis: bigint; amount: bigint } | null
  /** The simulation's L2 execution gas (not the L1 part), or null when it did not run. */
  gasUnits: bigint | null
  l1DataFee: S1L1DataFee
  /** The pool as read at the plan's block (null price for a pool with none). */
  pool: { id: Hex; initialized: boolean; sqrtPriceX96: bigint | null; tick: number | null }
  /** A new pool's starting price, both ways round from the integer. */
  initialPrice: { sqrtPriceX96: bigint; tick: number; price0In1: string; price1In0: string } | null
  /** The position as read (increase, change range, exit). */
  position: { tokenId: bigint; tickLower: number; tickUpper: number; liquidity: bigint; feesOwed: readonly [bigint, bigint]; inRange: boolean } | null
  /** Each leg's source and pools, for the review's route. */
  legs: readonly { source: string; pools: readonly { dex: 3 | 4; fee: number }[] }[]
  routing: string
  simulation: { status: 'ok' | 'reverted' | 'not_run'; reason: string | null; method: string | null }
  warnings: readonly string[]
}

export interface S1PlanReply {
  plan: ZapPlan
  quote: S1Quote
  facts: S1PlanFacts
  /** The plan answer as validated (for Details; never a source of addresses). */
  document: PlanDocument
}

/**
 * Why an answer was not used:
 *   - `refused`: the service said no, with its code (§2.4's table), validated by the package's `validateError`;
 *   - `expired`: the plan came back at or after its `expiresAt` (re-quoted silently, like `preview_expired`);
 *   - `unavailable`: the service could not be reached, or answered with no contract body (`reason`);
 *   - `invalid`: it answered something this app does not accept (the first check that failed);
 *   - `reverted`: its simulation reverted, or found the liquidity below the minimum (the revert's selector and name);
 *   - `unsimulated`: it did not simulate, for a reason the app does not accept (./parse.ts).
 * None ever draws a plan.
 */
export type S1PlanResult =
  | { kind: 'ok'; reply: S1PlanReply }
  | { kind: 'refused'; code: PositionPlanErrorCode; status: number; retryAfterSeconds?: number }
  | { kind: 'expired' }
  | { kind: 'unavailable'; reason: string; retryAfterSeconds?: number }
  | { kind: 'invalid'; detail: string }
  /**
   * `tokens` (added 2026-11-09, core flows, errors): every token the plan moves (the pool's two, then any other it pays
   * with), so a token's transfer refused by selector alone can name them (src/v2in/journey/errors.ts).
   */
  | { kind: 'reverted'; selector: Hex | null; name: string | null; tokens?: readonly Address[] }
  | { kind: 'unsimulated'; reason: string }

/**
 * One exchange with the plan service: the HTTP status and the JSON body; throws for a failure to reach it. `signal`
 * (added 2026-10-30, QA round 2 INST-2): the caller's abort, for a quote nobody waits for any more (an http transport
 * hands it to its POST; one that cannot stop a request may ignore it).
 */
export interface S1PlanTransport {
  readonly kind: 'fixture' | 'http'
  plan(request: Record<string, unknown>, signal?: AbortSignal): Promise<{ status: number; body: unknown; retryAfterSeconds?: number }>
}

export type { PositionPlanErrorCode }
