// @vitest-environment node

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { __testing__ as llmHealth } from "../_shared/llm-health";
import { callLlm, getProviderCredentials } from "../_shared/llm";

const originalEnv = { ...process.env };

function restoreEnv() {
  for (const key of Object.keys(process.env)) {
    if (!(key in originalEnv)) delete process.env[key];
  }
  Object.assign(process.env, originalEnv);
}

const originalFetch = globalThis.fetch;

beforeEach(() => {
  llmHealth.reset();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  llmHealth.reset();
  restoreEnv();
});

describe("Atlas Cloud LLM provider credentials", () => {
  test("returns null when the API key is not configured", () => {
    delete process.env.ATLASCLOUD_API_KEY;

    expect(getProviderCredentials("atlascloud")).toBeNull();
  });

  test("builds OpenAI-compatible chat credentials with the default model", () => {
    process.env.ATLASCLOUD_API_KEY = "test-atlas-key";
    delete process.env.ATLASCLOUD_API_BASE;
    delete process.env.ATLASCLOUD_MODEL;

    const credentials = getProviderCredentials("atlascloud");

    expect(credentials).toMatchObject({
      apiUrl: "https://api.atlascloud.ai/v1/chat/completions",
      model: "qwen/qwen3.5-flash",
      headers: {
        Authorization: "Bearer test-atlas-key",
        "Content-Type": "application/json",
      },
    });
  });

  test("honors model and base URL overrides", () => {
    process.env.ATLASCLOUD_API_KEY = "test-atlas-key";
    process.env.ATLASCLOUD_API_BASE = "https://proxy.example.test/custom/v1/";
    process.env.ATLASCLOUD_MODEL = "qwen/custom-model";

    const credentials = getProviderCredentials("atlascloud");

    expect(credentials?.apiUrl).toBe("https://proxy.example.test/custom/v1/chat/completions");
    expect(credentials?.model).toBe("qwen/custom-model");
  });

  test("defaults reasoning profile calls to the Atlas Cloud reasoning model", () => {
    process.env.ATLASCLOUD_API_KEY = "test-atlas-key";
    delete process.env.ATLASCLOUD_MODEL;

    const credentials = getProviderCredentials("atlascloud", { enableReasoning: true });

    expect(credentials?.model).toBe("deepseek-ai/deepseek-v4-pro");
  });
});

describe("Atlas Cloud base URL validation", () => {
  test.each(["api.atlascloud.ai/v1", "ftp://api.atlascloud.ai/v1", "not a url"])(
    "rejects %s without throwing",
    (base) => {
      process.env.ATLASCLOUD_API_KEY = "test-atlas-key";
      process.env.ATLASCLOUD_API_BASE = base;

      expect(getProviderCredentials("atlascloud")).toBeNull();
    },
  );

  test("accepts an absolute https base", () => {
    process.env.ATLASCLOUD_API_KEY = "test-atlas-key";
    process.env.ATLASCLOUD_API_BASE = "https://gateway.example.com/v1/";

    expect(getProviderCredentials("atlascloud")?.apiUrl).toBe(
      "https://gateway.example.com/v1/chat/completions",
    );
  });
});

describe("Atlas Cloud fallback budget", () => {
  test("a stalled Atlas attempt leaves time for the next independent provider", async () => {
    process.env.ATLASCLOUD_API_KEY = "test-atlas-key";
    delete process.env.ATLASCLOUD_API_BASE;
    process.env.OPENROUTER_API_KEY = "or-test-key";
    const posted: string[] = [];

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if ((init?.method || "GET") === "GET") return new Response("", { status: 200 });
      posted.push(url);
      if (url.includes("atlascloud.ai")) {
        return new Promise<Response>((_, reject) => {
          init?.signal?.addEventListener("abort", () => {
            const err = new Error("aborted");
            err.name = "AbortError";
            reject(err);
          });
        });
      }
      return new Response(JSON.stringify({
        choices: [{ message: { content: "The fallback provider answered inside the budget." } }],
        usage: { total_tokens: 9 },
      }), { status: 200 });
    }) as typeof fetch;

    const result = await callLlm({
      messages: [{ role: "user", content: "Summarize the headline." }],
      providerOrder: ["atlascloud", "openrouter"],
      timeoutMs: 6_500,
    });

    expect(result?.provider).toBe("openrouter");
    expect(posted.some((url) => url.includes("atlascloud.ai"))).toBe(true);
    expect(posted.some((url) => url.includes("openrouter.ai"))).toBe(true);
  }, 15_000);
});
