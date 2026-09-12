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

mkdirSync('.test-build', { recursive: true });
writeFileSync('.test-build/package.json', JSON.stringify({ type: 'commonjs' }));

execFileSync(
  process.execPath,
  [
    '--test',
    'tests/domain.test.mjs',
    'tests/gate.test.mjs',
    'tests/read.test.mjs',
    'tests/contract-pin.test.mjs',
    'tests/backend-contract.test.mjs',
    'tests/build-guard.test.mjs',
    'tests/forwarder.test.mjs',
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
    'tests/local-live-boundary.test.mjs',
    'tests/local-live-build.test.mjs',
    'tests/local-live-proxy.test.mjs',
    'tests/local-live-credentials.test.mjs',
    'tests/local-live-vite.test.mjs',
  ],
  { stdio: 'inherit' },
);
