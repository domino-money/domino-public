/**
 * One clock jump for the browser scenarios, on Playwright's installed clock.
 *
 * `page.clock.fastForward` fires every due timer at most once — "closing the
 * laptop lid for a while and reopening it later" in Playwright's words — and
 * the scenarios count on exactly that: one refresh per window, one poll per
 * leap. So a jump is still one fastForward, never a sequence of smaller ones,
 * which would fire a repeating timer once per step and change every count.
 *
 * What it adds is the wait the leap needs before it. A response still in
 * flight when the clock leaps meets its client timeout inside the leap and
 * reads as an outage while signed in: CI run 35243287546, which 15aa557 fixed
 * at the three sites it hit. The race belongs to every site that jumps, and to
 * every page of the context, whose pages share the clock. So before the leap
 * every open page is waited on until nothing is in flight, on the two signals
 * the app already exposes: the session flow's own busy flag, through the test
 * probe, and `aria-busy` in the document.
 *
 * `pending: true` is for the scenarios that hold a response on purpose and
 * jump across it; they say so at the call site.
 */
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

const quiet = () => {
  const probe = window.__dominoSessionProbe;
  const flowBusy = typeof probe?.busy === 'function' ? probe.busy() : false;
  return !flowBusy && !document.querySelector('[aria-busy="true"]');
};

/** Wait until no page of `page`'s context has a request in flight. */
export async function settled(page, { timeout = 10_000, label = 'every page settled' } = {}) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const pages = page.context().pages().filter((candidate) => !candidate.isClosed());
    const states = await Promise.all(pages.map((candidate) => candidate.evaluate(quiet).catch(() => false)));
    if (states.every(Boolean)) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await sleep(25);
  }
}

/** Settle every page of the context, then jump the shared clock once. */
export async function jump(page, ticks, { pending = false, timeout = 10_000 } = {}) {
  if (!pending) await settled(page, { timeout, label: `every page settled before jumping ${ticks}` });
  await page.clock.fastForward(ticks);
}
