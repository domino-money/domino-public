// The featured pools list (featured-pools v1 §10.2), one stored route, written by
// hand in read-v4's pattern. The producer is backend/featured_contract.py: this
// accepts exactly what its models accept, and fixtures/ holds both sides to it.
// Closed shapes, no coercion, no defaults; any other input is refused, never thrown.
export const CONTRACT_VERSION = '1.0.0-rc.1'
export const ENABLED_READS = Object.freeze(['featured-pools'])
export const ROUTES = Object.freeze({'featured-pools': Object.freeze({schemaVersion: 1})})
export { ERROR_STATUS_BY_CODE, validateError } from '../read-v1/runtime.mjs'

const ZERO = '0x' + '0'.repeat(40)
const MAX_POOLS = 12
const MAX_WITHDRAWN = 24
const STATUSES = ['current', 'repaired', 'carried_over', 'manual', 'none']
const SOURCES = ['pinned', 'ranked', 'carried', 'fallback', 'manual']
const IDENTITY_SOURCES = ['catalogue_event', 'catalogue_hint', 'position_manager', 'initialize_scan']
const AGE_SOURCES = ['catalogue_event', 'provider_pool_created_at', 'initialize_scan']
const WITHDRAW_REASONS = ['excluded_by_owner', 'pool_integration_unsupported', 'fixed_fee_mismatch',
  'invalid_protocol_fee', 'protocol_fee_directional_unsupported', 'token_code_changed', 'tvl_collapse',
  'price_fall', 'apr_or_turnover_above_ceiling', 'estimate_unavailable', 'volume_collapse']
const LIMITATIONS = ['provider_reported_volume_and_tvl_unreconciled', 'provider_listed_universe_only',
  'no_wash_trading_certification', 'not_a_return_forecast_or_recommendation']
// backend/featured_pools.py REASONS: the safety rules, then the market rules.
const REJECTION_REASONS = ['identity_unresolved', 'provider_currency_or_pool_mismatch',
  'provider_dex_unconfirmed', 'hooked_pool_unsupported', 'dynamic_fee_unsupported', 'fixed_fee_mismatch',
  'fee_out_of_range', 'invalid_protocol_fee', 'protocol_fee_directional_unsupported', 'no_reference_side',
  'same_asset_pair', 'token_no_code', 'token_metadata_unreadable', 'token_symbol_unsafe', 'token_lookalike',
  'token_symbol_duplicate', 'token_upgradeable_unreviewed', 'token_code_changed', 'token_protected_unreviewed',
  'token_symbol_forbidden', 'token_unreviewed', 'excluded_by_owner', 'estimate_not_available',
  'no_active_liquidity',
  'volume_below_floor', 'tvl_below_floor', 'reference_depth_below_floor', 'reference_depth_unmeasurable',
  'apr_above_ceiling', 'turnover_above_ceiling', 'pool_too_young', 'age_unknown', 'activity_below_floor',
  'volume_faded', 'not_persistent', 'price_move_outlier', 'provider_price_disagreement']
const RESPONSE_KEYS = ['schemaVersion', 'contractVersion', 'chainId', 'mode', 'status', 'revision', 'listId',
  'policyVersion', 'selectionDate', 'generatedAt', 'effectiveAt', 'validUntil', 'servedAt', 'window',
  'coverage', 'rules', 'pools', 'withdrawn', 'upcoming', 'evaluation', 'suggested', 'executionAvailable',
  'limitations']
const POOL_KEYS = ['slot', 'source', 'poolId', 'poolKey', 'integrationClass', 'tokens', 'identitySource',
  'ageSource', 'initializeBlock', 'verifiedAt', 'rankInputs']

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
// Exactly these own keys: none missing, none extra.
const exact = (value, keys) => object(value) && Object.keys(value).length === keys.length
  && keys.every(key => Object.hasOwn(value, key))
const oneOf = (values, value) => typeof value === 'string' && values.includes(value)
const orNull = (check, value) => value === null || check(value)
const list = (value, max, item) => Array.isArray(value) && value.length <= max && value.every(item)
const integer = (value, min, max) => Number.isSafeInteger(value) && value >= min && value <= max
const uint = value => integer(value, 0, Number.MAX_SAFE_INTEGER)
const address = value => typeof value === 'string' && /^0x[0-9a-f]{40}$/.test(value)
const hash = value => typeof value === 'string' && /^0x[0-9a-f]{64}$/.test(value)
// read_contract.DecimalString and pool_apr.AprDecimal.
const decimal = value => typeof value === 'string' && value.length <= 224 && /^[0-9]+(?:\.[0-9]+)?$/.test(value)
const apr = value => typeof value === 'string' && /^(?:0|[1-9][0-9]{0,77})(?:\.[0-9]{1,18})?$/.test(value)
// 1 to 32 code points, with no whitespace, control, format or lone surrogate
// (the producer's str cannot hold one): Python's isspace() is exactly Z and Cc.
const symbol = value => typeof value === 'string' && !/[\p{Z}\p{Cc}\p{Cf}\p{Cs}]/u.test(value)
  && [...value].length >= 1 && [...value].length <= 32
// ISO YYYY-MM-DD naming a real day, as date.fromisoformat reads it.
function day(value) {
  if (typeof value !== 'string' || !/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(value)) return false
  const [year, month, date] = value.split('-').map(Number)
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1]
  return year >= 1 && days !== undefined && date >= 1 && date <= days
}

const token = value => exact(value, ['address', 'symbol', 'decimals']) && address(value.address)
  && symbol(value.symbol) && integer(value.decimals, 0, 36)
// Hookless and fixed fee only; a dynamic fee (0x800000) is out of range.
const poolKey = value => exact(value, ['currency0', 'currency1', 'fee_pips', 'tick_spacing', 'hooks', 'feeMode'])
  && address(value.currency0) && address(value.currency1) && integer(value.fee_pips, 0, 999_999)
  && integer(value.tick_spacing, 1, 32_767) && value.hooks === ZERO && value.feeMode === 'fixed'
const rankInputs = value => exact(value, ['rankApr', 'freshApr', 'prevApr', 'volume24hUsd',
  'reportedLiquidityUsd', 'referenceDepthUsd', 'evaluatedAt'])
  && apr(value.rankApr) && apr(value.freshApr) && apr(value.prevApr) && decimal(value.volume24hUsd)
  && decimal(value.reportedLiquidityUsd) && decimal(value.referenceDepthUsd) && uint(value.evaluatedAt)

function pool(value) {
  if (!exact(value, POOL_KEYS) || !integer(value.slot, 1, MAX_POOLS) || !oneOf(SOURCES, value.source)
      || !hash(value.poolId) || !poolKey(value.poolKey) || value.integrationClass !== 'hookless_fixed_fee'
      || !Array.isArray(value.tokens) || value.tokens.length !== 2 || !value.tokens.every(token)
      || !oneOf(IDENTITY_SOURCES, value.identitySource) || !orNull(v => oneOf(AGE_SOURCES, v), value.ageSource)
      || !orNull(uint, value.initializeBlock)
      || !exact(value.verifiedAt, ['number', 'hash']) || !uint(value.verifiedAt.number) || !hash(value.verifiedAt.hash)
      || !orNull(rankInputs, value.rankInputs)) return false
  const {currency0, currency1} = value.poolKey
  // Sorted currencies, named in order by the tokens; rank inputs on ranked pools only.
  return currency0 < currency1 && value.tokens[0].address === currency0 && value.tokens[1].address === currency1
    && (value.rankInputs === null) === (value.source !== 'ranked')
}

const withdrawn = value => exact(value, ['poolId', 'reason', 'at']) && hash(value.poolId)
  && oneOf(WITHDRAW_REASONS, value.reason) && uint(value.at)
const span = value => exact(value, ['start', 'end']) && uint(value.start) && uint(value.end)
const coverage = value => exact(value, ['source', 'pages', 'lastListedVolume24hUsd', 'truncated'])
  && value.source === 'geckoterminal_dex_pools_by_h24_volume' && integer(value.pages, 0, 10)
  && orNull(decimal, value.lastListedVolume24hUsd) && typeof value.truncated === 'boolean'
const rules = value => exact(value, ['rankBy', 'estimateMethod', 'marketSource', 'minVolume24hUsd', 'minTvlUsd',
  'minReferenceDepthUsd', 'maxAprPercent', 'maxTurnover24h', 'minPoolAgeHours', 'size'])
  && value.rankBy === 'min_fresh_and_previous_day_feeAprEstimate24hPercent'
  && value.estimateMethod === 'fixed_lp_fee_x_volume24h_over_reported_tvl_annualized_365'
  && value.marketSource === 'geckoterminal'
  && ['minVolume24hUsd', 'minTvlUsd', 'minReferenceDepthUsd', 'maxAprPercent', 'maxTurnover24h']
    .every(name => decimal(value[name]))
  && uint(value.minPoolAgeHours) && integer(value.size, 1, MAX_POOLS)
const evaluation = value => exact(value, ['candidates', 'shortlisted', 'eligible', 'rejectedByReason'])
  && uint(value.candidates) && uint(value.shortlisted) && uint(value.eligible) && object(value.rejectedByReason)
  && Object.entries(value.rejectedByReason).every(([reason, count]) => oneOf(REJECTION_REASONS, reason) && uint(count))

export function validateRequest(route, body) {
  // The list is the same for everyone: the request names nothing.
  return route === 'featured-pools' && exact(body, [])
}

function validBody(body) {
  if (!exact(body, RESPONSE_KEYS) || body.schemaVersion !== 1 || body.contractVersion !== CONTRACT_VERSION
      || body.chainId !== 4663 || body.mode !== 'stored_featured_pools' || !oneOf(STATUSES, body.status)
      || !orNull(uint, body.revision) || !orNull(hash, body.listId)
      || !orNull(v => typeof v === 'string' && /^featured-v1:[0-9a-f]{12}$/.test(v), body.policyVersion)
      || !orNull(day, body.selectionDate) || !orNull(uint, body.generatedAt) || !orNull(uint, body.effectiveAt)
      || !orNull(uint, body.validUntil) || !uint(body.servedAt) || !orNull(span, body.window)
      || !orNull(coverage, body.coverage) || !orNull(rules, body.rules)
      || !list(body.pools, MAX_POOLS, pool) || !list(body.withdrawn, MAX_WITHDRAWN, withdrawn)
      || body.upcoming !== null || !orNull(evaluation, body.evaluation)
      || body.suggested !== false || body.executionAvailable !== false
      || !Array.isArray(body.limitations) || !body.limitations.every(item => oneOf(LIMITATIONS, item))) return false
  const {pools} = body
  const listed = new Set(pools.map(item => item.poolId))
  // No pools is exactly `none`; slots run 1..n; a pool appears once and is never also withdrawn.
  if ((body.status === 'none') !== (pools.length === 0) || !pools.every((item, index) => item.slot === index + 1)
      || listed.size !== pools.length || body.withdrawn.some(item => listed.has(item.poolId))) return false
  if (body.status === 'none') return true
  // A served list names its revision and its times, in order.
  const {revision, listId, generatedAt, effectiveAt, validUntil, servedAt} = body
  return revision !== null && listId !== null && generatedAt !== null && effectiveAt !== null
    && validUntil !== null && generatedAt <= effectiveAt && effectiveAt <= validUntil && generatedAt <= servedAt
}

export function validateResponse(route, body) {
  if (route !== 'featured-pools') return false
  try { return validBody(body) } catch { return false }
}

// The request names nothing, so a valid list answers it.
export const matchesRequest = (request, response) => exact(request, []) && object(response)
