/**
 * A referral link's `?ref=` (added 2026-11-07, the owner's Points page, Season 1; PROPOSAL.md §6 step 1, decisions D1
 * and D2): read from the address's own query on any page, stored in lower case when it is an address and the first one,
 * never the connected wallet's own, and taken out of the address bar by the router's own writer (src/lib/route.ts
 * dropSearchParam), the path, the other parameters, the section and the history entry kept.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

const require = createRequire(import.meta.url);
const APP = resolve(import.meta.dirname, '..');
const capture = { ...require('../.test-build/app/src/points/capture.js'), ...require('../.test-build/app/src/points/ref.js') };

const A = '0x7d3f0a91c2b84e5d6f1a2b3c4d5e6f708192a3b4';
const B = '0x91b7e2c04d5a6f38b2c1e9d07a4f6b3c2d1e0f9a';
const OWN = '0x4a62316623ad457f02cdc5d997ded67a383ec569';

/** localStorage, as much of it as capture.ts uses. */
function store(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    map,
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => void map.set(key, String(value)),
    removeItem: (key) => void map.delete(key),
  };
}

test('a valid ref is stored in lower case under its key, and the query is said to name one', () => {
  const s = store();
  assert.equal(capture.captureRef(`?ref=${A.toUpperCase().replace('0X', '0x')}`, s), true);
  assert.equal(s.map.get(capture.REF_KEY), A);
  assert.equal(capture.REF_KEY, 'domino.points.ref');
  assert.equal(capture.storedRef(s), A);
});

test('the first stored ref wins: a later ?ref= never replaces it', () => {
  const s = store();
  capture.captureRef(`?ref=${A}`, s);
  assert.equal(capture.captureRef(`?ref=${B}`, s), true, 'the later ref still leaves the address bar');
  assert.equal(capture.storedRef(s), A);
  capture.clearRef(s);
  assert.equal(capture.storedRef(s), null);
  capture.captureRef(`?ref=${B}`, s);
  assert.equal(capture.storedRef(s), B, 'once cleared (a link recorded), the next one is stored');
});

test('the connected wallet’s own link: kept by the entry (the wallet is not known yet), forgotten by the Points page, which takes the next one', () => {
  const s = store();
  assert.equal(capture.captureRef(`?ref=${OWN}`, s), true);
  assert.equal(capture.storedRef(s), OWN);
  // screens/Points.tsx: once that wallet is connected, its own link is cleared, so it never blocks the next one.
  const screen = readFileSync(join(APP, 'src/screens/Points.tsx'), 'utf8');
  assert.ok(screen.includes('const invitedBy = ref !== null && ref !== wallet ? ref : null'));
  assert.ok(screen.includes('if (wallet !== null && ref === wallet) clearRef(browserStore())'));
  capture.clearRef(s);
  capture.captureRef(`?ref=${A}`, s);
  assert.equal(capture.storedRef(s), A);
});

test('anything but one address is ignored and left in the address bar: a ref that is not one is not ours', () => {
  for (const search of ['?ref=0x123', `?ref=${A}0`, `?ref=${A.slice(2)}`, `?ref=0X${A.slice(2)}`, '?ref=', `?ref=${A}&ref=${B}`, `?ref= ${A}`, '?ref=0xzz' + '0'.repeat(38)]) {
    const s = store();
    assert.equal(capture.captureRef(search, s), false, search);
    assert.equal(s.map.size, 0, `${search}: nothing stored`);
  }
  for (const search of ['', '?', '?other=1', `?reference=${A}`, `?r=${A}`]) assert.equal(capture.captureRef(search, store()), false, search);
});

test('a stored value that is not an address reads as none; storage that throws keeps nothing and breaks nothing', () => {
  assert.equal(capture.storedRef(store({ [capture.REF_KEY]: 'nope' })), null);
  assert.equal(capture.storedRef(store({ [capture.REF_KEY]: A.toUpperCase().replace('0X', '0x') })), A);
  assert.equal(capture.storedRef(null), null);
  const refusing = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); }, removeItem() { throw new Error('denied'); } };
  assert.equal(capture.captureRef(`?ref=${A}`, refusing), true);
  assert.equal(capture.storedRef(refusing), null);
  assert.doesNotThrow(() => capture.clearRef(refusing));
});

/** A browser's location and history (tests/seo.test.mjs browserAt, as much as the route module needs here). */
function browserAt(href, state = null) {
  const events = new EventTarget();
  const entries = [{ url: new URL(href), state }];
  const at = 0;
  return {
    told: [],
    location: {
      get pathname() { return entries[at].url.pathname; },
      get search() { return entries[at].url.search; },
      get hash() { return entries[at].url.hash; },
    },
    history: {
      get state() { return entries[at].state; },
      get length() { return entries.length; },
      pushState(next, _title, url) { entries.push({ url: new URL(url, entries[at].url), state: next }); },
      replaceState(next, _title, url) { entries[at] = { url: new URL(url, entries[at].url), state: next }; },
    },
    addEventListener: (...args) => events.addEventListener(...args),
    removeEventListener: (...args) => events.removeEventListener(...args),
    dispatchEvent: (event) => events.dispatchEvent(event),
    get address() { return `${entries[at].url.pathname}${entries[at].url.search}${entries[at].url.hash}`; },
  };
}

function routesIn(win) {
  globalThis.window = win;
  const path = require.resolve('../.test-build/app/src/lib/route.js');
  delete require.cache[path];
  const route = require(path);
  win.addEventListener(route.ROUTE_EVENT, (event) => win.told.push(event.detail));
  return route;
}

test('the ref leaves the address bar in place: path, other parameters, section, history entry and its state kept, no move told', () => {
  for (const [from, to] of [
    [`/points?ref=${A}`, '/points'],
    [`/?ref=${A}`, '/'],
    [`/markets?utm=x&ref=${A}#top`, '/markets?utm=x#top'],
    [`/docs/risks?ref=${A}&b=2#who`, '/docs/risks?b=2#who'],
    [`/new?ref=wallet`, '/new?ref=wallet'],
  ]) {
    const win = browserAt(`https://domino.money${from}`, { kept: from });
    const route = routesIn(win);
    try {
      route.installRoutes();
      const s = store();
      if (capture.captureRef(win.location.search, s)) route.dropSearchParam('ref');
      assert.equal(win.address, to, from);
      assert.deepEqual([win.history.length, win.history.state], [1, { kept: from }], `${from}: the same entry, its state kept`);
      assert.deepEqual(win.told, [], `${from}: the route did not move`);
    } finally {
      delete globalThis.window;
    }
  }
});

test('only the address’s own query is read: a ref inside a section is not; a link from before becomes the page’s own address first', () => {
  // A section that carries a query (`/points#top?ref=…`): no query of the address's own, nothing stored, nothing written.
  {
    const win = browserAt(`https://domino.money/points#top?ref=${A}`);
    const route = routesIn(win);
    try {
      route.installRoutes();
      const s = store();
      assert.equal(capture.captureRef(win.location.search, s), false);
      assert.equal(s.map.size, 0);
      assert.equal(route.dropSearchParam('ref'), false, 'no query parameter of that name');
      assert.equal(win.address, `/points#top?ref=${A}`);
    } finally {
      delete globalThis.window;
    }
  }
  // A link from before (`/#/points?ref=…`): the router writes the page's own address first (src/lib/route.ts settle), its
  // query the address's own, so the referral link of the hash router still works, and leaves the bar the same way.
  {
    const win = browserAt(`https://domino.money/#/points?ref=${A}`);
    const route = routesIn(win);
    try {
      route.installRoutes();
      const s = store();
      assert.equal(capture.captureRef(win.location.search, s), true);
      route.dropSearchParam('ref');
      assert.equal(capture.storedRef(s), A);
      assert.equal(win.address, '/points');
      assert.equal(route.currentRoute(), '#/points');
    } finally {
      delete globalThis.window;
    }
  }
});

test('the entry takes the ref right after the router settles the address, before anything else reads it', () => {
  const main = readFileSync(join(APP, 'src/main.tsx'), 'utf8');
  const install = main.indexOf('installRoutes(isPagePath)');
  const take = main.indexOf("captureRef(window.location.search, store)) dropSearchParam('ref')");
  assert.ok(install > 0 && take > install, 'captured once the address is the page’s own');
  assert.ok(take < main.indexOf('createRoot(root)'), 'before the app draws');
  // Only the route module writes the address (tests/seo.test.mjs keeps every other module out of history).
  const code = readFileSync(join(APP, 'src/points/capture.ts'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  assert.doesNotMatch(code, /history\.|location\./);
});
