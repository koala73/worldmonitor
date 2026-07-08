import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import { STORY_TRACK_KEY } from "../server/_shared/cache-keys.ts";
import { __resetKeyPrefixCacheForTests } from "../server/_shared/redis.ts";
import { __testing__ } from "../server/worldmonitor/news/v1/list-feed-digest.ts";

const originalFetch = globalThis.fetch;
const originalEnv = { ...process.env };

function restoreEnv(): void {
  for (const key of Object.keys(process.env)) {
    if (!(key in originalEnv)) delete process.env[key];
  }
  Object.assign(process.env, originalEnv);
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  restoreEnv();
  __resetKeyPrefixCacheForTests();
});

describe("news digest story tracking Redis key prefix parity", () => {
  it("reads story:track rows through the same preview key-prefix normalization as writes", async () => {
    const hash = "0123456789abcdef0123456789abcdef";
    const pipelineBodies: unknown[] = [];

    process.env.UPSTASH_REDIS_REST_URL = "https://redis.example";
    process.env.UPSTASH_REDIS_REST_TOKEN = "token";
    process.env.VERCEL_ENV = "preview";
    process.env.VERCEL_GIT_COMMIT_SHA = "deadbeefcafebabe";
    __resetKeyPrefixCacheForTests();

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      assert.equal(String(input), "https://redis.example/pipeline");
      pipelineBodies.push(JSON.parse(String(init?.body ?? "[]")));
      return new Response(JSON.stringify([
        { result: ["1000", "2000", "4", "2", "7", "9"] },
      ]), { status: 200 });
    }) as typeof fetch;

    const tracks = await __testing__.readStoryTracks([hash]);

    assert.equal(tracks.get(hash)?.mentionCount, 4);
    assert.deepEqual(pipelineBodies, [[
      [
        "HMGET",
        `preview:deadbeef:${STORY_TRACK_KEY(hash)}`,
        "firstSeen",
        "lastSeen",
        "mentionCount",
        "sourceCount",
        "currentScore",
        "peakScore",
      ],
    ]]);
  });
});
