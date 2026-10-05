/**
 * What must never ship in a deployable build, in one list.
 *
 * vite.config.ts runs findForbidden over every script, stylesheet and page a
 * deployable build emits, then over the whole output directory, and fails the
 * build on any hit. tests/render.test.mjs runs it over the built dist, and
 * scripts/release.mjs refuses to record a dist that has one. The markers are
 * the words and values of sample, practice, fixture and test-only code: a hit
 * means such code reached the bundle, whatever the screen shows.
 *
 * assertDeployable says what a deployable mode of vite.config.ts may never
 * be: anything but live reads through the bridge, of the reviewed pool
 * selection, with no lab and every other flag off.
 */

/** @type {ReadonlyArray<{ name: string; pattern: RegExp }>} */
export const FORBIDDEN = [
  { name: 'local development boundary', pattern: /local-live|dev-read\.domino\.money|CF-Access-Client-Secret|CF-Access-Client-Id|__DOMINO_LOCAL_LIVE__|Local real-data development/ },
  // Sample and practice data or wording, in any case.
  { name: 'sample', pattern: /sample/i },
  { name: 'practice', pattern: /practice/i },
  // The invented example pair and its artwork.
  { name: 'example token', pattern: /\bMEME\b|Example token/ },
  // The fixture and test builds: their banner, labels, lab, data and ids.
  { name: 'test build banner', pattern: /Fixture build|Bridge test build|Not deployable|data-build-banner/ },
  { name: 'fixture labels', pattern: /Fixture data|Contract fixtures/ },
  { name: 'fixture files', pattern: /fixtures\/(gateway|error|invalid|requests)\b/ },
  // 2026-10-02 (Domino V2, spec F7 §7.5): the V2 fixture manifests (app/src/v2/fixtures). Changed on purpose (data) 2026-10-03
  // (main 597bcb7b, #302 merged): they carry the owner's real roles and the production CREATE3 addresses, so they are
  // caught by their fork rehearsal's verification blocks and first receipts, which no real deployment ever carries.
  { name: 'V2 fixture manifest', pattern: /a76e0a19b5a2f32b0a030cb8b8d10ad40fbc2b0520d0982b790ebcc8e2c3eaff|c7af84d2e9141bf3f9ea76521bef15a773d416a36dc633ee6107138e6b16d2f6|3c8046a86f3cdebc8e9d6ea2a83cd1bce7d60ee65ee107fe0b7bdf13c3d196b1|6c6acdaf64f555c412908b88045548ce7ea540790976c4adc1432bac15b19846|e909ff8c39d6f1f4ca5159a8c173029d3a8486c89eecee896a996a163b2cd77f|fc29003e425ef9d7d212207fb27421fb56bf0ca69bce3e06f242f7f207de1365/i },
  // 2026-10-02 (Domino V2, spec F7 §1.1, §7.5): V2's screens, which only the v2-test build carries (their root's mark).
  { name: 'V2 test screens', pattern: /data-v2-test-build/ },
  // Changed on purpose (data) 2026-10-02 (Domino V2 integration, item 6): that build and its screens are gone; both marks
  // stay forbidden, so a stale bundle of either can still never ship.
  // Changed on purpose (data) 2026-10-02 (Domino V2 preview build): the v2-preview build's own mark, beside the one above
  // (its V2 root carries both), so a preview bundle is refused in any release even if the test mark ever went.
  { name: 'V2 preview build', pattern: /data-v2-preview-build/ },
  // Changed on purpose (data) 2026-10-02 (Domino V2 integration, the preview-v2 build): the page of every build that
  // compiles V2 in, preview-v2 above all, is marked on its root element (vite.config.ts v2BuildMark), so such a dist is
  // refused in any release (scripts/release.mjs record and verify) and fails a deployable build's own bundle check.
  { name: 'V2 build', pattern: /data-v2-build/ },
  { name: 'fixture pool id', pattern: /0911afcb281d7bcae2d71443ceaeebd0f89b4537708449970d797622b4b4c941/i },
  { name: 'fixture snapshot hash', pattern: /abababababababab/i },
  { name: 'test cursor', pattern: /c0ffeec0ffee/i },
  { name: 'hostile symbol probe', pattern: /onerror=alert/i },
  { name: 'read lab', pattern: /read-lab/ },
  // Flags later changes (#70's wallet session, #72's deposit preview) must keep out of a deployable build.
  { name: 'test hooks', pattern: /testHooks|__DOMINO_TEST_HOOKS__/ },
  { name: 'deposit lab', pattern: /depositLab/ },
  // 2026-10-01 (RPC-SPEC §2.8): Domino's own node is the server's alone; a deployable dist never names its token-bearing
  // URL or the secret that holds it.
  { name: 'local node secret', pattern: /rpc\.domino\.money\/[A-Za-z0-9_-]{16}|LOCAL_RPC_URL/ },
  // 2026-10-01 (RPC-SPEC §7.9, the owner's rule: nothing is read from a public RPC): the chain's three public fallbacks
  // the page read from since 2026-09-28. Not the chain's official RPC: the wallet's "add network" names it, for the
  // wallet alone (src/wallet/chain.ts).
  { name: 'public RPC fallback', pattern: /robinhood-rpc\.publicnode\.com|rpc\.ordofi\.network|robinhood\.drpc\.org/i },
]

/**
 * Changed on purpose (data) 2026-10-02 (Domino V2 integration, the preview-v2 build): the markers a site that is
 * published but never released (preview-v2, on the preview alias, with real wallets) must not carry either
 * (vite.config.ts previewSiteBundleCheck): the local-development boundary, test hooks, the labs, the node's secret, the
 * public RPCs and the old fixture-only preview. The rest of FORBIDDEN is V2's own marked test data and the build's V2
 * mark, which it may carry and for which every release refuses it.
 */
export const PREVIEW_SITE_FORBIDDEN = new Set(['local development boundary', 'read lab', 'test hooks', 'deposit lab', 'local node secret', 'public RPC fallback', 'V2 preview build'])

/** Files a build emits that are text, and so are scanned. Images and fonts are binary and carry no code. */
export const TEXT_FILE = /\.(html|js|mjs|cjs|css|json|svg|txt|map|webmanifest|xml)$/i

/**
 * Every forbidden marker in `text`, each with a little context, at most
 * `limit` hits per marker so one bad bundle does not flood the log.
 */
export function findForbidden(text, limit = 3) {
  const found = []
  for (const { name, pattern } of FORBIDDEN) {
    const all = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`)
    let count = 0
    for (const match of text.matchAll(all)) {
      const at = match.index ?? 0
      found.push({ marker: name, match: match[0], at, context: text.slice(Math.max(0, at - 30), at + match[0].length + 30) })
      count += 1
      if (count >= limit) break
    }
  }
  return found
}

/**
 * The keys a deployable mode is made of. Any other key must be off: false,
 * absent, null, zero or empty.
 *
 * `wallet` joined them when wallet sign-in shipped: the deployed build carries
 * the feature, so it is a legitimate part of a deployable mode rather than a
 * test flag. `testHooks` deliberately did not: it stays outside this set, so a
 * deployable mode that switches it on is refused by the loop below, and the
 * FORBIDDEN list above refuses a bundle that so much as names it.
 *
 * Changed on purpose (data) 2026-10-02 (Domino V2 integration): `site` joined them: a deployable build is the real site
 * for V1 (vite.config.ts MODES), so it may say so.
 *
 * Changed on purpose 2026-10-04 (the owner: the site runs on Domino V2, its contracts deployed and pinned on every chain):
 * `v2` joined them. A deployable build carries V2's code and its pinned production manifests, never V2's test data: the
 * fixture sets stay with the builds that are not deployable (`__DOMINO_V2_FIXTURE_SETS__`), and FORBIDDEN still refuses
 * their fixture manifests, V2's test screens and the V2 build mark in any deployable bundle.
 */
const MODE_KEYS = new Set(['read', 'pools', 'deployable', 'outDir', 'lab', 'wallet', 'site', 'v2'])

/**
 * Throws unless a deployable mode reads live through the bridge, from the
 * reviewed pool selection, builds no lab, and switches nothing else on: no
 * test hooks, no preview, no deposit lab, no flag a later mode adds. Wallet
 * sign-in is part of what deploys and so is allowed; its test hooks are not.
 */
export function assertDeployable(mode, row) {
  const problems = []
  if (row.read !== 'bridge') problems.push(`reads ${String(row.read)}, not through the bridge`)
  if (row.pools !== 'selected') problems.push(`reads the ${String(row.pools)} pool set, not the reviewed selection`)
  if (row.lab) problems.push('builds the read lab')
  for (const [key, value] of Object.entries(row)) {
    if (!MODE_KEYS.has(key) && value) problems.push(`switches on ${key}`)
  }
  if (problems.length > 0) throw new Error(`The ${mode} mode is deployable and may not: ${problems.join('; ')}.`)
}
