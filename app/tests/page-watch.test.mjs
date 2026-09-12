/**
 * The harness's own rule about aborts, proved in a real browser, on both
 * sides of the line it draws.
 *
 * This app cancels a response body it will not use: an attempt or a read past
 * its deadline, a load superseded by the next one, the last waiter for a
 * shared capabilities check leaving, an answer over the size bound. Chromium
 * reports the request that body belonged to as net::ERR_ABORTED even though
 * its answer arrived, on a page no test touched, so the harness excuses that
 * one case. A body read to the end never reaches the failure handler at all,
 * so an abort of an answered request always means the body did not complete:
 * the rule cannot tell a release from an abandonment, and it is kept to
 * exactly what the reason covers, an /api call that is not a navigation.
 *
 * The cases below pin both edges. Widen the rule and the last two fail.
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright-core';
import { problemsOf, watch } from './page-watch.mjs';

/** Responses held open on purpose, destroyed when the suite ends. */
const HELD = new Set();
let server;
let browser;
let origin;

/** Headers and one chunk, then held: whatever reads this has to stop it itself. */
const holdAfterHeaders = (res, status, type) => {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
  res.write(type.startsWith('image/') ? Buffer.from('89504e470d0a1a0a', 'hex') : 'a chunk to read');
  HELD.add(res);
};

before(async () => {
  server = createServer((req, res) => {
    if (req.url === '/api/answered') return holdAfterHeaders(res, 200, 'application/json');
    if (req.url === '/api/answered-4xx') return holdAfterHeaders(res, 429, 'application/json');
    // No answer at all: whatever stops this request was never answered.
    if (req.url === '/api/silent') return void HELD.add(res);
    if (req.url === '/mark.png') return holdAfterHeaders(res, 200, 'image/png');
    // A navigation the browser answers and then abandons: it is a download.
    if (req.url === '/attachment') {
      res.writeHead(200, {
        'content-type': 'application/octet-stream',
        'content-disposition': 'attachment; filename="x.bin"',
        'cache-control': 'no-store',
      });
      // Ended, not held: the browser answers the navigation, declines to show
      // it, and aborts the request it already had an answer for.
      res.end('x');
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

/**
 * The same, in a browser of its own. A navigation the browser declines ends
 * the whole instance on some Chromium builds — measured here on Edge, where a
 * context of its own was not enough — and every case after it still needs a
 * browser, so that one runs on an instance it may take down with it.
 */
async function isolatedPage() {
  const failures = [];
  let own;
  for (const options of [{ channel: 'chrome' }, { channel: 'chromium' }, { channel: 'msedge' }, {}]) {
    try {
      own = await chromium.launch(options);
      break;
    } catch (error) {
      failures.push(String(error).split('\n')[0]);
    }
  }
  if (!own) throw new Error(`No Chromium build could be launched.\n${failures.join('\n')}`);
  const opened = await own.newPage();
  watch(opened);
  await opened.goto(`${origin}/`);
  return { page: opened, context: { close: () => own.close().catch(() => undefined) } };
}

test('an /api body the page stops reading, after its answer arrived, is not the page’s error', async () => {
  const open = await page();
  const failed = failedFor(open, '/api/answered');
  await open.evaluate(async () => {
    const response = await fetch('/api/answered');
    const reader = response.body.getReader();
    await reader.read();
    await reader.cancel();
  });
  assert.equal(await failed, 'net::ERR_ABORTED', 'the browser has to report this as an abort for the test to mean anything');
  assert.deepEqual(problemsOf(open), [], 'a cancelled body of an answered read is this app releasing it, not a fault');
  await open.close();
});

test('an abort of a request no answer ever arrived for is still the page’s error', async () => {
  const open = await page();
  const failed = failedFor(open, '/api/silent');
  await open.evaluate(() => {
    const controller = new AbortController();
    const sent = fetch('/api/silent', { signal: controller.signal }).catch(() => undefined);
    setTimeout(() => controller.abort(), 50);
    return sent;
  });
  assert.equal(await failed, 'net::ERR_ABORTED');
  assert.match(problemsOf(open).join('\n'), /request failed: .*\/api\/silent \(net::ERR_ABORTED\)/);
  await open.close();
});

test('a refused answer counts even when the page stops reading its body', async () => {
  const open = await page();
  const failed = failedFor(open, '/api/answered-4xx');
  await open.evaluate(async () => {
    const response = await fetch('/api/answered-4xx');
    const reader = response.body.getReader();
    await reader.read();
    await reader.cancel();
  });
  assert.equal(await failed, 'net::ERR_ABORTED');
  assert.match(problemsOf(open).join('\n'), /^429 for .*\/api\/answered-4xx$/m, 'the 429 is the problem, and the cancelled body is not');
  // The browser logs a refused load of its own, so both problems are the 429
  // itself. What matters is that neither of them is the cancelled body.
  for (const problem of problemsOf(open)) assert.match(problem, /429|Too Many Requests/, `not about the refusal: ${problem}`);
  assert.equal(problemsOf(open).filter((problem) => problem.includes('ERR_ABORTED')).length, 0, 'the cancelled body of an answered read is not a problem');
  await open.close();
});

test('a navigation abandoned after its answer is still the page’s error', async () => {
  const { page: open, context } = await isolatedPage();
  const failed = failedFor(open, '/attachment');
  await open.evaluate(() => {
    location.href = '/attachment';
  });
  assert.equal(await failed, 'net::ERR_ABORTED', 'a download the browser declines aborts the navigation it answered');
  assert.match(
    problemsOf(open).join('\n'),
    /request failed: .*\/attachment \(net::ERR_ABORTED\)/,
    'the page is still open: nothing about a navigation is excused',
  );
  await context.close();
});

test('a resource that is not a read, cut short after its answer, is still the page’s error', async () => {
  const open = await page();
  const failed = failedFor(open, '/mark.png');
  await open.evaluate(
    () =>
      new Promise((done) => {
        const img = document.createElement('img');
        img.src = '/mark.png';
        document.body.append(img);
        setTimeout(() => {
          img.remove();
          img.src = '';
          done();
        }, 150);
      }),
  );
  assert.equal(await failed, 'net::ERR_ABORTED');
  assert.match(problemsOf(open).join('\n'), /request failed: .*\/mark\.png \(net::ERR_ABORTED\)/, 'only an /api read releases a body here');
  await open.close();
});
