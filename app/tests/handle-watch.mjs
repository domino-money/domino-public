/**
 * Where a continuation handle must never be, checked two ways for B4 and the
 * fixture wallet test: `watchForHandle` runs in the page before any app code
 * and records every moment a copy of the handle is written to the DOM, the
 * URL, history state, storage or a cookie, even one removed again straight
 * away; `handlePlaces` looks at the same places at one moment, so a test can
 * look while the handle is live (after the first page, before Load more) and
 * again at the end.
 */

/** Runs in the page (page.addInitScript). `prefix` is a slice of the handle. */
export function watchForHandle(prefix) {
  const sightings = [];
  Object.defineProperty(window, '__handleSightings', { value: sightings });
  const note = (where, value) => {
    if (String(value ?? '').includes(prefix)) sightings.push(where);
  };
  const scan = (node) => note('dom', node.nodeType === 1 ? node.outerHTML : node.textContent);
  new MutationObserver((records) => {
    for (const r of records) {
      if (r.type === 'attributes') {
        note('dom', r.oldValue);
        note('dom', r.target.getAttribute(r.attributeName));
      } else if (r.type === 'characterData') {
        note('dom', r.oldValue);
        note('dom', r.target.data);
      } else {
        r.addedNodes.forEach(scan);
        r.removedNodes.forEach(scan);
      }
    }
  }).observe(document, { subtree: true, childList: true, attributes: true, attributeOldValue: true, characterData: true, characterDataOldValue: true });
  for (const name of ['pushState', 'replaceState']) {
    const original = history[name];
    history[name] = function (state, title, url) {
      note('history', JSON.stringify(state ?? null));
      note('url', url);
      return original.apply(this, arguments);
    };
  }
  addEventListener('hashchange', (event) => note('url', event.newURL));
  addEventListener('popstate', () => note('url', location.href));
  const setItem = Storage.prototype.setItem;
  Storage.prototype.setItem = function (key, value) {
    note(this === localStorage ? 'localStorage' : 'sessionStorage', `${key}=${value}`);
    return setItem.apply(this, arguments);
  };
  const cookie = Object.getOwnPropertyDescriptor(Document.prototype, 'cookie');
  Object.defineProperty(document, 'cookie', {
    configurable: true,
    get() {
      return cookie.get.call(this);
    },
    set(value) {
      note('cookie', value);
      cookie.set.call(this, value);
    },
  });
}

/** Which places hold `prefix` right now. */
export const handlePlaces = (page, prefix) =>
  page.evaluate((text) => {
    const has = (value) => String(value ?? '').includes(text);
    return {
      dom: has(document.documentElement.outerHTML),
      url: has(location.href),
      referrer: has(document.referrer),
      localStorage: has(JSON.stringify({ ...localStorage })),
      sessionStorage: has(JSON.stringify({ ...sessionStorage })),
      history: has(JSON.stringify(history.state)),
      cookie: has(document.cookie),
    };
  }, prefix);

export const NOWHERE = { dom: false, url: false, referrer: false, localStorage: false, sessionStorage: false, history: false, cookie: false };

/** Every place the in-page watcher saw `prefix` since the page loaded. */
export const handleSightings = (page) => page.evaluate(() => [...window.__handleSightings]);
