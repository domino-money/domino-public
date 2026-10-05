import { keccak256, stringToHex } from 'viem'

interface StoragePort { readonly length: number; key(index: number): string | null; getItem(key: string): string | null; setItem(key: string, value: string): void; removeItem(key: string): void }
/**
 * Web Locks, as the journal uses them: `request` makes a claim atomic across tabs. Since 2026-10-01 (audit C2) a page
 * also holds a lock of its own for each offer it made (`hold`, let go by `letGo` or when the page goes away), so another
 * page, or this one after a reload, can tell an offer whose page is still open (`held`) from one whose page is gone.
 */
interface LockPort {
  request<T>(name: string, callback: () => Promise<T>): Promise<T>
  hold?(name: string): void
  letGo?(name: string): void
  held?(name: string): Promise<boolean>
}
const prefix = 'domino.offered-nonce.v1.'
/** When a nonce's latch was claimed, in unix seconds, beside it under a prefix of its own (settle; 2026-10-01). */
const atPrefix = 'domino.offered-nonce-at.v1.'
const batchPrefix = 'domino.offered-batch.v1.'
/** When a batch's latch was claimed, in unix seconds, beside it under a prefix of its own (expireBatch). */
const batchAtPrefix = 'domino.offered-batch-at.v1.'
/** The lock a page holds while its offer may still be open in the wallet: the latch's own hash, under its own prefix. */
const livePrefix = 'domino.offered-live.v1.'
/**
 * The chain a journal keeps latches for. Changed on purpose 2026-10-02 (Domino V2, spec F7 §1.3: the nonce journal's and
 * the batch latch's keys include the action's chain): the chain is the first field of the hashed input, as it always was
 * for Robinhood Chain, so a journal for 4663 (every V1 caller, the default) writes the very same keys as before, and the
 * same account's nonce 7 on Base is another latch than its nonce 7 on Robinhood Chain.
 */
const ROBINHOOD = 4663
const chainOf = (chainId: number) => {
  if (!Number.isSafeInteger(chainId) || chainId <= 0) throw new Error('invalid_wallet_chain')
  return chainId
}
const nonceKey = (chainId: number, owner: string, nonce: bigint) => {
  if (!/^0x[0-9a-f]{40}$/.test(owner) || nonce < 0n || nonce >= 2n ** 64n) throw new Error('invalid_wallet_nonce')
  return prefix + keccak256(stringToHex(`${chainOf(chainId)}|${owner}|${nonce}`)).slice(2)
}
const batchKey = (chainId: number, owner: string, operationId: string) => {
  if (!/^0x[0-9a-f]{40}$/.test(owner) || !/^0x[0-9a-f]{64}$/.test(operationId)) throw new Error('invalid_wallet_batch')
  return batchPrefix + keccak256(stringToHex(`${chainOf(chainId)}|${owner}|${operationId}`)).slice(2)
}
/**
 * The mark after a claim time that says the page which claimed the latch holds its lock while it is open (2026-10-01, fix
 * round 1). Only a claim since audit C2 holds one. A latch from the release before it (production until this package: no
 * lock, and for a nonce no time at all) or one whose clock started when it was met carries no mark, and its missing lock
 * proves nothing: during the rollout a tab of that release may still have its prompt open. Such a latch is let go by its
 * age alone. A tab of the older release reading a marked time reads no number and starts the clock again: later, never
 * sooner.
 */
const LIVE_MARK = 'L'
/** A claim time as kept beside a latch: unix seconds (NaN when none or unreadable), and whether it carries LIVE_MARK. */
function readStamp(raw: string | null): { at: number; live: boolean } {
  if (raw === null) return { at: Number.NaN, live: false }
  const live = raw.endsWith(LIVE_MARK)
  return { at: Number(live ? raw.slice(0, -LIVE_MARK.length) : raw), live }
}
/** A wallet's id for a batch (EIP-5792): printable ASCII, and never the separator the latch stores it after. */
const BATCH_ID = /^[\x21-\x7b\x7d\x7e]{1,512}$/

/**
 * Whether a wallet's refusal of a send proves that nothing was sent, so its nonce latch can be let go (2026-10-01,
 * audit C2, with the owner's OK). Until then only EIP-1193's 4001 did, and any other refusal, a Ledger's included,
 * left a latch that blocked every later money action in that browser. These do:
 * - 4001 the person rejected it; 4100 the account is not authorized; 4200 the wallet does not carry the method;
 *   4900 and 4901 the wallet is disconnected, from every chain or this one; -32602 the wallet refused its fields
 *   before signing; 5000 WalletConnect's own "User rejected.";
 * - a hardware wallet's refusal, which MetaMask and others pass on as a -32603 with the device's words: the Ledger
 *   status 0x6985 ("Condition of use not satisfied (denied by the user?)"), or the person's refusal said in words.
 * Anything else (a time-out, a lost answer, a node's error) may have been sent: its latch stays until the chain or the
 * person settles it (settle and forget below). The error is walked through the wrappers wallets and viem use.
 */
const PERSON_CODES: ReadonlySet<number> = new Set([4001, 5000])
const REFUSAL_CODES: ReadonlySet<number> = new Set([...PERSON_CODES, 4100, 4200, 4900, 4901, -32602])
const REFUSAL_WORDS = /0x6985|denied by the user|rejected by the user|user rejected|user denied|user cancel+ed|cancel+ed by (?:the )?user|request rejected|rejected the request/i
/** Whether an error, walked through its wrappers, carries one of `codes` or says a refusal in words. */
function refusedWith(error: unknown, codes: ReadonlySet<number>): boolean {
  let refused = false
  const walk = (value: unknown, depth: number) => {
    if (refused || !value || typeof value !== 'object' || depth > 5) return
    const node = value as { code?: unknown; message?: unknown; data?: unknown; cause?: unknown; originalError?: unknown; error?: unknown }
    if (typeof node.code === 'number' && codes.has(node.code)) refused = true
    if (typeof node.message === 'string' && REFUSAL_WORDS.test(node.message)) refused = true
    if (typeof node.data === 'string' && REFUSAL_WORDS.test(node.data)) refused = true
    for (const next of [node.data, node.cause, node.originalError, node.error]) walk(next, depth + 1)
  }
  walk(error, 0)
  return refused
}
export const definiteRefusal = (error: unknown): boolean => refusedWith(error, REFUSAL_CODES)
/** The person's own refusal, in their wallet or on its device (4001, WalletConnect's 5000, a hardware wallet's words). */
export const personRefused = (error: unknown): boolean => refusedWith(error, PERSON_CODES)

/** A cross-tab, reload-safe quarantine for a nonce offered to a wallet. Only
 * hashes, random claim IDs and claim times are stored; no addresses, amounts,
 * calldata, bearer credentials or private API responses enter browser storage.
 *
 * A batch (EIP-5792) has a latch of its own, keyed by the operation id it
 * opens: a wallet may run it through a bundler, spending no nonce of the
 * owner's. It keeps the wallet's batch id beside the claim, the one value
 * from a wallet stored here, so the batch's status can be asked again after a
 * reload. The contract already refuses a second batch for the same id; the
 * latch keeps a second prompt from opening. Beside it, the time it was claimed
 * (2026-09-28), so a latch whose batch can no longer execute is freed
 * (expireBatch) instead of holding every later press.
 *
 * 2026-10-01 (audit C2, the owner's OK): a nonce's latch keeps its claim time too, and the page that claimed it holds
 * a lock while it is open. A latch met again while the chain shows nothing pending for that nonce is let go once its
 * page is gone (it was reloaded or closed during the prompt) or once it is older than the caller's limit (settle), or
 * when the person says they rejected or closed the request in their wallet (forget). Nothing here ever sends: each
 * later offer is a new review, and each money step names what it does once on chain (an operation is opened, swapped,
 * minted and closed once), so a request still open in a wallet cannot repeat one. */
export function createNonceJournal(storage: StoragePort, locks: LockPort, randomId: () => string, chainId: number = ROBINHOOD) {
  chainOf(chainId)
  const keyFor = (owner: string, nonce: bigint) => nonceKey(chainId, owner, nonce)
  const atKeyFor = (owner: string, nonce: bigint) => atPrefix + keyFor(owner, nonce).slice(prefix.length)
  const liveFor = (owner: string, nonce: bigint) => livePrefix + keyFor(owner, nonce).slice(prefix.length)
  const batchKeyFor = (owner: string, operationId: string) => batchKey(chainId, owner, operationId)
  const batchAtKeyFor = (owner: string, operationId: string) => batchAtPrefix + batchKeyFor(owner, operationId).slice(batchPrefix.length)
  const batchLiveFor = (owner: string, operationId: string) => livePrefix + 'b' + batchKeyFor(owner, operationId).slice(batchPrefix.length)
  const held = () => {
    let count = 0
    for (let i = 0; i < storage.length; i++) if (storage.key(i)?.startsWith(prefix) || storage.key(i)?.startsWith(batchPrefix)) count++
    return count
  }
  const place = (key: string) => {
    if (held() >= 1024) throw new Error('wallet_nonce_journal_full')
    const token = randomId()
    if (!/^[0-9a-f-]{36}$/.test(token)) throw new Error('wallet_nonce_coordination_unavailable')
    storage.setItem(key, token)
    if (storage.getItem(key) !== token) throw new Error('wallet_nonce_coordination_unavailable')
    return token
  }
  /**
   * Keeps the claim time beside a latch where storage allows; a latch never fails for want of it. `live`: the page that
   * claimed it holds its lock (LIVE_MARK).
   */
  const stamp = (key: string, at: number | undefined, live: boolean) => {
    if (at === undefined || !Number.isFinite(at) || at <= 0) return
    try { storage.setItem(key, `${Math.floor(at)}${live ? LIVE_MARK : ''}`) } catch { /* the latch's clock starts when it is next met */ }
  }
  const drop = (owner: string, nonce: bigint) => {
    storage.removeItem(keyFor(owner, nonce))
    storage.removeItem(atKeyFor(owner, nonce))
    locks.letGo?.(liveFor(owner, nonce))
  }
  return {
    offered: (owner: string, nonce: bigint) => storage.getItem(keyFor(owner, nonce)) !== null,
    /** `at`: when, in unix seconds. The page holds the offer's lock from here until it lets the latch go or closes. */
    claim: (owner: string, nonce: bigint, at?: number) => locks.request(keyFor(owner, nonce), async () => {
      const key = keyFor(owner, nonce)
      if (storage.getItem(key) !== null) throw new Error('wallet_nonce_already_offered')
      const token = place(key)
      stamp(atKeyFor(owner, nonce), at, locks.hold !== undefined)
      locks.hold?.(liveFor(owner, nonce))
      return token
    }),
    releaseAfterRejection: (owner: string, nonce: bigint, token: string) => locks.request(keyFor(owner, nonce), async () => {
      const key = keyFor(owner, nonce)
      if (storage.getItem(key) === token) drop(owner, nonce)
    }),
    /**
     * A latch on `nonce` met while the chain shows nothing pending for it (latest equals pending equals `nonce`). It
     * is let go when the page that claimed it is gone, a reload or a closed tab during the prompt, or when it was
     * claimed more than `maxAge` seconds before `now`. One with no time beside it (claimed before times were kept) or
     * a time in the future (a clock set back) starts its clock now. Only a latch whose time carries LIVE_MARK is let go
     * for want of its page's lock: one claimed by a release before the lock existed is let go by its age (fix round 1).
     * True when the nonce is free.
     */
    settle: (owner: string, nonce: bigint, now: number, maxAge: number) => locks.request(keyFor(owner, nonce), async () => {
      const key = keyFor(owner, nonce), atKey = atKeyFor(owner, nonce)
      if (storage.getItem(key) === null) {
        storage.removeItem(atKey)
        return true
      }
      const { at, live: marked } = readStamp(storage.getItem(atKey))
      const live = marked && locks.held ? await locks.held(liveFor(owner, nonce)) : true
      if (!live) {
        drop(owner, nonce)
        return true
      }
      if (!Number.isFinite(at) || at <= 0 || at > now) {
        stamp(atKey, now, marked)
        return false
      }
      if (now - at <= maxAge) return false
      drop(owner, nonce)
      return true
    }),
    /**
     * The person says they rejected or closed the request in their wallet (audit C2): the latch is let go, whoever
     * holds it. The caller asks only while the chain shows nothing pending for the nonce, and sends nothing itself.
     */
    forget: (owner: string, nonce: bigint) => locks.request(keyFor(owner, nonce), async () => {
      const had = storage.getItem(keyFor(owner, nonce)) !== null
      drop(owner, nonce)
      return had
    }),
    /** The batch offered for this operation: the wallet's id for it, '' until the wallet answered, null when none. */
    batchOffered: (owner: string, operationId: string): string | null => {
      const value = storage.getItem(batchKeyFor(owner, operationId))
      return value === null ? null : value.slice(37)
    },
    /** `at`: when, in unix seconds; kept beside the latch where storage allows, never failing the claim. */
    claimBatch: (owner: string, operationId: string, at?: number) => locks.request(batchKeyFor(owner, operationId), async () => {
      const key = batchKeyFor(owner, operationId)
      if (storage.getItem(key) !== null) throw new Error('wallet_batch_already_offered')
      const token = place(key)
      stamp(batchAtKeyFor(owner, operationId), at, locks.hold !== undefined)
      locks.hold?.(batchLiveFor(owner, operationId))
      return token
    }),
    /** Keeps the wallet's id for the batch this claim offered, so its status can be asked after a reload. */
    recordBatch: (owner: string, operationId: string, token: string, id: string) => locks.request(batchKeyFor(owner, operationId), async () => {
      if (!BATCH_ID.test(id)) throw new Error('invalid_wallet_batch')
      const key = batchKeyFor(owner, operationId)
      if (storage.getItem(key) === token) storage.setItem(key, `${token}|${id}`)
    }),
    /** Frees the latch once nothing of the batch can still execute or it is done, by its claim or by the wallet's id. */
    releaseBatch: (owner: string, operationId: string, claim: string) => locks.request(batchKeyFor(owner, operationId), async () => {
      const key = batchKeyFor(owner, operationId), value = storage.getItem(key)
      if (value !== null && claim !== '' && (value.slice(0, 36) === claim || value.slice(37) === claim)) {
        storage.removeItem(key)
        storage.removeItem(batchAtKeyFor(owner, operationId))
        locks.letGo?.(batchLiveFor(owner, operationId))
      }
    }),
    /**
     * Frees the latch claimed more than `maxAge` seconds before `now`: its batch can no longer execute (setup.ts
     * BATCH_LATCH_EXPIRY_S says why), whether or not the wallet ever answered. A latch with no time beside it (claimed
     * before times were kept, or where storage refused one) starts its clock now, and one claimed in the future (a clock
     * set back) starts it again: either frees later than needed, never sooner. 2026-10-01 (audit C2): a latch the wallet
     * never answered (no id beside it) whose page is gone, reloaded or closed during the prompt, is freed at once; the
     * contract refuses a second batch for the operation, so one still open in the wallet cannot run twice. Only one whose
     * time carries LIVE_MARK, though: a release before the lock existed claimed its latches holding none (fix round 1).
     * True when it freed one.
     */
    expireBatch: (owner: string, operationId: string, now: number, maxAge: number) => locks.request(batchKeyFor(owner, operationId), async () => {
      const key = batchKeyFor(owner, operationId), atKey = batchAtKeyFor(owner, operationId)
      const value = storage.getItem(key)
      if (value === null) {
        storage.removeItem(atKey)
        return false
      }
      const { at, live: marked } = readStamp(storage.getItem(atKey))
      if (value.length <= 36 && marked && locks.held && !(await locks.held(batchLiveFor(owner, operationId)))) {
        storage.removeItem(key)
        storage.removeItem(atKey)
        return true
      }
      if (!Number.isFinite(at) || at <= 0 || at > now) {
        stamp(atKey, now, marked)
        return false
      }
      if (now - at <= maxAge) return false
      storage.removeItem(key)
      storage.removeItem(atKey)
      locks.letGo?.(batchLiveFor(owner, operationId))
      return true
    }),
  }
}

/** The page's own holds: a release for each lock it holds until it lets the latch go or the page goes away. */
const holds = new Map<string, () => void>()
function browserLocks(locks: LockManager): LockPort {
  return {
    // The DOM's typing nests the callback's promise; the lock manager itself resolves to the callback's own result.
    request: <T,>(name: string, callback: () => Promise<T>) => locks.request(name, callback) as unknown as Promise<T>,
    hold(name) {
      if (holds.has(name)) return
      let release = () => {}
      const done = new Promise<void>((resolve) => { release = resolve })
      holds.set(name, release)
      void locks.request(name, () => done).catch(() => holds.delete(name))
    },
    letGo(name) {
      holds.get(name)?.()
      holds.delete(name)
    },
    // Taken only if no page holds it, and let go at once: a page that holds it, this one included, is still open.
    held: (name) => locks.request(name, { ifAvailable: true }, async (lock) => lock === null) as unknown as Promise<boolean>,
  }
}
function browserJournal(chainId: number = ROBINHOOD) {
  if (typeof window === 'undefined' || !navigator.locks) throw new Error('wallet_nonce_coordination_unavailable')
  return createNonceJournal(window.localStorage, browserLocks(navigator.locks), () => crypto.randomUUID(), chainId)
}
/**
 * The page's journal for one chain (Domino V2, spec F7 §1.3): the same latches, keys and locks as V1's, keyed by that
 * chain (finance/v2/wallet.ts). V1's functions below are this journal for Robinhood Chain.
 */
export const chainNonceJournal = (chainId: number) => browserJournal(chainId)
export const ownerNonceOffered = (owner: string, nonce: bigint) => browserJournal().offered(owner, nonce)
export const claimOwnerNonce = (owner: string, nonce: bigint) => browserJournal().claim(owner, nonce, Date.now() / 1000)
export const releaseOwnerNonceAfterRejection = (owner: string, nonce: bigint, token: string) => browserJournal().releaseAfterRejection(owner, nonce, token)
export const settleOwnerNonce = (owner: string, nonce: bigint, now: number, maxAge: number) => browserJournal().settle(owner, nonce, now, maxAge)
export const forgetOwnerNonce = (owner: string, nonce: bigint) => browserJournal().forget(owner, nonce)
export const ownerBatchOffered = (owner: string, operationId: string) => browserJournal().batchOffered(owner, operationId)
export const claimOwnerBatch = (owner: string, operationId: string) => browserJournal().claimBatch(owner, operationId, Date.now() / 1000)
export const recordOwnerBatch = (owner: string, operationId: string, token: string, id: string) => browserJournal().recordBatch(owner, operationId, token, id)
export const releaseOwnerBatch = (owner: string, operationId: string, claim: string) => browserJournal().releaseBatch(owner, operationId, claim)
export const expireOwnerBatch = (owner: string, operationId: string, now: number, maxAge: number) => browserJournal().expireBatch(owner, operationId, now, maxAge)
