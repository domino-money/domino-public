/**
 * What each build contains, read from the built files.
 *
 * The default build is what Pages deploys, and it carries wallet sign-in: the
 * feature is part of the site, in one lazy chunk beside the entry, so a page
 * that never opens it never downloads it. What the deployed build may never
 * carry is the probes the browser tests drive; those belong to the wallet-test
 * build alone. Neither build may carry a connector SDK, a relay or any public
 * RPC endpoint: every wallet call goes through the wallet's own provider, and
 * the page may reach nothing but its own origin.
 */
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { gzipSync } from 'node:zlib';

const APP = resolve(import.meta.dirname, '..');
const DIST = join(APP, 'dist');
const WALLET = join(APP, '.wallet-test-dist');

for (const dir of [DIST, WALLET]) {
  if (!existsSync(join(dir, 'index.html'))) throw new Error(`${dir} is missing. Run npm run build and npm run build:wallet-test first.`);
}

const assets = (dir) => readdirSync(join(dir, 'assets')).sort();
const scripts = (dir) => assets(dir).filter((file) => file.endsWith('.js'));
const textFiles = (dir) =>
  readdirSync(dir, { recursive: true })
    .map(String)
    .filter((file) => /\.(js|css|html)$/.test(file) && statSync(join(dir, file)).isFile())
    .map((file) => ({ file, text: readFileSync(join(dir, file), 'utf8') }));
const gzip = (file) => gzipSync(readFileSync(file), { level: 9 }).length;
/**
 * The one entry script and the one wallet chunk of a build.
 *
 * The entry is whichever script index.html loads, not whichever is named
 * index-*: a lazy chunk gets that name too when the module opening it is
 * called index.ts, which is how the read screens' chunk is named.
 */
function shape(dir) {
  const js = scripts(dir);
  const html = readFileSync(join(dir, 'index.html'), 'utf8');
  const entry = js.filter((file) => html.includes(file));
  const island = js.filter((file) => file.startsWith('WalletSessionIsland-'));
  return { js, entry, island };
}

test('the deployed build carries wallet sign-in as its own chunk, beside one entry and one stylesheet', () => {
  const { js, entry, island } = shape(DIST);
  assert.equal(entry.length, 1, js.join(', '));
  assert.equal(island.length, 1, js.join(', '));
  // The read screens and the shared read source are lazy chunks of their own,
  // so a visitor who opens neither the figures nor the position lookup never
  // downloads them. What must not appear is a second entry or a second island.
  assert.equal(assets(DIST).filter((file) => file.endsWith('.css')).length, 1, assets(DIST).join(', '));
});

test('the feature is lazy: the deployed entry holds no wallet code, and the chunk holds the session client', (t) => {
  const { entry, island } = shape(DIST);
  const entryText = readFileSync(join(DIST, 'assets', entry[0]), 'utf8');
  for (const needle of ['personal_sign', 'wallet_switchEthereumChain', '/api/session/v1/']) {
    assert.ok(!entryText.includes(needle), `dist/assets/${entry[0]} contains ${needle}: the feature must stay in its chunk`);
  }
  const islandText = readFileSync(join(DIST, 'assets', island[0]), 'utf8');
  assert.ok(islandText.includes('/api/session/v1/'), 'the chunk speaks to the session family through the same-origin bridge');
  assert.ok(islandText.includes('wallet_switchEthereumChain'), 'the chunk asks the wallet to be on Robinhood Chain');
  t.diagnostic(`dist/assets/${entry[0]}: ${statSync(join(DIST, 'assets', entry[0])).size} bytes, ${gzip(join(DIST, 'assets', entry[0]))} gzip`);
  t.diagnostic(`dist/assets/${island[0]}: ${statSync(join(DIST, 'assets', island[0])).size} bytes, ${gzip(join(DIST, 'assets', island[0]))} gzip`);
});

test('the deployed build carries none of the test probes', () => {
  const forbidden = ['__dominoSessionProbe', '__DOMINO_TEST_HOOKS__', 'testHooks', 'armPrivateRead', 'resolvePrivateReads', 'PrivateReadProbe'];
  for (const { file, text } of textFiles(DIST)) {
    for (const needle of forbidden) assert.ok(!text.includes(needle), `dist/${file} contains ${needle}`);
  }
});

test('the wallet-test build writes its own directory and loads the feature lazily', () => {
  assert.notEqual(resolve(WALLET), resolve(DIST));
  const { js, entry, island } = shape(WALLET);
  assert.equal(island.length, 1, js.join(', '));
  assert.equal(entry.length, 1);
  const entryText = readFileSync(join(WALLET, 'assets', entry[0]), 'utf8');
  assert.ok(!entryText.includes('personal_sign'), 'wallet code must sit in the lazy chunk, not the entry');
  const islandText = readFileSync(join(WALLET, 'assets', island[0]), 'utf8');
  assert.ok(islandText.includes('/api/session/v1/'));
  assert.ok(islandText.includes('wallet_switchEthereumChain'));
  assert.ok(islandText.includes('__dominoSessionProbe'), 'the probes are what this build is for');
});

test('no connector SDK, relay or public RPC endpoint reached either build', () => {
  // Names alone are not evidence: viem has a WalletConnect error class and
  // wagmi's injected connector knows the Coinbase and MetaMask provider flags.
  // What must not be present is SDK code or anywhere to connect to.
  const forbidden = [
    /@walletconnect\/|relay\.walletconnect|walletconnect\.(com|org)|EthereumProvider\.init/i,
    /@coinbase\/wallet-sdk|CoinbaseWalletSDK|keys\.coinbase\.com/i,
    /@metamask\/(sdk|connect)|metamask-sdk|MetaMaskSDK/i,
    /@base-org\/account|@safe-global\//i,
    /wss:\/\//,
  ];
  // The only URLs in a build are documentation links in error messages and
  // XML namespaces, plus the Google Fonts stylesheet index.html has always
  // loaded under the CSP. An RPC endpoint would be none of these.
  // domino.invalid and json-schema.org are the $id and $schema of the
  // producer's JSON schemas, in the contract packages the read adapter
  // validates against. Both are identifiers: `.invalid` is reserved by RFC
  // 2606 so it can never resolve, and the vocabulary URI is never fetched.
  const allowedHosts = new Set([
    'viem.sh',
    'wagmi.sh',
    'react.dev',
    'uniswap.org',
    'www.w3.org',
    'fonts.googleapis.com',
    'fonts.gstatic.com',
    'domino.invalid',
    'json-schema.org',
  ]);
  for (const [label, dir] of [
    ['dist', DIST],
    ['.wallet-test-dist', WALLET],
  ]) {
    for (const { file, text } of textFiles(dir)) {
      for (const pattern of forbidden) assert.ok(!pattern.test(text), `${label}/${file} matches ${pattern}`);
      const hosts = new Set([...text.matchAll(/https?:\/\/([a-z0-9.-]+)/gi)].map((match) => match[1].toLowerCase()));
      for (const host of hosts) assert.ok(allowedHosts.has(host) || file.endsWith('.css'), `${label}/${file} names ${host}`);
    }
  }
});

test('the lockfile holds no optional connector SDK', () => {
  const lock = JSON.parse(readFileSync(join(APP, 'package-lock.json'), 'utf8'));
  const packages = Object.keys(lock.packages);
  const sdks = packages.filter((name) =>
    /node_modules\/(@walletconnect|@coinbase|@metamask|@base-org|@safe-global|@reown|porto|accounts)(\/|$)/.test(name),
  );
  assert.deepEqual(sdks, []);
});

test('the wallet chunk stays within its size budget, in the build that deploys as well', (t) => {
  // 90 kB gzip is the ceiling for everything the lazy chunks add to a build:
  // wallet sign-in, the read screens and the shared read source together. A
  // connector SDK or a public-client stack slipping in would blow well past it.
  const BUDGET = 90_000;
  for (const [label, dir] of [
    ['dist', DIST],
    ['.wallet-test-dist', WALLET],
  ]) {
    const extra = scripts(dir).filter((file) => !file.startsWith('index-'));
    let total = 0;
    for (const file of extra) {
      const size = gzip(join(dir, 'assets', file));
      total += size;
      t.diagnostic(`${label}/assets/${file}: ${statSync(join(dir, 'assets', file)).size} bytes, ${size} gzip`);
    }
    assert.ok(total <= BUDGET, `${label} wallet chunks are ${total} bytes gzip, over the ${BUDGET} budget`);
  }
});
