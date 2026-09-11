import assert from 'node:assert/strict';
import { test } from 'node:test';
import { JsonNumber, parseStrictJson } from '../src/strict-json.mjs';

test('strict parser preserves JSON types and safely handles prototype names', () => {
  const parsed = parseStrictJson('{"__proto__":{"safe":true},"a":[null,false,0,"text\\\"quoted"]}');
  assert.equal(Object.getPrototypeOf(parsed), null);
  assert.equal(parsed.__proto__.safe, true);
  assert.deepEqual(parsed.a, [null, false, 0, 'text"quoted']);
  assert.equal({}.safe, undefined);
});

test('number lexemes avoid loss of precision and preserve integer syntax', () => {
  const parsed = parseStrictJson('[9223372036854775807,1.0,1e2,-0]', { numberLexemes: true });
  assert.equal(parsed.every((item) => item instanceof JsonNumber), true);
  assert.deepEqual(parsed.map((item) => item.source), ['9223372036854775807', '1.0', '1e2', '-0']);
});

for (const text of [
  '{"a":{"x":1,"x":2}}', '{"a":1,"\\u0061":2}', '{"a":1,}', '[1,]', '[01]', '[+1]', '[.1]',
  '{"a" 1}', '{a:1}', 'undefined', 'NaN', 'Infinity', '1e400', 'true false', '"bad\nstring"',
  '"bad\\xescape"', '"unterminated', `${'['.repeat(66)}0${']'.repeat(66)}`,
]) test(`strict parser rejects ${text.slice(0, 40)}`, () => assert.throws(() => parseStrictJson(text), SyntaxError));
