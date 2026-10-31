/** Round 5: the real inline V2 funding UI, served against controlled read/session/quote fixtures. No live wallet or network. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright-core';
import { closeBrowser } from '../support/close-browser.mjs';
import { WALLET_V2_DIST } from '../support/wallet-dist.mjs';
import { openFundingChoice, amountStep, typeSide, changeFundingPool, VIRTUAL, WETH } from '../support/funding-choices.mjs';

const APP = resolve(import.meta.dirname, '../..');
if (!existsSync(join(WALLET_V2_DIST, 'index.html'))) throw new Error('.wallet-test-v2-dist is missing. Run npm run build:wallet-test-v2 first (npm run test:v2in does).');
// The server takes the production CSP from the compiled middleware (the unit build, as every browser suite needs).
if (!existsSync(resolve(APP, '.test-build/app/functions/_middleware.js'))) execFileSync(process.execPath, ['scripts/test.mjs', '--build-only'], { cwd: APP, stdio: 'ignore' });
const { routeChain } = await import('../support/browser-chain.mjs');
const { createFakeSession } = await import('../support/fake-session.mjs');
const { ARTWORK, press, pressContinue } = await import('../support/new-position.mjs');
const { FIXTURE_TOKEN, createReadStub } = await import('../support/read-stub.mjs');
const { installS2Wallet, S2_ACCOUNT, S2_OWNER } = await import('../support/s2-wallet.mjs');
const { createWalletServer } = await import('../support/wallet-server.mjs');
const { createChainReads } = await import('../support/chain-reads.mjs');
const { quoteFor, recorded } = await import('../support/crosschain-quotes.mjs');
const readV6Runtime = await import('../../../api-contracts/read-v6/runtime.mjs');

const V2_DIST = WALLET_V2_DIST;
const USDG = '0x5fc5360d0400a0fd4f2af552add042d716f1d168';
const ZERO = '0x0000000000000000000000000000000000000000';
const READ = resolve(import.meta.dirname, '../../../api-contracts/read-v1/fixtures/gateway');
/** A read-v1 gateway fixture with the fixture TOKEN standing for USDG: its address and its symbol, nothing else. */
const asUsdg = (name) => readFileSync(resolve(READ, `${name}.json`), 'utf8').replaceAll(FIXTURE_TOKEN, USDG).replaceAll('"TOKEN"', '"USDG"');
/** What a wallet on Robinhood Chain is never asked by the offer on the preview: no switch, no read, no signature, no send. */
const NEVER = ['eth_sendTransaction', 'eth_signTypedData_v4', 'wallet_sendCalls', 'wallet_switchEthereumChain', 'wallet_addEthereumChain', 'eth_estimateGas', 'eth_getTransactionCount'];
/** An amount the bridge stub answers with no route at all (the package's own quote.none). */
const NO_ROUTE_RAW = '7000000';
/** ETH sent as USDG through Relay alone (Across bridges one token as itself only): US$4,000 an ETH, in USDG units per wei. */
const ETH_AS_USDG = { num: 4_000_000_000n, den: 10n ** 18n };

let browser;
before(async () => {
  for (const options of process.env.DOMINO_BROWSER_PATH ? [{ executablePath: process.env.DOMINO_BROWSER_PATH }] : [{ channel: 'chrome' }, { channel: 'chromium' }, { channel: 'msedge' }, {}]) {
    try {
      browser = await chromium.launch({ ...options, headless: true });
      break;
    } catch {}
  }
  if (!browser) throw new Error('A Chromium browser is required.');
});
after(async () => {
  await closeBrowser(browser);
});

/** The wallet's balances as the read service reports them: read-v1 wallet-assets.zero, TOKEN as USDG, and `ethWei` of ETH. */
function walletAssets(ethWei) {
  const body = JSON.parse(asUsdg('wallet-assets.zero'));
  body.items.find((item) => item.address === ZERO).amountRaw = String(ethWei);
  return JSON.stringify(body);
}

/**
 * The build served with the read stub (TOKEN as USDG; no USDG, and `ethWei` of ETH, none unless said) and the test wallet
 * connected on Robinhood Chain, at New position's amount step.
 * Added 2026-10-06 (the integration review): `range`, a Custom range typed as the page writes prices ("1 ETH = … USDG"),
 * [lowest, highest]; `relayDown`, the origins listing with Relay busy (only what Across bridges listed); `held`, steps held
 * unsettled from an earlier visit (finance/v2/crosschain.ts's store, in localStorage).
 * Added 2026-10-06 (rugged's answer of 6 Oct: approval and deposit in one batch): `sendOn`, a fake ORIGIN chain the wallet
 * sends on (../support/s2-wallet.mjs; nothing is sent anywhere else); `batches`, deposits sent as one batch on an earlier
 * visit and kept until the wallet names their transaction (finance/v2/crosschain.ts's store, in localStorage).
 */
async function openNewPosition({ gateOpen = true, ethWei = 0n, balances = {}, bridge = false, switching = false, served = null, journal = null, clock = false, range = null, relayDown = false, held = null, sendOn = null, batches = null, originsFailures = 0, originsRetryAfter = 30 } = {}) {
  const fake = createFakeSession();
  const errors = [];
  // The read stub's own fixture for each read (tests/support/read-stub.mjs), TOKEN as USDG, and the wallet's balances.
  const read = createReadStub({
    answer: (route, body) =>
      route === 'wallet-assets'
        ? walletAssets(ethWei)
        : asUsdg({ 'pool-market': 'pool-market.not-requested', token: body.token === ZERO ? 'token.native' : 'token.success' }[route] ?? `${route}.success`),
  });

  const bridgeCalls = [];
  // Changed on purpose 2026-10-06 (the owner's point 2b): the offer sizes what it brings from the service's own quotes, so
  // the stub answers whatever amount is asked (../support/crosschain-quotes.mjs, from the package's recorded answers):
  // with Relay's gas on the destination when asked, and with no route for NO_ROUTE_RAW. Changed on purpose 2026-10-06
  // (rugged's delta of 6 Oct §3): a one click asks by output, answered from the package's quote.output variants.
  const bridgeRoute = async (request, url) => {
    if (!bridge || !url.pathname.startsWith('/api/crosschain/v1/')) return undefined;
    const route = url.pathname.split('/').at(-1);
    // Changed on purpose (data) 2026-10-06: crosschain-v1 1.1.0-rc.1.
    const headers = { 'X-Domino-Crosschain-Contract': '1.1.0-rc.1' };
    if (route === 'capabilities') return Response.json({ contractVersion: '1.1.0-rc.1', dataMode: 'live', enabledRoutes: ['origins', 'quote', 'status'] }, { headers });
    const cookie = request.headers.get('cookie')?.match(/__Host-domino-session=([^;]+)/)?.[1];
    const session = fake.state.sessions.get(cookie);
    assert.ok(session && !session.revoked, 'private bridge reads use a real test session');
    assert.equal(request.headers.get('X-Domino-CSRF'), session.csrf);
    const body = await request.json();
    bridgeCalls.push({ route, body });
    if (route === 'origins' && originsFailures-- > 0) {
      return Response.json({ error: 'session_rate_limited' }, { status: 429, headers: { ...headers, 'Retry-After': String(originsRetryAfter) } });
    }
    if (route === 'quote') {
      // ETH for USDG: at a price, through Relay alone (Added 2026-10-06).
      const crossKind = body.originToken === ZERO && body.destinationToken === USDG ? { rate: ETH_AS_USDG, relayOnly: true } : {};
      return Response.json(quoteFor(body, S2_OWNER, body.destinationGas ? 'variants/quote.destination-gas' : body.amountRaw === NO_ROUTE_RAW ? 'variants/quote.none' : 'responses/quote', crossKind), { headers });
    }
    // A deposit sent here (Added 2026-10-06): Relay has not seen it yet, about the very deposit asked.
    if (route === 'status' && body.depositTxHash !== RECORDED_DEPOSIT) return Response.json(awaitingFor(body), { headers });
    const data = JSON.parse(readFileSync(resolve(APP, '../api-contracts/crosschain-v1/fixtures/responses/' + route + '.json'), 'utf8').replaceAll('0x1111111111111111111111111111111111111111', S2_OWNER));
    // The listing is the recorded one, for the token asked.
    if (route === 'origins') data.origins.destinationToken = body.destinationToken;
    // Relay busy: its listing could not be read, so only what Across bridges is listed (the backend drops the rest).
    if (route === 'origins' && relayDown) {
      data.origins.providers = data.origins.providers.map((p) => (p.provider === 'relay' ? { provider: 'relay', status: 'rate_limited', reason: 'provider_rate_limited' } : p));
      data.origins.chains = data.origins.chains
        .map((chain) => ({ ...chain, tokens: chain.tokens.map((t) => ({ ...t, providers: t.providers.filter((p) => p !== 'relay') })).filter((t) => t.providers.length > 0) }))
        .filter((chain) => chain.tokens.length > 0);
    }
    return Response.json(data, { headers });
  };
  // Added 2026-10-06: read-v6's chain-balances served by the site's route (`served`, ../support/chain-reads.mjs), as the read
  // Worker answers it: its capabilities naming that read alone, and each answer with the contract's header.
  const readV6 = { 'X-Domino-Read-Contract': '1.1.0-rc.1' };
  const servedRoute = async (request, url) => {
    if (!served || !url.pathname.startsWith('/api/read/v6/')) return undefined;
    const route = url.pathname.split('/').at(-1);
    if (route === 'capabilities') return Response.json({ contractVersion: '1.1.0-rc.1', dataMode: 'live_read_only', chainIds: [4663, 8453, 42161], enabledReads: ['chain-balances'], walletAuthentication: false, privateAccounts: false, ownerTransactions: false, automation: false }, { headers: readV6 });
    const said = await served.answer(route, await request.json());
    return said ? Response.json(said.body, { status: said.status, headers: readV6 }) : Response.json({ error: 'route_not_available' }, { status: 404, headers: readV6 });
  };
  const server = createWalletServer({ fake, dist: V2_DIST, routes: [servedRoute, bridgeRoute, (request, url) => read.handle(request, url) ?? undefined] });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const origin = `http://127.0.0.1:${server.address().port}`;
  fake.origin = origin;
  const context = await browser.newContext({ viewport: { width: 1320, height: 1100 } });
  // Added 2026-10-06: the page's clock, to move past a quote's deadline or a sign-in's wait without waiting (Playwright's).
  if (clock) await context.clock.install();
  await context.route(/^https:\/\/fonts\.(googleapis|gstatic)\.com\//, (route) => route.fulfill({ status: 200, contentType: 'text/css', body: '' }));
  await context.route(ARTWORK, (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
  const rpc = await routeChain(context);

  let signCalls = 0;
  if (bridge) {
    await context.exposeFunction('__r5SignTestMessage', async (raw) => { signCalls++; return S2_ACCOUNT.signMessage({ message: { raw } }); });
    await context.addInitScript(() => {
      const wrapped = new WeakSet();
      window.addEventListener('eip6963:announceProvider', (event) => {
        const provider = event.detail.provider;
        if (event.detail.info.name !== 'S2 Test Wallet' || wrapped.has(provider)) return;
        wrapped.add(provider);
        const original = provider.request.bind(provider);
        provider.request = (args) => args.method === 'personal_sign' ? window.__r5SignTestMessage(args.params[0]) : original(args);
      });
    });
  }
  const wallet = await installS2Wallet(context, { chainId: 4663, ...balances, origin: sendOn });
  // A deposit this browser followed on an earlier visit (finance/v2/crosschain.ts's journal, in localStorage).
  if (journal) await context.addInitScript(({ key, value }) => { if (localStorage.getItem(key) === null) localStorage.setItem(key, value); }, journal);
  // Steps held unsettled on an earlier visit (finance/v2/crosschain.ts's store, in localStorage).
  if (held) await context.addInitScript(({ key, value }) => { if (localStorage.getItem(key) === null) localStorage.setItem(key, value); }, held);
  // Deposits sent as one batch on an earlier visit (finance/v2/crosschain.ts's store, in localStorage).
  if (batches) await context.addInitScript(({ key, value }) => { if (localStorage.getItem(key) === null) localStorage.setItem(key, value); }, batches);
  // The gate's test-build hook (src/v2/gate.ts): opens V2 options on this server's origin; S2 is then `preview` here.
  if (gateOpen) await context.addInitScript(() => { window.__dominoV2Test = { originOpen: true }; });
  const page = await context.newPage();
  page.on('pageerror', (error) => errors.push(error.message));
  const s = {
    page,
    wallet,
    context,
    bridgeCalls,
    quotes: () => bridgeCalls.filter((c) => c.route === 'quote').map((c) => c.body),
    walletReads: () => read.requests.filter((r) => r.path.endsWith('/wallet-assets')).length,
    signCalls: () => signCalls,
    async close() {
      await context.close();
      await server.closeAll();
      assert.deepEqual(errors, [], 'no page error');
      assert.deepEqual(wallet.state.sends, [], 'the wallet was never asked to send');
      // Changed on purpose 2026-10-05: after the person's choice of network (`switching`), the wallet goes there.
      const never = switching ? NEVER.filter((method) => method !== 'wallet_switchEthereumChain') : NEVER;
      // Added 2026-10-06: a suite that presses Bring (`sendOn`) sends on that origin, and only there.
      const elsewhere = (entry) => !sendOn || entry.chainId !== sendOn.state.chainId || entry.method === 'eth_signTypedData_v4';
      assert.deepEqual(wallet.state.log.filter((entry) => never.includes(entry.method) && elsewhere(entry)).map((entry) => entry.method), [], 'no automatic wallet switch, signature or transaction');
      assert.deepEqual(rpc.publicAsked ?? [], [], 'no public RPC');
    },
  };
  try {
    await page.goto(`${origin}/#/new`);
    await page.waitForFunction(() => window.__dominoSessionProbe?.view().status === 'no_wallet');
    await page.locator('header [aria-haspopup="dialog"]').click();
    await page.locator('[role="dialog"][aria-labelledby="wallet-dialog-title"]').getByRole('button', { name: 'Connect S2 Test Wallet', exact: true }).click();
    await page.waitForFunction(() => window.__dominoSessionProbe?.view().status !== 'no_wallet');
    await page.keyboard.press('Escape');
    // Step 1: USDG and its pool; step 2: the range the pool's price gives; then the amount step.
    await page.getByRole('combobox', { name: 'Search a token' }).fill(USDG);
    await page.locator(`[data-token-option="${USDG}"]`).click();
    await page.locator('[data-picker="pool"] input[name="pool-option"]').first().click({ timeout: 30_000 });
    await page.locator('[data-chosen-pool]').waitFor();
    const current = (step) => page.locator(`li[data-step="${step}"][aria-current="step"]`);
    await pressContinue(current('pool'));
    await current('range').waitFor();
    if (range) {
      // As tests/support/new-position.mjs walkToReview types one: Custom, the highest price first.
      const step = current('range').locator('[data-picker="range"]');
      await press(step.getByRole('radio', { name: 'Custom' }));
      for (const [which, price] of [['upper', range[1]], ['lower', range[0]]]) {
        const field = step.locator(`#range-${which}-price`);
        await field.fill(price);
        await field.press('Enter');
      }
    }
    await pressContinue(current('range'));
    await current('amount').waitFor();
    // The amount step's own balance read has answered (zero USDG, zero ETH).
    await page.locator('li[data-step="amount"] [data-pair-balance="ready"]').first().waitFor({ timeout: 30_000 });
    return s;
  } catch (error) {
    await s.close().catch(() => {});
    throw error;
  }
}

/** The deposit the package's recorded `status` answer is about (its fixtures/responses/status.json). */
const RECORDED_DEPOSIT = `0x${'d1'.repeat(32)}`;
/**
 * Added 2026-10-06: Relay's answer for a deposit it has not seen yet (the package's own status.relay-awaiting), about the
 * very deposit asked: the request echoed with the owner, and the transition from the state last shown.
 */
function awaitingFor(body) {
  const data = recorded('variants/status.relay-awaiting', S2_OWNER);
  data.status.request = { ...body, owner: S2_OWNER };
  data.status.transition = body.previousState === null ? 'initial' : 'unchanged';
  return data;
}

/** Types `text` in the USDG field: the amount step's own amount, typed in USDG. */
const typeUsdg = (s, text) => s.page.locator('li[data-step="amount"] [data-pair-side="1"] input[inputmode="decimal"]').fill(text);

const OUT = process.env.DOMINO_R5_SHOTS;
async function capture(s, name, selector = '[data-funds-offer]', action = null) {
  if (!OUT) return;
  mkdirSync(OUT, { recursive: true });
  for (const width of [1440, 1280, 390, 320]) {
    await s.page.setViewportSize({ width, height: 1080 });
    await s.page.locator(selector).first().scrollIntoViewIfNeeded();
    if (action) {
      const button = s.page.locator(action);
      await button.scrollIntoViewIfNeeded();
      assert.equal(await button.isVisible(), true, `funding action visible at ${width}`);
      const box = await button.boundingBox();
      assert.ok(box && box.width > 40 && box.x >= 0 && box.x + box.width <= width + 1, `funding action fits ${width}`);
    }
    // Reset the viewport before a full-page capture so the sticky header is at the page top.
    await s.page.evaluate(() => scrollTo(0, 0));
    await s.page.screenshot({ path: resolve(OUT, name + '-' + width + '.png'), fullPage: true, animations: 'disabled' });
    // The part itself, close up, at each width.
    await s.page.locator(selector).first().screenshot({ path: resolve(OUT, name + '-' + width + '-part.png'), animations: 'disabled' });
    assert.equal(await s.page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'no horizontal overflow at ' + width);
  }
  await s.page.setViewportSize({ width: 1320, height: 1100 });
}
const signIn = async (s) => {
  if (!await s.page.locator('[role="dialog"][aria-labelledby="wallet-dialog-title"]').count()) await s.page.locator('header [aria-haspopup="dialog"]').click();
  await s.page.locator('[role="dialog"][aria-labelledby="wallet-dialog-title"]').getByRole('button', { name: 'Sign in', exact: true }).click();
  await s.page.waitForFunction(() => window.__dominoSessionProbe.view().status === 'signed_in');
  await s.page.keyboard.press('Escape');
};
const ARB_USDC = '0xaf88d065e77c8cc2239327c5edb3a432268e5831';
const BASE_USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const ETH_USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
const OP_USDC = '0x0b2c639c533813f4aa9d7837caf62653d097ff85';
const token = (address, symbol, decimals) => ({ address, symbol, decimals });
const homeReads = (native = 0n) => createChainReads({ chainId: 4663, tokens: [token(ZERO, 'ETH', 18), token(USDG, 'USDG', 6)], balances: { [ZERO]: native } });
const chainReads = (chainId, stable, raw = 100_000_000n, gas = 10n ** 16n) => createChainReads({ chainId,
  tokens: [token(ZERO, 'ETH', 18), token(stable, 'USDC', 6)], balances: { [ZERO]: gas, [stable]: raw },
});
function together(...readers) {
  return { answer(route, request) {
    const replies = readers.map((reader) => reader.answer(route, request)).filter(Boolean);
    if (!replies.length) return undefined;
    const chains = replies[0].body.chains.map((entry) => replies.flatMap((reply) => reply.body.chains).find((candidate) => candidate.chainId === entry.chainId && candidate.status === 'current') ?? entry);
    const complete = chains.every((entry) => entry.status === 'current');
    const known = chains.every((entry) => entry.totalUsd !== null);
    const micros = known ? chains.reduce((sum, entry) => sum + BigInt(entry.totalUsd.replace('.', '')), 0n) : null;
    const body = { ...replies[0].body, chains, coverage: complete ? 'complete' : 'partial', totalUsd: micros === null ? null : `${micros / 1_000_000n}.${String(micros % 1_000_000n).padStart(6, '0')}` };
    assert.ok(readV6Runtime.validateResponse(route, body));
    return { status: 200, body };
  } };
}
const offerReady = async (s, amount = '50') => {
  await typeUsdg(s, amount); await signIn(s);
  await s.page.locator('[data-funding-state="ready"]').waitFor({ timeout: 30_000 });
  return s.page.locator('[data-funds-offer]');
};

test('unavailable bridge stays locked, with no wallet prompts or invented funds', async () => {
  const s = await openNewPosition();
  try {
    assert.equal(await s.page.locator('[data-funds-offer]').count(), 0);
    await typeUsdg(s, '1000');
    assert.match(await s.page.locator('[data-funds-locked]').innerText(), /isn't available yet/);
    assert.equal(await s.page.locator('[data-funds-other], #funds-origin-chain, [data-funds-deposit-button]').count(), 0);
  } finally { await s.close(); }
});

test('discovery is read-only and only known holdings appear before an amount; no manual network selector', async () => {
  const served = together(homeReads(), chainReads(42161, ARB_USDC));
  const s = await openNewPosition({ bridge: true, served });
  try {
    await s.page.locator('[data-funds-line]').waitFor();
    assert.match(await s.page.locator('[data-funds-line]').innerText(), /Arbitrum One/);
    assert.equal(s.quotes().length, 0);
    assert.equal(await s.page.locator('[data-funds-other], #funds-origin-chain, [data-funds-network] button').count(), 0);
  } finally { await s.close(); }
});

test('one automatic proposal uses the missing amount, shows maximum debit and has one primary action', async () => {
  const s = await openNewPosition({ bridge: true, served: together(homeReads(), chainReads(42161, ARB_USDC)) });
  try {
    const offer = await offerReady(s);
    assert.equal(await offer.locator('[data-funds-deposit-button]').count(), 1);
    assert.equal(await offer.locator('[data-funding-sources]').getAttribute('data-funding-sources'), '1');
    assert.match(await offer.locator('[data-funds-title]').innerText(), /Arbitrum One/);
    assert.match(await offer.locator('[data-funds-quote]').innerText(), /Maximum to send/);
    assert.equal(s.quotes()[0].amountKind, 'output');
    assert.equal(s.quotes()[0].amountRaw, '50000000');
    assert.equal(s.quotes()[0].maxInputRaw, '100000000');
    assert.equal(s.signCalls(), 1);
    assert.equal(await offer.locator('[data-funds-other], #funds-origin-chain, [data-funds-edit]').count(), 0);
    await offer.locator('[data-funds-details] summary').click();
    assert.match(await offer.locator('[data-funds-details]').innerText(), /0\.35%/);
    assert.match(await offer.locator('[data-funds-details]').innerText(), /Network fee|network fee/);
    await offer.locator('[data-funds-details] summary').click();
    await capture(s, 'funding-clean-offer');
  } finally { await s.close(); }
});

test('changing the typed amount automatically replaces the unsent quote without changing the field', async () => {
  const s = await openNewPosition({ bridge: true, served: together(homeReads(), chainReads(42161, ARB_USDC)) });
  try {
    await offerReady(s, '30');
    await typeUsdg(s, '40');
    await s.page.waitForFunction(() => document.querySelector('[data-funds-lack-raw]')?.getAttribute('data-funds-lack-raw') === '40000000');
    await s.page.locator('[data-funding-state="ready"]').waitFor();
    assert.equal(s.quotes().at(-1).amountRaw, '40000000');
    assert.equal(await s.page.locator('li[data-step="amount"] [data-pair-side="1"] input[inputmode="decimal"]').inputValue(), '40');
    assert.equal(s.bridgeCalls.filter((call) => call.route === 'origins').length, 1, 'amount changes reuse destination route discovery');
  } finally { await s.close(); }
});

test('tokens with no source gas are not an actionable transfer and do not trigger wallet scans', async () => {
  const s = await openNewPosition({ bridge: true, served: together(homeReads(), chainReads(42161, ARB_USDC, 100_000_000n, 0n),
    chainReads(8453, BASE_USDC, 0n, 0n), chainReads(1, ETH_USDC, 0n, 0n), chainReads(10, OP_USDC, 0n, 0n)) });
  try {
    await typeUsdg(s, '50'); await signIn(s);
    await s.page.locator('[data-funds-nothing]').waitFor();
    assert.equal(await s.page.locator('[data-funds-deposit-button]').count(), 0);
    assert.equal(s.quotes().length, 0);
    assert.match(await s.page.locator('[data-funds-nothing]').innerText(), /need ETH for the transfer fee/);
    assert.match(await s.page.locator('[data-funds-title]').innerText(), /Arbitrum One/);
  } finally { await s.close(); }
});

test('unread balances remain unavailable, never zero or an empty-network claim', async () => {
  const s = await openNewPosition({ bridge: true });
  try {
    await typeUsdg(s, '50'); await signIn(s);
    await s.page.locator('[data-funds-nothing]').waitFor();
    // Changed on purpose 2026-10-30 (QA round 2, SWEEP: no words saying data is missing): the balances are read again on
    // their own (every 30 s, and on focus), said as being checked.
    assert.equal(await s.page.locator('[data-funds-nothing]').innerText(), 'Checking the tokens in your wallet…');
    assert.equal(await s.page.locator('[data-funds-deposit-button]').count(), 0);
  } finally { await s.close(); }
});

test('Ethereum is discovered automatically through the supported balance reader', async () => {
  const s = await openNewPosition({ bridge: true, served: together(homeReads(), chainReads(1, ETH_USDC)) });
  try {
    const offer = await offerReady(s);
    assert.match(await offer.locator('[data-funds-title]').innerText(), /Ethereum/);
    assert.equal(s.quotes()[0].originChainId, 1);
    assert.equal(await offer.locator('[data-funds-other], #funds-origin-chain').count(), 0);
  } finally { await s.close(); }
});

test('different-origin balances are combined only by guaranteed destination output', async () => {
  const served = together(homeReads(), chainReads(8453, BASE_USDC, 20_000_000n, 500_000_000_000_000n), chainReads(42161, ARB_USDC, 50_000_000n, 500_000_000_000_000n));
  const s = await openNewPosition({ bridge: true, served });
  try {
    await typeUsdg(s, '60'); await signIn(s);
    const card = s.page.locator('[data-funding-state="ready"]');
    await card.waitFor({ timeout: 30_000 });
    assert.equal(await card.locator('[data-funding-sources]').getAttribute('data-funding-sources'), '2');
    assert.equal(await card.locator('[data-funds-deposit-button]').count(), 1);
    assert.equal(await s.page.locator('li[data-step="amount"] [data-pair-side="1"] input[inputmode="decimal"]').inputValue(), '60');
    await capture(s, 'funding-aggregate-offer');
  } finally { await s.close(); }
});

test('origins 429 recovers automatically after Retry-After, and changing the amount cannot bypass the wait', async () => {
  const s = await openNewPosition({ bridge: true, served: together(homeReads(), chainReads(42161, ARB_USDC)), clock: true, originsFailures: 1, originsRetryAfter: 30 });
  try {
    await typeUsdg(s, '30'); await signIn(s);
    await s.page.locator('[data-error-code="session_rate_limited"]').waitFor();
    assert.equal(s.bridgeCalls.filter((call) => call.route === 'origins').length, 1);
    await s.page.clock.fastForward(20_000);
    await typeUsdg(s, '40');
    await s.page.clock.fastForward(5_000);
    assert.equal(s.bridgeCalls.filter((call) => call.route === 'origins').length, 1, 'typed changes must retain the service cooldown');
    await s.page.clock.fastForward(10_000);
    await s.page.locator('[data-funding-state="ready"]').waitFor({ timeout: 30_000 });
    assert.equal(s.bridgeCalls.filter((call) => call.route === 'origins').length, 2);
    assert.equal(s.quotes().at(-1).amountRaw, '40000000');
    assert.equal(await s.page.locator('[data-funds-run-notice]').count(), 0);
  } finally { await s.close(); }
});

test('a useful primary-network read produces a proposal while the other balance group is still pending', async () => {
  const primary = together(homeReads(), chainReads(8453, BASE_USDC, 0n, 0n), chainReads(42161, ARB_USDC));
  const secondary = together(chainReads(1, ETH_USDC, 0n, 0n), chainReads(10, OP_USDC, 0n, 0n));
  const release = [];
  let secondaryWaiting = 0, secondaryCompleted = 0;
  const served = { async answer(route, request) {
    if (route === 'chain-balances' && request.tokens.some((token) => token.chainId === 1 || token.chainId === 10)) {
      secondaryWaiting += 1;
      await new Promise((done) => release.push(done));
      secondaryCompleted += 1;
      return secondary.answer(route, request);
    }
    return primary.answer(route, request);
  } };
  const s = await openNewPosition({ bridge: true, served });
  try {
    const offer = await offerReady(s);
    assert.ok(secondaryWaiting > 0, 'the secondary balance read really started');
    assert.equal(secondaryCompleted, 0, 'the proposal does not depend on its completion');
    assert.match(await offer.locator('[data-funds-title]').innerText(), /Arbitrum One/);
    assert.equal(s.quotes()[0].originChainId, 42161);
  } finally {
    release.forEach((done) => done());
    await s.close();
  }
});

// Added 2026-10-30 (launch capacity 9a, pass 3 review): Amount's minute tick asks Domino's balances again but reuses the
// Ethereum and OP Mainnet balances read on this visit, with no request for them; a first read (another pool chosen) asks
// them again. The bridge is off here so its own discovery, which reads them on a timer of its own, does not blur the count.
test('Amount’s tick reuses the Ethereum and OP Mainnet balances read this visit; a first read asks them again', async () => {
  const local = createChainReads({ chainId: 4663, tokens: [token(ZERO, 'ETH', 18), token(USDG, 'USDG', 6), token(VIRTUAL, 'VIRTUAL', 6), token(WETH, 'WETH', 18)], balances: { [ZERO]: 10n ** 18n } });
  const reads = together(local, chainReads(1, ETH_USDC, 0n, 0n), chainReads(10, OP_USDC, 0n, 0n));
  const asked = { away: 0, home: 0 };
  const served = { answer(route, request) {
    if (route === 'chain-balances') asked[request.tokens.some((entry) => entry.chainId === 1 || entry.chainId === 10) ? 'away' : 'home'] += 1;
    return reads.answer(route, request);
  } };
  const s = await openFundingChoice(browser, { bridge: false, clock: true, served });
  const pause = (ms) => new Promise((done) => setTimeout(done, ms));
  const settle = async (check, what) => {
    for (const end = Date.now() + 15_000; Date.now() < end; await pause(100)) if (check()) return;
    assert.fail(`timed out waiting for ${what}`);
  };
  try {
    await settle(() => asked.away > 0, 'the first read of Ethereum and OP Mainnet');
    await pause(1_000);
    const first = { ...asked };
    // One tick: Domino's balances asked again, Ethereum's and OP Mainnet's taken from this visit's read.
    await s.page.clock.fastForward(61_000);
    await settle(() => asked.home > first.home, 'the tick’s read of Domino’s balances');
    await pause(1_000);
    assert.equal(asked.away, first.away, 'the tick asks nothing of Ethereum or OP Mainnet');
    // Another pool: its first read asks them again.
    await changeFundingPool(s.page, 1);
    await settle(() => asked.away > first.away, 'a first read of Ethereum and OP Mainnet for the new pool');
  } finally { await s.close(); }
});

test('an expired idle proposal stays visible and only refreshes when the user requests it', async () => {
  const s = await openNewPosition({ bridge: true, served: together(homeReads(), chainReads(42161, ARB_USDC)), clock: true });
  try {
    await offerReady(s);
    const firstQuote = s.quotes().length;
    await s.page.clock.fastForward(125_000);
    await s.page.locator('[data-funds-deposit-button]').getByText('Update transfer', { exact: true }).waitFor();
    assert.equal(s.quotes().length, firstQuote, 'expiry and routine balance refresh do not start more quotes');
    assert.equal(s.bridgeCalls.filter((call) => call.route === 'origins').length, 1);
    await s.page.locator('[data-funds-deposit-button]').click();
    await s.page.locator('[data-funding-state="ready"] [data-funds-deposit-button]').getByText('Use these funds', { exact: true }).waitFor({ timeout: 30_000 });
    assert.equal(s.quotes().length, firstQuote + 1);
    assert.equal(s.bridgeCalls.filter((call) => call.route === 'origins').length, 1, 'explicit renewal still reuses destination discovery');
  } finally { await s.close(); }
});

// The complete Journey is important here: Edit → Change pool unmounts the previous amount panel.
// A component-only prop change cannot establish whether a quote survives a real pool change.
for (const scenario of [
  { name: 'ETH/USDG', poolIndex: 0, destinationToken: ZERO },
  { name: 'ETH/USDG entered in ETH', poolIndex: 0, side: 0, text: '0.005', destinationToken: ZERO },
  { name: 'WETH/USDG', poolIndex: 3, weth: 10n ** 18n, destinationToken: WETH },
]) {
  test(`source choice: ${scenario.name} keeps remote funds available when local funds cover the position`, async () => {
    const s = await openFundingChoice(browser, scenario);
    try {
      const side = scenario.side ?? 1, typed = scenario.text ?? '30';
      await typeSide(s.page, side, typed); await signIn(s);
      const remote = s.page.locator('button[data-funds-sources]');
      await remote.waitFor();
      assert.match(await remote.innerText(), /Arbitrum One/);
      const proceed = amountStep(s.page).locator('[data-journey-footer] button').last();
      assert.equal(await proceed.isDisabled(), false, 'the local conversion is still usable');
      await s.page.waitForTimeout(900);
      assert.equal(s.quotes().length, 0, 'discovering another network never spends a quote');
      if (scenario.name === 'ETH/USDG') await capture(s, 'funding-choice-local-and-remote', 'li[data-step="amount"][aria-current="step"]', 'button[data-funds-sources]');
      await remote.click();
      await s.page.locator('[data-funding-state="ready"] [data-funds-deposit-button]').waitFor({ timeout: 30_000 });
      assert.equal(s.quotes().length, 1);
      assert.equal(s.quotes()[0].destinationToken, scenario.destinationToken);
      assert.equal(s.quotes()[0].amountKind, 'output');
      if (side === 0) assert.equal(s.quotes()[0].amountRaw, '5000000000000000', 'typing the funding asset preserves the complete exact-input budget');
      else assert.ok(BigInt(s.quotes()[0].amountRaw) > 15_000_000_000_000_000n, 'the funding asset covers both sides, including the local swap');
      assert.equal(await proceed.isDisabled(), false, 'exploring a transfer does not lock the local route');
      assert.equal(await amountStep(s.page).locator(`[data-pair-side="${side}"] input`).inputValue(), typed);
      if (scenario.name === 'ETH/USDG') await capture(s, 'funding-choice-open', 'li[data-step="amount"][aria-current="step"]', '[data-funds-deposit-button]');
      await s.page.locator('[data-funds-close]').click();
      await remote.waitFor();
      assert.equal(await s.page.locator('[data-funds-quote]').count(), 0);
      assert.equal(s.quotes().length, 1, 'closing the preview never refreshes or submits it');
      assert.equal(s.wallet.state.sends.length, 0);
    } finally { await s.close(); }
  });
}

test('source choice: USDG/VIRTUAL edits replace the quote; changing the pool restores the closed choice', async () => {
  const s = await openFundingChoice(browser, { poolIndex: 1 });
  try {
    await typeSide(s.page, 0, '30'); await signIn(s);
    await s.page.locator(`button[data-pay-with="${ZERO}"]`).waitFor();
    const remote = s.page.locator('button[data-funds-sources]');
    await remote.waitFor();
    assert.equal(s.quotes().length, 0);
    await remote.click();
    await s.page.locator('[data-funding-state="ready"]').waitFor();
    assert.equal(s.quotes().at(-1).amountRaw, '30000000');
    await typeSide(s.page, 0, '40');
    await s.page.waitForFunction(() => document.querySelector('[data-funding-state="ready"] [data-funds-lack-raw]')?.getAttribute('data-funds-lack-raw') === '40000000');
    assert.deepEqual(s.quotes().map((quote) => quote.amountRaw), ['30000000', '40000000']);
    await changeFundingPool(s.page, 2);
    await typeSide(s.page, 0, '45');
    await remote.waitFor();
    assert.equal(await s.page.locator('[data-funds-quote]').count(), 0, 'the prior pool proposal is gone');
    await s.page.waitForTimeout(900);
    assert.equal(s.quotes().length, 2, 'the pool change did not keep the previous remote choice open');
    await remote.click();
    await s.page.locator('[data-funding-state="ready"]').waitFor();
    assert.deepEqual(s.quotes().map((quote) => [quote.destinationToken, quote.amountRaw]), [[USDG, '30000000'], [USDG, '40000000'], [USDG, '45000000']]);
    assert.match(await s.page.locator('[data-funds-lack]').innerText(), /45 USDG/);
    assert.equal(await amountStep(s.page).locator('[data-pair-side="0"] input').inputValue(), '45');
  } finally { await s.close(); }
});

test('source choice: a delayed quote from the previous pool cannot reopen or replace the new pool choice', async () => {
  let release = () => {}, entered = 0, finished = false;
  const s = await openFundingChoice(browser, { poolIndex: 1, quoteReply: async (_request, reply) => {
    if (++entered === 1) { await new Promise((done) => { release = done; }); finished = true; }
    return reply();
  } });
  try {
    await typeSide(s.page, 0, '30'); await signIn(s);
    await s.page.locator('button[data-funds-sources]').click();
    await s.page.locator('[data-funds-quote-loading]').waitFor();
    for (let i = 0; entered === 0 && i < 100; i++) await s.page.waitForTimeout(50);
    assert.equal(entered, 1, 'the old pool request really reached the service');
    await changeFundingPool(s.page, 2);
    await typeSide(s.page, 0, '45');
    const remote = s.page.locator('button[data-funds-sources]');
    await remote.waitFor();
    release();
    await s.page.waitForTimeout(900);
    assert.equal(finished, true, 'the old response arrived after the pool changed');
    assert.equal(await s.page.locator('[data-funds-quote], [data-funds-deposit-button]').count(), 0);
    assert.equal(await remote.isVisible(), true);
    assert.equal(s.quotes().length, 1);
    await remote.click();
    await s.page.locator('[data-funding-state="ready"]').waitFor();
    assert.deepEqual(s.quotes().map((quote) => quote.amountRaw), ['30000000', '45000000']);
    assert.match(await s.page.locator('[data-funds-lack]').innerText(), /45 USDG/);
  } finally { release(); await s.close(); }
});

test('source choice: a generic pair keeps one explicit local payment choice instead of assuming its pool tokens are bridgeable', async () => {
  const s = await openFundingChoice(browser, { searchToken: VIRTUAL, poolIndex: 1 });
  try {
    await typeSide(s.page, 0, '30');
    const local = s.page.locator(`button[data-pay-with="${ZERO}"]`);
    await local.waitFor();
    await local.click();
    const panel = s.page.locator(`[data-pay-with-amount="${ZERO}"]`);
    await panel.waitFor();
    await panel.locator('input[inputmode="decimal"]').fill('0.01');
    await s.page.locator('button[data-funds-sources]').waitFor();
    assert.equal(s.quotes().length, 0, 'a funding asset can be discovered without quoting unsupported pool tokens');
    assert.equal(await panel.locator('input[inputmode="decimal"]').inputValue(), '0.01');
    assert.equal(await s.page.locator('[data-funds-quote]').count(), 0);
    assert.equal(s.wallet.state.sends.length, 0);
  } finally { await s.close(); }
});
