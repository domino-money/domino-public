/**
 * Elysium on the screens' lists (added 2026-11-07, Elysium's screens; docs/ELYSIUM_DAY9.md section 4 and section 7): every
 * list a screen keeps of "the other networks" or of "the three" now comes from the app's chain list
 * (src/config/chainIdentity.ts V2_CHAIN_IDS and OTHER_V2_CHAIN_IDS), so it names Elysium (99901), last, exactly where the
 * build serves it, and is today's list everywhere else. Each module is loaded twice from the compiled app (.test-build):
 * as today's build has it (Elysium off, as the release build is), and as a build where Elysium is live has it
 * (tests/v2/support/elysium-live.mjs ELYSIUM_FORCED; withFunds where funds can come from it too).
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { ELYSIUM_FORCED, loadWith, withFunds } from './support/elysium-live.mjs';

const require = createRequire(import.meta.url);
const BUILD = '../../.test-build/app/src/';
const ID = 99901;
const OWNER = '0x70997970c51812dc3a010c7d01b50e0d17dc79c8';
const ZERO = '0x0000000000000000000000000000000000000000';

const modules = () => ({
  identity: require(`${BUILD}config/chainIdentity.js`),
  networks: require(`${BUILD}v2in/journey/model/networks.js`),
  pools: require(`${BUILD}v2in/journey/model/pools.js`),
  routes: require(`${BUILD}components/explore/routes.js`),
  poolNetwork: require(`${BUILD}components/explore/poolNetwork.js`),
  networkMarkets: require(`${BUILD}lib/read/networkMarkets.js`),
  journal: require(`${BUILD}finance/v2/signatureJournal.js`),
  recovery: require(`${BUILD}v2in/lists/priceRecovery.js`),
  handoff: require(`${BUILD}v2in/automate/handoff.js`),
  collection: require(`${BUILD}v2in/lists/positionCollection.js`),
  holdings: require(`${BUILD}finance/v2/holdings.js`),
  funds: require(`${BUILD}v2in/funds/model.js`),
  intent: require(`${BUILD}v2in/funds/fundingIntent.js`),
  wallet: require(`${BUILD}v2in/walletNetworks/model.js`),
  chains: require(`${BUILD}v2/chains.js`),
  elysium: require(`${BUILD}lib/elysiumIdentity.js`),
  words: require(`${BUILD}lib/nativeWords.js`),
  types: require(`${BUILD}v2/types.js`),
});
const OFF = modules();
const ON = loadWith(require, ELYSIUM_FORCED, modules);
const FUNDS = loadWith(require, withFunds, modules);

/** A gate of each mode, as src/v2/gate.ts hands them (only `mode` is read here). */
const gates = (chains, mode) => Object.freeze(Object.fromEntries(chains.map((chainId) => [chainId, Object.freeze({ mode, chainId })])));

test('the other networks: Base and Arbitrum One today; Base, Arbitrum One and Elysium, last, where the build serves it', () => {
  assert.deepEqual([...OFF.identity.OTHER_V2_CHAIN_IDS], [8453, 42161]);
  assert.deepEqual([...ON.identity.OTHER_V2_CHAIN_IDS], [8453, 42161, ID]);
  assert.deepEqual([...ON.identity.V2_CHAIN_IDS], [4663, 8453, 42161, ID]);
  for (const value of [8453, 42161]) assert.equal(OFF.identity.isOtherV2ChainId(value), true);
  for (const value of [4663, ID, '8453', 1, null, undefined]) assert.equal(OFF.identity.isOtherV2ChainId(value), false, String(value));
  assert.equal(ON.identity.isOtherV2ChainId(ID), true);
  for (const value of [4663, String(ID), 99801, 999]) assert.equal(ON.identity.isOtherV2ChainId(value), false, String(value));
  // The Wallet card's networks follow the same list (src/v2in/walletNetworks/model.ts).
  assert.deepEqual([...OFF.wallet.WALLET_NETWORK_CHAINS], [8453, 42161]);
  assert.deepEqual([...ON.wallet.WALLET_NETWORK_CHAINS], [8453, 42161, ID]);
});

test('New position: the networks offered and read, and the gates merged, are every V2 chain the build serves', () => {
  assert.deepEqual(OFF.networks.offeredNetworks(gates([4663, 8453, 42161], 'live')), [8453, 42161]);
  assert.deepEqual(ON.networks.offeredNetworks(gates([4663, 8453, 42161, ID], 'live')), [8453, 42161, ID]);
  assert.deepEqual(ON.networks.readableNetworks(gates([4663, 8453, 42161, ID], 'preview')), [8453, 42161, ID]);
  assert.deepEqual(ON.networks.offeredNetworks(gates([4663, 8453, 42161, ID], 'preview')), [], 'a preview gate offers nothing to create, on Elysium as elsewhere');
  assert.deepEqual(ON.networks.readableNetworks({ ...gates([4663, 8453, 42161], 'preview'), [ID]: { mode: 'off', chainId: ID } }), [8453, 42161], 'a gate that is off is never read');
  // A chain once live stays live; Elysium's gate is merged as the others' are.
  const held = gates([4663, 8453, 42161, ID], 'preview');
  const next = { ...held, [ID]: Object.freeze({ mode: 'live', chainId: ID }) };
  const merged = ON.networks.mergeGates(held, next);
  assert.equal(merged[ID], next[ID]);
  assert.equal(merged[8453], held[8453], 'the others keep the very gate they had');
  assert.equal(ON.networks.mergeGates(merged, held), merged, 'live stays live, and nothing changed comes back as it was');
  // Today, the three alone, exactly as before.
  const three = gates([4663, 8453, 42161], 'preview');
  assert.equal(OFF.networks.mergeGates(three, gates([4663, 8453, 42161], 'preview')), three);
});

test('a pool read on Elysium is a pool of New position where the build serves it, v4 alone; nowhere today', () => {
  const tokenOf = (chainId, address) => ({ address, symbol: 'T', decimals: 18, chainId });
  const option = (chainId, dex = 4) => ({
    key: `0x${'ab'.repeat(32)}`, dex, currencies: [tokenOf(chainId, ZERO), tokenOf(chainId, '0x598b40933060c2e1b6ca8c875bd1afc12d9493d8')],
    feePips: 3000, tickSpacing: 60, hooks: ZERO, tick: 0, sqrtPriceX96: '79228162514264337593543950336', block: 1, readAt: null,
  });
  assert.equal(OFF.pools.poolFromList(option(ID)), null, 'Elysium is no V2 chain today');
  const pool = ON.pools.poolFromList(option(ID));
  assert.ok(pool, 'a v4 pool there is a pool');
  assert.equal(ON.pools.poolFromList({ ...option(ID, 3), key: `0x${'0'.repeat(24)}${'cd'.repeat(20)}` }), null, 'never a v3 pool on a v4-only chain');
  assert.ok(OFF.pools.poolFromList(option(8453)), 'Base, as before');
});

test('Markets and the Wallet card: an Elysium row is another network\'s row, as Base\'s and Arbitrum One\'s are', () => {
  const market = (chainId) => ({ tokens: { base: { chainId } } });
  assert.equal(OFF.networkMarkets.onNetwork(market(ID)), false);
  assert.equal(ON.networkMarkets.onNetwork(market(ID)), true);
  for (const build of [OFF, ON]) {
    assert.equal(build.networkMarkets.onNetwork(market(4663)), false);
    assert.equal(build.networkMarkets.onNetwork(market(8453)), true);
  }
  // The Wallet card asks about Elysium's own currencies from its profile, after Base's and Arbitrum One's.
  const asked = ON.wallet.walletBalanceTokens(null);
  assert.deepEqual([...new Set(asked.map((token) => token.chainId))], [8453, 42161, ID]);
  assert.deepEqual(asked.filter((token) => token.chainId === ID).map((token) => token.symbol), ['HYPE', 'WHYPE', 'USDC']);
  assert.equal(OFF.wallet.walletBalanceTokens(null).some((token) => token.chainId === ID), false);
});

test('signatures, price recovery, automation hand-offs and the positions\' order take Elysium only where it is served', async () => {
  const memory = () => {
    const items = new Map();
    return { get length() { return items.size; }, key: (i) => [...items.keys()][i] ?? null, getItem: (k) => items.get(k) ?? null, setItem: (k, v) => items.set(k, String(v)), removeItem: (k) => items.delete(k) };
  };
  const locks = { request: (_name, run) => run() };
  const entry = { chainId: ID, owner: OWNER, space: 'zap', verifier: '0x' + 'd4'.repeat(20), nonce: 7n };
  await assert.rejects(OFF.journal.createSignatureJournal(memory(), locks).record(entry), /invalid_signature_nonce/);
  const journal = ON.journal.createSignatureJournal(memory(), locks);
  await journal.record(entry);
  assert.equal(journal.held(entry), true);
  assert.equal(journal.list(ID, OWNER).length, 1);
  // Price recovery: a fresh Elysium position whose token's price read failed is surveyed where Elysium is served.
  const portfolio = {
    wallet: OWNER,
    chains: [{ chainId: ID, status: 'current' }],
    tokens: [{ chainId: ID, address: '0x' + '5e'.repeat(20), decimals: 18, price: null, priceReason: 'price_read_failed' }],
    positions: [{ chainId: ID, state: { status: 'live', freshness: { status: 'fresh' }, pool: { currency0: '0x' + '5e'.repeat(20), currency1: ZERO }, principalAtSpot: ['1', '0'], feesOwed: ['0', '0'] } }],
  };
  assert.deepEqual(OFF.recovery.priceRecoveryTargets(portfolio), []);
  assert.deepEqual(ON.recovery.priceRecoveryTargets(portfolio), [{ wallet: OWNER, chainId: ID, address: '0x' + '5e'.repeat(20) }]);
  // A vault handed to the automation panel.
  const vault = '0x' + 'ab'.repeat(20);
  OFF.handoff.offerVault({ chainId: ID, vault, focus: 'rearm' });
  assert.equal(OFF.handoff.waitingVault(), null, 'today an Elysium vault is no hand-off');
  ON.handoff.offerVault({ chainId: ID, vault, focus: 'rearm' });
  assert.deepEqual(ON.handoff.takeVault(ID, vault), { chainId: ID, vault, focus: 'rearm' });
  // Positions: the networks in the chain list's order, Elysium after Arbitrum One, any other network after them all.
  const row = (chainId, tokenId) => ({ chainId, dex: 4, tokenId });
  const order = ON.collection.newestFirst([row(ID, '5'), row(1, '1'), row(42161, '2'), row(4663, '3'), row(8453, '4')]).map((r) => r.chainId);
  assert.deepEqual(order, [4663, 8453, 42161, ID, 1]);
  assert.deepEqual(OFF.collection.newestFirst([row(1, '1'), row(42161, '2'), row(4663, '3'), row(8453, '4')]).map((r) => r.chainId), [4663, 8453, 42161, 1]);
});

test('funds from Elysium: nowhere today or on day 9; only where crosschain pins a bridge for it, as an origin read apart, its HYPE never brought as ETH', () => {
  for (const build of [OFF, ON]) {
    assert.equal(build.holdings.CANDIDATE_ORIGINS.some((origin) => origin.chainId === ID), false);
    assert.equal(build.funds.BALANCE_ORIGINS.includes(ID), false);
    assert.equal(build.funds.balanceChainsRequest(8453).some((token) => token.chainId === ID), false);
  }
  assert.deepEqual(OFF.holdings.CANDIDATE_ORIGINS.map((origin) => origin.chainId), [4663, 1, 8453, 42161, 10]);
  assert.deepEqual(FUNDS.holdings.CANDIDATE_ORIGINS.map((origin) => origin.chainId), [4663, 1, 8453, 42161, 10, ID]);
  const elysium = FUNDS.holdings.CANDIDATE_ORIGINS.at(-1);
  assert.equal(elysium.name, 'Elysium');
  assert.deepEqual(elysium.tokens.map((token) => token.symbol), ['HYPE', 'WHYPE', 'USDC']);
  assert.ok(elysium.tokens.every((token) => token.address === token.address.toLowerCase()));
  assert.equal(FUNDS.funds.BALANCE_ORIGINS.at(-1), ID);
  // Read in the request of its own (beside Ethereum's and OP Mainnet's), never in Domino's three's.
  assert.equal(FUNDS.funds.balancesRequest(8453).some((token) => token.chainId === ID), false);
  assert.deepEqual(FUNDS.funds.balanceChainsRequest(8453).filter((token) => token.chainId === ID).map((token) => token.address), elysium.tokens.map((token) => token.address));
  // HYPE and WHYPE are no ether; Elysium's dollar token is a dollar.
  assert.equal(FUNDS.funds.kindOf(ID, ZERO), null);
  assert.equal(FUNDS.funds.kindOf(ID, elysium.tokens[1].address), null);
  assert.equal(FUNDS.funds.kindOf(ID, elysium.tokens[2].address), 'dollar');
  assert.equal(FUNDS.funds.kindOf(8453, ZERO), 'ether', 'Base, as before');
  // A saved transfer from Elysium is read back only where funds can come from it.
  const saved = JSON.stringify({
    version: 1, id: 'f1', owner: OWNER, destinationChainId: 8453, destinationToken: ZERO, scope: 's', requiredRaw: '1', createdAt: 1,
    legs: [{ id: 'l1', originChainId: ID, originToken: elysium.tokens[2].address, symbol: 'USDC', decimals: 6, maxInputRaw: '1', minimumOutputRaw: '1', state: 'ready', destinationGas: false, depositTxHash: null }],
  });
  assert.equal(OFF.intent.parseFunding(saved, OWNER, 8453), null);
  assert.equal(ON.intent.parseFunding(saved, OWNER, 8453), null);
  assert.equal(FUNDS.intent.parseFunding(saved, OWNER, 8453)?.legs[0].originChainId, ID);
});

// Added 2026-11-07 (review finding P1): New position's V1 screens ask lib/elysiumIdentity.ts fundsBroughtTo whether an offer
// to bring funds sits below a short amount; it says what V2's own list of deposit destinations says, on every V2 network.
test('New position offers to bring funds exactly where a deposit can reach: every V2 network but Elysium', () => {
  for (const [label, build] of [['off', OFF], ['on', ON], ['funds', FUNDS]]) {
    for (const chainId of build.identity.V2_CHAIN_IDS) assert.equal(build.elysium.fundsBroughtTo(chainId), build.types.isS2Destination(chainId), `${label}: ${chainId}`);
  }
  for (const chainId of [4663, 8453, 42161]) assert.equal(OFF.elysium.fundsBroughtTo(chainId), true);
  assert.equal(OFF.elysium.fundsBroughtTo(ID), true, 'today no network is Elysium: nothing changes');
  assert.equal(ON.elysium.fundsBroughtTo(ID), false);
  assert.equal(FUNDS.elysium.fundsBroughtTo(ID), false, 'funds coming from Elysium are never funds brought to it');
});

// Added 2026-11-07 (review finding P6): the V1 sentences New position shares with V2's networks name Elysium's own
// currency there, whole words only, and are as written everywhere else.
test('a sentence written for Ether reads HYPE and WHYPE on Elysium where the build serves it, and as written everywhere else', () => {
  const sentences = ['Add ETH for the network fee to continue.', 'Native ETH', 'Network fees are extra, paid in ETH.', 'WETH or ETH, never ETHER'];
  for (const sentence of sentences) {
    for (const chainId of [4663, 8453, 42161, ID, null, undefined]) assert.equal(OFF.words.nativeWords(sentence, chainId), sentence, `off: ${chainId}`);
    for (const chainId of [4663, 8453, 42161, null, undefined]) assert.equal(ON.words.nativeWords(sentence, chainId), sentence, `on: ${chainId}`);
  }
  assert.equal(ON.words.nativeWords('Add ETH for the network fee to continue.', ID), 'Add HYPE for the network fee to continue.');
  assert.equal(ON.words.nativeWords('Native ETH', ID), 'Native HYPE');
  assert.equal(ON.words.nativeWords('WETH or ETH, never ETHER', ID), 'WHYPE or HYPE, never ETHER');
});
