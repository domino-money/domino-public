/**
 * Source-level guards for what this app must never contain. They are cheap and
 * blunt on purpose: a reviewer should never have to notice these by reading.
 * Comments are stripped first, so documentation may name what code may not use.
 */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, posix, relative, resolve } from 'node:path';
import { test } from 'node:test';

const SRC = resolve(import.meta.dirname, '../src');

/** Block comments, whole-line comments and trailing ` // ` comments. */
const stripComments = (text) =>
  text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/\s\/\/\s.*$/gm, '');

function sources(dir = SRC) {
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...sources(path));
    else if (/\.(ts|tsx)$/.test(entry.name)) {
      files.push({ path: relative(SRC, path).replaceAll('\\', '/'), code: stripComments(readFileSync(path, 'utf8')) });
    }
  }
  return files;
}
const ALL = sources();
const inside = (...dirs) => ALL.filter(({ path }) => dirs.some((dir) => path.startsWith(dir)));
const hits = (files, pattern) => files.flatMap(({ path, code }) => (pattern.test(code) ? [path] : []));
const specifiers = (code) => [...code.matchAll(/(?:from|import)\s*\(?\s*'([^']+)'/g)].map((match) => match[1]);

test('only closed financial adapters offer wallet transactions; login cannot spend', () => {
  // Any quote style, so a single-quoted literal is caught as well as a double one.
  const methods =
    /['"`](eth_sendTransaction|eth_signTransaction|eth_sendRawTransaction|eth_sign|eth_signTypedData(_v\d)?|wallet_sendCalls|wallet_addEthereumChain|wallet_watchAsset|eth_call|eth_estimateGas)['"`]/;
  // Changed on purpose (2026-09-24): finance/position.ts is the owner's collect and close, sent from the wallet to
  // Uniswap's pinned PositionManager, simulated and estimated first, through the same bounded client as setup.ts.
  // Changed on purpose (2026-09-25): finance/batch.ts offers the owner clients' one batch (wallet_sendCalls), shared by setup.ts and sequence.ts.
  // Changed on purpose (2026-10-01, the owner's OK on the audit's C1, C3 and C6):
  // - wallet/port.ts asks a wallet that does not know Robinhood Chain to add it (wallet_addEthereumChain), with the
  //   network's details fixed in wallet/chain.ts, before it switches: the only one of these methods it names;
  // - wallet/walletConnectMethods.ts lists what WalletConnect's transport forwards to a phone's wallet (what the wallet
  //   port and the money clients ask), and composes nothing;
  // - lib/chain/browser.ts's readOnChain admitted reads only, eth_call and eth_estimateGas among them. Changed on purpose
  //   2026-10-01 (RPC-SPEC D6 and §7.2): that file is gone; lib/walletReads.ts serves no read and names only
  //   eth_simulateV1 (tests/wallet-reads.test.mjs), so it names none of these.
  // Changed on purpose (2026-10-01, the chain2 workstream, part B): chains/elysium/signer.ts is the second chain's closed
  // signer: it sends exactly the transaction of a draft rugged97's actions service prepared, once, from the wallet the
  // person chose, and adds that chain to a wallet that does not know it (tests/elysium-signer.test.mjs). It is the only
  // file under chains/ that names any of these methods (tests/elysium-guards.test.mjs).
  // Changed on purpose (2026-10-01, fix round 3): finance/routedReplacement.ts reads Permit2's allowance for a replaced
  // routed swap's input (eth_call through the wallet's own provider, never the site's): a read, and the only one of these
  // methods it names. Merged 2026-10-02 with the RPC switch, which took lib/chain/browser.ts out of this list.
  assert.deepEqual(hits(ALL, methods), ['chains/elysium/signer.ts', 'finance/batch.ts', 'finance/position.ts', 'finance/routedReplacement.ts', 'finance/sequence.ts', 'finance/setup.ts', 'finance/wallet.ts', 'wallet/port.ts', 'wallet/walletConnectMethods.ts']);
  const named = (path) => [...new Set([...ALL.find((f) => f.path === path).code.matchAll(new RegExp(methods.source, 'g'))].map((m) => m[1]))].sort();
  assert.deepEqual(named('chains/elysium/signer.ts'), ['eth_sendTransaction', 'wallet_addEthereumChain'], 'the draft\'s one transaction, and the chain\'s details');
  const signer = ALL.find((f) => f.path === 'chains/elysium/signer.ts').code;
  assert.deepEqual([...signer.matchAll(/method: '([^']+)'/g)].map((m) => m[1]), ['eth_accounts', 'eth_getCode', 'eth_sendTransaction', 'wallet_addEthereumChain'], 'what the signer itself asks the chosen wallet');
  assert.deepEqual([...signer.matchAll(/quantity\(provider, '([^']+)'/g)].map((m) => m[1]), ['eth_getTransactionCount'], 'and the account\'s pending nonce, read before the send');
  assert.match(signer, /method: 'wallet_addEthereumChain', params: \[addChainParameters\(chain\)\]/, 'the registry\'s network details only');
  assert.deepEqual(hits(inside('chains/'), methods), ['chains/elysium/signer.ts'], 'nothing else of the second chain\'s section names a wallet transaction method');
  assert.deepEqual(named('wallet/port.ts'), ['wallet_addEthereumChain'], 'the switch adds the network, and nothing else');
  assert.deepEqual(hits(inside('lib/'), methods), [], 'the page’s own modules name none: the site serves the wallet no read (RPC-SPEC D6)');
  assert.deepEqual(named('finance/routedReplacement.ts'), ['eth_call'], 'a read only: the allowance a replaced swap would spend');
  assert.deepEqual(named('wallet/walletConnectMethods.ts'), ['eth_sendTransaction', 'wallet_addEthereumChain', 'wallet_sendCalls']);
  assert.deepEqual(hits(inside('session/', 'components/wallet/'), methods), [], 'login still cannot spend');
  assert.deepEqual(hits(inside('wallet/'), methods), ['wallet/port.ts', 'wallet/walletConnectMethods.ts'], 'the wallet layer adds the network and forwards; it composes nothing');
  assert.match(ALL.find((f) => f.path === 'wallet/port.ts').code, /method: 'wallet_addEthereumChain', params: \[ADD_ROBINHOOD_CHAIN\]/, 'the fixed network details only');
  assert.deepEqual([...ALL.find(f => f.path === 'finance/wallet.ts').code.matchAll(/method: '([^']+)'/g)].map(m => m[1]), ['eth_accounts', 'eth_chainId', 'eth_sendTransaction']);
});

// 2026-10-01 (audit C3): what WalletConnect forwards to a phone's wallet is this list, and only its transport uses it.
test('WalletConnect forwards exactly the wallet requests the app already makes, and reads go to the page', () => {
  const list = ALL.find((f) => f.path === 'wallet/walletConnectMethods.ts').code;
  assert.deepEqual([...list.matchAll(/'([a-z]+_[A-Za-z]+)'/g)].map((m) => m[1]),
    ['personal_sign', 'eth_sendTransaction', 'wallet_switchEthereumChain', 'wallet_addEthereumChain', 'wallet_getCapabilities', 'wallet_sendCalls', 'wallet_getCallsStatus']);
  const users = ALL.filter(({ code }) => /walletConnectMethods/.test(code)).map(({ path }) => path);
  assert.deepEqual(users, ['wallet/walletConnectFake.ts', 'wallet/walletConnectProvider.ts']);
  for (const path of users) {
    const code = ALL.find((f) => f.path === path).code;
    assert.match(code, /if \(!FORWARDED\.includes\(method\)\) return options\.read\(method, list\)/, `${path}: anything not forwarded is a read of the chain`);
    assert.doesNotMatch(code, /\b(sendTransaction|writeContract|signTypedData|encodeFunctionData)\b/, `${path} composes nothing`);
  }
  // The real client is reached only through the connector's dynamic import, and the fake only in test builds.
  const connector = ALL.find((f) => f.path === 'wallet/walletConnect.ts').code;
  assert.match(connector, /__DOMINO_TEST_HOOKS__ \? import\('\.\/walletConnectFake'\) : import\('\.\/walletConnectProvider'\)/);
  assert.deepEqual(ALL.filter(({ code }) => /['"]\.{1,2}\/(?:wallet\/)?walletConnectProvider['"]/.test(code.replace(/import type[^\n]*\n/g, ''))).map(({ path }) => path), ['wallet/walletConnect.ts']);
  assert.match(ALL.find((f) => f.path === 'config/walletConnect.ts').code, /export const WALLETCONNECT_PROJECT_ID = '[0-9a-f]{0,32}'/);
});

test('batches (EIP-5792) are asked for, offered and read back only by the closed batch module the owner clients share', () => {
  // Changed on purpose (2026-09-25): Create position's one-signature batch (docs/plans/2026-09-25-eip5792-batches-design.md)
  // reads what the wallet can batch, offers one batch and reads its status. Since the sequence's creation batches too, both
  // clients (finance/setup.ts, finance/sequence.ts) go through finance/batch.ts; login and every screen name none of these.
  const batch = /['"`](wallet_sendCalls|wallet_getCallsStatus|wallet_getCapabilities|wallet_showCallsStatus)['"`]/;
  // 2026-10-01 (audit C3): and WalletConnect's forward list, which passes finance/batch.ts's requests to a phone's wallet.
  assert.deepEqual(hits(ALL, batch), ['finance/batch.ts', 'wallet/walletConnectMethods.ts']);
});

test('exact approvals are confined to the closed setup, Permit2 and sequence ABIs', () => {
  // The closed ABIs are JSON (so the page ships no ABI parser): an approval is declared as an item named approve.
  const apis =
    /\b(sendTransaction|writeContract|sendCalls|signTypedData|simulateContract|useSendTransaction|useWriteContract|useSignTypedData|approve\s*\()|\bname:\s*['"`]approve['"`]/;
  assert.deepEqual(hits(ALL, apis), ['finance/routedSwap.ts', 'finance/sequence.ts', 'finance/setup.ts'], 'only the closed owner ABIs and exact-amount Permit2 adapter declare approvals');
  const route = ALL.find(file => file.path === 'finance/routedSwap.ts').code;
  assert.match(route, /approval\.spender !== ROUTE_PERMIT2/);
  assert.match(route, /BigInt\(approval\.amountRaw\) !== gross/);
  assert.match(route, /args: \[tokenIn, UNIVERSAL_ROUTER, gross, Number\(deadline\)\]/);
});

test('no connector SDK, public chain definition or network transport is used', () => {
  const packages = /^(viem\/chains|wagmi\/chains|wagmi\/connectors|@wagmi\/connectors|@walletconnect\/|@coinbase\/|@metamask\/|@base-org\/|@safe-global\/)/;
  const imported = ALL.flatMap(({ path, code }) => specifiers(code).filter((spec) => packages.test(spec)).map((spec) => `${path}: ${spec}`));
  // Changed on purpose (2026-10-01, audit C3, the owner's OK): WalletConnect's own client, in the one module the
  // connector loads on demand (wallet/walletConnect.ts); no wagmi connector package and no other SDK.
  assert.deepEqual(imported, ['wallet/walletConnectProvider.ts: @walletconnect/sign-client']);
  // Changed on purpose (2026-10-01, audit C9): one injected connector, aimed at window.ethereum alone, for a browser
  // wallet that announces nothing through EIP-6963 (wallet/port.ts offerLegacy).
  assert.deepEqual(hits(ALL, /\b(walletConnect|coinbaseWallet|metaMask|baseAccount|injected)\s*\(/), ['wallet/port.ts']);
  assert.equal([...ALL.find((f) => f.path === 'wallet/port.ts').code.matchAll(/\binjected\s*\(/g)].length, 1);
  // viem's network transports. `custom` over the wallet's own provider is the only one allowed.
  assert.deepEqual(hits(inside('session/', 'wallet/', 'components/wallet/'), /\b(http|webSocket|fallback|createPublicClient)\s*\(/), []);
});

test('nothing renders HTML from strings', () => {
  assert.deepEqual(hits(ALL, /dangerouslySetInnerHTML|innerHTML\s*=/), []);
});

test('session and wallet code never touches browser storage, but for the wallet ids the owner allowed', () => {
  const files = inside('session/', 'wallet/', 'components/wallet/');
  assert.ok(files.length > 5);
  // Changed on purpose (2026-10-01, audit C11, the owner's OK): wallet/memory.ts keeps which wallets the person
  // disconnected here and which one connected last, as wallet ids under one key, never an address
  // (tests/wallet-compat.test.mjs checks what it writes).
  assert.deepEqual(hits(files, /\b(localStorage|sessionStorage|indexedDB|document\.cookie)\b/), ['wallet/memory.ts']);
  const memory = ALL.find((f) => f.path === 'wallet/memory.ts').code;
  assert.deepEqual([...memory.matchAll(/\b(localStorage|sessionStorage|indexedDB|document\.cookie)\b/g)].map((m) => m[1]), ['localStorage']);
  assert.match(memory, /export const MEMORY_KEY = 'domino\.wallet\.v1'/);
});

test('wallet-provided names and icons never become a URL or an image', () => {
  const files = inside('components/wallet/');
  assert.deepEqual(hits(files, /\.icon\b/), [], 'the EIP-6963 icon is untrusted and must not be used');
  assert.deepEqual(hits(files, /\b(src|href)=\{/), []);
});

test('only session/contract.ts imports the session package at runtime; everything else imports types', () => {
  // The read adapter (src/lib/read) imports read-v1 at runtime in its own
  // builds; this guard is about the session package.
  const valueImports = ALL.filter(({ code }) => /^import\s+(?!type\b)[^;]*from\s+'api-contracts\/session-v1\//m.test(code)).map(({ path }) => path);
  assert.deepEqual(valueImports, ['session/contract.ts']);
});

test('the wallet feature is reached only through the build flag', () => {
  const importers = ALL.filter(({ code }) => /import\(\s*'\.\/wallet\/WalletSessionIsland'\s*\)/.test(code));
  assert.deepEqual(importers.map(({ path }) => path), ['components/Header.tsx']);
  // Changed on purpose 2026-09-28 (speed wave B, item 24): opened by components/Deferred.tsx's loader, which draws it as
  // soon as its chunk is in, not 300 ms after its fallback as a Suspense boundary reveals a lazy one; still behind the flag.
  assert.match(importers[0].code, /__DOMINO_WALLET_SESSION__\s*\?\s*deferred\(/);
  const localImporters = ALL.filter(({ code }) => /import\(\s*'\.\/wallet\/LocalWalletIsland'\s*\)/.test(code));
  assert.deepEqual(localImporters.map(({ path }) => path), ['components/Header.tsx']);
  assert.match(localImporters[0].code, /__DOMINO_LOCAL_LIVE__\s*\?\s*lazy\(/);
  const local = ALL.find(({ path }) => path === 'components/wallet/LocalWalletIsland.tsx');
  assert.ok(local);
  assert.doesNotMatch(local.code, /\b(useSession|sessionController|signLoginMessage|switchToRobinhood|signMessage|privateQueryClient|createSessionApi)\b/);
  assert.doesNotMatch(local.code, /\/api\/|wallet\/session|session\/controller|session\/privateQuery/);

  // Outside the feature, nothing imports wagmi, viem, TanStack Query or the
  // session modules statically. The error boundary is plain React and is the
  // one wallet component the header may import directly.
  // Review's last control, Create position, signs through the wallet (components/create/CreatePosition.tsx, in the
  // chunk components/create/DepositAmounts.tsx names), so both are part of the wallet feature, written with or
  // without their extension so that their importers are checked too. Only Review opens that chunk, lazily behind
  // the build flag (below). Changed on purpose (owner, 2026-09-22): Review's deposit amounts, and with them
  // StageBalance.tsx, the second part that opened the chunk, were deleted.
  // Changed on purpose (2026-09-24): the owner's position actions (Collect fees, Close position) and the refund of a
  // held setup deposit sign through the wallet too (components/positions/PositionActions.tsx and HeldDeposits.tsx),
  // written with or without their extension like Create position's chunk, so their importers are checked (below);
  // screens/PositionLab.tsx mounts them alone in test builds only (App.tsx, behind __DOMINO_TEST_HOOKS__).
  // Changed on purpose (owner, 2026-09-25): a sequence's Turn on and Pause (components/positions/SequenceSwitch.tsx) sign
  // through the wallet and ask the automation service through the session; only the owner's actions and the automation
  // page's success, both wallet feature code already, show it.
  // Changed on purpose (2026-10-02, rugged97's spec rev3 §2.13): the fees waiting in a vault and their withdrawal
  // (components/positions/FeeReserves.tsx) sign through the wallet too; Positions and a position's page open it lazily.
  const feature = /^(session|wallet|finance|components\/wallet)\/|^screens\/(Setup|AdvancedSetup|WalletDeposit|Performance|Execution|Sequence|SequenceCreate|PositionLab)\.tsx$|^components\/create\/(DepositAmounts|CreatePosition)(\.tsx)?$|^components\/positions\/(PositionActions|HeldDeposits|SequenceSwitch|FeeReserves)(\.tsx)?$/;
  // The onboarding previews and the deposit consumer (#38, #40/#44) read the
  // session through session/port.ts, and the preview screen also through
  // session/livePort.ts. Their lab screens live in chunks of the consumer-test
  // build only; consumer.guard and consumer.bundle prove neither lab reaches a
  // deployable one. The onboarding modules themselves now also ship, lazily,
  // under Setup's swap quote (G15), which hands them the live port. This is a
  // named exception, not an opening of the feature.
  const consumer = /^(onboarding|deposit|components\/(preview|deposit|consumer))\/|^screens\/(LivePreview|Deposits)\.tsx$/;
  const consumerMayUse = (path, target) =>
    consumer.test(path) && (target === 'session/port' || (path === 'screens/LivePreview.tsx' && target === 'session/livePort'));
  const reviewOpens = (path, spec) => path === 'components/create/StageReview.tsx' && spec === './DepositAmounts';
  // Changed on purpose (owner, 2026-09-24): a position's page opens the owner's Collect fees and Close position, and
  // Positions opens the held deposits with their refund, each as a lazy chunk behind the flag (asserted below). Named
  // here so that the importer check admits them once the position-actions branch makes the two files wallet feature code.
  // Changed on purpose 2026-10-02: both also open the fees waiting in a vault (FeeReserves), the same way.
  const POSITION_CHUNKS = { 'screens/PositionDetail.tsx': ['../components/positions/PositionActions', '../components/positions/FeeReserves'], 'screens/Positions.tsx': ['../components/positions/HeldDeposits', '../components/positions/FeeReserves'] };
  const positionsOpens = (path, spec) => POSITION_CHUNKS[path]?.includes(spec) ?? false;
  // Changed on purpose (2026-09-28, the owner's phone: Your positions stayed on its loading rows while the RPC refused his
  // address): the list, itself opened only behind the flag (Positions.tsx), keeps its display copy with the private
  // cards' keep, readKept and drop (finance/privateCards.ts), a module that names no wallet code (asserted here).
  // Changed on purpose 2026-10-01 (fees item A15): a position's page reads that same copy (readKept only) to draw its
  // header, dated and with no action, until its own chain read answers.
  const listKeeps = (path, spec) => (path === 'components/positions/OwnedPositions.tsx' && spec === '../../finance/privateCards') || (path === 'screens/PositionDetail.tsx' && spec === '../finance/privateCards');
  const keeper = ALL.find(({ path }) => path === 'finance/privateCards.ts');
  assert.deepEqual(specifiers(keeper.code), ['react', '../lib/walletIdentity'], 'the copies’ module imports React and the wallet’s address, nothing of the wallet feature');
  const offenders = [];
  for (const { path, code } of ALL.filter(({ path }) => !feature.test(path))) {
    for (const spec of specifiers(code)) {
      if (/^(wagmi|viem|@tanstack\/)/.test(spec)) offenders.push(`${path}: ${spec}`);
      if (!spec.startsWith('.')) continue;
      const target = posix.normalize(posix.join(posix.dirname(path), spec));
      if (feature.test(target) && target !== 'components/wallet/WalletBoundary' && spec !== './wallet/WalletSessionIsland' && spec !== './wallet/LocalWalletIsland' && !consumerMayUse(path, target) && !reviewOpens(path, spec) && !positionsOpens(path, spec) && !listKeeps(path, spec)) {
        offenders.push(`${path}: ${spec}`);
      }
    }
  }
  assert.deepEqual(offenders, []);
  assert.equal(ALL.some(({ path }) => path === 'components/create/StageBalance.tsx'), false, 'the deposit amounts section is gone');
  for (const path of ['components/create/StageReview.tsx']) {
    const { code } = ALL.find((file) => file.path === path);
    assert.match(code, /__DOMINO_WALLET_SESSION__\s*\?\s*lazy\(\(\)\s*=>\s*import\('\.\/DepositAmounts'\)/, `${path} opens Create position lazily, behind the flag`);
    // reviewOpens admits the specifier, and specifiers() cannot tell a static import from import(): every mention must be the lazy one,
    // so a static `from './DepositAmounts'` (or a bare import of it) beside the lazy import still fails here, before any build.
    const mentions = [...code.matchAll(/['"`]\.\/DepositAmounts(?:\.tsx?)?['"`]/g)].length;
    const lazy = [...code.matchAll(/import\(\s*['"`]\.\/DepositAmounts(?:\.tsx?)?['"`]\s*\)/g)].length;
    // Changed on purpose 2026-09-28 (speed wave, study item 33): Review's chunk is also asked ahead once a pool is chosen
    // (preloadCreateControl), with the same import() behind the same flag, so it is named twice, both times in import().
    assert.match(code, /export const preloadCreateControl = __DOMINO_WALLET_SESSION__\s*\?\s*\(\)\s*=>\s*void import\('\.\/DepositAmounts'\)/, `${path} asks Create position's chunk ahead only behind the flag`);
    assert.deepEqual([mentions, lazy], [2, 2], `${path} names Create position's chunk only in its two import() calls`);
  }
  for (const [path, spec] of Object.entries(POSITION_CHUNKS).flatMap(([path, specs]) => specs.map((spec) => [path, spec]))) {
    const { code } = ALL.find((file) => file.path === path);
    const quoted = spec.replaceAll('.', '\\.').replaceAll('/', '\\/');
    // 2026-10-01 (D1): the loader may be wrapped in recovering() (lib/staleRelease.ts); the same import, behind the same flag.
    assert.match(code, new RegExp(`__DOMINO_WALLET_SESSION__\\s*\\?\\s*lazy(?:<[^\\n]*?>)?\\((?:recovering\\()?\\(\\)\\s*=>\\s*import\\('${quoted}'\\)`), `${path} opens ${spec} lazily, behind the flag`);
    const mentions = [...code.matchAll(new RegExp(`['"\`]${quoted}(?:\\.tsx?)?['"\`]`, 'g'))].length;
    assert.equal(mentions, 1, `${path} names ${spec} once, in its lazy import(), and imports nothing else from it, types included`);
  }
});

// Added 2026-09-24 with the owner's position actions (components/positions/PositionActions.tsx: Collect fees and
// Close position; components/positions/HeldDeposits.tsx: the refund of a held setup deposit). Like Create position's
// chunk, whichever screen opens them does it lazily behind the wallet flag, naming each once, so a build without the
// wallet never loads them. Type-only imports are erased and are not an opening. Their lab screen is test-only.
test('the position actions are opened only lazily behind the wallet flag, and their lab only in test builds', () => {
  // Changed on purpose 2026-10-02: and the fees waiting in a vault, with their withdrawal (FeeReserves).
  const target = /^components\/positions\/(PositionActions|HeldDeposits|FeeReserves)$/;
  const openers = [];
  for (const { path, code } of ALL) {
    if (/^components\/positions\/(PositionActions|HeldDeposits|FeeReserves)\.tsx$/.test(path)) continue;
    const values = code.replace(/^import\s+type\s[^;]*?from\s*'[^']+';?$/gm, '');
    for (const spec of new Set(specifiers(values))) {
      if (!spec.startsWith('.') || !target.test(posix.normalize(posix.join(posix.dirname(path), spec)).replace(/\.tsx?$/, ''))) continue;
      openers.push(path);
      const quoted = spec.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      // 2026-09-24 (merge): an explicit type argument, lazy<ComponentType<Props>>(...), types the chunk from the opener's own props.
      // 2026-10-01 (D1): the loader may be wrapped in recovering() (lib/staleRelease.ts); the same import, behind the same flag.
      assert.match(values, new RegExp(`__DOMINO_WALLET_SESSION__\\s*\\?\\s*lazy(?:<[^\\n]*?>)?\\((?:recovering\\()?\\(\\)\\s*=>\\s*import\\('${quoted}'\\)`), `${path} opens ${spec} lazily, behind the wallet flag`);
      const mentions = [...values.matchAll(new RegExp(`['"\`]${quoted}['"\`]`, 'g'))].length;
      const lazy = [...values.matchAll(new RegExp(`import\\(\\s*['"\`]${quoted}['"\`]\\s*\\)`, 'g'))].length;
      assert.deepEqual([mentions, lazy], [1, 1], `${path} names ${spec} once, in its lazy import()`);
    }
  }
  assert.ok(openers.includes('screens/PositionLab.tsx'), openers.join(', '));
  const labOpeners = ALL.filter(({ code }) => /['"`]\.\/screens\/PositionLab(?:\.tsx?)?['"`]/.test(code)).map(({ path }) => path);
  assert.deepEqual(labOpeners, ['App.tsx'], 'only the app routes to the lab');
  assert.match(ALL.find(({ path }) => path === 'App.tsx').code, /const PositionLab = __DOMINO_TEST_HOOKS__\s*\?\s*lazy\((?:recovering\()?\(\)\s*=>\s*import\('\.\/screens\/PositionLab'\)/, 'the lab exists only where the test hooks do');
});

// 2026-10-01 (audit C16): every wallet the logo names has its local artwork, inert SVG with its provenance recorded.
test('each wallet logo is a local, inert SVG named in the provenance notes', () => {
  const logo = ALL.find(({ path }) => path === 'components/wallet/WalletLogo.tsx').code;
  const files = [...logo.matchAll(/src="\/wallets\/([a-z0-9-]+\.svg)"/g)].map((match) => match[1]);
  for (const name of ['coinbase.svg', 'okx.svg', 'trust.svg', 'walletconnect.svg', 'metamask.svg', 'rabby.svg']) assert.ok(files.includes(name), name);
  const provenance = readFileSync(resolve(SRC, '../public/wallets/PROVENANCE.md'), 'utf8');
  for (const name of files) {
    const svg = readFileSync(resolve(SRC, '../public/wallets', name), 'utf8');
    assert.match(svg, /^<svg[\s>]/, name);
    assert.doesNotMatch(svg, /<script|\son[a-z]+=|href=|<image|<foreignObject/i, name);
    assert.ok(provenance.includes(name), `${name} has its source in PROVENANCE.md`);
  }
});
