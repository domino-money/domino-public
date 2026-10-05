/**
 * TEST-ONLY. What tests/v2in-browser/automate.test.mjs needs of the old v2-test page helper (the rest went with the
 * #/v2 screens, 2026-10-02, item 6): the fake V2 vault chain (./v2-vault-chain.mjs) as a browser wallet's request
 * handler, in the pattern of tests/position-actions.browser.test.mjs, and read-v6's own valid fixtures adapted to that
 * chain and held to the package's validator, as the site's route will answer them.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import * as readRuntime from '../../../api-contracts/read-v6/runtime.mjs';

/**
 * The chain as a browser wallet: the connection methods a wallet answers itself (accounts, permissions, the switch;
 * capabilities: the chain's when it batches, else none), and every chain method passed to the fake chain. A method the
 * chain does not answer (4200) is recorded in `refused`.
 */
export function walletFor(chain) {
  let permitted = false;
  const refused = [];
  const switches = [];
  async function request(method, params = []) {
    switch (method) {
      case 'eth_requestAccounts': permitted = true; return { result: [chain.owner] };
      case 'wallet_requestPermissions': permitted = true; return { result: [{ parentCapability: 'eth_accounts', caveats: [{ type: 'restrictReturnedAccounts', value: [chain.owner] }] }] };
      case 'wallet_revokePermissions': permitted = false; return { result: null };
      case 'eth_accounts': return { result: permitted ? [chain.owner] : [] };
      case 'wallet_switchEthereumChain': {
        const id = Number(BigInt(params[0]?.chainId ?? '0x0'));
        switches.push(id);
        if (![4663, 8453, 42161].includes(id)) return { error: { code: 4902, message: 'Unrecognized chain ID.' } };
        chain.switchChain(id);
        return { result: null };
      }
      case 'wallet_getCapabilities': {
        // The chain's own answer when it states atomic support (a batching wallet); otherwise none: the steps.
        const reply = await chain.request(method, params);
        return reply.error?.code === 4200 ? { result: {} } : reply;
      }
    }
    const reply = await chain.request(method, params);
    if (reply.error?.code === 4200) refused.push(method);
    return reply;
  }
  return { request, refused, switches };
}

const READ6_VALID = resolve(import.meta.dirname, '../../../api-contracts/read-v6/fixtures/valid');
const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * One of read-v6's own valid fixtures (api-contracts/read-v6/fixtures/valid/<name>.json) as a scripted answer for the
 * page, adapted to the fake chain: every text in `swaps` ([from, to] pairs: the fixture's wallet, vault, module, tokens,
 * ids) replaced at once, then `edit(body)`, then held to the package's validator again, so the page reads only what the
 * contract allows.
 */
export function read6Answer(route, name, swaps = [], edit = () => {}) {
  let text = readFileSync(join(READ6_VALID, `${name}.json`), 'utf8');
  if (swaps.length) {
    const map = new Map(swaps);
    text = text.replace(new RegExp(swaps.map(([from]) => escape(from)).join('|'), 'g'), (found) => map.get(found));
  }
  const body = JSON.parse(text);
  edit(body);
  assert.equal(readRuntime.validateResponse(route, body), true, `${name}, adapted, is still a valid ${route} answer`);
  return { status: 200, body };
}

/** The fixtures' own wallet, vault, auto-exit module and tokens (api-contracts/read-v6/fixtures/valid). */
export const READ6 = Object.freeze({
  wallet: '0xb1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1',
  vault: '0xa2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2',
  module: '0xa4a4a4a4a4a4a4a4a4a4a4a4a4a4a4a4a4a4a4a4',
  usdg: '0x5fc5360d0400a0fd4f2af552add042d716f1d168',
  many: '0x7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a',
});
