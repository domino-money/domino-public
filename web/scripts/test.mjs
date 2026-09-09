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
    'lib/position.ts',
    'lib/compound.ts',
    'lib/practice.ts',
  ],
  { stdio: 'inherit' },
);
mkdirSync('.test-build', { recursive: true });
writeFileSync('.test-build/package.json', JSON.stringify({ type: 'commonjs' }));
execFileSync(process.execPath, ['--test', 'tests/domain.test.mjs'], {
  stdio: 'inherit',
});
