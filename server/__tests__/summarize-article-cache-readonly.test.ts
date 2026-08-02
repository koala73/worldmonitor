// @vitest-environment node

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const getCachedJson = vi.fn();
vi.mock("../_shared/redis", () => ({
  getCachedJson: (...a: unknown[]) => getCachedJson(...a),
}));

import { getSummarizeArticleCache } from "../worldmonitor/news/v1/get-summarize-article-cache";
import { CACHE_VERSION } from "../../src/utils/summary-cache-key";

const originalFetch = globalThis.fetch;

// Derive from CACHE_VERSION rather than hardcoding a version: the handler now
// serves only the current namespace, so a literal would silently turn every
// assertion below into a namespace-rejection miss on the next bump.
const CURRENT_KEY = `summary:${CACHE_VERSION}:test-key`;
const RETIRED_KEY = "summary:v1:test-key";

function makeContext() {
  return {
    request: new Request(`https://www.worldmonitor.app/api/news/v1/summarize-article-cache?cache_key=${CURRENT_KEY}`),
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
      cacheKey: CURRENT_KEY,
    });

    expect(result).toMatchObject({
      summary: "Cached brief",
      model: "llama",
      provider: "cache",
      tokens: 0,
      fallback: false,
      status: "SUMMARIZE_STATUS_CACHED",
    });
    expect(getCachedJson).toHaveBeenCalledWith(CURRENT_KEY);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  test("returns an empty miss without calling provider fetch", async () => {
    getCachedJson.mockResolvedValue(null);

    const result = await getSummarizeArticleCache(makeContext(), {
      cacheKey: CURRENT_KEY,
    });

    expect(result).toMatchObject({
      summary: "",
      provider: "",
      fallback: true,
      status: "SUMMARIZE_STATUS_UNSPECIFIED",
    });
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  test("a retired cache version is a clean miss and never reaches Redis (#5969)", async () => {
    // A stale browser bundle keeps minting keys for the previous namespace.
    // Serving those rows would defeat the CACHE_VERSION bump, which exists
    // precisely because old rows were built under different selection rules.
    getCachedJson.mockResolvedValue({ summary: "Stale brief", model: "llama", tokens: 123 });

    const result = await getSummarizeArticleCache(makeContext(), {
      cacheKey: RETIRED_KEY,
    });

    expect(result).toMatchObject({
      summary: "",
      provider: "",
      fallback: true,
      status: "SUMMARIZE_STATUS_UNSPECIFIED",
    });
    // A retired version is a miss, not a validation error, and must short
    // circuit before the lookup rather than fetching and discarding.
    expect(result.errorType).toBe("");
    expect(getCachedJson).not.toHaveBeenCalled();
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});
