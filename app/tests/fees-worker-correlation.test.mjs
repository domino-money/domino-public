/** A cancelled prefetch can already have queued its reply. Correlate attempts, not only the NFT. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import { test } from 'node:test';
import { fixtureRelay, loadCase, stateOfCase } from './support/fees/relay-fixture.mjs';

const require = createRequire(import.meta.url);
const { createFeesStore } = require('../.test-build/app/src/lib/fees/store.js');
const { runPipeline } = require('../.test-build/app/src/lib/fees/pipeline.js');
const constants = require('../.test-build/app/src/lib/fees/constants.js');
const ts = require('typescript');
const id = '3135288';
const fixture = loadCase(id);
const state = stateOfCase(fixture);
const result = await runPipeline({ logs: fixtureRelay(fixture).logs, sleep: async () => {} }, { id, ...state, budgetBytes: 16 * 1024 * 1024, checkpoint: null });
assert.equal(result.ok, true);
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };

test('a queued old estimate/done cannot complete or persist the replacement run, including absent tokens', () => {
  const posted = [], saved = [];
  const worker = { postMessage: (message) => posted.push(structuredClone(message)), terminate() {}, onmessage: null, onerror: null, onmessageerror: null };
  const store = createFeesStore({
    spawn: () => worker, postState: async () => ({ ok: true, value: fixture.state, bytes: 1 }),
    later: () => () => {}, timer: () => () => {},
    historyCache: { load: () => null, remove() {}, save: (...args) => saved.push(args) },
  });
  store.offer({ ok: true, value: fixture.state, bytes: 1 });
  const stop = store.prefetchHistory(id, () => {});
  const previous = posted.at(-1);
  stop();
  store.offer({ ok: true, value: { ...fixture.state, block: fixture.state.block + 1, timestamp: fixture.state.timestamp + 1 }, bytes: 1 });
  store.subscribeHistory([id], 'page', () => {});
  const current = posted.at(-1);
  assert.deepEqual(posted.map((message) => message.type), ['run', 'cancel', 'run']);
  assert.equal(posted[1].runId, previous.runId, 'cancel names exactly the superseded attempt');
  assert.ok(Number.isSafeInteger(current.runId) && current.runId > previous.runId);
  const pending = store.view(id);
  for (const runId of [previous.runId, undefined]) {
    worker.onmessage({ data: { type: 'estimate', id, runId, history: result.history, prices: result.prices } });
    worker.onmessage({ data: { type: 'done', id, runId, result } });
    assert.equal(store.view(id), pending, 'stale or uncorrelated reply leaves the active attempt untouched');
    assert.equal(saved.length, 0, 'no stale data persisted with the successor state');
  }
  worker.onmessage({ data: { type: 'done', id, runId: current.runId, result } });
  assert.equal(store.view(id).phase, 'verified');
  assert.equal(saved.length, 1, 'the correctly correlated attempt still completes normally');
});

test('the worker echoes each attempt token, ignores stale cancellations, and suppresses replaced work', async () => {
  const source = readFileSync(new URL('../src/lib/fees/feesReplay.worker.ts', import.meta.url), 'utf8');
  const output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const pending = [], posted = [];
  const scope = { onmessage: null, postMessage: (message) => posted.push(structuredClone(message)) };
  const modules = {
    '../chain/browser': { chainLane: () => ({ deps() {}, learned: () => false, wait: () => 0 }), memoryCache: () => ({}) },
    '../../../functions/_lib/fees': { knownHead() {}, logsOnChain() {} },
    '../../../functions/_lib/feesPath': { pathLogsOnChain() {} },
    './logs': { logsWith() { throw new Error('no network in protocol test'); } },
    './constants': constants,
    './pipeline': { outOfTime: (value) => value, runPipeline: (deps, run) => new Promise((resolve) => pending.push({ deps, run, resolve })) },
  };
  runInNewContext(output, { exports: {}, self: scope, AbortController, setTimeout, clearTimeout, Date,
    require: (name) => { assert.ok(name in modules, `unexpected module ${name}`); return modules[name]; },
  });
  const send = (message) => scope.onmessage({ data: message });
  const run = { type: 'run', id, ...state, budgetBytes: constants.BUDGET_BYTES.page, checkpoint: null };
  send({ ...run, runId: 1 });
  send({ ...run, runId: 2 });
  assert.equal(pending[0].deps.cancelled(), true);
  send({ type: 'cancel', id, runId: 1 });
  assert.equal(pending[1].deps.cancelled(), false, 'old cancel cannot stop the new attempt');
  pending[0].deps.progress({ bytes: 1, daysDone: 1, daysTotal: 2 });
  pending[0].resolve(result);
  await flush();
  assert.equal(posted.length, 0, 'replaced attempt emits nothing new');
  pending[1].deps.progress({ bytes: 2, daysDone: 1, daysTotal: 2 });
  pending[1].deps.estimate({ history: result.history, prices: result.prices });
  pending[1].resolve(result);
  await flush();
  assert.deepEqual(posted.map((message) => [message.type, message.runId]), [['progress', 2], ['estimate', 2], ['done', 2]]);
  send({ ...run, runId: 3 });
  send({ type: 'cancel', id, runId: 3 });
  assert.equal(pending[2].deps.cancelled(), true);
  pending[2].resolve(result);
  await flush();
  assert.equal(posted.length, 3);
  send(run);
  assert.equal(pending.length, 3, 'an uncorrelated run is not accepted');
});
