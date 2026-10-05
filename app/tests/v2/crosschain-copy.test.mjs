/**
 * The S2 screens' words (spec F7 §3.3-§3.5, §3.7, §3.9): every fixture and variant drawn as the spec quotes it.
 * Amounts are exact from raw strings, never floats; unknown decimals show the raw amount; a missing or hostile symbol
 * becomes a short address or clean text; no USD anywhere; the Domino fee is never said to be charged before `filled`.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build, fixture, fixtureText, lab, OWNER, runtime, VARIANTS } from './support/crosschain.mjs';

const { presentQuote, presentOrigins, presentStatus, naming, originGasDetail, destinationChoices } = build('present');
const { formatUnitsExact, amountText, tokenLabel, cleanSymbol, durationText, createTokenBook, createChainNames } = build('amounts');
const { CANDIDATE_COPY, STATE_COPY, FEE_STATUS_WORDS, bpsPercent, fill, PROVIDER_NAME, ADD_ORIGIN } = build('copy');
const { reply } = build('fixtureTransport');

const NAME = naming(fixture('responses/origins.json').origins);
const quoteOf = (name) => fixture(name).quote;

test('§3.5: the base quote reads exactly as the spec writes it, Relay the winner, both candidates shown', async () => {
  // Through the client and the fixture transport, as a screen would get it.
  const { client, transport } = lab();
  transport.script('origins', reply(200, fixtureText('responses/origins.json')));
  transport.script('quote', reply(200, fixtureText('responses/quote.json')));
  const origins = await client.origins(fixture('requests/origins.json'), { owner: OWNER });
  const quote = await client.quote(fixture('requests/quote.json'), { owner: OWNER });
  const view = presentQuote(quote.data.quote, naming(origins.data.origins));
  assert.equal(view.decision, 'relay');
  assert.equal(view.headline, null);
  assert.equal(view.origin, 'Arbitrum');
  assert.equal(view.destination, 'Robinhood Chain');
  assert.deepEqual(view.winner.lines, [
    'Domino fee (0.35%): 0.35 USDC, charged by Relay on Arbitrum',
    'Bridge fee: 0.048945 USDC',
    'You receive about 99.571446 USDG on Robinhood Chain (at least 99.073589 USDG)',
    'Network fee on Arbitrum: estimated by Relay',
    'Arrives in about 1 s',
  ]);
  assert.deepEqual(view.candidates.map((c) => [c.provider, c.name, c.winner, c.status, c.text]), [
    ['relay', 'Relay', true, 'quoted', null],
    ['across', 'Across', false, 'quoted', null],
  ]);
  assert.deepEqual(view.candidates[1].lines, [
    'Domino fee (0.35%): 0.349695 USDG, charged by Across on Robinhood Chain',
    'Bridge fee: 0.087036 USDC',
    'You receive about 99.563269 USDG on Robinhood Chain (at least 99.563269 USDG)',
    'Network fee on Arbitrum: Not reported',
    'Arrives in about 2 s',
  ]);
  const q = quote.data.quote;
  assert.equal(originGasDetail(q, q.candidates[0], NAME), '0.000001692667911 ETH');
  assert.equal(originGasDetail(q, q.candidates[1], NAME), null);
});

test('no route: the headline, and one line per provider with the spec’s words; the reason text never shows', () => {
  const quote = quoteOf('variants/quote.none.json');
  const view = presentQuote(quote, NAME);
  assert.equal(view.decision, null);
  assert.equal(view.winner, null);
  assert.equal(view.headline, 'No route available right now.');
  assert.deepEqual(view.candidates.map((c) => c.text), ["Domino's checks refused Relay's answer.", 'Across has no route for this token.']);
  assert.deepEqual(view.candidates.map((c) => c.lines), [null, null]);
  const words = JSON.stringify(view);
  for (const reason of ['relay_quote_app_fee_not_applied', 'provider_no_route']) assert.equal(words.includes(reason), false, reason);
});

test('native ETH through Across while Relay is busy: WETH fees on each side, ETH delivered, exact to the wei', () => {
  const view = presentQuote(quoteOf('variants/quote.native-only-across.json'), NAME);
  assert.equal(view.decision, 'across');
  assert.equal(view.candidates[0].text, 'Relay is busy. Try again shortly.');
  assert.equal(view.candidates[0].lines, null);
  assert.deepEqual(view.winner.lines, [
    'Domino fee (0.35%): 0.000174929011197839 WETH, charged by Across on Robinhood Chain',
    'Bridge fee: 0.000020282514903141 WETH',
    'You receive about 0.04980478847389902 ETH on Robinhood Chain (at least 0.04980478847389902 ETH)',
    'Network fee on Arbitrum: Not reported',
    'Arrives in about 1 s',
  ]);
});

test('destination gas: Relay delivers it and says so; Across says it cannot', () => {
  const view = presentQuote(quoteOf('variants/quote.destination-gas.json'), NAME);
  assert.equal(view.decision, 'relay');
  assert.ok(view.winner.lines.includes('Includes 0.000740778127264099 ETH for network fees on Robinhood Chain'));
  assert.equal(view.candidates[1].status, 'destination_gas_unsupported');
  assert.equal(view.candidates[1].text, "Across can't deliver gas on Robinhood Chain.");
  assert.equal(view.candidates[1].winner, false);
});

test('every candidate status has the spec’s sentence (§3.4)', () => {
  const words = Object.fromEntries(Object.entries(CANDIDATE_COPY).map(([status, template]) => [status, template === null ? null : fill(template, { provider: 'Relay', destination: 'Base', origin: 'Optimism' })]));
  assert.deepEqual(words, {
    quoted: null,
    destination_gas_unsupported: "Relay can't deliver gas on Base.",
    no_route: 'Relay has no route for this token.',
    amount_too_low: 'Amount too low for Relay.',
    amount_too_high: 'Amount too high for Relay.',
    rate_limited: 'Relay is busy. Try again shortly.',
    unavailable: 'Relay is unavailable right now.',
    rejected: 'Relay refused this request.',
    unsafe: "Domino's checks refused Relay's answer.",
    origin_not_supported: "Relay isn't supported from Optimism.",
  });
  assert.deepEqual(PROVIDER_NAME, { relay: 'Relay', across: 'Across' });
  assert.equal(fill(ADD_ORIGIN, { origin: 'Arbitrum' }), 'Add Arbitrum to your wallet, then try again.');
});

test('every state has the spec’s sentence (§3.7); the fee words are the details’ four', () => {
  const v = { provider: 'Relay', destination: 'Robinhood Chain', origin: 'Arbitrum', token: 'USDC' };
  assert.deepEqual(Object.fromEntries(Object.entries(STATE_COPY).map(([state, template]) => [state, fill(template, v)])), {
    awaiting_deposit: 'Waiting for Relay to see your deposit…',
    pending: 'Bridging to Robinhood Chain…',
    filled: 'Arrived in your wallet on Robinhood Chain.',
    refund_pending: 'Not filled in time. Across will refund USDC to your wallet on Arbitrum, usually 2.5 to 3 hours after your deposit.',
    failed: "The bridge failed. Relay is refunding your deposit on Arbitrum, minus the refund's gas.",
    refunded: 'Refunded to your wallet on Arbitrum.',
    refund_failed: 'Automatic refund failed. Reclaim your deposit at relay.link/withdraw with this wallet. If this is a smart or blocked wallet, contact Relay support.',
  });
  assert.deepEqual(FEE_STATUS_WORDS, { measured: 'measured', not_collected: 'not collected', pending: 'pending', unavailable: 'unavailable' });
});

test('every status fixture and variant draws its state; the fee appears only once filled, in the details', () => {
  const expected = {
    'responses/status.json': ['filled', 'Arrived in your wallet on Robinhood Chain.', { status: 'measured', words: 'measured', amount: '0.349695 USDG' }, 'fill'],
    'variants/status.across-held.json': ['filled', 'Arrived in your wallet on Robinhood Chain.', { status: 'pending', words: 'pending', amount: null }, null],
    'variants/status.across-refund-pending.json': ['refund_pending', 'Not filled in time. Across will refund your deposit to your wallet on Arbitrum, usually 2.5 to 3 hours after your deposit.', null, null],
    'variants/status.relay-awaiting.json': ['awaiting_deposit', 'Waiting for Relay to see your deposit…', null, null],
    'variants/status.relay-filled.json': ['filled', 'Arrived in your wallet on Robinhood Chain.', { status: 'measured', words: 'measured', amount: '0.35 USDC' }, 'fill'],
  };
  const names = ['responses/status.json', ...VARIANTS.filter((n) => n.startsWith('status.')).map((n) => `variants/${n}`)];
  assert.deepEqual(names.sort(), Object.keys(expected).sort());
  for (const name of names) {
    const report = fixture(name).status;
    const view = presentStatus({ report, shown: report.state, provider: report.request.provider, originChainId: report.request.originChainId, destinationChainId: report.request.destinationChainId, name: NAME });
    const [state, text, fee, link] = expected[name];
    assert.equal(view.state, state, name);
    assert.equal(view.text, text, name);
    assert.deepEqual(view.feeDetail, fee, name);
    assert.equal(view.link?.kind ?? null, link, name);
    assert.equal(view.terminal, report.terminal, name);
    assert.equal(view.next, state === 'filled' ? 'Create a position on Robinhood Chain' : null, name);
  }
  // Before the first answer the deposit is waiting for the provider; nothing is said about the fee.
  const before = presentStatus({ report: null, shown: null, provider: 'across', originChainId: 42161, destinationChainId: 8453, name: NAME });
  assert.equal(before.text, 'Waiting for Across to see your deposit…');
  assert.equal(before.feeDetail, null);
  // Refunded links to the origin; failed and refund_failed say what Relay does.
  const refunded = presentStatus({ report: { ...fixture('responses/status.json').status, fillTxHash: null, refundTxHash: `0x${'ab'.repeat(32)}` }, shown: 'refunded', provider: 'relay', originChainId: 42161, destinationChainId: 4663, name: NAME });
  assert.deepEqual([refunded.text, refunded.link, refunded.feeDetail], ['Refunded to your wallet on Arbitrum.', { kind: 'refund', chainId: 42161, hash: `0x${'ab'.repeat(32)}` }, null]);
  assert.equal(presentStatus({ report: null, shown: 'failed', provider: 'relay', originChainId: 10, destinationChainId: 8453, name: NAME }).text, "The bridge failed. Relay is refunding your deposit on Optimism, minus the refund's gas.");
});

test('origins: providers’ availability, chains in order, untrusted symbols, decimals null kept as unknown', () => {
  const list = fixture('responses/origins.json').origins;
  const view = presentOrigins(list);
  assert.deepEqual(view.providers, [
    { provider: 'relay', name: 'Relay', available: true, text: null },
    { provider: 'across', name: 'Across', available: true, text: null },
  ]);
  assert.deepEqual(view.chains.map((c) => [c.chainId, c.name]), [[1, 'Ethereum'], [10, 'Optimism'], [25, 'Cronos'], [137, 'Polygon'], [8453, 'Base'], [42161, 'Arbitrum'], [59144, 'Linea']]);
  const polygon = view.chains.find((c) => c.chainId === 137).tokens[0];
  assert.deepEqual(polygon, { address: '0x3c499c542cef5e3811e1192ce70d8cc03d5c3359', label: 'USDC', decimals: null, providers: ['Across'] });
  const busy = presentOrigins({ ...list, providers: [{ provider: 'relay', status: 'rate_limited', reason: 'x' }, { provider: 'across', status: 'unavailable', reason: 'y' }] });
  assert.deepEqual(busy.providers.map((p) => [p.available, p.text]), [[false, 'Relay is busy. Try again shortly.'], [false, 'Across is unavailable right now.']]);
  // The book: a listed token's decimals, a profile's charge currency, an unknown one.
  const book = createTokenBook(list);
  assert.deepEqual(book(137, '0x3c499c542cef5e3811e1192ce70d8cc03d5c3359'), { symbol: 'USDC', decimals: null });
  assert.deepEqual(book(4663, '0x5FC5360D0400A0FD4F2AF552ADD042D716F1D168'), { symbol: 'USDG', decimals: 6 });
  assert.deepEqual(book(25, '0x0000000000000000000000000000000000000000'), { symbol: 'CRO', decimals: 18 });
  assert.equal(book(1, '0x1234567890123456789012345678901234567890'), null);
  assert.equal(book(1, 'nope'), null);
  const names = createChainNames(list);
  assert.equal(names.origin(42161), 'Arbitrum');
  assert.equal(names.destination(42161), 'Arbitrum One');
  assert.equal(createChainNames(null).origin(42161), 'Arbitrum One', 'without a listing, the profile name');
  assert.equal(names.origin(999999), null);
});

test('amounts are exact from raw strings; unknown decimals show the raw amount; symbols are cleaned or replaced', () => {
  assert.equal(formatUnitsExact('350000', 6), '0.35');
  assert.equal(formatUnitsExact('99571446', 6), '99.571446');
  assert.equal(formatUnitsExact('1234500000', 6), '1,234.5');
  assert.equal(formatUnitsExact('0', 6), '0');
  assert.equal(formatUnitsExact('1', 18), '0.000000000000000001');
  assert.equal(formatUnitsExact('123456789012345678901234567890', 18), '123,456,789,012.34567890123456789');
  assert.equal(formatUnitsExact('5', 0), '5');
  assert.equal(formatUnitsExact('1.5', 6), null);
  assert.equal(formatUnitsExact('-1', 6), null);
  assert.equal(formatUnitsExact('01', 6), null);
  assert.equal(formatUnitsExact('1', null), null);
  assert.equal(formatUnitsExact('1', 256), null);
  assert.equal(amountText('1000000', '0x3c499c542cef5e3811e1192ce70d8cc03d5c3359', { symbol: 'USDC', decimals: null }), '1000000 raw units of USDC');
  assert.equal(amountText('1000000', '0x3c499c542cef5e3811e1192ce70d8cc03d5c3359', null), '1000000 raw units of 0x3c49…3359');
  assert.equal(amountText('1000000', '0x3c499c542cef5e3811e1192ce70d8cc03d5c3359', { symbol: null, decimals: 6 }), '1 0x3c49…3359');
  assert.equal(tokenLabel('0xaf88d065e77c8cc2239327c5edb3a432268e5831', null), '0xaf88…5831');
  assert.equal(cleanSymbol('USD‮C'), 'USDC', 'a right-to-left override is dropped');
  assert.equal(cleanSymbol('U​S\u0000D'), 'USD');
  assert.equal(cleanSymbol('​ ​'), null);
  assert.equal(cleanSymbol('A'.repeat(40)), `${'A'.repeat(24)}…`);
  assert.equal(bpsPercent(35), '0.35%');
  assert.equal(bpsPercent(5), '0.05%');
  assert.equal(bpsPercent(100), '1%');
  assert.equal(bpsPercent(250), '2.5%');
  assert.deepEqual([1, 59, 60, 61, 3600, 3660, 9000].map(durationText), ['1 s', '59 s', '1 min', '2 min', '1 h', '1 h 1 min', '2 h 30 min']);
});

test('no USD anywhere: the provider’s originGas.usd never reaches a sentence, and no figure carries a dollar sign', () => {
  const all = [
    ...['responses/quote.json', 'variants/quote.destination-gas.json', 'variants/quote.native-only-across.json', 'variants/quote.none.json'].map((n) => presentQuote(quoteOf(n), NAME)),
    presentOrigins(fixture('responses/origins.json').origins),
  ];
  const text = JSON.stringify(all);
  for (const usd of ['0.004568', '0.004571']) assert.equal(text.includes(usd), false, usd);
  assert.equal(text.includes('$'), false);
  assert.equal(/\bUSD\b/.test(text), false);
});

test('destinations are only each V2 chain’s charge currencies, the same three the package admits (§3.3)', async () => {
  const { CONSTANTS } = await import(new URL('../../../api-contracts/crosschain-v1/schema-data.mjs', import.meta.url).href);
  const choices = destinationChoices();
  assert.deepEqual(choices.map((c) => [c.chainId, c.chain, c.tokens.map((t) => t.symbol)]), [
    [4663, 'Robinhood Chain', ['USDG', 'ETH', 'WETH']],
    [8453, 'Base', ['USDC', 'ETH', 'WETH']],
    [42161, 'Arbitrum One', ['USDC', 'ETH', 'WETH']],
  ]);
  const listed = Object.fromEntries(choices.map((c) => [String(c.chainId), c.tokens.map((t) => t.address).sort()]));
  assert.deepEqual(listed, Object.fromEntries(Object.entries(CONSTANTS.destinations).map(([id, tokens]) => [id, [...tokens].sort()])));
  for (const c of choices) {
    for (const t of c.tokens) assert.ok(runtime.validateRequest('origins', { destinationChainId: c.chainId, destinationToken: t.address }), `${c.chain} ${t.symbol}`);
  }
  assert.equal(runtime.validateRequest('origins', { destinationChainId: 4663, destinationToken: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913' }), false, "Base's USDC is not a Robinhood destination");
});
