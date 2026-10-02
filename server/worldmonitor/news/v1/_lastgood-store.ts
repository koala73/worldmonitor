/**
 * Redis persistence for durable news-digest recovery (#7084).
 *
 * `_lastgood.ts` owns pure acceptance and serving policy. This module owns
 * external I/O and shared attempt identity. The RPC handler still chooses the
 * serving tier and shapes the response.
 */
import type { ListFeedDigestResponse } from '../../../../src/generated/server/worldmonitor/news/v1/service_server';
// @ts-expect-error — JS module, no declaration file
import { captureSilentError } from '../../../../api/_sentry-edge.js';
import { DIGEST_LASTGOOD_PUBLISH_SCRIPT } from '../../../../shared/digest-lastgood-publish-script.mjs';
import {
  readCachedJson,
  runRedisPipeline,
  runRedisTransaction,
  setCachedJson,
} from '../../../_shared/redis';
import { REVOKED_URLS_KEY, readRevokedUrlSet } from '../../../_shared/digest-revocations';
import { getUsageScope } from '../../../_shared/usage';
import {
  ATTEMPT_META_TTL_S,
  LASTGOOD_MAX_AGE_MS,
  LASTGOOD_TTL_S,
  attemptMetaKey,
  isAcceptableDigest,
  isEligibleScope,
  isStaleReason,
  lastGoodKey,
  nextPeak,
  parseAcceptedSnapshot,
  shouldReplaceAccepted,
  type AcceptedSnapshot,
  type AcceptedSnapshotMeta,
  type DigestLike,
  type StaleReason,
} from './_lastgood';

// Private wire value used by cachedFetchJsonWithMeta. This write is kept here
// because the attempt row and sentinel must become visible atomically.
const DIGEST_NEGATIVE_SENTINEL = '__WM_NEG__';
const DIGEST_CACHE_TTL_S = 900;
const DIGEST_REJECTION_TTL_S = 120;

export interface FailedDigestAttempt {
  readonly at: string;
  readonly reason: StaleReason;
}

interface AttemptSlot {
  readonly at: string;
  readonly buildError: FailedDigestAttempt;
  failure: FailedDigestAttempt | null;
}

export interface LastGoodRead<T extends DigestLike> {
  snapshot: AcceptedSnapshot<T> | null;
  readable: boolean;
}

const activeAttempts = new Map<string, AttemptSlot>();
const recentFailedAttempts = new Map<string, { attempt: FailedDigestAttempt; expiresAt: number }>();
const failureCooldowns = new Map<string, number>();
const gateRejectionReports = new Map<string, number>();
const GATE_REJECTION_REPORT_COOLDOWN_MS = 30 * 60 * 1000;
const RECENT_ATTEMPT_MEMORY_MS = 5_000;
const LOCAL_RECOVERY_MAX_ENTRIES = 100;

function scopeKey(variant: string, lang: string): string {
  return `${variant}:${lang}`;
}

function boundLocalRecoveryMaps(now: number): void {
  if (recentFailedAttempts.size > LOCAL_RECOVERY_MAX_ENTRIES) {
    for (const [key, entry] of recentFailedAttempts) {
      if (entry.expiresAt <= now) recentFailedAttempts.delete(key);
    }
    if (recentFailedAttempts.size > LOCAL_RECOVERY_MAX_ENTRIES) recentFailedAttempts.clear();
  }
  if (failureCooldowns.size > LOCAL_RECOVERY_MAX_ENTRIES) {
    for (const [key, expiresAt] of failureCooldowns) {
      if (expiresAt <= now) failureCooldowns.delete(key);
    }
    if (failureCooldowns.size > LOCAL_RECOVERY_MAX_ENTRIES) failureCooldowns.clear();
  }
}

export function shouldStartDigestAttempt(digestCacheKey: string, now = Date.now()): boolean {
  const expiresAt = failureCooldowns.get(digestCacheKey) ?? 0;
  if (expiresAt <= now) {
    failureCooldowns.delete(digestCacheKey);
    return true;
  }
  return false;
}

export function deferDigestAttempt(digestCacheKey: string, ttlSeconds: number, now = Date.now()): void {
  boundLocalRecoveryMaps(now);
  failureCooldowns.set(digestCacheKey, now + ttlSeconds * 1000);
}

export function beginDigestAttempt(variant: string, lang: string, at: string): AttemptSlot {
  // A shared promise rejection can wake a follower before the leader's outer
  // catch runs. The thrown/timeout identity is therefore prepared at start;
  // an empty result selects its own immutable record before it resolves.
  const buildError = Object.freeze({ at, reason: 'build-error' as const });
  const slot: AttemptSlot = { at, buildError, failure: null };
  activeAttempts.set(scopeKey(variant, lang), slot);
  return slot;
}

export function completeDigestAttempt(variant: string, lang: string, slot: AttemptSlot): void {
  if (activeAttempts.get(scopeKey(variant, lang)) === slot) {
    activeAttempts.delete(scopeKey(variant, lang));
  }
}

function scheduleBackground(promise: Promise<unknown>): void {
  const ctx = getUsageScope()?.ctx;
  if (ctx) ctx.waitUntil(promise);
  else void promise;
}

function transactionSucceeded(results: Array<{ result?: unknown; error?: string }>, count: number): boolean {
  return results.length === count && results.every((result) => !result.error && result.result !== null);
}

export function measureServableRichness(
  data: DigestLike,
  revokedUrls: ReadonlySet<string>,
): { categoryCount: number; itemCount: number } {
  const categories = Object.values(data.categories ?? {});
  let itemCount = 0;
  for (const bucket of categories) {
    const items = Array.isArray(bucket?.items) ? bucket.items : [];
    for (const item of items) {
      const link = item && typeof item === 'object' && 'link' in item
        ? (item as { link?: unknown }).link
        : undefined;
      if (typeof link !== 'string' || !revokedUrls.has(link)) itemCount += 1;
    }
  }
  return { categoryCount: categories.length, itemCount };
}

/**
 * Freeze the leader-owned failure identity synchronously, then publish it with
 * the negative sentinel in one transaction. Callers do not await telemetry;
 * the response fallback can proceed while waitUntil keeps the write alive.
 */
export function publishFailedAttempt(
  variant: string,
  lang: string,
  digestCacheKey: string,
  slot: AttemptSlot,
  reason: StaleReason,
  sentinelTtlSeconds: number,
): FailedDigestAttempt {
  if (slot.failure) return slot.failure;
  const attempt = reason === 'build-error'
    ? slot.buildError
    : Object.freeze({ at: slot.at, reason });
  slot.failure = attempt;
  const now = Date.now();
  recentFailedAttempts.set(scopeKey(variant, lang), {
    attempt,
    // Keep the exact identity for the same interval in which the local retry
    // gate can replay the failure without a Redis sentinel.
    expiresAt: now + sentinelTtlSeconds * 1000,
  });
  failureCooldowns.set(digestCacheKey, now + sentinelTtlSeconds * 1000);
  boundLocalRecoveryMaps(now);

  if (!isEligibleScope(variant, lang)) return attempt;
  const ts = Date.parse(attempt.at);
  const stored = { ts: Number.isFinite(ts) ? ts : Date.now(), outcome: attempt.reason };
  const persist = (async () => {
    try {
      if (process.env.LOCAL_API_MODE === 'tauri-sidecar') {
        // The sidecar cache is single-process. Attempt first preserves the
        // same visibility order even though it has no transaction primitive.
        const attemptWritten = await setCachedJson(attemptMetaKey(variant, lang), stored, ATTEMPT_META_TTL_S);
        if (attemptWritten) {
          await setCachedJson(digestCacheKey, DIGEST_NEGATIVE_SENTINEL, sentinelTtlSeconds);
        }
        return;
      }
      const results = await runRedisTransaction([
        ['SET', attemptMetaKey(variant, lang), JSON.stringify(stored), 'EX', String(ATTEMPT_META_TTL_S)],
        ['SET', digestCacheKey, JSON.stringify(DIGEST_NEGATIVE_SENTINEL), 'EX', String(sentinelTtlSeconds)],
      ]);
      if (!transactionSucceeded(results, 2)) {
        console.warn(`[digest-attempt] atomic publish unavailable variant=${variant} lang=${lang}`);
      }
    } catch (err) {
      console.warn('[digest-attempt] publish failed:', err);
      captureSilentError(err, {
        tags: { surface: 'news', component: 'digest-lastgood', stage: 'attempt-publish', variant, lang },
        fingerprint: ['digest-lastgood', 'attempt-publish-failed'],
      });
    }
  })();
  scheduleBackground(persist);
  return attempt;
}

/** Remember the gate identity locally after its durable publication succeeds. */
function rememberGateHeldAttempt(
  variant: string,
  lang: string,
  at: string,
  digestCacheKey?: string,
): void {
  const now = Date.now();
  recentFailedAttempts.set(scopeKey(variant, lang), {
    attempt: Object.freeze({ at, reason: 'gate-held' as const }),
    expiresAt: now + DIGEST_REJECTION_TTL_S * 1000,
  });
  if (digestCacheKey) {
    failureCooldowns.set(digestCacheKey, now + DIGEST_REJECTION_TTL_S * 1000);
  }
  boundLocalRecoveryMaps(now);
}

export async function recoverFailedAttempt(
  variant: string,
  lang: string,
  fallback: FailedDigestAttempt,
  preferRecent = true,
): Promise<FailedDigestAttempt> {
  const key = scopeKey(variant, lang);
  const active = activeAttempts.get(key);
  if (active) return active.failure ?? active.buildError;
  const recent = recentFailedAttempts.get(key);
  if (recent && preferRecent) {
    if (recent.expiresAt > Date.now()) return recent.attempt;
    recentFailedAttempts.delete(key);
  }

  if (isEligibleScope(variant, lang)) {
    try {
      const read = await readCachedJson(attemptMetaKey(variant, lang));
      if (read.status === 'hit' && read.value && typeof read.value === 'object') {
        const value = read.value as { ts?: unknown; outcome?: unknown };
        const ts = typeof value.ts === 'number' && Number.isFinite(value.ts) ? value.ts : null;
        const reason = isStaleReason(value.outcome) ? value.outcome : null;
        if (ts !== null && reason) {
          const recovered = Object.freeze({ at: new Date(ts).toISOString(), reason });
          recentFailedAttempts.set(key, {
            attempt: recovered,
            expiresAt: Date.now() + RECENT_ATTEMPT_MEMORY_MS,
          });
          return recovered;
        }
      }
    } catch {
      // Recovery metadata is best-effort; the in-isolate identity follows.
    }
  }
  if (recent && recent.expiresAt > Date.now()) return recent.attempt;
  return fallback;
}

// readRevokedUrlSet moved to server/_shared/digest-revocations.ts so every
// reader of news:digest:v1:* shares one gate. Re-exported for existing callers.
export { readRevokedUrlSet } from '../../../_shared/digest-revocations';

export async function readAcceptedSnapshot<T extends DigestLike>(variant: string, lang: string): Promise<LastGoodRead<T>> {
  if (!isEligibleScope(variant, lang)) return { snapshot: null, readable: true };
  try {
    const read = await readCachedJson(lastGoodKey(variant, lang));
    if (read.status === 'error') return { snapshot: null, readable: false };
    return {
      snapshot: read.status === 'hit' ? parseAcceptedSnapshot<T>(read.value) : null,
      readable: true,
    };
  } catch (err) {
    captureSilentError(err, {
      tags: { surface: 'news', component: 'digest-lastgood', stage: 'serve-read', variant, lang },
      fingerprint: ['digest-lastgood', 'serve-read-threw'],
    });
    return { snapshot: null, readable: false };
  }
}

/**
 * A fresh build lost to the live snapshot. The requester still gets the fresh
 * body; everyone else keeps the older one until a build clears the gate or the
 * snapshot ages out. That is correct for a degraded build and invisible when
 * it is wrong: on 2026-09-19 it froze `full` for ~6h with only a console.log.
 * One Sentry issue per variant, at warning level.
 *
 * The 120s rejection sentinel is the only backoff for a held snapshot, so a
 * frozen scope rebuilds ~30x/hour in every region. The condition is sustained,
 * not an event: one capture per scope per cooldown, per isolate. The capture
 * rides the request's waitUntil so a frozen isolate cannot drop it mid-incident.
 */
function reportGateRejection(variant: string, lang: string): void {
  console.log(`[digest-publication] candidate rejected by acceptance gate variant=${variant} lang=${lang}`);
  const key = scopeKey(variant, lang);
  const now = Date.now();
  if ((gateRejectionReports.get(key) ?? 0) > now) return;
  if (gateRejectionReports.size >= LOCAL_RECOVERY_MAX_ENTRIES) gateRejectionReports.clear();
  gateRejectionReports.set(key, now + GATE_REJECTION_REPORT_COOLDOWN_MS);
  captureSilentError(new Error('fresh digest rejected by the last-good acceptance gate'), {
    tags: { surface: 'news', component: 'digest-lastgood', stage: 'publish-gate', variant, lang },
    fingerprint: ['digest-lastgood', 'publish-gate-rejected', variant],
    level: 'warning',
    ctx: getUsageScope()?.ctx,
  });
}

/**
 * Publish a valid unfiltered body. The Redis script computes both candidate
 * and incumbent richness against one atomic SMEMBERS view before it writes.
 */
export async function publishAcceptedSnapshot(
  variant: string,
  lang: string,
  data: ListFeedDigestResponse,
  canonicalDigestKey?: string,
): Promise<'accepted' | 'rejected' | 'unavailable'> {
  if (!isEligibleScope(variant, lang) || !isAcceptableDigest(data)) return 'rejected';
  const now = Date.now();
  const generatedAtMs = Date.parse(data.generatedAt ?? '');
  const acceptedAt = Number.isFinite(generatedAtMs) ? generatedAtMs : now;
  try {
    if (process.env.LOCAL_API_MODE === 'tauri-sidecar') {
      const revoked = await readRevokedUrlSet();
      if (!revoked.readable) {
        console.warn(`[digest-publication] source unavailable variant=${variant} lang=${lang}`);
        return 'unavailable';
      }
      const candidateRichness = measureServableRichness(data, revoked.urls);
      if (candidateRichness.categoryCount < 1 || candidateRichness.itemCount < 1) {
        console.log(`[digest-publication] candidate rejected after revocations variant=${variant} lang=${lang}`);
        return 'rejected';
      }
      const read = await readAcceptedSnapshot<ListFeedDigestResponse>(variant, lang);
      if (!read.readable) {
        console.warn(`[digest-publication] publish unavailable variant=${variant} lang=${lang}`);
        return 'unavailable';
      }
      const current = read.snapshot;
      const currentCanonical = canonicalDigestKey
        ? await readCachedJson(canonicalDigestKey)
        : { status: 'miss' as const };
      if (currentCanonical.status === 'error') {
        console.warn(`[digest-publication] canonical read unavailable variant=${variant} lang=${lang}`);
        return 'unavailable';
      }
      const canonicalValue = currentCanonical.status === 'hit'
        && currentCanonical.value && typeof currentCanonical.value === 'object'
        ? currentCanonical.value as ListFeedDigestResponse
        : null;
      const canonicalGeneratedAt = canonicalValue ? Date.parse(canonicalValue.generatedAt ?? '') : NaN;
      const canonicalRichness = canonicalValue
        ? measureServableRichness(canonicalValue, revoked.urls)
        : null;
      const canonicalMeta = canonicalRichness
        && canonicalRichness.categoryCount >= 1
        && canonicalRichness.itemCount >= 1
        && Number.isFinite(canonicalGeneratedAt)
        ? {
            acceptedAt: canonicalGeneratedAt,
            ...canonicalRichness,
          }
        : null;
      // Re-measure the incumbent BODY under the current revocation set, as the
      // Lua gate does. Its stored itemCount is a publication-time count, and a
      // URL revoked since must not keep inflating it and veto the repair.
      const measuredCurrentItems = current
        ? measureServableRichness(current.data, revoked.urls).itemCount
        : undefined;
      const decision = shouldReplaceAccepted(current, candidateRichness, now, measuredCurrentItems);
      const canonicalDecision = canonicalMeta
        ? shouldReplaceAccepted(canonicalMeta, candidateRichness, now)
        : null;
      if (!decision.replace || canonicalDecision && !canonicalDecision.replace) {
        // The single-process sidecar has no transaction primitive. Publish
        // identity first, so a visible sentinel always has its matching reason.
        const attemptWritten = await setCachedJson(
          attemptMetaKey(variant, lang), { ts: now, outcome: 'gate-held' }, ATTEMPT_META_TTL_S,
        );
        if (!attemptWritten) return 'unavailable';
        if (!decision.replace && canonicalDigestKey && currentCanonical.status === 'miss') {
          const cooldownWritten = await setCachedJson(
            canonicalDigestKey,
            DIGEST_NEGATIVE_SENTINEL,
            DIGEST_REJECTION_TTL_S,
          );
          if (!cooldownWritten) {
            console.warn(`[digest-publication] publish unavailable variant=${variant} lang=${lang}`);
            return 'unavailable';
          }
        }
        rememberGateHeldAttempt(variant, lang, new Date(now).toISOString(), canonicalDigestKey);
        reportGateRejection(variant, lang);
        return 'rejected';
      }
      const meta: AcceptedSnapshotMeta = {
        acceptedAt,
        ...candidateRichness,
        ...nextPeak(current, candidateRichness.itemCount, acceptedAt, now, measuredCurrentItems),
      };
      const durableWritten = await setCachedJson(lastGoodKey(variant, lang), { ...meta, data }, LASTGOOD_TTL_S);
      if (!durableWritten) {
        console.warn(`[digest-publication] publish unavailable variant=${variant} lang=${lang}`);
        return 'unavailable';
      }
      if (canonicalDigestKey) {
        const canonicalWritten = await setCachedJson(canonicalDigestKey, data, DIGEST_CACHE_TTL_S);
        if (!canonicalWritten) {
          console.warn(`[digest-publication] publish unavailable variant=${variant} lang=${lang}`);
          return 'unavailable';
        }
      }
      return 'accepted';
    }

    // ARGV[5] is the digest body ALONE, and the script splices it into the
    // stored JSON verbatim. Sending the wrapped `{ acceptedAt, data }` and
    // letting Lua rebuild it meant a cjson decode/encode round trip, which
    // silently rewrote every empty array in the body as `{}`.
    const keys = canonicalDigestKey
      ? [lastGoodKey(variant, lang), REVOKED_URLS_KEY, attemptMetaKey(variant, lang), canonicalDigestKey]
      : [lastGoodKey(variant, lang), REVOKED_URLS_KEY, attemptMetaKey(variant, lang)];
    const args = [
      String(now),
      String(LASTGOOD_MAX_AGE_MS),
      String(acceptedAt),
      String(LASTGOOD_TTL_S),
      JSON.stringify(data),
      String(DIGEST_CACHE_TTL_S),
      new Date(now - LASTGOOD_MAX_AGE_MS).toISOString(),
      new Date(now).toISOString(),
      String(DIGEST_REJECTION_TTL_S),
      String(ATTEMPT_META_TTL_S),
    ];
    const results = await runRedisPipeline([[
      'EVAL',
      DIGEST_LASTGOOD_PUBLISH_SCRIPT,
      String(keys.length),
      ...keys,
      ...args,
    ]]);
    const outcome = results[0];
    if (!outcome || outcome.error) {
      console.warn(`[digest-publication] publish unavailable variant=${variant} lang=${lang}`);
      return 'unavailable';
    } else if (outcome.result === 0) {
      rememberGateHeldAttempt(variant, lang, new Date(now).toISOString(), canonicalDigestKey);
      reportGateRejection(variant, lang);
      return 'rejected';
    } else if (outcome.result === -1) {
      console.log(`[digest-publication] candidate rejected after revocations variant=${variant} lang=${lang}`);
      return 'rejected';
    } else if (outcome.result === 1) {
      return 'accepted';
    }
    console.warn(`[digest-publication] publish unavailable variant=${variant} lang=${lang}`);
    return 'unavailable';
  } catch (err) {
    console.warn('[digest-publication] publish failed:', err);
    captureSilentError(err, {
      tags: { surface: 'news', component: 'digest-lastgood', stage: 'publish', variant, lang },
      fingerprint: ['digest-lastgood', 'publish-failed'],
    });
    return 'unavailable';
  }
}

export const __testing__ = {
  activeAttempts,
  recentFailedAttempts,
  failureCooldowns,
  gateRejectionReports,
  deferDigestAttempt,
  measureServableRichness,
};
