/**
 * POST /api/automation/v1/state: which of Domino's three ways each position
 * NFT is held in (the owner's three features, 2026-09-24): a plain position,
 * Auto-compound or Domino-compound, and for the two automations whether the
 * sequence is paused or active. Read from Domino's own Robinhood Chain node
 * (functions/_lib/localRpc.ts, since 2026-10-01) in at most two batched reads.
 *
 * How a sequence holds its position (contracts/src/DominoVaultV4.sol
 * _armRoot, DominoVaultReadHelper.rootCustody): the root NFT stays in the
 * owner's wallet, approved to its sequence vault, and the vault is the NFT's
 * PositionManager subscriber. So, for the ids asked:
 *
 *   1. eth_blockNumber: the head both reads are pinned to.
 *   2. One Multicall3 aggregate3: PositionManager.subscriber(id) per id. No
 *      subscriber is a plain position.
 *   3. Only when a subscriber was found, one more aggregate3, per distinct
 *      subscriber: DominoVaultFactoryV1.isVault (the factory pinned in
 *      src/finance/pin.ts SEQUENCE_FACTORY, repeated here), and the vault's
 *      rootTokenId(), policy() and rootPermissionValid(). A vault the factory
 *      made, whose root is this id, is Auto-compound (a 200 bps service fee)
 *      or Domino-compound (400): paused as its policy says, active when it is
 *      not paused and its permission over the NFT still holds. Any other
 *      subscriber is not Domino's ('other'), and nothing more is said of it.
 *
 * What this is not: a general RPC proxy. The caller chooses token ids and
 * nothing else; the endpoint, every method, contract and calldata are fixed
 * here, and the calls, bytes and time one answer may cost are capped by the
 * owned-positions transport (functions/_lib/owned.ts). Per set of ids, an
 * answer is kept ANSWER_SECONDS and a failure FAILURE_SECONDS, so asking in a
 * loop is not a loop of RPC calls. No secret is involved: every answer is
 * public chain data, and it names no wallet.
 *
 * 2026-09-25 to 2026-10-01: the public RPC answered 429 to every call from
 * Cloudflare's edge, so the page ran scanAutomation itself, in the visitor's
 * browser. Changed on purpose 2026-10-01 (RPC-SPEC D3, the owner's rule:
 * nothing is read from a public RPC): the route answers again, at the edge
 * (functions/_lib/chainRoutes.ts), and the page asks it
 * (src/lib/automationState.ts). This module stays a pure one (no storage, no
 * DOM, no build flag).
 */
import {
  ChainError,
  POSITION_MANAGER,
  aggregate,
  asAddress,
  paced,
  quantity,
  reader,
  refuse,
  resultWord,
  word,
  type AnswerCache,
  type Budget,
  type OwnedDeps,
  type SubCall,
} from './owned'
import type { AutomationAnswer, PositionAutomation } from '../../src/lib/automationState'

/** DominoVaultFactoryV1 on Robinhood Chain (docs/deployments/v1-robinhood-mainnet-2026-09-21; src/finance/pin.ts). */
export const SEQUENCE_FACTORY = '0x16bf6eaba7b31118627b277e97249720dfe1c7ff'

/** Checked against viem in tests/automation-state.test.mjs. */
export const AUTOMATION_SELECTOR = {
  subscriber: '16a24131',
  isVault: '652b9b41',
  rootTokenId: '88f13dde',
  policy: '0505c8c9',
  rootPermissionValid: 'bd0d55ad',
} as const

/** The service fee that names each automation (src/finance/sequence.ts AUTOMATION_FEE_BPS). */
const MODE_OF_FEE: Readonly<Record<string, 'compound' | 'domino'>> = { '200': 'compound', '400': 'domino' }

/** The most ids one question may name: Positions lists at most 100 (functions/_lib/walletPositions.ts MAX_POSITIONS). */
export const MAX_IDS = 100
/** Sub-calls per aggregate3 call. Changed on purpose 2026-10-02 (rugged97's rule 5: at most 50 in one multicall): 50, was 150. */
export const CALLS_PER_AGGREGATE = 50
export const ANSWER_SECONDS = 15
export const FAILURE_SECONDS = 5
const MAX_BODY_BYTES = 8192
const ID = /^[1-9]\d{0,77}$/
const U256 = (1n << 256n) - 1n
const ZERO = '0x0000000000000000000000000000000000000000'
const JSON_HEADERS = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }

/** The ids from a POST body of exactly {"tokenIds": ["1", …]}: canonical decimal NFT ids, distinct, 1 to MAX_IDS. */
export function idsFrom(body: unknown): bigint[] | null {
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).join() !== 'tokenIds') return null
  const list = (body as { tokenIds?: unknown }).tokenIds
  if (!Array.isArray(list) || list.length === 0 || list.length > MAX_IDS) return null
  const ids: bigint[] = []
  for (const text of list) {
    if (typeof text !== 'string' || !ID.test(text)) return null
    const id = BigInt(text)
    if (id > U256 || ids.includes(id)) return null
    ids.push(id)
  }
  return ids
}

async function batched(deps: OwnedDeps, budget: Budget, calls: SubCall[], block: number) {
  const out: { success: boolean; data: string }[] = []
  for (let i = 0; i < calls.length; i += CALLS_PER_AGGREGATE) out.push(...(await aggregate(deps, budget, calls.slice(i, i + CALLS_PER_AGGREGATE), block)))
  return out
}

/** A bool word, or null when the sub-call failed or answered anything but 0 or 1. */
const flag = (call: { success: boolean; data: string }): boolean | null => {
  const value = resultWord(call)
  return value === 0n ? false : value === 1n ? true : null
}

/** policy()'s service fee and paused flag (Policy is seven static words), or null. */
function policyOf(call: { success: boolean; data: string }): { feeBps: bigint; paused: boolean } | null {
  if (!call.success) return null
  try {
    const r = reader(call.data)
    if (r.bytes < 7 * 32) return null
    const feeBps = r.at(0)
    const paused = r.at(6 * 32)
    if (feeBps >> 16n !== 0n || paused > 1n) return null
    return { feeBps, paused: paused === 1n }
  } catch {
    return null
  }
}

/*
 * 2026-09-28 (speed wave B, item 17: the badges and a position's chip came 0.6 s after the rows and the header, from a
 * read of three calls of their own): the two reads below are sub-calls the page's other reads carry too, the wallet's
 * list (walletPositions.ts scanWallet) and a position's state (fees.ts readState): each id's subscriber in their first
 * aggregate, the vaults' reads in their second. scanAutomation stays for the automation page's picker and the route.
 */
/** PositionManager.subscriber(id): no subscriber is a plain position. */
export const subscriberCall = (id: bigint): SubCall => ({ target: POSITION_MANAGER, data: AUTOMATION_SELECTOR.subscriber + word(id) })
/** The subscriber a subscriberCall answered. */
export function subscriberOf(call: { success: boolean; data: string }): string {
  const value = resultWord(call)
  if (value === null) throw new ChainError('fatal', 'invalid_subscriber')
  return asAddress(value)
}
/** The subscribers that may be Domino's vaults, each once: every one but the zero address. */
export const vaultsOf = (subscribers: readonly string[]) => [...new Set(subscribers.filter((address) => address !== ZERO))]
const PER_VAULT = 4
/** Per vault: the factory's isVault, and the vault's rootTokenId(), policy() and rootPermissionValid(). */
export const vaultCalls = (vaults: readonly string[]): SubCall[] =>
  vaults.flatMap((vault) => [
    { target: SEQUENCE_FACTORY, data: AUTOMATION_SELECTOR.isVault + word(BigInt(vault)) },
    { target: vault, data: AUTOMATION_SELECTOR.rootTokenId },
    { target: vault, data: AUTOMATION_SELECTOR.policy },
    { target: vault, data: AUTOMATION_SELECTOR.rootPermissionValid },
  ])
/** Each id's automation, from its subscriber and the vaults' reads (vaultCalls of vaultsOf(subscribers)), in order. */
export function automationsOf(ids: readonly bigint[], subscribers: readonly string[], read: readonly { success: boolean; data: string }[]): PositionAutomation[] {
  const vaults = vaultsOf(subscribers)
  return ids.map((id, index): PositionAutomation => {
    const tokenId = id.toString()
    const vault = subscribers[index]
    if (vault === ZERO) return { tokenId, automation: 'plain' }
    const at = vaults.indexOf(vault) * PER_VAULT
    const [isVault, root, policy, permission] = read.slice(at, at + PER_VAULT)
    const ours = flag(isVault) === true && resultWord(root) === id
    const terms = ours ? policyOf(policy) : null
    const mode = terms ? MODE_OF_FEE[terms.feeBps.toString()] : undefined
    const valid = flag(permission)
    if (!terms || !mode || valid === null) return { tokenId, automation: 'other' }
    return { tokenId, automation: mode, paused: terms.paused, active: !terms.paused && valid, vault }
  })
}

/** Each id's automation at the head, in the order asked. Throws ChainError when the chain cannot be read fully. */
export async function scanAutomation(deps: OwnedDeps, ids: readonly bigint[]): Promise<AutomationAnswer> {
  const budget: Budget = { calls: 0, started: deps.now(), logBytes: 0 }
  const head = quantity(await paced(deps, budget, 'eth_blockNumber', []))
  const subscribers = (await batched(deps, budget, ids.map(subscriberCall), head)).map(subscriberOf)
  const vaults = vaultsOf(subscribers)
  const read = vaults.length ? await batched(deps, budget, vaultCalls(vaults), head) : []
  return { block: head, positions: automationsOf(ids, subscribers, read) }
}

/** The cache key for a set of ids: a digest, so no id list becomes part of a URL, even an internal one. */
async function cacheKey(url: URL, ids: readonly bigint[]): Promise<Request> {
  const text = `automation/v1|${[...ids].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)).join(',')}`
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))
  return new Request(`${url.origin}/api/automation/v1/cache/${Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('')}`)
}

const STORED_AT = 'X-Automation-Stored-At'
const OUTCOME = 'X-Automation-Outcome'

/** An answer kept for the same ids, in the order this question asked them. */
function reordered(text: string, ids: readonly bigint[]): string | null {
  try {
    const kept = JSON.parse(text) as AutomationAnswer
    const byId = new Map(kept.positions.map((entry) => [entry.tokenId, entry]))
    const positions = ids.map((id) => byId.get(id.toString()))
    if (positions.some((entry) => !entry)) return null
    return JSON.stringify({ block: kept.block, positions })
  } catch {
    return null
  }
}

/**
 * A POST of {"tokenIds": [...]} answered from the chain, as JSON; a chain
 * that cannot be read fully is a 502, never a partial answer. The same set of
 * ids is answered from the cache for ANSWER_SECONDS, a failure for
 * FAILURE_SECONDS.
 */
export async function answerAutomation(request: Request, deps: OwnedDeps, cache: AnswerCache | null = null, waitUntil?: (work: Promise<unknown>) => void): Promise<Response> {
  const url = new URL(request.url)
  if (request.method !== 'POST') return refuse('method_not_allowed', 405, { Allow: 'POST' })
  const origin = request.headers.get('Origin')
  const site = request.headers.get('Sec-Fetch-Site')
  if ((origin !== null && origin !== url.origin) || (site !== null && site !== 'same-origin')) return refuse('origin_not_allowed', 403)
  if (!(request.headers.get('Content-Type') ?? '').toLowerCase().startsWith('application/json')) return refuse('json_required', 415)
  if (Number(request.headers.get('Content-Length') ?? '0') > MAX_BODY_BYTES) return refuse('request_too_large', 413)
  const text = await request.text()
  if (text.length > MAX_BODY_BYTES) return refuse('request_too_large', 413)
  let body: unknown
  try {
    body = JSON.parse(text)
  } catch {
    return refuse('invalid_request', 400)
  }
  const ids = idsFrom(body)
  if (!ids) return refuse('invalid_request', 400)

  const key = cache ? await cacheKey(url, ids) : null
  if (cache && key) {
    const kept = await cache.match(key).catch(() => undefined)
    const at = Number(kept?.headers.get(STORED_AT))
    if (kept && Number.isSafeInteger(at)) {
      const age = Math.max(0, deps.now() - at)
      const outcome = kept.headers.get(OUTCOME)
      if (outcome === 'answer' && age < ANSWER_SECONDS * 1000) {
        const answer = reordered(await kept.text(), ids)
        if (answer) return new Response(answer, { status: 200, headers: JSON_HEADERS })
      } else if (outcome === 'chain_unavailable' && age < FAILURE_SECONDS * 1000) {
        return refuse('chain_unavailable', 502, { 'Retry-After': String(FAILURE_SECONDS) })
      }
    }
  }
  let answer: string | null = null
  try {
    answer = JSON.stringify(await scanAutomation(deps, ids))
  } catch {
    answer = null
  }
  if (cache && key) {
    const seconds = answer ? ANSWER_SECONDS : FAILURE_SECONDS
    const entry = new Response(answer ?? JSON.stringify({ error: 'chain_unavailable' }), {
      headers: { 'Content-Type': 'application/json', 'Cache-Control': `max-age=${seconds}`, [STORED_AT]: String(deps.now()), [OUTCOME]: answer ? 'answer' : 'chain_unavailable' },
    })
    const stored = cache.put(key, entry).catch(() => undefined)
    if (waitUntil) waitUntil(stored)
    else await stored
  }
  return answer ? new Response(answer, { status: 200, headers: JSON_HEADERS }) : refuse('chain_unavailable', 502, { 'Retry-After': String(FAILURE_SECONDS) })
}
