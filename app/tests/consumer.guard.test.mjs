/**
 * Source guards for the onboarding previews (#38) and the deposit consumer
 * (#40/#44). Blunt on purpose: nothing here should depend on a reviewer
 * noticing. B2's tests/session.source-guard.test.mjs keeps covering all of
 * src; these cover the consumer's own directories more strictly.
 */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, posix, relative, resolve } from 'node:path';
import { test } from 'node:test';

const SRC = resolve(import.meta.dirname, '../src');

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
      const raw = readFileSync(path, 'utf8');
      files.push({ path: relative(SRC, path).replaceAll('\\', '/'), raw, code: stripComments(raw) });
    }
  }
  return files;
}

const ALL = sources();
const CONSUMER = [
  /^onboarding\//,
  /^deposit\//,
  /^components\/(preview|deposit|consumer)\//,
  /^screens\/(LivePreview|Deposits)\.tsx$/,
  /^lib\/(raw|clock)\.ts$/,
  /^lib\/http\//,
  /^session\/(port|livePort)\.ts$/,
];
const isConsumer = (path) => CONSUMER.some((pattern) => pattern.test(path));
const MINE = ALL.filter(({ path }) => isConsumer(path));
/**
 * The product's own consumers of the preview client outside those directories: New position's deposit amounts (a
 * wallet-build chunk of its own) and the in-memory draft it carries to Setup. They are not consumer code for GUARD-5's
 * import rules, but what GUARD-1, GUARD-3 and GUARD-6 forbid holds for them too: no wallet method, no storage, no URL
 * write, no clock of their own.
 */
const PRODUCT_CONSUMERS = ['components/create/DepositAmounts.tsx', 'lib/create/setupDraft.ts'];
const SCANNED = [...MINE, ...ALL.filter(({ path }) => PRODUCT_CONSUMERS.includes(path))];
const hits = (files, pattern) => files.flatMap(({ path, code }) => (pattern.test(code) ? [path] : []));
const specifiers = (code) => [...code.matchAll(/(?:from|import)\s*\(?\s*'([^']+)'/g)].map((match) => match[1]);
const target = (path, spec) => posix.normalize(posix.join(posix.dirname(path), spec));
const isConsumerTarget = (t) => isConsumer(`${t}.ts`) || isConsumer(`${t}.tsx`) || isConsumer(`${t}/`);
const byPath = (path) => ALL.find((file) => file.path === path);

test('the consumer directories exist and are what these guards scan', () => {
  for (const path of ['onboarding/client.ts', 'deposit/flow.ts', 'deposit/handoff.ts', 'screens/LivePreview.tsx', 'screens/Deposits.tsx', 'session/livePort.ts', ...PRODUCT_CONSUMERS]) {
    assert.ok(byPath(path), path);
  }
  assert.ok(MINE.length > 30, `${MINE.length} files`);
  assert.deepEqual(SCANNED.length, MINE.length + PRODUCT_CONSUMERS.length, 'GUARD-1, GUARD-3 and GUARD-6 also scan the product consumers');
});

test('GUARD-1: no wallet method, signing or transaction API, and no chain switch, in the consumer code or the product consumers', () => {
  const methods =
    /['"`](eth_sendTransaction|eth_signTransaction|eth_sendRawTransaction|eth_sign|eth_signTypedData(_v\d)?|personal_sign|wallet_sendCalls|wallet_addEthereumChain|wallet_watchAsset|wallet_switchEthereumChain|eth_requestAccounts|eth_call|eth_estimateGas)['"`]/;
  assert.deepEqual(hits(SCANNED, methods), []);
  const apis = /\b(sendTransaction|writeContract|sendCalls|signTypedData|signMessage|simulateContract|approve\s*\(|ethereum\b)/;
  assert.deepEqual(hits(SCANNED, apis), []);
  const imports = SCANNED.flatMap(({ path, code }) => specifiers(code).filter((spec) => /^(wagmi|viem|@tanstack\/)/.test(spec) || /\/wallet\//.test(spec)).map((spec) => `${path}: ${spec}`));
  assert.deepEqual(imports, ['session/livePort.ts: ../wallet/session'], 'only the live port reaches the wallet session, and only for its controller');
});

test('GUARD-1: function selectors appear only in the display map', () => {
  const selectors = /0x(095ea7b3|87517c45|dd46508f)/;
  assert.deepEqual(hits(MINE, selectors), ['deposit/copy.ts']);
});

test('GUARD-2: no Number, parseFloat, parseInt or toFixed on contract values; the one marked integer parser is the exception', () => {
  const forbidden = /\bNumber\(|\bparseFloat\b|\bparseInt\b|\.toFixed\(/;
  const marked = [];
  const offenders = [];
  for (const { path, raw } of MINE) {
    raw.split('\n').forEach((line, index) => {
      const code = line.replace(/^\s*(\/\/|\*|\/\*).*$/, '');
      if (!forbidden.test(code)) return;
      if (line.includes('raw-guard: integer-policy-field')) marked.push(`${path}:${index + 1}`);
      else offenders.push(`${path}:${index + 1}: ${line.trim()}`);
    });
  }
  assert.deepEqual(offenders, []);
  assert.equal(marked.length, 1, marked.join(', '));
  assert.match(marked[0], /^lib\/raw\.ts:/);
});

test('GUARD-3: no route to the live deposit service; storage only for the remembered id; no HTML from strings; no URL writes (the product consumers included)', () => {
  const importers = ALL.filter(({ code }) => specifiers(code).some((spec) => /httpTransport$/.test(spec))).map(({ path }) => path);
  assert.deepEqual(importers, ['screens/Setup.tsx'], 'only the reviewed live setup screen imports the live deposit transport');
  assert.deepEqual(hits(SCANNED, /\/api\/deposit\/v1/), ['deposit/transport.ts'], 'the prefix is declared once and used only by the unimported http transport');
  // New position's carried draft lives in memory only: no storage and no URL, whatever the product consumers grow into.
  assert.deepEqual(hits(SCANNED, /\blocalStorage\b/), ['deposit/memory.ts']);
  assert.deepEqual(hits(SCANNED, /\b(sessionStorage|indexedDB|document\.cookie)\b/), []);
  assert.deepEqual(hits(SCANNED, /dangerouslySetInnerHTML|innerHTML\s*=|\bsrc=\{|\bhref=\{/), []);
  assert.deepEqual(hits(SCANNED, /location\.(hash|href|search)\s*=|location\.(assign|replace)\(|history\.(pushState|replaceState)\(/), []);
});

test('GUARD-4: the spending capabilities stay literally false and the consumer never reads the capability table', () => {
  const capabilities = byPath('lib/capabilities.ts').code;
  for (const flag of ['signingEnabled', 'walletFundingEnabled', 'swapsEnabled']) assert.match(capabilities, new RegExp(`${flag}:\\s*false,`), flag);
  // F3's capability table has no `features` list, and the practice workspace
  // that line named is gone with it. What this case guards — the spending
  // flags above, literally false, and the consumer never reading the table
  // below — stands as written; the dead line becomes the negative it implies.
  assert.doesNotMatch(capabilities, /practice/i, 'the capability table claims no practice workspace');
  assert.deepEqual(hits(MINE, /\b(CAPABILITIES|ROADMAP)\b/), []);
});

test('GUARD-5: the consumer is reached only through the two flag-gated lab screens and the product’s two named consumers, each opened lazily', () => {
  const offenders = [];
  // The product now consumes onboarding-v1 (coverage audit G8 and G15): New position's deposit amounts ask for a
  // position preview, and Setup's assisted swap for a swap preview. Like the other private screens, those two
  // consumers are wallet-build code of their own: components/create/DepositAmounts.tsx is a lazy chunk opened only
  // behind __DOMINO_WALLET_SESSION__ (checked below), and AdvancedSetup.tsx is already inside the lazy Setup screen.
  // They are named here, one file each; nothing else outside the consumer directories may import them.
  for (const { path, code } of ALL.filter(({ path }) => !isConsumer(path) && !/^finance\/|^screens\/(Setup|AdvancedSetup|Performance|Execution|Sequence)\.tsx$|^components\/create\/DepositAmounts\.tsx$/.test(path))) {
    for (const spec of specifiers(code)) {
      if (spec.startsWith('.') && isConsumerTarget(target(path, spec))) offenders.push(`${path}: ${spec}`);
    }
  }
  assert.deepEqual(offenders, ['App.tsx: ./screens/LivePreview', 'App.tsx: ./screens/Deposits']);
  const app = byPath('App.tsx').code;
  assert.match(app, /__DOMINO_ONBOARDING_PREVIEW__\s*\?\s*lazy\(\(\)\s*=>\s*import\('\.\/screens\/LivePreview'\)/);
  assert.match(app, /__DOMINO_DEPOSIT_LAB__\s*\?\s*lazy\(\(\)\s*=>\s*import\('\.\/screens\/Deposits'\)/);

  const importersOf = (wanted) =>
    ALL.filter(({ path, code }) => specifiers(code).some((spec) => spec.startsWith('.') && target(path, spec) === wanted)).map(({ path }) => path);
  // The two product preview consumers read the session through the live port, as Performance and Execution do.
  assert.deepEqual(importersOf('session/livePort'), ['components/create/DepositAmounts.tsx', 'finance/wallet.ts', 'screens/AdvancedSetup.tsx', 'screens/Execution.tsx', 'screens/LivePreview.tsx', 'screens/Performance.tsx', 'screens/Setup.tsx']);
  // New position's consumer is its own chunk: only Review's two parts open it, each lazily behind the wallet flag,
  // so the entry never carries the session or the onboarding client (session.bundle and consumer.bundle check the build).
  assert.deepEqual(importersOf('components/create/DepositAmounts'), ['components/create/StageBalance.tsx', 'components/create/StageReview.tsx']);
  for (const path of ['components/create/StageBalance.tsx', 'components/create/StageReview.tsx']) {
    const { code } = byPath(path);
    assert.match(code, /__DOMINO_WALLET_SESSION__\s*\?\s*lazy\(\(\)\s*=>\s*import\('\.\/DepositAmounts'\)/, path);
    // importersOf() cannot tell a static import from import(): every mention of the module must be the lazy one.
    const mentions = [...code.matchAll(/['"`]\.\/DepositAmounts(?:\.tsx?)?['"`]/g)].length;
    const lazy = [...code.matchAll(/import\(\s*['"`]\.\/DepositAmounts(?:\.tsx?)?['"`]\s*\)/g)].length;
    assert.deepEqual([mentions, lazy], [1, 1], `${path} names the deposit amounts once, in its lazy import(), never in a static import beside it`);
  }
  assert.deepEqual(importersOf('components/preview/SwapQuote'), ['screens/AdvancedSetup.tsx'], 'the swap quote is shown only inside the lazy Setup screen');
  assert.deepEqual(importersOf('deposit/fixtures/fixtureSession'), ['screens/Deposits.tsx']);
  const deposits = byPath('screens/Deposits.tsx').code;
  assert.doesNotMatch(deposits, /session\/(port|livePort)'/, 'the lab never touches the real session');
  assert.doesNotMatch(deposits, /onboarding\//);
});

test('GUARD-6: no clock is read outside lib/clock.ts, in the consumer code or the product consumers', () => {
  assert.deepEqual(hits(SCANNED, /\bDate\.now\b|\bperformance\.now\b|new Date\(\s*\)/), ['lib/clock.ts']);
});

test('DF-11: prepare has exactly one call site, inside issueWalletStep; create and a wallet send have none', () => {
  const prepares = ALL.flatMap(({ path, code }) => [...code.matchAll(/\.prepare\(/g)].map(() => path));
  assert.deepEqual(prepares, ['deposit/flow.ts']);
  const flow = byPath('deposit/flow.ts').code;
  const start = flow.indexOf('async function issueWalletStep');
  const end = flow.indexOf('async function userAction');
  const at = flow.indexOf('.prepare(');
  assert.ok(start > 0 && start < at && at < end, 'the call sits in issueWalletStep');
  assert.deepEqual(hits(ALL, /\.create\(/), ['screens/Sequence.tsx', 'screens/SequenceCreate.tsx', 'screens/Setup.tsx']);
  assert.deepEqual(hits(ALL, /\bhandoff\.send\(|HANDOFF\.send\(|\.send\(\s*(step|walletStep)/), ['components/create/CreatePosition.tsx', 'screens/AdvancedSetup.tsx', 'screens/Sequence.tsx', 'screens/SequenceCreate.tsx']);
  assert.deepEqual(hits(MINE, /available:\s*true/), [], 'no handoff says it is available');
  assert.deepEqual(hits(MINE, /executionAvailable:\s*true|automationAvailable:\s*true|serverBroadcastAvailable:\s*true/), []);
});
