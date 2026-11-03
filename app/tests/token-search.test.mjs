/**
 * Token search by name (tokenSearch.ts): the merge of the tokens this app
 * knows by address, and the ranking of a typed name over their labels. Pure
 * functions, compiled by tsconfig.test.json into .test-build.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { test } from 'node:test';
import * as runtime from '../../api-contracts/read-v1/runtime.mjs';

const require = createRequire(import.meta.url);
const built = (name) => require(`../.test-build/app/src/${name}.js`);
const { knownTokens, searchTokens } = built('lib/read/screens/tokenSearch');
const { candidateFromToken, handoffFor } = built('lib/read/screens/tokens');
const { catalogueTokens } = built('config/selectedPoolCatalogue');

const READ = resolve(import.meta.dirname, '../../api-contracts/read-v1');
const fixture = (name) => JSON.parse(readFileSync(resolve(READ, `fixtures/gateway/${name}.json`), 'utf8'));

const USDG = '0x5fc5360d0400a0fd4f2af552add042d716f1d168';
const WETH = '0x0bd7d308f8e1639fab988df18a8011f41eacad73';
const MARLIN = '0xab35d04e1ee39c789c4a65d522417b3c7f2e4723';
const OTHER = `0x${'22'.repeat(20)}`;
const THIRD = `0x${'33'.repeat(20)}`;

const catalogue = [
  { address: WETH, label: 'WETH', artwork: 'WETH' },
  { address: USDG, label: 'USDG', artwork: 'USDG' },
  { address: MARLIN, label: 'MARLIN', artwork: 'MARLIN' },
];

/** A candidate as a wallet listing makes one: identity is the lowercase address; the symbol is whatever the contract said. */
const walletRow = (address, symbol, balance, why = null) => ({
  key: address,
  wire: address,
  token: { origin: 'read', chainId: 4663, address, symbol, decimals: 18, readStatus: 'available', artwork: null },
  kind: 'erc20_candidate',
  why,
  reasonCode: null,
  decimalsUnavailable: false,
  source: 'wallet',
  balance: balance === null ? null : { label: 'Balance', text: balance, state: 'value' },
  page: 1,
  old: false,
  block: null,
});

/** A candidate as a pasted-address read makes one, through the real projection of a real fixture. */
const pasted = (address, symbol, wire = address) => {
  const payload = fixture('token.success');
  const data = runtime.assertResponse('token', { ...payload, asset: { ...payload.asset, address, symbol } });
  return candidateFromToken(data, wire);
};

const keys = (list) => list.map((token) => token.key);
const hits = (results) => results.map((result) => (result.kind === 'known' ? result.token.key : `address:${result.key}`));

test('knownTokens merges by lowercase address: one entry, every source it is known from, the read candidate kept', () => {
  const read = pasted(USDG, 'USDG', `0x${USDG.slice(2).toUpperCase()}`);
  const known = knownTokens({ catalogue, candidates: [read, walletRow(USDG, 'USDG', '12.5')] });
  assert.equal(known.filter((token) => token.key === USDG).length, 1);
  const usdg = known.find((token) => token.key === USDG);
  assert.deepEqual(usdg.sources, ['catalogue', 'read', 'wallet']);
  assert.equal(usdg.wire, USDG, 'a catalogue token goes on the wire as its lowercase address');
  assert.equal(usdg.artwork, 'USDG');
  assert.equal(usdg.candidate.source, 'wallet', 'a later candidate for the same address replaces the earlier one');
  assert.equal(usdg.balanceText, '12.5');
});

test('label precedence: the read symbol, else the catalogue label, else null; artwork from the read token, else the catalogue', () => {
  const known = knownTokens({
    catalogue,
    candidates: [pasted(WETH, 'Wrapped'), walletRow(MARLIN, null, '1'), walletRow(OTHER, null, '2'), pasted(THIRD, 'THIRD')],
  });
  const byKey = Object.fromEntries(known.map((token) => [token.key, token]));
  assert.equal(byKey[WETH].label, 'Wrapped', 'a read symbol is the label');
  assert.equal(byKey[MARLIN].label, 'MARLIN', 'no symbol read: the catalogue label');
  assert.equal(byKey[OTHER].label, null, 'no symbol, no catalogue: unlabelled');
  assert.equal(byKey[THIRD].label, 'THIRD');
  assert.equal(byKey[USDG].label, 'USDG');
  assert.equal(byKey[USDG].candidate, null);
  assert.equal(byKey[WETH].artwork, 'WETH', 'the read token carries curated artwork by address');
  assert.equal(byKey[MARLIN].artwork, 'MARLIN', 'a wallet row without artwork falls back to the catalogue');
  assert.equal(byKey[OTHER].artwork, null);
});

test('order: catalogue order first, then every other address in candidate order, however the candidates were listed', () => {
  const known = knownTokens({ catalogue, candidates: [walletRow(THIRD, 'C', '1'), walletRow(USDG, 'USDG', '1'), walletRow(OTHER, 'B', '1'), walletRow(WETH, 'WETH', '1')] });
  assert.deepEqual(keys(known), [WETH, USDG, MARLIN, THIRD, OTHER]);
});

test('balance text only for a selectable wallet row; a pasted read has none; a later unreadable row clears it', () => {
  const known = knownTokens({ catalogue: [], candidates: [walletRow(OTHER, 'B', '4.0'), walletRow(THIRD, 'C', '9', 'wallet_unavailable'), pasted(USDG, 'USDG')] });
  const byKey = Object.fromEntries(known.map((token) => [token.key, token]));
  assert.equal(byKey[OTHER].balanceText, '4.0');
  assert.equal(byKey[THIRD].balanceText, null, 'a row whose balance could not be read shows none');
  assert.equal(byKey[USDG].balanceText, null);
  assert.deepEqual(byKey[USDG].sources, ['read']);
  const replaced = knownTokens({ catalogue: [], candidates: [walletRow(OTHER, 'B', '4.0'), walletRow(OTHER, 'B', null, 'wallet_unavailable')] });
  assert.equal(replaced[0].balanceText, null);
});

test('a pasted address not in the catalogue keeps its wire exactly as typed', () => {
  const typed = `0x${OTHER.slice(2).toUpperCase()}`;
  const [token] = knownTokens({ catalogue: [], candidates: [pasted(OTHER, 'B', typed)] });
  assert.equal(token.key, OTHER);
  assert.equal(token.wire, typed);
});

test('an empty query lists every known token, catalogue-sourced first, up to the limit', () => {
  const known = knownTokens({ catalogue, candidates: [walletRow(OTHER, 'B', '1'), walletRow(THIRD, null, '1')] });
  const all = searchTokens('', known);
  assert.deepEqual(hits(all), [WETH, USDG, MARLIN, OTHER, THIRD]);
  assert.ok(all.every((result) => result.kind === 'known' && result.rank === 0));
  assert.deepEqual(hits(searchTokens('   ', known)), hits(all), 'whitespace is an empty query');
  assert.deepEqual(hits(searchTokens('', known, 2)), [WETH, USDG]);
  // Catalogue-sourced first even when the caller's list is not in that order.
  assert.deepEqual(hits(searchTokens('', [...known].reverse())), [MARLIN, USDG, WETH, THIRD, OTHER]);
});

test('a name ranks labels case-insensitively: exact 0, prefix 1, substring 2, stable within a rank, unlabelled never', () => {
  const known = knownTokens({
    catalogue: [
      { address: WETH, label: 'WETH', artwork: 'WETH' },
      { address: USDG, label: 'USDG', artwork: 'USDG' },
      { address: MARLIN, label: 'USDGX', artwork: null },
    ],
    candidates: [walletRow(OTHER, 'xUSDG', '1'), walletRow(THIRD, null, '1'), pasted(`0x${'44'.repeat(20)}`, 'usdg')],
  });
  const results = searchTokens('usdg', known);
  assert.deepEqual(results.map((result) => [result.token.key, result.rank]), [
    [USDG, 0],
    [`0x${'44'.repeat(20)}`, 0],
    [MARLIN, 1],
    [OTHER, 2],
  ]);
  assert.deepEqual(hits(searchTokens('  Usd ', known)), [USDG, MARLIN, `0x${'44'.repeat(20)}`, OTHER], 'trimmed, case-insensitive, prefixes in known order before the substring');
  assert.deepEqual(hits(searchTokens('eth', known)), [WETH], 'a substring alone');
  assert.deepEqual(hits(searchTokens('zzz', known)), []);
  assert.ok(!hits(searchTokens('usdg', known)).includes(THIRD), 'a token with no label never matches a name');
});

test('nothing but the label is searched: an artwork key, an address fragment or a source name finds nothing by name', () => {
  const known = knownTokens({ catalogue: [{ address: WETH, label: 'Wrapped Ether', artwork: 'WETH' }], candidates: [walletRow(OTHER, 'B', '1')] });
  assert.deepEqual(hits(searchTokens('WETH', known)), []);
  assert.deepEqual(hits(searchTokens('0bd7', known)), []);
  assert.deepEqual(hits(searchTokens('0x0bd7', known)), []);
  assert.deepEqual(hits(searchTokens('wallet', known)), []);
  assert.deepEqual(hits(searchTokens('catalogue', known)), []);
});

test('an address query: the known token with that key, else the address itself, sent exactly as typed and keyed lowercase', () => {
  const known = knownTokens({ catalogue, candidates: [walletRow(OTHER, 'B', '1')] });
  const upper = `0x${USDG.slice(2).toUpperCase()}`;
  assert.deepEqual(searchTokens(upper, known), [{ kind: 'known', token: known[1], rank: 0 }]);
  assert.deepEqual(searchTokens(` ${OTHER} `, known), [{ kind: 'known', token: known[3], rank: 0 }]);
  const typed = `0x${THIRD.slice(2).toUpperCase()}`;
  assert.deepEqual(searchTokens(typed, known), [{ kind: 'address', wire: typed, key: THIRD }]);
  assert.deepEqual(searchTokens(`0X${THIRD.slice(2)}`, known), [], 'an upper-case 0X is not an address and matches no label');
  assert.deepEqual(searchTokens(THIRD.slice(0, 20), known), [], 'a partial address is not an address and matches no label');
});

test('the limit bounds a name query after ranking', () => {
  const candidates = Array.from({ length: 12 }, (_, i) => walletRow(`0x${(i + 1).toString(16).padStart(40, '0')}`, `TOK${i}`, '1'));
  const known = knownTokens({ catalogue: [], candidates });
  assert.equal(searchTokens('tok', known).length, 8, 'eight by default');
  assert.equal(searchTokens('tok', known, 3).length, 3);
  assert.equal(searchTokens('tok', known, 100).length, 12);
  assert.deepEqual(hits(searchTokens('tok1', known, 2)), [candidates[1].key, candidates[10].key], 'exact first, then the prefix hit, in order');
});

test('exclusion is not the search’s business: an excluded token is still found and left for the component to disable', () => {
  const known = knownTokens({ catalogue, candidates: [] });
  assert.equal(searchTokens.length, 2, 'query and known; the limit has a default and there is no exclude');
  assert.deepEqual(hits(searchTokens('USDG', known)), [USDG]);
  assert.deepEqual(hits(searchTokens(USDG, known)), [USDG]);
});

test('a search’s token read is handed over only for exactly the wire it read', () => {
  const read = pasted(USDG, 'USDG', `0x${USDG.slice(2).toUpperCase()}`);
  assert.equal(handoffFor(read, read.wire), read);
  assert.equal(handoffFor(read, USDG), null, 'another spelling is another request on the wire');
  assert.equal(handoffFor(walletRow(USDG, 'USDG', '1'), USDG), null, 'a wallet row is not a token read');
  assert.equal(handoffFor({ ...pasted(USDG, 'USDG'), block: null }, USDG), null, 'a candidate with no block was never read');
  assert.equal(handoffFor(null, USDG), null);
  assert.equal(handoffFor(undefined, USDG), null);
});

test('only a selectable answer is handed over: an unreadable token, whose reason may pass, is read again by the view it opens', () => {
  const read = (name) => candidateFromToken(runtime.assertResponse('token', fixture(name)), OTHER);
  for (const name of ['token.unavailable', 'token.call-gas-limit']) {
    const unreadable = read(name);
    assert.equal(unreadable.why, 'unreadable', name);
    assert.equal(handoffFor(unreadable, OTHER), null, `${name}: a transient answer stays the search’s, and the view asks for itself`);
  }
  assert.equal(handoffFor(read('token.missing-contract'), OTHER), null, 'nothing that cannot be chosen is handed over');
  for (const name of ['token.success', 'token.missing-decimals', 'token.zero-decimals']) {
    const usable = read(name);
    assert.equal(handoffFor(usable, OTHER), usable, `${name}: a selectable answer, partial metadata included, is handed over`);
  }
});

// Changed on purpose 2026-10-04 (the owner's new embedded list): the six tokens are PONS, USDG, ORBIO, CASHCAT, UBIK and
// VIRTUAL. The list still holds native ETH, in ETH/USDG as before, but that row names no addresses (only a read of the
// pool says native or wrapped), so ETH is not among them; WETH, whose pool left the list, is not either.
// Changed on purpose 2026-11-02 (the owner's new embedded list): seven tokens, PONS, USDG, ETH, TORCH, CASHCAT, PRIORS
// and VIRTUAL. ETH/TORCH holds no USDG, so its row names both currencies, native ETH by the zero address as its pool key
// does (the read service answers that address as native ETH); the ETH/USDG row still names none. WETH is not among them.
test('the selected pools’ catalogue names seven tokens by address, native ETH by ETH/TORCH’s row, and USDG, ETH and TORCH are found by name', () => {
  const ZERO = `0x${'0'.repeat(40)}`;
  const TORCH = '0x000050e18ffa3f8f7ad170eb9cef160eb3ed1111';
  const known = knownTokens({ catalogue: catalogueTokens(), candidates: [] });
  assert.deepEqual(known.map((token) => token.label), ['PONS', 'USDG', 'ETH', 'TORCH', 'CASHCAT', 'PRIORS', 'VIRTUAL']);
  assert.ok(known.every((token) => token.sources.length === 1 && token.sources[0] === 'catalogue' && token.candidate === null));
  assert.equal(known.find((token) => token.key === ZERO)?.artwork, 'ETH', 'native ETH, by the zero address ETH/TORCH names');
  assert.ok(!known.some((token) => token.key === WETH), 'no selected pool holds WETH');
  assert.deepEqual(hits(searchTokens('usdg', known)), [USDG]);
  assert.deepEqual(hits(searchTokens('eth', known)), [ZERO]);
  assert.deepEqual(hits(searchTokens('torch', known)), [TORCH]);
  assert.deepEqual(hits(searchTokens('cashcat', known)), ['0x020bfc650a365f8bb26819deaabf3e21291018b4']);
});
