import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { validateRequest } from '../../api-contracts/read-v1/runtime.mjs';

const openapi = JSON.parse(readFileSync(new URL('../../backend/openapi-read.json', import.meta.url), 'utf8'));
const schema = openapi.components.schemas.NftPositionsRequest.properties.tokenIds;
const pattern = new RegExp(schema.items.pattern, 'u'); // ECMA-262, no multiline flag.
const maximum = (2n ** 256n - 1n).toString();

test('exported NFT description has canonical unique string IDs and finite array bounds', () => {
  assert.equal(schema.type, 'array');
  assert.equal(schema.items.type, 'string');
  assert.equal(schema.uniqueItems, true);
  assert.equal(schema.minItems, 1);
  assert.equal(schema.maxItems, 10);
  assert.equal(schema.items.maxLength, 78);
  // Inspect the exported keyword above; acceptance still belongs to the
  // existing runtime. This test does not implement a JSON Schema validator.
  for (const [ids, expected] of [
    [['0', maximum], true], [Array.from({ length: 10 }, (_, i) => String(i)), true],
    [['0', '0'], false], [[maximum, maximum], false], [['1', '2', '1'], false],
    [[], false], [Array.from({ length: 11 }, (_, i) => String(i)), false],
    [null, false], ['0', false], [[0], false], [[true], false], [[null], false],
  ]) assert.equal(validateRequest('nft-positions', { tokenIds: ids }), expected, JSON.stringify(ids));
});

test('the exported uint256 pattern runs directly in ECMAScript without a fullmatch shim', () => {
  const cases = [
    ['0', true], ['1', true], [maximum, true],
    [(2n ** 256n).toString(), false], ['9'.repeat(78), false], ['1'.repeat(79), false],
    ...['', '00', '01', '-1', '+1', '1.0', '1e1', ' 1', '1 ', '0\n', '1\r\n',
        '1\r', '1\u2028', '1\u2029', '\n1', '１', '١', '𝟙'].map(value => [value, false]),
  ];
  for (const [value, expected] of cases) {
    assert.equal(pattern.test(value), expected, `ECMAScript pattern: ${JSON.stringify(value)}`);
    assert.equal(validateRequest('nft-positions', { tokenIds: [value] }), expected, `read-v1: ${JSON.stringify(value)}`);
  }
});

test('ECMAScript without multiline already rejects the final newline at dollar', () => {
  assert.equal(pattern.multiline, false);
  assert.equal(new RegExp('^0$', 'u').test('0\n'), false);
  assert.equal(new RegExp('^0$', 'mu').test('0\n'), true);
  assert.equal(pattern.test('0\n'), false);
});
