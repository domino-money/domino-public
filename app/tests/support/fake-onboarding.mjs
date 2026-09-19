/**
 * A stand-in for the onboarding worker and backend (#38), for the consumer
 * browser tests, mounted on the same origin next to the fake session service.
 *
 * On the way in it enforces what bridge/src/authenticated-worker.mjs does, in
 * its order: route, method, exact Origin and Fetch Metadata, enabled, the
 * version header, JSON media, the 8 KiB bound and the package runtime, then
 * the session cookie and the CSRF against the fake session's own rows. Every
 * client mistake is recorded as a violation while the fake still answers as
 * the worker would.
 *
 * Answers are the package fixtures, shifted to the fake's clock, with the
 * owner and recipient set to the signed-in owner and the request fingerprint
 * recomputed as the producer computes it. Swap amounts are recomputed
 * from the request so any amount the form sends has a valid answer; a
 * position request must equal one of the package's four position requests,
 * or it is refused as provider_request_rejected. Every answer is checked
 * against the package runtime before it is sent.
 *
 * Controls let a test serve one of the derived previews in
 * support/onboarding-derived.mjs, or put the real beta gate in front of the
 * next request: its 401 (no beta cookie) or its 503 (misconfigured, fails
 * closed), taken from the compiled middleware, byte for byte.
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadMiddleware } from '../../scripts/gated-server.mjs';
import { DERIVED_POSITIONS, DERIVED_SWAPS, fingerprintOf } from './onboarding-derived.mjs';

const PACKAGE = resolve(import.meta.dirname, '../../../api-contracts/onboarding-v1');
export const runtime = await import(pathToFileURL(resolve(PACKAGE, 'runtime.mjs')).href);
const read = (path) => JSON.parse(readFileSync(resolve(PACKAGE, 'fixtures', path), 'utf8'));
const clone = (value) => JSON.parse(JSON.stringify(value));

const PREFIX = '/api/onboarding/v1/';
const HEADER = 'X-Domino-Onboarding-Contract';
const ROUTES = ['swap-preview', 'position-preview'];
const SWAPS = { happy: read('responses/swap-preview.json').preview, unknown: read('variants/swap-preview.unknown.json').preview };
const POSITIONS = ['responses/position-preview.json', 'variants/position-preview.incomplete.json', 'variants/position-preview.blocked.json', 'variants/position-preview.native.json'].map(
  (path) => read(path).preview,
);

const sorted = (value) =>
  Array.isArray(value)
    ? value.map(sorted)
    : value && typeof value === 'object'
      ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, sorted(value[key])]))
      : value;
/** Test-only gate secrets: with them and no beta cookie the gate answers 401; with none it fails closed with 503. */
const GATE_ENV = { BETA_PASSWORD: 'correct-horse-battery-staple-42', BETA_COOKIE_KEY: 'q3VfK9mJx7Rt2WbN5cYp8LhD4sGa6ZeU1oTiQwErTyA' };
const middleware = loadMiddleware();

/** What the compiled beta gate answers this request when it carries no beta cookie. */
function gateAnswer(request, kind) {
  const bare = new Request(request.url, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: new URL(request.url).origin }, body: '{}' });
  return middleware.onRequest({
    request: bare,
    env: kind === 'required' ? GATE_ENV : {},
    next: async () => {
      throw new Error('the gate passed a request that had no beta cookie');
    },
  });
}

const withNulls = (body) => ({ budget0Raw: null, budget1Raw: null, nativeBalanceRaw: null, nativeGasReserveRaw: null, ...body });

function deferred() {
  let resolveIt;
  const promise = new Promise((done) => {
    resolveIt = done;
  });
  return { promise, resolve: resolveIt };
}

function sessionCookie(request) {
  for (const part of (request.headers.get('Cookie') ?? '').split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name === '__Host-domino-session') return rest.join('=');
  }
  return null;
}

export function createFakeOnboarding({ session }) {
  const state = { origin: null, log: [], violations: [] };
  const controls = {
    disabled: false,
    swap: 'happy',
    /** A key of DERIVED_SWAPS applied to every swap answer, or null. */
    swapDerived: null,
    /** A key of DERIVED_POSITIONS: the only position the fake then answers, or null. */
    positionDerived: null,
    /**
     * Answers any valid position request New position sends: the incomplete
     * package variant moved onto the request's pool, ticks and amount, with the
     * budget checks answered against whatever budgets the request carries (see
     * adaptedPosition). A request that names a gas reserve is still refused:
     * New position never chooses one.
     */
    positionFromRequest: false,
    /** 'required' or 'unavailable': the beta gate answers the next request instead of the worker. */
    gateNext: null,
    errorNext: new Map(),
    ownerOverride: null,
    stripHeader: false,
    holds: new Map(),
  };
  const violation = (text) => state.violations.push(text);

  function respond(status, body) {
    const headers = new Headers({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store, no-transform', 'X-Domino-Request-Id': randomUUID() });
    if (!controls.stripHeader) headers.set(HEADER, runtime.CONTRACT_VERSION);
    if (status === 429) headers.set('Retry-After', '60');
    return new Response(JSON.stringify(body), { status, headers });
  }

  function error(code) {
    const status = runtime.ERROR_STATUS_BY_CODE[code];
    const body = { error: code };
    if (!runtime.validateError(status, body)) violation(`fake produced an invalid error ${code}`);
    return respond(status, body);
  }

  /** The signed-in owner and CSRF behind this request's session cookie, if that session is live. */
  function sessionOf(request) {
    const token = sessionCookie(request);
    if (!token) return null;
    const owner = session.ownerOfSessionCookie(token);
    const row = session.state.sessions.get(token);
    if (!owner || !row) return null;
    const live = session.sessionsFor(owner).some((entry) => entry.csrf === row.csrf && entry.active);
    return live ? { owner, csrf: row.csrf } : null;
  }

  function stamp(preview) {
    const now = Math.floor(Date.now() / 1000);
    preview.requestedAt = now;
    preview.retrievedAt = now;
    preview.expiresAt = now + 30;
    if ('preparedDeadline' in preview) preview.preparedDeadline = now + 1200;
    // The producer's hash of the request as served, owner included.
    preview.requestFingerprint = fingerprintOf(preview.request);
    return preview;
  }

  function swapPreview(body, owner) {
    const preview = clone(SWAPS[controls.swap]);
    const amount = BigInt(body.amountRaw);
    const gross = amount * 2n;
    const floor = (gross * BigInt(10000 - body.slippageBps)) / 10000n;
    const quote = preview.quote;
    quote.dexInputAmountRaw = String(amount);
    quote.grossOutputAmountRaw = String(gross);
    quote.grossMinimumOutputAmountRaw = String(floor);
    quote.policyMinimumOutputRaw = String(floor);
    if (quote.outputAfterProviderFeeRaw !== null) {
      quote.outputAfterProviderFeeRaw = String(gross);
      quote.minimumAfterProviderFeeRaw = String(floor);
    }
    const tokenIn = body.tokenIn.toLowerCase();
    const tokenOut = body.tokenOut.toLowerCase();
    const [currency0, currency1] = [tokenIn, tokenOut].sort();
    for (const path of quote.routes) {
      for (const hop of path) {
        Object.assign(hop, { amountInRaw: String(amount), amountOutRaw: String(gross) });
        hop.tokenIn.address = tokenIn;
        hop.tokenOut.address = tokenOut;
        Object.assign(hop.poolKey, { currency0, currency1 });
      }
    }
    preview.providerOutputFee.currency = tokenOut;
    preview.request = { ...body, owner };
    if (controls.swapDerived) DERIVED_SWAPS[controls.swapDerived].mutate(preview, { owner });
    return stamp(preview);
  }

  function derivedPosition(name) {
    const { base, mutate } = DERIVED_POSITIONS[name];
    const preview = read(base).preview;
    mutate(preview);
    return preview;
  }

  /**
   * The incomplete package variant for another request: its pool, ticks and owner, the independent token expecting
   * exactly the amount asked, the other currency twice that plus one, and each maximum the expected amount plus the
   * request's slippage. No budget and no native balance, so the checks stay incomplete. Null for a request that
   * gives either: those have their own package fixtures.
   */
  function adaptedPosition(body, owner) {
    const request = withNulls(body);
    if (request.nativeGasReserveRaw !== null) return null;
    const preview = read('variants/position-preview.incomplete.json').preview;
    const independent = body.independentToken.toLowerCase();
    const amount = BigInt(body.amountRaw);
    const { currency0, currency1 } = body.poolKey;
    preview.request = { ...request, owner };
    Object.assign(preview.position, { poolId: body.poolId, poolKey: { ...body.poolKey }, tickLower: body.tickLower, tickUpper: body.tickUpper, recipient: owner });
    // The budgets New position now sends are the wallet's own balances, so the
    // checks are answered against them: a maximum a budget does not cover is
    // `exceeded` and blocks, and a budget that was not sent stays unknown.
    const budgets = [request.budget0Raw, request.budget1Raw];
    const reasons = [];
    preview.position.tokens = [currency0, currency1].map((address, index) => {
      const expected = address === independent ? amount : amount * 2n + 1n;
      const maximum = expected + (expected * BigInt(body.slippageBps)) / 10000n;
      const token = { address, expectedDepositRaw: String(expected), maximumDebitRaw: String(maximum) };
      const budget = budgets[index];
      if (budget === null) {
        reasons.push(`token${index}_budget_unknown`);
        return { ...token, budgetStatus: 'unknown', estimatedUnspentBudgetRaw: null, selectedBudgetRaw: null, unspentAtMaximumRaw: null };
      }
      if (BigInt(budget) < maximum) {
        reasons.push(`token${index}_maximum_exceeds_budget`);
        return { ...token, budgetStatus: 'exceeded', estimatedUnspentBudgetRaw: null, selectedBudgetRaw: budget, unspentAtMaximumRaw: null };
      }
      return {
        ...token,
        budgetStatus: 'within_limit',
        estimatedUnspentBudgetRaw: String(BigInt(budget) - expected),
        selectedBudgetRaw: budget,
        unspentAtMaximumRaw: String(BigInt(budget) - maximum),
      };
    });
    preview.nativeFunding.depositMaximumRaw = currency0 === '0x0000000000000000000000000000000000000000' ? preview.position.tokens[0].maximumDebitRaw : '0';
    if (request.nativeBalanceRaw === null) reasons.push('native_balance_unknown');
    else {
      preview.nativeFunding.reportedBalanceRaw = request.nativeBalanceRaw;
      if (BigInt(preview.nativeFunding.depositMaximumRaw) > BigInt(request.nativeBalanceRaw)) reasons.push('native_deposit_exceeds_balance');
    }
    // New position never chooses a gas reserve, so this one is always open.
    reasons.push('native_gas_reserve_unspecified');
    const blocked = reasons.some((reason) => reason === 'native_deposit_exceeds_balance' || reason.endsWith('_maximum_exceeds_budget'));
    preview.previewChecks = { reasons, status: blocked ? 'blocked' : reasons.length > 1 ? 'incomplete' : 'within_selected_limits' };
    return stamp(preview);
  }

  function positionPreview(body, owner) {
    if (controls.positionFromRequest) return adaptedPosition(body, owner);
    const wanted = JSON.stringify(sorted(withNulls(body)));
    const candidates = controls.positionDerived ? [derivedPosition(controls.positionDerived)] : POSITIONS;
    const match = candidates.find((preview) => {
      const { owner: _owner, ...request } = preview.request;
      return JSON.stringify(sorted(request)) === wanted;
    });
    if (!match) return null;
    const preview = clone(match);
    preview.request.owner = owner;
    preview.position.recipient = owner;
    return stamp(preview);
  }

  async function handle(request) {
    const url = new URL(request.url);
    const route = url.pathname.slice(PREFIX.length);
    const csrf = request.headers.get('X-Domino-CSRF');
    const entry = { route, method: request.method, csrf, at: Date.now() };
    state.log.push(entry);
    const done = (response) => {
      entry.status = response.status;
      return response;
    };
    if (controls.gateNext) {
      // The gate sits in front of the worker: nothing of the worker runs.
      const kind = controls.gateNext;
      controls.gateNext = null;
      entry.gate = kind;
      return done(await gateAnswer(request, kind));
    }

    if (!ROUTES.includes(route) || url.search) {
      violation(`unknown route ${url.pathname}${url.search}`);
      return done(error('route_not_available'));
    }
    if (request.method !== 'POST') {
      violation(`${request.method} ${route}`);
      return done(error('method_not_allowed'));
    }
    if (request.headers.get('Origin') !== state.origin) {
      violation(`${route} with Origin ${request.headers.get('Origin')}`);
      return done(error('origin_not_allowed'));
    }
    for (const [name, accepted] of [
      ['Sec-Fetch-Site', ['same-origin']],
      ['Sec-Fetch-Mode', ['cors', 'same-origin']],
      ['Sec-Fetch-Dest', ['empty']],
    ]) {
      const value = request.headers.get(name);
      if (value !== null && !accepted.includes(value)) {
        violation(`${route} with ${name}: ${value}`);
        return done(error('origin_not_allowed'));
      }
    }
    if (request.headers.get('Sec-Fetch-User') !== null) violation(`${route} with Sec-Fetch-User`);
    if (controls.disabled) return done(error('route_not_available'));
    const version = request.headers.get(HEADER);
    if (version !== runtime.CONTRACT_VERSION) {
      violation(`${route} with contract header ${version}`);
      if (version !== null) return done(error('upstream_contract_mismatch'));
    }
    if (!/^application\/json(;\s*charset=utf-8)?$/i.test(request.headers.get('Content-Type') ?? '')) {
      violation(`${route} without JSON`);
      return done(error('json_required'));
    }
    const text = await request.text();
    if (text.length > 8192) {
      violation(`${route} body over 8 KiB`);
      return done(error('request_too_large'));
    }
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      body = undefined;
    }
    entry.body = body;
    if (!runtime.validateRequest(route, body)) {
      violation(`${route} body failed the contract: ${text.slice(0, 200)}`);
      return done(error('invalid_request'));
    }
    for (const forbidden of ['owner', 'recipient', 'tenant', 'signature']) if (forbidden in body) violation(`${route} sent ${forbidden}`);

    const who = sessionOf(request);
    if (!who) return done(error('session_required'));
    if (csrf === null) {
      violation(`${route} without a CSRF`);
      return done(error('csrf_invalid'));
    }
    if (csrf !== who.csrf) return done(error('csrf_invalid'));
    entry.owner = who.owner;

    const hold = controls.holds.get(route);
    if (hold) {
      hold.arrived.resolve();
      await hold.released.promise;
    }
    const code = controls.errorNext.get(route);
    if (code) {
      controls.errorNext.delete(route);
      return done(error(code));
    }
    const owner = controls.ownerOverride ?? who.owner;
    const preview = route === 'swap-preview' ? swapPreview(body, owner) : positionPreview(body, owner);
    if (!preview) return done(error('provider_request_rejected'));
    const answer = { contractVersion: runtime.CONTRACT_VERSION, preview };
    if (!runtime.validateResponse(route, answer)) violation(`fake produced an invalid ${route} answer`);
    return done(respond(200, answer));
  }

  return {
    handle,
    state,
    controls,
    set origin(value) {
      state.origin = value;
    },
    /** Answers the next request on `route` with this error code. */
    failNext(route, code) {
      controls.errorNext.set(route, code);
    },
    /** Holds `route` after its checks until released. */
    hold(route) {
      const hold = { arrived: deferred(), released: deferred() };
      controls.holds.set(route, hold);
      return {
        arrived: hold.arrived.promise,
        release() {
          controls.holds.delete(route);
          hold.released.resolve();
        },
      };
    },
    calls: (route) => state.log.filter((entry) => !route || entry.route === route),
  };
}
