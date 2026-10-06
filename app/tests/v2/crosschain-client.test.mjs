/**
 * The S2 client (spec F7 §3.2-§3.4, §3.7, §3.8) over the crosschain-v1 package fixtures and the real runtime: every
 * response and variant is accepted for its route and echoes what was sent; the exact 1.1.0-rc.1 header (Changed on
 * purpose (data) 2026-10-06: 1.0.0-rc.1 -> 1.1.0-rc.1, quoting by output; the listener's window for rc.1 is not this
 * page's, which accepts its own version only); the gate;
 * the owner and echo bindings the runtime cannot do; a quote that arrives expired; every errors.json pair, its copy
 * and what the page does next, with denials reported to the session; the fixture transport's log; and the unimported
 * http transport's headers.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build, clone, CSRF, ERRORS, fakeClock, fakeSession, fixture, fixtureText, lab, OTHER, OWNER, runtime, sentFor, VARIANTS } from './support/crosschain.mjs';

const { interpretCrosschain, createCrosschainClient, quoteDeadlineMono, echoes } = build('client');
const { CROSSCHAIN_ROUTES, CROSSCHAIN_PREFIX, MAX_REQUEST_BYTES } = build('transport');
const { createFixtureTransport, reply, FIXTURE_BANNER } = build('fixtureTransport');
const { createHttpCrosschainTransport } = build('httpTransport');
const { CROSSCHAIN_ERROR_UI, errorDisposition, GENERIC_ERROR_COPY } = build('errors');

const TIMING = { sentMono: 1_000_000, receivedMono: 1_000_000 };
const raw = (status, body, extra = {}) => ({
  kind: 'reply',
  reply: {
    status,
    opaqueRedirect: false,
    contentType: 'application/json; charset=utf-8',
    contractHeader: '1.1.0-rc.1',
    requestIdHeader: null,
    retryAfterHeader: null,
    body: { kind: 'text', text: typeof body === 'string' ? body : JSON.stringify(body) },
    ...extra,
  },
});
const interpret = (route, body, extra, sent = sentFor(route, body), owner = OWNER) =>
  interpretCrosschain(route, sent, raw(200, body, extra), runtime, owner, TIMING, 'fixture');

test('the client covers exactly the runtime’s three routes, and every request fixture passes the runtime', () => {
  assert.deepEqual([...CROSSCHAIN_ROUTES].sort(), [...runtime.ROUTES].sort());
  assert.equal(CROSSCHAIN_PREFIX, '/api/crosschain/v1/');
  for (const route of CROSSCHAIN_ROUTES) assert.ok(runtime.validateRequest(route, fixture(`requests/${route}.json`)), route);
});

test('every response and variant validates and is accepted for its route, echoing what was sent', () => {
  for (const route of CROSSCHAIN_ROUTES) {
    const body = fixture(`responses/${route}.json`);
    assert.ok(runtime.validateResponse(route, body), route);
    const out = interpret(route, body);
    assert.equal(out.ok, true, route);
    assert.deepEqual(out.data, body);
    assert.equal(out.source, 'fixture');
  }
  assert.deepEqual(VARIANTS, [
    'quote.destination-gas.json',
    'quote.native-only-across.json',
    'quote.none.json',
    // Added 2026-10-06 (1.1.0-rc.1): quotes by output, which the offer's one click asks (rugged's delta of 6 Oct §3).
    'quote.output-above-max.json',
    'quote.output-native.json',
    'quote.output.json',
    'status.across-held.json',
    'status.across-refund-pending.json',
    'status.relay-awaiting.json',
    'status.relay-filled.json',
  ]);
  for (const name of VARIANTS) {
    const route = name.split('.')[0];
    const body = fixture(`variants/${name}`);
    assert.ok(runtime.validateResponse(route, body), name);
    assert.equal(interpret(route, body).ok, true, name);
    // A variant read as another route's answer is refused.
    const other = route === 'quote' ? 'status' : 'quote';
    assert.deepEqual(interpretCrosschain(other, sentFor(route, body), raw(200, body), runtime, OWNER, TIMING, 'fixture').failure, { kind: 'contract', detail: 'response' }, name);
  }
  // The request fixtures are what the base responses answer.
  assert.deepEqual(sentFor('quote', fixture('responses/quote.json')), fixture('requests/quote.json'));
  assert.deepEqual(sentFor('status', fixture('responses/status.json')), fixture('requests/status.json'));
  assert.deepEqual(sentFor('origins', fixture('responses/origins.json')), fixture('requests/origins.json'));
});

test('the header must be exactly 1.1.0-rc.1; header-less replies are the gate, a missing route, or refused', () => {
  const body = fixture('responses/quote.json');
  for (const version of ['1.0.0-rc.1', '1.0.0-rc.2', '1.1.0', '1.1.0-rc.1 ', '1.1.0-rc.2', '1.1.0-rc.4']) {
    assert.deepEqual(interpret('quote', body, { contractHeader: version }).failure, { kind: 'contract', detail: 'version' }, version);
  }
  const headerless = (status, text, contentType) => interpretCrosschain('quote', fixture('requests/quote.json'), raw(status, text, { contractHeader: null, contentType }), runtime, OWNER, TIMING, 'fixture').failure;
  assert.deepEqual(headerless(401, '{"error":"beta_access_required"}', 'application/json'), { kind: 'gate_required' });
  assert.deepEqual(headerless(503, '<html>', 'text/html'), { kind: 'gate_unavailable' });
  assert.deepEqual(headerless(404, '{"error":"not_found"}', 'application/json; charset=utf-8'), { kind: 'not_deployed' });
  assert.deepEqual(headerless(200, '<!doctype html>', 'text/html'), { kind: 'not_deployed' });
  assert.deepEqual(headerless(500, '{"error":"upstream_unavailable"}', 'application/json'), { kind: 'contract', detail: 'header_missing' });
  assert.deepEqual(interpret('quote', body, { opaqueRedirect: true }).failure, { kind: 'contract', detail: 'redirect' });
  assert.deepEqual(interpret('quote', body, { contentType: 'text/plain' }).failure, { kind: 'contract', detail: 'not_json' });
  assert.deepEqual(interpret('quote', '{"contractVersion":', {}, fixture('requests/quote.json')).failure, { kind: 'contract', detail: 'invalid_json' });
  assert.deepEqual(interpret('quote', body, { body: { kind: 'too_large' } }).failure, { kind: 'contract', detail: 'too_large' });
  assert.deepEqual(interpret('quote', body, { status: 201 }).failure, { kind: 'contract', detail: 'response' });
});

test('an answer about another wallet, or about another request, returns nothing (the runtime cannot check either)', () => {
  const quote = fixture('responses/quote.json');
  const out = interpret('quote', quote, {}, sentFor('quote', quote), OTHER);
  assert.deepEqual(out, { ok: false, route: 'quote', failure: { kind: 'contract', detail: 'owner' } });
  // The connected wallet compared without regard to case.
  assert.equal(interpret('quote', quote, {}, sentFor('quote', quote), OWNER.toUpperCase().replace('0X', '0x')).ok, true);
  // A rewritten owner still passes the runtime, which is why this check exists.
  const rewritten = clone(quote);
  rewritten.quote.request.owner = OTHER;
  for (const c of rewritten.quote.candidates) if (c.refund) c.refund.recipient = OTHER;
  assert.equal(runtime.validateResponse('quote', rewritten), true);
  assert.equal(interpret('quote', rewritten, {}, sentFor('quote', quote)).failure.detail, 'owner');
  const status = fixture('responses/status.json');
  assert.equal(interpret('status', status, {}, sentFor('status', status), OTHER).failure.detail, 'owner');
  // Echo: the answer must be about the request this page sent.
  assert.equal(interpret('quote', quote, {}, { ...sentFor('quote', quote), amountRaw: '100000001' }).failure.detail, 'echo');
  assert.equal(interpret('quote', quote, {}, { ...sentFor('quote', quote), slippageBps: 51 }).failure.detail, 'echo');
  // Added 2026-10-06 (1.1.0-rc.1): how the amount was asked, and the cap, are part of the request too.
  assert.equal(interpret('quote', quote, {}, { ...sentFor('quote', quote), amountKind: 'output', maxInputRaw: '100000000' }).failure.detail, 'echo');
  const byOutput = fixture('variants/quote.output.json');
  assert.equal(interpret('quote', byOutput, {}, { ...sentFor('quote', byOutput), maxInputRaw: '150000001' }).failure.detail, 'echo');
  assert.equal(interpret('status', status, {}, { ...sentFor('status', status), previousState: null }).failure.detail, 'echo');
  assert.equal(interpret('status', status, {}, { ...sentFor('status', status), depositTxHash: `0x${'e'.repeat(64)}` }).failure.detail, 'echo');
  const origins = fixture('responses/origins.json');
  assert.equal(interpret('origins', origins, {}, { destinationChainId: 4663, destinationToken: '0x0000000000000000000000000000000000000000' }).failure.detail, 'echo');
  // Addresses echo without regard to case.
  assert.equal(echoes('quote', { ...sentFor('quote', quote), originToken: quote.quote.request.originToken.toUpperCase().replace('0X', '0x') }, quote, OWNER), 'ok');
});

test('a quote is usable until min(sent + 120 s, received + (expiresAt − retrievedAt)) on this page’s clock; one that arrives past it is refused', () => {
  const quote = fixture('responses/quote.json');
  assert.equal(quoteDeadlineMono(quote.quote, { sentMono: 0, receivedMono: 5_000 }), 120_000);
  assert.equal(quoteDeadlineMono({ requestedAt: 100, retrievedAt: 150, expiresAt: 220 }, { sentMono: 0, receivedMono: 1_000 }), 71_000);
  const late = interpretCrosschain('quote', sentFor('quote', quote), raw(200, quote), runtime, OWNER, { sentMono: 0, receivedMono: 120_000 }, 'fixture');
  assert.deepEqual(late.failure, { kind: 'expired' });
  assert.equal(interpretCrosschain('quote', sentFor('quote', quote), raw(200, quote), runtime, OWNER, { sentMono: 0, receivedMono: 119_999 }, 'fixture').ok, true);
});

test('an invalid request, a request naming an owner, a bad wallet or a gone session sends nothing', async () => {
  const { client, transport, session } = lab();
  const quote = fixture('requests/quote.json');
  assert.equal((await client.quote({ ...quote, owner: OWNER }, { owner: OWNER })).failure.kind, 'request_invalid');
  assert.equal((await client.quote({ ...quote, recipient: OWNER }, { owner: OWNER })).failure.kind, 'request_invalid');
  assert.equal((await client.quote({ ...quote, amountRaw: 100000000 }, { owner: OWNER })).failure.kind, 'request_invalid');
  assert.equal((await client.quote({ ...quote, originChainId: 4663 }, { owner: OWNER })).failure.kind, 'request_invalid');
  assert.equal((await client.quote({ ...quote, destinationToken: OTHER }, { owner: OWNER })).failure.kind, 'request_invalid');
  assert.equal((await client.status({ ...fixture('requests/status.json'), requestId: `0x${'1'.repeat(64)}` }, { owner: OWNER })).failure.kind, 'request_invalid');
  assert.equal((await client.quote(quote, { owner: 'not-a-wallet' })).failure.kind, 'request_invalid');
  assert.equal(MAX_REQUEST_BYTES, 4096);
  session.signedIn = false;
  assert.equal((await client.quote(quote, { owner: OWNER })).failure.kind, 'session_gone');
  assert.equal(transport.calls().length, 0);
  assert.equal(session.lends, 0);
});

test('through the fixture transport: one POST per call, the lent CSRF compared in memory and never logged', async () => {
  const { client, transport, session } = lab();
  for (const route of CROSSCHAIN_ROUTES) transport.script(route, reply(200, fixtureText(`responses/${route}.json`)));
  const origins = await client.origins(fixture('requests/origins.json'), { owner: OWNER });
  const quote = await client.quote(fixture('requests/quote.json'), { owner: OWNER });
  const status = await client.status(fixture('requests/status.json'), { owner: OWNER });
  for (const out of [origins, quote, status]) assert.equal(out.ok, true, out.route);
  assert.equal(quote.data.quote.decision, 'relay');
  assert.equal(status.data.status.state, 'filled');
  assert.deepEqual(transport.calls().map((call) => [call.route, call.csrfMatched]), [['origins', true], ['quote', true], ['status', true]]);
  assert.deepEqual(transport.calls().map((call) => call.body), [fixture('requests/origins.json'), fixture('requests/quote.json'), fixture('requests/status.json')]);
  assert.equal(JSON.stringify(transport.calls()).includes(CSRF), false, 'the log never holds the CSRF');
  assert.equal(session.lends, 3);
  assert.deepEqual(transport.unscripted(), []);
  // An unscripted call is recorded and refused, and reads as a network failure.
  const extra = await client.quote(fixture('requests/quote.json'), { owner: OWNER });
  assert.deepEqual(extra.failure, { kind: 'network' });
  assert.deepEqual(transport.unscripted(), ['quote']);
  assert.match(FIXTURE_BANNER, /^Synthetic fixture: not your wallet, not live\./);
});

test('a wrong CSRF is visible in the log as a mismatch, never as the value', async () => {
  const transport = createFixtureTransport({ csrf: CSRF });
  const session = fakeSession({ csrf: 'd'.repeat(43) });
  const client = createCrosschainClient({ transport, runtime, session, clock: fakeClock() });
  transport.script('origins', reply(200, fixtureText('responses/origins.json')));
  await client.origins(fixture('requests/origins.json'), { owner: OWNER });
  assert.deepEqual(transport.calls().map((call) => call.csrfMatched), [false]);
  assert.equal(JSON.stringify(transport.calls()).includes('d'.repeat(43)), false);
});

test('all 28 errors.json pairs validate, come back as that code, and map to the spec’s copy and next step (§3.8)', async () => {
  assert.equal(Object.keys(ERRORS).length, 28);
  assert.deepEqual(Object.keys(CROSSCHAIN_ERROR_UI).sort(), Object.keys(runtime.ERROR_STATUS_BY_CODE).sort());
  const expected = {
    session_required: ['Sign in again to continue.', 'session'],
    csrf_invalid: ['Sign in again to continue.', 'session'],
    account_unsupported: ["This wallet type isn't supported. Use a regular wallet account.", 'account'],
    account_check_unavailable: ["We couldn't check your wallet right now. Try again.", 'retry'],
    origin_not_allowed: ["This page can't reach Domino's service.", 'stop'],
    invalid_request: ['Something went wrong with this request.', 'stop'],
    json_required: ['Something went wrong with this request.', 'stop'],
    method_not_allowed: ['Something went wrong with this request.', 'stop'],
    request_too_large: ['Something went wrong with this request.', 'stop'],
    route_not_available: ["Deposits from another network aren't available right now.", 'feature_off'],
    preview_expired: ['The quote expired. Getting a new one…', 'requote'],
    crosschain_route_unsupported: ["Deposits can't be made from this wallet.", 'stop'],
    crosschain_deposit_not_found: ["We couldn't match this deposit to your wallet. Check the transaction in the explorer.", 'stop_polling'],
    crosschain_listing_unavailable: ['The list of networks is unavailable right now. Try again.', 'later'],
    crosschain_capacity_busy: ['Busy right now. Try again in a moment.', 'backoff'],
    onboarding_capacity_busy: ['Busy right now. Try again in a moment.', 'backoff'],
    session_capacity_busy: ['Busy right now. Try again in a moment.', 'backoff'],
    onboarding_rate_limited: ['Too many requests. Try again in a moment.', 'backoff'],
    session_rate_limited: ['Too many requests. Try again in a moment.', 'backoff'],
    provider_rate_limited: ['Too many requests. Try again in a moment.', 'backoff'],
    provider_request_rejected: ['The bridge provider refused this request.', 'edit'],
    provider_unavailable: ['The bridge provider is unavailable right now.', 'later'],
    request_timeout: ['This took too long. Try again.', 'retry'],
    upstream_timeout: ['This took too long. Try again.', 'retry'],
    upstream_contract_mismatch: ['We got an unexpected answer. Try again.', 'retry_once'],
    upstream_invalid_response: ['We got an unexpected answer. Try again.', 'retry_once'],
    upstream_unavailable: ['Service unavailable right now.', 'later'],
    session_store_unavailable: ['Service unavailable right now.', 'later'],
  };
  assert.deepEqual(Object.keys(expected).sort(), Object.keys(ERRORS).sort());
  for (const [code, { status, body }] of Object.entries(ERRORS)) {
    assert.ok(runtime.validateError(status, body), code);
    assert.equal(runtime.ERROR_STATUS_BY_CODE[code], status, code);
    const { client, transport, session } = lab();
    transport.script('quote', reply(status, body, status === 429 ? { retryAfter: '7' } : {}));
    const out = await client.quote(fixture('requests/quote.json'), { owner: OWNER });
    assert.deepEqual([out.failure.kind, out.failure.code, out.failure.status], ['error', code, status], code);
    if (status === 429) assert.equal(out.failure.retryAfterS, 7, code);
    const disposition = CROSSCHAIN_ERROR_UI[code];
    assert.deepEqual([disposition.copy, disposition.next], expected[code], code);
    assert.equal(disposition.copy.includes(code), false, `${code} never appears in its text`);
    // Denials go to the session, and only denials.
    const denial = ['session_required', 'csrf_invalid', 'account_unsupported'].includes(code) ? [code] : [];
    assert.deepEqual(session.denials, denial, code);
  }
});

test('a neighbouring family’s code, an unknown code or a mismatched pair is an invalid body, not an error; an unknown code reads generic', () => {
  for (const [status, body] of [
    [409, { error: 'deposit_owner_busy' }],
    [400, { error: 'crosschain_everything_is_fine' }],
    [400, { error: 'session_required' }],
    [404, { error: 'route_not_available', detail: 'x' }],
  ]) {
    const out = interpretCrosschain('quote', fixture('requests/quote.json'), raw(status, body), runtime, OWNER, TIMING, 'fixture');
    assert.deepEqual(out.failure, { kind: 'contract', detail: 'error_body' }, JSON.stringify(body));
  }
  const unknown = errorDisposition('crosschain_new_code_2027');
  assert.equal(unknown.copy, GENERIC_ERROR_COPY);
  assert.equal(unknown.code, 'crosschain_new_code_2027', 'kept for a data-* attribute');
  assert.equal(unknown.known, false);
  assert.equal(unknown.copy.includes('crosschain_new_code_2027'), false);
  assert.equal(errorDisposition('preview_expired').known, true);
});

test('a 503 carries its Retry-After (1 to 60 s, else 60) for the backoff; a 429 without one waits 60 s', () => {
  const at = (status, header, code) => interpretCrosschain('status', fixture('requests/status.json'), raw(status, { error: code }, { retryAfterHeader: header }), runtime, OWNER, TIMING, 'fixture').failure;
  assert.equal(at(503, '12', 'provider_unavailable').retryAfterS, 12);
  assert.equal(at(429, null, 'provider_rate_limited').retryAfterS, 60);
  assert.equal(at(429, '0', 'provider_rate_limited').retryAfterS, 60);
  assert.equal(at(429, '61', 'provider_rate_limited').retryAfterS, 60);
  assert.equal(at(429, '1e1', 'provider_rate_limited').retryAfterS, 60);
  assert.equal(at(404, '5', 'crosschain_deposit_not_found').retryAfterS, undefined);
});

test('the http transport (imported by nothing) posts same-origin to /api/crosschain/v1/<route> with the pinned header and the lent CSRF', async () => {
  const posts = [];
  const post = async (url, init, options) => {
    posts.push({ url, init, options });
    const route = url.slice('/api/crosschain/v1/'.length);
    return raw(200, fixture(`responses/${route}.json`));
  };
  const session = fakeSession();
  const client = createCrosschainClient({ transport: createHttpCrosschainTransport({ post }), runtime, session, clock: fakeClock() });
  assert.equal(client.transportKind, 'http');
  for (const route of CROSSCHAIN_ROUTES) {
    const out = await client[route](fixture(`requests/${route}.json`), { owner: OWNER });
    assert.equal(out.ok, true, route);
    assert.equal(out.source, 'http');
  }
  assert.deepEqual(posts.map((p) => p.url), ['/api/crosschain/v1/origins', '/api/crosschain/v1/quote', '/api/crosschain/v1/status']);
  for (const { init, options } of posts) {
    assert.deepEqual(init.headers, {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'X-Domino-Crosschain-Contract': '1.1.0-rc.1',
      'X-Domino-CSRF': CSRF,
    });
    assert.equal(options.contractHeader, 'X-Domino-Crosschain-Contract');
    assert.equal(options.maxBytes, 262144);
    assert.equal(options.timeoutMs, 27_000);
    const sent = JSON.parse(init.body);
    for (const field of ['owner', 'recipient', 'refundTo', 'feeRecipient']) assert.equal(field in sent, false, field);
  }
});
