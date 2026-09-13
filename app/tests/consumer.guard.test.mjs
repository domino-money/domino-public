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
const hits = (files, pattern) => files.flatMap(({ path, code }) => (pattern.test(code) ? [path] : []));
const specifiers = (code) => [...code.matchAll(/(?:from|import)\s*\(?\s*'([^']+)'/g)].map((match) => match[1]);
const target = (path, spec) => posix.normalize(posix.join(posix.dirname(path), spec));
const isConsumerTarget = (t) => isConsumer(`${t}.ts`) || isConsumer(`${t}.tsx`) || isConsumer(`${t}/`);
const byPath = (path) => ALL.find((file) => file.path === path);

test('the consumer directories exist and are what these guards scan', () => {
  for (const path of ['onboarding/client.ts', 'deposit/flow.ts', 'deposit/handoff.ts', 'screens/LivePreview.tsx', 'screens/Deposits.tsx', 'session/livePort.ts']) {
    assert.ok(byPath(path), path);
  }
  assert.ok(MINE.length > 30, `${MINE.length} files`);
});

test('GUARD-1: no wallet method, signing or transaction API, and no chain switch, in the consumer code', () => {
  const methods =
    /['"`](eth_sendTransaction|eth_signTransaction|eth_sendRawTransaction|eth_sign|eth_signTypedData(_v\d)?|personal_sign|wallet_sendCalls|wallet_addEthereumChain|wallet_watchAsset|wallet_switchEthereumChain|eth_requestAccounts|eth_call|eth_estimateGas)['"`]/;
  assert.deepEqual(hits(MINE, methods), []);
  const apis = /\b(sendTransaction|writeContract|sendCalls|signTypedData|signMessage|simulateContract|approve\s*\(|ethereum\b)/;
  assert.deepEqual(hits(MINE, apis), []);
  const imports = MINE.flatMap(({ path, code }) => specifiers(code).filter((spec) => /^(wagmi|viem|@tanstack\/)/.test(spec) || /\/wallet\//.test(spec)).map((spec) => `${path}: ${spec}`));
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

test('GUARD-3: no route to the live deposit service; storage only for the remembered id; no HTML from strings; no URL writes', () => {
  const importers = ALL.filter(({ code }) => specifiers(code).some((spec) => /httpTransport$/.test(spec))).map(({ path }) => path);
  assert.deepEqual(importers, [], 'the http transport is node-tested only in this phase');
  assert.deepEqual(hits(MINE, /\/api\/deposit\/v1/), ['deposit/transport.ts'], 'the prefix is declared once and used only by the unimported http transport');
  assert.deepEqual(hits(MINE, /\blocalStorage\b/), ['deposit/memory.ts']);
  assert.deepEqual(hits(MINE, /\b(sessionStorage|indexedDB|document\.cookie)\b/), []);
  assert.deepEqual(hits(MINE, /dangerouslySetInnerHTML|innerHTML\s*=|\bsrc=\{|\bhref=\{/), []);
  assert.deepEqual(hits(MINE, /location\.(hash|href|search)\s*=|location\.(assign|replace)\(|history\.(pushState|replaceState)\(/), []);
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

test('GUARD-5: the consumer is reached only through the two flag-gated lazy screens', () => {
  const offenders = [];
  for (const { path, code } of ALL.filter(({ path }) => !isConsumer(path))) {
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
  assert.deepEqual(importersOf('session/livePort'), ['screens/LivePreview.tsx']);
  assert.deepEqual(importersOf('deposit/fixtures/fixtureSession'), ['screens/Deposits.tsx']);
  const deposits = byPath('screens/Deposits.tsx').code;
  assert.doesNotMatch(deposits, /session\/(port|livePort)'/, 'the lab never touches the real session');
  assert.doesNotMatch(deposits, /onboarding\//);
});

test('GUARD-6: no clock is read outside lib/clock.ts', () => {
  assert.deepEqual(hits(MINE, /\bDate\.now\b|\bperformance\.now\b|new Date\(\s*\)/), ['lib/clock.ts']);
});

test('DF-11: prepare has exactly one call site, inside issueWalletStep; create and a wallet send have none', () => {
  const prepares = ALL.flatMap(({ path, code }) => [...code.matchAll(/\.prepare\(/g)].map(() => path));
  assert.deepEqual(prepares, ['deposit/flow.ts']);
  const flow = byPath('deposit/flow.ts').code;
  const start = flow.indexOf('async function issueWalletStep');
  const end = flow.indexOf('async function userAction');
  const at = flow.indexOf('.prepare(');
  assert.ok(start > 0 && start < at && at < end, 'the call sits in issueWalletStep');
  assert.deepEqual(hits(ALL, /\.create\(/), []);
  assert.deepEqual(hits(ALL, /\bhandoff\.send\(|HANDOFF\.send\(|\.send\(\s*(step|walletStep)/), []);
  assert.deepEqual(hits(MINE, /available:\s*true/), [], 'no handoff says it is available');
  assert.deepEqual(hits(MINE, /executionAvailable:\s*true|automationAvailable:\s*true|serverBroadcastAvailable:\s*true/), []);
});
