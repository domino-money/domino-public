/**
 * TEST-ONLY. A Domino V2 deployment record for a chain with Uniswap v4 alone (added 2026-11-06, Elysium readiness;
 * rugged97's "delta 2": nine contracts instead of 13, `contractNames` still the 13), built from a fork-rehearsal fixture of
 * a chain with both versions. Shared by tests/v2/v4-only-chain.test.mjs (the parsers) and tests/v2/v4-only-screens.test.mjs
 * (the clients), so both run the very same record.
 */

export const V3_CONTRACTS = Object.freeze(['vault.v3', 'vaultFactory.v3', 'zap.v3', 'vaultExecutor.v3']);
export const V3_DEPLOYED = Object.freeze(['vault.v3', 'vaultFactory.v3', 'zap.v3']);
export const V3_DEPENDENCIES = Object.freeze(['v3Factory', 'v3PositionManager', 'v3Quoter', 'v3SwapRouter']);

/** A manifest with v3's contracts, salts, receipts, dependencies and code hashes taken out: what deploy.mjs writes for a chain with v4 alone. */
export function withoutV3(raw) {
  const m = structuredClone(raw);
  for (const name of V3_CONTRACTS) { delete m.contracts[name]; delete m.runtimeCodeHashes[name]; }
  for (const name of V3_DEPLOYED) { delete m.createx.salts[name]; delete m.createx.guardedSalts[name]; delete m.deploymentReceipts[name]; }
  for (const name of V3_DEPENDENCIES) { delete m.dependencies[name]; delete m.runtimeCodeHashes[name]; }
  return m;
}

/**
 * `raw` (a fork-rehearsal manifest with both versions, Arbitrum One's in the tests) moved to `profile`'s chain (`chainId`):
 * its v4 dependencies, their verified code hashes and the chain's charge currencies, v3 taken out.
 */
export function v4OnlyManifest(raw, profile, chainId) {
  const m = withoutV3(raw);
  const lower = (address) => address.toLowerCase();
  const verified = (address) => profile.verification.contracts.find((entry) => lower(entry.address) === lower(address)).codehash;
  m.chain = { name: profile.name, chainId, nativeCurrency: 'HYPE' };
  const v4 = profile.uniswap.v4;
  const dependencies = { v4PoolManager: v4.poolManager, v4PositionManager: v4.positionManager, v4StateView: v4.stateView, v4Quoter: v4.quoter, universalRouter: profile.uniswap.universalRouter.address, permit2: profile.permit2, wrappedNative: profile.wrappedNative.address };
  for (const [name, address] of Object.entries(dependencies)) { m.dependencies[name] = lower(address); m.runtimeCodeHashes[name] = verified(address); }
  m.chargeCurrencies = profile.chargeCurrencies.map((currency) => ({ token: lower(currency.address), rank: currency.rank }));
  return m;
}
