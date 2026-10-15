/** The shared canonical watcher is exercised with a fake clock and fixed public reads, never a wallet. */
// Changed on purpose 2026-10-14 (incident C2: the 429 on /api/chain/v1/confirmation). The queue read every included
// Robinhood receipt from the node on a timer (2 s, 5 s, 30 s, for seven days), and every receipt read-v6 merely listed
// too: about 470 node POSTs per receipt per tab. It now reads nothing by the clock. What may start a read is said by the
// tests below: the chain's finalized mark as read-v6 already serves it (a hint, never a proof), or, with that mark frozen,
// an operation that holds a settlement and is forty minutes old. The proof itself is unchanged: this exact transaction,
// in this exact block, the canonical block of that number, success, and the node's own finalized block at or past it.
// The older cases that started from "a timer fires after record" now start from the mark; each says so where it changed.
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import test from 'node:test'
const require = createRequire(import.meta.url)
const HASH = `0x${'ab'.repeat(32)}`, BLOCK_HASH = `0x${'cd'.repeat(32)}`, OTHER = `0x${'ef'.repeat(32)}`, WALLET = `0x${'01'.repeat(20)}`
const MINUTE = 60_000
/** The queue gives read-v6 its turn (INDEX_TURN_MS) before its own read at the mark. */
const INDEX_WAIT = 75_000
const flush = async () => { for (let i = 0; i < 4; i++) await new Promise(resolve => setImmediate(resolve)) }
/**
 * The module as the page loads it, over `deps` in place of its two imports (the edge reader and the position evidence).
 * Changed on purpose 2026-10-15 (pack 8, incident C5): its third import, the chains' receipt sources
 * (src/config/receiptSources.ts), is the real one, as the page's build compiles it.
 */
function load(deps = { confirmationReads: {}, notePositionConfirmation() {} }) {
  const ts = require('typescript'), mod = { exports: {} }
  const code = ts.transpileModule(readFileSync(new URL('../src/lib/confirmedOperations.ts', import.meta.url), 'utf8'),
    { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
  new Function('require', 'module', 'exports', code)(name => /receiptSources$/.test(name) ? require('../.test-build/app/src/config/receiptSources.js') : deps, mod, mod.exports)
  return mod.exports
}
const create = load().createConfirmedOperations
function harness({ answer = () => canonical(), finalized = async () => ({ number: '0x10' }) } = {}) {
  let now = 1000, visible = true
  const timers = new Set(), calls = [], asks = [], published = []
  const read = { read: async hash => { calls.push(hash); return answer(hash) }, finalized: async () => { asks.push(now); return finalized() } }
  const clock = { now: () => now, visible: () => visible,
    set: (run, ms) => { const timer = { run, at: now + ms }; timers.add(timer); return timer }, clear: timer => timers.delete(timer) }
  const store = create(read, clock, op => published.push(op))
  const first = () => [...timers].sort((a, b) => a.at - b.at)[0]
  return { store, calls, asks, published, timers, time: () => now, hide: () => { visible = false }, show: () => { visible = true }, advance: ms => { now += ms },
    /** When the next pass is due, or null with nothing scheduled. */
    due: () => first()?.at ?? null,
    async next() { const timer = first(); assert.ok(timer, 'a pass is scheduled'); timers.delete(timer); now = Math.max(now, timer.at); timer.run(); await flush() },
    /** Lets `ms` of the fake clock pass, running every pass that falls due inside it. */
    async run(ms) { const end = now + ms; for (let timer = first(); timer && timer.at <= end; timer = first()) { timers.delete(timer); now = Math.max(now, timer.at); timer.run(); await flush() } now = end } }
}
const input = (extra = {}) => ({ chainId: 4663, wallet: WALLET, tokenIds: ['3659830'], positionManager: `0x${'02'.repeat(20)}`,
  receipt: { transactionHash: HASH, blockHash: BLOCK_HASH, blockNumber: 16n, state: 'included' }, ...extra })
const canonical = (extra = {}) => ({ transaction: {}, receipt: { transactionHash: HASH, from: WALLET, blockHash: BLOCK_HASH, blockNumber: '0x10', status: '0x1' },
  block: { number: '0x10', hash: BLOCK_HASH }, ...extra })
/** read-v6's finalized mark for Robinhood Chain reaches `block`: the one read an own operation may make becomes due. */
const mark = (h, block = 16) => h.store.noteChainFinality(4663, block)
const indexed = (extra = {}) => ({ indexed: true, chainId: 4663, wallet: WALLET, tokenIds: [], receipt: { ...input().receipt, ...extra } })

test('operations require a real hash, owner and safe block, keep immutable scopes, and bound remembered operations', () => {
  const h = harness()
  const invalid = [input({ wallet: 'invalid' }), input({ receipt: { ...input().receipt, transactionHash: undefined } }),
    input({ receipt: { ...input().receipt, blockHash: 'invalid' } }), input({ receipt: { ...input().receipt, blockNumber: 0n } }),
    input({ receipt: { ...input().receipt, blockNumber: BigInt(Number.MAX_SAFE_INTEGER) + 1n } })]
  for (const value of invalid) assert.equal(h.store.record(value), null)
  assert.equal(h.store.get().length, 0)
  const ids = ['1'], op = h.store.record(input({ tokenIds: ids }))
  ids.push('2')
  assert.deepEqual(op.tokenIds, ['1'])
  assert.ok(Object.isFrozen(op.tokenIds))
  assert.ok(Object.isFrozen(h.store.get()[0]))
  assert.ok(Object.isFrozen(h.store.get()))
  for (let i = 0; i < 70; i++) h.store.record(input({ receipt: { ...input().receipt, transactionHash: `0x${i.toString(16).padStart(64, '0')}` } }))
  assert.equal(h.store.get().length, 64)
})

test('validated indexed finality completes exact multichain inclusion without losing its checked effects or opening another reader', () => {
  for (const chainId of [8453, 42161]) {
    const h = harness(), events = [{ address: `0x${'03'.repeat(20)}`, eventName: 'Created', args: { tokenId: 6238157n } }]
    const local = input({ chainId, vault: `0x${'04'.repeat(20)}`, receipt: { ...input().receipt, events } })
    const included = h.store.record(local)
    h.store.record({ indexed: true, chainId, wallet: WALLET, tokenIds: [], receipt: { ...local.receipt, events: [], state: 'finalized' } })
    const final = h.store.get()[0]
    assert.deepEqual(final, { ...included, phase: 'finalized' })
    assert.equal(final.indexed, undefined, 'index evidence cannot erase financial scope or its original provenance')
    h.store.record({ indexed: true, chainId, wallet: WALLET, tokenIds: [], receipt: input().receipt })
    assert.equal(h.store.get()[0], final, 'an older index response cannot downgrade finality')
    assert.equal(h.published.length, 2, 'no repeated publication or refresh loop')
    assert.equal(h.timers.size, 0); assert.equal(h.calls.length, 0)
  }
})

test('indexed finality is bound to owner, chain, transaction and block, and cannot resurrect a reorg', () => {
  const h = harness(), local = input({ chainId: 8453 })
  const included = h.store.record(local)
  const indexed = { ...local, indexed: true, tokenIds: [], receipt: { ...local.receipt, state: 'finalized' } }
  h.store.record({ ...indexed, wallet: `0x${'05'.repeat(20)}` })
  h.store.record({ ...indexed, receipt: { ...indexed.receipt, blockNumber: 17n } })
  h.store.record({ ...indexed, receipt: { ...indexed.receipt, blockHash: OTHER } })
  assert.equal(h.store.get()[0], included)
  h.store.record({ ...indexed, chainId: 42161 })
  assert.equal(h.store.finality(8453, HASH, BLOCK_HASH), 'included', 'a matching transaction on another chain is independent')
  h.store.reorg({ chainId: 8453, wallet: WALLET, hash: HASH, blockHash: BLOCK_HASH })
  const reorged = h.store.get().find(op => op.chainId === 8453)
  h.store.record(indexed)
  h.store.record({ ...indexed, receipt: { ...indexed.receipt, blockHash: OTHER } })
  assert.equal(h.store.get().find(op => op.chainId === 8453), reorged)
  assert.equal(reorged.phase, 'reorged', 'new effects must be checked by the financial client')
  assert.equal(h.timers.size, 0); assert.equal(h.calls.length, 0)
})

test('reload adoption finalizes historical receipts without introducing financial scope or new read work', () => {
  const h = harness(), historical = input({ chainId: 8453, indexed: true, positionManager: undefined, tokenIds: [] })
  h.store.record(historical)
  h.store.record({ ...historical, receipt: { ...historical.receipt, state: 'finalized' } })
  assert.equal(h.store.get()[0].indexed, true)
  assert.equal(h.store.get()[0].phase, 'finalized')
  assert.deepEqual(h.store.get()[0].tokenIds, [])
  assert.equal(h.timers.size, 0); assert.equal(h.calls.length, 0)
})

// Added 2026-10-14 (incident C2). Someone who only opens Receipts or a position sent nothing from this browser: what
// read-v6 lists is confirmed because the index holds it, and final when its own `tx.finality` says so. The page's list no
// longer hands such receipts to the queue (tests/v2/activity-history.test.mjs); this holds the queue itself to it.
test('ten unfinalized indexed receipts on Robinhood Chain make zero reads in twenty minutes', async () => {
  const h = harness({ answer: hash => canonical({ receipt: { ...canonical().receipt, transactionHash: hash } }) })
  const hashes = Array.from({ length: 10 }, (_, i) => `0x${i.toString(16).padStart(64, '0')}`)
  for (const transactionHash of hashes) h.store.record(indexed({ transactionHash }))
  assert.equal(h.store.get().length, 10)
  await h.run(MINUTE)
  assert.equal(h.calls.length, 0, 'a receipt the index listed is never read from the node')
  for (let minute = 1; minute < 20; minute++) { mark(h, 16 + minute); h.store.wake(); await h.run(MINUTE) }
  assert.equal(h.calls.length, 0, 'not when the finalized mark passes it, and not on a wake')
  assert.equal(h.asks.length, 0, 'the finalized block is not asked either')
  assert.equal(h.timers.size, 0, 'nothing is scheduled for them')
  assert.ok(h.store.get().every(op => op.phase === 'included'))
  for (const transactionHash of hashes) h.store.record(indexed({ transactionHash, state: 'finalized' }))
  assert.ok(h.store.get().every(op => op.phase === 'finalized' && op.indexed), 'the index\'s own finality completes what the index listed')
  assert.equal(h.calls.length, 0); assert.equal(h.timers.size, 0)
})

// Added 2026-10-14 (incident C2). Finality on Robinhood Chain trails the head by about 16 minutes (measured 2026-10-13);
// asking the node before the chain's finalized mark has passed the block can only answer "not yet".
test('an own included operation makes zero reads until the finalized mark reaches its block, then exactly one receipt read and one finality read', async () => {
  const h = harness()
  h.store.record(input())
  assert.equal(h.timers.size, 0, 'inclusion alone schedules nothing')
  await h.run(10 * MINUTE)
  assert.equal(h.calls.length, 0, 'no read by the clock')
  mark(h, 15); h.store.noteChainFinality(8453, 1000); h.store.noteChainFinality(4663, Number.NaN); h.store.noteChainFinality(4663, -1)
  await h.run(10 * MINUTE)
  assert.equal(h.calls.length, 0, 'a mark below its block, another chain\'s mark and a malformed mark start nothing')
  assert.equal(h.asks.length, 0)
  assert.equal(h.timers.size, 0)
  mark(h, 16)
  assert.equal(h.store.get()[0].phase, 'included', 'the mark is a hint: it finalizes nothing by itself')
  assert.equal(h.timers.size, 1)
  await h.run(10 * MINUTE)
  assert.equal(h.store.get()[0].phase, 'finalized')
  assert.equal(h.calls.length, 1, 'one receipt read, bound to the recorded block')
  assert.equal(h.asks.length, 1, 'one finalized-block read')
  mark(h, 5000); h.store.wake(); await h.run(10 * MINUTE)
  assert.equal(h.calls.length, 1); assert.equal(h.asks.length, 1)
  assert.equal(h.timers.size, 0, 'a final operation leaves nothing scheduled')
})

// Added 2026-10-14 (incident C2). The mark costs no request: it is `chains[].finalizedThrough` of the read-v6 answers the
// page reads anyway. This holds the page's own queue (the module's singleton) to it, and the two places that hand it on.
test('the finalized mark of a read-v6 answer reaches the page\'s own queue, from the lists\' portfolio and from the activity history', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
  const reads = [], confirmed = []
  const page = load({ confirmationReads: { read: async hash => { reads.push(hash); return canonical() }, finalized: async () => ({ number: '0x10' }) },
    notePositionConfirmation: change => confirmed.push(change) })
  page.recordConfirmedOperation(input())
  page.noteAnswerFinality([{ chainId: 8453, finalizedThrough: null }, { chainId: 42161, finalizedThrough: { number: 9000 } }, { chainId: 4663, finalizedThrough: { number: 15 } }])
  t.mock.timers.tick(10 * MINUTE); await flush()
  assert.equal(reads.length, 0, 'a mark below the block, a null one and another chain\'s start nothing')
  page.noteAnswerFinality([{ chainId: 4663, finalizedThrough: { number: 16 } }])
  t.mock.timers.tick(10 * MINUTE); await flush()
  assert.deepEqual(reads, [HASH])
  assert.equal(page.receiptFinality(4663, HASH, BLOCK_HASH), 'finalized')
  assert.deepEqual(confirmed.map(change => change.block), [16, 16], 'position sync hears the inclusion and its finality, as before')
  const source = readFileSync(new URL('../src/v2in/lists/source.ts', import.meta.url), 'utf8')
  assert.match(source, /await LISTS_SOURCE\.ownPortfolio\(wallet\)[\s\S]{0,600}?\n {2}if \(answer\.kind === 'ok'\) noteAnswerFinality\(answer\.body\.chains\)/, 'every good portfolio answer')
  const activity = readFileSync(new URL('../src/v2in/lists/activity.tsx', import.meta.url), 'utf8')
  // Changed on purpose 2026-10-15 (pack 7): the history takes a fifth argument after it, the idle predicate (activity.tsx idleWallet).
  assert.match(activity, /createActivityHistory\([\s\S]*?\}, refresh, answer => noteAnswerFinality\(answer\.chains\)(, idleWallet)?\)/, 'every good activity answer (tests/v2/activity-history.test.mjs holds the history to handing each on)')
})

test('an operation recorded after the mark already passed its block is read once too, never at once', async () => {
  const h = harness()
  mark(h, 4000)
  h.store.record(input())
  assert.equal(h.calls.length, 0)
  assert.ok(h.due() - h.time() >= 5000, 'the index is given its turn first')
  await h.run(10 * MINUTE)
  assert.equal(h.store.get()[0].phase, 'finalized')
  assert.equal(h.calls.length, 1); assert.equal(h.asks.length, 1)
})

// Added 2026-10-14 (incident C2). What read-v6 lists needs nothing from the node: its own item, of the same transaction
// in the same block, says when it is final. The queue waits a little after the mark for that answer before it reads.
test('an indexed finalized item of the same transaction and block finalizes an own operation with zero reads; its settlement keeps its own proof', async () => {
  for (const marked of [false, true]) {
    const h = harness(); let settled = 0
    const own = h.store.record(input({ onFinalized: async () => { settled++; return true } }))
    await h.run(10 * MINUTE)
    assert.equal(h.calls.length, 0, 'nothing is read while the index has not spoken')
    if (marked) mark(h)
    h.store.record(indexed({ blockHash: OTHER, state: 'finalized' }))
    assert.equal(h.store.get()[0].phase, 'included', 'another block\'s item proves nothing about this inclusion')
    h.store.record(indexed({ state: 'finalized' }))
    assert.deepEqual(h.store.get()[0], { ...own, phase: 'finalized' })
    assert.equal(settled, 0)
    await h.run(MINUTE)
    assert.equal(settled, 1, 'the settlement runs once the operation is final, with its own read')
    await h.run(30 * MINUTE)
    assert.equal(h.calls.length, 0, 'the queue itself read no receipt')
    assert.equal(h.asks.length, 0)
    assert.equal(h.timers.size, 0)
  }
})

test('an operation the index completes while an earlier read of the same pass is in flight is not read', async () => {
  let finish
  const h = harness({ answer: hash => hash === HASH ? new Promise(resolve => { finish = resolve }) : canonical({ receipt: { ...canonical().receipt, transactionHash: hash } }) })
  h.store.record(input()); h.store.record(input({ tokenIds: ['2'], receipt: { ...input().receipt, transactionHash: OTHER } }))
  mark(h); await h.next()
  assert.deepEqual(h.calls, [HASH], 'reads are one at a time')
  h.store.record(indexed({ transactionHash: OTHER, state: 'finalized' }))
  finish(canonical()); await flush()
  assert.deepEqual(h.calls, [HASH], 'the index spoke first: nothing is asked for the second')
  assert.ok(h.store.get().every(op => op.phase === 'finalized'))
  assert.equal(h.timers.size, 0)
})

// Added 2026-10-14 (incident C2). The node loop was also the only detector of a reorganised own operation on Robinhood
// Chain; the one read at finality keeps that check.
test('a different canonical block hash at that one read emits reorged, cancels the settlement and asks nothing more', async () => {
  let settled = 0
  const h = harness({ answer: () => canonical({ block: { number: '0x10', hash: OTHER } }) })
  h.store.record(input({ onFinalized: async () => { settled++; return true } }))
  await h.run(10 * MINUTE)
  assert.equal(h.calls.length, 0, 'not read before the mark')
  mark(h); await h.run(10 * MINUTE)
  assert.equal(h.calls.length, 1)
  assert.equal(h.store.get()[0].phase, 'reorged')
  assert.equal(h.published.at(-1).phase, 'reorged')
  assert.equal(h.asks.length, 0, 'a contradicted block needs no finality')
  assert.equal(settled, 0)
  assert.equal(h.timers.size, 0)
})

// Changed on purpose 2026-10-14 (incident C2): the read starts from the mark, not from a timer after `record`.
test('missing, lagging and unavailable data keep inclusion; finalized height alone proves nothing', async () => {
  for (const answer of [() => ({ transaction: null, receipt: null, block: null }), () => canonical({ block: null }),
    () => canonical({ block: { number: '0xf', hash: BLOCK_HASH } }), () => { throw new Error('node offline') }]) {
    let finalizedCalls = 0
    const h = harness({ answer, finalized: async () => { finalizedCalls++; return { number: '0x100' } } })
    h.store.record(input()); mark(h, 0x100); await h.next()
    assert.equal(h.calls.length, 1)
    assert.equal(h.store.get()[0].phase, 'included')
    assert.equal(finalizedCalls, 0)
    assert.equal(h.published.length, 1, 'no false rollback or finality publication')
  }
})

// Changed on purpose 2026-10-14 (incident C2): the read starts from the mark.
test('an unrelated receipt cannot roll back the tracked operation; a contradictory canonical proof can', async () => {
  for (const receiptPatch of [{ transactionHash: OTHER }]) {
    const h = harness({ answer: () => canonical({ receipt: { ...canonical().receipt, ...receiptPatch }, block: { number: '0x10', hash: OTHER } }) })
    h.store.record(input()); mark(h); await h.next()
    assert.equal(h.store.get()[0].phase, 'included')
  }
  const reorg = harness({ answer: () => canonical({ block: { number: '0x10', hash: OTHER } }) })
  reorg.store.record(input()); mark(reorg); await reorg.next()
  assert.equal(reorg.store.get()[0].phase, 'reorged')
  assert.equal(reorg.store.finality(4663, HASH, BLOCK_HASH), 'reorged')
  const moved = harness({ answer: () => canonical({ receipt: { ...canonical().receipt, blockNumber: '0x11', blockHash: OTHER }, block: { number: '0x11', hash: OTHER } }) })
  moved.store.record(input()); mark(moved); await moved.next()
  assert.equal(moved.store.get()[0].phase, 'reorged', 'a different inclusion waits for the financial client to verify its effects')
  assert.equal(moved.store.get()[0].blockHash, BLOCK_HASH, 'a watcher cannot adopt a new effect by itself')
})

// Changed on purpose 2026-10-14 (incident C2): the read starts from the mark.
test('canonical inclusion is retained if finality is missing, behind or failed, and finalized only when both agree', async () => {
  for (const finalized of [async () => null, async () => ({ number: '0xf' }), async () => { throw new Error('finality unavailable') }]) {
    const h = harness({ finalized }); h.store.record(input()); mark(h); await h.next()
    assert.equal(h.store.get()[0].phase, 'included')
  }
  const h = harness(); h.store.record(input()); mark(h); await h.next()
  assert.equal(h.store.get()[0].phase, 'finalized')
  assert.equal(h.published.at(-1).phase, 'finalized')
  assert.equal(h.store.finality(4663, HASH, OTHER), null, 'finality belongs to this exact block hash')
  assert.equal(h.store.finality(8453, HASH, BLOCK_HASH), null, 'chain is part of the identity')
})

// Changed on purpose 2026-10-14 (incident C2): the read starts from the mark.
test('an already checked AA receipt finalizes with its canonical hash even when its payer differs from the wallet', async () => {
  const h = harness({ answer: () => canonical({ receipt: { ...canonical().receipt, from: `0x${'03'.repeat(20)}` } }) })
  h.store.record(input()); mark(h); await h.next()
  assert.equal(h.store.get()[0].phase, 'finalized')
  assert.equal(h.store.get()[0].wallet, WALLET, 'the recorded authority stays the wallet whose effects were checked')
})

// Changed on purpose 2026-10-14 (incident C2): the six reads fall due from the mark; the pass still stops at four, and
// the four share one finalized-block read.
test('the watcher pauses hidden, wakes on visibility/focus, serializes reads and limits a pass to four', async () => {
  const h = harness({ answer: hash => canonical({ receipt: { ...canonical().receipt, transactionHash: hash } }) })
  for (let i = 0; i < 6; i++) h.store.record(input({ tokenIds: [String(i)], receipt: { ...input().receipt, transactionHash: `0x${i.toString(16).padStart(64, '0')}` } }))
  mark(h)
  h.hide(); await h.next(); assert.equal(h.calls.length, 0)
  h.show(); h.store.wake(); await h.next()
  assert.equal(h.calls.length, 4)
  assert.equal(h.asks.length, 1, 'one finalized-block read for the pass')
  assert.equal(h.store.get().filter(op => op.phase === 'included').length, 2)
  await h.next(); assert.equal(h.calls.length, 6)
  assert.equal(h.store.get().filter(op => op.phase === 'included').length, 0)
  assert.equal(h.timers.size, 0)
})

// Added 2026-10-14 (incident C2; the owner's console of 2026-10-13: `wake` on the stack of the refused read). A wallet
// popup closing fires `focus`; it cleared every wait and read at once.
test('twenty focus events make zero reads and bring no wait closer', async () => {
  const waiting = harness()
  waiting.store.record(input({ onFinalized: async () => true }))
  for (let i = 0; i < 20; i++) { waiting.store.wake(); await waiting.run(1000) }
  assert.equal(waiting.calls.length, 0, 'a wake reads nothing for an operation whose block the mark has not reached')
  assert.equal(waiting.asks.length, 0)
  const turn = harness()
  turn.store.record(input()); mark(turn)
  const due = turn.due()
  for (let i = 0; i < 20; i++) { turn.store.wake(); await turn.run(100) }
  assert.equal(turn.calls.length, 0, 'the index\'s turn is not cut short')
  assert.equal(turn.due(), due)
  const refused = harness({ answer: () => { throw Object.assign(new Error('confirmation_unavailable'), { retryAfterMs: 30_000 }) } })
  refused.store.record(input()); mark(refused); await refused.next()
  assert.equal(refused.calls.length, 1)
  const again = refused.due()
  assert.equal(again - refused.time(), 30_000)
  for (let i = 0; i < 20; i++) { refused.store.wake(); await refused.run(1000) }
  assert.equal(refused.calls.length, 1, 'a wake does not clear the wait a refusal named')
  assert.equal(refused.due(), again)
})

// Added 2026-10-14 (incident C2). A 502 with no Retry-After reached the queue as `retryAfterMs: 0` and brought the next
// read to 2 s, sooner than the 5 s it would have waited without the failure; and the reads went on for seven days.
test('a failed read backs off 5, 10, 20, 40, then 60 seconds, never sooner than 5 s, and at most ten more tries follow', async () => {
  const failures = [() => { throw Object.assign(new Error('confirmation_unavailable'), { retryAfterMs: 0 }) }, () => { throw new Error('node offline') },
    () => ({ transaction: null, receipt: null, block: null }), () => canonical({ receipt: { ...canonical().receipt, status: '0x0' } })]
  for (const failure of failures) {
    const at = []
    const h = harness({ answer: () => { at.push(h.time()); return failure() } })
    h.store.record(input({ onFinalized: async () => true })); mark(h)
    await h.run(60 * MINUTE)
    assert.deepEqual(at.slice(1).map((time, i) => time - at[i]), [5000, 10_000, 20_000, 40_000, 60_000, 60_000, 60_000, 60_000, 60_000, 60_000])
    assert.equal(h.store.get()[0].phase, 'included', 'an unread proof is never a rollback and never finality')
    mark(h, 9000); h.store.wake(); await h.run(24 * 60 * MINUTE)
    assert.equal(at.length, 11, 'the first read and ten more: a later mark, a wake or its age do not start them again')
    assert.equal(h.asks.length, 0)
    assert.equal(h.timers.size, 0, 'nothing is left scheduled')
  }
  const at = []
  const behind = harness({ answer: () => { at.push(behind.time()); return canonical() }, finalized: async () => ({ number: '0xf' }) })
  behind.store.record(input()); mark(behind); await behind.run(60 * MINUTE)
  assert.equal(at.length, 11, 'a finalized block still behind the mark is tried again on the same bounded steps')
  assert.deepEqual(at.slice(1, 4).map((time, i) => time - at[i]), [5000, 10_000, 20_000])
  assert.equal(behind.asks.length, 11, 'one finalized-block read per try')
  assert.equal(behind.timers.size, 0)
})

// Rewritten on purpose 2026-10-14 (incident C2). It held the defect's cadence: after a refusal the queue kept waking
// every 2 s and the case counted those empty passes. The wait a refusal names is still honoured for that hash while the
// other is read; now nothing runs before it, and a wake does not clear it.
test('receipt Retry-After is respected for that hash while other affected ids reconcile', async () => {
  let held = true
  const h = harness({ answer: hash => {
    if (hash === HASH && held) throw Object.assign(new Error('rate limited'), { retryAfterMs: 9000 })
    return canonical({ receipt: { ...canonical().receipt, transactionHash: hash } })
  } })
  h.store.record(input()); h.store.record(input({ tokenIds: ['2'], receipt: { ...input().receipt, transactionHash: OTHER } }))
  mark(h); await h.next(); assert.equal(h.calls.length, 2)
  assert.equal(h.store.finality(4663, OTHER, BLOCK_HASH), 'finalized')
  const refused = h.time()
  assert.equal(h.due() - refused, 9000, 'the next pass is the named wait away, not sooner')
  h.store.wake(); await h.run(8999); assert.equal(h.calls.length, 2)
  held = false; await h.next()
  assert.equal(h.time() - refused, 9000)
  assert.equal(h.store.finality(4663, HASH, BLOCK_HASH), 'finalized')
  assert.equal(h.timers.size, 0)
})

// Changed on purpose 2026-10-14 (incident C2): the read starts from the mark.
test('an in-flight old receipt cannot overwrite a newer checked inclusion or finalized state', async () => {
  let finish
  const h = harness({ answer: () => new Promise(resolve => { finish = resolve }) })
  h.store.record(input()); mark(h); await h.next()
  h.store.record(input({ receipt: { ...input().receipt, blockNumber: 17n, blockHash: OTHER, state: 'finalized' } }))
  finish(canonical({ block: { number: '0x10', hash: OTHER } })); await flush()
  assert.equal(h.store.get()[0].phase, 'finalized')
  assert.equal(h.store.get()[0].block, 17)
  assert.equal(h.store.get()[0].blockHash, OTHER)
})

// Changed on purpose 2026-10-14 (incident C2): the read starts from the mark.
test('an in-flight finality reply cannot finalize a superseded block and a delayed inclusion never downgrades finality', async () => {
  let finish
  const h = harness({ finalized: () => new Promise(resolve => { finish = resolve }) })
  h.store.record(input()); mark(h); await h.next()
  h.store.record(input({ receipt: { ...input().receipt, blockNumber: 17n, blockHash: OTHER } }))
  finish({ number: '0x100' }); await flush()
  assert.equal(h.store.get()[0].phase, 'included')
  assert.equal(h.store.get()[0].blockHash, OTHER)
  const final = h.store.record(input({ receipt: { ...input().receipt, state: 'finalized' } }))
  h.store.record(input())
  assert.equal(h.store.finality(4663, HASH, BLOCK_HASH), 'finalized')
  assert.equal(h.store.get()[0].at, final.at)
})

// Rewritten on purpose 2026-10-14 (incident C2). It read "expired": an included operation kept a pass scheduled for
// seven days and the case let them run out. Inclusion alone schedules nothing now, so there is nothing to expire.
test('other-chain operations start no unsupported reads, inclusion alone schedules nothing, and subscriptions stop cleanly', async () => {
  const h = harness(), observed = []
  const stop = h.store.subscribe(op => observed.push(op))
  h.store.record(input({ chainId: 8453 }))
  assert.equal(h.calls.length, 0)
  assert.equal(h.timers.size, 0, 'the Robinhood watcher never schedules unsupported chain reads')
  stop(); h.store.record(input()); assert.equal(observed.length, 1)
  assert.equal(h.timers.size, 0, 'no seven-day loop: without the mark there is no pass at all')
  h.advance(7 * 86400_000); h.store.wake(); await h.next()
  assert.equal(h.calls.length, 0)
  assert.equal(h.timers.size, 0)
})

test('other chains preserve their included evidence without starting a local finality or cleanup queue', async () => {
  const h = harness(); let attempts = 0
  for (const chainId of [8453, 42161]) h.store.record(input({ chainId, onFinalized: async () => { attempts++; return true } }))
  assert.equal(h.store.get().length, 2)
  assert.ok(h.store.get().every(operation => operation.phase === 'included'))
  assert.equal(h.calls.length, 0)
  assert.equal(h.timers.size, 0)
  h.store.wake(); await h.next()
  assert.equal(attempts, 0)
  assert.equal(h.calls.length, 0)
  assert.equal(h.timers.size, 0, 'a focus event does not add an unsupported chain reader')
  // Added 2026-10-14 (incident C2): their finalized mark reaches the queue too, and starts nothing there.
  h.store.noteChainFinality(8453, 4000); h.store.noteChainFinality(42161, 4000); h.advance(41 * MINUTE)
  assert.equal(h.timers.size, 0)
  assert.equal(h.calls.length, 0); assert.equal(h.asks.length, 0); assert.equal(attempts, 0)
})

test('a financial client can revoke only its exact recorded inclusion and adopt a checked reinclusion without public reads', () => {
  const h = harness(), events = []
  h.store.subscribe(operation => events.push(operation.phase))
  const scope = { chainId: 8453, wallet: WALLET, hash: HASH, blockHash: BLOCK_HASH }
  h.store.record(input({ chainId: 8453 }))
  h.store.record(input({ chainId: 42161 }))
  for (const wrong of [{ chainId: 4663 }, { wallet: `0x${'09'.repeat(20)}` }, { hash: OTHER }, { blockHash: OTHER }]) {
    assert.equal(h.store.reorg({ ...scope, ...wrong }), false)
  }
  assert.equal(h.store.reorg(scope), true)
  assert.equal(h.store.reorg(scope), false, 'the same contradiction publishes one rollback')
  assert.equal(h.store.finality(8453, HASH, BLOCK_HASH), 'reorged')
  assert.equal(h.store.finality(42161, HASH, BLOCK_HASH), 'included', 'the other chain is unaffected')
  h.store.record(input({ chainId: 8453, receipt: { ...input().receipt, blockHash: OTHER, blockNumber: 17n } }))
  assert.equal(h.store.finality(8453, HASH, OTHER), 'included')
  assert.equal(h.store.reorg(scope), false, 'a delayed contradiction cannot revoke a later block')
  assert.deepEqual(events, ['included', 'included', 'reorged', 'included'])
  assert.equal(h.calls.length, 0)
  assert.equal(h.timers.size, 0, 'no unsupported public RPC or cleanup queue is started')
})

// Changed on purpose 2026-10-14 (incident C2): the read starts from the mark. The settlement's rule is as it was: it
// is run only after the queue's own proof bound to the recorded block, and it survives the screen.
test('final settlement waits for canonical finality and survives the screen subscription ending', async () => {
  let canonicalReady = false, finalityReady = false, settled = 0
  const h = harness({ answer: () => canonicalReady ? canonical() : canonical({ block: null }),
    finalized: async () => finalityReady ? { number: '0x10' } : { number: '0xf' } })
  const observed = [], stop = h.store.subscribe(operation => observed.push(operation.phase))
  h.store.record(input({ onFinalized: async () => { settled++; return true } }))
  await h.run(10 * MINUTE)
  assert.equal(settled, 0, 'inclusion alone settles nothing')
  mark(h); await h.next()
  assert.equal(settled, 0, 'height without the matching canonical block cannot settle a financial journal')
  canonicalReady = true; await h.next()
  assert.equal(settled, 0, 'canonical inclusion without finality is insufficient')
  stop(); finalityReady = true; await h.next()
  assert.equal(h.store.get()[0].phase, 'finalized')
  await h.next()
  assert.equal(settled, 1, 'the shared callback survives the originating screen unmount')
  assert.deepEqual(observed, ['included'])
  assert.equal(h.timers.size, 0, 'a successful callback finishes the queue')
})

test('false and failed final settlements retry at least five seconds apart until their proof succeeds', async () => {
  const h = harness(), attempts = []
  h.store.record(input({ receipt: { ...input().receipt, state: 'finalized' }, onFinalized: async () => {
    attempts.push(h.time())
    if (attempts.length === 1) return false
    if (attempts.length === 2) throw new Error('the final read is unavailable')
    return true
  } }))
  for (let pass = 0; attempts.length < 3 && pass < 20; pass++) await h.next()
  assert.equal(attempts.length, 3)
  assert.ok(attempts[1] - attempts[0] >= 5000)
  assert.ok(attempts[2] - attempts[1] >= 5000)
  assert.equal(h.store.get()[0].phase, 'finalized', 'a journal read error never downgrades verified finality')
  assert.equal(h.timers.size, 0)
})

test('an unsuccessful final settlement stops after ten attempts without leaving a background timer', async () => {
  const h = harness(); let attempts = 0
  h.store.record(input({ receipt: { ...input().receipt, state: 'finalized' }, onFinalized: async () => { attempts++; return false } }))
  for (let pass = 0; h.timers.size && pass < 40; pass++) await h.next()
  assert.equal(attempts, 10)
  assert.equal(h.timers.size, 0, 'retry exhaustion releases scheduled work')
})

// Changed on purpose 2026-10-14 (incident C2): the read starts from the mark.
test('final settlement expires ten minutes after its first visible finality attempt', async () => {
  const h = harness(); let attempts = 0
  h.store.record(input({ onFinalized: async () => { attempts++; return false } }))
  mark(h); await h.next(); await h.next()
  assert.equal(h.store.get()[0].phase, 'finalized')
  assert.equal(attempts, 1)
  h.advance(600_000); await h.next()
  assert.equal(attempts, 1, 'the retry window ends even if fewer than ten attempts were possible')
  assert.equal(h.timers.size, 0, 'an expired finalized settlement leaves no perpetual scheduler')
})

// Changed on purpose 2026-10-14 (incident C2): the read starts from the mark.
test('late finality and a hidden screen do not consume the first final settlement attempt', async () => {
  let finalityReady = false, attempts = 0
  const h = harness({ finalized: async () => finalityReady ? { number: '0x10' } : null })
  h.store.record(input({ onFinalized: async () => { attempts++; return true } }))
  mark(h); await h.next(); h.advance(700_000); finalityReady = true; await h.next()
  assert.equal(h.store.get()[0].phase, 'finalized', 'finality can legitimately arrive more than ten minutes after inclusion')
  assert.equal(attempts, 0)
  h.hide(); h.advance(700_000); await h.next()
  assert.equal(attempts, 0, 'background time before the first visible callback is not its retry window')
  h.show(); h.store.wake(); await h.next()
  assert.equal(attempts, 1)
  assert.equal(h.timers.size, 0)
})

test('an included operation and its unstarted settlement expire together after seven days', async () => {
  const h = harness({ finalized: async () => null }); let attempts = 0
  h.store.record(input({ onFinalized: async () => { attempts++; return true } }))
  h.advance(7 * 86400_000); await h.next()
  assert.equal(attempts, 0)
  assert.equal(h.calls.length, 0)
  assert.equal(h.timers.size, 0, 'expired inclusion and settlement leave no perpetual scheduler')
  h.store.record(input({ receipt: { ...input().receipt, state: 'finalized' } })); h.store.wake(); await h.next()
  assert.equal(attempts, 0, 'an expired callback cannot revive with a late checked proof')
})

// Added 2026-10-14 (incident C2). read-v6's indexer keeps its last finalized mark silently when its own read fails
// (backend/v2_indexer.py), and the field may be null. A money journal must not wait on it for ever, so the fallback is
// keyed on the operation's age, not on the chain's status: one finalized-block question a minute, for everything waiting.
test('with the mark frozen, an operation that holds a settlement asks the finalized block from forty minutes old, at most once a minute', async () => {
  let final = '0xf', settled = 0
  const h = harness({ answer: hash => canonical({ receipt: { ...canonical().receipt, transactionHash: hash } }), finalized: async () => ({ number: final }) })
  const start = h.time()
  h.store.record(input({ onFinalized: async () => { settled++; return true } }))
  h.store.record(input({ tokenIds: ['2'], receipt: { ...input().receipt, transactionHash: OTHER }, onFinalized: async () => { settled++; return true } }))
  mark(h, 15)
  await h.run(40 * MINUTE - 1)
  assert.equal(h.asks.length, 0, 'not before it is forty minutes old')
  assert.equal(h.calls.length, 0)
  await h.run(19 * MINUTE + 30_001)
  assert.equal(h.asks[0] - start, 40 * MINUTE)
  assert.equal(h.asks.length, 20, 'two waiting operations share one question a minute')
  assert.ok(h.asks.every((at, i) => i === 0 || at - h.asks[i - 1] >= MINUTE))
  assert.equal(h.calls.length, 0, 'no receipt is read while the finalized block is behind')
  for (let i = 0; i < 20; i++) { h.store.wake(); await h.run(100) }
  assert.equal(h.asks.length, 20, 'a wake does not ask sooner')
  final = '0x10'; await h.next()
  assert.equal(h.time() - start, 60 * MINUTE)
  assert.equal(h.asks.length, 21, 'the same answer serves the receipts read in that pass')
  assert.deepEqual(h.calls, [HASH, OTHER], 'then one receipt read each, bound to its block')
  assert.ok(h.store.get().every(op => op.phase === 'finalized'))
  await h.next()
  assert.equal(settled, 2)
  assert.equal(h.timers.size, 0)
})

test('the frozen-mark fallback is for money journals only, slows on a refusal and ends after a day', async () => {
  const plain = harness({ finalized: async () => ({ number: '0xf' }) })
  plain.store.record(input()); mark(plain, 15)
  assert.equal(plain.timers.size, 0)
  await plain.run(3 * 60 * MINUTE)
  assert.equal(plain.asks.length, 0, 'an operation with nothing to release waits for the index or the mark, and asks nothing')
  const down = harness({ finalized: async () => { throw Object.assign(new Error('confirmation_unavailable'), { retryAfterMs: 0 }) } })
  down.store.record(input({ onFinalized: async () => true }))
  await down.run(50 * MINUTE)
  assert.ok(down.asks.length > 0 && down.asks.length <= 11)
  assert.ok(down.asks.every((at, i) => i === 0 || at - down.asks[i - 1] >= MINUTE), 'a failed question is not asked again sooner')
  assert.equal(down.calls.length, 0)
  const stuck = harness({ finalized: async () => ({ number: '0xf' }) }); let settled = 0
  const start = stuck.time()
  stuck.store.record(input({ onFinalized: async () => { settled++; return true } }))
  await stuck.run(30 * 60 * MINUTE)
  assert.ok(stuck.asks.at(-1) - start < 24 * 60 * MINUTE, 'the questions end a day after inclusion')
  assert.ok(stuck.asks.length <= 24 * 60 - 40)
  assert.equal(stuck.timers.size, 0, 'and leave nothing scheduled')
  assert.equal(stuck.calls.length, 0); assert.equal(settled, 0)
  stuck.store.record(indexed({ state: 'finalized' })); await stuck.next()
  assert.equal(settled, 1, 'the index may still complete it, and its journal is then released by its own proof')
})

// Changed on purpose 2026-10-14 (incident C2): the read starts from the mark.
test('a proven reorg cancels final settlement and no hidden screen runs settlement work', async () => {
  let attempts = 0
  const reorg = harness({ answer: () => canonical({ block: { number: '0x10', hash: OTHER } }) })
  reorg.store.record(input({ onFinalized: async () => { attempts++; return true } })); mark(reorg); await reorg.next()
  assert.equal(reorg.store.get()[0].phase, 'reorged')
  assert.equal(attempts, 0)
  assert.equal(reorg.timers.size, 0)
  const hidden = harness()
  hidden.store.record(input({ receipt: { ...input().receipt, state: 'finalized' }, onFinalized: async () => { attempts++; return true } }))
  hidden.hide(); await hidden.next()
  assert.equal(attempts, 0)
  hidden.show(); hidden.store.wake(); await hidden.next()
  assert.equal(attempts, 1)
  assert.equal(hidden.timers.size, 0)
})

test('final settlements share the sixty-four operation bound and run at most two callbacks per pass', async () => {
  const h = harness(), settled = []
  for (let i = 0; i < 70; i++) {
    const hash = `0x${i.toString(16).padStart(64, '0')}`
    h.store.record(input({ receipt: { ...input().receipt, transactionHash: hash, state: 'finalized' },
      onFinalized: async () => { settled.push(i); return true } }))
  }
  await h.next()
  assert.equal(settled.length, 2)
  assert.deepEqual(settled, [6, 7], 'evicted operations also release their callbacks')
  while (h.timers.size) await h.next()
  assert.deepEqual(settled, Array.from({ length: 64 }, (_, i) => i + 6))
  assert.equal(h.calls.length, 0, 'preverified finality does not trigger redundant receipt reads')
})

test('an in-flight settlement cannot remove a replacement callback for the same checked operation', async () => {
  const h = harness(); let finish, replacements = 0
  h.store.record(input({ receipt: { ...input().receipt, state: 'finalized' },
    onFinalized: () => new Promise(resolve => { finish = resolve }) }))
  await h.next()
  assert.equal(typeof finish, 'function')
  h.store.record(input({ receipt: { ...input().receipt, state: 'finalized' },
    onFinalized: async () => { replacements++; return true } }))
  finish(true); await flush(); await h.next()
  assert.equal(replacements, 1, 'the old completion cannot consume newer settlement work')
  assert.equal(h.timers.size, 0)
})

// ---------------------------------------------------------------------------------------------------------------------
// Added 2026-10-15 (pack 8, incident C5: no chain literal on the receipt path). The C2 tables above, on Robinhood Chain,
// Base and Arbitrum One. One table per chain (src/config/receiptSources.ts) says who makes the one read at finality: the
// queue's own read at the site's edge on Robinhood Chain; on Base and Arbitrum One the money client's own read through
// the person's wallet, judged by that client's own check. Base and Arbitrum One read their receipts through a follow of
// their own until final (v2in/journey/receiptFollow.ts, every 5 s, then 15 s, then 30 s, up to 80 reads an hour); here
// they read on the same rules as Robinhood Chain: nothing by the clock, one read when the mark (or, with none, the
// chain's age) says the block may be final. On a wallet chain the read below is the REAL money client
// (finance/v2/transact.ts receipt) over a fake wallet answering the same fixed answers, and the check is the REAL one
// automation's steps hand in (v2in/automate/receipt.ts); `calls` counts its receipt reads, `asks` its finalized-block
// reads, `wallet` every request the wallet saw.
// ---------------------------------------------------------------------------------------------------------------------
const { createTransactor } = require('../.test-build/app/src/finance/v2/transact.js')
const { v2Chain } = require('../.test-build/app/src/v2/chains.js')
const { reconcileAutomationReceipt } = require('../.test-build/app/src/v2in/automate/receipt.js')
const CHAINS = [4663, 8453, 42161]
const TO = `0x${'0d'.repeat(20)}`
const hex = n => `0x${n.toString(16)}`
const byWallet = chainId => chainId !== 4663
function chainHarness(chainId, { answer = () => canonical(), finalized = async () => ({ number: '0x10' }) } = {}) {
  const h = harness({ answer, finalized })
  const wallet = [], state = { available: 'ready' }
  let last = null
  const fake = { owner: WALLET, current: () => true, chainId: () => chainId, signatures: {},
    async request(method, params) {
      wallet.push(method)
      if (method === 'eth_accounts') return [WALLET]
      if (method === 'eth_chainId') return hex(chainId)
      if (method === 'eth_getTransactionByHash') {
        h.calls.push(params[0])
        last = await answer(params[0])
        return last.transaction === null ? null : { hash: params[0], from: WALLET, to: TO, input: '0x', value: '0x0', nonce: '0x1' }
      }
      if (method === 'eth_getTransactionReceipt') return last.receipt && { gasUsed: '0x5208', effectiveGasPrice: '0x1', logs: [], ...last.receipt }
      if (method === 'eth_getBlockByNumber' && params[0] === 'finalized') { h.asks.push(h.time()); return finalized() }
      if (method === 'eth_getBlockByNumber') return last.block
      throw new Error(`unexpected ${method}`)
    } }
  const client = createTransactor(fake, v2Chain(chainId), () => 1000)
  /** An own operation, as its money client records it: on a wallet chain with its own read and check (`follow`). */
  const own = (extra = {}) => {
    const value = input({ chainId, ...extra })
    if (!byWallet(chainId)) return h.store.record(value)
    let op = null
    op = h.store.record({ ...value, follow: {
      read: () => client.receipt(value.receipt.transactionHash, { from: WALLET, to: TO, data: '0x', value: '0x0', nonce: '0x1', chainId: hex(chainId) }),
      available: () => state.available,
      accept: next => reconcileAutomationReceipt(op, next, h.store.record, h.store.reorg, h.store.get().find(item => item.chainId === op.chainId && item.hash === op.hash) ?? null),
    } })
    return op
  }
  return { ...h, chainId, wallet, state, own, client, mark: (block = 16) => h.store.noteChainFinality(chainId, block) }
}

for (const chainId of CHAINS) {
  test(`[${chainId}] an own included operation makes zero reads until the finalized mark reaches its block, then one receipt read and one finality read`, async () => {
    const h = chainHarness(chainId)
    h.own()
    await h.run(5 * MINUTE)
    assert.equal(h.calls.length, 0, 'no read by the clock')
    h.mark(15); h.store.noteChainFinality(chainId === 4663 ? 8453 : 4663, 1000); h.mark(Number.NaN); h.mark(-1)
    await h.run(5 * MINUTE)
    assert.equal(h.calls.length, 0, 'a mark below its block, another chain\'s mark and a malformed mark start nothing')
    assert.equal(h.asks.length, 0)
    h.mark(16)
    assert.equal(h.store.get()[0].phase, 'included', 'the mark is a hint: it finalizes nothing by itself')
    await h.run(5 * MINUTE)
    assert.equal(h.store.get()[0].phase, 'finalized')
    assert.equal(h.calls.length, 1, 'one receipt read, bound to the recorded block')
    assert.equal(h.asks.length, 1, 'one finalized-block read')
    h.mark(5000); h.store.wake(); await h.run(60 * MINUTE)
    assert.equal(h.calls.length, 1); assert.equal(h.asks.length, 1)
    assert.equal(h.timers.size, 0, 'a final operation leaves nothing scheduled')
    if (byWallet(chainId)) assert.deepEqual(h.wallet, ['eth_accounts', 'eth_chainId', 'eth_getTransactionByHash', 'eth_getTransactionReceipt', 'eth_getBlockByNumber', 'eth_getBlockByNumber'], 'six wallet calls in all, at finality')
  })

  test(`[${chainId}] an operation recorded after the mark already passed its block is read once too, never at once`, async () => {
    const h = chainHarness(chainId)
    h.mark(4000)
    h.own()
    assert.equal(h.calls.length, 0)
    assert.ok(h.due() - h.time() >= 5000, 'the index is given its turn first')
    await h.run(10 * MINUTE)
    assert.equal(h.store.get()[0].phase, 'finalized')
    assert.equal(h.calls.length, 1); assert.equal(h.asks.length, 1)
  })

  test(`[${chainId}] an indexed finalized item of the same transaction and block finalizes an own operation with no queue read`, async () => {
    const h = chainHarness(chainId)
    const own = h.own()
    await h.run(5 * MINUTE)
    h.mark()
    h.store.record({ ...indexed({ blockHash: OTHER, state: 'finalized' }), chainId })
    assert.equal(h.store.get()[0].phase, 'included', 'another block\'s item proves nothing about this inclusion')
    h.store.record({ ...indexed({ state: 'finalized' }), chainId })
    assert.deepEqual(h.store.get()[0], { ...own, phase: 'finalized' })
    await h.run(60 * MINUTE)
    // Changed on purpose (2026-10-15, pack 8 review): on a wallet chain the money client's own read is also its release at
    // finality, so it is made once after read-v6's item (the test below); on Robinhood Chain the queue reads nothing.
    assert.equal(h.calls.length, byWallet(chainId) ? 1 : 0, "no queue read; on a wallet chain the client's one read")
    assert.equal(h.asks.length, byWallet(chainId) ? 1 : 0)
    if (!byWallet(chainId)) assert.equal(h.wallet.length, 0, 'nor asked the wallet anything')
    assert.equal(h.timers.size, 0)
  })

  test(`[${chainId}] a different canonical block at the one read at finality is a reorganised operation, and nothing more is asked`, async () => {
    const h = chainHarness(chainId, { answer: () => canonical({ block: { number: '0x10', hash: OTHER } }) })
    const published = []
    h.own()
    h.store.subscribe(op => published.push(op.phase))
    await h.run(5 * MINUTE)
    assert.equal(h.calls.length, 0, 'not read before the mark')
    h.mark(); await h.run(60 * MINUTE)
    assert.equal(h.calls.length, 1)
    assert.equal(h.store.get()[0].phase, 'reorged')
    assert.deepEqual(published, ['reorged'])
    assert.equal(h.asks.length, 0, 'a contradicted block needs no finality')
    assert.equal(h.timers.size, 0)
  })

  test(`[${chainId}] a transaction found in another block at that read is not adopted: the operation is reorganised for its client to check again`, async () => {
    const h = chainHarness(chainId, { answer: () => canonical({ receipt: { ...canonical().receipt, blockNumber: '0x11', blockHash: OTHER }, block: { number: '0x11', hash: OTHER } }) })
    h.own(); h.mark(); await h.run(10 * MINUTE)
    assert.equal(h.calls.length, 1)
    assert.equal(h.store.get()[0].phase, 'reorged')
    assert.equal(h.store.get()[0].blockHash, BLOCK_HASH, 'a watcher cannot adopt a new effect by itself')
  })

  test(`[${chainId}] missing or unavailable data keeps inclusion; finalized height alone proves nothing`, async () => {
    for (const answer of [() => ({ transaction: null, receipt: null, block: null }), () => canonical({ receipt: null, block: null }), () => canonical({ block: null }), () => { throw new Error('node offline') }]) {
      const h = chainHarness(chainId, { answer, finalized: async () => ({ number: '0x100' }) })
      h.own(); h.mark(0x100); await h.next()
      assert.equal(h.calls.length, 1)
      assert.equal(h.store.get()[0].phase, 'included')
      assert.equal(h.asks.length, 0)
      assert.equal(h.published.length, 1, 'no false rollback or finality publication')
    }
  })

  test(`[${chainId}] canonical inclusion is kept while finality is missing, behind or failed, and final only when both agree`, async () => {
    for (const finalized of [async () => null, async () => ({ number: '0xf' }), async () => { throw new Error('finality unavailable') }]) {
      const h = chainHarness(chainId, { finalized }); h.own(); h.mark(); await h.next()
      assert.equal(h.store.get()[0].phase, 'included')
    }
    const h = chainHarness(chainId); h.own(); h.mark(); await h.next()
    assert.equal(h.store.get()[0].phase, 'finalized')
    assert.equal(h.store.finality(chainId, HASH, OTHER), null, 'finality belongs to this exact block hash')
  })

  test(`[${chainId}] a failed read backs off 5, 10, 20, 40, then 60 seconds, and at most ten more tries follow`, async () => {
    for (const failure of [() => { throw Object.assign(new Error('confirmation_unavailable'), { retryAfterMs: 0 }) }, () => { throw new Error('node offline') }, () => ({ transaction: null, receipt: null, block: null })]) {
      const at = []
      const h = chainHarness(chainId, { answer: () => { at.push(h.time()); return failure() } })
      h.own(); h.mark()
      await h.run(60 * MINUTE)
      assert.deepEqual(at.slice(1).map((time, i) => time - at[i]), [5000, 10_000, 20_000, 40_000, 60_000, 60_000, 60_000, 60_000, 60_000, 60_000])
      assert.equal(h.store.get()[0].phase, 'included', 'an unread proof is never a rollback and never finality')
      h.mark(9000); h.store.wake(); await h.run(24 * 60 * MINUTE)
      assert.equal(at.length, 11, 'the first read and ten more: a later mark, a wake or its age do not start them again')
      assert.equal(h.timers.size, 0, 'nothing is left scheduled')
    }
  })

  test(`[${chainId}] twenty focus events make zero reads and bring no wait closer; a named wait is kept`, async () => {
    const turn = chainHarness(chainId)
    turn.own(); turn.mark()
    const due = turn.due()
    for (let i = 0; i < 20; i++) { turn.store.wake(); await turn.run(100) }
    assert.equal(turn.calls.length, 0, 'the index\'s turn is not cut short')
    assert.equal(turn.due(), due)
    const refused = chainHarness(chainId, { answer: () => { throw Object.assign(new Error('confirmation_unavailable'), { retryAfterMs: 30_000 }) } })
    refused.own(); refused.mark(); await refused.next()
    assert.equal(refused.calls.length, 1)
    const again = refused.due()
    assert.equal(again - refused.time(), 30_000)
    for (let i = 0; i < 20; i++) { refused.store.wake(); await refused.run(1000) }
    assert.equal(refused.calls.length, 1, 'a wake does not clear the wait a refusal named')
  })

  test(`[${chainId}] the queue pauses hidden, serializes its reads and limits a pass to four`, async () => {
    const h = chainHarness(chainId, { answer: hash => canonical({ receipt: { ...canonical().receipt, transactionHash: hash } }) })
    for (let i = 0; i < 6; i++) h.own({ tokenIds: [String(i)], receipt: { ...input().receipt, transactionHash: `0x${i.toString(16).padStart(64, '0')}` } })
    h.mark()
    h.hide(); await h.next(); assert.equal(h.calls.length, 0)
    h.show(); h.store.wake(); await h.next()
    assert.equal(h.calls.length, 4)
    assert.equal(h.store.get().filter(op => op.phase === 'included').length, 2)
    await h.next(); assert.equal(h.calls.length, 6)
    assert.equal(h.store.get().filter(op => op.phase === 'included').length, 0)
    assert.equal(h.timers.size, 0)
  })
}

// Added 2026-10-15 (pack 8, incident C5). read-v6 names no finalized mark for a chain it does not index (Base and
// Arbitrum One today: `finalizedThrough` null), so on those chains the age is what says the block may be final: the
// money client's own read is made once the operation is twenty minutes old; "not final yet" is read again a minute
// later, then two, four, eight, then every fifteen, ten more times at most. The follow it replaces read about fifty
// times in the same twenty minutes.
for (const chainId of [8453, 42161]) {
  test(`[${chainId}] with no mark, the money client's own read is made once the operation is twenty minutes old, then a minute apart at least, growing`, async () => {
    let final = '0xf'
    const h = chainHarness(chainId, { finalized: async () => ({ number: final }) })
    const start = h.time()
    h.own()
    await h.run(20 * MINUTE - 1)
    assert.equal(h.calls.length, 0, 'not before it is twenty minutes old')
    await h.run(1)
    assert.deepEqual(h.asks.map(at => at - start), [20 * MINUTE], 'one read at twenty minutes')
    await h.run(7 * MINUTE)
    assert.deepEqual(h.asks.map(at => at - start), [20, 21, 23, 27].map(m => m * MINUTE), 'then a minute, two, four, eight apart')
    assert.equal(h.store.get()[0].phase, 'included')
    for (let i = 0; i < 20; i++) { h.store.wake(); await h.run(100) }
    assert.equal(h.calls.length, 4, 'a wake does not read sooner')
    final = '0x10'
    await h.run(60 * MINUTE)
    assert.equal(h.store.get()[0].phase, 'finalized')
    assert.equal(h.calls.length, 5)
    assert.equal(h.timers.size, 0)
    const stuck = chainHarness(chainId, { finalized: async () => ({ number: '0xf' }) })
    stuck.own(); await stuck.run(3 * 24 * 60 * MINUTE)
    assert.equal(stuck.calls.length, 11, 'never more than the first read and ten more')
    assert.equal(stuck.timers.size, 0, 'and nothing is left scheduled')
  })

  test(`[${chainId}] a wallet on another account or network is not asked, spends no try, and is read once it is back`, async () => {
    const h = chainHarness(chainId)
    h.state.available = 'paused'
    h.own(); h.mark()
    await h.run(3 * 60 * MINUTE)
    assert.equal(h.wallet.length, 0, 'nothing asked of a wallet elsewhere')
    h.state.available = 'gone'
    await h.run(MINUTE)
    assert.equal(h.wallet.length, 0)
    h.state.available = 'ready'
    await h.run(MINUTE)
    assert.equal(h.store.get()[0].phase, 'finalized')
    assert.equal(h.calls.length, 1)
    assert.equal(h.timers.size, 0)
  })

  test(`[${chainId}] an own operation recorded with no read of its own (no follow) starts nothing, as before`, async () => {
    const h = chainHarness(chainId); let settled = 0
    h.store.record(input({ chainId, onFinalized: async () => { settled++; return true } }))
    h.mark(); await h.run(3 * 60 * MINUTE)
    assert.equal(h.calls.length, 0); assert.equal(h.wallet.length, 0); assert.equal(settled, 0)
    assert.equal(h.timers.size, 0)
  })
}

// Added (2026-10-15, pack 8 review, M1): on Base and Arbitrum One the money client's own read at finality (`follow`) is
// also its release (finance/v2/vault.ts and autoExit.ts `receipt`: a finalized step's hand-over released, a used nonce's
// signature forgotten). When read-v6's item made the operation final first, that read was dropped with the follow and
// the release never came. It is now made once, on the next pass, and judged by the client's own check.
/** The client's read as vault.ts and autoExit.ts make it: a final answer releases the step. */
function releasing(h, chainId = h.chainId) {
  const state = { reads: 0, released: 0 }
  let op = null
  op = h.store.record({ ...input({ chainId }), follow: {
    read: async () => { state.reads++; const next = await h.client.receipt(HASH, { from: WALLET, to: TO, data: '0x', value: '0x0', nonce: '0x1', chainId: hex(chainId) }); if (next.state === 'finalized') state.released++; return next },
    available: () => h.state.available,
    accept: next => reconcileAutomationReceipt(op, next, h.store.record, h.store.reorg, h.store.get().find(item => item.chainId === op.chainId && item.hash === op.hash) ?? null),
  } })
  return state
}

for (const chainId of [8453, 42161]) {
  test(`[${chainId}] an own operation final by read-v6's item first still gets the money client's one read at finality, and its release`, async () => {
    const h = chainHarness(chainId)
    const client = releasing(h)
    h.mark()
    h.store.record({ ...indexed({ state: 'finalized' }), chainId })
    assert.equal(h.store.get()[0].phase, 'finalized')
    await h.run(60 * MINUTE)
    assert.equal(client.reads, 1, "the money client's receipt read runs exactly once")
    assert.equal(client.released, 1, 'and the release at finality happens')
    assert.equal(h.store.get()[0].phase, 'finalized')
    h.mark(5000); h.store.wake(); await h.run(24 * 60 * MINUTE)
    assert.equal(client.reads, 1, 'never read again'); assert.equal(h.timers.size, 0)
  })

  test(`[${chainId}] that read waits for a wallet elsewhere, is dropped with a wallet gone, and is not made when the follow's own read already ended`, async () => {
    const paused = chainHarness(chainId), waited = releasing(paused)
    paused.state.available = 'paused'
    paused.mark(); paused.store.record({ ...indexed({ state: 'finalized' }), chainId })
    await paused.run(30 * MINUTE)
    assert.equal(waited.reads, 0, 'a wallet on another account or network is not asked')
    paused.state.available = 'ready'
    await paused.run(MINUTE)
    assert.equal(waited.reads, 1); assert.equal(waited.released, 1)
    const gone = chainHarness(chainId), dropped = releasing(gone)
    gone.state.available = 'gone'
    gone.mark(); gone.store.record({ ...indexed({ state: 'finalized' }), chainId })
    await gone.run(60 * MINUTE)
    assert.equal(dropped.reads, 0); assert.equal(gone.timers.size, 0)
    const ended = chainHarness(chainId), own = releasing(ended)
    ended.mark(); await ended.run(10 * MINUTE)
    assert.equal(own.reads, 1, "the follow's own read, at the mark")
    ended.store.record({ ...indexed({ state: 'finalized' }), chainId })
    await ended.run(60 * MINUTE)
    assert.equal(own.reads, 1, 'the index after it adds no read'); assert.equal(own.released, 1)
  })

  test(`[${chainId}] the index finalizing an operation while its follow's read is in flight takes that answer: one read, one release`, async () => {
    let release = null
    const h = chainHarness(chainId, { answer: () => new Promise(resolve => { release = () => resolve(canonical()) }) })
    const client = releasing(h)
    h.mark(); await h.run(INDEX_WAIT)
    assert.equal(client.reads, 1)
    h.store.record({ ...indexed({ state: 'finalized' }), chainId })
    release(); await flush()
    await h.run(60 * MINUTE)
    assert.equal(client.reads, 1); assert.equal(client.released, 1)
    assert.equal(h.timers.size, 0)
  })
}

// (2026-10-15, pack 8 review, M1 follow-up): the wallet's node may lag read-v6's mark. Its "not final yet" is read again
// on the wallet chains' own steps (1, 2, 4, 8, then every 15 minutes, ten more times at most) until it says final; the
// release then happens once, and nothing is read after it.
for (const chainId of [8453, 42161]) {
  test(`[${chainId}] a "not final yet" from the wallet after read-v6's item is read again on its steps, and the release happens once`, async () => {
    let final = '0xf'
    const h = chainHarness(chainId, { finalized: async () => ({ number: final }) })
    const state = { reads: [], released: 0 }
    let op = null
    op = h.store.record({ ...input({ chainId }), follow: {
      read: async () => { state.reads.push(h.time()); const next = await h.client.receipt(HASH, { from: WALLET, to: TO, data: '0x', value: '0x0', nonce: '0x1', chainId: hex(chainId) }); if (next.state === 'finalized') state.released++; return next },
      available: () => h.state.available,
      accept: next => reconcileAutomationReceipt(op, next, h.store.record, h.store.reorg, h.store.get().find(item => item.chainId === op.chainId && item.hash === op.hash) ?? null),
    } })
    h.mark()
    h.store.record({ ...indexed({ state: 'finalized' }), chainId })
    await h.run(MINUTE / 2)
    assert.equal(state.reads.length, 1, 'the one read, on the next pass')
    assert.equal(state.released, 0, 'the wallet says not final yet: nothing released')
    await h.run(3 * MINUTE)
    assert.deepEqual(state.reads.slice(1).map((at, i) => at - state.reads[i]), [MINUTE, 2 * MINUTE], 'again a minute later, then two')
    h.state.available = 'paused'
    await h.run(30 * MINUTE)
    assert.equal(state.reads.length, 3, 'a wallet elsewhere is not asked, and spends no try')
    h.state.available = 'ready'
    final = '0x10'
    await h.run(MINUTE)
    assert.equal(state.reads.length, 4); assert.equal(state.released, 1, 'final: released once')
    await h.run(24 * 60 * MINUTE)
    assert.equal(state.reads.length, 4, 'no read after the final one'); assert.equal(h.timers.size, 0)
    // Never final: the first read and ten more, then nothing; a wallet gone drops it at once.
    const stuck = chainHarness(chainId, { finalized: async () => ({ number: '0xf' }) }), lagging = releasing(stuck)
    stuck.mark(); stuck.store.record({ ...indexed({ state: 'finalized' }), chainId })
    await stuck.run(3 * 24 * 60 * MINUTE)
    assert.equal(lagging.reads, 11); assert.equal(lagging.released, 0); assert.equal(stuck.timers.size, 0)
  })
}
