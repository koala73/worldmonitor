// @vitest-environment node

// systemAppend is premium-only free text that reaches the system prompt. It is
// bounded like geoContext so an oversized append cannot inflate the prompt or
// the sanitizer's work.

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("../_shared/premium-check", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../_shared/premium-check")>();
  return {
    ...actual,
    resolvePremiumCallerIdentity: vi.fn(async () => ({
      isPremium: true,
      userId: null,
      kind: "api-key",
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

const ctx = () => ({
  // No user identity: the default provider chain applies.
  request: new Request("https://www.worldmonitor.app/api/news/v1/summarize-article"),
  pathParams: {},
  headers: {},
});

const request = (systemAppend: string) => ({
  provider: "openrouter",
  headlines: ["Senate passes sanctions package", "Markets rally on rate cut"],
  mode: "brief",
  geoContext: "",
  variant: "full",
  lang: "en",
  systemAppend,
  bodies: [],
});

describe("summarize-article systemAppend bound", () => {
  let systemPrompts: string[];

  beforeEach(() => {
    restoreEnv();
    process.env.OPENROUTER_API_KEY = "test-openrouter-key";
    systemPrompts = [];
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input instanceof Request ? input.url : input));
      if (url.host === "openrouter.ai" && url.pathname === "/api/v1/chat/completions") {
        const body = JSON.parse(String(init?.body));
        const system = body.messages?.find((m: { role: string }) => m.role === "system");
        if (system) systemPrompts.push(String(system.content));
        return new Response(JSON.stringify({
          choices: [{ message: { content: "Sanctions advance while markets rally on the rate cut." }, finish_reason: "stop" }],
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      // Provider reachability probes hit the bare origin.
      return new Response("", { status: 200 });
    }) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    restoreEnv();
  });

  test("caps an oversized systemAppend before it reaches the system prompt", async () => {
    const result = await summarizeArticle(ctx() as never, request("q".repeat(50_000)) as never);
    expect(result.status, JSON.stringify(result)).toBe("SUMMARIZE_STATUS_SUCCESS");
    expect(systemPrompts).toHaveLength(1);
    const appended = systemPrompts[0]!.split("\n\n---\n\n").pop()!;
    expect(appended).toBe("q".repeat(2000));
  });

  test("passes a normal systemAppend through unchanged", async () => {
    const result = await summarizeArticle(ctx() as never, request("Use the PMESII framework.") as never);
    expect(result.status, JSON.stringify(result)).toBe("SUMMARIZE_STATUS_SUCCESS");
    expect(systemPrompts[0]).toContain("\n\n---\n\nUse the PMESII framework.");
  });
});
