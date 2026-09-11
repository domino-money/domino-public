// JSON.parse selects the last duplicate key and rounds large integers. This
// bounded parser rejects duplicate keys (including escaped spellings), rejects
// non-finite numbers, and can retain request number lexemes for exact validation.
export class JsonNumber {
  constructor(source) { this.source = source; }
}

export function parseStrictJson(text, { numberLexemes = false } = {}) {
  let offset = 0;
  let nodes = 0;
  const invalid = () => { throw new SyntaxError('invalid_json'); };
  const whitespace = () => { while (/[\x20\x09\x0a\x0d]/.test(text[offset] ?? '\0')) offset++; };
  const string = () => {
    const start = offset++;
    while (offset < text.length) {
      const character = text[offset++];
      if (character === '"') {
        try { return JSON.parse(text.slice(start, offset)); } catch { invalid(); }
      }
      if (character === '\\') offset++;
    }
    invalid();
  };
  const value = (depth) => {
    if (depth > 64 || ++nodes > 100_000) invalid();
    whitespace();
    const character = text[offset];
    if (character === '"') return string();
    if (character === '{') {
      offset++;
      const object = Object.create(null);
      const keys = new Set();
      whitespace();
      if (text[offset] === '}') { offset++; return object; }
      while (offset < text.length) {
        whitespace();
        if (text[offset] !== '"') invalid();
        const key = string();
        if (keys.has(key)) invalid();
        keys.add(key);
        whitespace();
        if (text[offset++] !== ':') invalid();
        object[key] = value(depth + 1);
        whitespace();
        const delimiter = text[offset++];
        if (delimiter === '}') return object;
        if (delimiter !== ',') invalid();
      }
      invalid();
    }
    if (character === '[') {
      offset++;
      const array = [];
      whitespace();
      if (text[offset] === ']') { offset++; return array; }
      while (offset < text.length) {
        array.push(value(depth + 1));
        whitespace();
        const delimiter = text[offset++];
        if (delimiter === ']') return array;
        if (delimiter !== ',') invalid();
      }
      invalid();
    }
    for (const [literal, result] of [['true', true], ['false', false], ['null', null]]) {
      if (text.startsWith(literal, offset)) { offset += literal.length; return result; }
    }
    const match = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/.exec(text.slice(offset));
    if (!match || !Number.isFinite(Number(match[0]))) invalid();
    offset += match[0].length;
    return numberLexemes ? new JsonNumber(match[0]) : Number(match[0]);
  };
  const result = value(0);
  whitespace();
  if (offset !== text.length) invalid();
  return result;
}
