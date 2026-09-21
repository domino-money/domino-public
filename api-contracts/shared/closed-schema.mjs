// Closed JSON/schema validation shared by the financial API contracts.
// State-specific checks remain with each contract and are bound per instance.
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value) &&
  [Object.prototype, null].includes(Object.getPrototypeOf(value));
const denseArray = (value) => Array.isArray(value) && Reflect.ownKeys(value).length === value.length + 1 &&
  Object.keys(value).length === value.length && Object.keys(value).every((key, index) => key === String(index) &&
    Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), 'value'));
const equalConstant = (value, expected) => Array.isArray(expected)
  ? Array.isArray(value) && value.length === expected.length && denseArray(value) &&
    value.every((item, index) => equalConstant(item, expected[index]))
  : value === expected;

export function createContractValidators(schemas, errorStatusByCode, semantic) {
  function validate(schema, value, root, depth = 0) {
    if (!schema || depth > 32) return false;
    if (schema.$ref) {
      const name = schema.$ref.split('/').at(-1);
      return validate(root.$defs[name], value, root, depth + 1) && semantic(name, value);
    }
    if (schema.oneOf) return schema.oneOf.filter((option) => validate(option, value, root, depth + 1)).length === 1;
    if (schema.anyOf) return schema.anyOf.some((option) => validate(option, value, root, depth + 1));
    if (Object.hasOwn(schema, 'const') && !equalConstant(value, schema.const)) return false;
    if (schema.enum && !schema.enum.includes(value)) return false;
    if (schema.type === 'null') return value === null;
    if (schema.type === 'boolean') return typeof value === 'boolean';
    if (schema.type === 'integer') return Number.isSafeInteger(value) && !Object.is(value, -0) &&
      (schema.minimum === undefined || value >= schema.minimum) && (schema.maximum === undefined || value <= schema.maximum);
    if (schema.type === 'string') {
      if (typeof value !== 'string' || (schema.minLength !== undefined && value.length < schema.minLength) ||
          (schema.maxLength !== undefined && value.length > schema.maxLength)) return false;
      if (schema.pattern) {
        const match = value.match(new RegExp(schema.pattern, 'u'));
        if (!match || match[0] !== value) return false;
      }
      if (schema['x-maximum-raw'] && BigInt(value) > BigInt(schema['x-maximum-raw'])) return false;
      return true;
    }
    if (schema.type === 'array') return Array.isArray(value) &&
      (schema.minItems === undefined || value.length >= schema.minItems) &&
      (schema.maxItems === undefined || value.length <= schema.maxItems) &&
      denseArray(value) &&
      value.every((item) => validate(schema.items, item, root, depth + 1)) &&
      (!schema.uniqueItems || new Set(value.map((item) => JSON.stringify(item))).size === value.length);
    if (schema.type === 'object') {
      if (!object(value)) return false;
      const keys = Reflect.ownKeys(value), properties = schema.properties;
      return keys.every((key) => typeof key === 'string' && Object.hasOwn(properties, key) &&
        Object.getOwnPropertyDescriptor(value, key).enumerable && Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), 'value')) &&
        (schema.required || []).every((key) => Object.hasOwn(value, key)) &&
        keys.every((key) => validate(properties[key], value[key], root, depth + 1));
    }
    return false;
  }

  function check(route, kind, value) {
    try {
      if (!Object.hasOwn(schemas, route)) return false;
      const schema = schemas[route][kind];
      return validate(schema, value, schema) && semantic(schema.title, value);
    } catch { return false; }
  }

  return {
    validateRequest: (route, value) => check(route, 'request', value),
    validateResponse: (route, value) => check(route, 'response', value),
    validateError(status, value) {
      try {
        return Number.isSafeInteger(status) && object(value) && Reflect.ownKeys(value).length === 1 &&
          Object.hasOwn(value, 'error') && Object.hasOwn(Object.getOwnPropertyDescriptor(value, 'error'), 'value') &&
          Object.getOwnPropertyDescriptor(value, 'error').enumerable &&
          typeof value.error === 'string' && Object.hasOwn(errorStatusByCode, value.error) && errorStatusByCode[value.error] === status;
      } catch { return false; }
    }
  };
}
