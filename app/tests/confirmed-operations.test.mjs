/** The shared canonical watcher is exercised with a fake clock and fixed public reads, never a wallet. */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import test from 'node:test'
const require = createRequire(import.meta.url)
const HASH = `0x${'ab'.repeat(32)}`, BLOCK_HASH = `0x${'cd'.repeat(32)}`, OTHER = `0x${'ef'.repeat(32)}`, WALLET = `0x${'01'.repeat(20)}`
const flush = async () => { for (let i = 0; i < 4; i++) await new Promise(resolve => setImmediate(resolve)) }
function factory() {
  const ts = require('typescript'), mod = { exports: {} }
  const code = ts.transpileModule(readFileSync(new URL('../src/lib/confirmedOperations.ts', import.meta.url), 'utf8'),
    { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
  new Function('require', 'module', 'exports', code)(() => ({ confirmationReads: {}, notePositionConfirmation() {} }), mod, mod.exports)
  return mod.exports.createConfirmedOperations
}
const create = factory()
function harness({ answer = () => canonical(), finalized = async () => ({ number: '0x10' }) } = {}) {
  let now = 1000, visible = true
  const timers = new Set(), calls = [], published = []
  const read = { read: async hash => { calls.push(hash); return answer(hash) }, finalized }
  const clock = { now: () => now, visible: () => visible,
    set: (run, ms) => { const timer = { run, at: now + ms }; timers.add(timer); return timer }, clear: timer => timers.delete(timer) }
  const store = create(read, clock, op => published.push(op))
  return { store, calls, published, timers, time: () => now, hide: () => { visible = false }, show: () => { visible = true }, advance: ms => { now += ms },
    async next() { const timer = [...timers].sort((a, b) => a.at - b.at)[0]; assert.ok(timer, 'a pass is scheduled'); timers.delete(timer); now = Math.max(now, timer.at); timer.run(); await flush() } }
}
const input = (extra = {}) => ({ chainId: 4663, wallet: WALLET, tokenIds: ['3659830'], positionManager: `0x${'02'.repeat(20)}`,
  receipt: { transactionHash: HASH, blockHash: BLOCK_HASH, blockNumber: 16n, state: 'included' }, ...extra })
const canonical = (extra = {}) => ({ transaction: {}, receipt: { transactionHash: HASH, from: WALLET, blockHash: BLOCK_HASH, blockNumber: '0x10', status: '0x1' },
  block: { number: '0x10', hash: BLOCK_HASH }, ...extra })

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

test('missing, lagging and unavailable data keep inclusion; finalized height alone proves nothing', async () => {
  for (const answer of [() => ({ transaction: null, receipt: null, block: null }), () => canonical({ block: null }),
    () => canonical({ block: { number: '0xf', hash: BLOCK_HASH } }), () => { throw new Error('node offline') }]) {
    let finalizedCalls = 0
    const h = harness({ answer, finalized: async () => { finalizedCalls++; return { number: '0x100' } } })
    h.store.record(input()); await h.next()
    assert.equal(h.store.get()[0].phase, 'included')
    assert.equal(finalizedCalls, 0)
    assert.equal(h.published.length, 1, 'no false rollback or finality publication')
  }
})

test('an unrelated receipt cannot roll back the tracked operation; a contradictory canonical proof can', async () => {
  for (const receiptPatch of [{ transactionHash: OTHER }]) {
    const h = harness({ answer: () => canonical({ receipt: { ...canonical().receipt, ...receiptPatch }, block: { number: '0x10', hash: OTHER } }) })
    h.store.record(input()); await h.next()
    assert.equal(h.store.get()[0].phase, 'included')
  }
  const reorg = harness({ answer: () => canonical({ block: { number: '0x10', hash: OTHER } }) })
  reorg.store.record(input()); await reorg.next()
  assert.equal(reorg.store.get()[0].phase, 'reorged')
  assert.equal(reorg.store.finality(4663, HASH, BLOCK_HASH), 'reorged')
  const moved = harness({ answer: () => canonical({ receipt: { ...canonical().receipt, blockNumber: '0x11', blockHash: OTHER }, block: { number: '0x11', hash: OTHER } }) })
  moved.store.record(input()); await moved.next()
  assert.equal(moved.store.get()[0].phase, 'reorged', 'a different inclusion waits for the financial client to verify its effects')
  assert.equal(moved.store.get()[0].blockHash, BLOCK_HASH, 'a watcher cannot adopt a new effect by itself')
})

test('canonical inclusion is retained if finality is missing, behind or failed, and finalized only when both agree', async () => {
  for (const finalized of [async () => null, async () => ({ number: '0xf' }), async () => { throw new Error('finality unavailable') }]) {
    const h = harness({ finalized }); h.store.record(input()); await h.next()
    assert.equal(h.store.get()[0].phase, 'included')
  }
  const h = harness(); h.store.record(input()); await h.next()
  assert.equal(h.store.get()[0].phase, 'finalized')
  assert.equal(h.published.at(-1).phase, 'finalized')
  assert.equal(h.store.finality(4663, HASH, OTHER), null, 'finality belongs to this exact block hash')
  assert.equal(h.store.finality(8453, HASH, BLOCK_HASH), null, 'chain is part of the identity')
})

test('an already checked AA receipt finalizes with its canonical hash even when its payer differs from the wallet', async () => {
  const h = harness({ answer: () => canonical({ receipt: { ...canonical().receipt, from: `0x${'03'.repeat(20)}` } }) })
  h.store.record(input()); await h.next()
  assert.equal(h.store.get()[0].phase, 'finalized')
  assert.equal(h.store.get()[0].wallet, WALLET, 'the recorded authority stays the wallet whose effects were checked')
})

test('the watcher pauses hidden, wakes on visibility/focus, serializes reads and limits a pass to four', async () => {
  const h = harness({ answer: hash => canonical({ receipt: { ...canonical().receipt, transactionHash: hash } }) })
  for (let i = 0; i < 6; i++) h.store.record(input({ tokenIds: [String(i)], receipt: { ...input().receipt, transactionHash: `0x${i.toString(16).padStart(64, '0')}` } }))
  h.hide(); await h.next(); assert.equal(h.calls.length, 0)
  h.show(); h.store.wake(); await h.next()
  assert.equal(h.calls.length, 4)
  assert.equal(h.store.get().filter(op => op.phase === 'included').length, 2)
  await h.next(); assert.equal(h.calls.length, 6)
  assert.equal(h.store.get().filter(op => op.phase === 'included').length, 0)
  assert.equal(h.timers.size, 0)
})

test('receipt Retry-After is respected for that hash while other affected ids reconcile', async () => {
  let held = true
  const h = harness({ answer: hash => {
    if (hash === HASH && held) throw Object.assign(new Error('rate limited'), { retryAfterMs: 9000 })
    return canonical({ receipt: { ...canonical().receipt, transactionHash: hash } })
  } })
  h.store.record(input()); h.store.record(input({ tokenIds: ['2'], receipt: { ...input().receipt, transactionHash: OTHER } }))
  await h.next(); assert.equal(h.calls.length, 2)
  assert.equal(h.store.finality(4663, OTHER, BLOCK_HASH), 'finalized')
  await h.next(); await h.next(); assert.equal(h.calls.length, 2)
  h.advance(5000); held = false; await h.next()
  assert.equal(h.store.finality(4663, HASH, BLOCK_HASH), 'finalized')
})

test('an in-flight old receipt cannot overwrite a newer checked inclusion or finalized state', async () => {
  let finish
  const h = harness({ answer: () => new Promise(resolve => { finish = resolve }) })
  h.store.record(input()); await h.next()
  h.store.record(input({ receipt: { ...input().receipt, blockNumber: 17n, blockHash: OTHER, state: 'finalized' } }))
  finish(canonical({ block: { number: '0x10', hash: OTHER } })); await flush()
  assert.equal(h.store.get()[0].phase, 'finalized')
  assert.equal(h.store.get()[0].block, 17)
  assert.equal(h.store.get()[0].blockHash, OTHER)
})

test('an in-flight finality reply cannot finalize a superseded block and a delayed inclusion never downgrades finality', async () => {
  let finish
  const h = harness({ finalized: () => new Promise(resolve => { finish = resolve }) })
  h.store.record(input()); await h.next()
  h.store.record(input({ receipt: { ...input().receipt, blockNumber: 17n, blockHash: OTHER } }))
  finish({ number: '0x100' }); await flush()
  assert.equal(h.store.get()[0].phase, 'included')
  assert.equal(h.store.get()[0].blockHash, OTHER)
  const final = h.store.record(input({ receipt: { ...input().receipt, state: 'finalized' } }))
  h.store.record(input())
  assert.equal(h.store.finality(4663, HASH, BLOCK_HASH), 'finalized')
  assert.equal(h.store.get()[0].at, final.at)
})

test('expired and other-chain operations do not start unsupported reads; subscriptions stop cleanly', async () => {
  const h = harness(), observed = []
  const stop = h.store.subscribe(op => observed.push(op))
  h.store.record(input({ chainId: 8453 }))
  assert.equal(h.calls.length, 0)
  assert.equal(h.timers.size, 0, 'the Robinhood watcher never schedules unsupported chain reads')
  stop(); h.store.record(input()); assert.equal(observed.length, 1)
  h.advance(7 * 86400_000); await h.next()
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
})

test('final settlement waits for canonical finality and survives the screen subscription ending', async () => {
  let canonicalReady = false, finalityReady = false, settled = 0
  const h = harness({ answer: () => canonicalReady ? canonical() : canonical({ block: null }),
    finalized: async () => finalityReady ? { number: '0x10' } : { number: '0xf' } })
  const observed = [], stop = h.store.subscribe(operation => observed.push(operation.phase))
  h.store.record(input({ onFinalized: async () => { settled++; return true } }))
  await h.next()
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

test('final settlement expires ten minutes after its first visible finality attempt', async () => {
  const h = harness(); let attempts = 0
  h.store.record(input({ onFinalized: async () => { attempts++; return false } }))
  await h.next(); await h.next()
  assert.equal(h.store.get()[0].phase, 'finalized')
  assert.equal(attempts, 1)
  h.advance(600_000); await h.next()
  assert.equal(attempts, 1, 'the retry window ends even if fewer than ten attempts were possible')
  assert.equal(h.timers.size, 0, 'an expired finalized settlement leaves no perpetual scheduler')
})

test('late finality and a hidden screen do not consume the first final settlement attempt', async () => {
  let finalityReady = false, attempts = 0
  const h = harness({ finalized: async () => finalityReady ? { number: '0x10' } : null })
  h.store.record(input({ onFinalized: async () => { attempts++; return true } }))
  await h.next(); h.advance(700_000); finalityReady = true; await h.next()
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

test('a proven reorg cancels final settlement and no hidden screen runs settlement work', async () => {
  let attempts = 0
  const reorg = harness({ answer: () => canonical({ block: { number: '0x10', hash: OTHER } }) })
  reorg.store.record(input({ onFinalized: async () => { attempts++; return true } })); await reorg.next()
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
