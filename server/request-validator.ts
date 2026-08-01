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
  readonly required?: boolean;
  readonly ignore?: 'IGNORE_IF_ZERO_VALUE';
  readonly stringLen?: number;
  readonly stringMinLen?: number;
  readonly stringMaxLen?: number;
  readonly stringPattern?: string;
  readonly numberGte?: number;
  readonly numberLte?: number;
  readonly repeatedMinItems?: number;
  readonly repeatedMaxItems?: number;
}

interface MessageRule {
  readonly fields: Readonly<Record<string, FieldRule>>;
}

const requestTypes: Readonly<Record<string, string>> = GENERATED_REQUEST_TYPES;
const messageRules: Readonly<Record<string, MessageRule>> = GENERATED_MESSAGE_RULES;
const patternCache = new Map<string, RegExp>();
const hasOwn = (value: object, key: string): boolean => Object.prototype.hasOwnProperty.call(value, key);

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
  if (/^(?:s?fixed|s?int|uint)/.test(rule.kind)) {
    return rule.kind === 'int64' && rule.int64Encoding !== 'number' ? '0' : 0;
  }
  return undefined;
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
  if (rule.stringLen != null && length !== rule.stringLen) {
    addViolation(violations, path, `string length must be exactly ${rule.stringLen}`);
  }
  if (rule.stringMinLen != null && length < rule.stringMinLen) {
    addViolation(violations, path, `string length must be at least ${rule.stringMinLen}`);
  }
  if (rule.stringMaxLen != null && length > rule.stringMaxLen) {
    addViolation(violations, path, `string length must be at most ${rule.stringMaxLen}`);
  }
  if (rule.stringPattern != null) {
    let pattern = patternCache.get(rule.stringPattern);
    if (!pattern) {
      pattern = new RegExp(rule.stringPattern);
      patternCache.set(rule.stringPattern, pattern);
    }
    if (!pattern.test(value)) {
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
  if (rule.required && isRequiredValueMissing(value)) {
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
