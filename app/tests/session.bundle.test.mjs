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
 *
 * Changed on purpose 2026-10-01 (audit C3, the owner's OK): the deployed build
 * carries WalletConnect's own client (@walletconnect/sign-client) for a wallet
 * on a phone, in one chunk of its own that only the wallet island opens, by a
 * dynamic import, when the person picks WalletConnect. It is the one place a
 * relay may be named, and it is measured as its own family. The wallet-test
 * build carries a stand-in for it instead (src/wallet/walletConnectFake.ts).
 */
import assert from 'node:assert/strict';
import { parse } from '@babel/parser';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { test } from 'node:test';
import { gzipSync } from 'node:zlib';
import { createRequire } from 'node:module';
import { CONSTANTS as PLAN } from '../../api-contracts/position-plan-v1/schema-data.mjs';
import { CONSTANTS as READ_V6 } from '../../api-contracts/read-v6/schema-data.mjs';
import { elysiumSwitch, planNames, readV6Names } from '../scripts/elysium-switch.mjs';

const APP = resolve(import.meta.dirname, '..');
const DIST = join(APP, 'dist');
const WALLET = join(APP, '.wallet-test-dist');
const WALLET_V2 = join(APP, '.wallet-test-v2-dist');

for (const dir of [DIST, WALLET, WALLET_V2]) {
  if (!existsSync(join(dir, 'index.html'))) throw new Error(`${dir} is missing. Run npm run build, npm run build:wallet-test and npm run build:wallet-test-v2 first.`);
}

/**
 * The hosts WalletConnect's client names in its chunk, exactly (a new one in an upgrade is reviewed here first). Only
 * relay.walletconnect.org (its wss relay) and verify.walletconnect.org (the Verify API's frame) are in the page's CSP;
 * the rest are wallet-side services (echo, the .com verify), its RPC and telemetry the page never uses (reads go to the
 * chain's RPC, telemetry is off), and documentation or Telegram links in its error messages.
 */
const WALLETCONNECT_HOSTS = ['echo.walletconnect.com', 'oxlib.sh', 'pulse.walletconnect.org', 'rpc.walletconnect.org', 't.me', 'verify.walletconnect.com', 'verify.walletconnect.org'];
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
 * The entry is whichever script index.html loads as its module script, not
 * whichever is named index-*: a lazy chunk gets that name too when the module
 * opening it is called index.ts, which is how the read screens' chunk is named.
 * Changed on purpose 2026-10-01 (platform workstream, F1/F4): the page also names
 * the entry's two stable chunks (modulepreload links) and every route's files
 * (the boot script's table), so only the module script's src counts.
 */
function shape(dir) {
  const js = scripts(dir);
  const html = readFileSync(join(dir, 'index.html'), 'utf8');
  const entry = [...html.matchAll(/<script\b[^>]*\btype="module"[^>]*\bsrc="\/assets\/([^"]+)"/g)].map((match) => match[1]);
  const island = js.filter((file) => file.startsWith('WalletSessionIsland-'));
  return { js, entry, island };
}

test('the deployed build carries wallet sign-in and the positions collection as lazy chunks beside one entry', () => {
  const { js, entry, island } = shape(DIST);
  assert.equal(entry.length, 1, js.join(', '));
  assert.equal(island.length, 1, js.join(', '));
  // The read screens and the shared read source are lazy chunks of their own,
  // so a visitor who opens neither the figures nor the position lookup never
  // downloads them. What must not appear is a second entry or a second island.
  // Collection styles load with OwnedRows; transfer illustrations with the deferred funding services.
  // Neither stylesheet is linked by the initial document (checked below).
  // Changed on purpose 2026-11-07 (the owner's Points page, Season 1): the Points page's own styles (styles/v4-points.css)
  // come with its chunk alone, so the page's look costs no other screen anything.
  const css = assets(DIST).filter((file) => file.endsWith('.css'));
  assert.deepEqual(css.map((file) => file.split('-')[0]).sort(), ['OwnedRows', 'Points', 'index', 'screens', 'services'], css.join(', '));
  const collection = js.find((file) => file.startsWith('OwnedRows-'));
  assert.ok(collection && !staticClosure(DIST, entry).has(collection), 'the collection stays outside the entry static closure');
  const html = readFileSync(join(DIST, 'index.html'), 'utf8');
  assert.deepEqual([...html.matchAll(/<link rel="stylesheet"[^>]*href="\/assets\/([^"]+)"/g)].map((match) => match[1]), css.filter((file) => file.startsWith('index-')), 'the page links the site’s stylesheet alone');
  // F4: React and the read contracts' runtimes are chunks of their own the page loads beside the entry, and nothing else is.
  assert.deepEqual([...html.matchAll(/<link rel="modulepreload"[^>]*href="\/assets\/([^"]+)"/g)].map((match) => match[1].replace(/-[\w-]{8}\.js$/, '')).sort(), ['read-contracts', 'vendor-react']);
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
  // 2026-10-01 (audit C3): WalletConnect's client is a chunk of its own, opened only by the island's dynamic import.
  const walletConnect = scripts(DIST).filter((file) => file.startsWith('walletConnectProvider-'));
  assert.equal(walletConnect.length, 1, scripts(DIST).join(', '));
  assert.ok(!initial.has(walletConnect[0]) && !staticClosure(DIST, island).has(walletConnect[0]), 'never loaded with the page or the wallet island');
  for (const needle of ['relay.walletconnect', 'verify.walletconnect']) {
    assert.ok(!entryText.includes(needle) && !islandText.includes(needle), `${needle} stays in WalletConnect's own chunk`);
  }
  assert.ok([...staticClosure(DIST, island)].some((file) => [...nodes(moduleTree(DIST, file))].some((node) => node.type === 'ImportExpression' && node.source.value === `./${walletConnect[0]}`)), 'the island opens it through a dynamic import');
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
// (its official RPC), for reads only, by the page's own chain reads (src/lib/chain/browser.ts): the RPC
// answers 429 to every call from Cloudflare's edge, so the site's routes that read it for the page failed. Wallet
// calls still go through the wallet's own provider only; no connector SDK or relay is reached.
// Changed on purpose 2026-10-01 (RPC-SPEC, the owner's rule: nothing is read from a public RPC): no public RPC endpoint
// is reached any more. The chain's official RPC is only named, for the wallet's "add network" and the docs' network
// details; its three public fallbacks are named nowhere (see allowedHosts), and neither CSP names a chain RPC.
test('no connector SDK or relay, and no public RPC endpoint reached; the chain\u2019s official RPC only named for the wallet, either build', () => {
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
  // 2026-09-25: Robinhood Chain's public RPC, which the page read the chain from itself until 2026-10-01. Changed on
  // purpose 2026-10-01 (RPC-SPEC §7.5): only named now, never fetched: the wallet is handed it when it adds the network
  // (src/wallet/chain.ts) and the docs give it for adding the network by hand; no CSP directive names it.
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
    // 2026-09-28 to 2026-10-01: the chain's three public fallbacks were admitted here. Gone with the public RPC (RPC-SPEC):
    // a build that named one would fail this check, and the deployable build's own marker check (scripts/deploy-markers.mjs).
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
    // 2026-11-08 (owner): Domino's public source (src/lib/sourceRepo.ts), linked from the footer beside X and from the
    // docs' Contracts page. A navigation target in a new tab, never fetched, so no CSP directive names it either.
    'github.com',
  ]);
  // 2026-10-01 (audit C4, C1): the wallet dialog's fixed links, navigation targets in a phone's wallet app or a new
  // tab, never fetched (no CSP directive names them): MetaMask's, Coinbase Wallet's and Trust Wallet's documented links
  // that open domino.money in their own browsers, and where to get MetaMask or Rabby. And the explorer the wallet is
  // handed with Robinhood Chain's details when it adds the network (src/wallet/chain.ts), never fetched by the page.
  for (const host of ['metamask.app.link', 'go.cb-w.com', 'link.trustwallet.com', 'metamask.io', 'rabby.io', 'robinhoodchain.blockscout.com']) allowedHosts.add(host);
  // 2026-10-01 (the chain2 workstream, part B): the site's own origins, which the second chain's section compares the
  // page's location with to know whether it is open (src/chains/elysium/mode.ts: the site, the preview alias, the local
  // development server); never fetched, and no CSP directive names them.
  for (const host of ['domino.money', 'preview.domino-app-e65.pages.dev', 'localhost']) allowedHosts.add(host);
  // 2026-11-07 (the owner: Domino in Google, functions/_lib/seo.ts): the page's head names its canonical address and its
  // shared picture on domino.money (admitted above), Home's structured data its vocabulary (schema.org) and sitemap.xml its
  // namespace (www.sitemaps.org): identifiers search engines read, never fetched by the page; no CSP directive names them.
  for (const host of ['schema.org', 'www.sitemaps.org']) allowedHosts.add(host);
  // Changed on purpose 2026-10-04 (the owner: the site runs on Domino V2, so the deployed build carries it): the V2
  // explorers' links (src/v2/explorers.ts), navigation targets in a new tab; the citations of the V2 chain profiles
  // (api-contracts/v2/chains/*.json `sources`: where each address was checked), data never rendered as a link; ox's
  // documentation origin in its errors' messages (as viem.sh above); and viem's ENS avatar gateways, defaults inside its
  // actions (the app resolves no ENS name). None is ever fetched: no CSP directive names any of them (checked below).
  for (const host of [
    'basescan.org', 'arbiscan.io', 'robin.etherscan.io',
    'developers.uniswap.org', 'github.com', 'docs.chain.link', 'docs.robinhood.com', 'reference-data-directory.vercel.app', 'developers.circle.com', 'docs.base.org', 'docs.arbitrum.io',
    'oxlib.sh', 'ipfs.io', 'arweave.net',
  ]) allowedHosts.add(host);
  // Changed on purpose 2026-11-09 (Elysium's day 9): the citations of Elysium's mainnet profile
  // (api-contracts/v2/chains/elysium-99901.json `sources`: Kinetiq's docs pages and Ascend's), data never rendered as a
  // link, in whichever chunk parses the profile; never fetched, and no CSP directive names either (checked below). The
  // first is also Elysium's explorer since checklist step 5 (src/lib/elysiumIdentity.ts ELYSIUM_EXPLORER): a link for a
  // person's own click, as basescan.org's and arbiscan.io's are, never fetched.
  for (const host of ['elysium.kinetiq.xyz', 'ascendlaunch.gitbook.io']) allowedHosts.add(host);
  // And the second chain's public RPC and explorer, in the section's own files only (the 'elysium section' family): the
  // RPC is named in the preview's page CSP alone (functions/_middleware.ts APP_CSP_CHAIN2), never in production's, so
  // production's page cannot reach it; the explorer is a link, never fetched. Reads only, through the section's one
  // network call (src/chains/elysium/transport.ts, pinned in tests/read.test.mjs).
  const ELYSIUM_HOSTS = ['testnet-rpc.elysium.kinetiq.xyz', 'elysium.kinetiq.xyz'];
  // Exactly those, and only where the deployed CSP admits the two that are ever contacted. Changed on purpose 2026-10-01
  // (platform workstream): the CSPs are data (functions/_middleware.ts APP_CSP_SOURCES), so the headers they make are
  // checked, from the compiled middleware.
  const middleware = createRequire(import.meta.url)('../.test-build/app/functions/_middleware.js');
  const { APP_CSP } = middleware;
  const directive = (name) => APP_CSP.split('; ').find((part) => part.startsWith(`${name} `));
  assert.equal(directive('img-src'), "img-src 'self' data: https://cdn.dexscreener.com", 'the CSP names the artwork CDN');
  // 2026-09-25 to 2026-10-01: and the chain's RPC (2026-09-28: and its three public fallbacks), for the page and for the
  // fees worker. Changed on purpose 2026-10-01 (RPC-SPEC \u00a77.4): no chain RPC in either; the worker reaches the site alone.
  // 2026-10-01 (audit C3): and, for the page, WalletConnect's relay, with the page's own sources
  // (src/lib/chain/csp.ts PAGE_CONNECT_BASE), and its Verify API's frame: no other WalletConnect host.
  assert.equal(directive('connect-src'), "connect-src 'self' https://api.dexscreener.com wss://relay.walletconnect.org", 'the page\u2019s CSP names the artwork metadata endpoint and WalletConnect\u2019s relay, and no chain RPC');
  assert.equal(directive('frame-src'), 'frame-src https://verify.walletconnect.org', 'and WalletConnect\u2019s Verify API frame, no other WalletConnect host');
  // Changed on purpose 2026-10-02 (RPC-SPEC \u00a711.4): the fees worker is gone with the replay, and its CSP with it.
  assert.equal(middleware.WORKER_CSP, undefined, 'no fees worker, no worker CSP');
  assert.doesNotMatch(APP_CSP, /uniswap\.org/, 'the catalogue citation and the swap provenance label are never destinations');
  for (const [label, dir] of [
    ['dist', DIST],
    ['.wallet-test-dist', WALLET],
    ['.wallet-test-v2-dist', WALLET_V2],
  ]) {
    // 2026-10-01 (audit C3): WalletConnect's own chunk, and only it, names its relay and its hosts (the chunk's own
    // allowance below); the CSP lets the page reach exactly two of them, the relay and the Verify API's frame.
    const walletConnect = new Set(scripts(dir).filter((file) => file.startsWith('walletConnectProvider-')).map((file) => `assets${'/'}${file}`));
    assert.equal(walletConnect.size, dir === DIST ? 1 : 0, `${label}: WalletConnect's client ships in the deployed build only (the wallet-test build carries its stand-in)`);
    // 2026-10-01 (the chain2 workstream, part B): the second chain's section's own files (its chunk and what only it
    // loads), the one place its hosts may be named.
    const initial = staticClosure(dir, shape(dir).entry);
    const elysiumFiles = new Set([...staticClosure(dir, scripts(dir).filter((file) => file.startsWith('ElysiumEntry-')))].filter((file) => !initial.has(file)).map((file) => `assets${'/'}${file}`));
    assert.ok(elysiumFiles.size >= 1, `${label}: the second chain's section is a chunk of its own`);
    for (const { file, text } of textFiles(dir)) {
      const name = file.replaceAll('\\', '/');
      if (walletConnect.has(name)) {
        const hosts = [...new Set([...text.matchAll(/https?:\/\/([a-z0-9.-]+)/gi)].map((match) => match[1].toLowerCase()))].sort();
        assert.deepEqual(hosts, WALLETCONNECT_HOSTS, `${label}/${file}: the hosts WalletConnect's client names`);
        assert.deepEqual([...new Set([...text.matchAll(/wss:\/\/([a-z0-9.-]+)/gi)].map((match) => match[1]))], ['relay.walletconnect.org']);
        continue;
      }
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
        // Changed on purpose 2026-10-04 (V2 in the deployed build): viem's other ABI errors (an event's or an error's signature
        // not found, ContractFunctionRevertedError) give the same lookup link in their own messages; those exact templates
        // are admitted too, and any other use of the host still fails.
        endpointText = endpointText.replace(/`You can look up the (?:decoded )?signature here: https:\/\/4byte\.sourcify\.dev\/\?q=\$\{[A-Za-z_$][\w$]*\}\.`/g, 'signature lookup documentation');
      }
      const hosts = new Set([...endpointText.matchAll(/https?:\/\/([a-z0-9.-]+)/gi)].map((match) => match[1].toLowerCase()));
      for (const host of hosts) assert.ok(allowedHosts.has(host) || (ELYSIUM_HOSTS.includes(host) && elysiumFiles.has(name)) || file.endsWith('.css'), `${label}/${file} names ${host}`);
      // The citation is the catalogue's source path, with the pool id interpolated into it, and nothing else.
      const citations = [...text.matchAll(/https:\/\/app\.uniswap\.org[^"'`\s]*/g)].map((match) => match[0]);
      for (const url of citations) assert.match(url, /^https:\/\/app\.uniswap\.org\/explore\/pools\/robinhood\/(?:\$\{[A-Za-z_$][\w$]*\}|0x[0-9a-f]{64})?$/, `${label}/${file} names app.uniswap.org for something else`);
    }
  }
});

test('the lockfile holds no optional connector SDK but WalletConnect\u2019s own client', () => {
  const lock = JSON.parse(readFileSync(join(APP, 'package-lock.json'), 'utf8'));
  const packages = Object.keys(lock.packages);
  const sdks = packages.filter((name) =>
    /node_modules\/(@coinbase|@metamask|@base-org|@safe-global|@reown|porto|accounts)(\/|$)/.test(name),
  );
  assert.deepEqual(sdks, []);
  // Changed on purpose 2026-10-01 (audit C3, the owner's OK): @walletconnect/sign-client, pinned, and what it needs; no
  // modal (AppKit is @reown's, refused above) and no wagmi connector package.
  assert.equal(JSON.parse(readFileSync(join(APP, 'package.json'), 'utf8')).dependencies['@walletconnect/sign-client'], '2.25.0');
  const walletConnect = packages.filter((name) => /node_modules\/@walletconnect\//.test(name)).map((name) => name.replace(/^.*node_modules\//, ''));
  assert.ok(walletConnect.includes('@walletconnect/sign-client'));
  assert.ok(!walletConnect.some((name) => /ethereum-provider|universal-provider|modal|appkit/.test(name)), walletConnect.join(', '));
});

/**
 * Whether the repository turns Elysium on for these builds (the release build's own switch; the usual test builds read
 * the repository the same way), and what its rows, profile and pinned record may add then (the 2026-11-07 note below).
 */
const ELYSIUM_SWITCH = elysiumSwitch({ row: { testHooks: false, deployable: true, site: true }, appRoot: APP });
const ELYSIUM_LIVE = ELYSIUM_SWITCH.live;
const ELYSIUM_ALLOWANCE = Object.freeze({ 'domino v2': 8_500, 'pool history chart': 500 });
/** The forced live test build (npm run build:wallet-test-v2-elysium), where it was built. */
const WALLET_V2_ELYSIUM = join(APP, '.wallet-test-v2-dist-elysium');
/** A dist's first script, the one index.html loads (the initial entry). */
const entryOf = (dir) => {
  const match = /<script type="module" crossorigin src="\/assets\/([^"]+\.js)"/.exec(readFileSync(join(dir, 'index.html'), 'utf8'));
  assert.ok(match, `${basename(dir)}/index.html loads one entry`);
  return `assets/${match[1]}`;
};

// Added 2026-11-07 (ely/money: Elysium as a fourth V2 chain, switched on by itself): while the repository leaves Elysium
// off (today), the release build and the usual test builds hold nothing of chain 99901: no id, no profile, no record, no
// fixture, no slug, no WalletConnect chain; every Elysium branch folded away by the build's switch. The day it is live,
// the forced build's own suites hold what it carries (tests/v2/elysium-chain.test.mjs and the browser suites).
// Changed on purpose 2026-11-07 (day-9 rehearsal, finding F4): on a partial Monday (rugged97's read-v6 or position-plan
// naming 99901 while Elysium is still off), the build bundles his package data as it is, and it names the chain: read-v6's
// chain list, enums and price profile, position-plan-v1's row (named `elysium-99901`). Those traces are then allowed in
// the chunks that carry that data (its `priceProfiles` or `l1DataFeeSource` constants) and nowhere else; every other trace
// stays forbidden in every file, so nothing of the app's Elysium is ever there while it is off.
// Changed on purpose 2026-11-07 (Elysium's pre-launch, the owner's order: Elysium on the site before its network opens):
// "Elysium before live", by the repository's stage. Before live the builds hold nothing of chain 99901, as before (a
// partial Monday's package data aside, above); in pre-launch they also draw Home's "Open positions on" row with Elysium's
// chip and its tag, in the initial entry alone (never a lazy chunk: the row renders in the hero's first moment), and What
// Domino is's Elysium section, in the docs' chunk alone; off, none of either.
const PACKAGES_NAME = readV6Names(READ_V6.chainIds) || planNames(PLAN.chains);
const PACKAGE_TRACES = PACKAGES_NAME ? ['99901', '0x1863d', ...(planNames(PLAN.chains) ? ['elysium-99901'] : [])] : [];
// Changed on purpose 2026-11-09 (rugged97's bridge PR #488): crosschain-v1's data names 99901 too (Relay's pin and the
// destination enums); its chunk carries that package's `quoteLifetimeSeconds` constant.
const PACKAGE_DATA = /priceProfiles|l1DataFeeSource|quoteLifetimeSeconds/;
test('Elysium before live: the release build and the usual test builds carry no chain 99901 at all, and the pre-launch pieces only where they belong', (t) => {
  if (ELYSIUM_LIVE) return t.skip('the repository turns Elysium on: its id is in these builds');
  const prelaunch = ELYSIUM_SWITCH.stage === 'prelaunch';
  t.diagnostic(`the repository's stage: ${ELYSIUM_SWITCH.stage}`);
  const HOME = ['Open positions on', 'Opens next', 'dm-hero-when'];
  const DOCS = ['the next network on Domino', 'beforeElysiumOpens'];
  for (const dir of [DIST, WALLET, WALLET_V2]) {
    const entry = entryOf(dir);
    const found = new Map([...HOME, ...DOCS, '/chains/elysium.png'].map((trace) => [trace, []]));
    for (const { file, text } of textFiles(dir)) {
      // Changed on purpose 2026-11-07 (review findings E/P9 and P5): the pool step's one-version leads too, which only a
      // live build draws. Home's "Open positions on" row is held below, by the stage: in the entry alone in pre-launch,
      // nowhere when off.
      for (const trace of ['99901', '0x1863d', 'WHYPE', 'elysium-99901', 'Elysium explorer', '|elysium)', 'Elysium (synthetic', 'Pick two tokens and the fee', 'pick its two tokens and the fee']) {
        if (PACKAGE_TRACES.includes(trace) && PACKAGE_DATA.test(text)) continue;
        assert.equal(text.includes(trace), false, `${basename(dir)}/${file} carries ${trace}${PACKAGE_TRACES.includes(trace) ? ' outside the bundled package data of rugged97' : ''}`);
      }
      // The stylesheet holds the tag's rule in every build (CSS has no build switch); the scripts are what draw it.
      if (!file.endsWith('.js')) continue;
      for (const [trace, files] of found) if (text.includes(trace)) files.push(file.replaceAll('\\', '/'));
    }
    const docsChunk = [...found.get('the next network on Domino')];
    for (const trace of HOME) assert.deepEqual(found.get(trace), prelaunch ? [entry] : [], `${basename(dir)}: ${trace}`);
    for (const trace of DOCS) assert.deepEqual(found.get(trace), prelaunch ? docsChunk : [], `${basename(dir)}: ${trace}`);
    if (prelaunch) assert.match(docsChunk.join(), /^assets\/Docs-[\w-]+\.js$/, `${basename(dir)}: the section in the docs' chunk alone`);
    // Elysium's mark: its path is named once, in the entry, in every build (lib/elysiumIdentity.ts ELYSIUM_MARK).
    assert.deepEqual(found.get('/chains/elysium.png'), [entry], `${basename(dir)}: the mark's path`);
  }
});

// Added 2026-11-07 (Elysium's pre-launch): live always wins. The forced live build (built with the repository's
// ELYSIUM_OPENS_ON still written) carries none of the pre-launch pieces.
test('Elysium live wins over pre-launch: the forced live build carries no pre-launch piece', (t) => {
  if (!existsSync(join(WALLET_V2_ELYSIUM, 'index.html'))) return t.skip('the forced live build is not built here (npm run build:wallet-test-v2-elysium)');
  for (const { file, text } of textFiles(WALLET_V2_ELYSIUM)) {
    if (!file.endsWith('.js') && !file.endsWith('.html')) continue;
    for (const trace of ['Opens next', 'Opens Nov', 'the next network on Domino', 'dm-hero-when', 'beforeElysiumOpens', 'It opens on {day}']) {
      assert.equal(text.includes(trace), false, `${basename(WALLET_V2_ELYSIUM)}/${file} carries ${trace}`);
    }
  }
  // Its own row is the live one.
  assert.ok(textFiles(WALLET_V2_ELYSIUM).some(({ file, text }) => file.endsWith('.js') && text.includes('Open positions on')), 'the live row is there');
});

test('what every visitor downloads first, the route screens, the session/read closures and the financial screens each keep a measured budget', (t) => {
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
  // 2026-09-30, owner-authorized routed swap: exact Permit2/Universal Router admission, whole-flow simulation,
  // reviewed quote/session binding and cross-tab recovery are confined to the lazy Create/Setup closures.
  // Final Windows builds, gzip 9, against main 5eb: dist financial 181,302 -> 188,623 B, all lazy 203,122 ->
  // 210,447 B; wallet-test financial 182,608 -> 189,902 B, all lazy 204,633 -> 211,936 B. Production chunk deltas:
  // Create +4,318 B, SDK +2,650 B, words +137 B, shared onboarding extraction +197 B net, remaining imports +19 B.
  // Session/public reads change only 7 B in either build (65,134 / 65,704 B); worker 26,391 B and chain 19,492 B
  // are unchanged. Initial entry review disclosure adds 950 / 922 B, separately from these lazy budgets.
  // Round only the two exceeded ceilings to the next 0.1 kB: financial 190,000 B and all lazy 212,000 B
  // (98 / 64 B above the larger build). Keep all graph classifications and public/worker/chain ceilings intact.
  // 2026-10-01: data recovery stays below every production ceiling (financial 189,428 B, all lazy 211,263 B,
  // chain 19,987 B after removing redundant cancellation/cache fields). Wallet-test also carries PositionLab and
  // session probes, which never ship: measure that overhead separately, capped at 1.5 kB over the SAME production
  // tree. Do not charge that instrumentation to users or raise the production, public-read, worker or chain limits.
  // 2026-10-01, platform workstream (F1, F4, F8, H4): every screen but Home left the entry for a chunk of its own, React
  // and the read contracts' runtimes became two stable chunks beside it, and the screens' styles a stylesheet of their
  // own. Two new families: 'initial entry', what every visitor downloads before anything shows (the entry with the
  // chunks it imports, and the stylesheet the page links), which until now had no budget at all and grew 33% in a week
  // with no test failing; and 'route screens', the six screens' chunks with what they load beside them. Code that every
  // screen shared sat in the entry and counted nowhere; it now sits in shared lazy chunks, which the lazy families'
  // static closures reach, so those measure more for the same code: Rollup puts what only the Positions screen's own
  // chunks use (Collect fees, the held deposits, Performance, Execution) inside the Positions chunk, which those
  // closures then count whole (39 kB), although a visitor reaches them only through Positions, with it already loaded.
  // In the wallet-test build the lab opens them too, so they split differently there. Measured on Windows, gzip
  // level 9, both builds of this tree: initial entry 193,901 /
  // 191,518 B (main f6df054's entry and stylesheet, measured the same way: 305,613 + 57,080 = 362,693 B), route
  // screens 161,528 / 162,380 B, session/public reads 143,769 / 145,285 B, financial 293,371 / 256,024 B, all lazy
  // 324,692 / 327,148 B, fees worker 26,603 B and chain code 19,987 B in both. Every ceiling is set about 5% over the larger build, real headroom for the
  // next change instead of the 13 bytes chain code had left: initial entry 204 kB, route screens 171 kB,
  // session/public reads 153 kB, financial 309 kB, all lazy 344 kB, fees worker 28 kB, chain code 21 kB. The
  // wallet-test allowance becomes 3 kB: its builds split differently since the screens became chunks (+2,456 B on all
  // lazy, -37 kB on financial). A ceiling raised from here is the owner's call, said in the change that raises it.
  // 2026-10-01, the 2026-10 package, integration pass 1 (main aae87563 with pacote/ws-platform, ws-markets, ws-ci and
  // ws-chain2 merged in that order; the owner approved the whole package, and the integrator re-measures and sets every
  // ceiling about 5% over the larger build, rounded up to the next kB). Measured on Windows, gzip level 9, clean builds
  // of the merged tree, dist / .wallet-test-dist: initial entry 203,225 / 200,451 B (platform alone 194,421 B: markets'
  // stand-in figures, DEX Screener figures and a token's pools are Home's, so they ship in the entry), route screens
  // 164,644 / 164,877 B, session/public reads 143,101 / 144,080 B, financial 294,101 / 256,138 B, all lazy 325,486 /
  // 327,370 B, fees worker 26,603 B and chain code 19,962 B in both (chain2's part A is not wired into any build yet).
  // Ceilings: initial entry 214 kB (was 204), route screens 174 kB (was 171), session/public reads 152 kB (was 153),
  // financial 309 kB, all lazy 344 kB, fees worker 28 kB and chain code 21 kB (unchanged). The wallet-test allowance
  // stays 3 kB (its all-lazy overhead measures 1,884 B).
  // 2026-10-01, pacote/ws-wallets (the audit's wallet items C1-C16, D2, H5, the owner's OK): the wallet layer the money
  // screens share with the wallet island (session chunk +3,905 B: the network add and its notices, Cancel and -32002,
  // the legacy window.ethereum wallet, the wallet memory, WalletConnect's connector shell, the isWellFormed fallback),
  // the setup client (+1,225 B: nonce settling, page-failover reads, parallel reads, replaced transactions), Create
  // position (+705 B), the signed-out lines (+478 B new chunk), Automate (+164 B) and the dialog (+1,410 B, all lazy
  // only). Clean Windows builds, gzip 9, against main f6df054e: dist financial 189,428 -> 196,212 B, all lazy
  // 211,263 -> 219,448 B, chain code 19,987 -> 20,114 B (pure reads through the page's line, audit C6); wallet-test
  // financial 196,319 B, all lazy 219,773 B. Session/public reads, which carries the island and that shared layer, is
  // 70,448 B (wallet-test 69,866 B), inside its 90 kB ceiling; the fees worker is unchanged at 26,603 B.
  // WalletConnect's client (@walletconnect/sign-client 2.25.0, pinned, and its QR encoder) is a new family of its own,
  // 130,098 B, loaded only when the person picks WalletConnect (the wallet-test build's stand-in: 4,785 B). Only the
  // exceeded ceilings move, each to the 0.1 kB above the larger build with at least 50 B to spare: financial 196.3 kB
  // (88 B), all lazy 219.5 kB (52 B), chain 20.2 kB (86 B), and WalletConnect 130.2 kB (102 B). The 90 kB
  // session/read and 27 kB worker ceilings are unchanged.
  // 2026-10-01, the 2026-10 package, integration pass 2a (pacote/ws-wallets merged onto pass 1's tree; the integrator
  // re-measures and sets every ceiling about 5% over the larger build, rounded up to the next kB, as in pass 1). The
  // wallets branch measured and set its ceilings on main's layout, before the screens became chunks; these replace them
  // (its named FINANCIAL, ALL_LAZY, CHAIN and WALLETCONNECT constants are gone, every ceiling sits in the list below).
  // Clean Windows builds of the merged tree, gzip level 9, dist / .wallet-test-dist: initial entry 203,764 / 200,766 B
  // (pass 1: 203,225 B), route screens 164,499 / 164,685 B, session/public reads 147,934 / 147,869 B (pass 1: 143,101 B;
  // the wallet layer the island shares with the money screens), financial 300,323 / 261,235 B, all lazy 333,083 /
  // 333,881 B, fees worker 26,603 B and chain code 20,089 B in both, and WalletConnect's client 130,132 B (the
  // wallet-test build's stand-in: 4,785 B). Ceilings: initial entry 214 kB (unchanged), route screens 173 kB (was 174),
  // session/public reads 156 kB (was 152), financial 316 kB (was 309), all lazy 351 kB (was 344), fees worker 28 kB
  // (unchanged), chain code 22 kB (was 21) and WalletConnect 137 kB (new). The wallet-test allowance stays 3 kB (its
  // all-lazy overhead measures 798 B).
  // Changed on purpose (2026-10-01, the fees workstream, C:/dwt/pacote/fees): the worker reads a position's history at
  // chosen blocks from two archive nodes first (lib/fees/points.ts, pointsRun.ts, lib/chain/archive.ts, the Multicall3
  // coding from functions/_lib/owned.ts), with the replay kept as its fallback. Measured with esbuild's metafile against
  // main f6df054e: worker 26,517 -> 37,478 B gzip (points engine +15.8 kB raw, archive client +4.4 kB, Multicall3
  // coding +3.0 kB, the rest +8.1 kB). The chain code grew 19,987 -> 20,621 B (the page's state read through the
  // fallbacks during a rest, the lanes' quiet, the archives' runtime). Each ceiling is raised to the next whole kB above
  // the measured build: worker 38,000 B, chain 21,000 B. The position page's and the list's words (items A13, A15, A18,
  // D4, D5, E22) took all lazy from 211,263 B (the note above) to 212,724 B, with the public reads at 66,583 B and
  // financial at 189,735 B: all lazy is raised to 213,000 B; public reads (90,000) and financial (190,000) are unchanged.
  // 2026-10-01, the 2026-10 package, integration pass 2a, second merge (pacote/ws-fees onto the wallets merge; the same
  // rule: about 5% over the larger build, rounded up to the next kB). The fees branch's own ceilings above (worker 38 kB,
  // chain 21 kB, all lazy 213 kB, its 1.6 kB wallet-test cap) were set on main's layout and give way to these; the 3 kB
  // wallet-test allowance stays. Clean Windows builds of the merged tree, gzip level 9, dist / .wallet-test-dist: initial
  // entry 203,755 / 200,774 B, route screens 167,691 / 168,070 B, session/public reads 152,412 / 152,559 B, financial
  // 303,622 / 262,398 B, all lazy 337,527 / 338,584 B, fees worker 37,487 B and chain code 20,726 B in both, and
  // WalletConnect's client 130,133 B (stand-in 4,785 B). Ceilings: initial entry 214 kB (unchanged), route screens 177 kB
  // (was 173), session/public reads 161 kB (was 156), financial 319 kB (was 316), all lazy 356 kB (was 351), fees worker
  // 40 kB (was 28), chain code 22 kB and WalletConnect 137 kB (unchanged). The wallet-test all-lazy overhead measures
  // 1,057 B.
  // 2026-10-01, the chain2 workstream, part B (pacote/ws-chain2b on pass 2's tree): the second chain's section wired (a
  // route, a chunk of its own: the 'elysium section' family, new), the menu's link to it from the chain's identity and
  // the section's mode alone (src/config/chainIdentity.ts, src/chains/elysium/mode.ts), the registry the chain code now
  // reads (its identities in the entry, which the chain code and the fees screens import from it), the chain-scoped
  // storage keys with their one-time move (src/lib/chainStorage.ts), and the session's move between the registry's chains.
  // Clean Windows builds, gzip level 9, dist / .wallet-test-dist: initial entry 204,922 / 201,923 B (pass 2: 203,755 B),
  // route screens 168,032 / 168,445 B, session/public reads 152,739 / 153,031 B, financial 304,600 / 263,452 B (the
  // chunks that open the chain code name its files to preload, now that it imports the registry's identities from the
  // entry), all lazy 338,521 / 339,717 B, fees worker 37,460 B, chain code 20,717 B, WalletConnect 130,132 B, and the
  // section 40,929 / 40,938 B (with the concentrated-liquidity maths it shares with New position, a chunk of its own now,
  // and the dialog hook). Ceilings, about 5% over the larger build rounded up to the next kB as in the passes: initial
  // entry 216 kB (was 214), financial 320 kB (was 319), elysium section 43 kB (new); every other ceiling unchanged. The
  // wallet-test all-lazy overhead measures 1,196 B.
  const productionBytes = new Map();
  const budgetFailures = [];
  for (const [label, dir] of [
    ['dist', DIST],
    ['.wallet-test-dist', WALLET],
    ['.wallet-test-v2-dist', WALLET_V2],
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
    if (dir !== DIST) assert.deepEqual(positionRoots, ['HeldDeposits', 'PositionActions', 'PositionLab'], 'the lab and the two actions it opens');
    else assert.ok(['', 'HeldDeposits,PositionActions'].includes(positionRoots.join()), `dist carries both position actions or neither, and never the lab: ${positionRoots.join(', ')}`);
    // 2026-10-02 (rugged97's spec rev3 §2.13, the V1 incident): the fees waiting in a vault and their withdrawal
    // (components/positions/FeeReserves.tsx), a lazy root of its own that Positions and a position's page open in every
    // wallet build: a financial root like the position actions, in a build that carries them.
    const reserveRoots = js.filter((file) => /^FeeReserves-/.test(file));
    assert.equal(reserveRoots.length, positionRoots.includes('HeldDeposits') ? 1 : 0, 'the fees waiting in a vault come with the position actions, or not at all');
    // The V1 setup implementation exists only in the legacy fixture build; V2 cannot import it as a fallback.
    const legacyRoots = js.filter((file) => /^SequenceLegacy-/.test(file));
    assert.equal(legacyRoots.length, dir === WALLET ? 1 : 0, 'only the legacy wallet test carries the V1 sequence setup');
    const legacyCreate = js.filter((file) => /^DepositAmounts-/.test(file));
    assert.equal(legacyCreate.length, dir === WALLET ? 1 : 0, 'only the non-V2 wallet test carries the retired creation control');
    // Changed on purpose 2026-11-07 (the owner's Points page, Season 1): Points is a signed-in wallet screen, as Execution
    // and Performance are (it reads the session and asks the wallet to sign a referral link: finance/points.ts), so it is
    // a financial root and its closure the financial screens', where the session's code is counted once; measured as a
    // route screen it would charge the whole session stack to that family a second time. Its own chunk, its styles and
    // the points-v1 runtime are all it adds.
    const financialRoots = js.filter((file) => /^(Setup|Sequence|SequenceLegacy|Execution|Performance|Points|DepositAmounts|PositionActions|HeldDeposits|PositionLab|FeeReserves)-/.test(file));
    assert.equal(financialRoots.length, 5 + legacyCreate.length + positionRoots.length + reserveRoots.length + legacyRoots.length, 'the financial screens, actions and legacy-only controls are explicit lazy roots');
    assert.equal(readRoots.filter((file) => file.startsWith('index-')).length, 1, 'include the public read screen, even though Vite calls it index');
    const base = new Set([...staticClosure(dir, [...island, ...readRoots])].filter((file) => !initial.has(file)));
    const financial = new Set([...staticClosure(dir, financialRoots)].filter((file) => !initial.has(file)));
    for (const file of financialRoots) assert.ok(!base.has(file) && !initial.has(file), `${file} must remain opt-in`);
    // Pool pages and their figures dialog open the same chart automatically. Its renderer and history reader are
    // opt-in there: connecting a wallet or reading Positions must not download them. Keep every chart byte measured,
    // including shared dependencies in their existing families and the exclusive chart closure in all-lazy below.
    const poolChartRoots = js.filter((file) => /^PoolHistoryChart-/.test(file));
    assert.equal(poolChartRoots.length, 1, 'one shared pool history chart in every read build');
    for (const file of poolChartRoots) assert.ok(!initial.has(file) && !base.has(file) && !financial.has(file), 'pool history opens only on a pool page or its figures dialog');
    const poolChart = new Set([...staticClosure(dir, poolChartRoots)].filter((file) => !initial.has(file) && !base.has(file) && !financial.has(file)));
    const allLazy = new Set([...base, ...financial, ...poolChart]);
    // 2026-09-24 (P6, DESIGN-V2 §18, R-12): the fees replay worker (src/lib/fees/feesReplay.worker.ts, created only by
    // src/lib/fees/spawn.ts on a positions page) is its own closure with its own 16,000 B ceiling, outside all lazy: it is
    // not UI and loads only where a fees history is shown. A classic worker is one self-contained file: no import, no
    // export. It is emitted only once a screen uses the fees hooks (none may on a branch where no screen does yet).
    // Measured with a temporary opener on 2026-09-24: 16,419 B raw, 7,100 B gzip.
    // Changed on purpose 2026-10-02 (RPC-SPEC \u00a711.4): the replay is gone; the page folds the ledger route's answer
    // itself, so no worker is built at all.
    const worker = new Set(js.filter((file) => /^feesReplay\.worker-/.test(file)));
    assert.equal(worker.size, 0, `no fees worker: ${[...worker].join(', ')}`);
    for (const file of worker) {
      assert.ok(!initial.has(file) && !allLazy.has(file), 'the worker is loaded by new Worker(), never imported');
      assert.ok(moduleTree(dir, file).program.body.every((node) => !['ImportDeclaration', 'ExportNamedDeclaration', 'ExportAllDeclaration', 'ExportDefaultDeclaration'].includes(node.type)), 'a classic worker: one file');
    }
    // 2026-09-25: the chain code the page runs (see above): one chunk, reached only by dynamic import, never in the entry.
    // Since 2026-10-01 (RPC-SPEC §7.2) it is the wallet feature's reads only (lib/chain/chainCode.ts over lib/walletReads.ts).
    const chainRoots = js.filter((file) => /^chainCode-/.test(file));
    assert.equal(chainRoots.length, 1, `one chain code chunk: ${chainRoots.join(', ')}`);
    const chain = new Set([...staticClosure(dir, chainRoots)].filter((file) => !initial.has(file)));
    for (const file of chainRoots) assert.ok(!initial.has(file) && !allLazy.has(file), 'the chain code is loaded when a page reads the chain, never statically');
    // 2026-10-01 (platform workstream, F1): every screen but Home is a lazy root of its own, opened by its route (src/App.tsx),
    // measured as one family: the route screens, with everything they load that the entry does not carry. Some of what
    // the read and financial roots load moved out of the entry with them, so those families measure more than before
    // for the same code (see the budgets below).
    const routeRoots = js.filter((file) => /^(Explore|PoolDetail|Positions|NewPosition|Automate|Docs)-/.test(file) && !initial.has(file));
    assert.deepEqual(routeRoots.map((file) => file.split('-')[0]).sort(), ['Automate', 'Docs', 'Explore', 'NewPosition', 'PoolDetail', 'Positions'], 'each screen but Home is a chunk of its own');
    const routes = new Set([...staticClosure(dir, routeRoots)].filter((file) => !initial.has(file)));
    // 2026-10-01 (audit C3): WalletConnect's client, a chunk of its own the island opens only when the person picks it,
    // measured as its own family (the wallet-test build's stand-in in its place), outside every other.
    const walletConnectRoots = js.filter((file) => /^walletConnect(Provider|Fake)-/.test(file));
    assert.equal(walletConnectRoots.length, 1, `one WalletConnect chunk: ${walletConnectRoots.join(', ')}`);
    const walletConnect = new Set([...staticClosure(dir, walletConnectRoots)].filter((file) => !initial.has(file) && !allLazy.has(file)));
    for (const file of walletConnectRoots) assert.ok(!initial.has(file) && !allLazy.has(file) && !chain.has(file) && !routes.has(file), 'loaded only when the person picks WalletConnect');
    // 2026-10-01 (the chain2 workstream, part B): the second chain's section, one lazy root of its own that only its route
    // opens (#/elysium…, src/App.tsx), measured as its own family: its chunk and what it loads that the entry does not
    // carry (the concentrated-liquidity maths it shares with New position, the dialog hook it shares with the wallet).
    const elysiumRoots = js.filter((file) => /^ElysiumEntry-/.test(file));
    assert.equal(elysiumRoots.length, 1, `one section chunk: ${elysiumRoots.join(', ')}`);
    const elysium = new Set([...staticClosure(dir, elysiumRoots)].filter((file) => !initial.has(file)));
    for (const file of elysiumRoots) assert.ok(!initial.has(file) && !allLazy.has(file) && !chain.has(file) && !routes.has(file) && !walletConnect.has(file), 'loaded only when its route opens');
    // 2026-10-03 (the owner's point 10): the Price range chart (components/positions/visual/PriceVsRange.tsx: its axis, its
    // labels, its line and the pool's stored price history), a chunk of its own that only a position's page opens
    // (components/positions/PositionRange.tsx), measured as its own family, as WalletConnect's is: its chunk and what it
    // loads that neither the entry nor the lazy families carry. Moved out of the Positions chunk it was part of, so the list
    // and the screens around it no longer download it.
    const priceChartRoots = js.filter((file) => /^PriceVsRange-/.test(file));
    assert.equal(priceChartRoots.length, 1, `one Price range chart chunk: ${priceChartRoots.join(', ')}`);
    const priceChart = new Set([...staticClosure(dir, priceChartRoots)].filter((file) => !initial.has(file) && !allLazy.has(file)));
    for (const file of priceChartRoots) assert.ok(!initial.has(file) && !allLazy.has(file) && !routes.has(file), 'loaded only on a position’s page');
    // 2026-10-04 (the owner: the site runs on Domino V2, deployed and pinned on every chain): V2's own screens, the lazy roots
    // V1's screens open behind the bare __DOMINO_V2__ define (src/v2in: New position's zap journey and its advanced pool
    // finder, a position's V2 actions, page, dialogs and automation, the lists' rows and receipts, the automation setup, the
    // protection card, the inline funds offer), and the viem chunks only they load (actions, ccip, secp256k1): one family of
    // their own, measured in the deployed build that carries them. The V1 wallet-test build carries none.
    // 2026-10-05 (the owner: his New position screens, with V2 connected behind them): and JourneyCreateV2, his journey's
    // Review and Create position on the new contracts: 604,752 B gzip for the family then, so its budget 606,000.
    // V3 Markets also opens the public multi-network discovery adapter lazily. Charge its complete static closure
    // to the existing V2 family; it shares discovery with New position and receives no separate allowance.
    const marketsNetworkRoots = js.filter((file) => /^MarketsNetworks-/.test(file));
    assert.equal(marketsNetworkRoots.length, dir === WALLET ? 0 : 1, 'multi-network Markets discovery belongs only to V2 builds');
    for (const file of marketsNetworkRoots) {
      const discoverable = routeRoots.filter((root) => root.startsWith('Explore-')).some((root) =>
        [...nodes(moduleTree(dir, root))].some((node) => node.type === 'ImportExpression' && node.source.value === `./${file}`));
      assert.ok(discoverable, 'Markets opens its network discovery adapter through a dynamic import');
    }
    const v2Roots = js.filter((file) => /^(MarketsNetworks|NewPositionV2|JourneyCreateV2|PoolAdvanced|PositionV2Actions|PositionAutomation|PositionPage|ManagedVaults|OwnedRows|Receipts|SetupEntry|ProtectionSetup|AutomateProtection|FundsAmounts|MandateDialog|PositionDialog|VaultDialog|actions|ccip|secp256k1)-/.test(file));
    if (dir === WALLET) assert.deepEqual(v2Roots, [], 'the V1 wallet-test build carries no V2');
    else assert.ok(v2Roots.length >= 14, `the deployed build carries V2's screens: ${v2Roots.join(', ')}`);
    const v2 = new Set([...staticClosure(dir, v2Roots)].filter((file) => !initial.has(file)));
    for (const file of v2Roots) assert.ok(!initial.has(file) && !routes.has(file), `${file} is loaded only when a V1 screen opens V2`);
    // 2026-10-09: budget the V2 wallet fixture alongside production, including the fake deployment manifests it
    // opens dynamically. This previously unmeasured test-data family is absent from deployable and legacy builds.
    // Shared dependencies retain their existing family charges; only the fixture-exclusive closure uses this cap.
    const fixtureRoots = js.filter((file) => /^manifestFixtures-/.test(file));
    assert.equal(fixtureRoots.length, dir === WALLET_V2 ? 1 : 0, 'only the V2 wallet fixture carries fake deployment manifests');
    const measured = new Set([...initial, ...allLazy, ...worker, ...chain, ...routes, ...walletConnect, ...elysium, ...priceChart, ...v2]);
    for (const file of fixtureRoots) assert.ok(!measured.has(file), 'fake deployment manifests remain an opt-in test-data chunk');
    const fixtureData = new Set([...staticClosure(dir, fixtureRoots)].filter((file) => !measured.has(file)));
    assert.deepEqual([...new Set([...measured, ...fixtureData])].sort(), js, 'every generated script belongs to a measured closure');
    // H4 (2026-10-01): what every visitor downloads before anything shows, the entry with the chunks it imports and the
    // stylesheet the page links, has a budget of its own. Until then only lazily loaded families had one, and the entry
    // grew 33% in a week with no test failing.
    const html = readFileSync(join(dir, 'index.html'), 'utf8');
    const linked = [...html.matchAll(/<link rel="stylesheet"[^>]*href="\/assets\/([^"]+)"/g)].map((match) => match[1]);
    assert.equal(linked.length, 1, 'the page links one stylesheet');
    const first = new Set([...initial, ...linked]);
    // 2026-10-01 (RPC-SPEC, the switch to Domino's own node, re-measured at the integration): the chain code chunk is the
    // wallet feature's two functions and the site's chain routes' client (2,041 B both builds; 22,238 B before, with the
    // chain code itself, which now runs only at the edge), and the fees worker carries no chain code (24,164 B; about
    // 37.5 kB before). Both ceilings come down to keep them meaningful: chain code 22,000 -> 4,000, fees worker
    // 40,000 -> 28,000. Every other family is within its budget unchanged (initial entry 205,897 B; route screens 172,655 B;
    // session/public reads 156,227 B; financial 309,027 B; all lazy 344,252 B; elysium section 41,389 B, dist).
    // 2026-10-02 (rugged97's spec rev3 §2.13, the V1 incident: the fees waiting in a vault, with Withdraw to wallet): a
    // financial root of its own (components/positions/FeeReserves.tsx, 8,023 B with what it reads and withdraws with), and
    // the money client's reserves reads and withdrawal batch (finance/sequence.ts). Clean Windows builds, gzip level 9,
    // dist / .wallet-test-dist, on release/rpc-local-2026-10 (ebd563f8) then with the feature: financial 315,980 / 316,614
    // -> 325,333 / 325,936 B, all lazy 349,679 / 350,540 -> 359,261 / 360,053 B; every other family unchanged within a
    // few hundred bytes. Raised minimally, to the next kB above the deployable build: financial 320,000 -> 326,000, all
    // lazy 356,000 -> 360,000; the 3 kB wallet-test allowance stays.
    // 2026-10-02 (the review of that change, its eight findings): the vault's own record of a withdrawal (finance/sequence.ts
    // withdrawalRecords), every vault read a page at a time and each kept through failed reads (lib/automate/reserves.ts),
    // a long chain of members walked in pages, and the V1 release shipped for recovery (finance/pin.ts
    // SEQUENCE_RECOVERY_RECORD, about 0.7 kB of it). Clean Windows build, gzip level 9, dist / .wallet-test-dist: financial
    // 325,333 -> 328,545 / 329,147 B, all lazy 359,261 -> 362,466 / 363,253 B; every other family unchanged. Raised
    // minimally, to the next kB above the deployable build: financial 326,000 -> 329,000, all lazy 360,000 -> 363,000.
    // 2026-10-03 (the owner's UI round: the wallet dialog shows the account's disc, its short address and Copy instead of the
    // wallet app's name; components/read/screens/CopyButton.tsx and lib/format/tokenHue.ts join the dialog's chunk). Clean
    // Windows build, gzip level 9, dist: financial 329,434 B, all lazy 363,444 B. Raised minimally, to the next kB:
    // financial 329,000 -> 330,000, all lazy 363,000 -> 364,000.
    // 2026-10-03 (the owner's point 9, the position action dialogs redrawn as one family): Collect fees, Close position and
    // the fees waiting in a vault share components/positions/ActionSheet.tsx (the frame, the token rows, the facts). Clean
    // Windows build, gzip level 9, dist, v2/f7 (7c6e4822, the note above) then with the change: financial 329,434 ->
    // 330,611 B, all lazy 363,444 -> 364,666 B; the initial entry +6 B, every other family unchanged within a few dozen
    // bytes. Raised minimally, to the next kB above the deployable build: financial 330,000 -> 331,000, all lazy 364,000 ->
    // 365,000; the 3 kB wallet-test allowance stays.
    // 2026-10-03 (the owner's point 10): the Price range chart redrawn (its status in words, its whole band with Max and Min,
    // the pool's last 7 days from read-v3 `history`, readable prices) and moved to a chunk of its own that only a position's
    // page opens (components/positions/PositionRange.tsx). Clean Windows build, gzip level 9, dist, against v2/f7 at
    // 52f09f41: initial entry 205,685 -> 204,729 B, route screens 173,668 -> 173,723 B, session/public reads 156,880 ->
    // 156,999 B, financial 330,566 -> 330,656 B, all lazy 364,601 -> 364,755 B; the chart's own family 5,368 B, its budget
    // the next kB above it, 6,000 B. No other budget moves.
    // 2026-10-03 (the density change merged with the chart: lib/rootScale.ts and its rem() join the chart and the frames).
    // Clean Windows build, gzip level 9, dist: financial 330,839 B, all lazy 365,004 B (4 B over). Raised minimally, to the
    // next kB: all lazy 365,000 -> 366,000; financial stays at 331,000.
    // 2026-10-04 (the docs revalidated for V2, four new pages in the Docs route; the owner's ChatGPT UI round: the range
    // simulator redesigned, Automate's mode summary). Clean Windows build, gzip level 9, dist: route screens 179,731 B.
    // Raised minimally, to the next kB: route screens 177,000 -> 182,000 (the wallet-test build's 181,455 B; route screens
    // has no test-only allowance); financial 331,822 B: 331,000 -> 332,000; all lazy 366,041 B: 366,000 -> 367,000.
    // 2026-10-04 (the ChatGPT UI round 4: New position's single progress, Setup's grouped fields, Receipts' states):
    // financial 332,289 B: 332,000 -> 333,000; all lazy (366,531 B) stays at 367,000.
    // 2026-10-04 (the ChatGPT UI round 5: the inline funds offer, Change range and the charts): the wallet-test build's route
    // screens 182,155 B: 182,000 -> 183,000; dist's financial 332,563 B and all lazy 366,886 B stay under theirs.
    // 2026-10-04 (the owner: the site runs on Domino V2; the deployed build carries V2's screens and its pinned manifests):
    // V2 shares the wallet, session and chain code with V1, so the chunks the existing families load moved. Clean Windows
    // build, gzip level 9, dist / .wallet-test-dist: route screens 183,151 / 182,603 B, session/public reads 161,496 /
    // 158,959 B, financial 339,801 / 335,016 B, all lazy 376,287 / 369,661 B; Domino V2's own family 599,749 B (dist only).
    // Raised to the next kB above the deployable build, with one more kB for financial and all lazy (Linux builds measure a
    // few hundred bytes apart): route screens 183,000 -> 184,000, session/public reads 161,000 -> 162,000, financial
    // 333,000 -> 341,000, all lazy 367,000 -> 378,000; Domino V2 601,000 (new). The 3 kB wallet-test allowance stays.
    // 2026-10-05 (the owner: New position across Robinhood Chain, Base and Arbitrum One, each search result with its
    // network's tag; lib/create/otherChains.ts): the search's network rows, the network pool list and the chain-aware steps,
    // dist's route screens 185,032 B: 184,000 -> 186,000; session/public reads 161,932 B (68 B under, and Linux builds
    // measure a few hundred bytes apart): 162,000 -> 163,000; financial 341,594 B: 341,000 -> 343,000; all lazy 378,085 B:
    // 378,000 -> 380,000; Domino V2's own family 609,433 B (the other networks' module and the zap client's readPools):
    // 606,000 -> 611,000.
    // 2026-10-05 (0xdecimal's items 1-3: read-v6's chain-pools, chain-balances and chain-tokens): the package's schemas and
    // validators for the three routes, which the V2 read client carries, and its three read functions; CI's Linux dist
    // measured Domino V2's own family at 613,393 B (609,657 B on main): 611,000 -> 615,000, the next kB and one more, as
    // builds measure a few hundred bytes apart.
    // 2026-10-05 (read-v6 1.1.0-rc.1, qualified USD: 0xdecimal's items 4 and 8): the package's price, market, balance and
    // returned-reserves schemas and validators, which the V2 read client carries; CI's Linux dist measured Domino V2's own
    // family at 615,547 B (this Mac's at 614,311 B: the two zlibs differ either way): 615,000 -> 617,000, the next kB and
    // one more.
    // 2026-10-06 (rugged97's delta of 5 Oct, items 1-4 on screen, #368): New position's chain reads (search, pools, balances
    // through read-v6) and their pure model, Bring funds' balances per network, and qualified USD on the position page and
    // rows; CI's Linux dist measured Domino V2's own family at 619,437 B: 617,000 -> 621,000, the next kB and one more.
    // 2026-10-06 (the owner's five points of 6 Oct, one update: the bring-funds line and sizing, other networks' figures,
    // icons and search, Auto-exit at the range's edges, the simpler Review): this Windows build measured route screens
    // 187,470 B, session/public reads 163,770 B, financial 344,636 B, all lazy 381,166 B and Domino V2's own family
    // 632,523 B: 186,000 -> 189,000, 163,000 -> 165,000, 343,000 -> 346,000, 380,000 -> 383,000 and 621,000 -> 634,000, the
    // next kB and one more, as Linux builds measure a few hundred bytes apart.
    // 2026-10-06 (the integration review's Auto-exit fixes: paused only by its order, its rearm said by what it does and
    // offered on its card alone, the pool's price read before it is turned back on, Leave automation in its words, and on
    // its own root only a moved approval pauses it): this Windows build measured Domino V2's own family at 634,561 B,
    // +2,038 B (the vault dialog's chunk +999, the position automation's +554, the position dialog's +235, Auto-exit's
    // standing in a chunk of its own +446 out of the lists' parts -373, the rest chunk names): 634,000 -> 636,000, the
    // next kB and one more.
    // 2026-10-06 (the integration review's fixes merged together: the funds, Review, Auto-exit and misc rounds): this Windows
    // build measured Domino V2's own family at 637,459 B: 636,000 -> 639,000, the next kB and one more.
    // 2026-10-06 (the final check's fixes: Back after any create, Review's amounts before a quote, Read again, Auto-exit's
    // card after a module change, its ends by price move, one name per network): this Windows build measured Domino V2's own
    // family at 638,877 B, 123 B under 639,000, closer than Linux builds measure apart: 639,000 -> 640,000.
    // 2026-10-06 (the owner: USD for every Robinhood Chain pair from read-v6's qualified prices, and "Pay with ETH instead"
    // when a pair cannot be brought): this Windows build measured Domino V2's own family at 639,831 B, 169 B under 640,000,
    // closer than Linux builds measure apart: 640,000 -> 641,000.
    // 2026-10-06 (rugged97's answer of 6 Oct, app side: S2's approval and deposit in one batch and its card's fee and network
    // lines, Review's "up to X% smaller" line in view and DEX Screener's ten-minute rule, Auto-exit's warnings above its
    // button, its texts and "Closed by Auto-exit"): this Windows build measured route screens 188,415 B, session/public reads
    // 164,857 B and Domino V2's own family 643,594 B: 189,000 -> 190,000, 165,000 -> 166,000 and 641,000 -> 645,000, the next
    // kB and one more, as Linux builds measure a few hundred bytes apart.
    // 2026-10-06 (the same answer's Ethereum and OP Mainnet balances and its misc items merged in): Domino V2's own family
    // measured 645,073 B: 645,000 -> 647,000, the next kB and one more.
    // 2026-10-07 (the owner's unified automation and activity history): shared private receipt dates, the wallet/position
    // history pager, current-setup selection and reviewed gas recovery add opt-in code. Windows gzip level 9 measured
    // financial 346,052 B and Domino V2 649,841 B after removing the obsolete two-block receipt variant. Ceilings move
    // to 347,000 and 651,000, keeping about 1 kB for platform gzip variation. Initial entry and all other limits stay.
    // 2026-10-07 (V2 position history recovery): indexed mint hints, independent chart dates and first-reading APR
    // add about 1 kB to deferred code, with no new dependency or initial-entry growth. The pre-optimization Windows
    // build measured all-lazy at 383,529 B; its ceiling moves by 1 kB only. All other families retain their limits.
    // 2026-10-08 (first-hour position charts): validated creation-block price observations add no dependency or
    // initial-entry code. Windows gzip level 9 measured public reads 166,022 B and the chart 6,511 B. Allow 500 B
    // more for the shared optional wire field and 1 kB for the deferred chart; all other budgets remain unchanged.
    // V2-only automation discovery (2026-10-08): removing the legacy setup's static imports redistributes shared
    // chunks. Windows gzip 9: routes 190,155 B, public reads 166,496 B, financial 330,987 B, all lazy 368,517 B,
    // V2 616,443 B (previous V2 650,823 B). Round only the two nearly-full shared families up for platform/name
    // variation; keep the entry and every financial/V2 ceiling. All legacy code still counts in absolute budgets.
    // The fixture-only deployment data measures 12,384 B gzip on Windows; its separate 13 kB cap changes no
    // existing ceiling and is not part of the 3 kB instrumentation allowance for the comparable V2 feature closures.
    // Windows gzip 9 measures the separately deferred pool chart at 12,066 B: its own 13 kB cap leaves room for
    // platform/name variation. These same bytes still count against the unchanged all-lazy ceiling. No existing
    // budget or test-only allowance grows when the chart leaves the session/read startup path.
    // 2026-10-10 (bounded funding preparation): shared request admission/cooldowns, wallet/origin caches,
    // cancellable quote planning and local-payment retention add deferred V2 code without a dependency.
    // Linux CI and Windows both measure 653,623 B gzip. Rebase only V2 to the next kB plus 1 kB for
    // platform/chunk-name variation; the initial-entry ceiling and every other family stay unchanged.
    // 2026-10-10 (explicit funding choices): whole-position budgets and unsent-intent isolation add
    // 2,030 B gzip to deferred V2 (655,653 B measured on Windows), with no new dependency. Rebase
    // only V2 to the next kB plus 1 kB for platform/name variation; every other ceiling stays unchanged.
    // 2026-10-11: omitted-holding reconciliation and independently expiring ranking hints add deferred Wallet
    // code. Removing unused runtime namespace exports saved 298 B; Windows gzip 9 legacy all-lazy is
    // 387,376 B against 387,000 B including its existing test allowance. Round only all-lazy up 1 kB
    // (0.26%); no extra instrumentation discount, dependency, entry, financial or V2 ceiling change.
    // 2026-10-11 (funding handoff and dialog keyboard recovery): the shared journey guards and visibility-aware
    // focus trap measure 388,237 B gzip in legacy all-lazy, 237 B above its 388,000 B ceiling. Allow 500 B for
    // this measured code, without enlarging instrumentation, entry, financial or V2 budgets or adding dependencies.
    // 2026-10-11 (visible sign-in with account-safe network return, cross-network position actions and bounded
    // artwork recovery): the new deferred behavior measures 390,364 B in legacy wallet-test all-lazy after removing
    // its unused multi-chain switch helpers. Production all-lazy is 324,544 B. Allow 2.5 kB for this measured feature
    // growth (385,500 -> 388,000), with no new dependency or instrumentation discount. Initial-entry, session/read,
    // financial and V2 ceilings stay unchanged; grouping more UI code expanded earlier loading closures.
    // 2026-10-14 (incident of 2026-10-13, package D2: the Wallet card's bounded prices and its total of the priced
    // tokens with its note): the Positions chunk alone grows, 584 B gzip in the legacy wallet-test build (16,170 ->
    // 16,754 B) and 572 B in dist (18,502 -> 19,074 B), every other chunk within a few bytes. Windows gzip 9: legacy
    // wallet-test all-lazy 391,179 B against 391,000 B with its test allowance (D1 measured 390,622 B); production
    // all-lazy 325,412 B, route screens 159,278 B, initial entry 215,923 B (D1 215,925 B). Round only all-lazy up 1 kB;
    // no dependency, and the initial-entry, route, session/read, financial and V2 ceilings stay unchanged.
    // 2026-10-14 (incident X1: a screen that throws keeps the header and the footer): the screen boundary sits in the
    // entry, as App.tsx does; +88 B gzip alone (215,686 -> 215,774 B on a26a0a75), and with D2 merged the Windows gzip 9
    // initial entry measures 216,018 B against 216,000 B. Allow 500 B for this measured code; no dependency, and every
    // other ceiling stays unchanged.
    // Changed on purpose 2026-10-16 (V4 look, owner-approved prototype; impl/plan.md test C): the foundation's eager CSS
    // (V4 tokens and aliases, the load-moment classes, the lit edge, the primitives, the dialog and wallet frame), with the
    // rules it replaced removed in place, takes the Windows gzip 9 initial entry from 214,755 B to 217,598 B, 1,098 B over
    // 216,500 B. Raise only the initial entry by that overshoot rounded up to 0.5 kB; no dependency, every other ceiling
    // unchanged.
    // Changed on purpose 2026-10-16 (V4 look, owner-approved prototype; impl/plan.md test C, foundation F4-F8): the header,
    // footer, page title and ember (the V4 chrome, its menu glyphs, the title's stop, sheen and rise, the ember layer and
    // its script), with the header, menu, footer and title rules they replaced removed in place, take the Windows gzip 9
    // initial entry from 217,598 B to 218,886 B, 886 B over 218,000 B. Raise only the initial entry by that overshoot
    // rounded up to 0.5 kB; no dependency, every other ceiling unchanged.
    // Changed on purpose 2026-10-16 (V4 look, owner-approved prototype; impl/plan.md test C, docs-system): the eager system
    // states (styles/v4-system.css: the brand tile drawn in CSS for Not found, which is part of the entry, the fallen-tile
    // stage, the failed-screen title, the flagged loader's pips) take the Windows gzip 9 initial entry from 217,598 B to
    // 219,169 B, 1,169 B over 218,000 B (nothing eager was replaced; the loader was compacted first). Raise only the
    // initial entry by that overshoot rounded up to 0.5 kB; no dependency, every other ceiling unchanged.
    // Changed on purpose 2026-10-16 (V4 Home, owner-approved prototype; impl/plan.md test C): Home's V4 stylesheet (the
    // hero tile, the pool strip, the funding loop, the functions' stage, the range scene and the calm topics), with its
    // three replaced v3 files emptied and the hero's SVG sculpture and its stylesheet removed, takes the Windows gzip 9
    // initial entry from 217,598 B to 224,191 B, 6,191 B over 218,000 B. Raise only the initial entry by that overshoot
    // rounded up to 0.5 kB; no dependency, every other ceiling unchanged.
    // Changed on purpose 2026-10-16 (V4 integration, impl/plan.md test C, after the seven areas and the F-C cleanup of
    // the rules nothing renders): the three measures above were taken on separate branches. Merged, the Windows gzip 9
    // initial entry measures 224,453 B in dist (.wallet-test-dist 221,051 B, .wallet-test-v2-dist 221,738 B), 5,453 B
    // over 219,000 B. Raise only the initial entry to 225,000 B: the overshoot rounded up to 0.5 kB leaves 47 B, so one
    // more 0.5 kB keeps the plan's half-kilobyte headroom for platform gzip variation. No dependency, every other
    // ceiling unchanged.
    // Changed on purpose 2026-10-17 (V4 prototype parity, PR #429: the owner asked for the live site identical to the
    // approved prototype, animations included): the shared light, the per-screen load moments, the travelling tile and the
    // areas' rules land in the eager CSS and entry. Measured in CI (gzip 9): initial entry 238,651 B in dist (.wallet-test-dist
    // 235,386 B, .wallet-test-v2-dist 235,797 B), 13,651 B over 225,000 B; .wallet-test-dist all lazy 398,072 B, 6,072 B
    // over its 392,000 B (389,000 B + 3,000 B test-only). Raise the initial entry to 239,500 B and all lazy to 396,000 B:
    // each overshoot rounded up to 0.5 kB plus one more 0.5 kB of headroom. No dependency, every other ceiling unchanged.
    // Changed on purpose 2026-10-30 (QA round 2, shell-home: the route skeleton and the tab's name while a screen loads,
    // its files asked for on hover and focus, Skip to content, the Home hero's line and its linked network chips, the
    // approved Home row action, the 24/44 px hit areas, the 2px field focus ring, the arrow keys of every radio group):
    // measured with gzip 9 on the deployable build, the initial entry is 240,155 B (238,651 B at ae6333a2 measured the same
    // way, CI's own figure), 655 B over 239,500 B. Raise only the initial entry to 241,000 B: the overshoot rounded up to
    // 0.5 kB plus one more 0.5 kB of headroom. No dependency, every other ceiling unchanged. Re-measure on the integrated
    // branch: the other areas of the round may add to the entry too.
    // Changed on purpose 2026-10-30 (QA round 2, integrated branch): CI measured .wallet-test-dist all lazy at 404,674 B,
    // 5,674 B over its 399,000 B (396,000 B + 3,000 B test-only); dist all lazy is 332,267 B. Raise all lazy to 402,500 B:
    // the overshoot rounded up to 0.5 kB plus one more 0.5 kB of headroom. No dependency, every other ceiling unchanged.
    // Changed on purpose 2026-10-30 (QA round 2, integrated branch after the second pass and the cross-area pass 3; all
    // seven areas merged): measured with gzip 9 on Windows, clean builds of all three directories. Four families are over,
    // each already over before pass 3 (its own changes move them by -18 B, +83 B, -149 B and +49 B): the initial entry
    // 241,430 B in dist (.wallet-test-dist 238,202 B, .wallet-test-v2-dist 238,698 B), 430 B over 241,000 B; session/public
    // reads 167,431 B in .wallet-test-v2-dist (dist 166,859 B), 431 B over 167,000 B; .wallet-test-dist all lazy 406,432 B,
    // 932 B over its 405,500 B (402,500 B + 3,000 B test-only; dist 333,780 B); domino v2 663,449 B in dist
    // (.wallet-test-v2-dist 661,602 B), 6,449 B over 657,000 B. Each moves by its overshoot rounded up to 0.5 kB plus one
    // more 0.5 kB of headroom: initial entry 242,000 B, session/public reads 168,000 B, all lazy 404,000 B, domino v2
    // 664,000 B. No dependency, every other ceiling unchanged.
    // Changed on purpose 2026-10-31 (QA round 2 follow-ups, PR #431: free amounts on New position and the 25 follow-up
    // fixes, five areas merged): CI measured .wallet-test-dist all lazy at 407,817 B, 817 B over its 407,000 B (404,000 B
    // + 3,000 B test-only); dist all lazy is 334,290 B. Raise all lazy to 405,500 B: the overshoot rounded up to 0.5 kB
    // plus one more 0.5 kB of headroom. No dependency, every other ceiling unchanged.
    // Changed on purpose 2026-11-02 (launch batch: the four backend and ops fixes of #452 and the seven app fixes of
    // review M1-M4, A1, A2 and B2 and the featured fallback list, merged as one PR): main is already over domino v2's
    // ceiling. Since #443, CI measures 664,043 B for domino v2 in dist, 43 B over 664,000 B, and 407,885 B for all
    // lazy in .wallet-test-dist, 615 B under its 408,500 B (405,500 B + 3,000 B test-only; run 41476165786 on
    // d7469cd7). The backend fixes change no family: CI measured them on main to the byte (run 41512227100). Clean Mac
    // builds with gzip 9, one of main with those fixes and one of this branch, put the app fixes at +3,637 B in domino
    // v2 (662,632 B to 666,269 B; .wallet-test-v2-dist +3,659 B) and +753 B in that all lazy (406,954 B to 407,707 B).
    // On CI that is about 667,680 B, 3,680 B over 664,000 B, and 408,638 B, 138 B over 408,500 B. Raise domino v2 to
    // 668,500 B and all lazy to 406,500 B: each overshoot rounded up to 0.5 kB, plus one more 0.5 kB of headroom. No
    // dependency, and every other ceiling unchanged.
    // Changed on purpose 2026-11-04 (launch round P3, PR #456: read-v6 1.2.0-rc.1 adds the position-fees route for Base
    // and Arbitrum Fees earned): src/v2in/transports.ts imports the package's validators, which dispatch on every route,
    // so the route's request and response schemas land in domino v2 before the app calls it. CI measured domino v2 at
    // 671,196 B in dist (.wallet-test-v2-dist 669,514 B; run 41836942796) against 667,576 B on main at 0f9c520d (run
    // 41834140551): +3,620 B, 2,696 B over 668,500 B. Every other family moved by under 0.1 kB. Raise domino v2 to
    // 672,000 B: the overshoot rounded up to 0.5 kB plus one more 0.5 kB of headroom. No dependency, every other ceiling
    // unchanged.
    // Changed on purpose 2026-11-04 (Base's and Arbitrum's Fees earned and Your APR from read-v6's position-fees, the owner:
    // every chain the same as Robinhood Chain): Robinhood Chain's card opens lazily, but its tile, the mapping and the read
    // are on the V2 page, and the modules they share with V1's position page leave its chunk. Measured with gzip 9 on
    // Windows: domino v2 675,384 B in dist (.wallet-test-v2-dist 673,515 B), 3,384 B over 672,000 B; session/public reads
    // 169,476 B in .wallet-test-v2-dist (dist 168,923 B), 1,476 B over 168,000 B. Raise domino v2 to 676,000 B and
    // session/public reads to 170,000 B: each overshoot rounded up to 0.5 kB plus one more 0.5 kB of headroom. No
    // dependency, every other ceiling unchanged.
    // Changed on purpose 2026-11-06 (the owner: Base and Arbitrum an exact copy of Robinhood Chain's position page, nothing
    // pending on our side): the read route's capabilities asked in 1.2.0-rc.1 first with 1.1.0-rc.1 as before behind it
    // (src/v2/routes.ts); Robinhood Chain's own tile parts (components/positions/keyFigureParts.tsx: Token amounts, the
    // split bar, the range bar and the price), now shared by both position pages; the stored history's automation lines,
    // Activity settlements and Fees history line (src/v2in/position/storedFees.ts); the page's View address, burned NFT and
    // Details links, and the dialogs' USD. Measured with gzip 9 on Windows against the 2026-11-04 work in progress on the
    // same base (dist 675,393 B, .wallet-test-v2-dist 673,590 B): domino v2 678,888 B in dist (+3,495 B) and 677,042 B in
    // .wallet-test-v2-dist (+3,452 B), 2,888 B over 676,000 B. Raise domino v2 to 679,500 B: the overshoot rounded up to
    // 0.5 kB plus one more 0.5 kB of headroom. No dependency, every other ceiling unchanged.
    // Changed on purpose 2026-11-06 (the replica rule, O-15 and O-18: Base and Arbitrum One are Robinhood Chain's screens):
    // "Create a new pool (advanced)" opens the chosen token's network's finder (NewPositionV2, PoolAdvanced), and a
    // position made there gets Robinhood Chain's success with only the automations that network takes now (ReviewStage
    // CreatedOnNetwork: its gates and one read-v6 portfolio read; CreatedNext's code now shares ReviewStage's chunk).
    // Measured with gzip 9 on Windows against this branch's parent built the same way: domino v2 675,393 B to 676,131 B
    // in dist (+738 B, about 100 B of it the hashed chunk names every import carries; .wallet-test-v2-dist 674,413 B),
    // 131 B over 676,000 B. Raise domino v2 to 677,000 B: the overshoot rounded up to 0.5 kB plus one more 0.5 kB of
    // headroom. No dependency, every other ceiling unchanged. Its review (2026-11-06: read-v6's word asked about the
    // wallet that made the position): 676,160 B in dist (+29 B), 674,203 B in .wallet-test-v2-dist; the budget stays.
    // Changed on purpose 2026-11-06 (R-07, the owner's replica rule: the Wallet card lists the wallet's tokens on Base and
    // Arbitrum One too): the card's merge, figure and network rows join the Positions chunk, which Your positions' chunk
    // reaches, so they count in session/public reads; the watcher and its pure model join the V2 lists' chunk (OwnedRows),
    // no chunk of their own. Behind the V2 define, so the V1 wallet-test build carries almost none of it. Measured with gzip
    // 9 on Windows against f8825cd5: session/public reads 170,302 B in dist (+1,399 B) and 170,816 B in .wallet-test-v2-dist
    // (+1,327 B), 816 B over 170,000 B; domino v2 676,488 B in dist (+1,095 B), 488 B over 676,000 B. Raise session/public
    // reads to 171,500 B and domino v2 to 677,000 B: each overshoot rounded up to 0.5 kB plus one more 0.5 kB of headroom.
    // No dependency, every other ceiling unchanged.
    // Changed on purpose 2026-11-06 (Elysium readiness: the chain model that takes a HYPE-native chain and checks each
    // profile's rank rule, the screens naming the chain's own currency, and the network mark slot): measured with gzip 9
    // on Windows against this branch's base (f8825cd5, domino v2 675,393 B in dist): domino v2 677,294 B in dist
    // (+1,901 B; .wallet-test-v2-dist 675,349 B), 1,294 B over 676,000 B. Raise domino v2 to 678,000 B: the overshoot
    // rounded up to 0.5 kB plus one more 0.5 kB of headroom. No dependency, every other ceiling unchanged.
    // Changed on purpose 2026-11-06 (integ/replica-elysium: rep/pos, rep/mkt, rep/new, rep/wal and rep/ely merged on
    // f8825cd5 with main 1c357813, then the v4-only chain, the Base/Arbitrum Pool button and the Wallet card's mark slot).
    // Each branch above raised a ceiling against the same base on its own; the merge kept the largest (domino v2 679,500 B
    // from rep/pos), and their sum is over it. Measured with gzip 9 on Windows, clean builds of all three directories. The
    // merge alone (39f0ea27): domino v2 682,197 B in dist (.wallet-test-v2-dist 680,124 B), 2,697 B over 679,500 B; the
    // initial entry 242,056 B in dist, 56 B over 242,000 B (the branches' shared screens and rules). This branch's own
    // addition (the chain model's versions, the nine-component manifest rules, the guards that keep v3 out of a chain
    // with v4 alone, the invalid_request mapping, the network pool link): domino v2 +1,406 B in dist to 683,603 B
    // (.wallet-test-v2-dist +1,718 B to 681,842 B), 4,103 B over; the initial entry +12 B to 242,068 B, 68 B over.
    // Raise domino v2 to 684,500 B and the initial entry to 243,000 B: each overshoot rounded up to 0.5 kB plus one more
    // 0.5 kB of headroom. No dependency, every other ceiling unchanged.
    // Changed on purpose 2026-11-06 (the Elysium surface, branch ely/surface): its base, 39f0ea27 (the merge of the six
    // reviewed branches, each of which raised domino v2 from its own parent), is already over two ceilings: measured with
    // gzip 9 on Windows, initial entry 242,056 B in dist (56 B over 242,000 B) and domino v2 682,197 B (2,697 B over
    // 679,500 B). The surface adds 62 B to the entry (Elysium's switch, name and mark rows, Home's sixth place: 242,118 B)
    // and takes 258 B off domino v2 (681,939 B). Raise the entry to 243,000 B and domino v2 to 682,500 B: each overshoot
    // rounded up to 0.5 kB plus one more 0.5 kB of headroom. No dependency, every other ceiling unchanged.
    // Merged 2026-11-07 (ely/surface into integ/replica-elysium): the two raises above were made against the same base,
    // 39f0ea27, each on its own; the merge keeps the larger of each (domino v2 684,500 B, the initial entry 243,000 B).
    // Measured on the merge with gzip 9 on Windows, clean builds of all three directories: domino v2 683,379 B in dist
    // (.wallet-test-v2-dist 681,616 B), the initial entry 242,132 B in dist; inside both, so no ceiling moves.
    // Changed on purpose 2026-11-07 (ely/money: Elysium as a fourth V2 chain, switched on by itself). Off, as today and in
    // the release build, measured with gzip 9 on Windows, clean builds of all three directories against 683,379 B: domino
    // v2 683,799 B in dist (+420 B: the read client leaving out a chain it does not serve, the capabilities' wider chain
    // check, S2's destinations, the preview's fallback; .wallet-test-v2-dist 682,030 B), the initial entry 242,131 B; inside
    // every ceiling, so none moves. On, the day the repository holds every day-9 piece (scripts/elysium-switch.mjs), the
    // build also carries Elysium's rows, its profile and its pinned record: measured on the forced build
    // (.wallet-test-v2-dist-elysium, the synthetic profile, no record) against .wallet-test-v2-dist, domino v2 +1,745 B,
    // the pool history chart +9 B (13,000 B), V2 fixture data +510 B (12,906 B), the initial entry +43 B; the record not
    // in it, its text alone is 6,221 B gzip (the nine-contract fixture's, a bound: beside the other three records it
    // compresses further). So where the repository's switch is live, and there only, domino v2 may take 8,500 B more
    // (1,745 + 6,221 rounded up to 0.5 kB, plus one more 0.5 kB of headroom) and the pool history chart 500 B more (its
    // own measure at the ceiling, plus 0.5 kB). No dependency, no other ceiling, and nothing while Elysium is off.
    // Changed on purpose 2026-11-07 (merge of Elysium's pre-launch with day 9 on ready/final): the pre-launch row and its
    // opening words live in the initial entry by design (the hero draws them in its first moment). Measured with gzip 9
    // on Windows on the merge: the initial entry 242,999 B in dist, 1 B under 243,000 B. Raise it to 243,500 B: one more
    // 0.5 kB of headroom, as this file's rule gives. No dependency, every other ceiling unchanged.
    // Changed on purpose 2026-11-07 (merge of ready/seo into ready/leva2: pages of their own for Google beside Elysium's
    // pre-launch and the open-site fixes): the page's own address is read and written by the entry (src/lib/route.ts, the
    // aliases of functions/_lib/pagePaths.ts, the tab titles of src/lib/seo/heads.ts), and every link's href is a path.
    // Measured with gzip 9 on Windows, clean production builds: ready/seo alone (a56b97b7, on f6aa00bb) 242,970 B,
    // ready/leva2 alone (96bcc295) 242,999 B, the merge 243,853 B in dist (.wallet-test-dist 240,540 B,
    // .wallet-test-v2-dist 241,137 B), 353 B over 243,500 B: each branch's addition was measured on its own base. Raise
    // only the initial entry to 244,500 B: the overshoot rounded up to 0.5 kB plus one more 0.5 kB of headroom. No
    // dependency, every other ceiling unchanged (domino v2 684,086 B in dist, inside 684,500 B).
    // Changed on purpose 2026-11-07 (the owner: Domino in Google, integ-logs/seo/PROPOSAL.md; ready/seo with its review's
    // fixes). Every visitor's first download now carries the page's own address (src/lib/route.ts: the address read from
    // the path, a link from before rewritten in place, the site's links moved without a reload, an address naming another
    // host left alone), Home's tab title and the boot script's path read. Measured with gzip 9 on Windows, clean builds of
    // all three directories against main f6aa00bb (242,185 B in dist): the initial entry 243,039 B in dist (+854 B;
    // .wallet-test-v2-dist 240,317 B), 39 B over 243,000 B; and with Elysium on, the forced builds against
    // .wallet-test-v2-dist, +95 B (.wallet-test-v2-dist-elysium 240,412 B) and +106 B (-funds 240,423 B), so the release
    // build on day 9 about 243,145 B, 145 B over. Raise only the initial entry to 244,000 B: that overshoot rounded up to
    // 0.5 kB plus one more 0.5 kB of headroom. No dependency, every other ceiling unchanged.
    // Merged 2026-11-07 (ready/seo's review fixes into ready/leva2): ready/seo alone raised the entry to 244,000 B on
    // f6aa00bb; the merge keeps the larger, 244,500 B, which also holds day 9's Elysium-on addition (about 106 B).
    // Changed on purpose 2026-11-07 (the owner's Points page, Season 1, Stage 1; integ-logs/points/PROPOSAL.md). Every
    // visitor's first download carries what makes the page reachable and a referral link work on any page: the route row,
    // the menu's Points with its star, the `?ref=` capture (src/points/capture.ts) and the router's writer that takes `ref`
    // out of the address (src/lib/route.ts dropSearchParam), and the lazy screen's import with its files' list. The screen,
    // its styles, its transport and the points-v1 runtime are one chunk of their own, a financial root (above). Measured
    // with gzip 9 on Windows, clean builds of all three directories against ready/points' base (b671cdcb, built the same
    // way: dist 243,936 B, .wallet-test-dist 240,621 B, .wallet-test-v2-dist 241,215 B): the initial entry 244,398 B in dist
    // (+462 B; .wallet-test-dist 241,050 B, .wallet-test-v2-dist 241,659 B), 102 B under 244,500 B, but day 9's Elysium-on
    // addition (about 106 B) would take the release build about 4 B over. Raise the initial entry to 245,000 B: that overshoot rounded up to 0.5 kB. The all-lazy family takes the
    // Points chunk (10,220 B gzip in dist, its stylesheet 3,859 B beside it): dist 338,530 B -> 348,864 B, inside 406,500 B,
    // but the V1 wallet-test build, whose all lazy had 439 B of its test-only allowance left, goes to 419,375 B, 9,875 B over
    // 409,500 B. Raise all lazy to
    // 417,000 B: that overshoot rounded up to 0.5 kB plus one more 0.5 kB of headroom. No dependency, every other ceiling
    // unchanged (financial 272,632 B in dist and 348,561 B in .wallet-test-dist, inside 347,000 B and its 350,000 B).
    // Changed on purpose 2026-11-08 (the Points page's motion, the owner's animated prototype of 7 Nov: PROPOSAL.md §11,
    // src/points/motion.ts). The moments are Web Animations in the Points chunk alone (lazy, a financial root), which goes
    // from 10,230 B to 14,810 B gzip in dist (its stylesheet 3,890 -> 4,020 B); the initial entry does not move (244,407 B
    // in dist, 593 B under 245,000 B). Measured with gzip 9 on Windows, clean builds of all three directories on
    // ready/points-main: dist financial 277,222 B and all lazy 353,453 B, far inside; .wallet-test-v2-dist 278,833 B and
    // 355,272 B; but the V1 wallet-test build, the tightest, goes to financial 353,251 B (3,251 B over its 350,000 B) and
    // all lazy 424,088 B (4,088 B over 420,000 B). Raise financial to 351,000 B and all lazy to 422,000 B: each overshoot
    // rounded up to 0.5 kB plus one more 0.5 kB of headroom. No dependency, every other ceiling unchanged.
    // Changed on purpose 2026-11-09 (core flows, one PR of four areas after the friends' tests on the live site): close a
    // position whatever its automation (src/v2in/position/CloseSteps.tsx, the healing S1 gate), nothing loads forever
    // (src/lib/readWait.ts, src/v2in/lists/newPositionWait.ts, the wallet reconnect and fee-state deadlines, the token
    // page's stalled acquisitions), a sentence for each failure (src/v2/errors.ts walletNetworkFailure and the plan's
    // tokens) and Your APR's dust floor and batched ledger re-asks (src/lib/positionApr.ts, src/lib/fees/store.ts).
    // Measured with gzip 9 on Windows, clean builds of the merged branch against main d1538069 built the same way
    // (dist initial entry 244,923 B, domino v2 684,059 B): dist initial entry 245,196 B (+273 B, 196 B over 245,000 B),
    // dist domino v2 692,766 B (+8,707 B: close +3,782, errors +2,642, loading +2,098, APR +185; 8,266 B over 684,500 B),
    // .wallet-test-v2-dist session/public reads 171,842 B (342 B over 171,500 B). Raise the initial entry to 246,000 B,
    // session/public reads to 172,500 B and domino v2 to 694,000 B: each overshoot rounded up to 0.5 kB plus about one
    // more 0.5 kB of headroom. No dependency, every other ceiling unchanged.
    for (const [family, files, productionBudget] of [['initial entry', first, 246_000], ['route screens', routes, 191_000], ['session/public reads', base, 172_500], ['financial', financial, 351_000], ['pool history chart', poolChart, 13_000], ['all lazy', allLazy, 422_000], ['fees worker', worker, 28_000], ['chain code', chain, 4_000], ['walletconnect', walletConnect, 137_000], ['elysium section', elysium, 43_000], ['price range chart', priceChart, 7_000], ['domino v2', v2, 694_000], ['V2 fixture data', fixtureData, 13_000]]) {
      const total = [...files].reduce((sum, file) => sum + gzip(join(dir, 'assets', file)), 0);
      const testOnly = dir !== DIST && (family === 'financial' || family === 'all lazy');
      const budget = productionBudget + (testOnly ? 3_000 : 0) + (ELYSIUM_LIVE ? ELYSIUM_ALLOWANCE[family] ?? 0 : 0);
      if (dir === DIST) productionBytes.set(family, total);
      // The headroom is a diagnostic only, so the margin stays visible in every run; only the budget itself fails the test.
      t.diagnostic(`${label} ${family}: ${total} bytes gzip (${files.size} scripts; ${budget} budget; ${budget - total} bytes, ${((100 * (budget - total)) / budget).toFixed(1)}% headroom)`);
      // Compare instrumentation overhead between builds with the same V2 feature set. The legacy fixture still
      // counts every byte against its absolute budget; neither build discounts shared runtime or feature chunks.
      if (testOnly && dir === WALLET_V2 && total - productionBytes.get(family) > 3_000) budgetFailures.push(`${family}: V2 wallet test-only overhead exceeds 3 kB`);
      if (total > budget) budgetFailures.push(`${label} ${family} is ${total} bytes gzip, over the ${budget} budget`);
    }
  }
  assert.deepEqual(budgetFailures, [], 'every measured family must stay within its documented budget');
});
