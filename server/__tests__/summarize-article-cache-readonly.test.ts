// @vitest-environment node

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const getCachedJson = vi.fn();
vi.mock("../_shared/redis", () => ({
  getCachedJson: (...a: unknown[]) => getCachedJson(...a),
}));

import { getSummarizeArticleCache } from "../worldmonitor/news/v1/get-summarize-article-cache";

const originalFetch = globalThis.fetch;

function makeContext() {
  return {
    request: new Request("https://www.worldmonitor.app/api/news/v1/summarize-article-cache?cache_key=summary:v1:test-key"),
    pathParams: {},
    headers: {},
  };
}

beforeEach(() => {
  getCachedJson.mockReset();
  globalThis.fetch = vi.fn(async () => {
    throw new Error("cache lookup must not call providers");
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("summarize-article-cache read-only behavior", () => {
  test("returns cached summaries without calling provider fetch", async () => {
    getCachedJson.mockResolvedValue({ summary: "Cached brief", model: "llama", tokens: 123 });

    const result = await getSummarizeArticleCache(makeContext(), {
      cacheKey: "summary:v1:test-key",
    });

    expect(result).toMatchObject({
      summary: "Cached brief",
      model: "llama",
      provider: "cache",
      tokens: 0,
      fallback: false,
      status: "SUMMARIZE_STATUS_CACHED",
    });
    expect(getCachedJson).toHaveBeenCalledWith("summary:v1:test-key");
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  test("returns an empty miss without calling provider fetch", async () => {
    getCachedJson.mockResolvedValue(null);

    const result = await getSummarizeArticleCache(makeContext(), {
      cacheKey: "summary:v1:test-key",
    });

    expect(result).toMatchObject({
      summary: "",
      provider: "",
      fallback: true,
      status: "SUMMARIZE_STATUS_UNSPECIFIED",
    });
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});
