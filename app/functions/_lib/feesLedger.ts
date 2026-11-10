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
import { POSITION_MANAGER, SETUP_CONTRACT, SETUP_DEPLOY_BLOCK, SETUP_MINTED_TOPIC, TRANSFER_TOPIC, MULTICALL3, encodeAggregate3, decodeAggregate3 } from './owned'
import { AUTOMATION_SELECTOR, SEQUENCE_FACTORY } from './automation'
import {
  FAILURE_SECONDS,
  FINAL_SECONDS,
  DEADLINE_MS,
  HASH,
  MAX_BYTES,
  MAX_HEADERS,
  MAX_RPC_CALLS,
  POOL_MANAGER,
  RelayError,
  SAFE_DEPTH,
  SELECTOR,
  STATE_VIEW,
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
import type { LedgerEntry, LedgerPosition, LedgerResponse, LedgerWhy, StatePositionOk, StateResponse } from '../../src/lib/fees/types'

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
/** Verified Robinhood v4 deployment, docs/deployments/v2-robinhood-4663-2026-10-04/deployment.json. */
export const V2_ZAP = '0x376b92929bbe778c6dd64e8d73f8688686288e8a'
export const V2_FACTORY = '0xc71a561853514efc2271f1d10c13ec95834792ba'
export const V2_ACTION = '0xa7c6a820069d8f01991283e8f527fa1678590447c17064fd43148892d2863a92'
export const V2_STEP = '0xf6a97c0d2054864127258f1e392259b35bdb4e5360f3f78285bf30675b4b8b9a'
export const V2_VAULT_CREATED = '0x575ce09d88fdbe87124d0a71fd63b9862b8e580f59ed6d38a8fe30cf2e951c33'
export const V2_COLLECTED = '0xa54e6c2fc0861aa9c991b26891d71059d517983b9e84b91020f42609c452eb9d'
export const V2_COMPOUNDED = '0x0957afbb4f3559d58b385bc7712b4c0a8189e62797dc67866a78faaeb73eed50'
/** Earliest deployment receipt in the verified V2 profile; earlier settled entries need no reinterpretation. */
const V2_FIRST_BLOCK = 80_189_516
/** rugged97's rule 3: the lowest block any log is read from (DominoSetupV1's deploy). */
export const LEDGER_FLOOR = SETUP_DEPLOY_BLOCK

// ---------------------------------------------------------------------------
// Sizes and limits
// ---------------------------------------------------------------------------

export const MAX_LEDGER_IDS = 8
export const LEDGER_BODY_BYTES = 4_096
/** A cold NFT advances at most this many blocks per answer; the cursor survives between questions. */
export const LEDGER_SCAN_BLOCKS = 1_000_000
/** Only indexed NFT mints use this window; settlement and pool-log limits are unchanged. */
export const MINT_DISCOVERY_BLOCKS = 10_000_000
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
/** Whole answers refresh on the optional opening-price field; per-NFT accounting cursors are unchanged. */
export const LEDGER_ANSWER_VERSION = 'v3-mint-discovery-3'
/** PoolManager.Swap: used only for one verified mint block and one exact pool, never a history scan. */
export const MINT_SWAP = '0x40e9cecb9f5f1f1c5b9c97dec2917b7ee92e57ba5563708daca94dd84ad7112f'
/** A slow archive read must not hold a usable ledger for the RPC's normal ten-second timeout. */
export const MINT_PRICE_TIMEOUT_MS = 1_500
const MINT_PRICE_RECENT_SECONDS = 10
const MINT_PRICE_FAILURE_SECONDS = 30
const MINT_PRICE_BYTES = 32_768
/** The most one-block lookups one read makes; past it the ledger is kept as far as they reached, and says `reading`. */
export const LEDGER_STEP = 200
/**
 * Added on purpose 2026-11-09 (core flows, the owner: "I don't want slowness, the site is live"): one answer goes on,
 * pass after pass, while it is younger than this, where it said `reading` after one pass. A pass is what an answer was:
 * one LEDGER_SCAN_BLOCKS window for its NFTs, at most LEDGER_STEP lookups, its ledgers kept as it leaves them, so the
 * next pass (or the next answer, in this data centre) goes on from them. A position five weeks old waited for about
 * thirty answers of one window each, re-asked two seconds apart (tests/fees-ledger-speed.test.mjs). Well inside
 * DEADLINE_MS (25 s): the last pass started may still take its own few seconds.
 */
export const LEDGER_PASS_MS = 8_000
/** The calls an answer keeps past its later passes for the opening prices (mintPrices: one read and its Swap fallback). */
export const MINT_PRICE_CALLS = 2
/**
 * What a pass leaves of the answer's calls, past its windows' own rounds, for what its NFTs share after them: the vaults'
 * checkpoints, who is Domino's, the one-block lookups and the headers. The first pass keeps room for all of them (a
 * failure there fails the answer, as before); a later one only a little (a later pass that runs short ends, and the answer
 * is what the passes before it came to).
 */
const FIRST_SHARED_CALLS = 8
const LATER_SHARED_CALLS = 2
/** What the one-block lookups leave of a pass's calls for the headers of what they found. */
const HEADER_CALLS = 1
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
const OWN_ADDRESSES = [...ROUND_ONE_ADDRESSES, V2_ZAP, V2_FACTORY]
const OWN_TOPICS = [...ROUND_ONE_TOPICS, V2_ACTION, V2_STEP, V2_VAULT_CREATED]

// ---------------------------------------------------------------------------
// The question
// ---------------------------------------------------------------------------

export interface LedgerQuestion {
  /** Ascending, 1..8 distinct. */
  ids: bigint[]
  /** The page saw a settlement the ledger it has does not hold: a kept answer counts only within FRESH_LEDGER_MS. */
  fresh: boolean
  mintHints?: readonly { tokenId: string; block: number; tx: string }[]
}

/** A ledger body as its question, or null unless it is exactly {"tokenIds": [1..8 decimal ids]} and, at most, "fresh": true. */
export function ledgerRequestOf(body: Record<string, unknown>): LedgerQuestion | null {
  if ('fresh' in body && body.fresh !== true) return null
  const { fresh, mintHints, ...rest } = body
  const ids = stateIdsOf(rest)
  if (!ids || ids.length > MAX_LEDGER_IDS) return null
  if (mintHints !== undefined && (!Array.isArray(mintHints) || mintHints.length > ids.length || mintHints.some((hint) => {
    if (!hint || typeof hint !== 'object' || Object.keys(hint).sort().join(',') !== 'block,tokenId,tx') return true
    const h = hint as { tokenId?: unknown; block?: unknown; tx?: unknown }
    return typeof h.tokenId !== 'string' || !ids.some((id) => id.toString() === h.tokenId) || !Number.isSafeInteger(h.block) || (h.block as number) < LEDGER_FLOOR || typeof h.tx !== 'string' || !HASH.test(h.tx)
  }) || new Set(mintHints.map((hint) => hint.tokenId)).size !== mintHints.length)) return null
  return { ids, fresh: fresh === true, ...(mintHints === undefined ? {} : { mintHints: mintHints as LedgerQuestion['mintHints'] }) }
}

/** Hints partition in-flight/failure answers too: a failed cold scan must not mask a newly supplied mint proof. */
export const ledgerHintKey = (asked: LedgerQuestion): string => (asked.mintHints ?? []).map((hint) => `${hint.tokenId}:${hint.block}:${hint.tx}`).sort().join('|')

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
  /** A V2 zap collect: token-specific net outputs at zero liquidity delta, never an add/withdrawal's principal. */
  collected?: Array<{ block: number; tx: string; amounts: [string, string] }>
  /** V2 destination liquidity from Compounded, used to attest the add, never as newly earned income. */
  v2Increased?: Array<{ block: number; tx: string; delta: string }>
}

const noFacts = (): Facts => ({ candidates: [], realized: [], service: [], paidIn: [], paidOut: [], collected: [], v2Increased: [] })

/** `facts` of the blocks `keepIt` keeps. */
function factsWhere(facts: Facts, keepIt: (block: number) => boolean): Facts {
  return {
    candidates: facts.candidates.filter(keepIt),
    realized: facts.realized.filter((fact) => keepIt(fact.block)),
    service: facts.service.filter((fact) => keepIt(fact.block)),
    paidIn: facts.paidIn.filter((fact) => keepIt(fact.block)),
    paidOut: facts.paidOut.filter((fact) => keepIt(fact.block)),
    collected: (facts.collected ?? []).filter((fact) => keepIt(fact.block)),
    v2Increased: (facts.v2Increased ?? []).filter((fact) => keepIt(fact.block)),
  }
}

/** A verdict no later read changes: nothing is read for the NFT again while it is kept (`too_many` only an hour, round 4). */
type Final = 'too_many' | 'unseen' | 'liquidity'
const FINALS: readonly string[] = ['too_many', 'unseen', 'liquidity']

/** An NFT's ledger as kept between reads. */
interface Kept {
  v: 2 | 3
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
  v2Vaults?: string[]
  /** Own-event discovery has not yet proved every holder; no transfers of unknown addresses were followed. */
  trustPending?: boolean
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
    && (facts.collected === undefined || (Array.isArray(facts.collected) && facts.collected.every((fact) => isFact(fact, (one) => isPair(one.amounts)))))
    && (facts.v2Increased === undefined || (Array.isArray(facts.v2Increased) && facts.v2Increased.every((fact) => isFact(fact, (one) => isText(one.delta)))))
  )
}

const isKept = (value: unknown, poolId: string): value is Kept => {
  const kept = value as Kept | null
  return (
    !!kept &&
    (kept.v === 2 || kept.v === 3) &&
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
    (kept.v2Vaults === undefined || (Array.isArray(kept.v2Vaults) && kept.v2Vaults.every(isText))) &&
    (kept.trustPending === undefined || typeof kept.trustPending === 'boolean') &&
    Array.isArray(kept.entries) &&
    (kept.final === null || FINALS.includes(kept.final)) &&
    isFacts(kept.pending) &&
    (kept.mint === null || (typeof kept.mint === 'object' && isBlock(kept.mint.block) && isText(kept.mint.tx) && isBlock(kept.mint.t)))
  )
}

/** Different hint questions can finish out of order. Serialize this isolate's writes and retain the furthest verified
 * cursor, so a late cold read cannot erase the mint and complete ledger a hinted read already saved. Cache remains a
 * best-effort optimization across isolates; every returned answer is independently validated at its own head. */
const writes = new WeakMap<NonNullable<FeesRuntime['cache']>, Map<string, Promise<void>>>()
async function keepLedger(rt: FeesRuntime, url: string, value: Kept, seconds: number): Promise<void> {
  if (!rt.cache) return
  let queue = writes.get(rt.cache)
  if (!queue) { queue = new Map(); writes.set(rt.cache, queue) }
  const previous = queue.get(url) ?? Promise.resolve()
  const task = previous.catch(() => undefined).then(async () => {
    const newer = await kept<unknown>(rt, url)
    if (newer && isKept(newer.value, value.poolId) && newer.value.v === 3 && newer.value.scanned >= value.scanned && newer.value.through > value.through && !(newer.value.final === 'too_many' && newer.ageMs >= TOO_MANY_SECONDS * 1000)) return
    await keep({ ...rt, waitUntil: undefined }, url, value, seconds)
  })
  queue.set(url, task)
  try { await task } finally { if (queue.get(url) === task) queue.delete(url) }
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
  v2Vaults: Set<string>
  trustPending: boolean
  /** Once later own events establish trust, restart the bounded settlements pass from the actual mint. */
  restart: boolean
  /** The SetupMinted log this read found for it: who Domino minted it for, and in which transaction. */
  minted: { owner: string; tx: string } | null
  /** The kept facts in [entriesFrom, logsFrom), then what this read's logs named. */
  facts: Facts
  /** The blocks to look into, ascending. */
  candidates: number[]
  through: number
  /** This question's bounded log cursor, separate from settlements waiting for a one-block lookup. */
  scanned: number
  final: Final | null
  /**
   * Not answered this time (round 4, 2026-10-02): the question's byte budget did not hold its read. Never a verdict and
   * never kept: it is answered `reading` with what it has kept, and the page asks again.
   */
  unanswered: boolean
  /**
   * (2026-10-15, pack 8; study-charts.md fix 5): its mint discovery has covered the floor to the head and found no mint, so
   * it was minted before the floor: answered `before_floor` at once, with no ledger scan from the floor (about twenty
   * answers of LEDGER_SCAN_BLOCKS each, which could only come to the same answer). Never a verdict: nothing is kept final
   * for it, so its kept ledger and Activity stay as a finished scan leaves them (no mint, no entries).
   */
  beforeFloor: boolean
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

/**
 * Block timestamps: kept per block once final, else one batched eth_getBlockByNumber per MAX_HEADERS. `read`
 * (2026-11-09): what this answer's earlier passes read, at the same head, whatever its depth.
 */
async function headerTimes(rt: FeesRuntime, budget: Budget, origin: string, head: number, blocks: readonly number[], read: Map<number, number>): Promise<Map<number, number>> {
  const known = new Map<number, number>()
  const missing: number[] = []
  for (const block of new Set(blocks)) {
    const seen = read.get(block)
    if (seen !== undefined) {
      known.set(block, seen)
      continue
    }
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
      read.set(part[id], t)
      if (part[id] <= head - SAFE_DEPTH) await keep(rt, headerUrl(origin, part[id]), { t }, FINAL_SECONDS)
    }
  }
  return known
}

/**
 * Optional chart anchor: fixed getSlot0 calls at the NFT's verified mint block, never an inferred execution price.
 * Every unique pool/block is read once; different blocks share one bounded JSON-RPC POST. A pruned historical state can
 * fall back to the last actual Swap of that exact pool in that verified mint block: the same end-of-block price.
 * Both reads share one short optional deadline. No Swap in the block means no anchor, never an inferred price.
 * Recent blocks are read again, including once after finality, rather than promoting a provisional price forever.
 */
async function mintPrices(rt: FeesRuntime, budget: Budget, origin: string, head: number, positions: LedgerPosition[]): Promise<void> {
  type Priced = Extract<LedgerPosition, { ok: true }> & { mint: NonNullable<Extract<LedgerPosition, { ok: true }>['mint']> }
  type PriceKept = { sqrtPriceX96: string | null; finalized: boolean }
  type Need = { poolId: string; block: number; key: string; positions: Priced[]; finalized: boolean }
  const valid = (price: unknown): price is string => typeof price === 'string' && /^[1-9]\d{0,48}$/.test(price) && BigInt(price) < 1n << 160n
  const metrics = { eligible: 0, hit: 0, cooldown: 0, requested: 0, read: 0, rpc: 0, subcall: 0, invalid: 0, words3: 0, fields: 0, unavailable: 0, deadline: 0, budget: 0, swapRequested: 0, swapRead: 0, swapEmpty: 0, swapInvalid: 0 }
  let rpcCode: number | undefined
  let rpcClass: 'historical_unavailable' | 'reverted' | 'other' | 'mixed' | undefined
  const rpcFailed = (error: { code?: unknown; message?: unknown }, count: number) => {
    metrics.rpc += count
    if (Number.isSafeInteger(error.code)) rpcCode = error.code as number
    const message = typeof error.message === 'string' ? error.message.slice(0, 2048) : ''
    const classified = /missing trie|historical state|state (?:is )?(?:not available|unavailable)|pruned|no state available|metadata is not found/i.test(message) ? 'historical_unavailable' : /revert/i.test(message) ? 'reverted' : 'other'
    rpcClass = rpcClass && rpcClass !== classified ? 'mixed' : classified
  }
  const report = () => {
    // No addresses, ids, amounts, provider text or response bodies enter this optional diagnostic.
    try { rt.onDiagnostic?.({ event: 'ledger_mint_price', ...metrics, ...(rpcCode !== undefined ? { rpcCode } : {}), ...(rpcClass ? { rpcClass } : {}) }) } catch { /* Logging cannot change a ledger answer. */ }
  }
  const needed = new Map<string, Need>()
  for (const position of positions) {
    if (!position.ok || !position.mint || position.mint.block > head || position.mint.block < LEDGER_FLOOR) continue
    metrics.eligible++
    // Never reuse a value carried by an older per-NFT cache without checking the pool/block anchor's own finality.
    delete position.mint.sqrtPriceX96
    const { block } = position.mint
    const key = cacheUrl(origin, 'mintPrice1', position.state.poolId, block)
    const duplicate = needed.get(key)
    if (duplicate) { duplicate.positions.push(position as Priced); continue }
    const finalized = block <= head - SAFE_DEPTH
    const saved = await kept<PriceKept>(rt, key)
    if (saved && saved.value && typeof saved.value.finalized === 'boolean') {
      if (saved.value.sqrtPriceX96 === null && saved.ageMs < MINT_PRICE_FAILURE_SECONDS * 1000) { metrics.cooldown++; continue }
      if (valid(saved.value.sqrtPriceX96) && (saved.value.finalized && finalized || !saved.value.finalized && !finalized && saved.ageMs < MINT_PRICE_RECENT_SECONDS * 1000)) {
        position.mint.sqrtPriceX96 = saved.value.sqrtPriceX96
        metrics.hit++
        continue
      }
    }
    needed.set(key, { poolId: position.state.poolId, block, key, positions: [position as Priced], finalized })
  }
  if (!needed.size) { report(); return }
  metrics.requested = needed.size
  const remaining = DEADLINE_MS - (rt.deps.now() - budget.started)
  if (remaining <= 0 || MAX_BYTES - budget.bytes < MINT_PRICE_BYTES) { metrics.budget = needed.size; report(); return }
  const groups = new Map<number, Need[]>()
  for (const need of needed.values()) groups.set(need.block, [...(groups.get(need.block) ?? []), need])
  const plans = [...groups.entries()]
  const payload = plans.map(([block, reads], id) => ({ jsonrpc: '2.0', id, method: 'eth_call', params: [{ to: MULTICALL3, data: encodeAggregate3(reads.map((read) => ({ target: STATE_VIEW, data: SELECTOR.getSlot0 + read.poolId.slice(2) }))) }, hex(block)] }))
  const controller = new AbortController()
  // This optional deadline is caller cancellation, not evidence that the node itself is down. localRpc distinguishes
  // AbortError from TimeoutError, so an unavailable chart anchor does not rest unrelated balance/state reads.
  const timer = setTimeout(() => controller.abort(new DOMException('Optional mint price read ended', 'AbortError')), Math.min(MINT_PRICE_TIMEOUT_MS, remaining))
  const optional: FeesRuntime = { ...rt, deps: { ...rt.deps, fetch: (url, init) => rt.deps.fetch(url, { ...init, signal: controller.signal }) } }
  const obtained = new Map<string, string>()
  const fallback = new Set<Need>()
  try {
    // Deliberately no paced retry for this optional enrichment.
    const response = await post(optional, budget, payload, false, MINT_PRICE_BYTES)
    if (!Array.isArray(response) || response.length !== plans.length) { metrics.invalid = needed.size; return }
    const ids = response.map((envelope) => envelope?.id)
    if (ids.some((id) => !Number.isInteger(id) || id < 0 || id >= plans.length) || new Set(ids).size !== ids.length) { metrics.invalid = needed.size; return }
    for (const envelope of response) {
      const reads = plans[envelope.id][1]
      if (envelope.error) {
        rpcFailed(envelope.error, reads.length)
        for (const read of reads) fallback.add(read)
        continue
      }
      try {
        const result = resultOf(envelope)
        if (typeof result !== 'string') { metrics.invalid += reads.length; continue }
        const values = decodeAggregate3(result)
        if (values.length !== reads.length) { metrics.invalid += reads.length; continue }
        values.forEach((value, index) => {
          if (!value.success) { metrics.subcall++; fallback.add(reads[index]); return }
          if (!/^[0-9a-f]{256}$/i.test(value.data)) { metrics.invalid++; if (/^[0-9a-f]{192}$/i.test(value.data)) metrics.words3++; return }
          const data = `0x${value.data}`
          const price = wordAt(data, 0).toString()
          const tick = BigInt.asIntN(256, wordAt(data, 1))
          if (!valid(price) || tick < -(1n << 23n) || tick >= 1n << 23n || wordAt(data, 2) >> 24n !== 0n || wordAt(data, 3) >> 24n !== 0n) { metrics.fields++; return }
          obtained.set(reads[index].key, price)
          metrics.read++
        })
      } catch { metrics.invalid += reads.length /* A bad block does not discard another block's successful anchor. */ }
    }
    if (fallback.size && !controller.signal.aborted && rt.deps.now() - budget.started < DEADLINE_MS && MAX_BYTES - budget.bytes >= MINT_PRICE_BYTES) {
      const reads = [...fallback]
      metrics.swapRequested = reads.length
      // Only the mint's verified block, fixed PoolManager, scalar Swap topic and one scalar pool id. The transport
      // independently enforces that shape; no wildcard, address list, event list or second block is admitted.
      const response = await post(optional, budget, reads.map((read, id) => ({ jsonrpc: '2.0', id, method: 'eth_getLogs', params: [{ address: POOL_MANAGER, fromBlock: hex(read.block), toBlock: hex(read.block), topics: [MINT_SWAP, read.poolId] }] })), true, MINT_PRICE_BYTES)
      if (!Array.isArray(response) || response.length !== reads.length || response.some((envelope) => !Number.isInteger(envelope?.id) || envelope.id < 0 || envelope.id >= reads.length) || new Set(response.map((envelope) => envelope.id)).size !== reads.length) { metrics.swapInvalid = reads.length; return }
      for (const envelope of response) {
        const read = reads[envelope.id]
        if (envelope.error) { rpcFailed(envelope.error, 1); continue }
        try {
          const logs = resultOf(envelope)
          if (!Array.isArray(logs)) throw new Error('invalid')
          let last: { index: number; transaction: number; price: string } | null = null
          let blockHash: string | null = null
          const seen = new Set<number>()
          const transactions = new Map<string, number>()
          const ordered: Array<{ index: number; transaction: number; price: string; tx: string }> = []
          for (const raw of logs) {
            const log = logOf(raw, [POOL_MANAGER], read.block, read.block)
            if (!log || raw.removed !== false || log.topics.length !== 3 || log.topics[0] !== MINT_SWAP || log.topics[1] !== read.poolId || !ADDRESS_WORD.test(log.topics[2]) || wordsIn(log.data) !== 6 || seen.has(log.index)) throw new Error('invalid')
            const hash = typeof raw.blockHash === 'string' ? raw.blockHash.toLowerCase() : ''
            if (!HASH.test(hash) || blockHash && blockHash !== hash) throw new Error('invalid')
            blockHash = hash
            seen.add(log.index)
            const transaction = quantity(raw.transactionIndex)
            if (transactions.has(log.tx) && transactions.get(log.tx) !== transaction) throw new Error('invalid')
            transactions.set(log.tx, transaction)
            const price = wordAt(log.data, 2).toString()
            const tick = BigInt.asIntN(256, wordAt(log.data, 4))
            const signed128 = (value: bigint) => BigInt.asIntN(128, value) === BigInt.asIntN(256, value)
            if (!signed128(wordAt(log.data, 0)) || !signed128(wordAt(log.data, 1)) || !valid(price) || wordAt(log.data, 3) >> 128n !== 0n || tick < -887272n || tick > 887272n || wordAt(log.data, 5) > 1_000_000n) throw new Error('invalid')
            ordered.push({ index: log.index, transaction, price, tx: log.tx })
          }
          ordered.sort((a, b) => a.index - b.index)
          let tx: string | null = null
          for (const log of ordered) {
            if (last && (log.transaction < last.transaction || log.transaction === last.transaction && log.tx !== tx || log.transaction > last.transaction && log.tx === tx)) throw new Error('invalid')
            last = log
            tx = log.tx
          }
          if (last) { obtained.set(read.key, last.price); metrics.swapRead++ }
          else metrics.swapEmpty++
        } catch { metrics.swapInvalid++ }
      }
    }
  } catch { if (controller.signal.aborted) metrics.deadline = needed.size; else metrics.unavailable = needed.size }
  finally {
    clearTimeout(timer)
    report()
    for (const need of needed.values()) {
      const sqrtPriceX96 = obtained.get(need.key) ?? null
      if (sqrtPriceX96) for (const position of need.positions) position.mint.sqrtPriceX96 = sqrtPriceX96
      const newer = await kept<PriceKept>(rt, need.key)
      // Another NFT/request can have established this shared anchor while our optional read was in flight. A late
      // failure must not erase it; an older head must not downgrade a finalized anchor to a provisional cache entry.
      if (newer?.value && valid(newer.value.sqrtPriceX96) && (newer.value.finalized && (sqrtPriceX96 === null || !need.finalized) || sqrtPriceX96 === null && newer.ageMs < MINT_PRICE_RECENT_SECONDS * 1000)) continue
      await keep(rt, need.key, { sqrtPriceX96, finalized: need.finalized } satisfies PriceKept, sqrtPriceX96 === null ? MINT_PRICE_FAILURE_SECONDS : need.finalized ? FINAL_SECONDS : MINT_PRICE_RECENT_SECONDS)
    }
  }
}

/**
 * The PositionManager's ModifyLiquidity logs of each of `missing` (one-block lookups, none kept yet), kept a year once
 * final. The question's byte budget spent (round 4): the blocks looked into so far, the NFTs then going as far as those
 * (`reading`), as past LEDGER_STEP.
 */
async function lookups(rt: FeesRuntime, budget: Budget, origin: string, head: number, missing: readonly number[]): Promise<Map<number, Modify[]>> {
  const out = new Map<number, Modify[]>()
  for (let at = 0; at < missing.length; at += 50) {
    // Changed on purpose 2026-11-09 (core flows): the answer's calls short of the headers of what was found, as its byte
    // budget spent: the blocks looked into so far, the NFTs going as far as those (`reading`). It failed the answer.
    if (Math.min(budget.cap ?? MAX_RPC_CALLS, MAX_RPC_CALLS) - budget.calls <= HEADER_CALLS) break
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
    (list) => roundRead(rt, budget, [{ address: OWN_ADDRESSES, fromBlock: hex(from(list)), toBlock: hex(head), topics: [OWN_TOPICS, null, null, one(list.map((work) => work.word))] }]),
    (list, results) => {
      const byWord = new Map(list.map((work) => [work.word, work]))
      const logs = (results[0] as unknown[]).map((raw) => logOf(raw, OWN_ADDRESSES, from(list), head)).filter((log): log is Log => log !== null)
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
        } else if (log.address === V2_ZAP && log.topics[0] === V2_ACTION) {
          if (wordsIn(log.data) !== 3 || !ADDRESS_WORD.test(log.topics[2])) throw new RelayError('fatal', 'invalid_v2_action')
          const action = BigInt(log.topics[1])
          if (action < 1n || action > 4n || wordAt(log.data, 1) >> 128n !== 0n) throw new RelayError('fatal', 'invalid_v2_action')
          if (action === 1n || action === 3n) work.minted = { owner: addressOf(log.topics[2]), tx: log.tx }
          work.facts.candidates.push(log.block)
        } else if (log.address === V2_ZAP && log.topics[0] === V2_STEP) {
          if (wordsIn(log.data) !== 9 || !ADDRESS_WORD.test(log.topics[2])) throw new RelayError('fatal', 'invalid_v2_step')
          const key = work.state.poolKey
          if (wordAt(log.data, 0) !== 4n || wordAt(log.data, 1) !== BigInt(key.currency0) || wordAt(log.data, 2) !== BigInt(key.currency1) || wordAt(log.data, 3) !== BigInt(key.fee) || BigInt.asIntN(256, wordAt(log.data, 4)) !== BigInt(key.tickSpacing) || wordAt(log.data, 5) !== BigInt(key.hooks)) throw new RelayError('fatal', 'invalid_v2_pool')
          work.facts.candidates.push(log.block)
          const delta = BigInt.asIntN(256, wordAt(log.data, 6))
          const a0 = BigInt.asIntN(256, wordAt(log.data, 7)), a1 = BigInt.asIntN(256, wordAt(log.data, 8))
          if (delta === 0n && a0 >= 0n && a1 >= 0n) (work.facts.collected ??= []).push({ block: log.block, tx: log.tx, amounts: [a0.toString(), a1.toString()] })
        } else if (log.address === V2_FACTORY && log.topics[0] === V2_VAULT_CREATED) {
          if (wordsIn(log.data) !== 2 || wordAt(log.data, 0) !== 4n || !ADDRESS_WORD.test(log.topics[1]) || !ADDRESS_WORD.test(log.topics[2])) throw new RelayError('fatal', 'invalid_v2_vault')
          work.trusted.add(addressOf(log.topics[1]))
          work.trusted.add(addressOf(log.topics[2]))
          work.v2Vaults.add(addressOf(log.topics[2]))
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
  const madeV2 = new Set<string>()
  for (const part of chunks(unknown.filter((address) => !made.has(address)), 50)) {
    const results = await aggregate(rt, budget, part.map((address) => ({ target: V2_FACTORY, data: AUTOMATION_SELECTOR.isVault + addressWord(address) })), head)
    results.forEach((result, i) => {
      const data = result.data.startsWith('0x') ? result.data.slice(2) : result.data
      if (result.success && data.length === 64 && BigInt(`0x${data}`) === 1n) madeV2.add(part[i])
    })
  }
  for (const work of works) {
    for (const address of touching(work)) {
      if (!made.has(address) && !madeV2.has(address)) continue
      work.trusted.add(address)
      if (madeV2.has(address)) work.v2Vaults.add(address)
      else work.vaults.add(address)
    }
  }
  const left = works.filter((work) => work.holders.some((holder) => !work.trusted.has(holder)) && work.vaults.size + work.v2Vaults.size > 0)
  const vaults = unique(left.flatMap((work) => [...work.vaults, ...work.v2Vaults]))
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
    for (const holder of work.holders) if ([...work.vaults, ...work.v2Vaults].some((vault) => owners.get(vault) === holder)) work.trusted.add(holder)
  }
  for (const work of works) {
    if (touching(work).some((address) => !work.trusted.has(address))) {
      if (work.scanned >= head) work.final = 'unseen'
      else work.trustPending = true
    } else if (work.trustPending && work.mint) {
      work.trustPending = false
      work.restart = true
      work.scanned = work.mint.block - 1
      work.facts = noFacts()
    }
    if ((work.trustPending || work.restart) && work.mint) {
      work.through = work.mint.block - 1
      work.entriesFrom = work.mint.block
    }
  }
}

/** Where an NFT's followed addresses' transfers are read from this time: its logs' start, never before its mint. */
const startOf = (work: Work) => Math.max(work.logsFrom, work.mint?.block ?? LEDGER_FLOOR)
const tokensOf = (work: Work) => [work.state.poolKey.currency0, work.state.poolKey.currency1].filter((address) => address !== ZERO)

/** Only factory-proven V2 vaults, only this NFT. FeesCollected is newly settled income;
 * Compounded.fees0/1 is consumed capital and MUST NOT be counted as newly earned fees. */
async function v2Collections(rt: FeesRuntime, budget: Budget, works: Work[], head: number): Promise<void> {
  type Ask = { work: Work; addresses: string[]; from: number }
  const asked = new Map<Work[], Ask[]>()
  await together(works.filter((work) => work.v2Vaults.size > 0), async (list) => {
    const asks = list.flatMap((work) => chunks([...work.v2Vaults], 8).map((addresses) => ({ work, addresses, from: startOf(work) })))
    asked.set(list, asks)
    return roundRead(rt, budget, asks.map(({ work, addresses, from }) => ({ address: one(addresses), fromBlock: hex(from), toBlock: hex(head), topics: [[V2_COLLECTED, V2_COMPOUNDED], work.word] })))
  }, (list, results) => {
    for (const [i, { work, addresses, from }] of (asked.get(list) ?? []).entries()) {
      for (const raw of results[i] as unknown[]) {
        const log = logOf(raw, addresses, from, head)
        if (!log) continue
        if (log.topics.length !== 2 || log.topics[1] !== work.word) throw new RelayError('fatal', 'invalid_v2_collection')
        work.facts.candidates.push(log.block)
        if (log.topics[0] === V2_COLLECTED && wordsIn(log.data) === 2) {
          work.facts.realized.push({ block: log.block, tx: log.tx, vault: log.address, amounts: [wordAt(log.data, 0).toString(), wordAt(log.data, 1).toString()] })
        } else if (log.topics[0] === V2_COMPOUNDED && wordsIn(log.data) === 6) {
          if (wordAt(log.data, 0) >> 128n !== 0n || wordAt(log.data, 5) >> 64n !== 0n) { throw new RelayError('fatal', 'invalid_v2_collection') }
          // The service amounts aggregate every source budget; attributing them to the destination would be false.
          (work.facts.v2Increased ??= []).push({ block: log.block, tx: log.tx, delta: wordAt(log.data, 0).toString() })
        } else throw new RelayError('fatal', 'invalid_v2_collection')
      }
    }
  })
}

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
    const fresh = list.flatMap((work) => work.facts.realized.filter((fact) => fact.block >= work.logsFrom && !work.v2Vaults.has(fact.vault)))
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
  const collected = sums(facts.collected ?? [])
  const ambiguous = new Set<string>()
  for (const tx of unique([...collected.keys(), ...facts.realized.filter((fact) => work.v2Vaults.has(fact.vault)).map((fact) => fact.tx)])) {
    const modifications = own.filter((modify) => modify.tx === tx)
    const ownCollected = facts.realized.filter((fact) => fact.tx === tx && work.v2Vaults.has(fact.vault))
    const count = ownCollected.length || (facts.collected ?? []).filter((fact) => fact.tx === tx).length
    const added = (facts.v2Increased ?? []).filter((fact) => fact.tx === tx).reduce((sum, fact) => sum + BigInt(fact.delta), 0n)
    if (modifications.filter((modify) => BigInt(modify.delta) === 0n).length !== count || modifications.some((modify) => BigInt(modify.delta) < 0n) || modifications.reduce((sum, modify) => sum + BigInt(modify.delta), 0n) !== added) ambiguous.add(tx)
  }
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
    else if (ambiguous.has(modify.tx)) entries.push({ ...base, fees: null, why: 'shared' })
    else if (auto) {
      const paid = first ? service.get(modify.tx) : undefined
      entries.push({ ...base, fees: first ? [auto[0].toString(), auto[1].toString()] : ['0', '0'], auto: true, ...(paid ? { service: [paid[0].toString(), paid[1].toString()] as [string, string] } : {}) })
    } else if (delta !== 0n) entries.push({ ...base, fees: null, why: 'manual' })
    else if (collected.has(modify.tx)) entries.push({ ...base, fees: first ? collected.get(modify.tx)!.map(String) as [string, string] : ['0', '0'] })
    else if (native) entries.push({ ...base, fees: null, why: 'native' })
    else if (others.has(modify.tx) || paidOut.has(modify.tx) || !first) entries.push({ ...base, fees: null, why: 'shared' })
    else {
      const paid = paidIn.get(modify.tx)
      if (!paid) entries.push({ ...base, fees: null, why: 'unseen' })
      else entries.push({ ...base, fees: [paid[0].toString(), paid[1].toString()] })
    }
  }
  // A compound the engine names whose own ModifyLiquidity was not found: something this read did not see.
  const unseen = [...realized.keys(), ...collected.keys()].some((tx) => !own.some((modify) => modify.tx === tx))
  return { entries, unseen, broken: false }
}

/**
 * What one answer's passes hand on (2026-11-09, core flows): each NFT's ledger and mint discovery as the last pass kept
 * them (the edge cache may not hold them yet, or at all), which mint hints the node proved, and what stays the same for
 * the whole answer at its one head: the vaults' checkpoints, the one-block lookups and the headers.
 */
interface Passes {
  ledgers: Map<string, Kept>
  discovery: Map<string, MintDiscovery>
  proofs: Map<string, boolean>
  checkpoints: Map<string, Work['checkpoint']>
  blocks: Map<number, Modify[]>
  times: Map<number, number>
}

/**
 * What one pass came to: each NFT's position, the NFTs it answered (the others as their kept ledgers left them), and how
 * many windows the earliest NFT still being read is from the head.
 */
interface PassResult {
  built: Map<string, LedgerPosition>
  answered: Set<string>
  behind: number
}

/** Where the passes stand, each NFT's kept cursors and verdict and its discovery's: the same after a pass that read nothing new. */
const progressOf = (passes: Passes) =>
  JSON.stringify([
    [...passes.ledgers].map(([id, one]) => [id, one.through, one.scanned, one.final, one.trustPending === true, one.mint?.block ?? null]),
    [...passes.discovery].map(([id, one]) => [id, one.next, one.anchor?.block ?? null]),
  ])

/**
 * Room for one more pass (2026-11-09): the answer younger than LEDGER_PASS_MS, its calls short of the opening prices'
 * holding a window's two rounds and a later pass's share, and its byte budget a round's read (roundRead).
 */
const roomForPass = (rt: FeesRuntime, budget: Budget) =>
  rt.deps.now() - budget.started < LEDGER_PASS_MS &&
  !rt.deps.cancelled?.() &&
  MAX_RPC_CALLS - MINT_PRICE_CALLS - budget.calls >= 2 + LATER_SHARED_CALLS &&
  MAX_BYTES - budget.bytes >= ROUND_BYTES + LEDGER_TAIL_BYTES

/**
 * The windows one pass reads (2026-11-09, core flows): the earliest, which reads on from the oldest cursor and takes in
 * each later NFT once it reaches that NFT's cursor (one read for all of them from then on), and the window nearest the
 * head when the calls the answer has left past `shared` hold both all the way to the head, so its NFTs are answered by
 * this answer instead of after the earliest reaches them. The windows between wait, not answered by this pass
 * (`reading`, nothing kept for them, as a spent byte budget leaves an NFT). Each window side by side, as before, cost two
 * reads per window per pass and never took one in: eight positions minted on eight days cost sixteen reads a window, and
 * the answer's calls ran out.
 */
function chooseGroups<G extends { works: Work[]; to: number }>(groups: G[], budget: Budget, shared: number, head: number): G[] {
  if (groups.length <= 1) return groups
  const cost = (group: G) => 2 + (group.works.some((work) => work.v2Vaults.size > 0) ? 1 : 0)
  const [first, last] = [groups[0], groups[groups.length - 1]]
  const room = Math.min(budget.cap ?? MAX_RPC_CALLS, MAX_RPC_CALLS) - budget.calls - shared
  const windows = Math.ceil((head + 1 - Math.min(...last.works.map((work) => work.logsFrom))) / LEDGER_SCAN_BLOCKS)
  return windows * (cost(first) + cost(last)) <= room ? [first, last] : [first]
}

/**
 * The ledger of each of `ids` at the node's head (LedgerResponse). `origin`: the edge cache's prefix.
 *
 * Changed on purpose 2026-11-09 (core flows, the owner: "I don't want slowness, the site is live"): passes, where it was
 * one. The positions are read once, at one head; then each pass is what an answer was (ledgerPass: a LEDGER_SCAN_BLOCKS
 * window, at most LEDGER_STEP lookups, its ledgers kept as it leaves them), going on from where the one before it kept
 * them, while a ledger is still `reading`, the last pass moved something, and the answer has room (roomForPass:
 * LEDGER_PASS_MS, its calls, its bytes). A position five weeks old was about thirty answers of one window each, re-asked
 * two seconds apart; it is three now, a position ten days old one (tests/fees-ledger-speed.test.mjs). Every limit of a
 * node call is as it was (narrow windows, one-block PoolManager lookups, the byte caps, one call at a time). The first
 * pass fails the answer as the one pass did; a later pass that fails (its calls, the deadline, the node) ends the answer
 * with what the passes before it came to, each kept already. The opening prices are read once, after the last pass, with
 * calls the later passes leave them (MINT_PRICE_CALLS).
 */
export async function readLedger(rt: FeesRuntime, budget: Budget, origin: string, ids: readonly bigint[], hints: LedgerQuestion['mintHints'] = []): Promise<LedgerResponse> {
  const state = await readState(rt, budget, ids, true)
  const head = state.block
  const passes: Passes = { ledgers: new Map(), discovery: new Map(), proofs: new Map(), checkpoints: new Map(), blocks: new Map(), times: new Map() }
  const answered = new Map<string, LedgerPosition>()
  for (let pass = 0; ; pass++) {
    const before = progressOf(passes)
    let done: PassResult
    if (pass > 0) budget.cap = MAX_RPC_CALLS - MINT_PRICE_CALLS
    try {
      done = await ledgerPass(rt, budget, origin, state, hints, passes, pass === 0 ? FIRST_SHARED_CALLS : LATER_SHARED_CALLS)
    } catch (error) {
      if (pass === 0) throw error
      break
    } finally {
      delete budget.cap
    }
    // An NFT a pass did not reach keeps what an earlier pass answered for it.
    const reading = (id: string) => { const one = answered.get(id); return !one || (one.ok && one.why === 'reading') }
    const waiting = [...done.built.keys()].filter(reading)
    for (const [id, position] of done.built) if (done.answered.has(id) || !answered.has(id)) answered.set(id, position)
    if (![...answered.keys()].some(reading)) break
    // A pass that finished an NFT's ledger ends the answer when the others still `reading` cannot be read through in what
    // is left of it: its rate is shown now, not once the others' passes are done (they are asked again together,
    // lib/fees/store.ts). When they can, the answer goes on and brings them all.
    if (waiting.some((id) => !reading(id)) && 2 * done.behind > MAX_RPC_CALLS - MINT_PRICE_CALLS - LATER_SHARED_CALLS - budget.calls) break
    if (progressOf(passes) === before || !roomForPass(rt, budget)) break
  }
  const positions = state.positions.map((position): LedgerPosition => (position.ok ? (answered.get(position.tokenId) as LedgerPosition) : { tokenId: position.tokenId, ok: false, reason: position.reason }))
  await mintPrices(rt, budget, origin, head, positions)
  return { v: 1, block: head, timestamp: state.timestamp, positions }
}

/**
 * One pass of an answer over `state`'s positions (until 2026-11-09 the whole of readLedger): each NFT's ledger read on
 * from where it was kept (this answer's earlier pass's, else the edge cache's), one window, and kept again. `shared`: the
 * calls it leaves past its windows' rounds (chooseGroups).
 */
async function ledgerPass(rt: FeesRuntime, budget: Budget, origin: string, state: StateResponse, hints: LedgerQuestion['mintHints'], passes: Passes, shared: number): Promise<PassResult> {
  const head = state.block
  const vaults = new Map((state.automation ?? []).filter((one): one is typeof one & { vault: string } => 'vault' in one && typeof one.vault === 'string').map((one) => [one.tokenId, one.vault]))
  const works: Work[] = []
  /** A ledger kept for the next pass and in the edge cache for the next answer. */
  const keepWork = async (work: Work, value: Kept) => {
    passes.ledgers.set(work.key, value)
    await keepLedger(rt, keptUrl(origin, work.id), value, lifeOf(value.final))
  }
  const ok = state.positions.filter((one): one is StatePositionOk => one.ok)
  const keptById = new Map(
    await Promise.all(
      ok.map(async (one) => {
        const passed = passes.ledgers.get(one.tokenId)
        return [one.tokenId, passed ? { value: passed as unknown, ageMs: 0 } : await kept<unknown>(rt, keptUrl(origin, BigInt(one.tokenId)))] as const
      }),
    ),
  )
  const cold = ok.filter((one) => {
    if (hints?.some((hint) => hint.tokenId === one.tokenId && hint.block <= head)) return false
    const hit = keptById.get(one.tokenId)
    if (hit && isKept(hit.value, one.poolId) && hit.value.final && !(hit.value.final === 'too_many' && hit.ageMs >= TOO_MANY_SECONDS * 1000)) return false
    return !hit || !isKept(hit.value, one.poolId) || !hit.value.mint
  }).map((one) => BigInt(one.tokenId))
  const { found: discovered, beforeFloor } = await discoverMintStarts(rt, budget, origin, head, cold, passes.discovery)
  const plans = ok.map((position) => {
    const hit = keptById.get(position.tokenId)
    let was = hit && isKept(hit.value, position.poolId) ? hit.value : null
    // A `too_many` verdict is checked again once its hour is over (round 4): read anew, as a first read.
    if (hit && was?.final === 'too_many' && hit.ageMs >= TOO_MANY_SECONDS * 1000) was = null
    // A node behind the blocks kept (a restart, a catch-up; finding 8): read on from where it stands, the kept ledger kept.
    // One rolled back past the mint itself is read anew.
    if (was?.mint && was.mint.block > head) was = null
    // v2 records predate V2 event support. Preserve old V1 history, but rebuild discarded verdicts from their proven
    // mint, and only reinterpret the V2-era suffix of a surviving ledger. Merely clearing `final` would lose its entries.
    if (was?.v === 2 && was.final !== 'too_many' && (was.final === 'unseen' || was.final === 'liquidity' || was.scanned >= V2_FIRST_BLOCK)) {
      const restart = was.final ? was.mint?.block ?? LEDGER_FLOOR : Math.max(was.mint?.block ?? LEDGER_FLOOR, V2_FIRST_BLOCK)
      was = { ...was, v: 3, through: restart - 1, scanned: restart - 1, entries: was.final ? [] : was.entries.filter((entry) => entry.block < restart), holders: was.final ? [] : was.holders, trusted: was.final ? [] : was.trusted, vaults: was.final ? [] : was.vaults, v2Vaults: [], pending: noFacts(), final: null }
    }
    const hint = hints?.find((item) => item.tokenId === position.tokenId && item.block <= head)
    return { position, was, hint }
  })
  // An indexed mint only saves a history scan after the node proves this exact NFT's zero-address Transfer. A caller
  // cannot assert its owner, timestamp or fees, or shorten the history with an arbitrary transaction/block hint.
  // Changed on purpose 2026-11-09 (core flows): the hints of a question proved in one POST of one-block reads (it was one
  // POST each, eight of the answer's calls for a list's eight rows), and once an answer.
  const unproved = plans.filter((plan): plan is typeof plan & { hint: NonNullable<typeof plan.hint> } => !plan.was?.mint && !!plan.hint && !passes.proofs.has(plan.position.tokenId))
  if (unproved.length > 0) {
    const results = await logsBatch(rt, budget, unproved.map(({ position, hint }) => ({ address: POSITION_MANAGER, fromBlock: hex(hint.block), toBlock: hex(hint.block), topics: [TRANSFER_TOPIC, word(0n), null, word(BigInt(position.tokenId))] })), ROUND_BYTES)
    unproved.forEach(({ position, hint }, i) => {
      const id = BigInt(position.tokenId)
      const matches = (results[i] as unknown[]).map((raw) => logOf(raw, [POSITION_MANAGER], hint.block, hint.block)).filter((log): log is Log => log !== null && log.tx === hint.tx && log.topics.length === 4 && log.topics[0] === TRANSFER_TOPIC && log.topics[1] === word(0n) && ADDRESS_WORD.test(log.topics[2]) && log.topics[3] === word(id) && log.data === '0x')
      passes.proofs.set(position.tokenId, matches.length === 1)
    })
  }
  for (const { position, was, hint } of plans) {
    const id = BigInt(position.tokenId)
    let provenStart: number | null = discovered.get(position.tokenId)?.block ?? null
    if (!was?.mint && hint && passes.proofs.get(position.tokenId) === true) provenStart = hint.block
    const through = was ? Math.min(was.through, head) : 0
    const scanned = was ? Math.min(was.scanned, head) : 0
    // (2026-10-15, pack 8): discovery covered the floor to the head with no mint, and nothing proves one: before the floor.
    const floorProven = beforeFloor.has(position.tokenId) && !was?.mint && provenStart === null && !was?.final
    const start = was?.mint?.block ?? LEDGER_FLOOR
    // The logs from the last SAFE_DEPTH blocks they were read through (a reorganised tail is read again); the settlements
    // from the first block not worked out, the kept facts filling in between.
    const logsFrom = provenStart ?? (was ? Math.max(start, scanned + 1 - SAFE_DEPTH, LEDGER_FLOOR) : LEDGER_FLOOR)
    const entriesFrom = provenStart ?? (was ? Math.max(start, Math.min(through + 1, logsFrom), LEDGER_FLOOR) : LEDGER_FLOOR)
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
      v2Vaults: new Set(was?.v2Vaults ?? []),
      trustPending: was?.trustPending === true,
      restart: false,
      minted: null,
      facts: was ? factsWhere(was.pending, (block) => block >= entriesFrom && block < logsFrom) : noFacts(),
      candidates: [],
      through: head,
      scanned: head,
      final: was?.final ?? null,
      unanswered: discovered.has(position.tokenId) && discovered.get(position.tokenId) === null,
      beforeFloor: floorProven,
    })
  }
  const live = () => works.filter((work) => !work.final && !work.unanswered && !work.beforeFloor)
  // Group nearby cursors, instead of forcing a newly proven mint to wait for another NFT's old discovery scan.
  const groups: Array<{ works: Work[]; to: number }> = []
  for (const work of live().sort((a, b) => a.logsFrom - b.logsFrom)) {
    let group = groups.at(-1)
    if (!group || work.logsFrom > group.to) {
      group = { works: [], to: Math.min(head, work.logsFrom + LEDGER_SCAN_BLOCKS - 1) }
      groups.push(group)
    }
    group.works.push(work)
    work.through = group.to
    work.scanned = group.to
  }
  const chosen = chooseGroups(groups, budget, shared, head)
  for (const group of groups) if (!chosen.includes(group)) for (const work of group.works) work.unanswered = true
  // The vaults' checkpoints at the head: read once an answer (2026-11-09).
  await checkpointsAt(rt, budget, live().filter((work) => !passes.checkpoints.has(work.key)), head)
  for (const work of live()) {
    if (passes.checkpoints.has(work.key)) work.checkpoint = passes.checkpoints.get(work.key) ?? null
    else if (work.vault) passes.checkpoints.set(work.key, work.checkpoint)
  }
  for (const group of chosen) await roundOne(rt, budget, group.works.filter((work) => !work.final && !work.unanswered), group.to)
  for (const work of live()) if (work.holders.length > MAX_HOLDERS) work.final = 'too_many'
  await trust(rt, budget, live().filter((work) => work.mint), head)
  for (const group of chosen) {
    const settled = () => group.works.filter((work) => !work.final && !work.unanswered && !work.trustPending && !work.restart && work.mint)
    await v2Collections(rt, budget, settled(), group.to)
    await roundTwo(rt, budget, settled(), group.to)
  }
  // A verdict is kept at once (finding 14): a later failure of this question does not make the next one read it again.
  // `too_many` for an hour only (round 4), the others KEPT_SECONDS.
  const told = new Set<Work>()
  for (const work of works) {
    if (!work.final || work.kept?.final) continue
    await keepWork(work, verdict(work, work.final, work.mint, head))
    told.add(work)
  }

  // The blocks to look into: the mint's, the burns', the compounds' and the payments'.
  for (const work of works) {
    if (!work.mint || work.final || work.unanswered || work.trustPending || work.restart) continue
    const blocks = new Set<number>(work.facts.candidates)
    if (work.mint.block >= work.entriesFrom) blocks.add(work.mint.block)
    for (const fact of [...work.facts.realized, ...work.facts.paidIn, ...work.facts.paidOut]) blocks.add(fact.block)
    work.candidates = [...blocks].filter((block) => block >= work.entriesFrom && block <= head).sort((a, b) => a - b)
  }
  // At most LEDGER_STEP lookups of blocks not kept, oldest first across the NFTs; an NFT whose next block is past them
  // goes as far as the block before it. Changed on purpose 2026-11-09 (core flows): only the blocks of NFTs whose logs are
  // read to the head now. An NFT still reading its windows keeps its blocks to look into with its ledger (`pending`, as
  // past LEDGER_STEP), and the pass that reads its last window looks into them all, LEDGER_STEP at a time: a window is its
  // two rounds alone, where its lookups and their headers made it four calls.
  const all = [...new Set(works.filter((work) => work.scanned >= head).flatMap((work) => work.candidates))].sort((a, b) => a - b)
  const known = new Map<number, Modify[]>()
  const fresh: number[] = []
  for (const block of all) {
    // (2026-11-09) A block this answer's earlier pass looked into, final or not: the same head.
    const passed = passes.blocks.get(block)
    if (passed) {
      known.set(block, passed)
      continue
    }
    const hit = block <= head - SAFE_DEPTH ? await kept<Modify[]>(rt, blockUrl(origin, block)) : null
    if (hit && Array.isArray(hit.value)) known.set(block, hit.value)
    else fresh.push(block)
  }
  for (const [block, modifies] of await lookups(rt, budget, origin, head, fresh.slice(0, LEDGER_STEP))) {
    known.set(block, modifies)
    passes.blocks.set(block, modifies)
  }
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
  const times = await headerTimes(rt, budget, origin, head, newBlocks, passes.times)
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
          v: 3,
          poolId: work.state.poolId,
          through: work.through,
          scanned: work.scanned,
          mint,
          holders: work.holders,
          trusted: [...work.trusted],
          vaults: [...work.vaults],
          v2Vaults: [...work.v2Vaults],
          trustPending: work.trustPending,
          entries: all,
          final: null,
          pending: factsWhere({ ...work.facts, candidates: work.candidates }, (block) => block > work.through),
        }
    await keepWork(work, value)
  }
  const cursors = works.filter((work) => !work.final && !work.beforeFloor && (work.unanswered || work.scanned < head)).map((work) => (work.unanswered ? work.logsFrom : work.scanned + 1 - SAFE_DEPTH))
  const behind = cursors.length > 0 ? Math.ceil((head + 1 - Math.min(...cursors)) / LEDGER_SCAN_BLOCKS) : 0
  return { built, answered: new Set(works.filter((work) => !work.unanswered).map((work) => work.key)), behind }
}

type MintAnchor = { block: number; tx: string; hash: string; index: number }
type MintDiscovery = { head: number; next: number; anchor?: MintAnchor }

/** Discover only the indexed zero-address Transfer of these NFTs. No pool history, owner-wide transfer scan or
 * archive eth_call. Empty windows advance a bounded cursor; they never mean the position earned zero or is closed.
 * (2026-10-15, pack 8): `beforeFloor`, the ids whose discovery has now covered the floor to the head (this read's windows
 * and its re-read tail, or the kept cursor) and found no mint. */
async function discoverMintStarts(rt: FeesRuntime, budget: Budget, origin: string, head: number, ids: readonly bigint[], passed: Map<string, MintDiscovery>): Promise<{ found: Map<string, MintAnchor | null>; beforeFloor: Set<string> }> {
  const found = new Map<string, MintAnchor | null>()
  const beforeFloor = new Set<string>()
  const groups = new Map<number, { id: bigint; prior: MintDiscovery | null }[]>()
  for (const id of ids) {
    const key = cacheUrl(origin, 'mintDiscovery1', String(id), 0)
    // (2026-11-09) What this answer's earlier pass kept first: the cache may not hold it yet, or at all (tests).
    const saved = (passed.get(String(id)) ?? (await kept<unknown>(rt, key))?.value) as Partial<MintDiscovery> | undefined
    const valid = saved && Number.isSafeInteger(saved.head) && saved.head! <= head && Number.isSafeInteger(saved.next) && saved.next! >= LEDGER_FLOOR - 1 && saved.next! <= saved.head!
    const prior = valid ? saved as MintDiscovery : null
    const a = prior?.anchor
    if (a && Number.isSafeInteger(a.block) && a.block >= LEDGER_FLOOR && a.block <= head - SAFE_DEPTH && HASH.test(a.tx) && HASH.test(a.hash) && Number.isSafeInteger(a.index) && a.index >= 0) {
      found.set(String(id), a)
      continue
    }
    // Re-read the reorganisable tail before using an older empty-window cursor.
    const end = prior?.anchor ? head : prior?.next ?? head
    const group = groups.get(end) ?? []
    group.push({ id, prior })
    groups.set(end, group)
  }
  for (const [end, group] of groups) {
    const from = Math.max(LEDGER_FLOOR, end - MINT_DISCOVERY_BLOCKS + 1)
    const priorHead = Math.min(...group.map((one) => one.prior?.head ?? head))
    const ranges = end >= from ? [{ from, to: end }] : []
    if (priorHead < head && end < head) ranges.push({ from: Math.max(LEDGER_FLOOR, priorHead - SAFE_DEPTH), to: head })
    const topics = group.map((one) => word(one.id))
    let results: unknown[]
    try {
      results = ranges.length ? await roundRead(rt, budget, ranges.map((range) => ({ address: POSITION_MANAGER, fromBlock: hex(range.from), toBlock: hex(range.to), topics: [TRANSFER_TOPIC, word(0n), null, one(topics)] }))) : []
    } catch (error) {
      if (!(error instanceof RelayError) || error.kind !== 'bytes') throw error
      // A spent question or oversized discovery is not evidence of zero fees, closure or nonexistence.
      for (const { id } of group) found.set(String(id), null)
      continue
    }
    const anchors = new Map<string, MintAnchor>()
    for (let i = 0; i < ranges.length; i++) for (const raw of results[i] as unknown[]) {
      const log = logOf(raw, [POSITION_MANAGER], ranges[i].from, ranges[i].to)
      if (!log) continue
      if (log.topics.length !== 4 || log.topics[0] !== TRANSFER_TOPIC || log.topics[1] !== word(0n) || !ADDRESS_WORD.test(log.topics[2]) || !topics.includes(log.topics[3]) || log.data !== '0x') throw new RelayError('fatal', 'invalid_mint_log')
      const hash = (raw as { blockHash?: unknown }).blockHash
      if (typeof hash !== 'string' || !HASH.test(hash)) throw new RelayError('fatal', 'invalid_mint_hash')
      const id = BigInt(log.topics[3]).toString()
      const a = { block: log.block, tx: log.tx, hash: hash.toLowerCase(), index: log.index }
      const old = anchors.get(id)
      if (old && (old.block !== a.block || old.tx !== a.tx || old.hash !== a.hash || old.index !== a.index)) throw new RelayError('fatal', 'two_mints')
      anchors.set(id, a)
    }
    for (const { id } of group) {
      const anchor = anchors.get(String(id))
      const cursor: MintDiscovery = { head, next: from - 1, ...(anchor ? { anchor } : {}) }
      passed.set(String(id), cursor)
      await keep(rt, cacheUrl(origin, 'mintDiscovery1', String(id), 0), cursor, KEPT_SECONDS)
      if (anchor) found.set(String(id), anchor)
      else if (from > LEDGER_FLOOR) found.set(String(id), null)
      // Exhausted the indexed range without a mint: minted before the floor (2026-10-15, pack 8: answered at once, where
      // the ledger used to scan from the floor in LEDGER_SCAN_BLOCKS steps to come to the same answer).
      else beforeFloor.add(String(id))
    }
  }
  return { found, beforeFloor }
}

/** `work`'s ledger kept as `final`, its verdict: nothing more is read for it while it is kept (lifeOf). */
function verdict(work: Work, final: Final, mint: Work['mint'], head: number): Kept {
  return { v: 3, poolId: work.state.poolId, through: head, scanned: head, mint, holders: work.holders, trusted: [...work.trusted], vaults: [...work.vaults], v2Vaults: [...work.v2Vaults], entries: [], final, pending: noFacts() }
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
  const digest = await sha256(`${asked.ids.join(',')}|${LEDGER_ANSWER_VERSION}|${ledgerHintKey(asked)}`)
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
    const value = await shared(rt, asked.fresh ? `${key}#fresh` : key, () => readLedger(rt, budget, origin, asked.ids, asked.mintHints))
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
