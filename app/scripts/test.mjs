// Compiles the pure modules the tests exercise, then runs them under node --test.
// Mirrors web/scripts/test.mjs so both halves of the repository are checked the
// same way. The engine files come from web/lib because the money maths is not
// ours to copy; we compile the same sources the application imports.
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';

execFileSync(
  process.execPath,
  [
    'node_modules/typescript/bin/tsc',
    '--outDir',
    '.test-build',
    '--target',
    'ES2022',
    '--module',
    'commonjs',
    '--moduleResolution',
    'node',
    '--esModuleInterop',
    '--skipLibCheck',
    '--strict',
    'src/lib/pair.ts',
    'src/lib/geometry.ts',
    'src/lib/format.ts',
    'src/lib/markets.ts',
    '../web/lib/compound.ts',
    '../web/lib/position.ts',
    'functions/_lib/gate.ts',
    'functions/_middleware.ts',
  ],
  { stdio: 'inherit' },
);

mkdirSync('.test-build', { recursive: true });
writeFileSync('.test-build/package.json', JSON.stringify({ type: 'commonjs' }));

execFileSync(process.execPath, ['--test', 'tests/domain.test.mjs', 'tests/gate.test.mjs'], { stdio: 'inherit' });
