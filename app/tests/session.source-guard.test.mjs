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
  assert.deepEqual(hits(ALL, methods), ['finance/sequence.ts', 'finance/setup.ts', 'finance/wallet.ts']);
  assert.deepEqual(hits(inside('session/', 'wallet/', 'components/wallet/'), methods), [], 'login still cannot spend');
  assert.deepEqual([...ALL.find(f => f.path === 'finance/wallet.ts').code.matchAll(/method: '([^']+)'/g)].map(m => m[1]), ['eth_accounts', 'eth_chainId', 'eth_sendTransaction']);
});

test('exact approvals are confined to the closed setup and sequence ABIs', () => {
  const apis =
    /\b(sendTransaction|writeContract|sendCalls|signTypedData|simulateContract|useSendTransaction|useWriteContract|useSignTypedData|approve\s*\()/;
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
  const feature = /^(session|wallet|finance|components\/wallet)\/|^screens\/(Setup|AdvancedSetup|Performance|Execution|Sequence)\.tsx$/;
  // The onboarding previews and the deposit consumer (#38, #40/#44) read the
  // session through session/port.ts, and the preview screen also through
  // session/livePort.ts. Both live in chunks of the consumer-test build only;
  // consumer.guard and consumer.bundle prove neither reaches a deployable one.
  // This is a named exception for two modules, not an opening of the feature.
  const consumer = /^(onboarding|deposit|components\/(preview|deposit|consumer))\/|^screens\/(LivePreview|Deposits)\.tsx$/;
  const consumerMayUse = (path, target) =>
    consumer.test(path) && (target === 'session/port' || (path === 'screens/LivePreview.tsx' && target === 'session/livePort'));
  const offenders = [];
  for (const { path, code } of ALL.filter(({ path }) => !feature.test(path))) {
    for (const spec of specifiers(code)) {
      if (/^(wagmi|viem|@tanstack\/)/.test(spec)) offenders.push(`${path}: ${spec}`);
      if (!spec.startsWith('.')) continue;
      const target = posix.normalize(posix.join(posix.dirname(path), spec));
      if (feature.test(target) && target !== 'components/wallet/WalletBoundary' && spec !== './wallet/WalletSessionIsland' && spec !== './wallet/LocalWalletIsland' && !consumerMayUse(path, target)) {
        offenders.push(`${path}: ${spec}`);
      }
    }
  }
  assert.deepEqual(offenders, []);
});
