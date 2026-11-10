/**
 * The page's boot script: the one inline script index.html carries (2026-10-01, platform workstream: F1, F2, F3).
 *
 * It runs while the page is parsed, before the app's own script has arrived, and does two things:
 *
 *  1. It asks for the code of the route the page opens on. The build splits the app by screen (src/App.tsx), and
 *     writes into the page, beside this script, a table of the route names (src/routeTable.ts) and, for each route, the
 *     files its screen needs that the entry does not carry (vite.config.ts, the domino:boot plugin). This script adds a
 *     <link rel="modulepreload"> for each script and a <link rel="preload" as="style"> for each stylesheet, so they
 *     download beside the entry instead of after it. Changed on purpose 2026-11-07 (pages of their own, src/lib/route.ts):
 *     the route is the address's path (`/markets`), or a link from before (`/#/markets`) as it is, which the app turns
 *     into the path once it starts. A position's page (/positions/<id>) gets its own screen's files
 *     (vite.config.ts ROUTE_MODULES `position`), and since 2026-11-07 (launch sweep F11) Receipts (/positions/receipts)
 *     its own (`receipts`): it took the list's, whose stylesheet it never applies, a console warning a few seconds
 *     after load; until 2026-10-01 a position's page also got the chain code its first read ran (F2),
 *     which runs at the edge since (RPC-SPEC). The links are the ones the app's own loader would add later, with the
 *     same href and crossorigin, so nothing is fetched twice.
 *  2. On Home and Markets only, in the build that reads the live list, it sends the two first reads the app would send
 *     (the featured pools list and the read-v3 capabilities), as public/early-list.js did since 2026-09-28 (speed
 *     wave, item 10); the app takes each answer (src/lib/read/earlyList.ts) through the same checks as any other.
 *  3. Since 2026-10-01 (markets workstream, audit A7 b, the owner's OK), on a first visit (no copy of the last overview
 *     under a day old in this browser, src/lib/read/marketsPaint.ts PAINT_KEY, which it only reads), the moment the
 *     list and the read-v3 capabilities answer, and only where those capabilities list the overview, as the app itself
 *     asks it: the stored overview of the list's pools, in the list's order, lowercase. The app takes that answer only
 *     for that very question (the same body, takeEarly's `method path body` key). The answer is read through a copy at
 *     once, so the request ends whether or not the app takes it. A visitor with a copy has the app ask its pools beside
 *     the list itself.
 *
 * It was a file, public/early-list.js, which the gate answered with `private, no-cache`: one more round trip on every
 * visit before Home's first read (F3). Inline, it costs none. The page's CSP admits exactly this text and no other
 * inline script: APP_CSP names BOOT_SCRIPT_HASH (functions/_middleware.ts), and tests/gate.test.mjs checks that the hash
 * is this text's and that every build writes this text, byte for byte. The table beside it is a data block
 * (type="application/json"), which a browser never runs, so it may differ from build to build.
 *
 * Nothing here stores, reads a cookie, or reaches another host: the three same-origin requests the app itself sends
 * first, preload links for the site's own files, and one read (never a write) of the markets copy's time.
 */
export const BOOT_DATA_ID = 'dm-boot'

/**
 * The markets copy's key, which names its chain (2026-10-01, the chain2 workstream, part B, audit item G10): the one
 * src/lib/read/marketsPaint.ts PAINT_KEY keeps the copy under, from the chain registry (tests/featured-list.test.mjs
 * holds them equal). Written here rather than imported: this module runs as it is in Node too (the build's tests import
 * it directly), so it imports nothing. The script only reads it; a copy still under the old name moves to it the first
 * time the app reads it, so a returning visitor's first load after this change sends the overview read a first visit
 * sends, once.
 */
export const MARKETS_COPY_KEY = 'domino-markets-v2:4663'

export const BOOT_SCRIPT = `(function () {
  try {
    var data = JSON.parse(document.getElementById('${BOOT_DATA_ID}').textContent)
    var route = /^#\\//.test(location.hash) ? location.hash.slice(1) : location.pathname
    var segments = route.split('#')[0].split('/')
    var first = segments[1] || ''
    var second = segments[2] || ''
    var page = Object.prototype.hasOwnProperty.call(data.pages, first) ? data.pages[first] : null
    if (page === 'markets' && second && !/^0x[0-9a-fA-F]{40}$/.test(second)) page = null
    var key = page === 'positions' && /^[1-9][0-9]{0,77}$/.test(second) ? 'position' : page === 'positions' && second === 'receipts' ? 'receipts' : page
    var files = key && Object.prototype.hasOwnProperty.call(data.chunks, key) ? data.chunks[key] : []
    for (var i = 0; i < files.length; i++) {
      var link = document.createElement('link')
      if (/\\.css$/.test(files[i])) {
        link.rel = 'preload'
        link.as = 'style'
      } else {
        link.rel = 'modulepreload'
      }
      link.crossOrigin = ''
      link.setAttribute('href', files[i])
      document.head.appendChild(link)
    }
    if (data.early !== true || window.__dominoEarly !== undefined) return
    if (page !== 'overview' && (page !== 'markets' || second)) return
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
    var list = ask('/api/read/v5/featured-pools', 'POST', '{}')
    var capabilities = ask('/api/read/v3/capabilities', 'GET')
    var replies = {
      'POST /api/read/v5/featured-pools': list,
      'GET /api/read/v3/capabilities': capabilities,
    }
    window.__dominoEarly = { at: performance.now(), replies: replies }
    var copied = false
    try {
      var kept = JSON.parse(localStorage.getItem('${MARKETS_COPY_KEY}') || 'null')
      copied = !!kept && typeof kept.receivedAt === 'number' && Date.now() - kept.receivedAt < 86400000
    } catch (error) {
      copied = false
    }
    var copy = function (reply) {
      return reply.then(function (response) { return response.ok ? response.clone().json() : null }).catch(function () { return null })
    }
    if (!copied) Promise.all([copy(list), copy(capabilities)])
      .then(function (answers) {
        var body = answers[0]
        var listed = answers[1] && answers[1].dataMode !== 'disabled' && Array.isArray(answers[1].enabledReads) ? answers[1].enabledReads : []
        if (listed.indexOf('overview') === -1) return
        var pools = body && Array.isArray(body.pools) ? body.pools : []
        if (pools.length === 0 || pools.length > 24) return
        var ids = pools.map(function (pool) { return String(pool && pool.poolId).toLowerCase() })
        if (!ids.every(function (id) { return /^0x[0-9a-f]{64}$/.test(id) })) return
        var question = JSON.stringify({ poolIds: ids })
        var overview = ask('/api/read/v3/overview', 'POST', question)
        overview.then(function (response) { return response.clone().arrayBuffer() }).catch(function () {})
        replies['POST /api/read/v3/overview ' + question] = overview
      })
      .catch(function () {})
  } catch (error) {}
})()`

/** The CSP source that admits BOOT_SCRIPT and nothing else: its SHA-256, base64. tests/gate.test.mjs recomputes it. */
export const BOOT_SCRIPT_HASH = "'sha256-URUDaaI5RXsAaPdixlfFQ1Ki6D4iKQTyx3vo7lEXXOY='"

/** What the build writes into the page for the boot script: the data block, then the script itself. */
export interface BootData {
  /** Send Home's and Markets' first reads (the build that reads the live list only). */
  early: boolean
  /** The route table: first hash segment to page (src/routeTable.ts). */
  pages: Readonly<Record<string, string>>
  /** Per page (and `position`, a position's own page, and `receipts`, Receipts' since 2026-11-07), the site's files to ask for at once. */
  chunks: Readonly<Record<string, readonly string[]>>
}

/** The two elements, as the page carries them before the entry's module script. `<` is escaped, so no data closes the block. */
export function bootTags(data: BootData): string {
  const json = JSON.stringify(data).replace(/</g, '\\u003c')
  return `<script type="application/json" id="${BOOT_DATA_ID}">${json}</script>\n    <script>${BOOT_SCRIPT}</script>`
}
