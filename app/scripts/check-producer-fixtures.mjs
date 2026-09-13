/**
 * Runs every derived onboarding-v1 and deposit-v1 fixture the app serves
 * (tests/support/derived-corpus.mjs) through the Python producer model,
 * read-only: backend/onboarding_models.py and backend/deposit_models.py,
 * imported in place, plus the producer rules those models leave to the
 * services (scripts/producer_fixtures.py). Nothing is written outside
 * .test-build and no service runs.
 *
 * Not part of check:app or CI: it needs the backend's Python dependencies
 * (pydantic, eth-abi, eth-hash; backend/requirements-readonly.txt), which the
 * frontend job does not install. tests/consumer.fixtures.test.mjs holds the
 * same bodies to the same rules in node, inside check:app. Run from app/:
 *
 *   npm run check:producer-fixtures      (PYTHON=<interpreter> to choose one)
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';

// The corpus builds the lab's scenarios from the compiled modules, as the node tests do.
execFileSync(process.execPath, ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.test.json'], { stdio: 'inherit' });
execFileSync(process.execPath, ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.consumer-test.json'], { stdio: 'inherit' });
mkdirSync('.test-build', { recursive: true });
writeFileSync('.test-build/package.json', JSON.stringify({ type: 'commonjs' }));

const { OWNER_CONTROLS, depositCorpus, onboardingCorpus, onboardingPackageResponses } = await import('../tests/support/derived-corpus.mjs');
const payload = { onboarding: onboardingCorpus(), onboardingPackage: onboardingPackageResponses(), deposit: depositCorpus(), skipped: [...OWNER_CONTROLS] };
const python = process.env.PYTHON ?? (process.platform === 'win32' ? 'python' : 'python3');
const run = spawnSync(python, ['-B', 'scripts/producer_fixtures.py'], { input: JSON.stringify(payload), stdio: ['pipe', 'inherit', 'inherit'] });
if (run.error) throw run.error;
process.exitCode = run.status ?? 1;
