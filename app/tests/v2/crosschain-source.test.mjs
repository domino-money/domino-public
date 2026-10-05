/**
 * Source checks for src/v2/crosschain (spec F7 §3.1: the app never calls Relay or Across; §1.8: the pure V2 modules
 * name no wallet method). Comments are stripped first, as tests/session.source-guard.test.mjs does, so documentation
 * may name what code may not use. Also holds S2's wiring to its shape (Changed on purpose (data) 2026-10-02 (S2 wired)):
 * the HTTP transport is imported by the page's one route module alone, the runtime by the offer's page module alone, the
 * forwarder has the crosschain family the spec writes, declared ahead of its Worker, and wrangler.toml binds no
 * crosschain Worker until it is deployed.
 */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, posix, relative, resolve } from 'node:path';
import { test } from 'node:test';
import { build, SRC } from './support/crosschain.mjs';

const require = createRequire(import.meta.url);
const APP = resolve(SRC, '../../..');
const stripComments = (text) =>
  text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/\s\/\/\s.*$/gm, '');

function sources(dir) {
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...sources(path));
    else if (/\.(ts|tsx)$/.test(entry.name)) files.push({ path: relative(resolve(APP, 'src'), path).replaceAll('\\', '/'), code: stripComments(readFileSync(path, 'utf8')) });
  }
  return files;
}
const MINE = sources(SRC);
const ALL = sources(resolve(APP, 'src'));
const specifiers = (code) => [...code.matchAll(/(?:from|import)\s*\(?\s*'([^']+)'/g)].map((match) => match[1]);
const hits = (files, pattern) => files.flatMap(({ path, code }) => (pattern.test(code) ? [path] : []));
/** The one sentence that names Relay's site: the manual recovery the spec quotes for refund_failed (§3.7). It is text, not a request. */
const RECLAIM = 'Automatic refund failed. Reclaim your deposit at relay.link/withdraw with this wallet. If this is a smart or blocked wallet, contact Relay support.';

test('the module is the files this report describes', () => {
  assert.deepEqual(MINE.map((f) => f.path).sort(), [
    'v2/crosschain/amounts.ts',
    'v2/crosschain/client.ts',
    'v2/crosschain/contract.ts',
    'v2/crosschain/copy.ts',
    'v2/crosschain/errors.ts',
    'v2/crosschain/fixtureTransport.ts',
    'v2/crosschain/forwarder.ts',
    'v2/crosschain/httpTransport.ts',
    'v2/crosschain/polling.ts',
    'v2/crosschain/present.ts',
    'v2/crosschain/steps.ts',
    'v2/crosschain/transport.ts',
    'v2/crosschain/types.ts',
    'v2/crosschain/version.ts',
  ]);
});

test('no URL, no Relay or Across host, no fetch and no other network API: the app never calls a bridge provider', () => {
  const code = MINE.map(({ path, code }) => ({ path, code: path === 'v2/crosschain/copy.ts' ? code.replace(RECLAIM, '') : code }));
  assert.ok(MINE.find((f) => f.path === 'v2/crosschain/copy.ts').code.includes(RECLAIM), 'the reclaim sentence is where this test expects it');
  assert.deepEqual(hits(code, /https?:|wss?:|\/\/[a-z0-9-]+\.[a-z]/i), [], 'no URL');
  assert.deepEqual(hits(code, /relay\.link|across\.to|relay\.to|li\.fi|socket\.tech|\.relay\.|\.across\./i), [], 'no provider host');
  assert.deepEqual(hits(code, /\bfetch\s*\(|XMLHttpRequest|WebSocket|EventSource|sendBeacon|importScripts/), [], 'no network call');
  // The one path the module names is the same-origin prefix, declared once.
  assert.deepEqual(hits(MINE, /\/api\//), ['v2/crosschain/forwarder.ts', 'v2/crosschain/transport.ts']);
});

test('no wallet method, no signing, no transaction API, no chain switch, no approval call', () => {
  assert.deepEqual(hits(MINE, /['"`](eth_[A-Za-z0-9_]+|wallet_[A-Za-z0-9_]+|personal_sign|net_version)['"`]/), []);
  assert.deepEqual(hits(MINE, /\.request\s*\(|\bsendTransaction\b|\bwriteContract\b|\bsignTypedData\b|\bsignMessage\b|\bsendCalls\b|\bapprove\s*\(|switchChain|switchToChain/), []);
});

test('no browser storage and no clock of its own: the journal is data, the clock is injected', () => {
  assert.deepEqual(hits(MINE, /\b(localStorage|sessionStorage|indexedDB|document\.cookie|caches)\b/), []);
  assert.deepEqual(hits(MINE, /\bDate\.now\b|\bperformance\.now\b|new Date\(|\bsetTimeout\b|\bsetInterval\b/), []);
  assert.deepEqual(hits(MINE, /dangerouslySetInnerHTML|innerHTML/), []);
});

test('imports stay inside the module, the V2 foundation and the package’s types; only contract.ts takes the runtime', () => {
  const offenders = [];
  for (const { path, code } of MINE) {
    for (const spec of specifiers(code)) {
      if (spec.startsWith('./')) continue;
      if (spec === '../chains' || spec === '../types') continue;
      if (spec === 'api-contracts/crosschain-v1/types') continue;
      if (spec === 'api-contracts/crosschain-v1/runtime.mjs' && path === 'v2/crosschain/contract.ts') continue;
      offenders.push(`${path}: ${spec}`);
    }
  }
  assert.deepEqual(offenders, [], 'no session, wallet, finance, lib/http, lib/clock, onboarding, deposit, viem, wagmi or React');
  // Type-only, except the runtime in contract.ts.
  const valueImports = MINE.filter(({ code }) => /^import\s+(?!type\b)[^;\n]*from\s+'api-contracts\//m.test(code)).map(({ path }) => path);
  assert.deepEqual(valueImports, ['v2/crosschain/contract.ts']);
});

// Changed on purpose (data) 2026-10-02 (Domino V2 PHASE B, B5 S2): the S2 screens (v2ui/s2, opened only through V2Root in
// the v2-test build) and the closed origin sender (finance/v2/crosschain.ts) now import the module, as this test said
// PHASE B would. The runtime (contract.ts) and the fixture transport are taken by the screens' services alone; the HTTP
// transport and the forwarder design stay unwired (open point 17: no family, Worker, binding or keys), and so do the
// forwarder and wrangler.toml below.
// Changed on purpose (data) 2026-10-02 (S2 wired): the app's side of open point #17 is done. The HTTP transport is wired
// by the page's one V2 route module (finance/v2/http.ts liveCrosschainTransport), the routes probe (v2/routes.ts) knows
// the crosschain route's capabilities, the offer's page module (v2in/funds/live.ts) takes the runtime, and the forwarder
// has the family (functions/_lib/bridge.ts). Since 2026-10-05 the Worker is deployed, off, and production binds it (it
// answers route_not_available and capabilities "disabled" until switched on, read as "off").
test('S2 wired: the offer, the origin sender, the page\'s route module and the routes probe import it; the HTTP transport by finance/v2/http.ts alone; the forwarder has the family, production binds its Worker', () => {
  const outside = ALL.filter(({ path }) => !path.startsWith('v2/crosschain/'));
  const target = (path, spec) => posix.normalize(posix.join(posix.dirname(path), spec));
  const importers = outside.filter(({ path, code }) => specifiers(code).some((spec) => spec.startsWith('.') && target(path, spec).startsWith('v2/crosschain')));
  // Changed on purpose (data) 2026-10-02 (Domino V2 integration, funds): the inline offer in New position's amount step
  // (v2in/funds, opened lazily behind __DOMINO_V2__ only, tests/v2/funds-source.test.mjs) is S2's screen now; it takes
  // the runtime through its own services and the fixture transport through its own fixtures, for the preview gate only.
  assert.deepEqual(
    importers.map((f) => f.path).filter((path) => !/^v2in\/funds\/[A-Za-z0-9]+\.tsx?$/.test(path) && !['finance/v2/crosschain.ts', 'finance/v2/http.ts', 'v2/routes.ts'].includes(path)),
    [],
    'only the S2 screen, the closed origin sender, the page\'s route module and the routes probe',
  );
  const usersOf = (module) => ALL.filter(({ path, code }) => specifiers(code).some((spec) => spec.startsWith('.') && target(path, spec) === `v2/crosschain/${module}`)).map((f) => f.path);
  // Changed on purpose (data) 2026-10-02 (Domino V2 integration, item 6): the old #/v2 S2 screens (v2ui/s2) are gone.
  // Changed on purpose (data) 2026-10-02 (the owner: real data only): the offer builds no fixture client any more.
  assert.deepEqual(usersOf('contract').sort(), ['v2in/funds/live.ts'], 'the runtime is taken by the offer\'s page module alone (the node tests never load it)');
  assert.deepEqual(usersOf('fixtureTransport'), [], 'no fixture transport anywhere in the app');
  assert.deepEqual(usersOf('httpTransport'), ['finance/v2/http.ts'], 'the HTTP transport is imported by the page\'s one V2 route module alone');
  assert.deepEqual(usersOf('forwarder'), [], 'the forwarder design is imported by nothing: functions/_lib/bridge.ts writes the family itself');
  assert.deepEqual(usersOf('version').filter((path) => !path.startsWith('v2/crosschain/')), ['v2/routes.ts'], 'outside the module, the routes probe takes the contract\'s header and version');
  const functions = sources(resolve(APP, 'functions'));
  assert.deepEqual(hits(functions, /crosschain|CROSSCHAIN/), ['../functions/_lib/bridge.ts'], 'the forwarder has the crosschain family, and nothing else of functions/ names it');
  // Changed on purpose 2026-10-05 (the owner: everything integrated on our side): the Worker is deployed, off, so
  // production binds it, and production alone (tests/forwarder.test.mjs holds the layout).
  const toml = readFileSync(resolve(APP, 'wrangler.toml'), 'utf8');
  assert.match(toml, /\[\[env\.production\.services\]\]\nbinding = "CROSSCHAIN_BRIDGE"\nservice = "domino-crosschain-bridge"\n/, 'production binds the crosschain Worker');
  assert.equal(toml.match(/binding = "CROSSCHAIN_BRIDGE"/g)?.length, 1, 'once: the preview binds no crosschain Worker');
});

test('the forwarder design is exactly the family the spec writes (§3.2), frozen, and the family functions/_lib/bridge.ts declares carries it field for field, ahead of its Worker', () => {
  const { CROSSCHAIN_FAMILY_DESIGN, CROSSCHAIN_BINDING_DESIGN } = build('forwarder');
  assert.deepEqual(JSON.parse(JSON.stringify(CROSSCHAIN_FAMILY_DESIGN)), {
    prefix: '/api/crosschain/v1/',
    binding: 'CROSSCHAIN_BRIDGE',
    contract: 'x-domino-crosschain-contract',
    csrf: true,
    cookies: ['__Host-domino-session'],
  });
  assert.ok(Object.isFrozen(CROSSCHAIN_FAMILY_DESIGN) && Object.isFrozen(CROSSCHAIN_FAMILY_DESIGN.cookies));
  assert.deepEqual({ ...CROSSCHAIN_BINDING_DESIGN }, { binding: 'CROSSCHAIN_BRIDGE', service: 'domino-crosschain-bridge' });
  const { CROSSCHAIN_HEADER } = build('version');
  assert.equal(CROSSCHAIN_FAMILY_DESIGN.contract, CROSSCHAIN_HEADER.toLowerCase());
  // Changed on purpose (data) 2026-10-02 (S2 wired): the entry in FAMILIES, as the design says it, plus its name in
  // PREVIEW_FAMILIES, a private family on the preview, and `ahead` (nothing bound: the forwarder's own 404 not_found).
  const bridge = stripComments(readFileSync(resolve(APP, 'functions/_lib/bridge.ts'), 'utf8'));
  const entry = bridge.slice(bridge.indexOf("name: 'crosschain'"), bridge.indexOf('}', bridge.indexOf("name: 'crosschain'")));
  assert.ok(entry.length > 0, 'FAMILIES has the crosschain family');
  for (const line of ["prefix: '/api/crosschain/v1/'", "binding: 'CROSSCHAIN_BRIDGE'", "contract: 'x-domino-crosschain-contract'", 'csrf: true', "cookies: ['__Host-domino-session']", "preview: 'private'", 'ahead: true']) {
    assert.ok(entry.includes(line), `the family says ${line}`);
  }
  assert.match(bridge, /CROSSCHAIN_BRIDGE\?: unknown/, 'the binding is declared in BridgeEnv');
  const { PREVIEW_FAMILY_NAMES } = require('../../.test-build/app/functions/_lib/bridge.js');
  assert.ok(PREVIEW_FAMILY_NAMES.includes('crosschain'), 'the preview may name it');
  // The Worker the binding will name, in position-plan's mould: its own flag, gateway and Access pair, off as committed.
  const toml = readFileSync(resolve(APP, '../bridge/wrangler.crosschain.toml'), 'utf8');
  assert.match(toml, /^name = "domino-crosschain-bridge"$/m);
  assert.match(toml, /^main = "src\/crosschain-worker\.mjs"$/m);
  assert.match(toml, /^CROSSCHAIN_BRIDGE_ENABLED = "false"$/m);
  assert.equal(CROSSCHAIN_BINDING_DESIGN.service, toml.match(/^name = "([^"]+)"$/m)[1]);
});
