// @vitest-environment node

// Translate mode is free, so the gateway may not resolve a Clerk session or
// set x-user-id for it. The handler's own identity resolution must still bind
// a restricted account to its AI routing policy.

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("../_shared/premium-check", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../_shared/premium-check")>();
  return {
    ...actual,
    resolvePremiumCallerIdentity: vi.fn(async () => ({
      isPremium: false,
      userId: "user_restricted_bearer",
      kind: "bearer",
    })),
  };
});

import { summarizeArticle } from "../worldmonitor/news/v1/summarize-article";

const originalFetch = globalThis.fetch;
const originalEnv = { ...process.env };

function restoreEnv() {
  for (const key of Object.keys(process.env)) {
    if (!(key in originalEnv)) delete process.env[key];
  }
  Object.assign(process.env, originalEnv);
}

const translateRequest = (provider: string) => ({
  provider,
  headlines: ["Senate passes sanctions package"],
  mode: "translate",
  geoContext: "",
  variant: "fr",
  lang: "en",
  systemAppend: "",
  bodies: [],
});

// No x-user-id: the gateway did not resolve this caller.
const ctx = () => ({
  request: new Request("https://www.worldmonitor.app/api/news/v1/summarize-article", {
    headers: { Authorization: "Bearer clerk-session-token" },
  }),
  pathParams: {},
  headers: {},
});

describe("summarize-article translate mode under an AI routing policy", () => {
  let hosts: string[];

  beforeEach(() => {
    restoreEnv();
    process.env.OPENROUTER_API_KEY = "test-openrouter-key";
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    process.env.CONVEX_SITE_URL = "https://convex.example.test";
    process.env.CONVEX_SERVER_SHARED_SECRET = "shared-test-secret";
    hosts = [];
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input instanceof Request ? input.url : input));
      if (url.host === "convex.example.test") {
        return new Response(JSON.stringify({ policy: { allowedProviders: ["anthropic"] } }), { status: 200 });
      }
      if (url.pathname === "/" || url.pathname === "") return new Response("", { status: 200 });
      hosts.push(url.host);
      if (url.host === "api.anthropic.com") {
        return new Response(JSON.stringify({
          id: "msg_1", type: "message", role: "assistant", model: "claude-opus-5-5",
          content: [{ type: "text", text: "Le Sénat adopte un paquet de sanctions." }],
          stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 10, output_tokens: 9 },
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify({
        choices: [{ message: { content: "openrouter text" }, finish_reason: "stop" }],
      }), { status: 200 });
    }) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    restoreEnv();
  });

  test("uses the handler-resolved identity when the gateway set no user id", async () => {
    const result = await summarizeArticle(ctx() as never, translateRequest("openrouter") as never);
    expect(result.status).toBe("SUMMARIZE_STATUS_SUCCESS");
    expect(result.provider).toBe("anthropic");
    expect(hosts).toEqual(["api.anthropic.com"]);
  });
});
