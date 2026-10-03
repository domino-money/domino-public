import test from 'node:test';
import assert from 'node:assert/strict';
import { makeRpc, validateRoleInput, PRODUCTION_DEPLOYER } from './deploy.mjs';
import { startAnvil } from './deploy-anvil.mjs';
import { requireRehearsalFork, upstreamRpc, startFork, OWNER_ROLES, CHAINS } from './deploy-fork.mjs';

test('the rehearsal sends only to an Anvil fork it started itself, never to a loopback upstream', async () => {
  // Robinhood's upstream is a loopback tunnel to the real node: being loopback proves nothing.
  assert.throws(() => requireRehearsalFork(makeRpc('http://127.0.0.1:18551')), /rehearsal_fork_required/);
  const upstream = upstreamRpc('http://127.0.0.1:1', { robinhood: true });
  for (const method of ['eth_sendTransaction', 'eth_sendRawTransaction', 'personal_sendTransaction', 'anvil_setCode', 'anvil_setBalance',
    'anvil_impersonateAccount', 'evm_mine', 'evm_increaseTime', 'hardhat_setCode']) {
    await assert.rejects(upstream(method, []), /rpc_method_not_read_only/);
  }
  // Built in pieces so that the repository's credential scan does not read a URL with user information.
  for (const url of ['https://' + 'user:pass' + '@example.com', 'https://example.com/?key=1', 'https://example.com/#k', 'ws://example.com']) {
    assert.throws(() => upstreamRpc(url), /upstream_url_must_carry_no_credentials/);
  }
  assert.throws(() => upstreamRpc('https://rpc.mainnet.chain.robinhood.com', { robinhood: true }), /robinhood_requires_the_own_node_tunnel/);
});

test('a fork joins the rehearsal only with the profile\'s chain id at the requested block', async () => {
  const upstream = await startAnvil();
  try {
    for (let i = 0; i < 3; i++) await upstream.rpc('evm_mine', []);
    // A fork the guard failed to refuse is stopped, so that the regression fails here instead of hanging the runner.
    const refused = startFork({ chainId: 4663, stack: 'arbitrum-nitro' }, upstream.url, 2).then(async fork => { await fork.stop(); return fork; });
    await assert.rejects(refused, /rehearsal_fork_identity/);
    const fork = await startFork({ chainId: 31337, stack: 'arbitrum-nitro' }, upstream.url, 2);
    try {
      requireRehearsalFork(fork.rpc);
      assert.equal(Number((await fork.rpc('anvil_metadata', [])).forkedNetwork.forkBlockNumber), 2);
    } finally { await fork.stop(); }
  } finally { await upstream.stop(); }
});

test('the rehearsal deploys with the owner\'s checksummed production roles and Safe', () => {
  assert.deepEqual(CHAINS, ['robinhood-4663', 'base-8453', 'arbitrum-42161']);
  const lower = validateRoleInput(OWNER_ROLES, { production: true });
  assert.equal(lower.deployer, PRODUCTION_DEPLOYER);
  assert.equal(lower.governance, '0x2b1d4098ec880058886b95a0e75069a7099c5a9d');
});
