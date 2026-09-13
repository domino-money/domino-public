/**
 * What each build contains, read from the built files.
 *
 * The default build is what Pages deploys, and it carries wallet sign-in: the
 * feature is part of the site, in a lazy island with shared static dependencies
 * beside the entry, so a page that never opens it never downloads it. What the deployed build may never
 * carry is the probes the browser tests drive; those belong to the wallet-test
 * build alone. Neither build may carry a connector SDK, a relay or any public
 * RPC endpoint: every wallet call goes through the wallet's own provider, and
 * the page may reach nothing but its own origin.
 */
import assert from 'node:assert/strict';
import { parse } from '@babel/parser';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
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
const parsed = new Map();
function moduleTree(dir, file) {
  const path = join(dir, 'assets', file);
  if (!parsed.has(path)) parsed.set(path, parse(readFileSync(path, 'utf8'), { sourceType: 'module', createImportExpressions: true }));
  return parsed.get(path);
}
function* nodes(node) {
  if (!node || typeof node !== 'object') return;
  if (node.type) yield node;
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) { for (const child of value) yield* nodes(child); }
    else if (value && typeof value === 'object') yield* nodes(value);
  }
}
// Follow only real static imports/re-exports. A textual scan would accidentally
// traverse Vite's dynamic import/preload map and charge every opt-in screen to
// the session island. Shared chunks may themselves have static dependencies.
function staticClosure(dir, roots) {
  const found = new Set();
  function visit(file) {
    if (found.has(file)) return;
    assert.ok(scripts(dir).includes(file), `missing local module ${file}`);
    found.add(file);
    for (const node of moduleTree(dir, file).program.body) {
      if (!['ImportDeclaration', 'ExportNamedDeclaration', 'ExportAllDeclaration'].includes(node.type) || !node.source) continue;
      assert.match(node.source.value, /^\.\/[\w.-]+\.js$/, 'a bundled static dependency must be a local script');
      visit(basename(node.source.value));
    }
  }
  roots.forEach(visit);
  return found;
}
const closureText = (dir, files) => [...files].map((file) => readFileSync(join(dir, 'assets', file), 'utf8')).join('\n');
/**
 * The one entry script and the one wallet island root of a build.
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

test('the feature is lazy: the entry closure holds no wallet code, and the island static closure holds the session client', (t) => {
  const { entry, island } = shape(DIST);
  const initial = staticClosure(DIST, entry);
  const entryText = closureText(DIST, initial);
  for (const needle of ['personal_sign', 'wallet_switchEthereumChain', '/api/session/v1/']) {
    assert.ok(!entryText.includes(needle), `dist/assets/${entry[0]} contains ${needle}: the feature must stay in its chunk`);
  }
  assert.ok(!initial.has(island[0]), 'the entry must not statically load the session island');
  assert.ok([...nodes(moduleTree(DIST, entry[0]))].some((node) => node.type === 'ImportExpression' && node.source.value === `./${island[0]}`), 'the entry opens the island through a dynamic import');
  const islandText = closureText(DIST, staticClosure(DIST, island));
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
  const initial = staticClosure(WALLET, entry);
  const entryText = closureText(WALLET, initial);
  assert.ok(!entryText.includes('personal_sign'), 'wallet code must sit in the lazy chunk, not the entry');
  assert.ok(!initial.has(island[0]));
  const islandText = closureText(WALLET, staticClosure(WALLET, island));
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
  // The two DexScreener hosts are token artwork's decoration source
  // (src/lib/tokenArtwork.ts): an image CDN and the metadata endpoint that
  // names an image, both named in the deployed CSP (functions/_middleware.ts,
  // img-src and connect-src) and pinned by tests/token-artwork.test.mjs. Not
  // an RPC endpoint, a relay or a connector; nothing about a wallet goes there.
  const allowedHosts = new Set([
    'viem.sh',
    'wagmi.sh',
    // abitype/src/errors.ts builds its documentation link; its human-readable
    // SolidityProtectedKeywordError links to the language's keyword cheatsheet.
    'abitype.dev',
    'docs.soliditylang.org',
    'react.dev',
    'uniswap.org',
    'www.w3.org',
    'fonts.googleapis.com',
    'fonts.gstatic.com',
    'domino.invalid',
    'json-schema.org',
    'cdn.dexscreener.com',
    'api.dexscreener.com',
    // The reviewed pool catalogue records where its labels were inspected
    // (src/config/selectedPoolCatalogue.ts, sourceUrl): a citation kept as
    // data, never rendered as a link and never fetched (tests/read.test.mjs
    // pins its shape; the render suite finds no such link on any route).
    'app.uniswap.org',
  ]);
  // Exactly those, and only where the deployed CSP admits the two that are ever contacted.
  const csp = readFileSync(join(APP, 'functions', '_middleware.ts'), 'utf8');
  assert.ok(csp.includes("img-src 'self' data: https://cdn.dexscreener.com"), 'the CSP names the artwork CDN');
  assert.ok(csp.includes("connect-src 'self' https://api.dexscreener.com"), 'the CSP names the artwork metadata endpoint');
  assert.doesNotMatch(csp, /app\.uniswap\.org/, 'the catalogue citation is never a destination');
  for (const [label, dir] of [
    ['dist', DIST],
    ['.wallet-test-dist', WALLET],
  ]) {
    for (const { file, text } of textFiles(dir)) {
      for (const pattern of forbidden) assert.ok(!pattern.test(text), `${label}/${file} matches ${pattern}`);
      // viem/_esm/errors/abi.js puts this lookup link in the message of
      // AbiFunctionSignatureNotFoundError. Admit only that exact error-message
      // template in a super() call; an RPC/fetch URL using the host still fails.
      let endpointText = text;
      if (file.endsWith('.js') && text.includes('4byte.sourcify.dev')) {
        const tree = moduleTree(dir, basename(file));
        for (const node of nodes(tree)) {
          if (node.type !== 'CallExpression' || node.callee.type !== 'Super') continue;
          const [message, options] = node.arguments;
          if (options?.type !== 'ObjectExpression' || !options.properties.some((p) => p.type === 'ObjectProperty' && p.key.name === 'name' && p.value.value === 'AbiFunctionSignatureNotFoundError')) continue;
          if (message?.type !== 'CallExpression' || message.callee.type !== 'MemberExpression' || message.callee.property.name !== 'join' || message.callee.object.type !== 'ArrayExpression') continue;
          const link = message.callee.object.elements.find((part) => part?.type === 'TemplateLiteral' && part.quasis.length === 2 && part.expressions.length === 1 && part.expressions[0].type === 'Identifier' && part.quasis[0].value.cooked === 'You can look up the signature here: https://4byte.sourcify.dev/?q=' && part.quasis[1].value.cooked === '.');
          if (link) endpointText = endpointText.replace(text.slice(link.start, link.end), 'ABI signature lookup documentation');
        }
      }
      const hosts = new Set([...endpointText.matchAll(/https?:\/\/([a-z0-9.-]+)/gi)].map((match) => match[1].toLowerCase()));
      for (const host of hosts) assert.ok(allowedHosts.has(host) || file.endsWith('.css'), `${label}/${file} names ${host}`);
      // The citation is the catalogue's source path, with the pool id interpolated into it, and nothing else.
      const citations = [...text.matchAll(/https:\/\/app\.uniswap\.org[^"'`\s]*/g)].map((match) => match[0]);
      for (const url of citations) assert.match(url, /^https:\/\/app\.uniswap\.org\/explore\/pools\/robinhood\/(?:\$\{[A-Za-z_$][\w$]*\}|0x[0-9a-f]{64})?$/, `${label}/${file} names app.uniswap.org for something else`);
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

test('session/read closures retain their 90 kB budget; financial screens have a separate measured budget', (t) => {
  // Preserve the original session + public-read ceiling. P2 adds four explicitly
  // lazy financial screens and their schema/ABI clients, measured at 123.4 kB
  // gzip including shared dependencies. The 150 kB financial and total-lazy
  // ceilings leave ~9% over the measured 137.1 kB total, without charging these
  // opt-in screens to visitors who only open wallet sign-in or public reads.
  for (const [label, dir] of [
    ['dist', DIST],
    ['.wallet-test-dist', WALLET],
  ]) {
    const { js, entry, island } = shape(dir);
    const initial = staticClosure(dir, entry);
    const readRoots = js.filter((file) => /^(PoolExplorer|TokenPicker|index)-/.test(file) && !initial.has(file));
    const financialRoots = js.filter((file) => /^(Setup|Sequence|Execution|Performance)-/.test(file));
    assert.equal(financialRoots.length, 4, 'the four P2 financial screens are explicit lazy roots');
    assert.equal(readRoots.filter((file) => file.startsWith('index-')).length, 1, 'include the public read screen, even though Vite calls it index');
    const base = new Set([...staticClosure(dir, [...island, ...readRoots])].filter((file) => !initial.has(file)));
    const financial = new Set([...staticClosure(dir, financialRoots)].filter((file) => !initial.has(file)));
    for (const file of financialRoots) assert.ok(!base.has(file) && !initial.has(file), `${file} must remain opt-in`);
    const allLazy = new Set([...base, ...financial]);
    assert.deepEqual([...new Set([...initial, ...allLazy])].sort(), js, 'every generated script belongs to a measured closure');
    for (const [family, files, budget] of [['session/public reads', base, 90_000], ['financial', financial, 150_000], ['all lazy', allLazy, 150_000]]) {
      const total = [...files].reduce((sum, file) => sum + gzip(join(dir, 'assets', file)), 0);
      t.diagnostic(`${label} ${family}: ${total} bytes gzip (${files.size} scripts; ${budget} budget)`);
      assert.ok(total <= budget, `${label} ${family} is ${total} bytes gzip, over the ${budget} budget`);
    }
  }
});
