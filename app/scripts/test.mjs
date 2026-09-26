// Compiles the pure modules the tests exercise, then runs them under node --test.
// Mirrors web/scripts/test.mjs so both halves of the repository are checked the
// same way. The engine files come from web/lib because the money maths is not
// ours to copy; we compile the same sources the application imports.
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';

// The file list and compiler options live in tsconfig.test.json: CommonJS
// output for node --test, and the `api-contracts/*` path so the read adapter
// compiles against rugged97's contract types in place.
execFileSync(process.execPath, ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.test.json'], { stdio: 'inherit' });
// The onboarding previews (#38) and the deposit consumer (#40/#44): their own
// file list, into the same .test-build tree.
execFileSync(process.execPath, ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.consumer-test.json'], { stdio: 'inherit' });

mkdirSync('.test-build', { recursive: true });
writeFileSync('.test-build/package.json', JSON.stringify({ type: 'commonjs' }));

// `--build-only` (npm run build:unit) stops here. The browser suites load
// .test-build too (the gated server's middleware, the fake chains), and CI runs
// each of them in a job of its own, which needs this build but not these tests.
if (process.argv.includes('--build-only')) process.exit(0);

execFileSync(
  process.execPath,
  [
    '--test',
    'tests/domain.test.mjs',
    'tests/gate.test.mjs',
    'tests/read.test.mjs',
    'tests/read-estimate.test.mjs',
    'tests/read-public.test.mjs',
    'tests/contract-pin.test.mjs',
    'tests/backend-contract.test.mjs',
    'tests/build-guard.test.mjs',
    'tests/forwarder.test.mjs',
    'tests/owned.test.mjs',
    // 2026-09-24: the wallet's Domino positions from chain replace owned-positions (v1 list, row reads, browser memory).
    'tests/wallet-positions.test.mjs',
    // 2026-09-24: a position's feature (plain, Auto-compound or Domino-compound) from chain, and the three features' words.
    'tests/automation-state.test.mjs',
    'tests/release.test.mjs',
    'tests/session.api.test.mjs',
    'tests/session.siwe.test.mjs',
    'tests/session.machine.test.mjs',
    'tests/session.controller.test.mjs',
    'tests/session.refresh.test.mjs',
    'tests/session.privateQuery.test.mjs',
    'tests/session.forwarder.test.mjs',
    'tests/session.source-guard.test.mjs',
    'tests/screens.test.mjs',
    'tests/range-price-input.test.mjs',
    'tests/picker-presentation.test.mjs',
    'tests/token-artwork.test.mjs',
    // 2026-09-24: New position's pool step (usable pools, TVL order, pool-id hints).
    'tests/pool-hints.test.mjs',
    'tests/pool-workspace.test.mjs',
    'tests/create-journey.test.mjs',
    'tests/create-budgets.test.mjs',
    'tests/create-pair-amount.test.mjs',
    'tests/mint-plan.test.mjs',
    'tests/deposit-plan.test.mjs',
    'tests/sequence-options.test.mjs',
    'tests/row-apr.test.mjs',
    'tests/docs.test.mjs',
    'tests/price-series.test.mjs',
    'tests/pool-history.test.mjs',
    'tests/card-series.test.mjs',
    'tests/token-search.test.mjs',
    'tests/market-price.test.mjs',
    'tests/local-live-boundary.test.mjs',
    'tests/local-live-build.test.mjs',
    'tests/local-live-proxy.test.mjs',
    'tests/local-live-credentials.test.mjs',
    'tests/local-live-vite.test.mjs',
    'tests/onboarding.client.test.mjs',
    'tests/onboarding.controller.test.mjs',
    'tests/onboarding.project.test.mjs',
    'tests/deposit.client.test.mjs',
    'tests/deposit.flow.test.mjs',
    'tests/deposit.present.test.mjs',
    'tests/consumer.fixtures.test.mjs',
    'tests/consumer.guard.test.mjs',
    'tests/consumer.port.test.mjs',
    'tests/performance.controller.test.mjs',
    'tests/execution.controller.test.mjs',
    'tests/automation-availability.test.mjs',
    // 2026-09-25 (owner): a sequence's Turn on and Pause, offered only on the automation service's fresh word.
    'tests/sequence-switch.test.mjs',
    'tests/nonce.test.mjs',
    'tests/setup-recovery.test.mjs',
    // 2026-09-25: the EIP-7702 delegates this app recognizes, and the confirmation funding waits for otherwise.
    'tests/delegates.test.mjs',
    // 2026-09-25: Create position's batch (EIP-5792): capabilities, composition, simulation, one offer, the outcome by effect.
    'tests/setup-batch.test.mjs',
    'tests/setup-quoter.test.mjs',
    'tests/position-actions.test.mjs',
    // 2026-09-24: V2 foundation, the pure number, USD, time and chart geometry helpers (lib/format, lib/chart).
    'tests/format.test.mjs',
    'tests/chart-geometry.test.mjs',
    // 2026-09-24 (P6): the fees history, its relay, its pins and its store (DESIGN-V2 §15.7, R-11).
    'tests/fees-replay.test.mjs',
    'tests/fees-relay.test.mjs',
    'tests/fees-topics.test.mjs',
    'tests/fees-store.test.mjs',
    // 2026-09-25: the price path (a busy pool's position from the Swaps of its own life), its estimate and its two reads.
    'tests/fees-path.test.mjs',
    // 2026-09-25: the fees worker's paced lane to the public RPC, and the reads that share it with the page.
    'tests/chain-lane.test.mjs',
    // 2026-09-24 (P5): the guided creation's successor axis, per-field reasons and the Automate fee meter's rates (DESIGN-V2 §14, R-13, R-18).
    'tests/automate-successor.test.mjs',
    // 2026-09-24: the automation page's position picker (the wallet's open positions, a link's preselection, what each option shows).
    'tests/automate-picker.test.mjs',
    // 2026-09-25: the Positions Wallet card's prices (one provider GET per view, memory only) and main holdings by value.
    'tests/wallet-holdings.test.mjs',
    // 2026-09-25: closeBrowser, which every browser suite closes Chrome with (on macOS its pipes outlive it).
    'tests/close-browser.test.mjs',
  ],
  { stdio: 'inherit' },
);
