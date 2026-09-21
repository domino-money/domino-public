import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildPublicRelease, checkPublicReleaseEquivalence } from './build-public-release.mjs';
import { PUBLIC_ALIASES, PUBLIC_CONTRACTS } from './check-contract-size.mjs';
import { COMPILER_VERSION, COMPILER_SETTINGS, RELEASE_CONTRACTS } from './release-artifact-manifest.mjs';

function fixture(t) {
  const out = mkdtempSync(join(tmpdir(), 'domino public release '));
  t.after(() => rmSync(out, { recursive: true, force: true }));
  for (const [name, base] of Object.entries(PUBLIC_ALIASES)) {
    const spec = PUBLIC_CONTRACTS.find(value => value.name === name);
    for (const target of [name, base]) {
      const folder = join(out, target + '.sol'); mkdirSync(folder);
      const abi = [{ type: 'constructor', stateMutability: 'nonpayable', inputs:
        Array.from({ length: spec.constructorAddresses }, (_, i) => ({ name: 'arg' + i, type: spec.constructorTypes?.[i] ?? 'address' })) }];
      const value = { abi, metadata: { compiler: { version: COMPILER_VERSION }, settings: {
        ...structuredClone(COMPILER_SETTINGS), compilationTarget: { ['src/' + target + '.sol']: target },
      } }, bytecode: { object: '0x' + '60'.repeat(128) }, deployedBytecode: {
        object: '0x' + '00'.repeat(96), immutableReferences: { [target === name ? '123' : '456']: [{ start: 16, length: 32 }] },
      } };
      writeFileSync(join(folder, target + '.json'), JSON.stringify(value));
    }
  }
  return out;
}

test('the seven actual release names have strict equivalent base artifacts', t => {
  assert.deepEqual(Object.keys(PUBLIC_ALIASES).sort(), Object.values(RELEASE_CONTRACTS).sort());
  assert(Object.keys(PUBLIC_ALIASES).every(name => name.endsWith('V1')));
  const matches = checkPublicReleaseEquivalence(fixture(t));
  assert.equal(matches.length, 7);
  assert(matches.every(match => match.exactIdentity));
});

test('changing creation, runtime, ABI or immutable bytes cannot masquerade as a rename', t => {
  const out = fixture(t), path = join(out, 'DominoVaultV1.sol/DominoVaultV1.json');
  const initial = JSON.parse(readFileSync(path));
  for (const change of [
    value => { value.bytecode.object = '0x61' + value.bytecode.object.slice(4); },
    value => { value.deployedBytecode.object = '0x01' + value.deployedBytecode.object.slice(4); },
    value => { value.abi[0].inputs[0].name = 'different'; },
    value => { value.deployedBytecode.immutableReferences['123'][0].start = 17; },
  ]) {
    const changed = structuredClone(initial); change(changed); writeFileSync(path, JSON.stringify(changed));
    assert.throws(() => checkPublicReleaseEquivalence(out), /public_alias_identity_mismatch_DominoVaultV1/);
  }
});

test('public build compiles all seven sources through the pinned launcher and propagates failures', () => {
  let checked = false;
  assert.equal(buildPublicRelease('pinned-forge', {
    run: (binary, args, options) => {
      assert.equal(binary, 'pinned-forge'); assert.equal(args[0], 'build');
      assert(args.includes('--offline')); assert(args.includes('--use'));
      assert.equal(args.filter(value => value.startsWith('src/') && value.endsWith('V1.sol')).length, 7);
      assert(options.cwd.endsWith('contracts')); return 7;
    }, sizes: () => { checked = true; }, log: () => {},
  }), 7);
  assert.equal(checked, false);
  assert.equal(buildPublicRelease('pinned-forge', {
    run: () => 0,
    sizes: (_out, selected) => { assert.equal(selected, PUBLIC_CONTRACTS); return { ok: false, contracts: [] }; },
    equivalents: () => { throw new Error('must not reach equivalence'); }, log: () => {},
  }), 1);
});

test('compiled public release aliases preserve exact base identity',
  { skip: process.env.DOMINO_TEST_EVM !== '1' }, () => {
    assert.equal(checkPublicReleaseEquivalence().length, 7);
  });
