/**
 * The platform workstream's pure parts (2026-10-01): an open tab across a release (D1, src/lib/staleRelease.ts), what
 * this browser keeps about wallets and when it goes (I6, src/lib/browserCopies.ts), the kept number formatters (F5,
 * src/lib/format/numberFormat.ts), and the page's boot script with the route table the build writes beside it (F1, F2,
 * F3: functions/_lib/boot.ts, src/routeTable.ts). The middleware's side (renewal, the login's link, the limiter, the
 * favicon, the cache rules) is tests/gate.test.mjs's; the built page's is tests/session.bundle.test.mjs's.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { test } from 'node:test';

const require = createRequire(import.meta.url);
const built = (name) => require(`../.test-build/app/src/${name}.js`);
const release = built('lib/staleRelease');
const copies = built('lib/browserCopies');
const { numberFormat, keptFormats } = built('lib/format/numberFormat');
const { ROUTES, MARKETS_TOKEN } = built('routeTable');
const boot = require('../.test-build/app/functions/_lib/boot.js');
const source = (path) => readFileSync(new URL(`../src/${path}`, import.meta.url), 'utf8');

// ---------------------------------------------------------------------------
// D1: an open tab across a release.
// ---------------------------------------------------------------------------

test('a file of the page that is gone reads as such in every browser’s words; an error in code that loaded does not', () => {
  for (const message of [
    'Failed to fetch dynamically imported module: https://domino.money/assets/Explore-abc.js',
    'error loading dynamically imported module: https://domino.money/assets/Explore-abc.js',
    'Importing a module script failed.',
    'Unable to preload CSS for /assets/screens-abc.css',
    "Failed to load module script: Expected a JavaScript-or-Wasm module script but the server responded with a MIME type of \"text/html\".",
  ]) assert.equal(release.isMissingChunk(new TypeError(message)), true, message);
  for (const error of [new TypeError("Cannot read properties of undefined (reading 'x')"), new Error('boom'), null, undefined, 'Failed to fetch dynamically imported module', { message: 7 }]) {
    assert.equal(release.isMissingChunk(error), false, String(error));
  }
});

test('the entry a page loads is its module script, whatever the attribute order', () => {
  assert.equal(release.entryOf('<head><script type="module" crossorigin src="/assets/index-AbC.js"></script>'), '/assets/index-AbC.js');
  assert.equal(release.entryOf('<script src="/assets/index-x.js" type="module"></script>'), '/assets/index-x.js');
  assert.equal(release.entryOf('<script type="application/json" id="dm-boot">{"chunks":{"markets":["/assets/Explore-x.js"]}}</script><script>(function(){})()</script><script type="module" crossorigin src="/assets/index-y.js"></script>'), '/assets/index-y.js', 'the boot script and its table are not the entry');
  assert.equal(release.entryOf('<!doctype html><title>Domino · Access</title><script>(function(){})()</script>'), null, 'the access page has none');
});

/** A deployment that answers `/` with `reply`, and a tab running `current`, with a session store and a clock. */
function tab({ reply, current = '/assets/index-old.js', stored = null, now = 1_000_000 } = {}) {
  const state = { asked: [], reloads: 0, store: new Map(stored === null ? [] : [[release.RELOAD_MARK, String(stored)]]), now };
  const deps = {
    current: () => current,
    fetch: async (input, init) => {
      state.asked.push([input, init]);
      if (reply instanceof Error) throw reply;
      return reply;
    },
    storage: () => ({ getItem: (key) => state.store.get(key) ?? null, setItem: (key, value) => state.store.set(key, value) }),
    now: () => state.now,
    reload: () => {
      state.reloads += 1;
    },
  };
  return { state, deps };
}
const html = (entry) => new Response(`<!doctype html><script type="module" crossorigin src="${entry}"></script>`, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });

test('the deployment is asked once which entry its page loads: newer, the same, the access gate, or no answer', async () => {
  const cases = [
    [html('/assets/index-new.js'), 'newer'],
    [html('/assets/index-old.js'), 'same'],
    [new Response('{"error":"beta_access_required"}', { status: 401, headers: { 'Content-Type': 'application/json' } }), 'gate'],
    [new Response('down', { status: 503, headers: { 'Content-Type': 'text/plain' } }), 'unknown'],
    [new Response('{}', { headers: { 'Content-Type': 'application/json' } }), 'unknown'],
    [html('') /* no module script */, 'unknown'],
    [new TypeError('Failed to fetch'), 'unknown'],
  ];
  for (const [reply, expected] of cases) {
    const { state, deps } = tab({ reply });
    assert.equal(await release.deployedRelease(deps), expected, expected);
    assert.equal(state.asked.length, 1);
    assert.deepEqual(state.asked[0], ['/', { method: 'GET', cache: 'no-store', credentials: 'same-origin', redirect: 'manual', headers: { Accept: 'text/html' } }]);
  }
});

test('a newer release, or the gate asking again, reloads the tab once; nothing else does, and never twice within ten minutes', async () => {
  for (const [reply, reloads] of [[html('/assets/index-new.js'), 1], [new Response('', { status: 401 }), 1], [html('/assets/index-old.js'), 0], [new TypeError('offline'), 0]]) {
    const { state, deps } = tab({ reply });
    const recovery = release.createReleaseRecovery(deps);
    assert.equal(await recovery.recover(), reloads === 1);
    assert.equal(state.reloads, reloads);
    if (reloads) assert.equal(state.store.get(release.RELOAD_MARK), String(state.now), 'the time of the reload is kept for this tab');
  }
  // Within the gap after a reload: nothing more, whatever the deployment says (a loop is impossible).
  const recent = tab({ reply: html('/assets/index-new.js'), stored: 1_000_000 - release.RELOAD_GAP_MS + 1 });
  assert.equal(await release.createReleaseRecovery(recent.deps).recover(), false);
  assert.equal(recent.state.reloads, 0);
  const later = tab({ reply: html('/assets/index-new.js'), stored: 1_000_000 - release.RELOAD_GAP_MS });
  assert.equal(await release.createReleaseRecovery(later.deps).recover(), true);
  // Storage that throws or is missing: no reload at all, rather than one that cannot be counted.
  const blocked = tab({ reply: html('/assets/index-new.js') });
  blocked.deps.storage = () => null;
  assert.equal(await release.createReleaseRecovery(blocked.deps).recover(), false);
  assert.equal(blocked.state.reloads, 0);
  assert.equal(release.RELOAD_GAP_MS, 600_000);
});

test('files that fail together share one check, and a failure inside a money flow waits for the next navigation', async () => {
  const { state, deps } = tab({ reply: html('/assets/index-new.js') });
  const recovery = release.createReleaseRecovery(deps);
  const results = await Promise.all([recovery.recover(), recovery.recover(), recovery.recover()]);
  assert.deepEqual([state.asked.length, state.reloads], [1, 1], 'one question, one reload');
  assert.deepEqual(results, [true, true, true]);

  const flow = tab({ reply: html('/assets/index-new.js') });
  const inFlow = release.createReleaseRecovery(flow.deps);
  const later = [];
  inFlow.whenSafe(false, (run) => later.push(run));
  inFlow.whenSafe(false, (run) => later.push(run));
  assert.equal(later.length, 1, 'one wait, however many files failed');
  await new Promise((done) => setImmediate(done));
  assert.deepEqual([flow.state.asked.length, flow.state.reloads], [0, 0], 'nothing reloaded under the flow');
  later[0]();
  await new Promise((done) => setTimeout(done, 0));
  await new Promise((done) => setTimeout(done, 0));
  assert.deepEqual([flow.state.asked.length, flow.state.reloads], [1, 1], 'at the next navigation');
  for (const [hash, open] of [['#/new', true], ['#/new/0xabc', true], ['#/setup', true], ['#/sequence', true], ['#/', false], ['#/positions/3325113', false], ['#/markets', false], ['#/automate', false], ['', false], ['#/nope', false]]) {
    assert.equal(release.moneyFlowOpen(hash), open, hash);
  }
  // 2026-10-01 (the chain2 workstream, part B): and the second chain's own New position, #/elysium/new…; nothing else of
  // its section holds a money flow.
  for (const [hash, open] of [['#/elysium/new', true], ['#/elysium/new/0x4b79c0e837ab70451bc849bf21d9ea3b25b69883', true], ['#/elysium', false], ['#/elysium/pool/0xabc', false], ['#/elysium/positions', false], ['#/elysium/receipts#top', false], ['#/elysiumx/new', false]]) {
    assert.equal(release.moneyFlowOpen(hash), open, hash);
  }
  // A modal dialog open anywhere (a position's Collect fees or Close position, whose wallet prompt may be waiting) waits
  // the same way: recoverWhenSafe asks both.
  const asked = [];
  const page = (open) => ({ querySelector: (selector) => (asked.push(selector), open ? {} : null) });
  assert.equal(release.dialogOpen(page(true)), true);
  assert.equal(release.dialogOpen(page(false)), false);
  assert.deepEqual([...new Set(asked)], ['[aria-modal="true"]']);
  assert.equal(release.dialogOpen(null), false, 'no document: nothing open');
  assert.equal(release.dialogOpen({ querySelector: () => { throw new Error('detached'); } }), false);
  assert.match(source('lib/staleRelease.ts'), /whenSafe\(!moneyFlowOpen\(window\.location\.hash\) && !dialogOpen\(\),/);
});

test('every lazily loaded screen and part the app opens goes through the recovery, behind its own flag where it has one', () => {
  const app = source('App.tsx');
  for (const screen of ['Explore', 'PoolDetail', 'Positions', 'NewPosition', 'Automate', 'Docs']) {
    assert.match(app, new RegExp(`const ${screen} = deferred<[^>]*>\\(recovering\\(\\(\\) => import\\('\\./screens/${screen}'\\)`), screen);
  }
  for (const screen of ['Sequence', 'Setup']) assert.match(app, new RegExp(`const ${screen} = __DOMINO_WALLET_SESSION__ \\? lazy\\(recovering\\(\\(\\) => import\\('\\./screens/${screen}'\\)`), screen);
  // 2026-10-01 (the chain2 workstream, part B): the second chain's section, one chunk opened from its route.
  assert.match(app, /const Elysium = deferred<object>\(recovering\(\(\) => import\('\.\/chains\/elysium\/ui\/ElysiumEntry'\), screenFailed\)\)/, 'the second chain’s section');
  assert.match(source('main.tsx'), /window\.addEventListener\('vite:preloadError', recoverWhenSafe\)/, 'every chunk failure Vite reports');
  // Changed on purpose 2026-10-02 (RPC-SPEC §11.4): there is no fees worker any more, so no worker file to recover.
  assert.doesNotMatch(source('lib/fees/spawn.ts'), /new Worker\(/, 'no fees worker');
  assert.match(source('components/Header.tsx'), /deferred\(recovering\(\(\) => import\('\.\/wallet\/WalletSessionIsland'\)/, 'the wallet');
  const positions = source('screens/Positions.tsx');
  for (const chunk of ['./Performance', './Execution', '../components/positions/HeldDeposits', '../components/positions/OwnedPositions', './PositionDetail']) {
    assert.ok(positions.includes(`recovering(() => import('${chunk}')`), chunk);
  }
  assert.ok(source('screens/PositionDetail.tsx').includes("recovering(() => import('../components/positions/PositionActions')"));
  assert.doesNotMatch(app, /\.catch\(couldNotLoad\)/, 'no screen swallows a release’s missing file any more');
});

// ---------------------------------------------------------------------------
// Unknown routes (live notes L19): the table, and the page that says so.
// ---------------------------------------------------------------------------

test('the route table: every page App draws, the older spellings, and Markets takes only an address after it', () => {
  // Changed on purpose 2026-10-01 (the chain2 workstream, part B): and the second chain's section, #/elysium….
  assert.deepEqual(ROUTES, { '': 'overview', markets: 'markets', explore: 'markets', pools: 'markets', pool: 'pool', positions: 'positions', app: 'positions', portfolio: 'positions', new: 'new', automate: 'automate', settings: 'docs', docs: 'docs', sequence: 'sequence', setup: 'setup', elysium: 'elysium' });
  const app = source('App.tsx');
  assert.match(app, /const PAGES: Readonly<Record<string, Page>> = \{\n {2}\.\.\.ROUTES,/, 'App routes with the same table the build writes into the page');
  for (const page of new Set(Object.values(ROUTES))) assert.match(app, new RegExp(`case '${page}':`), page);
  assert.match(app, /const page: Page = Object\.hasOwn\(PAGES, first\) \? PAGES\[first\] : 'not-found'/, 'a route that names no page is not found, not Home');
  assert.match(app, /page === 'markets' && second !== '' && !MARKETS_TOKEN\.test\(second\) \? 'not-found' : page/);
  assert.match(app, /Object\.hasOwn\(FLAGGED, route\) && !FLAGGED\[route\] \? 'not-found' : route/, 'a screen this build does not carry is not found either');
  assert.equal(MARKETS_TOKEN.test(`0x${'aB'.repeat(20)}`), true);
  for (const second of ['0xab', 'receipts', `0x${'1'.repeat(41)}`, `0x${'g'.repeat(40)}`]) assert.equal(MARKETS_TOKEN.test(second), false, second);
  const page = source('screens/NotFound.tsx');
  assert.match(page, /title="This page doesn’t exist"/);
  assert.match(page, /<LinkButton href="#\/">Go to Home<\/LinkButton>/);
  assert.doesNotMatch(page, /\bimport\(|fetch|localStorage/, 'it reads and loads nothing');
});

// ---------------------------------------------------------------------------
// F1, F2, F3: the boot script, and the table the build writes beside it.
// ---------------------------------------------------------------------------

/** Runs the boot script for `hash` against a table, and says which links it added and what it sent. */
function runBoot(hash, data) {
  const links = [];
  const sent = [];
  const document = {
    getElementById: (id) => (id === boot.BOOT_DATA_ID ? { textContent: JSON.stringify(data) } : null),
    createElement: (tag) => ({ tag, setAttribute(name, value) { this[name] = value; } }),
    head: { appendChild: (link) => links.push(link) },
  };
  const window = {};
  new Function('window', 'document', 'location', 'performance', 'fetch', boot.BOOT_SCRIPT)(window, document, { hash }, performance, (path, init) => (sent.push(`${init.method} ${path}`), new Promise(() => {})));
  return { links: links.map((link) => `${link.rel}${link.as ? `:${link.as}` : ''} ${link.href} ${link.crossOrigin === '' ? 'anonymous' : link.crossOrigin}`), sent };
}

test('the boot script asks for the opened route’s files, the same links the app’s loader would add, and nothing else', () => {
  const data = {
    early: false,
    pages: ROUTES,
    chunks: {
      markets: ['/assets/Explore-a.js', '/assets/screens-b.css'],
      positions: ['/assets/Positions-c.js', '/assets/OwnedPositions-d.js', '/assets/chainRoutes-e.js'],
      position: ['/assets/Positions-c.js', '/assets/PositionDetail-f.js', '/assets/chainRoutes-e.js'],
      docs: ['/assets/Docs-g.js'],
    },
  };
  assert.deepEqual(runBoot('#/markets', data).links, ['modulepreload /assets/Explore-a.js anonymous', 'preload:style /assets/screens-b.css anonymous']);
  // Changed on purpose 2026-10-01 (fix round 1): the second chain's section has no row in the build's table (the same
  // build is served on domino.money, where its route is not found), so no page preloads its chunk.
  for (const hash of ['#/elysium', '#/elysium/pool/0x4b79c0e837ab70451bc849bf21d9ea3b25b69883', '#/elysium/new']) {
    assert.deepEqual(runBoot(hash, data).links, [], hash);
  }
  const routeModules = readFileSync(new URL('../vite.config.ts', import.meta.url), 'utf8').match(/export const ROUTE_MODULES[\s\S]*?\n\}/)[0];
  assert.doesNotMatch(routeModules.replace(/\/\/.*$/gm, ''), /elysium/i, 'no row for the section');
  assert.deepEqual(runBoot('#/explore', data).links, runBoot('#/markets', data).links, 'the older spelling too');
  assert.deepEqual(runBoot('#/positions/3325113', data).links, ['modulepreload /assets/Positions-c.js anonymous', 'modulepreload /assets/PositionDetail-f.js anonymous', 'modulepreload /assets/chainRoutes-e.js anonymous'], 'a position’s page, with the client its first read asks (the site’s chain routes since 2026-10-01, RPC-SPEC)');
  assert.deepEqual(runBoot('#/positions', data).links.map((line) => line.split(' ')[1]), data.chunks.positions);
  assert.deepEqual(runBoot('#/positions/receipts', data).links.map((line) => line.split(' ')[1]), data.chunks.positions, 'Receipts is the list’s route, not a position');
  assert.deepEqual(runBoot('#/docs/wallet#sign-in', data).links.map((line) => line.split(' ')[1]), ['/assets/Docs-g.js']);
  for (const hash of ['', '#/', '#/#pools', '#/nope', '#/markets/0xab', '#/new']) assert.deepEqual(runBoot(hash, data), { links: [], sent: [] }, hash);
  // A table without the route, or no table at all, is nothing to do.
  assert.deepEqual(runBoot('#/markets', { early: true, pages: ROUTES, chunks: {} }).links, []);
  const document = { getElementById: () => null, head: { appendChild: () => assert.fail('nothing is added without a table') } };
  new Function('window', 'document', 'location', 'performance', 'fetch', boot.BOOT_SCRIPT)({}, document, { hash: '#/markets' }, performance, () => assert.fail('nothing is sent without a table'));
});

test('once the page is idle, the main screens’ files are prefetched once each, as the app’s loader asks for them, and never on a saving connection', () => {
  const { prefetchRoutes, PREFETCHED } = built('lib/prefetchRoutes');
  assert.deepEqual([...PREFETCHED], ['markets', 'positions', 'position', 'pool', 'new', 'automate', 'docs']);
  const table = {
    chunks: {
      markets: ['/assets/Explore-a.js', '/assets/screens-b.css'],
      positions: ['/assets/Positions-c.js', '/assets/screens-b.css'],
      position: ['/assets/Positions-c.js', '/assets/PositionDetail-d.js', '/assets/chainRoutes-e.js'],
      setup: ['/assets/Setup-f.js'],
      docs: ['/assets/Docs-g.js', 'https://elsewhere.example/x.js', '/assets/../index.html'],
    },
  };
  const page = (data = table, existing = ['/assets/Explore-a.js']) => {
    const links = [];
    return {
      links,
      doc: {
        getElementById: (id) => (id === 'dm-boot' ? { textContent: JSON.stringify(data) } : null),
        querySelectorAll: () => existing.map((href) => ({ getAttribute: (name) => (name === 'href' ? href : null) })),
        createElement: () => ({ rel: '', as: '', crossOrigin: null, setAttribute(name, value) { this[name] = value; } }),
        head: { appendChild: (link) => links.push(link) },
      },
    };
  };
  const one = page();
  assert.equal(prefetchRoutes(one.doc, { effectiveType: '4g' }), 5);
  assert.deepEqual(one.links.map((link) => [link.rel, link.as, link.crossOrigin, link.href]), [
    ['prefetch', 'style', '', '/assets/screens-b.css'],
    ['prefetch', 'script', '', '/assets/Positions-c.js'],
    ['prefetch', 'script', '', '/assets/PositionDetail-d.js'],
    ['prefetch', 'script', '', '/assets/chainRoutes-e.js'],
    ['prefetch', 'script', '', '/assets/Docs-g.js'],
  ], 'each file once, none the page already holds, no money screen, nothing from elsewhere');
  for (const connection of [{ saveData: true }, { effectiveType: '2g' }, { effectiveType: 'slow-2g' }]) assert.equal(prefetchRoutes(page().doc, connection), 0, JSON.stringify(connection));
  assert.equal(prefetchRoutes(page({ nope: 1 }).doc, undefined), 0, 'no table: nothing');
  assert.match(source('main.tsx'), /window\.addEventListener\('load', \(\) => setTimeout\(\(\) => prefetchRoutes\(\), 4_000\), \{ once: true \}\)/, 'after the page has loaded and gone quiet');
});

test('the table is a data block no data can close, written before the script and the app’s entry', () => {
  const tags = boot.bootTags({ early: true, pages: { '': 'overview' }, chunks: { markets: ['/assets/x</script><script>alert(1)</script>.js'] } });
  assert.match(tags, /^<script type="application\/json" id="dm-boot">\{.*\}<\/script>\n {4}<script>/);
  assert.equal(tags.split('</script>').length - 1, 2, 'the data closes nothing: its < is escaped');
  assert.ok(tags.includes('\\u003c/script>'));
  assert.equal(JSON.parse(/id="dm-boot">(.*?)<\/script>/.exec(tags)[1]).chunks.markets[0], '/assets/x</script><script>alert(1)</script>.js');
  assert.ok(tags.endsWith(`<script>${boot.BOOT_SCRIPT}</script>`));
  // Changed on purpose 2026-10-01 (integration with the markets workstream, audit A7 b): the script reads, and only
  // reads, the time of the markets copy (tests/featured-list.test.mjs runs that step); it writes nothing.
  assert.doesNotMatch(boot.BOOT_SCRIPT, /\b(?:XMLHttpRequest|WebSocket|sendBeacon|sessionStorage|indexedDB|cookie|eval|innerHTML|import\()\b/);
  assert.deepEqual([...boot.BOOT_SCRIPT.matchAll(/\blocalStorage\b(\.\w+)?/g)].map((match) => match[1]), ['.getItem'], 'one read of one key, never a write');
});

// ---------------------------------------------------------------------------
// I6: what this browser keeps about wallets, and when it goes.
// ---------------------------------------------------------------------------

/** A Storage with the parts the copies use. */
function memory(entries = {}) {
  const map = new Map(Object.entries(entries));
  return {
    map,
    get length() {
      return map.size;
    },
    key: (index) => [...map.keys()][index] ?? null,
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: (key) => map.delete(key),
  };
}
const OWNER = '0xf6184f814543b88dd867c34ce6e9f56ab7d18c0a';
const OTHER = '0x1111111111111111111111111111111111111111';
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const kept = (at) => JSON.stringify({ at, data: [] });

test('a copy past its age is deleted as the site opens: a day for a wallet’s lists, by kind for the rest', () => {
  const now = 100 * DAY;
  const storage = memory({
    [`domino.kept.v1.owned.4663.${OWNER}`]: kept(now - DAY - 1),
    [`domino.kept.v1.owned.4663.${OTHER}`]: kept(now - DAY + 1),
    [`domino.kept.v1.receipts.4663.${OWNER}`]: kept(now - 29 * DAY),
    [`domino.kept.v1.managed.4663.${OWNER}`]: kept(now - 7 * HOUR),
    'domino.kept.v1.tokens': kept(now - 31 * DAY),
    'domino.kept.v1.someday': kept(now - 31 * DAY),
    'domino.kept.v1.broken': '{not json',
    'domino.kept.v1.future': kept(now + 2 * 60_000),
    'domino-wallet-v1': JSON.stringify({ v: 1, wallets: { [OWNER]: { at: now - 2 * DAY }, [OTHER]: { at: now - HOUR } } }),
    'domino-read-budget:v1': '{"kept":"not ours"}',
    'unrelated': 'x',
    // 2026-10-02 (RPC-SPEC §11.4): what the retired fees replay kept goes; the ledger's own copies age themselves.
    'domino:public-fee-history:1': '{}',
    'domino:fee-points:1': '{}',
    'domino:pool-inits:1': '{}',
    'domino:block-times:1': '{}',
    'domino:public-fee-history:2': '{}',
    'domino:fee-readings:1': '{}',
  });
  copies.sweepCopies(storage, now);
  assert.deepEqual([...storage.map.keys()].sort(), [
    'domino-read-budget:v1',
    'domino-wallet-v1',
    `domino.kept.v1.owned.4663.${OTHER}`,
    `domino.kept.v1.receipts.4663.${OWNER}`,
    'domino:fee-readings:1',
    'domino:public-fee-history:2',
    'unrelated',
  ]);
  assert.deepEqual(Object.keys(JSON.parse(storage.map.get('domino-wallet-v1')).wallets), [OTHER], 'the Wallet card keeps only the address still within its day');
  const none = memory({ 'domino-wallet-v1': JSON.stringify({ v: 1, wallets: { [OWNER]: { at: now - 2 * DAY } } }) });
  copies.sweepCopies(none, now);
  assert.equal(none.map.size, 0, 'and goes altogether when none is');
  assert.equal(copies.sweepCopies(null, now), 0, 'no storage: nothing to do');
  const throwing = { get length() { throw new Error('blocked'); }, key() {}, getItem() {}, setItem() {}, removeItem() {} };
  assert.equal(copies.sweepCopies(throwing, now), 0, 'blocked storage: nothing, and no error');
  assert.deepEqual(copies.KEPT_MAX_AGE_MS, { owned: DAY, receipts: 30 * DAY, managed: 6 * HOUR, tokens: 30 * DAY });
  // 2026-10-01 (the chain2 workstream, part B, audit G10): the Wallet card's copy names its chain now; the old name
  // (above) is aged the same way until the card moves it, and the new one is aged exactly alike.
  assert.equal(copies.WALLET_MEMORY, 'domino-wallet-v2:4663');
  assert.equal(copies.LEGACY_WALLET_MEMORY, 'domino-wallet-v1');
  const scoped = memory({ 'domino-wallet-v2:4663': JSON.stringify({ v: 1, wallets: { [OWNER]: { at: now - 2 * DAY }, [OTHER]: { at: now - HOUR } } }), 'domino-wallet-v2:99801': '{"v":1,"wallets":{}}', 'domino-wallet-v2:x': '{}' });
  copies.sweepCopies(scoped, now);
  assert.deepEqual(Object.keys(JSON.parse(scoped.map.get('domino-wallet-v2:4663')).wallets), [OTHER]);
  assert.ok(!scoped.map.has('domino-wallet-v2:99801'), 'any chain’s copy, aged alike: an empty one goes');
  assert.ok(scoped.map.has('domino-wallet-v2:x'), 'a name that is no chain’s is not this module’s to delete');
  // Fix round 1 (2026-10-01): the second chain's section's receipts, each 30 days from when it was sent, like the
  // receipts above; the key goes with its last one.
  const receipt = (sentAt) => ({ hash: `0x${'a'.repeat(64)}`, sentAt });
  const section = memory({
    [`domino-elysium-receipts-v1:99801:${OWNER}`]: JSON.stringify([receipt(now - DAY), receipt(now - 31 * DAY)]),
    [`domino-elysium-receipts-v1:99801:${OTHER}`]: JSON.stringify([receipt(now - 31 * DAY)]),
    'domino-elysium-receipts-v1:99801:0xnot': JSON.stringify([receipt(now - 31 * DAY)]),
  });
  copies.sweepCopies(section, now);
  assert.deepEqual(JSON.parse(section.map.get(`domino-elysium-receipts-v1:99801:${OWNER}`)), [receipt(now - DAY)]);
  assert.ok(!section.map.has(`domino-elysium-receipts-v1:99801:${OTHER}`), 'all past their age: the key goes');
  assert.ok(section.map.has('domino-elysium-receipts-v1:99801:0xnot'), 'a name that is no owner’s is not this module’s');
});

test('a wallet disconnected here takes every wallet’s copies with it, and nothing else', () => {
  const storage = memory({
    [`domino.kept.v1.owned.4663.${OWNER}`]: kept(1),
    [`domino.kept.v1.owned.4663.${OTHER}`]: kept(1),
    [`domino.kept.v1.receipts.4663.${OWNER}`]: kept(1),
    [`domino.kept.v1.managed.4663.${OWNER}`]: kept(1),
    'domino.kept.v1.tokens': kept(1),
    'domino-wallet-v1': '{}',
    // 2026-10-01 (the chain2 workstream, part B, audit G10): and the Wallet card's copy under its chain's name.
    'domino-wallet-v2:4663': '{}',
    'domino-wallet-v2:99801': '{}',
    'domino-read-budget:v1': '{}',
    // Fix round 1 (2026-10-01): and the second chain's section's receipts.
    [`domino-elysium-receipts-v1:99801:${OWNER}`]: '[]',
  });
  copies.forgetWallets(storage);
  assert.deepEqual([...storage.map.keys()].sort(), ['domino-read-budget:v1', 'domino.kept.v1.tokens'], 'public token details and the read budget stay');
  copies.forgetWallets(null);
  const island = readFileSync(new URL('../src/components/wallet/WalletSessionIsland.tsx', import.meta.url), 'utf8');
  assert.match(island, /if \(identity\.kind === 'connected'\) connected\.current = true\n\s+else if \(view\.status === 'no_wallet' && connected\.current\) \{\n\s+connected\.current = false\n\s+forgetWallets\(\)/, 'only a disconnect after a connection in this page');
  assert.match(source('main.tsx'), /setTimeout\(\(\) => sweepCopies\(\), 3_000\)/, 'the sweep runs after the first paint');
});

// Changed on purpose 2026-10-01 (the copy workstream): what this browser keeps moved from Wallet and sign-in to a docs page
// of its own, Privacy (lib/docs/pages/custody.ts), with every kind of copy and its age, which this checks against the
// constants themselves.
test('the docs say what this browser keeps, for how long, and how it goes; nothing claims Domino keeps nothing at all', () => {
  const docs = source('lib/docs/pages/custody.ts');
  assert.match(docs, /Connecting your wallet stores nothing about it on Domino’s servers\. This browser keeps short-lived copies, so a page shows at once and then reads again:/);
  assert.match(docs, /An older copy is never shown, and is deleted the next time the site opens\. Disconnecting your wallet here deletes its copies, and signing out deletes the signed-in ones\. Clearing this site’s data deletes them all\./);
  const DAY = 86_400_000;
  assert.deepEqual([copies.KEPT_MAX_AGE_MS.owned, copies.WALLET_MEMORY_MAX_AGE_MS, copies.KEPT_MAX_AGE_MS.managed, copies.KEPT_MAX_AGE_MS.receipts, copies.KEPT_MAX_AGE_MS.tokens], [DAY, DAY, DAY / 4, 30 * DAY, 30 * DAY], 'the ages the page states');
  // Changed on purpose 2026-10-01 (fix round 1): token balances are kept for a viewed address too, so they have a row of
  // their own beside your positions.
  for (const row of ["{ label: 'Your positions', value: 'A day' }", "{ label: 'Token balances', value: 'A day', note: 'Of your wallet and of an address you view.' }", "{ label: 'Managed positions', value: '6 hours'", "{ label: 'Receipts', value: '30 days'", "{ label: 'Token names', value: '30 days'"]) assert.ok(docs.includes(row), row);
  assert.doesNotMatch(docs, /servers keep nothing about your wallet/, 'the sign-in service knows a signed-in address, for its session');
  assert.doesNotMatch(source('lib/docs/pages/introduction.ts'), /stores nothing about it|keep nothing about it/);
  assert.match(source('lib/docs/pages/using.ts'), /only this browser keeps a copy, for a day\./);
});

// ---------------------------------------------------------------------------
// F5: one formatter per set of options, and exactly the text a new one writes.
// ---------------------------------------------------------------------------

test('a kept formatter writes exactly what a new one writes, and each set of options is made once', () => {
  const sets = [
    {},
    { maximumFractionDigits: 0 },
    { maximumSignificantDigits: 6 },
    { maximumSignificantDigits: 4 },
    { maximumFractionDigits: 1, minimumFractionDigits: 0 },
    { style: 'currency', currency: 'USD', maximumFractionDigits: 2, minimumFractionDigits: 2 },
    { style: 'currency', currency: 'USD', maximumFractionDigits: 0, minimumFractionDigits: 0 },
    { notation: 'compact', maximumFractionDigits: 1 },
  ];
  const values = [0, 1, -1, 0.000123456789, 0.5, 1.23456789, 999.995, 1000, 1234567.891, 18_800, 6_200_000, 1e15, 3.14159e-7, 12_345.6789];
  for (const options of sets) {
    const fresh = new Intl.NumberFormat('en-US', options);
    for (const value of values) assert.equal(numberFormat(options).format(value), fresh.format(value), `${JSON.stringify(options)} ${value}`);
    assert.equal(numberFormat({ ...options }), numberFormat(options), 'the same formatter for the same options');
  }
  const count = keptFormats();
  for (let i = 0; i < 100; i++) numberFormat({ maximumSignificantDigits: 6 }).format(i);
  assert.equal(keptFormats(), count, 'no new formatter per call');
  for (const path of ['lib/read/marketPrice.ts', 'lib/read/screens/positions.ts', 'lib/read/screens/poolRange.ts', 'components/pool/plain.ts', 'components/pool/PoolEarnings.tsx', 'lib/create/plain.ts', 'lib/create/depositForm.ts']) {
    assert.doesNotMatch(source(path), /new Intl\.NumberFormat/, path);
  }
});
