import { keccak256, stringToHex, type Hex } from 'viem'

/** Only an opaque account digest, claim and public transaction hash survive a reload.
 * No quote, address, amount, credential or calldata is persisted. Unknown outcomes
 * are quarantined across tabs; clearing a pending browser record is never recovery.
 *
 * Since 2026-10-01 (fix round 1) the swap's nonce, public chain data, is kept beside the hash under a key of its own
 * (a record of the release before reads as it did): a swap the wallet replaced ("Speed up" or "Cancel") never gets a
 * receipt for its own hash, and only its nonce, passed on chain, tells a replacement from a swap still pending, after
 * a reload too.
 *
 * Since fix round 3 (2026-10-01) what tells a replacement apart later is kept beside the nonce too (RouteEvidence):
 * a block height and digests, never an address, amount or calldata.
 *
 * Since fix round 3.1 (2026-10-01) the nonce and that evidence are kept with the claim itself, before the wallet is
 * asked: a swap offered to the wallet whose hash never came back (a signer slower than the signing window, a reload
 * while the wallet shows it, an answer that is not a hash) used to hold every later Create position of that wallet in
 * that browser for good. Its nonce now tells what became of it (components/create/CreatePosition.tsx).
 *
 * Since fix round 3.2 (2026-10-02):
 * - the router call's deadline, a time on the chain's clock, is kept with the evidence: after it the reviewed call can
 *   never go through, which bounds how long a swap nothing could tell apart holds anything;
 * - a record kept for another pool's deposit is never let go from a press elsewhere: it is moved aside (`park`), still
 *   guarding the deposit of its own pool, and the one slot (one routed swap offered at a time) is free again. It used to
 *   be let go, and that pool's one-token deposit could then be offered a second swap and fee;
 * - a swap the person says they rejected in their wallet, its hash never back, holds up a new Uniswap route until its
 *   deadline (`hold`): the wallet may still show it, and until then it could still go through;
 * - a hash that comes back after the claim was let go (another tab took the person's word meanwhile) is written back:
 *   the swap was sent, and its record guards its deposit again. */
interface StoragePort { getItem(key: string): string | null; setItem(key: string, value: string): void; removeItem(key: string): void }
interface LockPort { request<T>(key: string, run: () => Promise<T>): Promise<T> }
/**
 * What a routed swap leaves behind to tell a replacement apart on a later press or after a reload (fix round 3):
 * - `sentAfter`: a block height before the swap was sent. The transaction at its nonce is in a later block, so the search
 *   for it never asks for state further back than this (a node keeps old state only so far: about 2,000 blocks on the
 *   chain's RPC, none on publicnode);
 * - `swap`: keccak256 of the reviewed router calldata. Only that call, included, is the swap (another router call at
 *   the nonce is never taken for it);
 * - `permit`: a digest of the Permit2 allowance (owner, input token, router) as it stood right before the swap was sent,
 *   null for an ETH input. Read again at the newest block, where the swap's nonce is seen passed, unchanged, it shows
 *   the swap has not taken its input (finance/routedReplacement.ts);
 * - `spent` (fix round 3.1): a digest of the allowance the reviewed swap leaves once it has taken its input (the amount
 *   less the swap's input, the same expiry and nonce), null for an ETH input. Fix round 3.2: read so, the swap most likely
 *   went through, but a revoke (Permit2's lockdown) leaves the same allowance: a sign, never proof;
 * - `pool` (fix round 3.1): a digest of the owner and the pool the swap was for. The record guards only that pool's
 *   deposit against a second swap; in another pool it never says what to do with that pool's tokens;
 * - `deadline` (fix round 3.2): the reviewed router call's deadline, in seconds on the chain's clock. Once a block's time
 *   is past it, the call can never go through (Uniswap's router refuses it).
 * Records of the rounds before read with the parts they did not keep null.
 */
export interface RouteEvidence { sentAfter: bigint | null; swap: Hex | null; permit: Hex | null; spent: Hex | null; pool: Hex | null; deadline: bigint | null }
export interface RouteRecord { claim: string; hash: Hex | null; batchOperation: Hex | null; nonce?: bigint | null; evidence?: RouteEvidence | null }
const PREFIX = 'domino.routed-offer.v1.'
/**
 * The routed swap's nonce, beside its record (fix round 1): `<claim>|<decimal nonce>`, bound to the record's claim.
 * Fix round 3: `<claim>|<decimal nonce>|<decimal sentAfter or empty>|<swap digest or empty>|<permit digest or empty>`.
 * Fix round 3.1: two more digests, `|<spent digest or empty>|<pool digest or empty>`, and written with the claim.
 * Fix round 3.2: one more part, `|<decimal deadline or empty>`.
 */
const NONCE_PREFIX = 'domino.routed-offer-nonce.v1.'
/**
 * Fix round 3.2: records moved aside for the deposit of their own pool, each
 * `<claim>|<hash or empty>|<decimal nonce>|<sentAfter>|<swap>|<permit>|<spent>|<pool digest>|<deadline>`, joined by `;`.
 */
const PARKED_PREFIX = 'domino.routed-parked.v1.'
/** Fix round 3.2: until when (seconds, the chain's clock) a new Uniswap route waits, after the person's word on a swap whose hash never came back. */
const HOLD_PREFIX = 'domino.routed-hold.v1.'
/** The records moved aside at most: past it, a record stays where it is (it holds up the Uniswap route a while longer). */
const MAX_PARKED = 8
const DECIMAL = '(0|[1-9][0-9]{0,19})'
const DIGEST = '(0x[0-9a-f]{64})'
const NONCE_VALUE = new RegExp(`^([0-9a-f-]{36})\\|${DECIMAL}(?:\\|${DECIMAL}?\\|${DIGEST}?\\|${DIGEST}?(?:\\|${DIGEST}?\\|${DIGEST}?(?:\\|${DECIMAL}?)?)?)?$`)
const PARKED_VALUE = new RegExp(`^([0-9a-f-]{36})\\|(0x[0-9a-f]{64})?\\|${DECIMAL}\\|${DECIMAL}?\\|${DIGEST}?\\|${DIGEST}?\\|${DIGEST}?\\|${DIGEST}\\|${DECIMAL}?$`)
const keyOf = (owner: string) => {
  if (!/^0x[0-9a-f]{40}$/.test(owner)) throw new Error('route_coordination_unavailable')
  return PREFIX + keccak256(stringToHex(`4663|${owner}`)).slice(2)
}
const nonceKeyOf = (owner: string) => NONCE_PREFIX + keyOf(owner).slice(PREFIX.length)
const parkedKeyOf = (owner: string) => PARKED_PREFIX + keyOf(owner).slice(PREFIX.length)
const holdKeyOf = (owner: string) => HOLD_PREFIX + keyOf(owner).slice(PREFIX.length)
const digestOrNull = (value: Hex | null | undefined) => (typeof value === 'string' && /^0x[0-9a-f]{64}$/.test(value) ? value : null)
const decimalOrEmpty = (value: bigint | null | undefined) => (typeof value === 'bigint' && value >= 0n && value < 2n ** 64n ? String(value) : '')
/** The evidence parts of an entry, in order: sentAfter, the four digests, the deadline. */
const evidenceParts = (evidence: RouteEvidence) => [decimalOrEmpty(evidence.sentAfter),
  ...[evidence.swap, evidence.permit, evidence.spent, evidence.pool].map(value => digestOrNull(value) ?? ''), decimalOrEmpty(evidence.deadline)]
const evidenceOf = (parts: (string | undefined)[]): RouteEvidence => ({
  sentAfter: parts[0] ? BigInt(parts[0]) : null, swap: (parts[1] || null) as Hex | null, permit: (parts[2] || null) as Hex | null,
  spent: (parts[3] || null) as Hex | null, pool: (parts[4] || null) as Hex | null, deadline: parts[5] ? BigInt(parts[5]) : null,
})
/** The entry kept beside a claim: its nonce, and what tells a replacement apart when it was read. Null: nothing to keep. */
function nonceEntry(claim: string, nonce: bigint | null | undefined, evidence: RouteEvidence | null | undefined): string | null {
  if (nonce === undefined || nonce === null || nonce < 0n || nonce >= 2n ** 64n) return null
  if (!evidence) return `${claim}|${nonce}`
  return [claim, String(nonce), ...evidenceParts(evidence)].join('|')
}
export function createRouteJournal(storage: StoragePort, locks: LockPort, random: () => string) {
  function read(owner: string): RouteRecord | null {
    const value = storage.getItem(keyOf(owner))
    if (value === null) return null
    if (!/^[0-9a-f-]{36}\|((b:)?0x[0-9a-f]{64})?$/.test(value)) throw new Error('route_coordination_unavailable')
    const batch = value.slice(37).startsWith('b:')
    const claim = value.slice(0, 36)
    const hash = value.length > 37 && !batch ? value.slice(37) as Hex : null
    // The nonce counts only for this very claim, and never beside a batch; anything else reads as none. Fix round 3.1:
    // beside a claim with no hash too (kept with the claim, before the wallet is asked).
    const kept = batch ? null : NONCE_VALUE.exec(storage.getItem(nonceKeyOf(owner)) ?? '')
    const mine = kept !== null && kept[1] === claim
    // What tells a replacement apart (fix round 3), from the same entry; a record of the release before has none.
    const parts = mine ? kept[0].split('|').length : 0
    const evidence = mine && parts >= 5 ? evidenceOf(kept.slice(3)) : null
    return { claim, hash, batchOperation: batch ? value.slice(39) as Hex : null, nonce: mine ? BigInt(kept[2]) : null, evidence }
  }
  /** The records moved aside (fix round 3.2), as kept. Anything not one of them: refused, as a broken record is. */
  function parkedEntries(owner: string): string[] {
    const value = storage.getItem(parkedKeyOf(owner))
    if (value === null || value === '') return []
    const entries = value.split(';')
    if (entries.length > MAX_PARKED || entries.some(entry => !PARKED_VALUE.test(entry))) throw new Error('route_coordination_unavailable')
    return entries
  }
  function parkedRecord(entry: string): RouteRecord {
    const parts = PARKED_VALUE.exec(entry)!
    return { claim: parts[1], hash: (parts[2] ?? null) as Hex | null, batchOperation: null, nonce: BigInt(parts[3]), evidence: evidenceOf(parts.slice(4)) }
  }
  function writeParked(owner: string, entries: string[]) {
    if (entries.length) storage.setItem(parkedKeyOf(owner), entries.join(';'))
    else storage.removeItem(parkedKeyOf(owner))
  }
  function heldUntil(owner: string): bigint | null {
    const value = storage.getItem(holdKeyOf(owner))
    if (value === null) return null
    if (!new RegExp(`^${DECIMAL}$`).test(value)) throw new Error('route_coordination_unavailable')
    return BigInt(value)
  }
  return {
    read,
    /**
     * `nonce`, `evidence` (fix round 3.1): the nonce the swap about to be offered goes out with (checked free on chain
     * just before) and what tells a replacement apart, kept with the claim before the wallet is asked, where storage
     * allows (the claim never fails for it). A batch's claim keeps neither.
     */
    claim: (owner: string, nonce?: bigint, evidence?: RouteEvidence | null) => locks.request(keyOf(owner), async () => {
      if (read(owner)) throw new Error('route_already_offered')
      const claim = random()
      if (!/^[0-9a-f-]{36}$/.test(claim)) throw new Error('route_coordination_unavailable')
      storage.setItem(keyOf(owner), `${claim}|`)
      if (read(owner)?.claim !== claim) throw new Error('route_coordination_unavailable')
      const entry = nonceEntry(claim, nonce, evidence)
      if (entry !== null) try { storage.setItem(nonceKeyOf(owner), entry) } catch { /* its outcome is then unknown, as before */ }
      return claim
    }),
    /**
     * `nonce`: the nonce the swap was sent with, kept beside it where storage allows (the record never fails for it), with
     * what tells a replacement apart (`evidence`, fix round 3). Left out, what the claim kept stays.
     *
     * Fix round 3.2: a claim let go meanwhile (another tab took the person's word that the swap was rejected, or moved it
     * aside) is written back with its hash: the swap was sent, so its record guards its deposit again. Another claim in
     * the slot: refused, as before.
     */
    record: (owner: string, claim: string, hash: Hex, nonce?: bigint, evidence?: RouteEvidence | null) => locks.request(keyOf(owner), async () => {
      if (!/^0x[0-9a-f]{64}$/.test(hash)) throw new Error('route_coordination_unavailable')
      const current = read(owner)
      if (current === null) {
        // Written back: what the claim kept, moved aside or not, unless given anew.
        const entries = parkedEntries(owner), aside = entries.find(entry => entry.startsWith(`${claim}|`))
        const before = aside ? parkedRecord(aside) : null
        storage.setItem(keyOf(owner), `${claim}|`)
        const entry = nonceEntry(claim, nonce ?? before?.nonce, evidence ?? before?.evidence)
        if (entry !== null) try { storage.setItem(nonceKeyOf(owner), entry) } catch { /* a replacement then reads as pending, as before */ }
        if (aside) writeParked(owner, entries.filter(value => value !== aside))
      } else if (current.claim !== claim || current.batchOperation) throw new Error('route_coordination_unavailable')
      else {
        const entry = nonceEntry(claim, nonce, evidence)
        if (entry !== null) try { storage.setItem(nonceKeyOf(owner), entry) } catch { /* a replacement then reads as pending, as before */ }
      }
      storage.setItem(keyOf(owner), `${claim}|${hash}`)
      if (read(owner)?.hash !== hash) throw new Error('route_coordination_unavailable')
    }),
    recordBatch: (owner: string, claim: string, operationId: Hex) => locks.request(keyOf(owner), async () => {
      if (!/^0x[0-9a-f]{64}$/.test(operationId) || read(owner)?.claim !== claim) throw new Error('route_coordination_unavailable')
      storage.setItem(keyOf(owner), `${claim}|b:${operationId}`)
      if (read(owner)?.batchOperation !== operationId) throw new Error('route_coordination_unavailable')
    }),
    // Only an explicit wallet rejection, canonical revert, completed mint, a swap the wallet replaced (its nonce passed
    // on chain with no transaction under its hash: it can never be mined) whose replacement did not swap, or the person's
    // own word that a replaced swap the chain could not tell apart did not go through (fix round 3), permits this. Fix
    // round 3.1: also the person's word that they rejected a swap whose hash never came back, while its nonce is still
    // free on chain with nothing pending. Fix round 3.2: a record moved aside with this claim goes too (a swap known to
    // have gone through for another pool's deposit is no longer let go here: it is moved aside, `park`).
    release: (owner: string, claim: string) => locks.request(keyOf(owner), async () => {
      if (read(owner)?.claim === claim) {
        storage.removeItem(keyOf(owner))
        storage.removeItem(nonceKeyOf(owner))
      }
      const entries = parkedEntries(owner), left = entries.filter(entry => !entry.startsWith(`${claim}|`))
      if (left.length !== entries.length) writeParked(owner, left)
    }),
    /** Fix round 3.2: the record moved aside for the deposit of `pool` (a pool digest, routedReplacement.ts poolDigest), or null. */
    parked: (owner: string, pool: Hex): RouteRecord | null => {
      const entry = parkedEntries(owner).find(value => value.split('|')[7] === pool)
      return entry ? parkedRecord(entry) : null
    },
    /**
     * Fix round 3.2: the record in the slot, for another pool's deposit, moved aside: it goes on guarding that pool's
     * deposit (`parked`), and the slot is free for a routed swap here. Only a record with a hash or a nonce, its pool kept,
     * none moved aside for that pool yet, and room left; false (and nothing moved) otherwise.
     */
    park: (owner: string, claim: string) => locks.request(keyOf(owner), async () => {
      const current = read(owner)
      if (!current || current.claim !== claim || current.batchOperation || current.nonce === null || current.nonce === undefined || !current.evidence?.pool) return false
      const entries = parkedEntries(owner), pool = current.evidence.pool
      if (entries.length >= MAX_PARKED || entries.some(entry => entry.split('|')[7] === pool)) return false
      const entry = [claim, current.hash ?? '', String(current.nonce), ...evidenceParts(current.evidence)].join('|')
      if (!PARKED_VALUE.test(entry)) return false
      try { writeParked(owner, [...entries, entry]) } catch { return false }
      if (!parkedEntries(owner).includes(entry)) return false
      storage.removeItem(keyOf(owner))
      storage.removeItem(nonceKeyOf(owner))
      return true
    }),
    /** Fix round 3.2: a new Uniswap route waits until `until` (seconds, the chain's clock); a later time already kept stays. */
    hold: (owner: string, until: bigint) => locks.request(keyOf(owner), async () => {
      if (until < 0n || until >= 2n ** 64n) throw new Error('route_coordination_unavailable')
      const kept = heldUntil(owner)
      if (kept === null || kept < until) storage.setItem(holdKeyOf(owner), String(until))
      if ((heldUntil(owner) ?? -1n) < until) throw new Error('route_coordination_unavailable')
    }),
    heldUntil,
    /** Fix round 3.2: the hold let go, once its time has passed on the chain's clock (only the one read, never a later one). */
    releaseHold: (owner: string, until: bigint) => locks.request(keyOf(owner), async () => {
      if (heldUntil(owner) === until) storage.removeItem(holdKeyOf(owner))
    }),
  }
}
export function routeJournal() {
  if (typeof window === 'undefined' || !navigator.locks) throw new Error('route_coordination_unavailable')
  return createRouteJournal(window.localStorage, navigator.locks, () => crypto.randomUUID())
}
