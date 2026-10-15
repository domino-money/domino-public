/**
 * One place every browser test gets its page from.
 *
 * Two things went wrong often enough to belong here rather than in each test.
 *
 * What the browser reports has to be attributed to the page that reported it
 * and to the document that was showing at the time. A list held in a module
 * variable cannot do that: whichever test opened a page last owned the list,
 * so a failure that arrived late was either read by the wrong test or, once
 * another page had opened, silently dropped. Here each page keeps its own
 * list, for as long as the page exists.
 *
 * And a request the test itself stops is not a fault of the page. Measured
 * against a read the server never answers, a reload is the teardown that
 * reports one: the browser cancels what the leaving document still had in
 * flight and calls it net::ERR_ABORTED. A close reported nothing where this
 * was measured — the page's events die with it — and a hash change cancels
 * nothing by itself, since the document stays. Both are marked all the same:
 * what a close reports is a platform's decision rather than a promise, and a
 * screen this app leaves can cancel its own read as it unmounts, which is the
 * test's doing just as much.
 *
 * An /api answer that arrived and a body this app then stopped reading is the
 * same request to Chromium: cancelling that stream reports the request as
 * net::ERR_ABORTED, on a page the test has not touched. That is excused, and
 * only for an /api call, never a navigation, and only one an answer arrived
 * for. An abort with no answer behind it, a navigation abandoned after its
 * answer, and any other resource cut short after its headers all still count.
 *
 * `waitUntil: 'networkidle'` is no protection: it only says nothing was in
 * flight for 500 ms, and on a slow machine the landing has not sent its first
 * read by then — throttled 20x, it went out 3.4 s after goto returned. Nor is
 * the status the landing renders: in the run that failed, the read had its
 * answer 232 ms before the request left the wire, and the reload landed in
 * that gap. So `open` waits for both, and an ERR_ABORTED is excused only when
 * it belongs to a view the test navigated away from or closed. Every other
 * failure, in any document — a non-abort failure, an abort with the page
 * still sitting there, a console error, an uncaught error, a 4xx or 5xx —
 * still counts, which is what keeps an abort the page started itself visible.
 *
 * `open` also waits for the route to show what it is going to show, and for
 * the page's own reads to be off the wire, before it hands the page over. No
 * test has to remember that, and no teardown lands in the middle of a read.
 */

const ABORTED = 'net::ERR_ABORTED';

/** Per page: its problems, its /api trail per document, and what it is doing now. */
const STATE = new WeakMap();
/** The watched pages of a context, so closing the context accounts for all of them. */
const OF_CONTEXT = new WeakMap();

const pathOf = (url) => {
  try {
    return new URL(url).pathname;
  } catch {
    return '';
  }
};

const isApi = (request) => pathOf(request.url()).startsWith('/api/');

/**
 * Records what `page` reports, from now until it closes.
 *
 * `ignore` drops a problem the test deliberately provokes (a probe for a
 * missing file, the access page's own 401). `console`, `requests` and
 * `responses` say whether console errors, failed requests and 4xx/5xx
 * answers count as problems, so a suite keeps asserting exactly what it
 * already asserted. An uncaught error always counts.
 */
export function watch(page, { ignore = () => false, console: withConsole = true, requests = true, responses = true } = {}) {
  const problems = [];
  const state = {
    problems,
    /** The /api requests of each document this page has loaded, in order. */
    api: [],
    /**
     * DEX Screener asked through our own edge (functions/api/read/dex, audit I3, 2026-10-01): token artwork and figures,
     * never a read of the read service, kept apart from `api` so the read trails stay what they were.
     */
    dex: [],
    /**
     * `view` counts what the main frame has shown, a hash away within the same
     * document included, because leaving a screen cancels that screen's reads.
     * A request belongs to the view that was showing when it started.
     */
    view: 0,
    /** A teardown the test asked for, until the next view commits. */
    leaving: false,
    closed: false,
    inFlight: new Map(),
    /** The requests an answer arrived for, whatever became of the body. */
    answered: new WeakSet(),
  };
  STATE.set(page, state);
  const context = page.context();
  if (!OF_CONTEXT.has(context)) OF_CONTEXT.set(context, new Set());
  OF_CONTEXT.get(context).add(page);

  const push = (problem) => {
    if (!ignore(problem)) problems.push(problem);
  };

  page.on('pageerror', (error) => push(`uncaught: ${error.message}`));
  page.on('console', (message) => {
    if (!withConsole || message.type() !== 'error') return;
    // The source is part of the problem: a test that provokes one deliberately
    // knows it by the file it asked for, not by the browser's wording.
    const from = message.location()?.url;
    push(`console.error: ${message.text()}${from ? ` (${from})` : ''}`);
  });
  page.on('request', (request) => {
    // A document of its own: the trail follows the loads, not the hashes.
    if (request.isNavigationRequest() && request.frame() === page.mainFrame()) state.api.push([]);
    // While the test is tearing this view down, anything but the navigation
    // itself was started by the view that is going away.
    state.inFlight.set(request, state.leaving && !request.isNavigationRequest() ? state.view - 1 : state.view);
    // (2026-10-15, pack 7): the page's token lookups ask the edge's new path, /api/read/dex2/; both are DEX reads.
    if (isApi(request) && /^\/api\/read\/dex2?\//.test(pathOf(request.url()))) state.dex.push(`${request.method()} ${pathOf(request.url())}`);
    else if (isApi(request)) {
      if (state.api.length === 0) state.api.push([]);
      state.api.at(-1).push(`${request.method()} ${pathOf(request.url())}`);
    }
  });
  page.on('framenavigated', (frame) => {
    if (frame !== page.mainFrame()) return;
    state.view += 1;
    state.leaving = false;
  });
  page.on('requestfinished', (request) => state.inFlight.delete(request));
  page.on('requestfailed', (request) => {
    const startedIn = state.inFlight.get(request) ?? state.view;
    state.inFlight.delete(request);
    const error = request.failure()?.errorText;
    // The test left this view or closed the page: it stopped this itself.
    if (error === ABORTED && (state.closed || startedIn < state.view)) return;
    // An /api read this app answered and then stopped reading. It cancels a
    // body it will not use: an attempt or a read past its deadline, a load
    // superseded by the next one, the last waiter for a shared check leaving,
    // an answer over the size bound. Chromium reports the request that body
    // belonged to as aborted, with the page still sitting there. A body read
    // to the end never reaches here at all, it finishes, so this cannot tell
    // a release from an abandonment. It is therefore kept to exactly the
    // requests that reason covers: an /api call, never a navigation, and only
    // one an answer arrived for. Every other abort still counts.
    if (error === ABORTED && isApi(request) && !request.isNavigationRequest() && state.answered.has(request)) return;
    if (requests) push(`request failed: ${request.url()} (${error})`);
  });
  page.on('response', (response) => {
    state.answered.add(response.request());
    if (responses && response.status() >= 400) push(`${response.status()} for ${response.url()}`);
  });
  page.on('close', () => {
    state.closed = true;
  });
  return state;
}

/** The problems `page` has reported. The array stays the page's for its whole life. */
export const problemsOf = (page) => STATE.get(page).problems;

/** The /api requests of each document `page` has loaded, in order. */
export const apiOf = (page) => STATE.get(page).api;
/** DEX Screener asked through our own edge, every document together (audit I3). */
export const dexOf = (page) => STATE.get(page).dex;

/** Nothing is in flight that the page would lose if it were torn down now. */
export async function readsOffTheWire(page, timeout = 30_000) {
  const state = STATE.get(page);
  const until = Date.now() + timeout;
  for (;;) {
    const open = [...state.inFlight.keys()].filter((request) => isApi(request));
    if (open.length === 0) return;
    if (Date.now() > until) throw new Error(`a read was still in flight after ${timeout} ms: ${open.map((request) => request.url()).join(', ')}`);
    await page.waitForTimeout(25);
  }
}

/**
 * The route once it shows what it is going to show, and with its reads off
 * the wire.
 *
 * The landing has a read: it is shown when its status line says how that read
 * went, whatever the answer — not connected here, a failure or a result set
 * elsewhere. A route with no read is shown by its heading, and then a frame,
 * by when React has run the effects of that render, which is where a read
 * would start.
 */
export async function shown(page, route = '/', { timeout = 60_000 } = {}) {
  if (route === '/') {
    await page.waitForFunction(
      () => {
        const status = document.querySelector('#pools [data-read-status]')?.getAttribute('data-read-status');
        return Boolean(status) && status !== 'loading';
      },
      undefined,
      { timeout },
    );
  } else {
    await page.locator('h1').first().waitFor({ timeout });
    await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(done, 0)))));
  }
  await readsOffTheWire(page);
}

/**
 * A page that records what it reports, on the given route, ready to act on.
 *
 * `route` goes through `#`, the way this app addresses its screens; a suite
 * whose server wants a plain URL passes `url` instead.
 */
export async function open(browser, { origin, route = '/', url, viewport = { width: 1280, height: 900 }, wait = true, ...options } = {}) {
  const page = await browser.newPage({ viewport });
  watch(page, options);
  await page.goto(url ?? `${origin}/#${route}`, { waitUntil: 'networkidle' });
  if (wait) await shown(page, route);
  return page;
}

/**
 * Announces that the test is about to take the current view away from the
 * page — a reload, a link, a hash, a sign-out. What that view still has in
 * flight goes with it.
 */
export function leaving(page) {
  const state = STATE.get(page);
  if (!state) return;
  state.leaving = true;
  for (const [request, startedIn] of state.inFlight) {
    if (!request.isNavigationRequest()) state.inFlight.set(request, Math.min(startedIn, state.view - 1));
  }
}

/**
 * Reloads a page from `open`, and waits for the route again. What the
 * previous document still had in flight is stopped by the reload itself, so
 * its ERR_ABORTED is not the page's error; any other failure, of either
 * document, still is.
 */
export async function reload(page, route = '/', { wait = true } = {}) {
  leaving(page);
  await page.reload({ waitUntil: 'networkidle' });
  if (wait) await shown(page, route);
}

/** Goes to another screen of the same app, as a link or a hash would. */
export async function go(page, route, { wait = true } = {}) {
  leaving(page);
  await page.evaluate((hash) => {
    location.hash = hash;
  }, `#${route}`);
  await page.waitForFunction((hash) => location.hash === hash, `#${route}`);
  if (wait) await shown(page, route);
}

/** Closes a page from `open`. Whatever it still had in flight goes with it. */
export async function close(page) {
  leaving(page);
  const state = STATE.get(page);
  if (state) state.closed = true;
  await page.close();
}

/** Closes a context, accounting for every watched page in it the same way. */
export async function closeContext(context) {
  for (const page of OF_CONTEXT.get(context) ?? []) {
    leaving(page);
    STATE.get(page).closed = true;
  }
  await context.close();
}
