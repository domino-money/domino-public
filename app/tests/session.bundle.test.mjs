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

// Changed on purpose (2026-09-28): and, while that RPC cannot be reached, its three public fallbacks (see allowedHosts).
// Changed on purpose (2026-09-25): one public RPC endpoint is now reached, Robinhood Chain's own
// (rpc.mainnet.chain.robinhood.com), for reads only, by the page's own chain reads (src/lib/chain/browser.ts): the RPC
// answers 429 to every call from Cloudflare's edge, so the site's routes that read it for the page failed. Wallet
// calls still go through the wallet's own provider only; no connector SDK or relay is reached.
test('no connector SDK or relay, and no public RPC endpoint but the chain\u2019s own for the page\u2019s reads, reached either build', () => {
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
  // XML namespaces. An RPC endpoint would be none of these. Changed on purpose
  // 2026-09-28 (speed wave, item 35): the Google Fonts stylesheet index.html
  // loaded until then is gone (the site serves the same fonts itself,
  // src/styles/fonts.css), so its two hosts are no longer admitted.
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
  // 2026-09-25: Robinhood Chain's public RPC, which the page reads the chain from itself (the wallet's positions, a
  // position's state, the fees history's logs; src/lib/chain/browser.ts): named in the deployed CSP's connect-src, for
  // the page and for the fees worker (functions/_middleware.ts APP_CSP and WORKER_CSP), because the RPC rate-limits
  // Cloudflare's edge and the site's own routes could not read it for the page. Reads only (tests/read.test.mjs pins
  // the one fetch and the methods it may carry).
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
    'domino.invalid',
    'json-schema.org',
    'cdn.dexscreener.com',
    'api.dexscreener.com',
    'rpc.mainnet.chain.robinhood.com',
    // 2026-09-28: the chain's three public fallbacks (src/lib/chain/endpoints.ts), read with the same fixed calls while
    // the chain's own RPC cannot be reached (the DNS of Vivo, a large Brazilian ISP, answers NXDOMAIN for every host under
    // chain.robinhood.com), each checked to be chain 4663 first (src/lib/chain/failover.ts). Reads only, named in both
    // connect-src directives below, and pinned in tests/read.test.mjs.
    'robinhood-rpc.publicnode.com',
    'rpc.ordofi.network',
    'robinhood.drpc.org',
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
    // 2026-09-26 (owner): Domino's X account, linked once from the footer (src/components/Footer.tsx X_PROFILE). A
    // navigation target in a new tab, never fetched, so no CSP directive names it (tests/render.test.mjs pins the link).
    'x.com',
  ]);
  // Exactly those, and only where the deployed CSP admits the two that are ever contacted.
  const csp = readFileSync(join(APP, 'functions', '_middleware.ts'), 'utf8');
  assert.ok(csp.includes("img-src 'self' data: https://cdn.dexscreener.com"), 'the CSP names the artwork CDN');
  assert.ok(csp.includes("connect-src 'self' https://api.dexscreener.com"), 'the CSP names the artwork metadata endpoint');
  // 2026-09-25: and the chain's RPC, for the page and for the fees worker, which loads nothing and reaches nothing else.
  // 2026-09-28: and its three public fallbacks, exactly those, in both.
  const chainHosts = 'https://rpc.mainnet.chain.robinhood.com https://robinhood-rpc.publicnode.com https://rpc.ordofi.network https://robinhood.drpc.org';
  assert.ok(csp.includes(`"connect-src 'self' https://api.dexscreener.com ${chainHosts}",`), 'the page\u2019s CSP names the chain\u2019s RPC and its fallbacks');
  assert.ok(csp.includes(`export const WORKER_CSP = "default-src 'none'; connect-src ${chainHosts}"`), 'the fees worker\u2019s own CSP names only the chain\u2019s RPC and its fallbacks');
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
  // 2026-09-24, the three features joined up (branch r3/three, on e2f8553 with
  // rugged's PR #212, which had left 120 B of financial headroom): the
  // automation page reads each listed position's feature (src/lib/automationState.ts,
  // shared with Positions' rows and a position's page) so a position already in
  // a sequence says so and is not set up again, and the page shows the new
  // sequence on Positions at once. Measured on Windows, gzip level 9, after the
  // review's fixes (a position's page shares the wallet's list with the
  // automation page, and Rollup now puts that list, the picker's test and the
  // state client in one shared chunk): dist financial 164,754 B, all lazy
  // 181,289 B; .wallet-test-dist financial 165,977 B, all lazy 182,649 B. The
  // financial ceiling moves by the minimum, to 166.1 kB (123 B over the larger
  // build; the branch's first measurement, 166,393 B, had asked for 166.5 kB);
  // the all-lazy and 90 kB session/read ceilings are unchanged.
  // 2026-09-25: the page reads the chain itself (the public RPC answers 429 to
  // every call from Cloudflare's edge, so the site's routes failed and Positions
  // showed nothing): the wallet's positions (the route's scan,
  // functions/_lib/walletPositions.ts), a position's state and the fees
  // history's logs (the relay's reads, functions/_lib/fees.ts), with the RPC
  // runtime, Keccak and the ABI code under them (owned.ts,
  // src/lib/chain/browser.ts). That chain code is one chunk of its own
  // (src/lib/chain/chainCode.ts), loaded by dynamic import on a page's first
  // read of the chain (Positions, a position's page, the automation page's
  // picker), so neither the entry every page loads nor the financial screens'
  // closure carries it: it is measured as its own family, with its own
  // ceiling, like the fees worker. Measured on Windows, gzip level 9, against
  // r3/integrate e2f8553: dist entry 264,120 -> 264,216 B, financial 163,690
  // -> 163,660 B, all lazy 179,305 -> 179,299 B; .wallet-test-dist financial
  // 164,880 -> 164,865 B, all lazy 180,639 -> 180,648 B; the chain code
  // 12,715 B (new, 13,500 B ceiling); the fees worker, which now reads its logs
  // from the chain with the relay's code and its own paced lane, 7,169 ->
  // 14,162 B (16,000 B ceiling, unchanged). The financial, all-lazy and
  // session/read ceilings are unchanged. (An earlier version of this branch
  // shipped the scan in the financial closure and raised that ceiling to
  // 168 kB; the review moved the chain code out instead, and the ceiling is
  // back at 165 kB.)
  // 2026-09-25, r3/three and r3/chain merged (the two entries above were
  // measured on their own branches; these numbers supersede their ceilings):
  // the three features' state client and picker with the page's own chain
  // reads, on one tree (r3/integrate 248090d + r3/chain 036ba3c). Measured on
  // Windows, gzip level 9: dist financial 164,497 B, all lazy 181,069 B, fees
  // worker 14,162 B, chain code 12,715 B; .wallet-test-dist financial
  // 165,682 B, all lazy 182,386 B, fees worker 14,162 B, chain code 12,715 B.
  // The financial ceiling is set at the minimum the larger build needs,
  // 165.7 kB (18 B over it): above r3/chain's 165 kB, which three's automation
  // client and picker outgrow, and below r3/three's 166.1 kB. The all-lazy,
  // fees worker, chain code and 90 kB session/read ceilings are unchanged.
  // 2026-09-25, later (r3/integrate after the merge): the automation state is
  // read by the page itself through the chain code (the route's scanAutomation
  // joins the chunk), a later read of a wallet reads only the newest logs, and
  // a position's replay probes its pool first. Measured on Windows, gzip level
  // 9, both builds alike: chain code 13,618 B (12,715 B at the merge), fees
  // worker 14,863 B (14,162 B); dist financial 164,347 B and .wallet-test-dist
  // 165,547 B (the automation client no longer carries a fetch of its own),
  // all lazy 180,903 B and 182,232 B. The chain code ceiling moves by the
  // minimum, to 13.7 kB (82 B over both builds); every other ceiling is
  // unchanged.
  // 2026-09-25, later still: the probe in slices and a busy pool's epochs
  // asked in capped parts (functions/_lib/fees.ts, which the chain code and the
  // fees worker both carry). Measured the same way, both builds alike: chain
  // code 13,710 B, fees worker 15,029 B; dist financial 164,355 B and
  // .wallet-test-dist 165,549 B. The chain code ceiling moves by the minimum
  // again, to 13.8 kB (90 B over both builds).
  // 2026-09-25, EIP-7702 delegates: funding reads which delegate an account
  // runs, and waits for the person to confirm one this app does not recognize
  // (src/finance/delegates.ts with its table of 13 code hashes, and the
  // confirmation in Create position and the advanced funding form); the
  // wallet dialog names the delegate from the same table. Measured by CI
  // (Linux, gzip level 9; main 661fefb in run 36156871289, the branch in run
  // 36158157791): dist financial 164,355 -> 167,074 B, all lazy 180,916 ->
  // 183,774 B, session/public reads 57,120 -> 59,087 B; .wallet-test-dist
  // financial 165,549 -> 168,263 B, session/public reads 57,610 -> 59,577 B.
  // The financial ceiling moves by the minimum, to 168.3 kB (37 B over the
  // larger build); the all-lazy, fees worker, chain code and 90 kB
  // session/read ceilings are unchanged. Measure on x86, as these notes do:
  // an arm64 Mac's gzip sizes come out about 0.25% smaller (167,868 B for the
  // same .wallet-test-dist), and a ceiling first set from them fell 363 B
  // short on CI.
  // 2026-09-25, EIP-5792 batches: Create position in one signature
  // (finance/setup.ts atomicStatus, prepareBatch, sendBatch and batchStatus,
  // the batch latch in finance/nonce.ts, Create position's batch path and its
  // offer to a wallet that can upgrade; docs/plans/2026-09-25-eip5792-batches-design.md),
  // and the chain code's simulateOnChain (lib/chain/browser.ts), the batch's
  // simulation for a wallet without eth_simulateV1. Measured by CI (main
  // 7408d99 in run 36162545618, the branch in run 36174459017): dist financial
  // 167,074 -> 170,402 B, all lazy 183,774 -> 187,095 B; .wallet-test-dist
  // financial 168,263 -> 171,641 B, all lazy 185,097 -> 188,472 B; chain code
  // 13,710 -> 13,853 B in both builds. Each moves by the minimum: financial
  // 171.7 kB (59 B over the larger build), all lazy 188.5 kB (28 B), chain code
  // 13.9 kB (47 B); the fees worker and 90 kB session/read ceilings are unchanged.
  // 2026-09-25, round 4 merged on #217 (both sides measured together on
  // Windows, gzip level 9): .wallet-test-dist all lazy 188,595 B, 95 B over
  // #217's 188.5 kB, from the fast pool figures (lib/read/scheduler.ts,
  // marketsProvider.ts catch-up). The all-lazy ceiling moves by the minimum,
  // to 188.7 kB; financial 171,646 B, chain code 13,874 B and fees worker
  // 20,523 B stay under #217's and r4/fees' ceilings.
  // 2026-09-25, r4/fees (the owner: the Fees earned card loaded, then vanished,
  // on his busy-pool positions): the fees worker replays a busy pool's position
  // from the Swaps of its own life (src/lib/fees/replay.ts price path,
  // pipeline.ts path mode), reads them with two kinds of its own
  // (functions/_lib/feesPath.ts, which the page's chain code does not carry)
  // and draws an estimate first (src/lib/fees/estimate.ts). Measured on
  // Windows, gzip level 9, both builds alike: fees worker 20,180 B (15,029 B
  // before), chain code 13,731 B (/state names the pool's protocol fee). The
  // fees worker ceiling moves by the minimum, to 20.2 kB (20 B over both
  // builds); every other ceiling is unchanged.
  // 2026-09-25, r4/fees after its review: the estimate's windows sized by the
  // rate they read (a quiet probe made them wide, and they were cut at the
  // reply's cap live), the exact read keeping its place for a later run, the
  // lanes of several tabs sharing one pace on their channel, and the price
  // path's settled amounts marked near. Measured on Windows, gzip level 9, both
  // builds alike: fees worker 20,523 B; chain code 13,731 B (unchanged). The
  // fees worker ceiling moves to 20.6 kB, 77 B over both builds: a little more
  // than the minimum, because CI measures on Linux (the worker's sources are
  // LF in the index and the working tree, core.autocrlf false, so its input
  // is the same bytes there; not measured on Linux). Every other ceiling is
  // unchanged.
  // 2026-09-25, EIP-5792 batches, PR 2: a sequence's creation in one signature
  // (finance/sequence.ts prepareCreateBatch, sendCreateBatch and
  // createBatchStatus, SequenceCreate's batch path and its offer to a wallet
  // that can upgrade), on finance/batch.ts, which the setup client now shares.
  // Measured by CI (main cd26bad in run 36185407784, the branch in run
  // 36186169371): dist financial 170,401 -> 172,120 B, all lazy 187,217 ->
  // 188,936 B; .wallet-test-dist financial 171,639 -> 173,317 B, all lazy
  // 188,595 -> 190,263 B. Each moves by the minimum: financial 173.4 kB (83 B
  // over the larger build), all lazy 190.3 kB (37 B); the fees worker, chain
  // code and 90 kB session/read ceilings are unchanged.
  // 2026-09-25, the owner's "vamos ligar tudo": a sequence's Turn on and Pause
  // on its root position's page and on the automation page's success
  // (components/positions/SequenceSwitch.tsx, lib/automate/switchGate.ts, and
  // finance/sequenceLive.ts, the automation page's own connect and receipt
  // read moved there to be shared). Turn on asks the automation service
  // through the session, so the execution-v1 runtime, until now the Execution
  // screen's alone, becomes a shared chunk (runtime, closed-schema), and the
  // sequence client is shared by the automation page and the owner's actions.
  // Measured on Windows, gzip level 9, against main 75b04c4 on the same
  // machine (whose figures match CI's above): dist financial 172,120 ->
  // 175,865 B, all lazy 188,936 -> 192,764 B; .wallet-test-dist financial
  // 173,317 -> 177,584 B, all lazy 190,263 -> 194,672 B. Each moves by the
  // minimum: financial 177.6 kB (16 B over the larger build), all lazy
  // 194.7 kB (28 B); the fees worker, chain code and 90 kB session/read
  // ceilings are unchanged.
  // 2026-09-25, the review of Turn on: a "ready" is kept no longer than the
  // automation service's own expiry (at most 10 s by the execution contract,
  // capped at 9 s) and asked again just before it lapses, so the availability
  // client now returns that expiry (finance/automationAvailability.ts
  // automationReadyUntil) and the gate keeps it (lib/automate/switchGate.ts
  // readyUntil, renewIn). Measured on Windows, gzip level 9, both builds from
  // this tree: dist financial 175,865 -> 175,933 B, all lazy 192,764 ->
  // 192,838 B; .wallet-test-dist financial 177,584 -> 177,656 B, all lazy
  // 194,672 -> 194,747 B. Each moves by the minimum: financial 177.7 kB (44 B
  // over the larger build), all lazy 194.8 kB (53 B); every other ceiling is
  // unchanged.
  // 2026-09-26, Set up automation never reached the wallet (the public node keeps a block's state ~12 s, and ~50 pinned
  // reads one by one outlived it): the sequence client reads a block's codes, links and fields eight at a time
  // (finance/sequence.ts inOrder, SEQUENCE_READ_WIDTH). Measured by CI (main 82856af in run 36249257305, the branch in
  // run 36250085928): dist financial 175,948 -> 176,205 B, all lazy 192,851 -> 193,115 B; .wallet-test-dist financial
  // 177,665 -> 177,936 B (over 177.7 kB, where that run's check stopped), all lazy 194,754 B -> about 195,040 B: this
  // tree's figure on an arm64 Mac, 194,634 B, times CI's ratio to that Mac on the other three families (1.0020-1.0022).
  // Each moves by the minimum at 0.1 kB: financial 178.0 kB (64 B over the larger build), all lazy 195.1 kB; the fees
  // worker, chain code and 90 kB session/read ceilings are unchanged.
  // 2026-09-27, the Positions auto-refresh (the owner's OK, "pode fazer", on the study made at 7074cbd): Your positions
  // reads itself again every 30 s and a position's page every 60 s while the tab is visible, in place
  // (lib/walletPositions.ts askWallet, with its block, completeness and same-answer guards and its 60/120 s retry, behind
  // useWalletAnswer's `every`; HeldDeposits.tsx's onBusy, which holds the refresh during a refund; PositionDetail.tsx's
  // tick). walletPositions.ts is the picker's shared chunk, so the financial closure carries the loop too. Made smaller
  // first: walletPositions.ts and PositionDetail.tsx dropped their own copies of the visibility wait for quietRead.ts's,
  // which the entry already carries, and the loop was trimmed (from +361 B to +256 B financial in .wallet-test-dist).
  // Measured on Windows, gzip level 9, both builds from each tree, against 9131592 (the featured pools branch, PR #242):
  // dist financial 176,183 -> 176,442 B, all lazy 193,080 -> 193,305 B; .wallet-test-dist financial 177,902 ->
  // 178,158 B, all lazy 194,986 -> 195,250 B. Each moves by the minimum at 0.1 kB: financial 178.2 kB (42 B over the
  // larger build), all lazy 195.3 kB (50 B); the fees worker, chain code and 90 kB session/read ceilings are unchanged.
  // 2026-09-27, its review: a position's page keeps asking after a failed refresh (60 s, then every 120 s, with no end),
  // and the list's guards hold only with the refresh on. Measured the same way against f9dca1d: dist financial 176,442
  // -> 176,456 B, all lazy 193,305 -> 193,354 B; .wallet-test-dist financial 178,158 -> 178,149 B, all lazy 195,250 ->
  // 195,282 B. Within the ceilings (51 B and 18 B to spare in the larger build), which are unchanged.
  // 2026-09-27, r5/feesfast (the owner: the Fees earned chart took far too long to appear): a young position in a pool
  // whose Swaps the probe sees takes the price path of its own life (src/lib/fees/pipeline.ts P5), its settlements also
  // looked for among the pool's PositionManager ModifyLiquidity (functions/_lib/feesPath.ts `modifies`), its probe
  // stopped after the pool's last hour, its mint looked for in windows newest first (a transfer read names `until`), and
  // a read that names its blocks takes a head already read (functions/_lib/fees.ts headBlock, which the chain code and
  // the fees worker both carry). The owner's 3325113: 12.9 s to a verified chart live, 3.7 to 4.7 s after. Made smaller
  // first (the relay's transfer check; the page's client names the worker's kinds in fewer bytes). Measured on Windows,
  // gzip level 9, both builds from each tree, against main 4f66233: fees worker 20,561 -> 21,309 B and chain code
  // 13,874 -> 13,976 B in both builds; dist financial 176,446 -> 176,456 B, all lazy 193,349 -> 193,359 B;
  // .wallet-test-dist financial 178,158 -> 178,128 B, all lazy 195,284 -> 195,245 B. The fees worker and chain code
  // ceilings move by the minimum at 0.1 kB: 21.4 kB (91 B over both builds) and 14.0 kB (24 B); the financial,
  // all-lazy and 90 kB session/read ceilings are unchanged.
  // 2026-09-27, round 5 (r5/position, the owner: a position's page for someone who knows nothing of pools): its key
  // figures (components/positions/KeyFigures.tsx: Position value, Fees ready to collect, Your APR and the price against
  // the range), Your APR's arithmetic (lib/positionApr.ts), the page's own Activity card (PositionActivity.tsx) and its
  // Details disclosure, all in the position page's lazy chunk, where only that page loads them (the positions kit, which
  // would have put them in the entry every page loads, was measured and left: +1,876 B gzip there). Made smaller first:
  // PositionValue.tsx is gone (its two figures are the key figures'), the page's own price and range cells are gone, and
  // the owner's actions take `primary` from the page rather than reading the automation state themselves. Measured on
  // Windows, gzip level 9, both builds from this tree against 4f66233: dist financial 176,446 -> 176,476 B, all lazy
  // 193,349 -> 195,452 B; .wallet-test-dist financial 178,158 -> 178,177 B (23 B to spare), all lazy 195,284 ->
  // 197,390 B. The all-lazy ceiling moves by the minimum at 0.1 kB, to 197.4 kB (10 B over the larger build); the
  // financial, fees worker, chain code and 90 kB session/read ceilings are unchanged.
  // 2026-09-27, its review, with r5/charts (2504e7b) merged in: Activity marks only the re-adds the vault's own record
  // names (visual/activityRows.ts, PositionActivity.tsx useAutomaticAdds on lib/automationImpact.ts). Measured on
  // Windows, gzip level 9, both builds from this tree: dist financial 175,676 B, all lazy 194,895 B; .wallet-test-dist
  // financial 176,971 B, all lazy 196,369 B. Within the ceilings (1,229 B and 1,031 B to spare in the larger build),
  // which are unchanged.
  // 2026-09-27, round 5, receipts (the owner: "Managed positions" and "Receipts" looked terrible, the receipts running down
  // the Positions tab forever as tall cards of raw hashes): Receipts is one short row per receipt with a plain chip, what
  // it re-added in token units summed per token, the cancelled ones folded into one row, and the detail (amounts, then a
  // short copyable transaction, fee recipient and receipt id) one click away; the Positions tab shows four rows and links
  // the full list on its own page (#/positions/receipts, in the entry); Managed positions is one short row per position
  // with three figures and the rest inside All figures (screens/Execution.tsx, screens/Performance.tsx). The block and
  // sequence hashes and the raw liquidity units are no longer shown, and to make it smaller first the detail's block
  // line went too (45 B in .wallet-test-dist financial). Measured on
  // Windows, gzip level 9, both builds from each tree, against main 4f66233: dist financial 176,446 -> 177,089 B, all lazy
  // 193,349 -> 193,988 B; .wallet-test-dist financial 178,158 -> 178,775 B, all lazy 195,284 -> 195,897 B. Each moves by
  // the minimum at 0.1 kB: financial 178.8 kB (25 B over the larger build), all lazy 195.9 kB (3 B); the fees worker,
  // chain code and 90 kB session/read ceilings are unchanged.
  // 2026-09-27, round 5, receipts, its review: the Positions tab and the receipts page share one execution controller, so
  // See all and the way back read no list of their own (execution-v1's one read per 30 s), and the token details read once
  // are kept; a receipt's open sentence and the line under a position waiting for its first figures are in plain words;
  // Managed positions points at Start tracking when the wallet owns an automation nothing tracks, names a waiting row by its
  // position (with its link), shows no automation address outside All figures and leaves Track your automations out once
  // every listed automation is tracked; "re-add" keeps its hyphen whole (a word joiner). Made smaller first: the new
  // sentences were shortened and the receipts' visibility listener is added once, not per view (52 B in .wallet-test-dist
  // financial). Measured on Windows, gzip level 9, both builds from each tree, against 3ab5e9f (the numbers above): dist
  // financial 177,089 -> 177,246 B, all lazy 193,988 -> 194,140 B; .wallet-test-dist financial 178,775 -> 178,998 B, all
  // lazy 195,897 -> 196,132 B. Each moves by the minimum at 0.1 kB: financial 179.0 kB (2 B over the larger build), all
  // lazy 196.2 kB (68 B); the fees worker, chain code and 90 kB session/read ceilings are unchanged.
  // 2026-09-27, round 5 integrated (r5/integrate: r5/feesfast, r5/position with r5/charts, r5/receipts and r5/docs; the
  // page's Activity waits for the vault's first read as the Fees earned card does; the Price range writes the key figures'
  // plain figures; the card's unclaimed row says "Ready to collect"). Measured on Windows, gzip level 9, both builds from
  // this tree and from a clean checkout of main 4f66233: dist financial 176,446 -> 176,473 B, all lazy 193,349 ->
  // 195,723 B; .wallet-test-dist financial 178,158 -> 177,759 B, all lazy 195,284 -> 197,199 B; fees worker 20,561 ->
  // 21,309 B and chain code 13,874 -> 13,983 B in both builds. The financial ceiling stays main's 178.2 kB (r5/receipts'
  // 179.0 kB is not needed once r5/position's smaller page is in: 441 B to spare); all lazy moves by the minimum at
  // 0.1 kB, to 197.2 kB (1 B over the larger build); the fees worker (21.4 kB) and chain code (14.0 kB) keep
  // r5/feesfast's raise, which the integrated build still needs; 90 kB session/read is unchanged.
  // 2026-09-27, round 5 integrated, the Fees earned card's new attempt (the owner: the chart took far too long; a refused
  // run was asked again only by the next minute's /state read, about 67 s to the chart live): the fees worker's `done`
  // carries its lane's wait (lib/chain/browser.ts chainLane wait, feesReplay.worker.ts) and the store asks a refused run
  // again once it is over, then after 30, 60 and 120 s (lib/fees/store.ts RETRY_MS). The store is in the entry, and no
  // lazy chunk's code changed: each one's raw bytes are the same, but every one imports the entry by its hashed file name,
  // and the new name alone costs .wallet-test-dist's all lazy 46 B gzip (compared chunk by chunk). Made smaller first:
  // the worker's failure answer is one `post`, not two. Measured on Windows, gzip level 9, both builds from this tree
  // against 161d247: dist financial 176,473 -> 176,479 B, all lazy 195,723 -> 195,727 B; .wallet-test-dist financial
  // 177,759 -> 177,794 B, all lazy 197,199 -> 197,245 B; fees worker 21,309 -> 21,331 B and chain code 13,983 B
  // (unchanged: the lane is the worker's alone) in both builds. All lazy moves by the minimum at 0.1 kB, to 197.3 kB
  // (55 B over the larger build); the financial, fees worker, chain code and 90 kB session/read ceilings are unchanged.
  // 2026-09-27, round 6, point 3b (the owner: add each position's APR to Your positions, and clean the table): the list
  // shows Your APR, the position page's own figure, from the fees store's history of the visit, and measures the others
  // itself, one position at a time while on the screen (components/positions/listApr.ts: the queue, and the rows'
  // figures; OwnedPositions.tsx: the fees store's views and a row observer). lib/positionApr.ts leaves the position
  // page's chunk for a chunk the page and the list share (with AutomateEntry.tsx), and the rows' automation line under
  // each row is gone (its pictures with it). Made smaller first: the row's USD line (RowUsd), the old row's range bar
  // and its block tooltips are gone, the automation cell draws no picture. Measured on Windows, gzip level 9, both
  // builds from this tree and from a clean checkout of main 4e47edc: dist financial 176,497 -> 176,489 B, all lazy
  // 195,747 -> 197,369 B; .wallet-test-dist financial 177,778 -> 177,791 B, all lazy 197,228 -> 198,878 B; fees worker
  // and chain code unchanged. All lazy moves by the minimum at 0.1 kB, to 198.9 kB (22 B over the larger build); the
  // financial, fees worker, chain code and 90 kB session/read ceilings are unchanged.
  // 2026-09-28, point 3b's review (listApr.ts: the cap on the page's time, a second try after a cap, a refused /state
  // read asked again, never two runs at once, the queue handed the fees store itself; AutomateEntry.tsx: no tooltip on
  // the row's badge; the Positions docs pictures re-shot): measured the same way on a clean build of this tree, dist all
  // lazy 197,383 B and .wallet-test-dist all lazy 198,852 B (48 B under 198.9 kB; it moves by some 60 B between builds of
  // the same code, with the CSS file name the chunks import). No ceiling changes.
  // 2026-09-27, round 6, r6/receipts (the owner: the Receipts card and page blanked on every refresh, Show more vanished,
  // Managed positions flashed empty; "Fees added back" everywhere): the execution controller keeps what it shows through
  // every read, a hidden tab, a failure and a new session of the same wallet, reads the list's pages by itself (twenty to a
  // page, up to five) and again every five minutes, merging each page in place (finance/execution.ts); Managed positions
  // share one controller that keeps its cards the same way (finance/performance.ts, screens/Performance.tsx); both paint at
  // once from a checked, versioned, size-bounded copy in this browser, per wallet and chain, while the session is checked
  // and after, and forget it once the wallet signs out (finance/privateCache.ts, a chunk the two share, which now also
  // carries finance/reask.ts); the receipts page's Show more reveals ten rows at a time and keeps them. Made smaller first:
  // one hook paints the copy for both cards, one function forgets it for both controllers, the shared start also listens to
  // the tab's visibility, the token copy is plain triples, and Infinity replaces Number.*_INFINITY. Measured on Windows,
  // gzip level 9, both builds from this tree against main 4e47edc (chunk by chunk in .wallet-test-dist: Execution +681 B,
  // Performance +202 B, the shared chunk +641 B net of reask's 224 B, the entry +23 B): dist financial 176,479 -> 178,007 B,
  // all lazy 195,727 -> 197,253 B; .wallet-test-dist financial 177,794 -> 179,306 B, all lazy 197,245 -> 198,747 B. Each
  // moves by the minimum at 0.1 kB: financial 179.4 kB (94 B over the larger build), all lazy 198.8 kB (53 B); the fees
  // worker, chain code and 90 kB session/read ceilings are unchanged.
  // 2026-09-28, r6/receipts after its review: the wallet island forgets every wallet's private copies once a session ends,
  // a wallet is let go or an account is refused, on any page (components/wallet/WalletSessionIsland.tsx calls
  // finance/privateCards.ts forgetPrivate; the cards' controllers stop once no Positions view is shown, so a sign-out elsewhere
  // never reached their forgetting, which is gone); a Start tracking listing a stop cut off is asked again
  // (finance/performance.ts); Show more reads its page next, ahead of a read under way, a read from the first page covers every
  // receipt a read listed, and an emptied list is kept empty (finance/execution.ts). finance/privateCache.ts and
  // finance/reask.ts are one module now, finance/privateCards.ts: the island's import alone had split their shared chunk in
  // two. Made smaller first: the two modules joined (the shared chunk 865 -> 834 B), a check of each page's cursor left for a
  // bound of a hundred pages, and one loop over each page's receipts. Measured on Windows, gzip level 9, both builds from this
  // tree and from a clean checkout of e1759f0: dist financial 178,057 -> 178,013 B, all lazy 197,304 -> 197,324 B,
  // session/public reads 61,166 -> 62,064 B; .wallet-test-dist financial 179,318 -> 179,318 B, all lazy 198,763 -> 198,824 B
  // (chunk by chunk: WalletSessionIsland +61 B, Execution +21 B, Performance -7 B, the shared chunk -31 B), session/public
  // reads 61,729 -> 62,624 B. All lazy moves by the minimum at 0.1 kB, to 198.9 kB (76 B over the larger build); the
  // financial (82 B to spare), fees worker, chain code and 90 kB session/read ceilings are unchanged.
  // 2026-09-28, round 6 integrated (r6/integrate: r6/marketsdata, r6/poolpage, r6/newposition, r6/postable, r6/wallet,
  // r6/receipts, r6/simulator and r6/settingsdocs merged on main 4e47edc, then one markets price and the docs' pictures).
  // r6/postable and r6/receipts each raised all lazy from 197.3 to 198.9 kB on its own, so together they are over it: Your
  // APR on the list (the shared positionApr chunk +2,583 B, less PositionDetail -743 B and AutomateEntry -1,797 B, which
  // it came out of; OwnedPositions +1,606 B with listApr.ts) and the receipts that never blank (privateCards +836 B less
  // reask's 224 B, Execution +718 B, Performance +202 B, WalletSessionIsland +64 B); DepositAmounts -99 B
  // (r6/newposition). Nothing is duplicated between them to take out: each branch was made smaller first. Measured on
  // Windows, gzip level 9, clean builds of this tree and of a clean checkout of main 4e47edc: dist financial 176,497 ->
  // 177,928 B, all lazy 195,747 -> 198,886 B, session/public reads 61,172 -> 63,713 B; .wallet-test-dist financial
  // 177,778 -> 179,234 B, all lazy 197,228 -> 200,393 B, session/public reads 61,739 -> 64,283 B; fees worker 21,331 B and
  // chain code 13,983 B unchanged. All lazy moves by the minimum at 0.1 kB, to 200.4 kB (7 B over the larger build; a
  // change to any chunk or to the stylesheet's hashed name moves it by tens of bytes, so measure again after one); the
  // financial (166 B to spare), fees worker, chain code and 90 kB session/read ceilings are unchanged.
  // 2026-09-28, fix/positions-stuck (the owner, on his phone: Your positions stayed on its loading rows, "Reading your
  // positions from the chain…", while the public RPC refused his address): the list's read holds every tab's fees lane
  // for the whole of it and a refusal any page read meets rests them all (lib/chain/browser.ts holdReads, quietIn and
  // the page's side of the channel); the list's APR waits on both, and after each position as long as it took
  // (components/positions/listApr.ts); a first read the RPC refused is asked again 2 s later each time
  // (lib/walletPositions.ts); the list draws this browser's copy of the chain's last answer while the chain is read
  // (OwnedPositions.tsx, on finance/privateCards.ts keep, readKept and drop); and a WebView whose fetch gives no body
  // stream has its replies read whole (functions/_lib/owned.ts bodyWithin). Made smaller first: the fees relay's own copy
  // of bodyWithin is gone for owned.ts's (in the chain code and the fees worker alike), the fees worker no longer carries
  // the page's runtime it never used (it reads through its lane only), and the list's APR reads its wait through
  // walletPositions.ts's own import of the chain code rather than an import of its own. Measured on Windows, gzip level
  // 9, both builds from this tree and from main d1197112: dist financial 177,935 -> 178,010 B, all lazy 198,897 ->
  // 199,167 B, chain code 13,983 -> 14,150 B, fees worker 21,331 -> 21,131 B; .wallet-test-dist financial 179,203 ->
  // 179,288 B, all lazy 200,342 -> 200,635 B, chain code 13,983 -> 14,150 B, fees worker 21,331 -> 21,131 B. All lazy
  // and the chain code move by the minimum at 0.1 kB: 200.7 kB (65 B over the larger build) and 14.2 kB (50 B); the
  // financial (112 B to spare), fees worker (269 B) and 90 kB session/read ceilings are unchanged.
  // 2026-09-28, fix/rpc-fallback (the DNS of Vivo, a large Brazilian ISP, answers NXDOMAIN for every host under
  // chain.robinhood.com, and there the page read nothing: Your positions "couldn't be read"): the page's and the fees
  // worker's runtime (lib/chain/browser.ts) send through a router (lib/chain/failover.ts) over a registry of the chain's
  // own RPC and three measured public fallbacks (lib/chain/endpoints.ts): the reach probe that tells the RPC's unreadable
  // 429 from a name that does not resolve, the quiet probe that brings the calls back, each fallback's chain id check,
  // its budget and rest, its windows of logs; and the wallet scan finds its ids in DominoSetupV1's state when no endpoint
  // reads wide log ranges (functions/_lib/walletPositions.ts operationIds). Both the chain code and the worker carry the
  // router (a classic worker cannot load it later). Made smaller first: one table for the state reads, one reading of an
  // error's words (owned.ts classifyRpcError, already in both), the test hooks the router's own records, bare Infinity,
  // short refusals: 10,744 -> 9,960 B minified. Measured on Windows, gzip level 9, both builds from this tree and from
  // 0e0a5193: chain code 14,150 -> 17,968 B and fees worker 21,131 -> 24,636 B in both builds; financial, all lazy and
  // session/public reads move by a few bytes only, with the chunks' hashed names (dist 178,010 -> 177,995 B, 199,167 ->
  // 199,147 B, 63,987 -> 63,980 B; .wallet-test-dist 179,288 -> 179,290 B, 200,635 -> 200,633 B, 64,543 -> 64,539 B):
  // the router is in neither. The chain code and fees worker ceilings move by the minimum at 0.1 kB: 18.0 kB (32 B over
  // both builds) and 24.7 kB (64 B); the financial, all lazy and 90 kB session/read ceilings are unchanged.
  // 2026-09-28, fix/rpc-fallback after its review: a blip is not an outage (the chain's RPC is left alone 20 s at first,
  // doubled at each probe it does not answer, and a call only it serves probes it at once, at most every 15 s), and a
  // fallback that fails its chain-id check, or answers anything but JSON-RPC with a 2xx, is left alone (doubled at each
  // time in a row) while the call goes to the next. Made smaller first: the router takes owned.ts's hex, its chain-id
  // and log-window bodies spread the call, its abort reason check is one test, and its 2xx and 429 replies carry no
  // status text. Measured on Windows, gzip level 9, both builds from this tree and from 9847335c: chain code 17,968 ->
  // 18,085 B and fees worker 24,636 -> 24,761 B in both builds; financial, all lazy and session/public reads move by a
  // few bytes only, with the chunks' hashed names (dist 177,995 -> 177,996 B, 199,147 -> 199,148 B, 63,980 -> 63,981 B;
  // .wallet-test-dist 179,290 -> 179,299 B, 200,633 -> 200,647 B, 64,539 -> 64,539 B): the router is in neither. The
  // chain code and fees worker ceilings move by the minimum at 0.1 kB: 18.1 kB (15 B over both builds) and 24.8 kB
  // (39 B); the financial, all lazy and 90 kB session/read ceilings are unchanged.
  // 2026-09-28, fix/positions-stuck, after its review: a first read the RPC refused is asked again 2 s later twice, then
  // on the owner's ladder (lib/walletPositions.ts; the endless 2 s loop is gone); the list's copy is dated, and past an
  // hour (the Wallet card's WALLET_PRICE_MAX_AGE_MS) its rows show their token amounts only and the band waits
  // (OwnedPositions.tsx, on privateCards.ts readKept, which now tells its check when the entry was kept); and the card's
  // quiet and calm lines stand over the copy too (one note element for both). A variant computing the copy's end time in
  // recall measured 1 B larger. Measured on Windows, gzip level 9, both builds from this tree: dist financial 178,015 B,
  // all lazy 199,282 B, chain code 14,150 B, fees worker 21,131 B; .wallet-test-dist financial 179,282 B, all lazy
  // 200,342 B at d1197112 -> 200,635 B at 0e0a5193 -> 200,736 B. All lazy moves by the minimum at 0.1 kB, to 200.8 kB
  // (64 B over the larger build); the financial (118 B to spare), chain code (50 B), fees worker (269 B) and 90 kB
  // session/read ceilings are unchanged.
  // 2026-09-28, fix/vivo-release (fix/rpc-fallback, then fix/positions-stuck, merged on main bc3f5248 with
  // featured-polish): no ceiling was raised by both branches past their shared 0e0a5193, so each keeps its own: all lazy
  // 200.8 kB (fix/positions-stuck), fees worker 24.8 kB and chain code 18.1 kB (fix/rpc-fallback). Measured on Windows,
  // gzip level 9, clean builds of the merged tree: dist financial 178,040 B, all lazy 199,317 B, session/public reads
  // 64,122 B; .wallet-test-dist financial 179,288 B, all lazy 200,745 B, session/public reads 64,656 B; chain code
  // 18,085 B and fees worker 24,761 B in both. Every ceiling holds (all lazy 55 B to spare, chain code 15 B, fees worker
  // 39 B, financial 112 B), so none moves.
  // 2026-09-28, hotfix/charts (the owner: from that morning, for everyone, a position's Fees earned chart and Your APR
  // often did not show, and it took many reloads): the chain's RPC now refuses an eth_getLogs over more than 10,000,000
  // blocks, or over more than 100,000 when one place of its filter holds several values, and every fees history older
  // than a few hours ended as too_much_history. The relay's log reads (functions/_lib/fees.ts rangeLogs, in the chain code
  // and the worker) ask several events over a wide range as one filter each, in one batch (logsBatch, moved there from
  // feesPath.ts), and the widest range in windows; a pool's Initialize is looked for newest window first; the price
  // path's spans and settlements (feesPath.ts, the worker only) name one value a place over a wide range. The list's APR
  // queue is gone (OwnedPositions.tsx, listApr.ts), and with it the page's quietIn (lib/chain/browser.ts): smaller lazy
  // chunks. Made smaller first: one helper for the events a read asks (eachEvent, topicOf0), windows by recursion, the
  // settlements' own windows left to the range split. Measured on Windows, gzip level 9, both builds from this tree
  // (dist and wallet-test mode alike): chain code 18,085 -> 18,172 B, fees worker 24,761 -> 25,036 B. The chain code and
  // fees worker ceilings move by the minimum at 0.1 kB: 18.2 kB (28 B over both builds) and 25.1 kB (64 B); the
  // financial, all lazy and 90 kB session/read ceilings are unchanged.
  // 2026-09-28, speed/wave-a-release (speed wave A: speed/reads, speed/newpos and speed/boot, each on featured-polish
  // aaae6242, merged in that order on production 852a4140, hotfix/charts over the Vivo release): none of the three moved
  // a ceiling, so the merged values are measured against production's. Measured on Windows, gzip level 9, clean builds
  // of the merged tree: dist session/public reads 62,795 B, financial 177,988 B, all lazy 197,976 B; .wallet-test-dist
  // session/public reads 63,326 B, financial 179,233 B, all lazy 199,395 B; chain code 18,172 B and fees worker 25,036 B
  // in both. Every ceiling holds (financial 167 B to spare, all lazy 1,405 B, fees worker 64 B, chain code 28 B), so
  // none moves: the 0.1 kB minimum applies only to a ceiling a build passes.
  // 2026-09-28, hotfix/charts after its review (d478979d's quiet after a heavy reply had made every ordinary reply look
  // heavy once the router had answered a call itself, and a position page's run then ran out of its time, which was
  // final for the visit): the fees lane's quickest reply is the chain's own RPC's only, and a heavy one is one answered
  // while the calls go to that RPC (lib/chain/browser.ts chainLane); a position page's run stopped by its time alone is
  // told to the store as one that could not reach the chain, asked again on RETRY_MS (lib/fees/pipeline.ts outOfTime,
  // feesReplay.worker.ts). Tried smaller first, not taken: one closure for the lane's looks at the router (7 B larger),
  // the result changed in place (1 B smaller). Measured on Windows, gzip level 9, both builds from this tree (dist and
  // wallet-test mode alike): fees worker 25,082 -> 25,132 B (outOfTime 41 B of it); chain code 18,172 B unchanged. The
  // fees worker ceiling moves by the minimum at 0.1 kB, to 25.2 kB (68 B over both builds); the financial, all lazy,
  // chain code and 90 kB session/read ceilings are unchanged.
  // 2026-09-28, feat/eip7702 (the owner: when a wallet can batch, Review must show fewer wallet steps; the audit of the
  // batch path): finance/batch.ts reads wallet_getCapabilities under any key that names 4663 and under 0x0, and asks
  // again without the chain filter after -32602 (atomicStatusOf); the nonce journal keeps a batch latch's claim time and
  // frees a latch whose batch can no longer execute (finance/nonce.ts expireBatch, setup.ts offeredBatch); Create
  // position publishes what the wallet can batch for Review's list (lib/create/createProgress.ts). Chunk by chunk in
  // .wallet-test-dist: the shared setup chunk +391 B, DepositAmounts +55 B, the rest a few bytes each with the hashed
  // names. Made smaller first: a variant with no status ranking and one branch less in expireBatch measured 3 B smaller
  // over the closure, inside the names' noise, and was not kept. Measured on Windows, gzip level 9, clean builds of this
  // tree and of production b10cf6bc: dist financial 177,988 -> 178,439 B, all lazy 197,976 -> 198,424 B, session/public
  // reads 62,795 -> 62,792 B; .wallet-test-dist financial 179,233 -> 179,713 B, all lazy 199,395 -> 199,888 B,
  // session/public reads 63,326 -> 63,348 B; chain code 18,172 B and fees worker 25,036 B unchanged in both. The
  // financial ceiling moves by the minimum at 0.1 kB, to 179.8 kB (87 B over the larger build); the all lazy (912 B to
  // spare), fees worker, chain code and 90 kB session/read ceilings are unchanged.
  // 2026-09-29, release/combo (the lane-pace hotfix 6c493de0 with release/rc2 and feat/eip7702 merged): measured on
  // Windows, gzip level 9, clean builds of the merged tree: dist session/public reads 62,793 B, financial 178,448 B, all
  // lazy 198,435 B; .wallet-test-dist session/public reads 63,349 B, financial 179,745 B, all lazy 199,920 B; fees worker
  // 25,132 B and chain code 18,172 B in both. Every ceiling holds (financial 55 B to spare, all lazy 880 B, fees worker
  // 68 B, chain code 28 B), so none moves: the 0.1 kB minimum applies only to a ceiling a build passes.
  // 2026-09-28, speed wave B (speed/rpc: the front-end speed fixes of the positions study, items 14-26, 37, 39 and 43):
  // the fees lane's work measured to a reply's headers against the visitor's own round trip, its quiet capped, a staged
  // rest after a refusal, the page's light reads no longer holding the lanes 2 s after they end, a lane asking who reads
  // (lib/chain/browser.ts); the head a scan learned told to the router and the relay (failover.ts learn, fees.ts
  // knownHead); the wallet's first call one aggregate3 at 'latest' with its nonce, each position's feature in the list's
  // and the state's own calls, the receipts' tokens in one read (functions/_lib/walletPositions.ts, fees.ts,
  // automation.ts); the page's memory of a wallet's answer and its first read shared (lib/walletPositions.ts); a
  // position's page drawn from its row, its read handed to the fees store, its vault read beside its chart
  // (PositionDetail.tsx, lib/fees/store.ts, lib/automationImpact.ts); Receipts named from the chain (Execution.tsx);
  // lazy screens drawn as soon as their chunk is in (components/Deferred.tsx). Measured on its own base 93586d3b (before
  // the hotfix and wave A): chain code 18,085 -> 18,767 B, fees worker 24,761 -> 25,029 B, .wallet-test-dist financial
  // 179,288 -> 179,866 B, all lazy 200,745 -> 201,664 B.
  // 2026-09-28, speed/wave-b-release (speed wave B merged on production's speed-wave-a 7368b077: the hotfix wins where
  // wave B touched the list's APR, so its queue's states read together, its staged wait and the page's quietIn stay
  // gone; the wallet scan's SetupMinted walk is asked in windows of LOG_BLOCKS_ONE). Measured on Windows, gzip level 9,
  // clean builds of the merged tree: dist session/public reads 63,448 B, financial 178,579 B, all lazy 198,834 B;
  // .wallet-test-dist session/public reads 63,991 B, financial 179,847 B, all lazy 200,282 B; chain code 18,765 B and
  // fees worker 25,293 B in both. Three ceilings a build passes move by the minimum at 0.1 kB: financial 179.9 kB (53 B
  // over the larger build), fees worker 25.3 kB (7 B), chain code 18.8 kB (35 B); all lazy (518 B to spare) and the
  // 90 kB session/read ceiling are unchanged.
  // 2026-09-29, speed/wave-b-release with hotfix/charts (d478979d, a58e33de) merged at its live check: after a cold log
  // scan the fees lane is quiet heavyQuietMs (or its work times workFactor, uncapped), where the wave's quiet alone was
  // at most a second and drew the RPC's refusal; the lane's round trip is learned from the chain's own RPC's replies
  // only; the first staged rest is 6 s; a position page's run out of time is asked again (lib/chain/browser.ts,
  // lib/fees/pipeline.ts outOfTime, feesReplay.worker.ts). Measured on Windows, gzip level 9, clean builds of the merged
  // tree: dist session/public reads 63,448 B, financial 178,588 B, all lazy 198,844 B; .wallet-test-dist session/public
  // reads 63,981 B, financial 179,809 B, all lazy 200,240 B; fees worker 25,405 B and chain code 18,770 B in both. Only
  // the fees worker passes its ceiling: it moves by the minimum at 0.1 kB, to 25.5 kB (95 B to spare); financial (91 B),
  // all lazy (560 B), chain code (30 B) and the 90 kB session/read ceiling are unchanged.
  // 2026-09-28, feat/one-sided (the owner: one way round for every pool price, "1 MANY = 0.0025 USDG", and a range beside
  // today's price that takes one token alone, with no swap): Create position asks the mint as the deposit holds it before
  // any swap (a one-sided band, lib/create/mintPlan.ts), names the one token it deposits, and stops rather than swap
  // when the price moved into the range; the journey moves the amount to the token a range takes. Measured on Windows,
  // gzip level 9, clean builds from this tree on speed-wave-a b10cf6bc: dist financial 177,988 -> 178,134 B,
  // .wallet-test-dist financial 179,233 -> 179,403 B; all lazy 198,164 B and 199,614 B, session/public reads 62,874 B
  // and 63,415 B, chain code 18,172 B and fees worker 25,036 B in both. The financial ceiling moves by the minimum at
  // 0.1 kB, to 179.5 kB (97 B over the larger build); the all lazy (1,186 B to spare), fees worker, chain code and
  // 90 kB session/read ceilings are unchanged.
  // 2026-09-29, release/final (production's release-combo 0fccaf9b with main 54508a04, speed/wave-b-release 31a7ba9e and
  // feat/one-sided ea426d87 merged in that order): each branch's own growth, added together, is what the merged tree
  // measures (financial: release-combo's 179,745 B + wave B's 576 B + one-sided's 170 B = 180,491 B expected in
  // .wallet-test-dist, 180,450 B measured). Measured on Windows, gzip level 9, clean builds of the merged tree: dist
  // session/public reads 63,540 B, financial 179,202 B, all lazy 199,512 B; .wallet-test-dist session/public reads
  // 64,068 B, financial 180,450 B, all lazy 200,926 B; fees worker 25,405 B and chain code 18,770 B in both. Two ceilings
  // a build passes move by the minimum at 0.1 kB: financial 180.5 kB (50 B over the larger build) and all lazy 201.0 kB
  // (74 B); the fees worker (95 B to spare), chain code (30 B) and 90 kB session/read ceilings are unchanged.
  // 2026-09-29, preview recovery/history package: bounded list APR prefetch, saved public history and readiness
  // instrumentation add ~1.5 kB to the lazy closure; safe replay checkpoint resumption/run correlation add 986 B to
  // the worker, and RPC fallback/shared cooldown recovery adds 722 B to chain code. Clean Windows builds, gzip 9,
  // after equivalent listener/validation deduplication and absolute retry deadline recovery: dist session/read
  // 65,145 B, financial 179,256 B, all lazy 201,093 B; wallet-test 65,702 / 180,532 / 202,561 B.
  // Worker 26,391 B and chain code 19,492 B in both. The baseline
  // above is the previously recorded release/final measurement, not a new benchmark. Admit these reviewed features
  // with bounded ceilings of 203 kB lazy, 27 kB worker and 20 kB chain; keep the 90 kB session/read limit unchanged.
  // The wallet recovery deadline adds about 0.1 kB to shared session code; allow 180.7 kB for financial closures
  // (168 B headroom in wallet-test), not an exemption. Every generated script remains classified and measured.
  // 2026-09-29, claude/swap-route (onboarding-v1 1.1.0, the owner: New position's assisted swap routed through Uniswap
  // when that returns more than 0.5% above the pool): the onboarding runtime New position's SwapQuote already loads
  // (onboarding/contract.ts) carries every route's schemas, now swap-route's too, which New position is to call. No app
  // code changed. Measured on macOS, gzip level 9, both builds from this tree against 40c8d59: dist financial 177,584 ->
  // 179,670 B, all lazy 197,568 -> 199,665 B; .wallet-test-dist financial 178,863 -> 180,961 B, all lazy 199,034 ->
  // 201,129 B, about +2.1 kB each. This machine measures 398-404 B less than CI (40c8d59 in run 36637875233: dist
  // financial 177,985 B, all lazy 197,972 B; .wallet-test-dist financial 179,262 B, all lazy 199,432 B), so CI should
  // see about 181,360 B financial and 201,527 B all lazy in the larger build. Each moves to the 0.1 kB above that with
  // room for the estimate: financial 181.5 kB, all lazy 201.7 kB; the fees worker, chain code and 90 kB session/read
  // ceilings are unchanged.
  // 2026-09-29, main integration: combine the reviewed recovery package with onboarding-v1 1.1.0 already on main.
  // Clean Windows builds, gzip 9: dist session/read 65,127 B, financial 181,302 B, all lazy 203,122 B;
  // wallet-test 65,697 / 182,608 / 204,633 B. Relative to approved b3a10f70, the new onboarding schemas add
  // 2,049 / 2,043 B to dist financial / all lazy and 2,042 / 2,034 B to wallet-test. This is the additive cost
  // recorded by claude/swap-route above, not a regression in replay/cache work. Preserve all classifications and
  // 90 kB public, 27 kB worker, 20 kB chain bounds; combined financial / lazy bounds are 182.7 / 204.8 kB.
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
    // 2026-09-24 (P6, DESIGN-V2 §18, R-12): the fees replay worker (src/lib/fees/feesReplay.worker.ts, created only by
    // src/lib/fees/spawn.ts on a positions page) is its own closure with its own 16,000 B ceiling, outside all lazy: it is
    // not UI and loads only where a fees history is shown. A classic worker is one self-contained file: no import, no
    // export. It is emitted only once a screen uses the fees hooks (none may on a branch where no screen does yet).
    // Measured with a temporary opener on 2026-09-24: 16,419 B raw, 7,100 B gzip.
    const worker = new Set(js.filter((file) => /^feesReplay\.worker-/.test(file)));
    assert.ok(worker.size <= 1, `one fees worker at most: ${[...worker].join(', ')}`);
    for (const file of worker) {
      assert.ok(!initial.has(file) && !allLazy.has(file), 'the worker is loaded by new Worker(), never imported');
      assert.ok(moduleTree(dir, file).program.body.every((node) => !['ImportDeclaration', 'ExportNamedDeclaration', 'ExportAllDeclaration', 'ExportDefaultDeclaration'].includes(node.type)), 'a classic worker: one file');
    }
    // 2026-09-25: the chain code the page runs (see above): one chunk, reached only by dynamic import, never in the entry.
    const chainRoots = js.filter((file) => /^chainCode-/.test(file));
    assert.equal(chainRoots.length, 1, `one chain code chunk: ${chainRoots.join(', ')}`);
    const chain = new Set([...staticClosure(dir, chainRoots)].filter((file) => !initial.has(file)));
    for (const file of chainRoots) assert.ok(!initial.has(file) && !allLazy.has(file), 'the chain code is loaded when a page reads the chain, never statically');
    assert.deepEqual([...new Set([...initial, ...allLazy, ...worker, ...chain])].sort(), js, 'every generated script belongs to a measured closure');
    for (const [family, files, budget] of [['session/public reads', base, 90_000], ['financial', financial, 182_700], ['all lazy', allLazy, 204_800], ['fees worker', worker, 27_000], ['chain code', chain, 20_000]]) {
      const total = [...files].reduce((sum, file) => sum + gzip(join(dir, 'assets', file)), 0);
      // The headroom is a diagnostic only, so the margin stays visible in every run; only the budget itself fails the test.
      t.diagnostic(`${label} ${family}: ${total} bytes gzip (${files.size} scripts; ${budget} budget; ${budget - total} bytes, ${((100 * (budget - total)) / budget).toFixed(1)}% headroom)`);
      assert.ok(total <= budget, `${label} ${family} is ${total} bytes gzip, over the ${budget} budget`);
    }
  }
});
