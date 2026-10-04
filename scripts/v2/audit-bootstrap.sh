#!/bin/sh
# Rebuild the V2 audit candidate from a clean checkout and leave every V2 suite
# runnable one at a time (reports/V2_AUDIT_PACKAGE.md section 1; audit DV2-03:
# the earlier instructions built neither the integration artifacts nor the V1
# contracts below, so a clean checkout ran no behavioural test).
#
# The order matters:
# 1. dependencies from the lockfiles: the pinned Forge and solc-js live in
#    node_modules;
# 2. the seven V1 contracts whose sizes scripts/test-contracts.mjs checks after
#    every suite (its gate fails a run without them, V2 suites included);
# 3. the twelve V2 contracts and the integration artifacts the wired suites
#    load by name (vm.getCode), exactly as CI's Contracts (v2) and
#    Contracts (v2-audit) jobs build them;
# 4. the release manifest, against an independent compile and those artifacts.
#
# Then run one suite at a time, e.g.:
#   node scripts/test-contracts.mjs --match-path test/v2/adversarial/AutoExitInvariants.t.sol
set -eu
cd "$(dirname "$0")/../.."

npm ci --no-audit --no-fund
npm --prefix app ci --no-audit --no-fund

cd contracts
node ../scripts/test-contracts.mjs build \
  src/DominoVaultReadHelper.sol src/DominoVaultV4.sol src/DominoVaultFactoryV4.sol \
  src/DominoExecutionEngineV4.sol src/DominoRoutingHelperV4.sol src/DominoPriceGuardV4.sol src/DominoSetup.sol
node ../scripts/test-contracts.mjs build \
  src/v2/registry/DominoRegistry.sol src/v2/anchor/DominoPriceAnchor.sol \
  src/v2/autoexit/DominoAutoExit.sol src/v2/vault/DominoV2VaultSwapModule.sol \
  src/v2/vault/DominoV2VaultV3.sol src/v2/vault/DominoV2VaultV4.sol src/v2/vault/DominoV2VaultFactory.sol \
  src/v2/zap/DominoZapV3.sol src/v2/zap/DominoZapV4.sol src/v2/zap/DominoZapV4Steps.sol \
  test/v2/integration/IntegrationArtifacts.sol
cd ..

node scripts/v2/release-manifest.mjs --check --forge-out contracts/out
echo 'V2 audit build ready: run one suite at a time with node scripts/test-contracts.mjs --match-path <suite>.'
