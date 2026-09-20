#!/usr/bin/env node
/**
 * One bounded, read-only cold Markets load against the production beta.
 *
 * Uses the app's actual TypeScript loader, scheduler, bridge pipeline and
 * contract validators. This is a data-pipeline benchmark, not a DOM-paint
 * benchmark. It does not mount chart cards or run quiet background retries.
 *
 * npm ci --prefix app --ignore-scripts
 * node scripts/benchmark-frontend-data.mjs < /private/password-input
 *
 * Password: one line on stdin, never an argument or environment variable.
 * Stdout: JSONL with only sanitized route, timing, capability and data-age
 * observations. Cookies and response/request bodies are never printed or
 * persisted. No API writes other than obtaining the beta access cookie.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as v1 from '../api-contracts/read-v1/runtime.mjs';
import * as v2 from '../api-contracts/read-v2/runtime.mjs';
import * as v3 from '../api-contracts/read-v3/runtime.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const APP = resolve(ROOT, 'app');
const ORIGIN = 'https://domino.money';
const USER_AGENT = 'Mozilla/5.0 (compatible; DominoLatencyProbe/1.0)';
const MAX_REQUESTS = 60;
const TOTAL_MS = 300_000;
const MAX_BYTES = 1024 * 1024;
const SAFE_ROUTES = new Set(['capabilities', 'token', 'pools', 'pool-market', 'wallet-assets', 'nft-positions', 'catalogue', 'pool-activity', 'pool-positions', 'pool-metrics', 'markets-snapshot', 'overview', 'history', 'search']);
const storedMode = process.argv.length === 3 && process.argv[2] === '--stored';
const require = createRequire(import.meta.url);
const built = (name) => require(resolve(APP, '.test-build/app/src/lib/read', `${name}.js`));

if (process.argv.length > 2 && !storedMode) {
  if (process.argv.length === 3 && process.argv[2] === '--help') {
    console.log('Read one beta password line from stdin; emit sanitized JSONL for one cold production Markets load. --stored exercises the additive V3 overview adapter; no flag preserves the original legacy baseline. Max 60 reads / 300 seconds. Run npm ci --prefix app --ignore-scripts first.');
    process.exit(0);
  }
  console.error('No command-line credentials or target overrides are accepted. Use --help.');
  process.exit(2);
}
if (process.stdin.isTTY) {
  console.error('Refusing echoed terminal input. Supply the beta password through private stdin.');
  process.exit(2);
}
const compiler = resolve(APP, 'node_modules/typescript/bin/tsc');
if (!existsSync(compiler)) {
  console.error('Missing pinned compiler. Run npm ci --prefix app --ignore-scripts.');
  process.exit(2);
}
execFileSync(process.execPath, [compiler, '-p', 'tsconfig.test.json'], { cwd: APP, stdio: ['ignore', 'inherit', 'inherit'] });
mkdirSync(resolve(APP, '.test-build'), { recursive: true });
writeFileSync(resolve(APP, '.test-build/package.json'), '{"type":"commonjs"}\n');

let password = '';
for await (const chunk of process.stdin) {
  password += chunk.toString('utf8');
  if (Buffer.byteLength(password) > 2048) throw new Error('stdin_limit');
}
password = password.replace(/\r?\n$/, '');
if (!password || /[\r\n]/.test(password)) throw new Error('one_password_line_required');

const rounded = (n) => Math.round(n * 10) / 10;
const word = (s) => typeof s === 'string' && /^[a-zA-Z0-9_.:-]{1,100}$/.test(s) ? s : null;
const number = (n) => typeof n === 'number' && Number.isFinite(n) ? n : null;
const identifier = (s) => typeof s === 'string' && /^0x[a-fA-F0-9]{40}(?:[a-fA-F0-9]{24})?$/.test(s) ? s.toLowerCase() : null;
let start = performance.now();
const elapsed = () => rounded(performance.now() - start);
const emit = (event, data = {}) => process.stdout.write(`${JSON.stringify({ event, atMs: elapsed(), ...data })}\n`);

const login = await fetch(`${ORIGIN}/__beta/login`, {
  method: 'POST', redirect: 'manual',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: ORIGIN, Referer: `${ORIGIN}/`, 'User-Agent': USER_AGENT },
  body: new URLSearchParams({ password }), signal: AbortSignal.timeout(15_000),
});
password = '';
const setCookie = login.headers.getSetCookie();
let cookie = setCookie.map((line) => line.split(';', 1)[0]).join('; ');
await login.body?.cancel();
if (login.status !== 303 || !cookie || /[\r\n]/.test(cookie)) {
  emit('authentication_failed', { status: login.status });
  process.exit(1);
}

const { createEstimateSource } = built('estimateSource');
const { createPublicSource } = built('publicSource');
const { createPublicMetadataCache } = built('publicMetadataCache');
const { createScheduledSource } = built('scheduler');
const { loadSelectedPools } = built('marketsProvider');
const { createSnapshotMemo } = built('marketsSnapshot');
const { realClock } = built('pipeline');
const { SELECTED_POOLS } = require(resolve(APP, '.test-build/app/src/config/selectedPools.js'));
const abort = new AbortController();
let requestCount = 0;
let activeRequest = null;
const starts = [];
const ends = [];
const capabilityAnswers = [];
const seenRows = new Set();
let firstRowMs = null;
let allRowsMs = null;
// These timings mean token reads have settled, including failed/partial
// metadata. They do not establish that a numerical price can be displayed.
let firstPricedRowMs = null;
let allPricedRowsMs = null;
let sleepMs = 0;
const revision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim();
start = performance.now();
const startedAt = new Date().toISOString();
const stop = setTimeout(() => abort.abort(new Error('benchmark_deadline')), TOTAL_MS);
const clock = {
  ...realClock,
  sleep: async (ms, signal) => {
    const began = performance.now();
    emit('scheduler_wait', { durationMs: rounded(ms) });
    try { return await realClock.sleep(ms, signal); }
    finally { sleepMs += performance.now() - began; }
  },
};

async function tracedFetch(path, init) {
  if (!/^\/api\/read\/v[123]\/[a-z-]+$/.test(path)) throw new Error('route_refused');
  const route = path.split('/').at(-1);
  if (!SAFE_ROUTES.has(route)) throw new Error('route_refused');
  if (abort.signal.aborted || requestCount >= MAX_REQUESTS) {
    abort.abort(new Error('benchmark_bound'));
    throw new Error('benchmark_bound');
  }
  const id = ++requestCount;
  const began = elapsed();
  const body = typeof init.body === 'string' ? JSON.parse(init.body) : null;
  const request = {
    id, path, method: init.method, startMs: began,
    poolId: identifier(body?.poolId), token: identifier(body?.token),
    requestedPools: Array.isArray(body?.poolIds) ? body.poolIds.length : null,
    includePriceHistory: typeof body?.includePriceHistory === 'boolean' ? body.includePriceHistory : null,
  };
  starts.push(request);
  activeRequest = request;
  emit('request_start', request);
  const headers = new Headers(init.headers);
  headers.set('Cookie', cookie);
  headers.set('Origin', ORIGIN);
  headers.set('Referer', `${ORIGIN}/`);
  headers.set('User-Agent', USER_AGENT);
  headers.set('Sec-Fetch-Site', 'same-origin');
  headers.set('Sec-Fetch-Mode', 'same-origin');
  headers.set('Sec-Fetch-Dest', 'empty');
  try {
    const response = await fetch(`${ORIGIN}${path}`, { ...init, headers, redirect: 'manual', signal: AbortSignal.any([abort.signal, init.signal].filter(Boolean)) });
    const headersMs = elapsed();
    const reader = response.body?.getReader();
    const chunks = [];
    let size = 0;
    while (reader) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.length;
      if (size > MAX_BYTES) { await reader.cancel(); throw new Error('response_limit'); }
      chunks.push(part.value);
    }
    const bytes = Buffer.concat(chunks);
    let reply;
    try { reply = JSON.parse(bytes.toString('utf8')); } catch { reply = null; }
    const result = {
      ...request, endMs: elapsed(), headersMs, durationMs: rounded(elapsed() - began),
      status: response.status, bytes: size,
      retryAfter: word(response.headers.get('Retry-After')),
      requestId: word(response.headers.get('X-Domino-Request-Id')),
      contract: word(response.headers.get('X-Domino-Read-Contract')),
      error: word(reply?.error),
    };
    if (route === 'capabilities') {
      result.capabilities = { dataMode: word(reply?.dataMode), enabledReads: Array.isArray(reply?.enabledReads) ? reply.enabledReads.filter((item) => SAFE_ROUTES.has(item)) : null };
      capabilityAnswers.push({ path, ...result.capabilities });
    }
    if (route === 'markets-snapshot') result.snapshot = {
      status: word(reply?.status), ageSeconds: number(reply?.ageSeconds), builtAt: number(reply?.builtAt),
      poolCount: Array.isArray(reply?.pools) ? reply.pools.length : null,
    };
    if (route === 'overview') result.overview = {
      generatedAt: number(reply?.generatedAt), revision: number(reply?.revision),
      acquisitionAccepted: reply?.acquisitionAccepted === true,
      pools: Array.isArray(reply?.pools) ? reply.pools.map((entry) => ({ poolId: identifier(entry.poolId), observedAt: number(entry.observedAt), acquisition: word(entry.acquisition?.status), hasValue: entry.value !== null })) : null,
      tokenCount: Array.isArray(reply?.tokens) ? reply.tokens.length : null,
    };
    const market = path.includes('/v2/') ? reply?.market?.market : reply?.market;
    if (route === 'pool-market') result.market = { status: word(market?.status), reason: word(market?.reason), cacheAgeSeconds: number(market?.cache?.ageSeconds), retrievedAt: number(market?.data?.retrievedAt) };
    ends.push(result);
    emit('request_end', result);
    return new Response(bytes, { status: response.status, statusText: response.statusText, headers: response.headers });
  } catch (error) {
    const result = { ...request, endMs: elapsed(), durationMs: rounded(elapsed() - began), failure: word(error?.name) ?? 'Error' };
    ends.push(result);
    emit('request_end', result);
    throw error;
  } finally { activeRequest = null; }
}

const options = { enabled: true, validators: v1, fetch: tracedFetch, clock };
const legacy = createEstimateSource(options, v2);
const raw = storedMode ? createPublicSource(legacy, options, v3) : legacy;
const scheduler = createPublicMetadataCache(createScheduledSource(raw, { minIntervalMs: 1100, clock }), clock);
const source = {
  ...scheduler,
  read: (route, request, opts = {}) => scheduler.read(route, request, { ...opts, signal: AbortSignal.any([abort.signal, opts.signal].filter(Boolean)) }),
  routeEnabled: (route, opts = {}) => scheduler.routeEnabled(route, { ...opts, signal: AbortSignal.any([abort.signal, opts.signal].filter(Boolean)) }),
};
emit('benchmark_start', { startedAt, revision, origin: ORIGIN, userAgent: USER_AGENT, mode: storedMode ? 'cold_stored_overview_pipeline' : 'cold_markets_pipeline', priceTimingMeaning: 'token_metadata_reads_settled_not_verified_price', maxRequests: MAX_REQUESTS, totalBudgetMs: TOTAL_MS, poolCount: SELECTED_POOLS.length, minIntervalMs: 1100, burst: 5, perMinute: 30 });
try {
  const loaded = await loadSelectedPools(source, SELECTED_POOLS, abort.signal, (rows) => {
    const newlyVisible = [];
    for (const row of rows) if (!seenRows.has(row.poolId)) { seenRows.add(row.poolId); newlyVisible.push(row.poolId); }
    if (rows.length && firstRowMs === null) firstRowMs = elapsed();
    if (rows.length === SELECTED_POOLS.length && allRowsMs === null) allRowsMs = elapsed();
    const metadataReadyRows = rows.filter((row) => row.tokensPending !== true).length;
    if (metadataReadyRows && firstPricedRowMs === null) firstPricedRowMs = elapsed();
    if (metadataReadyRows === SELECTED_POOLS.length && allPricedRowsMs === null) allPricedRowsMs = elapsed();
    emit('rows_progress', { rowCount: rows.length, metadataReadyRows, newlyVisible, rows: rows.map((row) => ({
      poolId: row.poolId, tokensPending: row.tokensPending === true,
      block: number(row.provenance?.block), cacheAgeSeconds: number(row.provenance?.market?.cacheAgeSeconds),
      marketStatus: word(row.provenance?.market?.status), metricStatus: word(row.provenance?.metrics?.freshness),
      hasEstimate: Boolean(row.feeAprEstimate),
    })) });
  }, { tokens: new Map(), snapshot: createSnapshotMemo(clock.monotonic), metrics: true, overview: storedMode });
  emit('benchmark_summary', {
    elapsedMs: elapsed(), firstRowMs, allRowsMs, firstPricedRowMs, allPricedRowsMs,
    priceTimingMeaning: 'token_metadata_reads_settled_not_verified_price', settledRows: loaded.rows.length,
    aborted: loaded.aborted || abort.signal.aborted, blocking: loaded.blocking ? { state: word(loaded.blocking.state), route: word(loaded.blocking.route) } : null,
    requestCount, recordedResponses: ends.length, schedulerSleepMs: rounded(sleepMs),
    capabilityAnswers, statuses: ends.reduce((counts, entry) => { const status = String(entry.status ?? 'transport'); counts[status] = (counts[status] ?? 0) + 1; return counts; }, {}),
    problems: loaded.problems.map((problem) => ({ poolId: problem.poolId, route: word(problem.outcome.route), state: word(problem.outcome.state), reason: word(problem.outcome.reason), producerCode: word(problem.outcome.cause?.code) })),
  });
  if (loaded.aborted || loaded.blocking || abort.signal.aborted) process.exitCode = 1;
} catch (error) {
  emit('benchmark_failed', { failure: word(error?.name) ?? 'Error', requestCount, activePath: activeRequest?.path ?? null });
  process.exitCode = 1;
} finally {
  clearTimeout(stop);
  cookie = '';
}
