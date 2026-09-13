/**
 * What the builds contain for the previews (#38) and the deposit consumer
 * (#40/#44), read from the built files.
 *
 * The default build (dist, what Pages deploys) has none of it: no chunk, no
 * contract string, no fixture, no copy. The consumer-test build has it in two
 * lazy chunks and what they alone import, found through the Vite manifest,
 * and even there no wallet method, no route to the live deposit service and
 * no second React.
 */
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
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

const CONSUMER_MARKERS = [
  '/api/onboarding/v1',
  '/api/deposit/v1',
  'X-Domino-Onboarding-Contract',
  'X-Domino-Deposit-Contract',
  'swap-preview',
  'position-preview.native',
  'validateWalletStep',
  'DISABLED_WALLET_HANDOFF',
  'Wallet sending isn',
  'preview_expired',
  'deposit_owner_busy',
  '25431634fd7de725',
  'Synthetic fixture',
  'fixture-csrf-not-a-session',
  'domino-preview-budget-v1',
  'domino-deposit-last-operation-v1',
  'Live preview (invited testers)',
  '__dominoDepositProbe',
  'live-preview',
];

test('the default build carries nothing of the previews or the deposit consumer', () => {
  const files = textFiles(DIST);
  for (const { file, text } of files) {
    for (const marker of CONSUMER_MARKERS) assert.ok(!text.includes(marker), `dist/${file} contains ${marker}`);
  }
  const assets = readdirSync(join(DIST, 'assets'));
  assert.deepEqual(assets.filter((file) => /^(LivePreview|Deposits|OperationPanel|PreviewPanels)/.test(file)), []);
  // When this case was written the deployable build was a single script. It is
  // four now, each one reviewed work already in main: the entry, its vendor
  // half, the wallet session island (#111) and the dialog helper the read
  // screens share (#112). What the case is about is that no preview or deposit
  // chunk is among them, so it names what is allowed instead of counting to one.
  const ALLOWED = /^(index|WalletSessionIsland|useDialog|appSourceBridge)-/;
  assert.deepEqual(
    assets.filter((file) => file.endsWith('.js')).filter((file) => !ALLOWED.test(file)),
    [],
    'no chunk beyond the reviewed ones reaches the build that deploys',
  );
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
  assert.ok(all.includes('/api/onboarding/v1/'));
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
