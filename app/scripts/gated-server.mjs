/**
 * Serves app/dist through the real access middleware, locally.
 *
 * Cloudflare runs functions/_middleware.ts in front of the static files. This
 * does the same thing with node:http, so the gate can be looked at in a
 * browser and tested end to end without a Cloudflare account. It loads the
 * middleware compiled by scripts/test.mjs, never a copy of it.
 *
 *   npm test                                  # compiles the middleware
 *   npm run build
 *   BETA_PASSWORD=... BETA_COOKIE_KEY=... node scripts/gated-server.mjs [port]
 */
import { existsSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { extname, join, normalize, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pathToFileURL } from 'node:url';

const HERE = import.meta.dirname;
const COMPILED = resolve(HERE, '../.test-build/app/functions/_middleware.js');
export const DIST = resolve(HERE, '../dist');
/** The fixture and bridge-test builds, which never go to dist. */
export const FIXTURE_DIST = resolve(HERE, '../.fixture-dist');
export const BRIDGE_DIST = resolve(HERE, '../.bridge-dist');

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.jpg': 'image/jpeg',
  '.png': 'image/png',
  '.json': 'application/json',
  '.woff2': 'font/woff2',
};

export function loadMiddleware() {
  if (!existsSync(COMPILED)) {
    throw new Error('The middleware is not compiled. Run `npm test` in app/ first.');
  }
  return createRequire(import.meta.url)(COMPILED);
}

/** What Cloudflare's asset server would return for a path, as a Response. */
async function staticResponse(dist, url) {
  let file = normalize(join(dist, decodeURIComponent(url.pathname)));
  if (!file.startsWith(dist)) return new Response('forbidden', { status: 403 });
  try {
    if ((await stat(file)).isDirectory()) file = join(file, 'index.html');
  } catch {
    if (extname(file)) return new Response('not found', { status: 404 });
    file = join(dist, 'index.html');
  }
  const body = await readFile(file);
  return new Response(body, {
    status: 200,
    headers: { 'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream' },
  });
}

/**
 * node:http server whose every request goes through the middleware first.
 *
 * `api`, when given, answers /api/* requests the middleware admits, the way a
 * Pages Function or a mounted Worker would, and receives the request the
 * middleware passes on (which may differ from the browser's: a public read
 * loses its cookies). Without it they fall through to the static files, as
 * before. `observe`, when given, sees each request exactly as the browser
 * sent it, before the middleware. `env` is read on every request, so a test
 * can break the gate configuration mid-run by changing it.
 */
export function createGatedServer({ env, dist = DIST, middleware = loadMiddleware(), api = null, observe = null }) {
  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://${req.headers.host}`);
      const headers = new Headers();
      for (const [name, value] of Object.entries(req.headers)) {
        if (Array.isArray(value)) value.forEach((v) => headers.append(name, v));
        else if (value !== undefined) headers.set(name, value);
      }
      const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
      const request = new Request(url, {
        method: req.method,
        headers,
        body: hasBody ? Readable.toWeb(req) : undefined,
        duplex: hasBody ? 'half' : undefined,
      });
      observe?.(request);
      const next = (passed) => (api && url.pathname.startsWith('/api/') ? api(passed ?? request) : staticResponse(dist, url));
      const response = await middleware.onRequest({ request, env, next });
      const cookies = response.headers.getSetCookie();
      for (const [name, value] of response.headers) {
        if (name.toLowerCase() !== 'set-cookie') res.setHeader(name, value);
      }
      if (cookies.length) res.setHeader('Set-Cookie', cookies);
      res.writeHead(response.status);
      res.end(req.method === 'HEAD' ? undefined : Buffer.from(await response.arrayBuffer()));
    } catch (error) {
      res.writeHead(500, { 'Content-Type': 'text/plain' }).end(String(error));
    }
  });
}

// Run directly: serve on a local port for a look in a real browser.
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const port = Number(process.argv[2] ?? 5290);
  const env = { BETA_PASSWORD: process.env.BETA_PASSWORD, BETA_COOKIE_KEY: process.env.BETA_COOKIE_KEY };
  createGatedServer({ env }).listen(port, '127.0.0.1', () => {
    console.log(`gated app on http://127.0.0.1:${port}`);
  });
}
