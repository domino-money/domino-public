/**
 * What each producer error code means for this app.
 *
 * The table is typed over the contract's closed error union, so a new code in
 * the next contract fails typecheck here instead of falling into a default.
 * `validateError` has already checked that the status matches the code.
 *
 * The `retryable` column is this app's reading of the codes, not a producer
 * table: the package publishes statuses, not retry advice. It marks what reads
 * as a transient outage (network, RPC, deadline, reorganised snapshot, database
 * outage), where a person's Retry may get another answer, and leaves integrity,
 * configuration and indexing failures unmarked, because asking again would get
 * the same one. None of them is asked again automatically: under R-1 (#1) the
 * pipeline does that only after a validated 429 `read_capacity_busy`.
 */
import type { ErrorCode } from './types'

export type ErrorClass =
  | { kind: 'restart' }
  | { kind: 'route_disabled' }
  | { kind: 'request_rejected' }
  | { kind: 'busy' }
  | { kind: 'incompatible' }
  | { kind: 'unavailable'; retryable: boolean }

const RESTART = { kind: 'restart' } as const
const REJECTED = { kind: 'request_rejected' } as const
const TRANSIENT = { kind: 'unavailable', retryable: true } as const
const FINAL = { kind: 'unavailable', retryable: false } as const

export const ERROR_CLASS = {
  // 400 / 409: recover by restarting the list, never by retrying the same page.
  invalid_or_expired_cursor: RESTART,
  catalogue_revision_changed: RESTART,
  // 404: the bridge has this route switched off.
  route_not_available: { kind: 'route_disabled' },
  // Other 4xx: this app sent something the bridge refuses.
  invalid_request: REJECTED,
  invalid_token_list: REJECTED,
  json_required: REJECTED,
  local_client_required: REJECTED,
  method_not_allowed: REJECTED,
  origin_not_allowed: REJECTED,
  request_timeout: REJECTED,
  request_too_large: REJECTED,
  // 429: says when to come back. The one answer asked again automatically (pipeline.ts).
  read_capacity_busy: { kind: 'busy' },
  // 502: the bridge and the gateway disagree on the contract.
  upstream_contract_mismatch: { kind: 'incompatible' },
  upstream_invalid_response: FINAL,
  // 503 / 504, transient: shown as itself, for a person to retry. Never asked again automatically.
  upstream_unavailable: TRANSIENT,
  upstream_timeout: TRANSIENT,
  read_deadline_exceeded: TRANSIENT,
  network_unavailable: TRANSIENT,
  rpc_error: TRANSIENT,
  rpc_call_gas_limit: TRANSIENT,
  rpc_call_reverted: TRANSIENT,
  missing_rpc_result: TRANSIENT,
  block_unavailable: TRANSIENT,
  stale_or_future_block: TRANSIENT,
  snapshot_reorganized: TRANSIENT,
  metrics_snapshot_reorganized: TRANSIENT,
  nft_snapshot_reorganized: TRANSIENT,
  activity_snapshot_reorganized: TRANSIENT,
  catalogue_database_unavailable: TRANSIENT,
  // 503: the snapshot store is empty — a provider read must land first (T2.1).
  snapshot_not_built: FINAL,
  // 503, not transient: integrity, configuration, indexing or budget.
  activity_methodology_mismatch: FINAL,
  activity_not_indexed: FINAL,
  activity_pool_not_registered: FINAL,
  activity_window_budget_exhausted: FINAL,
  catalogue_not_configured: FINAL,
  catalogue_schema_mismatch: FINAL,
  fixed_fee_mismatch: FINAL,
  invalid_abi_response: FINAL,
  invalid_json: FINAL,
  invalid_market_query: FINAL,
  invalid_nft_position_info: FINAL,
  invalid_nft_snapshot_block: FINAL,
  invalid_pool_key: FINAL,
  invalid_pool_state: FINAL,
  invalid_quantity: FINAL,
  invalid_rpc_envelope: FINAL,
  invalid_snapshot_request: FINAL,
  invalid_tick_spacing: FINAL,
  manager_mismatch: FINAL,
  missing_contract_code: FINAL,
  nft_core_liquidity_mismatch: FINAL,
  nft_live_position_has_no_owner: FINAL,
  nft_pool_or_range_mismatch: FINAL,
  pool_id_mismatch: FINAL,
  provider_currency_mismatch: FINAL,
  quantity_too_large: FINAL,
  request_budget_exhausted: FINAL,
  response_too_large: FINAL,
  wrong_chain: FINAL,
} as const satisfies Record<ErrorCode, ErrorClass>
