import { anyApi, httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import { internal } from "./_generated/api";

const TRUSTED = [
  "https://worldmonitor.app",
  "*.worldmonitor.app",
  "http://localhost:3000",
];

function matchOrigin(origin: string, pattern: string): boolean {
  if (pattern.startsWith("*.")) {
    return origin.endsWith(pattern.slice(1));
  }
  return origin === pattern;
}

function allowedOrigin(origin: string | null, trusted: string[]): string | null {
  if (!origin) return null;
  return trusted.some((p) => matchOrigin(origin, p)) ? origin : null;
}

function corsHeaders(origin: string | null): Headers {
  const headers = new Headers();
  const allowed = allowedOrigin(origin, TRUSTED);
  if (allowed) {
    headers.set("Access-Control-Allow-Origin", allowed);
    headers.set("Access-Control-Allow-Methods", "POST, OPTIONS");
    headers.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
    headers.set("Access-Control-Max-Age", "86400");
  }
  return headers;
}

async function timingSafeEqualStrings(a: string, b: string): Promise<boolean> {
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.generateKey(
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const [sigA, sigB] = await Promise.all([
    crypto.subtle.sign("HMAC", keyMaterial, enc.encode(a)),
    crypto.subtle.sign("HMAC", keyMaterial, enc.encode(b)),
  ]);
  const aArr = new Uint8Array(sigA);
  const bArr = new Uint8Array(sigB);
  let diff = 0;
  for (let i = 0; i < aArr.length; i++) diff |= aArr[i] ^ bArr[i];
  return diff === 0;
}

const http = httpRouter();

http.route({
  path: "/api/user-prefs",
  method: "OPTIONS",
  handler: httpAction(async (_ctx, request) => {
    const headers = corsHeaders(request.headers.get("Origin"));
    return new Response(null, { status: 204, headers });
  }),
});

http.route({
  path: "/api/user-prefs",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const headers = corsHeaders(request.headers.get("Origin"));
    headers.set("Content-Type", "application/json");

    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      return new Response(JSON.stringify({ error: "UNAUTHENTICATED" }), {
        status: 401,
        headers,
      });
    }

    let body: {
      variant?: string;
      data?: unknown;
      expectedSyncVersion?: number;
      schemaVersion?: number;
    };
    try {
      body = await request.json() as typeof body;
    } catch {
      return new Response(JSON.stringify({ error: "INVALID_JSON" }), {
        status: 400,
        headers,
      });
    }

    if (
      typeof body.variant !== "string" ||
      body.data === undefined ||
      typeof body.expectedSyncVersion !== "number"
    ) {
      return new Response(JSON.stringify({ error: "MISSING_FIELDS" }), {
        status: 400,
        headers,
      });
    }

    try {
      const result = await ctx.runMutation(
        anyApi.userPreferences.setPreferences,
        {
          variant: body.variant,
          data: body.data,
          expectedSyncVersion: body.expectedSyncVersion,
          schemaVersion: body.schemaVersion,
        },
      );
      return new Response(JSON.stringify(result), { status: 200, headers });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("CONFLICT")) {
        return new Response(JSON.stringify({ error: "CONFLICT" }), {
          status: 409,
          headers,
        });
      }
      if (msg.includes("BLOB_TOO_LARGE")) {
        return new Response(JSON.stringify({ error: "BLOB_TOO_LARGE" }), {
          status: 400,
          headers,
        });
      }
      throw err;
    }
  }),
});

http.route({
  path: "/api/telegram-pair-callback",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    // Always return 200 — non-200 triggers Telegram retry storm
    const secret = process.env.TELEGRAM_WEBHOOK_SECRET ?? "";
    const provided =
      request.headers.get("X-Telegram-Bot-Api-Secret-Token") ?? "";

    if (!secret || !(await timingSafeEqualStrings(provided, secret))) {
      return new Response("OK", { status: 200 });
    }

    let update: {
      message?: {
        chat?: { type?: string; id?: number };
        text?: string;
        date?: number;
      };
    };
    try {
      update = await request.json() as typeof update;
    } catch {
      return new Response("OK", { status: 200 });
    }

    const msg = update.message;
    if (!msg) return new Response("OK", { status: 200 });

    if (msg.chat?.type !== "private") return new Response("OK", { status: 200 });

    if (!msg.date || Math.abs(Date.now() / 1000 - msg.date) > 900) {
      return new Response("OK", { status: 200 });
    }

    const text = msg.text?.trim() ?? "";
    const chatId = String(msg.chat.id);

    const match = text.match(/^\/start\s+([A-Za-z0-9_-]{40,50})$/);
    if (!match) return new Response("OK", { status: 200 });

    await ctx.runMutation(anyApi.notificationChannels.claimPairingToken, {
      token: match[1],
      chatId,
    });

    return new Response("OK", { status: 200 });
  }),
});

http.route({
  path: "/relay/deactivate",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const secret = process.env.RELAY_SHARED_SECRET ?? "";
    const provided = (request.headers.get("Authorization") ?? "").replace(/^Bearer\s+/, "");

    if (!secret || !(await timingSafeEqualStrings(provided, secret))) {
      return new Response(JSON.stringify({ error: "UNAUTHORIZED" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    }

    let body: { userId?: string; channelType?: string };
    try {
      body = await request.json() as typeof body;
    } catch {
      return new Response(JSON.stringify({ error: "INVALID_JSON" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (
      typeof body.userId !== "string" || !body.userId ||
      (body.channelType !== "telegram" && body.channelType !== "slack" && body.channelType !== "email")
    ) {
      return new Response(JSON.stringify({ error: "MISSING_FIELDS" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    await ctx.runMutation(internal.notificationChannels.deactivateChannelForUser, {
      userId: body.userId,
      channelType: body.channelType,
    });

    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }),
});

http.route({
  path: "/relay/channels",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const secret = process.env.RELAY_SHARED_SECRET ?? "";
    const provided = (request.headers.get("Authorization") ?? "").replace(/^Bearer\s+/, "");

    if (!secret || !(await timingSafeEqualStrings(provided, secret))) {
      return new Response(JSON.stringify({ error: "UNAUTHORIZED" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    }

    let body: { userId?: string };
    try {
      body = await request.json() as typeof body;
    } catch {
      return new Response(JSON.stringify({ error: "INVALID_JSON" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (typeof body.userId !== "string" || !body.userId) {
      return new Response(JSON.stringify({ error: "MISSING_USER_ID" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    const channels = await ctx.runQuery(internal.notificationChannels.getChannelsByUserId, {
      userId: body.userId,
    });

    return new Response(JSON.stringify(channels ?? []), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }),
});

export default http;
