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
  // Changed on purpose 2026-10-06 (the owner: AI/PONS short and nothing offered; the review of 2026-10-06): the offer may
  // also pay with one other token (`onPayWith`, offered where Domino's service says it may, `pay`); once chosen, V1's
  // amounts, still mounted by the step itself in both branches, draw that token's one panel and the way back.
  const paying = '<PairedAmounts state={state} balances={balances} onBudget={onBudget} onDeposit={onDeposit} pay={pay} onPayWith={onPayWith} />';
  assert.ok(mount.includes(`<>\n          ${paying}\n          <FundsOffer state={state} balances={balances} onBudget={onBudget} onDeposit={onDeposit} onArrived={onFundsArrived} onPayWith={onPayWith} pay={pay} />\n        </>`), 'V1\'s amounts, mounted by the step itself, then the offer alone under them');
  assert.ok(mount.trimEnd().endsWith(`) : (\n        ${amounts}\n      )}`), 'the alternate is V1\'s expression exactly');
  // The chunk is the offer alone: it never mounts the amounts (so nothing remounts when it lands).
  const chunk = ALL.find(({ path }) => path === 'v2in/funds/FundsAmounts.tsx').code;
  assert.doesNotMatch(chunk, /PairedAmounts/);
  // Changed on purpose 2026-10-06 (the review): the pool and its network known, the line to pay with one other token is
  // drawn whatever S2's gate says and whether a wallet is connected or not; the offer itself only where the gate opens S2
  // and a wallet is connected, as before.
  assert.match(chunk, /return null\s*\n\s*const raw = rawBalances\(balances\)/, 'nothing without a pool on one of Domino\'s networks');
  assert.match(chunk, /\{gate && gate\.mode !== 'off' && wallet !== null && \(\s*<BringFunds/, 'the offer where the gate opens S2 and a wallet is connected');
  // Outside the offer's own directory, no module names it.
  const importers = ALL.filter(({ path, code }) => !path.startsWith('v2in/funds/') && /v2in\/funds/.test(code)).map(({ path }) => path);
  assert.deepEqual(importers, ['components/create/StageAmount.tsx']);
});

// Added 2026-10-06 (the review of 2026-10-06: the panel to pay with one other token was drawn inside the offer's chunk and
// its card, so a wallet locked, a gate read again or a branch of the card left the step with no amount field and no way
// back, or remounted the field mid-typing): paid that way, the panel and the way back are V1's own amounts', drawn by the
// step itself; the chunk only offers the line, first, outside the offer's card.
test('paying with one other token: the panel and its way back are the step\'s own; the chunk offers the line alone, outside the offer\'s card', () => {
  const paired = ALL.find(({ path }) => path === 'components/create/PairedAmounts.tsx').code;
  assert.match(paired, /if \(paid && onPayWith\) \{/);
  assert.match(paired, /data-pay-with-amount=\{token\.address\}/);
  assert.match(paired, /data-pay-with-back=""/);
  const chunk = ALL.find(({ path }) => path === 'v2in/funds/FundsAmounts.tsx').code;
  assert.doesNotMatch(chunk, /data-pay-with-amount|data-pay-with-back|PayPanel/);
  // The line first, then the offer's card: never inside it, so no branch of the card remounts it.
  assert.match(chunk, /return \(\s*<>\s*\{onPayWith && !paid && pay && planned\?\.plan\?\.kind === 'short' && <PayLine /);
  const offer = ALL.find(({ path }) => path === 'v2in/funds/BringFunds.tsx').code;
  assert.doesNotMatch(offer, /PayLine|payWith|\bpaid\b/, 'the offer\'s card knows nothing of it');
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
  // Changed on purpose 2026-10-06 (rugged97's #379): Ethereum and OP Mainnet have a button too, but only where Domino's
  // service read something to bring there (model.ts BALANCE_ORIGINS, their own read); Domino's own stay these three.
  assert.match(offer, /const SOURCE_CHAINS: readonly V2ChainId\[\] = \[4663, 8453, 42161\]/, 'Robinhood Chain, Base and Arbitrum One');
  assert.match(offer, /const away = BALANCE_ORIGINS\.filter\(\(id\) => id !== chainId && !closed\.has\(id\)\)\s+\.map\(\(id\) => \(\{ id, holds: holdsOf\(id\) \}\)\)\s+\.filter\(\(n\) => n\.holds\.state === 'holds' \|\| n\.holds\.state === 'no_gas'\)/, 'Ethereum and OP Mainnet only where something was read there, never unread or empty');
  // Changed on purpose 2026-10-06 (rugged97's #379): a V2 network through the port's V2 switch; Ethereum or OP Mainnet
  // through its switch to an origin.
  assert.match(offer, /const switched = await \(isV2ChainId\(origin\) \? switchToChain\(origin\) : switchToOrigin\(origin\)\)/, 'through the port');
  assert.doesNotMatch(offer, /scanHoldings|CANDIDATE_ORIGINS\.filter/, 'no scan of every network');
  assert.match(offer, /report = await readHoldingsReport\(await browserOriginWallet\(\), candidate\)/, 'the closed reader, on the network the wallet is on');
  assert.match(offer, /report\.unread\.length > 0 \? fail\(FUNDS_TEXT\.readFailed\(network\), 'read_partial'\)/, 'an unread balance is never said to be zero');
  assert.match(offer, /const sources = SOURCE_CHAINS\.filter\(\(id\) => id !== chainId\)/, 'never the destination');
  assert.doesNotMatch(offer, /\.request\(|eth_|balanceOf/, 'no read of its own');
  const copy = require('../../.test-build/app/src/v2in/funds/copy.js');
  assert.equal(copy.FUNDS_TEXT.youNeed('0.0021 ETH', 'Robinhood Chain'), 'You need 0.0021 ETH more on Robinhood Chain.');
  assert.equal(copy.FUNDS_TEXT.bringFrom, 'Bring it from:');
  // Changed on purpose 2026-10-06 (the owner's point 4: little text): the how-it-works sentence is gone; one live line says it.
  assert.equal(copy.FUNDS_TEXT.howItWorks, undefined);
  assert.equal(copy.FUNDS_TEXT.noneThere('ETH, WETH or USDC', 'Base'), 'You have no ETH, WETH or USDC on Base.');
  assert.equal(copy.FUNDS_TEXT.switchingTo('Base'), 'Switching your wallet to Base…');
  assert.equal(copy.FUNDS_TEXT.checking('Base'), 'Checking your balance on Base…');
  assert.equal(copy.FUNDS_TEXT.signingIn, "Sign in with your wallet to continue. This doesn't move funds.");
});

test('the decided words: #16\'s discrete line, #29\'s "Get gas on {destination}" and S2\'s locked sentence, exactly; titles by token and network', () => {
  const copy = require('../../.test-build/app/src/v2in/funds/copy.js');
  // Changed on purpose 2026-10-06 (rugged's answer of 6 Oct, F7 delta of 6 Oct §1): the fee in the line is §3.5's sentence,
  // with its amount, token, chain and where it is charged; #16's clause after it, as it was.
  assert.equal(copy.bridgeElsewhereLine('Domino fee (0.35%): 0.35 USDC, charged by Relay on Arbitrum One'), 'Domino fee (0.35%): 0.35 USDC, charged by Relay on Arbitrum One · you can also bridge with any other service');
  // One network cost line in view, never 0: the provider's estimate on the origin, or "Not reported".
  assert.equal(copy.FUNDS_TEXT.networkFee('Arbitrum One', '0.000001 ETH', 'Relay'), 'Network fee on Arbitrum One: about 0.000001 ETH, estimated by Relay');
  assert.equal(copy.FUNDS_TEXT.networkFee('Arbitrum One', null, 'Across'), 'Network fee on Arbitrum One: Not reported');
  // rugged's answer of 6 Oct (F7 delta of 6 Oct §2 step 7), his words: the line that counts the transactions, for a batch.
  assert.equal(copy.FUNDS_TEXT.batchLine(false), 'Approval and deposit in one confirmation · confirm in your wallet');
  assert.equal(copy.FUNDS_TEXT.batchLine(true), 'Approval and deposit in one confirmation · waiting to be included…');
  assert.equal(copy.FUNDS_TEXT.gasOffer('Robinhood Chain'), 'Get gas on Robinhood Chain');
  // Changed on purpose 2026-10-06 (the integration review: "Bring USDG from Arbitrum One" above "Bring 100 USDC from
  // Arbitrum One"): once a network is picked, the title names the network alone.
  assert.equal(copy.FUNDS_TEXT.title('USDG', 'Arbitrum One'), 'Bring funds from Arbitrum One');
  assert.equal(copy.FUNDS_TEXT.title('USDG', null), 'Bring USDG from another network');
  // The integration review's copy: plain English, the button by its own word.
  assert.equal(copy.FUNDS_TEXT.allYouHave('Arbitrum One'), "That's all you have on Arbitrum One. It's less than this amount needs.");
  assert.equal(copy.FUNDS_TEXT.nothingToUse('Robinhood Chain'), 'None of it is in your wallet on Robinhood Chain now.');
  assert.equal(copy.FUNDS_TEXT.newQuote, 'The quote expired. Here is a new one: press Bring again to continue.');
  assert.equal(copy.FUNDS_TEXT.newQuoteApproved, 'Your approval went through, but the quote expired. Here is a new one: press Bring again to continue.');
  // Decided [owner, 2026-10-02 evening]: S2's own locked sentence, in place of the gate's about Domino's contracts; said
  // whenever the offer has no service to ask (every gate mode today), on a press of Bring.
  assert.equal(copy.FUNDS_TEXT.locked, "Bringing funds from another network isn't available yet.");
  const offer = ALL.find(({ path }) => path === 'v2in/funds/BringFunds.tsx').code;
  assert.match(offer, /const locked = services === null \? FUNDS_TEXT\.locked : null/);
  assert.doesNotMatch(offer, /lockedCopy/, "never the gate's contracts sentence");
  const constants = require('../../.test-build/app/src/v2in/funds/constants.js');
  assert.equal(constants.FUNDS_SHOW_BRIDGE_ELSEWHERE, true, 'decision #16');
  // Changed on purpose 2026-10-06 (rugged's answer of 6 Oct: the owner revoked decision #15).
  assert.equal(constants.FUNDS_BATCH_APPROVAL_AND_DEPOSIT, true, 'decision #15 revoked: one batch where the wallet batches on the origin');
  // Changed on purpose (data) 2026-10-02 (S2 wired): the app's side of #17 is done; the Worker's deployment and binding are the dashboard's.
  assert.equal(constants.FUNDS_HTTP_TRANSPORT_WIRED, true, 'open point #17, the app\'s side');
});


// Changed on purpose 2026-10-05: the network is the person's one choice; nothing switches the wallet before it.
test('the offer appears automatically, while wallet network changes wait for the person\'s one choice of network or of the discreet line', () => {
  const offer = ALL.find(({ path }) => path === 'v2in/funds/BringFunds.tsx').code;
  // Changed on purpose 2026-10-06 (the owner's point 1): or the discreet line's holding, before an amount is typed; the
  // service's balances are read as the amount step opens, silently, and only the networks it reads are asked.
  assert.match(offer, /const servedKey = live && \(discreet \|\| lacks\.length > 0 \|\| pick !== null\) \? servedFor : null/, 'read as the step opens, before anything is typed');
  // Changed on purpose 2026-10-06 (the review): read again, as a new generation, once a deposit or a held step is settled.
  assert.match(offer, /const servedFor = `\$\{ownKey\}\|\$\{servedGen\}`/);
  assert.match(offer, /onSettled=\{\(\) => \{\s+setSettled\(\(previous\) => new Set\(previous\)\.add\(d\.record\.depositTxHash\)\)\s+readAgain\(\)/);
  assert.match(offer, /readChainBalances\(transports\.read, transports\.readRuntime, wallet, balancesRequest\(chainId\)\)/, 'only what model.ts balancesRequest asks');
  // Changed on purpose 2026-10-06 (rugged97's #379): Ethereum and OP Mainnet in a request of their own, under the same gate,
  // each answer kept apart (a failed one never takes the other's with it), Domino's three first before anything is drawn.
  assert.equal([...offer.matchAll(/readChainBalances\(/g)].length, 2, 'two requests, never one naming both');
  assert.match(offer, /const tokens = balanceChainsRequest\(chainId\)\s+if \(tokens\.length === 0\) return null\s+const away = await readChainBalances\(transports\.read, transports\.readRuntime, wallet, tokens\)/, 'only what model.ts balanceChainsRequest asks');
  assert.match(offer, /if \(!routeServes\(await transports\.routeState\('readV6'\), 'chain-balances'\)\) return null\s+if \(part === 'elsewhere'\)/, 'the same gate for both');
  assert.match(offer, /for \(const part of \['domino', 'elsewhere'\] as const\) \{\s+void readServed\(part\)\.then\(\(answer\) => \{\s+if \(alive\) keepServed\(servedKey, part, answer\)/);
  assert.match(offer, /return answer === null && \(here\[part\] \?\? null\) !== null \? here : \{ \.\.\.here, \[part\]: answer \}/, 'a failed read keeps its own earlier answer, and touches nothing else');
  assert.match(offer, /const servedNow = useMemo\(\(\) => \(servedHere === null \|\| servedHere\.domino === undefined \? null : mergeBalances\(servedHere\.domino, servedHere\.elsewhere \?\? null\)\), \[servedHere\]\)/);
  assert.doesNotMatch(offer, /setOpened|open=\{opened/);
  // Changed on purpose 2026-10-06 (the integration review): or the same pick again, from its "Sign in" button once the
  // person closed the wallet's dialog.
  assert.deepEqual([...offer.matchAll(/void bringFrom\(([^)]*)\)/g)].map((m) => m[1]).sort(), ['id', 'id as V2ChainId', 'last.origin, last.named', 'line.chainId, line'], 'from a network button, the same network chosen under Change amount, the discreet line, or the same pick again');
  assert.match(offer, /lastPick\.current = \{ origin, named \}/);
  assert.match(offer, /onClick=\{\(\) => void bringFrom\(id\)\}/);
  // Changed on purpose 2026-10-06 (the integration review): usable while a pick waits for a sign-in; never from an origin a
  // held step keeps closed.
  assert.match(offer, /const line = discreet && live && lacks\.length === 0 && \(!ownWay \|\| signing\) && !inFlight && servedNow \? bestHolding\(servedNow, chainId, deliverable, closed\) : null/, 'the line only before an amount, only on a live chain, only from what was read, never beside a deposit on its way');
  // Changed on purpose 2026-10-06 (the integration review): held back as a whole only for a deposit that may still arrive
  // here; any other held step closes its own origin.
  assert.match(offer, /const inFlight = holdOffers\(\s+deposits\.map\(\(d\) => \(\{ sentHere: d\.review !== null, hash: d\.record\.depositTxHash \}\)\),\s+settled,\s+held,\s+chainId,\s+\)/);
  assert.match(offer, /const closed = useMemo\(\(\) => heldOrigins\(held\), \[held\]\)/);
  assert.match(offer, /const open = sources\.filter\(\(id\) => !closed\.has\(id\)\)/);
  assert.match(offer, /const networks = open\.map\(/);
  assert.match(offer, /const showSources = lacks\.length > 0 && !inFlight && /, 'nor the networks');
  // A deposit this browser follows keeps the box drawn while the balances are read again (its arrival told once).
  assert.match(offer, /const underWay = ownWay \|\| heldNotice !== null \|\| held\.length > 0 \|\| deposits\.length > 0/);
  // Never everything held once an amount is typed: a figure, or the amount field for the person.
  assert.match(offer, /if \(typed && \(needRaw === null \|\| needRaw <= 0n\)\) \{/);
  assert.match(offer, /await sizeBring\(p, needRaw, latest\.current\.gasFlag, turn, prices\)/);
  // Changed on purpose 2026-10-06 (the review): the lack and the holding chosen together; the first ask by kind and price,
  // then sizeStep; a first ask of everything held never stands as the amount; every quote within the cap, let go with the choice.
  assert.match(offer, /bringChoice\(\{ lacks: latest\.current\.lacks, holdings, destination: chainId, origin, deliverable, prices \}\)/);
  assert.match(offer, /const first = firstAsk\(\{ need, needDecimals, needKind: kindOf\(chainId, p\.target\), sentDecimals: p\.decimals, sentKind: kindOf\(p\.origin, p\.holding\.token\), available, prices \}\)/);
  assert.match(offer, /const step = sizeStep\(\{ need, asked: first\.amount, available, minimum: winningMinimum\(probe\.data\.quote\), blind: first\.blind, fee: fixedFeeOf\(probe\.data\.quote\) \}\)/);
  assert.match(offer, /return services\.client\.quote\(requestFor\(raw\), \{ owner: services\.owner, signal \}\)/, 'a sizing quote stops with its choice');
  assert.equal([...offer.matchAll(/services\.client\.quote\(/g)].length, 2, 'two places ask a quote: the page\'s own ask and the sizing\'s, both counted');
  assert.equal([...offer.matchAll(/countQuote\(\)/g)].length, 2);
  assert.doesNotMatch(offer, /lackFor|firstGuess/);
  // No Get a quote button and no bridge slippage control (V1's 0.5%); provider names are not listed per token.
  assert.doesNotMatch(offer, /data-funds-get-quote|data-funds-slippage|providerListed|t\.providers\.join/);
  assert.match(offer, /slippageBps: FUNDS_DEFAULT_SLIPPAGE_BPS/);
  const quote = ALL.find(({ path }) => path === 'v2in/funds/QuoteView.tsx').code;
  assert.doesNotMatch(quote, /\bPill\b|FUNDS_TEXT\.best|quoteTitle|Compare routes/, 'no Quote heading, no Best pill, no second disclosure');
  assert.equal([...quote.matchAll(/<details/g)].length, 1, 'ONE Details');
  assert.equal([...quote.matchAll(/data-funds-deposit-button/g)].length, 1, 'ONE button');
  // The owner's own amount step: the line before an amount, the shortfall said once (PairedAmounts), Use keeping the amount.
  const amounts = ALL.find(({ path }) => path === 'v2in/funds/FundsAmounts.tsx').code;
  // Changed on purpose 2026-10-06: paid with one other token, its own amount decides the line, and the box says the shortfall
  // (that token's panel says nothing of it).
  assert.match(amounts, /discreet=\{paid \? !amount : planned === null\}/);
  assert.match(amounts, /shortSaid=\{!paid\}/);
  assert.match(amounts, /wholeFromOther\(terms, planned\.independent, planned\.need\[0\], planned\.need\[1\], terms\.slippageBps\)/, 'on Review\'s own terms');
  const zap = ALL.find(({ path }) => path === 'v2in/funds/ZapFunds.tsx').code;
  assert.doesNotMatch(zap, /discreet|shortSaid/, 'the zap path keeps its own sentence and no line');
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
