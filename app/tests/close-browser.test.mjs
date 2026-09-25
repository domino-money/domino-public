/**
 * closeBrowser (support/close-browser.mjs), against a stand-in browser: the
 * case it exists for needs macOS and a GoogleUpdater run. The stand-in keeps
 * the two facts the helper relies on, both measured with real Chrome and
 * playwright-core 1.56 on 25 September 2026: close() resolves only once the
 * browser's stdout and stderr reach EOF, which processes Chrome leaves behind
 * can delay for minutes, and 'disconnected' fires as soon as Chrome exits.
 */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { closeBrowser } from './support/close-browser.mjs';

/**
 * A browser that exits `exitMs` after close() is called. Its close() never
 * returns ('held': something kept its pipes), returns after `close` ms, or
 * rejects with `close` halfway to the exit.
 */
function standIn({ exitMs = 10, close = 'held', connected = true } = {}) {
  const browser = new EventEmitter();
  let alive = connected;
  browser.closed = false;
  browser.isConnected = () => alive;
  browser.close = () => {
    if (alive) setTimeout(() => { alive = false; browser.emit('disconnected', browser); }, exitMs);
    if (close === 'held') return new Promise(() => {});
    if (close instanceof Error) return new Promise((resolve, reject) => setTimeout(() => reject(close), exitMs / 2));
    return new Promise((resolve) => setTimeout(() => { browser.closed = true; resolve(); }, close));
  };
  return browser;
}

async function elapsed(promise) {
  const start = performance.now();
  await promise;
  return performance.now() - start;
}

const timers = () => process.getActiveResourcesInfo().filter((kind) => kind === 'Timeout').length;

test('a close() that finishes within settleMs of the exit is waited for, and no longer', async () => {
  const browser = standIn({ exitMs: 10, close: 60 });
  const took = await elapsed(closeBrowser(browser, { settleMs: 5_000 }));
  assert.equal(browser.closed, true);
  assert.ok(took < 2_000, `took ${took} ms, as if the whole of settleMs had to pass`);
});

test('a close() held open past the exit is left settleMs after it', { timeout: 5_000 }, async () => {
  const took = await elapsed(closeBrowser(standIn({ exitMs: 10, close: 'held' }), { settleMs: 50 }));
  assert.ok(took >= 55, `returned after ${took} ms, before the browser exited and settleMs passed`);
});

test('nothing is left before the browser has exited, however long that takes', { timeout: 5_000 }, async () => {
  const took = await elapsed(closeBrowser(standIn({ exitMs: 300, close: 'held' }), { settleMs: 10 }));
  assert.ok(took >= 290, `returned after ${took} ms, while the browser was still running`);
});

test('a browser that had already gone gets settleMs, not forever', { timeout: 5_000 }, async () => {
  const took = await elapsed(closeBrowser(standIn({ connected: false, close: 'held' }), { settleMs: 50 }));
  assert.ok(took >= 45, `returned after ${took} ms`);
});

test('a close() that fails fails the caller', async () => {
  const failure = new Error('close failed');
  await assert.rejects(closeBrowser(standIn({ exitMs: 20, close: failure }), { settleMs: 5_000 }), failure);
});

test('no browser, nothing to close', async () => {
  await closeBrowser(undefined);
});

test('no timer outlives the call, whether close() returns after the exit or before it', async () => {
  await new Promise((resolve) => setTimeout(resolve, 50)); // the earlier stand-ins' exits
  const before = timers();
  await closeBrowser(standIn({ exitMs: 10, close: 60 }), { settleMs: 5_000 });
  assert.equal(timers(), before, 'close() returned after the exit');
  await closeBrowser(standIn({ exitMs: 20, close: 0 }), { settleMs: 5_000 });
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(timers(), before, 'close() returned before the exit');
});
