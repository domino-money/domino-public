/**
 * The session state machine, walked without a browser, a wallet or a network.
 *
 * These are the rules that keep one account's session away from another and
 * keep the wallet from being asked to sign anything the user did not ask for.
 * The browser tests prove the same things end to end; here every branch can
 * be reached directly, including the ones a real service rarely produces.
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { getAddress } from 'viem';
import { FIXTURES, runtime, siweMessage } from './support/session-fixtures.mjs';

const require = createRequire(import.meta.url);
const { reduce, initialMachine, sessionChains } = require('../.test-build/app/src/session/machine.js');
const { ERROR_CLASS } = require('../.test-build/app/src/session/errors.js');

const ORIGIN = 'https://app.example.invalid';
// `chains`: the registry's chains a session is kept across where the second chain's section is open (G11; the controller
// sets it from the page's origin, sessionChains). The tests below that walk G11 run as on the preview alias.
const env = { origin: ORIGIN, checksum: getAddress, chains: [4663, 99801] };
const ADDR_A = FIXTURES.requests.challenge.address;
const ADDR_B = getAddress('0x70997970c51812dc3a010c7d01b50e0d17dc79c8');
const PREAUTH = 'p'.repeat(43);
const CSRF_A = 'a'.repeat(43);
const CSRF_B = 'b'.repeat(43);
const SIGNATURE = FIXTURES.requests.verify.signature;

/** A connected wallet. `connectorUid` is the wagmi connector instance it came through. */
const wallet = (address, chainId = 4663, connectorUid = 'uid-a') => ({
  kind: 'connected',
  connectorUid,
  connectorName: 'Test Wallet',
  address,
  chainId,
});

const ok = (route, body) => ({ ok: true, route, body, serverTime: null });
const code = (route, error) => ({
  ok: false,
  route,
  failure: { kind: 'session_error', status: runtime.ERROR_STATUS_BY_CODE[error], code: error, retryAfterS: null },
  serverTime: null,
});
const broken = (route, kind, extra = {}) => ({ ok: false, route, failure: { kind, ...extra }, serverTime: null });

const session = (address, csrf = CSRF_A) => ({
  ...FIXTURES.responses.me,
  owner: { address: address.toLowerCase(), chainId: 4663 },
  csrfToken: csrf,
});
const challengeFor = (address, origin = ORIGIN) => ({
  challengeId: 'b'.repeat(32),
  expiresAt: '2026-09-10T12:05:00Z',
  message: siweMessage({ origin, address, nonce: 'a'.repeat(32), issuedAt: '2026-09-10T12:00:00Z', expiresAt: '2026-09-10T12:05:00Z' }),
});

// Events that depend on the machine's current epoch are written as functions.
const result = (outcome) => (m) => ({ type: 'result', epoch: m.epoch, outcome });
const signed = (signature = SIGNATURE) => (m) => ({ type: 'signed', epoch: m.epoch, signature });
const identity = (value) => ({ type: 'identity', identity: value });

/** Runs events in order and returns the final machine with every effect emitted. */
function run(machine, ...events) {
  const effects = [];
  for (const event of events) {
    const step = reduce(machine, typeof event === 'function' ? event(machine) : event, env);
    machine = step.machine;
    effects.push(...step.effects);
  }
  return { machine, effects };
}
const then = (start, ...events) => run(start.machine, ...events);
const routes = (effects) => effects.filter((e) => e.type === 'call').map((e) => e.request.route);
const lastCall = (effects) => effects.filter((e) => e.type === 'call').at(-1)?.request;
const signs = (effects) => effects.filter((e) => e.type === 'sign');
const types = (effects) => effects.map((e) => e.type);

/** Connected as `address` on 4663, through `who`, told there is no session. */
const signedOut = (address = ADDR_A, who = wallet(address)) => run(initialMachine, identity(who), result(code('me', 'session_required')));
/** Asked the wallet to sign and waiting. */
const awaitingSignature = (address = ADDR_A, who = wallet(address)) =>
  then(
    signedOut(address, who),
    { type: 'sign_in' },
    result(ok('bootstrap', { ...FIXTURES.responses.bootstrap, csrfToken: PREAUTH })),
    result(ok('challenge', challengeFor(address))),
  );
/** Signed in as `address`. */
const signedIn = (address = ADDR_A, csrf = CSRF_A, who = wallet(address)) =>
  then(awaitingSignature(address, who), signed(), result(ok('verify', session(address, csrf))));
/** Signed, with verify in flight. Its effects end at the verify request. */
const verifying = (address = ADDR_A) => then(awaitingSignature(address), signed());

test('the error table covers exactly the codes the runtime defines', () => {
  assert.deepEqual(Object.keys(ERROR_CLASS).sort(), Object.keys(runtime.ERROR_STATUS_BY_CODE).sort());
  assert.equal(Object.keys(ERROR_CLASS).length, 22);
});

test('the first identity on Robinhood Chain reads me and nothing else', () => {
  const start = run(initialMachine, identity(wallet(ADDR_A)));
  assert.deepEqual(routes(start.effects), ['me']);
  assert.equal(start.machine.view.status, 'checking');
  const out = then(start, result(code('me', 'session_required')));
  assert.deepEqual(out.machine.view, { status: 'signed_out', reason: 'none' });
  assert.deepEqual(out.effects, []);
});

test('a wallet on another chain reads nothing and is asked to switch', () => {
  const out = run(initialMachine, identity(wallet(ADDR_A, 1)));
  assert.deepEqual(out.machine.view, { status: 'wrong_network', chainId: 1 });
  assert.deepEqual(out.effects, []);
  // Expiry, focus and other tabs do not read me on the wrong chain either.
  for (const cause of ['expiry', 'visible', 'remote']) {
    assert.deepEqual(then(out, { type: 'recheck', cause }).effects, []);
  }
});

test('a sign-in asks for exactly one signature, only after the challenge check, and verifies with the preauth CSRF', () => {
  const start = signedOut();
  const out = then(start, { type: 'sign_in' });
  assert.deepEqual(routes(out.effects), ['bootstrap']);
  assert.equal(lastCall(out.effects).csrf, undefined);

  const withPreauth = then(out, result(ok('bootstrap', { ...FIXTURES.responses.bootstrap, csrfToken: PREAUTH })));
  assert.deepEqual(lastCall(withPreauth.effects), { route: 'challenge', body: { address: ADDR_A, chainId: 4663 }, csrf: PREAUTH });

  const asked = then(withPreauth, result(ok('challenge', challengeFor(ADDR_A))));
  assert.deepEqual(signs(asked.effects), [{ type: 'sign', epoch: asked.machine.epoch, address: ADDR_A, message: challengeFor(ADDR_A).message }]);

  const verifying = then(asked, signed());
  assert.deepEqual(lastCall(verifying.effects), {
    route: 'verify',
    body: { challengeId: 'b'.repeat(32), message: challengeFor(ADDR_A).message, signature: SIGNATURE },
    csrf: PREAUTH,
  });

  const done = then(verifying, result(ok('verify', session(ADDR_A))));
  assert.equal(done.machine.view.status, 'signed_in');
  assert.deepEqual(types(done.effects), ['private_identity', 'schedule_expiry', 'broadcast']);
  assert.equal(done.machine.preauthCsrf, null);
});

test('no failure, at any step, asks for a signature or restarts sign-in on its own', () => {
  const steps = {
    me: () => run(initialMachine, identity(wallet(ADDR_A))),
    bootstrap: () => then(signedOut(), { type: 'sign_in' }),
    challenge: () => then(signedOut(), { type: 'sign_in' }, result(ok('bootstrap', { ...FIXTURES.responses.bootstrap, csrfToken: PREAUTH }))),
    verify: () => then(awaitingSignature(), signed()),
    logout: () => then(signedIn(), { type: 'sign_out' }),
  };
  const failures = [
    ...Object.keys(runtime.ERROR_STATUS_BY_CODE).map((error) => (route) => code(route, error)),
    ...['gate_required', 'gate_unavailable', 'network_error', 'timeout', 'aborted', 'runtime_error'].map(
      (kind) => (route) => broken(route, kind),
    ),
    (route) => broken(route, 'not_routed', { status: 200 }),
    (route) => broken(route, 'not_routed', { status: 502 }),
    (route) => broken(route, 'contract_mismatch', { detail: 'body' }),
  ];
  let walked = 0;
  for (const [step, start] of Object.entries(steps)) {
    for (const failure of failures) {
      let state = then(start(), result(failure(step)));
      const effects = [...state.effects];
      // Answer every follow-up request with the same failure, a few rounds deep.
      for (let round = 0; round < 4; round += 1) {
        const pending = lastCall(state.effects);
        if (!pending) break;
        state = then(state, result(failure(pending.route)));
        effects.push(...state.effects);
      }
      const label = `${step} → ${JSON.stringify(failure(step).failure)}`;
      assert.deepEqual(signs(effects), [], label);
      assert.deepEqual(routes(effects).filter((route) => route !== 'me' && route !== 'logout'), [], label);
      assert.notEqual(state.machine.view.status, 'signed_in', label);
      walked += 1;
    }
  }
  assert.equal(walked, 5 * 31);
});

test('account_unsupported after a valid signature stops everything for that address', () => {
  const out = then(verifying(), result(code('verify', 'account_unsupported')));
  // Nothing but the preauth abort is sent after the denial; it lands blocked.
  assert.deepEqual(out.machine.view, { status: 'signing_in', step: 'closing' });
  assert.deepEqual(routes(out.effects), ['logout']);
  const closed = then(out, result(ok('logout', FIXTURES.responses.logout)));
  assert.deepEqual(closed.machine.view, { status: 'blocked', failure: 'account_unsupported', retry: 'none', retryAfterS: null });
  for (const event of [{ type: 'sign_in' }, { type: 'retry' }, { type: 'recheck', cause: 'remote' }, { type: 'recheck', cause: 'expiry' }]) {
    assert.deepEqual(then(closed, event).effects, [], JSON.stringify(event));
  }
  // Reconnecting the same address on the same page stays denied without a request.
  const again = then(closed, identity({ kind: 'disconnected' }), identity(wallet(ADDR_A)));
  assert.deepEqual(routes(again.effects), []);
  assert.deepEqual(again.machine.view, { status: 'blocked', failure: 'account_unsupported', retry: 'none', retryAfterS: null });
  // Another address is not affected.
  assert.deepEqual(routes(then(closed, identity(wallet(ADDR_B))).effects), ['me']);
});

test('a 503 is an unavailable state, never signed out, and trying again only reads me', () => {
  for (const error of ['session_store_unavailable', 'account_check_unavailable', 'upstream_unavailable']) {
    const out = then(run(initialMachine, identity(wallet(ADDR_A))), result(code('me', error)));
    assert.equal(out.machine.view.status, 'blocked', error);
    assert.equal(out.machine.view.retry, 'check', error);
    assert.deepEqual(routes(then(out, { type: 'retry' }).effects), ['me'], error);
  }
  const store = then(run(initialMachine, identity(wallet(ADDR_A))), result(code('me', 'session_store_unavailable')));
  assert.equal(store.machine.view.failure, 'store_unavailable');
});

test('switching account while signed in drops private data and signs the old session out', () => {
  const start = signedIn();
  const out = then(start, identity(wallet(ADDR_B)));
  assert.equal(out.machine.epoch, start.machine.epoch + 1);
  assert.deepEqual(types(out.effects), ['abort_inflight', 'cancel_expiry', 'clear_private', 'call']);
  assert.deepEqual(lastCall(out.effects), { route: 'logout', csrf: CSRF_A });
  assert.deepEqual(out.machine.view, { status: 'signing_out' });
  assert.equal(out.machine.session, null);

  const landed = then(out, result(ok('logout', FIXTURES.responses.logout)));
  assert.deepEqual(landed.machine.view, { status: 'signed_out', reason: 'identity_changed' });
  assert.ok(types(landed.effects).includes('broadcast'));
  assert.deepEqual(signs(landed.effects), []);
  assert.deepEqual(routes(landed.effects), []);
});

test('switching network while signed in signs out once and then reads nothing until the chain is back', () => {
  const out = then(signedIn(), identity(wallet(ADDR_A, 1)));
  assert.deepEqual(routes(out.effects), ['logout']);
  const landed = then(out, result(ok('logout', FIXTURES.responses.logout)));
  assert.deepEqual(landed.machine.view, { status: 'wrong_network', chainId: 1 });
  assert.deepEqual(routes(landed.effects), []);
  const back = then(landed, identity(wallet(ADDR_A)));
  assert.deepEqual(routes(back.effects), ['me']);
  const fresh = then(back, result(code('me', 'session_required')));
  assert.deepEqual(fresh.machine.view, { status: 'signed_out', reason: 'none' });
});

test('a connector change for the same address is an identity change too', () => {
  const out = then(signedIn(), identity(wallet(ADDR_A, 4663, 'uid-b')));
  assert.deepEqual(lastCall(out.effects), { route: 'logout', csrf: CSRF_A });
});

test('two providers announcing the same rdns are two wallets: moving from one to the other ends the session', () => {
  // A provider declares its own EIP-6963 rdns, so two can share one; the
  // identity used to carry it as `connectorId`. wagmi makes a connector, with
  // its own uid, for each announced provider, and that instance is the wallet.
  const RDNS = 'test.wallet.shared';
  const first = { ...wallet(ADDR_A, 4663, 'uid-a'), connectorId: RDNS };
  const second = { ...wallet(ADDR_A, 4663, 'uid-b'), connectorId: RDNS };
  const start = signedIn(ADDR_A, CSRF_A, first);
  const out = then(start, identity(second));
  assert.equal(out.machine.epoch, start.machine.epoch + 1, 'a new epoch, so a new private scope');
  assert.deepEqual(types(out.effects), ['abort_inflight', 'cancel_expiry', 'clear_private', 'call']);
  assert.deepEqual(lastCall(out.effects), { route: 'logout', csrf: CSRF_A });
  const landed = then(out, result(ok('logout', FIXTURES.responses.logout)));
  assert.deepEqual(landed.machine.view, { status: 'signed_out', reason: 'identity_changed' });
  assert.deepEqual(signs(landed.effects), []);
  // The same instance reported again is not a change.
  assert.equal(then(start, identity({ ...first })).machine, start.machine);
});

test('disconnecting the wallet signs out and shows no wallet', () => {
  const out = then(signedIn(), identity({ kind: 'disconnected' }), result(ok('logout', FIXTURES.responses.logout)));
  assert.deepEqual(out.machine.view, { status: 'no_wallet' });
});

test("a result that arrives after a switch is discarded: A's me never reaches B", () => {
  const pending = run(initialMachine, identity(wallet(ADDR_A)));
  const epochA = pending.machine.epoch;
  const switched = then(pending, identity(wallet(ADDR_B)));
  const late = run(switched.machine, { type: 'result', epoch: epochA, outcome: ok('me', session(ADDR_A)) });
  assert.equal(late.machine, switched.machine, 'the machine must be untouched');
  assert.deepEqual(late.effects, []);
});

test('a stale successful verify revokes the session it created and shows nothing', () => {
  const pending = then(awaitingSignature(), signed());
  const epoch = pending.machine.epoch;
  const switched = then(pending, identity(wallet(ADDR_B)));
  const late = run(switched.machine, { type: 'result', epoch, outcome: ok('verify', session(ADDR_A)) });
  assert.equal(late.machine, switched.machine);
  assert.deepEqual(late.effects, [{ type: 'cleanup_logout', csrf: CSRF_A }]);
});

test('switching during a sign-in abandons it: the late signature is ignored and the login is aborted', () => {
  const waiting = awaitingSignature();
  const epoch = waiting.machine.epoch;
  const switched = then(waiting, identity(wallet(ADDR_B)));
  assert.deepEqual(lastCall(switched.effects), { route: 'logout', csrf: PREAUTH });
  const late = run(switched.machine, { type: 'signed', epoch, signature: SIGNATURE });
  assert.equal(late.machine, switched.machine);
  assert.deepEqual(late.effects, []);
});

test('an abort refused for its CSRF recovers the session CSRF from me and closes it, once', () => {
  // Verify's headers landed (session cookie set, preauth cookie cleared) but
  // its body did not: the preauth abort cannot match any more.
  const switched = then(then(awaitingSignature(), signed()), identity(wallet(ADDR_B)));
  const refused = then(switched, result(code('logout', 'csrf_invalid')));
  assert.deepEqual(routes(refused.effects), ['me']);
  const recovered = then(refused, result(ok('me', session(ADDR_A, CSRF_A))));
  assert.deepEqual(lastCall(recovered.effects), { route: 'logout', csrf: CSRF_A });
  const again = then(recovered, result(code('logout', 'csrf_invalid')));
  assert.deepEqual(routes(again.effects), [], 'never more than one retry');
  assert.deepEqual(again.machine.view, { status: 'signed_out', reason: 'identity_changed' });
});

test("the CSRF recovery never closes another account's session", () => {
  const switched = then(then(awaitingSignature(), signed()), identity(wallet(ADDR_B)));
  const out = then(switched, result(code('logout', 'csrf_invalid')), result(ok('me', session(ADDR_B, CSRF_B))));
  assert.deepEqual(routes(out.effects).filter((route) => route === 'logout'), []);
});

test('a user sign-out refused for its CSRF retries once, then says it is unconfirmed', () => {
  const out = then(
    signedIn(),
    { type: 'sign_out' },
    result(code('logout', 'csrf_invalid')),
    result(ok('me', session(ADDR_A, CSRF_A))),
    result(code('logout', 'csrf_invalid')),
  );
  assert.deepEqual(out.machine.view, { status: 'blocked', failure: 'signout_unconfirmed', retry: 'sign_out', retryAfterS: null });
  assert.deepEqual(then(out, { type: 'sign_in' }).effects, [], 'sign-in waits for a confirmed sign-out');
});

test('a lost verify response is recovered through me without a second signature', () => {
  const lost = then(verifying(), result(broken('verify', 'network_error')));
  assert.deepEqual(routes(lost.effects), ['me']);
  const recovered = then(lost, result(ok('me', session(ADDR_A))));
  assert.equal(recovered.machine.view.status, 'signed_in');
  assert.deepEqual(signs([...lost.effects, ...recovered.effects]), []);
});

test('a lost verify response with no session aborts the preauth and never replays the signature', () => {
  const out = then(awaitingSignature(), signed(), result(broken('verify', 'timeout')), result(code('me', 'session_required')));
  assert.deepEqual(lastCall(out.effects), { route: 'logout', csrf: PREAUTH });
  const landed = then(out, result(ok('logout', FIXTURES.responses.logout)));
  assert.deepEqual(landed.machine.view, { status: 'signed_out', reason: 'lost_response' });
  assert.deepEqual(routes(landed.effects), []);
});

test('preauth_required at verify still closes the context, in case an earlier attempt committed', () => {
  const out = then(verifying(), result(code('verify', 'preauth_required')));
  assert.deepEqual(lastCall(out.effects), { route: 'logout', csrf: PREAUTH });
  // If the context itself has lapsed, the abort is refused too; me confirms
  // there is no session to close, and the flow lands without a signature.
  const refused = then(out, result(code('logout', 'preauth_required')));
  assert.deepEqual(routes(refused.effects), ['me']);
  const landed = then(refused, result(code('me', 'session_required')));
  assert.deepEqual(landed.machine.view, { status: 'signed_out', reason: 'preauth_expired' });
  assert.deepEqual(signs([...refused.effects, ...landed.effects]), []);
});

test('every 5xx at verify is treated as possibly committed: me first, then the preauth abort', () => {
  for (const error of ['upstream_timeout', 'request_timeout', 'upstream_unavailable', 'session_store_unavailable', 'upstream_invalid_response', 'upstream_contract_mismatch', 'account_check_unavailable']) {
    const out = then(verifying(), result(code('verify', error)));
    assert.deepEqual(routes(out.effects), ['me'], error);
    const aborted = then(out, result(code('me', 'session_required')));
    assert.deepEqual(lastCall(aborted.effects), { route: 'logout', csrf: PREAUTH }, error);
    const landed = then(aborted, result(ok('logout', FIXTURES.responses.logout)));
    assert.equal(landed.machine.view.status, 'blocked', error);
  }
});

test('a platform 5xx at verify without the contract header is treated as possibly committed too', () => {
  // A header-less 503 looks like a broken gate; 500, 502, 504 and 52x come
  // from the edge or a Worker failure. Any of them can follow the store's
  // commit, so the preauth CSRF must survive to abort it.
  const cases = [
    [broken('verify', 'gate_unavailable'), 'gate_unavailable'],
    ...[500, 502, 504, 520, 522, 524].map((status) => [broken('verify', 'not_routed', { status }), 'service_unavailable']),
  ];
  for (const [outcome, failure] of cases) {
    const label = JSON.stringify(outcome.failure);
    const out = then(verifying(), result(outcome));
    assert.deepEqual(routes(out.effects), ['me'], label);
    assert.equal(out.machine.preauthCsrf, PREAUTH, label);
    // The applied cookie, if any, recovers the session without a signature.
    assert.equal(then(out, result(ok('me', session(ADDR_A)))).machine.view.status, 'signed_in', label);
    const aborted = then(out, result(code('me', 'session_required')));
    assert.deepEqual(lastCall(aborted.effects), { route: 'logout', csrf: PREAUTH }, label);
    const landed = then(aborted, result(ok('logout', FIXTURES.responses.logout)));
    assert.deepEqual(landed.machine.view, { status: 'blocked', failure, retry: 'check', retryAfterS: null }, label);
    // Checking again reads me, then sign-in is offered again.
    const checked = then(landed, { type: 'retry' }, result(code('me', 'session_required')));
    assert.deepEqual(checked.machine.view, { status: 'signed_out', reason: 'none' }, label);
    assert.deepEqual(signs([...out.effects, ...aborted.effects, ...landed.effects, ...checked.effects]), [], label);
  }
  // If the gate really is down, the abort fails harmlessly and the flow lands.
  const down = then(
    verifying(),
    result(broken('verify', 'gate_unavailable')),
    result(broken('me', 'gate_unavailable')),
    result(broken('logout', 'gate_unavailable')),
  );
  assert.deepEqual(down.machine.view, { status: 'blocked', failure: 'gate_unavailable', retry: 'check', retryAfterS: null });
  assert.deepEqual(routes(down.effects), ['me', 'logout'], 'one read, one abort, nothing more');
});

test('verify answers that never reached the store stop without a request', () => {
  for (const outcome of [broken('verify', 'gate_required'), broken('verify', 'not_routed', { status: 404 }), broken('verify', 'not_routed', { status: 200 })]) {
    const out = then(verifying(), result(outcome));
    assert.deepEqual(out.effects, [], JSON.stringify(outcome.failure));
    assert.equal(out.machine.view.status, 'blocked');
  }
});

test('a verify 200 that fails validation is never adopted; the session it made is closed', () => {
  const out = then(verifying(), result(broken('verify', 'contract_mismatch', { detail: 'body' })));
  assert.deepEqual(routes(out.effects), ['me']);
  const closing = then(out, result(ok('me', session(ADDR_A, CSRF_A))));
  assert.deepEqual(lastCall(closing.effects), { route: 'logout', csrf: CSRF_A });
  const landed = then(closing, result(ok('logout', FIXTURES.responses.logout)));
  assert.equal(landed.machine.view.failure, 'contract_mismatch');
});

test('session_exists is adopted through me without a signature, and a stranger’s session is not', () => {
  const start = then(then(signedOut(), { type: 'sign_in' }), result(code('bootstrap', 'session_exists')));
  assert.deepEqual(routes(start.effects), ['me']);
  const adopted = then(start, result(ok('me', session(ADDR_A))));
  assert.equal(adopted.machine.view.status, 'signed_in');
  const other = then(start, result(ok('me', session(ADDR_B, CSRF_B))));
  assert.deepEqual(other.machine.view, { status: 'other_session', owner: ADDR_B.toLowerCase() });
  // Signing that session out uses its own CSRF, read from me.
  assert.deepEqual(lastCall(then(other, { type: 'sign_out' }).effects), { route: 'logout', csrf: CSRF_B });
});

test('a replayed or expired challenge ends the attempt; nothing is signed again', () => {
  const out = then(awaitingSignature(), signed(), result(code('verify', 'challenge_invalid')));
  assert.deepEqual(lastCall(out.effects), { route: 'logout', csrf: PREAUTH });
  const landed = then(out, result(ok('logout', FIXTURES.responses.logout)));
  assert.deepEqual(landed.machine.view, { status: 'signed_out', reason: 'challenge_expired' });
  assert.deepEqual(signs(landed.effects), []);
});

test('a message that does not match this page is never shown to the wallet', () => {
  for (const challenge of [challengeFor(ADDR_A, 'https://evil.example'), challengeFor(ADDR_B)]) {
    const out = then(
      signedOut(),
      { type: 'sign_in' },
      result(ok('bootstrap', { ...FIXTURES.responses.bootstrap, csrfToken: PREAUTH })),
      result(ok('challenge', challenge)),
    );
    assert.deepEqual(signs(out.effects), []);
    assert.deepEqual(lastCall(out.effects), { route: 'logout', csrf: PREAUTH });
    const landed = then(out, result(ok('logout', FIXTURES.responses.logout)));
    assert.equal(landed.machine.view.failure, 'untrusted_challenge');
  }
});

test('a declined signature closes the login and asks for nothing more', () => {
  const waiting = awaitingSignature();
  const out = run(waiting.machine, { type: 'sign_failed', epoch: waiting.machine.epoch, reason: 'user_rejected' });
  assert.deepEqual(lastCall(out.effects), { route: 'logout', csrf: PREAUTH });
  const landed = then(out, result(ok('logout', FIXTURES.responses.logout)));
  assert.deepEqual(landed.machine.view, { status: 'signed_out', reason: 'signature_declined' });
});

test('a signature the contract refuses to send closes the login', () => {
  const waiting = then(awaitingSignature(), signed('0x1234'));
  const out = run(waiting.machine, { type: 'request_refused', epoch: waiting.machine.epoch });
  assert.deepEqual(lastCall(out.effects), { route: 'logout', csrf: PREAUTH });
});

test('expiry or revocation found by me clears private data and signs out', () => {
  const out = then(signedIn(), { type: 'recheck', cause: 'expiry' });
  assert.deepEqual(routes(out.effects), ['me']);
  assert.equal(out.machine.view.status, 'signed_in', 'the view holds while checking');
  const ended = then(out, result(code('me', 'session_required')));
  assert.deepEqual(ended.machine.view, { status: 'signed_out', reason: 'session_ended' });
  assert.deepEqual(types(ended.effects), ['clear_private', 'cancel_expiry']);
  assert.equal(ended.machine.session, null);
});

test('a user sign-out uses the session CSRF and tells other tabs', () => {
  const out = then(signedIn(), { type: 'sign_out' });
  assert.deepEqual(lastCall(out.effects), { route: 'logout', csrf: CSRF_A });
  assert.ok(types(out.effects).includes('clear_private'));
  const landed = then(out, result(ok('logout', FIXTURES.responses.logout)));
  assert.deepEqual(landed.machine.view, { status: 'signed_out', reason: 'logged_out' });
  assert.ok(types(landed.effects).includes('broadcast'));
});

test("another tab's change is read back through me, and never re-announced", () => {
  const out = then(signedOut(), { type: 'recheck', cause: 'remote' });
  assert.deepEqual(routes(out.effects), ['me']);
  const adopted = then(out, result(ok('me', session(ADDR_A))));
  assert.equal(adopted.machine.view.status, 'signed_in');
  assert.ok(!types(adopted.effects).includes('broadcast'), 'a tab must not echo what it learned from another');
});

test('the view never carries a credential, a message or a signature', () => {
  const walk = [signedOut(), awaitingSignature(), then(awaitingSignature(), signed()), signedIn(), then(signedIn(), identity(wallet(ADDR_B)))];
  for (const { machine } of walk) {
    const text = JSON.stringify(machine.view);
    for (const secret of [PREAUTH, CSRF_A, SIGNATURE, 'Nonce:']) assert.ok(!text.includes(secret), text);
  }
});

test("a recheck that arrives while this tab's me is in flight runs after it: another tab's sign-out is not lost", () => {
  const checking = then(signedIn(), { type: 'recheck', cause: 'visible' });
  assert.deepEqual(routes(checking.effects), ['me']);
  // The other tab signs out while this me is on the wire.
  const told = then(checking, { type: 'recheck', cause: 'remote' });
  assert.deepEqual(told.effects, []);
  assert.equal(told.machine.recheckPending, true);
  assert.deepEqual(then(told, { type: 'recheck', cause: 'remote' }).effects, [], 'several arrivals still make one check');
  // This me was answered before the sign-out committed.
  const stale = then(told, result(ok('me', session(ADDR_A))));
  assert.equal(stale.machine.view.status, 'signed_in');
  assert.deepEqual(routes(stale.effects), ['me'], 'the waiting recheck runs at once');
  assert.equal(stale.machine.recheckPending, false);
  const ended = then(stale, result(code('me', 'session_required')));
  assert.deepEqual(ended.machine.view, { status: 'signed_out', reason: 'session_ended' });
  assert.ok(types(ended.effects).includes('clear_private'));
});

test('a waiting recheck after a sign-in keeps the reason on screen and never signs', () => {
  const waiting = then(awaitingSignature(), { type: 'recheck', cause: 'remote' });
  const declined = run(waiting.machine, { type: 'sign_failed', epoch: waiting.machine.epoch, reason: 'user_rejected' });
  const closed = then(declined, result(ok('logout', FIXTURES.responses.logout)));
  assert.deepEqual(routes(closed.effects), ['me']);
  const landed = then(closed, result(code('me', 'session_required')));
  assert.deepEqual(landed.machine.view, { status: 'signed_out', reason: 'signature_declined' });
  assert.deepEqual(signs([...closed.effects, ...landed.effects]), []);
});

test('a waiting recheck is dropped by an identity change and never retries a failure', () => {
  const told = then(signedIn(), { type: 'recheck', cause: 'visible' }, { type: 'recheck', cause: 'remote' });
  const switched = then(told, identity(wallet(ADDR_B)));
  assert.equal(switched.machine.recheckPending, false);
  const landed = then(switched, result(ok('logout', FIXTURES.responses.logout)));
  assert.deepEqual(routes(landed.effects), []);
  assert.deepEqual(landed.machine.view, { status: 'signed_out', reason: 'identity_changed' });

  const failing = then(signedIn(), { type: 'recheck', cause: 'visible' }, { type: 'recheck', cause: 'remote' });
  const down = then(failing, result(code('me', 'session_store_unavailable')));
  assert.equal(down.machine.view.status, 'signed_in');
  assert.deepEqual(routes(down.effects), [], 'a pending check never bypasses outage backoff');
  assert.ok(down.effects.some((effect) => effect.type === 'check_failed'));
  assert.ok(!down.effects.some((effect) => effect.type === 'clear_private'));

  const denied = then(verifying(), { type: 'recheck', cause: 'remote' }, result(code('verify', 'account_unsupported')));
  assert.deepEqual(denied.effects.filter((e) => e.type === 'sign'), [], 'no signature after account_unsupported');
  assert.deepEqual(routes(denied.effects), ['logout'], 'only the preauth abort');
});

test('a Sign out click during a background me is not lost: the check is abandoned and the session signed out', () => {
  const checking = then(signedIn(), { type: 'recheck', cause: 'visible' });
  assert.deepEqual(checking.machine.flow, { kind: 'me', purpose: 'restore', wasSignedIn: true });
  const out = then(checking, { type: 'sign_out' });
  assert.deepEqual(types(out.effects), ['abort_inflight', 'cancel_expiry', 'clear_private', 'call']);
  assert.deepEqual(lastCall(out.effects), { route: 'logout', csrf: CSRF_A });
  assert.deepEqual(out.machine.view, { status: 'signing_out' });
  assert.ok(out.machine.epoch > checking.machine.epoch);
  // The check's answer lands afterwards, under the old epoch, and changes nothing.
  const late = run(out.machine, { type: 'result', epoch: checking.machine.epoch, outcome: ok('me', session(ADDR_A)) });
  assert.deepEqual(late.effects, []);
  assert.deepEqual(late.machine.view, { status: 'signing_out' });
  const landed = then(late, result(ok('logout', FIXTURES.responses.logout)));
  assert.deepEqual(landed.machine.view, { status: 'signed_out', reason: 'logged_out' });
  assert.equal(landed.machine.session, null);
  assert.ok(types(landed.effects).includes('broadcast'));
  assert.deepEqual(routes(landed.effects), []);
});

test('a Sign out click also wins over a waiting recheck, and over a check of another session', () => {
  const told = then(signedIn(), { type: 'recheck', cause: 'visible' }, { type: 'recheck', cause: 'remote' });
  const out = then(told, { type: 'sign_out' });
  assert.equal(out.machine.recheckPending, false);
  assert.deepEqual(lastCall(out.effects), { route: 'logout', csrf: CSRF_A });
  assert.deepEqual(routes(then(out, result(ok('logout', FIXTURES.responses.logout))).effects), [], 'no check after the sign-out');

  const other = then(signedOut(), { type: 'sign_in' }, result(code('bootstrap', 'session_exists')), result(ok('me', session(ADDR_B, CSRF_B))));
  assert.equal(other.machine.view.status, 'other_session');
  const checking = then(other, { type: 'recheck', cause: 'remote' });
  assert.deepEqual(routes(checking.effects), ['me']);
  const signingOut = then(checking, { type: 'sign_out' });
  assert.equal(signingOut.effects[0].type, 'abort_inflight');
  assert.deepEqual(lastCall(signingOut.effects), { route: 'logout', csrf: CSRF_B });

  // Signed out, there is nothing to sign out: the check keeps running.
  const idle = then(signedOut(), { type: 'recheck', cause: 'remote' });
  const ignored = then(idle, { type: 'sign_out' });
  assert.deepEqual(ignored.effects, []);
  assert.deepEqual(ignored.machine.flow, idle.machine.flow);
});

test('a Sign in click during a background me starts the sign-in; a session another tab made is adopted without signing', () => {
  const checking = then(signedOut(), { type: 'recheck', cause: 'remote' });
  const out = then(checking, { type: 'sign_in' });
  assert.deepEqual(types(out.effects), ['abort_inflight', 'call']);
  assert.deepEqual(routes(out.effects), ['bootstrap']);
  assert.deepEqual(out.machine.view, { status: 'signing_in', step: 'bootstrap' });
  const late = run(out.machine, { type: 'result', epoch: checking.machine.epoch, outcome: ok('me', session(ADDR_A)) });
  assert.deepEqual(late.effects, []);
  const adopted = then(late, result(code('bootstrap', 'session_exists')), result(ok('me', session(ADDR_A))));
  assert.equal(adopted.machine.view.status, 'signed_in');
  assert.deepEqual(signs(adopted.effects), []);
});

test('only a session verify just created is scheduled as fresh', () => {
  const fresh = (effects) => effects.filter((e) => e.type === 'schedule_expiry').map((e) => e.fresh);
  const done = then(verifying(), result(ok('verify', session(ADDR_A))));
  assert.deepEqual(fresh(done.effects), [true]);
  assert.deepEqual(fresh(then(verifying(), result(broken('verify', 'network_error')), result(ok('me', session(ADDR_A)))).effects), [true]);
  assert.deepEqual(fresh(then(run(initialMachine, identity(wallet(ADDR_A))), result(ok('me', session(ADDR_A)))).effects), [false]);
  assert.deepEqual(fresh(then(done, { type: 'recheck', cause: 'expiry' }, result(ok('me', session(ADDR_A)))).effects), [false]);
});

test('a new session for the same owner, found by a background me, gets a new epoch and nothing of the old one', () => {
  const CSRF_C = 'c'.repeat(43);
  const start = signedIn();
  const out = then(start, { type: 'recheck', cause: 'visible' }, result(ok('me', session(ADDR_A, CSRF_C))));
  assert.equal(out.machine.view.status, 'signed_in');
  assert.equal(out.machine.session.csrf, CSRF_C);
  assert.ok(out.machine.epoch > start.machine.epoch, 'the new server session has its own private scope');
  assert.deepEqual(types(out.effects), ['call', 'clear_private', 'cancel_expiry', 'private_identity', 'schedule_expiry']);
  assert.deepEqual(signs(out.effects), []);

  // The same session read back again keeps its scope and its data.
  const again = then(out, { type: 'recheck', cause: 'expiry' }, result(ok('me', session(ADDR_A, CSRF_C))));
  assert.equal(again.machine.epoch, out.machine.epoch);
  assert.deepEqual(types(again.effects), ['call', 'private_identity', 'schedule_expiry']);
});

test('a new session behind a coalesced recheck is still told apart from the old one', () => {
  const CSRF_C = 'c'.repeat(43);
  const start = signedIn();
  // Another tab signs out and in again while this tab's own me is in flight.
  const told = then(start, { type: 'recheck', cause: 'expiry' }, { type: 'recheck', cause: 'remote' }, { type: 'recheck', cause: 'remote' });
  const first = then(told, result(ok('me', session(ADDR_A, CSRF_A))));
  assert.equal(first.machine.epoch, start.machine.epoch, 'the answer from before is still the same session');
  assert.deepEqual(routes(first.effects), ['me'], 'the waiting recheck runs');
  const second = then(first, result(ok('me', session(ADDR_A, CSRF_C))));
  assert.ok(second.machine.epoch > start.machine.epoch);
  assert.deepEqual(types(second.effects).slice(0, 2), ['clear_private', 'cancel_expiry']);
  // The late answer of the old epoch's me, if any, is stale.
  const late = run(second.machine, { type: 'result', epoch: start.machine.epoch, outcome: ok('me', session(ADDR_A, CSRF_A)) });
  assert.deepEqual(late.effects, []);
  assert.equal(late.machine.session.csrf, CSRF_C);
});

test('a session that ended and a later one for the same owner never share an epoch', () => {
  const start = signedIn();
  const ended = then(start, { type: 'recheck', cause: 'visible' }, result(code('me', 'session_required')));
  assert.equal(ended.machine.view.status, 'signed_out');
  assert.ok(types(ended.effects).includes('clear_private'));
  const back = then(ended, { type: 'recheck', cause: 'remote' }, result(ok('me', session(ADDR_A, 'c'.repeat(43)))));
  assert.equal(back.machine.view.status, 'signed_in');
  assert.ok(back.machine.epoch > start.machine.epoch);
});

// ---------------------------------------------------------------------------
// 2026-10-01, the chain2 workstream, part B, audit item G11: the session is the account's, not the network's. A signed-in
// account whose wallet moves to the second chain's network (another chain of the registry, config/chainIdentity.ts
// REGISTRY_CHAIN_IDS) keeps its session, and is signed in again on its way back without a signature. Anything else is an
// identity change as it always was: another account or wallet, a chain outside the registry, or a flow in progress.
// ---------------------------------------------------------------------------

const ELYSIUM = 99801;

test('a signed-in account whose wallet moves to the second chain keeps its session, asks nothing there, and comes back signed in without a signature', () => {
  const start = signedIn();
  const away = then(start, identity(wallet(ADDR_A, ELYSIUM)));
  assert.deepEqual(away.machine.view, { status: 'wrong_network', chainId: ELYSIUM }, 'Robinhood Chain\'s screens say the wallet is elsewhere, as for any other chain');
  assert.deepEqual(types(away.effects), ['abort_inflight', 'cancel_expiry', 'clear_private'], 'nothing asked, nothing closed; what was read for the chain left behind is dropped');
  assert.deepEqual(away.machine.session, start.machine.session, 'the session is kept');
  assert.equal(away.machine.epoch, start.machine.epoch + 1, 'a new epoch: nothing read before reaches the new chain');
  // Nothing is read for the session while the wallet is away: no check, no renewal.
  for (const event of [{ type: 'recheck', cause: 'expiry' }, { type: 'recheck', cause: 'visible' }, { type: 'recheck', cause: 'remote' }, { type: 'refresh' }, { type: 'sign_in' }]) {
    assert.deepEqual(then(away, event).effects, [], event.type);
  }
  const back = then(away, identity(wallet(ADDR_A)));
  assert.deepEqual(routes(back.effects), ['me'], 'back on Robinhood Chain: me, and nothing else');
  assert.equal(back.machine.view.status, 'checking');
  const landed = then(back, result(ok('me', session(ADDR_A))));
  assert.equal(landed.machine.view.status, 'signed_in');
  assert.equal(landed.machine.view.owner, ADDR_A.toLowerCase());
  assert.deepEqual(signs([...away.effects, ...back.effects, ...landed.effects]), [], 'no signature at any point');
  assert.deepEqual(routes([...away.effects, ...back.effects, ...landed.effects]).filter((route) => route !== 'me'), [], 'no logout, no bootstrap, no challenge');
  assert.ok(types(landed.effects).includes('schedule_expiry'), 'its deadline is placed again');
  // A session that ended while the wallet was away: signed out, as a check finds it.
  const ended = then(back, result(code('me', 'session_required')));
  assert.deepEqual([ended.machine.view, ended.machine.session], [{ status: 'signed_out', reason: 'session_ended' }, null]);
});

test('a sign-out while the wallet is away closes the kept session; a disconnect or another account there does too', () => {
  const away = then(signedIn(), identity(wallet(ADDR_A, ELYSIUM)));
  const out = then(away, { type: 'sign_out' });
  assert.deepEqual(lastCall(out.effects), { route: 'logout', csrf: CSRF_A });
  const landed = then(out, result(ok('logout', FIXTURES.responses.logout)));
  assert.deepEqual([landed.machine.view, landed.machine.session], [{ status: 'wrong_network', chainId: ELYSIUM }, null]);
  for (const next of [{ kind: 'disconnected' }, wallet(ADDR_B, ELYSIUM), wallet(ADDR_A, ELYSIUM, 'uid-b'), wallet(ADDR_A, 1)]) {
    assert.deepEqual(lastCall(then(away, identity(next)).effects), { route: 'logout', csrf: CSRF_A }, JSON.stringify(next));
  }
});

test('anything but the same account moving between the registry\'s chains is an identity change, exactly as before', () => {
  // The same moves to a chain outside the registry and to the second chain give the same steps wherever a session is not
  // at rest, and wherever there is none.
  const same = (label, start) => {
    const elsewhere = then(start, identity(wallet(ADDR_A, 1)));
    const elysium = then(start, identity(wallet(ADDR_A, ELYSIUM)));
    const view = (step) => (step.machine.view.status === 'wrong_network' ? { ...step.machine.view, chainId: 'x' } : step.machine.view);
    assert.deepEqual([types(elysium.effects), routes(elysium.effects), view(elysium), elysium.machine.session], [types(elsewhere.effects), routes(elsewhere.effects), view(elsewhere), elsewhere.machine.session], label);
  };
  same('signed out', signedOut());
  same('asking for the signature', awaitingSignature());
  same('verify in flight', verifying());
  same('signing out', then(signedIn(), { type: 'sign_out' }));
  // Another account or wallet on the second chain, from signed in: closed, as before.
  assert.deepEqual(lastCall(then(signedIn(), identity(wallet(ADDR_B, ELYSIUM))).effects), { route: 'logout', csrf: CSRF_A });
  assert.deepEqual(lastCall(then(signedIn(), identity(wallet(ADDR_A, ELYSIUM, 'uid-b'))).effects), { route: 'logout', csrf: CSRF_A });
  // And to a chain outside the registry, from signed in: closed, as before (the test above, 'switching network while
  // signed in', walks it to the end).
  assert.deepEqual(lastCall(then(signedIn(), identity(wallet(ADDR_A, 1))).effects), { route: 'logout', csrf: CSRF_A });
});

test('a background check in flight when the wallet moves is abandoned: its late answer changes nothing, the session stays', () => {
  const checking = then(signedIn(), { type: 'recheck', cause: 'visible' });
  assert.deepEqual(routes(checking.effects), ['me']);
  const away = then(checking, identity(wallet(ADDR_A, ELYSIUM)));
  assert.deepEqual([away.machine.view, away.machine.flow], [{ status: 'wrong_network', chainId: ELYSIUM }, { kind: 'idle' }]);
  // The check's answer, sent for the epoch before the move, is stale.
  const late = reduce(away.machine, { type: 'result', epoch: checking.machine.epoch, outcome: ok('me', session(ADDR_A)) }, env);
  assert.equal(late.machine, away.machine);
  assert.deepEqual(away.machine.session.csrf, CSRF_A);
});

test('the registry\'s chains are the ones the session keeps an account across', () => {
  const { REGISTRY_CHAIN_IDS, ROBINHOOD_ID, ELYSIUM_ID } = require('../.test-build/app/src/config/chainIdentity.js');
  const { CHAINS } = require('../.test-build/app/src/config/chains.js');
  assert.deepEqual([...REGISTRY_CHAIN_IDS], CHAINS.map((chain) => chain.id));
  assert.deepEqual([ROBINHOOD_ID, ELYSIUM_ID], [4663, ELYSIUM]);
});

// Fix round 1 (2026-10-01): where the second chain's section is off (domino.money until its deployment is qualified, and
// any origin but the preview alias and the local development servers) its network is a chain outside the site, so a
// signed-in account whose wallet moves there is an identity change, exactly as before the section existed.
test('where the second chain’s section is off, a move to its network signs out like any other chain', () => {
  assert.deepEqual([...sessionChains('https://domino.money')], [4663], 'production');
  assert.deepEqual([...sessionChains('https://evil.example')], [4663]);
  // Changed on purpose 2026-10-02 (review of the RPC switch, finding 1): the section is closed on the preview alias and
  // the development server too while it could read its chain only from a public RPC (mode.ts SECTION_READS), so there
  // as well a move to its network is a move to a chain outside the site.
  assert.deepEqual([...sessionChains('https://preview.domino-app-e65.pages.dev')], [4663], 'the preview alias, today');
  assert.deepEqual([...sessionChains('http://localhost:5273')], [4663], 'the development server, today');
  for (const production of [{ origin: 'https://domino.money', checksum: getAddress, chains: sessionChains('https://domino.money') }, { origin: 'https://domino.money', checksum: getAddress }]) {
    const start = signedIn();
    const elysium = reduce(start.machine, { type: 'identity', identity: wallet(ADDR_A, ELYSIUM) }, production);
    const elsewhere = reduce(start.machine, { type: 'identity', identity: wallet(ADDR_A, 1) }, production);
    assert.deepEqual(lastCall(elysium.effects), { route: 'logout', csrf: CSRF_A }, 'closed, as before');
    assert.deepEqual([types(elysium.effects), elysium.machine.view.status], [types(elsewhere.effects), elsewhere.machine.view.status]);
  }
  // A list naming a chain outside the registry is never trusted.
  const odd = reduce(signedIn().machine, { type: 'identity', identity: wallet(ADDR_A, 1) }, { ...env, chains: [4663, 1] });
  assert.deepEqual(lastCall(odd.effects), { route: 'logout', csrf: CSRF_A });
});
