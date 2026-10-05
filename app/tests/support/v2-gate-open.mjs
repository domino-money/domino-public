/**
 * Loaded into every test process of the V1 browser suites scripts/v1-on-v2.mjs runs on wallet-test-v2, the wallet test
 * build with Domino V2 compiled in (Domino V2 integration, 2026-10-02, the base agent's item 3).
 *
 * Every page any of those suites opens starts with V2's gate open on the test server's origin: the test build's own hook,
 * `window.__dominoV2Test.originOpen` (src/v2/gate.ts reads it where `__DOMINO_TEST_HOOKS__` is on, and only there), set
 * before the page's first script, as the preview alias opens it by its origin. So V1's flows are checked with V2's
 * options inside the screens, in `preview` (run up to the review, locked there), exactly as the owner meets them on the
 * preview. Whatever else a suite puts in `window.__dominoV2Test` is kept.
 *
 * It patches playwright-core's chromium (one instance per process, shared by every suite file): each context a launched
 * browser makes, and each page it opens directly, gets the hook as an init script, which the browser injects itself, so
 * the page's CSP has no say in it. Nothing in the app changes.
 */
import { chromium } from 'playwright-core';

const OPEN = () => {
  window.__dominoV2Test = { ...(window.__dominoV2Test ?? {}), originOpen: true };
};

const launch = chromium.launch.bind(chromium);
chromium.launch = async (...args) => {
  const browser = await launch(...args);
  const newContext = browser.newContext.bind(browser);
  browser.newContext = async (...options) => {
    const context = await newContext(...options);
    await context.addInitScript(OPEN);
    return context;
  };
  const newPage = browser.newPage.bind(browser);
  browser.newPage = async (...options) => {
    const page = await newPage(...options);
    await page.addInitScript(OPEN);
    return page;
  };
  return browser;
};
