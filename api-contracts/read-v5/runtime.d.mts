// Written by hand with runtime.mjs (featured-pools v1 §10.2); the producer is
// backend/featured_contract.py. Decimals are strings; times are Unix seconds.
import type { ErrorResponse } from '../read-v1/types.js';

/** The version this runtime speaks: rc.2, featured-policy v2 (rugged's handoff of 28/09/2026). */
export type ReadV5ContractVersion = '1.0.0-rc.2';
/** Every version an answer may carry: rc.1 while the VM moves to rc.2, each held to its own rules. */
export type ReadV5AcceptedVersion = '1.0.0-rc.1' | ReadV5ContractVersion;
/** The lower of today's and the previous day's APR (policy v1), or today's alone (policy v2, rc.2 on). */
export type FeaturedRankBy = 'min_fresh_and_previous_day_feeAprEstimate24hPercent' | 'feeAprEstimate24hPercent';
export type FeaturedStatus = 'current' | 'repaired' | 'carried_over' | 'manual' | 'none';
export type FeaturedPoolSource = 'pinned' | 'ranked' | 'carried' | 'fallback' | 'manual';
export type FeaturedIdentitySource = 'catalogue_event' | 'catalogue_hint' | 'position_manager' | 'initialize_scan';
export type FeaturedAgeSource = 'catalogue_event' | 'provider_pool_created_at' | 'initialize_scan';
export type FeaturedWithdrawReason = 'excluded_by_owner' | 'pool_integration_unsupported' | 'fixed_fee_mismatch'
  | 'invalid_protocol_fee' | 'protocol_fee_directional_unsupported' | 'token_code_changed' | 'tvl_collapse'
  | 'price_fall' | 'apr_or_turnover_above_ceiling' | 'estimate_unavailable' | 'volume_collapse';
export type FeaturedLimitation = 'provider_reported_volume_and_tvl_unreconciled' | 'provider_listed_universe_only'
  | 'no_wash_trading_certification' | 'not_a_return_forecast_or_recommendation';
export type FeaturedRejectionReason = 'identity_unresolved' | 'provider_currency_or_pool_mismatch'
  | 'provider_dex_unconfirmed' | 'hooked_pool_unsupported' | 'dynamic_fee_unsupported' | 'fixed_fee_mismatch'
  | 'fee_out_of_range' | 'invalid_protocol_fee' | 'protocol_fee_directional_unsupported' | 'no_reference_side'
  | 'same_asset_pair' | 'token_no_code' | 'token_metadata_unreadable' | 'token_symbol_unsafe' | 'token_lookalike'
  | 'token_symbol_duplicate' | 'token_upgradeable_unreviewed' | 'token_code_changed' | 'token_protected_unreviewed'
  | 'token_symbol_forbidden' | 'token_unreviewed' | 'excluded_by_owner' | 'estimate_not_available'
  | 'no_active_liquidity' | 'volume_below_floor' | 'tvl_below_floor' | 'reference_depth_below_floor'
  | 'reference_depth_unmeasurable' | 'apr_above_ceiling' | 'turnover_above_ceiling' | 'pool_too_young'
  | 'age_unknown' | 'activity_below_floor' | 'volume_faded' | 'not_persistent' | 'price_move_outlier'
  | 'provider_price_disagreement';

/** Untrusted display text: 1 to 32 code points, no whitespace, control or format character. */
export interface FeaturedToken { address: string; symbol: string; decimals: number; }
/** Hookless, fixed fee: `currency0 < currency1`, `fee_pips` 0..999999, `tick_spacing` 1..32767. */
export interface FeaturedPoolKey {
  currency0: string; currency1: string; fee_pips: number; tick_spacing: number;
  hooks: '0x0000000000000000000000000000000000000000'; feeMode: 'fixed';
}
/**
 * Under policy v2 `rankApr` is `freshApr`. From rc.2, `prevApr` is null for a pool with no
 * evaluation the day before, and `referenceDepthUsd` null where depth was not measured.
 */
export interface FeaturedRankInputs {
  rankApr: string; freshApr: string; prevApr: string | null; volume24hUsd: string;
  reportedLiquidityUsd: string; referenceDepthUsd: string | null; evaluatedAt: number;
}
export interface FeaturedPool {
  /** 1..n in list order, without gaps. */
  slot: number;
  source: FeaturedPoolSource;
  poolId: string;
  poolKey: FeaturedPoolKey;
  integrationClass: 'hookless_fixed_fee';
  /** The key's currency0 then currency1. */
  tokens: [FeaturedToken, FeaturedToken];
  identitySource: FeaturedIdentitySource;
  ageSource: FeaturedAgeSource | null;
  initializeBlock: number | null;
  verifiedAt: { number: number; hash: string };
  /** Present exactly when `source` is `ranked`. */
  rankInputs: FeaturedRankInputs | null;
}
/** A pool removed by a safety rule in the last seven days; never also listed. */
export interface FeaturedWithdrawn { poolId: string; reason: FeaturedWithdrawReason; at: number; }
export interface FeaturedCoverage {
  source: 'geckoterminal_dex_pools_by_h24_volume'; pages: number;
  lastListedVolume24hUsd: string | null; truncated: boolean;
}
/**
 * The rules a list was chosen by, as recorded with it. The two floors are always stated; from
 * rc.2 any other market rule may be null, which means that rule is off (rc.1 states them all).
 */
export interface FeaturedRules {
  rankBy: FeaturedRankBy;
  estimateMethod: 'fixed_lp_fee_x_volume24h_over_reported_tvl_annualized_365';
  marketSource: 'geckoterminal';
  minVolume24hUsd: string; minTvlUsd: string; minReferenceDepthUsd: string | null;
  maxAprPercent: string | null; maxTurnover24h: string | null; minPoolAgeHours: number | null; size: number;
}
export interface FeaturedEvaluation {
  candidates: number; shortlisted: number; eligible: number;
  rejectedByReason: Partial<Record<FeaturedRejectionReason, number>>;
}
/**
 * `none` is exactly an empty `pools` (it may still carry `withdrawn`). Any other
 * status names `revision`, `listId` and the times, with
 * `generatedAt <= effectiveAt <= validUntil` and `generatedAt <= servedAt`.
 * A stale list (`servedAt > validUntil`) is valid here: the reader decides.
 */
export interface FeaturedPoolsResponse {
  schemaVersion: 1;
  contractVersion: ReadV5AcceptedVersion;
  chainId: 4663;
  mode: 'stored_featured_pools';
  status: FeaturedStatus;
  revision: number | null;
  listId: string | null;
  policyVersion: string | null;
  selectionDate: string | null;
  generatedAt: number | null;
  effectiveAt: number | null;
  validUntil: number | null;
  servedAt: number;
  window: { start: number; end: number } | null;
  coverage: FeaturedCoverage | null;
  rules: FeaturedRules | null;
  pools: FeaturedPool[];
  withdrawn: FeaturedWithdrawn[];
  upcoming: null;
  evaluation: FeaturedEvaluation | null;
  suggested: false;
  executionAvailable: false;
  limitations: FeaturedLimitation[];
}
/** The body is `{}`: the list is the same for everyone. */
export type FeaturedPoolsRequest = Record<string, never>;
export interface ReadV5Requests { 'featured-pools': FeaturedPoolsRequest; }
export interface ReadV5Responses { 'featured-pools': FeaturedPoolsResponse; }
export type ReadV5Route = keyof ReadV5Requests;
export type { ErrorResponse };

export const CONTRACT_VERSION: ReadV5ContractVersion;
export const CONTRACT_VERSIONS: readonly ReadV5AcceptedVersion[];
export const ENABLED_READS: readonly ReadV5Route[];
export const ROUTES: Readonly<Record<ReadV5Route, Readonly<{ schemaVersion: 1 }>>>;
export const ERROR_STATUS_BY_CODE: Readonly<Record<ErrorResponse['error'], number>>;
export function validateError(status: number, value: unknown): value is ErrorResponse;
export function validateRequest<R extends ReadV5Route>(route: R, value: unknown): value is ReadV5Requests[R];
export function validateResponse<R extends ReadV5Route>(route: R, value: unknown): value is ReadV5Responses[R];
export function matchesRequest(request: unknown, response: unknown): boolean;
