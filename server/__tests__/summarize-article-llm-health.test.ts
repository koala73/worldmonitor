// @vitest-environment node

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { __testing__ as llmHealth, isModelUsable } from "../_shared/llm-health";
import { summarizeArticle } from "../worldmonitor/news/v1/summarize-article";

const originalFetch = globalThis.fetch;
const originalEnv = { ...process.env };

function restoreEnv() {
  for (const key of Object.keys(process.env)) {
    if (!(key in originalEnv)) delete process.env[key];
  }
  Object.assign(process.env, originalEnv);
}

function makeContext() {
  const headers = { "X-WorldMonitor-Key": "enterprise-test-key" };
  return {
    request: new Request("https://www.worldmonitor.app/api/news/v1/summarize-article", { headers }),
    pathParams: {},
    headers,
  };
}

function request(provider: "openrouter" | "groq", headline: string) {
  return {
    provider,
    headlines: [headline],
    mode: "brief",
    geoContext: "",
    variant: "full",
    lang: "en",
    systemAppend: "",
    bodies: [],
  };
}

beforeEach(() => {
  restoreEnv();
  llmHealth.reset();
  process.env.OPENROUTER_API_KEY = "or-test-key";
  process.env.GROQ_API_KEY = "groq-test-key";
  process.env.WORLDMONITOR_VALID_KEYS = "enterprise-test-key";
  process.env.UPSTASH_REDIS_REST_URL = "https://redis.test";
  process.env.UPSTASH_REDIS_REST_TOKEN = "redis-token";
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  llmHealth.reset();
  restoreEnv();
});

describe("summarizeArticle model health fallback", () => {
  test("a quarantined provider does not poison the provider-independent summary cache", async () => {
    const redis = new Map<string, string>();
    const providerPosts: string[] = [];
    let redisSetCount = 0;

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const method = init?.method || "GET";

      if (url.startsWith("https://redis.test/get/")) {
        const key = decodeURIComponent(url.slice("https://redis.test/get/".length));
        return new Response(JSON.stringify({ result: redis.get(key) ?? null }), { status: 200 });
      }

      if (url === "https://redis.test/" && method === "POST") {
        const command = JSON.parse(String(init?.body || "[]")) as string[];
        expect(command[0]).toBe("SET");
        redis.set(command[1], command[2]);
        redisSetCount += 1;
        return new Response(JSON.stringify({ result: "OK" }), { status: 200 });
      }

      if (method === "GET") return new Response("", { status: 200 });

      if (url.includes("/chat/completions")) {
        providerPosts.push(url);
        const body = JSON.parse(String(init?.body || "{}")) as { model?: string };
        if (url.includes("openrouter.ai")) {
          return new Response(JSON.stringify({
            error: { message: `${body.model} is not a valid model ID` },
          }), { status: 400 });
        }
        return new Response(JSON.stringify({
          choices: [{ message: { content: "Groq provides a healthy fallback summary for this headline." } }],
          usage: { total_tokens: 9 },
        }), { status: 200 });
      }

      return new Response(JSON.stringify({ result: "OK" }), { status: 200 });
    }) as typeof fetch;

    for (const headline of ["First rejected model request", "Second rejected model request"]) {
      const rejected = await summarizeArticle(makeContext(), request("openrouter", headline));
      expect(rejected.status).toBe("SUMMARIZE_STATUS_ERROR");

      const immediateFallback = await summarizeArticle(makeContext(), request("groq", headline));
      expect(immediateFallback).toMatchObject({
        summary: "Groq provides a healthy fallback summary for this headline.",
        provider: "groq",
        status: "SUMMARIZE_STATUS_SUCCESS",
      });
    }

    const sharedHeadline = "Fallback after model quarantine";
    const setsBeforeQuarantineSkip = redisSetCount;
    const quarantined = await summarizeArticle(makeContext(), request("openrouter", sharedHeadline));
    expect(quarantined.status).toBe("SUMMARIZE_STATUS_ERROR");
    expect(redisSetCount).toBe(
      setsBeforeQuarantineSkip,
      "skipping a quarantined provider must not write a negative cache sentinel",
    );

    const fallback = await summarizeArticle(makeContext(), request("groq", sharedHeadline));
    expect(fallback).toMatchObject({
      summary: "Groq provides a healthy fallback summary for this headline.",
      provider: "groq",
      fallback: false,
      status: "SUMMARIZE_STATUS_SUCCESS",
    });
    expect(providerPosts.filter(url => url.includes("openrouter.ai"))).toHaveLength(2);
    expect(providerPosts.filter(url => url.includes("api.groq.com"))).toHaveLength(3);
  });

  test("an accepted but invalid summary resets the rejection streak", async () => {
    const redis = new Map<string, string>();
    let providerPostCount = 0;

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const method = init?.method || "GET";

      if (url.startsWith("https://redis.test/get/")) {
        const key = decodeURIComponent(url.slice("https://redis.test/get/".length));
        return new Response(JSON.stringify({ result: redis.get(key) ?? null }), { status: 200 });
      }
      if (url === "https://redis.test/" && method === "POST") {
        const command = JSON.parse(String(init?.body || "[]")) as string[];
        redis.set(command[1], command[2]);
        return new Response(JSON.stringify({ result: "OK" }), { status: 200 });
      }
      if (method === "GET") return new Response("", { status: 200 });
      if (!url.includes("openrouter.ai")) {
        return new Response(JSON.stringify({ result: "OK" }), { status: 200 });
      }

      providerPostCount += 1;
      const body = JSON.parse(String(init?.body || "{}")) as { model?: string };
      if (providerPostCount === 2) {
        return new Response(JSON.stringify({
          choices: [{ message: { content: "too short" } }],
          usage: { total_tokens: 2 },
        }), { status: 200 });
      }
      return new Response(JSON.stringify({
        error: { message: `${body.model} is not a valid model ID` },
      }), { status: 400 });
    }) as typeof fetch;

    for (const headline of ["first rejection", "accepted invalid output", "second rejection"]) {
      await summarizeArticle(makeContext(), request("openrouter", headline));
    }

    expect(providerPostCount).toBe(3);
    expect(isModelUsable(
      "https://openrouter.ai/api/v1/chat/completions",
      "deepseek/deepseek-v4-flash",
    )).toBe(true);
  });
});
