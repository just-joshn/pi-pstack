/** Minimal JSON Schema subset validator (draft 2020-12 keywords used by compat schemas). */

function resolveRef(root, ref) {
  if (!ref.startsWith("#/$defs/")) throw new Error(`unsupported $ref: ${ref}`);
  return root.$defs[ref.slice("#/$defs/".length)];
}

function matchesSingle(type, value) {
  if (type === "array") return Array.isArray(value);
  if (type === "object") return value !== null && typeof value === "object" && !Array.isArray(value);
  if (type === "integer") return Number.isInteger(value);
  if (type === "null") return value === null;
  return typeof value === type;
}

function typeErrors(type, value, path) {
  if (type === undefined) return [];
  const types = Array.isArray(type) ? type : [type];
  return types.some((entry) => matchesSingle(entry, value)) ? [] : [`${path}: expected type ${types.join("|")}`];
}

function scalarErrors(schema, value, path) {
  const constError = schema.const !== undefined && value !== schema.const ? [`${path}: expected ${JSON.stringify(schema.const)}`] : [];
  const enumError = schema.enum && !schema.enum.includes(value) ? [`${path}: ${JSON.stringify(value)} not in ${schema.enum.join("|")}`] : [];
  const minError = typeof value === "string" && schema.minLength !== undefined && value.length < schema.minLength ? [`${path}: shorter than ${schema.minLength}`] : [];
  return [...constError, ...enumError, ...minError];
}

function objectErrors(schema, value, path, root) {
  const props = schema.properties ?? {};
  const missing = (schema.required ?? []).filter((key) => !(key in value)).map((key) => `${path}: missing ${key}`);
  const extra = schema.additionalProperties === false ? Object.keys(value).filter((key) => !(key in props)).map((key) => `${path}: unknown property ${key}`) : [];
  const nested = Object.entries(props).flatMap(([key, sub]) => (key in value ? validateNode(sub, value[key], `${path}.${key}`, root) : []));
  return [...missing, ...extra, ...nested];
}

function arrayErrors(schema, value, path, root) {
  if (!schema.items) return [];
  return value.flatMap((item, index) => validateNode(schema.items, item, `${path}[${index}]`, root));
}

export function validateNode(schema, value, path = "$", root = schema) {
  const active = schema.$ref ? resolveRef(root, schema.$ref) : schema;
  const typeError = typeErrors(active.type, value, path);
  if (typeError.length > 0) return typeError;
  const scalar = scalarErrors(active, value, path);
  const object = active.type === "object" ? objectErrors(active, value, path, root) : [];
  const array = active.type === "array" ? arrayErrors(active, value, path, root) : [];
  return [...scalar, ...object, ...array];
}
