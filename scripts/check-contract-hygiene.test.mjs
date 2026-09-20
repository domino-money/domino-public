import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PRAGMA, formatHygiene, importedNames, inspectSource } from './check-contract-hygiene.mjs';

const CLEAN = `// SPDX-License-Identifier: MIT
${PRAGMA}

import {DominoVaultTypes as T, IERC20E2} from "./DominoVaultTypes.sol";
import {PolicyValidation} from "./PolicyValidation.sol";

contract Example {
    T.PoolKey private key;
    function f(IERC20E2 token) external view returns (bool) { return PolicyValidation.ok(token); }
}
`;

test('a clean source has no findings', () => {
  assert.deepEqual(inspectSource(CLEAN), []);
  assert.equal(formatHygiene({ ok: true, report: [] }), 'Contract hygiene: clean.');
});

test('every rule fires on its own defect and names it', () => {
  assert.deepEqual(inspectSource(CLEAN.replace('// SPDX-License-Identifier: MIT\n', '')), ['missing_spdx']);
  assert.deepEqual(inspectSource(CLEAN.replace(PRAGMA, 'pragma solidity ^0.8.26;')), ['wrong_pragma']);
  assert.deepEqual(inspectSource(CLEAN.replace('contract Example {', 'contract Example { // TODO tighten')), ['leftover_marker:7']);
  assert.deepEqual(inspectSource(CLEAN.replace('PolicyValidation.ok(token)', 'true')), ['unused_import:PolicyValidation']);
  // An aliased import is judged by the alias it is used under.
  assert.deepEqual(inspectSource(CLEAN.replace('T.PoolKey private key;', 'uint256 private key;')), ['unused_import:T']);
  const dev = CLEAN.replace('import {PolicyValidation}', 'import {console} from "forge-std/console.sol";\nimport {PolicyValidation}');
  assert.deepEqual(inspectSource(dev), ['development_import', 'unused_import:console']);
  assert.deepEqual(inspectSource(dev.replace('return PolicyValidation.ok(token);', 'console.log(1); return PolicyValidation.ok(token);'), { shipped: false }), []);
});

test('a name another file imports from this one is a re-export, not an unused import', () => {
  const fixture = { file: 'contracts/test/Fixture.sol', text: CLEAN.replace('PolicyValidation.ok(token)', 'true') };
  const user = { file: 'contracts/test/setup/User.t.sol', text: `// SPDX-License-Identifier: MIT\n${PRAGMA}\nimport {PolicyValidation as PV} from "../Fixture.sol";\ncontract U { function f() external pure returns (bool) { return PV.ok(); } }\n` };
  const reexports = importedNames([fixture, user]);
  assert.deepEqual([...reexports.get('contracts/test/Fixture.sol')], ['PolicyValidation']);
  assert.deepEqual(inspectSource(fixture.text), ['unused_import:PolicyValidation']);
  assert.deepEqual(inspectSource(fixture.text, { reexported: reexports.get('contracts/test/Fixture.sol') }), []);
});

test('the report names each file and finding', () => {
  const text = formatHygiene({ ok: false, report: [{ file: 'contracts/src/X.sol', findings: ['wrong_pragma', 'unused_import:Y'] }] });
  assert.equal(text, 'contracts/src/X.sol: wrong_pragma, unused_import:Y\nContract hygiene: 1 file(s) with findings.');
});
