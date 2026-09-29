// Home's and Markets' first reads, sent as soon as the page is parsed, while the app's own script (about 290 kB
// compressed) downloads and starts (speed wave, item 10, 2026-09-28): the featured pools list, and the read-v3
// capabilities the overview after it waits for. Only the deployable build loads this file (vite.config.ts earlyList),
// on Home and Markets only. The app takes each answer as that read's one attempt (src/lib/read/earlyList.ts), through
// the same checks, deadline and budget as any other read; an answer the app does not take within a few seconds is let
// go. The same same-origin requests the app itself sends, and nothing else.
(function () {
  try {
    // The app got there first (a cached app, this file asked again): it reads for itself.
    if (window.__dominoEarly !== undefined) return
    var segments = location.hash.replace(/^#/, '').split('#')[0].split('/')
    var first = segments[1] || ''
    if (['', 'markets', 'explore', 'pools'].indexOf(first) === -1) return
    // A token's own view (#/markets/<address>, src/components/explore/routes.ts) shows no list.
    if (first !== '' && /^0x[0-9a-fA-F]{40}$/.test(segments[2] || '')) return
    var ask = function (path, method, body) {
      var reply = fetch(path, {
        method: method,
        headers: body === undefined ? { Accept: 'application/json' } : { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: body,
        mode: 'same-origin',
        credentials: 'same-origin',
        redirect: 'manual',
        cache: 'no-store',
        referrerPolicy: 'same-origin',
      })
      reply.catch(function () {})
      return reply
    }
    window.__dominoEarly = {
      at: performance.now(),
      replies: {
        'POST /api/read/v5/featured-pools': ask('/api/read/v5/featured-pools', 'POST', '{}'),
        'GET /api/read/v3/capabilities': ask('/api/read/v3/capabilities', 'GET'),
      },
    }
  } catch (error) {
    // Nothing sent: the app reads for itself, as it always did.
  }
})()
