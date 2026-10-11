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
test('payment remains the amount step\'s choice, offered inside the transfer continuation only after funds arrive', () => {
  const paired = ALL.find(({ path }) => path === 'components/create/PairedAmounts.tsx').code;
  assert.match(paired, /if \(paid && onPayWith\) \{/);
  assert.match(paired, /data-pay-with-amount=\{token\.address\}/);
  assert.match(paired, /data-pay-with-back=""/);
  const chunk = ALL.find(({ path }) => path === 'v2in/funds/FundsAmounts.tsx').code;
  assert.doesNotMatch(chunk, /data-pay-with-amount|data-pay-with-back|PayPanel/);
  assert.match(chunk, /tracking !== trackingKey && showPayment && alternative && <PayLine /, 'no competing payment call to action during transfer tracking');
  assert.match(chunk, /continuation=\{usableLocal && alternative \? <PayLine /, 'only an actually usable local balance offers conversion after arrival');
  const offer = ALL.find(({ path }) => path === 'v2in/funds/BringFunds.tsx').code;
  assert.doesNotMatch(offer, /PayLine|payWith|\bpaid\b/, 'the offer\'s card knows nothing of it');
  assert.match(offer, /allArrived && !changed && !run && !resume && !keep && !intent\?\.paymentRaw && continuation/, 'transfer completion cannot itself select or spend a payment token');
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
    const runtime = { CONTRACT_VERSION: '1.1.0-rc.1', ROUTES: ['origins', 'quote', 'status'], ERROR_STATUS_BY_CODE: {}, validateRequest: () => true, validateResponse: () => true, validateError: () => true, advance: () => ['pending', 'initial'] };
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
  assert.deepEqual(imports.sort(), ['../../finance/v2/http', '../../v2/crosschain/contract', '../../v2/gate', '../../v2/read/v6', '../../v2/routes', '../transports', './reconcile', './services']);
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

test('automatic discovery reads supported chain balances without a network picker or wallet reads', () => {
  const offer = ALL.find(({ path }) => path === 'v2in/funds/BringFunds.tsx').code;
  assert.match(offer, /balancesRequest\(chainId\), balanceChainsRequest\(chainId\)/, 'supported networks only, including Ethereum and OP Mainnet');
  assert.match(offer, /routeServes\(await transports\.routeState\('readV6'\), 'chain-balances'\)/, 'the read route must serve balances');
  assert.match(offer, /candidate\.chainId === chainId \|\| closed\.has\(candidate\.chainId\)/, 'the destination and quarantined origins cannot fund a new transfer');
  assert.match(offer, /gas === null \|\| gas <= 0n/, 'an unread native balance is not usable gas');
  assert.doesNotMatch(offer, /readHoldingsReport|<Select|otherMode|data-funds-other|bringFrom\(/, 'no manual network selection or wallet switch for discovery');
  assert.doesNotMatch(offer, /\.request\(|eth_|balanceOf/, 'closed readers and senders own wallet operations');
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
  assert.match(offer, /!live && <p data-funds-locked="">\{FUNDS_TEXT\.locked\}/);
  assert.doesNotMatch(offer, /lockedCopy/, "never the gate's contracts sentence");
  const constants = require('../../.test-build/app/src/v2in/funds/constants.js');
  assert.equal(constants.FUNDS_SHOW_BRIDGE_ELSEWHERE, true, 'decision #16');
  // Changed on purpose 2026-10-06 (rugged's answer of 6 Oct: the owner revoked decision #15).
  assert.equal(constants.FUNDS_BATCH_APPROVAL_AND_DEPOSIT, true, 'decision #15 revoked: one batch where the wallet batches on the origin');
  // Changed on purpose (data) 2026-10-02 (S2 wired): the app's side of #17 is done; the Worker's deployment and binding are the dashboard's.
  assert.equal(constants.FUNDS_HTTP_TRANSPORT_WIRED, true, 'open point #17, the app\'s side');
});


test('the funding proposal preserves consent, source caps, unknown outcomes and the user amount', () => {
  const offer = ALL.find(({ path }) => path === 'v2in/funds/BringFunds.tsx').code;
  const intent = ALL.find(({ path }) => path === 'v2in/funds/fundingIntent.ts').code;
  const status = ALL.find(({ path }) => path === 'v2in/funds/DepositStatus.tsx').code;
  assert.equal([...offer.matchAll(/data-funds-deposit-button/g)].length, 1, 'one primary transfer action');
  assert.equal([...offer.matchAll(/<details/g)].length, 1, 'one progressive details disclosure');
  assert.match(offer, /onClick=\{\(\) => void \(expired && !intent \? prepare\(\) : execute\(\)\)\}/, 'wallet sends require the user action; an expired preview must be renewed first');
  assert.match(offer, /withFundingLock\(wallet/);
  assert.match(offer, /respectsLeg\(accepted, leg, checked\.quote\)/, 'replacement quotes must fit accepted spending and output');
  assert.match(intent, /maxInputRaw: sentRaw\(leg\.quote\)/, 'the accepted debit, never the whole available wallet, caps refreshes');
  assert.match(intent, /leg\.state === 'sending' \? 'unknown' : leg\.state/, 'a reload never makes a sendable leg out of an uncertain wallet request');
  assert.match(offer, /services\.client\.quote\(request, \{ owner: wallet, signal, priority \}\)/, 'quotes use the shared authenticated request budget and cancellation');
  assert.match(offer, /requestFailure/);
  assert.match(offer, /SEND_MARGIN_MS/);
  assert.match(offer, /data-funds-destination-gas/);
  assert.match(offer, /originGasDetail/);
  assert.match(offer, /state === 'unknown'/);
  assert.doesNotMatch(offer, /data-funds-get-quote|data-funds-slippage|data-funds-other/);
  assert.match(status, /const done = view\.terminal/, 'missing bridge status is never a confirmed failure');
  assert.match(status, /filled && balanceState !== 'ready'/, 'arrival settles only after actual balances reconcile');
  assert.doesNotMatch(status, /switchToChain|own\.balance\(|data-funds-use="balance"/, 'no network popup or automatic whole-wallet resize on arrival');
  const amounts = ALL.find(({ path }) => path === 'v2in/funds/FundsAmounts.tsx').code;
  assert.match(amounts, /wholeFromOther\(terms, planned\.independent, planned\.need\[0\], planned\.need\[1\], terms\.slippageBps\)/, 'the funding amount uses Review terms');
  assert.match(amounts, /intentKey=/, 'position and typed input isolate the funding intent');
});

test('live V2 Amount mounts the same funding flow and reads destination balances without moving the wallet', () => {
  const stage = ALL.find(({ path }) => path === 'v2in/journey/AmountStage.tsx').code;
  const funds = ALL.find(({ path }) => path === 'v2in/funds/ZapFunds.tsx').code;
  assert.match(stage, /<ZapFunds state=\{state\} onAmounts=\{onAmounts\}/);
  assert.match(funds, /services\?\.readBalances\?\.\(state\.chainId, tokensKey\.split\(','\)\)/);
  assert.match(funds, /inputsOf\(state\)/);
  assert.match(funds, /lackingZapTokens/);
  assert.match(funds, /onAmounts\(state\.amounts\)/, 'the existing amount is preserved when an arrival is acknowledged');
  assert.doesNotMatch(funds, /onUseToken=|readHoldingsReport|browserOriginWallet/);
  assert.doesNotMatch(funds, /switchTo|\.request\(|eth_|balanceOf/);
});
