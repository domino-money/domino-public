/**
 * A V2 chain's identity on screen (added 2026-11-06, Elysium readiness): its name, its explorer and its mark, for every
 * chain of the app's one list (config/chainIdentity.ts V2_CHAIN_IDS). Today that is Robinhood Chain, Base and Arbitrum
 * One, exactly as before. Elysium is a slot: its name, its mark's file and its funding row place are prepared
 * (src/v2/elysium.ts) and attached to no chain id; these tests fail on the day its id joins the list until each table
 * names it (docs/ELYSIUM_DAY9.md), so it can never appear with another network's mark or as "another network".
 */
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { ELYSIUM_FORCED, withFunds } from './support/elysium-live.mjs';

const require = createRequire(import.meta.url);
const BUILD = '../../.test-build/app/src/';
const chains = require(`${BUILD}v2/chains.js`);
const identity = require(`${BUILD}config/chainIdentity.js`);
const { ELYSIUM } = require(`${BUILD}v2/elysium.js`);
const identityWords = require(`${BUILD}lib/elysiumIdentity.js`);
const { NETWORK_NAMES, networkName } = require(`${BUILD}lib/networkName.js`);
const explorers = require(`${BUILD}v2/explorers.js`);
const marks = require(`${BUILD}lib/chainMarks.js`);
const APP = fileURLToPath(new URL('../../', import.meta.url));
const read = (path) => readFileSync(join(APP, path), 'utf8');
const HASH = `0x${'ab'.repeat(32)}`;
const FIRST_THREE = [4663, 8453, 42161];

test('every V2 chain has one name, the same on every screen', () => {
  assert.deepEqual([...identity.V2_CHAIN_IDS], chains.V2_CHAINS.map((chain) => chain.chainId));
  for (const chain of chains.V2_CHAINS) {
    assert.equal(NETWORK_NAMES[chain.chainId], chain.name, `${chain.chainId}: lib/networkName.ts names it as its screens do`);
    assert.equal(chains.V2_CHAIN_FACTS[chain.chainId].name, chain.name);
  }
  assert.deepEqual(chains.V2_CHAINS.map((chain) => networkName(chain.chainId)), ['Robinhood Chain', 'Base', 'Arbitrum One']);
  // Elysium's words are ready and named nowhere: no table holds a row for it until its id exists.
  assert.equal(ELYSIUM.name, 'Elysium');
  assert.equal(Object.values(NETWORK_NAMES).includes(ELYSIUM.name), false);
});

test('every V2 chain has an explorer row; a chain without an explorer draws no link', () => {
  assert.deepEqual(chains.V2_CHAINS.map((chain) => explorers.v2TxUrl(chain.chainId, HASH)), [
    `https://robinhoodchain.blockscout.com/tx/${HASH}`, `https://basescan.org/tx/${HASH}`, `https://arbiscan.io/tx/${HASH}`,
  ]);
  assert.deepEqual(chains.V2_CHAINS.map((chain) => explorers.v2ContractUrl(chain.chainId, `0x${'cd'.repeat(20)}`)), [
    `https://robin.etherscan.io/address/0x${'cd'.repeat(20)}`, `https://basescan.org/address/0x${'cd'.repeat(20)}`, `https://arbiscan.io/address/0x${'cd'.repeat(20)}`,
  ]);
  assert.equal(explorers.v2TxUrl(99801, HASH), null);
  assert.equal(explorers.v2TxUrl(8453, '0x12'), null);
  // The tables have one row per chain of the list, a host or null (the type asks for every row; null is "none yet").
  const source = read('src/v2/explorers.ts');
  assert.match(source, /const TX: Readonly<Record<V2ChainId, string \| null>>/);
  assert.match(source, /const CONTRACT: Readonly<Record<V2ChainId, string \| null>>/);
  assert.match(source, /return host && /);
});

test('marks: the three keep the stylesheets\' drawings; a chain past them must be drawn from its own file', () => {
  assert.deepEqual(marks.CHAIN_MARK_FILES, {});
  for (const chainId of [...FIRST_THREE, 1, 10, '8453', 'unavailable', null, undefined]) assert.deepEqual(marks.chainMarkProps(chainId), {});
  // The day-9 guard: a V2 chain the stylesheets do not draw (any id past the first three) has its file here, or some
  // places would show Robinhood Chain's or Base's mark for it (their defaults in styles/v4-markets.css).
  for (const chainId of identity.V2_CHAIN_IDS.filter((id) => !FIRST_THREE.includes(id))) {
    assert.equal(typeof marks.CHAIN_MARK_FILES[chainId], 'string', `${chainId}: lib/chainMarks.ts CHAIN_MARK_FILES`);
  }
  // With a file, the element carries it as --dm-chain-mark; a path that is not a site file is refused.
  // Changed on purpose 2026-11-07: Elysium's mark is a PNG (the owner's file); a PNG path is a site file as an SVG one is.
  assert.deepEqual(marks.markPropsFrom({ 99801: ELYSIUM.mark }, 99801), { 'data-chain-mark': '', style: { '--dm-chain-mark': 'url("/chains/elysium.png")' } });
  assert.deepEqual(marks.markPropsFrom({ 99801: ELYSIUM.mark }, '99801'), { 'data-chain-mark': '', style: { '--dm-chain-mark': 'url("/chains/elysium.png")' } });
  assert.deepEqual(marks.markPropsFrom({ 99801: '/chains/x.svg' }, 99801), { 'data-chain-mark': '', style: { '--dm-chain-mark': 'url("/chains/x.svg")' } });
  assert.deepEqual(marks.markPropsFrom({ 99801: 'https://example.com/x.svg' }, 99801), {});
  assert.deepEqual(marks.markPropsFrom({ 99801: '/chains/x.gif' }, 99801), {});
  assert.deepEqual(marks.markPropsFrom({ 99801: '/chains/x.svg") , url("/y.svg' }, 99801), {});
});

test('Elysium\'s mark is one path, the owner\'s square PNG, that no chain the app serves points to yet', () => {
  assert.equal(ELYSIUM.mark, '/chains/elysium.png');
  // The official file is the owner's (public/chains/elysium.png). Changed on purpose 2026-11-06 (the review): this test
  // said the file must be absent, so it would have failed the day the owner adds it, with no chain pointing to it.
  // Changed on purpose 2026-11-07: the owner supplied Kinetiq's mark as a PNG (128 x 128, white inside the circle,
  // transparent outside), and it is in the repository. Its arrival changes nothing on screen by itself; it must be a
  // square PNG image (the signature, then the IHDR chunk with equal width and height), and the only file under
  // public/chains: no SVG stand-in beside it.
  const file = join(APP, 'public', 'chains', 'elysium.png');
  assert.ok(existsSync(file), 'public/chains/elysium.png is in the repository');
  const bytes = readFileSync(file);
  assert.deepEqual([...bytes.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 'the PNG signature');
  assert.deepEqual([bytes.readUInt32BE(8), bytes.toString('latin1', 12, 16)], [13, 'IHDR'], 'the IHDR chunk first');
  assert.equal(bytes.readUInt32BE(16), bytes.readUInt32BE(20), 'square');
  assert.equal(bytes.readUInt32BE(16), 128, '128 pixels a side, as the owner\'s file is');
  assert.deepEqual(readdirSync(join(APP, 'public', 'chains')), ['elysium.png']);
  assert.equal(Object.values(marks.CHAIN_MARK_FILES).includes(ELYSIUM.mark), false);
  assert.equal(identityWords.ELYSIUM_FUNDS_FROM, false, 'nor does Home\'s "Bring funds from" row, until funds can come from it');
  // The path is written once, in src/lib/elysiumIdentity.ts; Home's network mark and Elysium's record read it from there.
  const files = (dir) => readdirSync(join(APP, dir), { withFileTypes: true }).flatMap((entry) => entry.isDirectory() ? files(join(dir, entry.name)) : [join(dir, entry.name).replaceAll('\\', '/')]);
  const naming = files('src').filter((path) => /\.(?:ts|tsx|css)$/.test(path) && read(path).includes('chains/elysium.png'));
  assert.deepEqual(naming, ['src/lib/elysiumIdentity.ts']);
  assert.deepEqual(files('src').filter((path) => /\.(?:ts|tsx|css)$/.test(path) && read(path).includes('chains/elysium.svg')), [], 'the old SVG path is named nowhere');
  const home = read('src/components/home/HomeCapabilities.tsx');
  // Changed on purpose 2026-11-07 (Elysium's screens): and ELYSIUM_LIVE, for Home's "Open positions on" row (POSITION_ROW).
  // Changed on purpose 2026-11-07 (Elysium's pre-launch): and ELYSIUM_PRELAUNCH, for the same row before Elysium is live.
  assert.match(home, /import \{ ELYSIUM_FUNDS_FROM, ELYSIUM_LIVE, ELYSIUM_MARK, ELYSIUM_NAME, ELYSIUM_PRELAUNCH \} from '\.\.\/\.\.\/lib\/elysiumIdentity'/);
  assert.match(home, /export const POSITION_ROW: readonly MarkedNetwork\[\] = Object\.freeze\(ELYSIUM_LIVE \|\| ELYSIUM_PRELAUNCH \? \['Robinhood Chain', 'Base', 'Arbitrum One', ELYSIUM_NAME\] : \[\]\)/, 'the row where Elysium is live or in pre-launch, empty only where it is off');
  assert.match(home, /if \(network === ELYSIUM_NAME\) \{/);
  assert.match(home, /<img src=\{ELYSIUM_MARK\} alt="" width=\{20\} height=\{20\} draggable=\{false\} onError=/, 'a missing file draws nothing in its place');
  assert.deepEqual([ELYSIUM.name, ELYSIUM.mark, ELYSIUM.fundsFrom], [identityWords.ELYSIUM_NAME, identityWords.ELYSIUM_MARK, identityWords.ELYSIUM_FUNDS_FROM]);
});

test('Home\'s "Bring funds from" row: the same five networks until funds can come from Elysium', () => {
  assert.equal(ELYSIUM.fundsFrom, false);
  const home = read('src/components/home/HomeCapabilities.tsx');
  assert.match(home, /export const FUNDING_NETWORKS = \['Ethereum', 'Base', 'Arbitrum One', 'OP Mainnet', 'Robinhood Chain'\] as const/);
  assert.match(home, /export const FUNDING_ROW: readonly MarkedNetwork\[\] = Object\.freeze\(ELYSIUM_FUNDS_FROM \? \[\.\.\.FUNDING_NETWORKS, ELYSIUM_NAME\] : \[\.\.\.FUNDING_NETWORKS\]\)/);
  assert.match(read('src/screens/Landing.tsx'), /FUNDING_ROW\.map\(network =>/);
  // Elysium's profile names no bridge, so Bring funds stays off there (the synthetic profile's too).
  const fixture = JSON.parse(read('tests/fixtures/v2-chains/elysium-99801.json'));
  assert.deepEqual(fixture.bridge.providers, []);
});

test('each place that draws a network\'s mark takes the file slot, after its own chains\' rules', () => {
  const renderers = {
    'src/components/read/screens/TokenSearch.tsx': 2,
    'src/components/read/screens/PoolPicker.tsx': 1,
    'src/components/read/screens/NetworkTokenExplorer.tsx': 1,
    'src/v2in/lists/parts.tsx': 1,
    'src/v2in/lists/receiptParts.tsx': 3,
    // Added 2026-11-06 (the merge of rep/wal, and the Elysium surface): the Wallet card's network rows, beside a token
    // (styles/v4-positions.css, with the Positions collection's marker).
    'src/components/portfolio/PortfolioTokens.tsx': 1,
  };
  for (const [path, count] of Object.entries(renderers)) assert.equal(read(path).match(/\{\.\.\.chainMarkProps\(/g)?.length, count, path);
  const markets = read('src/styles/v4-markets.css'), positions = read('src/styles/v4-positions.css');
  for (const [css, chipRule, markRule] of [
    [markets, '.dm-v3-token-group[data-token-group="42161"]::before', '.dm-v3-market-search .dm-v3-token-group[data-chain-mark]::before { background-image: var(--dm-chain-mark); }'],
    [markets, '.dm-flow-hit .dm-chip[data-chain-chip="42161"]::before', '.dm-v3-market-search .dm-flow-hit .dm-chip[data-chain-mark]::before { background-image: var(--dm-chain-mark); }'],
    [markets, '.dm-mkt-tags > [data-chain-chip="42161"]::before', '[data-markets] .dm-mkt-tags > [data-chain-mark]::before { background-image: var(--dm-chain-mark); }'],
    [markets, '.dm-flow-pool-net[data-chain-chip="42161"]::before', '[data-network-token-view] .dm-flow-pool-chips > .dm-flow-pool-net[data-chain-mark]::before { background-image: var(--dm-chain-mark); }'],
    // The Positions collection's network and the Wallet card's network rows share one rule (rep/wal's, merged 2026-11-06),
    // held as the stylesheet has it.
    [positions, '.dm-acct-token-network)[data-v2-chain="10"]::before', '.dm-positions-page :is(.dm-own-collection .dm-collection-network, .dm-acct-token-network)[data-chain-mark]::before { background-image: var(--dm-chain-mark); }'],
    [positions, '.dm-activity-chain[data-activity-chain="10"]::before', '.dm-activity-chain[data-chain-mark]::before { background-image: var(--dm-chain-mark); }'],
    [positions, 'li[data-v2-receipt-chain="42161"]', 'li[data-chain-mark] > .dm-rcpt-operation > .dm-rcpt-detail > .dm-rcpt-tech > [data-receipt-field="network"] > dd::before {'],
  ]) {
    assert.ok(css.includes(markRule), markRule);
    assert.ok(css.indexOf(markRule) > css.indexOf(chipRule), `${markRule}: after the chains' own rules, so it wins`);
  }
  // A token page with no name for its network yet says what lib/networkName.ts says, never another network's name.
  assert.doesNotMatch(read('src/components/read/screens/NetworkTokenExplorer.tsx'), /chainId === 8453 \? 'Base' : 'Arbitrum One'/);
});

/**
 * The compiled modules loaded again with the build's Elysium defines set as `flags` (globalThis, which a compile outside
 * Vite reads as a Vite define would be read), then the cache restored: what a build with Elysium live holds.
 */
function loadWith(flags, load) {
  const ours = (key) => key.includes('.test-build');
  const saved = Object.entries(require.cache).filter(([key]) => ours(key));
  for (const [key] of saved) delete require.cache[key];
  Object.assign(globalThis, flags);
  try {
    return load();
  } finally {
    for (const name of Object.keys(flags)) delete globalThis[name];
    for (const key of Object.keys(require.cache)) if (ours(key)) delete require.cache[key];
    for (const [key, value] of saved) require.cache[key] = value;
  }
}
// Changed on purpose 2026-11-07 (Elysium as a fourth V2 chain): a live build carries Elysium's profile, which the V2
// chain list now serves (./support/elysium-live.mjs, what a forced test build carries).
const LIVE = ELYSIUM_FORCED;
const LIVE_FUNDS = withFunds;

// Added 2026-11-06 (the Elysium surface): the switch (lib/elysiumIdentity.ts ELYSIUM_LIVE, scripts/elysium-switch.mjs).
test('the switch off (today): Elysium is in no table, by either id', () => {
  assert.equal(identityWords.ELYSIUM_LIVE, false);
  assert.equal(identityWords.ELYSIUM_V2_ID, 99901);
  for (const id of [99901, 99801]) {
    assert.equal(Object.hasOwn(NETWORK_NAMES, id), false);
    assert.equal(networkName(id), 'another network');
    assert.deepEqual(marks.chainMarkProps(id), {});
  }
});

test('the switch on: Elysium is named "Elysium" and drawn from its own file by its mainnet id, in every table, and funds come from it only with the second switch', () => {
  const on = loadWith(LIVE, () => ({
    words: require(`${BUILD}lib/elysiumIdentity.js`),
    names: require(`${BUILD}lib/networkName.js`),
    marks: require(`${BUILD}lib/chainMarks.js`),
    present: require(`${BUILD}v2/crosschain/present.js`),
    v6: require(`${BUILD}v2/read/v6.js`),
    elysium: require(`${BUILD}v2/elysium.js`).ELYSIUM,
  }));
  assert.equal(on.words.ELYSIUM_LIVE, true);
  assert.equal(on.words.ELYSIUM_FUNDS_FROM, false, 'no bridge serves it: the second switch is off');
  assert.equal(on.names.NETWORK_NAMES[99901], 'Elysium');
  assert.equal(on.names.networkName(99901), 'Elysium');
  assert.equal(on.names.networkName(99801), 'another network', 'the old testnet is not Elysium');
  for (const id of [4663, 8453, 42161, 1, 10]) assert.equal(on.names.NETWORK_NAMES[id], NETWORK_NAMES[id], `${id} keeps its name`);
  assert.deepEqual(on.marks.CHAIN_MARK_FILES, { 99901: '/chains/elysium.png' });
  for (const id of [99901, '99901']) assert.deepEqual(on.marks.chainMarkProps(id), { 'data-chain-mark': '', style: { '--dm-chain-mark': 'url("/chains/elysium.png")' } });
  for (const id of [...FIRST_THREE, 99801, 1, 10, 'unavailable', null]) assert.deepEqual(on.marks.chainMarkProps(id), {}, `${id} keeps the stylesheets' drawing`);
  // The bring card names it as the app does, never as a listing would; read-v6's coverage sentence names it too.
  assert.equal(on.present.networkName(99901, 'Elysium Mainnet'), 'Elysium');
  assert.equal(on.v6.coverageNote([{ chainId: 8453, status: 'current' }, { chainId: 99901, status: 'unavailable' }]), 'Showing Base. Elysium is unavailable right now.');
  assert.equal(on.elysium.fundsFrom, false);
  // Funds from it: only with Elysium live and crosschain-v1 pinning a bridge there (the second define), never the second alone.
  assert.equal(loadWith(LIVE_FUNDS, () => require(`${BUILD}lib/elysiumIdentity.js`).ELYSIUM_FUNDS_FROM), true);
  assert.equal(loadWith({ __DOMINO_ELYSIUM_FUNDS_FROM__: true }, () => require(`${BUILD}lib/elysiumIdentity.js`).ELYSIUM_FUNDS_FROM), false);
  // And the cache holds today's modules again.
  assert.equal(require(`${BUILD}lib/networkName.js`).networkName(99901), 'another network');
});

test('Home with the switch: the "Bring funds from" row and the funding scene take Elysium only once funds can come from it, Robinhood Chain staying at the scene\'s foot', () => {
  const home = read('src/components/home/HomeCapabilities.tsx');
  assert.match(home, /export const FUNDING_PLACES: readonly MarkedNetwork\[\] = Object\.freeze\(ELYSIUM_FUNDS_FROM \? \[\.\.\.FUNDING_NETWORKS\.slice\(0, 4\), ELYSIUM_NAME, FUNDING_NETWORKS\[4\]\] : \[\.\.\.FUNDING_NETWORKS\]\)/);
  assert.match(home, /const SOURCES: readonly number\[\] = FUNDING_PLACES\.map\(\(_, index\) => 42 \+ 44 \* index\)/, 'one more route in the same rhythm');
  assert.match(home, /const source = mode === 'local' \? HOME_PLACE : picked/);
  assert.match(home, /data-places=\{FUNDING_PLACES\.length > 5 \? FUNDING_PLACES\.length : undefined\}/, 'five places today: the markup is what it was');
  assert.ok(read('src/styles/v4-home.css').includes('.dm-home .dm-funding-networks:where([data-places="6"]) { height: 16rem; }'));
  // The scene's design: six 36 px chips with 8 px gaps fill 256 of its 300 design px from 24 down, the routes 44 apart.
  assert.equal(24 + 6 * 36 + 5 * 8, 280);
  assert.ok(42 + 44 * 5 + 18 <= 300);
});
