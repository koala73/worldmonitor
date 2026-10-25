import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const seeder = fileURLToPath(new URL('../scripts/seed-aaii-sentiment.mjs', import.meta.url));
const key = 'market:aaii-sentiment:v1';
const metaKey = 'seed-meta:market:aaii-sentiment';
const now = Date.parse('2026-10-15T22:02:40.592Z');
const fetchedAt = Date.parse('2026-10-08T22:02:00.000Z');

const preload = `
import { readFileSync, writeFileSync } from 'node:fs';
const config = JSON.parse(readFileSync(process.env.AAII_FIXTURE_CONFIG, 'utf8'));
const NativeDate = Date;
globalThis.Date = class extends NativeDate {
  constructor(...args) { super(...(args.length ? args : [config.now])); }
  static now() { return config.now; }
};
const cache = new Map(Object.entries(config.cache));
const commands = [];
const sources = [];
function command(cmd) {
  commands.push(cmd);
  const [op, key, value] = cmd;
  if (op === 'GET') return { result: cache.get(key)?.value ?? null };
  if (op === 'SET') {
    const ex = cmd.indexOf('EX');
    const px = cmd.indexOf('PX');
    const expiresAt = ex >= 0 ? config.now + Number(cmd[ex + 1]) * 1000
      : px >= 0 ? config.now + Number(cmd[px + 1]) : null;
    cache.set(key, { value, expiresAt });
    return { result: 'OK' };
  }
  if (op === 'EXPIRE') {
    const entry = cache.get(key);
    if (entry) entry.expiresAt = config.now + Number(value) * 1000;
    return { result: entry ? 1 : 0 };
  }
  if (op === 'DEL') return { result: cache.delete(key) ? 1 : 0 };
  if (op === 'EVAL') {
    cache.delete(cmd[3]);
    return { result: 1 };
  }
  throw new Error('Unexpected Redis command ' + op);
}
globalThis.fetch = async (input, init = {}) => {
  const url = new URL(String(input));
  if (url.hostname === 'aaii-redis.invalid') {
    if (config.source === 'redis-error' && url.pathname.startsWith('/get/')) return new Response('Forbidden', { status: 403 });
    if (url.pathname.startsWith('/get/')) return Response.json(command(['GET', decodeURIComponent(url.pathname.slice(5))]));
    const body = JSON.parse(init.body);
    return Response.json(Array.isArray(body[0]) ? body.map(command) : command(body));
  }
  if (url.hostname !== 'www.aaii.com') throw new Error('Unexpected network host ' + url.hostname);
  sources.push(url.pathname);
  if (sources.length === 1 && config.elapsedMs) config.now += config.elapsedMs;
  if (config.source === 'http-error') return new Response('Unavailable', { status: 503 });
  if (config.source === 'forbidden') return new Response('Forbidden', { status: 403 });
  if (sources.length === 1) {
    if (config.source === 'flaky-http') return new Response('Unavailable', { status: 503 });
    if (config.source === 'flaky-network') throw new TypeError('temporary connection failure');
    if (config.source === 'rate-limit') return new Response('Slow down', { status: 429, headers: { 'Retry-After': config.retryAfter ?? '20' } });
  }
  if (url.pathname.endsWith('.xls')) return new Response(new Uint8Array(0));
  if (['html', 'redis-error', 'stale-html', 'flaky-http', 'flaky-network', 'rate-limit'].includes(config.source)) return new Response('<span>Week ending October ' + (config.source === 'stale-html' ? '7' : '14') + ', 2026</span><td class="tableTxt">40.0%</td><td class="tableTxt">30.0%</td><td class="tableTxt">30.0%</td>');
  return new Response('<html>No survey rows</html>');
};
process.on('exit', () => writeFileSync(process.env.AAII_FIXTURE_RESULT, JSON.stringify({ cache: Object.fromEntries(cache), commands, sources })));
`;

function run({ cache = {}, source = 'empty', retryAfter, elapsedMs } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'aaii-publication-'));
  try {
    const importPath = join(dir, 'fetch.mjs');
    const configPath = join(dir, 'config.json');
    const resultPath = join(dir, 'result.json');
    writeFileSync(importPath, preload);
    writeFileSync(configPath, JSON.stringify({ now, cache, source, retryAfter, elapsedMs }));
    const child = spawnSync(process.execPath, ['--import', importPath, seeder], {
      env: {
        PATH: process.env.PATH,
        NODE_ENV: 'test',
        NODE_TEST_CONTEXT: 'child-v8',
        WM_SEED_RETRY_DELAY_MS: '0',
        UPSTASH_REDIS_REST_URL: 'https://aaii-redis.invalid',
        UPSTASH_REDIS_REST_TOKEN: 'synthetic',
        AAII_FIXTURE_CONFIG: configPath,
        AAII_FIXTURE_RESULT: resultPath,
      },
      encoding: 'utf8', timeout: 15_000,
    });
    assert.equal(child.error, undefined);
    return { ...JSON.parse(readFileSync(resultPath, 'utf8')), status: child.status, log: child.stdout + child.stderr };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function previous(fallback) {
  const date = fallback ? '2026-04-03' : '2026-10-08';
  const week = { date, bullish: 35.7, bearish: 43, neutral: 21.3, spread: -7.3 };
  return {
    [key]: {
      value: JSON.stringify({
        _seed: { fetchedAt, recordCount: 1, sourceVersion: 'aaii-xls-html-v1', schemaVersion: 1, state: 'OK' },
        data: { seededAt: date + 'T12:00:00.000Z', fallback, source: fallback ? 'fallback' : 'xls', latest: week, weeks: [week] },
      }),
      expiresAt: now + 120_000,
    },
    [metaKey]: {
      value: JSON.stringify({ fetchedAt, recordCount: 1, sourceVersion: 'aaii-xls-html-v1' }),
      expiresAt: now + 120_000,
    },
  };
}

for (const [name, cache] of [
  ['no prior publication', {}],
  ['a genuine prior publication', previous(false)],
  ['a legacy fallback publication', previous(true)],
  ['an expired payload with surviving metadata', { [metaKey]: previous(false)[metaKey] }],
]) {
  test(`zero usable live rows fails without changing ${name} or its expiry`, () => {
    const result = run({ cache });
    assert.equal(result.status, 75, result.log);
    assert.deepEqual(result.sources, ['/sentimentsurvey']);
    assert.deepEqual(result.cache, cache);
    assert.match(result.log, /AAII sources returned no usable sentiment rows/);
    assert.doesNotMatch(result.log, /"event":"seed_complete"|Using fallback data/);
    assert.equal(result.commands.some(([op, target]) => ['SET', 'EXPIRE', 'DEL'].includes(op)
      && [key, metaKey].includes(target)), false);
  });
}

test('failed HTTP responses do not become a valid empty publication', () => {
  const cache = previous(false);
  const result = run({ source: 'http-error', cache });
  assert.equal(result.status, 75, result.log);
  assert.deepEqual(result.cache, cache);
  assert.equal(result.sources.length, 4);
  assert.doesNotMatch(result.log, /"state":"OK_ZERO"|"event":"seed_complete"/);
});

for (const source of ['flaky-http', 'flaky-network', 'rate-limit']) {
  test(`${source} retries before publishing while preserving the provider delay`, () => {
    const result = run({ source, cache: fullHistory() });
    assert.equal(result.status, 0, result.log);
    assert.deepEqual(result.sources, ['/sentimentsurvey', '/sentimentsurvey']);
    assert.match(result.log, new RegExp('Retry 1/3 in ' + (source === 'rate-limit' ? '20000' : '10000') + 'ms'));
    const canonical = JSON.parse(result.cache[key].value);
    assert.equal(canonical._seed.recordCount, 52);
    assert.equal(canonical.data.latest.date, '2026-10-15');
    assert.match(result.log, /"event":"seed_complete"/);
  });
}

test('permission denial fails immediately without replacing data or renewing expiry', () => {
  const cache = fullHistory();
  const result = run({ source: 'forbidden', cache });
  assert.equal(result.status, 75, result.log);
  assert.deepEqual(result.sources, ['/sentimentsurvey']);
  assert.deepEqual(result.cache, cache);
  assert.doesNotMatch(result.log, /Retry|"event":"seed_complete"/);
});

for (const retryAfter of ['120', new Date(now + 120_000).toUTCString()]) {
  test(`Retry-After ${retryAfter} keeps the full provider delay`, () => {
    const result = run({ source: 'rate-limit', cache: fullHistory(), retryAfter });
    const expected = retryAfter === '120' ? 120_000 : Date.parse(retryAfter) - now;
    assert.equal(result.status, 0, result.log);
    assert.equal(result.sources.length, 2);
    assert.match(result.log, new RegExp('Retry 1/3 in ' + expected + 'ms'));
    assert.equal(JSON.parse(result.cache[key].value)._seed.recordCount, 52);
  });
}

for (const [name, retryAfter, elapsedMs] of [
  ['delta-seconds at the fixed deadline', '240', 0],
  ['HTTP-date past the fixed deadline', new Date(now + 300_000).toUTCString(), 0],
  ['remaining budget after a slow response', '120', 130_000],
  ['ten-second floor outside the remaining budget', '1', 231_000],
]) {
  test(`${name} stops without another request or publication`, () => {
    const cache = fullHistory();
    const result = run({ source: 'rate-limit', cache, retryAfter, elapsedMs });
    assert.equal(result.status, 75, result.log);
    assert.deepEqual(result.sources, ['/sentimentsurvey']);
    assert.deepEqual(result.cache, cache);
    assert.doesNotMatch(result.log, /Retry|"event":"seed_complete"/);
  });
}

function fullHistory() {
  const cache = previous(false);
  const value = JSON.parse(cache[key].value);
  value.data.weeks = Array.from({ length: 52 }, (_, index) => ({
    ...value.data.latest,
    date: new Date(fetchedAt - index * 7 * 86400000).toISOString().slice(0, 10),
  }));
  value._seed.recordCount = 52;
  cache[key].value = JSON.stringify(value);
  return cache;
}

test('a new live HTML week retains the latest 52 genuine weeks and their source dates', () => {
  const cache = fullHistory();
  const oldWeeks = JSON.parse(cache[key].value).data.weeks;
  const result = run({ source: 'html', cache });
  assert.equal(result.status, 0, result.log);
  assert.deepEqual(result.sources, ['/sentimentsurvey']);
  const canonical = JSON.parse(result.cache[key].value);
  assert.equal(canonical._seed.recordCount, 52);
  assert.equal(canonical.data.weeks.length, 52);
  assert.equal(canonical.data.latest.date, '2026-10-15');
  assert.deepEqual(canonical.data.weeks.slice(1), oldWeeks.slice(0, 51));
  assert.deepEqual(canonical.data.previous, oldWeeks[0]);
  assert.deepEqual(canonical.data.avg8w, { bullish: 36.2, bearish: 41.4, neutral: 22.4, spread: -5.1 });
  assert.equal(result.cache[key].expiresAt, now + 604800_000);
  assert.equal(JSON.parse(result.cache[metaKey].value).recordCount, 52);
});

test('a repeated live week replaces that date without duplicating or shrinking history', () => {
  const cache = fullHistory();
  const value = JSON.parse(cache[key].value);
  value.data.weeks[0].date = '2026-10-15';
  cache[key].value = JSON.stringify(value);
  const result = run({ source: 'html', cache });
  assert.equal(result.status, 0, result.log);
  const weeks = JSON.parse(result.cache[key].value).data.weeks;
  assert.equal(weeks.length, 52);
  assert.equal(new Set(weeks.map(w => w.date)).size, 52);
  assert.equal(weeks[0].bullish, 40);
});

test('a failed history read cannot replace the full history with one week', () => {
  const cache = fullHistory();
  const result = run({ source: 'redis-error', cache });
  assert.notEqual(result.status, 0, result.log);
  assert.deepEqual(result.cache, cache);
  assert.doesNotMatch(result.log, /"event":"seed_complete"/);
});

test('an old live page cannot renew the history or metadata expiry', () => {
  const cache = fullHistory();
  const result = run({ source: 'stale-html', cache });
  assert.notEqual(result.status, 0, result.log);
  assert.deepEqual(result.cache, cache);
  assert.doesNotMatch(result.log, /"event":"seed_complete"/);
});

test('invalid retained history fails without dropping its rows or renewing expiry', () => {
  const cache = fullHistory();
  const value = JSON.parse(cache[key].value);
  value.data.weeks[10].bullish = -1;
  cache[key].value = JSON.stringify(value);
  const result = run({ source: 'html', cache });
  assert.notEqual(result.status, 0, result.log);
  assert.deepEqual(result.cache, cache);
});

test('usable live HTML publishes the existing AAII consumer shape', () => {
  const result = run({ source: 'html', cache: previous(true) });
  assert.equal(result.status, 0, result.log);
  const canonical = JSON.parse(result.cache[key].value);
  assert.equal(canonical._seed.state, 'OK');
  assert.equal(canonical._seed.recordCount, 1);
  assert.equal(canonical._seed.fetchedAt, now);
  assert.equal(canonical.data.fallback, false);
  assert.equal(canonical.data.source, 'html');
  assert.equal(canonical.data.seededAt, '2026-10-15T22:02:40.592Z');
  assert.deepEqual(canonical.data.latest, { date: '2026-10-15', bullish: 40, bearish: 30, neutral: 30, spread: 10 });
  assert.deepEqual(canonical.data.weeks, [canonical.data.latest]);
  assert.deepEqual(canonical.data.avg8w, { bullish: 40, bearish: 30, neutral: 30, spread: 10 });
  assert.equal(result.cache[key].expiresAt, now + 604800_000);
  assert.equal(JSON.parse(result.cache[metaKey].value).fetchedAt, now);
  assert.match(result.log, /"event":"seed_complete"/);
});
