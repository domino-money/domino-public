/**
 * Source guards for the inline deposit-from-another-network offer (src/v2in/funds, spec F7 §3): it names no wallet method
 * (the closed sender, finance/v2/crosschain.ts, the closed reader of other networks, finance/v2/holdings.ts, and the
 * wallet port do every read, switch and send), reaches no network and keeps nothing in the browser itself; New position's
 * amount step keeps V1's amounts itself and opens only the offer lazily behind the bare V2 define (components/Deferred.tsx,
 * so the inputs never remount when the chunk lands), with a mount whose V1 alternate is the amounts expression exactly (so
 * a build without V2 emits the same bytes); and it carries no fixtures and no test data (the owner, 2026-10-02 night).
 * Comments are stripped first, so documentation may name what code may not use.
 */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, relative, resolve } from 'node:path';
import { test } from 'node:test';

const require = createRequire(import.meta.url);
const SRC = resolve(import.meta.dirname, '../../src');
const FUNDS = resolve(SRC, 'v2in/funds');
const strip = (text) => text.replaceAll('\r\n', '\n').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\s\/\/\s.*$/gm, '');

function sources(dir) {
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...sources(path));
    else if (/\.(ts|tsx)$/.test(entry.name)) files.push({ path: relative(SRC, path).replaceAll('\\', '/'), code: strip(readFileSync(path, 'utf8')) });
  }
  return files;
}
const ALL = sources(SRC);
const MINE = ALL.filter(({ path }) => path.startsWith('v2in/funds/'));
const hits = (files, pattern) => files.filter(({ code }) => pattern.test(code)).map(({ path }) => path);

test('the offer names no wallet method, reaches no network and keeps nothing in the browser itself', () => {
  assert.ok(MINE.length >= 9, `${MINE.length} files`);
  // A method, not one of the closed sender's stop codes (wallet_error, wallet_request_open and the like).
  assert.deepEqual(hits(MINE, /['"`]((?:eth|personal|net|web3)_[A-Za-z0-9_]+|wallet_[a-z]+[A-Z][A-Za-z0-9]*)['"`]/), [], 'only the closed clients name wallet methods');
  assert.deepEqual(hits(MINE, /\b(?:fetch|XMLHttpRequest|WebSocket|EventSource|sendBeacon)\s*\(|https?:\/\//), [], 'no network of its own');
  assert.deepEqual(hits(MINE, /\b(?:localStorage|sessionStorage|indexedDB|document\.cookie)\b/), [], 'storage only through the closed module');
  assert.deepEqual(hits(MINE, /\b(?:sendTransaction|writeContract|sendCalls|signTypedData|approve\s*\()/), [], 'no approval or send composed here');
});

// Changed on purpose 2026-10-03 (the integration review, #15): V1's amounts are mounted by the step itself in both branches
// and the chunk is the offer alone, drawn as soon as it is in (components/Deferred.tsx, as OwnedPositions.tsx opens the
// lists' chunks), so the inputs never remount when it lands; a Suspense fallback that drew the amounts again lost the caret.
test('New position\'s amount step keeps V1\'s amounts itself and opens only the offer lazily behind the bare define; its V1 alternate is the amounts expression exactly', () => {
  const stage = ALL.find(({ path }) => path === 'components/create/StageAmount.tsx').code;
  assert.match(stage, /const FundsOffer = __DOMINO_V2__ \? deferred<FundsOfferProps>\(recovering\(\(\) => import\('\.\.\/\.\.\/v2in\/funds\/FundsAmounts'\), \(\) => \(\{ default: NoOffer \}\)\)\) : null/, 'deferred, with a stand-in of nothing should the chunk be gone');
  assert.match(stage, /if \(__DOMINO_V2__ && FundsOffer\) FundsOffer\.preload\(\)/, 'the chunk is asked for as the step\'s module loads');
  assert.equal([...stage.matchAll(/v2in\//g)].length, 1, 'named once, in its lazy import()');
  assert.doesNotMatch(stage, /\blazy\(|Suspense|fallback=/, 'no Suspense fallback: nothing of V1\'s is drawn twice');
  const amounts = '<PairedAmounts state={state} balances={balances} onBudget={onBudget} onDeposit={onDeposit} />';
  const mount = stage.slice(stage.indexOf('{__DOMINO_V2__ && FundsOffer ? ('), stage.indexOf('<details'));
  assert.ok(mount.startsWith('{__DOMINO_V2__ && FundsOffer ? ('), 'the mount is a ternary on the bare define');
  // Changed on purpose 2026-10-05: the offer also says when funds it brought arrived, so the step reads its balances again.
  assert.ok(mount.includes(`<>\n          ${amounts}\n          <FundsOffer state={state} balances={balances} onBudget={onBudget} onDeposit={onDeposit} onArrived={onFundsArrived} />\n        </>`), 'V1\'s amounts, mounted by the step itself, then the offer alone under them');
  assert.ok(mount.trimEnd().endsWith(`) : (\n        ${amounts}\n      )}`), 'the alternate is V1\'s expression exactly');
  // The chunk is the offer alone: it never mounts the amounts (so nothing remounts when it lands).
  const chunk = ALL.find(({ path }) => path === 'v2in/funds/FundsAmounts.tsx').code;
  assert.doesNotMatch(chunk, /PairedAmounts/);
  assert.match(chunk, /return null\s*\n\s*const raw = rawBalances\(balances\)/, 'nothing where the gate is off or no wallet is connected');
  // Outside the offer's own directory, no module names it.
  const importers = ALL.filter(({ path, code }) => !path.startsWith('v2in/funds/') && /v2in\/funds/.test(code)).map(({ path }) => path);
  assert.deepEqual(importers, ['components/create/StageAmount.tsx']);
});

// Changed on purpose (data) 2026-10-02 (S2 holdings; the owner, 2026-10-02 night): no fixtures and no test data anywhere,
// real data only. The offer's fixtures module (v2in/funds/fixtures.ts) and the fixture client are gone; the services are
// null in every gate mode until the HTTP transport is wired (open point #17), and the offer then runs locked.
// Changed on purpose (data) 2026-10-02 (S2 wired): under a `live` gate (the crosschain route's own capabilities say it
// serves, src/v2/gate.ts) the services are the crosschain-v1 client over the page's HTTP transport, handed in by
// v2in/funds/live.ts; `preview` and `off` stay null, and a page whose transport is not the HTTP one gets none either.
// Changed on purpose 2026-10-03 (the integration review, #22): the `fixture` prop, the "Test data" pills and their words
// are gone from the offer altogether; the sender's own `quote_synthetic` guard (finance/v2/crosschain.ts) stays, said plainly.
test('no fixtures and no test data: nothing of the offer imports the package fixtures or a fixture transport, and no part of it carries a fixture prop or a test-data mark', () => {
  assert.equal(MINE.some(({ path }) => path === 'v2in/funds/fixtures.ts'), false, 'the fixtures module is gone');
  assert.deepEqual(hits(MINE, /fixtureTransport|crosschain-v1\/fixtures\/|testScope|FIXTURE_OWNER|fundsFixtureReply/), []);
  assert.deepEqual(hits(MINE, /\bfixture\b|data-fixture|testData|TestData|Test data/), [], 'no fixture prop, pill or mark anywhere in the offer');
  const offer = ALL.find(({ path }) => path === 'v2in/funds/BringFunds.tsx').code;
  assert.doesNotMatch(offer, /FUNDS_TEXT\.testData|FUNDS_TEXT\.synthetic|testNote|previewNoAnswer|noTestAnswer/);
  const words = require('../../.test-build/app/src/v2in/funds/copy.js');
  assert.equal(words.FUNDS_TEXT.testData, undefined);
  assert.equal(words.FUNDS_TEXT.synthetic, undefined);
  assert.doesNotMatch(words.senderCopy('quote_synthetic', { origin: 'Base', native: 'ETH' }), /test data/i, 'the sender\'s guard, said plainly');
  const { fundsServices } = require('../../.test-build/app/src/v2in/funds/services.js');
  const gate = (mode) => ({ mode, chainId: 4663, contracts: {}, locked: mode === 'preview' });
  const OWNER = `0x${'Ab'.repeat(20)}`;
  const page = (kind = 'http') => {
    const built = [];
    const clock = { monoMs: () => 1_000, setTimer: (callback, ms) => { built.push(['timer', ms]); return () => {}; } };
    const session = { withCsrf: async () => ({ lent: false }), reportDenial: () => {} };
    const runtime = { CONTRACT_VERSION: '1.0.0-rc.1', ROUTES: ['origins', 'quote', 'status'], ERROR_STATUS_BY_CODE: {}, validateRequest: () => true, validateResponse: () => true, validateError: () => true, advance: () => ['pending', 'initial'] };
    return { built, runtime, clock, live: () => { built.push(['live']); return { transport: { kind, send: async () => ({ kind: 'network' }) }, runtime, session, clock }; } };
  };
  for (const mode of ['off', 'preview']) {
    const p = page();
    assert.equal(fundsServices(gate(mode), OWNER, p), null, `${mode}: never a client`);
    assert.deepEqual(p.built, [], `${mode}: the page's parts are not even asked for`);
  }
  const p = page();
  const services = fundsServices(gate('live'), OWNER, p);
  assert.ok(services, 'live: the client');
  assert.deepEqual([services.source, services.client.transportKind, services.owner], ['http', 'http', OWNER.toLowerCase()]);
  assert.equal(services.runtime, p.runtime);
  assert.equal(services.clock, p.clock);
  services.deadlineTimer(() => {}, 120_000);
  void services.wait(5_000);
  assert.deepEqual(p.built, [['live'], ['timer', 120_000], ['timer', 5_000]], 'the deadline timer and the wait are the page clock\'s');
  assert.equal(fundsServices(gate('live'), OWNER, page('fixture')), null, 'a fixture transport is never a service, whatever the gate says');
});

// Changed on purpose (data) 2026-10-02 (S2 wired): the page's parts come from one module, which reaches the page's V2 route
// module and the package runtime and nothing else, and is imported by the amount step alone (the node tests never load it).
test('the offer\'s page module hands in the HTTP transport, the signed-in session, the runtime and the page clock, and only the two amount integrations and their S2 gate hook import it', () => {
  const live = readFileSync(resolve(FUNDS, 'live.ts'), 'utf8');
  const imports = [...live.matchAll(/^import[^;]*?from '([^']+)'/gm)].map((match) => match[1]);
  assert.deepEqual(imports.sort(), ['../../finance/v2/http', '../../v2/crosschain/contract', '../../v2/gate', '../../v2/routes', './services']);
  assert.match(live, /live: \(\) => \(\{ transport: liveCrosschainTransport\(\), runtime: CROSSCHAIN_RUNTIME, session: liveCrosschainSession\(\), clock: liveClock \}\)/);
  assert.match(live, /export const fundsRoutes: S2Routes = \(\) => Promise\.resolve\(\(probe \?\?= v2RouteProbe\(\)\)\)/, 'one probe for the offer, the page\'s');
  // Sorted by code unit (2026-10-04, PR #335's CI): the directory walk's order is the file system's, not the same on Linux.
  assert.deepEqual(ALL.filter(({ code }) => /from '\.\/live'/.test(code)).map(({ path }) => path).sort(), ['v2in/funds/FundsAmounts.tsx', 'v2in/funds/ZapFunds.tsx', 'v2in/funds/useS2Gate.ts']);
  const amounts = ALL.find(({ path }) => path === 'v2in/funds/FundsAmounts.tsx').code;
  assert.match(amounts, /fundsServices\(gate, wallet, fundsPage\)/, 'the connected wallet is the owner');
  assert.match(ALL.find(({ path }) => path === 'v2in/funds/useS2Gate.ts').code, /s2Gate\(chainId, fundsRoutes\)/, 'the S2 gate, asked with the page\'s probe');
  assert.doesNotMatch(amounts, /v2Gate\(/, 'never the manifest gate for S2');
  // S2 reads no contract set (spec F7 §3.1): whatever set its gate carries is never read by the offer.
  assert.deepEqual(hits(MINE, /gate\.contracts|\.contracts\b/), [], 'the offer never reads gate.contracts');
  assert.deepEqual(hits(MINE, /lockedCopy/), [], 'nor the gate\'s sentence about Domino\'s contracts');
});

// Changed on purpose 2026-10-05 (the owner, testing the offer: "it keeps asking me to sign in ... the networks don't show
// ... it has to happen behind the scenes, whoever uses Domino has no experience"): the holdings scan across Ethereum, Base,
// Arbitrum One and OP Mainnet (./Holdings.tsx, gone) is one click on one of Domino's own networks: the wallet moves there
// through wallet/port's V2 switch, its balances are read through the closed reader, the rest follows by itself.
test('one click on one of Domino\'s networks: switched through wallet/port, read through the closed reader, nothing else', () => {
  assert.equal(ALL.some(({ path }) => path === 'v2in/funds/Holdings.tsx'), false, 'the scan is gone');
  const offer = ALL.find(({ path }) => path === 'v2in/funds/BringFunds.tsx').code;
  assert.match(offer, /const SOURCE_CHAINS: readonly V2ChainId\[\] = \[4663, 8453, 42161\]/, 'Robinhood Chain, Base and Arbitrum One only, never Ethereum or OP Mainnet');
  assert.match(offer, /const switched = await switchToChain\(origin\)/, 'a V2 network, through the port');
  assert.doesNotMatch(offer, /scanHoldings|CANDIDATE_ORIGINS\.filter/, 'no scan of every network');
  assert.match(offer, /report = await readHoldingsReport\(await browserOriginWallet\(\), candidate\)/, 'the closed reader, on the network the wallet is on');
  assert.match(offer, /report\.unread\.length > 0 \? fail\(FUNDS_TEXT\.readFailed\(network\), 'read_partial'\)/, 'an unread balance is never said to be zero');
  assert.match(offer, /const sources = SOURCE_CHAINS\.filter\(\(id\) => id !== chainId\)/, 'never the destination');
  assert.doesNotMatch(offer, /\.request\(|eth_|balanceOf/, 'no read of its own');
  const copy = require('../../.test-build/app/src/v2in/funds/copy.js');
  assert.equal(copy.FUNDS_TEXT.youNeed('0.0021 ETH', 'Robinhood Chain'), 'You need 0.0021 ETH more on Robinhood Chain.');
  assert.equal(copy.FUNDS_TEXT.bringFrom, 'Bring it from:');
  assert.equal(copy.FUNDS_TEXT.howItWorks('Robinhood Chain'), 'Your wallet goes to that network to send it, then comes back to Robinhood Chain. You approve each step in your wallet.');
  assert.equal(copy.FUNDS_TEXT.noneThere('ETH, WETH or USDC', 'Base'), 'You have no ETH, WETH or USDC on Base.');
  assert.equal(copy.FUNDS_TEXT.switchingTo('Base'), 'Switching your wallet to Base…');
  assert.equal(copy.FUNDS_TEXT.checking('Base'), 'Checking your balance on Base…');
  assert.equal(copy.FUNDS_TEXT.signingIn, "Sign in with your wallet to continue. This doesn't move funds.");
});

test('the decided words: #16\'s discrete line, #29\'s "Get gas on {destination}" and S2\'s locked sentence, exactly; titles by token and network', () => {
  const copy = require('../../.test-build/app/src/v2in/funds/copy.js');
  assert.equal(copy.bridgeElsewhereLine('0.35%', 'Relay'), 'Domino fee 0.35% · via Relay · you can also bridge with any other service');
  assert.equal(copy.FUNDS_TEXT.gasOffer('Robinhood Chain'), 'Get gas on Robinhood Chain');
  assert.equal(copy.FUNDS_TEXT.title('USDG', 'Arbitrum'), 'Bring USDG from Arbitrum');
  assert.equal(copy.FUNDS_TEXT.title('USDG', null), 'Bring USDG from another network');
  // Decided [owner, 2026-10-02 evening]: S2's own locked sentence, in place of the gate's about Domino's contracts; said
  // whenever the offer has no service to ask (every gate mode today), on a press of Bring.
  assert.equal(copy.FUNDS_TEXT.locked, "Bringing funds from another network isn't available yet.");
  const offer = ALL.find(({ path }) => path === 'v2in/funds/BringFunds.tsx').code;
  assert.match(offer, /const locked = services === null \? FUNDS_TEXT\.locked : null/);
  assert.doesNotMatch(offer, /lockedCopy/, "never the gate's contracts sentence");
  const constants = require('../../.test-build/app/src/v2in/funds/constants.js');
  assert.equal(constants.FUNDS_SHOW_BRIDGE_ELSEWHERE, true, 'decision #16');
  assert.equal(constants.FUNDS_BATCH_APPROVAL_AND_DEPOSIT, false, 'decision #15');
  // Changed on purpose (data) 2026-10-02 (S2 wired): the app's side of #17 is done; the Worker's deployment and binding are the dashboard's.
  assert.equal(constants.FUNDS_HTTP_TRANSPORT_WIRED, true, 'open point #17, the app\'s side');
});


// Changed on purpose 2026-10-05: the network is the person's one choice; nothing switches the wallet before it.
test('the offer appears automatically, while wallet network changes wait for the person\'s one choice of network', () => {
  const offer = ALL.find(({ path }) => path === 'v2in/funds/BringFunds.tsx').code;
  assert.match(offer, /const opened = lacks.length > 0/);
  assert.doesNotMatch(offer, /setOpened|open=\{opened/);
  assert.equal([...offer.matchAll(/bringFrom\(/g)].length, 1, 'called from one place only');
  assert.match(offer, /onClick=\{\(\) => void bringFrom\(id\)\}/, 'from a network button alone');
});


test('live V2 Amount mounts the same funding flow and reads only through the closed wallet reader', () => {
  const stage = ALL.find(({ path }) => path === 'v2in/journey/AmountStage.tsx').code;
  const funds = ALL.find(({ path }) => path === 'v2in/funds/ZapFunds.tsx').code;
  assert.match(stage, /<ZapFunds state=\{state\} onAmounts=\{onAmounts\}/);
  assert.match(funds, /walletChainId !== candidate.chainId/);
  assert.match(funds, /readHoldingsReport\(await browserOriginWallet\(\), candidate\)/);
  assert.match(funds, /inputsOf\(state\)/);
  assert.match(funds, /lackingZapTokens/);
  assert.match(funds, /onUseToken=\{useToken\}/);
  assert.doesNotMatch(funds, /switchTo|\.request\(|eth_|balanceOf/);
});
