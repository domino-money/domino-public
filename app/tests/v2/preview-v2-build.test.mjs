/**
 * The preview-v2 build (Domino V2 integration, 2026-10-02): the site exactly as production builds it, with Domino V2
 * compiled in, published by hand to the preview alias and never released.
 *
 *   - the mode resolves to production's defines for V1 (live reads of the reviewed pools, wallet sign-in, no test hooks,
 *     `__DOMINO_DEPLOYABLE__` true: V1's pin insisted on, no build banner, the chain read) plus V2 and V2's fixture sets;
 *     it is not deployable, writes to its own directory, marks its page, and runs the published site's own bundle check;
 *   - every other mode keeps what it had: `__DOMINO_DEPLOYABLE__` true only where the page is the site (production,
 *     development, preview-v2), V2's fixture sets taken only where V2 is carried by a build that is not deployable;
 *   - the page mark and every V2 marker are refused by a release; the published site's check refuses what no site may
 *     carry and lets V2's own marked test data through;
 *   - the V2 money modules take a fixture set in preview-v2 (up to a review; src/finance/v2/liveLock.ts refuses its sends)
 *     and refuse it, as before, in a deployable build.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { resolveConfig } from 'vite';
import { FORBIDDEN, PREVIEW_SITE_FORBIDDEN, assertDeployable, findForbidden } from '../../scripts/deploy-markers.mjs';
import { createV2Chain, walletOf as zapWalletOf } from '../support/v2-chain.mjs';
import { createVaultChain, vaultContracts, walletOf as vaultWalletOf } from '../support/v2-vault-chain.mjs';

const require = createRequire(import.meta.url);
const APP = resolve(import.meta.dirname, '../..');
const CONFIG = join(APP, 'vite.config.ts');
const BUILD = resolve(APP, '.test-build/app/src');
const chains = require(`${BUILD}/v2/chains.js`);
const NOW = 1_790_870_000;

const resolveFor = (mode) => resolveConfig({ root: APP, configFile: CONFIG, configLoader: 'runner', mode, logLevel: 'silent' }, 'build', mode);
const plugin = (config, name) => config.plugins.find((p) => p.name === name);

/** Every mode of the MODES table, by name, with its row's text. */
const ROWS = (() => {
  const config = readFileSync(CONFIG, 'utf8');
  return Object.fromEntries([...config.slice(config.indexOf('const MODES'), config.indexOf('} as const')).matchAll(/^\s+'?([a-z0-9-]+)'?: \{(.+)\},?$/gm)].map(([, name, row]) => [name, row]));
})();

// ---------------------------------------------------------------------------
// The mode
// ---------------------------------------------------------------------------

// Changed on purpose 2026-10-04 (the owner: the site runs on Domino V2, deployed and pinned): production carries V2 too,
// with its pinned production manifests and never its fixture sets; preview-v2 differs from it only by those fixture sets
// (and the page mark that goes with them), and stays never deployable.
test('preview-v2 is production with V2\'s fixture sets: the same V1 and V2 defines but the fixture sets, never deployable', async () => {
  const production = await resolveFor('production');
  const preview = await resolveFor('preview-v2');
  const V1 = ['__DOMINO_READ_MODE__', '__DOMINO_POOL_SET__', '__DOMINO_DEPLOYABLE__', '__DOMINO_WALLET_SESSION__', '__DOMINO_TEST_HOOKS__', '__DOMINO_LOCAL_LIVE__', '__DOMINO_ONBOARDING_PREVIEW__', '__DOMINO_DEPOSIT_LAB__', '__DOMINO_V2__'];
  for (const name of V1) assert.equal(preview.define[name], production.define[name], `${name} is production's`);
  assert.deepEqual(V1.map((name) => preview.define[name]), ['"bridge"', '"selected"', 'true', 'true', 'false', 'false', 'false', 'false', 'true']);
  assert.deepEqual([preview.define.__DOMINO_V2__, preview.define.__DOMINO_V2_FIXTURE_SETS__], ['true', 'true']);
  assert.deepEqual([production.define.__DOMINO_V2__, production.define.__DOMINO_V2_FIXTURE_SETS__], ['true', 'false'], 'production: V2 on, never its fixture sets');
  assert.equal(preview.define.__DOMINO_V2_PREVIEW__, undefined, 'the old fixture-only preview build is gone (item 6)');
  assert.equal(preview.build.outDir, '.preview-v2-dist');
  const row = ROWS['preview-v2'];
  assert.ok(row, 'preview-v2 has its row');
  assert.match(row, /read: 'bridge', pools: 'selected', deployable: false, outDir: '\.preview-v2-dist', lab: false, wallet: true, testHooks: false, preview: false, depositLab: false, v2: true, site: true/);
  assert.match(ROWS.production, /deployable: true, outDir: 'dist', lab: false, wallet: true, testHooks: false, preview: false, depositLab: false, v2: true, site: true/);
  // Its page is marked, and the published site's own check runs over its bundle; the deployable one does not.
  assert.ok(plugin(preview, 'domino:v2-build-mark'), 'the page mark');
  assert.ok(plugin(preview, 'domino:v2-screens-css'), 'V2\'s class names reach its CSS');
  assert.ok(plugin(preview, 'domino:preview-site-bundle-check'));
  assert.equal(plugin(production, 'domino:v2-build-mark'), undefined, 'production carries V2 but never the mark of a build with its test data');
  assert.ok(plugin(production, 'domino:v2-screens-css'), 'V2\'s class names reach production\'s CSS');
  // The boot script sends the list's first reads there, as on domino.money.
  const { scripts } = JSON.parse(readFileSync(join(APP, 'package.json'), 'utf8'));
  assert.equal(scripts['build:preview-v2'], 'tsc --noEmit && vite build --mode preview-v2');
  assert.deepEqual(readFileSync(join(APP, '.gitignore'), 'utf8').split(/\r?\n/).filter((line) => line === '.preview-v2-dist/'), ['.preview-v2-dist/'], 'ignored by git, and so by Tailwind\'s scan of the app');
});

test('every mode: the page is the site for V1 only in production, development and preview-v2; V2\'s fixture sets only where V2 is carried and not deployable', async () => {
  const expected = { site: ['development', 'preview-v2', 'production'] };
  const site = [];
  for (const mode of Object.keys(ROWS)) {
    const config = await resolveFor(mode);
    if (config.define.__DOMINO_DEPLOYABLE__ === 'true') site.push(mode);
    const v2 = /\bv2: true\b/.test(ROWS[mode]);
    const deployable = /\bdeployable: true\b/.test(ROWS[mode]);
    assert.equal(config.define.__DOMINO_V2_FIXTURE_SETS__, JSON.stringify(v2 && !deployable), `${mode} fixture sets`);
    assert.match(ROWS[mode], /\bsite: (true|false)\b/, `${mode} says whether it is the site`);
    // A build that is the site but not deployable publishes a page the site's own check guards.
    assert.equal(Boolean(plugin(config, 'domino:preview-site-bundle-check')), true, `${mode} has the plugin`);
  }
  assert.deepEqual(site.sort(), expected.site);
  const config = readFileSync(CONFIG, 'utf8');
  assert.match(config, /__DOMINO_V2_FIXTURE_SETS__: JSON\.stringify\(settings\.v2 && !settings\.deployable\)/, 'written for every mode from its row');
  assert.match(config, /previewSiteBundleCheck\(mode, !localLive && !settings\.deployable && settings\.site\)/, 'active only for a published site that is not deployable');
});

// ---------------------------------------------------------------------------
// The marks
// ---------------------------------------------------------------------------

test('the page of a build that carries V2 is marked, and the mark is refused by any release and any deployable bundle', async () => {
  const mark = plugin(await resolveFor('preview-v2'), 'domino:v2-build-mark');
  const page = '<!doctype html>\n<html lang="en">\n  <head></head>\n</html>\n';
  const marked = mark.transformIndexHtml.handler(page);
  assert.match(marked, /^<!doctype html>\n<html data-v2-build="preview-v2" lang="en">/);
  assert.ok(findForbidden(marked).some((hit) => hit.marker === 'V2 build'), 'refused by name');
  assert.throws(() => mark.transformIndexHtml.handler('<body></body>'), /no <html> element/);
  // Production's own check refuses the mark and every V2 marker in its bundle.
  const check = plugin(await resolveFor('production'), 'domino:deployable-bundle-check');
  const bundle = (fileName, text) => ({ [fileName]: fileName.endsWith('.js') ? { type: 'chunk', fileName, code: text } : { type: 'asset', fileName, source: text } });
  for (const [file, text] of [
    ['index.html', marked],
    ['assets/index.js', '<main data-v2-test-build="">'],
    ['assets/index.js', '{blockHash:"0xa76e0a19b5a2f32b0a030cb8b8d10ad40fbc2b0520d0982b790ebcc8e2c3eaff"}'],
    ['assets/gate.js', 'transactionHash:"0x6c6acdaf64f555c412908b88045548ce7ea540790976c4adc1432bac15b19846"'],
  ]) {
    assert.throws(() => check.generateBundle.call({}, {}, bundle(file, text)), /deployable and carries what must never ship/, `${file}: ${text}`);
  }
});

test('the published site\'s check refuses what no site may carry and lets V2\'s own marked test data through', async () => {
  const check = plugin(await resolveFor('preview-v2'), 'domino:preview-site-bundle-check');
  const run = (fileName, text) => check.generateBundle.call({}, {}, { [fileName]: fileName.endsWith('.js') ? { type: 'chunk', fileName, code: text } : { type: 'asset', fileName, source: text } });
  for (const text of ['window.__DOMINO_TEST_HOOKS__', 'testHooks', 'depositLab', '/read-lab.html', 'https://rpc.domino.money/AbCdEfGh01234567/', 'LOCAL_RPC_URL', 'robinhood-rpc.publicnode.com', 'rpc.ordofi.network', 'dev-read.domino.money', '<main data-v2-preview-build="">']) {
    assert.throws(() => run('assets/x.js', text), /published as the site and carries what a site must never carry/, text);
  }
  for (const text of ['<html data-v2-build="preview-v2">', 'blockHash:"0xa76e0a19b5a2f32b0a030cb8b8d10ad40fbc2b0520d0982b790ebcc8e2c3eaff"', 'Test data']) {
    assert.doesNotThrow(() => run('assets/x.js', text), text);
  }
  const off = plugin(await resolveFor('v2-test'), 'domino:preview-site-bundle-check');
  assert.doesNotThrow(() => off.generateBundle.call({}, {}, { 'assets/x.js': { type: 'chunk', fileName: 'assets/x.js', code: 'testHooks' } }), 'a test build is not a published site');
  const names = new Set(FORBIDDEN.map((entry) => entry.name));
  for (const name of PREVIEW_SITE_FORBIDDEN) assert.ok(names.has(name), `${name} is a FORBIDDEN marker`);
});

// ---------------------------------------------------------------------------
// The V2 money modules under preview-v2's defines
// ---------------------------------------------------------------------------

const MODULES = ['v2/flag', 'v2/manifest', 'v2/manifestFixtures', 'finance/v2/deployment', 'finance/v2/zap', 'finance/v2/vault', 'finance/v2/autoExit', 'finance/v2/direct', 'finance/v2/liveLock'];
const forget = () => {
  for (const name of MODULES) {
    try {
      delete require.cache[require.resolve(`${BUILD}/${name}.js`)];
    } catch {
      // A module this tree does not have yet.
    }
  }
};
/** The modules loaded fresh under `flags`, then forgotten with the flags. */
function under(flags) {
  forget();
  Object.assign(globalThis, flags);
  try {
    const load = (name) => require(`${BUILD}/${name}.js`);
    return { fixtures: load('v2/manifestFixtures'), deployment: load('finance/v2/deployment'), zap: load('finance/v2/zap'), vault: load('finance/v2/vault'), direct: load('finance/v2/direct') };
  } finally {
    for (const key of Object.keys(flags)) delete globalThis[key];
    forget();
  }
}

test('preview-v2 (the site, with V2\'s fixture sets): a fixture set is taken by the manifest gate and every money client, up to a review', () => {
  const m = under({ __DOMINO_DEPLOYABLE__: true, __DOMINO_V2__: true, __DOMINO_V2_FIXTURE_SETS__: true });
  for (const chainId of [4663, 8453, 42161]) assert.equal(m.fixtures.fixtureContracts(chainId).fixture, true, `the gate's fixture set on ${chainId}`);
  const zapChain = createV2Chain();
  assert.equal(typeof m.zap.createZapClient(zapWalletOf(zapChain), chains.v2Chain(zapChain.home), zapChain.contracts, () => NOW).review, 'function');
  const vaultChain = createVaultChain({ chainId: 4663, timestamp: NOW });
  assert.ok(m.vault.createVaultClient(vaultWalletOf(vaultChain), chains.v2Chain(4663), vaultContracts(4663), () => NOW));
  assert.ok(m.direct.createDirectClient(vaultWalletOf(vaultChain), chains.v2Chain(4663), () => NOW, { ...chains.v2Chain(4663).verifiedCode }));
  assert.equal(zapChain.log.length, 0, 'nothing was asked of a wallet to build them');
});

test('production and development (deployable, no fixture sets): a fixture set is refused, as before, even with V2 compiled in', () => {
  for (const v2 of [false, true]) {
    const m = under({ __DOMINO_DEPLOYABLE__: true, __DOMINO_V2__: v2, __DOMINO_V2_FIXTURE_SETS__: false });
    assert.throws(() => m.fixtures.fixtureContracts(4663), /manifest_fixture_refused/);
    const zapChain = createV2Chain();
    assert.throws(() => m.zap.createZapClient(zapWalletOf(zapChain), chains.v2Chain(zapChain.home), zapChain.contracts, () => NOW), /deployment_fixture_refused/);
    const vaultChain = createVaultChain({ chainId: 4663, timestamp: NOW });
    assert.throws(() => m.vault.createVaultClient(vaultWalletOf(vaultChain), chains.v2Chain(4663), vaultContracts(4663), () => NOW), /deployment_fixture_refused/);
    assert.throws(() => m.direct.createDirectClient(vaultWalletOf(vaultChain), chains.v2Chain(4663), () => NOW, { ...chains.v2Chain(4663).verifiedCode }), /deployment_fixture_refused/);
  }
  // A test build that carries V2 (not deployable) takes them, as before.
  const test = under({ __DOMINO_DEPLOYABLE__: false, __DOMINO_V2__: true, __DOMINO_V2_FIXTURE_SETS__: true });
  assert.equal(test.fixtures.fixtureContracts(8453).fixture, true);
});
