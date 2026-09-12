/**
 * The wallet session feature end to end in a real browser, against the
 * wallet-test build, under the production CSP.
 *
 * Wallets are EIP-6963 providers injected before the page loads (see
 * support/mock-wallet.mjs); the session service is a stateful fake that
 * behaves like the bridge and the producer (support/fake-session.mjs). After
 * every scenario the run fails on: a CSP violation, a browser error, a request
 * to another origin, a session protocol violation recorded by the fake, a
 * wallet method outside the login allowlist, a challenge verified twice, or a
 * signature that no Sign in click asked for.
 */
import assert from 'node:assert/strict';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright-core';
import { createFakeSession } from './support/fake-session.mjs';
import { ACCOUNTS, installWallets } from './support/mock-wallet.mjs';
import { createWalletServer, WALLET_DIST } from './support/wallet-server.mjs';

if (!existsSync(join(WALLET_DIST, 'index.html'))) {
  throw new Error('.wallet-test-dist is missing. Run `npm run build:wallet-test` before this test.');
}

const ADDR_A = ACCOUNTS[0].address;
const ADDR_B = ACCOUNTS[1].address;
const HOUR = 3_600_000;
const FONTS = /^https:\/\/fonts\.(googleapis|gstatic)\.com\//;
const INJECTED = /^https?:\/\/[^/]*\.kaspersky-labs\.com\//;
const GATE_PASSWORD = 'wallet-test-beta-password';
const GATE_KEY = 'Wq7mZ2vHx9Lr4TbN1cYp6KsJ3dGa8FeU5oViRtYqWeB';
/**
 * How long a wait may take before it fails. This is a ceiling, not a delay:
 * a passing wait returns as soon as its condition holds. It is generous
 * because on a loaded machine (other builds or installs running at the same
 * time) the wallet island's lazy chunk has taken more than ten seconds to
 * report its first view. Negative checks ("nothing happened") use their own
 * short sleeps and are unaffected.
 */
const WAIT_MS = 45_000;

const LAUNCHES = process.env.DOMINO_BROWSER_PATH
  ? [{ executablePath: process.env.DOMINO_BROWSER_PATH }]
  : [{ channel: 'chrome' }, { channel: 'chromium' }, { channel: 'msedge' }, {}];

let browser;
/** Every server a scenario started, so a failed test cannot keep the run alive. */
const servers = new Set();

before(async () => {
  for (const options of LAUNCHES) {
    try {
      browser = await chromium.launch(options);
      break;
    } catch {
      // try the next build
    }
  }
  if (!browser) throw new Error('No Chromium build could be launched. Set DOMINO_BROWSER_PATH.');
});

after(async () => {
  await browser?.close();
  await Promise.all([...servers].map((server) => server.closeAll()));
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * One isolated world: a fake service, a server, a browser context with two
 * wallets. `close()` tears it down and checks every invariant.
 */
async function scenario({ gate = null, intercept, admit = [ADDR_A, ADDR_B], clockAt, allowConsoleErrors = false, wallets } = {}) {
  const fake = createFakeSession();
  for (const address of admit) fake.admit(address);
  const server = createWalletServer({ fake, gate, intercept });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  servers.add(server);
  const origin = `http://127.0.0.1:${server.address().port}`;
  fake.origin = origin;

  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  // playwright-core has no default action timeout; a missing element would
  // otherwise hang the whole run instead of failing one test.
  context.setDefaultTimeout(WAIT_MS);
  if (clockAt !== undefined) await context.clock.install({ time: clockAt });
  // Google Fonts is the one third-party origin the CSP allows. Answer it
  // locally, so the run never depends on the network.
  await context.route(FONTS, (route) => route.fulfill({ status: 200, contentType: 'text/css', body: '' }));
  // Desktop antivirus suites inject their own script into every page they
  // proxy (see gate.browser.test.mjs). That request is not the app's; it is
  // refused here and left out of the external-request check. Anything else
  // leaving the origin still fails the run.
  await context.route(INJECTED, (route) => route.abort());
  const wallet = await installWallets(context, wallets);
  const problems = [];
  const external = [];
  context.on('request', (request) => {
    const url = request.url();
    if (!url.startsWith(origin) && !url.startsWith('data:') && !FONTS.test(url) && !INJECTED.test(url)) external.push(url);
  });

  const s = {
    fake,
    wallet,
    origin,
    context,
    signClicks: 0,
    /** Challenge ids a test replays on purpose (see the replay scenario). */
    replayed: new Set(),
    async open(route = '/app') {
      const page = await context.newPage();
      page.on('pageerror', (error) => problems.push(`uncaught: ${error.message}`));
      page.on('console', (message) => {
        // Chrome logs every 4xx/5xx fetch as "Failed to load resource". The
        // fake's own log is the record of what the service answered.
        if (message.type() !== 'error' || allowConsoleErrors || /Failed to load resource/.test(message.text())) return;
        problems.push(`console.error: ${message.text()}`);
      });
      await page.goto(`${origin}/#${route}`, { waitUntil: 'load' });
      return page;
    },
    async close() {
      await context.close();
      await server.closeAll();
      servers.delete(server);
      assert.deepEqual(wallet.state.csp, [], 'CSP violations');
      assert.deepEqual(problems, [], 'browser errors');
      assert.deepEqual(external, [], 'requests to another origin');
      assert.deepEqual(fake.state.violations, [], 'session protocol violations');
      assert.deepEqual(wallet.state.refused, [], 'wallet methods outside the login allowlist');
      for (const [id, count] of fake.state.verifies) {
        // A test that replays a verify itself names the challenge; the app never may.
        const allowed = s.replayed.has(id) ? 2 : 1;
        assert.ok(count <= allowed, `challenge ${id} was verified ${count} times`);
      }
      assert.ok(wallet.state.signed.length <= s.signClicks, 'a signature was requested without a Sign in click');
    },
  };
  return s;
}

// ---- page helpers ----------------------------------------------------------

const trigger = (page) => page.locator('header [aria-haspopup="dialog"]');
const dialog = (page) => page.getByRole('dialog', { name: /^(Connect|Wallet)$/ });
const view = (page) => page.evaluate(() => window.__dominoSessionProbe.view());
const privateKeys = (page) => page.evaluate(() => window.__dominoSessionProbe.privateKeys().map((key) => key.join('|')));

/** Polls with page.evaluate; nothing here needs eval under the page's CSP. */
async function until(page, predicate, arg, label, timeout = WAIT_MS) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await page.evaluate(predicate, arg).catch(() => false);
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label ?? predicate}`);
    await sleep(25);
  }
}
const viewIs = (page, status) =>
  until(page, (wanted) => window.__dominoSessionProbe?.view().status === wanted, status, `view ${status}`).then(() => view(page));

async function openDialog(page) {
  if (!(await dialog(page).isVisible())) await trigger(page).click();
  await dialog(page).waitFor();
}

async function connect(page, name = 'Test Wallet A') {
  await viewIs(page, 'no_wallet');
  await openDialog(page);
  await dialog(page).getByRole('button', { name: `Connect ${name}` }).click();
  return viewIs(page, 'signed_out');
}

async function clickSignIn(s, page) {
  await openDialog(page);
  s.signClicks += 1;
  await dialog(page).getByRole('button', { name: 'Sign in', exact: true }).click();
}

async function signIn(s, page) {
  await clickSignIn(s, page);
  return viewIs(page, 'signed_in');
}

async function enterBeta(page, origin) {
  await page.goto(`${origin}/`, { waitUntil: 'load' });
  await page.fill('#password', GATE_PASSWORD);
  await Promise.all([page.waitForNavigation({ waitUntil: 'load' }), page.click('button[type="submit"]')]);
  await page.goto(`${origin}/#/app`, { waitUntil: 'load' });
}

const activeSessions = (s, address) => s.fake.sessionsFor(address).filter((row) => row.active);

// ---- discovery and sign-in --------------------------------------------------

test('each announced wallet is listed by name, and no provider icon becomes an image', async () => {
  const s = await scenario();
  const page = await s.open();
  await viewIs(page, 'no_wallet');
  await openDialog(page);
  const names = await dialog(page).getByRole('list', { name: 'Browser wallets' }).getByRole('button').allInnerTexts();
  assert.deepEqual(names.map((name) => name.replace(/\s+/g, ' ').trim()), ['Connect Test Wallet A', 'Connect Test Wallet B']);
  assert.equal(await dialog(page).locator('img, image, [src], [href]').count(), 0, 'no provider icon may be rendered');
  assert.equal(await page.locator('[src^="data:image/svg+xml,%3Csvg"]').count(), 0);
  // Nothing is read from the service until a wallet is connected.
  assert.equal(s.fake.state.log.length, 0);
  await s.close();
});

test('clean wallet picker uses only bundled brand icons; connection shows the address before sign-in', async () => {
  const s = await scenario({ wallets: [
    { id: 'rabby', name: 'Rabby Wallet', rdns: 'io.rabby', uuid: '8f2a7d1c-0000-4000-8000-000000000001' },
    { id: 'unknown', name: 'Unknown Wallet', rdns: 'unknown.wallet', uuid: '8f2a7d1c-0000-4000-8000-000000000002' },
  ] });
  const page = await s.open();
  await viewIs(page, 'no_wallet');
  await openDialog(page);
  assert.equal(await dialog(page).getByRole('heading', { name: 'Connect', exact: true }).count(), 1);
  assert.doesNotMatch(await dialog(page).innerText(), /Signing in is not a permission|Connect a browser wallet|Robinhood Chain · 4663|Only standard wallets/);
  assert.deepEqual(await dialog(page).locator('img').evaluateAll((images) => images.map((image) => image.getAttribute('src'))), ['/wallets/rabby.svg']);
  assert.equal(await dialog(page).locator('img').evaluate((image) => image.complete && image.naturalWidth > 0), true);
  await dialog(page).getByRole('button', { name: 'Connect Rabby Wallet' }).click();
  await viewIs(page, 'signed_out');
  assert.match(await trigger(page).innerText(), new RegExp(`${ADDR_A.slice(0, 6)}…${ADDR_A.slice(-4)}`));
  assert.doesNotMatch(await trigger(page).innerText(), /Signed in/);
  assert.equal(await trigger(page).getAttribute('title'), ADDR_A);
  assert.equal(s.wallet.state.signed.length, 0, 'showing the address does not sign in');
  await dialog(page).getByRole('button', { name: 'Disconnect wallet', exact: true }).click();
  await viewIs(page, 'no_wallet');
  assert.equal(await trigger(page).innerText(), 'Connect wallet');
  await s.close();
});

test('sign-in: bootstrap, challenge for the EIP-55 address, one signature over the exact server message, verify', async () => {
  const s = await scenario();
  const page = await s.open();
  await connect(page);
  await signIn(s, page);

  assert.deepEqual(s.fake.state.log.map((entry) => entry.route), ['me', 'bootstrap', 'challenge', 'verify']);
  assert.equal(s.fake.calls('challenge')[0].body.address, ADDR_A, 'the challenge names the EIP-55 address');
  assert.equal(s.wallet.state.signed.length, 1);
  const issued = [...s.fake.state.contexts.values()][0].challenge.message;
  assert.equal(s.wallet.state.signed[0].message, issued, 'the wallet signed the server message byte for byte');

  await until(page, () => document.querySelector('[data-testid="session-details"]') !== null, null, 'session details');
  assert.equal(await dialog(page).getByRole('button', { name: 'Sign out', exact: true }).count(), 1);
  assert.match(await trigger(page).innerText(), /Signed in/);
  const keys = await privateKeys(page);
  assert.equal(keys.length, 1);
  assert.ok(keys[0].includes(ADDR_A.toLowerCase()) && keys[0].endsWith('|session'), keys[0]);
  assert.equal(s.wallet.state.signed.length, s.signClicks);
  await s.close();
});

test('a reload restores the session through me, without a signature and without a new CSRF', async () => {
  const s = await scenario();
  const page = await s.open();
  await connect(page);
  await signIn(s, page);
  const [session] = activeSessions(s, ADDR_A);

  await page.reload({ waitUntil: 'load' });
  await viewIs(page, 'signed_in');
  assert.equal(s.wallet.state.signed.length, 1, 'no signature on reload');
  assert.equal(s.fake.calls('me').at(-1).csrf, null, 'me carries no CSRF');

  await openDialog(page);
  await dialog(page).getByRole('button', { name: 'Sign out' }).click();
  await viewIs(page, 'signed_out');
  const logout = s.fake.calls('logout').at(-1);
  assert.equal(logout.csrf, session.csrf, 'the CSRF from me after reload is the one verify issued');
  assert.equal(logout.status, 200);
  await s.close();
});

test('two tabs share one session: the second restores it, and a sign-out in either reaches both', async () => {
  const s = await scenario();
  const first = await s.open();
  await connect(first);
  await signIn(s, first);
  const [session] = activeSessions(s, ADDR_A);

  const second = await s.open();
  await viewIs(second, 'signed_in');
  assert.equal(s.wallet.state.signed.length, 1, 'the second tab signed nothing');

  await openDialog(second);
  await dialog(second).getByRole('button', { name: 'Sign out' }).click();
  await viewIs(second, 'signed_out');
  assert.equal(s.fake.calls('logout').at(-1).csrf, session.csrf);
  assert.equal(s.fake.calls('logout').at(-1).status, 200);
  // The first tab hears about it and reads its own state back.
  const firstView = await viewIs(first, 'signed_out');
  assert.equal(firstView.reason, 'session_ended');
  assert.deepEqual(await privateKeys(first), []);
  assert.equal(s.fake.count('logout'), 1);
  await s.close();
});

test("a sign-out in one tab reaches the other even while that tab's own me is in flight", async () => {
  const s = await scenario({ clockAt: Date.now() });
  const first = await s.open();
  await connect(first);
  await signIn(s, first);
  const second = await s.open();
  await viewIs(second, 'signed_in');

  // The second tab comes back into view and reads me. The service answers it
  // while the session is still alive, and the answer is delivered late.
  const held = s.fake.hold('me', 'after');
  await second.clock.fastForward('00:31');
  await second.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await held.arrived;

  await openDialog(first);
  await dialog(first).getByRole('button', { name: 'Sign out' }).click();
  await viewIs(first, 'signed_out');
  assert.equal(s.fake.calls('logout').at(-1).status, 200);
  // Let the broadcast land in the second tab while its me is still held.
  await sleep(300);
  held.release();

  const out = await viewIs(second, 'signed_out');
  assert.equal(out.reason, 'session_ended');
  assert.deepEqual(await privateKeys(second), []);
  assert.equal(await second.locator('[data-testid="session-details"]').count(), 0);
  assert.equal(s.wallet.state.signed.length, 1);
  await s.close();
});

test('a Sign out click while this tab is checking its session is not lost', async () => {
  const s = await scenario({ clockAt: Date.now() });
  const page = await s.open();
  await connect(page);
  await signIn(s, page);

  // The tab comes back into view and reads me; its answer is delivered late.
  const held = s.fake.hold('me', 'after');
  await page.clock.fastForward('00:31');
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await held.arrived;

  await openDialog(page);
  const button = dialog(page).getByRole('button', { name: 'Sign out' });
  assert.ok(await button.isEnabled());
  await button.click();
  const out = await viewIs(page, 'signed_out');
  assert.equal(out.reason, 'logged_out');
  assert.equal(s.fake.calls('logout').at(-1).status, 200);
  assert.deepEqual(activeSessions(s, ADDR_A), []);
  assert.deepEqual(await privateKeys(page), []);

  // The abandoned check's answer changes nothing.
  held.release();
  await sleep(500);
  assert.equal((await view(page)).status, 'signed_out');
  assert.equal(await page.locator('[data-testid="session-details"]').count(), 0);
  assert.equal(s.wallet.state.signed.length, 1);
  await s.close();
});

test('a new session another tab made for the same account gets a new private scope in this tab', async () => {
  const s = await scenario({ clockAt: Date.now() });
  const first = await s.open();
  await connect(first);
  await signIn(s, first);
  const second = await s.open();
  await viewIs(second, 'signed_in');
  const [before] = await privateKeys(first);
  const [old] = activeSessions(s, ADDR_A);

  // The first tab reads me while the old session is still alive; the answer
  // is delivered late, so it misses the other tab's sign-out in between.
  const held = s.fake.hold('me', 'after');
  await first.clock.fastForward('00:31');
  await first.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await held.arrived;

  await openDialog(second);
  await dialog(second).getByRole('button', { name: 'Sign out' }).click();
  await viewIs(second, 'signed_out');
  await signIn(s, second);
  const [renewed] = activeSessions(s, ADDR_A);
  assert.notEqual(renewed.csrf, old.csrf, 'the other tab made a new server session');
  await sleep(300);
  held.release();

  // The late answer is the old session; the waiting recheck finds the new one.
  const deadline = Date.now() + WAIT_MS;
  let keys = await privateKeys(first);
  while ((keys.length !== 1 || keys[0] === before) && Date.now() < deadline) {
    await sleep(50);
    keys = await privateKeys(first);
  }
  assert.equal((await view(first)).status, 'signed_in');
  assert.equal(keys.length, 1, 'only the new session has private data');
  assert.notEqual(keys[0], before, 'nothing is read under the old session scope');
  const [, connector, address, chain, epoch, part] = keys[0].split('|');
  const [, oldConnector, oldAddress, oldChain, oldEpoch] = before.split('|');
  assert.deepEqual([connector, address, chain, part], [oldConnector, oldAddress, oldChain, 'session']);
  assert.ok(Number(epoch) > Number(oldEpoch), `epoch ${oldEpoch} -> ${epoch}`);

  // The first tab now holds the new session's CSRF: its sign-out closes it.
  await openDialog(first);
  await dialog(first).getByRole('button', { name: 'Sign out' }).click();
  await viewIs(first, 'signed_out');
  assert.equal(s.fake.calls('logout').at(-1).csrf, renewed.csrf);
  assert.equal(s.fake.calls('logout').at(-1).status, 200);
  assert.deepEqual(activeSessions(s, ADDR_A), []);
  assert.equal(s.wallet.state.signed.length, 2, 'the first tab signed nothing');
  await s.close();
});

// ---- account and network changes --------------------------------------------

test('switching account drops private data at once, signs the old session out, and needs a fresh sign-in', async () => {
  const s = await scenario();
  const page = await s.open();
  await connect(page);
  await signIn(s, page);

  const held = s.fake.hold('logout');
  await s.wallet.switchAccount('a', 1);
  await held.arrived;
  // While the old session is still being signed out, nothing of A's is left.
  assert.deepEqual(await privateKeys(page), []);
  assert.equal((await view(page)).status, 'signing_out');
  assert.ok(!(await dialog(page).innerText()).includes(ADDR_A), "A's address is gone from the dialog");
  held.release();

  const after = await viewIs(page, 'signed_out');
  assert.equal(after.reason, 'identity_changed');
  const logout = s.fake.calls('logout')[0];
  assert.equal(logout.status, 200);
  assert.deepEqual(activeSessions(s, ADDR_A), [], "A's session is revoked");
  assert.equal(s.wallet.state.signed.length, 1, 'no signature was requested for B on its own');

  await signIn(s, page);
  const keys = await privateKeys(page);
  assert.ok(keys.every((key) => key.includes(ADDR_B.toLowerCase())), keys.join(', '));
  await s.close();
});

test('switching network signs out once, reads nothing on the wrong chain, and switches back on request', async () => {
  const s = await scenario();
  const page = await s.open();
  await connect(page);
  await signIn(s, page);

  await s.wallet.switchChain('a', 1);
  await viewIs(page, 'wrong_network');
  await until(page, () => true, null, 'settle');
  const meBefore = s.fake.count('me');
  await sleep(500);
  assert.equal(s.fake.count('me'), meBefore, 'no me on the wrong chain');
  assert.equal(s.fake.count('logout'), 1, 'exactly one sign-out');
  assert.deepEqual(await privateKeys(page), []);

  await openDialog(page);
  await dialog(page).getByRole('button', { name: 'Switch to Robinhood Chain' }).click();
  const back = await viewIs(page, 'signed_out');
  assert.equal(back.reason, 'none', 'the old session is gone; a fresh sign-in is required');
  assert.deepEqual(s.wallet.calls('wallet_switchEthereumChain').map((call) => call.params[0].chainId), ['0x1237']);
  await s.close();
});

test('a wallet that does not know Robinhood Chain is asked to add it by hand, never through the app', async () => {
  const s = await scenario();
  const page = await s.open();
  await connect(page);
  await s.wallet.switchChain('a', 1);
  await viewIs(page, 'wrong_network');
  s.wallet.forgetChain('a', 4663);
  await openDialog(page);
  await dialog(page).getByRole('button', { name: 'Switch to Robinhood Chain' }).click();
  await dialog(page).getByRole('alert').waitFor();
  assert.match(await dialog(page).getByRole('alert').innerText(), /Add Robinhood Chain \(4663\) in your wallet/);
  await s.close();
});

test('reopening the app with the wallet on another account shows the stored session as someone else’s', async () => {
  const s = await scenario();
  const first = await s.open();
  await connect(first);
  await signIn(s, first);
  await first.close();

  await s.wallet.switchAccount('a', 1, { silently: true });
  const page = await s.open();
  const other = await viewIs(page, 'other_session');
  assert.equal(other.owner, ADDR_A.toLowerCase());
  assert.deepEqual(await privateKeys(page), [], "B never sees A's private data");

  await openDialog(page);
  await dialog(page).getByRole('button', { name: 'Sign that session out' }).click();
  await viewIs(page, 'signed_out');
  assert.deepEqual(activeSessions(s, ADDR_A), []);
  await s.close();
});

// ---- two wallets that announce the same rdns ------------------------------

/**
 * An EIP-6963 provider declares its own rdns, so nothing stops two of them
 * declaring the same one. These two differ only in uuid and name, and hold
 * the same account.
 */
const SAME_RDNS = [
  { id: 'a', name: 'Test Wallet A', rdns: 'test.wallet.shared', uuid: '8f2a7d1c-0000-4000-8000-0000000000a1' },
  { id: 'b', name: 'Test Wallet B', rdns: 'test.wallet.shared', uuid: '8f2a7d1c-0000-4000-8000-0000000000b1' },
];
/** The wallets asked for account access (the connect prompt), in order. */
const accessRequests = (s) => s.wallet.calls('wallet_requestPermissions').map((call) => call.id);

test('two wallets announcing the same rdns: each button connects its own provider, which then signs', async () => {
  const s = await scenario({ wallets: SAME_RDNS });
  const page = await s.open();
  await viewIs(page, 'no_wallet');
  await openDialog(page);
  const names = await dialog(page).getByRole('list', { name: 'Browser wallets' }).getByRole('button').allInnerTexts();
  assert.deepEqual(names.map((name) => name.replace(/\s+/g, ' ').trim()), ['Connect Test Wallet A', 'Connect Test Wallet B']);

  await connect(page, 'Test Wallet B');
  assert.deepEqual(accessRequests(s), ['b'], 'the B button asked B, and only B, for access');
  assert.match(await dialog(page).innerText(), /Test Wallet B/);
  await signIn(s, page);
  assert.deepEqual(s.wallet.state.signed.map((entry) => entry.id), ['b'], 'B signed the sign-in message');

  await dialog(page).getByRole('button', { name: 'Sign out', exact: true }).click();
  await viewIs(page, 'signed_out');
  await dialog(page).getByRole('button', { name: 'Disconnect wallet' }).click();
  await connect(page, 'Test Wallet A');
  assert.deepEqual(accessRequests(s), ['b', 'a'], 'the A button asked A');
  assert.match(await dialog(page).innerText(), /Test Wallet A/);
  await s.close();
});

test('a second wallet with the same rdns taking over the connection ends the first one’s session', async () => {
  const s = await scenario({ wallets: SAME_RDNS });
  const page = await s.open();
  await connect(page, 'Test Wallet A');
  await signIn(s, page);
  const [session] = activeSessions(s, ADDR_A);
  assert.equal((await privateKeys(page)).length, 1);

  // The user connects this site from B itself. wagmi makes B the connection:
  // the same address on the same chain, through another provider. That is
  // another wallet, so A's session must not carry over to it.
  await s.wallet.connectFromWallet('b');
  const after = await viewIs(page, 'signed_out');
  assert.equal(after.reason, 'identity_changed');
  assert.deepEqual(await privateKeys(page), [], "nothing of A's session is left in the private cache");
  const logout = s.fake.calls('logout').at(-1);
  assert.equal(logout.csrf, session.csrf, "A's session is the one signed out");
  assert.equal(logout.status, 200);
  assert.deepEqual(activeSessions(s, ADDR_A), []);
  assert.match(await dialog(page).innerText(), /Test Wallet B/);
  assert.equal(s.wallet.state.signed.length, 1, 'nothing was signed for B on its own');

  // B needs a sign-in of its own, and signs it itself.
  await signIn(s, page);
  assert.deepEqual(s.wallet.state.signed.map((entry) => entry.id), ['a', 'b']);
  assert.equal(activeSessions(s, ADDR_A).length, 1);
  await s.close();
});

// ---- expiry, logout, revocation --------------------------------------------

test('the absolute expiry is noticed on time: me, then signed out with private data cleared', async () => {
  const s = await scenario({ clockAt: Date.now() });
  const page = await s.open();
  await connect(page);
  await signIn(s, page);
  s.fake.advance(12 * HOUR + 60_000);
  await page.clock.fastForward('12:02:00');
  const ended = await viewIs(page, 'signed_out');
  assert.equal(ended.reason, 'session_ended');
  assert.deepEqual(await privateKeys(page), []);
  await s.close();
});

test('an idle expiry is found when the tab comes back into view', async () => {
  const s = await scenario({ clockAt: Date.now() });
  const page = await s.open();
  await connect(page);
  await signIn(s, page);
  s.fake.advance(31 * 60_000);
  // Past the visibility throttle, but before any scheduled check.
  await page.clock.fastForward('00:31');
  const reads = s.fake.count('me');
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  const ended = await viewIs(page, 'signed_out');
  assert.equal(ended.reason, 'session_ended');
  assert.equal(s.fake.count('me'), reads + 1, 'the visibility check found it');
  await s.close();
});

test('an idle expiry is noticed while the tab stays in view, and the end time is not overstated', async () => {
  const s = await scenario({ clockAt: Date.now() });
  const page = await s.open();
  await connect(page);
  await signIn(s, page);
  await until(page, () => document.querySelector('[data-testid="session-details"]') !== null, null, 'session details');
  const details = await page.locator('[data-testid="session-details"]').innerText();
  assert.match(details, /Ends no later than/);
  assert.doesNotMatch(details, /Session ends/);
  assert.match(await dialog(page).innerText(), /ends a session sooner after 30 minutes idle/);

  // No visibility change, no other tab: the page's own checks find it.
  s.fake.advance(31 * 60_000);
  await page.clock.fastForward('31:00');
  const ended = await viewIs(page, 'signed_out');
  assert.equal(ended.reason, 'session_ended');
  assert.deepEqual(await privateKeys(page), []);
  assert.equal(await page.locator('[data-testid="session-details"]').count(), 0);
  await s.close();
});

test('after a reload the restored session is still checked every few minutes', async () => {
  const s = await scenario({ clockAt: Date.now() });
  const page = await s.open();
  await connect(page);
  await signIn(s, page);
  await page.reload({ waitUntil: 'load' });
  await viewIs(page, 'signed_in');
  s.fake.advance(31 * 60_000);
  await page.clock.fastForward('05:01');
  const ended = await viewIs(page, 'signed_out');
  assert.equal(ended.reason, 'session_ended');
  assert.deepEqual(await privateKeys(page), []);
  assert.equal(s.wallet.state.signed.length, 1);
  await s.close();
});

test('a browser clock running ahead of the server does not loop on me', async () => {
  const s = await scenario({ clockAt: Date.now() + 13 * HOUR });
  const page = await s.open();
  await connect(page);
  await signIn(s, page);
  const reads = s.fake.count('me');
  await page.clock.fastForward('02:00');
  await sleep(300);
  assert.equal(s.fake.count('me'), reads);
  assert.equal((await view(page)).status, 'signed_in');
  await s.close();
});

test('sign-out is confirmed by the service, clears the cookie, and survives a reload', async () => {
  const s = await scenario();
  const page = await s.open();
  await connect(page);
  await signIn(s, page);
  await openDialog(page);
  await dialog(page).getByRole('button', { name: 'Sign out' }).click();
  const out = await viewIs(page, 'signed_out');
  assert.equal(out.reason, 'logged_out');
  assert.equal(s.fake.calls('logout')[0].status, 200);
  const cookies = await s.context.cookies();
  assert.deepEqual(cookies.filter((cookie) => cookie.name.startsWith('__Host-domino-')), []);
  await page.reload({ waitUntil: 'load' });
  assert.equal((await viewIs(page, 'signed_out')).reason, 'none');
  await s.close();
});

test('revocation ends the session, and re-admission does not bring it back: a new sign-in is needed', async () => {
  const s = await scenario();
  const page = await s.open();
  await connect(page);
  await signIn(s, page);

  s.fake.revoke(ADDR_A);
  await page.reload({ waitUntil: 'load' });
  await viewIs(page, 'signed_out');
  s.fake.admit(ADDR_A);
  await page.reload({ waitUntil: 'load' });
  assert.equal((await viewIs(page, 'signed_out')).reason, 'none', 'the old session stays dead');
  assert.equal(s.wallet.state.signed.length, 1, 'nothing asked for a signature on its own');

  await signIn(s, page);
  assert.equal(s.wallet.state.signed.length, 2);
  const rows = s.fake.sessionsFor(ADDR_A);
  assert.deepEqual(rows.map((row) => row.active), [false, true]);
  await s.close();
});

test('an expired or used challenge is refused, and nothing is signed or sent again without a click', async () => {
  const s = await scenario();
  const page = await s.open();
  await connect(page);
  s.wallet.state.beforeSign = async () => s.fake.expireChallenges();
  await clickSignIn(s, page);
  const out = await viewIs(page, 'signed_out');
  assert.equal(out.reason, 'challenge_expired');
  await sleep(800);
  assert.equal(s.wallet.state.signed.length, 1);
  assert.equal(s.fake.count('challenge'), 1);
  assert.equal(s.fake.count('verify'), 1);
  assert.match(await dialog(page).innerText(), /expired or was already used/);
  await s.close();
});

test('a verify response lost after its cookie landed is recovered through me, without replaying the signature', async () => {
  const s = await scenario();
  const page = await s.open();
  await connect(page);
  s.fake.controls.breakAfterHeaders.add('verify');
  await signIn(s, page);
  assert.equal(s.fake.count('verify'), 1);
  assert.equal(s.wallet.state.signed.length, 1);
  assert.equal(s.fake.calls('me').length, 2, 'the initial check and the recovery');
  await s.close();
});

test('a verify response lost before any cookie is closed with the preauth abort; the signature is not replayed', async () => {
  const s = await scenario();
  const page = await s.open();
  await connect(page);
  s.fake.controls.dropAfterCommit.add('verify');
  await clickSignIn(s, page);
  const out = await viewIs(page, 'signed_out');
  assert.equal(out.reason, 'lost_response');
  assert.equal(s.fake.count('verify'), 1);
  assert.equal(s.fake.calls('logout')[0].status, 200);
  assert.deepEqual(activeSessions(s, ADDR_A), [], 'the session the lost verify created is revoked');
  await s.close();
});

test('a verify answered by a platform 5xx after it committed is closed with the preauth abort, and the next sign-in works', async () => {
  for (const [status, failure] of [
    [502, 'service_unavailable'],
    [503, 'gate_unavailable'],
  ]) {
    const s = await scenario();
    const page = await s.open();
    await connect(page);
    s.fake.controls.platformErrorAfterCommit.set('verify', status);
    await clickSignIn(s, page);
    const out = await viewIs(page, 'blocked');
    assert.equal(out.failure, failure, `${status}`);
    assert.deepEqual(s.fake.state.log.map((entry) => entry.route), ['me', 'bootstrap', 'challenge', 'verify', 'me', 'logout'], `${status}`);
    assert.equal(s.fake.calls('logout')[0].status, 200, 'the preauth abort revoked what verify created');
    assert.deepEqual(activeSessions(s, ADDR_A), []);

    await dialog(page).getByRole('button', { name: 'Check again' }).click();
    await viewIs(page, 'signed_out');
    await signIn(s, page);
    assert.equal(s.fake.calls('bootstrap').at(-1).status, 200, 'no session_exists lockout from the old context');
    assert.equal(s.wallet.state.signed.length, 2, 'the second signature came from the second click');
    await s.close();
  }
});

// ---- admission, unavailability, gate ----------------------------------------

test('wallet_not_allowed after a valid signature shows the invitation state and stops every request', async () => {
  const s = await scenario({ admit: [] });
  const page = await s.open();
  await connect(page);
  await clickSignIn(s, page);
  await viewIs(page, 'not_invited');
  assert.equal(s.wallet.state.signed.length, 1, 'the denial came after a valid signature');
  const requests = s.fake.state.log.length;
  await sleep(3000);
  assert.equal(s.fake.state.log.length, requests, 'nothing is sent after the denial');
  const text = await dialog(page).innerText();
  assert.match(text, /isn’t on the invited list/);
  assert.doesNotMatch(text, /unavailable|outage|network/i);
  assert.equal(await dialog(page).getByRole('button', { name: 'Sign in', exact: true }).count(), 0);
  await s.close();
});

test('an unavailable session store is its own state, and trying again only reads me', async () => {
  const s = await scenario();
  s.fake.controls.storeDown.add('me');
  const page = await s.open();
  await viewIs(page, 'no_wallet');
  await openDialog(page);
  await dialog(page).getByRole('button', { name: 'Connect Test Wallet A' }).click();
  const down = await viewIs(page, 'blocked');
  assert.equal(down.failure, 'store_unavailable');
  assert.match(await dialog(page).innerText(), /temporarily unavailable\. This is not a problem with your wallet/);

  s.fake.controls.storeDown.delete('me');
  await dialog(page).getByRole('button', { name: 'Check again' }).click();
  await viewIs(page, 'signed_out');
  assert.equal(s.fake.count('bootstrap'), 0);

  s.fake.controls.storeDown.add('verify');
  await clickSignIn(s, page);
  const failed = await viewIs(page, 'blocked');
  assert.equal(failed.failure, 'store_unavailable');
  assert.equal(s.fake.calls('logout').at(-1).status, 200, 'the pending login was closed');
  await s.close();
});

test('an expired beta cookie is reported as such, through the real gate, and is not a session state', async () => {
  const gate = { BETA_PASSWORD: GATE_PASSWORD, BETA_COOKIE_KEY: GATE_KEY };
  const s = await scenario({ gate });
  const page = await s.context.newPage();
  await enterBeta(page, s.origin);
  await connect(page);
  await s.context.clearCookies({ name: '__Host-domino-beta' });
  await clickSignIn(s, page);
  const out = await viewIs(page, 'blocked');
  assert.equal(out.failure, 'gate_required');
  assert.match(await dialog(page).innerText(), /beta access expired/);
  assert.equal(s.wallet.state.signed.length, 0);
  await s.close();
});

test('a broken gate configuration is reported as the site being unavailable', async () => {
  const gate = { BETA_PASSWORD: GATE_PASSWORD, BETA_COOKIE_KEY: GATE_KEY };
  const s = await scenario({ gate });
  const page = await s.context.newPage();
  await enterBeta(page, s.origin);
  await connect(page);
  gate.BETA_COOKIE_KEY = '';
  await clickSignIn(s, page);
  const out = await viewIs(page, 'blocked');
  assert.equal(out.failure, 'gate_unavailable');
  assert.equal(s.wallet.state.signed.length, 0);
  await s.close();
});

// ---- isolation and races ---------------------------------------------------

test("cross-account isolation: after A then B, nothing of A's is shown, cached or sent", async () => {
  const s = await scenario();
  const page = await s.open();
  await connect(page);
  await signIn(s, page);
  await s.wallet.switchAccount('a', 1);
  await viewIs(page, 'signed_out');
  await signIn(s, page);
  const signedInB = s.fake.state.log.length;

  const text = (await page.locator('body').innerText()).toLowerCase();
  assert.ok(!text.includes(ADDR_A.toLowerCase()) && !text.includes(ADDR_A.slice(0, 6).toLowerCase() + '…'), "A's address is on screen");
  const keys = await privateKeys(page);
  assert.ok(keys.length > 0 && keys.every((key) => key.includes(ADDR_B.toLowerCase())), keys.join(', '));
  assert.deepEqual(activeSessions(s, ADDR_A), []);

  await page.reload({ waitUntil: 'load' });
  await viewIs(page, 'signed_in');
  for (const entry of s.fake.state.log.slice(signedInB)) {
    if (entry.cookies.session) assert.equal(s.fake.ownerOfSessionCookie(entry.cookies.session), ADDR_B.toLowerCase());
  }
  await s.close();
});

test("A's me held across a switch to B is discarded when it lands", async () => {
  const s = await scenario();
  const page = await s.open();
  await connect(page);
  await signIn(s, page);
  const held = s.fake.hold('me');
  await page.reload({ waitUntil: 'load' });
  await held.arrived;
  await s.wallet.switchAccount('a', 1);
  held.release();
  const other = await viewIs(page, 'other_session');
  assert.equal(other.owner, ADDR_A.toLowerCase(), 'B is told a session for A exists, nothing more');
  assert.deepEqual(await privateKeys(page), []);
  assert.equal(await page.locator('[data-testid="session-details"]').count(), 0);
  await s.close();
});

test("A's verify held across a switch is discarded, and the session it created is revoked", async () => {
  const s = await scenario();
  const page = await s.open();
  await connect(page);
  const held = s.fake.hold('verify', 'after');
  await clickSignIn(s, page);
  await held.arrived;
  await s.wallet.switchAccount('a', 1);
  const out = await viewIs(page, 'signed_out');
  assert.equal(out.reason, 'identity_changed');
  held.release();
  await sleep(300);
  assert.deepEqual(activeSessions(s, ADDR_A), []);
  assert.equal((await view(page)).status, 'signed_out');
  assert.deepEqual(await privateKeys(page), []);
  await s.close();
});

test('a verify whose cookie landed but whose body did not is still revoked after a switch', async () => {
  const s = await scenario();
  const page = await s.open();
  await connect(page);
  const stall = s.fake.stallAfterHeaders('verify');
  await clickSignIn(s, page);
  await stall.arrived;
  await s.wallet.switchAccount('a', 1);
  await viewIs(page, 'signed_out');
  stall.release();
  // The preauth abort cannot match any more (the browser holds the new session
  // cookie instead), so the client recovers the session CSRF from me and closes it.
  assert.deepEqual(
    s.fake.calls('logout').map((entry) => entry.status),
    [403, 200],
  );
  assert.deepEqual(activeSessions(s, ADDR_A), []);
  await s.close();
});

test('session_exists is adopted through me, with no second signature', async () => {
  const s = await scenario();
  const first = await s.open();
  await connect(first);
  await signIn(s, first);
  // The second tab reads me at the wrong moment and believes there is no session.
  s.fake.controls.failNext.set('me', 'session_required');
  const second = await s.open();
  await viewIs(second, 'signed_out');
  await clickSignIn(s, second);
  await viewIs(second, 'signed_in');
  assert.equal(s.fake.calls('bootstrap').at(-1).status, 409);
  assert.equal(s.wallet.state.signed.length, 1);
  await s.close();
});

// ---- misconfiguration and untrusted input -----------------------------------

test('a switched-off or unrouted session service says sign-in is not enabled', async () => {
  for (const setup of [(fake) => (fake.controls.disabled = true), (fake) => (fake.controls.notRouted = true)]) {
    const s = await scenario();
    setup(s.fake);
    const page = await s.open();
    await viewIs(page, 'no_wallet');
    await openDialog(page);
    await dialog(page).getByRole('button', { name: 'Connect Test Wallet A' }).click();
    const out = await viewIs(page, 'blocked');
    assert.equal(out.failure, 'service_disabled');
    assert.match(await dialog(page).innerText(), /isn’t enabled on this deployment/);
    await s.close();
  }
});

test('a contract mismatch stops without a retry loop, and a mismatched verify is never adopted', async () => {
  const s = await scenario();
  const page = await s.open();
  await connect(page);
  await signIn(s, page);
  s.fake.controls.corruptNext.set('me', 'version');
  await page.reload({ waitUntil: 'load' });
  assert.equal((await viewIs(page, 'blocked')).failure, 'contract_mismatch');
  const reads = s.fake.count('me');
  await sleep(1000);
  assert.equal(s.fake.count('me'), reads, 'no retry loop');
  assert.deepEqual(await privateKeys(page), []);
  await s.close();

  const t = await scenario();
  const again = await t.open();
  await connect(again);
  t.fake.controls.corruptNext.set('verify', 'extra_field');
  await clickSignIn(t, again);
  assert.equal((await viewIs(again, 'blocked')).failure, 'contract_mismatch');
  assert.deepEqual(activeSessions(t, ADDR_A), [], 'the session behind the unreadable answer is closed');
  await t.close();
});

test('a message for another domain is never shown to the wallet', async () => {
  const s = await scenario();
  const page = await s.open();
  await connect(page);
  s.fake.controls.foreignDomain = true;
  await clickSignIn(s, page);
  assert.equal((await viewIs(page, 'blocked')).failure, 'untrusted_challenge');
  assert.equal(s.wallet.calls('personal_sign').length, 0);
  assert.equal(s.fake.calls('logout')[0].status, 200, 'the preauth context is closed');
  await s.close();
});

test('a declined signature closes the login and is not asked again', async () => {
  const s = await scenario();
  const page = await s.open();
  await connect(page);
  s.wallet.rejectNext('a', 'personal_sign');
  await clickSignIn(s, page);
  assert.equal((await viewIs(page, 'signed_out')).reason, 'signature_declined');
  await sleep(500);
  assert.equal(s.wallet.calls('personal_sign').length, 1);
  assert.equal(s.fake.count('verify'), 0);
  assert.equal(s.fake.calls('logout')[0].status, 200);
  await s.close();
});

// ---- what signing in does not change ----------------------------------------

test('signing in grants nothing: the site says so, and signing stays off', async () => {
  const s = await scenario();
  const page = await s.open();
  await connect(page);
  await signIn(s, page);
  // The owner removed the permanent explanatory paragraphs from this modal.
  // Permissions remain unchanged and the existing Settings explanation stays.
  assert.doesNotMatch(await dialog(page).innerText(), /Signing in is not a permission|Only standard wallets/);
  await dialog(page).getByRole('button', { name: 'Close' }).click();
  // Signed in is all the header claims: no mode label, and nothing about what
  // the address may now do.
  const header = await page.locator('header').innerText();
  assert.match(header, /Signed in/);
  assert.doesNotMatch(header, /practice/i);

  await page.evaluate(() => (window.location.hash = '#/settings'));
  await until(page, () => /Signing/.test(document.body.innerText), null, 'settings');
  const settings = await page.locator('main').innerText();
  assert.match(settings, /Signing\s+Off/);
  assert.match(settings, /grants no spending permission/);
  assert.doesNotMatch(settings, /practice/i);
  // Moving between routes keeps the session without reading it again.
  const reads = s.fake.count('me');
  await page.evaluate(() => (window.location.hash = '#/'));
  await page.evaluate(() => (window.location.hash = '#/app'));
  await viewIs(page, 'signed_in');
  assert.equal(s.fake.count('me'), reads);
  await s.close();
});

test('the wallet build still renders exactly one React', async () => {
  const s = await scenario();
  const page = await s.open();
  await connect(page);
  const suffixes = await page.evaluate(() => {
    const found = new Set();
    for (const el of document.querySelectorAll('body *')) {
      for (const key of Object.keys(el)) {
        const match = /^__reactFiber(\$.+)$/.exec(key);
        if (match) found.add(match[1]);
      }
    }
    return [...found];
  });
  assert.equal(suffixes.length, 1, JSON.stringify(suffixes));
  await s.close();
});

test('a wallet chunk that fails to load leaves the app running with the disabled control', async () => {
  const chunk = readdirSync(join(WALLET_DIST, 'assets')).find((file) => file.startsWith('WalletSessionIsland-'));
  const s = await scenario({
    allowConsoleErrors: true,
    intercept: (url) =>
      url.pathname === `/assets/${chunk}`
        ? new Response('{"error":"beta_access_required"}', { status: 401, headers: { 'Content-Type': 'application/json' } })
        : undefined,
  });
  const page = await s.open();
  // The Suspense fallback shows first; the boundary replaces it once the import fails.
  await until(page, () => /could not load/.test(document.querySelector('header button[disabled]')?.title ?? ''), null, 'boundary fallback');
  const fallback = page.locator('header').getByRole('button', { name: 'Connect wallet' });
  assert.equal(await fallback.isDisabled(), true);
  assert.ok((await page.locator('main').innerText()).length > 200, 'the rest of the app still renders');
  assert.equal(s.fake.state.log.length, 0);
  await s.close();
});

// ---- private reads, focus and challenge replay -----------------------------

const probe = {
  arm: (page) => page.evaluate(() => window.__dominoSessionProbe.armPrivateRead()),
  reads: (page) => page.evaluate(() => window.__dominoSessionProbe.privateReads()),
  values: (page) => page.evaluate(() => window.__dominoSessionProbe.privateValues()),
  resolve: (page, match, value) =>
    page.evaluate(([m, v]) => window.__dominoSessionProbe.resolvePrivateReads(m, v), [match, value]),
  started: (page, match, label) =>
    until(page, (m) => window.__dominoSessionProbe.privateReads().some((read) => read.key.includes(m) && !read.settled), match, label),
  shown: (page) => page.getByTestId('private-probe').textContent(),
};

test("a private read in flight when the account switches never shows A's answer to B", async () => {
  const s = await scenario();
  const page = await s.open();
  await connect(page);
  await signIn(s, page);
  const a = ADDR_A.toLowerCase();
  const b = ADDR_B.toLowerCase();

  await probe.arm(page);
  await probe.started(page, a, "A's private read");
  await s.wallet.switchAccount('a', 1);
  await viewIs(page, 'signed_out');
  const cancelled = (await probe.reads(page)).filter((read) => read.key.includes(a));
  assert.ok(cancelled.length === 1 && cancelled[0].aborted, JSON.stringify(cancelled));

  await signIn(s, page);
  await probe.started(page, b, "B's private read");
  // A's answer arrives only now, while B is signed in and B's own read is open.
  assert.equal(await probe.resolve(page, a, 'secret-of-A'), 1);
  await sleep(300);
  assert.equal(await probe.shown(page), '');
  assert.ok(!(await probe.values(page)).some((value) => value.includes('secret-of-A')), "A's answer is in the cache");
  const keys = await privateKeys(page);
  assert.ok(keys.every((key) => key.includes(b)), keys.join(', '));

  assert.equal(await probe.resolve(page, b, 'secret-of-B'), 1);
  await until(page, () => document.querySelector('[data-testid="private-probe"]')?.textContent === 'secret-of-B', undefined, "B's answer");
  await s.close();
});

test('a private read in flight across sign-out and a new sign-in for the same account stays with its session', async () => {
  const s = await scenario();
  const page = await s.open();
  await connect(page);
  await signIn(s, page);
  await probe.arm(page);
  await probe.started(page, ADDR_A.toLowerCase(), 'the first private read');
  const [first] = await probe.reads(page);

  await openDialog(page);
  await dialog(page).getByRole('button', { name: 'Sign out', exact: true }).click();
  await viewIs(page, 'signed_out');
  await signIn(s, page);
  await until(
    page,
    (old) => window.__dominoSessionProbe.privateReads().some((read) => read.key !== old && !read.settled),
    first.key,
    'the second read',
  );
  const second = (await probe.reads(page)).find((read) => read.key !== first.key);
  assert.ok(first.aborted || (await probe.reads(page))[0].aborted, 'the first read was cancelled');

  assert.equal(await probe.resolve(page, first.key, 'old-session'), 1);
  await sleep(300);
  assert.equal(await probe.shown(page), '');
  assert.ok(!(await probe.values(page)).some((value) => value.includes('old-session')));
  assert.equal(await probe.resolve(page, second.key, 'new-session'), 1);
  await until(page, () => document.querySelector('[data-testid="private-probe"]')?.textContent === 'new-session', undefined, 'the new answer');
  await s.close();
});

const focusInDialog = (page) =>
  page.evaluate(() => {
    const node = document.querySelector('[role="dialog"]');
    return Boolean(node && node.contains(document.activeElement));
  });

/** Presses Tab until the focused element's text is `name`. */
async function tabTo(page, name) {
  for (let i = 0; i < 15; i += 1) {
    const text = await page.evaluate(() => document.activeElement?.textContent?.trim() ?? '');
    if (text === name) return;
    await page.keyboard.press('Tab');
  }
  throw new Error(`Tab never reached ${name}`);
}

test('the wallet dialog takes focus, keeps Tab inside, closes on Escape and returns focus to its trigger', async () => {
  const s = await scenario();
  const page = await s.open();
  await viewIs(page, 'no_wallet');
  await trigger(page).focus();
  await page.keyboard.press('Enter');
  await dialog(page).waitFor();
  assert.equal(await page.evaluate(() => document.activeElement?.id), 'wallet-dialog-title', 'focus starts on the title');
  assert.equal(await trigger(page).getAttribute('aria-expanded'), 'true');
  assert.equal(await page.locator('#root').getAttribute('aria-hidden'), 'true', 'the page behind is hidden');
  assert.notEqual(await page.locator('#root').getAttribute('inert'), null, 'the page behind is inert');

  for (const key of ['Tab', 'Shift+Tab']) {
    for (let i = 1; i <= 12; i += 1) {
      await page.keyboard.press(key);
      assert.ok(await focusInDialog(page), `${key} #${i} left the dialog`);
    }
  }

  await page.keyboard.press('Escape');
  await dialog(page).waitFor({ state: 'detached' });
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('aria-haspopup')), 'dialog', 'focus is back on the trigger');
  assert.equal(await trigger(page).getAttribute('aria-expanded'), 'false');
  assert.equal(await page.locator('#root').getAttribute('aria-hidden'), null);
  await s.close();
});

test('a keyboard sign-in keeps focus inside the dialog as each step replaces its buttons', async () => {
  const s = await scenario();
  const page = await s.open();
  await viewIs(page, 'no_wallet');
  await trigger(page).focus();
  await page.keyboard.press('Enter');
  await dialog(page).waitFor();

  await tabTo(page, 'Connect Test Wallet A');
  await page.keyboard.press('Enter');
  await viewIs(page, 'signed_out');
  assert.ok(await focusInDialog(page), 'focus was lost when the wallet list went away');

  await tabTo(page, 'Sign in');
  s.signClicks += 1;
  await page.keyboard.press('Enter');
  await viewIs(page, 'signed_in');
  assert.ok(await focusInDialog(page), 'focus was lost when the sign-in buttons changed');

  await tabTo(page, 'Sign out');
  await page.keyboard.press('Enter');
  await viewIs(page, 'signed_out');
  assert.ok(await focusInDialog(page), 'focus was lost when Sign out went away');

  await page.keyboard.press('Escape');
  await dialog(page).waitFor({ state: 'detached' });
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('aria-haspopup')), 'dialog');
  await s.close();
});

test('a challenge another verify already used is refused; nothing is signed or verified again until the next click', async () => {
  const s = await scenario();
  const page = await s.open();
  await connect(page);
  s.wallet.state.beforeSign = async () => s.fake.consumeChallenges();
  await clickSignIn(s, page);
  const out = await viewIs(page, 'signed_out');
  assert.equal(out.reason, 'challenge_expired');
  await sleep(800);
  assert.equal(s.wallet.state.signed.length, 1);
  assert.equal(s.fake.count('challenge'), 1);
  assert.equal(s.fake.count('verify'), 1);
  assert.ok(s.fake.calls('verify')[0].status >= 400, 'the used challenge was refused');
  assert.deepEqual(activeSessions(s, ADDR_A), []);
  assert.match(await dialog(page).innerText(), /expired or was already used/);

  // The next attempt is the user's own, with a fresh challenge and nonce.
  s.wallet.state.beforeSign = null;
  await signIn(s, page);
  const [first, second] = s.wallet.state.signed.map((entry) => /Nonce: (\S+)/.exec(entry.message)[1]);
  assert.notEqual(first, second);
  assert.equal(s.fake.count('verify'), 2);
  await s.close();
});

test('a verify replayed after it succeeded is refused, creates nothing, and leaves the signed-in tab as it was', async () => {
  const s = await scenario();
  const page = await s.open();
  await connect(page);
  let captured = null;
  page.on('request', (request) => {
    if (request.url().endsWith('/api/session/v1/verify')) captured = { headers: request.headers(), body: request.postData() };
  });
  await signIn(s, page);
  assert.ok(captured, 'the verify request was seen');
  const { challengeId } = JSON.parse(captured.body);
  s.replayed.add(challengeId);

  // Exactly the same request again, from the same page and cookie jar.
  const replay = await page.evaluate(async ({ headers, body }) => {
    const response = await fetch('/api/session/v1/verify', {
      method: 'POST',
      credentials: 'same-origin',
      headers: {
        'Content-Type': headers['content-type'],
        'X-Domino-CSRF': headers['x-domino-csrf'],
        'X-Domino-Session-Contract': headers['x-domino-session-contract'],
      },
      body,
    });
    return { status: response.status, body: await response.json() };
  }, captured);
  assert.ok(replay.status >= 400 && replay.status < 500, JSON.stringify(replay));
  // Which rule refuses it depends on what the service checks first: the live
  // session (session_exists), the spent preauth context, or the used challenge.
  assert.ok(['session_exists', 'preauth_required', 'challenge_invalid'].includes(replay.body.error), JSON.stringify(replay));
  assert.equal(activeSessions(s, ADDR_A).length, 1, 'no second session');
  assert.equal(s.fake.state.verifies.get(challengeId), 2);

  await sleep(500);
  assert.equal((await view(page)).status, 'signed_in');
  assert.equal(s.wallet.state.signed.length, 1, 'nothing was signed again');
  assert.equal(s.fake.count('challenge'), 1);
  await s.close();
});

// ---- refresh (POST /refresh renews the 30-minute idle deadline) -------------

/** A trusted key press: user activity in this tab, with no effect on the page. */
const act = (page) => page.keyboard.press('Shift');

/** Polls a condition on the test side (the fake's log), not in the page. */
async function eventually(check, label, timeout = WAIT_MS) {
  const deadline = Date.now() + timeout;
  for (;;) {
    if (check()) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await sleep(25);
  }
}

/** Makes the page report itself hidden or visible, the way a background tab does. */
const setVisibility = (page, state) =>
  page.evaluate((value) => {
    Object.defineProperty(document, 'visibilityState', { value, configurable: true });
    Object.defineProperty(document, 'hidden', { value: value === 'hidden', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
  }, state);

test('while the user is active in a visible tab, refresh keeps the session alive well past 30 idle minutes', async () => {
  const s = await scenario({ clockAt: Date.now() });
  const page = await s.open();
  await connect(page);
  await signIn(s, page);
  const [session] = activeSessions(s, ADDR_A);
  const [scope] = await privateKeys(page);

  for (let round = 1; round <= 3; round += 1) {
    await act(page);
    s.fake.advance(21 * 60_000);
    await page.clock.fastForward('21:00');
    await eventually(() => s.fake.count('refresh') === round, `refresh ${round}`);
    await until(page, () => window.__dominoSessionProbe.view().status === 'signed_in' && !document.querySelector('[aria-busy="true"]'), null, 'settled');
  }

  // 63 minutes after sign-in, with no request but GET me and refresh.
  assert.equal((await view(page)).status, 'signed_in');
  const [alive] = activeSessions(s, ADDR_A);
  assert.ok(alive, 'the server session is still active');
  assert.equal(alive.csrf, session.csrf, 'refresh never rotates the CSRF');
  for (const call of s.fake.calls('refresh')) {
    assert.equal(call.csrf, session.csrf, 'refresh carries the session CSRF');
    assert.equal(call.status, 200);
  }
  assert.deepEqual(await privateKeys(page), [scope], 'the same private scope, kept across refreshes');
  assert.equal(s.wallet.state.signed.length, 1, 'no signature after sign-in');
  await s.close();
});

test('without activity the session is not refreshed and idles out as before', async () => {
  const s = await scenario({ clockAt: Date.now() });
  const page = await s.open();
  await connect(page);
  await signIn(s, page);
  s.fake.advance(31 * 60_000);
  await page.clock.fastForward('31:00');
  const ended = await viewIs(page, 'signed_out');
  assert.equal(ended.reason, 'session_ended');
  assert.equal(s.fake.count('refresh'), 0);
  await s.close();
});

test("two tabs refreshing the same session keep one CSRF, and neither breaks the other's", async () => {
  const s = await scenario({ clockAt: Date.now() });
  const first = await s.open();
  await connect(first);
  await signIn(s, first);
  const second = await s.open();
  await viewIs(second, 'signed_in');
  const [session] = activeSessions(s, ADDR_A);
  const reads = s.fake.count('me');

  // The restored tab does not know when the session last renewed, so the
  // first activity there refreshes at once, and tells the other tab.
  await act(second);
  await eventually(() => s.fake.count('refresh') === 1, 'the restored tab refreshed');
  await sleep(300);
  assert.equal(s.fake.count('me'), reads, 'a renewal notice makes no tab read me');

  // Both tabs in use through the next window.
  await act(first);
  await act(second);
  s.fake.advance(21 * 60_000);
  await first.clock.fastForward('21:00');
  await eventually(() => s.fake.count('refresh') >= 2, 'a refresh in the next window');
  await sleep(500);
  const refreshes = s.fake.calls('refresh');
  assert.ok(refreshes.length <= 3, `at most one refresh per tab per window, not ${refreshes.length}`);
  for (const call of refreshes) {
    assert.equal(call.csrf, session.csrf);
    assert.equal(call.status, 200);
  }
  for (const page of [first, second]) assert.equal((await view(page)).status, 'signed_in');
  assert.equal(activeSessions(s, ADDR_A).length, 1);
  assert.equal(activeSessions(s, ADDR_A)[0].csrf, session.csrf, 'both tabs still hold the one CSRF');

  // Quiet again: nothing more is sent.
  const settled = s.fake.state.log.length;
  await sleep(500);
  assert.equal(s.fake.state.log.length, settled, 'no refresh or me storm');

  // Either tab's CSRF still works: the second signs out, the first follows.
  await openDialog(second);
  await dialog(second).getByRole('button', { name: 'Sign out' }).click();
  await viewIs(second, 'signed_out');
  assert.equal(s.fake.calls('logout').at(-1).csrf, session.csrf);
  assert.equal(s.fake.calls('logout').at(-1).status, 200);
  assert.equal((await viewIs(first, 'signed_out')).reason, 'session_ended');
  assert.equal(s.wallet.state.signed.length, 1);
  await s.close();
});

test('a refresh after revocation signs out and clears private data, with no signature', async () => {
  const s = await scenario({ clockAt: Date.now() });
  const page = await s.open();
  await connect(page);
  await signIn(s, page);
  assert.equal((await privateKeys(page)).length, 1);

  await act(page);
  const held = s.fake.hold('refresh', 'before');
  s.fake.advance(21 * 60_000);
  await page.clock.fastForward('21:00');
  await held.arrived;
  s.fake.revoke(ADDR_A);
  held.release();

  const out = await viewIs(page, 'signed_out');
  assert.equal(out.reason, 'session_ended');
  assert.equal(s.fake.calls('refresh').at(-1).status, 401);
  assert.deepEqual(await privateKeys(page), []);
  assert.equal(await page.locator('[data-testid="session-details"]').count(), 0);
  assert.equal(s.wallet.state.signed.length, 1, 'no signature on refresh failure');
  await s.close();
});

test('a refresh the store cannot serve keeps the session, says so, and retries a bounded number of times', async () => {
  const s = await scenario({ clockAt: Date.now() });
  const page = await s.open();
  await connect(page);
  await signIn(s, page);
  const [scope] = await privateKeys(page);

  await act(page);
  s.fake.controls.storeDown.add('refresh');
  s.fake.advance(21 * 60_000);
  await page.clock.fastForward('21:00');
  await eventually(() => s.fake.count('refresh') === 1, 'the first refresh');
  const kept = await until(page, () => {
    const v = window.__dominoSessionProbe.view();
    return v.status === 'signed_in' && v.notice === 'refresh_unavailable' && v;
  }, null, 'the unavailable notice');
  assert.equal(kept.status, 'signed_in', 'a 503 is not a sign-out');
  assert.deepEqual(await privateKeys(page), [scope], 'private data stays');
  await openDialog(page);
  assert.match(await dialog(page).innerText(), /could not renew your session/);

  // Retries back off, and stop.
  for (const step of ['00:31', '01:01', '02:01']) {
    await page.clock.fastForward(step);
    await sleep(200);
  }
  await eventually(() => s.fake.count('refresh') === 4, 'three retries');
  await page.clock.fastForward('04:00');
  await sleep(300);
  assert.equal(s.fake.count('refresh'), 4, 'no more than three retries');
  assert.ok(s.fake.calls('refresh').every((call) => call.status === 503));
  assert.equal((await view(page)).status, 'signed_in');
  assert.equal(s.wallet.state.signed.length, 1);
  await s.close();
});

test('a tab whose outage retries ran out refreshes again once another tab has renewed the session', async () => {
  const s = await scenario({ clockAt: Date.now() });
  const first = await s.open();
  await connect(first);
  await signIn(s, first);
  // A second tab restores the session, and stays untouched through the outage.
  const second = await s.open();
  await viewIs(second, 'signed_in');
  const [session] = activeSessions(s, ADDR_A);

  // The first tab's refresh and all three of its retries meet an outage.
  await act(first);
  s.fake.controls.storeDown.add('refresh');
  s.fake.advance(21 * 60_000);
  await first.clock.fastForward('21:00');
  await eventually(() => s.fake.count('refresh') === 1, 'the first refresh');
  for (const step of ['00:31', '01:01', '02:01']) {
    await first.clock.fastForward(step);
    await sleep(200);
  }
  await eventually(() => s.fake.count('refresh') === 4, 'three retries');
  await first.clock.fastForward('04:00');
  await sleep(300);
  assert.equal(s.fake.count('refresh'), 4, 'the retries stop within the outage');

  // The service is back. The second tab's first activity renews the session
  // and tells the first; then the second tab goes to the background.
  s.fake.controls.storeDown.delete('refresh');
  await act(second);
  await eventually(() => s.fake.count('refresh') === 5, 'the second tab renewed');
  assert.equal(s.fake.calls('refresh').at(-1).status, 200);
  await until(first, () => {
    const v = window.__dominoSessionProbe.view();
    return v.status === 'signed_in' && v.notice === undefined;
  }, null, 'the first tab heard of the renewal');
  await setVisibility(second, 'hidden');

  // The user keeps working in the first tab only. It renews the session
  // itself before the idle deadline the second tab's renewal set.
  await act(first);
  s.fake.advance(21 * 60_000);
  await first.clock.fastForward('21:00');
  await eventually(() => s.fake.count('refresh') === 6, 'the first tab refreshes in the new window');
  assert.equal(s.fake.calls('refresh').at(-1).status, 200);
  assert.equal(s.fake.calls('refresh').at(-1).csrf, session.csrf);
  // Past the deadline the second tab's renewal set, the session lives on.
  await act(first);
  s.fake.advance(11 * 60_000);
  await first.clock.fastForward('11:00');
  await sleep(300);
  assert.equal(activeSessions(s, ADDR_A).length, 1, 'the server session is still active');
  assert.equal((await view(first)).status, 'signed_in');
  assert.equal(s.wallet.state.signed.length, 1, 'no signature after sign-in');
  await s.close();
});

test('a refresh that fails once and then succeeds clears the notice and renews the session', async () => {
  const s = await scenario({ clockAt: Date.now() });
  const page = await s.open();
  await connect(page);
  await signIn(s, page);

  await act(page);
  s.fake.controls.failNext.set('refresh', 'upstream_timeout');
  s.fake.advance(21 * 60_000);
  await page.clock.fastForward('21:00');
  await eventually(() => s.fake.count('refresh') === 1, 'the first refresh');
  await until(page, () => window.__dominoSessionProbe.view().notice === 'refresh_unavailable', null, 'the notice');
  await page.clock.fastForward('00:31');
  await eventually(() => s.fake.count('refresh') === 2, 'the retry');
  await until(page, () => {
    const v = window.__dominoSessionProbe.view();
    return v.status === 'signed_in' && v.notice === undefined;
  }, null, 'the notice cleared');
  assert.deepEqual(s.fake.calls('refresh').map((call) => call.status), [504, 200]);
  // Renewed: past the original idle deadline, the session lives on.
  s.fake.advance(15 * 60_000);
  assert.equal(activeSessions(s, ADDR_A).length, 1);
  await s.close();
});

// ---- the CSRF stays in memory ----------------------------------------------

/**
 * Everything a page could keep or show outside its memory, as text: the URL,
 * browser storage, cookies visible to scripts, IndexedDB, what was posted on
 * the session channel, the markup, and the private cache's keys and values.
 */
const outsideMemory = (page) =>
  page.evaluate(async () => ({
    url: location.href,
    localStorage: JSON.stringify(Object.entries(localStorage)),
    sessionStorage: JSON.stringify(Object.entries(sessionStorage)),
    cookie: document.cookie,
    indexedDB: JSON.stringify(await indexedDB.databases()),
    broadcasts: JSON.stringify(window.__dominoHeard),
    markup: document.documentElement.outerHTML,
    queryKeys: JSON.stringify(window.__dominoSessionProbe.privateKeys()),
    queryValues: JSON.stringify(window.__dominoSessionProbe.privateValues()),
  }));

test('the CSRF is only compared in memory: never stored, in a URL, a query key, the console or a cross-tab message', async () => {
  const s = await scenario({ clockAt: Date.now() });
  const logged = [];
  const urls = [];
  s.context.on('console', (message) => logged.push(message.text()));
  s.context.on('request', (request) => urls.push(request.url()));
  // A second listener on the session channel, in every page, hears what the app posts there.
  await s.context.addInitScript(() => {
    window.__dominoHeard = [];
    new BroadcastChannel('domino-session-v1').onmessage = (event) => window.__dominoHeard.push(event.data);
  });

  const first = await s.open();
  await connect(first);
  await signIn(s, first);
  const second = await s.open();
  await viewIs(second, 'signed_in');
  // An active tab refreshes; the other hears of the renewal.
  await act(first);
  s.fake.advance(21 * 60_000);
  await first.clock.fastForward('21:00');
  await eventually(() => s.fake.count('refresh') === 1, 'the refresh');
  await until(first, () => window.__dominoSessionProbe.view().status === 'signed_in' && !document.querySelector('[aria-busy="true"]'), null, 'settled');

  // Every CSRF the service issued: the preauth one, then the session one.
  const csrfs = [...s.fake.state.contexts.values(), ...s.fake.state.sessions.values()].map((row) => row.csrf);
  assert.equal(csrfs.length, 2);
  assert.ok(s.fake.calls('refresh').every((call) => call.csrf === csrfs[1]), 'the CSRF travels as the X-Domino-CSRF header');
  const leaks = [];
  const look = async (moment) => {
    for (const [tab, page] of [first, second].entries()) {
      for (const [where, text] of Object.entries(await outsideMemory(page))) {
        if (csrfs.some((csrf) => text.includes(csrf))) leaks.push(`${moment}, tab ${tab + 1}: ${where}`);
      }
    }
  };
  await look('signed in');
  assert.ok((await privateKeys(first)).length > 0, 'the private cache was in use while it was looked at');

  await openDialog(second);
  await dialog(second).getByRole('button', { name: 'Sign out', exact: true }).click();
  await viewIs(second, 'signed_out');
  await viewIs(first, 'signed_out');
  await look('signed out');
  if (csrfs.some((csrf) => logged.some((text) => text.includes(csrf)))) leaks.push('the console');
  if (csrfs.some((csrf) => urls.some((url) => url.includes(csrf)))) leaks.push('a request URL');
  assert.deepEqual(leaks, []);

  // What crossed between tabs is the fact of a change, and nothing else.
  const heard = [...(await first.evaluate(() => window.__dominoHeard)), ...(await second.evaluate(() => window.__dominoHeard))];
  for (const message of heard) assert.ok(['{"t":"changed"}', '{"t":"renewed"}'].includes(JSON.stringify(message)), JSON.stringify(message));
  assert.ok(heard.some((message) => message.t === 'renewed'), 'the renewal was announced');
  assert.ok(heard.some((message) => message.t === 'changed'), 'the sign-out was announced');
  await s.close();
});

test('no refresh while signed out, nor while the tab is hidden; coming back into view refreshes', async () => {
  const s = await scenario({ clockAt: Date.now() });
  const page = await s.open();
  await connect(page);
  // Signed out: activity and time never refresh.
  await act(page);
  await page.clock.fastForward('25:00');
  await sleep(300);
  assert.equal(s.fake.count('refresh'), 0, 'nothing to refresh while signed out');

  await signIn(s, page);
  await act(page);
  await setVisibility(page, 'hidden');
  s.fake.advance(21 * 60_000);
  await page.clock.fastForward('21:00');
  await sleep(500);
  assert.equal(s.fake.count('refresh'), 0, 'a hidden tab never refreshes');
  assert.equal((await view(page)).status, 'signed_in');

  await page.clock.fastForward('00:31');
  await setVisibility(page, 'visible');
  await eventually(() => s.fake.count('refresh') === 1, 'the refresh on coming back');
  assert.equal(s.fake.calls('refresh')[0].status, 200);
  await viewIs(page, 'signed_in');
  await s.close();
});
