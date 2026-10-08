/**
 * The closed-beta access gate, exercised through the middleware exactly as
 * Cloudflare calls it: a Request in, a Response out, and a `next` that stands
 * in for the static files. Every test that expects a refusal also asserts
 * that `next` was never called, so "refused" always means "nothing served".
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { beforeEach, test } from 'node:test';

const require = createRequire(import.meta.url);
const gate = require('../.test-build/app/functions/_lib/gate.js');
const { onRequest, APP_CSP, APP_CSP_SOURCES, ICON_CACHE, LOGIN_PATH, LOGOUT_PATH, PERMISSIONS_POLICY, STATIC_CSP, cspOf, loginLimiter } = require('../.test-build/app/functions/_middleware.js');
const middlewareExports = require('../.test-build/app/functions/_middleware.js');
const { BOOT_SCRIPT, BOOT_SCRIPT_HASH } = require('../.test-build/app/functions/_lib/boot.js');
const { createHash } = require('node:crypto');
/** A CSP hash source for an inline script's exact text. */
const hashOf = (text) => `'sha256-${createHash('sha256').update(text, 'utf8').digest('base64')}'`;
/** Remove only the response's nonce when comparing the fixed policy. */
const withoutNonce = (policy) => policy.replace(/ 'nonce-[A-Za-z0-9+/]+={0,2}'/, '');

const PASSWORD = 'correct-horse-battery-staple-42';
const KEY = 'q3VfK9mJx7Rt2WbN5cYp8LhD4sGa6ZeU1oTiQwErTyA';
const ENV = { BETA_PASSWORD: PASSWORD, BETA_COOKIE_KEY: KEY };
const ORIGIN = 'https://domino.money';

let served = 0;
const next = async () => {
  served += 1;
  return new Response('<!doctype html><title>app</title>', {
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'public, max-age=0' },
  });
};
beforeEach(() => {
  served = 0;
});

const run = (request, env = ENV) => onRequest({ request, env, next });

const navigate = (path = '/', headers = {}) =>
  new Request(`${ORIGIN}${path}`, { headers: { 'Sec-Fetch-Mode': 'navigate', Accept: 'text/html', ...headers } });

const fetchLike = (path, headers = {}) =>
  new Request(`${ORIGIN}${path}`, { headers: { 'Sec-Fetch-Mode': 'no-cors', Accept: '*/*', ...headers } });

const loginPost = (password, headers = {}) =>
  new Request(`${ORIGIN}${LOGIN_PATH}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: ORIGIN, ...headers },
    body: `password=${encodeURIComponent(password)}`,
  });

/** Logs in and returns the `name=value` pair the browser would send back. */
async function signIn(env = ENV) {
  const response = await run(loginPost(env.BETA_PASSWORD), env);
  assert.equal(response.status, 303);
  return response.headers.get('Set-Cookie').split(';')[0];
}

// ---------------------------------------------------------------------------
// Configuration: a broken deployment is closed, never open.
// ---------------------------------------------------------------------------

test('without configuration every path is refused, including the login form', async () => {
  for (const env of [{}, { BETA_PASSWORD: PASSWORD }, { BETA_COOKIE_KEY: KEY }]) {
    for (const request of [navigate('/'), fetchLike('/assets/index.js'), fetchLike('/api/read/v1/pools'), loginPost(PASSWORD)]) {
      const response = await run(request, env);
      assert.equal(response.status, 503, `${request.method} ${new URL(request.url).pathname}`);
    }
  }
  assert.equal(served, 0, 'a misconfigured deployment served app content');
});

test('a weak password, a short key, or one secret reused as the other is refused', async () => {
  const weak = [
    { BETA_PASSWORD: 'short-password', BETA_COOKIE_KEY: KEY },
    { BETA_PASSWORD: PASSWORD, BETA_COOKIE_KEY: 'too-short-key' },
    { BETA_PASSWORD: KEY, BETA_COOKIE_KEY: KEY },
    { BETA_PASSWORD: PASSWORD, BETA_COOKIE_KEY: 'x'.repeat(600) },
  ];
  for (const env of weak) {
    assert.equal(await gate.readConfig(env), null, JSON.stringify(Object.keys(env)));
    assert.equal((await run(navigate('/'), env)).status, 503);
  }
  assert.equal(served, 0);
});

test('the unavailable page offers no form to submit', async () => {
  const text = await (await run(navigate('/'), {})).text();
  assert.doesNotMatch(text, /<form/);
  assert.match(text, /Access is paused/);
});

/** The access page in each of its four states, as the gate answers them. */
async function accessPages() {
  const address = { 'CF-Connecting-IP': '198.51.100.250' };
  for (let i = 0; i < gate.LOGIN_LIMIT.failures; i++) await run(loginPost('wrong', address));
  const wait = await run(loginPost('wrong', address));
  assert.equal(wait.status, 429);
  return {
    ask: await (await run(navigate('/'))).text(),
    wrong: await (await run(loginPost('wrong'))).text(),
    wait: await wait.text(),
    unavailable: await (await run(navigate('/'), {})).text(),
  };
}

/** What a visitor reads: the markup and styles removed, so the login path's name does not count. */
const wordsOf = (html) => html.replace(/<style>[\s\S]*<\/style>/, ' ').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ');

test('the access page calls nothing a beta and asks no one to come back later, in any state', async () => {
  const pages = await accessPages();
  for (const [state, html] of Object.entries(pages)) {
    // The app recognises this page by its exact title (GATE_PAGE_MARKER in src/lib/read/interpret.ts).
    assert.match(html, /<title>Domino · Access<\/title>/, state);
    const words = wordsOf(html);
    assert.doesNotMatch(words, /\bbeta\b|\blater\b|temporarily/i, state);
    assert.match(words, /Invitation only/, state);
  }
  // Changed on purpose 2026-10-03 (the owner's review of the access page: fewer words): one short line, and the
  // headline's full stop in Tangerine, as the wordmark's.
  assert.match(pages.ask, /<h1>You’re early<span class="dot">\.<\/span><\/h1>\s*<p class="lede">Enter the password from your invitation\.<\/p>/);
  assert.match(pages.unavailable, /<h1>Access is paused<span class="dot">\.<\/span><\/h1>\s*<p class="lede">Nothing is wrong on your side\.<\/p>/);
});

// 2026-10-03 (the owner: "It also says 'Robinhood Chain': that isn't needed, Domino is becoming multi-chain."): no state
// of the access page names a chain, and the redesigned page (a drawing, its motion, icons) is still all inline: nothing
// is asked of another host, no style sits in an attribute, and the only scheme in it is the SVG namespace inside the
// favicon's data: URL.
test('the access page names no chain and asks nothing of another host, in any state', async () => {
  const pages = await accessPages();
  for (const [state, html] of Object.entries(pages)) {
    assert.doesNotMatch(wordsOf(html), /robinhood|\bchains?\b/i, state);
    assert.doesNotMatch(html, /robinhood/i, state);
    const references = [...html.matchAll(/\b(?:src|href|action)="([^"]*)"|url\(([^)]*)\)/g)].map((match) => match[1] ?? match[2]);
    assert.ok(references.length > 0, state);
    for (const reference of references) assert.match(reference, /^'?(?:\/(?!\/)|#|data:)/, `${state}: ${reference}`);
    assert.deepEqual([...new Set(html.match(/https?:\/\/[^\s'"]+/g))], ['http://www.w3.org/2000/svg'], state);
    assert.doesNotMatch(html, /\sstyle="/, `${state}: a style attribute`);
    assert.equal((html.match(/<script\b/g) ?? []).length, 1, `${state}: its one script`);
  }
  // The two fonts where the gate serves them; while access is paused it refuses them too (rule 1), so that page names
  // none, and asks for nothing at all but itself.
  for (const state of ['ask', 'wrong', 'wait']) for (const font of gate.GATE_FONTS) assert.ok(pages[state].includes(font), `${state}: ${font}`);
  for (const font of gate.GATE_FONTS) assert.ok(!pages.unavailable.includes(font), `unavailable: ${font}`);
});

// 2026-10-03: the app reads at most MAX_PAGE_BYTES of an HTML 503 to find the gate's title in it (src/lib/read/interpret.ts,
// src/lib/http/rawReply.ts); a longer body is refused whole as too large, and "Access is paused" would become a generic
// failure. The redesigned page carries only what its state uses, so the paused one stays well inside that.
test('the paused page fits inside what the app reads of a 503 to recognise the gate', async () => {
  const { MAX_PAGE_BYTES, GATE_PAGE_MARKER } = require('../.test-build/app/src/lib/read/interpret.js');
  const { MAX_PAGE_BYTES: RAW_MAX_PAGE_BYTES } = require('../.test-build/app/src/lib/http/rawReply.js');
  const response = await run(fetchLike('/api/read/v1/capabilities'), {});
  assert.equal(response.status, 503);
  assert.match(response.headers.get('Content-Type'), /^text\/html/);
  const bytes = Buffer.byteLength(await response.text(), 'utf8');
  for (const limit of [MAX_PAGE_BYTES, RAW_MAX_PAGE_BYTES]) assert.ok(bytes <= limit - 2048, `${bytes} bytes, against ${limit} (2 KiB kept spare)`);
  assert.ok((await (await run(navigate('/'), {})).text()).includes(GATE_PAGE_MARKER));
});

// 2026-10-03: the access page's drawing moves on a first visit only, a few loops, then rests on its complete picture;
// nothing moves at all where the system asks for reduced motion.
test('the access page’s motion plays a few times on a first visit, never forever, and stops under reduced motion', async () => {
  const pages = await accessPages();
  for (const [state, html] of Object.entries(pages)) {
    const style = /<style>([\s\S]*)<\/style>/.exec(html)[1];
    assert.doesNotMatch(style, /infinite/, `${state}: a loop without end`);
    assert.match(style, /@media \(prefers-reduced-motion: reduce\) \{ \*, \*::before, \*::after \{ animation: none !important; transition: none !important; \} \}\s*$/, `${state}: reduced motion stills everything, last`);
    for (const [, count] of style.matchAll(/animation: g-[a-z0-9-]+ [\d.]+s linear [\d.]+s (\S+);/g)) assert.ok(Number(count) <= 3, `${state}: ${count} loops`);
    // The loop belongs to the first visit: sent with that page alone, every selector that starts it naming data-state="ask"
    // (the run, its six tiles, the lit tile, its face and its glow).
    const loops = [...style.matchAll(/[^;{}]*\{ animation: g-(?:run|tip-\d|lit|lit-body|warm) [^}]*\}/g)].map((match) => match[0]);
    assert.equal(loops.length, state === 'ask' ? 10 : 0, `${state}: ${loops.length} looping parts`);
    for (const rule of loops) assert.match(rule, /body\[data-state="ask"\]/, rule);
    assert.match(html, new RegExp(`<body data-state="${state}">`), state);
  }
});

// ---------------------------------------------------------------------------
// Without the cookie nothing of the app leaves the server.
// ---------------------------------------------------------------------------

test('a page navigation without access gets the access page, not the app', async () => {
  const response = await run(navigate('/'));
  assert.equal(response.status, 401);
  assert.equal(served, 0);
  assert.match(response.headers.get('Content-Type'), /text\/html/);
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  assert.equal(response.headers.get('Content-Security-Policy'), gate.PAGE_CSP);
  const text = await response.text();
  assert.match(text, /<form method="post" action="\/__beta\/login"/);
  assert.match(text, /type="password"/);
  // Changed on purpose 2026-10-01 (platform workstream, D3): one script, the one that carries the opened link through
  // the login, and the page's CSP admits exactly its text, by its hash, and nothing else that runs.
  const scripts = [...text.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)].map((match) => match[1]);
  assert.deepEqual(scripts, [gate.GATE_SCRIPT], 'the access page runs its one script and no other');
  assert.equal(gate.GATE_SCRIPT_HASH, hashOf(gate.GATE_SCRIPT), 'PAGE_CSP names the script’s own hash');
  assert.ok(gate.PAGE_CSP.split('; ').includes(`script-src ${gate.GATE_SCRIPT_HASH}`), gate.PAGE_CSP);
  assert.doesNotMatch(gate.PAGE_CSP, /unsafe-inline'[^;]*script|script-src[^;]*unsafe|connect-src|google/i);
  assert.doesNotMatch(gate.GATE_SCRIPT, /\b(?:fetch|XMLHttpRequest|cookie|localStorage|sessionStorage|eval|src|href)\b/, 'it reads the hash and writes one field, nothing else');
});

test('assets, tokens and API paths without access are refused as JSON', async () => {
  for (const path of ['/assets/index-abc123.js', '/assets/index.css', '/tokens/usdg.svg', '/favicon.svg', '/api/read/v1/pools', '/index.html']) {
    const response = await run(fetchLike(path));
    assert.equal(response.status, 401, path);
    assert.deepEqual(await response.json(), { error: 'beta_access_required' }, path);
  }
  assert.equal(served, 0, 'an asset was served without access');
});

test('a HEAD request without access is refused too', async () => {
  const response = await run(new Request(`${ORIGIN}/`, { method: 'HEAD', headers: { 'Sec-Fetch-Mode': 'navigate' } }));
  assert.equal(response.status, 401);
  assert.equal(served, 0);
});

test('a navigation without Fetch Metadata falls back to the Accept header', async () => {
  const response = await run(new Request(`${ORIGIN}/`, { headers: { Accept: 'text/html,application/xhtml+xml' } }));
  assert.equal(response.status, 401);
  assert.match(await response.text(), /Access password/);
});

// ---------------------------------------------------------------------------
// Login.
// ---------------------------------------------------------------------------

test('the right password sets exactly the cookie the spec describes and returns home', async () => {
  const response = await run(loginPost(PASSWORD));
  assert.equal(response.status, 303);
  assert.equal(response.headers.get('Location'), '/');
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  const cookie = response.headers.get('Set-Cookie');
  assert.match(cookie, /^__Host-domino-beta=v1\.\d+\.[A-Za-z0-9_-]{43}; /);
  for (const attribute of ['Path=/', 'Secure', 'HttpOnly', 'SameSite=Lax', `Max-Age=${gate.SESSION_SECONDS}`]) {
    assert.ok(cookie.split('; ').includes(attribute), `missing ${attribute}`);
  }
  assert.doesNotMatch(cookie, /Domain=/i, 'a __Host- cookie must not carry Domain');
  assert.equal(served, 0, 'login itself must not serve the app');
});

test('a wrong password is refused with the page and a generic error', async () => {
  for (const attempt of ['', 'wrong', PASSWORD.slice(0, -1), `${PASSWORD} `, PASSWORD.toUpperCase()]) {
    const response = await run(loginPost(attempt));
    assert.equal(response.status, 401, JSON.stringify(attempt));
    assert.equal(response.headers.get('Set-Cookie'), null);
    const text = await response.text();
    assert.match(text, /That password didn’t work/);
    assert.match(text, /aria-invalid="true"/);
  }
  assert.equal(served, 0);
});

test('a login posted from another site is refused', async () => {
  assert.equal((await run(loginPost(PASSWORD, { Origin: 'https://evil.example' }))).status, 403);
  assert.equal((await run(loginPost(PASSWORD, { 'Sec-Fetch-Site': 'cross-site' }))).status, 403);
  assert.equal((await run(loginPost(PASSWORD, { 'Sec-Fetch-Site': 'same-site' }))).status, 403);
});

test('a login that is not a small form post is refused', async () => {
  const json = new Request(`${ORIGIN}${LOGIN_PATH}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: ORIGIN },
    body: JSON.stringify({ password: PASSWORD }),
  });
  assert.equal((await run(json)).status, 415);

  // Larger than the limit, delivered without a Content-Length, so the
  // streaming cap is what has to stop it.
  const huge = loginPost(`${PASSWORD}&pad=${'x'.repeat(4000)}`);
  assert.equal((await run(huge)).status, 413);

  const declared = new Request(`${ORIGIN}${LOGIN_PATH}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: ORIGIN, 'Content-Length': '5000' },
    body: 'password=x',
  });
  assert.equal((await run(declared)).status, 413);
});

test('GET on the login path goes home instead of doing anything', async () => {
  const response = await run(navigate(LOGIN_PATH));
  assert.equal(response.status, 303);
  assert.equal(response.headers.get('Location'), '/');
});

// ---------------------------------------------------------------------------
// With the cookie.
// ---------------------------------------------------------------------------

test('with a valid cookie the app is served, with the security headers', async () => {
  const cookie = await signIn();
  const response = await run(navigate('/', { Cookie: cookie }));
  assert.equal(response.status, 200);
  assert.equal(served, 1);
  assert.equal(withoutNonce(response.headers.get('Content-Security-Policy')), APP_CSP);
  assert.equal(response.headers.get('Cache-Control'), 'private, no-cache');
  assert.equal(response.headers.get('Strict-Transport-Security'), 'max-age=31536000');
  assert.equal(response.headers.get('X-Content-Type-Options'), 'nosniff');
  assert.equal(response.headers.get('X-Frame-Options'), 'DENY');
  assert.equal(response.headers.get('X-Robots-Tag'), 'noindex, nofollow');
  assert.match(response.headers.get('Vary'), /Cookie/);
  assert.equal(response.headers.get('Permissions-Policy'), PERMISSIONS_POLICY);
  assert.equal(response.headers.get('Cross-Origin-Opener-Policy'), 'same-origin-allow-popups');
  assert.equal(response.headers.get('Cross-Origin-Resource-Policy'), 'same-origin');
});

test('the access page and refusals carry the same isolation headers as the app', async () => {
  for (const request of [navigate('/'), fetchLike('/assets/index.js')]) {
    const response = await run(request);
    assert.equal(response.status, 401);
    assert.equal(response.headers.get('Permissions-Policy'), PERMISSIONS_POLICY);
    assert.equal(response.headers.get('Cross-Origin-Opener-Policy'), 'same-origin-allow-popups');
    assert.equal(response.headers.get('Cross-Origin-Resource-Policy'), 'same-origin');
    assert.equal(response.headers.get('X-Frame-Options'), 'DENY');
  }
});

// Changed on purpose 2026-10-01 (platform workstream, I8): USB, HID, serial and Bluetooth are switched off too. They were
// left open for a wallet connection still to come; it came, and it reaches wallets only through their own providers
// (EIP-6963), so a hardware wallet behind an extension talks to its device from the extension, never from this page.
test('the permissions policy switches off sensors, payments and the device APIs the page never uses', () => {
  for (const feature of ['camera', 'microphone', 'geolocation', 'payment', 'usb', 'hid', 'serial', 'bluetooth']) {
    assert.match(PERMISSIONS_POLICY, new RegExp(`(^|, )${feature}=\\(\\)`), `${feature} is not switched off`);
  }
});

test('hashed assets stay cacheable, but only in the browser that authenticated', async () => {
  const cookie = await signIn();
  const response = await onRequest({
    request: fetchLike('/assets/index-abc123.js', { Cookie: cookie }),
    env: ENV,
    next: async () => new Response('x', { headers: { 'Content-Type': 'text/javascript', 'Cache-Control': 'public, max-age=0' } }),
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('Cache-Control'), 'private, max-age=31536000, immutable');
});

/** An admitted request for `path`, answered by the static files with `type`. */
async function admitted(path, type) {
  const cookie = await signIn();
  return onRequest({
    request: fetchLike(path, { Cookie: cookie }),
    env: ENV,
    next: async () => new Response('x', { headers: { 'Content-Type': type, 'Cache-Control': 'public, max-age=0' } }),
  });
}

// 2026-09-28 (speed wave, item 36): a content-hashed file is the same for everyone, and `private` already keeps it out
// of shared caches, so it no longer varies on Cookie: that made every chunk the browser held go back to the server,
// once each, after any cookie changed. Changed on purpose 2026-10-01 (platform workstream, F3, D1): the fixed public
// files (icons, the docs' pictures, the favicon) do not vary on it either, now that the beta cookie is renewed as it is
// used; a file the deployment does not hold, which Pages answers with the app's page, is a 404 no cache keeps.
test('hashed assets and fixed public files do not vary on the cookie; pages, other files and API answers do', async () => {
  for (const [path, type] of [
    ['/assets/index-abc123.js', 'text/javascript'],
    ['/assets/index-abc123.css', 'text/css'],
    ['/assets/geist-latin-AbC_12.woff2', 'font/woff2'],
    ['/assets/feesReplay.worker-CdlBbZHL.js', 'text/javascript'],
  ]) {
    const response = await admitted(path, type);
    assert.equal(response.headers.get('Vary'), null, path);
    assert.equal(response.headers.get('Cache-Control'), 'private, max-age=31536000, immutable', path);
  }
  for (const [path, type] of [['/tokens/weth.svg', 'image/svg+xml'], ['/wallets/rabby.svg', 'image/svg+xml'], ['/docs/markets.webp', 'image/webp'], ['/favicon.svg', 'image/svg+xml']]) {
    assert.equal((await admitted(path, type)).headers.get('Vary'), null, path);
  }
  for (const [path, type] of [
    ['/', 'text/html; charset=utf-8'],
    ['/robots.txt', 'text/plain'],
    ['/api/read/v1/capabilities', 'application/json'],
  ]) {
    assert.match((await admitted(path, type)).headers.get('Vary') ?? '', /Cookie/, path);
  }
  // A missing file, under /assets/ (an old release's chunk, D1) or anywhere else, answered with the app's page: a 404.
  for (const path of ['/assets/missing-abc.js', '/assets/missing.css', '/tokens/nosuchtoken.svg', '/docs/nosuch.webp', '/favicon.ico']) {
    const missing = await admitted(path, 'text/html; charset=utf-8');
    assert.equal(missing.status, 404, path);
    assert.equal(missing.headers.get('Cache-Control'), 'no-store', path);
    assert.deepEqual(await missing.json(), { error: 'not_found' }, path);
  }
  // Pages and paths with no file name stay the app's page.
  for (const path of ['/', '/index.html', '/positions', '/x.html']) assert.equal((await admitted(path, 'text/html; charset=utf-8')).status, 200, path);
});

// 2026-09-28 (speed wave, item 41): the tokens' and wallets' icons public/ serves under fixed names are kept a day, then
// used while they are checked again, instead of being asked through the gate on every page load. Changed on purpose
// 2026-10-01 (platform workstream, F3): the docs' pictures (one round trip each per docs page) and the favicon too. Any
// other public file is checked on every load. Every file that is not a page carries the static files' CSP (I8): an
// SVG opened on its own runs nothing.
test('icons, the docs’ pictures and the favicon are kept a day; other public files are checked on every load', async () => {
  for (const [path, type] of [['/tokens/weth.svg', 'image/svg+xml'], ['/tokens/marlin.jpg', 'image/jpeg'], ['/wallets/metamask.svg', 'image/svg+xml'], ['/docs/markets.webp', 'image/webp'], ['/favicon.svg', 'image/svg+xml']]) {
    const response = await admitted(path, type);
    assert.equal(response.headers.get('Cache-Control'), ICON_CACHE, path);
    assert.equal(response.headers.get('Content-Security-Policy'), STATIC_CSP, path);
  }
  assert.equal(ICON_CACHE, 'private, max-age=86400, stale-while-revalidate=604800');
  assert.equal(STATIC_CSP, "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; frame-ancestors 'none'");
  for (const [path, type] of [['/tokensx/weth.svg', 'image/svg+xml'], ['/x/tokens/weth.svg', 'image/svg+xml'], ['/robots.txt', 'text/plain']]) {
    const response = await admitted(path, type);
    assert.equal(response.headers.get('Cache-Control'), 'private, no-cache', path);
    assert.equal(response.headers.get('Content-Security-Policy'), STATIC_CSP, path);
  }
});

// 2026-09-28 (speed wave, item 35): the fonts are the site's own files (src/styles/fonts.css), so the page's CSP admits
// styles and fonts from this origin alone, and names no Google host.
test('the page takes its styles and fonts from this origin alone', () => {
  const parts = APP_CSP.split('; ');
  assert.ok(parts.includes("style-src 'self'"), APP_CSP);
  assert.ok(parts.includes("font-src 'self'"), APP_CSP);
  assert.doesNotMatch(APP_CSP, /google|gstatic|data:[^;]*font|font-src[^;]*data:/i);
});

// 2026-09-25: the page and the fees replay worker read Robinhood Chain's public RPC themselves (it rate-limits
// Cloudflare's edge); a dedicated worker keeps the CSP its own file is served with, so the worker's file carries one that
// loads nothing. No other script gets a CSP of its own. Changed on purpose 2026-10-01 (RPC-SPEC §7.4, the owner's rule:
// nothing is read from a public RPC): neither names any chain RPC any more; the chain is read through the site's own
// routes ('self'), and the worker reaches the site alone. Changed on purpose 2026-10-02 (RPC-SPEC §11.4): the fees worker
// is gone with the replay; every file under /assets/ carries the static files' CSP, a worker's name included.
test('the page reaches this site, and no chain RPC; there is no worker policy; nothing else is opened', async () => {
  const connect = APP_CSP.split('; ').find((part) => part.startsWith('connect-src '));
  // Changed on purpose (2026-10-01, audit C3): and WalletConnect's relay, with its Verify API's frame, for a phone's wallet.
  assert.equal(connect, "connect-src 'self' https://api.dexscreener.com wss://relay.walletconnect.org");
  assert.deepEqual(APP_CSP.split('; ').filter((part) => part.startsWith('frame-src ')), ['frame-src https://verify.walletconnect.org']);
  assert.equal(middlewareExports.WORKER_CSP, undefined, 'no worker policy');
  assert.doesNotMatch(APP_CSP, /robinhood|publicnode|ordofi|drpc/i, 'no Robinhood Chain RPC, nor any of its public fallbacks');
  const cookie = await signIn();
  const asset = (path) => onRequest({ request: fetchLike(path, { Cookie: cookie }), env: ENV, next: async () => new Response('x', { headers: { 'Content-Type': 'text/javascript' } }) });
  const worker = await asset('/assets/feesReplay.worker-CdlBbZHL.js');
  assert.equal(worker.headers.get('Content-Security-Policy'), STATIC_CSP, 'the old worker\'s name gets nothing of its own');
  assert.equal(worker.headers.get('Cache-Control'), 'private, max-age=31536000, immutable');
  // Changed on purpose 2026-10-01 (I8): every other file under /assets/ carries the static files' CSP, which a script the
  // page loads ignores (the page's policy governs it) and which keeps any of them inert when opened on its own.
  for (const path of ['/assets/index-abc123.js', '/assets/feesReplay.worker.js', '/assets/x/feesReplay.worker-abc.js', '/assets/feesReplay.worker-abc.js.map']) {
    assert.equal((await asset(path)).headers.get('Content-Security-Policy'), STATIC_CSP, path);
  }
});

// ---------------------------------------------------------------------------
// 2026-10-01, platform workstream: the page's CSP as data, its one inline script by hash (F1, F3).
// ---------------------------------------------------------------------------

test('the page’s fixed CSP admits the boot script by its exact hash', () => {
  assert.equal(APP_CSP, cspOf(APP_CSP_SOURCES));
  // 2026-10-01 (audit C3, the wallets workstream): and frame-src, WalletConnect's Verify API frame alone.
  assert.deepEqual(Object.keys(APP_CSP_SOURCES), ['default-src', 'script-src', 'style-src', 'font-src', 'img-src', 'connect-src', 'frame-src', 'object-src', 'frame-ancestors', 'base-uri', 'form-action']);
  assert.deepEqual(APP_CSP_SOURCES['script-src'], ["'self'", BOOT_SCRIPT_HASH]);
  assert.equal(BOOT_SCRIPT_HASH, hashOf(BOOT_SCRIPT), 'the hash is the boot script’s own');
  assert.doesNotMatch(APP_CSP, /'unsafe-inline'|'unsafe-eval'|'nonce-|'strict-dynamic'/, 'no shared nonce or broad inline permission');
  for (const [directive, list] of Object.entries(APP_CSP_SOURCES)) {
    assert.equal(new Set(list).size, list.length, `${directive} names a source twice`);
    // A host is an https origin; the one wss origin is WalletConnect's relay, in connect-src (2026-10-01, audit C3).
    for (const source of list) assert.match(source, /^(?:'[a-z-]+'|'sha256-[A-Za-z0-9+/]{43}='|data:|https:\/\/[a-z0-9.-]+)$|^wss:\/\/relay\.walletconnect\.org$/, `${directive} ${source}`);
    if (list.some((source) => source.startsWith('wss:'))) assert.equal(directive, 'connect-src', 'a wss source only where the page connects');
  }
});

// ---------------------------------------------------------------------------
// 2026-10-01, platform workstream: public files with no cookie (V5, I5).
// ---------------------------------------------------------------------------

test('the favicon and the access page’s two fonts are served without the cookie, kept a day, and nothing else is', async () => {
  for (const [path, type] of [['/favicon.ico', 'image/x-icon'], ['/__beta/fonts/geist-latin.woff2', 'font/woff2'], ['/__beta/fonts/instrument-serif-latin.woff2', 'font/woff2']]) {
    let handed = 0;
    const response = await onRequest({ request: fetchLike(path), env: ENV, next: async () => (handed++, new Response('x', { headers: { 'Content-Type': type } })) });
    assert.equal(response.status, 200, path);
    assert.equal(handed, 1, path);
    assert.equal(response.headers.get('Cache-Control'), ICON_CACHE, path);
    assert.equal(response.headers.get('Vary'), null, path);
    assert.equal(response.headers.get('Content-Security-Policy'), STATIC_CSP, path);
    assert.equal(response.headers.get('Cross-Origin-Resource-Policy'), 'same-origin', path);
    // Not served in place of a missing file: Pages' page for it becomes a 404.
    const missing = await onRequest({ request: fetchLike(path), env: ENV, next: async () => new Response('<!doctype html>', { headers: { 'Content-Type': 'text/html; charset=utf-8' } }) });
    assert.equal(missing.status, 404, path);
    // Only a GET or a HEAD, and only these exact paths.
    const posted = await onRequest({ request: new Request(`${ORIGIN}${path}`, { method: 'POST', body: 'x' }), env: ENV, next: async () => assert.fail('a POST went past the gate') });
    assert.equal(posted.status, 401, path);
  }
  for (const path of ['/favicon.svg', '/__beta/fonts/other.woff2', '/__beta/fonts/', '/__beta/fonts/geist-latin.woff2x', '/favicon.ico/x']) {
    const response = await run(fetchLike(path));
    assert.equal(response.status, 401, path);
  }
  assert.equal(served, 0);
  const config = await run(navigate('/favicon.ico'), {});
  assert.equal(config.status, 503, 'a deployment without its secrets still serves nothing');
});

// ---------------------------------------------------------------------------
// 2026-10-01, platform workstream: the week runs from the last visit, and the opened link survives the login (D3).
// ---------------------------------------------------------------------------

test('a page loaded with a cookie more than a day old gets a fresh one; nothing else renews it', async () => {
  const config = await gate.readConfig(ENV);
  const DAY = 86_400_000;
  const old = (await gate.issueCookie(config, Date.now() - 2 * DAY)).split(';')[0];
  const recent = (await gate.issueCookie(config, Date.now() - 3_600_000)).split(';')[0];
  const renewed = await run(navigate('/', { Cookie: old }));
  assert.equal(renewed.status, 200);
  const cookie = renewed.headers.get('Set-Cookie');
  assert.match(cookie ?? '', /^__Host-domino-beta=v1\.\d+\.[A-Za-z0-9_-]{43}; Path=\/; Secure; HttpOnly; SameSite=Lax; Max-Age=604800$/);
  const expires = Number(/v1\.(\d+)\./.exec(cookie)[1]);
  assert.ok(Math.abs(expires - (Math.floor(Date.now() / 1000) + gate.SESSION_SECONDS)) <= 5, 'a full week from now');
  assert.equal(await gate.hasValidCookie(config, cookie.split(';')[0], Date.now()), true);
  assert.equal((await run(navigate('/', { Cookie: recent }))).headers.get('Set-Cookie'), null, 'less than a day old: kept as it is');
  // A page the browser's copy answers (304) renews it too: most page loads after the first are those.
  const notModified = await onRequest({ request: navigate('/', { Cookie: old }), env: ENV, next: async () => new Response(null, { status: 304 }) });
  assert.match(notModified.headers.get('Set-Cookie') ?? '', /^__Host-domino-beta=v1\./);
  // A script, a style or an API call never carries one, nor does a refusal.
  for (const path of ['/assets/index-abc.js', '/api/read/v1/capabilities']) {
    const response = await onRequest({ request: fetchLike(path, { Cookie: old }), env: ENV, next: async () => new Response('{}', { headers: { 'Content-Type': 'application/json' } }) });
    assert.equal(response.headers.get('Set-Cookie'), null, path);
  }
  const failed = await onRequest({ request: navigate('/', { Cookie: old }), env: ENV, next: async () => new Response('down', { status: 500, headers: { 'Content-Type': 'text/plain' } }) });
  assert.equal(failed.headers.get('Set-Cookie'), null);
  assert.equal(gate.RENEW_AFTER_SECONDS, 86_400);
  assert.equal(gate.renewable(Math.floor(Date.now() / 1000) + gate.SESSION_SECONDS - 86_399, Date.now()), false);
  assert.equal(gate.renewable(Math.floor(Date.now() / 1000) + gate.SESSION_SECONDS - 86_401, Date.now()), true);
});

const loginWith = (fields, headers = {}) =>
  new Request(`${ORIGIN}${LOGIN_PATH}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: ORIGIN, ...headers },
    body: new URLSearchParams(fields).toString(),
  });

test('the login goes back to the link the visitor opened, and only to a link of this site’s own shape', async () => {
  for (const next of ['#/positions/3325113', '#/markets/0x5fc5360d0400a0fd4f2af552add042d716f1d168', '#/docs/wallet#sign-in', '#/', '#/new/0x031fe000f185cdf1b8850821d22bdf4ed1e337909be7caa00c2b68594da83f03']) {
    const response = await run(loginWith({ password: PASSWORD, next }));
    assert.equal(response.status, 303, next);
    assert.equal(response.headers.get('Location'), `/${next}`, next);
    assert.match(response.headers.get('Set-Cookie') ?? '', /^__Host-domino-beta=v1\./);
  }
  for (const next of ['', 'https://evil.example', '//evil.example', '/positions', '#positions', '#/x"><script>alert(1)</script>', '#/%2F%2Fevil', `#/${'a'.repeat(201)}`, '#/a#b#c', '#/a b', 'javascript:alert(1)']) {
    const response = await run(loginWith({ password: PASSWORD, next }));
    assert.equal(response.headers.get('Location'), '/', JSON.stringify(next));
  }
  // A wrong password keeps the link in the page it answers with, and only a link of that shape.
  const wrong = await (await run(loginWith({ password: 'wrong', next: '#/positions/42' }))).text();
  assert.match(wrong, /<input id="next" name="next" type="hidden" value="#\/positions\/42" \/>/);
  const hostile = await (await run(loginWith({ password: 'wrong', next: '#/x"><script>' }))).text();
  assert.match(hostile, /<input id="next" name="next" type="hidden" value="" \/>/);
  // The page's script copies the opened link into that field, the same shape only.
  const field = { value: '' };
  const runScript = (hash) => {
    field.value = '';
    new Function('document', 'location', gate.GATE_SCRIPT)({ getElementById: (id) => (id === 'next' ? field : null) }, { hash });
    return field.value;
  };
  assert.equal(runScript('#/positions/3325113'), '#/positions/3325113');
  assert.equal(runScript('#/docs/wallet#sign-in'), '#/docs/wallet#sign-in');
  for (const hash of ['', '#', '#x', '#/x"><b>', `#/${'a'.repeat(201)}`]) assert.equal(runScript(hash), '', hash);
});

// ---------------------------------------------------------------------------
// 2026-10-01, platform workstream: wrong passwords are limited per client address (I7).
// ---------------------------------------------------------------------------

test('after five wrong passwords from one address, that address waits a minute, whatever it sends; another does not', async () => {
  const address = '198.51.100.7';
  const from = (ip) => ({ 'CF-Connecting-IP': ip });
  for (let i = 0; i < gate.LOGIN_LIMIT.failures; i++) {
    const response = await run(loginWith({ password: 'wrong' }, from(address)));
    assert.equal(response.status, 401, `try ${i + 1}`);
  }
  for (const password of ['wrong', PASSWORD]) {
    const response = await run(loginWith({ password, next: '#/positions/1' }, from(address)));
    assert.equal(response.status, 429, password === PASSWORD ? 'even the right one' : 'a sixth');
    assert.equal(response.headers.get('Set-Cookie'), null);
    assert.match(response.headers.get('Retry-After') ?? '', /^(?:[1-5]?[0-9]|60)$/);
    const text = await response.text();
    assert.match(text, /Too many tries in a row\. Wait a minute, then try again\./);
    assert.match(text, /value="#\/positions\/1"/, 'the link is kept for the next try');
  }
  assert.equal((await run(loginWith({ password: PASSWORD }, from('198.51.100.8')))).status, 303, 'another address is not held');
  assert.equal((await run(loginWith({ password: PASSWORD }))).status, 303, 'a request without an edge address is not limited: there is nothing to hold it to');
});

test('the limiter: a window, a lock that ends, a reset on success, and bounded memory', () => {
  const limits = { failures: 3, windowMs: 1000, lockMs: 500, clients: 4 };
  const limiter = gate.createLoginLimiter(limits);
  limiter.failed('a', 0);
  limiter.failed('a', 100);
  assert.equal(limiter.waitMs('a', 200), 0, 'two of three: still free');
  limiter.failed('a', 1200);
  assert.equal(limiter.waitMs('a', 1200), 0, 'the first two left the window');
  limiter.failed('a', 1250);
  limiter.failed('a', 1300);
  assert.equal(limiter.waitMs('a', 1300), 500, 'three within the window: locked');
  assert.equal(limiter.waitMs('a', 1799), 1);
  assert.equal(limiter.waitMs('a', 1800), 0, 'and free again after the lock');
  limiter.failed('b', 0);
  limiter.failed('b', 1);
  limiter.succeeded('b');
  limiter.failed('b', 2);
  assert.equal(limiter.waitMs('b', 3), 0, 'a success starts again from nothing');
  for (const client of ['c', 'd', 'e', 'f', 'g', 'h']) limiter.failed(client, 10);
  assert.ok(limiter.size() <= limits.clients, `at most ${limits.clients} addresses kept: ${limiter.size()}`);
  assert.deepEqual(gate.LOGIN_LIMIT, { failures: 5, windowMs: 600_000, lockMs: 60_000, clients: 5_000 });
  assert.equal(typeof loginLimiter.waitMs, 'function');
});

test('the cookie is accepted among other cookies', async () => {
  const cookie = await signIn();
  const response = await run(navigate('/', { Cookie: `theme=dark; ${cookie}; other=1` }));
  assert.equal(response.status, 200);
});

// ---------------------------------------------------------------------------
// Public reads go on without cookies. The browser attaches every same-origin
// cookie whose Path covers the read, and session-v1's __Host- cookies must be
// Path=/, so the gate is the first place that can drop them.
// ---------------------------------------------------------------------------

const SESSION_COOKIES = '__Host-domino-session=sessiontoken; __Host-domino-preauth=preauthtoken';

/** Runs a request through the gate and returns what `next` was handed. */
async function passedOn(request) {
  const handed = [];
  const response = await onRequest({
    request,
    env: ENV,
    next: async (passed) => {
      handed.push(passed);
      return new Response('{}', { headers: { 'Content-Type': 'application/json' } });
    },
  });
  return { response, handed };
}

test('a public read goes on past the gate with no cookie at all, and otherwise unchanged', async () => {
  const cookie = await signIn();
  const body = '{"token":"0x' + 'a1'.repeat(20) + '"}';
  const request = new Request(`${ORIGIN}/api/read/v1/token`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'X-Domino-Read-Contract': '1.1.0-rc.3',
      Cookie: `theme=dark; ${cookie}; ${SESSION_COOKIES}`,
    },
    body,
  });
  const { response, handed } = await passedOn(request);
  assert.equal(response.status, 200);
  assert.equal(handed.length, 1);
  const passed = handed[0];
  assert.ok(passed instanceof Request, 'the gate hands on a request of its own, not the one the browser sent');
  assert.equal(passed.headers.get('Cookie'), null, 'no cookie of any kind goes past the gate on a public read');
  for (const [name, value] of passed.headers) assert.doesNotMatch(value, /sessiontoken|preauthtoken|domino-beta/, `a credential went on in ${name}`);
  assert.equal(passed.method, 'POST');
  assert.equal(passed.url, `${ORIGIN}/api/read/v1/token`);
  assert.equal(passed.headers.get('Content-Type'), 'application/json');
  assert.equal(passed.headers.get('X-Domino-Read-Contract'), '1.1.0-rc.3');
  assert.equal(await passed.text(), body, 'the body goes on byte for byte');
});

test('the capabilities read loses its cookies too', async () => {
  const cookie = await signIn();
  const { handed } = await passedOn(fetchLike('/api/read/v1/capabilities', { Cookie: `${cookie}; ${SESSION_COOKIES}` }));
  assert.equal(handed.length, 1);
  assert.equal(handed[0]?.headers.get('Cookie'), null);
});

test('everything that is not a public read keeps its cookies, because session routes need them', async () => {
  const cookie = await signIn();
  for (const path of ['/', '/api/session/v1/me', '/api/onboarding/v1/status', '/api/readiness', '/assets/index.js']) {
    const { response, handed } = await passedOn(fetchLike(path, { Cookie: `${cookie}; ${SESSION_COOKIES}` }));
    assert.equal(response.status, 200, path);
    assert.deepEqual(handed, [undefined], `${path} goes on as the browser sent it`);
  }
});

// 2026-10-01 (RPC-SPEC §2.7): Domino's own chain routes go on as a public read does: with no cookie at all, and their
// answers compressible (no-store alone). Any other path under their prefixes keeps its cookies.
test('Domino’s own chain routes go on past the gate with no cookie at all, and leave no-store; nothing else under their prefixes does', async () => {
  const cookie = await signIn();
  // Changed on purpose 2026-10-02 (RPC-SPEC §11.4): the ledger route, in place of the fees replay's /logs.
  const paths = ['/api/owned/v2/positions', '/api/fees/v1/state', '/api/fees/v2/ledger', '/api/automation/v1/state', '/api/automation/v1/record', '/api/chain/v1/simulate', '/API/Fees/V2/Ledger'];
  for (const path of paths) {
    const body = '{"tokenIds":["1"]}';
    const request = new Request(`${ORIGIN}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: ORIGIN, 'Sec-Fetch-Site': 'same-origin', Cookie: `theme=dark; ${cookie}; ${SESSION_COOKIES}` }, body });
    const { response, handed } = await passedOn(request);
    assert.equal(response.status, 200, path);
    assert.ok(handed[0] instanceof Request, `${path}: the gate hands on a request of its own`);
    assert.equal(handed[0].headers.get('Cookie'), null, `${path}: no cookie of any kind goes past the gate`);
    for (const [name, value] of handed[0].headers) assert.doesNotMatch(value, /sessiontoken|preauthtoken|domino-beta/, `${path}: a credential went on in ${name}`);
    assert.equal(await handed[0].text(), body, `${path}: the body goes on byte for byte`);
    assert.equal(response.headers.get('Cache-Control'), 'no-store', path);
    assert.equal(response.headers.get('Content-Security-Policy'), "default-src 'none'; frame-ancestors 'none'", path);
  }
  for (const path of ['/api/owned/v2/positions/', '/api/fees/v1/state/x', '/api/owned/v1/positions', '/api/chain/v1/call', '/api/fees/v1/logs', '/api/fees/v2/ledger/x']) {
    const { response, handed } = await passedOn(fetchLike(path, { Cookie: `${cookie}; ${SESSION_COOKIES}` }));
    assert.deepEqual(handed, [undefined], `${path} goes on as the browser sent it`);
    assert.equal(response.headers.get('Cache-Control'), 'no-store, no-transform', path);
  }
  // Without the beta cookie, refused as every API call is.
  const { response, handed } = await passedOn(new Request(`${ORIGIN}/api/fees/v2/ledger`, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: SESSION_COOKIES }, body: '{}' }));
  assert.deepEqual([response.status, await response.json(), handed], [401, { error: 'beta_access_required' }, []]);
});

test('a read without the beta cookie is still refused, whatever else it carries', async () => {
  const { response, handed } = await passedOn(fetchLike('/api/read/v1/token', { Cookie: SESSION_COOKIES }));
  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { error: 'beta_access_required' });
  assert.deepEqual(handed, []);
});

// ---------------------------------------------------------------------------
// 2026-10-01, the chain2 workstream, part B: /uniswap-v3/* (rugged97's Uniswap v3 services for the second chain's
// section, functions/uniswap-v3/[[path]].ts) is an API path behind the gate, and the preview's page CSP names the
// second chain's RPC.
// ---------------------------------------------------------------------------

const V3_BODY = '{"chainId":99801,"protocol":"uniswap-v3"}';
const v3Post = (path, headers = {}) =>
  new Request(`${ORIGIN}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: ORIGIN, 'Sec-Fetch-Site': 'same-origin', 'Sec-Fetch-Mode': 'cors', 'Sec-Fetch-Dest': 'empty', ...headers }, body: V3_BODY });

test('/uniswap-v3 goes on past the gate with no cookie at all, and its answer leaves as an API answer', async () => {
  const cookie = await signIn();
  for (const path of ['/uniswap-v3/read/v1/capabilities', '/uniswap-v3/actions/v1/prepare', '/UNISWAP-V3/read/v1/capabilities', '/uniswap-v3', '/uniswap-v3/']) {
    const handed = [];
    const response = await onRequest({
      request: v3Post(path, { Cookie: `theme=dark; ${cookie}; ${SESSION_COOKIES}` }),
      env: ENV,
      next: async (passed) => {
        handed.push(passed);
        return new Response('{}', { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=60', 'Content-Security-Policy': "default-src *" } });
      },
    });
    assert.equal(response.status, 200, path);
    assert.equal(handed.length, 1, path);
    assert.ok(handed[0] instanceof Request, `${path}: the gate hands on a request of its own`);
    assert.equal(handed[0].headers.get('Cookie'), null, `${path}: no cookie of any kind goes past the gate`);
    for (const [name, value] of handed[0].headers) assert.doesNotMatch(value, /sessiontoken|preauthtoken|domino-beta/, `${path}: a credential went on in ${name}`);
    assert.equal(handed[0].method, 'POST');
    assert.equal(handed[0].headers.get('Origin'), ORIGIN, 'the browser\'s own Origin goes on, for the route\'s same-origin check');
    assert.equal(await handed[0].text(), V3_BODY, 'the body goes on byte for byte');
    assert.equal(response.headers.get('Cache-Control'), 'no-store, no-transform', `${path}: never stored, whatever the route said`);
    assert.equal(response.headers.get('Content-Security-Policy'), "default-src 'none'; frame-ancestors 'none'", `${path}: the API's CSP`);
    assert.equal(response.headers.get('X-Content-Type-Options'), 'nosniff');
    assert.match(response.headers.get('Vary') ?? '', /Cookie/);
    assert.equal(response.headers.get('Set-Cookie'), null, 'an API call never renews the beta cookie');
  }
  // Not this prefix: the page's own route goes on as the browser sent it.
  const { handed } = await passedOn(fetchLike('/uniswap-v3x/read/v1/capabilities', { Cookie: `${cookie}; ${SESSION_COOKIES}` }));
  assert.deepEqual(handed, [undefined]);
});

test('/uniswap-v3 without the beta cookie is refused as JSON, and a path with an empty segment never reaches the files', async () => {
  const { response, handed } = await passedOn(v3Post('/uniswap-v3/read/v1/capabilities', { Cookie: SESSION_COOKIES }));
  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { error: 'beta_access_required' });
  assert.deepEqual(handed, []);
  const cookie = await signIn();
  for (const path of ['/uniswap-v3//read/v1/capabilities', '/uniswap-v3/read/v1//capabilities', '/UNISWAP-V3//x']) {
    const refused = await onRequest({ request: v3Post(path, { Cookie: cookie }), env: ENV, next });
    assert.equal(refused.status, 404, path);
    assert.deepEqual(await refused.json(), { error: 'not_found' }, path);
    assert.equal(refused.headers.get('Cache-Control'), 'no-store, no-transform', path);
    assert.equal(refused.headers.get('Content-Security-Policy'), "default-src 'none'; frame-ancestors 'none'", path);
    assert.equal(served, 0, `${path}: never index.html`);
  }
});

// Changed on purpose 2026-10-02 (review of the RPC switch, finding 1; the owner's rule: the site reads nothing from a
// public RPC, on the preview too): the second chain's RPC is a public node, and its section is closed while it could read
// only that (src/chains/elysium/mode.ts SECTION_READS), so the preview's page CSP names it no more: CHAIN2_PREVIEW "true"
// serves APP_CSP_CHAIN2, which is production's policy until the section has a source of rugged97's.
test('the preview\'s page CSP where CHAIN2_PREVIEW is "true" names no public node while the second chain\'s section reads none, and nothing else changes', async () => {
  const { APP_CSP_CHAIN2 } = require('../.test-build/app/functions/_middleware.js');
  const directive = (policy, name) => policy.split('; ').find((part) => part.startsWith(`${name} `));
  assert.equal(directive(APP_CSP_CHAIN2, 'connect-src'), directive(APP_CSP, 'connect-src'), 'the page\'s own sources and WalletConnect\'s relay, no chain\'s RPC (no Robinhood Chain RPC since 2026-10-01, RPC-SPEC §7.4; no Elysium one since 2026-10-02)');
  assert.deepEqual(APP_CSP_CHAIN2.split('; ').filter((part) => !part.startsWith('connect-src ')), APP_CSP.split('; ').filter((part) => !part.startsWith('connect-src ')), 'every other directive is production\'s');
  assert.doesNotMatch(APP_CSP, /elysium|kinetiq/, 'production\'s policy names no host of the second chain');
  assert.doesNotMatch(APP_CSP_CHAIN2, /elysium|kinetiq/, 'nor the preview\'s');
  const cookie = await signIn();
  const csp = async (env, request = navigate('/', { Cookie: cookie })) => withoutNonce((await onRequest({ request, env, next })).headers.get('Content-Security-Policy'));
  assert.equal(await csp(ENV), APP_CSP, 'unset: production\'s');
  assert.equal(await csp({ ...ENV, CHAIN2_PREVIEW: 'true' }), APP_CSP_CHAIN2, '"true": the preview\'s');
  for (const value of ['TRUE', 'True', '1', 'yes', ' true', 'true ', '', 'false']) assert.equal(await csp({ ...ENV, CHAIN2_PREVIEW: value }), APP_CSP, `"${value}": production's`);
  // A page the browser revalidates keeps its original nonce and CSP; non-pages stay unchanged: the files stay inert (the fees
  // worker's name too, since 2026-10-02), API answers render nothing.
  const revalidated = await onRequest({ request: navigate('/', { Cookie: cookie }), env: { ...ENV, CHAIN2_PREVIEW: 'true' }, next: async () => new Response(null, { status: 304, headers: { 'Content-Type': 'text/html; charset=utf-8' } }) });
  assert.equal(revalidated.headers.get('Content-Security-Policy'), null);
  const asset = (path, type) => onRequest({ request: fetchLike(path, { Cookie: cookie }), env: { ...ENV, CHAIN2_PREVIEW: 'true' }, next: async () => new Response('x', { headers: { 'Content-Type': type } }) });
  assert.equal((await asset('/assets/feesReplay.worker-CdlBbZHL.js', 'text/javascript')).headers.get('Content-Security-Policy'), STATIC_CSP);
  assert.equal((await asset('/assets/index-abc123.js', 'text/javascript')).headers.get('Content-Security-Policy'), STATIC_CSP);
  assert.equal((await asset('/api/read/v1/capabilities', 'application/json')).headers.get('Content-Security-Policy'), "default-src 'none'; frame-ancestors 'none'");
  // The access page keeps its own policy either way.
  const ask = await onRequest({ request: navigate('/'), env: { ...ENV, CHAIN2_PREVIEW: 'true' }, next });
  assert.equal(ask.status, 401);
  assert.doesNotMatch(ask.headers.get('Content-Security-Policy'), /elysium|kinetiq/);
});

test('a tampered, expired, foreign or duplicated cookie is refused', async () => {
  const good = await signIn();
  const [name, value] = good.split('=');
  const flip = (s, i) => s.slice(0, i) + (s[i] === 'A' ? 'B' : 'A') + s.slice(i + 1);

  const config = await gate.readConfig(ENV);
  const expired = (await gate.issueCookie(config, Date.now() - (gate.SESSION_SECONDS + 5) * 1000)).split(';')[0];

  const otherKey = { ...ENV, BETA_COOKIE_KEY: 'Zz9yXw8vUt7sRq6pOn5mLk4jIh3gFe2dCb1aZyXwVuT' };
  const foreign = await signIn(otherKey);

  const [, stamp, sig] = value.split('.');
  const extended = `${name}=v1.${Number(stamp) + 86400}.${sig}`;

  const cases = {
    'signature altered': `${name}=${flip(value, value.length - 3)}`,
    'expiry moved later': extended,
    expired,
    'signed with another key': foreign,
    duplicated: `${good}; ${good}`,
    'wrong version': `${name}=v2.${stamp}.${sig}`,
    empty: `${name}=`,
    'far future': `${name}=v1.99999999999.${sig}`,
  };
  for (const [label, cookie] of Object.entries(cases)) {
    const response = await run(navigate('/', { Cookie: cookie }));
    assert.equal(response.status, 401, label);
  }
  assert.equal(served, 0, 'an invalid cookie reached the app');
});

test('changing the password signs everyone out at once', async () => {
  const cookie = await signIn();
  const rotated = { ...ENV, BETA_PASSWORD: 'a-completely-new-beta-password' };
  assert.equal((await run(navigate('/', { Cookie: cookie }), rotated)).status, 401);
  assert.equal(served, 0);
});

test('logout clears the cookie, and only a same-site POST can do it', async () => {
  const response = await run(new Request(`${ORIGIN}${LOGOUT_PATH}`, { method: 'POST', headers: { Origin: ORIGIN } }));
  assert.equal(response.status, 303);
  assert.match(response.headers.get('Set-Cookie'), /^__Host-domino-beta=; .*Max-Age=0/);
  assert.equal((await run(navigate(LOGOUT_PATH))).status, 405);
  assert.equal(
    (await run(new Request(`${ORIGIN}${LOGOUT_PATH}`, { method: 'POST', headers: { Origin: 'https://evil.example' } }))).status,
    405,
  );
});

// ---------------------------------------------------------------------------
// Hostnames.
// ---------------------------------------------------------------------------

test('www redirects to the apex, keeping the path', async () => {
  const response = await run(new Request('https://www.domino.money/some/path?x=1', { headers: { 'Sec-Fetch-Mode': 'navigate' } }));
  assert.equal(response.status, 301);
  assert.equal(response.headers.get('Location'), 'https://domino.money/some/path?x=1');
  assert.equal(served, 0);
});

// Added 2026-09-21. The www redirect was the one answer the gate sent without a
// Cache-Control, and a browser keeps an uncached permanent redirect for the life
// of the profile — the mapping could never have been changed again for anyone
// who had followed it once.
test('the www redirect is not stored, so the mapping can still be changed', async () => {
  const response = await run(new Request('https://www.domino.money/', { headers: { 'Sec-Fetch-Mode': 'navigate' } }));
  assert.equal(response.status, 301);
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  // The redirect is the first answer a www visitor gets, so its HSTS is what promotes
  // the next hop to https. It rides on BASE_HEADERS; pinned here so a literal header
  // object cannot quietly drop it.
  assert.equal(response.headers.get('Strict-Transport-Security'), 'max-age=31536000');
  assert.equal(served, 0);
});

test('a preview hostname gets the same gate, not a way around it', async () => {
  for (const host of ['https://domino-app.pages.dev', 'https://abc123.domino-app.pages.dev']) {
    const page = await run(new Request(`${host}/`, { headers: { 'Sec-Fetch-Mode': 'navigate' } }));
    assert.equal(page.status, 401, host);
    const asset = await run(new Request(`${host}/assets/index.js`));
    assert.equal(asset.status, 401, host);
  }
  assert.equal(served, 0);
});

// ---------------------------------------------------------------------------
// The primitives.
// ---------------------------------------------------------------------------

test('password comparison is exact', async () => {
  const config = await gate.readConfig(ENV);
  assert.equal(await gate.isPassword(config, PASSWORD), true);
  for (const wrong of ['', PASSWORD + 'x', PASSWORD.slice(1), 'x'.repeat(600)]) {
    assert.equal(await gate.isPassword(config, wrong), false);
  }
});

// Added 2026-09-20. A GET on the login path answered 303 with a Set-Cookie
// clearing the beta cookie, and no origin check of any kind guarded it — so any
// page, ad frame or extension the visitor happened to load could point at
// /__beta/login and sign them out of the whole site, and so could their own
// bookmark. A GET must not change session state.
test('a GET on the login path redirects and touches no cookie; only a same-origin POST signs out', async () => {
  const cookie = await signIn();
  const get = await run(navigate(LOGIN_PATH, { Cookie: cookie }));
  assert.equal(get.status, 303);
  assert.equal(get.headers.get('Location'), '/');
  assert.equal(get.headers.get('Set-Cookie'), null, 'no Set-Cookie header at all, not even an empty one');
  // The session it did not touch still works.
  assert.equal((await run(navigate('/', { Cookie: cookie }))).status, 200);

  // A cross-origin POST to the logout path is refused before it can clear anything.
  const foreign = new Request(`${ORIGIN}${LOGOUT_PATH}`, { method: 'POST', headers: { Origin: 'https://evil.example', Cookie: cookie } });
  const refused = await run(foreign);
  assert.equal(refused.status, 405);
  assert.equal(refused.headers.get('Set-Cookie'), null);
  assert.equal((await run(navigate('/', { Cookie: cookie }))).status, 200, 'still signed in');

  // And the real sign-out still works, and really clears it.
  const out = await run(new Request(`${ORIGIN}${LOGOUT_PATH}`, { method: 'POST', headers: { Origin: ORIGIN, Cookie: cookie } }));
  assert.equal(out.status, 303);
  assert.match(out.headers.get('Set-Cookie') ?? '', /Max-Age=0/);
});

// 2026-10-01 (platform workstream, I8): a 304's headers replace those of the browser's copy. The page's own revalidation
// often comes back with no Content-Type, and must not carry the static files' CSP, or the page's CSP would be replaced
// by one that runs nothing.
test('a 304 never carries a CSP other than the one its copy was served with', async () => {
  const cookie = await signIn();
  const revalidated = (path, headers = {}) =>
    onRequest({ request: navigate(path, { Cookie: cookie }), env: ENV, next: async () => new Response(null, { status: 304, headers }) });
  const page = await revalidated('/');
  assert.equal(page.status, 304);
  assert.equal(page.headers.get('Content-Security-Policy'), null, 'the page keeps its own CSP');
  assert.equal(page.headers.get('Cache-Control'), 'private, no-cache');
  assert.equal((await revalidated('/', { 'Content-Type': 'text/html; charset=utf-8' })).headers.get('Content-Security-Policy'), null);
  const typed = await revalidated('/', { 'Content-Type': 'text/html', ETag: '"index"', 'Content-Security-Policy': "script-src 'self'" });
  assert.equal(typed.headers.get('Content-Security-Policy'), null, 'an upstream policy cannot replace the retained nonce');
  assert.equal(typed.headers.get('ETag'), '"index"');
  const icon = await onRequest({ request: fetchLike('/tokens/weth.svg', { Cookie: cookie }), env: ENV, next: async () => new Response(null, { status: 304 }) });
  assert.equal(icon.headers.get('Content-Security-Policy'), null);
  assert.equal(icon.headers.get('Cache-Control'), ICON_CACHE);
  const favicon = await onRequest({ request: fetchLike('/favicon.ico'), env: ENV, next: async () => new Response(null, { status: 304 }) });
  assert.equal(favicon.status, 304);
  assert.equal(favicon.headers.get('Content-Security-Policy'), null);
});

test('each app HTML response gives Cloudflare a fresh nonce without changing the document, validators or other policies', async () => {
  const cookie = await signIn();
  const document = `<!doctype html><script>${BOOT_SCRIPT}</script>`;
  const nonces = new Set();
  for (let i = 0; i < 3; i++) {
    const response = await onRequest({
      request: navigate('/', { Cookie: cookie }), env: ENV,
      next: async () => new Response(document, { headers: { 'Content-Type': 'text/html', ETag: '"index"', 'Last-Modified': 'Wed, 07 Oct 2026 12:00:00 GMT' } }),
    });
    const policy = response.headers.get('Content-Security-Policy');
    const matches = [...policy.matchAll(/'nonce-([A-Za-z0-9+/]+={0,2})'/g)];
    assert.equal(matches.length, 1);
    assert.equal(Buffer.from(matches[0][1], 'base64').length, 16, '128 bits from Web Crypto');
    nonces.add(matches[0][1]);
    assert.match(policy.split('; ').find((part) => part.startsWith('script-src ')), /'nonce-/);
    assert.equal(withoutNonce(policy), APP_CSP, 'only the script nonce is added');
    assert.equal(await response.text(), document, 'boot still runs by hash; no HTML rewriting');
    assert.equal(response.headers.get('ETag'), '"index"');
    assert.equal(response.headers.get('Last-Modified'), 'Wed, 07 Oct 2026 12:00:00 GMT');
    assert.equal(response.headers.get('Cache-Control'), 'private, no-cache');
    assert.match(response.headers.get('Vary'), /Cookie/);
  }
  assert.equal(nonces.size, 3, 'a nonce is never reused between responses');
  assert.equal((await run(navigate('/'))).headers.get('Content-Security-Policy'), gate.PAGE_CSP, 'the beta gate keeps its separate policy');
});
