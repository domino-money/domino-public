/**
 * TEST-ONLY. Added 2026-10-14 (incident C3: screens finish at inclusion; a release that waits for finality is a settlement
 * registered with the page's confirmation queue). The queue (src/lib/confirmedOperations.ts) as the page builds it, on a
 * fake clock, over `read` in place of the site's edge reader: as tests/confirmed-operations.test.mjs loads it.
 *
 *   confirmationQueue(read)   { store, mark(chainId, block), run(ms), calls }
 *     store   the queue (record, get, subscribe, noteChainFinality …)
 *     mark    read-v6's finalized mark reaching `block` (the hint that lets an own operation's one read fall due)
 *     run     lets `ms` of the fake clock pass, running every pass that falls due inside it
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const flush = async () => { for (let i = 0; i < 8; i++) await new Promise((resolve) => setImmediate(resolve)); };

export function confirmationQueue(read) {
  const ts = require('typescript'), mod = { exports: {} };
  const code = ts.transpileModule(readFileSync(new URL('../../../src/lib/confirmedOperations.ts', import.meta.url), 'utf8'),
    { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  new Function('require', 'module', 'exports', code)(() => ({ confirmationReads: {}, notePositionConfirmation() {} }), mod, mod.exports);
  let now = 1_000;
  const timers = new Set(), calls = [];
  const counted = { read: async (hash) => { calls.push(hash); return read.read(hash); }, finalized: () => read.finalized() };
  const clock = { now: () => now, visible: () => true, set: (run, ms) => { const timer = { run, at: now + ms }; timers.add(timer); return timer; }, clear: (timer) => timers.delete(timer) };
  const store = mod.exports.createConfirmedOperations(counted, clock);
  const first = () => [...timers].sort((a, b) => a.at - b.at)[0];
  return {
    store,
    calls,
    mark: (chainId, block) => store.noteChainFinality(chainId, block),
    async run(ms) {
      const end = now + ms;
      await flush();
      for (let timer = first(); timer && timer.at <= end; timer = first()) { timers.delete(timer); now = Math.max(now, timer.at); timer.run(); await flush(); }
      now = end;
    },
  };
}

/** The site's edge reader over a fake chain's own answers (`chain.request`), its finalized block as `finality.final` says. */
export function edgeReaderOf(chain, finality) {
  const ask = async (method, params) => (await chain.request(method, params)).result ?? null;
  return {
    read: async (hash) => {
      const transaction = await ask('eth_getTransactionByHash', [hash]);
      const receipt = transaction ? await ask('eth_getTransactionReceipt', [hash]) : null;
      const block = receipt ? await ask('eth_getBlockByNumber', [receipt.blockNumber, false]) : null;
      return { transaction, receipt, block };
    },
    finalized: async () => (finality.final ? { number: '0xffffffff' } : { number: '0x0' }),
  };
}
