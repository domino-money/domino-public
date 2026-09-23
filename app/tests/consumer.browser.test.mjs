/**
 * The onboarding previews (#38) and the deposit fixture lab (#40/#44) in a
 * real browser, against the consumer-test build, under the production CSP.
 *
 * Previews run against B2's real wallet session (mock EIP-6963 wallets and
 * the fake session service) and a fake onboarding worker on the same origin
 * (support/fake-onboarding.mjs). The deposit lab needs no sign-in: it runs on
 * package fixtures and a synthetic session. After every scenario the run fails
 * on a CSP violation, a browser error, a request to another origin, a
 * protocol violation recorded by either fake, a wallet method outside the
 * login allowlist, a signature no Sign in click asked for, or any request to
 * /api/deposit/.
 */
import { jump } from './support/clock.mjs';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright-core';
import { createFakeOnboarding } from './support/fake-onboarding.mjs';
import { createFakeSession } from './support/fake-session.mjs';
import { ACCOUNTS, installWallets } from './support/mock-wallet.mjs';
import { ARTWORK, footerButton, walkToReview } from './support/new-position.mjs';
import { createReadStub } from './support/read-stub.mjs';
import { createWalletServer } from './support/wallet-server.mjs';

const DIST = resolve(import.meta.dirname, '../.consumer-test-dist');
if (!existsSync(join(DIST, 'index.html'))) throw new Error('.consumer-test-dist is missing. Run `npm run build:consumer-test` before this test.');

const ADDR_A = ACCOUNTS[0].address;
const ADDR_B = ACCOUNTS[1].address;
const FONTS = /^https:\/\/fonts\.(googleapis|gstatic)\.com\//;
const INJECTED = /^https?:\/\/[^/]*\.kaspersky-labs\.com\//;
const ZERO = '0x0000000000000000000000000000000000000000';
const OTHER_OWNER = '0x9999999999999999999999999999999999999999';
const OPERATION_ID = '00000000-0000-4000-8000-000000000040';
const EXPIRED_ON_ARRIVAL = 'This preview had already expired by the time it arrived, so its figures are hidden.';
const LAUNCHES = process.env.DOMINO_BROWSER_PATH
  ? [{ executablePath: process.env.DOMINO_BROWSER_PATH }]
  : [{ channel: 'chrome' }, { channel: 'chromium' }, { channel: 'msedge' }, {}];

let browser;
const servers = new Set();

before(async () => {
  for (const options of LAUNCHES) {
    try {
      browser = await chromium.launch({ ...options, headless: process.env.CONSUMER_HEADED !== '1' });
      break;
    } catch {
      // the next build
    }
  }
  if (!browser) throw new Error('No Chromium build could be launched. Set DOMINO_BROWSER_PATH.');
});

after(async () => {
  await browser?.close();
  await Promise.all([...servers].map((server) => server.closeAll()));
});

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

async function scenario({ clockAt, wallets, reads = false } = {}) {
  const fake = createFakeSession();
  const onboarding = createFakeOnboarding({ session: fake });
  // New position's scenarios also need the public reads: the real read Worker over the package fixtures.
  const read = reads ? createReadStub() : null;
  const server = createWalletServer({
    fake,
    dist: DIST,
    routes: [(request, url) => (url.pathname.startsWith('/api/onboarding/v1/') ? onboarding.handle(request) : read?.handle(request, url))],
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  servers.add(server);
  const origin = `http://127.0.0.1:${server.address().port}`;
  fake.origin = origin;
  onboarding.origin = origin;

  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  context.setDefaultTimeout(15_000);
  if (clockAt !== undefined) await context.clock.install({ time: clockAt });
  await context.route(FONTS, (route) => route.fulfill({ status: 200, contentType: 'text/css', body: '' }));
  await context.route(INJECTED, (route) => route.abort());
  // New position shows token marks, whose optional artwork lookup the CSP admits; it is answered here with nothing.
  if (reads) await context.route(ARTWORK, (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
  const wallet = await installWallets(context, wallets);
  const problems = [];
  const external = [];
  const requests = [];
  context.on('request', (request) => {
    const url = request.url();
    requests.push(url);
    if (!url.startsWith(origin) && !url.startsWith('data:') && !FONTS.test(url) && !INJECTED.test(url) && !(reads && ARTWORK.test(url))) external.push(url);
  });

  const s = {
    fake,
    onboarding,
    wallet,
    origin,
    context,
    requests,
    signClicks: 0,
    async open(route) {
      const page = await context.newPage();
      page.on('pageerror', (error) => problems.push(`uncaught: ${error.message}`));
      page.on('console', (message) => {
        if (message.type() !== 'error' || /Failed to load resource/.test(message.text())) return;
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
      assert.deepEqual(onboarding.state.violations, [], 'onboarding protocol violations');
      assert.deepEqual(wallet.state.refused, [], 'wallet methods outside the login allowlist');
      assert.ok(wallet.state.signed.length <= s.signClicks, 'a signature was requested without a Sign in click');
      assert.deepEqual(requests.filter((url) => url.includes('/api/deposit/')), [], 'nothing may reach the deposit service');
    },
  };
  return s;
}

// ---- helpers ---------------------------------------------------------------------

const trigger = (page) => page.locator('header [aria-haspopup="dialog"]');
const dialog = (page) => page.locator('[role="dialog"][aria-labelledby="wallet-dialog-title"]');

async function until(page, predicate, arg, label, timeout = 10_000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await page.evaluate(predicate, arg).catch(() => false);
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await sleep(25);
  }
}
// Sign-in is a handshake of several steps, and these two are waited on inside
// it. The 10 s default is not enough on a loaded machine — a CI runner, or a
// laptop with the other browser suites still going — where the whole chain
// timed out at 10.9 s. The deadline only bounds how long a genuine failure
// takes to report, so it matches the 30 s the deposit amounts already use.
const viewIs = (page, status) => until(page, (wanted) => window.__dominoSessionProbe?.view().status === wanted, status, `session view ${status}`, 30_000);
const previewState = (page, wanted) =>
  until(page, (value) => document.querySelector('[data-preview-state]')?.getAttribute('data-preview-state') === value, wanted, `preview state ${wanted}`, 30_000);
// The eligibility text itself: a transient "Checking your sign-in…" also
// renders as state "ineligible", so a wait on the state alone races the block.
const eligibilityIs = (page, pattern, label) =>
  until(
    page,
    ([source, flags]) => new RegExp(source, flags).test(document.querySelector('[data-testid="preview-eligibility"]')?.textContent ?? ''),
    [pattern.source, pattern.flags],
    `eligibility: ${label}`,
  );

async function openDialog(page) {
  if (!(await dialog(page).isVisible())) await trigger(page).click();
  await dialog(page).waitFor();
}
async function closeDialog(page) {
  if (await dialog(page).isVisible()) await page.keyboard.press('Escape');
}

async function signIn(s, page, name = 'Test Wallet A') {
  await viewIs(page, 'no_wallet');
  await openDialog(page);
  await dialog(page).getByRole('button', { name: `Connect ${name}` }).click();
  await viewIs(page, 'signed_out');
  s.signClicks += 1;
  await dialog(page).getByRole('button', { name: 'Sign in', exact: true }).click();
  await viewIs(page, 'signed_in');
  await closeDialog(page);
  await previewState(page, 'ready');
}

const getPreview = (page) => page.getByRole('button', { name: /^(Get|Refresh) preview$/ });
const figures = (page) => page.locator('[data-testid="preview-figures"]');
const onboardingCount = (s) => s.onboarding.calls().length;

async function preview(page) {
  await getPreview(page).click();
  await previewState(page, 'current');
}

async function noSigningControls(page) {
  const names = await page.locator('main').getByRole('button').allInnerTexts();
  for (const name of names) assert.doesNotMatch(name, /^(Confirm|Swap|Deposit|Sign|Approve|Send)\b/i, `a control named ${name}`);
}

// ---- previews ------------------------------------------------------------------

test('previews need a signed-in session; one POST per click with the session CSRF; the happy swap renders as preview only', async () => {
  const s = await scenario();
  const page = await s.open('/live-preview');
  await previewState(page, 'ineligible');
  await eligibilityIs(page, /Connect a wallet to request a live preview/, 'no wallet');
  assert.match(await page.locator('[data-testid="preview-eligibility"]').innerText(), /Connect a wallet to request a live preview/);
  assert.equal(await getPreview(page).isDisabled(), true);
  await signIn(s, page);
  assert.equal(onboardingCount(s), 0, 'nothing is requested until the user asks');

  await preview(page);
  const [call] = s.onboarding.calls('swap-preview');
  const [session] = s.fake.sessionsFor(ADDR_A).filter((row) => row.active);
  assert.equal(call.csrf, session.csrf, 'the CSRF of this session, lent for the request');
  assert.deepEqual(call.body, { chainId: 4663, tokenIn: '0x1111111111111111111111111111111111111111', tokenOut: '0x2222222222222222222222222222222222222222', amountRaw: '1000', slippageBps: 50, maxPriceImpactBps: 100 });
  const text = await figures(page).innerText();
  assert.match(text, /Preview only/);
  assert.match(text, /A provider estimate, not a quote lock, transaction or authorization/);
  assert.match(text, /0\.000000000000001 SYN-A/);
  assert.match(text, /Not selected \(ceiling 0\.65%\)/);
  assert.match(text, /Within observed limits/);
  await noSigningControls(page);
  assert.equal(s.wallet.state.signed.length, 1, 'the sign-in signature only');
  await s.close();
});

test('every preview state renders: blocked unknowns, and the four position fixtures', async () => {
  const s = await scenario();
  const page = await s.open('/live-preview');
  await signIn(s, page);

  s.onboarding.controls.swap = 'unknown';
  await page.getByLabel('Amount to send (raw units)').fill('1001');
  await preview(page);
  let text = await figures(page).innerText();
  assert.match(text, /Blocked/);
  assert.match(text, /Unknown: Not available: the provider fee is unknown/);
  assert.match(text, /Price impact\s+Unknown: Not reported/);
  assert.doesNotMatch(text, /Output after provider fee\s+0\.000000000000002/, 'gross is never shown as net');

  await page.getByRole('tab', { name: 'Position' }).click();
  await previewState(page, 'ready');
  await preview(page);
  assert.match(await figures(page).innerText(), /Within your selected limits/);

  for (const field of ['Budget for currency 0 (raw units, blank for not given)', 'Budget for currency 1 (raw units, blank for not given)', 'Native gas reserve (wei, blank for not given)', 'Native ETH balance (wei, you enter it; not verified)']) {
    await page.getByLabel(field).fill('');
  }
  await preview(page);
  text = await figures(page).innerText();
  assert.match(text, /Incomplete/);
  assert.match(text, /No budget was set for currency 0/);

  await page.getByLabel('Budget for currency 0 (raw units, blank for not given)').fill('110');
  await page.getByLabel('Budget for currency 1 (raw units, blank for not given)').fill('1');
  await page.getByLabel('Native ETH balance (wei, you enter it; not verified)').fill('1000');
  await page.getByLabel('Native gas reserve (wei, blank for not given)').fill('300');
  await preview(page);
  text = await figures(page).innerText();
  assert.match(text, /Blocked/);
  assert.match(text, /The maximum debit of currency 1 exceeds your budget/);

  await page.getByLabel('Budget for currency 1 (raw units, blank for not given)').fill('220');
  await page.getByLabel('Pool').selectOption({ label: 'ETH (native) / SYN-B · 0.30% (Synthetic test pool)' });
  await preview(page);
  text = await figures(page).innerText();
  assert.match(text, /0\.000000000000000101 ETH/);
  assert.match(text, /Not verified\./);
  await noSigningControls(page);
  assert.equal(s.onboarding.calls('position-preview').length, 4);
  await s.close();
});

test('a preview is current until 29 s and gone at 30 s, focus moves to the expired heading, and nothing re-requests it', async () => {
  const s = await scenario({ clockAt: Date.now() });
  const page = await s.open('/live-preview');
  await signIn(s, page);
  await preview(page);
  await figures(page).locator('dd').first().evaluate((node) => {
    node.setAttribute('tabindex', '-1');
    node.focus();
  });
  await jump(page, '00:29');
  await until(page, () => document.querySelector('[data-testid="preview-expiry"]')?.textContent === 'Expires in 1 s', null, 'one second left');
  assert.equal(await figures(page).count(), 1);
  await jump(page, '00:01');
  await previewState(page, 'expired');
  assert.equal(await figures(page).count(), 0, 'the figures are gone');
  assert.match(await page.locator('main').innerText(), /This preview expired at .*Its figures are hidden\./);
  assert.equal(await page.evaluate(() => document.activeElement?.textContent), 'Preview expired');
  await jump(page, '05:00');
  assert.equal(onboardingCount(s), 1, 'no timer asks again');
  assert.equal(await getPreview(page).innerText(), 'Refresh preview');
  assert.equal(await getPreview(page).isEnabled(), true);
  await s.close();
});

test('changing an input drops the preview at once', async () => {
  const s = await scenario();
  const page = await s.open('/live-preview');
  await signIn(s, page);
  await preview(page);
  await page.getByLabel('Slippage (basis points)').fill('60');
  await previewState(page, 'ready');
  assert.equal(await figures(page).count(), 0);
  await page.getByLabel('Slippage (basis points)').fill('6x');
  await previewState(page, 'editing');
  assert.equal(await page.getByLabel('Slippage (basis points)').getAttribute('aria-invalid'), 'true');
  assert.equal(onboardingCount(s), 1);
  await s.close();
});

test('an account switch in the wallet drops the preview and sends nothing more', async () => {
  const s = await scenario();
  const page = await s.open('/live-preview');
  await signIn(s, page);
  await preview(page);
  await s.wallet.switchAccount('a', 1);
  await until(page, () => document.querySelector('[data-testid="preview-figures"]') === null, null, 'figures dropped');
  await previewState(page, 'ineligible');
  assert.equal(onboardingCount(s), 1);
  await s.close();
});

test('a network switch drops the preview and blocks requests', async () => {
  const s = await scenario();
  const page = await s.open('/live-preview');
  await signIn(s, page);
  await preview(page);
  // B2 signs the old session out first, so "Checking your sign-in…" (also
  // state "ineligible") comes before the wrong-network block. Hold the logout
  // to pin that window, then wait for the block itself, not the state.
  const held = s.fake.hold('logout');
  await s.wallet.switchChain('a', 1);
  await held.arrived;
  await previewState(page, 'ineligible');
  assert.equal(await figures(page).count(), 0, 'dropped before the logout answers');
  assert.match(await page.locator('[data-testid="preview-eligibility"]').innerText(), /Checking your sign-in/);
  held.release();
  await eligibilityIs(page, /Switch your wallet to Robinhood Chain \(4663\)/, 'wrong network');
  assert.equal(await figures(page).count(), 0);
  assert.match(await page.locator('[data-testid="preview-eligibility"]').innerText(), /Switch your wallet to Robinhood Chain \(4663\)/);
  assert.equal(await getPreview(page).isDisabled(), true);
  await s.close();
});

test('signing out drops the preview; a new sign-in starts from ready, never from the old preview', async () => {
  const s = await scenario();
  const page = await s.open('/live-preview');
  await signIn(s, page);
  await preview(page);
  await openDialog(page);
  await dialog(page).getByRole('button', { name: 'Sign out' }).click();
  await viewIs(page, 'signed_out');
  await closeDialog(page);
  await previewState(page, 'ineligible');
  assert.equal(await figures(page).count(), 0);
  assert.match(await page.locator('[data-testid="preview-eligibility"]').innerText(), /Sign in with your wallet/);
  await openDialog(page);
  s.signClicks += 1;
  await dialog(page).getByRole('button', { name: 'Sign in', exact: true }).click();
  await viewIs(page, 'signed_in');
  await closeDialog(page);
  await previewState(page, 'ready');
  await s.close();
});

// ---- New position: Review asks onboarding-v1 nothing (G8 retired) ------------------
//
// Changed on purpose (owner, 2026-09-22): Review's deposit amounts per token, the onboarding-v1 position preview
// they asked for a signed-in wallet (G8), were deleted. Review keeps Your choices and Wallet steps, and Create
// position reads the wallet and the chain itself. What those cases proved about the preview is gone with it; what
// stays is that Review asks the onboarding service nothing, signed in or not, and ends on Create position.

const positionCalls = (s) => s.onboarding.calls('position-preview');
/** What New position's product rules keep off its screen. */
const REVIEW_FORBIDDEN = /Preview only|Request details|Onboarding contract|"chainId"|not enabled|not connected yet|isn.t enabled|\bbeta\b|read-only|Retry|Read again/i;

/** Sign-in from the header on any page: connect Test Wallet A, then Sign in. */
async function signInHere(s, page) {
  await viewIs(page, 'no_wallet');
  await openDialog(page);
  await dialog(page).getByRole('button', { name: 'Connect Test Wallet A' }).click();
  await viewIs(page, 'signed_out');
  s.signClicks += 1;
  await dialog(page).getByRole('button', { name: 'Sign in', exact: true }).click();
  await viewIs(page, 'signed_in');
  await closeDialog(page);
}

test('New position’s Review keeps Your choices and Wallet steps, asks the onboarding service nothing signed out or signed in, and ends on Create position', async () => {
  const s = await scenario({ reads: true, clockAt: Date.now() });
  s.onboarding.controls.positionFromRequest = true;
  const page = await s.open('/new');
  await walkToReview(page);
  // With no wallet connected Review's last control asks for one, and says why.
  const connect = page.locator('[data-create-position="connect"]');
  await connect.waitFor({ timeout: 30_000 });
  assert.equal(await connect.innerText(), 'Connect wallet');
  assert.equal(await page.locator('#create-reason').innerText(), 'Connect your wallet to create the position. Each transaction appears in your wallet to sign.');
  const review = page.locator('[data-stage="review"]');
  assert.deepEqual(await review.locator('h3').allInnerTexts(), ['Your choices', 'Wallet steps'], 'the two sections Review keeps');
  assert.equal(await page.locator('section[data-stage="balance"], [data-balance-row], [data-amount-cell]').count(), 0, 'no deposit amounts section');
  const signedOut = await page.locator('main').innerText();
  assert.doesNotMatch(signedOut, /Deposit amounts per token|Sign in with your wallet to see these amounts\.|Exact amounts are calculated/);
  assert.equal(positionCalls(s).length, 0);

  // Signed in while Review is open: still no preview is asked, and the page is the same two sections.
  await signInHere(s, page);
  await page.locator('[data-create-position="idle"]').waitFor({ timeout: 30_000 });
  assert.equal(await page.locator('[data-create-position="idle"]').innerText(), 'Create position');
  assert.equal(await page.locator('#create-reason').innerText(), 'Your wallet asks you to sign each step in the list above, in order.');
  assert.deepEqual(await review.locator('h3').allInnerTexts(), ['Your choices', 'Wallet steps']);
  const text = await page.locator('main').innerText();
  assert.doesNotMatch(text, REVIEW_FORBIDDEN);
  assert.doesNotMatch(text, /Deposit amounts per token|Sign in with your wallet to see these amounts\.|Exact amounts are calculated/);
  assert.equal(await page.getByRole('link', { name: 'Continue in Setup' }).count(), 0, 'no way on through Setup');
  await noSigningControls(page);
  // The steps are listed with their keys, before anything is pressed, and none is marked as running or done.
  const steps = await page.locator('[data-wallet-steps] li').evaluateAll((items) => items.map((item) => [item.getAttribute('data-wallet-step'), item.getAttribute('data-step-state')]));
  assert.ok(steps.length >= 3 && steps.every(([key, state]) => key && state === null), JSON.stringify(steps));
  assert.deepEqual(steps.at(-1), ['mint', null]);

  // Neither time nor opening Review again asks for anything.
  await jump(page, '05:00');
  await footerButton(page, 'Back').click();
  await page.locator('[data-stage-card="amount"] [data-pair-side="1"]').waitFor();
  await footerButton(page, 'Continue').click();
  await page.locator('[data-stage-card="review"]').waitFor();
  await sleep(1_000);
  assert.equal(positionCalls(s).length, 0, 'no position preview, ever');
  assert.equal(s.onboarding.calls().length, 0, 'nothing of the onboarding service');
  assert.equal(s.wallet.state.signed.length, 1, 'the sign-in signature only');
  await s.close();
});

// ---- two wallets that announce the same rdns (rugged97's #70 P2, on #72) ------

/**
 * An EIP-6963 provider declares its own rdns, so nothing stops two of them
 * declaring the same one. These two differ only in uuid and name, and hold
 * the same account.
 */
const SAME_RDNS = [
  { id: 'a', name: 'Test Wallet A', rdns: 'test.wallet.shared', uuid: '8f2a7d1c-0000-4000-8000-0000000000a1' },
  { id: 'b', name: 'Test Wallet B', rdns: 'test.wallet.shared', uuid: '8f2a7d1c-0000-4000-8000-0000000000b1' },
];

test('two wallets announcing the same rdns: previews go out under the session of the wallet picked, and the other taking over drops the preview with that session', async () => {
  const s = await scenario({ wallets: SAME_RDNS });
  const page = await s.open('/live-preview');
  await signIn(s, page, 'Test Wallet B');
  assert.deepEqual(s.wallet.calls('wallet_requestPermissions').map((call) => call.id), ['b'], 'the B button asked B, and only B, for access');
  assert.deepEqual(s.wallet.state.signed.map((entry) => entry.id), ['b'], 'B signed the sign-in message');
  await preview(page);
  const [viaB] = s.fake.sessionsFor(ADDR_A).filter((row) => row.active);
  assert.equal(s.onboarding.calls('swap-preview').at(-1).csrf, viaB.csrf, "the preview went out under B's session");

  // The user connects this site from A itself: the same account on the same
  // chain, through another provider. That is another wallet, so nothing of
  // B's session may carry over to it.
  await s.wallet.connectFromWallet('a');
  await until(page, () => document.querySelector('[data-testid="preview-figures"]') === null, null, 'figures dropped');
  await viewIs(page, 'signed_out');
  assert.equal(await page.evaluate(() => window.__dominoSessionProbe.view().reason), 'identity_changed');
  const logout = s.fake.calls('logout').at(-1);
  assert.equal(logout.csrf, viaB.csrf, "B's session is the one signed out");
  assert.deepEqual(s.fake.sessionsFor(ADDR_A).filter((row) => row.active), []);
  await eligibilityIs(page, /Sign in with your wallet/, 'signed out');
  assert.equal(await getPreview(page).isDisabled(), true);
  assert.equal(onboardingCount(s), 1, 'nothing more was sent');

  // A needs a sign-in of its own and signs it itself; its preview carries its own session's CSRF.
  await openDialog(page);
  assert.match(await dialog(page).innerText(), /Test Wallet A/);
  s.signClicks += 1;
  await dialog(page).getByRole('button', { name: 'Sign in', exact: true }).click();
  await viewIs(page, 'signed_in');
  await closeDialog(page);
  await previewState(page, 'ready');
  assert.deepEqual(s.wallet.state.signed.map((entry) => entry.id), ['b', 'a']);
  await preview(page);
  const [viaA] = s.fake.sessionsFor(ADDR_A).filter((row) => row.active);
  assert.notEqual(viaA.csrf, viaB.csrf);
  assert.equal(s.onboarding.calls('swap-preview').at(-1).csrf, viaA.csrf, "A's preview went out under A's own session");
  assert.equal(onboardingCount(s), 2);
  await s.close();
});

test('a preview for another owner is refused and nothing of it renders', async () => {
  const s = await scenario();
  const page = await s.open('/live-preview');
  await signIn(s, page);
  s.onboarding.controls.ownerOverride = OTHER_OWNER;
  await getPreview(page).click();
  await previewState(page, 'failed');
  assert.match(await page.locator('[data-testid="preview-failure"]').innerText(), /Preview unavailable\. Nothing from this attempt is shown\./);
  assert.equal(await figures(page).count(), 0);
  await s.close();
});

test('a 429 disables the action for its Retry-After, also for new inputs, with no automatic retry (T-27)', async () => {
  const s = await scenario();
  const page = await s.open('/live-preview');
  await signIn(s, page);

  s.onboarding.failNext('swap-preview', 'session_rate_limited');
  await getPreview(page).click();
  await previewState(page, 'failed');
  assert.match(await page.locator('[data-testid="preview-failure"]').innerText(), /Too many preview requests\. Try again in 60 s\./);
  assert.equal(await getPreview(page).isDisabled(), true);

  await page.getByLabel('Amount to send (raw units)').fill('2000');
  // The cooldown still applies to new inputs: the server's 429 is honoured.
  await previewState(page, 'ready');
  assert.equal(await getPreview(page).isDisabled(), true);
  await sleep(500);
  assert.equal(s.onboarding.calls('swap-preview').length, 1, 'no automatic retry');
  assert.equal(s.wallet.state.signed.length, 1);
  await s.close();
});

test('session_required from the preview route re-reads me once and never asks for a signature (T-28)', async () => {
  const s = await scenario();
  const page = await s.open('/live-preview');
  await signIn(s, page);
  const meBefore = s.fake.count('me');
  s.onboarding.failNext('swap-preview', 'session_required');
  await getPreview(page).click();
  await previewState(page, 'failed');
  assert.match(await page.locator('[data-testid="preview-failure"]').innerText(), /Your session ended/);
  const deadline = Date.now() + 5_000;
  while (s.fake.count('me') === meBefore && Date.now() < deadline) await sleep(25);
  assert.equal(s.fake.count('me'), meBefore + 1, 'one me, to see whether the session is still there');
  assert.equal(s.wallet.state.signed.length, 1, 'no signature');
  s.onboarding.controls.disabled = true;
  await page.getByLabel('Amount to send (raw units)').fill('3000');
  await getPreview(page).click();
  await previewState(page, 'failed');
  assert.match(await page.locator('[data-testid="preview-failure"]').innerText(), /Live previews aren't enabled on this deployment\./);
  await s.close();
});

test('nothing of a preview reaches storage or the URL (INV-7)', async () => {
  const s = await scenario();
  const page = await s.open('/live-preview');
  await signIn(s, page);
  await preview(page);
  const stored = await page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }));
  assert.doesNotMatch(stored, /grossOutput|0x25431634|requestFingerprint|swap-preview|preview/i);
  assert.equal(new URL(page.url()).hash, '#/live-preview');
  await s.close();
});

// ---- the session CSRF stays in memory (rugged97 on #14) ----------------------

/**
 * Everything a page could keep or show outside its memory, as text: the URL,
 * browser storage, cookies visible to scripts, IndexedDB, the markup, the
 * private cache's keys and values, and what was posted on the session and
 * preview-budget channels.
 */
const outsideMemory = (page) =>
  page.evaluate(async () => ({
    url: location.href,
    localStorage: JSON.stringify(Object.entries(localStorage)),
    sessionStorage: JSON.stringify(Object.entries(sessionStorage)),
    cookie: document.cookie,
    indexedDB: JSON.stringify(await indexedDB.databases()),
    markup: document.documentElement.outerHTML,
    queryKeys: JSON.stringify(window.__dominoSessionProbe.privateKeys()),
    queryValues: JSON.stringify(window.__dominoSessionProbe.privateValues()),
    broadcasts: JSON.stringify(window.__dominoHeard),
  }));

test('previews lend the session CSRF to their request header only: never stored, in a URL, the markup, the console or a cross-tab message', async () => {
  const s = await scenario();
  const logged = [];
  s.context.on('console', (message) => logged.push(message.text()));
  // A second listener on each channel, in every page, hears what the app posts there.
  await s.context.addInitScript(() => {
    window.__dominoHeard = { session: [], budget: [] };
    new BroadcastChannel('domino-session-v1').onmessage = (event) => window.__dominoHeard.session.push(event.data);
    new BroadcastChannel('domino-preview-budget-v1').onmessage = (event) => window.__dominoHeard.budget.push(event.data);
  });
  const amount = (page) => page.getByLabel('Amount to send (raw units)');

  const first = await s.open('/live-preview');
  await signIn(s, first);
  await preview(first);
  // A second tab restores the session and asks for a preview of its own.
  const second = await s.open('/live-preview');
  await viewIs(second, 'signed_in');
  await previewState(second, 'ready');
  await preview(second);
  // A refused CSRF: the port has B2 read me again, which compares the CSRF in memory.
  const meBefore = s.fake.count('me');
  await amount(first).fill('2000');
  await previewState(first, 'ready');
  s.onboarding.failNext('swap-preview', 'csrf_invalid');
  await getPreview(first).click();
  const deadline = Date.now() + 5_000;
  while (s.fake.count('me') === meBefore && Date.now() < deadline) await sleep(25);
  assert.equal(s.fake.count('me'), meBefore + 1, 'one me after the refusal');
  await until(first, () => ['failed', 'ready'].includes(document.querySelector('[data-preview-state]')?.getAttribute('data-preview-state')), null, 'the recheck settled');
  await viewIs(first, 'signed_in');
  // A 429: its cooldown goes to the other tab over the budget channel.
  await amount(first).fill('3000');
  await previewState(first, 'ready');
  s.onboarding.failNext('swap-preview', 'session_rate_limited');
  await getPreview(first).click();
  await previewState(first, 'failed');

  // Every CSRF the service issued: the preauth one, then the session one.
  const csrfs = [...s.fake.state.contexts.values(), ...s.fake.state.sessions.values()].map((row) => row.csrf);
  assert.equal(csrfs.length, 2);
  assert.equal(onboardingCount(s), 4);
  assert.ok(s.onboarding.calls().every((call) => call.csrf === csrfs[1]), 'each preview carried the session CSRF, as its X-Domino-CSRF header');
  const leaks = [];
  const look = async (moment) => {
    for (const [tab, page] of [first, second].entries()) {
      for (const [where, text] of Object.entries(await outsideMemory(page))) {
        if (csrfs.some((csrf) => text.includes(csrf))) leaks.push(`${moment}, tab ${tab + 1}: ${where}`);
      }
    }
  };
  await look('previews shown');

  await openDialog(second);
  await dialog(second).getByRole('button', { name: 'Sign out', exact: true }).click();
  await viewIs(second, 'signed_out');
  await viewIs(first, 'signed_out');
  await look('signed out');
  if (csrfs.some((csrf) => logged.some((text) => text.includes(csrf)))) leaks.push('the console');
  if (csrfs.some((csrf) => s.requests.some((url) => url.includes(csrf)))) leaks.push('a request URL');
  assert.deepEqual(leaks, []);

  // What crossed between tabs is the fact of a change, a send or a cooldown, and nothing else.
  const heard = { session: [], budget: [] };
  for (const page of [first, second]) {
    const got = await page.evaluate(() => window.__dominoHeard);
    heard.session.push(...got.session);
    heard.budget.push(...got.budget);
  }
  for (const message of heard.session) assert.ok(['{"t":"changed"}', '{"t":"renewed"}'].includes(JSON.stringify(message)), JSON.stringify(message));
  for (const message of heard.budget) assert.ok(/^\{"t":"spent"\}$|^\{"t":"cooldown","ms":\d+\}$/.test(JSON.stringify(message)), JSON.stringify(message));
  assert.ok(heard.budget.some((message) => message.t === 'spent'), 'the sends were announced');
  assert.ok(heard.budget.some((message) => message.t === 'cooldown'), 'the cooldown was announced');
  assert.ok(heard.session.some((message) => message.t === 'changed'), 'the sign-out was announced');
  await s.close();
});

// ---- previews: the failure map, derived variants and the clock ----------------

const failure = (page) => page.locator('[data-testid="preview-failure"]').innerText();
const eligibility = (page) => page.locator('[data-testid="preview-eligibility"]').innerText();

/** Changes an input and changes it back: the old result is dropped and the same request can be asked again. */
async function sameInputsAgain(page) {
  const field = page.getByLabel('Maximum price impact (basis points)');
  await field.fill('99');
  await previewState(page, 'ready');
  await field.fill('100');
  await previewState(page, 'ready');
}

/**
 * Tab timer throttling, reproduced: the page's monotonic clock moves on while
 * no timer runs, so the 27 s abort cannot fire. Playwright's clock has no
 * public call for that (fastForward fires the timers that fall due), so the
 * clock is paused and its ticks are moved directly. If Playwright renames its
 * internals this throws instead of passing silently.
 */
async function holdTimersWhileTimePasses(page, ms) {
  await page.clock.pauseAt((await page.evaluate(() => Date.now())) + 100);
  await page.evaluate((advance) => {
    const controller = globalThis.__pwClock?.controller;
    if (typeof controller?._advanceNow !== 'function' || typeof controller._now?.ticks !== 'number') {
      throw new Error("Playwright's clock internals changed: update holdTimersWhileTimePasses");
    }
    const before = performance.now();
    controller._advanceNow(controller._now.ticks + advance);
    if (performance.now() - before < advance) throw new Error('the monotonic clock did not move');
  }, ms);
}

test('every failure the worker can answer renders its own copy, replaces the preview, and never re-asks (T-29 to T-33)', async () => {
  const s = await scenario();
  const page = await s.open('/live-preview');
  await signIn(s, page);
  const meBefore = s.fake.count('me');
  const CASES = [
    ['invalid_request', /^The preview service rejected these inputs\. Check them and try again\./, 'edit'],
    ['preview_expired', /^This preview expired before it could be delivered\. Request a new one\./, 'manual'],
    ['provider_request_rejected', /^No preview is available for this selection\. Nothing else was tried in its place\./, 'edit'],
    ['provider_unavailable', /^The price provider is unavailable right now\. Try again later\./, 'manual'],
    ['session_store_unavailable', /^The preview service can't check your session right now\. You're still signed in\. Try again shortly\./, 'manual'],
    ['account_check_unavailable', /^The preview service can't check your session right now\. You're still signed in\. Try again shortly\./, 'manual'],
    ['request_timeout', /^The preview request timed out\. Nothing from it is shown\./, 'manual'],
  ];
  for (const [index, [code, copy, retry]] of CASES.entries()) {
    if (index > 0) await sameInputsAgain(page);
    s.onboarding.failNext('swap-preview', code);
    await getPreview(page).click();
    await previewState(page, 'failed');
    const text = await failure(page);
    assert.match(text, copy, code);
    assert.match(text, /Support reference: [0-9a-f-]{36}/, `${code}: the request id, as text`);
    assert.equal(await figures(page).count(), 0, code);
    assert.equal(await getPreview(page).isDisabled(), retry === 'edit', `${code}: ${retry === 'edit' ? 'fix the inputs first' : 'the user may ask again'}`);
    assert.equal(s.onboarding.calls('swap-preview').length, index + 1, `${code}: one request per click`);
  }
  await sleep(300);
  assert.equal(onboardingCount(s), CASES.length, 'nothing re-asked on its own');
  await viewIs(page, 'signed_in');
  assert.equal(s.fake.count('me'), meBefore, 'none of these touches the session (T-30)');
  assert.equal(s.wallet.state.signed.length, 1, 'no signature');
  await s.close();
});

test("csrf_invalid rechecks the sign-in with no signature; the beta gate's real 401 and 503 come first; account_unsupported signs the tab out (T-28, T-35)", async () => {
  const s = await scenario();
  const page = await s.open('/live-preview');
  await signIn(s, page);

  const meBefore = s.fake.count('me');
  s.onboarding.failNext('swap-preview', 'csrf_invalid');
  await getPreview(page).click();
  const deadline = Date.now() + 5_000;
  while (s.fake.count('me') === meBefore && Date.now() < deadline) await sleep(25);
  assert.equal(s.fake.count('me'), meBefore + 1, 'one me, to recheck the sign-in');
  await until(page, () => ['failed', 'ready'].includes(document.querySelector('[data-preview-state]')?.getAttribute('data-preview-state')), null, 'the recheck settled');
  if ((await page.locator('[data-preview-state]').getAttribute('data-preview-state')) === 'failed') {
    assert.match(await failure(page), /^Rechecking your sign-in\. No signature is needed\. Try again when it finishes\./);
  }
  await viewIs(page, 'signed_in');
  await getPreview(page).click();
  await previewState(page, 'current');
  assert.equal(s.wallet.state.signed.length, 1, 'no signature');

  for (const [kind, copy] of [
    ['required', /^Your beta access has expired\. Reload the page and enter the password again\.$/],
    ['unavailable', /^The site is temporarily unavailable\. Try again later\.$/],
  ]) {
    await sameInputsAgain(page);
    s.onboarding.controls.gateNext = kind;
    await getPreview(page).click();
    await previewState(page, 'failed');
    assert.match(await failure(page), copy, kind);
    assert.equal(await getPreview(page).isDisabled(), true, `${kind}: asking again cannot fix it`);
    assert.equal(await figures(page).count(), 0);
    assert.equal(s.onboarding.calls().at(-1).gate, kind);
  }
  await viewIs(page, 'signed_in');

  await sameInputsAgain(page);
  s.onboarding.failNext('swap-preview', 'account_unsupported');
  await getPreview(page).click();
  await eligibilityIs(page, /This account can't use previews\. Only standard wallets \(EOAs\) are supported/, 'account unsupported');
  assert.match(await eligibility(page), /You've been signed out\./);
  assert.equal(await figures(page).count(), 0);
  assert.equal(await getPreview(page).isDisabled(), true);
  await sleep(300);
  assert.equal(onboardingCount(s), 5, 'one request per click, nothing re-asked');
  assert.equal(s.wallet.state.signed.length, 1, 'no signature');
  await s.close();
});

test('the derived swap variants render in the browser: fee outputs with "(you)", failure, impact, unknowns and multi-path routes (FIX-1, OV-4)', async () => {
  const s = await scenario();
  const page = await s.open('/live-preview');
  await signIn(s, page);
  const you = new RegExp(`${ADDR_A} \\(you\\)`, 'i');
  const CASES = [
    [
      'unsupported_nonzero_fee',
      (text) => {
        assert.match(text, /Blocked/);
        assert.match(text, /Non-zero fee reported \(0\.25%\), not supported/);
        assert.match(text, /The provider reported a non-zero output fee, which is not supported\./);
        assert.match(text, /Integrator fee/);
        assert.match(text, you);
      },
    ],
    [
      'provider_failure',
      (text) => {
        assert.match(text, /SIMULATION_ERROR/);
        assert.match(text, /The provider reported a failed simulation\./);
      },
    ],
    [
      'impact_exceeded',
      (text) => {
        assert.match(text, /Price impact\s+1\.5%/);
        assert.match(text, /Price impact is above your maximum\./);
      },
    ],
    ['approval_unknown', (text) => assert.match(text, /Approval\s+Unknown:/)],
    [
      'usd_null',
      (text) => {
        assert.match(text, /In USD \(provider\)\s+Unknown: Not reported\./);
        assert.match(text, /Within observed limits/);
      },
    ],
    ['decimals_null', (text) => assert.match(text, /0\.000000000000001 SYN-A/, "the curated catalog's decimals, never guessed ones")],
    ['multi_hop', (text) => assert.match(text, /Path: 0\.000000000000001 SYN-A in → 0\.000000000000002 SYN-B out/)],
    [
      'multi_path',
      (text) => {
        assert.match(text, /Path 1 of 2/);
        assert.match(text, /Path 2 of 2: 0\.0000000000000005 SYN-A in → 0\.000000000000001 SYN-B out/);
        assert.doesNotMatch(text, /Path: /, 'no path is "the" route');
      },
    ],
  ];
  for (const [index, [name, check]] of CASES.entries()) {
    if (index > 0) await sameInputsAgain(page);
    s.onboarding.controls.swapDerived = name;
    await preview(page);
    check(await figures(page).innerText());
    if (name === 'multi_hop') assert.equal(await figures(page).locator('ol > li').count(), 2, 'both hops');
  }
  await noSigningControls(page);
  assert.equal(s.onboarding.calls('swap-preview').length, CASES.length);
  await s.close();
});

test('the derived position variants render in the browser: a provider gas estimate, and both native blocked reasons (FIX-1)', async () => {
  const s = await scenario();
  const page = await s.open('/live-preview');
  await signIn(s, page);
  await page.getByRole('tab', { name: 'Position' }).click();
  await previewState(page, 'ready');

  s.onboarding.controls.positionDerived = 'gas_reported';
  await preview(page);
  let text = await figures(page).innerText();
  assert.match(text, /Network gas\s+0\.000000000001 ETH/);
  assert.match(text, /Provider estimate; not verified\./);

  s.onboarding.controls.positionDerived = 'native_blocked_twice';
  await page.getByLabel('Pool').selectOption({ label: 'ETH (native) / SYN-B · 0.30% (Synthetic test pool)' });
  await page.getByLabel('Native ETH balance (wei, you enter it; not verified)').fill('100');
  await preview(page);
  text = await figures(page).innerText();
  assert.match(text, /Blocked/);
  assert.match(text, /The native deposit exceeds the balance you entered\./);
  assert.match(text, /The native deposit plus your gas reserve exceeds the balance you entered\./);
  await noSigningControls(page);
  assert.equal(s.onboarding.calls('position-preview').length, 2);
  await s.close();
});

test('a request still open at 27 s is abandoned as timed out; one that arrives after its 30 s life (tab timers held back) is expired on arrival, never shown, and a second says so (PB-21)', async () => {
  const s = await scenario({ clockAt: Date.now() });
  const page = await s.open('/live-preview');
  await signIn(s, page);

  let held = s.onboarding.hold('swap-preview');
  await getPreview(page).click();
  await held.arrived;
  await previewState(page, 'loading');
  await jump(page, '00:27', { pending: true });
  await previewState(page, 'failed');
  assert.match(await failure(page), /^The preview request timed out\. Nothing from it is shown\./);
  held.release();

  for (const repeated of [false, true]) {
    held = s.onboarding.hold('swap-preview');
    await getPreview(page).click();
    await held.arrived;
    await holdTimersWhileTimePasses(page, 31_000);
    held.release();
    await until(page, (copy) => document.querySelector('[data-testid="preview-failure"]')?.textContent.includes(copy) ?? false, EXPIRED_ON_ARRIVAL, 'expired on arrival');
    assert.equal(await page.locator('[data-preview-state]').getAttribute('data-preview-state'), 'failed');
    const text = await failure(page);
    if (repeated) assert.match(text, /If this keeps happening, the price service is slow right now\. Try again in a minute\./);
    else assert.doesNotMatch(text, /keeps happening/);
    assert.equal(await figures(page).count(), 0, 'nothing of it is shown');
    assert.equal(await getPreview(page).isEnabled(), true, 'the user may ask again');
  }
  // Every answer was a valid 200: the one abandoned at 27 s came late and was dropped, the other two came after their life.
  assert.deepEqual(s.onboarding.calls('swap-preview').map((call) => call.status), [200, 200, 200]);
  assert.equal(onboardingCount(s), 3, 'one request per click');
  await s.close();
});

// ---- deposit fixture lab -------------------------------------------------------

const labPanel = (page) => page.locator('section[data-view]');
async function pick(page, id) {
  await page.getByLabel('Scenario').selectOption(id);
  await until(page, () => document.querySelector('[data-testid="request-log"]') !== null && !document.body.innerText.includes('Loading…'), null, `scenario ${id}`);
}
const viewKind = (page) => labPanel(page).getAttribute('data-view');
const probe = (page, name) => page.evaluate((key) => window.__dominoDepositProbe[key](), name);

const VARIANT_KIND = {
  cancelled: 'cancelled_clean',
  confirmed: 'confirmed',
  erc20_approval: 'step_ready',
  erc20_reset: 'step_ready',
  fee_cap_breach: 'confirmed',
  legacy_receipt: 'confirmed',
  mint: 'step_ready',
  native: 'step_ready',
  partial_allowances: 'draft_new',
  pending: 'pending',
  permit2_approval: 'step_ready',
  'proxy-event-amounts': 'confirmed',
  reported_nonce_conflict: 'attention_conflict',
  'reviewed-proxy': 'step_ready',
  superseded: 'superseded',
  'token-review-changed': 'confirmed',
};
const DERIVED_KIND = {
  reverted: 'reverted',
  cancel_requested: 'cancel_requested',
  cancel_requested_conflict: 'cancel_requested_support',
  cancel_requested_unresolved: 'cancel_requested_support',
  cancel_requested_reorged: 'cancel_requested_reorg',
  pending_not_found: 'pending',
  attention_reorged: 'attention_reorg',
  attention_transient: 'attention_generic',
  attention_approval_unqualified: 'attention_generic',
  draft_after_approval: 'draft_progress',
  cancelled_after_steps: 'cancelled_after_steps',
  pending_provisional: 'pending',
  owner_unavailable: 'confirmed',
  l1_null: 'confirmed',
  l1_zero: 'confirmed',
  basis_token_review_unavailable: 'confirmed',
  basis_legacy_unqualified: 'confirmed',
  basis_native_net_unavailable: 'confirmed',
  single_breach: 'confirmed',
  awaiting_via_get: 'step_reserved',
};

async function labSweep(page) {
  const seen = {};
  for (const [name, kind] of Object.entries(VARIANT_KIND)) {
    await pick(page, `variant:${name}`);
    if (kind === 'step_ready') {
      assert.equal(await viewKind(page), 'draft_new', `${name} boots in draft, before its step is issued`);
      await page.getByRole('button', { name: 'Prepare first step' }).click();
      await until(page, () => document.querySelector('section[data-view]')?.getAttribute('data-view') === 'step_ready', null, `${name} step ready`);
    }
    assert.equal(await viewKind(page), kind, name);
    seen[name] = await labPanel(page).innerText();
  }
  for (const [id, kind] of Object.entries(DERIVED_KIND)) {
    await pick(page, `derived:${id}`);
    assert.equal(await viewKind(page), kind, id);
    seen[id] = await labPanel(page).innerText();
  }
  return seen;
}

test('the lab renders every package variant and derived fixture, with the banner, no sign-in, and no Send control anywhere (DB-1, DB-2)', async () => {
  const s = await scenario({ clockAt: Date.parse('2026-09-11T12:00:00Z') });
  const page = await s.open('/deposits');
  assert.match(await page.locator('[data-testid="fixture-banner"]').innerText(), /Synthetic fixture: not your wallet, not live/);
  const first = await labSweep(page);
  assert.equal(Object.keys(first).length, 36);
  assert.equal(await page.getByRole('button', { name: /send/i }).count(), 0);
  assert.deepEqual(await probe(page, 'unscripted'), []);
  assert.equal(s.fake.state.log.length, 0, 'the lab never touches the session service');
  // The header's wallet island (#14) reconnects on load with eth_accounts,
  // which reads and grants nothing. The lab itself asks the wallet nothing.
  assert.deepEqual(s.wallet.state.log.filter((entry) => entry.method !== 'eth_accounts'), [], 'the lab never touches a wallet');
  await s.close();

  // DB-14: the same lab under a device clock two years later shows the same thing.
  const later = await scenario({ clockAt: Date.parse('2028-06-01T00:00:00Z') });
  const again = await labSweep(await later.open('/deposits'));
  assert.deepEqual(again, first);
  await later.close();
});

test('a prepared mint: every field, the pre-sign checks against a simulated wallet, and only a status line where Send would be (DB-2, DB-3, C-R3)', async () => {
  const s = await scenario();
  const page = await s.open('/deposits');
  await pick(page, 'variant:mint');
  await page.getByRole('button', { name: 'Prepare first step' }).click();
  await until(page, () => document.querySelector('[data-testid="presign"]') !== null, null, 'pre-sign checks');
  const panel = await labPanel(page).innerText();
  assert.match(panel, /Create the position, ticks -120 to 180/);
  assert.match(panel, /33,000,000 wei/);
  assert.equal(await page.locator('[data-testid="handoff-status"]').innerText(), "Wallet sending isn't available in this build. Nothing has been sent. Nonce 5 stays reserved on the server until a transaction at that nonce finalizes.");
  assert.equal(await probe(page, 'handoffAvailable'), false);
  const failing = () => page.locator('[data-testid="presign"] li[data-ok="false"]').evaluateAll((rows) => rows.map((row) => row.getAttribute('data-check')));
  assert.deepEqual(await failing(), ['summary', 'handoff']);
  await page.getByLabel('I reviewed every field of this wallet step').check();
  assert.deepEqual(await failing(), ['handoff'], 'checks 1 to 7 pass for the fixture owner on 4663 while fresh');
  await page.getByLabel('Wallet network').selectOption('1');
  await page.getByLabel('Wallet account').selectOption('0x1212121212121212121212121212121212121212');
  assert.deepEqual(await failing(), ['chain', 'account', 'handoff']);
  await page.getByLabel('Handoff clock').selectOption('expired');
  await until(page, () => document.querySelector('section[data-view]')?.getAttribute('data-view') === 'handoff_expired', null, 'handoff expired');
  assert.equal(await page.locator('[data-testid="presign"]').count(), 0, 'an expired step is not offered for review');
  await page.getByLabel('Handoff clock').selectOption('fresh');
  await until(page, () => document.querySelector('section[data-view]')?.getAttribute('data-view') === 'step_ready', null, 'fresh again');
  assert.equal(await page.getByRole('button', { name: /send/i }).count(), 0);
  assert.equal(JSON.parse(await probe(page, 'walletStep')).transaction.data, JSON.parse(readFileSync(resolve(import.meta.dirname, '../../api-contracts/deposit-v1/fixtures/variants/mint.json'), 'utf8')).walletStep.transaction.data);
  assert.deepEqual(s.wallet.state.log.filter((entry) => entry.method !== 'eth_accounts'), [], 'no wallet method but the header reconnect');
  await s.close();
});

test('an admission denial latches Prepare off: exactly one prepare, no retry, no create, no new mint (rugged97)', async () => {
  const s = await scenario();
  const page = await s.open('/deposits');
  await pick(page, 'admission-denied');
  const prepare = page.getByRole('button', { name: 'Prepare first step' });
  await prepare.click();
  await until(page, () => document.querySelector('[data-testid="deposit-notice"]') !== null, null, 'denial notice');
  assert.match(await page.locator('[data-testid="deposit-notice"]').innerText(), /Deposits aren't available for this pool or token\. Nothing already sent from your wallet is cancelled by this\./);
  assert.equal(await prepare.isDisabled(), true);
  assert.match(await labPanel(page).innerText(), /Prepare is off for this deposit/);
  await prepare.click({ force: true }).catch(() => {});
  await sleep(300);
  const routes = (await probe(page, 'calls')).map((call) => call.route);
  assert.deepEqual(routes, ['list', 'get', 'prepare']);
  assert.ok(!routes.includes('create'));
  await s.close();
});

test('owner binding: another account’s deposit is refused whole, forgotten, and never shown (DC-7)', async () => {
  const s = await scenario();
  const page = await s.open('/deposits');
  await pick(page, 'foreign-get');
  assert.equal(await labPanel(page).count(), 0);
  assert.equal(await probe(page, 'remembered'), null, 'the remembered id is dropped silently');
  await page.getByRole('button', { name: /^Open deposit / }).first().click();
  await until(page, () => document.querySelector('[data-testid="deposit-notice"]') !== null, null, 'owner notice');
  assert.match(await page.locator('[data-testid="deposit-notice"]').innerText(), /about another account, so nothing from it is shown or remembered/);
  assert.equal(await labPanel(page).count(), 0);
  await pick(page, 'foreign-list');
  assert.equal(await page.getByRole('button', { name: /^Open deposit / }).count(), 0);
  assert.deepEqual((await probe(page, 'calls')).map((call) => call.route), ['list']);
  await s.close();
});

test('conflicts and unresolved hashes are support-required: no retry, cancel, dismiss or new deposit (#68)', async () => {
  const s = await scenario();
  const page = await s.open('/deposits');
  for (const id of ['support-conflict', 'unresolved', 'derived:cancel_requested_conflict', 'derived:cancel_requested_unresolved']) {
    await pick(page, id);
    const panel = labPanel(page);
    assert.equal(await panel.getByText('Support required', { exact: true }).count(), 1, id);
    const buttons = await panel.getByRole('button').allInnerTexts();
    assert.deepEqual(buttons.sort(), ['Check allowances', 'Check status'], id);
    assert.equal(await panel.getByLabel('Transaction hash from your wallet').count(), 0, `${id}: no report form`);
    assert.doesNotMatch(await panel.innerText(), /cancel or replace/, id);
  }
  await pick(page, 'support-conflict');
  assert.match(await page.locator('[data-testid="conflicts"]').innerText(), /nonce 6 .* same effect as step 1 \(nonce 5\)/);
  await s.close();
});

test('recovery copy, gas, evidence basis and exceeded limits render as the digest asks', async () => {
  const s = await scenario();
  const page = await s.open('/deposits');
  await pick(page, 'variant:fee_cap_breach');
  assert.match(await page.locator('[data-testid="breach"]').innerText(), /gas limit 300,001 \(you selected 300,000\)/);
  await pick(page, 'derived:l1_null');
  assert.match(await page.locator('[data-testid="gas-block"]').innerText(), /Of which data-posting \(L1\), included above\s+Unknown: Not reported \(unknown\)/);
  await pick(page, 'variant:token-review-changed');
  const amounts = await page.locator('[data-testid="amounts-block"]').innerText();
  assert.match(amounts, /Unknown: Unavailable: the token's implementation changed/);
  assert.doesNotMatch(amounts, /Deposited, currency 0\s+0\b/);
  await pick(page, 'derived:cancel_requested');
  assert.match(await labPanel(page).innerText(), /may still have, or may already have sent/);
  await pick(page, 'variant:confirmed');
  await page.getByRole('button', { name: 'Check allowances' }).click();
  await until(page, () => document.querySelector('[data-testid="revocation-guidance"]') !== null, null, 'allowances');
  assert.match(await page.locator('[data-testid="allowances"]').innerText(), /Could not read/);
  assert.match(await page.locator('[data-testid="revocation-guidance"]').innerText(), /no button for it and builds nothing/);
  await s.close();
});

test('without a wallet handoff a live transport kind cannot issue a step; a version conflict reads once and never replays', async () => {
  const s = await scenario();
  const page = await s.open('/deposits');
  await pick(page, 'http-activation');
  const reopen = page.getByRole('button', { name: 'Re-open wallet step' });
  assert.equal(await reopen.isDisabled(), true);
  assert.match(await labPanel(page).innerText(), /It stays off until this app can send from your wallet/);
  await pick(page, 'version-conflict');
  await page.getByRole('button', { name: 'Cancel deposit' }).click();
  await until(page, () => document.querySelector('section[data-view]')?.getAttribute('data-view') === 'cancelled_clean', null, 'latest state');
  assert.deepEqual((await probe(page, 'calls')).map((call) => call.route), ['list', 'get', 'cancel', 'get']);
  await s.close();
});

const depositNotice = (page) => page.locator('[data-testid="deposit-notice"]').innerText();
const noticeShown = (page) => until(page, () => document.querySelector('[data-testid="deposit-notice"]') !== null, null, 'deposit notice');
const routesOf = async (page) => (await probe(page, 'calls')).map((call) => call.route);
const viewBecomes = (page, kind) => until(page, (wanted) => document.querySelector('section[data-view]')?.getAttribute('data-view') === wanted, kind, `view ${kind}`);

test('refusals in Chromium: a changed token stops and latches, an expired handoff keeps the nonce held, a session end is told once, owner busy points at the blocker (REC-3, T17)', async () => {
  const s = await scenario();
  const page = await s.open('/deposits');
  const reopen = () => page.getByRole('button', { name: 'Re-open wallet step' });

  await pick(page, 'token-changed');
  assert.equal(await viewKind(page), 'step_reserved');
  await reopen().click();
  await noticeShown(page);
  assert.match(await depositNotice(page), /^A token in this pool changed since it was reviewed\. Stopped: don't sign anything for this step\./);
  assert.equal(await viewKind(page), 'step_reserved', 'the reservation is still shown as held');
  assert.equal(await reopen().isDisabled(), true);
  assert.match(await labPanel(page).innerText(), /Prepare is off for this deposit/);
  assert.equal(await page.locator('[data-testid="presign"]').count(), 0, 'nothing to review or sign');
  await reopen().click({ force: true }).catch(() => {});
  await sleep(300);
  assert.deepEqual(await routesOf(page), ['list', 'get', 'reconcile', 'prepare']);

  await pick(page, 'artifact-expired');
  await reopen().click();
  await noticeShown(page);
  assert.match(await depositNotice(page), /^The wallet handoff for this step expired\. The reservation for nonce 5 is still held\. If your wallet already sent it, use Check status\./);
  assert.equal(await viewKind(page), 'step_reserved');
  assert.equal(await page.locator('[data-testid="presign"]').count(), 0);
  assert.deepEqual(await routesOf(page), ['list', 'get', 'reconcile', 'prepare']);

  // rugged97's P2 on #72: a re-delivered step this page did not issue.
  await pick(page, 'redelivery-after-reload');
  await reopen().click();
  await viewBecomes(page, 'handoff_unconfirmed');
  assert.match(await labPanel(page).innerText(), /can't tell how much of its validity is left/);
  assert.equal(await page.locator('[data-testid="presign"]').count(), 0, 'nothing is offered for review');
  assert.deepEqual(await routesOf(page), ['list', 'get', 'reconcile', 'prepare']);

  await pick(page, 'session-required');
  await page.getByRole('button', { name: 'Prepare first step' }).click();
  await noticeShown(page);
  assert.match(await depositNotice(page), /^Your session ended\. Sign in again to continue\. Any reserved wallet step stays reserved\./);
  await sleep(300);
  assert.deepEqual(await probe(page, 'denials'), [{ code: 'session_required', epoch: 1 }], 'told to the session port once');
  assert.deepEqual(await routesOf(page), ['list', 'get', 'prepare'], 'no retry');

  await pick(page, 'owner-busy');
  await page.getByRole('button', { name: 'Prepare first step' }).click();
  await noticeShown(page);
  assert.match(await depositNotice(page), /^Another deposit of yours is still open or needs attention\. Resolve it first\./);
  await page.getByRole('button', { name: 'Open the deposit that blocks this one' }).click();
  await viewBecomes(page, 'pending');
  const calls = await probe(page, 'calls');
  assert.deepEqual(calls.map((call) => call.route), ['list', 'get', 'reconcile', 'prepare', 'get']);
  assert.equal(calls.at(-1).body.intentId, '00000000-0000-4000-8000-000000000050', 'the blocking deposit');
  assert.equal(s.fake.state.log.length, 0, 'the lab never touches the session service');
  await s.close();
});

test('boot reconciles only the outstanding deposit; a reported hash is checked, lowercased and only a hint; a second page loads only when asked (DB-11, T20)', async () => {
  const s = await scenario();
  const page = await s.open('/deposits');
  const pending = JSON.parse(readFileSync(resolve(import.meta.dirname, '../../api-contracts/deposit-v1/fixtures/variants/pending.json'), 'utf8'));

  await pick(page, 'boot-reconcile');
  let calls = await probe(page, 'calls');
  assert.deepEqual(calls.map((call) => call.route), ['list', 'reconcile']);
  assert.deepEqual(calls[1].body, { intentId: '00000000-0000-4000-8000-000000000051', version: pending.operation.version }, 'once, with its own version');
  assert.equal(await page.getByRole('button', { name: /^Open deposit / }).count(), 4);
  assert.equal(await page.getByText('Reserved slot', { exact: true }).count(), 1);
  assert.equal(await labPanel(page).count(), 0);
  assert.match(await page.locator('main').innerText(), /No deposit is open\./);

  await pick(page, 'report-hash');
  const hash = labPanel(page).getByLabel('Transaction hash from your wallet');
  const submit = labPanel(page).getByRole('button', { name: 'Report hash' });
  assert.match(await labPanel(page).innerText(), /The hash is only a hint\. Status comes from the chain\./);
  await hash.fill('0x1234');
  await submit.click();
  await sleep(300);
  assert.ok(!(await routesOf(page)).includes('report'), 'a malformed hash is never sent');
  await hash.fill(`0x${'AB'.repeat(32)}`);
  await submit.click();
  await viewBecomes(page, 'pending');
  calls = await probe(page, 'calls');
  assert.deepEqual(calls.map((call) => call.route), ['list', 'get', 'reconcile', 'report']);
  assert.deepEqual(calls.at(-1).body, { intentId: OPERATION_ID, version: 2, transactionHash: `0x${'ab'.repeat(32)}` });

  await pick(page, 'list-more');
  const listed = page.getByRole('button', { name: /^Open deposit / });
  assert.equal(await listed.count(), 2);
  await sleep(300);
  assert.deepEqual(await routesOf(page), ['list'], 'nothing more until asked');
  await page.getByRole('button', { name: 'Load more' }).click();
  await until(page, () => document.querySelectorAll('[aria-label^="Open deposit "]').length === 3, null, 'the second page');
  assert.equal(await page.getByRole('button', { name: 'Load more' }).count(), 0, 'no more pages');
  calls = await probe(page, 'calls');
  assert.deepEqual(calls.map((call) => call.body), [{ limit: 20 }, { limit: 20, before: '00000000-0000-4000-8000-000000000062' }]);
  await s.close();
});

test('both consumer screens open by their own routes, each with one React and no browser error', async () => {
  // No entry card leads to them from Positions (DESIGN.md I.1, J.3): the consumer-test build opens each by its route.
  const s = await scenario();
  const reacts = (page) => page.evaluate(() => {
    const keys = new Set();
    for (const node of document.querySelectorAll('*')) for (const key of Object.keys(node)) if (key.startsWith('__reactFiber$')) keys.add(key);
    return keys.size;
  });
  const deposits = await s.open('/deposits');
  await deposits.locator('[data-testid="fixture-banner"]').waitFor();
  assert.equal(await reacts(deposits), 1);
  const preview = await s.open('/live-preview');
  await preview.getByRole('heading', { name: 'Live preview' }).waitFor();
  assert.equal(await reacts(preview), 1);
  await s.close();
});
