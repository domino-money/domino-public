/**
 * Domino in Google (2026-11-07, the owner's yes to integ-logs/seo/PROPOSAL.md): pages of their own, each with its own
 * head, the sitemap, the 301s and 404s, noindex lifted only on domino.money with search switched on, and the address
 * bar read and written in one module only (src/lib/route.ts). The browser side (every old `#/` link landing on the same
 * screen at its clean address, the raw HTML each address answers) is tests/routes.browser.test.mjs.
 */
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, relative, resolve } from 'node:path';
import { beforeEach, test } from 'node:test';
import { parse } from '@babel/parser';

const require = createRequire(import.meta.url);
const APP = resolve(import.meta.dirname, '..');
const BUILT = join(APP, '.test-build/app');
const seo = require('../.test-build/app/functions/_lib/seo.js');
const { PAGE_ALIASES, canonicalPath } = require('../.test-build/app/functions/_lib/pagePaths.js');
const table = require('../.test-build/app/src/lib/seo/table.js');
const heads = require('../.test-build/app/src/lib/seo/heads.js');
const { ROUTES, pendingTitle } = require('../.test-build/app/src/routeTable.js');
const { DOC_ALIASES, DOC_PAGES, DOCS_HOME } = require('../.test-build/app/src/lib/docs/registry.js');
const { CREATE } = require('../.test-build/app/src/lib/create/copy.js');
const { onRequest } = require('../.test-build/app/functions/_middleware.js');

const readText = (path) => readFileSync(path, 'utf8').replace(/\r\n/g, '\n');

/**
 * The page kept out of search (heads.ts MAIN_PAGES, `index: false`). Changed on purpose 2026-11-07 (the owner's Points page,
 * Season 1): it is declared now, with the words he approved (integ-logs/points/PROPOSAL.md §3); before, a test declared one
 * of its own to prove the rule.
 */
const POINTS = Object.freeze({ path: '/points', title: 'Points · Domino', description: 'Your Domino points for Season 1 and your referral link.', index: false });

// ---------------------------------------------------------------------------
// The words, as the owner approved them (PROPOSAL.md §3).
// ---------------------------------------------------------------------------

const APPROVED = {
  '/': ['Domino · Earn fees. Keep control.', 'Put two tokens in a Uniswap pool and earn its trading fees. Your wallet stays yours.'],
  '/markets': ['Markets · Domino', 'Top pools of the last 24 hours, with their volume and estimated APR.'],
  '/new': ['New position · Domino', 'Choose a pool, a price range and an amount. Nothing leaves your wallet until you confirm.'],
  '/automate': ['Automate · Domino', 'Auto-compound, Domino-compound or Auto-exit: choose what happens next.'],
  '/docs': ['Docs · Domino', 'How Domino works, what your wallet signs, and what it costs.'],
  '/positions': ['Positions · Domino', 'Your positions on every network, what they earned, and what your automation did.'],
  '/docs/risks': ['Risks · Docs · Domino', 'What Domino does not remove: moving prices, idle ranges, fees that fall short, automation that stops, and token, bridge and contract risk.'],
  // Added 2026-11-07 (the owner: a Docs page for Season 1 of points): listed for search like every docs page.
  '/docs/points': ['Points · Docs · Domino', 'Season 1 of Domino points: what they count, how a wallet earns them, referrals, and what points are not.'],
};

test('Home and the six sitelink pages carry the approved words; every docs page its own title and summary', () => {
  const pages = table.headTable().pages;
  for (const [path, [title, description]] of Object.entries(APPROVED)) {
    assert.deepEqual([pages[path].title, pages[path].description, pages[path].index], [title, description, true], path);
  }
  assert.equal(pages['/'].social, 'Earn fees. Keep control.', 'a shared Home link does not repeat the site’s name');
  assert.equal(pages['/docs/auto-compound'].description, 'Adds a position’s earned fees back into the same position, so it grows, and nothing else.', 'the alternative sixth');
  // Changed on purpose 2026-11-07 (the owner's Points page, Season 1): Points among the main screens, kept out of search,
  // and the docs' Points page among theirs.
  assert.deepEqual(Object.keys(pages), ['/', '/markets', '/new', '/positions', '/automate', '/points', '/docs', ...DOC_PAGES.map((page) => `/docs/${page.slug}`)]);
  assert.equal(Object.keys(pages).length, 31, 'Home, six screens (Points kept out of search) and the docs with their 24 pages');
  assert.deepEqual(pages['/points'], { title: POINTS.title, description: POINTS.description, index: false });
  for (const page of DOC_PAGES) {
    assert.deepEqual([pages[`/docs/${page.slug}`].title, pages[`/docs/${page.slug}`].description], [`${page.title} · Docs · Domino`, page.summary], page.slug);
  }
  for (const words of Object.values(pages)) assert.ok(words.description.length <= 160, `${words.title}: a description a result shows whole`);
});

test('each title is the name the page’s own tab has, so the result and the tab say the same', () => {
  const pages = table.headTable().pages;
  for (const [path, page] of [['/markets', 'markets'], ['/new', 'new'], ['/positions', 'positions'], ['/automate', 'automate'], ['/docs', 'docs']]) {
    assert.equal(pages[path].title, pendingTitle(page, '', `#${path}`, true), path);
  }
  assert.equal(pages['/new'].title, `${CREATE.page.title} · Domino`, 'New position names its tab from its copy');
  assert.equal(pages['/docs'].title, `${DOCS_HOME.title} · Domino`);
  const source = (path) => readText(join(APP, 'src', path));
  assert.match(source('screens/Docs.tsx'), /useRouteTitle\(page \? `\$\{page\.title\} · Docs` :/, 'a docs page’s tab is "<page> · Docs · Domino"');
  assert.match(source('screens/Automate.tsx'), /useRouteTitle\('Automate'\)/);
  assert.match(source('screens/Explore.tsx'), /'Token pools' : 'Markets'\)/);
  assert.match(source('screens/Positions.tsx'), /: 'Positions'\)/);
  // Home's tab is its search title (decision 1): Landing names it from the same constant.
  assert.equal(heads.HOME_TITLE, pages['/'].title);
  assert.match(source('screens/Landing.tsx'), /useTabTitle\(HOME_TITLE\)/);
});

/** The table as a build with Elysium live has it: the compiled modules loaded again with the build's defines on globalThis. */
function tableWithElysium() {
  const flags = { __DOMINO_ELYSIUM_LIVE__: true, __DOMINO_ELYSIUM_FUNDS_FROM__: false, __DOMINO_ELYSIUM_UNISWAP__: null };
  const ours = (key) => key.includes('.test-build');
  const saved = Object.entries(require.cache).filter(([key]) => ours(key));
  for (const [key] of saved) delete require.cache[key];
  Object.assign(globalThis, flags);
  try {
    return { table: require('../.test-build/app/src/lib/seo/table.js'), docs: require('../.test-build/app/src/lib/docs/registry.js') };
  } finally {
    for (const name of Object.keys(flags)) delete globalThis[name];
    for (const key of Object.keys(require.cache)) if (ours(key)) delete require.cache[key];
    for (const [key, value] of saved) require.cache[key] = value;
  }
}

// PROPOSAL.md (correction 1) counted three such summaries; the registry has four: the docs' Markets page names the other
// networks too (lib/docs/pages/using.ts OTHERS).
test('the docs summaries are the build’s own: with Elysium live, the four that name the networks change, and the table with them', () => {
  const off = table.headTable().pages;
  const live = tableWithElysium();
  const on = live.table.headTable().pages;
  for (const page of live.docs.DOC_PAGES) assert.equal(on[`/docs/${page.slug}`].description, page.summary, page.slug);
  const changed = Object.keys(off).filter((path) => off[path].description !== on[path]?.description).sort();
  assert.deepEqual(changed, ['/docs/contracts', '/docs/markets', '/docs/wallet', '/docs/what-is-domino'], 'What Domino is, Wallet and sign-in, Markets, Contracts');
  for (const path of Object.keys(APPROVED)) assert.deepEqual(on[path], off[path], `${path}: the approved words name no network`);
});

test('a build with Elysium switched on writes its own summaries into its page: the same build that draws its docs', { skip: !existsSync(join(APP, '.wallet-test-v2-dist-elysium/index.html')) && 'no forced Elysium build here (npm run build:wallet-test-v2-elysium)' }, () => {
  const page = readFileSync(join(APP, '.wallet-test-v2-dist-elysium/index.html'), 'utf8');
  const carried = JSON.parse(/<script type="application\/json" id="dm-head">([^<]*)<\/script>/.exec(page)[1]);
  assert.deepEqual(carried.pages, tableWithElysium().table.headTable().pages);
  assert.match(carried.pages['/docs/wallet'].description, /four networks/);
  assert.match(table.headTable().pages['/docs/wallet'].description, /three networks/);
});

// Changed on purpose 2026-11-07 (the owner's Points page, Season 1): 30 pages for search (the docs' Points page joins), and
// the Points page itself, declared now, out of the sitemap.
test('sitemap.xml lists the 30 pages for search, at their own address on domino.money, and none kept out of search', () => {
  const xml = table.sitemapXml();
  const urls = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((match) => match[1]);
  assert.match(xml, /^<\?xml version="1\.0" encoding="UTF-8"\?>\n<urlset xmlns="http:\/\/www\.sitemaps\.org\/schemas\/sitemap\/0\.9">\n/);
  assert.equal(urls.length, 30);
  assert.deepEqual(urls, Object.keys(table.headTable().pages).filter((path) => path !== '/points').map((path) => `https://domino.money${path}`));
  assert.ok(urls.includes('https://domino.money/docs/points'), 'the docs’ Points page is for search');
  assert.ok(!urls.includes('https://domino.money/points'), 'the Points page is not');
  // A page kept out of search (a future points page), declared as one would: a main page with `index: false`, through the
  // same pageWords the build uses. It keeps its words and stays out of the sitemap; the others stay listed.
  const kept = table.pageWords();
  assert.deepEqual(kept.find((page) => page.path === '/points'), { ...POINTS, index: false });
  assert.deepEqual(heads.MAIN_PAGES.find((page) => page.path === '/points'), POINTS);
  assert.ok(kept.filter((page) => page.path !== '/points').every((page) => page.index === true));
  assert.equal(table.headTable(kept).pages['/points'].index, false);
  assert.doesNotMatch(table.sitemapXml(kept), /domino\.money\/points<\/loc>/);
  assert.equal([...table.sitemapXml(kept).matchAll(/<loc>/g)].length, 30);
  // A main page that says nothing is listed, as every one is today.
  assert.ok(heads.MAIN_PAGES.every((page) => page.index === undefined || page.path === '/points'));
});

test('the older names are the route table’s and the docs’ own, and every one is a page’s own address', () => {
  const routeAliases = Object.entries(ROUTES).filter(([first, page]) => first !== '' && first !== page && !['pool', 'sequence', 'setup', 'elysium'].includes(first));
  const expected = {
    ...Object.fromEntries(routeAliases.map(([first, page]) => [`/${first}`, `/${page === 'overview' ? '' : page}`])),
    ...Object.fromEntries(Object.entries(DOC_ALIASES).map(([from, to]) => [`/docs/${from}`, `/docs/${to}`])),
  };
  assert.deepEqual(PAGE_ALIASES, expected);
  for (const to of Object.values(PAGE_ALIASES)) assert.ok(Object.hasOwn(table.headTable().pages, to), `${to} is a page of its own`);
  for (const [path, own] of [['/', '/'], ['/markets', '/markets'], ['/markets/', '/markets'], ['/docs///', '/docs'], ['/explore', '/markets'], ['/explore/', '/markets'], ['/pools', '/markets'], ['/app', '/positions'], ['/portfolio', '/positions'], ['/settings', '/docs'], ['/docs/stop-loss', '/docs/auto-exit'], ['/docs/domino-compounder', '/docs/domino-compound'], ['/explore/0xabc', '/explore/0xabc'], ['/portfolio/0x1', '/portfolio/0x1'], ['/positions/', '/positions']]) {
    assert.equal(canonicalPath(path), own, path);
  }
});

test('no folder of the site’s files has a page’s name, but docs, whose pictures Pages serves beside the page', () => {
  const folders = readdirSync(join(APP, 'public')).filter((name) => statSync(join(APP, 'public', name)).isDirectory());
  const pages = new Set(Object.keys(ROUTES).filter(Boolean));
  assert.deepEqual(folders.filter((name) => pages.has(name)), ['docs'], 'a new folder named like a page would shadow it');
  for (const name of readdirSync(join(APP, 'public', 'docs'))) assert.match(name, /\.webp$/, 'only pictures under /docs/: every other /docs/<x> is a page');
});

// ---------------------------------------------------------------------------
// The head each address answers with (functions/_lib/seo.ts through the real middleware).
// ---------------------------------------------------------------------------

const TEMPLATE = '<!doctype html>\n<html lang="en">\n  <head>\n    <meta charset="UTF-8" />\n    <title>Domino</title>\n    <link rel="icon" type="image/svg+xml" href="/favicon.svg" />\n  </head>\n  <body>\n    <div id="root"></div>\n  </body>\n</html>\n';
const DIST_INDEX = join(APP, 'dist/index.html');
/** The page the build writes: dist's own when it is there (npm run build), else the template through the same writer. */
const PAGE = existsSync(DIST_INDEX) ? readFileSync(DIST_INDEX, 'utf8') : table.withHead(TEMPLATE);
const OPEN = { BETA_GATE: 'off' };
const SEARCH = { BETA_GATE: 'off', SEARCH_INDEX: 'on' };

let asked = [];
beforeEach(() => {
  asked = [];
});
const serve = (body = PAGE, status = 200, type = 'text/html; charset=utf-8') => async (passed) => {
  asked.push(passed?.method ?? 'next()');
  return new Response(body, { status, headers: { 'Content-Type': type, 'Content-Length': String(Buffer.byteLength(body)) } });
};
const visit = (url, env = OPEN, { method = 'GET', next = serve() } = {}) =>
  onRequest({ request: new Request(url, { method, headers: { 'Sec-Fetch-Mode': 'navigate', Accept: 'text/html' } }), env, next });

const meta = (html, attribute, name) => new RegExp(`<meta ${attribute}="${name.replace(/[.:]/g, '\\$&')}" content="([^"]*)" />`).exec(html)?.[1] ?? null;
const headOf = (html) => ({
  title: /<title>([^<]*)<\/title>/.exec(html)?.[1] ?? null,
  description: meta(html, 'name', 'description'),
  canonical: /<link rel="canonical" href="([^"]*)" \/>/.exec(html)?.[1] ?? null,
  robots: meta(html, 'name', 'robots'),
  ogTitle: meta(html, 'property', 'og:title'),
  ogDescription: meta(html, 'property', 'og:description'),
  ogUrl: meta(html, 'property', 'og:url'),
  ogImage: meta(html, 'property', 'og:image'),
  ogSite: meta(html, 'property', 'og:site_name'),
  card: meta(html, 'name', 'twitter:card'),
  ld: /<script type="application\/ld\+json">([^<]*)<\/script>/.exec(html)?.[1] ?? null,
  tables: (html.match(/id="dm-head"/g) ?? []).length,
  titles: (html.match(/<title>/g) ?? []).length,
});

test('the built page carries Home’s head and the table, between the marks, once each', () => {
  const head = headOf(PAGE);
  assert.equal(head.title, APPROVED['/'][0]);
  assert.equal(head.description, APPROVED['/'][1]);
  assert.equal(head.canonical, 'https://domino.money/');
  assert.equal(head.ogSite, 'Domino');
  assert.equal(head.ogTitle, 'Earn fees. Keep control.');
  assert.equal(head.ogImage, 'https://domino.money/og.png');
  assert.equal(head.card, 'summary_large_image');
  assert.deepEqual(JSON.parse(head.ld), { '@context': 'https://schema.org', '@type': 'WebSite', name: 'Domino', alternateName: 'domino.money', url: 'https://domino.money/' });
  assert.equal(head.tables, 1);
  assert.equal(head.titles, 1);
  assert.equal(head.robots, null, 'Home is for search');
  assert.match(PAGE, /<link rel="icon" type="image\/svg\+xml" href="\/favicon\.svg" \/>/, 'the favicon unchanged');
  // The structured data is a data block: no CSP runs it, so the page's policy needs no new hash (the boot script's stays the one).
  const scripts = [...PAGE.matchAll(/<script\b([^>]*)>/g)].map((match) => match[1]);
  for (const attributes of scripts) assert.match(attributes, /type="(?:application\/json|application\/ld\+json|module)"|^$/, attributes);
  if (existsSync(DIST_INDEX)) {
    // The table dist carries is the one this build's words give (the release build: Elysium as its switch says).
    const carried = JSON.parse(/<script type="application\/json" id="dm-head">([^<]*)<\/script>/.exec(PAGE)[1]);
    const elysium = /"what-is-domino"/.test(PAGE) && carried.pages['/docs/what-is-domino'].description !== table.headTable().pages['/docs/what-is-domino'].description;
    assert.deepEqual(carried, elysium ? tableWithElysium().table.headTable() : table.headTable());
    assert.equal(readText(join(APP, 'dist/sitemap.xml')), table.sitemapXml());
    assert.ok(existsSync(join(APP, 'dist/og.png')), 'the shared picture ships');
  }
});

test('each page the table lists answers 200 with its own title, description, canonical address and shared link, and no table', async () => {
  // Changed on purpose 2026-11-09 (Elysium's day 9): the table the build carries, Elysium's once its switch is on (as the
  // test above reads it), since the edge answers each page from the table in dist's page.
  const carried = existsSync(DIST_INDEX) ? JSON.parse(/<script type="application\/json" id="dm-head">([^<]*)<\/script>/.exec(PAGE)[1]) : null;
  const elysium = carried !== null && carried.pages['/docs/what-is-domino'].description !== table.headTable().pages['/docs/what-is-domino'].description;
  for (const [path, words] of Object.entries((elysium ? tableWithElysium().table : table).headTable().pages)) {
    const response = await visit(`https://domino.money${path}`);
    const html = await response.text();
    const head = headOf(html);
    assert.equal(response.status, 200, path);
    assert.deepEqual([head.title, head.description, head.canonical, head.ogUrl, head.ogTitle, head.ogDescription], [words.title, words.description, `https://domino.money${path}`, `https://domino.money${path}`, words.social ?? words.title, words.description], path);
    assert.equal(head.tables, 0, `${path}: the table stays at the edge`);
    assert.equal(head.titles, 1, path);
    // The Points page keeps noindex: its own words and canonical address, out of search (2026-11-07).
    assert.equal(head.robots, words.index ? null : 'noindex', path);
    assert.equal(head.ld !== null, path === '/', `${path}: the site's name as structured data on Home alone`);
    assert.equal(response.headers.get('Content-Length'), null, `${path}: no stale length`);
    assert.match(html, /<div id="root"><\/div>/, `${path}: the app itself, unchanged`);
  }
});

test('a page the app opens with no words of its own answers 200 with the site’s head, no canonical address and noindex', async () => {
  for (const path of ['/pool/0x' + 'ab'.repeat(32), '/pool/0x' + 'ab'.repeat(32) + '/0x' + '11'.repeat(20), '/pool/network/8453/0x' + 'ab'.repeat(32) + '/0x' + '11'.repeat(20), '/markets/0x' + '11'.repeat(20), '/markets/network/8453/0x' + '11'.repeat(20), '/explore/0x' + '11'.repeat(20), '/positions/123', '/positions/receipts', '/positions/base-v4-5', '/portfolio/0x' + '22'.repeat(20), '/new/0x' + 'ab'.repeat(32), '/new/network/8453/0x' + '11'.repeat(20), '/sequence', '/sequence/compound/7', '/sequence/protection', '/setup', '/elysium', '/elysium/new', '/docs/risks/extra', '/docs/stop-loss/x']) {
    const response = await visit(`https://domino.money${path}`);
    const head = headOf(await response.text());
    assert.equal(response.status, 200, path);
    assert.deepEqual([head.title, head.canonical, head.ogUrl, head.robots, head.ld, head.tables], ['Domino', null, null, 'noindex', null, 0], path);
    assert.equal(head.description, APPROVED['/'][1], path);
    // A shared link's title is the tab's (PROPOSAL.md §3), not Home's pitch.
    assert.deepEqual([head.ogTitle, head.ogDescription], ['Domino', APPROVED['/'][1]], path);
  }
});

test('an address the app has nothing at answers 404 with the same app, which says the page does not exist', async () => {
  for (const path of ['/nope', '/docs/nope', '/markets/nope', '/Markets', '/assets', '//markets', '/docs/constructor', '/constructor', '/__proto__']) {
    const response = await visit(`https://domino.money${path}`);
    const html = await response.text();
    assert.equal(response.status, 404, path);
    assert.match(html, /<div id="root"><\/div>/, path);
    assert.equal(headOf(html).robots, 'noindex', path);
    assert.equal(response.headers.get('Cache-Control'), 'no-store', `${path}: never kept`);
    assert.match(response.headers.get('Content-Security-Policy'), /script-src 'nonce-/, `${path}: the page's own policy, so the app runs`);
  }
});

test('a trailing slash and an older name move for good to the page’s own address; a HEAD answers as its GET does, without a body', async () => {
  for (const [path, own] of [['/markets/', '/markets'], ['/docs/', '/docs'], ['/docs/risks/', '/docs/risks'], ['/explore', '/markets'], ['/pools', '/markets'], ['/app', '/positions'], ['/portfolio', '/positions'], ['/settings', '/docs'], ['/docs/stop-loss', '/docs/auto-exit'], ['/docs/domino-compounder', '/docs/domino-compound'], ['/explore/?a=1', '/markets?a=1']]) {
    const response = await visit(`https://domino.money${path}`);
    assert.deepEqual([response.status, response.headers.get('Location'), response.headers.get('Cache-Control')], [301, `https://domino.money${own}`, 'no-store'], path);
    assert.deepEqual(asked, [], `${path}: nothing served`);
  }
  // A page's HEAD is asked of the files as its GET (Cloudflare answers a HEAD with headers alone, no table to read), so it
  // answers with its GET's status and robots, without the body. A GET goes on as sent.
  await visit('https://domino.money/docs/risks');
  assert.deepEqual(asked, ['next()'], 'a GET: the request as sent');
  asked = [];
  const head = await visit('https://domino.money/docs/risks', OPEN, { method: 'HEAD' });
  assert.deepEqual([head.status, await head.text()], [200, '']);
  assert.deepEqual(asked, ['GET'], 'a HEAD: its GET');
  const missing = await visit('https://domino.money/nope', OPEN, { method: 'HEAD' });
  assert.deepEqual([missing.status, await missing.text()], [404, '']);
  for (const [path, robots] of [['/markets', null], ['/docs/risks', null], ['/pool/0x1', 'noindex'], ['/nope', 'noindex']]) {
    for (const method of ['GET', 'HEAD']) {
      const response = await visit(`https://domino.money${path}`, SEARCH, { method });
      assert.equal(response.headers.get('X-Robots-Tag'), robots, `${method} ${path} with search on`);
    }
  }
  // Where the files still answer with no page, there is no table to read: passed on as before, noindex kept.
  const bodiless = await visit('https://domino.money/nope', OPEN, { method: 'HEAD', next: serve('', 200) });
  assert.deepEqual([bodiless.status, bodiless.headers.get('X-Robots-Tag')], [200, 'noindex, nofollow']);
  // A file's HEAD goes on as sent.
  asked = [];
  await visit('https://domino.money/og.png', OPEN, { method: 'HEAD', next: serve('x', 200, 'image/png') });
  assert.deepEqual(asked, ['next()']);
});

test('anything but a page with its table is passed on as it came: files, API answers, other HTML, a page without the marks', async () => {
  const other = '<!doctype html><title>app</title>';
  const plain = await visit('https://domino.money/nope', OPEN, { next: serve(other) });
  assert.deepEqual([plain.status, await plain.text()], [200, other], 'no table: the page as before');
  const broken = await visit('https://domino.money/markets', OPEN, { next: serve(PAGE.replace('<!--/dm-head-->', '')) });
  assert.equal(broken.status, 200);
  assert.equal(headOf(await broken.text()).tables, 1, 'no marks: left as it came');
  const gone = await visit('https://domino.money/markets', OPEN, { next: serve('nope', 404, 'text/plain') });
  assert.equal(gone.status, 404);
  for (const path of ['/sitemap.xml', '/og.png', '/favicon.svg', '/assets/index-a.js', '/docs/markets.webp']) {
    const response = await visit(`https://domino.money${path}`, OPEN, { next: serve('file', 200, 'application/octet-stream') });
    assert.deepEqual([response.status, await response.text()], [200, 'file'], path);
  }
});

// ---------------------------------------------------------------------------
// noindex: lifted only on domino.money, with search on, for the listed pages, the favicon and the picture.
// ---------------------------------------------------------------------------

const robotsAt = async (url, env, next = serve()) => (await onRequest({ request: new Request(url, { headers: { 'Sec-Fetch-Mode': 'navigate', Accept: 'text/html' } }), env, next })).headers.get('X-Robots-Tag');

test('search off (the default): every answer keeps noindex, nofollow, on domino.money too', async () => {
  for (const env of [OPEN, { ...OPEN, SEARCH_INDEX: 'ON' }, { ...OPEN, SEARCH_INDEX: ' on' }, { ...OPEN, SEARCH_INDEX: 'true' }, { ...OPEN, SEARCH_INDEX: '' }]) {
    for (const path of ['/', '/markets', '/docs/risks', '/pool/0x1', '/nope', '/favicon.svg', '/og.png']) {
      assert.equal(await robotsAt(`https://domino.money${path}`, env), 'noindex, nofollow', `${JSON.stringify(env)} ${path}`);
    }
  }
});

test('search on: only domino.money’s listed pages, its favicon and its picture are for search; every other host and answer is not', async () => {
  for (const [path, words] of Object.entries(table.headTable().pages)) assert.equal(await robotsAt(`https://domino.money${path}`, SEARCH), words.index ? null : 'noindex', path);
  for (const path of ['/favicon.svg', '/favicon.ico', '/og.png']) assert.equal(await robotsAt(`https://domino.money${path}`, SEARCH, serve('x', 200, 'image/png')), null, path);
  for (const path of ['/pool/0x1', '/positions/123', '/sequence', '/elysium', '/nope', '/docs/nope']) assert.equal(await robotsAt(`https://domino.money${path}`, SEARCH), 'noindex', `${path}: out of search, its links followed`);
  for (const path of ['/assets/index-a.js', '/tokens/eth.svg', '/docs/markets.webp']) assert.equal(await robotsAt(`https://domino.money${path}`, SEARCH, serve('x', 200, 'text/plain')), 'noindex, nofollow', path);
  // The sitemap: never a result itself, its addresses all followed.
  assert.equal(await robotsAt('https://domino.money/sitemap.xml', SEARCH, serve('<urlset/>', 200, 'application/xml')), 'noindex', 'the sitemap');
  assert.equal(await robotsAt('https://domino.money/sitemap.xml', SEARCH, serve('{}', 404, 'application/json')), 'noindex, nofollow', 'a sitemap not deployed');
  assert.equal(await robotsAt('https://domino.money/sitemap.xml', OPEN, serve('<urlset/>', 200, 'application/xml')), 'noindex, nofollow', 'the sitemap with search off');
  assert.equal(await robotsAt('https://preview.domino-app-e65.pages.dev/sitemap.xml', SEARCH, serve('<urlset/>', 200, 'application/xml')), 'noindex, nofollow', 'the preview’s sitemap');
  assert.equal(await robotsAt('https://domino.money/api/read/v1/capabilities', SEARCH, serve('{}', 200, 'application/json')), 'noindex, nofollow', 'the API');
  assert.equal(await robotsAt('https://domino.money/favicon.svg', SEARCH, serve('x', 404, 'text/plain')), 'noindex, nofollow', 'a missing file');
  for (const host of ['preview.domino-app-e65.pages.dev', 'domino-app-e65.pages.dev', 'a1b2c3d4.domino-app-e65.pages.dev', 'vm-read.domino.money', 'www.domino.money', 'domino.money.evil.example', 'example.com', '127.0.0.1']) {
    for (const path of ['/', '/markets', '/docs/risks', '/og.png', '/favicon.svg']) {
      assert.equal(await robotsAt(`https://${host}${path}`, SEARCH), 'noindex, nofollow', `${host}${path}`);
    }
  }
  // A page kept out of search by its own words (the Points page since 2026-11-07, a main page with `index: false`, through
  // the build's own pageWords and headTable): its head, its canonical address, and noindex, for a GET and a HEAD.
  const kept = table.headTable();
  assert.equal(kept.routes.points, 'points', 'the route table names it');
  const page = PAGE.replace(/<script type="application\/json" id="dm-head">[^<]*<\/script>/, seo.tableTag(kept));
  const response = await onRequest({ request: new Request('https://domino.money/points', { headers: { 'Sec-Fetch-Mode': 'navigate' } }), env: SEARCH, next: serve(page) });
  const head = headOf(await response.text());
  assert.deepEqual([response.status, response.headers.get('X-Robots-Tag'), head.title, head.robots, head.canonical], [200, 'noindex', 'Points · Domino', 'noindex', 'https://domino.money/points']);
  const headed = await onRequest({ request: new Request('https://domino.money/points', { method: 'HEAD', headers: { 'Sec-Fetch-Mode': 'navigate' } }), env: SEARCH, next: serve(page) });
  assert.deepEqual([headed.status, headed.headers.get('X-Robots-Tag')], [200, 'noindex']);
  // The pages beside it keep their place in search.
  const markets = await onRequest({ request: new Request('https://domino.money/markets', { headers: { 'Sec-Fetch-Mode': 'navigate' } }), env: SEARCH, next: serve(page) });
  assert.deepEqual([markets.status, markets.headers.get('X-Robots-Tag'), headOf(await markets.text()).robots], [200, null, null]);
});

test('the access page and the gate’s own answers keep noindex, nofollow, and the gate admits and refuses exactly as before', async () => {
  const ENV = { BETA_PASSWORD: 'correct-horse-battery-staple-42', BETA_COOKIE_KEY: 'q3VfK9mJx7Rt2WbN5cYp8LhD4sGa6ZeU1oTiQwErTyA', SEARCH_INDEX: 'on' };
  const gated = await onRequest({ request: new Request('https://domino.money/markets', { headers: { 'Sec-Fetch-Mode': 'navigate' } }), env: ENV, next: serve() });
  const html = await gated.text();
  assert.equal(gated.status, 401);
  assert.equal(gated.headers.get('X-Robots-Tag'), 'noindex, nofollow');
  assert.deepEqual(asked, [], 'nothing of the app served');
  // The asked page goes through the password as the route the gate already carries; Home carries none, as before.
  assert.match(html, /<input id="next" name="next" type="hidden" value="#\/markets" \/>/);
  // A path with an empty segment (`//evil/`) carries none: after the password it would read as another host's address.
  for (const [path, next] of [['/', ''], ['/explore', '#/markets'], ['/docs/risks', '#/docs/risks'], ['/pool/0xab/0xcd', '#/pool/0xab/0xcd'], ['/api/read/x', ''], ['/og.png', ''], ['/a"b', ''], ['//evil/', ''], ['//evil.example/x', ''], ['/docs//risks', '']]) {
    const page = await (await onRequest({ request: new Request(`https://domino.money${path}`, { headers: { 'Sec-Fetch-Mode': 'navigate' } }), env: ENV, next: serve() })).text();
    assert.ok(page.includes(`<input id="next" name="next" type="hidden" value="${next}" />`), `${path} carries "${next}"`);
  }
  const fetched = await onRequest({ request: new Request('https://domino.money/markets', { headers: { 'Sec-Fetch-Mode': 'cors' } }), env: ENV, next: serve() });
  assert.deepEqual([fetched.status, fetched.headers.get('X-Robots-Tag')], [401, 'noindex, nofollow'], 'a fetch is refused as JSON, as before');
  const login = await onRequest({ request: new Request('https://domino.money/__beta/login'), env: OPEN, next: serve() });
  assert.deepEqual([login.status, login.headers.get('Location'), login.headers.get('X-Robots-Tag')], [303, '/', 'noindex, nofollow']);
});

// ---------------------------------------------------------------------------
// The address bar in one module (src/lib/route.ts).
// ---------------------------------------------------------------------------

/** A browser's location and history, enough for the route module: entries, state, popstate and hashchange. */
function browserAt(href, state = null) {
  const events = new EventTarget();
  const entries = [{ url: new URL(href), state }];
  let at = 0;
  /** As a browser's history does: another origin's address (`//host`, `/\host`) is refused with a SecurityError. */
  const within = (url) => {
    if (url == null) return entries[at].url;
    const to = new URL(url, entries[at].url);
    if (to.origin !== entries[at].url.origin) throw new DOMException(`A history state object with URL '${to.href}' cannot be created`, 'SecurityError');
    return to;
  };
  const win = {
    told: [],
    location: {
      get pathname() { return entries[at].url.pathname; },
      get search() { return entries[at].url.search; },
      get hash() { return entries[at].url.hash; },
      get href() { return entries[at].url.href; },
    },
    history: {
      get state() { return entries[at].state; },
      get length() { return entries.length; },
      pushState(next, _title, url) { const to = within(url); entries.splice(at + 1); entries.push({ url: to, state: next }); at += 1; },
      replaceState(next, _title, url) { entries[at] = { url: within(url), state: next }; },
    },
    addEventListener: (...args) => events.addEventListener(...args),
    removeEventListener: (...args) => events.removeEventListener(...args),
    dispatchEvent: (event) => events.dispatchEvent(event),
    /** A link from before followed, or `location.hash = …`: a new entry, then popstate and hashchange, as Chromium does. */
    followHash(hash) { win.history.pushState(null, '', hash); events.dispatchEvent(new Event('popstate')); events.dispatchEvent(new Event('hashchange')); },
    go(delta) { at += delta; events.dispatchEvent(new Event('popstate')); },
    get address() { return `${win.location.pathname}${win.location.search}${win.location.hash}`; },
  };
  return win;
}

/** The route module, loaded fresh into `win` (its last told route is module state). */
function routesIn(win) {
  globalThis.window = win;
  const path = require.resolve('../.test-build/app/src/lib/route.js');
  delete require.cache[path];
  const route = require(path);
  win.addEventListener(route.ROUTE_EVENT, (event) => win.told.push(event.detail));
  return route;
}

test('every route reads in the hash router’s form, from a clean address or a link from before', () => {
  const win = browserAt('https://domino.money/docs/risks#who');
  const route = routesIn(win);
  try {
    assert.equal(route.currentRoute(), '#/docs/risks#who');
    for (const [where, form] of [[{ pathname: '/', hash: '' }, '#/'], [{ pathname: '/', hash: '#learn' }, '#/#learn'], [{ pathname: '/markets', hash: '' }, '#/markets'], [{ pathname: '/', hash: '#/markets' }, '#/markets'], [{ pathname: '/positions', hash: '#/docs' }, '#/docs'], [{ pathname: '/pool/0xab/0xcd', hash: '' }, '#/pool/0xab/0xcd']]) {
      assert.equal(route.routeOf(where), form, JSON.stringify(where));
    }
    for (const [href, form] of [['/markets', '#/markets'], ['/', '#/'], ['/#learn', '#/#learn'], ['/docs/fees#network-gas', '#/docs/fees#network-gas'], ['#/markets', '#/markets'], ['/explore', '#/markets'], ['#/docs/stop-loss#x', '#/docs/auto-exit#x'], ['/markets/', '#/markets'], ['https://domino.money/markets', null], ['//evil.example/x', null], ['/\\evil.example/x', null], ['/\t/evil.example', null], ['#//evil.example/x', null], ['#/\\evil.example', null], ['#//markets', null], ['/api/read/v1/pools', null], ['/uniswap-v3/x', null], ['/__beta/login', null], ['/docs/markets.webp', null], ['/sitemap.xml', null], ['#learn', null], ['mailto:x@y.z', null], ['', null]]) {
      assert.equal(route.routeOfHref(href), form, href);
    }
  } finally {
    delete globalThis.window;
  }
});

test('a link from before becomes the page’s own address in place: no reload, no new entry, its state kept, aliases resolved', () => {
  for (const [from, to] of [['/#/markets', '/markets'], ['/#/', '/'], ['/#/#learn', '/#learn'], ['/#/docs/risks#who', '/docs/risks#who'], ['/#/explore', '/markets'], ['/#/pools#0x' + 'ab'.repeat(32), '/markets#0x' + 'ab'.repeat(32)], ['/#/app', '/positions'], ['/#/portfolio', '/positions'], ['/#/settings', '/docs'], ['/#/docs/stop-loss', '/docs/auto-exit'], ['/#/positions/123', '/positions/123'], ['/#/explore/0x' + '11'.repeat(20), '/explore/0x' + '11'.repeat(20)], ['/?utm=x#/markets', '/markets?utm=x'], ['/markets/', '/markets'], ['/explore', '/markets'], ['/markets', '/markets'], ['/docs#x', '/docs#x']]) {
    const win = browserAt(`https://domino.money${from}`, { kept: from });
    const route = routesIn(win);
    try {
      route.installRoutes();
      assert.equal(win.address, to, from);
      assert.deepEqual([win.history.length, win.history.state], [1, { kept: from }], `${from}: the same entry, its state kept`);
      assert.deepEqual(win.told, [], `${from}: no move told at start`);
    } finally {
      delete globalThis.window;
    }
  }
});

// Review 2026-11-07 (gate/security D1, compatibility 1): a link from before with a second slash or a backslash after `#/`
// (`/#//markets` mistyped, `/#//evil.example/x` crafted) names another host as a path; history refuses it with an error,
// which at start stopped the app before it drew anything. Such an address is left as it is, and the app reads it as it
// always did (Home for `#//…`, not found for `#/\…`, as production does today).
test('a link from before that names another host as a path is left as it is: nothing thrown, nothing written, the route read as before', () => {
  for (const from of ['/#//markets', '/#//evil', '/#//evil.example/x', '/#/\\evil.example', '/#/\\evil.example/x#y', '/?ref=1#//evil.example']) {
    const win = browserAt(`https://domino.money${from}`, { kept: from });
    const route = routesIn(win);
    try {
      const before = win.address;
      assert.doesNotThrow(() => route.installRoutes(), from);
      assert.deepEqual([win.address, win.history.length, win.history.state], [before, 1, { kept: from }], `${from}: left as it is`);
      assert.equal(route.currentRoute(), new URL(`https://domino.money${from}`).hash, `${from}: read as before`);
      // Typed again while the app is open: the move is told, and nothing throws.
      win.followHash('#//evil.example/y');
      assert.deepEqual([win.address.endsWith('#//evil.example/y'), win.told.at(-1)?.to], [true, '#//evil.example/y'], from);
      // A move to such an address is refused, and the open one stays; a move of the site's goes on.
      assert.equal(route.navigate('//evil.example/z'), false);
      assert.equal(route.navigate('#/\\evil.example/z', { replace: true }), false);
      assert.ok(win.address.endsWith('#//evil.example/y'));
      assert.equal(route.navigate('/markets'), true);
      assert.equal(win.address, '/markets');
    } finally {
      delete globalThis.window;
    }
  }
});

test('moves: a link pushes one entry and is told once; the open address again is nothing; replace and quiet; Back is told only when the route changed', () => {
  const win = browserAt('https://domino.money/');
  const route = routesIn(win);
  try {
    route.installRoutes();
    route.navigate('/markets');
    assert.deepEqual([win.address, win.history.length, win.told], ['/markets', 2, [{ from: '#/', to: '#/markets' }]]);
    route.navigate('/markets');
    assert.deepEqual([win.history.length, win.told.length], [2, 1], 'the open address again changes nothing');
    route.navigate('#/explore/0x' + '11'.repeat(20));
    assert.equal(win.address, '/explore/0x' + '11'.repeat(20), 'a link from before, written clean');
    route.navigate('/docs/stop-loss#x', { replace: true });
    assert.deepEqual([win.address, win.history.length, win.history.state], ['/docs/auto-exit#x', 3, null], 'replaced in place, as location.replace');
    route.navigate('/portfolio/0x1', { quiet: true });
    assert.deepEqual([win.address, win.told.length], ['/portfolio/0x1', 3], 'quiet: the address alone');
    win.go(-1);
    assert.deepEqual(win.told.at(-1), { from: '#/portfolio/0x1', to: '#/docs/auto-exit#x' }, 'Back from a quiet entry is a move');
    // New position's steps: entries of one address, their state only. Back between them is no move.
    win.history.pushState({ dmStep: 'range' }, '');
    const before = win.told.length;
    win.go(-1);
    assert.equal(win.told.length, before, 'a step entry is not a page change');
    // A hash assigned while open (an old link, a test's location.hash): the clean address, the route told once.
    win.followHash('#/positions');
    assert.deepEqual([win.address, win.told.at(-1)], ['/positions', { from: '#/docs/auto-exit#x', to: '#/positions' }]);
    assert.equal(win.told.filter((change) => change.to === '#/positions').length, 1, 'popstate and hashchange tell it once');
    win.followHash('#top');
    assert.deepEqual([win.address, win.told.at(-1).to], ['/positions#top', '#/positions#top'], 'a section is a move, as before');
    // onRoute's once and its stop.
    const heard = [];
    const stop = route.onRoute((change) => heard.push(change.to));
    route.onRoute((change) => heard.push(`once ${change.to}`), true);
    route.navigate('/automate');
    route.navigate('/new');
    stop();
    route.navigate('/docs');
    assert.deepEqual(heard, ['#/automate', 'once #/automate', '#/new']);
  } finally {
    delete globalThis.window;
  }
});

// ---------------------------------------------------------------------------
// One module reads and writes the address (PROPOSAL.md §8, item 9).
// ---------------------------------------------------------------------------

/** Every .ts and .tsx file under `dir`. */
const sources = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? sources(join(dir, entry.name)) : /\.tsx?$/.test(entry.name) && !entry.name.endsWith('.d.ts') ? [join(dir, entry.name)] : []));

test('nothing but src/lib/route.ts reads location.hash, listens to hashchange or writes a "#/" route', () => {
  const SRC = join(APP, 'src');
  // The read lab (read-lab.html, fixture builds only) routes its own page by its own hash, `#screens/<case>`.
  const allowed = new Set(['lib/route.ts']);
  const found = [];
  for (const file of sources(SRC)) {
    const name = relative(SRC, file).split('\\').join('/');
    if (allowed.has(name) || name.startsWith('lab/')) continue;
    const ast = parse(readFileSync(file, 'utf8'), { sourceType: 'module', plugins: ['typescript', ...(file.endsWith('.tsx') ? ['jsx'] : [])] });
    const visit = (node) => {
      if (!node || typeof node.type !== 'string') return;
      const at = `${name}:${node.loc?.start.line}`;
      if ((node.type === 'StringLiteral' || node.type === 'JSXText') && (node.value.includes('#/') || node.value === 'hashchange')) found.push(`${at} "${node.value}"`);
      if (node.type === 'TemplateElement' && node.value.cooked?.includes('#/')) found.push(`${at} \`${node.value.cooked}\``);
      if (node.type === 'MemberExpression' && !node.computed && node.property.name === 'hash' && ((node.object.type === 'Identifier' && node.object.name === 'location') || (node.object.type === 'MemberExpression' && node.object.property?.name === 'location'))) found.push(`${at} location.hash`);
      for (const [key, value] of Object.entries(node)) {
        if (key === 'loc' || key === 'start' || key === 'end' || key === 'leadingComments' || key === 'trailingComments' || key === 'innerComments') continue;
        if (Array.isArray(value)) value.forEach(visit);
        else if (value && typeof value === 'object') visit(value);
      }
    };
    visit(ast.program);
  }
  assert.deepEqual(found, []);
});
