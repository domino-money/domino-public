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
