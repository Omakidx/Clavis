import { z } from 'zod';

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function makeNullable(prop: unknown): unknown {
  if (!isObject(prop)) return prop;
  const type = prop['type'];
  if (typeof type === 'string') return { ...prop, type: [type, 'null'] };
  if (Array.isArray(type))
    return type.includes('null') ? prop : { ...prop, type: [...type, 'null'] };
  return { anyOf: [prop, { type: 'null' }] };
}

function strictify(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(strictify);
  if (!isObject(node)) return node;
  const out: JsonObject = {};
  for (const [key, value] of Object.entries(node)) {
    // `properties` maps names to schemas, so recurse into its values, not its keys.
    if (key === 'properties' && isObject(value)) {
      out[key] = Object.fromEntries(Object.entries(value).map(([k, v]) => [k, strictify(v)]));
    } else {
      out[key] = strictify(value);
    }
  }
  if (isObject(out['properties'])) {
    const properties = out['properties'];
    const required = new Set(Array.isArray(out['required']) ? (out['required'] as string[]) : []);
    for (const name of Object.keys(properties)) {
      if (!required.has(name)) properties[name] = makeNullable(properties[name]);
    }
    out['required'] = Object.keys(properties);
    out['additionalProperties'] = false;
  }
  return out;
}

/**
 * Derive a Groq strict-mode JSON schema from a Zod output schema without editing the
 * contract: every property is required, every object is closed, and fields that are
 * optional in Zod become nullable (`["string","null"]`). The model then returns `null`
 * for "absent"; `dropNulls` removes those before Zod validation.
 */
export function toStrictJsonSchema(schema: z.ZodType): JsonObject {
  const raw = z.toJSONSchema(schema) as JsonObject;
  const { $schema: _ignored, ...rest } = raw;
  return strictify(rest) as JsonObject;
}

/** Recursively remove `null` object members so Zod `.optional()` fields accept "absent". */
export function dropNulls(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(dropNulls);
  if (!isObject(value)) return value;
  const out: JsonObject = {};
  for (const [key, member] of Object.entries(value)) {
    if (member !== null) out[key] = dropNulls(member);
  }
  return out;
}
