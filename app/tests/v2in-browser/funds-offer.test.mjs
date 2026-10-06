/** Round 5: the real inline V2 funding UI, served against controlled read/session/quote fixtures. No live wallet or network. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright-core';
import { closeBrowser } from '../support/close-browser.mjs';
import { WALLET_V2_DIST } from '../support/wallet-dist.mjs';

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
const { createOriginChain } = await import('../support/s2-origin-chain.mjs');
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

const shot = (page, name) => {
  const dir = resolve(import.meta.dirname, '../../.test-artifacts');
  mkdirSync(dir, { recursive: true });
  return page.screenshot({ path: resolve(dir, name), fullPage: true });
};

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
async function openNewPosition({ gateOpen = true, ethWei = 0n, balances = {}, bridge = false, switching = false, served = null, journal = null, clock = false, range = null, relayDown = false, held = null, sendOn = null, batches = null } = {}) {
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
  // with Relay's gas on the destination when asked, and with no route for NO_ROUTE_RAW.
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
    const said = served.answer(route, await request.json());
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
async function capture(s, name, selector = '[data-funds-offer]') {
  if (!OUT) return;
  mkdirSync(OUT, { recursive: true });
  for (const width of [1440, 390, 320]) {
    await s.page.setViewportSize({ width, height: 1080 });
    await s.page.locator(selector).first().scrollIntoViewIfNeeded();
    await s.page.screenshot({ path: resolve(OUT, name + '-' + width + '.png'), fullPage: true });
    // The part itself, close up, at each width.
    await s.page.locator(selector).first().screenshot({ path: resolve(OUT, name + '-' + width + '-part.png') });
    assert.equal(await s.page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'no horizontal overflow at ' + width);
  }
  await s.page.setViewportSize({ width: 1320, height: 1100 });
}

// Changed on purpose 2026-10-06 (the owner's point 1): before an amount, nothing but the discreet line, and only when
// Domino's service read something to bring; the box comes once an amount the wallet can't fund is typed.
test('an amount the wallet can\'t fund shows the inline offer and its real service state, without wallet prompts; nothing before it', async () => {
  const s = await openNewPosition();
  try {
    await s.page.waitForTimeout(500);
    assert.equal(await s.page.locator('[data-funds-offer], [data-funds-line]').count(), 0, 'nothing before an amount');
    await typeUsdg(s, '1000');
    const offer = s.page.locator('[data-funds-offer]');
    await offer.waitFor();
    assert.equal(await offer.evaluate((el) => el.tagName), 'SECTION');
    assert.equal(await offer.locator(':scope > summary').count(), 0);
    assert.match(await offer.locator('[data-funds-locked]').innerText(), /isn't available yet/);
    assert.equal(await offer.locator('[data-funds-scan]').count(), 0, 'do not ask the wallet to scan for an unavailable bridge');
    assert.equal(await offer.locator('[data-funds-nothing]').count(), 0, 'an unread wallet is never reported empty');
    // The amount step says the wallet is short once (PairedAmounts); the offer does not say it again.
    assert.equal(await s.page.locator('[data-amount-short]').count(), 1);
    assert.equal(await offer.locator('[data-funds-lack]').count(), 0, 'one sentence, not two');
    await capture(s, 'funds-unavailable-after-local-fixture');
  } finally { await s.close(); }
});

// Changed on purpose 2026-10-05 (the owner, testing the offer: "it keeps asking me to sign in ... the networks don't show
// ... it has to happen behind the scenes, whoever uses Domino has no experience"): one sentence, Domino's other networks as
// the one choice, and the rest done for the person after it: sign in once, the wallet moved there once, its balance read,
// the token and the amount chosen, the quote asked.
const signInFromDialog = async (s) => {
  const dialog = s.page.locator('[role="dialog"][aria-labelledby="wallet-dialog-title"]');
  await dialog.getByRole('button', { name: 'Sign in', exact: true }).click();
  await s.page.waitForFunction(() => window.__dominoSessionProbe.view().status === 'signed_in');
  await s.page.keyboard.press('Escape');
};
const switches = (s) => s.wallet.state.log.filter((entry) => entry.method === 'wallet_switchEthereumChain').map((entry) => entry.params[0].chainId);
const ARB_USDC = '0xaf88d065e77c8cc2239327c5edb3a432268e5831';
const ARB_WETH = '0x82af49447d8a07e3bd95bd0d56f35241523fbab1';
/** 100 USDC and 0.01 ETH (for the approval's and the deposit's gas) on Arbitrum One, as the wallet's own read gives them. */
const ARB_WALLET = { tokens: { [`42161:${ARB_USDC}`]: { balance: 100_000_000n, decimals: 6 } }, native: { 42161: 10n ** 16n } };

// Changed on purpose 2026-10-06 (the owner's point 2b: a US$16 position asked for US$270): the amount brought is what the
// position lacks, sized from the service's own quote, never everything held there.
test('one click on a network: signed in once, the wallet moved there once, its balance read, the token and the amount the position lacks, one quote', async () => {
  const s = await openNewPosition({ bridge: true, switching: true, balances: ARB_WALLET });
  try {
    await typeUsdg(s, '50');
    const offer = s.page.locator('[data-funds-offer]');
    await offer.locator('[data-funds-sources]').waitFor();
    await offer.locator('[data-funds-network]').first().waitFor();
    assert.deepEqual(await offer.locator('[data-funds-network]').evaluateAll((els) => els.map((el) => [el.getAttribute('data-funds-network'), el.textContent.trim()])), [['8453', 'Base'], ['42161', 'Arbitrum One']], 'Domino\'s other networks, never the destination');
    assert.equal(await offer.locator('[data-funds-scan], #funds-origin-chain, [data-funds-signin], .dm-funds-route').count(), 0, 'no scan, no list of networks, no separate sign-in, no route steps');
    assert.equal(await offer.locator('[data-funds-other]').count(), 1, 'one discreet way to the other networks');
    assert.equal(s.bridgeCalls.length, 0, 'nothing asked before the choice');
    assert.deepEqual(switches(s), []);
    await capture(s, 'funds-choice');
    await offer.locator('[data-funds-network="42161"]').click();
    await signInFromDialog(s);
    const quote = offer.locator('[data-funds-quote]');
    await quote.waitFor({ timeout: 30_000 });
    assert.equal(s.signCalls(), 1, 'signed once');
    assert.deepEqual(switches(s), ['0xa4b1'], 'the wallet moved to Arbitrum One once, to read it (the service read nothing)');
    // 50 USDG lacking, sent as USDC: 50 plus room for the fees; the first quote's minimum covers it, so it is the only one.
    assert.deepEqual(s.quotes().map((q) => [q.originChainId, q.originToken, q.amountRaw, q.destinationToken, q.destinationGas]), [[42161, ARB_USDC, '51000000', USDG, false]], 'one quote, for what the position lacks');
    // Changed on purpose 2026-10-06 (the integration review): the title names the network alone once it is picked; the
    // button says what leaves the wallet (USDC), the card what arrives (USDG).
    assert.match(await offer.locator('[data-funds-title]').innerText(), /^Bring funds from Arbitrum One$/);
    assert.equal(await offer.locator('[data-funds-sources]').count(), 0, 'the choice made, the quote is the screen');
    // The card: what arrives and when, one button, the discrete line; the rest folded under one Details.
    assert.equal((await quote.locator('[data-funds-receive] .dm-funds-delivery').innerText()).trim(), 'You receive about 50.781437 USDG on Robinhood Chain (at least 50.52753 USDG)');
    assert.equal((await quote.locator('[data-funds-eta]').innerText()).trim(), 'Arrives in about 1 s');
    assert.equal((await quote.locator('[data-funds-deposit-button]').innerText()).trim(), 'Bring 51 USDC from Arbitrum One');
    // Changed on purpose 2026-10-06 (rugged's answer of 6 Oct, F7 delta of 6 Oct §1): in view, Domino's fee with its amount,
    // token, chain and where it is charged (in #16's discrete line), and the network fee on the origin; the rest in Details.
    assert.match(await quote.locator('[data-funds-bridge-elsewhere]').innerText(), /^Domino fee \(0\.35%\): 0\.1785 USDC, charged by Relay on Arbitrum One · you can also bridge with any other service$/);
    assert.equal((await quote.locator('[data-funds-network-fee="estimated"]').innerText()).trim(), 'Network fee on Arbitrum One: about 0.000001 ETH, estimated by Relay');
    assert.equal(await quote.locator('details').count(), 1, 'ONE Details');
    assert.equal(await quote.locator('[data-funds-quote-details]').getAttribute('open'), null, 'closed');
    assert.equal(await quote.locator('[data-funds-candidate="relay"]').isVisible(), false, 'the bridge fee and the other route are in Details');
    assert.equal(await offer.getByText('Quote', { exact: true }).count(), 0, 'no "Quote" heading');
    assert.equal(await offer.locator('.dm-pill').count(), 0, 'no "Best" pill');
    await capture(s, 'funds-one-click');
    await quote.locator('[data-funds-quote-details] > summary').click();
    assert.match(await quote.locator('[data-funds-candidate="relay"][data-funds-winner] [data-funds-lines]').innerText(), /Domino fee \(0\.35%\): 0\.1785 USDC, charged by Relay on Arbitrum One/);
    assert.equal(await quote.locator('[data-funds-candidate="across"]').isVisible(), true, 'the other route, in the same Details');
    assert.match(await quote.locator('[data-funds-send]').innerText(), /51 USDC/);
    await capture(s, 'funds-one-click-details');
  } finally { await s.close(); }
});

// Added 2026-10-06 (the owner's point 2b): the quote follows the amount typed in the step: sized again after a pause when
// it changes, and gone once nothing is lacking.
test('the quote follows the amount typed: sized again when it changes, gone when nothing is lacking', async () => {
  const s = await openNewPosition({ bridge: true, switching: true, balances: ARB_WALLET });
  try {
    await typeUsdg(s, '50');
    const offer = s.page.locator('[data-funds-offer]');
    await offer.locator('[data-funds-network="42161"]').click();
    await signInFromDialog(s);
    await s.page.waitForFunction(() => document.querySelector('[data-funds-quote] [data-funds-deposit-button]')?.textContent?.trim() === 'Bring 51 USDC from Arbitrum One', null, { timeout: 30_000 });
    await typeUsdg(s, '80');
    // Changed on purpose 2026-10-06 (the review): the quote for 50 is greyed and closed at once, not only once its new size is asked.
    assert.equal(await s.page.evaluate(() => document.querySelector('[data-funds-quote-stale]') !== null && document.querySelector('[data-funds-quote] [data-funds-deposit-button]')?.disabled === true), true, 'never sendable for the old amount');
    await s.page.waitForFunction(() => document.querySelector('[data-funds-quote] [data-funds-deposit-button]')?.textContent?.trim() === 'Bring 81.6 USDC from Arbitrum One' && !document.querySelector('[data-funds-quote-stale]'), null, { timeout: 30_000 });
    assert.deepEqual(s.quotes().map((q) => q.amountRaw), ['51000000', '81600000'], 'one quote each, the second for the new amount');
    await typeUsdg(s, '');
    await offer.waitFor({ state: 'detached' });
    assert.equal(s.quotes().length, 2, 'nothing asked for an amount no longer lacking');
  } finally { await s.close(); }
});

test('a network with nothing to bring says so; one whose balance could not be read says that, never zero', async () => {
  const s = await openNewPosition({ bridge: true, switching: true, balances: { tokens: {
    '8453:0x4200000000000000000000000000000000000006': { balance: 0n, decimals: 18 },
    '8453:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913': { balance: 0n, decimals: 6 },
  } } });
  try {
    await typeUsdg(s, '50');
    const offer = s.page.locator('[data-funds-offer]');
    await offer.locator('[data-funds-network="8453"]').click();
    await signInFromDialog(s);
    const said = offer.locator('[data-funds-pick="empty"][data-funds-pick-network="8453"]');
    await said.waitFor({ timeout: 30_000 });
    assert.equal((await said.innerText()).trim(), 'You have no ETH, WETH or USDC on Base.');
    // Arbitrum One's tokens are unknown to this wallet: unread, so not "nothing".
    await offer.locator('[data-funds-network="42161"]').click();
    const unread = offer.locator('[data-funds-pick="failed"][data-error-code="read_partial"]');
    await unread.waitFor({ timeout: 30_000 });
    assert.match(await unread.innerText(), /Arbitrum One couldn't be read/);
    assert.equal(s.quotes().length, 0, 'no quote without something to send');
    assert.deepEqual(switches(s), ['0x2105', '0xa4b1']);
  } finally { await s.close(); }
});

// Added 2026-10-06 (the owner's point 7: no transaction that cannot go through): a token on a network with no ETH there.
test('a token on a network with no ETH to send it is not brought: said in one line, nothing asked of the bridge', async () => {
  const s = await openNewPosition({ bridge: true, switching: true, balances: { tokens: { [`42161:${ARB_USDC}`]: { balance: 100_000_000n, decimals: 6 }, [`42161:${ARB_WETH}`]: { balance: 0n, decimals: 18 } } } });
  try {
    await typeUsdg(s, '50');
    const offer = s.page.locator('[data-funds-offer]');
    await offer.locator('[data-funds-network="42161"]').click();
    await signInFromDialog(s);
    const said = offer.locator('[data-funds-pick="empty"][data-funds-pick-network="42161"]');
    await said.waitFor({ timeout: 30_000 });
    assert.equal((await said.innerText()).trim(), 'You have 100 USDC on Arbitrum One, but no ETH there to pay the network fee.');
    assert.equal(s.quotes().length, 0);
  } finally { await s.close(); }
});

test('a pool covered by the existing one-token swap keeps the cross-network offer out', async () => {
  const s = await openNewPosition({ ethWei: 500000000000000n + 1000000n });
  try {
    await s.page.waitForTimeout(500);
    assert.equal(await s.page.locator('[data-funds-offer]').count(), 0);
    await typeUsdg(s, '1000');
    await s.page.locator('[data-funds-offer]').waitFor();
    assert.equal(await s.page.locator('[data-amount-short]').count(), 1, 'the amount step\'s own line says it is short');
    await typeUsdg(s, '0.1');
    await s.page.locator('[data-funds-offer]').waitFor({ state: 'detached' });
  } finally { await s.close(); }
});

test('the closed V2 gate retains the original amount step without funds discovery', async () => {
  const s = await openNewPosition({ gateOpen: false });
  try {
    await s.page.waitForTimeout(500);
    assert.equal(await s.page.locator('[data-funds-offer], [data-funds-line]').count(), 0);
    await typeUsdg(s, '1000');
    await s.page.waitForTimeout(500);
    assert.equal(await s.page.locator('[data-funds-offer], [data-funds-line]').count(), 0);
  } finally { await s.close(); }
});

// Changed on purpose 2026-10-06 (the owner's point 4): "Get gas on {destination}" in the card when the destination's ETH
// reads as none (never pre-chosen), the quote sized again with it; Change amount keeps the amount (a new quote by itself
// after a pause), the network and the token; no bridge slippage, no provider names, no "Get a quote".
test('the quote card: gas on the destination in the card, sized again; Change amount re-quotes by itself; no route says so', async () => {
  const s = await openNewPosition({ bridge: true, switching: true, balances: ARB_WALLET });
  try {
    await typeUsdg(s, '50');
    const offer = s.page.locator('[data-funds-offer]');
    await offer.locator('[data-funds-network="42161"]').click();
    await signInFromDialog(s);
    const quote = offer.locator('[data-funds-quote]');
    await quote.waitFor({ timeout: 30_000 });
    assert.equal(await quote.getAttribute('data-funds-decision'), 'relay');
    // The wallet has no ETH on Robinhood Chain (the amount step read it): the option is in the card, not chosen.
    const gas = quote.locator('[data-funds-gas-card] input');
    assert.equal(await gas.isChecked(), false, 'gas delivery is the person\'s choice');
    await capture(s, 'funds-gas-option');
    await gas.check();
    await s.page.waitForFunction(() => !document.querySelector('[data-funds-quote-stale]') && /Includes 0\.\d+ ETH for network fees on Robinhood Chain/.test(document.querySelector('[data-funds-quote] [data-funds-candidate="relay"] [data-funds-lines]')?.textContent ?? ''), null, { timeout: 30_000 });
    assert.equal(await quote.locator('[data-funds-candidate="across"]').getAttribute('data-funds-status'), 'destination_gas_unsupported');
    assert.equal(await quote.locator('[data-funds-candidate="across"]').isVisible(), false, 'the other route is folded');
    await quote.locator('[data-funds-quote-details] > summary').click();
    assert.equal(await quote.locator('[data-funds-candidate="across"]').isVisible(), true, 'the other route and why it has no price stay one click away');
    // Sized again with the gas: what arrives with Relay's top-up taken out still covers the position.
    const sized = s.quotes().filter((q) => q.destinationGas);
    assert.ok(sized.length >= 1 && sized.length <= 2, `${sized.length} quotes with the gas: at most one more`);
    assert.ok(BigInt(sized.at(-1).amountRaw) > 51_000_000n, 'more sent, so what arrives still covers the position');
    await gas.uncheck();
    await s.page.waitForFunction(() => document.querySelector('[data-funds-quote]:not([aria-busy]) [data-funds-deposit-button]')?.textContent?.trim() === 'Bring 51 USDC from Arbitrum One' && !document.querySelector('[data-funds-quote-stale]'), null, { timeout: 30_000 });
    // Change amount: the amount, the network and the token; nothing else.
    await offer.locator('[data-funds-edit] > summary').click();
    const edit = offer.locator('[data-funds-edit]');
    assert.equal(await edit.locator('#funds-amount').inputValue(), '51');
    assert.equal(await edit.locator('[data-funds-slippage], [data-funds-get-quote], [data-funds-providers]').count(), 0, 'no bridge slippage, no Get a quote, no provider list');
    assert.equal(await edit.getByText(/Relay|Across/).count(), 0, 'no provider names');
    const before = s.quotes().length;
    await edit.locator('#funds-amount').fill('3');
    await edit.locator('#funds-amount').fill('30');
    await s.page.waitForFunction(() => document.querySelector('[data-funds-quote] [data-funds-deposit-button]')?.textContent?.trim() === 'Bring 30 USDC from Arbitrum One' && !document.querySelector('[data-funds-quote-stale]'), null, { timeout: 30_000 });
    assert.deepEqual(s.quotes().slice(before).map((q) => q.amountRaw), ['30000000'], 'asked once, after the pause, for what was typed last');
    await edit.locator('#funds-amount').fill('7');
    await s.page.waitForFunction(() => document.querySelector('[data-funds-quote]')?.getAttribute('data-funds-decision') === 'none' && !document.querySelector('[data-funds-quote-stale]'), null, { timeout: 30_000 });
    assert.equal(await quote.locator('[data-funds-deposit-button]').count(), 0, 'no send control for a plan with no route');
    assert.match(await quote.locator('[data-funds-no-route]').innerText(), /No route available right now\./);
    await capture(s, 'funds-no-route');
  } finally { await s.close(); }
});

// Added 2026-10-06 (rugged97's delta of 5 Oct, item 3: read-v6's chain-balances): Domino's service reads the balances on the
// other networks; the one click then asks the quote with the wallet where it is, and the wallet moves to that network only
// when the person presses the button that sends.
const arbitrumHoldings = (balances = { [ARB_USDC]: 100_000_000n, [ZERO]: 10n ** 16n }) => createChainReads({
  chainId: 42161,
  tokens: [{ address: ZERO, symbol: 'ETH', decimals: 18 }, { address: ARB_WETH, symbol: 'WETH', decimals: 18 }, { address: ARB_USDC, symbol: 'USDC', name: 'USD Coin', decimals: 6 }],
  balances,
});
/**
 * Added 2026-10-06 (rugged97's #379): the networks each chain-balances request named, in order. Ethereum and OP Mainnet
 * (`BALANCE_CHAIN_IDS`) are asked in a request of their own, beside Domino's three.
 */
const BALANCE_CHAIN_IDS = [1, 10];
const askedNetworks = (reads) => reads.calls.filter((c) => c.route === 'chain-balances').map((c) => [...new Set(c.request.tokens.map((t) => t.chainId))]);
/** The service's reads of Domino's three networks alone (never one naming Ethereum or OP Mainnet). */
const dominoReads = (reads) => reads.calls.filter((c) => c.route === 'chain-balances' && !c.request.tokens.some((t) => BALANCE_CHAIN_IDS.includes(t.chainId)));
const dominoRead = (reads) => dominoReads(reads)[0];
/** Added 2026-10-06 (the review of rugged97's #379): the service's reads of Ethereum and OP Mainnet alone, in their own request. */
const elsewhereReads = (reads) => reads.calls.filter((c) => c.route === 'chain-balances' && c.request.tokens.every((t) => BALANCE_CHAIN_IDS.includes(t.chainId)));
/**
 * Added 2026-10-06 (the review of rugged97's #379): Domino's three read by `domino`, and Ethereum and OP Mainnet by
 * `elsewhere`, each stub answering, and recording, the requests of its own read alone.
 */
const twoReads = (domino, elsewhere) => ({
  answer: (route, request) => (route === 'chain-balances' && request.tokens?.some((t) => BALANCE_CHAIN_IDS.includes(t.chainId)) ? elsewhere : domino).answer(route, request),
});

// Added 2026-10-06 (the owner's point 1: "only before an amount, only when the person has money on another network ... a
// visual sign that she has a token there and that we will bridge it"; clicking brings everything held there, less the gas).
test('before an amount, ONE discreet line names what the service read on another network; one click quotes all of it, the wallet staying where it is', async () => {
  const reads = arbitrumHoldings();
  const s = await openNewPosition({ bridge: true, served: reads });
  try {
    const line = s.page.locator('[data-funds-line]');
    await line.waitFor({ timeout: 30_000 });
    assert.equal(await s.page.locator('[data-funds-line]').count(), 1, 'one line');
    assert.equal(await line.getAttribute('data-funds-line'), '42161');
    assert.equal((await line.locator('.dm-funds-line-text').innerText()).trim(), 'You have 100 USDC on Arbitrum One (about $100.00)');
    assert.equal((await line.locator('.dm-funds-line-action').innerText()).trim(), 'Bring it here');
    assert.equal(await s.page.locator('[data-funds-offer]').count(), 0, 'the line alone, no box');
    // Under the two amounts, before Advanced.
    assert.equal(await s.page.evaluate(() => {
      const line = document.querySelector('[data-funds-line]');
      const advanced = document.querySelector('li[data-step="amount"] [data-flow-advanced]');
      const amounts = document.querySelector('li[data-step="amount"] [data-paired-amounts]');
      return !!(line && advanced && amounts && amounts.compareDocumentPosition(line) & Node.DOCUMENT_POSITION_FOLLOWING && line.compareDocumentPosition(advanced) & Node.DOCUMENT_POSITION_FOLLOWING);
    }), true);
    // Changed on purpose 2026-10-06 (paying with one other token): the destination's WETH and USDG after its ETH.
    // Changed on purpose 2026-10-06 (rugged97's #379): Ethereum and OP Mainnet are asked in a request of their own, beside
    // this one (dominoRead), so this one is found by what it asks.
    assert.deepEqual(dominoRead(reads).request.tokens.map((t) => t.chainId), [8453, 8453, 8453, 42161, 42161, 42161, 4663, 4663, 4663], 'the other networks\' ETH, WETH and USDC, then the destination\'s ETH, WETH and USDG');
    assert.equal(s.bridgeCalls.length, 0, 'no sign-in, no quote before the click');
    assert.deepEqual(switches(s), []);
    await capture(s, 'funds-discreet-line', '[data-funds-line]');
    await line.click();
    await signInFromDialog(s);
    const quote = s.page.locator('[data-funds-offer] [data-funds-quote]');
    await quote.waitFor({ timeout: 30_000 });
    assert.deepEqual(s.quotes().map((q) => [q.originChainId, q.originToken, q.amountRaw, q.destinationToken]), [[42161, ARB_USDC, '100000000', USDG]], 'all of it, brought as USDG (the same kind)');
    assert.equal((await s.page.locator('[data-funds-title]').innerText()).trim(), 'Bring funds from Arbitrum One', 'never a token beside the button\'s other one');
    assert.deepEqual(switches(s), [], 'the wallet stays on Robinhood Chain for the quote');
    assert.equal(await s.page.locator('[data-funds-line]').count(), 0, 'the line gives way to the offer');
    await capture(s, 'funds-discreet-line-quote');
  } finally { await s.close(); }
});

test('no line when every network the service read holds nothing to bring', async () => {
  // Changed on purpose 2026-10-06 (the review of rugged97's #379: with two reads, "a chain-balances read was asked" no
  // longer said Domino's was): Domino's three, read by one stub, and Ethereum and OP Mainnet, read apart by another (nothing
  // on Ethereum either, OP Mainnet not configured), each checked on its own before the page is looked at.
  const arbitrum = arbitrumHoldings({});
  const ethereum = ethereumHoldings({});
  const s = await openNewPosition({ bridge: true, served: twoReads(arbitrum, ethereum) });
  try {
    for (const until = Date.now() + 30_000; dominoReads(arbitrum).length === 0 || elsewhereReads(ethereum).length === 0; await s.page.waitForTimeout(50)) assert.ok(Date.now() < until, 'both reads asked');
    await s.page.waitForTimeout(800);
    assert.deepEqual(dominoRead(arbitrum).request.tokens.map((t) => t.chainId), [8453, 8453, 8453, 42161, 42161, 42161, 4663, 4663, 4663], 'Domino\'s three, read');
    assert.ok(askedNetworks(arbitrum).every((ids) => ids.join() === DOMINO_ASKED), 'Domino\'s read, only Domino\'s three');
    assert.ok(askedNetworks(ethereum).every((ids) => ids.join() === ELSEWHERE_ASKED), 'Ethereum and OP Mainnet, read on their own');
    assert.equal(await s.page.locator('[data-funds-line], [data-funds-offer]').count(), 0);
  } finally { await s.close(); }
});

test("after an amount, the service's balances under each network; one click quotes what the position lacks with the wallet where it is", async () => {
  const reads = arbitrumHoldings();
  const s = await openNewPosition({ bridge: true, served: reads });
  try {
    await s.page.locator('[data-funds-line]').waitFor({ timeout: 30_000 });
    await typeUsdg(s, '50');
    const offer = s.page.locator('[data-funds-offer]');
    const holds = offer.locator('[data-funds-network-holds="42161"]');
    await holds.waitFor({ timeout: 30_000 });
    // Changed on purpose 2026-10-06 (the integration review): what can be sent, ETH less the gas Review keeps.
    assert.equal((await holds.innerText()).trim(), 'You have 0.0095 ETH · 100 USDC', 'no USD: Arbitrum One\'s ETH has no price in this read');
    assert.equal(await offer.locator('[data-funds-network-holds="8453"]').count(), 0, 'Base not read by the service: nothing said, never a zero');
    assert.equal(await offer.locator('[data-funds-network="8453"]').count(), 1, 'its button stays: the wallet\'s own read there');
    assert.equal(await s.page.locator('[data-funds-line]').count(), 0, 'the line is for before an amount only');
    assert.deepEqual(switches(s), [], 'nothing asked of the wallet to know it');
    await shot(s.page, 'funds-served-networks.png');
    await offer.locator('[data-funds-network="42161"]').click();
    await signInFromDialog(s);
    const quote = offer.locator('[data-funds-quote]');
    await quote.waitFor({ timeout: 30_000 });
    assert.deepEqual(s.quotes().map((q) => q.amountRaw), ['51000000'], 'what the position lacks, sized: one quote');
    assert.deepEqual(switches(s), [], 'the wallet stays on Robinhood Chain for the quote');
    // Changed on purpose 2026-10-06 (rugged97's #379): counted among Domino's own reads (Ethereum's and OP Mainnet's are apart).
    assert.ok(dominoReads(reads).length >= 2, 'read when the step opened, and again for the choice');
    await shot(s.page, 'funds-served-balances.png');
  } finally { await s.close(); }
});

// Added 2026-10-06 (the owner's point 3): a network read as empty is gone; when every network read is empty, one sentence.
test('every network read is empty: one sentence instead of empty buttons, and the other networks one click away', async () => {
  const empty = (chainId, stable, wrapped) => createChainReads({ chainId, tokens: [{ address: ZERO, symbol: 'ETH', decimals: 18 }, { address: wrapped, symbol: 'WETH', decimals: 18 }, { address: stable, symbol: 'USDC', decimals: 6 }] });
  const base = empty(8453, '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', '0x4200000000000000000000000000000000000006');
  const arbitrum = empty(42161, ARB_USDC, ARB_WETH);
  // Both networks read (each stub reads its own): one answer, as the service gives it.
  const served = {
    calls: [],
    answer(route, request) {
      served.calls.push({ route, request });
      if (route !== 'chain-balances') return undefined;
      const a = arbitrum.answer(route, request).body;
      const b = base.answer(route, request).body;
      const chains = a.chains.map((chain) => (chain.chainId === 8453 ? b.chains.find((c) => c.chainId === 8453) : chain));
      const body = { ...a, chains, coverage: chains.every((c) => c.status === 'current') ? 'complete' : 'partial', totalUsd: null };
      assert.ok(readV6Runtime.validateResponse(route, body) && readV6Runtime.validateExchange(route, request, body), 'the merged answer keeps the contract');
      return { status: 200, body };
    },
  };
  const s = await openNewPosition({ bridge: true, served });
  try {
    await s.page.waitForTimeout(800);
    assert.equal(await s.page.locator('[data-funds-line]').count(), 0, 'nothing before an amount');
    await typeUsdg(s, '50');
    const offer = s.page.locator('[data-funds-offer]');
    const nothing = offer.locator('[data-funds-nothing]');
    await nothing.waitFor({ timeout: 30_000 });
    assert.equal((await nothing.innerText()).trim(), 'Nothing to bring from Base or Arbitrum One.');
    assert.equal(await offer.locator('[data-funds-network]').count(), 0, 'no empty buttons');
    assert.equal(await offer.locator('[data-funds-other]').count(), 1);
    await capture(s, 'funds-nothing-elsewhere');
  } finally { await s.close(); }
});

// Added 2026-10-06 (the owner's point 2a: "let it fetch from more chains, not only these"): the listing's other networks
// with both Relay and Across, behind ONE discreet entry; the person picks the network and the token and types the amount
// (the service reads no balance there yet); one quote, one button; the wallet moves only to send.
test('Other networks: pick Ethereum and its USDC, type the amount; one quote after the pause, one button, the wallet not moved', async () => {
  const s = await openNewPosition({ bridge: true, served: arbitrumHoldings() });
  try {
    await s.page.locator('[data-funds-line]').waitFor({ timeout: 30_000 });
    await typeUsdg(s, '50');
    const offer = s.page.locator('[data-funds-offer]');
    await offer.locator('[data-funds-other]').click();
    await signInFromDialog(s);
    const form = offer.locator('[data-funds-others]');
    await form.locator('#funds-origin-chain').waitFor({ timeout: 30_000 });
    await form.locator('#funds-origin-chain').click();
    const names = await s.page.locator('[data-funds-origin-chain]').evaluateAll((els) => els.map((el) => el.textContent.trim()));
    assert.deepEqual(names, ['Base', 'Arbitrum One', 'Ethereum', 'OP Mainnet', 'Linea'], 'Domino\'s own, then the others with both bridges; one name each');
    await s.page.locator('[data-funds-origin-chain="1"]').click();
    await form.locator('#funds-origin-token').click();
    // Changed on purpose 2026-10-06 (the review: Relay lists sixteen tokens on Ethereum here, SOMI, PLUME, APE...): the
    // network's own currency, WETH, USDC and USDT, and what both bridges list.
    assert.deepEqual(await s.page.locator('[data-funds-origin-token]').evaluateAll((els) => els.map((el) => el.textContent.trim())), ['ETH', 'WETH', 'USDC', 'USDT', 'USDG']);
    await s.page.locator('[data-funds-origin-token="0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48"]').click();
    await form.locator('#funds-amount').fill('25');
    const quote = offer.locator('[data-funds-quote]');
    await quote.waitFor({ timeout: 30_000 });
    assert.deepEqual(s.quotes().map((q) => [q.originChainId, q.originToken, q.amountRaw]), [[1, '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', '25000000']]);
    assert.equal((await quote.locator('[data-funds-deposit-button]').innerText()).trim(), 'Bring 25 USDC from Ethereum');
    assert.deepEqual(switches(s), [], 'the wallet moves only to send');
    await capture(s, 'funds-other-networks');
  } finally { await s.close(); }
});

// Added 2026-10-06 (the owner's point 4): a deposit followed from an earlier visit, as its card reads once it arrived:
// where it came from in one line (the bridge in Details), the amounts rounded, and Use for what is in the wallet now.
test('a deposit followed after a reload: arrived, coming from Arbitrum One, the bridge in Details, Use for what is there now', async () => {
  const { depositJournalKey } = createRequire(import.meta.url)('../../.test-build/app/src/finance/v2/crosschain.js');
  const record = { provider: 'across', originChainId: 42161, destinationChainId: 4663, depositTxHash: `0x${'d1'.repeat(32)}`, requestId: null, lastState: 'pending' };
  const s = await openNewPosition({ bridge: true, balances: { tokens: { [`4663:${USDG}`]: { balance: 99_563_269n, decimals: 6 } } }, journal: { key: depositJournalKey(4663, S2_OWNER), value: JSON.stringify([record]) } });
  try {
    await typeUsdg(s, '50');
    const card = s.page.locator(`[data-funds-deposit="${record.depositTxHash}"]`);
    await card.waitFor({ timeout: 30_000 });
    // Changed on purpose 2026-10-06 (the integration review): "On the way" only while it is on its way.
    const heading = s.page.locator('[data-funds-deposits] > h4');
    assert.equal(await heading.innerText(), 'On the way');
    // Followed once signed in (the status route is private).
    await s.page.locator('header [aria-haspopup="dialog"]').click();
    await signInFromDialog(s);
    await s.page.locator(`[data-funds-deposit="${record.depositTxHash}"][data-funds-state="filled"]`).waitFor({ timeout: 30_000 });
    await heading.waitFor({ state: 'detached', timeout: 5_000 });
    assert.equal((await card.locator('.dm-subtitle').first().innerText()).trim(), 'Coming from Arbitrum One');
    assert.match(await card.locator('[data-funds-state-text]').innerText(), /Arrived in your wallet on Robinhood Chain\./);
    await card.locator(`[data-funds-balance="${USDG}"]`).waitFor({ timeout: 30_000 });
    assert.match(await card.locator(`[data-funds-balance="${USDG}"]`).innerText(), /99\.563269 USDG/);
    await card.locator(`[data-funds-balance="${USDG}"] input`).check();
    assert.equal((await card.locator('[data-funds-use]').innerText()).trim(), 'Use 99.563269 USDG for this position');
    await card.locator('details > summary').click();
    assert.match(await card.locator('details').innerText(), /Bridge\s+Across/);
    // Its arrival told once: the amount step read its balances again once, not over and over.
    const reads = s.walletReads();
    await s.page.waitForTimeout(2500);
    assert.equal(s.walletReads(), reads, 'no balance read after the one the arrival asked for');
    await capture(s, 'funds-deposit-arrived', `[data-funds-deposit="${record.depositTxHash}"]`);
    // Changed on purpose 2026-10-06 (the integration review: Use left the card, and pressing it again did nothing): the
    // amount is what arrived, and the card is done.
    await card.locator('[data-funds-use="balance"]').click();
    await card.waitFor({ state: 'detached', timeout: 5_000 });
    assert.equal(await s.page.locator('li[data-step="amount"] [data-pair-side="1"] input[inputmode="decimal"]').inputValue(), '99.563269');
  } finally { await s.close(); }
});

test('the send moves the wallet to that network once; what the run says stays on screen with its quote', async () => {
  const s = await openNewPosition({ bridge: true, switching: true, served: arbitrumHoldings() });
  try {
    await s.page.locator('[data-funds-line]').waitFor({ timeout: 30_000 });
    await typeUsdg(s, '50');
    const offer = s.page.locator('[data-funds-offer]');
    await offer.locator('[data-funds-network-holds="42161"]').waitFor({ timeout: 30_000 });
    await offer.locator('[data-funds-network="42161"]').click();
    await signInFromDialog(s);
    const quote = offer.locator('[data-funds-quote]');
    await quote.waitFor({ timeout: 30_000 });
    assert.deepEqual(switches(s), []);
    // Changed on purpose 2026-10-06 (the review: the card and the run's notice vanished while the moved session asked the
    // listing again): from the notice on, the quote card never leaves the page.
    await s.page.evaluate(() => {
      window.__fundsQuoteGone = false;
      new MutationObserver(() => {
        if (document.querySelector('[data-funds-run-notice]')) window.__fundsNoticeSeen = true;
        if (window.__fundsNoticeSeen && !document.querySelector('[data-funds-quote]')) window.__fundsQuoteGone = true;
      }).observe(document.body, { subtree: true, childList: true, attributes: true });
    });
    await quote.locator('[data-funds-deposit-button]').click();
    // The test wallet holds nothing there, so the review on Arbitrum One stops: nothing is sent.
    const notice = offer.locator('[data-funds-run-notice]');
    await notice.waitFor({ timeout: 30_000 });
    await s.page.waitForTimeout(2500);
    assert.equal(await s.page.evaluate(() => window.__fundsQuoteGone), false, 'the card stayed, with its notice');
    assert.equal(await notice.isVisible(), true);
    assert.deepEqual(switches(s), ['0xa4b1'], 'moved to Arbitrum One once, by the send');
    assert.equal(await quote.isVisible(), true, 'the quote stays, its session having moved with the wallet');
    assert.equal(await offer.locator('[data-funds-pick]').count(), 0, 'no pick left waiting');
    await capture(s, 'funds-run-notice');
  } finally { await s.close(); }
});

// Added 2026-10-06 (the review of 2026-10-06: after a deposit, the line named the funds just bridged once more): once a
// deposit is settled, Domino's service is asked again and the line names only what is still there. A deposit this page
// sent holds the line back until then (model.ts holdOffers, tested there: the test wallet never sends); one followed since
// a reload does not, since the balances were read after it left.
test('a deposit followed since a reload: the line names what was read after it left; once it arrived, the balances are read again', async () => {
  const { depositJournalKey } = createRequire(import.meta.url)('../../.test-build/app/src/finance/v2/crosschain.js');
  const record = { provider: 'across', originChainId: 42161, destinationChainId: 4663, depositTxHash: `0x${'d1'.repeat(32)}`, requestId: null, lastState: 'pending' };
  const held = { [ARB_USDC]: 100_000_000n, [ZERO]: 10n ** 16n };
  const reads = arbitrumHoldings(held);
  const balanceReads = () => reads.calls.filter((c) => c.route === 'chain-balances').length;
  const s = await openNewPosition({ bridge: true, served: reads, journal: { key: depositJournalKey(4663, S2_OWNER), value: JSON.stringify([record]) } });
  try {
    await s.page.locator(`[data-funds-deposit="${record.depositTxHash}"]`).waitFor({ timeout: 30_000 });
    const text = s.page.locator('[data-funds-line] .dm-funds-line-text');
    await text.waitFor({ timeout: 30_000 });
    assert.equal((await text.innerText()).trim(), 'You have 100 USDC on Arbitrum One (about $100.00)', 'read after that deposit left');
    // Meanwhile 70 of them were bridged elsewhere; the deposit arrives once the person is signed in (the status route is private).
    held[ARB_USDC] = 30_000_000n;
    const before = balanceReads();
    await s.page.locator('header [aria-haspopup="dialog"]').click();
    await signInFromDialog(s);
    await s.page.locator(`[data-funds-deposit="${record.depositTxHash}"][data-funds-state="filled"]`).waitFor({ timeout: 30_000 });
    await s.page.waitForFunction(() => document.querySelector('[data-funds-line] .dm-funds-line-text')?.textContent?.trim() === 'You have 30 USDC on Arbitrum One (about $30.00)', null, { timeout: 30_000 });
    assert.ok(balanceReads() > before, 'read again once it arrived');
    await capture(s, 'funds-line-after-arrival');
  } finally { await s.close(); }
});

// Added 2026-10-06 (the review: past the automatic new quotes, "The quote expired." had no way out).
test('past its automatic new quotes, an expired quote says so with one button that gets a new one', async () => {
  const s = await openNewPosition({ bridge: true, switching: true, balances: ARB_WALLET, clock: true });
  try {
    await typeUsdg(s, '50');
    const offer = s.page.locator('[data-funds-offer]');
    await offer.locator('[data-funds-network="42161"]').click();
    await signInFromDialog(s);
    await offer.locator('[data-funds-quote] [data-funds-deposit-button]').waitFor({ timeout: 30_000 });
    assert.equal(s.quotes().length, 1);
    // Each deadline (2 minutes, less the margin to send) asks a new one by itself, three times in a row.
    for (let n = 2; n <= 4; n += 1) {
      await s.page.clock.fastForward('01:55');
      for (let i = 0; i < 100 && s.quotes().length < n; i += 1) await s.page.waitForTimeout(100);
      assert.equal(s.quotes().length, n, `new quote ${n - 1} asked by itself`);
      await offer.locator('[data-funds-quote]:not([aria-busy]) [data-funds-deposit-button]').waitFor({ timeout: 30_000 });
    }
    await s.page.clock.fastForward('01:55');
    const expired = offer.locator('[data-funds-quote-expired]');
    await expired.waitFor({ timeout: 30_000 });
    assert.equal(s.quotes().length, 4, 'no more by itself');
    assert.equal(await offer.locator('[data-funds-quote]').count(), 0, 'nothing sendable');
    assert.equal((await expired.locator('[data-funds-renew]').innerText()).trim(), 'Get a new quote');
    await capture(s, 'funds-quote-expired');
    await expired.locator('[data-funds-renew]').click();
    await offer.locator('[data-funds-quote] [data-funds-deposit-button]').waitFor({ timeout: 30_000 });
    assert.equal(s.quotes().length, 5, 'one new quote, for the same amount');
    assert.equal(s.quotes()[4].amountRaw, s.quotes()[0].amountRaw);
  } finally { await s.close(); }
});

// Added 2026-10-06 (the review: a line pick that came to nothing left no way to try again before an amount). Changed on
// purpose 2026-10-06 (the integration review: a beginner who closed the sign-in dialog met three minutes of a box with
// nothing to press, then a red error): while the dialog is open the pick waits with its own "Sign in" button and the line
// stays; once it is closed without signing in, it is said within a moment, calmly, with a "Sign in" that runs the same pick.
test('a sign-in closed without signing: said within a moment and calmly under the line, whose Sign in runs the same pick again', async () => {
  const s = await openNewPosition({ bridge: true, served: arbitrumHoldings() });
  try {
    const line = s.page.locator('[data-funds-line]');
    await line.waitFor({ timeout: 30_000 });
    await line.click();
    const dialog = s.page.locator('[role="dialog"][aria-labelledby="wallet-dialog-title"]');
    await dialog.waitFor();
    // Waiting for the sign-in: one calm line with its own Sign in, and the line itself still there.
    await s.page.locator('[data-funds-pick="signing"]').waitFor({ timeout: 30_000 });
    assert.equal(await s.page.locator('[data-funds-pick-sign-in="signing"]').count(), 1);
    assert.equal(await line.count(), 1, 'the line stays usable');
    await s.page.keyboard.press('Escape');
    await dialog.waitFor({ state: 'detached' });
    // Closed without signing in: said within a moment (the second the dialog has to open, never three minutes), never as an
    // error.
    const said = s.page.locator('[data-funds-pick="failed"][data-error-code="signed_out"]');
    await said.waitFor({ timeout: 5_000 });
    assert.equal((await said.innerText()).trim(), 'Sign in with your wallet to bring funds from another network.');
    assert.equal(await said.getAttribute('class'), 'dm-hint', 'calm: no red');
    assert.equal(await line.isVisible(), true, 'the line is back, to try again');
    assert.equal(await s.page.locator('[data-funds-offer]').count(), 0, 'no box for it');
    assert.equal(s.quotes().length, 0);
    await capture(s, 'funds-line-pick-failed', '.dm-funds-pick-row');
    // Its Sign in runs the same pick: the dialog, the sign-in, then the quote.
    await s.page.locator('[data-funds-pick-sign-in="failed"]').click();
    await signInFromDialog(s);
    await s.page.locator('[data-funds-offer] [data-funds-quote]').waitFor({ timeout: 30_000 });
    assert.equal(await said.count(), 0, 'the new pick took its place');
    assert.deepEqual(s.quotes().map((q) => [q.originChainId, q.originToken]), [[42161, ARB_USDC]], 'the same holding');
  } finally { await s.close(); }
});

// ---- Added 2026-10-06: the integration review (C:/dwt/v2/estudo-2026-10-06/integration-findings.md) -------------------

/** A step held unsettled from an earlier visit (finance/v2/crosschain.ts UnsettledOffer), from `originChainId` to `destinationChainId`. */
const heldStep = (originChainId, kind, destinationChainId = 4663) => ({ originChainId, nonce: '7', kind, quote: `${'ab'.repeat(32)}:1`, provider: 'relay', destinationChainId, at: Math.floor(Date.now() / 1000), state: 'open' });
const heldStore = (...steps) => {
  const { unsettledKey } = createRequire(import.meta.url)('../../.test-build/app/src/finance/v2/crosschain.js');
  return { key: unsettledKey(S2_OWNER), value: JSON.stringify(steps) };
};

// Regressions #2: one approval left unanswered on Base used to hide every way to bring funds, for every position.
test('a step held on one network closes that network alone: the line and the other networks stay, with Other networks', async () => {
  const s = await openNewPosition({ bridge: true, served: arbitrumHoldings(), held: heldStore(heldStep(8453, 'approval')) });
  try {
    await s.page.locator('[data-funds-held="8453"]').waitFor({ timeout: 30_000 });
    const line = s.page.locator('[data-funds-line]');
    await line.waitFor({ timeout: 30_000 });
    assert.equal(await line.getAttribute('data-funds-line'), '42161', 'what Arbitrum One holds, beside the approval held on Base');
    await typeUsdg(s, '50');
    const offer = s.page.locator('[data-funds-offer]');
    await offer.locator('[data-funds-network="42161"]').waitFor({ timeout: 30_000 });
    assert.deepEqual(await offer.locator('[data-funds-network]').evaluateAll((els) => els.map((el) => el.getAttribute('data-funds-network'))), ['42161'], 'Base, held, is not offered');
    assert.equal(await offer.locator('[data-funds-other]').count(), 1, 'Other networks stays');
    assert.equal(await offer.locator('[data-funds-held="8453"]').count(), 1, 'the held approval keeps its card and its way out');
    await capture(s, 'funds-held-one-origin');
  } finally { await s.close(); }
});

test('a deposit held for this network holds every offer back (no second bridge while it may arrive); one held for another network does not', async () => {
  const here = await openNewPosition({ bridge: true, served: arbitrumHoldings(), held: heldStore(heldStep(8453, 'deposit', 4663)) });
  try {
    await here.page.locator('[data-funds-held="8453"]').waitFor({ timeout: 30_000 });
    assert.equal(await here.page.locator('[data-funds-deposits] > h4').innerText(), 'On the way', 'it may arrive here');
    await here.page.waitForTimeout(800);
    assert.equal(await here.page.locator('[data-funds-line]').count(), 0, 'no line while it may arrive');
    await typeUsdg(here, '50');
    await here.page.locator('[data-funds-offer]').waitFor();
    await here.page.waitForTimeout(800);
    assert.equal(await here.page.locator('[data-funds-sources]').count(), 0, 'no networks either');
  } finally { await here.close(); }
  const elsewhere = await openNewPosition({ bridge: true, served: arbitrumHoldings(), held: heldStore(heldStep(8453, 'deposit', 42161)) });
  try {
    await elsewhere.page.locator('[data-funds-held="8453"]').waitFor({ timeout: 30_000 });
    await elsewhere.page.locator('[data-funds-line="42161"]').waitFor({ timeout: 30_000 });
    assert.equal(await elsewhere.page.locator('[data-funds-deposits] > h4').count(), 0, 'not "On the way" here: it goes to another network');
  } finally { await elsewhere.close(); }
});

// Changed on purpose 2026-10-06 (the integration review's second pass: any held step brought "On the way" back above an
// arrived card): only what may still arrive here is on its way; a held approval, where nothing moves, is not.
test('"On the way" only while something may still arrive here: a held approval beside a deposit that arrived leaves no heading', async () => {
  const { depositJournalKey } = createRequire(import.meta.url)('../../.test-build/app/src/finance/v2/crosschain.js');
  const record = { provider: 'across', originChainId: 42161, destinationChainId: 4663, depositTxHash: `0x${'d1'.repeat(32)}`, requestId: null, lastState: 'pending' };
  const s = await openNewPosition({ bridge: true, held: heldStore(heldStep(8453, 'approval')), journal: { key: depositJournalKey(4663, S2_OWNER), value: JSON.stringify([record]) } });
  try {
    const heading = s.page.locator('[data-funds-deposits] > h4');
    await s.page.locator(`[data-funds-deposit="${record.depositTxHash}"]`).waitFor({ timeout: 30_000 });
    await s.page.locator('[data-funds-held="8453"]').waitFor({ timeout: 30_000 });
    assert.equal(await heading.innerText(), 'On the way', 'the deposit is on its way');
    // Followed once signed in (the status route is private): it arrives.
    await s.page.locator('header [aria-haspopup="dialog"]').click();
    await signInFromDialog(s);
    await s.page.locator(`[data-funds-deposit="${record.depositTxHash}"][data-funds-state="filled"]`).waitFor({ timeout: 30_000 });
    await heading.waitFor({ state: 'detached', timeout: 5_000 });
    assert.equal(await s.page.locator('[data-funds-held="8453"]').count(), 1, 'the held approval keeps its card and its way out');
    await capture(s, 'funds-held-approval-arrived', '[data-funds-deposits]');
  } finally { await s.close(); }
});

// Rugged-literal #4 (spec F7 §3.3, "each provider's availability"): Relay's listing busy, so what only Relay bridges (ETH
// on Arbitrum One here) is missing from it; the page says why, once, and nothing while both bridges are listed.
test('a bridge the listing could not list says so: in what a pick came to, and once beside the networks', async () => {
  const s = await openNewPosition({ bridge: true, served: arbitrumHoldings({ [ZERO]: 10n ** 16n }), relayDown: true });
  try {
    const line = s.page.locator('[data-funds-line="42161"]');
    await line.waitFor({ timeout: 30_000 });
    await line.click();
    await signInFromDialog(s);
    const said = s.page.locator('[data-funds-pick="empty"][data-funds-pick-network="42161"]');
    await said.waitFor({ timeout: 30_000 });
    assert.equal((await said.innerText()).trim(), 'Nothing in your wallet on Arbitrum One can be brought here right now. Relay is busy. Try again shortly.');
    assert.equal(s.quotes().length, 0, 'nothing asked of a bridge that does not list it');
    await capture(s, 'funds-provider-busy-line', '.dm-funds-pick-row');
    await typeUsdg(s, '50');
    const offer = s.page.locator('[data-funds-offer]');
    const providers = offer.locator('[data-funds-providers]');
    await providers.waitFor({ timeout: 30_000 });
    assert.equal((await providers.innerText()).trim(), 'Relay is busy. Try again shortly.');
    assert.equal(await providers.count(), 1, 'said once');
    assert.equal(await offer.locator('[data-funds-other]').count(), 1);
    await capture(s, 'funds-provider-busy');
  } finally { await s.close(); }
});

// Integration #2: a range below today's price takes USDG alone ("1 ETH = 1,000,000,000,000 USDG" here). ETH held elsewhere
// is brought as USDG, and ETH that arrives never becomes the amount's token (the range could take none of it).
test('a range that takes USDG alone: the line brings ETH held elsewhere as USDG', async () => {
  const s = await openNewPosition({ bridge: true, served: arbitrumHoldings({ [ZERO]: 10n ** 17n }), range: ['500000000000', '900000000000'] });
  try {
    const line = s.page.locator('[data-funds-line="42161"]');
    await line.waitFor({ timeout: 30_000 });
    assert.equal(await line.getAttribute('data-funds-line-token'), ZERO);
    assert.equal(await line.getAttribute('data-funds-line-target'), USDG, 'the token the range takes, never ETH');
    assert.equal((await line.locator('.dm-funds-line-text').innerText()).trim(), 'You have 0.0995 ETH on Arbitrum One', 'what can be sent: the gas Review keeps stays');
    await line.click();
    await signInFromDialog(s);
    await s.page.locator('[data-funds-offer] [data-funds-quote] [data-funds-deposit-button]').waitFor({ timeout: 30_000 });
    assert.deepEqual(s.quotes().map((q) => [q.originChainId, q.originToken, q.destinationToken, q.amountRaw]), [[42161, ZERO, USDG, '99500000000000000']]);
    await capture(s, 'funds-takes-only-quote');
  } finally { await s.close(); }
});

test('a range that takes USDG alone: ETH that arrived is never made the amount token; a hint says to enter the amount in USDG', async () => {
  const { depositJournalKey } = createRequire(import.meta.url)('../../.test-build/app/src/finance/v2/crosschain.js');
  const record = { provider: 'across', originChainId: 42161, destinationChainId: 4663, depositTxHash: `0x${'d1'.repeat(32)}`, requestId: null, lastState: 'pending' };
  const s = await openNewPosition({
    bridge: true,
    range: ['500000000000', '900000000000'],
    balances: { native: { 4663: 10n ** 16n }, tokens: { [`4663:${USDG}`]: { balance: 0n, decimals: 6 } } },
    journal: { key: depositJournalKey(4663, S2_OWNER), value: JSON.stringify([record]) },
  });
  try {
    await typeUsdg(s, '50');
    const card = s.page.locator(`[data-funds-deposit="${record.depositTxHash}"]`);
    await card.waitFor({ timeout: 30_000 });
    await s.page.locator('header [aria-haspopup="dialog"]').click();
    await signInFromDialog(s);
    await s.page.locator(`[data-funds-deposit="${record.depositTxHash}"][data-funds-state="filled"]`).waitFor({ timeout: 30_000 });
    // After a reload the journal does not say which token arrived: the person picks ETH, the one there is something of.
    await card.locator(`[data-funds-balance="${ZERO}"] input`).check({ timeout: 30_000 });
    const hint = card.locator('[data-funds-takes-only]');
    await hint.waitFor({ timeout: 5_000 });
    assert.equal((await hint.innerText()).trim(), 'Enter the amount in USDG above: Domino swaps what arrived for it.');
    assert.equal(await card.locator('[data-funds-use]').count(), 0, 'no Use for a token the range takes none of');
    await capture(s, 'funds-takes-only-arrived', `[data-funds-deposit="${record.depositTxHash}"]`);
  } finally { await s.close(); }
});

// ---------------------------------------------------------------------------------------------------------------------
// Added 2026-10-06 (rugged's answer of 6 Oct: the owner revoked decision #15; F7 delta of 6 Oct §1 and §2): the quote card
// shows Domino's fee in full and the network fee; Bring sends the exact approval and the deposit as ONE batch where the
// wallet batches on the origin, else the two transactions of before; a batch kept from an earlier visit is followed.
// ---------------------------------------------------------------------------------------------------------------------

/** The fake origin's first and second transaction hashes (../support/s2-origin-chain.mjs). */
const HASH_OF = (i) => `0x${(0xa0 + i).toString(16).padStart(64, '0')}`;
const DEPOSITORY_ARB = '0x4cd00e387622c35bddb9b4c962c136462338bc31';
/** Waits, a little at a time, until `check` holds (a fake's own state, outside the page). */
const until = async (check, ms = 30_000) => {
  for (const end = Date.now() + ms; !check() && Date.now() < end; ) await new Promise((done) => setTimeout(done, 100));
  assert.ok(check(), 'in time');
};
/** 0.01 ETH on Arbitrum One for the network fees there, as the wallet reads it. */
const ARB_GAS = { native: { 42161: 10n ** 16n } };

/** To the quote card for USDG lacking on Robinhood Chain, from the USDC Domino's service read on Arbitrum One. */
async function toQuote(s) {
  await s.page.locator('[data-funds-line]').waitFor({ timeout: 30_000 });
  await typeUsdg(s, '50');
  const offer = s.page.locator('[data-funds-offer]');
  await offer.locator('[data-funds-network-holds="42161"]').waitFor({ timeout: 30_000 });
  await offer.locator('[data-funds-network="42161"]').click();
  await signInFromDialog(s);
  const quote = offer.locator('[data-funds-quote]');
  await quote.waitFor({ timeout: 30_000 });
  return { offer, quote };
}

test('the quote card keeps Domino’s fee in full and the network fee in view; Bring is ONE confirmation where the wallet batches on Arbitrum One', async () => {
  const origin = createOriginChain({ owner: S2_OWNER, chainId: 42161, atomic: 'ready', mine: 'manual' });
  const s = await openNewPosition({ bridge: true, switching: true, balances: ARB_GAS, served: arbitrumHoldings(), sendOn: origin });
  try {
    const { offer, quote } = await toQuote(s);
    // In view, not only in Details: the fee's amount, token, chain and where it is charged; the gas on the origin.
    assert.equal((await quote.locator('[data-funds-domino-fee]').innerText()).trim(), 'Domino fee (0.35%): 0.1785 USDC, charged by Relay on Arbitrum One · you can also bridge with any other service');
    assert.equal((await quote.locator('[data-funds-network-fee]').innerText()).trim(), 'Network fee on Arbitrum One: about 0.000001 ETH, estimated by Relay');
    assert.equal(await quote.locator('[data-funds-network-fee]').getAttribute('title'), 'Network fee on Arbitrum One: about 0.000001692667911 ETH, estimated by Relay', 'exact in its title');
    assert.equal(await quote.locator('[data-funds-domino-fee]').isVisible(), true);
    assert.equal(await quote.locator('[data-funds-network-fee]').isVisible(), true);
    assert.equal(await quote.locator('[data-funds-quote-details]').getAttribute('open'), null, 'with Details closed');
    await capture(s, 'funds-quote-fees');
    // Bring: the wallet moves to Arbitrum One, then ONE confirmation for the approval and the deposit.
    origin.state.nextBatch = 'wait';
    await quote.locator('[data-funds-deposit-button]').click();
    await s.page.waitForFunction(() => document.querySelector('[data-funds-quote] [data-funds-run-status]')?.textContent?.trim() === 'Approval and deposit in one confirmation · confirm in your wallet', null, { timeout: 30_000 });
    await capture(s, 'funds-batch-confirm');
    // The wallet's prompt is open: the batch reached it; the person confirms.
    await until(() => origin.state.answerBatch !== null);
    origin.answerBatch();
    await s.page.waitForFunction(() => document.querySelector('[data-funds-quote] [data-funds-run-status]')?.textContent?.trim() === 'Approval and deposit in one confirmation · waiting to be included…', null, { timeout: 30_000 });
    // The batch: atomic required, on Arbitrum One, the exact approval and the deposit exactly as quoted.
    const [batch] = origin.state.batches;
    const asked = s.quotes().at(-1);
    const { steps } = quoteFor(asked, S2_OWNER).quote;
    assert.deepEqual([batch.version, batch.atomicRequired, batch.chainId, batch.from], ['2.0.0', true, '0xa4b1', S2_OWNER]);
    assert.deepEqual(batch.calls, steps.map((step) => ({ to: step.transaction.to, data: step.transaction.data, value: '0x0' })));
    assert.deepEqual([batch.calls[0].to, batch.calls[1].to], [ARB_USDC, DEPOSITORY_ARB]);
    assert.equal(s.wallet.calls('eth_sendTransaction').length, 0, 'no transaction of its own');
    assert.deepEqual(switches(s), ['0xa4b1'], 'the wallet moved to Arbitrum One once, to send');
    // Kept until the wallet names its transaction (in this browser, for a reload).
    const { batchJournalKey, depositJournalKey } = createRequire(import.meta.url)('../../.test-build/app/src/finance/v2/crosschain.js');
    const keptBatch = JSON.parse(await s.page.evaluate((key) => localStorage.getItem(key), batchJournalKey(S2_OWNER)));
    assert.deepEqual(keptBatch.map((e) => [e.originChainId, e.destinationChainId, e.provider, e.batchId]), [[42161, 4663, 'relay', 'batch-1']]);
    // Mined: the deposit's transaction is the batch's one transaction; the deposit is followed from it.
    origin.include(HASH_OF(0));
    const card = s.page.locator(`[data-funds-deposit="${HASH_OF(0)}"]`);
    await card.waitFor({ timeout: 30_000 });
    assert.equal((await card.locator('.dm-subtitle').first().innerText()).trim(), 'Coming from Arbitrum One');
    const kept = JSON.parse(await s.page.evaluate((key) => localStorage.getItem(key), depositJournalKey(4663, S2_OWNER)));
    assert.deepEqual(kept.map((r) => [r.provider, r.originChainId, r.depositTxHash, r.requestId !== null]), [['relay', 42161, HASH_OF(0), true]]);
    assert.equal(await s.page.evaluate((key) => localStorage.getItem(key), batchJournalKey(S2_OWNER)), null, 'the batch kept until then is gone');
    await card.locator('details > summary').click();
    // Its receipt read on Arbitrum One for the review it came from: included (Details: "On Arbitrum One").
    await s.page.waitForFunction((hash) => /On Arbitrum One\s*(Included|Finalized)/.test(document.querySelector(`[data-funds-deposit="${hash}"] details`)?.textContent ?? ''), HASH_OF(0), { timeout: 30_000 });
    assert.equal(await offer.locator('[data-funds-quote]').count(), 0, 'the quote is done');
    await capture(s, 'funds-batch-sent', `[data-funds-deposit="${HASH_OF(0)}"]`);
  } finally { await s.close(); }
});

test('a wallet that does not batch on Arbitrum One: the exact approval, then the deposit, two confirmations as before', async () => {
  const origin = createOriginChain({ owner: S2_OWNER, chainId: 42161 });
  const s = await openNewPosition({ bridge: true, switching: true, balances: ARB_GAS, served: arbitrumHoldings(), sendOn: origin });
  try {
    const { quote } = await toQuote(s);
    await quote.locator('[data-funds-deposit-button]').click();
    const card = s.page.locator(`[data-funds-deposit="${HASH_OF(1)}"]`);
    await card.waitFor({ timeout: 30_000 });
    assert.deepEqual(origin.state.sent.map((tx) => [tx.to, tx.chainId]), [[ARB_USDC, '0xa4b1'], [DEPOSITORY_ARB, '0xa4b1']], 'the approval, then the deposit');
    assert.deepEqual(origin.state.batches, [], 'never a batch');
    assert.equal(s.wallet.calls('wallet_getCapabilities').filter((entry) => entry.chainId === 42161).length, 1, 'what the wallet can batch there, asked once');
    assert.equal((await card.locator('.dm-subtitle').first().innerText()).trim(), 'Coming from Arbitrum One');
  } finally { await s.close(); }
});

test('the allowance already covers the amount on Arbitrum One: the deposit alone, one transaction, the wallet’s batching not even asked', async () => {
  const origin = createOriginChain({ owner: S2_OWNER, chainId: 42161, atomic: 'supported' });
  origin.state.allowances.set(`${ARB_USDC}|${S2_OWNER}|${DEPOSITORY_ARB}`, 10n ** 12n);
  const s = await openNewPosition({ bridge: true, switching: true, balances: ARB_GAS, served: arbitrumHoldings(), sendOn: origin });
  try {
    const { quote } = await toQuote(s);
    await quote.locator('[data-funds-deposit-button]').click();
    await s.page.locator(`[data-funds-deposit="${HASH_OF(0)}"]`).waitFor({ timeout: 30_000 });
    assert.deepEqual(origin.state.sent.map((tx) => tx.to), [DEPOSITORY_ARB], 'one transaction');
    assert.deepEqual(origin.state.batches, []);
    assert.equal(s.wallet.calls('wallet_getCapabilities').filter((entry) => entry.chainId === 42161).length, 0);
  } finally { await s.close(); }
});

test('a deposit sent as one batch on an earlier visit: followed once the wallet names its transaction, from whichever network the wallet is on', async () => {
  const { batchJournalKey } = createRequire(import.meta.url)('../../.test-build/app/src/finance/v2/crosschain.js');
  const origin = createOriginChain({ owner: S2_OWNER, chainId: 42161, atomic: 'supported', mine: 'manual' });
  // The batch the wallet took on the earlier visit, still not on chain.
  const { id } = await origin.wallet.request('wallet_sendCalls', [{ version: '2.0.0', chainId: '0xa4b1', from: S2_OWNER, atomicRequired: true, calls: [{ to: DEPOSITORY_ARB, data: '0xe8017952', value: '0x0' }] }]);
  const entry = { originChainId: 42161, destinationChainId: 4663, provider: 'relay', requestId: `0x${'17'.repeat(32)}`, batchId: id, quote: `${'ab'.repeat(32)}:1`, at: Math.floor(Date.now() / 1000) };
  const s = await openNewPosition({ bridge: true, sendOn: origin, batches: { key: batchJournalKey(S2_OWNER), value: JSON.stringify([entry]) } });
  try {
    const pending = s.page.locator('[data-funds-pending-batch="42161"]');
    await pending.waitFor({ timeout: 30_000 });
    assert.equal((await pending.locator('.dm-subtitle').innerText()).trim(), 'Coming from Arbitrum One');
    assert.equal((await pending.locator('[data-funds-state-text]').innerText()).trim(), 'Sent, waiting to be included…');
    assert.equal(await s.page.locator('[data-funds-deposits] > h4').innerText(), 'On the way');
    assert.equal(await s.page.locator('[data-funds-line]').count(), 0, 'nothing more offered while it may arrive');
    await capture(s, 'funds-batch-pending', '[data-funds-pending-batch]');
    // Its status asked through the wallet on Robinhood Chain, where the wallet is: the id names no network.
    assert.ok(s.wallet.calls('wallet_getCallsStatus').every((entry) => entry.chainId === 4663));
    origin.include(HASH_OF(0));
    const card = s.page.locator(`[data-funds-deposit="${HASH_OF(0)}"]`);
    await card.waitFor({ timeout: 30_000 });
    await pending.waitFor({ state: 'detached', timeout: 10_000 });
    assert.equal(await s.page.evaluate((key) => localStorage.getItem(key), batchJournalKey(S2_OWNER)), null, 'the batch kept until then is gone');
    assert.deepEqual(switches(s), [], 'the wallet never moved');
  } finally { await s.close(); }
});

// ---- Added 2026-10-06: Ethereum and OP Mainnet (rugged97's #379, read-v6 1.1.0-rc.1: chain-balances reads them when a
// request names them; rollout reader, then Worker, then app). Domino's service reads them in a request of their own, beside
// Domino's three, and what is held there joins the line, the networks, the sizing and the quote as any of Domino's networks'.

const USDC_1 = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
const WETH_1 = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2';
/** 100 USDC and 0.01 ETH (for the approval's and the deposit's gas) on Ethereum, as Domino's service reads them. */
const ethereumHoldings = (balances = { [USDC_1]: 100_000_000n, [ZERO]: 10n ** 16n }) => createChainReads({
  chainId: 1,
  tokens: [{ address: ZERO, symbol: 'ETH', decimals: 18 }, { address: WETH_1, symbol: 'WETH', decimals: 18 }, { address: USDC_1, symbol: 'USDC', name: 'USD Coin', decimals: 6 }],
  balances,
});
/** The two requests the offer makes: Domino's three (the destination last), and Ethereum and OP Mainnet on their own. */
const DOMINO_ASKED = '8453,42161,4663';
const ELSEWHERE_ASKED = BALANCE_CHAIN_IDS.join();

/** The page at a desktop's width and a phone's (1280 and 390), with no sideways scroll at either; then back. */
async function bothWidths(page, name) {
  const dir = resolve(import.meta.dirname, '../../.test-artifacts');
  mkdirSync(dir, { recursive: true });
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.waitForTimeout(150);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), true, `${name}: no horizontal scroll at ${width}`);
    await page.screenshot({ path: resolve(dir, `${name}-${width}.png`), fullPage: true });
  }
  await page.setViewportSize({ width: 1320, height: 1100 });
}

test('USDC on Ethereum, read in a request of its own, is the discreet line; one click quotes it from Ethereum, the wallet staying where it is', async () => {
  const reads = ethereumHoldings();
  const s = await openNewPosition({ bridge: true, served: reads });
  try {
    const line = s.page.locator('[data-funds-line]');
    await line.waitFor({ timeout: 30_000 });
    assert.equal(await s.page.locator('[data-funds-line]').count(), 1, 'one line');
    assert.equal(await line.getAttribute('data-funds-line'), '1');
    assert.equal(await line.getAttribute('data-funds-line-token'), USDC_1);
    assert.equal(await line.getAttribute('data-funds-line-target'), USDG, 'a dollar, brought as USDG');
    assert.equal((await line.locator('.dm-funds-line-text').innerText()).trim(), 'You have 100 USDC on Ethereum (about $100.00)');
    assert.equal((await line.locator('.dm-funds-line-action').innerText()).trim(), 'Bring it here');
    assert.equal(await line.locator('[data-token-mark="unknown"]').count(), 1, 'a calm disc: no bundled USDC, nothing fetched');
    // Two requests: Domino's three exactly as before, and Ethereum and OP Mainnet on their own; never one naming both.
    const asked = askedNetworks(reads);
    assert.ok(asked.some((ids) => ids.join() === DOMINO_ASKED), 'Domino\'s three, as before');
    assert.ok(asked.some((ids) => ids.join() === ELSEWHERE_ASKED), 'Ethereum and OP Mainnet on their own');
    assert.ok(asked.every((ids) => [DOMINO_ASKED, ELSEWHERE_ASKED].includes(ids.join())), `never one naming both: ${JSON.stringify(asked)}`);
    assert.equal(s.bridgeCalls.length, 0, 'no sign-in, no quote before the click');
    await bothWidths(s.page, 'funds-line-ethereum');
    await line.click();
    await signInFromDialog(s);
    const quote = s.page.locator('[data-funds-offer] [data-funds-quote]');
    await quote.locator('[data-funds-deposit-button]').waitFor({ timeout: 30_000 });
    // The bring quote asks origin chain 1: all of it (before an amount, the owner's default), brought as USDG.
    assert.deepEqual(s.quotes().map((q) => [q.originChainId, q.originToken, q.amountRaw, q.destinationChainId, q.destinationToken]), [[1, USDC_1, '100000000', 4663, USDG]]);
    assert.equal((await quote.locator('[data-funds-deposit-button]').innerText()).trim(), 'Bring 100 USDC from Ethereum');
    assert.equal((await s.page.locator('[data-funds-title]').innerText()).trim(), 'Bring funds from Ethereum');
    assert.deepEqual(switches(s), [], 'the wallet stays on Robinhood Chain for the quote');
    assert.ok(askedNetworks(reads).filter((ids) => ids.join() === ELSEWHERE_ASKED).length >= 2, 'Ethereum read again for the choice');
    await bothWidths(s.page, 'funds-line-ethereum-quote');
  } finally { await s.close(); }
});

test('after an amount, Ethereum has its button where the service read something there; one click quotes what the position lacks from it', async () => {
  const reads = ethereumHoldings();
  const s = await openNewPosition({ bridge: true, served: reads });
  try {
    await s.page.locator('[data-funds-line="1"]').waitFor({ timeout: 30_000 });
    await typeUsdg(s, '50');
    const offer = s.page.locator('[data-funds-offer]');
    const holds = offer.locator('[data-funds-network-holds="1"]');
    await holds.waitFor({ timeout: 30_000 });
    // Domino's networks first (not read by the service here: their buttons stay, nothing said), then Ethereum; OP Mainnet,
    // not read, has none.
    assert.deepEqual(await offer.locator('[data-funds-network]').evaluateAll((els) => els.map((el) => [el.getAttribute('data-funds-network'), el.textContent.trim(), el.getAttribute('data-funds-holds')])), [['8453', 'Base', 'unread'], ['42161', 'Arbitrum One', 'unread'], ['1', 'Ethereum', 'holds']]);
    // Changed on purpose 2026-10-06 (the review of rugged97's #379): its ETH less Ethereum's own gas (0.003 ETH kept there).
    assert.match((await holds.innerText()).trim(), /^You have 0\.007 ETH · 100 USDC \(about \$\d+\.\d{2}\)$/, 'what can be sent there, valued');
    assert.equal(await offer.locator('[data-funds-other]').count(), 1, 'Other networks stays');
    await bothWidths(s.page, 'funds-networks-ethereum');
    await offer.locator('[data-funds-network="1"]').click();
    await signInFromDialog(s);
    const quote = offer.locator('[data-funds-quote]');
    await quote.locator('[data-funds-deposit-button]').waitFor({ timeout: 30_000 });
    // 50 USDG lacking, sent as USDC from Ethereum: 50 plus room for the fees, as from any network.
    assert.deepEqual(s.quotes().map((q) => [q.originChainId, q.originToken, q.amountRaw, q.destinationToken]), [[1, USDC_1, '51000000', USDG]]);
    assert.equal((await quote.locator('[data-funds-deposit-button]').innerText()).trim(), 'Bring 51 USDC from Ethereum');
    assert.deepEqual(switches(s), [], 'the wallet stays on Robinhood Chain for the quote');
  } finally { await s.close(); }
});

// Added 2026-10-06 (the review of rugged97's #379: before an amount, a one click from Ethereum with its own ETH quoted the
// whole balance less the gas Review keeps, which is sized to the rollups' gas, so the deposit could not pay Ethereum's):
// Ethereum's ETH keeps Ethereum's own gas, 0.003 ETH, in the line, its value and the quote.
test('ETH on Ethereum keeps Ethereum\'s own gas: the line and its one click bring the balance less 0.003 ETH', async () => {
  const s = await openNewPosition({ bridge: true, served: ethereumHoldings({ [ZERO]: 10n ** 17n }), range: ['500000000000', '900000000000'] });
  try {
    const line = s.page.locator('[data-funds-line="1"]');
    await line.waitFor({ timeout: 30_000 });
    assert.equal(await line.getAttribute('data-funds-line-token'), ZERO);
    assert.match((await line.locator('.dm-funds-line-text').innerText()).trim(), /^You have 0\.097 ETH on Ethereum \(about \$[\d,]+\.\d{2}\)$/, 'what can be sent: Ethereum\'s gas stays there');
    await line.click();
    await signInFromDialog(s);
    await s.page.locator('[data-funds-offer] [data-funds-quote] [data-funds-deposit-button]').waitFor({ timeout: 30_000 });
    assert.deepEqual(s.quotes().map((q) => [q.originChainId, q.originToken, q.destinationToken, q.amountRaw]), [[1, ZERO, USDG, '97000000000000000']], 'the balance less 0.003 ETH');
    assert.deepEqual(switches(s), [], 'the wallet stays on Robinhood Chain for the quote');
  } finally { await s.close(); }
});

// A Worker that has not taken its rollout step yet refuses a request naming Ethereum or OP Mainnet (422 invalid_request, as
// bridge/src/worker.mjs answers a request its contract refuses): Domino's three are read, drawn and brought from exactly as
// before, and the two simply stay unread (nothing said of them; Other networks as before).
test('a Worker that still refuses Ethereum and OP Mainnet: Domino\'s three exactly as before, the two unread and unsaid', async () => {
  const arbitrum = arbitrumHoldings();
  const refused = [];
  const served = {
    calls: arbitrum.calls,
    answer(route, request) {
      if (route === 'chain-balances' && request.tokens?.some((t) => BALANCE_CHAIN_IDS.includes(t.chainId))) {
        refused.push(request);
        return { status: 422, body: { error: 'invalid_request' } };
      }
      return arbitrum.answer(route, request);
    },
  };
  const s = await openNewPosition({ bridge: true, served });
  try {
    const line = s.page.locator('[data-funds-line]');
    await line.waitFor({ timeout: 30_000 });
    assert.equal((await line.locator('.dm-funds-line-text').innerText()).trim(), 'You have 100 USDC on Arbitrum One (about $100.00)', 'the line as before');
    assert.ok(refused.length >= 1, 'Ethereum and OP Mainnet were asked, and refused');
    assert.deepEqual(dominoRead(arbitrum).request.tokens.map((t) => t.chainId), [8453, 8453, 8453, 42161, 42161, 42161, 4663, 4663, 4663], 'Domino\'s request as before');
    await typeUsdg(s, '50');
    const offer = s.page.locator('[data-funds-offer]');
    await offer.locator('[data-funds-network-holds="42161"]').waitFor({ timeout: 30_000 });
    assert.deepEqual(await offer.locator('[data-funds-network]').evaluateAll((els) => els.map((el) => el.getAttribute('data-funds-network'))), ['8453', '42161'], 'no button for a network not read');
    assert.equal(await offer.getByText(/Ethereum|OP Mainnet/).count(), 0, 'nothing said of them');
    assert.equal(await offer.locator('[data-funds-other]').count(), 1, 'Other networks, as before');
    await offer.locator('[data-funds-network="42161"]').click();
    await signInFromDialog(s);
    await offer.locator('[data-funds-quote] [data-funds-deposit-button]').waitFor({ timeout: 30_000 });
    assert.deepEqual(s.quotes().map((q) => [q.originChainId, q.originToken, q.amountRaw]), [[42161, ARB_USDC, '51000000']], 'brought from Arbitrum One as before');
  } finally { await s.close(); }
});
