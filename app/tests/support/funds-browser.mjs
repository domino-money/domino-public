/** Shared browser harness for funding arrival and recovery: controlled read/session/wallet fixtures only. */
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { WALLET_V2_DIST } from '../support/wallet-dist.mjs';

const APP = resolve(import.meta.dirname, '../..');
if (!existsSync(join(WALLET_V2_DIST, 'index.html'))) throw new Error('.wallet-test-v2-dist is missing. Run npm run build:wallet-test-v2 first (npm run test:v2in does).');
// The server takes the production CSP from the compiled middleware (the unit build, as every browser suite needs).
if (!existsSync(resolve(APP, '.test-build/app/functions/_middleware.js'))) throw new Error('Build the unit bundle before recovery tests.');
const { routeChain } = await import('../support/browser-chain.mjs');
const { createFakeSession } = await import('../support/fake-session.mjs');
const { ARTWORK, press, pressContinue } = await import('../support/new-position.mjs');
const { FIXTURE_TOKEN, createReadStub } = await import('../support/read-stub.mjs');
const { installS2Wallet, S2_ACCOUNT, S2_OWNER } = await import('../support/s2-wallet.mjs');
const { createWalletServer } = await import('../support/wallet-server.mjs');
const { createChainReads } = await import('../support/chain-reads.mjs');
const { contractsFor } = await import('../support/v2-chain.mjs');
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
export async function openFundingPage(browser, { gateOpen = true, ethWei = 0n, balances = {}, bridge = false, switching = false, served = null, journal = null, clock = false, range = null, relayDown = false, held = null, sendOn = null, batches = null, intent = null, statusReply = null, walletAssetsReply = null, readReply = null, quoteReply = null, localLive = false, searchToken = USDG, poolKey = null } = {}) {
  const fake = createFakeSession();
  const errors = [];
  // The read stub's own fixture for each read (tests/support/read-stub.mjs), TOKEN as USDG, and the wallet's balances.
  const read = createReadStub({
    answer: (route, body) => readReply?.(route, body) ?? (
      route === 'wallet-assets'
        ? walletAssetsReply?.() ?? walletAssets(ethWei)
        : asUsdg({ 'pool-market': 'pool-market.not-requested', token: body.token === ZERO ? 'token.native' : 'token.success' }[route] ?? `${route}.success`)),
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
    if (route === 'quote') {
      // ETH for USDG: at a price, through Relay alone (Added 2026-10-06).
      const crossKind = body.originToken === ZERO && body.destinationToken === USDG ? { rate: ETH_AS_USDG, relayOnly: true } : {};
      const reply = () => quoteFor(body, S2_OWNER, body.destinationGas ? 'variants/quote.destination-gas' : body.amountRaw === NO_ROUTE_RAW ? 'variants/quote.none' : 'responses/quote', crossKind);
      return Response.json(quoteReply ? await quoteReply(body, reply) : reply(), { headers });
    }
    // A deposit sent here (Added 2026-10-06): Relay has not seen it yet, about the very deposit asked.
    if (route === 'status' && statusReply) return Response.json(await statusReply(body), { headers });
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
    return said ? Response.json(said.body, { status: said.status, headers: { ...readV6, ...said.headers } }) : Response.json({ error: 'route_not_available' }, { status: 404, headers: readV6 });
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
  if (intent) await context.addInitScript(({ key, value }) => { if (localStorage.getItem(key) === null) localStorage.setItem(key, value); }, intent);
  if (journal) await context.addInitScript(({ key, value }) => { if (localStorage.getItem(key) === null) localStorage.setItem(key, value); }, journal);
  // Steps held unsettled on an earlier visit (finance/v2/crosschain.ts's store, in localStorage).
  if (held) await context.addInitScript(({ key, value }) => { if (localStorage.getItem(key) === null) localStorage.setItem(key, value); }, held);
  // Deposits sent as one batch on an earlier visit (finance/v2/crosschain.ts's store, in localStorage).
  if (batches) await context.addInitScript(({ key, value }) => { if (localStorage.getItem(key) === null) localStorage.setItem(key, value); }, batches);
  // The gate's test-build hook (src/v2/gate.ts): opens V2 options on this server's origin; S2 is then `preview` here.
  if (gateOpen) {
    if (localLive && served) await context.exposeFunction('__fundingChainRead', (request) => served.answer('chain-balances', request));
    await context.addInitScript(({ contracts, reads }) => {
      window.__dominoV2Test = { originOpen: true, ...(contracts ? { backendOn: true, contracts: { 4663: contracts } } : {}),
        ...(reads ? { read6: { 'chain-balances': (request) => window.__fundingChainRead(request) } } : {}) };
    }, { contracts: localLive ? contractsFor(4663) : null, reads: localLive && served !== null });
  }
  const page = await context.newPage();
  page.on('pageerror', (error) => errors.push(error.message));
  const s = {
    page,
    wallet,
    context,
    bridgeCalls, origin,
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
    await page.getByRole('combobox', { name: 'Search a token' }).fill(searchToken);
    await page.locator(`[data-token-option="${searchToken}"]`).click();
    await (poolKey ? page.locator(`[data-picker="pool"] [data-pool-key="${poolKey}"] input[name="pool-option"]`) : page.locator('[data-picker="pool"] input[name="pool-option"]').first()).click({ timeout: 30_000 });
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

const signIn = async (s) => {
  if (!await s.page.locator('[role="dialog"][aria-labelledby="wallet-dialog-title"]').count()) await s.page.locator('header [aria-haspopup="dialog"]').click();
  await s.page.locator('[role="dialog"][aria-labelledby="wallet-dialog-title"]').getByRole('button', { name: 'Sign in', exact: true }).click();
  await s.page.waitForFunction(() => window.__dominoSessionProbe.view().status === 'signed_in');
  await s.page.keyboard.press('Escape');
};
const ARB_USDC = '0xaf88d065e77c8cc2239327c5edb3a432268e5831';
const BASE_USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
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


export { USDG, ZERO, S2_OWNER, ARB_USDC, BASE_USDC, RECORDED_DEPOSIT, awaitingFor, recorded, createChainReads, walletAssets, typeUsdg, signIn, homeReads, chainReads, together, offerReady };
