/**
 * POST /api/automation/v1/record (RPC-SPEC §2.5.5, 2026-10-01): an automation vault's own record for "Auto-compound
 * impact", read at the edge from Domino's node in place of the page's two log reads (src/lib/automationImpact.ts
 * readVault): the vault's ExecutionCompleted logs in [from, to], and the pair's ERC-20 transfers out of the vault over
 * the blocks of those executions. The page still parses both (lib/vaultLogs.ts executionsOf and paymentsOf); this reads,
 * checks each log is the one asked for, and trims it.
 *
 * Every method (eth_blockNumber, eth_getLogs), address, topic and window is fixed here; the caller names a vault, a
 * token id, the pair's two currencies and a block range of at most RECORD_SPAN blocks.
 *
 * 2026-10-02 (review finding 5): the node is read in fixed units of the window's width (EDGE_LOG_LIMITS.one, one POST
 * each), aligned to block 0: a unit's executions kept per vault, and the pair's
 * payments over that unit's executions kept per vault and pair, read only when the range asked holds one of them (a
 * unit below the head's SAFE_DEPTH for a year, the newest one ten seconds). An answer takes its range out of them. So a
 * question whose range moves by a block reads nothing new, and a visitor cannot mint cache misses by shifting `from`
 * or `to`.
 *
 * Changed on purpose 2026-10-02 (RPC fix round 2: the newest unit was read again from its first block on almost every
 * question, up to 50 node calls where the page's catch-up asked for a minute of blocks, and its payments over the whole
 * unit's executions too). A unit that can still change is kept a week, and read on from where it was kept: its last
 * SAFE_DEPTH blocks again (a reorganised tail is replaced), then up to the head; one node call while it was kept within
 * the last few hours. Its payments are read on the same way. Within ten seconds of its read it is served as kept.
 *
 * Changed on purpose 2026-10-02 (rugged97's rule 3: never a log below block 69,249,061): no unit is read below
 * RECORD_FLOOR, DominoSetupV1's deploy block, whatever the question asks; it was the factory's block (69,239,633), or the
 * question's own `from` when lower. The release's factory and setup were deployed together, 9,428 blocks apart, before any
 * vault existed; the integrator confirms once on the live node that no vault ran an execution between the two (RPC-SPEC
 * §11.4).
 */
import { SETUP_DEPLOY_BLOCK, TRANSFER_TOPIC } from './owned'
import { AUTOMATION_SELECTOR, SEQUENCE_FACTORY } from './automation'
import {
  FAILURE_SECONDS,
  FINAL_SECONDS,
  HASH,
  RelayError,
  SAFE_DEPTH,
  SHORT_SECONDS,
  addressWord,
  aggregate,
  answer,
  blockNumber,
  cacheUrl,
  failure,
  failureSeconds,
  headBlock,
  hex,
  keep,
  kept,
  keysAre,
  logsBatch,
  newBudget,
  outcomeOf,
  quantity,
  refusal,
  sha256,
  shared,
  tokenIdOk,
  type Budget,
  type FeesRuntime,
} from './fees'
import type { RawLog, VaultRecordRequest, VaultRecordResponse } from '../../src/lib/edge/chainRoutes'

/**
 * keccak256("ExecutionCompleted(bytes32,bytes32,uint8,uint256,uint256,uint64)"), DominoVaultV4's (src/lib/vaultLogs.ts).
 * Moved here 2026-10-02 from feesPath.ts, retired with the fees replay.
 */
export const EXECUTION_COMPLETED = '0xa75f5619abce0f39b6b0ace7eb96f20ba345b963b9799beed8451480a406cde0'
/** The most blocks one record request covers. */
export const RECORD_SPAN = 50_000_000
/**
 * The first block any vault of Domino's factory can have an execution in: the factory's own (the page's
 * src/lib/automationImpact.ts VAULT_FIRST_BLOCK, docs/deployments/v1-robinhood-mainnet-2026-09-21; a test holds them equal).
 */
export const VAULT_FIRST_BLOCK = 69_239_633
/** The lowest block a record unit is read from (rugged97's rule 3, 2026-10-02): DominoSetupV1's deploy, the node's log floor. */
export const RECORD_FLOOR = SETUP_DEPLOY_BLOCK
/** How long a unit that can still change is kept, to be read on from (served as kept only within SHORT_SECONDS). */
export const OPEN_UNIT_SECONDS = 7 * 24 * 3600
export const RECORD_BODY_BYTES = 512
/** The most bytes a record answer may take: the page's client reads no more (src/lib/edge/chainRoutes.ts REPLY_BYTES.record). */
export const RECORD_REPLY_BYTES = 2_097_152

const ADDRESS = /^0x[0-9a-f]{40}$/
const DATA = /^0x(?:[0-9a-f]{2})*$/
const QUANTITY = /^0x(?:0|[1-9a-f][0-9a-f]*)$/
const addressOk = (value: unknown): value is string => typeof value === 'string' && ADDRESS.test(value)

/** A record body as a VaultRecordRequest, or null unless it is exactly one (exact keys, lowercase addresses, a short range). */
export function recordRequestOf(body: Record<string, unknown>): VaultRecordRequest | null {
  if (!keysAre(body, ['vault', 'tokenId', 'currencies', 'from', 'to'])) return null
  const { vault, tokenId, currencies, from, to } = body
  if (!addressOk(vault) || BigInt(vault) === 0n || !tokenIdOk(tokenId) || tokenId === '0') return null
  if (!Array.isArray(currencies) || currencies.length !== 2 || !currencies.every(addressOk)) return null
  if (!blockNumber(from) || !blockNumber(to) || to < from || to - from > RECORD_SPAN) return null
  return { vault, tokenId, currencies: [currencies[0], currencies[1]], from, to }
}

/** One log as the node sent it, checked for shape and range, trimmed and lowercased; null for a removed one (a reorg). */
function trimmed(raw: unknown, from: number, to: number): RawLog | null {
  if (!raw || typeof raw !== 'object') throw new RelayError('fatal', 'invalid_log')
  const log = raw as Record<string, unknown>
  if (log.removed === true) return null
  const topics = Array.isArray(log.topics) ? log.topics.map((topic) => String(topic).toLowerCase()) : null
  const [address, data, tx, block, index] = [log.address, log.data, log.transactionHash, log.blockNumber, log.logIndex].map((value) => (typeof value === 'string' ? value.toLowerCase() : ''))
  if (!ADDRESS.test(address) || !topics || topics.length < 1 || topics.length > 4 || !topics.every((topic) => HASH.test(topic)) || !DATA.test(data) || !HASH.test(tx) || !QUANTITY.test(index)) throw new RelayError('fatal', 'invalid_log')
  const at = quantity(block)
  if (at < from || at > to) throw new RelayError('fatal', 'log_out_of_range')
  return { address, topics, data, blockNumber: block, transactionHash: tx, logIndex: index }
}

/** One filter's logs over [from, to], in logical windows of `window` blocks (one batch), oldest first, removed ones dropped. */
async function logsOver(rt: FeesRuntime, budget: Budget, filter: { address: string | string[]; topics: string[] }, from: number, to: number, window: number): Promise<RawLog[]> {
  const filters: unknown[] = []
  for (let lo = from; lo <= to; lo += window) filters.push({ address: filter.address, fromBlock: hex(lo), toBlock: hex(Math.min(to, lo + window - 1)), topics: filter.topics })
  const out: RawLog[] = []
  for (const result of await logsBatch(rt, budget, filters)) {
    for (const raw of result as unknown[]) {
      const log = trimmed(raw, from, to)
      if (log) out.push(log)
    }
  }
  return out
}

/** One unit of a vault's executions as kept: the blocks read, whether it is final, and its executions. */
interface ExecutionUnit {
  from: number
  to: number
  final: boolean
  executions: RawLog[]
}

/** The pair's payments out of the vault over one unit's executions (`from` to `to`, their first and last blocks), as kept. */
interface PaymentUnit {
  from: number
  to: number
  final: boolean
  transfers: RawLog[]
}

const blockOf = (log: RawLog) => quantity(log.blockNumber)

/** A kept unit as it may be read on: one that starts at or before `from` and was read to a block, or null. */
function baseOf<T extends { from: number; to: number; final: boolean }>(hit: { value: T } | null, from: number, entries: 'executions' | 'transfers'): T | null {
  const value = hit?.value
  return value && Number.isSafeInteger(value.from) && Number.isSafeInteger(value.to) && value.from <= from && value.to >= value.from && typeof value.final === 'boolean' && Array.isArray((value as Record<string, unknown>)[entries]) ? value : null
}

/**
 * Where a kept unit is read on from (RPC fix round 2): its last SAFE_DEPTH blocks again, so a reorganised tail is
 * replaced, never before `from`; `from` itself with nothing kept. The kept logs below it stay.
 */
const resumeOf = (base: { to: number } | null, from: number, cut: number) => (base ? Math.max(from, Math.min(base.to, cut) + 1 - SAFE_DEPTH) : from)

/**
 * Unit `unit` of the vault's executions ([unit × window, its end], from RECORD_FLOOR at the earliest), read up to
 * `head` at most: a kept one that is final, or that reaches `need` and is younger than SHORT_SECONDS, as kept; else read
 * on from the kept one (resumeOf), or whole, and kept: a year once its end is SAFE_DEPTH below the head, else
 * OPEN_UNIT_SECONDS. Every execution must be the vault's ExecutionCompleted, or the answer fails.
 */
async function executionUnit(rt: FeesRuntime, budget: Budget, origin: string | null, asked: VaultRecordRequest, head: number, unit: number, window: number, need: number): Promise<ExecutionUnit> {
  const start = Math.max(unit * window, RECORD_FLOOR)
  const end = unit * window + window - 1
  const cut = Math.min(end, head)
  const url = origin === null ? null : cacheUrl(origin, 'recordUnit', await sha256(asked.vault), unit)
  const hit = url ? await kept<ExecutionUnit>(rt, url) : null
  const base = baseOf(hit, start, 'executions')
  if (base && hit && (base.final || (base.to >= need && hit.ageMs < SHORT_SECONDS * 1000))) return base
  const read = async (): Promise<ExecutionUnit> => {
    const resume = resumeOf(base, start, cut)
    const fresh = await logsOver(rt, budget, { address: asked.vault, topics: [EXECUTION_COMPLETED] }, resume, cut, window)
    if (fresh.some((log) => log.address !== asked.vault || log.topics[0] !== EXECUTION_COMPLETED)) throw new RelayError('fatal', 'invalid_log_topics')
    const final = cut === end && end <= head - SAFE_DEPTH
    const value: ExecutionUnit = { from: start, to: cut, final, executions: [...(base?.executions.filter((log) => blockOf(log) < resume) ?? []), ...fresh] }
    if (url) await keep(rt, url, value, final ? FINAL_SECONDS : OPEN_UNIT_SECONDS)
    return value
  }
  return url ? shared(rt, `${url}#${cut}`, read) : read()
}

/**
 * The pair's ERC-20 Transfers out of the vault over unit `unit`'s executions (their first block to their last), kept
 * per vault, pair and unit as that unit is, and read on from the kept ones the same way (resumeOf). Every transfer must
 * be one of the pair's, out of the vault, or the answer fails.
 */
async function paymentUnit(rt: FeesRuntime, budget: Budget, origin: string | null, asked: VaultRecordRequest, pair: readonly string[], unit: number, window: number, of: ExecutionUnit): Promise<RawLog[]> {
  const blocks = of.executions.map(blockOf)
  const [first, last] = [Math.min(...blocks), Math.max(...blocks)]
  const url = origin === null ? null : cacheUrl(origin, 'recordPaid', await sha256(`${asked.vault}|${[...pair].sort().join(',')}`), unit)
  const hit = url ? await kept<PaymentUnit>(rt, url) : null
  const base = baseOf(hit, first, 'transfers')
  if (base && hit && base.to >= last && (base.final || hit.ageMs < SHORT_SECONDS * 1000)) return base.transfers
  const read = async (): Promise<PaymentUnit> => {
    const resume = resumeOf(base, first, last)
    const vaultWord = `0x${asked.vault.slice(2).padStart(64, '0')}`
    const fresh = await logsOver(rt, budget, { address: pair.length === 1 ? pair[0] : [...pair], topics: [TRANSFER_TOPIC, vaultWord] }, resume, last, window)
    if (fresh.some((log) => !pair.includes(log.address) || log.topics[0] !== TRANSFER_TOPIC || log.topics[1] !== vaultWord)) throw new RelayError('fatal', 'invalid_log_topics')
    const value: PaymentUnit = { from: base ? base.from : first, to: last, final: of.final, transfers: [...(base?.transfers.filter((log) => blockOf(log) < resume) ?? []), ...fresh] }
    if (url) await keep(rt, url, value, of.final ? FINAL_SECONDS : OPEN_UNIT_SECONDS)
    return value
  }
  return (await (url ? shared(rt, `${url}#${first}-${last}`, read) : read())).transfers
}

/**
 * Whether `vault` is one Domino's factory made (DominoVaultFactoryV1.isVault, one eth_call at the head), kept a year once
 * it is (a vault stays one); an address that is not is asked again next time, and costs no log read.
 */
async function factoryMade(rt: FeesRuntime, budget: Budget, vault: string, origin: string | null): Promise<boolean> {
  const url = origin === null ? null : cacheUrl(origin, 'recordVault', await sha256(vault), 0)
  const hit = url ? await kept<{ made: true }>(rt, url) : null
  if (hit?.value.made === true) return true
  const [result] = await aggregate(rt, budget, [{ target: SEQUENCE_FACTORY, data: AUTOMATION_SELECTOR.isVault + addressWord(vault) }], 'latest')
  const data = result.data.startsWith('0x') ? result.data.slice(2) : result.data
  const made = result.success && data.length >= 64 && BigInt(`0x${data.slice(0, 64)}`) === 1n
  if (made && url) await keep(rt, url, { made: true }, FINAL_SECONDS)
  return made
}

/**
 * The vault's record for the request, at the node's head: behind when `to` is past it. `transfers` is null when either
 * currency is native (its payments are not logs), [] when there is no execution; else the pair's transfers out of the
 * vault in the blocks of the units' executions, between the first and the last execution in [from, to] (the page keeps
 * those of the executions' own transactions, lib/vaultLogs.ts paymentsOf). Read in the units of recordUnit, from
 * `origin`'s cache when one is given.
 *
 * Changed on purpose 2026-10-02 (review of rugged97's rules, finding 16): only a vault Domino's factory made has a
 * record; any other address has none, answered with no log read (it took any address, so each new one was a cold scan
 * since the floor that no cache could hold).
 */
export async function readVaultRecord(rt: FeesRuntime, budget: Budget, asked: VaultRecordRequest, window: number, origin: string | null = null): Promise<VaultRecordResponse> {
  const head = await headBlock(rt, budget, asked.to)
  if (asked.to > head) return { v: 1, behind: true }
  const pair = [...new Set(asked.currencies)]
  if (!(await factoryMade(rt, budget, asked.vault, origin))) return { v: 1, head, executions: [], transfers: pair.some((currency) => BigInt(currency) === 0n) ? null : [] }
  const within = (log: RawLog, from: number, to: number) => blockOf(log) >= from && blockOf(log) <= to
  const units: Array<{ unit: number; of: ExecutionUnit; asked: RawLog[] }> = []
  for (let unit = Math.floor(Math.max(asked.from, RECORD_FLOOR) / window); unit * window <= asked.to; unit++) {
    const of = await executionUnit(rt, budget, origin, asked, head, unit, window, Math.min(unit * window + window - 1, asked.to))
    units.push({ unit, of, asked: of.executions.filter((log) => within(log, asked.from, asked.to)) })
  }
  const executions = units.flatMap((one) => one.asked)
  if (pair.some((currency) => BigInt(currency) === 0n)) return { v: 1, head, executions, transfers: null }
  if (executions.length === 0) return { v: 1, head, executions, transfers: [] }
  const blocks = executions.map(blockOf)
  const [first, last] = [Math.min(...blocks), Math.max(...blocks)]
  // Only the units that hold an execution asked for: their payments, then those between the first and the last.
  const transfers: RawLog[] = []
  for (const one of units) if (one.asked.length > 0) transfers.push(...(await paymentUnit(rt, budget, origin, asked, pair, one.unit, window, one.of)))
  return { v: 1, head, executions, transfers: transfers.filter((log) => within(log, first, last)) }
}

/**
 * POST /api/automation/v1/record's answer for a checked request: the whole answer kept under
 * cacheUrl(origin, 'record', sha256(the request), 0) for a year once `to` is SAFE_DEPTH below the head, else
 * SHORT_SECONDS; a `behind` answer is never kept. A record larger than the page reads is too large (413); a
 * rate-limited node is a 429 and anything else a 502, each kept FAILURE_SECONDS, or a minute when our own time-out ended
 * it (fees.ts failureSeconds, finding 6).
 */
export async function recordAnswer(request: Request, rt: FeesRuntime, asked: VaultRecordRequest, window: number): Promise<Response> {
  const { origin } = new URL(request.url)
  const digest = await sha256(JSON.stringify(asked))
  const key = cacheUrl(origin, 'record', digest, 0)
  const failKey = cacheUrl(origin, 'recordFail', digest, 0)
  const hit = await kept<{ text: string; final: boolean }>(rt, key)
  if (hit && typeof hit.value.text === 'string' && (hit.value.final === true || hit.ageMs < SHORT_SECONDS * 1000)) return answer(hit.value.text, request)
  const recent = await kept<{ outcome: 'rate_limited' | 'rpc_unavailable'; seconds?: number }>(rt, failKey)
  const life = 1000 * (Number.isSafeInteger(recent?.value.seconds) && (recent?.value.seconds as number) > 0 ? (recent?.value.seconds as number) : FAILURE_SECONDS)
  if (recent && recent.ageMs < life) return failure(recent.value.outcome, life - recent.ageMs)
  const budget = newBudget(rt)
  try {
    const value = await shared(rt, key, () => readVaultRecord(rt, budget, asked, window, origin))
    const text = JSON.stringify(value)
    if (text.length > RECORD_REPLY_BYTES) return refusal('too_large', 413)
    if ('head' in value) {
      const final = asked.to <= value.head - SAFE_DEPTH
      await keep(rt, key, { text, final }, final ? FINAL_SECONDS : SHORT_SECONDS)
    }
    return answer(text, request)
  } catch (error) {
    const outcome = outcomeOf(error)
    const seconds = failureSeconds(error)
    await keep(rt, failKey, { outcome, seconds }, seconds)
    return failure(outcome, Math.max(budget.retryAfterMs, seconds * 1000))
  }
}
