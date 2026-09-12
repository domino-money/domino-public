/**
 * The harness's own rule about aborts, proved in a real browser.
 *
 * A read of this app that is over cancels the stream of a body it will not
 * use (bridgeSource discards it, boundedBody stops reading on abort). To
 * Chromium that is the request being aborted, reported on a page no test
 * touched, so the harness excuses it — but only where an answer for that
 * request had already arrived. Everything else about an abort still counts,
 * or a read the app cancelled before it was answered would stop being
 * visible, which is the failure this file exists to prevent.
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright-core';
import { problemsOf, watch } from './page-watch.mjs';

const HELD = new Set();
let server;
let browser;
let origin;

before(async () => {
  server = createServer((req, res) => {
    // Headers and one chunk, then held open: the page cancels what it is reading.
    if (req.url === '/answered') {
      res.writeHead(200, { 'content-type': 'text/plain', 'cache-control': 'no-store' });
      res.write('a chunk to read');
      HELD.add(res);
      return;
    }
    // The same, refused: an answer arrived, and it is a 4xx.
    if (req.url === '/answered-4xx') {
      res.writeHead(429, { 'content-type': 'text/plain', 'cache-control': 'no-store' });
      res.write('slow down');
      HELD.add(res);
      return;
    }
    // No answer at all: whatever stops this request was never answered.
    if (req.url === '/silent') {
      HELD.add(res);
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }).end('<!doctype html><title>harness</title>');
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  origin = `http://127.0.0.1:${server.address().port}`;

  const failures = [];
  for (const options of [{ channel: 'chrome' }, { channel: 'chromium' }, { channel: 'msedge' }, {}]) {
    try {
      browser = await chromium.launch(options);
      break;
    } catch (error) {
      failures.push(String(error).split('\n')[0]);
    }
  }
  if (!browser) throw new Error(`No Chromium build could be launched.\n${failures.join('\n')}`);
});

after(async () => {
  for (const res of HELD) res.destroy();
  await browser?.close();
  await new Promise((done) => server.close(done));
});

/** The error text the browser reported for the first failed request whose URL says `mark`. */
const failedFor = (page, mark) =>
  new Promise((done, fail) => {
    const timer = setTimeout(() => fail(new Error(`no failed request for ${mark}`)), 15_000);
    const onFail = (request) => {
      if (!request.url().includes(mark)) return;
      clearTimeout(timer);
      page.off('requestfailed', onFail);
      done(request.failure()?.errorText);
    };
    page.on('requestfailed', onFail);
  });

/** A watched page on the harness server, nothing loaded yet but the shell. */
async function page() {
  const opened = await browser.newPage();
  watch(opened);
  await opened.goto(`${origin}/`);
  return opened;
}

test('a body the page stops reading, after its answer arrived, is not the page\'s error', async () => {
  const open = await page();
  const failed = failedFor(open, '/answered');
  await open.evaluate(async () => {
    const response = await fetch('/answered');
    const reader = response.body.getReader();
    await reader.read();
    await reader.cancel();
  });
  assert.equal(await failed, 'net::ERR_ABORTED', 'the browser has to report this as an abort for the test to mean anything');
  assert.deepEqual(problemsOf(open), [], 'a cancelled body of an answered request is the read ending, not a fault');
  await open.close();
});

test('an abort of a request no answer ever arrived for is still the page\'s error', async () => {
  const open = await page();
  const failed = failedFor(open, '/silent');
  await open.evaluate(() => {
    const controller = new AbortController();
    const sent = fetch('/silent', { signal: controller.signal }).catch(() => undefined);
    setTimeout(() => controller.abort(), 50);
    return sent;
  });
  assert.equal(await failed, 'net::ERR_ABORTED');
  assert.match(problemsOf(open).join('\n'), /request failed: .*\/silent \(net::ERR_ABORTED\)/);
  await open.close();
});

test('a refused answer counts even when the page stops reading its body', async () => {
  const open = await page();
  const failed = failedFor(open, '/answered-4xx');
  await open.evaluate(async () => {
    const response = await fetch('/answered-4xx');
    const reader = response.body.getReader();
    await reader.read();
    await reader.cancel();
  });
  assert.equal(await failed, 'net::ERR_ABORTED');
  assert.match(problemsOf(open).join('\n'), /^429 for .*\/answered-4xx$/m, 'the 429 is the problem, and the cancelled body is not');
  // The browser logs a refused load of its own, so both problems are the 429
  // itself. What matters is that neither of them is the cancelled body.
  for (const problem of problemsOf(open)) assert.match(problem, /429|Too Many Requests/, `not about the refusal: ${problem}`);
  assert.equal(problemsOf(open).filter((problem) => problem.includes('ERR_ABORTED')).length, 0, 'the cancelled body of an answered request is not a problem');
  await open.close();
});
