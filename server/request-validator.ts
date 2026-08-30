/**
 * Runtime enforcement for buf.validate request annotations emitted into the
 * generated registry. Both production edge gateways and the Vite development
 * router register this callback with sebuf's generated route factories.
 */

import {
  GENERATED_MESSAGE_RULES,
  GENERATED_REQUEST_TYPES,
} from '../src/generated/server/request_validation';

export interface RequestFieldViolation {
  field: string;
  description: string;
}

interface FieldRule {
  readonly kind: string;
  readonly repeated?: boolean;
  readonly optional?: boolean;
  readonly messageType?: string;
  readonly int64Encoding?: 'number' | 'string';
  readonly enumValues?: readonly string[];
  readonly enumDefinedOnly?: boolean;
  readonly enumNotIn?: readonly string[];
  readonly required?: boolean;
  readonly ignore?: 'IGNORE_IF_ZERO_VALUE';
  readonly stringLen?: number;
  readonly stringMinLen?: number;
  readonly stringMaxLen?: number;
  readonly stringMaxBytes?: number;
  readonly stringConst?: string;
  readonly stringPattern?: string;
  readonly numberGte?: number;
  readonly numberLte?: number;
  readonly repeatedMinItems?: number;
  readonly repeatedMaxItems?: number;
  readonly repeatedUnique?: boolean;
}

interface MessageRule {
  readonly fields: Readonly<Record<string, FieldRule>>;
}

const requestTypes: Readonly<Record<string, string>> = GENERATED_REQUEST_TYPES;
const messageRules: Readonly<Record<string, MessageRule>> = GENERATED_MESSAGE_RULES;
const patternCache = new Map<string, RegExp>();
const utf8Encoder = new TextEncoder();
const hasOwn = (value: object, key: string): boolean => Object.prototype.hasOwnProperty.call(value, key);

function exceedsUtf8ByteLimit(value: string, limit: number): boolean {
  if (value.length > limit) return true;
  for (let index = 0; index < value.length; index += 1) {
    if (value.charCodeAt(index) > 0x7f) return utf8Encoder.encode(value).byteLength > limit;
  }
  return false;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function addViolation(
  violations: RequestFieldViolation[],
  field: string,
  description: string,
): void {
  violations.push({ field, description });
}

function isRequiredValueMissing(value: unknown): boolean {
  return value == null
    || value === ''
    || (Array.isArray(value) && value.length === 0);
}

function isZeroValue(value: unknown): boolean {
  return value == null
    || value === ''
    || value === 0
    || value === false
    || (Array.isArray(value) && value.length === 0);
}

function defaultScalarValue(rule: FieldRule): unknown {
  if (rule.optional) return undefined;
  if (rule.kind === 'string') return '';
  if (rule.kind === 'double' || rule.kind === 'float') return 0;
  if (rule.kind === 'enum') return rule.enumValues?.[0];
  if (/^(?:s?fixed|s?int|uint)/.test(rule.kind)) {
    return rule.kind === 'int64' && rule.int64Encoding !== 'number' ? '0' : 0;
  }
  return undefined;
}

function validateEnum(
  rule: FieldRule,
  value: unknown,
  path: string,
  violations: RequestFieldViolation[],
): void {
  // Wire contract is enum NAMES only, deliberately narrower than canonical proto3 JSON
  // (which also permits the integer ordinal). The generated server types model these as
  // string unions and the published OpenAPI documents only the string form, so accepting
  // an integer here would pass a value the handler is not typed for. Keep the rejection
  // explicit so a proto3-JSON client gets an actionable message instead of a bare 400.
  if (typeof value !== 'string') {
    addViolation(
      violations,
      path,
      'value must be an enum name (this API does not accept the numeric proto3-JSON enum form)',
    );
    return;
  }
  // Membership is enforced whenever the generated rule carries the enum's values, not
  // only when the proto opted into `enum.defined_only`. This validator only ever sees
  // proto3 JSON, where an undeclared enum NAME is a parse error by spec, so enforcing
  // unconditionally costs conformant callers nothing and keeps the default fail-closed
  // for any future enum field whose proto forgets the annotation.
  if (rule.enumValues && !rule.enumValues.includes(value)) {
    addViolation(violations, path, 'enum value must be defined');
    return;
  }
  if (rule.enumNotIn?.includes(value)) {
    addViolation(violations, path, `enum value must not be ${value}`);
  }
}

// Adjacent bounded repeats of the SAME character class, e.g. `[A-Za-z0-9_-]{16,1000}[A-Za-z0-9_-]{0,536}`.
// The backreference forces the two class bodies to be textually identical.
const ADJACENT_CLASS_QUANTIFIERS = /(\[(?:[^\]\\]|\\.)*\])\{(\d+),(\d+)\}\1\{(\d+),(\d+)\}/;

/**
 * Collapses adjacent bounded repeats of an identical character class into one repeat.
 *
 * Proto `string.pattern` rules are authored against RE2, which is a linear-time engine
 * with NO backtracking but a hard cap of 1000 on a single repetition. Authors therefore
 * split a longer bound into two adjacent quantifiers (`{16,1000}{0,536}`) — free under
 * RE2, but ambiguous under JavaScript's backtracking RegExp, where a non-matching input
 * is driven through ~(b-a)x(d-c) split combinations. Measured on the Company Monitoring
 * cursor pattern: 21ms/op at 800 chars and 30-337ms/op at 2KB, versus ~0.01ms collapsed.
 *
 * For any set S, `S{a,b}S{c,d}` accepts exactly `S{a+c,b+d}`, so this rewrite preserves
 * the language while removing the ambiguity. It runs once per distinct pattern at
 * compile time, and the result is what gets cached.
 */
export function collapseAdjacentClassQuantifiers(source: string): string {
  let out = source;
  // Loop so a 3+ term run collapses fully; each pass removes one adjacency.
  for (let guard = 0; guard < 16; guard += 1) {
    const next = out.replace(
      ADJACENT_CLASS_QUANTIFIERS,
      (_match, cls: string, a: string, b: string, c: string, d: string) =>
        `${cls}{${Number(a) + Number(c)},${Number(b) + Number(d)}}`,
    );
    if (next === out) break;
    out = next;
  }
  return out;
}

function compilePattern(source: string): RegExp {
  let pattern = patternCache.get(source);
  if (!pattern) {
    pattern = new RegExp(collapseAdjacentClassQuantifiers(source));
    patternCache.set(source, pattern);
  }
  return pattern;
}

function validateString(
  rule: FieldRule,
  value: unknown,
  path: string,
  violations: RequestFieldViolation[],
): void {
  if (typeof value !== 'string') {
    addViolation(violations, path, 'value must be a string');
    return;
  }

  const length = [...value].length;
  let oversized = false;
  if (rule.stringLen != null && length !== rule.stringLen) {
    addViolation(violations, path, `string length must be exactly ${rule.stringLen}`);
    if (length > rule.stringLen) oversized = true;
  }
  if (rule.stringMinLen != null && length < rule.stringMinLen) {
    addViolation(violations, path, `string length must be at least ${rule.stringMinLen}`);
  }
  if (rule.stringMaxLen != null && length > rule.stringMaxLen) {
    addViolation(violations, path, `string length must be at most ${rule.stringMaxLen}`);
    oversized = true;
  }
  if (rule.stringMaxBytes != null && exceedsUtf8ByteLimit(value, rule.stringMaxBytes)) {
    addViolation(violations, path, `string UTF-8 length must be at most ${rule.stringMaxBytes} bytes`);
    oversized = true;
  }
  if (rule.stringConst != null && value !== rule.stringConst) {
    addViolation(violations, path, `string must equal ${rule.stringConst}`);
  }
  // Skip the pattern once the value is already known to be over a declared length or
  // byte bound. The request is rejected either way, and running a regex over unbounded
  // attacker-controlled input is the expensive part — the declared max_bytes must
  // actually bound the matching work, not just the payload.
  if (rule.stringPattern != null && !oversized) {
    if (!compilePattern(rule.stringPattern).test(value)) {
      addViolation(violations, path, `string must match pattern ${rule.stringPattern}`);
    }
  }
}

function validateNumber(
  rule: FieldRule,
  value: unknown,
  path: string,
  violations: RequestFieldViolation[],
): void {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    addViolation(violations, path, 'value must be a finite number');
    return;
  }
  if (rule.kind !== 'double' && rule.kind !== 'float' && !Number.isInteger(value)) {
    addViolation(violations, path, 'value must be an integer');
    return;
  }
  if (rule.numberGte != null && value < rule.numberGte) {
    addViolation(violations, path, `number must be greater than or equal to ${rule.numberGte}`);
  }
  if (rule.numberLte != null && value > rule.numberLte) {
    addViolation(violations, path, `number must be less than or equal to ${rule.numberLte}`);
  }
}

function validateStringEncodedInt64(
  rule: FieldRule,
  value: unknown,
  path: string,
  violations: RequestFieldViolation[],
): void {
  if (typeof value !== 'string' || !/^-?\d+$/.test(value)) {
    addViolation(violations, path, 'value must be a base-10 integer string');
    return;
  }
  const integer = BigInt(value);
  if (rule.numberGte != null && integer < BigInt(rule.numberGte)) {
    addViolation(violations, path, `number must be greater than or equal to ${rule.numberGte}`);
  }
  if (rule.numberLte != null && integer > BigInt(rule.numberLte)) {
    addViolation(violations, path, `number must be less than or equal to ${rule.numberLte}`);
  }
}

function validateSingleValue(
  rule: FieldRule,
  value: unknown,
  path: string,
  violations: RequestFieldViolation[],
  ancestors: Set<object>,
): void {
  if (rule.kind === 'message') {
    if (!isRecord(value)) {
      addViolation(violations, path, 'value must be an object');
      return;
    }
    if (!rule.messageType) {
      throw new Error(`Generated request-validation rule for ${path} is missing its message type.`);
    }
    validateMessage(rule.messageType, value, path, violations, ancestors);
    return;
  }
  if (rule.kind === 'string') {
    validateString(rule, value, path, violations);
    return;
  }
  if (rule.kind === 'enum') {
    validateEnum(rule, value, path, violations);
    return;
  }
  if (rule.kind === 'int64' && rule.int64Encoding !== 'number') {
    validateStringEncodedInt64(rule, value, path, violations);
    return;
  }
  validateNumber(rule, value, path, violations);
}

function validateField(
  rule: FieldRule,
  value: unknown,
  present: boolean,
  path: string,
  violations: RequestFieldViolation[],
  ancestors: Set<object>,
): void {
  if (rule.ignore === 'IGNORE_IF_ZERO_VALUE' && (!present || isZeroValue(value))) {
    return;
  }
  const enumZeroValue = rule.kind === 'enum' && value === rule.enumValues?.[0];
  if (rule.required && (isRequiredValueMissing(value) || enumZeroValue)) {
    addViolation(violations, path, 'value is required');
    return;
  }

  if (rule.repeated) {
    const repeatedValue = present ? value : [];
    if (!Array.isArray(repeatedValue)) {
      addViolation(violations, path, 'value must be an array');
      return;
    }
    if (rule.repeatedMinItems != null && repeatedValue.length < rule.repeatedMinItems) {
      addViolation(violations, path, `array must contain at least ${rule.repeatedMinItems} item(s)`);
    }
    if (rule.repeatedMaxItems != null && repeatedValue.length > rule.repeatedMaxItems) {
      addViolation(violations, path, `array must contain at most ${rule.repeatedMaxItems} item(s)`);
    }
    if (rule.repeatedUnique && new Set(repeatedValue.map((item) => JSON.stringify(item))).size !== repeatedValue.length) {
      addViolation(violations, path, 'array items must be unique');
    }
    repeatedValue.forEach((item, index) => {
      validateSingleValue(rule, item, `${path}[${index}]`, violations, ancestors);
    });
    return;
  }

  if (!present) {
    if (rule.kind === 'message' || rule.optional) return;
    value = defaultScalarValue(rule);
  }
  if (value === undefined) return;
  validateSingleValue(rule, value, path, violations, ancestors);
}

function validateMessage(
  typeName: string,
  body: Record<string, unknown>,
  parentPath: string,
  violations: RequestFieldViolation[],
  ancestors: Set<object>,
): void {
  const schema = messageRules[typeName];
  if (!schema) {
    throw new Error(`No generated message-validation schema for ${typeName}.`);
  }
  if (ancestors.has(body)) {
    addViolation(violations, parentPath || '$request', 'value must not contain circular references');
    return;
  }

  ancestors.add(body);
  for (const [fieldName, rule] of Object.entries(schema.fields)) {
    const path = parentPath ? `${parentPath}.${fieldName}` : fieldName;
    validateField(rule, body[fieldName], hasOwn(body, fieldName), path, violations, ancestors);
  }
  ancestors.delete(body);
}

export function validateGeneratedRequest(
  methodName: string,
  body: unknown,
): RequestFieldViolation[] | undefined {
  const requestType = requestTypes[methodName];
  if (!hasOwn(requestTypes, methodName) || typeof requestType !== 'string') {
    throw new Error(`No generated request-validation schema for RPC method ${methodName}.`);
  }
  if (!isRecord(body)) {
    return [{ field: '$request', description: 'value must be an object' }];
  }

  const violations: RequestFieldViolation[] = [];
  validateMessage(requestType, body, '', violations, new Set());
  return violations.length > 0 ? violations : undefined;
}
