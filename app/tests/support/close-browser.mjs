/**
 * Closes a browser that chromium.launch() started, without waiting for the
 * processes that outlive it.
 *
 * playwright-core's close() resolves once the browser's stdout and stderr
 * reach EOF, not once the browser exits. On macOS, branded Chrome starts
 * GoogleUpdater (--wake-all) about 20 seconds after launch. The updater and
 * the crash handlers inherit those pipes, in process groups of their own that
 * close() never signals, and hold them until they are done: 22 seconds to ten
 * minutes on 25 September 2026. close() waited all that time, and so did
 * every browser suite.
 *
 * The browser has exited once it disconnects. From then on this gives close()
 * `settleMs` to finish (it still removes the temporary profile) and then stops
 * waiting for it. The pipes keep the file's event loop alive all the same, so
 * every node --test that runs a browser suite passes --test-force-exit, which
 * ends the file once its tests and hooks are done.
 */
export async function closeBrowser(browser, { settleMs = 5_000 } = {}) {
  if (!browser) return;
  const exited = browser.isConnected() ? new Promise((resolve) => browser.once('disconnected', resolve)) : Promise.resolve();
  const closed = browser.close();
  let timer;
  let done = false;
  const settled = exited.then(() => new Promise((resolve) => { if (!done) timer = setTimeout(resolve, settleMs); }));
  try {
    await Promise.race([closed, settled]);
  } finally {
    done = true;
    clearTimeout(timer);
  }
}
