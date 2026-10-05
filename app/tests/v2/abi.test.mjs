/**
 * The V2 clients' ABIs (src/finance/v2/abi.ts) carry every function the spec names, under the spec's exact selectors
 * (spec F7 §2.1, §5, appendix A), and the hand-declared standard items are the standard ones.
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { toFunctionSelector } from 'viem';

const require = createRequire(import.meta.url);
const abi = require('../../.test-build/app/src/finance/v2/abi.js');

const selectors = (items) => new Map(items.filter((item) => item.type === 'function').map((item) => [toFunctionSelector(item), item.name]));
const expectAll = (items, table, label) => {
  const have = selectors(items);
  for (const [selector, name] of Object.entries(table)) assert.equal(have.get(selector), name, `${label}: ${name} ${selector}`);
};

test('the zap: the four actions in their three consents, nonces and checks (§2.1)', () => {
  expectAll(abi.ZAP_ABI, {
    '0x0e97b041': 'create', '0xec627dfe': 'createWithPermit', '0x2e563c43': 'increase', '0xc6b4277b': 'increaseWithPermit',
    '0x2abb5a53': 'changeRange', '0xf6b7af55': 'changeRangeWithSignature', '0xda5951bb': 'exit', '0x2573777b': 'exitWithSignature',
    '0x4fe02b44': 'nonceBitmap', '0x2bce68d2': 'invalidateNonces', '0x791b98bc': 'positionManager', '0x4c70f1f2': 'hookedPoolsAllowed', '0xf698da25': 'domainSeparator',
  }, 'zap');
});

test('the vault factory and the vault (§5, appendix A)', () => {
  expectAll(abi.VAULT_FACTORY_ABI, { '0xee568446': 'createVault', '0xb6a98fbc': 'predictVault', '0x0cd55abf': 'nextNonce', '0x652b9b41': 'isVault' }, 'factory');
  expectAll(abi.VAULT_ABI, {
    '0x8da5cb5b': 'owner', '0x16f0115b': 'pool', '0xebf0c717': 'root', '0xba5b7982': 'positions', '0x0505c8c9': 'policy', '0x860aefcf': 'limits',
    '0x5c975abb': 'paused', '0x19edb7b8': 'rootArmed', '0x7e25850b': 'stateNonce', '0xd66bd524': 'reserves', '0x97073538': 'exitModule',
    '0x740b167b': 'setPolicy', '0x2853449f': 'setLimits', '0x8456cb59': 'pause', '0x046f7da2': 'resume', '0xf6fa162e': 'rearm',
    '0xf28bf186': 'withdrawReserves', '0x76175193': 'withdrawChild', '0xb29a8140': 'recoverToken', '0x5b6c508c': 'exitAll', '0x325be671': 'setExitModule',
    '0x956d113b': 'member', '0x74b453f0': 'lot', '0x8d137367': 'idleReserves', '0x82564bca': 'quoteCurrency', '0xda3f1b44': 'lastExecutionAt', '0xf578affa': 'recoverPosition',
    // Changed on purpose (data) 2026-10-02 (Domino V2 integration, spec rev4 §5.6, #311): anyone returns a closed vault's reserves to its owner.
    '0x8192ff3b': 'returnReserves',
  }, 'vault');
  // One returnReserves item, whether the ledger's export carries it (main after #311) or abi.ts adds it.
  assert.equal(abi.VAULT_ABI.filter((item) => item.type === 'function' && item.name === 'returnReserves').length, 1);
});

test('the auto-exit module, frozen and extension (§4, appendix A)', () => {
  expectAll(abi.AUTO_EXIT_ABI, {
    '0x68c665c2': 'registerMandate', '0xd91ebc2a': 'revokeMandate', '0x0a6cdf56': 'mandateStatus', '0xf698da25': 'domainSeparator',
    '0x19eee827': 'mandateOf', '0x1647795e': 'nonceUsed', '0x4d2c3175': 'unclaimed', '0xcfdd7aea': 'cancelNonce', '0x21c0b342': 'claim',
    '0xe229cd76': 'MAX_SLIPPAGE_BPS', '0x9c392d2c': 'maxObservationAgeSeconds', '0x0036c27c': 'minTwapSeconds',
  }, 'autoExit');
});

test('the registry, Permit2 and the position managers (appendix A)', () => {
  expectAll(abi.REGISTRY_ABI, { '0x62260388': 'chargeCurrencyRank', '0x7c043d8c': 'automationHalted', '0x39827635': 'routerVersion' }, 'registry');
  expectAll(abi.PERMIT2_ABI, { '0x4fe02b44': 'nonceBitmap', '0x3ff9dcb1': 'invalidateUnorderedNonces' }, 'permit2');
  expectAll(abi.V4_POSITION_MANAGER_ABI, { '0x095ea7b3': 'approve', '0x081812fc': 'getApproved', '0x16a24131': 'subscriber', '0xad0b27fb': 'unsubscribe', '0x6352211e': 'ownerOf' }, 'v4 PositionManager');
  expectAll(abi.V3_POSITION_MANAGER_ABI, { '0x095ea7b3': 'approve', '0x081812fc': 'getApproved', '0x99fbab88': 'positions', '0x6352211e': 'ownerOf' }, 'v3 NonfungiblePositionManager');
  expectAll(abi.ERC20_ABI, { '0xdd62ed3e': 'allowance', '0x095ea7b3': 'approve', '0x70a08231': 'balanceOf' }, 'ERC-20');
});

test('no ABI carries setApprovalForAll: approvals are individual, always', () => {
  for (const [name, items] of Object.entries(abi)) {
    assert.equal(items.some((item) => item.name === 'setApprovalForAll'), false, name);
  }
});
