import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { readFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright-core';
import { createFakeSession } from './support/fake-session.mjs';
import { createWalletServer } from './support/wallet-server.mjs';
import { ACCOUNTS, installWallets } from './support/mock-wallet.mjs';
import * as runtime from '../../api-contracts/performance-v2/runtime.mjs';

let browser;
before(async () => {
  for (const options of process.env.DOMINO_BROWSER_PATH ? [{ executablePath: process.env.DOMINO_BROWSER_PATH }] : [{ channel: 'chrome' }, { channel: 'chromium' }, {}]) {
    try { browser = await chromium.launch({ ...options, headless: true }); break; } catch {}
  }
  if (!browser) throw new Error('A Chromium browser is required.');
});
after(async () => { await browser?.close(); });
const fixture = path => JSON.parse(readFileSync(new URL(`../../api-contracts/performance-v2/fixtures/${path}.json`, import.meta.url)));
async function scenario() {
  const fake = createFakeSession(); fake.admit(ACCOUNTS[0].address);
  const calls = [], errors = [];
  let mode = 'available';
  const server = createWalletServer({ fake, dist: resolve(import.meta.dirname, '../.wallet-test-dist'), routes: [async (request, url) => {
    if (!url.pathname.startsWith('/api/performance/v2/')) return;
    calls.push(url.pathname);
    assert.ok(request.headers.get('cookie')?.includes('__Host-domino-session=')); assert.ok(request.headers.get('X-Domino-CSRF'));
    const route = url.pathname.split('/').at(-1);
    const value = route === 'epochs' ? fixture('responses/epochs') : fixture(mode === 'available' ? 'responses/cards' : 'variants/stale');
    value.owner = ACCOUNTS[0].address.toLowerCase();
    assert.ok(runtime.validateResponse(route, value));
    return new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json', 'X-Domino-Performance-Contract': runtime.CONTRACT_VERSION } });
  }] });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  const origin = `http://127.0.0.1:${server.address().port}`; fake.origin = origin;
  const context = await browser.newContext({ viewport: { width: 1320, height: 1000 } });
  await context.route(/^https:\/\/fonts\.(googleapis|gstatic)\.com\//, route => route.fulfill({ status: 200, contentType: 'text/css', body: '' }));
  const wallet = await installWallets(context);
  const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
  await page.goto(`${origin}/#/app`);
  return { page, calls, wallet, context, mode(value) { mode = value; }, async close() {
    await context.close(); await server.closeAll(); assert.deepEqual(errors, []); assert.deepEqual(wallet.state.csp, []); assert.deepEqual(wallet.state.refused, []);
  } };
}
async function login(page) {
  await page.waitForFunction(() => window.__dominoSessionProbe?.view().status === 'no_wallet');
  await page.locator('header [aria-haspopup="dialog"]').click();
  const dialog = page.locator('[role="dialog"][aria-labelledby="wallet-dialog-title"]');
  await dialog.getByRole('button', { name: 'Connect Test Wallet A', exact: true }).click();
  await page.waitForFunction(() => window.__dominoSessionProbe?.view().status === 'signed_out');
  await dialog.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.waitForFunction(() => window.__dominoSessionProbe?.view().status === 'signed_in');
  await page.keyboard.press('Escape');
}
test('private history renders exact producer amounts only after login and disappears on account change', async () => {
  const s = await scenario();
  try {
    await s.page.getByText('Sign in with your wallet to view private history.', { exact: true }).waitFor(); assert.equal(s.calls.length, 0);
    await login(s.page);
    await s.page.getByText('$9', { exact: true }).waitFor();
    assert.equal(s.calls.length, 2); assert.equal(s.wallet.state.signed.length, 1);
    const screenshots = resolve(import.meta.dirname, '../.test-artifacts'); mkdirSync(screenshots, { recursive: true });
    await s.page.screenshot({ path: join(screenshots, 'p2-private-history.png'), fullPage: true });
    await s.wallet.switchAccount('a', 1);
    await s.page.getByText('$9', { exact: true }).waitFor({ state: 'hidden' });
    assert.equal(s.calls.length, 2);
  } finally { await s.close(); }
});
test('setup asks for sign-in and makes no deposit request or wallet transaction by merely opening the screen', async () => {
  const s = await scenario(); const depositCalls = [];
  s.page.on('request', request => { if (request.url().includes('/api/deposit/')) depositCalls.push(request.url()); });
  try {
    await s.page.goto(`${s.page.url().split('/#')[0]}/#/setup`);
    await s.page.getByText('Sign in with your wallet to prepare a deposit or view its receipts.', { exact: true }).waitFor();
    assert.deepEqual(depositCalls, []); assert.equal(s.wallet.state.signed.length, 0); assert.deepEqual(s.wallet.state.refused, []);
  } finally { await s.close(); }
});

test('sequence is reachable from dashboard and requests no signature, approval or transaction before review', async () => {
  const s = await scenario();
  try {
    await s.page.getByRole('link', {name:'Create or manage a sequence'}).click();
    await s.page.getByRole('heading', {name:'Your sequences',exact:true}).waitFor();
    assert.equal(s.wallet.state.signed.length,0);assert.deepEqual(s.wallet.state.refused,[]);
    await s.page.getByRole('button', {name:'Load deployment and my sequences'}).click();
    await s.page.getByText('Sequence creation is not available on this deployment yet. No approval or transaction was requested.',{exact:true}).waitFor();
    const screenshots=resolve(import.meta.dirname,'../.test-artifacts');mkdirSync(screenshots,{recursive:true});
    await s.page.screenshot({path:join(screenshots,'p2-sequence-off.png'),fullPage:true});
    assert.equal(s.wallet.state.signed.length,0);assert.deepEqual(s.wallet.state.refused,[]);
  } finally {await s.close();}
});
