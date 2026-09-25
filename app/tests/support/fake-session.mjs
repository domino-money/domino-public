/**
 * A stateful stand-in for the session BFF and the producer behind it, for the
 * browser tests.
 *
 * It enforces what bridge/src/session-worker.mjs enforces on the way in (exact
 * Origin, Fetch Metadata, contract header, CSRF presence, strict bodies checked
 * by the package runtime) and answers the way backend/session_store.py does:
 * single-use challenges with five attempts, CSRF bound to the preauth context
 * or the session, read-only GET me that never rotates the CSRF, POST refresh
 * that renews only the idle deadline and returns the same CSRF and absolute
 * expiry (session_store.py begin_private/finish_private), logout by
 * session or by preauth abort (which also revokes a session the context
 * created), bootstrap refusing a preauth whose context already created an
 * active session (session_store.py matches source_context_hash).
 * Cookies carry the real names and attributes.
 *
 * Every client mistake is recorded as a violation while the fake still answers
 * as the real service would, so graceful handling cannot hide a protocol bug.
 * Every reply is checked against the package runtime before it is sent.
 */
import { randomBytes } from 'node:crypto';
import { recoverMessageAddress } from 'viem';
import { runtime, siweMessage, utc } from './session-fixtures.mjs';

const PREFIX = '/api/session/v1/';
const HEADER = 'X-Domino-Session-Contract';
const MINUTE = 60_000;
/** Returned instead of a Response: the server closes the socket without answering. */
export const DROP = Symbol('drop the connection');

const credential = () => randomBytes(32).toString('base64url');
const hex = (bytes) => randomBytes(bytes).toString('hex');

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function cookiesOf(request) {
  const found = {};
  for (const part of (request.headers.get('Cookie') ?? '').split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name === '__Host-domino-preauth') found.preauth = rest.join('=');
    if (name === '__Host-domino-session') found.session = rest.join('=');
  }
  return found;
}

export function createFakeSession() {
  const state = {
    origin: null,
    offset: 0,
    contexts: new Map(),
    sessions: new Map(),
    violations: [],
    log: [],
    verifies: new Map(),
  };
  const controls = {
    disabled: false,
    storeDown: new Set(),
    holds: new Map(),
    dropAfterCommit: new Set(),
    breakAfterHeaders: new Set(),
    stallAfterHeaders: new Map(),
    notRouted: false,
    errorAfterCommit: new Map(),
    platformErrorAfterCommit: new Map(),
    failNext: new Map(),
    corruptNext: new Map(),
    foreignDomain: false,
    // The account check every session reply carries: a plain EOA unless a test sets another (an EIP-7702 designator's).
    validation: { method: 'plain_eoa', blockNumber: '123', blockHash: `0x${'ab'.repeat(32)}` },
  };
  const now = () => Date.now() + state.offset;
  const violation = (text) => state.violations.push(text);

  // The listener's own headers (backend/session_api.py): no-transform since
  // #75, in the producer release the pin names (b50f80e). Past the gate the
  // middleware sets the same value on every /api answer (F1).
  function headers(extra = {}) {
    return new Headers({
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store, no-transform',
      [HEADER]: runtime.CONTRACT_VERSION,
      ...extra,
    });
  }

  function error(code) {
    const status = runtime.ERROR_STATUS_BY_CODE[code];
    const body = { error: code };
    if (!runtime.validateError(status, body)) violation(`fake produced an invalid error ${code}`);
    const out = headers(status === 429 ? { 'Retry-After': '60' } : {});
    return new Response(JSON.stringify(body), { status, headers: out });
  }

  function success(route, body, cookies = {}) {
    const out = headers();
    for (const [name, token] of Object.entries(cookies)) {
      const maxAge = token === null ? 0 : name === 'preauth' ? 600 : 43200;
      out.append('Set-Cookie', `__Host-domino-${name}=${token ?? ''}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`);
    }
    const corruption = controls.corruptNext.get(route);
    if (corruption) {
      controls.corruptNext.delete(route);
      if (corruption === 'version') out.set(HEADER, '2.0.0');
      if (corruption === 'extra_field') body = { ...body, role: 'admin' };
    } else if (!runtime.validateResponse(route, body)) violation(`fake produced an invalid ${route} body`);
    return new Response(JSON.stringify(body), { status: 200, headers: out });
  }

  const activeSession = (token) => {
    const row = token ? state.sessions.get(token) : undefined;
    if (!row || row.revoked || row.expiresAt <= now() || row.idleAt <= now()) return null;
    return row;
  };

  function context(preauth, csrf, { allowConsumed = false } = {}) {
    const row = preauth ? state.contexts.get(preauth) : undefined;
    if (!row || row.revoked || row.expiresAt <= now() || (row.consumed && !allowConsumed)) return 'preauth_required';
    if (csrf !== row.csrf) return 'csrf_invalid';
    return row;
  }

  function sessionBody(row) {
    return {
      authenticated: true,
      owner: { address: row.owner, chainId: 4663 },
      expiresAt: utc(row.expiresAt),
      csrfToken: row.csrf,
      validation: controls.validation,
    };
  }

  async function waitIfHeld(route, phase) {
    const hold = controls.holds.get(route);
    if (!hold || hold.phase !== phase) return;
    hold.arrived.resolve();
    await hold.released.promise;
  }

  // ---- routes -------------------------------------------------------------

  function bootstrap(cookies) {
    if (activeSession(cookies.session)) return error('session_exists');
    // A consumed context cannot start a second login while the session it
    // created is active, even if the browser never received that session.
    if (cookies.preauth) {
      for (const [token, row] of state.sessions) {
        if (row.context === cookies.preauth && activeSession(token)) return error('session_exists');
      }
    }
    const token = credential();
    const row = { csrf: credential(), expiresAt: now() + 10 * MINUTE, revoked: false, consumed: false, challenge: null };
    state.contexts.set(token, row);
    return success('bootstrap', { status: 'challenge_required', csrfToken: row.csrf, expiresAt: utc(row.expiresAt) }, { preauth: token });
  }

  function challenge(cookies, csrf, body) {
    const ctx = context(cookies.preauth, csrf);
    if (typeof ctx === 'string') return error(ctx);
    const address = body.address.toLowerCase();
    const issued = Math.floor(now() / 1000) * 1000;
    const expires = Math.min(issued + 5 * MINUTE, Math.floor(ctx.expiresAt / 1000) * 1000);
    const nonce = hex(16);
    const origin = controls.foreignDomain ? 'https://evil.example' : state.origin;
    // Issuing a new challenge replaces the context's earlier one.
    ctx.challenge = {
      id: hex(16),
      address,
      message: siweMessage({ origin, address: body.address, nonce, issuedAt: utc(issued), expiresAt: utc(expires) }),
      expiresAt: expires,
      attempts: 0,
      consumed: false,
    };
    return success('challenge', { challengeId: ctx.challenge.id, message: ctx.challenge.message, expiresAt: utc(expires) });
  }

  async function verify(cookies, csrf, body) {
    state.verifies.set(body.challengeId, (state.verifies.get(body.challengeId) ?? 0) + 1);
    if (activeSession(cookies.session)) return error('session_exists');
    const ctx = context(cookies.preauth, csrf);
    if (typeof ctx === 'string') return error(ctx);
    const current = ctx.challenge;
    if (!current || current.id !== body.challengeId || current.consumed || current.expiresAt <= now() || current.attempts >= 5) {
      return error('challenge_invalid');
    }
    current.attempts += 1;
    if (current.message !== body.message) return error('challenge_invalid');
    let signer = null;
    try {
      signer = (await recoverMessageAddress({ message: body.message, signature: body.signature })).toLowerCase();
    } catch {
      signer = null;
    }
    if (signer !== current.address) return error('invalid_signature');

    current.consumed = true;
    ctx.consumed = true;
    const token = credential();
    const row = {
      owner: current.address,
      csrf: credential(),
      expiresAt: now() + 12 * 60 * MINUTE,
      idleAt: now() + 30 * MINUTE,
      revoked: false,
      context: cookies.preauth,
    };
    state.sessions.set(token, row);
    await waitIfHeld('verify', 'after');
    if (controls.dropAfterCommit.delete('verify')) return DROP;
    const platform = controls.platformErrorAfterCommit.get('verify');
    if (platform) {
      // The edge or the Worker platform fails after the store committed: no
      // contract header, no cookie, an HTML body.
      controls.platformErrorAfterCommit.delete('verify');
      return new Response(`<!doctype html><title>${platform}</title><h1>Error ${platform}</h1>`, {
        status: platform,
        headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
      });
    }
    const lateError = controls.errorAfterCommit.get('verify');
    if (lateError) {
      controls.errorAfterCommit.delete('verify');
      return error(lateError);
    }
    const response = success('verify', sessionBody(row), { preauth: null, session: token });
    const stall = controls.stallAfterHeaders.get('verify');
    if (stall) {
      // Headers (and so the cookies) reach the browser at once; the body waits.
      controls.stallAfterHeaders.delete('verify');
      const payload = new TextEncoder().encode(await response.clone().text());
      stall.arrived.resolve();
      return new Response(
        new ReadableStream({
          async pull(controller) {
            await stall.released.promise;
            controller.enqueue(payload);
            controller.close();
          },
        }),
        { status: 200, headers: response.headers },
      );
    }
    if (controls.breakAfterHeaders.delete('verify')) {
      // Headers (and so the cookies) reach the browser; the body never does.
      return new Response(
        new ReadableStream({
          pull(controller) {
            controller.error(new Error('connection lost after headers'));
          },
        }),
        { status: 200, headers: response.headers },
      );
    }
    return response;
  }

  function me(cookies) {
    const row = activeSession(cookies.session);
    if (!row) return error('session_required');
    // Read-only: no idle renewal, no CSRF rotation.
    return success('me', sessionBody(row));
  }

  function refresh(cookies, csrf) {
    const row = activeSession(cookies.session);
    if (!row) return error('session_required');
    if (csrf !== row.csrf) return error('csrf_invalid');
    row.idleAt = now() + 30 * MINUTE;
    return success('refresh', sessionBody(row));
  }

  function logout(cookies, csrf) {
    const row = activeSession(cookies.session);
    let target;
    if (row && csrf === row.csrf) target = row.context;
    else {
      const ctx = context(cookies.preauth, csrf, { allowConsumed: true });
      if (typeof ctx === 'string') return error(row ? 'csrf_invalid' : cookies.preauth ? ctx : 'session_required');
      target = cookies.preauth;
      if (row && row.context !== target) return error('csrf_invalid');
    }
    const ctx = state.contexts.get(target);
    if (ctx) {
      ctx.revoked = true;
      if (ctx.challenge) ctx.challenge.consumed = true;
    }
    for (const session of state.sessions.values()) if (session.context === target) session.revoked = true;
    if (row && row.context === target) row.revoked = true;
    return success('logout', { authenticated: false }, { preauth: null, session: null });
  }

  // ---- entry --------------------------------------------------------------

  async function handle(request) {
    const url = new URL(request.url);
    const route = url.pathname.slice(PREFIX.length);
    const csrf = request.headers.get('X-Domino-CSRF');
    const cookies = cookiesOf(request);
    const entry = { route, method: request.method, csrf, cookies, at: Date.now() };
    state.log.push(entry);
    const done = (response) => {
      entry.status = response === DROP ? 'dropped' : response.status;
      return response;
    };

    if (!runtime.ROUTES.includes(route) || url.search) {
      violation(`unknown route ${url.pathname}${url.search}`);
      return done(error('route_not_available'));
    }
    if (request.method !== (route === 'me' ? 'GET' : 'POST')) {
      violation(`${request.method} ${route}`);
      return done(error('method_not_allowed'));
    }
    const origin = request.headers.get('Origin');
    if ((route !== 'me' || origin !== null) && origin !== state.origin) {
      violation(`${route} with Origin ${origin}`);
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
    if (controls.disabled) return done(error('route_not_available'));
    const version = request.headers.get(HEADER);
    if (version !== runtime.CONTRACT_VERSION) {
      violation(`${route} with contract header ${version}`);
      if (version !== null) return done(error('upstream_contract_mismatch'));
    }
    if (csrf !== null && !runtime.credential(csrf)) {
      violation(`${route} with a malformed CSRF`);
      return done(error('csrf_invalid'));
    }
    if ((route === 'bootstrap' || route === 'me') && csrf !== null) violation(`${route} sent a CSRF`);
    if (['challenge', 'verify', 'refresh', 'logout'].includes(route) && csrf === null) {
      violation(`${route} without a CSRF`);
      return done(error('csrf_invalid'));
    }

    let body = {};
    if (route === 'me') {
      if (request.headers.has('Content-Type')) violation('me sent a Content-Type');
      if ((await request.text()) !== '') {
        violation('me sent a body');
        return done(error('invalid_request'));
      }
    } else {
      if (!/^application\/json(;\s*charset=utf-8)?$/i.test(request.headers.get('Content-Type') ?? '')) {
        violation(`${route} without JSON`);
        return done(error('json_required'));
      }
      const text = await request.text();
      try {
        body = JSON.parse(text);
      } catch {
        body = undefined;
      }
      if (text.length > 8192 || !runtime.validateRequest(route, body)) {
        violation(`${route} body failed the contract: ${text.slice(0, 200)}`);
        return done(error('invalid_request'));
      }
      entry.body = body;
    }

    await waitIfHeld(route, 'before');
    const failure = controls.failNext.get(route);
    if (failure) {
      controls.failNext.delete(route);
      return done(error(failure));
    }
    if (controls.storeDown.has(route)) return done(error('session_store_unavailable'));

    switch (route) {
      case 'bootstrap':
        return done(bootstrap(cookies));
      case 'challenge':
        return done(challenge(cookies, csrf, body));
      case 'verify':
        return done(await verify(cookies, csrf, body));
      case 'me': {
        // Answered from the state as it is now; delivered on release.
        const response = me(cookies);
        await waitIfHeld('me', 'after');
        return done(response);
      }
      case 'refresh':
        return done(refresh(cookies, csrf));
      case 'logout':
        return done(logout(cookies, csrf));
    }
  }

  return {
    handle,
    state,
    controls,
    set origin(value) {
      state.origin = value;
    },
    /** Revokes every session this owner holds, as session_store.revoke does. */
    revoke(address) {
      const key = address.toLowerCase();
      for (const row of state.sessions.values()) if (row.owner === key) row.revoked = true;
    },
    advance(ms) {
      state.offset += ms;
    },
    /** Holds `route` before it is processed, or ('after') after verify commits or me is answered. */
    hold(route, phase = 'before') {
      const hold = { phase, arrived: deferred(), released: deferred() };
      controls.holds.set(route, hold);
      return {
        arrived: hold.arrived.promise,
        release() {
          controls.holds.delete(route);
          hold.released.resolve();
        },
      };
    },
    /** Sends verify's headers after it commits, and its body only on release. */
    stallAfterHeaders(route) {
      const stall = { arrived: deferred(), released: deferred() };
      controls.stallAfterHeaders.set(route, stall);
      return { arrived: stall.arrived.promise, release: () => stall.released.resolve() };
    },
    expireChallenges() {
      for (const ctx of state.contexts.values()) if (ctx.challenge) ctx.challenge.expiresAt = now() - 1;
    },
    /** Marks every current challenge used, as a copy of its verify that reached the service first would. */
    consumeChallenges() {
      for (const ctx of state.contexts.values()) if (ctx.challenge) ctx.challenge.consumed = true;
    },
    sessionsFor(address) {
      const key = address.toLowerCase();
      return [...state.sessions.values()].filter((row) => row.owner === key).map((row) => ({ ...row, active: activeSession([...state.sessions.entries()].find(([, value]) => value === row)[0]) !== null }));
    },
    count(route) {
      return state.log.filter((entry) => entry.route === route).length;
    },
    calls(route) {
      return state.log.filter((entry) => entry.route === route);
    },
    /** Tokens of the session cookie, mapped to the owner it belongs to. */
    ownerOfSessionCookie(token) {
      return state.sessions.get(token)?.owner ?? null;
    },
  };
}
