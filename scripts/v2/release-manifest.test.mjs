import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { differences, forgeMismatches } from './release-manifest.mjs';

const identity = { creationSha256: 'aa', runtimeSha256: 'bb', creationBytes: 2, runtimeBytes: 1, abiSha256: 'cc', immutableRanges: [] };
const manifest = () => ({
  schemaVersion: 1, kind: 'domino-v2-reviewed-release-artifacts', sourceTreeSha256: '11',
  sources: { 'src/v2/A.sol': '01', 'src/v2/B.sol': '02' }, releaseInputs: { 'scripts/v2/deploy.mjs': '03' },
  contracts: { A: { source: 'src/v2/A.sol', ...identity } },
});

test('differences names each changed source, input and contract field', () => {
  assert.deepEqual(differences(manifest(), manifest()), []);
  const after = manifest();
  after.sourceTreeSha256 = '12';
  after.sources['src/v2/B.sol'] = '22'; delete after.sources['src/v2/A.sol']; after.sources['src/v2/C.sol'] = '04';
  after.releaseInputs['scripts/v2/deploy.mjs'] = '33';
  after.contracts.A.runtimeSha256 = 'b0'; after.contracts.A.immutableRanges = [{ start: 0, length: 32 }];
  after.contracts.B = { source: 'src/v2/B.sol', ...identity };
  assert.deepEqual(differences(manifest(), after), [
    'sourceTreeSha256 changed',
    'sources: src/v2/A.sol removed', 'sources: src/v2/B.sol changed', 'sources: src/v2/C.sol added',
    'releaseInputs: scripts/v2/deploy.mjs changed',
    'contracts: A runtimeSha256, immutableRanges', 'contracts: B source, creationSha256, runtimeSha256, creationBytes, runtimeBytes, abiSha256, immutableRanges',
  ]);
});

test('a Foundry artifact must be the pinned contract', () => {
  const directory = mkdtempSync(join(tmpdir(), 'domino-v2-forge-out-'));
  try {
    const pinned = { contracts: { A: { source: 'src/v2/x/A.sol', creationSha256: '', runtimeSha256: '', creationBytes: 2, runtimeBytes: 1,
      abiSha256: '', immutableRanges: [] } } };
    assert.match(forgeMismatches(pinned, directory)[0], /^A: no Foundry artifact at /);
    mkdirSync(join(directory, 'A.sol'));
    writeFileSync(join(directory, 'A.sol', 'A.json'), JSON.stringify({ abi: [], bytecode: { object: '0x6000', linkReferences: {} },
      deployedBytecode: { object: '0x00', linkReferences: {}, immutableReferences: {} } }));
    assert.deepEqual(forgeMismatches(pinned, directory), ['A: Foundry artifact differs in creationSha256, runtimeSha256, abiSha256']);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
