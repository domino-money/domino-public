/**
 * Serves the wallet-test build with the fake session service on the same
 * origin, the way Pages and the session Worker would.
 *
 * HTML carries the exact production CSP, taken from the compiled middleware.
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

export const WALLET_DIST = resolve(import.meta.dirname, '../../.wallet-test-dist');

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.json': 'application/json',
  '.woff2': 'font/woff2',
};

const DROPPED = new Error('drop the connection');

/** Where Positions asks which position NFTs the connected wallet holds (functions/api/owned/v1/positions.ts). */
export const OWNED_PATH = '/api/owned/v1/positions';

/**
 * This server has no chain behind it, so it answers the owned-positions POST
 * as the endpoint would for a wallet that holds no position NFT and no held
 * deposit: every scenario that connects a wallet on Positions gets a real,
 * empty answer instead of the app shell. A test that wants positions answers
 * the path itself, through `routes`, which run first. Added on purpose on
 * 2026-09-24 with the list, so that no suite depends on what the app does
 * with an HTML answer.
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
  return Response.json({ owner, block: 1, positions: [], complete: true, deposits: [] });
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
