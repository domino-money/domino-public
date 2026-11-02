#!/usr/bin/env bash
# Shared commands for the hosted control and the disposable Clawber guest.
# No deployment or production service is part of a pilot workload.
set -Eeuo pipefail

workload=${1:-}
phase=${2:-run}
case "$workload" in
  read-worker|contracts-v1|contracts-v2-audit|browser-finance-create|backend) ;;
  *) echo 'Usage: run-pilot-workload.sh {read-worker|contracts-v1|contracts-v2-audit|browser-finance-create|backend} {prepare|run}' >&2; exit 64 ;;
esac
case "$phase" in prepare|run) ;; *) echo 'Invalid pilot phase' >&2; exit 64 ;; esac
cd "$(dirname "${BASH_SOURCE[0]}")/../.."

metrics=${DOMINO_PILOT_TIMINGS:-${RUNNER_TEMP:-${TMPDIR:-/tmp}}/domino-ci-pilot-timings.jsonl}
mkdir -p "$(dirname "$metrics")"

# GNU date is present in both Ubuntu 24.04 environments. Keep failed timings
# and the command's exit status; successful reporting must not conceal failure.
timed() {
  local name=$1 began ended status elapsed
  shift
  began=$(date +%s%N)
  set +e
  "$@"
  status=$?
  set -e
  ended=$(date +%s%N)
  elapsed=$(( (ended - began) / 1000000 ))
  printf '{"workload":"%s","phase":"%s","status":%d,"durationMs":%d}\n' "$workload" "$name" "$status" "$elapsed" >> "$metrics"
  if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
    printf '| %s | %s | %d | %d |\n' "$workload" "$name" "$status" "$elapsed" >> "$GITHUB_STEP_SUMMARY"
  fi
  return "$status"
}

prepare() {
  case "$workload" in
    read-worker) ;; # The current Read Worker job requires no dependency install.
    contracts-*) timed install-root npm ci --no-audit --no-fund ;;
    browser-*)
      timed install-web npm --prefix web ci --no-audit --no-fund
      timed install-app npm --prefix app ci --no-audit --no-fund
      ;;
    backend)
      timed install-root npm ci --no-audit --no-fund
      timed install-app npm --prefix app ci --no-audit --no-fund
      timed install-python python -m pip install -r backend/requirements-api.lock
      ;;
  esac
}

contracts() {
  local part=${workload#contracts-} suites suite
  timed forge-cache-test node --test scripts/forge-cache.test.mjs
  timed forge-cache-prune node scripts/forge-cache.mjs prune
  if [ "$part" != v1 ]; then
    (
      cd contracts
      timed contract-artifacts node ../scripts/test-contracts.mjs build \
        src/v2/registry/DominoRegistry.sol src/v2/anchor/DominoPriceAnchor.sol \
        src/v2/autoexit/DominoAutoExit.sol src/v2/vault/DominoV2VaultSwapModule.sol \
        src/v2/vault/DominoV2VaultV3.sol src/v2/vault/DominoV2VaultV4.sol src/v2/vault/DominoV2VaultFactory.sol \
        src/v2/zap/DominoZapV3.sol src/v2/zap/DominoZapV4.sol src/v2/zap/DominoZapV4Steps.sol \
        test/v2/integration/IntegrationArtifacts.sol
    )
  fi
  case "$part" in
    v2-audit) suites=$(find contracts/test/v2/adversarial contracts/test/v2/invariant -name '*.t.sol' | sort) ;;
    v1) suites=$(find contracts/test -name '*.t.sol' -not -path 'contracts/test/v2/*' | sort) ;;
  esac
  test -n "$suites"
  for suite in $suites; do
    echo "::group::${suite}"
    timed contract-suite node scripts/test-contracts.mjs --match-path "${suite#contracts/}"
    echo '::endgroup::'
  done
  timed gas-tool-tests node --test scripts/gas-baseline.test.mjs scripts/mutate-contracts.test.mjs
  timed gas-baseline node scripts/gas-baseline.mjs --check --part "$part"
  timed forge-cache-record node scripts/forge-cache.mjs record
}

backend_started=false
cleanup() {
  local status=$?
  trap - EXIT
  if [ "$backend_started" = true ]; then
    set +e
    local stopped=0
    timed postgres-stop python backend/dev_postgres.py stop || stopped=$?
    if [ "$status" -eq 0 ]; then status=$stopped; fi
  fi
  exit "$status"
}

backend() {
  export DOMINO_TEST_POSTGRES=1 DOMINO_TEST_EVM=1
  export DOMINO_PG_BIN=/usr/lib/postgresql/16/bin
  export DOMINO_V2_COMPILE_CACHE=${RUNNER_TEMP:-${TMPDIR:-/tmp}}/v2-deploy-compile
  trap cleanup EXIT
  timed forge-cache-test node --test scripts/forge-cache.test.mjs
  timed forge-cache-prune node scripts/forge-cache.mjs prune
  (cd contracts; timed setup-artifacts node ../scripts/test-contracts.mjs build test/setup/DominoSetup.t.sol)
  timed v4-fixture node scripts/test-contracts.mjs --match-path test/reference/OfficialDominoExecutionV4.t.sol
  timed swap-fixture node scripts/test-contracts.mjs --match-path test/audit_engine/SwapReinvestment.t.sol
  timed public-build node scripts/build-public-release.mjs
  timed public-manifest node scripts/release-artifact-manifest.mjs --check
  (
    cd contracts
    timed v2-artifacts node ../scripts/test-contracts.mjs build \
      src/v2/registry/DominoRegistry.sol src/v2/anchor/DominoPriceAnchor.sol \
      src/v2/autoexit/DominoAutoExit.sol src/v2/vault/DominoV2VaultSwapModule.sol \
      src/v2/vault/DominoV2VaultV3.sol src/v2/vault/DominoV2VaultV4.sol src/v2/vault/DominoV2VaultFactory.sol \
      src/v2/zap/DominoZapV3.sol src/v2/zap/DominoZapV4.sol src/v2/zap/DominoZapV4Steps.sol \
      test/reference/OfficialV3Fixture.sol
  )
  local script
  for script in export-read-contract export-read-v2-contract export-read-v3-contract; do
    timed contract-export python "scripts/$script.py" --check
  done
  timed read-v3-parity python scripts/check-read-v3-parity.py
  for script in export-read-openapi export-session-contract export-onboarding-contract export-deposit-contract \
    export-performance-contract export-performance-v2-contract export-execution-contract export-crosschain-contract \
    export-read-v6-contract export-position-plan-contract; do
    timed contract-export python "scripts/$script.py" --check
  done
  test -x "$DOMINO_PG_BIN/initdb"
  local pattern
  for pattern in test_catalogue_postgres.py test_upgrade_postgres.py test_dev_catalogue_profile.py test_upgrade_financial.py; do
    timed staging-postgres env DOMINO_TEST_STAGING_POSTGRES=1 python -B -m unittest discover -s scripts/staging/tests -p "$pattern" -v
  done
  backend_started=true # Cleanup also runs after a partially failed initialization.
  timed postgres-prepare python backend/dev_postgres.py prepare-tests
  timed backend-tests python -m unittest discover -s backend/tests -v
  timed unsigned-release-tests node --test scripts/prepare-financial-release.test.mjs scripts/prepare-financial-release-rpc.test.mjs scripts/release-artifact-manifest.test.mjs scripts/build-public-release.test.mjs
  timed v2-deploy-tests node --test scripts/v2/deploy.test.mjs scripts/v2/deploy-preflight.test.mjs scripts/v2/deploy-schema.test.mjs scripts/v2/deploy-fork.test.mjs scripts/v2/release-manifest.test.mjs
  timed v2-manifest node scripts/v2/release-manifest.mjs --check --forge-out contracts/out
  timed forge-cache-record node scripts/forge-cache.mjs record
}

if [ "$phase" = prepare ]; then
  prepare
else
  case "$workload" in
    read-worker) timed read-worker npm run check:read-bridge ;;
    contracts-*) contracts ;;
    browser-finance-create)
      timed build-unit npm --prefix app run build:unit
      timed build-app npm --prefix app run build
      timed browser-finance-create npm --prefix app run test:finance-create
      ;;
    backend) backend ;;
  esac
fi
