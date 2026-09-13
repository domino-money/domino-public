/**
 * Shared pieces for the onboarding preview (#38) and deposit consumer
 * (#40/#44) node tests: a clock the test moves by hand, a session port the
 * test controls, the two package runtimes and their fixtures read in place
 * from api-contracts/, and the real compiled beta gate.
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
export const CONTRACTS = resolve(import.meta.dirname, '../../../api-contracts');
export const build = (path) => require(`../../.test-build/app/src/${path}.js`);
export const onboardingRuntime = await import(pathToFileURL(resolve(CONTRACTS, 'onboarding-v1/runtime.mjs')).href);
export const depositRuntime = await import(pathToFileURL(resolve(CONTRACTS, 'deposit-v1/runtime.mjs')).href);
export const fixtureText = (pkg, path) => readFileSync(resolve(CONTRACTS, pkg, 'fixtures', path), 'utf8');
export const fixture = (pkg, path) => JSON.parse(fixtureText(pkg, path));
export const depositSource = { text: (path) => fixtureText('deposit-v1', path) };
export const clone = (value) => JSON.parse(JSON.stringify(value));
export const flush = () => new Promise((done) => setImmediate(done));

/** A monotonic clock and a wall clock that only move when the test says so. Timers fire in order. */
export function fakeClock({ mono = 10_000, wall = Date.parse('2026-09-11T12:00:00Z') } = {}) {
  let now = mono;
  let wallNow = wall;
  let timers = [];
  return {
    monoMs: () => now,
    wallMs: () => wallNow,
    setTimer(callback, ms) {
      const timer = { at: now + ms, callback, live: true };
      timers.push(timer);
      return () => {
        timer.live = false;
      };
    },
    advance(ms) {
      const end = now + ms;
      for (;;) {
        const due = timers.filter((timer) => timer.live && timer.at <= end).sort((a, b) => a.at - b.at)[0];
        if (!due) break;
        now = Math.max(now, due.at);
        due.live = false;
        due.callback();
      }
      now = end;
      timers = timers.filter((timer) => timer.live);
    },
    setWall(ms) {
      wallNow = ms;
    },
    pending: () => timers.filter((timer) => timer.live).length,
  };
}

export const { NO_SESSION } = build('session/controller');
export const OWNER = '0xabababababababababababababababababababab';

/** A session port whose snapshot the test sets. It lends a CSRF only to the signed-in epoch. */
export function fakePort({ owner = OWNER, epoch = 1, connectorUid = 'uid-a', csrf = 'c'.repeat(43), csrfAccess = true, snapshot } = {}) {
  let current = snapshot ?? { kind: 'signed_in', owner, chainId: 4663, epoch, connectorUid };
  const listeners = new Set();
  const port = {
    csrfAccess,
    lends: [],
    denials: [],
    getSnapshot: () => current,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    withCsrf(wanted, fn) {
      if (!csrfAccess || current.kind !== 'signed_in' || current.epoch !== wanted) return Promise.resolve(NO_SESSION);
      port.lends.push(wanted);
      return fn(csrf);
    },
    reportDenial(code, epoch) {
      port.denials.push({ code, epoch });
    },
    set(next) {
      current = next;
      for (const listener of [...listeners]) listener();
    },
  };
  return port;
}

/** A transport result as a fixture or a fetch would produce it. `contract` is the package header, absent unless given. */
export function reply(status, body, { contract, contentType = 'application/json; charset=utf-8', retryAfter = null, requestId = null, opaqueRedirect = false } = {}) {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return {
    kind: 'reply',
    reply: {
      status,
      opaqueRedirect,
      contentType,
      contractHeader: contract === undefined ? null : contract,
      requestIdHeader: requestId,
      retryAfterHeader: retryAfter,
      body: { kind: 'text', text },
    },
  };
}

// ---- the real beta gate -----------------------------------------------------

export const GATE_ENV = { BETA_PASSWORD: 'correct-horse-battery-staple-42', BETA_COOKIE_KEY: 'q3VfK9mJx7Rt2WbN5cYp8LhD4sGa6ZeU1oTiQwErTyA' };
const middleware = require('../../.test-build/app/functions/_middleware.js');

/** What the compiled gate answers a same-origin JSON POST to `path` that carries no beta cookie. */
export function gateAnswer(path, env = GATE_ENV) {
  const request = new Request(`https://domino.money${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'Sec-Fetch-Mode': 'cors', 'Sec-Fetch-Site': 'same-origin', Origin: 'https://domino.money' },
    body: '{}',
  });
  return middleware.onRequest({
    request,
    env,
    next: async () => {
      throw new Error('the gate passed a request that had no beta cookie');
    },
  });
}
