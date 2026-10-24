/**
 * Daily ceilings and the early-warning alarm for the two credential classes
 * that used to have no daily cap at all: operator keys (`WORLDMONITOR_VALID_KEYS`,
 * which the gateway labels `enterprise`) and the catalog Enterprise plan.
 *
 * Both were sold or issued as "unlimited", so one leaked key meant unbounded
 * provider spend. The ceilings below are circuit breakers, not plan limits:
 * each sits far above observed use (operator keys, 2026-07-20 → 2026-10-18:
 * peak 1,911 requests/day per key, peak 162 direct-LLM calls/day). The alarm
 * fires well before a ceiling, once per principal per meter per UTC day, so a
 * leak pages someone while the key still works.
 *
 * The catalog Enterprise ceilings live in `convex/config/productCatalog.ts`
 * (the Convex config graph cannot be imported here); `planLimits` carries them
 * to these call sites like any other plan's.
 */

// @ts-expect-error — JS module, no declaration file
import { captureSilentError } from '../../api/_sentry-edge.js';

/** Per operator key, per UTC day. */
export const OPERATOR_KEY_DAILY_CEILINGS = {
  /** REST requests. Recorded only while `API_RATE_LIMIT_ENFORCE` is off. */
  restRequests: 100_000,
  /** MCP tool calls: one unit per call, as on Pro's dedicated counter. */
  mcpUnits: 10_000,
  /** Direct-LLM calls, one counter shared by the gateway, chat-analyst and widget-agent. */
  directLlmCalls: 5_000,
} as const;

/** The alarm fires when a day's count first reaches this share of its ceiling. */
export const HIGH_USAGE_ALARM_FRACTION = 0.25;

export type HighUsageMeter = 'rest' | 'mcp' | 'direct-llm';

/**
 * Whether the reservation that just moved a counter to `newCount` (charging
 * `weight` units) crossed the alarm threshold. True for exactly one
 * reservation per counter per day, because the counter only grows within its
 * day: the one whose previous value sat below the threshold and whose new
 * value reached it. Weighted increments can step over the exact threshold, so
 * this compares the range, not equality.
 */
export function crossedHighUsageThreshold(newCount: number, weight: number, ceiling: number): boolean {
  if (!Number.isFinite(newCount) || !Number.isFinite(ceiling) || ceiling <= 0) return false;
  const threshold = Math.ceil(ceiling * HIGH_USAGE_ALARM_FRACTION);
  const previous = newCount - Math.max(1, weight);
  return previous < threshold && newCount >= threshold;
}

type HighUsageReporter = (error: Error, opts: Record<string, unknown>) => unknown;
let reporter: HighUsageReporter = captureSilentError;

// Crossings already reported this UTC day, by meter, credential and principal.
// Direct-LLM counters roll back when a relay fails, so a retry at the
// threshold crosses it again; this keeps that to one event per isolate. Other
// isolates can still report the same crossing, and Sentry groups them under
// one fingerprint.
const reportedToday = new Map<string, string>();

export function __setHighUsageReporterForTests(fn: HighUsageReporter | null): void {
  reporter = fn ?? captureSilentError;
}

export function __resetHighUsageAlarmForTests(): void {
  reportedToday.clear();
}

/**
 * Report a crossed threshold to Sentry. `principal` must already be a
 * non-secret identifier — the gateway's `hashKeySync` of an operator key (the
 * `principal_id` Axiom records) or an account id — never a raw credential.
 */
export function reportHighUsageIfCrossed(opts: {
  meter: HighUsageMeter;
  credential: 'operator-key' | 'enterprise-plan';
  principal: string;
  newCount: number;
  weight?: number;
  ceiling: number;
  ctx?: { waitUntil: (p: Promise<unknown>) => void };
}): boolean {
  if (!crossedHighUsageThreshold(opts.newCount, opts.weight ?? 1, opts.ceiling)) return false;
  const day = new Date().toISOString().slice(0, 10);
  const key = `${opts.meter}|${opts.credential}|${opts.principal}`;
  if (reportedToday.get(key) === day) return false;
  // Evict only earlier days. Today's entries are what stop a rollback and
  // retry from re-reporting, and they are bounded by the principals that
  // crossed a threshold today.
  for (const [reportedKey, reportedDay] of reportedToday) {
    if (reportedDay !== day) reportedToday.delete(reportedKey);
  }
  reportedToday.set(key, day);
  reporter(
    new Error(
      `High daily usage: ${opts.credential} ${opts.principal} reached ${opts.newCount} of its ` +
        `${opts.ceiling} ${opts.meter} ceiling`,
    ),
    {
      tags: { route: 'high-usage-alarm', meter: opts.meter, credential: opts.credential },
      extra: { principal: opts.principal, newCount: opts.newCount, ceiling: opts.ceiling },
      fingerprint: ['high-usage-alarm', opts.meter, opts.credential],
      ctx: opts.ctx,
    },
  );
  return true;
}

/**
 * The direct-LLM quota principal for an operator key: `wm:` plus the first 32
 * hex chars of its SHA-256. This is the bucket `api/widget-agent.ts` already
 * charged, so moving the gateway and chat-analyst onto it adds their calls to
 * the existing counter rather than starting a second one.
 */
export async function operatorKeyQuotaPrincipal(key: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(key));
  const hex = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return `wm:${hex.slice(0, 32)}`;
}
