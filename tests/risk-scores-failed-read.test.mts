/**
 * 2026-09-29 15:16Z: one risk-scores build read every signal-family input as
 * null while all of them were fresh in Redis. getCachedJson turns a Redis
 * error into the same null as a missing key, so the build published as fresh:
 * live cache, stale fallback, CII trend snapshot, and seed-meta recordCount 0
 * (health CRIT EMPTY_DATA). A failed read must never publish; a genuine miss
 * still does.
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

const { getRiskScores, getCiiTrendPriorCandidateBuckets } = await import('../server/worldmonitor/intelligence/v1/get-risk-scores');
const { CII_FORMULA_VERSION } = await import('../server/worldmonitor/intelligence/v1/_risk-config');
const { __clearLocalUnavailableBackoffForTests } = await import('../server/_shared/redis');

const SIGNAL_FAMILY_KEYS = [
  'conflict:ucdp-events:v1',
  'news:insights:v1',
  'news:threat:summary:v1',
  'cyber:threats-bootstrap:v2',
];
const LIVE_KEY = `risk:scores:sebuf:${CII_FORMULA_VERSION}`;
const STALE_KEY = `risk:scores:sebuf:stale:${CII_FORMULA_VERSION}`;
const REJECTED_KEY = `risk:scores:sebuf:rejected:${CII_FORMULA_VERSION}`;
const SEED_META_KEY = 'seed-meta:intelligence:risk-scores';
const NEG_SENTINEL = '__WM_NEG__';
const currentYear = new Date().getFullYear();
const DISPLACEMENT_CURRENT_KEY = `displacement:summary:v1:${currentYear}`;
const DISPLACEMENT_PREVIOUS_KEY = `displacement:summary:v1:${currentYear - 1}`;

let writes: Array<{ key: string; value: string }> = [];
let gets: string[] = [];
let errorLogs: string[] = [];

interface RedisStub {
  /** Keys whose GET rejects with a fetch timeout. */
  failing?: Iterable<string>;
  /** Raw Upstash `result` strings by key; anything absent is a miss. */
  stored?: Record<string, string>;
}

function stubRedis({ failing = [], stored = {} }: RedisStub = {}): void {
  const failingKeys = new Set(failing);
  writes = [];
  gets = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.startsWith(`${UPSTASH}/get/`)) {
      const key = decodeURIComponent(url.slice(`${UPSTASH}/get/`.length));
      gets.push(key);
      if (failingKeys.has(key)) throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
      return Response.json({ result: stored[key] ?? null });
    }
    if (url.startsWith(UPSTASH)) {
      const body = JSON.parse(String(init.body ?? '[]'));
      const commands: unknown[][] = Array.isArray(body[0]) ? body : [body];
      for (const command of commands) {
        if (command[0] === 'SET') writes.push({ key: String(command[1]), value: String(command[2]) });
      }
      return Response.json(Array.isArray(body[0]) ? commands.map(() => ({ result: 'OK' })) : { result: 'OK' });
    }
    throw new Error(`unexpected fetch: ${url}`);
  }) as typeof fetch;
}

const stalePayload = {
  ciiScores: [{ region: 'ZZ', score: 77, level: 'high', trend: 'stable', components: {}, computedAt: 1 }],
  strategicRisks: [],
  degraded: false,
  stale: false,
};

const writtenKeys = () => writes.map((write) => write.key);
const published = () => writtenKeys().filter((key) => (
  (key.startsWith('risk:scores:sebuf') && key !== REJECTED_KEY) || key === SEED_META_KEY
));
const rejectionRecord = () => writes.filter((write) => write.key === REJECTED_KEY);

beforeEach(() => {
  writes = [];
  gets = [];
  errorLogs = [];
  __clearLocalUnavailableBackoffForTests();
  console.error = (...args: unknown[]) => {
    errorLogs.push(args.map((arg) => (typeof arg === 'string' ? arg : JSON.stringify(arg))).join(' '));
  };
});
after(() => {
  globalThis.fetch = originalFetch;
  console.error = originalConsoleError;
  process.env = originalEnv;
});

describe('risk-scores build with failed Redis reads', () => {
  it('publishes nothing when the signal-family reads error', async () => {
    stubRedis({ failing: SIGNAL_FAMILY_KEYS });
    await getRiskScores({} as never, {} as never);
    assert.deepEqual(published(), [], 'a build computed from failed reads must not reach any cache or seed-meta');
  });

  it('still publishes a build whose inputs are genuinely absent', async () => {
    stubRedis();
    await getRiskScores({} as never, {} as never);
    assert.ok(published().includes(SEED_META_KEY), 'a real empty build still stamps seed-meta');
  });

  it('publishes nothing when a single non-count source read errors', async () => {
    stubRedis({ failing: ['intelligence:gpsjam:v2'] });
    await getRiskScores({} as never, {} as never);
    assert.deepEqual(published(), [], 'every Redis input is load-bearing, not only the count families');
  });

  it('serves the existing stale payload flagged degraded and stale when the build is rejected', async () => {
    stubRedis({ failing: ['news:insights:v1'], stored: { [STALE_KEY]: JSON.stringify(stalePayload) } });
    const response = await getRiskScores({} as never, {} as never);
    assert.equal(response.degraded, true, 'a rejected build must not be served as a fresh one');
    assert.equal(response.stale, true, 'the fallback must be labelled stale');
    assert.equal(response.ciiScores[0]?.region, 'ZZ', 'the served scores must come from the stale key');
    assert.equal(response.ciiScores[0]?.score, 77);
    assert.deepEqual(published(), []);
  });

  it('writes neither the build nor a negative sentinel to the live key on rejection', async () => {
    stubRedis({ failing: ['news:insights:v1'] });
    await getRiskScores({} as never, {} as never);
    assert.ok(!writtenKeys().includes(LIVE_KEY), 'the live key must be left untouched by a rejected build');
    assert.ok(!writes.some((write) => write.value === JSON.stringify(NEG_SENTINEL)), 'no negative sentinel may be cached');
  });

  it('records the rejection with key names and failure classes but no payload values', async () => {
    const marker = 'PAYLOAD_MARKER_9f3c';
    stubRedis({
      failing: ['news:insights:v1'],
      stored: {
        'cyber:threats-bootstrap:v2': `{"threats":[${marker}`,
        'conflict:ucdp-events:v1': JSON.stringify({ events: [{ country: 'Ukraine', note: marker }] }),
      },
    });
    await getRiskScores({} as never, {} as never);
    assert.equal(rejectionRecord().length, 1, 'exactly one rejection record is written');
    const record = JSON.parse(rejectionRecord()[0]!.value) as { at: number; failedReads: Array<{ key: string; failure: string }> };
    assert.equal(typeof record.at, 'number');
    assert.deepEqual(
      [...record.failedReads].sort((a, b) => a.key.localeCompare(b.key)),
      [
        { key: 'cyber:threats-bootstrap:v2', failure: 'parse' },
        { key: 'news:insights:v1', failure: 'timeout' },
      ],
    );
    assert.ok(!rejectionRecord()[0]!.value.includes(marker), 'the record must not carry stored payload bytes');
    assert.equal(errorLogs.length, 1, 'one rejection log line');
    assert.ok(errorLogs[0]!.includes('news:insights:v1') && errorLogs[0]!.includes('cyber:threats-bootstrap:v2'), 'the log names the failed keys');
    assert.ok(!errorLogs[0]!.includes(marker), 'the log must not carry stored payload bytes');
  });

  it('rejects the build when a trend-prior bucket read errors', async () => {
    const [targetBucket] = getCiiTrendPriorCandidateBuckets(Date.now());
    stubRedis({ failing: [`risk:scores:sebuf:trend-history:${CII_FORMULA_VERSION}:${targetBucket}`] });
    await getRiskScores({} as never, {} as never);
    assert.deepEqual(published(), [], 'the trend prior is a build input like any other');
  });

  it('does not fall back to the previous displacement year when the current year read errors', async () => {
    stubRedis({
      failing: [DISPLACEMENT_CURRENT_KEY],
      stored: { [DISPLACEMENT_PREVIOUS_KEY]: JSON.stringify({ countries: [{ code: 'SDN', totalDisplaced: 1000 }] }) },
    });
    await getRiskScores({} as never, {} as never);
    assert.deepEqual(published(), [], 'an errored current-year read is not a missing year');
    assert.ok(!gets.includes(DISPLACEMENT_PREVIOUS_KEY), 'the previous year must not be consulted after an error');
  });

  it('still falls back to the previous displacement year when the current year is a miss', async () => {
    stubRedis({
      stored: { [DISPLACEMENT_PREVIOUS_KEY]: JSON.stringify({ countries: [{ code: 'SDN', totalDisplaced: 1000 }] }) },
    });
    await getRiskScores({} as never, {} as never);
    assert.ok(gets.includes(DISPLACEMENT_PREVIOUS_KEY), 'a genuine miss still consults the previous year');
    assert.ok(published().includes(SEED_META_KEY), 'a build from a miss-then-hit still publishes');
  });
});
