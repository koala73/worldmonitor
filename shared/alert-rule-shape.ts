import { PREFERENCE_VARIANTS } from './cloud-preferences-contract';

/**
 * Bounds for an `alertRules` row. One account used to be able to write rows
 * of any size (unbounded `variant`, `eventTypes`, `channels`) and any number
 * of them, and the relay reads every enabled row in one Convex transaction —
 * so one account could push that shared read past the Convex read limit and
 * stop delivery for everyone. Every writer (Convex internal mutations and
 * the edge handler) checks the same function so the bounds cannot drift.
 */
export const ALERT_RULE_VARIANTS = PREFERENCE_VARIANTS;
export type AlertRuleVariant = (typeof ALERT_RULE_VARIANTS)[number];

/** One row per variant: a variant is the row key, so this is the row cap. */
export const ALERT_RULES_PER_USER_MAX = ALERT_RULE_VARIANTS.length;

export const ALERT_RULE_CHANNEL_TYPES = [
  'telegram', 'slack', 'email', 'discord', 'teams', 'webhook', 'web_push',
] as const;
/** A rule lists each channel type at most once. */
export const ALERT_RULE_CHANNELS_MAX = ALERT_RULE_CHANNEL_TYPES.length;

/** There are ~25 event types; the settings UI writes at most two. */
export const ALERT_RULE_EVENT_TYPES_MAX = 32;
/** Mirrors the /api/notify ingest contract (eventType ≤ 64 chars). */
export const ALERT_RULE_EVENT_TYPE_MAX_LENGTH = 64;
// Same control / bidi character set /api/notify rejects on ingest.
const EVENT_TYPE_FORBIDDEN_CHARS = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069]/;

/** Opt-in watched-site alerts; mirrored by scripts/lib/orbital-site-alerts.cjs for the relay. */
export const ORBITAL_SITE_ALERT_EVENT_TYPES = ['orbital_imaging_window', 'orbital_site_change'] as const;
/** A rule watches at most this many sites; each one can page on every seed run. */
export const ORBITAL_ALERT_SITES_MAX = 25;
/** Watched-site ids are `<list>:<slug>` (shared/watched-sites.ts). */
const ORBITAL_SITE_ID_PATTERN = /^[a-z][a-z0-9-]{0,31}:[a-z0-9_.-]{1,96}$/;

export type AlertRuleShapeCode =
  | 'VARIANT_INVALID'
  | 'EVENT_TYPES_INVALID'
  | 'CHANNELS_INVALID'
  | 'ORBITAL_SITES_INVALID';

export interface AlertRuleShapeViolation {
  code: AlertRuleShapeCode;
  message: string;
}

export function isAlertRuleVariant(value: unknown): value is AlertRuleVariant {
  return typeof value === 'string' && (ALERT_RULE_VARIANTS as readonly string[]).includes(value);
}

export function isAlertRuleEventType(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= ALERT_RULE_EVENT_TYPE_MAX_LENGTH
    && !EVENT_TYPE_FORBIDDEN_CHARS.test(value);
}

/**
 * Every bound the input breaks (one entry per field, first failing check).
 * `eventTypes` / `channels` are optional because the digest and quiet-hours
 * writers never carry them; `variant` is always required.
 */
export function listAlertRuleShapeViolations(input: {
  variant: unknown;
  eventTypes?: unknown;
  channels?: unknown;
  orbitalSites?: unknown;
}): AlertRuleShapeViolation[] {
  const violations: AlertRuleShapeViolation[] = [];
  if (!isAlertRuleVariant(input.variant)) {
    violations.push({
      code: 'VARIANT_INVALID',
      message: `variant must be one of: ${ALERT_RULE_VARIANTS.join(', ')}`,
    });
  }
  if (input.eventTypes !== undefined) {
    if (!Array.isArray(input.eventTypes) || input.eventTypes.length > ALERT_RULE_EVENT_TYPES_MAX) {
      violations.push({
        code: 'EVENT_TYPES_INVALID',
        message: `eventTypes must be an array of at most ${ALERT_RULE_EVENT_TYPES_MAX} entries`,
      });
    } else if (!input.eventTypes.every(isAlertRuleEventType)) {
      violations.push({
        code: 'EVENT_TYPES_INVALID',
        message: `each eventType must be a string of 1-${ALERT_RULE_EVENT_TYPE_MAX_LENGTH} characters with no control characters`,
      });
    }
  }
  if (input.channels !== undefined) {
    if (!Array.isArray(input.channels) || input.channels.length > ALERT_RULE_CHANNELS_MAX) {
      violations.push({
        code: 'CHANNELS_INVALID',
        message: `channels must be an array of at most ${ALERT_RULE_CHANNELS_MAX} entries`,
      });
    } else if (!input.channels.every((c) => (ALERT_RULE_CHANNEL_TYPES as readonly string[]).includes(c as string))) {
      violations.push({
        code: 'CHANNELS_INVALID',
        message: `each channel must be one of: ${ALERT_RULE_CHANNEL_TYPES.join(', ')}`,
      });
    }
  }
  if (input.orbitalSites !== undefined) {
    if (!Array.isArray(input.orbitalSites) || input.orbitalSites.length > ORBITAL_ALERT_SITES_MAX) {
      violations.push({
        code: 'ORBITAL_SITES_INVALID',
        message: `orbitalSites must be an array of at most ${ORBITAL_ALERT_SITES_MAX} watched-site ids`,
      });
    } else if (!input.orbitalSites.every((id) => typeof id === 'string' && ORBITAL_SITE_ID_PATTERN.test(id))) {
      violations.push({
        code: 'ORBITAL_SITES_INVALID',
        message: 'each orbitalSites entry must be a watched-site id such as "chokepoint:hormuz_strait"',
      });
    }
  }
  return violations;
}

/** The first bound the input breaks, or null when it is in shape. */
export function getAlertRuleShapeViolation(input: {
  variant: unknown;
  eventTypes?: unknown;
  channels?: unknown;
  orbitalSites?: unknown;
}): AlertRuleShapeViolation | null {
  return listAlertRuleShapeViolations(input)[0] ?? null;
}

/** Dedupe in first-seen order; shape is already validated. */
export function dedupeStrings<T extends string>(values: readonly T[]): T[] {
  return Array.from(new Set(values));
}
