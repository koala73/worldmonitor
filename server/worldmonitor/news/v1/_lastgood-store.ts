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
import { REVOKED_URLS_KEY } from '../../../_shared/digest-revocations';
import { getUsageScope } from '../../../_shared/usage';
import {
  ATTEMPT_META_TTL_S,
  LASTGOOD_MAX_AGE_MS,
  LASTGOOD_TTL_S,
  attemptMetaKey,
  isAcceptableDigest,
  isEligibleScope,
  lastGoodKey,
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
    for (const item of bucket?.items ?? []) {
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
        const reason = value.outcome === 'build-error' || value.outcome === 'empty-rebuild'
          ? value.outcome
          : null;
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
 * Publish a valid unfiltered body. The Redis script computes both candidate
 * and incumbent richness against one atomic SMEMBERS view before it writes.
 */
export async function publishAcceptedSnapshot(
  variant: string,
  lang: string,
  data: ListFeedDigestResponse,
): Promise<void> {
  if (!isEligibleScope(variant, lang) || !isAcceptableDigest(data)) return;
  const now = Date.now();
  const generatedAtMs = Date.parse(data.generatedAt ?? '');
  const acceptedAt = Number.isFinite(generatedAtMs) ? generatedAtMs : now;
  try {
    if (process.env.LOCAL_API_MODE === 'tauri-sidecar') {
      const read = await readAcceptedSnapshot<ListFeedDigestResponse>(variant, lang);
      if (!read.readable) return;
      const current = read.snapshot;
      const { categoryCount, itemCount } = measureServableRichness(data, new Set());
      const decision = shouldReplaceAccepted(current, { categoryCount, itemCount }, now);
      if (!decision.replace) return;
      const meta: AcceptedSnapshotMeta = { acceptedAt, categoryCount, itemCount };
      await setCachedJson(lastGoodKey(variant, lang), { ...meta, data }, LASTGOOD_TTL_S);
      return;
    }

    // ARGV[5] is the digest body ALONE, and the script splices it into the
    // stored JSON verbatim. Sending the wrapped `{ acceptedAt, data }` and
    // letting Lua rebuild it meant a cjson decode/encode round trip, which
    // silently rewrote every empty array in the body as `{}`.
    const results = await runRedisPipeline([[
      'EVAL',
      DIGEST_LASTGOOD_PUBLISH_SCRIPT,
      '2',
      lastGoodKey(variant, lang),
      REVOKED_URLS_KEY,
      String(now),
      String(LASTGOOD_MAX_AGE_MS),
      String(acceptedAt),
      String(LASTGOOD_TTL_S),
      JSON.stringify(data),
    ]]);
    const outcome = results[0];
    if (!outcome || outcome.error) {
      console.warn(`[digest-lastgood] guarded publish unavailable variant=${variant} lang=${lang}`);
    } else if (outcome.result === 0) {
      console.log(`[digest-lastgood] kept live snapshot (not-narrower) variant=${variant} lang=${lang}`);
    } else if (outcome.result === -1) {
      console.log(`[digest-lastgood] candidate rejected after revocations variant=${variant} lang=${lang}`);
    }
  } catch (err) {
    console.warn('[digest-lastgood] publish failed:', err);
    captureSilentError(err, {
      tags: { surface: 'news', component: 'digest-lastgood', stage: 'publish', variant, lang },
      fingerprint: ['digest-lastgood', 'publish-failed'],
    });
  }
}

export const __testing__ = {
  activeAttempts,
  recentFailedAttempts,
  failureCooldowns,
  measureServableRichness,
};
