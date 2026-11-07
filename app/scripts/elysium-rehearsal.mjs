/**
 * Day 9 rehearsed, for the test builds only (added 2026-11-07, Elysium's screens). A build that forces Elysium on
 * (scripts/elysium-switch.mjs, DOMINO_TEST_ELYSIUM_PROFILE) stands in for rugged97's whole day-9 pull request; besides his
 * enabled profile and record, that pull request brings read-v6 and position-plan-v1 versions that name chain 99901
 * (docs/ELYSIUM_DAY9.md). Without them every read and plan of Elysium is refused by the package the app bundles, so the
 * forced build could only ever show Elysium's screens empty. This module writes those two packages' data as day 9 has
 * them, from the repository's own and the forced profile, and nothing else: each package's schemas name 99901 wherever
 * they name Domino's three chains (an `enum` of chain ids), and its constants take a row for it:
 *   - read-v6: CONSTANTS.chainIds ends with 99901; CONSTANTS.priceProfiles[99901] is the profile's stable and wrapped
 *     token, and its HYPE priced at its native pool alone (`nativePool`, the runtime's own shape for a chain with no feed;
 *     api-contracts/read-v6/runtime.mjs `priced`).
 *   - position-plan-v1: CONSTANTS.chains[99901], the profile's charge currencies, Permit2, Universal Router and wrapped
 *     token, a Nitro chain's L1 data fee source, as the package writes Arbitrum One's row.
 * The runtimes themselves (their checks) are rugged97's, unchanged: vite.config.ts serves these as the two packages'
 * `schema-data.mjs` in a forced test build alone (`elysiumRehearsal`), and tests/support/elysium-day9.mjs loads the same
 * runtimes over them in node for the browser suites' fixture services. The release build and every build that does not
 * force Elysium bundle the repository's packages as they are (tests/elysium-switch.test.mjs).
 *
 * Pure: data in, data out.
 */
import { ELYSIUM_V2_ID } from './elysium-switch.mjs';

const THREE = [4663, 8453, 42161];
/** The V2 chains beside Robinhood Chain: every chain-id enum that names them (Domino's three, or these two alone) takes Elysium. */
const OTHERS = [8453, 42161];
const ZERO = '0x0000000000000000000000000000000000000000';
const lower = (value) => String(value).toLowerCase();
const copy = (value) => JSON.parse(JSON.stringify(value));

/**
 * Every `enum` of chain ids that names Base and Arbitrum One (Domino's three, or those two alone), with 99901 added after
 * them, and every list of exactly one entry per
 * chain (an answer's `chains`: `minItems` and `maxItems` both three) one entry longer (a deep copy; nothing else moves).
 */
function withChain(value, key = '') {
  if (Array.isArray(value)) {
    // Domino's three, or the other networks beside Robinhood Chain alone (chain-tokens names Base and Arbitrum One).
    const chains = value.length > 0 && value.every((item) => typeof item === 'number') && OTHERS.every((id) => value.includes(id));
    return chains && !value.includes(ELYSIUM_V2_ID) ? [...value, ELYSIUM_V2_ID] : value.map((item) => withChain(item));
  }
  if (value !== null && typeof value === 'object') {
    const out = Object.fromEntries(Object.entries(value).map(([name, item]) => [name, withChain(item, name)]));
    if (key === 'chains' && out.type === 'array' && out.minItems === THREE.length && out.maxItems === THREE.length) Object.assign(out, { minItems: THREE.length + 1, maxItems: THREE.length + 1 });
    return out;
  }
  return value;
}

/** The profile's rank-1 charge currency that is not its native one: its stable. */
const stableOf = (profile) => lower(profile.chargeCurrencies.find((currency) => currency.rank === 1 && lower(currency.address) !== ZERO).address);

/** The pool its native currency is priced at, as a pool key (the profile's gasPrice.poolNativeUsd). */
function nativePoolOf(profile) {
  const pool = profile.gasPrice?.poolNativeUsd;
  if (!pool || pool.dex !== 4) throw new Error('the rehearsal needs a profile whose gas is priced at a v4 native pool');
  const [currency0, currency1] = [lower(pool.currency), lower(pool.stable)].sort();
  return { dex: 4, currency0, currency1, fee: pool.fee, tickSpacing: pool.tickSpacing, hooks: ZERO };
}

/** read-v6's schema data (its SCHEMAS, ERRORS and CONSTANTS) as a day-9 version naming 99901 has it. */
export function rehearseReadV6(data, profile) {
  const out = { SCHEMAS: withChain(copy(data.SCHEMAS)), ERRORS: copy(data.ERRORS), CONSTANTS: copy(data.CONSTANTS) };
  if (!out.CONSTANTS.chainIds.includes(ELYSIUM_V2_ID)) out.CONSTANTS.chainIds.push(ELYSIUM_V2_ID);
  out.CONSTANTS.priceProfiles[String(ELYSIUM_V2_ID)] ??= { stable: stableOf(profile), wrapped: lower(profile.wrappedNative.address), nativePool: nativePoolOf(profile) };
  return out;
}

/** position-plan-v1's schema data as a day-9 version naming 99901 has it. */
export function rehearsePlan(data, profile) {
  const out = { SCHEMAS: withChain(copy(data.SCHEMAS)), ERRORS: copy(data.ERRORS), CONSTANTS: copy(data.CONSTANTS) };
  out.CONSTANTS.chains[String(ELYSIUM_V2_ID)] ??= {
    chargeCurrencies: profile.chargeCurrencies.map((currency) => ({ rank: currency.rank, token: lower(currency.address) })),
    l1DataFeeSource: 'nitro_node_interface',
    name: `${profile.slug}-${ELYSIUM_V2_ID}`,
    permit2: lower(profile.permit2),
    stack: profile.stack,
    universalRouter: lower(profile.uniswap.universalRouter.address),
    wrappedNative: lower(profile.wrappedNative.address),
  };
  return out;
}

/** A `schema-data.mjs` module's text for `data`, in the package's own three exports. */
export const moduleSource = (data) => `// Day 9 rehearsed for a forced test build (app/scripts/elysium-rehearsal.mjs); never a release.\nexport const SCHEMAS = ${JSON.stringify(data.SCHEMAS)};\nexport const ERRORS = ${JSON.stringify(data.ERRORS)};\nexport const CONSTANTS = ${JSON.stringify(data.CONSTANTS)};\n`;
