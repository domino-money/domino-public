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
  assert.deepEqual(hits(ALL, methods), ['finance/batch.ts', 'finance/position.ts', 'finance/sequence.ts', 'finance/setup.ts', 'finance/wallet.ts']);
  assert.deepEqual(hits(inside('session/', 'wallet/', 'components/wallet/'), methods), [], 'login still cannot spend');
  assert.deepEqual([...ALL.find(f => f.path === 'finance/wallet.ts').code.matchAll(/method: '([^']+)'/g)].map(m => m[1]), ['eth_accounts', 'eth_chainId', 'eth_sendTransaction']);
});

test('batches (EIP-5792) are asked for, offered and read back only by the closed batch module the owner clients share', () => {
  // Changed on purpose (2026-09-25): Create position's one-signature batch (docs/plans/2026-09-25-eip5792-batches-design.md)
  // reads what the wallet can batch, offers one batch and reads its status. Since the sequence's creation batches too, both
  // clients (finance/setup.ts, finance/sequence.ts) go through finance/batch.ts; login and every screen name none of these.
  const batch = /['"`](wallet_sendCalls|wallet_getCallsStatus|wallet_getCapabilities|wallet_showCallsStatus)['"`]/;
  assert.deepEqual(hits(ALL, batch), ['finance/batch.ts']);
});

test('exact approvals are confined to the closed setup and sequence ABIs', () => {
  // The closed ABIs are JSON (so the page ships no ABI parser): an approval is declared as an item named approve.
  const apis =
    /\b(sendTransaction|writeContract|sendCalls|signTypedData|simulateContract|useSendTransaction|useWriteContract|useSignTypedData|approve\s*\()|\bname:\s*['"`]approve['"`]/;
  assert.deepEqual(hits(ALL, apis), ['finance/sequence.ts', 'finance/setup.ts'], 'only the closed owner ABIs declare exact token or NFT approval');
});

test('no connector SDK, public chain definition or network transport is used', () => {
  const packages = /^(viem\/chains|wagmi\/chains|wagmi\/connectors|@wagmi\/connectors|@walletconnect\/|@coinbase\/|@metamask\/|@base-org\/|@safe-global\/)/;
  const imported = ALL.flatMap(({ path, code }) => specifiers(code).filter((spec) => packages.test(spec)).map((spec) => `${path}: ${spec}`));
  assert.deepEqual(imported, []);
  assert.deepEqual(hits(ALL, /\b(walletConnect|coinbaseWallet|metaMask|baseAccount|injected)\s*\(/), []);
  // viem's network transports. `custom` over the wallet's own provider is the only one allowed.
  assert.deepEqual(hits(inside('session/', 'wallet/', 'components/wallet/'), /\b(http|webSocket|fallback|createPublicClient)\s*\(/), []);
});

test('nothing renders HTML from strings', () => {
  assert.deepEqual(hits(ALL, /dangerouslySetInnerHTML|innerHTML\s*=/), []);
});

test('session and wallet code never touches browser storage', () => {
  const files = inside('session/', 'wallet/', 'components/wallet/');
  assert.ok(files.length > 5);
  assert.deepEqual(hits(files, /\b(localStorage|sessionStorage|indexedDB|document\.cookie)\b/), []);
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
  assert.match(importers[0].code, /__DOMINO_WALLET_SESSION__\s*\?\s*lazy\(/);
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
  const feature = /^(session|wallet|finance|components\/wallet)\/|^screens\/(Setup|AdvancedSetup|WalletDeposit|Performance|Execution|Sequence|SequenceCreate|PositionLab)\.tsx$|^components\/create\/(DepositAmounts|CreatePosition)(\.tsx)?$|^components\/positions\/(PositionActions|HeldDeposits|SequenceSwitch)(\.tsx)?$/;
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
  const POSITION_CHUNKS = { 'screens/PositionDetail.tsx': '../components/positions/PositionActions', 'screens/Positions.tsx': '../components/positions/HeldDeposits' };
  const positionsOpens = (path, spec) => POSITION_CHUNKS[path] === spec;
  // Changed on purpose (2026-09-28, the owner's phone: Your positions stayed on its loading rows while the RPC refused his
  // address): the list, itself opened only behind the flag (Positions.tsx), keeps its display copy with the private
  // cards' keep, readKept and drop (finance/privateCards.ts), a module that names no wallet code (asserted here).
  const listKeeps = (path, spec) => path === 'components/positions/OwnedPositions.tsx' && spec === '../../finance/privateCards';
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
  for (const [path, spec] of Object.entries(POSITION_CHUNKS)) {
    const { code } = ALL.find((file) => file.path === path);
    const quoted = spec.replaceAll('.', '\\.').replaceAll('/', '\\/');
    assert.match(code, new RegExp(`__DOMINO_WALLET_SESSION__\\s*\\?\\s*lazy(?:<[^\\n]*?>)?\\(\\(\\)\\s*=>\\s*import\\('${quoted}'\\)`), `${path} opens ${spec} lazily, behind the flag`);
    const mentions = [...code.matchAll(new RegExp(`['"\`]${quoted}(?:\\.tsx?)?['"\`]`, 'g'))].length;
    assert.equal(mentions, 1, `${path} names ${spec} once, in its lazy import(), and imports nothing else from it, types included`);
  }
});

// Added 2026-09-24 with the owner's position actions (components/positions/PositionActions.tsx: Collect fees and
// Close position; components/positions/HeldDeposits.tsx: the refund of a held setup deposit). Like Create position's
// chunk, whichever screen opens them does it lazily behind the wallet flag, naming each once, so a build without the
// wallet never loads them. Type-only imports are erased and are not an opening. Their lab screen is test-only.
test('the position actions are opened only lazily behind the wallet flag, and their lab only in test builds', () => {
  const target = /^components\/positions\/(PositionActions|HeldDeposits)$/;
  const openers = [];
  for (const { path, code } of ALL) {
    if (/^components\/positions\/(PositionActions|HeldDeposits)\.tsx$/.test(path)) continue;
    const values = code.replace(/^import\s+type\s[^;]*?from\s*'[^']+';?$/gm, '');
    for (const spec of new Set(specifiers(values))) {
      if (!spec.startsWith('.') || !target.test(posix.normalize(posix.join(posix.dirname(path), spec)).replace(/\.tsx?$/, ''))) continue;
      openers.push(path);
      const quoted = spec.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      // 2026-09-24 (merge): an explicit type argument, lazy<ComponentType<Props>>(...), types the chunk from the opener's own props.
      assert.match(values, new RegExp(`__DOMINO_WALLET_SESSION__\\s*\\?\\s*lazy(?:<[^\\n]*?>)?\\(\\(\\)\\s*=>\\s*import\\('${quoted}'\\)`), `${path} opens ${spec} lazily, behind the wallet flag`);
      const mentions = [...values.matchAll(new RegExp(`['"\`]${quoted}['"\`]`, 'g'))].length;
      const lazy = [...values.matchAll(new RegExp(`import\\(\\s*['"\`]${quoted}['"\`]\\s*\\)`, 'g'))].length;
      assert.deepEqual([mentions, lazy], [1, 1], `${path} names ${spec} once, in its lazy import()`);
    }
  }
  assert.ok(openers.includes('screens/PositionLab.tsx'), openers.join(', '));
  const labOpeners = ALL.filter(({ code }) => /['"`]\.\/screens\/PositionLab(?:\.tsx?)?['"`]/.test(code)).map(({ path }) => path);
  assert.deepEqual(labOpeners, ['App.tsx'], 'only the app routes to the lab');
  assert.match(ALL.find(({ path }) => path === 'App.tsx').code, /const PositionLab = __DOMINO_TEST_HOOKS__\s*\?\s*lazy\(\(\)\s*=>\s*import\('\.\/screens\/PositionLab'\)/, 'the lab exists only where the test hooks do');
});
