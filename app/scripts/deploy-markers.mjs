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
 */
const MODE_KEYS = new Set(['read', 'pools', 'deployable', 'outDir', 'lab', 'wallet'])

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
