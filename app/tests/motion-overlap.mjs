/**
 * Whether the footer's motion control (Pause motion / Resume motion) covers
 * any text, for the tests that drive a built page in a browser
 * (render.test.mjs, release.browser.test.mjs).
 *
 * Changed on purpose (owner, 2026-09-26: dark only): this checked the
 * appearance toggle, which is gone with the light theme. The motion control
 * sat beside it in the footer's last row and is what remains there, so it
 * keeps the same protection: in the footer's own flow, never over the page.
 *
 * Scrolls the page from top to bottom a third of a viewport at a time, then
 * brings the top and the bottom of each of `stops` (selectors) to the edge
 * of the viewport, and at every position lists each visible text node whose
 * box meets the control's. Returns those hits, and which stops were found, so
 * a caller can tell the parts it asked about were really on the page.
 */

/** The widths the control is checked at: a phone, a tablet at md, a laptop. */
export const CONTROL_VIEWPORTS = [
  [390, 844],
  [768, 1024],
  [1280, 900],
];

/** The motion control's accessible name, in either of its two states. */
export const MOTION_CONTROL = /^(Pause|Resume) motion$/;

export function textUnderMotionControl(page, stops = []) {
  return page.evaluate(async ({ selectors, name }) => {
    const pattern = new RegExp(name);
    const control = [...document.querySelectorAll('footer button')].find((button) => pattern.test(button.textContent.trim()));
    if (!control) return { hits: ['no motion control'], seen: [] };
    const hits = [];
    const seen = [];
    const settle = () => new Promise((done) => setTimeout(done, 30));
    const check = (where) => {
      const t = control.getBoundingClientRect();
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (!node.textContent.trim() || control.contains(node)) continue;
        const style = getComputedStyle(node.parentElement);
        if (style.visibility === 'hidden' || style.display === 'none' || node.parentElement.closest('[aria-hidden="true"], .sr-only')) continue;
        const range = document.createRange();
        range.selectNodeContents(node);
        for (const r of range.getClientRects()) {
          if (r.width === 0 || r.height === 0 || r.bottom <= 0 || r.top >= window.innerHeight) continue;
          if (r.left < t.right && r.right > t.left && r.top < t.bottom && r.bottom > t.top) {
            hits.push(`${where}: "${node.textContent.trim().slice(0, 40)}"`);
            break;
          }
        }
      }
    };
    const step = Math.floor(window.innerHeight / 3);
    for (let y = 0; y <= document.documentElement.scrollHeight; y += step) {
      window.scrollTo(0, y);
      await settle();
      check(`at scroll ${y}`);
    }
    for (const selector of selectors) {
      const target = document.querySelector(selector);
      if (!target) continue;
      seen.push(selector);
      for (const block of ['start', 'end']) {
        target.scrollIntoView({ block });
        await settle();
        check(`${selector} at the ${block === 'start' ? 'top' : 'bottom'}`);
      }
    }
    return { hits: [...new Set(hits)], seen };
  }, { selectors: stops, name: MOTION_CONTROL.source });
}
