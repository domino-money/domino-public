/**
 * Serves the wallet-test build with the fake session service on the same
 * origin, the way Pages and the session Worker would.
 *
 * HTML carries the exact production CSP, taken from the compiled middleware,
 * and so does the fees worker's file (WORKER_CSP, 2026-09-25).
 * With `gate` set, every request goes through the real closed-beta middleware
 * first, so its 401 and 503 answers are the real ones. Responses are streamed:
 * headers are flushed before the body, which is what lets a test deliver
 * verify's cookies and then lose its body.
 */
import { readFile, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, join, normalize, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { loadMiddleware } from '../../scripts/gated-server.mjs';
import { DROP } from './fake-session.mjs';
import { feesDefault } from './fees/stub.mjs';

export const WALLET_DIST = resolve(import.meta.dirname, '../../.wallet-test-dist');

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.json': 'application/json',
  '.woff2': 'font/woff2',
};

const DROPPED = new Error('drop the connection');

/**
 * Where Positions asks which positions the connected wallet created through Domino (functions/api/owned/v2/positions.ts;
 * v1 was retired on 2026-09-24).
 */
export const OWNED_PATH = '/api/owned/v2/positions';

/**
 * This server has no chain behind it, so it answers the owned-positions POST
 * as the endpoint would for a wallet that created no position and holds no
 * deposit: every scenario that connects a wallet on Positions gets a real,
 * empty answer instead of the app shell. A test that wants positions answers
 * the path itself, through `routes`, which run first. Added on purpose on
 * 2026-09-24 with the list, so that no suite depends on what the app does
 * with an HTML answer. Since 2026-09-25 the page reads the chain itself (the
 * RPC rate-limits Cloudflare's edge) and never asks this path or the fees
 * relay's: suites answer the RPC with tests/support/browser-chain.mjs. The
 * answers stay, as the routes do, for anything that still asks.
 */
async function noOwnedPositions(request) {
  let owner = null;
  try {
    const body = await request.json();
    if (typeof body?.owner === 'string' && /^0x[0-9a-fA-F]{40}$/.test(body.owner)) owner = body.owner.toLowerCase();
  } catch {
    // An unreadable body is refused below.
  }
  if (request.method !== 'POST' || !owner) return Response.json({ error: 'invalid_request' }, { status: 400 });
  return Response.json({ owner, block: 1, positions: [], deposits: [] });
}

/** Where a position's feature is asked (functions/api/automation/v1/state.ts; 2026-09-24, the three features). */
export const AUTOMATION_PATH = '/api/automation/v1/state';

/**
 * This server has no chain behind it, so it answers the automation POST as the endpoint would for NFTs no sequence
 * holds: every id a plain position. A test that wants a sequence answers the path itself, through `routes`, which run
 * first. Added on purpose on 2026-09-24 with the rows' and the position page's state.
 * Since 2026-09-25 the page reads a position's feature from the chain itself (the RPC rate-limits Cloudflare's edge) and
 * never asks this path: suites answer the RPC with tests/support/browser-chain.mjs. The answer stays, as the route does,
 * for anything that still asks.
 */
export async function plainAutomation(request) {
  let ids = null;
  try {
    const body = await request.json();
    if (Array.isArray(body?.tokenIds) && body.tokenIds.length > 0 && body.tokenIds.every((id) => typeof id === 'string' && /^[1-9]\d{0,77}$/.test(id))) ids = body.tokenIds;
  } catch {
    // An unreadable body is refused below.
  }
  if (request.method !== 'POST' || !ids) return Response.json({ error: 'invalid_request' }, { status: 400 });
  return Response.json({ block: 1, positions: ids.map((tokenId) => ({ tokenId, automation: 'plain' })) });
}

async function staticResponse(dist, url) {
  let file = normalize(join(dist, decodeURIComponent(url.pathname)));
  if (!file.startsWith(dist)) return new Response('forbidden', { status: 403 });
  try {
    if ((await stat(file)).isDirectory()) file = join(file, 'index.html');
  } catch {
    if (extname(file)) return new Response('not found', { status: 404 });
    file = join(dist, 'index.html');
  }
  return new Response(await readFile(file), { headers: { 'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream' } });
}

function toRequest(req) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (Array.isArray(value)) value.forEach((item) => headers.append(name, item));
    else if (value !== undefined) headers.set(name, value);
  }
  const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
  return new Request(url, {
    method: req.method,
    headers,
    body: hasBody ? Readable.toWeb(req) : undefined,
    duplex: hasBody ? 'half' : undefined,
  });
}

async function send(req, res, response) {
  const cookies = response.headers.getSetCookie();
  for (const [name, value] of response.headers) {
    if (name.toLowerCase() !== 'set-cookie') res.setHeader(name, value);
  }
  if (cookies.length) res.setHeader('Set-Cookie', cookies);
  // One request per connection. Chromium transparently re-sends a request
  // whose reused keep-alive connection closes without an answer, which would
  // turn a test's deliberately lost response into a silent second attempt.
  res.setHeader('Connection', 'close');
  res.writeHead(response.status);
  res.flushHeaders();
  if (!response.body) {
    res.end();
    return;
  }
  try {
    for await (const chunk of response.body) {
      if (res.destroyed) return;
      res.write(chunk);
    }
    res.end();
  } catch {
    // The body failed after the headers went out: cut the connection.
    req.socket.destroy();
  }
}

/**
 * @param fake       the fake session service
 * @param gate       env for the real beta gate, or null to serve without it
 * @param intercept  (url) => Response | undefined, to replace a static file
 * @param routes     test-only same-origin handlers, after session routing and the gate; the
 *                   owned-positions POST falls through to an empty answer (noOwnedPositions)
 */
export function createWalletServer({ fake, gate = null, intercept, dist = WALLET_DIST, routes = [] }) {
  const middleware = loadMiddleware();
  const sockets = new Set();
  /** The owned-positions requests this server answered itself, in order. */
  const owned = [];

  async function app(request) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/session/v1/') && !fake.controls.notRouted) return fake.handle(request);
    for (const route of routes) {
      const response = await route(request, url);
      if (response !== undefined) return response;
    }
    if (url.pathname === OWNED_PATH) {
      owned.push({ method: request.method });
      return noOwnedPositions(request);
    }
    if (url.pathname === AUTOMATION_PATH) return plainAutomation(request);
    // 2026-09-24 (P6, R-7): the fees relay (functions/api/fees/v1/*) answers every position not_found by default, so no
    // history is drawn and /logs is never asked; a suite that wants one passes tests/support/fees/stub.mjs's
    // feesFixtureRoute through `routes`, which run first.
    const fees = await feesDefault(request, url);
    if (fees) return fees;
    const replaced = intercept?.(url);
    if (replaced) return replaced;
    return staticResponse(dist, url);
  }

  const server = createServer(async (req, res) => {
    try {
      const request = toRequest(req);
      let response;
      if (gate) {
        response = await middleware.onRequest({
          request,
          env: gate,
          next: async () => {
            const out = await app(request);
            if (out === DROP) throw DROPPED;
            return out;
          },
        });
      } else {
        response = await app(request);
        if (response !== DROP && (response.headers.get('Content-Type') ?? '').includes('text/html')) {
          response = new Response(response.body, response);
          response.headers.set('Content-Security-Policy', middleware.APP_CSP);
        } else if (response !== DROP && middleware.WORKER_PATH.test(new URL(request.url).pathname)) {
          // 2026-09-25: the fees worker's own CSP, as production serves its file (it reads the chain's RPC itself).
          response = new Response(response.body, response);
          response.headers.set('Content-Security-Policy', middleware.WORKER_CSP);
        }
      }
      if (response === DROP) {
        req.socket.destroy();
        return;
      }
      await send(req, res, response);
    } catch (error) {
      if (error === DROPPED) {
        req.socket.destroy();
        return;
      }
      if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end(String(error));
    }
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  server.owned = owned;
  server.closeAll = () =>
    new Promise((done) => {
      for (const socket of sockets) socket.destroy();
      server.close(done);
    });
  return server;
}
