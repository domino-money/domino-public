/**
 * The wallet picker for every chain (src/chains/eip6963.ts, 2026-10-01, the chain2 workstream, audit items G11 and
 * G12): only well-formed announcements, a wallet's name as text and never its icon, the registry's chain id in the
 * switch, a wallet that does not know the chain told apart (4902, also wrapped), and nothing asked but reads and the
 * switch.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { test } from 'node:test';

const require = createRequire(import.meta.url);
const picker = require('../.test-build/app/src/chains/eip6963.js');
const { ELYSIUM, ROBINHOOD } = require('../.test-build/app/src/config/chains.js');

const provider = (handler) => {
  const asked = [];
  return { asked, request: async (args) => (asked.push(args), handler(args)) };
};
const detail = (info, request = async () => null) => ({ info: { uuid: '350670db-19fa-4704-a166-e52e178b59d2', name: 'MetaMask', rdns: 'io.metamask', icon: 'data:image/svg+xml,<svg/>', ...info }, provider: { request } });

test('only well-formed announcements are wallets, named as text, without their icon', () => {
  const wallet = picker.announced(detail({}));
  assert.deepEqual(wallet.info, { uuid: '350670db-19fa-4704-a166-e52e178b59d2', name: 'MetaMask', rdns: 'io.metamask' });
  assert.equal('icon' in wallet.info, false);
  for (const bad of [{ uuid: 'x' }, { name: '' }, { name: 'A‮B' }, { name: 'x'.repeat(41) }, { rdns: 'not a domain' }]) assert.equal(picker.announced(detail(bad)), null, JSON.stringify(bad));
  assert.equal(picker.announced({ info: detail({}).info, provider: {} }), null, 'no request function');
  assert.equal(picker.announced(null), null);
});

test('discovery asks the browser\'s wallets to announce themselves and lists each once, by name', () => {
  const target = new EventTarget();
  const lists = [];
  target.addEventListener('eip6963:requestProvider', () => {
    target.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail: detail({ name: 'Rabby', rdns: 'io.rabby', uuid: 'aaaaaaaa-0000-0000-0000-000000000001' }) }));
    target.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail: detail({}) }));
    target.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail: detail({ name: 'MetaMask again' }) }));
    target.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail: { junk: true } }));
  });
  const stop = picker.discoverWallets(target, (list) => lists.push(list.map((w) => w.info.name)));
  assert.deepEqual(lists.at(-1), ['MetaMask again', 'Rabby']);
  stop();
  target.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail: detail({ name: 'Late', uuid: 'bbbbbbbb-0000-0000-0000-000000000002' }) }));
  assert.deepEqual(lists.at(-1), ['MetaMask again', 'Rabby'], 'nothing after stop');
});

test('the switch asks for the registry\'s chain id, and says when the wallet is there, moved, or does not know it', async () => {
  let chain = '0x1237';
  const p = provider(async ({ method, params }) => {
    if (method === 'eth_chainId') return chain;
    if (method === 'wallet_switchEthereumChain') {
      chain = params[0].chainId;
      return null;
    }
  });
  assert.equal(await picker.switchChain(p, ELYSIUM), 'switched');
  assert.deepEqual(p.asked.find((a) => a.method === 'wallet_switchEthereumChain').params, [{ chainId: '0x185d9' }]);
  assert.equal(await picker.switchChain(p, ELYSIUM), 'already');
  assert.equal(await picker.switchChain(p, ROBINHOOD), 'switched');

  const unknown = (error) => provider(async ({ method }) => (method === 'eth_chainId' ? '0x1237' : Promise.reject(error)));
  assert.equal(await picker.switchChain(unknown({ code: 4902, message: 'Unrecognized chain ID' }), ELYSIUM), 'needs-add');
  assert.equal(await picker.switchChain(unknown({ code: -32603, data: { originalError: { code: 4902 } } }), ELYSIUM), 'needs-add', 'MetaMask Mobile wraps it');
  assert.equal(await picker.switchChain(unknown({ code: -32603, message: 'Chain 0x185d9 has not been added' }), ELYSIUM), 'needs-add');
  assert.equal(await picker.switchChain(unknown({ code: 4001, message: 'User rejected' }), ELYSIUM), 'rejected');
  assert.equal(await picker.switchChain(unknown({ code: -32000, message: 'boom' }), ELYSIUM), 'failed');
});

test('accounts are read and checked, lowercase', async () => {
  const p = provider(async ({ method }) => (method === 'eth_requestAccounts' || method === 'eth_accounts' ? ['0xF6184F814543b88Dd867C34cE6E9f56Ab7d18C0a'] : null));
  assert.equal(await picker.connectAccount(p), '0xf6184f814543b88dd867c34ce6e9f56ab7d18c0a');
  assert.equal(await picker.currentAccount(p), '0xf6184f814543b88dd867c34ce6e9f56ab7d18c0a');
  await assert.rejects(picker.connectAccount(provider(async () => [])), /no_account/);
  assert.equal(await picker.currentAccount(provider(async () => ['nope'])), null);
});

test('the picker asks a wallet nothing but who it is, where it is, and to switch: no add, no send, no chain id of its own', () => {
  const source = readFileSync(new URL('../src/chains/eip6963.ts', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  const methods = [...new Set([...source.matchAll(/['"`]((?:eth|wallet|personal)_[A-Za-z]+)['"`]/g)].map((m) => m[1]))].sort();
  assert.deepEqual(methods, ['eth_accounts', 'eth_chainId', 'eth_requestAccounts', 'wallet_switchEthereumChain']);
  assert.doesNotMatch(source, /\b(?:4663|99801|0x1237|0x185d9)\b/, 'every chain id comes from the registry');
  assert.doesNotMatch(source, /window\.ethereum|\.icon\b|localStorage|sessionStorage/);
});

// ---------------------------------------------------------------------------------------------------------------------
// Added 2026-10-15 (pack 8, incident X2: reconnect the wallet used last, or none). After a reload the page reconnects
// the wallet this browser connected last (wallet/memory.ts, its announced id), whichever order the wallets announce
// themselves in, and no other: on ffbd80ab the first wallet that announced itself and still authorized the site won
// (the remembered one went first only among those announced in the same moment), and the "Browser wallet" entry
// (whoever holds window.ethereum) could be reconnected too. Nothing here may open a wallet's prompt: a reload only asks
// a wallet whether it still authorizes the site and reconnects it (wagmi's reconnect, no eth_requestAccounts).
// wallet/port.ts itself runs below, over a fake wagmi config and the real wallet memory.
// ---------------------------------------------------------------------------------------------------------------------
const ts = require('typescript');
const transpile = (path) => ts.transpileModule(readFileSync(new URL(path, import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

function loadMemory() {
  const mod = { exports: {} };
  new Function('require', 'module', 'exports', transpile('../src/wallet/memory.ts'))(() => ({}), mod, mod.exports);
  return mod.exports;
}

/**
 * A page load: `remembered` the wallet connected last on this browser (null: none), `wallets` [rdns, ms after load it
 * announces itself], every one authorizing the site, and `legacy`: window.ethereum holds a provider (authorized too).
 */
async function reload({ remembered = null, wallets = [], legacy = false, settle = 1200, silent = [], stuckReconnect = false } = {}) {
  const store = new Map();
  if (remembered) store.set('domino.wallet.v1', JSON.stringify({ recent: remembered, disconnected: [] }));
  const memory = loadMemory().walletMemory(() => ({ getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v), removeItem: (k) => store.delete(k) }));
  const reconnected = [], prompts = [], authorizedAsked = [];
  let uid = 0;
  const connector = (id, name, type = 'injected') => ({ uid: `uid-${++uid}`, id, name, type,
    isAuthorized: async () => { authorizedAsked.push(id); if (silent.includes(id)) await new Promise(() => {}); return true; },
    connect: async () => { prompts.push(id); throw new Error('a prompt opened'); },
    getProvider: async () => ({ request: async ({ method }) => { if (method === 'eth_requestAccounts') prompts.push(id); return null; } }) });
  const listeners = new Set(), watchers = new Set();
  const config = {
    connectors: [],
    state: { status: 'disconnected', connections: new Map(), current: null },
    setState(change) { config.state = change(config.state); for (const watch of [...watchers]) watch(connection()); },
    _internal: { connectors: {
      setup: (made) => connector(made.target.id, made.target.name),
      setState(change) { config.connectors = change(config.connectors); for (const listen of [...listeners]) listen(config.connectors); },
      subscribe(listen) { listeners.add(listen); return () => listeners.delete(listen); },
    } },
  };
  const connection = () => {
    const current = config.state.current && config.state.connections.get(config.state.current);
    return config.state.status === 'connected' && current ? { status: 'connected', address: `0x${'11'.repeat(20)}`, chainId: 4663, connector: current.connector } : { status: config.state.status };
  };
  const actions = {
    connect: async () => { prompts.push('connect'); throw new Error('a prompt opened'); },
    disconnect: async () => {},
    signMessage: async () => { throw new Error('no signature'); },
    getConnection: () => connection(),
    watchConnection: (_config, { onChange }) => { watchers.add(onChange); return () => watchers.delete(onChange); },
    reconnect: async (_config, { connectors }) => {
      reconnected.push(connectors.map((one) => one.id));
      if (stuckReconnect) return new Promise(() => {});
      config.setState((state) => ({ ...state, status: 'connected', current: connectors[0].uid, connections: new Map([[connectors[0].uid, { connector: connectors[0] }]]) }));
      return [];
    },
  };
  const stubs = {
    viem: { getAddress: (a) => a, numberToHex: (n) => `0x${Number(n).toString(16)}` },
    wagmi: { injected: (options) => options },
    'wagmi/actions': actions,
    '../config/chainIdentity': { V2_CHAIN_IDS: [4663, 8453, 42161] },
    '../session/machine': { ROBINHOOD_CHAIN_ID: 4663 },
    './chain': { ADD_ROBINHOOD_CHAIN: {} },
    './config': { walletConfig: config },
    './codes': { codesOf: () => [] },
    './memory': { memory },
  };
  const win = { setTimeout, clearTimeout, ethereum: legacy ? { request: async ({ method }) => { if (method === 'eth_requestAccounts') prompts.push('window.ethereum'); return []; } } : undefined };
  const mod = { exports: {} };
  new Function('require', 'module', 'exports', 'window', transpile('../src/wallet/port.ts'))((name) => {
    if (!(name in stubs)) throw new Error(`unexpected import ${name}`);
    return stubs[name];
  }, mod, mod.exports, win);
  const named = { 'io.metamask': 'MetaMask', 'io.rabby': 'Rabby', 'app.phantom': 'Phantom' };
  const announce = (id) => config._internal.connectors.setState((list) => [...list, connector(id, named[id] ?? id)]);
  for (const [id, at] of wallets) if (at === 0) announce(id);
  const identities = [];
  const stop = mod.exports.startIdentityFeed((identity) => identities.push(identity.kind === 'connected' ? `connected:${identity.connectorName}` : identity.kind));
  for (const [id, at] of wallets) if (at > 0) setTimeout(() => announce(id), at);
  await sleep(settle);
  stop();
  return { reconnected, prompts, identities, authorizedAsked, config, port: mod.exports };
}

test('a reload reconnects the remembered wallet whichever of two announces itself first, and never the other', async () => {
  for (const wallets of [[['io.metamask', 0], ['io.rabby', 0]], [['io.rabby', 0], ['io.metamask', 0]]]) {
    const page = await reload({ remembered: 'io.rabby', wallets, settle: 400 });
    assert.deepEqual(page.reconnected, [['io.rabby']], JSON.stringify(wallets));
    assert.equal(page.identities.at(-1), 'connected:Rabby');
    assert.equal(page.authorizedAsked.includes('io.metamask'), false, 'the other wallet is not even asked');
  }
  for (const wallets of [[['io.metamask', 0], ['io.rabby', 150]], [['io.rabby', 150], ['io.metamask', 0]], [['io.rabby', 0], ['io.metamask', 150]]]) {
    const page = await reload({ remembered: 'io.rabby', wallets });
    assert.deepEqual(page.reconnected, [['io.rabby']], `announced apart: ${JSON.stringify(wallets)}`);
    assert.deepEqual(page.identities.filter((kind) => kind === 'disconnected'), [], 'no "disconnected" while the remembered wallet is announcing itself');
    assert.equal(page.identities.at(-1), 'connected:Rabby');
  }
});

test('a remembered wallet that announces itself late is still the one reconnected; until then the page says none', async () => {
  const page = await reload({ remembered: 'io.rabby', wallets: [['io.metamask', 0], ['io.rabby', 900]], settle: 1300 });
  assert.deepEqual(page.reconnected, [['io.rabby']]);
  const disconnected = page.identities.indexOf('disconnected');
  assert.ok(disconnected > 0 && disconnected < page.identities.indexOf('connected:Rabby'), 'after REMEMBERED_WAIT_MS: none connected, then the remembered one');
  const gone = await reload({ remembered: 'io.rabby', wallets: [['io.metamask', 0], ['app.phantom', 100]] });
  assert.deepEqual(gone.reconnected, [], 'the remembered wallet is not installed: none, never another');
  assert.equal(gone.identities.at(-1), 'disconnected');
});

test('the "Browser wallet" entry (window.ethereum) is never reconnected when a wallet is remembered', async () => {
  const page = await reload({ remembered: 'io.metamask', legacy: true, wallets: [], settle: 1000 });
  assert.ok(page.config.connectors.some((one) => one.id === page.port.LEGACY_ID), 'offered in the list after LEGACY_WAIT_MS');
  assert.deepEqual(page.reconnected, [], 'never reconnected by itself');
  assert.equal(page.identities.at(-1), 'disconnected');
  const own = await reload({ remembered: page.port.LEGACY_ID, legacy: true, wallets: [], settle: 1000 });
  assert.deepEqual(own.reconnected, [[page.port.LEGACY_ID]], 'unless it is the wallet used last');
});

test('no prompt ever opens by itself on a reload; with no wallet remembered the first that authorizes the site, as before', async () => {
  const runs = [
    await reload({ remembered: 'io.rabby', wallets: [['io.metamask', 0], ['io.rabby', 150]], legacy: true }),
    await reload({ remembered: 'io.metamask', legacy: true }),
    await reload({ wallets: [['io.metamask', 0], ['io.rabby', 0]], settle: 400 }),
  ];
  for (const page of runs) assert.deepEqual(page.prompts, [], 'only "do you still authorize this site" and wagmi\'s reconnect');
  assert.deepEqual(runs[2].reconnected, [['io.metamask']]);
  assert.equal(runs[0].port.REMEMBERED_WAIT_MS, 600);
});

// (2026-10-15, pack 8 review, L4): the "Browser wallet" entry remembered (an extension that once announced nothing), and
// a wallet now announcing itself through EIP-6963: the entry is not offered beside it, so the remembered id names nothing
// listed. Main reconnected the announced wallet that still authorized the site; so does this, with no prompt.
test('a remembered "Browser wallet" entry with an announced wallet now reconnects that wallet, as main, with no prompt', async () => {
  const LEGACY = 'injected';
  for (const at of [0, 100]) {
    const page = await reload({ remembered: LEGACY, legacy: true, wallets: [['io.metamask', at]], settle: 1000 });
    assert.deepEqual(page.reconnected, [['io.metamask']], `announced at ${at} ms`);
    assert.equal(page.identities.at(-1), 'connected:MetaMask');
    assert.deepEqual(page.prompts, []);
    assert.equal(page.config.connectors.some((one) => one.id === LEGACY), false, 'the entry is not offered beside it');
  }
  const two = await reload({ remembered: LEGACY, legacy: true, wallets: [['io.rabby', 0], ['io.metamask', 0]], settle: 400 });
  assert.deepEqual(two.reconnected, [['io.rabby']], 'the first that authorizes the site, in the list\'s order, as main');
  assert.deepEqual(two.prompts, []);
});

// Added 2026-11-09 (core flows, the owner: nothing may load forever): a wallet that never says whether it still authorizes
// the site, or a reconnect that never answers, held the page's identity on "unknown" for good (every page that waits for it
// on its loading frame). Past AUTHORIZED_WAIT_MS the next wallet is asked; past RECONNECT_WAIT_MS the page says none.
test('a wallet that never answers a reload does not hold the page: the next one is asked, or none is connected', async () => {
  const first = await reload({ wallets: [['io.metamask', 0], ['io.rabby', 0]], silent: ['io.metamask'], settle: 5_600 });
  assert.equal(first.port.AUTHORIZED_WAIT_MS, 5_000);
  assert.deepEqual(first.authorizedAsked, ['io.metamask', 'io.rabby'], 'the silent wallet, then the next one');
  assert.deepEqual(first.reconnected, [['io.rabby']]);
  assert.equal(first.identities.at(-1), 'connected:Rabby');
  assert.deepEqual(first.prompts, []);
  const stuck = await reload({ remembered: 'io.rabby', wallets: [['io.rabby', 0]], stuckReconnect: true, settle: 10_600 });
  assert.equal(stuck.port.RECONNECT_WAIT_MS, 10_000);
  assert.deepEqual(stuck.reconnected, [['io.rabby']]);
  assert.equal(stuck.identities[0], 'unknown', 'connecting from the start');
  assert.equal(stuck.identities.at(-1), 'disconnected', 'a reconnect that never answered is said as none connected');
  assert.deepEqual(stuck.prompts, []);
});
