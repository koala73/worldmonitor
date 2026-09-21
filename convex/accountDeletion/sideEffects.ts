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
import { internalAction, internalMutation } from "../_generated/server";
import { mergeUniqueStrings } from "./registry";

const REDIS_FETCH_TIMEOUT_MS = 5_000;
const CLERK_FETCH_TIMEOUT_MS = 8_000;
const DODO_ATTEMPT_TIMEOUT_MS = 8_000;
const MCP_NEG_CACHE_TTL_SECONDS = 60;
const USER_AGENT = "worldmonitor-convex/1.0";
const MAX_EXTERNAL_ATTEMPTS = 5;
const RETRY_BASE_DELAY_MS = 30_000;
const RETRY_MAX_DELAY_MS = 5 * 60_000;

class ProviderError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
  }
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

async function redisDel(keys: string[]): Promise<void> {
  if (keys.length === 0) return;
  const unique = mergeUniqueStrings([], keys);
  const commands = unique.map((key) => ["DEL", key]);
  const response = await redisCommand("/pipeline", {
    body: JSON.stringify(commands),
  });
  await redisResult(response, "DEL");
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

async function redisSetEx(key: string, value: string, ttlSeconds: number): Promise<void> {
  const response = await redisCommand(
    `/set/${encodeURIComponent(key)}/${encodeURIComponent(value)}/EX/${ttlSeconds}`,
  );
  await redisResult(response, "SET");
}

async function deleteAccountRedisKeys(args: {
  userId: string;
  keyHashes: string[];
  embedKeyHashes: string[];
  mcpTokenIds: string[];
}): Promise<void> {
  const keys = [
    entitlementKey(args.userId),
    `brief:latest:${args.userId}`,
    ...args.keyHashes.flatMap((hash) => [
      `user-api-key:${hash}`,
      `bootstrap-user-api-key-invalid:${hash}`,
    ]),
    ...args.embedKeyHashes.map((hash) => `embed-key:${hash}`),
  ];

  const latest = await redisGetJson(`brief:latest:${args.userId}`);
  const slot =
    latest && typeof latest === "object" && typeof (latest as { issueSlot?: unknown }).issueSlot === "string"
      ? (latest as { issueSlot: string }).issueSlot
      : typeof latest === "string"
        ? latest
        : null;
  if (slot) keys.push(`brief:${args.userId}:${slot}`);

  await redisDel(keys);

  for (const tokenId of args.mcpTokenIds) {
    await redisSetEx(`pro-mcp-token-neg:${tokenId}`, "1", MCP_NEG_CACHE_TTL_SECONDS);
  }
}

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
    const snapshot = await ctx.runQuery(
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
    const started = await ctx.runMutation(internal.accountDeletion.sideEffects.beginExternalAttempt, args);
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
      const status = await ctx.runMutation(internal.accountDeletion.sideEffects.recordExternalFailure, {
        deletionId: args.deletionId, lastError, retryable,
      });
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
      const status = await ctx.runMutation(internal.accountDeletion.sideEffects.recordExternalFailure, {
        deletionId: args.deletionId,
        lastError: `REDIS:${errorMessage(err)}`,
        retryable: isRetryable(err),
      });
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
      const status = await ctx.runMutation(internal.accountDeletion.sideEffects.recordExternalFailure, {
        deletionId: args.deletionId,
        lastError: `CLERK_DELETE:${errorMessage(err)}`,
        retryable: isRetryable(err),
      });
      return { status };
    }

    const result = await ctx.runMutation(internal.accountDeletion.erase.markExternalComplete, {
      deletionId: args.deletionId,
    });
    return { status: result.status === "already_deleted" ? "complete" as const : result.status };
  },
});
