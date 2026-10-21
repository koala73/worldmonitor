import { RpcValidationError } from './billing-denial';
import { JMESPATH_SCHEMA } from './jmespath';
import { SUMMARY_SCHEMA } from './registry';
import { z } from 'zod';
import type { ToolDef } from './types';

// Validation keywords used by the registry. Descriptions, defaults and non-UUID format
// annotations do not change arguments or impose additional caller constraints.
type Schema = {
  type?: string | string[];
  properties?: Record<string, Schema>;
  required?: string[];
  items?: Schema;
  enum?: unknown[];
  const?: unknown;
  minimum?: number;
  maximum?: number;
  exclusiveMinimum?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  format?: string;
  minItems?: number;
  maxItems?: number;
  uniqueItems?: boolean;
  additionalProperties?: boolean | Schema;
  oneOf?: Schema[];
};
type Violation = { field: string; description: string };
const UUID_SCHEMA = z.string().uuid();

function matchesType(type: string, value: unknown): boolean {
  switch (type) {
    case 'null': return value === null;
    case 'array': return Array.isArray(value);
    case 'object': return value !== null && typeof value === 'object' && !Array.isArray(value);
    case 'integer': return Number.isSafeInteger(value);
    case 'number': return typeof value === 'number' && Number.isFinite(value);
    default: return typeof value === type;
  }
}

function violationsFor(schema: Schema, value: unknown, field = ''): Violation[] {
  const violations: Violation[] = [];
  const reject = (description: string, path = field) => {
    if (violations.length < 8) violations.push({ field: path.slice(0, 100) || 'arguments', description });
  };
  if (schema.type && ![schema.type].flat().some(type => matchesType(type, value))) {
    reject(`Expected ${[schema.type].flat().join(' or ')}.`);
    return violations;
  }
  if (schema.enum && !schema.enum.includes(value)) reject(`Use one of: ${schema.enum.join(', ')}.`.slice(0, 200));
  if (Object.prototype.hasOwnProperty.call(schema, 'const') && value !== schema.const) reject('Value must match the declared constant.');
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) reject(`Must be at least ${schema.minimum}.`);
    if (schema.maximum !== undefined && value > schema.maximum) reject(`Must be at most ${schema.maximum}.`);
    if (schema.exclusiveMinimum !== undefined && value <= schema.exclusiveMinimum) reject(`Must be greater than ${schema.exclusiveMinimum}.`);
  }
  if (typeof value === 'string') {
    const length = [...value].length;
    if (schema.minLength !== undefined && length < schema.minLength) reject(`Must contain at least ${schema.minLength} characters.`);
    if (schema.maxLength !== undefined && length > schema.maxLength) reject(`Must contain at most ${schema.maxLength} characters.`);
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) reject('Must match the declared pattern.');
    if (schema.format === 'uuid' && !UUID_SCHEMA.safeParse(value).success) reject('Must be a valid UUID.');
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) reject(`Must contain at least ${schema.minItems} items.`);
    if (schema.maxItems !== undefined && value.length > schema.maxItems) reject(`Must contain at most ${schema.maxItems} items.`);
    if (schema.uniqueItems && new Set(value.map(item => JSON.stringify(item))).size !== value.length) reject('Items must be unique.');
    if (schema.items) {
      for (let i = 0; i < value.length && violations.length < 8; i++) {
        violations.push(...violationsFor(schema.items, value[i], `${field}.${i}`).slice(0, 8 - violations.length));
      }
    }
  } else if (value !== null && typeof value === 'object') {
    const object = value as Record<string, unknown>;
    const pathFor = (key: string) => field ? `${field}.${key}` : key;
    for (const key of schema.required ?? []) {
      if (!Object.prototype.hasOwnProperty.call(object, key)) reject('Required argument is missing.', pathFor(key));
    }
    for (const [key, item] of Object.entries(object)) {
      if (violations.length >= 8) break;
      const property = Object.prototype.hasOwnProperty.call(schema.properties ?? {}, key) ? schema.properties![key] : undefined;
      if (property) violations.push(...violationsFor(property, item, pathFor(key)).slice(0, 8 - violations.length));
      else if (schema.additionalProperties === false) reject('Unknown argument.', pathFor(key));
      else if (typeof schema.additionalProperties === 'object') {
        violations.push(...violationsFor(schema.additionalProperties, item, pathFor(key)).slice(0, 8 - violations.length));
      }
    }
  }
  if (schema.oneOf && schema.oneOf.filter(branch => violationsFor(branch, value, field).length === 0).length !== 1) {
    reject('Arguments must match exactly one supported selection.');
  }
  return violations;
}

export function validateToolArgs(tool: ToolDef, args: unknown): asserts args is Record<string, unknown> {
  const violations = violationsFor({
    ...tool.inputSchema,
    properties: {
      ...tool.inputSchema.properties,
      jmespath: JMESPATH_SCHEMA,
      ...(tool._execute === undefined ? { summary: SUMMARY_SCHEMA } : {}),
    },
  } as Schema, args);
  if (violations.length) throw new RpcValidationError(tool.name, violations);
  tool._validateArgs?.(Object.fromEntries(Object.entries(args as Record<string, unknown>).filter(([key]) => key !== 'panel_request')));
}
