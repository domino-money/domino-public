/**
 * Source guards for the chain2 workstream's files (2026-10-01): blunt on purpose, like tests/session.source-guard.test.mjs
 * and tests/read.test.mjs, whose rules these files keep (and which part B extends to them by name).
 *
 * - No chain id is written anywhere but the registry (audit item G12: rugged97's entry wrote 99801 into its wallet send).
 * - The section's page code has no network call of its own (no fetch, no XMLHttpRequest, no WebSocket), names no wallet
 *   transaction method and no eth_call, imports no wallet SDK and nothing of the Robinhood wallet feature or of
 *   src/finance: the money path of the second chain is rugged97's drafts, signed by the closed signer part B adds.
 * - rugged97's vendored runtimes are imported at run time only by the edge route and the section's entry.
 *
 * Part B (2026-10-01) admits two files by name, as tests/read.test.mjs and tests/session.source-guard.test.mjs do: the
 * section's one network call (src/chains/elysium/transport.ts) and its closed wallet signer (src/chains/elysium/signer.ts),
 * both imported by the routed entry alone (src/chains/elysium/ui/ElysiumEntry.tsx). And the app's menu, which every page
 * carries, links the section from the chain's identity and the section's mode alone.
 */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { test } from 'node:test';

const APP = resolve(import.meta.dirname, '..');
const walk = (dir) => readdirSync(dir).flatMap((name) => {
  const path = join(dir, name);
  return statSync(path).isDirectory() ? walk(path) : [path];
});
const rel = (path) => relative(APP, path).replaceAll('\\', '/');
const strip = (text) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\s\/\/\s.*$/gm, '');
const valueCode = (text) => strip(text).replace(/^import\s+type\s[^;]*?from\s*'[^']+';?$/gm, '').replace(/^export\s+type\s[^;]*?from\s*'[^']+';?$/gm, '');

/** Every TypeScript file this workstream added. */
const MINE = [
  ...walk(join(APP, 'src/chains')),
  join(APP, 'src/config/chains.ts'),
  join(APP, 'src/config/chainKit.ts'),
  join(APP, 'src/config/chainElysium.ts'),
  join(APP, 'src/config/chainIdentity.ts'),
  join(APP, 'functions/_lib/uniswap-v3/words.ts'),
  join(APP, 'src/lib/chain/client.ts'),
  join(APP, 'src/lib/chain/csp.ts'),
  join(APP, 'src/lib/chainStorage.ts'),
  join(APP, 'functions/_lib/uniswap-v3/abi.ts'),
  join(APP, 'functions/_lib/uniswap-v3/reads.ts'),
  join(APP, 'functions/_lib/uniswap-v3/edge.ts'),
  join(APP, 'functions/_lib/uniswap-v3/handler.ts'),
  join(APP, 'functions/uniswap-v3/[[path]].ts'),
].filter((path) => /\.tsx?$/.test(path)).map((path) => ({ path: rel(path), raw: readFileSync(path, 'utf8') }));
const PAGE = MINE.filter(({ path }) => path.startsWith('src/'));
const page = (path) => PAGE.find((file) => file.path === path).raw;

test('the files are there', () => {
  assert.ok(MINE.length >= 20, `${MINE.length}`);
  for (const path of ['src/chains/elysium/ui/ElysiumSection.tsx', 'src/chains/elysium/ui/ElysiumEntry.tsx', 'src/chains/elysium/transport.ts', 'src/chains/elysium/signer.ts', 'src/chains/elysium/mode.ts']) {
    assert.ok(PAGE.some((file) => file.path === path), path);
  }
});

test('no chain id is written anywhere but the registry', () => {
  const ids = /\b(?:99801|4663|0x185d9|0x1237|998)\b/;
  // The registry: the ids themselves (config/chainIdentity.ts, part B) and its profiles' names (robinhood-4663,
  // elysium-99801) in the records.
  const found = MINE.filter(({ path }) => !['src/config/chainIdentity.ts', 'src/config/chains.ts', 'src/config/chainElysium.ts'].includes(path)).filter(({ raw }) => ids.test(strip(raw))).map(({ path }) => path);
  assert.deepEqual(found, []);
});

test('the page code has no network call of its own but the admitted transport, which only the routed entry hands in', () => {
  // The same rule as tests/read.test.mjs's fetcher allowlist, which reads comments too, and admits the same one file.
  assert.deepEqual(PAGE.filter(({ raw }) => /\bfetch\(|XMLHttpRequest|new WebSocket|EventSource|sendBeacon/.test(raw)).map(({ path }) => path), ['src/chains/elysium/transport.ts']);
  assert.deepEqual(PAGE.filter(({ raw }) => /127\.0\.0\.1|:8876|\/v1\/read\/|\.sourceUrl\b|dangerouslySetInnerHTML|innerHTML/.test(raw)).map(({ path }) => path), []);
  // The section takes the transport, the signer and the network add as props; only its entry imports them.
  const importers = PAGE.filter(({ raw }) => /from '\.\.?\/(?:\.\.\/)?(?:transport|signer)'/.test(valueCode(raw))).map(({ path }) => path);
  assert.deepEqual(importers, ['src/chains/elysium/ui/ElysiumEntry.tsx']);
  assert.match(page('src/chains/elysium/ui/ElysiumEntry.tsx'), /<ElysiumSection transport=\{elysiumTransport\} signerFor=\{elysiumSignerFor\} addChain=\{addChain\} \/>/);
});

test('no wallet transaction method, no eth_call, no approval or send API in the page code but the closed signer', () => {
  const methods = /['"`](eth_sendTransaction|eth_signTransaction|eth_sendRawTransaction|eth_sign|eth_signTypedData(_v\d)?|personal_sign|wallet_sendCalls|wallet_getCallsStatus|wallet_getCapabilities|wallet_showCallsStatus|wallet_addEthereumChain|wallet_watchAsset|eth_call|eth_estimateGas)['"`]/;
  assert.deepEqual(PAGE.filter(({ raw }) => methods.test(strip(raw))).map(({ path }) => path), ['src/chains/elysium/signer.ts'], 'the closed signer alone');
  const signer = strip(page('src/chains/elysium/signer.ts'));
  assert.deepEqual([...new Set([...signer.matchAll(new RegExp(methods.source, 'g'))].map((m) => m[1]))].sort(), ['eth_sendTransaction', 'wallet_addEthereumChain'], 'the draft\'s one transaction, and the chain\'s details');
  assert.equal([...signer.matchAll(/method: 'eth_sendTransaction'/g)].length, 1, 'one send, in one place');
  const apis = /\b(sendTransaction|writeContract|sendCalls|signTypedData|simulateContract|useSendTransaction|useWriteContract|useSignTypedData|approve\s*\()|\bname:\s*['"`]approve['"`]/;
  assert.deepEqual(PAGE.filter(({ raw }) => apis.test(strip(raw))).map(({ path }) => path), []);
  assert.deepEqual(PAGE.filter(({ raw }) => /eth_sendTransaction|eth_sendRawTransaction|writeContract|sendCalls|eth_signTypedData|\.approve\(/.test(raw)).map(({ path }) => path), ['src/chains/elysium/signer.ts'], 'not even in a comment, but in the signer');
});

test('no wallet SDK, nothing of the Robinhood wallet feature, nothing of src/finance', () => {
  const specifiers = (code) => [...code.matchAll(/(?:from|import)\s*\(?\s*'([^']+)'/g)].map((m) => m[1]);
  const offenders = [];
  for (const { path, raw } of PAGE) {
    for (const spec of specifiers(strip(raw))) {
      if (/^(wagmi|viem|@tanstack\/|@walletconnect|@coinbase|@metamask)/.test(spec)) offenders.push(`${path}: ${spec}`);
      const target = spec.startsWith('.') ? rel(resolve(APP, join(path, '..'), spec)) : spec;
      if (/^src\/(session|wallet|finance|components\/wallet)\//.test(target)) offenders.push(`${path}: ${spec}`);
    }
  }
  assert.deepEqual(offenders, []);
  assert.deepEqual(PAGE.filter(({ raw }) => /window\.ethereum/.test(strip(raw))).map(({ path }) => path), [], 'a wallet is the one the person chose (EIP-6963)');
  assert.deepEqual(PAGE.filter(({ raw }) => /\b(localStorage|sessionStorage|indexedDB)\b/.test(strip(raw))).map(({ path }) => path), ['src/lib/chainStorage.ts'], 'storage only through the chain-scoped keys');
});

test('rugged97\'s runtimes are imported at run time only by the edge route and the section\'s entry', () => {
  const importers = MINE.filter(({ raw }) => /^import\s+(?!type\b)[^;]*from\s+'[^']*contracts\/uniswap-v3-(?:read|actions)-v1\/runtime\.mjs'/m.test(raw)).map(({ path }) => path).sort();
  assert.deepEqual(importers, ['functions/_lib/uniswap-v3/handler.ts', 'src/chains/elysium/ui/ElysiumSection.tsx']);
});

test('the section shares no module with Robinhood Chain\'s lazy chunks: its whole import graph stays out of them', () => {
  // Robinhood's lazy chain code (lib/chain/chainCode.ts and what it imports): a module the section imported from there
  // would be split out of Robinhood's chunk into a shared one, changing what Robinhood's pages load. Changed on purpose
  // 2026-10-01 (RPC-SPEC §7.7): the page's router (endpoints, failover, browser) is gone; the wallet feature's reads and
  // the site's chain routes' client are Robinhood's now.
  const robinhood = /(?:functions\/_lib\/(?:owned|fees|feesPath|walletPositions|automation)|src\/lib\/chain\/chainCode|src\/lib\/walletReads|src\/lib\/edge\/chainRoutes|src\/lib\/fees\/|src\/config\/(?:chains|chainRobinhood))(?:\.ts)?$/;
  const seen = new Set();
  const offenders = [];
  const visit = (path) => {
    if (seen.has(path)) return;
    seen.add(path);
    let raw;
    try {
      raw = readFileSync(join(APP, path), 'utf8');
    } catch {
      return;
    }
    for (const [, spec] of valueCode(raw).matchAll(/(?:from|import)\s*\(?\s*'([^']+)'/g)) {
      if (!spec.startsWith('.')) continue;
      const target = rel(resolve(APP, join(path, '..'), spec));
      if (robinhood.test(target)) offenders.push(`${path} -> ${target}`);
      for (const ext of ['.ts', '.tsx', '/index.ts']) visit(`${target}${ext}`);
    }
  };
  // From the routed entry (part B), which brings the transport and the signer with the section.
  visit('src/chains/elysium/ui/ElysiumEntry.tsx');
  for (const path of ['src/chains/elysium/ui/ElysiumSection.tsx', 'src/chains/elysium/transport.ts', 'src/chains/elysium/signer.ts']) assert.ok(seen.has(path), path);
  assert.ok(seen.size > 20, `${seen.size} modules walked`);
  assert.deepEqual(offenders, []);
});

test('the chain code is pure: no DOM, no storage, no build flag, no network of its own, reads only', () => {
  for (const name of ['abi.ts', 'reads.ts']) {
    const code = readFileSync(join(APP, 'functions/_lib/uniswap-v3', name), 'utf8');
    assert.doesNotMatch(code, /\b(?:localStorage|sessionStorage|indexedDB|document\.|window\.|__DOMINO_)\w*|\bfetch\(/, name);
    const methods = [...new Set([...code.matchAll(/['"`]((?:eth|net|web3|wallet|personal|debug|txpool)_[A-Za-z]+)['"`]/g)].map((m) => m[1]))].sort();
    assert.ok(methods.every((method) => ['eth_call', 'eth_getLogs', 'eth_getBlockByNumber', 'eth_blockNumber'].includes(method)), `${name}: ${methods}`);
  }
});

// Part B (2026-10-01): the app's menu, which every page carries, links the section where its mode is not off, and brings
// only the chain's identity and the mode into the page for it: never the chain's record, the section's code, or the API
// forwarder's tables (functions/_lib/bridge.ts, whose two origins mode.ts copies; tests/elysium-adapter.test.mjs holds
// them equal). tests/session.bundle.test.mjs checks the built entry for the same.
test('the menu links the section from the chain\'s identity and the section\'s mode alone', () => {
  const menu = readFileSync(join(APP, 'src/components/HeaderMenu.tsx'), 'utf8');
  const chainImports = [...valueCode(menu).matchAll(/from '(\.\.\/(?:config|chains)\/[^']+)'/g)].map((m) => m[1]).sort();
  assert.deepEqual(chainImports, ['../chains/elysium/mode', '../config/chainIdentity']);
  assert.match(menu, /const ELYSIUM_LINKED = typeof location !== 'undefined' && sectionLinked\(location\.origin, ELYSIUM_STATUS\)/);
  assert.match(menu, /\.\.\.\(ELYSIUM_LINKED \? \[\{ kind: 'link', href: `#\/\$\{ELYSIUM_KEY\}`, label: ELYSIUM_NAME,/);
  const mode = valueCode(readFileSync(join(APP, 'src/chains/elysium/mode.ts'), 'utf8'));
  assert.deepEqual([...mode.matchAll(/^\s*(?:import|export\s[^;]*\sfrom)\s.*$/gm)].map((m) => m[0]), [], 'the mode imports nothing at run time');
  const identity = strip(readFileSync(join(APP, 'src/config/chainIdentity.ts'), 'utf8'));
  // Changed on purpose 2026-11-07 (Elysium as a fourth V2 chain): one import, Elysium's literals (its id and the build's
  // switch, src/lib/elysiumIdentity.ts), so V2's chain list follows the switch; that file imports nothing at all.
  assert.deepEqual([...identity.matchAll(/^\s*(?:import|export\s[^;]*\sfrom)\s.*$/gm)].map((m) => m[0].trim()), ["import { ELYSIUM_LIVE, ELYSIUM_V2_ID } from '../lib/elysiumIdentity'"], 'the identities import Elysium\'s literals alone');
  assert.doesNotMatch(strip(readFileSync(join(APP, 'src/lib/elysiumIdentity.ts'), 'utf8')), /^\s*(?:import|export\s[^;]*\sfrom)\s/m, 'which import nothing: literals only');
  assert.doesNotMatch(identity, /kinetiq|https?:\/\/[^'\n]*elysium/i, 'no Elysium endpoint rides in every page');
});
