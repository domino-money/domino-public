/**
 * The new-position journey as a pure state machine: five stages, what each
 * needs before Continue, what a step forward or back does to the state, the
 * validation of budget and range, and the plain-text summary. The journey
 * creates a plain Uniswap position and asks nothing about automation: that
 * is applied later, from Automate, to a position that exists. The Domino
 * limits, their validation and the successor geometry stay here as pure
 * helpers for that screen; no stage of this journey reads them.
 *
 * No React and no reads. Everything a stage shows comes from the values the
 * screens put here: a token candidate and a pool option from validated reads,
 * ticks from the range controls, text from inputs. Nothing here computes a
 * deposit composition: that is the position-preview service's, which Review
 * asks for with the request `previewRequest` forms. Nothing here signs,
 * approves, deposits or swaps, and nothing implies it can.
 */
import type { PositionPreviewRequest } from 'api-contracts/onboarding-v1/types'
import { SELECTED_POOL_CATALOGUE, type PoolCatalogueEntry } from '../../config/selectedPoolCatalogue'
import { CAPABILITIES } from '../capabilities'
import { parseDecimal } from '../read/decimal'
import { tokenText } from '../read/project'
import { DYNAMIC_FEE_PIPS } from '../read/screens/fee'
import { CHAIN_ID, NATIVE_CURRENCY, addressKey, poolIdKey, shortAddress, type AddressKey, type PoolIdKey } from '../read/screens/identity'
import { boundPrice, poolPrice, presetRange, rangePosition, usableTicks, type PoolPrice } from '../read/screens/poolRange'
import type { PoolOption } from '../read/screens/poolsList'
import type { TokenCandidate } from '../read/screens/tokens'
import type { TokenDisplay } from '../read/types'
import type { BudgetFields } from './budgets'
import { CREATE } from './copy'
import { SLIPPAGE_DEFAULT_BPS, slippageBpsFrom, slippageWritten } from './slippage'

export type Stage = 'token' | 'pool' | 'amount' | 'balance' | 'review'
export const STAGES: readonly Stage[] = ['token', 'pool', 'amount', 'balance', 'review']
export const stageIndex = (stage: Stage) => STAGES.indexOf(stage)

/** Two ticks, multiples of the pool's spacing, lower below upper. */
export interface TickRange {
  lower: number
  upper: number
}

/** What a position's earned fees do. Chosen on Automate for a position that exists, never in this journey, which keeps `'none'`. */
export type Automation = 'none' | 'compound' | 'domino'

/** Domino limits exactly as typed; `validateLimits` turns them into numbers. */
export interface DominoLimits {
  triggerPercent: string
  maxOverlapPercent: string
  sequenceCap: string
}

export const DEFAULT_LIMITS: DominoLimits = { triggerPercent: '5', maxOverlapPercent: '20', sequenceCap: '3' }
/** The slippage a journey starts with, as the text the state keeps: 0.5% (create/slippage.ts). */
export const DEFAULT_SLIPPAGE_BPS = String(SLIPPAGE_DEFAULT_BPS)

/**
 * The contract's own domains (contracts/src/PolicyValidation.sol and the
 * Policy struct in IDominoVaultDraft.sol): trigger distance and maximum
 * overlap 0 to 2000 basis points each, 0 included, and 1 to 255 positions
 * counting the root. A percentage with up to two decimal places is a whole
 * number of basis points.
 */
export const LIMIT_BOUNDS = {
  trigger: { min: 0, max: 20 },
  overlap: { min: 0, max: 20 },
  cap: { min: 1, max: 255 },
} as const

/**
 * The successor upside the geometry is drawn with. On chain it is the
 * sequence's own setting, 1 to 1,000,000 basis points (DominoVaultV4's
 * limits check); 50% is the default, not a fixed rule.
 */
export const DEFAULT_UPSIDE_PERCENT = 50

export interface JourneyState {
  stage: Stage
  /** The furthest stage the person has continued to; the rail may reopen any stage up to it. */
  furthest: Stage
  token: TokenCandidate | null
  /** An optional second asset that narrows the pool list. */
  paired: TokenCandidate | null
  pool: PoolOption | null
  /** The budget as typed, in the selected token's units. */
  budget: string
  slippageBps: string
  range: TickRange | null
  /** Kept at their defaults by every stage of this journey; Automate's own state starts from `withAutomation` and `withLimits`. */
  automation: Automation
  limits: DominoLimits
}

export function initialState(): JourneyState {
  return {
    stage: 'token',
    furthest: 'token',
    token: null,
    paired: null,
    pool: null,
    budget: '',
    slippageBps: DEFAULT_SLIPPAGE_BPS,
    range: null,
    automation: 'none',
    limits: { ...DEFAULT_LIMITS },
  }
}

export type Check = { ok: true } | { ok: false; reason: string }
const OK: Check = { ok: true }
const fail = (reason: string): Check => ({ ok: false, reason })

/* ---------------------------------------------------------------------------
   Identity helpers
--------------------------------------------------------------------------- */

const tokenAddress = (token: TokenDisplay) => token.address

/** Whether a pool trades the currency at `key`. */
export const poolHolds = (pool: PoolOption, key: AddressKey) => pool.currencies.some((currency) => tokenAddress(currency) === key)

/** The pool's other currency, given one of its two. Null when `key` is not in the pool. */
export function otherCurrency(pool: PoolOption, key: AddressKey): TokenDisplay | null {
  if (!poolHolds(pool, key)) return null
  return pool.currencies.find((currency) => tokenAddress(currency) !== key) ?? null
}

/** The decimals the read returned for a candidate. Never from a label. */
export const candidateDecimals = (candidate: TokenCandidate): number | null => candidate.token.decimals

/**
 * The two currencies of a verified pool as token candidates, so a person who
 * arrived by pool link can pick the one they deposit. Everything on the row
 * is the pools read's own: address, symbol, decimals and read status.
 */
export function candidatesFromPool(option: PoolOption): TokenCandidate[] {
  return option.currencies.map((token): TokenCandidate => {
    const address = tokenAddress(token)
    const key = addressKey(address)
    const why = token.readStatus === 'no_contract' ? 'no_contract' : token.readStatus === 'unavailable' ? 'unreadable' : null
    return {
      key,
      wire: address,
      token,
      kind: why !== null ? 'unknown' : key === NATIVE_CURRENCY ? 'native' : 'erc20_candidate',
      why,
      reasonCode: null,
      decimalsUnavailable: token.decimals === null,
      // The address came out of the pools read, lowercase, and goes back on the wire as it came.
      source: 'pasted',
      wallet: null,
      balance: null,
      page: null,
      old: false,
      block: option.block,
    }
  })
}

/* ---------------------------------------------------------------------------
   The pool id in the link
--------------------------------------------------------------------------- */

export type Preselect = { ok: true; key: PoolIdKey; catalogue: PoolCatalogueEntry | null } | { ok: false; reason: 'empty' | 'malformed' }

/** USDG: every pool of the reviewed selection trades against it, so the verification read is asked about it. */
export const USDG = addressKey('0x5fc5360d0400a0fd4f2af552add042d716f1d168')

/**
 * The second hash segment is untrusted: it becomes a pool id only when it is
 * exactly one, and it is never shown as anything else. Verification against
 * the chain happens in the screen, through `verifyCandidate`.
 */
export function preselectFrom(param: string): Preselect {
  if (param === '') return { ok: false, reason: 'empty' }
  if (!/^0x[0-9a-fA-F]{64}$/.test(param)) return { ok: false, reason: 'malformed' }
  const key = poolIdKey(param)
  return { ok: true, key, catalogue: SELECTED_POOL_CATALOGUE.find((entry) => entry.poolId === key) ?? null }
}

/** The address the verification read names for a linked pool: USDG, which every catalogue pool holds. */
export const verificationToken = (preselect: Extract<Preselect, { ok: true }>): AddressKey => {
  const paired = preselect.catalogue?.addresses?.[1]
  return paired ? addressKey(paired) : USDG
}

/* ---------------------------------------------------------------------------
   Validation
--------------------------------------------------------------------------- */

const MAX_UINT256 = (1n << 256n) - 1n
const DECIMAL_TEXT = /^(?:0|[1-9]\d*)(?:\.\d+)?$/
const PERCENT_TEXT = /^(?:0|[1-9]\d*)(?:\.\d{1,2})?$/

export type BudgetCheck = { ok: true; raw: string } | { ok: false; reason: string }

/**
 * A decimal budget in the token's units to raw base units, with the decimals
 * the read returned. Exact BigInt arithmetic; unknown decimals block, never
 * guess. The result matches the preview contract's `amountRaw` pattern.
 */
export function validateBudget(text: string, decimals: number | null): BudgetCheck {
  if (decimals === null) return { ok: false, reason: CREATE.amount.decimalsUnknown }
  if (text === '') return { ok: false, reason: CREATE.amount.empty }
  if (text.length > 100 || !DECIMAL_TEXT.test(text)) return { ok: false, reason: CREATE.amount.format }
  const value = parseDecimal(text)
  if (!value || value.coefficient === 0n) return { ok: false, reason: CREATE.amount.zero }
  if (value.scale > decimals) return { ok: false, reason: CREATE.amount.tooManyPlaces(decimals) }
  const raw = value.coefficient * 10n ** BigInt(decimals - value.scale)
  if (raw > MAX_UINT256) return { ok: false, reason: CREATE.amount.tooLarge }
  return { ok: true, raw: raw.toString() }
}

export type SlippageCheck = { ok: true; bps: number } | { ok: false; reason: string }

/** The slippage as kept: whole basis points inside the product's bound, 0.1% to 5% (create/slippage.ts). */
export function validateSlippage(text: string): SlippageCheck {
  const bps = slippageBpsFrom(text)
  return bps === null ? { ok: false, reason: CREATE.amount.slippageInvalid } : { ok: true, bps }
}

/** A range on this pool: whole ticks, multiples of the spacing, inside v4's ticks, lower below upper. */
export function validateRange(range: TickRange | null, pool: PoolOption): Check {
  if (!range) return fail(CREATE.amount.noRange)
  const spacing = pool.tickSpacing
  if (!Number.isInteger(range.lower) || !Number.isInteger(range.upper)) return fail(CREATE.amount.rangeTicks)
  if (range.lower % spacing !== 0 || range.upper % spacing !== 0) return fail(CREATE.amount.rangeSpacing)
  const { min, max } = usableTicks(spacing)
  if (range.lower < min || range.upper > max) return fail(CREATE.amount.rangeBounds)
  if (range.lower >= range.upper) return fail(CREATE.amount.rangeOrder)
  return OK
}

export interface LimitValues {
  trigger: number
  overlap: number
  cap: number
}
export type LimitProblems = Record<keyof DominoLimits, string | null>
export type LimitsCheck = { ok: true; values: LimitValues; problems: LimitProblems } | { ok: false; problems: LimitProblems }

function percentWithin(text: string, min: number, max: number): number | null {
  if (!PERCENT_TEXT.test(text)) return null
  const value = Number(text)
  return value >= min && value <= max ? value : null
}

/** The three Domino limits, each checked on its own so every problem is shown at once. */
export function validateLimits(limits: DominoLimits): LimitsCheck {
  const trigger = percentWithin(limits.triggerPercent, LIMIT_BOUNDS.trigger.min, LIMIT_BOUNDS.trigger.max)
  const overlap = percentWithin(limits.maxOverlapPercent, LIMIT_BOUNDS.overlap.min, LIMIT_BOUNDS.overlap.max)
  const capText = limits.sequenceCap
  const cap = /^[1-9]\d*$/.test(capText) && Number(capText) >= LIMIT_BOUNDS.cap.min && Number(capText) <= LIMIT_BOUNDS.cap.max ? Number(capText) : null
  const problems: LimitProblems = {
    triggerPercent: trigger === null ? CREATE.automation.triggerInvalid : null,
    maxOverlapPercent: overlap === null ? CREATE.automation.overlapInvalid : null,
    sequenceCap: cap === null ? CREATE.automation.capInvalid : null,
  }
  if (trigger === null || overlap === null || cap === null) return { ok: false, problems }
  return { ok: true, values: { trigger, overlap, cap }, problems }
}

/* ---------------------------------------------------------------------------
   Transitions
--------------------------------------------------------------------------- */

const earlier = (a: Stage, b: Stage): Stage => (stageIndex(a) <= stageIndex(b) ? a : b)

/** The pool's price as the range controls judge it, at `now` (the page's clock). */
export const priceOf = (pool: PoolOption | null, now: number): PoolPrice | null => (pool ? poolPrice(pool, now) : null)

/** What each stage needs before Continue. Review never continues: creation is gated (`createGate`). */
export function canContinue(stage: Stage, state: JourneyState, now: number): Check {
  switch (stage) {
    case 'token':
      if (!state.token) return fail(CREATE.token.needToken)
      return state.token.why === null ? OK : fail(CREATE.token.notSelectable)
    case 'pool':
      if (!state.token) return fail(CREATE.token.needToken)
      if (!state.pool) return fail(CREATE.pool.needPool)
      if (!poolHolds(state.pool, state.token.key)) return fail(CREATE.pool.poolMismatch)
      // Create position opens positions through Domino V1's setup contract, which takes hookless, fixed-fee pools only.
      if (state.pool.hooks !== NATIVE_CURRENCY) return fail(CREATE.pool.unsupportedHooks)
      if (state.pool.feePips === DYNAMIC_FEE_PIPS) return fail(CREATE.pool.unsupportedDynamic)
      return OK
    case 'amount': {
      if (!state.token || !state.pool) return fail(CREATE.pool.needPool)
      const price = priceOf(state.pool, now)
      if (!price || price.state !== 'usable') return fail(CREATE.amount.priceUnavailable)
      const budget = validateBudget(state.budget, candidateDecimals(state.token))
      if (!budget.ok) return fail(budget.reason)
      const range = validateRange(state.range, state.pool)
      if (!range.ok) return range
      const slippage = validateSlippage(state.slippageBps)
      return slippage.ok ? OK : fail(slippage.reason)
    }
    case 'balance':
      // The deposit amounts are an estimate shown in Review; nothing waits for them.
      return OK
    case 'review':
      return fail(CREATE.review.final)
    default:
      return stage satisfies never
  }
}

/** The furthest stage the state allows: every stage before it can continue. */
export function reachable(state: JourneyState, now: number): Stage {
  for (const stage of STAGES) if (!canContinue(stage, state, now).ok) return stage
  return 'review'
}

/** Whether the rail may open `stage`: reached before, and every stage before it still complete. */
export const canOpen = (stage: Stage, state: JourneyState, now: number) => stageIndex(stage) <= stageIndex(earlier(state.furthest, reachable(state, now)))

export function next(state: JourneyState, now: number): JourneyState {
  const at = stageIndex(state.stage)
  if (at >= STAGES.length - 1 || !canContinue(state.stage, state, now).ok) return state
  const stage = STAGES[at + 1]
  return { ...state, stage, furthest: stageIndex(stage) > stageIndex(state.furthest) ? stage : state.furthest }
}

export function back(state: JourneyState): JourneyState {
  const at = stageIndex(state.stage)
  return at === 0 ? state : { ...state, stage: STAGES[at - 1] }
}

export function goTo(state: JourneyState, stage: Stage, now: number): JourneyState {
  return canOpen(stage, state, now) ? { ...state, stage } : state
}

/** A different token changes the units of the budget and may leave the chosen pool: both go. */
export function withToken(state: JourneyState, token: TokenCandidate | null): JourneyState {
  const same = token !== null && state.token !== null && token.key === state.token.key
  const pool = token && state.pool && poolHolds(state.pool, token.key) ? state.pool : null
  return {
    ...state,
    token,
    paired: token && state.paired && state.paired.key === token.key ? null : state.paired,
    pool,
    range: pool ? state.range : null,
    budget: same ? state.budget : '',
  }
}

/** A second asset only narrows the pool list; a chosen pool that does not hold it goes. */
export function withPaired(state: JourneyState, paired: TokenCandidate | null): JourneyState {
  const pool = state.pool && (!paired || poolHolds(state.pool, paired.key)) ? state.pool : null
  return { ...state, paired, pool, range: pool ? state.range : null }
}

/** A pool read again keeps its range; a different pool starts with the standard preset on its price, or no range. */
export function withPool(state: JourneyState, pool: PoolOption | null, now: number): JourneyState {
  if (pool && state.pool && pool.key === state.pool.key) return { ...state, pool }
  if (!pool) return { ...state, pool: null, range: null }
  const price = poolPrice(pool, now)
  return { ...state, pool, range: price.state === 'usable' ? presetRange(price.tick, price.tickSpacing, 'standard') : null }
}

export const withRange = (state: JourneyState, range: TickRange | null): JourneyState => ({ ...state, range })
export const withBudget = (state: JourneyState, budget: string): JourneyState => ({ ...state, budget })
export const withSlippage = (state: JourneyState, slippageBps: string): JourneyState => ({ ...state, slippageBps })
export const withAutomation = (state: JourneyState, automation: Automation): JourneyState => ({ ...state, automation })
export const withLimits = (state: JourneyState, limits: Partial<DominoLimits>): JourneyState => ({ ...state, limits: { ...state.limits, ...limits } })

/* ---------------------------------------------------------------------------
   The preview request and the creation gate
--------------------------------------------------------------------------- */

export type PreviewRequest = { ok: true; request: PositionPreviewRequest } | { ok: false; reason: string }

/**
 * The position-preview request this journey sends, shaped exactly as
 * onboarding-v1's `position-preview.request.schema.json`. Formed only from
 * validated reads and validated inputs, and never sent from here: Review's
 * deposit amounts send it, in builds with wallet sign-in, for a signed-in
 * wallet (components/create/DepositAmounts.tsx). The pool key must be hookless
 * with a fixed fee: that is what the service admits.
 *
 * `budgets` are the connected wallet's balances of the pool's two currencies,
 * read at a block and converted exactly (create/budgets.ts). They are what
 * lets the service report `token0_maximum_exceeds_budget` or
 * `token1_maximum_exceeds_budget` and an unspent figure per currency: a
 * deposit is funded with both currencies, and without them nothing can say
 * the wallet is short of the one the person did not choose. Still nothing is
 * invented — a currency whose balance could not be read adds no field, and a
 * gas reserve is never assumed.
 */
export function previewRequest(state: JourneyState, budgets: BudgetFields = {}): PreviewRequest {
  const { token, pool, range } = state
  if (!token || !pool || !range) return { ok: false, reason: CREATE.balance.incomplete }
  if (pool.hooks !== NATIVE_CURRENCY) return { ok: false, reason: CREATE.balance.hooks }
  if (pool.feePips === DYNAMIC_FEE_PIPS) return { ok: false, reason: CREATE.balance.dynamicFee }
  if (!poolHolds(pool, token.key)) return { ok: false, reason: CREATE.pool.poolMismatch }
  const budget = validateBudget(state.budget, candidateDecimals(token))
  if (!budget.ok) return { ok: false, reason: budget.reason }
  const ticks = validateRange(range, pool)
  if (!ticks.ok) return { ok: false, reason: ticks.reason }
  const slippage = validateSlippage(state.slippageBps)
  if (!slippage.ok) return { ok: false, reason: slippage.reason }
  const [currency0, currency1] = pool.currencies
  return {
    ok: true,
    request: {
      chainId: CHAIN_ID,
      poolId: pool.key,
      poolKey: {
        currency0: tokenAddress(currency0),
        currency1: tokenAddress(currency1),
        fee_pips: pool.feePips,
        tick_spacing: pool.tickSpacing,
        // The contract admits exactly the zero address here; `pool.hooks` was checked to be it above.
        hooks: '0x0000000000000000000000000000000000000000',
      },
      independentToken: token.key,
      amountRaw: budget.raw,
      tickLower: range.lower,
      tickUpper: range.upper,
      slippageBps: slippage.bps,
      ...budgets,
    },
  }
}

/**
 * The choices Setup's deposit draft starts from when the person continues
 * there: the verified pool, which of its currencies the amount is in, the
 * amount in raw units, the range and the slippage. The same validated values
 * as the preview request, so a pool the deposit service does not admit is
 * never carried. Budgets and network limits are not: Setup asks for them.
 */
export interface SetupDraft {
  pool: PoolOption
  /** The index of the deposit token among the pool's currencies. */
  independent: 0 | 1
  amountRaw: string
  tickLower: number
  tickUpper: number
  slippageBps: number
}

export function setupDraft(state: JourneyState): SetupDraft | null {
  const formed = previewRequest(state)
  if (!formed.ok || !state.pool || !state.token) return null
  const index = state.pool.currencies.findIndex((currency) => tokenAddress(currency) === state.token?.key)
  if (index !== 0 && index !== 1) return null
  const { request } = formed
  return { pool: state.pool, independent: index, amountRaw: request.amountRaw, tickLower: request.tickLower, tickUpper: request.tickUpper, slippageBps: request.slippageBps }
}

export interface CreateGate {
  enabled: boolean
  reason: string
  detail: string
}

/**
 * Whether Domino signs anything on its own: the build's automated-signing
 * flag, which is false. Create position is the owner's own wallet steps
 * (components/create/CreatePosition.tsx), admitted at run time by the release
 * endpoint; nothing here signs for the owner. read-v1 1.1.0-rc.3 types the
 * capabilities answer's `ownerTransactions` as the literal `false`
 * (api-contracts/read-v1/types.ts), so no server answer can change that.
 */
export function createGate(): CreateGate {
  return { enabled: CAPABILITIES.signingEnabled, reason: CREATE.review.final, detail: CREATE.review.stepsNote }
}

/* ---------------------------------------------------------------------------
   Domino geometry, wallet steps, fee bases and the summary
--------------------------------------------------------------------------- */

const LOG_STEP = Math.log(1.0001)
const ticksFor = (ratio: number) => Math.log(ratio) / LOG_STEP

export interface SuccessorGeometry {
  /** The tick at which the source becomes eligible to evaluate: trigger% below its upper bound. */
  triggerTick: number
  /** The lowest tick the successor's floor may take: overlap% below the source's upper bound, rounded up to the spacing. */
  floorMinTick: number
  /** The successor's target ceiling at the default upside: 50% above the source's upper bound, rounded up to the spacing. */
  ceilingTick: number
}

/**
 * The agreed successor geometry from a range's upper bound, as ticks on the
 * pool's spacing, with the default upside. An illustration of the rule in the
 * pool's own price orientation, never a plan. Null when the spacing cannot
 * hold it.
 */
export function successorGeometry(range: TickRange, limits: LimitValues, spacing: number): SuccessorGeometry | null {
  const { min, max } = usableTicks(spacing)
  const clamp = (tick: number) => Math.min(max, Math.max(min, tick))
  const triggerTick = clamp(Math.floor(range.upper + ticksFor(1 - limits.trigger / 100)))
  const floorMinTick = clamp(Math.ceil((range.upper + ticksFor(1 - limits.overlap / 100)) / spacing) * spacing)
  const ceilingTick = clamp(Math.ceil((range.upper + ticksFor(1 + DEFAULT_UPSIDE_PERCENT / 100)) / spacing) * spacing)
  if (floorMinTick >= ceilingTick) return null
  return { triggerTick, floorMinTick, ceilingTick }
}

export interface WalletStep {
  /** 'fund', 'swap', 'mint', or `approve:<token address>`: the key Create position reports each step's progress under (lib/create/createProgress.ts). */
  key: string
  title: string
  detail: string
  /** The token the step concerns, for the screen to name by symbol and address. */
  token?: TokenDisplay
}

/**
 * The wallet steps Create position asks for, in order: a description, not an
 * action, and nothing about automation, which is applied afterwards from
 * Automate with its own owner transactions. `swapFrom` is the token
 * a one-token deposit is made in (lib/create/depositPlan.ts): only it is
 * approved and deposited, and a swap inside the pool comes before the mint.
 * `assistedFee` is the deployment's assisted-swap fee, as written.
 */
export function walletSteps(state: JourneyState, swapFrom: 0 | 1 | null = null, assistedFee = '0.65%'): WalletStep[] {
  const { token, pool } = state
  if (!token || !pool || !poolHolds(pool, token.key)) return []
  const words = CREATE.review
  const steps: WalletStep[] = []
  for (const [index, currency] of pool.currencies.entries()) {
    if (tokenAddress(currency) === NATIVE_CURRENCY || (swapFrom !== null && index !== swapFrom)) continue
    steps.push({ key: `approve:${tokenAddress(currency)}`, title: words.approveStep, detail: words.approveStepDetail, token: currency })
  }
  if (swapFrom === null) {
    steps.push({ key: 'fund', title: words.fundStep, detail: words.fundStepDetail })
  } else {
    const held = pool.currencies[swapFrom]
    steps.push({ key: 'fund', title: words.fundOneStep, detail: words.fundOneStepDetail(tokenAddress(held) === NATIVE_CURRENCY), token: held })
    steps.push({ key: 'swap', title: words.swapStep, detail: words.swapStepDetail(assistedFee) })
  }
  steps.push({ key: 'mint', title: words.mintStep, detail: words.mintStepDetail })
  return steps
}

export interface FeeBasis {
  label: string
  value: string
  note: string
}

/**
 * The fee bases side by side, each with its own basis. Never one number, and
 * no Domino service fee: a direct deposit carries none, and the fee on
 * earned fees is Automate's to state when automation is applied.
 */
export function feeBases(state: JourneyState): FeeBasis[] {
  const poolFee = state.pool ? state.pool.fee : CREATE.page.notChosen
  const { feeLabels, feeValues, feeNotes } = CREATE.review
  return [
    { label: feeLabels.pool, value: poolFee, note: feeNotes.pool },
    { label: feeLabels.swap, value: feeValues.swap, note: feeNotes.swap },
    { label: feeLabels.gas, value: feeValues.gas, note: feeNotes.gas },
  ]
}

export interface SummaryLine {
  stage: Stage
  label: string
  value: string
  /** The stage's inputs are complete. */
  done: boolean
}

const rangeText = (range: TickRange, price: PoolPrice | null): string => {
  const words = CREATE.review.summary
  if (price && price.state === 'usable') {
    const lower = boundPrice(range.lower, price) ?? words.beyondDisplay
    const upper = boundPrice(range.upper, price) ?? words.beyondDisplay
    return words.rangePrices(lower, upper, range.lower, range.upper)
  }
  return words.rangeTicks(range.lower, range.upper)
}

/** One line per stage for the rail and the review, with "—" where nothing is chosen. */
export function summaryLines(state: JourneyState, now: number): SummaryLine[] {
  const none = CREATE.page.notChosen
  const price = priceOf(state.pool, now)
  const token = state.token
  const tokenValue = token ? `${tokenText(token.token)} · ${shortAddress(token.key)}` : none
  const pool = state.pool
  const poolValue = pool ? `${tokenText(pool.currencies[0])}/${tokenText(pool.currencies[1])} · ${pool.fee} · ${shortAddress(pool.key)}` : none
  const budget = token ? validateBudget(state.budget, candidateDecimals(token)) : null
  const slippage = validateSlippage(state.slippageBps)
  const amountValue =
    budget?.ok && state.range && token && slippage.ok
      ? `${state.budget} ${tokenText(token.token)} · ${rangeText(state.range, price)} · ${CREATE.review.summary.slippage(slippageWritten(slippage.bps))}`
      : none
  return [
    { stage: 'token', label: CREATE.stage.token.short, value: tokenValue, done: canContinue('token', state, now).ok },
    { stage: 'pool', label: CREATE.stage.pool.short, value: poolValue, done: canContinue('pool', state, now).ok },
    { stage: 'amount', label: CREATE.stage.amount.short, value: amountValue, done: canContinue('amount', state, now).ok },
    { stage: 'balance', label: CREATE.stage.balance.short, value: stageIndex(state.furthest) > stageIndex('balance') ? CREATE.balance.notEnabled : none, done: stageIndex(state.furthest) > stageIndex('balance') },
    { stage: 'review', label: CREATE.stage.review.short, value: state.stage === 'review' ? CREATE.review.final : none, done: false },
  ]
}

/** Where the pool's price sits against the range, in words, or null without both. */
export function positionText(state: JourneyState, now: number): string | null {
  const price = priceOf(state.pool, now)
  if (!price || price.state !== 'usable' || !state.range) return null
  const inside = rangePosition(state.range, price.tick) === 'inside'
  return `${inside ? CREATE.review.inRange : CREATE.review.outOfRange}${price.stale ? ` ${CREATE.review.stale}` : ''}`
}

/**
 * The whole journey as plain text lines: the review's words, and what tests
 * read. `swapFrom` is the token a one-token deposit is made in, as Review
 * plans it (lib/create/reviewPlan.ts), for the wallet steps.
 */
export function serialiseSummary(state: JourneyState, now: number, swapFrom: 0 | 1 | null = null): string[] {
  const words = CREATE.review.summary
  const lines = summaryLines(state, now).map((line) => `${line.label}: ${line.value}`)
  const position = positionText(state, now)
  if (position) lines.push(`${words.price}: ${position}`)
  for (const [index, step] of walletSteps(state, swapFrom).entries()) lines.push(`${words.walletStep(index + 1)}: ${step.title}`)
  for (const fee of feeBases(state)) lines.push(`${fee.label}: ${fee.value}`)
  // The owner's own action: the wallet signs each step when Create position is pressed (components/create/CreatePosition.tsx).
  lines.push(`${words.create}: ${CREATE.review.final}`)
  return lines
}
