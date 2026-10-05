/**
 * Shared pieces for the S2 (crosschain-v1) node tests: the package runtime and fixtures read in place from
 * api-contracts/crosschain-v1, the compiled modules of src/v2/crosschain, a clock the test moves by hand and a
 * session the test controls. No network: nothing here fetches.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
export const PACKAGE = resolve(import.meta.dirname, '../../../../api-contracts/crosschain-v1');
export const SRC = resolve(import.meta.dirname, '../../../src/v2/crosschain');
export const runtime = await import(pathToFileURL(resolve(PACKAGE, 'runtime.mjs')).href);
export const build = (name) => require(`../../../.test-build/app/src/v2/crosschain/${name}.js`);

export const fixtureText = (path) => readFileSync(resolve(PACKAGE, 'fixtures', path), 'utf8');
export const fixture = (path) => JSON.parse(fixtureText(path));
export const clone = (value) => JSON.parse(JSON.stringify(value));
export const VARIANTS = readdirSync(resolve(PACKAGE, 'fixtures', 'variants')).sort();
export const ERRORS = fixture('errors.json');

/** The package's synthetic user and fee recipient. */
export const OWNER = '0x1111111111111111111111111111111111111111';
export const FEE_RECIPIENT = '0x2222222222222222222222222222222222222222';
export const OTHER = '0x9999999999999999999999999999999999999999';
export const CSRF = 'c'.repeat(43);

/** The request a response echoes, without the owner: what this page must have sent for that answer. */
export function sentFor(route, body) {
  if (route === 'origins') return { destinationChainId: body.origins.destinationChainId, destinationToken: body.origins.destinationToken };
  const { owner, ...rest } = route === 'quote' ? body.quote.request : body.status.request;
  void owner;
  return rest;
}

/** A monotonic clock that only moves when the test says so. Timers fire in order. */
export function fakeClock(start = 1_000_000) {
  let now = start;
  let timers = [];
  return {
    monoMs: () => now,
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
        const due = timers.filter((t) => t.live && t.at <= end).sort((a, b) => a.at - b.at)[0];
        if (!due) break;
        now = Math.max(now, due.at);
        due.live = false;
        due.callback();
      }
      now = end;
      timers = timers.filter((t) => t.live);
    },
    pending: () => timers.filter((t) => t.live).map((t) => t.at - now),
  };
}

/** A session that lends `csrf` while `signedIn` holds, and records every denial. */
export function fakeSession({ csrf = CSRF } = {}) {
  const session = {
    signedIn: true,
    lends: 0,
    denials: [],
    async withCsrf(send) {
      if (!session.signedIn) return { lent: false };
      session.lends += 1;
      return { lent: true, value: await send(csrf) };
    },
    reportDenial(code) {
      session.denials.push(code);
    },
  };
  return session;
}

export const flush = () => new Promise((done) => setImmediate(done));

/** A fixture transport, a session and a client over the real runtime, on a fake clock. */
export function lab({ clock = fakeClock() } = {}) {
  const { createFixtureTransport } = build('fixtureTransport');
  const { createCrosschainClient } = build('client');
  const transport = createFixtureTransport({ csrf: CSRF });
  const session = fakeSession();
  const client = createCrosschainClient({ transport, runtime, session, clock });
  return { transport, session, client, clock };
}
