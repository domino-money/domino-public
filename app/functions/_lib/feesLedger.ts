/**
 * POST /api/fees/v2/ledger: a position NFT's own ledger of settlements, at the edge, over Domino's own Robinhood Chain
 * node (functions/_lib/localRpc.ts). The page folds it with the chain's unclaimed figure (/state) into Fees earned, its
 * measured points and Your APR (src/lib/fees/ledger.ts).
 *
 *   {"tokenIds": ["1".."8"], "fresh"?: true}  →  LedgerResponse (src/lib/fees/types.ts)
 *
 * Why (rugged97's rules for the site's token, C:/dwt/rpc-plan/RUGGED_RPC_SITE_2026-10-02.md, binding): rule 2 forbids
 * reading a pool's ModifyLiquidity or Swap history per request (PONS/USDG's since the deploy cost his node two seconds of
 * CPU and 10.6 MB); a fees history must come from eth_call and our own events. Rule 1: log reads go on from the last
 * block kept per NFT, and only a first visit scans since the deploy. Rule 3: nothing below block 69,249,061.
 *
 * What it reads, all scoped to the NFTs, our contracts or the addresses that are Domino's:
 * - the positions at the head (fees.ts readState: two eth_call, the head's block from ArbSys), and, when an automation
 *   vault holds one, the vault's checkpoint of it (one more eth_call at that block);
 * - round one, one log read for every NFT of the question: the PositionManager's Transfer logs of each (topic3 = the id:
 *   its mint and every address that held it), the engine's FeesRealized for each (the exact fees of every automatic
 *   compound) and DominoSetupV1's SetupMinted for each (who Domino minted it for);
 * - which of the holders Domino's are (one eth_call): the SetupMinted owner, a vault the factory made (isVault), or the
 *   owner of one of the NFT's vaults. A ledger whose NFT a holder that is none of these held is not exact ('unseen') and
 *   reads nothing more, now or later: such an address's transfers are not read (review of the rules, finding 1: the
 *   transfers of a router or a busy contract an NFT was sent to are a scan wider than a pool's history);
 * - round two, one log read for every NFT: the ERC-20 transfers of the pools' currencies between the PoolManager and
 *   those addresses (the blocks where an owner's own settlement can be, and what an owner's collect paid), and the
 *   engine's BudgetApplied of the vaults that compounded them (the service fee of each compound);
 * - at each of those blocks only, the PoolManager's ModifyLiquidity logs of that one block whose sender is the
 *   PositionManager (one-block lookups: never a range of the pool's history), the NFT's own among them by its salt;
 * - the headers of the blocks its settlements are in.
 *
 * Each settlement's fees are known exactly when it is an automatic compound (FeesRealized), the mint (nothing), or an
 * owner's collect (a change of 0) whose transaction did nothing else and paid only ERC-20s to a holder. An owner's add,
 * withdrawal or close settles fees that cannot be told apart from the principal it moves: the ledger says so (`why`),
 * and the page shows Fees ready to collect only. The ledger is exact when every settlement's fees are known, the
 * settlements add up to the position's liquidity now, (a vault's position) the vault's own checkpoint agrees, and (a pool
 * in native ETH, whose payouts leave no log) that checkpoint vouches for every settlement since the last compound.
 *
 * Kept per NFT in the edge cache (KEPT_SECONDS), whatever it came to (review of the rules, findings 4 and 14): with the
 * block its settlements are known through, the block its logs were read through and what those logs named past the
 * first (finding 5), so the next read goes on from its last SAFE_DEPTH blocks (a reorganised tail is read again) and
 * never reads a log twice. A ledger that no later read can make exact (more holders than MAX_HOLDERS, more bytes than
 * ROUND_BYTES or settlements than MAX_ENTRIES, a holder that is not Domino's, settlements that remove more than they
 * add) is kept as that verdict, and nothing more is read for it while it is kept (`too_many` TOO_MANY_SECONDS, then read
 * again; the others KEPT_SECONDS). A first read scans from the floor (round one) and from
 * the mint (round two); a read with more one-block lookups than LEDGER_STEP goes as far as they reach, keeps that, and
 * says `reading`, so the next read goes on. The one-block lookups and the headers of final blocks are kept a year, shared
 * by every NFT. A whole answer is kept LEDGER_SECONDS per set of ids (FRESH_LEDGER_MS for a fresh question, the page's
 * after a settlement it has not seen).
 *
 * The question's byte budget (fees.ts MAX_BYTES) running out is never a verdict (review of the rules, round 4): the NFTs
 * whose reads it did not cover are not answered this time (`reading`, nothing kept for them), and the page asks again.
 */
import { POSITION_MANAGER, SETUP_CONTRACT, SETUP_DEPLOY_BLOCK, SETUP_MINTED_TOPIC, TRANSFER_TOPIC } from './owned'
import { AUTOMATION_SELECTOR, SEQUENCE_FACTORY } from './automation'
import {
  FAILURE_SECONDS,
  FINAL_SECONDS,
  HASH,
  MAX_BYTES,
  MAX_HEADERS,
  POOL_MANAGER,
  RelayError,
  SAFE_DEPTH,
  TOPIC,
  addressWord,
  aggregate,
  answer,
  cacheUrl,
  failure,
  failureSeconds,
  hex,
  keep,
  kept,
  logsBatch,
  newBudget,
  outcomeOf,
  paced,
  post,
  quantity,
  readState,
  refusal,
  resultOf,
  sha256,
  shared,
  stateIdsOf,
  type Budget,
  type FeesRuntime,
} from './fees'
import type { LedgerEntry, LedgerPosition, LedgerResponse, LedgerWhy, StatePositionOk } from '../../src/lib/fees/types'

// ---------------------------------------------------------------------------
// Pins (checked against the contracts and the deployment profile in tests/fees-ledger.test.mjs)
// ---------------------------------------------------------------------------

/** DominoExecutionEngineV1 (docs/deployments/v1-robinhood-mainnet-2026-09-21/deployment.json contracts.engine). */
export const ENGINE = '0x9bef35ea86aedc9489486c4db3d2816ba2ad7ce9'
/** keccak256("FeesRealized(address,bytes32,uint256,bytes32,bytes32,uint128,uint128)"), contracts/src/DominoExecutionEngineV4.sol. */
export const FEES_REALIZED = '0x884839872e03806c67b7182dea9035dedf576b37a5158aa4a0aeeee2e9619e89'
/** keccak256 of BudgetApplied(address,bytes32,bytes32,address,uint256,CompoundAmounts) with its nine uint128 fields. */
export const BUDGET_APPLIED = '0xf2afe26d0039071b4a9564bd91918c7d7adc90de4d80da43f5a55eb3066b2cfb'
/** DominoVaultV4.checkpoint(uint256): its T.Checkpoint (liquidity, the two fee growths last and now, a block and a commitment). */
export const CHECKPOINT_SELECTOR = 'ed64bab2'
/** DominoVaultV4.owner(): the person a vault of the factory's acts for (finding 1: a holder Domino's reads follow). */
export const VAULT_OWNER_SELECTOR = '8da5cb5b'
/** rugged97's rule 3: the lowest block any log is read from (DominoSetupV1's deploy). */
export const LEDGER_FLOOR = SETUP_DEPLOY_BLOCK

// ---------------------------------------------------------------------------
// Sizes and limits
// ---------------------------------------------------------------------------

export const MAX_LEDGER_IDS = 8
export const LEDGER_BODY_BYTES = 512
/** How long a whole answer serves a question for the same ids; a fresh question takes one only within FRESH_LEDGER_MS. */
export const LEDGER_SECONDS = 30
export const FRESH_LEDGER_MS = 2_000
/** How long an NFT's ledger is kept to be read on from, or its verdict to read nothing more for it. */
export const KEPT_SECONDS = 30 * 86_400
/**
 * How long a `too_many` verdict is kept before the NFT is read again (from the floor). Added on purpose 2026-10-02 (review
 * of the rules, round 4): it was kept KEPT_SECONDS, and a question's byte budget running out became that verdict for a
 * month. Only the NFT's own result makes it now (more holders than MAX_HOLDERS, its own read past ROUND_BYTES, more
 * settlements than MAX_ENTRIES), and it is checked again after an hour.
 */
export const TOO_MANY_SECONDS = 3_600
/**
 * The version in the ledger's own cache keys: its kept ledgers and verdicts, its whole answers and its kept failures.
 * Bumped on purpose 2026-10-02 (review of the rules, round 4): 1 → 2 (the kinds `ledger`, `ledgerAnswer`, `ledgerFail` →
 * `ledger2`, …), so no `too_many` a spent budget wrote on the preview's edge cache is read again. The one-block lookups
 * and the headers are the chain's own facts, never a verdict: their keys stay.
 */
export const LEDGER_KEYS = 2
/** The most one-block lookups one read makes; past it the ledger is kept as far as they reached, and says `reading`. */
export const LEDGER_STEP = 200
/** The most settlements one ledger keeps, and the most addresses that held one NFT. */
export const MAX_ENTRIES = 2_000
export const MAX_HOLDERS = 8
/**
 * The most bytes one round of log reads may take (all the ids' holder transfers, say); past it, an NFT alone. Changed on
 * purpose 2026-10-02 (review of the rules, finding 14): 2 MiB, was 4: a round past it and that NFT's own read past it
 * again take half of the answer's MAX_BYTES (fees.ts), so the question's other NFTs still have their reads.
 */
export const ROUND_BYTES = 2 * 1024 * 1024
/**
 * What a round's read leaves of the question's byte budget for the reads after the rounds (the one-block lookups, the
 * headers): a round's read is asked only while the budget holds ROUND_BYTES and this much more (round 4, 2026-10-02), so
 * no read of a round is ever cut by the budget, and the NFTs answered still get their lookups and headers.
 */
export const LEDGER_TAIL_BYTES = 1024 * 1024
/**
 * How long a question whose read was still too large is answered 413 at once (finding 1: it was kept nowhere, so each
 * repeat read it again). Rare since each NFT past ROUND_BYTES alone is kept as `too_many`.
 */
export const TOO_LARGE_SECONDS = 600

const ZERO = '0x0000000000000000000000000000000000000000'
const WORDS = /^0x(?:[0-9a-f]{64})*$/
const ADDRESS_WORD = /^0x0{24}[0-9a-f]{40}$/
const word = (n: bigint) => `0x${BigInt.asUintN(256, n).toString(16).padStart(64, '0')}`
const POOL_WORD = `0x${addressWord(POOL_MANAGER)}`
const SENDER_WORD = `0x${addressWord(POSITION_MANAGER)}`
const addressOf = (topic: string) => `0x${topic.slice(26)}`
const one = <T>(list: readonly T[]): T | readonly T[] => (list.length === 1 ? list[0] : list)
const unique = <T>(list: readonly T[]): T[] => [...new Set(list)]
const chunks = <T>(list: readonly T[], size: number): T[][] => Array.from({ length: Math.ceil(list.length / size) }, (_, i) => list.slice(i * size, i * size + size))
/** Round one's one read: the NFTs' own Transfer logs, the engine's FeesRealized and DominoSetupV1's SetupMinted for them. */
const ROUND_ONE_ADDRESSES = [POSITION_MANAGER, ENGINE, SETUP_CONTRACT]
const ROUND_ONE_TOPICS = [TRANSFER_TOPIC, FEES_REALIZED, SETUP_MINTED_TOPIC]

// ---------------------------------------------------------------------------
// The question
// ---------------------------------------------------------------------------

export interface LedgerQuestion {
  /** Ascending, 1..8 distinct. */
  ids: bigint[]
  /** The page saw a settlement the ledger it has does not hold: a kept answer counts only within FRESH_LEDGER_MS. */
  fresh: boolean
}

/** A ledger body as its question, or null unless it is exactly {"tokenIds": [1..8 decimal ids]} and, at most, "fresh": true. */
export function ledgerRequestOf(body: Record<string, unknown>): LedgerQuestion | null {
  if ('fresh' in body && body.fresh !== true) return null
  const { fresh, ...rest } = body
  const ids = stateIdsOf(rest)
  return ids && ids.length <= MAX_LEDGER_IDS ? { ids, fresh: fresh === true } : null
}

// ---------------------------------------------------------------------------
// Logs, checked
// ---------------------------------------------------------------------------

interface Log {
  address: string
  topics: string[]
  data: string
  block: number
  index: number
  tx: string
}

/** One log as the node sent it, checked (its address one of `addresses`, its block in [from, to]); null for a removed one. */
function logOf(raw: unknown, addresses: readonly string[], from: number, to: number): Log | null {
  if (!raw || typeof raw !== 'object') throw new RelayError('fatal', 'invalid_log')
  const log = raw as Record<string, unknown>
  if (log.removed === true) return null
  const address = typeof log.address === 'string' ? log.address.toLowerCase() : ''
  if (!addresses.includes(address)) throw new RelayError('fatal', 'invalid_log_address')
  const topics = Array.isArray(log.topics) ? log.topics.map((topic) => (typeof topic === 'string' ? topic.toLowerCase() : '')) : []
  if (topics.length < 1 || topics.length > 4 || !topics.every((topic) => HASH.test(topic))) throw new RelayError('fatal', 'invalid_log_topics')
  const data = typeof log.data === 'string' ? log.data.toLowerCase() : ''
  if (!WORDS.test(data)) throw new RelayError('fatal', 'invalid_log_data')
  const tx = typeof log.transactionHash === 'string' ? log.transactionHash.toLowerCase() : ''
  if (!HASH.test(tx)) throw new RelayError('fatal', 'invalid_log_tx')
  const block = quantity(log.blockNumber)
  if (block < from || block > to) throw new RelayError('fatal', 'log_out_of_range')
  return { address, topics, data, block, index: quantity(log.logIndex), tx }
}

/** The `n`th 32-byte word of a log's data. */
const wordAt = (data: string, n: number) => BigInt(`0x${data.slice(2 + 64 * n, 2 + 64 * (n + 1))}`)
const wordsIn = (data: string) => (data.length - 2) / 64
const byOrder = (a: { block: number; index: number }, b: { block: number; index: number }) => a.block - b.block || a.index - b.index

/** One PositionManager ModifyLiquidity of a block, as a one-block lookup keeps it. */
interface Modify {
  index: number
  tx: string
  poolId: string
  tickLower: number
  tickUpper: number
  delta: string
  salt: string
}

function modifyOf(log: Log): Modify {
  if (log.topics.length !== 3 || log.topics[0] !== TOPIC.ModifyLiquidity || log.topics[2] !== SENDER_WORD || wordsIn(log.data) !== 4) throw new RelayError('fatal', 'invalid_log_topics')
  return {
    index: log.index,
    tx: log.tx,
    poolId: log.topics[1],
    tickLower: Number(BigInt.asIntN(24, wordAt(log.data, 0))),
    tickUpper: Number(BigInt.asIntN(24, wordAt(log.data, 1))),
    delta: BigInt.asIntN(256, wordAt(log.data, 2)).toString(),
    salt: wordAt(log.data, 3).toString(),
  }
}

// ---------------------------------------------------------------------------
// What is kept
// ---------------------------------------------------------------------------

/**
 * What an NFT's logs named, per log, in the blocks its ledger is not worked out for yet: kept with the ledger past
 * `through`, so the next read does not read those logs again (finding 5). Amounts are decimal, per side of the pair.
 */
interface Facts {
  /** The blocks to look into (its burns, and the blocks below), ascending. */
  candidates: number[]
  /** The engine's FeesRealized for the NFT: the vault that compounded it, and the fees. */
  realized: Array<{ block: number; tx: string; vault: string; amounts: [string, string] }>
  /** The engine's BudgetApplied for the NFT: the service fee. */
  service: Array<{ block: number; tx: string; amounts: [string, string] }>
  /** What the PoolManager paid one of the addresses followed. */
  paidIn: Array<{ block: number; tx: string; amounts: [string, string] }>
  /** A transaction in which one of the addresses followed paid the PoolManager. */
  paidOut: Array<{ block: number; tx: string }>
}

const noFacts = (): Facts => ({ candidates: [], realized: [], service: [], paidIn: [], paidOut: [] })

/** `facts` of the blocks `keepIt` keeps. */
function factsWhere(facts: Facts, keepIt: (block: number) => boolean): Facts {
  return {
    candidates: facts.candidates.filter(keepIt),
    realized: facts.realized.filter((fact) => keepIt(fact.block)),
    service: facts.service.filter((fact) => keepIt(fact.block)),
    paidIn: facts.paidIn.filter((fact) => keepIt(fact.block)),
    paidOut: facts.paidOut.filter((fact) => keepIt(fact.block)),
  }
}

/** A verdict no later read changes: nothing is read for the NFT again while it is kept (`too_many` only an hour, round 4). */
type Final = 'too_many' | 'unseen' | 'liquidity'
const FINALS: readonly string[] = ['too_many', 'unseen', 'liquidity']

/** An NFT's ledger as kept between reads. */
interface Kept {
  v: 2
  poolId: string
  /** Every settlement up to this block is in `entries`. */
  through: number
  /** The NFT's logs and its followed addresses' transfers were read up to this block; what they named past `through` is `pending`. */
  scanned: number
  /** null: no mint at or above the floor (minted before it), checked up to `scanned`. */
  mint: { block: number; tx: string; t: number } | null
  holders: string[]
  /** The addresses whose transfers are followed, each found to be Domino's: the SetupMinted owner, vaults, vault owners. */
  trusted: string[]
  /** Those of them that are vaults the factory made. */
  vaults: string[]
  entries: LedgerEntry[]
  final: Final | null
  pending: Facts
}

const isBlock = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0
const isText = (value: unknown): value is string => typeof value === 'string'
const isPair = (value: unknown): value is [string, string] => Array.isArray(value) && value.length === 2 && value.every(isText)
const isFact = (value: unknown, more: (fact: Record<string, unknown>) => boolean): boolean => !!value && typeof value === 'object' && isBlock((value as Record<string, unknown>).block) && isText((value as Record<string, unknown>).tx) && more(value as Record<string, unknown>)
const isFacts = (value: unknown): value is Facts => {
  const facts = value as Facts | null
  return (
    !!facts &&
    Array.isArray(facts.candidates) &&
    facts.candidates.every(isBlock) &&
    Array.isArray(facts.realized) &&
    facts.realized.every((fact) => isFact(fact, (one) => isText(one.vault) && isPair(one.amounts))) &&
    Array.isArray(facts.service) &&
    facts.service.every((fact) => isFact(fact, (one) => isPair(one.amounts))) &&
    Array.isArray(facts.paidIn) &&
    facts.paidIn.every((fact) => isFact(fact, (one) => isPair(one.amounts))) &&
    Array.isArray(facts.paidOut) &&
    facts.paidOut.every((fact) => isFact(fact, () => true))
  )
}

const isKept = (value: unknown, poolId: string): value is Kept => {
  const kept = value as Kept | null
  return (
    !!kept &&
    kept.v === 2 &&
    kept.poolId === poolId &&
    isBlock(kept.through) &&
    isBlock(kept.scanned) &&
    kept.through <= kept.scanned &&
    Array.isArray(kept.holders) &&
    kept.holders.every(isText) &&
    Array.isArray(kept.trusted) &&
    kept.trusted.every(isText) &&
    Array.isArray(kept.vaults) &&
    kept.vaults.every(isText) &&
    Array.isArray(kept.entries) &&
    (kept.final === null || FINALS.includes(kept.final)) &&
    isFacts(kept.pending) &&
    (kept.mint === null || (typeof kept.mint === 'object' && isBlock(kept.mint.block) && isText(kept.mint.tx) && isBlock(kept.mint.t)))
  )
}

const keptUrl = (origin: string, id: bigint) => cacheUrl(origin, `ledger${LEDGER_KEYS}`, id.toString(), 0)
/** How long a verdict is kept: `too_many` only an hour, then read again (round 4); the others as a ledger. */
const lifeOf = (final: Final | null) => (final === 'too_many' ? TOO_MANY_SECONDS : KEPT_SECONDS)
const blockUrl = (origin: string, block: number) => cacheUrl(origin, 'pmBlock', '0', block)
const headerUrl = (origin: string, block: number) => cacheUrl(origin, 'header', '0', block)

// ---------------------------------------------------------------------------
// The read
// ---------------------------------------------------------------------------

/** One NFT on its way through the read. */
interface Work {
  id: bigint
  key: string
  /** Its id as a log topic. */
  word: string
  state: StatePositionOk
  vault: string | null
  checkpoint: { liquidity: bigint; last0: bigint; last1: bigint } | null
  kept: Kept | null
  /** The first block whose settlements are worked out this time; the kept entries before it stay. */
  entriesFrom: number
  /** The first block its logs are read from this time; what the kept facts hold before it is not read again. */
  logsFrom: number
  mint: { block: number; tx: string; t: number } | null
  holders: string[]
  trusted: Set<string>
  vaults: Set<string>
  /** The SetupMinted log this read found for it: who Domino minted it for, and in which transaction. */
  minted: { owner: string; tx: string } | null
  /** The kept facts in [entriesFrom, logsFrom), then what this read's logs named. */
  facts: Facts
  /** The blocks to look into, ascending. */
  candidates: number[]
  through: number
  final: Final | null
  /**
   * Not answered this time (round 4, 2026-10-02): the question's byte budget did not hold its read. Never a verdict and
   * never kept: it is answered `reading` with what it has kept, and the page asks again.
   */
  unanswered: boolean
}

/** Each vault's checkpoint of its NFT at `block` (one eth_call); a checkpoint that does not read is left out. */
async function checkpointsAt(rt: FeesRuntime, budget: Budget, works: Work[], block: number): Promise<void> {
  const held = works.filter((work) => work.vault)
  if (held.length === 0) return
  const results = await aggregate(rt, budget, held.map((work) => ({ target: work.vault as string, data: CHECKPOINT_SELECTOR + word(work.id).slice(2) })), block)
  held.forEach((work, i) => {
    const result = results[i]
    // aggregate3's return data comes without its 0x (owned.ts decodeAggregate3).
    const data = result.data.startsWith('0x') ? result.data : `0x${result.data}`
    if (!result.success || data.length < 2 + 64 * 3) return
    const liquidity = wordAt(data, 0)
    if (liquidity === 0n) return
    work.checkpoint = { liquidity, last0: wordAt(data, 1), last1: wordAt(data, 2) }
  })
}

/** Block timestamps: kept per block once final, else one batched eth_getBlockByNumber per MAX_HEADERS. */
async function headerTimes(rt: FeesRuntime, budget: Budget, origin: string, head: number, blocks: readonly number[]): Promise<Map<number, number>> {
  const known = new Map<number, number>()
  const missing: number[] = []
  for (const block of new Set(blocks)) {
    const hit = await kept<{ t: number }>(rt, headerUrl(origin, block))
    if (hit && Number.isSafeInteger(hit.value.t)) known.set(block, hit.value.t)
    else missing.push(block)
  }
  for (let at = 0; at < missing.length; at += MAX_HEADERS) {
    const part = missing.slice(at, at + MAX_HEADERS)
    const reply = await paced(rt, budget, () => post(rt, budget, part.map((block, id) => ({ jsonrpc: '2.0', id, method: 'eth_getBlockByNumber', params: [hex(block), false] })), false))
    if (!Array.isArray(reply) || reply.length !== part.length) throw new RelayError('fatal', 'invalid_batch')
    const seen = new Set<number>()
    for (const envelope of reply) {
      const id = (envelope as { id?: unknown } | null)?.id
      if (typeof id !== 'number' || !Number.isSafeInteger(id) || id < 0 || id >= part.length || seen.has(id)) throw new RelayError('fatal', 'invalid_batch')
      seen.add(id)
      const header = resultOf(envelope)
      if (!header || typeof header !== 'object') throw new RelayError('fatal', 'missing_header')
      const { number, timestamp } = header as { number?: unknown; timestamp?: unknown }
      if (quantity(number) !== part[id]) throw new RelayError('fatal', 'invalid_header')
      const t = quantity(timestamp)
      known.set(part[id], t)
      if (part[id] <= head - SAFE_DEPTH) await keep(rt, headerUrl(origin, part[id]), { t }, FINAL_SECONDS)
    }
  }
  return known
}

/**
 * The PositionManager's ModifyLiquidity logs of each of `missing` (one-block lookups, none kept yet), kept a year once
 * final. The question's byte budget spent (round 4): the blocks looked into so far, the NFTs then going as far as those
 * (`reading`), as past LEDGER_STEP.
 */
async function lookups(rt: FeesRuntime, budget: Budget, origin: string, head: number, missing: readonly number[]): Promise<Map<number, Modify[]>> {
  const out = new Map<number, Modify[]>()
  for (let at = 0; at < missing.length; at += 50) {
    const part = missing.slice(at, at + 50)
    // One block each (rugged97's rule 2: the PoolManager's logs are never read over a range), sender the PositionManager.
    let results: unknown[]
    try {
      results = await logsBatch(rt, budget, part.map((block) => ({ address: POOL_MANAGER, fromBlock: hex(block), toBlock: hex(block), topics: [TOPIC.ModifyLiquidity, null, SENDER_WORD] })), ROUND_BYTES)
    } catch (error) {
      if (error instanceof RelayError && error.message === 'budget_spent') break
      throw error
    }
    for (const [i, result] of results.entries()) {
      const block = part[i]
      const modifies: Modify[] = []
      for (const raw of result as unknown[]) {
        const log = logOf(raw, [POOL_MANAGER], block, block)
        if (log) modifies.push(modifyOf(log))
      }
      out.set(block, modifies)
      if (block <= head - SAFE_DEPTH) await keep(rt, blockUrl(origin, block), modifies, FINAL_SECONDS)
    }
  }
  return out
}

/**
 * A round's one log read, within ROUND_BYTES: asked only while the question's byte budget holds that and
 * LEDGER_TAIL_BYTES more, else `budget_spent` before anything is sent (round 4, 2026-10-02).
 */
function roundRead(rt: FeesRuntime, budget: Budget, filters: unknown[]): Promise<unknown[]> {
  if (MAX_BYTES - budget.bytes < ROUND_BYTES + LEDGER_TAIL_BYTES) return Promise.reject(new RelayError('bytes', 'budget_spent'))
  return logsBatch(rt, budget, filters, ROUND_BYTES)
}

/**
 * `ask(list)`'s logs, applied by `apply`, for every NFT of `works` at once (one read, rugged97's rule 1: one scan, not one
 * per NFT and filter); past ROUND_BYTES, each NFT alone, and one whose own read is still past ROUND_BYTES is `too_many`.
 *
 * Changed on purpose 2026-10-02 (review of the rules, round 4): any byte failure was `too_many`, kept a month, so the
 * question's budget running out (`budget_spent`) made the NFTs it reached that verdict. Only the NFT's own read past its
 * own cap (`attempt_cap`, the read alone) is a verdict now; a read the budget did not hold leaves its NFTs, and every one
 * after them, `unanswered` this time.
 */
async function together(works: Work[], ask: (list: Work[]) => Promise<unknown[] | null>, apply: (list: Work[], results: unknown[]) => void): Promise<void> {
  /** 'done', or what stopped the read: its own cap ('own') or the question's budget ('spent'). */
  const tried = async (list: Work[]): Promise<'done' | 'own' | 'spent'> => {
    try {
      const results = await ask(list)
      if (results) apply(list, results)
      return 'done'
    } catch (error) {
      if (!(error instanceof RelayError) || error.kind !== 'bytes') throw error
      return error.message === 'attempt_cap' ? 'own' : 'spent'
    }
  }
  if (works.length === 0) return
  const all = await tried(works)
  if (all === 'done') return
  let spent = all === 'spent'
  for (const work of works) {
    const alone = spent ? 'spent' : works.length === 1 ? all : await tried([work])
    if (alone === 'own') work.final = 'too_many'
    else if (alone === 'spent') {
      work.unanswered = true
      spent = true
    }
  }
}

/**
 * Round one: for every NFT of `works` together, in one log read from the earliest of their `logsFrom` to the head
 * (finding 7: it was two reads per NFT, each since the deploy on a first visit), its own Transfer logs (its mint, its
 * holders, its burns), the engine's FeesRealized for it and DominoSetupV1's SetupMinted for it.
 */
async function roundOne(rt: FeesRuntime, budget: Budget, works: Work[], head: number): Promise<void> {
  const from = (list: Work[]) => Math.min(...list.map((work) => work.logsFrom))
  await together(
    works,
    (list) => roundRead(rt, budget, [{ address: ROUND_ONE_ADDRESSES, fromBlock: hex(from(list)), toBlock: hex(head), topics: [ROUND_ONE_TOPICS, null, null, one(list.map((work) => work.word))] }]),
    (list, results) => {
      const byWord = new Map(list.map((work) => [work.word, work]))
      const logs = (results[0] as unknown[]).map((raw) => logOf(raw, ROUND_ONE_ADDRESSES, from(list), head)).filter((log): log is Log => log !== null)
      for (const log of logs.sort(byOrder)) {
        const work = log.topics.length === 4 ? byWord.get(log.topics[3]) : undefined
        if (!work) throw new RelayError('fatal', 'invalid_log_topics')
        // Another NFT's earlier range: its own logs before its `logsFrom` are known already.
        if (log.block < work.logsFrom) continue
        if (log.address === POSITION_MANAGER && log.topics[0] === TRANSFER_TOPIC) {
          if (log.data !== '0x' || !ADDRESS_WORD.test(log.topics[1]) || !ADDRESS_WORD.test(log.topics[2])) throw new RelayError('fatal', 'invalid_log_topics')
          const [sender, receiver] = [addressOf(log.topics[1]), addressOf(log.topics[2])]
          if (sender === ZERO) {
            if (work.mint && work.mint.tx !== log.tx) throw new RelayError('fatal', 'two_mints')
            work.mint = { block: log.block, tx: log.tx, t: work.mint?.t ?? 0 }
          }
          if (receiver !== ZERO && !work.holders.includes(receiver)) work.holders.push(receiver)
          if (receiver === ZERO) work.facts.candidates.push(log.block)
        } else if (log.address === ENGINE && log.topics[0] === FEES_REALIZED) {
          if (wordsIn(log.data) !== 4 || !ADDRESS_WORD.test(log.topics[1])) throw new RelayError('fatal', 'invalid_log_topics')
          const [amount0, amount1] = [wordAt(log.data, 2), wordAt(log.data, 3)]
          if (amount0 >> 128n !== 0n || amount1 >> 128n !== 0n) throw new RelayError('fatal', 'invalid_log_data')
          work.facts.realized.push({ block: log.block, tx: log.tx, vault: addressOf(log.topics[1]), amounts: [amount0.toString(), amount1.toString()] })
        } else if (log.address === SETUP_CONTRACT && log.topics[0] === SETUP_MINTED_TOPIC) {
          if (wordsIn(log.data) !== 3 || !ADDRESS_WORD.test(log.topics[2])) throw new RelayError('fatal', 'invalid_log_topics')
          work.minted = { owner: addressOf(log.topics[2]), tx: log.tx }
        } else throw new RelayError('fatal', 'invalid_log_topics')
      }
      // Who Domino minted it for (DominoSetupV1 mints to the operation's own owner, its msg.sender), in its mint itself.
      for (const work of list) if (work.minted && work.mint && work.minted.tx === work.mint.tx) work.trusted.add(work.minted.owner)
    },
  )
}

/** The addresses whose transfers would be this NFT's settlements: its holders, and the vaults that compounded it. */
const touching = (work: Work) => unique([...work.holders, ...work.facts.realized.map((fact) => fact.vault)])

/**
 * Which addresses of each NFT are Domino's (finding 1): the SetupMinted owner (round one), the vault its automation runs
 * in now (readState asked the factory already), a vault the factory made (isVault, one eth_call for all the NFTs), or the
 * owner of one of its vaults (a Domino-compound position handed back; one more eth_call, only when such a holder is
 * left). An NFT one of whose holders or compounding vaults is none of these is `unseen` for good, and nothing more is read
 * for it: an address that is not Domino's is never followed.
 */
async function trust(rt: FeesRuntime, budget: Budget, works: Work[], head: number): Promise<void> {
  if (works.length === 0) return
  for (const work of works) {
    if (!work.vault) continue
    work.trusted.add(work.vault)
    work.vaults.add(work.vault)
  }
  const unknown = unique(works.flatMap((work) => touching(work).filter((address) => !work.trusted.has(address))))
  const made = new Set<string>()
  for (const part of chunks(unknown, 50)) {
    const results = await aggregate(rt, budget, part.map((address) => ({ target: SEQUENCE_FACTORY, data: AUTOMATION_SELECTOR.isVault + addressWord(address) })), head)
    results.forEach((result, i) => {
      const data = result.data.startsWith('0x') ? result.data.slice(2) : result.data
      if (result.success && data.length >= 64 && BigInt(`0x${data.slice(0, 64)}`) === 1n) made.add(part[i])
    })
  }
  for (const work of works) {
    for (const address of touching(work)) {
      if (!made.has(address)) continue
      work.trusted.add(address)
      work.vaults.add(address)
    }
  }
  const left = works.filter((work) => work.holders.some((holder) => !work.trusted.has(holder)) && work.vaults.size > 0)
  const vaults = unique(left.flatMap((work) => [...work.vaults]))
  const owners = new Map<string, string>()
  for (const part of chunks(vaults, 50)) {
    // A vault the factory made: its owner() is Domino's own code.
    const results = await aggregate(rt, budget, part.map((vault) => ({ target: vault, data: VAULT_OWNER_SELECTOR })), head)
    results.forEach((result, i) => {
      const data = result.data.startsWith('0x') ? result.data.slice(2) : result.data
      if (result.success && /^0{24}[0-9a-f]{40}/.test(data)) owners.set(part[i], `0x${data.slice(24, 64)}`)
    })
  }
  for (const work of left) {
    for (const holder of work.holders) if ([...work.vaults].some((vault) => owners.get(vault) === holder)) work.trusted.add(holder)
  }
  for (const work of works) if (touching(work).some((address) => !work.trusted.has(address))) work.final = 'unseen'
}

/** Where an NFT's followed addresses' transfers are read from this time: its logs' start, never before its mint. */
const startOf = (work: Work) => Math.max(work.logsFrom, work.mint?.block ?? LEDGER_FLOOR)
const tokensOf = (work: Work) => [work.state.poolKey.currency0, work.state.poolKey.currency1].filter((address) => address !== ZERO)

/**
 * Round two, for every NFT of `works` together (finding 7): the ERC-20 transfers of their pools' currencies between the
 * PoolManager and their followed addresses since each one's start, one log read per eight currencies and seven addresses
 * (both directions in one: a transfer between two followed addresses is left out); and the engine's BudgetApplied of the
 * vaults over the compounds this read found.
 */
async function roundTwo(rt: FeesRuntime, budget: Budget, works: Work[], head: number): Promise<void> {
  type Ask = { kind: 'paid' | 'budget'; filter: unknown; from: number; to: number; addresses: string[] }
  const plan = (list: Work[]): Ask[] => {
    const asks: Ask[] = []
    const paying = list.filter((work) => tokensOf(work).length > 0 && work.trusted.size > 0)
    if (paying.length > 0) {
      const from = Math.min(...paying.map(startOf))
      const owners = unique(paying.flatMap((work) => [...work.trusted])).map((address) => `0x${addressWord(address)}`)
      for (const tokens of chunks(unique(paying.flatMap(tokensOf)), 8)) {
        for (const part of chunks(owners, 7)) {
          const side = [POOL_WORD, ...part]
          asks.push({ kind: 'paid', from, to: head, addresses: tokens, filter: { address: one(tokens), fromBlock: hex(from), toBlock: hex(head), topics: [TRANSFER_TOPIC, side, side] } })
        }
      }
    }
    const fresh = list.flatMap((work) => work.facts.realized.filter((fact) => fact.block >= work.logsFrom))
    if (fresh.length > 0) {
      const [lo, hi] = [Math.min(...fresh.map((fact) => fact.block)), Math.max(...fresh.map((fact) => fact.block))]
      for (const part of chunks(unique(fresh.map((fact) => `0x${addressWord(fact.vault)}`)), 8)) {
        asks.push({ kind: 'budget', from: lo, to: hi, addresses: [ENGINE], filter: { address: ENGINE, fromBlock: hex(lo), toBlock: hex(hi), topics: [BUDGET_APPLIED, one(part)] } })
      }
    }
    return asks
  }
  const asked = new Map<Work[], Ask[]>()
  await together(
    works,
    async (list) => {
      const asks = plan(list)
      asked.set(list, asks)
      return asks.length > 0 ? roundRead(rt, budget, asks.map((ask) => ask.filter)) : null
    },
    (list, results) => {
      const asks = asked.get(list) ?? []
      asks.forEach((ask, i) => {
        for (const raw of results[i] as unknown[]) {
          const log = logOf(raw, ask.addresses, ask.from, ask.to)
          if (!log) continue
          if (ask.kind === 'budget') {
            if (log.topics.length !== 4 || log.topics[0] !== BUDGET_APPLIED || wordsIn(log.data) !== 11) throw new RelayError('fatal', 'invalid_log_topics')
            // Another NFT's compound by the same vault is not this one's.
            const work = list.find((one) => one.id === wordAt(log.data, 1))
            if (!work || log.block < work.logsFrom) continue
            const currency = `0x${(wordAt(log.data, 0) & ((1n << 160n) - 1n)).toString(16).padStart(40, '0')}`
            const side = currency === work.state.poolKey.currency0 ? 0 : currency === work.state.poolKey.currency1 ? 1 : -1
            if (side === -1) continue
            const fee = wordAt(log.data, 2 + 5).toString()
            work.facts.service.push({ block: log.block, tx: log.tx, amounts: side === 0 ? [fee, '0'] : ['0', fee] })
            continue
          }
          if (log.topics.length !== 3 || log.topics[0] !== TRANSFER_TOPIC || wordsIn(log.data) !== 1) throw new RelayError('fatal', 'invalid_log_topics')
          const [sender, receiver] = [log.topics[1], log.topics[2]]
          const paid = sender === POOL_WORD && receiver !== POOL_WORD
          const paying = receiver === POOL_WORD && sender !== POOL_WORD
          // Between two followed addresses, or the PoolManager's own: not a settlement.
          if (!paid && !paying) continue
          const holder = paid ? receiver : sender
          if (!ADDRESS_WORD.test(holder)) continue
          const amount = wordAt(log.data, 0).toString()
          for (const work of list) {
            if (log.block < startOf(work) || !work.trusted.has(addressOf(holder))) continue
            const side = log.address === work.state.poolKey.currency0 ? 0 : log.address === work.state.poolKey.currency1 ? 1 : -1
            if (side === -1) continue
            if (paid) work.facts.paidIn.push({ block: log.block, tx: log.tx, amounts: side === 0 ? [amount, '0'] : ['0', amount] })
            else work.facts.paidOut.push({ block: log.block, tx: log.tx })
          }
        }
      })
    },
  )
}

/** Per transaction, the sums of `facts`' amounts. */
function sums(facts: ReadonlyArray<{ tx: string; amounts: [string, string] }>): Map<string, [bigint, bigint]> {
  const out = new Map<string, [bigint, bigint]>()
  for (const fact of facts) {
    const sum = out.get(fact.tx) ?? [0n, 0n]
    out.set(fact.tx, [sum[0] + BigInt(fact.amounts[0]), sum[1] + BigInt(fact.amounts[1])])
  }
  return out
}

/**
 * The NFT's entries in [work.entriesFrom, work.through], from the one-block lookups and its facts. `broken`: its own
 * ModifyLiquidity logs remove more than the ones before them added (an add this ledger cannot see: one paid in ETH, say);
 * that ledger is `liquidity` for good (finding 10: it threw, and failed every NFT of the question).
 */
function entriesOf(work: Work, found: Map<number, Modify[]>, running: bigint): { entries: Omit<LedgerEntry, 't'>[]; unseen: boolean; broken: boolean } {
  const { state } = work
  const salt = work.id.toString()
  const facts = factsWhere(work.facts, (block) => block >= work.entriesFrom && block <= work.through)
  const own: Array<Modify & { block: number }> = []
  const others = new Set<string>()
  for (const block of work.candidates) {
    if (block > work.through) break
    for (const modify of found.get(block) ?? []) {
      const mine = modify.poolId === state.poolId && modify.salt === salt
      if (mine && (modify.tickLower !== state.tickLower || modify.tickUpper !== state.tickUpper)) throw new RelayError('fatal', 'invalid_position')
      if (mine) own.push({ ...modify, block })
      else others.add(modify.tx)
    }
  }
  own.sort(byOrder)
  const realized = sums(facts.realized)
  const service = sums(facts.service)
  const paidIn = sums(facts.paidIn)
  const paidOut = new Set(facts.paidOut.map((fact) => fact.tx))
  const native = state.poolKey.currency0 === ZERO || state.poolKey.currency1 === ZERO
  const seenTx = new Set<string>()
  const entries: Omit<LedgerEntry, 't'>[] = []
  let liquidity = running
  for (const modify of own) {
    const first = !seenTx.has(modify.tx)
    seenTx.add(modify.tx)
    const delta = BigInt(modify.delta)
    liquidity += delta
    if (liquidity < 0n) return { entries, unseen: false, broken: true }
    const auto = realized.get(modify.tx)
    const kind: LedgerEntry['kind'] = work.mint && modify.tx === work.mint.tx && first && delta > 0n ? 'mint' : delta === 0n ? 'collect' : delta > 0n ? 'increase' : liquidity === 0n ? 'close' : 'decrease'
    const base = { block: modify.block, index: modify.index, tx: modify.tx, kind, delta: delta.toString() }
    if (kind === 'mint') entries.push({ ...base, fees: ['0', '0'] })
    else if (auto) {
      const paid = first ? service.get(modify.tx) : undefined
      entries.push({ ...base, fees: first ? [auto[0].toString(), auto[1].toString()] : ['0', '0'], auto: true, ...(paid ? { service: [paid[0].toString(), paid[1].toString()] as [string, string] } : {}) })
    } else if (delta !== 0n) entries.push({ ...base, fees: null, why: 'manual' })
    else if (native) entries.push({ ...base, fees: null, why: 'native' })
    else if (others.has(modify.tx) || paidOut.has(modify.tx) || !first) entries.push({ ...base, fees: null, why: 'shared' })
    else {
      const paid = paidIn.get(modify.tx)
      if (!paid) entries.push({ ...base, fees: null, why: 'unseen' })
      else entries.push({ ...base, fees: [paid[0].toString(), paid[1].toString()] })
    }
  }
  // A compound the engine names whose own ModifyLiquidity was not found: something this read did not see.
  const unseen = [...realized.keys()].some((tx) => !own.some((modify) => modify.tx === tx))
  return { entries, unseen, broken: false }
}

/** The ledger of each of `ids` at the node's head (LedgerResponse). `origin`: the edge cache's prefix. */
export async function readLedger(rt: FeesRuntime, budget: Budget, origin: string, ids: readonly bigint[]): Promise<LedgerResponse> {
  const state = await readState(rt, budget, ids, true)
  const head = state.block
  const vaults = new Map((state.automation ?? []).filter((one): one is typeof one & { vault: string } => 'vault' in one && typeof one.vault === 'string').map((one) => [one.tokenId, one.vault]))
  const works: Work[] = []
  for (const position of state.positions) {
    if (!position.ok) continue
    const id = BigInt(position.tokenId)
    const hit = await kept<unknown>(rt, keptUrl(origin, id))
    let was = hit && isKept(hit.value, position.poolId) ? hit.value : null
    // A `too_many` verdict is checked again once its hour is over (round 4): read anew, as a first read.
    if (hit && was?.final === 'too_many' && hit.ageMs >= TOO_MANY_SECONDS * 1000) was = null
    // A node behind the blocks kept (a restart, a catch-up; finding 8): read on from where it stands, the kept ledger kept.
    // One rolled back past the mint itself is read anew.
    if (was?.mint && was.mint.block > head) was = null
    const through = was ? Math.min(was.through, head) : 0
    const scanned = was ? Math.min(was.scanned, head) : 0
    const start = was?.mint?.block ?? LEDGER_FLOOR
    // The logs from the last SAFE_DEPTH blocks they were read through (a reorganised tail is read again); the settlements
    // from the first block not worked out, the kept facts filling in between.
    const logsFrom = was ? Math.max(start, scanned + 1 - SAFE_DEPTH, LEDGER_FLOOR) : LEDGER_FLOOR
    const entriesFrom = was ? Math.max(start, Math.min(through + 1, logsFrom), LEDGER_FLOOR) : LEDGER_FLOOR
    works.push({
      id,
      key: position.tokenId,
      word: word(id),
      state: position,
      vault: vaults.get(position.tokenId) ?? null,
      checkpoint: null,
      kept: was,
      entriesFrom,
      logsFrom,
      mint: was?.mint ?? null,
      holders: [...(was?.holders ?? [])],
      trusted: new Set(was?.trusted ?? []),
      vaults: new Set(was?.vaults ?? []),
      minted: null,
      facts: was ? factsWhere(was.pending, (block) => block >= entriesFrom && block < logsFrom) : noFacts(),
      candidates: [],
      through: head,
      final: was?.final ?? null,
      unanswered: false,
    })
  }
  const live = () => works.filter((work) => !work.final && !work.unanswered)
  await checkpointsAt(rt, budget, live(), head)
  await roundOne(rt, budget, live().filter((work) => !(work.kept && work.kept.mint === null)), head)
  for (const work of live()) if (work.holders.length > MAX_HOLDERS) work.final = 'too_many'
  await trust(rt, budget, live().filter((work) => work.mint), head)
  await roundTwo(rt, budget, live().filter((work) => work.mint), head)
  // A verdict is kept at once (finding 14): a later failure of this question does not make the next one read it again.
  // `too_many` for an hour only (round 4), the others KEPT_SECONDS.
  const told = new Set<Work>()
  for (const work of works) {
    if (!work.final || work.kept?.final) continue
    await keep(rt, keptUrl(origin, work.id), verdict(work, work.final, work.mint, head), lifeOf(work.final))
    told.add(work)
  }

  // The blocks to look into: the mint's, the burns', the compounds' and the payments'.
  for (const work of works) {
    if (!work.mint || work.final || work.unanswered) continue
    const blocks = new Set<number>(work.facts.candidates)
    if (work.mint.block >= work.entriesFrom) blocks.add(work.mint.block)
    for (const fact of [...work.facts.realized, ...work.facts.paidIn, ...work.facts.paidOut]) blocks.add(fact.block)
    work.candidates = [...blocks].filter((block) => block >= work.entriesFrom && block <= head).sort((a, b) => a - b)
  }
  // At most LEDGER_STEP lookups of blocks not kept, oldest first across the NFTs; an NFT whose next block is past them
  // goes as far as the block before it.
  const all = [...new Set(works.flatMap((work) => work.candidates))].sort((a, b) => a - b)
  const known = new Map<number, Modify[]>()
  const fresh: number[] = []
  for (const block of all) {
    const hit = block <= head - SAFE_DEPTH ? await kept<Modify[]>(rt, blockUrl(origin, block)) : null
    if (hit && Array.isArray(hit.value)) known.set(block, hit.value)
    else fresh.push(block)
  }
  for (const [block, modifies] of await lookups(rt, budget, origin, head, fresh.slice(0, LEDGER_STEP))) known.set(block, modifies)
  for (const work of works) {
    const next = work.candidates.find((block) => !known.has(block))
    if (next !== undefined) work.through = next - 1
  }

  const pending: Array<{ work: Work; entries: Omit<LedgerEntry, 't'>[]; unseen: boolean }> = []
  const newBlocks: number[] = []
  for (const work of works) {
    if (work.unanswered) continue
    if (work.mint && work.mint.t === 0) newBlocks.push(work.mint.block)
    if (!work.mint || work.final) {
      pending.push({ work, entries: [], unseen: false })
      continue
    }
    const before = (work.kept?.entries ?? []).filter((entry) => entry.block < work.entriesFrom)
    const running = before.reduce((sum, entry) => sum + BigInt(entry.delta), 0n)
    const { entries, unseen, broken } = entriesOf(work, known, running)
    if (broken) work.final = 'liquidity'
    pending.push({ work, entries: broken ? [] : entries, unseen })
    if (!broken) newBlocks.push(...entries.map((entry) => entry.block))
  }
  const times = await headerTimes(rt, budget, origin, head, newBlocks)
  const built = new Map<string, LedgerPosition>()
  // Not answered this time (round 4): what it has kept, as far as it is worked out, `reading`; nothing kept for it.
  for (const work of works) {
    if (!work.unanswered) continue
    const through = Math.min(head, work.entriesFrom - 1)
    const entries = (work.kept?.entries ?? []).filter((entry) => entry.block <= through)
    built.set(work.key, { tokenId: work.key, ok: true, through, state: work.state, mint: work.kept?.mint ?? null, entries, exact: false, why: 'reading', ...(work.vault ? { vault: work.vault } : {}) })
  }
  for (const { work, entries, unseen } of pending) {
    const mint = work.mint ? { ...work.mint, t: work.mint.t || times.get(work.mint.block) || 0 } : null
    if (mint && mint.t === 0) throw new RelayError('fatal', 'missing_header')
    const before = (work.kept?.entries ?? []).filter((entry) => entry.block < work.entriesFrom)
    const all = work.final ? [] : [...before, ...entries.map((entry) => ({ ...entry, t: times.get(entry.block) ?? 0 }))]
    if (all.some((entry) => entry.t === 0)) throw new RelayError('fatal', 'missing_header')
    if (all.length > MAX_ENTRIES) work.final = 'too_many'
    const why = whyOf(work, mint, all, unseen, head)
    built.set(work.key, {
      tokenId: work.key,
      ok: true,
      through: work.final ? head : work.through,
      state: work.state,
      mint,
      entries: work.final ? [] : all,
      exact: why === null,
      ...(why ? { why } : {}),
      ...(work.vault ? { vault: work.vault } : {}),
    })
    // Kept whatever it came to (findings 4 and 14): a verdict for good as itself, so nothing is read for it again; any
    // other ledger with what its logs named past `through` (finding 5). A verdict already kept stays as it was.
    if (work.kept?.final || told.has(work)) continue
    const value: Kept = work.final
      ? verdict(work, work.final, mint, head)
      : {
          v: 2,
          poolId: work.state.poolId,
          through: work.through,
          scanned: head,
          mint,
          holders: work.holders,
          trusted: [...work.trusted],
          vaults: [...work.vaults],
          entries: all,
          final: null,
          pending: factsWhere({ ...work.facts, candidates: work.candidates }, (block) => block > work.through),
        }
    await keep(rt, keptUrl(origin, work.id), value, lifeOf(work.final))
  }
  const positions = state.positions.map((position): LedgerPosition => (position.ok ? (built.get(position.tokenId) as LedgerPosition) : { tokenId: position.tokenId, ok: false, reason: position.reason }))
  return { v: 1, block: head, timestamp: state.timestamp, positions }
}

/** `work`'s ledger kept as `final`, its verdict: nothing more is read for it while it is kept (lifeOf). */
function verdict(work: Work, final: Final, mint: Work['mint'], head: number): Kept {
  return { v: 2, poolId: work.state.poolId, through: head, scanned: head, mint, holders: work.holders, trusted: [...work.trusted], vaults: [...work.vaults], entries: [], final, pending: noFacts() }
}

/** Why a ledger is not exact (src/lib/fees/types.ts LedgerWhy), or null when it is. */
function whyOf(work: Work, mint: Work['mint'], entries: readonly LedgerEntry[], unseen: boolean, head: number): LedgerWhy | null {
  if (work.final) return work.final
  if (work.through < head) return 'reading'
  if (!mint) return 'before_floor'
  const unknown = entries.find((entry) => entry.fees === null)
  if (unknown) return unknown.why ?? 'manual'
  if (entries.reduce((sum, entry) => sum + BigInt(entry.delta), 0n) !== BigInt(work.state.liquidity)) return 'liquidity'
  if (unseen) return 'unseen'
  // A vault's own checkpoint of the NFT must be its state now unless something it did not make settled it since its last
  // compound: the owner's own settlement, which the ledger then holds after that compound; anything else was not seen.
  const point = work.checkpoint
  const last = entries[entries.length - 1]
  const vouched = !!point && !!last && (last.auto === true || last.kind === 'mint')
  if (vouched && point) {
    const same = point.liquidity === BigInt(work.state.liquidity) && point.last0 === BigInt(work.state.feeGrowthInside0LastX128) && point.last1 === BigInt(work.state.feeGrowthInside1LastX128)
    if (!same) return 'unseen'
  }
  // A pool in native ETH (review of the rules, finding 9): a collect that paid out only ETH leaves no log at all, so no
  // read finds its block; only a vault's checkpoint, agreeing above, vouches that nothing settled the NFT since its last
  // compound.
  if ((work.state.poolKey.currency0 === ZERO || work.state.poolKey.currency1 === ZERO) && !vouched) return 'native'
  return null
}

// ---------------------------------------------------------------------------
// POST /api/fees/v2/ledger
// ---------------------------------------------------------------------------

type AnswerKept = { text: string; complete: boolean }
type FailureKept = { outcome: 'rate_limited' | 'rpc_unavailable' | 'too_large'; seconds?: number }

/**
 * The route's answer for a checked question: a whole answer kept per set of ids LEDGER_SECONDS (a fresh question takes
 * one only within FRESH_LEDGER_MS), never one that is still `reading`; questions of the same ids at once share one read.
 * A read past its own bytes is too large (413), kept TOO_LARGE_SECONDS; a rate-limited node is a 429 and anything else
 * (the question's byte budget spent included, round 4) a 502, each kept FAILURE_SECONDS, or a minute when our own
 * time-out ended it (fees.ts failureSeconds, finding 6).
 */
export async function ledgerAnswer(request: Request, rt: FeesRuntime, asked: LedgerQuestion): Promise<Response> {
  const { origin } = new URL(request.url)
  const digest = await sha256(asked.ids.join(','))
  const key = cacheUrl(origin, `ledgerAnswer${LEDGER_KEYS}`, digest, 0)
  const failKey = cacheUrl(origin, `ledgerFail${LEDGER_KEYS}`, digest, 0)
  const hit = await kept<AnswerKept>(rt, key)
  if (hit && typeof hit.value.text === 'string' && hit.value.complete === true && hit.ageMs < (asked.fresh ? FRESH_LEDGER_MS : LEDGER_SECONDS * 1000)) return answer(hit.value.text, request)
  const recent = await kept<FailureKept>(rt, failKey)
  if (recent) {
    const { outcome, seconds } = recent.value
    const life = 1000 * (Number.isSafeInteger(seconds) && (seconds as number) > 0 ? (seconds as number) : outcome === 'too_large' ? TOO_LARGE_SECONDS : FAILURE_SECONDS)
    if (recent.ageMs < life) {
      if (outcome === 'too_large') return refusal('too_large', 413)
      if (outcome === 'rate_limited' || outcome === 'rpc_unavailable') return failure(outcome, life - recent.ageMs)
    }
  }
  const budget = newBudget(rt)
  try {
    // A fresh read never joins one that started before it (it may predate the settlement the page saw).
    const value = await shared(rt, asked.fresh ? `${key}#fresh` : key, () => readLedger(rt, budget, origin, asked.ids))
    const text = JSON.stringify(value)
    const complete = value.positions.every((position) => !position.ok || (position.through === value.block && position.why !== 'reading'))
    if (complete) await keep(rt, key, { text, complete } satisfies AnswerKept, LEDGER_SECONDS)
    return answer(text, request)
  } catch (error) {
    // The question's own budget spent (round 4) is no verdict: a short failure, as any other, and the page asks again.
    if (error instanceof RelayError && error.kind === 'bytes' && error.message !== 'budget_spent') {
      await keep(rt, failKey, { outcome: 'too_large', seconds: TOO_LARGE_SECONDS } satisfies FailureKept, TOO_LARGE_SECONDS)
      return refusal('too_large', 413)
    }
    const outcome = outcomeOf(error)
    const seconds = failureSeconds(error)
    await keep(rt, failKey, { outcome, seconds } satisfies FailureKept, seconds)
    return failure(outcome, Math.max(budget.retryAfterMs, seconds * 1000))
  }
}
