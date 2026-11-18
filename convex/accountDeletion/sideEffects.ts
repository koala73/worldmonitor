/**
 * External account-deletion side effects: Dodo cancel, Redis invalidation,
 * MCP negative-cache sentinels, and Clerk user delete.
 *
 * Convex actions in this codebase use fetch (no `"use node"`). Tests mock
 * network; this module must not call live providers from unit tests.
 */

import { DodoPayments, NotFoundError, APIConnectionTimeoutError, APIConnectionError } from "dodopayments";
import { v } from "convex/values";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { internalAction, internalMutation, type ActionCtx } from "../_generated/server";
import { mergeUniqueStrings } from "./registry";

const REDIS_FETCH_TIMEOUT_MS = 5_000;
const CLERK_FETCH_TIMEOUT_MS = 8_000;
const DODO_ATTEMPT_TIMEOUT_MS = 8_000;
const MCP_NEG_CACHE_TTL_SECONDS = 60;
// The relay writes a recipient's alert history when its delivery pass ends,
// which can be after the account's Redis keys were deleted here. Its write
// (scripts/lib/sent-alert-history.cjs) is refused while this per-user marker
// exists, so a late write cannot recreate the history. The marker only has to
// outlive a pass that loaded the account's alert rules before the `personal`
// step deleted them (minutes); it uses the history's own 7-day TTL.
// tests/list-sent-alerts.test.mts fails when the key or the TTL drift from the
// relay module.
const SENT_ALERTS_ERASED_TTL_SECONDS = 7 * 24 * 60 * 60;
const USER_AGENT = "worldmonitor-convex/1.0";
const MAX_EXTERNAL_ATTEMPTS = 5;
const RETRY_BASE_DELAY_MS = 30_000;
const RETRY_MAX_DELAY_MS = 5 * 60_000;

class ProviderError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
  }
}

/**
 * Record an external failure without letting the recording itself escape.
 *
 * If this mutation throws — an optimistic-concurrency conflict from an
 * overlapping re-arm, a transient Convex error — the exception would propagate
 * out of `runExternalErase` and abandon the row at pending/external with its
 * attempt already consumed and nothing rescheduled. Nothing sweeps that state
 * quickly, so the deletion stalls with the subscription still live.
 */
async function recordFailureSafely(
  ctx: ActionCtx,
  deletionId: Id<"accountDeletions">,
  lastError: string,
  retryable: boolean,
): Promise<"pending" | "failed"> {
  return ctx.runMutation(internal.accountDeletion.sideEffects.recordExternalFailure, {
    deletionId, lastError, retryable,
  }).catch(() => "failed" as const);
}

function isRetryable(err: unknown): boolean {
  if (isTimeout(err)) return true;
  if (!err || typeof err !== "object") return false;
  const status = (err as { status?: unknown }).status;
  if (typeof status === "number") {
    return status === 408 || status === 429 || status >= 500;
  }
  return err instanceof TypeError || err instanceof APIConnectionError;
}

export const beginExternalAttempt = internalMutation({
  args: { deletionId: v.id("accountDeletions") },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.deletionId);
    if (!row || row.status !== "pending" || row.step !== "external") return false;
    if ((row.externalAttempts ?? 0) >= MAX_EXTERNAL_ATTEMPTS) {
      await ctx.db.patch(row._id, {
        status: "failed", lastError: "EXTERNAL_ATTEMPTS_EXHAUSTED", updatedAt: Date.now(),
      });
      return false;
    }
    await ctx.db.patch(row._id, {
      externalAttempts: (row.externalAttempts ?? 0) + 1, updatedAt: Date.now(),
    });
    return true;
  },
});

export const recordExternalFailure = internalMutation({
  args: {
    deletionId: v.id("accountDeletions"),
    lastError: v.string(),
    retryable: v.boolean(),
  },
  returns: v.union(v.literal("pending"), v.literal("failed")),
  handler: async (ctx, args): Promise<"pending" | "failed"> => {
    const row = await ctx.db.get(args.deletionId);
    if (!row || row.status !== "pending") return "failed";
    const attempts = row.externalAttempts ?? 0;
    const status = args.retryable && attempts < MAX_EXTERNAL_ATTEMPTS ? "pending" : "failed";
    await ctx.db.patch(row._id, { status, lastError: args.lastError, updatedAt: Date.now() });
    if (status === "pending") {
      await ctx.scheduler.runAfter(
        Math.min(RETRY_MAX_DELAY_MS, RETRY_BASE_DELAY_MS * 2 ** Math.max(0, attempts - 1)),
        internal.accountDeletion.sideEffects.runExternalErase,
        { deletionId: row._id },
      );
    } else {
      // sentry-coverage-ok: structured console.error is forwarded by Convex,
      // and this IS the alert. A terminal external failure — Dodo refusing to
      // cancel, a Redis outage, a Clerk API error, a missing provider
      // credential — otherwise only ever wrote a database field, so nobody
      // learned that a user's deletion had stopped with their subscription
      // still live. Re-throwing instead would lose the recorded status.
      console.error(JSON.stringify({
        breadcrumb: "account_deletion_external_failed",
        deletionId: args.deletionId,
        externalAttempts: attempts,
        lastError: args.lastError,
      }));
    }
    return status;
  },
});

export function buildDeletionDodoClientOptions(env: {
  DODO_API_KEY?: string;
  DODO_PAYMENTS_ENVIRONMENT?: string;
}): ConstructorParameters<typeof DodoPayments>[0] {
  if (!env.DODO_API_KEY) {
    throw new Error("DODO_API_KEY_MISSING");
  }
  const isLive = env.DODO_PAYMENTS_ENVIRONMENT === "live_mode";
  return {
    bearerToken: env.DODO_API_KEY,
    ...(isLive ? {} : { environment: "test_mode" as const }),
    maxRetries: 0,
    timeout: DODO_ATTEMPT_TIMEOUT_MS,
  };
}

function entitlementKey(userId: string): string {
  const envPrefix = process.env.DODO_PAYMENTS_ENVIRONMENT === "live_mode" ? "live" : "test";
  return `entitlements:${envPrefix}:${userId}`;
}

function isNotFound(err: unknown): boolean {
  if (err instanceof NotFoundError) return true;
  if (!err || typeof err !== "object") return false;
  const status = (err as { status?: unknown }).status;
  return status === 404;
}

function isTimeout(err: unknown): boolean {
  if (err instanceof APIConnectionTimeoutError) return true;
  if (err instanceof Error) {
    const name = err.name.toLowerCase();
    const message = err.message.toLowerCase();
    return (
      name.includes("timeout") ||
      name.includes("abort") ||
      message.includes("timeout") ||
      message.includes("timed out") ||
      message.includes("aborted")
    );
  }
  return false;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function cancelDodoSubscription(
  client: DodoPayments,
  dodoSubscriptionId: string,
): Promise<"cancelled" | "missing"> {
  try {
    await client.subscriptions.update(dodoSubscriptionId, { status: "cancelled" });
    return "cancelled";
  } catch (err) {
    if (isNotFound(err)) return "missing";
    throw err;
  }
}

async function redisCommand(
  pathAndQuery: string,
  init: RequestInit = {},
): Promise<Response> {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) {
    throw new Error("UPSTASH_REDIS_PAIR_INCOMPLETE");
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REDIS_FETCH_TIMEOUT_MS);
  try {
    return await fetch(`${url}${pathAndQuery}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "User-Agent": `${USER_AGENT} (redis)`,
        ...(init.headers ?? {}),
      },
      body: init.body,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
}

async function redisResult(response: Response, operation: string): Promise<unknown> {
  if (!response.ok) {
    throw new ProviderError(`REDIS_${operation}_FAILED:${response.status}`, response.status);
  }
  const body: unknown = await response.json();
  const results = Array.isArray(body) ? body : [body];
  if (results.length === 0 || results.some((result) =>
    !result || typeof result !== "object" || "error" in result || !("result" in result))) {
    throw new ProviderError(`REDIS_${operation}_INVALID_RESULT`);
  }
  return body;
}

/**
 * One pipelined round trip for the whole revocation set.
 *
 * Upstash counts its request-size cap per command, not per pipeline, and this
 * set is bounded by the account's own key/token counts, so batching is safe.
 *
 * The SETs go first. A pipeline runs its commands in order but is not a
 * transaction, and the alert-history marker has to exist before that history
 * is deleted: a relay write landing between a DEL and a later SET would bring
 * the history back.
 */
async function redisRevoke(
  delKeys: string[],
  setExEntries: Array<{ key: string; value: string; ttlSeconds: number }>,
): Promise<void> {
  const uniqueDels = mergeUniqueStrings([], delKeys);
  const commands: string[][] = [
    ...setExEntries.map(({ key, value, ttlSeconds }) => [
      "SET", key, value, "EX", String(ttlSeconds),
    ]),
    ...uniqueDels.map((key) => ["DEL", key]),
  ];
  if (commands.length === 0) return;
  const response = await redisCommand("/pipeline", {
    body: JSON.stringify(commands),
  });
  await redisResult(response, "REVOKE");
}

async function redisGetJson(key: string): Promise<unknown> {
  const response = await redisCommand(`/get/${encodeURIComponent(key)}`);
  const body = (await redisResult(response, "GET")) as { result?: unknown };
  const raw = body.result;
  if (typeof raw !== "string" || raw.length === 0) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

/** How long a digest compose can still see an erase; one compose run takes minutes. */
const BRIEF_ERASED_TTL_SECONDS = 86_400;

/** Bounds one account's slot index read; the writer trims it to the 7-day envelope TTL. */
const MAX_BRIEF_SLOTS = 1_000;

async function redisZrangeAll(key: string): Promise<string[]> {
  const response = await redisCommand(`/zrange/${encodeURIComponent(key)}/0/${MAX_BRIEF_SLOTS - 1}`);
  const body = (await redisResult(response, "ZRANGE")) as { result?: unknown };
  return Array.isArray(body.result)
    ? body.result.filter((slot): slot is string => typeof slot === "string" && slot.length > 0)
    : [];
}

async function deleteAccountRedisKeys(args: {
  userId: string;
  keyHashes: string[];
  embedKeyHashes: string[];
  mcpTokenIds: string[];
}): Promise<void> {
  const keys = [
    entitlementKey(args.userId),
    // Alerts delivered to the account (scripts/lib/sent-alert-history.cjs).
    `wm:notif:sent:v1:${args.userId}`,
    ...args.keyHashes.flatMap((hash) => [
      `user-api-key:${hash}`,
      `bootstrap-user-api-key-invalid:${hash}`,
    ]),
    ...args.embedKeyHashes.map((hash) => `embed-key:${hash}`),
  ];

  // Marked first (briefErasedKey in shared/brief-envelope.js): a digest compose
  // re-reads it after its envelope write, so a compose racing this erase
  // either sees it and removes its own brief or wrote a slot the reads below
  // find. It only has to outlive one compose run.
  await redisRevoke([], [{ key: `brief:erased:${args.userId}`, value: "1", ttlSeconds: BRIEF_ERASED_TTL_SECONDS }]);
  const latest = await redisGetJson(`brief:latest:${args.userId}`);
  const slot =
    latest && typeof latest === "object" && typeof (latest as { issueSlot?: unknown }).issueSlot === "string"
      ? (latest as { issueSlot: string }).issueSlot
      : typeof latest === "string"
        ? latest
        : null;
  // Every slot in the per-user index (briefSlotsKey in shared/brief-envelope.js),
  // plus the pointer's slot for briefs written before the index existed.
  const slotsKey = `brief:slots:${args.userId}`;
  const slots = mergeUniqueStrings(await redisZrangeAll(slotsKey), slot ? [slot] : []);
  for (const s of slots) {
    keys.push(`brief:${args.userId}:${s}`);
    // Localized sibling; source of truth is briefLocalizedKey in shared/brief-envelope.js.
    keys.push(`brief:l10n:${args.userId}:${s}`);
  }

  // Deletes, the alert-history marker and the MCP negative-cache sentinels go
  // in one pipeline. The sentinels used to be a per-token await, each its own
  // fetch with its own 5s budget, serialized inside the same action that still
  // has to reach Dodo and Clerk.
  await redisRevoke(
    keys,
    [
      { key: `wm:notif:sent-erased:v1:${args.userId}`, value: "1", ttlSeconds: SENT_ALERTS_ERASED_TTL_SECONDS },
      ...args.mcpTokenIds.map((tokenId) => ({
        key: `pro-mcp-token-neg:${tokenId}`,
        value: "1",
        ttlSeconds: MCP_NEG_CACHE_TTL_SECONDS,
      })),
    ],
  );
  // The index and pointer are how a retry finds the slots. Upstash runs every
  // command in a pipeline even after one fails, so they are deleted in a
  // separate request, only once every slot delete above has succeeded
  // (redisRevoke throws on any failed command).
  await redisRevoke([slotsKey, `brief:latest:${args.userId}`], []);
}

const MAX_BRIEF_SWEEP_PAGES = 1_000;

/**
 * The brief keys a compose writes for an account: envelopes and localized
 * siblings per slot, the slot index, and the latest pointer. The erase
 * tombstone is excluded: a compose still running reads it to remove its own
 * brief.
 */
function isAccountBriefKey(key: string, userId: string): boolean {
  if (key === `brief:slots:${userId}` || key === `brief:latest:${userId}`) return true;
  for (const prefix of [`brief:${userId}:`, `brief:l10n:${userId}:`]) {
    if (key.startsWith(prefix)) {
      const slot = key.slice(prefix.length);
      return slot.length > 0 && !slot.includes(":");
    }
  }
  return false;
}

/**
 * Bound both each action and the total shared-keyspace scan per sweep. One
 * pass matches every brief key shape for the account, so a full sweep costs
 * one keyspace scan (~580 pages at COUNT 1000 today), within the budget.
 */
export const sweepBriefEnvelopes = internalAction({
  args: {
    deletionId: v.id("accountDeletions"),
    cursor: v.string(),
    attempt: v.number(),
    pages: v.optional(v.number()),
    page: v.optional(v.object({ cursor: v.string(), keys: v.array(v.string()) })),
  },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    let page = args.page;
    try {
      const snapshot = await ctx.runQuery(internal.accountDeletion.erase.getExternalEraseSnapshot,
        { deletionId: args.deletionId });
      // Billing events can reopen an erased account's deletion. Its personal
      // data still needs cleanup even if cancellation is pending or failed.
      if (!snapshot) return null;
      const { userId } = snapshot;
      // Redis MATCH is a glob, not a literal. Escape identity characters; the
      // glob over-matches (brief:erased:, ids sharing a prefix), so every key
      // is checked against the exact account shapes before deleting.
      const pattern = `brief:*${userId.replace(/[\\*?\[\]]/g, "\\$&")}*`;
      if (!page) {
        const response = await redisCommand("", {
          body: JSON.stringify(["SCAN", args.cursor, "MATCH", pattern, "COUNT", "1000"]),
        });
        const body = await redisResult(response, "BRIEF_SCAN") as { result?: unknown };
        const result = body.result;
        if (!Array.isArray(result) || result.length !== 2 ||
            typeof result[0] !== "string" || !/^\d+$/.test(result[0]) ||
            !Array.isArray(result[1]) || !result[1].every((key: unknown) =>
              typeof key === "string" && key.startsWith("brief:") && key.includes(userId))) {
          throw new Error("REDIS_BRIEF_SCAN_INVALID_RESULT");
        }
        page = { cursor: result[0], keys: (result[1] as string[]).filter(key => isAccountBriefKey(key, userId)) };
      }
      if (!page.keys.every(key => isAccountBriefKey(key, userId))) {
        throw new Error("REDIS_BRIEF_PAGE_INVALID_KEYS");
      }
      const { keys, cursor } = page;
      // COUNT is a hint, so bound each delete request independently.
      for (let i = 0; i < keys.length; i += 100) {
        await redisRevoke(keys.slice(i, i + 100), []);
      }
      if (cursor !== "0") {
        const pages = (args.pages ?? 0) + 1;
        if (pages >= MAX_BRIEF_SWEEP_PAGES) {
          // sentry-coverage-ok: structured console.error is forwarded by Convex.
          // Include the next cursor so an operator can continue this sweep
          // with pages: 0 after checking Redis load, without rescanning.
          console.error(JSON.stringify({ breadcrumb: "account_deletion_brief_sweep_truncated",
            deletionId: args.deletionId, cursor, pages }));
          return null;
        }
        await ctx.scheduler.runAfter(0, internal.accountDeletion.sideEffects.sweepBriefEnvelopes, {
          deletionId: args.deletionId, cursor, attempt: 0, pages,
        });
      }
    } catch (err) {
      if (args.attempt + 1 < MAX_EXTERNAL_ATTEMPTS) {
        // SCAN may not return the same keys when a cursor is replayed. Keep
        // this page until every DEL succeeds; repeated deletes are safe.
        await ctx.scheduler.runAfter(
          Math.min(RETRY_MAX_DELAY_MS, RETRY_BASE_DELAY_MS * 2 ** args.attempt),
          internal.accountDeletion.sideEffects.sweepBriefEnvelopes,
          { ...args, ...(page ? { page } : {}), attempt: args.attempt + 1 },
        );
      } else {
        // sentry-coverage-ok: structured console.error is forwarded by Convex.
        console.error(JSON.stringify({ breadcrumb: "account_deletion_brief_sweep_failed",
          deletionId: args.deletionId, error: errorMessage(err) }));
        throw err;
      }
    }
    return null;
  },
});

async function deleteClerkUser(userId: string): Promise<"deleted" | "missing"> {
  const secret = process.env.CLERK_SECRET_KEY;
  if (!secret) {
    throw new Error("CLERK_SECRET_MISSING");
  }
  const response = await fetch(
    `https://api.clerk.com/v1/users/${encodeURIComponent(userId)}`,
    {
      method: "DELETE",
      headers: {
        Authorization: `Bearer ${secret}`,
        "User-Agent": USER_AGENT,
      },
      signal: AbortSignal.timeout(CLERK_FETCH_TIMEOUT_MS),
    },
  );
  if (response.status === 404) return "missing";
  if (!response.ok) {
    throw new ProviderError(`CLERK_DELETE_FAILED:${response.status}`, response.status);
  }
  return "deleted";
}

const runResultValidator = v.object({
  status: v.union(
    v.literal("pending"),
    v.literal("complete"),
    v.literal("already_deleted"),
    v.literal("failed"),
  ),
});

export const runExternalErase = internalAction({
  args: { deletionId: v.id("accountDeletions") },
  returns: runResultValidator,
  handler: async (ctx, args): Promise<{ status: "pending" | "complete" | "already_deleted" | "failed" }> => {
    // These two RPCs used to sit outside every try. An RPC-level throw here —
    // a transient Convex failure, an exhausted OCC retry, a stale internal.*
    // reference after a deploy — recorded no failure and scheduled nothing,
    // leaving the row at pending/external, indistinguishable from a healthy
    // in-progress deletion, with the fence on and the Clerk login still live.
    // Inferred from the query rather than hand-declared: a local mirror of the
    // validator's shape can drift from it silently, and there is no import
    // cycle to avoid here (nothing imports this module; it reaches erase.ts
    // through `internal.*`).
    let snapshot: Awaited<ReturnType<
      typeof ctx.runQuery<typeof internal.accountDeletion.erase.getExternalEraseSnapshot>
    >>;
    let started: boolean;
    try {
      snapshot = await ctx.runQuery(
        internal.accountDeletion.erase.getExternalEraseSnapshot,
        { deletionId: args.deletionId },
      );
      if (!snapshot) {
        return { status: "already_deleted" as const };
      }
      if (snapshot.status === "complete") {
        return { status: "already_deleted" as const };
      }
      if (snapshot.status === "failed") return { status: "failed" as const };
      if (snapshot.step !== "external") {
        return { status: "pending" as const };
      }
      started = await ctx.runMutation(internal.accountDeletion.sideEffects.beginExternalAttempt, args);
    } catch (err) {
      // No attempt was consumed and no provider was touched, so this is safe
      // to retry. Record it so the row carries a failure and a schedule
      // instead of silently stalling.
      // sentry-coverage-ok: structured console.error is forwarded by Convex,
      // and re-throwing would abandon the row at pending/external with no
      // failure recorded and nothing scheduled — the exact stall this catch
      // exists to close.
      console.error(JSON.stringify({
        breadcrumb: "account_deletion_external_setup_failed",
        deletionId: args.deletionId,
        error: errorMessage(err),
      }));
      const status = await recordFailureSafely(
        ctx, args.deletionId, `EXTERNAL_SETUP:${errorMessage(err)}`, true,
      );
      return { status };
    }
    if (!started) return { status: "failed" as const };

    let cancelled = [...snapshot.cancelledDodoSubscriptionIds];
    const remaining = snapshot.dodoSubscriptionIds.filter(
      (id) => !cancelled.includes(id),
    );

    try {
      if (remaining.length > 0) {
        const client = new DodoPayments(buildDeletionDodoClientOptions(process.env));
        for (const dodoSubscriptionId of remaining) {
          await cancelDodoSubscription(client, dodoSubscriptionId);
          cancelled = mergeUniqueStrings(cancelled, [dodoSubscriptionId]);
          await ctx.runMutation(internal.accountDeletion.erase.recordExternalProgress, {
            deletionId: args.deletionId,
            cancelledDodoSubscriptionIds: cancelled,
            lastError: null,
          });
        }
      }
    } catch (err) {
      let lastError = `${isTimeout(err) ? "DODO_TIMEOUT" : "DODO_CANCEL"}:${errorMessage(err)}`;
      let retryable = isRetryable(err);
      // Revoke cache-backed access even when billing cancellation is unavailable.
      try {
        await deleteAccountRedisKeys({
          userId: snapshot.userId,
          keyHashes: snapshot.keyHashes,
          embedKeyHashes: snapshot.embedKeyHashes,
          mcpTokenIds: snapshot.mcpTokenIds,
        });
        await ctx.runMutation(internal.accountDeletion.erase.recordExternalProgress, {
          deletionId: args.deletionId,
          cancelledDodoSubscriptionIds: cancelled,
          redisClearedAt: Date.now(),
        });
      } catch (redisErr) {
        lastError += `;REDIS:${errorMessage(redisErr)}`;
        retryable = retryable && isRetryable(redisErr);
      }
      const status = await recordFailureSafely(ctx, args.deletionId, lastError, retryable);
      return { status };
    }

    try {
      await deleteAccountRedisKeys({
        userId: snapshot.userId,
        keyHashes: snapshot.keyHashes,
        embedKeyHashes: snapshot.embedKeyHashes,
        mcpTokenIds: snapshot.mcpTokenIds,
      });
      await ctx.runMutation(internal.accountDeletion.erase.recordExternalProgress, {
        deletionId: args.deletionId,
        redisClearedAt: Date.now(),
        lastError: null,
      });
    } catch (err) {
      const status = await recordFailureSafely(
        ctx, args.deletionId, `REDIS:${errorMessage(err)}`, isRetryable(err),
      );
      return { status };
    }

    try {
      await deleteClerkUser(snapshot.userId);
      await ctx.runMutation(internal.accountDeletion.erase.recordExternalProgress, {
        deletionId: args.deletionId,
        clerkDeletedAt: Date.now(),
        lastError: null,
      });
    } catch (err) {
      const status = await recordFailureSafely(
        ctx, args.deletionId, `CLERK_DELETE:${errorMessage(err)}`, isRetryable(err),
      );
      return { status };
    }

    const result = await ctx.runMutation(internal.accountDeletion.erase.markExternalComplete, {
      deletionId: args.deletionId,
    });
    return { status: result.status === "already_deleted" ? "complete" as const : result.status };
  },
});
