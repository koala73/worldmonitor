import { ValidationError } from '../../../../src/generated/server/worldmonitor/shipping/v2/service_server';
import eventTriggers from '../../../../shared/event-triggers.json';
import ISO2_TO_ISO3 from '../../../../shared/iso2-to-iso3.json';

/**
 * Validation and defaults for the `scope` object of an occurrence-event
 * subscription (news.breaking, market.move, natural.hazard), driven by the
 * event's `inputSchema` in shared/event-triggers.json so the registry stays
 * the one contract the API, the worker and the Zapier app share.
 *
 * Defaults are applied here and stored on the record, the way alertThreshold
 * defaults to 50 at registration: the worker never consults the registry for
 * a record's scope, so editing a default later changes only new subscriptions.
 */

interface ScopeFieldSchema {
  type?: string;
  items?: { type?: string; enum?: string[]; minLength?: number; maxLength?: number; pattern?: string };
  enum?: string[];
  minimum?: number;
  maximum?: number;
  maxItems?: number;
  default?: unknown;
}

interface RegistryEvent {
  kind?: string;
  inputSchema?: { properties?: Record<string, ScopeFieldSchema> };
}

export type WebhookScopeValue = string[] | number | string;
/** The stored shape: only the keys the event defines, defaults filled in. */
export type StoredWebhookScope = Record<string, WebhookScopeValue>;

const EVENTS = eventTriggers.events as unknown as Record<string, RegistryEvent>;
const ISO2_CODES = new Set(Object.keys(ISO2_TO_ISO3));
/** Keys whose items are stored lower-cased (matched case-insensitively). */
const LOWERCASE_KEYS = new Set(['keywords']);
/** Keys whose items are stored upper-cased (codes and tickers). */
const UPPERCASE_KEYS = new Set(['countries', 'symbols']);

export const OCCURRENCE_EVENT_TYPES: ReadonlySet<string> = new Set(
  Object.entries(EVENTS).filter(([, event]) => event.kind === 'occurrence').map(([key]) => key),
);

export function isOccurrenceEvent(eventType: string): boolean {
  return OCCURRENCE_EVENT_TYPES.has(eventType);
}

export function scopeSchemaFor(eventType: string): Record<string, ScopeFieldSchema> | null {
  if (!isOccurrenceEvent(eventType)) return null;
  return EVENTS[eventType]?.inputSchema?.properties ?? {};
}

function violation(field: string, description: string): ValidationError {
  return new ValidationError([{ field, description }]);
}

function isProvided(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'string') return value.trim().length > 0;
  return true;
}

function normalizeList(field: string, key: string, raw: unknown, schema: ScopeFieldSchema): string[] {
  if (!Array.isArray(raw)) throw violation(field, `${field} must be an array of strings`);
  const items = schema.items ?? {};
  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'string') throw violation(field, `${field} must be an array of strings`);
    let item = entry.trim();
    if (!item) continue;
    if (LOWERCASE_KEYS.has(key)) item = item.toLowerCase();
    if (UPPERCASE_KEYS.has(key)) item = item.toUpperCase();
    if (items.minLength !== undefined && item.length < items.minLength) {
      throw violation(field, `${field} items must be at least ${items.minLength} characters: ${item}`);
    }
    if (items.maxLength !== undefined && item.length > items.maxLength) {
      throw violation(field, `${field} items must be at most ${items.maxLength} characters`);
    }
    if (items.enum && !items.enum.includes(item)) {
      throw violation(field, `Unknown ${key} value: ${item}. Expected one of ${items.enum.join(', ')}`);
    }
    if (key === 'countries' && !ISO2_CODES.has(item)) {
      throw violation(field, `Unknown country code: ${item}. Expected ISO 3166-1 alpha-2`);
    }
    if (!seen.has(item)) {
      seen.add(item);
      out.push(item);
    }
  }
  if (schema.maxItems !== undefined && out.length > schema.maxItems) {
    throw violation(field, `${field} accepts at most ${schema.maxItems} items`);
  }
  return out;
}

function normalizeNumber(field: string, raw: unknown, schema: ScopeFieldSchema): number {
  const value = typeof raw === 'string' && raw.trim() ? Number(raw) : raw;
  if (typeof value !== 'number' || !Number.isFinite(value)) throw violation(field, `${field} must be a number`);
  if (schema.type === 'integer' && !Number.isInteger(value)) throw violation(field, `${field} must be an integer`);
  if (schema.minimum !== undefined && value < schema.minimum) {
    throw violation(field, `${field} must be between ${schema.minimum} and ${schema.maximum}`);
  }
  if (schema.maximum !== undefined && value > schema.maximum) {
    throw violation(field, `${field} must be between ${schema.minimum} and ${schema.maximum}`);
  }
  return value;
}

function normalizeEnum(field: string, raw: unknown, schema: ScopeFieldSchema): string {
  if (typeof raw !== 'string') throw violation(field, `${field} must be a string`);
  const value = raw.trim();
  if (!schema.enum?.includes(value)) {
    throw violation(field, `${field} must be one of ${(schema.enum ?? []).join(', ')}`);
  }
  return value;
}

/**
 * Validate a registration's `scope` for `eventType` and return the stored
 * shape with defaults. A threshold event (chokepoint.disruption,
 * country.risk_surge) accepts no scope: any set key is a 400, like `countries`
 * on a chokepoint subscription. An occurrence event rejects keys its
 * inputSchema does not define, so a `symbols` list on news.breaking is a 400
 * rather than a silently ignored filter. Empty arrays and empty strings count
 * as "not sent", because generated clients serialise every repeated field.
 */
export function normalizeWebhookScope(eventType: string, raw: unknown): StoredWebhookScope {
  if (raw !== undefined && raw !== null && (typeof raw !== 'object' || Array.isArray(raw))) {
    throw violation('scope', 'scope must be an object');
  }
  const provided = Object.entries((raw ?? {}) as Record<string, unknown>).filter(([, value]) => isProvided(value));
  const schema = scopeSchemaFor(eventType);
  if (!schema) {
    if (provided.length) {
      throw violation('scope', `scope applies only to ${[...OCCURRENCE_EVENT_TYPES].join(', ')}`);
    }
    return {};
  }
  const out: StoredWebhookScope = {};
  for (const [key, value] of provided) {
    const fieldSchema = schema[key];
    const field = `scope.${key}`;
    if (!fieldSchema) {
      throw violation(field, `${field} does not apply to ${eventType}. Expected ${Object.keys(schema).join(', ')}`);
    }
    if (fieldSchema.type === 'array') out[key] = normalizeList(field, key, value, fieldSchema);
    else if (fieldSchema.type === 'integer' || fieldSchema.type === 'number') out[key] = normalizeNumber(field, value, fieldSchema);
    else out[key] = normalizeEnum(field, value, fieldSchema);
  }
  for (const [key, fieldSchema] of Object.entries(schema)) {
    if (key in out || !('default' in fieldSchema)) continue;
    const fallback = fieldSchema.default;
    out[key] = Array.isArray(fallback) ? [...fallback] as string[] : fallback as number | string;
  }
  return out;
}
