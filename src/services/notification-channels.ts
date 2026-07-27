import { getClerkToken, getCurrentClerkUser } from '@/services/clerk';
import { SITE_VARIANT } from '@/config/variant';

export type ChannelType = 'telegram' | 'slack' | 'email' | 'discord' | 'webhook' | 'web_push';
export type Sensitivity = 'all' | 'high' | 'critical';
export type QuietHoursOverride = 'critical_only' | 'silence_all' | 'batch_on_wake';
export type DigestMode = 'realtime' | 'daily' | 'twice_daily' | 'weekly';

export interface NotificationChannel {
  channelType: ChannelType;
  verified: boolean;
  linkedAt: number;
  chatId?: string;
  email?: string;
  slackChannelName?: string;
  slackTeamName?: string;
  slackConfigurationUrl?: string;
  webhookLabel?: string;
  // web_push identity fields
  endpoint?: string;
  p256dh?: string;
  auth?: string;
  userAgent?: string;
}

export interface AlertRule {
  variant: string;
  enabled: boolean;
  eventTypes: string[];
  sensitivity: Sensitivity;
  channels: ChannelType[];
  quietHoursEnabled?: boolean;
  quietHoursStart?: number;
  quietHoursEnd?: number;
  quietHoursTimezone?: string;
  quietHoursOverride?: QuietHoursOverride;
  digestMode?: DigestMode;
  digestHour?: number;
  digestTimezone?: string;
  aiDigestEnabled?: boolean;
  // Optional country-scope (ISO-3166 alpha-2). Empty/absent → all countries.
  countries?: string[];
  // Optional watchlist ticker-scope (#4922 U3). OPT-IN scoped, unlike
  // countries: empty/absent → NO watchlist_story_alert delivery.
  tickers?: string[];
}

export interface ChannelsData {
  channels: NotificationChannel[];
  alertRules: AlertRule[];
}

// ---------------------------------------------------------------------------
// Retryable billing-verification denials (#5622)
// ---------------------------------------------------------------------------

/**
 * The `code`s the server marks RETRYABLE on a 503
 * (server/_shared/entitlement-check.ts, documented in docs/usage-errors.mdx).
 *
 * An allowlist, not "any 503", and that is the whole point. This endpoint also
 * answers 503 for a missing Convex/relay env and for relay failures that happen
 * AFTER a mutation may have partially landed — blind-retrying a POST on those
 * risks a duplicate write. A billing-verification denial is emitted by the gate
 * BEFORE any write, so retrying it is side-effect-free.
 *
 * `subscription_lapsed` is absent on purpose: it is a 403 and terminal.
 */
const RETRYABLE_BILLING_CODES = new Set([
  'entitlement_verification_unavailable',
  'renewal_verification_pending',
  'renewal_verification_failed',
]);

/** Used when the server omitted Retry-After; matches the server's own default. */
const DEFAULT_BILLING_RETRY_AFTER_SECONDS = 5;

/**
 * Longest delay worth waiting out inline. The server clamps Retry-After to
 * 1-60s; a user sitting in the activation wizard will not wait a minute, so a
 * longer hint means "surface the failure now" rather than "retry early".
 *
 * This threshold is not arbitrary — it lands between the delays the three
 * retryable states actually ask for (convex/payments/billing.ts):
 *
 *   entitlement_verification_unavailable  fixed 5s      -> retried
 *   renewal_verification_pending          1-3s, from
 *                                         the 2s Dodo
 *                                         re-check window -> retried
 *   renewal_verification_failed           up to 60s, the
 *                                         per-subscription
 *                                         failure cooldown -> NOT retried
 *
 * Declining the third is the correct outcome, not a shortfall: that cooldown
 * exists to stop re-querying Dodo, so a retry inside it is answered from the
 * same cooled-down state. Waiting it out inline would block the wizard for a
 * minute to arrive at the same denial.
 *
 * Retrying EARLIER than the server asked is deliberately not an option either:
 * it violates the Retry-After contract and, because the server negative-caches
 * a transient answer for a few seconds
 * (UNAVAILABLE_NEGATIVE_CACHE_TTL_MS in server/_shared/entitlement-check.ts),
 * an early retry would deterministically be served the same cached failure.
 */
const BILLING_RETRY_MAX_DELAY_MS = 10_000;

/**
 * How long to wait before the single retry, or null when this response must not
 * be retried. Pure — the wire decision, testable without a network.
 */
export function billingVerificationRetryDelayMs(input: {
  status: number;
  code: string | null;
  retryAfterHeader: string | null;
}): number | null {
  if (input.status !== 503) return null;
  if (!input.code || !RETRYABLE_BILLING_CODES.has(input.code)) return null;

  const parsed = Number(input.retryAfterHeader);
  const seconds = Number.isFinite(parsed) && parsed > 0
    ? parsed
    : DEFAULT_BILLING_RETRY_AFTER_SECONDS;
  const delayMs = Math.ceil(seconds * 1_000);
  return delayMs > BILLING_RETRY_MAX_DELAY_MS ? null : delayMs;
}

/**
 * The denial code, header-first with a body fallback.
 *
 * `X-Billing-Verification` is now in Access-Control-Expose-Headers (#5622), but
 * the dashboard's same-origin calls are not the only consumers — the Tauri shell
 * and widget embeds are cross-origin, and an intermediary can strip a header.
 * The body's `code` mirrors it, read off a CLONE so the caller's response stream
 * is untouched whether or not we end up retrying.
 */
async function readBillingVerificationCode(res: Response): Promise<string | null> {
  const header = res.headers.get('X-Billing-Verification');
  if (header) return header;
  try {
    const body = await res.clone().json() as { code?: unknown };
    return typeof body.code === 'string' ? body.code : null;
  } catch {
    return null;
  }
}

function sleep(ms: number, signal?: AbortSignal | null): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error('Aborted'));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    function onAbort(): void {
      clearTimeout(timer);
      reject(signal?.reason ?? new Error('Aborted'));
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Seam for the retry tests. The real Clerk token fetch and `fetch` cannot be
 * driven from a unit test, and the retry decision is exactly the kind of wiring
 * that a source-level assertion can claim works while it does not.
 */
export interface NotificationChannelsClientDeps {
  getClerkToken: typeof getClerkToken;
  getCurrentClerkUser: typeof getCurrentClerkUser;
  fetch: typeof fetch;
  sleep: (ms: number, signal?: AbortSignal | null) => Promise<void>;
}

const defaultClientDeps = (): NotificationChannelsClientDeps => ({
  getClerkToken,
  getCurrentClerkUser,
  fetch: (...args) => globalThis.fetch(...args),
  sleep,
});

let clientDeps = defaultClientDeps();

export function __setNotificationChannelsClientDepsForTests(
  overrides: Partial<NotificationChannelsClientDeps> | null,
): void {
  clientDeps = overrides ? { ...defaultClientDeps(), ...overrides } : defaultClientDeps();
}

function assertExpectedAccount(expectedUserId?: string): void {
  if (expectedUserId && clientDeps.getCurrentClerkUser()?.id !== expectedUserId) {
    throw new Error('Authenticated account changed during notification setup');
  }
}

async function sendOnce(
  path: string,
  init?: RequestInit,
  expectedUserId?: string,
): Promise<Response> {
  assertExpectedAccount(expectedUserId);
  let token = await clientDeps.getClerkToken();
  if (!token) {
    console.warn('[authFetch] getClerkToken returned null, retrying in 2s...');
    await clientDeps.sleep(2000, init?.signal ?? null);
    token = await clientDeps.getClerkToken();
  }
  if (!token) throw new Error('Not authenticated (Clerk token null after retry)');
  // The token was resolved asynchronously. Re-check immediately before the
  // request so a modal opened by user A cannot write under user B's session.
  assertExpectedAccount(expectedUserId);
  return clientDeps.fetch(path, {
    ...init,
    headers: {
      ...(init?.headers ?? {}),
      Authorization: `Bearer ${token}`,
    },
  });
}

/**
 * Authenticated fetch with ONE bounded retry on a retryable
 * billing-verification 503 (#5622).
 *
 * Before this, every caller below threw `Error(\`... ${res.status}\`)` on any
 * non-2xx, so the 503 + Retry-After + X-Billing-Verification the server emits
 * for an unverifiable entitlement was inert on this surface — the day-0 Pro
 * activation wizard failed the step exactly as if the user had no subscription.
 * The retry is what makes the server-side contract observable behavior.
 *
 * Bounded on purpose: one extra attempt, only for the codes the server marks
 * retryable, only after waiting the delay it asked for. The retry re-derives the
 * Clerk token and re-asserts the expected account, so it cannot write under a
 * session that changed while we waited.
 *
 * Note this does NOT help the day-0 poisoned-marker cohort — that state is a
 * 403 by design (see api/notification-channels.ts), and no amount of retrying
 * should turn a clean upsell into a retry loop.
 *
 * `init.body` must be a re-sendable value (every caller here passes a string).
 * A stream body would be consumed by the first attempt.
 *
 * `waitSignal` cancels only the Retry-After WAIT, never a dispatched request.
 * That distinction is the whole point: a caller whose lifetime signal lands in
 * `init.signal` cancels the POST itself, and for the fire-and-forget setters
 * below that silently discards a write the user already made. Read paths pass
 * their signal in `init` (cancelling a stale read is desirable); write paths
 * pass it here instead, so closing the settings panel abandons the retry rather
 * than the mutation.
 */
async function authFetch(
  path: string,
  init?: RequestInit,
  expectedUserId?: string,
  waitSignal?: AbortSignal | null,
): Promise<Response> {
  // Pin the identity for the whole call, including the retry. `expectedUserId`
  // is opt-in and most callers in this file omit it (every setter reached from
  // src/services/notifications-settings.ts), which made assertExpectedAccount a
  // no-op for them. That was tolerable while a call was one round-trip; adding a
  // multi-second wait is not — an account switch during the wait would let the
  // retry write under the new session. Falling back to the session that was
  // current when the call started gives those callers the same protection the
  // activation wizard asks for explicitly.
  const pinnedUserId = expectedUserId ?? clientDeps.getCurrentClerkUser()?.id;
  const first = await sendOnce(path, init, pinnedUserId);
  if (first.status !== 503) return first;

  // No identity could be pinned — `getCurrentClerkUser()` is a synchronous
  // `clerkInstance?.user` read that never triggers a load, while
  // `getClerkToken()` above can itself initialise Clerk and succeed. So a call
  // landing in that window reaches here with `pinnedUserId === undefined`, and
  // `assertExpectedAccount(undefined)` is a no-op. Rather than retry with the
  // account check silently disabled — the exact protection the comment above
  // claims — decline the retry and let the caller surface the 503.
  if (pinnedUserId === undefined) return first;

  const delayMs = billingVerificationRetryDelayMs({
    status: first.status,
    code: await readBillingVerificationCode(first),
    retryAfterHeader: first.headers.get('Retry-After'),
  });
  if (delayMs === null) return first;

  await clientDeps.sleep(delayMs, waitSignal ?? init?.signal ?? null);
  return sendOnce(path, init, pinnedUserId);
}

export async function getChannelsData(
  expectedUserId?: string,
  signal?: AbortSignal,
): Promise<ChannelsData> {
  const res = await authFetch(
    '/api/notification-channels',
    signal ? { signal } : undefined,
    expectedUserId,
  );
  if (!res.ok) throw new Error(`get channels: ${res.status}`);
  return res.json() as Promise<ChannelsData>;
}

export async function createPairingToken(
  signal?: AbortSignal,
): Promise<{ token: string; expiresAt: number }> {
  const res = await authFetch('/api/notification-channels', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'create-pairing-token', variant: SITE_VARIANT }),
    signal,
  });
  if (!res.ok) throw new Error(`create pairing token: ${res.status}`);
  return res.json();
}

/**
 * `signal` on the WRITE setters below (set-channel, delete-channel,
 * set-alert-rules, set-quiet-hours, set-digest-settings, set-notification-config)
 * abandons the Retry-After wait only — it never cancels a dispatched request.
 *
 * That is deliberately NOT what `signal` means on `getChannelsData` /
 * `createPairingToken`, where it aborts the fetch: cancelling a stale READ is
 * the point, while cancelling a write silently discards a setting the user
 * already changed. The settings panel passes its section-lifetime signal to
 * both, so the distinction has to live here rather than at the call site.
 *
 * `startSlackOAuth` / `startDiscordOAuth` keep the read semantics — they persist
 * nothing the user would miss, and abandoning a popup handoff on teardown is
 * correct.
 */
export async function setEmailChannel(
  email: string,
  expectedUserId?: string,
  signal?: AbortSignal,
): Promise<void> {
  const res = await authFetch('/api/notification-channels', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'set-channel', channelType: 'email', email }),
  }, expectedUserId, signal);
  if (!res.ok) throw new Error(`set email channel: ${res.status}`);
}

export async function setSlackChannel(
  webhookEnvelope: string,
  signal?: AbortSignal,
): Promise<void> {
  const res = await authFetch('/api/notification-channels', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'set-channel', channelType: 'slack', webhookEnvelope }),
  }, undefined, signal);
  if (!res.ok) throw new Error(`set slack channel: ${res.status}`);
}

export async function setWebhookChannel(
  webhookUrl: string,
  label?: string,
  signal?: AbortSignal,
): Promise<void> {
  const res = await authFetch('/api/notification-channels', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'set-channel', channelType: 'webhook', webhookEnvelope: webhookUrl, webhookLabel: label }),
  }, undefined, signal);
  if (!res.ok) throw new Error(`set webhook channel: ${res.status}`);
}

export async function startSlackOAuth(signal?: AbortSignal): Promise<string> {
  const res = await authFetch('/api/slack/oauth/start', { method: 'POST', signal });
  if (!res.ok) throw new Error(`slack oauth start: ${res.status}`);
  const data = await res.json() as { oauthUrl: string };
  return data.oauthUrl;
}

export async function startDiscordOAuth(signal?: AbortSignal): Promise<string> {
  const res = await authFetch('/api/discord/oauth/start', { method: 'POST', signal });
  if (!res.ok) throw new Error(`discord oauth start: ${res.status}`);
  const data = await res.json() as { oauthUrl: string };
  return data.oauthUrl;
}

export async function deleteChannel(
  channelType: ChannelType,
  signal?: AbortSignal,
): Promise<void> {
  const res = await authFetch('/api/notification-channels', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'delete-channel', channelType }),
  }, undefined, signal);
  if (!res.ok) throw new Error(`delete channel: ${res.status}`);
}

export async function saveAlertRules(
  rules: AlertRule,
  signal?: AbortSignal,
): Promise<void> {
  const res = await authFetch('/api/notification-channels', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'set-alert-rules', ...rules }),
  }, undefined, signal);
  if (!res.ok) throw new Error(`save alert rules: ${res.status}`);
}

export async function setQuietHours(settings: {
  variant: string;
  quietHoursEnabled: boolean;
  quietHoursStart?: number;
  quietHoursEnd?: number;
  quietHoursTimezone?: string;
  quietHoursOverride?: QuietHoursOverride;
  countries?: string[];
}, signal?: AbortSignal): Promise<void> {
  const res = await authFetch('/api/notification-channels', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'set-quiet-hours', ...settings }),
  }, undefined, signal);
  if (!res.ok) throw new Error(`set quiet hours: ${res.status}`);
}

export async function setDigestSettings(settings: {
  variant: string;
  digestMode: DigestMode;
  digestHour?: number;
  digestTimezone?: string;
  countries?: string[];
}, signal?: AbortSignal): Promise<void> {
  const res = await authFetch('/api/notification-channels', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'set-digest-settings', ...settings }),
  }, undefined, signal);
  if (!res.ok) throw new Error(`set digest settings: ${res.status}`);
}

/**
 * Watchlist story alerts (#4922 U3): re-sync the alert rule's ticker-scope
 * after the user edits their market watchlist.
 *
 * No-ops (without any network write) unless the user's rule is enabled AND
 * has opted into 'watchlist_story_alert' — callers additionally gate on
 * PRO tier + signed-in state before invoking, so free/anon watchlist edits
 * never generate 4xx traffic against the PRO-gated endpoint.
 */
const WATCHLIST_TICKERS_MAX = 50;
const WATCHLIST_TICKER_RE = /^[A-Z][A-Z0-9&-]{0,11}(\.[A-Z]{1,3})?$/;

function normalizeWatchlistTickers(input: readonly string[] | undefined): string[] {
  const cleaned: string[] = [];
  const seen = new Set<string>();
  for (const raw of input ?? []) {
    if (typeof raw !== 'string') continue;
    const upper = raw.trim().toUpperCase();
    if (!WATCHLIST_TICKER_RE.test(upper)) continue;
    if (seen.has(upper)) continue;
    seen.add(upper);
    cleaned.push(upper);
  }
  return cleaned.slice(0, WATCHLIST_TICKERS_MAX);
}

function tickerSetsEqual(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const bSet = new Set(b);
  return a.every((ticker) => bSet.has(ticker));
}

export type WatchlistTickerSyncPayload = Pick<AlertRule, 'variant' | 'enabled' | 'eventTypes' | 'sensitivity' | 'channels'> & {
  tickers: string[];
};

export function buildWatchlistTickerSyncPayload(rule: AlertRule | undefined, symbols: string[]): WatchlistTickerSyncPayload | null {
  if (!rule?.enabled || !rule.eventTypes?.includes('watchlist_story_alert')) return null;
  const tickers = normalizeWatchlistTickers(symbols);
  if (tickerSetsEqual(normalizeWatchlistTickers(rule.tickers), tickers)) return null;
  return {
    variant: rule.variant,
    enabled: rule.enabled,
    eventTypes: rule.eventTypes,
    sensitivity: rule.sensitivity,
    channels: rule.channels,
    // countries / aiDigestEnabled omitted on purpose — preserve-on-omit.
    tickers,
  };
}

export async function syncWatchlistTickersToAlertRule(
  symbols: string[],
  signal?: AbortSignal,
): Promise<void> {
  const data = await getChannelsData(undefined, signal);
  const payload = buildWatchlistTickerSyncPayload(data.alertRules?.[0], symbols);
  if (!payload) return;
  await saveAlertRules(payload, signal);
}

/**
 * Thrown when the server rejects a (digestMode, sensitivity) pair as incompatible
 * — currently the (realtime, all) combination. UI catches this specifically to
 * render the helper text inline rather than surfacing a generic error.
 * See docs/archive/plans/forbid-realtime-all-events.md §1f.
 */
export class IncompatibleDeliveryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IncompatibleDeliveryError';
  }
}

/**
 * Atomic save of (digestMode, sensitivity) and any subset of the alert-rule /
 * digest-schedule fields. Used by the settings UI's delivery-mode change flow
 * — replaces the legacy two-call sequence (saveAlertRules + setDigestSettings)
 * which races against the cross-field validator on `daily+all → realtime`.
 */
export async function setNotificationConfig(args: {
  variant: string;
  enabled?: boolean;
  eventTypes?: string[];
  sensitivity?: Sensitivity;
  channels?: ChannelType[];
  aiDigestEnabled?: boolean;
  digestMode?: DigestMode;
  digestHour?: number;
  digestTimezone?: string;
  countries?: string[];
  tickers?: string[];
}, expectedUserId?: string, signal?: AbortSignal): Promise<void> {
  const res = await authFetch('/api/notification-channels', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'set-notification-config', ...args }),
  }, expectedUserId, signal);
  if (res.ok) return;
  let body: { error?: string; message?: string } = {};
  try { body = await res.json(); } catch { /* keep default */ }
  if (res.status === 400 && body.error === 'INCOMPATIBLE_DELIVERY') {
    throw new IncompatibleDeliveryError(
      body.message ?? 'Real-time delivery requires High or Critical sensitivity.',
    );
  }
  throw new Error(`set notification config: ${res.status}`);
}
