/**
 * The CII build reads the derived `wildfire:fires-summary:v1` instead of the
 * multi-MB canonical key (#9509). While the summary is absent (deploy window,
 * or an extra-key write that failed after the canonical publish) it recomputes
 * the same projection from the canonical key; a present-but-malformed summary
 * is reported unusable rather than silently masked by that fallback.
 */
import { strict as assert } from 'node:assert';
import { after, beforeEach, describe, it } from 'node:test';

const originalEnv = { ...process.env };
const originalFetch = globalThis.fetch;
const originalConsoleError = console.error;
const UPSTASH = 'https://upstash.test';

process.env.UPSTASH_REDIS_REST_URL = UPSTASH;
process.env.UPSTASH_REDIS_REST_TOKEN = 'upstash-token';
delete process.env.VERCEL_ENV;
delete process.env.LOCAL_API_MODE;
delete process.env.ACLED_ACCESS_TOKEN;
delete process.env.ACLED_EMAIL;
delete process.env.ACLED_PASSWORD;

const { getRiskScores } = await import('../server/worldmonitor/intelligence/v1/get-risk-scores');
const { __clearLocalUnavailableBackoffForTests } = await import('../server/_shared/redis');
const { summarizeWildfireDetections, WILDFIRE_FIRES_SUMMARY_KEY } = await import('../scripts/shared/wildfire-fires-summary.mjs');

const CANONICAL_KEY = 'wildfire:fires:v1';
const SEED_META_KEY = 'seed-meta:intelligence:risk-scores';

let writes: Array<{ key: string; value: string }> = [];
let gets: string[] = [];

function stubRedis({ failing = [] as string[], stored = {} as Record<string, string> } = {}): void {
  const failingKeys = new Set(failing);
  writes = [];
  gets = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    if (url.origin !== UPSTASH) throw new Error(`unexpected fetch: ${url}`);
    if (url.pathname.startsWith('/get/')) {
      const key = decodeURIComponent(url.pathname.slice('/get/'.length));
      gets.push(key);
      if (failingKeys.has(key)) throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
      return Response.json({ result: stored[key] ?? null });
    }
    const body = JSON.parse(String(init.body ?? '[]'));
    const commands: unknown[][] = Array.isArray(body[0]) ? body : [body];
    for (const command of commands) {
      if (command[0] === 'SET') writes.push({ key: String(command[1]), value: String(command[2]) });
    }
    return Response.json(Array.isArray(body[0]) ? commands.map(() => ({ result: 'OK' })) : { result: 'OK' });
  }) as typeof fetch;
}

const envelope = (data: unknown) => JSON.stringify({ _seed: { fetchedAt: Date.now(), recordCount: 1 }, data });

const canonicalPayload = () => ({
  fireDetections: [
    { id: 'bright', location: { latitude: 39, longitude: -98 }, brightness: 400, frp: 60, detectedAt: Date.now() - 60_000, source: 'firms' },
    { id: 'dim', location: { latitude: 39.5, longitude: -98.5 }, brightness: 300, frp: 5, detectedAt: Date.now() - 60_000, source: 'firms' },
    { id: 'offshore', location: { latitude: 0, longitude: -160 }, brightness: 500, frp: 90, detectedAt: Date.now() - 60_000, source: 'firms' },
  ],
  _firmsState: 'ok',
  _firmsPartial: false,
  _firmsCount: 3,
});

const usScore = async () => (await getRiskScores({} as never, {} as never)).ciiScores.find((score) => score.region === 'US')!.combinedScore;
const firesInput = () => {
  const meta = writes.find((write) => write.key === SEED_META_KEY);
  assert.ok(meta, 'the build must stamp its seed-meta');
  return (JSON.parse(meta.value) as { inputs: Record<string, { state: string }> }).inputs.fires;
};

beforeEach(() => {
  __clearLocalUnavailableBackoffForTests();
  console.error = () => {};
});
after(() => {
  globalThis.fetch = originalFetch;
  console.error = originalConsoleError;
  process.env = originalEnv;
});

describe('CII fires input from the summary key', () => {
  it('scores from the summary and never reads the canonical key while the summary is present', async () => {
    stubRedis();
    const withoutFires = await usScore();

    stubRedis({ stored: { [WILDFIRE_FIRES_SUMMARY_KEY]: envelope(summarizeWildfireDetections(canonicalPayload())) } });
    const withFires = await usScore();
    assert.ok(withFires > withoutFires, `US must score the two detections inside its borders (${withFires} vs ${withoutFires})`);
    assert.equal(firesInput().state, 'live');
    assert.ok(gets.includes(WILDFIRE_FIRES_SUMMARY_KEY));
    assert.ok(!gets.includes(CANONICAL_KEY), 'the 2 MB canonical key stays off the hot path');
  });

  it('recomputes the same scores from the canonical key only while the summary is absent', async () => {
    stubRedis({ stored: { [WILDFIRE_FIRES_SUMMARY_KEY]: envelope(summarizeWildfireDetections(canonicalPayload())) } });
    const fromSummary = await usScore();

    stubRedis({ stored: { [CANONICAL_KEY]: envelope(canonicalPayload()) } });
    const fromCanonical = await usScore();
    assert.equal(fromCanonical, fromSummary);
    assert.equal(firesInput().state, 'live');
    assert.ok(gets.includes(CANONICAL_KEY), 'the fallback read happens');
  });

  it('reports fires missing when neither key exists', async () => {
    stubRedis();
    await usScore();
    assert.equal(firesInput().state, 'missing');
    assert.ok(gets.includes(WILDFIRE_FIRES_SUMMARY_KEY));
    assert.ok(gets.includes(CANONICAL_KEY));
  });

  it('reports a malformed summary unusable instead of masking it with the canonical fallback', async () => {
    stubRedis({
      stored: {
        [WILDFIRE_FIRES_SUMMARY_KEY]: envelope({ fireDetections: [] }),
        [CANONICAL_KEY]: envelope(canonicalPayload()),
      },
    });
    await usScore();
    assert.equal(firesInput().state, 'unusable');
    assert.ok(!gets.includes(CANONICAL_KEY));
  });

  it('reports a canonical payload that cannot be summarized as unusable, not missing', async () => {
    stubRedis({ stored: { [CANONICAL_KEY]: envelope({ fires: [] }) } });
    await usScore();
    assert.equal(firesInput().state, 'unusable');
  });

  it('rejects the build when the summary read itself fails', async () => {
    stubRedis({ failing: [WILDFIRE_FIRES_SUMMARY_KEY] });
    await getRiskScores({} as never, {} as never);
    assert.ok(!writes.some((write) => write.key === SEED_META_KEY), 'a failed read must not publish');
    assert.ok(!gets.includes(CANONICAL_KEY), 'a read error is not a miss');
  });
});
