import { isDeepStrictEqual } from 'node:util'

// The deliberately small vocabulary of the canonical dev-status-v1 schema.
// No coercion, remote references, optional-field guessing or additional keys.
const VOCABULARY = new Set(['$schema', '$id', 'title', 'description', 'type', 'additionalProperties', 'required', 'properties', 'const', 'enum', 'minLength', 'maxLength', 'pattern', 'items', 'uniqueItems', 'maxItems', 'oneOf', 'allOf', 'if', 'then', 'else', 'minimum', 'maximum'])
export function validateStatus(schema, value, depth = 0) {
  if (!schema || typeof schema !== 'object' || depth > 24 || Object.keys(schema).some((k) => !VOCABULARY.has(k))) return false
  if ('const' in schema && !isDeepStrictEqual(value, schema.const)) return false
  if (schema.enum && !schema.enum.some((v) => isDeepStrictEqual(value, v))) return false
  if (schema.type === 'object' && (!value || typeof value !== 'object' || Array.isArray(value))) return false
  if (schema.type === 'array' && !Array.isArray(value)) return false
  if (schema.type === 'string' && typeof value !== 'string') return false
  if (schema.type === 'boolean' && typeof value !== 'boolean') return false
  if (schema.type === 'integer' && !Number.isSafeInteger(value)) return false
  if (schema.type && !['object', 'array', 'string', 'boolean', 'integer'].includes(schema.type)) return false
  if (schema.required && !schema.required.every((key) => value && Object.hasOwn(value, key))) return false
  if (schema.properties && value && typeof value === 'object' && !Array.isArray(value)) {
    if (schema.additionalProperties === false && Object.keys(value).some((key) => !Object.hasOwn(schema.properties, key))) return false
    for (const [key, child] of Object.entries(schema.properties)) if (Object.hasOwn(value, key) && !validateStatus(child, value[key], depth + 1)) return false
  }
  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) return false
    if (schema.maxLength !== undefined && value.length > schema.maxLength) return false
    if (schema.pattern) { const match = new RegExp(schema.pattern).exec(value); if (!match || match[0] !== value) return false }
  }
  if (typeof value === 'number' && ((schema.minimum !== undefined && value < schema.minimum) || (schema.maximum !== undefined && value > schema.maximum))) return false
  if (Array.isArray(value)) {
    if (schema.maxItems !== undefined && value.length > schema.maxItems) return false
    if (schema.uniqueItems && new Set(value.map((v) => JSON.stringify(v))).size !== value.length) return false
    if (schema.items && !value.every((v) => validateStatus(schema.items, v, depth + 1))) return false
  }
  if (schema.oneOf && schema.oneOf.filter((s) => validateStatus(s, value, depth + 1)).length !== 1) return false
  if (schema.allOf && !schema.allOf.every((s) => validateStatus(s, value, depth + 1))) return false
  if (schema.if) { const branch = validateStatus(schema.if, value, depth + 1) ? schema.then : schema.else; if (branch && !validateStatus(branch, value, depth + 1)) return false }
  return true
}
