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
  // Setup consumes onboarding-v1 for the signed-in wallet (G15); its client stays out of the entry too.
  for (const needle of ['personal_sign', 'wallet_switchEthereumChain', '/api/session/v1/', '/api/onboarding/v1/', 'X-Domino-Onboarding-Contract']) {
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
  // 2026-09-24: the metadata endpoint's same GET also picks which pool ids New
  // position asks the read service to verify (src/lib/read/screens/poolHints.ts):
  // the host and path are unchanged, and none of its figures is shown.
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
    // The product now consumes onboarding-v1 (New position's deposit amounts,
    // Setup's swap quote), so its runtime ships in those lazy chunks. Its swap
    // response schema pins the provider the backend quoted from as a `const`
    // (SwapProvenance.endpoint): a value the validator compares, never a
    // destination. The page only ever posts to its own /api/onboarding/v1/.
    'trade-api.gateway.uniswap.org',
  ]);
  // Exactly those, and only where the deployed CSP admits the two that are ever contacted.
  const csp = readFileSync(join(APP, 'functions', '_middleware.ts'), 'utf8');
  assert.ok(csp.includes("img-src 'self' data: https://cdn.dexscreener.com"), 'the CSP names the artwork CDN');
  assert.ok(csp.includes("connect-src 'self' https://api.dexscreener.com"), 'the CSP names the artwork metadata endpoint');
  assert.doesNotMatch(csp, /app\.uniswap\.org/, 'the catalogue citation is never a destination');
  assert.doesNotMatch(csp, /gateway\.uniswap\.org/, 'the swap provenance label is never a destination');
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
  // Preserve the original session + public-read ceiling. P2 added four explicitly
  // lazy financial screens and their schema/ABI clients; wave 2 added New
  // position's deposit amounts and the onboarding client they share with Setup's
  // swap quote. Measured on 2026-09-15, gzip level 9, shared dependencies
  // included: before this branch the all-lazy closure was 145,806 B in dist and
  // 146,328 B in .wallet-test-dist (financial 132,231 B), 2.8% and 2.4% under
  // 150 kB. The closed owner ABIs now ship as JSON instead of being parsed at
  // runtime, which drops abitype's parser: 143,468 B and 143,985 B (financial
  // 129,891 B), 4.4% and 4.0% under the ceiling. The wallet-test build is the
  // larger and fails first. The headroom is printed with every run below; the
  // ceilings stay where they were, without charging these opt-in screens to
  // visitors who only open wallet sign-in or public reads.
  //
  // 2026-09-22: Setup gained the deposit through the wallet alone
  // (screens/WalletDeposit.tsx with create/mintPlan.ts, create/depositForm.ts
  // and finance/gas.ts), the path that creates a position with no session and
  // no deposit service. Measured in dist: financial 140,042 B, all lazy
  // 153,653 B. The all-lazy ceiling moves to 160 kB for it; the session and
  // public-read ceiling is untouched (50,957 B against 90 kB), so nobody who
  // never opens Setup pays for it.
  // 2026-09-23: the owner-only V4 sequence snapshot and readiness UI stay in
  // the lazy finance closure. Readiness adds about 1.7 kB gzip versus main
  // #204's Linux baseline of 160,358 B; PR #205 measured 162,022 B on Linux.
  // The 163 kB ceiling leaves 978 B headroom there. The 90 kB session/read and
  // 150 kB finance ceilings stay unchanged; the initial closure is outside this sum.
  // 2026-09-24: Create position checks the pool before a one-token deposit
  // (CreatePosition.tsx swapPreflight: finance/setup.ts poolState, quotePool with
  // its quoterAbi and revertOf, depositPlan.ts quoteWithin/endSqrtPrice, and the
  // sentences that say nothing was deposited), all inside the lazy DepositAmounts
  // chunk. Measured on Windows, gzip level 9, both builds from the same tree: at
  // main 6af7691 financial was 148,417 B (dist) and 148,698 B
  // (.wallet-test-dist), all lazy 162,022 B and 162,437 B; with the check,
  // financial 149,916 B and 150,206 B, all lazy 163,521 B and 163,946 B (about
  // +1.5 kB each). The financial ceiling moves to 151.5 kB and the all-lazy one
  // to 164.5 kB, keeping the headroom they had (1,584 B / 1,294 B and
  // 979 B / 554 B). The 90 kB session/read ceiling is untouched: nobody who
  // never opens Review's Create position pays for it.
  // 2026-09-24: Positions lists the connected wallet's position NFTs and opens a
  // page per position (owner's request). Both are lazy read roots
  // (OwnedPositions, PositionDetail) with their shared PositionFigures and
  // PositionRange chunks, so the entry every page loads grows by 598 B only
  // (229,365 -> 229,963 B in dist); the position-actions placeholders add 143 B
  // to the financial closure. Measured on Windows, gzip level 9: all lazy
  // 162,024 -> 170,635 B in dist and 162,452 -> 171,066 B in .wallet-test-dist;
  // financial 148,418 -> 148,561 B and 148,712 -> 148,851 B; session/public reads
  // 59,413 B and 59,918 B. The all-lazy ceiling moves to 172 kB for it (934 B
  // headroom in .wallet-test-dist); the 90 kB and 150 kB ceilings are unchanged.
  // 2026-09-24: the owner's position actions, Collect fees, Close position and
  // the refund of a held deposit (components/positions/PositionActions.tsx,
  // HeldDeposits.tsx, finance/position.ts, about 11.6 kB gzip), are lazy
  // financial roots. Measured on Windows, gzip level 9, shared dependencies
  // included. Before (main 6af7691): dist financial 148,418 B, all lazy
  // 162,024 B; .wallet-test-dist 148,712 B and 162,452 B. After, on this branch,
  // where only the wallet-test lab (screens/PositionLab.tsx, about 0.8 kB) opens
  // them: dist unchanged at 148,416 B and 162,021 B; .wallet-test-dist 161,014 B
  // and 174,757 B. With the Positions screens opening both lazily (the merged
  // shape, measured with a temporary opener): dist 159,929 B and 173,543 B;
  // .wallet-test-dist 161,013 B and 174,759 B. The financial ceiling moves to
  // 162 kB and the all-lazy one to 176 kB for them, about 1 kB over the larger
  // build; the 90 kB session/read ceiling is untouched, so nobody who never
  // opens a position's actions pays for them.
  // 2026-09-24, merged (the three entries above were measured on their own
  // branches; these numbers supersede their ceilings): the pool check before a
  // one-token deposit, the Positions list and page, the position actions and
  // the review's fixes, all on one tree. Measured on Windows, gzip level 9:
  // dist financial 162,459 B, all lazy 185,115 B; .wallet-test-dist financial
  // 163,591 B, all lazy 186,391 B (it also carries the test-only PositionLab).
  // Against main 6af7691 (financial 148,418 B / 148,712 B, all lazy 162,024 B
  // / 162,452 B) that is about +14.9 kB financial and +23.9 kB all lazy, all in
  // chunks opened only by Review's Create position or by Positions. The
  // financial ceiling moves to 165 kB and the all-lazy one to 188 kB, about
  // 1.4 kB and 1.6 kB over the larger build; the 90 kB session/read ceiling is
  // unchanged.
  for (const [label, dir] of [
    ['dist', DIST],
    ['.wallet-test-dist', WALLET],
  ]) {
    const { js, entry, island } = shape(dir);
    const initial = staticClosure(dir, entry);
    // Changed on purpose (owner, 2026-09-24): Positions' own list (components/positions/OwnedPositions.tsx) and a
    // position's page (screens/PositionDetail.tsx) are public-read screens in chunks of their own, opened only on
    // Positions, so the entry every page loads does not carry them.
    const readRoots = js.filter((file) => /^(PoolExplorer|TokenPicker|index|OwnedPositions|PositionDetail)-/.test(file) && !initial.has(file));
    // New position's Create position is the fifth private lazy root: the chunk Review opens in wallet builds
    // (components/create/DepositAmounts.tsx), which signs through the wallet with the setup client. Changed on
    // purpose (owner, 2026-09-22): it held Review's deposit amounts and their onboarding-v1 preview (G8) before;
    // those were deleted, and the chunk is Create position alone.
    // 2026-09-24: the owner's position actions are lazy roots of their own: components/positions/PositionActions.tsx
    // (Collect fees, Close position) and HeldDeposits.tsx (the refund of a held setup deposit), opened lazily by the
    // Positions screens in every wallet build, and in the wallet-test build also by its test-only lab
    // (screens/PositionLab.tsx, routed only behind __DOMINO_TEST_HOOKS__). A deployable dist never carries the lab, and
    // carries the two actions together or not at all (not at all on a branch where no Positions screen opens them yet).
    const positionRoots = js.filter((file) => /^(PositionActions|HeldDeposits|PositionLab)-/.test(file)).map((file) => file.split('-')[0]).sort();
    if (dir === WALLET) assert.deepEqual(positionRoots, ['HeldDeposits', 'PositionActions', 'PositionLab'], 'the lab and the two actions it opens');
    else assert.ok(['', 'HeldDeposits,PositionActions'].includes(positionRoots.join()), `dist carries both position actions or neither, and never the lab: ${positionRoots.join(', ')}`);
    const financialRoots = js.filter((file) => /^(Setup|Sequence|Execution|Performance|DepositAmounts|PositionActions|HeldDeposits|PositionLab)-/.test(file));
    assert.equal(financialRoots.length, 5 + positionRoots.length, 'the four P2 financial screens, New position\'s Create position and the position actions are explicit lazy roots');
    assert.equal(readRoots.filter((file) => file.startsWith('index-')).length, 1, 'include the public read screen, even though Vite calls it index');
    const base = new Set([...staticClosure(dir, [...island, ...readRoots])].filter((file) => !initial.has(file)));
    const financial = new Set([...staticClosure(dir, financialRoots)].filter((file) => !initial.has(file)));
    for (const file of financialRoots) assert.ok(!base.has(file) && !initial.has(file), `${file} must remain opt-in`);
    const allLazy = new Set([...base, ...financial]);
    assert.deepEqual([...new Set([...initial, ...allLazy])].sort(), js, 'every generated script belongs to a measured closure');
    for (const [family, files, budget] of [['session/public reads', base, 90_000], ['financial', financial, 165_000], ['all lazy', allLazy, 188_000]]) {
      const total = [...files].reduce((sum, file) => sum + gzip(join(dir, 'assets', file)), 0);
      // The headroom is a diagnostic only, so the margin stays visible in every run; only the budget itself fails the test.
      t.diagnostic(`${label} ${family}: ${total} bytes gzip (${files.size} scripts; ${budget} budget; ${budget - total} bytes, ${((100 * (budget - total)) / budget).toFixed(1)}% headroom)`);
      assert.ok(total <= budget, `${label} ${family} is ${total} bytes gzip, over the ${budget} budget`);
    }
  }
});
