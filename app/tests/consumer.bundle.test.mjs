/**
 * What the builds contain for the previews (#38) and the deposit consumer
 * (#40/#44), read from the built files.
 *
 * The default build (dist, what Pages deploys) excludes the preview/deposit
 * labs and their fixtures. Its opt-in Setup screen now uses the real deposit
 * client, behind the existing session and wallet-review gates. The consumer-test build has the labs in two
 * lazy chunks and what they alone import, found through the Vite manifest,
 * and even there no wallet method, no route to the live deposit service and
 * no second React.
 *
 * The product consumes onboarding-v1 as well (coverage audit G15): Setup's
 * assisted swap quote, inside the lazy Setup screen. So the onboarding client
 * and its runtime ship, but only in that opt-in closure, never in the entry;
 * the lab screens, their synthetic catalogue and fixtures, and the lab's
 * wording still never ship. Changed on purpose (owner, 2026-09-22): New
 * position's deposit amounts (G8) were deleted from Review, and the lazy chunk
 * Review opens in wallet builds (DepositAmounts-*.js) is Create position alone,
 * which signs through the wallet and asks the onboarding service nothing.
 */
import assert from 'node:assert/strict';
import { parse } from '@babel/parser';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { test } from 'node:test';
import { gzipSync } from 'node:zlib';

const APP = resolve(import.meta.dirname, '..');
const DIST = join(APP, 'dist');
const CONSUMER = join(APP, '.consumer-test-dist');

for (const dir of [DIST, CONSUMER]) {
  if (!existsSync(join(dir, 'index.html'))) throw new Error(`${dir} is missing. Run npm run build and npm run build:consumer-test first.`);
}

const textFiles = (dir) =>
  readdirSync(dir, { recursive: true })
    .map(String)
    .filter((file) => /\.(js|css|html)$/.test(file) && statSync(join(dir, file)).isFile())
    .map((file) => ({ file: file.replaceAll('\\', '/'), text: readFileSync(join(dir, file), 'utf8') }));

// Shared production deposit code is admitted only in Setup's exclusive static
// closure. These strings do not grant the old preview/lab code an exception.
const SETUP_DEPOSIT_MARKERS = [
  '/api/deposit/v1',
  'X-Domino-Deposit-Contract',
  'validateWalletStep',
  'Wallet sending isn',
  'deposit_owner_busy',
  'domino-deposit-last-operation-v1',
];
// The onboarding client, its runtime and the page's preview budget: admitted in the product consumer's opt-in
// closure (Setup with its swap quote), never in the entry's and never in Create position's.
const ONBOARDING_MARKERS = [
  '/api/onboarding/v1',
  'X-Domino-Onboarding-Contract',
  'swap-preview',
  'domino-preview-budget-v1',
];
// Error codes both packages define ('preview_expired' is a deposit-v1 code and an onboarding-v1 one): the deposit
// client's confinement still holds for them. Admitted in Setup's exclusive chunks, never in a chunk Setup shares
// with the other private screens.
const SHARED_CODE_MARKERS = ['preview_expired'];
// The labs, their synthetic catalogue and fixtures, and the lab's own wording: never in the build that deploys.
const CONSUMER_MARKERS = [
  'position-preview.native',
  'DISABLED_WALLET_HANDOFF',
  '25431634fd7de725',
  'Synthetic fixture',
  'Synthetic test pool',
  'fixture-csrf-not-a-session',
  'Live preview (invited testers)',
  '__dominoDepositProbe',
  'live-preview',
  'Preview only',
  'enabled on this deployment',
  'part of this build',
  'beta access',
];

function productionClosures() {
  const assets = join(DIST, 'assets');
  const scripts = readdirSync(assets).filter((file) => file.endsWith('.js')).sort();
  const html = readFileSync(join(DIST, 'index.html'), 'utf8');
  const entry = scripts.filter((file) => html.includes(file));
  const setup = scripts.filter((file) => file.startsWith('Setup-'));
  const amounts = scripts.filter((file) => file.startsWith('DepositAmounts-'));
  assert.equal(entry.length, 1);
  assert.equal(setup.length, 1);
  assert.equal(amounts.length, 1, 'Create position is one lazy chunk');
  const trees = new Map(scripts.map((file) => [file, parse(readFileSync(join(assets, file), 'utf8'), { sourceType: 'module' })]));
  const reach = (roots) => {
    const seen = new Set();
    const walk = (file) => {
      if (seen.has(file)) return;
      assert.ok(trees.has(file), `missing local module ${file}`);
      seen.add(file);
      // Deliberately do not follow import(): opening another lazy screen is a
      // separate user action, not part of the entry's static dependency graph.
      for (const node of trees.get(file).program.body) {
        if (!['ImportDeclaration', 'ExportNamedDeclaration', 'ExportAllDeclaration'].includes(node.type) || !node.source) continue;
        assert.match(node.source.value, /^\.\/[\w.-]+\.js$/);
        walk(basename(node.source.value));
      }
    };
    roots.forEach(walk);
    return seen;
  };
  // Changed on purpose (owner, 2026-09-24): the Positions list, a position's page and their two wallet chunks are lazy roots too.
  // 2026-09-24 (P6, DESIGN-V2 §18, R-12): the fees replay worker (src/lib/fees/feesReplay.worker.ts), a classic worker
  // file that only src/lib/fees/spawn.ts creates, is an admitted root of its own, within its 16,000 B gzip ceiling.
  const workers = scripts.filter((file) => /^feesReplay\.worker-/.test(file));
  for (const file of workers) assert.ok(gzipSync(readFileSync(join(assets, file)), { level: 9 }).length <= 16_000, `${file} is over its 16,000 B gzip ceiling`);
  // 2026-09-25: the chain code the page runs (src/lib/chain/chainCode.ts: the routes' scan and relay reads, the RPC runtime,
  // Keccak), one chunk loaded by dynamic import on a page's first read of the chain, is an admitted root of its own
  // (tests/session.bundle.test.mjs measures it, with its own ceiling).
  const otherRoots = scripts.filter((file) => /^(index|WalletSessionIsland|PoolExplorer|TokenPicker|Sequence|Execution|Performance|DepositAmounts|OwnedPositions|PositionDetail|PositionActions|HeldDeposits|feesReplay\.worker|chainCode)-/.test(file));
  const shared = reach([...entry, ...otherRoots]);
  const setupClosure = reach(setup);
  assert.ok(!shared.has(setup[0]), 'Setup must not be loaded statically by the entry or another screen');
  const importsSetup = (node) => {
    if (!node || typeof node !== 'object') return false;
    if (node.type === 'CallExpression' && node.callee?.type === 'Import' && node.arguments[0]?.value === `./${setup[0]}`) return true;
    return Object.values(node).some((child) => Array.isArray(child) ? child.some(importsSetup) : importsSetup(child));
  };
  assert.ok(importsSetup(trees.get(entry[0])), 'the entry opens Setup through a dynamic import');
  assert.deepEqual([...new Set([...shared, ...setupClosure])].sort(), scripts, 'every production module belongs to an admitted screen closure');
  const entryClosure = reach(entry);
  const amountsClosure = reach(amounts);
  assert.ok(!entryClosure.has(amounts[0]) && !entryClosure.has(setup[0]), 'neither Create position nor Setup is loaded statically by the entry');
  const opens = (node, file) => {
    if (!node || typeof node !== 'object') return false;
    if (node.type === 'CallExpression' && node.callee?.type === 'Import' && node.arguments[0]?.value === `./${file}`) return true;
    return Object.values(node).some((child) => (Array.isArray(child) ? child.some((item) => opens(item, file)) : opens(child, file)));
  };
  assert.ok(opens(trees.get(entry[0]), amounts[0]), 'the entry opens Create position through a dynamic import');
  const onboardingAdmitted = new Set([...setupClosure].filter((file) => !entryClosure.has(file)));
  const setupOnly = new Set([...setupClosure].filter((file) => !shared.has(file)));
  const sharedCodeAdmitted = setupOnly;
  return { setupOnly, setupClosure, amountsClosure, onboardingAdmitted, sharedCodeAdmitted };
}

test('production excludes preview/deposit labs and confines the live deposit client to opt-in Setup', () => {
  const files = textFiles(DIST);
  const { setupOnly, setupClosure, amountsClosure, onboardingAdmitted, sharedCodeAdmitted } = productionClosures();
  for (const { file, text } of files) {
    for (const marker of CONSUMER_MARKERS) assert.ok(!text.includes(marker), `dist/${file} contains ${marker}`);
    for (const marker of SETUP_DEPOSIT_MARKERS) {
      if (text.includes(marker)) assert.ok(file.startsWith('assets/') && setupOnly.has(basename(file)), `dist/${file} contains ${marker} outside opt-in Setup`);
    }
    for (const marker of ONBOARDING_MARKERS) {
      if (text.includes(marker)) assert.ok(file.startsWith('assets/') && onboardingAdmitted.has(basename(file)), `dist/${file} contains ${marker} outside the opt-in onboarding consumer`);
    }
    for (const marker of SHARED_CODE_MARKERS) {
      if (text.includes(marker)) assert.ok(file.startsWith('assets/') && sharedCodeAdmitted.has(basename(file)), `dist/${file} contains ${marker} outside Setup's own chunks`);
    }
  }
  assert.ok(files.some(({ text }) => SHARED_CODE_MARKERS.every((marker) => text.includes(marker))), 'the shared error codes are still in the build, so the confinement above is checked against something');
  // Create position's chunk carries the setup client it signs through, its assisted swap and its way to the new position's
  // page on Positions ('#/positions/<id>', a position's own page since 2026-09-24),
  // and nothing of the onboarding service: Review asks no preview any more.
  const amountsText = [...amountsClosure].map((file) => readFileSync(join(DIST, 'assets', file), 'utf8')).join('\n');
  for (const marker of ['quoteSwap', 'swap_output_insufficient', 'getSlot0', '#/positions/']) {
    assert.ok(amountsText.includes(marker), `the production Create position closure is missing ${marker}`);
  }
  for (const marker of [...ONBOARDING_MARKERS, 'position-preview']) assert.ok(!amountsText.includes(marker), `the production Create position closure carries ${marker}`);
  const assets = readdirSync(join(DIST, 'assets'));
  assert.deepEqual(assets.filter((file) => /^(LivePreview|Deposits|OperationPanel|PreviewPanels)/.test(file)), []);
  const setupText = [...setupClosure].map((file) => readFileSync(join(DIST, 'assets', file), 'utf8')).join('\n');
  // Confirm that the real transport and existing review UI survived bundling.
  // Behavioral request/session/pre-sign guards remain covered by the deposit
  // client/flow tests; presence of these strings alone cannot prove authority.
  for (const marker of ['/api/deposit/v1', 'X-Domino-CSRF', 'summaryAcknowledged', 'Review and send in wallet', 'wallet_review_required', '/api/onboarding/v1/', 'swap-preview']) {
    assert.ok(setupText.includes(marker), `the production Setup closure is missing ${marker}`);
  }
});

test('the default stylesheet loads nothing from elsewhere (BUN-2)', (t) => {
  const css = readdirSync(join(DIST, 'assets')).filter((file) => file.endsWith('.css'));
  assert.equal(css.length, 1);
  const text = readFileSync(join(DIST, 'assets', css[0]), 'utf8');
  assert.deepEqual([...text.matchAll(/url\(\s*['"]?(?!data:)([^'")]+)/g)].map((match) => match[1]), []);
  assert.ok(!/@import/.test(text));
  t.diagnostic(`dist/assets/${css[0]}: ${Buffer.byteLength(text)} bytes`);
});

/** The consumer chunks: the two lazy screens and every chunk only they reach. */
function consumerChunks() {
  const manifest = JSON.parse(readFileSync(join(CONSUMER, '.vite', 'manifest.json'), 'utf8'));
  const roots = ['src/screens/LivePreview.tsx', 'src/screens/Deposits.tsx'];
  for (const root of roots) assert.ok(manifest[root]?.isDynamicEntry, `${root} is a lazy chunk`);
  const reach = (from) => {
    const seen = new Set();
    const walk = (key) => {
      if (seen.has(key)) return;
      seen.add(key);
      for (const next of manifest[key]?.imports ?? []) walk(next);
    };
    walk(from);
    return seen;
  };
  // What the entry and every other lazy entry (the wallet island) reach is
  // shared, not the consumer's: B2's wallet session chunk is one of those.
  const shared = new Set();
  for (const key of Object.keys(manifest)) {
    if (manifest[key].isEntry || (manifest[key].isDynamicEntry && !roots.includes(key))) for (const reached of reach(key)) shared.add(reached);
  }
  const mine = new Set();
  for (const root of roots) for (const key of reach(root)) if (!shared.has(key)) mine.add(key);
  return { manifest, files: [...mine].map((key) => manifest[key].file) };
}

test('the consumer-test build loads the previews and the deposit lab lazily, in their own chunks', (t) => {
  const { manifest, files } = consumerChunks();
  const entry = Object.values(manifest).find((chunk) => chunk.isEntry);
  const entryText = readFileSync(join(CONSUMER, entry.file), 'utf8');
  for (const marker of ['X-Domino-Onboarding-Contract', 'validateWalletStep', 'Synthetic fixture']) {
    assert.ok(!entryText.includes(marker), `the entry chunk must not carry ${marker}`);
  }
  const all = files.map((file) => readFileSync(join(CONSUMER, file), 'utf8')).join('\n');
  // The onboarding client is no longer the lab's alone: New position's deposit amounts (another lazy entry) and
  // Setup share it, so it sits in a lazy chunk shared with them. It is still reached from the preview screen, and
  // the entry chunk carries none of it (checked above).
  const reached = (from) => {
    const seen = new Set();
    const walk = (key) => {
      if (seen.has(key)) return;
      seen.add(key);
      for (const next of manifest[key]?.imports ?? []) walk(next);
    };
    walk(from);
    return [...seen].map((key) => manifest[key].file);
  };
  const previewText = reached('src/screens/LivePreview.tsx').map((file) => readFileSync(join(CONSUMER, file), 'utf8')).join('\n');
  assert.ok(previewText.includes('/api/onboarding/v1/'));
  assert.ok(all.includes('X-Domino-Deposit-Contract') || all.includes('1.1.0-rc.4'));
  for (const file of files) t.diagnostic(`${file}: ${statSync(join(CONSUMER, file)).size} bytes, ${gzipSync(readFileSync(join(CONSUMER, file)), { level: 9 }).length} gzip`);
});

test('the consumer chunks hold no wallet method, no signing API and no route to the live deposit service (BUN-3)', () => {
  const { files } = consumerChunks();
  const methods = /['"`](eth_sendTransaction|eth_signTransaction|eth_sendRawTransaction|eth_sign|eth_signTypedData(_v\d)?|wallet_sendCalls|wallet_addEthereumChain|wallet_watchAsset|wallet_switchEthereumChain)['"`]/;
  for (const file of files) {
    const text = readFileSync(join(CONSUMER, file), 'utf8');
    assert.ok(!methods.test(text), `${file} names a wallet method`);
    assert.ok(!text.includes('/api/deposit/v1'), `${file} can reach the deposit service`);
    assert.ok(!/writeContract|sendTransaction|signTypedData/.test(text), `${file} names a signing API`);
  }
  // viem's own strings in the wallet chunk are not scanned (B2's bundle test
  // covers that chunk); the browser tests record every wallet method called.
});

test('the consumer-test build has exactly one React', () => {
  const copies = textFiles(CONSUMER).filter(({ text }) => text.includes('react.transitional.element')).map(({ file }) => file);
  assert.equal(copies.length, 1, copies.join(', '));
});
