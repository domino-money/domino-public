/**
 * The Points page in a real browser (added 2026-11-07, the owner's Points page, Season 1, Stage 1;
 * integ-logs/points/PROPOSAL.md §3 and the design he chose, direction C "Corrente"), on wallet-test-v2
 * (.wallet-test-v2-dist: the deployed build's screens with the test wallets and the fake session service:
 * `npm run test:v2in`), with the points routes answered here, never a real backend:
 *
 *   - signed out (no wallet; a wallet and no sign-in), the service off (no Worker, or the Worker disabled) before and after
 *     9 Nov, the service live with the contract's own example, the first count still to come, the sign-in ended, the
 *     service busy and Try again;
 *   - a referral link: captured on opening, the card for each state, Link referrer signing points-v1's referralText only
 *     on its click and sending it at once, recorded, existing, each refusal, the wallet's refusal, Not now, the wallet's
 *     own link;
 *   - the way in: the menu's Points and Positions' Points button.
 *
 * The page's clock is fixed by the test hook the build carries (window.__dominoPointsNow, screens/Points.tsx nowMs), so
 * the season's phases are drawn whatever today is; the session's own clock stays the browser's.
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { after, before, test } from 'node:test';
import { recoverMessageAddress } from 'viem';
import * as runtime from '../../../api-contracts/points-v1/runtime.mjs';
import { closeBrowser } from '../support/close-browser.mjs';
import { createFakeSession } from '../support/fake-session.mjs';
import { ACCOUNTS, installWallets } from '../support/mock-wallet.mjs';
import { launchBrowser } from '../support/s1-browser.mjs';
import { WALLET_V2_DIST } from '../support/wallet-dist.mjs';
import { createWalletServer } from '../support/wallet-server.mjs';

const APP = resolve(import.meta.dirname, '../..');
const CONTRACT = resolve(APP, '../api-contracts/points-v1');
if (!existsSync(join(WALLET_V2_DIST, 'index.html'))) throw new Error('.wallet-test-v2-dist is missing. Run npm run build:wallet-test-v2 first.');
const fixture = (name) => JSON.parse(readFileSync(join(CONTRACT, 'fixtures', name), 'utf8'));

const OWNER = ACCOUNTS[0].address.toLowerCase();
const INVITER = '0x7d3f0a91c2b84e5d6f1a2b3c4d5e6f708192a3b4';
const OTHER = '0x91b7e2c04d5a6f38b2c1e9d07a4f6b3c2d1e0f9a';
const VERSION = runtime.CONTRACT_VERSION;
const HEADER = 'X-Domino-Points-Contract';
/** 9 Nov 2026, 03:00 UTC: an hour after the contract's example count (02:05 UTC), on the season's first day. */
const AFTER = Date.UTC(2026, 10, 9, 3);
/** 8 Nov 2026, 12:00 UTC: before the season. */
const BEFORE = Date.UTC(2026, 10, 8, 12);

/** The contract's example `points` answer about the connected wallet, with its referrer as a test names it; validated. */
function pointsAbout(wallet, { referrer = fixture('responses/points.json').wallet.referrer, snapshot } = {}) {
  const body = fixture('responses/points.json');
  body.wallet.address = wallet;
  body.wallet.referrer = referrer;
  if (snapshot !== undefined) body.snapshot = snapshot;
  assert.equal(runtime.validateResponse('points', body), true);
  return body;
}
const LIVE = { contractVersion: VERSION, dataMode: 'live', enabledRoutes: ['points', 'link'] };
const DISABLED = { contractVersion: VERSION, dataMode: 'disabled', enabledRoutes: [] };
/** No Worker bound: the forwarder's 404, no contract header. */
const noWorker = () => ({ status: 404, body: { error: 'not_found' }, contract: false });
/** The Worker disabled: capabilities say so; the routes are its route_not_available. */
const disabled = (method, route) => (route === 'capabilities' ? { status: 200, body: DISABLED } : { status: 404, body: { error: 'route_not_available' } });
/** The Worker live: capabilities, `points` from `answer`, `link` from `link`. */
const live = ({ answer = () => ({ status: 200, body: pointsAbout(OWNER) }), link = () => ({ status: 500, body: { error: 'upstream_unavailable' } }) } = {}) => (method, route, body) => {
  if (route === 'capabilities') return { status: 200, body: LIVE };
  if (route === 'points') return typeof answer === 'function' ? answer(body) : answer;
  return link(body);
};

let browser;
before(async () => {
  browser = await launchBrowser();
});
after(async () => {
  await closeBrowser(browser);
});

/**
 * /points on wallet-test-v2. `points(method, route, body)`: the points routes' answer ({ status, body, contract? }), every
 * request recorded with its headers. `clock`: the page's fixed time. `stored`: a referrer this browser already keeps.
 * `search`: the address's query. `connect` / `signIn`: Test Wallet A, from the header's dialog.
 */
async function scenario({ points = noWorker, clock = AFTER, stored = null, search = '', path = '/points', connect = true, signIn = true, viewport = { width: 1440, height: 1000 }, init = [], reducedMotion = null } = {}) {
  const fake = createFakeSession();
  const asked = [];
  const server = createWalletServer({
    fake,
    dist: WALLET_V2_DIST,
    routes: [
      async (request, url) => {
        if (!url.pathname.startsWith('/api/points/v1/')) return undefined;
        const route = url.pathname.slice('/api/points/v1/'.length);
        const text = request.method === 'POST' ? await request.text() : null;
        const body = text === null ? null : JSON.parse(text);
        asked.push({ method: request.method, route, body, at: Date.now(), csrf: request.headers.get('x-domino-csrf'), contract: request.headers.get('x-domino-points-contract'), cookie: request.headers.get('cookie') ?? '' });
        const answer = await points(request.method, route, body);
        return Response.json(answer.body, { status: answer.status, headers: answer.contract === false ? {} : { [HEADER]: VERSION } });
      },
    ],
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const origin = `http://127.0.0.1:${server.address().port}`;
  fake.origin = origin;
  const context = await browser.newContext({ viewport, ...(reducedMotion ? { reducedMotion } : {}) });
  for (const [script, arg] of init) await context.addInitScript(script, arg);
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin });
  await context.route(/^https:\/\/fonts\.(googleapis|gstatic)\.com\//, (route) => route.fulfill({ status: 200, contentType: 'text/css', body: '' }));
  const wallet = await installWallets(context);
  if (clock !== null) await context.addInitScript((value) => { window.__dominoPointsNow = value; }, clock);
  if (stored !== null) await context.addInitScript((value) => { if (!sessionStorage.getItem('pts-seeded')) { sessionStorage.setItem('pts-seeded', '1'); localStorage.setItem('domino.points.ref', value); } }, stored);
  const errors = [];
  const page = await context.newPage();
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`${origin}${path}${search}`);
  await page.waitForFunction(() => window.__dominoSessionProbe?.view().status === 'no_wallet');
  const dialog = page.locator('[role="dialog"][aria-labelledby="wallet-dialog-title"]');
  if (connect) {
    await page.locator('header [aria-haspopup="dialog"]').click();
    await dialog.getByRole('button', { name: 'Connect Test Wallet A', exact: true }).click();
    await page.waitForFunction(() => window.__dominoSessionProbe?.view().status === 'signed_out');
    if (signIn) {
      await dialog.getByRole('button', { name: 'Sign in', exact: true }).click();
      await page.waitForFunction(() => window.__dominoSessionProbe?.view().status === 'signed_in');
    }
    await page.keyboard.press('Escape');
  }
  const main = page.locator('main.dm-points-page');
  return {
    page,
    main,
    asked,
    wallet,
    origin,
    lead: (kind) => page.locator(`main.dm-points-page[data-points-lead="${kind}"]`).waitFor(),
    stored: () => page.evaluate(() => localStorage.getItem('domino.points.ref')),
    async close() {
      await context.close();
      await server.closeAll();
      assert.deepEqual(errors, [], 'no page error');
      assert.deepEqual(wallet.state.csp, [], 'no CSP violation');
    },
  };
}

const text = (locator) => locator.innerText().then((value) => value.replace(/\s+/g, ' ').trim());
/** The wallet's signatures other than the sign-in's own message. */
const linkSignatures = (s) => s.wallet.state.signed.filter((entry) => entry.message.startsWith('Domino Points'));

test('no wallet: connect to see your points, Season 1 and how points are counted; the service asked once, nothing private', async () => {
  const s = await scenario({ connect: false, points: live() });
  try {
    await s.lead('connect');
    assert.match(await text(s.main), /Connect a wallet to see your points\./);
    assert.match(await text(s.main), /Signing in is a free message, not a transaction\. Your points belong to your wallet address, on any device\./);
    assert.equal(await s.main.getByRole('button', { name: 'Connect wallet' }).count(), 1);
    assert.equal(await s.main.getByRole('link', { name: 'How Domino works' }).getAttribute('href'), '/#learn');
    assert.equal(await s.page.locator('[data-points-share]').count(), 0, 'no link without a wallet');
    const lower = s.page.locator('[data-points-lower="season"]');
    assert.match(await text(lower), /Season 1 9 Nov 2026 to 9 Feb 2027 Use Domino 1,000 points for every \$1 in fees Refer a wallet Plus 10% of its points from use/);
    await lower.locator('summary').click();
    assert.match(await text(lower.locator('details')), /Assisted swap 0\.65% of the amount swapped/);
    assert.equal(await lower.getByRole('link', { name: 'How points work' }).getAttribute('href'), '/docs/points');
    assert.equal(await s.page.title(), 'Points · Domino');
    assert.deepEqual(s.asked.map((entry) => `${entry.method} ${entry.route}`), ['GET capabilities']);
    assert.equal(s.asked[0].csrf, null, 'capabilities carry no CSRF');
    assert.equal(s.asked[0].contract, VERSION);
    // The menu names the page, and so does Positions.
    await s.page.locator('header button[aria-controls="site-menu"], header [aria-haspopup="menu"]').first().click();
    assert.equal(await s.page.locator('#site-menu').getByRole('menuitem', { name: 'Points' }).or(s.page.locator('#site-menu a[href="/points"]')).first().getAttribute('href'), '/points');
  } finally {
    await s.close();
  }
});

test('a wallet and no sign-in: Sign in, and the page’s own button signs in through the header’s flow, then the points come', async () => {
  const s = await scenario({ signIn: false, points: live() });
  try {
    await s.lead('sign_in');
    assert.match(await text(s.main), /Sign in to see your points\./);
    // The wallet's link works already, and its chip says which wallet.
    assert.equal(await s.page.locator('[data-points-link]').getAttribute('data-points-link'), `https://domino.money/points?ref=${OWNER}`);
    assert.equal(await s.page.locator('[data-connected-wallet] .pt-mono').innerText(), `${OWNER.slice(0, 6)}…${OWNER.slice(-4)}`);
    assert.equal(s.asked.filter((entry) => entry.route === 'points').length, 0, 'nothing private before signing in');
    await s.main.locator('[data-points-action="sign-in"]').click();
    await s.page.waitForFunction(() => window.__dominoSessionProbe?.view().status === 'signed_in');
    await s.lead('total');
    assert.equal(await s.page.locator('[data-points-total]').getAttribute('data-points-total'), '1715.000000');
  } finally {
    await s.close();
  }
});

test('the service off: no Worker or the Worker disabled, before 9 Nov the season’s start, after it the calm line; nothing private asked', async () => {
  for (const [points, clock, kind, words] of [
    [noWorker, AFTER, 'off', /Points can’t be shown right now\. Every Domino fee from 9 Nov 2026, 00:00 UTC counts toward them, so nothing is missed\./],
    [disabled, AFTER, 'off', /Points can’t be shown right now\./],
    [noWorker, BEFORE, 'before', /Season 1 starts 9 Nov at 00:00 UTC\. From then on, every Domino fee your wallet pays earns points, counted every hour\. Your link works already\./],
  ]) {
    const s = await scenario({ points, clock });
    try {
      await s.lead(kind);
      assert.match(await text(s.main), words);
      assert.equal(await s.page.locator('[data-points-share] button[data-points-action="copy"]').count(), 1, 'the link works already');
      assert.deepEqual(s.asked.map((entry) => entry.route), ['capabilities'], `${kind}: nothing private asked`);
      if (kind === 'before') assert.match(await text(s.page.locator('[data-node="you"]')), /You Counting starts 9 Nov/);
    } finally {
      await s.close();
    }
  }
});

test('live, with the contract’s own example: the total, the line of play, what earned the points, the count’s time and hashes, Copy link', async () => {
  const s = await scenario({ points: live({ answer: () => ({ status: 200, body: pointsAbout(OWNER, { referrer: OTHER }) }) }) });
  try {
    await s.lead('total');
    const total = s.page.locator('[data-points-total]');
    assert.equal(await text(total), '1,715 points');
    assert.equal(await total.getAttribute('title'), '1715.000000 points', 'the exact figure on hover');
    assert.match(await text(s.page.locator('[data-node="prev"]')), /Your referrer 0x91b7…0f9a/);
    assert.match(await text(s.page.locator('[data-node="you"]')), /You 1,650 from using Domino/);
    assert.match(await text(s.page.locator('[data-node="next"]')), /1 wallet joined with your link \+65 points/);
    assert.equal(await s.page.locator('.pt-run .pt-tile.solid').count(), 1);
    assert.equal(await s.page.locator('.pt-run .pt-tile.ghost').count(), 2);
    const rows = await s.page.locator('[data-points-lower="earned"] li').evaluateAll((items) => items.map((item) => [item.dataset.kind, item.innerText.replace(/\s+/g, ' ').trim()]));
    assert.deepEqual(rows, [['assistedSwap', 'Assisted swaps $0.65 in fees 650'], ['automation', 'Automation $0.65 in fees 650'], ['bridge', 'Deposits from another network $0.35 in fees 350']], 'Auto-exit at $0 is left out');
    assert.equal(await text(s.page.locator('.pt-count')), 'Counted every hour, last at 02:05 UTC. Season 1: 9 Nov 2026 to 9 Feb 2027, day 1 of 92.');
    await s.page.locator('.pt-details summary').click();
    const details = await text(s.page.locator('.pt-details'));
    assert.match(details, /Rules \(SHA-256\) 1657…fd98/);
    assert.match(details, /Last count \(SHA-256\) 3333…3333/);
    // The request: the session's cookie, its CSRF and the contract's header; the body the contract's {}.
    const asked = s.asked.find((entry) => entry.route === 'points');
    assert.deepEqual(asked.body, {});
    assert.equal(asked.contract, VERSION);
    assert.match(asked.csrf, /\S{16,}/);
    assert.match(asked.cookie, /__Host-domino-session=/);
    // Copy link copies the whole link.
    await s.page.locator('[data-points-action="copy"]').click();
    await s.page.locator('[data-points-action="copy"][data-copied]').waitFor();
    assert.equal(await s.page.evaluate(() => navigator.clipboard.readText()), `https://domino.money/points?ref=${OWNER}`);
    assert.match(await text(s.page.locator('[data-points-action="copy"]')), /Copied/);
    assert.equal(linkSignatures(s).length, 0, 'nothing signed for a link');
  } finally {
    await s.close();
  }
});

test('before 9 Nov with the service live, and after it before the first count, the page says when points start', async () => {
  for (const [clock, answer, kind, words] of [
    [BEFORE, pointsAbout(OWNER), 'before', /Season 1 starts 9 Nov at 00:00 UTC\./],
    [AFTER, pointsAbout(OWNER, { snapshot: null }), 'started', /Season 1 has started\. Points are counted every hour from 9 Nov, 00:00 UTC\. Yours show here after the next count\./],
  ]) {
    const s = await scenario({ clock, points: live({ answer: () => ({ status: 200, body: answer }) }) });
    try {
      await s.lead(kind);
      assert.match(await text(s.main), words);
      assert.equal(await s.page.locator('[data-points-total]').count(), 0);
    } finally {
      await s.close();
    }
  }
});

test('the sign-in ended, the service busy and Try again, an answer outside the contract: the page’s own words', async () => {
  {
    const s = await scenario({ points: live({ answer: () => ({ status: 401, body: { error: 'session_required' } }) }) });
    try {
      await s.lead('sign_in');
      assert.match(await text(s.main), /Your sign-in ended\. Sign in again to see your points\./);
    } finally {
      await s.close();
    }
  }
  {
    let calls = 0;
    const s = await scenario({ points: live({ answer: () => (++calls === 1 ? { status: 503, body: { error: 'points_unavailable' } } : { status: 200, body: pointsAbout(OWNER) }) }) });
    try {
      await s.lead('problem');
      assert.match(await text(s.main), /Points can’t be loaded right now\. Try again in a minute\./);
      await s.main.locator('[data-points-action="retry"]').click();
      await s.lead('total');
      assert.equal(calls, 2);
    } finally {
      await s.close();
    }
  }
  {
    const broken = pointsAbout(OWNER);
    broken.wallet.points = '9999.000000';
    const s = await scenario({ points: live({ answer: () => ({ status: 200, body: broken }) }) });
    try {
      await s.lead('problem');
      assert.equal(await s.page.locator('[data-points-total]').count(), 0, 'never shown');
    } finally {
      await s.close();
    }
  }
});

test('a referral link: kept on opening, the address cleaned; Link referrer signs points-v1’s text only on its click and sends it at once; recorded', async () => {
  const s = await scenario({
    search: `?ref=${INVITER.toUpperCase().replace('0X', '0x')}&utm=x`,
    points: live({
      answer: () => ({ status: 200, body: pointsAbout(OWNER, { referrer: null }) }),
      link: (body) => ({ status: 200, body: { contractVersion: VERSION, status: 'recorded', referee: OWNER, referrer: body.referrer } }),
    }),
  });
  try {
    assert.equal(new URL(s.page.url()).search, '?utm=x', 'ref left the address bar, the rest kept');
    assert.equal(await s.stored(), INVITER);
    await s.lead('total');
    const card = s.page.locator('[data-points-card="link"]');
    await card.waitFor();
    assert.match(await text(card), new RegExp(`Link your referrer You opened a referral link from 0x7d3f…a3b4\\. Linking adds 10% of your points from using Domino to theirs\\. You keep all of yours\\. Your wallet asks you to sign a message\\. It’s free, approves no transaction, and the link stays for all of Season 1\\.`));
    assert.match(await text(s.page.locator('[data-node="prev"]')), /0x7d3f…a3b4 invited you Not linked yet/);
    await s.page.waitForTimeout(500);
    assert.equal(linkSignatures(s).length, 0, 'no signature without the click');
    assert.equal(s.asked.filter((entry) => entry.route === 'link').length, 0);
    const clicked = Date.now();
    await card.locator('[data-points-action="link"]').click();
    const done = s.page.locator('[data-points-card="recorded"]');
    await done.waitFor();
    assert.equal(await text(done), 'Referrer linked Linked to 0x7d3f…a3b4. It stays for all of Season 1.');
    const signed = linkSignatures(s);
    assert.equal(signed.length, 1);
    const sent = s.asked.filter((entry) => entry.route === 'link');
    assert.equal(sent.length, 1);
    const { referrer, issuedAt, signature } = sent[0].body;
    assert.equal(referrer, INVITER);
    assert.ok(issuedAt >= Math.floor(clicked / 1000) - 1 && issuedAt <= Math.floor(Date.now() / 1000), 'issued at the click');
    assert.equal(signed[0].message, runtime.referralText('points-s1', OWNER, INVITER, issuedAt), 'the contract’s text, byte for byte');
    assert.equal(signed[0].signature, signature);
    assert.equal((await recoverMessageAddress({ message: signed[0].message, signature })).toLowerCase(), OWNER);
    assert.equal(runtime.validateRequest('link', sent[0].body), true);
    assert.equal(sent[0].contract, VERSION);
    assert.match(sent[0].csrf, /\S{16,}/);
    assert.equal(await s.stored(), null, 'the stored link is cleared');
    assert.equal(await s.page.locator('[data-node="prev"][data-solid]').count(), 1, 'the referrer’s tile takes its place');
    assert.match(await text(s.page.locator('[data-node="prev"]')), /Your referrer 0x7d3f…a3b4/);
  } finally {
    await s.close();
  }
});

test('Link referrer: existing, each refusal in its own words, the wallet’s refusal, and Not now', async () => {
  const words = {
    referral_self: 'You can’t refer yourself.',
    referral_wallet_excluded: 'This wallet can’t take part in referrals.',
    referral_season_closed: 'Season 1 has ended, so referrals are closed.',
    referral_message_not_fresh: 'The signature expired. Sign again to link.',
    referral_signature_invalid: 'The signature doesn’t match the connected wallet. Sign again with the same wallet.',
    referral_signature_mismatch: 'The signature doesn’t match the connected wallet. Sign again with the same wallet.',
  };
  const examples = fixture('errors.json').filter((example) => example.body.error.startsWith('referral_'));
  let next = null;
  const s = await scenario({
    stored: INVITER,
    points: live({ answer: () => ({ status: 200, body: pointsAbout(OWNER, { referrer: null }) }), link: () => next }),
  });
  try {
    const card = s.page.locator('[data-points-card="link"]');
    await card.waitFor();
    for (const { status, body } of examples) {
      next = { status, body };
      await card.locator('[data-points-action="link"]').click();
      await card.locator('[data-points-line]').waitFor();
      assert.equal(await text(card.locator('.pt-invite-status')), words[body.error], body.error);
      assert.equal(await card.locator('[data-points-action="link"]').isEnabled(), true, 'ready to try again');
      await s.page.waitForFunction(() => !document.querySelector('[data-points-action="link"][aria-busy]'));
    }
    assert.equal(await s.stored(), INVITER, 'a refusal keeps the stored link');
    // The wallet refuses to sign: nothing signed, nothing sent.
    const sentBefore = s.asked.filter((entry) => entry.route === 'link').length;
    s.wallet.rejectNext('a', 'personal_sign');
    await card.locator('[data-points-action="link"]').click();
    await s.page.waitForFunction(() => document.querySelector('.pt-invite-status')?.textContent === 'Nothing was signed, so nothing was linked.');
    assert.equal(s.asked.filter((entry) => entry.route === 'link').length, sentBefore);
    // Existing: the first link holds.
    next = { status: 200, body: { contractVersion: VERSION, status: 'existing', referee: OWNER, referrer: OTHER } };
    await card.locator('[data-points-action="link"]').click();
    const existing = s.page.locator('[data-points-card="existing"]');
    await existing.waitFor();
    assert.equal(await text(existing), 'Link your referrer Your referrer is 0x91b7…0f9a. A wallet’s first link stays for all of Season 1.');
    assert.equal(await s.stored(), null, 'cleared on existing too');
  } finally {
    await s.close();
  }
  // Not now: hidden for this visit, the stored link kept.
  const later = await scenario({ stored: INVITER, points: live({ answer: () => ({ status: 200, body: pointsAbout(OWNER, { referrer: null }) }) }) });
  try {
    const card = later.page.locator('[data-points-card="link"]');
    await card.waitFor();
    await card.locator('[data-points-action="later"]').click();
    await card.waitFor({ state: 'detached' });
    assert.equal(await later.stored(), INVITER);
    assert.equal(linkSignatures(later).length, 0);
  } finally {
    await later.close();
  }
});

test('the referral link where linking cannot work yet: the service off says when it opens; signed out, one line asks to sign in first', async () => {
  {
    const s = await scenario({ stored: INVITER, points: noWorker });
    try {
      const card = s.page.locator('[data-points-card="later"]');
      await card.waitFor();
      assert.match(await text(card), /Linking opens when points are counted\. Their 10% counts from 9 Nov, 00:00 UTC, whenever the link is made\./);
      assert.equal(await card.locator('[data-points-action="link"]').count(), 0, 'no button that cannot work');
      assert.equal(await card.locator('[data-points-action="later"]').count(), 1);
    } finally {
      await s.close();
    }
  }
  {
    const s = await scenario({ stored: INVITER, signIn: false, points: live() });
    try {
      const line = s.page.locator('[data-points-invited]');
      await line.waitFor();
      assert.equal(await text(line), '0x7d3f…a3b4 invited you. Sign in to link them as your referrer.');
      assert.equal(await s.page.locator('[data-points-card]').count(), 0, 'no second card: one way to sign in');
      assert.equal(await s.main.locator('[data-points-action="sign-in"]').count(), 1);
    } finally {
      await s.close();
    }
  }
});

test('the wallet’s own link is never a referral: forgotten once that wallet is connected', async () => {
  const s = await scenario({ search: `?ref=${OWNER}`, points: live({ answer: () => ({ status: 200, body: pointsAbout(OWNER, { referrer: null }) }) }) });
  try {
    await s.lead('total');
    await s.page.waitForFunction(() => localStorage.getItem('domino.points.ref') === null);
    assert.equal(await s.page.locator('[data-points-card]').count(), 0);
  } finally {
    await s.close();
  }
});

test('Positions has a Points button at every width, and the phone draws the page in one column with the line as a legend', async () => {
  const s = await scenario({ path: '/positions', connect: false });
  try {
    const wide = s.page.locator('[data-positions-points="wide"]');
    await wide.waitFor();
    assert.equal(await wide.getAttribute('href'), '/points');
    assert.equal(await wide.isVisible(), true);
    assert.equal(await s.page.locator('[data-positions-points="narrow"]').isVisible(), false);
    await s.page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await s.page.locator('[data-positions-points="narrow"]').isVisible(), true);
    assert.equal(await wide.isVisible(), false);
    await s.page.locator('[data-positions-points="narrow"]').click();
    await s.lead('connect');
    assert.equal(new URL(s.page.url()).pathname, '/points');
    assert.equal(await s.page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'no horizontal overflow on a phone');
  } finally {
    await s.close();
  }
});

// ---- Motion (added 2026-11-08: the owner's animated prototype, integ-logs/points/PROPOSAL.md §11, src/points/motion.ts).
// Every animation of the page is a Web Animation named by its moment (pt-entrance, pt-link, pt-join, ...); the log below
// records each one as it is made: its moment, what it animates, whether it moves, how long, how often, on what. A moment
// runs once: its parts are counted, then counted again after the page has been left and opened again.

/** Logs every animation the Points page's motion makes. */
const MOTION_LOG = () => {
  const native = Element.prototype.animate;
  window.__ptMotion = [];
  Element.prototype.animate = function (keyframes, options) {
    const animation = native.call(this, keyframes, options);
    const id = options && typeof options === 'object' ? String(options.id ?? '') : '';
    if (id.startsWith('pt-')) {
      const props = [...new Set(keyframes.flatMap((frame) => Object.keys(frame)).filter((key) => !['offset', 'easing', 'composite'].includes(key)))];
      const moves = keyframes.some((frame) => frame.transform !== undefined && frame.transform !== 'none');
      const node = this.closest('[data-node]')?.getAttribute('data-node') ?? null;
      const classes = (this.getAttribute('class') ?? '').split(' ').filter(Boolean).map((name) => `.${name}`).join('');
      window.__ptMotion.push({ id, props, moves, duration: options.duration, iterations: options.iterations ?? 1, node, target: `${this.tagName.toLowerCase()}${classes}` });
    }
    return animation;
  };
};
const motion = (s, id) => s.page.evaluate((id) => window.__ptMotion.filter((entry) => !id || entry.id === id), id);
const running = (s, id) => s.page.evaluate((id) => document.getAnimations().filter((animation) => animation.id === id).map((animation) => animation.playState), id);
/** Leaves Points for Positions and opens it again: a later visit in the same session. */
async function again(s) {
  await s.page.locator('header a[href="/positions"]').first().click();
  await s.page.locator('[data-positions-points="wide"]').click();
  await s.page.locator('main.dm-points-page:not([data-points-lead="wait"])').waitFor();
  await s.page.waitForTimeout(600);
}
const linkRecorded = (body) => ({ status: 200, body: { contractVersion: VERSION, status: 'recorded', referee: OWNER, referrer: body.referrer } });

test('motion: the line settles once per session, each part once (the double drops, the tiles meet, the total rolls); a later visit is still', async () => {
  const s = await scenario({ path: '/positions', points: live({ answer: () => ({ status: 200, body: pointsAbout(OWNER, { referrer: OTHER }) }) }), init: [[MOTION_LOG]] });
  try {
    await s.page.locator('[data-positions-points="wide"]').click();
    await s.lead('total');
    await s.page.locator('main.dm-points-page[data-entrance="play"]').waitFor();
    assert.equal(await s.page.evaluate(() => sessionStorage.getItem('domino.points.seen')), '1');
    const entrance = await motion(s, 'pt-entrance');
    const of = (node, target, moves) => entrance.filter((entry) => entry.node === node && entry.target.startsWith(target) && (moves === undefined || entry.moves === moves));
    assert.equal(of('you', 'span.pt-drop', true).length, 1, 'the double drops once');
    assert.equal(of('you', 'span.pt-ground', true).length, 1, 'its shadow blooms once');
    assert.equal(of('prev', 'span.pt-drop', true).length, 1, 'the referrer’s tile slides in once');
    assert.equal(of('next', 'span.pt-drop', true).length, 1, 'the one wallet referred joins once');
    assert.equal(of('next', 'span.pt-drop', false).length, 1 + 2, 'its tile opaque at once, and the two places fade in, with no click');
    assert.equal(entrance.filter((entry) => entry.target === 'span.pt-jflash').length, 2, 'a light at each of the two joints');
    assert.equal(entrance.filter((entry) => entry.target === 'span.pt-strip').length, 4, 'each digit of 1,715 rolls once');
    assert.equal(entrance.filter((entry) => entry.target.startsWith('section.pt-share')).length, 1);
    for (const entry of entrance) {
      assert.equal(entry.iterations, 1, `${entry.target}: nothing loops`);
      assert.deepEqual(entry.props.filter((prop) => !['transform', 'opacity', 'visibility'].includes(prop)), [], `${entry.target}: transform and opacity only (and the drum shown while it rolls)`);
    }
    assert.ok(entrance.length > 30, `the whole entrance (${entrance.length} animations)`);
    // A later visit in the same session: nothing enters.
    await again(s);
    assert.equal((await motion(s, 'pt-entrance')).length, entrance.length, 'the entrance does not run again');
    assert.equal(await s.page.locator('main.dm-points-page[data-entrance]').count(), 0);
    assert.equal(await text(s.page.locator('[data-points-total]')), '1,715 points', 'the total is its words; the drums are decoration');
  } finally {
    await s.close();
  }
});

test('motion: Link referrer: the slot breathes while it asks and stops when asked; the success moment runs once; a screen reader hears it', async () => {
  let release = null;
  const s = await scenario({ path: '/positions', stored: INVITER, init: [[MOTION_LOG]], points: live({ answer: () => ({ status: 200, body: pointsAbout(OWNER, { referrer: null }) }), link: linkRecorded }) });
  try {
    await s.page.locator('[data-positions-points="wide"]').click();
    const card = s.page.locator('[data-points-card="link"]');
    await card.waitFor();
    const breath = await motion(s, 'pt-breathe');
    assert.equal(breath.length, 1);
    assert.deepEqual([breath[0].props, breath[0].iterations, breath[0].node], [['opacity'], Infinity, 'prev'], 'the dashed place breathes, opacity only, until asked');
    assert.deepEqual(await running(s, 'pt-breathe'), ['running']);
    s.wallet.state.beforeSign = () => new Promise((done) => { release = done; });
    await card.locator('[data-points-action="link"]').click();
    await s.page.locator('[data-points-action="link"][aria-busy="true"]').waitFor();
    assert.deepEqual(await running(s, 'pt-breathe'), [], 'the place stops breathing the moment the wallet is asked');
    assert.equal((await motion(s, 'pt-wait')).filter((entry) => entry.iterations === Infinity).length, 3, 'three pips light in turn while it waits');
    s.wallet.state.beforeSign = null;
    release();
    await s.page.locator('[data-points-card="recorded"]').waitFor();
    await s.page.waitForTimeout(1800);
    const linked = await motion(s, 'pt-link');
    assert.equal(linked.filter((entry) => entry.node === 'prev' && entry.target === 'i').length, 8, 'its eight pips are stamped, one by one');
    assert.equal(linked.filter((entry) => entry.target === 'span.pt-sweep').length, 3, 'a light passes along the three tiles in play');
    assert.equal(linked.filter((entry) => entry.target === 'span.pt-jflash').length, 1, 'the joint clicks');
    assert.equal(linked.filter((entry) => entry.target.startsWith('span.pt-check')).length, 1, 'the check pops');
    assert.deepEqual(await running(s, 'pt-wait'), [], 'the pips stop');
    assert.deepEqual(await running(s, 'pt-breathe'), [], 'the place is filled: no breath');
    assert.equal(await s.page.locator('[data-points-said]').textContent(), 'Referrer linked.', 'said once');
    assert.equal(await s.page.locator('[data-points-said]').getAttribute('aria-live'), 'polite');
    // The ask stays in its place, hidden and inert, so the card keeps its size: nothing under it moves.
    assert.equal(await s.page.locator('.pt-invite .pt-ask[inert][aria-hidden="true"]').count(), 1);
    assert.equal(await s.page.locator('.pt-invite .pt-ask').evaluate((el) => getComputedStyle(el).visibility), 'hidden');
    assert.equal((await motion(s, 'pt-link')).length, linked.length, 'the moment ran once');
    // Copy link answers in its own place, and the live region says Copied.
    await s.page.locator('[data-points-action="copy"]').click();
    await s.page.locator('[data-points-action="copy"][data-copied]').waitFor();
    assert.ok((await motion(s, 'pt-copy')).length >= 4, 'the icon and the label cross');
    assert.equal(await s.page.locator('[data-points-share] [aria-live="polite"]').textContent(), 'Copied');
  } finally {
    await s.close();
  }
});

test('motion: a wallet that joined since the last visit comes in at the end of the line, once; the count changes', async () => {
  const seed = (owner) => {
    if (sessionStorage.getItem('pt-line-seeded')) return;
    sessionStorage.setItem('pt-line-seeded', '1');
    sessionStorage.setItem('domino.points.seen', '1');
    localStorage.setItem('domino.points.line', JSON.stringify({ [owner]: 0 }));
  };
  const s = await scenario({ path: '/positions', init: [[MOTION_LOG], [seed, OWNER]], points: live({ answer: () => ({ status: 200, body: pointsAbout(OWNER, { referrer: OTHER }) }) }) });
  try {
    await s.page.locator('[data-positions-points="wide"]').click();
    await s.lead('total');
    await s.page.waitForFunction((owner) => JSON.parse(localStorage.getItem('domino.points.line') ?? '{}')[owner] === 1, OWNER);
    assert.equal((await motion(s, 'pt-entrance')).length, 0, 'not the first visit of the session: no entrance');
    const join = await motion(s, 'pt-join');
    assert.equal(join.filter((entry) => entry.node === 'next' && entry.target === 'span.pt-drop' && entry.moves).length, 1, 'its tile comes in at the end of the line');
    assert.equal(join.filter((entry) => entry.node === 'next' && entry.target.includes('.pt-left')).length, 2, 'the place it fills and the old count leave');
    assert.equal(join.filter((entry) => entry.target === 'span.pt-jflash').length, 1, 'with its click at the joint');
    await s.page.waitForTimeout(1200);
    assert.equal(await text(s.page.locator('[data-node="next"]')), '1 wallet joined with your link +65 points', 'the count, the old words gone');
    assert.equal(await s.page.locator('.pt-run .pt-tile.solid').count(), 1);
    await again(s);
    assert.equal((await motion(s, 'pt-join')).length, join.length, 'it joins once');
  } finally {
    await s.close();
  }
});

test('motion: before 9 Nov a slow light crosses the season’s words; it pauses while the tab is hidden', async () => {
  const s = await scenario({ clock: BEFORE, connect: false, init: [[MOTION_LOG]] });
  try {
    await s.lead('before');
    await s.page.waitForTimeout(300);
    const light = await motion(s, 'pt-shimmer');
    assert.equal(light.length, 2, 'a window of light and the words in it, counter-moving');
    for (const entry of light) assert.deepEqual([entry.props, entry.iterations, entry.node], [['transform'], Infinity, 'you']);
    assert.deepEqual(await running(s, 'pt-shimmer'), ['running', 'running']);
    assert.equal(await text(s.page.locator('[data-node="you"]')), 'You Counting starts 9 Nov', 'the light is decoration: the words once');
    const hide = (value) => s.page.evaluate((value) => {
      if (value) Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
      else delete document.hidden;
      document.dispatchEvent(new Event('visibilitychange'));
    }, value);
    await hide(true);
    assert.deepEqual(await running(s, 'pt-shimmer'), ['paused', 'paused'], 'nothing runs while the tab is hidden');
    await hide(false);
    assert.deepEqual(await running(s, 'pt-shimmer'), ['running', 'running']);
  } finally {
    await s.close();
  }
});

test('motion under reduced motion: nothing moves and nothing loops; each change is a short fade', async () => {
  {
    const s = await scenario({ path: '/positions', reducedMotion: 'reduce', stored: INVITER, init: [[MOTION_LOG]], points: live({ answer: () => ({ status: 200, body: pointsAbout(OWNER, { referrer: null }) }), link: linkRecorded }) });
    try {
      await s.page.locator('[data-positions-points="wide"]').click();
      await s.page.locator('[data-points-card="link"]').waitFor();
      await s.page.locator('[data-points-card="link"] [data-points-action="link"]').click();
      await s.page.locator('[data-points-card="recorded"]').waitFor();
      await s.page.locator('[data-points-action="copy"]').click();
      await s.page.locator('[data-points-action="copy"][data-copied]').waitFor();
      await s.page.waitForTimeout(400);
      const all = await motion(s);
      for (const id of ['pt-entrance', 'pt-wait', 'pt-link', 'pt-copy']) assert.ok(all.some((entry) => entry.id === id), `${id} still says what changed`);
      for (const entry of all) {
        assert.equal(entry.moves, false, `${entry.id} ${entry.target}: nothing moves`);
        assert.deepEqual(entry.props.filter((prop) => prop !== 'opacity' && prop !== 'visibility'), [], `${entry.id} ${entry.target}: opacity only`);
        assert.ok(entry.duration <= 180 && entry.iterations === 1, `${entry.id} ${entry.target}: a short fade, once`);
      }
      assert.equal(all.filter((entry) => entry.id === 'pt-breathe').length, 0, 'no breath');
      assert.equal(all.filter((entry) => ['span.pt-jflash', 'span.pt-sweep', 'i'].includes(entry.target)).length, 0, 'no joint light, no sweep, no stamps, no pips');
    } finally {
      await s.close();
    }
  }
  {
    const s = await scenario({ clock: BEFORE, connect: false, reducedMotion: 'reduce', init: [[MOTION_LOG]] });
    try {
      await s.lead('before');
      await s.page.waitForTimeout(300);
      assert.deepEqual(await motion(s, 'pt-shimmer'), [], 'no shimmer');
    } finally {
      await s.close();
    }
  }
});
