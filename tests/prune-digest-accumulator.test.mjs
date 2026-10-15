import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  DELETE_RECORD_BATCH,
  PRUNE_PAGE_SCRIPT,
  RETENTION_MS,
  runCleanup,
} from '../scripts/prune-digest-accumulator.mjs';

const CONFIG = {
  UPSTASH_REDIS_REST_URL: 'https://redis.example',
  UPSTASH_REDIS_REST_TOKEN: 'test-token',
  FORECAST_EVIDENCE_CUTOVER_ENABLED: '1',
};
const KEY = 'digest:accumulator:v1:full:en';
const OTHER_KEY = 'digest:accumulator:v1:finance:en';
const NOW = 1_800_000_000_000;
const CUTOFF = NOW - RETENTION_MS;

function scoreInRange(score, min, max) {
  const lower = min === '-inf' ? -Infinity : Number(String(min).replace(/^\(/, ''));
  const upper = max === '+inf' ? Infinity : Number(String(max).replace(/^\(/, ''));
  const lowerOk = String(min).startsWith('(') ? score > lower : score >= lower;
  const upperOk = String(max).startsWith('(') ? score < upper : score <= upper;
  return lowerOk && upperOk;
}

function createFakeRedis({
  rowsByKey = {},
  scanPages = [['0', []]],
  failZremCall = null,
  redisNowMs = NOW,
  timeResult = null,
} = {}) {
  const state = new Map(
    Object.entries(rowsByKey).map(([key, rows]) => [key, rows.map((row) => ({ ...row }))]),
  );
  const calls = [];
  let scanIndex = 0;
  let zremCalls = 0;

  const response = (result, { ok = true, status = 200 } = {}) => ({
    ok,
    status,
    async json() { return { result }; },
  });

  async function fetchImpl(_url, options) {
    const command = JSON.parse(options.body);
    calls.push({ command, headers: options.headers });
    const [verb, key, ...args] = command;
    const rows = state.get(key) ?? [];

    if (verb === 'SCAN') return response(scanPages[scanIndex++] ?? ['0', []]);
    if (verb === 'TIME') {
      return response(timeResult ?? [String(Math.floor(redisNowMs / 1000)), String((redisNowMs % 1000) * 1000)]);
    }
    if (verb === 'EVAL') {
      // Emulates PRUNE_PAGE_SCRIPT atomically: select by CURRENT score, remove.
      assert.equal(key, PRUNE_PAGE_SCRIPT);
      const [, evalKey, cutoffArg, limitArg] = args;
      zremCalls += 1;
      if (failZremCall === zremCalls) return response(null, { ok: false, status: 503 });
      const evalRows = state.get(evalKey) ?? [];
      const targets = new Set(evalRows
        .filter((row) => scoreInRange(row.score, '-inf', cutoffArg))
        .sort((a, b) => a.score - b.score)
        .slice(0, Number(limitArg))
        .map((row) => row.member));
      state.set(evalKey, evalRows.filter((row) => !targets.has(row.member)));
      return response(targets.size);
    }
    if (verb === 'ZCARD') return response(rows.length);
    if (verb === 'ZRANGE') {
      if (rows.length === 0) return response([]);
      const sorted = rows.slice().sort((a, b) => a.score - b.score);
      const row = args[0] === '-1' ? sorted.at(-1) : sorted[0];
      return response([row.member, String(row.score)]);
    }
    if (verb === 'ZCOUNT') {
      return response(rows.filter((row) => scoreInRange(row.score, args[0], args[1])).length);
    }
    throw new Error(`Unexpected fake Redis command: ${verb}`);
  }

  return { fetchImpl, calls, state };
}

function row(member, score) {
  return { member, score };
}

function quietRun(fake, argv = [], extra = {}) {
  return runCleanup({
    argv,
    env: CONFIG,
    nowMs: NOW,
    fetchImpl: fake.fetchImpl,
    log: () => {},
    ...extra,
  });
}

describe('digest accumulator cleanup', () => {
  it('defaults to a non-mutating dry run and sends the required User-Agent', async () => {
    const fake = createFakeRedis({
      scanPages: [['0', [KEY]]],
      rowsByKey: { [KEY]: [row('old', CUTOFF - 1), row('new', CUTOFF + 1)] },
    });

    const result = await quietRun(fake, [], {
      env: {
        UPSTASH_REDIS_REST_URL: CONFIG.UPSTASH_REDIS_REST_URL,
        UPSTASH_REDIS_REST_TOKEN: CONFIG.UPSTASH_REDIS_REST_TOKEN,
      },
    });

    assert.equal(result.mode, 'DRY-RUN');
    assert.equal(result.results[0].before.wouldRemove, 1);
    assert.equal(fake.state.get(KEY).length, 2);
    assert.equal(fake.calls.some(({ command }) => command[0] === 'GET'), false);
    assert.equal(fake.calls.some(({ command }) => command[0] === 'ZREM'), false);
    assert.ok(fake.calls.every(({ headers }) => headers['User-Agent'] === 'worldmonitor-prune-digest-accumulator/1.0'));
  });

  it('follows every SCAN cursor page and deduplicates discovered keys', async () => {
    const fake = createFakeRedis({
      scanPages: [['7', [OTHER_KEY]], ['0', [KEY, OTHER_KEY]]],
    });

    const result = await quietRun(fake);

    assert.deepEqual(result.keys, [KEY, OTHER_KEY].sort());
    const scans = fake.calls.filter(({ command }) => command[0] === 'SCAN');
    assert.deepEqual(scans.map(({ command }) => command[1]), ['0', '7']);
    assert.ok(scans.every(({ command }) => command.includes('COUNT')));
  });

  it('requires exact reviewed keys for apply and rejects keys outside the accumulator namespace', async () => {
    const unused = createFakeRedis();
    await assert.rejects(() => quietRun(unused, ['--apply']), /requires at least one reviewed exact --key/);
    await assert.rejects(
      () => quietRun(unused, ['--apply', '--key', 'digest:accumulator:v1:*']),
      /Refusing non-accumulator or non-exact key/,
    );
    await assert.rejects(
      () => quietRun(unused, ['--apply', '--key', 'forecast:evidence:v1:full:en']),
      /Refusing non-accumulator or non-exact key/,
    );
    assert.equal(unused.calls.length, 0);
  });

  it('rejects apply without the cutover flag before reading or mutating Redis', async () => {
    const fake = createFakeRedis({ rowsByKey: { [KEY]: [row('old', CUTOFF - 1)] } });

    await assert.rejects(
      () => quietRun(fake, ['--apply', '--key', KEY], {
        env: {
          UPSTASH_REDIS_REST_URL: CONFIG.UPSTASH_REDIS_REST_URL,
          UPSTASH_REDIS_REST_TOKEN: CONFIG.UPSTASH_REDIS_REST_TOKEN,
        },
      }),
      /FORECAST_EVIDENCE_CUTOVER_ENABLED must equal 1/,
    );
    assert.equal(fake.calls.length, 0);
  });

  it('applies full/en on the flag alone and never reads a coverage marker (#7082)', async () => {
    // Judging reads only the evidence archive since #8995. Production carries
    // only the v2 continuity marker, so a marker gate would block the sweep
    // forever while protecting no reader.
    const fake = createFakeRedis({
      rowsByKey: { [KEY]: [row('old', CUTOFF - 1), row('boundary', CUTOFF)] },
    });

    const result = await quietRun(fake, ['--apply', '--key', KEY]);

    assert.equal(result.cutoverReady, true);
    assert.equal(result.results[0].removed, 1);
    assert.deepEqual(fake.state.get(KEY).map(({ member }) => member), ['boundary']);
    assert.equal(fake.calls.some(({ command }) => command[0] === 'GET'), false);
  });

  it('applies an exact non-full/en accumulator key with the flag set', async () => {
    const fake = createFakeRedis({
      rowsByKey: {
        [OTHER_KEY]: [row('old', CUTOFF - 1), row('boundary', CUTOFF)],
      },
    });

    const result = await quietRun(fake, ['--apply', '--key', OTHER_KEY]);

    assert.deepEqual(result.keys, [OTHER_KEY]);
    assert.equal(result.results[0].removed, 1);
    assert.deepEqual(fake.state.get(OTHER_KEY).map(({ member }) => member), ['boundary']);
  });

  it('removes only scores strictly older than the retention cutoff', async () => {
    const fake = createFakeRedis({
      rowsByKey: {
        [KEY]: [
          row('older', CUTOFF - 1),
          row('boundary', CUTOFF),
          row('newer', CUTOFF + 1),
        ],
      },
    });

    const result = await quietRun(fake, ['--apply', '--key', KEY]);

    assert.equal(result.results[0].removed, 1);
    assert.deepEqual(fake.state.get(KEY).map(({ member }) => member), ['boundary', 'newer']);
    const counts = fake.calls.filter(({ command }) => command[0] === 'ZCOUNT');
    assert.ok(counts.every(({ command }) => command[3] === `(${CUTOFF}`));
    const pages = fake.calls.filter(({ command }) => command[0] === 'EVAL');
    assert.ok(pages.length > 0 && pages.every(({ command }) => command[4] === `(${CUTOFF}`));
  });

  it('deletes a large eligible set in bounded record pages', async () => {
    const oldRows = Array.from(
      { length: DELETE_RECORD_BATCH * 2 + 5 },
      (_, index) => row(`old-${index}`, CUTOFF - index - 1),
    );
    const fake = createFakeRedis({ rowsByKey: { [KEY]: oldRows } });

    const result = await quietRun(fake, ['--apply', `--key=${KEY}`]);

    assert.equal(result.results[0].removed, oldRows.length);
    assert.equal(result.results[0].pages, 3);
    const removals = fake.calls.filter(({ command }) => command[0] === 'EVAL');
    assert.deepEqual(removals.map(({ command }) => command[5]), ['100', '100', '5']);
    assert.ok(removals.every(({ command }) => Number(command[5]) <= DELETE_RECORD_BATCH));
  });

  it('makes bounded progress and resumes an incomplete exact-key apply run', async () => {
    const fake = createFakeRedis({
      rowsByKey: {
        [KEY]: [
          row('old-1', CUTOFF - 3),
          row('old-2', CUTOFF - 2),
          row('old-3', CUTOFF - 1),
          row('boundary', CUTOFF),
        ],
      },
    });
    const budget = { deleteRecordBatch: 2, maxDeleteCommands: 2 };

    const first = await quietRun(fake, ['--apply', '--key', KEY], budget);
    assert.equal(first.results[0].removed, 2);
    assert.equal(first.results[0].complete, false);
    assert.equal(first.results[0].eligibleRemaining, 1);
    assert.deepEqual(fake.state.get(KEY).map(({ member }) => member), ['old-3', 'boundary']);

    const second = await quietRun(fake, ['--apply', '--key', KEY], budget);
    assert.equal(second.results[0].removed, 1);
    assert.equal(second.results[0].complete, true);
    assert.equal(second.results[0].eligibleRemaining, 0);
    assert.deepEqual(fake.state.get(KEY).map(({ member }) => member), ['boundary']);
  });

  it('stops on a partial Redis failure and can be resumed safely', async () => {
    const oldRows = Array.from(
      { length: DELETE_RECORD_BATCH + 5 },
      (_, index) => row(`old-${index}`, CUTOFF - index - 1),
    );
    const fake = createFakeRedis({ rowsByKey: { [KEY]: oldRows }, failZremCall: 2 });

    await assert.rejects(
      () => quietRun(fake, ['--apply', '--key', KEY]),
      /Redis EVAL failed: HTTP 503/,
    );
    assert.equal(fake.state.get(KEY).length, 5, 'the first committed page is preserved for a safe retry');
  });

  it('is idempotent when apply is repeated after a successful run', async () => {
    const fake = createFakeRedis({
      rowsByKey: { [KEY]: [row('old', CUTOFF - 1), row('boundary', CUTOFF)] },
    });

    const first = await quietRun(fake, ['--apply', '--key', KEY]);
    const second = await quietRun(fake, ['--apply', '--key', KEY]);

    assert.equal(first.results[0].removed, 1);
    assert.equal(second.results[0].removed, 0);
    assert.deepEqual(fake.state.get(KEY).map(({ member }) => member), ['boundary']);
  });

  it('retains the weekly digest window rather than the 48-hour key TTL', async () => {
    // seed-digest-notifications buildDigest() reads this key back to the
    // subscriber's lastSentAt — ~7 days for a weekly rule. Pruning to 48h
    // silently shipped two-day digests to weekly subscribers.
    const fake = createFakeRedis({
      rowsByKey: {
        [KEY]: [
          row('six-days-old', NOW - 6 * 24 * 60 * 60 * 1000),
          row('nine-days-old', NOW - 9 * 24 * 60 * 60 * 1000),
        ],
      },
    });

    await quietRun(fake, ['--apply', '--key', KEY]);

    assert.deepEqual(
      fake.state.get(KEY).map(({ member }) => member),
      ['six-days-old'],
      'a six-day-old member is still inside a weekly digest window',
    );
    assert.ok(RETENTION_MS > 7 * 24 * 60 * 60 * 1000);
  });

  it('reports cutover readiness in dry-run without touching Redis state', async () => {
    // "Is it safe to prune yet?" must be answerable without risking --apply.
    const fake = createFakeRedis({
      scanPages: [['0', [KEY]]],
      rowsByKey: { [KEY]: [row('old', CUTOFF - 1)] },
    });

    const result = await quietRun(fake);

    assert.equal(result.cutoverReady, true);
    assert.equal(result.cutoverBlockedReason, null);
    assert.equal(result.retentionMs, RETENTION_MS);
    assert.equal(fake.calls.some(({ command }) => command[0] === 'ZREM'), false);
    assert.equal(fake.state.get(KEY).length, 1);
  });

  it('reports the blocking reason in dry-run instead of throwing', async () => {
    const fake = createFakeRedis({
      scanPages: [['0', [KEY]]],
      rowsByKey: { [KEY]: [row('old', CUTOFF - 1)] },
    });

    const result = await quietRun(fake, [], {
      env: {
        UPSTASH_REDIS_REST_URL: CONFIG.UPSTASH_REDIS_REST_URL,
        UPSTASH_REDIS_REST_TOKEN: CONFIG.UPSTASH_REDIS_REST_TOKEN,
      },
    });

    assert.equal(result.cutoverReady, false);
    assert.match(result.cutoverBlockedReason, /FORECAST_EVIDENCE_CUTOVER_ENABLED must equal 1/);
    assert.equal(result.results[0].before.wouldRemove, 1);
    assert.equal(fake.calls.some(({ command }) => command[0] === 'ZREM'), false);
  });

  it('dry-run issues only read commands', async () => {
    const fake = createFakeRedis({
      scanPages: [['0', [KEY, OTHER_KEY]]],
      rowsByKey: { [KEY]: [row('old', CUTOFF - 1)], [OTHER_KEY]: [row('new', NOW)] },
    });

    await quietRun(fake);

    const verbs = new Set(fake.calls.map(({ command }) => command[0]));
    assert.deepEqual([...verbs].sort(), ['SCAN', 'TIME', 'ZCARD', 'ZCOUNT', 'ZRANGE']);
  });

  it('never deletes a member re-added with a fresh score after the pre-scan', async () => {
    // A publication can re-ZADD a story between the pre-scan and its delete
    // page. Selection and removal run in one script, so the fresh score saves it.
    const fake = createFakeRedis({
      rowsByKey: { [KEY]: [row('refreshed', CUTOFF - 2), row('stale', CUTOFF - 1)] },
    });
    const originalFetch = fake.fetchImpl;
    let refreshed = false;
    const racingFetch = async (url, options) => {
      const command = JSON.parse(options.body);
      if (!refreshed && command[0] === 'EVAL') {
        refreshed = true;
        fake.state.set(KEY, fake.state.get(KEY).map((r) => (r.member === 'refreshed' ? { ...r, score: NOW } : r)));
      }
      return originalFetch(url, options);
    };

    const result = await quietRun({ ...fake, fetchImpl: racingFetch }, ['--apply', '--key', KEY]);

    assert.equal(result.results[0].removed, 1);
    assert.equal(result.results[0].convergedEarly, true);
    assert.equal(result.results[0].complete, true);
    assert.deepEqual(fake.state.get(KEY).map(({ member }) => member), ['refreshed']);
    assert.equal(fake.calls.some(({ command }) => command[0] === 'ZREM'), false, 'no unguarded ZREM by member');
  });

  it('derives the cutoff from Redis TIME, not the operator clock', async () => {
    // An operator clock 3 days fast would otherwise delete 3 days of members
    // that are still inside retention.
    const redisNowMs = NOW - 3 * 24 * 60 * 60 * 1000;
    const redisCutoff = redisNowMs - RETENTION_MS;
    const fake = createFakeRedis({
      redisNowMs,
      rowsByKey: { [KEY]: [row('expired', redisCutoff - 1), row('inside-retention', redisCutoff + 60_000)] },
    });

    const result = await quietRun(fake, ['--apply', '--key', KEY]);

    assert.equal(result.observedAtMs, NOW);
    assert.equal(result.redisTimeMs, redisNowMs);
    assert.equal(result.clockSkewMs, NOW - redisNowMs);
    assert.equal(result.cutoff, redisCutoff);
    assert.deepEqual(fake.state.get(KEY).map(({ member }) => member), ['inside-retention']);
  });

  it('prints the operator clock and Redis TIME in the dry-run log', async () => {
    const fake = createFakeRedis({ scanPages: [['0', [KEY]]], redisNowMs: NOW - 1234 });
    const lines = [];

    await quietRun(fake, [], { log: (line) => lines.push(line) });

    assert.match(lines[0], new RegExp(`observedAt=${new Date(NOW).toISOString()} redisTime=${new Date(NOW - 1234).toISOString()} clockSkewMs=1234 `));
  });

  it('refuses to run on a malformed Redis TIME reply', async () => {
    const fake = createFakeRedis({ scanPages: [['0', [KEY]]], timeResult: ['nope'] });
    await assert.rejects(() => quietRun(fake), /Redis TIME returned/);
  });

  it('converges instead of failing when publication pruned the tail first', async () => {
    // The live digest prunes the same key on every build. An empty delete page
    // with nothing eligible left is a won race, not a corrupted key.
    const fake = createFakeRedis({
      rowsByKey: { [KEY]: [row('old-1', CUTOFF - 2), row('old-2', CUTOFF - 1)] },
    });
    const originalFetch = fake.fetchImpl;
    let stolen = false;
    const racingFetch = async (url, options) => {
      const command = JSON.parse(options.body);
      // Between the ZCOUNT that sized the work and the first delete page, the
      // publication prune removes every eligible member.
      if (!stolen && command[0] === 'EVAL') {
        stolen = true;
        fake.state.set(KEY, []);
      }
      return originalFetch(url, options);
    };

    const result = await quietRun({ ...fake, fetchImpl: racingFetch }, ['--apply', '--key', KEY]);

    assert.equal(result.results[0].removed, 0);
    assert.equal(result.results[0].convergedEarly, true);
    assert.equal(result.results[0].complete, true);
    assert.equal(result.results[0].eligibleRemaining, 0);
  });

  it('still fails loudly when a page is empty but members remain eligible', async () => {
    const fake = createFakeRedis({
      rowsByKey: { [KEY]: [row('old-1', CUTOFF - 2), row('old-2', CUTOFF - 1)] },
    });
    const originalFetch = fake.fetchImpl;
    const lyingFetch = async (url, options) => {
      const command = JSON.parse(options.body);
      // A delete page that removes nothing while ZCOUNT still reports work is a
      // genuine inconsistency and must not be swallowed by the convergence path.
      if (command[0] === 'EVAL') {
        return { ok: true, status: 200, async json() { return { result: 0 }; } };
      }
      return originalFetch(url, options);
    };

    await assert.rejects(
      () => quietRun({ ...fake, fetchImpl: lyingFetch }, ['--apply', '--key', KEY]),
      /a delete page removed 0\/2 with 2 still eligible/,
    );
  });
});
