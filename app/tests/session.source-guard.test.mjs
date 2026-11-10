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
// Changed on purpose (data) 2026-10-02 (Domino V2, spec F7 §1.8 and D15): the V2 modules (src/v2, src/finance/v2) are
// held to their own, narrower lists in the V2 test at the end of this file; the V1 lists below are about V1's files.
const V2_PATH = /^(v2|finance\/v2)\//;
const V1 = ALL.filter(({ path }) => !V2_PATH.test(path));
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
  assert.deepEqual(hits(V1, methods), ['chains/elysium/signer.ts', 'finance/batch.ts', 'finance/position.ts', 'finance/routedReplacement.ts', 'finance/sequence.ts', 'finance/setup.ts', 'finance/wallet.ts', 'wallet/port.ts', 'wallet/walletConnectMethods.ts']);
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
  // Changed on purpose 2026-10-04 (rugged97's delta of 4 Oct §5, D15): the list forwards V2's EIP-712 signature too.
  assert.deepEqual(named('wallet/walletConnectMethods.ts'), ['eth_sendTransaction', 'eth_signTypedData_v4', 'wallet_addEthereumChain', 'wallet_sendCalls']);
  assert.deepEqual(hits(inside('session/', 'components/wallet/'), methods), [], 'login still cannot spend');
  assert.deepEqual(hits(inside('wallet/'), methods), ['wallet/port.ts', 'wallet/walletConnectMethods.ts'], 'the wallet layer adds the network and forwards; it composes nothing');
  assert.match(ALL.find((f) => f.path === 'wallet/port.ts').code, /method: 'wallet_addEthereumChain', params: \[ADD_ROBINHOOD_CHAIN\]/, 'the fixed network details only');
  assert.deepEqual([...ALL.find(f => f.path === 'finance/wallet.ts').code.matchAll(/method: '([^']+)'/g)].map(m => m[1]), ['eth_accounts', 'eth_chainId', 'eth_sendTransaction']);
});

// 2026-10-01 (audit C3): what WalletConnect forwards to a phone's wallet is this list, and only its transport uses it.
test('WalletConnect forwards exactly the wallet requests the app already makes, and reads go to the page', () => {
  const list = ALL.find((f) => f.path === 'wallet/walletConnectMethods.ts').code;
  // Changed on purpose 2026-10-04 (rugged97's delta of 4 Oct §5, D15): eth_signTypedData_v4 joins, forwarded only (its
  // one asker is finance/v2/typedData.ts, below); the pattern reads a method's digits and underscores too.
  assert.deepEqual([...list.matchAll(/'([a-z]+_[A-Za-z0-9_]+)'/g)].map((m) => m[1]),
    ['personal_sign', 'eth_sendTransaction', 'wallet_switchEthereumChain', 'wallet_addEthereumChain', 'wallet_getCapabilities', 'wallet_sendCalls', 'wallet_getCallsStatus', 'eth_signTypedData_v4']);
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
  assert.deepEqual(hits(V1, apis), ['finance/routedSwap.ts', 'finance/sequence.ts', 'finance/setup.ts'], 'only the closed owner ABIs and exact-amount Permit2 adapter declare approvals');
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
  // Changed on purpose 2026-10-30 (QA round 2, N56): the one built link is the wallet apps' (WalletSessionDialog.tsx
  // WalletApps): each wallet's fixed link, on the fixed site, followed by the open route only when it passes the access
  // gate's own pattern (tests/wallet-compat.test.mjs checks the hosts and the pattern). No wallet-provided value is in it.
  assert.deepEqual(hits(files, /\b(src|href)=\{/), ['components/wallet/WalletSessionDialog.tsx']);
  const dialog = files.find((f) => f.path === 'components/wallet/WalletSessionDialog.tsx').code;
  assert.deepEqual([...dialog.matchAll(/\b(?:src|href)=\{([^}]*)\}/g)].map((m) => m[1]), ['href'], 'only the wallet apps\' links');
  assert.match(dialog, /\{apps\.map\(\(\[id, name, href\]\) => \(/);
});

test('only session/contract.ts imports the session package at runtime; everything else imports types', () => {
  // The read adapter (src/lib/read) imports read-v1 at runtime in its own
  // builds; this guard is about the session package.
  const valueImports = ALL.filter(({ code }) => /^import\s+(?!type\b)[^;]*from\s+'api-contracts\/session-v1\//m.test(code)).map(({ path }) => path);
  assert.deepEqual(valueImports, ['session/contract.ts']);
});

test('the wallet feature is reached only through the build flag', () => {
  // Changed on purpose (data) 2026-10-02 (Domino V2 integration, item 6): the old #/v2 screens (v2ui, App.tsx's one
  // importer) are gone; the integrated V2 modules are held by the V2 integration tests at the end of this file.
  assert.equal(ALL.some(({ path }) => path.startsWith('v2ui/')), false, 'the old #/v2 screens are gone');
  assert.equal(ALL.some(({ code }) => /['"`][./]*v2ui\//.test(code)), false, 'and nothing names them');
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
  // Changed on purpose (data) 2026-10-02 (Domino V2 integration): v2in/ is the integrated V2 modules, mounted in the existing
  // screens; wallet feature code (they drive finance/v2's clients). A V1 file opens one only lazily, behind the bare
  // __DOMINO_V2__ define, on the same line (v2InOpens, held by the V2 integration test below), so every deployable build
  // carries none of them. (The old #/v2 screens, v2ui/, were admitted the same way until item 6 removed them.)
  // Changed on purpose (2026-10-02, rugged97's spec rev3 §2.13): the fees waiting in a vault and their withdrawal
  // (components/positions/FeeReserves.tsx) sign through the wallet too; Positions and a position's page open it lazily.
  // Changed on purpose 2026-11-07 (the owner's Points page, Season 1): screens/Points.tsx reads the signed-in session and
  // asks the wallet to sign a referral link (finance/points.ts), so it is wallet feature code too; App.tsx opens it only
  // lazily, behind __DOMINO_WALLET_SESSION__ (asserted below).
  const feature = /^(session|wallet|finance|components\/wallet|v2in)\/|^screens\/(Setup|AdvancedSetup|WalletDeposit|Performance|Execution|Points|Sequence|SequenceCreate|SequenceLegacy|SequenceShell|PositionLab)\.tsx$|^components\/create\/(DepositAmounts|CreatePosition)(\.tsx)?$|^components\/positions\/(PositionActions|HeldDeposits|SequenceSwitch|FeeReserves)(\.tsx)?$/;
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
  const v2InOpens = (path, target) => target.startsWith('v2in/');
  const listKeeps = (path, spec) => (path === 'components/positions/OwnedPositions.tsx' && spec === '../../finance/privateCards') || (path === 'screens/PositionDetail.tsx' && spec === '../finance/privateCards');
  const keeper = ALL.find(({ path }) => path === 'finance/privateCards.ts');
  assert.deepEqual(specifiers(keeper.code), ['react', '../lib/walletIdentity'], 'the copies’ module imports React and the wallet’s address, nothing of the wallet feature');
  const offenders = [];
  for (const { path, code } of ALL.filter(({ path }) => !feature.test(path))) {
    for (const spec of specifiers(code)) {
      if (/^(wagmi|viem|@tanstack\/)/.test(spec)) offenders.push(`${path}: ${spec}`);
      if (!spec.startsWith('.')) continue;
      const target = posix.normalize(posix.join(posix.dirname(path), spec));
      if (feature.test(target) && target !== 'components/wallet/WalletBoundary' && spec !== './wallet/WalletSessionIsland' && spec !== './wallet/LocalWalletIsland' && !consumerMayUse(path, target) && !reviewOpens(path, spec) && !positionsOpens(path, spec) && !listKeeps(path, spec) && !v2InOpens(path, target)) {
        offenders.push(`${path}: ${spec}`);
      }
    }
  }
  assert.deepEqual(offenders, []);
  // Changed on purpose (data) 2026-10-02 (Domino V2 integration): a V1 file names a v2in module only inside
  // `__DOMINO_V2__ ? lazy(() => import('…/v2in/…'))` (recovering() allowed), never a static import, types included.
  // Changed on purpose (data) 2026-10-02 (the lists): `deferred(...)` (components/Deferred.tsx, the same lazy opening without a
  // Suspense boundary) counts as lazy too; OwnedPositions.tsx and Positions.tsx open the lists' rows that way.
  for (const { path, code } of ALL.filter(({ path }) => !feature.test(path) || /^screens\/(Sequence|SequenceCreate|SequenceLegacy|SequenceShell)\.tsx$/.test(path))) {
    const mentions = [...code.matchAll(/['"`]((?:\.\.?\/)+v2in\/[^'"`]+)['"`]/g)].length;
    if (mentions === 0) continue;
    const lazy = [...code.matchAll(/__DOMINO_V2__\s*\?\s*(?:lazy|deferred)(?:<[^\n]*?>)?\((?:recovering\()?\(\)\s*=>\s*import\('(?:\.\.?\/)+v2in\/[^']+'\)/g)].length;
    assert.equal(mentions, lazy, `${path} names src/v2in only in lazy imports behind __DOMINO_V2__`);
  }
  assert.equal(ALL.some(({ path }) => path === 'components/create/StageBalance.tsx'), false, 'the deposit amounts section is gone');
  for (const path of ['components/create/StageReview.tsx']) {
    const { code } = ALL.find((file) => file.path === path);
    assert.match(code, /__DOMINO_WALLET_SESSION__\s*&&\s*!__DOMINO_V2__\s*\?\s*lazy\(\(\)\s*=>\s*import\('\.\/DepositAmounts'\)/, `${path} opens retired Create position only in the non-V2 wallet harness`);
    // reviewOpens admits the specifier, and specifiers() cannot tell a static import from import(): every mention must be the lazy one,
    // so a static `from './DepositAmounts'` (or a bare import of it) beside the lazy import still fails here, before any build.
    const mentions = [...code.matchAll(/['"`]\.\/DepositAmounts(?:\.tsx?)?['"`]/g)].length;
    const lazy = [...code.matchAll(/import\(\s*['"`]\.\/DepositAmounts(?:\.tsx?)?['"`]\s*\)/g)].length;
    // Changed on purpose 2026-09-28 (speed wave, study item 33): Review's chunk is also asked ahead once a pool is chosen
    // (preloadCreateControl), with the same import() behind the same flag, so it is named twice, both times in import().
    assert.match(code, /export const preloadCreateControl = __DOMINO_WALLET_SESSION__\s*&&\s*!__DOMINO_V2__\s*\?\s*\(\)\s*=>\s*void import\('\.\/DepositAmounts'\)/, `${path} preloads retired Create position only in the non-V2 wallet harness`);
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

// Changed on purpose (data) 2026-10-02 (Domino V2, spec F7 §1.8, D15): V2 needs EIP-712 signatures in three places (the
// Permit2 batch witness, RelayedPositionAction and ExitMandate). One closed module, finance/v2/typedData.ts, is the only
// file in the app that names eth_signTypedData_v4; the V2 money clients (finance/v2/zap.ts, vault.ts, autoExit.ts) join
// the transaction methods' list as the V1 clients did; the pure V2 modules (src/v2) name no wallet method at all. No V2
// file offers a batch itself: batches stay finance/batch.ts's (generalized per chain in PHASE B).
test('V2: one closed module signs typed data, the closed V2 clients alone name transaction methods, and src/v2 names none', () => {
  const methods =
    /['"`](eth_sendTransaction|eth_signTransaction|eth_sendRawTransaction|eth_sign|eth_signTypedData(_v\d)?|wallet_sendCalls|wallet_addEthereumChain|wallet_watchAsset|eth_call|eth_estimateGas)['"`]/;
  // finance/v2/transact.ts is the three clients' one shared sender (simulate, estimate, the nonce, the chain read last,
  // one eth_sendTransaction), so the discipline lives in one place; it is held to exactly the methods it names (below).
  // Changed on purpose (data) 2026-10-02 (Domino V2 PHASE B, B5 S2, spec F7 §3.6): finance/v2/crosschain.ts, the closed
  // sender of a deposit's two transactions on its ORIGIN chain (any EVM chain the origins listing names), joins; it is
  // held to exactly the methods it names (below).
  // Changed on purpose (data) 2026-10-02 (Domino V2 S1, B2.4): finance/v2/direct.ts joins, the owner's direct exit to both
  // tokens and collect at Uniswap's own position manager (spec F7 §2.6.4), sent through the same shared sender.
  // Changed on purpose (data) 2026-10-02 (S2 holdings): finance/v2/holdings.ts joins as a read only, like V1's
  // finance/routedReplacement.ts: what the wallet holds on another network (ETH, WETH, USDC), read through the wallet's
  // own provider after the wallet switched there (the owner's decision #9; the site reads no public RPC), eth_call for
  // balanceOf the only one of these methods it names; it switches nothing (wallet/port's switch is handed in) and sends
  // nothing (asserted below).
  const V2_CLOSED = ['finance/v2/autoExit.ts', 'finance/v2/crosschain.ts', 'finance/v2/direct.ts', 'finance/v2/holdings.ts', 'finance/v2/transact.ts', 'finance/v2/typedData.ts', 'finance/v2/vault.ts', 'finance/v2/zap.ts'];
  const v2 = ALL.filter(({ path }) => V2_PATH.test(path));
  assert.ok(v2.some(({ path }) => path === 'finance/v2/typedData.ts'));
  const offering = hits(v2, methods);
  assert.deepEqual(offering.filter((path) => !V2_CLOSED.includes(path)), [], 'only the closed V2 clients name transaction methods');
  // Changed on purpose 2026-10-04 (rugged97's delta of 4 Oct §5, D15): WalletConnect's list names the method to forward
  // it to a phone's wallet; it composes and asks nothing (the WalletConnect test above). One module still signs.
  assert.deepEqual(hits(ALL, /['"`]eth_signTypedData(_v\d)?['"`]/), ['finance/v2/typedData.ts', 'wallet/walletConnectMethods.ts'], 'one module signs typed data; WalletConnect only forwards it');
  assert.deepEqual(hits(ALL, /request\(\s*['"`]eth_signTypedData(_v\d)?['"`]/), ['finance/v2/typedData.ts'], 'and only that module asks it');
  assert.deepEqual(hits(ALL, /['"`]eth_sign['"`]|personal_sign['"`]/).filter((path) => V2_PATH.test(path)), [], 'V2 signs no message');
  const typedData = ALL.find(({ path }) => path === 'finance/v2/typedData.ts').code;
  assert.deepEqual([...typedData.matchAll(/request\('([^']+)'/g)].map((m) => m[1]), ['eth_accounts', 'eth_chainId', 'eth_signTypedData_v4'], 'the signer reads the account and the chain, then asks once');
  const transact = ALL.find(({ path }) => path === 'finance/v2/transact.ts').code;
  assert.deepEqual([...new Set([...transact.matchAll(new RegExp(methods.source, 'g'))].map((m) => m[1]))].sort(), ['eth_call', 'eth_estimateGas', 'eth_sendTransaction'], 'the shared sender simulates, estimates and sends, nothing else of these');
  assert.equal([...transact.matchAll(/'eth_sendTransaction'/g)].length, 1, 'one send');
  // Changed on purpose (data) 2026-10-02 (Domino V2 PHASE B, B5 S2): the origin sender reads (the account, the chain, the
  // allowance, balances and decimals, the nonce, the fee, the estimate, receipts) and sends once; it adds no network.
  const crosschain = ALL.find(({ path }) => path === 'finance/v2/crosschain.ts').code;
  assert.deepEqual([...new Set([...crosschain.matchAll(new RegExp(methods.source, 'g'))].map((m) => m[1]))].sort(), ['eth_call', 'eth_estimateGas', 'eth_sendTransaction'], 'the origin sender reads, estimates and sends, nothing else of these');
  assert.equal([...crosschain.matchAll(/'eth_sendTransaction'/g)].length, 1, 'one send');
  const ORIGIN_METHODS = ['eth_accounts', 'eth_call', 'eth_chainId', 'eth_estimateGas', 'eth_gasPrice', 'eth_getBalance', 'eth_getBlockByNumber', 'eth_getTransactionByHash', 'eth_getTransactionCount', 'eth_getTransactionReceipt', 'eth_maxPriorityFeePerGas', 'eth_sendTransaction'];
  assert.deepEqual([...new Set([...crosschain.matchAll(/rpc\('([a-zA-Z_]+)'/g)].map((m) => m[1]))].sort(), ORIGIN_METHODS, 'every wallet request the origin sender makes');
  assert.deepEqual([...crosschain.matchAll(/['"`]((?:eth|personal|net|web3)_[A-Za-z0-9_]+|wallet_[a-z]+[A-Z][A-Za-z0-9]*)['"`]/g)].map((m) => m[1]).filter((m) => !ORIGIN_METHODS.includes(m)), [], 'and it names no other method (its own stop codes, wallet_refused and the like, are not methods)');
  // Changed on purpose (data) 2026-10-02 (S2 holdings): the reader of other networks reads the chain, the native balance
  // and balanceOf, nothing else, through the injected wallet handle; no switch, no send, no network added.
  const holdings = ALL.find(({ path }) => path === 'finance/v2/holdings.ts').code;
  assert.deepEqual([...new Set([...holdings.matchAll(new RegExp(methods.source, 'g'))].map((m) => m[1]))], ['eth_call'], 'a read only: the balances on another network');
  assert.deepEqual([...holdings.matchAll(/request\('([a-zA-Z_]+)'/g)].map((m) => m[1]), ['eth_chainId', 'eth_getBalance', 'eth_call'], 'the chain confirmed first, then the balances');
  assert.deepEqual([...holdings.matchAll(/['"`]((?:eth|personal|net|web3)_[A-Za-z0-9_]+|wallet_[a-z]+[A-Z][A-Za-z0-9]*)['"`]/g)].map((m) => m[1]).filter((m) => !['eth_chainId', 'eth_getBalance', 'eth_call'].includes(m)), [], 'and it names no other method');
  assert.doesNotMatch(holdings, /\b(switchTo(Origin|Chain|Robinhood)|getProvider|wagmi|viem)\b/, 'the switch is handed in, and it reaches no provider of its own');
  // Changed on purpose (data) 2026-10-02 (Domino V2, post-B4 review): the four clients send only through the shared
  // sender (transact.ts) and sign only through typedData.ts: none names a send, a signature or a batch itself.
  for (const path of ['finance/v2/autoExit.ts', 'finance/v2/direct.ts', 'finance/v2/vault.ts', 'finance/v2/zap.ts']) {
    const code = ALL.find((file) => file.path === path).code;
    const named = [...new Set([...code.matchAll(new RegExp(methods.source, 'g'))].map((m) => m[1]))];
    assert.deepEqual(named.filter((m) => m !== 'eth_call' && m !== 'eth_estimateGas'), [], `${path} sends and signs only through the shared modules`);
  }
  // No V2 module outside the test screens imports a fixture transport (the read API's, the plan API's, S2's).
  assert.deepEqual(hits(ALL.filter(({ path }) => V2_PATH.test(path)), /from\s+['"][^'"]*fixtureTransport['"]/), [], 'fixture transports are imported only by the v2-test screens and the tests');
  // Changed on purpose (data) 2026-10-02 (Domino V2 integration): the integrated V2 modules (v2in/, V2 builds only) may, as
  // the v2-test screens could: the gate's `preview` reads the package fixtures through them.
  assert.deepEqual(hits(ALL.filter(({ path }) => !V2_PATH.test(path) && !path.startsWith('v2in/')), /from\s+['"][^'"]*v2\/[^'"]*fixtureTransport['"]/), [], 'and by no V1 module');
  assert.deepEqual(hits(inside('v2/'), methods), [], 'the pure V2 modules name no wallet method');
  assert.deepEqual(hits(v2, /['"`](wallet_sendCalls|wallet_getCallsStatus|wallet_getCapabilities|wallet_showCallsStatus|wallet_addEthereumChain)['"`]/), [], 'no V2 file offers a batch or adds a network');
  assert.deepEqual(hits(inside('v2/'), /\b(localStorage|sessionStorage|indexedDB|document\.cookie)\b/), [], 'the pure V2 modules keep nothing in the browser');
  // Every V2 approval is declared in a closed V2 client, never in a screen or a pure module.
  const apis = /\b(sendTransaction|writeContract|sendCalls|signTypedData|simulateContract|useSendTransaction|useWriteContract|useSignTypedData|approve\s*\()|\bname:\s*['"`]approve['"`]/;
  assert.deepEqual(hits(v2, apis).filter((path) => !V2_CLOSED.includes(path) && path !== 'finance/v2/abi.ts'), [], 'V2 approvals are declared only by the closed V2 ABIs and clients');
});

// Changed on purpose (data) 2026-10-02 (Domino V2 integration, the base agent's items 4 and 6): V2 is an integration into
// the existing screens. The production and development builds carry none of it, byte for byte, so a V1 file (anything
// outside src/v2, src/finance/v2 and src/v2in) never imports a V2 module statically: it opens an integrated V2 module
// (src/v2in) only through import(), on a line that is behind the bare define:
// `const X = __DOMINO_V2__ ? lazy(() => import('../../v2in/area/Thing')) : null`. A type-only import is erased and opens
// nothing. The integrated modules are screens: they name no wallet method, ask no provider, and reach the wallet layer
// only through the closed finance/v2 clients and wallet/port's chain switch. Item 6 took away the two allowances this
// had while the old #/v2 screens (src/v2ui, App.tsx's route) and the old preview build's lock (wallet/port.ts's static
// import of finance/v2/previewLock.ts) existed: neither does any more.
const V2_DIRS = /^(v2|finance\/v2|v2in)\//;

test('V2 integration: no V1 file imports a V2 module statically; it opens src/v2in only by import(), behind the bare __DOMINO_V2__ define', () => {
  const statics = [];
  const opens = [];
  for (const { path, code } of ALL.filter(({ path }) => !V2_DIRS.test(path))) {
    // Type-only imports are erased at compile time: they open nothing.
    const values = code.replace(/^import\s+type\s[^;]*?from\s*'[^']+';?$/gm, '');
    const resolveSpec = (spec) => posix.normalize(posix.join(posix.dirname(path), spec)).replace(/\.tsx?$/, '');
    for (const match of values.matchAll(/(?:\bfrom\s*|^\s*import\s+)'([^']+)'/gm)) {
      const spec = match[1];
      if (!spec.startsWith('.')) continue;
      if (V2_DIRS.test(resolveSpec(spec))) statics.push(`${path}: ${spec}`);
    }
    for (const line of values.split('\n')) {
      for (const match of line.matchAll(/\bimport\(\s*'([^']+)'\s*\)/g)) {
        const spec = match[1];
        if (!spec.startsWith('.')) continue;
        const target = resolveSpec(spec);
        if (!V2_DIRS.test(target)) continue;
        opens.push(path);
        const before = line.slice(0, match.index);
        assert.match(before, /__DOMINO_V2__\s*(\?|&&)/, `${path} opens ${spec} only behind the bare __DOMINO_V2__ define, on the same line`);
        assert.ok(target.startsWith('v2in/'), `${path} opens ${spec}: a V1 file opens the integrated modules (src/v2in) only, never src/v2 or src/finance/v2 directly`);
      }
    }
  }
  assert.deepEqual(statics, [], 'no V1 file imports a V2 module statically');
  assert.ok(opens.length >= 1, 'the guard sees the V1 files that open the integrated modules (it would be blind otherwise)');
  assert.ok(opens.includes('components/create/StageAmount.tsx'), 'New position\'s amount step opens its inline offer lazily');
  assert.equal(ALL.some(({ path }) => path === 'finance/v2/previewLock.ts'), false, 'the old preview build\'s lock is gone');
  assert.doesNotMatch(ALL.find(({ path }) => path === 'wallet/port.ts').code, /from '\.\.\/(?:finance\/v2|v2|v2in)\//, 'the wallet port imports nothing of V2');
});

test('V2 integration: the integrated modules (src/v2in) name no wallet method and ask no provider; their wallet layer is wallet/port\'s chain switch', () => {
  const v2in = inside('v2in/');
  assert.ok(v2in.length >= 1, 'src/v2in exists');
  const methods = /['"`](eth_sendTransaction|eth_signTransaction|eth_sendRawTransaction|eth_sign|eth_signTypedData(_v\d)?|personal_sign|wallet_sendCalls|wallet_getCallsStatus|wallet_getCapabilities|wallet_showCallsStatus|wallet_switchEthereumChain|wallet_addEthereumChain|wallet_watchAsset|eth_call|eth_estimateGas|eth_accounts|eth_requestAccounts|eth_chainId)['"`]/;
  assert.deepEqual(hits(v2in, methods), [], 'no wallet RPC method');
  assert.deepEqual(hits(v2in, /\.request\(|getProvider\(|from 'wagmi|from '@wagmi|from 'viem\/actions'|window\.ethereum/), [], 'no provider, no wagmi, no viem action');
  const apis = /\b(sendTransaction|writeContract|sendCalls|signTypedData|simulateContract|useSendTransaction|useWriteContract|useSignTypedData)\b/;
  assert.deepEqual(hits(v2in, apis), [], 'no send or signature API of their own: only the closed finance/v2 clients send and sign');
  const fromPort = new Set();
  for (const { path, code } of v2in) {
    for (const [, names] of code.matchAll(/import \{([^}]+)\} from '(?:\.\.\/)+wallet\/port'/g)) for (const name of names.split(',')) fromPort.add(name.trim().replace(/^type\s+/, ''));
    for (const [, target] of code.matchAll(/from '((?:\.\.\/)+(?:wallet|session)\/[^']+)'/g)) assert.match(target, /\/wallet\/port$/, `${path} imports ${target}: of the wallet and the session, only the port's chain switch`);
  }
  for (const name of fromPort) assert.ok(['ChainSwitchOutcome', 'switchToChain', 'switchToOrigin', 'v2SwitchNotice'].includes(name), `wallet/port.ts ${name}`);
});

// Added 2026-11-07 (the owner's Points page, Season 1): the Points screen is wallet feature code (it reads the session
// and asks the wallet to sign a referral link), opened only by App.tsx, lazily, behind the wallet's build flag; the one
// module it signs and sends through is finance/points.ts, which signs with the sign-in's own signer and nothing else.
test('the Points screen is opened only lazily behind the wallet flag, and signs only through finance/points.ts', () => {
  const openers = ALL.filter(({ code }) => /['"`]\.{1,2}\/(?:screens\/)?Points['"`]/.test(code)).map(({ path }) => path);
  assert.deepEqual(openers, ['App.tsx']);
  assert.match(ALL.find(({ path }) => path === 'App.tsx').code, /const Points = __DOMINO_WALLET_SESSION__ \? deferred<object>\(recovering\(\(\) => import\('\.\/screens\/Points'\)/);
  const screen = ALL.find(({ path }) => path === 'screens/Points.tsx').code;
  assert.doesNotMatch(screen, /\b(signLoginMessage|signMessage|sessionController|withSessionCsrf|fetch)\b|personal_sign/, 'the screen asks through finance/points.ts only');
  const binding = ALL.find(({ path }) => path === 'finance/points.ts').code;
  assert.deepEqual([...binding.matchAll(/\b(signLoginMessage|signMessage|signTypedData|sendTransaction)\(/g)].map((m) => m[1]), ['signLoginMessage'], 'one signature, the referral text');
});
