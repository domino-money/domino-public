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
const { onRequest, APP_CSP, LOGIN_PATH, LOGOUT_PATH, PERMISSIONS_POLICY, WORKER_CSP } = require('../.test-build/app/functions/_middleware.js');

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

test('the access page calls nothing a beta and asks no one to come back later, in any state', async () => {
  const pages = {
    ask: await (await run(navigate('/'))).text(),
    wrong: await (await run(loginPost('wrong'))).text(),
    unavailable: await (await run(navigate('/'), {})).text(),
  };
  for (const [state, html] of Object.entries(pages)) {
    // The app recognises this page by its exact title (GATE_PAGE_MARKER in src/lib/read/interpret.ts).
    assert.match(html, /<title>Domino · Access<\/title>/, state);
    // What a visitor reads: the markup and styles removed, so the login path's name does not count.
    const words = html.replace(/<style>[\s\S]*<\/style>/, ' ').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ');
    assert.doesNotMatch(words, /\bbeta\b|\blater\b|temporarily/i, state);
    assert.match(words, /Invitation only/, state);
  }
  assert.match(pages.ask, /Enter the access password from your invitation to continue\./);
  assert.match(pages.unavailable, /<h1>Access is paused\.<\/h1>\s*<p class="lede">Nothing is wrong on your side\.<\/p>/);
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
  assert.doesNotMatch(text, /<script/, 'the access page must run no script');
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
  assert.equal(response.headers.get('Content-Security-Policy'), APP_CSP);
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

test('the permissions policy switches off sensors and payments but leaves hardware-wallet paths alone', () => {
  for (const feature of ['camera', 'microphone', 'geolocation', 'payment']) {
    assert.match(PERMISSIONS_POLICY, new RegExp(`(^|, )${feature}=\\(\\)`), `${feature} is not switched off`);
  }
  for (const feature of ['usb', 'hid', 'serial', 'bluetooth']) {
    assert.doesNotMatch(PERMISSIONS_POLICY, new RegExp(`(^|, )${feature}=`), `${feature} would block hardware wallets`);
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

// 2026-09-25: the page and the fees replay worker read Robinhood Chain's public RPC themselves (it rate-limits
// Cloudflare's edge). The page's CSP names it; a dedicated worker keeps the CSP its own file is served with, so the
// worker's file carries one that loads nothing and reaches only the RPC. No other script gets a CSP of its own.
test('the page and the fees worker may reach the chain’s RPC, and nothing else is opened', async () => {
  const connect = APP_CSP.split('; ').find((part) => part.startsWith('connect-src '));
  assert.equal(connect, "connect-src 'self' https://api.dexscreener.com https://rpc.mainnet.chain.robinhood.com");
  assert.equal(WORKER_CSP, "default-src 'none'; connect-src https://rpc.mainnet.chain.robinhood.com");
  const cookie = await signIn();
  const asset = (path) => onRequest({ request: fetchLike(path, { Cookie: cookie }), env: ENV, next: async () => new Response('x', { headers: { 'Content-Type': 'text/javascript' } }) });
  const worker = await asset('/assets/feesReplay.worker-CdlBbZHL.js');
  assert.equal(worker.headers.get('Content-Security-Policy'), WORKER_CSP);
  assert.equal(worker.headers.get('Cache-Control'), 'private, max-age=31536000, immutable');
  for (const path of ['/assets/index-abc123.js', '/assets/feesReplay.worker.js', '/assets/x/feesReplay.worker-abc.js', '/assets/feesReplay.worker-abc.js.map']) {
    assert.equal((await asset(path)).headers.get('Content-Security-Policy'), null, path);
  }
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

test('a read without the beta cookie is still refused, whatever else it carries', async () => {
  const { response, handed } = await passedOn(fetchLike('/api/read/v1/token', { Cookie: SESSION_COOKIES }));
  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { error: 'beta_access_required' });
  assert.deepEqual(handed, []);
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
